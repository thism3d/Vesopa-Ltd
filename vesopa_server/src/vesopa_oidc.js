/**
 * A small OpenID Connect client for auth.vesopa.com, shared by the products in
 * this repository.
 *
 * WHY THIS EXISTS SEPARATELY FROM `dinein_auth.js`. The menu was migrated first
 * and carries its own copy of this machinery. It is live and working, and
 * rewriting a working migration to remove duplication is the kind of tidying
 * that breaks a thing nobody asked to have broken. So the second and third
 * migrations use this, and `dinein_auth.js` should be moved onto it the next
 * time somebody has a reason to open it.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 *   It does not touch a database. Every product has its own users table with
 *   its own shape, and the identity provider must never write to one — that is
 *   rule 1 of the migration plan. This hands back verified claims; what a
 *   product does with them is the product's business.
 *
 *   It does not create a session. The back office issues its own JWT and the
 *   panel its own cookie, and both should keep doing exactly that, so that
 *   turning this off is a flag rather than a rewrite.
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const DEFAULT_ISSUER = 'https://auth.vesopa.com';
const STATE_TTL_MS = 10 * 60 * 1000;
const JWKS_TTL_MS = 60 * 60 * 1000;

/**
 * One client, for one application.
 *
 * `label` appears in log lines only, so that two clients in the same process
 * are tellable apart when something goes wrong at two in the morning.
 */
function createClient({
  label,
  issuer = process.env.VESOPA_AUTH_ISSUER || DEFAULT_ISSUER,
  clientId,
  clientSecret,
  redirectUri,
  scope = 'openid profile email',
}) {
  const ISSUER = String(issuer).replace(/\/+$/, '');

  /*
   * Enabled means the flag AND the credentials.
   *
   * A half-configured integration that offers a button and then fails is worse
   * than no button: somebody picks the option that looks most official and is
   * told it went wrong, which teaches them the whole product is unreliable.
   */
  const enabled = Boolean(clientId && clientSecret && redirectUri);

  // In-memory, single-use, swept. A restart loses any sign-in that is mid-flight
  // — ten minutes of them at most — which is the right trade against putting a
  // table in every product's database for a value that lives for one round trip.
  const states = new Map();
  let jwksCache = { at: 0, keys: null };

  function sweep() {
    const now = Date.now();
    for (const [key, value] of states) {
      if (now - value.at > STATE_TTL_MS) states.delete(key);
    }
  }

  /**
   * The key set, cached, and kept when the refresh fails.
   *
   * `stale-if-error` on purpose. One box holds every Vesopa login; the
   * mitigation for that is every client holding on to what it already knows. A
   * key set fetched an hour ago verifies today's tokens perfectly well, and
   * refusing everybody because the key server hiccuped would turn a blip into
   * an outage.
   */
  async function jwks({ force = false } = {}) {
    if (!force && jwksCache.keys && Date.now() - jwksCache.at < JWKS_TTL_MS) {
      return jwksCache.keys;
    }
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

  /**
   * Begin a sign-in. Returns the URL to send the person to.
   *
   * PKCE even though this is a confidential client with a secret. It costs two
   * fields and closes authorisation-code interception, and the identity
   * provider requires it of every client regardless.
   */
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

  /**
   * Finish it. Returns the verified claims, or throws.
   *
   * The state is CLAIMED, not merely read: two callbacks with the same state —
   * a double-clicked link, or a replay — must not both proceed.
   */
  async function complete(query) {
    const state = String(query.state || '');
    const held = states.get(state);
    if (!held) throw new Error('that sign-in has expired or was already used');
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
   * Verify an ID token properly.
   *
   * Every one of these has been the hole in somebody's integration:
   *
   *   the SIGNATURE, against the published key with that `kid` — a token whose
   *     signature nobody checks is a token anybody can write
   *   the ISSUER, so a token from some other server is not accepted here
   *   the AUDIENCE, so a token minted for a DIFFERENT Vesopa application cannot
   *     be replayed at this one
   *   the NONCE we sent, tying the token to this sign-in and not one captured
   *     earlier
   *   the EXPIRY, which jsonwebtoken does — but only if we let it
   */
  async function verifyIdToken(idToken, nonce) {
    if (!idToken) throw new Error('no id token came back');

    const header = JSON.parse(
      Buffer.from(String(idToken).split('.')[0] || '', 'base64url').toString('utf8'),
    );

    const findKey = async (force) => (await jwks({ force })).find((key) => key.kid === header.kid);

    /*
     * A `kid` we do not know is the ordinary appearance of a key rotation, not
     * an attack — so the set is refetched once before giving up. Without this,
     * every rotation is an outage for every client with a warm cache.
     */
    let key = await findKey(false);
    if (!key) key = await findKey(true);
    if (!key) throw new Error('the token was signed with a key we do not know');

    const publicKey = crypto.createPublicKey({ key, format: 'jwk' });
    const claims = jwt.verify(idToken, publicKey, {
      algorithms: ['RS256'],
      issuer: ISSUER,
      audience: clientId,
    });

    if (!nonce || claims.nonce !== nonce) {
      throw new Error('the token does not answer the sign-in we started');
    }
    return claims;
  }

  return { enabled, issuer: ISSUER, clientId, redirectUri, begin, complete, verifyIdToken, jwks };
}

module.exports = { createClient, DEFAULT_ISSUER };
