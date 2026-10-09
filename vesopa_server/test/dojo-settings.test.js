/**
 * Dojo card settings per venue (accreditation, October 2026): the key check
 * on save, the fixed software house id, and the till's card log.
 *
 * No MySQL and no network: Dojo is a scripted fetch.
 */

const assert = require('assert');

process.env.EXPRESS_SECRET_KEY = process.env.EXPRESS_SECRET_KEY || 'test-sealing-key';

const {
  verifyDojo, publicView, eventId, SOFTWARE_HOUSE_ID, PUBLIC_SANDBOX_KEY,
} = require('../src/dojo_settings');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

function fakeFetch(status, body, seen = []) {
  return async (url, init) => {
    seen.push({ url, headers: init.headers });
    return {
      status,
      ok: status >= 200 && status < 300,
      json: async () => body,
    };
  };
}

test('the software house id is SL942X04', () => {
  assert.strictEqual(SOFTWARE_HOUSE_ID, 'SL942X04');
});

test('a wrong key reads "API key is incorrect"', async () => {
  const r = await verifyDojo({ key: 'sk_sandbox_wrong', fetchImpl: fakeFetch(401, {}) });
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /API key is incorrect/);
});

test('the check sends both partner ids, a blank reseller as the software house', async () => {
  const seen = [];
  await verifyDojo({ key: 'sk_sandbox_x', resellerId: '', fetchImpl: fakeFetch(200, [], seen) });
  assert.strictEqual(seen[0].headers['software-house-id'], 'SL942X04');
  assert.strictEqual(seen[0].headers['reseller-id'], 'SL942X04');
});

test('a typed reseller id is sent as typed', async () => {
  const seen = [];
  await verifyDojo({ key: 'sk_sandbox_x', resellerId: 'RES9', fetchImpl: fakeFetch(200, [], seen) });
  assert.strictEqual(seen[0].headers['reseller-id'], 'RES9');
});

test('an offline card machine cannot be saved', async () => {
  const r = await verifyDojo({
    key: 'sk_sandbox_x',
    terminalId: 'T1',
    fetchImpl: fakeFetch(200, [{ id: 'tm_1', properties: { tid: 'T1' }, status: 'Offline' }]),
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /Offline/);
});

test('a connected card machine can be saved, by its number or its id', async () => {
  const list = [{ id: 'tm_1', properties: { tid: 'T1' }, status: 'Available' }];
  const byTid = await verifyDojo({ key: 'sk_sandbox_x', terminalId: 'T1', fetchImpl: fakeFetch(200, list) });
  const byId = await verifyDojo({ key: 'sk_sandbox_x', terminalId: 'tm_1', fetchImpl: fakeFetch(200, list) });
  assert.ok(byTid.ok && byId.ok);
  assert.strictEqual(byTid.terminal.id, 'tm_1');
});

test('a machine that is not on the account is refused', async () => {
  const r = await verifyDojo({ key: 'sk_sandbox_x', terminalId: 'nope', fetchImpl: fakeFetch(200, []) });
  assert.strictEqual(r.ok, false);
});

test('a venue with nothing saved is on the public sandbox key', () => {
  const v = publicView(null);
  assert.strictEqual(v.key_source, 'public_sandbox');
  assert.strictEqual(v.environment, 'sandbox');
  assert.strictEqual(v.key_hint, PUBLIC_SANDBOX_KEY.slice(-4));
  assert.strictEqual(v.result_seconds, 5);
  assert.strictEqual(v.reseller_sent, 'SL942X04');
});

test('the public view never carries the key', () => {
  const v = publicView({ api_key_enc: 'v1:secret', key_hint: 'ab12', environment: 'live', result_seconds: 15 });
  assert.ok(!JSON.stringify(v).includes('v1:secret'));
  assert.strictEqual(v.result_seconds, 15);
});

test('a till re-sending the same event gets the same id', () => {
  const e = { at: '2026-10-09T18:00:00Z', kind: 'sale', outcome: 'declined', intent_id: 'pi_1', amount_minor: 100 };
  assert.strictEqual(eventId('a@b', e), eventId('a@b', { ...e }));
  assert.notStrictEqual(eventId('a@b', e), eventId('a@b', { ...e, outcome: 'approved' }));
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ok   ${name}`);
    } catch (err) {
      failed += 1;
      console.error(`  FAIL ${name}`);
      console.error(`       ${err.message}`);
    }
  }
  console.log(`\ndojo-settings: ${tests.length - failed}/${tests.length} passed`);
  if (failed) process.exit(1);
})();
