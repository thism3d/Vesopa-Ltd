/**
 * Licence holds: pausing or removing one thing a venue has (2026-10-05).
 *
 * Set from admin.vesopa.com (and from Admin here), read wherever the item is
 * enforced:
 *
 *   till, kitchen, display, express   licences.js -- the device warns through
 *                                     the grace, then shows its lock screen,
 *                                     and no new device of that kind signs in
 *   module:<key>                      modules.js -- reads as not allowed
 *   loyalty_app                       loyalty_app.js -- the app stops opening
 *
 * A GRACE DAY. The owner's choice: a pause warns for a day and only then
 * stops, so a venue paused by mistake, or in the middle of service, has time
 * to ring. See schema_admin_holds.sql.
 *
 * FAILS OPEN. A server without the table, or a lookup that fails, answers "no
 * hold" -- the same rule licences.js and entitlements.js follow: a billing
 * lookup must never be the reason a venue cannot trade.
 */
const express = require('express');

const { MODULES } = require('./modules');

const DEVICE_ITEMS = ['till', 'kitchen', 'display', 'express'];
const ITEMS = [
  ...DEVICE_ITEMS,
  ...MODULES.map((m) => `module:${m.key}`),
  'loyalty_app',
];
const GRACE_HOURS = 24;
const CACHE_MS = 30 * 1000;
const cache = new Map();

const isMissing = (e) => e && (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR');

/** A row as callers see it. `stopped` is the only thing enforcement reads. */
function shape(row, now = Date.now()) {
  if (!row) return null;
  const graceUntil = new Date(row.grace_until);
  return {
    item: row.item,
    state: row.state === 'removed' ? 'removed' : 'paused',
    reason: row.reason || null,
    heldAt: row.held_at ? new Date(row.held_at).toISOString() : null,
    heldBy: row.held_by || null,
    graceUntil: graceUntil.toISOString(),
    stopped: !(graceUntil.valueOf() > now),
  };
}

/** The hold on one item for a venue (by contact email), or null. */
async function holdFor(db, office, item) {
  if (!office || !item) return null;
  const key = `${office}|${item}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return shape(hit.row);
  let row = null;
  try {
    [[row]] = await db.query('SELECT * FROM bo_admin_holds WHERE office = ? AND item = ?', [office, item]);
  } catch (e) {
    if (!isMissing(e)) console.warn('[admin_holds] lookup failed:', e.message);
    return null;
  }
  cache.set(key, { row: row || null, at: Date.now() });
  return shape(row || null);
}

/** Whether the item has stopped for the venue: past its grace. */
async function stopped(db, office, item) {
  const hold = await holdFor(db, office, item);
  return !!(hold && hold.stopped);
}

/** Every hold a venue has, keyed by item. */
async function holdsFor(db, office) {
  try {
    const [rows] = await db.query('SELECT * FROM bo_admin_holds WHERE office = ?', [office]);
    return Object.fromEntries(rows.map((r) => [r.item, shape(r)]));
  } catch (e) {
    if (isMissing(e)) return {};
    throw e;
  }
}

function forget(office) {
  for (const key of cache.keys()) if (key.startsWith(`${office}|`)) cache.delete(key);
}

/** What a device is told while its licence is paused. */
function notice(hold, label) {
  if (!hold) return null;
  const when = new Date(hold.graceUntil).toLocaleString('en-GB', {
    timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
  const what = label || 'This app';
  if (hold.stopped) {
    return hold.state === 'removed'
      ? `${what} has been removed from this venue. Please contact Vesopa.`
      : `${what} is paused for this venue. Please contact Vesopa.`;
  }
  return `${what} has been paused and stops at ${when}. Please contact Vesopa.`;
}

/**
 * Pause, remove or resume one item.
 *
 * Pausing something already paused keeps its original grace: pressing Pause
 * twice must not give a venue a second free day. Removing a paused item keeps
 * the grace too, for the same reason. `graceHours` 0 stops it at once, for the
 * rare case (fraud, a venue that has closed) where a day is wrong.
 */
async function setHold(db, office, item, { action, reason, by, graceHours = GRACE_HOURS }) {
  if (!ITEMS.includes(item)) {
    const err = new Error(`There is nothing called ${item} to pause.`);
    err.status = 400;
    throw err;
  }
  if (action === 'resume') {
    await db.execute('DELETE FROM bo_admin_holds WHERE office = ? AND item = ?', [office, item]);
  } else if (action === 'pause' || action === 'remove') {
    const hours = Math.max(0, Math.min(24 * 30, Number(graceHours) || 0));
    await db.execute(
      `INSERT INTO bo_admin_holds (office, item, state, reason, grace_until, held_by)
       VALUES (?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? HOUR), ?)
       ON DUPLICATE KEY UPDATE
         state = VALUES(state),
         reason = COALESCE(VALUES(reason), reason),
         held_by = VALUES(held_by)`,
      [office, item, action === 'remove' ? 'removed' : 'paused', reason ? String(reason).slice(0, 255) : null,
        hours, by ? String(by).slice(0, 190) : null]
    );
  } else {
    const err = new Error('Choose pause, remove or resume.');
    err.status = 400;
    throw err;
  }
  forget(office);
  return holdFor(db, office, item);
}

/** Admin routes, mounted under /api/admin behind requireAuth + admin. */
function adminHoldRoutes({ pool, broadcast, auth, admin }) {
  const router = express.Router();

  async function officeEmail(id) {
    const [[row]] = await pool.query('SELECT contact_email FROM offices WHERE id = ?', [id]);
    return row ? row.contact_email : null;
  }

  router.get('/holds/items', auth, admin, (_req, res) => res.json({ items: ITEMS, grace_hours: GRACE_HOURS }));

  router.get('/offices/:id/holds', auth, admin, async (req, res, next) => {
    try {
      const office = await officeEmail(req.params.id);
      if (!office) return res.status(404).json({ error: 'No such office.' });
      res.json({ holds: await holdsFor(pool, office) });
    } catch (e) {
      next(e);
    }
  });

  router.put('/offices/:id/holds/:item', auth, admin, async (req, res, next) => {
    try {
      const office = await officeEmail(req.params.id);
      if (!office) return res.status(404).json({ error: 'No such office.' });
      const b = req.body || {};
      const hold = await setHold(pool, office, req.params.item, {
        action: b.action,
        reason: b.reason,
        by: req.user.email,
        graceHours: b.grace_hours === undefined ? GRACE_HOURS : b.grace_hours,
      });
      // Devices re-ask /licence/state when the settings broadcast arrives.
      if (broadcast) broadcast({ type: 'till-settings', office }, { office });
      res.json({ ok: true, hold });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message });
      next(e);
    }
  });

  return router;
}

module.exports = {
  ITEMS,
  DEVICE_ITEMS,
  GRACE_HOURS,
  shape,
  holdFor,
  holdsFor,
  stopped,
  notice,
  setHold,
  forget,
  adminHoldRoutes,
};
