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
const apps = require('../apps');
const sso = require('../integrations/hestia-sso');
const registrar = require('../integrations/domainnameapi');
const pricing = require('../pricing');
const linking = require('../domain-linking');
const nameservers = require('../nameservers');
const domainState = require('../domain-state');
const live = require('../panel-live');
const countries = require('../countries');
const geo = require('../geo');
const mailboxes = require('../mailboxes');
const { sendMail, shell, detailTable, escapeHtml, DEFAULT_TO } = require('../mailer');
const { flash, field, rateLimited } = require('../http-utils');
const {
  NAMESERVERS, DOMAIN_NS_GRACE_DAYS, SITE_URL, POINT_HOSTNAME,
} = require('../config');

const router = express.Router();

/**
 * The tools on a service page, all of which now live on this site.
 *
 * These used to be deep links into HestiaCP on :2083 — a second sign-in, a
 * second password out of the welcome email, and a control panel that looks
 * nothing like this one. The file manager and the terminal are both served
 * here now, signed in with the session the customer already has, so nothing
 * sends a customer to the panel and nothing asks them to log in twice.
 *
 * `files` deep-links to the site's own document root rather than the top of the
 * home directory: somebody who clicks "Files" from a website is looking for
 * that website's files, and public_html is where they are.
 */
function siteTools(service) {
  const domain = (service && service.primary_domain) || '';
  const docRoot = domain ? `web/${domain}/public_html` : 'web';
  return {
    files: `/panel/files?path=${encodeURIComponent(docRoot)}`,
    filesHome: '/panel/files',
    terminal: '/panel/terminal',
    profile: '/panel/settings',
  };
}

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

/**
 * Fetch a domain and prove it belongs to the signed-in customer.
 *
 * ACCEPTS EITHER THE NAME OR THE ID, and the name is what the panel now links
 * to: `/panel/domains/example.com` rather than `/panel/domains/4`.
 *
 * The numeric URL was never a security hole — `customer_id = ?` has always been
 * in the WHERE clause, so editing the number has only ever produced a 404. But
 * it was a URL that invited editing, which is its own problem: somebody who
 * tries it and gets "not found" has no way to know whether that means "not
 * yours" or "we lost it", and a support ticket is the cheapest way to find out.
 * A name answers the question before it is asked. It is also the thing a
 * customer can read in a browser history, paste into a ticket, and bookmark
 * without wondering which of their domains it was.
 *
 * Ids still resolve, because they are in emails, in the activity log and in
 * anybody's bookmarks. Both paths carry the same ownership check; neither is
 * more trusted than the other.
 */
async function ownedDomain(req) {
  const raw = String(req.params.id || '').trim().toLowerCase();
  if (!raw) return null;
  // A bare run of digits is an id. Everything else is treated as a name — a
  // domain label cannot be all digits at the top level, so the two cannot be
  // confused for one another.
  if (/^[0-9]+$/.test(raw)) {
    return db.one('SELECT * FROM domains WHERE id = ? AND customer_id = ? LIMIT 1', [raw, req.customer.id]);
  }
  if (!/^[a-z0-9.-]{3,190}$/.test(raw)) return null;
  return db.one('SELECT * FROM domains WHERE domain = ? AND customer_id = ? LIMIT 1', [raw, req.customer.id]);
}

/**
 * The addresses a domain resolves to, MINUS our own.
 *
 * The observed address is genuinely useful diagnostics — "we can see
 * 203.0.113.9" lets a customer fix a wrong A record in two minutes, where
 * "not pointing here" is a support ticket. But once the domain DOES point at
 * us, the same field is our node's address printed into the panel, which is
 * the one thing that must never appear there: every customer who copies it
 * pins us to that number in a zone we cannot see, and moving the node then
 * breaks all of them silently.
 *
 * So the diagnostic survives and the leak does not. Where the answer is us,
 * the page says so in words instead.
 */
async function foreignAddresses(domain) {
  const seen = (domain.ip_observed || '').split(' ').filter(Boolean);
  if (!seen.length) return [];
  let ours = [];
  try {
    ours = await nameservers.ourAddresses(POINT_HOSTNAME);
  } catch {
    // Unable to say which are ours — so treat them all as ours and print none.
    return [];
  }
  return seen.filter((ip) => !ours.includes(ip));
}

/**
 * The canonical path for a domain. Used everywhere so the links cannot drift.
 *
 * Takes a row, a name, or one of domain-linking's result objects — and those
 * are the reason for the `id` fallback. A successful result carries `domain`,
 * but the "that domain is already on your account" refusal carries only `id`,
 * and the old `d.domain || d` turned that object into the literal string
 * "[object Object]" in the URL. An id resolves here exactly as a name does
 * (see ownedDomain), so referencing the row is both correct and enough.
 */
function domainPath(d, suffix = '') {
  const ref = d && typeof d === 'object' ? (d.domain || d.id || '') : d;
  return `/panel/domains/${encodeURIComponent(ref)}${suffix}`;
}

/**
 * What to say after building a domain on the node.
 *
 * Three genuinely different outcomes, and the middle one is the one worth
 * getting right: a zone that has just been created is correct and not yet
 * resolving anywhere, because the resolvers that answered SERVFAIL a minute ago
 * are still holding that answer. "Not pointing at us" would be the same red
 * message the customer has been staring at all along, for a state that is now
 * fixed and merely waiting on the internet's own clock.
 */
