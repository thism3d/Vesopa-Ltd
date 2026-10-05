#!/usr/bin/env node
/**
 * Set up a partner's venue in the back office: the office, its manager's
 * sign-in, the modules it is allowed, membership plans mirroring the partner's
 * own, and (when asked) a fresh partner key.
 *
 *   node tool/setup-partner-venue.js --name "Metric Group UK" \
 *        --email m.hammond@metricgroup.co.uk --person "Matt Hammond" \
 *        --modules memberships,vehicle_access --plans plans.json \
 *        [--new-key --key-out /path/key] [--by info@vesopasoftware.com]
 *
 * FIRST USED 2026-10-05 for Metric Group UK (tool/setup_metric_venue.py runs
 * it on the live box). Prints one JSON line: the office, which plan here each
 * of the partner's plans became, and whether a key was written.
 *
 * IDEMPOTENT. The office is found by its manager's address; plans by the id
 * the partner already holds for them, then by name. Run it twice and the
 * second run changes nothing except, with --new-key, the key.
 *
 * NO PASSWORD. The manager's back-office row gets a random hash nobody knows:
 * they sign in with Continue with Vesopa, which links this row by verified
 * email on their first sign-in (src/backoffice_auth.js).
 *
 * THE KEY IS NEVER PRINTED. It is written to --key-out, mode 600, for the
 * caller to move into the partner's .env and delete.
 */
require('dotenv').config({ quiet: true });
const crypto = require('crypto');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const mysql = require('mysql2/promise');
const { setAllowed } = require('../src/modules');
const { issuePartnerKey } = require('../src/memberships');
const { cleanSchemeInput } = require('../src/loyalty_schemes');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const KEY_LABEL = 'Metric Membership';

/** The office for this address: reused if it exists, created if not. */
async function ensureOffice(db, { name, email, person }) {
  const [[user]] = await db.query(
    'SELECT id, office_id FROM backoffice_users WHERE LOWER(email) = ? LIMIT 1', [email]);
  let [[office]] = await db.query(
    'SELECT id, name, contact_email FROM offices WHERE LOWER(contact_email) = ? LIMIT 1', [email]);
  const actions = [];

  if (user && office && user.office_id && user.office_id !== office.id) {
    throw new Error(`${email} already signs in to office ${user.office_id}, not ${office.id}. Nothing was changed.`);
  }
  if (!office && user && user.office_id) {
    [[office]] = await db.query('SELECT id, name, contact_email FROM offices WHERE id = ?', [user.office_id]);
    if (office && String(office.contact_email).toLowerCase() !== email) {
      throw new Error(`${email} is a user of "${office.name}", which belongs to someone else. Nothing was changed.`);
    }
  }

  if (!office) {
    const [r] = await db.execute(
      "INSERT INTO offices (name, contact_email, plan, status) VALUES (?, ?, 'partner', 'active')", [name, email]);
    [[office]] = await db.query('SELECT id, name, contact_email FROM offices WHERE id = ?', [r.insertId]);
    actions.push('office created');
  } else if (office.name !== name) {
    await db.execute('UPDATE offices SET name = ? WHERE id = ?', [name, office.id]);
    actions.push(`office renamed from "${office.name}"`);
  }

  if (!user) {
    // Unusable on purpose: sign-in is Continue with Vesopa. See the header.
    const hash = await bcrypt.hash(crypto.randomBytes(32).toString('base64url'), 12);
    await db.execute(
      `INSERT INTO backoffice_users (email, password, name, company, approved, role, office_id)
       VALUES (?, ?, ?, ?, 'Y', 'office', ?)`,
      [email, hash, person || name, name, office.id]);
    actions.push('manager sign-in created');
  } else {
    await db.execute(
      "UPDATE backoffice_users SET office_id = ?, approved = 'Y', company = ? WHERE id = ?",
      [office.id, name, user.id]);
  }
  return { office: { id: office.id, key: office.contact_email, name }, actions };
}

