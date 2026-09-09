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
const recovery = require('../recovery');
const stepup = require('./stepup');
const factors = require('../factors');
const authmethods = require('../authmethods');
const captcha = require('../captcha');
const accounts = require('../accounts');
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
  /*
   * The same context the GET builds. Without it this render would show the
   * default buttons rather than the application's — so a failed attempt would
   * quietly offer more ways in than the successful page did, which is both
   * confusing and a way to reach a method an application deliberately turned
   * off.
   */
  const context = await authmethods.contextFor(returnTo, live.auth_policy_default);
  return res.status(400).render('login', {
    title: 'Sign in to Vesopa',
    description: 'One Vesopa account for every Vesopa product.',
    nonce: res.locals.nonce,
    config,
    mode,
    channel,
    providers: context.shape.providers,
    methods: context.shape,
    application: context.application,
    policy: context.policy,
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

    let existing = await identity.findIdentity(channel === 'email' ? 'email' : 'phone', normalised);

    /*
     * NOBODY GETS TWO ACCOUNTS FOR ONE ADDRESS.
     *
     * If no identity of our own holds this address, an account may still hold
     * it as an address a provider verified — the state left behind by signing
     * in with GitHub, where the provider's own row carries the address and
     * there is no separate email row. Without this line the person types the
     * address they just signed in with, and gets a brand-new empty account.
     *
     * It only decides WHOSE code this is. The code still has to be received and
     * typed, and the identity is only attached at that point — see the note in
     * POST /login/verify.
     */
    if (!existing && channel === 'email') {
      existing = await identity.findByAssertedEmail(normalised);
    }

    /*
     * A suspended account is told the same thing as everyone else and simply
     * never receives a code. Saying "your account is suspended" on a public form
     * confirms the address exists and tells whoever is probing something about
     * the person that is none of their business.
     */
    const suspended = existing && existing.user_status !== 'active';

    /*
     * IS THIS A PERSON? reCAPTCHA v3 answers with a probability, not a verdict.
     *
     * A hard failure — a token that did not come from our form — is refused. A
     * LOW SCORE IS NOT: it removes the password fast path and asks for an
     * emailed code, which the account's owner can answer and a script cannot.
     * Refusing on a score would lock real people out of their own accounts on a
     * shared office address or a VPN, which is a worse outcome than the one
     * being defended against. See src/captcha.js.
     */
    const verdict = await captcha.assess(req.body.captcha_token, 'signin', req.clientIp);
    if (!verdict.ok) {
      await events.recordLogin({
        userId: existing ? existing.user_id : null,
        method: 'email_code',
        outcome: 'blocked',
        failureReason: `captcha_${String(verdict.reason).slice(0, 40)}`,
        identifier: normalised,
        ip: req.clientIp,
        userAgent: req.userAgent,
      });
      return await backToLogin(res, {
        error: 'Something went wrong checking that request. Please try again.',
        mode,
        channel,
        identifier: typed,
        returnTo,
      });
    }

    /*
     * Does this person have a password, and does this application lead with it?
     *
     * Resolved BEFORE any code is sent, which is the whole point of the change:
     * asking for a password and emailing a code are alternatives, and the old
     * order sent a code to everybody whether or not they were ever going to
     * look at it.
     *
     * A paused account is treated as having no password. The pause is enforced
     * on the POST regardless — this only stops the page offering a box that is
     * going to refuse whatever is typed into it, which is a small cruelty to
     * somebody who has already been locked out once.
     */
    const hasPassword = existing
      ? Boolean(
          await db.one(
            `SELECT p.id FROM user_passwords p
               JOIN users u ON u.id = p.user_id
              WHERE p.user_id = ? AND p.retired_at IS NULL
                AND (u.password_paused_until IS NULL OR u.password_paused_until <= NOW())
              LIMIT 1`,
            [existing.user_id],
          ),
        )
      : false;

    const live = await settings.all();
    const context = await authmethods.contextFor(returnTo, live.auth_policy_default);
    const step = authmethods.firstStep({
      policy: context.policy,
      methods: context.methods,
      hasPassword,
    });

    /*
     * Why this person is about to be asked for a code rather than a password.
     *
     * Without this line the degrade is invisible: somebody reports "it never
     * asks for my password, it just emails me", and there is no way from
     * outside to tell whether the policy is wrong, they have no password, the
     * account is suspended, or reCAPTCHA scored them badly. All four look
     * identical on the page — deliberately, because saying which would tell an
     * attacker as much as it tells the owner. So it is said HERE instead.
     *
     * No address and no score-per-person beyond the number: this is an
     * operational breadcrumb, not a log of who signed in from where.
     */
    if (step === 'password' && (suspended || verdict.degrade)) {
      console.log(
        `[signin] password step skipped — ${suspended ? 'account suspended' : `captcha ${verdict.reason}` +
          (verdict.score === null ? '' : ` (score ${verdict.score})`)}`,
      );
    }

    if (step === 'password' && !suspended && !verdict.degrade) {
      /*
       * Straight to the password, with NO code sent and nothing said about
       * whether the address is known — the page after this one looks the same
       * either way to anybody who has not got the password.
       */
      setFlow(
        res,
        JSON.stringify({
          s: 'password',
          d: typed,
          n: normalised,
          ch: channel,
          p: true,
          r: returnTo,
          m: remember,
          u: existing.user_id,
        }),
      );
      return res.redirect(303, '/login/password');
    }

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


/**
 * One factor is down. Decide whether that is enough, and sign them in.
 *
 * SHARED BY EVERY FIRST FACTOR — an emailed code, a texted code, and now a
 * password. It was inline in the code path until the password step existed,
 * and duplicating it would have been the classic way to end up with a
 * second-factor check on one route and not the other: the security page would
 * say two-step verification was on, and for one way in it would not be.
 *
 * `flow` carries what the first factor established: the identifier (n), where
 * to go afterwards (r), whether to remember (m), and the channel (ch).
 */
async function completeSignIn({ req, res, userId, amr, method, flow }) {
    // ------------------------------------------------------------------
    // One factor down. Is that enough?
    // ------------------------------------------------------------------

    const known = await sessions.recogniseDevice(req, res);
    let deviceId = known && !known.reuseDetected ? known.id : null;

    /*
     * ASK FOR THE SECOND FACTOR, IF THEY HAVE ONE.
     *
     * Until this existed, enrolling an authenticator changed nothing: sign-in
     * finished on the first factor and the session was recorded as `aal1`
     * regardless. The security page said two-step verification was on, and it
     * was not — which is the worst kind of security feature, one that is
     * believed.
     *
     * A remembered device may skip this, and only this. It never skips the
     * first factor: the device cookie proves which machine this is, not who is
     * sitting at it.
     */
    const held = await factors.enrolled(userId, {
      firstFactorPhone: flow.ch === 'phone' ? flow.n : null,
    });

    if (held.any && !factors.deviceMaySkip(known)) {
      stepup.setPending(res, {
        u: userId,
        a: amr,
        r: flow.r || '',
        m: Boolean(flow.m),
        // What the first factor was, so a code to the same phone is not
        // offered as the second — that would be one proof counted twice.
        p: flow.ch === 'phone' ? flow.n : null,
      });
      clearFlow(res);

      await events.recordLogin({
        userId,
        method,
        outcome: 'challenge',
        failureReason: 'second_factor_required',
        identifier: flow.n,
        ip: req.clientIp,
        userAgent: req.userAgent,
      });

      return res.redirect(303, '/login/second');
    }

    // ------------------------------------------------------------------
    // Signed in
    // ------------------------------------------------------------------

    if (flow.m && !deviceId) {
      deviceId = await sessions.rememberDevice({ userId, req, res });
    }

    const session = await sessions.create({
      userId,
      amr,
      // A remembered device that skipped the second factor is still recorded
      // as having met the bar — that is what being trusted means — so the
      // assurance reflects what the person actually holds.
      acr: held.any ? 'aal2' : 'aal1',
      remembered: Boolean(flow.m),
      deviceId,
      ip: req.clientIp,
      userAgent: req.userAgent,
    });

    sessions.setCookie(res, session.token, Boolean(flow.m));

    /*
     * THE NEW SESSION JOINS THE OTHERS RATHER THAN EVICTING THEM.
     *
     * `accounts.add` puts this token at the front of the roster and keeps
     * whatever was already there, so signing in as a second account leaves the
     * first one signed in — which is the whole feature. It is done on EVERY
     * sign-in, not only when `add=1` was asked for, because the roster is
     * simply the list of sessions this browser holds and a session that is not
     * in it is one the chooser cannot offer.
     *
     * The list is read first so that a dead entry — an account signed out on
     * another device — is pruned in the same write rather than lingering.
     */
    accounts.add(res, await accounts.list(req, null), session.token);

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
  }

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

      /*
       * A PASSWORD ALONE WILL NOT DO, FOR A DAY AFTER SOMEBODY WAS HELPED BACK
       * IN.
       *
       * This is the control that keeps administrator-assisted recovery from
       * becoming the easiest way into an account. The attack it survives is not
       * technical: somebody telephones, says they have lost their phone, is
       * convincing, and support removes their second factor. If a stolen
       * password worked immediately afterwards, the reset would have handed the
       * account over.
       *
       * With the password paused, whoever asked must now prove they can RECEIVE
       * at the address or number on the account — exactly what an attacker with
       * only a password cannot do, and exactly what the real owner does in ten
       * seconds. The code they need has already been sent; they simply use it
       * instead.
       */
      const account = await db.one('SELECT password_paused_until FROM users WHERE id = ?', [userId]);
      if (recovery.passwordPaused(account)) {
        await events.recordLogin({
          userId,
          method: 'password',
          outcome: 'blocked',
          failureReason: 'password_paused',
          identifier: flow.n,
          ip: req.clientIp,
          userAgent: req.userAgent,
        });
        return showAgain(
          'Your account was recently recovered, so a password on its own is not enough for now. ' +
            'Use the code we sent you instead.',
        );
      }

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

        /*
         * Asked again, here, rather than trusted from the flow cookie. The
         * cookie was written before the code was sent, and an account can be
         * created in between — by the person themselves in another tab, or by
         * a provider sign-in that finished first. Making a second account for
         * an address somebody has just proved is the exact fault this is for.
         */
        const held = type === 'email' ? await identity.findByAssertedEmail(flow.n) : null;
        if (held) {
          userId = held.user_id;
          try {
            await identity.attachIdentity(userId, {
              type: 'email',
              identifier: flow.d,
              normalised: flow.n,
              verified: true,
              verifiedVia: 'email_code',
            });
          } catch (error) {
            if (!db.isDuplicate(error)) throw error;
          }
          return completeSignIn({ req, res, userId, amr, method, flow });
        }

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
        const type = flow.ch === 'phone' ? 'phone' : 'email';
        identityRow = await identity.findIdentity(type, flow.n);

        if (identityRow) {
          await identity.markVerified(identityRow.id, type === 'phone' ? 'sms' : 'email_code');
        } else if (type === 'email') {
          /*
           * ADOPTION. The account was found by the address a provider asserted
           * (see POST /login), so it has no email identity of its own yet — and
           * the person has just proved, this minute, that they receive there.
           *
           * Attaching it now is what stops the same discovery having to be made
           * on every future sign-in, and is what makes the address appear under
           * "How you sign in" where the person can see and remove it. The
           * proof for it is genuinely two-sided: the provider verified the
           * address, and so did we, independently.
           *
           * A duplicate means somebody else took the address in the seconds
           * since the code was sent. The sign-in still succeeds — this person
           * is who the account says they are — and the address simply stays
           * unattached rather than the whole thing failing.
           */
          try {
            await identity.attachIdentity(userId, {
              type: 'email',
              identifier: flow.d,
              normalised: flow.n,
              verified: true,
              verifiedVia: 'email_code',
            });
            await events.recordAudit({
              actorUserId: userId,
              action: 'identity.adopted',
              targetType: 'identity',
              targetId: 'email',
              detail: { why: 'a provider had already verified this address for this account' },
              ip: req.clientIp,
              userAgent: req.userAgent,
            });
          } catch (error) {
            if (!db.isDuplicate(error)) throw error;
          }
        }
      }
    }

    return completeSignIn({ req, res, userId, amr, method, flow });
  } catch (error) {
    return next(error);
  }
});

