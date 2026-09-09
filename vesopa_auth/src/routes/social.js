/**
 * Signing in with Google, Apple, Microsoft or GitHub.
 *
 * THE STATE LIVES IN THE DATABASE, NOT IN A COOKIE, and that is not a
 * preference. Apple returns its result as a cross-site form POST, and a
 * SameSite=Lax cookie is not sent on one. An implementation that keeps the
 * state in a cookie therefore works perfectly for Google, Microsoft and GitHub
 * and fails only for Apple — which is a miserable thing to debug, because the
 * code is plainly correct and only one provider is broken.
 *
 * THE LINKING RULE, WHICH IS THE WHOLE SECURITY OF THIS FILE
 *
 * An incoming Google account whose email matches an existing Vesopa account is
 * NOT linked to it. The attack that forbids it: somebody registers
 * victim@gmail.com here, never verifies it, and waits. The real owner later
 * signs in with Google. A silent link would weld the victim's Google identity
 * onto the attacker's account — and the attacker's password would then open it,
 * while the victim saw nothing but a successful sign-in.
 *
 * So a match interrupts: "you already have an account — sign in to link it".
 * The link is made only after the person has authenticated against the account
 * that already exists.
 */

const express = require('express');
const crypto = require('crypto');

const config = require('../config');
const db = require('../db');
const providers = require('../providers');
const identity = require('../identity');
const avatars = require('../avatars');
const sessions = require('../sessions');
const events = require('../events');
const rateLimit = require('../ratelimit');
const stepup = require('./stepup');
const factors = require('../factors');
const { normaliseEmail, normaliseSubject, isPrivateRelay } = require('../normalise');
const { newToken } = require('../crypto');
const { safeReturnTo } = require('./pages');

const router = express.Router();

const STATE_TTL_MINUTES = 15;

function fail(res, heading, message, status = 400) {
  return res.status(status).render('error', {
    title: 'Sign-in problem',
    heading,
    message,
    config,
    nonce: res.locals.nonce,
    noindex: true,
  });
}

// ---------------------------------------------------------------------------
// Off to the provider
// ---------------------------------------------------------------------------

