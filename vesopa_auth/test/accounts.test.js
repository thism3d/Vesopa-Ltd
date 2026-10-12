/**
 * One person, one Vesopa account (owner, 2026-10-12): "Passkey, email account
 * and Apple account matched means similar account... no duplicate accounts
 * same mail".
 *
 *     node --test test/accounts.test.js
 *
 * No database. The modules are the real ones; only the functions that would
 * reach MySQL are swapped for a small stand-in, so what is tested is the
 * decision -- link to the account that already holds the address, or make a
 * new one -- and not the SQL.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const identity = require('../src/identity');
const events = require('../src/events');
const { accountFor } = require('../src/routes/social');
const { shape } = require('../src/routes/member_passkeys');

events.recordLogin = async () => {};
events.recordAudit = async () => {};

/** A world of email identities, by normalised address. */
function world(rows) {
  const calls = { attached: [], created: [] };
  db.one = async (sql, params) => {
    if (/FROM user_identities i/.test(sql) && /i.type = \?/.test(sql)) {
      const [type, norm] = params;
      return rows.find((r) => r.type === type && r.identifier_norm === norm) || null;
    }
    if (/asserted_email_norm = \?/.test(sql)) {
      return rows.find((r) => r.asserted_email_norm === params[0] && r.asserted_email_verified) || null;
    }
    return null;
  };
  identity.attachIdentity = async (userId, fields) => { calls.attached.push({ userId, ...fields }); return 1; };
  identity.createUser = async (fields) => { calls.created.push(fields); return { userId: 99, publicId: 'NEW' }; };
  identity.touchIdentity = async () => {};
  return calls;
}

const apple = { key: 'apple', name: 'Apple', trustsEmail: true };
const req = { clientIp: '127.0.0.1', userAgent: 'test' };
const profile = (email, verified = true) => ({ email, emailVerified: verified, name: 'Sam', raw: {} });

test('Apple with a verified address somebody already proved signs in to THAT account', async () => {
  const calls = world([{ type: 'email', identifier_norm: 'sam@example.com', user_id: 7, verified_at: new Date() }]);
  const found = await accountFor(req, {
    provider: apple, profile: profile('Sam@Example.com'), subject: 'apple-1',
    assertedEmail: 'sam@example.com', relay: false, existing: null,
  });
  assert.deepEqual(found, { userId: 7 });
  assert.equal(calls.created.length, 0, 'no second account');
  assert.equal(calls.attached[0].userId, 7);
  assert.equal(calls.attached[0].type, 'apple');
});

test('an account another provider made with that address is found too (Google first, Apple second)', async () => {
  const calls = world([{
    type: 'google', asserted_email_norm: 'sam@example.com', asserted_email_verified: 1, user_id: 12,
  }]);
  const found = await accountFor(req, {
    provider: apple, profile: profile('sam@example.com'), subject: 'apple-2',
    assertedEmail: 'sam@example.com', relay: false, existing: null,
  });
  assert.deepEqual(found, { userId: 12 });
  assert.equal(calls.created.length, 0);
});

test('a provider account already linked signs straight in', async () => {
  const calls = world([]);
  const found = await accountFor(req, {
    provider: apple, profile: profile('sam@example.com'), subject: 'apple-3',
    assertedEmail: 'sam@example.com', relay: false,
    existing: { id: 3, user_id: 21, user_status: 'active' },
  });
  assert.deepEqual(found, { userId: 21 });
  assert.equal(calls.created.length + calls.attached.length, 0);
});

test('an address nobody ever proved is not matched: a new account, not somebody else\'s', async () => {
  const calls = world([{ type: 'email', identifier_norm: 'sam@example.com', user_id: 7, verified_at: null }]);
  const found = await accountFor(req, {
    provider: apple, profile: profile('sam@example.com'), subject: 'apple-4',
    assertedEmail: 'sam@example.com', relay: false, existing: null,
  });
  assert.deepEqual(found, { userId: 99 });
  assert.equal(calls.created.length, 1);
});

test("Apple's private relay never matches an account (it is not evidence of an address)", async () => {
  const calls = world([{
    type: 'email', identifier_norm: 'abc@privaterelay.appleid.com', user_id: 7, verified_at: new Date(),
  }]);
  const found = await accountFor(req, {
    provider: apple, profile: profile('abc@privaterelay.appleid.com'), subject: 'apple-5',
    assertedEmail: 'abc@privaterelay.appleid.com', relay: true, existing: null,
  });
  assert.deepEqual(found, { userId: 99 });
  assert.equal(calls.created.length, 1);
});

test('an app is told about a passkey, never given its key', () => {
  const row = shape({
    id: 4, name: '', aaguid: 'ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4', device_type: 'multiDevice',
    backup_state: 1, created_at: 'then', last_used_at: null, public_key: Buffer.from('x'), credential_id: Buffer.from('y'),
  });
  assert.deepEqual(Object.keys(row).sort(),
    ['aaguid', 'backup_state', 'created_at', 'device_type', 'id', 'last_used_at', 'name']);
  assert.equal(row.name, 'Passkey');
  assert.equal(row.backup_state, 1);
});
