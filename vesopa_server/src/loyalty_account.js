/**
 * The other ways in, and the member's own account page.
 *
 * WHY THIS IS ITS OWN FILE
 *
 * loyalty_app.js already carries the card, the points, the news and the whole
 * back office half. Adding four sign-in methods and an account section to it
 * would have made one file nobody can hold in their head. The split is along
 * the seam that matters: loyalty_app.js is what a member HAS, this is how they
 * prove who they are and what they may change about themselves.
 *
 * It is handed the session helpers rather than rebuilding them, because a
 * second implementation of "mint a token" is a second thing to get wrong.
 *
 * EVERY ROUTE HERE CHECKS THE VENUE ALLOWS IT. A method being switched off in
 * the back office is not merely a button the app stops drawing — the app is
 * software on somebody's phone and cannot be trusted to have stopped drawing
 * it. Turning off passwords has to mean passwords stop working.
 */
const crypto = require('crypto');

const express = require('express');

const auth = require('./loyalty_auth');
const { cleanPhone, postcoderSend, postcoderVerify } = require('./dinein_otp');

/** How long a texted code stands, matching the emailed one. */
const SMS_MINUTES = 10;
const SMS_PER_HOUR = 5;

module.exports = function loyaltyAccountRoutes(deps) {
  const {
    pool, json, requireCustomer, customerToken, appBySlug, revokeSessions,
    callerIp, customerByEmail, ensureCard, joinScheme, brandFor, sendMail,
    cleanText, emailOk,
  } = deps;

  const router = express.Router();

  /** The venue, and what it allows, or an answer for the caller. */
  async function venue(req, res, method) {
    const app = await appBySlug(pool, req.params.slug);
    if (!app) {
      res.status(404).json({ error: 'There is no app at this address.' });
      return null;
    }
    const methods = await auth.methodsFor(pool, app.office);
    if (method && !methods[method]) {
      res.status(400).json({ error: 'That way of signing in is not switched on for this venue.' });
      return null;
    }
    return app;
  }

  /** Start a session for a membership, exactly as the code flow does. */
  async function signIn(req, office, customerId) {
    const sessionId = crypto.randomUUID();
    const platform = ['web', 'windows', 'android', 'ios'].includes(req.body && req.body.platform)
      ? req.body.platform : 'web';
    await pool.execute(
      `INSERT INTO epos_loyalty_app_sessions (id, office, customer_id, platform, user_agent, last_seen_at)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      [sessionId, office, customerId, platform, cleanText(req.headers['user-agent'], 255)]
    );
    return customerToken(office, customerId, sessionId);
  }

  // ---- Signing in with a password ------------------------------------------

  /**
   * An email address and a password.
   *
   * A WRONG PASSWORD AND AN ADDRESS THAT IS NOT A MEMBER ANSWER THE SAME WAY.
   * Telling them apart would turn this into a way of asking the venue who its
   * customers are, which is the leak the code flow was already careful about.
   */
  router.post('/loyalty/v1/app/:slug/password', json, async (req, res, next) => {
    try {
      const app = await venue(req, res, 'password');
      if (!app) return;
      const email = String((req.body || {}).email || '').trim().toLowerCase();
      const password = String((req.body || {}).password || '');
      if (!emailOk(email) || !password) {
        return res.status(400).json({ error: 'Enter your email address and password.' });
      }
      const [[customer]] = await pool.query(
        `SELECT id, password_hash FROM epos_customers
          WHERE email_key = ? AND LOWER(email) = ? ORDER BY created_at LIMIT 1`,
        [app.office, email]
      );
      // Always spends the bcrypt time, member or not.
      if (!(await auth.passwordMatches(customer, password))) {
        return res.status(401).json({ error: 'That email address and password do not match.' });
      }
      await ensureCard(pool, app.office, customer.id);
      res.json({ token: await signIn(req, app.office, customer.id) });
    } catch (e) {
      next(e);
    }
  });

  // ---- Signing in with a passkey -------------------------------------------

  /**
   * What the browser needs to offer a passkey.
   *
   * An email address is optional and is a hint, not a check: given one we can
   * name that member's credentials, and without one the browser offers whatever
   * discoverable passkey it holds. Either way this answers the same for an
   * address that is not a member — it simply names no credentials.
   */
  router.post('/loyalty/v1/app/:slug/passkey/options', json, async (req, res, next) => {
    try {
      const app = await venue(req, res, 'passkey');
      if (!app) return;
      const email = String((req.body || {}).email || '').trim().toLowerCase();
      const customer = email && emailOk(email)
        ? await customerByEmail(pool, app.office, email) : null;
      res.json(await auth.authenticationOptions(pool, { office: app.office, customer }));
    } catch (e) {
      next(e);
    }
  });

  router.post('/loyalty/v1/app/:slug/passkey/verify', json, async (req, res, next) => {
    try {
      const app = await venue(req, res, 'passkey');
      if (!app) return;
      const result = await auth.verifyAuthentication(pool, { office: app.office, body: req.body || {} });
      if (result.error) return res.status(401).json({ error: result.error });
      await ensureCard(pool, app.office, result.customerId);
      res.json({ token: await signIn(req, app.office, result.customerId) });
    } catch (e) {
      next(e);
    }
  });

  // ---- Signing in with a texted code ---------------------------------------

  /**
   * Text a code to a number the venue already holds for a member.
   *
   * ONLY TO A NUMBER THAT WAS PROVED, and only to one already on the books. A
   * texted code to any number typed in would let somebody claim the membership
   * that happens to carry it — and numbers get onto customer records by being
   * read out across a counter and typed by somebody in a hurry.
   *
   * Answers the same whether or not the number is known, for the same reason
   * the emailed code does.
   */
  router.post('/loyalty/v1/app/:slug/sms', json, async (req, res, next) => {
    try {
      const app = await venue(req, res, 'code_sms');
      if (!app) return;
      const phone = cleanPhone(String((req.body || {}).phone || ''));
      if (!phone) return res.status(400).json({ error: 'Please enter your mobile number.' });

      const ip = callerIp(req);
      const [[recent]] = await pool.query(
        `SELECT COUNT(*) AS n FROM epos_loyalty_app_codes
          WHERE office = ? AND channel = 'sms' AND phone = ? AND created_at > NOW() - INTERVAL 1 HOUR`,
        [app.office, phone]
      );
      if (Number(recent.n) >= SMS_PER_HOUR) {
        return res.status(429).json({ error: 'Too many codes asked for. Please try again in an hour.' });
      }

      const [[customer]] = await pool.query(
        `SELECT id FROM epos_customers
          WHERE email_key = ? AND phone = ? AND phone_verified_at IS NOT NULL LIMIT 1`,
        [app.office, phone]
      );
      if (customer) {
        const brand = await brandFor(pool, app.office, app);
        const reference = await postcoderSend(phone, brand.name);
        if (reference) {
          await pool.execute(
            `INSERT INTO epos_loyalty_app_codes
               (id, office, email, channel, phone, reference, code_hash, expires_at, ip_address)
             VALUES (?, ?, '', 'sms', ?, ?, '', NOW() + INTERVAL ${SMS_MINUTES} MINUTE, ?)`,
            [crypto.randomUUID(), app.office, phone, reference, ip]
          );
        }
      }
      res.json({ ok: true, minutes: SMS_MINUTES });
    } catch (e) {
      next(e);
    }
  });

  router.post('/loyalty/v1/app/:slug/sms/verify', json, async (req, res, next) => {
    try {
      const app = await venue(req, res, 'code_sms');
      if (!app) return;
      const phone = cleanPhone(String((req.body || {}).phone || ''));
      const code = String((req.body || {}).code || '').trim();
      if (!phone || !/^\d{4,8}$/.test(code)) {
        return res.status(400).json({ error: 'Enter the code from the text message.' });
      }
      const [live] = await pool.query(
        `SELECT id, reference FROM epos_loyalty_app_codes
          WHERE office = ? AND channel = 'sms' AND phone = ?
            AND used_at IS NULL AND expires_at > NOW()
          ORDER BY created_at DESC LIMIT 3`,
        [app.office, phone]
      );
      let ok = false;
      for (const row of live) {
        // Postcoder generated and checks it; we never held the code itself.
        if (await postcoderVerify(row.reference, code)) { ok = true; break; }
      }
      if (!ok) return res.status(400).json({ error: 'That code is not right. Please try again.' });

      const [[customer]] = await pool.query(
        `SELECT id FROM epos_customers
          WHERE email_key = ? AND phone = ? AND phone_verified_at IS NOT NULL LIMIT 1`,
        [app.office, phone]
      );
      if (!customer) return res.status(400).json({ error: 'That code is not right. Please try again.' });

      await pool.execute(
        `UPDATE epos_loyalty_app_codes SET used_at = NOW()
          WHERE office = ? AND channel = 'sms' AND phone = ? AND used_at IS NULL`,
        [app.office, phone]
      );
      await ensureCard(pool, app.office, customer.id);
      res.json({ token: await signIn(req, app.office, customer.id) });
    } catch (e) {
      next(e);
    }
  });

  // ---- Continue with Vesopa -------------------------------------------------

  /**
   * Sign in with the Vesopa account the venue already issues.
   *
   * The app does the OAuth dance itself (it has a browser, or can open one) and
   * brings back the id token. This checks it and finds — or creates — the
   * membership behind it.
   *
   * MATCHED ON THE SUBJECT FIRST, THE EMAIL SECOND. An email at
   * auth.vesopa.com can be changed; the subject cannot. Matching on email alone
   * would hand somebody a membership by changing an address, and matching on
   * subject alone would strand every member who joined before this existed.
   */
  router.post('/loyalty/v1/app/:slug/vesopa', json, async (req, res, next) => {
    try {
      const app = await venue(req, res, 'vesopa');
      if (!app) return;
      /*
       * TWO WAYS IN, because the two kinds of app genuinely differ.
       *
       * The web app cannot swap a code for a token itself: that call wants
       * the client secret where there is one, and browsers would need auth
       * to allow cross-origin POSTs from every venue's address. So it sends
       * the code here and THIS server does the exchange. A token from auth
       * never touches the browser, which is the better arrangement anyway.
       *
       * A native app (Windows, and the phones later) opens a browser and
       * receives the answer on a loopback of its own, exactly as the till
       * and the display already do, and arrives here holding an id token.
       */
      const body = req.body || {};
      let idToken = String(body.id_token || '');
      if (!idToken && body.code) {
        idToken = await exchangeCode(String(body.code), String(body.code_verifier || ''),
          String(body.redirect_uri || ''));
        if (!idToken) return res.status(401).json({ error: 'That sign-in could not be completed.' });
      }
      const claims = await verifyVesopaToken(idToken);
      if (!claims) return res.status(401).json({ error: 'That sign-in could not be accepted.' });

      const email = String(claims.email || '').trim().toLowerCase();
      if (!claims.email_verified || !emailOk(email)) {
        return res.status(400).json({
          error: 'Your Vesopa account needs a confirmed email address before it can be used here.',
        });
      }

      let [[customer]] = await pool.query(
        'SELECT id FROM epos_customers WHERE email_key = ? AND vesopa_sub = ? LIMIT 1',
        [app.office, String(claims.sub)]
      );
      if (!customer) customer = await customerByEmail(pool, app.office, email);
      if (!customer) {
        const id = await joinScheme(pool, app.office, {
          name: cleanText(claims.name, 120) || email.split('@')[0],
          email,
        });
        customer = { id };
      }
      await pool.execute(
        'UPDATE epos_customers SET vesopa_sub = ? WHERE id = ? AND email_key = ?',
        [String(claims.sub), customer.id, app.office]
      );
      await ensureCard(pool, app.office, customer.id);
      res.json({ token: await signIn(req, app.office, customer.id) });
    } catch (e) {
      next(e);
    }
  });

  /**
   * Swap an authorization code for an id token, server to server.
   *
   * PKCE carries the proof, so this works whether or not the client has a
   * secret -- and the loyalty client is a public one, because the app it
   * serves is a web page anybody can read.
   */
  async function exchangeCode(code, verifier, redirectUri) {
    const issuer = String(process.env.VESOPA_AUTH_ISSUER || '').replace(/\/$/, '');
    const clientId = String(process.env.VESOPA_LOYALTY_CLIENT_ID || '');
    if (!issuer || !clientId || !code || !verifier) return null;
    try {
      const form = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        client_id: clientId,
        redirect_uri: redirectUri || `https://${process.env.MENU_HOST || 'menu.vesopaepos.com'}/app/vesopa/callback`,
      });
      const secret = process.env.VESOPA_LOYALTY_CLIENT_SECRET;
      if (secret) form.set('client_secret', secret);
      const res = await fetch(`${issuer}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form,
        signal: AbortSignal.timeout(12000),
      });
      if (!res.ok) {
        console.warn('[loyalty_account] token exchange refused:', res.status, (await res.text()).slice(0, 200));
        return null;
      }
      const data = await res.json();
      return data && data.id_token ? String(data.id_token) : null;
    } catch (e) {
      console.warn('[loyalty_account] token exchange failed:', e.message);
      return null;
    }
  }

  /*
   * The signing keys, cached, with the stale set kept as a fallback.
   *
   * THE PATH IS /jwks.json, NOT /.well-known/jwks.json. Guessing the
   * conventional path is what broke this: the fetch 404'd, the verifier
   * answered null, and every Continue with Vesopa was refused with a message
   * that blamed the sign-in. The discovery document publishes `jwks_uri` and
   * that is the authority -- so it is read from there and only falls back to
   * the known path if discovery itself cannot be reached.
   */
  let jwksCache = { at: 0, keys: null };
  const JWKS_TTL_MS = 60 * 60 * 1000;

  async function signingKeys() {
    if (jwksCache.keys && Date.now() - jwksCache.at < JWKS_TTL_MS) return jwksCache.keys;
    const issuer = String(process.env.VESOPA_AUTH_ISSUER || '').replace(/\/$/, '');
    try {
      let uri = `${issuer}/jwks.json`;
      try {
        const disco = await fetch(`${issuer}/.well-known/openid-configuration`,
          { signal: AbortSignal.timeout(8000) });
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
      // Stale beats nothing: an hour-old key set verifies today's tokens, and
      // a member signing in on a bad line should not fail for that.
      if (jwksCache.keys) return jwksCache.keys;
      throw e;
    }
  }

  /**
   * Check an id token from Vesopa Auth against its published keys.
   *
   * THE ALGORITHM COMES FROM THE KEY, never from the token's own header.
   * Trusting the header is the `alg: none` hole, where an attacker declares
   * the token unsigned and every check after it passes. The header is used
   * only to say WHICH key, which it cannot lie about usefully.
   */
  async function verifyVesopaToken(idToken) {
    const issuer = String(process.env.VESOPA_AUTH_ISSUER || '').replace(/\/$/, '');
    const clientId = String(process.env.VESOPA_LOYALTY_CLIENT_ID || '');
    if (!issuer || !clientId || !idToken) return null;
    try {
      const jwt = require('jsonwebtoken');
      const header = JSON.parse(Buffer.from(String(idToken).split('.')[0], 'base64url').toString());
      const keys = await signingKeys();
      const jwk = keys.find((k) => k.kid === header.kid) || (keys.length === 1 ? keys[0] : null);
      if (!jwk) return null;
      const algorithms = [jwk.alg || (jwk.kty === 'EC' ? 'ES256' : 'RS256')];
      const pem = crypto.createPublicKey({ key: jwk, format: 'jwk' })
        .export({ type: 'spki', format: 'pem' });
      return jwt.verify(idToken, pem, { algorithms, issuer, audience: clientId });
    } catch (e) {
      console.warn('[loyalty_account] vesopa token refused:', e.message);
      return null;
    }
  }
  // ---- The member's own account --------------------------------------------

  /** Who they are and what they can prove, for the account page. */
  router.get('/loyalty/v1/me/account', requireCustomer, async (req, res, next) => {
    try {
      const [[c]] = await pool.query(
        `SELECT name, email, phone, phone_verified_at, password_set_at, vesopa_sub
           FROM epos_customers WHERE id = ? AND email_key = ?`,
        [req.customerId, req.office]
      );
      if (!c) return res.status(404).json({ error: 'Your membership could not be found.' });
      const [keys] = await pool.query(
        `SELECT id, name, created_at, last_used_at FROM epos_loyalty_passkeys
          WHERE office = ? AND customer_id = ? AND revoked_at IS NULL ORDER BY created_at`,
        [req.office, req.customerId]
      );
      const [devices] = await pool.query(
        `SELECT id, platform, created_at, last_seen_at FROM epos_loyalty_app_sessions
          WHERE office = ? AND customer_id = ? AND revoked_at IS NULL ORDER BY last_seen_at DESC`,
        [req.office, req.customerId]
      );
      const [[settings]] = await pool.query(
        'SELECT auth_policy, self_service FROM epos_loyalty_app WHERE office = ?', [req.office]
      );
      const config = await auth.configFor(pool, req.office, settings);
      res.json({
        name: c.name,
        email: c.email,
        phone: c.phone || null,
        phone_verified: !!c.phone_verified_at,
        has_password: !!c.password_set_at,
        vesopa_linked: !!c.vesopa_sub,
        passkeys: keys,
        devices: devices.map((d) => ({ ...d, current: d.id === req.sessionId })),
        can_edit: config.self_service,
        methods: config.methods,
      });
    } catch (e) {
      next(e);
    }
  });

  /** Change the name on the card. */
  router.put('/loyalty/v1/me/account', requireCustomer, json, async (req, res, next) => {
    try {
      const [[settings]] = await pool.query(
        'SELECT auth_policy, self_service FROM epos_loyalty_app WHERE office = ?', [req.office]
      );
      const config = await auth.configFor(pool, req.office, settings);
      if (!config.self_service) {
        return res.status(403).json({ error: 'This venue keeps member details itself. Please ask at the venue.' });
      }
      const name = cleanText((req.body || {}).name, 120);
      if (!name) return res.status(400).json({ error: 'Please give a name for the card.' });
      await pool.execute(
        'UPDATE epos_customers SET name = ? WHERE id = ? AND email_key = ?',
        [name, req.customerId, req.office]
      );
      res.json({ ok: true, name });
    } catch (e) {
      next(e);
    }
  });

  /**
   * Set, change or remove a password.
   *
   * Changing one needs the old password; setting a first one does not, because
   * the member proved themselves getting into the app and has nothing older to
   * prove. Removing one needs it, so a borrowed unlocked phone cannot quietly
   * take a password off an account.
   */
  router.post('/loyalty/v1/me/password', requireCustomer, json, async (req, res, next) => {
    try {
      const methods = await auth.methodsFor(pool, req.office);
      if (!methods.password) {
        return res.status(400).json({ error: 'This venue does not use passwords.' });
      }
      const [[c]] = await pool.query(
        'SELECT password_hash, password_set_at FROM epos_customers WHERE id = ? AND email_key = ?',
        [req.customerId, req.office]
      );
      if (!c) return res.status(404).json({ error: 'Your membership could not be found.' });

      const body = req.body || {};
      const remove = body.remove === true;
      if ((c.password_set_at || remove) && !(await auth.passwordMatches(c, body.current))) {
        return res.status(401).json({ error: 'That is not your current password.' });
      }
      if (remove) {
        await pool.execute(
          'UPDATE epos_customers SET password_hash = NULL, password_set_at = NULL WHERE id = ? AND email_key = ?',
          [req.customerId, req.office]
        );
        return res.json({ ok: true, has_password: false });
      }
      const problem = auth.passwordProblem(body.password);
      if (problem) return res.status(400).json({ error: problem });
      await pool.execute(
        'UPDATE epos_customers SET password_hash = ?, password_set_at = NOW() WHERE id = ? AND email_key = ?',
        [await auth.hashPassword(body.password), req.customerId, req.office]
      );
      res.json({ ok: true, has_password: true });
    } catch (e) {
      next(e);
    }
  });

  /** Add a phone number: a code is texted to it, and it counts for nothing until proved. */
  router.post('/loyalty/v1/me/phone', requireCustomer, json, async (req, res, next) => {
    try {
      if (!process.env.POSTCODER_API_KEY) {
        return res.status(400).json({ error: 'Phone numbers cannot be confirmed on this server yet.' });
      }
      const phone = cleanPhone(String((req.body || {}).phone || ''));
      if (!phone) return res.status(400).json({ error: 'Please enter a mobile number.' });
      const [[settings]] = await pool.query('SELECT app_name FROM epos_loyalty_app WHERE office = ?', [req.office]);
      const brand = await brandFor(pool, req.office, settings);
      const reference = await postcoderSend(phone, brand.name);
      if (!reference) return res.status(502).json({ error: 'That text could not be sent. Please try again shortly.' });
      await pool.execute(
        `INSERT INTO epos_loyalty_app_codes
           (id, office, email, channel, phone, reference, code_hash, expires_at, ip_address)
         VALUES (?, ?, '', 'sms', ?, ?, '', NOW() + INTERVAL ${SMS_MINUTES} MINUTE, ?)`,
        [crypto.randomUUID(), req.office, phone, reference, callerIp(req)]
      );
      res.json({ ok: true, minutes: SMS_MINUTES });
    } catch (e) {
      next(e);
    }
  });

  router.post('/loyalty/v1/me/phone/verify', requireCustomer, json, async (req, res, next) => {
    try {
      const phone = cleanPhone(String((req.body || {}).phone || ''));
      const code = String((req.body || {}).code || '').trim();
      if (!phone || !code) return res.status(400).json({ error: 'Enter the code from the text message.' });
      const [live] = await pool.query(
        `SELECT id, reference FROM epos_loyalty_app_codes
          WHERE office = ? AND channel = 'sms' AND phone = ?
            AND used_at IS NULL AND expires_at > NOW()
          ORDER BY created_at DESC LIMIT 3`,
        [req.office, phone]
      );
      let ok = false;
      for (const row of live) {
        if (await postcoderVerify(row.reference, code)) { ok = true; break; }
      }
      if (!ok) return res.status(400).json({ error: 'That code is not right. Please try again.' });
      /*
       * ONE PROVED NUMBER PER MEMBERSHIP, per venue. Two memberships sharing a
       * proved number would make a texted code ambiguous, and the sign-in would
       * pick whichever row came back first.
       */
      await pool.execute(
        `UPDATE epos_customers SET phone_verified_at = NULL
          WHERE email_key = ? AND phone = ? AND id <> ?`,
        [req.office, phone, req.customerId]
      );
      await pool.execute(
        'UPDATE epos_customers SET phone = ?, phone_verified_at = NOW() WHERE id = ? AND email_key = ?',
        [phone, req.customerId, req.office]
      );
      await pool.execute(
        `UPDATE epos_loyalty_app_codes SET used_at = NOW()
          WHERE office = ? AND channel = 'sms' AND phone = ? AND used_at IS NULL`,
        [req.office, phone]
      );
      res.json({ ok: true, phone });
    } catch (e) {
      next(e);
    }
  });

  router.delete('/loyalty/v1/me/phone', requireCustomer, async (req, res, next) => {
    try {
      await pool.execute(
        'UPDATE epos_customers SET phone_verified_at = NULL WHERE id = ? AND email_key = ?',
        [req.customerId, req.office]
      );
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // ---- The member's passkeys ------------------------------------------------

  router.post('/loyalty/v1/me/passkeys/options', requireCustomer, json, async (req, res, next) => {
    try {
      const methods = await auth.methodsFor(pool, req.office);
      if (!methods.passkey) return res.status(400).json({ error: 'This venue does not use passkeys.' });
      const [[c]] = await pool.query(
        'SELECT id, name, email, member_no FROM epos_customers WHERE id = ? AND email_key = ?',
        [req.customerId, req.office]
      );
      if (!c) return res.status(404).json({ error: 'Your membership could not be found.' });
      res.json(await auth.registrationOptions(pool, { office: req.office, customer: c }));
    } catch (e) {
      next(e);
    }
  });

  router.post('/loyalty/v1/me/passkeys', requireCustomer, json, async (req, res, next) => {
    try {
      const methods = await auth.methodsFor(pool, req.office);
      if (!methods.passkey) return res.status(400).json({ error: 'This venue does not use passkeys.' });
      const [[c]] = await pool.query(
        'SELECT id FROM epos_customers WHERE id = ? AND email_key = ?', [req.customerId, req.office]
      );
      if (!c) return res.status(404).json({ error: 'Your membership could not be found.' });
      const result = await auth.saveRegistration(pool, {
        office: req.office, customer: c, body: req.body || {}, name: (req.body || {}).name,
      });
      if (result.error) return res.status(400).json({ error: result.error });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  router.delete('/loyalty/v1/me/passkeys/:id', requireCustomer, async (req, res, next) => {
    try {
      await pool.execute(
        `UPDATE epos_loyalty_passkeys SET revoked_at = NOW()
          WHERE id = ? AND office = ? AND customer_id = ? AND revoked_at IS NULL`,
        [String(req.params.id), req.office, req.customerId]
      );
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  /** Sign every other device out, leaving this one signed in. */
  router.post('/loyalty/v1/me/signout-others', requireCustomer, async (req, res, next) => {
    try {
      const n = await revokeSessions(
        'office = ? AND customer_id = ? AND id <> ?',
        [req.office, req.customerId, req.sessionId]
      );
      res.json({ ok: true, signed_out: n });
    } catch (e) {
      next(e);
    }
  });

  return router;
};
