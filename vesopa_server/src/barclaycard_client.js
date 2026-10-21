/**
 * Barclaycard Smartpay Fuse (2026-10-20): the third acquirer beside Dojo and
 * Teya, for online payments. Smartpay Fuse is CyberSource's REST API under
 * Barclaycard's hosts, signed with HTTP Signature (HmacSHA256): the merchant
 * (organisation) id, a key id and its shared secret, all from the Smartpay
 * Fuse Business Center. Nothing here stores anything: the caller passes the
 * credentials (sealed per venue in the back office).
 */
const crypto = require('crypto');

const HOSTS = {
  sandbox: 'api.smartpayfuse-test.barclaycard',
  live: 'api.smartpayfuse.barclaycard',
};

class BarclaycardError extends Error {
  constructor(status, code, message, body) {
    super(message);
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

const cleanEnv = (env) => (env === 'live' ? 'live' : 'sandbox');

/** The HTTP Signature headers for one request. */
function signedHeaders({ env, merchantId, keyId, secret }, method, path, body) {
  const host = HOSTS[cleanEnv(env)];
  const date = new Date().toUTCString();
  const headers = { host, date, 'v-c-merchant-id': merchantId };
  const names = ['host', 'date', '(request-target)'];
  if (body != null) {
    headers.digest = 'SHA-256=' + crypto.createHash('sha256').update(body, 'utf8').digest('base64');
    names.push('digest');
  }
  names.push('v-c-merchant-id');
  const line = (n) => (n === '(request-target)' ? `(request-target): ${method.toLowerCase()} ${path}` : `${n}: ${headers[n]}`);
  const signingString = names.map(line).join('\n');
  const sig = crypto.createHmac('sha256', Buffer.from(secret, 'base64')).update(signingString, 'utf8').digest('base64');
  headers.signature = `keyid="${keyId}", algorithm="HmacSHA256", headers="${names.join(' ')}", signature="${sig}"`;
  return headers;
}

async function call(creds, method, path, payload, { timeoutMs = 30000 } = {}) {
  const body = payload == null ? null : JSON.stringify(payload);
  const { host, ...headers } = signedHeaders(creds, method, path, body);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    // fetch sets Host itself, to the same value that was signed.
    res = await fetch(`https://${host}${path}`, {
      method,
      headers: {
        ...headers,
        'content-type': 'application/json;charset=utf-8',
        accept: 'application/hal+json;charset=utf-8, application/json, application/jwt',
      },
      body,
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new BarclaycardError(0, e.name === 'AbortError' ? 'TIMEOUT' : 'UNREACHABLE',
      e.name === 'AbortError' ? 'Barclaycard did not answer in time.' : 'Could not reach Barclaycard.');
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) { json = null; }
  if (!res.ok) {
    const msg = (json && (json.message || (json.response && json.response.rmsg) || json.reason)) || `Barclaycard answered ${res.status}.`;
    throw new BarclaycardError(res.status, (json && (json.reason || json.status)) || 'HTTP_' + res.status, String(msg).slice(0, 300), json);
  }
  return json != null ? json : text;
}

/**
 * Unified Checkout capture context: a signed JWT the payment page loads
 * Barclaycard's own card form (and Apple Pay / Google Pay) with. Card numbers
 * never touch Vesopa.
 */
function captureContext(creds, { targetOrigins, amountMinor, reference, complete = false, currency = 'GBP', country = 'GB', locale = 'en_GB', clientVersion = '0.31' }) {
  const body = {
    targetOrigins,
    clientVersion,
    allowedCardNetworks: ['VISA', 'MASTERCARD', 'AMEX', 'MAESTRO'],
    allowedPaymentTypes: ['PANENTRY', 'APPLEPAY', 'GOOGLEPAY'],
    country,
    locale,
    // 3-D Secure wants the cardholder's email and billing postcode (M05:
    // "a full valid message"), so the form asks for them when it pays.
    captureMandate: complete
      ? { billingType: 'PARTIAL', requestEmail: true, requestPhone: false, requestShipping: false, showAcceptedNetworkIcons: true }
      : { billingType: 'NONE', requestEmail: false, requestPhone: false, requestShipping: false, showAcceptedNetworkIcons: true },
    orderInformation: { amountDetails: { totalAmount: (amountMinor / 100).toFixed(2), currency } },
  };
  if (reference) body.clientReferenceInformation = { code: String(reference).slice(0, 50) };
  // The form itself authenticates the cardholder (3-D Secure 2, Strong
  // Customer Authentication) and takes the payment: Barclaycard declines an
  // online card payment without it (M05 test 19, reason 478).
  if (complete) body.completeMandate = { type: 'CAPTURE', consumerAuthentication: true };
  return call(creds, 'POST', '/up/v1/capture-contexts', body);
}

/** Authorise and capture in one, from a Unified Checkout transient token or a card. */
function pay(creds, { reference, amountMinor, currency = 'GBP', transientToken, card, billTo }) {
  const body = {
    clientReferenceInformation: { code: String(reference).slice(0, 50) },
    processingInformation: { capture: true },
    orderInformation: {
      amountDetails: { totalAmount: (amountMinor / 100).toFixed(2), currency },
      // Barclaycard asks for a bill-to on every payment. A table order has
      // no address, so the customer's name (or "Guest") at the venue's own.
      billTo: billToFor(billTo),
    },
  };
  if (transientToken) body.tokenInformation = { transientTokenJwt: transientToken };
  if (card) body.paymentInformation = { card };
  // A decline is an answer, not a failure: Barclaycard sends DECLINED (201)
  // or INVALID_REQUEST (400) with the reason, which outcomeOf() reads.
  return call(creds, 'POST', '/pts/v2/payments', body).catch((e) => {
    if (e instanceof BarclaycardError && (e.status === 400 || e.status === 402) && e.body && e.body.status) return e.body;
    throw e;
  });
}

/**
 * Give back an authorisation that was not captured: a "soft decline"
 * (AUTHORIZED_PENDING_REVIEW, M05 CVN 004 and AVS 2418.00) leaves the money
 * held on the card until it is reversed.
 */
function reverse(creds, paymentId, { reference, amountMinor, currency = 'GBP' }) {
  return call(creds, 'POST', `/pts/v2/payments/${encodeURIComponent(paymentId)}/reversals`, {
    clientReferenceInformation: { code: String(reference).slice(0, 50) },
    reversalInformation: { amountDetails: { totalAmount: (amountMinor / 100).toFixed(2), currency }, reason: 'not captured' },
  });
}

/**
 * Take back a payment that must not stand (a soft decline, or our CVV rule):
 * voided when it was captured today, reversed when it was only authorised.
 */
async function undo(creds, paymentId, { reference, amountMinor }) {
  try {
    return await voidPayment(creds, paymentId, { reference: `${reference}-void`.slice(0, 50) });
  } catch (e) {
    return reverse(creds, paymentId, { reference: `${reference}-rev`.slice(0, 50), amountMinor });
  }
}

/**
 * What Barclaycard's response codes mean for the customer and the clerk, from
 * Barclaycard's M05 Test Cases ("Barclays Code description / action").
 * retry: 'other_card' | 'later' | 'lower' | 'fix' | 'never'.
 */
const RESPONSE_CODES = {
  '3': { text: 'This card cannot be used here.', retry: 'other_card' },
  '5': { text: 'The card was declined by the bank.', retry: 'other_card' },
  '12': { text: 'The bank did not allow this payment.', retry: 'other_card' },
  '13': { text: 'The amount is over the card\'s limit.', retry: 'lower' },
  '14': { text: 'The card number was not recognised.', retry: 'fix' },
  '15': { text: 'The card\'s bank could not be reached.', retry: 'later' },
  '19': { text: 'The payment did not go through.', retry: 'fix' },
  '21': { text: 'The payment did not go through.', retry: 'other_card' },
  '30': { text: 'The payment did not go through.', retry: 'other_card' },
  '41': { text: 'The card was declined by the bank.', retry: 'never' },
  '43': { text: 'The card was declined by the bank.', retry: 'never' },
  '51': { text: 'There are not enough funds on this card.', retry: 'lower' },
  '57': { text: 'The bank did not allow this payment on this card.', retry: 'other_card' },
  '58': { text: 'The bank did not allow this payment on this card.', retry: 'other_card' },
  '59': { text: 'The card was declined by the bank.', retry: 'never' },
  '61': { text: 'This would go over the card\'s limit.', retry: 'lower' },
  '62': { text: 'This card is restricted.', retry: 'other_card' },
  '63': { text: 'The bank did not allow this payment.', retry: 'other_card' },
  '65': { text: 'The bank needs to check it is you.', retry: 'fix' },
  '91': { text: 'The card\'s bank is not answering.', retry: 'later' },
  '92': { text: 'The card could not be checked just now.', retry: 'later' },
  '93': { text: 'The card was declined by the bank.', retry: 'other_card' },
  '94': { text: 'This looks like a repeat of a payment already made.', retry: 'never' },
  N7: { text: 'The security code (CVV) did not match.', retry: 'fix' },
  R0: { text: 'Payments on this card have been stopped.', retry: 'never' },
  R1: { text: 'Payments on this card have been stopped.', retry: 'never' },
  R3: { text: 'Payments on this card have been stopped.', retry: 'never' },
};

const REASONS = {
  INSUFFICIENT_FUND: { text: 'There are not enough funds on this card.', retry: 'lower' },
  CUSTOMER_AUTHENTICATION_REQUIRED: { text: 'The bank needs to check it is you.', retry: 'fix' },
  INVALID_ACCOUNT: { text: 'The card number was not recognised.', retry: 'fix' },
  EXPIRED_CARD: { text: 'This card has expired.', retry: 'other_card' },
  CV_FAILED: { text: 'The security code (CVV) did not match.', retry: 'fix' },
  AVS_FAILED: { text: 'The billing address did not match the card.', retry: 'fix' },
  STOLEN_LOST_CARD: { text: 'The card was declined by the bank.', retry: 'never' },
  ISSUER_UNAVAILABLE: { text: 'The card\'s bank is not answering.', retry: 'later' },
  DUPLICATE_REQUEST: { text: 'This looks like a repeat of a payment already made.', retry: 'never' },
  INVALID_DATA: { text: 'The payment details were not accepted.', retry: 'fix' },
  MISSING_FIELD: { text: 'The payment details were incomplete.', retry: 'fix' },
  PAYMENT_REFUSED: { text: 'The card was declined by the bank.', retry: 'other_card' },
};

const ADVICE = {
  other_card: 'Please try another card.',
  later: 'Please try again in a few minutes, or use another card.',
  lower: 'Please try another card.',
  fix: 'Please check the details and try again.',
  never: 'Please use another card.',
};

/**
 * One payment answer, read: approved, a soft decline (authorised but not
 * captured, to be reversed), or declined with a sentence for the customer.
 */
function outcomeOf(p) {
  const pi = (p && p.processorInformation) || {};
  const code = pi.responseCode != null ? String(pi.responseCode) : null;
  const reason = (p && p.errorInformation && p.errorInformation.reason) || (p && p.reason) || null;
  const cvn = (pi.cardVerification && pi.cardVerification.resultCode) || null;
  const avs = (pi.avs && pi.avs.code) || null;
  const status = (p && p.status) || 'UNKNOWN';
  const base = { status, code, reason, cvn, avs, approvalCode: pi.approvalCode || null, id: (p && p.id) || null };
  // Our own rule as well as the bank's: a security code that did not match
  // is never taken, even when the account lets it through (the sandbox
  // authorises M05 CVN 004). The caller voids it at once (undo()).
  if (approved(p) && cvn === 'N') {
    return { ...base, approved: false, soft: true, message: `${RESPONSE_CODES.N7.text} ${ADVICE.fix}`, retry: 'fix' };
  }
  if (approved(p)) return { ...base, approved: true, soft: false, message: 'Paid', retry: null };
  let known = (code && RESPONSE_CODES[code]) || (reason && REASONS[reason]) || null;
  if (status === 'AUTHORIZED_PENDING_REVIEW') {
    // The bank authorised it, but the security code or address did not
    // match, so it was not taken; the hold is released by a reversal.
    known = cvn === 'N' ? RESPONSE_CODES.N7 : avs === 'N' ? REASONS.AVS_FAILED : { text: 'The bank asked for this payment to be checked.', retry: 'other_card' };
    return { ...base, approved: false, soft: true, message: `${known.text} ${ADVICE[known.retry]}`, retry: known.retry };
  }
  if (status === 'INVALID_REQUEST' && !known) known = REASONS.INVALID_DATA;
  if (!known) known = { text: 'The card was declined.', retry: 'other_card' };
  return { ...base, approved: false, soft: false, message: `${known.text} ${ADVICE[known.retry]}`, retry: known.retry };
}

/**
 * A payment the card form took itself (3-D Secure and capture, Unified
 * Checkout complete()), checked with Barclaycard: the form's answer is only
 * a pointer, the transaction record is the proof. Waits a little for the
 * record to appear. Answers the outcome with the amount and reference
 * Barclaycard holds, or null while it is not found.
 */
async function completedPayment(creds, completeJwt, { tries = 8, gapMs = 2000 } = {}) {
  const id = transactionIdIn(completeJwt);
  if (!id) return null;
  for (let i = 0; i < tries; i++) {
    try {
      const t = await transaction(creds, id);
      return { id, ...detailsOutcome(t) };
    } catch (e) {
      if (!(e instanceof BarclaycardError) || e.status !== 404) throw e;
    }
    await new Promise((r) => setTimeout(r, gapMs));
  }
  return { id, pending: true };
}

/** The transaction id inside the form's answer (a JWT, or the JSON it carries). */
function transactionIdIn(answer) {
  let payload = answer;
  if (typeof answer === 'string' && /^\d{16,26}$/.test(answer.trim())) return answer.trim();
  if (typeof answer === 'string') {
    const parts = answer.split('.');
    try {
      payload = JSON.parse(Buffer.from(parts.length === 3 ? parts[1] : answer, parts.length === 3 ? 'base64url' : 'utf8').toString('utf8'));
    } catch (_) {
      return /^\d{16,26}$/.test(answer) ? answer : null;
    }
  }
  const seen = [];
  const walk = (o, depth) => {
    if (!o || typeof o !== 'object' || depth > 4) return;
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === 'string' && /^(id|transactionId|paymentId)$/i.test(k) && /^\d{16,26}$/.test(v)) seen.push(v);
      else if (typeof v === 'object') walk(v, depth + 1);
    }
  };
  walk(payload, 0);
  return seen[0] || null;
}

const CARD_TYPES = { '001': 'VISA', '002': 'MASTERCARD', '003': 'AMEX', '005': 'DINERS', '007': 'JCB', '024': 'MAESTRO', '042': 'MAESTRO' };

/** A transaction record (/tss/v2/transactions) read as an outcome. */
function detailsOutcome(t) {
  const apps = (t.applicationInformation && t.applicationInformation.applications) || [];
  const app = (name) => apps.find((a) => a.name === name);
  const auth = app('ics_auth');
  const bill = app('ics_bill');
  const ok = (a) => a && String(a.rCode) === '1';
  const pi = t.processorInformation || {};
  const card = (t.paymentInformation && t.paymentInformation.card) || {};
  const amount = Math.round(Number((t.orderInformation && t.orderInformation.amountDetails && t.orderInformation.amountDetails.totalAmount) || 0) * 100);
  const reference = (t.clientReferenceInformation && t.clientReferenceInformation.code) || null;
  const code = pi.responseCode != null ? String(pi.responseCode) : null;
  const known = (code && RESPONSE_CODES[code]) || { text: 'The card was declined.', retry: 'other_card' };
  const paid = ok(auth) && ok(bill);
  return {
    approved: paid,
    soft: ok(auth) && !bill,
    amountMinor: amount,
    reference,
    code,
    approvalCode: pi.approvalCode || null,
    cardLast4: card.suffix ? String(card.suffix).slice(-4) : null,
    cardBrand: CARD_TYPES[card.type] || card.type || null,
    message: paid ? 'Paid' : `${known.text} ${ADVICE[known.retry]}`,
  };
}

function billToFor(b = {}) {
  const name = String(b.name || '').trim().split(/\s+/).filter(Boolean);
  return {
    firstName: (b.firstName || name[0] || 'Guest').slice(0, 60),
    lastName: (b.lastName || name.slice(1).join(' ') || 'Customer').slice(0, 60),
    email: (b.email && /@/.test(b.email) ? b.email : 'orders@vesopa.com').slice(0, 255),
    address1: (b.address1 || 'Online order').slice(0, 60),
    locality: (b.locality || 'Online').slice(0, 50),
    postalCode: b.postalCode ? String(b.postalCode).slice(0, 10) : undefined,
    country: (b.country || 'GB').slice(0, 2),
  };
}

/** Refund a captured payment, in full or in part. */
function refund(creds, paymentId, { reference, amountMinor, currency = 'GBP' }) {
  return call(creds, 'POST', `/pts/v2/payments/${encodeURIComponent(paymentId)}/refunds`, {
    clientReferenceInformation: { code: String(reference).slice(0, 50) },
    orderInformation: { amountDetails: { totalAmount: (amountMinor / 100).toFixed(2), currency } },
  });
}

/** Void a payment the same day, before it settles. */
function voidPayment(creds, paymentId, { reference }) {
  return call(creds, 'POST', `/pts/v2/payments/${encodeURIComponent(paymentId)}/voids`, {
    clientReferenceInformation: { code: String(reference).slice(0, 50) },
  });
}

/** One transaction's details. */
function transaction(creds, id) {
  return call(creds, 'GET', `/tss/v2/transactions/${encodeURIComponent(id)}`);
}

/** Whether a payment answer is a success. */
const approved = (p) => !!p && (p.status === 'AUTHORIZED' || p.status === 'PENDING' || p.status === 'TRANSMITTED');

module.exports = {
  HOSTS,
  BarclaycardError,
  cleanEnv,
  signedHeaders,
  call,
  captureContext,
  pay,
  refund,
  voidPayment,
  reverse,
  undo,
  transaction,
  approved,
  outcomeOf,
  completedPayment,
  transactionIdIn,
  detailsOutcome,
  RESPONSE_CODES,
};
