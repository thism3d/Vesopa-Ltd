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
const jwt = require('jsonwebtoken');
const tillSeats = require('./till_seats');
const { resolveTillSite, sitePickToken, readSitePickToken } = require('./sites');

/** Trimmed text of at most [max] characters, or null when there is none. */
function clampText(value, max) {
  const s = value == null ? '' : String(value).trim();
  return s ? s.slice(0, max) : null;
}

const ISSUER = (process.env.VESOPA_AUTH_ISSUER || 'https://auth.vesopa.com').replace(/\/+$/, '');
const TILL_CLIENT_ID = process.env.VESOPA_AUTH_TILL_CLIENT_ID || '';
const ENABLED =
  String(process.env.VESOPA_AUTH_TILL_ENABLED || '').toLowerCase() === 'on' && Boolean(TILL_CLIENT_ID);

// See the note on /api/terminal/vesopa/enabled. Ignored unless sign-in is live.
const TILL_ONLY = ENABLED
  && String(process.env.VESOPA_AUTH_TILL_ONLY || '').toLowerCase() === 'on';

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

  /*
   * VESOPA AND NOTHING ELSE, when the venue is ready for it.
   *
   * The owner's instruction for the whole platform: one way in, with the
   * Vesopa mark on it. `only` tells the till to stop drawing the email and
   * password fields beside the button.
   *
   * IT IS A FLAG AND NOT A DELETION, which is the same rule the back office
   * follows. The password endpoint, its hashes and the till's own form all
   * still exist; rolling back is turning this off and restarting, which is a
   * thing somebody can do at seven on a Friday with a room full of covers.
   * Deleting the code would make the rollback a deploy.
   *
   * It cannot turn itself on by accident: with Vesopa sign-in not live, `only`
   * would leave a terminal with no way to be commissioned at all, so it is
   * ignored.
   */
  router.get('/api/terminal/vesopa/enabled', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({
      enabled: ENABLED,
      only: TILL_ONLY,
      issuer: ISSUER,
      clientId: ENABLED ? TILL_CLIENT_ID : null,
    });
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

      // Which site this till is for. A login that manages more than one site
      // is asked -- by a till that says it can ask (1.7.3.0). The Vesopa token
      // above is spent, so the till comes back with the site and a short pass
      // instead (`/commission/site`). See src/sites.js.
      const placed = await resolveTillSite(pool, user, {
        canAsk: (req.body || {}).site_choice === true,
        officeId: (req.body || {}).office_id,
      });
      if (placed.error) return res.status(403).json({ error: placed.error });
      if (placed.choose) {
        return res.json({
          choose_site: true,
          sites: placed.choose,
          pick_token: sitePickToken(user.id, secret),
        });
      }

      return finishCommission(placed.user, req.body || {}, res);
    } catch (error) {
      return next(error);
    }
  });

  /**
   * A till's credentials, for somebody already proved and placed at a site:
   * a licence seat first (the venue's limit is checked here, and a machine
   * signing in again keeps the seat it already had -- see src/till_seats.js),
   * then the session and terminal tokens.
   */
  async function finishCommission(user, body, res) {
    let seatId;
    try {
      seatId = await tillSeats.claimSeat(pool, {
        office: user.officeEmail,
        deviceId: clampText(body.device_id, 64),
        deviceName: clampText(body.device_name, 120),
        by: user.email,
      });
    } catch (e) {
      if (e instanceof tillSeats.SeatLimitError) {
        return res.status(409).json({
          error: e.message,
          licences: e.limit,
          seats: e.seats.map((s) => ({ name: s.device_name, last_seen_at: s.last_seen_at })),
        });
      }
      throw e;
    }
    return res.json({
      token: issueToken(user, secret),
      terminalToken: issueTerminalToken(user, secret, undefined, seatId),
      user,
    });
  }

  /**
   * The second half of signing a till in for a login with more than one site:
   * the site the manager chose, and the five-minute pass from the first half.
   */
  router.post('/api/terminal/vesopa/commission/site', express.json(), async (req, res, next) => {
    try {
      const body = req.body || {};
      let userId;
      try {
        userId = readSitePickToken(body.pick_token, secret);
      } catch {
        return res.status(401).json({ error: 'That took too long. Sign the till in again.' });
      }
      const [[row]] = await pool.query(
        `SELECT u.id, u.email, u.name, u.role, u.approved, u.office_id,
                o.name AS office_name, o.contact_email AS office_email
           FROM backoffice_users u LEFT JOIN offices o ON o.id = u.office_id
          WHERE u.id = ?`,
        [userId]
      );
      if (!row || row.approved !== 'Y') {
        return res.status(403).json({ error: 'That account can no longer set up a till.' });
      }
      const user = {
        id: row.id,
        email: row.email,
        name: row.name,
        role: row.role || 'office',
        officeId: row.office_id,
        officeName: row.office_name,
        officeEmail: row.office_email,
      };
      const placed = await resolveTillSite(pool, user, {
        canAsk: true,
        officeId: body.office_id,
      });
      if (placed.error) return res.status(403).json({ error: placed.error });
      if (placed.choose) return res.status(400).json({ error: 'Which site is this till for?' });
      return finishCommission(placed.user, body, res);
    } catch (error) {
      return next(error);
    }
  });

  /*
   * The same door, for a kitchen screen.
   *
   * WHAT A KITCHEN SIGN-IN IS, AND WHY THIS DOES NOT REPLACE IT WHOLESALE
   *
   * A kitchen screen's own credential -- the venue, a username and a password
   * created in the back office under Kitchen screens -- belongs to the WALL and
   * not to a person. That is deliberate and it is worth keeping: a screen can
   * be turned off without turning a person off, and nobody's identity is left
   * signed in on a display the whole kitchen can see for ninety days.
   *
   * What the venue asked for is one way in across the software, and this is
   * that: a manager signs the screen in once with their Vesopa account and the
   * server issues the screen's token. The typed credential comes off the
   * screen; it is still what the token names, and still what the back office
   * manages.
   *
   * A screen commissioned this way is marked `via: vesopa` on its token. That
   * matters in one place: `PUT /kitchen/profile/branding` asks for the screen
   * password before it will rebrand a display, and a screen with no typed
   * password cannot answer. Those screens are rebranded from the back office
   * instead, which is where every other venue-wide setting already lives.
   */
  /**
   * A kitchen screen's own token, for a screen commissioned with Vesopa.
   *
   * The same shape `/api/kitchen/login` issues, so nothing downstream can tell
   * which door a screen came through — `scope`, `office`, `user` and `name` are
   * what every kitchen route reads.
   *
   * `user` is the person's address rather than a kitchen login's username,
   * because that is the truth about who set this screen up, and `via` records
   * how. See the note above for the one route that reads `via`.
   */
  function issueKitchenToken(office, claims, secret) {
    if (!office) return null;
    return jwt.sign(
      {
        scope: 'kitchen',
        office,
        user: String(claims.email).toLowerCase(),
        name: claims.name || claims.email,
        via: 'vesopa',
      },
      secret,
      // Ninety days, matching the typed door. A wall screen signed in every
      // week is a wall screen somebody props open.
      { expiresIn: '90d' }
    );
  }

  router.post('/api/kitchen/vesopa/commission', express.json(), async (req, res, next) => {
    try {
      let claims;
      try {
        claims = await verifyTillToken((req.body || {}).id_token);
      } catch (error) {
        console.warn('[kitchen_vesopa] refused a token:', error.message);
        return res.status(401).json({ error: 'That sign-in could not be accepted.' });
      }

      if (!claims.email || claims.email_verified !== true) {
        return res.status(403).json({
          error: 'Your Vesopa account has no confirmed email address.',
        });
      }

      // The same matching, linking and access rules as every other door.
      const user = await linkAndFind(pool, claims);
      if (!user) {
        return res.status(403).json({
          error: 'There is no back-office user for that address. Ask your manager to add you.',
        });
      }
      if (user.blocked) return res.status(403).json({ error: user.blocked });
      if (!user.officeEmail) {
        return res.status(403).json({
          error: 'Your account is not attached to a venue, so it cannot set up a kitchen screen.',
        });
      }

      const token = issueKitchenToken(user.officeEmail, claims, secret);
      if (!token) {
        return res.status(500).json({ error: 'That screen could not be set up.' });
      }
      return res.json({ token, office: user.officeEmail });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

module.exports = { terminalVesopaRoutes, ENABLED, ISSUER, TILL_CLIENT_ID, verifyTillToken };