// ===========================================================================
// The password step
// ===========================================================================
//
// Reached only when the application's policy leads with a password AND the
// person actually has one. It is a separate page rather than a second field on
// the first one, for the reason the reference design shows: one thing on screen
// at a time, and the page can say WHO it is about to sign in — which on a
// shared machine is the difference between signing in and three wrong attempts
// against somebody else's account.

/** Everything the password page needs, from the flow cookie. */
async function passwordPage(req, res, error = '') {
  const flow = readFlow(req);
  if (!flow || flow.s !== 'password' || !flow.u) {
    res.redirect(303, '/login');
    return null;
  }

  const user = await db.one(
    'SELECT public_id, display_name, given_name, avatar_path FROM users WHERE id = ?',
    [flow.u],
  );
  const context = await authmethods.contextFor(flow.r || '');
  const name = (user && (user.given_name || user.display_name || '').trim()) || '';

  return res.status(error ? 400 : 200).render('password', {
    title: 'Enter your password',
    nonce: res.locals.nonce,
    config,
    // "Hi Muzahid" where we know a name, and a plain instruction where we do
    // not — an empty "Hi" reads as a bug, and "Hi there" reads as marketing.
    greeting: name ? `Hi ${name}` : 'Welcome back',
    destination: flow.d,
    initial: (name || flow.d || '?').trim().charAt(0).toUpperCase(),
    avatar: (user && user.avatar_path) || '',
    application: context.application,
    canPasskey: context.shape.passkey,
    returnTo: flow.r || '',
    remember: Boolean(flow.m),
    error,
    noindex: true,
  });
}

