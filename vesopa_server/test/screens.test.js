/**
 * Screen programming: who may lay out a venue's till, and what a grid may hold.
 *
 * Run with `npm test`. No MySQL: the queries are answered from a script, which
 * is enough for what actually goes wrong in these routes — tenancy, route
 * ordering, and the fact that everything here is a payload a browser posts and
 * a till then has to draw.
 *
 * The value in most of these is the same as in the kitchen's suite: they are
 * about the request, not about the arithmetic. A span that runs off the grid, a
 * colour with a typo in it, a `kind` nobody has heard of — each is something a
 * person can produce, and each has to come out as a screen that draws rather
 * than as a till showing a red error to a queue.
 */

const assert = require('assert');
const express = require('express');
const jwt = require('jsonwebtoken');

const {
  screensRoutes,
  tillScreenRoutes,
  normaliseButton,
  cleanHex,
  FUNCTION_KEYS,
} = require('../src/screens');

const SECRET = 'test-secret-not-a-real-one';

function fakePool(script) {
  const asked = [];
  const answer = (sql, params) => {
    asked.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    for (const [pattern, rows] of script) {
      if (sql.includes(pattern)) return [rows, []];
    }
    return [[], []];
  };
  return {
    asked,
    query: async (sql, params) => answer(sql, params),
    execute: async (sql, params) => answer(sql, params),
    getConnection: async () => ({
      beginTransaction: async () => {},
      commit: async () => {},
      rollback: async () => {},
      release: () => {},
      execute: async (sql, params) => answer(sql, params),
    }),
  };
}

function appWith(pool, broadcast = () => {}) {
  const app = express();
  app.use(express.json());
  app.use('/api', screensRoutes({ pool, broadcast, secret: SECRET }));
  app.use('/api', tillScreenRoutes({ pool }));
  app.use((err, _req, res, _next) => {
    console.error('route error:', err);
    res.status(500).json({ error: String(err) });
  });
  return app;
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

async function call(server, method, path, { body, token } = {}) {
  const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, body: json };
}

const sessionToken = jwt.sign(
  { sub: 1, email: 'boss@example.com', role: 'office', officeId: 7 },
  SECRET
);
const kitchenToken = jwt.sign(
  { scope: 'kitchen', office: 'venue@example.com', user: 'grill' },
  SECRET
);
const terminalToken = jwt.sign(
  { scope: 'terminal', office: 'venue@example.com', officeId: 7 },
  SECRET
);

const OFFICE = [
  'FROM offices WHERE id',
  [{ contact_email: 'venue@example.com' }],
];
const SCREEN = [
  'FROM epos_screens WHERE id',
  [
    {
      id: 3,
      office: 'venue@example.com',
      name: 'Drinks',
      surface: 'sale',
      grid_rows: 5,
      grid_cols: 6,
      sort_order: 0,
    },
  ],
];

const grid = { rows: 5, cols: 6 };

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.log(`FAIL  ${name}\n      ${e.message}`);
    process.exitCode = 1;
  }
}

