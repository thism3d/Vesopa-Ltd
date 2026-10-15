/**
 * The second step, in both places it is needed.
 *
 *   FINISHING A SIGN-IN. Somebody has proved one thing — a code, a password, a
 *   provider — and holds an authenticator or a passkey. They are not signed in
 *   yet; they are mid-way, and this is where they finish.
 *
 *   RAISING A LIVE SESSION. An application asked for `acr_values=aal2` for one
 *   action. The person stays signed in and is asked only for the factor they
 *   are missing. Logging them out and back in would be simpler to write and is
 *   how people learn to hate a security feature.
 *
 * THE PENDING STATE IS SIGNED, and that is not decoration. It carries "this
 * browser has already passed the first factor as user 47". A cookie that merely
 * said so could be typed by hand, and then somebody holding a stolen
 * authenticator code — or a recovery code found on a desk — could sign in
 * without ever knowing the password or receiving the emailed code. An HMAC over
 * the payload means the server only believes states it issued itself.
 */

const crypto = require('crypto');
const express = require('express');

const config = require('../config');
const db = require('../db');
const sessions = require('../sessions');
const recent = require('../recent');
const identity = require('../identity');
const events = require('../events');
const csrf = require('../csrf');
const factors = require('../factors');
const challenges = require('../challenges');
const rateLimit = require('../ratelimit');
const { verifyTotp, decrypt, verifyPassword } = require('../crypto');
const { checkPasskey } = require('./mfa');

const router = express.Router();

const PENDING_COOKIE = config.isProduction ? '__Host-vesopa_pending' : 'vesopa_pending';
const PENDING_MINUTES = 10;

// ---------------------------------------------------------------------------
// The signed pending state
// ---------------------------------------------------------------------------

function signState(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const mac = crypto
    .createHmac('sha256', config.secrets.codePepper)
    .update(body)
    .digest('base64url');
  return `${body}.${mac}`;
}

function readState(raw) {
  if (!raw || !raw.includes('.')) return null;
  const [body, mac] = raw.split('.', 2);
  const expected = crypto
    .createHmac('sha256', config.secrets.codePepper)
    .update(body)
    .digest('base64url');

  // Constant time, and length-checked first so timingSafeEqual cannot throw.
  const a = Buffer.from(mac || '', 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  try {
    const state = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!state.u || !state.exp || state.exp < Date.now()) return null;
    return state;
  } catch {
    return null;
  }
}

function setPending(res, state) {
  res.cookie(PENDING_COOKIE, signState({ ...state, exp: Date.now() + PENDING_MINUTES * 60000 }), {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: 'lax',
    path: '/',
    maxAge: PENDING_MINUTES * 60000,
  });
}

function clearPending(res) {
  res.clearCookie(PENDING_COOKIE, {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: 'lax',
    path: '/',
  });
}

// ---------------------------------------------------------------------------
// Checking a second factor
// ---------------------------------------------------------------------------

/**
 * Try whatever was submitted against whatever they hold.
 *
 * Returns `{ ok, method }` or `{ ok: false, error }`. One function for both
 * flows, so the sign-in path and the step-up path cannot drift apart — which
 * they would, and the weaker of the two would be the one nobody noticed.
 */
