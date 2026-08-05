/**
 * Offices: the customer record, the subscription, and the chase.
 *
 * `offices` is the billing source of truth. subscriptions/subscription_invoices
 * exist in the schema but no office has ever had a row in either, and keeping
 * two places that both claim to know when an account renews is how a customer
 * gets chased for money they have paid. Everything here reads and writes
 * offices.* plus the office_payments ledger.
 *
 * The rule that shapes the whole screen: **an expiry never disables anything.**
 * There is no code path here that sets status='paused' because a date passed.
 * Lapsing produces a row in a list, a red badge and a pre-written email — a
 * human decides what happens next.
 */

const express = require('express');
const { pool, transaction } = require('../db');
const { sendMail } = require('../mailer');
const { renderRenewalReminder, defaultReminderBody } = require('../emails/renewal-reminder');
const {
  money, moneyShort, fromMinor, toMinor, formatDate, formatDateTime, isoDate,
  addMonths, today, subscriptionState, EXPIRING_WINDOW_DAYS,
  back, readFlash, navCounts, str, int,
} = require('./util');

const router = express.Router();

const OFFICE_COLUMNS = `id, name, contact_email, contact_name, contact_phone, status,
  plan, monthly_fee_minor, term_months, billing_day, next_due_on, trial_ends_on,
  is_demo, notes, reminded_at, paused_at, pause_reason, created_at`;

/** Plans the admin can put an office on, newest pricing first. */
async function livePlans() {
  const [rows] = await pool.query(
    `SELECT slug, name, period_months, price_per_month_minor, total_minor,
            discounted_minor, total_with_vat_minor, currency
     FROM web_plans
     WHERE is_archived = 0
     ORDER BY sort_order, period_months`
  );
  return rows;
}

// ---- List -----------------------------------------------------------------

router.get('/offices', async (req, res, next) => {
  try {
    const filter = String(req.query.filter || 'all');
    const q = str(req.query.q, 120);

    const where = [];
    const params = [];

    if (q) {
      where.push('(o.name LIKE ? OR o.contact_email LIKE ? OR o.contact_phone LIKE ?)');
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }

    if (filter === 'attention') {
      where.push(`o.status = 'active' AND o.next_due_on IS NOT NULL
                  AND o.next_due_on <= DATE_ADD(CURDATE(), INTERVAL ? DAY)`);
      params.push(EXPIRING_WINDOW_DAYS);
    } else if (filter === 'overdue') {
      where.push(`o.status = 'active' AND o.next_due_on IS NOT NULL AND o.next_due_on < CURDATE()`);
    } else if (filter === 'trial') {
      where.push(`o.trial_ends_on IS NOT NULL AND o.trial_ends_on >= CURDATE()`);
    } else if (filter === 'paused') {
      where.push(`o.status = 'paused'`);
    } else if (filter === 'archived') {
      where.push(`o.status = 'archived'`);
    } else if (filter === 'all') {
      // Archived accounts are history; they clutter the default list.
      where.push(`o.status <> 'archived'`);
    }

    const [rows] = await pool.query(
      `SELECT ${OFFICE_COLUMNS.split(',').map((c) => `o.${c.trim()}`).join(', ')},
              (SELECT COUNT(*) FROM backoffice_users u WHERE u.office_id = o.id) AS users,
              (SELECT COUNT(*) FROM bo_clarks c WHERE c.email = o.contact_email) AS clerks,
              (SELECT COALESCE(SUM(p.amount_minor), 0) FROM office_payments p
                WHERE p.office_id = o.id) AS collected_minor,
              (SELECT MAX(p.paid_on) FROM office_payments p WHERE p.office_id = o.id) AS last_paid_on
       FROM offices o
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY (o.next_due_on IS NULL), o.next_due_on ASC, o.name ASC`,
      params
    );

    res.render('admin/offices', {
      title: 'Offices & Billing | Vesopa Admin',
      heading: 'Offices & Billing',
      nav: 'offices',
      counts: await navCounts(),
      flash: readFlash(req),
      rows: rows.map((o) => ({ ...o, state: subscriptionState(o) })),
      filter,
      q,
      plans: await livePlans(),
      money, moneyShort, formatDate, fromMinor, isoDate, today, addMonths,
    });
  } catch (e) {
    next(e);
  }
});

