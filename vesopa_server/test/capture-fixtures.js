/**
 * Capture a real board response as fixtures for the Flutter tests.
 *
 * The seam most likely to be wrong in this feature is the one between the
 * server's JSON and the Dart models on the kitchen screen — and neither side's
 * own tests cross it. A `TINYINT(1)` arriving as `1` rather than `true`, a
 * `DOUBLE` arriving as `2.5`, a `DATETIME` arriving as a UTC string: all of
 * them are invisible to a test that builds its own input.
 *
 * So rather than hand-writing a fixture and hoping it matches, this plants a
 * venue, fires three deliberately awkward tickets through the real routes, bumps
 * one of them half-way, and writes out the actual bytes the server sends.
 *
 * Needs the same test database as kitchen.integration.js:
 *
 *     KDS_DB_NAME=vesopa_kds_test KDS_DB_USER=… KDS_DB_PASSWORD=…  *       node test/capture-fixtures.js
 *
 * Written to ../vesopa_epos_kitchen/test/fixtures/, read by that app's
 * test/board_test.dart. Re-run it whenever the board's JSON shape changes; the
 * Dart tests will then fail loudly if the two have drifted apart, which is
 * exactly what they are for.
 */

const DB_NAME = process.env.KDS_DB_NAME || 'vesopa_kds_test';

// The same guard kitchen.integration.js has: this seeds and deletes rows, so it
// must never be pointed at a live database by a stray environment variable.
if (!/test/i.test(DB_NAME)) {
  console.error(
    `Refusing to run against "${DB_NAME}" — the database name must contain ` +
      '"test". This script creates and deletes rows.'
  );
  process.exit(1);
}

process.env.DB_NAME = DB_NAME;
process.env.DB_HOST = process.env.KDS_DB_HOST || '127.0.0.1';
process.env.DB_PORT = process.env.KDS_DB_PORT || '3306';
process.env.DB_USER = process.env.KDS_DB_USER || 'vesopa_test';
process.env.DB_PASSWORD = process.env.KDS_DB_PASSWORD || 'kds-test-pw';
process.env.JWT_SECRET = 'capture-fixtures-secret-not-a-real-one';
process.env.PORT = process.env.KDS_PORT || '5202';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const { server, pool } = require('../src/server');

const BASE = `http://127.0.0.1:${process.env.PORT}`;
const OFFICE = 'kds-capture@example.invalid';
const uuid = () => crypto.randomUUID();

async function call(method, p, { body, token } = {}) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, text: await res.text() };
}

