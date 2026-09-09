/**
 * The OpenID Connect provider: /authorize, /token, /userinfo and their
 * neighbours.
 *
 * WHERE ERRORS GO, WHICH IS A SECURITY DECISION AND NOT A STYLE ONE
 *
 * OAuth says most failures at /authorize are reported by redirecting back to
 * the client with `?error=`. That is only safe once the client and its redirect
 * URI have both been established as genuine. Before that — unknown client_id,
 * or a redirect_uri that is not registered — redirecting is the vulnerability:
 * an attacker registers nothing, points `redirect_uri` at their own site, and
 * this server becomes an open redirect wearing Vesopa's domain.
 *
 * So: those two failures render a page here and go nowhere. Everything after
 * them redirects, as the specification asks.
 */

const express = require('express');
const crypto = require('crypto');

const config = require('../config');
const db = require('../db');
const keys = require('../keys');
const sessions = require('../sessions');
const identity = require('../identity');
const events = require('../events');
const csrf = require('../csrf');
const clients = require('../oauth/clients');
const tokens = require('../oauth/tokens');
const { newId, newToken, hashToken, safeEqual } = require('../crypto');

const router = express.Router();

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * The document every client library reads first.
 *
 * Getting this right is most of what "simple integration" means: a developer
 * who can point their library at the issuer URL never has to be told any of
 * these paths, and never mistypes one.
 */
router.get('/.well-known/openid-configuration', (req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.json({
    issuer: config.issuer,
    authorization_endpoint: `${config.issuer}/oauth/authorize`,
    token_endpoint: `${config.issuer}/oauth/token`,
    userinfo_endpoint: `${config.issuer}/oauth/userinfo`,
    jwks_uri: `${config.issuer}/jwks.json`,
    revocation_endpoint: `${config.issuer}/oauth/revoke`,
    introspection_endpoint: `${config.issuer}/oauth/introspect`,
    end_session_endpoint: `${config.issuer}/oauth/logout`,

    scopes_supported: ['openid', 'profile', 'email', 'phone', 'offline_access', 'roles'],
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token', 'client_credentials'],
    subject_types_supported: ['public', 'pairwise'],
    id_token_signing_alg_values_supported: [keys.ALGORITHM],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic', 'none'],

    // PKCE, and S256 only. `plain` is in the specification and is not offered:
    // it protects against nothing an attacker who can see the request cannot
    // trivially defeat.
    code_challenge_methods_supported: ['S256'],

    claims_supported: [
      'sub', 'iss', 'aud', 'exp', 'iat', 'auth_time', 'nonce', 'amr', 'acr', 'sid',
      'name', 'given_name', 'family_name', 'picture', 'birthdate', 'locale', 'zoneinfo',
      'email', 'email_verified', 'phone_number', 'phone_number_verified', 'roles',
    ],

    service_documentation: `${config.issuer}/docs`,
    op_policy_uri: `${config.issuer}/privacy`,
    op_tos_uri: `${config.issuer}/terms`,
  });
});