// ---- Detail ---------------------------------------------------------------

router.get('/offices/:id', async (req, res, next) => {
  const id = int(req.params.id, 0);
  if (!id) return back(res, '/admin/offices', { err: 'Unknown office.' });

  try {
    const [[office]] = await pool.query(`SELECT ${OFFICE_COLUMNS} FROM offices WHERE id = ?`, [id]);
    if (!office) return back(res, '/admin/offices', { err: 'That office no longer exists.' });

    const [users, clerks, payments, log, tills, plans] = await Promise.all([
      pool.query(
        `SELECT id, email, name, company, approved, role, timeadded
         FROM backoffice_users WHERE office_id = ? OR email = ? ORDER BY id`,
        [id, office.contact_email]
      ).then((r) => r[0]),

      pool.query(
        `SELECT id, clark_name, pluid, timeadded FROM bo_clarks WHERE email = ? ORDER BY pluid`,
        [office.contact_email]
      ).then((r) => r[0]),

      pool.query(
        `SELECT id, amount_minor, currency, paid_on, method, reference,
                period_start, period_end, plan_slug, note, recorded_by
         FROM office_payments WHERE office_id = ? ORDER BY paid_on DESC, id DESC`,
        [id]
      ).then((r) => r[0]),

      pool.query(
        `SELECT id, kind, subject, body, outcome, admin_name, created_at
         FROM office_contact_log WHERE office_id = ? ORDER BY created_at DESC LIMIT 40`,
        [id]
      ).then((r) => r[0]),

      // What the tills under this office have actually done. The office's email
      // is the tenant key epos_orders was built around.
      pool.query(
        `SELECT COUNT(*) AS orders,
                COALESCE(SUM(total_minor), 0) AS gross_minor,
                MAX(created_at) AS last_order_at,
                COALESCE(SUM(CASE WHEN created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
                                  THEN total_minor END), 0) AS gross_30_minor
         FROM epos_orders WHERE email = ?`,
        [office.contact_email]
      ).then((r) => r[0][0]),

      livePlans(),
    ]);

    const state = subscriptionState(office);
    const plan = plans.find((p) => p.slug === office.plan) || null;

    // The amount the renewal email quotes: the plan's term price if the office
    // is on a plan, otherwise the monthly fee times the term.
    const dueMinor = plan
      ? plan.discounted_minor || plan.total_minor
      : Number(office.monthly_fee_minor || 0) * Number(office.term_months || 1);

    res.render('admin/office-detail', {
      title: `${office.name} | Vesopa Admin`,
      heading: office.name,
      nav: 'offices',
      counts: await navCounts(),
      flash: readFlash(req),

      office,
      state,
      plan,
      plans,
      dueMinor,
      users,
      clerks,
      payments,
      log,
      tills,
      collected: payments.reduce((a, p) => a + Number(p.amount_minor), 0),

      draftBody: defaultReminderBody({
        officeName: office.name,
        dueLabel: formatDate(office.next_due_on),
        days: state.days,
        amount: money(dueMinor),
      }),

      money, moneyShort, fromMinor, formatDate, formatDateTime, isoDate, today, addMonths,
    });
  } catch (e) {
    next(e);
  }
});

// ---- Create ---------------------------------------------------------------

