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

test('the relying party is the menu host, so one passkey covers every venue', () => {
  const party = auth.rp({ MENU_HOST: 'menu.example.test' });
  assert.equal(party.id, 'menu.example.test');
  assert.deepEqual(party.origins, ['https://menu.example.test']);
});
