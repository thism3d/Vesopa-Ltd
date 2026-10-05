/**
 * The audit log: every change made here, who made it, and whether it worked.
 * Written before the answer goes back, so a change nobody can account for
 * cannot happen. A failure to write it is logged and does not undo the change
 * (the app that owns the thing has its own record too).
 */
const db = require('./db');

async function record({ actor, action, app = null, venueId = null, venueName = null, item = null, detail = null, ok = true }) {
  try {
    await db.run(
      `INSERT INTO adm_audit (actor, action, app, venue_id, venue_name, item, detail, ok)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [String(actor).slice(0, 190), String(action).slice(0, 48), app, venueId || null,
        venueName ? String(venueName).slice(0, 190) : null, item,
        detail == null ? null : typeof detail === 'string' ? detail : JSON.stringify(detail), ok ? 1 : 0]
    );
  } catch (e) {
    console.error('[audit] could not record', action, e.message);
  }
}

async function recent({ limit = 100, venueId = null, since = null } = {}) {
  const where = [];
  const params = [];
  if (venueId) { where.push('venue_id = ?'); params.push(venueId); }
  if (since) { where.push('at >= ?'); params.push(since); }
  params.push(Math.min(500, Math.max(1, Number(limit) || 100)));
  return db.all(
    `SELECT * FROM adm_audit ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY at DESC, id DESC LIMIT ?`,
    params
  );
}

module.exports = { record, recent };
