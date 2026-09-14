/**
 * Continue with Vesopa, for the staff console.
 *
 * The same client the back office uses (vesopa_server/src/vesopa_oidc.js) --
 * PKCE, state claimed not read, nonce checked, signature, issuer and audience
 * verified -- plus one thing the back office does not need: the ROLES. The
 * state is also held in the browser that started (admin.js, vg_state), so a
 * callback only completes where its sign-in began.
 *
 * Auth puts a person's roles in the ACCESS token, not the ID token, so both are
 * verified: the ID token says who they are, the access token says what they may
 * do here, and the two must name the same person. An access token is checked
 * for its type as well, because accepting one where an ID token was expected
 * (or the other way round) is a confusion that has produced real holes.
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const STATE_TTL_MS = 10 * 60 * 1000;
const JWKS_TTL_MS = 60 * 60 * 1000;

function createClient({ issuer, clientId, clientSecret, redirectUri, scope = 'openid profile email roles' }) {
  const ISSUER = String(issuer).replace(/\/+$/, '');
  const enabled = Boolean(clientId && clientSecret && redirectUri);
  const states = new Map();
  let jwksCache = { at: 0, keys: null };

  function sweep() {
    const now = Date.now();
    for (const [key, value] of states) if (now - value.at > STATE_TTL_MS) states.delete(key);
  }

  async function jwks({ force = false } = {}) {
    if (!force && jwksCache.keys && Date.now() - jwksCache.at < JWKS_TTL_MS) return jwksCache.keys;
    try {
      const res = await fetch(`${ISSUER}/jwks.json`, { signal: AbortSignal.timeout(8000) });
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

  async function verify(token, { type, nonce }) {
    if (!token) throw new Error(`no ${type} came back`);
    const header = JSON.parse(Buffer.from(String(token).split('.')[0] || '', 'base64url').toString('utf8'));
    if (type === 'access token' && header.typ && String(header.typ).toLowerCase() !== 'at+jwt') {
      throw new Error('that is not an access token');
    }
    if (type === 'id token' && String(header.typ || '').toLowerCase() === 'at+jwt') {
      throw new Error('an access token was offered as an ID token');
    }
    const find = async (force) => (await jwks({ force })).find((k) => k.kid === header.kid);
    let key = await find(false);
    if (!key) key = await find(true);
    if (!key) throw new Error('the token was signed with a key we do not know');
    const claims = jwt.verify(token, crypto.createPublicKey({ key, format: 'jwk' }), {
      algorithms: ['RS256'],
      issuer: ISSUER,
      audience: clientId,
    });
    if (type === 'id token' && (!nonce || claims.nonce !== nonce)) {
      throw new Error('the token does not answer the sign-in we started');
    }
    return claims;
  }

  async function complete(query) {
    const state = String(query.state || '');
    const held = states.get(state);
    if (!held) throw new Error('that sign-in has expired or was already used');
    states.delete(state);
    if (query.error) throw new Error(`Vesopa said: ${query.error}`);
    if (!query.code) throw new Error('no code came back');

    const res = await fetch(`${ISSUER}/oauth/token`, {
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
    const tokens = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`token exchange failed: ${tokens.error_description || tokens.error || res.status}`);

    const identity = await verify(tokens.id_token, { type: 'id token', nonce: held.nonce });
    const access = await verify(tokens.access_token, { type: 'access token' });
    if (access.sub !== identity.sub) throw new Error('the two tokens name different people');

    return {
      sub: identity.sub,
      email: identity.email_verified ? String(identity.email || '').toLowerCase() : null,
      name: identity.name || identity.given_name || null,
      roles: Array.isArray(access.roles) ? access.roles.map(String) : [],
      returnTo: held.returnTo,
    };
  }

  return { enabled, begin, complete };
}

module.exports = { createClient };
