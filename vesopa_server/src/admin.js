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
    try {
      const [rows] = await pool.query(
        `SELECT o.id, o.name, o.contact_email, o.status, o.plan,
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
         ORDER BY o.name`
      );
      res.json(rows);
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
