/*
 * End-to-end tests against a real MariaDB (metric_test), a fake Vesopa Auth
 * key, and a fake Hikvision camera with digest authentication.
 *
 *   npm test          (needs MariaDB on 127.0.0.1, root with no password,
 *                      or DB_USER / DB_PASSWORD set)
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

process.env.DB_NAME = 'metric_test';
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-123';
process.env.VESOPA_METRIC_CLIENT_ID = 'metric-test-client';
process.env.VESOPA_AUTH_ISSUER = 'https://auth.example.test';
process.env.BASE_URL = 'https://metric.example.test';
process.env.METRIC_ADMIN_EMAILS = 'staff@metricgroup.co.uk';
process.env.METRIC_SCHEDULER = 'off';
process.env.LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'metric-logs-'));

const mysql = require('mysql2/promise');
const jwt = require('jsonwebtoken');

let server;
let base;
let db;
let activity;
let session;
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

function idToken(sub, email, name = 'Test Driver') {
  return jwt.sign({ sub, email, name }, privateKey, {
    algorithm: 'RS256', keyid: 'k1', issuer: 'https://auth.example.test', audience: 'metric-test-client', expiresIn: '5m',
  });
}

async function call(method, url, { body, token, headers = {}, raw } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload;
  if (raw !== undefined) payload = raw;
  else if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(`${base}${url}`, { method, headers: h, body: payload, redirect: 'manual' });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* text */ }
  return { status: res.status, json, text, headers: res.headers };
}

before(async () => {
  const root = await mysql.createConnection({ host: '127.0.0.1', user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '', multipleStatements: true });
  await root.query('DROP DATABASE IF EXISTS metric_test; CREATE DATABASE metric_test CHARACTER SET utf8mb4');
  await root.query('USE metric_test');
  const sql = fs.readFileSync(path.join(__dirname, '..', 'schema', 'schema.sql'), 'utf8');
  await root.query(sql);
  await root.query(sql); // re-runnable: the deploy applies it twice
  await root.end();

  db = require('../src/db');
  activity = require('../src/activity');
  session = require('../src/session');
  activity.useDb(db);
  require('../src/vesopa')._setKeys([{ ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }]);
  const { createApp } = require('../src/server');
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await db.pool.end();
});

let member;
let memberToken;
let gateKey;
let gateId;

test('the schema applied twice leaves one default plan', async () => {
  const plans = await db.all('SELECT * FROM plans');
  assert.equal(plans.length, 1);
  assert.equal(plans[0].is_default, 1);
});

test('Continue with Vesopa (native id token) makes a pending member', async () => {
  const r = await call('POST', '/api/v1/auth/vesopa', { body: { idToken: idToken('sub-1', 'driver@example.com') } });
  assert.equal(r.status, 200, r.text);
  assert.ok(r.json.token);
  assert.equal(r.json.member.status, 'pending');
  assert.match(r.json.member.memberNo, /^MG1\d{5}$/);
  member = r.json.member;
  memberToken = r.json.token;

  const bad = await call('POST', '/api/v1/auth/vesopa', { body: { idToken: idToken('x', 'x@x').replace(/.$/, 'A') } });
  assert.equal(bad.status, 401);
  const wrongRedirect = await call('POST', '/api/v1/auth/vesopa', { body: { code: 'c', verifier: 'v', redirectUri: 'https://evil.example/cb' } });
  assert.equal(wrongRedirect.status, 400);
});

test('members add, list and refuse cars by the rules', async () => {
  const add = await call('POST', '/api/v1/vehicles', { token: memberToken, body: { plate: 'ab12 cde', make: 'Ford', colour: 'Blue' } });
  assert.equal(add.status, 201, add.text);
  assert.equal(add.json.vehicle.plate, 'AB12CDE');
  assert.equal(add.json.vehicle.display, 'AB12 CDE');

  const dup = await call('POST', '/api/v1/vehicles', { token: memberToken, body: { plate: 'AB12CDE' } });
  assert.equal(dup.status, 409);
  assert.equal(dup.json.code, 'duplicate');

  const junk = await call('POST', '/api/v1/vehicles', { token: memberToken, body: { plate: '!' } });
  assert.equal(junk.status, 400);

  // Another member cannot take a plate already on a live membership.
  const other = await call('POST', '/api/v1/auth/vesopa', { body: { idToken: idToken('sub-2', 'other@example.com') } });
  const taken = await call('POST', '/api/v1/vehicles', { token: other.json.token, body: { plate: 'AB12 CDE' } });
  assert.equal(taken.status, 409);
  assert.equal(taken.json.code, 'taken');

  await call('POST', '/api/v1/vehicles', { token: memberToken, body: { plate: 'XY70 ABC' } });
  await call('POST', '/api/v1/vehicles', { token: memberToken, body: { plate: 'K1 ABC' } });
  const limit = await call('POST', '/api/v1/vehicles', { token: memberToken, body: { plate: 'LM65 OPQ' } });
  assert.equal(limit.status, 409);
  assert.equal(limit.json.code, 'limit');

  const me = await call('GET', '/api/v1/me', { token: memberToken });
  assert.equal(me.json.vehicles.length, 3);
  assert.equal(me.json.member.standing, 'pending');

  const noToken = await call('GET', '/api/v1/me');
  assert.equal(noToken.status, 401);
});

