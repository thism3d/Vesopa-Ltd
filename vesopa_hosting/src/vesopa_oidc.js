/**
 * An OpenID Connect client for auth.vesopa.com, with no dependencies.
 *
 * NO `jsonwebtoken`, DELIBERATELY. This application does not carry that package
 * and adding one to a live product to verify a signature that `node:crypto` can
 * verify in twenty lines is a poor trade — a dependency is something somebody
 * has to keep updated for as long as the product exists. Everything below uses
 * only what Node already has.
 *
 * The sibling copy in `vesopa_server/src/vesopa_oidc.js` does use it, because
 * that application already did. The two are otherwise the same client, and they
 * are separate files because the two applications deploy independently — a
 * shared module one directory up would simply not be there after a deploy.
 *
 * WHAT IT DOES NOT DO: touch a database, or create a session. The panel has its
 * own customers table and its own signed cookie, and both keep working exactly
 * as they do — which is what makes turning this off a flag rather than a
 * rewrite.
 */

const crypto = require('crypto');

const DEFAULT_ISSUER = 'https://auth.vesopa.com';
const STATE_TTL_MS = 10 * 60 * 1000;
const JWKS_TTL_MS = 60 * 60 * 1000;

function base64urlToBuffer(value) {
  return Buffer.from(String(value), 'base64url');
}

function createClient({
  label,
  issuer = process.env.VESOPA_AUTH_ISSUER || DEFAULT_ISSUER,
  clientId,
  clientSecret,
  redirectUri,
  scope = 'openid profile email',
}) {
  const ISSUER = String(issuer).replace(/\/+$/, '');
  const enabled = Boolean(clientId && clientSecret && redirectUri);

  const states = new Map();
  let jwksCache = { at: 0, keys: null };

  function sweep() {
    const now = Date.now();
    for (const [key, value] of states) {
      if (now - value.at > STATE_TTL_MS) states.delete(key);
    }
  }

  /**
   * The key set, cached, and KEPT when a refresh fails.
   *
   * One box holds every Vesopa login. The mitigation for that is every client
   * holding on to what it already knows: a key set fetched an hour ago verifies
   * today's tokens perfectly well, and refusing everybody because the key
   * server hiccuped turns a blip into an outage.
   */
  async function jwks({ force = false } = {}) {
    if (!force && jwksCache.keys && Date.now() - jwksCache.at < JWKS_TTL_MS) return jwksCache.keys;
    try {
      const response = await fetch(`${ISSUER}/jwks.json`, { signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error(`jwks ${response.status}`);
      const body = await response.json();
      if (!body || !Array.isArray(body.keys) || !body.keys.length) throw new Error('jwks was empty');
      jwksCache = { at: Date.now(), keys: body.keys };
      return body.keys;
    } catch (error) {
      if (jwksCache.keys) {
        console.warn(`[${label}] jwks refresh failed, using cached:`, error.message);
        return jwksCache.keys;
      }
      throw error;
    }
  }

  function begin({ returnTo = '' } = {}) {
    sweep();
    const state = crypto.randomBytes(32).toString('base64url');
    const nonce = crypto.randomBytes(24).toString('base64url');
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

    states.set(state, { at: Date.now(), nonce, verifier, returnTo });

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope,
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    return { url: `${ISSUER}/oauth/authorize?${params}`, state };
  }

  async function complete(query) {
    const state = String(query.state || '');
    const held = states.get(state);
    if (!held) throw new Error('that sign-in has expired or was already used');
    // Claimed, not merely read: two callbacks with the same state must not both
    // proceed.
    states.delete(state);

    if (query.error) throw new Error(`the identity provider said: ${query.error}`);
    if (!query.code) throw new Error('no authorisation code came back');

    const response = await fetch(`${ISSUER}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: String(query.code),
        redirect_uri: redirectUri,
        code_verifier: held.verifier,
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
      signal: AbortSignal.timeout(12000),
    });

    const tokens = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(`token exchange failed: ${tokens.error_description || tokens.error || response.status}`);
    }

    const claims = await verifyIdToken(tokens.id_token, held.nonce);
    return { claims, tokens, returnTo: held.returnTo };
  }

  /**
   * Verify an ID token with nothing but `node:crypto`.
   *
   * Every check here has been the hole in somebody's integration:
   *
   *   the SIGNATURE against the published key with that `kid` — a token whose
   *     signature nobody checks is a token anybody can write
   *   the ALGORITHM, pinned to RS256 from the KEY rather than read from the
   *     token's own header. Trusting the header is the classic `alg: none`
   *     hole, where an attacker simply declares the token unsigned.
   *   the ISSUER, the AUDIENCE, the EXPIRY, and the NONCE we sent
   */
  async function verifyIdToken(idToken, nonce) {
    if (!idToken) throw new Error('no id token came back');

    const parts = String(idToken).split('.');
    if (parts.length !== 3) throw new Error('that is not a JWT');

    const header = JSON.parse(base64urlToBuffer(parts[0]).toString('utf8'));

    const findKey = async (force) => (await jwks({ force })).find((key) => key.kid === header.kid);

    // A `kid` we do not know is the ordinary appearance of a key rotation, not
    // an attack, so the set is refetched once before giving up. Without this,
    // every rotation is an outage for every client with a warm cache.
    let jwk = await findKey(false);
    if (!jwk) jwk = await findKey(true);
    if (!jwk) throw new Error('the token was signed with a key we do not know');
    if (jwk.kty !== 'RSA') throw new Error(`unexpected key type ${jwk.kty}`);

    const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    const verified = crypto.verify(
      'RSA-SHA256',
      Buffer.from(`${parts[0]}.${parts[1]}`, 'utf8'),
      publicKey,
      base64urlToBuffer(parts[2]),
    );
    if (!verified) throw new Error('the signature does not check out');

    const claims = JSON.parse(base64urlToBuffer(parts[1]).toString('utf8'));
    const now = Math.floor(Date.now() / 1000);

    if (claims.iss !== ISSUER) throw new Error('the token came from somewhere else');

    // `aud` may be a string or an array; both are legal.
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audience.includes(clientId)) {
      throw new Error('the token was minted for a different application');
    }

    // Sixty seconds of slack for clocks that disagree, and no more.
    if (typeof claims.exp !== 'number' || claims.exp + 60 < now) throw new Error('the token has expired');
    if (typeof claims.nbf === 'number' && claims.nbf - 60 > now) throw new Error('the token is not valid yet');

    if (!nonce || claims.nonce !== nonce) {
      throw new Error('the token does not answer the sign-in we started');
    }

    return claims;
  }

  return { enabled, issuer: ISSUER, clientId, redirectUri, begin, complete, verifyIdToken, jwks };
}

module.exports = { createClient, DEFAULT_ISSUER };
