/**
 * Memberships: plans, members, freezes, families, classes and the partner API
 * Metric reads, against a real MySQL/MariaDB like modules.test.js. Skips
 * cleanly when no database is reachable.
 *
 * THE RULES THAT MATTER
 *
 *   1. Nothing answers for a venue without the Memberships module on.
 *   2. Joining dates the membership from today for the plan's term; renewing
 *      early extends, it never shortens.
 *   3. A freeze gives the days back on the expiry, is limited to the plan's
 *      days a year, and the gym door turns a frozen card away.
 *   4. A family plan holds as many people as it says, and they follow the
 *      payer's dates and state.
 *   5. Classes fill up, then waitlist; a cancellation promotes the waitlist.
 *   6. Metric's partner key sees only its own venue, and new sign-ups wait
 *      for approval.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');

const SECRET = 'memberships-test-secret';
process.env.JWT_SECRET = SECRET;

const { moduleRoutes, setAllowed } = require('../src/modules');
const { membershipRoutes, issuePartnerKey, doorCheck, stateOf } = require('../src/memberships');

const DB = process.env.MEMBERSHIPS_TEST_DB || 'vesopa_memberships_selftest';
const USER = process.env.EXPRESS_TEST_USER || process.env.DINEIN_TEST_USER || 'root';
const PASS = process.env.EXPRESS_TEST_PASS || process.env.DINEIN_TEST_PASS || '';
const HOST = process.env.EXPRESS_TEST_HOST || '127.0.0.1';

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${e.stack || e.message}`);
    process.exitCode = 1;
  }
}

const GYM = { id: 1, name: 'Iron Gym', email: 'iron@memberships.test' };
const PUB = { id: 2, name: 'The Arms', email: 'arms@memberships.test' };
const sessionFor = (o) => jwt.sign({ email: o.email, officeId: o.id, role: 'office' }, SECRET);
const tillFor = (o) => jwt.sign({ scope: 'terminal', office: o.email, officeId: o.id }, SECRET);

async function applySchema(conn, file) {
  const migration = fs.readFileSync(path.join(__dirname, '..', 'schema', file), 'utf8');
  let delimiter = ';';
  let buffer = '';
  for (const line of migration.split(/\r?\n/)) {
    const d = /^DELIMITER\s+(\S+)/.exec(line.trim());
    if (d) { delimiter = d[1]; continue; }
    if (line.trim().startsWith('--') && !buffer.trim()) continue;
    buffer += line + '\n';
    if (buffer.trimEnd().endsWith(delimiter)) {
      const sql = buffer.trimEnd().slice(0, -delimiter.length).trim();
      if (sql) await conn.query(sql);
      buffer = '';
    }
  }
}

function call(server, method, url, token, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: server.address().port, method, path: url,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function main() {
  let admin;
  try {
    admin = await mysql.createConnection({ host: HOST, user: USER, password: PASS, multipleStatements: true });
  } catch (e) {
    console.log(`-- no database reachable, skipping (${e.code || e.message})`);
    return;
  }
  await admin.query(`DROP DATABASE IF EXISTS ${DB}; CREATE DATABASE ${DB} CHARACTER SET utf8mb4;`);
  await admin.query(`USE ${DB}`);
  await admin.query(`CREATE TABLE backoffice_users (
    id INT AUTO_INCREMENT PRIMARY KEY, email VARCHAR(190), password VARCHAR(255),
    name VARCHAR(190), company VARCHAR(190), approved CHAR(1)) ENGINE=InnoDB`);
  // Every schema file this feature reads, in the order the deploy applies
  // them, twice: the second pass proves each is safe to run again.
  // The deploy applies every file, in order; so does this, twice, which also
  // proves each is safe to run again. Files about tables this test does not
  // build (products, staff) fail on the missing table and are skipped; the
  // ones this feature owns must apply cleanly.
  const mustApply = /^schema_(customers|loyalty_schemes|tenancy|till_gym|venue_modules|memberships|memberships_collation)\.sql$/;
  const files = fs.readdirSync(path.join(__dirname, '..', 'schema')).filter((f) => f.endsWith('.sql')).sort();
  for (let pass = 0; pass < 2; pass++) {
    for (const f of files) {
      try {
        await applySchema(admin, f);
      } catch (e) {
        if (mustApply.test(f)) throw new Error(`${f}: ${e.message}`);
      }
    }
  }

  const pool = mysql.createPool({ host: HOST, user: USER, password: PASS, database: DB, connectionLimit: 5, dateStrings: false });
  await pool.query('INSERT INTO offices (id, name, contact_email) VALUES (?,?,?), (?,?,?)',
    [GYM.id, GYM.name, GYM.email, PUB.id, PUB.name, PUB.email]);

  const app = express();
  const broadcast = () => {};
  app.use(moduleRoutes({ pool, broadcast, secret: SECRET }));
  app.use(membershipRoutes({ pool, broadcast, secret: SECRET }));
  app.use((err, _req, res, _next) => { console.error(err); res.status(500).json({ error: err.message }); });
  const server = app.listen(0);
  const bo = sessionFor(GYM);
  const till = tillFor(GYM);

  try {
    await check('nothing answers before the module is allowed', async () => {
      const r = await call(server, 'GET', '/api/memberships/plans', bo);
      assert.strictEqual(r.status, 404);
      const t = await call(server, 'GET', '/till/memberships/plans', till);
      assert.strictEqual(t.status, 404);
    });

    await setAllowed(pool, GYM.id, { memberships: { allowed: true } }, 'test');

    const [plan] = await pool.query(
      `INSERT INTO epos_loyalty_schemes (office, name, is_membership, membership_fee_minor, membership_term_months,
         joining_fee_minor, family_size, freeze_days_per_year, class_credits_per_month)
       VALUES (?, 'Gold', 1, 3500, 1, 1000, 3, 30, 2)`, [GYM.email]);
    const [single] = await pool.query(
      `INSERT INTO epos_loyalty_schemes (office, name, is_membership, membership_fee_minor, membership_term_months,
         includes_gym, includes_classes)
       VALUES (?, 'Classes only', 1, 2000, 12, 0, 1)`, [GYM.email]);
    await pool.query("INSERT INTO epos_loyalty_schemes (office, name) VALUES (?, 'Regulars')", [GYM.email]);

    await check('plans are the membership schemes only, with their extras', async () => {
      const r = await call(server, 'GET', '/api/memberships/plans', bo);
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(r.body.map((p) => p.name).sort(), ['Classes only', 'Gold']);
      const gold = r.body.find((p) => p.name === 'Gold');
      assert.strictEqual(gold.fee_minor, 3500);
      assert.strictEqual(gold.joining_fee_minor, 1000);
      assert.strictEqual(gold.family_size, 3);
      assert.strictEqual(gold.includes_gym, true);
    });

    const [[{ d: today }]] = await pool.query("SELECT DATE_FORMAT(CURDATE(), '%Y-%m-%d') AS d");
    const [[{ d: inMonth }]] = await pool.query("SELECT DATE_FORMAT(CURDATE() + INTERVAL 1 MONTH, '%Y-%m-%d') AS d");
    const [[{ d: inTwo }]] = await pool.query("SELECT DATE_FORMAT(CURDATE() + INTERVAL 2 MONTH, '%Y-%m-%d') AS d");

    let ann;
    await check('joining a new member dates it from today for the term', async () => {
      const r = await call(server, 'POST', '/till/memberships/members', till,
        { scheme_id: plan.insertId, customer: { name: 'Ann Lee', email: 'ann@example.com', card_number: '4001' } });
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      ann = r.body;
      assert.strictEqual(ann.state, 'active');
      assert.strictEqual(ann.joined_on, today);
      assert.strictEqual(ann.membership_expiry, inMonth);
      assert.ok(ann.member_no, 'a member number is given');
      assert.strictEqual(ann.history[0].kind, 'join');
      assert.strictEqual(ann.history[0].via, 'till');
    });

    await check('joining twice is refused', async () => {
      const r = await call(server, 'POST', '/api/memberships/members', bo, { scheme_id: plan.insertId, customer_id: ann.id });
      assert.strictEqual(r.status, 409);
    });

    await check('renewing early extends from the expiry', async () => {
      const r = await call(server, 'POST', `/api/memberships/members/${ann.id}/renew`, bo, {});
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.strictEqual(r.body.membership_expiry, inTwo);
    });

    let kid;
    await check('a family plan takes as many people as it covers, then is full', async () => {
      const a = await call(server, 'POST', '/api/memberships/members', bo, { family_head_id: ann.id, customer: { name: 'Kid One' } });
      assert.strictEqual(a.status, 201, JSON.stringify(a.body));
      kid = a.body;
      assert.strictEqual(kid.membership_expiry, inTwo);
      const b = await call(server, 'POST', '/api/memberships/members', bo, { family_head_id: ann.id, customer: { name: 'Kid Two' } });
      assert.strictEqual(b.status, 201);
      const c = await call(server, 'POST', '/api/memberships/members', bo, { family_head_id: ann.id, customer: { name: 'Kid Three' } });
      assert.strictEqual(c.status, 409);
      const d = await call(server, 'GET', `/api/memberships/members/${ann.id}`, bo);
      assert.strictEqual(d.body.family.length, 3);
    });

    await check('a freeze moves the expiry on, follows the family, and the door refuses', async () => {
      const [[{ d: until }]] = await pool.query("SELECT DATE_FORMAT(CURDATE() + INTERVAL 9 DAY, '%Y-%m-%d') AS d");
      const r = await call(server, 'POST', `/api/memberships/members/${ann.id}/freeze`, bo, { from: today, until });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.strictEqual(r.body.state, 'frozen');
      const [[{ d: moved }]] = await pool.query("SELECT DATE_FORMAT(CURDATE() + INTERVAL 2 MONTH + INTERVAL 10 DAY, '%Y-%m-%d') AS d");
      assert.strictEqual(r.body.membership_expiry, moved);
      const k = await call(server, 'GET', `/api/memberships/members/${kid.id}`, bo);
      assert.strictEqual(k.body.state, 'frozen', 'family follow the payer');
      const door = await doorCheck(pool, GYM.email, ann.id);
      assert.strictEqual(door && door.reason, 'frozen');
    });

    await check('freezing beyond the plan\'s days a year is refused', async () => {
      await call(server, 'POST', `/api/memberships/members/${ann.id}/unfreeze`, bo, {});
      const [[{ d: until }]] = await pool.query("SELECT DATE_FORMAT(CURDATE() + INTERVAL 40 DAY, '%Y-%m-%d') AS d");
      const r = await call(server, 'POST', `/api/memberships/members/${ann.id}/freeze`, bo, { from: today, until });
      assert.strictEqual(r.status, 409);
    });

    await check('unfreezing on the first day takes back the unused days', async () => {
      const d = await call(server, 'GET', `/api/memberships/members/${ann.id}`, bo);
      assert.strictEqual(d.body.state, 'active');
      // Frozen today, ten days: unfreezing today keeps today, takes back nine.
      const [[{ d: expect }]] = await pool.query("SELECT DATE_FORMAT(CURDATE() + INTERVAL 2 MONTH + INTERVAL 1 DAY, '%Y-%m-%d') AS d");
      assert.strictEqual(d.body.membership_expiry, expect);
      assert.strictEqual(d.body.freeze_days_used, 1);
    });

    await check('a plan without the gym is refused at the door', async () => {
      const r = await call(server, 'POST', '/api/memberships/members', bo, { scheme_id: single.insertId, customer: { name: 'Bea' } });
      assert.strictEqual(r.status, 201);
      const door = await doorCheck(pool, GYM.email, r.body.id);
      assert.strictEqual(door && door.reason, 'no_gym');
    });

    await check('a customer who never joined a plan is let in as before', async () => {
      await pool.query("INSERT INTO epos_customers (id, email_key, name) VALUES ('walkin', ?, 'Walk In')", [GYM.email]);
      assert.strictEqual(await doorCheck(pool, GYM.email, 'walkin'), null);
    });

    await check('cancel keeps what was paid for; reinstate undoes it', async () => {
      const r = await call(server, 'POST', `/api/memberships/members/${ann.id}/cancel`, bo, {});
      assert.strictEqual(r.body.state, 'cancelled');
      assert.ok(r.body.membership_expiry > today);
      const s = await call(server, 'POST', `/api/memberships/members/${ann.id}/reinstate`, bo, {});
      assert.strictEqual(s.body.state, 'active');
    });

    let session;
    await check('classes: a timetable makes sessions, which fill up then waitlist', async () => {
      const k = await call(server, 'POST', '/api/classes', bo, { name: 'Spin', capacity: 1, duration_min: 45 });
      assert.strictEqual(k.status, 201);
      const [[{ wd, d }]] = await pool.query("SELECT WEEKDAY(CURDATE() + INTERVAL 1 DAY) + 1 AS wd, DATE_FORMAT(CURDATE() + INTERVAL 1 DAY, '%Y-%m-%d') AS d");
      const t = await call(server, 'POST', '/api/classes/timetable', bo, { class_id: k.body.id, weekday: wd, start_time: '18:30' });
      assert.strictEqual(t.status, 201, JSON.stringify(t.body));
      const s = await call(server, 'GET', `/api/classes/sessions?from=${d}&to=${d}`, bo);
      assert.strictEqual(s.status, 200, JSON.stringify(s.body));
      assert.strictEqual(s.body.length, 1);
      session = s.body[0];
      const again = await call(server, 'GET', `/api/classes/sessions?from=${d}&to=${d}`, bo);
      assert.strictEqual(again.body.length, 1, 'opening the day twice makes the session once');
      const a = await call(server, 'POST', `/api/classes/sessions/${session.id}/book`, bo, { customer_id: ann.id });
      assert.strictEqual(a.body.status, 'booked', JSON.stringify(a.body));
      const b = await call(server, 'POST', `/api/classes/sessions/${session.id}/book`, bo, { customer_id: kid.id });
      assert.strictEqual(b.body.status, 'waitlist');
      await call(server, 'POST', `/api/classes/sessions/${session.id}/unbook`, bo, { customer_id: ann.id });
      const v = await call(server, 'GET', `/api/classes/sessions/${session.id}`, bo);
      const kidBooking = v.body.bookings.find((x) => x.customer_id === kid.id);
      assert.strictEqual(kidBooking.status, 'booked', 'the waitlist moves up');
    });

    await check('a customer without a membership needs a drop-in', async () => {
      const r = await call(server, 'POST', `/till/classes/sessions/${session.id}/book`, till, { customer_id: 'walkin' });
      assert.strictEqual(r.status, 409);
    });

    let key;
    await check('Metric: a partner key reads its venue\'s plans and members', async () => {
      key = await issuePartnerKey(pool, GYM.email, 'Metric', 'test');
      const token = typeof key === 'string' ? key : key.key;
      key = token;
      const p = await call(server, 'GET', '/partner/v1/memberships/plans', key);
      assert.strictEqual(p.status, 200);
      assert.strictEqual(p.body.length, 2);
      const m = await call(server, 'GET', '/partner/v1/memberships/members', key);
      assert.ok(m.body.some((x) => x.name === 'Ann Lee'));
      const bad = await call(server, 'GET', '/partner/v1/memberships/members', 'vpk_nope');
      assert.strictEqual(bad.status, 401);
    });

    await check('Metric: a sign-up waits for approval, then is approved', async () => {
      const r = await call(server, 'POST', '/partner/v1/memberships/members', key,
        { name: 'Matt Driver', email: 'matt@example.com', vesopa_sub: 'sub-123', scheme_id: plan.insertId });
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      assert.strictEqual(r.body.state, 'pending');
      const again = await call(server, 'POST', '/partner/v1/memberships/members', key, { email: 'matt@example.com', vesopa_sub: 'sub-123' });
      assert.strictEqual(again.body.id, r.body.id, 'the same person is not added twice');
      const ok = await call(server, 'POST', `/partner/v1/memberships/members/${r.body.id}/approve`, key, { by: 'staff@metric' });
      assert.strictEqual(ok.body.state, 'active');
      const s = await call(server, 'POST', `/partner/v1/memberships/members/${r.body.id}/suspend`, key, {});
      assert.strictEqual(s.body.state, 'cancelled');
    });

    await check('another venue cannot see this venue\'s members', async () => {
      await setAllowed(pool, PUB.id, { memberships: { allowed: true } }, 'test');
      const r = await call(server, 'GET', `/api/memberships/members/${ann.id}`, sessionFor(PUB));
      assert.strictEqual(r.status, 404);
    });

    await check('withdrawing the module hides it again and keeps the members', async () => {
      await setAllowed(pool, GYM.id, { memberships: { allowed: false } }, 'test');
      const r = await call(server, 'GET', '/api/memberships/members', bo);
      assert.strictEqual(r.status, 404);
      const [[{ n }]] = await pool.query("SELECT COUNT(*) AS n FROM epos_customers WHERE email_key = ? AND membership_status <> ''", [GYM.email]);
      assert.ok(Number(n) >= 5);
    });

    await check('a database missing a member column still lists members', async () => {
      const { forgetMemberColumns } = require('../src/memberships');
      await setAllowed(pool, GYM.id, { memberships: { allowed: true } }, 'test');
      await pool.query('ALTER TABLE epos_customers DROP COLUMN photo_url');
      forgetMemberColumns();
      const m = await call(server, 'GET', '/partner/v1/memberships/members', key);
      assert.strictEqual(m.status, 200, JSON.stringify(m.body));
      assert.ok(m.body.length > 0);
      const b = await call(server, 'GET', '/api/memberships/members', bo);
      assert.strictEqual(b.status, 200, JSON.stringify(b.body));
    });

    await check('plans and members list when office columns differ in collation', async () => {
      // The live server: epos_customers.email_key in one collation, the
      // office columns of older tables in another.
      await pool.query('ALTER TABLE epos_loyalty_schemes MODIFY office VARCHAR(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL');
      const p = await call(server, 'GET', '/partner/v1/memberships/plans', key);
      assert.strictEqual(p.status, 200, JSON.stringify(p.body));
      const m = await call(server, 'GET', '/partner/v1/memberships/members', key);
      assert.strictEqual(m.status, 200, JSON.stringify(m.body));
    });

    await check('stateOf reads the states', async () => {
      assert.strictEqual(stateOf({ membership_status: '' }, '2026-01-01'), 'none');
      assert.strictEqual(stateOf({ membership_status: 'active', membership_expiry: '2025-12-31' }, '2026-01-01'), 'expired');
      assert.strictEqual(stateOf({ membership_status: 'frozen', frozen_from: '2026-01-01', frozen_until: '2026-01-05' }, '2026-01-03'), 'frozen');
    });
  } finally {
    server.close();
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin.end();
  }
  console.log(`memberships: ${passed} checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
