/**
 * Pausing and removing a venue's apps, modules and Loyalty app from
 * admin.vesopa.com (2026-10-05), against a real MySQL/MariaDB.
 *
 *   * a server without the table answers "no hold", so a deploy changes nothing;
 *   * a pause warns through a grace day, then locks the device even at a venue
 *     that was never made lockable, and no new device of that kind signs in;
 *   * a module past its grace reads as not allowed and leaves the invoice;
 *   * pressing Pause twice does not give a second free day;
 *   * resume puts everything back;
 *   * ADMIN_SERVICE_KEY opens /api/admin and nothing else.
 *
 * SKIPPED when no database is reachable. Root with no password on 127.0.0.1,
 * like the other database tests.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');

const SECRET = 'holds-test-secret';
const SERVICE_KEY = 'k'.repeat(48);
process.env.JWT_SECRET = SECRET;
process.env.ADMIN_SERVICE_KEY = SERVICE_KEY;

const holds = require('../src/admin_holds');
const licences = require('../src/licences');
const { modulesFor, moduleCharges } = require('../src/modules');
const { requireAuth } = require('../src/auth');

const DB = 'vesopa_admin_holds_selftest';
const HOST = '127.0.0.1';
const PUB = { id: 7, name: 'The Arms', email: 'arms@holds.test' };

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

function call(server, method, url, token, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: server.address().port, method, path: url,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
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
  console.log('\nLicence holds\n');
  let root;
  try {
    root = await mysql.createConnection({ host: HOST, user: 'root', password: '', multipleStatements: true });
  } catch (e) {
    console.log(`  -- no database reachable, skipping (${e.code || e.message})`);
    return;
  }
  await root.query(`DROP DATABASE IF EXISTS ${DB}; CREATE DATABASE ${DB} CHARACTER SET utf8mb4; USE ${DB};`);
  await root.query(`CREATE TABLE backoffice_users (
    id INT AUTO_INCREMENT PRIMARY KEY, email VARCHAR(190), password VARCHAR(255),
    name VARCHAR(190), company VARCHAR(190), approved CHAR(1)) ENGINE=InnoDB`);
  await root.query(`CREATE TABLE epos_card_settings (
    office VARCHAR(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL PRIMARY KEY) ENGINE=InnoDB`);
  await applySchema(root, 'schema_tenancy.sql');
  await applySchema(root, 'schema_till_gym.sql');
  await applySchema(root, 'schema_venue_modules.sql');
  await root.query("INSERT INTO offices (id, name, contact_email, status) VALUES (?, ?, ?, 'active')",
    [PUB.id, PUB.name, PUB.email]);
  await root.end();

  const pool = mysql.createPool({ host: HOST, user: 'root', password: '', database: DB, connectionLimit: 4 });
  const sent = [];
  const app = express();
  app.use(express.json());
  const admin = (req, res, next) => (req.user && req.user.role === 'admin' ? next() : res.status(403).json({ error: 'no' }));
  app.use('/api/admin', holds.adminHoldRoutes({ pool, broadcast: (m) => sent.push(m), auth: requireAuth(SECRET), admin }));
  app.get('/api/products', requireAuth(SECRET), (req, res) => res.json({ user: req.user }));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));

  try {
    await check('without the migration there is no hold, and nothing locks', async () => {
      assert.strictEqual(await holds.holdFor(pool, PUB.email, 'till'), null);
      const s = await licences.stateFor(pool, PUB.email, 'till');
      assert.strictEqual(s.locked, false);
      assert.strictEqual(s.paused, null);
    });

    for (let run = 0; run < 2; run++) {
      const conn = await pool.getConnection();
      await applySchema(conn, 'schema_admin_holds.sql');
      conn.release();
    }

    await check('the service key opens /api/admin only, and names the admin', async () => {
      const wrong = await call(server, 'GET', `/api/admin/offices/${PUB.id}/holds`, 'x'.repeat(48));
      assert.strictEqual(wrong.status, 401);
      const elsewhere = await call(server, 'GET', '/api/products', SERVICE_KEY);
      assert.strictEqual(elsewhere.status, 401, 'the key must not open venue routes');
      const r = await call(server, 'GET', `/api/admin/offices/${PUB.id}/holds`, SERVICE_KEY);
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.deepStrictEqual(r.body.holds, {});
    });

    await check('a paused till warns through the grace day and still runs', async () => {
      const r = await call(server, 'PUT', `/api/admin/offices/${PUB.id}/holds/till`, SERVICE_KEY,
        { action: 'pause', reason: 'Unpaid since August' }, { 'X-Vesopa-Admin': 'Info@VesopaSoftware.com' });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.strictEqual(r.body.hold.stopped, false);
      assert.match(r.body.hold.heldBy, /^info@vesopasoftware\.com \(admin\.vesopa\.com\)$/);
      assert.ok(sent.some((m) => m.type === 'till-settings' && m.office === PUB.email));
      const s = await licences.stateFor(pool, PUB.email, 'till');
      assert.strictEqual(s.locked, false);
      assert.strictEqual(s.paused, 'paused');
      assert.ok(s.renewBy, 'the existing lapsing warning shows');
      assert.match(s.notice, /Till has been paused and stops at/);
      assert.strictEqual(await licences.limitFor(pool, PUB.email, 'till'), null);
    });

    await check('pausing again keeps the first grace', async () => {
      const [[before]] = await pool.query('SELECT grace_until FROM bo_admin_holds WHERE office = ?', [PUB.email]);
      await new Promise((r) => setTimeout(r, 1100));
      await holds.setHold(pool, PUB.email, 'till', { action: 'pause', by: 'x@y.z' });
      const [[after]] = await pool.query('SELECT grace_until FROM bo_admin_holds WHERE office = ?', [PUB.email]);
      assert.strictEqual(new Date(after.grace_until).valueOf(), new Date(before.grace_until).valueOf());
    });

    await check('past its grace the till locks, even at a venue never made lockable', async () => {
      await pool.query('UPDATE bo_admin_holds SET grace_until = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE office = ?', [PUB.email]);
      holds.forget(PUB.email);
      const s = await licences.stateFor(pool, PUB.email, 'till');
      assert.strictEqual(s.lockable, false);
      assert.strictEqual(s.locked, true);
      assert.match(s.notice, /Till is paused for this venue/);
      assert.strictEqual(await licences.limitFor(pool, PUB.email, 'till'), 0, 'no new till signs in');
      const kitchen = await licences.stateFor(pool, PUB.email, 'kitchen');
      assert.strictEqual(kitchen.locked, false, 'only the paused app stops');
    });

    await check('resume puts the till back', async () => {
      const r = await call(server, 'PUT', `/api/admin/offices/${PUB.id}/holds/till`, SERVICE_KEY, { action: 'resume' });
      assert.strictEqual(r.body.hold, null);
      const s = await licences.stateFor(pool, PUB.email, 'till');
      assert.strictEqual(s.locked, false);
      assert.strictEqual(s.paused, null);
    });

    await check('a removed module stops after its grace and leaves the invoice', async () => {
      await pool.query(
        "INSERT INTO bo_venue_modules (office_id, module, allowed, enabled, price_minor) VALUES (?, 'memberships', 1, 1, 2900)",
        [PUB.id]
      );
      assert.strictEqual((await moduleCharges(pool, PUB.id, 'month')).total, 2900);
      await holds.setHold(pool, PUB.email, 'module:memberships', { action: 'remove', by: 'x@y.z', graceHours: 24 });
      let m = (await modulesFor(pool, PUB.id, PUB.email)).find((x) => x.key === 'memberships');
      assert.strictEqual(m.allowed, true, 'still working through the grace day');
      assert.strictEqual(m.hold.state, 'removed');
      await holds.setHold(pool, PUB.email, 'module:memberships', { action: 'remove', by: 'x@y.z', graceHours: 0 });
      await pool.query('UPDATE bo_admin_holds SET grace_until = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE office = ?', [PUB.email]);
      holds.forget(PUB.email);
      m = (await modulesFor(pool, PUB.id, PUB.email)).find((x) => x.key === 'memberships');
      assert.strictEqual(m.allowed, false);
      assert.strictEqual(m.on, false);
      assert.strictEqual((await moduleCharges(pool, PUB.id, 'month')).total, 0);
      const [[row]] = await pool.query("SELECT allowed FROM bo_venue_modules WHERE module = 'memberships'");
      assert.strictEqual(Number(row.allowed), 1, 'nothing is deleted or rewritten');
    });

    await check('something that is not sold cannot be paused', async () => {
      const r = await call(server, 'PUT', `/api/admin/offices/${PUB.id}/holds/spaceship`, SERVICE_KEY, { action: 'pause' });
      assert.strictEqual(r.status, 400);
      const bad = await call(server, 'PUT', `/api/admin/offices/${PUB.id}/holds/till`, SERVICE_KEY, { action: 'explode' });
      assert.strictEqual(bad.status, 400);
    });
  } finally {
    server.close();
    await pool.query(`DROP DATABASE IF EXISTS ${DB}`).catch(() => {});
    await pool.end();
  }
  console.log(`\n${passed} checks passed`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
