/**
 * PayPal, via the Orders v2 API.
 *
 * A HOSTED page, not the JS SDK buttons vesopa_web uses — this app's checkout
 * already redirects to a gateway (SSLCommerz) and back, so an order's own
 * `approve` link, followed directly, fits that shape with no client-side SDK
 * and no embedded button to keep working. One order, captured once, matching
 * how a domain or a hosting term is actually sold here: not a subscription.
 *
 * Env:
 *   PAYPAL_MODE            sandbox | live | mock
 *   PAYPAL_CLIENT_ID       public — sent to nobody but PayPal's own API
 *   PAYPAL_CLIENT_SECRET   SERVER SIDE ONLY — mints the OAuth token
 *
 * `mock` mirrors sslcommerz.js: the whole journey runs against `/pay/mock/*`
 * with no money moving.
 */

const crypto = require('crypto');

const CLIENT_ID = process.env.PAYPAL_CLIENT_ID || '';
const CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET || '';
const MODE = (process.env.PAYPAL_MODE || (CLIENT_ID ? 'sandbox' : 'mock')).toLowerCase();
const API_BASE = MODE === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';

const TIMEOUT_MS = Number(process.env.PAYPAL_TIMEOUT_MS) || 15_000;

const isLive = () => MODE === 'live';
const isConfigured = () => Boolean(CLIENT_ID && CLIENT_SECRET);

function status() {
  return {
    mode: MODE,
    configured: isConfigured(),
    // Sandbox counts as a working gateway — same reasoning as sslcommerz's
    // `mock`, except this one is a real PayPal environment with fake money,
    // so it is "live" enough to exercise the checkout end to end.
    live: (isLive() || MODE === 'sandbox') && isConfigured(),
    base: API_BASE,
  };
}

let cachedToken = null;

async function accessToken() {
  if (cachedToken && cachedToken.expires > Date.now()) return cachedToken.value;

  const res = await fetch(`${API_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`PayPal auth failed: ${res.status} ${text}`);

  const data = JSON.parse(text);
  cachedToken = { value: data.access_token, expires: Date.now() + (data.expires_in - 60) * 1000 };
  return cachedToken.value;
}

async function call(path, { method = 'POST', body } = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${await accessToken()}`,
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`PayPal ${method} ${path} failed: ${res.status} ${text}`);
    try {
      err.paypalName = JSON.parse(text).name;
    } catch {
      /* not JSON */
    }
    throw err;
  }
  return text ? JSON.parse(text) : {};
}

// ---------------------------------------------------------------------------
// Starting a payment
// ---------------------------------------------------------------------------
/**
 * Create an order and get the URL to send the browser to.
 *
 * `amount` is in MAJOR units of `currency`, same contract as the sslcommerz
 * and stripe adapters.
 *
 * @returns {Promise<{ok: true, tranId, redirectUrl} | {ok: false, error}>}
 */
async function initiate({
  amount, currency = 'GBP', orderRef, description,
  successUrl, cancelUrl,
}) {
  if (MODE === 'mock') {
    const tranId = `MOCK-${Date.now().toString(36).toUpperCase()}-${crypto.randomInt(1000, 9999)}`;
    return {
      ok: true,
      tranId,
      mock: true,
      redirectUrl: `/pay/mock/${encodeURIComponent(tranId)}`,
    };
  }

  if (!isConfigured()) return { ok: false, error: 'The payment gateway is not configured.' };

  try {
    const order = await call('/v2/checkout/orders', {
      body: {
        intent: 'CAPTURE',
        purchase_units: [
          {
            reference_id: orderRef,
            custom_id: orderRef,
            description: (description || `Order ${orderRef}`).slice(0, 127),
            amount: { currency_code: currency, value: Number(amount).toFixed(2) },
          },
        ],
        application_context: {
          brand_name: 'Vesopa Cloud',
          // The customer never sees a shipping form for a domain or a hosting
          // account, and PAY_NOW skips PayPal's own "Continue" interstitial.
          shipping_preference: 'NO_SHIPPING',
          user_action: 'PAY_NOW',
          return_url: successUrl,
          cancel_url: cancelUrl,
        },
      },
    });

    const approve = (order.links || []).find((l) => l.rel === 'approve' || l.rel === 'payer-action');
    if (!approve) return { ok: false, error: 'PayPal did not return an approval link.' };
    return { ok: true, tranId: order.id, redirectUrl: approve.href };
  } catch (err) {
    return { ok: false, error: 'We could not reach the payment gateway. Please try again.' };
  }
}

/**
 * Capture an order the customer just approved.
 *
 * Safe to call twice: PayPal answers a second capture on an already-captured
 * order with an ORDER_ALREADY_CAPTURED error, and the recovery is to read the
 * order back rather than treat that as a failure — the same pattern
 * vesopa_web's paypal.js already uses.
 */
async function captureOrder(orderId) {
  try {
    return await call(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`);
  } catch (err) {
    if (!/ORDER_ALREADY_CAPTURED/.test(err.message)) throw err;
    return call(`/v2/checkout/orders/${encodeURIComponent(orderId)}`, { method: 'GET' });
  }
}

/**
 * Read an order back without capturing it.
 *
 * What the reconciler asks with. A customer who approved the payment and then
 * closed the tab leaves an order sitting at APPROVED — the money is authorised
 * and nobody has taken it, and only asking PayPal reveals that. Capturing is a
 * separate, deliberate step afterwards, so this can be called on a schedule
 * without ever moving money by accident.
 */
async function getOrder(orderId) {
  return call(`/v2/checkout/orders/${encodeURIComponent(orderId)}`, { method: 'GET' });
}

function isPaidOrder(order) {
  return Boolean(order) && order.status === 'COMPLETED';
}

/** Approved by the payer but not yet captured — money waiting to be taken. */
function isApprovedOrder(order) {
  return Boolean(order) && (order.status === 'APPROVED' || order.status === 'SAVED');
}

/** What the customer paid with, for the admin. */
function describeMethod(order) {
  const source = order?.payment_source ? Object.keys(order.payment_source)[0] : '';
  return String(source || 'paypal').slice(0, 120);
}

module.exports = {
  status,
  isLive,
  isConfigured,
  initiate,
  captureOrder,
  getOrder,
  isPaidOrder,
  isApprovedOrder,
  describeMethod,
  MODE,
};
