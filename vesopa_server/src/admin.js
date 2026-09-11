const express = require('express');
const bcrypt = require('bcryptjs');
const { requireAuth } = require('./auth');

/** Platform admin only. An office user hitting these must be refused. */
function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Administrator access only' });
  }
  next();
}

/**
 * Platform administration: the offices (tenants), their status, and their
 * recurring charges.
 */
function adminRoutes({ pool, broadcast, secret }) {
  const router = express.Router();
  const auth = requireAuth(secret);

  router.use(auth, requireAdmin);

  // ---- Offices ------------------------------------------------------------

  router.get('/offices', async (_req, res, next) => {
    // Till licences (schema_till_licences.sql): the limit, and how many tills
    // are signed in now. Collated explicitly because offices.contact_email took
    // the server's default collation and bo_till_seats.office did not -- the
    // "Illegal mix of collations" that only ever happens on live. Tried first and
    // fallen back from, so the office list never breaks over a migration.
    const LICENCES = `o.till_licences,
                (SELECT COUNT(*) FROM bo_till_seats t
                  WHERE t.office = o.contact_email COLLATE utf8mb4_general_ci
                    AND t.released_at IS NULL) AS tills_in_use,`;
    const select = (licences) => `
        SELECT o.id, o.name, o.contact_email, o.status, o.plan, ${licences}
                o.created_at, o.paused_at, o.pause_reason,
                s.id            AS subscription_id,
                s.amount_minor,
                s.interval_unit,
                s.next_due_on,
                s.status        AS subscription_status,
                (SELECT COUNT(*) FROM backoffice_users u
                  WHERE u.office_id = o.id)             AS user_count,
                (SELECT COUNT(*) FROM subscription_invoices i
                  WHERE i.office_id = o.id AND i.status = 'overdue') AS overdue_count
         FROM offices o
         LEFT JOIN subscriptions s
           ON s.office_id = o.id AND s.status = 'active'
         ORDER BY o.name`;
    try {
      let rows;
      try {
        [rows] = await pool.query(select(LICENCES));
      } catch (e) {
        if (e.code !== 'ER_BAD_FIELD_ERROR' && e.code !== 'ER_NO_SUCH_TABLE') throw e;
        [rows] = await pool.query(select(''));
      }
      res.json(rows);
    } catch (e) {
      next(e);
    }
  });

  /**
   * How many tills this office may have signed in at once. Null (a blank box)
   * is no limit. Lowering it below the tills already in never signs one out:
   * the next sign-in is refused until the venue is back under.
   */
  router.put('/offices/:id/licences', async (req, res, next) => {
    try {
      const raw = (req.body || {}).till_licences;
      let value = null;
      if (raw !== null && raw !== undefined && String(raw).trim() !== '') {
        value = Number(raw);
        if (!Number.isInteger(value) || value < 0 || value > 999) {
          return res.status(400).json({ error: 'Till licences must be a whole number from 0 to 999, or blank for no limit.' });
        }
      }
      const [r] = await pool.execute(
        'UPDATE offices SET till_licences = ? WHERE id = ?',
        [value, req.params.id]
      );
      if (!r.affectedRows) return res.status(404).json({ error: 'No such office.' });
      broadcast({ type: 'offices.updated' });
      res.json({ ok: true, till_licences: value });
    } catch (e) {
      next(e);
    }
  });

  /** Create an office, its first user, and optionally its recurring charge. */
  router.post('/offices', async (req, res, next) => {
    const { name, contact_email, plan, password, amount_minor, interval_unit } =
      req.body || {};

    if (!name || !contact_email || !password) {
      return res
        .status(400)
        .json({ error: 'Name, contact email and a password are required' });
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [office] = await conn.execute(
        `INSERT INTO offices (name, contact_email, plan, status)
         VALUES (?, ?, ?, 'active')`,
        [name, contact_email, plan ?? null]
      );
      const officeId = office.insertId;

      // The office's first sign-in. Hashed from the outset — no new account
      // ever gets a plaintext password.
      const hash = await bcrypt.hash(password, 12);
      await conn.execute(
        `INSERT INTO backoffice_users
           (email, password, name, company, approved, role, office_id)
         VALUES (?, ?, ?, ?, 'Y', 'office', ?)`,
        [contact_email, hash, name, name, officeId]
      );

      if (amount_minor > 0) {
        const [sub] = await conn.execute(
          `INSERT INTO subscriptions
             (office_id, amount_minor, interval_unit, next_due_on, status)
           VALUES (?, ?, ?, CURDATE(), 'active')`,
          [officeId, amount_minor, interval_unit || 'month']
        );
        // Raise the first invoice immediately, so the charge exists rather than
        // only appearing when some future job runs.
        await conn.execute(
          `INSERT INTO subscription_invoices
             (subscription_id, office_id, amount_minor, due_on, status)
           VALUES (?, ?, ?, CURDATE(), 'due')`,
          [sub.insertId, officeId, amount_minor]
        );
      }

      await conn.commit();
      broadcast({ type: 'offices.updated' });
      res.status(201).json({ id: officeId });
    } catch (e) {
      await conn.rollback();
      if (e.code === 'ER_DUP_ENTRY') {
        return res
          .status(409)
          .json({ error: 'An office already exists for that email' });
      }
      next(e);
    } finally {
      conn.release();
    }
  });

  /**
   * Pause or resume an office.
   *
   * A paused office cannot sign into the back office AND its tills are refused
   * by the API — see requireActiveOffice. Pausing that only locked the browser
   * would let a non-paying customer keep trading.
   */
  router.post('/offices/:id/status', async (req, res, next) => {
    const { status, reason } = req.body || {};
    if (!['active', 'paused', 'archived'].includes(status)) {
      return res.status(400).json({ error: 'Unknown status' });
    }

    try {
      await pool.execute(
        `UPDATE offices
         SET status = ?,
             paused_at    = IF(? = 'paused', NOW(), NULL),
             pause_reason = IF(? = 'paused', ?, NULL)
         WHERE id = ?`,
        [status, status, status, reason ?? null, req.params.id]
      );

      // Tills poll this too, so a pause takes effect without waiting for a
      // restart.
      broadcast({ type: 'office.status', officeId: Number(req.params.id), status });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // ---- More than one site under one login (src/sites.js) -------------------

  /**
   * Who manages this site: its own users (home) and the logins linked to it
   * from another office. Only the links can be removed here -- a home user
   * belongs to the office and is managed under Users.
   */
  router.get('/offices/:id/managers', async (req, res, next) => {
    try {
      const officeId = Number(req.params.id);
      const [home] = await pool.query(
        `SELECT id AS user_id, email, name, 1 AS home
           FROM backoffice_users WHERE office_id = ? ORDER BY name`,
        [officeId]
      );
      let linked = [];
      try {
        [linked] = await pool.query(
          `SELECT u.id AS user_id, u.email, u.name, 0 AS home, o.name AS home_office
             FROM bo_user_sites s
             JOIN backoffice_users u ON u.id = s.user_id
             LEFT JOIN offices o ON o.id = u.office_id
            WHERE s.office_id = ? ORDER BY u.name`,
          [officeId]
        );
      } catch (e) {
        if (e.code !== 'ER_NO_SUCH_TABLE') throw e;
      }
      res.json([...home, ...linked].map((r) => ({ ...r, home: Number(r.home) === 1 })));
    } catch (e) {
      next(e);
    }
  });

  /** Let an existing back-office login manage this site too, by its email. */
  router.post('/offices/:id/managers', async (req, res, next) => {
    try {
      const officeId = Number(req.params.id);
      const email = String((req.body || {}).email || '').trim().toLowerCase();
      if (!email) return res.status(400).json({ error: 'Which login? Give its email address.' });
      const [[office]] = await pool.query('SELECT id FROM offices WHERE id = ?', [officeId]);
      if (!office) return res.status(404).json({ error: 'No such office.' });
      const [[user]] = await pool.query(
        'SELECT id, office_id, name FROM backoffice_users WHERE LOWER(email) = ?',
        [email]
      );
      if (!user) {
        return res.status(404).json({
          error: 'No back-office login has that email. Create it under its own office first.',
        });
      }
      if (Number(user.office_id) === officeId) {
        return res.status(409).json({ error: `${user.name} already belongs to this site.` });
      }
      await pool.execute(
        'INSERT IGNORE INTO bo_user_sites (user_id, office_id, added_by) VALUES (?, ?, ?)',
        [user.id, officeId, req.user.email]
      );
      res.status(201).json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  /** Stop a linked login managing this site. Its home office is untouched. */
  router.delete('/offices/:id/managers/:userId', async (req, res, next) => {
    try {
      const [r] = await pool.execute(
        'DELETE FROM bo_user_sites WHERE office_id = ? AND user_id = ?',
        [Number(req.params.id), Number(req.params.userId)]
      );
      if (!r.affectedRows) return res.status(404).json({ error: 'That login is not linked here.' });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // ---- Billing ------------------------------------------------------------

  router.get('/offices/:id/invoices', async (req, res, next) => {
    try {
      const [rows] = await pool.query(
        `SELECT id, amount_minor, due_on, paid_at, status
         FROM subscription_invoices
         WHERE office_id = ?
         ORDER BY due_on DESC`,
        [req.params.id]
      );
      res.json(rows);
    } catch (e) {
      next(e);
    }
  });

  /** Set or change an office's recurring charge. */
  router.put('/offices/:id/subscription', async (req, res, next) => {
    const { amount_minor, interval_unit, next_due_on } = req.body || {};
    try {
      const [existing] = await pool.query(
        `SELECT id FROM subscriptions WHERE office_id = ? AND status = 'active'`,
        [req.params.id]
      );

      if (existing.length > 0) {
        await pool.execute(
          `UPDATE subscriptions
           SET amount_minor = ?, interval_unit = ?, next_due_on = ?
           WHERE id = ?`,
          [
            amount_minor,
            interval_unit || 'month',
            next_due_on,
            existing[0].id,
          ]
        );
      } else {
        await pool.execute(
          `INSERT INTO subscriptions
             (office_id, amount_minor, interval_unit, next_due_on, status)
           VALUES (?, ?, ?, ?, 'active')`,
          [req.params.id, amount_minor, interval_unit || 'month', next_due_on]
        );
      }

      broadcast({ type: 'offices.updated' });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  /** Mark an invoice settled and roll the subscription to the next period. */
  router.post('/invoices/:id/paid', async (req, res, next) => {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [[invoice]] = await conn.query(
        'SELECT * FROM subscription_invoices WHERE id = ?',
        [req.params.id]
      );
      if (!invoice) {
        await conn.rollback();
        return res.status(404).json({ error: 'No such invoice' });
      }

      await conn.execute(
        `UPDATE subscription_invoices
         SET status = 'paid', paid_at = NOW() WHERE id = ?`,
        [req.params.id]
      );

      // Advance the schedule and raise the next charge, so billing keeps
      // running without anyone having to remember to do it.
      const [[sub]] = await conn.query(
        'SELECT * FROM subscriptions WHERE id = ?',
        [invoice.subscription_id]
      );
      if (sub && sub.status === 'active') {
        const unit = sub.interval_unit === 'year' ? 'YEAR' : 'MONTH';
        await conn.execute(
          `UPDATE subscriptions
           SET next_due_on = DATE_ADD(next_due_on, INTERVAL 1 ${unit})
           WHERE id = ?`,
          [sub.id]
        );
        const [[next]] = await conn.query(
          'SELECT next_due_on FROM subscriptions WHERE id = ?',
          [sub.id]
        );
        await conn.execute(
          `INSERT INTO subscription_invoices
             (subscription_id, office_id, amount_minor, due_on, status)
           VALUES (?, ?, ?, ?, 'due')`,
          [sub.id, sub.office_id, sub.amount_minor, next.next_due_on]
        );
      }

      await conn.commit();
      broadcast({ type: 'offices.updated' });
      res.json({ ok: true });
    } catch (e) {
      await conn.rollback();
      next(e);
    } finally {
      conn.release();
    }
  });

  /** Flag everything past its due date. */
  router.post('/invoices/sweep-overdue', async (_req, res, next) => {
    try {
      const [r] = await pool.execute(
        `UPDATE subscription_invoices
         SET status = 'overdue'
         WHERE status = 'due' AND due_on < CURDATE()`
      );
      broadcast({ type: 'offices.updated' });
      res.json({ marked_overdue: r.affectedRows });
    } catch (e) {
      next(e);
    }
  });

  return router;
}

module.exports = { adminRoutes, requireAdmin };
