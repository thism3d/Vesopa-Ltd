/**
 * The kitchen routes, against a fake database.
 *
 * Run with `npm test`. No MySQL is needed: every query is recorded and answered
 * from a script, which is enough to exercise what actually goes wrong in these
 * routes — who is allowed to call them, what is written, and what the screen is
 * handed back.
 *
 * It earned its keep on the first run. `requireAuth` refused a *terminal* token
 * by name, so the kitchen token — added later — sailed through it and opened
 * the whole back office to a shared login taped to a kitchen wall. See the
 * "a kitchen token cannot create logins" check, and the note in src/auth.js.
 */

const assert = require('assert');
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const {
  kitchenRoutes,
  kitchenAppRoutes,
  tillKitchenRoutes,
} = require('../src/kitchen');

const SECRET = 'test-secret-not-a-real-one';

/** Answers queries from a scripted list, and remembers what it was asked. */
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
      execute: async (sql, params) => {
        asked.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
        if (sql.includes('INSERT IGNORE INTO epos_kitchen_tickets')) {
          return [{ affectedRows: 1 }, []];
        }
        return [{ affectedRows: 1 }, []];
      },
    }),
  };
}

function appWith(pool, broadcast = () => {}) {
  const app = express();
  app.use(express.json());
  app.use('/api', kitchenRoutes({ pool, broadcast, secret: SECRET }));
  app.use('/api', kitchenAppRoutes({ pool, broadcast, secret: SECRET }));
  app.use(tillKitchenRoutes({ pool, broadcast, secret: SECRET }));
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
  const res = await fetch(
    `http://127.0.0.1:${server.address().port}${path}`,
    {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }
  );
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, body: json };
}

