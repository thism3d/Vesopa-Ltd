/**
 * Signing in to a menu with a Vesopa account — Phase 6, the first migration.
 *
 * IT SHIPS DORMANT. Nothing here answers anything unless `VESOPA_AUTH_ENABLED`
 * is set in the environment. That is rule 2 of the migration plan and it is not
 * negotiable: rollback has to be flipping a flag and restarting, not a deploy
 * under pressure at seven on a Friday with a room full of covers.
 *
 * GUEST ORDERING IS UNTOUCHED, AND THAT IS THE WHOLE POINT.
 *
 * The person here is at a table with food coming. Guest is the default, it is
 * preselected, and every part of the menu works without an account. What this
 * adds is a third way to sign in beside the email code and the phone code —
 * never a gate in front of the menu, never a step before a basket can be sent.
 *
 * The quiet failure this file is written to avoid: an identity provider gets
 * added to a product like this and the sign-in becomes load-bearing by
 * accident. Somebody puts the check one layer too high, and a diner is asked to
 * register before they can read a menu. Nobody catches it in testing, because
 * everybody testing it has an account.
 *
 * ONE REDIRECT URI, HOWEVER MANY VENUE DOMAINS.
 *
 * A venue can point its own domain at this server — menu.theirpub.co.uk — and
 * print that on its cards. Redirect matching at the identity provider is exact
 * string equality with no wildcards, so registering every venue's domain would
 * be a support task for ever and one nobody would keep up with.
 *
 * So the round trip ALWAYS goes out from and comes back to the canonical menu
 * host, and where the person actually was is carried in the server-side state
 * and used to send them home afterwards. One registered URI, any number of
 * venue domains, and no wildcard anywhere.
 *
 * THE TOKEN IS NEVER PUT IN A URL. The callback stores the minted session
 * against a single-use handle and redirects with that instead. A URL is written
 * to the access log, kept in browser history, and handed to the next site as a
 * Referer — and the thing being passed here is a thirty-day session.
 */

const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const ISSUER = (process.env.VESOPA_AUTH_ISSUER || 'https://auth.vesopa.com').replace(/\/+$/, '');
const CLIENT_ID = process.env.VESOPA_AUTH_CLIENT_ID || '';
const CLIENT_SECRET = process.env.VESOPA_AUTH_CLIENT_SECRET || '';
const MENU_HOST = (process.env.MENU_HOST || 'menu.vesopaepos.com').trim().toLowerCase();
const REDIRECT_URI = `https://${MENU_HOST}/auth/callback`;

/*
 * The flag, and it is deliberately three things at once: the feature has to be
 * turned on AND the credentials have to be present. A half-configured
 * integration that offers a button and then fails is worse than no button —
 * somebody picks the option that looks most official and is told it went wrong,
 * which teaches them the whole menu is unreliable.
 */
const ENABLED =
  String(process.env.VESOPA_AUTH_ENABLED || '').toLowerCase() === 'on' &&
  !!CLIENT_ID &&
  !!CLIENT_SECRET;

// Matches the code-based sign-in, so a person's session is the same length
// however they proved who they are.
const SESSION_DAYS = 30;

const STATE_TTL_MS = 10 * 60 * 1000; // a round trip through a provider
const HANDOFF_TTL_MS = 2 * 60 * 1000; // page load, no more

// ---------------------------------------------------------------------------
// In-memory, and safe because this process is single
// ---------------------------------------------------------------------------
//
// `ecosystem.config.cjs` runs this app with `instances: 1, exec_mode: 'fork'`,
// so there is exactly one process and a Map is a Map. If that ever becomes a
// cluster, BOTH of these have to move into the database or a shared store —
// otherwise a callback landing on the wrong worker fails a sign-in with a
// message about state that makes no sense to anybody.
//
// Written here rather than discovered later.

const states = new Map();
const handoffs = new Map();

function sweep(map, ttl) {
  const now = Date.now();
  for (const [key, value] of map) {
    if (now - value.at > ttl) map.delete(key);
  }
}

