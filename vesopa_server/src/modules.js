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
 * Admin also sets what each module costs: a default monthly price per module,
 * a price per venue (zero is free), promo codes that take a percentage or an
 * amount off for some months, and a platform-wide off switch per module.
 * "Let administration decide the extra value ... set it free or offer promo
 * codes and ... quick add or disable anything." (owner, 2026-10-04)
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
 * The catalogue. Adding a module is adding a line here; the admin screens, the
 * venue's Modules page and the till all read this list from the server.
 *
 * `price` is the starting monthly price in pence, used only when the database
 * has no price yet (schema_venue_modules.sql seeds the same figures and says
 * where they came from). `managerSwitch` names where the manager's on/off lives
 * when it is not bo_venue_modules.enabled -- only the gym, whose switch
 * predates modules.
 */
const MODULES = [
  {
    key: 'memberships',
    label: 'Memberships',
    summary: 'Membership plans, joining fees, renewals, freezes, family plans and classes.',
    price: 2900,
  },
  {
    key: 'gym_door',
    label: 'Gym door',
    summary: 'Members swipe in and out at an unmanned door; attendance and expiry slips.',
    price: 1500,
    managerSwitch: 'gym',
  },
  {
    key: 'vehicle_access',
    label: 'Vehicle access',
    summary: 'Members register cars and number-plate cameras open the barrier.',
    price: 3900,
  },
];

const KEYS = new Set(MODULES.map((m) => m.key));

const isMissingTable = (e) =>
  e && (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR');

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

/** A whole number of pence from 0 to £10,000, or null for "use the default". */
function cleanPrice(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < 0 || n > 1_000_000) {
    throw badRequest('A module price must be between £0 and £10,000 a month.');
  }
  return n;
}

