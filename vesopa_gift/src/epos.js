/**
 * The EPOS, from here: everything Vesopa Gift asks the back office.
 *
 * Its other end is vesopa_server/src/gift_integration.js, which explains why
 * the surface is so small. On the live box this is a loopback call to the
 * back office beside us, carrying GIFT_SERVICE_KEY.
 *
 * Every call has a timeout and says what went wrong in words a person can act
 * on. Nothing here retries on its own: the callers that must not do a thing
 * twice (issue a card, refund) are idempotent at the other end, and it is the
 * caller that knows whether trying again is safe.
 */

const config = require('./config');

class EposError extends Error {
  constructor(status, message, body) {
    super(message);
    this.name = 'EposError';
    this.status = status;
    this.body = body;
  }
}

async function call(method, path, body, { timeout = 20000 } = {}) {
  if (!config.GIFT_SERVICE_KEY) throw new EposError(0, 'This server is not connected to the EPOS.');
  let res;
  try {
    res = await fetch(`${config.EPOS_API}/api/integrations/gift${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${config.GIFT_SERVICE_KEY}`,
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
  } catch (e) {
    throw new EposError(0, `The EPOS could not be reached (${e.name === 'TimeoutError' ? 'timed out' : e.message})`);
  }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  if (!res.ok) {
    throw new EposError(res.status, (json && json.error) || `The EPOS answered ${res.status}`, json);
  }
  return json;
}

const enc = encodeURIComponent;

module.exports = {
  EposError,
  venues: () => call('GET', '/venues').then((r) => r.venues),
  venue: (officeId) => call('GET', `/venues/${enc(officeId)}`),
  issueCard: (officeId, card) => call('POST', `/venues/${enc(officeId)}/cards`, card),
  card: (officeId, cardId) => call('GET', `/venues/${enc(officeId)}/cards/${enc(cardId)}`),
  lookup: (officeId, code) => call('GET', `/venues/${enc(officeId)}/lookup?code=${enc(code)}`),
  patchCard: (officeId, cardId, patch) => call('PATCH', `/venues/${enc(officeId)}/cards/${enc(cardId)}`, patch),
  voidCard: (officeId, cardId, reason) => call('POST', `/venues/${enc(officeId)}/cards/${enc(cardId)}/void`, { reason }),
  summary: (officeId, weeks = 8) => call('GET', `/venues/${enc(officeId)}/summary?weeks=${enc(weeks)}`),
  startPayment: (officeId, p) => call('POST', `/venues/${enc(officeId)}/payments`, p, { timeout: 35000 }),
  payment: (officeId, intentId) => call('GET', `/venues/${enc(officeId)}/payments/${enc(intentId)}`, undefined, { timeout: 35000 }),
  refund: (officeId, intentId, r) => call('POST', `/venues/${enc(officeId)}/payments/${enc(intentId)}/refund`, r, { timeout: 35000 }),
  cancelPayment: (officeId, intentId) => call('POST', `/venues/${enc(officeId)}/payments/${enc(intentId)}/cancel`, {}),
};
