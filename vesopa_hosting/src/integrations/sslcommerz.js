/**
 * SSLCommerz, via BosheBoshe.
 *
 * BosheBoshe is the merchant of record and routes to SSLCommerz underneath. We
 * only ever talk to BosheBoshe: one API key, one signature scheme, one place to
 * look when a payment goes missing.
 *
 * Env:
 *   SSLCZ_BASE_URL    default https://bosheboshe.com  (no trailing slash)
 *   SSLCZ_API_KEY     public — sent in the initiate form
 *   SSLCZ_API_SECRET  signature verification and refunds — SERVER SIDE ONLY
 *   SSLCZ_MODE        live | mock
 *
 * `mock` is the same idea as DNA_MODE and HESTIA_MODE elsewhere in this app: the
 * whole payment journey runs, a payment row is written and settled, and no money
 * moves. It is what makes the checkout testable without a live card.
 *
 * THE SECRET NEVER LEAVES THIS FILE. It verifies callbacks and signs refund
 * requests; nothing else in the codebase needs to see it, and no template is
 * ever handed it.
 */

const crypto = require('crypto');

const BASE_URL = (process.env.SSLCZ_BASE_URL || 'https://bosheboshe.com').replace(/\/+$/, '');
const API_KEY = process.env.SSLCZ_API_KEY || '';
const API_SECRET = process.env.SSLCZ_API_SECRET || '';
const MODE = (process.env.SSLCZ_MODE || (API_KEY ? 'live' : 'mock')).toLowerCase();

/** How long to wait on the gateway before giving up, in ms. */
const TIMEOUT_MS = Number(process.env.SSLCZ_TIMEOUT_MS) || 15_000;

const isLive = () => MODE === 'live';
const isConfigured = () => Boolean(API_KEY && API_SECRET);

function status() {
  return {
    mode: MODE,
    configured: isConfigured(),
    live: isLive() && isConfigured(),
    base: BASE_URL,
  };
}

// ---------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------
/**
 * PHP's urlencode(), reproduced exactly.
 *
 * The gateway signs with PHP's http_build_query(), and the difference between
 * that and encodeURIComponent is not cosmetic: PHP writes a space as `+` and
 * escapes `~`, JavaScript does the opposite on both. A customer name with a
 * space in it — which is most of them — produces a different string, a
 * different HMAC, and a callback rejected as forged. This function is the
 * reason the signature check works on real orders and not only on test ones.
 */
function phpUrlencode(str) {
  return encodeURIComponent(str)
    .replace(/%20/g, '+')
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/~/g, '%7E');
}

/** PHP http_build_query() over ksort()ed keys — what the gateway signs. */
function phpHttpBuildQuery(params) {
  return Object.keys(params)
    .sort()
    .map((k) => `${phpUrlencode(k)}=${phpUrlencode(params[k])}`)
    .join('&');
}

/**
 * Recompute the HMAC the gateway appends to every callback and IPN.
 *
 * Signs every field EXCEPT `signature` itself. Returns false rather than
 * throwing, on every failure path, so a caller can treat "not verified" as one
 * answer — an exception here would turn a malformed callback into a 500 and a
 * retry storm from the gateway.
 *
 * NOTHING IS TRUSTED UNTIL THIS RETURNS TRUE. The browser return and the IPN
 * both arrive as ordinary HTTP requests that anybody can forge; the signature
 * is the only thing separating a real payment from someone typing our success
 * URL into their address bar with `status=VALID` on the end.
 */
