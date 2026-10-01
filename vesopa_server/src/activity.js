const express = require('express');
const jwt = require('jsonwebtoken');
const { accessGuard } = require('./permissions');

/**
 * The activity log, wired into this server.
 *
 * The logger itself is src/activity_log.js (a synced copy of
 * shared/activity-log/activity_log.js). This file adds what is particular to
 * the back office:
 *
 *   identify(req)          who a request was from: venue, person, app, device.
 *                          Used by the middleware in server.js, which writes a
 *                          line for every request that changes something.
 *   POST /activity/v1/events     events from the apps: taps, screens, sign-ins,
 *                          errors. Any device token (till, kitchen screen,
 *                          Express kiosk, loyalty app) or a back-office session.
 *                          The venue always comes off the signed token, never
 *                          the body, so one venue cannot write into another's log.
 *   GET  /api/activity     the back office's Activity Log page, filtered.
 *                          Scoped to the signed-in venue; the Vesopa admin can
 *                          see every venue or pick one.
 *   GET  /api/activity/facets   devices, people, versions, kinds and buttons
 *                          seen in the last 30 days, for the filter pickers.
 *   GET  /api/activity/summary  counts for the same filters: totals,
 *                          problems, people, devices, by action, by app, by hour.
 *   GET  /api/activity.csv the same rows as a spreadsheet, for a support ticket.
 *
 * NOTHING HERE IS ON THE PATH THAT TAKES MONEY. Logging is fire-and-forget and
 * a failed POST from an app is retried by the app later or dropped.
 */

// Which app a device token belongs to.
const APP_FOR_SCOPE = {
  terminal: 'epos',
  kitchen: 'kitchen',
  express: 'express',
  loyalty: 'loyalty',
};

// Apps allowed to name themselves in a batch. Anything else becomes the app
// its token says it is.
const KNOWN_APPS = new Set([
  'epos', 'kitchen', 'display', 'express', 'loyalty', 'backoffice',
  'metric', 'membership', 'gift', 'web',
]);

const MAX_BATCH = 200;
const RATE_PER_MINUTE = 3000;

