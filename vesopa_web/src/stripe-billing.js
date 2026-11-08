'use strict';

/**
 * Stripe for vesopaepos.com's own sales: the hardware shop and Vesopa EPOS
 * subscriptions (owner, 2026-11-08: "integrate the stripe checkout with proper
 * Apple Pay and Google Pay support, do not redirect to stripe page").
 *
 * The same shape as dojo-billing.js, so shop.js and subscriptions.js do not
 * care which one takes the money (billing.js chooses). The customer pays on
 * vesopaepos.com/pay/<id>: Stripe's Payment Element and Express Checkout
 * Element on our own page, never a Stripe-hosted one.
 *
 * Keys, in the site's .env (never in the database or the page source):
 *   STRIPE_SECRET_KEY        sk_live_ (Vesopa Software Ltd) or sk_test_
 *   STRIPE_PUBLISHABLE_KEY   pk_live_ / pk_test_, the page's key
 *   STRIPE_WEBHOOK_SECRET    whsec_ of https://vesopaepos.com/webhooks/stripe
 * The mode comes from the key itself, so a test key can never take real money.
 */
const crypto = require('crypto');

const API = 'https://api.stripe.com';
const VERSION = '2025-09-30.clover';
const SITE = () => String(process.env.SITE_URL || 'https://vesopaepos.com').replace(/\/+$/, '');

const key = () => String(process.env.STRIPE_SECRET_KEY || '').trim();
const publishableKey = () => String(process.env.STRIPE_PUBLISHABLE_KEY || '').trim();
const configured = () => /^(sk|rk)_(test|live)_/.test(key()) && /^pk_(test|live)_/.test(publishableKey());
const mode = () => (/^(sk|rk)_live_/.test(key()) ? 'live' : 'sandbox');

class StripeError extends Error {
  constructor(status, message, body) { super(message); this.status = status; this.body = body; }
}

function form(obj, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === undefined || v === null) continue;
    const name = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((x, i) => (typeof x === 'object' ? form(x, `${name}[${i}]`, out) : out.append(`${name}[${i}]`, String(x))));
    else if (typeof v === 'object') form(v, name, out);
    else out.append(name, String(v));
  }
  return out;
}

async function call(method, path, body, { idempotencyKey } = {}) {
  if (!configured()) throw new StripeError(0, 'Stripe is not set up for vesopaepos.com (STRIPE_SECRET_KEY).');
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: `Bearer ${key()}`,
      'Stripe-Version': VERSION,
      ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    body: body ? form(body).toString() : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!res.ok) {
    const e = (json && json.error) || {};
    console.error(`[stripe] ${method} ${path.split('?')[0]} -> ${res.status} ${e.code || ''} ${e.request_log_url || ''}`);
    throw new StripeError(res.status, `Stripe: ${String(e.message || `HTTP ${res.status}`).slice(0, 220)}`, json);
  }
  return json;
}

/** A signed link to our own payment page, so an id alone cannot open it. */
function sign(id) {
  const secret = process.env.SESSION_SECRET || process.env.SUBS_SERVICE_KEY || key();
  return crypto.createHmac('sha256', `vesopa-pay|${secret}`).update(String(id)).digest('hex').slice(0, 24);
}
const checkoutUrl = (id) => `${SITE()}/pay/${encodeURIComponent(id)}?k=${sign(id)}`;
function signatureOk(id, k) {
  const want = sign(id);
  return typeof k === 'string' && k.length === want.length && crypto.timingSafeEqual(Buffer.from(k), Buffer.from(want));
}

/**
 * Dojo's words for where a payment stands, so the callers' checks hold for
 * both: Captured = paid, Authorized = the bank is still finishing.
 */
function asDojo(pi) {
  const s = pi.status;
  const declined = s === 'requires_payment_method' && pi.last_payment_error;
  const status = s === 'succeeded' ? 'Captured'
    : s === 'processing' || s === 'requires_capture' ? 'Authorized'
      : s === 'canceled' ? 'Canceled'
        : declined ? 'Declined' : 'Created';
  return { ...pi, stripe_status: s, status };
}

