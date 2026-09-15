/**
 * Stock control and the report catalogue, against the live back office.
 *
 *   cd @app && node tool/verify-stock-live.js
 *
 * Runs ON the server, like verify-gym-live.js: the token is minted from the
 * server's own JWT_SECRET, the calls go through nginx at the public address,
 * and the database is read directly to check what the routes did.
 *
 * The rules, because everything in this database except the test venue
 * belongs to a paying customer:
 *
 *   * manager@vesopa.co.uk only.
 *   * It picks one of that venue's products, remembers its stock row exactly,
 *     and writes it back at the end -- pass or fail.
 *   * Everything it makes -- a supplier, pack sizes, documents, movements, an
 *     order -- is deleted at the end, by id. Completed documents cannot be
 *     deleted through the API (that is the point of them), so this reaches
 *     into the database for its own rows and nothing else.
 *   * It never prints a secret.
 */

require('dotenv').config();

const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');

const OFFICE = 'manager@vesopa.co.uk';
const BASE = process.env.VERIFY_BASE || 'https://backoffice.vesopaepos.com';
const TAG = `verify-${Date.now().toString(36)}`;

let passed = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failures.push(`${name}: ${e.message}`);
    console.error(`  FAIL  ${name}`);
    console.error(`        ${e.message}`);
  }
}
const assert = (c, m) => {
  if (!c) throw new Error(m);
};

