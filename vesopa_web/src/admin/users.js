/**
 * Back-office logins and till sub-users.
 *
 * Two tables, two screens, because they are genuinely different things:
 *
 *   backoffice_users — an email and a bcrypt password that signs into the back
 *     office at backoffice.vesopaepos.com. role='admin' can see every office;
 *     role='office' sees its own.
 *
 *   bo_clarks — a name and a PIN typed into a till. Not a login: it identifies
 *     who rang a sale. Keyed by the office's email, which is the tenant key
 *     epos_orders and the rest of the till schema were built around.
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const { sendMail } = require('../mailer');
const { renderAccountApproved } = require('../emails/account-approved');
const {
  formatDate, formatDateTime, back, readFlash, navCounts, str, int,
} = require('./util');

const router = express.Router();

/**
 * Fill in each row's `clerks` count and `last_order_at` by matching on email.
 *
 * These were correlated subqueries — `WHERE c.email = u.email` — until that
 * turned out to be the reason this whole screen 500s on the live database.
 *
 * bo_clarks.email is utf8_general_ci and epos_orders.email is
 * utf8mb4_general_ci; those two compare happily, because MySQL widens the
 * narrower side. backoffice_users.email is the one column in the schema left on
 * utf8_unicode_ci, and general_ci against unicode_ci is not a comparison MySQL
 * will make — it is "Illegal mix of collations", a hard error. Every other
 * admin screen joins on the columns that agree, which is why this is the only
 * link in the sidebar that breaks.
 *
 * schema_admin.sql brings that column into line, but a page that works only
 * once a migration has been run is a page that breaks again the next time one
 * is missed. Comparing the addresses as parameters (which are coercible, so
 * they take the column's collation) and matching them up here cannot hit the
 * error at all, whatever collation the column ends up carrying.
 *
 * Two grouped scans rather than 2N correlated subqueries, as a side effect.
 */
async function attachEmailTotals(rows) {
  for (const row of rows) {
    row.clerks = 0;
    row.last_order_at = null;
  }

  const emails = [...new Set(rows.map((r) => r.email).filter(Boolean))];
  if (!emails.length) return;

  const [clerkCounts, lastOrders] = await Promise.all([
    pool
      .query('SELECT email, COUNT(*) AS n FROM bo_clarks WHERE email IN (?) GROUP BY email', [emails])
      .then((r) => r[0]),
    pool
      .query(
        'SELECT email, MAX(created_at) AS last_at FROM epos_orders WHERE email IN (?) GROUP BY email',
        [emails]
      )
      .then((r) => r[0]),
  ]);

  // Lowercased keys because the columns are *_ci: MySQL considers
  // Sam@shop.uk and sam@shop.uk the same address and a JS Map does not, so
  // matching case-sensitively here would quietly report zero clerks for anyone
  // whose login was typed in a different case to their till record.
  const byEmail = (list, value) => {
    const map = new Map();
    for (const r of list) map.set(String(r.email).toLowerCase(), value(r));
    return map;
  };
  const clerks = byEmail(clerkCounts, (r) => Number(r.n));
  const orders = byEmail(lastOrders, (r) => r.last_at);

  for (const row of rows) {
    const key = String(row.email || '').toLowerCase();
    row.clerks = clerks.get(key) || 0;
    row.last_order_at = orders.get(key) || null;
  }
}

// ---- Back office users ----------------------------------------------------