const kitchenToken = jwt.sign(
  { scope: 'kitchen', office: 'venue@example.com', user: 'grill', name: 'Grill' },
  SECRET
);
const sessionToken = jwt.sign(
  { sub: 1, email: 'boss@example.com', role: 'office', officeId: 7 },
  SECRET
);
const terminalToken = jwt.sign(
  { scope: 'terminal', office: 'venue@example.com', officeId: 7 },
  SECRET
);

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
  console.log('Kitchen routes\n');

  // ---- Credentials are not interchangeable --------------------------------

  // Both routers are mounted under /api, and the back-office one first. If they
  // shared a path, requireAuth would sit in front of every screen's board fetch
  // — refusing the kitchen token, ending the request, and never falling through
  // to the router that would have served it. Every screen in every venue would
  // go blank. Hence /kitchen/board and /kitchen/monitor.
  await check('a signed-in screen can read its board', async () => {
    const server = await listen(appWith(fakePool([])));
    const res = await call(server, 'GET', '/api/kitchen/board', {
      token: kitchenToken,
    });
    server.close();
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.ok(Array.isArray(res.body.tickets), 'it is a board');
  });

  await check('a session token cannot read the screens’ board', async () => {
    const server = await listen(appWith(fakePool([])));
    const res = await call(server, 'GET', '/api/kitchen/board', {
      token: sessionToken,
    });
    server.close();
    assert.strictEqual(res.status, 401, `got ${res.status}`);
  });

  await check('a kitchen token cannot read the office monitor', async () => {
    const server = await listen(appWith(fakePool([])));
    const res = await call(server, 'GET', '/api/kitchen/monitor', {
      token: kitchenToken,
    });
    server.close();
    assert.strictEqual(res.status, 401, `got ${res.status}`);
  });

  await check('a kitchen token cannot create logins', async () => {
    const server = await listen(appWith(fakePool([])));
    const res = await call(server, 'POST', '/api/kitchen/users', {
      token: kitchenToken,
      body: { username: 'sneak', password: 'aaaa' },
    });
    server.close();
    assert.strictEqual(res.status, 401, `got ${res.status}`);
  });

  await check('an unsigned screen cannot bump', async () => {
    const server = await listen(appWith(fakePool([])));
    const res = await call(server, 'POST', '/api/kitchen/tickets/abc/bump');
    server.close();
    assert.strictEqual(res.status, 401, `got ${res.status}`);
  });

  // ---- Sign-in -------------------------------------------------------------

  await check('sign-in rejects a wrong password without saying so', async () => {
    const hash = await bcrypt.hash('correct-horse', 10);
    const pool = fakePool([
      ['FROM epos_kitchen_users', [
        { id: 1, username: 'grill', password: hash, display_name: 'Grill', active: 1 },
      ]],
      ['FROM offices', [{ status: 'active', name: 'The Venue' }]],
    ]);
    const server = await listen(appWith(pool));
    const res = await call(server, 'POST', '/api/kitchen/login', {
      body: { office: 'venue@example.com', username: 'grill', password: 'wrong' },
    });
    server.close();
    assert.strictEqual(res.status, 401);
    assert.match(res.body.error, /username or password/i);
    assert.ok(!/password is wrong/i.test(res.body.error), 'must stay vague');
  });

  await check('sign-in returns a token and the venue profile', async () => {
    const hash = await bcrypt.hash('correct-horse', 10);
    const pool = fakePool([
      ['FROM epos_kitchen_users', [
        { id: 1, username: 'grill', password: hash, display_name: 'Grill', active: 1 },
      ]],
      ['FROM offices', [{ status: 'active', name: 'The Venue' }]],
      ['FROM epos_till_settings', [
        { printer_name_kp1: 'Grill', printer_name_kp3: 'Fryer' },
      ]],
      ['FROM epos_kitchen_screens', [
        {
          id: 4, name: 'Grill', stations: 'kp1,kp3', columns_count: 0,
          warn_seconds: 480, late_seconds: 900, recall_minutes: 60,
          sound: 1, sort_order: 0,
        },
      ]],
    ]);
    const server = await listen(appWith(pool));
    const res = await call(server, 'POST', '/api/kitchen/login', {
      body: {
        office: 'venue@example.com',
        username: 'grill',
        password: 'correct-horse',
      },
    });
    server.close();

    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const claims = jwt.verify(res.body.token, SECRET);
    assert.strictEqual(claims.scope, 'kitchen');
    assert.strictEqual(claims.office, 'venue@example.com');
    assert.strictEqual(res.body.stationNames.kp1, 'Grill');
    assert.deepStrictEqual(res.body.screens[0].stations, ['kp1', 'kp3']);
  });

  await check('a paused office cannot sign a screen in', async () => {
    const hash = await bcrypt.hash('correct-horse', 10);
    const pool = fakePool([
      ['FROM epos_kitchen_users', [
        { id: 1, username: 'grill', password: hash, active: 1 },
      ]],
      ['FROM offices', [{ status: 'paused', name: 'The Venue' }]],
    ]);
    const server = await listen(appWith(pool));
    const res = await call(server, 'POST', '/api/kitchen/login', {
      body: {
        office: 'venue@example.com',
        username: 'grill',
        password: 'correct-horse',
      },
    });
    server.close();
    assert.strictEqual(res.status, 402, JSON.stringify(res.body));
  });

  // ---- The till pushing a ticket ------------------------------------------

  await check('a ticket with no screen-bound lines is accepted, not stored',
    async () => {
      const pool = fakePool([]);
      const server = await listen(appWith(pool));
      const res = await call(server, 'POST', '/till/kitchen/tickets', {
        body: { id: 'abc', office: 'venue@example.com', lines: [] },
      });
      server.close();
      assert.strictEqual(res.status, 202);
      assert.ok(
        !pool.asked.some((q) => q.sql.includes('INSERT IGNORE')),
        'nothing should have been written'
      );
    });

  await check('a ticket routed nowhere we know is accepted, not stored',
    async () => {
      const pool = fakePool([]);
      const server = await listen(appWith(pool));
      const res = await call(server, 'POST', '/till/kitchen/tickets', {
        body: {
          id: 'abc',
          office: 'venue@example.com',
          lines: [{ name: 'Chips', quantity: 1, stations: 'kp9' }],
        },
      });
      server.close();
      assert.strictEqual(res.status, 202);
      assert.strictEqual(res.body.status, 'unrouted');
    });

  await check('a ticket is stored, with one station row per station',
    async () => {
      const pool = fakePool([]);
      const sent = [];
      const server = await listen(appWith(pool, (m, o) => sent.push([m, o])));
      const res = await call(server, 'POST', '/till/kitchen/tickets', {
        body: {
          id: 'ticket-1',
          office: 'venue@example.com',
          order_id: 'order-1',
          kind: 'table',
          table_number: 4,
          room_name: 'Lounge',
          staff_name: 'sophie',
          placed_at: new Date().toISOString(),
          lines: [
            { name: 'Burger', quantity: 1, note: 'no tomato', stations: 'kp1' },
            { name: 'Chips', quantity: 2, stations: 'kp3' },
          ],
        },
      });
      server.close();

      assert.strictEqual(res.status, 201, JSON.stringify(res.body));

      const lines = pool.asked.filter((q) =>
        q.sql.includes('INSERT INTO epos_kitchen_ticket_lines')
      );
      assert.strictEqual(lines.length, 2, 'two lines');

      const stations = pool.asked.filter((q) =>
        q.sql.includes('INSERT INTO epos_kitchen_ticket_stations')
      );
      assert.strictEqual(stations.length, 2, 'kp1 and kp3');
      assert.deepStrictEqual(
        stations.map((q) => q.params[1]).sort(),
        ['kp1', 'kp3']
      );

      // Office-scoped, or one venue's dinner shows up on another's wall.
      const [message, options] = sent[0];
      assert.strictEqual(message.type, 'kitchen.ticket');
      assert.strictEqual(options.office, 'venue@example.com');
    });

  // ---- Bumping -------------------------------------------------------------

  await check('a bump closes only the stations the screen watches', async () => {
    const pool = fakePool([
      ['FROM epos_kitchen_tickets WHERE id', [{ id: 'ticket-1' }]],
    ]);
    const server = await listen(appWith(pool));
    const res = await call(server, 'POST', '/api/kitchen/tickets/ticket-1/bump', {
      token: kitchenToken,
      body: { stations: ['kp1'] },
    });
    server.close();

    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const update = pool.asked.find((q) =>
      q.sql.includes('UPDATE epos_kitchen_ticket_stations')
    );
    assert.ok(update.sql.includes('station IN (?)'), update.sql);
    assert.ok(update.params.includes('kp1'));
    // A state assignment, so a retry over a flaky link cannot half-finish it.
    assert.ok(update.sql.includes("status <> 'done'"), update.sql);
  });

  await check('a bump with no stations closes the lot', async () => {
    const pool = fakePool([
      ['FROM epos_kitchen_tickets WHERE id', [{ id: 'ticket-1' }]],
    ]);
    const server = await listen(appWith(pool));
    await call(server, 'POST', '/api/kitchen/tickets/ticket-1/bump', {
      token: kitchenToken,
      body: { stations: [] },
    });
    server.close();

    const update = pool.asked.find((q) =>
      q.sql.includes('UPDATE epos_kitchen_ticket_stations')
    );
    assert.ok(!update.sql.includes('station IN'), update.sql);
  });

  await check('one venue cannot bump another venue’s ticket', async () => {
    // The ticket lookup is scoped by office, so a ticket belonging to somebody
    // else simply is not found.
    const pool = fakePool([]);
    const server = await listen(appWith(pool));
    const res = await call(server, 'POST', '/api/kitchen/tickets/theirs/bump', {
      token: kitchenToken,
    });
    server.close();
    assert.strictEqual(res.status, 404);
    const lookup = pool.asked[0];
    assert.ok(lookup.params.includes('venue@example.com'), 'scoped by office');
  });

  // ---- Delivery modes from a till -----------------------------------------

  await check('a terminal token may set delivery modes', async () => {
    const pool = fakePool([
      ['FROM epos_till_settings', [{ kitchen_mode_kp1: 'screen' }]],
    ]);
    const server = await listen(appWith(pool));
    const res = await call(server, 'PUT', '/till/kitchen/modes', {
      token: terminalToken,
      body: { kp1: 'screen' },
    });
    server.close();

    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.kp1, 'screen');
    // Everything unset reads as printer, which is the compatibility promise.
    assert.strictEqual(res.body.kp2, 'printer');
  });

  await check('a nonsense delivery mode falls back to printer', async () => {
    const pool = fakePool([['FROM epos_till_settings', [{}]]]);
    const server = await listen(appWith(pool));
    await call(server, 'PUT', '/till/kitchen/modes', {
      token: terminalToken,
      body: { kp1: 'carrier-pigeon' },
    });
    server.close();

    const write = pool.asked.find((q) =>
      q.sql.includes('INSERT INTO epos_till_settings')
    );
    assert.ok(write.params.includes('printer'), JSON.stringify(write.params));
  });

  await check('a kitchen token may not set delivery modes', async () => {
    const server = await listen(appWith(fakePool([])));
    const res = await call(server, 'PUT', '/till/kitchen/modes', {
      token: kitchenToken,
      body: { kp1: 'screen' },
    });
    server.close();
    assert.strictEqual(res.status, 401, `got ${res.status}`);
  });

  // ---- Validation ----------------------------------------------------------

  await check('a username with spaces is refused', async () => {
    const server = await listen(appWith(fakePool([
      ['FROM offices WHERE id', [{ contact_email: 'venue@example.com' }]],
    ])));
    const res = await call(server, 'POST', '/api/kitchen/users', {
      token: sessionToken,
      body: { username: 'the grill', password: 'aaaa' },
    });
    server.close();
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
  });

  await check('the routing count says what points at each station', async () => {
    // The number that makes the delivery toggles mean something. A venue rang
    // up because their screens stayed empty, and the answer was that all 64 of
    // their products routed to DRINKS while DRINKS was still set to Printer —
    // ten seconds to see with this on the page, and invisible without it.
    const pool = fakePool([
      ['FROM offices WHERE id', [{ contact_email: 'venue@example.com' }]],
      [
        'FROM bo_products',
        [
          { printer_routes: 'kp1' },
          { printer_routes: 'kp2' },
          // On the grill *and* the pass. Counts for both, not once.
          { printer_routes: 'kp1,kp3' },
          // Junk stations are dropped rather than counted.
          { printer_routes: 'kp9,bar' },
        ],
      ],
    ]);
    const server = await listen(appWith(pool));
    const res = await call(server, 'GET', '/api/kitchen/routing', {
      token: sessionToken,
    });
    server.close();

    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.counts.kp1, 2);
    assert.strictEqual(res.body.counts.kp2, 1);
    assert.strictEqual(res.body.counts.kp3, 1);
    // Present and zero, not missing: the page draws a row for all six.
    assert.strictEqual(res.body.counts.kp4, 0);
    assert.strictEqual(res.body.counts.kp5, 0);
    assert.strictEqual(res.body.counts.kp6, 0);
  });

  await check('the routing count is scoped to the venue', async () => {
    const pool = fakePool([
      ['FROM offices WHERE id', [{ contact_email: 'venue@example.com' }]],
    ]);
    const server = await listen(appWith(pool));
    await call(server, 'GET', '/api/kitchen/routing', { token: sessionToken });
    server.close();

    const q = pool.asked.find((a) => a.sql.includes('FROM bo_products'));
    assert.deepStrictEqual(q.params, ['venue@example.com']);
  });

  await check('an email address is a usable kitchen login', async () => {
    // Venues do use one: the office address is the string everybody on site
    // already knows, so it is what gets written on the card by the screen.
    // The validator used to reject `@`, which made the login a manager asked
    // for impossible to create with no way to tell why from the back office.
    const pool = fakePool([
      ['FROM offices WHERE id', [{ contact_email: 'venue@example.com' }]],
    ]);
    const server = await listen(appWith(pool));
    const res = await call(server, 'POST', '/api/kitchen/users', {
      token: sessionToken,
      body: { username: 'Manager@Vesopa.co.uk', password: 'aaaa' },
    });
    server.close();
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    // Folded to lower case on the way in, because that is what a screen sends
    // and the lookup is an exact match.
    assert.strictEqual(res.body.username, 'manager@vesopa.co.uk');
  });

  await check('a screen’s red always arrives after its amber', async () => {
    const pool = fakePool([
      ['FROM offices WHERE id', [{ contact_email: 'venue@example.com' }]],
    ]);
    const server = await listen(appWith(pool));
    await call(server, 'POST', '/api/kitchen/screens', {
      token: sessionToken,
      body: { name: 'Grill', warn_seconds: 900, late_seconds: 120 },
    });
    server.close();

    const insert = pool.asked.find((q) =>
      q.sql.includes('INSERT INTO epos_kitchen_screens')
    );
    const [, , , , warn, late] = insert.params;
    assert.ok(late > warn, `late ${late} must be after warn ${warn}`);
  });

  console.log(`\n${passed} checks passed`);
})();