async function main() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not set.');
  const token = jwt.sign({ email: OFFICE, name: TAG, role: 'manager' }, secret, { expiresIn: '15m' });
  const call = async (path, { method = 'GET', body } = {}) => {
    const res = await fetch(BASE + '/api' + path, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('json')) return { status: res.status, bytes: (await res.arrayBuffer()).byteLength };
    return { status: res.status, body: await res.json() };
  };

  const db = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER,
    password: process.env.DB_PASS || process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'vesopa_eposdb',
  });

  // ---- Remember what we touch ---------------------------------------------
  const [[product]] = await db.query(
    `SELECT id, pluid, product_name, stock_quantity, cost_price, low_stock_at, supplier_id,
            supplier_code, pack_size_id, pack_cost, min_stock, max_stock, stock_unit
       FROM bo_products WHERE email = ? AND COALESCE(is_modifier, 0) = 0 ORDER BY pluid LIMIT 1`,
    [OFFICE]
  );
  assert(product, 'the test venue has no products');
  const [[packsBefore]] = await db.query('SELECT COUNT(*) AS n FROM bo_pack_sizes WHERE office = ?', [OFFICE]);
  const [[schedBefore]] = await db.query('SELECT COUNT(*) AS n FROM bo_report_schedules WHERE office = ?', [OFFICE]);
  const made = { supplier: null, docs: [], order: null, schedule: null };

  async function restore() {
    await db.execute(
      `UPDATE bo_products SET stock_quantity = ?, cost_price = ?, low_stock_at = ?, supplier_id = ?,
              supplier_code = ?, pack_size_id = ?, pack_cost = ?, min_stock = ?, max_stock = ?, stock_unit = ?
        WHERE id = ? AND email = ?`,
      [product.stock_quantity, product.cost_price, product.low_stock_at, product.supplier_id, product.supplier_code,
        product.pack_size_id, product.pack_cost, product.min_stock, product.max_stock, product.stock_unit, product.id, OFFICE]
    );
    await db.execute('DELETE FROM epos_stock_movements WHERE office = ? AND (staff_name = ? OR doc_id IN (SELECT id FROM bo_stock_docs WHERE office = ? AND staff_name = ?))', [OFFICE, TAG, OFFICE, TAG]);
    await db.execute('DELETE FROM bo_stock_docs WHERE office = ? AND staff_name = ?', [OFFICE, TAG]);
    if (made.order) await db.execute('DELETE FROM bo_purchase_orders WHERE id = ? AND office = ?', [made.order, OFFICE]);
    if (made.schedule) await db.execute('DELETE FROM bo_report_schedules WHERE id = ? AND office = ?', [made.schedule, OFFICE]);
    if (made.supplier) await db.execute('DELETE FROM bo_suppliers WHERE id = ? AND office = ?', [made.supplier, OFFICE]);
    // The pack sizes were seeded by our first read only if the venue had none.
    if (Number(packsBefore.n) === 0) await db.execute('DELETE FROM bo_pack_sizes WHERE office = ?', [OFFICE]);
  }

  try {
    let keg;
    await check('pack sizes read (seeded on first read)', async () => {
      const r = await call('/stock/pack-sizes');
      assert(r.status === 200 && r.body.length >= 1, `status ${r.status}`);
      keg = r.body.find((p) => Number(p.units) > 1) || r.body[0];
    });

    await check('a supplier is made', async () => {
      const r = await call('/stock/suppliers', { method: 'POST', body: { name: `${TAG} Supplies`, email: 'nobody@example.invalid' } });
      assert(r.status === 201, `status ${r.status} ${JSON.stringify(r.body)}`);
      made.supplier = r.body.id;
    });

    await check('stock settings save on a product', async () => {
      const r = await call(`/stock/products/${product.id}/settings`, {
        method: 'PUT',
        body: { supplier_id: made.supplier, pack_size_id: keg.id, pack_cost: 100, min_stock: 5, max_stock: 50 },
      });
      assert(r.status === 200, `status ${r.status} ${JSON.stringify(r.body)}`);
      const list = await call('/stock/products');
      const p = list.body.find((x) => x.pluid === product.pluid);
      assert(p && p.pack_name === keg.name, 'pack not shown');
    });

    await check('a stock take sets the count and writes the ledger', async () => {
      const r = await call('/stock/docs', { method: 'POST', body: { kind: 'stocktake', complete: true, notes: TAG, lines: [{ pluid: product.pluid, quantity: 40 }] } });
      assert(r.status === 201 && r.body.completed, `status ${r.status} ${JSON.stringify(r.body)}`);
      made.docs.push(r.body.id);
      const [[row]] = await db.query('SELECT stock_quantity FROM bo_products WHERE id = ?', [product.id]);
      assert(Number(row.stock_quantity) === 40, `count is ${row.stock_quantity}`);
    });

    await check('a wastage comes off it, once', async () => {
      const r = await call('/stock/docs', { method: 'POST', body: { kind: 'wastage', notes: TAG, lines: [{ pluid: product.pluid, quantity: 3, reason: 'Verify' }] } });
      assert(r.status === 201, `status ${r.status}`);
      made.docs.push(r.body.id);
      const done = await call(`/stock/docs/${r.body.id}/complete`, { method: 'POST' });
      assert(done.status === 200, `complete ${done.status}`);
      const again = await call(`/stock/docs/${r.body.id}/complete`, { method: 'POST' });
      assert(again.status === 409, `second complete answered ${again.status}`);
      const [[row]] = await db.query('SELECT stock_quantity FROM bo_products WHERE id = ?', [product.id]);
      assert(Number(row.stock_quantity) === 37, `count is ${row.stock_quantity}`);
    });

    await check('an order is suggested, raised, sent by phone and delivered', async () => {
      const s = await call(`/stock/orders/suggest?supplier=${made.supplier}`);
      assert(s.status === 200, `suggest ${s.status}`);
      const r = await call('/stock/orders', { method: 'POST', body: { supplier_id: made.supplier, send_method: 'phone', notes: TAG, lines: [{ pluid: product.pluid, packs: 1 }] } });
      assert(r.status === 201, `order ${r.status} ${JSON.stringify(r.body)}`);
      made.order = r.body.id;
      const sent = await call(`/stock/orders/${made.order}/send`, { method: 'POST' });
      assert(sent.status === 200, `send ${sent.status}`);
      const o = await call(`/stock/orders/${made.order}`);
      const d = await call(`/stock/orders/${made.order}/deliver`, { method: 'POST', body: { lines: [{ id: o.body.lines[0].id, packs: 1 }] } });
      assert(d.status === 200 && d.body.order_status === 'delivered', `deliver ${d.status} ${JSON.stringify(d.body)}`);
      const [[row]] = await db.query('SELECT stock_quantity FROM bo_products WHERE id = ?', [product.id]);
      assert(Number(row.stock_quantity) === 37 + Number(keg.units), `count is ${row.stock_quantity}`);
      const pdf = await call(`/stock/orders/${made.order}/pdf`);
      assert(pdf.status === 200 && pdf.bytes > 1000, 'no order pdf');
      // The delivery document was stamped with our name by the route.
      await db.execute('UPDATE bo_stock_docs SET staff_name = ? WHERE order_id = ? AND office = ?', [TAG, made.order, OFFICE]);
    });

    await check('the count sheet is a PDF', async () => {
      const r = await call('/stock/count-sheet.pdf');
      assert(r.status === 200 && r.bytes > 1000, `status ${r.status}`);
    });

    let catalogue;
    await check('the catalogue lists 38 reports in four groups with clerks and departments', async () => {
      const r = await call('/reports/catalogue');
      assert(r.status === 200, `status ${r.status}`);
      catalogue = r.body;
      assert(catalogue.reports.length >= 38, `${catalogue.reports.length} reports`);
      assert(catalogue.groups.length === 4, 'groups');
      assert(Array.isArray(catalogue.clerks) && Array.isArray(catalogue.departments), 'clerks/departments');
    });

    for (const rep of catalogue ? catalogue.reports : []) {
      await check(`report ${rep.key} runs on live`, async () => {
        const r = await call('/reports/run', { method: 'POST', body: { report: rep.key, period: 'last_7_days', filters: { product: String(product.pluid), group_by: 'department' } } });
        assert(r.status === 200, `status ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
        assert(Array.isArray(r.body.sections) && r.body.sections.length, 'no sections');
      });
    }

    await check('stock variance shows the stock take just done', async () => {
      const r = await call('/reports/run', { method: 'POST', body: { report: 'stock_variance', period: 'today' } });
      const row = r.body.sections.flatMap((s) => s.rows).find((x) => x.raw && x.raw.name === product.product_name);
      assert(row, 'no row for the product');
    });

    await check('one report exports as PDF, CSV and XLS', async () => {
      for (const format of ['pdf', 'csv', 'xls']) {
        const r = await call('/reports/export', { method: 'POST', body: { report: 'stock_movements', period: 'last_7_days', format } });
        assert(r.status === 200 && r.bytes > 100, `${format}: status ${r.status}`);
      }
    });

    await check('a schedule keeps its filters', async () => {
      const r = await call('/reports/schedules', {
        method: 'POST',
        body: { name: TAG, report_key: 'product_audit', format: 'pdf', frequency: 'weekly', time: '08:30', period: 'last_week', recipients: 'nobody@example.invalid', active: false, product: String(product.pluid) },
      });
      assert(r.status === 201, `status ${r.status} ${JSON.stringify(r.body)}`);
      made.schedule = r.body.id;
      const list = await call('/reports/schedules');
      const mine = list.body.find((s) => s.id === made.schedule);
      assert(mine && mine.filters && mine.filters.product === String(product.pluid), `filters ${JSON.stringify(mine && mine.filters)}`);
    });

    await check('the loyalty spending report no longer answers 500 on live', async () => {
      const r = await call('/reports/run', { method: 'POST', body: { report: 'loyalty_spending', period: 'last_30_days' } });
      assert(r.status === 200, `status ${r.status}`);
    });
  } finally {
    await restore();
    const [[after]] = await db.query('SELECT stock_quantity FROM bo_products WHERE id = ?', [product.id]);
    const [[left]] = await db.query('SELECT COUNT(*) AS n FROM bo_stock_docs WHERE office = ? AND staff_name = ?', [OFFICE, TAG]);
    const [[sched]] = await db.query('SELECT COUNT(*) AS n FROM bo_report_schedules WHERE office = ?', [OFFICE]);
    console.log(`\n  tidy: stock back to ${after.stock_quantity} (was ${product.stock_quantity}); ${left.n} documents left; schedules ${sched.n} (were ${schedBefore.n})`);
    await db.end();
  }
  console.log(`\nverify-stock-live: ${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
