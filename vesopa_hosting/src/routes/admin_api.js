/**
 * admin.vesopa.com's way in (2026-10-05).
 *
 * One caller, identified by ADMIN_SERVICE_KEY and compared in constant time.
 * It can list hosting services and suspend or restore one, through the same
 * steps as the Suspend button in /admin/services (HestiaCP first, then the
 * row, then the activity log), and nothing else. The person acting is named in
 * X-Vesopa-Admin and written to the log.
 *
 * Unset (or shorter than 32 characters), every call is refused with 503.
 */
const crypto = require('crypto');
const express = require('express');
const db = require('../db');
const hestia = require('../integrations/hestia');

function sameKey(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

const router = express.Router();
router.use(express.json({ limit: '20kb' }));

router.use((req, res, next) => {
  const expected = process.env.ADMIN_SERVICE_KEY || '';
  if (expected.length < 32) return res.status(503).json({ error: 'admin.vesopa.com is not connected to Vesopa Cloud.' });
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token || !sameKey(token, expected)) return res.status(401).json({ error: 'Not admin.vesopa.com' });
  next();
});

router.get('/services', async (_req, res, next) => {
  try {
    const services = await db.query(
      `SELECT s.id, s.status, s.primary_domain, s.suspended_reason, s.created_at, s.next_due_on,
              p.name AS plan_name, c.id AS customer_id, c.email, c.status AS customer_status
         FROM services s
         JOIN plans p ON p.id = s.plan_id
         JOIN customers c ON c.id = s.customer_id
        ORDER BY s.created_at DESC LIMIT 500`
    ).catch(async (e) => {
      if (e.code !== 'ER_BAD_FIELD_ERROR') throw e;
      return db.query(
        `SELECT s.id, s.status, s.primary_domain, s.suspended_reason, s.created_at,
                p.name AS plan_name, c.id AS customer_id, c.email
           FROM services s JOIN plans p ON p.id = s.plan_id JOIN customers c ON c.id = s.customer_id
          ORDER BY s.created_at DESC LIMIT 500`
      );
    });
    res.json({ services });
  } catch (e) { next(e); }
});

async function setSuspended(req, res, next, suspend) {
  try {
    const service = await db.one(
      'SELECT s.*, c.hestia_user FROM services s JOIN customers c ON c.id = s.customer_id WHERE s.id = ? LIMIT 1',
      [req.params.id]
    );
    if (!service) return res.status(404).json({ error: 'No such service.' });
    const reason = String((req.body && req.body.reason) || '').slice(0, 190);
    try {
      if (suspend) await hestia.suspendUser(service.hestia_user);
      else await hestia.unsuspendUser(service.hestia_user);
    } catch (err) {
      return res.status(502).json({ error: `The hosting node refused: ${err.message}` });
    }
    await db.query('UPDATE services SET status = ?, suspended_reason = ? WHERE id = ?', [
      suspend ? 'suspended' : 'active', suspend ? reason : '', service.id,
    ]);
    const who = String(req.get('x-vesopa-admin') || '').trim().toLowerCase().slice(0, 150);
    await db.logActivity({
      actorType: 'admin', actorId: null,
      action: suspend ? 'service.suspended' : 'service.unsuspended',
      target: service.primary_domain || `service#${service.id}`,
      detail: `${reason}${reason ? ' ' : ''}(${who || 'admin.vesopa.com'} via admin.vesopa.com)`.slice(0, 255),
      ip: req.ip,
    });
    res.json({ ok: true, id: service.id, status: suspend ? 'suspended' : 'active' });
  } catch (e) { next(e); }
}

router.post('/services/:id/suspend', (req, res, next) => setSuspended(req, res, next, true));
router.post('/services/:id/unsuspend', (req, res, next) => setSuspended(req, res, next, false));

module.exports = router;
