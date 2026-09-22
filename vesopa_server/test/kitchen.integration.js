/**
 * Vesopa Kitchen, end to end, against a real database.
 *
 * `test/kitchen.test.js` stubs the pool and checks who is allowed to call what.
 * This one boots the actual server, drives the whole life of an order — a till
 * fires it, a screen picks it up, bumps it, recalls it — and reads the rows back
 * out of MySQL. It is the half that catches SQL that only fails when a real
 * database is asked to run it: collations, GROUP BY under ONLY_FULL_GROUP_BY,
 * the boolean-in-HAVING trick the board query leans on.
 *
 * It needs a database, so it is deliberately NOT wired to `npm test`. Set one
 * up once:
 *
 *     mysql -u root -e "CREATE DATABASE vesopa_kds_test
 *                       CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci"
 *     mysql -u root vesopa_kds_test < backup/Backup_v1.0.0.sql
 *     for f in schema.sql $(ls schema_*.sql | sort); do
 *       mysql -u root vesopa_kds_test < "$f"
 *     done
 *
 * then run it:
 *
 *     KDS_DB_NAME=vesopa_kds_test KDS_DB_USER=… KDS_DB_PASSWORD=… \
 *       node test/kitchen.integration.js
 *
 * It only ever touches the two offices it creates, and deletes them on the way
 * in and the way out. It will refuse to run against a database whose name does
 * not contain "test".
 */

const assert = require('assert');

// ---- Guards ---------------------------------------------------------------

const DB_NAME = process.env.KDS_DB_NAME || 'vesopa_kds_test';

// A test that seeds and deletes rows must never be pointed at a live database
// by a stray environment variable. The name has to say it is a test one.
if (!/test/i.test(DB_NAME)) {
  console.error(
    `Refusing to run against "${DB_NAME}" — the database name must contain ` +
      '"test". This test creates and deletes rows.'
  );
  process.exit(1);
}

// The server reads its configuration from the environment at require time, so
// this has to be set before it is loaded.
process.env.DB_NAME = DB_NAME;
process.env.DB_HOST = process.env.KDS_DB_HOST || '127.0.0.1';
process.env.DB_PORT = process.env.KDS_DB_PORT || '3306';
process.env.DB_USER = process.env.KDS_DB_USER || 'vesopa_test';
process.env.DB_PASSWORD = process.env.KDS_DB_PASSWORD || 'kds-test-pw';
process.env.JWT_SECRET = 'integration-test-secret-not-a-real-one';
process.env.PORT = process.env.KDS_PORT || '5199';

const bcrypt = require('bcryptjs');
const WebSocket = require('ws');

const { server, pool } = require('../src/server');

const BASE = `http://127.0.0.1:${process.env.PORT}`;

const VENUE = 'kds-test-venue@example.invalid';
const OTHER = 'kds-test-other@example.invalid';

