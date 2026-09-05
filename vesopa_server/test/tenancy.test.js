/**
 * One venue's takings never appear in another venue's back office.
 *
 * A customer created a new company, opened its Till Report, and read somebody
 * else's trading: four thousand pounds of bills, a PLU list of dishes their
 * kitchen does not cook, and department names they had never typed — while
 * Products and Departments, the pages that *were* scoped, correctly said
 * "Nothing yet." The catalogue was theirs and the money was everybody's.
 *
 * Six routes were the cause. Every one of them read `epos_orders` with nothing
 * in the WHERE but `closed_at IS NOT NULL`. Three were written
 * `async (_req, res, next)` — the underscore says it plainly: the request was
 * never consulted, so there was nothing in the handler that *could* have
 * narrowed the query.
 *
 * TWO KINDS OF CHECK, BECAUSE ONE OF THEM IS NOT ENOUGH
 *
 * The behavioural half mounts the real routers on a recording pool, calls each
 * route as a signed-in manager, and insists the office's own address was bound
 * into every statement that touched a tenant table. That is what proves the
 * scoping works — a WHERE clause naming a column no value ever reaches is not
 * scoping.
 *
 * The static half sweeps every `pool.query` in src/ for a tenant table with no
 * owner predicate. That is what stops this coming back: the next report route
 * somebody adds is covered by a test written today, before it exists. The
 * behavioural half can only test the routes it knows to call.
 *
 * WHY THE JOINS ARE CHECKED TOO
 *
 * `bo_products.pluid` and `bo_clarks.pin_code` are unique within an office, not
 * across the platform. Joining on either alone borrows another venue's product,
 * group and staff *names* into a report whose figures are correctly scoped —
 * quieter than the leak above, and worse to explain, because the numbers look
 * right.
 */

const assert = require('assert');
const express = require('express');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const path = require('path');

const { backofficeRoutes } = require('../src/backoffice');
const { programmingRoutes } = require('../src/programming');

const SECRET = 'tenancy-test-secret';

/** The office the signed-in manager belongs to, and the one next door. */
const OURS = 'the-bridge@vesopa.co.uk';
const THEIRS = 'someone-else@vesopa.co.uk';

let passed = 0;
const checks = [];
const check = (name, fn) => checks.push({ name, fn });

/** A pool that answers nothing and remembers everything it was asked. */
function recordingPool() {
  const asked = [];
  const answer = (sql, params) => {
    const flat = sql.replace(/\s+/g, ' ').trim();
    asked.push({ sql: flat, params: params || [] });
    // The office lookup behind `tenantEmail`. Everything else may be empty:
    // this is about the questions asked, not the answers.
    if (flat.startsWith('SELECT contact_email FROM offices')) {
      return [[{ contact_email: OURS, name: 'The Bridge' }], []];
    }
    return [[], []];
  };
  return {
    asked,
    query: async (sql, params) => answer(sql, params),
    execute: async (sql, params) => answer(sql, params),
  };
}

/** Tables whose rows belong to one office and must never cross. */
const TENANT_TABLES =
  /\b(epos_orders|epos_order_lines|epos_payments|bo_products|bo_clarks|epos_customers|epos_time_clock)\b/i;

// ---- Behaviour: every route binds the office ------------------------------

const ROUTES = [
  '/api/live',
  '/api/reports',
  '/api/sales',
  '/api/sales-explorer',
  '/api/till-report',
  '/api/bill-report',
];

const listen = (app) =>
  new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });

function mount(pool) {
  const app = express();
  app.use(express.json());
  const deps = { pool, broadcast: () => {}, secret: SECRET };
  app.use('/api', backofficeRoutes(deps));
  app.use('/api', programmingRoutes(deps));
  app.use((err, _req, res, _next) => res.status(500).json({ error: String(err) }));
  return app;
}

/** A manager of office 7, whose contact address the pool reports as OURS. */
const token = jwt.sign(
  { sub: 3, email: 'nicki@thebridge.co.uk', role: 'manager', officeId: 7 },
  SECRET
);

