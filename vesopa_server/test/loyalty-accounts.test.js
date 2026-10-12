/**
 * One person, one member per venue, and passkeys a member can recognise
 * (owner, 2026-10-12: "no duplicate accounts same mail", "passkey device info
 * should show").
 *
 *     node --test test/loyalty-accounts.test.js
 *
 * No database: an in-memory stand-in that answers the statements joinScheme
 * sends, with a real GET_LOCK, because "two sign-ins at once make one member"
 * is the claim most worth proving and the one a fake that ran everything in
 * order would prove nothing about.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { joinScheme, customerByEmail } = require('../src/loyalty_app');
const { androidOrigins, rp } = require('../src/loyalty_auth');
const { passkeyProvider } = require('../src/passkey_providers');
const { passkeyRow, vesopaPasskeyRow, deviceLabel } = require('../src/loyalty_account');

const OFFICE = 'club@example.com';

/** The customers table, and a pool whose connections share named locks. */
function world(customers = []) {
  const locks = new Map(); // name -> promise chain
  const held = new Map(); // name -> release
  let seq = 1;
  const pause = () => new Promise((r) => setImmediate(r));

  async function query(sql, params = []) {
    await pause(); // every statement yields, so two joins really interleave
    if (/GET_LOCK/.test(sql)) {
      const name = params[0];
      const before = locks.get(name) || Promise.resolve();
      let release;
      const mine = new Promise((r) => { release = r; });
      locks.set(name, before.then(() => mine));
      await before;
      held.set(name, release);
      return [[{ ok: 1 }]];
    }
    if (/RELEASE_LOCK/.test(sql)) {
      const release = held.get(params[0]);
      held.delete(params[0]);
      if (release) release();
      return [[{ ok: 1 }]];
    }
    if (/FROM epos_customers\s+WHERE email_key = \? AND LOWER\(TRIM\(email\)\) = \?/.test(sql)) {
      const [office, email] = params;
      const rows = customers
        .filter((c) => c.email_key === office && String(c.email || '').trim().toLowerCase() === email)
        .sort((a, b) => a.created_at - b.created_at);
      return [rows.slice(0, 1)];
    }
    if (/^\s*INSERT INTO epos_customers/.test(sql)) {
      const [id, office, name, email] = params;
      customers.push({ id, email_key: office, name, email, created_at: seq++ });
      return [{ affectedRows: 1 }];
    }
    if (/SELECT card_number FROM epos_customers/.test(sql)) return [[{ card_number: '999800001' }]];
    if (/SELECT next_number/.test(sql)) return [[{ next_number: 2 }]];
    return [[]];
  }
  const conn = () => ({
    query, execute: query,
    beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {},
  });
  return { customers, pool: { query, execute: query, getConnection: async () => conn() } };
}

test('an address already on the books is that member, whatever its case or spaces', async () => {
  const { pool } = world([{ id: 'old', email_key: OFFICE, email: ' Sam@Example.com', created_at: 0 }]);
  assert.equal((await customerByEmail(pool, OFFICE, 'sam@example.com ')).id, 'old');
  assert.equal(await joinScheme(pool, OFFICE, { name: 'Sam', email: 'SAM@example.com' }), 'old');
});

test('the oldest member wins where there are already two', async () => {
  const { pool } = world([
    { id: 'newer', email_key: OFFICE, email: 'sam@example.com', created_at: 5 },
    { id: 'older', email_key: OFFICE, email: 'sam@example.com', created_at: 1 },
  ]);
  assert.equal((await customerByEmail(pool, OFFICE, 'sam@example.com')).id, 'older');
});

test('a new address makes one member', async () => {
  const { pool, customers } = world();
  const id = await joinScheme(pool, OFFICE, { name: 'Sam', email: 'Sam@Example.com ' });
  assert.equal(customers.length, 1);
  assert.equal(customers[0].id, id);
  assert.equal(customers[0].email, 'sam@example.com');
});

