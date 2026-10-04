/**
 * Modules: what Vesopa admin allows a venue, and what its manager switches on.
 *
 * Run against a real MySQL/MariaDB, like express.test.js, because the parts
 * that can go wrong are SQL: the upsert that must switch a module on when it is
 * first allowed but leave a manager's "off" alone afterwards, the migration
 * backfill that must keep every gym that is already running, and the invoice
 * that must carry the module prices. Skips cleanly when no database is
 * reachable.
 *
 * THE RULES THAT MATTER
 *
 *   1. Nothing is on for a venue until admin allows it.
 *   2. Allowing switches it on; the manager can then switch it off, and admin
 *      saving the venue again does not switch it back on behind their back.
 *   3. A manager cannot switch on what admin has not allowed.
 *   4. The gym door obeys the admin switch everywhere, and a venue already
 *      running the gym before modules keeps it.
 *   5. Allowed modules are charged on the next invoice, monthly or yearly.
 *   6. Devices see only what is on.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');

const SECRET = 'modules-test-secret';
process.env.JWT_SECRET = SECRET;

const { moduleRoutes, moduleCharges } = require('../src/modules');
const { adminRoutes } = require('../src/admin');
const { gymRoutes } = require('../src/gym');

const DB = process.env.MODULES_TEST_DB || 'vesopa_modules_selftest';
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

const GYM = { id: 1, name: 'Iron Gym', email: 'iron@modules.test' };
const PUB = { id: 2, name: 'The Arms', email: 'arms@modules.test' };

const adminToken = jwt.sign({ email: 'admin@vesopa.test', role: 'admin' }, SECRET);
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
  await applySchema(admin, 'schema_tenancy.sql');
  await applySchema(admin, 'schema_till_gym.sql');

  // Before the migration: the gym is running at the gym, and was never on at
  // the pub. The backfill has to keep the first and must not invent the second.
  await admin.query(
    'INSERT INTO offices (id, name, contact_email, status) VALUES (?,?,?,\'active\'), (?,?,?,\'active\')',
    [GYM.id, GYM.name, GYM.email, PUB.id, PUB.name, PUB.email]
  );
  await admin.query('INSERT INTO epos_gym_settings (office, enabled) VALUES (?, 1)', [GYM.email]);

  // The migration, twice: the deploy runs every file on every deploy.
  for (let run = 0; run < 2; run++) await applySchema(admin, 'schema_venue_modules.sql');
  await admin.end();

  const pool = mysql.createPool({ host: HOST, user: USER, password: PASS, database: DB, connectionLimit: 4 });
  const sent = [];
  const broadcast = (m) => sent.push(m);

  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRoutes({ pool, broadcast, secret: SECRET }));
  app.use(gymRoutes({ pool, broadcast, secret: SECRET }));
  app.use(moduleRoutes({ pool, broadcast, secret: SECRET }));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));

  const mod = (list, key) => list.find((m) => m.key === key);

  try {
    await check('a gym already running before modules keeps it', async () => {
      const r = await call(server, 'GET', '/api/modules', sessionFor(GYM));
      assert.strictEqual(r.status, 200);
      const gym = mod(r.body, 'gym_door');
      assert.strictEqual(gym.allowed, true);
      assert.strictEqual(gym.on, true);
      const s = await call(server, 'GET', '/till/gym/settings', null);
      assert.strictEqual(s.status, 401);
      const till = await call(server, 'GET', '/till/gym/settings', tillFor(GYM));
      assert.strictEqual(till.body.enabled, 1);
    });

    await check('nothing is on at a venue admin has not allowed anything', async () => {
      const r = await call(server, 'GET', '/api/modules', sessionFor(PUB));
      assert.ok(r.body.every((m) => !m.allowed && !m.on));
      const till = await call(server, 'GET', '/till/modules', tillFor(PUB));
      assert.deepStrictEqual(till.body.on, []);
    });

    await check('a manager cannot switch on what admin has not allowed', async () => {
      const r = await call(server, 'PUT', '/api/modules/memberships', sessionFor(PUB), { enabled: true });
      assert.strictEqual(r.status, 403);
      const g = await call(server, 'PUT', '/api/gym/settings', sessionFor(PUB), { enabled: 1 });
      assert.strictEqual(g.status, 403);
    });

    await check('the gym switch alone does not open the door without admin', async () => {
      // A row written directly, as an older till version or a person might.
      await pool.query('INSERT INTO epos_gym_settings (office, enabled) VALUES (?, 1)', [PUB.email]);
      const till = await call(server, 'GET', '/till/gym/settings', tillFor(PUB));
      assert.strictEqual(till.body.enabled, 0);
      assert.strictEqual(till.body.module_allowed, 0);
      const board = await call(server, 'GET', '/till/gym/board', tillFor(PUB));
      assert.strictEqual(board.status, 404);
    });

    await check('only admin can allow modules', async () => {
      const r = await call(server, 'PUT', `/api/admin/offices/${PUB.id}/modules`, sessionFor(PUB),
        { modules: { memberships: { allowed: true } } });
      assert.strictEqual(r.status, 403);
    });

    await check('allowing a module switches it on, and the till sees it', async () => {
      const r = await call(server, 'PUT', `/api/admin/offices/${PUB.id}/modules`, adminToken,
        { modules: { memberships: { allowed: true, price_minor: 1500 } } });
      assert.strictEqual(r.status, 200);
      const m = mod(r.body, 'memberships');
      assert.strictEqual(m.on, true);
      assert.strictEqual(m.price_minor, 1500);
      const till = await call(server, 'GET', '/till/modules', tillFor(PUB));
      assert.deepStrictEqual(till.body.on, ['memberships']);
      assert.ok(sent.some((x) => x.type === 'modules'));
    });

    await check("the manager's off survives admin saving the venue again", async () => {
      const off = await call(server, 'PUT', '/api/modules/memberships', sessionFor(PUB), { enabled: false });
      assert.strictEqual(off.status, 200);
      assert.strictEqual(mod(off.body, 'memberships').on, false);
      const again = await call(server, 'PUT', `/api/admin/offices/${PUB.id}/modules`, adminToken,
        { modules: { memberships: { allowed: true, price_minor: 1500 } } });
      const m = mod(again.body, 'memberships');
      assert.strictEqual(m.allowed, true);
      assert.strictEqual(m.enabled, false);
    });

    await check('withdrawing keeps the row and hides it; allowing again turns it on', async () => {
      const w = await call(server, 'PUT', `/api/admin/offices/${PUB.id}/modules`, adminToken,
        { modules: { memberships: { allowed: false } } });
      assert.strictEqual(mod(w.body, 'memberships').on, false);
      const [[row]] = await pool.query('SELECT price_minor FROM bo_venue_modules WHERE office_id = ? AND module = ?', [PUB.id, 'memberships']);
      assert.strictEqual(row.price_minor, 1500);
      const a = await call(server, 'PUT', `/api/admin/offices/${PUB.id}/modules`, adminToken,
        { modules: { memberships: { allowed: true } } });
      assert.strictEqual(mod(a.body, 'memberships').on, true);
      assert.strictEqual(mod(a.body, 'memberships').price_minor, 1500);
    });

    await check('allowing the gym door opens it, through the same gym settings', async () => {
      await call(server, 'PUT', `/api/admin/offices/${PUB.id}/modules`, adminToken,
        { modules: { gym_door: { allowed: true } } });
      const till = await call(server, 'GET', '/till/gym/settings', tillFor(PUB));
      assert.strictEqual(till.body.enabled, 1);
      const off = await call(server, 'PUT', '/api/modules/gym_door', sessionFor(PUB), { enabled: false });
      assert.strictEqual(mod(off.body, 'gym_door').on, false);
      const after = await call(server, 'GET', '/till/gym/settings', tillFor(PUB));
      assert.strictEqual(after.body.enabled, 0);
    });

    await check('default prices apply where a venue has none', async () => {
      const p = await call(server, 'PUT', '/api/admin/modules/prices', adminToken, { vehicle_access: 2500, nonsense: 9 });
      assert.strictEqual(p.status, 200);
      await call(server, 'PUT', `/api/admin/offices/${PUB.id}/modules`, adminToken,
        { modules: { vehicle_access: { allowed: true } } });
      const r = await call(server, 'GET', `/api/admin/offices/${PUB.id}/modules`, adminToken);
      assert.strictEqual(mod(r.body, 'vehicle_access').price_minor, 2500);
      const bad = await call(server, 'PUT', `/api/admin/offices/${PUB.id}/modules`, adminToken,
        { modules: { vehicle_access: { allowed: true, price_minor: -5 } } });
      assert.strictEqual(bad.status, 400);
    });

    await check('allowed modules are charged: monthly, and twelve times on a yearly plan', async () => {
      // memberships 15.00 + vehicle_access 25.00; the gym door costs nothing.
      const m = await moduleCharges(pool, PUB.id, 'month');
      assert.strictEqual(m.total, 4000);
      assert.match(m.detail, /Memberships 15\.00/);
      const y = await moduleCharges(pool, PUB.id, 'year');
      assert.strictEqual(y.total, 48000);
    });

    await check('a new office with modules ticked is billed for them on its first invoice', async () => {
      const r = await call(server, 'POST', '/api/admin/offices', adminToken, {
        name: 'New Gym', contact_email: 'new@modules.test', password: 'pw-12345678',
        amount_minor: 5000, interval_unit: 'month', modules: ['memberships', 'gym_door', 'made_up'],
      });
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      const list = await call(server, 'GET', `/api/admin/offices/${r.body.id}/modules`, adminToken);
      assert.strictEqual(mod(list.body, 'memberships').on, true);
      assert.strictEqual(mod(list.body, 'gym_door').on, true);
      assert.strictEqual(mod(list.body, 'vehicle_access').allowed, false);
      const [[inv]] = await pool.query('SELECT amount_minor, modules_minor, modules_detail FROM subscription_invoices WHERE office_id = ?', [r.body.id]);
      // 50.00 + memberships at the default price (0, none set) = 50.00.
      assert.strictEqual(inv.amount_minor, 5000);
      assert.strictEqual(inv.modules_minor, 0);
    });

    await check('paying an invoice raises the next one with module charges', async () => {
      await pool.query(
        "INSERT INTO subscriptions (office_id, amount_minor, interval_unit, next_due_on, status) VALUES (?, 3000, 'month', CURDATE(), 'active')",
        [PUB.id]
      );
      const [[sub]] = await pool.query('SELECT id FROM subscriptions WHERE office_id = ?', [PUB.id]);
      const [ins] = await pool.query(
        "INSERT INTO subscription_invoices (subscription_id, office_id, amount_minor, due_on, status) VALUES (?, ?, 3000, CURDATE(), 'due')",
        [sub.id, PUB.id]
      );
      const paid = await call(server, 'POST', `/api/admin/invoices/${ins.insertId}/paid`, adminToken);
      assert.strictEqual(paid.status, 200);
      const [[next]] = await pool.query(
        "SELECT amount_minor, modules_minor, modules_detail FROM subscription_invoices WHERE office_id = ? AND status = 'due'",
        [PUB.id]
      );
      assert.strictEqual(next.amount_minor, 3000 + 4000);
      assert.strictEqual(next.modules_minor, 4000);
      assert.match(next.modules_detail, /Vehicle access 25\.00/);
    });
  } finally {
    server.close();
    await pool.end();
  }

  console.log(`\n${passed} passed`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