test('a site and gate are made in the console, with a one-time key', async () => {
  const unauth = await call('GET', '/api/admin/members');
  assert.equal(unauth.status, 401);
  const notStaff = session.issueAdmin({ sub: 'z', email: 'someone@else.com' });
  assert.equal((await call('GET', '/api/admin/me', { headers: { Cookie: `mg_admin=${notStaff}` } })).status, 401);

  const cookie = `mg_admin=${session.issueAdmin({ sub: 'staff-1', email: 'staff@metricgroup.co.uk', name: 'Staff' })}`;
  const site = await call('POST', '/api/admin/sites', { headers: { Cookie: cookie }, body: { name: 'Swindon HQ', address: 'Swindon' } });
  assert.equal(site.status, 201);
  const gate = await call('POST', `/api/admin/sites/${site.json.id}/gates`, { headers: { Cookie: cookie }, body: { name: 'Main entrance', direction: 'entry' } });
  assert.equal(gate.status, 201, gate.text);
  assert.match(gate.json.key, /^mg_/);
  assert.ok(gate.json.urls.event.endsWith('/event'));
  gateKey = gate.json.key;
  gateId = gate.json.id;
  const stored = await db.one('SELECT key_hash FROM gates WHERE id = ?', [gateId]);
  assert.notEqual(stored.key_hash, gateKey, 'only the hash is stored');

  const ping = await call('GET', `/anpr/v1/gates/${gateKey}/ping`);
  assert.equal(ping.status, 200);
  assert.equal((await call('GET', '/anpr/v1/gates/mg_wrongwrongwrongwrongwrong/ping')).status, 404);
});

test('the barrier stays shut until Metric approves the member, then opens', async () => {
  require('../src/access')._resetBursts();
  let r = await call('POST', `/anpr/v1/gates/${gateKey}/event`, { body: { plate: 'AB12CDE', confidence: 97 } });
  assert.equal(r.json.open, false);
  assert.equal(r.json.reason, 'pending');

  const cookie = `mg_admin=${session.issueAdmin({ sub: 'staff-1', email: 'staff@metricgroup.co.uk' })}`;
  const approve = await call('PATCH', `/api/admin/members/${member.id}`, { headers: { Cookie: cookie }, body: { status: 'active' } });
  assert.equal(approve.status, 200);

  require('../src/access')._resetBursts();
  r = await call('POST', `/anpr/v1/gates/${gateKey}/event`, { body: { plate: 'AB12CDE', direction: 'in' } });
  assert.equal(r.json.open, true);
  assert.equal(r.json.reason, 'member');
  assert.equal(r.json.direction, 'entry');

  // A burst of reads of the same car is answered once.
  const again = await call('POST', `/anpr/v1/gates/${gateKey}/event`, { body: { plate: 'AB12CDE' } });
  assert.equal(again.json.open, true);
  const count = await db.one("SELECT COUNT(*) AS n FROM access_events WHERE plate = 'AB12CDE'");
  assert.equal(Number(count.n), 2);

  // A close read (0 for D) still opens on a lane that allows it.
  const fuzzy = await call('POST', `/anpr/v1/gates/${gateKey}/event`, { body: { plate: 'AB12C0E' } });
  assert.equal(fuzzy.json.open, true);
  assert.equal(fuzzy.json.reason, 'member_fuzzy');

  const stranger = await call('POST', `/anpr/v1/gates/${gateKey}/event?format=text`, { body: { plate: 'ZZ99ZZZ' } });
  assert.equal(stranger.text, 'DENY');

  // Expired memberships stop opening.
  await db.run('UPDATE members SET valid_to = ? WHERE id = ?', ['2020-01-01', member.id]);
  require('../src/access')._resetBursts();
  const expired = await call('POST', `/anpr/v1/gates/${gateKey}/event`, { body: { plate: 'AB12CDE' } });
  assert.equal(expired.json.reason, 'expired');
  await db.run('UPDATE members SET valid_to = NULL WHERE id = ?', [member.id]);

  const visits = await call('GET', '/api/v1/visits', { token: memberToken });
  assert.ok(visits.json.visits.length >= 3);
});

