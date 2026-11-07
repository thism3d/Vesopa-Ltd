/**
 * Stripe card readers for Go on an iPad (2026-11-07): what a reader payment
 * looks like to Go's card-machine screen, and what is asked of Stripe.
 */
'use strict';

const assert = require('assert');
const stripe = require('../src/stripe_client');

const pi = (status) => ({ id: 'pi_1', status });
const reader = (status, failure) => ({
  action: { status, failure_message: failure, process_payment_intent: { payment_intent: 'pi_1' } },
});

assert.deepStrictEqual(stripe.readerState(pi('succeeded'), reader('succeeded')), { state: 'paid' });
assert.deepStrictEqual(stripe.readerState(pi('canceled'), null), { state: 'cancelled' });
assert.deepStrictEqual(stripe.readerState(pi('requires_payment_method'), reader('failed', 'Card declined')),
  { state: 'failed', message: 'Card declined' });
assert.strictEqual(stripe.readerState(pi('requires_payment_method'), reader('in_progress')).prompt, 'present card');
assert.strictEqual(stripe.readerState(pi('processing'), reader('in_progress')).prompt, 'processing');
// Another payment's failure on the same reader is not this one's.
const other = { action: { status: 'failed', process_payment_intent: { payment_intent: 'pi_2' } } };
assert.strictEqual(stripe.readerState(pi('requires_payment_method'), other).state, 'pending');

(async () => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_x';
  const asked = [];
  const fetchImpl = async (url, init) => {
    asked.push({ url: String(url), body: String(init.body || ''), headers: init.headers });
    return { ok: true, status: 200, text: async () => '{"id":"tmr_1"}' };
  };
  await stripe.processOnReader('acct_1', 'tmr_1', 'pi_1', { fetchImpl });
  assert.ok(asked[0].url.endsWith('/v1/terminal/readers/tmr_1/process_payment_intent'));
  assert.strictEqual(new URLSearchParams(asked[0].body).get('payment_intent'), 'pi_1');
  assert.strictEqual(asked[0].headers['Stripe-Account'], 'acct_1');
  await stripe.listReaders('acct_1', 'tml_1', { fetchImpl });
  assert.ok(asked[1].url.includes('location=tml_1'));
  await stripe.presentTestCard('acct_1', 'tmr_1', { fetchImpl });
  assert.ok(asked[2].url.endsWith('/v1/test_helpers/terminal/readers/tmr_1/present_payment_method'));
  assert.strictEqual(asked[2].body, '', "no card named: Stripe default approved card");
  await stripe.presentTestCard('acct_1', 'tmr_1', { fetchImpl, card: 'declined' });
  assert.strictEqual(new URLSearchParams(asked[3].body).get('card_present[number]'), '4000000000000002');
  await stripe.presentTestCard('acct_1', 'tmr_1', { fetchImpl, card: 'anything else' });
  assert.strictEqual(asked[4].body, '', 'an unknown case never sends a number');
  console.log('stripe-readers: ok');
})().catch((e) => { console.error(e); process.exit(1); });
