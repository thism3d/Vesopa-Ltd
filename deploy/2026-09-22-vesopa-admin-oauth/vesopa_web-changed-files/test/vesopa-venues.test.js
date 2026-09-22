/**
 * What a venue should look like on auth.vesopa.com — src/vesopa-venues.js.
 *
 *     node --test test/vesopa-venues.test.js
 *
 * The fixtures are the shapes of the live venues on 2026-09-22, because the
 * rules are only worth anything if they do the right thing to those.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// The module requires ../src/db, which demands DB credentials at load.
const dbPath = path.join(__dirname, '..', 'src', 'db.js');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { pool: {} } };

const { buildPayload, skipReason } = require('../src/vesopa-venues');

const office = (over = {}) => ({
  id: 35, name: 'Pontardawe RFC', contact_email: 'info@vesopa.com', contact_name: 'Carys',
  status: 'active', plan: 'quarterly', next_due_on: '2026-12-04', created_at: '2026-09-04T10:00:00Z',
  trial_ends_on: null, is_demo: 0, demo_of: null, auth_organisation_id: null, ...over,
});
const user = (over = {}) => ({ id: 17, email: 'info@vesopa.com', name: 'Carys', role: 'office', approved: 'Y', ...over });

// ---- who is skipped ------------------------------------------------------------

test('skips: already linked, demo, archived, .invalid, no users, platform staff', () => {
  assert.match(skipReason({ office: office({ auth_organisation_id: 1 }), users: [user()] }), /already linked/);
  assert.match(skipReason({ office: office({ is_demo: 1 }), users: [user()] }), /demo/);
  assert.match(skipReason({ office: office({ demo_of: 9 }), users: [user()] }), /demo/);
  assert.match(skipReason({ office: office({ status: 'archived' }), users: [user()] }), /archived/);
  assert.match(skipReason({ office: office({ contact_email: 'isolation@vesopa.invalid' }), users: [user()] }), /invalid/);
  assert.match(skipReason({ office: office(), users: [] }), /no back-office users/);
  assert.match(
    skipReason({ office: office({ contact_email: 'info@vesopasoftware.com' }), users: [user({ email: 'info@vesopasoftware.com', role: 'admin' })] }),
    /platform staff/
  );
  assert.equal(skipReason({ office: office(), users: [user()] }), '');
});

// ---- the payload ---------------------------------------------------------------

test('a plain venue: its contact owns it, one till and one display, the plan name and renewal', () => {
  const p = buildPayload({ office: office(), users: [user()], planName: 'Quarterly Plan' });
  assert.equal(p.venue_ref, 'epos-office:35');
  assert.equal(p.owner.email, 'info@vesopa.com');
  assert.deepEqual(p.members, []);
  const epos = p.subscriptions.find((s) => s.product === 'epos');
  assert.equal(epos.quantity, 1);
  assert.equal(epos.plan_label, 'Quarterly Plan');
  assert.equal(epos.renews_at, '2026-12-04');
  assert.equal(epos.status, 'active');
  assert.equal(p.subscriptions.find((s) => s.product === 'display').quantity, 1);
  assert.equal(p.subscriptions.some((s) => s.product === 'kitchen'), false, 'Kitchen is an add-on');
  assert.deepEqual(p.owner.apps.map((a) => a.slug), ['vesopa-backoffice', 'vesopa-epos']);
});

test('never sells fewer devices than are signed in now (the Kitchen: 13 tills)', () => {
  const p = buildPayload({
    office: office({ id: 9, contact_email: 'manager@vesopa.co.uk' }),
    users: [user({ email: 'manager@vesopa.co.uk' })],
    seats: { till: 13, express: 1, display: 1 },
    limits: { till: 3, kitchen: 2, display: 1 },
  });
  const q = Object.fromEntries(p.subscriptions.map((s) => [s.product, s.quantity]));
  assert.deepEqual(q, { epos: 13, display: 1, kitchen: 2, express: 1 });
});

test('the contact owns it when they are a user; everyone else is an admin member', () => {
  const p = buildPayload({
    office: office({ id: 9, contact_email: 'manager@vesopa.co.uk' }),
    users: [
      user({ id: 23, email: 'dylan@vesopa.com', name: 'Dylan' }),
      user({ id: 15, email: 'manager@vesopa.co.uk', name: 'Manager' }),
      user({ id: 24, email: 'dylan@beaconsepos.com', name: 'Dylan' }),
    ],
  });
  assert.equal(p.owner.email, 'manager@vesopa.co.uk');
  assert.deepEqual(p.members.map((m) => [m.email, m.org_role]), [
    ['dylan@vesopa.com', 'admin'], ['dylan@beaconsepos.com', 'admin'],
  ]);
});

test('with no user at the contact address, the first user owns it', () => {
  const p = buildPayload({ office: office({ contact_email: 'accounts@venue.co' }), users: [user({ email: 'boss@venue.co' })] });
  assert.equal(p.owner.email, 'boss@venue.co');
});

test('unapproved users and platform admins are never members', () => {
  const p = buildPayload({
    office: office(),
    users: [user(), user({ id: 30, email: 'pending@venue.co', approved: 'N' }), user({ id: 31, email: 'staff@vesopa.com', role: 'admin' })],
  });
  assert.deepEqual(p.members, []);
});

test('nobody approved: no payload at all', () => {
  assert.equal(buildPayload({ office: office(), users: [user({ approved: 'N' })] }), null);
});

test('a paused venue is sold as paused; a venue in trial as trialling until its end', () => {
  assert.equal(buildPayload({ office: office({ status: 'paused' }), users: [user()] }).subscriptions[0].status, 'paused');
  const future = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10);
  const t = buildPayload({ office: office({ trial_ends_on: future }), users: [user()] }).subscriptions[0];
  assert.equal(t.status, 'trialling');
  assert.equal(t.ends_at, future);
  const past = buildPayload({ office: office({ trial_ends_on: '2026-01-01' }), users: [user()] }).subscriptions[0];
  assert.equal(past.status, 'active');
});

test('dates from the database arrive as YYYY-MM-DD whatever their type', () => {
  const p = buildPayload({ office: office({ next_due_on: new Date('2026-10-15T00:00:00Z'), created_at: new Date('2026-09-01T12:00:00Z') }), users: [user()] });
  assert.equal(p.subscriptions[0].renews_at, '2026-10-15');
  assert.equal(p.subscriptions[0].started_at, '2026-09-01');
});
