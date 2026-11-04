/**
 * Stripe's API, for the venues that choose Stripe beside Dojo and Teya
 * (2026-11-04). See connect-recommend-plan.md at the repo root.
 *
 * Plain fetch rather than the SDK, as dojo_client.js and teya_client.js do:
 * the back office is hot-deployed file by file, and a new npm dependency is
 * one more thing a deploy can miss.
 *
 *   v2 (Accounts): JSON bodies, the Connect preview version (STRIPE_PREVIEW_VERSION)
 *   v1 (everything else): form-encoded, Stripe-Account for the venue's account
 *
 * Keys: STRIPE_SECRET_KEY (sk_test_ in the sandbox, sk_live_ once live) and
 * STRIPE_PUBLISHABLE_KEY, in the server's .env. Never in the database, never
 * sent to a till.
 */
'use strict';

const crypto = require('crypto');

const API = (process.env.STRIPE_API_BASE || 'https://api.stripe.com').replace(/\/+$/, '');
/** The Connect preview the plan's account configuration needs. */
const PREVIEW = process.env.STRIPE_PREVIEW_VERSION || '2026-10-28.preview';

class StripeError extends Error {
  constructor(status, code, message, raw) {
    super(message);
    this.status = status;
    this.code = code;
    this.raw = raw;
  }
}

const secretKey = () => String(process.env.STRIPE_SECRET_KEY || '').trim();
const configured = () => /^(sk|rk)_(test|live)_/.test(secretKey());
const environment = () => (/^(sk|rk)_live_/.test(secretKey()) ? 'live' : 'sandbox');