// ---------------------------------------------------------------------------
// JWKS, cached
// ---------------------------------------------------------------------------
//
// Cached with `stale-if-error` semantics on purpose: if auth.vesopa.com is
// unreachable, a menu that already has the keys keeps verifying tokens rather
// than refusing everybody. One box holds every Vesopa login, and the mitigation
// for that is every client holding on to what it already knows.

let jwksCache = { at: 0, keys: null };
const JWKS_TTL_MS = 60 * 60 * 1000;

async function jwks({ force = false } = {}) {
  if (!force && jwksCache.keys && Date.now() - jwksCache.at < JWKS_TTL_MS) {
    return jwksCache.keys;
  }
  try {
    const response = await fetch(`${ISSUER}/jwks.json`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(`jwks ${response.status}`);
    const body = await response.json();
    if (!body || !Array.isArray(body.keys) || !body.keys.length) {
      throw new Error('jwks was empty');
    }
    jwksCache = { at: Date.now(), keys: body.keys };
    return body.keys;
  } catch (error) {
    // Stale beats nothing. A key set we fetched an hour ago verifies today's
    // tokens perfectly well.
    if (jwksCache.keys) {
      console.warn('[dinein_auth] jwks refresh failed, using cached:', error.message);
      return jwksCache.keys;
    }
    throw error;
  }
}

/**
 * Verify an ID token properly.
 *
 * Every one of these checks has been the hole in somebody's integration:
 *
 *   the SIGNATURE, against the published key with that `kid` — a token whose
 *     signature nobody checks is a token anybody can write
 *   the ISSUER, so a token minted by some other server is not accepted here
 *   the AUDIENCE, so a token minted for a DIFFERENT Vesopa application cannot
 *     be replayed at this one
 *   the NONCE we sent, which is what ties this token to this sign-in rather
 *     than to one captured earlier
 *   the EXPIRY, which `jsonwebtoken` does for us but only if we let it
 */
async function verifyIdToken(idToken, nonce) {
  const header = JSON.parse(
    Buffer.from(String(idToken).split('.')[0] || '', 'base64url').toString('utf8'),
  );

  const findKey = async (force) => {
    const keys = await jwks({ force });
    return keys.find((key) => key.kid === header.kid);
  };

  /*
   * A `kid` we do not know is the normal appearance of a key rotation, not an
   * attack — so the key set is refetched once before giving up. Without this,
   * every rotation is an outage for every client that happened to have a warm
   * cache.
   */
  let key = await findKey(false);
  if (!key) key = await findKey(true);
  if (!key) throw new Error('the token was signed with a key we do not know');

  const publicKey = crypto.createPublicKey({ key, format: 'jwk' });
  const claims = jwt.verify(idToken, publicKey, {
    algorithms: ['RS256'],
    issuer: ISSUER,
    audience: CLIENT_ID,
  });

  if (!nonce || claims.nonce !== nonce) {
    throw new Error('the token does not answer the sign-in we started');
  }
  return claims;
}

// ---------------------------------------------------------------------------
// The routes
// ---------------------------------------------------------------------------

function dineinAuthRoutes({ pool, secret }) {
  const router = express.Router();

  /*
   * With the flag off, this router is not mounted at all — see server.js. This
   * second guard is belt and braces for the case where it is mounted by
   * mistake: every route answers 404, which is what a feature that does not
   * exist should look like.
   */
  if (!ENABLED) {
    router.use('/auth/callback', (req, res) => res.status(404).end());
    router.use('/api/public/dinein/auth', (req, res) => res.status(404).end());
    return router;
  }

  /**
   * Which venue this sign-in is for.
   *
   * By slug when the person is on the shared menu host, and by hostname when
   * the venue has pointed a domain of its own at this server — because on
   * menu.theirpub.co.uk there is no slug in the URL at all, and a sign-in
   * button that only worked on our own domain would be broken for exactly the
   * venues that paid for a domain.
   *
   * `is_published` is checked in both directions. A venue that is not live has
   * no menu to come back to, and enrolling a diner against one would leave a
   * membership row for a venue that never opens.
   */
  async function venueOf(req) {
    const slug = String(req.query.venue || '').trim().slice(0, 120);
    if (slug) {
      const [[bySlug]] = await pool.query(
        'SELECT office_id, slug FROM dinein_venue WHERE slug = ? AND is_published = 1 LIMIT 1',
        [slug],
      );
      if (bySlug) return bySlug;
    }

    const host = hostOf(req);
    if (!host || host === MENU_HOST || host === `www.${MENU_HOST}`) return null;

    const names = host.startsWith('www.') ? [host, host.slice(4)] : [host, `www.${host}`];
    const [[byHost]] = await pool.query(
      'SELECT office_id, slug FROM dinein_venue' +
        ' WHERE custom_domain IN (?, ?) AND is_published = 1 LIMIT 1',
      names,
    );
    return byHost || null;
  }

  /**
   * Start. The button on the checkout sheet comes here.
   *
   * PKCE on a confidential client as well, because the identity provider
   * requires it of every client — and it is free protection against an
   * authorisation code intercepted anywhere between the browser and here.
   */
  router.get('/api/public/dinein/auth/start', async (req, res, next) => {
    try {
      const venue = await venueOf(req);
      if (!venue) return res.status(400).send('Unknown venue.');

      const verifier = crypto.randomBytes(32).toString('base64url');
      const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
      const state = crypto.randomBytes(24).toString('base64url');
      const nonce = crypto.randomBytes(16).toString('base64url');

      /*
       * Where to come back to. This is why the venue's own domain never has to
       * be registered at the identity provider — it is kept here, server-side,
       * and only ever used to build a path on a host we already trust.
       *
       * THE FALLBACK HAS TO BE THE VENUE'S MENU, NOT `/`.
       *
       * On the shared host, `/` is the "which venue?" page, and it does not
       * carry the menu's script — so a person returning there lands on a page
       * that cannot claim the session they just went and got. It looks like the
       * sign-in silently failed, and it did: the handle sat unused on the URL.
       * That is exactly what happened the first time this was driven end to
       * end. On a venue's own domain `/` IS the menu, so it is right there.
       */
      const fromReferer = safeReturn(req.headers.referer, req);
      const onSharedHost = hostOf(req) === MENU_HOST || hostOf(req) === `www.${MENU_HOST}`;
      const backTo =
        fromReferer && fromReferer !== '/'
          ? fromReferer
          : (onSharedHost && venue.slug ? `/${venue.slug}` : '/');

      sweep(states, STATE_TTL_MS);
      states.set(state, {
        at: Date.now(),
        verifier,
        nonce,
        officeId: venue.office_id,
        slug: venue.slug,
        backTo,
      });

      const url = new URL(`${ISSUER}/oauth/authorize`);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', CLIENT_ID);
      url.searchParams.set('redirect_uri', REDIRECT_URI);
      url.searchParams.set('state', state);
      url.searchParams.set('nonce', nonce);
      url.searchParams.set('code_challenge', challenge);
      url.searchParams.set('code_challenge_method', 'S256');
      /*
       * Exactly what the menu needs and nothing more. `orders.claim` is what
       * lets somebody who ordered as a guest on this phone keep those orders
       * when they sign in — without it, signing in loses the meal they are in
       * the middle of, which is the worst possible moment to ask anybody to
       * make an account.
       */
      url.searchParams.set(
        'scope',
        'openid profile email offline_access orders.read orders.write orders.claim',
      );

      return res.redirect(302, url.toString());
    } catch (error) {
      return next(error);
    }
  });

  /**
   * Come back.
   *
   * Always on the canonical menu host, whatever domain the person started on.
   */
  router.get('/auth/callback', async (req, res, next) => {
    try {
      sweep(states, STATE_TTL_MS);
      const held = states.get(String(req.query.state || ''));
      // Single use. A replayed state is either a double-click or somebody
      // trying it on, and neither should get a second session.
      if (held) states.delete(String(req.query.state || ''));

      if (!held || Date.now() - held.at > STATE_TTL_MS) {
        return res.status(400).send(page('That sign-in took too long. Please try again.', '/'));
      }

      /*
       * The person pressed Deny, or the provider refused. Not an error: they
       * are sent back to their table and can carry on as a guest, which is what
       * most people were going to do anyway.
       */
      if (req.query.error || !req.query.code) {
        return res.redirect(302, held.backTo || '/');
      }

      const tokenResponse = await fetch(`${ISSUER}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: String(req.query.code),
          redirect_uri: REDIRECT_URI,
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          code_verifier: held.verifier,
        }).toString(),
        signal: AbortSignal.timeout(10000),
      });

      if (!tokenResponse.ok) {
        /*
         * Logged WITHOUT the body. An OAuth error response can quote the
         * request back, and the request carried the client secret.
         */
        console.error('[dinein_auth] token exchange failed:', tokenResponse.status);
        return res.status(502).send(page('We could not finish signing you in.', held.backTo));
      }

      const issued = await tokenResponse.json();
      const claims = await verifyIdToken(issued.id_token, held.nonce);

      const diner = await findOrCreateFromVesopa(pool, held.officeId, claims);

      const handle = crypto.randomBytes(16).toString('base64url');
      sweep(handoffs, HANDOFF_TTL_MS);
      handoffs.set(handle, {
        at: Date.now(),
        payload: {
          ok: true,
          token: jwt.sign(
            { scope: 'diner', diner: diner.id, office: diner.office_id },
            secret,
            { expiresIn: `${SESSION_DAYS}d` },
          ),
          account: {
            email: diner.email,
            phone: diner.phone_e164,
            name: diner.name,
            has_password: !!diner.pass_hash,
          },
          // Never offered to somebody who arrived this way. They have a Vesopa
          // account; a second password on a pub's menu is not an improvement.
          offer_password: false,
          is_new: !!diner.was_created,
          via: 'vesopa',
        },
      });

      const home = new URL(held.backTo || '/', `https://${MENU_HOST}`);
      home.searchParams.set('signed_in', handle);
      return res.redirect(302, home.pathname + home.search);
    } catch (error) {
      console.error('[dinein_auth] callback failed:', error.message);
      return next(error);
    }
  });

  /**
   * The page exchanges the handle for the session.
   *
   * Single use, two minutes, and a POST — so it is not something a Referer or
   * an access log can leak, and not something that can be replayed out of
   * somebody's history.
   */
  router.post('/api/public/dinein/auth/claim', express.json(), (req, res) => {
    sweep(handoffs, HANDOFF_TTL_MS);
    const handle = String((req.body || {}).handle || '');
    const held = handoffs.get(handle);
    if (!held) return res.status(400).json({ error: 'That sign-in has already been used.' });
    handoffs.delete(handle);
    return res.json(held.payload);
  });

  return router;
}

/**
 * Is this a path on this site we are willing to send somebody back to?
 *
 * Only a path, never a URL. `return=https://evil.example` is the oldest
 * phishing trick there is: the person checks the domain, signs in, and is
 * handed straight to somebody else's page — which then asks for the same thing
 * again and is believed.
 */
/**
 * The host this request arrived on, as the customer typed it.
 *
 * A proxy may append to `x-forwarded-host`; the first entry is the one the
 * browser asked for. The port is stripped because menu.vesopaepos.com:443 is
 * the same host. Mirrors `hostOf` in dinein_pages.js deliberately — the two
 * have to agree about what host a request is on, or a venue's own domain works
 * for the menu and not for the sign-in.
 */
function hostOf(req) {
  return String(req.headers['x-forwarded-host'] || req.headers.host || '')
    .split(',')[0]
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, '');
}

function safeReturn(referer, req) {
  try {
    const url = new URL(String(referer || ''), `https://${MENU_HOST}`);
    const path = url.pathname + url.search;
    if (!path.startsWith('/')) return '/';
    if (path.startsWith('//') || path.startsWith('/\\')) return '/';
    return path.slice(0, 300);
  } catch {
    return '/';
  }
}

/**
 * The diner row for a Vesopa account, at this venue.
 *
 * MATCHED ON `sub` FIRST, AND ON THE EMAIL ADDRESS ONLY IF IT IS VERIFIED.
 *
 * The subject is the stable identifier — an address changes, and two people can
 * share one. But somebody who has been ordering here with a code for a year
 * already has a row, and creating a second one would lose their history the
 * moment they signed in with Vesopa instead. So a verified address is allowed
 * to adopt the existing row, once, and the subject is written onto it.
 *
 * `email_verified` is what makes that safe. The identity provider will not
 * assert an address it has not proved — and adopting a row on an UNVERIFIED
 * address would be exactly the account-takeover the provider's own linking
 * interrupt exists to prevent.
 */
async function findOrCreateFromVesopa(pool, officeId, claims) {
  const sub = String(claims.sub || '').slice(0, 64);
  if (!sub) throw new Error('the token carried no subject');

  const email = claims.email_verified ? String(claims.email || '').toLowerCase() : '';
  const name = String(claims.name || '').trim().slice(0, 120) || null;

  const [[bySub]] = await pool.query(
    'SELECT * FROM dinein_diners WHERE office_id = ? AND vesopa_sub = ? LIMIT 1',
    [officeId, sub],
  );
  if (bySub) {
    await pool.execute(
      'UPDATE dinein_diners SET last_seen = NOW(), name = COALESCE(name, ?) WHERE id = ?',
      [name, bySub.id],
    );
    return bySub;
  }

  if (email) {
    const [[byEmail]] = await pool.query(
      'SELECT * FROM dinein_diners WHERE office_id = ? AND email = ? LIMIT 1',
      [officeId, email],
    );
    // Only ever reached with a real, verified address — `email` is '' above
    // when the provider did not assert one, and this branch is skipped.
    if (byEmail) {
      await pool.execute(
        `UPDATE dinein_diners
            SET vesopa_sub = ?, last_seen = NOW(),
                email_verified_at = NOW(), name = COALESCE(name, ?)
          WHERE id = ?`,
        [sub, name, byEmail.id],
      );
      byEmail.vesopa_sub = sub;
      return byEmail;
    }
  }

  /*
   * NULL for the address, not an empty string, when there is none.
   *
   * `uq_dinein_diner (office_id, email)` is a unique index, and MySQL treats
   * every NULL in one as distinct while treating two empty strings as the same
   * value. A phone-only Vesopa account inserted with '' would collide with the
   * next phone-only account at the same venue — the second person to sign in
   * gets a 1062 they cannot possibly understand. `email` was made nullable for
   * exactly this reason when phone sign-in was added; this respects it.
   */
  const [result] = await pool.execute(
    `INSERT INTO dinein_diners
       (office_id, email, pass_hash, name, vesopa_sub, last_seen, email_verified_at)
     VALUES (?, ?, NULL, ?, ?, NOW(), ?)`,
    [officeId, email || null, name, sub, email ? new Date() : null],
  );
  const [[made]] = await pool.query('SELECT * FROM dinein_diners WHERE id = ?', [result.insertId]);
  if (made) made.was_created = true;
  return made;
}

/** A plain page for the two things that can go wrong on the way back. */
function page(message, backTo) {
  const safe = String(message).replace(/[<>&]/g, '');
  const href = String(backTo || '/').replace(/"/g, '');
  return (
    '<!doctype html><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Vesopa</title>' +
    '<body style="margin:0;font:16px/1.5 -apple-system,BlinkMacSystemFont,' +
    "'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#F4F5F1;color:#14161A\">" +
    '<div style="max-width:420px;margin:16vh auto;padding:0 20px;text-align:center">' +
    `<p>${safe}</p>` +
    `<p><a href="${href}">Back to the menu</a></p>` +
    '<p style="color:#6b7280;font-size:14px">You can carry on ordering as a guest.</p>' +
    '</div>'
  );
}

module.exports = { dineinAuthRoutes, ENABLED, ISSUER, CLIENT_ID, REDIRECT_URI };
