/**
 * Modifiers: which questions a product asks, and who is allowed to say.
 *
 * Run with `npm test`. No MySQL: the queries are answered from a script, as in
 * screens.test.js, because what goes wrong in these routes is not arithmetic —
 * it is tenancy, ordering, and payloads a browser can produce that a till then
 * has to act on in front of a queue.
 *
 * The ordering tests are the ones that matter most. "Singles or doubles" has to
 * be asked before "which mixer", and the order lives in a sort column that a
 * reorder rewrites wholesale — so a test that only checked membership would
 * pass on a list that asks the bar the wrong question first.
 */

const assert = require('assert');
const express = require('express');
const jwt = require('jsonwebtoken');

const {
  modifierRoutes,
  tillModifierRoutes,
  selectionLimits,
  clampInt,
} = require('../src/modifiers');

const SECRET = 'test-secret-not-a-real-one';

function fakePool(script) {
  const asked = [];
  const answer = (sql, params) => {
    asked.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    for (const [pattern, rows] of script) {
      if (sql.includes(pattern)) {
        if (rows instanceof Error) throw rows;
        return [rows, []];
      }
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
      query: async (sql, params) => answer(sql, params),
      execute: async (sql, params) => answer(sql, params),
    }),
  };
}

function appWith(pool, broadcast = () => {}) {
  const app = express();
  app.use(express.json());
  app.use('/api', modifierRoutes({ pool, broadcast, secret: SECRET }));
  app.use('/api', tillModifierRoutes({ pool }));
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

const OFFICE = [
  'FROM offices WHERE id',
  [{ contact_email: 'venue@example.com' }],
];

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log('  ok  ', name);
    passed++;
  } catch (e) {
    console.error('  FAIL', name);
    throw e;
  }
}