async function checkSecondFactor(userId, body, { ip = '', first = [] } = {}) {
  // One limit across every kind of second factor. Separate counters would let
  // somebody spend five guesses on the authenticator and five more on the
  // recovery codes.
  const attempt = await rateLimit.hit('second-factor', String(userId), {
    limit: 8,
    windowSeconds: 900,
  });
  if (!attempt.allowed) {
    return { ok: false, error: 'Too many attempts. Please wait fifteen minutes.' };
  }

  const code = String(body.code || '').trim();

  // --- an authenticator app -------------------------------------------
  if (body.method === 'totp') {
    const row = await db.one(
      'SELECT * FROM user_totp WHERE user_id = ? AND confirmed_at IS NOT NULL AND revoked_at IS NULL',
      [userId],
    );
    if (!row) return { ok: false, error: 'There is no authenticator app on this account.' };

    const secret = decrypt(row.secret_cipher, config.secrets.encryptionKey);
    const step = verifyTotp(secret, code, { window: 1, after: row.last_step });
    if (step === null) {
      return { ok: false, error: 'That code is not right. They change every 30 seconds — try the current one.' };
    }
    // The spent step is recorded, so the same six digits read over a shoulder
    // do not work again for the rest of the window.
    await db.execute('UPDATE user_totp SET last_step = ?, last_used_at = NOW() WHERE id = ?', [
      step,
      row.id,
    ]);
    await rateLimit.clear('second-factor', String(userId));
    return { ok: true, method: 'totp' };
  }

  // --- a code we texted ------------------------------------------------
  if (body.method === 'sms') {
    /*
     * The challenge is found from the ACCOUNT, not from a hidden field.
     *
     * Passing the id through the form would mean trusting the browser to say
     * which challenge is being answered — and a challenge id raised for one
     * purpose could then be presented for another. Looking it up from the
     * number on the account is both simpler and narrower: the only code that
     * can be spent here is a step-up code, raised for this person, for the
     * phone we texted.
     */
    const phone = await db.one(
      `SELECT identifier_norm FROM user_identities
        WHERE user_id = ? AND type = 'phone' AND revoked_at IS NULL AND verified_at IS NOT NULL
        ORDER BY is_recovery, created_at LIMIT 1`,
      [userId],
    );
    if (!phone) return { ok: false, error: 'There is no number on this account we can text.' };

    const live = await challenges.findLive(phone.identifier_norm, 'step_up');
    if (!live) return { ok: false, error: 'Ask for a new code — that one has expired.' };

    const result = await challenges.verify({ challengeId: live.public_id, code, ip });
    if (!result.ok) {
      return { ok: false, error: 'That code is not right, or it has expired.' };
    }
    if (result.challenge.user_id !== userId) {
      return { ok: false, error: 'That code was not for this.' };
    }
    await rateLimit.clear('second-factor', String(userId));
    return { ok: true, method: 'sms2' };
  }

  // --- a code we emailed (2026-10-15) ------------------------------------
  // Only when the first step was not an emailed code: the same proof twice is
  // one proof.
  if (body.method === 'email') {
    if (first.includes('otp')) return { ok: false, error: 'You signed in with an emailed code, so use another way.' };
    const address = await emailOf(userId);
    if (!address) return { ok: false, error: 'There is no confirmed email address on this account.' };
    const live = await challenges.findLive(address.identifier_norm, 'step_up');
    if (!live) return { ok: false, error: 'Ask for a new code — that one has expired.' };
    const result = await challenges.verify({ challengeId: live.public_id, code, ip });
    if (!result.ok) return { ok: false, error: 'That code is not right, or it has expired.' };
    if (result.challenge.user_id !== userId) return { ok: false, error: 'That code was not for this.' };
    await rateLimit.clear('second-factor', String(userId));
    return { ok: true, method: 'email2' };
  }

  // --- the password (2026-10-15) ----------------------------------------
  // Only when the first step was not the password.
  if (body.method === 'password') {
    if (first.includes('pwd')) return { ok: false, error: 'You signed in with your password, so use another way.' };
    const stored = await db.one(
      'SELECT password_hash FROM user_passwords WHERE user_id = ? AND retired_at IS NULL LIMIT 1',
      [userId],
    );
    if (!stored) return { ok: false, error: 'There is no password on this account.' };
    const given = String(body.password || '');
    if (!given || !(await verifyPassword(stored.password_hash, given, config.secrets.passwordPepper))) {
      return { ok: false, error: 'That password is not right.' };
    }
    await rateLimit.clear('second-factor', String(userId));
    return { ok: true, method: 'pwd2' };
  }

  // --- a recovery code -------------------------------------------------
  if (body.method === 'recovery') {
    const cleaned = code.toUpperCase().replace(/\s/g, '');
    const unused = await db.query(
      'SELECT id, code_hash FROM user_recovery_codes WHERE user_id = ? AND used_at IS NULL',
      [userId],
    );
    for (const row of unused) {
      // eslint-disable-next-line no-await-in-loop
      if (await verifyPassword(row.code_hash, cleaned, config.secrets.passwordPepper)) {
        // Conditional, so the same code submitted twice in the same instant
        // cannot be spent twice.
        // eslint-disable-next-line no-await-in-loop
        const spent = await db.execute(
          'UPDATE user_recovery_codes SET used_at = NOW(), used_ip = ? WHERE id = ? AND used_at IS NULL',
          [String(ip).slice(0, 45), row.id],
        );
        if (spent.affectedRows !== 1) break;
        await rateLimit.clear('second-factor', String(userId));
        return { ok: true, method: 'recovery_code' };
      }
    }
    return { ok: false, error: 'That recovery code is not right, or it has already been used.' };
  }

  return { ok: false, error: 'Choose how you would like to prove it is you.' };
}