test('events are read from Hikvision XML, multipart and Dahua JSON', async () => {
  const { parseEvent } = require('../src/anpr');
  const xml = '<?xml version="1.0"?><EventNotificationAlert><eventType>ANPR</eventType><ANPR><licensePlate>XY70ABC</licensePlate><confidenceLevel>92</confidenceLevel><direction>forward</direction></ANPR></EventNotificationAlert>';
  assert.equal(parseEvent({ raw: Buffer.from(xml), contentType: 'application/xml' }).plate, 'XY70ABC');

  const boundary = 'MIME_boundary';
  const multi = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/xml\r\n\r\n${xml}\r\n--${boundary}\r\nContent-Type: image/jpeg\r\n\r\n`),
    crypto.randomBytes(2000),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const p = parseEvent({ raw: multi, contentType: `multipart/form-data; boundary=${boundary}` });
  assert.equal(p.plate, 'XY70ABC');
  assert.equal(p.confidence, '92');

  const dahua = { Picture: { Plate: { PlateNumber: 'K1ABC' }, SnapInfo: { Direction: 'Approach' } } };
  const d = parseEvent({ json: dahua });
  assert.equal(d.plate, 'K1ABC');

  require('../src/access')._resetBursts();
  const r = await call('POST', `/anpr/v1/gates/${gateKey}/event`, { raw: multi, headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` } });
  assert.equal(r.json.open, true, r.text);
  assert.equal(r.json.plate, 'XY70ABC');

  const unknown = await call('POST', `/anpr/v1/gates/${gateKey}/event`, { body: { plate: 'unknown' } });
  assert.equal(unknown.json.reason, 'no_plate');
});

test('the allow-list is pulled as JSON or CSV and follows the members', async () => {
  let r = await call('GET', `/anpr/v1/gates/${gateKey}/allowlist`);
  assert.deepEqual(r.json.plates, ['AB12CDE', 'K1ABC', 'XY70ABC']);
  r = await call('GET', `/anpr/v1/gates/${gateKey}/allowlist?format=csv`);
  assert.equal(r.text, 'plate\nAB12CDE\nK1ABC\nXY70ABC\n');

  const me = await call('GET', '/api/v1/me', { token: memberToken });
  const k1 = me.json.vehicles.find((v) => v.plate === 'K1ABC');
  const del = await call('DELETE', `/api/v1/vehicles/${k1.id}`, { token: memberToken });
  assert.equal(del.status, 200);
  r = await call('GET', `/anpr/v1/gates/${gateKey}/allowlist`);
  assert.deepEqual(r.json.plates, ['AB12CDE', 'XY70ABC']);
});

