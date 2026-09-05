/**
 * The leak, reproduced against a real database and then proved closed.
 *
 * `tenancy.test.js` checks the SQL the routes emit. This one checks what a
 * manager actually reads, because those are different claims: a query can name
 * the right column and still be handed the wrong value, and the customer's
 * complaint was never about SQL — it was that a company created that morning
 * showed four thousand pounds of somebody else's bills.
 *
 * So this builds exactly that. Two offices in one database: The Bridge, trading
 * since last month, and New Company, opened today with nothing rung up. It signs
 * in as New Company and reads all six report pages. Every one of them must be
 * empty. A single row of The Bridge's is a failure, and the assertion says which
 * row, because "reports leak" is not a thing anybody can act on.
 *
 * NOT PART OF `npm test`
 *
 * It needs a MySQL/MariaDB to talk to, and the rest of the suite deliberately
 * needs nothing. Run it directly:
 *
 *     DB_NAME=vesopa_tenancy_test DB_USER=root DB_PASSWORD=... \
 *       node test/tenancy.e2e.js
 *
 * It creates its own rows under two addresses nobody trades under, and deletes
 * them again on the way out, so it can be pointed at a scratch database without
 * leaving anything behind.
 */

const assert = require('assert');
const express = require('express');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');

const { backofficeRoutes } = require('../src/backoffice');
const { programmingRoutes } = require('../src/programming');

const SECRET = 'tenancy-e2e-secret';

/** The venue that has been trading, and the one opened this morning. */
const BRIDGE = 'bridge-e2e@vesopa.invalid';
const FRESH = 'newco-e2e@vesopa.invalid';

/** Everything The Bridge has that New Company must never see. */
const BRIDGE_DISH = 'Lamb Curry E2E';
const BRIDGE_DEPT = 'Mains E2E';
const BRIDGE_GROUP = 'Food E2E';
const BRIDGE_CLERK = 'Bridge Clerk E2E';
const BRIDGE_TOTAL_MINOR = 31750;

let passed = 0;
const checks = [];
const check = (name, fn) => checks.push({ name, fn });

// ---- The two venues --------------------------------------------------------

/**
 * The next free id in a legacy table.
 *
 * `bo_products`, `bo_clarks` and `backoffice_users` predate the migrations in
 * schema/ and a scratch database rebuilt from the SQL backup gets them without
 * AUTO_INCREMENT. Asking for MAX(id)+1 works either way, and costs one query on
 * a table this test has just emptied.
 */
async function nextId(pool, table) {
  const [[row]] = await pool.query(`SELECT COALESCE(MAX(id), 0) + 1 AS id FROM ${table}`);
  return row.id;
}

async function seed(pool) {
  await wipe(pool);

  for (const [email, name] of [[BRIDGE, 'The Bridge'], [FRESH, 'New Company']]) {
    await pool.query(
      `INSERT INTO offices (name, contact_email, status) VALUES (?, ?, 'active')`,
      [name, email]
    );
  }
  const [offices] = await pool.query(
    'SELECT id, contact_email FROM offices WHERE contact_email IN (?, ?)',
    [BRIDGE, FRESH]
  );
  const officeId = Object.fromEntries(offices.map((o) => [o.contact_email, o.id]));

  for (const email of [BRIDGE, FRESH]) {
    await pool.query(
      `INSERT INTO backoffice_users (id, email, password, name, approved, office_id, role)
       VALUES (?, ?, 'x', ?, 'Y', ?, 'office')`,
      [
        await nextId(pool, 'backoffice_users'),
        `manager+${email}`,
        `Manager of ${email}`,
        officeId[email],
      ]
    );
  }

  // The Bridge's catalogue, staff and a month of trading.
  await pool.query(
    `INSERT INTO bo_products (id, email, pluid, product_name, department_name, group_name, price, tax_percentage)
     VALUES (?, ?, 9001, ?, ?, ?, 12.50, 20)`,
    [await nextId(pool, 'bo_products'), BRIDGE, BRIDGE_DISH, BRIDGE_DEPT, BRIDGE_GROUP]
  );
  await pool.query(
    `INSERT INTO bo_clarks (id, email, pluid, clark_name, pin_code, active)
     VALUES (?, ?, 1, ?, '4321', 1)`,
    [await nextId(pool, 'bo_clarks'), BRIDGE, BRIDGE_CLERK]
  );

  // Closed today, so `/live` (which is CURDATE()-bound) sees it too.
  const orderId = 'e2e-bridge-order-0000000000000000001';
  await pool.query(
    `INSERT INTO epos_orders
       (id, email, table_number, clerk_pin, subtotal_minor, tax_minor, total_minor, closed_at)
     VALUES (?, ?, 7, '4321', ?, 5292, ?, NOW())`,
    [orderId, BRIDGE, BRIDGE_TOTAL_MINOR, BRIDGE_TOTAL_MINOR]
  );
  await pool.query(
    `INSERT INTO epos_order_lines
       (id, order_id, plu_id, name, quantity, unit_price_minor, tax_percentage)
     VALUES (?, ?, 9001, ?, 25, 1270, 20)`,
    ['e2e-bridge-line-00000000000000000001', orderId, BRIDGE_DISH]
  );
  await pool.query(
    `INSERT INTO epos_payments (id, order_id, method, amount_minor)
     VALUES (?, ?, 'cash', ?)`,
    ['e2e-bridge-pay-000000000000000000001', orderId, BRIDGE_TOTAL_MINOR]
  );

  // New Company has a name and nothing else. This is the whole point.
  return officeId;
}

