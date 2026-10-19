/**
 * Teya, the second card acquirer beside Dojo (2026-10-19).
 *
 * Two Teya products, two sets of credentials:
 *
 *   POSLink (card machines). One partner app for every venue -- the Device
 *   Code app on partner.teya.xyz. A venue's manager approves Vesopa once by
 *   scanning a QR code and signing in with their Teya account; that gives a
 *   user token (refresh token lasts 15 years). With it we list the venue's
 *   stores and card machines and register the ePOS for one store, which
 *   returns machine-to-machine credentials for that store. Payments, their
 *   live status and refunds use those.
 *
 *   Online Payments (the menu's hosted checkout). The venue connects on
 *   business.teya.xyz/ecom/plugin-registration, and Teya posts that store's own
 *   client id, secret and payment-webhook key to our registration webhook.
 *
 * Environments: 'sandbox' (teya.xyz, the default for every venue) and 'live'
 * (teya.com). Live needs Vesopa's production partner credentials, which Teya
 * issues after certification (TEYA_LIVE_* in the back office .env); until
 * then live is offered but not available, and says why.
 *
 * Every call has a timeout; every failure is a TeyaError with Teya's own code
 * and a sentence a manager can read.
 */
'use strict';

const crypto = require('crypto');

const HOSTS = {
  sandbox: {
    id: 'https://id.teya.xyz',
    api: 'https://api.teya.xyz',
    business: 'https://business.teya.xyz',
    publicKey: 'https://cdn.teya.xyz/dynamic/4eb143f2/public-key',
  },
  live: {
    id: 'https://id.teya.com',
    api: 'https://api.teya.com',
    business: 'https://business.teya.com',
    publicKey: 'https://cdn.teya.com/dynamic/4eb143f2/public-key',
  },
};

const ENVS = new Set(['sandbox', 'live']);
const cleanEnv = (env) => (ENVS.has(env) ? env : 'sandbox');
const hosts = (env) => HOSTS[cleanEnv(env)];

/** Vesopa's partner apps for an environment. */
function partner(env) {
  const live = cleanEnv(env) === 'live';
  const pick = (name) => String(process.env[(live ? 'TEYA_LIVE_' : 'TEYA_') + name] || '').trim();
  return {
    deviceId: pick('DEVICE_CLIENT_ID'),
    deviceSecret: pick('DEVICE_CLIENT_SECRET'),
    webId: pick('WEB_CLIENT_ID'),
    webSecret: pick('WEB_CLIENT_SECRET'),
    // TESTING in development; Teya assigns Vesopa its own value for production.
    pluginType: pick('PLUGIN_TYPE') || (live ? '' : 'TESTING'),
  };
}

/** Whether an environment can be used at all on this server. */
function available(env) {
  const p = partner(env);
  return !!(p.deviceId && p.deviceSecret);
}

class TeyaError extends Error {
  constructor(status, code, message, body) {
    super(message);
    this.name = 'TeyaError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

/** Teya's error codes, in words a manager can act on. */
const PLAIN = {
  UNAUTHORISED: 'Teya did not accept the connection. Connect Teya again.',
  UNAUTHORIZED: 'Teya did not accept the connection. Connect Teya again.',
  FORBIDDEN: 'This Teya account is not allowed to do that. Check the store and card machine.',
  NOT_FOUND: 'Teya could not find that. It may have been removed.',
  TRANSACTION_NOT_FOUND: 'Teya could not find the original card payment to refund.',
  TRANSACTION_ALREADY_IN_PROGRESS: 'The card machine is already taking another payment.',
  TERMINAL_UNREACHABLE: 'The card machine could not be reached. Check it is on and online.',
  SERVICE_UNAVAILABLE: 'Teya is not available just now. Please try again in a moment.',
  TRANSACTION_CANNOT_BE_REVERSED: 'Teya cannot refund this payment.',
  AMOUNT_TOO_SMALL: 'That amount is too small for Teya.',
  TRANSACTION_NOT_ALLOWED: 'Teya does not allow that payment.',
};

function plainError(status, body, fallback) {
  const code = (body && (body.code || body.error)) || '';
  const desc = body && (body.description || body.error_description || body.detail || body.message);
  if (PLAIN[code]) return { code, message: PLAIN[code] };
  if (status === 401) return { code: code || 'UNAUTHORISED', message: PLAIN.UNAUTHORISED };
  if (status === 429) return { code: code || 'TOO_MANY', message: 'Teya asked us to slow down. Please try again in a moment.' };
  if (status >= 500) return { code: code || 'TEYA_DOWN', message: PLAIN.SERVICE_UNAVAILABLE };
  return { code: code || 'TEYA_' + status, message: desc ? `Teya: ${String(desc).slice(0, 200)}` : fallback };
}

async function readJson(res) {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 300) };
  }
}

