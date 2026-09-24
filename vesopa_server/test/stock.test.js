/**
 * Stock control, against a real database.
 *
 * Run with `npm test`. Needs a MariaDB on 127.0.0.1 with the structure-only
 * copy of live called vesopa_live_shape (see gift-shop.test.js); skips
 * cleanly when there is none, because the ledger's rules are transactions and
 * row locks and a scripted pool cannot say whether they hold.
 *
 * What is guarded, in order of how much it would cost to get wrong:
 *
 *  1. **A document applies once.** Two Completes, one set of movements. A
 *     stocktake applied twice puts every count out by its own variance and
 *     nobody notices until the valuation is £-373,713 -- which is what the
 *     brief's recording shows.
 *  2. **A stocktake sets; everything else adds.** The line on a stocktake is
 *     what was counted. The line on a wastage is what went.
 *  3. **A sale writes the ledger**, for a tracked product, and leaves an
 *     untracked one alone.
 *  4. **A delivery is in packs and lands in units**, and teaches the product
 *     its pack cost.
 *  5. **Scoped.** A venue sees its own suppliers, packs and documents and
 *     nobody else's -- the join to bo_products carries the office too.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const express = require('express');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');

const { stockRoutes } = require('../src/stock');
const { recordSale } = require('../src/sales');
const { toPdf } = require('../src/reports');

const DB = process.env.STOCK_TEST_DB || 'vesopa_stock_selftest';
const TEMPLATE = process.env.FIVE_TEST_TEMPLATE || 'vesopa_live_shape';
const USER = process.env.EXPRESS_TEST_USER || 'root';
const PASS = process.env.EXPRESS_TEST_PASS || '';
const HOST = process.env.EXPRESS_TEST_HOST || '127.0.0.1';
const SECRET = 'stock-test-secret';

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
    console.error(`        ${e.stack || e.message}`);
    process.exitCode = 1;
  }
}

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

const A = { id: 921, email: 'stock-a@ledger.test', name: 'The Ledger Arms' };
const B = { id: 922, email: 'stock-b@ledger.test', name: 'The Other Cellar' };

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
  for (const file of ['schema_stock.sql', 'schema_till_events.sql']) {
    for (const sql of statementsOf(fs.readFileSync(path.join(dir, file), 'utf8'))) {
      await admin.query(sql);
    }
  }

  // Two venues, three products each, one of them untracked.
  for (const o of [A, B]) {
    await admin.query(
      'INSERT INTO offices (id, name, contact_email) VALUES (?, ?, ?)',
      [o.id, o.name, o.email]
    );
    await admin.query(
      `INSERT INTO bo_products (email, pluid, product_name, department_name, group_name, price, tax_percentage, stock_quantity, cost_price)
       VALUES (?, 1, 'Carling', 'Drink', 'Beers & Ciders', 4.10, 20, 100, 1.64),
              (?, 2, 'Coke Can', 'Drink', 'Soft Drinks', 1.80, 20, 24, 0.40),
              (?, 3, 'Crisps', 'Food', 'Snacks', 1.20, 20, NULL, 0.35)`,
      [o.email, o.email, o.email]
    );
  }

  const pool = mysql.createPool({ host: HOST, user: USER, password: PASS, database: DB, connectionLimit: 6 });
  const app = express();
  app.use(express.json());
  const stock = stockRoutes({ pool, broadcast: () => {}, secret: SECRET, toPdf });
  app.use('/api', stock);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;

  const tokenFor = (o) => jwt.sign({ sub: 0, email: o.email, name: 'Tester', role: 'manager', officeId: o.id }, SECRET);
  const call = async (method, url, body, o = A) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenFor(o)}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const ct = res.headers.get('content-type') || '';
    return { status: res.status, body: ct.includes('json') ? await res.json() : await res.arrayBuffer() };
  };
  const stockOf = async (pluid, o = A) => {
    const [[r]] = await pool.query('SELECT stock_quantity FROM bo_products WHERE email = ? AND pluid = ?', [o.email, pluid]);
    return r.stock_quantity;
  };
  const movements = async (pluid, o = A) => {
    const [rows] = await pool.query(
      'SELECT kind, quantity, unit_cost_minor FROM epos_stock_movements WHERE office = ? AND pluid = ? ORDER BY created_at, moved_at',
      [o.email, pluid]
    );
    return rows;
  };

  try {
    await check('pack sizes are seeded on first read, per venue', async () => {
      const r = await call('GET', '/stock/pack-sizes');
      assert.strictEqual(r.status, 200);
      assert.ok(r.body.some((p) => p.name === '11g Keg' && Number(p.units) === 88));
      const other = await call('GET', '/stock/pack-sizes', undefined, B);
      assert.strictEqual(other.body.length, r.body.length);
      assert.notStrictEqual(other.body[0].id, r.body[0].id);
    });

    let supplierId;
    await check('a supplier is made, listed, and invisible to the other venue', async () => {
      const made = await call('POST', '/stock/suppliers', { name: 'Bookers', email: 'orders@bookers.test' });
      assert.strictEqual(made.status, 201);
      supplierId = made.body.id;
      const list = await call('GET', '/stock/suppliers');
      assert.strictEqual(list.body.length, 1);
      const theirs = await call('GET', '/stock/suppliers', undefined, B);
      assert.strictEqual(theirs.body.length, 0);
      const dup = await call('POST', '/stock/suppliers', { name: 'Bookers' });
      assert.strictEqual(dup.status, 409);
    });

    let kegId;
    await check('stock settings: a pack cost sets the unit cost, and min stock the low mark', async () => {
      const packs = (await call('GET', '/stock/pack-sizes')).body;
      kegId = packs.find((p) => p.name === '11g Keg').id;
      const [[carling]] = await pool.query('SELECT id FROM bo_products WHERE email = ? AND pluid = 1', [A.email]);
      const r = await call('PUT', `/stock/products/${carling.id}/settings`, {
        supplier_id: supplierId, supplier_code: 'CARL-11', pack_size_id: kegId,
        pack_cost: 132.0, min_stock: 44, max_stock: 264,
      });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      const list = (await call('GET', '/stock/products')).body;
      const c = list.find((p) => p.pluid === 1);
      assert.strictEqual(c.unit_cost_minor, 150);
      assert.strictEqual(Number(c.low_stock_at), 44);
      assert.strictEqual(c.pack_name, '11g Keg');
      assert.strictEqual(c.stock_display, '100 (1.14 11g Keg)');
      assert.strictEqual(c.level, 'ok');
      assert.strictEqual(list.find((p) => p.pluid === 3).level, 'untracked');
      // The other venue's Carling knows nothing of this.
      const theirs = (await call('GET', '/stock/products', undefined, B)).body.find((p) => p.pluid === 1);
      assert.strictEqual(theirs.pack_name, null);
    });

    await check('a sale writes the ledger for a tracked product and not an untracked one', async () => {
      const conn = await pool.getConnection();
      await conn.beginTransaction();
      const r = await recordSale(conn, {
        id: '11111111-1111-4111-8111-111111111111', email: A.email, closed_at: '2026-09-14T12:00:00Z',
        clerk_name: 'Sarah', terminal: 'Bar 1', total_minor: 530,
        lines: [
          { plu_id: 1, name: 'Carling', quantity: 2, unit_price_minor: 410, tax_percentage: 20 },
          { plu_id: 3, name: 'Crisps', quantity: 1, unit_price_minor: 120, tax_percentage: 20 },
        ],
        payments: [{ method: 'card', amount_minor: 940, cashback_minor: 2000 }],
      });
      await conn.commit();
      conn.release();
      assert.strictEqual(r.duplicate, false);
      assert.strictEqual(Number(await stockOf(1)), 98);
      const m = await movements(1);
      assert.strictEqual(m.length, 1);
      assert.strictEqual(m[0].kind, 'sale');
      assert.strictEqual(Number(m[0].quantity), -2);
      assert.strictEqual(m[0].unit_cost_minor, 150);
      assert.strictEqual((await movements(3)).length, 0);
      const [[pay]] = await pool.query('SELECT cashback_minor FROM epos_payments WHERE order_id = ?', ['11111111-1111-4111-8111-111111111111']);
      assert.strictEqual(pay.cashback_minor, 2000);
    });

    await check('a retried sale moves nothing twice', async () => {
      const conn = await pool.getConnection();
      await conn.beginTransaction();
      const r = await recordSale(conn, {
        id: '11111111-1111-4111-8111-111111111111', email: A.email,
        lines: [{ plu_id: 1, name: 'Carling', quantity: 2, unit_price_minor: 410 }],
        payments: [],
      });
      await conn.rollback();
      conn.release();
      assert.strictEqual(r.duplicate, true);
      assert.strictEqual(Number(await stockOf(1)), 98);
      assert.strictEqual((await movements(1)).length, 1);
    });

    let wastageId;
    await check('a wastage draft is saved, then completed: minus the quantity, once', async () => {
      const made = await call('POST', '/stock/docs', {
        kind: 'wastage', notes: 'Dropped a tray',
        lines: [{ pluid: 2, quantity: 3, reason: 'Dropped' }],
      });
      assert.strictEqual(made.status, 201, JSON.stringify(made.body));
      wastageId = made.body.id;
      assert.strictEqual(Number(await stockOf(2)), 24, 'a draft moves nothing');
      const done = await call('POST', `/stock/docs/${wastageId}/complete`);
      assert.strictEqual(done.status, 200, JSON.stringify(done.body));
      assert.strictEqual(Number(await stockOf(2)), 21);
      const m = await movements(2);
      assert.strictEqual(m.length, 1);
      assert.strictEqual(m[0].kind, 'wastage');
      assert.strictEqual(Number(m[0].quantity), -3);
      assert.strictEqual(m[0].unit_cost_minor, 40);
      const again = await call('POST', `/stock/docs/${wastageId}/complete`);
      assert.strictEqual(again.status, 409);
      assert.strictEqual(Number(await stockOf(2)), 21, 'a second Complete changed nothing');
      const edit = await call('PUT', `/stock/docs/${wastageId}`, { lines: [{ pluid: 2, quantity: 9 }] });
      assert.strictEqual(edit.status, 409);
      const del = await call('DELETE', `/stock/docs/${wastageId}`);
      assert.strictEqual(del.status, 409);
    });

    await check('a wastage cannot be negative; an adjustment can', async () => {
      const bad = await call('POST', '/stock/docs', { kind: 'wastage', lines: [{ pluid: 2, quantity: -1 }] });
      assert.strictEqual(bad.status, 400);
      const adj = await call('POST', '/stock/docs', {
        kind: 'adjustment', complete: true, lines: [{ pluid: 2, quantity: -1, reason: 'Breakage found' }],
      });
      assert.strictEqual(adj.status, 201, JSON.stringify(adj.body));
      assert.strictEqual(adj.body.completed, true);
      assert.strictEqual(Number(await stockOf(2)), 20);
    });

    await check('a stocktake SETS the count, records what was expected, and starts tracking a new product', async () => {
      const r = await call('POST', '/stock/docs', {
        kind: 'stocktake', complete: true,
        lines: [{ pluid: 1, quantity: 90 }, { pluid: 2, quantity: 20 }, { pluid: 3, quantity: 12 }],
      });
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      assert.strictEqual(Number(await stockOf(1)), 90);
      assert.strictEqual(Number(await stockOf(2)), 20);
      assert.strictEqual(Number(await stockOf(3)), 12);
      const doc = (await call('GET', `/stock/docs/${r.body.id}`)).body;
      const carling = doc.lines.find((l) => l.pluid === 1);
      assert.strictEqual(Number(carling.expected), 98);
      assert.strictEqual(Number(carling.quantity), 90);
      const m1 = await movements(1);
      assert.strictEqual(m1[m1.length - 1].kind, 'stocktake');
      assert.strictEqual(Number(m1[m1.length - 1].quantity), -8);
      // Counted exactly what was there: no movement written.
      assert.strictEqual((await movements(2)).filter((m) => m.kind === 'stocktake').length, 0);
      // Never tracked before: expected 0, movement +12.
      const m3 = await movements(3);
      assert.strictEqual(m3.length, 1);
      assert.strictEqual(Number(m3[0].quantity), 12);
    });

    await check('documents are listed with their value, and scoped', async () => {
      const list = (await call('GET', '/stock/docs?kind=wastage')).body;
      assert.strictEqual(list.length, 1);
      assert.strictEqual(list[0].status, 'completed');
      assert.strictEqual(Number(list[0].line_count), 1);
      assert.strictEqual(Number(list[0].value_minor), 120);
      const theirs = (await call('GET', '/stock/docs', undefined, B)).body;
      assert.strictEqual(theirs.length, 0);
      const peek = await call('GET', `/stock/docs/${wastageId}`, undefined, B);
      assert.strictEqual(peek.status, 404);
    });

    let orderId;
    await check('a suggested order brings a low product back to its maximum, in whole packs', async () => {
      // Carling is at 90 with a min of 44: not low. Take it below.
      await call('POST', '/stock/docs', { kind: 'stocktake', complete: true, lines: [{ pluid: 1, quantity: 30 }] });
      const s = (await call('GET', `/stock/orders/suggest?supplier=${supplierId}`)).body;
      assert.strictEqual(s.length, 1);
      assert.strictEqual(s[0].pluid, 1);
      assert.strictEqual(s[0].short_units, 234);
      assert.strictEqual(s[0].packs, 3);
    });

    await check('an order is made in packs at the pack price', async () => {
      const r = await call('POST', '/stock/orders', {
        supplier_id: supplierId, send_method: 'phone', notes: 'Weekly',
        lines: [{ pluid: 1, packs: 3 }],
      });
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      orderId = r.body.id;
      const o = (await call('GET', `/stock/orders/${orderId}`)).body;
      assert.strictEqual(o.status, 'new');
      assert.strictEqual(o.supplier_name, 'Bookers');
      assert.strictEqual(o.total_minor, 39600);
      assert.strictEqual(o.lines[0].pack_name, '11g Keg');
      assert.strictEqual(Number(o.lines[0].pack_units), 88);
      const pdf = await call('GET', `/stock/orders/${orderId}/pdf`);
      assert.strictEqual(pdf.status, 200);
      assert.ok(pdf.body.byteLength > 1000);
    });

    await check('sending by phone marks it sent; sending by email with no address is refused', async () => {
      const sent = await call('POST', `/stock/orders/${orderId}/send`);
      assert.strictEqual(sent.status, 200);
      assert.strictEqual((await call('GET', `/stock/orders/${orderId}`)).body.status, 'sent');
      const mail = await call('POST', '/stock/orders', { supplier_name: 'Nobody', send_method: 'email', lines: [{ pluid: 2, packs: 1 }] });
      const refused = await call('POST', `/stock/orders/${mail.body.id}/send`);
      assert.strictEqual(refused.status, 400);
    });

    await check('a part delivery lands in units, teaches the pack cost, and leaves the rest outstanding', async () => {
      const o = (await call('GET', `/stock/orders/${orderId}`)).body;
      const r = await call('POST', `/stock/orders/${orderId}/deliver`, { lines: [{ id: o.lines[0].id, packs: 2 }] });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.strictEqual(r.body.order_status, 'part_delivered');
      assert.strictEqual(Number(await stockOf(1)), 30 + 176);
      const deliveries = (await movements(1)).filter((x) => x.kind === 'delivery');
      assert.strictEqual(deliveries.length, 1);
      assert.strictEqual(Number(deliveries[0].quantity), 176);
      assert.strictEqual(deliveries[0].unit_cost_minor, 150);
      const rest = await call('POST', `/stock/orders/${orderId}/deliver`, { lines: [{ id: o.lines[0].id, packs: 1 }] });
      assert.strictEqual(rest.body.order_status, 'delivered');
      assert.strictEqual(Number(await stockOf(1)), 30 + 264);
      const closed = await call('POST', `/stock/orders/${orderId}/deliver`, { lines: [{ id: o.lines[0].id, packs: 1 }] });
      assert.strictEqual(closed.status, 409);
      const docs = (await call('GET', '/stock/docs?kind=delivery')).body;
      assert.strictEqual(docs.length, 2);
      assert.strictEqual(docs[0].order_id, orderId);
    });

    await check('a wastage rung on the till is a completed document, and its retry is a no-op', async () => {
      const id = '22222222-2222-4222-8222-222222222222';
      const first = await stock.wastageFromTill(A.email, { id, plu_id: 2, quantity: 2, reason: 'Flat', staff_name: 'Tom', terminal: 'Bar 1' });
      assert.strictEqual(first.completed, true);
      assert.strictEqual(Number(await stockOf(2)), 18);
      const again = await stock.wastageFromTill(A.email, { id, plu_id: 2, quantity: 2, reason: 'Flat' });
      assert.strictEqual(again.duplicate, true);
      assert.strictEqual(Number(await stockOf(2)), 18);
      const [[doc]] = await pool.query('SELECT terminal, status FROM bo_stock_docs WHERE id = ?', [id]);
      assert.strictEqual(doc.terminal, 'Bar 1');
      assert.strictEqual(doc.status, 'completed');
    });

    await check('the count sheet is a PDF of tracked products', async () => {
      const r = await call('GET', '/stock/count-sheet.pdf');
      assert.strictEqual(r.status, 200);
      assert.ok(r.body.byteLength > 1000);
    });

    await check('a pack size in use cannot be deleted; an unused one can', async () => {
      const used = await call('DELETE', `/stock/pack-sizes/${kegId}`);
      assert.strictEqual(used.status, 409);
      const packs = (await call('GET', '/stock/pack-sizes')).body;
      const spare = packs.find((p) => p.name === 'Pack of 6');
      const gone = await call('DELETE', `/stock/pack-sizes/${spare.id}`);
      assert.strictEqual(gone.status, 200);
      const cross = await call('DELETE', `/stock/pack-sizes/${kegId}`, undefined, B);
      assert.strictEqual(cross.status, 404);
    });

    await check('a supplier with orders is kept; the other venue cannot touch it', async () => {
      const r = await call('DELETE', `/stock/suppliers/${supplierId}`);
      assert.strictEqual(r.status, 409);
      const cross = await call('PUT', `/stock/suppliers/${supplierId}`, { name: 'Hijacked' }, B);
      assert.strictEqual(cross.status, 404);
      const [[s]] = await pool.query('SELECT name FROM bo_suppliers WHERE id = ?', [supplierId]);
      assert.strictEqual(s.name, 'Bookers');
    });
  } finally {
    server.close();
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin.end();
  }

  console.log(`\nstock: ${passed}/${passed + failed} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
