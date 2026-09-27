/**
 * Members and their cars: the reads and writes both the app and the console
 * make, so the rules (how many cars, one live membership per plate) live in
 * one place.
 */

const db = require('./db');
const config = require('./config');
const plates = require('./plates');
const sync = require('./sync');

class Refusal extends Error {
  constructor(message, status = 400, code = 'refused') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function defaultPlan() {
  return db.one('SELECT * FROM plans WHERE is_default = 1 AND active = 1 ORDER BY id LIMIT 1');
}

/** The member for a Vesopa account, made on first sign-in. */
async function fromVesopa(claims) {
  const sub = String(claims.sub || '');
  if (!sub) throw new Refusal('Vesopa did not say who you are. Please try again.', 401);
  const email = String(claims.email || '').slice(0, 191);
  const name = String(claims.name || [claims.given_name, claims.family_name].filter(Boolean).join(' ') || '').slice(0, 120);
  let member = await db.one('SELECT * FROM members WHERE vesopa_sub = ?', [sub]);
  if (!member) {
    const plan = await defaultPlan();
    const res = await db.run(
      'INSERT INTO members (vesopa_sub, email, name, status, plan_id) VALUES (?, ?, ?, ?, ?)',
      [sub, email, name, config.AUTO_APPROVE ? 'active' : 'pending', plan ? plan.id : null],
    );
    await db.run('UPDATE members SET member_no = ? WHERE id = ?', [`MG${String(100000 + res.insertId)}`, res.insertId]);
    member = await db.one('SELECT * FROM members WHERE id = ?', [res.insertId]);
    member.isNew = true;
  } else if (member.status === 'closed') {
    // Came back after deleting their account: a fresh start, waiting again.
    await db.run("UPDATE members SET status = ?, email = ?, name = IF(name = '', ?, name) WHERE id = ?",
      [config.AUTO_APPROVE ? 'active' : 'pending', email, name, member.id]);
    member = await db.one('SELECT * FROM members WHERE id = ?', [member.id]);
    member.isNew = true;
  } else if (email && email !== member.email) {
    await db.run('UPDATE members SET email = ? WHERE id = ?', [email, member.id]);
    member.email = email;
  }
  return member;
}

async function planFor(member) {
  if (member.plan_id) {
    const p = await db.one('SELECT * FROM plans WHERE id = ?', [member.plan_id]);
    if (p) return p;
  }
  return defaultPlan();
}

async function vehiclesOf(memberId) {
  return db.all('SELECT * FROM vehicles WHERE member_id = ? AND removed_at IS NULL ORDER BY id', [memberId]);
}

async function addVehicle(member, { plate, make = '', colour = '', nickname = '' }) {
  if (!plates.valid(plate)) throw new Refusal('That does not look like a registration. Check it and try again.', 400, 'bad_plate');
  const n = plates.normalise(plate);
  const plan = await planFor(member);
  const max = (plan && plan.max_vehicles) || config.DEFAULT_MAX_VEHICLES;
  const mine = await vehiclesOf(member.id);
  if (mine.some((v) => v.plate === n)) throw new Refusal('That car is already on your membership.', 409, 'duplicate');
  if (mine.length >= max) throw new Refusal(`Your membership covers ${max} car${max === 1 ? '' : 's'}. Remove one to add another.`, 409, 'limit');
  const taken = await db.one('SELECT id FROM vehicles WHERE live_plate = ?', [n]);
  if (taken) {
    throw new Refusal('That registration is already on another membership. If it is your car, contact Metric and we will sort it out.', 409, 'taken');
  }
  const res = await db.run(
    'INSERT INTO vehicles (member_id, plate, plate_display, plate_fuzzy, make, colour, nickname) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [member.id, n, plates.display(plate), plates.fuzzy(n), String(make).slice(0, 60), String(colour).slice(0, 40), String(nickname).slice(0, 60)],
  );
  sync.soon();
  return db.one('SELECT * FROM vehicles WHERE id = ?', [res.insertId]);
}

async function updateVehicle(memberId, vehicleId, { make, colour, nickname }) {
  const v = await db.one('SELECT * FROM vehicles WHERE id = ? AND member_id = ? AND removed_at IS NULL', [vehicleId, memberId]);
  if (!v) throw new Refusal('That car is not on your membership.', 404, 'not_found');
  await db.run('UPDATE vehicles SET make = ?, colour = ?, nickname = ? WHERE id = ?', [
    make != null ? String(make).slice(0, 60) : v.make,
    colour != null ? String(colour).slice(0, 40) : v.colour,
    nickname != null ? String(nickname).slice(0, 60) : v.nickname,
    v.id,
  ]);
  return db.one('SELECT * FROM vehicles WHERE id = ?', [v.id]);
}

async function removeVehicle(memberId, vehicleId) {
  const v = await db.one('SELECT * FROM vehicles WHERE id = ? AND member_id = ? AND removed_at IS NULL', [vehicleId, memberId]);
  if (!v) throw new Refusal('That car is not on your membership.', 404, 'not_found');
  await db.run('UPDATE vehicles SET removed_at = NOW() WHERE id = ?', [v.id]);
  sync.soon();
  return v;
}

/** Where the member's cars are right now, from each car's last read. */
async function presence(memberId) {
  return db.all(
    `SELECT e.vehicle_id, e.direction, e.at, s.name AS site
       FROM access_events e
       JOIN (SELECT vehicle_id, MAX(id) AS id FROM access_events
              WHERE member_id = ? AND decision = 'open' GROUP BY vehicle_id) last ON last.id = e.id
       JOIN sites s ON s.id = e.site_id`,
    [memberId],
  );
}

module.exports = { Refusal, fromVesopa, planFor, vehiclesOf, addVehicle, updateVehicle, removeVehicle, presence, defaultPlan };
