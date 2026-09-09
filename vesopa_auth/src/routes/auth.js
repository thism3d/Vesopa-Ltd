/**
 * Signing in, which on this site is the same thing as signing up.
 *
 * THE SHAPE OF THE FLOW
 *
 *   POST /login          identifier in, code out, always
 *   GET  /login/verify   type the code, or a password if there is one
 *   POST /login/verify   check it, make the account if it is new, start a session
 *   POST /logout         end it
 *
 * A CODE IS SENT WHETHER OR NOT THE ACCOUNT EXISTS, and that is the design, not
 * a shortcut. For somebody who already has an account it signs them in; for
 * somebody who does not it is the verification step of creating one. The person
 * never has to know which of the two happened, which is exactly what the owner
 * asked for: one form, one button, and a link under it that changes a word.
 *
 * It also means the response to "is bob@example.com registered?" is identical
 * either way — same page, same wording, same work done. The one remaining tell
 * is that a password box appears for accounts that have a password, and that is
 * a deliberate, documented trade: the alternative is either hiding password
 * sign-in from the people who use it, or offering a password box to everyone
 * and telling most of them their correct password is wrong.
 */

const express = require('express');

const config = require('../config');
const db = require('../db');
const identity = require('../identity');
const challenges = require('../challenges');
const sessions = require('../sessions');
const events = require('../events');
const rateLimit = require('../ratelimit');
const csrf = require('../csrf');
const sms = require('../sms');
const settings = require('../settings');
const { verifyPassword } = require('../crypto');
const { normaliseEmail, normalisePhone, guessIdentifierType } = require('../normalise');
const { safeReturnTo } = require('./pages');

const router = express.Router();

/*
 * Which challenge this browser is answering.
 *
 * In a cookie rather than the URL. A query string is copied into a chat window
 * when somebody asks for help, lands in browser history on a shared machine,
 * and survives in whatever logs the URL passes through. None of that is fatal
 * on its own — the challenge id is not the code — but it is a free thing to
 * avoid.
 */
const FLOW_COOKIE = config.isProduction ? '__Host-vesopa_flow' : 'vesopa_flow';

function setFlow(res, value) {
  res.cookie(FLOW_COOKIE, value, {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: 'lax',
    path: '/',
    maxAge: (config.codes.ttlMinutes + 5) * 60 * 1000,
  });
}

function clearFlow(res) {
  res.clearCookie(FLOW_COOKIE, {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: 'lax',
    path: '/',
  });
}

/** Dial codes for the country picker, matched to the login page's list. */
const DIAL_CODES = {
  GB: '44', IE: '353', US: '1', FR: '33', DE: '49', ES: '34',
  IT: '39', NL: '31', PL: '48', IN: '91', PK: '92', BD: '880',
};

/** Show the sign-in form again with something gone wrong. */
async function backToLogin(res, { error, mode = 'login', channel = 'email', identifier = '', returnTo = '' }) {
  const live = await settings.all();
  return res.status(400).render('login', {
    title: 'Sign in to Vesopa',
    description: 'One Vesopa account for every Vesopa product.',
    nonce: res.locals.nonce,
    config,
    mode,
    channel,
    providers: require('../providers').enabled(),
    returnTo,
    identifier,
    error,
    noindex: true,
    settings: live,
    layout: live.login_layout,
  });
}

// ---------------------------------------------------------------------------
// POST /login — the identifier
// ---------------------------------------------------------------------------