// ---------------------------------------------------------------------------
// Finishing a sign-in
// ---------------------------------------------------------------------------

/** The confirmed email address on an account, or null. */
async function emailOf(userId) {
  return db.one(
    `SELECT identifier, identifier_norm FROM user_identities
      WHERE user_id = ? AND type = 'email' AND revoked_at IS NULL AND verified_at IS NOT NULL
      ORDER BY is_recovery, created_at LIMIT 1`,
    [userId],
  );
}

/** What a session's first step was: its amr, as a list. */
function amrOf(session) {
  if (!session) return [];
  if (Array.isArray(session.amr)) return session.amr;
  try { return JSON.parse(session.amr || '[]'); } catch { return []; }
}

/**
 * The ways in beyond the enrolled factors (the owner, 2026-10-15: "options to
 * verify using other steps like again OTP verify and maybe passwords"): an
 * emailed code when the first step was not one, the password when the first
 * step was not the password, and the passkey the account already has.
 */
async function otherWays(userId, first) {
  const address = first.includes('otp') ? null : await emailOf(userId);
  const password = first.includes('pwd')
    ? null
    : await db.one('SELECT id FROM user_passwords WHERE user_id = ? AND retired_at IS NULL LIMIT 1', [userId]);
  return {
    email: address ? `${String(address.identifier).slice(0, 2)}•••@${String(address.identifier).split('@')[1] || ''}` : '',
    password: Boolean(password),
  };
}

async function renderChallenge(res, { userId, state, error = '', mode, returnTo = '', first = null, sent = '' }) {
  const held = await factors.enrolled(userId, { firstFactorPhone: state && state.p });
  const person = await identity.getUser(userId);
  const alt = await otherWays(userId, first || (state && state.a) || []);

  return res.render('second-factor', {
    title: 'One more step',
    nonce: res.locals.nonce,
    config,
    held,
    mode,
    returnTo,
    error,
    // The number is shown last-three-digits only. Somebody who has borrowed a
    // signed-in laptop should not be handed the owner's phone number.
    phoneHint: held.sms ? `•••${String(held.sms.identifier).slice(-3)}` : '',
    displayName: person ? person.display_name : '',
    alt,
    sent,
    noindex: true,
  });
}

router.get('/login/second', async (req, res, next) => {
  try {
    const state = readState(req.cookies ? req.cookies[PENDING_COOKIE] : null);
    if (!state) return res.redirect(303, '/login');
    return await renderChallenge(res, { userId: state.u, state, mode: 'sign-in', returnTo: state.r || '' });
  } catch (error) {
    return next(error);
  }
});

