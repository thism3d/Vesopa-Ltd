/**
 * The activity log: what every member, member of staff and camera pressed,
 * changed or sent, kept on the server so a fault can be traced afterwards.
 *
 * TWO COPIES, for two kinds of looking:
 *
 *   logs/metric-activity-YYYY-MM-DD.jsonl   one JSON object per line, one file
 *                                           a day, kept LOG_KEEP_DAYS. Readable
 *                                           with tail/grep on the box even when
 *                                           the database is the thing broken.
 *   activity_log table                      what the staff console searches.
 *
 * Writing the log never fails a request: a full disk or a dropped database
 * connection is reported to stderr and the member's action carries on.
 *
 * NO SECRETS IN HERE. Callers pass plain facts; `clean` drops any key that
 * looks like a credential before anything is written, as a second line of
 * defence.
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');

let db = null;
function useDb(d) { db = d; }

const SECRET_KEY = /pass|secret|token|key|code|verifier|authori[sz]ation|cookie/i;

function clean(value, depth = 0) {
  if (value == null || depth > 4) return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => clean(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY.test(k) ? '[hidden]' : clean(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string' && value.length > 500) return `${value.slice(0, 500)}…`;
  return value;
}

function day(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function fileFor(d) {
  return path.join(config.LOG_DIR, `metric-activity-${day(d)}.jsonl`);
}

let dirReady = false;
function appendLine(entry) {
  try {
    if (!dirReady) { fs.mkdirSync(config.LOG_DIR, { recursive: true }); dirReady = true; }
    fs.appendFile(fileFor(new Date()), `${JSON.stringify(entry)}\n`, (e) => {
      if (e) console.error('[activity] file write failed:', e.message);
    });
  } catch (e) {
    console.error('[activity] file write failed:', e.message);
  }
}

/**
 * Record one thing that happened.
 *
 *   actor   { type: 'member'|'admin'|'gate'|'system', id, label }
 *   action  a short dotted name: 'vehicle.add', 'ui.tap', 'gate.event' ...
 *   detail  plain facts, any shape
 *   req     the request, for the address and which app sent it
 */
function record({ actor = { type: 'system' }, action, detail = null, req = null, app = '' }) {
  const entry = {
    at: new Date().toISOString(),
    actor: actor.type,
    actorId: actor.id != null ? String(actor.id) : '',
    who: actor.label || '',
    action: String(action || 'unknown').slice(0, 80),
    detail: clean(detail),
    ip: req ? String(req.ip || '') : '',
    app: String(app || (req && req.get && req.get('X-Metric-App')) || '').slice(0, 40),
  };
  appendLine(entry);
  if (db) {
    db.run(
      `INSERT INTO activity_log (actor_type, actor_id, actor_label, action, detail, ip, app)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [entry.actor, entry.actorId.slice(0, 64), entry.who.slice(0, 191), entry.action,
        entry.detail == null ? null : JSON.stringify(entry.detail), entry.ip.slice(0, 64), entry.app],
    ).catch((e) => console.error('[activity] db write failed:', e.message));
  }
  return entry;
}

/** Delete day files older than LOG_KEEP_DAYS, and the table rows with them. */
async function prune() {
  const cutoff = Date.now() - config.LOG_KEEP_DAYS * 86400000;
  try {
    for (const f of fs.readdirSync(config.LOG_DIR)) {
      const m = f.match(/^metric-activity-(\d{4}-\d{2}-\d{2})\.jsonl$/);
      if (m && Date.parse(m[1]) < cutoff) fs.unlinkSync(path.join(config.LOG_DIR, f));
    }
  } catch { /* no directory yet */ }
  if (db) {
    await db.run('DELETE FROM activity_log WHERE at < ?', [new Date(cutoff)]).catch(() => {});
  }
}

module.exports = { record, prune, useDb, clean, fileFor };
