/**
 * The venue's local link, the back office's half (2026-10-27).
 *
 * Nicki, Pontardawe RFC: tills, kitchen screens and customer displays should
 * talk to each other over the venue's own network, so the table plan and the
 * kitchen keep going when the internet does not. The devices do the talking
 * (lib/data/lan/lan_link.dart in each app); this file gives them what they
 * cannot make for themselves:
 *
 *   GET  /api/lan/key        the venue's link key, to any of its devices
 *   POST /api/lan/report     what a device can see on the network (the check)
 *   GET  /api/lan/reports    the back office's Local network page
 *   PUT  /api/lan/settings   pin a main till
 *   POST /api/lan/conflicts  a change that lost when the link and the cloud met
 *   GET  /api/lan/conflicts  for the back office
 *
 * THE KEY. One per venue, derived from the server's secret and the venue, so
 * it needs no table and every device of the venue gets the same one. A device
 * proves it belongs with its own signed token -- a till's, a kitchen
 * screen's, a display's -- and a session token (a person) is not given it.
 * Changing `LAN_KEY_VERSION` re-keys every venue at once.
 */
const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const { requireAuth } = require('./auth');

const LAN_KEY_VERSION = 1;
const DEVICE_SCOPES = new Set(['terminal', 'kitchen', 'display']);

let ensured = null;
/** The three small tables, made on first use rather than by hand. */
function ensureTables(pool) {
  if (!ensured) {
    ensured = (async () => {
      await pool.query(`CREATE TABLE IF NOT EXISTS epos_lan_reports (
        office      VARCHAR(190) NOT NULL,
        device      VARCHAR(64)  NOT NULL,
        role        VARCHAR(16)  NOT NULL,
        name        VARCHAR(120) NULL,
        version     VARCHAR(24)  NULL,
        report      MEDIUMTEXT   NULL,
        updated_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (office, device)
      )`);
      await pool.query(`CREATE TABLE IF NOT EXISTS epos_lan_settings (
        office         VARCHAR(190) NOT NULL PRIMARY KEY,
        preferred_hub  VARCHAR(64)  NULL,
        updated_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )`);
      await pool.query(`CREATE TABLE IF NOT EXISTS epos_lan_conflicts (
        id          BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
        office      VARCHAR(190) NOT NULL,
        device      VARCHAR(64)  NULL,
        kind        VARCHAR(32)  NOT NULL,
        ref         VARCHAR(64)  NULL,
        detail      TEXT         NULL,
        created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        KEY idx_lan_conflicts_office (office, created_at)
      )`);
      await pool.query(`CREATE TABLE IF NOT EXISTS epos_lan_journal (
        office      VARCHAR(190) NOT NULL,
        id          VARCHAR(80)  NOT NULL,
        path        VARCHAR(80)  NOT NULL,
        status      SMALLINT     NULL,
        created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (office, id)
      )`);
    })().catch((e) => {
      ensured = null;
      throw e;
    });
  }
  return ensured;
}

function lanKey(secret, office) {
  return crypto
    .createHmac('sha256', String(secret))
    .update(`vesopa-lan-v${LAN_KEY_VERSION}|${String(office).toLowerCase()}`)
    .digest('hex');
}

function clamp(v, n) {
  return v == null ? null : String(v).slice(0, n);
}

/** Any of the venue's device tokens; sets req.device = {office, scope}. */
function requireDevice(secret) {
  return (req, res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    try {
      const claims = jwt.verify(String(token || ''), secret);
      if (!DEVICE_SCOPES.has(claims.scope) || !claims.office) throw new Error('scope');
      req.device = { office: claims.office, scope: claims.scope };
      next();
    } catch {
      res.status(401).json({ error: 'Only a signed-in device of the venue may join its local link.' });
    }
  };
}

/**
 * Money moved while the internet was down, replayed when it is back.
 *
 * The main till keeps points, gift cards and vouchers while offline and, once
 * the cloud answers again, sends each move to the route it would have used,
 * with `X-Vesopa-Offline-Id`. This lets each one through once: the id is
 * written first, a repeat is answered as done without running, and a move
 * that failed on the server (5xx) gives its id back so the next try can run.
 */
function offlineOnce(pool) {
  return async (req, res, next) => {
    const id = clamp(req.headers['x-vesopa-offline-id'], 80);
    if (!id) return next();
    const office = String((req.body && req.body.office) || req.query.office || '').trim();
    if (!office) return next();
    try {
      await ensureTables(pool);
      const [r] = await pool.execute(
        'INSERT IGNORE INTO epos_lan_journal (office, id, path) VALUES (?, ?, ?)',
        [office, id, clamp(req.path, 80)]
      );
      if (!r.affectedRows) {
        return res.json({ ok: true, duplicate: true });
      }
      res.on('finish', () => {
        const status = res.statusCode;
        const q = status >= 500
          ? pool.execute('DELETE FROM epos_lan_journal WHERE office = ? AND id = ?', [office, id])
          : pool.execute('UPDATE epos_lan_journal SET status = ? WHERE office = ? AND id = ?', [status, office, id]);
        q.catch(() => {});
      });
      next();
    } catch (e) {
      next(e);
    }
  };
}