router.get('/jwks.json', async (req, res, next) => {
  try {
    res.set('Cache-Control', 'public, max-age=3600');
    res.json(await keys.jwks());
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// /oauth/authorize
// ---------------------------------------------------------------------------

/** Send the client an error the way the specification asks. */
function redirectError(res, redirectUri, state, error, description) {
  const url = new URL(redirectUri);
  url.searchParams.set('error', error);
  if (description) url.searchParams.set('error_description', description);
  if (state) url.searchParams.set('state', state);
  return res.redirect(303, url.toString());
}

/** Render a dead end, for the failures that must not be redirected. */
function fatal(res, heading, message) {
  return res.status(400).render('error', {
    title: 'Sign-in problem',
    heading,
    message,
    config,
    nonce: res.locals.nonce,
    noindex: true,
  });
}

router.get('/oauth/authorize', async (req, res, next) => {
  try {
    const {
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: responseType,
      scope: requestedScope,
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: codeChallengeMethod,
      prompt,
      acr_values: acrValues,
    } = req.query;

    const application = await clients.find(clientId);
    if (!application) {
      return fatal(
        res,
        'That application is not recognised',
        'The application that sent you here is not registered with Vesopa, or has been suspended. Nothing has been shared.',
      );
    }

    if (!clients.matchRedirect(application, redirectUri)) {
      // NOT a redirect. See the note at the top of this file: obeying an
      // unregistered redirect_uri is precisely the hole.
      return fatal(
        res,
        'That return address is not registered',
        `${application.name} asked us to send you somewhere it has not registered with Vesopa. For your safety we have stopped here.`,
      );
    }

    // From here on, errors go back to the client.
    if (responseType !== 'code') {
      return redirectError(res, redirectUri, state, 'unsupported_response_type',
        'Only the authorization code flow is supported.');
    }
    if (!clients.allowsGrant(application, 'authorization_code')) {
      return redirectError(res, redirectUri, state, 'unauthorized_client',
        'This application may not use the authorization code grant.');
    }
    if (!codeChallenge || codeChallengeMethod !== 'S256') {
      return redirectError(res, redirectUri, state, 'invalid_request',
        'PKCE with S256 is required for every client.');
    }

    const scopes = await clients.permittedScopes(application, requestedScope);
    if (!scopes.granted.includes('openid')) {
      return redirectError(res, redirectUri, state, 'invalid_scope',
        'The openid scope is required.');
    }

    const session = await sessions.load(req);

    if (!session) {
      if (prompt === 'none') {
        return redirectError(res, redirectUri, state, 'login_required',
          'No one is signed in.');
      }
      // Send them to sign in, and bring them straight back to this exact
      // request afterwards. `return_to` is a path on this site only, which is
      // what safeReturnTo enforces.
      const back = `/oauth/authorize?${new URLSearchParams(req.query).toString()}`;
      return res.redirect(303, `/login?return_to=${encodeURIComponent(back)}`);
    }

    await sessions.touch(session);

    /*
     * Isolation: may this person use this application at all?
     *
     * One pool of people, per-application membership. A QR menu enrols whoever
     * turns up; a back office does not, and says so rather than silently
     * creating an account nobody meant to create.
     */
    const member = await clients.membership(application.id, session.user_id);
    if (!member || member.status === 'removed') {
      if (!application.allow_self_enroll) {
        return redirectError(res, redirectUri, state, 'access_denied',
          'You do not have access to this application.');
      }
      await clients.enrol(application.id, session.user_id);
    } else if (member.status === 'suspended') {
      return redirectError(res, redirectUri, state, 'access_denied',
        'Your access to this application has been suspended.');
    }

    /*
     * Consent.
     *
     * Vesopa's own products skip it, and that is a considered decision rather
     * than a shortcut: asking somebody to authorise "Vesopa EPOS" to see their
     * Vesopa profile, on Vesopa's own sign-in page, teaches people to click
     * through consent screens without reading them — which is the exact habit
     * the screen exists to prevent. Third parties always ask.
     */
    const needsConsent =
      !application.is_first_party &&
      !(await db.one(
        `SELECT id FROM oauth_consents
          WHERE user_id = ? AND application_id = ? AND revoked_at IS NULL
            AND scope = ?`,
        [session.user_id, application.id, scopes.granted.join(' ')],
      ));

    if (needsConsent) {
      if (prompt === 'none') {
        return redirectError(res, redirectUri, state, 'consent_required',
          'This application needs your permission first.');
      }
      return res.render('consent', {
        title: `Allow ${application.name}?`,
        nonce: res.locals.nonce,
        config,
        application,
        scopes: scopes.describe,
        session,
        query: req.query,
        noindex: true,
      });
    }

    return issueCode(res, { application, session, scopes: scopes.granted, req });
  } catch (error) {
    return next(error);
  }
});

/** The consent screen's answer. */
router.post('/oauth/consent', csrf.verify, async (req, res, next) => {
  try {
    const session = await sessions.load(req);
    if (!session) return res.redirect(303, '/login');

    const application = await clients.find(req.body.client_id);
    if (!application) return fatal(res, 'That application is not recognised', 'Nothing has been shared.');
    if (!clients.matchRedirect(application, req.body.redirect_uri)) {
      return fatal(res, 'That return address is not registered', 'For your safety we have stopped here.');
    }

    const scopes = await clients.permittedScopes(application, req.body.scope);

    if (req.body.decision !== 'allow') {
      await events.recordAudit({
        actorUserId: session.user_id,
        action: 'consent.denied',
        targetType: 'application',
        targetId: application.client_id,
        applicationId: application.id,
        ip: req.clientIp,
      });
      return redirectError(res, req.body.redirect_uri, req.body.state, 'access_denied',
        'You chose not to continue.');
    }

    await db.execute(
      `INSERT INTO oauth_consents (user_id, application_id, scope, ip)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE scope = VALUES(scope), granted_at = NOW(), revoked_at = NULL`,
      [session.user_id, application.id, scopes.granted.join(' '), req.clientIp],
    );

    await events.recordAudit({
      actorUserId: session.user_id,
      action: 'consent.granted',
      targetType: 'application',
      targetId: application.client_id,
      applicationId: application.id,
      detail: { scope: scopes.granted },
      ip: req.clientIp,
    });

    return issueCode(res, {
      application,
      session,
      scopes: scopes.granted,
      req,
      override: req.body,
    });
  } catch (error) {
    return next(error);
  }
});

/**
 * Mint the authorisation code and send them back.
 *
 * The code is hashed, single-use and lives sixty seconds. It is long because it
 * is a bearer credential for the length of one HTTP round trip, and short-lived
 * because that is all it ever needs to be.
 */
async function issueCode(res, { application, session, scopes, req, override = null }) {
  const source = override || req.query;
  const code = newToken(32);

  await db.execute(
    `INSERT INTO oauth_authorization_codes
       (code_hash, application_id, user_id, session_id, redirect_uri, scope, nonce,
        code_challenge, code_challenge_method, amr, acr, auth_time, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'S256', ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? SECOND))`,
    [
      hashToken(code),
      application.id,
      session.user_id,
      session.id,
      source.redirect_uri,
      scopes.join(' '),
      source.nonce || '',
      source.code_challenge,
      typeof session.amr === 'string' ? session.amr : JSON.stringify(session.amr || []),
      session.acr || 'aal1',
      session.created_at,
      config.tokens.authorizationCodeTtlSeconds,
    ],
  );

  await db.execute(
    'UPDATE application_members SET last_seen_at = NOW() WHERE application_id = ? AND user_id = ?',
    [application.id, session.user_id],
  );

  const url = new URL(source.redirect_uri);
  url.searchParams.set('code', code);
  if (source.state) url.searchParams.set('state', source.state);
  return res.redirect(303, url.toString());
}

// ---------------------------------------------------------------------------
// /oauth/token
// ---------------------------------------------------------------------------

function tokenError(res, error, description, status = 400) {
  return res.status(status).json({ error, error_description: description });
}

/**
 * Which application is calling, and has it proved it?
 *
 * Accepts a secret in the body or in HTTP Basic, because both are in the
 * specification and client libraries differ. A public client presents no secret
 * and is identified by client_id alone — which is safe only because PKCE binds
 * the code to the caller.
 */
async function authenticateClient(req) {
  let clientId = req.body.client_id;
  let secret = req.body.client_secret;

  const header = String(req.get('authorization') || '');
  if (header.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const index = decoded.indexOf(':');
    if (index > 0) {
      clientId = decodeURIComponent(decoded.slice(0, index));
      secret = decodeURIComponent(decoded.slice(index + 1));
    }
  }

  const application = await clients.find(clientId);
  if (!application) return { error: 'invalid_client' };

  if (clients.isPublic(application)) {
    // A public client must NOT send a secret. One arriving means the developer
    // has misconfigured something and believes they are protected when they are
    // not, so say so rather than ignoring it.
    if (secret) return { error: 'invalid_client', description: 'This client must not send a secret.' };
    return { application };
  }

  if (!(await clients.verifySecret(application, secret))) {
    return { error: 'invalid_client', description: 'Client authentication failed.' };
  }
  return { application };
}

router.post('/oauth/token', async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');

    const auth = await authenticateClient(req);
    if (auth.error) return tokenError(res, auth.error, auth.description, 401);
    const application = auth.application;

    const grantType = req.body.grant_type;
    if (!clients.allowsGrant(application, grantType)) {
      return tokenError(res, 'unauthorized_client', `This application may not use ${grantType}.`);
    }

    if (grantType === 'authorization_code') {
      return await exchangeCode(req, res, application);
    }
    if (grantType === 'refresh_token') {
      return await exchangeRefresh(req, res, application);
    }
    if (grantType === 'client_credentials') {
      return await clientCredentials(req, res, application);
    }
    return tokenError(res, 'unsupported_grant_type', `${grantType} is not supported.`);
  } catch (error) {
    return next(error);
  }
});

async function exchangeCode(req, res, application) {
  const { code, redirect_uri: redirectUri, code_verifier: verifier } = req.body;
  if (!code || !verifier) {
    return tokenError(res, 'invalid_request', 'code and code_verifier are required.');
  }

  const row = await db.one(
    'SELECT * FROM oauth_authorization_codes WHERE code_hash = ?',
    [hashToken(code)],
  );
  if (!row) return tokenError(res, 'invalid_grant', 'That code is not valid.');
  if (row.application_id !== application.id) {
    return tokenError(res, 'invalid_grant', 'That code was issued to another application.');
  }

  /*
   * A code presented twice means somebody else has it. Everything descended
   * from it is revoked — the legitimate client will have to start again, which
   * is a far better outcome than an attacker holding a live session.
   */
  if (row.consumed_at) {
    /*
     * Revoke what descended from THIS code, scoped to the session it belonged
     * to — not everything this person holds for this application.
     *
     * The broader version is tempting and wrong: one replayed code from a
     * laptop would sign the same person out of the till and their phone as
     * well. The code came from one session; the blast radius is that session.
     */
    if (row.session_id) {
      await db.execute(
        `UPDATE oauth_refresh_tokens SET revoked_at = NOW(), revoked_reason = 'code_replay'
          WHERE application_id = ? AND session_id = ? AND revoked_at IS NULL`,
        [application.id, row.session_id],
      );
    } else {
      await db.execute(
        `UPDATE oauth_refresh_tokens SET revoked_at = NOW(), revoked_reason = 'code_replay'
          WHERE user_id = ? AND application_id = ? AND revoked_at IS NULL`,
        [row.user_id, application.id],
      );
    }

    await events.recordLogin({
      userId: row.user_id,
      applicationId: application.id,
      method: 'refresh',
      outcome: 'blocked',
      failureReason: 'code_replay',
      ip: req.clientIp,
      userAgent: req.userAgent,
    });

    return tokenError(res, 'invalid_grant', 'That code has already been used.');
  }

  if (new Date(row.expires_at) < new Date()) {
    return tokenError(res, 'invalid_grant', 'That code has expired.');
  }
  if (row.redirect_uri !== redirectUri) {
    return tokenError(res, 'invalid_grant', 'redirect_uri does not match the one used to get the code.');
  }

  // PKCE: SHA-256 of the verifier, base64url, compared in constant time.
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  if (!safeEqual(challenge, row.code_challenge)) {
    return tokenError(res, 'invalid_grant', 'PKCE verification failed.');
  }

  const consumed = await db.execute(
    'UPDATE oauth_authorization_codes SET consumed_at = NOW() WHERE id = ? AND consumed_at IS NULL',
    [row.id],
  );
  if (consumed.affectedRows !== 1) {
    return tokenError(res, 'invalid_grant', 'That code has already been used.');
  }

  const user = await identity.getUser(row.user_id);
  if (!user || user.status !== 'active') {
    return tokenError(res, 'invalid_grant', 'That account is not available.');
  }

  const scope = row.scope.split(' ').filter(Boolean);
  const amr = safeJson(row.amr, []);
  const roles = scope.includes('roles') ? await clients.rolesFor(application.id, user.id) : null;

  const sessionPublicId = await sessionPublicIdFor(row.session_id);
  const accessToken = await tokens.issueAccessToken({
    application, user, scope, sessionId: sessionPublicId, amr, acr: row.acr, roles,
  });
  const claims = await tokens.claimsFor(user, scope);
  const idToken = await tokens.issueIdToken({
    application, user, nonce: row.nonce, sessionId: sessionPublicId,
    amr, acr: row.acr, authTime: row.auth_time, claims,
  });

  const body = {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: application.access_token_ttl || config.tokens.accessTtlSeconds,
    id_token: idToken,
    scope: scope.join(' '),
  };

  // A refresh token only when `offline_access` was asked for and granted. Handing
  // one to every client by default gives long-lived access to applications that
  // never needed it.
  if (scope.includes('offline_access')) {
    const refresh = await tokens.issueRefreshToken({
      application,
      userId: user.id,
      sessionId: row.session_id,
      deviceId: null,
      scope,
      ip: req.clientIp,
    });
    body.refresh_token = refresh.token;
  }

  await events.recordLogin({
    userId: user.id,
    applicationId: application.id,
    method: 'refresh',
    outcome: 'success',
    ip: req.clientIp,
    userAgent: req.userAgent,
  });

  return res.json(body);
}

async function exchangeRefresh(req, res, application) {
  const presented = req.body.refresh_token;
  if (!presented) return tokenError(res, 'invalid_request', 'refresh_token is required.');

  const result = await tokens.rotateRefreshToken({
    application,
    presented,
    ip: req.clientIp,
  });

  if (!result.ok) {
    if (result.replay) {
      /*
       * Reuse. The family is already revoked. Tell the person, because a stolen
       * refresh token is exactly the event they need to hear about and the
       * only signal they will get.
       */
      await events.recordLogin({
        userId: result.row.user_id,
        applicationId: application.id,
        method: 'refresh',
        outcome: 'blocked',
        failureReason: 'token_reuse',
        ip: req.clientIp,
        userAgent: req.userAgent,
      });
      return tokenError(res, 'invalid_grant', 'That token has already been used. All sessions for this application have been ended.');
    }
    if (result.retry) {
      return tokenError(res, 'invalid_grant', 'That token was just used. Please retry.', 409);
    }
    return tokenError(res, 'invalid_grant', 'That refresh token is not valid.');
  }

  const row = result.row;
  const user = await identity.getUser(row.user_id);
  if (!user || user.status !== 'active') {
    return tokenError(res, 'invalid_grant', 'That account is not available.');
  }

  const scope = row.scope.split(' ').filter(Boolean);
  const roles = scope.includes('roles') ? await clients.rolesFor(application.id, user.id) : null;
  const sessionPublicId = await sessionPublicIdFor(row.session_id);

  const accessToken = await tokens.issueAccessToken({
    application, user, scope, sessionId: sessionPublicId, roles,
  });

  return res.json({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: application.access_token_ttl || config.tokens.accessTtlSeconds,
    refresh_token: result.token,
    scope: scope.join(' '),
  });
}

async function clientCredentials(req, res, application) {
  if (clients.isPublic(application)) {
    return tokenError(res, 'unauthorized_client', 'A public client cannot use client_credentials.');
  }
  const scopes = await clients.permittedScopes(application, req.body.scope);
  const scope = scopes.granted.filter((s) => s !== 'openid');

  const token = await keys.sign(
    { sub: application.client_id, client_id: application.client_id, scope: scope.join(' ') },
    { audience: application.client_id, expiresIn: config.tokens.accessTtlSeconds, type: 'at+jwt' },
  );

  return res.json({
    access_token: token,
    token_type: 'Bearer',
    expires_in: config.tokens.accessTtlSeconds,
    scope: scope.join(' '),
  });
}

// ---------------------------------------------------------------------------
// /oauth/userinfo
// ---------------------------------------------------------------------------

router.get('/oauth/userinfo', async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    const header = String(req.get('authorization') || '');
    if (!header.startsWith('Bearer ')) {
      res.set('WWW-Authenticate', 'Bearer');
      return res.status(401).json({ error: 'invalid_token' });
    }

    let payload;
    try {
      ({ payload } = await keys.verify(header.slice(7)));
    } catch {
      res.set('WWW-Authenticate', 'Bearer error="invalid_token"');
      return res.status(401).json({ error: 'invalid_token' });
    }

    const application = await clients.find(payload.client_id);
    if (!application) return res.status(401).json({ error: 'invalid_token' });

    /*
     * Find the person from the `sub` in the token. For a pairwise subject that
     * cannot be reversed — it is an HMAC — so the lookup goes the other way:
     * take the membership list for this application and find whose derived
     * subject matches. The list is small because it is scoped to one
     * application, which is the point of scoping it.
     */
    const user = await userFromSubject(application, payload.sub);
    if (!user) return res.status(401).json({ error: 'invalid_token' });

    const scope = String(payload.scope || '').split(' ').filter(Boolean);
    const claims = await tokens.claimsFor(user, scope);
    return res.json({ sub: payload.sub, ...claims });
  } catch (error) {
    return next(error);
  }
});

