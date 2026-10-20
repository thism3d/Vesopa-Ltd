/**
 * Prove the Barclaycard Smartpay Fuse SANDBOX keys from the repo's
 * .env.barclaycard: a test-card payment, its refund, a void, and a Unified
 * Checkout capture context. Sandbox only; prints no secret.
 *
 *   node vesopa_server/tool/barclaycard_sandbox_test.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env.barclaycard'), quiet: true });
const bc = require('../src/barclaycard_client');

const creds = {
  env: 'sandbox',
  merchantId: process.env.BARCLAYCARD_SANDBOX_MERCHANT_ID,
  keyId: process.env.BARCLAYCARD_SANDBOX_KEY_ID,
  secret: process.env.BARCLAYCARD_SANDBOX_SHARED_SECRET,
};

const card = { number: '4111111111111111', expirationMonth: '12', expirationYear: '2031', securityCode: '123' };
const ok = (label, v) => console.log(`✓ ${label}${v ? ': ' + v : ''}`);

(async () => {
  if (!creds.merchantId || !creds.keyId || !creds.secret) throw new Error('.env.barclaycard is missing a value');
  const ref = `vesopa-test-${Date.now().toString(36)}`;
  const p = await bc.pay(creds, { reference: ref, amountMinor: 123, card });
  ok('payment £1.23', `${p.status} id ${p.id}`);
  if (!bc.approved(p)) throw new Error('payment not approved: ' + JSON.stringify(p.errorInformation || p));

  const r = await bc.refund(creds, p.id, { reference: ref + '-r', amountMinor: 50 });
  ok('refund £0.50', `${r.status} id ${r.id}`);

  const p2 = await bc.pay(creds, { reference: ref + '-2', amountMinor: 200, card });
  const v = await bc.voidPayment(creds, p2.id, { reference: ref + '-v' });
  ok('void £2.00', `${v.status}`);

  const cc = await bc.captureContext(creds, { targetOrigins: ['https://menu.vesopa.com'], amountMinor: 123 });
  ok('Unified Checkout capture context', typeof cc === 'string' ? `JWT ${cc.length} chars` : JSON.stringify(cc).slice(0, 80));
})().catch((e) => {
  console.error('✗', e.status || '', e.code || '', e.message);
  if (e.body) console.error(JSON.stringify(e.body).slice(0, 600));
  process.exit(1);
});
