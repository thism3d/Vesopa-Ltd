/**
 * Email: the customer's own mailboxes at their own domain.
 *
 * Mounted at /panel/mail inside the panel router, so it inherits the signed-in
 * guard there. Every route re-derives which domains this customer may touch
 * from the database rather than trusting the name in the URL — a domain in a
 * path is the one thing a customer can edit.
 *
 * THE ADDRESS IS THEIRS; THE SERVER IS OURS. Mailboxes live at
 * `you@theirdomain.com`, but every client connects to one hostname
 * (MAIL_HOSTNAME) with one certificate. The panel used to hand out
 * `mail.<their domain>`, which has no certificate and, for a customer whose DNS
 * is elsewhere, does not resolve at all — instructions for a server that could
 * not be reached. See config.js.
 *
 * TWO KINDS OF DOMAIN, and the difference is the whole shape of the page:
 *
 *   ours      delegated to our nameservers. We have already written the MX, the
 *             SPF and the DKIM. Create a mailbox and it works.
 *   theirs    pointed here by an A record, DNS still at their provider. The
 *             mailbox is just as real, but nothing can reach it until they
 *             publish the records — so the page shows exactly what to paste and
 *             checks the public DNS to say whether it has taken effect.
 *
 * SUBDOMAINS ARE NEVER OFFERED. Mail belongs on the main domain — see
 * linking.mayHaveMail.
 */

const express = require('express');

const auth = require('../auth');
const db = require('../db');
const hestia = require('../integrations/hestia');
const mailboxes = require('../mailboxes');
const { flash, field, rateLimited } = require('../http-utils');
const {
  sendMail, shell, detailTable, escapeHtml,
} = require('../mailer');
const {
  MAIL_HOSTNAME, WEBMAIL_URL, MAIL_PORTS, SITE_URL, CONTACT,
} = require('../config');

const router = express.Router();

/** A mailbox name. Deliberately narrower than the RFC allows — see below. */
const ACCOUNT_RE = /^[a-z0-9]([a-z0-9._-]{0,58}[a-z0-9])?$/;

/**
 * The domain from the URL, proved to be one this customer may have mail on.
 *
 * Returns null rather than throwing so each route can decide what to do. The
 * list comes from mailboxes.usableDomains, which excludes subdomains and
 * anything not verified as pointing at us.
 */
async function ownedMailDomain(req, name) {
  const wanted = String(name || '').trim().toLowerCase();
  if (!wanted) return null;
  const allowed = await mailboxes.usableDomains(req.customer);
  return allowed.find((d) => d.domain === wanted) || null;
}

/** Everything one domain's page needs, gathered once. */
async function domainView(req, row) {
  const username = req.customer.hestia_user;
  const ownDns = row.verify_method === 'ns';

  const [accounts, dkim, live] = await Promise.all([
    hestia.listMailAccounts({ username, domain: row.domain }).catch(() => []),
    ownDns ? Promise.resolve(null) : hestia.dkimRecord({ username, domain: row.domain }),
    // Only worth asking the public DNS when the customer is the one who has to
    // publish the records. Where the zone is ours, it is our own answer coming
    // back and it proves nothing.
    ownDns ? Promise.resolve(null) : mailboxes.checkMailRecords(row.domain),
  ]);

  const domains = await hestia.listMailDomains(username).catch(() => []);
  const thisDomain = domains.find((d) => d.domain === row.domain) || null;

  return {
    domain: row.domain,
    ownDns,
    accounts,
    catchall: thisDomain ? thisDomain.catchall : '',
    records: ownDns ? [] : mailboxes.recordsFor(row, dkim),
    dnsCheck: live,
    settings: mailboxes.connectionSettings(),
  };
}

