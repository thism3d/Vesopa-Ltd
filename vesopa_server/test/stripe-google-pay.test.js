/**
 * Google Pay on Go through Stripe: what is asked of Stripe, and the option that
 * chooses the gateway.
 */
'use strict';

const assert = require('assert');
const { cleanGoOptions } = require('../src/go_options');
const stripe = require('../src/stripe_client');

assert.strictEqual(cleanGoOptions({}).google_pay_gateway, 'off', 'off until a manager chooses');
assert.strictEqual(cleanGoOptions({ google_pay_gateway: 'stripe' }).google_pay_gateway, 'stripe');
assert.strictEqual(cleanGoOptions({ google_pay_gateway: 'dojo' }).google_pay_gateway, 'dojo');
assert.strictEqual(cleanGoOptions({ google_pay_gateway: 'nonsense' }).google_pay_gateway, 'off');

(async () => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_x';
  let asked = null;
  const fetchImpl = async (url, init) => {
    asked = { url: String(url), body: String(init.body), headers: init.headers };
    const text = '{"id":"pi_1","status":"succeeded"}';
    return { ok: true, status: 200, text: async () => text, json: async () => JSON.parse(text) };
  };
  const made = await stripe.createWalletPayment('acct_1', { amountMinor: 1250, token: 'tok_abc', reference: 'r1' }, { fetchImpl });
  assert.strictEqual(made.status, 'succeeded');
  const body = new URLSearchParams(asked.body);
  assert.strictEqual(body.get('amount'), '1250');
  assert.strictEqual(body.get('payment_method_data[card][token]'), 'tok_abc');
  assert.strictEqual(body.get('confirm'), 'true');
  const headers = Object.fromEntries(Object.entries(asked.headers).map(([k, v]) => [k.toLowerCase(), v]));
  assert.strictEqual(headers['stripe-account'], 'acct_1', 'a direct charge on the venue');
  assert.ok(headers['idempotency-key'].startsWith('vesopa-gp-'), 'one token, one charge');
  console.log('stripe-google-pay: checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