function buildOutcome(name, result) {
  if (result.verdict?.matched) {
    return result.built?.ssl
      ? `${name} is set up, pointing at us and secured with a certificate.`
      : `${name} is set up and pointing at us. The certificate follows once DNS has settled — usually a few minutes.`;
  }
  return `${name} is now set up on the server. Its DNS is being published — public resolvers `
    + 'can take a few minutes to pick it up, and the certificate is issued automatically after that. '
    + 'Press "Check now" in a little while.';
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

    /*
     * Live usage off the node, and its absence must not take the page with it.
     * The overview is the page somebody opens when something is wrong, so it
     * has to render when the node is the thing that is wrong.
     */
    let stats = null;
    if (req.customer.hestia_user && services.some((s) => s.status === 'active')) {
      try {
        stats = await hestia.userStats(req.customer.hestia_user);
      } catch {
        stats = null;
      }
    }

    /*
     * Every judgement about a domain comes from src/domain-state, once, so this
     * page cannot disagree with the domain list or the domain page about what
     * a given row means. It used to: this page's fallback branch printed
     * "Registering…" for anything without an expiry date, which is every
     * adopted domain, every subdomain and every external one — so six live
     * websites were all described as being registered, next to an ACTIVE badge
     * saying the opposite.
     */
    const grouped = domainState.group(domains);

    res.render('panel/dashboard', {
      title: 'Your panel',
      robots: 'noindex',
      services,
      domains,
      domainGroups: grouped,
      stats,
      openTickets,
      unpaid,
      // Anything a customer has to act on, in one list, so the page can lead
      // with it instead of scattering four warnings down the column.
      todo: grouped.needsYou,
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
      `SELECT s.*, p.name AS plan_name, p.slug AS plan_slug,
              p.\`databases\` AS plan_databases, p.mailboxes AS plan_mailboxes,
              p.storage_gb
         FROM services s
         JOIN plans p ON p.id = s.plan_id
        WHERE s.customer_id = ? AND s.status <> 'terminated'
        ORDER BY s.created_at DESC`,
      [req.customer.id],
    );

    /*
     * Live usage, attached to each card.
     *
     * ONE call, not one per site: every hosting account a customer has lives
     * under the same Hestia user, so `v-list-user` answers for all of them and
     * asking per row would be the same round trip repeated. And it is wrapped,
     * because a node that is slow or down must not take this page with it —
     * "Open site" is exactly the button somebody wants when the node is having
     * a bad day.
     */
    let stats = null;
    if (req.customer.hestia_user && services.some((s) => s.status === 'active')) {
      try {
        stats = await hestia.userStats(req.customer.hestia_user);
      } catch {
        stats = null;
      }
    }
    services.forEach((s) => { s.stats = s.status === 'active' ? stats : null; });

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
      tools: siteTools(service),
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
/*
 * The file manager. Its own router because it is a dozen routes and two of them
 * do not take a JSON body — see src/routes/panel-files.js. Mounted here so it
 * inherits the signed-in guard at the top of this file.
 */
/*
 * Applications, runtimes and the Node process manager.
 *
 * Mounted before /databases only because that is the order they read in on the
 * rail. Everything under /apps needs the same session and the same hosting
 * account as every other panel page, which the middleware above has already
 * established.
 */
/**
 * Backups: download one, put one back, throw one away.
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS MISSING
 * ---------------------------------------------------------------------------
 * The page listed backups and could take a new one, and that was all. A backup
 * you cannot download is not a backup — it is a promise about a file on a
 * machine you do not control — and a backup you cannot restore is a list.
 * Between them those two gaps meant the nightly job was, from the customer's
 * side, decoration.
 *
 * ---------------------------------------------------------------------------
 * THE DOWNLOAD GOES THROUGH THE BROKER, AND HAS TO
 * ---------------------------------------------------------------------------
 * Every customer's archive lives in one flat /backup directory, each one mode
 * 0640 owned `hestiaweb:<that customer>`. This process runs as the website's
 * own account and can read exactly one customer's — its own. So the file is
 * streamed by apps/broker.py, which drops to the asking customer first and
 * lets the filesystem decide. Nothing is buffered: a backup is measured in
 * gigabytes.
 */
const BACKUP_NAME_RE = /^[A-Za-z0-9._-]{1,120}\.tar(\.(gz|zst|bz2|xz))?$/;

router.get('/services/:id/backups/:name/download', async (req, res, next) => {
  const back = `/panel/services/${req.params.id}/backups`;
  try {
    const service = await ownedService(req);
    if (!service) return next();
    const name = String(req.params.name || '');
    if (!BACKUP_NAME_RE.test(name)) {
      flash(res, 'That is not a backup we know about.', 'error');
      return res.redirect(back);
    }

    const user = await apps.accountFor(req.customer);
    const file = await apps.downloadBackup(user, name);

    res.set('Content-Type', 'application/x-tar');
    res.set('Content-Disposition', `attachment; filename="${name}"`);
    if (file.size) res.set('Content-Length', String(file.size));
    /*
     * `no-transform` alongside `no-store`, and it is doing real work.
     *
     * no-store because a backup is the customer's whole account and must not
     * sit in a shared cache anywhere between here and them.
     *
     * no-transform because the compression middleware in server.js otherwise
     * takes the response, and a compressed response has NO Content-Length —
     * so a browser downloading a four-gigabyte archive showed no size, no
     * progress and no estimate, just a number climbing. (`compression` honours
     * no-transform explicitly, which is why this works rather than needing a
     * filter.) Gzipping a tar of already-compressed site data buys nothing
     * anyway; it is CPU spent to make the file marginally larger.
     */
    res.set('Cache-Control', 'no-store, no-transform');

    file.stream.pipe(res);
    // A dropped download must not leave a broker child streaming into nothing.
    res.on('close', () => { try { file.stream.destroy(); } catch { /* gone */ } });
    return undefined;
  } catch (err) {
    if (err instanceof apps.AppError) {
      flash(res, err.message, 'error');
      return res.redirect(back);
    }
    return next(err);
  }
});

router.post('/services/:id/backups/:name/restore', async (req, res, next) => {
  const back = `/panel/services/${req.params.id}/backups`;
  try {
    if (!auth.checkCsrf(req)) return res.redirect(back);
    const service = await ownedService(req);
    if (!service) return next();
    const name = String(req.params.name || '');
    if (!BACKUP_NAME_RE.test(name)) {
      flash(res, 'That is not a backup we know about.', 'error');
      return res.redirect(back);
    }

    /*
     * Typing the date is not theatre. A restore OVERWRITES — the website in the
     * web root now, the contents of the database now — and it cannot be undone
     * from inside the panel, because the thing that would undo it is the state
     * being replaced. A checkbox is too easy to click by accident on a page
     * whose other buttons are all harmless.
     */
    if (String(req.body.confirm || '').trim() !== name) {
      flash(res, 'Type the backup name exactly to confirm the restore.', 'error');
      return res.redirect(back);
    }

    const sections = {
      web: req.body.web === 'on',
      dns: req.body.dns === 'on',
      mail: req.body.mail === 'on',
      db: req.body.db === 'on',
      cron: req.body.cron === 'on',
      udir: req.body.udir === 'on',
    };
    if (!Object.values(sections).some(Boolean)) {
      flash(res, 'Choose at least one thing to restore.', 'error');
      return res.redirect(back);
    }

    if (rateLimited(req.customer.id, 'restore', { max: 3, windowMs: 86_400_000 })) {
      flash(res, 'That is three restores today. Open a ticket if something is going wrong.', 'warn');
      return res.redirect(back);
    }

    try {
      await hestia.restoreBackup({ username: req.customer.hestia_user, backup: name, ...sections });
      await db.logActivity({
        actorType: 'customer', actorId: req.customer.id,
        action: 'backup.restored', target: name, ip: req.ip,
      }).catch(() => {});
      flash(res, 'Restore started. It runs on the server and takes a few minutes — your site may be inconsistent until it finishes.');
    } catch (err) {
      flash(res, `Could not start the restore: ${err.message}`, 'error');
    }
    return res.redirect(back);
  } catch (err) {
    return next(err);
  }
});

router.post('/services/:id/backups/:name/delete', async (req, res, next) => {
  const back = `/panel/services/${req.params.id}/backups`;
  try {
    if (!auth.checkCsrf(req)) return res.redirect(back);
    const service = await ownedService(req);
    if (!service) return next();
    const name = String(req.params.name || '');
    if (!BACKUP_NAME_RE.test(name)) {
      flash(res, 'That is not a backup we know about.', 'error');
      return res.redirect(back);
    }
    try {
      await hestia.deleteBackup({ username: req.customer.hestia_user, backup: name });
      flash(res, 'Backup deleted.');
    } catch (err) {
      flash(res, `Could not delete it: ${err.message}`, 'error');
    }
    return res.redirect(back);
  } catch (err) {
    return next(err);
  }
});

router.use('/apps', require('./panel-apps'));

router.use('/databases', require('./panel-databases'));

router.use('/files', require('./panel-files'));

/*
 * Email. Its own router for the same reason as the file manager: a dozen routes
 * with their own validation, and mounting it here means it inherits the
 * signed-in guard at the top of this file.
 */
router.use('/mail', require('./panel-mail'));

/**
 * The terminal page.
 *
 * The page itself is trivial; everything real happens over the websocket at
 * /panel/terminal/ws, which does its own authentication (src/terminal.js). The
 * checks here are only so that somebody without hosting gets an explanation
 * rather than a black rectangle that fails to connect.
 */
router.get('/terminal', async (req, res, next) => {
  try {
    if (!req.customer.hestia_user) {
      flash(res, 'There is no hosting on this account yet, so there is nothing to open a terminal on.', 'warn');
      return res.redirect('/panel');
    }
    const service = await db.one(
      "SELECT id FROM services WHERE customer_id = ? AND status = 'active' LIMIT 1",
      [req.customer.id],
    );
    if (!service) {
      flash(res, 'Your hosting is not active yet — the terminal opens once it is set up.', 'warn');
      return res.redirect('/panel');
    }

    res.render('panel/terminal', {
      title: 'Terminal',
      robots: 'noindex',
      username: req.customer.hestia_user,
      // A label, not the node's address — the IP is shown nowhere, and the
      // hostname is what a customer would put in an SSH client anyway.
      hostLabel: new URL(SITE_URL).hostname,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/domains', async (req, res, next) => {
  try {
    // A removed domain is history, not a holding. It stays in the table so the
    // activity log and any future re-add have something to point at, and out of
    // this list so the panel only ever shows domains the account actually has.
    const domains = await db.query(
      `SELECT * FROM domains WHERE customer_id = ? AND status <> 'removed'
        ORDER BY domain`,
      [req.customer.id],
    );

    /*
     * The state of each row, decided ONCE by src/domain-state, and the split
     * into what needs the customer / what is in flight / what is fine.
     *
     * This is the repair for "your domains always registering?". The template
     * used to work it out for itself, in EJS, with a bare `else` that printed
     * "Being registered…" whenever there was no expiry date — true of every
     * adopted domain, every subdomain and every external one.
     */
    const groups = domainState.group(domains);

    /*
     * Subdomains are listed UNDER the domain they belong to, not scattered
     * through an alphabetical list of everything. A flat list puts
     * `shop.example.com` and `example.com` in different places and makes them
     * look like two unrelated purchases — which is also why people go looking
     * for a renewal date and a DNS tab on a subdomain that has neither.
     *
     * Built here rather than in the template: it is a decision about the data,
     * and EJS is a poor place to keep one.
     */
    const settled = groups.fine;
    const parents = settled.filter((d) => d.source !== 'subdomain');
    const subs = settled.filter((d) => d.source === 'subdomain');
    const byName = new Map(parents.map((d) => [d.domain, { ...d, children: [] }]));

    const orphans = [];
    subs.forEach((sub) => {
      // Walk up the labels: shop.example.co.uk sits under a three-label parent,
      // and a.b.example.com is a legitimate second-level subdomain.
      const labels = sub.domain.split('.');
      let placed = false;
      for (let i = 1; i < labels.length - 1 && !placed; i++) {
        const owner = byName.get(labels.slice(i).join('.'));
        if (owner) {
          owner.children.push(sub);
          placed = true;
        }
      }
      // A subdomain whose parent was removed from the account still has a site
      // on the node. Hiding it would be the panel disagreeing with the server.
      if (!placed) orphans.push(sub);
    });

    res.render('panel/domains', {
      title: 'Your domains',
      robots: 'noindex',
      groups,
      tree: [...byName.values()],
      orphans,
      total: domains.length,
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
/** Everything the add form needs, in one place so the GET and the re-render agree. */
async function addFormData(req) {
  const [services, parents] = await Promise.all([
    db.query(
      `SELECT s.id, s.primary_domain, p.name AS plan_name FROM services s
         JOIN plans p ON p.id = s.plan_id
        WHERE s.customer_id = ? AND s.status = 'active'`,
      [req.customer.id],
    ),
    db.query(
      `SELECT domain FROM domains
        WHERE customer_id = ? AND status <> 'removed' AND source <> 'subdomain'
        ORDER BY domain`,
      [req.customer.id],
    ),
  ]);
  return {
    services,
    parents,
    defaultNameservers: NAMESERVERS,
    pointHostname: POINT_HOSTNAME,
    addresses: await nameservers.ourAddresses(POINT_HOSTNAME),
    graceDays: DOMAIN_NS_GRACE_DAYS,
  };
}

router.get('/domains/add', async (req, res, next) => {
  try {
    res.render('panel/domain-add', {
      title: 'Add a domain',
      robots: 'noindex',
      ...(await addFormData(req)),
      values: {},
      errors: {},
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Add a domain OR a subdomain — one form, one route, told apart by the name.
 *
 * There used to be two forms on the page and two routes behind them, and the
 * customer had to know which of the two things they had before they could
 * start. They do not: "add heat6.com" and "add shop.heat6.com" are the same
 * intention, and which one it is, is a fact about the name that we can work out
 * ourselves.
 *
 * The test is NOT the number of dots. `shop.heat6.com` and `vesopa.co.uk` both
 * have three labels; one is a subdomain and one is a registrable domain, and no
 * amount of counting separates them. What separates them is whether the account
 * already holds something this name sits under — which is also exactly the
 * authorisation check for creating it. See linking.findParent.
 */
router.post('/domains/add', async (req, res, next) => {
  try {
    if (!auth.checkCsrf(req)) return res.redirect('/panel/domains/add');

    if (rateLimited(req.customer.id, 'domain-add', { max: 20, windowMs: 3600_000 })) {
      flash(res, 'That is a lot of names in one go. Try again in a little while.', 'warn');
      return res.redirect('/panel/domains');
    }

    const wanted = field(req.body.domain, 190).trim().toLowerCase()
      // People paste URLs. Taking the domain out of one is a kindness that
      // costs three characters of code and saves a confusing error.
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .replace(/[/?#].*$/, '');
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

    const parent = wanted ? await linking.findParent(req.customer, wanted) : null;

    // ---- A subdomain of something they already have ------------------------
    if (parent) {
      /*
       * DNS and mail are not asked about and not accepted. A subdomain lives in
       * its parent's zone and email belongs on the main domain — the form does
       * not offer either, and ignoring anything posted here means a crafted
       * request cannot turn them on behind the UI's back.
       */
      const added = await linking.addSubdomain({
        customer: req.customer,
        subdomain: wanted,
        serviceId: attachTo,
        wantDns: false,
        wantMail: false,
      });

      if (!added.ok) {
        flash(res, added.error, 'warn');
        return res.redirect(added.id ? `/panel/domains/${added.id}` : '/panel/domains/add');
      }
      if (!added.built.pointed) {
        flash(res, `${added.domain} was added, but the website could not be created on the server. `
          + 'Open a ticket and we will sort it.', 'warn');
        return res.redirect(domainPath(added));
      }

      // Whether it RESOLVES is the thing worth saying. A "done" message for a
      // name that answers nowhere is the most annoying kind of wrong.
      const live = await linking.verify(added.row, { customer: req.customer });
      flash(
        res,
        live.matched
          ? `${added.domain} is set up and serving.`
          : `${added.domain} is set up. One thing left: add an A record for it at whoever runs `
            + `DNS for ${added.parent} — this page shows exactly what.`,
        live.matched ? 'ok' : 'warn',
      );
      return res.redirect(domainPath(added));
    }

    // ---- A domain in its own right ----------------------------------------
    const added = await linking.addExternal({
      customer: req.customer,
      domain: wanted,
      serviceId: attachTo,
      // Checkbox absent means unticked. DNS arrives ticked on the form, so an
      // absent value here is a deliberate opt-out rather than a default.
      wantDns: Boolean(req.body.want_dns),
      wantMail: Boolean(req.body.want_mail),
    });

    if (!added.ok) {
      if (added.id) {
        flash(res, added.error, 'warn');
        return res.redirect(domainPath(added));
      }
      return res.status(400).render('panel/domain-add', {
        title: 'Add a domain',
        robots: 'noindex',
        ...(await addFormData(req)),
        values: { domain: wanted, service_id: serviceId },
        errors: { domain: added.error },
      });
    }

    /*
     * Checked once, immediately. Most people add a domain AFTER pointing it, so
     * this is usually the moment it goes live — and being told "you are all
     * set" on the same screen is worth far more than the same message arriving
     * from a sweep fifteen minutes later.
     */
    const verdict = await linking.verify(added.row, { customer: req.customer });

    if (verdict.matched) {
      flash(res, `${added.domain} is pointing at us — we are setting it up now.`);
    } else if (wanted.split('.').length > 2) {
      /*
       * Looks like a subdomain, but of a domain this account does not hold. It
       * is still perfectly addable — an A record aimed here is enough, and the
       * new verification will pick that up — so it is added rather than
       * refused. Saying why avoids the "it did not offer me the subdomain
       * options" confusion.
       */
      flash(res, `${added.domain} has been added. We do not have its main domain on this account, `
        + 'so point it here with an A record — this page shows the value to use.', 'warn');
    } else {
      flash(res, `${added.domain} has been added. Point it at us using either method shown on `
        + 'this page; we check every few minutes and will email you when it is live.', 'warn');
    }
    res.redirect(domainPath(added));
  } catch (err) {
    next(err);
  }
});

router.get('/domains/:id', async (req, res, next) => {
  try {
    const domain = await ownedDomain(req);
    if (!domain) return next();

    const subdomain = linking.isSubdomain(domain);

    /*
     * A SUBDOMAIN GETS A DIFFERENT PAGE, not the same page with things hidden.
     *
     * Nearly nothing on the domain overview applies to one: it has no
     * nameservers to set, no registrar, no expiry, no auto-renew, no transfer
     * and no zone of its own. Rendering that template and hiding two thirds of
     * it leaves a page that is mostly absence — and it is how the panel came to
     * tell customers a working subdomain was "waiting for your nameservers".
     */
    /*
     * The website record behind this name, for the redirect card — which both
     * this page and the subdomain page draw. `webDomain` and not
     * `listWebDomains`: the plural command does not return REDIRECT, which is
     * how a customer could switch a redirect on and then find no way to switch
     * it off. See the note on webDomain in integrations/hestia.js.
     */
    const site = req.customer.hestia_user
      ? await hestia.webDomain({ username: req.customer.hestia_user, domain: domain.domain })
        .catch(() => null)
      : null;
    const hasHosting = Boolean(req.customer.hestia_user);

    const [ssl, addresses, node] = await Promise.all([
      linking.refreshSsl(domain, req.customer),
      nameservers.ourAddresses(POINT_HOSTNAME),
      // What is actually on the node for this name. The removal card is built
      // from this, so it can offer the DNS zone and the mailboxes only when
      // they exist — and say how much is in each.
      linking.nodeState(domain, req.customer),
    ]);

    if (subdomain) {
      const parentName = linking.parentNameOf(domain.domain);
      // The parent's own row, so the page can link straight to its DNS rather
      // than telling the customer to go and find it.
      const parentRow = parentName
        ? await db.one(
          "SELECT id FROM domains WHERE domain = ? AND customer_id = ? AND status <> 'removed' LIMIT 1",
          [parentName, req.customer.id],
        )
        : null;

      return res.render('panel/domain-sub', {
        title: domain.domain,
        robots: 'noindex',
        domain,
        ssl,
        parent: parentName,
        parentId: parentRow ? parentRow.id : null,
        pointHostname: POINT_HOSTNAME,
        addresses,
        observed: await foreignAddresses(domain),
        canRemove: true,
        node,
        site,
        hasHosting,
      });
    }

    // The renewal quote is in the visitor's own currency: nothing has been
    // charged yet, so this is a shop price like any other.
    const price = await pricing.priceForTld(domain.tld, req.currency);

    res.render('panel/domain', {
      site,
      hasHosting,
      title: domain.domain,
      robots: 'noindex',
      domain,
      price,
      ssl,
      defaultNameservers: NAMESERVERS,
      pointHostname: POINT_HOSTNAME,
      addresses,
      observedNs: (domain.ns_observed || '').split(' ').filter(Boolean),
      observedIp: await foreignAddresses(domain),
      registrarLive: registrar.isLive(),
      graceDays: DOMAIN_NS_GRACE_DAYS,
      // What the customer may do with it, decided by the server. The template
      // asks these rather than re-deriving the rules in EJS, where they would
      // be a second copy that drifts.
      canEditDns: linking.mayEditDns(domain, req.customer),
      canHaveMail: linking.mayHaveMail(domain),
      /*
       * REMOVAL IS OFFERED FOR EVERY DOMAIN NOW, and what it means depends on
       * who holds the registration.
       *
       * It used to be external-only, on the reasoning that a domain registered
       * here is the customer's property and leaves by transfer rather than by
       * button. True of the REGISTRATION, and it quietly took the hosting with
       * it: there was no way to take a domain we registered off a plan, off a
       * server, or out of a broken half-built state. The registration is still
       * untouched by this button — see the remove handler, which detaches one
       * of ours and only fully removes an external name.
       */
      canRemove: true,
      node,
      // The plans this domain could be attached to, and the one it is on. A
      // domain with no service is not broken — but it is also not hosted, and
      // until now the panel had no control that could change that.
      hostingServices: await db.query(
        `SELECT s.id, s.primary_domain, p.name AS plan_name FROM services s
           JOIN plans p ON p.id = s.plan_id
          WHERE s.customer_id = ? AND s.status = 'active'
          ORDER BY s.id`,
        [req.customer.id],
      ),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Issue or retry the certificate for one domain.
 *
 * The single most-used button in the panel, and until now it existed only on
 * the SERVICE page — so a domain not attached to a service had no way to ask
 * for a certificate at all, which is most of them on this node.
 */
router.post('/domains/:id/ssl', async (req, res, next) => {
  try {
    if (!auth.checkCsrf(req)) return res.redirect(`/panel/domains/${req.params.id}`);
    const domain = await ownedDomain(req);
    if (!domain) return next();
    const back = domainPath(domain);

    // Let's Encrypt rate-limits per domain and the limit is not generous. A
    // customer holding down the button would spend it and then be locked out
    // for an hour at the exact moment they need a certificate.
    if (rateLimited(req.customer.id, 'domain-ssl', { max: 5, windowMs: 3600_000 })) {
      flash(res, 'We have tried a few times just now. Give it an hour — Let\'s Encrypt limits how often a domain may be asked for.', 'warn');
      return res.redirect(back);
    }

    const result = await linking.issueSsl(domain, req.customer);
    if (result.ok) {
      flash(res, `The certificate for ${domain.domain} is installed. It renews itself from here on.`);
    } else {
      flash(res, result.message || result.error || 'That certificate could not be issued.', 'error');
    }
    res.redirect(back);
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
/**
 * Check whether the domain points at us yet.
 *
 * ANSWERS JSON WHEN ASKED TO. "Why is the DNS check taking very long" was not
 * really about the lookups — those are a second or two — but about what the
 * page did while they ran: it threw itself away, waited with a blank screen,
 * and rebuilt everything. If the answer was "not yet", which it is most of the
 * time somebody presses this, you did the whole thing again.
 *
 * The form post is untouched and still works without JavaScript.
 */
router.post('/domains/:id/verify', async (req, res, next) => {
  const wantsJson = req.is('application/json') || (req.get('accept') || '').includes('application/json');
  try {
    if (!auth.checkCsrf(req)) {
      if (wantsJson) return res.status(403).json({ ok: false, message: 'Your session expired. Reload the page.' });
      return res.redirect(`/panel/domains/${req.params.id}`);
    }
    const domain = await ownedDomain(req);
    if (!domain) return next();

    const back = domainPath(domain);
    const answer = (ok, message) => {
      if (wantsJson) return res.json({ ok, message });
      flash(res, message, ok ? 'ok' : 'warn');
      return res.redirect(back);
    };

    if (rateLimited(req.customer.id, 'domain-verify', { max: 12, windowMs: 600_000 })) {
      return answer(false, 'We have just checked a few times. Give DNS a couple of minutes and try again.');
    }

    const verdict = await linking.verify(domain, { customer: req.customer });
    const sub = linking.isSubdomain(domain);

    // Anyone watching this domain gets the new state immediately rather than
    // up to a tick later — see src/panel-live.js.
    live.publish(req.customer.id, `domain:${domain.id}`);

    if (verdict.matched) {
      const how = verdict.method === 'ns' ? 'through our nameservers' : 'with an A record';
      return answer(true, verdict.pointed?.pointed
        ? `${domain.domain} points here ${how} and the site is set up.`
        : `${domain.domain} points here ${how}. ${verdict.pointed?.reason || ''}`.trim());
    }

    if (sub) {
      /*
       * A subdomain is never about nameservers, so its failure must never
       * mention them. Saying what it DOES answer with is the whole value of the
       * message: "we can see 3.72.113.21" is a customer fixing it in two
       * minutes, where "not pointing here" is a support ticket.
       */
      return answer(false, verdict.addresses.length
        ? `Not yet — ${domain.domain} answers with ${verdict.addresses.join(', ')}, which is not this server.`
        : `Not yet — ${domain.domain} does not resolve anywhere yet. Add the A record shown on this page.`);
    }

    return answer(false, verdict.nameservers.length
      ? `Not yet — ${domain.domain} still points at ${verdict.nameservers.join(' and ')}. `
        + 'Either switch its nameservers to ours, or point an A record here.'
      : `Not yet — ${verdict.error || 'we could not read its nameservers.'}`);
  } catch (err) {
    next(err);
  }
});

/**
 * Attach this domain to a hosting plan, or take it off one.
 *
 * The control that was missing. A domain could be filed under a service only at
 * the moment it was added and never afterwards — so a name registered through
 * the order flow, which files it under nothing, could not be put on the plan the
 * customer had just bought. `vesopa.site` was in exactly that position: paid
 * for, delegated to us, attached to nothing, with no control on the page that
 * could change it.
 *
 * Attaching does three things, and the third is the one that matters: it files
 * the domain under the service, adopts it as the plan's primary domain if the
 * plan has none, and BUILDS IT ON THE NODE. A domain attached to a plan that
 * the node does not serve is a database row pretending to be hosting.
 */
router.post('/domains/:id/service', async (req, res, next) => {
  try {
    if (!auth.checkCsrf(req)) return res.redirect(`/panel/domains/${req.params.id}`);
    const domain = await ownedDomain(req);
    if (!domain) return next();

    const wanted = Number(req.body.service_id) || null;
    const back = domainPath(domain);

    let service = null;
    if (wanted) {
      service = await db.one(
        `SELECT s.*, p.name AS plan_name FROM services s
           JOIN plans p ON p.id = s.plan_id
          WHERE s.id = ? AND s.customer_id = ? AND s.status = 'active' LIMIT 1`,
        [wanted, req.customer.id],
      );
      if (!service) {
        flash(res, 'That hosting plan is not on your account.', 'warn');
        return res.redirect(back);
      }
    }

    await db.query('UPDATE domains SET service_id = ? WHERE id = ?', [service ? service.id : null, domain.id]);

    if (!service) {
      /*
       * Detaching from the plan is a filing change and nothing more. The site,
       * the zone and the mailboxes stay exactly as they are — removing those is
       * the remove button's job, and doing it here would take a live website
       * down for somebody who only meant to tidy up which plan it sits under.
       */
      await db.logActivity({
        actorType: 'customer', actorId: req.customer.id, action: 'domain.detached',
        target: domain.domain, ip: req.ip,
      });
      flash(res, `${domain.domain} is no longer filed under a hosting plan. Nothing on the server has changed.`, 'info');
      return res.redirect(back);
    }

    // A plan with no domain adopts this one. A plan that already has a primary
    // domain keeps it, and this becomes an additional domain on the same
    // account — which is what an add-on domain has always meant here.
    const adopted = !service.primary_domain;
    if (adopted) {
      await db.query('UPDATE services SET primary_domain = ? WHERE id = ?', [domain.domain, service.id]);
    }

    const result = await linking.rebuild({ ...domain, service_id: service.id }, req.customer);

    await db.logActivity({
      actorType: 'customer', actorId: req.customer.id, action: 'domain.attached',
      target: domain.domain, ip: req.ip,
      detail: `${service.plan_name}${adopted ? ' (adopted as the plan’s domain)' : ''}; `
        + (result.ok ? 'built on the node' : `not built: ${result.error || result.built?.reason || 'unknown'}`),
      ok: Boolean(result.ok),
    });

    live.publish(req.customer.id, `domain:${domain.id}`);

    if (!result.ok) {
      flash(res, `${domain.domain} is now on your ${service.plan_name} plan, but the website could not be `
        + `created on the server (${result.error || result.built?.reason || 'unknown error'}). `
        + 'Try "Set it up on the server" on this page, or open a ticket.', 'warn');
      return res.redirect(back);
    }

    flash(res, buildOutcome(domain.domain, result), result.verdict?.matched ? 'ok' : 'info');
    res.redirect(back);
  } catch (err) {
    next(err);
  }
});

/**
 * Build this domain on the server now.
 *
 * The button for the deadlock. A domain delegated to our nameservers that we
 * hold no zone for is answered REFUSED by ns1, which the public internet reads
 * as SERVFAIL — so the verification that gates the build can never pass, and
 * the build that would fix it never runs. `verify` now breaks that loop by
 * itself for domains registered here; this is the manual version, and it is the
 * only route to it for an EXTERNAL domain, where building automatically on the
 * strength of a failed lookup would mean creating zones for names nobody has
 * pointed at us.
 *
 * Pressing it twice is harmless — every step tolerates already-existing.
 */
router.post('/domains/:id/rebuild', async (req, res, next) => {
  try {
    if (!auth.checkCsrf(req)) return res.redirect(`/panel/domains/${req.params.id}`);
    const domain = await ownedDomain(req);
    if (!domain) return next();

    const back = domainPath(domain);

    // Three or four calls to the node and possibly one to Let's Encrypt. Cheap
    // enough to offer freely, expensive enough not to leave unbounded.
    if (rateLimited(req.customer.id, 'domain-rebuild', { max: 6, windowMs: 600_000 })) {
      flash(res, 'We have just done that a few times. Give DNS a couple of minutes and try again.', 'warn');
      return res.redirect(back);
    }

    const result = await linking.rebuild(domain, req.customer);
    live.publish(req.customer.id, `domain:${domain.id}`);

    await db.logActivity({
      actorType: 'customer', actorId: req.customer.id, action: 'domain.rebuilt',
      target: domain.domain, ip: req.ip,
      detail: result.ok ? 'Website, zone and mail created or confirmed on the node.' : (result.error || 'not built'),
      ok: Boolean(result.ok),
    });

    if (!result.ok) {
      flash(res, result.error
        || `${domain.domain} could not be set up on the server. ${result.built?.reason || ''}`.trim(), 'warn');
      return res.redirect(back);
    }

    flash(res, buildOutcome(domain.domain, result), result.verdict?.matched ? 'ok' : 'info');
    res.redirect(back);
  } catch (err) {
    next(err);
  }
});

/**
 * Take a domain off the account, or off its hosting.
 *
 * WHAT "REMOVE" MEANS DEPENDS ON WHO HOLDS THE REGISTRATION, and conflating the
 * two is how this used to refuse the request outright.
 *
 *   external      A name registered somewhere else and merely pointed here.
 *                 Removing it takes the row off the account entirely; there is
 *                 nothing else of theirs here to keep.
 *
 *   ours          A name registered THROUGH us. The registration is the
 *                 customer's property, is paid for, and has a renewal date — so
 *                 the row stays, and what is removed is the hosting: the site
 *                 comes off the node, the domain comes off its plan, and if it
 *                 was that plan's primary domain the plan goes back to having
 *                 none. It reappears in the panel as a parked domain, which is
 *                 exactly what it now is.
 *
 * The old handler refused the second case with "open a ticket and we will
 * transfer it out", which answered a question nobody asked: wanting a domain off
 * a hosting plan is not wanting it moved to another registrar.
 *
 * THE ZONE AND THE MAILBOXES ARE ASKED ABOUT, NOT ASSUMED. `v-delete-domain`
 * takes website, DNS and mail together, and for a domain delegated to us the
 * zone is the thing making the delegation resolve at all — deleting it as a
 * side effect of "remove this site" takes the domain off the internet rather
 * than off the plan, and takes the mailboxes with it. The form offers each one
 * that actually exists, with what is in it; nothing here is removed unless it
 * was ticked.
 */
router.post('/domains/:id/remove', async (req, res, next) => {
  try {
    if (!auth.checkCsrf(req)) return res.redirect(`/panel/domains/${req.params.id}`);
    const domain = await ownedDomain(req);
    if (!domain) return next();

    const ours = domain.source === 'registered' || domain.source === 'transfer';
    const back = domainPath(domain);

    /*
     * The checkboxes. Absent means unticked, which is the safe reading in both
     * directions: a request that lost them removes less than asked rather than
     * more, and a crafted one cannot delete a zone the form never offered.
     *
     * An EXTERNAL domain leaving the account is the exception — there is no row
     * left to hold the leftovers against, so it takes everything with it, which
     * is what it has always done and what its confirmation says.
     */
    const dropDns = ours ? Boolean(req.body.drop_dns) : true;
    const dropMail = ours ? Boolean(req.body.drop_mail) : true;

    /*
     * Take it off the node BEFORE the row changes. In that order a failure
     * leaves the domain visibly still on the account, which is a state the
     * customer can retry from; the other way round loses the only record of
     * which account the leftover zone belonged to.
     */
    const unpointed = await linking.unpointFromNode(domain, req.customer, {
      web: true, dns: dropDns, mail: dropMail,
    });

    // Whichever parts were kept are still ours to serve, so the flags that say
    // whether we serve them have to agree. A zone kept with `dns_enabled = 0`
    // would be deleted by the next rebuild without anybody asking again.
    if (ours) {
      const service = domain.service_id
        ? await db.one('SELECT id, primary_domain FROM services WHERE id = ? AND customer_id = ? LIMIT 1',
          [domain.service_id, req.customer.id])
        : null;

      await db.query(
        `UPDATE domains
            SET service_id = NULL, pointed_at = NULL,
                dns_enabled = ?, mail_enabled = ?,
                ns_verified_at = NULL, verify_method = ''
          WHERE id = ?`,
        [dropDns ? 0 : 1, dropMail ? 0 : 1, domain.id],
      );

      /*
       * The plan goes back to "No domain attached" and NOTHING ELSE HAPPENS to
       * it. Not suspended, not cancelled, not rebuilt — the account, its files,
       * its databases and its other domains are untouched. A customer changing
       * which name their plan answers to must not be able to lose the plan.
       */
      if (service && service.primary_domain === domain.domain) {
        await db.query("UPDATE services SET primary_domain = '' WHERE id = ?", [service.id]);
      }
    } else {
      await db.query("UPDATE domains SET status = 'removed', service_id = NULL WHERE id = ?", [domain.id]);
    }

    const kept = ours ? [!dropDns && 'DNS', !dropMail && 'email'].filter(Boolean) : [];

    await db.logActivity({
      actorType: 'customer', actorId: req.customer.id,
      action: ours ? 'domain.unhosted' : 'domain.removed',
      target: domain.domain, ip: req.ip,
      detail: unpointed.ok
        ? `Removed from the node: ${(unpointed.removed || []).join(', ') || 'nothing was there'}`
          + `${kept.length ? `; kept ${kept.join(' and ')}` : ''}`
        : `Node cleanup failed: ${unpointed.error}`,
      ok: unpointed.ok,
    });

    live.publish(req.customer.id, `domain:${domain.id}`);

    if (!unpointed.ok) {
      // Said plainly rather than swallowed: the change has happened either way,
      // and a zone still answering for a domain they believe they have removed
      // is exactly the thing they need to be able to tell us about.
      flash(res, `${domain.domain} has been taken off its hosting, but part of it could not be cleared `
        + `from the server (${unpointed.error}). We have logged it — open a ticket if the domain still `
        + 'resolves here.', 'warn');
      return res.redirect(ours ? back : '/panel/domains');
    }

    if (ours) {
      flash(res, `${domain.domain} is no longer hosted here`
        + `${kept.length ? `, but we still run its ${kept.join(' and ')}` : ''}. `
        + 'The registration is untouched — it is still yours and still renews. '
        + 'Attach it to a plan again whenever you want a site on it.', 'info');
      return res.redirect(back);
    }

    flash(res, `${domain.domain} has been removed from your account, along with its website, DNS and mail `
      + 'here. The domain itself is registered elsewhere and is untouched.', 'info');
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

    /*
     * A SUBDOMAIN HAS NO DNS PAGE. Sent to the parent's instead, which is the
     * page that can actually change it.
     *
     * Enforced here and not only in the template: a link removed from a page is
     * not a rule, it is a tidier page, and the URL is still typed, bookmarked
     * and followed. The redirect is also the more useful answer — somebody who
     * got here wanted to change where this name points, and the parent's zone
     * is where that record lives.
     */
    if (linking.isSubdomain(domain)) {
      const parent = await db.one(
        "SELECT id FROM domains WHERE domain = ? AND customer_id = ? AND status <> 'removed' LIMIT 1",
        [linking.parentNameOf(domain.domain), req.customer.id],
      );
      flash(res, `${domain.domain} is a subdomain — its DNS lives in ${linking.parentNameOf(domain.domain)}'s zone.`, 'warn');
      return res.redirect(parent ? `/panel/domains/${parent.id}/dns` : `/panel/domains/${domain.id}`);
    }

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
    // Same rule as the GET, restated because a POST is a separate door.
    {
      const target = await ownedDomain(req);
      if (target && linking.isSubdomain(target)) {
        flash(res, 'A subdomain has no DNS zone of its own — change the record on its parent domain.', 'warn');
        return res.redirect(domainPath(target));
      }
    }
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
          // The form has a TTL field and validateRecord() checks it, but edit
          // used to drop it on the floor — so a customer could set a TTL when
          // adding a record and never change it again, with the form showing
          // the new number back to them as though it had been saved.
          ttl: record.ttl,
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
    if (linking.isSubdomain(domain)) {
      // A subdomain has no delegation of its own. `source` is checked before
      // 'external' below because a subdomain is neither registered here nor
      // there, and would otherwise fall through to the registrar call.
      flash(res, 'A subdomain has no nameservers of its own — it follows whatever its parent domain does.', 'warn');
      return res.redirect(domainPath(domain));
    }
    if (domain.source === 'external') {
      flash(
        res,
        'This domain is registered elsewhere, so its nameservers are changed at that registrar, not here.',
        'warn',
      );
      return res.redirect(domainPath(domain));
    }

    const ns = [req.body.ns1, req.body.ns2, req.body.ns3, req.body.ns4]
      .map((n) => field(n, 190).toLowerCase())
      .filter(Boolean);

    if (ns.length < 2) {
      flash(res, 'A domain needs at least two nameservers.', 'error');
      return res.redirect(domainPath(domain));
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
    res.redirect(domainPath(domain));
  } catch (err) {
    next(err);
  }
});

/**
 * Send visitors somewhere else.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS WAS THE MISSING PAGE
 * ---------------------------------------------------------------------------
 * People buy a second domain for one of three reasons: they want the .co.uk as
 * well as the .com, they are moving to a new name, or they bought a misspelling
 * before somebody else did. All three end in the same request — "point it at
 * the main site" — and there was no way to do it. The answer was a support
 * ticket, or a one-line index.php somebody had to be told how to write.
 *
 * ---------------------------------------------------------------------------
 * THE CODE IS THE PART PEOPLE GET WRONG, SO THE FORM DOES NOT SAY "301"
 * ---------------------------------------------------------------------------
 * 301 is cached hard — some browsers keep one until their cache is cleared, so
 * a redirect set by mistake follows that visitor around long after the server
 * has been fixed, and there is nothing we can do about it from here. 302 is not
 * cached and is the right answer for anything temporary or unfinished.
 *
 * The form therefore offers "moved for good" and "just for now", explains what
 * each does to somebody's browser, and defaults to neither — see
 * views/panel/domain.ejs. The numbers are shown, because somebody who knows
 * what they want is looking for them, but they are not the label.
 */
router.post('/domains/:id/redirect', async (req, res, next) => {
  try {
    if (!auth.checkCsrf(req)) return res.redirect('/panel/domains');
    const domain = await ownedDomain(req);
    if (!domain) return next();
    const back = domainPath(domain);

    if (!req.customer.hestia_user) {
      flash(res, 'There is no hosting on this account yet, so there is no website to redirect.', 'error');
      return res.redirect(back);
    }

    // Clearing is its own submit, and it is the easy half.
    if (req.body.action === 'clear') {
      try {
        await hestia.clearRedirect({ username: req.customer.hestia_user, domain: domain.domain });
        flash(res, `${domain.domain} serves its own website again.`);
      } catch (err) {
        flash(res, `Could not remove the redirect: ${err.message}`, 'error');
      }
      return res.redirect(back);
    }

    const raw = String(req.body.target || '').trim();
    const code = req.body.code === '302' ? 302 : 301;

    /*
     * Accept what people actually type. "example.com", "https://example.com"
     * and "example.com/shop" are all the same intent, and refusing two of the
     * three teaches nothing. The scheme is stripped for the bare-host case
     * because that is the form Hestia's own examples use, and kept when there
     * is a path, because then it matters.
     */
    let target = raw.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    if (!target) {
      flash(res, 'Type where visitors should go.', 'error');
      return res.redirect(back);
    }
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(\/[^\s?#]*)?$/i.test(target)) {
      flash(res, 'That does not look like a web address. Try something like example.com, or example.com/page.', 'error');
      return res.redirect(back);
    }
    if (target.toLowerCase() === domain.domain.toLowerCase()) {
      /*
       * A domain redirecting to itself is an infinite loop, and the browser
       * reports it as "too many redirects" on a site that was working a minute
       * ago. Cheaper to refuse than to explain afterwards.
       */
      flash(res, `${domain.domain} cannot redirect to itself — visitors would go round in a loop.`, 'error');
      return res.redirect(back);
    }

    try {
      await hestia.setRedirect({
        username: req.customer.hestia_user, domain: domain.domain, target, code,
      });
      await db.logActivity({
        actorType: 'customer', actorId: req.customer.id,
        action: 'domain.redirect', target: `${domain.domain} -> ${target} (${code})`, ip: req.ip,
      }).catch(() => {});
      flash(res, code === 301
        ? `${domain.domain} now sends visitors to ${target}, permanently. Browsers remember a permanent redirect, so test it in a private window.`
        : `${domain.domain} now sends visitors to ${target}, temporarily. Nothing caches this one, so you can change it freely.`);
    } catch (err) {
      flash(res, `Could not set the redirect: ${err.message}`, 'error');
    }
    return res.redirect(back);
  } catch (err) {
    return next(err);
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
    res.redirect(domainPath(domain));
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
router.get('/settings', async (req, res, next) => {
  try {
    /*
     * The country the form OPENS on, when the account has none stored.
     *
     * Geolocation is a suggestion on a visible form, never a value written to
     * an account. A VPN, a mobile carrier routing through another country, or a
     * corporate proxy would otherwise file somebody's domain registration under
     * a country they have never been to — and the registrant country is a
     * matter of record at the registry, not a preference.
     *
     * `countryFor` has its own cache, its own timeout and its own circuit
     * breaker, but a settings page must render even when all three are having a
     * bad day.
     */
    let guessed = '';
    if (!req.customer.country) {
      try {
        guessed = (await geo.countryFor(req.ip)) || '';
      } catch {
        guessed = '';
      }
    }

    res.render('panel/settings', {
      title: 'Account settings',
      robots: 'noindex',
      errors: {},
      values: {},
      geoCountry: guessed,
      country: countries.pick(req.customer.country, guessed),
    });
  } catch (err) {
    next(err);
  }
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
      country: field(req.body.country, 2).toUpperCase(),
    };

    const errors = {};
    if (!values.first_name) errors.first_name = 'Required.';
    if (!values.last_name) errors.last_name = 'Required.';
    /*
     * Checked against the list, not merely truncated to two characters.
     *
     * This value is the registrant's country of record on any domain the
     * account holds, so `ZZ` is not a harmless typo — it is a registry record
     * that has to be corrected by hand later. The picker cannot produce one,
     * which means anything invalid arriving here came from a crafted POST and
     * deserves a plain refusal rather than a silent fallback to GB.
     */
    if (!countries.isValid(values.country)) errors.country = 'Choose a country from the list.';
    if (Object.keys(errors).length) {
      return res.status(400).render('panel/settings', {
        title: 'Account settings',
        robots: 'noindex',
        errors,
        values,
        geoCountry: '',
        country: countries.pick(values.country || req.customer.country, ''),
      });
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
      subject: 'Your password was changed — Vesopa Cloud',
      html: shell({
        title: 'Your password was changed',
        intro: 'The password on your Vesopa Cloud account has just been changed, and every other device has been signed out.',
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