router.get('/login/password', async (req, res, next) => {
  try {
    return await passwordPage(req, res);
  } catch (error) {
    return next(error);
  }
});

router.post('/login/password', csrf.verify, async (req, res, next) => {
  try {
    const flow = readFlow(req);
    if (!flow || flow.s !== 'password' || !flow.u) return res.redirect(303, '/login');

    /*
     * RATE LIMITED PER ACCOUNT, not only per IP.
     *
     * A password box that is not is a password box somebody grinds. The limit
     * is on the account because that is what is being attacked — an attacker
     * with a list of addresses and a botnet defeats a per-IP limit by using a
     * different address each time, and a per-account one stops exactly the
     * thing they are trying to do.
     */
    /*
     * THE SAME BUCKET AND THE SAME SUBJECT as the password option on the
     * verify page, deliberately.
     *
     * There are two routes into a password check now, and giving them separate
     * counters would hand an attacker a second allowance for free: spend eight
     * guesses here, walk to the other page, spend eight more. Keyed on the
     * normalised identifier — which is what is being attacked — rather than on
     * the IP, because an attacker with a list of addresses and a botnet defeats
     * a per-IP limit by construction.
     */
    const limited = await rateLimit.hit('password', flow.n, {
      limit: 8,
      windowSeconds: 900,
    });
    // `allowed`, not `ok` — ratelimit.hit's shape. Checking the wrong property
    // made every attempt read as blocked, including the right password.
    if (!limited.allowed) {
      await events.recordLogin({
        userId: flow.u,
        method: 'password',
        outcome: 'blocked',
        failureReason: 'rate_limited',
        identifier: flow.n,
        ip: req.clientIp,
        userAgent: req.userAgent,
      });
      return await passwordPage(
        req,
        res,
        'Too many attempts. Wait a few minutes, or use a code instead.',
      );
    }

    const verdict = await captcha.assess(req.body.captcha_token, 'password', req.clientIp);
    if (!verdict.ok || verdict.degrade) {
      /*
       * The score dropped between the first page and this one, or the token
       * did not check out. Not refused — moved to a code, which is the same
       * account and a harder thing for a script to answer.
       */
      return await sendCodeForFlow(req, res, flow, 'We need to check it is you. Enter the code we just sent.');
    }

    const row = await db.one(
      `SELECT p.id, p.password_hash, p.algorithm
         FROM user_passwords p
         JOIN users u ON u.id = p.user_id
        WHERE p.user_id = ? AND p.retired_at IS NULL
          AND (u.password_paused_until IS NULL OR u.password_paused_until <= NOW())
        ORDER BY p.id DESC LIMIT 1`,
      [flow.u],
    );

    const given = String(req.body.password || '');
    const ok =
      row && given
        ? await verifyPassword(row.password_hash, given, config.secrets.passwordPepper)
        : false;

    if (!ok) {
      await events.recordLogin({
        userId: flow.u,
        method: 'password',
        outcome: 'failure',
        failureReason: 'wrong_password',
        identifier: flow.n,
        ip: req.clientIp,
        userAgent: req.userAgent,
      });
      /*
       * The same sentence whether the password was wrong or there was no
       * password row at all. Distinguishing them tells whoever is guessing
       * which accounts are worth more guesses.
       */
      return await passwordPage(req, res, 'That password is not right. Try again, or use a code.');
    }

    await rateLimit.clear('password', flow.n);

    return await completeSignIn({
      req,
      res,
      userId: flow.u,
      amr: ['pwd'],
      method: 'password',
      flow,
    });
  } catch (error) {
    return next(error);
  }
});

