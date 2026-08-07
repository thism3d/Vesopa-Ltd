/**
 * Stripe, via Checkout Sessions.
 *
 * A HOSTED page, deliberately — the same shape as SSLCommerz. Checkout Sessions
 * put card, Apple Pay and Google Pay behind one Stripe-hosted URL and Stripe
 * decides which wallets to show from what is enabled in the Dashboard and what
 * the browser supports. The alternative — mounting Stripe's Payment Element on
 * our own page — needs a domain-verification file for Apple Pay that only the
 * Stripe Dashboard can issue; the hosted page needs none of that because the
 * page itself is served from a domain Stripe already owns.
 *
 * Env:
 *   STRIPE_MODE           live | mock
 *   STRIPE_SECRET_KEY     SERVER SIDE ONLY — creates sessions, reads them back
 *   STRIPE_PUBLISHABLE_KEY  not currently used server-side; kept for a future
 *                           embedded flow, exported so nothing has to guess it
 *
 * `mock` mirrors sslcommerz.js and hestia.js: the whole journey runs against
 * `/pay/mock/*` with no money moving, which is what makes checkout walkable
 * without a Stripe account.
 */

const crypto = require('crypto');

const API_BASE = 'https://api.stripe.com/v1';
const API_VERSION = '2024-06-20';

const SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY || '';
const MODE = (process.env.STRIPE_MODE || (SECRET_KEY ? 'live' : 'mock')).toLowerCase();

const TIMEOUT_MS = Number(process.env.STRIPE_TIMEOUT_MS) || 15_000;

const isLive = () => MODE === 'live';
const isConfigured = () => Boolean(SECRET_KEY);

function status() {
  return {
    mode: MODE,
    configured: isConfigured(),
    live: isLive() && isConfigured(),
    publishableKey: PUBLISHABLE_KEY,
  };
}

// ---------------------------------------------------------------------------
// Stripe's API is form-encoded with bracket notation for nested fields —
// `line_items[0][price_data][unit_amount]` rather than JSON. Flattened once
// here so the caller can hand over a plain nested object.
// ---------------------------------------------------------------------------
function flatten(obj, prefix, out) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === '') continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (item && typeof item === 'object') flatten(item, `${key}[${i}]`, out);
        else out.push([`${key}[${i}]`, String(item)]);
      });
    } else if (typeof v === 'object') {
      flatten(v, key, out);
    } else {
      out.push([key, String(v)]);
    }
  }
  return out;
}

function toFormBody(obj) {
  const pairs = flatten(obj, '', []);
  return pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}

async function request(path, { method = 'POST', body } = {}) {
  const abort = AbortSignal.timeout(TIMEOUT_MS);
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Stripe-Version': API_VERSION,
    },
    ...(body ? { body: toFormBody(body) } : {}),
    signal: abort,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Stripe returned an unreadable response (${res.status}).`);
  }
  if (!res.ok) {
    const msg = json?.error?.message || `Stripe refused the request (${res.status}).`;
    const err = new Error(msg);
    err.stripeCode = json?.error?.code;
    throw err;
  }
  return json;
}

// ---------------------------------------------------------------------------
// Starting a payment
// ---------------------------------------------------------------------------
/**
 * Open a Checkout Session and get the URL to send the browser to.
 *
 * `amount` is in MAJOR units of `currency`, matching the sslcommerz adapter's
 * contract — the caller already did the minor-to-major conversion once, next
 * to the money it belongs to.
 *
 * @returns {Promise<{ok: true, tranId, redirectUrl} | {ok: false, error}>}
 */
async function initiate({
  amount, currency = 'GBP', orderRef, description,
  cusEmail, successUrl, cancelUrl,
}) {
  if (MODE === 'mock') {
    // Same trick as sslcommerz.js: a fake tran id that routes back into our
    // own /pay/mock/:tranId, so the whole journey is walkable with no account.
    const tranId = `MOCK-${Date.now().toString(36).toUpperCase()}-${crypto.randomInt(1000, 9999)}`;
    return {
      ok: true,
      tranId,
      mock: true,
      redirectUrl: `/pay/mock/${encodeURIComponent(tranId)}`,
    };
  }

  if (!isConfigured()) return { ok: false, error: 'The payment gateway is not configured.' };

  // Stripe wants the amount in the currency's smallest unit as an integer —
  // the same "minor units" this whole app already works in, so no rounding
  // step is introduced here that is not already accounted for by the caller.
  const minorAmount = Math.round(Number(amount) * 100);

  try {
    const session = await request('/checkout/sessions', {
      body: {
        mode: 'payment',
        client_reference_id: orderRef,
        customer_email: cusEmail || undefined,
        /*
         * ADAPTIVE PRICING OFF.
         *
         * Left on, Stripe re-presents the total in the viewer's local currency
         * and adds its own conversion fee, so a basket that said $45.48 arrives
         * at a payment page saying something else. This app already decides
         * what currency a customer is charged in — see toSettlement() — and a
         * second, invisible conversion on top of that is exactly the kind of
         * surprise the currency code was written to avoid.
         */
        adaptive_pricing: { enabled: 'false' },
        // {CHECKOUT_SESSION_ID} is a literal placeholder Stripe substitutes —
        // not something evaluated here.
        success_url: `${successUrl}${successUrl.includes('?') ? '&' : '?'}session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: cancelUrl,
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: currency.toLowerCase(),
              unit_amount: minorAmount,
              product_data: { name: description || `Order ${orderRef}` },
            },
          },
        ],
      },
    });
    return { ok: true, tranId: session.id, redirectUrl: session.url };
  } catch (err) {
    return { ok: false, error: err.message || 'We could not reach the payment gateway. Please try again.' };
  }
}

/**
 * Read a Checkout Session back from Stripe, to confirm it is genuinely paid.
 *
 * NOTHING FROM THE BROWSER RETURN IS TRUSTED — the session is fetched fresh
 * from Stripe by id and `payment_status` read from that response, the same
 * principle as sslcommerz's HMAC check: a query string anyone can forge is
 * never the source of truth for money changing hands.
 */
async function retrieveSession(sessionId) {
  return request(`/checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=payment_intent.payment_method`, { method: 'GET' });
}

function isPaidSession(session) {
  return Boolean(session) && session.payment_status === 'paid';
}

/** What the customer paid with, for the admin. Best-effort — never a card number. */
function describeMethod(session) {
  const pm = session?.payment_intent?.payment_method;
  if (pm?.type === 'card' && pm.card) {
    return `${pm.card.brand || 'card'} ···· ${pm.card.last4 || ''}`.trim().slice(0, 120);
  }
  const types = Array.isArray(session?.payment_method_types) ? session.payment_method_types : [];
  return types.join(' · ').slice(0, 120);
}

module.exports = {
  status,
  isLive,
  isConfigured,
  initiate,
  retrieveSession,
  isPaidSession,
  describeMethod,
  MODE,
  PUBLISHABLE_KEY,
};
