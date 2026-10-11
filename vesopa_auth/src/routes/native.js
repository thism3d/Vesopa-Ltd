/**
 * Signing in to Vesopa from a venue's own app, natively (2026-10-11).
 *
 * The app shows the device's own sheets -- Sign in with Apple, Google's sign-in,
 * the iPhone's or iPad's passkey prompt -- and no web page of ours opens. What
 * the sheet gives back is handed here and becomes an ordinary authorisation
 * code for that app, which it swaps at /oauth/token with its PKCE verifier like
 * any other. So the account, the session, the devices list, the second factor
 * and the application's membership rules are exactly the ones Continue with
 * Vesopa uses; only the page in the middle is gone.
 *
 *   POST /oauth/native  (JSON)
 *     client_id, redirect_uri, scope, nonce,
 *     code_challenge, code_challenge_method=S256      as /oauth/authorize
 *     provider   'apple' | 'google' | 'passkey'
 *     id_token   apple, google: what the sheet returned
 *     name       apple: the name Apple gives once, on the first sign-in
 *     credential passkey: the assertion, with the challenge from
 *                /webauthn/authenticate/options
 *   -> 200 { code }
 *   -> 4xx { error, error_description }   error_description is fit to show
 *
 * WHICH APPS. Only `native` clients, and a provider token only when it was
 * minted for one of our own apps (its audience):
 *
 *   NATIVE_APPLE_AUDIENCES   bundle ids; default the apps that exist today
 *   NATIVE_GOOGLE_AUDIENCES  Google OAuth client ids (each app's iOS client;
 *                            the web client GOOGLE_CLIENT_ID is always taken)
 *   NATIVE_PASSKEY_ORIGINS   origins an app's passkey assertion may carry
 *                            besides https://<rp id> (what an iPhone sends):
 *                            Android's android:apk-key-hash:...
 *
 * A passkey needs the app named in the RP ID's own apple-app-site-association
 * and assetlinks.json (vesopa.com; tool/deploy_pontardawe_app.py puts them there).
 *
 * CONSENT, IN THE APP. An application that asks for it (Vesopa Loyalty does:
 * schema_016) gets `consent_required` the first time, with what it would see
 * and a `ticket`. The app shows that in its own dialog and, on Allow, sends
 * { ticket, consent: true } with the same client_id, redirect_uri and
 * code_challenge: no second Apple sheet or passkey prompt. The ticket is
 * signed, lasts five minutes and is bound to that code_challenge. Consent is
 * only ever granted here for Vesopa's own applications.
 *
 * WHAT IS NOT DONE HERE: a second factor. An Apple or Google sign-in to an
 * account that holds one answers `second_factor_required`, and the app goes
 * through Continue with Vesopa's page, where it is asked for. A passkey is
 * already aal2.
 */
const crypto = require('crypto');
const express = require('express');

const config = require('../config');
const db = require('../db');
const sessions = require('../sessions');
const events = require('../events');
const factors = require('../factors');
const identity = require('../identity');
const rateLimit = require('../ratelimit');
const providers = require('../providers');
const clients = require('../oauth/clients');
const { normaliseEmail, normaliseSubject, isPrivateRelay } = require('../normalise');
const { accountFor } = require('./social');
const { checkPasskey } = require('./mfa');
const { admit, mintCode } = require('./oidc');

const router = express.Router();

function list(value, fallback = '') {
  return String(value || fallback).split(',').map((s) => s.trim()).filter(Boolean);
}

function audiences(provider) {
  if (provider === 'apple') {
    return list(process.env.NATIVE_APPLE_AUDIENCES,
      'com.vesopaepos.pontardawerfc,com.vesopaepos.thevesopakitchen');
  }
  if (provider === 'google') {
    return [...new Set([...list(process.env.NATIVE_GOOGLE_AUDIENCES), ...list(process.env.GOOGLE_CLIENT_ID)])];
  }
  return [];
}

function passkeyOrigins() {
  return [
    ...config.webauthn.rpOrigins,
    `https://${config.webauthn.rpId}`,
    ...list(process.env.NATIVE_PASSKEY_ORIGINS),
  ];
}

// ---- The consent ticket ----------------------------------------------------------

const TICKET_MINUTES = 5;

function mac(body) {
  // 'native.' keeps it from ever reading as step-up's pending state, which is
  // signed with the same secret.
  return crypto.createHmac('sha256', config.secrets.codePepper).update(`native.${body}`).digest('base64url');
}

