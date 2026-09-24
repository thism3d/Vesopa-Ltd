/**
 * The four reports the venue asked for, run against a real database.
 *
 * A report is the one screen a venue prints and hands to an accountant, so
 * there are two things worth proving and they are not the same:
 *
 *   1. The figures are right. Seeded rows in, known totals out — checked
 *      against arithmetic done here rather than against whatever the query
 *      happened to return the first time it ran.
 *
 *   2. They are somebody's figures and not everybody's. Six report routes read
 *      `epos_orders` with no owner at all until recently, and a venue opened a
 *      new company and read a stranger's trading. Every report below is run as
 *      a second venue that traded nothing, and every one of them must be empty.
 *
 *     DB_NAME=vesopa_tenancy_test DB_USER=root DB_PASSWORD=... \
 *       node test/reports-new.e2e.js
 */

const assert = require('assert');
const mysql = require('mysql2/promise');

const { REPORTS, runReport, toCsv, toXlsx, toPdf } = require('../src/reports');

const OURS = 'reports-e2e@vesopa.invalid';
const THEIRS = 'reports-e2e-next-door@vesopa.invalid';

const DAY = '2026-09-03';
const FROM = new Date(`${DAY}T00:00:00`);
const TO = new Date(`${DAY}T23:59:59`);

let passed = 0;
const checks = [];
const check = (name, fn) => checks.push({ name, fn });

async function nextId(pool, table) {
  const [[row]] = await pool.query(`SELECT COALESCE(MAX(id), 0) + 1 AS id FROM ${table}`);
  return row.id;
}

// ---------------------------------------------------------------------------
// A day's trading, with figures chosen so the arithmetic is checkable by eye
// ---------------------------------------------------------------------------

const CURRY = { plu: 5001, name: 'Lamb Curry', dept: 'Mains', price: 1200, qty: 3 };
const NAAN = { plu: 5002, name: 'Garlic Naan', dept: 'Sides', price: 350, qty: 4 };

