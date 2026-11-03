/**
 * Device health and the fleet (2026-11-03).
 *
 * Three halves:
 *
 *   devices   POST /till/health: a till, kitchen screen or display sends what
 *             Settings > Network and hardware shows (adapters, Wi-Fi, hotspot,
 *             Bluetooth, USB, warnings) every ten minutes and on a change.
 *   venue     GET /api/devices/health for the back office's Devices page, and
 *             POST /api/app-installs/update: a venue Vesopa has allowed to
 *             update itself moves an app to Vesopa's approved version (the
 *             default pin) now, at a time, or on the till's next prompt.
 *   admin     GET /api/admin/fleet: every device of every venue with its
 *             versions, health and error counts; /api/admin/fleet/logs: the
 *             errors and warnings a device sent; PUT /api/admin/venue-self-updates.
 *
 * A venue can only ever move to the version Vesopa set as the default for
 * everybody, never to one of its own choosing, and only once admin.vesopa.com
 * has said it may (bo_venue_self_updates).
 *
 * The table makes itself on first use, and FAILS OPEN like app_updates: a
 * health report that cannot be stored is dropped, never an error on the till.
 */
const express = require('express');
const { requireTerminal } = require('./auth');
const appUpdates = require('./app_updates');

const clamp = (v, n) => {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, n) : null;
};
const isMissing = (e) => e && (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR');

let ensured = false;
async function ensureTable(pool) {
  if (ensured) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS bo_device_health (
    office      VARCHAR(190) NOT NULL,
    device_id   VARCHAR(64)  NOT NULL,
    app         VARCHAR(32)  NULL,
    app_version VARCHAR(32)  NULL,
    device_name VARCHAR(120) NULL,
    snapshot    MEDIUMTEXT   NULL,
    warnings    INT          NOT NULL DEFAULT 0,
    updated_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (office, device_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await pool.query(`CREATE TABLE IF NOT EXISTS bo_venue_self_updates (
    office      VARCHAR(190) NOT NULL PRIMARY KEY,
    allowed     TINYINT(1)   NOT NULL DEFAULT 0,
    set_by      VARCHAR(190) NULL,
    updated_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  ensured = true;
}

/**
 * Keep only what a manager reads: no MAC-level noise beyond what the till
 * already shows, and a hard size cap so a broken till cannot fill the table.
 */
function cleanSnapshot(s) {
  if (!s || typeof s !== 'object') return null;
  const list = (v, n) => (Array.isArray(v) ? v.slice(0, n) : []);
  const pick = (o, keys) => {
    const out = {};
    for (const k of keys) if (o && o[k] != null) out[k] = typeof o[k] === 'string' ? o[k].slice(0, 200) : o[k];
    return out;
  };
  const out = {
    os: clamp(s.os, 120),
    cpu: clamp(s.cpu, 120),
    memory_mb: Number.isFinite(Number(s.memory_mb)) ? Number(s.memory_mb) : null,
    disk_free_gb: Number.isFinite(Number(s.disk_free_gb)) ? Number(s.disk_free_gb) : null,
    uptime_h: Number.isFinite(Number(s.uptime_h)) ? Number(s.uptime_h) : null,
    online_via: clamp(s.online_via, 120),
    adapters: list(s.adapters, 12).map((a) => pick(a, ['name', 'kind', 'status', 'ipv4', 'gateway', 'speed', 'category', 'ssid', 'signal'])),
    hotspot: s.hotspot && typeof s.hotspot === 'object' ? pick(s.hotspot, ['supported', 'on', 'ssid', 'clients']) : null,
    bluetooth: clamp(s.bluetooth, 24),
    devices: list(s.devices, 40).map((d) => pick(d, ['name', 'kind', 'status', 'problem'])),
    printers: list(s.printers, 12).map((p) => pick(p, ['name', 'status', 'kind'])),
    warnings: list(s.warnings, 20).map((w) => String(w).slice(0, 240)),
    helper: clamp(s.helper, 24),
    local_link: clamp(s.local_link, 60),
  };
  const text = JSON.stringify(out);
  return text.length > 60000 ? null : out;
}

/** The venue's office (contact email) for a back-office user. */
async function officeOf(pool, user) {
  if (user.officeId) {
    const [[o]] = await pool.query('SELECT contact_email FROM offices WHERE id = ?', [user.officeId]);
    if (o) return o.contact_email;
  }
  return user.email;
}

async function mayUpdateItself(pool, office) {
  try {
    await ensureTable(pool);
    const [[row]] = await pool.query('SELECT allowed FROM bo_venue_self_updates WHERE office = ?', [office]);
    return !!(row && Number(row.allowed));
  } catch (e) {
    if (!isMissing(e)) console.warn('[device_health] venue_self:', e.message);
    return false;
  }
}

function deviceHealthRoutes({ pool, secret, auth, admin, broadcast }) {
  const router = express.Router();

  router.post('/till/health', requireTerminal(secret), express.json({ limit: '128kb' }), async (req, res) => {
    try {
      const b = req.body || {};
      const deviceId = clamp(b.device_id, 64);
      if (!deviceId) return res.status(400).json({ error: 'No device.' });
      const snapshot = cleanSnapshot(b.snapshot);
      await ensureTable(pool);
      await pool.execute(
        `INSERT INTO bo_device_health (office, device_id, app, app_version, device_name, snapshot, warnings)
         VALUES (?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE app = VALUES(app), app_version = VALUES(app_version), device_name = VALUES(device_name),
           snapshot = VALUES(snapshot), warnings = VALUES(warnings), updated_at = CURRENT_TIMESTAMP`,
        [req.office, deviceId, clamp(b.app, 32), clamp(b.app_version, 32), clamp(b.device_name, 120),
          snapshot ? JSON.stringify(snapshot) : null, snapshot ? snapshot.warnings.length : 0]);
      res.json({ ok: true });
    } catch (e) {
      console.warn('[device_health] report:', e.message);
      res.json({ ok: false });
    }
  });

  router.get('/api/devices/health', auth, async (req, res, next) => {
    try {
      const office = await officeOf(pool, req.user);
      let rows = [];
      try {
        await ensureTable(pool);
        [rows] = await pool.query(
          'SELECT device_id, app, app_version, device_name, snapshot, warnings, updated_at FROM bo_device_health WHERE office = ? ORDER BY device_name',
          [office]);
      } catch (e) { if (!isMissing(e)) throw e; }
      res.json({
        can_update: await mayUpdateItself(pool, office),
        devices: rows.map((r) => ({ ...r, snapshot: r.snapshot ? JSON.parse(r.snapshot) : null })),
      });
    } catch (e) { next(e); }
  });

  /**
   * The venue moves an app to Vesopa's approved version: the default pin is
   * copied into the venue's own row, with the venue's choice of when.
   * body: { app, mode: 'now' | 'at' | 'ask', install_at }
   */
  router.post('/api/app-installs/update', auth, express.json(), async (req, res, next) => {
    try {
      const office = await officeOf(pool, req.user);
      if (!(await mayUpdateItself(pool, office))) {
        return res.status(403).json({ error: 'Updates for this venue are set by Vesopa. Ask Vesopa support to move your tills, or to let you do it here.' });
      }
      const b = req.body || {};
      const app = String(b.app || '');
      if (!appUpdates.APPS.includes(app)) return res.status(400).json({ error: 'No such app.' });
      const [[def]] = await pool.query('SELECT * FROM bo_app_pins WHERE app = ? AND office = ?', [app, appUpdates.DEFAULT]);
      if (!def || !def.version) return res.status(409).json({ error: 'Vesopa has no approved version of this app to move to yet.' });
      const mode = b.mode === 'now' || b.mode === 'at' ? b.mode : 'ask';
      let at = null;
      if (mode === 'at') {
        const t = new Date(String(b.install_at || ''));
        if (Number.isNaN(t.getTime()) || t.getTime() < Date.now() - 60000) return res.status(400).json({ error: 'Choose a time from now on.' });
        at = t.toISOString();
      }
      const by = clamp(`${req.user.email || 'venue'} (back office)`, 190);
      await pool.execute(
        `INSERT INTO bo_app_pins (office, app, version, url, sha256, size, store_ok, set_by, set_at, mode, install_at, force_update)
         VALUES (?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,?,?,0)
         ON DUPLICATE KEY UPDATE version = VALUES(version), url = VALUES(url), sha256 = VALUES(sha256), size = VALUES(size),
           store_ok = VALUES(store_ok), set_by = VALUES(set_by), set_at = CURRENT_TIMESTAMP, mode = VALUES(mode),
           install_at = VALUES(install_at), force_update = 0`,
        [office, app, def.version, def.url, def.sha256, def.size, def.store_ok || 0, by, mode, at]);
      if (broadcast) broadcast({ type: 'till-settings', office }, { office });
      res.json({ ok: true, version: appUpdates.normalise(def.version), mode, install_at: at });
    } catch (e) { next(e); }
  });

  // ---- admin.vesopa.com ----------------------------------------------------

  router.get('/api/admin/fleet', auth, admin, async (req, res, next) => {
    try {
      const officeId = Number(req.query.office_id) || null;
      const where = officeId ? 'WHERE o.id = ?' : '';
      const args = officeId ? [officeId] : [];
      const [offices] = await pool.query(`SELECT o.id, o.name, o.contact_email FROM offices o ${where}`, args);
      const emails = offices.map((o) => o.contact_email).filter(Boolean);
      if (!emails.length) return res.json({ venues: [] });
      const q = async (sql, a) => {
        try { const [r] = await pool.query(sql, a); return r; } catch (e) { if (isMissing(e)) return []; throw e; }
      };
      await ensureTable(pool).catch(() => {});
      const [devices, installs, health, errors, pins, selfRows] = await Promise.all([
        q('SELECT office, device_id, kind, name, signed_in_as, app_version, ip_address, online, last_seen_at FROM bo_devices WHERE office IN (?)', [emails]),
        q(`SELECT office, app, device_id, device_name, version, install, last_seen_at FROM bo_app_installs
            WHERE office IN (?) AND last_seen_at > DATE_SUB(NOW(), INTERVAL 60 DAY)`, [emails]),
        q('SELECT office, device_id, app, app_version, device_name, snapshot, warnings, updated_at FROM bo_device_health WHERE office IN (?)', [emails]),
        q(`SELECT office, device_id, SUM(at > DATE_SUB(NOW(), INTERVAL 1 DAY)) AS day, COUNT(*) AS week, MAX(at) AS last_at
             FROM epos_activity_log WHERE office IN (?) AND action = 'error' AND at > DATE_SUB(NOW(), INTERVAL 7 DAY)
              AND device_id IS NOT NULL GROUP BY office, device_id`, [emails]),
        q('SELECT office, app, version, mode, install_at, set_by, set_at FROM bo_app_pins WHERE office IN (?)', [[...emails, appUpdates.DEFAULT]]),
        q('SELECT office, allowed FROM bo_venue_self_updates WHERE office IN (?)', [emails]),
      ]);
      const selfOn = new Set(selfRows.filter((r) => Number(r.allowed)).map((r) => r.office));
      const byOffice = (rows, email) => rows.filter((r) => r.office === email);
      res.json({
        updates_on: await appUpdates.enabled(pool),
        defaults: pins.filter((p) => p.office === appUpdates.DEFAULT),
        venues: offices.map((o) => {
          const e = o.contact_email;
          const errs = byOffice(errors, e);
          const hs = byOffice(health, e);
          // One row per machine: bo_devices (tills, displays, Go) and the
          // installs that never registered there (kitchen screens), by id.
          const ids = new Map();
          for (const d of byOffice(devices, e)) ids.set(d.device_id, { device_id: d.device_id, kind: d.kind, name: d.name, online: !!d.online, last_seen_at: d.last_seen_at, ip: d.ip_address, signed_in_as: d.signed_in_as, app_version: d.app_version, apps: [] });
          for (const i of byOffice(installs, e)) {
            if (!ids.has(i.device_id)) ids.set(i.device_id, { device_id: i.device_id, kind: i.app, name: i.device_name, online: null, last_seen_at: i.last_seen_at, apps: [] });
            ids.get(i.device_id).apps.push({ app: i.app, version: appUpdates.normalise(i.version) || i.version, install: i.install, last_seen_at: i.last_seen_at });
          }
          for (const h of hs) {
            if (!ids.has(h.device_id)) ids.set(h.device_id, { device_id: h.device_id, kind: h.app, name: h.device_name, online: null, last_seen_at: h.updated_at, apps: [] });
            const d = ids.get(h.device_id);
            d.health = { at: h.updated_at, warnings: h.warnings, snapshot: h.snapshot ? JSON.parse(h.snapshot) : null };
          }
          for (const er of errs) {
            const d = ids.get(er.device_id);
            if (d) d.errors = { day: Number(er.day) || 0, week: Number(er.week) || 0, last_at: er.last_at };
          }
          return {
            office_id: o.id, name: o.name, office: e, venue_self: selfOn.has(e),
            pins: byOffice(pins, e),
            errors_day: errs.reduce((s, r) => s + (Number(r.day) || 0), 0),
            devices: [...ids.values()].sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''))),
          };
        }),
      });
    } catch (e) { next(e); }
  });

  /** A device's errors and warnings (the apps' activity log), newest first. */
  router.get('/api/admin/fleet/logs', auth, admin, async (req, res, next) => {
    try {
      const officeId = Number(req.query.office_id);
      if (!officeId) return res.status(400).json({ error: 'Choose a venue.' });
      const [[o]] = await pool.query('SELECT contact_email FROM offices WHERE id = ?', [officeId]);
      if (!o) return res.status(404).json({ error: 'No such venue.' });
      const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 90);
      const level = req.query.level === 'all' ? 'all' : 'errors';
      const args = [o.contact_email, days];
      let extra = '';
      if (req.query.device_id) { extra += ' AND device_id = ?'; args.push(String(req.query.device_id).slice(0, 64)); }
      if (level === 'errors') extra += " AND (action IN ('error','warning','crash') OR status >= 500)";
      const [rows] = await pool.query(
        `SELECT at, app, app_version, device_id, device_name, actor, action, target, status, detail
           FROM epos_activity_log WHERE office = ? AND at > DATE_SUB(NOW(), INTERVAL ? DAY)${extra}
          ORDER BY at DESC LIMIT 500`, args);
      res.json({ events: rows });
    } catch (e) {
      if (isMissing(e)) return res.json({ events: [] });
      next(e);
    }
  });

  /** body: { office_ids: [..], on: true|false } */
  router.put('/api/admin/venue-self-updates', auth, admin, express.json(), async (req, res, next) => {
    try {
      const ids = [].concat((req.body && req.body.office_ids) || []).map(Number).filter((n) => n > 0).slice(0, 2000);
      if (!ids.length) return res.status(400).json({ error: 'Choose at least one venue.' });
      const on = req.body.on === true;
      const [rows] = await pool.query('SELECT contact_email FROM offices WHERE id IN (?)', [ids]);
      await ensureTable(pool);
      const by = clamp(req.user && req.user.email, 190);
      for (const r of rows) {
        await pool.execute(
          `INSERT INTO bo_venue_self_updates (office, allowed, set_by) VALUES (?, ?, ?)
           ON DUPLICATE KEY UPDATE allowed = VALUES(allowed), set_by = VALUES(set_by)`,
          [r.contact_email, on ? 1 : 0, by]);
      }
      res.json({ ok: true, changed: rows.length, on });
    } catch (e) { next(e); }
  });

  return router;
}

module.exports = { deviceHealthRoutes, cleanSnapshot, mayUpdateItself };
