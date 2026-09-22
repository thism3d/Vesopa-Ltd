/**
 * Everything the public forms submit: demo requests, support messages, training
 * bookings and job applications.
 *
 * One config table, one template. The PHP panel had four copies of the same
 * screen with the column names swapped, which is why the training screen never
 * grew the search the messages screen had.
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const { pool, transaction } = require('../db');
const { sendMail } = require('../mailer');
const { renderAccountApproved } = require('../emails/account-approved');
const {
  formatDate, formatDateTime, back, readFlash, navCounts, str, int,
} = require('./util');

const router = express.Router();

const SCREENS = {
  demo: {
    nav: 'demo',
    table: 'demo_request',
    heading: 'Demo Requests',
    columns: `timeadded, id, name, email, phone, business_name, business_brief, approved`,
    search: ['name', 'email', 'phone', 'business_name'],
    fields: [
      { label: 'Business', key: 'business_name' },
      { label: 'Email', key: 'email', type: 'email' },
      { label: 'Phone', key: 'phone', type: 'tel' },
      { label: 'Received', key: 'timeadded', type: 'datetime' },
    ],
    body: 'business_brief',
    approvable: true,
  },
  messages: {
    nav: 'messages',
    table: 'customer_message',
    heading: 'Support Messages',
    columns: `timeadded, id, name, email, phone, message, comment`,
    search: ['name', 'email', 'phone', 'message'],
    fields: [
      { label: 'Email', key: 'email', type: 'email' },
      { label: 'Phone', key: 'phone', type: 'tel' },
      { label: 'Received', key: 'timeadded', type: 'datetime' },
    ],
    body: 'message',
  },
  training: {
    nav: 'training',
    table: 'training_request',
    heading: 'Training Requests',
    columns: `timeadded, id, name, email, phone, company, booking_time, message`,
    search: ['name', 'email', 'phone', 'company'],
    fields: [
      { label: 'Company', key: 'company' },
      { label: 'Email', key: 'email', type: 'email' },
      { label: 'Phone', key: 'phone', type: 'tel' },
      { label: 'Wants', key: 'booking_time', type: 'datetime' },
      { label: 'Received', key: 'timeadded', type: 'datetime' },
    ],
    body: 'message',
  },
  job: {
    nav: 'job',
    table: 'career_request',
    heading: 'Job Applications',
    columns: `timeadded, id, name, email, phone, company, description`,
    search: ['name', 'email', 'phone', 'company'],
    fields: [
      { label: 'Applying for', key: 'company' },
      { label: 'Email', key: 'email', type: 'email' },
      { label: 'Phone', key: 'phone', type: 'tel' },
      { label: 'Received', key: 'timeadded', type: 'datetime' },
    ],
    body: 'description',
  },
};

router.get('/requests/:screen', async (req, res, next) => {
  const screen = SCREENS[req.params.screen];
  if (!screen) return back(res, '/admin/dashboard', { err: 'Unknown screen.' });

  try {
    const q = str(req.query.q, 120);
    // Only meaningful on the demo screen, where a row can be pending or done.
    const state = ['pending', 'done'].includes(req.query.state) ? req.query.state : '';

    const where = [];
    const params = [];

    if (q) {
      where.push(`(${screen.search.map((c) => `${c} LIKE ?`).join(' OR ')})`);
      screen.search.forEach(() => params.push(`%${q}%`));
    }
    if (screen.approvable && state) {
      where.push('approved = ?');
      params.push(state === 'pending' ? 'N' : 'Y');
    }

    const [rows] = await pool.query(
      `SELECT ${screen.columns} FROM ${screen.table}
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY id DESC LIMIT 500`,
      params
    );

    res.render('admin/requests', {
      title: `${screen.heading} | Vesopa Admin`,
      heading: screen.heading,
      nav: screen.nav,
      counts: await navCounts(),
      flash: readFlash(req),
      screen,
      screenKey: req.params.screen,
      rows, q, state,
      formatDate, formatDateTime,
    });
  } catch (e) {
    next(e);
  }
});

router.post('/requests/:screen/:id/delete', async (req, res, next) => {
  const screen = SCREENS[req.params.screen];
  if (!screen) return back(res, '/admin/dashboard', { err: 'Unknown screen.' });

  try {
    // The table name is looked up from SCREENS, never taken from the URL — the
    // param only selects which entry to use.
    await pool.query(`DELETE FROM ${screen.table} WHERE id = ?`, [int(req.params.id, 0)]);
    back(res, `/admin/requests/${req.params.screen}`, { ok: 'Deleted.' });
  } catch (e) {
    next(e);
  }
});

/**
 * Approve a demo request: mark it done, create or re-enable the back office
 * login, register the office if it is new, and email them.
 *
 * One transaction. The PHP ran the writes separately, so a failure part-way
 * left a request flagged approved with no login behind it — and the customer
 * had an email telling them to sign in.
 */
