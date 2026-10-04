/*
 * Members and plans in Vesopa EPOS: the same server, with EPOS_BASE_URL and
 * EPOS_PARTNER_KEY pointing at a fake EPOS partner API (a local http server
 * that behaves like vesopa_server/src/memberships.js "Partner (Metric)").
 *
 * Its own database (metric_epos_test), so it never meets metric.test.js.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const KEY = 'vpk_test_partner_key';

// ---- the fake EPOS ---------------------------------------------------------
const epos = {
  plans: [
    { id: 7, name: 'Gold', description: 'Two cars, every site', active: true, max_vehicles: 2 },
    { id: 8, name: 'Fleet', description: 'Five cars', active: true, max_vehicles: 5 },
  ],
  members: new Map(),
  calls: [],
  nextId: 600,
  failCreate: false,
};
const planOf = (id) => epos.plans.find((p) => p.id === Number(id)) || null;
function eposMember(m) {
  return {
    id: m.id, vesopa_sub: m.vesopa_sub || null, name: m.name, email: m.email, phone: m.phone || '',
    member_number: null, state: m.state, status: m.state,
    plan: m.plan ? { id: m.plan.id, name: m.plan.name, max_vehicles: m.plan.max_vehicles } : null,
    valid_from: m.valid_from || '2026-01-01', valid_to: m.valid_to || '2099-12-31',
    access: m.state === 'active', family_head_id: null,
  };
}
epos.members.set(501, { id: 501, vesopa_sub: null, name: 'Existing Driver', email: 'existing@example.com', state: 'active', plan: planOf(7) });
epos.members.set(502, { id: 502, vesopa_sub: 'sub-frozen', name: 'Frozen Driver', email: 'frozen@example.com', state: 'frozen', plan: planOf(7) });

function fakeEpos(req, res) {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const send = (status, json) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(json)); };
    if (req.headers.authorization !== `Bearer ${KEY}`) return send(401, { error: 'A partner key is required.' });
    const b = body ? JSON.parse(body) : {};
    epos.calls.push({ method: req.method, url: req.url, body: b });
    if (req.method === 'GET' && req.url === '/partner/v1/memberships/plans') return send(200, epos.plans);
    if (req.method === 'GET' && req.url === '/partner/v1/memberships/members') return send(200, [...epos.members.values()].map(eposMember));
    if (req.method === 'POST' && req.url === '/partner/v1/memberships/members') {
      if (epos.failCreate) return send(500, { error: 'boom' });
      let m = [...epos.members.values()].find((x) => b.vesopa_sub && x.vesopa_sub === b.vesopa_sub)
        || [...epos.members.values()].find((x) => b.email && x.email.toLowerCase() === String(b.email).toLowerCase());
      if (!m) {
        m = { id: epos.nextId++, email: b.email, name: b.name, state: b.status === 'active' ? 'active' : 'pending', plan: planOf(b.scheme_id) || epos.plans[0] };
        epos.members.set(m.id, m);
      }
      m.vesopa_sub = m.vesopa_sub || b.vesopa_sub || null;
      if (b.name) m.name = b.name;
      if (b.phone) m.phone = b.phone;
      return send(201, eposMember(m));
    }
    const a = req.url.match(/^\/partner\/v1\/memberships\/members\/(\d+)\/(\w+)$/);
    if (req.method === 'POST' && a) {
      const m = epos.members.get(Number(a[1]));
      if (!m) return send(404, { error: 'No such member.' });
      switch (a[2]) {
        case 'approve':
          if (!['pending', 'cancelled'].includes(m.state)) return send(409, { error: 'This membership is already active.' });
          m.state = 'active'; break;
        case 'suspend': m.state = 'cancelled'; break;
        case 'cancel': m.state = 'cancelled'; break;
        case 'renew': m.state = 'active'; m.valid_to = '2099-12-31'; break;
        case 'plan': if (!planOf(b.scheme_id)) return send(400, { error: 'Pick a membership plan.' }); m.plan = planOf(b.scheme_id); break;
        default: return send(404, { error: 'No such action.' });
      }
      return send(200, eposMember(m));
    }
    return send(404, { error: 'Not found' });
  });
}

// ---- the server under test ------------------------------------------------
let eposServer;
let server;
let base;
let db;
let session;
let access;
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

function idToken(sub, email, name = 'Test Driver') {
  const jwt = require('jsonwebtoken');
  return jwt.sign({ sub, email, name }, privateKey, {
    algorithm: 'RS256', keyid: 'k1', issuer: 'https://auth.example.test', audience: 'metric-test-client', expiresIn: '5m',
  });
}

async function call(method, url, { body, token, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(`${base}${url}`, { method, headers: h, body: payload, redirect: 'manual' });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* text */ }
  return { status: res.status, json, text };
}

