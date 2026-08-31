/**
 * Notifications — the panel's own inbox, and the warning banner on top of it.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * Everything this system knew that a customer needed to act on was delivered
 * one of two ways, and both of them lose the message:
 *
 *   a flash message  gone on the next click
 *   an email         gone into a spam folder, or read on a phone and forgotten
 *
 * Neither survives long enough to be a to-do list, and "your domain will be
 * suspended in 15 days unless you click a link" IS a to-do list. arpi.site is
 * the worked example: registered, an ICANN verification mail sent to an address
 * the customer does not watch, and nothing anywhere in the panel saying a
 * verification was outstanding. It sat unusable for nine hours, and the only
 * reason it was ever fixed is that the customer went looking on their own.
 *
 * ---------------------------------------------------------------------------
 * THE TWO HALVES, AND WHY THEY ARE SEPARATE
 * ---------------------------------------------------------------------------
 * `raise()` and friends are the INBOX: durable rows, deduped, that persist
 * until the condition clears. They are written by the things that know —
 * provisioning, the DNS sweep, the registrar adapter.
 *
 * `collect()` is the BANNER: it derives the current warnings by looking at the
 * account as it is right now. It writes nothing and is safe to call on every
 * page render.
 *
 * They are separate because they answer different questions. The inbox answers
 * "what has happened that I should know about", which needs history. The banner
 * answers "what is broken with my account right now", which needs the truth as
 * of this millisecond and must never show a stale row for a problem the
 * customer fixed two minutes ago. Deriving the banner from stored rows would
 * mean every fix has to remember to resolve its own notification, and the one
 * that forgets leaves a permanent red bar on a healthy account.
 *
 * ---------------------------------------------------------------------------
 * LEVELS ARE NOT DECORATION
 * ---------------------------------------------------------------------------
 *   error    broken now, losing service now          red
 *   warn     will break on a known date if ignored   amber
 *   success  something awaited has finished          green
 *   info     worth knowing, nothing to do            blue
 *
 * A thing that is merely pending is NOT a warning. Colouring "your site is
 * being set up" amber teaches people that amber means nothing, and then the
 * amber that means "verify this or lose the domain" is ignored too.
 *
 * ---------------------------------------------------------------------------
 * EVERY WARNING CARRIES ITS OWN FIX
 * ---------------------------------------------------------------------------
 * `fix_url` points at the page that resolves THIS problem — not a section
 * index. A warning that says "there is a problem with one of your domains" and
 * drops the customer on a list of nine domains has not helped them; they still
 * have to find it. That is the difference between a banner people act on and a
 * banner people learn to scroll past.
 */

const db = require('./db');

/** The areas a notification can belong to, matching the ENUM in schema.sql. */
const AREAS = ['account', 'hosting', 'domain', 'email', 'billing'];

/** Ordering for display: worst first, then newest. */
const LEVEL_RANK = { error: 0, warn: 1, success: 2, info: 3 };

function sortWarnings(list) {
  return [...list].sort((a, b) => {
    const d = (LEVEL_RANK[a.level] ?? 9) - (LEVEL_RANK[b.level] ?? 9);
    return d !== 0 ? d : String(a.title).localeCompare(String(b.title));
  });
}

// ---------------------------------------------------------------------------
// The inbox
// ---------------------------------------------------------------------------

/**
 * Record something the customer needs to know, or refresh it if it is already
 * standing.
 *
 * Deduped on `dedupe_key`, which is why the DNS sweep can call this every five
 * minutes for the same unverified domain without producing 288 rows a day. An
 * existing OPEN row is updated in place and keeps its `created_at`, so "you
 * have had this problem since Tuesday" stays true.
 *
 * Re-raising a RESOLVED key reopens it and clears `read_at`: the problem came
 * back, so it is new again and should be unread again.
 *
 * Never throws. A notification is a courtesy on top of an operation that has
 * already happened, and failing to write one must not fail the operation — a
 * domain that registered successfully is not a failed registration because the
 * notifications table was locked.
 */
