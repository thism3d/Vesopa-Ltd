const express = require('express');
const { requireAuth, requireTerminal } = require('./auth');

/**
 * Modules: parts of the system only some venues get.
 *
 * Vesopa admin ALLOWS a module for a venue (when it is created, or later), and
 * the venue's manager then turns it on or off. Both have to say yes before
 * anything the module owns appears in the back office, on a till, a kiosk or a
 * customer display. See schema_venue_modules.sql for why there are two
 * switches and why withdrawing a module never deletes its data.
 *
 * TENANCY
 *
 *   /api/admin/...      Vesopa admin only, any venue by id.
 *   /api/modules        the signed-in venue's own modules, session token.
 *   /till/modules       a commissioned device; the venue comes off the token.
 *
 * FAILS CLOSED, EXCEPT FOR THE GYM
 *
 * A server whose database has not had the migration yet answers "no modules"
 * -- with one exception. The gym door existed before modules did and was
 * switched by the manager alone, so on such a server it keeps behaving exactly
 * as it did. Nothing a venue runs today may vanish because a deploy ran the
 * code before the schema.
 */

/**
 * The catalogue. Adding a module is adding a line here; the admin screen, the
 * venue's Modules page and the till all read this list from the server.
 *
 * `managerSwitch` names where the manager's on/off lives when it is not the
 * `enabled` column of bo_venue_modules -- only the gym, whose switch predates
 * modules.
 */
const MODULES = [
  {
    key: 'memberships',
    label: 'Memberships',
    summary: 'Membership plans, joining fees, renewals, freezes, family plans and classes.',
  },
  {
    key: 'gym_door',
    label: 'Gym door',
    summary: 'Members swipe in and out at an unmanned door; attendance and expiry slips.',
    managerSwitch: 'gym',
  },
  {
    key: 'vehicle_access',
    label: 'Vehicle access',
    summary: 'Members register cars and number-plate cameras open the barrier.',
  },
];

const KEYS = new Set(MODULES.map((m) => m.key));

const isMissingTable = (e) =>
  e && (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR');

/** A whole number of pence from 0 to £10,000, or null for "use the default". */
function cleanPrice(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < 0 || n > 1_000_000) {
    const err = new Error('A module price must be between £0 and £10,000 a month.');
    err.status = 400;
    throw err;
  }
  return n;
}

async function defaultPrices(db) {
  try {
    const [rows] = await db.query('SELECT module, price_minor FROM bo_module_prices');
    return Object.fromEntries(rows.map((r) => [r.module, Number(r.price_minor) || 0]));
  } catch (e) {
    if (isMissingTable(e)) return {};
    throw e;
  }
}

async function officeRow(db, officeId) {
  const [[row]] = await db.query(
    'SELECT id, contact_email FROM offices WHERE id = ?',
    [officeId]
  );
  return row || null;
}

async function gymSwitch(db, email) {
  try {
    const [[row]] = await db.query(
      'SELECT enabled FROM epos_gym_settings WHERE office = ?',
      [email]
    );
    return !!(row && Number(row.enabled));
  } catch (e) {
    if (isMissingTable(e)) return false;
    throw e;
  }
}

/**
 * Every module for one venue: allowed, enabled, on (both), and price.
 *
 * `email` is the venue's contact email, the key the gym and most of the till
 * tables use; passed in when the caller already has it to save a lookup.
 */
async function modulesFor(db, officeId, email) {
  let rows = null;
  try {
    [rows] = await db.query(
      `SELECT module, allowed, enabled, price_minor, allowed_at, allowed_by
         FROM bo_venue_modules WHERE office_id = ?`,
      [officeId]
    );
  } catch (e) {
    if (!isMissingTable(e)) throw e;
  }
  const prices = await defaultPrices(db);
  const byKey = Object.fromEntries((rows || []).map((r) => [r.module, r]));

  const out = [];
  for (const m of MODULES) {
    const row = byKey[m.key];
    // No table at all: only the gym survives, on its old manager-only rule.
    let allowed = rows === null ? m.key === 'gym_door' : !!(row && Number(row.allowed));
    let enabled;
    if (m.managerSwitch === 'gym') {
      enabled = email ? await gymSwitch(db, email) : false;
    } else {
      enabled = !!(row && Number(row.enabled));
    }
    const price = row && row.price_minor !== null && row.price_minor !== undefined
      ? Number(row.price_minor)
      : (prices[m.key] ?? 0);
    out.push({
      key: m.key,
      label: m.label,
      summary: m.summary,
      allowed,
      enabled,
      on: allowed && enabled,
      price_minor: price,
      default_price_minor: prices[m.key] ?? 0,
      allowed_at: row ? row.allowed_at : null,
      allowed_by: row ? row.allowed_by : null,
    });
  }
  return out;
}

