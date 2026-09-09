/**
 * Commissioning a till with a Vesopa account — Phase 6, migration four.
 *
 * THE TILL IS A PUBLIC CLIENT AND HOLDS NO SECRET. It ships to venues, runs on
 * a machine in a bar, and anything inside it can be read by whoever has the
 * machine. So it does the authorisation-code flow itself, with PKCE and a
 * loopback redirect, and never sees the back office's client secret.
 *
 * What it then does is hand the ID TOKEN it received to this endpoint, which
 * verifies it and issues the back office's own long-lived terminal token. That
 * is the only new thing here: everything downstream — the terminal token, the
 * staff PINs that unlock it, the office scoping — is exactly as it was.
 *
 * WHY A TILL IS DIFFERENT FROM EVERY OTHER CLIENT, and why the terminal token
 * still lasts ten years: a terminal is commissioned once and then runs for
 * months without anybody signing into it. The thing it needs the token FOR is
 * unlocking itself when a member of staff types a PIN, and a till that silently
 * stopped being able to do that after twelve hours would be a till that cannot
 * sell, discovered mid-service on a Saturday.
 *
 * THE THREE THINGS THAT STOP A CAPTURED ID TOKEN BEING REUSED HERE
 *
 *   1. The AUDIENCE must be the till application, not the back office. A token
 *      minted for any other Vesopa application is refused, so the browser
 *      session somebody has in the back office cannot be turned into a till.
 *   2. It must be FRESH. These live ten minutes; anything older is refused
 *      regardless of its signature.
 *   3. It is SINGLE USE. The `jti` is remembered until it expires, so the same
 *      token cannot commission a second terminal — which is what an attacker
 *      who read one out of a log would try.
 */

const crypto = require('crypto');
const express = require('express');

const { linkAndFind } = require('./backoffice_auth');

const ISSUER = (process.env.VESOPA_AUTH_ISSUER || 'https://auth.vesopa.com').replace(/\/+$/, '');
const TILL_CLIENT_ID = process.env.VESOPA_AUTH_TILL_CLIENT_ID || '';
const ENABLED =
  String(process.env.VESOPA_AUTH_TILL_ENABLED || '').toLowerCase() === 'on' && Boolean(TILL_CLIENT_ID);

const MAX_TOKEN_AGE_SECONDS = 600;

let jwksCache = { at: 0, keys: null };
const JWKS_TTL_MS = 60 * 60 * 1000;

/*
 * Tokens already spent, until they expire anyway.
 *
 * In memory rather than a table: entries live at most ten minutes, and a
 * restart losing them costs nothing an attacker could use — a token from before
 * the restart has expired on its own by the time anybody could try it.
 */
const spent = new Map();

function rememberSpent(jti, expSeconds) {
  spent.set(jti, expSeconds * 1000);
  const now = Date.now();
  for (const [key, until] of spent) {
    if (until < now) spent.delete(key);
  }
}

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
    // Stale beats nothing: a key set from an hour ago verifies today's tokens,
    // and a till being commissioned on a bad line should not fail for that.
    if (jwksCache.keys) return jwksCache.keys;
    throw error;
  }
}

/**
 * Verify an ID token minted for the TILL.
 *
 * The algorithm is taken from the key, never from the token's own header —
 * trusting the header is the `alg: none` hole, where an attacker declares the
 * token unsigned and every check after it passes.
 */
async function verifyTillToken(idToken) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw new Error('that is not a token');

  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));

  const find = async (force) => (await jwks({ force })).find((key) => key.kid === header.kid);
  let jwk = await find(false);
  if (!jwk) jwk = await find(true);
  if (!jwk) throw new Error('signed with a key we do not know');
  if (jwk.kty !== 'RSA') throw new Error('unexpected key type');

  const ok = crypto.verify(
    'RSA-SHA256',
    Buffer.from(`${parts[0]}.${parts[1]}`, 'utf8'),
    crypto.createPublicKey({ key: jwk, format: 'jwk' }),
    Buffer.from(parts[2], 'base64url'),
  );
  if (!ok) throw new Error('the signature does not check out');

  const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  const now = Math.floor(Date.now() / 1000);

  if (claims.iss !== ISSUER) throw new Error('the token came from somewhere else');

  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audience.includes(TILL_CLIENT_ID)) {
    throw new Error('that token was not minted for the till');
  }

  if (typeof claims.exp !== 'number' || claims.exp + 30 < now) throw new Error('the token has expired');
  if (typeof claims.iat === 'number' && now - claims.iat > MAX_TOKEN_AGE_SECONDS) {
    throw new Error('the token is too old to commission a terminal');
  }

  if (!claims.jti) throw new Error('the token has no id, so it cannot be spent once');
  if (spent.has(claims.jti)) throw new Error('that token has already been used');
  rememberSpent(claims.jti, claims.exp);

  return claims;
}

/**
 * @param issueToken          the back office's own session-token function
 * @param issueTerminalToken  and its terminal-token function
 *
 * Both are passed in and used verbatim, so a till commissioned this way is
 * indistinguishable downstream from one commissioned with a password.
 */
function terminalVesopaRoutes({ pool, secret, issueToken, issueTerminalToken }) {
  const router = express.Router();

  router.get('/api/terminal/vesopa/enabled', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ enabled: ENABLED, issuer: ISSUER, clientId: ENABLED ? TILL_CLIENT_ID : null });
  });

  if (!ENABLED) {
    router.use('/api/terminal/vesopa', (req, res) => res.status(404).end());
    return router;
  }

  router.post('/api/terminal/vesopa/commission', express.json(), async (req, res, next) => {
    try {
      let claims;
      try {
        claims = await verifyTillToken((req.body || {}).id_token);
      } catch (error) {
        // Deliberately vague to the caller, specific in the log. A till being
        // set up in a bar does not need to know which check failed, and an
        // attacker probing certainly does not.
        console.warn('[terminal_vesopa] refused a token:', error.message);
        return res.status(401).json({ error: 'That sign-in could not be accepted.' });
      }

      if (!claims.email || claims.email_verified !== true) {
        return res.status(403).json({
          error: 'Your Vesopa account has no confirmed email address.',
        });
      }

      /*
       * The SAME matching, linking and access rules the browser door uses —
       * the function itself, not a second copy of it. Approval, the office
       * status, and the platform admin's exemption from the office check all
       * come from there.
       */
      const user = await linkAndFind(pool, claims);

      if (!user) {
        return res.status(403).json({
          error: 'There is no back-office user for that address. Ask your manager to add you.',
        });
      }
      if (user.blocked) {
        return res.status(403).json({ error: user.blocked });
      }

      /*
       * A till sells from an office's catalogue, so a user with no office has
       * nothing to commission a terminal FOR. The password door has the same
       * rule — it only attaches a terminal token `if (terminal && officeEmail)`
       * — but there it is silent, and here that would present as a till which
       * signed in successfully and then could not check a single PIN.
       */
      if (!user.officeEmail) {
        return res.status(403).json({
          error: 'Your account is not attached to a venue, so it cannot set up a till.',
        });
      }

      return res.json({
        token: issueToken(user, secret),
        terminalToken: issueTerminalToken(user, secret),
        user,
      });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

module.exports = { terminalVesopaRoutes, ENABLED, ISSUER, TILL_CLIENT_ID, verifyTillToken };
