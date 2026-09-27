/**
 * The Microsoft Store testers' membership: approved, with two cars and a few
 * visits, so a tester who signs in sees a real card, cars and visits.
 *
 *     node scripts/seed-test-member.js <vesopa sub> <email> "<name>"
 *
 * Run on the box from the app's folder by scripts/setup-test-account.py, which
 * makes the Vesopa account and asks Vesopa Auth for the sub first. Idempotent:
 * a second run fixes the status, dates and plan and adds nothing twice.
 *
 * The cars' plates end in I and Q, which the DVLA never issues in those
 * places, so no real car's plate can match them, fuzzily or not. The visits
 * are at a car park of their own that members never see (not public, not
 * active) with a lane that is switched off, so no barrier is involved.
 */

require('dotenv').config({ override: true });

const crypto = require('crypto');

const db = require('../src/db');
const plates = require('../src/plates');

const SITE = 'Store review car park (test)';
const CARS = [
  { plate: 'MG24 QIQ', make: 'Tesla Model 3', colour: 'Grey', nickname: 'Work car' },
  { plate: 'LR71 IQI', make: 'Volkswagen Golf', colour: 'White', nickname: '' },
];
// [car, direction, days ago, hour, minute]
const VISITS = [
  [1, 'entry', 6, 9, 12], [1, 'exit', 6, 17, 55],
  [0, 'entry', 3, 8, 38], [0, 'exit', 3, 17, 31],
  [0, 'entry', 1, 8, 51], [0, 'exit', 1, 18, 7],
  [0, 'entry', 0, 8, 42],
];

const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

function at(daysAgo, hour, minute) {
  const d = new Date(Date.now() - daysAgo * 86400000);
  d.setHours(hour, minute, 0, 0);
  // "This morning" before the morning has happened is yesterday.
  if (d > new Date()) d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

async function main() {
  const [sub, email, name] = process.argv.slice(2).map((a) => String(a || '').trim());
  if (!sub || !email.includes('@') || !name) {
    console.error('usage: seed-test-member.js <vesopa sub> <email> "<name>"');
    process.exit(2);
  }

  const plan = await db.one('SELECT * FROM plans WHERE is_default = 1 AND active = 1 ORDER BY id LIMIT 1');
  const note = 'Microsoft Store certification test account (scripts/setup-test-account.py).';
  let member = await db.one('SELECT * FROM members WHERE vesopa_sub = ?', [sub]);
  if (!member) {
    const res = await db.run(
      "INSERT INTO members (vesopa_sub, email, name, company, status, plan_id, notes) VALUES (?, ?, ?, 'Vesopa Software Ltd', 'active', ?, ?)",
      [sub, email, name, plan ? plan.id : null, note],
    );
    await db.run('UPDATE members SET member_no = ? WHERE id = ?', [`MG${String(100000 + res.insertId)}`, res.insertId]);
    member = await db.one('SELECT * FROM members WHERE id = ?', [res.insertId]);
    console.log(`  created member ${member.member_no}`);
  } else {
    console.log(`  member ${member.member_no} already exists`);
  }
  await db.run(
    "UPDATE members SET status = 'active', email = ?, plan_id = COALESCE(plan_id, ?), valid_from = ?, valid_to = ?, notes = ? WHERE id = ?",
    [email, plan ? plan.id : null, day(-30), day(365), note, member.id],
  );

  let site = await db.one('SELECT id FROM sites WHERE name = ?', [SITE]);
  if (!site) {
    const res = await db.run('INSERT INTO sites (name, address, public, active) VALUES (?, ?, 0, 0)', [SITE, 'Test data for the Store testers only']);
    site = { id: res.insertId };
    console.log('  created the hidden test car park');
  }
  let gate = await db.one('SELECT id FROM gates WHERE site_id = ? ORDER BY id LIMIT 1', [site.id]);
  if (!gate) {
    const key = crypto.createHash('sha256').update(crypto.randomBytes(32)).digest('hex');
    const res = await db.run("INSERT INTO gates (site_id, name, direction, key_hash, active) VALUES (?, 'Main barrier', 'both', ?, 0)", [site.id, key]);
    gate = { id: res.insertId };
  }

  const vehicleIds = [];
  for (const car of CARS) {
    const plate = plates.normalise(car.plate);
    let v = await db.one('SELECT id, member_id FROM vehicles WHERE live_plate = ?', [plate]);
    if (v && v.member_id !== member.id) {
      console.log(`  ${car.plate} is on another membership; left alone`);
      vehicleIds.push(null);
      continue;
    }
    if (!v) {
      const res = await db.run(
        'INSERT INTO vehicles (member_id, plate, plate_display, plate_fuzzy, make, colour, nickname) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [member.id, plate, car.plate, plates.fuzzy(plate), car.make, car.colour, car.nickname],
      );
      v = { id: res.insertId };
      console.log(`  added ${car.plate}`);
    }
    vehicleIds.push(v.id);
  }

  const had = await db.one('SELECT COUNT(*) AS n FROM access_events WHERE member_id = ?', [member.id]);
  if (!had.n) {
    for (const [car, direction, daysAgo, hour, minute] of VISITS) {
      if (!vehicleIds[car]) continue;
      await db.run(
        `INSERT INTO access_events (gate_id, site_id, plate, direction, decision, reason, member_id, vehicle_id, source, at)
         VALUES (?, ?, ?, ?, 'open', 'member', ?, ?, 'test', ?)`,
        [gate.id, site.id, plates.normalise(CARS[car].plate), direction, member.id, vehicleIds[car], at(daysAgo, hour, minute)],
      );
    }
    console.log(`  added ${VISITS.length} visits`);
  }
  console.log(`  ${email} is member ${member.member_no}, active until ${day(365)}`);
}

main()
  .then(() => db.pool.end())
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('failed:', error.message);
    process.exit(1);
  });
