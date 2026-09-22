/**
 * A small OpenID Connect client for auth.vesopa.com.
 *
 * The same shape as the back office's `vesopa_oidc.js` — begin() hands back the
 * authorize URL, complete() exchanges the code and returns verified claims —
 * with one deliberate difference: the ID token is verified with Node's own
 * `crypto` rather than `jsonwebtoken`. This site does not otherwise depend on a
 * JWT library, and adding one to verify a single RS256 signature would make a
 * deploy of this feature an `npm install` on the live box as well as a copy.
 *
 * WHAT IT DOES NOT DO: touch a database, or create a session. It returns
 * verified claims; admin-auth.js decides what they mean and issues the same
 * cookie the password form issues.
 */

const crypto = require('crypto');

const DEFAULT_ISSUER = 'https://auth.vesopa.com';
const STATE_TTL_MS = 10 * 60 * 1000;
const JWKS_TTL_MS = 60 * 60 * 1000;
// Clocks drift. A minute either way, the same allowance jsonwebtoken defaults to
// being asked for, keeps a slightly-fast issuer from bouncing every sign-in.
const CLOCK_SKEW_S = 60;

function b64urlJson(part) {
  return JSON.parse(Buffer.from(String(part || ''), 'base64url').toString('utf8'));
}

function createClient({
  label = 'vesopa_oidc',
  issuer = process.env.VESOPA_AUTH_ISSUER || DEFAULT_ISSUER,
  clientId,
  clientSecret,
  redirectUri,
  scope = 'openid profile email',
  fetchImpl = (...args) => fetch(...args),
  now = () => Date.now(),
}) {
  const ISSUER = String(issuer).replace(/\/+$/, '');

  // Enabled means the credentials are all there. A button that leads to a
  // half-configured integration is worse than no button.
  const enabled = Boolean(clientId && clientSecret && redirectUri);

  // In memory, single use, swept. pm2 runs this site as one fork process (see
  // ecosystem.config.cjs), so one map covers every request. A restart loses at
  // most ten minutes of sign-ins that were mid-flight.
  const states = new Map();
  let jwksCache = { at: 0, keys: null };

  function sweep() {
    const cutoff = now() - STATE_TTL_MS;
    for (const [key, value] of states) if (value.at < cutoff) states.delete(key);
  }

  async function jwks({ force = false } = {}) {
    if (!force && jwksCache.keys && now() - jwksCache.at < JWKS_TTL_MS) return jwksCache.keys;
    const response = await fetchImpl(`${ISSUER}/jwks.json`, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`jwks answered ${response.status}`);
    const body = await response.json();
    const keys = Array.isArray(body.keys) ? body.keys : [];
    // An empty set is never cached: caching it would reject every token for an
    // hour after a transient hiccup on the issuer.
    if (keys.length) jwksCache = { at: now(), keys };
    return keys;
  }

  /** Start a sign-in. PKCE is required by the issuer of every client. */
  function begin({ returnTo = '' } = {}) {
    sweep();
    const state = crypto.randomBytes(32).toString('base64url');
    const nonce = crypto.randomBytes(24).toString('base64url');
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

    states.set(state, { at: now(), nonce, verifier, returnTo });

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

  /**
   * Finish a sign-in. Returns verified claims, or throws.
   * The state is claimed, not read, so a replayed callback cannot proceed twice.
   */
  async function complete(query) {
    const state = String(query.state || '');
    const held = states.get(state);
    if (!held) throw new Error('that sign-in has expired or was already used');
    states.delete(state);
    if (now() - held.at > STATE_TTL_MS) throw new Error('that sign-in has expired');

    if (query.error) throw new Error(`the identity provider said: ${query.error}`);
    if (!query.code) throw new Error('no authorisation code came back');

    const response = await fetchImpl(`${ISSUER}/oauth/token`, {
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
    return { claims, returnTo: held.returnTo };
  }

  /**
   * Verify an RS256 ID token: signature against the published key with that
   * `kid`, then issuer, audience, expiry and nonce. Every one of these has been
   * the hole in somebody's integration, so none is optional.
   */
  async function verifyIdToken(idToken, nonce) {
    if (!idToken) throw new Error('no id token came back');
    const parts = String(idToken).split('.');
    if (parts.length !== 3) throw new Error('the id token is malformed');

    const header = b64urlJson(parts[0]);
    // Pinned. Accepting whatever `alg` the token names is how `none` and
    // HS256-with-the-public-key attacks get in.
    if (header.alg !== 'RS256') throw new Error(`unexpected token algorithm ${header.alg}`);

    // An unknown kid is the ordinary look of a key rotation: refetch once.
    const findKey = async (force) => (await jwks({ force })).find((k) => k.kid === header.kid);
    let jwk = await findKey(false);
    if (!jwk) jwk = await findKey(true);
    if (!jwk) throw new Error('the token was signed with a key we do not know');

    const valid = crypto.verify(
      'RSA-SHA256',
      Buffer.from(`${parts[0]}.${parts[1]}`),
      crypto.createPublicKey({ key: jwk, format: 'jwk' }),
      Buffer.from(parts[2], 'base64url'),
    );
    if (!valid) throw new Error('the token signature does not verify');

    const claims = b64urlJson(parts[1]);
    const nowS = Math.floor(now() / 1000);

    if (claims.iss !== ISSUER) throw new Error('the token is from a different issuer');
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(clientId)) throw new Error('the token was issued to a different application');
    if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_S < nowS) throw new Error('the token has expired');
    if (typeof claims.nbf === 'number' && claims.nbf - CLOCK_SKEW_S > nowS) throw new Error('the token is not valid yet');
    if (!nonce || claims.nonce !== nonce) throw new Error('the token does not answer the sign-in we started');

    return claims;
  }

  return { label, enabled, issuer: ISSUER, clientId, redirectUri, begin, complete, verifyIdToken };
}

module.exports = { createClient, DEFAULT_ISSUER };