async function raise({
  customerId, level = 'info', area = 'account',
  title, body = '', fixUrl = '', fixLabel = '', dedupeKey,
}) {
  if (!customerId || !title) return { ok: false };
  const key = String(dedupeKey || title).slice(0, 120);
  const safeArea = AREAS.includes(area) ? area : 'account';
  try {
    await db.query(
      `INSERT INTO notifications
         (customer_id, level, area, title, body, fix_url, fix_label, dedupe_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         level      = VALUES(level),
         area       = VALUES(area),
         title      = VALUES(title),
         body       = VALUES(body),
         fix_url    = VALUES(fix_url),
         fix_label  = VALUES(fix_label),
         -- A problem that has come back is unread again.
         read_at     = IF(resolved_at IS NULL, read_at, NULL),
         resolved_at = NULL`,
      [
        customerId, level, safeArea,
        String(title).slice(0, 190), String(body).slice(0, 600),
        String(fixUrl).slice(0, 300), String(fixLabel).slice(0, 60), key,
      ],
    );
    return { ok: true };
  } catch (err) {
    console.error('[notifications] could not raise:', err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * The condition has cleared. Idempotent, and silent if there was never a row —
 * callers resolve keys optimistically after a fix rather than checking first.
 */
async function resolve(customerId, dedupeKey) {
  if (!customerId || !dedupeKey) return;
  try {
    await db.query(
      `UPDATE notifications SET resolved_at = NOW()
        WHERE customer_id = ? AND dedupe_key = ? AND resolved_at IS NULL`,
      [customerId, String(dedupeKey).slice(0, 120)],
    );
  } catch (err) {
    console.error('[notifications] could not resolve:', err.message);
  }
}

/** Resolve every open key starting with this prefix — "domain:14:" and so on. */
async function resolvePrefix(customerId, prefix) {
  if (!customerId || !prefix) return;
  try {
    await db.query(
      `UPDATE notifications SET resolved_at = NOW()
        WHERE customer_id = ? AND dedupe_key LIKE ? AND resolved_at IS NULL`,
      [customerId, `${String(prefix).slice(0, 100)}%`],
    );
  } catch (err) {
    console.error('[notifications] could not resolve prefix:', err.message);
  }
}

/** The bell's list. Newest first, unresolved and recently-resolved together. */
async function list(customerId, { limit = 30, unreadOnly = false } = {}) {
  if (!customerId) return [];
  const where = unreadOnly ? 'AND read_at IS NULL' : '';
  return db.query(
    `SELECT * FROM notifications
      WHERE customer_id = ? ${where}
        AND (resolved_at IS NULL OR resolved_at > NOW() - INTERVAL 7 DAY)
      ORDER BY resolved_at IS NOT NULL, FIELD(level,'error','warn','success','info'), created_at DESC
      LIMIT ?`,
    [customerId, Number(limit) || 30],
  );
}

/** The number on the bell. Unread and unresolved only. */
async function unreadCount(customerId) {
  if (!customerId) return 0;
  const row = await db.one(
    'SELECT COUNT(*) AS n FROM notifications WHERE customer_id = ? AND read_at IS NULL AND resolved_at IS NULL',
    [customerId],
  );
  return Number(row?.n || 0);
}

async function markRead(customerId, id = null) {
  if (!customerId) return;
  if (id) {
    await db.query('UPDATE notifications SET read_at = NOW() WHERE customer_id = ? AND id = ? AND read_at IS NULL',
      [customerId, id]);
  } else {
    await db.query('UPDATE notifications SET read_at = NOW() WHERE customer_id = ? AND read_at IS NULL', [customerId]);
  }
}

// ---------------------------------------------------------------------------
// The banner
// ---------------------------------------------------------------------------

/**
 * Everything wrong with this account right now, derived live.
 *
 * Reads three tables and nothing from the node — this runs on every panel page
 * render, so it has to stay to a handful of indexed queries. Anything that
 * needs to ask Hestia or the public DNS is written down by the sweep when it
 * asks, and read from the row here.
 *
 * `area` filters to one section's warnings: the hosting page shows hosting
 * problems, the mail page shows mail problems. The dashboard passes nothing and
 * gets all of them, which is the point of the banner being on the dashboard.
 *
 * @returns {Promise<Array>} sorted worst-first, each with a fix_url that
 *   resolves that specific problem.
 */
async function collect(customer, { area = null } = {}) {
  if (!customer?.id) return [];
  const out = [];
  const add = (w) => { if (!area || w.area === area) out.push(w); };

  const [domains, services, emails] = await Promise.all([
    db.query(
      `SELECT * FROM domains
        WHERE customer_id = ? AND status NOT IN ('removed','cancelled')`,
      [customer.id],
    ),
    db.query(
      `SELECT s.*, p.name AS plan_name FROM services s
         JOIN plans p ON p.id = s.plan_id
        WHERE s.customer_id = ? AND s.status <> 'cancelled'`,
      [customer.id],
    ),
    db.query(
      `SELECT * FROM email_services WHERE customer_id = ? AND status <> 'cancelled'`,
      [customer.id],
    ).catch(() => []),
  ]);

  // --- Account-level ------------------------------------------------------
  if (!customer.email_verified) {
    add({
      level: 'warn',
      area: 'account',
      title: 'Confirm your email address',
      body: 'We send order confirmations, invoices and domain notices to this address. '
        + 'Until it is confirmed, those emails may not reach you.',
      fix_url: '/panel/settings',
      fix_label: 'Resend the email',
      key: 'account:email_unverified',
    });
  }

  /*
   * An incomplete address is only a problem for somebody who owns a domain,
   * and then it is a serious one: it is the registrant of record, and the
   * registry can suspend a domain over it. Nagging a hosting-only customer for
   * a postcode we have no use for is how a banner becomes wallpaper.
   */
  if (domains.length) {
    const missing = [];
    if (!String(customer.address1 || '').trim()) missing.push('street address');
    if (!String(customer.city || '').trim()) missing.push('city');
    if (!String(customer.postcode || '').trim()) missing.push('postcode');
    if (String(customer.phone || '').replace(/\D/g, '').length < 6) missing.push('phone number');
    if (missing.length) {
      add({
        level: 'error',
        area: 'account',
        title: 'Your registrant details are incomplete',
        body: `Your ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing. `
          + 'These are the details filed with the registry for your domains, and a registry '
          + 'can suspend a domain whose contact details are incomplete.',
        fix_url: '/panel/settings',
        fix_label: 'Complete my details',
        key: 'account:contact_incomplete',
      });
    }
  }

  // --- Domains ------------------------------------------------------------
  for (const d of domains) {
    const base = `/panel/domains/${d.id}`;

    /*
     * The registrant verification. This is the arpi.site failure, and it is an
     * ERROR rather than a warning once the deadline is inside a week, because
     * the consequence is not "a feature is unavailable" — it is the registry
     * turning the domain off.
     */
    if (d.verification_deadline && !d.registrant_verified_at) {
      const daysLeft = Math.ceil((new Date(d.verification_deadline) - Date.now()) / 864e5);
      const overdue = daysLeft <= 0;
      add({
        level: overdue || daysLeft <= 7 ? 'error' : 'warn',
        area: 'domain',
        title: overdue
          ? `${d.domain} may be suspended — verification overdue`
          : `Verify your email for ${d.domain}`,
        body: overdue
          ? `The registry required the registrant address (${d.registrant_email || customer.email}) to be `
            + 'confirmed and the deadline has passed. The domain can be suspended at any time until it is. '
            + 'Open the verification email from the registrar, or ask us to send it again.'
          : `The registry requires you to confirm ${d.registrant_email || customer.email} within `
            + `${daysLeft} day${daysLeft === 1 ? '' : 's'}, or ${d.domain} will be suspended. `
            + 'Check your inbox for an email from the registrar — it is easy to miss.',
        fix_url: `${base}#verification`,
        fix_label: 'How to verify',
        key: `domain:${d.id}:registrant_verification`,
      });
    }

    // The registrar is showing somebody else as the owner of this name.
    if (d.status === 'active' && d.source !== 'external' && d.contacts_verified === 0 && d.contacts_warning) {
      add({
        level: 'error',
        area: 'domain',
        title: `${d.domain} is registered to the wrong contact`,
        body: d.contacts_warning,
        fix_url: `${base}#contacts`,
        fix_label: 'Fix the owner details',
        key: `domain:${d.id}:contacts`,
      });
    }

    // Delegated nowhere useful. Only for names the customer has to act on —
    // an external domain we are waiting on.
    if (d.source === 'external' && !d.ns_verified_at && d.status !== 'pending') {
      const deadline = d.ns_grace_until ? new Date(d.ns_grace_until) : null;
      const daysLeft = deadline ? Math.ceil((deadline - Date.now()) / 864e5) : null;
      add({
        level: daysLeft !== null && daysLeft <= 3 ? 'error' : 'warn',
        area: 'domain',
        title: `${d.domain} is not pointing at us yet`,
        body: 'Change the nameservers at your current registrar to ours, and this domain will go live '
          + `automatically.${daysLeft !== null && daysLeft > 0
            ? ` If it has not by ${deadline.toDateString()}, it will be removed from your account.` : ''}`,
        fix_url: `${base}#nameservers`,
        fix_label: 'Show me the nameservers',
        key: `domain:${d.id}:not_delegated`,
      });
    }

    /*
     * A certificate that has expired or is about to. Read from the stored
     * expiry, not from the SSL flag — see the note on webDomainCert in the
     * Hestia adapter for why the flag cannot answer this.
     */
    if (d.ssl_expires_at) {
      const daysLeft = Math.ceil((new Date(d.ssl_expires_at) - Date.now()) / 864e5);
      if (daysLeft <= 0) {
        add({
          level: 'error',
          area: 'domain',
          title: `The certificate for ${d.domain} has expired`,
          body: 'Visitors are seeing a security warning instead of your site. '
            + 'Issuing a new certificate usually takes under a minute.',
          fix_url: `${base}#ssl`,
          fix_label: 'Issue a new certificate',
          key: `domain:${d.id}:ssl_expired`,
        });
      } else if (daysLeft <= 10) {
        add({
          level: 'warn',
          area: 'domain',
          title: `The certificate for ${d.domain} expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`,
          body: 'Certificates normally renew themselves. If this one has not renewed by the time it '
            + 'expires, visitors will see a security warning.',
          fix_url: `${base}#ssl`,
          fix_label: 'Renew it now',
          key: `domain:${d.id}:ssl_expiring`,
        });
      }
    } else if (d.ssl_status === 'failed' && d.pointed_at) {
      add({
        level: 'warn',
        area: 'domain',
        title: `${d.domain} has no security certificate`,
        body: d.ssl_error || 'The last attempt to issue a certificate did not succeed.',
        fix_url: `${base}#ssl`,
        fix_label: 'Try again',
        key: `domain:${d.id}:ssl_failed`,
      });
    }

    // Expiring registration. Losing a domain is unrecoverable, so this starts
    // shouting a long way out.
    if (d.expires_at) {
      const daysLeft = Math.ceil((new Date(d.expires_at) - Date.now()) / 864e5);
      if (daysLeft <= 30) {
        add({
          level: daysLeft <= 7 ? 'error' : 'warn',
          area: 'domain',
          title: daysLeft <= 0
            ? `${d.domain} has expired`
            : `${d.domain} expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`,
          body: 'Once a domain lapses it can be bought by anyone, and getting it back is usually '
            + 'impossible. Renew it to keep it.',
          fix_url: `${base}#renew`,
          fix_label: 'Renew this domain',
          key: `domain:${d.id}:expiring`,
        });
      }
    }

    /*
     * Registered, delegated, and attached to nothing. This is the state
     * arpi.site was in, and on its own it is invisible: the domain page looks
     * fine and the hosting page does not mention it.
     */
    if (d.status === 'active' && !d.service_id && d.source !== 'subdomain' && services.length) {
      add({
        level: 'info',
        area: 'domain',
        title: `${d.domain} is not connected to any hosting yet`,
        body: 'The domain is registered and working, but it is not attached to a hosting plan, '
          + 'so there is no website behind it.',
        fix_url: `${base}#hosting`,
        fix_label: 'Connect it to hosting',
        key: `domain:${d.id}:unattached`,
      });
    }
  }

  // --- Hosting ------------------------------------------------------------
  for (const s of services) {
    const base = `/panel/services/${s.id}`;

    if (s.status === 'suspended') {
      add({
        level: 'error',
        area: 'hosting',
        title: `Your ${s.plan_name} hosting is suspended`,
        body: 'The site is not being served. This is usually an unpaid invoice.',
        fix_url: '/panel/billing',
        fix_label: 'Check billing',
        key: `service:${s.id}:suspended`,
      });
    }

    // Hosting bought, nothing to serve it under. The other half of the
    // unattached-domain warning, shown where the customer is looking.
    if (s.status === 'active' && !s.primary_domain) {
      const spare = domains.filter((d) => !d.service_id && d.status === 'active');
      add({
        level: 'warn',
        area: 'hosting',
        title: `Your ${s.plan_name} plan has no domain attached`,
        body: spare.length
          ? `Nothing is being served yet. ${spare.map((d) => d.domain).join(', ')} `
            + `${spare.length === 1 ? 'is' : 'are'} ready to connect.`
          : 'Nothing is being served yet. Connect a domain you own, or register one, to put a site live.',
        fix_url: `${base}#domain`,
        fix_label: 'Attach a domain',
        key: `service:${s.id}:no_domain`,
      });
    }

    if (s.next_due_at) {
      const daysLeft = Math.ceil((new Date(s.next_due_at) - Date.now()) / 864e5);
      if (daysLeft <= 7) {
        add({
          level: daysLeft <= 0 ? 'error' : 'warn',
          area: 'billing',
          title: daysLeft <= 0
            ? `Payment overdue for your ${s.plan_name} plan`
            : `Your ${s.plan_name} plan renews in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`,
          body: daysLeft <= 0
            ? 'The plan stays online for now, but it will be suspended if this is not settled.'
            : 'No action needed if your details are up to date.',
          fix_url: '/panel/billing',
          fix_label: 'Go to billing',
          key: `service:${s.id}:due`,
        });
      }
    }
  }

  // --- Email --------------------------------------------------------------
  for (const e of emails) {
    if (e.status === 'active' && !e.domain) {
      add({
        level: 'warn',
        area: 'email',
        title: 'Your mailboxes have no domain yet',
        body: 'You are paying for mailboxes but no domain is set up to receive mail. '
          + 'Attach a domain to start using them.',
        fix_url: '/panel/mail',
        fix_label: 'Set up email',
        key: `email:${e.id}:no_domain`,
      });
    }
    if (e.status === 'suspended') {
      add({
        level: 'error',
        area: 'email',
        title: 'Your email service is suspended',
        body: 'Mail is not being delivered. This is usually an unpaid invoice.',
        fix_url: '/panel/billing',
        fix_label: 'Check billing',
        key: `email:${e.id}:suspended`,
      });
    }
  }

  return sortWarnings(out);
}

/**
 * The banner's own summary: how many, and how bad the worst one is.
 *
 * The shell renders one bar whose colour is the worst level present, because
 * four stacked coloured bars is not a warning system, it is a decorated page.
 */
function summarise(warnings) {
  const list = warnings || [];
  const worst = list.reduce(
    (acc, w) => ((LEVEL_RANK[w.level] ?? 9) < (LEVEL_RANK[acc] ?? 9) ? w.level : acc),
    'info',
  );
  return {
    count: list.length,
    worst: list.length ? worst : null,
    errors: list.filter((w) => w.level === 'error').length,
    warns: list.filter((w) => w.level === 'warn').length,
  };
}

module.exports = {
  AREAS,
  raise,
  resolve,
  resolvePrefix,
  list,
  unreadCount,
  markRead,
  collect,
  summarise,
  sortWarnings,
};