test('a Hikvision camera gets plates pushed and removed with digest auth', async () => {
  const seen = [];
  const cam = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const auth = req.headers.authorization || '';
      if (!auth.startsWith('Digest ')) {
        res.writeHead(401, { 'WWW-Authenticate': 'Digest realm="IP Camera", qop="auth", nonce="abc123", opaque="xyz"' });
        return res.end();
      }
      // Check the digest the way a camera does.
      const { parseChallenge } = require('../src/adapters/http');
      const a = parseChallenge(auth.slice(7));
      const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
      const ha1 = md5(`admin:IP Camera:camPass1`);
      const ha2 = md5(`${req.method}:${a.uri}`);
      const expect = md5(`${ha1}:${a.nonce}:${a.nc}:${a.cnonce}:${a.qop}:${ha2}`);
      if (a.response !== expect) { res.writeHead(401); return res.end(); }
      seen.push({ method: req.method, url: req.url, body });
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      res.end('<ResponseStatus><statusCode>1</statusCode></ResponseStatus>');
    });
  });
  await new Promise((r) => cam.listen(0, r));
  const camUrl = `http://127.0.0.1:${cam.address().port}`;

  const cookie = `mg_admin=${session.issueAdmin({ sub: 'staff-1', email: 'staff@metricgroup.co.uk' })}`;
  const site = await db.one('SELECT id FROM sites LIMIT 1');
  const g = await call('POST', `/api/admin/sites/${site.id}/gates`, {
    headers: { Cookie: cookie },
    body: { name: 'Exit lane', direction: 'exit', adapter: 'hikvision', mode: 'allowlist', deviceUrl: camUrl, deviceUser: 'admin', devicePass: 'camPass1' },
  });
  assert.equal(g.status, 201);

  const listed = await call('GET', '/api/admin/sites', { headers: { Cookie: cookie } });
  const shown = listed.json.sites[0].gates.find((x) => x.id === g.json.id);
  assert.equal(shown.hasPassword, true);
  assert.equal(JSON.stringify(listed.json).includes('camPass1'), false, 'the camera password never reaches the console');

  let out = await call('POST', `/api/admin/gates/${g.json.id}/sync`, { headers: { Cookie: cookie } });
  assert.equal(out.json.added, 2, out.text);
  assert.match(seen[0].url, /licensePlateAuditData/);
  assert.match(seen[0].body, /<LicensePlate>AB12CDE<\/LicensePlate>/);
  assert.match(seen[0].body, /whiteList/);

  // Suspend the member: both plates come off the camera.
  await call('PATCH', `/api/admin/members/${member.id}`, { headers: { Cookie: cookie }, body: { status: 'suspended' } });
  out = await call('POST', `/api/admin/gates/${g.json.id}/sync`, { headers: { Cookie: cookie } });
  assert.equal(out.json.removed, 2, out.text);
  assert.match(seen[seen.length - 1].url, /DelLicensePlateAuditData/);

  // A camera that is down is recorded, not thrown.
  await db.run('UPDATE gates SET device_url = ? WHERE id = ?', ['http://127.0.0.1:1', g.json.id]);
  await call('PATCH', `/api/admin/members/${member.id}`, { headers: { Cookie: cookie }, body: { status: 'active' } });
  out = await call('POST', `/api/admin/gates/${g.json.id}/sync`, { headers: { Cookie: cookie } });
  assert.ok(out.json.error);
  const row = await db.one('SELECT last_sync_error FROM gates WHERE id = ?', [g.json.id]);
  assert.ok(row.last_sync_error.length > 0);
  cam.close();
});

test('every press and change is in the activity log, on disk and in the table, without secrets', async () => {
  const r = await call('POST', '/api/v1/log', { token: memberToken, headers: { 'X-Metric-App': 'metric-android 1.0.0' }, body: { events: [{ type: 'tap', name: 'add_car', screen: 'cars' }, { type: 'screen', name: 'visits' }] } });
  assert.equal(r.json.logged, 2);
  await new Promise((res) => setTimeout(res, 300));
  const rows = await db.all("SELECT * FROM activity_log WHERE actor_type = 'member' AND actor_id = ? ORDER BY id", [String(member.id)]);
  const actions = rows.map((x) => x.action);
  for (const a of ['member.joined', 'vehicle.add', 'vehicle.remove', 'ui.tap', 'ui.screen']) assert.ok(actions.includes(a), `${a} logged`);
  assert.equal(rows.find((x) => x.action === 'ui.tap').app, 'metric-android 1.0.0');

  const file = fs.readFileSync(activity.fileFor(new Date()), 'utf8');
  assert.match(file, /"action":"vehicle.add"/);
  assert.match(file, /"action":"admin.gate_add"/);
  assert.equal(file.includes('camPass1'), false);

  const cookie = `mg_admin=${session.issueAdmin({ sub: 'staff-1', email: 'staff@metricgroup.co.uk' })}`;
  const view = await call('GET', '/api/admin/activity?actor=member', { headers: { Cookie: cookie } });
  assert.ok(view.json.activity.length > 3);
});

test('deleting the account takes every car off every barrier', async () => {
  const r = await call('DELETE', '/api/v1/me', { token: memberToken });
  assert.equal(r.status, 200);
  const cars = await db.one('SELECT COUNT(*) AS n FROM vehicles WHERE member_id = ? AND removed_at IS NULL', [member.id]);
  assert.equal(Number(cars.n), 0);
  const list = await call('GET', `/anpr/v1/gates/${gateKey}/allowlist`);
  assert.deepEqual(list.json.plates, []);
  assert.equal((await call('GET', '/api/v1/me', { token: memberToken })).status, 401);
});

test('the web callback hands the code back to the app; the console is served', async () => {
  const cb = await call('GET', '/auth/callback?code=abc&state=xyz.123');
  assert.equal(cb.status, 302);
  assert.equal(cb.headers.get('location'), '/?vesopa_code=abc&vesopa_state=xyz.123');
  const page = await call('GET', '/admin/');
  assert.equal(page.status, 200);
  assert.match(page.text, /Membership console/);
  const health = await call('GET', '/health');
  assert.equal(health.json.ok, true);
});