router.post('/offices/new', async (req, res, next) => {
  const name = str(req.body.name, 255);
  const email = str(req.body.contact_email, 255).toLowerCase();

  if (!name || !email.includes('@')) {
    return back(res, '/admin/offices', { err: 'An office needs a name and a valid email.' });
  }

  try {
    const plans = await livePlans();
    const plan = plans.find((p) => p.slug === str(req.body.plan, 64)) || null;
    const term = int(req.body.term_months, plan ? plan.period_months : 3) || 3;

    await pool.query(
      `INSERT INTO offices
         (name, contact_email, contact_name, contact_phone, status, plan,
          monthly_fee_minor, term_months, next_due_on, trial_ends_on, is_demo, notes)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)`,
      [
        name,
        email,
        str(req.body.contact_name, 255) || null,
        str(req.body.contact_phone, 64) || null,
        plan ? plan.slug : null,
        plan ? plan.price_per_month_minor : toMinor(req.body.monthly_fee),
        term,
        isoDate(req.body.next_due_on) || addMonths(today(), term),
        isoDate(req.body.trial_ends_on),
        req.body.is_demo ? 1 : 0,
        str(req.body.notes, 2000) || null,
      ]
    );
    back(res, '/admin/offices', { ok: `${name} added.` });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') {
      return back(res, '/admin/offices', {
        err: `An office is already registered against ${email}.`,
      });
    }
    next(e);
  }
});

// ---- Edit -----------------------------------------------------------------

router.post('/offices/:id', async (req, res, next) => {
  const id = int(req.params.id, 0);
  if (!id) return back(res, '/admin/offices', { err: 'Unknown office.' });

  try {
    const plans = await livePlans();
    const slug = str(req.body.plan, 64);
    const plan = plans.find((p) => p.slug === slug) || null;

    const status = ['active', 'paused', 'archived'].includes(req.body.status)
      ? req.body.status
      : 'active';

    // Only stamp paused_at on the transition, so re-saving a paused office does
    // not keep moving the date it was paused.
    const [[before]] = await pool.query('SELECT status FROM offices WHERE id = ?', [id]);
    if (!before) return back(res, '/admin/offices', { err: 'That office no longer exists.' });

    const pausing = status === 'paused' && before.status !== 'paused';

    await pool.query(
      `UPDATE offices SET
         name = ?, contact_email = ?, contact_name = ?, contact_phone = ?,
         status = ?, plan = ?, monthly_fee_minor = ?, term_months = ?,
         next_due_on = ?, trial_ends_on = ?, is_demo = ?, notes = ?,
         -- Stamped on the transition into paused, cleared on the way out, and
         -- left alone while it stays paused: re-saving the form must not keep
         -- moving the date the account was suspended.
         paused_at = CASE WHEN ? THEN NOW()
                          WHEN ? THEN paused_at
                          ELSE NULL END,
         pause_reason = ?
       WHERE id = ?`,
      [
        str(req.body.name, 255),
        str(req.body.contact_email, 255).toLowerCase(),
        str(req.body.contact_name, 255) || null,
        str(req.body.contact_phone, 64) || null,
        status,
        plan ? plan.slug : null,
        // An explicit fee wins over the plan's, so a legacy price can be
        // honoured without inventing a one-off plan for it.
        req.body.monthly_fee !== undefined && str(req.body.monthly_fee)
          ? toMinor(req.body.monthly_fee)
          : plan
            ? plan.price_per_month_minor
            : 0,
        int(req.body.term_months, plan ? plan.period_months : 3) || 3,
        isoDate(req.body.next_due_on),
        isoDate(req.body.trial_ends_on),
        req.body.is_demo ? 1 : 0,
        str(req.body.notes, 2000) || null,
        pausing ? 1 : 0,
        status === 'paused' ? 1 : 0,
        status === 'paused' ? str(req.body.pause_reason, 255) || null : null,
        id,
      ]
    );

    back(res, `/admin/offices/${id}`, { ok: 'Saved.' });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') {
      return back(res, `/admin/offices/${id}`, {
        err: 'Another office already uses that email address.',
      });
    }
    next(e);
  }
});

// ---- Record a payment -----------------------------------------------------

/**
 * Money in, and — if the admin ticks the box — the renewal date moved forward.
 *
 * One transaction: a payment recorded against an account whose next_due_on
 * silently failed to advance is an account that gets chased next week for
 * money it has already handed over.
 */
