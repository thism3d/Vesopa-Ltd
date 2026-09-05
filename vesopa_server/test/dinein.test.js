/**
 * Dine-in, against a real database.
 *
 * WHY THIS ONE IS NOT A MOCK
 *
 * Most of the suite here drives a recording pool and asserts on the SQL that
 * comes out, which is the right shape for "does this route scope its query".
 * It is the wrong shape for this feature. The things that can actually go wrong
 * with dine-in are things a mock cannot have an opinion about:
 *
 *   * whether the price a customer is charged really is read from the catalogue
 *     rather than believed from the phone,
 *   * whether an order placed on one venue's table can be seen by another,
 *   * whether accepting an order twice makes two kitchen tickets,
 *   * whether a table keeps its printed address across a rename.
 *
 * Each of those is a join, a transaction or a race, so this test stands up a
 * MariaDB schema, seeds two venues, and drives the real Express routers.
 *
 * It needs a local MySQL or MariaDB. Set DINEIN_TEST_DB to point it somewhere
 * other than the default, and DINEIN_TEST_USER / _PASS for credentials. With no
 * server reachable it says so and exits 0 rather than failing a suite that runs
 * on machines without one.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');

const express = require('express');
const mysql = require('mysql2/promise');
const jwt = require('jsonwebtoken');

const { dineinRoutes } = require('../src/dinein');
const { dineinPageRoutes } = require('../src/dinein_pages');
const { programmingRoutes } = require('../src/programming');

const DB = process.env.DINEIN_TEST_DB || 'vesopa_dinein_selftest';
const USER = process.env.DINEIN_TEST_USER || 'root';
const PASS = process.env.DINEIN_TEST_PASS || '';
const HOST = process.env.DINEIN_TEST_HOST || '127.0.0.1';
const SECRET = 'dinein-test-secret';

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
    console.error(`        ${e.message}`);
    process.exitCode = 1;
  }
}

/** The two offices this test uses. Two, because half of what is being checked
    is that one cannot see the other. */
const ALPHA = { id: 901, email: 'alpha@dinein.test', name: 'The Alpha Arms' };
const BETA = { id: 902, email: 'beta@dinein.test', name: 'The Beta Bistro' };

function tokenFor(office) {
  return jwt.sign(
    { email: office.email, officeId: office.id, role: 'manager' },
    SECRET,
    { expiresIn: '1h' }
  );
}

/**
 * The credential a commissioned till actually carries.
 *
 * Deliberately a different shape from the one above, and the test has to use
 * the right one: `requireAuth` refuses a terminal token and `requireTerminal`
 * refuses a session token, so a test that signed the till in as a manager
 * would pass against routes no real till could reach.
 */
function terminalTokenFor(office) {
  return jwt.sign(
    {
      scope: 'terminal',
      office: office.email,
      officeId: office.id,
      commissionedBy: office.email,
    },
    SECRET,
    { expiresIn: '1h' }
  );
}

