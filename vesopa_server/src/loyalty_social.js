/**
 * Sign in with Apple and Google, straight from a venue's own app (2026-10-11).
 *
 * The app signs in on the device -- Apple's own sheet, Google's own sheet --
 * and arrives here holding the provider's id token. This checks it against
 * the provider's published keys and answers the confirmed email address.
 * Nothing is exchanged and no secret is needed: these are public clients and
 * the token's signature, issuer, audience and expiry are the whole proof.
 *
 * WHICH APPS MAY SIGN IN is the audience check: a token minted for somebody
 * else's app is refused even though Apple signed it.
 *
 *   LOYALTY_APPLE_AUDIENCES   bundle ids, comma separated (each venue app,
 *                             and the shared one)
 *   LOYALTY_GOOGLE_AUDIENCES  Google OAuth client ids (each app's iOS client,
 *                             and the Android/web client its tokens name)
 *
 * Both default to the apps that exist today, so a server whose .env says
 * nothing still takes them.
 */
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const PROVIDERS = {
  apple: {
    issuers: ['https://appleid.apple.com'],
    jwks: 'https://appleid.apple.com/auth/keys',
    audiences: () => list(process.env.LOYALTY_APPLE_AUDIENCES,
      'com.vesopaepos.pontardawerfc,com.vesopaepos.thevesopakitchen'),
  },
  google: {
    issuers: ['https://accounts.google.com', 'accounts.google.com'],
    jwks: 'https://www.googleapis.com/oauth2/v3/certs',
    audiences: () => list(process.env.LOYALTY_GOOGLE_AUDIENCES, ''),
  },
};

function list(value, fallback) {
  return String(value || fallback).split(',').map((s) => s.trim()).filter(Boolean);
}

const cache = new Map();
const TTL_MS = 60 * 60 * 1000;

async function keys(provider, { refresh = false } = {}) {
  const hit = cache.get(provider);
  if (!refresh && hit && Date.now() - hit.at < TTL_MS) return hit.keys;
  try {
    const res = await fetch(PROVIDERS[provider].jwks, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`jwks ${res.status}`);
    const body = await res.json();
    if (!body || !Array.isArray(body.keys) || !body.keys.length) throw new Error('jwks was empty');
    cache.set(provider, { at: Date.now(), keys: body.keys });
    return body.keys;
  } catch (e) {
    if (hit) return hit.keys;
    throw e;
  }
}

/**
 * The token's claims when it is genuine, else null. The algorithm comes from
 * the key, never from the token's header.
 */
async function verify(provider, token) {
  const p = PROVIDERS[provider];
  const audience = p ? p.audiences() : [];
  if (!p || !token || !audience.length) return null;
  try {
    const header = JSON.parse(Buffer.from(String(token).split('.')[0], 'base64url').toString());
    let set = await keys(provider);
    let jwk = set.find((k) => k.kid === header.kid);
    // Providers rotate keys; one we have not seen is a reason to look again.
    if (!jwk) {
      set = await keys(provider, { refresh: true });
      jwk = set.find((k) => k.kid === header.kid);
    }
    if (!jwk) return null;
    const pem = crypto.createPublicKey({ key: jwk, format: 'jwk' }).export({ type: 'spki', format: 'pem' });
    return jwt.verify(token, pem, {
      algorithms: [jwk.alg || 'RS256'],
      issuer: p.issuers,
      audience,
    });
  } catch (e) {
    console.warn(`[loyalty_social] ${provider} token refused:`, e.message);
    return null;
  }
}

/** Apple sends email_verified as "true" (a string) in older tokens. */
function verifiedEmail(claims) {
  const email = String((claims && claims.email) || '').trim().toLowerCase();
  const ok = claims && (claims.email_verified === true || claims.email_verified === 'true');
  return ok && email ? email : '';
}

module.exports = { verify, verifiedEmail, PROVIDERS };