/** Whether one module is on (allowed and enabled) for a venue, by email. */
async function moduleOn(db, email, key) {
  const [[office]] = await db.query(
    'SELECT id FROM offices WHERE contact_email = ? LIMIT 1',
    [email]
  ).catch(() => [[null]]);
  if (!office) {
    // A venue with no offices row (a legacy single-user account) cannot be
    // allowed anything by admin; only the gym keeps its old rule.
    return key === 'gym_door' ? gymSwitch(db, email) : false;
  }
  const all = await modulesFor(db, office.id, email);
  const m = all.find((x) => x.key === key);
  return !!(m && m.on);
}

/** Whether admin has allowed one module for a venue, by email. */
async function moduleAllowed(db, email, key) {
  const [[office]] = await db.query(
    'SELECT id FROM offices WHERE contact_email = ? LIMIT 1',
    [email]
  ).catch(() => [[null]]);
  if (!office) return key === 'gym_door';
  const all = await modulesFor(db, office.id, email);
  const m = all.find((x) => x.key === key);
  return !!(m && m.allowed);
}

/**
 * Allow or withdraw modules for a venue. `changes` is
 * `{ key: { allowed, price_minor } }`; keys not named are left alone.
 *
 * Allowing a module also switches it on, so a venue created with Memberships
 * ticked has memberships, not a switch to go and find. The manager can still
 * turn it off.
 */
async function setAllowed(db, officeId, changes, by) {
  for (const [key, change] of Object.entries(changes || {})) {
    if (!KEYS.has(key) || !change || typeof change !== 'object') continue;
    const allowed = change.allowed ? 1 : 0;
    const price = Object.prototype.hasOwnProperty.call(change, 'price_minor')
      ? cleanPrice(change.price_minor)
      : undefined;
    await db.execute(
      `INSERT INTO bo_venue_modules
         (office_id, module, allowed, enabled, price_minor, allowed_at, allowed_by,
          enabled_at, enabled_by)
       VALUES (?, ?, ?, ?, ?, IF(? = 1, NOW(), NULL), ?, IF(? = 1, NOW(), NULL), ?)
       ON DUPLICATE KEY UPDATE
         enabled    = IF(allowed = 0 AND VALUES(allowed) = 1, 1, enabled),
         enabled_at = IF(allowed = 0 AND VALUES(allowed) = 1, NOW(), enabled_at),
         enabled_by = IF(allowed = 0 AND VALUES(allowed) = 1, VALUES(enabled_by), enabled_by),
         allowed_at = IF(allowed <> VALUES(allowed), NOW(), allowed_at),
         allowed_by = IF(allowed <> VALUES(allowed), VALUES(allowed_by), allowed_by),
         allowed    = VALUES(allowed)
         ${price === undefined ? '' : ', price_minor = VALUES(price_minor)'}`,
      [officeId, key, allowed, allowed, price ?? null, allowed, by || null, allowed, by || null]
    );

    // The gym's manager switch lives on its own settings row. Allowing the
    // module turns the door on, as for every other module; it does not touch
    // the prefix, which the manager still has to set.
    if (key === 'gym_door' && allowed) {
      const office = await officeRow(db, officeId);
      if (office) {
        const [[existing]] = await db.query(
          'SELECT enabled FROM epos_gym_settings WHERE office = ?',
          [office.contact_email]
        ).catch(() => [[undefined]]);
        if (!existing) {
          await db.execute(
            'INSERT INTO epos_gym_settings (office, enabled) VALUES (?, 1)',
            [office.contact_email]
          ).catch((e) => { if (!isMissingTable(e)) throw e; });
        }
      }
    }
  }
}

/**
 * What a venue's allowed modules add to one invoice.
 *
 * Monthly prices; a yearly subscription pays twelve of them. Returns the total
 * and a short line saying what it is made of, stored on the invoice so a bill
 * that grew can be explained.
 */
async function moduleCharges(db, officeId, intervalUnit) {
  let list;
  try {
    list = await modulesFor(db, officeId, null);
  } catch (e) {
    if (isMissingTable(e)) return { total: 0, detail: null };
    throw e;
  }
  const months = intervalUnit === 'year' ? 12 : 1;
  const charged = list.filter((m) => m.allowed && m.price_minor > 0);
  const total = charged.reduce((sum, m) => sum + m.price_minor * months, 0);
  const detail = charged.length
    ? charged.map((m) => `${m.label} ${(m.price_minor * months / 100).toFixed(2)}`).join(', ')
    : null;
  return { total, detail };
}