async function userFromSubject(application, subject) {
  if (application.subject_type === 'public') {
    return identity.getUserByPublicId(subject);
  }
  const members = await db.query(
    `SELECT u.* FROM application_members m
       JOIN users u ON u.id = m.user_id
      WHERE m.application_id = ? AND m.status = 'active'`,
    [application.id],
  );
  return (
    members.find((user) => tokens.subjectFor(application, user.public_id) === subject) || null
  );
}

// ---------------------------------------------------------------------------
// Revocation, introspection, logout
// ---------------------------------------------------------------------------

router.post('/oauth/revoke', async (req, res, next) => {
  try {
    const auth = await authenticateClient(req);
    if (auth.error) return tokenError(res, auth.error, auth.description, 401);
    if (req.body.token) await tokens.revokeToken(req.body.token, 'client_revoked');
    // Always 200, whether or not the token existed: the specification says so,
    // and answering differently turns this into an oracle for guessing tokens.
    return res.status(200).end();
  } catch (error) {
    return next(error);
  }
});

router.post('/oauth/introspect', async (req, res, next) => {
  try {
    const auth = await authenticateClient(req);
    if (auth.error) return tokenError(res, auth.error, auth.description, 401);

    try {
      const { payload } = await keys.verify(req.body.token);
      return res.json({
        active: true,
        scope: payload.scope,
        client_id: payload.client_id,
        sub: payload.sub,
        exp: payload.exp,
        iat: payload.iat,
        token_type: 'Bearer',
      });
    } catch {
      return res.json({ active: false });
    }
  } catch (error) {
    return next(error);
  }
});

