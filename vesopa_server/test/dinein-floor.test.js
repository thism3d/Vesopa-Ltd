/**
 * The floor a customer is shown when they arrive without scanning.
 *
 * WHY THIS IS DRIVEN THROUGH THE ROUTE
 *
 * There is no pure function to point at here. What matters is what leaves the
 * server: which columns are read, which tables are offered, and — the part
 * worth a test on its own — what is *not* sent. The endpoint is public and
 * unauthenticated, so anything it puts in the response is readable by anybody
 * who knows a venue's address.
 *
 * The pool is a stub that answers by matching the SQL it is handed. That makes
 * the test sensitive to the queries actually being made, which is the point: a
 * rewrite that quietly drops the `qr_enabled` filter, or joins the bill itself
 * rather than its existence, fails here rather than on a customer's phone.
 */
const assert = require('assert');
const express = require('express');
const http = require('http');

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${e.message}`);
    process.exitCode = 1;
  }
}

const { dineinRoutes } = require('../src/dinein');

// ---------------------------------------------------------------------------
// A floor to answer with
// ---------------------------------------------------------------------------

const ROOMS = [
  { id: 1, name: 'Bar', sort_order: 0, outline: null, cols: 12, rows: 8 },
  { id: 2, name: 'Terrace', sort_order: 1, outline: null, cols: 10, rows: 6 },
];

const TABLES = [
  // In the plan, takes orders.
  { id: 11, room_id: 1, table_number: '1', label: null, name: 'By the window',
    public_id: 'aaa', qr_enabled: 1, pos_x: 2, pos_y: 3, width: 2, height: 2,
    shape: 'circle', seats: 4 },
  { id: 12, room_id: 1, table_number: '2', label: 'T2', name: null,
    public_id: 'bbb', qr_enabled: 1, pos_x: 6, pos_y: 3, width: 2, height: 1,
    shape: 'rect', seats: 2 },
  { id: 13, room_id: 2, table_number: '9', label: null, name: null,
    public_id: 'ccc', qr_enabled: 1, pos_x: 1, pos_y: 1, width: 1, height: 1,
    shape: 'rect', seats: null },
];

/**
 * A pool that answers by the shape of the query.
 *
 * Every call is recorded, because "which columns did it ask for" is half of
 * what is being checked.
 */
function stubPool(over = {}) {
  const calls = [];
  const answer = (sql, params) => {
    calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    if (/FROM dinein_venue/.test(sql)) {
      return over.venue === null
        ? [[]]
        : [[over.venue || { office_id: 7, display_name: 'The Vesopa Kitchen', is_published: 1 }]];
    }
    if (/FROM offices/.test(sql)) return [[{ contact_email: 'kitchen@example.com' }]];
    if (/FROM floor_rooms/.test(sql)) return [over.rooms || ROOMS];
    if (/FROM floor_tables/.test(sql)) {
      // The stub applies the filter the route asked for, rather than pretending
      // it was applied: a route that stopped filtering would then be visible.
      let rows = over.tables || TABLES;
      if (/qr_enabled = 1/.test(sql)) rows = rows.filter((t) => t.qr_enabled === 1);
      if (/public_id IS NOT NULL/.test(sql)) rows = rows.filter((t) => t.public_id);
      return [rows];
    }
    if (/FROM epos_open_bills/.test(sql)) return [over.open || []];
    return [[]];
  };
  return {
    calls,
    query: async (sql, params) => answer(sql, params),
    execute: async (sql, params) => answer(sql, params),
  };
}

/** The route, mounted for real, asked for one path. */
function get(pool, path) {
  const app = express();
  app.use(dineinRoutes({ pool, broadcast() {}, secret: 'test-secret' }));
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      http.get({ port: server.address().port, path }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          server.close();
          let json = null;
          try { json = JSON.parse(body); } catch { /* left null */ }
          resolve({ status: res.statusCode, body: json, raw: body });
        });
      }).on('error', (e) => { server.close(); reject(e); });
    });
  });
}

(async () => {
  console.log('\nThe floor a customer picks a table from\n');

  // -------------------------------------------------------------------------
  // What is sent
  // -------------------------------------------------------------------------

  await check('a published venue answers with its rooms and its tables', async () => {
    const pool = stubPool();
    const { status, body } = await get(pool, '/api/public/dinein/floor/vesopakitchen');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.rooms.length, 2);
    assert.strictEqual(body.tables.length, 3);
    assert.strictEqual(body.venue.name, 'The Vesopa Kitchen');
  });

  await check('each table carries the code that ordering needs', async () => {
    const { body } = await get(stubPool(), '/api/public/dinein/floor/vesopakitchen');
    // Without this the picker can draw a plan and then have nowhere to post to:
    // the order endpoint is addressed by a table's public id and nothing else.
    for (const t of body.tables) {
      assert.ok(t.public_id, 'a table arrived with no code');
    }
    assert.deepStrictEqual(body.tables.map((t) => t.public_id), ['aaa', 'bbb', 'ccc']);
  });

  await check('a table is named the way the till names it', async () => {
    const { body } = await get(stubPool(), '/api/public/dinein/floor/vesopakitchen');
    const names = body.tables.map((t) => t.name);
    // Name, then label, then the number — the same order of preference the rest
    // of the system uses, so the table on the phone reads as the table on the
    // screen the food is carried towards.
    assert.deepStrictEqual(names, ['By the window', 'T2', 'Table 9']);
  });

  await check('positions come through so the plan is the room', async () => {
    const { body } = await get(stubPool(), '/api/public/dinein/floor/vesopakitchen');
    const first = body.tables[0];
    assert.strictEqual(first.x, 2);
    assert.strictEqual(first.y, 3);
    assert.strictEqual(first.w, 2);
    assert.strictEqual(first.h, 2);
    assert.strictEqual(first.shape, 'circle');
    assert.strictEqual(first.seats, 4);
    assert.strictEqual(first.room_id, 1);
  });

  await check('a shape the designer never set still draws as something', async () => {
    const pool = stubPool({
      tables: [{ ...TABLES[0], shape: null }],
    });
    const { body } = await get(pool, '/api/public/dinein/floor/vesopakitchen');
    assert.strictEqual(body.tables[0].shape, 'rect');
  });

  // -------------------------------------------------------------------------
  // What is not sent
  // -------------------------------------------------------------------------

  await check('nothing about the open bill leaves the server', async () => {
    const pool = stubPool({
      open: [{ table_number: '1', room_id: 1 }],
    });
    const { raw } = await get(pool, '/api/public/dinein/floor/vesopakitchen');
    // This endpoint has no credential in front of it. A total, a staff name or
    // a line count on it would be the contents of somebody else's dinner,
    // readable by anybody who knows the venue's address.
    for (const leak of ['total', 'staff', 'clerk', 'covers', 'payload', 'line_count']) {
      assert.ok(!raw.includes(leak), `the response mentions ${leak}`);
    }
  });

  await check('the bill query asks only whether one exists', async () => {
    const pool = stubPool({ open: [] });
    await get(pool, '/api/public/dinein/floor/vesopakitchen');
    const bills = pool.calls.find((c) => /epos_open_bills/.test(c.sql));
    assert.ok(bills, 'occupancy was never read');
    assert.match(bills.sql, /SELECT DISTINCT table_number, room_id/,
      'the bill query grew columns');
    assert.match(bills.sql, /status <> 'closed'/, 'a closed bill would mark a table busy');
  });

  await check('a venue with no email on the office still gets a plan', async () => {
    // A floor with every table reading free is worth more than a 500. The
    // picker degrades to "we cannot tell you what is in use", which is what it
    // looked like before there was an occupancy flag at all.
    const pool = stubPool();
    const inner = pool.query;
    pool.query = async (sql, params) => (/FROM offices/.test(sql) ? [[]] : inner(sql, params));
    const { status, body } = await get(pool, '/api/public/dinein/floor/vesopakitchen');
    assert.strictEqual(status, 200);
    assert.ok(body.tables.every((t) => t.busy === false));
  });

  // -------------------------------------------------------------------------
  // Occupancy
  // -------------------------------------------------------------------------

  await check('a table with a bill on it is marked, and still offered', async () => {
    const pool = stubPool({ open: [{ table_number: '2', room_id: 1 }] });
    const { body } = await get(pool, '/api/public/dinein/floor/vesopakitchen');
    const busy = body.tables.filter((t) => t.busy);
    assert.deepStrictEqual(busy.map((t) => t.public_id), ['bbb']);
    // Marked, not withheld. The table somebody is already sitting at is the
    // likeliest one they will pick, and a second round joins that same bill.
    assert.strictEqual(body.tables.length, 3);
  });

  await check('a free floor marks nothing', async () => {
    const { body } = await get(stubPool({ open: [] }), '/api/public/dinein/floor/vesopakitchen');
    assert.ok(body.tables.every((t) => t.busy === false));
  });

  // -------------------------------------------------------------------------
  // Which tables are offered at all
  // -------------------------------------------------------------------------

  await check('a table that does not take phone orders is not on the plan', async () => {
    const pool = stubPool({
      tables: [TABLES[0], { ...TABLES[1], qr_enabled: 0 }],
    });
    const { body } = await get(pool, '/api/public/dinein/floor/vesopakitchen');
    // Offering it would draw a table somebody can tap and then be refused by,
    // which is worse than not drawing it.
    assert.deepStrictEqual(body.tables.map((t) => t.public_id), ['aaa']);
  });

  await check('a table with no code printed against it is not on the plan', async () => {
    const pool = stubPool({
      tables: [TABLES[0], { ...TABLES[1], public_id: null }],
    });
    const { body } = await get(pool, '/api/public/dinein/floor/vesopakitchen');
    assert.deepStrictEqual(body.tables.map((t) => t.public_id), ['aaa']);
  });

  await check('the floor is read for one office only', async () => {
    const pool = stubPool();
    await get(pool, '/api/public/dinein/floor/vesopakitchen');
    for (const table of ['floor_rooms', 'floor_tables']) {
      const call = pool.calls.find((c) => c.sql.includes('FROM ' + table));
      assert.ok(call, `${table} was never read`);
      assert.match(call.sql, /WHERE office_id = \?/, `${table} was read across offices`);
      assert.deepStrictEqual(call.params[0], 7);
    }
  });

  // -------------------------------------------------------------------------
  // Venues that should not answer
  // -------------------------------------------------------------------------

  await check('an unknown venue is a 404', async () => {
    const { status } = await get(stubPool({ venue: null }), '/api/public/dinein/floor/nowhere');
    assert.strictEqual(status, 404);
  });

  await check('an unpublished venue does not hand out its floor plan', async () => {
    // A venue still setting itself up has a plan in the designer and no menu
    // for the public. The layout of a room that is not open yet is nobody's
    // business either.
    const pool = stubPool({
      venue: { office_id: 7, display_name: 'Not open yet', is_published: 0 },
    });
    const { status } = await get(pool, '/api/public/dinein/floor/vesopakitchen');
    assert.strictEqual(status, 404);
  });

  await check('the slug is cleaned before it reaches the query', async () => {
    const pool = stubPool();
    await get(pool, '/api/public/dinein/floor/' + encodeURIComponent("Vesopa Kitchen'"));
    const venue = pool.calls.find((c) => /FROM dinein_venue/.test(c.sql));
    assert.strictEqual(venue.params[0], 'vesopa-kitchen');
  });

  console.log(`\n${passed} passed\n`);
})().catch((e) => {
  console.error('FAILED:', e);
  process.exitCode = 1;
});
