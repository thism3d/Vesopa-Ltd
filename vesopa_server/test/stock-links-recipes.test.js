/**
 * Stock fixes and features of 2026-09-22.
 *
 *     node test/stock-links-recipes.test.js
 *
 *   - what a sale or wastage takes off: recipes, linked products, plain ones
 *   - the GP calculator's sums
 *   - a sale of a cocktail writes its ingredients' movements (recordSale)
 *   - the stock screen's product box finds what staff actually type
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { stockTargets } = require('../src/stock_effects');
const { gpFigures } = require('../src/stock');

// ---- a pretend venue --------------------------------------------------------

const PRODUCTS = {
  100: { product_name: 'Guinness Pint' },
  101: { product_name: 'Guinness Half', stock_parent_pluid: 100, stock_ratio: 0.5 },
  200: { product_name: 'House Red 75cl' },
  201: { product_name: 'House Red 175ml', stock_parent_pluid: 200, stock_ratio: 0.2333 },
  300: { product_name: 'Aperol' },
  301: { product_name: 'Prosecco' },
  302: { product_name: 'Soda' },
  310: { product_name: 'Aperol Spritz' },
  320: { product_name: 'Spritz Jug' },
  400: { product_name: 'Ouroboros' },
};
const RECIPES = {
  310: [{ ingredient_pluid: 300, quantity: 2 }, { ingredient_pluid: 301, quantity: 3 }, { ingredient_pluid: 302, quantity: 1 }],
  320: [{ ingredient_pluid: 310, quantity: 4 }],     // a jug is four spritzes
  400: [{ ingredient_pluid: 400, quantity: 1 }],     // names itself
};

function fakeConn(products = PRODUCTS, recipes = RECIPES) {
  return {
    async query(sql, params) {
      if (/FROM bo_recipe_lines/.test(sql)) return [recipes[params[1]] || []];
      if (/FROM bo_products/.test(sql)) {
        const p = products[params[1]];
        return [p ? [{ stock_parent_pluid: null, stock_ratio: null, ...p }] : []];
      }
      throw new Error(`unexpected: ${sql}`);
    },
  };
}
const plain = (targets) => targets.map((t) => [t.pluid, Number(t.qty.toFixed(4)), t.via]);

test('a plain product takes itself off', async () => {
  assert.deepEqual(plain(await stockTargets(fakeConn(), 'v', 100, 2)), [[100, 2, null]]);
});

test('three half pints are 1.5 pints off the pint', async () => {
  assert.deepEqual(plain(await stockTargets(fakeConn(), 'v', 101, 3)), [[100, 1.5, 'Guinness Half']]);
});

test('a 175ml glass comes off the bottle', async () => {
  assert.deepEqual(plain(await stockTargets(fakeConn(), 'v', 201, 3)), [[200, 0.6999, 'House Red 175ml']]);
});

test('two spritzes take each ingredient by its measure', async () => {
  assert.deepEqual(plain(await stockTargets(fakeConn(), 'v', 310, 2)), [
    [300, 4, 'Aperol Spritz'], [301, 6, 'Aperol Spritz'], [302, 2, 'Aperol Spritz'],
  ]);
});

test('a recipe of a recipe resolves all the way down, named by what was sold', async () => {
  assert.deepEqual(plain(await stockTargets(fakeConn(), 'v', 320, 1)), [
    [300, 8, 'Spritz Jug'], [301, 12, 'Spritz Jug'], [302, 4, 'Spritz Jug'],
  ]);
});

test('a recipe that names itself stops instead of looping', async () => {
  const out = await stockTargets(fakeConn(), 'v', 400, 1);
  assert.equal(out.length, 1);
  assert.equal(out[0].pluid, 400);
});

test('a negative adjustment of a linked product is negative on the parent', async () => {
  assert.deepEqual(plain(await stockTargets(fakeConn(), 'v', 101, -4)), [[100, -2, 'Guinness Half']]);
});

// ---- GP calculator ------------------------------------------------------------

test('GP is worked without VAT, and the recommendation hits the target, rounded up to 5p', () => {
  // A pint: costs £1.50, sells at £5.00 with 20% VAT. Net £4.1667.
  const g = gpFigures(5, 20, 150, 70);
  assert.equal(g.has_cost, true);
  assert.equal(g.current_gp, 64); // (416.67 - 150) / 416.67
  // 150 / 0.3 * 1.2 = 600 -> £6.00
  assert.equal(g.recommended_price_minor, 600);
});

test('the recommendation rounds UP, never quietly missing the target', () => {
  const g = gpFigures(0, 20, 101, 70); // 101 / .3 * 1.2 = 404 -> 405
  assert.equal(g.recommended_price_minor, 405);
});

test('no cost, no GP — rather than a meaningless 100%', () => {
  assert.deepEqual(gpFigures(5, 20, 0, 70), { has_cost: false, target_gp: 70 });
});

test('a blank target uses 70%', () => {
  assert.equal(gpFigures(5, 20, 150, null).target_gp, 70);
});

// ---- a sale of a cocktail -----------------------------------------------------

test('recordSale takes a cocktail’s ingredients off and writes their ledger rows', async () => {
  const { recordSale } = require('../src/sales');
  const stock = { 300: 70, 301: 100, 302: null, 310: null }; // soda is not counted
  const moved = [];
  const conn = {
    async execute(sql, params) {
      if (/INSERT IGNORE INTO epos_orders/.test(sql)) return [{ affectedRows: 1 }];
      if (/INSERT INTO epos_order_lines/.test(sql)) return [{}];
      if (/UPDATE bo_products\s+SET stock_quantity = stock_quantity - \?/.test(sql)) {
        stock[params[2]] -= params[0];
        return [{}];
      }
      if (/INSERT INTO epos_stock_movements/.test(sql)) { moved.push({ pluid: params[1], qty: params[3], reason: params[5] }); return [{}]; }
      if (/INSERT INTO epos_payments/.test(sql)) return [{}];
      return [{}];
    },
    async query(sql, params) {
      if (/FROM bo_recipe_lines/.test(sql)) return [RECIPES[params[1]] || []];
      if (/SELECT stock_quantity, cost_price, product_name/.test(sql)) {
        const plu = params[1];
        return [[{ stock_quantity: stock[plu] ?? null, cost_price: 1, product_name: PRODUCTS[plu]?.product_name }]];
      }
      if (/FROM bo_products/.test(sql)) return [[{ stock_parent_pluid: null, stock_ratio: null, ...PRODUCTS[params[1]] }]];
      return [[]];
    },
  };
  const res = await recordSale(conn, {
    id: 'o1', email: 'v', lines: [{ plu_id: 310, name: 'Aperol Spritz', quantity: 2, unit_price_minor: 850 }], payments: [],
  });
  assert.equal(res.duplicate, false);
  assert.equal(stock[300], 66);  // 70 - 2x2
  assert.equal(stock[301], 94);  // 100 - 2x3
  assert.equal(stock[302], null); // not counted, left alone
  assert.deepEqual(moved.map((m) => [m.pluid, m.qty]), [[300, -4], [301, -6]]);
  assert.match(moved[0].reason, /Sold as Aperol Spritz/);
});

test('a sale never fails because stock resolution did — it falls back to the product', async () => {
  const { recordSale } = require('../src/sales');
  const moved = [];
  const conn = {
    async execute(sql, params) {
      if (/INSERT IGNORE INTO epos_orders/.test(sql)) return [{ affectedRows: 1 }];
      if (/INSERT INTO epos_stock_movements/.test(sql)) moved.push(params[1]);
      return [{}];
    },
    async query(sql) {
      if (/FROM bo_recipe_lines/.test(sql)) { const e = new Error("Table 'bo_recipe_lines' doesn't exist"); e.code = 'ER_NO_SUCH_TABLE'; throw e; }
      if (/SELECT stock_quantity, cost_price, product_name/.test(sql)) return [[{ stock_quantity: 10, cost_price: 1, product_name: 'Guinness Pint' }]];
      return [[]];
    },
  };
  const warn = console.warn; console.warn = () => {};
  try {
    const res = await recordSale(conn, { id: 'o2', email: 'v', lines: [{ plu_id: 100, name: 'Guinness Pint', quantity: 1, unit_price_minor: 500 }], payments: [] });
    assert.equal(res.duplicate, false);
  } finally { console.warn = warn; }
  assert.deepEqual(moved, [100]);
});

// ---- the stock screen's product box -------------------------------------------

function loadStockScreen(products) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'stock.js'), 'utf8');
  const ctx = vm.createContext({
    document: { addEventListener() {}, querySelectorAll: () => [], head: { appendChild() {} } },
    console, setTimeout,
  });
  vm.runInContext(src, ctx);
  vm.runInContext(`skProducts = ${JSON.stringify(products)};`, ctx);
  return (code) => vm.runInContext(code, ctx);
}

const CATALOGUE = [
  { pluid: 125, product_name: 'Guinness Pint', department_name: 'Bar', group_name: 'Draught', barcode: '5000213', stock_item: true },
  { pluid: 126, product_name: 'Guinness Half', department_name: 'Bar', group_name: 'Draught', stock_item: false },
  { pluid: 130, product_name: 'Carling Pint', department_name: 'Bar', group_name: 'Draught', stock_item: true },
  { pluid: 167, product_name: 'Fanta', department_name: 'Starters', group_name: 'Soft Drinks', stock_item: true },
];

test('the product box finds what staff type — the "products won\'t add" bug', () => {
  const run = loadStockScreen(CATALOGUE);
  const plus = (typed) => JSON.parse(run(`JSON.stringify(skResolve(${JSON.stringify(typed)}).map((p) => p.pluid))`));
  assert.deepEqual(plus('guinness'), [125, 126], 'part of a name, any case');
  assert.deepEqual(plus('Guinness Pint'), [125], 'exact name wins outright');
  assert.deepEqual(plus('125'), [125], 'a PLU');
  assert.deepEqual(plus('5000213'), [125], 'a barcode');
  assert.deepEqual(plus('pint'), [125, 130], 'one word, several products');
  assert.deepEqual(plus('guin half'), [126], 'every word must be in it');
  assert.deepEqual(plus('Guinness Pint — PLU 125'), [125], 'the old suggestion text still works');
  assert.deepEqual(plus('zzz'), []);
});
