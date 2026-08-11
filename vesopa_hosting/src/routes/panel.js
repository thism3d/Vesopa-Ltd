/**
 * The customer control panel.
 *
 * This is the product. Everything here is a thin, opinionated surface over
 * HestiaCP: the customer sees their site, not a server. Six things they
 * actually do, not four hundred icons.
 *
 * Every route is guarded by `requireCustomer`, and every route that touches a
 * service or domain re-checks ownership from the database. An id in a URL is
 * never trusted, because the id in a URL is the one thing a customer can edit.
 */

const express = require('express');
const db = require('../db');
const auth = require('../auth');
const hestia = require('../integrations/hestia');
const sso = require('../integrations/hestia-sso');
const registrar = require('../integrations/domainnameapi');
const pricing = require('../pricing');
const linking = require('../domain-linking');
const mailboxes = require('../mailboxes');
const { sendMail, shell, detailTable, escapeHtml, DEFAULT_TO } = require('../mailer');
const { flash, field, rateLimited } = require('../http-utils');
const { NAMESERVERS, DOMAIN_NS_GRACE_DAYS } = require('../config');

const router = express.Router();

// ---------------------------------------------------------------------------
// Guard
// ---------------------------------------------------------------------------
router.use((req, res, next) => {
  if (!req.customer) {
    const target = encodeURIComponent(req.originalUrl);
    return res.redirect(`/login?next=${target}`);
  }
  res.locals.bodyClass = 'has-panel';
  res.locals.panelPath = req.path;
  next();
});

/*
 * Post-payment onboarding, mounted here rather than in server.js so it inherits
 * the guard above. A setup screen reachable without a session would show one
 * customer's order reference to anyone with the id.
 */
router.use('/', require('./setup'));

/** Fetch a service and prove it belongs to the signed-in customer. */
async function ownedService(req) {
  return db.one(
    `SELECT s.*, p.name AS plan_name, p.slug AS plan_slug, p.storage_gb, p.websites,
            p.\`databases\` AS plan_databases, p.mailboxes AS plan_mailboxes,
            p.daily_backups, p.hestia_package, sv.hostname AS server_hostname
       FROM services s
       JOIN plans p ON p.id = s.plan_id
       LEFT JOIN servers sv ON sv.id = s.server_id
      WHERE s.id = ? AND s.customer_id = ?
      LIMIT 1`,
    [req.params.id, req.customer.id],
  );
}

