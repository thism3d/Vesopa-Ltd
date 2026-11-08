/**
 * A venue in live mode beside sandbox ones (2026-11-08): The Vesopa Kitchen
 * takes real payments into Vesopa Software Ltd's own account while every
 * other Stripe venue stays in the sandbox.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');

process.env.STRIPE_SECRET_KEY = 'sk_test_sandbox';
process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_sandbox';
process.env.STRIPE_LIVE_SECRET_KEY = 'sk_live_real';
process.env.STRIPE_LIVE_PUBLISHABLE_KEY = 'pk_live_real';

const stripe = require('../src/stripe_client');

function recorder() {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, headers: init.headers });
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'pi_1', charges_enabled: true, payouts_enabled: true }) };
  };
  return { seen, fetchImpl };
}

test('a live venue on the platform uses the live key and no Stripe-Account', async () => {
  const r = recorder();
  const row = { environment: 'live', account_id: stripe.PLATFORM };
  await stripe.createTerminalPayment(row.account_id, { amountMinor: 100 }, { ...stripe.optsFor(row), fetchImpl: r.fetchImpl });
  assert.strictEqual(r.seen[0].headers.Authorization, 'Bearer sk_live_real');
  assert.strictEqual(r.seen[0].headers['Stripe-Account'], undefined);
  assert.strictEqual(stripe.publishableFor('live'), 'pk_live_real');
  assert.strictEqual(stripe.environmentOf('live'), 'live');
});

test('a sandbox venue keeps the sandbox key and its connected account', async () => {
  const r = recorder();
  const row = { environment: 'sandbox', account_id: 'acct_venue' };
  await stripe.retrievePayment(row.account_id, 'pi_1', { ...stripe.optsFor(row), fetchImpl: r.fetchImpl });
  assert.strictEqual(r.seen[0].headers.Authorization, 'Bearer sk_test_sandbox');
  assert.strictEqual(r.seen[0].headers['Stripe-Account'], 'acct_venue');
  assert.strictEqual(stripe.environmentOf(null), 'sandbox');
});

test('the platform is ready when it may charge and pay out', async () => {
  const r = recorder();
  const s = await stripe.platformReadiness({ key: 'sk_live_real', fetchImpl: r.fetchImpl });
  assert.deepStrictEqual([s.card_payments, s.payouts, s.ready], ['active', 'active', true]);
});