const staff = () => ({ Cookie: `mg_admin=${session.issueAdmin({ sub: 'staff-1', email: 'staff@metricgroup.co.uk' })}` });
const callsTo = (re) => epos.calls.filter((c) => re.test(`${c.method} ${c.url}`));

before(async () => {
  eposServer = http.createServer(fakeEpos);
  await new Promise((r) => eposServer.listen(0, '127.0.0.1', r));

  process.env.DB_NAME = 'metric_epos_test';
  process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-123';
  process.env.VESOPA_METRIC_CLIENT_ID = 'metric-test-client';
  process.env.VESOPA_AUTH_ISSUER = 'https://auth.example.test';
  process.env.BASE_URL = 'https://metric.example.test';
  process.env.METRIC_ADMIN_EMAILS = 'staff@metricgroup.co.uk';
  process.env.METRIC_SCHEDULER = 'off';
  process.env.LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'metric-epos-logs-'));
  process.env.EPOS_BASE_URL = `http://127.0.0.1:${eposServer.address().port}/`;
  process.env.EPOS_PARTNER_KEY = KEY;

  const mysql = require('mysql2/promise');
  const root = await mysql.createConnection({ host: '127.0.0.1', user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '', multipleStatements: true });
  await root.query('DROP DATABASE IF EXISTS metric_epos_test; CREATE DATABASE metric_epos_test CHARACTER SET utf8mb4');
  await root.query('USE metric_epos_test');
  const sql = fs.readFileSync(path.join(__dirname, '..', 'schema', 'schema.sql'), 'utf8');
  await root.query(sql);
  await root.query(sql); // re-runnable, EPOS columns included
  // A member approved here before EPOS was switched on.
  await root.query("INSERT INTO members (vesopa_sub, email, name, status, member_no) VALUES ('sub-old', 'old@example.com', 'Old Member', 'active', 'MG100001')");
  await root.end();

  db = require('../src/db');
  session = require('../src/session');
  access = require('../src/access');
  require('../src/activity').useDb(db);
  require('../src/vesopa')._setKeys([{ ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }]);
  const { createApp } = require('../src/server');
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  eposServer.close();
  await db.pool.end();
});

let gateKey;
let newMember;
let newToken;

test('EPOS is on when both variables are set', () => {
  const config = require('../src/config');
  assert.equal(config.EPOS_ON, true);
  assert.equal(config.EPOS_BASE_URL.endsWith('/'), false);
});

test('a sync pulls plans and members from EPOS and pushes local members to it', async () => {
  const r = await call('POST', '/api/admin/epos/sync', { headers: staff() });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.plans, 2);
  assert.equal(r.json.failed, 0, JSON.stringify(r.json.errors));

  const gold = await db.one("SELECT * FROM plans WHERE epos_plan_id = '7'");
  assert.equal(gold.name, 'Gold');
  assert.equal(gold.max_vehicles, 2);

  // An EPOS member nobody here has seen: added, waiting to sign in.
  const existing = await db.one("SELECT * FROM members WHERE epos_member_id = '501'");
  assert.equal(existing.vesopa_sub, 'epos:501');
  assert.equal(existing.status, 'active');
  assert.equal(existing.epos_state, 'active');
  assert.equal(existing.plan_id, gold.id);

  const frozen = await db.one("SELECT * FROM members WHERE epos_member_id = '502'");
  assert.equal(frozen.vesopa_sub, 'sub-frozen');
  assert.equal(frozen.status, 'suspended');

  // The member Metric approved before EPOS: created in EPOS as active.
  const create = callsTo(/^POST \/partner\/v1\/memberships\/members$/).find((c) => c.body.vesopa_sub === 'sub-old');
  assert.ok(create, 'old member created in EPOS');
  assert.equal(create.body.status, 'active');
  const old = await db.one("SELECT * FROM members WHERE vesopa_sub = 'sub-old'");
  assert.ok(old.epos_member_id);
  assert.equal(old.status, 'active');

  const st = await call('GET', '/api/admin/epos', { headers: staff() });
  assert.equal(st.json.enabled, true);
  assert.equal(st.json.last.ok, true);

  // A second sync changes nothing and adds nobody.
  const again = await call('POST', '/api/admin/epos/sync', { headers: staff() });
  assert.equal(again.json.added, 0);
  assert.equal(again.json.created, 0);
  assert.equal(Number((await db.one('SELECT COUNT(*) AS n FROM members')).n), 3);
});

