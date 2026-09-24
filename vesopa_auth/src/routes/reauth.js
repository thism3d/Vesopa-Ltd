/**
 * "Confirm it is you", the page.
 *
 * The reasoning for why this exists at all is in src/reauth.js. This is the
 * form: whichever proofs the person actually holds, offered together, on one
 * screen, so nobody is sent away to enrol something before they can set a
 * recovery address.
 *
 * THE ORDER IS THE STRENGTH ORDER, and the emailed code is last on purpose. It
 * is the one everybody can do, and it is also the weakest of the three for
 * somebody who has already got into the mailbox — so it is offered, and it is
 * not what the page suggests first.
 */

const express = require('express');

const config = require('../config');
const db = require('../db');
const csrf = require('../csrf');
const sessions = require('../sessions');
const challenges = require('../challenges');
const events = require('../events');
const rateLimit = require('../ratelimit');
const reauth = require('../reauth');
const stepup = require('./stepup');
const { verifyPassword } = require('../crypto');

const router = express.Router();

/** Only a path on this site, and only ever inside the account area. */
function safeNext(value) {
  const raw = String(value || '');
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/account';
  return raw.slice(0, 400);
}

/** What this person can actually prove with. */
async function proofs(userId) {
  const [password, totp, address] = await Promise.all([
    db.one(
      `SELECT p.id FROM user_passwords p
         JOIN users u ON u.id = p.user_id
        WHERE p.user_id = ? AND p.retired_at IS NULL
          AND (u.password_paused_until IS NULL OR u.password_paused_until <= NOW())
        LIMIT 1`,
      [userId],
    ),
    db.one(
      'SELECT id FROM user_totp WHERE user_id = ? AND confirmed_at IS NOT NULL AND revoked_at IS NULL',
      [userId],
    ),
    /*
     * The address a code would go to — the primary one, and NOT a recovery-only
     * one. Using the recovery address to authorise changing the recovery
     * address would be a circle: whoever holds it could quietly move it
     * somewhere else and the real owner would never be asked.
     */
    db.one(
      `SELECT i.identifier, i.identifier_norm FROM user_identities i
        WHERE i.user_id = ? AND i.type = 'email' AND i.revoked_at IS NULL
          AND i.verified_at IS NOT NULL AND i.is_recovery = 0
        ORDER BY i.id LIMIT 1`,
      [userId],
    ),
  ]);
  return { password: Boolean(password), totp: Boolean(totp), address: address || null };
}

async function show(req, res, session, { error = '', sent = false } = {}) {
  const held = await proofs(session.user_id);
  return res.status(error ? 400 : 200).render('account/confirm', {
    title: 'Confirm it is you',
    nonce: res.locals.nonce,
    config,
    session,
    styles: ['console'],
    noindex: true,
    /*
     * `req.body` is UNDEFINED on a GET in Express 5 — the body parsers only
     * populate it for a request that actually has a body — so reading through
     * it unguarded is a 500 on the page's own first render. Found by
     * photographing the page, which is what photographing pages is for.
     */
    next: safeNext((req.query && req.query.next) || (req.body && req.body.next)),
    held,
    sent,
    error,
    minutes: config.codes.ttlMinutes,
  });
}

router.get('/account/confirm', async (req, res, next) => {
  try {
    const session = await sessions.load(req);
    if (!session) return res.redirect(303, `/login?return_to=${encodeURIComponent(req.originalUrl)}`);
    // Already proved. Nobody should be asked twice inside the window.
    if (reauth.fresh(session)) return res.redirect(303, safeNext(req.query && req.query.next));
    return await show(req, res, session);
  } catch (error) {
    return next(error);
  }
});

/** Send the emailed code. A separate route so the form's other proofs stay simple. */
router.post('/account/confirm/code', csrf.verify, async (req, res, next) => {
  try {
    const session = await sessions.load(req);
    if (!session) return res.redirect(303, '/login');

    const held = await proofs(session.user_id);
    if (!held.address) return await show(req, res, session, { error: 'There is no confirmed address on this account.' });

    await challenges.create({
      channel: 'email',
      purpose: 'step_up',
      destination: held.address.identifier,
      destinationNorm: held.address.identifier_norm,
      userId: session.user_id,
      ip: req.clientIp,
      userAgent: req.userAgent,
    });

    return await show(req, res, session, { sent: true });
  } catch (error) {
    return next(error);
  }
});

router.post('/account/confirm', csrf.verify, async (req, res, next) => {
  try {
    const session = await sessions.load(req);
    if (!session) return res.redirect(303, '/login');

    /*
     * Rate limited on the ACCOUNT, like every other guess on this site. This is
     * a password box and a code box on one page; leaving it uncounted would
     * make it the softest place on the site to grind either.
     */
    const attempt = await rateLimit.hit('reauth', String(session.user_id), {
      limit: 8,
      windowSeconds: 900,
    });
    if (!attempt.allowed) {
      return await show(req, res, session, {
        error: 'Too many attempts. Please wait fifteen minutes.',
      });
    }

    const method = String(req.body.method || '');
    let ok = false;
    let how = '';

    if (method === 'password') {
      const row = await db.one(
        `SELECT p.password_hash FROM user_passwords p
           JOIN users u ON u.id = p.user_id
          WHERE p.user_id = ? AND p.retired_at IS NULL
            AND (u.password_paused_until IS NULL OR u.password_paused_until <= NOW())
          ORDER BY p.id DESC LIMIT 1`,
        [session.user_id],
      );
      const given = String(req.body.password || '');
      ok = Boolean(
        row && given && (await verifyPassword(row.password_hash, given, config.secrets.passwordPepper)),
      );
      how = 'password';
      if (!ok) {
        return await show(req, res, session, { error: 'That password is not right.' });
      }
    } else if (method === 'totp' || method === 'recovery') {
      const result = await stepup.checkSecondFactor(session.user_id, req.body, { ip: req.clientIp });
      if (!result.ok) return await show(req, res, session, { error: result.error });
      ok = true;
      how = result.method;
    } else if (method === 'email') {
      const held = await proofs(session.user_id);
      if (!held.address) {
        return await show(req, res, session, { error: 'There is no confirmed address on this account.' });
      }
      const live = await challenges.findLive(held.address.identifier_norm, 'step_up');
      if (!live) {
        return await show(req, res, session, { error: 'Ask for a new code — that one has expired.' });
      }
      const result = await challenges.verify({
        challengeId: live.public_id,
        code: String(req.body.code || '').trim(),
        ip: req.clientIp,
      });
      if (!result.ok || result.challenge.user_id !== session.user_id) {
        return await show(req, res, session, { error: 'That code is not right, or it has expired.' });
      }
      ok = true;
      how = 'email_code';
    } else {
      return await show(req, res, session, { error: 'Choose how you would like to prove it is you.' });
    }

    if (!ok) return await show(req, res, session, { error: 'That did not work. Please try again.' });

    await rateLimit.clear('reauth', String(session.user_id));
    await reauth.mark(session.id);

    await events.recordAudit({
      actorUserId: session.user_id,
      action: 'account.reconfirmed',
      targetType: 'session',
      targetId: session.public_id,
      detail: { how },
      ip: req.clientIp,
      userAgent: req.userAgent,
    });

    return res.redirect(303, safeNext(req.body && req.body.next));
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
