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
  cleanImage,
  cleanEmoji,
  functionKeysFor,
  limitsFor,
  FUNCTION_KEYS,
  BAR_KEYS,
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

  await check('a key’s lettering is bounded, and null means “the till decides”', async () => {
    // A real kind, not a blank. A blank carries nothing but its ground now —
    // see "a reserved space carries nothing but its ground" below — so it is no
    // longer a neutral vehicle for checking what the cleaners do.
    const key = (extra) =>
      normaliseButton(
        { row: 0, col: 0, kind: 'function', functionKey: 'note', ...extra },
        grid
      );
    const plain = key({});
    // The normal case, and it has to cost nothing: most keys are a word on a
    // colour, and a key that has never been given a font must not arrive at a
    // till carrying one.
    assert.strictEqual(plain.font_family, null);
    assert.strictEqual(plain.font_size, null);

    const styled = key({ fontFamily: '  Bebas Neue!! ', fontSize: '22' });
    // A slug, not a family name. Anything that is not one is cut out rather
    // than refused: this ends up naming a font family on a counter, and the
    // till's answer to a name it does not know is to letter the key plainly.
    assert.strictEqual(styled.font_family, 'bebasneue');
    assert.strictEqual(styled.font_size, 22);

    // The column is a TINYINT. A number past 255 would be *stored as something
    // else* rather than refused, which is how a key ends up at 4pt.
    assert.strictEqual(
      key({ fontSize: 900 }).font_size,
      72
    );
    assert.strictEqual(
      key({ fontSize: 2 }).font_size,
      8
    );
    // Empty is not nought. It is "no answer", which is what most keys say.
    assert.strictEqual(
      key({ fontSize: '' }).font_size,
      null
    );
    assert.strictEqual(
      key({ fontSize: 'large' }).font_size,
      null
    );
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
    // A real kind, for the reason given on the lettering check above.
    const b = normaliseButton(
      {
        row: 0,
        col: 0,
        kind: 'function',
        functionKey: 'note',
        label: '  ' + 'x'.repeat(80) + '  ',
      },
      grid
    );
    assert.strictEqual(b.label.length, 40);
    assert.strictEqual(
      normaliseButton(
        { row: 0, col: 0, kind: 'function', functionKey: 'note', label: '   ' },
        grid
      ).label,
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

  // -------------------------------------------------------------------------
  // The bars
  //
  // A bar is a screen: same table, same buttons, same whole-grid save. So what
  // is worth testing is only where it is NOT the same — which keys it accepts,
  // what shape it may be, and the two places a bar and a sale screen must not
  // be allowed to be mistaken for one another.
  // -------------------------------------------------------------------------

  const BAR = [
    'FROM epos_screens WHERE id',
    [
      {
        id: 9,
        office: 'venue@example.com',
        name: 'Counter bar',
        surface: 'bottombar',
        grid_rows: 1,
        grid_cols: 12,
        sort_order: 0,
      },
    ],
  ];

  await check('a bar accepts Pay and a sale screen does not', async () => {
    const onBar = normaliseButton(
      { row: 0, col: 0, kind: 'function', functionKey: 'pay' },
      { rows: 1, cols: 12, surface: 'bottombar' }
    );
    assert.strictEqual(onBar.function_key, 'pay');

    // The reason the whitelist is per surface rather than one longer list: a
    // Pay key in the middle of a page of lagers, one row above Cancel, is a
    // mis-press that costs a venue a bill.
    const onGrid = normaliseButton(
      { row: 0, col: 0, kind: 'function', functionKey: 'pay' },
      grid
    );
    assert.strictEqual(onGrid.function_key, null);
  });

  await check('a live display cannot be placed on a sale grid', async () => {
    const b = normaliseButton(
      { row: 0, col: 0, kind: 'function', functionKey: 'open_bills' },
      grid
    );
    assert.strictEqual(b.function_key, null, 'nothing on the sale grid draws it');
  });

  await check('a sale function still works on a bar', async () => {
    // The bar list is a superset for the ordinary keys, so a venue rebuilding
    // its own bar can place Covers and Notes where they already are.
    for (const key of FUNCTION_KEYS) {
      assert.ok(BAR_KEYS.includes(key), `${key} is missing from the bar list`);
    }
    assert.deepStrictEqual(functionKeysFor('sale'), FUNCTION_KEYS);
    assert.deepStrictEqual(functionKeysFor('topbar'), BAR_KEYS);
  });

  await check('a bar is one or two rows and up to sixteen across', async () => {
    assert.deepStrictEqual(limitsFor('bottombar'), {
      rows: 2,
      cols: 16,
      defRows: 1,
      defCols: 10,
    });
    assert.deepStrictEqual(limitsFor('sale'), {
      rows: 10,
      cols: 12,
      defRows: 5,
      defCols: 6,
    });
  });

  await check('a new bar is created on the surface it was asked for', async () => {
    const pool = fakePool([
      OFFICE,
      ['COALESCE(MAX(sort_order)', [{ next: 0 }]],
      ['INSERT INTO epos_screens', { insertId: 12 }],
      BAR,
    ]);
    const server = await listen(appWith(pool));
    const res = await call(server, 'POST', '/api/screens', {
      token: sessionToken,
      body: { name: 'Counter bar', surface: 'bottombar', rows: 9, cols: 40 },
    });
    server.close();

    assert.strictEqual(res.status, 201);
    const insert = pool.asked.find((a) => a.sql.startsWith('INSERT INTO epos_screens'));
    assert.strictEqual(insert.params[2], 'bottombar');
    // Clamped to a bar's ceilings, not a screen's — nine rows of action bar
    // would leave nothing to sell from.
    assert.strictEqual(insert.params[3], 2);
    assert.strictEqual(insert.params[4], 16);
  });

  await check('a nonsense surface falls back to a sale screen', async () => {
    const pool = fakePool([
      OFFICE,
      ['COALESCE(MAX(sort_order)', [{ next: 0 }]],
      ['INSERT INTO epos_screens', { insertId: 12 }],
      SCREEN,
    ]);
    const server = await listen(appWith(pool));
    await call(server, 'POST', '/api/screens', {
      token: sessionToken,
      body: { name: 'Whatever', surface: 'wallpaper' },
    });
    server.close();

    const insert = pool.asked.find((a) => a.sql.startsWith('INSERT INTO epos_screens'));
    assert.strictEqual(insert.params[2], 'sale');
  });

  await check('a bar cannot be copied into a sale screen', async () => {
    // Half the keys would be dropped on save and the copy would look like it
    // worked. Refused with the reason instead.
    const pool = fakePool([OFFICE, BAR]);
    const server = await listen(appWith(pool));
    const res = await call(server, 'POST', '/api/screens', {
      token: sessionToken,
      body: { name: 'Food', surface: 'sale', copyFromId: 9 },
    });
    server.close();

    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /bottombar/);
  });

  // -------------------------------------------------------------------------
  // What the tills wear
  // -------------------------------------------------------------------------

  await check('/screens/defaults is matched before /screens/:id', async () => {
    // The same trap /screens/home sits above, and the reason the next literal
    // path added here has to go above the parameter too: with `:id` first this
    // arrives as a screen whose id is the string "defaults" and 404s for ever.
    const pool = fakePool([OFFICE, SCREEN]);
    const server = await listen(appWith(pool));
    const res = await call(server, 'PUT', '/api/screens/defaults', {
      token: sessionToken,
      body: { homeScreenId: 3 },
    });
    server.close();

    assert.strictEqual(res.status, 200);
    assert.ok(
      pool.asked.some((a) => a.sql.includes('INSERT INTO epos_till_settings')),
      'the defaults were never written'
    );
  });

  await check('a sale screen cannot be worn as a bottom bar', async () => {
    // A manager who picks the wrong row from a list has to be told at the
    // moment they pick it, not by walking to a till and finding a page of
    // lagers squashed into the bottom two inches of it.
    const pool = fakePool([OFFICE, SCREEN]);
    const server = await listen(appWith(pool));
    const res = await call(server, 'PUT', '/api/screens/defaults', {
      token: sessionToken,
      body: { bottomBarScreenId: 3 },
    });
    server.close();

    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /not a bottombar one/);
  });

  await check('clearing a default back to the built-in is allowed', async () => {
    // null is a real value here, which is why the route checks hasOwnProperty
    // rather than truth — otherwise there would be no way back to the bar the
    // till ships with.
    const pool = fakePool([OFFICE]);
    const server = await listen(appWith(pool));
    const res = await call(server, 'PUT', '/api/screens/defaults', {
      token: sessionToken,
      body: { topBarScreenId: null },
    });
    server.close();

    assert.strictEqual(res.status, 200);
    const write = pool.asked.find((a) => a.sql.includes('INSERT INTO epos_till_settings'));
    assert.deepStrictEqual(write.params, ['venue@example.com', null]);
  });

  await check('setting the defaults pushes till-settings, not screens', async () => {
    const sent = [];
    const pool = fakePool([OFFICE, SCREEN]);
    const server = await listen(
      appWith(pool, (msg, opts) => sent.push({ msg, opts }))
    );
    await call(server, 'PUT', '/api/screens/defaults', {
      token: sessionToken,
      body: { homeScreenId: 3 },
    });
    server.close();

    assert.ok(sent.some((s) => s.msg.type === 'till-settings'));
    assert.ok(!sent.some((s) => s.msg.type === 'screens'));
  });

  await check('another venue’s screen cannot be worn', async () => {
    const pool = fakePool([OFFICE]);
    const server = await listen(appWith(pool));
    const res = await call(server, 'PUT', '/api/screens/defaults', {
      token: sessionToken,
      body: { bottomBarScreenId: 999 },
    });
    server.close();

    assert.strictEqual(res.status, 404);
  });

  await check('a deleted bar stops being worn', async () => {
    // Without this a venue that deletes the bar it was wearing gets tills
    // pointing at a row that is not there — and no foreign key to catch it,
    // deliberately, because a cascade here would take a venue's home screen
    // away as a side effect of tidying up.
    const pool = fakePool([OFFICE, BAR]);
    const server = await listen(appWith(pool));
    await call(server, 'DELETE', '/api/screens/9', { token: sessionToken });
    server.close();

    const cleared = pool.asked.filter((a) =>
      a.sql.includes('top_bar_screen_id = IF')
    );
    assert.strictEqual(cleared.length, 1, 'the tills still wear a deleted bar');
    const pages = pool.asked.filter((a) => a.sql.includes('top_bar_id = IF'));
    assert.strictEqual(pages.length, 1, 'a page still asks for a deleted bar');
  });

  // -------------------------------------------------------------------------
  // The face on a key
  // -------------------------------------------------------------------------

  await check('a picture must live on this server', async () => {
    // The same rule as the idle image, and for the same reason: a till on a
    // venue's own network with no route to the open internet must not be able
    // to end up drawing a broken frame across its sale screen — weeks after the
    // layout was arranged, in front of customers.
    assert.strictEqual(cleanImage('/uploads/burger.png'), '/uploads/burger.png');
    assert.strictEqual(cleanImage('/assets/logo.svg'), '/assets/logo.svg');
    assert.strictEqual(cleanImage('https://example.com/burger.png'), null);
    assert.strictEqual(cleanImage('  '), null);
    assert.strictEqual(cleanImage(undefined), null);
  });

  await check('an emoji is bounded, not policed', async () => {
    assert.strictEqual(cleanEmoji('🍔'), '🍔');
    // A venue that types "1/2" into this box has made a perfectly good key
    // face. A regex that let one through and not the other would be a bug
    // report nobody could act on.
    assert.strictEqual(cleanEmoji('1/2'), '1/2');
    assert.strictEqual(cleanEmoji(''), null);
    assert.ok(cleanEmoji('x'.repeat(50)).length <= 16);
  });

  await check('a key carries its own face through a save', async () => {
    const b = normaliseButton(
      {
        row: 0,
        col: 0,
        kind: 'page',
        targetScreenId: 4,
        emoji: '🍔',
        imageUrl: '/uploads/food.png',
      },
      grid
    );
    // A page key could never carry either of these before, which is why the
    // venue that photographed its menu could not put its own picture on the
    // FOOD key that leads to it.
    assert.strictEqual(b.emoji, '🍔');
    assert.strictEqual(b.image_url, '/uploads/food.png');
  });

  await check('an off-site picture is dropped, not stored', async () => {
    const b = normaliseButton(
      { row: 0, col: 0, kind: 'product', pluId: 1, imageUrl: 'http://evil/x.png' },
      grid
    );
    assert.strictEqual(b.image_url, null);
  });

  // -------------------------------------------------------------------------
  // Reserved space: a blank that holds ground
  // -------------------------------------------------------------------------
  //
  // A manager lays a screen out shapes first and products second — "we usually
  // resize the buttons and then add products and functionality later". That
  // only works if a sized-but-empty key survives a save, which it did not:
  // every blank was dropped on the way to the database.

  await check('a reserved space carries nothing but its ground', async () => {
    const b = normaliseButton(
      {
        row: 1,
        col: 2,
        rowSpan: 2,
        colSpan: 2,
        kind: 'blank',
        // All of this is refused. A colour and a label on a key that draws
        // nothing and cannot be pressed is a key a clerk would try to press.
        label: 'Coming soon',
        fill: '#a5c715',
        ink: '#131a04',
        emoji: 'X',
        imageUrl: '/uploads/x.png',
        fontFamily: 'inter',
        fontSize: 20,
        pluId: 55,
      },
      grid
    );
    assert.strictEqual(b.kind, 'blank');
    assert.strictEqual(b.row_span, 2);
    assert.strictEqual(b.col_span, 2);
    assert.strictEqual(b.label, null);
    assert.strictEqual(b.fill, null);
    assert.strictEqual(b.ink, null);
    assert.strictEqual(b.emoji, null);
    assert.strictEqual(b.image_url, null);
    assert.strictEqual(b.font_family, null);
    assert.strictEqual(b.font_size, null);
    assert.strictEqual(b.plu_id, null);
  });

  await check('a spanning blank is stored and a 1x1 one is not', async () => {
    // The rule the save loop applies, stated here as the thing it is: ground
    // held, or nothing at all. public/screens.js spHoldsSpace() must agree.
    const held = (raw) => {
      const b = normaliseButton(raw, grid);
      return !(b.kind === 'blank' && b.row_span < 2 && b.col_span < 2);
    };
    assert.ok(held({ row: 0, col: 0, rowSpan: 2, colSpan: 1, kind: 'blank' }));
    assert.ok(held({ row: 0, col: 0, rowSpan: 1, colSpan: 3, kind: 'blank' }));
    assert.ok(!held({ row: 0, col: 0, rowSpan: 1, colSpan: 1, kind: 'blank' }));
    // And a real key is stored whatever its size, which is the case this must
    // not have broken.
    assert.ok(held({ row: 0, col: 0, kind: 'product', pluId: 1 }));
  });

  await check('a reserved space is clamped to the grid like any key', async () => {
    const b = normaliseButton(
      { row: 3, col: 4, rowSpan: 9, colSpan: 9, kind: 'blank' },
      grid
    );
    assert.ok(b.grid_row + b.row_span <= grid.rows);
    assert.ok(b.grid_col + b.col_span <= grid.cols);
  });

  // -------------------------------------------------------------------------
  // Framing a picture on a key
  // -------------------------------------------------------------------------

  await check('a key says how its picture sits on it', async () => {
    const b = normaliseButton(
      {
        row: 0,
        col: 0,
        kind: 'product',
        pluId: 4,
        imageUrl: '/uploads/burger.png',
        imageFit: 'contain',
        imageScale: 250,
        imageX: -40,
        imageY: 15,
        showLabel: true,
      },
      grid
    );
    assert.strictEqual(b.image_fit, 'contain');
    assert.strictEqual(b.image_scale, 250);
    assert.strictEqual(b.image_x, -40);
    assert.strictEqual(b.image_y, 15);
    assert.strictEqual(b.show_label, 1);
  });

  await check('an untouched picture says nothing, which is the plain answer', async () => {
    // Null everywhere it has never been set, and null is what every key drew
    // before these columns existed — fill the key, no zoom, centred. A venue
    // that never opens the control must see no change.
    const b = normaliseButton(
      { row: 0, col: 0, kind: 'product', pluId: 4, imageUrl: '/uploads/x.png' },
      grid
    );
    assert.strictEqual(b.image_scale, null);
    assert.strictEqual(b.image_x, null);
    assert.strictEqual(b.image_y, null);
    assert.strictEqual(b.show_label, 0);
    // Except the fit, which has a real default rather than a null one: there
    // are only two answers, and `cover` is the one every key already drew.
    assert.strictEqual(b.image_fit, 'cover');
  });

  await check('the framing is bounded, and the zoom goes below the fit', async () => {
    const framed = (extra) =>
      normaliseButton(
        { row: 0, col: 0, kind: 'product', pluId: 4, ...extra },
        grid
      );
    assert.strictEqual(framed({ imageScale: 9999 }).image_scale, 400);
    // Twenty, not a hundred. A floor at "exactly the fit" means a picture can
    // only ever be cropped and never pulled back to show more of itself, which
    // is the fault the product cropper had to be fixed for: "the images are too
    // zoomed in" was a floor in the wrong place, not a zoom.
    assert.strictEqual(framed({ imageScale: 1 }).image_scale, 20);
    assert.strictEqual(framed({ imageX: -999 }).image_x, -100);
    assert.strictEqual(framed({ imageY: 999 }).image_y, 100);
    // A fit nobody has heard of draws as cover rather than as nothing. A back
    // office one release ahead of a till must leave it drawing a key.
    assert.strictEqual(framed({ imageFit: 'tile' }).image_fit, 'cover');
  });

  console.log(`\n${passed} checks passed`);
})();
