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
const registrar = require('../integrations/domainnameapi');
const pricing = require('../pricing');
const { sendMail, shell, detailTable, escapeHtml, DEFAULT_TO } = require('../mailer');
const { flash, field, rateLimited } = require('../http-utils');
const { NAMESERVERS } = require('../config');

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
        `SELECT * FROM domains WHERE customer_id = ? AND status <> 'cancelled'
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
      'SELECT * FROM domains WHERE customer_id = ? AND service_id = ?',
      [req.customer.id, service.id],
    );

    res.render('panel/service', {
      title: service.primary_domain || service.plan_name,
      robots: 'noindex',
      service,
      stats,
      statsError,
      addonDomains,
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
    if (rateLimited(req.customer.id, 'ssl-retry', { max: 6, windowMs: 3600_000 })) {
      flash(res, 'You have tried several times. Wait a few minutes and try again — DNS can take up to an hour.', 'warn');
      return res.redirect(`/panel/services/${service.id}`);
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
      flash(
        res,
        'We could not issue the certificate yet. This nearly always means the domain is not pointing at us — check the nameservers below, then try again in a few minutes.',
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

    res.render(`panel/service-${req.params.tab}`, {
      title: `${service.primary_domain || service.plan_name} — ${req.params.tab}`,
      robots: 'noindex',
      service,
      items,
      error,
      hestiaLive: hestia.isLive(),
    });
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
    const domains = await db.query(
      'SELECT * FROM domains WHERE customer_id = ? ORDER BY expires_at IS NULL, expires_at ASC',
      [req.customer.id],
    );
    res.render('panel/domains', { title: 'Your domains', robots: 'noindex', domains });
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
    });
  } catch (err) {
    next(err);
  }
});

router.post('/domains/:id/nameservers', async (req, res, next) => {
  try {
    if (!auth.checkCsrf(req)) return res.redirect(`/panel/domains/${req.params.id}`);
    const domain = await ownedDomain(req);
    if (!domain) return next();

    const ns = [req.body.ns1, req.body.ns2, req.body.ns3, req.body.ns4]
      .map((n) => field(n, 190).toLowerCase())
      .filter(Boolean);

    if (ns.length < 2) {
      flash(res, 'A domain needs at least two nameservers.', 'error');
      return res.redirect(`/panel/domains/${domain.id}`);
    }

    try {
      await registrar.setNameservers({ domain: domain.domain, nameservers: ns });
      await db.query('UPDATE domains SET ns1=?, ns2=?, ns3=?, ns4=? WHERE id = ?', [
        ns[0] || '', ns[1] || '', ns[2] || '', ns[3] || '', domain.id,
      ]);
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
