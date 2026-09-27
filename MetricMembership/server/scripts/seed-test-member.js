/**
 * The Microsoft Store testers' membership: approved, with three cars and a
 * week of comings and goings at two car parks, one of them refused, so a
 * tester who signs in sees a real card, cars and visits.
 *
 *     node scripts/seed-test-member.js <vesopa sub> <email> "<name>"
 *
 * Run on the box from the app's folder by scripts/setup-test-account.py, which
 * makes the Vesopa account and asks Vesopa Auth for the sub first. Idempotent:
 * a second run fixes the status, dates and plan and adds nothing twice.
 *
 * The cars' plates end in I and Q, which the DVLA never issues in those
 * places, so no real car's plate can match them, fuzzily or not. The visits
 * are at car parks of their own that members never see (not public, not
 * active) with lanes that are switched off, so no barrier is involved.
 */

require('dotenv').config({ override: true });

const crypto = require('crypto');

const db = require('../src/db');
const plates = require('../src/plates');

const SITES = [
  { name: 'Kembrey Park (Store test)', address: 'Kembrey Park, Swindon' },
  { name: 'Delta Business Park (Store test)', address: 'Great Western Way, Swindon' },
];
const CARS = [
  { plate: 'MG24 QIQ', make: 'Tesla Model 3', colour: 'Grey', nickname: 'Work car' },
  { plate: 'LR71 IQI', make: 'Volkswagen Golf', colour: 'White', nickname: 'Family car' },
  { plate: 'WU19 QQI', make: 'Ford Transit Custom', colour: 'Blue', nickname: 'Site van' },
];
// [car, site, direction, days ago, hour, minute, reason]. Oldest first.
const VISITS = [
  [0, 0, 'entry', 6, 8, 34], [2, 1, 'entry', 6, 10, 5], [2, 1, 'exit', 6, 11, 48], [0, 0, 'exit', 6, 17, 41],
  [0, 0, 'entry', 5, 8, 52], [0, 0, 'exit', 5, 12, 30], [0, 0, 'entry', 5, 13, 22], [0, 0, 'exit', 5, 18, 3],
  [1, 1, 'entry', 4, 9, 16], [2, 1, 'entry', 4, 7, 58, 'not_this_site'], [1, 1, 'exit', 4, 16, 27],
  [0, 0, 'entry', 3, 8, 38], [2, 0, 'entry', 3, 11, 14], [2, 0, 'exit', 3, 14, 2], [0, 0, 'exit', 3, 17, 31],
  [0, 0, 'entry', 2, 8, 45], [0, 0, 'exit', 2, 17, 12], [1, 1, 'entry', 2, 18, 40], [1, 1, 'exit', 2, 21, 6],
  [0, 0, 'entry', 1, 8, 51], [2, 1, 'entry', 1, 9, 33], [2, 1, 'exit', 1, 15, 20], [0, 0, 'exit', 1, 18, 7],
  [0, 0, 'entry', 0, 8, 42],
];

const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

// London wall-clock times, stored in UTC as the server does.
function at(daysAgo, hour, minute) {
  const d = new Date(Date.now() - daysAgo * 86400000);
  const offset = new Date(d.toLocaleString('en-US', { timeZone: 'Europe/London' })) - new Date(d.toLocaleString('en-US', { timeZone: 'UTC' }));
  d.setUTCHours(hour, minute, 0, 0);
  d.setTime(d.getTime() - offset);
  // "This morning" before the morning has happened is a week ago instead.
  if (d > new Date()) d.setTime(d.getTime() - 7 * 86400000);
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
      "INSERT INTO members (vesopa_sub, email, name, phone, company, status, plan_id, notes) VALUES (?, ?, ?, '01632 960123', 'Metric Group', 'active', ?, ?)",
      [sub, email, name, plan ? plan.id : null, note],
    );
    await db.run('UPDATE members SET member_no = ? WHERE id = ?', [`MG${String(100000 + res.insertId)}`, res.insertId]);
    member = await db.one('SELECT * FROM members WHERE id = ?', [res.insertId]);
    console.log(`  created member ${member.member_no}`);
  } else {
    console.log(`  member ${member.member_no} already exists`);
  }
  await db.run(
    "UPDATE members SET status = 'active', email = ?, name = IF(name = '', ?, name), plan_id = COALESCE(plan_id, ?), valid_from = ?, valid_to = ?, notes = ? WHERE id = ?",
    [email, name, plan ? plan.id : null, day(-90), day(365), note, member.id],
  );

  const sites = [];
  for (const s of SITES) {
    let site = await db.one('SELECT id FROM sites WHERE name = ?', [s.name]);
    if (!site) {
      const res = await db.run('INSERT INTO sites (name, address, public, active) VALUES (?, ?, 0, 0)', [s.name, s.address]);
      site = { id: res.insertId };
      console.log(`  created the hidden test car park ${s.name}`);
    }
    const gates = {};
    for (const direction of ['entry', 'exit']) {
      const gateName = direction === 'entry' ? 'Entry barrier' : 'Exit barrier';
      let gate = await db.one('SELECT id FROM gates WHERE site_id = ? AND name = ?', [site.id, gateName]);
      if (!gate) {
        const key = crypto.createHash('sha256').update(crypto.randomBytes(32)).digest('hex');
        const res = await db.run('INSERT INTO gates (site_id, name, direction, key_hash, active) VALUES (?, ?, ?, ?, 0)', [site.id, gateName, direction, key]);
        gate = { id: res.insertId };
      }
      gates[direction] = gate.id;
    }
    sites.push({ id: site.id, gates });
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
    const rows = VISITS.map(([car, s, direction, daysAgo, hour, minute, reason]) => ({ car, s, direction, reason, when: at(daysAgo, hour, minute) }))
      .filter((r) => vehicleIds[r.car])
      .sort((a, b) => (a.when < b.when ? -1 : 1));
    for (const r of rows) {
      await db.run(
        `INSERT INTO access_events (gate_id, site_id, plate, direction, decision, reason, member_id, vehicle_id, source, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'test', ?)`,
        [sites[r.s].gates[r.direction], sites[r.s].id, plates.normalise(CARS[r.car].plate), r.direction,
          r.reason ? 'deny' : 'open', r.reason || 'member', member.id, vehicleIds[r.car], r.when],
      );
    }
    console.log(`  added ${rows.length} visits`);
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