(async () => {
  console.log('\nmodifiers');

  // -- the two numbers that are the whole behaviour of a prompt --------------

  await test('a max below the min is raised to meet it, not refused', () => {
    // "at least three, at most one" is incoherent. The minimum is the number
    // the manager typed on purpose, so it wins.
    assert.deepStrictEqual(selectionLimits({ min_select: 3, max_select: 1 }),
      { min: 3, max: 3 });
  });

  await test('a max of zero means no ceiling and survives a low min', () => {
    assert.deepStrictEqual(selectionLimits({ min_select: 2, max_select: 0 }),
      { min: 2, max: 0 });
  });

  await test('nonsense falls back rather than reaching the database', () => {
    assert.deepStrictEqual(selectionLimits({ min_select: 'x', max_select: null }),
      { min: 0, max: 1 });
    assert.strictEqual(clampInt(-5, { min: 0, max: 99, fallback: 0 }), 0);
    assert.strictEqual(clampInt(1e9, { min: 0, max: 99, fallback: 0 }), 99);
  });

  await test('an edit that omits the limits keeps the ones already stored', () => {
    assert.deepStrictEqual(
      selectionLimits({ name: 'Mixers' }, { min_select: 1, max_select: 4 }),
      { min: 1, max: 4 }
    );
  });

  // -- creating a group ------------------------------------------------------

  await test('creating a group creates the screen that holds its answers', async () => {
    const pool = fakePool([
      OFFICE,
      ['COUNT(*) AS count FROM epos_modifier_groups', [{ count: 2 }]],
      ['INSERT INTO epos_screens', { insertId: 55 }],
      ['INSERT INTO epos_modifier_groups', { insertId: 9 }],
    ]);
    const server = await listen(appWith(pool));
    const res = await call(server, 'POST', '/api/modifier-groups', {
      token: sessionToken,
      body: { name: 'Mixers', min_select: 0, max_select: 1 },
    });
    server.close();

    assert.strictEqual(res.status, 201);
    assert.deepStrictEqual(res.body, { id: 9, screen_id: 55 });

    // The screen is a modifier surface, so it can never turn up in the picker
    // of pages a till may open on.
    const screen = pool.asked.find((a) => a.sql.includes('INSERT INTO epos_screens'));
    assert.ok(screen.sql.includes("'modifier'"), 'screen must be a modifier surface');
    // And the group points at it.
    const group = pool.asked.find((a) => a.sql.includes('INSERT INTO epos_modifier_groups'));
    assert.ok(group.params.includes(55), 'group must reference the new screen');
  });

  await test('a duplicate name is a 409, not a 500', async () => {
    const dup = Object.assign(new Error('dup'), { code: 'ER_DUP_ENTRY' });
    const pool = fakePool([
      OFFICE,
      ['COUNT(*) AS count FROM epos_modifier_groups', [{ count: 0 }]],
      ['INSERT INTO epos_screens', dup],
    ]);
    const server = await listen(appWith(pool));
    const res = await call(server, 'POST', '/api/modifier-groups', {
      token: sessionToken,
      body: { name: 'Mixers' },
    });
    server.close();

    assert.strictEqual(res.status, 409);
    assert.match(res.body.error, /already a modifier group/i);
  });

  await test('a group needs a name', async () => {
    const pool = fakePool([OFFICE]);
    const server = await listen(appWith(pool));
    const res = await call(server, 'POST', '/api/modifier-groups', {
      token: sessionToken,
      body: { name: '   ' },
    });
    server.close();
    assert.strictEqual(res.status, 400);
  });

  await test('signing in is required to touch groups', async () => {
    const pool = fakePool([OFFICE]);
    const server = await listen(appWith(pool));
    const res = await call(server, 'GET', '/api/modifier-groups');
    server.close();
    assert.ok(res.status === 401 || res.status === 403, `got ${res.status}`);
  });

  // -- what a product asks ---------------------------------------------------

  await test('the questions a product asks are written in the order given', async () => {
    const pool = fakePool([
      OFFICE,
      ['AND id IN',
        [{ id: 12 }, { id: 4 }, { id: 8 }]],
    ]);
    const server = await listen(appWith(pool));
    const res = await call(server, 'PUT', '/api/products/331/modifiers', {
      token: sessionToken,
      // Doubles, then the mixer, then the dash — the order the bar asks in.
      body: { group_ids: [4, 12, 8] },
    });
    server.close();

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.count, 3);

    const inserts = pool.asked.filter((a) =>
      a.sql.includes('INSERT INTO epos_product_modifiers'));
    assert.deepStrictEqual(
      inserts.map((i) => [i.params[2], i.params[3]]),
      [[4, 0], [12, 1], [8, 2]],
      'group ids must be stored with the sort order they were sent in'
    );

    // Replaced wholesale, so a reorder cannot leave the old order behind.
    assert.ok(
      pool.asked.some((a) => a.sql.includes('DELETE FROM epos_product_modifiers')),
      'the previous list must be cleared first'
    );
  });

  await test("another office's group cannot be attached to this one's product", async () => {
    const pool = fakePool([
      OFFICE,
      // The lookup is scoped to this office, so the stranger's id comes back
      // unmatched however plausible it looked in the request.
      ['AND id IN', [{ id: 4 }]],
    ]);
    const server = await listen(appWith(pool));
    const res = await call(server, 'PUT', '/api/products/331/modifiers', {
      token: sessionToken,
      body: { group_ids: [4, 9999] },
    });
    server.close();

    assert.strictEqual(res.body.count, 1);
    const inserts = pool.asked.filter((a) =>
      a.sql.includes('INSERT INTO epos_product_modifiers'));
    assert.deepStrictEqual(inserts.map((i) => i.params[2]), [4]);
  });

  await test('the same question twice is stored once', async () => {
    const pool = fakePool([
      OFFICE,
      ['AND id IN', [{ id: 4 }]],
    ]);
    const server = await listen(appWith(pool));
    await call(server, 'PUT', '/api/products/331/modifiers', {
      token: sessionToken,
      body: { group_ids: [4, 4, 4] },
    });
    server.close();

    const inserts = pool.asked.filter((a) =>
      a.sql.includes('INSERT INTO epos_product_modifiers'));
    assert.strictEqual(inserts.length, 1);
  });

  await test('clearing every question is allowed', async () => {
    const pool = fakePool([OFFICE]);
    const server = await listen(appWith(pool));
    const res = await call(server, 'PUT', '/api/products/331/modifiers', {
      token: sessionToken,
      body: { group_ids: [] },
    });
    server.close();

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.count, 0);
    assert.ok(
      pool.asked.some((a) => a.sql.includes('DELETE FROM epos_product_modifiers')),
      'an empty list still has to clear what was there'
    );
  });

  // -- what the till reads ---------------------------------------------------

  await test('the till feed keys groups by PLU, in order', async () => {
    const pool = fakePool([
      ['FROM epos_modifier_groups', [
        { id: 4, name: 'Doubles', min_select: 1, max_select: 1, screen_id: 40 },
        { id: 12, name: 'Mixers', min_select: 0, max_select: 1, screen_id: 41 },
      ]],
      ['FROM epos_product_modifiers', [
        { plu_id: 331, group_id: 4 },
        { plu_id: 331, group_id: 12 },
        { plu_id: 902, group_id: 12 },
      ]],
    ]);
    const server = await listen(appWith(pool));
    const res = await call(server, 'GET', '/api/till/modifiers?office=venue@example.com');
    server.close();

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.products, { 331: [4, 12], 902: [12] });
    assert.strictEqual(res.body.groups.length, 2);
  });

  await test('the till feed carries no buttons — they arrive with the screens', async () => {
    const pool = fakePool([
      ['FROM epos_modifier_groups', [
        { id: 4, name: 'Doubles', min_select: 1, max_select: 1, screen_id: 40 },
      ]],
    ]);
    const server = await listen(appWith(pool));
    const res = await call(server, 'GET', '/api/till/modifiers?office=venue@example.com');
    server.close();

    // The group says which screen holds its answers and nothing more. A till
    // that already has every screen must not be sent them twice.
    assert.deepStrictEqual(Object.keys(res.body).sort(), ['groups', 'products']);
    assert.strictEqual(res.body.groups[0].screen_id, 40);
    assert.ok(!('buttons' in res.body.groups[0]));
    assert.ok(
      !pool.asked.some((a) => a.sql.includes('epos_screen_buttons')),
      'the till feed must not query buttons'
    );
  });

  await test('the till feed needs an office and does not need a token', async () => {
    const pool = fakePool([]);
    const server = await listen(appWith(pool));
    const missing = await call(server, 'GET', '/api/till/modifiers');
    const fine = await call(server, 'GET', '/api/till/modifiers?office=venue@example.com');
    server.close();

    assert.strictEqual(missing.status, 400);
    // Unauthenticated on purpose: a terminal reads this the way it reads the
    // catalogue and its screens. If this ever 401s, every till loses its
    // modifiers at once.
    assert.strictEqual(fine.status, 200);
  });

  // -- deleting --------------------------------------------------------------

  await test('deleting a group takes its layout with it', async () => {
    const pool = fakePool([
      OFFICE,
      ['screen_id FROM epos_modifier_groups WHERE id', [{ screen_id: 77 }]],
    ]);
    const server = await listen(appWith(pool));
    const res = await call(server, 'DELETE', '/api/modifier-groups/9', {
      token: sessionToken,
    });
    server.close();

    assert.strictEqual(res.status, 200);
    const dropped = pool.asked.find((a) =>
      a.sql.includes('DELETE FROM epos_screens'));
    assert.ok(dropped, 'the modifier screen must be deleted too');
    // Scoped to the modifier surface, so a mis-stored id can never delete a
    // venue's sale screen.
    assert.ok(dropped.sql.includes("surface = 'modifier'"));
  });

  await test("deleting another office's group is a 404", async () => {
    const pool = fakePool([OFFICE]); // the group lookup finds nothing
    const server = await listen(appWith(pool));
    const res = await call(server, 'DELETE', '/api/modifier-groups/9', {
      token: sessionToken,
    });
    server.close();
    assert.strictEqual(res.status, 404);
  });

  // -- the push --------------------------------------------------------------

  await test('a change tells the tills to reload their screens too', async () => {
    const sent = [];
    const pool = fakePool([
      OFFICE,
      ['AND id IN', [{ id: 4 }]],
    ]);
    const server = await listen(appWith(pool, (msg) => sent.push(msg.type)));
    await call(server, 'PUT', '/api/products/331/modifiers', {
      token: sessionToken,
      body: { group_ids: [4] },
    });
    server.close();

    // Modifiers alone would leave a till holding a prompt whose buttons it
    // never re-fetched.
    assert.ok(sent.includes('modifiers'), 'must push modifiers');
    assert.ok(sent.includes('screens'), 'must push screens');
  });

  console.log(`\nmodifiers: ${passed}/${passed} passed\n`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
