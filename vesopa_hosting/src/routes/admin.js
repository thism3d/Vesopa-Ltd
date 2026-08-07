/**
 * Admin panel.
 *
 * A separate cookie, a separate secret and a separate table from the customer
 * side, so a compromise of one cannot mint a session on the other. Admin
 * sessions are 12 hours rather than 30 days.
 *
 * Everything destructive is a POST with a CSRF token and lands in
 * `activity_log`. The log is the answer to "who suspended that account", and it
 * is worth more than the five minutes it costs to write.
 */

const express = require('express');
const db = require('../db');
const auth = require('../auth');
const pricing = require('../pricing');
const hestia = require('../integrations/hestia');
const registrar = require('../integrations/domainnameapi');
const provisioning = require('../provisioning');
const { sendMail, shell, escapeHtml } = require('../mailer');
const { flash, rateLimited, clearRateLimit, field, paging, isEmail } = require('../http-utils');
const currency = require('../currency');
const geo = require('../geo');
const config = require('../config');
const catalogue = require('../domain-catalogue');
const markup = require('../tld-markup');

const router = express.Router();

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------
router.use(async (req, res, next) => {
  res.locals.bodyClass = 'has-panel is-admin';
  const session = auth.readAdminSession(req);
  if (!session) return next();
  try {
    const admin = await db.one('SELECT * FROM hosting_admins WHERE id = ? AND active = 1 LIMIT 1', [session.sub]);
    if (admin && auth.passwordVersion(admin.password_hash) === session.pwv) {
      req.admin = admin;
      res.locals.admin = admin;
    }
  } catch (err) {
    console.error('[admin] session lookup failed:', err.message);
  }
  next();
});

// ---------------------------------------------------------------------------
// Sign in / out — must come before the guard
// ---------------------------------------------------------------------------
router.get('/login', (req, res) => {
  if (req.admin) return res.redirect('/admin');
  res.render('admin/login', { title: 'Admin sign in', robots: 'noindex', error: null, values: {} });
});

router.post('/login', async (req, res, next) => {
  try {
    const email = field(req.body.email, 190).toLowerCase();
    const password = String(req.body.password || '');

    const fail = (message) =>
      res.status(401).render('admin/login', { title: 'Admin sign in', robots: 'noindex', error: message, values: { email } });

    if (!auth.checkCsrf(req)) return fail('Your session expired. Please try again.');
    // Tighter than the customer side: this form guards the whole business.
    if (rateLimited(req.ip, 'admin-login', { max: 8, windowMs: 900_000 })) {
      return fail('Too many attempts. Please wait 15 minutes.');
    }

    const admin = await db.one('SELECT * FROM hosting_admins WHERE email = ? AND active = 1 LIMIT 1', [email]);
    const ok = await auth.checkPassword(password, admin?.password_hash);

    if (!admin || !ok) {
      await db.logActivity({ actorType: 'admin', action: 'admin.login_failed', target: email, ok: false, ip: req.ip });
      return fail('That email address or password is not right.');
    }

    clearRateLimit(req.ip, 'admin-login');
    await db.query('UPDATE hosting_admins SET last_login_at = NOW() WHERE id = ?', [admin.id]);
    await db.logActivity({ actorType: 'admin', actorId: admin.id, action: 'admin.login', target: email, ip: req.ip });

    auth.issueAdminSession(res, admin);
    res.redirect('/admin');
  } catch (err) {
    next(err);
  }
});

router.post('/logout', (req, res) => {
  auth.clearAdminSession(res);
  res.redirect('/admin/login');
});

// ---------------------------------------------------------------------------
// Guard
// ---------------------------------------------------------------------------
router.use((req, res, next) => {
  if (!req.admin) return res.redirect('/admin/login');
  res.locals.adminPath = req.path;
  next();
});

