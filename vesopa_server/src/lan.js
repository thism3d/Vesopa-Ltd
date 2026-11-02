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
 * Vesopa support (2026-11-02), a platform admin only:
 *   GET  /api/lan/support-code   today's code that opens the till's page
 *   POST /api/lan/commands       test or act on a device, through the main till
 *   GET  /api/lan/commands/:id   how that went
 * And the till's side of it: GET /api/lan/devices, GET /api/lan/commands,
 * POST /api/lan/commands/:id/result, POST /api/lan/main-till.
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
        hosts          VARCHAR(600) NULL,
        updated_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )`);
      // Added 2026-11-02, for a table made before it.
      await pool.query('ALTER TABLE epos_lan_settings ADD COLUMN hosts VARCHAR(600) NULL')
        .catch((e) => { if (e.code !== 'ER_DUP_FIELDNAME') throw e; });
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
      await pool.query(`CREATE TABLE IF NOT EXISTS epos_lan_commands (
        id          BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
        office      VARCHAR(190) NOT NULL,
        target      VARCHAR(80)  NOT NULL,
        action      VARCHAR(24)  NOT NULL,
        status      VARCHAR(12)  NOT NULL DEFAULT 'pending',
        result      TEXT         NULL,
        created_by  VARCHAR(190) NULL,
        created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        done_at     TIMESTAMP    NULL,
        KEY idx_lan_commands_office (office, status)
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

/** Addresses from a box or a stored list: IPv4 only, no more than 32. */
function hostsOf(raw) {
  const list = Array.isArray(raw) ? raw : String(raw || '').split(/[\s,]+/);
  return [...new Set(list.map((h) => String(h).trim())
    .filter((h) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h) && h.split('.').every((n) => Number(n) <= 255)))].slice(0, 32);
}

/**
 * The day's code that opens the till's Connected devices page. Made from the
 * venue key, so a till can check it with the internet down, and different for
 * every venue and every day (UTC).
 */
function supportCode(secret, office, day = new Date()) {
  const date = day.toISOString().slice(0, 10);
  const mac = crypto.createHmac('sha256', Buffer.from(lanKey(secret, office), 'hex'))
    .update(`vesopa-lan-support|${date}`)
    .digest();
  return String(mac.readUInt32BE(0) % 1000000).padStart(6, '0');
}

/**
 * Who may use Vesopa support's tools (2026-11-02): a platform admin, the
 * addresses the owner named, and anybody a platform admin grants it to in the
 * back office (backoffice_users.lan_support). Not platform admin: it opens the
 * support tools for the venue that login is in, and nothing else.
 */
const SUPPORT_EMAILS = new Set(['info@vesopa.com', 'support@vesopa.com', 'info@vesopasoftware.com']);

const COMMANDS = new Set(['ping', 'speed', 'identify', 'restart', 'disconnect', 'takeover', 'fullcheck']);

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
    const office = String(req.office || (req.body && req.body.office) || req.query.office || '').trim();
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

