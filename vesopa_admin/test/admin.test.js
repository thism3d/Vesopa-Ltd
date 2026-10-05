/**
 * admin.vesopa.com, end to end against a real MariaDB and a fake back office
 * and Gift (2026-10-05). The fakes answer the same routes the real apps do and
 * record what they were asked, so these checks prove what admin.vesopa.com
 * SENDS; the back office's side is proven by vesopa_server/test/admin-holds.
 *
 * SKIPPED when no database is reachable (root, no password, 127.0.0.1).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const mysql = require('mysql2/promise');

const DB = 'vesopa_admin_selftest';
const KEY = 'e'.repeat(40);
const GKEY = 'g'.repeat(40);

const roles = require('../src/roles');
const catalogue = require('../src/catalogue');

test('roles: a role is limited to its apps, and the owner is everything', () => {
  const owner = roles.principal({ email: 'info@vesopasoftware.com', row: null, ownerEmail: 'info@vesopasoftware.com' });
  assert.ok(owner.isOwner && roles.can(owner, 'admins.manage') && roles.can(owner, 'licences.sell', 'gift'));
  const giftSupport = roles.principal({ email: 'g@x.com', row: { role: 'support', apps: 'gift', status: 'active' }, ownerEmail: 'info@vesopasoftware.com' });
  assert.ok(roles.can(giftSupport, 'licences.run', 'gift'));
  assert.ok(!roles.can(giftSupport, 'licences.run', 'epos'), 'not in an app it was not given');
  assert.ok(!roles.can(giftSupport, 'licences.sell', 'gift'), 'support moves no money');
  const suspended = roles.principal({ email: 's@x.com', row: { role: 'owner', apps: '*', status: 'suspended' }, ownerEmail: 'info@vesopasoftware.com' });
  assert.ok(!suspended.active && !roles.can(suspended, 'licences.view'));
  const nobody = roles.principal({ email: 'n@x.com', row: null, ownerEmail: 'info@vesopasoftware.com' });
  assert.ok(!nobody.active);
  assert.strictEqual(roles.cleanApps(['gift', 'nonsense', 'epos']), 'gift,epos');
  assert.strictEqual(roles.cleanApps(['*', 'gift']), '*');
});

test('catalogue: one state per line, from what the apps said', () => {
  const till = catalogue.BY_KEY.till;
  assert.strictEqual(catalogue.lineFor(till, { limits: { till: null } }).state, 'active', 'no limit is sold');
  assert.strictEqual(catalogue.lineFor(till, { limits: { till: 0 } }).state, 'off');
  const graceLine = catalogue.lineFor(till, { limits: { till: 2 }, inUse: { till: 1 }, holds: { till: { state: 'paused', stopped: false, graceUntil: '2026-10-06T10:00:00Z' } } });
  assert.deepStrictEqual([graceLine.state, graceLine.seats, graceLine.used, graceLine.until], ['grace', 2, 1, '2026-10-06T10:00:00Z']);
  const mem = catalogue.BY_KEY.memberships;
  assert.strictEqual(catalogue.lineFor(mem, { modules: { memberships: { allowed: false } } }).state, 'off');
  assert.strictEqual(catalogue.lineFor(mem, {
    modules: { memberships: { allowed: false, hold: { stopped: true } } },
    holds: { 'module:memberships': { state: 'removed', stopped: true, graceUntil: 'x' } },
  }).state, 'removed', 'a removed module still shows, as removed');
  assert.strictEqual(catalogue.lineFor(catalogue.BY_KEY.gift, { gift: { enabled: true, pending: { due_at: 'y', action: 'pause' } } }).state, 'grace');
});

function listen(app) {
  return new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
}

function call(server, method, url, { cookie, form } = {}) {
  return new Promise((resolve, reject) => {
    const body = form ? new URLSearchParams(form).toString() : null;
    const req = http.request({
      host: '127.0.0.1', port: server.address().port, method, path: url,
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const flashOf = (res) => {
  const c = [].concat(res.headers['set-cookie'] || []).find((x) => x.startsWith('va_flash='));
  return c ? JSON.parse(Buffer.from(c.split(';')[0].slice(9), 'base64url').toString('utf8')) : null;
};

test('admin.vesopa.com end to end', async (t) => {
  let root;
  try {
    root = await mysql.createConnection({ host: '127.0.0.1', user: 'root', password: '', multipleStatements: true });
  } catch (e) {
    t.skip(`no database reachable (${e.code})`);
    return;
  }
  await root.query(`DROP DATABASE IF EXISTS ${DB}; CREATE DATABASE ${DB} CHARACTER SET utf8mb4; USE ${DB};`);
  await root.query(fs.readFileSync(path.join(__dirname, '..', 'schema', 'schema.sql'), 'utf8'));
  await root.query(fs.readFileSync(path.join(__dirname, '..', 'schema', 'schema.sql'), 'utf8'));
  await root.end();

  // The fake back office: the routes vesopa_admin calls, and a record of them.
  const asked = [];
  const holds = {};
  const limits = { till: null, kitchen: 1, display: null, express: 0 };
  const eposApp = express();
  eposApp.use(express.json());
  eposApp.use((req, res, next) => {
    if (req.get('authorization') !== `Bearer ${KEY}`) return res.status(401).json({ error: 'no' });
    asked.push({ method: req.method, url: req.url, as: req.get('x-vesopa-admin'), body: req.body });
    next();
  });
  const venue = () => ({
    id: 7, name: 'The Arms', email: 'arms@pub.test', status: 'active', plan: 'Pro',
    devices: { till: { total: 2, online: 0 } }, online: 0, device_count: 2, last_seen_at: new Date(Date.now() - 3600e3).toISOString(),
    today: { orders: 12, total_minor: 45600 }, overdue: { count: 1, amount_minor: 4900 },
    holds: Object.values(holds),
  });
  eposApp.get('/api/admin/overview', (_req, res) => res.json({
    at: new Date().toISOString(), online_minutes: 10,
    totals: { venues: 1, active: 1, paused: 0, devices: 2, online: 0, today_minor: 45600, today_orders: 12, overdue_invoices: 1, overdue_minor: 4900, holds_in_grace: Object.values(holds).filter((h) => !h.stopped).length, holds_stopped: 0 },
    venues: [venue()],
  }));
  eposApp.get('/api/admin/offices/7/licence-limits', (_req, res) => res.json({ limits, keys: [] }));
  eposApp.get('/api/admin/licences', (_req, res) => res.json({ venues: [{ id: 7, products: [{ kind: 'till', in_use: 2 }] }] }));
  eposApp.get('/api/admin/offices/7/modules', (_req, res) => res.json([{ key: 'memberships', allowed: false, charge_minor: 2900 }]));
  eposApp.put('/api/admin/offices/7/licence-limits', (req, res) => { Object.assign(limits, req.body); res.json({ ok: true }); });
  eposApp.put('/api/admin/offices/7/modules', (_req, res) => res.json([]));
  eposApp.put('/api/admin/offices/7/holds/:item', (req, res) => {
    if (req.body.action === 'resume') { delete holds[req.params.item]; return res.json({ ok: true, hold: null }); }
    holds[req.params.item] = { item: req.params.item, state: req.body.action === 'remove' ? 'removed' : 'paused', stopped: false, graceUntil: new Date(Date.now() + req.body.grace_hours * 3600e3).toISOString(), reason: req.body.reason };
    res.json({ ok: true, hold: holds[req.params.item] });
  });
  eposApp.get('/api/admin/modules', (_req, res) => res.json([{ key: 'memberships', label: 'Memberships', price_minor: 2900, active: true, venues: 0 }]));
  const eposServer = await listen(eposApp);

  const giftAsked = [];
  let giftOn = true;
  const giftApp = express();
  giftApp.use((req, res, next) => (req.get('authorization') === `Bearer ${GKEY}` ? next() : res.status(401).json({ error: 'no' })));
  giftApp.get('/api/admin/venues', (_req, res) => res.json({ venues: [{ office_id: 7, enabled: giftOn }] }));
  giftApp.post('/api/admin/venues/:id/:what', (req, res) => { giftAsked.push(req.params.what); giftOn = req.params.what === 'enable'; res.json({ ok: true }); });
  const giftServer = await listen(giftApp);

  Object.assign(process.env, {
    DB_HOST: '127.0.0.1', DB_USER: 'root', DB_PASSWORD: '', DB_NAME: DB,
    EPOS_API: `http://127.0.0.1:${eposServer.address().port}`, EPOS_SERVICE_KEY: KEY,
    GIFT_API: `http://127.0.0.1:${giftServer.address().port}`, GIFT_SERVICE_KEY: GKEY,
    HOSTING_SERVICE_KEY: '', SMTP_HOST: '', OWNER_EMAIL: 'info@vesopasoftware.com',
  });
  const db = require('../src/db');
  const { build } = require('../src/server');
  const scheduler = require('../src/scheduler');
  const server = await listen(build());

  async function signIn(email) {
    const token = crypto.randomBytes(16).toString('hex');
    const csrf = crypto.randomBytes(16).toString('hex');
    await db.run(
      'INSERT INTO adm_sessions (id, email, csrf, expires_at) VALUES (?, ?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 1 HOUR))',
      [crypto.createHash('sha256').update(token).digest('hex'), email, csrf]
    );
    return { cookie: `va_sid=${token}`, csrf };
  }

  try {
    await t.test('signed out, every page goes to sign-in', async () => {
      const r = await call(server, 'GET', '/');
      assert.strictEqual(r.status, 303);
      assert.strictEqual(r.headers.location, '/signin');
      const s = await call(server, 'GET', '/signin');
      assert.match(s.text, /Sign-in is not set up/);
    });

    const owner = await signIn('info@vesopasoftware.com');

    await t.test('the owner sees the live overview', async () => {
      const r = await call(server, 'GET', '/', { cookie: owner.cookie });
      assert.strictEqual(r.status, 200, r.text.slice(0, 300));
      assert.match(r.text, /£456\.00/);
      assert.match(r.text, /The Arms<\/b>: no device online/);
      assert.match(r.text, /1 overdue invoice/);
    });

    await t.test('the venue page shows every catalogue line', async () => {
      const r = await call(server, 'GET', '/venues/7', { cookie: owner.cookie });
      assert.strictEqual(r.status, 200, r.text.slice(0, 300));
      for (const l of ['Till', 'Kitchen screen', 'Express kiosk', 'Memberships', 'Gift cards and tickets']) assert.ok(r.text.includes(l), l);
      assert.match(r.text, /2 in use · no limit/);
    });

    await t.test('pause goes to the back office as the admin, with a grace day, and is logged', async () => {
      asked.length = 0;
      const r = await call(server, 'POST', '/venues/7/items/till', { cookie: owner.cookie, form: { _csrf: owner.csrf, action: 'pause', reason: 'Unpaid', grace_hours: '24' } });
      assert.strictEqual(r.status, 303);
      assert.match(flashOf(r).text, /Till paused\. It keeps working until/);
      const put = asked.find((a) => a.method === 'PUT' && a.url === '/api/admin/offices/7/holds/till');
      assert.deepStrictEqual(put.body, { action: 'pause', reason: 'Unpaid', grace_hours: 24 });
      assert.strictEqual(put.as, 'info@vesopasoftware.com');
      const [row] = await db.all("SELECT * FROM adm_audit WHERE action = 'till.pause'");
      assert.ok(row && row.ok === 1 && row.venue_name === 'The Arms');
      const page = await call(server, 'GET', '/venues/7', { cookie: owner.cookie });
      assert.match(page.text, /Pausing · stops/);
      assert.match(page.text, />Resume</);
    });

    await t.test('add a device app sets its seats and lifts any hold', async () => {
      asked.length = 0;
      await call(server, 'POST', '/venues/7/items/express', { cookie: owner.cookie, form: { _csrf: owner.csrf, action: 'add', seats: '2' } });
      assert.deepStrictEqual(asked.find((a) => a.url.endsWith('/licence-limits') && a.method === 'PUT').body, { express: 2 });
      assert.ok(asked.find((a) => a.url.endsWith('/holds/express') && a.body.action === 'resume'));
    });

    await t.test('a form without its token changes nothing', async () => {
      asked.length = 0;
      const r = await call(server, 'POST', '/venues/7/items/till', { cookie: owner.cookie, form: { action: 'resume' } });
      assert.strictEqual(r.status, 403);
      assert.strictEqual(asked.filter((a) => a.method === 'PUT').length, 0);
    });

    await t.test('support can pause but not remove; a Gift-only admin cannot open venues', async () => {
      await db.run("INSERT INTO adm_admins (email, role, apps, status) VALUES ('sam@vesopa.com', 'support', '*', 'active'), ('gina@vesopa.com', 'support', 'gift', 'active')");
      const sam = await signIn('sam@vesopa.com');
      const r = await call(server, 'POST', '/venues/7/items/memberships', { cookie: sam.cookie, form: { _csrf: sam.csrf, action: 'remove' } });
      assert.match(flashOf(r).text, /Support\) cannot remove Memberships/);
      const gina = await signIn('gina@vesopa.com');
      const v = await call(server, 'GET', '/venues', { cookie: gina.cookie });
      assert.strictEqual(v.status, 403);
      const a = await call(server, 'GET', '/admins', { cookie: sam.cookie });
      assert.strictEqual(a.status, 403);
    });

    await t.test('pausing Gift waits for the grace day, then the scheduler switches it off', async () => {
      giftAsked.length = 0;
      await call(server, 'POST', '/venues/7/items/gift', { cookie: owner.cookie, form: { _csrf: owner.csrf, action: 'pause', grace_hours: '24' } });
      assert.deepStrictEqual(giftAsked, [], 'nothing yet');
      assert.strictEqual(await scheduler.runDue(new Date()), 0);
      assert.strictEqual(await scheduler.runDue(new Date(Date.now() + 25 * 3600e3)), 1);
      assert.deepStrictEqual(giftAsked, ['disable']);
      await call(server, 'POST', '/venues/7/items/gift', { cookie: owner.cookie, form: { _csrf: owner.csrf, action: 'resume' } });
      assert.deepStrictEqual(giftAsked, ['disable', 'enable']);
    });

    await t.test('admins: the owner adds a per-app admin; nobody else can make an Owner', async () => {
      const r = await call(server, 'POST', '/admins', { cookie: owner.cookie, form: { _csrf: owner.csrf, email: 'Hal@Vesopa.com', role: 'billing', apps: 'hosting' } });
      assert.match(flashOf(r).text, /hal@vesopa\.com can sign in as Billing/);
      const [hal] = await db.all("SELECT * FROM adm_admins WHERE email = 'hal@vesopa.com'");
      assert.deepStrictEqual([hal.role, hal.apps], ['billing', 'hosting']);
      await db.run("INSERT INTO adm_admins (email, role, apps, status) VALUES ('mia@vesopa.com', 'owner', '*', 'active')");
      const mia = await signIn('mia@vesopa.com');
      const m = await call(server, 'POST', '/admins', { cookie: mia.cookie, form: { _csrf: mia.csrf, email: 'x@vesopa.com', role: 'owner', apps: '*' } });
      assert.match(flashOf(m).text, /Only the owner can make another Owner/);
    });

    await t.test('the daily summary goes once a day, after eight', async () => {
      const morning = new Date('2026-10-06T09:30:00Z');
      await db.run("UPDATE adm_audit SET at = '2026-10-06 07:00:00'");
      assert.strictEqual(await scheduler.dailySummary(new Date('2026-10-06T05:00:00Z')), false, 'not before eight');
      assert.strictEqual(await scheduler.dailySummary(morning), true);
      assert.strictEqual(await scheduler.dailySummary(morning), false, 'once');
    });
  } finally {
    server.close();
    eposServer.close();
    giftServer.close();
    await db.pool.query(`DROP DATABASE IF EXISTS ${DB}`).catch(() => {});
    await db.pool.end();
  }
});
