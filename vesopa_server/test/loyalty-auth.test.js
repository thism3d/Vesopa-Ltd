/**
 * The rules that decide whether a member can get in at all.
 *
 * These are unit tests because the failures they guard against are silent: a
 * venue switching every method off and locking its own members out, or a policy
 * naming a method the venue does not offer and leaving the app with nothing to
 * lead on. Neither throws; both just quietly stop people signing in.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const auth = require('../src/loyalty_auth');

/** A pool that answers with fixed method rows. */
const fakeDb = (rows) => ({ query: async () => [rows] });

test('a venue with no rows gets the default it already had', async () => {
  const methods = await auth.methodsFor(fakeDb([]), 'a@b.test', {});
  assert.deepEqual(methods, { code_email: true });
});

test('switching everything off cannot lock a venue out', async () => {
  // The worst thing in this file. A venue that did this would have no way back
  // in from the app, including the person who did it.
  const methods = await auth.methodsFor(
    fakeDb([{ method: 'code_email', enabled: 0 }, { method: 'password', enabled: 0 }]),
    'a@b.test',
    {}
  );
  assert.equal(methods.code_email, true);
});

test('a method the server cannot perform is dropped, not offered', async () => {
  const rows = [{ method: 'code_email', enabled: 1 }, { method: 'code_sms', enabled: 1 }];
  // No SMS account configured.
  const without = await auth.methodsFor(fakeDb(rows), 'a@b.test', {});
  assert.equal(without.code_sms, undefined);
  const with_ = await auth.methodsFor(fakeDb(rows), 'a@b.test', { POSTCODER_API_KEY: 'k' });
  assert.equal(with_.code_sms, true);
});

test('a table that does not exist yet still signs members in', async () => {
  const broken = { query: async () => { const e = new Error('no table'); e.code = 'ER_NO_SUCH_TABLE'; throw e; } };
  const methods = await auth.methodsFor(broken, 'a@b.test', {});
  assert.deepEqual(methods, { code_email: true });
});

test('a policy naming a method the venue does not offer falls back', () => {
  assert.equal(auth.policyFor({ auth_policy: 'password_first' }, { code_email: true }), 'code_first');
  assert.equal(auth.policyFor({ auth_policy: 'vesopa_first' }, { code_email: true }), 'code_first');
  assert.equal(
    auth.policyFor({ auth_policy: 'password_first' }, { code_email: true, password: true }),
    'password_first'
  );
  assert.equal(auth.policyFor({ auth_policy: 'nonsense' }, { code_email: true }), 'code_first');
});

test('a password is checked in constant-ish time whether or not there is one', async () => {
  assert.equal(await auth.passwordMatches(null, 'anything'), false);
  assert.equal(await auth.passwordMatches({ password_hash: null }, 'anything'), false);
  const hash = await auth.hashPassword('a-long-enough-password');
  assert.equal(await auth.passwordMatches({ password_hash: hash }, 'a-long-enough-password'), true);
  assert.equal(await auth.passwordMatches({ password_hash: hash }, 'wrong'), false);
});

test('a password is judged on length, not on punctuation', () => {
  assert.ok(auth.passwordProblem('short'));
  assert.equal(auth.passwordProblem('correct horse battery staple'), null);
  // The one people actually pick when told to use a symbol.
  assert.ok(auth.passwordProblem('Pas1!'));
});

/** A pool holding members and venues, answering the three reads venuesForVesopa makes. */
function venueDb(customers, apps) {
  const queries = [];
  return {
    queries,
    query: async (sql, params) => {
      queries.push(sql);
      if (/vesopa_sub = \?/.test(sql)) return [customers.filter((c) => c.vesopa_sub === params[0])];
      if (/WHERE email = \?/.test(sql)) return [customers.filter((c) => c.email === params[0])];
      if (/FROM epos_loyalty_app/.test(sql)) {
        return [apps.filter((a) => a.enabled && params[0].includes(a.office))];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

const APPS = [
  { slug: 'the-crown', office: 'crown@venue.test', app_name: 'The Crown', enabled: 1 },
  { slug: 'the-mill', office: 'mill@venue.test', app_name: 'The Mill', enabled: 1 },
  { slug: 'switched-off', office: 'off@venue.test', app_name: 'Off', enabled: 0 },
];

test('Continue with Vesopa finds only the venues that let this person in', async () => {
  const db = venueDb([
    { id: 'c1', email_key: 'crown@venue.test', email: 'sam@x.test', vesopa_sub: null },
    { id: 'c2', email_key: 'off@venue.test', email: 'sam@x.test', vesopa_sub: null },
    { id: 'c3', email_key: 'mill@venue.test', email: 'someone@else.test', vesopa_sub: null },
  ], APPS);
  const venues = await auth.venuesForVesopa(db, { sub: 'sub-sam', email: 'sam@x.test' });
  // Not The Mill (somebody else's membership), not the venue whose app is off.
  assert.deepEqual(venues.map((v) => [v.slug, v.customerId]), [['the-crown', 'c1']]);
});

test('an account with no invitation anywhere gets nothing, and nothing is made', async () => {
  const db = venueDb([], APPS);
  assert.deepEqual(await auth.venuesForVesopa(db, { sub: 'sub-new', email: 'new@x.test' }), []);
  assert.ok(db.queries.every((q) => /^\s*SELECT/.test(q)), 'only reads');
});

test('a linked account wins over an email, and a card linked to another account is not taken by email', async () => {
  const db = venueDb([
    // Sam's own card at The Crown, linked to Sam's account under an old address.
    { id: 'linked', email_key: 'crown@venue.test', email: 'old@x.test', vesopa_sub: 'sub-sam' },
    { id: 'by-email', email_key: 'crown@venue.test', email: 'sam@x.test', vesopa_sub: null },
    // A card at The Mill with Sam's address on it, but claimed by another account.
    { id: 'theirs', email_key: 'mill@venue.test', email: 'sam@x.test', vesopa_sub: 'sub-other' },
  ], APPS);
  const venues = await auth.venuesForVesopa(db, { sub: 'sub-sam', email: 'sam@x.test' });
  assert.deepEqual(venues.map((v) => [v.slug, v.customerId]), [['the-crown', 'linked']]);
});

test('the office is bound as a value, never compared column to column', async () => {
  // epos_customers.email_key and epos_loyalty_app.office differ in collation on
  // live, where comparing them is a 500.
  const db = venueDb([{ id: 'c1', email_key: 'crown@venue.test', email: 'sam@x.test' }], APPS);
  await auth.venuesForVesopa(db, { sub: 's', email: 'sam@x.test' });
  assert.ok(db.queries.every((q) => !/email_key\s*=\s*\w+\.office|office\s*=\s*\w+\.email_key|JOIN/i.test(q)));
});

test('the relying party is the menu host, so one passkey covers every venue', () => {
  const party = auth.rp({ MENU_HOST: 'menu.example.test' });
  assert.equal(party.id, 'menu.example.test');
  assert.deepEqual(party.origins, ['https://menu.example.test']);
});
