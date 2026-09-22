/**
 * Cryptocurrency, via our own BTCPay Server and its Greenfield API.
 *
 * The node at pay.vesopaepos.com is ours, not a processor's. That is the whole
 * reason this gateway exists alongside the card ones: nobody sits between the
 * customer and us taking a percentage, there is no account that can be frozen,
 * and the store settles to wallets we hold. What it costs in exchange is that
 * "paid" is a slower and more interesting question than it is on a card, which
 * is what most of the care below is about.
 *
 * Env:
 *   BTCPAY_MODE            live | mock
 *   BTCPAY_URL             https://pay.vesopaepos.com  (no trailing slash)
 *   BTCPAY_API_KEY         Greenfield key — SERVER SIDE ONLY
 *   BTCPAY_STORE_ID        which store to invoice against
 *   BTCPAY_WEBHOOK_SECRET  verifies the webhook; SERVER SIDE ONLY
 *
 * `mock` mirrors sslcommerz.js, stripe.js and hestia.js: the whole journey runs
 * against `/pay/mock/*` with no money moving and no BTCPay account needed.
 *
 * ## Which statuses mean money
 *
 * BTCPay moves an invoice through New -> Processing -> Settled, and the middle
 * one is the trap. `Processing` means the customer has paid and the payment is
 * in the mempool, or on Lightning, in flight. It is NOT money yet: an on-chain
 * payment that is unconfirmed can still be replaced by its sender, and this
 * shop hands over a hosting account and — worse — registers domains at a
 * registry, neither of which can be taken back. So ONLY `Settled` settles,
 * which is BTCPay's word for "confirmed to the degree this store asked for" and
 * is governed by the store's own speed policy rather than by anything here.
 *
 * The visible cost is that the customer's browser comes back from a perfectly
 * good payment while the invoice still says Processing. isPaidInvoice() is
 * therefore not the only question the return route asks — see isPendingInvoice.
 */

const crypto = require('crypto');

const BASE_URL = (process.env.BTCPAY_URL || 'https://pay.vesopaepos.com').replace(/\/+$/, '');
const API_KEY = process.env.BTCPAY_API_KEY || '';
const STORE_ID = process.env.BTCPAY_STORE_ID || '';
const WEBHOOK_SECRET = process.env.BTCPAY_WEBHOOK_SECRET || '';
const MODE = (process.env.BTCPAY_MODE || (API_KEY && STORE_ID ? 'live' : 'mock')).toLowerCase();

const TIMEOUT_MS = Number(process.env.BTCPAY_TIMEOUT_MS) || 15_000;

/**
 * How long a crypto attempt stays worth asking BTCPay about.
 *
 * Longer than the 90 minutes the card gateways get, and for a reason that is
 * particular to this one: a card either authorises in seconds or does not, but
 * an on-chain payment broadcast in the last minute of the invoice window can
 * take another hour to confirm at a low fee. Closing the attempt at 90 minutes
 * would mark as expired a payment that is sitting in the mempool and will land.
 * Three hours covers a slow block; the store's own monitoring window (24h by
 * default) is what actually decides how late a payment BTCPay will still credit.
 */
const SESSION_MINUTES = Number(process.env.BTCPAY_SESSION_MINUTES) || 180;

const isLive = () => MODE === 'live';
const isConfigured = () => Boolean(API_KEY && STORE_ID);

function status() {
  return {
    mode: MODE,
    configured: isConfigured(),
    live: isLive() && isConfigured(),
    base: BASE_URL,
    store: STORE_ID,
    // Said out loud because a live gateway with no webhook secret still works
    // — it just falls back to the reconciler's polling, which is slower and
    // which nobody notices is doing all the work until it is switched off.
    webhook: Boolean(WEBHOOK_SECRET),
  };
}