router.get('/users', async (req, res, next) => {
  try {
    const q = str(req.query.q, 120);
    const role = ['admin', 'office'].includes(req.query.role) ? req.query.role : '';
    const status = ['Y', 'N'].includes(req.query.status) ? req.query.status : '';

    const where = [];
    const params = [];
    if (q) {
      where.push('(u.email LIKE ? OR u.name LIKE ? OR u.company LIKE ?)');
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    if (role) { where.push('u.role = ?'); params.push(role); }
    if (status) { where.push('u.approved = ?'); params.push(status); }

    const [rows] = await pool.query(
      `SELECT u.id, u.email, u.name, u.company, u.approved, u.role, u.office_id, u.timeadded,
              o.name AS office_name, o.status AS office_status, o.next_due_on
       FROM backoffice_users u
       LEFT JOIN offices o ON o.id = u.office_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY u.id DESC`,
      params
    );

    await attachEmailTotals(rows);

    const [offices] = await pool.query(
      `SELECT id, name, contact_email FROM offices WHERE status <> 'archived' ORDER BY name`
    );

    res.render('admin/users', {
      title: 'Back Office Users | Vesopa Admin',
      heading: 'Back Office Users',
      nav: 'users',
      counts: await navCounts(),
      flash: readFlash(req),
      rows, offices, q, role, status,
      formatDate, formatDateTime,
    });
  } catch (e) {
    next(e);
  }
});

/**
 * Register a back-office login.
 *
 * Optionally creates the office to go with it, because "add a customer" is one
 * action in the admin's head and making them visit two screens to do it is how
 * a login ends up with no office_id and disappears from the billing screens.
 */
router.post('/users/new', async (req, res, next) => {
  const email = str(req.body.email, 255).toLowerCase();
  const name = str(req.body.name, 255);
  const password = String(req.body.password || '');
  const role = req.body.role === 'admin' ? 'admin' : 'office';

  if (!email.includes('@') || !name) {
    return back(res, '/admin/users', { err: 'A name and a valid email are required.' });
  }
  if (password.length < 8) {
    return back(res, '/admin/users', { err: 'The password must be at least 8 characters.' });
  }

  try {
    let officeId = int(req.body.office_id, 0) || null;

    // "New office" is the sentinel the select uses for the create-as-you-go case.
    if (req.body.office_id === 'new') {
      const [[plan]] = await pool.query(
        `SELECT slug, period_months, price_per_month_minor FROM web_plans
         WHERE is_default = 1 AND is_archived = 0 LIMIT 1`
      );
      const term = plan ? plan.period_months : 3;

      const [result] = await pool.query(
        `INSERT INTO offices (name, contact_email, contact_name, status, term_months,
                              next_due_on, plan, monthly_fee_minor)
         VALUES (?, ?, ?, 'active', ?, DATE_ADD(CURDATE(), INTERVAL ? MONTH), ?, ?)`,
        [
          str(req.body.company, 255) || name,
          email,
          name,
          term,
          term,
          plan ? plan.slug : null,
          plan ? plan.price_per_month_minor : 0,
        ]
      );
      officeId = result.insertId;
    }

    await pool.query(
      `INSERT INTO backoffice_users (email, password, name, company, approved, role, office_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         password = VALUES(password), name = VALUES(name), company = VALUES(company),
         approved = VALUES(approved), role = VALUES(role),
         office_id = COALESCE(VALUES(office_id), office_id)`,
      [
        email,
        await bcrypt.hash(password, 12),
        name,
        str(req.body.company, 255) || null,
        req.body.approved === '0' ? 'N' : 'Y',
        role,
        officeId,
      ]
    );

    if (req.body.notify) {
      // The plaintext password exists only on this request — the column holds
      // a bcrypt hash — so the mail has to be built here or not at all.
      sendMail({
        to: email,
        subject: 'Your Vesopa EPOS Back Office Account',
        html: renderAccountApproved({ email, password }),
      });
    }

    back(res, '/admin/users', {
      ok: `${name} registered${req.body.notify ? ' and emailed their details' : ''}.`,
    });
  } catch (e) {
    next(e);
  }
});

router.post('/users/:id', async (req, res, next) => {
  const id = int(req.params.id, 0);
  if (!id) return back(res, '/admin/users', { err: 'Unknown user.' });

  try {
    await pool.query(
      `UPDATE backoffice_users
       SET email = ?, name = ?, company = ?, approved = ?, role = ?, office_id = ?
       WHERE id = ?`,
      [
        str(req.body.email, 255).toLowerCase(),
        str(req.body.name, 255),
        str(req.body.company, 255) || null,
        req.body.approved === '1' ? 'Y' : 'N',
        req.body.role === 'admin' ? 'admin' : 'office',
        int(req.body.office_id, 0) || null,
        id,
      ]
    );
    back(res, '/admin/users', { ok: 'Saved.' });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') {
      return back(res, '/admin/users', { err: 'Another login already uses that email.' });
    }
    next(e);
  }
});

router.post('/users/:id/password', async (req, res, next) => {
  const id = int(req.params.id, 0);
  const password = String(req.body.password || '');

  if (password.length < 8) {
    return back(res, '/admin/users', { err: 'The password must be at least 8 characters.' });
  }

  try {
    const [[user]] = await pool.query('SELECT email, name FROM backoffice_users WHERE id = ?', [id]);
    if (!user) return back(res, '/admin/users', { err: 'Unknown user.' });

    await pool.query('UPDATE backoffice_users SET password = ? WHERE id = ?', [
      await bcrypt.hash(password, 12),
      id,
    ]);

    if (req.body.notify) {
      sendMail({
        to: user.email,
        subject: 'Your Vesopa EPOS Back Office Password Has Changed',
        html: renderAccountApproved({ email: user.email, password }),
      });
    }

    back(res, '/admin/users', {
      ok: `Password reset for ${user.name}${req.body.notify ? ' and emailed to them' : ''}.`,
    });
  } catch (e) {
    next(e);
  }
});

/**
 * Turn a login off.
 *
 * Not a delete: the office's orders, products and clerks are all keyed by this
 * email, and removing the row would leave that data unreachable through the
 * back office while still sitting in the database.
 */