// ---- Harness --------------------------------------------------------------

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${e.message.split('\n')[0]}`);
  }
}

async function call(method, path, { body, token } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: res.status, body: json };
}

/** Everything this test created, in dependency order. */
async function cleanUp() {
  for (const office of [VENUE, OTHER]) {
    await pool.execute('DELETE FROM epos_kitchen_tickets WHERE office = ?', [office]);
    await pool.execute('DELETE FROM epos_kitchen_users WHERE office = ?', [office]);
    await pool.execute('DELETE FROM epos_kitchen_screens WHERE office = ?', [office]);
    await pool.execute('DELETE FROM epos_till_settings WHERE office = ?', [office]);
    await pool.execute('DELETE FROM backoffice_users WHERE email = ?', [office]);
    await pool.execute('DELETE FROM offices WHERE contact_email = ?', [office]);
  }
}

/** An office with a back-office user who can sign in. */
async function seedOffice(email) {
  const [office] = await pool.execute(
    `INSERT INTO offices (name, contact_email, status)
     VALUES (?, ?, 'active')`,
    [`Test venue ${email}`, email]
  );
  await pool.execute(
    `INSERT INTO backoffice_users (name, email, password, approved, role, office_id)
     VALUES (?, ?, ?, 'Y', 'office', ?)`,
    ['Test manager', email, await bcrypt.hash('manager-pw', 10), office.insertId]
  );
  return office.insertId;
}

const uuid = () => require('crypto').randomUUID();

// ---- The run --------------------------------------------------------------

(async () => {
  console.log(`\nVesopa Kitchen — end to end against ${DB_NAME}\n`);

  await cleanUp();
  await seedOffice(VENUE);
  await seedOffice(OTHER);

  // ---- The back office sets the venue up ----------------------------------

  const signIn = await call('POST', '/api/login', {
    body: { email: VENUE, password: 'manager-pw' },
  });
  assert.strictEqual(signIn.status, 200, JSON.stringify(signIn.body));
  const office = signIn.body.token;

  await check('the back office names its stations', async () => {
    const res = await call('PUT', '/api/till-settings', {
      token: office,
      body: { printer_name_kp1: 'Grill', printer_name_kp3: 'Fryer' },
    });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.printer_name_kp1, 'Grill');
    // Every station starts on a printer, which is the compatibility promise:
    // a venue that upgrades and never opens the kitchen page prints as before.
    assert.strictEqual(res.body.kitchen_mode_kp1, 'printer');
  });

  await check('the back office puts two stations on screens', async () => {
    const res = await call('PUT', '/api/till-settings', {
      token: office,
      body: { kitchen_mode_kp1: 'screen', kitchen_mode_kp3: 'both' },
    });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.kitchen_mode_kp1, 'screen');
    assert.strictEqual(res.body.kitchen_mode_kp3, 'both');
    assert.strictEqual(res.body.kitchen_mode_kp2, 'printer', 'others untouched');
  });

  await check('the back office creates a kitchen login', async () => {
    const res = await call('POST', '/api/kitchen/users', {
      token: office,
      body: { username: 'Grill', password: 'grill-pw', display_name: 'Grill screen' },
    });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    // Lower-cased on the way in, so a chef typing "grill" on glass gets in.
    assert.strictEqual(res.body.username, 'grill');
  });

  await check('a duplicate kitchen login is refused', async () => {
    const res = await call('POST', '/api/kitchen/users', {
      token: office,
      body: { username: 'grill', password: 'other-pw' },
    });
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
  });

  let screenId;
  await check('the back office defines a grill screen', async () => {
    const res = await call('POST', '/api/kitchen/screens', {
      token: office,
      body: {
        name: 'Grill',
        stations: ['kp1'],
        warn_seconds: 120,
        late_seconds: 240,
        recall_minutes: 30,
      },
    });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    screenId = res.body.id;

    const list = await call('GET', '/api/kitchen/screens', { token: office });
    const grill = list.body.find((s) => s.id === screenId);
    assert.deepStrictEqual(grill.stations, ['kp1']);
    assert.strictEqual(grill.recall_minutes, 30);
  });

  // ---- A screen signs in ---------------------------------------------------

  let kitchen;
  await check('a screen signs in and is handed the venue', async () => {
    const res = await call('POST', '/api/kitchen/login', {
      body: { office: VENUE, username: 'grill', password: 'grill-pw' },
    });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    kitchen = res.body.token;

    assert.strictEqual(res.body.stationNames.kp1, 'Grill');
    assert.strictEqual(res.body.stationNames.kp3, 'Fryer');
    assert.ok(
      res.body.screens.some((s) => s.name === 'Grill'),
      'the venue’s screens come back with the sign-in'
    );
  });

  await check('a wrong password is refused, vaguely', async () => {
    const res = await call('POST', '/api/kitchen/login', {
      body: { office: VENUE, username: 'grill', password: 'nope' },
    });
    assert.strictEqual(res.status, 401);
    assert.match(res.body.error, /username or password/i);
  });

  // Planted before the first board fetch on purpose. The retention sweep is
  // fired lazily from that fetch, at most once an hour per process — so this is
  // the only window in the run where it can be observed at all.
  const ancient = uuid();
  await pool.execute(
    `INSERT INTO epos_kitchen_tickets (id, office, order_id, placed_at)
     VALUES (?, ?, ?, DATE_SUB(NOW(), INTERVAL 30 DAY))`,
    [ancient, VENUE, uuid()]
  );
  await pool.execute(
    `INSERT INTO epos_kitchen_ticket_lines
       (id, ticket_id, seq, quantity, name, stations)
     VALUES (?, ?, 0, 1, 'Ancient soup', 'kp1')`,
    [uuid(), ancient]
  );
  await pool.execute(
    `INSERT INTO epos_kitchen_ticket_stations (ticket_id, station, status, done_at)
     VALUES (?, 'kp1', 'done', DATE_SUB(NOW(), INTERVAL 30 DAY))`,
    [ancient]
  );

  await check('the board starts empty', async () => {
    const res = await call('GET', '/api/kitchen/board', { token: kitchen });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(
      res.body.tickets,
      [],
      'a month-old completed ticket is well outside any recall window'
    );
    assert.ok(res.body.serverTime, 'the server sends its clock');
  });

  await check('the retention sweep removes what nobody can reach', async () => {
    // Not awaited by the route — housekeeping must never make a screen wait —
    // so give it a moment.
    await new Promise((r) => setTimeout(r, 700));

    const [[t]] = await pool.query(
      'SELECT COUNT(*) AS n FROM epos_kitchen_tickets WHERE id = ?',
      [ancient]
    );
    assert.strictEqual(Number(t.n), 0, 'the month-old ticket is gone');

    const [[l]] = await pool.query(
      'SELECT COUNT(*) AS n FROM epos_kitchen_ticket_lines WHERE ticket_id = ?',
      [ancient]
    );
    assert.strictEqual(Number(l.n), 0, 'its lines cascaded away with it');
  });

  // ---- A till fires an order ----------------------------------------------

  const ticketId = uuid();
  const orderId = uuid();
  const placedAt = new Date(Date.now() - 90_000); // 90 seconds ago

  await check('a till pushes a ticket', async () => {
    const res = await call('POST', '/till/kitchen/tickets', {
      body: {
        id: ticketId,
        office: VENUE,
        order_id: orderId,
        ticket_no: 'A1B2C3',
        kind: 'table',
        table_number: 4,
        room_name: 'Lounge',
        staff_name: 'sophie',
        covers: 2,
        placed_at: placedAt.toISOString(),
        lines: [
          { id: uuid(), name: 'Crispy Chicken Burger', quantity: 1,
            note: 'no tomato', stations: 'kp1' },
          { id: uuid(), name: 'Kids Breakfast', quantity: 1, stations: 'kp1' },
          { id: uuid(), name: 'Chips', quantity: 2, stations: 'kp3' },
        ],
      },
    });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  });

  await check('re-sending the same ticket does not duplicate it', async () => {
    const res = await call('POST', '/till/kitchen/tickets', {
      body: {
        id: ticketId,
        office: VENUE,
        order_id: orderId,
        lines: [{ name: 'Crispy Chicken Burger', quantity: 1, stations: 'kp1' }],
      },
    });
    assert.strictEqual(res.body.status, 'duplicate', JSON.stringify(res.body));

    const [[row]] = await pool.query(
      'SELECT COUNT(*) AS n FROM epos_kitchen_ticket_lines WHERE ticket_id = ?',
      [ticketId]
    );
    assert.strictEqual(Number(row.n), 3, 'still the original three lines');
  });

  await check('the board shows it, with the till’s own time', async () => {
    const res = await call('GET', '/api/kitchen/board', { token: kitchen });
    assert.strictEqual(res.body.tickets.length, 1, JSON.stringify(res.body));

    const t = res.body.tickets[0];
    assert.strictEqual(t.tableNumber, 4);
    assert.strictEqual(t.roomName, 'Lounge');
    assert.strictEqual(t.staffName, 'sophie');
    assert.strictEqual(t.ticketNo, 'A1B2C3');
    assert.strictEqual(t.kind, 'table');
    assert.strictEqual(t.lines.length, 3);
    assert.strictEqual(t.lines[0].note, 'no tomato');
    assert.deepStrictEqual(t.lines[0].stations, ['kp1']);

    // Both stations the lines routed to, and both open.
    assert.deepStrictEqual(
      t.stations.map((s) => s.station).sort(),
      ['kp1', 'kp3']
    );
    assert.ok(t.stations.every((s) => s.status === 'open'));

    // The elapsed clock counts from when the till fired, not when the row
    // landed — a ticket held up by the network is late, and the board must say
    // so rather than restarting its clock.
    const age = Date.now() - new Date(t.placedAt).getTime();
    assert.ok(age > 60_000, `expected ~90s of age, got ${Math.round(age / 1000)}s`);
  });

  await check('another venue cannot see it', async () => {
    const theirs = await call('POST', '/api/login', {
      body: { email: OTHER, password: 'manager-pw' },
    });
    const res = await call('GET', '/api/kitchen/monitor', {
      token: theirs.body.token,
    });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.tickets, [], 'no leak across offices');
  });

  // ---- Bumping -------------------------------------------------------------

  await check('the grill bumps its half; the ticket stays open', async () => {
    const res = await call('POST', `/api/kitchen/tickets/${ticketId}/bump`, {
      token: kitchen,
      body: { stations: ['kp1'] },
    });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));

    const board = await call('GET', '/api/kitchen/board', { token: kitchen });
    const t = board.body.tickets[0];
    const kp1 = t.stations.find((s) => s.station === 'kp1');
    const kp3 = t.stations.find((s) => s.station === 'kp3');

    assert.strictEqual(kp1.status, 'done');
    assert.ok(kp1.doneAt, 'stamped');
    assert.strictEqual(kp1.doneBy, 'Grill screen', 'who bumped it');
    assert.strictEqual(kp3.status, 'open', 'the fryer is still going');
  });

  await check('bumping twice is bumping once', async () => {
    const [[before]] = await pool.query(
      `SELECT done_at FROM epos_kitchen_ticket_stations
        WHERE ticket_id = ? AND station = 'kp1'`,
      [ticketId]
    );
    await call('POST', `/api/kitchen/tickets/${ticketId}/bump`, {
      token: kitchen,
      body: { stations: ['kp1'] },
    });
    const [[after]] = await pool.query(
      `SELECT done_at FROM epos_kitchen_ticket_stations
        WHERE ticket_id = ? AND station = 'kp1'`,
      [ticketId]
    );
    assert.strictEqual(
      String(before.done_at),
      String(after.done_at),
      'a retry must not move the timestamp'
    );
  });

  await check('the fryer finishes and the ticket is complete', async () => {
    await call('POST', `/api/kitchen/tickets/${ticketId}/bump`, {
      token: kitchen,
      body: { stations: ['kp3'] },
    });
    const board = await call('GET', '/api/kitchen/board', { token: kitchen });
    const t = board.body.tickets[0];
    assert.ok(
      t.stations.every((s) => s.status === 'done'),
      'every station done'
    );
    // Still on the board — it is in the recall window, which is the whole point
    // of the Completed tab.
    assert.strictEqual(board.body.tickets.length, 1);
  });

  await check('a completed ticket outside the window drops off', async () => {
    const res = await call('GET', '/api/kitchen/board?minutes=1', {
      token: kitchen,
    });
    // Completed seconds ago, so a one-minute window still holds it. Push the
    // completion back an hour and it should go.
    assert.strictEqual(res.body.tickets.length, 1, 'still inside a 1m window');

    await pool.execute(
      `UPDATE epos_kitchen_ticket_stations
          SET done_at = DATE_SUB(NOW(), INTERVAL 2 HOUR)
        WHERE ticket_id = ?`,
      [ticketId]
    );
    const later = await call('GET', '/api/kitchen/board?minutes=60', {
      token: kitchen,
    });
    assert.deepStrictEqual(later.body.tickets, [], 'aged out of recall');
  });

  await check('recall puts every station back on the board', async () => {
    const res = await call('POST', `/api/kitchen/tickets/${ticketId}/recall`, {
      token: kitchen,
    });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));

    const board = await call('GET', '/api/kitchen/board', { token: kitchen });
    const t = board.body.tickets[0];
    assert.ok(
      t.stations.every((s) => s.status === 'open' && s.doneAt === null),
      'all re-opened and un-stamped'
    );
  });

  await check('rushing sorts a ticket to the front', async () => {
    // A second, newer ticket. Oldest-first would put the original on top.
    const second = uuid();
    await call('POST', '/till/kitchen/tickets', {
      body: {
        id: second,
        office: VENUE,
        order_id: uuid(),
        placed_at: new Date().toISOString(),
        lines: [{ name: 'Soup', quantity: 1, stations: 'kp1' }],
      },
    });

    let board = await call('GET', '/api/kitchen/board', { token: kitchen });
    assert.strictEqual(board.body.tickets[0].id, ticketId, 'oldest first');

    await call('POST', `/api/kitchen/tickets/${second}/rush`, {
      token: kitchen,
      body: { rushed: true },
    });

    board = await call('GET', '/api/kitchen/board', { token: kitchen });
    assert.strictEqual(board.body.tickets[0].id, second, 'rush beats age');
    assert.strictEqual(board.body.tickets[0].rushed, true);

    await pool.execute('DELETE FROM epos_kitchen_tickets WHERE id = ?', [second]);
  });

  await check('one venue cannot bump another’s ticket', async () => {
    const theirLogin = await call('POST', '/api/kitchen/users', {
      token: (await call('POST', '/api/login', {
        body: { email: OTHER, password: 'manager-pw' },
      })).body.token,
      body: { username: 'theirs', password: 'theirs-pw' },
    });
    assert.strictEqual(theirLogin.status, 201, JSON.stringify(theirLogin.body));

    const theirScreen = await call('POST', '/api/kitchen/login', {
      body: { office: OTHER, username: 'theirs', password: 'theirs-pw' },
    });
    const res = await call('POST', `/api/kitchen/tickets/${ticketId}/bump`, {
      token: theirScreen.body.token,
    });
    assert.strictEqual(res.status, 404, 'not found, because not theirs');

    const board = await call('GET', '/api/kitchen/board', { token: kitchen });
    assert.ok(
      board.body.tickets[0].stations.every((s) => s.status === 'open'),
      'ours is untouched'
    );
  });

  // ---- Delivery modes from a commissioned till -----------------------------

  await check('a till may read and set delivery modes', async () => {
    const commissioned = await call('POST', '/api/login', {
      body: { email: VENUE, password: 'manager-pw', terminal: true },
    });
    const terminal = commissioned.body.terminalToken;
    assert.ok(terminal, 'a terminal token is issued when asked for');

    const read = await call('GET', '/till/kitchen/modes', { token: terminal });
    assert.strictEqual(read.body.kp1, 'screen');

    const write = await call('PUT', '/till/kitchen/modes', {
      token: terminal,
      body: { kp2: 'both' },
    });
    assert.strictEqual(write.status, 200, JSON.stringify(write.body));
    assert.strictEqual(write.body.kp2, 'both');
    assert.strictEqual(write.body.kp1, 'screen', 'the others are untouched');
  });

  // ---- The push socket -----------------------------------------------------

  await check('a subscribed socket is told about its own venue only',
    async () => {
      const heard = [];
      const ws = new WebSocket(
        `ws://127.0.0.1:${process.env.PORT}/ws`
      );
      await new Promise((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
      });
      ws.on('message', (raw) => heard.push(JSON.parse(raw.toString())));
      ws.send(JSON.stringify({ type: 'subscribe', office: OTHER }));

      // Give the subscribe a moment to be applied before firing.
      await new Promise((r) => setTimeout(r, 120));

      const fired = uuid();
      await call('POST', '/till/kitchen/tickets', {
        body: {
          id: fired,
          office: VENUE,
          order_id: uuid(),
          lines: [{ name: 'Soup', quantity: 1, stations: 'kp1' }],
        },
      });
      await new Promise((r) => setTimeout(r, 250));
      ws.close();
      await pool.execute('DELETE FROM epos_kitchen_tickets WHERE id = ?', [fired]);

      const leaked = heard.filter((m) => m.type === 'kitchen.ticket');
      assert.strictEqual(
        leaked.length,
        0,
        `a socket subscribed to ${OTHER} heard ${VENUE}: ${JSON.stringify(leaked)}`
      );
    });

  await check('a subscribed socket IS told about a ticket of its own',
    async () => {
      const heard = [];
      const ws = new WebSocket(`ws://127.0.0.1:${process.env.PORT}/ws`);
      await new Promise((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
      });
      ws.on('message', (raw) => heard.push(JSON.parse(raw.toString())));
      ws.send(JSON.stringify({ type: 'subscribe', office: VENUE }));
      await new Promise((r) => setTimeout(r, 120));

      const fired = uuid();
      await call('POST', '/till/kitchen/tickets', {
        body: {
          id: fired,
          office: VENUE,
          order_id: uuid(),
          lines: [{ name: 'Soup', quantity: 1, stations: 'kp1' }],
        },
      });
      await new Promise((r) => setTimeout(r, 250));
      ws.close();
      await pool.execute('DELETE FROM epos_kitchen_tickets WHERE id = ?', [fired]);

      const pushes = heard.filter((m) => m.type === 'kitchen.ticket');
      assert.strictEqual(pushes.length, 1, JSON.stringify(heard));
      assert.strictEqual(pushes[0].id, fired);
    });

  // ---- The credentials stay apart -----------------------------------------

  await check('a kitchen token cannot reach the back office', async () => {
    // The check that matters most, and the one that was wrong: requireAuth used
    // to refuse the terminal scope by name, so the kitchen token walked
    // straight through it.
    const products = await call('GET', '/api/products', { token: kitchen });
    assert.strictEqual(products.status, 401, `got ${products.status}`);

    const users = await call('GET', '/api/kitchen/users', { token: kitchen });
    assert.strictEqual(users.status, 401, `got ${users.status}`);
  });

  await check('a back-office token cannot bump', async () => {
    const res = await call('POST', `/api/kitchen/tickets/${ticketId}/bump`, {
      token: office,
    });
    assert.strictEqual(res.status, 401, `got ${res.status}`);
  });

  // ---- Rows written are the rows expected ---------------------------------

  await check('the ticket in the database looks right', async () => {
    const [[t]] = await pool.query(
      'SELECT * FROM epos_kitchen_tickets WHERE id = ?',
      [ticketId]
    );
    assert.strictEqual(t.office, VENUE);
    assert.strictEqual(t.order_id, orderId);
    assert.strictEqual(t.kind, 'table');
    assert.strictEqual(t.table_number, 4);

    const [lines] = await pool.query(
      'SELECT * FROM epos_kitchen_ticket_lines WHERE ticket_id = ? ORDER BY seq',
      [ticketId]
    );
    // Sequence preserved: a kitchen reads a ticket top to bottom, and a
    // re-sorted ticket is a re-plated dish.
    assert.deepStrictEqual(
      lines.map((l) => l.name),
      ['Crispy Chicken Burger', 'Kids Breakfast', 'Chips']
    );
    assert.deepStrictEqual(lines.map((l) => l.seq), [0, 1, 2]);
    assert.strictEqual(lines[2].stations, 'kp3');
  });

  await check('the office columns join without a collation error', async () => {
    // The trap schema_staff_idle.sql documents: a bare utf8mb4 column on the
    // live server defaults to a collation that will not compare against
    // backoffice_users.email, and it never reproduces on a dev box with
    // different defaults. Proven by actually doing the join.
    const [rows] = await pool.query(
      `SELECT k.username, u.name
         FROM epos_kitchen_users k
         JOIN backoffice_users u ON u.email = k.office
        WHERE k.office = ?`,
      [VENUE]
    );
    assert.ok(rows.length >= 1, 'the join returns rows');

    const [more] = await pool.query(
      `SELECT t.id
         FROM epos_kitchen_tickets t
         JOIN epos_till_settings s ON s.office = t.office
        WHERE t.office = ?`,
      [VENUE]
    );
    assert.ok(more.length >= 1, 'tickets join till settings');
  });

  await check('the board query survives ONLY_FULL_GROUP_BY', async () => {
    // The board groups by ticket and orders by columns of the grouped table.
    // MySQL accepts that only because the grouping key is the primary key —
    // and strict mode is where a query that "works on my machine" stops.
    const conn = await pool.getConnection();
    try {
      await conn.query("SET SESSION sql_mode = 'ONLY_FULL_GROUP_BY,STRICT_ALL_TABLES'");
      const [rows] = await conn.query(
        `SELECT t.id
           FROM epos_kitchen_tickets t
           JOIN epos_kitchen_ticket_stations s ON s.ticket_id = t.id
          WHERE t.office = ?
          GROUP BY t.id
         HAVING SUM(s.status <> 'done') > 0
             OR MAX(s.done_at) >= DATE_SUB(NOW(), INTERVAL ? MINUTE)
          ORDER BY t.rushed DESC, t.placed_at ASC`,
        [VENUE, 60]
      );
      assert.ok(Array.isArray(rows));
    } finally {
      conn.release();
    }
  });

  await check('deleting a ticket takes its lines and stations with it',
    async () => {
      const doomed = uuid();
      await call('POST', '/till/kitchen/tickets', {
        body: {
          id: doomed,
          office: VENUE,
          order_id: uuid(),
          lines: [{ name: 'Soup', quantity: 1, stations: 'kp1' }],
        },
      });
      await pool.execute('DELETE FROM epos_kitchen_tickets WHERE id = ?', [doomed]);

      const [[lines]] = await pool.query(
        'SELECT COUNT(*) AS n FROM epos_kitchen_ticket_lines WHERE ticket_id = ?',
        [doomed]
      );
      const [[states]] = await pool.query(
        'SELECT COUNT(*) AS n FROM epos_kitchen_ticket_stations WHERE ticket_id = ?',
        [doomed]
      );
      assert.strictEqual(Number(lines.n), 0, 'lines cascaded');
      assert.strictEqual(Number(states.n), 0, 'stations cascaded');
    });

  // ---- Done ---------------------------------------------------------------

  await cleanUp();
  console.log(
    `\n${passed} passed, ${failed} failed\n`
  );

  server.close();
  await pool.end();
  process.exit(failed === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error('\nThe run itself failed:\n', e);
  try {
    await cleanUp();
    server.close();
    await pool.end();
  } catch {
    // Already on the way out.
  }
  process.exit(1);
});
