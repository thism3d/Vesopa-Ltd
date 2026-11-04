/**
 * Which sites a kitchen cooks for (2026-11-04), against a fake database.
 *
 * A ticket remembers the till that fired it and that till's site; a screen
 * lists its sites, and the back office, a till and the screen itself can name
 * it and choose them.
 */

const assert = require('assert');
const express = require('express');
const jwt = require('jsonwebtoken');

const { kitchenRoutes, kitchenAppRoutes, tillKitchenRoutes, parseSites, formatSites } = require('../src/kitchen');

const SECRET = 'test-secret-not-a-real-one';
const OFFICE = 'venue@example.com';

function fakePool(script) {
  const asked = [];
  const answer = (sql, params) => {
    asked.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    for (const [pattern, rows] of script) {
      if (sql.includes(pattern)) return [typeof rows === 'function' ? rows(params) : rows, []];
    }
    if (/^\s*(INSERT|UPDATE|DELETE)/i.test(sql)) return [{ affectedRows: 1, insertId: 42 }, []];
    return [[], []];
  };
  const pool = {
    asked,
    query: async (sql, params) => answer(sql, params),
    execute: async (sql, params) => answer(sql, params),
  };
  pool.getConnection = async () => ({
    beginTransaction: async () => {},
    commit: async () => {},
    rollback: async () => {},
    release: () => {},
    query: pool.query,
    execute: pool.execute,
  });
  return pool;
}

function appWith(pool) {
  const app = express();
  app.use(express.json());
  app.use('/api', kitchenRoutes({ pool, broadcast: () => {}, secret: SECRET }));
  app.use('/api', kitchenAppRoutes({ pool, broadcast: () => {}, secret: SECRET }));
  app.use(tillKitchenRoutes({ pool, broadcast: () => {}, secret: SECRET }));
  app.use((err, _req, res, _next) => res.status(500).json({ error: String(err) }));
  return app;
}

const listen = (app) => new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });

async function call(server, method, path, { body, token } = {}) {
  const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, body: json };
}

const goKitchen = jwt.sign({ scope: 'kitchen', office: OFFICE, user: 'boss', name: 'Boss', via: 'go' }, SECRET);
const loginKitchen = jwt.sign({ scope: 'kitchen', office: OFFICE, user: 'grill', name: 'Grill' }, SECRET);
const terminal = jwt.sign({ scope: 'terminal', office: OFFICE, officeId: 7 }, SECRET);
const session = jwt.sign({ sub: 1, email: OFFICE, role: 'office' }, SECRET);

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.log(`FAIL  ${name}\n      ${e.stack}`);
    process.exitCode = 1;
  }
}

const SITES = [['FROM bo_till_sites', [{ id: 1, name: 'Bar', colour: '#123456' }, { id: 2, name: 'Lounge', colour: null }]],
  ['FROM bo_till_names WHERE office = ? AND site_id IS NOT NULL', [{ terminal: 'TILL-1', label: 'Bar till', site_id: 1 }]]];