async function ownedDomain(req) {
  return db.one('SELECT * FROM domains WHERE id = ? AND customer_id = ? LIMIT 1', [
    req.params.id,
    req.customer.id,
  ]);
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------
router.get('/', async (req, res, next) => {
  try {
    const [services, domains, openTickets, unpaid] = await Promise.all([
      db.query(
        `SELECT s.*, p.name AS plan_name FROM services s
           JOIN plans p ON p.id = s.plan_id
          WHERE s.customer_id = ? AND s.status <> 'terminated'
          ORDER BY s.created_at DESC`,
        [req.customer.id],
      ),
      db.query(
        `SELECT * FROM domains WHERE customer_id = ? AND status NOT IN ('cancelled','removed')
          ORDER BY expires_at IS NULL, expires_at ASC`,
        [req.customer.id],
      ),
      db.query(
        `SELECT * FROM tickets WHERE customer_id = ? AND status <> 'closed' ORDER BY updated_at DESC`,
        [req.customer.id],
      ),
      db.query(
        `SELECT * FROM orders WHERE customer_id = ? AND status = 'pending' ORDER BY created_at DESC`,
        [req.customer.id],
      ),
    ]);

    // Anything expiring inside 30 days deserves the top of the page, because a
    // domain that lapses is the one failure a customer cannot undo themselves.
    const soon = domains.filter((d) => {
      if (!d.expires_at) return false;
      const days = (new Date(d.expires_at) - Date.now()) / 864e5;
      return days <= 30 && days > -30;
    });

    res.render('panel/dashboard', {
      title: 'Your panel',
      robots: 'noindex',
      services,
      domains,
      openTickets,
      unpaid,
      expiringSoon: soon,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------
router.get('/services', async (req, res, next) => {
  try {
    const services = await db.query(
      `SELECT s.*, p.name AS plan_name, p.slug AS plan_slug FROM services s
         JOIN plans p ON p.id = s.plan_id
        WHERE s.customer_id = ? ORDER BY s.created_at DESC`,
      [req.customer.id],
    );
    res.render('panel/services', { title: 'Your hosting', robots: 'noindex', services });
  } catch (err) {
    next(err);
  }
});

router.get('/services/:id', async (req, res, next) => {
  try {
    const service = await ownedService(req);
    if (!service) return next();

    // The node is asked for live usage, but its being down must not take the
    // page down with it — the customer still needs the nameservers and the
    // links on this page.
    let stats = null;
    let statsError = null;
    if (service.status === 'active' && req.customer.hestia_user) {
      try {
        stats = await hestia.userStats(req.customer.hestia_user);
      } catch (err) {
        statsError = err.message;
      }
    }

    const addonDomains = await db.query(
      'SELECT * FROM domains WHERE customer_id = ? AND service_id = ? AND status <> ?',
      [req.customer.id, service.id, 'removed'],
    );

    // The site's own domain, so the page can say whether a certificate is even
    // possible yet rather than offering a button that cannot work.
    const primaryDomain = service.primary_domain
      ? await db.one(
        'SELECT * FROM domains WHERE domain = ? AND customer_id = ? LIMIT 1',
        [service.primary_domain, req.customer.id],
      )
      : null;

    res.render('panel/service', {
      title: service.primary_domain || service.plan_name,
      robots: 'noindex',
      service,
      stats,
      statsError,
      addonDomains,
      primaryDomain,
      nameservers: NAMESERVERS,
      hestiaLive: hestia.isLive(),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Retry SSL.
 *
 * The single most-used button in the panel, because "my padlock is missing"
 * almost always means "DNS had not propagated when we first tried". Making it
 * self-service removes an entire category of ticket.
 *
 * THREE THINGS HAVE TO BE TRUE, and all three are checked here rather than
 * relied upon from the page that drew the button:
 *
 *   the hosting is ours     a certificate is installed on a web server. We can
 *                           only install one on ours, so there is nothing this
 *                           button could do for a site hosted elsewhere.
 *   the hosting is live     paid for and provisioned. `status = 'active'` is
 *                           reached only through a settled payment.
 *   the domain points here  Let's Encrypt proves control by fetching a file
 *                           over the domain. If it does not resolve to us the
 *                           challenge fails, and issuing for a name we do not
 *                           serve would be certifying somebody else's domain.
 */
router.post('/services/:id/ssl', async (req, res, next) => {
  try {
    if (!auth.checkCsrf(req)) return res.redirect(`/panel/services/${req.params.id}`);
    const service = await ownedService(req);
    if (!service) return next();

    if (!service.primary_domain) {
      flash(res, 'Add a domain to this site first.', 'warn');
      return res.redirect(`/panel/services/${service.id}`);
    }
    if (service.status !== 'active') {
      flash(
        res,
        service.status === 'pending'
          ? 'This hosting account is not live yet — certificates are issued once it is set up.'
          : `This hosting account is ${service.status}, so a certificate cannot be issued for it.`,
        'warn',
      );
      return res.redirect(`/panel/services/${service.id}`);
    }
    if (rateLimited(req.customer.id, 'ssl-retry', { max: 6, windowMs: 3600_000 })) {
      flash(res, 'You have tried several times. Wait a few minutes and try again — DNS can take up to an hour.', 'warn');
      return res.redirect(`/panel/services/${service.id}`);
    }

    /*
     * Checked live rather than read off the row: the customer is pressing this
     * button precisely because they have just changed their nameservers, and
     * the stored answer is by definition the one from before they did.
     * Verifying also creates the site on the node if the sweep has not got to
     * it yet, which is the other half of why the padlock was missing.
     */
    const domainRow = await db.one(
      'SELECT * FROM domains WHERE domain = ? AND customer_id = ? LIMIT 1',
      [service.primary_domain, req.customer.id],
    );

    let verdict = null;
    if (domainRow) {
      verdict = await linking.verify(domainRow, { customer: req.customer });

      /*
       * THE ONE HARD STOP: an external domain that has never proved it points
       * here. There is no website for it on the node and issuing a certificate
       * for a name we have no relationship with is the impersonation case.
       *
       * A NAMESERVER MISMATCH ON ITS OWN IS NOT A STOP, and an earlier version
       * of this made it one — which would have refused every customer running
       * their DNS at Cloudflare with an A record pointed at us. Their site
       * resolves here, so the ACME challenge succeeds, and their nameservers
       * are none of our business. Let's Encrypt decides; we only decline the
       * request we know we have no standing to make.
       */
      const verified = verdict.matched || Boolean(domainRow.ns_verified_at);
      if (!linking.mayPoint({ ...domainRow, ns_verified_at: verified ? new Date() : null })) {
        flash(
          res,
          `${service.primary_domain} is not pointing at us yet${verdict.nameservers.length
            ? ` — we can see ${verdict.nameservers.join(' and ')}`
            : ''}. Set the nameservers below, then try again in a few minutes.`,
          'warn',
        );
        return res.redirect(`/panel/services/${service.id}`);
      }
    }

    try {
      await hestia.enableSSL({ username: req.customer.hestia_user, domain: service.primary_domain });
      await db.logActivity({
        actorType: 'customer', actorId: req.customer.id, action: 'ssl.issued',
        target: service.primary_domain, ip: req.ip,
      });
      flash(res, 'Certificate issued — your padlock should appear within a minute.');
    } catch (err) {
      await db.logActivity({
        actorType: 'customer', actorId: req.customer.id, action: 'ssl.failed',
        target: service.primary_domain, detail: err.message, ok: false, ip: req.ip,
      });
      /*
       * When the lookup above told us where the domain actually points, say so.
       * "Check the nameservers" is advice; "we can see ns1.othercompany.com" is
       * the answer, and it is the difference between a fix and a ticket.
       */
      flash(
        res,
        verdict && !verdict.matched && verdict.nameservers.length
          ? `We could not issue the certificate yet. ${service.primary_domain} points at `
            + `${verdict.nameservers.join(' and ')} — if your DNS is elsewhere, make sure its A record points at us.`
          : 'We could not issue the certificate yet. This nearly always means the domain is not pointing at us — check the nameservers below, then try again in a few minutes.',
        'error',
      );
    }
    res.redirect(`/panel/services/${service.id}`);
  } catch (err) {
    next(err);
  }
});

/**
 * Databases, mailboxes and backups — read-through to the node.
 *
 * The tab is validated in the handler rather than with an inline regex in the
 * path. Express 5 moved to path-to-regexp v8, which dropped `:tab(a|b|c)`
 * entirely: that syntax now throws at route-registration time, i.e. at boot.
 */
const SERVICE_TABS = ['databases', 'email', 'backups'];

router.get('/services/:id/:tab', async (req, res, next) => {
  try {
    if (!SERVICE_TABS.includes(req.params.tab)) return next();

    const service = await ownedService(req);
    if (!service) return next();

    const user = req.customer.hestia_user;
    let items = [];
    let error = null;

    if (user && service.status === 'active') {
      try {
        if (req.params.tab === 'databases') items = await hestia.listDatabases(user);
        if (req.params.tab === 'email') {
          items = await hestia.listMailAccounts({ username: user, domain: service.primary_domain });
        }
        if (req.params.tab === 'backups') items = await hestia.listBackups(user);
      } catch (err) {
        error = err.message;
      }
    }

    /*
     * The mailbox allowance is computed for the tab that spends it, and only
     * there. It reads the node, so putting it on every service page would cost
     * a round trip to Hestia to render a backups list.
     */
    const quota = req.params.tab === 'email' ? await mailboxes.allowance(req.customer) : null;
    const mailDomains = req.params.tab === 'email' ? await mailboxes.usableDomains(req.customer) : [];

    res.render(`panel/service-${req.params.tab}`, {
      title: `${service.primary_domain || service.plan_name} — ${req.params.tab}`,
      robots: 'noindex',
      service,
      items,
      error,
      quota,
      mailDomains,
      hestiaLive: hestia.isLive(),
      ssoReady: sso.configured(),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Open a database in phpMyAdmin, already signed in.
 *
 * This is a redirect and not a link rendered into the page on purpose. The
 * node gives a signed handoff sixty seconds to be used, so a URL baked into
 * HTML would be stale before most people finished reading the page. Minting it
 * at the moment of the click also keeps the token out of our own page source.
 *
 * Ownership is re-derived from the node's list rather than trusted from the
 * URL — the same rule the DNS record routes follow. A customer editing the
 * database name in the address bar gets a 404, not somebody else's data.
 */
router.get('/services/:id/databases/:name/open', async (req, res, next) => {
  try {
    const service = await ownedService(req);
    if (!service) return next();

    const user = req.customer.hestia_user;
    if (!user || service.status !== 'active') return next();

    if (!sso.configured()) {
      flash(res, 'One-click database access is not set up on this server yet.', 'warn');
      return res.redirect(`/panel/services/${service.id}/databases`);
    }

    // The node is the authority on what this account owns.
    const owned = await hestia.listDatabases(user);
    const target = owned.find((d) => d.name === req.params.name);
    if (!target) return next();

    const url = target.type === 'pgsql'
      ? sso.phpPgAdminUrl(req, { username: user, database: target.name })
      : sso.phpMyAdminUrl(req, { username: user, database: target.name });

    await db.logActivity({
      actorType: 'customer', actorId: req.customer.id, action: 'database.sso_opened',
      target: target.name, detail: target.type || 'mysql', ip: req.ip,
    });
    return res.redirect(url);
  } catch (err) {
    // A node that cannot mint the handoff must not 500 the panel — the
    // customer still has the connection details on the page behind them.
    flash(res, `Could not open that database: ${err.message}`, 'error');
    return res.redirect(`/panel/services/${req.params.id}/databases`);
  }
});

/**
 * Create a mailbox.
 *
 * The allowance is checked HERE, against the node's own count, and not against
 * anything the page was rendered with. A form drawn when three mailboxes were
 * free and submitted twenty minutes later has to be told the truth as it is
 * now, and a customer with two tabs open must not be able to spend the same
 * last mailbox in both.
 */
router.post('/services/:id/email', async (req, res, next) => {
  try {
    const back = `/panel/services/${req.params.id}/email`;
    if (!auth.checkCsrf(req)) return res.redirect(back);
    const service = await ownedService(req);
    if (!service) return next();

    if (service.status !== 'active') {
      flash(res, 'This hosting account is not live yet.', 'warn');
      return res.redirect(back);
    }

    const account = field(req.body.account, 60).toLowerCase();
    const domain = field(req.body.domain, 190).toLowerCase();
    const password = String(req.body.password || '');

    if (!/^[a-z0-9._-]{1,60}$/.test(account)) {
      flash(res, 'A mailbox name can only contain letters, numbers, dots, hyphens and underscores.', 'error');
      return res.redirect(back);
    }
    const problem = auth.passwordProblem(password);
    if (problem) {
      flash(res, problem, 'error');
      return res.redirect(back);
    }

    // The domain has to be one we actually serve mail for — see usableDomains().
    const allowedDomains = await mailboxes.usableDomains(req.customer);
    const target = allowedDomains.find((d) => d.domain === domain) ? domain : '';
    if (!target) {
      flash(res, 'Pick one of your own domains, pointed at us, to create the mailbox at.', 'error');
      return res.redirect(back);
    }

    const verdict = await mailboxes.canCreate(req.customer);
    if (!verdict.ok) {
      flash(res, verdict.reason, 'warn');
      return res.redirect(back);
    }

    try {
      // The mail domain may not exist on the node yet — a second hosting
      // account, or a domain added after provisioning. Creating it is cheap and
      // "already exists" is not a failure.
      await hestia.addMailDomain({ username: req.customer.hestia_user, domain: target })
        .catch((err) => { if (err.code !== 4) throw err; });

      await hestia.addMailAccount({
        username: req.customer.hestia_user,
        domain: target,
        account,
        password,
      });
      await db.logActivity({
        actorType: 'customer', actorId: req.customer.id, action: 'mailbox.created',
        target: `${account}@${target}`,
        detail: `${verdict.quota.used + 1} of ${verdict.quota.total}`, ip: req.ip,
      });
      flash(res, `${account}@${target} is ready. Sign in to webmail with the password you just set.`);
    } catch (err) {
      flash(res, `The mail server refused that: ${err.message}`, 'error');
    }
    res.redirect(back);
  } catch (err) {
    next(err);
  }
});

/** Delete a mailbox — and everything in it, which the page says twice. */
router.post('/services/:id/email/delete', async (req, res, next) => {
  try {
    const back = `/panel/services/${req.params.id}/email`;
    if (!auth.checkCsrf(req)) return res.redirect(back);
    const service = await ownedService(req);
    if (!service) return next();

    const account = field(req.body.account, 60).toLowerCase();
    const domain = field(req.body.domain, 190).toLowerCase();

    // Ownership again, from the database: the address in the form is the one
    // thing a customer can edit, and deleting a mailbox at somebody else's
    // domain is exactly what that edit would be for.
    const allowedDomains = await mailboxes.usableDomains(req.customer);
    if (!account || !allowedDomains.find((d) => d.domain === domain)) return next();

    try {
      await hestia.deleteMailAccount({ username: req.customer.hestia_user, domain, account });
      await db.logActivity({
        actorType: 'customer', actorId: req.customer.id, action: 'mailbox.deleted',
        target: `${account}@${domain}`, ip: req.ip,
      });
      flash(res, `${account}@${domain} has been deleted.`);
    } catch (err) {
      flash(res, `The mail server refused that: ${err.message}`, 'error');
    }
    res.redirect(back);
  } catch (err) {
    next(err);
  }
});

router.post('/services/:id/backups', async (req, res, next) => {
  try {
    if (!auth.checkCsrf(req)) return res.redirect(`/panel/services/${req.params.id}/backups`);
    const service = await ownedService(req);
    if (!service) return next();

    if (rateLimited(req.customer.id, 'backup', { max: 2, windowMs: 86_400_000 })) {
      flash(res, 'You can take two manual backups a day. Automatic ones keep running as normal.', 'warn');
      return res.redirect(`/panel/services/${service.id}/backups`);
    }

    try {
      await hestia.createBackup(req.customer.hestia_user);
      flash(res, 'Backup started. It will appear here when it finishes — usually a few minutes.');
    } catch (err) {
      flash(res, `Could not start the backup: ${err.message}`, 'error');
    }
    res.redirect(`/panel/services/${service.id}/backups`);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Domains
// ---------------------------------------------------------------------------
router.get('/domains', async (req, res, next) => {
  try {
    // A removed domain is history, not a holding. It stays in the table so the
    // activity log and any future re-add have something to point at, and out of
    // this list so the panel only ever shows domains the account actually has.
    const domains = await db.query(
      `SELECT * FROM domains WHERE customer_id = ? AND status <> 'removed'
        ORDER BY expires_at IS NULL, expires_at ASC`,
      [req.customer.id],
    );
    res.render('panel/domains', {
      title: 'Your domains',
      robots: 'noindex',
      domains,
      graceDays: DOMAIN_NS_GRACE_DAYS,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Add a domain you already own.
 *
 * Registered ABOVE `/domains/:id` on purpose — Express matches in order, and a
 * parameter route declared first would swallow `/domains/add` and answer 404.
 */
router.get('/domains/add', async (req, res, next) => {
  try {
    const services = await db.query(
      `SELECT s.id, s.primary_domain, p.name AS plan_name FROM services s
         JOIN plans p ON p.id = s.plan_id
        WHERE s.customer_id = ? AND s.status = 'active'`,
      [req.customer.id],
    );
    res.render('panel/domain-add', {
      title: 'Add a domain',
      robots: 'noindex',
      services,
      nameservers: NAMESERVERS,
      graceDays: DOMAIN_NS_GRACE_DAYS,
      values: {},
      errors: {},
    });
  } catch (err) {
    next(err);
  }
});

router.post('/domains/add', async (req, res, next) => {
  try {
    if (!auth.checkCsrf(req)) return res.redirect('/panel/domains/add');

    if (rateLimited(req.customer.id, 'domain-add', { max: 10, windowMs: 3600_000 })) {
      flash(res, 'That is a lot of domains in one go. Try again in a little while.', 'warn');
      return res.redirect('/panel/domains');
    }

    const wanted = field(req.body.domain, 190);
    const serviceId = Number(req.body.service_id) || null;

    // The service, if one was chosen, has to be this customer's own.
    let attachTo = null;
    if (serviceId) {
      const owned = await db.one(
        'SELECT id FROM services WHERE id = ? AND customer_id = ? LIMIT 1',
        [serviceId, req.customer.id],
      );
      attachTo = owned ? owned.id : null;
    }

    const added = await linking.addExternal({
      customer: req.customer,
      domain: wanted,
      serviceId: attachTo,
    });

    if (!added.ok) {
      if (added.id) {
        flash(res, added.error, 'warn');
        return res.redirect(`/panel/domains/${added.id}`);
      }
      const services = await db.query(
        `SELECT s.id, s.primary_domain, p.name AS plan_name FROM services s
           JOIN plans p ON p.id = s.plan_id
          WHERE s.customer_id = ? AND s.status = 'active'`,
        [req.customer.id],
      );
      return res.status(400).render('panel/domain-add', {
        title: 'Add a domain',
        robots: 'noindex',
        services,
        nameservers: NAMESERVERS,
        graceDays: DOMAIN_NS_GRACE_DAYS,
        values: { domain: wanted, service_id: serviceId },
        errors: { domain: added.error },
      });
    }

    /*
     * Checked once, immediately. Most people add a domain AFTER changing the
     * nameservers, so this is usually the moment it goes live — and being told
     * "you are all set" on the same screen is worth far more than the same
     * message arriving from a sweep fifteen minutes later.
     */
    const verdict = await linking.verify(added.row, { customer: req.customer });

    flash(
      res,
      verdict.matched
        ? `${added.domain} is pointing at us — we are setting it up now.`
        : `${added.domain} has been added. Set the nameservers below at your registrar; `
          + `we check every few minutes and will email you when it is live.`,
      verdict.matched ? 'ok' : 'warn',
    );
    res.redirect(`/panel/domains/${added.id}`);
  } catch (err) {
    next(err);
  }
});

router.get('/domains/:id', async (req, res, next) => {
  try {
    const domain = await ownedDomain(req);
    if (!domain) return next();
    // The renewal quote is in the visitor's own currency: nothing has been
    // charged yet, so this is a shop price like any other.
    const price = await pricing.priceForTld(domain.tld, req.currency);
    res.render('panel/domain', {
      title: domain.domain,
      robots: 'noindex',
      domain,
      price,
      defaultNameservers: NAMESERVERS,
      registrarLive: registrar.isLive(),
      graceDays: DOMAIN_NS_GRACE_DAYS,
      // What the customer may do with it, decided by the server. The template
      // asks these rather than re-deriving the rules in EJS, where they would
      // be a second copy that drifts.
      canEditDns: linking.mayEditDns(domain, req.customer),
      // Only an external domain can be taken off the account — one registered
      // here is the customer's property and leaves by transfer, not by button.
      canRemove: domain.source === 'external',
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Check the nameservers now.
 *
 * The whole point of a manual check is impatience — somebody has just saved the
 * change at their registrar and wants to know. Rate-limited because a DNS
 * lookup per click is a lookup somebody will hold down the button on, and
 * because propagation is not measured in seconds.
 */
router.post('/domains/:id/verify', async (req, res, next) => {
  try {
    if (!auth.checkCsrf(req)) return res.redirect(`/panel/domains/${req.params.id}`);
    const domain = await ownedDomain(req);
    if (!domain) return next();

    const back = `/panel/domains/${domain.id}`;
    if (rateLimited(req.customer.id, 'domain-verify', { max: 12, windowMs: 600_000 })) {
      flash(res, 'We have just checked a few times. Give DNS a couple of minutes and try again.', 'warn');
      return res.redirect(back);
    }

    const verdict = await linking.verify(domain, { customer: req.customer });

    if (verdict.matched) {
      flash(
        res,
        verdict.pointed?.pointed
          ? `${domain.domain} points at us and the site is set up.`
          : `${domain.domain} points at us. ${verdict.pointed?.reason || ''}`.trim(),
      );
    } else {
      flash(
        res,
        verdict.nameservers.length
          ? `Not yet — ${domain.domain} still points at ${verdict.nameservers.join(' and ')}.`
          : `Not yet — ${verdict.error || 'we could not read its nameservers.'}`,
        'warn',
      );
    }
    res.redirect(back);
  } catch (err) {
    next(err);
  }
});

/** Take an external domain off the account. The domain itself is untouched. */
router.post('/domains/:id/remove', async (req, res, next) => {
  try {
    if (!auth.checkCsrf(req)) return res.redirect(`/panel/domains/${req.params.id}`);
    const domain = await ownedDomain(req);
    if (!domain) return next();

    if (domain.source !== 'external') {
      flash(
        res,
        'This domain is registered with us, so it cannot be removed here — open a ticket and we will transfer it out for you.',
        'warn',
      );
      return res.redirect(`/panel/domains/${domain.id}`);
    }

    await db.query("UPDATE domains SET status = 'removed', service_id = NULL WHERE id = ?", [domain.id]);
    await db.logActivity({
      actorType: 'customer', actorId: req.customer.id, action: 'domain.removed',
      target: domain.domain, ip: req.ip,
    });
    flash(res, `${domain.domain} has been removed from your account. The domain itself is untouched.`);
    res.redirect('/panel/domains');
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// DNS
//
// Editable for any domain we are actually answering for — see mayEditDns().
// The records live on the node, which is what our nameservers serve from, so
// there is no copy here to keep in step and no "save and publish" step: an edit
// is live as soon as the node accepts it.
// ---------------------------------------------------------------------------
router.get('/domains/:id/dns', async (req, res, next) => {
  try {
    const domain = await ownedDomain(req);
    if (!domain) return next();

    const allowed = linking.mayEditDns(domain, req.customer);
    let records = [];
    let error = '';

    if (allowed.ok) {
      try {
        records = await hestia.listDnsRecords({
          username: req.customer.hestia_user,
          domain: domain.domain,
        });
      } catch (err) {
        // Exit code 5 is "no such object" — the zone has not been created yet,
        // which is a state, not a fault. Anything else is worth showing.
        error = err.code === 5 ? '' : err.message;
      }
    }

    res.render('panel/domain-dns', {
      title: `${domain.domain} — DNS`,
      robots: 'noindex',
      domain,
      records,
      error,
      allowed,
      types: hestia.DNS_TYPES,
      hestiaLive: hestia.isLive(),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/domains/:id/dns', async (req, res, next) => {
  try {
    const back = `/panel/domains/${req.params.id}/dns`;
    if (!auth.checkCsrf(req)) return res.redirect(back);
    const domain = await ownedDomain(req);
    if (!domain) return next();

    const allowed = linking.mayEditDns(domain, req.customer);
    if (!allowed.ok) {
      flash(res, allowed.reason, 'warn');
      return res.redirect(back);
    }

    const action = String(req.body.action || 'add');
    const username = req.customer.hestia_user;
    const id = field(req.body.record_id, 12);

    /*
     * Delete takes only the record id, and takes it from the node's own list
     * rather than trusting the form: an id that is not in this zone belongs to
     * somebody else's, and Hestia would happily delete it if asked as admin.
     */
    if (action === 'delete') {
      try {
        const existing = await hestia.listDnsRecords({ username, domain: domain.domain });
        if (!existing.some((r) => r.id === id)) return res.redirect(back);
        await hestia.deleteDnsRecord({ username, domain: domain.domain, id });
        await db.logActivity({
          actorType: 'customer', actorId: req.customer.id, action: 'dns.deleted',
          target: domain.domain, detail: `record ${id}`, ip: req.ip,
        });
        flash(res, 'Record deleted. DNS changes reach everyone within the record’s TTL.');
      } catch (err) {
        flash(res, `The server refused that: ${err.message}`, 'error');
      }
      return res.redirect(back);
    }

    const checked = linking.validateRecord({
      name: req.body.name,
      type: req.body.type,
      value: req.body.value,
      priority: req.body.priority,
      ttl: req.body.ttl,
    });
    if (!checked.ok) {
      flash(res, checked.error, 'error');
      return res.redirect(back);
    }
    const record = checked.record;

    try {
      if (action === 'edit' && id) {
        const existing = await hestia.listDnsRecords({ username, domain: domain.domain });
        if (!existing.some((r) => r.id === id)) return res.redirect(back);
        await hestia.changeDnsRecord({
          username, domain: domain.domain, id,
          name: record.name, type: record.type, value: record.value, priority: record.priority,
        });
      } else {
        await hestia.addDnsRecord({
          username, domain: domain.domain,
          name: record.name, type: record.type, value: record.value,
          priority: record.priority, ttl: record.ttl,
        });
      }
      await db.logActivity({
        actorType: 'customer', actorId: req.customer.id,
        action: action === 'edit' ? 'dns.changed' : 'dns.added',
        target: domain.domain,
        detail: `${record.name} ${record.type} ${record.value}`.slice(0, 190),
        ip: req.ip,
      });
      flash(res, action === 'edit' ? 'Record updated.' : 'Record added.');
    } catch (err) {
      flash(res, `The server refused that: ${err.message}`, 'error');
    }
    res.redirect(back);
  } catch (err) {
    next(err);
  }
});

router.post('/domains/:id/nameservers', async (req, res, next) => {
  try {
    if (!auth.checkCsrf(req)) return res.redirect(`/panel/domains/${req.params.id}`);
    const domain = await ownedDomain(req);
    if (!domain) return next();

    /*
     * Only for a domain we hold. An external one is registered somewhere else
     * entirely and its nameservers are set in that registrar's control panel —
     * a form here would send a change to a registrar that has never heard of
     * the name, and the customer would believe they had done what we asked.
     */
    if (domain.source === 'external') {
      flash(
        res,
        'This domain is registered elsewhere, so its nameservers are changed at that registrar, not here.',
        'warn',
      );
      return res.redirect(`/panel/domains/${domain.id}`);
    }

    const ns = [req.body.ns1, req.body.ns2, req.body.ns3, req.body.ns4]
      .map((n) => field(n, 190).toLowerCase())
      .filter(Boolean);

    if (ns.length < 2) {
      flash(res, 'A domain needs at least two nameservers.', 'error');
      return res.redirect(`/panel/domains/${domain.id}`);
    }

    try {
      await registrar.setNameservers({ domain: domain.domain, nameservers: ns });
      /*
       * The verification is dropped along with the old delegation. Pointing a
       * domain away from us has to stop it counting as pointed at us — that
       * flag is what lets a certificate be issued and a mailbox be created for
       * the name, and leaving it set after the customer moved the domain
       * elsewhere would be recording something that is no longer true. The
       * sweep re-checks and restores it if the new nameservers are still ours.
       */
      await db.query(
        `UPDATE domains SET ns1=?, ns2=?, ns3=?, ns4=?, ns_verified_at = NULL, ns_checked_at = NULL
          WHERE id = ?`,
        [ns[0] || '', ns[1] || '', ns[2] || '', ns[3] || '', domain.id],
      );
      await db.logActivity({
        actorType: 'customer', actorId: req.customer.id, action: 'domain.nameservers_changed',
        target: domain.domain, detail: ns.join(', '), ip: req.ip,
      });
      flash(res, 'Nameservers updated. It can take a few hours to take effect everywhere.');
    } catch (err) {
      flash(res, `Could not update the nameservers: ${err.message}`, 'error');
    }
    res.redirect(`/panel/domains/${domain.id}`);
  } catch (err) {
    next(err);
  }
});

router.post('/domains/:id/auto-renew', async (req, res, next) => {
  try {
    if (!auth.checkCsrf(req)) return res.redirect(`/panel/domains/${req.params.id}`);
    const domain = await ownedDomain(req);
    if (!domain) return next();

    const on = req.body.auto_renew === '1';
    await db.query('UPDATE domains SET auto_renew = ? WHERE id = ?', [on ? 1 : 0, domain.id]);
    await db.logActivity({
      actorType: 'customer', actorId: req.customer.id,
      action: on ? 'domain.autorenew_on' : 'domain.autorenew_off', target: domain.domain, ip: req.ip,
    });
    flash(
      res,
      on
        ? 'Automatic renewal is on. We will email you before we take payment.'
        : 'Automatic renewal is off. This domain will expire on its expiry date unless you renew it manually.',
      on ? 'ok' : 'warn',
    );
    res.redirect(`/panel/domains/${domain.id}`);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Billing
// ---------------------------------------------------------------------------
router.get('/billing', async (req, res, next) => {
  try {
    const orders = await db.query(
      'SELECT * FROM orders WHERE customer_id = ? ORDER BY created_at DESC LIMIT 100',
      [req.customer.id],
    );
    const services = await db.query(
      `SELECT s.*, p.name AS plan_name FROM services s JOIN plans p ON p.id = s.plan_id
        WHERE s.customer_id = ? AND s.status = 'active' ORDER BY s.next_due_at ASC`,
      [req.customer.id],
    );
    res.render('panel/billing', { title: 'Billing', robots: 'noindex', orders, services });
  } catch (err) {
    next(err);
  }
});

router.get('/orders/:id', async (req, res, next) => {
  try {
    const order = await db.one('SELECT * FROM orders WHERE id = ? AND customer_id = ? LIMIT 1', [
      req.params.id,
      req.customer.id,
    ]);
    if (!order) return next();
    const items = await db.query('SELECT * FROM order_items WHERE order_id = ?', [order.id]);
    res.render('panel/order', { title: `Order ${order.reference}`, robots: 'noindex', order, items });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------
router.get('/tickets', async (req, res, next) => {
  try {
    const tickets = await db.query(
      'SELECT * FROM tickets WHERE customer_id = ? ORDER BY updated_at DESC',
      [req.customer.id],
    );
    res.render('panel/tickets', { title: 'Support tickets', robots: 'noindex', tickets });
  } catch (err) {
    next(err);
  }
});

router.get('/tickets/new', async (req, res, next) => {
  try {
    const services = await db.query(
      `SELECT s.id, s.primary_domain, p.name AS plan_name FROM services s
         JOIN plans p ON p.id = s.plan_id
        WHERE s.customer_id = ? AND s.status <> 'terminated'`,
      [req.customer.id],
    );
    res.render('panel/ticket-new', { title: 'Open a ticket', robots: 'noindex', services, values: {}, errors: {} });
  } catch (err) {
    next(err);
  }
});

router.post('/tickets/new', async (req, res, next) => {
  try {
    const values = {
      subject: field(req.body.subject, 190),
      department: ['support', 'billing', 'abuse'].includes(req.body.department) ? req.body.department : 'support',
      priority: ['low', 'normal', 'high'].includes(req.body.priority) ? req.body.priority : 'normal',
      body: field(req.body.body, 20_000),
    };

    const errors = {};
    if (!auth.checkCsrf(req)) errors.form = 'Your session expired. Please try again.';
    if (!values.subject) errors.subject = 'Give it a short subject.';
    if (values.body.length < 10) errors.body = 'Please add a little more detail.';
    if (rateLimited(req.customer.id, 'ticket', { max: 10, windowMs: 3600_000 })) {
      errors.form = 'You have opened several tickets recently. Please reply to an existing one instead.';
    }

    if (Object.keys(errors).length) {
      const services = await db.query(
        `SELECT s.id, s.primary_domain, p.name AS plan_name FROM services s
           JOIN plans p ON p.id = s.plan_id WHERE s.customer_id = ?`,
        [req.customer.id],
      );
      return res.status(400).render('panel/ticket-new', {
        title: 'Open a ticket', robots: 'noindex', services, values, errors,
      });
    }

    const reference = `T${Date.now().toString(36).toUpperCase()}`;
    const name = `${req.customer.first_name} ${req.customer.last_name}`.trim();

    const ticketId = await db.transaction(async (conn) => {
      const [ins] = await conn.query(
        'INSERT INTO tickets (reference, customer_id, subject, department, priority) VALUES (?, ?, ?, ?, ?)',
        [reference, req.customer.id, values.subject, values.department, values.priority],
      );
      await conn.query(
        'INSERT INTO ticket_messages (ticket_id, author, author_name, body) VALUES (?, ?, ?, ?)',
        [ins.insertId, 'customer', name, values.body],
      );
      return ins.insertId;
    });

    sendMail({
      to: DEFAULT_TO,
      replyTo: req.customer.email,
      subject: `[${reference}] ${values.subject}`,
      html: shell({
        title: `New ${values.department} ticket`,
        bodyHtml:
          detailTable([
            ['From', `${escapeHtml(name)} &lt;${escapeHtml(req.customer.email)}&gt;`],
            ['Priority', escapeHtml(values.priority)],
            ['Reference', escapeHtml(reference)],
          ]) +
          `<p style="margin:18px 0 0;font-size:14px;line-height:1.65;white-space:pre-wrap">${escapeHtml(values.body)}</p>`,
        ctaText: 'Reply in admin',
        ctaUrl: `${res.locals.siteUrl}/admin/tickets/${ticketId}`,
      }),
    });

    flash(res, `Ticket ${reference} opened. We will reply by email as well as here.`);
    res.redirect(`/panel/tickets/${ticketId}`);
  } catch (err) {
    next(err);
  }
});

router.get('/tickets/:id', async (req, res, next) => {
  try {
    const ticket = await db.one('SELECT * FROM tickets WHERE id = ? AND customer_id = ? LIMIT 1', [
      req.params.id,
      req.customer.id,
    ]);
    if (!ticket) return next();
    const messages = await db.query(
      'SELECT * FROM ticket_messages WHERE ticket_id = ? ORDER BY created_at ASC',
      [ticket.id],
    );
    res.render('panel/ticket', { title: ticket.subject, robots: 'noindex', ticket, messages });
  } catch (err) {
    next(err);
  }
});

router.post('/tickets/:id/reply', async (req, res, next) => {
  try {
    if (!auth.checkCsrf(req)) return res.redirect(`/panel/tickets/${req.params.id}`);
    const ticket = await db.one('SELECT * FROM tickets WHERE id = ? AND customer_id = ? LIMIT 1', [
      req.params.id,
      req.customer.id,
    ]);
    if (!ticket) return next();

    const body = field(req.body.body, 20_000);
    if (body.length < 2) {
      flash(res, 'Write something first.', 'warn');
      return res.redirect(`/panel/tickets/${ticket.id}`);
    }

    const name = `${req.customer.first_name} ${req.customer.last_name}`.trim();
    await db.query(
      'INSERT INTO ticket_messages (ticket_id, author, author_name, body) VALUES (?, ?, ?, ?)',
      [ticket.id, 'customer', name, body],
    );
    // Reopening a closed ticket by replying is what a customer expects; making
    // them open a new one to say "that did not work" is hostile.
    await db.query('UPDATE tickets SET status = ?, updated_at = NOW() WHERE id = ?', ['customer_reply', ticket.id]);

    sendMail({
      to: DEFAULT_TO,
      replyTo: req.customer.email,
      subject: `[${ticket.reference}] Re: ${ticket.subject}`,
      html: shell({
        title: 'Customer replied',
        intro: `${escapeHtml(name)} replied to ticket ${escapeHtml(ticket.reference)}.`,
        bodyHtml: `<p style="margin:0;font-size:14px;line-height:1.65;white-space:pre-wrap">${escapeHtml(body)}</p>`,
        ctaText: 'Open in admin',
        ctaUrl: `${res.locals.siteUrl}/admin/tickets/${ticket.id}`,
      }),
    });

    res.redirect(`/panel/tickets/${ticket.id}`);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Account settings
// ---------------------------------------------------------------------------
router.get('/settings', (req, res) => {
  res.render('panel/settings', { title: 'Account settings', robots: 'noindex', errors: {}, values: {} });
});

router.post('/settings', async (req, res, next) => {
  try {
    if (!auth.checkCsrf(req)) return res.redirect('/panel/settings');
    const values = {
      first_name: field(req.body.first_name, 80),
      last_name: field(req.body.last_name, 80),
      company: field(req.body.company, 160),
      phone: field(req.body.phone, 40),
      address1: field(req.body.address1, 160),
      address2: field(req.body.address2, 160),
      city: field(req.body.city, 80),
      postcode: field(req.body.postcode, 24),
      country: field(req.body.country, 2).toUpperCase() || 'GB',
    };

    const errors = {};
    if (!values.first_name) errors.first_name = 'Required.';
    if (!values.last_name) errors.last_name = 'Required.';
    if (Object.keys(errors).length) {
      return res.status(400).render('panel/settings', { title: 'Account settings', robots: 'noindex', errors, values });
    }

    await db.query(
      `UPDATE customers SET first_name=?, last_name=?, company=?, phone=?,
              address1=?, address2=?, city=?, postcode=?, country=? WHERE id = ?`,
      [
        values.first_name, values.last_name, values.company, values.phone,
        values.address1, values.address2, values.city, values.postcode, values.country,
        req.customer.id,
      ],
    );
    flash(res, 'Details saved.');
    res.redirect('/panel/settings');
  } catch (err) {
    next(err);
  }
});

router.post('/settings/password', async (req, res, next) => {
  try {
    if (!auth.checkCsrf(req)) return res.redirect('/panel/settings');

    const current = String(req.body.current_password || '');
    const next_ = String(req.body.new_password || '');
    const again = String(req.body.new_password_confirm || '');

    const ok = await auth.checkPassword(current, req.customer.password_hash);
    if (!ok) {
      flash(res, 'Your current password is not right.', 'error');
      return res.redirect('/panel/settings');
    }
    if (next_ !== again) {
      flash(res, 'The two new passwords do not match.', 'error');
      return res.redirect('/panel/settings');
    }
    const problem = auth.passwordProblem(next_);
    if (problem) {
      flash(res, problem, 'error');
      return res.redirect('/panel/settings');
    }

    const hash = await auth.hashPassword(next_);
    await db.query('UPDATE customers SET password_hash = ? WHERE id = ?', [hash, req.customer.id]);
    await db.logActivity({
      actorType: 'customer', actorId: req.customer.id, action: 'password.changed',
      target: req.customer.email, ip: req.ip,
    });

    sendMail({
      to: req.customer.email,
      subject: 'Your password was changed — Vesopa Hosting',
      html: shell({
        title: 'Your password was changed',
        intro: 'The password on your Vesopa Hosting account has just been changed, and every other device has been signed out.',
        footNote: '<b>If this was not you</b>, reply to this email immediately.',
      }),
    });

    // The fingerprint has moved, so this browser needs a fresh cookie too.
    const updated = await db.one('SELECT * FROM customers WHERE id = ? LIMIT 1', [req.customer.id]);
    auth.issueCustomerSession(res, updated);

    flash(res, 'Password changed. Other devices have been signed out.');
    res.redirect('/panel/settings');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