/** Stripe's form encoding: a[b][0]=c. */
function form(obj, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((x, i) => (typeof x === 'object' ? form(x, `${key}[${i}]`, out) : out.append(`${key}[${i}]`, String(x))));
    else if (typeof v === 'object') form(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

async function call(method, path, { body, account, v2 = false, idempotencyKey, fetchImpl = fetch } = {}) {
  if (!configured()) throw new StripeError(503, 'NOT_CONFIGURED', 'Stripe is not set up on this server yet.');
  const headers = { Authorization: `Bearer ${secretKey()}` };
  if (v2) {
    headers['Stripe-Version'] = PREVIEW;
    headers['Content-Type'] = 'application/json';
  } else if (body) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }
  if (account) headers['Stripe-Account'] = account;
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const res = await fetchImpl(API + path, {
    method,
    headers,
    body: body ? (v2 ? JSON.stringify(body) : form(body).toString()) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text.slice(0, 300) }; }
  if (!res.ok) {
    const e = json && json.error ? json.error : {};
    throw new StripeError(res.status, e.code || e.type || 'STRIPE_ERROR', e.message || `Stripe answered ${res.status}`, json);
  }
  return json;
}

// ---- Connected accounts (v2) ------------------------------------------------

/**
 * A venue's connected account: Express dashboard, Vesopa sets pricing,
 * Stripe holds losses; merchant configuration for direct charges and
 * customer configuration for Vesopa's licence billing.
 */
function createAccount({ email, name, country = 'gb', currency = 'gbp' }, opts = {}) {
  return call('POST', '/v2/core/accounts', {
    ...opts,
    v2: true,
    body: {
      contact_email: email || undefined,
      display_name: name || undefined,
      dashboard: 'express',
      identity: { country },
      configuration: {
        merchant: { capabilities: { card_payments: { requested: true } } },
        customer: { capabilities: { automatic_indirect_tax: { requested: true } } },
      },
      defaults: {
        currency,
        locales: ['en-GB'],
        responsibilities: { fees_collector: 'application', losses_collector: 'stripe' },
      },
      include: ['configuration.merchant', 'configuration.customer', 'requirements'],
    },
  });
}

function retrieveAccount(id, opts = {}) {
  const q = ['configuration.merchant', 'requirements'].map((x) => `include=${encodeURIComponent(x)}`).join('&');
  return call('GET', `/v2/core/accounts/${encodeURIComponent(id)}?${q}`, { ...opts, v2: true });
}

/** What the plan gates on: card payments and payouts both active. */
function readiness(account) {
  const caps = (account && account.configuration && account.configuration.merchant && account.configuration.merchant.capabilities) || {};
  const card = (caps.card_payments && caps.card_payments.status) || 'inactive';
  const payouts = (caps.stripe_balance && caps.stripe_balance.payouts && caps.stripe_balance.payouts.status) || 'inactive';
  const due = (account && account.requirements && account.requirements.entries) || [];
  return { card_payments: card, payouts, ready: card === 'active' && payouts === 'active', requirements_due: due.length };
}

/** Embedded components for the venue's Payments page. */
function accountSession(account, opts = {}) {
  const on = { enabled: true };
  return call('POST', '/v1/account_sessions', {
    ...opts,
    body: {
      account,
      components: {
        account_onboarding: on,
        notification_banner: on,
        account_management: on,
        payments: { enabled: true, features: { refund_management: true, dispute_management: true, capture_payments: true } },
        payouts: on,
        balance_report: on,
        payout_reconciliation_report: on,
      },
    },
  });
}

/** An Express dashboard login for the venue. */
function loginLink(account, opts = {}) {
  return call('POST', `/v1/accounts/${encodeURIComponent(account)}/login_links`, opts);
}

// ---- Terminal: Tap to Pay on the venue's account -----------------------------

function createLocation(account, { name, line1, city, postcode, country = 'GB' }, opts = {}) {
  return call('POST', '/v1/terminal/locations', {
    ...opts,
    account,
    body: { display_name: name, address: { line1, city, postal_code: postcode, country } },
  });
}

function connectionToken(account, location, opts = {}) {
  return call('POST', '/v1/terminal/connection_tokens', { ...opts, account, body: location ? { location } : {} });
}

/**
 * A card-present payment on the venue's account (a direct charge). No
 * application_fee_amount: the Platform Pricing Tool sets Vesopa's margin.
 */
function createTerminalPayment(account, { amountMinor, currency = 'gbp', reference, description }, opts = {}) {
  return call('POST', '/v1/payment_intents', {
    ...opts,
    account,
    idempotencyKey: reference ? `vesopa-tp-${reference}` : undefined,
    body: {
      amount: amountMinor,
      currency,
      payment_method_types: ['card_present'],
      capture_method: 'automatic',
      description: description || undefined,
      metadata: reference ? { vesopa_ref: reference } : undefined,
    },
  });
}

function retrievePayment(account, id, opts = {}) {
  return call('GET', `/v1/payment_intents/${encodeURIComponent(id)}`, { ...opts, account });
}

function cancelPayment(account, id, opts = {}) {
  return call('POST', `/v1/payment_intents/${encodeURIComponent(id)}/cancel`, { ...opts, account, body: {} });
}

function refund(account, { paymentIntent, amountMinor, reference }, opts = {}) {
  return call('POST', '/v1/refunds', {
    ...opts,
    account,
    idempotencyKey: reference ? `vesopa-rf-${reference}` : undefined,
    body: { payment_intent: paymentIntent, amount: amountMinor || undefined },
  });
}

// ---- Webhooks -----------------------------------------------------------------

/**
 * Check a webhook's Stripe-Signature against its raw body and secret: t= the
 * timestamp, v1= HMAC-SHA256 of "t.body". Refused when older than [tolerance]
 * seconds, so a captured request cannot be replayed later.
 */
function verifyWebhook(rawBody, header, secret, tolerance = 300, now = Date.now()) {
  if (!secret || !header || !rawBody) return false;
  const parts = Object.fromEntries(String(header).split(',').map((p) => p.split('=')).filter((p) => p.length === 2).map(([k, v]) => [k.trim(), v.trim()]));
  const t = Number(parts.t);
  if (!t || Math.abs(now / 1000 - t) > tolerance) return false;
  const sigs = String(header).split(',').filter((p) => p.trim().startsWith('v1=')).map((p) => p.trim().slice(3));
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody}`).digest('hex');
  return sigs.some((s) => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
}

module.exports = {
  StripeError,
  PREVIEW,
  configured,
  environment,
  form,
  createAccount,
  retrieveAccount,
  readiness,
  accountSession,
  loginLink,
  createLocation,
  connectionToken,
  createTerminalPayment,
  retrievePayment,
  cancelPayment,
  refund,
  verifyWebhook,
};
