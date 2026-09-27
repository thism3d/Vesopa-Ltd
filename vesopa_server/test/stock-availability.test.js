/**
 * What can still be made, and Sold out (2026-09-27): /stock/availability and
 * /stock/sold-out, and the kitchen screen's limited copy of the stock routes.
 *
 *   * a product's own count; a half pint limited by its keg; a burger limited
 *     by whichever ingredient runs out first; an uncounted ingredient does not
 *     limit it;
 *   * Sold out is the QR menu's own switch (dinein_items.available);
 *   * a kitchen screen may read, record wastage and mark sold out -- nothing
 *     else.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');

const { stockRoutes } = require('../src/stock');

const SECRET = 'test-secret-not-a-real-one';

const PRODUCTS = [
  { id: 1, pluid: 101, product_name: 'Carling Pint', stock_quantity: 44, stock_unit: 'pint' },
  { id: 2, pluid: 102, product_name: 'Carling Half', stock_quantity: null, stock_parent_pluid: 101, stock_ratio: 0.5, parent_name: 'Carling Pint' },
  { id: 3, pluid: 103, product_name: 'Burger', stock_quantity: null, recipe_lines: 3 },
  { id: 4, pluid: 104, product_name: 'Bun', stock_quantity: 5 },
  { id: 5, pluid: 105, product_name: 'Patty', stock_quantity: 12 },
  { id: 6, pluid: 106, product_name: 'Sauce', stock_quantity: null },
  { id: 7, pluid: 107, product_name: 'Chips', stock_quantity: null },
];
const RECIPES = [
  { recipe_pluid: 103, ingredient_pluid: 104, quantity: 1 },
  { recipe_pluid: 103, ingredient_pluid: 105, quantity: 2 },
  { recipe_pluid: 103, ingredient_pluid: 106, quantity: 0.1 },
];

function fakePool({ menu = [] } = {}) {
  const asked = [];
  const answer = (sql, params) => {
    const q = sql.replace(/\s+/g, ' ').trim();
    asked.push({ q, params });
    if (q.startsWith('SELECT contact_email FROM offices')) return [[{ contact_email: 'venue@example.com' }]];
    if (q.startsWith('SELECT id FROM offices WHERE contact_email')) return [[{ id: 7 }]];
    if (q.includes('FROM bo_products p')) return [PRODUCTS.map((p) => ({ ...p }))];
    if (q.startsWith('SELECT recipe_pluid')) return [RECIPES];
    if (q.startsWith('SELECT plu_id, MAX(available)')) return [menu];
    if (q.startsWith('UPDATE dinein_items')) {
      const n = menu.filter((m) => m.plu_id === params[2]).length;
      return [{ affectedRows: n }];
    }
    return [[]];
  };
  return {
    asked,
    query: async (sql, params = []) => [answer(sql, params)[0], []],
    execute: async (sql, params = []) => [answer(sql, params)[0], []],
    getConnection: async () => ({
      beginTransaction: async () => {},
      commit: async () => {},
      rollback: async () => {},
      release: () => {},
      query: async (sql, params = []) => [answer(sql, params)[0], []],
      execute: async (sql, params = []) => [answer(sql, params)[0], []],
    }),
  };
}

async function serve(pool, opts) {
  const pushes = [];
  const app = express();
  app.use(express.json());
  app.use(stockRoutes({ pool, broadcast: (m) => pushes.push(m), secret: SECRET, toPdf: async () => Buffer.from(''), ...opts }));
  app.use((err, _req, res, _next) => res.status(500).json({ error: String(err) }));
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const call = async (method, path, { token, body } = {}) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { server, call, pushes };
}

const terminal = jwt.sign({ scope: 'terminal', office: 'venue@example.com', officeId: 7 }, SECRET);
const kitchenToken = jwt.sign({ scope: 'kitchen', office: 'venue@example.com', user: 'grill', name: 'Grill' }, SECRET);

test('how many more can be made', async () => {
  const { server, call } = await serve(fakePool({ menu: [{ plu_id: 103, any_on: 0, n: 2 }, { plu_id: 101, any_on: 1, n: 1 }] }), { till: true });
  try {
    const r = await call('GET', '/till/stock/availability', { token: terminal });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const by = Object.fromEntries(r.body.map((p) => [p.product_name, p]));
    assert.equal(by['Carling Pint'].can_make, 44);
    assert.equal(by['Carling Half'].can_make, 88, 'a half is limited by its keg');
    assert.equal(by.Burger.can_make, 5, 'five buns, six pairs of patties: the buns decide; the uncounted sauce does not limit');
    assert.equal(by.Chips.can_make, null, 'nothing counted, nothing to say');
    assert.deepEqual(by.Burger.recipe.map((l) => [l.product_name, l.quantity]), [['Bun', 1], ['Patty', 2], ['Sauce', 0.1]]);
    assert.equal(by.Burger.sold_out, true, 'every menu entry switched off');
    assert.equal(by['Carling Pint'].sold_out, false);
    assert.equal(by.Chips.on_menu, false);
  } finally {
    server.close();
  }
});

test('Sold out is the menu’s own switch, and says so for a product not on the menu', async () => {
  const pool = fakePool({ menu: [{ plu_id: 103, any_on: 1, n: 2 }] });
  const { server, call, pushes } = await serve(pool, { till: true });
  try {
    const r = await call('POST', '/till/stock/sold-out', { token: terminal, body: { pluid: 103, sold_out: true } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const upd = pool.asked.find((a) => a.q.startsWith('UPDATE dinein_items'));
    assert.deepEqual(upd.params, [0, 7, 103]);
    assert.ok(pushes.some((p) => p.type === 'dinein.updated'), 'the QR menu and kiosk were not told');
    const none = await call('POST', '/till/stock/sold-out', { token: terminal, body: { pluid: 107, sold_out: true } });
    assert.equal(none.status, 409);
    assert.match(none.body.error, /not on the QR or kiosk menu/);
  } finally {
    server.close();
  }
});

test('a kitchen screen reads, wastes and marks sold out, and nothing else', async () => {
  const pool = fakePool({ menu: [{ plu_id: 103, any_on: 1, n: 1 }] });
  const { server, call } = await serve(pool, { kitchen: true });
  try {
    assert.equal((await call('GET', '/kitchen/stock/availability', { token: kitchenToken })).status, 200);
    assert.equal((await call('GET', '/kitchen/stock/availability', { token: terminal })).status, 401, 'a till token is not a kitchen token');
    assert.equal((await call('POST', '/kitchen/stock/sold-out', { token: kitchenToken, body: { pluid: 103, sold_out: true } })).status, 200);
    const waste = await call('POST', '/kitchen/stock/docs', { token: kitchenToken, body: { kind: 'wastage', lines: [{ pluid: 104, quantity: 2, reason: 'Dropped' }] } });
    assert.notEqual(waste.status, 403);
    const insert = pool.asked.find((a) => /INSERT INTO bo_stock_docs/.test(a.q));
    assert.ok(insert && insert.params.includes('Grill'), 'the screen is who the ledger records');
    assert.equal((await call('POST', '/kitchen/stock/docs', { token: kitchenToken, body: { kind: 'stocktake', lines: [] } })).status, 403);
    assert.equal((await call('PATCH', '/kitchen/stock/products/1', { token: kitchenToken, body: { pack_size_id: 2 } })).status, 403);
    assert.equal((await call('PUT', '/kitchen/stock/recipes/103', { token: kitchenToken, body: { lines: [] } })).status, 403);
  } finally {
    server.close();
  }
});