(async () => {
  console.log('Screen programming\n');

  // ---- Route ordering ------------------------------------------------------

  // Express matches in definition order. With `/screens/:id` declared first,
  // this arrives as a screen whose id is the string "home", finds nothing and
  // answers 404 for ever — while looking perfectly correct in the source. The
  // same trap the kitchen's /kitchen/monitor was named around.
  await check('PUT /screens/home is not swallowed by /screens/:id', async () => {
    const pool = fakePool([OFFICE, SCREEN]);
    const server = await listen(appWith(pool));
    const res = await call(server, 'PUT', '/api/screens/home', {
      token: sessionToken,
      body: { screenId: 3 },
    });
    server.close();

    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.homeScreenId, 3);
    assert.ok(
      pool.asked.some((q) => q.sql.includes('INSERT INTO epos_till_settings')),
      'the home screen was never written'
    );
  });

  await check('setting home to null falls back to the built-in Default', async () => {
    const pool = fakePool([OFFICE]);
    const server = await listen(appWith(pool));
    const res = await call(server, 'PUT', '/api/screens/home', {
      token: sessionToken,
      body: { screenId: null },
    });
    server.close();

    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.homeScreenId, null);
  });

  // ---- Who may write -------------------------------------------------------

  await check('a kitchen token cannot read a venue’s screens', async () => {
    const server = await listen(appWith(fakePool([OFFICE])));
    const res = await call(server, 'GET', '/api/screens', {
      token: kitchenToken,
    });
    server.close();
    assert.strictEqual(res.status, 401);
  });

  await check('a terminal token cannot lay out a screen', async () => {
    const pool = fakePool([OFFICE, SCREEN]);
    const server = await listen(appWith(pool));
    const res = await call(server, 'PUT', '/api/screens/3/buttons', {
      token: terminalToken,
      body: { buttons: [] },
    });
    server.close();

    assert.strictEqual(res.status, 401);
    assert.ok(
      !pool.asked.some((q) => q.sql.includes('DELETE FROM epos_screen_buttons')),
      'it wrote anyway'
    );
  });

  await check('a screen belonging to another venue is a 404, not a 403', async () => {
    // Scoped in the WHERE clause, so the row simply is not found. Saying 403
    // would confirm the id exists, which is a thing a competitor can enumerate.
    const pool = fakePool([OFFICE]);
    const server = await listen(appWith(pool));
    const res = await call(server, 'GET', '/api/screens/999', {
      token: sessionToken,
    });
    server.close();
    assert.strictEqual(res.status, 404);
  });

  await check('every screen read is scoped to the caller’s office', async () => {
    const pool = fakePool([OFFICE, SCREEN]);
    const server = await listen(appWith(pool));
    await call(server, 'GET', '/api/screens/3', { token: sessionToken });
    server.close();

    const read = pool.asked.find((q) => q.sql.includes('FROM epos_screens WHERE id'));
    assert.ok(read.sql.includes('office = ?'), read.sql);
    assert.ok(read.params.includes('venue@example.com'), JSON.stringify(read.params));
  });

  // ---- The till's own read -------------------------------------------------

  await check('a till reads its screens without a token', async () => {
    const server = await listen(appWith(fakePool([])));
    const res = await call(
      server,
      'GET',
      '/api/till/screens?office=venue%40example.com'
    );
    server.close();

    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(res.body.screens, []);
  });

  await check('a till with no office named is refused', async () => {
    const server = await listen(appWith(fakePool([])));
    const res = await call(server, 'GET', '/api/till/screens');
    server.close();
    assert.strictEqual(res.status, 400);
  });

  // ---- What a button may be ------------------------------------------------

  await check('a button off the grid is dropped, not clamped', async () => {
    // Clamping would silently move it into a cell nobody chose, which is worse
    // than losing it: the layout would look saved and be wrong.
    assert.strictEqual(normaliseButton({ row: 9, col: 0 }, grid), null);
    assert.strictEqual(normaliseButton({ row: 0, col: 99 }, grid), null);
    assert.strictEqual(normaliseButton({ row: -1, col: 0 }, grid), null);
    assert.strictEqual(normaliseButton(null, grid), null);
  });

  await check('a span is clamped to the edge of the grid', async () => {
    const b = normaliseButton(
      { row: 3, col: 4, rowSpan: 9, colSpan: 9, kind: 'blank' },
      grid
    );
    assert.strictEqual(b.row_span, 2, 'rows: 3 + 2 == 5');
    assert.strictEqual(b.col_span, 2, 'cols: 4 + 2 == 6');
  });

  // The one that would put two things on a till button. A button changed from a
  // product to a page must not keep its plu_id, or the renderer has two
  // references to dispatch on and picks whichever it happens to check first.
  await check('changing a button’s kind clears the other kinds’ references', async () => {
    const asPage = normaliseButton(
      { row: 0, col: 0, kind: 'page', pluId: 42, targetScreenId: 3, functionKey: 'qty' },
      grid
    );
    assert.strictEqual(asPage.target_screen_id, 3);
    assert.strictEqual(asPage.plu_id, null);
    assert.strictEqual(asPage.function_key, null);

    const asProduct = normaliseButton(
      { row: 0, col: 0, kind: 'product', pluId: 42, targetScreenId: 3 },
      grid
    );
    assert.strictEqual(asProduct.plu_id, 42);
    assert.strictEqual(asProduct.target_screen_id, null);
  });

  await check('an unknown kind becomes a blank', async () => {
    const b = normaliseButton({ row: 0, col: 0, kind: 'launch_missile' }, grid);
    assert.strictEqual(b.kind, 'blank');
  });

  // Whitelisted because the till dispatches on it. Storing arbitrary text would
  // let a venue fill a screen with keys that do nothing, with nothing to
  // explain why.
  await check('an unknown function key is not stored', async () => {
    const b = normaliseButton(
      { row: 0, col: 0, kind: 'function', functionKey: 'drop_database' },
      grid
    );
    assert.strictEqual(b.function_key, null);
  });

  await check('every whitelisted function key is accepted', async () => {
    for (const key of FUNCTION_KEYS) {
      const b = normaliseButton(
        { row: 0, col: 0, kind: 'function', functionKey: key },
        grid
      );
      assert.strictEqual(b.function_key, key, key);
    }
  });

  await check('a malformed colour becomes null, not itself', async () => {
    for (const bad of ['', '  ', 'red', '#12345', 'javascript:alert(1)']) {
      assert.strictEqual(cleanHex(bad), null, bad);
    }
    assert.strictEqual(cleanHex('A5C715'), '#a5c715');
    assert.strictEqual(cleanHex('#A5C715'), '#a5c715');
  });

  await check('a label is trimmed, capped, and empty becomes null', async () => {
    const b = normaliseButton(
      { row: 0, col: 0, kind: 'blank', label: '  ' + 'x'.repeat(80) + '  ' },
      grid
    );
    assert.strictEqual(b.label.length, 40);
    assert.strictEqual(
      normaliseButton({ row: 0, col: 0, label: '   ' }, grid).label,
      null
    );
  });

  // ---- Saving a layout -----------------------------------------------------

  await check('blanks are not stored — an empty cell is already empty', async () => {
    const pool = fakePool([OFFICE, SCREEN]);
    const server = await listen(appWith(pool));
    await call(server, 'PUT', '/api/screens/3/buttons', {
      token: sessionToken,
      body: {
        buttons: [
          { row: 0, col: 0, kind: 'product', pluId: 1 },
          { row: 0, col: 1, kind: 'blank' },
          { row: 0, col: 2, kind: 'blank', label: 'still blank' },
        ],
      },
    });
    server.close();

    const inserts = pool.asked.filter((q) =>
      q.sql.includes('INSERT INTO epos_screen_buttons')
    );
    assert.strictEqual(inserts.length, 1, `${inserts.length} rows written`);
  });

  await check('a layout is replaced wholesale, inside a transaction', async () => {
    const pool = fakePool([OFFICE, SCREEN]);
    const server = await listen(appWith(pool));
    await call(server, 'PUT', '/api/screens/3/buttons', {
      token: sessionToken,
      body: { buttons: [{ row: 1, col: 1, kind: 'product', pluId: 7 }] },
    });
    server.close();

    const order = pool.asked.map((q) => q.sql);
    const del = order.findIndex((s) => s.includes('DELETE FROM epos_screen_buttons'));
    const ins = order.findIndex((s) => s.includes('INSERT INTO epos_screen_buttons'));
    assert.ok(del >= 0, 'the old layout was never cleared');
    assert.ok(ins > del, 'the new buttons went in before the old ones came out');
  });

  await check('two buttons on one cell do not fail the save', async () => {
    // The editor cannot produce this; a hand-rolled request can, and refusing
    // the whole layout over it helps nobody. Last one wins.
    const pool = fakePool([OFFICE, SCREEN]);
    const server = await listen(appWith(pool));
    const res = await call(server, 'PUT', '/api/screens/3/buttons', {
      token: sessionToken,
      body: {
        buttons: [
          { row: 0, col: 0, kind: 'product', pluId: 1 },
          { row: 0, col: 0, kind: 'product', pluId: 2 },
        ],
      },
    });
    server.close();

    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const inserts = pool.asked.filter((q) =>
      q.sql.includes('INSERT INTO epos_screen_buttons')
    );
    assert.strictEqual(inserts.length, 1);
    assert.ok(inserts[0].params.includes(2), 'the later button did not win');
  });

  // ---- Deleting ------------------------------------------------------------

  // Two things point at a screen, and both have to be cleaned or a venue is
  // left with a key that goes nowhere and a home screen that does not exist.
  await check('deleting a screen clears what pointed at it', async () => {
    const pool = fakePool([OFFICE, SCREEN]);
    const server = await listen(appWith(pool));
    await call(server, 'DELETE', '/api/screens/3', { token: sessionToken });
    server.close();

    const sql = pool.asked.map((q) => q.sql).join('\n');
    assert.ok(
      sql.includes("SET kind = 'blank', target_screen_id = NULL"),
      'page buttons pointing at it were left dangling'
    );
    assert.ok(
      sql.includes('SET home_screen_id = NULL'),
      'the venue’s home screen was left pointing at a deleted screen'
    );
  });

  // ---- Telling the tills ---------------------------------------------------

  await check('a saved layout is pushed to this venue only', async () => {
    const sent = [];
    const pool = fakePool([OFFICE, SCREEN]);
    const server = await listen(
      appWith(pool, (msg, opts) => sent.push({ msg, opts }))
    );
    await call(server, 'PUT', '/api/screens/3/buttons', {
      token: sessionToken,
      body: { buttons: [] },
    });
    server.close();

    const push = sent.find((s) => s.msg.type === 'screens');
    assert.ok(push, 'nothing was broadcast');
    assert.strictEqual(push.opts.office, 'venue@example.com');
  });

  // The home screen lives on the till-settings row, which the tills already
  // watch. Broadcasting `screens` for it would leave every till still reading
  // the old home screen until something else happened to move.
  await check('changing the home screen pushes till-settings, not screens', async () => {
    const sent = [];
    const pool = fakePool([OFFICE, SCREEN]);
    const server = await listen(
      appWith(pool, (msg, opts) => sent.push({ msg, opts }))
    );
    await call(server, 'PUT', '/api/screens/home', {
      token: sessionToken,
      body: { screenId: 3 },
    });
    server.close();

    assert.ok(
      sent.some((s) => s.msg.type === 'till-settings'),
      'the tills were never told'
    );
  });

  console.log(`\n${passed} checks passed`);
})();
