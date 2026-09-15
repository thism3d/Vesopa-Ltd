/**
 * Every report in the catalogue, against a real database.
 *
 * reports.test.js proves the shape, the windows and the exporters with a
 * scripted pool. This proves the SQL: that all thirty-eight builders run on
 * live's schema, that they run on a venue with nothing in it, and that the
 * ones which are different views of the same money agree with each other.
 * Skips cleanly without a MariaDB and the vesopa_live_shape template.
 *
 * The reconciliation checks are the point. Department Sales, Sub Department
 * Sales, the Tax Report, Sales by Table Location and the products table of
 * Product Sales by Time are five groupings of one set of sale lines, and the
 * Financial Summary's department table is a sixth. If any two disagree the
 * report is wrong and somebody's books are wrong with it.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const mysql = require('mysql2/promise');

const { REPORTS, GROUPS, runReport, reportHeader, toCsv, toXlsx, toPdf } = require('../src/reports');

const DB = process.env.REPORTS_TEST_DB || 'vesopa_reports_selftest';
const TEMPLATE = process.env.FIVE_TEST_TEMPLATE || 'vesopa_live_shape';
const USER = process.env.EXPRESS_TEST_USER || 'root';
const PASS = process.env.EXPRESS_TEST_PASS || '';
const HOST = process.env.EXPRESS_TEST_HOST || '127.0.0.1';

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

const A = { id: 931, email: 'reports-a@catalogue.test', name: 'The Reporting Arms' };
const EMPTY = { id: 932, email: 'reports-empty@catalogue.test', name: 'The Empty Bar' };

// Trading week: Monday 7 September 2026 to Sunday 13th. The reports are asked
// for that week, so the seeded sales sit inside it and nothing else does.
const WEEK_FROM = '2026-09-07';
const WEEK_TO = '2026-09-13';
const at = (day, hh, mm = 0) => `2026-09-${String(day).padStart(2, '0')} ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00`;

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
  for (const file of ['schema_stock.sql', 'schema_till_events.sql', 'schema_reports.sql']) {
    for (const sql of statementsOf(fs.readFileSync(path.join(dir, file), 'utf8'))) {
      await admin.query(sql);
    }
  }

  // ---- The venue ----------------------------------------------------------
  for (const o of [A, EMPTY]) {
    await admin.query('INSERT INTO offices (id, name, contact_email) VALUES (?, ?, ?)', [o.id, o.name, o.email]);
  }
  await admin.query('INSERT INTO floor_rooms (id, office_id, name) VALUES (7001, ?, ?), (7002, ?, ?)', [A.id, 'Lounge', A.id, 'Bar']);
  await admin.query(
    `INSERT INTO bo_products (email, pluid, product_name, department_name, group_name, price, tax_percentage, stock_quantity, cost_price)
     VALUES (?, 1, 'Carling', 'Drink', 'Beers & Ciders', 4.10, 20, 100, 1.64),
            (?, 2, 'Coke Can', 'Drink', 'Soft Drinks', 1.80, 20, 24, 0.40),
            (?, 3, 'Crisps', 'Food', 'Snacks', 1.20, 0, NULL, 0.35),
            (?, 4, 'Burger', 'Food', 'Lunch', 9.50, 20, NULL, 3.10)`,
    [A.email, A.email, A.email, A.email]
  );
  await admin.query(
    `INSERT INTO bo_clarks (id, email, pluid, clark_name, pin_code, hourly_rate)
     VALUES (8001, ?, 1, 'Sarah', '1111', 12.50), (8002, ?, 2, 'Tom', '2222', NULL)`,
    [A.email, A.email]
  );

  // Six sales across the week: two clerks, two rooms, two tills, three
  // methods, a discount, a gratuity, a customer, cashback.
  const sales = [
    { id: 'o1', day: 7, hh: 12, clerk: 'Sarah', term: 'Bar 1', room: 7001, covers: 2, lines: [[1, 2, 410], [4, 1, 950]], pay: [['card', 1870]], grat: 100 },
    { id: 'o2', day: 8, hh: 19, clerk: 'Tom', term: 'Bar 2', room: 7002, covers: 0, lines: [[1, 3, 410]], pay: [['cash', 1230]] },
    { id: 'o3', day: 9, hh: 13, clerk: 'Sarah', term: 'Bar 1', room: 7001, covers: 1, lines: [[2, 2, 180, 60]], pay: [['card', 300]], cashback: 2000 },
    { id: 'o4', day: 11, hh: 21, clerk: 'Tom', term: 'Bar 2', room: null, covers: 0, lines: [[3, 4, 120]], pay: [['cash', 480]], customer: 'Priya' },
    { id: 'o5', day: 12, hh: 14, clerk: 'Sarah', term: 'Bar 1', room: 7001, covers: 4, lines: [[4, 2, 950], [1, 2, 410]], pay: [['card', 2000], ['voucher', 720]] },
    { id: 'o6', day: 13, hh: 10, clerk: 'Tom', term: 'Bar 2', room: 7002, covers: 0, lines: [[2, 1, 180]], pay: [['cash', 180]] },
  ];
  const ids = {};
  let expectedGross = 0;
  for (const s of sales) {
    const id = `00000000-0000-4000-8000-0000000000${s.id.slice(1)}`.slice(0, 36).padEnd(36, '0');
    ids[s.id] = id;
    let total = 0;
    for (const [, qty, price, disc = 0] of s.lines) total += qty * price - disc;
    expectedGross += total;
    await admin.query(
      `INSERT INTO epos_orders (id, email, clerk_name, terminal, room_id, covers, subtotal_minor, discount_minor, total_minor,
                                closed_at, gratuity_minor, customer_id, customer_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, A.email, s.clerk, s.term, s.room, s.covers, total, s.lines.reduce((a, l) => a + (l[3] || 0), 0), total + (s.grat || 0),
        at(s.day, s.hh), s.grat || 0, s.customer ? 'cust-1' : null, s.customer || null]
    );
    for (const [plu, qty, price, disc = 0] of s.lines) {
      const [[p]] = await admin.query('SELECT product_name, tax_percentage FROM bo_products WHERE email = ? AND pluid = ?', [A.email, plu]);
      await admin.query(
        `INSERT INTO epos_order_lines (id, order_id, plu_id, name, quantity, unit_price_minor, tax_percentage, discount_minor)
         VALUES (UUID(), ?, ?, ?, ?, ?, ?, ?)`,
        [id, plu, p.product_name, qty, price, p.tax_percentage, disc]
      );
    }
    for (const [method, amount] of s.pay) {
      await admin.query(
        `INSERT INTO epos_payments (id, order_id, method, amount_minor, gratuity_minor, cashback_minor)
         VALUES (UUID(), ?, ?, ?, ?, ?)`,
        [id, method, amount, method === 'card' ? s.grat || 0 : 0, s.cashback || 0]
      );
    }
  }

  // Till events, stock movements, a stocktake, an order, a shift, a gift card.
  await admin.query(
    `INSERT INTO epos_till_events (id, office, kind, amount_minor, note, reason, staff_name, terminal, at)
     VALUES (UUID(), ?, 'refund', 410, 'Carling, flat', 'Customer complaint', 'Sarah', 'Bar 1', ?),
            (UUID(), ?, 'expense', 3000, 'Window cleaner', 'Sundries', 'Tom', 'Bar 2', ?),
            (UUID(), ?, 'no_sale', 0, NULL, 'Change', 'Tom', 'Bar 2', ?)`,
    [A.email, at(8, 20), A.email, at(10, 11), A.email, at(10, 12)]
  );
  await admin.query(
    `INSERT INTO epos_stock_movements (id, office, pluid, product_name, kind, quantity, unit_cost_minor, reason, staff_name, moved_at)
     VALUES (UUID(), ?, 1, 'Carling', 'sale', -7, 164, NULL, 'Sarah', ?),
            (UUID(), ?, 1, 'Carling', 'wastage', -2, 164, 'Spilled', 'Tom', ?),
            (UUID(), ?, 1, 'Carling', 'delivery', 88, 150, '1 × 11g Keg', 'Sarah', ?),
            (UUID(), ?, 2, 'Coke Can', 'sale', -3, 40, NULL, 'Sarah', ?),
            (UUID(), ?, 2, 'Coke Can', 'adjustment', 5, 40, 'Found a box', 'Sarah', ?)`,
    [A.email, at(12, 14), A.email, at(9, 22), A.email, at(10, 9), A.email, at(9, 13), A.email, at(11, 9)]
  );
  await admin.query(
    `INSERT INTO bo_stock_docs (id, office, kind, status, notes, staff_name, completed_at)
     VALUES ('d0000000-0000-4000-8000-000000000001', ?, 'stocktake', 'completed', 'Sunday count', 'Sarah', ?)`,
    [A.email, at(13, 23)]
  );
  await admin.query(
    `INSERT INTO bo_stock_doc_lines (id, doc_id, pluid, product_name, expected, quantity, unit_cost_minor)
     VALUES (UUID(), 'd0000000-0000-4000-8000-000000000001', 1, 'Carling', 104, 100, 150),
            (UUID(), 'd0000000-0000-4000-8000-000000000001', 2, 'Coke Can', 26, 24, 40)`
  );
  await admin.query(
    `INSERT INTO bo_suppliers (id, office, name) VALUES (9001, ?, 'Bookers')`, [A.email]
  );
  await admin.query(
    `INSERT INTO bo_purchase_orders (id, office, supplier_id, supplier_name, status, total_minor, created_at, delivered_at)
     VALUES ('a0000000-0000-4000-8000-000000000001', ?, 9001, 'Bookers', 'delivered', 13200, ?, ?)`,
    [A.email, at(9, 10), at(10, 9)]
  );
  await admin.query(
    `INSERT INTO bo_purchase_order_lines (id, order_id, pluid, product_name, pack_name, pack_units, pack_cost_minor, packs_ordered, packs_delivered)
     VALUES (UUID(), 'a0000000-0000-4000-8000-000000000001', 1, 'Carling', '11g Keg', 88, 13200, 1, 1)`
  );
  await admin.query(
    `INSERT INTO epos_time_clock (office, staff_id, staff_name, clocked_in_at, clocked_out_at, in_terminal)
     VALUES (?, 8001, 'Sarah', ?, ?, 'Bar 1'), (?, 8002, 'Tom', ?, ?, 'Bar 2')`,
    [A.email, at(7, 10), at(7, 18), A.email, at(8, 17), at(8, 23, 30)]
  );
  await admin.query(
    `INSERT INTO epos_gift_cards (id, office, code, initial_minor, balance_minor, status, created_at)
     VALUES ('c0000000-0000-4000-8000-000000000001', ?, 'GIFT-1', 5000, 3000, 'active', ?)`,
    [A.email, at(7, 11)]
  );
  await admin.query(
    `INSERT INTO epos_gift_card_txns (id, gift_card_id, office, kind, amount_minor, balance_after, clerk_name, created_at)
     VALUES (UUID(), 'c0000000-0000-4000-8000-000000000001', ?, 'issue', 5000, 5000, 'Sarah', ?),
            (UUID(), 'c0000000-0000-4000-8000-000000000001', ?, 'redeem', -2000, 3000, 'Tom', ?)`,
    [A.email, at(7, 11), A.email, at(12, 15)]
  );

  const pool = mysql.createPool({ host: HOST, user: USER, password: PASS, database: DB, connectionLimit: 4 });
  const run = (report, office = A, extra = {}) =>
    runReport({
      pool,
      office: office.email,
      siteName: office.name,
      report,
      period: 'custom',
      from: WEEK_FROM,
      to: WEEK_TO,
      ...extra,
    });
  const total = (report, sectionIndex, key) => Number(report.sections[sectionIndex].total[key]);
  const sumRows = (report, sectionIndex, key) => report.sections[sectionIndex].rows.reduce((a, r) => a + (Number(r[key]) || 0), 0);

  try {
    await check('every report belongs to a group and names only known filters', () => {
      for (const [key, def] of Object.entries(REPORTS)) {
        assert.ok(GROUPS[def.group], `${key} has no group`);
        assert.ok(typeof def.build === 'function', `${key} has no builder`);
        assert.ok(Array.isArray(def.filters), `${key} has no filters list`);
      }
      assert.ok(Object.keys(REPORTS).length >= 38);
    });

    for (const key of Object.keys(REPORTS)) {
      await check(`${key} runs on an empty venue`, async () => {
        const r = await run(key, EMPTY, { filters: { product: '1', clerk: 'Nobody', week_start: WEEK_FROM } });
        assert.ok(Array.isArray(r.sections) && r.sections.length >= 1, 'no sections');
        // A summary block (Profit Summary's three lines, GP Summary's two)
        // has fixed rows; everything in them must be nothing.
        for (const s of r.sections) {
          assert.ok(Array.isArray(s.columns) && s.columns.length, `${s.title} has no columns`);
          for (const row of s.rows) {
            for (const c of s.columns) {
              if (c.type === 'money' || c.type === 'number') {
                assert.ok(!Number(row[c.key]), `${s.title}: ${c.label} is ${row[c.key]} on an empty venue`);
              }
            }
          }
        }
      });
    }

    const built = {};
    for (const key of Object.keys(REPORTS)) {
      await check(`${key} runs on the seeded venue and exports three ways`, async () => {
        const r = await run(key, A, { filters: { product: '1', clerk: 'Sarah', week_start: WEEK_FROM, group_by: 'department' } });
        built[key] = r;
        assert.ok(r.sections.length >= 1);
        const csv = toCsv(r);
        assert.ok(csv.includes(r.name), 'csv lacks the report name');
        const xlsx = await toXlsx(r);
        assert.ok(xlsx.length > 500, 'xlsx is empty');
        const pdf = await toPdf(r);
        assert.ok(pdf.length > 1000, 'pdf is empty');
      });
    }

    await check('department, sub department, tax, table location and product tables all reconcile', () => {
      const dept = total(built.department_sales, 0, 'gross_minor');
      assert.strictEqual(dept, expectedGross, 'department sales differ from what was seeded');
      assert.strictEqual(total(built.sub_department_sales, 0, 'gross_minor'), dept);
      assert.strictEqual(total(built.tax_report, 0, 'gross_minor'), dept);
      assert.strictEqual(total(built.sales_by_table_location, 0, 'gross_minor'), dept);
      assert.strictEqual(total(built.product_sales_by_time, 0, 'gross_minor'), dept);
      assert.strictEqual(total(built.product_sales_by_time, 1, 'gross_minor'), dept);
      assert.strictEqual(total(built.profit_summary, 0, 'gross_minor'), dept);
      assert.strictEqual(total(built.weekly_sales_analysis, 0, 'gross_minor'), dept);
      assert.strictEqual(total(built.sales_comparison, 0, 'this_minor'), dept);
      assert.strictEqual(total(built.financial_summary, 0, 'gross_minor'), dept);
      // The week grid, run from the same Monday, adds up to the same week.
      assert.strictEqual(total(built.financial_summary_7_days, 0, 'week_minor'), dept);
      assert.strictEqual(total(built.daily_department_sales, 0, 'week_minor'), total(built.department_sales, 0, 'net_minor'));
    });

    await check('the tax report and the department report agree on the tax', () => {
      assert.strictEqual(total(built.tax_report, 0, 'tax_minor'), total(built.department_sales, 0, 'tax_minor'));
      // Crisps are zero-rated: one row at 0% with no tax in it.
      const zero = built.tax_report.sections[0].rows.find((r) => r.name === '0% Rate');
      assert.ok(zero, 'no zero-rate row');
      assert.strictEqual(Number(zero.tax_minor), 0);
      assert.strictEqual(Number(zero.gross_minor), 480);
    });

    await check('payments add up to the money taken, with cashback and gratuity beside', () => {
      const r = built.payment_types;
      assert.strictEqual(total(r, 0, 'total_minor'), expectedGross + 100);
      const card = r.sections[0].rows.find((x) => x.name === 'Card');
      assert.strictEqual(card.cashback_minor, 2000);
      assert.strictEqual(card.gratuity_minor, 100);
      assert.strictEqual(total(built.transactions_by_payment_type, 0, 'amount_minor') + total(built.transactions_by_payment_type, 1, 'amount_minor') + total(built.transactions_by_payment_type, 2, 'amount_minor'), expectedGross + 100);
      assert.strictEqual(built.transaction_detail.sections[0].rows.length, 6);
    });

    await check('the clerk filter narrows Product Sales by Clerk to one person', () => {
      const r = built.product_sales_by_clerk;
      assert.strictEqual(r.sections.length, 1);
      assert.strictEqual(r.sections[0].title, 'Sarah');
      assert.strictEqual(r.filters.clerk, 'Sarah');
      assert.ok(reportHeader(r).some((h) => h[0] === 'Clerk' && h[1] === 'Sarah'));
      assert.strictEqual(total(r, 0, 'gross_minor'), 1770 + 300 + 2720);
    });

    await check('covers: spend per head is takings over covers, by day part and by room', () => {
      const r = built.covers_report;
      assert.strictEqual(total(r, 0, 'covers'), 7);
      const lounge = r.sections[1].rows.find((x) => x.name === 'Lounge');
      assert.strictEqual(lounge.covers, 7);
      assert.strictEqual(lounge.average_minor, Math.round((1870 + 300 + 2720) / 7));
      assert.ok(r.sections[1].rows.some((x) => x.name === 'None'));
    });

    await check('profit summary: COS from cost price, labour only where a rate is set, net below', () => {
      const r = built.profit_summary;
      const drink = r.sections[0].rows.find((x) => x.name === 'Drink');
      // Carling 7 × £1.64 + Coke 3 × £0.40
      assert.strictEqual(drink.cost_minor, 1148 + 120);
      const labour = r.sections[1];
      assert.ok(labour.title.includes('Tom'), 'Tom has no rate and should be named');
      const sarah = labour.rows.find((x) => x.name === 'Sarah');
      assert.strictEqual(sarah.hours, 8);
      assert.strictEqual(sarah.total_minor, 10000);
      assert.strictEqual(r.sections[2].rows[2].total_minor, r.sections[2].rows[0].total_minor - 10000);
    });

    await check('GP summary puts notional against actual from the ledger', () => {
      const r = built.gp_summary;
      assert.strictEqual(r.sections[0].rows[0].cost_minor, total(built.profit_summary, 0, 'cost_minor'));
      // Ledger out in the week: sales 7×164 + 3×40, wastage 2×164.
      assert.strictEqual(r.sections[0].rows[1].cost_minor, 1148 + 120 + 328);
      assert.strictEqual(r.sections[1].rows[1].total_minor, 328);
    });

    await check('refunds, expenses and cashback read the till events and the payments', () => {
      assert.strictEqual(total(built.refunds, 0, 'amount_minor'), 410);
      assert.strictEqual(built.refunds.sections[0].rows[0].clerk, 'Sarah');
      assert.strictEqual(total(built.expenses, 0, 'amount_minor'), 3000);
      assert.strictEqual(total(built.cashback, 0, 'amount_minor'), 2000);
      const seven = built.financial_summary_7_days;
      const exp = seven.sections[2].rows.find((x) => x.name === 'Window cleaner');
      assert.strictEqual(exp.week_minor, -3000);
      assert.strictEqual(exp.d3, -3000, 'Thursday 10th');
    });

    await check('stock movements show units with packs, and the valuation is as at the period end', () => {
      const carling = built.stock_movements.sections.flatMap((s) => s.rows).find((r) => r.name === 'Carling');
      assert.strictEqual(carling.sales, '-7');
      assert.strictEqual(carling.wastage, '-2');
      assert.strictEqual(carling.deliveries, '88');
      assert.strictEqual(carling.current, '100');
      const v = built.stock_valuation;
      assert.strictEqual(v.filters.group_by, 'department');
      assert.strictEqual(v.sections.length, 1, 'grouped by department: Drink only');
      const row = v.sections[0].rows.find((r) => r.name === 'Carling');
      assert.strictEqual(row.units, 100);
      assert.strictEqual(row.value_minor, 100 * 164);
      assert.strictEqual(v.sections[0].total.value_minor, 100 * 164 + 24 * 40);
    });

    await check('wastage, variance and orders read their tables', () => {
      assert.strictEqual(total(built.wastage_report, 0, 'cost_minor'), 328);
      assert.strictEqual(built.wastage_report.sections[0].rows[0].reasons, 'Spilled');
      const v = built.stock_variance;
      assert.strictEqual(v.sections.length, 1);
      assert.strictEqual(total(v, 0, 'variance'), -6);
      assert.strictEqual(total(v, 0, 'variance_minor'), -4 * 150 + -2 * 40);
      const o = built.orders_and_deliveries;
      assert.strictEqual(o.sections[0].rows.length, 1);
      assert.strictEqual(o.sections[0].rows[0].status, 'Delivered');
      assert.strictEqual(o.sections[0].rows[0].delivered_minor, 13200);
    });

    await check('product audit walks a running balance back from the shelf', () => {
      const r = built.product_audit;
      assert.strictEqual(r.productLabel, 'Carling (PLU 1)');
      const rows = r.sections[0].rows;
      assert.strictEqual(rows.length, 3);
      assert.strictEqual(rows[rows.length - 1].balance, 100);
      assert.strictEqual(rows[0].balance, 100 - 88 - (-7) - 0 - -2 + 0 - 2 - 0, 'first balance');
      assert.strictEqual(built.product_sales_audit.sections[0].rows.length, 3);
      assert.strictEqual(total(built.product_sales_audit, 0, 'quantity'), 7);
    });

    await check('attendance and wage percentage come from the clock', () => {
      const a = built.clerk_attendance;
      assert.strictEqual(total(a, 0, 'hours'), 14.5);
      assert.strictEqual(total(a, 0, 'cost_minor'), 10000);
      const w = built.wage_percentage;
      const mon = w.sections[0].rows.find((r) => r.name.startsWith('Mon'));
      assert.strictEqual(mon.sales_minor, 1870);
      assert.strictEqual(mon.cost_minor, 10000);
      assert.strictEqual(built.clerk_sub_department_sales.sections.length, 1);
    });

    await check('customer and gift card reports', () => {
      const c = built.customer_transactions;
      assert.strictEqual(c.sections[0].rows.length, 1);
      assert.strictEqual(c.sections[0].rows[0].name, 'Priya');
      assert.strictEqual(built.gift_card_report.highlights[0].minor, 5000);
      assert.strictEqual(built.gift_card_report.highlights[1].minor, 3000);
      assert.strictEqual(built.gift_card_transactions.sections[0].rows.length, 2);
    });

    await check('a week-start report ignores the period and takes seven days from the date', async () => {
      const r = await run('daily_department_sales', A, { period: 'today', filters: { week_start: '2026-09-09' } });
      assert.strictEqual(r.filters.week_start, '2026-09-09');
      assert.strictEqual(r.sections[0].columns[1].label, 'Wed 09/09');
      assert.strictEqual(r.sections[0].columns[7].label, 'Tue 15/09');
      // Monday's and Tuesday's sales are outside it now: Monday's net is
      // 683 + 792 (Carling 820, Burger 950, both at 20%), Tuesday's 1025.
      assert.strictEqual(total(r, 0, 'week_minor'), total(built.department_sales, 0, 'net_minor') - 1475 - 1025);
    });

    await check('a filter a report does not name is dropped, not applied', async () => {
      const r = await run('department_sales', A, { filters: { clerk: 'Sarah', product: '1' } });
      assert.deepStrictEqual(r.filters, {});
      assert.strictEqual(total(r, 0, 'gross_minor'), expectedGross);
    });
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin.end();
  }

  console.log(`\nreports-catalogue: ${passed}/${passed + failed} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