test('two sign-ins with one address at the same moment make ONE member', async () => {
  const { pool, customers } = world();
  const [a, b, c] = await Promise.all([
    joinScheme(pool, OFFICE, { name: 'Sam', email: 'sam@example.com' }),
    joinScheme(pool, OFFICE, { name: 'Sam', email: 'SAM@example.com' }),
    joinScheme(pool, OFFICE, { name: 'Sam', email: ' sam@example.com' }),
  ]);
  assert.equal(customers.length, 1);
  assert.equal(a, b);
  assert.equal(b, c);
});

test('the same address at another venue is another venue\'s member', async () => {
  const { pool, customers } = world([{ id: 'there', email_key: 'other@example.com', email: 'sam@example.com', created_at: 0 }]);
  const id = await joinScheme(pool, OFFICE, { name: 'Sam', email: 'sam@example.com' });
  assert.notEqual(id, 'there');
  assert.equal(customers.length, 2);
});

test("the venue's Android app is an origin for its passkeys, worked out from assetlinks' fingerprint", () => {
  const print = 'A3:03:9D:73:74:E8:1B:10:4D:85:9F:7B:A4:4A:AD:7D:74:31:C3:BB:C6:E4:CE:51:43:FF:47:B3:59:10:C3:82';
  const env = { LOYALTY_RP_ID: 'loyalty.vesopa.com', LOYALTY_ANDROID_APPS: `com.vesopaepos.pontardawerfc=${print}` };
  const [origin] = androidOrigins(env);
  assert.equal(origin, `android:apk-key-hash:${Buffer.from(print.replace(/:/g, ''), 'hex').toString('base64url')}`);
  assert.deepEqual(rp(env).origins, ['https://loyalty.vesopa.com', origin]);
  assert.deepEqual(androidOrigins({ LOYALTY_ANDROID_APPS: 'broken' }), []);
});

test('a passkey says where it lives', () => {
  assert.equal(passkeyProvider('ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4'), 'Google Password Manager');
  assert.equal(passkeyProvider('BADA5566-A7AA-401F-BD96-45619A55120D'), '1Password');
  // Apple sends zeros for iCloud Keychain: the device it was added on decides.
  assert.equal(passkeyProvider('00000000-0000-0000-0000-000000000000', 'iPhone'), 'iCloud Keychain');
  assert.equal(passkeyProvider(null, 'Android phone or tablet'), 'Google Password Manager');
  assert.equal(passkeyProvider('', 'Edge on Windows'), 'Windows Hello');
  // An authenticator we do not know is not guessed at.
  assert.equal(passkeyProvider('12345678-1234-1234-1234-123456789abc', 'iPhone'), null);
});

test('the account page gets name, place, device and dates for both kinds, and no key', () => {
  const venue = passkeyRow({
    id: 'p1', name: null, aaguid: '00000000-0000-0000-0000-000000000000', device: 'iPad',
    backed_up: 1, created_at: 'a', last_used_at: null, public_key: 'secret', credential_id: 'cred',
  });
  assert.deepEqual(venue, {
    id: 'p1', kind: 'venue', name: null, provider: 'iCloud Keychain', device: 'iPad', synced: true,
    created_at: 'a', last_used_at: null,
  });
  // A server without the new columns yet: still listed.
  assert.equal(passkeyRow({ id: 'p2', created_at: 'b' }).provider, null);
  const vesopa = vesopaPasskeyRow({
    id: 9, name: 'Passkey', aaguid: 'ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4', backup_state: 1, created_at: 'c',
  });
  assert.equal(vesopa.id, 'vesopa:9');
  assert.equal(vesopa.kind, 'vesopa');
  assert.equal(vesopa.provider, 'Google Password Manager');
  assert.equal(vesopa.name, null);
  assert.equal(deviceLabel('ios', 'Pontardawe RFC (iPad; iOS 26.0)'), 'iPad');
});