function activityRoutes({ pool, secret, log }) {
  const router = express.Router();

  // officeId -> contact email, so a back-office line can carry its venue
  // without a query per request. Offices do not change address often, and a
  // stale entry only mislabels a log line for ten minutes.
  const officeCache = new Map();
  async function officeEmail(officeId) {
    if (!officeId) return null;
    const hit = officeCache.get(officeId);
    if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.email;
    const [[row]] = await pool.query('SELECT contact_email FROM offices WHERE id = ?', [officeId]);
    const email = row ? row.contact_email : null;
    officeCache.set(officeId, { email, at: Date.now() });
    return email;
  }

  function claimsOf(req) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return null;
    try {
      return jwt.verify(token, secret);
    } catch {
      return null;
    }
  }

  /** Who a request was from. Never throws. */
  async function identify(req) {
    const who = { app: 'server' };
    try {
      const claims = req.user || req.terminal || req.kitchen || claimsOf(req);
      if (claims && claims.scope) {
        who.app = APP_FOR_SCOPE[claims.scope] || claims.scope;
        who.office = claims.office || null;
        who.actorType = claims.scope === 'loyalty' ? 'customer' : 'device';
        if (claims.cid) who.customerId = String(claims.cid);
        if (claims.kiosk) who.deviceId = String(claims.kiosk);
        if (claims.commissionedBy) who.actor = claims.commissionedBy;
      } else if (claims && claims.email) {
        who.app = 'backoffice';
        who.actor = claims.email;
        who.actorType = claims.role === 'admin' ? 'admin' : 'user';
        who.office = (await officeEmail(claims.officeId)) || claims.email;
      }
      // A route that resolved the venue itself knows best.
      if (req.office) who.office = req.office;
      if (req.customerId) who.customerId = String(req.customerId);
      if (req.seatId) who.deviceId = who.deviceId || String(req.seatId);
      // Signing in: record who tried, even though nobody is signed in yet. The
      // password is redacted by the logger; the address tried is the point.
      if (!who.actor && req.body && typeof req.body.email === 'string') {
        who.actor = req.body.email.slice(0, 190);
      }
    } catch {
      // A line with less on it is better than no line.
    }
    return who;
  }

  // ---------------------------------------------------------------------------
  // The apps' half.
  // ---------------------------------------------------------------------------

  const buckets = new Map();
  function allow(key, count) {
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || now - b.at > 60 * 1000) { b = { at: now, n: 0 }; buckets.set(key, b); }
    b.n += count;
    if (buckets.size > 5000) buckets.clear();
    return b.n <= RATE_PER_MINUTE;
  }

  router.post('/activity/v1/events', async (req, res) => {
    const claims = claimsOf(req);
    if (!claims) return res.status(401).json({ error: 'Not signed in' });

    const events = Array.isArray(req.body && req.body.events) ? req.body.events.slice(0, MAX_BATCH) : [];
    if (!events.length) return res.json({ ok: true, accepted: 0 });

    let office = claims.office || null;
    let app = APP_FOR_SCOPE[claims.scope] || null;
    let actorType = claims.scope === 'loyalty' ? 'customer' : 'staff';
    let defaultActor = null;
    if (!claims.scope) {
      // A back-office browser.
      app = 'backoffice';
      actorType = claims.role === 'admin' ? 'admin' : 'user';
      defaultActor = claims.email || null;
      try { office = (await officeEmail(claims.officeId)) || claims.email; } catch { office = claims.email; }
    } else if (!app) {
      return res.status(401).json({ error: 'Not signed in' });
    }
    if (!office) return res.status(401).json({ error: 'Not signed in' });

    const key = claims.jti || `${claims.scope || 'bo'}:${office}:${claims.kiosk || claims.cid || claims.sub || ''}`;
    if (!allow(key, events.length)) return res.status(429).json({ error: 'Too many events' });

    const body = req.body || {};
    // The customer display has no network; its till forwards its events and
    // says so. Only a till may speak for a display.
    const claimed = String(body.app || '').toLowerCase();
    if (claims.scope === 'terminal' && claimed === 'display') app = 'display';
    // A white-label loyalty app (Metric, for one) says which brand it is.
    else if (claims.scope === 'loyalty' && KNOWN_APPS.has(claimed)
      && !['epos', 'kitchen', 'express', 'display', 'backoffice'].includes(claimed)) {
      app = claimed;
    }

    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || null;
    const now = Date.now();
    let accepted = 0;
    for (const e of events) {
      if (!e || typeof e !== 'object') continue;
      // An app's clock is trusted to order its own events but not to put them
      // in the future or in last year.
      let at = e.at ? Date.parse(e.at) : now;
      if (!Number.isFinite(at) || at > now + 5 * 60 * 1000 || at < now - 30 * 86400000) at = now;
      log.record({
        at,
        office,
        app,
        appVersion: body.app_version,
        deviceId: body.device_id || claims.kiosk || null,
        deviceName: body.device_name,
        actor: e.actor || defaultActor,
        actorType: e.actor_type || actorType,
        customerId: claims.cid ? String(claims.cid) : e.customer_id,
        action: e.action,
        target: e.target,
        detail: e.detail,
        sessionId: e.session_id || body.session_id,
        ip,
      });
      accepted += 1;
    }
    res.json({ ok: true, accepted });
  });

  // ---------------------------------------------------------------------------
  // The back office's half.
  // ---------------------------------------------------------------------------

  const guard = accessGuard({ pool, secret })('programming.activity_log');

  const clean = (v, max = 190) => {
    const s = String(v ?? '').trim();
    return s ? s.slice(0, max) : null;
  };

  // Values a filter may name exactly. Anything else is ignored rather than
  // matched, so a typo in a URL widens the list instead of emptying it.
  const ACTOR_TYPES = new Set(['staff', 'user', 'admin', 'customer', 'device', 'system']);
  const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

  /** "tap,screen" as a short list of clean action names. */
  const actionList = (v) => String(v ?? '').split(',')
    .map((a) => a.trim().toLowerCase()).filter((a) => /^[a-z0-9_.-]{1,32}$/.test(a)).slice(0, 12);

  /** A whole number in [min, max], or null. */
  const intIn = (v, min, max) => {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v);
    return Number.isInteger(n) && n >= min && n <= max ? n : null;
  };

  /**
   * The row's time on the manager's clock, for "between 18:00 and 23:00" and
   * "Saturdays". `at` is written in the server's own time zone; the page sends
   * its offset as ?tz= (minutes, as getTimezoneOffset gives it). Without one
   * the server's clock is used, as the by-hour chart always did.
   */
  function localAt(q) {
    const tz = intIn(q.tz, -900, 900);
    if (tz === null) return { expr: 'at', args: [] };
    const shift = new Date().getTimezoneOffset() - tz;
    return shift ? { expr: 'DATE_ADD(at, INTERVAL ? MINUTE)', args: [shift] } : { expr: 'at', args: [] };
  }

  /**
   * Build the WHERE clause from the query string.
   *
   * A venue sees only its own rows. The Vesopa admin sees every venue, or the
   * one named in ?office=.
   *
   * Filters, all optional and combined with AND:
   *   app, app_version, device_id, customer_id, session_id   exact
   *   actor_type                 staff | user | admin | customer | device | system
   *   action                     one kind, or several as "tap,screen"
   *   not_action                 kinds to leave out, as "screen,tap"
   *   actor, target, q           contains (q looks in target, detail, device, person)
   *   method                     GET | POST | PUT | PATCH | DELETE
   *   result                     ok | problems | 4xx | 5xx
   *   status                     one HTTP status, e.g. 404
   *   min_ms                     slower than this many milliseconds
   *   ip                         starts with
   *   from, to                   instants (a bare "to" date means that whole day)
   *   hour_from, hour_to         time of day on the manager's clock; 22 to 2 wraps midnight
   *   days                       weekdays as "1,7" (1 = Sunday, as MySQL counts)
   *   errors=1                   the same as result=problems
   */
  async function where(req) {
    const clauses = [];
    const args = [];
    const q = req.query || {};
    if (req.user.role === 'admin') {
      const office = clean(q.office);
      if (office) { clauses.push('office = ?'); args.push(office.toLowerCase()); }
    } else {
      const office = (await officeEmail(req.user.officeId)) || req.user.email;
      clauses.push('office = ?');
      args.push(String(office).toLowerCase());
    }
    for (const [param, column] of [
      ['app', 'app'], ['app_version', 'app_version'], ['device_id', 'device_id'],
      ['customer_id', 'customer_id'], ['session_id', 'session_id'],
    ]) {
      const v = clean(q[param], 64);
      if (v) { clauses.push(`${column} = ?`); args.push(v); }
    }
    const actorType = clean(q.actor_type, 16);
    if (actorType && ACTOR_TYPES.has(actorType)) { clauses.push('actor_type = ?'); args.push(actorType); }
    const actions = actionList(q.action);
    if (actions.length) {
      clauses.push(`action IN (${actions.map(() => '?').join(', ')})`);
      args.push(...actions);
    }
    const hidden = actionList(q.not_action);
    if (hidden.length) {
      clauses.push(`action NOT IN (${hidden.map(() => '?').join(', ')})`);
      args.push(...hidden);
    }
    const actor = clean(q.actor);
    if (actor) { clauses.push('actor LIKE ?'); args.push(`%${actor}%`); }
    const target = clean(q.target, 120);
    if (target) { clauses.push('target LIKE ?'); args.push(`%${target}%`); }
    const text = clean(q.q, 100);
    if (text) {
      clauses.push('(target LIKE ? OR detail LIKE ? OR device_name LIKE ? OR actor LIKE ?)');
      args.push(`%${text}%`, `%${text}%`, `%${text}%`, `%${text}%`);
    }
    const method = String(q.method || '').toUpperCase();
    if (METHODS.has(method)) { clauses.push('method = ?'); args.push(method); }
    const result = q.errors === '1' ? 'problems' : String(q.result || '');
    if (result === 'problems') clauses.push("(action = 'error' OR status >= 400)");
    else if (result === 'ok') clauses.push("(action <> 'error' AND (status IS NULL OR status < 400))");
    else if (result === '4xx') clauses.push('status BETWEEN 400 AND 499');
    else if (result === '5xx') clauses.push('status >= 500');
    const status = intIn(q.status, 100, 599);
    if (status !== null) { clauses.push('status = ?'); args.push(status); }
    const minMs = intIn(q.min_ms, 1, 3600000);
    if (minMs !== null) { clauses.push('ms >= ?'); args.push(minMs); }
    const ip = clean(q.ip, 64);
    if (ip) { clauses.push('ip LIKE ?'); args.push(`${ip.replace(/[%_\\]/g, '')}%`); }
    const from = clean(q.from, 30);
    if (from && !Number.isNaN(Date.parse(from))) { clauses.push('at >= ?'); args.push(new Date(from)); }
    const to = clean(q.to, 30);
    if (to && !Number.isNaN(Date.parse(to))) {
      // A bare date means the whole of that day.
      const end = /^\d{4}-\d{2}-\d{2}$/.test(to) ? new Date(Date.parse(to) + 86400000) : new Date(to);
      clauses.push('at < ?');
      args.push(end);
    }
    const hourFrom = intIn(q.hour_from, 0, 23);
    const hourTo = intIn(q.hour_to, 0, 23);
    const days = [...new Set(String(q.days ?? '').split(',').map((d) => intIn(d.trim(), 1, 7)).filter((d) => d !== null))];
    if (hourFrom !== null || hourTo !== null || (days.length && days.length < 7)) {
      const local = localAt(q);
      const hour = `HOUR(${local.expr})`;
      if (hourFrom !== null && hourTo !== null && hourFrom > hourTo) {
        // Late night: 22:00 to 02:59 is two pieces of the day.
        clauses.push(`(${hour} >= ? OR ${hour} <= ?)`);
        args.push(...local.args, hourFrom, ...local.args, hourTo);
      } else {
        if (hourFrom !== null) { clauses.push(`${hour} >= ?`); args.push(...local.args, hourFrom); }
        if (hourTo !== null) { clauses.push(`${hour} <= ?`); args.push(...local.args, hourTo); }
      }
      if (days.length && days.length < 7) {
        clauses.push(`DAYOFWEEK(${local.expr}) IN (${days.map(() => '?').join(', ')})`);
        args.push(...local.args, ...days);
      }
    }
    const before = Number(q.before_id);
    if (Number.isInteger(before) && before > 0) { clauses.push('id < ?'); args.push(before); }
    // Live mode asks only for what arrived since the newest row it shows, and
    // oldest-first pages onwards the same way.
    const after = Number(q.after_id);
    if (Number.isInteger(after) && after > 0) { clauses.push('id > ?'); args.push(after); }
    return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', args };
  }

  const COLUMNS = `id, at, office, app, app_version, device_id, device_name, actor,
                   actor_type, customer_id, action, target, method, status, ms,
                   detail, ip, session_id`;

  router.get('/api/activity', guard, async (req, res, next) => {
    try {
      const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 500);
      const { sql, args } = await where(req);
      const order = req.query.order === 'asc' ? 'ASC' : 'DESC';
      const [rows] = await pool.query(
        `SELECT ${COLUMNS} FROM epos_activity_log ${sql} ORDER BY id ${order} LIMIT ?`,
        [...args, limit]
      );
      res.json({ rows, more: rows.length === limit, admin: req.user.role === 'admin' });
    } catch (e) {
      if (e && e.code === 'ER_NO_SUCH_TABLE') return res.json({ rows: [], more: false, admin: req.user.role === 'admin' });
      next(e);
    }
  });

  /**
   * The shape of what the filters match, for the strip above the list: how
   * much happened, how much of it went wrong, who and what was involved, and
   * when in the day it happened. Counted over every matching row rather than
   * the page on screen, so "12 problems" means twelve, not twelve of the 200
   * that happened to be loaded.
   */
  router.get('/api/activity/summary', guard, async (req, res, next) => {
    try {
      const query = { ...(req.query || {}) };
      delete query.before_id;
      delete query.after_id;
      const { sql, args } = await where({ user: req.user, query });
      const [[totals]] = await pool.query(
        `SELECT COUNT(*) AS total,
                SUM(action = 'error' OR status >= 400) AS problems,
                COUNT(DISTINCT actor) AS people,
                COUNT(DISTINCT device_id) AS devices,
                MIN(at) AS first_at, MAX(at) AS last_at
           FROM epos_activity_log ${sql}`,
        args
      );
      const [actions] = await pool.query(
        `SELECT action, COUNT(*) AS n FROM epos_activity_log ${sql}
          GROUP BY action ORDER BY n DESC LIMIT 20`,
        args
      );
      const [apps] = await pool.query(
        `SELECT app, COUNT(*) AS n FROM epos_activity_log ${sql}
          GROUP BY app ORDER BY n DESC LIMIT 20`,
        args
      );
      const local = localAt(query);
      const [hours] = await pool.query(
        `SELECT HOUR(${local.expr}) AS h, COUNT(*) AS n FROM epos_activity_log ${sql}
          GROUP BY h`,
        [...local.args, ...args]
      );
      const byHour = Array(24).fill(0);
      for (const r of hours || []) {
        const h = Number(r.h);
        if (h >= 0 && h < 24) byHour[h] = Number(r.n) || 0;
      }
      const t = totals || {};
      res.json({
        total: Number(t.total) || 0,
        problems: Number(t.problems) || 0,
        people: Number(t.people) || 0,
        devices: Number(t.devices) || 0,
        firstAt: t.first_at || null,
        lastAt: t.last_at || null,
        byAction: (actions || []).map((r) => ({ action: r.action, n: Number(r.n) || 0 })),
        byApp: (apps || []).map((r) => ({ app: r.app, n: Number(r.n) || 0 })),
        byHour,
      });
    } catch (e) {
      if (e && e.code === 'ER_NO_SUCH_TABLE') {
        return res.json({ total: 0, problems: 0, people: 0, devices: 0, byAction: [], byApp: [], byHour: Array(24).fill(0) });
      }
      next(e);
    }
  });

  /** The devices and people seen lately, for the filter dropdowns. */
  router.get('/api/activity/facets', guard, async (req, res, next) => {
    try {
      const { sql, args } = await where({ user: req.user, query: { office: req.query.office } });
      const since = `${sql ? `${sql} AND` : 'WHERE'} at >= DATE_SUB(NOW(), INTERVAL 30 DAY)`;
      const [devices] = await pool.query(
        `SELECT device_id, MAX(device_name) AS device_name, MAX(app) AS app
           FROM epos_activity_log ${since} AND device_id IS NOT NULL
          GROUP BY device_id ORDER BY MAX(at) DESC LIMIT 100`,
        args
      );
      // The people, versions, kinds and buttons seen lately, so a filter can be
      // picked rather than spelled.
      const [actors] = await pool.query(
        `SELECT actor, MAX(actor_type) AS actor_type, COUNT(*) AS n
           FROM epos_activity_log ${since} AND actor IS NOT NULL
          GROUP BY actor ORDER BY n DESC LIMIT 200`,
        args
      );
      const [versions] = await pool.query(
        `SELECT app, app_version, MAX(at) AS last_at
           FROM epos_activity_log ${since} AND app_version IS NOT NULL
          GROUP BY app, app_version ORDER BY last_at DESC LIMIT 60`,
        args
      );
      const [actions] = await pool.query(
        `SELECT action, COUNT(*) AS n FROM epos_activity_log ${since}
          GROUP BY action ORDER BY n DESC LIMIT 40`,
        args
      );
      const [targets] = await pool.query(
        `SELECT target, COUNT(*) AS n FROM epos_activity_log ${since} AND target IS NOT NULL
          GROUP BY target ORDER BY n DESC LIMIT 200`,
        args
      );
      let offices = [];
      if (req.user.role === 'admin') {
        [offices] = await pool.query(
          `SELECT office, COUNT(*) AS n FROM epos_activity_log
            WHERE at >= DATE_SUB(NOW(), INTERVAL 30 DAY) AND office IS NOT NULL
            GROUP BY office ORDER BY n DESC LIMIT 500`
        );
      }
      res.json({
        devices,
        offices: offices.map((o) => o.office),
        actors: (actors || []).map((a) => ({ actor: a.actor, actorType: a.actor_type, n: Number(a.n) || 0 })),
        versions: (versions || []).map((v) => ({ app: v.app, version: v.app_version })),
        actions: (actions || []).map((a) => ({ action: a.action, n: Number(a.n) || 0 })),
        targets: (targets || []).map((t) => t.target),
      });
    } catch (e) {
      if (e && e.code === 'ER_NO_SUCH_TABLE') {
        return res.json({ devices: [], offices: [], actors: [], versions: [], actions: [], targets: [] });
      }
      next(e);
    }
  });

  router.get('/api/activity.csv', guard, async (req, res, next) => {
    try {
      const { sql, args } = await where(req);
      const [rows] = await pool.query(
        `SELECT ${COLUMNS} FROM epos_activity_log ${sql} ORDER BY id ${req.query.order === 'asc' ? 'ASC' : 'DESC'} LIMIT 20000`,
        args
      );
      const cols = ['at', 'office', 'app', 'app_version', 'device_name', 'device_id', 'actor',
        'actor_type', 'customer_id', 'action', 'target', 'method', 'status', 'ms', 'detail', 'ip',
        'session_id'];
      const cell = (v) => {
        if (v === null || v === undefined) return '';
        let s = v instanceof Date ? v.toISOString() : String(v);
        // A cell starting with = + - @ is a formula to Excel.
        if (/^[=+\-@]/.test(s)) s = `'${s}`;
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="activity-${new Date().toISOString().slice(0, 10)}.csv"`);
      res.send(csv);
    } catch (e) {
      next(e);
    }
  });

  return { router, identify };
}

/** Paths that would drown the log. */
function skipActivity(req) {
  const p = (req.originalUrl || req.url || '').split('?')[0];
  if (p === '/activity/v1/events') return true;
  // A till's ten-minute "still here". Its connects and sign-ins are already in
  // bo_device_log.
  if (req.method === 'POST' && p === '/till/devices') return true;
  return false;
}

module.exports = { activityRoutes, skipActivity, APP_FOR_SCOPE };