async function seed(pool) {
  await wipe(pool);

  for (const [email, name] of [[OURS, 'Reports Venue'], [THEIRS, 'Next Door']]) {
    await pool.query(
      `INSERT INTO offices (name, contact_email, status) VALUES (?, ?, 'active')`,
      [name, email]
    );
  }

  for (const p of [CURRY, NAAN]) {
    await pool.query(
      `INSERT INTO bo_products (id, email, pluid, product_name, department_name, group_name, price, tax_percentage)
       VALUES (?, ?, ?, ?, ?, 'Food', ?, 20)`,
      [await nextId(pool, 'bo_products'), OURS, p.plu, p.name, p.dept, p.price / 100]
    );
  }
  await pool.query(
    `INSERT INTO bo_clarks (id, email, pluid, clark_name, pin_code, active)
     VALUES (?, ?, 1, 'Alex Morgan', '4321', 1)`,
    [await nextId(pool, 'bo_clarks'), OURS]
  );

  // A member, so the loyalty report has somebody in it.
  const customerId = 'reports-e2e-customer-000000000000001';
  await pool.query(
    `INSERT INTO epos_customers (id, email_key, name, member_no, tier_name, points_balance)
     VALUES (?, ?, 'Jo Patel', 41, 'Gold', 120)`,
    [customerId, OURS]
  );

  // One bill: 3 curries and 4 naans, £5.00 off the curry line, £2.00 off the
  // bill. Gross 3*1200 + 4*350 = 5000; line discount 500; bill discount 200.
  const orderId = 'reports-e2e-order-0000000000000001';
  await pool.query(
    `INSERT INTO epos_orders
       (id, email, table_number, covers, clerk_pin, customer_id,
        subtotal_minor, discount_minor, tax_minor, total_minor, closed_at, terminal)
     VALUES (?, ?, 4, 2, '4321', ?, 5000, 200, 750, 4300, ?, 'Bar')`,
    [orderId, OURS, customerId, `${DAY} 19:30:00`]
  );
  await pool.query(
    `INSERT INTO epos_order_lines
       (id, order_id, plu_id, name, quantity, unit_price_minor, tax_percentage, discount_minor, promotion_name, is_modifier, line_no)
     VALUES (?, ?, ?, ?, ?, ?, 20, 500, 'Curry Night', 0, 1)`,
    ['reports-e2e-line-00000000000000001', orderId, CURRY.plu, CURRY.name, CURRY.qty, CURRY.price]
  );
  await pool.query(
    `INSERT INTO epos_order_lines
       (id, order_id, plu_id, name, quantity, unit_price_minor, tax_percentage, discount_minor, is_modifier, line_no)
     VALUES (?, ?, ?, ?, ?, ?, 20, 0, 0, 2)`,
    ['reports-e2e-line-00000000000000002', orderId, NAAN.plu, NAAN.name, NAAN.qty, NAAN.price]
  );
  await pool.query(
    `INSERT INTO epos_payments (id, order_id, method, amount_minor)
     VALUES (?, ?, 'card', 4300)`,
    ['reports-e2e-pay-000000000000000001', orderId]
  );

  await pool.query(
    `INSERT INTO epos_loyalty_txns
       (id, office, customer_id, order_id, kind, points, balance_after, spend_minor, value_minor, created_at)
     VALUES (?, ?, ?, ?, 'earn', 43, 163, 4300, 0, ?)`,
    ['reports-e2e-loy-000000000000000001', OURS, customerId, orderId, `${DAY} 19:31:00`]
  );
  await pool.query(
    `INSERT INTO epos_loyalty_txns
       (id, office, customer_id, order_id, kind, points, balance_after, spend_minor, value_minor, created_at)
     VALUES (?, ?, ?, ?, 'redeem', -100, 63, 0, 500, ?)`,
    ['reports-e2e-loy-000000000000000002', OURS, customerId, orderId, `${DAY} 19:32:00`]
  );

  // Two voids: one line-level, one whole check.
  await pool.query(
    `INSERT INTO epos_void_log
       (id, email, order_id, clerk_pin, reason, items, scope, amount_minor, voided_at, terminal)
     VALUES (?, ?, ?, '4321', 'Wrong item rung up', '1x Lamb Curry', 'lines', 1200, ?, 'Bar')`,
    ['reports-e2e-void-00000000000000001', OURS, orderId, `${DAY} 20:05:00`]
  );
  await pool.query(
    `INSERT INTO epos_void_log
       (id, email, order_id, clerk_pin, reason, items, scope, amount_minor, voided_at, terminal)
     VALUES (?, ?, ?, '4321', 'Customer left', '2x Garlic Naan', 'sale', 700, ?, 'Bar')`,
    ['reports-e2e-void-00000000000000002', OURS, orderId, `${DAY} 21:15:00`]
  );

  // Next door traded nothing at all. That is the whole point of them.
}

async function wipe(pool) {
  for (const [table, column] of [
    ['epos_orders', 'email'],
    ['epos_void_log', 'email'],
    ['bo_products', 'email'],
    ['bo_clarks', 'email'],
    ['epos_customers', 'email_key'],
    ['epos_loyalty_txns', 'office'],
  ]) {
    await pool
      .query(`DELETE FROM ${table} WHERE ${column} IN (?, ?)`, [OURS, THEIRS])
      .catch(() => {});
  }
  await pool.query('DELETE FROM offices WHERE contact_email IN (?, ?)', [OURS, THEIRS]);
}

// ---------------------------------------------------------------------------

const NEW_REPORTS = ['product_sales', 'discounts', 'loyalty_spending', 'voids_cancels'];

/** Find a section by title, so a test says what it wanted when it is not there. */
const sectionOf = (report, title) => {
  const found = report.sections.find((s) => s.title === title);
  assert.ok(found, `${report.name} has no "${title}" section`);
  return found;
};

const rowOf = (section, name) => {
  const found = section.rows.find((r) => String(r.name).includes(name));
  assert.ok(found, `"${name}" is not in ${section.title}`);
  return found;
};

