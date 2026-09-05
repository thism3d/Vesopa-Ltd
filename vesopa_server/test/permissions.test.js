/**
 * Who may do what, and — more importantly — who may change who may do what.
 *
 * A permission system has one failure that matters more than all the others: a
 * user who can lift their own restrictions. Roles here only ever subtract, so
 * anybody able to edit a role can restore their own access by deleting the one
 * that limits them. That makes the management routes the hole that empties
 * every other one, and it is the first thing checked below.
 *
 * The second is the migration. Every clerk and every login that existed before
 * this feature has no group and no role, and both of those have to keep meaning
 * "as before". A default of deny would have taken the refund key off every
 * member of staff in the country on the morning it shipped, and nobody would
 * have known until somebody tried to give a customer their money back.
 */

const assert = require('assert');
const express = require('express');
const jwt = require('jsonwebtoken');

const {
  TILL_COLUMNS,
  TILL_PERMISSIONS,
  BACKOFFICE_KEYS,
  BACKOFFICE_PERMISSIONS,
  STANDARD_GROUPS,
  STANDARD_ROLES,
  parsePermissions,
  permissionRoutes,
} = require('../src/permissions');

const SECRET = 'permissions-test-secret';
const OFFICE = 'venue@vesopa.co.uk';

let passed = 0;
const checks = [];
const check = (name, fn) => checks.push({ name, fn });

/** A pool that answers from a script and records everything. */
function fakePool(script = []) {
  const asked = [];
  const answer = (sql, params) => {
    const flat = sql.replace(/\s+/g, ' ').trim();
    asked.push({ sql: flat, params: params || [] });
    if (flat.startsWith('SELECT contact_email FROM offices')) {
      return [[{ contact_email: OFFICE }], []];
    }
    for (const [pattern, rows] of script) {
      if (flat.includes(pattern)) return [rows, []];
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
      query: async (sql, params) => answer(sql, params),
    }),
  };
}

const listen = (app) =>
  new Promise((r) => {
    const s = app.listen(0, () => r(s));
  });

function mount(pool) {
  const app = express();
  app.use(express.json());
  app.use('/api', permissionRoutes({ pool, broadcast: () => {}, secret: SECRET }));
  app.use((err, _req, res, _next) => res.status(500).json({ error: String(err) }));
  return app;
}

const tokenFor = (claims) =>
  jwt.sign({ sub: 5, email: 'user@venue.co.uk', role: 'office', officeId: 3, ...claims }, SECRET);

async function call(pool, method, path, { token, body } = {}) {
  const server = await listen(mount(pool));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  } finally {
    server.close();
  }
}

/** A pool whose signed-in user holds exactly `granted`. */
const poolForRole = (granted, extra = []) =>
  fakePool([
    ['FROM backoffice_users u JOIN bo_user_roles r', [{ permissions: JSON.stringify(granted), display_name: 'Test role' }]],
    ...extra,
  ]);

// ---------------------------------------------------------------------------
// The hole that empties every other one
// ---------------------------------------------------------------------------

const MANAGEMENT = [
  ['POST', '/api/permission-groups', { name: 'Anything' }],
  ['PUT', '/api/permission-groups/1', { name: 'Anything' }],
  ['DELETE', '/api/permission-groups/1', null],
  ['POST', '/api/permission-groups/standard', null],
  ['POST', '/api/user-roles', { display_name: 'Anything' }],
  ['PUT', '/api/user-roles/1', { display_name: 'Anything' }],
  ['DELETE', '/api/user-roles/1', null],
  ['POST', '/api/user-roles/standard', null],
];

for (const [method, path, body] of MANAGEMENT) {
  check(`an accountant cannot ${method} ${path}`, async () => {
    // The role the customer described: reports and nothing else. If it can
    // reach any of these it can write itself a new role and read the lot.
    const accountant = STANDARD_ROLES.find((r) => r.display_name === 'Accountant');
    const res = await call(poolForRole(accountant.permissions), method, path, {
      token: tokenFor({}),
      body,
    });
    assert.strictEqual(res.status, 403, `${method} ${path} answered ${res.status}`);
  });
}

check('somebody holding people.edit can', async () => {
  // The other half: a guard that refuses everybody is not a guard, it is an
  // outage.
  const res = await call(poolForRole(['people.edit']), 'POST', '/api/user-roles', {
    token: tokenFor({}),
    body: { display_name: 'Bar Manager', permissions: ['dashboard.view'] },
  });
  assert.strictEqual(res.status, 201);
});

check('and none of it is reachable without signing in', async () => {
  for (const [method, path, body] of MANAGEMENT) {
    const res = await call(fakePool(), method, path, { body });
    assert.strictEqual(res.status, 401, `${method} ${path} answered ${res.status}`);
  }
});