// ---------------------------------------------------------------------------
// The mail home: every domain, every mailbox
// ---------------------------------------------------------------------------
router.get('/', async (req, res, next) => {
  try {
    const usable = await mailboxes.usableDomains(req.customer);
    const quota = await mailboxes.allowance(req.customer);

    // ?domain= comes from the links on a domain's page. Anything else falls
    // back to the first one they have.
    const wanted = String(req.query.domain || '').toLowerCase();
    const chosen = usable.find((d) => d.domain === wanted) || usable[0] || null;

    const view = chosen && req.customer.hestia_user
      ? await domainView(req, chosen)
      : null;

    res.render('panel/mail', {
      title: 'Email',
      robots: 'noindex',
      usable,
      chosen: chosen ? chosen.domain : '',
      view,
      quota,
      webmail: WEBMAIL_URL,
      mailHost: MAIL_HOSTNAME,
      ports: MAIL_PORTS,
      hestiaLive: hestia.isLive(),
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Create a mailbox
// ---------------------------------------------------------------------------

/**
 * The welcome message.
 *
 * Sent to the account address AND delivered into the new mailbox, because those
 * two do different jobs. The one to their account address is the copy they can
 * find later, from a machine that is not yet set up. The one INSIDE the mailbox
 * is the first thing they see when they sign in, at the moment they are looking
 * for exactly these settings — and it proves the mailbox works, which no
 * message sent anywhere else can.
 */
function welcomeHtml(address, settings) {
  return shell({
    title: 'Your new mailbox',
    intro: `<strong>${escapeHtml(address)}</strong> is ready to use. Here is everything needed to `
      + 'read and send from it.',
    bodyHtml: `
      <p style="margin:0 0 14px">Sign in to webmail from any browser:</p>
      ${detailTable([
    ['Webmail', `<a href="${WEBMAIL_URL}">${escapeHtml(WEBMAIL_URL)}</a>`],
    ['Username', escapeHtml(address)],
    ['Password', 'the one you chose'],
  ])}
      <p style="margin:18px 0 14px">Or set it up in Outlook, Apple Mail or your phone:</p>
      ${detailTable([
    ['Incoming (IMAP)', `${escapeHtml(settings.imap.host)} — port ${settings.imap.port}, SSL/TLS`],
    ['Outgoing (SMTP)', `${escapeHtml(settings.smtp.host)} — port ${settings.smtp.port}, SSL/TLS`],
    ['Username', escapeHtml(address)],
    ['Authentication', 'Normal password'],
  ])}
      <p style="margin:18px 0 0;font-size:14px;color:#555">
        The server name is <strong>${escapeHtml(settings.imap.host)}</strong> for everybody —
        not your own domain. Your domain is the address; this is the server it is collected from.
      </p>`,
    ctaText: 'Open webmail',
    ctaUrl: WEBMAIL_URL,
    footNote: `Questions? Reply to this message or contact ${CONTACT.support_email}.`,
  });
}

/**
 * Put the welcome message INTO the mailbox that was just made.
 *
 * Sent through our own SMTP to the new address, which means it travels the same
 * path a real message would — so a mailbox that cannot receive fails here,
 * visibly, at the moment it is created, rather than the first time a customer
 * gives the address to someone.
 *
 * Never fatal. A mailbox that exists but has no welcome note in it is a working
 * mailbox, and refusing the whole operation over a greeting would be absurd.
 */
async function deliverWelcome(address, settings) {
  try {
    return await sendMail({
      to: address,
      subject: `Your mailbox ${address} is ready`,
      html: welcomeHtml(address, settings),
    });
  } catch (err) {
    console.error('[mail] welcome delivery failed:', err.message);
    return false;
  }
}

router.post('/:domain/create', async (req, res, next) => {
  const back = `/panel/mail?domain=${encodeURIComponent(req.params.domain)}`;
  try {
    if (!auth.checkCsrf(req)) return res.redirect(back);
    const row = await ownedMailDomain(req, req.params.domain);
    if (!row) {
      flash(res, 'Pick one of your own domains, pointed at us, to create the mailbox at.', 'error');
      return res.redirect('/panel/mail');
    }
    if (rateLimited(req.customer.id, 'mailbox-create', { max: 20, windowMs: 3600_000 })) {
      flash(res, 'That is a lot of mailboxes in one go. Try again in a little while.', 'warn');
      return res.redirect(back);
    }

    const account = field(req.body.account, 60).toLowerCase();
    const password = String(req.body.password || '');
    const quotaMb = Number(req.body.quota_mb) || 0;

    /*
     * Narrower than the RFC allows, on purpose. A mailbox name that starts or
     * ends with a dot, or contains two in a row, is legal on paper and rejected
     * by a good share of the internet — so it would be an address that works
     * here and silently fails to receive from elsewhere.
     */
    if (!ACCOUNT_RE.test(account)) {
      flash(res, 'A mailbox name can use letters, numbers, dots, hyphens and underscores, '
        + 'and must start and end with a letter or number.', 'error');
      return res.redirect(back);
    }
    const problem = auth.passwordProblem(password);
    if (problem) {
      flash(res, `${problem} This is the mailbox's own password, not your Vesopa one.`, 'error');
      return res.redirect(back);
    }

    /*
     * The allowance is checked HERE, against the node's own count, and not
     * against anything the page was rendered with. A form drawn when three
     * mailboxes were free and submitted twenty minutes later has to be told the
     * truth as it is now, and a customer with two tabs open must not be able to
     * spend the same last mailbox in both.
     */
    const verdict = await mailboxes.canCreate(req.customer);
    if (!verdict.ok) {
      flash(res, verdict.reason, 'warn');
      return res.redirect(back);
    }

    const username = req.customer.hestia_user;
    const address = `${account}@${row.domain}`;

    try {
      // The mail domain may not exist on the node yet — a domain added after
      // provisioning, or one that opted out of mail at the time.
      await hestia.addMailDomain({ username, domain: row.domain })
        .catch((err) => { if (err.code !== 4) throw err; });

      /*
       * And immediately take the `mail.<domain>` webmail alias back off it.
       * Hestia adds one to every mail domain; that name has no certificate and
       * is not where anybody should be sent. One hostname serves webmail for
       * every customer.
       */
      await hestia.removeWebmailAlias({ username, domain: row.domain }).catch(() => {});

      await hestia.addMailAccount({
        username, domain: row.domain, account, password, quota: quotaMb || 1024,
      });
    } catch (err) {
      flash(res, `The mail server refused that: ${err.message}`, 'error');
      return res.redirect(back);
    }

    const settings = mailboxes.connectionSettings(address);

    // Both, and neither blocks the redirect on failure — see deliverWelcome.
    const [toAccount, toInbox] = await Promise.all([
      sendMail({
        to: req.customer.email,
        subject: `Your new mailbox: ${address}`,
        html: welcomeHtml(address, settings),
      }).catch(() => false),
      deliverWelcome(address, settings),
    ]);

    await db.logActivity({
      actorType: 'customer',
      actorId: req.customer.id,
      action: 'mailbox.created',
      target: address,
      detail: `${verdict.quota.used + 1} of ${verdict.quota.total}`
        + `; welcome ${toInbox ? 'delivered' : 'not delivered'}`,
      ip: req.ip,
    });

    flash(res, `${address} is ready. `
      + (toInbox
        ? 'Setup instructions are waiting in the mailbox itself'
        : 'Setup instructions are on this page')
      + (toAccount ? `, and a copy has been emailed to ${req.customer.email}.` : '.'));
    res.redirect(back);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// One mailbox
// ---------------------------------------------------------------------------
router.get('/:domain/:account', async (req, res, next) => {
  try {
    const row = await ownedMailDomain(req, req.params.domain);
    if (!row) return next();

    const username = req.customer.hestia_user;
    const account = String(req.params.account || '').toLowerCase();
    const box = await hestia.mailAccount({ username, domain: row.domain, account });
    if (!box) return next();

    const autoreply = box.autoreply
      ? await hestia.getAutoreply({ username, domain: row.domain, account })
      : '';

    res.render('panel/mailbox', {
      title: box.address,
      robots: 'noindex',
      domain: row.domain,
      box,
      autoreply,
      settings: mailboxes.connectionSettings(box.address),
      webmail: WEBMAIL_URL,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Every change to one mailbox, as a table rather than as six near-identical
 * handlers. Each entry validates its own input and returns the message to show.
 */
const ACTIONS = {
  password: async ({ req, username, domain, account }) => {
    const password = String(req.body.password || '');
    const problem = auth.passwordProblem(password);
    if (problem) throw new Error(problem);
    await hestia.changeMailPassword({ username, domain, account, password });
    return 'Password changed. Every device signed in as this mailbox will ask for it again.';
  },

  quota: async ({ req, username, domain, account }) => {
    const raw = String(req.body.quota_mb || '').trim();
    const quotaMb = raw === '' || raw === '0' ? 0 : Number(raw);
    if (!Number.isFinite(quotaMb) || quotaMb < 0 || quotaMb > 1024 * 512) {
      throw new Error('Give a size in MB, or 0 for no limit.');
    }
    await hestia.changeMailQuota({ username, domain, account, quotaMb });
    return quotaMb ? `Size limit set to ${quotaMb} MB.` : 'Size limit removed.';
  },

  forwards: async ({ req, username, domain, account }) => {
    const forwards = String(req.body.forwards || '')
      .split(/[\s,;]+/).map((f) => f.trim().toLowerCase()).filter(Boolean);
    const bad = forwards.find((f) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f));
    if (bad) throw new Error(`"${bad}" is not an email address.`);
    if (forwards.length > 20) throw new Error('Twenty forwarding addresses is the limit.');

    const forwardOnly = Boolean(req.body.forward_only);
    /*
     * "Keep a copy" off with no forwards would deliver mail precisely nowhere.
     * Hestia would accept it; the customer would lose every message and have no
     * way of knowing why.
     */
    if (forwardOnly && !forwards.length) {
      throw new Error('You have asked not to keep a copy, but given nowhere to forward to — '
        + 'that would throw every message away. Add an address, or tick "keep a copy".');
    }
    await hestia.setMailForwards({ username, domain, account, forwards, forwardOnly });
    if (!forwards.length) return 'Forwarding turned off.';
    return `Forwarding to ${forwards.join(', ')}`
      + (forwardOnly ? ', and not keeping a copy here.' : ', and keeping a copy here.');
  },

  aliases: async ({ req, username, domain, account }) => {
    const aliases = String(req.body.aliases || '')
      .split(/[\s,;]+/).map((a) => a.trim().toLowerCase()).filter(Boolean)
      // An alias is a local part on this same domain. Somebody typing the whole
      // address means the same thing and should not be corrected at.
      .map((a) => (a.includes('@') ? a.split('@')[0] : a));
    const bad = aliases.find((a) => !ACCOUNT_RE.test(a));
    if (bad) throw new Error(`"${bad}" is not a valid name for an address.`);
    if (aliases.length > 20) throw new Error('Twenty extra addresses is the limit.');
    await hestia.setMailAliases({ username, domain, account, aliases });
    return aliases.length
      ? `Also receiving at ${aliases.map((a) => `${a}@${domain}`).join(', ')}.`
      : 'Extra addresses removed.';
  },

  autoreply: async ({ req, username, domain, account }) => {
    const message = String(req.body.message || '').trim().slice(0, 2000);
    await hestia.setAutoreply({ username, domain, account, message });
    return message ? 'Auto-reply is on.' : 'Auto-reply turned off.';
  },
};

Object.entries(ACTIONS).forEach(([name, handler]) => {
  router.post(`/:domain/:account/${name}`, async (req, res, next) => {
    const domain = String(req.params.domain || '').toLowerCase();
    const account = String(req.params.account || '').toLowerCase();
    const back = `/panel/mail/${encodeURIComponent(domain)}/${encodeURIComponent(account)}`;
    try {
      if (!auth.checkCsrf(req)) return res.redirect(back);
      const row = await ownedMailDomain(req, domain);
      if (!row) return next();

      const username = req.customer.hestia_user;
      const box = await hestia.mailAccount({ username, domain: row.domain, account });
      if (!box) return next();

      try {
        const message = await handler({
          req, username, domain: row.domain, account,
        });
        await db.logActivity({
          actorType: 'customer', actorId: req.customer.id,
          action: `mailbox.${name}`, target: box.address, ip: req.ip,
        });
        flash(res, message);
      } catch (err) {
        flash(res, err.message, 'error');
      }
      res.redirect(back);
    } catch (err) {
      next(err);
    }
  });
});

/** Delete a mailbox — and everything in it, which the page says twice. */
router.post('/:domain/:account/delete', async (req, res, next) => {
  const domain = String(req.params.domain || '').toLowerCase();
  const back = `/panel/mail?domain=${encodeURIComponent(domain)}`;
  try {
    if (!auth.checkCsrf(req)) return res.redirect(back);
    const row = await ownedMailDomain(req, domain);
    if (!row) return next();

    const account = String(req.params.account || '').toLowerCase();
    try {
      await hestia.deleteMailAccount({
        username: req.customer.hestia_user, domain: row.domain, account,
      });
      await db.logActivity({
        actorType: 'customer', actorId: req.customer.id,
        action: 'mailbox.deleted', target: `${account}@${row.domain}`, ip: req.ip,
      });
      flash(res, `${account}@${row.domain} and everything in it has been deleted.`);
    } catch (err) {
      flash(res, `The mail server refused that: ${err.message}`, 'error');
    }
    res.redirect(back);
  } catch (err) {
    next(err);
  }
});

/**
 * Catch-all: where mail to any unknown address on the domain goes.
 *
 * Off by default and worth leaving off. A catch-all receives every typo and
 * every address a spammer ever guesses, and the volume surprises people.
 */
router.post('/:domain/catchall', async (req, res, next) => {
  const domain = String(req.params.domain || '').toLowerCase();
  const back = `/panel/mail?domain=${encodeURIComponent(domain)}`;
  try {
    if (!auth.checkCsrf(req)) return res.redirect(back);
    const row = await ownedMailDomain(req, domain);
    if (!row) return next();

    const address = field(req.body.address, 190).toLowerCase();
    if (address && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) {
      flash(res, 'That is not an email address.', 'error');
      return res.redirect(back);
    }
    try {
      await hestia.setCatchall({
        username: req.customer.hestia_user, domain: row.domain, address,
      });
      flash(res, address
        ? `Anything sent to an unknown address at ${row.domain} now goes to ${address}.`
        : 'Catch-all turned off. Mail to unknown addresses will bounce, which is usually what you want.');
    } catch (err) {
      flash(res, `The mail server refused that: ${err.message}`, 'error');
    }
    res.redirect(back);
  } catch (err) {
    next(err);
  }
});

/** Re-check the customer's own DNS for the records mail needs. */
router.post('/:domain/check', async (req, res, next) => {
  const domain = String(req.params.domain || '').toLowerCase();
  const back = `/panel/mail?domain=${encodeURIComponent(domain)}`;
  try {
    if (!auth.checkCsrf(req)) return res.redirect(back);
    const row = await ownedMailDomain(req, domain);
    if (!row) return next();

    if (rateLimited(req.customer.id, 'mail-dns-check', { max: 15, windowMs: 600_000 })) {
      flash(res, 'We have just checked a few times. Give DNS a couple of minutes.', 'warn');
      return res.redirect(back);
    }

    const check = await mailboxes.checkMailRecords(row.domain);
    if (check.mxOk && check.spfOk) {
      flash(res, `${row.domain} is set up correctly — mail will reach your mailboxes.`);
    } else if (check.mxOk) {
      flash(res, 'The MX record is right. The SPF record is still missing or does not '
        + `mention ${MAIL_HOSTNAME}, so some of your mail may be treated as spam.`, 'warn');
    } else {
      flash(res, check.mxSeen.length
        ? `Not yet — mail for ${row.domain} is still going to ${check.mxSeen.join(', ')}.`
        : `Not yet — ${row.domain} has no MX record that we can see.`, 'warn');
    }
    res.redirect(back);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