// ---------------------------------------------------------------------------
// The API
// ---------------------------------------------------------------------------
async function call(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${BASE_URL}/api/v1${path}`, {
    method,
    headers: {
      // Greenfield's own scheme — the literal word `token`, not Bearer.
      Authorization: `token ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`BTCPay returned an unreadable response (${res.status}).`);
  }

  if (!res.ok) {
    // Greenfield answers a validation failure with an array of field errors and
    // everything else with a single {code, message}.
    const detail = Array.isArray(json)
      ? json.map((e) => e.message).filter(Boolean).join('; ')
      : json?.message;
    const err = new Error(detail || `BTCPay refused the request (${res.status}).`);
    err.btcpayCode = Array.isArray(json) ? 'validation' : json?.code;
    err.httpStatus = res.status;
    throw err;
  }
  return json;
}

// ---------------------------------------------------------------------------
// Starting a payment
// ---------------------------------------------------------------------------
/**
 * Open an invoice and get the URL to send the browser to.
 *
 * `amount` is in MAJOR units of `currency`, the same contract every adapter in
 * this folder takes. BTCPay is given the FIAT amount and does the conversion to
 * whichever coin the customer picks, at a rate it locks for the life of the
 * invoice — so the shop's price is the shop's price, and the exchange-rate risk
 * during those thirty minutes is the invoice's, not the customer's and not ours.
 *
 * @returns {Promise<{ok: true, tranId, redirectUrl} | {ok: false, error}>}
 */
async function initiate({
  amount, currency = 'GBP', orderRef, description,
  cusName, cusEmail, successUrl,
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
    const invoice = await call(`/stores/${encodeURIComponent(STORE_ID)}/invoices`, {
      method: 'POST',
      body: {
        amount: String(Number(amount).toFixed(2)),
        currency: String(currency).toUpperCase(),
        metadata: {
          orderId: orderRef,
          buyerName: cusName || undefined,
          buyerEmail: cusEmail || undefined,
          itemDesc: description || `Order ${orderRef}`,
        },
        checkout: {
          /*
           * OUR OWN REFERENCE IN THE RETURN URL, not the invoice id.
           *
           * The redirect target has to be decided when the invoice is created,
           * which is before its id exists. BTCPay does substitute an
           * `{InvoiceId}` placeholder, but the route does not need it: our
           * order reference is already unique per attempt, it is enough to find
           * our own payment row, and the invoice id we then ask BTCPay about
           * comes from that row rather than from the query string. One less
           * thing the browser is trusted with, and one less dependency on a
           * templating detail of somebody else's checkout page.
           */
          redirectURL: `${successUrl}${successUrl.includes('?') ? '&' : '?'}ref=${encodeURIComponent(orderRef)}`,
          redirectAutomatically: true,
          // Cancelling on BTCPay's page just leaves the invoice to expire —
          // there is no "cancel" callback to point anywhere.
        },
      },
    });
    return { ok: true, tranId: invoice.id, redirectUrl: invoice.checkoutLink };
  } catch (err) {
    return { ok: false, error: err.message || 'We could not reach the payment gateway. Please try again.' };
  }
}

/** Read an invoice back from BTCPay. The only source of truth for its status. */
async function getInvoice(invoiceId) {
  return call(`/stores/${encodeURIComponent(STORE_ID)}/invoices/${encodeURIComponent(invoiceId)}`);
}

/**
 * Can we still read our own store? Asked only when an invoice lookup fails.
 *
 * BTCPAY ANSWERS 403, NOT 404, FOR AN INVOICE THAT DOES NOT EXIST. That is
 * deliberate on their side — it refuses to tell an unauthorised caller whether
 * an id is real — but it makes "this invoice is gone" and "this key has been
 * revoked" the same HTTP status, and the two want opposite handling. Gone
 * means close the attempt; revoked means touch nothing, because closing every
 * pending attempt would mark real, paid-and-confirming payments as cancelled.
 *
 * One extra call on the error path settles it: if the store still reads, the
 * key is fine and the invoice is the thing that is missing.
 */
