/**
 * The venue's local link, server half (src/lan.js, 2026-10-27): the key goes
 * to the venue's devices only, reports are kept, and a move replayed after an
 * outage runs once however often it is sent.
 *
 *   node test/lan.test.js
 *
 * In-process with a stand-in database: no MySQL needed.
 */
const assert = require('assert');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { lanRoutes, offlineOnce, lanKey } = require('../src/lan');

const SECRET = 'lan-test-secret';
let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`  FAIL  ${name}\n        ${e.stack}`);
    process.exitCode = 1;
  }
}

/** Just enough of mysql2 for these routes. */
function fakePool() {
  const reports = new Map();
  const journal = new Map();
  const settings = new Map();
  return {
    reports, journal, settings,
    async query(sql, params = []) {
      if (/^CREATE TABLE/i.test(sql.trim())) return [[]];
      if (/FROM epos_lan_settings/.test(sql)) {
        const v = settings.get(params[0]);
        return [v ? [{ preferred_hub: v }] : []];
      }
      if (/FROM epos_lan_reports/.test(sql)) {
        return [[...reports.values()].filter((r) => r.office === params[0])];
      }
      if (/FROM epos_lan_conflicts/.test(sql)) return [[]];
      throw new Error(`unexpected query ${sql}`);
    },
    async execute(sql, params = []) {
      if (/INSERT INTO epos_lan_reports/.test(sql)) {
        const [office, device, role, name, version, report] = params;
        reports.set(`${office}|${device}`, { office, device, role, name, version, report, age_s: 0 });
        return [{ affectedRows: 1 }];
      }
      if (/INSERT IGNORE INTO epos_lan_journal/.test(sql)) {
        const k = `${params[0]}|${params[1]}`;
        if (journal.has(k)) return [{ affectedRows: 0 }];
        journal.set(k, { path: params[2] });
        return [{ affectedRows: 1 }];
      }
      if (/DELETE FROM epos_lan_journal/.test(sql)) {
        journal.delete(`${params[0]}|${params[1]}`);
        return [{ affectedRows: 1 }];
      }
      if (/UPDATE epos_lan_journal/.test(sql)) return [{ affectedRows: 1 }];
      if (/INSERT INTO epos_lan_settings/.test(sql)) {
        settings.set(params[0], params[1]);
        return [{ affectedRows: 1 }];
      }
      throw new Error(`unexpected execute ${sql}`);
    },
  };
}

function serve(app) {
  return new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
}

async function call(server, method, path, { token, body, headers = {} } = {}) {
  const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* none */ }
  return { status: res.status, json };
}

(async () => {
  const pool = fakePool();
  const app = express();
  app.use(express.json());
  app.use(lanRoutes({ pool, secret: SECRET }));
  let runs = 0;
  let failNext = false;
  app.post('/api/gift-cards/redeem', offlineOnce(pool), (req, res) => {
    runs++;
    if (failNext) { failNext = false; return res.status(503).json({ error: 'down' }); }
    res.json({ ok: true, balance_minor: 1000 - runs * 100 });
  });
  const server = await serve(app);

  const till = jwt.sign({ scope: 'terminal', office: 'club@venue.test' }, SECRET);
  const kitchen = jwt.sign({ scope: 'kitchen', office: 'club@venue.test' }, SECRET);
  const other = jwt.sign({ scope: 'terminal', office: 'other@venue.test' }, SECRET);
  const person = jwt.sign({ email: 'club@venue.test' }, SECRET);

  await check('a till and a kitchen screen of the venue get the same key', async () => {
    const a = await call(server, 'GET', '/api/lan/key', { token: till });
    const b = await call(server, 'GET', '/api/lan/key', { token: kitchen });
    assert.strictEqual(a.status, 200);
    assert.strictEqual(a.json.key, b.json.key);
    assert.strictEqual(a.json.key, lanKey(SECRET, 'club@venue.test'));
    assert.strictEqual(a.json.key.length, 64);
  });

  await check('another venue gets another key; a person or nobody gets none', async () => {
    const a = await call(server, 'GET', '/api/lan/key', { token: till });
    const o = await call(server, 'GET', '/api/lan/key', { token: other });
    assert.notStrictEqual(a.json.key, o.json.key);
    assert.strictEqual((await call(server, 'GET', '/api/lan/key', { token: person })).status, 401);
    assert.strictEqual((await call(server, 'GET', '/api/lan/key')).status, 401);
  });

  await check('a report is kept, and the tills it names are handed out as targets', async () => {
    const r = await call(server, 'POST', '/api/lan/report', {
      token: till,
      body: { device: 'till-1', role: 'till', name: 'Bar', version: '1.16.33', ips: ['192.168.1.20'] },
    });
    assert.strictEqual(r.status, 200);
    const key = await call(server, 'GET', '/api/lan/key', { token: kitchen });
    assert.deepStrictEqual(key.json.targets, ['192.168.1.20']);
  });

  await check('a replayed move runs once; a failed one may run again', async () => {
    const body = { office: 'club@venue.test', code: '9878001', amount_minor: 100 };
    const h = { 'X-Vesopa-Offline-Id': 'till-1:42' };
    const first = await call(server, 'POST', '/api/gift-cards/redeem', { body, headers: h });
    const again = await call(server, 'POST', '/api/gift-cards/redeem', { body, headers: h });
    assert.strictEqual(first.json.balance_minor, 900);
    assert.strictEqual(again.json.duplicate, true);
    assert.strictEqual(runs, 1);

    failNext = true;
    const h2 = { 'X-Vesopa-Offline-Id': 'till-1:43' };
    const down = await call(server, 'POST', '/api/gift-cards/redeem', { body, headers: h2 });
    assert.strictEqual(down.status, 503);
    await new Promise((r) => setTimeout(r, 30));
    const retry = await call(server, 'POST', '/api/gift-cards/redeem', { body, headers: h2 });
    assert.strictEqual(retry.status, 200);
    assert.notStrictEqual(retry.json.duplicate, true);
    assert.strictEqual(runs, 3);

    // Without the header nothing changes: an ordinary till call runs.
    await call(server, 'POST', '/api/gift-cards/redeem', { body });
    assert.strictEqual(runs, 4);
  });

  server.close();
  console.log(`${passed} passed`);
})();