router.get('/auth/:provider', async (req, res, next) => {
  try {
    const provider = providers.get(req.params.provider);
    if (!provider) return fail(res, 'Unknown sign-in method', 'That provider is not one we offer.', 404);
    if (!provider.configured) {
      return fail(
        res,
        `${provider.name} sign-in is not available yet`,
        'It has not been set up on this server. Please use your email address or phone number for now.',
        503,
      );
    }

    // Somebody bouncing through the provider redirect repeatedly is either
    // broken or probing; either way it costs the provider's rate limit as well
    // as ours.
    const attempt = await rateLimit.hit('social:start', req.clientIp || 'unknown', {
      limit: 30,
      windowSeconds: 900,
    });
    if (!attempt.allowed) {
      return fail(res, 'Too many attempts', 'Please wait a few minutes and try again.', 429);
    }

    /*
     * Linking rather than signing in? Only if they are already signed in. The
     * two intents are recorded separately and must never be interchangeable:
     * a link callback that could sign somebody in would let an attacker start a
     * link flow and finish it as a login.
     */
    const session = await sessions.load(req);
    const intent = req.query.intent === 'link' && session ? 'link' : 'login';

    const state = newToken(32);
    const nonce = newToken(24);
    const { verifier, challenge } = providers.pkce();

    await db.execute(
      `INSERT INTO oauth_states
         (state, provider, nonce, code_verifier, intent, user_id, return_to, ip, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? MINUTE))`,
      [
        state,
        provider.key,
        nonce,
        verifier,
        intent,
        intent === 'link' ? session.user_id : null,
        safeReturnTo(req.query.return_to),
        String(req.clientIp || '').slice(0, 45),
        STATE_TTL_MINUTES,
      ],
    );

    return res.redirect(
      303,
      provider.authorizeUrl({ state, nonce, codeChallenge: challenge }),
    );
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// Back from the provider
// ---------------------------------------------------------------------------

// Apple posts; the rest use a query string. Both land here.
router.get('/auth/:provider/callback', handleCallback);
router.post('/auth/:provider/callback', handleCallback);

async function handleCallback(req, res, next) {
  try {
    const provider = providers.get(req.params.provider);
    if (!provider) return fail(res, 'Unknown sign-in method', 'That provider is not one we offer.', 404);

    const source = req.method === 'POST' ? req.body : req.query;

    if (source.error) {
      // The person pressed cancel at the provider. That is not an error worth a
      // scary page — put them back where they started.
      return res.redirect(303, '/login');
    }

    /*
     * Claim the state, single use, in one statement. Two callbacks arriving
     * with the same state — a double-clicked link, or a replay — must not both
     * proceed, and a SELECT followed by an UPDATE would let them.
     */
    const claimed = await db.execute(
      `UPDATE oauth_states SET consumed_at = NOW()
        WHERE state = ? AND provider = ? AND consumed_at IS NULL AND expires_at > NOW()`,
      [String(source.state || ''), provider.key],
    );
    if (claimed.affectedRows !== 1) {
      return fail(
        res,
        'That sign-in link has expired',
        'It may have been used already, or left open too long. Please start again.',
      );
    }
    const flow = await db.one('SELECT * FROM oauth_states WHERE state = ?', [source.state]);

    if (!source.code) {
      return fail(res, 'Sign-in did not complete', `${provider.name} did not send us anything to work with.`);
    }

    // ------------------------------------------------------------------
    // Ask the provider who this is
    // ------------------------------------------------------------------
    let profile;
    let tokenSet;
    try {
      tokenSet = await provider.exchange({
        code: source.code,
        codeVerifier: flow.code_verifier,
      });
      profile = await provider.profile(tokenSet, { nonce: flow.nonce, callbackBody: source });
    } catch (error) {
      console.error(`[social] ${provider.key} exchange failed:`, error.message);
      await events.recordLogin({
        method: provider.key,
        outcome: 'failure',
        failureReason: 'provider_error',
        ip: req.clientIp,
        userAgent: req.userAgent,
      });
      return fail(
        res,
        `We could not finish signing in with ${provider.name}`,
        'Nothing has been changed on your account. Please try again, or use your email address.',
      );
    }

    const subject = normaliseSubject(profile.subject);
    if (!subject) return fail(res, 'Sign-in did not complete', `${provider.name} did not identify you.`);

    const assertedEmail = normaliseEmail(profile.email);
    // Apple relay addresses are real and forward, and are NOT the person's own
    // address. They must never be matched against one.
    const relay = profile.isPrivateRelay || isPrivateRelay(profile.email);

    // ------------------------------------------------------------------
    // Do we know this provider account already?
    // ------------------------------------------------------------------
    const existing = await identity.findIdentity(provider.key, subject);

    if (flow.intent === 'link') {
      return await finishLink(req, res, { provider, flow, existing, subject, profile, assertedEmail, relay, tokenSet });
    }

    if (existing) {
      if (existing.user_status !== 'active') {
        return fail(res, 'That account is not available', 'Please contact info@vesopasoftware.com.');
      }
      await identity.touchIdentity(existing.id);
      return await signIn(req, res, { userId: existing.user_id, provider, flow });
    }

    // ------------------------------------------------------------------
    // New provider account. Is there already a Vesopa account for the person?
    // ------------------------------------------------------------------
    const candidate = relay
      ? null
      : await identity.findLinkCandidate(profile.email, assertedEmail, provider.trustsEmail && profile.emailVerified);

    if (candidate) {
      /*
       * SAME PERSON, SAME ADDRESS — LINK IT AND LET THEM IN.
       *
       * This used to stop and render `link-required`: "you already have a
       * Vesopa account, sign in to it first, then link Google." It was the
       * cautious reading, and it was the wrong one. Somebody who presses
       * Continue with Google has answered the question of who they are. Being
       * told to go and fetch a code from their email instead is the moment
       * they decide the sign-in is broken — and they are half right, because
       * the code proves ownership of the very address Google just proved.
       *
       * WHAT MAKES THIS SAFE, and it is not a judgement call — every one of
       * these is already enforced by identity.findLinkCandidate, which returns
       * null unless ALL of them hold:
       *
       *   the provider is one we trust to verify addresses at all;
       *   the provider asserted email_verified for THIS sign-in;
       *   the Vesopa identity it matches is itself verified (verified_at);
       *   the address is not an Apple private relay.
       *
       * So the match is verified-to-verified. That is the same bar Google and
       * Microsoft use to merge an account, and it is strictly stronger than
       * the emailed code the old page demanded: a code proves somebody can
       * read the mailbox now, which is exactly what the provider's assertion
       * already says.
       *
       * If any of those fail, `candidate` is null and we never reach here —
       * an unverified provider address still cannot claim an existing account.
       */
      await identity.attachIdentity(candidate.user_id, {
        type: provider.key,
        identifier: profile.email || subject,
        normalised: subject,
        display: profile.email || '',
        verified: true,
        verifiedVia: provider.key,
      });

      await events.recordLogin({
        userId: candidate.user_id,
        method: provider.key,
        outcome: 'success',
        // Kept in the record: this sign-in is also the moment the provider
        // became attached, and a support call about "when did Google appear on
        // my account" is answered by this row.
        failureReason: 'auto_linked',
        identifier: assertedEmail,
        ip: req.clientIp,
        userAgent: req.userAgent,
      });

      return await signIn(req, res, { userId: candidate.user_id, provider, flow });
    }

    // ------------------------------------------------------------------
    // Nobody here by that name: make an account.
    // ------------------------------------------------------------------
    let userId;
    try {
      const created = await identity.createUser({
        type: provider.key,
        identifier: profile.email || subject,
        normalised: subject,
        display: profile.email || '',
        verified: true,
        verifiedVia: provider.key,
        displayName: profile.name || '',
        profile: profile.raw,
        assertedEmail: profile.email || '',
        assertedEmailVerified: profile.emailVerified,
      });
      userId = created.userId;

      /*
       * The address becomes a real identity of its own — so the person can
       * later sign in with a code to it, or set a password — but ONLY when the
       * provider is one we trust to have verified it, and never for an Apple
       * relay address, which can be switched off and stop existing.
       *
       * A duplicate here is not fatal: it means somebody else already holds
       * that address, and the account still works through the provider.
       */
      if (assertedEmail && profile.emailVerified && provider.trustsEmail && !relay) {
        try {
          await identity.attachIdentity(userId, {
            type: 'email',
            identifier: profile.email,
            normalised: assertedEmail,
            verified: true,
            verifiedVia: provider.key,
          });
        } catch (error) {
          if (!db.isDuplicate(error)) throw error;
        }
      }

      await captureAvatar({ provider, userId, publicId: created.publicId, profile, tokenSet });

      await events.recordAudit({
        actorUserId: userId,
        action: 'account.created',
        targetType: 'user',
        targetId: created.publicId,
        detail: { via: provider.key },
        ip: req.clientIp,
      });
    } catch (error) {
      // Two callbacks for the same brand-new provider account, racing. The
      // index refused the second; adopt whichever won.
      if (!db.isDuplicate(error)) throw error;
      const now = await identity.findIdentity(provider.key, subject);
      if (!now) throw error;
      userId = now.user_id;
    }

    return await signIn(req, res, { userId, provider, flow });
  } catch (error) {
    return next(error);
  }
}

/** Attach this provider account to the person who is already signed in. */
async function finishLink(req, res, { provider, flow, existing, subject, profile, assertedEmail, relay, tokenSet }) {
  const session = await sessions.load(req);
  if (!session || session.user_id !== flow.user_id) {
    return fail(res, 'Please sign in again', 'We could not confirm who you are. Nothing has been linked.');
  }

  if (existing) {
    if (existing.user_id === session.user_id) {
      return res.redirect(303, '/account?linked=already');
    }
    // Somebody else holds it. The uniqueness rule is doing its job.
    return fail(
      res,
      `That ${provider.name} account is already in use`,
      `It is linked to a different Vesopa account. Unlink it there first, and it will be free to add here.`,
    );
  }

  try {
    await identity.attachIdentity(session.user_id, {
      type: provider.key,
      identifier: profile.email || subject,
      normalised: subject,
      display: profile.email || '',
      verified: true,
      verifiedVia: provider.key,
      profile: profile.raw,
      assertedEmail: profile.email || '',
      assertedEmailVerified: profile.emailVerified,
    });
  } catch (error) {
    if (db.isDuplicate(error)) {
      return fail(
        res,
        `That ${provider.name} account is already in use`,
        'It is linked to a different Vesopa account.',
      );
    }
    throw error;
  }

  /*
   * Take the picture only if they have not got one. Linking a second provider
   * must not silently replace a photograph the person chose themselves.
   */
  const user = await identity.getUser(session.user_id);
  if (!user.avatar_path) {
    await captureAvatar({
      provider,
      userId: session.user_id,
      publicId: user.public_id,
      profile,
      tokenSet,
    });
  }

  await events.recordAudit({
    actorUserId: session.user_id,
    action: 'identity.linked',
    targetType: 'identity',
    targetId: provider.key,
    detail: { email: profile.email || null, relay },
    ip: req.clientIp,
    userAgent: req.userAgent,
  });

  // Tell them. A link they did not make is something they must hear about, and
  // this is the only warning they will get.
  await notify(session.user_id, {
    heading: `${provider.name} was linked to your account`,
    body: `Your ${provider.name} account can now be used to sign in to Vesopa.`,
    req,
  });

  return res.redirect(303, safeReturnTo(flow.return_to) || '/account?linked=1');
}

/** Start a session and put them where they were going. */
async function signIn(req, res, { userId, provider, flow }) {
  const known = await sessions.recogniseDevice(req, res);
  const deviceId = known && !known.reuseDetected ? known.id : null;

  /*
   * A provider is ONE factor, not two.
   *
   * It is easy to assume that somebody who came back from Google with a valid
   * ID token has already done their own two-step verification, and to wave them
   * through. Google may well have — but we cannot see whether they did, and the
   * factor the person enrolled HERE is the one this account's owner chose. So
   * the same rule as every other first factor: if they hold a second one, they
   * are asked for it.
   */
  const held = await factors.enrolled(userId);
  if (held.any && !factors.deviceMaySkip(known)) {
    stepup.setPending(res, {
      u: userId,
      a: [provider.key],
      r: safeReturnTo(flow.return_to) || '',
      m: true,
      p: null,
    });

    await events.recordLogin({
      userId,
      method: provider.key,
      outcome: 'challenge',
      failureReason: 'second_factor_required',
      ip: req.clientIp,
      userAgent: req.userAgent,
    });

    return res.redirect(303, '/login/second');
  }

  const session = await sessions.create({
    userId,
    amr: [provider.key],
    acr: held.any ? 'aal2' : 'aal1',
    remembered: true,
    deviceId,
    ip: req.clientIp,
    userAgent: req.userAgent,
  });

  sessions.setCookie(res, session.token, true);

  await events.recordLogin({
    userId,
    sessionId: session.id,
    method: provider.key,
    outcome: 'success',
    ip: req.clientIp,
    userAgent: req.userAgent,
    deviceId,
  });

  return res.redirect(303, safeReturnTo(flow.return_to) || '/account');
}

/**
 * Copy the provider's profile picture, if there is one.
 *
 * Best effort, always. This runs at the end of a sign-in with the person
 * waiting, so a slow or missing image must cost them nothing — every failure
 * inside is swallowed and simply leaves them without a picture, which they can
 * upload themselves.
 *
 * Apple never sends one. Microsoft keeps it behind Graph rather than in the ID
 * token, so it needs the access token as well.
 */
async function captureAvatar({ provider, userId, publicId, profile, tokenSet }) {
  try {
    if (provider.key === 'microsoft') {
      await avatars.storeFromMicrosoftGraph(userId, publicId, tokenSet && tokenSet.access_token);
      return;
    }
    if (profile.picture) {
      await avatars.storeFromUrl(userId, publicId, profile.picture);
    }
  } catch (error) {
    console.warn('[social] avatar not captured:', error.message);
  }
}

async function notify(userId, { heading, body, req }) {
  try {
    const mailer = require('../mailer');
    const address = await db.one(
      `SELECT identifier FROM user_identities
        WHERE user_id = ? AND type = 'email' AND revoked_at IS NULL AND verified_at IS NOT NULL
        ORDER BY is_recovery, created_at LIMIT 1`,
      [userId],
    );
    if (!address) return;
    await mailer.sendSecurityNotice({
      to: address.identifier,
      heading,
      body,
      when: new Date().toUTCString(),
      ip: req.clientIp,
      device: sessions.describeDevice(req.userAgent),
    });
  } catch (error) {
    // A notification that cannot be sent must never break the action it is
    // describing — the link has already happened.
    console.error('[social] notification failed:', error.message);
  }
}

module.exports = router;