router.post('/users/:id/disable', async (req, res, next) => {
  const id = int(req.params.id, 0);
  try {
    const [[user]] = await pool.query('SELECT email, approved FROM backoffice_users WHERE id = ?', [id]);
    if (!user) return back(res, '/admin/users', { err: 'Unknown user.' });

    const next_ = user.approved === 'Y' ? 'N' : 'Y';
    await pool.query('UPDATE backoffice_users SET approved = ? WHERE id = ?', [next_, id]);

    // The demo request is what lets them ask again, so it tracks the account.
    await pool.query('UPDATE demo_request SET approved = ? WHERE email = ?', [next_, user.email]);

    back(res, '/admin/users', {
      ok: next_ === 'Y' ? `${user.email} can sign in again.` : `${user.email} disabled.`,
    });
  } catch (e) {
    next(e);
  }
});

router.post('/users/:id/delete', async (req, res, next) => {
  const id = int(req.params.id, 0);
  try {
    await pool.query('DELETE FROM backoffice_users WHERE id = ?', [id]);
    back(res, '/admin/users', {
      ok: 'Login deleted.',
      warn: 'Their till data is keyed by email and is still in the database.',
    });
  } catch (e) {
    next(e);
  }
});

// ---- Till sub-users (clerks) ----------------------------------------------

router.get('/clerks', async (req, res, next) => {
  try {
    const q = str(req.query.q, 120);

    const [rows] = await pool.query(
      `SELECT c.id, c.email, c.pluid, c.clark_name, c.timeadded,
              o.id AS office_id, o.name AS office_name,
              (SELECT COUNT(*) FROM epos_orders e
                WHERE e.email = c.email AND e.clerk_pin = c.pin_code
                  AND e.created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)) AS orders_30,
              (SELECT COALESCE(SUM(e.total_minor), 0) FROM epos_orders e
                WHERE e.email = c.email AND e.clerk_pin = c.pin_code
                  AND e.created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)) AS taken_30_minor
       FROM bo_clarks c
       LEFT JOIN offices o ON o.contact_email = c.email
       ${q ? 'WHERE c.clark_name LIKE ? OR c.email LIKE ? OR o.name LIKE ?' : ''}
       ORDER BY o.name, c.pluid`,
      q ? [`%${q}%`, `%${q}%`, `%${q}%`] : []
    );

    const [offices] = await pool.query(
      `SELECT id, name, contact_email FROM offices WHERE status <> 'archived' ORDER BY name`
    );

    res.render('admin/clerks', {
      title: 'Till Sub-users | Vesopa Admin',
      heading: 'Till Sub-users',
      nav: 'clerks',
      counts: await navCounts(),
      flash: readFlash(req),
      rows, offices, q,
      money: require('./util').money,
      formatDate,
    });
  } catch (e) {
    next(e);
  }
});

router.post('/clerks/new', async (req, res, next) => {
  const email = str(req.body.email, 255).toLowerCase();
  const name = str(req.body.clark_name, 255);
  const pin = str(req.body.pin_code, 32);

  if (!email.includes('@') || !name || !pin) {
    return back(res, '/admin/clerks', { err: 'Office, name and PIN are all required.' });
  }

  try {
    // pluid is the till's button number. Next free one for this office unless
    // the admin picked it, so two clerks cannot share a slot by accident.
    let pluid = int(req.body.pluid, 0);
    if (!pluid) {
      const [[row]] = await pool.query(
        'SELECT COALESCE(MAX(pluid), 0) + 1 AS next FROM bo_clarks WHERE email = ?',
        [email]
      );
      pluid = row.next;
    }

    // Stored as typed: the till matches epos_orders.clerk_pin against this
    // column directly (see vesopa_server/src/backoffice.js), so hashing it here
    // would silently stop every clerk report from resolving a name.
    await pool.query(
      'INSERT INTO bo_clarks (email, pluid, clark_name, pin_code) VALUES (?, ?, ?, ?)',
      [email, pluid, name, pin]
    );

    back(res, '/admin/clerks', { ok: `${name} added.` });
  } catch (e) {
    next(e);
  }
});

router.post('/clerks/:id', async (req, res, next) => {
  const id = int(req.params.id, 0);
  const pin = str(req.body.pin_code, 32);

  try {
    if (pin) {
      await pool.query(
        'UPDATE bo_clarks SET clark_name = ?, pluid = ?, pin_code = ? WHERE id = ?',
        [str(req.body.clark_name, 255), int(req.body.pluid, 0), pin, id]
      );
    } else {
      // Blank means "leave the PIN alone", so re-saving a name does not wipe it.
      await pool.query('UPDATE bo_clarks SET clark_name = ?, pluid = ? WHERE id = ?', [
        str(req.body.clark_name, 255),
        int(req.body.pluid, 0),
        id,
      ]);
    }
    back(res, '/admin/clerks', { ok: 'Saved.' });
  } catch (e) {
    next(e);
  }
});

router.post('/clerks/:id/delete', async (req, res, next) => {
  try {
    await pool.query('DELETE FROM bo_clarks WHERE id = ?', [int(req.params.id, 0)]);
    back(res, '/admin/clerks', { ok: 'Sub-user removed.' });
  } catch (e) {
    next(e);
  }
});

module.exports = { usersRouter: router, attachEmailTotals };