test('plans are made in EPOS, not here; only their sites are Metric\'s', async () => {
  const r = await call('POST', '/api/admin/plans', { headers: staff(), body: { name: 'Local plan' } });
  assert.equal(r.status, 409);
  const gold = await db.one("SELECT * FROM plans WHERE epos_plan_id = '7'");
  await call('PATCH', `/api/admin/plans/${gold.id}`, { headers: staff(), body: { name: 'Renamed', maxVehicles: 9, siteIds: '' } });
  const after = await db.one('SELECT * FROM plans WHERE id = ?', [gold.id]);
  assert.equal(after.name, 'Gold');
  assert.equal(after.max_vehicles, 2);
});

test('a new sign-up is created in EPOS, pending', async () => {
  const r = await call('POST', '/api/v1/auth/vesopa', { body: { idToken: idToken('sub-new', 'new@example.com', 'New Driver') } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.member.status, 'pending');
  assert.equal(r.json.member.epos.state, 'pending');
  assert.equal(r.json.member.plan.name, 'Gold');
  const sent = callsTo(/^POST \/partner\/v1\/memberships\/members$/).find((c) => c.body.vesopa_sub === 'sub-new');
  assert.equal(sent.body.email, 'new@example.com');
  assert.equal(sent.body.name, 'New Driver');
  assert.equal(sent.body.status, undefined, 'pending: no status sent');
  newMember = r.json.member;
  newToken = r.json.token;
});

test('the car limit is the EPOS plan\'s max_vehicles', async () => {
  assert.equal((await call('POST', '/api/v1/vehicles', { token: newToken, body: { plate: 'EP01 AAA' } })).status, 201);
  assert.equal((await call('POST', '/api/v1/vehicles', { token: newToken, body: { plate: 'EP01 BBB' } })).status, 201);
  const third = await call('POST', '/api/v1/vehicles', { token: newToken, body: { plate: 'EP01 CCC' } });
  assert.equal(third.status, 409);
  assert.equal(third.json.code, 'limit');
});

test('staff approval goes to EPOS first; then the barrier opens', async () => {
  const site = await call('POST', '/api/admin/sites', { headers: staff(), body: { name: 'Swindon HQ' } });
  const gate = await call('POST', `/api/admin/sites/${site.json.id}/gates`, { headers: staff(), body: { name: 'Main', direction: 'entry' } });
  gateKey = gate.json.key;

  access._resetBursts();
  let r = await call('POST', `/anpr/v1/gates/${gateKey}/event`, { body: { plate: 'EP01AAA' } });
  assert.equal(r.json.open, false);
  assert.equal(r.json.reason, 'pending');

  // The console's save sends every field; only the status change goes to EPOS.
  const m = await db.one('SELECT * FROM members WHERE id = ?', [newMember.id]);
  const patch = await call('PATCH', `/api/admin/members/${m.id}`, {
    headers: staff(), body: { status: 'active', planId: String(m.plan_id), validFrom: '', validTo: '', name: 'New Driver', company: 'ACME', phone: '', notes: 'ok' },
  });
  assert.equal(patch.status, 200, patch.text);
  assert.deepEqual(patch.json.epos, ['approve']);
  const approve = callsTo(/\/approve$/).pop();
  assert.equal(approve.url, `/partner/v1/memberships/members/${m.epos_member_id}/approve`);
  assert.equal(approve.body.by, 'staff@metricgroup.co.uk');
  const row = await db.one('SELECT * FROM members WHERE id = ?', [m.id]);
  assert.equal(row.status, 'active');
  assert.equal(row.epos_state, 'active');
  assert.equal(row.company, 'ACME');

  access._resetBursts();
  r = await call('POST', `/anpr/v1/gates/${gateKey}/event`, { body: { plate: 'EP01AAA' } });
  assert.equal(r.json.open, true, r.text);
  const list = await call('GET', `/anpr/v1/gates/${gateKey}/allowlist`);
  assert.deepEqual(list.json.plates, ['EP01AAA', 'EP01BBB']);
});

test('EPOS refusing an action changes nothing here', async () => {
  const before = await db.one('SELECT * FROM members WHERE id = ?', [newMember.id]);
  const r = await call('POST', `/api/admin/members/${newMember.id}/actions/approve`, { headers: staff() });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /already active/);
  const afterRow = await db.one('SELECT * FROM members WHERE id = ?', [newMember.id]);
  assert.equal(afterRow.status, before.status);
});