function makeTicket(who, application, codeChallenge) {
  const body = Buffer.from(JSON.stringify({
    u: who.userId, m: who.amr, l: who.acr, a: application.id, c: codeChallenge,
    exp: Date.now() + TICKET_MINUTES * 60000,
  })).toString('base64url');
  return `${body}.${mac(body)}`;
}

function readTicket(raw, application, codeChallenge) {
  const [body, given] = String(raw || '').split('.', 2);
  if (!body || !given) return null;
  const a = Buffer.from(given);
  const b = Buffer.from(mac(body));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const t = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!t.u || t.exp < Date.now() || t.a !== application.id || t.c !== codeChallenge) return null;
    return { userId: t.u, amr: t.m, acr: t.l };
  } catch {
    return null;
  }
}

function refuse(res, status, error, description) {
  return res.status(status).json({ error, error_description: description });
}

const PASSKEY_WORDS = {
  unknown_credential: 'That passkey is not on a Vesopa account. Please sign in another way.',
  account_unavailable: 'That account is not available. Please contact info@vesopasoftware.com.',
  challenge_expired: 'That took too long. Please try again.',
  not_verified: 'That passkey could not be checked. Please try again.',
  no_credential: 'No passkey came back. Please try again.',
};

/** Apple or Google: who the token says, and their Vesopa account. */
async function fromProvider(req, res, key) {
  const provider = providers.get(key);
  const audience = audiences(key);
  if (!provider || !audience.length) {
    refuse(res, 400, 'unsupported_provider', `Signing in with ${provider ? provider.name : 'that'} is not set up for this app yet.`);
    return null;
  }
  const given = String(req.body.name || '').trim().slice(0, 120);
  const [firstName, ...rest] = given.split(/\s+/);
  let profile;
  try {
    profile = await provider.profile(
      { id_token: String(req.body.id_token || '') },
      {
        audience,
        // Apple gives the name once, to the app; this is the shape its
        // website callback carries it in.
        callbackBody: given ? { user: JSON.stringify({ name: { firstName, lastName: rest.join(' ') } }) } : null,
      },
    );
  } catch (error) {
    console.warn(`[native] ${key} token refused:`, error.message);
    await events.recordLogin({
      method: key, outcome: 'failure', failureReason: 'provider_error', ip: req.clientIp, userAgent: req.userAgent,
    });
    refuse(res, 401, 'invalid_grant', `${provider.name} did not confirm who you are. Please try again.`);
    return null;
  }

  const subject = normaliseSubject(profile.subject);
  if (!subject) {
    refuse(res, 401, 'invalid_grant', `${provider.name} did not confirm who you are. Please try again.`);
    return null;
  }
  const existing = await identity.findIdentity(provider.key, subject);
  const found = await accountFor(req, {
    provider,
    profile,
    tokenSet: { id_token: req.body.id_token },
    subject,
    assertedEmail: normaliseEmail(profile.email),
    relay: profile.isPrivateRelay || isPrivateRelay(profile.email),
    existing,
  });
  if (found.unavailable) {
    refuse(res, 403, 'access_denied', 'That account is not available. Please contact info@vesopasoftware.com.');
    return null;
  }

  // ONE factor, as on the website (social.js signIn): somebody who holds a
  // second one is asked for it, on Vesopa's page.
  const held = await factors.enrolled(found.userId);
  if (held.any) {
    await events.recordLogin({
      userId: found.userId, method: key, outcome: 'challenge', failureReason: 'second_factor_required',
      ip: req.clientIp, userAgent: req.userAgent,
    });
    refuse(res, 409, 'second_factor_required', 'Your account has two-step sign-in, so Vesopa will ask for it.');
    return null;
  }
  return { userId: found.userId, amr: [key], acr: 'aal1' };
}