const guard = (req, res, back) => {
  if (auth.checkCsrf(req)) return true;
  flash(res, 'Your session expired. Please try again.', 'error');
  res.redirect(back);
  return false;
};

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------
router.get('/', async (req, res, next) => {
  try {
    const [counts] = await db.query(`
      SELECT
        (SELECT COUNT(*) FROM customers WHERE status = 'active')                 AS customers,
        (SELECT COUNT(*) FROM services  WHERE status = 'active')                 AS services,
        (SELECT COUNT(*) FROM domains   WHERE status = 'active')                 AS domains,
        (SELECT COUNT(*) FROM orders    WHERE status = 'pending')                AS pending_orders,
        (SELECT COUNT(*) FROM tickets   WHERE status IN ('open','customer_reply')) AS open_tickets,
        (SELECT COUNT(*) FROM enquiries WHERE handled = 0)                       AS new_enquiries,
        -- base_total_pence, NOT total_pence.
        --
        -- Summing total_pence adds 79 dollars to 59 pounds and calls it 138.
        -- Every order carries what it was worth in the base currency at the
        -- rate that applied the day it was placed, and that is the only column
        -- that can honestly be added across a mixed set.
        (SELECT COALESCE(SUM(base_total_pence),0) FROM orders
          WHERE status IN ('paid','provisioning','active')
            AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY))                  AS revenue_30d
    `);

    // And the same 30 days split by the currency actually taken, because
    // "£4,180 last month" hides the fact that a third of it arrived in dollars.
    const revenueByCurrency = await db.query(
      `SELECT currency,
              COUNT(*)                         AS orders,
              COALESCE(SUM(total_pence),0)     AS taken,
              COALESCE(SUM(base_total_pence),0) AS in_base
         FROM orders
        WHERE status IN ('paid','provisioning','active')
          AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
        GROUP BY currency
        ORDER BY in_base DESC`,
    );

    const [recentOrders, recentTickets, expiring, activity] = await Promise.all([
      db.query(
        `SELECT o.*, c.email, c.first_name, c.last_name FROM orders o
           JOIN customers c ON c.id = o.customer_id
          ORDER BY o.created_at DESC LIMIT 8`,
      ),
      db.query(
        `SELECT t.*, c.email FROM tickets t JOIN customers c ON c.id = t.customer_id
          WHERE t.status IN ('open','customer_reply') ORDER BY t.updated_at DESC LIMIT 8`,
      ),
      db.query(
        `SELECT d.*, c.email FROM domains d JOIN customers c ON c.id = d.customer_id
          WHERE d.status = 'active' AND d.expires_at IS NOT NULL
            AND d.expires_at <= DATE_ADD(CURDATE(), INTERVAL 45 DAY)
          ORDER BY d.expires_at ASC LIMIT 10`,
      ),
      db.query('SELECT * FROM activity_log ORDER BY created_at DESC LIMIT 12'),
    ]);

    res.render('admin/dashboard', {
      title: 'Admin',
      robots: 'noindex',
      counts,
      revenueByCurrency,
      recentOrders,
      recentTickets,
      expiring,
      activity,
      registrarStatus: registrar.status(),
      hestiaStatus: hestia.status(),
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------
router.get('/customers', async (req, res, next) => {
  try {
    const q = field(req.query.q, 190);
    const { page, perPage, offset } = paging(req, { perPage: 30 });
    const where = q ? 'WHERE email LIKE ? OR first_name LIKE ? OR last_name LIKE ? OR company LIKE ?' : '';
    const params = q ? Array(4).fill(`%${q}%`) : [];

    const customers = await db.query(
      `SELECT c.*,
              (SELECT COUNT(*) FROM services s WHERE s.customer_id = c.id AND s.status='active') AS services,
              (SELECT COUNT(*) FROM domains  d WHERE d.customer_id = c.id AND d.status='active') AS domains
         FROM customers c ${where}
        ORDER BY c.created_at DESC LIMIT ? OFFSET ?`,
      [...params, perPage, offset],
    );
    const [{ total }] = await db.query(`SELECT COUNT(*) AS total FROM customers ${where}`, params);

    res.render('admin/customers', { title: 'Customers', robots: 'noindex', customers, q, page, perPage, total });
  } catch (err) {
    next(err);
  }
});

router.get('/customers/:id', async (req, res, next) => {
  try {
    const customer = await db.one('SELECT * FROM customers WHERE id = ? LIMIT 1', [req.params.id]);
    if (!customer) return next();

    const [services, domains, orders, tickets, activity] = await Promise.all([
      db.query(
        `SELECT s.*, p.name AS plan_name FROM services s JOIN plans p ON p.id = s.plan_id
          WHERE s.customer_id = ? ORDER BY s.created_at DESC`,
        [customer.id],
      ),
      db.query('SELECT * FROM domains WHERE customer_id = ? ORDER BY created_at DESC', [customer.id]),
      db.query('SELECT * FROM orders WHERE customer_id = ? ORDER BY created_at DESC', [customer.id]),
      db.query('SELECT * FROM tickets WHERE customer_id = ? ORDER BY updated_at DESC', [customer.id]),
      db.query(
        'SELECT * FROM activity_log WHERE actor_type = ? AND actor_id = ? ORDER BY created_at DESC LIMIT 25',
        ['customer', customer.id],
      ),
    ]);

    res.render('admin/customer', {
      title: `${customer.first_name} ${customer.last_name}`.trim() || customer.email,
      robots: 'noindex',
      customer, services, domains, orders, tickets, activity,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/customers/:id/status', async (req, res, next) => {
  try {
    const back = `/admin/customers/${req.params.id}`;
    if (!guard(req, res, back)) return;

    const status = ['active', 'suspended', 'closed'].includes(req.body.status) ? req.body.status : 'active';
    const customer = await db.one('SELECT * FROM customers WHERE id = ? LIMIT 1', [req.params.id]);
    if (!customer) return next();

    await db.query('UPDATE customers SET status = ? WHERE id = ?', [status, customer.id]);

    // Suspending the customer suspends their sites too — otherwise "suspended"
    // means nothing and the sites carry on serving.
    if (status === 'suspended' && customer.hestia_user) {
      try {
        await hestia.suspendUser(customer.hestia_user);
      } catch (err) {
        flash(res, `Customer suspended, but the node refused: ${err.message}`, 'warn');
      }
      await db.query("UPDATE services SET status = 'suspended' WHERE customer_id = ? AND status = 'active'", [customer.id]);
    }
    if (status === 'active' && customer.hestia_user) {
      try {
        await hestia.unsuspendUser(customer.hestia_user);
        await db.query("UPDATE services SET status = 'active' WHERE customer_id = ? AND status = 'suspended'", [customer.id]);
      } catch (err) {
        flash(res, `Customer reactivated, but the node refused: ${err.message}`, 'warn');
      }
    }

    await db.logActivity({
      actorType: 'admin', actorId: req.admin.id, action: `customer.${status}`,
      target: customer.email, ip: req.ip,
    });
    flash(res, `Customer set to ${status}.`);
    res.redirect(back);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------
router.get('/orders', async (req, res, next) => {
  try {
    const status = field(req.query.status, 20);
    const { page, perPage, offset } = paging(req, { perPage: 30 });
    const where = status ? 'WHERE o.status = ?' : '';
    const params = status ? [status] : [];

    const orders = await db.query(
      `SELECT o.*, c.email, c.first_name, c.last_name FROM orders o
         JOIN customers c ON c.id = o.customer_id ${where}
        ORDER BY o.created_at DESC LIMIT ? OFFSET ?`,
      [...params, perPage, offset],
    );
    const [{ total }] = await db.query(`SELECT COUNT(*) AS total FROM orders o ${where}`, params);

    res.render('admin/orders', { title: 'Orders', robots: 'noindex', orders, status, page, perPage, total });
  } catch (err) {
    next(err);
  }
});

router.get('/orders/:id', async (req, res, next) => {
  try {
    const order = await db.one(
      `SELECT o.*, c.email, c.first_name, c.last_name, c.company, c.phone,
              c.address1, c.address2, c.city, c.postcode, c.country, c.hestia_user
         FROM orders o JOIN customers c ON c.id = o.customer_id
        WHERE o.id = ? LIMIT 1`,
      [req.params.id],
    );
    if (!order) return next();

    const [items, services, domains, paymentRows] = await Promise.all([
      db.query('SELECT * FROM order_items WHERE order_id = ?', [order.id]),
      db.query(
        `SELECT s.*, p.name AS plan_name FROM services s JOIN plans p ON p.id = s.plan_id WHERE s.order_id = ?`,
        [order.id],
      ),
      db.query('SELECT * FROM domains WHERE order_id = ?', [order.id]),
      // Newest first. A customer who tried three times has three rows, and the
      // last one is the one being asked about.
      db.query('SELECT * FROM payments WHERE order_id = ? ORDER BY id DESC', [order.id]),
    ]);

    /*
     * Payments are formatted here rather than in the template because each row
     * carries TWO currencies — what the order was in, and what the gateway
     * actually took — and neither is the admin's own currency. Formatting them
     * in the view with the page's `money()` would print a taka figure with a
     * pound sign in front of it.
     */
    const { all: allCurrencies } = await currency.load({ includeInactive: true });
    const findCur = (code) => allCurrencies.find((c) => c.code === code) || null;
    const payments = paymentRows.map((p) => ({
      ...p,
      amount_display: currency.format(p.amount_minor, findCur(p.currency)),
      charged_display: currency.format(p.charged_minor, findCur(p.charged_currency)),
      // Only worth showing when the two genuinely differ.
      converted: p.currency !== p.charged_currency,
    }));

    res.render('admin/order', {
      title: `Order ${order.reference}`,
      robots: 'noindex',
      order, items, services, domains, payments,
      hestiaLive: hestia.isLive(),
      registrarLive: registrar.isLive(),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Mark paid and provision.
 *
 * This is the button the payment webhook will replace. It calls exactly the
 * same function, which is the point of `provisioning.js` being a module.
 */
router.post('/orders/:id/pay', async (req, res, next) => {
  try {
    const back = `/admin/orders/${req.params.id}`;
    if (!guard(req, res, back)) return;

    const order = await db.one('SELECT * FROM orders WHERE id = ? LIMIT 1', [req.params.id]);
    if (!order) return next();

    if (order.status !== 'pending') {
      flash(res, `That order is already ${order.status}.`, 'warn');
      return res.redirect(back);
    }

    await db.query(
      "UPDATE orders SET status = 'paid', paid_at = NOW(), payment_ref = ? WHERE id = ?",
      [field(req.body.payment_ref, 190), order.id],
    );
    await db.logActivity({
      actorType: 'admin', actorId: req.admin.id, action: 'order.marked_paid',
      target: order.reference,
      detail: `${currency.format(order.total_pence, await currency.resolve(order.currency))} ${order.currency}`,
      ip: req.ip,
    });

    /*
     * PAYMENT NO LONGER PROVISIONS IMMEDIATELY, and that is the point of the
     * new flow.
     *
     * The customer's setup wizard opens the moment the order is paid, and its
     * first question is which domain the hosting is for — including the free
     * one they are owed. Provisioning here would answer that question for them
     * (with "none") before they ever saw it, and the free domain would be
     * quietly lost.
     *
     * So: if a hosting service is still waiting at the `domain` step, leave it
     * for the customer. Anything else — a domain-only order, an email-only
     * order, or a service whose domain question is already settled — has
     * nothing to ask and is provisioned right here as before.
     *
     * The "Provision now" button on the order page overrides this, for the
     * customer who telephones rather than finishing the wizard.
     */
    const waiting = await db.one(
      `SELECT id FROM services WHERE order_id = ? AND setup_step = 'domain' AND status = 'pending' LIMIT 1`,
      [order.id],
    );

    if (waiting) {
      flash(res, 'Marked paid. The customer is choosing their domain — setup starts when they do.');
      return res.redirect(back);
    }

    const result = await provisioning.provisionOrder(order.id, {
      actorType: 'admin', actorId: req.admin.id, ip: req.ip,
    });

    if (result.ok) {
      flash(res, 'Paid and provisioned. The welcome email has gone out.');
    } else {
      const failures = [
        ...result.services.filter((s) => !s.ok && !s.skipped).map((s) => `hosting: ${s.error}`),
        ...result.domains.filter((d) => !d.ok && !d.skipped).map((d) => `${d.domain}: ${d.error}`),
      ];
      flash(res, `Partly provisioned. ${failures.join(' · ')}`, 'warn');
    }
    res.redirect(back);
  } catch (err) {
    next(err);
  }
});

/** Retry the parts that failed, without re-charging or re-doing what worked. */
router.post('/orders/:id/provision', async (req, res, next) => {
  try {
    const back = `/admin/orders/${req.params.id}`;
    if (!guard(req, res, back)) return;

    const result = await provisioning.provisionOrder(req.params.id, {
      actorType: 'admin', actorId: req.admin.id, ip: req.ip,
    });
    flash(res, result.ok ? 'Everything provisioned.' : 'Some steps still failed — see the order for detail.', result.ok ? 'ok' : 'warn');
    res.redirect(back);
  } catch (err) {
    next(err);
  }
});

router.post('/orders/:id/cancel', async (req, res, next) => {
  try {
    const back = `/admin/orders/${req.params.id}`;
    if (!guard(req, res, back)) return;
    const order = await db.one('SELECT * FROM orders WHERE id = ? LIMIT 1', [req.params.id]);
    if (!order) return next();

    await db.query("UPDATE orders SET status = 'cancelled' WHERE id = ?", [order.id]);
    await db.query("UPDATE services SET status = 'terminated' WHERE order_id = ? AND status = 'pending'", [order.id]);
    await db.query("UPDATE domains SET status = 'cancelled' WHERE order_id = ? AND status = 'pending'", [order.id]);
    await db.logActivity({
      actorType: 'admin', actorId: req.admin.id, action: 'order.cancelled', target: order.reference, ip: req.ip,
    });
    flash(res, 'Order cancelled.');
    res.redirect(back);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------
router.get('/services', async (req, res, next) => {
  try {
    const { page, perPage, offset } = paging(req, { perPage: 40 });
    const services = await db.query(
      `SELECT s.*, p.name AS plan_name, c.email, sv.hostname
         FROM services s
         JOIN plans p ON p.id = s.plan_id
         JOIN customers c ON c.id = s.customer_id
         LEFT JOIN servers sv ON sv.id = s.server_id
        ORDER BY s.created_at DESC LIMIT ? OFFSET ?`,
      [perPage, offset],
    );
    const [{ total }] = await db.query('SELECT COUNT(*) AS total FROM services');
    res.render('admin/services', { title: 'Services', robots: 'noindex', services, page, perPage, total });
  } catch (err) {
    next(err);
  }
});

router.post('/services/:id/suspend', async (req, res, next) => {
  try {
    const back = req.get('Referer') && req.get('Referer').startsWith(res.locals.siteUrl) ? req.get('Referer') : '/admin/services';
    if (!guard(req, res, back)) return;

    const service = await db.one(
      'SELECT s.*, c.hestia_user, c.email FROM services s JOIN customers c ON c.id = s.customer_id WHERE s.id = ? LIMIT 1',
      [req.params.id],
    );
    if (!service) return next();

    const suspending = service.status === 'active';
    const reason = field(req.body.reason, 190);

    try {
      if (suspending) await hestia.suspendUser(service.hestia_user);
      else await hestia.unsuspendUser(service.hestia_user);
    } catch (err) {
      flash(res, `The node refused: ${err.message}`, 'error');
      return res.redirect(back);
    }

    await db.query('UPDATE services SET status = ?, suspended_reason = ? WHERE id = ?', [
      suspending ? 'suspended' : 'active',
      suspending ? reason : '',
      service.id,
    ]);
    await db.logActivity({
      actorType: 'admin', actorId: req.admin.id,
      action: suspending ? 'service.suspended' : 'service.unsuspended',
      target: service.primary_domain || `service#${service.id}`, detail: reason, ip: req.ip,
    });

    flash(res, suspending ? 'Service suspended.' : 'Service restored.');
    res.redirect(back);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Domains
// ---------------------------------------------------------------------------
router.get('/domains', async (req, res, next) => {
  try {
    const { page, perPage, offset } = paging(req, { perPage: 40 });
    const domains = await db.query(
      `SELECT d.*, c.email FROM domains d JOIN customers c ON c.id = d.customer_id
        ORDER BY d.expires_at IS NULL, d.expires_at ASC LIMIT ? OFFSET ?`,
      [perPage, offset],
    );
    const [{ total }] = await db.query('SELECT COUNT(*) AS total FROM domains');
    res.render('admin/domains', { title: 'Domains', robots: 'noindex', domains, page, perPage, total });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------
router.get('/plans', async (req, res, next) => {
  try {
    // Base currency throughout the admin: every figure on this page is a
    // sterling price being edited, not a shop price being shown.
    const { plans } = await pricing.load({ fresh: true, includeInactive: true });
    res.render('admin/plans', {
      title: 'Hosting plans',
      robots: 'noindex',
      plans,
      currencies: (await currency.load()).all.filter((c) => !c.is_base),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Email plans.
 *
 * Registered BEFORE `/plans/:id`, because Express matches in order and
 * `/plans/email` would otherwise be read as a plan whose id is "email" —
 * `db.one` would find nothing and the page would 404 with no clue why.
 */
router.get('/plans/email', async (req, res, next) => {
  try {
    const { businessEmail, marketingEmail } = await pricing.load({ fresh: true, includeInactive: true });
    res.render('admin/email-plans', {
      title: 'Email plans',
      robots: 'noindex',
      businessEmail,
      marketingEmail,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/plans/email/:id', async (req, res, next) => {
  try {
    const row = await db.one('SELECT * FROM email_plans WHERE id = ? LIMIT 1', [req.params.id]);
    if (!row) return next();
    // Decorated, not raw: the form shows the per-month figure and the saving
    // each total produces, and those live on the decorated shape.
    const base = await currency.base();
    const plan = pricing.decorateEmailPlan(pricing.convertRow(row, 'email_plan', base, {}), base);
    res.render('admin/email-plan', {
      title: `Edit ${row.name}`,
      robots: 'noindex',
      plan,
      matrix: await pricing.currencyMatrix('email_plan', plan),
      entity: 'email_plan',
      errors: {},
    });
  } catch (err) {
    next(err);
  }
});

router.post('/plans/email/:id', async (req, res, next) => {
  try {
    const back = `/admin/plans/email/${req.params.id}`;
    if (!guard(req, res, back)) return;

    const plan = await db.one('SELECT * FROM email_plans WHERE id = ? LIMIT 1', [req.params.id]);
    if (!plan) return next();

    await db.query(
      `UPDATE email_plans SET name=?, tagline=?, unit_label=?, monthly_pence=?, annual_pence=?,
              storage_gb=?, min_units=?, max_units=?, monthly_sends=?,
              badge=?, sort_order=?, active=?, features=?
        WHERE id = ?`,
      [
        field(req.body.name, 80),
        field(req.body.tagline, 190),
        field(req.body.unit_label, 40) || 'mailbox',
        toPence(req.body.monthly), toPence(req.body.annual),
        Number(req.body.storage_gb) || 0,
        Math.max(1, Number(req.body.min_units) || 1),
        Math.max(1, Number(req.body.max_units) || 500),
        Number(req.body.monthly_sends) || 0,
        field(req.body.badge, 40),
        Number(req.body.sort_order) || 0,
        req.body.active ? 1 : 0,
        field(req.body.features, 4000),
        plan.id,
      ],
    );

    pricing.invalidate();
    await db.logActivity({
      actorType: 'admin', actorId: req.admin.id, action: 'email_plan.updated',
      target: plan.slug, ip: req.ip,
    });
    flash(res, `${plan.name} updated.`);
    res.redirect('/admin/plans/email');
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Discount codes
// ---------------------------------------------------------------------------
router.get('/coupons', async (req, res, next) => {
  try {
    const rows = await db.query('SELECT * FROM coupons ORDER BY active DESC, id DESC');
    res.render('admin/coupons', { title: 'Discount codes', robots: 'noindex', coupons: rows });
  } catch (err) {
    next(err);
  }
});

router.post('/coupons', async (req, res, next) => {
  try {
    if (!guard(req, res, '/admin/coupons')) return;

    const code = field(req.body.code, 40).toUpperCase().replace(/[^A-Z0-9_-]/g, '');
    if (!code) {
      flash(res, 'A code needs at least one letter or number.', 'error');
      return res.redirect('/admin/coupons');
    }

    const kind = req.body.kind === 'fixed' ? 'fixed' : 'percent';
    // A percentage is 1–100; a fixed amount is pounds in the form, pence here.
    const value = kind === 'percent'
      ? Math.max(1, Math.min(100, Number(req.body.value) || 0))
      : toPence(req.body.value);

    if (!value) {
      flash(res, 'That discount comes to nothing.', 'error');
      return res.redirect('/admin/coupons');
    }

    await db.query(
      `INSERT INTO coupons
         (code, description, kind, value, min_spend_pence, applies_to,
          max_uses, first_order_only, expires_at, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
       ON DUPLICATE KEY UPDATE
         description = VALUES(description), kind = VALUES(kind), value = VALUES(value),
         min_spend_pence = VALUES(min_spend_pence), applies_to = VALUES(applies_to),
         max_uses = VALUES(max_uses), first_order_only = VALUES(first_order_only),
         expires_at = VALUES(expires_at), active = 1`,
      [
        code,
        field(req.body.description, 190),
        kind,
        value,
        toPence(req.body.min_spend),
        ['all', 'hosting', 'domain', 'email'].includes(req.body.applies_to) ? req.body.applies_to : 'all',
        Math.max(0, Number(req.body.max_uses) || 0),
        req.body.first_order_only ? 1 : 0,
        field(req.body.expires_at, 20) || null,
      ],
    );

    await db.logActivity({
      actorType: 'admin', actorId: req.admin.id, action: 'coupon.saved', target: code, ip: req.ip,
    });
    flash(res, `${code} saved.`);
    res.redirect('/admin/coupons');
  } catch (err) {
    next(err);
  }
});

router.post('/coupons/:id/toggle', async (req, res, next) => {
  try {
    if (!guard(req, res, '/admin/coupons')) return;
    // Toggled rather than deleted: a code on a past order should still resolve
    // when someone asks what that discount was.
    await db.query('UPDATE coupons SET active = 1 - active WHERE id = ?', [req.params.id]);
    res.redirect('/admin/coupons');
  } catch (err) {
    next(err);
  }
});

router.get('/plans/:id', async (req, res, next) => {
  try {
    const plan = await db.one('SELECT * FROM plans WHERE id = ? LIMIT 1', [req.params.id]);
    if (!plan) return next();
    // Decorated so the price fields can show the per-month figure and saving
    // that each total produces — the numbers an admin is actually reasoning
    // about when they change one.
    const base = await currency.base();
    const decorated = pricing.decoratePlan(pricing.convertRow(plan, 'plan', base, {}), base);
    res.render('admin/plan', {
      title: `Edit ${plan.name}`,
      robots: 'noindex',
      plan: decorated,
      matrix: await pricing.currencyMatrix('plan', decorated),
      entity: 'plan',
      errors: {},
    });
  } catch (err) {
    next(err);
  }
});

/** Pounds in the form, pence in the database. Never store a float. */
const toPence = (v) => Math.max(0, Math.round(Number(String(v).replace(/[^0-9.]/g, '')) * 100) || 0);

router.post('/plans/:id', async (req, res, next) => {
  try {
    const back = `/admin/plans/${req.params.id}`;
    if (!guard(req, res, back)) return;

    const plan = await db.one('SELECT * FROM plans WHERE id = ? LIMIT 1', [req.params.id]);
    if (!plan) return next();

    await db.query(
      `UPDATE plans SET name=?, tagline=?, monthly_pence=?, annual_pence=?, biennial_pence=?,
              triennial_pence=?,
              websites=?, storage_gb=?, bandwidth_gb=?, \`databases\`=?, mailboxes=?,
              free_domain=?, free_ssl=?, daily_backups=?, priority_support=?,
              hestia_package=?, badge=?, sort_order=?, active=?, features=?
        WHERE id = ?`,
      [
        field(req.body.name, 80),
        field(req.body.tagline, 190),
        toPence(req.body.monthly), toPence(req.body.annual), toPence(req.body.biennial),
        toPence(req.body.triennial),
        Number(req.body.websites) || 1,
        Number(req.body.storage_gb) || 1,
        Number(req.body.bandwidth_gb) || 0,
        Number(req.body.databases) || 1,
        Number(req.body.mailboxes) || 1,
        req.body.free_domain ? 1 : 0,
        req.body.free_ssl ? 1 : 0,
        req.body.daily_backups ? 1 : 0,
        req.body.priority_support ? 1 : 0,
        field(req.body.hestia_package, 64) || 'default',
        field(req.body.badge, 40),
        Number(req.body.sort_order) || 0,
        req.body.active ? 1 : 0,
        field(req.body.features, 4000),
        plan.id,
      ],
    );

    pricing.invalidate();
    await db.logActivity({
      actorType: 'admin', actorId: req.admin.id, action: 'plan.updated', target: plan.slug, ip: req.ip,
    });
    flash(res, `${field(req.body.name, 80)} saved. Live on the site immediately.`);
    res.redirect('/admin/plans');
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// TLD pricing
// ---------------------------------------------------------------------------
/**
 * Filter and page the TLD table.
 *
 * THE TABLE IS 715 ROWS NOW. It was 23 when this screen was written, and a
 * single form containing every one of them is 3,000 inputs, several megabytes
 * of HTML, and a save that rewrites the whole catalogue to change one price.
 *
 * So the page shows one filtered slice at a time, and the save posts only what
 * is on screen. That is safe because the save has always updated BY ID — the
 * rows that were not rendered are simply not in the request and are not
 * touched.
 */
const TLDS_PER_PAGE = 50;

function tldFilters(query) {
  return {
    q: String(query.q || '').trim().toLowerCase().replace(/^\./, '').slice(0, 40),
    category: String(query.category || ''),
    // `loss` is the reason this filter set exists at all: the rate-card import
    // found eleven extensions selling below cost, and finding them again in a
    // 715-row table without a filter is not realistic.
    show: String(query.show || ''),
    page: Math.max(1, Number(query.page) || 1),
  };
}

/**
 * Rebuild the filter query string from whatever a form posted back.
 *
 * Every write on this screen redirects, and a redirect that drops the filters
 * dumps the admin back at page 1 of 715 rows. The forms carry the four filter
 * values as hidden fields and this turns them back into a query string.
 */
function backQuery(body) {
  const p = new URLSearchParams();
  for (const key of ['q', 'category', 'show', 'page']) {
    const value = String(body[`f_${key}`] || '').trim();
    if (value) p.set(key, value);
  }
  const qs = p.toString();
  return qs ? `?${qs}` : '';
}

function filterTlds(rows, f) {
  let out = rows;
  if (f.q) out = out.filter((t) => t.tld.includes(f.q));
  if (f.category) out = out.filter((t) => (t.category || 'other') === f.category);
  if (f.show === 'loss') out = out.filter((t) => t.register_pence > 0 && t.register_pence < t.cost_pence);
  if (f.show === 'featured') out = out.filter((t) => t.featured);
  if (f.show === 'inactive') out = out.filter((t) => !t.active);
  if (f.show === 'nocost') out = out.filter((t) => !t.cost_pence);
  return out;
}

router.get('/tlds', async (req, res, next) => {
  try {
    const { tlds: allTlds } = await pricing.load({ fresh: true, includeInactive: true });
    const others = (await currency.load({ includeInactive: true })).all.filter((c) => !c.is_base);

    const f = tldFilters(req.query);
    const matched = filterTlds(allTlds, f);
    const pages = Math.max(1, Math.ceil(matched.length / TLDS_PER_PAGE));
    const page = Math.min(f.page, pages);
    const tlds = matched.slice((page - 1) * TLDS_PER_PAGE, page * TLDS_PER_PAGE);

    // Counts for the filter buttons, computed on the WHOLE table rather than
    // the current page — a badge saying "11 below cost" that only counted the
    // fifty rows on screen would be worse than no badge.
    const tally = {
      all: allTlds.length,
      loss: allTlds.filter((t) => t.register_pence > 0 && t.register_pence < t.cost_pence).length,
      featured: allTlds.filter((t) => t.featured).length,
      inactive: allTlds.filter((t) => !t.active).length,
      nocost: allTlds.filter((t) => !t.cost_pence).length,
    };

    /*
     * The per-currency editor is a TAB, opened with ?currency=USD, rather than
     * twelve more columns on a table that already scrolls sideways at forty
     * extensions. One currency at a time is the only version of this page
     * somebody can actually edit without losing their place in it.
     */
    const wanted = String(req.query.currency || '').toUpperCase();
    const overrideCurrency = others.find((c) => c.code === wanted) || null;

    let overrideRows = [];
    // The per-currency editor follows the SAME slice. Two tables on one page
    // showing different sets of extensions would be unusable.
    if (overrideCurrency) {
      // Built straight off the base layer rather than by calling
      // currencyMatrix() forty times — that helper re-reads the whole override
      // set per row, which is fine for one plan and silly for a table.
      const { overrides } = await pricing.loadBase();
      const mine = overrides?.tld || {};
      overrideRows = tlds.map((t) => {
        const set = mine[t.id]?.[overrideCurrency.code] || {};
        const row = { id: t.id, tld: t.tld };
        for (const f of ['register', 'renew', 'transfer']) {
          const baseAmount = Number(t[`base_${f}_pence`] ?? t[`${f}_pence`]) || 0;
          row[f] = {
            converted_minor: currency.convert(baseAmount, overrideCurrency),
            override_minor: set[f] === undefined ? null : Number(set[f]),
          };
        }
        return row;
      });
    }

    res.render('admin/tlds', {
      title: 'Domain pricing',
      robots: 'noindex',
      tlds,
      currencies: others,
      overrideCurrency,
      overrideRows,
      // Paging and filtering
      filters: f,
      page,
      pages,
      matchedCount: matched.length,
      tally,
      categories: catalogue.CATEGORIES,
      // What the markup ladder would charge, so an admin can see the suggestion
      // beside the price without leaving the row.
      suggest: (cost) => markup.sellFrom(cost),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/tlds', async (req, res, next) => {
  try {
    if (!guard(req, res, '/admin/tlds')) return;

    // The whole table posts at once, as parallel arrays. Simpler to reason
    // about than a row-at-a-time form, and it is a page an admin edits in one
    // sitting when the registrar changes its rate card.
    const ids = [].concat(req.body.id || []);
    const reg = [].concat(req.body.register || []);
    const ren = [].concat(req.body.renew || []);
    const tra = [].concat(req.body.transfer || []);
    const cost = [].concat(req.body.cost || []);
    const cat = [].concat(req.body.category || []);
    const featured = new Set([].concat(req.body.featured || []).map(String));
    const active = new Set([].concat(req.body.active || []).map(String));

    /*
     * Only the rows on screen are posted, and only they are touched.
     *
     * The update is BY ID, so a filtered page of fifty saves those fifty and
     * leaves the other 665 exactly as they were. That is what makes paginating
     * this form safe — and it is also why the checkbox columns are read as a
     * set of posted ids rather than as an array: an unchecked checkbox sends
     * nothing at all, so the arrays would not line up with `ids`.
     */
    for (let i = 0; i < ids.length; i++) {
      await db.query(
        `UPDATE tlds SET register_pence=?, renew_pence=?, transfer_pence=?, cost_pence=?,
                category=?, featured=?, active=? WHERE id = ?`,
        [
          toPence(reg[i]), toPence(ren[i]), toPence(tra[i]), toPence(cost[i]),
          catalogue.CATEGORY_BY_SLUG[cat[i]] ? cat[i] : 'other',
          featured.has(String(ids[i])) ? 1 : 0,
          active.has(String(ids[i])) ? 1 : 0,
          ids[i],
        ],
      );
    }

    pricing.invalidate();
    await db.logActivity({ actorType: 'admin', actorId: req.admin.id, action: 'tlds.updated', target: `${ids.length} rows`, ip: req.ip });
    flash(res, `Saved ${ids.length} extension${ids.length === 1 ? '' : 's'}.`);
    // Back to the same filtered page, not to the top of an unfiltered table.
    // Losing your place after every save makes a 715-row catalogue unworkable.
    res.redirect(`/admin/tlds${backQuery(req.body)}`);
  } catch (err) {
    next(err);
  }
});

/**
 * Reprice the extensions currently on screen from the markup ladder.
 *
 * The same function the rate-card importer uses — src/tld-markup.js — applied
 * to whatever the filter has selected. The intended use is the one the import
 * flagged: filter to "below cost", check the suggestions, reprice those eleven.
 *
 * It works on the POSTED IDS, not on the filter re-run server-side, and that is
 * deliberate. The admin is looking at a page of suggestions; repricing has to
 * change exactly the rows they were shown, not whatever the filter happens to
 * match a second later after somebody else's edit.
 */
router.post('/tlds/reprice', async (req, res, next) => {
  try {
    const back = `/admin/tlds${backQuery(req.body)}`;
    if (!guard(req, res, back)) return;

    const ids = [].concat(req.body.id || []).map(Number).filter(Boolean);
    if (!ids.length) {
      flash(res, 'Nothing to reprice.', 'warn');
      return res.redirect(back);
    }

    const rows = await db.query(
      `SELECT id, tld, cost_pence, register_pence FROM tlds WHERE id IN (${ids.map(() => '?').join(',')})`,
      ids,
    );

    let changed = 0;
    let skipped = 0;
    for (const row of rows) {
      // No cost, no suggestion. Repricing off a zero cost would set every one
      // of them to zero and give the catalogue away.
      if (!row.cost_pence) {
        skipped += 1;
        continue;
      }
      const target = markup.sellFrom(row.cost_pence);
      if (target === row.register_pence) continue;
      await db.query(
        'UPDATE tlds SET register_pence = ?, renew_pence = GREATEST(renew_pence, ?) WHERE id = ?',
        [target, target, row.id],
      );
      changed += 1;
    }

    pricing.invalidate();
    await db.logActivity({
      actorType: 'admin', actorId: req.admin.id, action: 'tlds.repriced',
      target: `${changed} rows`, detail: `${skipped} skipped for having no cost`, ip: req.ip,
    });
    flash(
      res,
      `Repriced ${changed} extension${changed === 1 ? '' : 's'} from the markup ladder.`
      + (skipped ? ` ${skipped} skipped — no cost recorded.` : ''),
    );
    res.redirect(back);
  } catch (err) {
    next(err);
  }
});

router.post('/tlds/new', async (req, res, next) => {
  try {
    if (!guard(req, res, '/admin/tlds')) return;
    const tld = field(req.body.tld, 32).toLowerCase().replace(/^\./, '');
    if (!/^[a-z0-9.-]{2,32}$/.test(tld)) {
      flash(res, 'That does not look like an extension.', 'error');
      return res.redirect('/admin/tlds');
    }
    await db.query(
      `INSERT INTO tlds (tld, register_pence, renew_pence, transfer_pence, cost_pence, sort_order)
       VALUES (?, ?, ?, ?, ?, 999)
       ON DUPLICATE KEY UPDATE active = 1`,
      [tld, toPence(req.body.register), toPence(req.body.renew), toPence(req.body.transfer), toPence(req.body.cost)],
    );
    pricing.invalidate();
    flash(res, `.${tld} added.`);
    res.redirect('/admin/tlds');
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Currencies
// ---------------------------------------------------------------------------
/**
 * Everything about how a base price becomes a foreign one is on this screen:
 * the rate, the rounding, the VAT treatment, and which countries land on it.
 *
 * It is one page rather than a row-at-a-time editor because the four numbers
 * only make sense next to each other — a rate without its rounding rule tells
 * you nothing about what a customer will actually be charged, so the preview
 * column shows a real plan price run all the way through.
 */
router.get('/currencies', async (req, res, next) => {
  try {
    const { all, base } = await currency.load({ fresh: true, includeInactive: true });
    const { planRows } = await pricing.loadBase({ fresh: true });

    // A real price from the catalogue, so the preview is something an admin can
    // recognise rather than an invented round number that hides the rounding.
    const sample = planRows.find((p) => p.active && p.annual_pence > 0) || planRows[0] || null;

    /*
     * DOES THE PRICE LADDER SURVIVE THE ROUNDING IN THIS CURRENCY?
     *
     * The whole catalogue is built on "longer term, better rate". A coarse
     * rounding rule can flatten that without anybody noticing: at 1.27, £2.59
     * and £2.29 a month BOTH become $2.99 under `charm99`, so the three-year
     * plan costs the same per month as the two-year one and the customer is
     * asked to commit for an extra year in exchange for nothing.
     *
     * That is invisible from the sterling catalogue — the sterling prices are
     * fine — and it is invisible from this screen unless it is checked. So it
     * is checked, per currency, against every active plan.
     */
    const termsAsc = config.TERMS.slice().sort((a, b) => a.months - b.months);
    const ladderWarnings = [];
    for (const c of all.filter((x) => x.active && !x.is_base)) {
      /*
       * The EFFECTIVE prices, from the priced catalogue — not `convert()` on
       * the base row.
       *
       * A hand-typed override does not go through the converter, so checking
       * the conversion would be blind to exactly the case that most needs
       * catching: an admin fixing one term's price in one currency and
       * accidentally making it cheaper than the longer term next to it.
       */
      const { plans } = await pricing.load({ cur: c });
      const broken = [];
      for (const plan of plans) {
        let previous = null;
        for (const term of termsAsc) {
          const total = Number(plan.price[term.months]) || 0;
          if (!total) continue;
          const rate = Math.round(total / term.months);
          if (previous && rate >= previous.rate) {
            broken.push(`${plan.name}: ${term.label} is not cheaper per month than ${previous.label}`);
            break;
          }
          previous = { rate, label: term.label };
        }
      }
      if (broken.length) ladderWarnings.push({ code: c.code, broken });
    }

    res.render('admin/currencies', {
      title: 'Currencies',
      robots: 'noindex',
      currencies: all,
      base,
      sample,
      // The rounding helper itself, so the preview column can show the same
      // arithmetic the site will actually run rather than a template's
      // approximation of it.
      cur: currency,
      ladderWarnings,
      geoStatus: geo.status(),
      roundingRules: currency.ROUNDING_RULES,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/currencies', async (req, res, next) => {
  try {
    if (!guard(req, res, '/admin/currencies')) return;

    const codes = [].concat(req.body.code || []);
    const rates = [].concat(req.body.rate || []);
    const roundings = [].concat(req.body.rounding || []);
    const vats = [].concat(req.body.vat_percent || []);
    const vatLabels = [].concat(req.body.vat_label || []);
    const symbols = [].concat(req.body.symbol || []);
    const locales = [].concat(req.body.locale || []);
    const countries = [].concat(req.body.countries || []);
    const active = new Set([].concat(req.body.active || []).map(String));
    const wantedDefault = String(req.body.is_default || '').toUpperCase();

    const { base } = await currency.load({ includeInactive: true });

    for (let i = 0; i < codes.length; i++) {
      const code = String(codes[i]).toUpperCase().slice(0, 3);
      const isBase = code === base.code;

      /*
       * THE BASE CURRENCY'S RATE IS PINNED AT 1 AND ITS ROUNDING AT `exact`.
       *
       * Not a cosmetic guard. A rate of 1.05 on the base row would mean the
       * sterling prices an admin typed are not the sterling prices customers
       * see, and a rounding rule there would quietly rewrite every one of them
       * — with no way to tell from the catalogue screen that it had happened.
       */
      const rate = isBase ? 1 : Math.max(0.000001, Number(rates[i]) || 1);
      const rounding = isBase ? 'exact'
        : (currency.ROUNDING_CODES.includes(roundings[i]) ? roundings[i] : 'charm9');

      await db.query(
        `UPDATE currencies
            SET rate = ?, rounding = ?, vat_percent = ?, vat_label = ?,
                symbol = ?, locale = ?, countries = ?, active = ?, is_default = ?
          WHERE code = ?`,
        [
          rate,
          rounding,
          Math.max(0, Math.min(100, Number(vats[i]) || 0)),
          field(vatLabels[i], 40),
          field(symbols[i], 8),
          field(locales[i], 12) || 'en-GB',
          field(countries[i], 255).toUpperCase().replace(/[^A-Z,]/g, ''),
          // The base currency can never be switched off — it is what the whole
          // catalogue is denominated in, and the site has nothing to fall back
          // to without it.
          isBase || active.has(code) ? 1 : 0,
          code === wantedDefault ? 1 : 0,
          code,
        ],
      );
    }

    // Exactly one default, always. If the form somehow named none, the base
    // takes it rather than leaving new visitors with nothing to resolve to.
    const [{ defaults }] = await db.query('SELECT COUNT(*) AS defaults FROM currencies WHERE is_default = 1');
    if (!defaults) {
      await db.query('UPDATE currencies SET is_default = 1 WHERE code = ?', [base.code]);
    }

    currency.invalidate();
    pricing.invalidate();
    await db.logActivity({
      actorType: 'admin', actorId: req.admin.id, action: 'currencies.updated',
      target: `${codes.length} rows`, ip: req.ip,
    });
    flash(res, 'Currencies saved. Every price on the site has moved.');
    res.redirect('/admin/currencies');
  } catch (err) {
    next(err);
  }
});

router.post('/currencies/new', async (req, res, next) => {
  try {
    if (!guard(req, res, '/admin/currencies')) return;
    const code = field(req.body.code, 3).toUpperCase().replace(/[^A-Z]/g, '');
    if (code.length !== 3) {
      flash(res, 'A currency code is three letters — EUR, AUD, NZD.', 'error');
      return res.redirect('/admin/currencies');
    }
    await db.query(
      `INSERT INTO currencies (code, name, symbol, locale, rate, rounding, sort_order, active)
       VALUES (?, ?, ?, ?, ?, 'charm99', 99, 0)
       ON DUPLICATE KEY UPDATE name = VALUES(name)`,
      [
        code,
        field(req.body.name, 60) || code,
        field(req.body.symbol, 8) || code,
        field(req.body.locale, 12) || 'en-GB',
        Math.max(0.000001, Number(req.body.rate) || 1),
      ],
    );
    currency.invalidate();
    pricing.invalidate();
    // Added switched OFF. A currency with a placeholder rate and no country
    // mapping appearing in the customer switcher the instant it is created is
    // how somebody buys a plan at the wrong price.
    flash(res, `${code} added, switched off. Set its rate and countries, then turn it on.`);
    res.redirect('/admin/currencies');
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Per-currency price overrides
// ---------------------------------------------------------------------------
/**
 * Type a price for one field, in one currency, and it stops being converted.
 *
 * Posted as flat `o_USD_monthly` names, because express is configured with
 * `extended: false` and does not parse nested bracket syntax — a silently
 * ignored `o[USD][monthly]` would look like a form that saves and does nothing.
 *
 * A blank box DELETES the override and hands the field back to the converter.
 * That is the only way back: without it, the first admin to type a number into
 * a currency has pinned it for ever and every future rate change quietly skips
 * that one price.
 */
router.post('/prices/:entity/:id', async (req, res, next) => {
  try {
    const entity = String(req.params.entity);
    const table = { plan: 'plans', email_plan: 'email_plans', tld: 'tlds' }[entity];
    if (!table) return next();

    const backTo = {
      plan: `/admin/plans/${req.params.id}`,
      email_plan: `/admin/plans/email/${req.params.id}`,
      tld: '/admin/tlds',
    }[entity];
    if (!guard(req, res, backTo)) return;

    const row = await db.one(`SELECT id FROM ${table} WHERE id = ? LIMIT 1`, [req.params.id]);
    if (!row) return next();

    const { all } = await currency.load({ includeInactive: true });
    const validCurrency = new Set(all.filter((c) => !c.is_base).map((c) => c.code));
    const validField = new Set(pricing.PRICE_FIELDS[entity]);

    let set = 0;
    let cleared = 0;

    for (const [key, raw] of Object.entries(req.body)) {
      const match = /^o_([A-Za-z]{3})_([a-z_]+)$/.exec(key);
      if (!match) continue;
      const code = match[1].toUpperCase();
      const fieldName = match[2];
      if (!validCurrency.has(code) || !validField.has(fieldName)) continue;

      const typed = String(raw).trim();
      if (!typed) {
        const [res2] = await db.pool.query(
          'DELETE FROM price_overrides WHERE entity = ? AND entity_id = ? AND currency = ? AND field = ?',
          [entity, row.id, code, fieldName],
        );
        cleared += res2.affectedRows;
        continue;
      }

      await db.query(
        `INSERT INTO price_overrides (entity, entity_id, currency, field, amount_minor)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE amount_minor = VALUES(amount_minor)`,
        [entity, row.id, code, fieldName, toPence(typed)],
      );
      set += 1;
    }

    pricing.invalidate();
    await db.logActivity({
      actorType: 'admin', actorId: req.admin.id, action: 'prices.overridden',
      target: `${entity}#${row.id}`, detail: `${set} set, ${cleared} back to converted`, ip: req.ip,
    });
    flash(res, set || cleared
      ? `Saved — ${set} fixed price${set === 1 ? '' : 's'}, ${cleared} back to converted.`
      : 'No changes.');
    res.redirect(backTo);
  } catch (err) {
    next(err);
  }
});

/**
 * The whole TLD table's overrides for one currency, in one submit.
 *
 * Parallel arrays, the same shape as the sterling table above it, because it is
 * a page an admin edits in one sitting when a registry moves its rate card.
 */
router.post('/prices/tld-bulk', async (req, res, next) => {
  try {
    const code = String(req.body.currency || '').toUpperCase();
    const back = `/admin/tlds?currency=${encodeURIComponent(code)}`;
    if (!guard(req, res, back)) return;

    const { all } = await currency.load({ includeInactive: true });
    const cur = all.find((c) => c.code === code && !c.is_base);
    if (!cur) {
      flash(res, 'That is not a currency we sell in.', 'error');
      return res.redirect('/admin/tlds');
    }

    const ids = [].concat(req.body.id || []);
    const cols = {
      register: [].concat(req.body.o_register || []),
      renew: [].concat(req.body.o_renew || []),
      transfer: [].concat(req.body.o_transfer || []),
    };

    let set = 0;
    let cleared = 0;

    for (let i = 0; i < ids.length; i++) {
      for (const [fieldName, values] of Object.entries(cols)) {
        const typed = String(values[i] ?? '').trim();
        if (!typed) {
          const [result] = await db.pool.query(
            'DELETE FROM price_overrides WHERE entity = ? AND entity_id = ? AND currency = ? AND field = ?',
            ['tld', ids[i], code, fieldName],
          );
          cleared += result.affectedRows;
          continue;
        }
        await db.query(
          `INSERT INTO price_overrides (entity, entity_id, currency, field, amount_minor)
           VALUES ('tld', ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE amount_minor = VALUES(amount_minor)`,
          [ids[i], code, fieldName, toPence(typed)],
        );
        set += 1;
      }
    }

    pricing.invalidate();
    await db.logActivity({
      actorType: 'admin', actorId: req.admin.id, action: 'prices.overridden',
      target: `tld/${code}`, detail: `${set} fixed, ${cleared} back to converted`, ip: req.ip,
    });
    flash(res, `${code} domain pricing saved — ${set} fixed, ${cleared} back to converted.`);
    res.redirect(back);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Servers
// ---------------------------------------------------------------------------
router.get('/servers', async (req, res, next) => {
  try {
    const servers = await db.query(
      `SELECT s.*, (SELECT COUNT(*) FROM services v WHERE v.server_id = s.id AND v.status <> 'terminated') AS used
         FROM servers s ORDER BY s.id`,
    );
    res.render('admin/servers', {
      title: 'Servers',
      robots: 'noindex',
      servers,
      hestiaStatus: hestia.status(),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/servers/:id', async (req, res, next) => {
  try {
    if (!guard(req, res, '/admin/servers')) return;
    await db.query(
      'UPDATE servers SET name=?, hostname=?, ip=?, api_port=?, location=?, max_accounts=?, active=?, notes=? WHERE id = ?',
      [
        field(req.body.name, 80),
        field(req.body.hostname, 190).toLowerCase(),
        field(req.body.ip, 45),
        Number(req.body.api_port) || 8083,
        field(req.body.location, 80),
        Number(req.body.max_accounts) || 200,
        req.body.active ? 1 : 0,
        field(req.body.notes, 2000),
        req.params.id,
      ],
    );
    await db.logActivity({ actorType: 'admin', actorId: req.admin.id, action: 'server.updated', target: field(req.body.hostname, 190), ip: req.ip });
    flash(res, 'Server saved.');
    res.redirect('/admin/servers');
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------
router.get('/tickets', async (req, res, next) => {
  try {
    const status = field(req.query.status, 20);
    const where = status ? 'WHERE t.status = ?' : "WHERE t.status <> 'closed'";
    const params = status ? [status] : [];
    const tickets = await db.query(
      `SELECT t.*, c.email, c.first_name, c.last_name FROM tickets t
         JOIN customers c ON c.id = t.customer_id ${where}
        ORDER BY FIELD(t.priority,'high','normal','low'), t.updated_at DESC LIMIT 100`,
      params,
    );
    res.render('admin/tickets', { title: 'Tickets', robots: 'noindex', tickets, status });
  } catch (err) {
    next(err);
  }
});

router.get('/tickets/:id', async (req, res, next) => {
  try {
    const ticket = await db.one(
      `SELECT t.*, c.email, c.first_name, c.last_name, c.id AS customer_id
         FROM tickets t JOIN customers c ON c.id = t.customer_id WHERE t.id = ? LIMIT 1`,
      [req.params.id],
    );
    if (!ticket) return next();
    const messages = await db.query('SELECT * FROM ticket_messages WHERE ticket_id = ? ORDER BY created_at ASC', [ticket.id]);
    res.render('admin/ticket', { title: ticket.subject, robots: 'noindex', ticket, messages });
  } catch (err) {
    next(err);
  }
});

router.post('/tickets/:id/reply', async (req, res, next) => {
  try {
    const back = `/admin/tickets/${req.params.id}`;
    if (!guard(req, res, back)) return;

    const ticket = await db.one(
      `SELECT t.*, c.email, c.first_name FROM tickets t JOIN customers c ON c.id = t.customer_id
        WHERE t.id = ? LIMIT 1`,
      [req.params.id],
    );
    if (!ticket) return next();

    const body = field(req.body.body, 20_000);
    const close = Boolean(req.body.close);

    if (body.length >= 2) {
      await db.query(
        'INSERT INTO ticket_messages (ticket_id, author, author_name, body) VALUES (?, ?, ?, ?)',
        [ticket.id, 'staff', req.admin.name || 'Vesopa Hosting', body],
      );
      sendMail({
        to: ticket.email,
        subject: `[${ticket.reference}] Re: ${ticket.subject}`,
        html: shell({
          title: 'We have replied to your ticket',
          intro: `Hello ${escapeHtml(ticket.first_name || 'there')} — here is our reply.`,
          bodyHtml: `<p style="margin:0;font-size:14px;line-height:1.65;white-space:pre-wrap">${escapeHtml(body)}</p>`,
          ctaText: 'Reply in your panel',
          ctaUrl: `${res.locals.siteUrl}/panel/tickets/${ticket.id}`,
        }),
      });
    }

    await db.query('UPDATE tickets SET status = ?, updated_at = NOW() WHERE id = ?', [
      close ? 'closed' : 'answered',
      ticket.id,
    ]);
    await db.logActivity({
      actorType: 'admin', actorId: req.admin.id,
      action: close ? 'ticket.closed' : 'ticket.answered', target: ticket.reference, ip: req.ip,
    });

    flash(res, close ? 'Replied and closed.' : 'Reply sent.');
    res.redirect(back);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Enquiries
// ---------------------------------------------------------------------------
router.get('/enquiries', async (req, res, next) => {
  try {
    const enquiries = await db.query('SELECT * FROM enquiries ORDER BY created_at DESC LIMIT 200');
    res.render('admin/enquiries', { title: 'Enquiries', robots: 'noindex', enquiries });
  } catch (err) {
    next(err);
  }
});

router.post('/enquiries/:id/handled', async (req, res, next) => {
  try {
    if (!guard(req, res, '/admin/enquiries')) return;
    await db.query('UPDATE enquiries SET handled = 1 - handled WHERE id = ?', [req.params.id]);
    res.redirect('/admin/enquiries');
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Settings and log
// ---------------------------------------------------------------------------
router.get('/settings', async (req, res, next) => {
  try {
    const settings = await db.settings({ fresh: true });
    const admins = await db.query('SELECT id, email, name, role, active, last_login_at FROM hosting_admins ORDER BY id');

    /*
     * The reseller balance, because a zero balance is a silent killer: every
     * availability search keeps working perfectly, and every registration fails
     * at the moment a customer has already paid us. Worth a second on a page
     * nobody loads often.
     *
     * Never allowed to break the page — a registrar having a bad afternoon must
     * not take the settings screen down with it.
     */
    const balance = await registrar.balance().catch((err) => ({ ok: false, error: err.message }));

    res.render('admin/settings', {
      title: 'Settings',
      robots: 'noindex',
      settings,
      admins,
      registrarStatus: registrar.status(),
      registrarBalance: balance,
      hestiaStatus: hestia.status(),
      geoStatus: geo.status(),
      // VAT lives on the currency row now, so the settings page points at the
      // screen that owns it rather than printing a number it cannot change.
      currencies: (await currency.load({ includeInactive: true })).all,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/settings', async (req, res, next) => {
  try {
    if (!guard(req, res, '/admin/settings')) return;
    const allowed = ['company_name', 'support_email', 'support_phone', 'address', 'vat_number', 'announcement', 'money_back_days', 'uptime_promise'];
    for (const name of allowed) {
      if (req.body[name] === undefined) continue;
      await db.query(
        'INSERT INTO settings (name, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)',
        [name, field(req.body[name], 2000)],
      );
    }
    db.invalidateSettings();
    flash(res, 'Settings saved.');
    res.redirect('/admin/settings');
  } catch (err) {
    next(err);
  }
});

router.post('/settings/admins', async (req, res, next) => {
  try {
    if (!guard(req, res, '/admin/settings')) return;
    // Only an owner can mint another member of staff.
    if (req.admin.role !== 'owner') {
      flash(res, 'Only an owner can add staff.', 'error');
      return res.redirect('/admin/settings');
    }

    const email = field(req.body.email, 190).toLowerCase();
    const name = field(req.body.name, 120);
    const password = String(req.body.password || '');
    const role = ['admin', 'support'].includes(req.body.role) ? req.body.role : 'support';

    if (!isEmail(email)) {
      flash(res, 'That email address does not look right.', 'error');
      return res.redirect('/admin/settings');
    }
    const problem = auth.passwordProblem(password);
    if (problem) {
      flash(res, problem, 'error');
      return res.redirect('/admin/settings');
    }

    const hash = await auth.hashPassword(password);
    await db.query(
      'INSERT INTO hosting_admins (email, name, password_hash, role) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE active = 1',
      [email, name, hash, role],
    );
    await db.logActivity({ actorType: 'admin', actorId: req.admin.id, action: 'admin.created', target: email, ip: req.ip });
    flash(res, `${email} added as ${role}.`);
    res.redirect('/admin/settings');
  } catch (err) {
    next(err);
  }
});

router.get('/log', async (req, res, next) => {
  try {
    const { page, perPage, offset } = paging(req, { perPage: 60 });
    const entries = await db.query('SELECT * FROM activity_log ORDER BY created_at DESC LIMIT ? OFFSET ?', [perPage, offset]);
    const [{ total }] = await db.query('SELECT COUNT(*) AS total FROM activity_log');
    res.render('admin/log', { title: 'Activity log', robots: 'noindex', entries, page, perPage, total });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