for (const route of ROUTES) {
  check(`${route} asks only for this office's rows`, async () => {
    const pool = recordingPool();
    const server = await listen(mount(pool));
    try {
      const res = await fetch(
        `http://127.0.0.1:${server.address().port}${route}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      assert.strictEqual(res.status, 200, `${route} answered ${res.status}`);
    } finally {
      server.close();
    }

    const touching = pool.asked.filter((q) => TENANT_TABLES.test(q.sql));
    assert.ok(
      touching.length > 0,
      `${route} never read a tenant table — the test is checking nothing`
    );

    for (const q of touching) {
      assert.ok(
        q.params.includes(OURS),
        `${route} read a tenant table without binding the office:\n      ${q.sql.slice(0, 160)}\n      params: ${JSON.stringify(q.params)}`
      );
    }
  });
}

check('a manager cannot read another office by asking for it', async () => {
  // `office_email` is the platform admin's way of inspecting one office. A
  // manager passing it must be ignored, not obeyed.
  const pool = recordingPool();
  const server = await listen(mount(pool));
  try {
    await fetch(
      `http://127.0.0.1:${server.address().port}/api/till-report?office_email=${encodeURIComponent(THEIRS)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
  } finally {
    server.close();
  }

  const touching = pool.asked.filter((q) => TENANT_TABLES.test(q.sql));
  assert.ok(touching.length > 0, 'no tenant query was made');
  for (const q of touching) {
    assert.ok(!q.params.includes(THEIRS), 'the neighbour\'s address was bound');
    assert.ok(q.params.includes(OURS), 'the office was not bound');
  }
});

check('none of it is reachable without signing in', async () => {
  const server = await listen(mount(recordingPool()));
  try {
    for (const route of ROUTES) {
      const res = await fetch(`http://127.0.0.1:${server.address().port}${route}`);
      assert.strictEqual(res.status, 401, `${route} answered ${res.status}`);
    }
  } finally {
    server.close();
  }
});

// ---- Static: no unscoped query anywhere in src/ ---------------------------

/**
 * A predicate that ties rows to an owner. `order_id`/`id` count: a lookup by
 * primary key on a row whose ownership the caller has already checked is
 * scoped by that check, not by a repeated email.
 */
const OWNED =
  /\b(email|email_key|office|office_id)\b|order_id\s*=\s*\?|\bid\s*=\s*\?|reference\s*=\s*\?/i;

/**
 * Some queries build their WHERE somewhere else — `${window}` in reports.js,
 * `${where.join(' AND ')}` in three more — and the owner predicate lives in
 * that fragment rather than in the template. Following the name to where it is
 * assigned is the difference between a check that reads the SQL and one that
 * only reads part of it; without it these four would have to be listed as
 * exceptions, and an exception list is where the next leak hides.
 */
function fragmentIsOwned(src, sql) {
  const names = [...sql.matchAll(/\$\{\s*([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
  return names.some((name) => {
    const assignments = [
      // let window = 'o.email = ? AND ...'
      new RegExp(`\\b(?:let|const|var)\\s+${name}\\s*=\\s*([^;]+);`, 'g'),
      // where.push('o.email = ?')  /  window += ' AND o.email = ?'
      new RegExp(`\\b${name}\\s*(?:\\.push\\(|\\+=)([^;]+);`, 'g'),
    ];
    return assignments.some((re) =>
      [...src.matchAll(re)].some((m) => OWNED.test(m[1]))
    );
  });
}

check('every query on a tenant table names an owner', () => {
  const dir = path.join(__dirname, '..', 'src');
  const offenders = [];

  for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(dir, name), 'utf8');
    for (const m of src.matchAll(/pool\.(?:query|execute)\(\s*`([^`]*)`/g)) {
      const sql = m[1];
      if (!TENANT_TABLES.test(sql)) continue;
      if (OWNED.test(sql) || fragmentIsOwned(src, sql)) continue;
      const line = src.slice(0, m.index).split('\n').length;
      offenders.push(`${name}:${line}  ${sql.replace(/\s+/g, ' ').trim().slice(0, 120)}`);
    }
  }

  assert.deepStrictEqual(
    offenders,
    [],
    `unscoped tenant queries:\n      ${offenders.join('\n      ')}`
  );
});

check('the owner sweep still catches a query that loses its scoping', () => {
  // The sweep above passes. This proves it passes because the source is clean
  // and not because the pattern stopped matching anything — a green check that
  // cannot go red is not a check.
  const leaky = 'SELECT id FROM epos_orders WHERE closed_at IS NOT NULL';
  assert.ok(TENANT_TABLES.test(leaky));
  assert.ok(!OWNED.test(leaky));
  assert.ok(!fragmentIsOwned('const where = [];', leaky));

  // And a fragment that carries the office is followed correctly.
  const viaFragment = 'SELECT id FROM epos_orders WHERE ${where.join(\' AND \')}';
  assert.ok(fragmentIsOwned("const where = ['email = ?'];", viaFragment));
  assert.ok(!fragmentIsOwned("const where = ['closed_at IS NOT NULL'];", viaFragment));
});

check('the report routes consult the request they were handed', () => {
  // `_req` is how all three of these were written when they leaked. The
  // underscore is a promise that the request is unused, and a route that reads
  // a tenant table cannot honestly make it.
  const files = ['backoffice.js', 'programming.js'];
  const bad = [];
  for (const name of files) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', name), 'utf8');
    for (const m of src.matchAll(/router\.(get|post|put|delete)\(\s*'([^']+)'[^\n]*async \(_req/g)) {
      bad.push(`${name}: ${m[1].toUpperCase()} ${m[2]}`);
    }
  }
  assert.deepStrictEqual(bad, [], `routes ignoring their request:\n      ${bad.join('\n      ')}`);
});

// ---- Run -------------------------------------------------------------------

(async () => {
  console.log('Tenancy: one venue never sees another\n');
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
  console.log(`\ntenancy: ${passed}/${checks.length} checks passed`);
})();