/**
 * Drop out of the password step and send a code instead.
 *
 * THE WAY OUT IS THE POINT. A password-first page with no escape is a locked
 * door for everybody who has forgotten theirs, and "forgot password" flows are
 * where account recovery goes wrong. Here the escape is the ordinary sign-in
 * path: prove you can receive at the address, exactly as if the password had
 * never been asked for.
 */
async function sendCodeForFlow(req, res, flow, notice) {
  const result = await challenges.create({
    channel: flow.ch === 'phone' ? 'sms' : 'email',
    purpose: 'login',
    destination: flow.d,
    destinationNorm: flow.n,
    userId: flow.u,
    ip: req.clientIp,
    userAgent: req.userAgent,
  });

  await events.recordLogin({
    userId: flow.u,
    method: flow.ch === 'phone' ? 'sms_otp' : 'email_code',
    outcome: 'challenge',
    identifier: flow.n,
    ip: req.clientIp,
    userAgent: req.userAgent,
  });

  setFlow(
    res,
    JSON.stringify({
      c: result.challengeId,
      d: flow.d,
      n: flow.n,
      ch: flow.ch,
      // Carried through, so the verify page can still offer "use my password"
      // to somebody who changed their mind on the way.
      p: true,
      r: flow.r || '',
      m: flow.m,
      u: flow.u,
    }),
  );
  return res.redirect(303, `/login/verify${notice ? '?notice=1' : ''}`);
}