(async () => {
  // Clean slate.
  await pool.execute('DELETE FROM epos_kitchen_tickets WHERE office = ?', [OFFICE]);
  await pool.execute('DELETE FROM epos_kitchen_users WHERE office = ?', [OFFICE]);
  await pool.execute('DELETE FROM epos_kitchen_screens WHERE office = ?', [OFFICE]);
  await pool.execute('DELETE FROM epos_till_settings WHERE office = ?', [OFFICE]);
  await pool.execute('DELETE FROM backoffice_users WHERE email = ?', [OFFICE]);
  await pool.execute('DELETE FROM offices WHERE contact_email = ?', [OFFICE]);

  const [office] = await pool.execute(
    "INSERT INTO offices (name, contact_email, status) VALUES (?, ?, 'active')",
    ['The Capture Arms', OFFICE]
  );
  await pool.execute(
    `INSERT INTO backoffice_users (name, email, password, approved, role, office_id)
     VALUES (?, ?, ?, 'Y', 'office', ?)`,
    ['Manager', OFFICE, await bcrypt.hash('pw', 10), office.insertId]
  );

  const login = JSON.parse(
    (await call('POST', '/api/login', { body: { email: OFFICE, password: 'pw' } })).text
  );
  const token = login.token;

  await call('PUT', '/api/till-settings', {
    token,
    body: {
      printer_name_kp1: 'Grill',
      printer_name_kp3: 'Fryer',
      kitchen_mode_kp1: 'screen',
      kitchen_mode_kp3: 'screen',
    },
  });
  await call('POST', '/api/kitchen/users', {
    token,
    body: { username: 'grill', password: 'grill-pw', display_name: 'Grill screen' },
  });
  await call('POST', '/api/kitchen/screens', {
    token,
    body: {
      name: 'Grill', stations: ['kp1'],
      warn_seconds: 300, late_seconds: 600, recall_minutes: 45,
    },
  });
  await call('POST', '/api/kitchen/screens', {
    token,
    body: { name: 'Pass', stations: [], columns_count: 3 },
  });

  // Three tickets, deliberately covering the awkward shapes: a modifier, a
  // multi-station order, a partly-bumped one, and a completed one.
  const t1 = uuid(); // open, grill + fryer, with a modifier
  const t2 = uuid(); // grill done, fryer still going
  const t3 = uuid(); // completed everywhere

  await call('POST', '/till/kitchen/tickets', {
    body: {
      id: t1, office: OFFICE, order_id: uuid(), ticket_no: '7C41A9',
      kind: 'table', table_number: 4, room_name: 'Lounge',
      staff_name: 'sophie', covers: 2, note: 'allergy: nuts',
      placed_at: new Date(Date.now() - 400_000).toISOString(),
      lines: [
        { id: uuid(), name: 'Crispy Chicken Burger', quantity: 1,
          note: 'no tomato, no garlic', stations: 'kp1' },
        { id: uuid(), name: 'Kids Breakfast', quantity: 1, stations: 'kp1' },
        { id: uuid(), name: 'Chips', quantity: 2.5, stations: 'kp3' },
      ],
    },
  });

  await call('POST', '/till/kitchen/tickets', {
    body: {
      id: t2, office: OFFICE, order_id: uuid(), ticket_no: 'B2D3E4',
      kind: 'sale',
      placed_at: new Date(Date.now() - 100_000).toISOString(),
      lines: [
        { id: uuid(), name: 'Crispy Chicken Burger', quantity: 3, stations: 'kp1' },
        { id: uuid(), name: 'Onion Rings', quantity: 1, stations: 'kp3' },
      ],
    },
  });

  await call('POST', '/till/kitchen/tickets', {
    body: {
      id: t3, office: OFFICE, order_id: uuid(), ticket_no: 'F5A6B7',
      kind: 'table', table_number: 8, room_name: 'Bar', staff_name: 'steff',
      placed_at: new Date(Date.now() - 900_000).toISOString(),
      lines: [{ id: uuid(), name: 'Soup', quantity: 1, stations: 'kp1' }],
    },
  });

  const screen = JSON.parse(
    (await call('POST', '/api/kitchen/login', {
      body: { office: OFFICE, username: 'grill', password: 'grill-pw' },
    })).text
  );

  await call('POST', `/api/kitchen/tickets/${t2}/bump`, {
    token: screen.token, body: { stations: ['kp1'] },
  });
  await call('POST', `/api/kitchen/tickets/${t3}/bump`, {
    token: screen.token, body: { stations: [] },
  });
  await call('POST', `/api/kitchen/tickets/${t1}/rush`, {
    token: screen.token, body: { rushed: true },
  });

  const board = await call('GET', '/api/kitchen/board?minutes=60', {
    token: screen.token,
  });

  const out = path.join(
    __dirname, '..', '..', 'vesopa_epos_kitchen', 'test', 'fixtures'
  );
  fs.mkdirSync(out, { recursive: true });

  // The sign-in response minus the token, which is a credential and has no
  // business in a checked-in fixture.
  const profile = { ...screen };
  delete profile.token;

  fs.writeFileSync(
    path.join(out, 'board.json'),
    JSON.stringify(JSON.parse(board.text), null, 2) + '\n'
  );
  fs.writeFileSync(
    path.join(out, 'profile.json'),
    JSON.stringify(profile, null, 2) + '\n'
  );

  console.log(`Wrote ${path.resolve(out)}`);
  console.log(`  board.json    ${board.text.length} bytes, ` +
    `${JSON.parse(board.text).tickets.length} tickets`);
  console.log(`  profile.json  ${profile.screens.length} screens`);

  await pool.execute('DELETE FROM epos_kitchen_tickets WHERE office = ?', [OFFICE]);
  await pool.execute('DELETE FROM epos_kitchen_users WHERE office = ?', [OFFICE]);
  await pool.execute('DELETE FROM epos_kitchen_screens WHERE office = ?', [OFFICE]);
  await pool.execute('DELETE FROM epos_till_settings WHERE office = ?', [OFFICE]);
  await pool.execute('DELETE FROM backoffice_users WHERE email = ?', [OFFICE]);
  await pool.execute('DELETE FROM offices WHERE contact_email = ?', [OFFICE]);

  server.close();
  await pool.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
