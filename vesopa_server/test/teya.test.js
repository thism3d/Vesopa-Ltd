/**
 * Teya client: signatures, the registration address, reading the live
 * payment stream, and what the till is told. No network: fetch is stubbed.
 */
'use strict';

const assert = require('assert');
const crypto = require('crypto');

process.env.TEYA_DEVICE_CLIENT_ID = 'dev-id';
process.env.TEYA_DEVICE_CLIENT_SECRET = 'dev-secret';
delete process.env.TEYA_LIVE_DEVICE_CLIENT_ID;

const teya = require('../src/teya_client');
const { paymentView, messageFor } = require('../src/teya');

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('  ok  ', name);
  } catch (e) {
    console.error('  FAIL', name, '\n', e);
    process.exitCode = 1;
  }
}

(async () => {
  console.log('Teya');

  await check('sandbox available, live not until Teya issues live credentials', () => {
    assert.strictEqual(teya.available('sandbox'), true);
    assert.strictEqual(teya.available('live'), false);
    assert.strictEqual(teya.cleanEnv('nonsense'), 'sandbox');
  });

  await check("a venue's own live credentials make live available for that venue only", () => {
    const own = { deviceId: 'venue-live-id', deviceSecret: 'venue-live-secret' };
    assert.strictEqual(teya.available('live', own), true);
    assert.strictEqual(teya.available('live'), false);
    assert.strictEqual(teya.partner('live', own).source, 'venue');
    assert.strictEqual(teya.partner('sandbox').source, 'vesopa');
  });

  await check('a webhook signature is checked over the raw body', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = publicKey.export({ type: 'spki', format: 'pem' });
    const body = Buffer.from('{"event":"payment.succeeded.v1","data":{"session_id":"s1"}}');
    const sig = crypto.sign('sha256', body, privateKey).toString('base64');
    assert.strictEqual(teya.verifySignature(body, sig, pem), true);
    assert.strictEqual(teya.verifySignature(Buffer.from(body.toString().replace('s1', 's2')), sig, pem), false);
    assert.strictEqual(teya.verifySignature(body, '', pem), false);
    assert.strictEqual(teya.verifySignature(body, 'not base64 at all!', pem), false);
  });

  await check('registration address on the sandbox uses TESTING', () => {
    const url = new URL(teya.registrationUrl('sandbox', {
      registrationWebhook: 'https://bo.example/api/teya/online/registration?env=sandbox',
      paymentsWebhook: 'https://bo.example/api/teya/online/payments?env=sandbox',
      state: 'abc',
    }));
    assert.strictEqual(url.origin, 'https://business.teya.xyz');
    assert.strictEqual(url.searchParams.get('pluginType'), 'TESTING');
    assert.strictEqual(url.searchParams.get('state'), 'abc');
  });

  await check('live start refuses with a sentence when live is not set up', async () => {
    await assert.rejects(teya.startDevice('live'), (e) => e.code === 'NOT_CONFIGURED' && /live app credentials/.test(e.message));
  });

  await check('the live stream is read until Teya gives its outcome', async () => {
    const events = [
      { status: 'NEW' },
      { status: 'IN_PROGRESS', progress_status: 'WAITING_FOR_CARD_ENTRY' },
      { status: 'SUCCESSFUL', gateway_payment_id: 'gw1', metadata: { payment_method_details: { card: { last4: '4673', brand: 'MASTERCARD' }, authorisation_code: '537001' } } },
    ];
    const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
    const realFetch = global.fetch;
    global.fetch = async () => new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    try {
      const p = await teya.followPayment('sandbox', 'tok', 'pr1', 2000);
      assert.strictEqual(p.final, true);
      const v = paymentView(p);
      assert.strictEqual(v.outcome, 'approved');
      assert.strictEqual(v.gateway_payment_id, 'gw1');
      assert.strictEqual(v.card_last4, '4673');
      assert.strictEqual(v.auth_code, '537001');
    } finally {
      global.fetch = realFetch;
    }
  });

  await check('a declined or cancelled payment says so, and says no money moved', () => {
    assert.strictEqual(paymentView({ status: 'FAILED', status_reason: 'DECLINED_ONLINE' }).outcome, 'declined');
    assert.strictEqual(paymentView({ status: 'CANCELLED', status_reason: 'CANCELLED_BY_USER' }).outcome, 'cancelled');
    assert.match(messageFor('FAILED', null, 'TIMEOUT'), /No money was taken/);
    assert.strictEqual(paymentView({ status: 'IN_PROGRESS', progress_status: 'PIN_ENTRY' }).message, 'Enter PIN');
    assert.strictEqual(paymentView({ status: 'IN_PROGRESS' }).final, false);
  });

  await check('a Teya error reads as a sentence, never a stack', async () => {
    const realFetch = global.fetch;
    global.fetch = async () => new Response(JSON.stringify({ code: 'TERMINAL_UNREACHABLE', description: 'x' }), { status: 400 });
    try {
      await assert.rejects(teya.createPayment('sandbox', 't', { storeId: 's', terminalId: 'd', amountMinor: 100, reference: 'r' }, 'k'),
        (e) => e instanceof teya.TeyaError && /could not be reached/.test(e.message));
    } finally {
      global.fetch = realFetch;
    }
  });

  console.log(`\nteya: ${passed} checks passed`);
})();