/** A tiny fetch against the test server, returning status and parsed body. */
function call(base, method, url, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      base + url,
      {
        method,
        headers: {
          Accept: 'application/json',
          ...(token ? { Authorization: 'Bearer ' + token } : {}),
          ...(payload
            ? {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
              }
            : {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = JSON.parse(raw);
          } catch {
            parsed = raw;
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * The legacy tables this feature joins against.
 *
 * `bo_products` and `offices` are not created by any file in schema/ — they
 * came from the PHP system this replaced — so the test makes the columns it
 * actually reads. Deliberately minimal: inventing the whole legacy table here
 * would be inventing a second definition of it.
 */
const LEGACY = `
CREATE TABLE IF NOT EXISTS offices (
  id INT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  contact_email VARCHAR(255) NOT NULL,
  UNIQUE KEY uq_office_email (contact_email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS bo_products (
  id INT AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(255) NOT NULL,
  pluid INT NOT NULL,
  product_name VARCHAR(255) NOT NULL,
  price DOUBLE NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`;

async function main() {
  console.log('\nDine-in\n');

  let admin;
  try {
    admin = await mysql.createConnection({
      host: HOST, user: USER, password: PASS, multipleStatements: true,
    });
  } catch (e) {
    console.log('  -- no database reachable, skipping (' + e.code + ')');
    return;
  }

  await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await admin.query(`CREATE DATABASE \`${DB}\` CHARACTER SET utf8mb4`);
  await admin.end();

  const conn = await mysql.createConnection({
    host: HOST, user: USER, password: PASS, database: DB,
    multipleStatements: true,
  });

  await conn.query(LEGACY);

  // Only the files this feature needs. Applying all of them would drag in the
  // rest of the platform's legacy dependencies for no gain.
  const schemaDir = path.join(__dirname, '..', 'schema');
  for (const file of ['schema_layout.sql', 'schema_menu_dinein.sql']) {
    const sql = fs.readFileSync(path.join(schemaDir, file), 'utf8');
    // DELIMITER is a client instruction, not SQL. The driver does not know it,
    // so the stored-procedure blocks are run as their own statements.
    await runScript(conn, sql);
  }

  for (const office of [ALPHA, BETA]) {
    await conn.execute(
      'INSERT INTO offices (id, name, contact_email) VALUES (?, ?, ?)',
      [office.id, office.name, office.email]
    );
  }
  await conn.execute(
    'INSERT INTO bo_products (email, pluid, product_name, price) VALUES ' +
      '(?, ?, ?, ?), (?, ?, ?, ?), (?, ?, ?, ?)',
    [
      ALPHA.email, 100, 'Fish and chips', 14.5,
      ALPHA.email, 101, 'Sticky toffee pudding', 7.0,
      BETA.email, 100, 'Carbonara', 12.0,
    ]
  );

  const pool = mysql.createPool({
    host: HOST, user: USER, password: PASS, database: DB,
    waitForConnections: true, connectionLimit: 6,
  });

  const sent = [];
  const broadcast = (message, options = {}) => sent.push({ message, options });

  const app = express();
  app.use(express.json());
  app.use('/api', dineinRoutes({ pool, broadcast, secret: SECRET }));
  app.use('/api', programmingRoutes({ pool, broadcast, secret: SECRET }));
  app.use(dineinPageRoutes());
  app.use((err, _req, res, _next) => {
    console.error('        server error:', err.message);
    res.status(500).json({ error: err.message });
  });

  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;

  const alpha = tokenFor(ALPHA);
  const beta = tokenFor(BETA);
  const alphaTill = terminalTokenFor(ALPHA);
  const betaTill = terminalTokenFor(BETA);

  // -------------------------------------------------------------------------
  // Setting the venue up
  // -------------------------------------------------------------------------

  await check('a venue starts unpublished, so nothing is public by accident', async () => {
    const res = await call(base, 'GET', '/api/dinein/venue', { token: alpha });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.is_published, 0);
    assert.strictEqual(res.body.ordering_open, 0);
  });

  await check('a web address is tidied rather than taken as typed', async () => {
    const res = await call(base, 'PUT', '/api/dinein/venue', {
      token: alpha,
      body: { slug: '  The Alpha Arms!! ', display_name: 'The Alpha Arms' },
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.venue.slug, 'the-alpha-arms');
  });

  await check('two venues cannot share one web address', async () => {
    const res = await call(base, 'PUT', '/api/dinein/venue', {
      token: beta,
      body: { slug: 'the-alpha-arms' },
    });
    assert.strictEqual(res.status, 409);
    assert.match(res.body.error, /already uses/i);
  });

  await check('an address the platform needs for itself is refused', async () => {
    const res = await call(base, 'PUT', '/api/dinein/venue', {
      token: beta,
      body: { slug: 'api' },
    });
    assert.strictEqual(res.status, 409);
  });

  // -------------------------------------------------------------------------
  // The floor, and the addresses printed on it
  // -------------------------------------------------------------------------

  let roomId;
  let tableId;
  let tablePublicId;

  await check('a room can be drawn as an L rather than a box', async () => {
    const made = await call(base, 'POST', '/api/floor/rooms', {
      token: alpha,
      body: {
        name: 'Restaurant',
        cols: 12,
        rows: 10,
        outline: [[0, 0], [12, 0], [12, 5], [6, 5], [6, 10], [0, 10]],
      },
    });
    assert.strictEqual(made.status, 201);
    roomId = made.body.id;

    const plan = await call(base, 'GET', '/api/floor', { token: alpha });
    const room = plan.body.find((r) => r.id === roomId);
    assert.ok(room, 'the room came back');
    assert.deepStrictEqual(JSON.parse(room.outline), [
      [0, 0], [12, 0], [12, 5], [6, 5], [6, 10], [0, 10],
    ]);
  });

  await check('a shape that is not a shape falls back to a rectangle', async () => {
    const made = await call(base, 'POST', '/api/floor/rooms', {
      token: alpha,
      body: { name: 'Snug', outline: [[0, 0], [4, 0]] },
    });
    assert.strictEqual(made.status, 201);
    const plan = await call(base, 'GET', '/api/floor', { token: alpha });
    const room = plan.body.find((r) => r.id === made.body.id);
    assert.strictEqual(room.outline, null);
  });

  await check('a new table is minted a public address', async () => {
    const made = await call(base, 'POST', '/api/floor/tables', {
      token: alpha,
      body: { room_id: roomId, table_number: 5, name: 'Window' },
    });
    assert.strictEqual(made.status, 201);
    tableId = made.body.id;

    const list = await call(base, 'GET', '/api/dinein/tables', { token: alpha });
    const table = list.body.tables.find((t) => t.id === tableId);
    assert.ok(table.public_id, 'it has a public id');
    assert.strictEqual(table.public_id.length, 32);
    assert.match(table.url, /\/t\/[0-9a-f]{32}$/);
    tablePublicId = table.public_id;
  });

  await check('one table name cannot be another table name in the same kitchen', async () => {
    const clash = await call(base, 'POST', '/api/floor/tables', {
      token: alpha,
      body: { room_id: roomId, table_number: 6, name: 'window' },
    });
    assert.strictEqual(clash.status, 409);
    assert.match(clash.body.error, /already a table called/i);
  });

  await check('renaming and renumbering a table leaves its address alone', async () => {
    const res = await call(base, 'PUT', '/api/floor/tables/' + tableId, {
      token: alpha,
      body: { name: 'Bay 1', table_number: 12 },
    });
    assert.strictEqual(res.status, 200);

    const list = await call(base, 'GET', '/api/dinein/tables', { token: alpha });
    const table = list.body.tables.find((t) => t.id === tableId);
    assert.strictEqual(table.name, 'Bay 1');
    assert.strictEqual(table.table_number, 12);
    assert.strictEqual(
      table.public_id,
      tablePublicId,
      'the printed card still points at this table'
    );
  });

  await check('one venue cannot see another venue\'s tables', async () => {
    const list = await call(base, 'GET', '/api/dinein/tables', { token: beta });
    assert.strictEqual(list.status, 200);
    assert.strictEqual(list.body.tables.length, 0);
  });

  // -------------------------------------------------------------------------
  // The menu
  // -------------------------------------------------------------------------

  let sectionId;

  await check('a section takes products from the venue\'s own catalogue', async () => {
    const made = await call(base, 'POST', '/api/dinein/sections', {
      token: alpha,
      body: { name: 'Mains', blurb: 'Served all day' },
    });
    assert.strictEqual(made.status, 201);
    sectionId = made.body.id;

    const added = await call(
      base,
      'POST',
      '/api/dinein/sections/' + sectionId + '/items',
      { token: alpha, body: { plu_ids: [100, 101] } }
    );
    assert.strictEqual(added.status, 201);
    assert.strictEqual(added.body.added, 2);
  });

  await check('a section will not take another venue\'s product', async () => {
    // PLU 100 exists for both offices; Beta asking Alpha's section to add it is
    // the shape of the attack, and the section not being Beta's is what stops
    // it first.
    const res = await call(
      base,
      'POST',
      '/api/dinein/sections/' + sectionId + '/items',
      { token: beta, body: { plu_ids: [100] } }
    );
    assert.strictEqual(res.status, 404);
  });

  await check('an unpublished menu is not readable by the public', async () => {
    const res = await call(base, 'GET', '/api/public/dinein/table/' + tablePublicId);
    assert.strictEqual(res.status, 404);
    assert.match(res.body.error, /not open/i);
  });

  await check('a published menu is priced from the live catalogue', async () => {
    await call(base, 'PUT', '/api/dinein/venue', {
      token: alpha,
      body: { is_published: true, ordering_open: true },
    });
    const res = await call(base, 'GET', '/api/public/dinein/table/' + tablePublicId);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.venue.name, 'The Alpha Arms');
    assert.strictEqual(res.body.table.name, 'Bay 1');

    const items = res.body.sections[0].items;
    assert.strictEqual(items.length, 2);
    const fish = items.find((i) => i.plu_id === 100);
    assert.strictEqual(fish.price_minor, 1450, 'read from bo_products, in pence');
  });

  await check('a price changed in the catalogue changes on the phone', async () => {
    await conn.execute(
      'UPDATE bo_products SET price = ? WHERE email = ? AND pluid = ?',
      [15.95, ALPHA.email, 100]
    );
    const res = await call(base, 'GET', '/api/public/dinein/table/' + tablePublicId);
    const fish = res.body.sections[0].items.find((i) => i.plu_id === 100);
    assert.strictEqual(fish.price_minor, 1595);
  });

  // -------------------------------------------------------------------------
  // Ordering
  // -------------------------------------------------------------------------

  let orderPublicId;
  let orderId;

  await check('an order is priced by the server, not by the phone', async () => {
    const menu = await call(base, 'GET', '/api/public/dinein/table/' + tablePublicId);
    const items = menu.body.sections[0].items;
    const fish = items.find((i) => i.plu_id === 100);
    const pud = items.find((i) => i.plu_id === 101);

    const res = await call(
      base,
      'POST',
      '/api/public/dinein/table/' + tablePublicId + '/order',
      {
        body: {
          name: 'Sam',
          lines: [
            // A phone claiming the fish costs a penny. The field is not read.
            { item_id: fish.id, qty: 2, unit_price_minor: 1, price: 0.01 },
            { item_id: pud.id, qty: 1 },
          ],
        },
      }
    );
    assert.strictEqual(res.status, 201);
    // 2 x 15.95 + 1 x 7.00
    assert.strictEqual(res.body.total_minor, 1595 * 2 + 700);
    orderPublicId = res.body.public_id;
  });

  await check('the till is told, and only that venue\'s till', async () => {
    const push = sent.filter((s) => s.message.type === 'dinein.order').pop();
    assert.ok(push, 'something was broadcast');
    assert.strictEqual(push.options.office, ALPHA.email);
  });

  await check('the customer can read their own order back', async () => {
    const res = await call(base, 'GET', '/api/public/dinein/order/' + orderPublicId);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.status, 'placed');
    assert.strictEqual(res.body.table_label, 'Bay 1');
    assert.strictEqual(res.body.lines.length, 2);
  });

  await check('a sold-out item is refused rather than quietly dropped', async () => {
    const menu = await call(base, 'GET', '/api/public/dinein/table/' + tablePublicId);
    const pud = menu.body.sections[0].items.find((i) => i.plu_id === 101);
    await conn.execute('UPDATE dinein_items SET available = 0 WHERE plu_id = ?', [101]);

    const res = await call(
      base,
      'POST',
      '/api/public/dinein/table/' + tablePublicId + '/order',
      { body: { lines: [{ item_id: pud.id, qty: 1 }] } }
    );
    assert.strictEqual(res.status, 409);
    assert.match(res.body.error, /sold out/i);
    await conn.execute('UPDATE dinein_items SET available = 1 WHERE plu_id = ?', [101]);
  });

  await check('an empty basket is refused', async () => {
    const res = await call(
      base,
      'POST',
      '/api/public/dinein/table/' + tablePublicId + '/order',
      { body: { lines: [] } }
    );
    assert.strictEqual(res.status, 400);
  });

  await check('a table with its code turned off will not take an order', async () => {
    await call(base, 'PUT', '/api/floor/tables/' + tableId, {
      token: alpha,
      body: { qr_enabled: false },
    });
    const menu = await call(base, 'GET', '/api/public/dinein/table/' + tablePublicId);
    assert.strictEqual(menu.status, 200, 'the menu still opens');
    assert.strictEqual(menu.body.table.ordering, false, 'and says why it cannot order');

    const res = await call(
      base,
      'POST',
      '/api/public/dinein/table/' + tablePublicId + '/order',
      { body: { lines: [{ item_id: 1, qty: 1 }] } }
    );
    assert.strictEqual(res.status, 403);
    await call(base, 'PUT', '/api/floor/tables/' + tableId, {
      token: alpha,
      body: { qr_enabled: true },
    });
  });

  // -------------------------------------------------------------------------
  // The till's side
  // -------------------------------------------------------------------------

  await check('the till sees what is waiting for it', async () => {
    const res = await call(base, 'GET', '/api/till/dinein/orders', { token: alphaTill });
    assert.strictEqual(res.status, 200);
    const waiting = res.body.filter((o) => o.status === 'placed');
    assert.strictEqual(waiting.length, 1);
    assert.strictEqual(waiting[0].lines.length, 2);
    orderId = waiting[0].id;
  });

  await check('another venue\'s till sees none of it', async () => {
    const res = await call(base, 'GET', '/api/till/dinein/orders', { token: betaTill });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.length, 0);
  });

  await check('accepting twice does not make two kitchen tickets', async () => {
    const first = await call(
      base, 'POST', '/api/till/dinein/orders/' + orderId + '/accepted',
      { token: alphaTill, body: { order_id: 'SALE-1' } }
    );
    assert.strictEqual(first.status, 200);

    const second = await call(
      base, 'POST', '/api/till/dinein/orders/' + orderId + '/accepted',
      { token: alphaTill, body: { order_id: 'SALE-2' } }
    );
    assert.strictEqual(second.status, 409, 'the second press is refused');
    assert.match(second.body.error, /already moved on/i);

    const [[row]] = await conn.query(
      'SELECT order_id FROM dinein_orders WHERE id = ?',
      [orderId]
    );
    assert.strictEqual(row.order_id, 'SALE-1', 'still attached to the first sale');
  });

  await check('another venue cannot move this order along', async () => {
    const res = await call(
      base, 'POST', '/api/till/dinein/orders/' + orderId + '/ready',
      { token: betaTill }
    );
    assert.strictEqual(res.status, 409);
  });

  await check('the till is told where the table is now, not where it was', async () => {
    // The order stored the table's id and the label it had at the time. If the
    // number came out of the order rather than off the table, renumbering
    // between the customer ordering and a clerk accepting would put the food on
    // somebody else's bill — which is the exact fault the whole ids-not-names
    // rule exists to prevent, so it is checked from the till's side too.
    await call(base, 'PUT', '/api/floor/tables/' + tableId, {
      token: alpha,
      body: { table_number: 21 },
    });
    const res = await call(base, 'GET', '/api/till/dinein/orders', {
      token: alphaTill,
    });
    const order = res.body.find((o) => o.id === orderId);
    assert.ok(order, 'the order is still there');
    assert.strictEqual(order.table_number, 21, 'the number tracks the table');
    assert.strictEqual(
      order.table_label,
      'Bay 1',
      'and the label it was placed against is kept as it was'
    );
  });

  await check('a back office session is not a till, and cannot act as one', async () => {
    // requireTerminal refuses a session token on purpose: the two credentials
    // authorise different things and a till token sits on a shop-floor machine.
    // Without this the till routes could quietly have been left on requireAuth,
    // which no real till can satisfy — the failure would have shown up at a
    // counter rather than here.
    const res = await call(base, 'GET', '/api/till/dinein/orders', { token: alpha });
    assert.strictEqual(res.status, 401);
  });

  await check('and an uncommissioned till is refused rather than served', async () => {
    const res = await call(base, 'GET', '/api/till/dinein/orders');
    assert.strictEqual(res.status, 401);
  });

  await check('an order runs accepted then ready then served', async () => {
    const ready = await call(
      base, 'POST', '/api/till/dinein/orders/' + orderId + '/ready',
      { token: alphaTill }
    );
    assert.strictEqual(ready.status, 200);
    const served = await call(
      base, 'POST', '/api/till/dinein/orders/' + orderId + '/served',
      { token: alphaTill }
    );
    assert.strictEqual(served.status, 200);

    const res = await call(base, 'GET', '/api/public/dinein/order/' + orderPublicId);
    assert.strictEqual(res.body.status, 'served');
    assert.ok(res.body.accepted_at, 'the times were stamped');
    assert.ok(res.body.ready_at);
    assert.ok(res.body.served_at);
  });

  await check('a customer cannot withdraw food the kitchen already has', async () => {
    const res = await call(
      base, 'POST', '/api/public/dinein/order/' + orderPublicId + '/cancel'
    );
    assert.strictEqual(res.status, 409);
  });

  await check('a customer can withdraw one nobody has picked up', async () => {
    const menu = await call(base, 'GET', '/api/public/dinein/table/' + tablePublicId);
    const fish = menu.body.sections[0].items.find((i) => i.plu_id === 100);
    const made = await call(
      base,
      'POST',
      '/api/public/dinein/table/' + tablePublicId + '/order',
      { body: { lines: [{ item_id: fish.id, qty: 1 }] } }
    );
    assert.strictEqual(made.status, 201);

    const res = await call(
      base, 'POST', '/api/public/dinein/order/' + made.body.public_id + '/cancel'
    );
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.status, 'cancelled');
  });

  // -------------------------------------------------------------------------
  // The pages themselves
  // -------------------------------------------------------------------------

  await check('the table page is served, and carries its own id', async () => {
    const res = await call(base, 'GET', '/t/' + tablePublicId);
    assert.strictEqual(res.status, 200);
    assert.ok(
      String(res.body).includes(tablePublicId),
      'the document knows which table it is'
    );
  });

  await check('the venue page is served at the venue address', async () => {
    const res = await call(base, 'GET', '/m/the-alpha-arms');
    assert.strictEqual(res.status, 200);
    assert.ok(String(res.body).includes('the-alpha-arms'));
  });

  await check('a code that matches nothing says so', async () => {
    const res = await call(base, 'GET', '/api/public/dinein/table/' + 'f'.repeat(32));
    assert.strictEqual(res.status, 404);
  });

  server.close();
  await pool.end();
  await conn.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await conn.end();

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
}

/**
 * Run a .sql file that contains DELIMITER blocks.
 *
 * DELIMITER is a mysql-client instruction and means nothing to the driver, so
 * the file is split on it: the CREATE PROCEDURE bodies are sent whole, and
 * everything outside them is sent as ordinary multi-statement SQL.
 */
async function runScript(conn, sql) {
  const parts = sql.split(/^DELIMITER\s+(\S+)\s*$/m);
  // parts: [plain, delim, block, delim, block, ...] — the split keeps the
  // captured delimiter, and a block ends where the next DELIMITER resets it.
  let buffer = parts[0];
  for (let i = 1; i < parts.length; i += 2) {
    const delim = parts[i];
    const chunk = parts[i + 1] || '';
    if (delim === ';') {
      buffer += chunk;
      continue;
    }
    if (buffer.trim()) await conn.query(buffer);
    buffer = '';
    for (const statement of chunk.split(delim)) {
      if (statement.trim()) await conn.query(statement);
    }
  }
  if (buffer.trim()) await conn.query(buffer);
}

main().catch((e) => {
  console.error('  FAIL  the test itself fell over');
  console.error(e);
  process.exitCode = 1;
});
