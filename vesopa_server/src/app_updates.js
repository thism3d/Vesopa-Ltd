/**
 * Which version of each Windows app a venue runs (admin.vesopa.com Versions,
 * 2026-10-05). See schema_app_updates.sql.
 *
 * Two halves:
 *
 *   devices   /api/licence/state (licences.js) calls seen() with what the
 *             device says it runs, and offerFor() to learn whether to tell it
 *             to move. The device asks every five minutes already, so this
 *             adds no new call and no new credential.
 *   admin     /api/admin/app-versions, for admin.vesopa.com: every pin and
 *             every device's version, and setting a pin for some venues or the
 *             default.
 *
 * Only a device that installed from our own installer is ever offered a
 * version: a Microsoft Store copy is updated by the Store, and an installer
 * run over it would put a second copy beside it, not replace it.
 *
 * FAILS OPEN, like the holds: a server without the tables, or a lookup that
 * fails, offers nothing and records nothing. A version check must never be
 * why a device cannot start.
 */
const express = require('express');

const APPS = ['till', 'kitchen', 'display', 'express', 'loyalty'];

/**
 * Each app's Microsoft Store product, for a Store copy told to update
 * (2026-10-08). A Store copy cannot run our installer -- that would put a
 * second, separate app beside it -- but it can be sent to its own page in the
 * Store, where the newer version is one press away.
 */
const STORE_IDS = {
  till: '9PDMNJXNFZCW',
  kitchen: '9P29NN3R5PGS',
  display: '9P8JCLQ5M3SQ',
  express: '9N5W5VLP2948',
  loyalty: '9N6VWPJ25VPH',
};
const DEFAULT = '*';
const isMissing = (e) => e && (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR');
const clamp = (v, n) => {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, n) : null;
};

/** 1.14.2, 1.14.2.0 and 1.14.2+50 are the same version. */
function normalise(v) {
  const s = String(v || '').trim().split('+')[0];
  const parts = s.split('.').map((p) => Number.parseInt(p, 10));
  if (!parts.length || parts.some((p) => !Number.isFinite(p) || p < 0)) return null;
  while (parts.length > 3 && parts[parts.length - 1] === 0) parts.pop();
  return parts.join('.');
}

