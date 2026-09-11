/**
 * Dojo's REST API, from the server.
 *
 * The till talks to Dojo itself, from a machine behind the bar, with a key the
 * venue pasted into its Settings. A kiosk cannot: it stands in the room where
 * the customers are, and anything on it can be read by whoever unscrews the
 * back. So for Vesopa Express the server holds the key and makes every call,
 * and the kiosk only ever asks the server how its payment is going.
 *
 * The protocol is the one the till already proved against the sandbox -- see
 * vesopa_epos/lib/payments/payment_provider.dart for the long version of each
 * of these notes:
 *
 *   * `Authorization: Basic <secret key>` -- the raw key, not base64, and not
 *     Bearer (Bearer is a 401).
 *   * a `version` header on every call; 2024-02-05 is the first that serves
 *     the terminal endpoints.
 *   * the terminal endpoints also need `software-house-id` AND `reseller-id`;
 *     with either missing Dojo answers 401, which looks like a bad key.
 *   * intent bodies are PascalCase (`Amount.Value`), and
 *   * Dojo IGNORES Idempotency-Key, so a second POST of the same intent is a
 *     second charge. The caller keeps the intent id and reuses it.
 */

const BASE = (process.env.DOJO_BASE_URL || 'https://api.dojo.tech').replace(/\/+$/, '');
const VERSION = process.env.DOJO_API_VERSION || '2024-02-05';

/** Dojo's own published sandbox partner ids, used when a sandbox key is. */
const SANDBOX_SOFTWARE_HOUSE = 'softwareHouse1';
const SANDBOX_RESELLER = 'reseller1';

class DojoError extends Error {
  constructor(status, message, body) {
    super(message);
    this.name = 'DojoError';
    this.status = status;
    this.body = body;
  }
}

function isSandboxKey(key) {
  return String(key || '').startsWith('sk_sandbox_');
}

/** The partner ids for a key: the configured ones, or the sandbox's own. */
function partnerIds(key) {
  const sandbox = isSandboxKey(key);
  return {
    softwareHouseId:
      process.env.DOJO_SOFTWARE_HOUSE_ID || (sandbox ? SANDBOX_SOFTWARE_HOUSE : ''),
    resellerId: process.env.DOJO_RESELLER_ID || (sandbox ? SANDBOX_RESELLER : ''),
  };
}

/**
 * One call. Throws a DojoError carrying Dojo's own message where there is one,
 * with the key scrubbed out of it -- an error body that quotes the credential
 * back must not reach a log or a kiosk screen.
 */
async function call(key, method, path, { body, terminal = false, fetchImpl } = {}) {
  if (!key) throw new DojoError(0, 'No Dojo key is configured for this venue.');
  const headers = {
    Authorization: 'Basic ' + key,
    version: VERSION,
    Accept: 'application/json',
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (terminal) {
    const ids = partnerIds(key);
    if (!ids.softwareHouseId || !ids.resellerId) {
      throw new DojoError(
        0,
        'The card machine needs DOJO_SOFTWARE_HOUSE_ID and DOJO_RESELLER_ID on the server.'
      );
    }
    headers['software-house-id'] = ids.softwareHouseId;
    headers['reseller-id'] = ids.resellerId;
  }

  const doFetch = fetchImpl || fetch;
  let response;
  try {
    response = await doFetch(BASE + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
  } catch (error) {
    throw new DojoError(0, 'Dojo could not be reached: ' + error.message);
  }

  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }

  if (!response.ok) {
    const said =
      (json && (json.title || json.detail || json.message || json.error)) ||
      text.slice(0, 200) ||
      response.statusText;
    throw new DojoError(
      response.status,
      String(said).split(key).join('<key>'),
      json
    );
  }
  return json;
}

/**
 * Create the payment intent. Returns Dojo's intent -- `id` is what everything
 * after this is keyed on.
 *
 * `itemLines` puts the basket on the card machine's screen and the customer's
 * Dojo receipt.
 */
function createIntent(key, { amountMinor, reference, description, itemLines = [] }, opts) {
  return call(key, 'POST', '/payment-intents', {
    ...opts,
    body: {
      Amount: { Value: amountMinor, CurrencyCode: 'GBP' },
      Reference: String(reference || 'vesopa-express').slice(0, 40),
      Description: description ? String(description).slice(0, 80) : undefined,
      CaptureMode: 'Auto',
      ...(itemLines.length ? { itemLines } : {}),
    },
  });
}

function getIntent(key, intentId, opts) {
  return call(key, 'GET', '/payment-intents/' + encodeURIComponent(intentId), opts);
}

/** Send the intent to a card machine. Returns the session; `id` tracks it. */
function startSession(key, { terminalId, intentId }, opts) {
  return call(key, 'POST', '/terminal-sessions', {
    ...opts,
    terminal: true,
    body: {
      terminalId,
      details: { sessionType: 'Sale', sale: { paymentIntentId: intentId } },
    },
  });
}

function getSession(key, sessionId, opts) {
  return call(key, 'GET', '/terminal-sessions/' + encodeURIComponent(sessionId), {
    ...opts,
    terminal: true,
  });
}

/** Only honoured before a card is presented; a refusal is not an error. */
async function cancelSession(key, sessionId, opts) {
  try {
    await call(key, 'PUT', '/terminal-sessions/' + encodeURIComponent(sessionId) + '/cancel', {
      ...opts,
      terminal: true,
    });
    return true;
  } catch {
    return false;
  }
}

function answerSignature(key, sessionId, accepted, opts) {
  return call(key, 'PUT', '/terminal-sessions/' + encodeURIComponent(sessionId) + '/signature', {
    ...opts,
    terminal: true,
    body: { accepted: !!accepted },
  });
}

function listTerminals(key, opts) {
  return call(key, 'GET', '/terminals?statuses=Available', { ...opts, terminal: true });
}

/**
 * What a session's state means for a kiosk that nobody is standing behind.
 *
 *   paid       Captured. Only Captured: a signature sale passes through
 *              Authorized BEFORE the signature is checked, so treating
 *              Authorized as paid books money a rejected signature declines.
 *   signature  the machine wants the signature accepted; an unattended kiosk
 *              accepts it, as the till does by default.
 *   failed     Declined or Canceled -- verdicts; no money moved.
 *   uncertain  Expired -- the machine stopped answering, and the card may have
 *              gone through. Never shown as a decline; the intent is asked.
 *   waiting    anything else.
 */
function sessionState(session) {
  const status = String((session && session.status) || '').toLowerCase();
  if (status === 'captured') return 'paid';
  if (status === 'signatureverificationrequired') return 'signature';
  if (status === 'declined' || status === 'canceled' || status === 'cancelled') return 'failed';
  if (status === 'expired') return 'uncertain';
  return 'waiting';
}

/** The machine's most recent prompt -- PresentCard, EnterPin, RemoveCard... */
function lastPrompt(session) {
  const events = (session && session.notificationEvents) || [];
  const last = events.length ? events[events.length - 1] : null;
  return last ? last.notificationType || null : null;
}

/** Whether an intent has the money. */
function intentPaid(intent) {
  const status = String((intent && intent.status) || '').toLowerCase();
  return status === 'captured' || status === 'succeeded';
}

module.exports = {
  DojoError,
  isSandboxKey,
  partnerIds,
  createIntent,
  getIntent,
  startSession,
  getSession,
  cancelSession,
  answerSignature,
  listTerminals,
  sessionState,
  lastPrompt,
  intentPaid,
};