/**
 * RP-initiated logout.
 *
 * Ends the session here. It does NOT end the application's own session — that
 * is theirs to end, and pretending otherwise is the third mistake Kimi
 * predicted. Access tokens already issued stay valid until they expire, which
 * is why they last ten minutes.
 */
router.get('/oauth/logout', async (req, res, next) => {
  try {
    const session = await sessions.load(req);
    if (session) {
      await sessions.revoke(session.id, 'rp_logout');
      sessions.clearCookie(res);
    }

    const target = req.query.post_logout_redirect_uri;
    if (target) {
      const application = await clients.find(req.query.client_id);
      if (application && clients.matchRedirect(application, target, 'logout')) {
        const url = new URL(target);
        if (req.query.state) url.searchParams.set('state', req.query.state);
        return res.redirect(303, url.toString());
      }
      // An unregistered post-logout URI is dropped rather than obeyed: it is
      // the same open-redirect hole as at /authorize, and being at the end of
      // a flow makes it no safer.
    }
    return res.redirect(303, '/login');
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------

function safeJson(value, fallback) {
  if (!value) return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

async function sessionPublicIdFor(sessionId) {
  if (!sessionId) return null;
  const row = await db.one('SELECT public_id FROM sso_sessions WHERE id = ?', [sessionId]);
  return row ? row.public_id : null;
}

module.exports = router;