const cleanCode = (value) =>
  String(value ?? '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 32);

/** `{ key: { price_minor, active } }`, from the database or the catalogue. */
async function catalogue(db) {
  const out = Object.fromEntries(MODULES.map((m) => [m.key, { price_minor: m.price, active: true }]));
  try {
    const [rows] = await db.query('SELECT module, price_minor, active FROM bo_module_prices');
    for (const r of rows) {
      if (!out[r.module]) continue;
      out[r.module] = { price_minor: Number(r.price_minor) || 0, active: !!Number(r.active) };
    }
  } catch (e) {
    if (!isMissingTable(e)) throw e;
  }
  return out;
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
 * Whether a promo applied on `from` still applies on `today`, and what it
 * leaves of `price`. A code turned off after it was applied stops applying;
 * one that has merely passed its expiry date keeps going for the venues that
 * already have it -- the expiry is for new uses.
 */
function discounted(price, promo, from, today = new Date()) {
  if (!promo || !Number(promo.active)) return { price, promo: null };
  if (promo.months !== null && promo.months !== undefined && from) {
    const end = new Date(from);
    end.setMonth(end.getMonth() + Number(promo.months));
    if (today >= end) return { price, promo: null };
  }
  let off = 0;
  if (promo.percent_off) off = Math.round((price * Number(promo.percent_off)) / 100);
  else if (promo.amount_off_minor) off = Number(promo.amount_off_minor);
  return { price: Math.max(0, price - off), promo };
}

async function promosById(db) {
  try {
    const [rows] = await db.query('SELECT * FROM bo_module_promos');
    return Object.fromEntries(rows.map((r) => [r.id, r]));
  } catch (e) {
    if (isMissingTable(e)) return {};
    throw e;
  }
}

function promoLabel(p) {
  const what = p.percent_off ? `${p.percent_off}% off` : `£${(Number(p.amount_off_minor || 0) / 100).toFixed(2)} off`;
  const how = p.months ? ` for ${p.months} month${Number(p.months) === 1 ? '' : 's'}` : '';
  return `${p.code}: ${what}${how}`;
}

/**
 * Every module for one venue: allowed, enabled, on (both), and what it costs.
 *
 * `email` is the venue's contact email, the key the gym and most of the till
 * tables use; passed in when the caller already has it to save a lookup.
 * A module switched off platform-wide reads as not allowed, with `retired` set
 * so admin screens can say why.
 */
async function modulesFor(db, officeId, email) {
  let rows = null;
  try {
    [rows] = await db.query(
      `SELECT module, allowed, enabled, price_minor, allowed_at, allowed_by,
              promo_id, promo_from
         FROM bo_venue_modules WHERE office_id = ?`,
      [officeId]
    );
  } catch (e) {
    if (!isMissingTable(e)) throw e;
  }
  const cat = await catalogue(db);
  const promos = rows && rows.some((r) => r.promo_id) ? await promosById(db) : {};
  const byKey = Object.fromEntries((rows || []).map((r) => [r.module, r]));

  // Pauses and removals from admin.vesopa.com (admin_holds.js). Required here
  // rather than at the top because admin_holds reads MODULES from this file.
  const holds = email ? await require('./admin_holds').holdsFor(db, email).catch(() => ({})) : {};

  const out = [];
  for (const m of MODULES) {
    const row = byKey[m.key];
    const retired = !cat[m.key].active;
    // No table at all: only the gym survives, on its old manager-only rule.
    const granted = rows === null ? m.key === 'gym_door' : !!(row && Number(row.allowed));
    const hold = holds[`module:${m.key}`] || null;
    // Through the grace day it still works; past it, it reads as not allowed.
    const allowed = granted && !retired && !(hold && hold.stopped);
    const enabled = m.managerSwitch === 'gym'
      ? (email ? await gymSwitch(db, email) : false)
      : !!(row && Number(row.enabled));
    const listPrice = row && row.price_minor !== null && row.price_minor !== undefined
      ? Number(row.price_minor)
      : cat[m.key].price_minor;
    const promo = row && row.promo_id ? promos[row.promo_id] : null;
    const charged = discounted(listPrice, promo, row && row.promo_from);
    out.push({
      key: m.key,
      label: m.label,
      summary: m.summary,
      allowed,
      enabled,
      on: allowed && enabled,
      retired,
      price_minor: listPrice,
      own_price: !!(row && row.price_minor !== null && row.price_minor !== undefined),
      default_price_minor: cat[m.key].price_minor,
      charge_minor: charged.price,
      promo: promo ? { id: promo.id, code: promo.code, label: promoLabel(promo), applies: !!charged.promo } : null,
      allowed_at: row ? row.allowed_at : null,
      allowed_by: row ? row.allowed_by : null,
      hold,
    });
  }
  return out;
}

async function officeByEmail(db, email) {
  const [[office]] = await db.query(
    'SELECT id FROM offices WHERE contact_email = ? LIMIT 1',
    [email]
  ).catch(() => [[null]]);
  return office || null;
}

/** Whether one module is on (allowed and enabled) for a venue, by email. */
async function moduleOn(db, email, key) {
  const office = await officeByEmail(db, email);
  if (!office) {
    // A venue with no offices row (a legacy single-user account) cannot be
    // allowed anything by admin; only the gym keeps its old rule.
    return key === 'gym_door' ? gymSwitch(db, email) : false;
  }
  const m = (await modulesFor(db, office.id, email)).find((x) => x.key === key);
  return !!(m && m.on);
}

/** Whether admin has allowed one module for a venue, by email. */
async function moduleAllowed(db, email, key) {
  const office = await officeByEmail(db, email);
  if (!office) return key === 'gym_door';
  const m = (await modulesFor(db, office.id, email)).find((x) => x.key === key);
  return !!(m && m.allowed);
}

/**
 * Find a promo code that can be applied today, to `module`.
 * Throws a 400 saying why when it cannot.
 */
async function usablePromo(db, code, module) {
  const clean = cleanCode(code);
  const [[promo]] = await db.query('SELECT * FROM bo_module_promos WHERE code = ?', [clean]);
  if (!promo || !Number(promo.active)) throw badRequest(`There is no promo code ${clean}.`);
  if (promo.module && promo.module !== module) {
    const label = (MODULES.find((m) => m.key === promo.module) || {}).label || promo.module;
    throw badRequest(`${clean} is for ${label} only.`);
  }
  if (promo.expires_on && new Date(promo.expires_on) < new Date(new Date().toDateString())) {
    throw badRequest(`${clean} has expired.`);
  }
  if (promo.max_uses !== null && promo.max_uses !== undefined) {
    const [[used]] = await db.query(
      'SELECT COUNT(*) AS n FROM bo_venue_modules WHERE promo_id = ?',
      [promo.id]
    );
    if (Number(used.n) >= Number(promo.max_uses)) throw badRequest(`${clean} has been used up.`);
  }
  return promo;
}

/**
 * Allow or withdraw modules for a venue. `changes` is
 * `{ key: { allowed, price_minor, promo_code } }`; keys not named are left
 * alone, and within a key, fields not sent are left alone. `promo_code: ''`
 * removes a promo.
 *
 * Allowing a module also switches it on, so a venue created with Memberships
 * ticked has memberships, not a switch to go and find. The manager can still
 * turn it off, and admin saving the venue again does not undo that.
 */
async function setAllowed(db, officeId, changes, by) {
  for (const [key, change] of Object.entries(changes || {})) {
    if (!KEYS.has(key) || !change || typeof change !== 'object') continue;
    const has = (f) => Object.prototype.hasOwnProperty.call(change, f);
    const allowed = change.allowed ? 1 : 0;
    const price = has('price_minor') ? cleanPrice(change.price_minor) : undefined;

    let promo;
    if (has('promo_code')) {
      promo = String(change.promo_code ?? '').trim() ? await usablePromo(db, change.promo_code, key) : null;
    }

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

    if (promo !== undefined) {
      // Re-applying the code a venue already has keeps its start date, so
      // saving the form again does not restart a three-month offer.
      await db.execute(
        `UPDATE bo_venue_modules
            SET promo_from = IF(promo_id <=> ?, promo_from, IF(? IS NULL, NULL, CURDATE())),
                promo_id = ?
          WHERE office_id = ? AND module = ?`,
        [promo ? promo.id : null, promo ? promo.id : null, promo ? promo.id : null, officeId, key]
      );
    }

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
 * Monthly prices after any promo; a yearly subscription pays twelve of them.
 * Returns the total and a short line saying what it is made of, stored on the
 * invoice so a bill that grew can be explained.
 */
async function moduleCharges(db, officeId, intervalUnit) {
  let list;
  try {
    // With the email, so a module paused or removed past its grace day
    // (admin_holds.js) reads as not allowed and drops off the invoice.
    const [[o]] = await db.query('SELECT contact_email FROM offices WHERE id = ?', [officeId]).catch(() => [[null]]);
    list = await modulesFor(db, officeId, o ? o.contact_email : null);
  } catch (e) {
    if (isMissingTable(e)) return { total: 0, detail: null };
    throw e;
  }
  const months = intervalUnit === 'year' ? 12 : 1;
  const charged = list.filter((m) => m.allowed && m.charge_minor > 0);
  const total = charged.reduce((sum, m) => sum + m.charge_minor * months, 0);
  const detail = charged.length
    ? charged.map((m) =>
        `${m.label} ${(m.charge_minor * months / 100).toFixed(2)}${m.promo && m.promo.applies ? ` (${m.promo.code})` : ''}`
      ).join(', ').slice(0, 500)
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

  const changed = () => {
    broadcast({ type: 'modules' });
    broadcast({ type: 'gym' });
    broadcast({ type: 'offices.updated' });
  };

  // ---- Admin: the catalogue -------------------------------------------------

  /** Every module, its default price, whether it is on platform-wide, and use. */
  router.get('/api/admin/modules', auth, admin, async (_req, res, next) => {
    try {
      const cat = await catalogue(pool);
      let counts = {};
      try {
        const [rows] = await pool.query(
          `SELECT module, SUM(allowed) AS venues FROM bo_venue_modules GROUP BY module`
        );
        counts = Object.fromEntries(rows.map((r) => [r.module, Number(r.venues) || 0]));
      } catch (e) {
        if (!isMissingTable(e)) throw e;
      }
      res.json(MODULES.map((m) => ({
        key: m.key, label: m.label, summary: m.summary,
        price_minor: cat[m.key].price_minor,
        active: cat[m.key].active,
        venues: counts[m.key] || 0,
      })));
    } catch (e) { next(e); }
  });

  /** One module's default price and platform-wide switch. */
  router.put('/api/admin/modules/:key', auth, admin, async (req, res, next) => {
    try {
      const key = req.params.key;
      if (!KEYS.has(key)) return res.status(404).json({ error: 'No such module.' });
      const body = req.body || {};
      const cat = await catalogue(pool);
      const price = Object.prototype.hasOwnProperty.call(body, 'price_minor')
        ? (cleanPrice(body.price_minor) ?? 0)
        : cat[key].price_minor;
      const active = Object.prototype.hasOwnProperty.call(body, 'active')
        ? (body.active ? 1 : 0)
        : (cat[key].active ? 1 : 0);
      await pool.execute(
        `INSERT INTO bo_module_prices (module, price_minor, active) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE price_minor = VALUES(price_minor), active = VALUES(active)`,
        [key, price, active]
      );
      changed();
      res.json({ ok: true, key, price_minor: price, active: !!active });
    } catch (e) { fail(res, next, e); }
  });

  /** Several default prices at once: `{ key: price_minor }`. */
  router.put('/api/admin/modules-prices', auth, admin, async (req, res, next) => {
    try {
      const cat = await catalogue(pool);
      for (const [key, value] of Object.entries(req.body || {})) {
        if (!KEYS.has(key)) continue;
        await pool.execute(
          `INSERT INTO bo_module_prices (module, price_minor, active) VALUES (?, ?, ?)
           ON DUPLICATE KEY UPDATE price_minor = VALUES(price_minor)`,
          [key, cleanPrice(value) ?? 0, cat[key].active ? 1 : 0]
        );
      }
      res.json({ ok: true });
    } catch (e) { fail(res, next, e); }
  });

  /**
   * Every venue against every module, for the quick switches on
   * Admin > Modules. Practice venues are left out, as on the offices list.
   */
  router.get('/api/admin/modules-venues', auth, admin, async (_req, res, next) => {
    try {
      let offices;
      try {
        [offices] = await pool.query(
          'SELECT id, name, contact_email, status FROM offices WHERE demo_of IS NULL ORDER BY name'
        );
      } catch (e) {
        if (e.code !== 'ER_BAD_FIELD_ERROR') throw e;
        [offices] = await pool.query('SELECT id, name, contact_email, status FROM offices ORDER BY name');
      }
      const out = [];
      for (const o of offices) {
        out.push({ ...o, modules: await modulesFor(pool, o.id, o.contact_email) });
      }
      res.json(out);
    } catch (e) { next(e); }
  });

  // ---- Admin: promo codes ---------------------------------------------------

  router.get('/api/admin/module-promos', auth, admin, async (_req, res, next) => {
    try {
      const [rows] = await pool.query(
        `SELECT p.*, (SELECT COUNT(*) FROM bo_venue_modules v WHERE v.promo_id = p.id) AS uses
           FROM bo_module_promos p ORDER BY p.active DESC, p.created_at DESC`
      );
      res.json(rows.map((p) => ({ ...p, label: promoLabel(p) })));
    } catch (e) {
      if (isMissingTable(e)) return res.json([]);
      next(e);
    }
  });

  router.post('/api/admin/module-promos', auth, admin, async (req, res, next) => {
    try {
      const b = req.body || {};
      const code = cleanCode(b.code);
      if (code.length < 3) throw badRequest('A promo code needs at least three letters or numbers.');
      const module = b.module ? String(b.module) : null;
      if (module && !KEYS.has(module)) throw badRequest('No such module.');
      const percent = b.percent_off === '' || b.percent_off == null ? null : Math.round(Number(b.percent_off));
      const amount = b.amount_off_minor === '' || b.amount_off_minor == null ? null : Math.round(Number(b.amount_off_minor));
      if ((percent === null) === (amount === null)) {
        throw badRequest('Give either a percentage off or an amount off, not both.');
      }
      if (percent !== null && !(percent >= 1 && percent <= 100)) throw badRequest('A percentage off must be from 1 to 100.');
      if (amount !== null && !(amount >= 1 && amount <= 1_000_000)) throw badRequest('An amount off must be from 1p to £10,000.');
      const months = b.months === '' || b.months == null ? null : Math.round(Number(b.months));
      if (months !== null && !(months >= 1 && months <= 120)) throw badRequest('Months must be from 1 to 120, or blank for ever.');
      const maxUses = b.max_uses === '' || b.max_uses == null ? null : Math.round(Number(b.max_uses));
      if (maxUses !== null && !(maxUses >= 1)) throw badRequest('Uses must be at least 1, or blank for no limit.');
      const expires = b.expires_on ? String(b.expires_on).slice(0, 10) : null;
      if (expires && !/^\d{4}-\d{2}-\d{2}$/.test(expires)) throw badRequest('The expiry date is not a date.');
      try {
        const [r] = await pool.execute(
          `INSERT INTO bo_module_promos
             (code, description, module, percent_off, amount_off_minor, months, expires_on, max_uses, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [code, String(b.description || '').slice(0, 190), module, percent, amount, months, expires, maxUses, req.user.email || null]
        );
        res.status(201).json({ id: r.insertId, code });
      } catch (e) {
        if (e.code === 'ER_DUP_ENTRY') throw badRequest(`${code} already exists.`);
        throw e;
      }
    } catch (e) { fail(res, next, e); }
  });

  /** Turn a code on or off. Off also stops it discounting venues that have it. */
  router.put('/api/admin/module-promos/:id', auth, admin, async (req, res, next) => {
    try {
      const [r] = await pool.execute(
        'UPDATE bo_module_promos SET active = ? WHERE id = ?',
        [(req.body || {}).active ? 1 : 0, req.params.id]
      );
      if (!r.affectedRows) return res.status(404).json({ error: 'No such promo code.' });
      changed();
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  // ---- Admin: one venue -----------------------------------------------------

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
      changed();
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
  discounted,
};