(async () => {
  console.log('Kitchen sites\n');

  await check('site lists are cleaned and stored in order', async () => {
    assert.deepStrictEqual(parseSites('3, 1,x,1,0'), [1, 3]);
    assert.deepStrictEqual(parseSites([2, '5']), [2, 5]);
    assert.strictEqual(formatSites([]), null);
    assert.strictEqual(formatSites(['4', 2]), '2,4');
  });

  await check('a ticket records its till and that till\'s site', async () => {
    const pool = fakePool([['SELECT site_id FROM bo_till_names', [{ site_id: 2 }]]]);
    const server = await listen(appWith(pool));
    const res = await call(server, 'POST', '/till/kitchen/tickets', {
      body: { id: '11111111-1111-1111-1111-111111111111', office: OFFICE, terminal: 'LOUNGE-1',
        lines: [{ id: '22222222-2222-2222-2222-222222222222', quantity: 1, name: 'Chips', stations: 'kp1' }] },
    });
    server.close();
    assert.strictEqual(res.status, 201);
    const insert = pool.asked.find((q) => q.sql.startsWith('INSERT IGNORE INTO epos_kitchen_tickets'));
    assert.ok(insert.sql.includes('terminal, site_id'), insert.sql);
    assert.deepStrictEqual(insert.params.slice(-2), ['LOUNGE-1', 2]);
  });

  await check('a ticket with no till named takes its open bill\'s', async () => {
    const pool = fakePool([
      ['FROM epos_open_bills', [{ terminal: 'TILL-1' }]],
      ['SELECT site_id FROM bo_till_names', [{ site_id: 1 }]],
    ]);
    const server = await listen(appWith(pool));
    await call(server, 'POST', '/till/kitchen/tickets', {
      body: { id: '33333333-3333-3333-3333-333333333333', office: OFFICE, order_id: 'bill-1',
        lines: [{ id: '44444444-4444-4444-4444-444444444444', quantity: 1, name: 'Pie', stations: 'kp1' }] },
    });
    server.close();
    const insert = pool.asked.find((q) => q.sql.startsWith('INSERT IGNORE INTO epos_kitchen_tickets'));
    assert.deepStrictEqual(insert.params.slice(-2), ['TILL-1', 1]);
  });

  await check('the board says which till and site each ticket came from', async () => {
    const pool = fakePool([
      ['HAVING SUM', [{ id: 't1' }]],
      ['FROM epos_kitchen_tickets', [{ id: 't1', order_id: 'o1', kind: 'sale', rushed: 0, placed_at: new Date(), terminal: 'TILL-1', site_id: 1 }]],
    ]);
    const server = await listen(appWith(pool));
    const res = await call(server, 'GET', '/api/kitchen/board', { token: goKitchen });
    server.close();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.tickets[0].terminal, 'TILL-1');
    assert.strictEqual(res.body.tickets[0].siteId, 1);
  });

  await check('a screen\'s profile lists the venue\'s sites and its own', async () => {
    const pool = fakePool([...SITES,
      ['FROM epos_kitchen_screens', [{ id: 5, name: 'Main kitchen', stations: 'kp1', site_ids: '1,2' }]]]);
    const server = await listen(appWith(pool));
    const res = await call(server, 'GET', '/api/kitchen/profile', { token: goKitchen });
    server.close();
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.sites.map((s) => s.name), ['Bar', 'Lounge']);
    assert.deepStrictEqual(res.body.screens[0].sites, [1, 2]);
    assert.deepStrictEqual(res.body.screens[0].till_sites, { 'TILL-1': 1 });
    assert.strictEqual('site_ids' in res.body.screens[0], false);
  });

  await check('the back office saves a screen\'s sites', async () => {
    const pool = fakePool([['SELECT * FROM epos_kitchen_screens', [{ id: 5, name: 'Main', warn_seconds: 480, late_seconds: 900 }]]]);
    const server = await listen(appWith(pool));
    const res = await call(server, 'PUT', '/api/kitchen/screens/5', { token: session, body: { name: 'Main', sites: [2, 1] } });
    server.close();
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const save = pool.asked.find((q) => q.sql.startsWith('UPDATE epos_kitchen_screens SET site_ids'));
    assert.deepStrictEqual(save.params, ['1,2', 5, OFFICE]);
  });

  await check('a till names a kitchen and chooses its sites', async () => {
    const pool = fakePool([['SELECT id, tv_size, zoom_percent, touch FROM epos_kitchen_screens', [{ id: 5 }]]]);
    const server = await listen(appWith(pool));
    const res = await call(server, 'PUT', '/till/kitchen/display/5', { token: terminal, body: { name: 'Lounge kitchen', sites: [2] } });
    const made = await call(server, 'POST', '/till/kitchen/display', { token: terminal, body: { name: 'Bar kitchen', sites: [1] } });
    server.close();
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.ok(pool.asked.some((q) => q.sql.startsWith('UPDATE epos_kitchen_screens SET name') && q.params[0] === 'Lounge kitchen'));
    assert.ok(pool.asked.some((q) => q.sql.startsWith('UPDATE epos_kitchen_screens SET site_ids') && q.params[0] === '2'));
    assert.strictEqual(made.status, 201);
    assert.strictEqual(made.body.id, 42);
  });

  await check('two kitchens cannot share a name', async () => {
    const pool = fakePool([['SELECT id FROM epos_kitchen_screens WHERE office = ? AND name = ?', [{ id: 9 }]]]);
    const server = await listen(appWith(pool));
    const res = await call(server, 'POST', '/till/kitchen/display', { token: terminal, body: { name: 'Main' } });
    server.close();
    assert.strictEqual(res.status, 409);
  });

  await check('a Go kitchen names itself; a kitchen login needs its password', async () => {
    const pool = fakePool([...SITES, ['SELECT id FROM epos_kitchen_screens WHERE id = ?', [{ id: 5 }]]]);
    const server = await listen(appWith(pool));
    const ok = await call(server, 'PUT', '/api/kitchen/profile/screens/5', { token: goKitchen, body: { name: 'Pass', sites: [1] } });
    const refused = await call(server, 'PUT', '/api/kitchen/profile/screens/5', { token: loginKitchen, body: { name: 'Pass' } });
    server.close();
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    assert.deepStrictEqual(ok.body.sites.map((s) => s.id), [1, 2]);
    assert.strictEqual(refused.status, 403);
  });

  console.log(`\n${passed} checks passed`);
})();
