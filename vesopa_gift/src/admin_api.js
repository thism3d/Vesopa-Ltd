/**
 * admin.vesopa.com's way in (2026-10-05).
 *
 * One caller, identified by ADMIN_SERVICE_KEY and compared in constant time --
 * the same arrangement the back office uses to let this shop in. It can list
 * which venues sell gift cards and switch one on or off, through the same
 * steps the owner's /admin/venues buttons take, and nothing else. The person
 * acting is named in X-Vesopa-Admin and written to the audit log.
 *
 * Unset (or shorter than 32 characters), every call is refused with 503.
 */
const crypto = require('crypto');
const express = require('express');

const db = require('./db');
const epos = require('./epos');
const venues = require('./venues');
const fulfil = require('./fulfil');

function sameKey(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

function actorOf(req) {
  const who = String(req.get('x-vesopa-admin') || '').trim().toLowerCase().slice(0, 150);
  return who ? `${who} (admin.vesopa.com)` : 'admin.vesopa.com';
}

const router = express.Router();

router.use((req, res, next) => {
  const expected = process.env.ADMIN_SERVICE_KEY || '';
  if (expected.length < 32) return res.status(503).json({ error: 'admin.vesopa.com is not connected to Vesopa Gift.' });
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token || !sameKey(token, expected)) return res.status(401).json({ error: 'Not admin.vesopa.com' });
  next();
});

/** Every venue this shop has a row for, on or off. */
router.get('/venues', async (_req, res, next) => {
  try {
    const rows = await db.all('SELECT office_id, slug, enabled, enabled_at, enabled_by FROM gift_venues');
    res.json({
      venues: rows.map((r) => ({
        office_id: Number(r.office_id),
        slug: r.slug,
        enabled: !!Number(r.enabled),
        enabled_at: r.enabled_at,
        enabled_by: r.enabled_by,
      })),
    });
  } catch (e) { next(e); }
});

router.post('/venues/:officeId/enable', async (req, res, next) => {
  try {
    const ev = await epos.venue(Number(req.params.officeId));
    await venues.ensure(ev);
    const by = actorOf(req);
    await db.run(
      'UPDATE gift_venues SET enabled = 1, enabled_at = UTC_TIMESTAMP(), enabled_by = ? WHERE office_id = ?',
      [by, ev.id]
    );
    await venues.refreshBrand(ev.id).catch(() => {});
    const v = await venues.get(ev.id);
    await fulfil.audit(ev.id, 'venue.enabled', { slug: v.slug }, by);
    res.json({ ok: true, office_id: ev.id, slug: v.slug, enabled: true });
  } catch (e) {
    if (e.status === 404) return res.status(404).json({ error: 'No such venue in the EPOS.' });
    next(e);
  }
});

router.post('/venues/:officeId/disable', async (req, res, next) => {
  try {
    const id = Number(req.params.officeId);
    await db.run('UPDATE gift_venues SET enabled = 0 WHERE office_id = ?', [id]);
    await fulfil.audit(id, 'venue.disabled', null, actorOf(req));
    res.json({ ok: true, office_id: id, enabled: false });
  } catch (e) { next(e); }
});

module.exports = { adminApiRouter: router };
