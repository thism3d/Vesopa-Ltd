/**
 * One-time codes: making them, sending them, and checking them.
 *
 * Both channels come through here, and they work differently underneath:
 *
 *   email — we generate the code, store an HMAC of it under a server pepper,
 *           send it, and compare here.
 *   phone — Postcoder generates, sends AND checks it. We never see it. The row
 *           holds their reference instead of a hash, and verifying is a call
 *           out rather than a comparison.
 *
 * Callers do not care which. `create()` and `verify()` behave the same way for
 * both, which is what lets the login page treat the email/phone toggle as a
 * cosmetic choice.
 */

const config = require('./config');
const db = require('./db');
const sms = require('./sms');
const mailer = require('./mailer');
const rateLimit = require('./ratelimit');
const { newId, newNumericCode, hashCode, safeEqual } = require('./crypto');

const HOUR = 3600;

/**
 * Ask for a code.
 *
 * Returns `{ ok, challengeId, reason }`. On failure `reason` is for the log,
 * not for the person: see the note on enumeration below.
 */
/**
 * How long a live code is REUSED rather than replaced.
 *
 * The bug this fixes, reported from the live site: somebody asked for a code,
 * opened the privacy policy in the same tab, pressed Back — and was sent a
 * second code, which silently invalidated the first one they were about to
 * type. Any repeat of the same request does it: a double-clicked button, a
 * browser retrying after a dropped connection, a restored tab.
 *
 * Fighting the browser is the wrong answer; the request is legitimate and
 * arrives however careful the redirect handling is. So a repeat within this
 * window returns the code that is already in flight instead of minting a new
 * one. Nothing is sent, nothing is invalidated, and the code in the person's
 * inbox is still the right one.
 *
 * Two minutes: comfortably longer than a page load and a look at a policy page,
 * comfortably shorter than the ten-minute life of the code. Asking again after
 * that — or pressing "Send another code", which forces it — gets a fresh one,
 * because by then the honest reason is that the first never arrived.
 */
const REUSE_WINDOW_SECONDS = 120;