/** Text a code to the number on the account. */
router.post('/login/second/sms', csrf.verify, async (req, res, next) => {
  try {
    const state = readState(req.cookies ? req.cookies[PENDING_COOKIE] : null);
    if (!state) return res.redirect(303, '/login');

    const held = await factors.enrolled(state.u, { firstFactorPhone: state.p });
    if (!held.sms) {
      return await renderChallenge(res, {
        userId: state.u,
        state,
        mode: 'sign-in',
        returnTo: state.r || '',
        error: 'There is no number on this account we can text.',
      });
    }

    const sent = await challenges.create({
      channel: 'sms',
      purpose: 'step_up',
      destination: held.sms.identifier,
      destinationNorm: held.sms.identifier_norm,
      userId: state.u,
      ip: req.clientIp,
      userAgent: req.userAgent,
      force: true,
    });

    return await renderChallenge(res, {
      userId: state.u,
      state,
      mode: 'sign-in',
      returnTo: state.r || '',
      error: sent.ok ? '' : 'We could not send that text. Try your authenticator app instead.',
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/login/second', csrf.verify, async (req, res, next) => {
  try {
    const state = readState(req.cookies ? req.cookies[PENDING_COOKIE] : null);
    if (!state) return res.redirect(303, '/login');

    const result = await checkSecondFactor(state.u, req.body, { ip: req.clientIp, first: state.a || [] });
    if (!result.ok) {
      await events.recordLogin({
        userId: state.u,
        method: req.body.method === 'totp' ? 'totp' : req.body.method === 'recovery' ? 'recovery_code' : 'sms_otp',
        outcome: 'failure',
        failureReason: 'second_factor',
        ip: req.clientIp,
        userAgent: req.userAgent,
      });
      return await renderChallenge(res, {
        userId: state.u,
        state,
        mode: 'sign-in',
        returnTo: state.r || '',
        error: result.error,
      });
    }

    // ------------------------------------------------------------------
    // Both factors are in. NOW they are signed in.
    // ------------------------------------------------------------------
    const amr = (state.a || []).concat([result.method]);
    const known = await sessions.recogniseDevice(req, res);
    let deviceId = known && !known.reuseDetected ? known.id : null;

    if (state.m && !deviceId) {
      deviceId = await sessions.rememberDevice({ userId: state.u, req, res });
    }

    /*
     * A remembered device is trusted to skip the SECOND factor next time, and
     * the trust is granted here — after it was actually used, not when the box
     * was ticked. Ticking a box is not evidence of anything.
     */
    if (deviceId) {
      await db.execute(
        'UPDATE devices SET trusted_until = DATE_ADD(NOW(), INTERVAL ? DAY) WHERE id = ?',
        [config.session.deviceTrustDays, deviceId],
      );
    }

    const session = await sessions.create({
      userId: state.u,
      amr,
      acr: factors.acrFor(amr),
      remembered: Boolean(state.m),
      deviceId,
      ip: req.clientIp,
      userAgent: req.userAgent,
    });
    sessions.setCookie(res, session.token, Boolean(state.m));
    await recent.rememberUser(req, res, state.u);
    clearPending(res);

    await events.recordLogin({
      userId: state.u,
      sessionId: session.id,
      method: result.method === 'recovery_code' ? 'recovery_code' : result.method === 'sms2' ? 'sms_otp' : 'totp',
      outcome: 'success',
      ip: req.clientIp,
      userAgent: req.userAgent,
      deviceId,
    });

    /*
     * A recovery code is a warning, not merely a sign-in. Somebody using one
     * has lost their usual factor, and the account is now one code closer to
     * having none — so they are told, and the count is on the security page.
     */
    if (result.method === 'recovery_code') {
      await events.recordAudit({
        actorUserId: state.u,
        action: 'mfa.recovery_code_used',
        targetType: 'user',
        targetId: String(state.u),
        ip: req.clientIp,
      });
    }

    return res.redirect(303, state.r || '/account/profile');
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// Raising a session that already exists
// ---------------------------------------------------------------------------

router.get('/step-up', async (req, res, next) => {
  try {
    const session = await sessions.load(req);
    if (!session) {
      return res.redirect(303, `/login?return_to=${encodeURIComponent(req.originalUrl)}`);
    }
    const returnTo = String(req.query.return_to || '').startsWith('/') ? req.query.return_to : '/account/profile';
    return await renderChallenge(res, { userId: session.user_id, state: null, mode: 'step-up', returnTo, first: amrOf(session) });
  } catch (error) {
    return next(error);
  }
});

router.post('/step-up/sms', csrf.verify, async (req, res, next) => {
  try {
    const session = await sessions.load(req);
    if (!session) return res.redirect(303, '/login');

    const held = await factors.enrolled(session.user_id);
    if (held.sms) {
      await challenges.create({
        channel: 'sms',
        purpose: 'step_up',
        destination: held.sms.identifier,
        destinationNorm: held.sms.identifier_norm,
        userId: session.user_id,
        ip: req.clientIp,
        userAgent: req.userAgent,
        force: true,
      });
    }
    return await renderChallenge(res, {
      userId: session.user_id,
      state: null,
      mode: 'step-up',
      returnTo: String(req.body.return_to || '/account/profile'),
      error: held.sms ? '' : 'There is no number on this account we can text.',
      first: amrOf(session),
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/step-up', csrf.verify, async (req, res, next) => {
  try {
    const session = await sessions.load(req);
    if (!session) return res.redirect(303, '/login');

    const returnTo = String(req.body.return_to || '').startsWith('/')
      ? req.body.return_to
      : '/account/profile';

    const result = await checkSecondFactor(session.user_id, req.body, { ip: req.clientIp, first: amrOf(session) });
    if (!result.ok) {
      return await renderChallenge(res, {
        userId: session.user_id,
        state: null,
        mode: 'step-up',
        returnTo,
        error: result.error,
        first: amrOf(session),
      });
    }

    /*
     * The session is RAISED, not replaced. They stay signed in, everything they
     * had open still works, and the applications holding tokens are unaffected
     * until those tokens are next refreshed — which is the entire point of
     * step-up existing.
     */
    const amr = Array.isArray(session.amr)
      ? session.amr
      : JSON.parse(session.amr || '[]');
    const raised = amr.concat([result.method]);
    await sessions.raiseAssurance(session.id, raised, factors.acrFor(raised));

    await events.recordLogin({
      userId: session.user_id,
      sessionId: session.id,
      method: result.method === 'recovery_code' ? 'recovery_code' : result.method === 'sms2' ? 'sms_otp' : 'totp',
      outcome: 'success',
      failureReason: 'step_up',
      ip: req.clientIp,
      userAgent: req.userAgent,
    });

    return res.redirect(303, returnTo);
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// An emailed code, and a passkey, as the second step (2026-10-15)
// ---------------------------------------------------------------------------

async function sendEmailCode(req, userId) {
  const address = await emailOf(userId);
  if (!address) return false;
  const sent = await challenges.create({
    channel: 'email',
    purpose: 'step_up',
    destination: address.identifier,
    destinationNorm: address.identifier_norm,
    userId,
    ip: req.clientIp,
    userAgent: req.userAgent,
    force: true,
  });
  return Boolean(sent && sent.ok !== false);
}

router.post('/login/second/email', csrf.verify, async (req, res, next) => {
  try {
    const state = readState(req.cookies ? req.cookies[PENDING_COOKIE] : null);
    if (!state) return res.redirect(303, '/login');
    const ok = !(state.a || []).includes('otp') && await sendEmailCode(req, state.u);
    return await renderChallenge(res, {
      userId: state.u, state, mode: 'sign-in', returnTo: state.r || '',
      error: ok ? '' : 'We could not send that email. Try another way.', sent: ok ? 'email' : '',
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/step-up/email', csrf.verify, async (req, res, next) => {
  try {
    const session = await sessions.load(req);
    if (!session) return res.redirect(303, '/login');
    const first = amrOf(session);
    const ok = !first.includes('otp') && await sendEmailCode(req, session.user_id);
    return await renderChallenge(res, {
      userId: session.user_id, state: null, mode: 'step-up',
      returnTo: String(req.body.return_to || '/account/profile'),
      error: ok ? '' : 'We could not send that email. Try another way.', sent: ok ? 'email' : '', first,
    });
  } catch (error) {
    return next(error);
  }
});

/**
 * A passkey as the second step. The browser runs the same ceremony as
 * passkey sign-in; this checks the passkey belongs to the person mid-sign-in
 * (or signed in), then finishes the sign-in or raises the session, exactly as
 * a correct code does. JSON in and out, for public/js/second-passkey.js.
 */
router.post('/second/passkey', async (req, res, next) => {
  try {
    const mode = req.body && req.body.mode === 'step-up' ? 'step-up' : 'sign-in';
    let userId = null;
    let state = null;
    let session = null;
    if (mode === 'sign-in') {
      state = readState(req.cookies ? req.cookies[PENDING_COOKIE] : null);
      if (!state) return res.status(401).json({ message: 'That sign-in has expired. Start again.', redirect: '/login' });
      userId = state.u;
    } else {
      session = await sessions.load(req);
      if (!session) return res.status(401).json({ message: 'Please sign in again.', redirect: '/login' });
      userId = session.user_id;
    }

    const attempt = await rateLimit.hit('second-factor', String(userId), { limit: 8, windowSeconds: 900 });
    if (!attempt.allowed) return res.status(429).json({ message: 'Too many attempts. Please wait fifteen minutes.' });

    const checked = await checkPasskey(req, req.body || {});
    if (checked.error) return res.status(checked.status || 400).json({ message: 'That passkey could not be used. Try again.' });
    if (Number(checked.stored.user_id) !== Number(userId)) {
      return res.status(403).json({ message: 'That passkey belongs to a different account.' });
    }
    await rateLimit.clear('second-factor', String(userId));

    if (mode === 'step-up') {
      const raised = amrOf(session).concat(['webauthn']);
      await sessions.raiseAssurance(session.id, raised, factors.acrFor(raised));
      await events.recordLogin({
        userId, sessionId: session.id, method: 'passkey', outcome: 'success', failureReason: 'step_up',
        ip: req.clientIp, userAgent: req.userAgent,
      });
      const back = String(req.body.return_to || '');
      return res.json({ ok: true, redirect: back.startsWith('/') ? back : '/account/profile' });
    }

    // Finishing a sign-in: the same as the code path in POST /login/second.
    const amr = (state.a || []).concat(['webauthn']);
    const known = await sessions.recogniseDevice(req, res);
    let deviceId = known && !known.reuseDetected ? known.id : null;
    if (state.m && !deviceId) deviceId = await sessions.rememberDevice({ userId, req, res });
    if (deviceId) {
      await db.execute(
        'UPDATE devices SET trusted_until = DATE_ADD(NOW(), INTERVAL ? DAY) WHERE id = ?',
        [config.session.deviceTrustDays, deviceId],
      );
    }
    const created = await sessions.create({
      userId, amr, acr: factors.acrFor(amr), remembered: Boolean(state.m), deviceId,
      ip: req.clientIp, userAgent: req.userAgent,
    });
    sessions.setCookie(res, created.token, Boolean(state.m));
    await recent.rememberUser(req, res, userId);
    clearPending(res);
    await events.recordLogin({
      userId, sessionId: created.id, method: 'passkey', outcome: 'success',
      ip: req.clientIp, userAgent: req.userAgent, deviceId,
    });
    return res.json({ ok: true, redirect: state.r || '/account/profile' });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
module.exports.setPending = setPending;
/*
 * Shared with the "confirm it is you" gate, which needs exactly this check for
 * an authenticator or a recovery code. Copying it there would mean two rate
 * limits on one thing, and the day one of them was tightened the other would
 * quietly still be the loose one.
 */
module.exports.checkSecondFactor = checkSecondFactor;
module.exports.clearPending = clearPending;
module.exports.readState = readState;
module.exports.PENDING_COOKIE = PENDING_COOKIE;
