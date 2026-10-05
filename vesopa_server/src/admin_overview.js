/**
 * The back office's half of admin.vesopa.com's live overview (2026-10-05).
 *
 * One read for every venue: devices by kind and how many are online now, when
 * the venue was last heard from, today's takings, overdue invoices and any
 * holds. admin.vesopa.com draws its home screen from this and its venue list
 * from the same rows, so the two cannot disagree.
 *
 * Read-only, platform admin only (mounted under /api/admin, behind the admin
 * gate in admin.js). Each part is asked on its own and an absent table is an
 * empty part, so the overview still draws against a server mid-migration.
 */
const express = require('express');

const isSoft = (e) => e && (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR');

async function rows(db, sql, params = []) {
  try {
    const [r] = await db.query(sql, params);
    return r;
  } catch (e) {
    if (isSoft(e)) return [];
    throw e;
  }
}

/** A device not heard from in this long counts as offline whatever its flag says. */
const ONLINE_MINUTES = 10;

async function overview(db) {
  let offices = await rows(db,
    `SELECT id, name, contact_email, status, plan, paused_at, pause_reason
       FROM offices WHERE demo_of IS NULL ORDER BY name`);
  if (!offices.length) {
    offices = await rows(db, 'SELECT id, name, contact_email, status, plan FROM offices ORDER BY name');
  }

  const devices = await rows(db,
    `SELECT office, kind, COUNT(*) AS total,
            SUM(online = 1 AND last_seen_at > DATE_SUB(NOW(), INTERVAL ${ONLINE_MINUTES} MINUTE)) AS online,
            MAX(last_seen_at) AS last_seen_at
       FROM bo_devices GROUP BY office, kind`);
  const sales = await rows(db,
    `SELECT email AS office, COUNT(*) AS orders, COALESCE(SUM(total_minor), 0) AS total_minor
       FROM epos_orders WHERE closed_at >= CURDATE() GROUP BY email`);
  const overdue = await rows(db,
    `SELECT office_id, COUNT(*) AS n, COALESCE(SUM(amount_minor), 0) AS amount_minor
       FROM subscription_invoices WHERE status = 'overdue' GROUP BY office_id`);
  const holds = await rows(db, 'SELECT * FROM bo_admin_holds');

  const shape = require('./admin_holds').shape;
  const key = (s) => String(s || '').toLowerCase();
  const byOffice = (list, field) => {
    const out = {};
    for (const r of list) (out[key(r[field])] = out[key(r[field])] || []).push(r);
    return out;
  };
  const dev = byOffice(devices, 'office');
  const sold = Object.fromEntries(sales.map((r) => [key(r.office), r]));
  const owed = Object.fromEntries(overdue.map((r) => [String(r.office_id), r]));
  const held = byOffice(holds, 'office');

  const venues = offices.map((o) => {
    const k = key(o.contact_email);
    const kinds = {};
    let lastSeen = null;
    for (const d of dev[k] || []) {
      kinds[d.kind] = { total: Number(d.total), online: Number(d.online) || 0 };
      if (d.last_seen_at && (!lastSeen || new Date(d.last_seen_at) > lastSeen)) lastSeen = new Date(d.last_seen_at);
    }
    const s = sold[k];
    const i = owed[String(o.id)];
    return {
      id: o.id,
      name: o.name,
      email: o.contact_email,
      status: o.status,
      plan: o.plan || null,
      paused_at: o.paused_at || null,
      pause_reason: o.pause_reason || null,
      devices: kinds,
      online: Object.values(kinds).reduce((n, d) => n + d.online, 0),
      device_count: Object.values(kinds).reduce((n, d) => n + d.total, 0),
      last_seen_at: lastSeen ? lastSeen.toISOString() : null,
      today: { orders: s ? Number(s.orders) : 0, total_minor: s ? Number(s.total_minor) : 0 },
      overdue: { count: i ? Number(i.n) : 0, amount_minor: i ? Number(i.amount_minor) : 0 },
      holds: (held[k] || []).map((h) => shape(h)),
    };
  });

  const sum = (f) => venues.reduce((n, v) => n + f(v), 0);
  return {
    at: new Date().toISOString(),
    online_minutes: ONLINE_MINUTES,
    totals: {
      venues: venues.length,
      active: venues.filter((v) => v.status === 'active').length,
      paused: venues.filter((v) => v.status === 'paused').length,
      devices: sum((v) => v.device_count),
      online: sum((v) => v.online),
      today_minor: sum((v) => v.today.total_minor),
      today_orders: sum((v) => v.today.orders),
      overdue_invoices: sum((v) => v.overdue.count),
      overdue_minor: sum((v) => v.overdue.amount_minor),
      holds_in_grace: sum((v) => v.holds.filter((h) => !h.stopped).length),
      holds_stopped: sum((v) => v.holds.filter((h) => h.stopped).length),
    },
    venues,
  };
}

function adminOverviewRoutes({ pool }) {
  const router = express.Router();
  router.get('/overview', async (_req, res, next) => {
    try {
      res.json(await overview(pool));
    } catch (e) {
      next(e);
    }
  });
  return router;
}

module.exports = { overview, adminOverviewRoutes, ONLINE_MINUTES };