// ---------------------------------------------------------------------------
// Nothing changes for anybody until somebody asks it to
// ---------------------------------------------------------------------------

check('a user with no role is unrestricted, as they were yesterday', async () => {
  // No row comes back from the roles join, which is every user that existed
  // before this feature.
  const res = await call(fakePool(), 'GET', '/api/me/access', { token: tokenFor({}) });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.unrestricted, true);
  assert.strictEqual(res.body.permissions.length, BACKOFFICE_KEYS.size);
});

check('and can still reach the management routes', async () => {
  const res = await call(fakePool(), 'POST', '/api/user-roles/standard', {
    token: tokenFor({}),
  });
  assert.strictEqual(res.status, 201);
});

check('the platform admin is unrestricted without a role row', async () => {
  const res = await call(fakePool(), 'GET', '/api/me/access', {
    token: tokenFor({ role: 'admin', officeId: null }),
  });
  assert.strictEqual(res.body.unrestricted, true);
});

// ---------------------------------------------------------------------------
// Tenancy
// ---------------------------------------------------------------------------

check('roles and groups are read for one office only', async () => {
  for (const path of ['/api/user-roles', '/api/permission-groups']) {
    const pool = fakePool();
    await call(pool, 'GET', path, { token: tokenFor({}) });

    const read = pool.asked.filter((q) => /bo_user_roles|epos_permission_groups/i.test(q.sql));
    assert.ok(read.length, `${path} read nothing`);
    for (const q of read) {
      assert.ok(q.params.includes(OFFICE), `${path} did not bind the office:\n      ${q.sql}`);
    }
  }
});

check('a manager cannot read another office by naming it', async () => {
  const pool = fakePool();
  await call(pool, 'GET', '/api/user-roles?office_email=next-door@vesopa.co.uk', {
    token: tokenFor({}),
  });
  const read = pool.asked.filter((q) => /bo_user_roles/i.test(q.sql));
  for (const q of read) {
    assert.ok(!q.params.includes('next-door@vesopa.co.uk'));
    assert.ok(q.params.includes(OFFICE));
  }
});

// ---------------------------------------------------------------------------
// A role cannot grant what does not exist
// ---------------------------------------------------------------------------

check('an invented permission is dropped on the way in', async () => {
  const pool = poolForRole(['people.edit']);
  await call(pool, 'POST', '/api/user-roles', {
    token: tokenFor({}),
    body: {
      display_name: 'Sneaky',
      permissions: ['dashboard.view', 'billing.take_everyones_money', '*'],
    },
  });

  const insert = pool.asked.find((q) => q.sql.startsWith('INSERT INTO bo_user_roles'));
  const stored = JSON.parse(insert.params[3]);
  assert.deepStrictEqual(stored, ['dashboard.view']);
});

check('and on the way out, so a retired page stops granting anything', () => {
  assert.deepStrictEqual(
    parsePermissions('["dashboard.view","reports.the_old_one"]'),
    ['dashboard.view']
  );
  // Nothing readable at all is nothing granted, rather than a crash.
  assert.deepStrictEqual(parsePermissions('not json'), []);
  assert.deepStrictEqual(parsePermissions(null), []);
  assert.deepStrictEqual(parsePermissions('{"all":true}'), []);
});

check('a duplicate in the list is stored once', async () => {
  const pool = poolForRole(['people.edit']);
  await call(pool, 'POST', '/api/user-roles', {
    token: tokenFor({}),
    body: { display_name: 'Twice', permissions: ['dashboard.view', 'dashboard.view'] },
  });
  const insert = pool.asked.find((q) => q.sql.startsWith('INSERT INTO bo_user_roles'));
  assert.deepStrictEqual(JSON.parse(insert.params[3]), ['dashboard.view']);
});

// ---------------------------------------------------------------------------
// The catalogues themselves
// ---------------------------------------------------------------------------

check('the till list is the obvious ones, and not the Windows ones', () => {
  // The venue was explicit: their old system offered twenty-one and they did
  // not want them all. Anything about administering the machine rather than
  // running the bar is deliberately absent.
  assert.strictEqual(TILL_COLUMNS.length, 11);
  for (const absent of [
    'can_restart_app',
    'can_update_database',
    'can_stop_external_applications',
    'can_sync_tables',
  ]) {
    assert.ok(!TILL_COLUMNS.includes(absent), `${absent} should not be offered`);
  }
  for (const wanted of ['can_refund', 'can_void', 'can_discount', 'is_manager']) {
    assert.ok(TILL_COLUMNS.includes(wanted), `${wanted} is missing`);
  }
});