test('a plan change in the console is made in EPOS', async () => {
  const fleet = await db.one("SELECT * FROM plans WHERE epos_plan_id = '8'");
  const r = await call('PATCH', `/api/admin/members/${newMember.id}`, { headers: staff(), body: { status: 'active', planId: String(fleet.id) } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.epos, ['plan']);
  assert.equal(callsTo(/\/plan$/).pop().body.scheme_id, 8);
  const row = await db.one('SELECT * FROM members WHERE id = ?', [newMember.id]);
  assert.equal(row.plan_id, fleet.id);
  assert.equal(row.epos_plan_name, 'Fleet');
  // Local-only plans cannot be chosen.
  const local = await db.one('SELECT * FROM plans WHERE epos_plan_id IS NULL LIMIT 1');
  const bad = await call('PATCH', `/api/admin/members/${newMember.id}`, { headers: staff(), body: { planId: String(local.id) } });
  assert.equal(bad.status, 400);
});

test('a state changed in EPOS reaches the barrier at the next sync', async () => {
  const m = await db.one('SELECT * FROM members WHERE id = ?', [newMember.id]);
  epos.members.get(Number(m.epos_member_id)).state = 'frozen';
  await call('POST', '/api/admin/epos/sync', { headers: staff() });
  access._resetBursts();
  const r = await call('POST', `/anpr/v1/gates/${gateKey}/event`, { body: { plate: 'EP01AAA' } });
  assert.equal(r.json.open, false);
  assert.equal(r.json.reason, 'frozen');
  assert.deepEqual((await call('GET', `/anpr/v1/gates/${gateKey}/allowlist`)).json.plates, []);

  // Even if the local status said active, EPOS's state is what counts.
  await db.run("UPDATE members SET status = 'active' WHERE id = ?", [m.id]);
  access._resetBursts();
  assert.equal((await call('POST', `/anpr/v1/gates/${gateKey}/event`, { body: { plate: 'EP01AAA' } })).json.open, false);

  epos.members.get(Number(m.epos_member_id)).state = 'active';
  await call('POST', '/api/admin/epos/sync', { headers: staff() });
  access._resetBursts();
  assert.equal((await call('POST', `/anpr/v1/gates/${gateKey}/event`, { body: { plate: 'EP01AAA' } })).json.open, true);
});

test('suspending sends suspend to EPOS and shuts the barrier', async () => {
  const r = await call('POST', `/api/admin/members/${newMember.id}/actions/suspend`, { headers: staff() });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.member.status, 'suspended');
  assert.equal(r.json.member.epos.state, 'cancelled');
  access._resetBursts();
  const read = await call('POST', `/anpr/v1/gates/${gateKey}/event`, { body: { plate: 'EP01AAA' } });
  assert.equal(read.json.reason, 'cancelled');
  // And approve reinstates it.
  const back = await call('POST', `/api/admin/members/${newMember.id}/actions/approve`, { headers: staff() });
  assert.equal(back.json.member.status, 'active');
});

test('an EPOS member signing in for the first time takes their row by email', async () => {
  const before = await db.one("SELECT * FROM members WHERE epos_member_id = '501'");
  const r = await call('POST', '/api/v1/auth/vesopa', { body: { idToken: idToken('sub-existing', 'existing@example.com') } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.member.id, before.id);
  assert.equal(r.json.member.status, 'active');
  const row = await db.one('SELECT * FROM members WHERE id = ?', [before.id]);
  assert.equal(row.vesopa_sub, 'sub-existing');
  assert.equal(epos.members.get(501).vesopa_sub, 'sub-existing', 'the Vesopa account is passed to EPOS');
});

test('EPOS down: sign-in still works, and the next sync links the member', async () => {
  epos.failCreate = true;
  const r = await call('POST', '/api/v1/auth/vesopa', { body: { idToken: idToken('sub-offline', 'offline@example.com') } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.member.status, 'pending');
  assert.equal(r.json.member.epos, null);
  epos.failCreate = false;
  const s = await call('POST', '/api/admin/epos/sync', { headers: staff() });
  assert.equal(s.json.created, 1);
  const row = await db.one("SELECT * FROM members WHERE vesopa_sub = 'sub-offline'");
  assert.ok(row.epos_member_id);
  assert.equal(row.epos_state, 'pending');
});

test('a wrong partner key is reported, not thrown', async () => {
  const config = require('../src/config');
  const good = config.EPOS_PARTNER_KEY;
  config.EPOS_PARTNER_KEY = 'vpk_wrong';
  const r = await call('POST', '/api/admin/epos/sync', { headers: staff() });
  config.EPOS_PARTNER_KEY = good;
  assert.equal(r.status, 502);
  assert.match(r.json.error, /partner key/);
  const st = await call('GET', '/api/admin/epos', { headers: staff() });
  assert.equal(st.json.last.ok, false);
});