function verifySignature(query) {
  if (!API_SECRET) return false;

  const data = {};
  let signature = '';
  for (const [k, v] of Object.entries(query || {})) {
    const val = Array.isArray(v) ? v[0] : v;
    if (val === undefined || val === null) continue;
    if (k === 'signature') {
      signature = String(val);
      continue;
    }
    data[k] = String(val);
  }
  if (!signature) return false;

  const expected = crypto
    .createHmac('sha256', API_SECRET)
    .update(phpHttpBuildQuery(data))
    .digest('hex');

  try {
    // Length-safe: timingSafeEqual throws on a mismatch of length, which is
    // itself a "no" rather than an error.
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

/** Only VALID means paid. Everything else — including VALIDATED — does not. */
function isPaidStatus(value) {
  return String(value || '').toUpperCase() === 'VALID';
}

// ---------------------------------------------------------------------------
// Starting a payment
// ---------------------------------------------------------------------------
/**
 * Open a payment session and get the URL to send the browser to.
 *
 * `amount` is in MAJOR units of `currency` — taka, not poisha. The gateway's
 * own field is a decimal string, and converting from our minor units is the
 * caller's job so that the rounding happens once, next to the money it belongs
 * to, and is recorded on the payment row.
 *
 * @returns {Promise<{ok: true, tranId, redirectUrl} | {ok: false, error, status?}>}
 */
async function initiate({
  amount, currency = 'BDT', orderRef,
  cusName, cusEmail, cusPhone, cusAddress, cusCity,
  successUrl, failUrl, cancelUrl, ipnUrl,
}) {
  if (MODE === 'mock') {
    /*
     * The mock returns a URL back into our own app, which is what makes the
     * whole journey walkable without a gateway account: the browser is
     * redirected to a page that offers "approve" and "decline", and both land
     * on the real callback handlers. The one thing it cannot exercise is the
     * signature check, so those handlers skip it in mock mode — deliberately,
     * and only there.
     */
    const tranId = `MOCK-${Date.now().toString(36).toUpperCase()}-${crypto.randomInt(1000, 9999)}`;
    return {
      ok: true,
      tranId,
      mock: true,
      redirectUrl: `/pay/mock/${encodeURIComponent(tranId)}`,
    };
  }

  if (!API_KEY) return { ok: false, error: 'The payment gateway is not configured.' };

  const form = new URLSearchParams({
    api_key: API_KEY,
    amount: Number(amount).toFixed(2),
    currency,
    order_ref: orderRef,
    cus_name: cusName || 'Customer',
    cus_email: cusEmail || '',
    cus_phone: cusPhone || '',
    cus_add1: cusAddress || 'N/A',
    cus_city: cusCity || 'N/A',
    success_url: successUrl,
    fail_url: failUrl,
    cancel_url: cancelUrl,
    response_type: 'json',
  });
  if (ipnUrl) form.set('ipn_url', ipnUrl);

  // An abandoned fetch would hold the customer on a spinner until nginx gave
  // up; a timeout gets them a real message and a Try again button.
  const abort = AbortSignal.timeout(TIMEOUT_MS);

  try {
    const res = await fetch(`${BASE_URL}/payment_proceed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: form.toString(),
      signal: abort,
    });

    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false, error: `The gateway returned an unreadable response (${res.status}).`, status: res.status };
    }

    if (!res.ok || json.status === 'error') {
      return { ok: false, error: json?.message || `The gateway refused the payment (${res.status}).`, status: res.status };
    }
    if (!json.redirect_url || !json.tran_id) {
      return { ok: false, error: 'The gateway did not return a payment link.' };
    }
    return { ok: true, tranId: String(json.tran_id), redirectUrl: String(json.redirect_url) };
  } catch (err) {
    const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError';
    return {
      ok: false,
      error: timedOut
        ? 'The payment gateway did not respond. Please try again.'
        : 'We could not reach the payment gateway. Please try again.',
    };
  }
}

/**
 * What the gateway told us about the payment method used, for the admin.
 *
 * Cherry-picked rather than passed through: the callback carries a lot of
 * fields and only these three say anything a human reading an order wants to
 * know. Truncated because it goes into a VARCHAR(120) and a gateway is free to
 * send whatever it likes.
 */
function describeMethod(q) {
  const bits = [q?.card_issuer, q?.card_brand, q?.card_type]
    .map((v) => String(v || '').trim())
    .filter(Boolean);
  return [...new Set(bits)].join(' · ').slice(0, 120);
}

module.exports = {
  BASE_URL,
  status,
  isLive,
  isConfigured,
  verifySignature,
  isPaidStatus,
  initiate,
  describeMethod,
  // Exported for the mock callback page, which has to build a payload the real
  // handlers will accept.
  phpHttpBuildQuery,
  MODE,
};
