/**
 * Training mode, till licences and more than one site -- against the real
 * server, on a database shaped like live.
 *
 *   EXPRESS_TEST_USER=vesopa_test EXPRESS_TEST_PASS=vesopa_test node test/five-features.test.js
 *
 * HOW
 *
 * The structure of `vesopa_live_shape` (a structure-only copy of live) is copied
 * into a scratch database, and then every migration is replayed over it twice,
 * in the order the deploy runs them -- which is itself the first test: the new
 * files have to apply cleanly on top of live's shape, and apply again. Then
 * src/server.js is started against it as a child process, exactly as pm2 runs
 * it, and everything below is plain HTTP.
 *
 * Skipped, not failed, where there is no database or no live-shaped template.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const DB = process.env.FIVE_TEST_DB || 'vesopa_five_selftest';
const TEMPLATE = process.env.FIVE_TEST_TEMPLATE || 'vesopa_live_shape';
const USER = process.env.EXPRESS_TEST_USER || 'root';
const PASS = process.env.EXPRESS_TEST_PASS || '';
const HOST = process.env.EXPRESS_TEST_HOST || '127.0.0.1';
const SECRET = 'five-features-test-secret';

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${e.message}`);
    process.exitCode = 1;
  }
}

const ARMS = { id: 901, email: 'arms@five.test', name: 'The Arms' };
const SECOND = { id: 902, email: 'second@five.test', name: 'The Second Arms' };
const OTHER = { id: 903, email: 'other@five.test', name: 'The Other Inn' };
const PASSWORD = 'correct horse 42';

/** Split a migration the way the mysql client would: it understands DELIMITER. */
function statementsOf(sql) {
  const out = [];
  let delimiter = ';';
  let buffer = '';
  for (const line of sql.split('\n')) {
    const d = /^DELIMITER\s+(\S+)/.exec(line.trim());
    if (d) { delimiter = d[1]; continue; }
    if (line.trim().startsWith('--') && !buffer.trim()) continue;
    buffer += line + '\n';
    if (buffer.trimEnd().endsWith(delimiter)) {
      const s = buffer.trimEnd().slice(0, -delimiter.length).trim();
      if (s) out.push(s);
      buffer = '';
    }
  }
  if (buffer.trim()) out.push(buffer.trim());
  return out;
}

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
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
  const [[tpl]] = await admin.query(
    'SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ?', [TEMPLATE]
  );
  if (!tpl.n) {
    console.log(`-- no ${TEMPLATE} template database, skipping`);
    await admin.end();
    return;
  }

  // ---- A database shaped like live, then every migration, twice ------------
  await admin.query(`DROP DATABASE IF EXISTS ${DB}; CREATE DATABASE ${DB} CHARACTER SET utf8mb4;`);
  const [tables] = await admin.query(
    "SELECT table_name AS t FROM information_schema.tables WHERE table_schema = ? AND table_type = 'BASE TABLE'",
    [TEMPLATE]
  );
  await admin.query(`USE ${DB}`);
  await admin.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const { t } of tables) {
    const [[row]] = await admin.query(`SHOW CREATE TABLE \`${TEMPLATE}\`.\`${t}\``);
    await admin.query(row['Create Table']);
  }
  await admin.query('SET FOREIGN_KEY_CHECKS = 1');

  const dir = path.join(__dirname, '..', 'schema');
  const files = ['schema.sql', ...fs.readdirSync(dir).filter((f) => /^schema_.*\.sql$/.test(f)).sort()];
  await check('every migration applies over live\'s shape, and again', async () => {
    for (let run = 0; run < 2; run++) {
      for (const file of files) {
        for (const sql of statementsOf(fs.readFileSync(path.join(dir, file), 'utf8'))) {
          try {
            await admin.query(sql);
          } catch (e) {
            throw new Error(`${file} (run ${run + 1}): ${e.message}\n        ${sql.slice(0, 120)}`);
          }
        }
      }
    }
  });
  await admin.end();

  const pool = mysql.createPool({ host: HOST, user: USER, password: PASS, database: DB, connectionLimit: 6 });

  // ---- Seed ----------------------------------------------------------------
  const hash = await bcrypt.hash(PASSWORD, 4);
  await pool.query(
    'INSERT INTO offices (id, name, contact_email, status) VALUES (?,?,?,?),(?,?,?,?),(?,?,?,?)',
    [ARMS.id, ARMS.name, ARMS.email, 'active', SECOND.id, SECOND.name, SECOND.email, 'active',
      OTHER.id, OTHER.name, OTHER.email, 'active']
  );
  const [owner] = await pool.query(
    "INSERT INTO backoffice_users (email, password, name, approved, office_id, role) VALUES (?, ?, 'Owner', 'Y', ?, 'office')",
    [ARMS.email, hash, ARMS.id]
  );
  await pool.query(
    "INSERT INTO backoffice_users (email, password, name, approved, office_id, role) VALUES (?, ?, 'Second manager', 'Y', ?, 'office'), (?, ?, 'Other', 'Y', ?, 'office')",
    [SECOND.email, hash, SECOND.id, OTHER.email, hash, OTHER.id]
  );
  const [[secondManager]] = await pool.query('SELECT id FROM backoffice_users WHERE email = ?', [SECOND.email]);
  const [[adminUser]] = await pool.query(
    "INSERT INTO backoffice_users (email, password, name, approved, office_id, role) VALUES ('admin@five.test', ?, 'Admin', 'Y', NULL, 'admin') RETURNING id",
    [hash]
  ).then(([r]) => [r]).catch(async () => {
    const [r] = await pool.query("SELECT id FROM backoffice_users WHERE email='admin@five.test'");
    return [r];
  });
  const [alice] = await pool.query("INSERT INTO bo_clarks (email, pluid, clark_name, pin_code, active) VALUES (?, 1, 'Alice', '1111', 1)", [ARMS.email]);
  const [trainee] = await pool.query("INSERT INTO bo_clarks (email, pluid, clark_name, pin_code, active, training) VALUES (?, 2, 'Training', '2222', 1, 1)", [ARMS.email]);
  await pool.query("INSERT INTO bo_clarks (email, pluid, clark_name, pin_code, active) VALUES (?, 1, 'Bob', '3333', 1)", [SECOND.email]);

  // A stand-in for the Flutter web build, with the placeholders the real one
  // carries, so the per-venue page can be checked without building Flutter.
  const os = require('os');
  const webDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loyalty-web-'));
  fs.writeFileSync(path.join(webDir, 'index.html'),
    '<!doctype html><html><head><base href="/app/__SLUG__/"><title>__APP_NAME__</title>'
    + '<meta name="theme-color" content="__THEME__"><link rel="apple-touch-icon" href="__ICON__"></head>'
    + '<body style="background:__BACKGROUND__"></body></html>');
  fs.writeFileSync(path.join(webDir, 'push-sw.js'), '// push worker');
  fs.writeFileSync(path.join(webDir, 'main.dart.js'), '// app');
  const vapidKeys = require('web-push').generateVAPIDKeys();

  // ---- The server itself ---------------------------------------------------
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'test',
      JWT_SECRET: SECRET,
      DB_HOST: HOST,
      DB_PORT: '3306',
      DB_USER: USER,
      DB_PASSWORD: PASS,
      DB_NAME: DB,
      SMTP_HOST: '',
      VESOPA_AUTH_ENABLED: '',
      VESOPA_AUTH_BACKOFFICE_ENABLED: '',
      VESOPA_AUTH_TILL_ENABLED: '',
      LOYALTY_WEB_DIR: webDir,
      VAPID_PUBLIC_KEY: vapidKeys.publicKey,
      VAPID_PRIVATE_KEY: vapidKeys.privateKey,
      EXPRESS_SECRET_KEY: 'five-test-sealing-key',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });

  const call = async (method, url, { token, body } = {}) => {
    const res = await fetch(base + url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, body: json };
  };

  try {
    let up = false;
    for (let i = 0; i < 100 && !up; i++) {
      await new Promise((r) => setTimeout(r, 150));
      try { up = (await fetch(`${base}/health`)).ok; } catch { /* not yet */ }
    }
    if (!up) throw new Error(`the server did not start:\n${log.slice(-2000)}`);

    const session = (office, userId = owner.insertId) =>
      jwt.sign({ sub: userId, email: office.email, name: 'Owner', role: 'office', officeId: office.id }, SECRET, { expiresIn: '1h' });
    const adminSession = jwt.sign({ sub: adminUser.id, email: 'admin@five.test', name: 'Admin', role: 'admin', officeId: null }, SECRET, { expiresIn: '1h' });

    // A till signed in with the password door, as the till does it.
    const signInTill = (extra = {}) => call('POST', '/api/login', {
      body: { email: ARMS.email, password: PASSWORD, terminal: true, ...extra },
    });

    // ======================================================================
    // Training mode
    // ======================================================================
    const first = await signInTill({ device_id: 'dev-bar', device_name: 'Bar' });
    const barToken = first.body && first.body.terminalToken;

    await check('a till is signed in, and its token names its licence seat', async () => {
      assert.strictEqual(first.status, 200, JSON.stringify(first.body));
      assert.ok(barToken);
      const claims = jwt.decode(barToken);
      assert.ok(claims.jti, 'the token carries a seat id');
      const [[seat]] = await pool.query('SELECT device_id, device_name, released_at FROM bo_till_seats WHERE id = ?', [claims.jti]);
      assert.strictEqual(seat.device_id, 'dev-bar');
      assert.strictEqual(seat.device_name, 'Bar');
      assert.strictEqual(seat.released_at, null);
    });

    await check('an older till is not given training accounts at all', async () => {
      const r = await call('GET', '/till/staff', { token: barToken });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      const names = r.body.map((s) => s.name);
      assert.deepStrictEqual(names, ['Alice']);
      assert.strictEqual(r.body[0].training, false);
    });

    await check('a till that understands training gets them, marked', async () => {
      const r = await call('GET', '/till/staff?features=training', { token: barToken });
      const t = r.body.find((s) => s.name === 'Training');
      assert.ok(t, 'the training account is listed');
      assert.strictEqual(t.training, true);
      assert.strictEqual(r.body.find((s) => s.name === 'Alice').training, false);
    });

    const order = (id, extra = {}) => ({
      id,
      email: ARMS.email,
      subtotal_minor: 250,
      tax_minor: 42,
      total_minor: 250,
      closed_at: new Date().toISOString(),
      staff_id: alice.insertId,
      clerk_name: 'Alice',
      lines: [{ plu_id: 1, name: 'Tea', quantity: 1, unit_price_minor: 250, tax_percentage: 20 }],
      payments: [{ method: 'cash', amount_minor: 250 }],
      ...extra,
    });

    await check('a sale marked training is taken and recorded nowhere', async () => {
      const id = '11111111-1111-4111-8111-111111111111';
      const r = await call('POST', '/till/orders', { body: order(id, { training: true }) });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.status, 'ignored');
      const [[n]] = await pool.query('SELECT COUNT(*) AS n FROM epos_orders WHERE id = ?', [id]);
      assert.strictEqual(n.n, 0);
    });

    await check('a sale rung up by a training account is ignored even unmarked', async () => {
      const id = '22222222-2222-4222-8222-222222222222';
      const r = await call('POST', '/till/orders', {
        body: order(id, { staff_id: trainee.insertId, clerk_name: 'Training' }),
      });
      assert.strictEqual(r.body.status, 'ignored');
      const [[n]] = await pool.query('SELECT COUNT(*) AS n FROM epos_orders WHERE id = ?', [id]);
      assert.strictEqual(n.n, 0);
    });

    await check('a real sale still lands in the ledger', async () => {
      const id = '33333333-3333-4333-8333-333333333333';
      const r = await call('POST', '/till/orders', { body: order(id) });
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      const [[n]] = await pool.query('SELECT COUNT(*) AS n FROM epos_orders WHERE id = ?', [id]);
      assert.strictEqual(n.n, 1);
    });

    await check("a trainee's void is not logged; a real one is", async () => {
      const r1 = await call('POST', '/till/voids', {
        body: { id: 'v-train', office: ARMS.email, clerk_pin: '2222', reason: 'Practice', amount_minor: 100 },
      });
      assert.strictEqual(r1.body.status, 'ignored');
      const r2 = await call('POST', '/till/voids', {
        body: { id: 'v-real', office: ARMS.email, clerk_pin: '1111', reason: 'Wrong item', amount_minor: 100 },
      });
      assert.strictEqual(r2.status, 201);
      const [rows] = await pool.query('SELECT id FROM epos_void_log WHERE email = ?', [ARMS.email]);
      assert.deepStrictEqual(rows.map((r) => r.id), ['v-real']);
    });

    await check('a training bill is not put on the shared table plan', async () => {
      const r = await call('POST', '/till/open-bills', {
        token: barToken,
        body: { id: '44444444-4444-4444-8444-444444444444', staff_id: trainee.insertId, payload: {}, training: true },
      });
      assert.strictEqual(r.body.status, 'ignored');
      const [[n]] = await pool.query('SELECT COUNT(*) AS n FROM epos_open_bills');
      assert.strictEqual(n.n, 0);
    });

    await check('training cannot spend a gift card', async () => {
      const r = await call('POST', `/api/gift-cards/redeem?office=${encodeURIComponent(ARMS.email)}`, {
        body: { code: 'GC1', amount_minor: 500, training: true },
      });
      assert.strictEqual(r.status, 409);
      assert.ok(/Training mode/.test(r.body.error));
    });

    await check('the back office creates, lists and changes a training account', async () => {
      const tok = session(ARMS);
      const made = await call('POST', '/api/staff', {
        token: tok, body: { clark_name: 'Trainee two', pin_code: '4444', pluid: 5, training: 1 },
      });
      assert.strictEqual(made.status, 201, JSON.stringify(made.body));
      let list = await call('GET', '/api/staff', { token: tok });
      const two = list.body.find((s) => s.clark_name === 'Trainee two');
      assert.strictEqual(two.training, true);
      assert.strictEqual(list.body.find((s) => s.clark_name === 'Alice').training, false);
      const put = await call('PUT', `/api/staff/${made.body.id}`, {
        token: tok, body: { clark_name: 'Trainee two', pluid: 5, training: 0 },
      });
      assert.strictEqual(put.status, 200);
      list = await call('GET', '/api/staff', { token: tok });
      assert.strictEqual(list.body.find((s) => s.clark_name === 'Trainee two').training, false);
      // An edit that says nothing about training leaves it alone.
      await pool.query('UPDATE bo_clarks SET training = 1 WHERE id = ?', [made.body.id]);
      await call('PUT', `/api/staff/${made.body.id}`, { token: tok, body: { clark_name: 'Renamed', pluid: 5 } });
      const [[row]] = await pool.query('SELECT training FROM bo_clarks WHERE id = ?', [made.body.id]);
      assert.strictEqual(row.training, 1);
    });

    // ======================================================================
    // Till licences
    // ======================================================================
    await check('signing in again on the same machine keeps its one seat', async () => {
      const again = await signInTill({ device_id: 'dev-bar', device_name: 'Bar' });
      assert.strictEqual(again.status, 200);
      assert.strictEqual(jwt.decode(again.body.terminalToken).jti, jwt.decode(barToken).jti);
      const [[n]] = await pool.query('SELECT COUNT(*) AS n FROM bo_till_seats WHERE office = ? AND released_at IS NULL', [ARMS.email]);
      assert.strictEqual(n.n, 1);
    });

    await check('with every licence in use, a new till is refused and told which tills hold them', async () => {
      await pool.query('UPDATE offices SET till_licences = 1 WHERE id = ?', [ARMS.id]);
      const r = await signInTill({ device_id: 'dev-door', device_name: 'Door' });
      assert.strictEqual(r.status, 409, JSON.stringify(r.body));
      assert.ok(/in use: Bar/.test(r.body.error), r.body.error);
      assert.strictEqual(r.body.licences, 1);
      assert.ok(!r.body.terminalToken);
    });

    await check('a till signed in before licences is counted the first time it calls in', async () => {
      await pool.query('UPDATE offices SET till_licences = NULL WHERE id = ?', [ARMS.id]);
      const legacy = jwt.sign({ scope: 'terminal', office: ARMS.email, officeId: ARMS.id, commissionedBy: ARMS.email }, SECRET, { expiresIn: '1h' });
      const r = await call('GET', '/till/staff', { token: legacy });
      assert.strictEqual(r.status, 200);
      const [[n]] = await pool.query('SELECT COUNT(*) AS n FROM bo_till_seats WHERE office = ? AND released_at IS NULL AND token_hash IS NOT NULL', [ARMS.email]);
      assert.strictEqual(n.n, 1);
      // ...and naming its machine lets go of the seat that machine held before.
      const dev = await call('POST', '/till/devices', {
        token: legacy, body: { devices: [{ device_id: 'dev-bar', kind: 'till', name: 'Bar' }] },
      });
      assert.strictEqual(dev.status, 200, JSON.stringify(dev.body));
      const [live] = await pool.query('SELECT id, token_hash FROM bo_till_seats WHERE office = ? AND released_at IS NULL', [ARMS.email]);
      assert.strictEqual(live.length, 1, 'one seat for one machine');
      assert.ok(live[0].token_hash, 'the one left is the machine\'s current token');
      const old = await call('GET', '/till/staff', { token: barToken });
      assert.strictEqual(old.status, 401, 'the superseded token is turned away');
      assert.strictEqual(old.body.signed_out, true);
    });

    await check('the back office lists the seats and signs a till out', async () => {
      const tok = session(ARMS);
      const fresh = await signInTill({ device_id: 'dev-door', device_name: 'Door' });
      assert.strictEqual(fresh.status, 200);
      const seats = await call('GET', '/api/devices/seats', { token: tok });
      assert.strictEqual(seats.status, 200, JSON.stringify(seats.body));
      assert.strictEqual(seats.body.limit, null);
      const door = seats.body.seats.find((s) => s.device_name === 'Door');
      assert.ok(door);
      const rel = await call('POST', `/api/devices/seats/${door.id}/release`, { token: tok });
      assert.strictEqual(rel.status, 200);
      const after = await call('GET', '/till/staff', { token: fresh.body.terminalToken });
      assert.strictEqual(after.status, 401);
      assert.strictEqual(after.body.signed_out, true);
      // Another venue cannot see or release this venue's seats.
      const theirs = await call('GET', '/api/devices/seats', { token: session(OTHER) });
      assert.strictEqual(theirs.body.seats.length, 0);
    });

    await check('a till signing itself out gives its seat back', async () => {
      const t = await signInTill({ device_id: 'dev-patio', device_name: 'Patio' });
      const r = await call('POST', '/till/seat/release', { token: t.body.terminalToken });
      assert.strictEqual(r.status, 200);
      const [[row]] = await pool.query('SELECT released_at, release_reason FROM bo_till_seats WHERE id = ?', [jwt.decode(t.body.terminalToken).jti]);
      assert.ok(row.released_at);
      assert.strictEqual(row.release_reason, 'signed out on the till');
    });

    await check('the admin sets licences and sees tills in use (collations as live has them)', async () => {
      const put = await call('PUT', `/api/admin/offices/${ARMS.id}/licences`, { token: adminSession, body: { till_licences: 3 } });
      assert.strictEqual(put.status, 200, JSON.stringify(put.body));
      const list = await call('GET', '/api/admin/offices', { token: adminSession });
      assert.strictEqual(list.status, 200, JSON.stringify(list.body));
      const arms = list.body.find((o) => o.id === ARMS.id);
      assert.strictEqual(arms.till_licences, 3);
      assert.ok(Number(arms.tills_in_use) >= 1);
      const bad = await call('PUT', `/api/admin/offices/${ARMS.id}/licences`, { token: adminSession, body: { till_licences: -1 } });
      assert.strictEqual(bad.status, 400);
      const none = await call('PUT', `/api/admin/offices/${ARMS.id}/licences`, { token: adminSession, body: { till_licences: null } });
      assert.strictEqual(none.body.till_licences, null);
      const refused = await call('PUT', `/api/admin/offices/${ARMS.id}/licences`, { token: session(ARMS), body: { till_licences: 99 } });
      assert.strictEqual(refused.status, 403);
    });

    // ======================================================================
    // More than one site
    // ======================================================================
    await check('a login with one site has no drop-down to offer', async () => {
      const r = await call('GET', '/api/sites', { token: session(ARMS) });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.sites.length, 1);
    });

    await check('the admin links a login to a second site', async () => {
      const add = await call('POST', `/api/admin/offices/${SECOND.id}/managers`, { token: adminSession, body: { email: ARMS.email } });
      assert.strictEqual(add.status, 201, JSON.stringify(add.body));
      const who = await call('GET', `/api/admin/offices/${SECOND.id}/managers`, { token: adminSession });
      assert.ok(who.body.some((p) => p.email === ARMS.email && !p.home));
      assert.ok(who.body.some((p) => p.email === SECOND.email && p.home));
      const dup = await call('POST', `/api/admin/offices/${ARMS.id}/managers`, { token: adminSession, body: { email: ARMS.email } });
      assert.strictEqual(dup.status, 409, 'its own office is not a link');
    });

    let secondSession;
    await check('the login switches into the second site, and sees only its data', async () => {
      const tok = session(ARMS);
      const sites = await call('GET', '/api/sites', { token: tok });
      assert.deepStrictEqual(sites.body.sites.map((s) => s.name).sort(), [ARMS.name, SECOND.name].sort());
      assert.strictEqual(sites.body.current, ARMS.id);
      const sw = await call('POST', '/api/sites/switch', { token: tok, body: { office_id: SECOND.id } });
      assert.strictEqual(sw.status, 200, JSON.stringify(sw.body));
      assert.strictEqual(sw.body.site.email, SECOND.email);
      secondSession = sw.body.token;
      assert.strictEqual(jwt.decode(secondSession).officeId, SECOND.id);
      assert.strictEqual(jwt.decode(secondSession).sub, owner.insertId);
      const staff = await call('GET', '/api/staff', { token: secondSession });
      assert.deepStrictEqual(staff.body.map((s) => s.clark_name), ['Bob']);
      const home = await call('GET', '/api/staff', { token: tok });
      assert.ok(home.body.every((s) => s.clark_name !== 'Bob'));
    });

    await check('a switched session does not outlive the one it came from', async () => {
      const short = jwt.sign({ sub: owner.insertId, email: ARMS.email, name: 'Owner', role: 'office', officeId: ARMS.id }, SECRET, { expiresIn: 600 });
      const sw = await call('POST', '/api/sites/switch', { token: short, body: { office_id: SECOND.id } });
      const c = jwt.decode(sw.body.token);
      assert.ok(c.exp - c.iat <= 600, `lifetime ${c.exp - c.iat}s`);
    });

    await check('a site the login was never given cannot be switched to', async () => {
      const r = await call('POST', '/api/sites/switch', { token: session(ARMS), body: { office_id: OTHER.id } });
      assert.strictEqual(r.status, 403);
      const r2 = await call('POST', '/api/sites/switch', { token: session(SECOND, secondManager.id), body: { office_id: ARMS.id } });
      assert.strictEqual(r2.status, 403);
    });

    await check('a till that can ask is asked which site it is for', async () => {
      const ask = await signInTill({ site_choice: true, device_id: 'dev-2', device_name: 'Second bar' });
      assert.strictEqual(ask.status, 200);
      assert.strictEqual(ask.body.choose_site, true);
      assert.ok(!ask.body.terminalToken);
      assert.deepStrictEqual(ask.body.sites.map((s) => s.id).sort(), [ARMS.id, SECOND.id].sort());
      const chosen = await signInTill({ site_choice: true, office_id: SECOND.id, device_id: 'dev-2', device_name: 'Second bar' });
      assert.strictEqual(chosen.status, 200, JSON.stringify(chosen.body));
      const claims = jwt.decode(chosen.body.terminalToken);
      assert.strictEqual(claims.office, SECOND.email);
      const staff = await call('GET', '/till/staff', { token: chosen.body.terminalToken });
      assert.deepStrictEqual(staff.body.map((s) => s.name), ['Bob']);
      const [[seat]] = await pool.query('SELECT office FROM bo_till_seats WHERE id = ?', [claims.jti]);
      assert.strictEqual(seat.office, SECOND.email);
      const wrong = await signInTill({ site_choice: true, office_id: OTHER.id });
      assert.strictEqual(wrong.status, 403);
    });

    await check('an older till is signed in to the login\'s own site, as always', async () => {
      const old = await signInTill({});
      assert.strictEqual(old.status, 200);
      assert.strictEqual(jwt.decode(old.body.terminalToken).office, ARMS.email);
    });

    // ======================================================================
    // The loyalty app
    // ======================================================================
    const crypto = require('crypto');
    const armsSession = session(ARMS);
    await pool.query('INSERT INTO epos_loyalty_settings (office, point_value_minor) VALUES (?, 2)', [ARMS.email]);

    await check('the back office sets the app up and switches it on', async () => {
      const off = await call('PUT', '/api/loyalty-app', { token: armsSession, body: { enabled: 1 } });
      assert.strictEqual(off.status, 400, 'no address, no switching on');
      const r = await call('PUT', '/api/loyalty-app', {
        token: armsSession,
        body: {
          enabled: 1, slug: 'the-arms', app_name: 'Arms Rewards', colour_primary: '#123abc',
          latitude: 51.7, longitude: -3.85, radius_m: 500, links: { website: 'https://arms.example' },
          wns_package_sid: 'ms-app://s-1-15-2-1', wns_secret: 'not-a-real-secret',
        },
      });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.strictEqual(r.body.settings.wns_configured, true);
      assert.ok(!('wns_secret_enc' in r.body.settings), 'the sealed secret never comes back');
      const [[row]] = await pool.query('SELECT wns_secret_enc FROM epos_loyalty_app WHERE office = ?', [ARMS.email]);
      assert.ok(String(row.wns_secret_enc).startsWith('v1:'), 'sealed at rest');
      const taken = await call('PUT', '/api/loyalty-app', { token: session(OTHER), body: { slug: 'the-arms' } });
      assert.strictEqual(taken.status, 409);
      const page = await call('GET', '/api/loyalty-app', { token: armsSession });
      assert.strictEqual(page.body.brand.name, 'Arms Rewards');
      assert.ok(page.body.url.endsWith('/app/the-arms/'));
      assert.strictEqual(page.body.web_push_ready, true);
    });

    await check("the app draws the venue's own brand, and offers web push", async () => {
      const r = await call('GET', '/loyalty/v1/app/the-arms');
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.name, 'Arms Rewards');
      assert.strictEqual(r.body.colours.primary, '#123ABC');
      assert.strictEqual(r.body.push.web.vapid_public_key, vapidKeys.publicKey);
      assert.strictEqual(r.body.push.windows, true);
      assert.strictEqual(r.body.links.website, 'https://arms.example');
      assert.strictEqual((await call('GET', '/loyalty/v1/app/nobody-here')).status, 404);
    });

    await check('the web app page is the shared build, dressed as the venue', async () => {
      const fetch = async (url) => {
        try {
          return await globalThis.fetch(url);
        } catch (e) {
          throw new Error(`${url}: ${e.message} ${e.cause ? e.cause.code || e.cause.message : ''}`);
        }
      };
      const res = await fetch(`${base}/app/the-arms/`);
      assert.strictEqual(res.status, 200);
      const html = await res.text();
      assert.ok(html.includes('<base href="/app/the-arms/">'), html);
      assert.ok(html.includes('<title>Arms Rewards</title>'));
      assert.ok(html.includes('#123ABC'));
      const deep = await fetch(`${base}/app/the-arms/card`);
      assert.strictEqual(deep.status, 200, 'a deep link is the app page');
      const sw = await fetch(`${base}/app/the-arms/push-sw.js`);
      assert.strictEqual(sw.status, 200);
      assert.strictEqual(sw.headers.get('service-worker-allowed'), '/app/the-arms/');
      const manifest = await (await fetch(`${base}/app/the-arms/manifest.webmanifest`)).json();
      assert.strictEqual(manifest.name, 'Arms Rewards');
      assert.strictEqual(manifest.scope, '/app/the-arms/');
      const escape = await fetch(`${base}/app/the-arms/..%2F..%2Fsrc%2Fserver.js`);
      assert.notStrictEqual(escape.status, 200, 'no way out of the build folder');
    });

    const EMAIL = 'sam@member.test';
    const giveCode = async (email, code) => {
      const hash = crypto.createHmac('sha256', SECRET).update(`${ARMS.email}|${email}|${code}`).digest('hex');
      await pool.query(
        'INSERT INTO epos_loyalty_app_codes (id, office, email, code_hash, expires_at) VALUES (?, ?, ?, ?, NOW() + INTERVAL 10 MINUTE)',
        [crypto.randomUUID(), ARMS.email, email, hash]
      );
    };

    let member;
    await check('a new address joins with a code and a name, and gets a card number', async () => {
      const asked = await call('POST', '/loyalty/v1/app/the-arms/code', { body: { email: EMAIL } });
      assert.strictEqual(asked.status, 200);
      await giveCode(EMAIL, '424242');
      const wrong = await call('POST', '/loyalty/v1/app/the-arms/verify', { body: { email: EMAIL, code: '000000' } });
      assert.strictEqual(wrong.status, 400);
      const noName = await call('POST', '/loyalty/v1/app/the-arms/verify', { body: { email: EMAIL, code: '424242' } });
      assert.strictEqual(noName.status, 409);
      assert.strictEqual(noName.body.needs_name, true);
      const joined = await call('POST', '/loyalty/v1/app/the-arms/verify', { body: { email: EMAIL, code: '424242', name: 'Sam' } });
      assert.strictEqual(joined.status, 200, JSON.stringify(joined.body));
      member = joined.body.token;
      const again = await call('POST', '/loyalty/v1/app/the-arms/verify', { body: { email: EMAIL, code: '424242' } });
      assert.strictEqual(again.status, 400, 'a code works once');
      const me = await call('GET', '/loyalty/v1/me', { token: member });
      assert.strictEqual(me.status, 200, JSON.stringify(me.body));
      assert.strictEqual(me.body.name, 'Sam');
      assert.ok(/^9998\d{5}$/.test(me.body.card_number), me.body.card_number);
      assert.strictEqual(me.body.qr, me.body.card_number, 'the QR is the card number the till knows');
    });

    await check("points and history come from the venue's own records", async () => {
      const [[c]] = await pool.query('SELECT id FROM epos_customers WHERE email = ?', [EMAIL]);
      await pool.query('UPDATE epos_customers SET points_balance = 120 WHERE id = ?', [c.id]);
      await pool.query(
        "INSERT INTO epos_loyalty_txns (id, office, customer_id, kind, points, balance_after, spend_minor) VALUES (?, ?, ?, 'earn', 120, 120, 12000)",
        [crypto.randomUUID(), ARMS.email, c.id]
      );
      const me = await call('GET', '/loyalty/v1/me', { token: member });
      assert.strictEqual(me.body.points, 120);
      assert.strictEqual(me.body.points_value_minor, 240, "at the venue's own point value");
      const h = await call('GET', '/loyalty/v1/me/history', { token: member });
      assert.strictEqual(h.body.items.length, 1);
      assert.strictEqual(h.body.items[0].points, 120);
    });

    await check('an existing member signs in without joining again', async () => {
      await pool.query(
        "INSERT INTO epos_customers (id, email_key, name, email, card_number) VALUES (?, ?, 'Pat', 'pat@member.test', '999800777')",
        [crypto.randomUUID(), ARMS.email]
      );
      await giveCode('pat@member.test', '111222');
      const r = await call('POST', '/loyalty/v1/app/the-arms/verify', { body: { email: 'pat@member.test', code: '111222' } });
      assert.strictEqual(r.status, 200);
      const me = await call('GET', '/loyalty/v1/me', { token: r.body.token });
      assert.strictEqual(me.body.card_number, '999800777');
      const [[n]] = await pool.query("SELECT COUNT(*) AS n FROM epos_customers WHERE email = 'pat@member.test'");
      assert.strictEqual(n.n, 1);
    });

    await check('only real push services are accepted as a subscription', async () => {
      const evil = await call('POST', '/loyalty/v1/me/push', {
        token: member, body: { subscription: { endpoint: 'https://10.0.0.1/steal', keys: { p256dh: 'x', auth: 'y' } } },
      });
      assert.strictEqual(evil.status, 400);
      const wnsEvil = await call('POST', '/loyalty/v1/me/push', { token: member, body: { kind: 'wns', channel_uri: 'https://evil.example/x' } });
      assert.strictEqual(wnsEvil.status, 400);
      const ok = await call('POST', '/loyalty/v1/me/push', {
        token: member,
        body: {
          subscription: {
            endpoint: 'https://fcm.googleapis.com/fcm/send/test-endpoint',
            keys: {
              p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM',
              auth: 'tBHItJI5svbpez7KI4CCXg',
            },
          },
        },
      });
      assert.strictEqual(ok.status, 201, JSON.stringify(ok.body));
    });

    await check('a member near the venue is in the "near" audience; one far away is not', async () => {
      const near = await call('POST', '/loyalty/v1/me/location', { token: member, body: { latitude: 51.7005, longitude: -3.8505, accuracy: 20 } });
      assert.strictEqual(near.body.near, true);
      let a = await call('POST', '/api/loyalty-app/audience', { token: armsSession, body: { audience: { kind: 'near' } } });
      assert.strictEqual(a.body.members, 1, JSON.stringify(a.body));
      assert.strictEqual(a.body.web, 1);
      await call('POST', '/loyalty/v1/me/location', { token: member, body: { latitude: 52.5, longitude: -1.9 } });
      a = await call('POST', '/api/loyalty-app/audience', { token: armsSession, body: { audience: { kind: 'near' } } });
      assert.strictEqual(a.body.members, 0);
      const all = await call('POST', '/api/loyalty-app/audience', { token: armsSession, body: { audience: { kind: 'all' } } });
      assert.strictEqual(all.body.members, 2);
      await call('POST', '/loyalty/v1/me/location', { token: member, body: { latitude: 51.7005, longitude: -3.8505 } });
    });

    await check('a notification goes to the inbox of everyone it is for, and is counted', async () => {
      const sent = await call('POST', '/api/loyalty-app/messages', {
        token: armsSession, body: { title: 'Match day', body: 'Two for one on pints before kick-off.', audience: { kind: 'near' } },
      });
      assert.strictEqual(sent.status, 201, JSON.stringify(sent.body));
      let row;
      for (let i = 0; i < 60; i++) {
        [[row]] = await pool.query('SELECT status, recipients, reached_web, failed FROM epos_push_messages WHERE id = ?', [sent.body.id]);
        if (row.status === 'sent') break;
        await new Promise((r) => setTimeout(r, 250));
      }
      assert.strictEqual(row.status, 'sent');
      assert.strictEqual(row.recipients, 1);
      // The test endpoint is not a real subscription, so the push itself fails
      // -- what matters is that it was attempted, counted, and the inbox has it.
      assert.strictEqual(row.reached_web + row.failed, 1);
      const inbox = await call('GET', '/loyalty/v1/me/messages', { token: member });
      assert.strictEqual(inbox.body.items.length, 1);
      assert.strictEqual(inbox.body.items[0].title, 'Match day');
      assert.strictEqual(inbox.body.unread, 1);
      await call('POST', `/loyalty/v1/me/messages/${sent.body.id}/read`, { token: member });
      assert.strictEqual((await call('GET', '/loyalty/v1/me/messages', { token: member })).body.unread, 0);
      const list = await call('GET', '/api/loyalty-app/messages', { token: armsSession });
      assert.strictEqual(list.body[0].title, 'Match day');
      const theirs = await call('GET', '/api/loyalty-app/messages', { token: session(OTHER) });
      assert.strictEqual(theirs.body.length, 0, 'another venue sees none of it');
    });

    await check('a scheduled notification waits, and can be cancelled', async () => {
      const later = new Date(Date.now() + 3600_000).toISOString();
      const s = await call('POST', '/api/loyalty-app/messages', { token: armsSession, body: { title: 'Quiz night', body: 'Thursday, 8pm.', send_at: later } });
      const [[row]] = await pool.query('SELECT status FROM epos_push_messages WHERE id = ?', [s.body.id]);
      assert.strictEqual(row.status, 'scheduled');
      const c = await call('POST', `/api/loyalty-app/messages/${s.body.id}/cancel`, { token: armsSession });
      assert.strictEqual(c.status, 200);
      const again = await call('POST', `/api/loyalty-app/messages/${s.body.id}/cancel`, { token: armsSession });
      assert.strictEqual(again.status, 409);
    });

    await check('signing out ends the session at once, and forgets the device', async () => {
      const out = await call('POST', '/loyalty/v1/me/signout', { token: member });
      assert.strictEqual(out.status, 200);
      const me = await call('GET', '/loyalty/v1/me', { token: member });
      assert.strictEqual(me.status, 401);
      const [[ch]] = await pool.query("SELECT disabled_at FROM epos_push_channels WHERE endpoint LIKE '%test-endpoint'");
      assert.ok(ch.disabled_at, 'the notification channel went with the session');
    });

    await check('a customer token opens nothing in the back office, and a till token nothing here', async () => {
      await giveCode(EMAIL, '989898');
      const r = await call('POST', '/loyalty/v1/app/the-arms/verify', { body: { email: EMAIL, code: '989898' } });
      const bo = await call('GET', '/api/staff', { token: r.body.token });
      assert.strictEqual(bo.status, 401);
      const till = jwt.sign({ scope: 'terminal', office: ARMS.email }, SECRET);
      assert.strictEqual((await call('GET', '/loyalty/v1/me', { token: till })).status, 401);
    });

    await check('unlinking takes the site away at the next switch', async () => {
      const del = await call('DELETE', `/api/admin/offices/${SECOND.id}/managers/${owner.insertId}`, { token: adminSession });
      assert.strictEqual(del.status, 200);
      const r = await call('POST', '/api/sites/switch', { token: session(ARMS), body: { office_id: SECOND.id } });
      assert.strictEqual(r.status, 403);
    });
  } finally {
    child.kill();
    try { fs.rmSync(webDir, { recursive: true, force: true }); } catch { /* temp */ }
    await pool.end();
    if (!process.env.FIVE_TEST_KEEP) {
      const drop = await mysql.createConnection({ host: HOST, user: USER, password: PASS });
      await drop.query(`DROP DATABASE IF EXISTS ${DB}`);
      await drop.end();
    }
    if (failed) console.error('\n--- server log (tail) ---\n' + log.slice(-3000));
  }

  console.log(`\n  ${passed} passed, ${failed} failed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
