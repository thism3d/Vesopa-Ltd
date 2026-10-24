'use strict';

/**
 * Dojo for Vesopa's own subscriptions (2026-10-24).
 *
 * The same API conventions as vesopa_server/src/dojo_client.js: the raw secret
 * key as `Authorization: Basic <key>` (not base64), a `version` header on every
 * call, money in pence.
 *
 * Key: DOJO_SUBS_KEY in the environment. It starts as the Dojo SANDBOX key
 * (sk_sandbox_...) the owner asked for; a live key (sk_prod_...) is only ever
 * set once Dojo has certified Vesopa EPOS for live subscriptions. The mode is
 * read from the key itself, so a sandbox key can never take real money.
 *
 * Flows used, all documented by Dojo:
 *   setup intent   POST /setup-intents -> customer authorises at
 *                  pay.dojo.tech/checkout/<id> -> POST /payment-intents with
 *                  setupIntentId -> POST /payment-intents/<id>/charge.
 *                  Single use: it pays the first charge after the trial.
 *   pay link       POST /payment-intents -> pay.dojo.tech/checkout/<id>, for
 *                  renewals and for a customer replacing a failed card.
 *   refund         POST /payment-intents/<id>/refunds
 */
const crypto = require('crypto');

const BASE = (process.env.DOJO_BASE_URL || 'https://api.dojo.tech').replace(/\/+$/, '');
const VERSION = '2024-02-05';

function key() { return String(process.env.DOJO_SUBS_KEY || '').trim(); }
function mode() { return key().startsWith('sk_prod_') ? 'live' : 'sandbox'; }
function configured() { return /^sk_(sandbox|prod)_/.test(key()); }

class DojoError extends Error {
  constructor(status, message, body) { super(message); this.status = status; this.body = body; }
}

async function call(method, path, body) {
  if (!configured()) throw new DojoError(0, 'Dojo is not set up for subscriptions (DOJO_SUBS_KEY).');
  const res = await fetch(BASE + path, {
    method,
    headers: {
      Authorization: 'Basic ' + key(),
      version: VERSION,
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      // A retried request must not charge twice.
      ...(method === 'POST' ? { 'Idempotency-Key': crypto.randomUUID() } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!res.ok) {
    const said = (json && (json.detail || json.title || json.message || (json.errors && JSON.stringify(json.errors)))) || `HTTP ${res.status}`;
    throw new DojoError(res.status, `Dojo: ${String(said).slice(0, 220)}`, json);
  }
  return json;
}

const checkoutUrl = (id) => 'https://pay.dojo.tech/checkout/' + encodeURIComponent(id);

/** Save and authorise the card for the first charge after the trial. */
async function createSetupIntent({ reference, amountMinor, terms, redirectUrl }) {
  const body = {
    reference: String(reference).slice(0, 80),
    merchantInitiatedTransactionType: 'Unscheduled',
    terms: String(terms).slice(0, 500),
    intendedAmount: { value: amountMinor, currencyCode: 'GBP' },
  };
  try {
    return await call('POST', '/setup-intents', redirectUrl ? { ...body, config: { redirectUrl, cancelUrl: redirectUrl } } : body);
  } catch (e) {
    // Older API shapes refuse `config` on setup intents: the checkout then
    // falls back to Dojo's own success page, and the return page polls.
    if (redirectUrl && e.status === 400) return call('POST', '/setup-intents', body);
    throw e;
  }
}

const getSetupIntent = (id) => call('GET', '/setup-intents/' + encodeURIComponent(id));

/** A payment intent; with setupIntentId it can be charged without the customer. */
function createPaymentIntent({ amountMinor, reference, description, redirectUrl, setupIntentId }) {
  return call('POST', '/payment-intents', {
    amount: { value: amountMinor, currencyCode: 'GBP' },
    reference: String(reference).slice(0, 80),
    ...(description ? { description: String(description).slice(0, 120) } : {}),
    ...(setupIntentId ? { setupIntentId } : {}),
    ...(redirectUrl ? { config: { redirectUrl, cancelUrl: redirectUrl } } : {}),
  });
}

const chargePaymentIntent = (id) => call('POST', '/payment-intents/' + encodeURIComponent(id) + '/charge');
const getPaymentIntent = (id) => call('GET', '/payment-intents/' + encodeURIComponent(id));

function refund(paymentIntentId, amountMinor, reason) {
  return call('POST', '/payment-intents/' + encodeURIComponent(paymentIntentId) + '/refunds', {
    amount: amountMinor,
    refundReason: String(reason || 'Refund').slice(0, 120),
  });
}

/** Paid means Captured (Dojo's own word); see dojo_client.js for why not Authorized. */
function isPaid(pi) { return String((pi && pi.status) || '').toLowerCase() === 'captured'; }
function isFailed(pi) { return ['canceled', 'cancelled', 'declined', 'failed', 'reversed'].includes(String((pi && pi.status) || '').toLowerCase()); }

/** "Visa •• 4242" from whatever card details Dojo returned, or null. */
function cardLabel(obj) {
  const pd = (obj && (obj.paymentDetails || obj.paymentMethod || obj.card)) || {};
  const last4 = pd.cardNumber ? String(pd.cardNumber).slice(-4) : pd.last4 || null;
  const scheme = pd.cardScheme || pd.scheme || pd.brand || '';
  return last4 ? `${scheme ? scheme + ' ' : ''}•• ${last4}`.trim() : null;
}

module.exports = {
  configured, mode, checkoutUrl, DojoError,
  createSetupIntent, getSetupIntent, createPaymentIntent, chargePaymentIntent, getPaymentIntent, refund,
  isPaid, isFailed, cardLabel,
};