router.post('/login/use-code', csrf.verify, async (req, res, next) => {
  try {
    const flow = readFlow(req);
    if (!flow || !flow.u) return res.redirect(303, '/login');
    return await sendCodeForFlow(req, res, flow);
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
    /*
     * ONE ACCOUNT LEAVES, NOT ALL OF THEM.
     *
     * This used to clear the session cookie and stop, which with a roster would
     * mean the browser still held tokens for accounts nobody could reach — a
     * chooser offering sessions and a person who believes they have signed out.
     * The account that was active is removed from the roster, and if another
     * one is left it becomes active. `/account/signout` is the same decision
     * with a name on it; this is the plain "Sign out" button.
     */
    const roster = await accounts.list(req, null);
    const active = roster.find((entry) => entry.active);
    const left = roster.filter((entry) => !entry.active);

    if (left.length) {
      accounts.write(res, left.map((entry) => entry.token));
      sessions.setCookie(res, left[0].token, Boolean(left[0].session.remembered));
    } else {
      sessions.clearCookie(res);
      accounts.clear(res);
    }
    void active;
    clearFlow(res);

    /*
     * "Use a different account" is a logout with somewhere to come back to.
     *
     * The consent screen's account chip posts here with the authorisation it
     * was in the middle of, so that signing out and signing in as somebody else
     * lands back on the same request rather than on an empty account page with
     * the application still waiting.
     *
     * A POST, and `safeReturnTo` — this is a same-site path or nothing. A
     * logout that redirects to wherever a query string says would be an open
     * redirect on the one origin where that matters most.
     */
    const back = safeReturnTo(req.body.return_to);
    if (left.length) {
      // Still signed in as somebody. Sending them to a sign-in page they do not
      // need is how "sign out of this one" reads as "sign out of everything".
      return res.redirect(303, back || '/account');
    }
    if (back) return res.redirect(303, `/login?return_to=${encodeURIComponent(back)}`);
    return res.redirect(303, '/login');
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