async function storeReachable() {
  try {
    await call(`/stores/${encodeURIComponent(STORE_ID)}`);
    return true;
  } catch {
    return false;
  }
}

/** Settled — confirmed to the store's speed policy. The only status that pays. */
function isPaidInvoice(invoice) {
  return String(invoice?.status || '') === 'Settled';
}

/**
 * Paid, but not yet confirmed. The customer is not at fault and must not be
 * told the payment failed — this is the state a browser almost always returns
 * in, and it becomes Settled on its own within a block or two.
 */
function isPendingInvoice(invoice) {
  return String(invoice?.status || '') === 'Processing';
}

/**
 * Dead: nothing was paid in time, or what was paid does not add up.
 *
 * `Expired` with an `additionalStatus` of `PaidPartial` or `PaidLate` is
 * deliberately NOT treated as dead here — money did arrive, and an order that
 * quietly cancels itself with a customer's coins sitting in our wallet is the
 * one failure in this file that a support ticket cannot fix from the outside.
 * It stays pending so that a human sees it.
 */
function isDeadInvoice(invoice) {
  const st = String(invoice?.status || '');
  const extra = String(invoice?.additionalStatus || 'None');
  if (st === 'Invalid') return true;
  return st === 'Expired' && extra === 'None';
}

/** Whether an expired/invalid invoice nevertheless received money. */
function hasPartialPayment(invoice) {
  return ['PaidPartial', 'PaidLate', 'PaidOver'].includes(String(invoice?.additionalStatus || ''));
}

/** Which coin and rail the customer actually used, for the admin. */
function describeMethod(invoice) {
  const st = String(invoice?.checkout?.paymentMethods || '');
  const paid = Array.isArray(invoice?.paymentMethods) ? invoice.paymentMethods : [];
  const used = paid.find((m) => Number(m.paymentMethodPaid || m.totalPaid || 0) > 0) || paid[0];
  const id = used?.paymentMethodId || used?.paymentMethod || st;
  return String(id || 'crypto').replace(/_/g, '-').slice(0, 120);
}

// ---------------------------------------------------------------------------
// The webhook
// ---------------------------------------------------------------------------
/**
 * Verify BTCPay's `BTCPay-Sig` header against the raw request body.
 *
 * THE RAW BYTES, not the parsed object. `JSON.stringify(req.body)` is a
 * different string from what was sent the moment BTCPay's serialiser and
 * Node's disagree about key order or number formatting, and the HMAC is over
 * bytes. server.js keeps the buffer on `req.rawBody` for exactly this.
 *
 * Compared with timingSafeEqual, and false on every failure path rather than
 * throwing — an unverified webhook is one answer, not an exception, and a 500
 * here would make BTCPay retry a delivery we are right to be refusing.
 */
function verifyWebhook(rawBody, signatureHeader) {
  if (!WEBHOOK_SECRET || !rawBody) return false;
  const sent = String(signatureHeader || '');
  if (!sent.startsWith('sha256=')) return false;

  const expected = `sha256=${crypto.createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex')}`;
  const a = Buffer.from(sent);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * The events worth subscribing to.
 *
 * `InvoiceSettled` is the one that pays. `InvoiceInvalid` and `InvoiceExpired`
 * close a dead attempt promptly instead of leaving it for the reconciler, and
 * `InvoicePaymentSettled` is what makes a partial payment visible while there
 * is still time to do something about it.
 */
const WEBHOOK_EVENTS = [
  'InvoiceSettled',
  'InvoiceInvalid',
  'InvoiceExpired',
  'InvoiceProcessing',
  'InvoicePaymentSettled',
];

module.exports = {
  status,
  isLive,
  isConfigured,
  initiate,
  getInvoice,
  storeReachable,
  isPaidInvoice,
  isPendingInvoice,
  isDeadInvoice,
  hasPartialPayment,
  describeMethod,
  verifyWebhook,
  WEBHOOK_EVENTS,
  SESSION_MINUTES,
  MODE,
  BASE_URL,
  STORE_ID,
};