router.post('/offices/:id/payment', async (req, res, next) => {
  const id = int(req.params.id, 0);
  if (!id) return back(res, '/admin/offices', { err: 'Unknown office.' });

  const amountMinor = toMinor(req.body.amount);
  if (amountMinor <= 0) {
    return back(res, `/admin/offices/${id}`, { err: 'Enter an amount greater than zero.' });
  }

  const method = ['bank', 'card', 'paypal', 'cash', 'cheque', 'other'].includes(req.body.method)
    ? req.body.method
    : 'bank';

  try {
    await transaction(async (conn) => {
      const [[office]] = await conn.query(
        'SELECT id, plan, term_months, next_due_on FROM offices WHERE id = ? FOR UPDATE',
        [id]
      );
      if (!office) return;

      const term = int(office.term_months, 3) || 3;
      // The term this money buys starts where the last one ended, not today —
      // paying a week late should not push every future renewal a week later.
      const periodStart = isoDate(office.next_due_on) || today();
      const periodEnd = addMonths(periodStart, term);

      await conn.query(
        `INSERT INTO office_payments
           (office_id, amount_minor, paid_on, method, reference,
            period_start, period_end, plan_slug, note, recorded_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          amountMinor,
          isoDate(req.body.paid_on) || today(),
          method,
          str(req.body.reference, 120) || null,
          periodStart,
          periodEnd,
          office.plan || null,
          str(req.body.note, 500) || null,
          req.admin.fullname || req.admin.username,
        ]
      );

      if (req.body.advance) {
        await conn.query(
          'UPDATE offices SET next_due_on = ?, reminded_at = NULL WHERE id = ?',
          [periodEnd, id]
        );
      }
    });

    back(res, `/admin/offices/${id}`, {
      ok: req.body.advance
        ? `Payment recorded and the renewal date moved on.`
        : 'Payment recorded.',
    });
  } catch (e) {
    next(e);
  }
});

router.post('/offices/:id/payment/:paymentId/delete', async (req, res, next) => {
  const id = int(req.params.id, 0);
  try {
    await pool.query('DELETE FROM office_payments WHERE id = ? AND office_id = ?', [
      int(req.params.paymentId, 0),
      id,
    ]);
    back(res, `/admin/offices/${id}`, { ok: 'Payment removed from the ledger.' });
  } catch (e) {
    next(e);
  }
});

// ---- Renew without a payment ----------------------------------------------

/** Extend the term by hand: a goodwill month, a comped account, a correction. */
router.post('/offices/:id/extend', async (req, res, next) => {
  const id = int(req.params.id, 0);
  const months = Math.max(1, Math.min(36, int(req.body.months, 3)));

  try {
    const [[office]] = await pool.query('SELECT next_due_on FROM offices WHERE id = ?', [id]);
    if (!office) return back(res, '/admin/offices', { err: 'Unknown office.' });

    // From today if the term already lapsed, so "extend 3 months" means three
    // months of cover from now rather than three months from a date in the past.
    const from = isoDate(office.next_due_on);
    const base = !from || from < today() ? today() : from;

    await pool.query('UPDATE offices SET next_due_on = ?, reminded_at = NULL WHERE id = ?', [
      addMonths(base, months),
      id,
    ]);
    back(res, `/admin/offices/${id}`, { ok: `Extended by ${months} month${months === 1 ? '' : 's'}.` });
  } catch (e) {
    next(e);
  }
});

// ---- The chase ------------------------------------------------------------

/**
 * Send the renewal email, and write down that it went.
 *
 * The send is awaited — unlike the enquiry notifications, which are fire and
 * forget — because the admin needs to know whether to pick the phone up
 * instead. A failure is logged as a failure, not swallowed.
 */
router.post('/offices/:id/remind', async (req, res, next) => {
  const id = int(req.params.id, 0);

  try {
    const [[office]] = await pool.query(
      `SELECT id, name, contact_email, contact_name, contact_phone, plan,
              monthly_fee_minor, term_months, next_due_on, trial_ends_on, status
       FROM offices WHERE id = ?`,
      [id]
    );
    if (!office) return back(res, '/admin/offices', { err: 'Unknown office.' });

    const state = subscriptionState(office);
    const [[plan]] = await pool.query(
      'SELECT name, discounted_minor, total_minor FROM web_plans WHERE slug = ?',
      [office.plan || '']
    );

    const dueMinor = plan
      ? plan.discounted_minor || plan.total_minor
      : Number(office.monthly_fee_minor || 0) * Number(office.term_months || 1);

    const subject =
      str(req.body.subject, 255) ||
      `Your Vesopa EPOS subscription — ${office.name}`;
    const body =
      str(req.body.body, 6000) ||
      defaultReminderBody({
        officeName: office.name,
        dueLabel: formatDate(office.next_due_on),
        days: state.days,
        amount: money(dueMinor),
      });

    let outcome = 'sent';
    let flash = { ok: `Reminder emailed to ${office.contact_email}.` };

    try {
      await sendMail({
        to: office.contact_email,
        subject,
        html: renderRenewalReminder({
          officeName: office.name,
          contactName: office.contact_name,
          dueLabel: formatDate(office.next_due_on),
          days: state.days,
          amount: money(dueMinor),
          planName: plan ? plan.name : office.plan,
          body,
        }),
      });
    } catch (mailError) {
      console.error('[admin] renewal reminder failed', mailError);
      outcome = 'failed';
      flash = {
        err: `Could not send to ${office.contact_email}. Ring them on ${
          office.contact_phone || 'the number on file'
        } instead — the failure is logged below.`,
      };
    }

    await pool.query(
      `INSERT INTO office_contact_log (office_id, kind, subject, body, outcome, admin_name)
       VALUES (?, 'email', ?, ?, ?, ?)`,
      [id, subject, body, outcome, req.admin.fullname || req.admin.username]
    );

    // Acknowledged either way: a failed send is still an attempt, and the log
    // entry is what stops the next admin repeating it blind.
    await pool.query('UPDATE offices SET reminded_at = NOW() WHERE id = ?', [id]);

    back(res, `/admin/offices/${id}`, flash);
  } catch (e) {
    next(e);
  }
});

/** "I rang them" / "I emailed them myself" / a note. */
router.post('/offices/:id/log', async (req, res, next) => {
  const id = int(req.params.id, 0);
  const kind = ['email', 'call', 'note'].includes(req.body.kind) ? req.body.kind : 'note';
  const body = str(req.body.body, 4000);

  if (!body) return back(res, `/admin/offices/${id}`, { err: 'Nothing to log.' });

  try {
    await pool.query(
      `INSERT INTO office_contact_log (office_id, kind, subject, body, outcome, admin_name)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        id,
        kind,
        str(req.body.subject, 255) || null,
        body,
        kind === 'call' ? str(req.body.outcome, 32) || 'spoke' : null,
        req.admin.fullname || req.admin.username,
      ]
    );
    await pool.query('UPDATE offices SET reminded_at = NOW() WHERE id = ?', [id]);
    back(res, `/admin/offices/${id}`, { ok: 'Logged.' });
  } catch (e) {
    next(e);
  }
});

// ---- Collection ledger ----------------------------------------------------

router.get('/collection', async (req, res, next) => {
  try {
    // Default to the calendar year, which is the window the question is
    // usually asked in.
    const from = isoDate(req.query.from) || `${new Date().getFullYear()}-01-01`;
    const to = isoDate(req.query.to) || today();

    const [rows, [totals], byMonth, byMethod, outstanding] = await Promise.all([
      pool.query(
        `SELECT p.*, o.name AS office_name, o.contact_email
         FROM office_payments p
         JOIN offices o ON o.id = p.office_id
         WHERE p.paid_on BETWEEN ? AND ?
         ORDER BY p.paid_on DESC, p.id DESC
         LIMIT 500`,
        [from, to]
      ).then((r) => r[0]),

      pool.query(
        `SELECT COALESCE(SUM(amount_minor), 0) AS total_minor, COUNT(*) AS n,
                COUNT(DISTINCT office_id) AS offices
         FROM office_payments WHERE paid_on BETWEEN ? AND ?`,
        [from, to]
      ).then((r) => r[0]),

      pool.query(
        `SELECT DATE_FORMAT(paid_on, '%Y-%m') AS month,
                COALESCE(SUM(amount_minor), 0) AS amount_minor, COUNT(*) AS n
         FROM office_payments WHERE paid_on BETWEEN ? AND ?
         GROUP BY month ORDER BY month`,
        [from, to]
      ).then((r) => r[0]),

      pool.query(
        `SELECT method, COALESCE(SUM(amount_minor), 0) AS amount_minor, COUNT(*) AS n
         FROM office_payments WHERE paid_on BETWEEN ? AND ?
         GROUP BY method ORDER BY amount_minor DESC`,
        [from, to]
      ).then((r) => r[0]),

      // What is owed but not in: the gap between the ledger and the plan.
      pool.query(
        `SELECT o.id, o.name, o.contact_email, o.contact_phone, o.next_due_on,
                o.term_months, o.monthly_fee_minor, o.plan,
                COALESCE(p.discounted_minor, p.total_minor,
                         o.monthly_fee_minor * o.term_months) AS due_minor
         FROM offices o
         LEFT JOIN web_plans p ON p.slug = o.plan
         WHERE o.status = 'active'
           AND o.next_due_on IS NOT NULL
           AND o.next_due_on < CURDATE()
         ORDER BY o.next_due_on`
      ).then((r) => r[0]),
    ]);

    res.render('admin/collection', {
      title: 'Collection | Vesopa Admin',
      heading: 'Collection',
      nav: 'collection',
      counts: await navCounts(),
      flash: readFlash(req),
      rows, totals, byMonth, byMethod, outstanding,
      from, to,
      money, moneyShort, formatDate,
    });
  } catch (e) {
    next(e);
  }
});

/** The ledger as CSV, for the accountant. */
router.get('/collection.csv', async (req, res, next) => {
  try {
    const from = isoDate(req.query.from) || `${new Date().getFullYear()}-01-01`;
    const to = isoDate(req.query.to) || today();

    const [rows] = await pool.query(
      `SELECT p.paid_on, o.name AS office, o.contact_email, p.amount_minor, p.currency,
              p.method, p.reference, p.period_start, p.period_end, p.plan_slug,
              p.note, p.recorded_by
       FROM office_payments p JOIN offices o ON o.id = p.office_id
       WHERE p.paid_on BETWEEN ? AND ?
       ORDER BY p.paid_on, p.id`,
      [from, to]
    );

    // Excel reads a leading = or + in a cell as a formula, so any value that
    // starts with one is prefixed with a quote.
    const cell = (v) => {
      if (v == null) return '';
      let s = String(v);
      if (/^[=+\-@]/.test(s)) s = `'${s}`;
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const header = [
      'paid_on', 'office', 'email', 'amount', 'currency', 'method', 'reference',
      'period_start', 'period_end', 'plan', 'note', 'recorded_by',
    ];

    const body = rows.map((r) =>
      [
        isoDate(r.paid_on), r.office, r.contact_email,
        (r.amount_minor / 100).toFixed(2), r.currency, r.method, r.reference,
        isoDate(r.period_start), isoDate(r.period_end), r.plan_slug, r.note, r.recorded_by,
      ].map(cell).join(',')
    );

    res.type('text/csv').set(
      'Content-Disposition',
      `attachment; filename="vesopa-collection-${from}-to-${to}.csv"`
    ).send([header.join(','), ...body].join('\n'));
  } catch (e) {
    next(e);
  }
});

module.exports = { officesRouter: router };
