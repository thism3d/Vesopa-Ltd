/**
 * Which version of each Windows app a venue runs (admin.vesopa.com Versions,
 * 2026-10-05), against a real MySQL/MariaDB.
 *
 *   * a server without the tables, or with the switch off, offers nothing;
 *   * /licence/state records what each device runs, Store copy or ours;
 *   * a venue's own version beats the default, and "No auto updates" is a pin
 *     with no version;
 *   * an older version is offered too (moving a venue back), marked downgrade;
 *   * a Microsoft Store copy is never offered anything;
 *   * Loyalty's open check follows the default only.
 *
 * SKIPPED when no database is reachable.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');

const SECRET = 'updates-test-secret';
const SERVICE_KEY = 'u'.repeat(48);
process.env.JWT_SECRET = SECRET;
process.env.ADMIN_SERVICE_KEY = SERVICE_KEY;

const updates = require('../src/app_updates');
const { licenceRoutes } = require('../src/licences');
const { requireAuth } = require('../src/auth');

const DB = 'vesopa_app_updates_selftest';
const HOST = '127.0.0.1';
const PUB = { id: 7, name: 'The Arms', email: 'arms@updates.test' };
const CLUB = { id: 8, name: 'The Club', email: 'club@updates.test' };
const SHA = 'a'.repeat(64);

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
  let buffer = '';
  for (const line of migration.split(/\r?\n/)) {
    if (line.trim().startsWith('--') && !buffer.trim()) continue;
    buffer += line + '\n';
    if (buffer.trimEnd().endsWith(';')) {
      const sql = buffer.trimEnd().slice(0, -1).trim();
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
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
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

const device = (office, scope = 'terminal') => jwt.sign({ scope, office }, SECRET);
const as = (version, install = 'direct', id = 'PC-1') => ({
  'X-Vesopa-App-Version': version, 'X-Vesopa-Install': install, 'X-Vesopa-Device-Id': id, 'X-Vesopa-Device-Name': `Till ${id}`,
});

async function main() {
  console.log('\nApp versions\n');
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
  for (const v of [PUB, CLUB]) {
    await root.query("INSERT INTO offices (id, name, contact_email, status) VALUES (?, ?, ?, 'active')", [v.id, v.name, v.email]);
  }
  await root.end();

  const pool = mysql.createPool({ host: HOST, user: 'root', password: '', database: DB, connectionLimit: 4 });
  const sent = [];
  const app = express();
  app.use(express.json());
  const admin = (req, res, next) => (req.user && req.user.role === 'admin' ? next() : res.status(403).json({ error: 'no' }));
  app.use('/api', licenceRoutes({ pool, secret: SECRET }));
  app.use(updates.publicRoutes({ pool }));
  app.use('/api/admin', updates.adminRoutes({ pool, broadcast: (m) => sent.push(m), auth: requireAuth(SECRET), admin }));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));

  const pin = (offices, version, extra = {}) => call(server, 'PUT', '/api/admin/app-versions/till', SERVICE_KEY,
    { offices, version, url: version ? `https://admin.vesopa.com/dl/x/${version}.exe` : undefined, sha256: version ? SHA : undefined, size: 1000, ...extra });

  try {
    await check('without the tables a device is answered as before, with no update', async () => {
      const r = await call(server, 'GET', '/api/licence/state', device(PUB.email), undefined, as('1.14.2'));
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.strictEqual(r.body.locked, false);
      assert.strictEqual(r.body.update, null);
    });

    for (let run = 0; run < 2; run++) {
      const conn = await pool.getConnection();
      await applySchema(conn, 'schema_app_updates.sql');
      conn.release();
    }

    await check('versions are compared as numbers, whatever their spelling', () => {
      assert.strictEqual(updates.normalise('1.14.2.0'), '1.14.2');
      assert.strictEqual(updates.normalise('1.14.2+50'), '1.14.2');
      assert.strictEqual(updates.compare('1.9.0', '1.14.2'), -1);
      assert.strictEqual(updates.compare('1.14.2.0', '1.14.2'), 0);
      assert.strictEqual(updates.normalise('one'), null);
    });

    await check('a device says what it runs, and the admin sees it', async () => {
      await call(server, 'GET', '/api/licence/state', device(PUB.email), undefined, as('1.14.2', 'direct', 'PC-1'));
      await call(server, 'GET', '/api/licence/state', device(PUB.email), undefined, as('1.14.1', 'store', 'PC-2'));
      await call(server, 'GET', '/api/licence/state', device(PUB.email, 'kitchen'), undefined, as('1.7.2', 'direct', 'K-1'));
      const r = await call(server, 'GET', '/api/admin/app-versions?app=till', SERVICE_KEY);
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.strictEqual(r.body.enabled, false, 'off until Vesopa turns it on');
      const tills = r.body.devices.map((d) => `${d.office_id}:${d.device_id}:${d.version}:${d.install}`).sort();
      assert.deepStrictEqual(tills, ['7:PC-1:1.14.2:direct', '7:PC-2:1.14.1:store']);
    });

    await check('with the switch off, a pinned venue is told nothing', async () => {
      const r = await pin([PUB.id], '1.15.0');
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.ok(sent.some((m) => m.office === PUB.email));
      const s = await call(server, 'GET', '/api/licence/state', device(PUB.email), undefined, as('1.14.2'));
      assert.strictEqual(s.body.update, null);
    });

    await check('switched on, the venue is offered its version; the Store copy is not', async () => {
      const on = await call(server, 'PUT', '/api/admin/app-versions-settings', SERVICE_KEY, { enabled: true });
      assert.strictEqual(on.body.enabled, true);
      const s = await call(server, 'GET', '/api/licence/state', device(PUB.email), undefined, as('1.14.2'));
      assert.deepStrictEqual(s.body.update, {
        version: '1.15.0', url: 'https://admin.vesopa.com/dl/x/1.15.0.exe', sha256: SHA, size: 1000, downgrade: false,
      });
      const store = await call(server, 'GET', '/api/licence/state', device(PUB.email), undefined, as('1.14.2', 'store'));
      assert.strictEqual(store.body.update, null);
      const there = await call(server, 'GET', '/api/licence/state', device(PUB.email), undefined, as('1.15.0.0'));
      assert.strictEqual(there.body.update, null, 'already on it');
    });

    await check('an older version is offered as a downgrade', async () => {
      await pin([PUB.id], '1.13.0');
      const s = await call(server, 'GET', '/api/licence/state', device(PUB.email), undefined, as('1.14.2'));
      assert.strictEqual(s.body.update.version, '1.13.0');
      assert.strictEqual(s.body.update.downgrade, true);
    });

    await check('the default reaches venues without their own, and No auto updates holds a venue', async () => {
      const d = await pin('default', '1.14.3');
      assert.strictEqual(d.status, 200, JSON.stringify(d.body));
      const club = await call(server, 'GET', '/api/licence/state', device(CLUB.email), undefined, as('1.14.2'));
      assert.strictEqual(club.body.update.version, '1.14.3');
      await pin([CLUB.id], null);
      const held = await call(server, 'GET', '/api/licence/state', device(CLUB.email), undefined, as('1.14.2'));
      assert.strictEqual(held.body.update, null);
      await call(server, 'PUT', '/api/admin/app-versions/till', SERVICE_KEY, { offices: [CLUB.id], clear: true });
      const back = await call(server, 'GET', '/api/licence/state', device(CLUB.email), undefined, as('1.14.2'));
      assert.strictEqual(back.body.update.version, '1.14.3', 'follows the default again');
    });

    await check('a pin needs a real address and hash', async () => {
      const r = await call(server, 'PUT', '/api/admin/app-versions/till', SERVICE_KEY, { offices: [PUB.id], version: '1.2.3', url: 'http://x', sha256: 'nope' });
      assert.strictEqual(r.status, 400);
      const none = await call(server, 'PUT', '/api/admin/app-versions/till', SERVICE_KEY, { offices: [] });
      assert.strictEqual(none.status, 400);
      const app2 = await call(server, 'PUT', '/api/admin/app-versions/spaceship', SERVICE_KEY, { offices: 'default' });
      assert.strictEqual(app2.status, 400);
    });

    await check("Loyalty's open check follows the default only", async () => {
      await call(server, 'PUT', '/api/admin/app-versions/loyalty', SERVICE_KEY,
        { offices: 'default', version: '1.0.10', url: 'https://admin.vesopa.com/dl/l.exe', sha256: SHA });
      const r = await call(server, 'GET', '/loyalty/v1/app-update', null, undefined, as('1.0.9'));
      assert.strictEqual(r.body.update.version, '1.0.10');
      const store = await call(server, 'GET', '/loyalty/v1/app-update', null, undefined, as('1.0.9', 'store'));
      assert.strictEqual(store.body.update, null);
    });

    await check('only an admin may set versions', async () => {
      const r = await call(server, 'GET', '/api/admin/app-versions', device(PUB.email));
      assert.ok(r.status === 401 || r.status === 403, String(r.status));
    });
  } finally {
    server.close();
    await pool.query(`DROP DATABASE IF EXISTS ${DB}`).catch(() => {});
    await pool.end();
  }
  console.log(`\n${passed} checks passed`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
