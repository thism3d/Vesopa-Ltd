/**
 * Continue with Vesopa, server side: swap a code for an id token, and check an
 * id token against Vesopa Auth's published keys.
 *
 * Shared by the loyalty app's member sign-in (loyalty_account.js) and the
 * loyalty website's administrator sign-in (loyalty_site.js). Both use the
 * public `vesopa-loyalty` client with PKCE, so no secret is needed -- one is
 * sent if VESOPA_LOYALTY_CLIENT_SECRET is set.
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');

function issuer() {
  return String(process.env.VESOPA_AUTH_ISSUER || '').replace(/\/$/, '');
}

function clientId() {
  return String(process.env.VESOPA_LOYALTY_CLIENT_ID || '');
}

/** Swap an authorization code for an id token, server to server. Null on any failure. */
async function exchangeCode({ code, verifier, redirectUri }) {
  if (!issuer() || !clientId() || !code || !verifier || !redirectUri) return null;
  try {
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: clientId(),
      redirect_uri: redirectUri,
    });
    const secret = process.env.VESOPA_LOYALTY_CLIENT_SECRET;
    if (secret) form.set('client_secret', secret);
    const res = await fetch(`${issuer()}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) {
      console.warn('[vesopa_idtoken] token exchange refused:', res.status, (await res.text()).slice(0, 200));
      return null;
    }
    const data = await res.json();
    return data && data.id_token ? String(data.id_token) : null;
  } catch (e) {
    console.warn('[vesopa_idtoken] token exchange failed:', e.message);
    return null;
  }
}

/*
 * The signing keys, cached, with the stale set kept as a fallback.
 *
 * THE PATH IS /jwks.json, NOT /.well-known/jwks.json. Guessing the
 * conventional path is what broke this once: the fetch 404'd, the verifier
 * answered null, and every Continue with Vesopa was refused with a message
 * that blamed the sign-in. The discovery document publishes `jwks_uri` and
 * that is the authority -- the known path is only the fallback.
 */
let jwksCache = { at: 0, keys: null };
const JWKS_TTL_MS = 60 * 60 * 1000;

async function signingKeys() {
  if (jwksCache.keys && Date.now() - jwksCache.at < JWKS_TTL_MS) return jwksCache.keys;
  try {
    let uri = `${issuer()}/jwks.json`;
    try {
      const disco = await fetch(`${issuer()}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(8000) });
      if (disco.ok) {
        const doc = await disco.json();
        if (doc && typeof doc.jwks_uri === 'string') uri = doc.jwks_uri;
      }
    } catch {
      // Discovery is a convenience. The known path still works.
    }
    const res = await fetch(uri, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`jwks ${res.status}`);
    const body = await res.json();
    if (!body || !Array.isArray(body.keys) || !body.keys.length) throw new Error('jwks was empty');
    jwksCache = { at: Date.now(), keys: body.keys };
    return body.keys;
  } catch (e) {
    // Stale beats nothing: an hour-old key set verifies today's tokens.
    if (jwksCache.keys) return jwksCache.keys;
    throw e;
  }
}

/**
 * Check an id token. THE ALGORITHM COMES FROM THE KEY, never from the token's
 * own header -- trusting the header is the `alg: none` hole. The header only
 * says WHICH key.
 */
async function verify(idToken) {
  if (!issuer() || !clientId() || !idToken) return null;
  try {
    const header = JSON.parse(Buffer.from(String(idToken).split('.')[0], 'base64url').toString());
    const keys = await signingKeys();
    const jwk = keys.find((k) => k.kid === header.kid) || (keys.length === 1 ? keys[0] : null);
    if (!jwk) return null;
    const algorithms = [jwk.alg || (jwk.kty === 'EC' ? 'ES256' : 'RS256')];
    const pem = crypto.createPublicKey({ key: jwk, format: 'jwk' }).export({ type: 'spki', format: 'pem' });
    return jwt.verify(idToken, pem, { algorithms, issuer: issuer(), audience: clientId() });
  } catch (e) {
    console.warn('[vesopa_idtoken] token refused:', e.message);
    return null;
  }
}

module.exports = { issuer, clientId, exchangeCode, verify };
