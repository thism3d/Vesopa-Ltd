/**
 * Talking to a camera on its own web interface.
 *
 * Hikvision and Dahua both want HTTP DIGEST authentication on their APIs, and
 * Node's fetch does not do digest. This does the one round it needs: ask, read
 * the challenge, answer it. Basic is used only where a camera offers nothing
 * else.
 */

const crypto = require('crypto');

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

function parseChallenge(header) {
  const out = {};
  const re = /(\w+)=("([^"]*)"|[^,\s]*)/g;
  let m;
  while ((m = re.exec(header))) out[m[1]] = m[3] !== undefined ? m[3] : m[2];
  return out;
}

function digestHeader({ method, uri, user, pass, challenge, nc = 1 }) {
  const c = parseChallenge(challenge);
  const realm = c.realm || '';
  const nonce = c.nonce || '';
  const qop = (c.qop || '').split(',').map((s) => s.trim()).includes('auth') ? 'auth' : '';
  const cnonce = crypto.randomBytes(8).toString('hex');
  const ncHex = String(nc).padStart(8, '0');
  const ha1 = md5(`${user}:${realm}:${pass}`);
  const ha2 = md5(`${method}:${uri}`);
  const response = qop ? md5(`${ha1}:${nonce}:${ncHex}:${cnonce}:${qop}:${ha2}`) : md5(`${ha1}:${nonce}:${ha2}`);
  const parts = [
    `username="${user}"`, `realm="${realm}"`, `nonce="${nonce}"`, `uri="${uri}"`,
    `response="${response}"`, 'algorithm=MD5',
  ];
  if (c.opaque) parts.push(`opaque="${c.opaque}"`);
  if (qop) parts.push(`qop=${qop}`, `nc=${ncHex}`, `cnonce="${cnonce}"`);
  return `Digest ${parts.join(', ')}`;
}

/**
 * A request to a camera. `base` is the gate's device_url (http://10.0.0.5).
 * Answers { status, text }; throws only when the camera cannot be reached.
 */
async function request({ base, path, method = 'GET', user = '', pass = '', body, contentType, timeoutMs = 8000 }) {
  const url = new URL(path, base.endsWith('/') ? base : `${base}/`);
  const headers = {};
  if (contentType) headers['Content-Type'] = contentType;
  const go = (auth) => fetch(url, {
    method,
    headers: auth ? { ...headers, Authorization: auth } : headers,
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  let res = await go(null);
  if (res.status === 401 && user) {
    const challenge = res.headers.get('www-authenticate') || '';
    await res.text().catch(() => {});
    const uri = url.pathname + url.search;
    const auth = /^digest/i.test(challenge)
      ? digestHeader({ method, uri, user, pass, challenge })
      : `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
    res = await go(auth);
  }
  return { status: res.status, text: await res.text() };
}

module.exports = { request, digestHeader, parseChallenge };
