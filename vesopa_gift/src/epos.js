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
 *
 * NOT fetch(). The back office listens on 5060, and fetch follows the browser
 * rule that refuses a list of "bad ports" -- 5060 is SIP's -- so every call
 * failed on the live box with "fetch failed: bad port", while the tests, on
 * random ports, all passed. node:http has no such list.
 */

const http = require('http');
const https = require('https');
const config = require('./config');

class EposError extends Error {
  constructor(status, message, body) {
    super(message);
    this.name = 'EposError';
    this.status = status;
    this.body = body;
  }
}

/** One request, the whole answer as text. Rejects only when nothing came back. */
function request(method, url, headers, payload, timeout) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = (u.protocol === 'https:' ? https : http).request(u, { method, headers, timeout }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

async function call(method, path, body, { timeout = 20000 } = {}) {
  if (!config.GIFT_SERVICE_KEY) throw new EposError(0, 'This server is not connected to the EPOS.');
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const headers = {
    Authorization: `Bearer ${config.GIFT_SERVICE_KEY}`,
    Accept: 'application/json',
    ...(payload !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
  };
  let res;
  try {
    res = await request(method, `${config.EPOS_API}/api/integrations/gift${path}`, headers, payload, timeout);
  } catch (e) {
    throw new EposError(0, `The EPOS could not be reached (${e.code === 'ETIMEDOUT' ? 'timed out' : (e.code || e.message)})`);
  }
  let json = null;
  try { json = res.text ? JSON.parse(res.text) : null; } catch { json = null; }
  if (res.status < 200 || res.status >= 300) {
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
