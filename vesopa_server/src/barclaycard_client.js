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
function captureContext(creds, { targetOrigins, amountMinor, currency = 'GBP', country = 'GB', locale = 'en_GB', clientVersion = '0.31' }) {
  return call(creds, 'POST', '/up/v1/capture-contexts', {
    targetOrigins,
    clientVersion,
    allowedCardNetworks: ['VISA', 'MASTERCARD', 'AMEX', 'MAESTRO'],
    allowedPaymentTypes: ['PANENTRY', 'APPLEPAY', 'GOOGLEPAY'],
    country,
    locale,
    captureMandate: { billingType: 'NONE', requestEmail: false, requestPhone: false, requestShipping: false, showAcceptedNetworkIcons: true },
    orderInformation: { amountDetails: { totalAmount: (amountMinor / 100).toFixed(2), currency } },
  });
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
  return call(creds, 'POST', '/pts/v2/payments', body);
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
  transaction,
  approved,
};