function lanRoutes({ pool, secret }) {
  const router = express.Router();
  const device = requireDevice(secret);
  const auth = requireAuth(secret);

  async function tenantEmail(req) {
    if (req.user.officeId) {
      const [[office]] = await pool.query('SELECT contact_email FROM offices WHERE id = ?', [req.user.officeId]);
      if (office) return office.contact_email;
    }
    return req.user.email;
  }

  router.get('/api/lan/key', device, async (req, res, next) => {
    try {
      await ensureTables(pool);
      const office = req.device.office;
      const [[settings]] = await pool.query('SELECT preferred_hub FROM epos_lan_settings WHERE office = ?', [office]);
      // Where the venue's other devices said they were today: announced to
      // directly as well, for a network that drops broadcasts.
      const [rows] = await pool.query(
        `SELECT device, role, report FROM epos_lan_reports
          WHERE office = ? AND updated_at > DATE_SUB(NOW(), INTERVAL 1 DAY)`,
        [office]
      );
      const targets = [];
      for (const r of rows) {
        if (r.role !== 'till') continue;
        try {
          const rep = JSON.parse(r.report || '{}');
          for (const ip of rep.ips || []) targets.push(String(ip));
        } catch { /* a report that will not parse names nobody */ }
      }
      res.json({
        key: lanKey(secret, office),
        version: LAN_KEY_VERSION,
        preferred_hub: settings ? settings.preferred_hub : null,
        targets: [...new Set(targets)].slice(0, 32),
      });
    } catch (e) { next(e); }
  });

  router.post('/api/lan/report', device, async (req, res, next) => {
    try {
      await ensureTables(pool);
      const r = req.body || {};
      const id = clamp(r.device, 64);
      if (!id) return res.status(400).json({ error: 'device is required' });
      const text = JSON.stringify(r).slice(0, 60000);
      await pool.execute(
        `INSERT INTO epos_lan_reports (office, device, role, name, version, report)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE role = VALUES(role), name = VALUES(name),
           version = VALUES(version), report = VALUES(report), updated_at = NOW()`,
        [req.device.office, id, clamp(r.role, 16) || req.device.scope, clamp(r.name, 120), clamp(r.version, 24), text]
      );
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  router.get('/api/lan/reports', auth, async (req, res, next) => {
    try {
      await ensureTables(pool);
      const office = await tenantEmail(req);
      const [rows] = await pool.query(
        `SELECT device, role, name, version, report, updated_at,
                TIMESTAMPDIFF(SECOND, updated_at, NOW()) AS age_s
           FROM epos_lan_reports WHERE office = ? ORDER BY role, name`,
        [office]
      );
      const [[settings]] = await pool.query('SELECT preferred_hub FROM epos_lan_settings WHERE office = ?', [office]);
      const [conflicts] = await pool.query(
        `SELECT id, device, kind, ref, detail, created_at FROM epos_lan_conflicts
          WHERE office = ? ORDER BY id DESC LIMIT 50`,
        [office]
      );
      res.json({
        preferred_hub: settings ? settings.preferred_hub : null,
        devices: rows.map((r) => {
          let report = {};
          try { report = JSON.parse(r.report || '{}'); } catch { /* empty */ }
          return {
            device: r.device,
            role: r.role,
            name: r.name,
            version: r.version,
            updated_at: r.updated_at,
            age_s: Number(r.age_s),
            report,
          };
        }),
        conflicts,
      });
    } catch (e) { next(e); }
  });

  router.put('/api/lan/settings', auth, async (req, res, next) => {
    try {
      await ensureTables(pool);
      const office = await tenantEmail(req);
      const hub = clamp(req.body && req.body.preferred_hub, 64) || null;
      await pool.execute(
        `INSERT INTO epos_lan_settings (office, preferred_hub) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE preferred_hub = VALUES(preferred_hub)`,
        [office, hub]
      );
      res.json({ ok: true, preferred_hub: hub });
    } catch (e) { next(e); }
  });

  router.post('/api/lan/conflicts', device, async (req, res, next) => {
    try {
      await ensureTables(pool);
      const list = Array.isArray(req.body && req.body.conflicts) ? req.body.conflicts.slice(0, 100) : [];
      for (const c of list) {
        await pool.execute(
          'INSERT INTO epos_lan_conflicts (office, device, kind, ref, detail) VALUES (?, ?, ?, ?, ?)',
          [req.device.office, clamp(c.device, 64), clamp(c.kind, 32) || 'other', clamp(c.ref, 64),
            clamp(typeof c.detail === 'string' ? c.detail : JSON.stringify(c.detail ?? null), 4000)]
        );
      }
      res.json({ ok: true, logged: list.length });
    } catch (e) { next(e); }
  });

  return router;
}

module.exports = { lanRoutes, offlineOnce, ensureTables, lanKey };