function moduleRoutes({ pool, broadcast, secret }) {
  const router = express.Router();
  const auth = requireAuth(secret);
  const terminal = requireTerminal(secret);

  const admin = (req, res, next) =>
    req.user?.role === 'admin'
      ? next()
      : res.status(403).json({ error: 'Administrator access only' });

  /** The signed-in venue: its id and email. */
  async function myOffice(req) {
    if (req.user.officeId) {
      const row = await officeRow(pool, req.user.officeId);
      if (row) return row;
    }
    const [[row]] = await pool.query(
      'SELECT id, contact_email FROM offices WHERE contact_email = ? LIMIT 1',
      [req.user.email]
    );
    return row || null;
  }

  const fail = (res, next, e) =>
    e.status ? res.status(e.status).json({ error: e.message }) : next(e);

  // ---- Admin ---------------------------------------------------------------

  router.get('/api/admin/modules', auth, admin, async (_req, res, next) => {
    try {
      const prices = await defaultPrices(pool);
      res.json(MODULES.map((m) => ({
        key: m.key, label: m.label, summary: m.summary,
        price_minor: prices[m.key] ?? 0,
      })));
    } catch (e) { next(e); }
  });

  /** Default monthly prices: `{ key: price_minor }`. */
  router.put('/api/admin/modules/prices', auth, admin, async (req, res, next) => {
    try {
      for (const [key, value] of Object.entries(req.body || {})) {
        if (!KEYS.has(key)) continue;
        const price = cleanPrice(value) ?? 0;
        await pool.execute(
          `INSERT INTO bo_module_prices (module, price_minor) VALUES (?, ?)
           ON DUPLICATE KEY UPDATE price_minor = VALUES(price_minor)`,
          [key, price]
        );
      }
      res.json({ ok: true });
    } catch (e) { fail(res, next, e); }
  });

  router.get('/api/admin/offices/:id/modules', auth, admin, async (req, res, next) => {
    try {
      const office = await officeRow(pool, req.params.id);
      if (!office) return res.status(404).json({ error: 'No such office.' });
      res.json(await modulesFor(pool, office.id, office.contact_email));
    } catch (e) { next(e); }
  });

  router.put('/api/admin/offices/:id/modules', auth, admin, async (req, res, next) => {
    try {
      const office = await officeRow(pool, req.params.id);
      if (!office) return res.status(404).json({ error: 'No such office.' });
      await setAllowed(pool, office.id, (req.body || {}).modules, req.user.email);
      broadcast({ type: 'modules' });
      broadcast({ type: 'gym' });
      broadcast({ type: 'offices.updated' });
      res.json(await modulesFor(pool, office.id, office.contact_email));
    } catch (e) { fail(res, next, e); }
  });

  // ---- The venue's own -----------------------------------------------------

  router.get('/api/modules', auth, async (req, res, next) => {
    try {
      const office = await myOffice(req);
      if (!office) return res.json([]);
      res.json(await modulesFor(pool, office.id, office.contact_email));
    } catch (e) { next(e); }
  });

  /** The manager's switch. Refused for a module admin has not allowed. */
  router.put('/api/modules/:key', auth, async (req, res, next) => {
    try {
      const key = req.params.key;
      if (!KEYS.has(key)) return res.status(404).json({ error: 'No such module.' });
      const office = await myOffice(req);
      if (!office) return res.status(404).json({ error: 'No venue for this sign-in.' });

      const list = await modulesFor(pool, office.id, office.contact_email);
      const mod = list.find((m) => m.key === key);
      if (!mod.allowed) {
        return res.status(403).json({
          error: `${mod.label} is not part of this venue's system. Ask Vesopa to add it.`,
        });
      }
      const enabled = (req.body || {}).enabled ? 1 : 0;
      const spec = MODULES.find((m) => m.key === key);
      if (spec.managerSwitch === 'gym') {
        await pool.execute(
          `INSERT INTO epos_gym_settings (office, enabled) VALUES (?, ?)
           ON DUPLICATE KEY UPDATE enabled = VALUES(enabled)`,
          [office.contact_email, enabled]
        );
        broadcast({ type: 'gym' });
      } else {
        await pool.execute(
          `UPDATE bo_venue_modules
              SET enabled = ?, enabled_at = NOW(), enabled_by = ?
            WHERE office_id = ? AND module = ?`,
          [enabled, req.user.email || null, office.id, key]
        );
      }
      broadcast({ type: 'modules' });
      res.json(await modulesFor(pool, office.id, office.contact_email));
    } catch (e) { next(e); }
  });

  // ---- Devices -------------------------------------------------------------

  /**
   * What a till, kiosk or display should show. Only the keys that are on, so
   * a device never has to know the difference between "not allowed" and
   * "switched off" -- both mean "not here".
   */
  router.get('/till/modules', terminal, async (req, res, next) => {
    try {
      const [[office]] = await pool.query(
        'SELECT id, contact_email FROM offices WHERE contact_email = ? LIMIT 1',
        [req.office]
      );
      if (!office) {
        const gym = await gymSwitch(pool, req.office);
        return res.json({ on: gym ? ['gym_door'] : [] });
      }
      const list = await modulesFor(pool, office.id, office.contact_email);
      res.json({ on: list.filter((m) => m.on).map((m) => m.key) });
    } catch (e) { next(e); }
  });

  return router;
}

module.exports = {
  MODULES,
  moduleRoutes,
  modulesFor,
  moduleOn,
  moduleAllowed,
  setAllowed,
  moduleCharges,
};