router.post('/login', csrf.verify, async (req, res, next) => {
  try {
    const mode = req.body.mode === 'register' ? 'register' : 'login';
    const returnTo = safeReturnTo(req.body.return_to);
    const remember = req.body.remember === '1';

    let channel = req.body.channel === 'phone' ? 'phone' : 'email';
    let typed = channel === 'phone' ? req.body.phone : req.body.email;
    typed = String(typed || '').trim();

    if (!typed) {
      return await backToLogin(res, {
        error: channel === 'phone' ? 'Enter your mobile number.' : 'Enter your email address.',
        mode,
        channel,
        returnTo,
      });
    }

    /*
     * Somebody typed a number into the email box, or an address into the phone
     * box. Follow what they meant rather than what the toggle said — being told
     * "that email address does not look right" when you have carefully typed a
     * phone number is the kind of small insult that loses an account.
     */
    const guessed = guessIdentifierType(typed);
    if (guessed && guessed !== channel) channel = guessed;

    let normalised = null;
    if (channel === 'email') {
      normalised = normaliseEmail(typed);
      if (!normalised) {
        return await backToLogin(res, {
          error: 'That does not look like an email address.',
          mode,
          channel,
          identifier: typed,
          returnTo,
        });
      }
    } else {
      const country = DIAL_CODES[req.body.dial] ? req.body.dial : 'GB';
      normalised = normalisePhone(typed, country);
      if (!normalised) {
        return await backToLogin(res, {
          error: 'That does not look like a mobile number.',
          mode,
          channel,
          identifier: typed,
          returnTo,
        });
      }
      if (!sms.canReach(normalised)) {
        return await backToLogin(res, {
          error:
            'We can only text UK mobile numbers at the moment. Please use your email address instead.',
          mode,
          channel: 'email',
          returnTo,
        });
      }
    }

    const existing = await identity.findIdentity(channel === 'email' ? 'email' : 'phone', normalised);

    /*
     * A suspended account is told the same thing as everyone else and simply
     * never receives a code. Saying "your account is suspended" on a public form
     * confirms the address exists and tells whoever is probing something about
     * the person that is none of their business.
     */
    const suspended = existing && existing.user_status !== 'active';

    let result = { ok: true, challengeId: null };
    if (!suspended) {
      result = await challenges.create({
        channel: channel === 'email' ? 'email' : 'sms',
        purpose: existing ? 'login' : 'register',
        destination: typed,
        destinationNorm: normalised,
        userId: existing ? existing.user_id : null,
        ip: req.clientIp,
        userAgent: req.userAgent,
      });
    }

    if (!result.ok && result.reason !== 'destination_rate_limited') {
      await events.recordLogin({
        userId: existing ? existing.user_id : null,
        method: channel === 'email' ? 'email_code' : 'sms_otp',
        outcome: 'failure',
        failureReason: result.reason,
        identifier: normalised,
        ip: req.clientIp,
        userAgent: req.userAgent,
      });

      const messages = {
        country_not_supported:
          'We can only text UK mobile numbers at the moment. Please use your email instead.',
        sms_send_failed: 'We could not send that text. Please try email instead.',
        email_send_failed: 'We could not send that email. Please try again in a moment.',
        ip_rate_limited: 'Too many attempts from here. Please wait a few minutes and try again.',
      };
      return await backToLogin(res, {
        error: messages[result.reason] || 'Something went wrong. Please try again.',
        mode,
        channel,
        identifier: typed,
        returnTo,
      });
    }

    await events.recordLogin({
      userId: existing ? existing.user_id : null,
      method: channel === 'email' ? 'email_code' : 'sms_otp',
      outcome: 'challenge',
      identifier: normalised,
      ip: req.clientIp,
      userAgent: req.userAgent,
    });

    /*
     * The flow cookie carries everything the next page needs. `hasPassword` is
     * resolved here rather than there so the verify page does not have to look
     * the account up again — and so that a rate-limited or suspended request,
     * which never touched the database, produces a page that looks exactly like
     * a successful one.
     */
    const hasPassword = existing
      ? Boolean(
          await db.one(
            'SELECT id FROM user_passwords WHERE user_id = ? AND retired_at IS NULL LIMIT 1',
            [existing.user_id],
          ),
        )
      : false;

    setFlow(
      res,
      JSON.stringify({
        c: result.challengeId,
        d: typed,
        n: normalised,
        ch: channel,
        p: hasPassword,
        r: returnTo,
        m: remember,
        u: existing ? existing.user_id : null,
      }),
    );

    return res.redirect(303, '/login/verify');
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// GET /login/verify — type the code
// ---------------------------------------------------------------------------

function readFlow(req) {
  const raw = req.cookies ? req.cookies[FLOW_COOKIE] : null;
  if (!raw) return null;
  try {
    const flow = JSON.parse(raw);
    return flow && flow.n ? flow : null;
  } catch {
    return null;
  }
}

router.get('/login/verify', (req, res) => {
  const flow = readFlow(req);
  if (!flow) return res.redirect(303, '/login');

  return res.render('verify', {
    title: 'Enter your code',
    nonce: res.locals.nonce,
    config,
    destination: flow.d,
    channel: flow.ch,
    hasPassword: Boolean(flow.p),
    minutes: config.codes.ttlMinutes,
    error: '',
    noindex: true,
  });
});

// ---------------------------------------------------------------------------
// POST /login/verify — check it, and sign them in
// ---------------------------------------------------------------------------

router.post('/login/verify', csrf.verify, async (req, res, next) => {
  try {
    const flow = readFlow(req);
    if (!flow) return res.redirect(303, '/login');

    const usingPassword = Boolean(req.body.password);
    const method = usingPassword
      ? 'password'
      : flow.ch === 'phone'
        ? 'sms_otp'
        : 'email_code';

    const showAgain = (error) =>
      res.status(400).render('verify', {
        title: 'Enter your code',
        nonce: res.locals.nonce,
        config,
        destination: flow.d,
        channel: flow.ch,
        hasPassword: Boolean(flow.p),
        minutes: config.codes.ttlMinutes,
        error,
        noindex: true,
      });

    let userId = flow.u;
    let identityRow = null;
    let amr = [];

    if (usingPassword) {
      /*
       * A separate, tighter limit for passwords. The code path is protected by
       * the challenge's own attempt counter, which dies after five; a password
       * has no such counter of its own, so this is it.
       */
      const attempt = await rateLimit.hit('password', flow.n, {
        limit: 5,
        windowSeconds: 900,
      });
      if (!attempt.allowed) {
        await events.recordLogin({
          userId,
          method: 'password',
          outcome: 'blocked',
          failureReason: 'rate_limited',
          identifier: flow.n,
          ip: req.clientIp,
          userAgent: req.userAgent,
        });
        return showAgain('Too many attempts. Please wait fifteen minutes, or use the code instead.');
      }

      if (!userId) return showAgain('That password is not right.');

      const stored = await db.one(
        'SELECT password_hash FROM user_passwords WHERE user_id = ? AND retired_at IS NULL LIMIT 1',
        [userId],
      );
      const good =
        stored &&
        (await verifyPassword(stored.password_hash, req.body.password, config.secrets.passwordPepper));

      if (!good) {
        await events.recordLogin({
          userId,
          method: 'password',
          outcome: 'failure',
          failureReason: 'wrong_password',
          identifier: flow.n,
          ip: req.clientIp,
          userAgent: req.userAgent,
        });
        return showAgain('That password is not right.');
      }

      await rateLimit.clear('password', flow.n);
      amr = ['pwd'];
    } else {
      const check = await challenges.verify({
        challengeId: flow.c,
        code: req.body.code,
        ip: req.clientIp,
      });

      if (!check.ok) {
        await events.recordLogin({
          userId,
          method,
          outcome: 'failure',
          failureReason: check.reason,
          identifier: flow.n,
          ip: req.clientIp,
          userAgent: req.userAgent,
        });

        const messages = {
          wrong_code: 'That code is not right. Check it and try again.',
          expired: 'That code has expired. Ask for a new one.',
          already_used: 'That code has already been used. Ask for a new one.',
          superseded: 'A newer code was sent. Please use that one.',
          too_many_attempts: 'Too many attempts. Ask for a new code.',
          not_found: 'That code is not right. Check it and try again.',
        };
        return showAgain(messages[check.reason] || 'That code is not right.');
      }

      amr = [flow.ch === 'phone' ? 'sms' : 'otp'];

      /*
       * THE REGISTRATION HALF OF THE LOGIN PAGE.
       *
       * Nobody was found for this identifier, and they have just proved they
       * receive at it — so this is a new account. The person is not told that
       * anything different happened, because from where they are standing
       * nothing different did.
       */
      if (!userId) {
        const type = flow.ch === 'phone' ? 'phone' : 'email';
        try {
          const created = await identity.createUser({
            type,
            identifier: flow.d,
            normalised: flow.n,
            verified: true,
            verifiedVia: type === 'phone' ? 'sms' : 'email_code',
          });
          userId = created.userId;
          await events.recordAudit({
            actorUserId: userId,
            action: 'account.created',
            targetType: 'user',
            targetId: created.publicId,
            detail: { via: type },
            ip: req.clientIp,
            userAgent: req.userAgent,
          });
        } catch (error) {
          /*
           * Somebody registered this identifier between the code being sent and
           * it being typed — two tabs, or two people racing for one shared
           * mailbox. The index refused the second insert, which is exactly its
           * job. Adopt the account that now exists rather than failing: this
           * person has just proved they receive at that address.
           */
          if (!db.isDuplicate(error)) throw error;
          const now = await identity.findIdentity(type, flow.n);
          if (!now) throw error;
          userId = now.user_id;
        }
      } else {
        identityRow = await identity.findIdentity(
          flow.ch === 'phone' ? 'phone' : 'email',
          flow.n,
        );
        if (identityRow) {
          await identity.markVerified(identityRow.id, flow.ch === 'phone' ? 'sms' : 'email_code');
        }
      }
    }

    // ------------------------------------------------------------------
    // Signed in
    // ------------------------------------------------------------------

    const known = await sessions.recogniseDevice(req, res);
    let deviceId = known && !known.reuseDetected ? known.id : null;

    if (flow.m && !deviceId) {
      deviceId = await sessions.rememberDevice({ userId, req, res });
    }

    const session = await sessions.create({
      userId,
      amr,
      acr: 'aal1',
      remembered: Boolean(flow.m),
      deviceId,
      ip: req.clientIp,
      userAgent: req.userAgent,
    });

    sessions.setCookie(res, session.token, Boolean(flow.m));
    clearFlow(res);

    await events.recordLogin({
      userId,
      sessionId: session.id,
      method,
      outcome: 'success',
      identifier: flow.n,
      ip: req.clientIp,
      userAgent: req.userAgent,
      deviceId,
    });

    return res.redirect(303, flow.r || '/account');
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// Resend
// ---------------------------------------------------------------------------

router.post('/login/resend', csrf.verify, async (req, res, next) => {
  try {
    const flow = readFlow(req);
    if (!flow) return res.redirect(303, '/login');

    /*
     * `force` — this is the person explicitly asking for another code, so it
     * must actually send one. Everywhere else a repeat within a couple of
     * minutes reuses the code already in flight (see challenges.create), which
     * is what stops a back-button or a double click from replacing a code
     * somebody is halfway through typing.
     */
    const result = await challenges.create({
      channel: flow.ch === 'phone' ? 'sms' : 'email',
      purpose: flow.u ? 'login' : 'register',
      destination: flow.d,
      destinationNorm: flow.n,
      userId: flow.u,
      ip: req.clientIp,
      userAgent: req.userAgent,
      force: true,
    });

    // The new challenge replaces the old one in the flow — the previous code was
    // revoked by `create`, so keeping its id would leave the page checking
    // against a code that can no longer succeed.
    if (result.ok) {
      setFlow(res, JSON.stringify({ ...flow, c: result.challengeId }));
    }

    return res.redirect(303, '/login/verify');
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// Out
// ---------------------------------------------------------------------------

router.post('/logout', csrf.verify, async (req, res, next) => {
  try {
    const session = await sessions.load(req);
    if (session) {
      await sessions.revoke(session.id, 'logout');
      /*
       * The audit log, NOT login_events.
       *
       * A logout is not an attempt to get in, and writing it as one corrupts
       * the only numbers the analytics panel has: recorded as a successful
       * `password` event it inflates password sign-ins, which is precisely the
       * figure used to judge whether people are moving to passkeys. A log that
       * is quietly wrong is worse than no log, because decisions get made from
       * it.
       */
      await events.recordAudit({
        actorUserId: session.user_id,
        action: 'session.logout',
        targetType: 'session',
        targetId: session.public_id,
        ip: req.clientIp,
        userAgent: req.userAgent,
      });
    }
    sessions.clearCookie(res);
    clearFlow(res);
    return res.redirect(303, '/login');
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