check('every till permission has a label and an explanation', () => {
  // The switches are read by a manager, not by a developer. A row with no hint
  // is a switch somebody has to guess at, and a guessed switch stays on.
  for (const p of TILL_PERMISSIONS) {
    assert.ok(p.label && p.label.length > 2, `${p.column} has no label`);
    assert.ok(p.hint && p.hint.length > 10, `${p.column} has no hint`);
  }
});

check('the back office list has no duplicate keys', () => {
  const flat = BACKOFFICE_PERMISSIONS.flatMap((g) => g.keys.map((k) => k.key));
  assert.strictEqual(new Set(flat).size, flat.length);
  assert.strictEqual(new Set(flat).size, BACKOFFICE_KEYS.size);
});

check('every group has a name and at least one key', () => {
  for (const g of BACKOFFICE_PERMISSIONS) {
    assert.ok(g.group, 'a group with no name');
    assert.ok(g.keys.length, `${g.group} is empty`);
    for (const k of g.keys) assert.ok(k.label, `${k.key} has no label`);
  }
});

check('every standard role grants only keys that exist', () => {
  for (const role of STANDARD_ROLES) {
    for (const key of role.permissions) {
      assert.ok(BACKOFFICE_KEYS.has(key), `${role.display_name} grants unknown ${key}`);
    }
  }
});

check('the accountant sees the money and cannot touch anything', () => {
  // The customer's own example, kept honest.
  const accountant = STANDARD_ROLES.find((r) => r.display_name === 'Accountant');
  assert.ok(accountant.permissions.includes('reports.financial_summary'));
  assert.ok(accountant.permissions.includes('reports.till_report'));
  for (const forbidden of [
    'catalogue.edit',
    'programming.edit',
    'people.edit',
    'commerce.edit',
    'people.users',
  ]) {
    assert.ok(
      !accountant.permissions.includes(forbidden),
      `an accountant should not hold ${forbidden}`
    );
  }
});

check('the standard till groups climb rather than overlap', () => {
  const [staff, supervisor, manager] = STANDARD_GROUPS;
  assert.strictEqual(staff.granted.length, 0);
  assert.ok(supervisor.granted.length > staff.granted.length);
  assert.strictEqual(manager.granted.length, TILL_COLUMNS.length);
  // A supervisor runs the floor; refunding and closing the day do not.
  assert.ok(!supervisor.granted.includes('can_refund'));
  assert.ok(!supervisor.granted.includes('can_z_report'));
  assert.ok(supervisor.granted.includes('can_void'));
});

check('the standard groups grant only columns that exist', () => {
  for (const group of STANDARD_GROUPS) {
    for (const column of group.granted) {
      assert.ok(TILL_COLUMNS.includes(column), `${group.name} grants unknown ${column}`);
    }
  }
});

check('the catalogue is served to the browser that draws it', async () => {
  const res = await call(fakePool(), 'GET', '/api/permissions/catalogue', {
    token: tokenFor({}),
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.till.length, TILL_COLUMNS.length);
  assert.strictEqual(res.body.backoffice.length, BACKOFFICE_PERMISSIONS.length);
});

// ---------------------------------------------------------------------------
// Writing a group
// ---------------------------------------------------------------------------

check('a group stores every switch as 0 or 1, never undefined', async () => {
  const pool = poolForRole(['people.edit']);
  await call(pool, 'POST', '/api/permission-groups', {
    token: tokenFor({}),
    body: { name: 'Bar', can_void: true, can_refund: false, nonsense: true },
  });

  const insert = pool.asked.find((q) => q.sql.startsWith('INSERT INTO epos_permission_groups'));
  // email, name, sort_order, then one per column.
  const switches = insert.params.slice(3);
  assert.strictEqual(switches.length, TILL_COLUMNS.length);
  for (const v of switches) assert.ok(v === 0 || v === 1, `stored ${v}`);
  assert.strictEqual(switches[TILL_COLUMNS.indexOf('can_void')], 1);
  assert.strictEqual(switches[TILL_COLUMNS.indexOf('can_refund')], 0);
});

check('a group with no name is refused rather than stored blank', async () => {
  for (const name of ['', '   ', null, undefined]) {
    const res = await call(poolForRole(['people.edit']), 'POST', '/api/permission-groups', {
      token: tokenFor({}),
      body: { name },
    });
    assert.strictEqual(res.status, 400, `"${name}" was accepted`);
  }
});

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

(async () => {
  console.log('Permissions: roles, groups, and who may change them\n');
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
  console.log(`\npermissions: ${passed}/${checks.length} checks passed`);
})();
