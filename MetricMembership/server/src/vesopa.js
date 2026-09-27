/**
 * Continue with Vesopa, server side: swap a code for an id token, and check an
 * id token against Vesopa Auth's published keys.
 *
 * The same shape as the loyalty server's (vesopa_server/src/vesopa_idtoken.js),
 * copied rather than shared because the two ship separately. The member app
 * reaches this two ways, as the loyalty app does:
 *
 *   * the WEB app brings back a code and its PKCE verifier; this server does
 *     the exchange, so no token from Auth ever sits in browser storage
 *   * a NATIVE app (Windows, Android, iPhone) does its own exchange over a
 *     loopback port and sends the id token; this server checks it
 *
 * The staff console uses the same client, started and finished here.
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('./config');

async function exchangeCode({ code, verifier, redirectUri }) {
  if (!config.AUTH_CLIENT_ID || !code || !verifier || !redirectUri) return null;
  try {
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: config.AUTH_CLIENT_ID,
      redirect_uri: redirectUri,
    });
    if (config.AUTH_CLIENT_SECRET) form.set('client_secret', config.AUTH_CLIENT_SECRET);
    const res = await fetch(`${config.AUTH_ISSUER}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) {
      console.warn('[vesopa] token exchange refused:', res.status, (await res.text()).slice(0, 200));
      return null;
    }
    const data = await res.json();
    return data && data.id_token ? String(data.id_token) : null;
  } catch (e) {
    console.warn('[vesopa] token exchange failed:', e.message);
    return null;
  }
}

// Signing keys, cached for an hour; a stale set beats none. /jwks.json, as
// published in discovery -- not /.well-known/jwks.json (see the loyalty copy).
let jwksCache = { at: 0, keys: null };

async function signingKeys() {
  if (jwksCache.keys && Date.now() - jwksCache.at < 3600000) return jwksCache.keys;
  try {
    let uri = `${config.AUTH_ISSUER}/jwks.json`;
    try {
      const d = await fetch(`${config.AUTH_ISSUER}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(8000) });
      if (d.ok) {
        const doc = await d.json();
        if (doc && typeof doc.jwks_uri === 'string') uri = doc.jwks_uri;
      }
    } catch { /* the known path still works */ }
    const res = await fetch(uri, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`jwks ${res.status}`);
    const body = await res.json();
    if (!body || !Array.isArray(body.keys) || !body.keys.length) throw new Error('jwks was empty');
    jwksCache = { at: Date.now(), keys: body.keys };
    return body.keys;
  } catch (e) {
    if (jwksCache.keys) return jwksCache.keys;
    throw e;
  }
}

/** The algorithm comes from the KEY, never the token's own header. */
async function verify(idToken, { nonce } = {}) {
  if (!config.AUTH_CLIENT_ID || !idToken) return null;
  try {
    const header = JSON.parse(Buffer.from(String(idToken).split('.')[0], 'base64url').toString());
    if (String(header.typ || '').toLowerCase() === 'at+jwt') return null;
    const keys = await signingKeys();
    const jwk = keys.find((k) => k.kid === header.kid) || (keys.length === 1 ? keys[0] : null);
    if (!jwk) return null;
    const algorithms = [jwk.alg || (jwk.kty === 'EC' ? 'ES256' : 'RS256')];
    const pem = crypto.createPublicKey({ key: jwk, format: 'jwk' }).export({ type: 'spki', format: 'pem' });
    const claims = jwt.verify(idToken, pem, { algorithms, issuer: config.AUTH_ISSUER, audience: config.AUTH_CLIENT_ID });
    if (nonce && claims.nonce !== nonce) return null;
    return claims;
  } catch (e) {
    console.warn('[vesopa] token refused:', e.message);
    return null;
  }
}

/** A PKCE pair and state for a sign-in this server starts (the staff console). */
function begin(redirectUri, extra = {}) {
  const state = crypto.randomBytes(24).toString('base64url');
  const nonce = crypto.randomBytes(16).toString('base64url');
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const params = new URLSearchParams({
    client_id: config.AUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid profile email',
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ...extra,
  });
  return { url: `${config.AUTH_ISSUER}/oauth/authorize?${params}`, state, nonce, verifier };
}

// Tests swap the network out.
function _setKeys(keys) { jwksCache = { at: Date.now(), keys }; }

module.exports = { exchangeCode, verify, begin, _setKeys };