async function main() {
  const pool = await mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'vesopa_tenancy_test',
    connectionLimit: 4,
  });

  try {
    await seed(pool);

    // `runReport` is the one entry point the browser, the exporters and the
    // scheduler all go through, so the tests use it rather than reaching for a
    // builder directly — a report that only works when called the test's way
    // is not a report anybody can run.
    const run = (key, office = OURS, siteName = 'Reports Venue') =>
      runReport({
        pool,
        office,
        siteName,
        report: key,
        period: 'custom',
        from: DAY,
        to: DAY,
      });

    // ---- They exist and answer -------------------------------------------

    check('all four are offered by the catalogue', () => {
      for (const key of NEW_REPORTS) {
        assert.ok(REPORTS[key], `${key} is not registered`);
        assert.ok(REPORTS[key].label, `${key} has no label`);
        assert.ok(REPORTS[key].description, `${key} has no description`);
      }
    });

    check('every one names itself, its site and its window', async () => {
      // A PDF of takings with no dates on it is not evidence of anything.
      for (const key of NEW_REPORTS) {
        const report = await run(key);
        assert.ok(report.name, `${key} has no name`);
        assert.strictEqual(report.site, 'Reports Venue');
        assert.ok(report.from instanceof Date, `${key} has no start`);
        assert.ok(report.to instanceof Date, `${key} has no end`);
        // Whole days in the venue's own time, ending at 23:59:59 — the same
        // window every other report uses, or two reports over the same dates
        // disagree by a sale.
        assert.strictEqual(report.from.toISOString().slice(0, 10), DAY);
        assert.strictEqual(report.to.getHours(), 23);
        assert.ok(report.generatedAt instanceof Date);
        assert.ok(report.sections.length > 0, `${key} has no sections`);
      }
    });

    // ---- Product Sales ----------------------------------------------------

    check('product sales counts what was rung up', async () => {
      const report = await run('product_sales');
      const products = sectionOf(report, 'Product Sales');

      const curry = rowOf(products, 'Lamb Curry');
      assert.strictEqual(curry.count, CURRY.qty);
      assert.strictEqual(curry.gross_minor, CURRY.qty * CURRY.price); // 3600
      assert.strictEqual(curry.discount_minor, 500);
      assert.strictEqual(curry.sales_minor, 3100);
      // 20% VAT inclusive on 3100 = 3100/6 = 516.67 → 517
      assert.strictEqual(curry.tax_minor, 517);
      assert.strictEqual(curry.net_minor, 3100 - 517);

      const naan = rowOf(products, 'Garlic Naan');
      assert.strictEqual(naan.count, NAAN.qty);
      assert.strictEqual(naan.gross_minor, NAAN.qty * NAAN.price); // 1400
      assert.strictEqual(naan.discount_minor, 0);
    });

    check('and rolls the same rows up by department', async () => {
      // The two tables have to add up to each other, or one of them is wrong.
      const report = await run('product_sales');
      const products = sectionOf(report, 'Product Sales');
      const departments = sectionOf(report, 'By Department');

      assert.strictEqual(
        departments.total.sales_minor,
        products.total.sales_minor,
        'the department roll-up disagrees with the product list'
      );
      assert.strictEqual(rowOf(departments, 'Mains').sales_minor, 3100);
      assert.strictEqual(rowOf(departments, 'Sides').sales_minor, 1400);
    });

    // ---- Discounts --------------------------------------------------------

    check('the discount report separates a promotion from a hand-out', async () => {
      const report = await run('discounts');
      const byDiscount = sectionOf(report, 'By Discount');

      // The curry line carried a named promotion.
      const promo = rowOf(byDiscount, 'Curry Night');
      assert.strictEqual(promo.count, 1);
      assert.strictEqual(promo.total_minor, 500);
    });

    check('and names the member of staff who gave it', async () => {
      // "We gave away four hundred pounds" is interesting; "and two hundred of
      // it was one person" is actionable.
      const report = await run('discounts');
      const staff = rowOf(sectionOf(report, 'By Staff Member'), 'Alex Morgan');
      assert.strictEqual(staff.total_minor, 200); // the bill-level discount
    });

    check('and counts the whole-bill reduction, which is on no line', async () => {
      const report = await run('discounts');
      const bill = sectionOf(report, 'Whole-bill Discounts');
      assert.strictEqual(bill.total.total_minor, 200);

      // The headline is both kinds together: 500 on a line + 200 on the bill.
      const givenAway = report.highlights.find((h) => h.label === 'Given away');
      assert.strictEqual(givenAway.minor, 700);
    });

    // ---- Loyalty ----------------------------------------------------------

    check('loyalty spending counts only bills with a member on them', async () => {
      const report = await run('loyalty_spending');
      const members = sectionOf(report, 'Members');

      const jo = rowOf(members, 'Jo Patel');
      assert.ok(jo.name.includes('#41'), 'the member number is not shown');
      assert.strictEqual(jo.count, 1);
      assert.strictEqual(jo.total_minor, 4300);
      assert.strictEqual(jo.average_minor, 4300);
      assert.strictEqual(jo.tier, 'Gold');
    });

    check('and reads points from the ledger, not from the spend', async () => {
      // A manual award or an expiry moves a balance without a sale, so a report
      // that recomputed from the takings would disagree with the customer's own
      // card.
      const report = await run('loyalty_spending');
      const points = sectionOf(report, 'Points');
      assert.strictEqual(rowOf(points, 'Earned').count, 43);
      assert.strictEqual(rowOf(points, 'Redeemed').count, 100);
      assert.strictEqual(rowOf(points, 'Redeemed').total_minor, 500);
    });

    // ---- Voids ------------------------------------------------------------

    check('voids are read from the log, because the sale has no trace of them', async () => {
      const report = await run('voids_cancels');
      const reasons = sectionOf(report, 'By Reason');

      assert.strictEqual(rowOf(reasons, 'Wrong item rung up').total_minor, 1200);
      assert.strictEqual(rowOf(reasons, 'Customer left').total_minor, 700);
      assert.strictEqual(reasons.total.total_minor, 1900);
    });

    check('and a cancelled check is told apart from voided lines', async () => {
      const report = await run('voids_cancels');
      const scope = sectionOf(report, 'Lines or Whole Checks');
      assert.strictEqual(rowOf(scope, 'Cancelled check').total_minor, 700);
      assert.strictEqual(rowOf(scope, 'Voided lines').total_minor, 1200);
    });

    check('and every void is itemised, because an amount alone proves nothing', async () => {
      // Two voids of £4.50 could be a mis-keyed coffee or a bottle of wine
      // walking out of the door.
      const report = await run('voids_cancels');
      const every = sectionOf(report, 'Every Void');
      assert.strictEqual(every.rows.length, 2);
      assert.ok(
        every.rows.some((r) => r.items.includes('Lamb Curry')),
        'the items summary is missing'
      );
      assert.ok(every.rows.every((r) => r.staff === 'Alex Morgan'));
    });

    // ---- Tenancy ----------------------------------------------------------

    check('none of it reaches the venue next door', async () => {
      for (const key of NEW_REPORTS) {
        const report = await run(key, THEIRS, 'Next Door');
        const body = JSON.stringify(report.sections);
        for (const secret of ['Lamb Curry', 'Garlic Naan', 'Jo Patel', 'Alex Morgan', 'Curry Night']) {
          assert.ok(
            !body.includes(secret),
            `${key} leaked "${secret}" into a venue that traded nothing`
          );
        }
        for (const s of report.sections) {
          assert.strictEqual(
            Number(s.total.total_minor ?? s.total.sales_minor ?? 0),
            0,
            `${key} § ${s.title} was not empty next door`
          );
        }
      }
    });

    // ---- Exports ----------------------------------------------------------

    check('each one exports as the file it claims to be', async () => {
      const magic = {
        pdf: (buf) => buf.subarray(0, 4).toString() === '%PDF',
        csv: (buf) => buf.toString('utf8').includes(','),
        xlsx: (buf) => buf[0] === 0x50 && buf[1] === 0x4b, // PK
      };
      const exporters = { csv: toCsv, xlsx: toXlsx, pdf: toPdf };
      for (const key of NEW_REPORTS) {
        const report = await run(key);
        for (const [format, exporter] of Object.entries(exporters)) {
          const out = await exporter(report);
          const buf = Buffer.isBuffer(out) ? out : Buffer.from(out);
          assert.ok(buf.length > 100, `${key}.${format} is empty (${buf.length})`);
          assert.ok(magic[format](buf), `${key}.${format} is not a ${format}`);
        }
      }
    });

    // ---- Run --------------------------------------------------------------

    console.log('The four new reports, against a real database\n');
    for (const { name, fn } of checks) {
      try {
        await fn();
        passed++;
        console.log(`  ok  ${name}`);
      } catch (e) {
        console.log(`FAIL  ${name}\n      ${e.message}`);
        process.exitCode = 1;
      }
    }
    console.log(`\nnew reports: ${passed}/${checks.length} checks passed`);
  } finally {
    await wipe(pool).catch(() => {});
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