async function create({
  channel,
  purpose,
  destination,
  destinationNorm,
  userId = null,
  applicationId = null,
  ip = '',
  userAgent = '',
  force = false,
}) {
  /*
   * Reuse before rate limiting, and before anything is sent.
   *
   * Deliberately ahead of the rate limiter as well: a repeated request that
   * sends nothing must not spend the person's allowance either, or pressing
   * Back three times would lock them out of their own sign-in.
   */
  if (!force) {
    const live = await findLive(destinationNorm, purpose);
    if (live && Date.now() - new Date(live.created_at).getTime() < REUSE_WINDOW_SECONDS * 1000) {
      return {
        ok: true,
        challengeId: live.public_id,
        rowId: live.id,
        expiresAt: live.expires_at,
        reused: true,
      };
    }
  }

  // Two limits, protecting two different things. Per destination stops this
  // service being used to send a stranger forty messages, and stops one account
  // being hammered. Per IP stops one machine walking through a list.
  const perDestination = await rateLimit.hit(`code:${channel}`, destinationNorm, {
    limit: config.codes.maxSendsPerDestination,
    windowSeconds: HOUR,
  });
  if (!perDestination.allowed) {
    return { ok: false, reason: 'destination_rate_limited', retryAfter: perDestination.retryAfter };
  }

  const perIp = await rateLimit.hit('code:ip', ip || 'unknown', {
    limit: config.codes.maxSendsPerIp,
    windowSeconds: HOUR,
  });
  if (!perIp.allowed) {
    return { ok: false, reason: 'ip_rate_limited', retryAfter: perIp.retryAfter };
  }

  if (channel === 'sms' && !sms.canReach(destinationNorm)) {
    return { ok: false, reason: 'country_not_supported' };
  }

  const expiresAt = new Date(Date.now() + config.codes.ttlMinutes * 60 * 1000);
  const publicId = newId();

  /*
   * Asking for a new code retires the old one, and the database enforces it:
   * `uq_challenge_live` permits one live row per (destination, purpose). Two
   * codes valid at once is worse than it sounds — it doubles what a guesser
   * gets per send, and it produces the everyday confusion of somebody typing
   * the first code after the second has arrived and being told they are wrong.
   */
  await db.execute(
    `UPDATE verification_challenges
        SET revoked_at = NOW()
      WHERE destination_norm = ? AND purpose = ?
        AND consumed_at IS NULL AND revoked_at IS NULL`,
    [destinationNorm, purpose],
  );

  let codeHash = '';
  let externalRef = '';
  let plainCode = null;

  if (channel === 'sms') {
    const reference = await sms.provider().sendCode(destinationNorm, {
      minutes: config.codes.ttlMinutes,
      length: config.codes.length,
    });
    // No reference means nothing was sent. The person is waiting for a message,
    // so this must be a failure and never an optimistic success.
    if (!reference) return { ok: false, reason: 'sms_send_failed' };
    externalRef = reference;
  } else {
    plainCode = newNumericCode(config.codes.length);
    codeHash = hashCode(plainCode, config.secrets.codePepper);
  }

  const result = await db.execute(
    `INSERT INTO verification_challenges
       (public_id, purpose, channel, destination, destination_norm, user_id,
        application_id, code_hash, external_ref, max_attempts, ip, user_agent, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      publicId,
      purpose,
      channel,
      String(destination).slice(0, 255),
      destinationNorm,
      userId,
      applicationId,
      codeHash,
      externalRef,
      config.codes.maxAttempts,
      String(ip).slice(0, 45),
      String(userAgent).slice(0, 400),
      expiresAt,
    ],
  );

  if (channel === 'email') {
    try {
      await mailer.sendCode({
        to: destination,
        code: plainCode,
        purpose,
        minutes: config.codes.ttlMinutes,
      });
    } catch (error) {
      // The row stays: it is evidence that a send was attempted, and the sweep
      // will clear it. But the caller must know, because a person staring at a
      // form deserves "we could not send that" rather than silence.
      console.error('[challenges] email send failed:', error.message);
      return { ok: false, reason: 'email_send_failed', challengeId: publicId };
    }
  }

  return { ok: true, challengeId: publicId, rowId: result.insertId, expiresAt };
}

/**
 * Check a code.
 *
 * Returns `{ ok, challenge, reason }`.
 *
 * THE ATTEMPT IS COUNTED BEFORE THE COMPARISON, and that ordering is the whole
 * defence. Counting afterwards means an error thrown anywhere in between — a
 * dropped connection to the SMS gateway, say — leaves the attempt uncounted,
 * and a guesser who kills the request at the right moment has unlimited tries
 * at a six-digit number.
 */
async function verify({ challengeId, code, ip = '' }) {
  const challenge = await db.one(
    'SELECT * FROM verification_challenges WHERE public_id = ?',
    [challengeId],
  );
  if (!challenge) return { ok: false, reason: 'not_found' };
  if (challenge.consumed_at) return { ok: false, reason: 'already_used' };
  if (challenge.revoked_at) return { ok: false, reason: 'superseded' };
  if (new Date(challenge.expires_at) < new Date()) return { ok: false, reason: 'expired' };
  if (challenge.attempts >= challenge.max_attempts) return { ok: false, reason: 'too_many_attempts' };

  const counted = await db.execute(
    `UPDATE verification_challenges
        SET attempts = attempts + 1
      WHERE id = ? AND attempts < max_attempts AND consumed_at IS NULL AND revoked_at IS NULL`,
    [challenge.id],
  );
  if (counted.affectedRows !== 1) return { ok: false, reason: 'too_many_attempts' };

  let matched = false;
  if (challenge.channel === 'sms') {
    matched = await sms.provider().verifyCode(challenge.external_ref, code);
  } else {
    const expected = hashCode(String(code).trim(), config.secrets.codePepper);
    matched = safeEqual(expected, challenge.code_hash);
  }

  if (!matched) return { ok: false, reason: 'wrong_code', attempts: challenge.attempts + 1 };

  /*
   * Consume it, conditionally. Two requests arriving with the correct code at
   * the same instant must not both succeed — one wins the UPDATE and the other
   * gets zero rows and is told the code is spent. Without the WHERE clause,
   * both would be handed a session.
   */
  const consumed = await db.execute(
    'UPDATE verification_challenges SET consumed_at = NOW() WHERE id = ? AND consumed_at IS NULL',
    [challenge.id],
  );
  if (consumed.affectedRows !== 1) return { ok: false, reason: 'already_used' };

  // A proved destination clears its own send limit: somebody who just showed
  // they own this address should not be locked out by their earlier attempts.
  await rateLimit.clear(`code:${challenge.channel}`, challenge.destination_norm);

  return { ok: true, challenge };
}

/** The live challenge for a destination and purpose, if there is one. */
async function findLive(destinationNorm, purpose) {
  return db.one(
    `SELECT * FROM verification_challenges
      WHERE destination_norm = ? AND purpose = ?
        AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()
      LIMIT 1`,
    [destinationNorm, purpose],
  );
}

/**
 * Delete spent and expired codes.
 *
 * The published retention promise is 24 hours, and it is a promise worth
 * keeping for its own sake: a table of one-time codes is a list of live
 * credentials that nobody thinks of as one.
 */
async function sweep(hours = config.retention.challengeHours) {
  const result = await db.execute(
    'DELETE FROM verification_challenges WHERE created_at < DATE_SUB(NOW(), INTERVAL ? HOUR)',
    [hours],
  );
  return result.affectedRows;
}

module.exports = { create, verify, findLive, sweep };
