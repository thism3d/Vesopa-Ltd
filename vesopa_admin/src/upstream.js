/**
 * Calling the apps admin.vesopa.com runs: the back office, Gift, Cloud.
 *
 * Each app has an admin API that admits only its service key, and the person
 * acting rides along in X-Vesopa-Admin so the app can record them. On the
 * live box every call is a loopback to an app beside this one.
 *
 * node:http, NOT fetch(): the back office listens on 5060, and fetch refuses
 * a list of "bad ports" that includes 5060 (SIP) -- Vesopa Gift found that
 * out on the live box (vesopa_gift/src/epos.js).
 */
const http = require('http');
const https = require('https');
const config = require('./config');

class UpstreamError extends Error {
  constructor(app, status, message, body) {
    super(message);
    this.name = 'UpstreamError';
    this.app = app;
    this.status = status;
    this.body = body;
  }
}

const NAMES = { epos: 'the back office', gift: 'Vesopa Gift', hosting: 'Vesopa Cloud' };

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

function connected(app) {
  const a = config.APPS[app];
  return !!(a && a.base && a.key && a.key.length >= 32);
}

/** One call to one app. `as` is the signed-in admin's email. */
async function call(app, method, path, { body, as, timeout = 15000 } = {}) {
  const a = config.APPS[app];
  if (!connected(app)) throw new UpstreamError(app, 0, `admin.vesopa.com is not connected to ${NAMES[app] || app} yet.`);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const headers = {
    Authorization: `Bearer ${a.key}`,
    Accept: 'application/json',
    ...(as ? { 'X-Vesopa-Admin': String(as).slice(0, 150) } : {}),
    ...(payload !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
  };
  let res;
  try {
    res = await request(method, `${a.base}${path}`, headers, payload, timeout);
  } catch (e) {
    throw new UpstreamError(app, 0, `${NAMES[app] || app} did not answer (${e.code || e.message}).`);
  }
  let json = null;
  try { json = res.text ? JSON.parse(res.text) : null; } catch { /* not JSON */ }
  if (res.status >= 400) {
    const said = json && json.error ? json.error : `answered ${res.status}`;
    throw new UpstreamError(app, res.status, `${NAMES[app] || app}: ${said}`, json);
  }
  return json;
}

module.exports = { call, connected, UpstreamError, NAMES };