/** One membership plan here for each of the partner's plans. */
async function ensurePlans(db, officeKey, plans) {
  const map = {};
  const actions = [];
  for (const p of plans) {
    let id = null;
    if (p.epos_plan_id) {
      const [[row]] = await db.query(
        'SELECT id FROM epos_loyalty_schemes WHERE id = ? AND office = ?', [p.epos_plan_id, officeKey]);
      if (row) id = row.id;
    }
    if (!id) {
      const [[row]] = await db.query(
        'SELECT id FROM epos_loyalty_schemes WHERE office = ? AND name = ? AND is_membership = 1 LIMIT 1',
        [officeKey, String(p.name).slice(0, 80)]);
      if (row) id = row.id;
    }
    if (!id) {
      // Free and five years long: these members already pay Metric, and the
      // barrier must not start refusing them on a renewal date nobody set.
      const { errors, values } = cleanSchemeInput({
        name: p.name,
        description: p.description || null,
        is_membership: 1,
        membership_fee_minor: 0,
        membership_term_months: 60,
        joining_fee_minor: 0,
        max_vehicles: Math.min(20, Math.max(0, Number(p.max_vehicles) || 1)),
        includes_gym: 0,
        includes_classes: 0,
        sell_online: 0,
        offer_at_till: 0,
        is_default: p.is_default ? 1 : 0,
        active: p.active === 0 ? 0 : 1,
        colour: '#0f8a6c',
      });
      if (errors.length) throw new Error(`Plan "${p.name}": ${errors.join(' ')}`);
      const cols = Object.keys(values);
      const [r] = await db.execute(
        `INSERT INTO epos_loyalty_schemes (office, ${cols.map((c) => `\`${c}\``).join(', ')})
         VALUES (?, ${cols.map(() => '?').join(', ')})`,
        [officeKey, ...cols.map((c) => values[c])]);
      id = r.insertId;
      actions.push(`plan "${p.name}" created`);
    }
    map[p.id] = id;
  }
  return { map, actions };
}

async function main() {
  const name = String(arg('name') || '').trim();
  const email = String(arg('email') || '').trim().toLowerCase();
  const person = String(arg('person') || '').trim();
  const by = String(arg('by') || 'info@vesopasoftware.com');
  if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new Error('--name and --email are required');
  }
  const modules = String(arg('modules') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const plansFile = arg('plans');
  const plans = plansFile ? JSON.parse(fs.readFileSync(plansFile, 'utf8') || '[]') : [];

  const db = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'vesopa_eposdb',
    charset: 'utf8mb4',
  });
  try {
    await db.beginTransaction();
    const { office, actions } = await ensureOffice(db, { name, email, person });
    if (modules.length) {
      await setAllowed(db, office.id, Object.fromEntries(modules.map((k) => [k, { allowed: true }])), by);
    }
    const planned = await ensurePlans(db, office.key, plans);
    actions.push(...planned.actions);

    let keyWritten = false;
    if (arg('new-key')) {
      const out = arg('key-out');
      if (!out || out === true) throw new Error('--new-key needs --key-out');
      await db.execute(
        'UPDATE epos_partner_keys SET revoked_at = NOW() WHERE office = ? AND label = ? AND revoked_at IS NULL',
        [office.key, KEY_LABEL]);
      const key = await issuePartnerKey(db, office.key, KEY_LABEL, by);
      fs.writeFileSync(out, key, { mode: 0o600 });
      keyWritten = true;
      actions.push('partner key issued');
    }
    await db.commit();

    const [mods] = await db.query(
      'SELECT module, allowed, enabled FROM bo_venue_modules WHERE office_id = ? ORDER BY module', [office.id]);
    console.log(JSON.stringify({ office, modules: mods, plans: planned.map, key_written: keyWritten, actions }));
  } catch (e) {
    await db.rollback().catch(() => {});
    throw e;
  } finally {
    await db.end();
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
