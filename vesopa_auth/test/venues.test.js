/**
 * Venues as organisations — src/venues.js.
 *
 *     node --test test/venues.test.js
 *
 * No database: an in-memory stand-in that answers exactly the statements
 * venues.js sends, with a real rollback, because "a dry run writes nothing" and
 * "a failure half-way writes nothing" are the two claims most worth proving.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// venues.js requires ./db at load, which opens a pool from the server's
// environment. Stand a harmless stub in its place before anything loads it.
const dbPath = path.join(__dirname, '..', 'src', 'db.js');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: {} };

const { provision, validate, InvalidVenue } = require('../src/venues');

// ---- the stand-in -----------------------------------------------------------

function world() {
  return {
    users: [{ id: 4 }],
    identities: [{ user_id: 4, identifier_norm: 'info@vesopasoftware.com', verified: true }],
    orgs: [{ id: 1, public_id: 'VESOPA', name: 'Vesopa Software Ltd', slug: 'vesopa', owner_user_id: 4, external_ref: null }],
    orgMembers: [],
    apps: [
      { id: 1, slug: 'vesopa-epos' },
      { id: 13, slug: 'vesopa-backoffice' },
    ],
    appRoles: [
      { id: 101, application_id: 1, role_key: 'till.operator', is_default: 1 },
      { id: 102, application_id: 1, role_key: 'till.manager', is_default: 0 },
    ],
    appMembers: [],
    memberRoles: [],
    products: [{ id: 1, slug: 'epos' }, { id: 3, slug: 'display' }, { id: 2, slug: 'kitchen' }],
    subs: [],
    nextId: 1000,
  };
}

function fakeDb(state) {
  const id = () => ++state.nextId;
  // Copies, as a real driver returns: a row read must not change under the
  // caller when a later statement updates the table.
  const rows = (x) => (x ? [{ ...x }] : []);

  function run(sql, p) {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (/^SELECT u\.id FROM users u JOIN user_identities/.test(s)) {
      const i = state.identities.find((r) => r.identifier_norm === p[0]);
      return rows(i && { id: i.user_id });
    }
    if (/^INSERT INTO users/.test(s)) { const u = { id: id() }; state.users.push(u); return { insertId: u.id }; }
    if (/^INSERT INTO user_identities/.test(s)) {
      const r = { id: id(), user_id: p[0], identifier_norm: p[2], verified: false };
      state.identities.push(r); return { insertId: r.id };
    }
    if (/^UPDATE users SET primary_email_id/.test(s)) return { affectedRows: 1 };
    if (/^SELECT id, public_id, owner_user_id, name FROM organisations WHERE external_ref/.test(s)) {
      return rows(state.orgs.find((o) => o.external_ref === p[0]));
    }
    if (/^SELECT id FROM organisations WHERE slug/.test(s)) return rows(state.orgs.find((o) => o.slug === p[0]));
    if (/^INSERT INTO organisations/.test(s)) {
      const o = { id: id(), public_id: p[0], name: p[1], slug: p[2], owner_user_id: p[3], external_ref: p[4], managed_by_application_id: p[5] };
      state.orgs.push(o); return { insertId: o.id };
    }
    if (/^SELECT role FROM organisation_members/.test(s)) {
      return rows(state.orgMembers.find((m) => m.organisation_id === p[0] && m.user_id === p[1]));
    }
    if (/^INSERT INTO organisation_members/.test(s)) {
      state.orgMembers.push({ organisation_id: p[0], user_id: p[1], role: p[2] }); return { affectedRows: 1 };
    }
    if (/^UPDATE organisation_members SET role/.test(s)) {
      const m = state.orgMembers.find((x) => x.organisation_id === p[1] && x.user_id === p[2]); m.role = p[0];
      return { affectedRows: 1 };
    }
    if (/^SELECT id FROM applications WHERE slug/.test(s)) return rows(state.apps.find((a) => a.slug === p[0]));
    if (/^SELECT id(, status)? FROM application_members WHERE application_id/.test(s)) {
      return rows(state.appMembers.find((m) => m.application_id === p[0] && m.user_id === p[1]));
    }
    if (/^INSERT INTO application_members/.test(s)) {
      if (!state.appMembers.find((m) => m.application_id === p[0] && m.user_id === p[1])) {
        state.appMembers.push({ id: id(), application_id: p[0], user_id: p[1], status: 'active' });
      }
      return { affectedRows: 1 };
    }
    if (/^INSERT IGNORE INTO application_member_roles \(member_id, role_id\) SELECT/.test(s)) {
      for (const r of state.appRoles.filter((x) => x.application_id === p[1] && x.is_default)) {
        if (!state.memberRoles.find((m) => m.member_id === p[0] && m.role_id === r.id)) state.memberRoles.push({ member_id: p[0], role_id: r.id });
      }
      return { affectedRows: 1 };
    }
    if (/^SELECT id FROM application_roles/.test(s)) {
      return rows(state.appRoles.find((r) => r.application_id === p[0] && r.role_key === p[1]));
    }
    if (/^INSERT IGNORE INTO application_member_roles \(member_id, role_id\) VALUES/.test(s)) {
      if (state.memberRoles.find((m) => m.member_id === p[0] && m.role_id === p[1])) return { affectedRows: 0 };
      state.memberRoles.push({ member_id: p[0], role_id: p[1] }); return { affectedRows: 1 };
    }
    if (/^SELECT id FROM products WHERE slug/.test(s)) return rows(state.products.find((x) => x.slug === p[0]));
    if (/^SELECT id, quantity FROM subscriptions/.test(s)) {
      return rows(state.subs.find((x) => x.organisation_id === p[0] && x.product_id === p[1]));
    }
    if (/^INSERT INTO subscriptions/.test(s)) {
      state.subs.push({ id: id(), user_id: p[1], product_id: p[2], organisation_id: p[3], plan_label: p[4], quantity: p[5], status: p[6], renews_at: p[7] });
      return { affectedRows: 1 };
    }
    if (/^UPDATE subscriptions SET quantity/.test(s)) {
      state.subs.find((x) => x.id === p[1]).quantity = p[0]; return { affectedRows: 1 };
    }
    throw new Error(`unexpected SQL: ${s}`);
  }

  const tx = {
    async one(sql, p = []) { const r = run(sql, p); return Array.isArray(r) ? (r[0] || null) : r; },
    async query(sql, p = []) { return run(sql, p); },
    async execute(sql, p = []) { return run(sql, p); },
  };
  return {
    async transaction(work) {
      const snapshot = structuredClone(state);
      try { return await work(tx); } catch (e) {
        for (const k of Object.keys(state)) delete state[k];
        Object.assign(state, snapshot);
        throw e;
      }
    },
  };
}

const venue = (over = {}) => ({
  venue_ref: 'epos-office:35',
  name: 'Pontardawe RFC',
  owner: { email: 'Info@Vesopa.com', name: 'Carys', apps: [
    { slug: 'vesopa-backoffice', roles: [] },
    { slug: 'vesopa-epos', roles: ['till.manager'] },
  ] },
  members: [],
  subscriptions: [
    { product: 'epos', quantity: 1, plan_label: 'Quarterly Plan', status: 'active', renews_at: '2026-12-04' },
    { product: 'display', quantity: 1, plan_label: 'Included', status: 'active' },
  ],
  ...over,
});

// ---- validation ---------------------------------------------------------------

test('validation refuses what must never reach the database', () => {
  const bad = {
    'a missing ref': venue({ venue_ref: '' }),
    'a ref with spaces': venue({ venue_ref: 'office 35' }),
    'no owner email': venue({ owner: { email: '' } }),
    'an .invalid owner (can never receive a code)': venue({ owner: { email: 'isolation@vesopa.invalid' } }),
    'an app outside the venue family': venue({ owner: { email: 'a@b.co', apps: [{ slug: 'vesopa-cloud' }] } }),
    'hosting sold per venue': venue({ subscriptions: [{ product: 'hosting', quantity: 1 }] }),
    'a zero quantity': venue({ subscriptions: [{ product: 'epos', quantity: 0 }] }),
    'a fractional quantity': venue({ subscriptions: [{ product: 'epos', quantity: 1.5 }] }),
    'a bad date': venue({ subscriptions: [{ product: 'epos', quantity: 1, renews_at: '04/12/2026' }] }),
    'a second owner among members': venue({ members: [{ email: 'x@y.co', org_role: 'owner' }] }),
  };
  for (const [name, body] of Object.entries(bad)) {
    assert.throws(() => validate(body), InvalidVenue, name);
  }
});

test('the same person twice keeps the higher role and every app', () => {
  const v = validate(venue({ members: [
    { email: 'staff@venue.co', org_role: 'viewer', apps: [{ slug: 'vesopa-epos' }] },
    { email: 'STAFF@venue.co', org_role: 'admin', apps: [{ slug: 'vesopa-backoffice' }] },
  ] }));
  const staff = v.people.find((p) => p.email === 'staff@venue.co');
  assert.equal(staff.orgRole, 'admin');
  assert.deepEqual(staff.apps.map((a) => a.slug), ['vesopa-epos', 'vesopa-backoffice']);
});

// ---- provisioning ---------------------------------------------------------------

test('a new venue: organisation, silent unverified owner account, memberships, subscriptions', async () => {
  const state = world();
  const r = await provision(venue(), { applicationId: 50, database: fakeDb(state) });

  assert.equal(r.created, true);
  const org = state.orgs.find((o) => o.external_ref === 'epos-office:35');
  assert.ok(org, 'organisation made and findable by its ref');
  assert.equal(org.managed_by_application_id, 50);

  const identity = state.identities.find((i) => i.identifier_norm === 'info@vesopa.com');
  assert.ok(identity, 'account created');
  assert.equal(identity.verified, false, 'NEVER marked verified — the emailed code does that');
  assert.equal(org.owner_user_id, identity.user_id);

  assert.deepEqual(state.orgMembers, [{ organisation_id: org.id, user_id: identity.user_id, role: 'owner' }]);
  assert.equal(state.appMembers.length, 2, 'back office and till');
  const tillMember = state.appMembers.find((m) => m.application_id === 1);
  const roles = state.memberRoles.filter((m) => m.member_id === tillMember.id).map((m) => m.role_id).sort();
  assert.deepEqual(roles, [101, 102], 'default role plus till.manager');

  assert.equal(state.subs.length, 2);
  const epos = state.subs.find((x) => x.product_id === 1);
  assert.equal(epos.quantity, 1);
  assert.equal(epos.organisation_id, org.id);
  assert.equal(epos.user_id, identity.user_id);
});

test('running it twice changes nothing and reports nothing', async () => {
  const state = world();
  const db = fakeDb(state);
  await provision(venue(), { database: db });
  const before = structuredClone(state);
  const again = await provision(venue(), { database: db });
  assert.equal(again.created, false);
  assert.deepEqual(again.actions, []);
  assert.deepEqual(state, before);
});

test('an existing account is used, not duplicated', async () => {
  const state = world();
  state.identities.push({ user_id: 85, identifier_norm: 'info@vesopa.com', verified: true });
  state.users.push({ id: 85 });
  const r = await provision(venue(), { database: fakeDb(state) });
  assert.equal(r.actions.some((a) => a.do === 'create_account'), false);
  assert.equal(state.orgs.find((o) => o.external_ref).owner_user_id, 85);
});

test('a dry run reports the same actions and writes nothing', async () => {
  const state = world();
  const before = structuredClone(state);
  const dry = await provision(venue(), { dryRun: true, database: fakeDb(state) });
  assert.equal(dry.dry_run, true);
  assert.ok(dry.actions.find((a) => a.do === 'create_organisation'));
  assert.ok(dry.actions.find((a) => a.do === 'add_subscription' && a.product === 'epos'));
  assert.deepEqual(state, before, 'rolled back');

  const real = await provision(venue(), { database: fakeDb(state) });
  const shape = (acts) => acts.map((a) => a.do);
  assert.deepEqual(shape(real.actions), shape(dry.actions), 'dry run predicts the real run');
});

test('a quantity is raised, never lowered', async () => {
  const state = world();
  const db = fakeDb(state);
  await provision(venue(), { database: db });
  const up = await provision(venue({ subscriptions: [{ product: 'epos', quantity: 3 }] }), { database: db });
  assert.deepEqual(up.actions, [{ do: 'raise_quantity', product: 'epos', from: 1, to: 3 }]);
  const down = await provision(venue({ subscriptions: [{ product: 'epos', quantity: 1 }] }), { database: db });
  assert.deepEqual(down.actions, []);
  assert.equal(state.subs.find((x) => x.product_id === 1).quantity, 3);
});

test('a role is raised, never lowered, and nobody is removed', async () => {
  const state = world();
  const db = fakeDb(state);
  await provision(venue({ members: [{ email: 'staff@venue.co', org_role: 'admin' }] }), { database: db });
  const r = await provision(venue({ members: [{ email: 'staff@venue.co', org_role: 'viewer' }] }), { database: db });
  assert.deepEqual(r.actions, []);
  const staffId = state.identities.find((i) => i.identifier_norm === 'staff@venue.co').user_id;
  assert.equal(state.orgMembers.find((m) => m.user_id === staffId).role, 'admin');
  const without = await provision(venue({ members: [] }), { database: db });
  assert.deepEqual(without.actions, []);
  assert.equal(state.orgMembers.length, 2, 'omitting somebody does not remove them');
});

test('a different owner is reported, never reassigned by a sync', async () => {
  const state = world();
  const db = fakeDb(state);
  await provision(venue(), { database: db });
  const ownerBefore = state.orgs.find((o) => o.external_ref).owner_user_id;
  const r = await provision(venue({ owner: { email: 'new-owner@venue.co' } }), { database: db });
  assert.ok(r.actions.find((a) => a.do === 'owner_differs'));
  assert.equal(state.orgs.find((o) => o.external_ref).owner_user_id, ownerBefore);
});

test('Vesopa\'s own organisation is never touched', async () => {
  const state = world();
  await provision(venue(), { database: fakeDb(state) });
  assert.deepEqual(state.orgs[0], world().orgs[0]);
});

test('an unknown role is skipped and said so, not silently dropped', async () => {
  const state = world();
  const r = await provision(venue({ owner: { email: 'o@v.co', apps: [{ slug: 'vesopa-epos', roles: ['till.god'] }] } }),
    { database: fakeDb(state) });
  assert.ok(r.actions.find((a) => a.do === 'skip_role' && a.role === 'till.god'));
});

test('a failure part-way writes nothing at all', async () => {
  const state = world();
  const before = structuredClone(state);
  const db = fakeDb(state);
  // A product id the stand-in cannot insert into: sabotage the subscription write.
  const original = db.transaction;
  db.transaction = (work) => original.call(db, async (tx) => {
    const wrapped = { ...tx, execute: async (sql, p) => {
      if (/INSERT INTO subscriptions/.test(sql)) throw new Error('disk full');
      return tx.execute(sql, p);
    } };
    return work(wrapped);
  });
  await assert.rejects(provision(venue(), { database: db }), /disk full/);
  assert.deepEqual(state, before);
});

test('a venue linked elsewhere is refused, not duplicated', async () => {
  const state = world();
  const before = structuredClone(state);
  // The Vesopa Kitchen case: linked by hand to Vesopa's own organisation (1),
  // which has no venue ref. A top-up must not quietly create a second one.
  await assert.rejects(
    provision(venue({ venue_ref: 'epos-office:9', expect_organisation_id: 1 }), { database: fakeDb(state) }),
    (e) => e instanceof InvalidVenue && /Nothing was changed/.test(e.message),
  );
  assert.deepEqual(state, before);
});

test('the expected organisation, when it matches, is topped up as normal', async () => {
  const state = world();
  const db = fakeDb(state);
  const first = await provision(venue(), { database: db });
  const again = await provision(venue({ expect_organisation_id: first.organisation_id,
    subscriptions: [{ product: 'epos', quantity: 2 }] }), { database: db });
  assert.deepEqual(again.actions, [{ do: 'raise_quantity', product: 'epos', from: 1, to: 2 }]);
});
