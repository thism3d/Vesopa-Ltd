/**
 * Helping somebody who has lost their second factor.
 *
 * THIS IS THE MOST DANGEROUS FUNCTION IN THE SYSTEM, and it is worth being
 * blunt about why. Every other control here — argon2id, passkeys, rotation,
 * reuse detection — is undone by an administrator who can be talked into
 * removing somebody's authenticator. Recovery is where MFA systems are actually
 * defeated, and it is defeated over the telephone rather than over the network.
 *
 * So this does four things beyond the removal itself, and none of them is
 * optional:
 *
 *   1. THE PASSWORD IS PAUSED. For 24 hours afterwards a password alone will
 *      not sign anybody in — they must prove they can RECEIVE at the address or
 *      number on the account. An attacker who has talked support into a reset
 *      but holds only a stolen password gets nothing; the real owner types a
 *      code and is barely delayed. This single control is what turns recovery
 *      from the easiest way in back into the hardest.
 *
 *   2. EVERY SESSION ENDS. If somebody was already inside, the reset does not
 *      leave them there.
 *
 *   3. THE PERSON IS TOLD, at once, by email. A reset they did not ask for is
 *      the only warning they will get, and it must not wait for them to notice.
 *
 *   4. IT IS WRITTEN DOWN — who, when, why, and how they were satisfied it was
 *      really them. A recovery nobody can account for six months later is a
 *      recovery that might as well not have been checked at all.
 */

const db = require('./db');
const mailer = require('./mailer');
const events = require('./events');
const sessions = require('./sessions');
const { newId } = require('./crypto');

/** How long a password alone will not do, after somebody is helped back in. */
const PASSWORD_PAUSE_HOURS = 24;

const VERIFICATION = {
  email_code: 'They read back a code we sent to the address on the account',
  sms_code: 'They read back a code we texted to the number on the account',
  known_in_person: 'I know them and recognised them',
  manager_confirmed: 'Their manager confirmed it, separately',
  other: 'Something else — described in the reason',
};

/**
 * What is there to remove, and what would be left afterwards.
 *
 * Shown to the administrator before they act, because "remove their passkeys"
 * reads very differently when the answer is "they have three" and when it is
 * "that is the only way they can sign in at all".
 */
async function summarise(userId) {
  const [totp, passkeys, codes, password, identities] = await Promise.all([
    db.one(
      'SELECT id, created_at, last_used_at FROM user_totp WHERE user_id = ? AND confirmed_at IS NOT NULL AND revoked_at IS NULL',
      [userId],
    ),
    db.query(
      'SELECT id, name, created_at, last_used_at FROM user_passkeys WHERE user_id = ? AND revoked_at IS NULL',
      [userId],
    ),
    db.one(
      'SELECT COUNT(*) AS remaining FROM user_recovery_codes WHERE user_id = ? AND used_at IS NULL',
      [userId],
    ),
    db.one('SELECT created_at FROM user_passwords WHERE user_id = ? AND retired_at IS NULL', [userId]),
    db.query(
      `SELECT type, identifier, verified_at, is_recovery FROM user_identities
        WHERE user_id = ? AND revoked_at IS NULL ORDER BY is_recovery, created_at`,
      [userId],
    ),
  ]);

  const contactable = identities.filter(
    (i) => (i.type === 'email' || i.type === 'phone') && i.verified_at,
  );

  return {
    totp,
    passkeys,
    recoveryCodesLeft: codes ? Number(codes.remaining) : 0,
    hasPassword: Boolean(password),
    identities,
    /*
     * Can they still get in on their own once we have removed things?
     *
     * If the answer is no, an administrator is about to lock somebody out
     * rather than help them, and the page says so before the button is pressed.
     */
    contactable: contactable.length,
    canStillSignIn: contactable.length > 0,
  };
}

/**
 * Do it.
 *
 * Everything is in one transaction except the notification, which is sent
 * afterwards and never allowed to fail the reset — the person's authenticator
 * is already gone by then, and a mail server having a bad afternoon must not
 * leave the account half-recovered.
 */