/** Negative when a is older than b. */
function compare(a, b) {
  const x = String(normalise(a) || '0').split('.').map(Number);
  const y = String(normalise(b) || '0').split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

async function enabled(db) {
  try {
    const [[row]] = await db.query("SELECT v FROM bo_app_update_settings WHERE k = 'enabled'");
    return !!(row && row.v === '1');
  } catch (e) {
    if (!isMissing(e)) console.warn('[app_updates] settings:', e.message);
    return false;
  }
}

/** Note what a device runs. Never throws. */
async function seen(db, { office, app, deviceId, deviceName, version, install }) {
  if (!office || !APPS.includes(app) || !deviceId) return;
  try {
    await db.execute(
      `INSERT INTO bo_app_installs (office, app, device_id, device_name, version, install, last_seen_at)
       VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)
       ON DUPLICATE KEY UPDATE device_name = COALESCE(VALUES(device_name), device_name),
         version = VALUES(version), install = VALUES(install), last_seen_at = CURRENT_TIMESTAMP`,
      [office, app, clamp(deviceId, 64), clamp(deviceName, 120), clamp(version, 32),
        install === 'store' || install === 'direct' ? install : null]
    );
  } catch (e) {
    if (!isMissing(e)) console.warn('[app_updates] seen:', e.message);
  }
}

/** The pin that applies to a venue: its own, else the default, else none. */
async function pinFor(db, office, app) {
  const [rows] = await db.query(
    'SELECT * FROM bo_app_pins WHERE app = ? AND office IN (?, ?)',
    [app, office || DEFAULT, DEFAULT]
  );
  return rows.find((r) => r.office === office) || rows.find((r) => r.office === DEFAULT) || null;
}

/**
 * What to tell a device about its version, or null to say nothing.
 *
 * `version` is what the device runs. Older AND newer pins are both offered:
 * moving a venue back is the point ("I can downgrade them").
 */
async function offerFor(db, { office, app, version, install, storeCheck = false }) {
  if ((install !== 'direct' && install !== 'store') || !APPS.includes(app) || !normalise(version)) return null;
  try {
    if (!(await enabled(db))) return null;
    const pin = await pinFor(db, office, app);
    if (!pin || !pin.version) return null;
    const direction = compare(pin.version, version);
    if (direction === 0) return null;
    // A Microsoft Store copy (2026-10-08): only forward -- the Store cannot
    // go back a version. "It should act the same way no matter" (the owner):
    // a copy that can ask the Store itself whether the update is there yet
    // (storeCheck, X-Vesopa-Store-Check, from EPOS 1.15.1 on) is told
    // straight away and updates in place. An older one (1.15.0) can only open
    // its Store page, so it waits for the "live on the Store" mark (store_ok).
    if (install === 'store') {
      if (!STORE_IDS[app]) return null;
      if (direction < 0) {
        // Set back: the Store cannot go back, so a copy that knows how
        // (storeCheck) moves to our installer, data and all -- "I need to move
        // back" (the owner). switch says so; the installer is the venue's.
        if (!storeCheck || !pin.url || !pin.sha256) return null;
        return {
          version: normalise(pin.version), url: pin.url, sha256: pin.sha256,
          size: pin.size == null ? null : Number(pin.size), downgrade: true, switch: true,
        };
      }
      if (!storeCheck && !Number(pin.store_ok)) return null;
      return { version: normalise(pin.version), store: true, store_id: STORE_IDS[app], downgrade: false };
    }
    if (!pin.url || !pin.sha256) return null;
    return {
      version: normalise(pin.version),
      url: pin.url,
      sha256: pin.sha256,
      size: pin.size == null ? null : Number(pin.size),
      downgrade: direction < 0,
    };
  } catch (e) {
    if (!isMissing(e)) console.warn('[app_updates] offer:', e.message);
    return null;
  }
}

/** The device half's headers, read once. */
function fromHeaders(req) {
  return {
    version: clamp(req.get('x-vesopa-app-version'), 32),
    deviceId: clamp(req.get('x-vesopa-device-id'), 64),
    deviceName: clamp(req.get('x-vesopa-device-name'), 120),
    install: clamp(req.get('x-vesopa-install'), 8),
    storeCheck: req.get('x-vesopa-store-check') === '1',
  };
}

/**
 * Loyalty has no venue credential (it is a member's app), so it asks here,
 * in the open, and follows the default only. Under /loyalty/v1/, which
 * loyalty.vesopa.com passes through to this server (loyalty_host.js).
 */
function publicRoutes({ pool }) {
  const router = express.Router();
  router.get('/loyalty/v1/app-update', async (req, res) => {
    const app = 'loyalty';
    const h = fromHeaders(req);
    res.set('Cache-Control', 'no-store');
    res.json({ update: await offerFor(pool, { office: DEFAULT, app, version: h.version || req.query.version, install: h.install || req.query.install, storeCheck: h.storeCheck }) });
  });
  return router;
}

/** Mounted under /api/admin behind requireAuth + admin, like the holds. */
function adminRoutes({ pool, broadcast, auth, admin }) {
  const router = express.Router();

  router.get('/app-versions', auth, admin, async (req, res, next) => {
    try {
      const app = req.query.app ? String(req.query.app) : null;
      if (app && !APPS.includes(app)) return res.status(400).json({ error: 'No such app.' });
      let pins = [];
      let devices = [];
      try {
        [pins] = await pool.query(
          `SELECT p.*, o.id AS office_id FROM bo_app_pins p LEFT JOIN offices o ON o.contact_email = p.office
            ${app ? 'WHERE p.app = ?' : ''}`, app ? [app] : []);
        [devices] = await pool.query(
          `SELECT i.*, o.id AS office_id FROM bo_app_installs i JOIN offices o ON o.contact_email = i.office
            WHERE i.last_seen_at > DATE_SUB(NOW(), INTERVAL 60 DAY) ${app ? 'AND i.app = ?' : ''}
            ORDER BY i.last_seen_at DESC`, app ? [app] : []);
      } catch (e) {
        if (!isMissing(e)) throw e;
      }
      const shape = (p) => ({
        office_id: p.office === DEFAULT ? null : p.office_id, default: p.office === DEFAULT, app: p.app,
        version: p.version, url: p.url, sha256: p.sha256, size: p.size == null ? null : Number(p.size),
        store: !!Number(p.store_ok || 0), set_by: p.set_by, set_at: p.set_at,
      });
      res.json({
        enabled: await enabled(pool),
        apps: APPS,
        pins: pins.map(shape),
        devices: devices.map((d) => ({
          office_id: d.office_id, app: d.app, device_id: d.device_id, device_name: d.device_name,
          version: d.version, install: d.install, last_seen_at: d.last_seen_at,
        })),
      });
    } catch (e) {
      next(e);
    }
  });

  /**
   * Set (or clear) the version for some venues, or the default.
   *
   * body: { offices: [ids] | 'default', version, url, sha256, size }
   *   version null   -> "No auto updates" (a row with no version)
   *   clear: true    -> drop the venues' own rows so they follow the default
   */
  router.put('/app-versions/:app', auth, admin, async (req, res, next) => {
    try {
      const app = String(req.params.app);
      if (!APPS.includes(app)) return res.status(400).json({ error: 'No such app.' });
      const b = req.body || {};
      let offices;
      if (b.offices === 'default') {
        offices = [DEFAULT];
      } else {
        const ids = [].concat(b.offices || []).map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 2000);
        if (!ids.length) return res.status(400).json({ error: 'Choose at least one venue.' });
        const [rows] = await pool.query('SELECT contact_email FROM offices WHERE id IN (?)', [ids]);
        offices = rows.map((r) => r.contact_email).filter(Boolean);
        if (!offices.length) return res.status(404).json({ error: 'No such venues.' });
      }
      const by = clamp(req.user && req.user.email, 190);
      if (b.clear === true) {
        if (offices[0] === DEFAULT) {
          await pool.query('DELETE FROM bo_app_pins WHERE app = ? AND office = ?', [app, DEFAULT]);
        } else {
          await pool.query('DELETE FROM bo_app_pins WHERE app = ? AND office IN (?)', [app, offices]);
        }
      } else {
        const version = b.version == null || b.version === '' ? null : normalise(b.version);
        if (b.version && !version) return res.status(400).json({ error: 'That is not a version number.' });
        // A version is reached through our installer (url + sha256), the
        // Microsoft Store (store: true), or both. Store only is a version that
        // was never built as an installer: direct copies are not offered it.
        const store = !!version && b.store === true;
        const hasFile = !!version && b.url != null && b.url !== '';
        const sha = hasFile ? String(b.sha256 || '').toLowerCase() : null;
        if (version && hasFile && (!/^[0-9a-f]{64}$/.test(sha) || !/^https:\/\/\S+$/.test(String(b.url || '')))) {
          return res.status(400).json({ error: 'A version needs its download address and SHA-256.' });
        }
        if (version && !hasFile && !store) {
          return res.status(400).json({ error: 'A version needs its download address and SHA-256, or to be on the Microsoft Store.' });
        }
        for (const office of offices) {
          await pool.execute(
            `INSERT INTO bo_app_pins (office, app, version, url, sha256, size, store_ok, set_by, set_at)
             VALUES (?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
             ON DUPLICATE KEY UPDATE version = VALUES(version), url = VALUES(url), sha256 = VALUES(sha256),
               size = VALUES(size), store_ok = VALUES(store_ok), set_by = VALUES(set_by), set_at = CURRENT_TIMESTAMP`,
            [office, app, version, hasFile ? String(b.url).slice(0, 500) : null, sha,
              hasFile && b.size != null ? Number(b.size) || null : null, store ? 1 : 0, by]
          );
        }
      }
      // Devices re-ask /licence/state when the settings broadcast arrives.
      if (broadcast) {
        for (const office of offices) if (office !== DEFAULT) broadcast({ type: 'till-settings', office }, { office });
      }
      res.json({ ok: true, changed: offices.length });
    } catch (e) {
      next(e);
    }
  });

  router.put('/app-versions-settings', auth, admin, async (req, res, next) => {
    try {
      const on = req.body && req.body.enabled === true;
      await pool.execute(
        "INSERT INTO bo_app_update_settings (k, v) VALUES ('enabled', ?) ON DUPLICATE KEY UPDATE v = VALUES(v)",
        [on ? '1' : '0']
      );
      res.json({ ok: true, enabled: on });
    } catch (e) {
      next(e);
    }
  });

  return router;
}

module.exports = { APPS, STORE_IDS, DEFAULT, normalise, compare, enabled, seen, pinFor, offerFor, fromHeaders, publicRoutes, adminRoutes };