/**
 * A payment for the page to take: card, Apple Pay, Google Pay and Link. The
 * return address rides in metadata.
 */
async function createPaymentIntent({ amountMinor, reference, description, redirectUrl, email, kind }) {
  const pi = await call('POST', '/v1/payment_intents', {
    amount: amountMinor,
    currency: 'gbp',
    // Card (with Apple Pay and Google Pay, which are card wallets) and Link.
    payment_method_types: ['card', 'link'],
    description: description ? String(description).slice(0, 250) : undefined,
    statement_descriptor_suffix: 'VESOPA EPOS',
    receipt_email: email || undefined,
    metadata: {
      vesopa_ref: String(reference || '').slice(0, 300),
      vesopa_kind: kind || undefined,
      return_url: redirectUrl || undefined,
      site: 'vesopaepos.com',
    },
  }, { idempotencyKey: `vesopaepos-${crypto.randomUUID()}` });
  return asDojo(pi);
}

/** Stripe's payments stay payable until paid or cancelled: nothing to refresh. */
async function refreshClientSecret(id) {
  const pi = await call('GET', `/v1/payment_intents/${encodeURIComponent(id)}`);
  if (pi.status === 'canceled' || pi.status === 'succeeded') throw new StripeError(409, 'That payment can no longer be paid.');
  return asDojo(pi);
}

async function getPaymentIntent(id) {
  return asDojo(await call('GET', `/v1/payment_intents/${encodeURIComponent(id)}?expand[]=latest_charge`));
}

/** For our own page only: the client secret the Payment Element needs. */
const getForPage = (id) => call('GET', `/v1/payment_intents/${encodeURIComponent(id)}`);

async function chargePaymentIntent() {
  throw new StripeError(400, 'A saved Dojo card cannot be charged through Stripe.');
}

function refund(paymentIntentId, amountMinor, reason) {
  return call('POST', '/v1/refunds', {
    payment_intent: paymentIntentId,
    amount: amountMinor || undefined,
    metadata: { reason: String(reason || 'Refund').slice(0, 120) },
  }, { idempotencyKey: `vesopaepos-rf-${paymentIntentId}-${amountMinor || 'all'}-${crypto.createHash('sha1').update(String(reason || '')).digest('hex').slice(0, 8)}` });
}

const isPaid = (pi) => String((pi && pi.status) || '').toLowerCase() === 'captured';
const isFailed = (pi) => ['canceled', 'declined'].includes(String((pi && pi.status) || '').toLowerCase());

/** "Visa •• 4242", "Apple Pay (Visa •• 4242)", or null. */
function cardLabel(pi) {
  const ch = pi && typeof pi.latest_charge === 'object' ? pi.latest_charge : null;
  const card = ch && ch.payment_method_details && ch.payment_method_details.card;
  if (!card) return null;
  const brand = card.brand ? card.brand[0].toUpperCase() + card.brand.slice(1) : '';
  const base = `${brand} •• ${card.last4}`.trim();
  const wallet = card.wallet && card.wallet.type;
  const named = { apple_pay: 'Apple Pay', google_pay: 'Google Pay', link: 'Link', samsung_pay: 'Samsung Pay' }[wallet];
  return named ? `${named} (${base})` : base;
}

/** Stripe-Signature over the raw body; refused when older than five minutes. */
function verifyWebhook(rawBody, header, secret = process.env.STRIPE_WEBHOOK_SECRET, now = Date.now()) {
  if (!secret || !header || !rawBody) return false;
  const parts = String(header).split(',').map((p) => p.trim());
  const t = Number((parts.find((p) => p.startsWith('t=')) || '').slice(2));
  if (!t || Math.abs(now / 1000 - t) > 300) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return parts.filter((p) => p.startsWith('v1=')).map((p) => p.slice(3))
    .some((s) => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
}

module.exports = {
  provider: 'stripe', configured, mode, publishableKey, checkoutUrl, signatureOk, StripeError,
  createPaymentIntent, refreshClientSecret, getPaymentIntent, getForPage, chargePaymentIntent, refund,
  isPaid, isFailed, cardLabel, verifyWebhook, asDojo, form,
};