async function wipe(pool) {
  await pool.query(
    `DELETE FROM epos_orders WHERE email IN (?, ?)`, [BRIDGE, FRESH]
  );
  for (const table of ['bo_products', 'bo_clarks']) {
    await pool.query(`DELETE FROM ${table} WHERE email IN (?, ?)`, [BRIDGE, FRESH]);
  }
  await pool.query(
    `DELETE FROM backoffice_users WHERE email IN (?, ?)`,
    [`manager+${BRIDGE}`, `manager+${FRESH}`]
  );
  await pool.query(
    'DELETE FROM offices WHERE contact_email IN (?, ?)', [BRIDGE, FRESH]
  );
}

// ---- Reading the back office as New Company -------------------------------

const ROUTES = [
  '/api/live',
  '/api/reports',
  '/api/sales',
  '/api/sales-explorer',
  '/api/till-report',
  '/api/bill-report',
];

/** Anything of The Bridge's that must not appear in New Company's back office. */
const FORBIDDEN = [
  BRIDGE_DISH,
  BRIDGE_DEPT,
  BRIDGE_GROUP,
  BRIDGE_CLERK,
  String(BRIDGE_TOTAL_MINOR),
  'e2e-bridge-order',
];

async function open() {
  const pool = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'vesopa_tenancy_test',
    connectionLimit: 4,
  });

  const app = express();
  app.use(express.json());
  const deps = { pool, broadcast: () => {}, secret: SECRET };
  app.use('/api', backofficeRoutes(deps));
  app.use('/api', programmingRoutes(deps));
  app.use((err, _req, res, _next) => res.status(500).json({ error: String(err) }));

  const server = await new Promise((r) => {
    const s = app.listen(0, () => r(s));
  });
  return { pool, server };
}

async function run({ pool, server }) {
  const officeId = await seed(pool);
  const base = `http://127.0.0.1:${server.address().port}`;

  const as = (email) =>
    jwt.sign(
      { sub: 1, email: `manager+${email}`, role: 'office', officeId: officeId[email] },
      SECRET
    );

  const get = async (route, email) => {
    const res = await fetch(`${base}${route}`, {
      headers: { Authorization: `Bearer ${as(email)}` },
    });
    assert.strictEqual(res.status, 200, `${route} answered ${res.status}`);
    return JSON.stringify(await res.json());
  };

  // ---- The customer's complaint, as a check ------------------------------

  for (const route of ROUTES) {
    check(`${route} shows New Company nothing of The Bridge's`, async () => {
      const body = await get(route, FRESH);
      for (const secret of FORBIDDEN) {
        assert.ok(
          !body.includes(secret),
          `${route} leaked "${secret}" into New Company's back office:\n      ${body.slice(0, 300)}`
        );
      }
    });
  }

  check('and The Bridge can still read its own trading', async () => {
    // The other half of the fix. Scoping that also hides a venue's own takings
    // would be a worse bug than the one being fixed, and quieter.
    const report = await get('/api/reports', BRIDGE);
    assert.ok(report.includes(BRIDGE_DISH), 'The Bridge cannot see its own PLU sales');
    assert.ok(report.includes(BRIDGE_DEPT), 'The Bridge cannot see its own departments');
    assert.ok(report.includes(BRIDGE_CLERK), 'The Bridge cannot see its own staff');

    const bills = await get('/api/bill-report', BRIDGE);
    assert.ok(bills.includes('e2e-bridge-order'), 'The Bridge cannot see its own bills');

    const live = await get('/api/live', BRIDGE);
    assert.ok(live.includes(String(BRIDGE_TOTAL_MINOR)), 'The Bridge dashboard is blank');
    assert.ok(live.includes(BRIDGE_DEPT), 'The Bridge dashboard lost its departments');
  });

  check('the till report separates the two venues by day, not by luck', async () => {
    const theirs = await get('/api/till-report', BRIDGE);
    const ours = await get('/api/till-report', FRESH);
    assert.ok(theirs.includes(String(BRIDGE_TOTAL_MINOR)), 'The Bridge has no till report');
    assert.strictEqual(ours, '[]', `New Company's till report was not empty: ${ours}`);
  });

  console.log('Tenancy end-to-end: two venues, one database\n');
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
  console.log(`\ntenancy e2e: ${passed}/${checks.length} checks passed`);
}

/**
 * The pool and the listening socket are closed whatever happens, including on
 * the way out of a failure. Without that a broken seed leaves node holding an
 * idle connection and the run never ends — which reads as a hung test rather
 * than as the error it actually is, and that is a bad half-hour to give
 * somebody.
 */
(async () => {
  let pool;
  let server;
  try {
    ({ pool, server } = await open());
    await run({ pool, server });
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    if (server) server.close();
    if (pool) {
      try {
        await wipe(pool);
      } catch {
        // A database that could not be tidied is not a test result.
      }
      await pool.end();
    }
  }
})();