router.post('/oauth/native', async (req, res, next) => {
  try {
    const body = req.body || {};
    const limited = await rateLimit.hit('native_signin', req.clientIp || 'unknown', { limit: 60, windowSeconds: 600 });
    if (limited && limited.allowed === false) {
      return refuse(res, 429, 'slow_down', 'Too many tries. Please wait a few minutes.');
    }

    const application = await clients.find(body.client_id);
    if (!application || application.client_type !== 'native') {
      return refuse(res, 400, 'invalid_client', 'This app is not registered with Vesopa.');
    }
    if (!clients.matchRedirect(application, body.redirect_uri)) {
      return refuse(res, 400, 'invalid_request', 'This app is not registered with Vesopa.');
    }
    if (!clients.allowsGrant(application, 'authorization_code')) {
      return refuse(res, 400, 'unauthorized_client', 'This app may not sign in this way.');
    }
    if (!body.code_challenge || body.code_challenge_method !== 'S256') {
      return refuse(res, 400, 'invalid_request', 'PKCE with S256 is required.');
    }
    const scopes = await clients.permittedScopes(application, body.scope);
    if (!scopes.granted.includes('openid')) {
      return refuse(res, 400, 'invalid_scope', 'The openid scope is required.');
    }

    // ---- Who is this ------------------------------------------------------------
    let who;
    const provider = String(body.provider || '');
    if (body.ticket) {
      who = readTicket(body.ticket, application, body.code_challenge);
      if (!who) return refuse(res, 400, 'invalid_grant', 'That took too long. Please sign in again.');
    } else if (provider === 'apple' || provider === 'google') {
      who = await fromProvider(req, res, provider);
      if (!who) return undefined;
    } else if (provider === 'passkey') {
      const credential = body.credential && typeof body.credential === 'object' ? body.credential : {};
      const checked = await checkPasskey(req, { ...credential, challenge: body.challenge }, passkeyOrigins());
      if (checked.error) {
        return refuse(res, checked.status === 403 ? 403 : 401, checked.error,
          PASSKEY_WORDS[checked.error] || 'That passkey could not be used. Please try again.');
      }
      who = { userId: checked.stored.user_id, amr: ['webauthn'], acr: 'aal2' };
    } else {
      return refuse(res, 400, 'unsupported_provider', 'That way of signing in is not offered here.');
    }

    // ---- May they use this app, and is this sign-in strong enough ---------------
    const required = await factors.requiredFor({ userId: who.userId, application, scopes: scopes.granted });
    if (!factors.meets(who.acr, required)) {
      return refuse(res, 409, 'second_factor_required', 'This app needs two-step sign-in, so Vesopa will ask for it.');
    }

    const admitted = await admit(application, who.userId);
    if (admitted !== 'ok') {
      return refuse(res, 403, 'access_denied', admitted === 'suspended'
        ? `Your access to ${application.name} has been suspended.`
        : `${application.name} has not given this Vesopa account access.`);
    }

    const needsConsent =
      (application.show_consent === undefined ? !application.is_first_party : Boolean(application.show_consent)) &&
      !(await db.one(
        `SELECT id FROM oauth_consents
          WHERE user_id = ? AND application_id = ? AND revoked_at IS NULL AND scope = ?`,
        [who.userId, application.id, scopes.granted.join(' ')],
      ));
    if (needsConsent) {
      if (!application.is_first_party) {
        return refuse(res, 409, 'consent_required', `${application.name} needs your permission on Vesopa's page first.`);
      }
      if (!(body.ticket && body.consent === true)) {
        return res.status(409).json({
          error: 'consent_required',
          error_description: `Allow ${application.app_display_name || application.name} to use your Vesopa account?`,
          application: application.app_display_name || application.name,
          scopes: scopes.describe.map((row) => ({ name: row.name, title: row.title, description: row.description })),
          ticket: makeTicket(who, application, body.code_challenge),
        });
      }
      await db.execute(
        `INSERT INTO oauth_consents (user_id, application_id, scope, ip)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE scope = VALUES(scope), granted_at = NOW(), revoked_at = NULL`,
        [who.userId, application.id, scopes.granted.join(' '), req.clientIp],
      );
      await events.recordAudit({
        actorUserId: who.userId,
        action: 'consent.granted',
        targetType: 'application',
        targetId: application.client_id,
        applicationId: application.id,
        detail: { scope: scopes.granted, via: 'app' },
        ip: req.clientIp,
      });
    }

    // The same session a sign-in on the website starts: it is on the person's
    // devices page, and signing out there ends the app's refresh token too.
    const started = await sessions.create({
      userId: who.userId,
      amr: who.amr,
      acr: who.acr,
      remembered: true,
      ip: req.clientIp,
      userAgent: req.userAgent,
    });
    const session = await sessions.loadByToken(started.token);

    const code = await mintCode({
      application,
      session,
      scopes: scopes.granted,
      redirectUri: body.redirect_uri,
      nonce: body.nonce,
      codeChallenge: body.code_challenge,
    });

    await events.recordLogin({
      userId: who.userId,
      sessionId: started.id,
      method: who.amr[0],
      outcome: 'success',
      applicationId: application.id,
      ip: req.clientIp,
      userAgent: req.userAgent,
    });

    return res.json({ code });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
module.exports.audiences = audiences;
module.exports.passkeyOrigins = passkeyOrigins;
module.exports.makeTicket = makeTicket;
module.exports.readTicket = readTicket;