function lanRoutes({ pool, secret, broadcast = () => {} }) {
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
      const [[settings]] = await pool.query('SELECT preferred_hub, hosts FROM epos_lan_settings WHERE office = ?', [office]);
      // Where the venue's tills said they were this month, and any addresses
      // set in the back office: tried directly as well, for a network that
      // drops broadcasts or puts its Wi-Fi on another subnet.
      const [rows] = await pool.query(
        `SELECT device, role, report FROM epos_lan_reports
          WHERE office = ? AND updated_at > DATE_SUB(NOW(), INTERVAL 30 DAY)`,
        [office]
      );
      const targets = hostsOf(settings && settings.hosts);
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
      const [[settings]] = await pool.query('SELECT preferred_hub, hosts FROM epos_lan_settings WHERE office = ?', [office]);
      const [conflicts] = await pool.query(
        `SELECT id, device, kind, ref, detail, created_at FROM epos_lan_conflicts
          WHERE office = ? ORDER BY id DESC LIMIT 50`,
        [office]
      );
      res.json({
        support: await isSupport(req.user),
        platform_admin: req.user.role === 'admin',
        preferred_hub: settings ? settings.preferred_hub : null,
        hosts: hostsOf(settings && settings.hosts),
        ports: { tcp: 47821, udp: 47820 },
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
      const body = req.body || {};
      if ('preferred_hub' in body) {
        const hub = clamp(body.preferred_hub, 64) || null;
        await pool.execute(
          `INSERT INTO epos_lan_settings (office, preferred_hub) VALUES (?, ?)
           ON DUPLICATE KEY UPDATE preferred_hub = VALUES(preferred_hub)`,
          [office, hub]
        );
      }
      if ('hosts' in body) {
        const hosts = hostsOf(body.hosts).join(',');
        await pool.execute(
          `INSERT INTO epos_lan_settings (office, hosts) VALUES (?, ?)
           ON DUPLICATE KEY UPDATE hosts = VALUES(hosts)`,
          [office, hosts || null]
        );
      }
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  // ---- Vesopa support ------------------------------------------------------

  let supportColumn = null;
  function ensureSupportColumn() {
    if (!supportColumn) {
      supportColumn = pool
        .query('ALTER TABLE backoffice_users ADD COLUMN lan_support TINYINT(1) NOT NULL DEFAULT 0')
        .then(() => true)
        .catch((e) => e && (e.code === 'ER_DUP_FIELDNAME' || e.errno === 1060));
    }
    return supportColumn;
  }

  async function isSupport(user) {
    if (!user) return false;
    if (user.role === 'admin') return true;
    if (SUPPORT_EMAILS.has(String(user.email || '').toLowerCase())) return true;
    if (!(await ensureSupportColumn())) return false;
    try {
      const [[row]] = await pool.query(
        'SELECT lan_support FROM backoffice_users WHERE LOWER(email) = ?',
        [String(user.email || '').toLowerCase()]
      );
      return !!(row && Number(row.lan_support) === 1);
    } catch {
      return false;
    }
  }

  const supportOnly = async (req, res, next) => {
    try {
      if (!(await isSupport(req.user))) {
        return res.status(403).json({ error: 'This is for Vesopa support.' });
      }
      next();
    } catch (e) { next(e); }
  };

  const adminOnly = (req, res, next) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only a Vesopa platform admin can do this.' });
    next();
  };

  /** Who has Vesopa support, for the back office. */
  router.get('/api/lan/support-users', auth, adminOnly, async (req, res, next) => {
    try {
      const has = await ensureSupportColumn();
      const [rows] = has
        ? await pool.query(
          `SELECT u.email, u.name, o.name AS office FROM backoffice_users u
             LEFT JOIN offices o ON o.id = u.office_id WHERE u.lan_support = 1 ORDER BY u.email`)
        : [[]];
      res.json({ always: [...SUPPORT_EMAILS], granted: rows });
    } catch (e) { next(e); }
  });

  /** Give or take away Vesopa support for a back-office login, by its address. */
  router.put('/api/lan/support-users', auth, adminOnly, async (req, res, next) => {
    try {
      const email = String((req.body && req.body.email) || '').trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Type the email address of a back-office login.' });
      if (!(await ensureSupportColumn())) return res.status(500).json({ error: 'The database would not take the setting.' });
      const [r] = await pool.execute(
        'UPDATE backoffice_users SET lan_support = ? WHERE LOWER(email) = ?',
        [req.body.on === false ? 0 : 1, email]
      );
      if (!r.affectedRows) {
        return res.status(404).json({ error: `There is no back-office login for ${email}. Add it under Back Office Users first.` });
      }
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  /** What the venue's devices last reported, for the till's own page. */
  router.get('/api/lan/devices', device, async (req, res, next) => {
    try {
      await ensureTables(pool);
      const [rows] = await pool.query(
        `SELECT device, role, name, version, report,
                TIMESTAMPDIFF(SECOND, updated_at, NOW()) AS age_s
           FROM epos_lan_reports
          WHERE office = ? AND updated_at > DATE_SUB(NOW(), INTERVAL 30 DAY)
          ORDER BY role, name`,
        [req.device.office]
      );
      res.json({
        devices: rows.map((r) => {
          let report = {};
          try { report = JSON.parse(r.report || '{}'); } catch { /* empty */ }
          return { device: r.device, role: r.role, name: r.name, version: r.version, age_s: Number(r.age_s), report };
        }),
      });
    } catch (e) { next(e); }
  });

  /** A till that has just been made the main one, so it stays so. */
  router.post('/api/lan/main-till', device, async (req, res, next) => {
    try {
      await ensureTables(pool);
      if (req.device.scope !== 'terminal') return res.status(403).json({ error: 'Only a till can do this.' });
      const hub = clamp(req.body && req.body.device, 64);
      if (!hub) return res.status(400).json({ error: 'device is required' });
      await pool.execute(
        `INSERT INTO epos_lan_settings (office, preferred_hub) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE preferred_hub = VALUES(preferred_hub)`,
        [req.device.office, hub]
      );
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  router.get('/api/lan/support-code', auth, supportOnly, async (req, res, next) => {
    try {
      res.json({ code: supportCode(secret, await tenantEmail(req)) });
    } catch (e) { next(e); }
  });

  router.post('/api/lan/commands', auth, supportOnly, async (req, res, next) => {
    try {
      await ensureTables(pool);
      const office = await tenantEmail(req);
      const target = clamp(req.body && req.body.target, 80);
      const action = clamp(req.body && req.body.action, 24);
      if (!target || !COMMANDS.has(action)) return res.status(400).json({ error: 'target and action are required' });
      const [r] = await pool.execute(
        'INSERT INTO epos_lan_commands (office, target, action, created_by) VALUES (?, ?, ?, ?)',
        [office, target, action, clamp(req.user.email, 190)]
      );
      broadcast({ type: 'lan.command' }, { office });
      res.json({ ok: true, id: r.insertId });
    } catch (e) { next(e); }
  });

  router.get('/api/lan/commands/:id', auth, supportOnly, async (req, res, next) => {
    try {
      await ensureTables(pool);
      const [[row]] = await pool.query(
        'SELECT id, target, action, status, result FROM epos_lan_commands WHERE id = ? AND office = ?',
        [req.params.id, await tenantEmail(req)]
      );
      if (!row) return res.status(404).json({ error: 'No such command.' });
      let result = null;
      try { result = JSON.parse(row.result || 'null'); } catch { /* plain */ }
      res.json({ ...row, result });
    } catch (e) { next(e); }
  });

  /** The main till collects what is waiting; anything over five minutes is stale. */
  router.get('/api/lan/commands', device, async (req, res, next) => {
    try {
      await ensureTables(pool);
      if (req.device.scope !== 'terminal') return res.json({ commands: [] });
      const [rows] = await pool.query(
        `SELECT id, target, action FROM epos_lan_commands
          WHERE office = ? AND status = 'pending' AND created_at > DATE_SUB(NOW(), INTERVAL 5 MINUTE)
          ORDER BY id LIMIT 10`,
        [req.device.office]
      );
      const taken = [];
      for (const r of rows) {
        const [u] = await pool.execute(
          `UPDATE epos_lan_commands SET status = 'running' WHERE id = ? AND status = 'pending'`,
          [r.id]
        );
        if (u.affectedRows) taken.push(r);
      }
      res.json({ commands: taken });
    } catch (e) { next(e); }
  });

  router.post('/api/lan/commands/:id/result', device, async (req, res, next) => {
    try {
      await ensureTables(pool);
      const b = req.body || {};
      await pool.execute(
        `UPDATE epos_lan_commands SET status = ?, result = ?, done_at = NOW() WHERE id = ? AND office = ?`,
        [b.ok === false ? 'failed' : 'done', JSON.stringify(b.result ?? null).slice(0, 60000), req.params.id, req.device.office]
      );
      res.json({ ok: true });
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

module.exports = { lanRoutes, offlineOnce, ensureTables, lanKey, supportCode };