async function reset({
  userId,
  actorUserId,
  removeTotp = false,
  removePasskeys = false,
  reissueCodes = false,
  reason,
  verifiedBy,
  ip = '',
  userAgent = '',
}) {
  if (!reason || String(reason).trim().length < 10) {
    return { ok: false, error: 'Write down why, in a sentence somebody can read in six months.' };
  }
  if (!(verifiedBy in VERIFICATION)) {
    return { ok: false, error: 'Say how you satisfied yourself it was really them.' };
  }
  if (!removeTotp && !removePasskeys && !reissueCodes) {
    return { ok: false, error: 'Choose at least one thing to do.' };
  }
  if (Number(userId) === Number(actorUserId)) {
    /*
     * Not on yourself. An administrator who can reset their own second factor
     * has no second factor — and the whole control is that two people are
     * involved. Use your own recovery codes, like everybody else.
     */
    return { ok: false, error: 'You cannot do this to your own account. Ask another administrator.' };
  }

  const before = await summarise(userId);
  const publicId = newId();
  let removedPasskeys = 0;
  let newCodes = null;

  await db.transaction(async (tx) => {
    if (removeTotp && before.totp) {
      await tx.execute('UPDATE user_totp SET revoked_at = NOW() WHERE id = ?', [before.totp.id]);
    }
    if (removePasskeys && before.passkeys.length) {
      const result = await tx.execute(
        'UPDATE user_passkeys SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL',
        [userId],
      );
      removedPasskeys = result.affectedRows;
    }

    await tx.execute(
      `UPDATE users
          SET mfa_reset_at = NOW(), mfa_reset_by = ?,
              password_paused_until = DATE_ADD(NOW(), INTERVAL ? HOUR)
        WHERE id = ?`,
      [actorUserId, PASSWORD_PAUSE_HOURS, userId],
    );

    await tx.execute(
      `INSERT INTO account_recoveries
         (public_id, user_id, actor_user_id, removed_totp, removed_passkeys,
          reissued_codes, reason, verified_by, ip)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        publicId,
        userId,
        actorUserId,
        removeTotp && before.totp ? 1 : 0,
        removedPasskeys,
        reissueCodes ? 1 : 0,
        String(reason).trim().slice(0, 500),
        verifiedBy,
        String(ip).slice(0, 45),
      ],
    );
  });

  if (reissueCodes) {
    const mfa = require('./routes/mfa');
    newCodes = await mfa.issueRecoveryCodes(userId);
  }

  // Everything they had open, ended. If somebody else was already inside, the
  // reset does not leave them there.
  await sessions.revokeAllForUser(userId, 'mfa_reset');
  await db.execute(
    `UPDATE oauth_refresh_tokens SET revoked_at = NOW(), revoked_reason = 'mfa_reset'
      WHERE user_id = ? AND revoked_at IS NULL`,
    [userId],
  );

  await events.recordAudit({
    actorUserId,
    actorType: 'admin',
    action: 'account.recovery',
    targetType: 'user',
    targetId: String(userId),
    detail: {
      recovery: publicId,
      removed_totp: removeTotp && !!before.totp,
      removed_passkeys: removedPasskeys,
      reissued_codes: !!reissueCodes,
      verified_by: verifiedBy,
    },
    ip,
    userAgent,
  });

  /*
   * Written into the person's OWN sign-in history, not only the admin audit.
   * They will never read our audit log; they might well read their history, and
   * a reset they did not ask for is exactly what that page is for.
   */
  await events.recordLogin({
    userId,
    method: 'recovery_code',
    outcome: 'challenge',
    failureReason: 'admin_reset',
    ip,
    userAgent,
  });

  const notified = await notify(userId, { removeTotp, removedPasskeys, reissueCodes });
  if (notified) {
    await db.execute('UPDATE account_recoveries SET notified_at = NOW() WHERE public_id = ?', [
      publicId,
    ]);
  }

  return {
    ok: true,
    publicId,
    removedPasskeys,
    recoveryCodes: newCodes,
    notified,
    pausedUntilHours: PASSWORD_PAUSE_HOURS,
  };
}

async function notify(userId, { removeTotp, removedPasskeys, reissueCodes }) {
  try {
    const address = await db.one(
      `SELECT identifier FROM user_identities
        WHERE user_id = ? AND type = 'email' AND revoked_at IS NULL AND verified_at IS NOT NULL
        ORDER BY is_recovery, created_at LIMIT 1`,
      [userId],
    );
    if (!address) return false;

    const done = [];
    if (removeTotp) done.push('your authenticator app was removed');
    if (removedPasskeys) done.push(`${removedPasskeys} passkey${removedPasskeys === 1 ? ' was' : 's were'} removed`);
    if (reissueCodes) done.push('new recovery codes were issued');

    await mailer.sendSecurityNotice({
      to: address.identifier,
      heading: 'Somebody at Vesopa helped you back into your account',
      body:
        `At your request, ${done.join(', ')}. Every device has been signed out. ` +
        `For the next ${PASSWORD_PAUSE_HOURS} hours you will need a code sent to this address ` +
        'to sign in, even if you know your password — that is deliberate, and it is what stops ' +
        'somebody else asking us to do this to your account. ' +
        'If you did NOT ask for this, write to security@vesopa.com immediately.',
      when: new Date().toUTCString(),
      ip: '',
      device: '',
    });
    return true;
  } catch (error) {
    console.error('[recovery] could not notify:', error.message);
    return false;
  }
}

/** Is a password alone acceptable for this account right now? */
function passwordPaused(user) {
  if (!user || !user.password_paused_until) return false;
  return new Date(user.password_paused_until) > new Date();
}

async function historyFor(userId) {
  return db.query(
    `SELECT r.*, u.display_name AS actor_name
       FROM account_recoveries r
       LEFT JOIN users u ON u.id = r.actor_user_id
      WHERE r.user_id = ?
      ORDER BY r.created_at DESC
      LIMIT 20`,
    [userId],
  );
}

async function recent(limit = 25) {
  return db.query(
    `SELECT r.*, u.display_name AS actor_name, p.public_id AS subject_public_id,
            p.display_name AS subject_name
       FROM account_recoveries r
       LEFT JOIN users u ON u.id = r.actor_user_id
       JOIN users p ON p.id = r.user_id
      ORDER BY r.created_at DESC
      LIMIT ${Math.max(1, Math.min(100, Number(limit) || 25))}`,
  );
}

module.exports = {
  VERIFICATION,
  PASSWORD_PAUSE_HOURS,
  summarise,
  reset,
  passwordPaused,
  historyFor,
  recent,
};
