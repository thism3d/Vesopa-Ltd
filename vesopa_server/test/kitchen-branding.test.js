/**
 * White-label branding: who may change it, and what they may change it to.
 *
 * Run with `npm test`. No MySQL is needed — the queries are answered from a
 * script, which is enough for what actually goes wrong here: a shared password
 * on a wall being able to reach further than it should, and a value typed in an
 * office being able to leave a kitchen unable to draw a board.
 *
 * Two of these checks exist because of specific hazards in this codebase rather
 * than as general good manners, and both are noted where they sit: the
 * mount-order shadowing that `/kitchen/monitor` was named around, and the fact
 * that kitchen branding shares a table with the *receipt* designer.
 */

const assert = require('assert');
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const { kitchenRoutes, kitchenAppRoutes } = require('../src/kitchen');

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
  };
}

/**
 * Mounted in the same order as server.js — the back office first.
 *
 * That order is the whole point of one of the checks below, so it is not a
 * detail of the harness: getting it wrong here would make the test pass while
 * the live server failed.
 */
function appWith(pool, broadcast = () => {}) {
  const app = express();
  app.use(express.json());
  app.use('/api', kitchenRoutes({ pool, broadcast, secret: SECRET }));
  app.use('/api', kitchenAppRoutes({ pool, broadcast, secret: SECRET }));
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

const kitchenToken = jwt.sign(
  { scope: 'kitchen', office: 'venue@example.com', user: 'grill', name: 'Grill' },
  SECRET
);
const sessionToken = jwt.sign(
  { sub: 1, email: 'boss@example.com', role: 'office', officeId: 7 },
  SECRET
);

/** A pool that knows one kitchen login, with the given password. */
async function poolWithLogin(password, extra = []) {
  const hash = await bcrypt.hash(password, 10);
  return fakePool([
    ['FROM epos_kitchen_users', [{ password: hash, active: 1 }]],
    ['FROM offices WHERE id', [{ contact_email: 'venue@example.com' }]],
    ...extra,
  ]);
}

/** The write a branding save actually made, if any. */
function brandingWrite(pool) {
  return pool.asked.find((q) => q.sql.includes('INSERT INTO epos_branding'));
}

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
  console.log('Kitchen branding\n');

  // ---- The screen's own door ----------------------------------------------

  // The hazard this is guarding is mount order, not authorisation. Both routers
  // are mounted under /api with the back office's first, so if the screen's
  // save shared the path `/kitchen/branding`, requireAuth would sit in front of
  // it — refuse the kitchen token, end the request, and never fall through to
  // the handler that would have served it. It would fail as 401 "not signed
  // in", in a kitchen, while the same save from the back office worked.
  //
  // This is the same trap `/kitchen/monitor` was named around. It is checked
  // rather than commented because the next person to add a screen-writable
  // setting will reach for the short path.
  await check('a screen’s branding save is not shadowed by the back office', async () => {
    const pool = await poolWithLogin('correct-horse');
    const server = await listen(appWith(pool));
    const res = await call(server, 'PUT', '/api/kitchen/profile/branding', {
      token: kitchenToken,
      body: { password: 'correct-horse', appName: 'Bell Kitchen' },
    });
    server.close();

    assert.notStrictEqual(
      res.status,
      401,
      'the back office router swallowed the screen’s save'
    );
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  });

  await check('a screen cannot use the back office’s branding path', async () => {
    const pool = await poolWithLogin('correct-horse');
    const server = await listen(appWith(pool));
    const res = await call(server, 'PUT', '/api/kitchen/branding', {
      token: kitchenToken,
      body: { password: 'correct-horse', appName: 'Bell Kitchen' },
    });
    server.close();

    assert.strictEqual(res.status, 401);
    assert.strictEqual(brandingWrite(pool), undefined, 'it wrote anyway');
  });

  // ---- The password ------------------------------------------------------

  // 200 with the answer in the body, not 401. A wrong password and an expired
  // token send a chef to two different places, and a screen that cannot tell
  // them apart tells somebody their password is wrong when what actually
  // happened is that the screen needs signing in again.
  await check('a wrong password is a 200 with ok:false, not a 401', async () => {
    const pool = await poolWithLogin('correct-horse');
    const server = await listen(appWith(pool));
    const res = await call(server, 'POST', '/api/kitchen/verify', {
      token: kitchenToken,
      body: { password: 'not-the-password' },
    });
    server.close();

    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.ok, false);
  });

  await check('the right password verifies', async () => {
    const pool = await poolWithLogin('correct-horse');
    const server = await listen(appWith(pool));
    const res = await call(server, 'POST', '/api/kitchen/verify', {
      token: kitchenToken,
      body: { password: 'correct-horse' },
    });
    server.close();

    assert.strictEqual(res.body.ok, true);
  });

  await check('an empty password never verifies', async () => {
    const pool = await poolWithLogin('correct-horse');
    const server = await listen(appWith(pool));
    const res = await call(server, 'POST', '/api/kitchen/verify', {
      token: kitchenToken,
      body: { password: '' },
    });
    server.close();

    assert.strictEqual(res.body.ok, false);
  });

  await check('a turned-off login cannot verify, even with the right password', async () => {
    const hash = await bcrypt.hash('correct-horse', 10);
    const pool = fakePool([
      ['FROM epos_kitchen_users', [{ password: hash, active: 0 }]],
    ]);
    const server = await listen(appWith(pool));
    const res = await call(server, 'POST', '/api/kitchen/verify', {
      token: kitchenToken,
      body: { password: 'correct-horse' },
    });
    server.close();

    assert.strictEqual(res.body.ok, false);
  });

  // 403, not 401, for the same reason. A mistyped password must not tell a
  // screen to sign in again — that throws away a token it cannot get back
  // without the venue's office email.
  await check('a wrong password on a save is 403, and writes nothing', async () => {
    const pool = await poolWithLogin('correct-horse');
    const server = await listen(appWith(pool));
    const res = await call(server, 'PUT', '/api/kitchen/profile/branding', {
      token: kitchenToken,
      body: { password: 'wrong', appName: 'Bell Kitchen' },
    });
    server.close();

    assert.strictEqual(res.status, 403, JSON.stringify(res.body));
    assert.strictEqual(brandingWrite(pool), undefined, 'it wrote anyway');
  });

  // ---- What a write may touch --------------------------------------------

  // The load-bearing one. Kitchen branding lives on `epos_branding`, which also
  // carries the *receipt* designer's venue name, logo and layout. A screen on a
  // wall that could name its own columns could restyle every VAT receipt the
  // venue hands a customer — so the update is built from a whitelist rather
  // than from the request body.
  await check('a save cannot reach the receipt’s own columns', async () => {
    const pool = await poolWithLogin('correct-horse');
    const server = await listen(appWith(pool));
    await call(server, 'PUT', '/api/kitchen/profile/branding', {
      token: kitchenToken,
      body: {
        password: 'correct-horse',
        appName: 'Bell Kitchen',
        // All of these are real columns on the same row.
        venue_name: 'Not The Bell',
        logo_url: '/uploads/evil.png',
        footer_message: 'Refunds are not given',
        vat_number: 'GB000000000',
        show_powered_by: 0,
      },
    });
    server.close();

    const write = brandingWrite(pool);
    assert.ok(write, 'nothing was written at all');
    for (const forbidden of [
      'venue_name',
      'logo_url',
      'footer_message',
      'vat_number',
      '`show_powered_by`',
    ]) {
      assert.ok(
        !write.sql.includes(forbidden),
        `a screen wrote to ${forbidden}: ${write.sql}`
      );
    }
    assert.ok(write.sql.includes('kitchen_app_name'), write.sql);
  });

  // The one route that writes files stays behind a session. A kiosk in full
  // screen with no keyboard is a poor place to browse a filesystem anyway.
  await check('a screen cannot set the logo, even in a valid save', async () => {
    const pool = await poolWithLogin('correct-horse');
    const server = await listen(appWith(pool));
    await call(server, 'PUT', '/api/kitchen/profile/branding', {
      token: kitchenToken,
      body: {
        password: 'correct-horse',
        appName: 'Bell Kitchen',
        logoUrl: '/uploads/anything.png',
      },
    });
    server.close();

    const write = brandingWrite(pool);
    assert.ok(
      !write.sql.includes('kitchen_logo_url'),
      `a screen set the logo: ${write.sql}`
    );
  });

  // ---- What a value may be -----------------------------------------------

  await check('the hold is clamped to six seconds', async () => {
    const pool = fakePool([
      ['FROM offices WHERE id', [{ contact_email: 'venue@example.com' }]],
    ]);
    const server = await listen(appWith(pool));
    await call(server, 'PUT', '/api/kitchen/branding', {
      token: sessionToken,
      body: { splashMs: 60000 },
    });
    server.close();

    const write = brandingWrite(pool);
    assert.ok(write.params.includes(6000), JSON.stringify(write.params));
  });

  await check('a negative hold becomes none at all', async () => {
    const pool = fakePool([
      ['FROM offices WHERE id', [{ contact_email: 'venue@example.com' }]],
    ]);
    const server = await listen(appWith(pool));
    await call(server, 'PUT', '/api/kitchen/branding', {
      token: sessionToken,
      body: { splashMs: -4000 },
    });
    server.close();

    const write = brandingWrite(pool);
    assert.ok(write.params.includes(0), JSON.stringify(write.params));
  });

  // Every screen in the venue parses this string. A malformed one must be
  // dropped here rather than sent to a wall to be discovered at service.
  await check('a malformed colour is stored as empty, not as itself', async () => {
    const pool = fakePool([
      ['FROM offices WHERE id', [{ contact_email: 'venue@example.com' }]],
    ]);
    const server = await listen(appWith(pool));
    await call(server, 'PUT', '/api/kitchen/branding', {
      token: sessionToken,
      body: { splashBg: 'javascript:alert(1)', accent: '#12345' },
    });
    server.close();

    const write = brandingWrite(pool);
    assert.ok(
      !write.params.some((p) => String(p).includes('javascript')),
      JSON.stringify(write.params)
    );
    assert.ok(!write.params.includes('#12345'), JSON.stringify(write.params));
  });

  await check('a good colour is stored, with its hash and in lower case', async () => {
    const pool = fakePool([
      ['FROM offices WHERE id', [{ contact_email: 'venue@example.com' }]],
    ]);
    const server = await listen(appWith(pool));
    await call(server, 'PUT', '/api/kitchen/branding', {
      token: sessionToken,
      body: { accent: 'A5C715' },
    });
    server.close();

    const write = brandingWrite(pool);
    assert.ok(write.params.includes('#a5c715'), JSON.stringify(write.params));
  });

  // ---- Reading ------------------------------------------------------------

  // A venue that has never opened the receipt designer has no row at all. The
  // read must answer with the defaults rather than throwing, or a screen cannot
  // sign in — the branding is bundled into the profile response.
  await check('a venue with no branding row reads as the standard look', async () => {
    const pool = fakePool([
      ['FROM offices WHERE id', [{ contact_email: 'venue@example.com' }]],
    ]);
    const server = await listen(appWith(pool));
    const res = await call(server, 'GET', '/api/kitchen/branding', {
      token: sessionToken,
    });
    server.close();

    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.appName, '');
    assert.strictEqual(res.body.logoUrl, null);
    assert.strictEqual(res.body.splashEnabled, true);
  });

  // The venue's trading name is a better second choice than nothing: a screen
  // showing a logo and "The Bell" is branded, and one showing a logo alone is
  // ambiguous in a group that runs four sites.
  await check('an empty tagline falls back to the venue’s receipt name', async () => {
    const pool = fakePool([
      ['FROM offices WHERE id', [{ contact_email: 'venue@example.com' }]],
      [
        'FROM epos_branding',
        [
          {
            venue_name: 'The Bell',
            logo_url: '/uploads/receipt.png',
            kitchen_tagline: '',
            kitchen_app_name: 'Bell Kitchen',
            kitchen_splash_enabled: 1,
            kitchen_splash_ms: 1800,
            kitchen_show_powered_by: 1,
          },
        ],
      ],
    ]);
    const server = await listen(appWith(pool));
    const res = await call(server, 'GET', '/api/kitchen/branding', {
      token: sessionToken,
    });
    server.close();

    assert.strictEqual(res.body.tagline, 'The Bell');
    // And the receipt's logo stands in for a kitchen logo nobody has set.
    assert.strictEqual(res.body.logoUrl, '/uploads/receipt.png');
  });

  await check('a kitchen logo overrides the receipt’s', async () => {
    const pool = fakePool([
      ['FROM offices WHERE id', [{ contact_email: 'venue@example.com' }]],
      [
        'FROM epos_branding',
        [
          {
            venue_name: 'The Bell',
            logo_url: '/uploads/receipt.png',
            kitchen_logo_url: '/uploads/kitchen.png',
            kitchen_splash_enabled: 1,
            kitchen_splash_ms: 1800,
            kitchen_show_powered_by: 1,
          },
        ],
      ],
    ]);
    const server = await listen(appWith(pool));
    const res = await call(server, 'GET', '/api/kitchen/branding', {
      token: sessionToken,
    });
    server.close();

    assert.strictEqual(res.body.logoUrl, '/uploads/kitchen.png');
  });

  // The screen reads branding as part of its profile, bundled with the screens
  // and station names — one round trip on a venue's wifi rather than four. If
  // this seam breaks, every wall silently reverts to the Vesopa look.
  await check('a screen’s profile carries the venue’s branding', async () => {
    const pool = fakePool([
      ['FROM offices WHERE contact_email', [{ name: 'The Bell', status: 'active' }]],
      [
        'FROM epos_branding',
        [
          {
            kitchen_app_name: 'Bell Kitchen',
            kitchen_accent: '#00a6a6',
            kitchen_splash_enabled: 1,
            kitchen_splash_ms: 900,
            kitchen_show_powered_by: 0,
          },
        ],
      ],
    ]);
    const server = await listen(appWith(pool));
    const res = await call(server, 'GET', '/api/kitchen/profile', {
      token: kitchenToken,
    });
    server.close();

    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.branding, 'the profile carried no branding');
    assert.strictEqual(res.body.branding.appName, 'Bell Kitchen');
    assert.strictEqual(res.body.branding.accent, '#00a6a6');
    assert.strictEqual(res.body.branding.splashMs, 900);
    assert.strictEqual(res.body.branding.showPoweredBy, false);
  });

  // ---- Deployed ahead of its migration ------------------------------------

  // The one that would take the whole estate down. Branding is bundled into
  // /kitchen/login and /kitchen/profile, so if the read throws — which it does
  // when the server is running ahead of its migration and the kitchen_* columns
  // do not exist yet — no screen in any venue can sign in, over a logo.
  //
  // It has to degrade to the built-in look instead. This is the same class of
  // failure as the schema_printer_names.sql rename in architecture.md §10, and
  // it is a test rather than a comment for the same reason.
  await check('a server ahead of its migration still serves a profile', async () => {
    const pool = {
      asked: [],
      query: async (sql) => {
        if (sql.includes('FROM epos_branding')) {
          const e = new Error("Unknown column 'kitchen_app_name' in 'field list'");
          e.code = 'ER_BAD_FIELD_ERROR';
          throw e;
        }
        if (sql.includes('FROM offices WHERE contact_email')) {
          return [[{ name: 'The Bell', status: 'active' }], []];
        }
        return [[], []];
      },
      execute: async () => [[], []],
    };
    const server = await listen(appWith(pool));
    const res = await call(server, 'GET', '/api/kitchen/profile', {
      token: kitchenToken,
    });
    server.close();

    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.branding, 'the profile carried no branding at all');
    assert.strictEqual(res.body.branding.appName, '');
    assert.strictEqual(res.body.branding.splashEnabled, true);
  });

  // ---- The other screens find out ----------------------------------------

  await check('a save tells the venue’s other screens', async () => {
    const sent = [];
    const pool = await poolWithLogin('correct-horse');
    const server = await listen(
      appWith(pool, (msg, opts) => sent.push({ msg, opts }))
    );
    await call(server, 'PUT', '/api/kitchen/profile/branding', {
      token: kitchenToken,
      body: { password: 'correct-horse', appName: 'Bell Kitchen' },
    });
    server.close();

    const push = sent.find((s) => s.msg.type === 'kitchen.branding');
    assert.ok(push, 'nothing was broadcast');
    // Office-scoped: a venue's branding must not reach another venue's wall.
    assert.strictEqual(push.opts.office, 'venue@example.com');
  });

  console.log(`\n${passed} checks passed`);
})();