/** POST a form to Teya's identity server. */
async function form(env, path, params, { basic } = {}) {
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
  if (basic) headers.Authorization = 'Basic ' + Buffer.from(`${basic[0]}:${basic[1]}`).toString('base64');
  let res;
  try {
    res = await fetch(hosts(env).id + path, {
      method: 'POST',
      headers,
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    throw new TeyaError(0, 'TEYA_UNREACHABLE', 'Teya could not be reached. Check the internet connection and try again.');
  }
  const body = await readJson(res);
  if (!res.ok) {
    const e = plainError(res.status, body, 'Teya refused the sign-in.');
    throw new TeyaError(res.status, body.error || e.code, e.message, body);
  }
  return body;
}

/** Call a Teya API with a bearer token. */
async function api(env, method, path, token, { body, idempotencyKey, timeoutMs = 20000 } = {}) {
  const headers = {
    Authorization: 'Bearer ' + token,
    Accept: 'application/json',
    'User-Agent': 'Vesopa-EPOS/1.0',
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  let res;
  try {
    res = await fetch(hosts(env).api + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    throw new TeyaError(0, timeout ? 'TEYA_TIMEOUT' : 'TEYA_UNREACHABLE',
      timeout ? 'Teya did not answer in time. Please try again.' : 'Teya could not be reached. Check the internet connection and try again.');
  }
  const data = await readJson(res);
  if (!res.ok) {
    const e = plainError(res.status, data, 'Teya refused that request.');
    throw new TeyaError(res.status, e.code, e.message, data);
  }
  return data;
}

// ---- Signing a venue in (Device Code flow) --------------------------------

/** Start: a code and a QR for the manager to approve on their phone. */
async function startDevice(env) {
  const p = partner(env);
  if (!p.deviceId) throw new TeyaError(0, 'NOT_CONFIGURED', cleanEnv(env) === 'live'
    ? 'Teya Live is not set up on Vesopa yet. Teya issues live credentials once the integration is certified.'
    : 'Teya is not set up on this server.');
  return form(env, '/oauth/v2/device', { client_id: p.deviceId, client_secret: p.deviceSecret });
}

/** Has the manager approved yet? `{ pending: true }` while they have not. */
async function pollDevice(env, deviceCode) {
  const p = partner(env);
  try {
    return await form(env, '/oauth/v2/oauth-token', {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: deviceCode,
      client_id: p.deviceId,
      client_secret: p.deviceSecret,
    });
  } catch (e) {
    const code = e.body && e.body.error;
    if (code === 'authorization_pending' || code === 'slow_down') return { pending: true, slowDown: code === 'slow_down' };
    if (code === 'expired_token') throw new TeyaError(e.status, 'EXPIRED', 'The QR code has expired. Start again for a new one.');
    if (code === 'access_denied') throw new TeyaError(e.status, 'DENIED', 'The sign-in was declined on Teya.');
    throw e;
  }
}

/** A fresh user token. Refresh tokens are single use: store the new one. */
function refreshUser(env, refreshToken) {
  const p = partner(env);
  return form(env, '/oauth/v2/oauth-token', { grant_type: 'refresh_token', refresh_token: refreshToken }, { basic: [p.deviceId, p.deviceSecret] });
}

// ---- Machine tokens (the store's own credentials) --------------------------

const tokenCache = new Map();

/** A client-credentials token, cached until a minute before it expires. */
async function clientToken(env, clientId, clientSecret, scope) {
  const key = `${cleanEnv(env)}|${clientId}|${scope || ''}`;
  const hit = tokenCache.get(key);
  if (hit && hit.until > Date.now()) return hit.token;
  const params = { grant_type: 'client_credentials' };
  if (scope) params.scope = scope;
  const t = await form(env, '/oauth/v2/oauth-token', params, { basic: [clientId, clientSecret] });
  const ttl = Math.max(60, Number(t.expires_in) || 900);
  tokenCache.set(key, { token: t.access_token, until: Date.now() + (ttl - 60) * 1000 });
  return t.access_token;
}

function forgetToken(env, clientId) {
  for (const k of tokenCache.keys()) if (k.startsWith(`${cleanEnv(env)}|${clientId}|`)) tokenCache.delete(k);
}

// ---- Stores, card machines, registration -----------------------------------

async function listStores(env, token) {
  const r = await api(env, 'GET', '/poslink/v1/stores', token);
  return Array.isArray(r) ? r : (r.stores || r.data || []);
}

async function listTerminals(env, token, storeId) {
  const r = await api(env, 'GET', `/poslink/v1/stores/${encodeURIComponent(storeId)}/terminals`, token);
  return Array.isArray(r) ? r : (r.terminals || r.data || []);
}

/** Register this venue's Vesopa as the ePOS for a store: its own M2M credentials. */
function registerEpos(env, userToken, storeId, eposExternalId) {
  return api(env, 'POST', '/poslink/v1/epos/register', userToken, {
    body: { store_id: storeId, epos_external_id: String(eposExternalId).slice(0, 100) },
  });
}

// ---- Card machine payments --------------------------------------------------

/** Send a sale (or an unreferenced refund) to a card machine. */
function createPayment(env, token, { storeId, terminalId, amountMinor, tipMinor = 0, reference, eposInstanceId, type = 'SALE' }, idempotencyKey) {
  return api(env, 'POST', '/poslink/v3/payment-requests', token, {
    idempotencyKey,
    body: {
      store_id: storeId,
      terminal_id: terminalId,
      requested_amount: { amount: amountMinor, currency: 'GBP', tip: tipMinor },
      transaction_type: type,
      merchant_reference: String(reference).slice(0, 64),
      epos_instance_id: eposInstanceId ? String(eposInstanceId).slice(0, 64) : undefined,
    },
  });
}

const FINAL = new Set(['SUCCESSFUL', 'CANCELLED', 'FAILED']);

/**
 * Where a payment request is, following Teya's live status stream for up to
 * [waitMs]. Returns the latest state seen (merged across events), with
 * `final` set once Teya has given its outcome.
 */
async function followPayment(env, token, id, waitMs = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), waitMs);
  let state = { payment_request_id: id };
  try {
    let res;
    try {
      res = await fetch(`${hosts(env).api}/poslink/v3/payment-requests/${encodeURIComponent(id)}`, {
        headers: { Authorization: 'Bearer ' + token, Accept: 'text/event-stream', 'User-Agent': 'Vesopa-EPOS/1.0' },
        signal: ctrl.signal,
      });
    } catch (e) {
      if (e && e.name === 'AbortError') return { ...state, final: false };
      throw new TeyaError(0, 'TEYA_UNREACHABLE', 'Teya could not be reached. Check the internet connection.');
    }
    if (!res.ok) {
      const body = await readJson(res);
      const e = plainError(res.status, body, 'Teya could not say where the payment is.');
      throw new TeyaError(res.status, e.code, e.message, body);
    }
    // A plain JSON answer (no stream) is the state as it stands.
    if (!String(res.headers.get('content-type') || '').includes('event-stream')) {
      state = { ...state, ...(await readJson(res)) };
      return { ...state, final: FINAL.has(state.status) };
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch {
        break; // the wait ran out
      }
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
        if (!data) continue;
        try {
          state = { ...state, ...JSON.parse(data) };
        } catch {
          // a line this build cannot read
        }
        if (FINAL.has(state.status)) {
          ctrl.abort();
          return { ...state, final: true };
        }
      }
    }
  } finally {
    clearTimeout(timer);
  }
  return { ...state, final: FINAL.has(state.status) };
}

/** Ask the card machine to stop. A request, not a confirmation: keep following. */
function cancelPayment(env, token, id) {
  return api(env, 'PATCH', `/poslink/v2/payment-requests/${encodeURIComponent(id)}`, token, { body: { status: 'CANCELLING' } });
}

/** Refund a card machine payment by its gateway_payment_id. */
function refundCardPayment(env, token, { gatewayPaymentId, amountMinor, terminalId, reference }, idempotencyKey) {
  return api(env, 'POST', '/poslink/v2/refunds', token, {
    idempotencyKey,
    body: {
      transaction_id: gatewayPaymentId,
      amount: amountMinor,
      currency: 'GBP',
      terminal_id: terminalId || undefined,
      merchant_reference: reference ? String(reference).slice(0, 64) : undefined,
    },
  });
}

// ---- Online payments (hosted checkout) --------------------------------------

const ONLINE_SCOPE = 'checkout/sessions/create checkout/sessions/id/get refunds/create ecommerce/registrations/current';

/** Where to send a manager to connect their store's online payments. */
function registrationUrl(env, { registrationWebhook, paymentsWebhook, state, version }) {
  const p = partner(env);
  const q = new URLSearchParams({
    registrationWebhook,
    paymentsWebhook,
    pluginType: p.pluginType || 'TESTING',
    pluginVersion: version || '1.0.0',
    state,
  });
  return `${hosts(env).business}/ecom/plugin-registration?${q.toString()}`;
}

function createSession(env, token, { amountMinor, reference, storeId, successUrl, cancelUrl, failureUrl, lines }, idempotencyKey) {
  return api(env, 'POST', '/v2/checkout/sessions', token, {
    idempotencyKey,
    body: {
      type: 'SALE',
      amount: { value: amountMinor, currency: 'GBP' },
      merchant_reference: String(reference).slice(0, 60),
      store_id: storeId || undefined,
      success_url: successUrl,
      cancel_url: cancelUrl || successUrl,
      failure_url: failureUrl || successUrl,
      // Straight back to the order page, which reads the session: a redirect
      // is never taken as proof of payment.
      post_success_payment: 'REDIRECT',
      language: 'en-GB',
      line_items: Array.isArray(lines) && lines.length ? lines.slice(0, 100) : undefined,
    },
  });
}

function getSession(env, token, sessionId) {
  return api(env, 'GET', `/v2/checkout/sessions/${encodeURIComponent(sessionId)}`, token);
}

function refundOnline(env, token, { transactionId, amountMinor, reference }, idempotencyKey) {
  return api(env, 'POST', '/v3/refunds', token, {
    idempotencyKey,
    body: { transaction_id: transactionId, amount: amountMinor, merchant_reference: reference || undefined },
  });
}

function deactivateRegistration(env, token) {
  return api(env, 'DELETE', '/v1/ecommerce/registrations/current', token);
}

// ---- Signatures --------------------------------------------------------------

/** SHA256withRSA over the raw body, Base64 signature, as Teya signs webhooks. */
function verifySignature(rawBody, signatureB64, publicKeyPem) {
  try {
    if (!rawBody || !signatureB64 || !publicKeyPem) return false;
    return crypto.verify('sha256', Buffer.from(rawBody), publicKeyPem, Buffer.from(String(signatureB64), 'base64'));
  } catch {
    return false;
  }
}

const keyCache = new Map();

/** Teya's public key for registration webhooks, cached for an hour. */
async function registrationKey(env) {
  const hit = keyCache.get(cleanEnv(env));
  if (hit && hit.until > Date.now()) return hit.pem;
  const res = await fetch(hosts(env).publicKey, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new TeyaError(res.status, 'KEY_UNAVAILABLE', 'Teya\'s signing key could not be fetched.');
  let pem = (await res.text()).trim();
  if (!pem.includes('BEGIN')) pem = `-----BEGIN PUBLIC KEY-----\n${pem}\n-----END PUBLIC KEY-----`;
  keyCache.set(cleanEnv(env), { pem, until: Date.now() + 3600 * 1000 });
  return pem;
}

module.exports = {
  HOSTS,
  ENVS,
  cleanEnv,
  partner,
  available,
  TeyaError,
  startDevice,
  pollDevice,
  refreshUser,
  clientToken,
  forgetToken,
  listStores,
  listTerminals,
  registerEpos,
  createPayment,
  followPayment,
  cancelPayment,
  refundCardPayment,
  ONLINE_SCOPE,
  registrationUrl,
  createSession,
  getSession,
  refundOnline,
  deactivateRegistration,
  verifySignature,
  registrationKey,
  FINAL,
};