router.post('/requests/demo/:id/approve', async (req, res, next) => {
  const id = int(req.params.id, 0);
  const password = String(req.body.password || '');

  if (password.length < 8) {
    return back(res, '/admin/requests/demo', { err: 'The password must be at least 8 characters.' });
  }

  try {
    const result = await transaction(async (conn) => {
      const [[request]] = await conn.query(
        `SELECT id, name, email, phone, business_name FROM demo_request
         WHERE approved = 'N' AND id = ?`,
        [id]
      );
      if (!request) return null;

      const { name, email, phone, business_name: company } = request;
      await conn.query(`UPDATE demo_request SET approved = 'Y' WHERE id = ?`, [id]);

      // The office is the billing record. Created here so a newly approved
      // customer appears on the subscription screens straight away rather than
      // being invisible until someone notices.
      const [[plan]] = await conn.query(
        `SELECT slug, period_months, price_per_month_minor FROM web_plans
         WHERE is_default = 1 AND is_archived = 0 LIMIT 1`
      );
      const term = plan ? plan.period_months : 3;

      await conn.query(
        `INSERT INTO offices (name, contact_email, contact_name, contact_phone, status,
                              term_months, next_due_on, plan, monthly_fee_minor, trial_ends_on)
         VALUES (?, ?, ?, ?, 'active', ?, DATE_ADD(CURDATE(), INTERVAL ? MONTH), ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           name = VALUES(name),
           -- COALESCE the other way round: an admin who has already typed a
           -- contact name or number should not lose it to the form's values.
           contact_name  = COALESCE(contact_name,  VALUES(contact_name)),
           contact_phone = COALESCE(contact_phone, VALUES(contact_phone)),
           status = 'active'`,
        [
          company || name,
          email,
          name,
          phone || null,
          term,
          term,
          plan ? plan.slug : null,
          plan ? plan.price_per_month_minor : 0,
          req.body.trial ? new Date(Date.now() + 14 * 86400000) : null,
        ]
      );

      const [[office]] = await conn.query('SELECT id FROM offices WHERE contact_email = ?', [email]);

      // One statement covers "new business" and "returning business we had
      // disabled". As a SELECT-then-branch it was a race that could insert a
      // duplicate under two concurrent approvals.
      await conn.query(
        `INSERT INTO backoffice_users (email, password, name, company, approved, office_id)
         VALUES (?, ?, ?, ?, 'Y', ?)
         ON DUPLICATE KEY UPDATE password = VALUES(password), approved = 'Y',
                                 name = VALUES(name), company = VALUES(company),
                                 office_id = COALESCE(backoffice_users.office_id, VALUES(office_id))`,
        [email, await bcrypt.hash(password, 12), name, company, office ? office.id : null]
      );

      return { email, name };
    });

    if (!result) {
      return back(res, '/admin/requests/demo', { err: 'That request has already been handled.' });
    }

    // The plaintext password exists only on this request; the column holds a
    // bcrypt hash, so the mail has to be built here.
    sendMail({
      to: result.email,
      subject: 'Your Account Has Been Approved - Expand With Vesopa EPOS',
      html: renderAccountApproved({ email: result.email, password }),
    });

    back(res, '/admin/offices', {
      ok: `${result.name} approved — office registered and the login emailed to ${result.email}.`,
    });
  } catch (e) {
    next(e);
  }
});

module.exports = { requestsRouter: router };
