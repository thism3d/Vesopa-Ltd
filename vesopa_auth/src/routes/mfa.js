/**
 * Second factors: authenticator apps, passkeys and recovery codes.
 *
 * ENROLMENT MUST NEVER BE ABLE TO LOCK SOMEBODY OUT. That is the rule the whole
 * file is arranged around, and it shows up in three places:
 *
 *   * A TOTP secret is `pending` until a code from it has been checked. Until
 *     that moment the sign-in path is untouched, so an interrupted enrolment —
 *     a dead phone battery, a closed tab — leaves the account exactly as it was.
 *   * Recovery codes are generated and shown at the end of enrolment, once.
 *   * Removing a factor requires proving you still have one.
 *
 * The commonest way an MFA rollout goes wrong is not a weak factor: it is a
 * person who half-enrolled and can no longer get in.
 */

const express = require('express');
const QRCode = require('qrcode');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');

const config = require('../config');
const db = require('../db');
const sessions = require('../sessions');
const events = require('../events');
const csrf = require('../csrf');
const rateLimit = require('../ratelimit');
const identity = require('../identity');
const {
  newId,
  newToken,
  newTotpSecret,
  verifyTotp,
  totpUri,
  encrypt,
  decrypt,
  hashPassword,
  verifyPassword,
} = require('../crypto');

const router = express.Router();

async function requireSession(req, res) {
  const session = await sessions.load(req);
  if (!session) {
    res.status(401).json({ error: 'not_signed_in' });
    return null;
  }
  return session;
}

// ===========================================================================
// Authenticator app (TOTP)
// ===========================================================================

/**
 * Begin enrolment: make a secret, show it as a QR code, and change nothing.
 *
 * The row is written with `confirmed_at` NULL, which is what keeps this
 * reversible. Nothing in the sign-in path looks at an unconfirmed secret.
 */
router.post('/account/totp/start', csrf.verify, async (req, res, next) => {
  try {
    const session = await requireSession(req, res);
    if (!session) return undefined;

    const secret = newTotpSecret();

    // Replace any half-finished attempt rather than accumulating them — an
    // abandoned enrolment from last week must not be able to confirm today.
    await db.execute(
      'DELETE FROM user_totp WHERE user_id = ? AND confirmed_at IS NULL',
      [session.user_id],
    );

    await db.execute(
      'INSERT INTO user_totp (user_id, secret_cipher) VALUES (?, ?)',
      [session.user_id, encrypt(secret, config.secrets.encryptionKey)],
    );

    const account = await db.one(
      `SELECT identifier FROM user_identities
        WHERE user_id = ? AND type = 'email' AND revoked_at IS NULL
        ORDER BY is_recovery, created_at LIMIT 1`,
      [session.user_id],
    );

    const uri = totpUri(secret, account ? account.identifier : session.user_public_id, 'Vesopa');

    /*
     * The QR is rendered server-side into a data: URI. It never becomes a file
     * on disk and never reaches a third-party chart service — which is how TOTP
     * secrets have leaked from otherwise careful systems.
     */
    const qr = await QRCode.toDataURL(uri, { errorCorrectionLevel: 'M', margin: 1, width: 240 });

    return res.json({
      qr,
      // Shown beside the QR so somebody on a desktop with the authenticator on
      // the same machine can type it, and so a blind user can enrol at all.
      manualKey: secret.replace(/(.{4})/g, '$1 ').trim(),
    });
  } catch (error) {
    return next(error);
  }
});

/** Finish enrolment by proving the app produces the right code. */
router.post('/account/totp/confirm', csrf.verify, async (req, res, next) => {
  try {
    const session = await requireSession(req, res);
    if (!session) return undefined;

    const attempt = await rateLimit.hit('totp:confirm', String(session.user_id), {
      limit: 10,
      windowSeconds: 900,
    });
    if (!attempt.allowed) return res.status(429).json({ error: 'too_many_attempts' });

    const pending = await db.one(
      'SELECT * FROM user_totp WHERE user_id = ? AND confirmed_at IS NULL ORDER BY id DESC LIMIT 1',
      [session.user_id],
    );
    if (!pending) return res.status(400).json({ error: 'no_enrolment_in_progress' });

    const secret = decrypt(pending.secret_cipher, config.secrets.encryptionKey);
    const step = verifyTotp(secret, req.body.code, { window: 1 });
    if (step === null) return res.status(400).json({ error: 'wrong_code' });

    await db.transaction(async (tx) => {
      // Exactly one confirmed authenticator per person. Two live secrets is two
      // things to steal and one more to forget about.
      await tx.execute(
        "UPDATE user_totp SET revoked_at = NOW() WHERE user_id = ? AND confirmed_at IS NOT NULL AND revoked_at IS NULL",
        [session.user_id],
      );
      await tx.execute(
        'UPDATE user_totp SET confirmed_at = NOW(), last_step = ?, last_used_at = NOW() WHERE id = ?',
        [step, pending.id],
      );
    });

    const codes = await issueRecoveryCodes(session.user_id);

    await events.recordAudit({
      actorUserId: session.user_id,
      action: 'mfa.totp.enrolled',
      targetType: 'user',
      targetId: session.user_public_id,
      ip: req.clientIp,
      userAgent: req.userAgent,
    });

    /*
     * The recovery codes are returned exactly once, here. They are stored
     * hashed, so this is the only moment they exist in readable form — which is
     * why the UI must make the person save them before it moves on.
     */
    return res.json({ ok: true, recoveryCodes: codes });
  } catch (error) {
    return next(error);
  }
});

/** Turn it off — after proving you can still get in. */
router.post('/account/totp/disable', csrf.verify, async (req, res, next) => {
  try {
    const session = await requireSession(req, res);
    if (!session) return undefined;

    const active = await db.one(
      'SELECT * FROM user_totp WHERE user_id = ? AND confirmed_at IS NOT NULL AND revoked_at IS NULL',
      [session.user_id],
    );
    if (!active) return res.status(400).json({ error: 'not_enrolled' });

    // Removing a factor is exactly the thing an attacker with a borrowed
    // session wants to do first, so it costs a current code.
    const secret = decrypt(active.secret_cipher, config.secrets.encryptionKey);
    if (verifyTotp(secret, req.body.code, { window: 1 }) === null) {
      return res.status(400).json({ error: 'wrong_code' });
    }

    await db.execute('UPDATE user_totp SET revoked_at = NOW() WHERE id = ?', [active.id]);
    await events.recordAudit({
      actorUserId: session.user_id,
      action: 'mfa.totp.removed',
      targetType: 'user',
      targetId: session.user_public_id,
      ip: req.clientIp,
      userAgent: req.userAgent,
    });
    await notify(session.user_id, {
      heading: 'Your authenticator app was removed',
      body: 'Two-step verification by authenticator app is no longer on your Vesopa account.',
      req,
    });

    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

/**
 * Ten single-use codes, hashed like passwords because that is what they are.
 *
 * Crockford base32 in two groups of five: no I, L, O or U, so a code read down
 * a telephone or copied off a printout cannot become a different code.
 */
async function issueRecoveryCodes(userId) {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const batch = newId();
  const codes = [];

  for (let i = 0; i < 10; i += 1) {
    const raw = Array.from({ length: 10 }, () => alphabet[Math.floor(Math.random() * 32)]).join('');
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }

  await db.transaction(async (tx) => {
    // A new batch replaces the old one entirely: leaving the previous codes
    // live would mean a person who regenerated them because they were lost
    // still has the lost ones working.
    await tx.execute('DELETE FROM user_recovery_codes WHERE user_id = ? AND used_at IS NULL', [
      userId,
    ]);
    for (const code of codes) {
      // eslint-disable-next-line no-await-in-loop
      const hash = await hashPassword(code, config.secrets.passwordPepper);
      // eslint-disable-next-line no-await-in-loop
      await tx.execute(
        'INSERT INTO user_recovery_codes (user_id, code_hash, batch_id) VALUES (?, ?, ?)',
        [userId, hash, batch],
      );
    }
  });

  return codes;
}

router.post('/account/recovery-codes', csrf.verify, async (req, res, next) => {
  try {
    const session = await requireSession(req, res);
    if (!session) return undefined;
    const codes = await issueRecoveryCodes(session.user_id);
    await events.recordAudit({
      actorUserId: session.user_id,
      action: 'mfa.recovery_codes.regenerated',
      targetType: 'user',
      targetId: session.user_public_id,
      ip: req.clientIp,
    });
    return res.json({ ok: true, recoveryCodes: codes });
  } catch (error) {
    return next(error);
  }
});

// ===========================================================================
// Passkeys
// ===========================================================================

/*
 * THE RELYING PARTY ID IS THE APEX DOMAIN, and it is the single hardest thing
 * in this system to change afterwards.
 *
 * A passkey is bound to the RP ID it was created under. Enrolled against
 * `auth.vesopa.com`, it could never be used from menu.vesopa.com or
 * cloud.vesopa.com — and the only remedy would be asking every user to enrol
 * again. Bound to `vesopa.com`, it works on every Vesopa subdomain that will
 * ever exist. Only this origin runs the ceremonies, which is why the origin
 * list is narrow while the RP ID is broad.
 */

async function storeChallenge({ challenge, purpose, userId = null, ip = '' }) {
  await db.execute(
    `INSERT INTO webauthn_challenges (challenge, purpose, user_id, ip, expires_at)
     VALUES (?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 5 MINUTE))`,
    [challenge, purpose, userId, String(ip).slice(0, 45)],
  );
}

/** Claim a challenge, single use, in one statement. */
async function claimChallenge(challenge, purpose) {
  const claimed = await db.execute(
    `UPDATE webauthn_challenges SET consumed_at = NOW()
      WHERE challenge = ? AND purpose = ? AND consumed_at IS NULL AND expires_at > NOW()`,
    [challenge, purpose],
  );
  if (claimed.affectedRows !== 1) return null;
  return db.one('SELECT * FROM webauthn_challenges WHERE challenge = ?', [challenge]);
}

router.post('/webauthn/register/options', csrf.verify, async (req, res, next) => {
  try {
    const session = await requireSession(req, res);
    if (!session) return undefined;

    const user = await identity.getUser(session.user_id);
    const existing = await db.query(
      'SELECT credential_id, transports FROM user_passkeys WHERE user_id = ? AND revoked_at IS NULL',
      [session.user_id],
    );

    const options = await generateRegistrationOptions({
      rpName: config.webauthn.rpName,
      rpID: config.webauthn.rpId,
      // Opaque random bytes, never the email and never the ULID. This value is
      // stored on the person's own device and in their password manager.
      userID: user.webauthn_handle,
      userName: await displayNameFor(session.user_id),
      userDisplayName: user.display_name || 'Vesopa',
      attestationType: 'none',
      // Stops the same authenticator being enrolled twice, which produces two
      // credentials the person cannot tell apart on the security page.
      excludeCredentials: existing.map((row) => ({
        id: Buffer.from(row.credential_id).toString('base64url'),
        transports: row.transports ? row.transports.split(',') : undefined,
      })),
      authenticatorSelection: {
        // Discoverable, so the passkey can sign somebody in who has not typed
        // anything — which is the only version that fits an email-first form.
        residentKey: 'required',
        // Required everywhere: it is what makes a passkey worth two factors
        // rather than one, and it keeps a single code path.
        userVerification: 'required',
      },
    });

    await storeChallenge({
      challenge: options.challenge,
      purpose: 'register',
      userId: session.user_id,
      ip: req.clientIp,
    });

    return res.json(options);
  } catch (error) {
    return next(error);
  }
});

router.post('/webauthn/register/verify', csrf.verify, async (req, res, next) => {
  try {
    const session = await requireSession(req, res);
    if (!session) return undefined;

    const expected = req.body.expectedChallenge || req.body.challenge;
    const row = await claimChallenge(String(expected || ''), 'register');
    if (!row || row.user_id !== session.user_id) {
      return res.status(400).json({ error: 'challenge_expired' });
    }

    const verification = await verifyRegistrationResponse({
      response: req.body.credential,
      expectedChallenge: row.challenge,
      expectedOrigin: config.webauthn.rpOrigins,
      expectedRPID: config.webauthn.rpId,
      requireUserVerification: true,
    });

    if (!verification.verified || !verification.registrationInfo) {
      return res.status(400).json({ error: 'not_verified' });
    }

    const info = verification.registrationInfo;
    const credential = info.credential || info;

    await db.execute(
      `INSERT INTO user_passkeys
         (user_id, credential_id, public_key, sign_count, transports, aaguid,
          name, backup_eligible, backup_state, user_verified, device_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        session.user_id,
        Buffer.from(credential.id, 'base64url'),
        Buffer.from(credential.publicKey),
        credential.counter || 0,
        (credential.transports || []).join(','),
        info.aaguid || '',
        String(req.body.name || 'Passkey').slice(0, 80),
        info.credentialBackedUp !== undefined ? Number(info.credentialBackedUp) : 0,
        info.credentialBackedUp ? 1 : 0,
        1,
        info.credentialDeviceType || '',
      ],
    );

    await events.recordAudit({
      actorUserId: session.user_id,
      action: 'mfa.passkey.added',
      targetType: 'user',
      targetId: session.user_public_id,
      ip: req.clientIp,
      userAgent: req.userAgent,
    });
    await notify(session.user_id, {
      heading: 'A passkey was added to your account',
      body: 'It can now be used to sign in to Vesopa without a password.',
      req,
    });

    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

/**
 * Options for signing in with a passkey.
 *
 * No `allowCredentials`: the credential is discoverable, so the browser offers
 * whichever passkey it holds for this site and tells us afterwards who it
 * belongs to. That is what makes the conditional-UI prompt on the email field
 * possible.
 */
router.post('/webauthn/authenticate/options', async (req, res, next) => {
  try {
    const options = await generateAuthenticationOptions({
      rpID: config.webauthn.rpId,
      userVerification: 'required',
    });
    await storeChallenge({
      challenge: options.challenge,
      purpose: 'authenticate',
      ip: req.clientIp,
    });
    return res.json(options);
  } catch (error) {
    return next(error);
  }
});

router.post('/webauthn/authenticate/verify', async (req, res, next) => {
  try {
    const credentialId = req.body.rawId || req.body.id;
    if (!credentialId) return res.status(400).json({ error: 'no_credential' });

    const stored = await db.one(
      `SELECT p.*, u.public_id AS user_public_id, u.status AS user_status
         FROM user_passkeys p
         JOIN users u ON u.id = p.user_id
        WHERE p.credential_id = ? AND p.revoked_at IS NULL`,
      [Buffer.from(credentialId, 'base64url')],
    );
    if (!stored) return res.status(400).json({ error: 'unknown_credential' });
    if (stored.user_status !== 'active') return res.status(403).json({ error: 'account_unavailable' });

    const challengeValue = String(req.body.expectedChallenge || req.body.challenge || '');
    const row = await claimChallenge(challengeValue, 'authenticate');
    if (!row) return res.status(400).json({ error: 'challenge_expired' });

    const verification = await verifyAuthenticationResponse({
      response: req.body,
      expectedChallenge: row.challenge,
      expectedOrigin: config.webauthn.rpOrigins,
      expectedRPID: config.webauthn.rpId,
      requireUserVerification: true,
      credential: {
        id: Buffer.from(stored.credential_id).toString('base64url'),
        publicKey: new Uint8Array(stored.public_key),
        counter: Number(stored.sign_count),
        transports: stored.transports ? stored.transports.split(',') : undefined,
      },
    });

    if (!verification.verified) {
      await events.recordLogin({
        userId: stored.user_id,
        method: 'passkey',
        outcome: 'failure',
        failureReason: 'not_verified',
        ip: req.clientIp,
        userAgent: req.userAgent,
      });
      return res.status(400).json({ error: 'not_verified' });
    }

    /*
     * SIGN COUNT, IN 2026.
     *
     * The counter was designed to catch a cloned authenticator. Most passkeys
     * today are synced across a person's devices and report zero for ever, so
     * refusing a login because the counter did not increase locks out the
     * ordinary case. It is recorded, and a DECREASE from a non-zero counter is
     * worth an alert — never a refusal.
     */
    const newCount = Number(verification.authenticationInfo.newCounter || 0);
    if (Number(stored.sign_count) > 0 && newCount > 0 && newCount <= Number(stored.sign_count)) {
      console.warn(`[webauthn] sign count did not advance for credential ${stored.id}`);
      await events.recordLogin({
        userId: stored.user_id,
        method: 'passkey',
        outcome: 'challenge',
        failureReason: 'sign_count_anomaly',
        ip: req.clientIp,
        userAgent: req.userAgent,
      });
    }

    await db.execute(
      'UPDATE user_passkeys SET sign_count = ?, last_used_at = NOW() WHERE id = ?',
      [newCount, stored.id],
    );

    const session = await sessions.create({
      userId: stored.user_id,
      // A passkey with user verification is possession and verification in one
      // gesture, so it stands on its own at aal2.
      amr: ['webauthn'],
      acr: 'aal2',
      remembered: true,
      ip: req.clientIp,
      userAgent: req.userAgent,
    });
    sessions.setCookie(res, session.token, true);

    await events.recordLogin({
      userId: stored.user_id,
      sessionId: session.id,
      method: 'passkey',
      outcome: 'success',
      ip: req.clientIp,
      userAgent: req.userAgent,
    });

    return res.json({ ok: true, redirect: '/account' });
  } catch (error) {
    return next(error);
  }
});

router.post('/account/passkeys/:id/remove', csrf.verify, async (req, res, next) => {
  try {
    const session = await requireSession(req, res);
    if (!session) return undefined;

    // The last-way-in guard applies to passkeys too: somebody whose only
    // credential is a passkey must not be able to delete it and be locked out.
    const remaining = await identity.countAuthMethods(session.user_id);
    if (remaining <= 1) return res.status(409).json({ error: 'last_auth_method' });

    await db.execute(
      'UPDATE user_passkeys SET revoked_at = NOW() WHERE id = ? AND user_id = ? AND revoked_at IS NULL',
      [req.params.id, session.user_id],
    );
    await events.recordAudit({
      actorUserId: session.user_id,
      action: 'mfa.passkey.removed',
      targetType: 'passkey',
      targetId: String(req.params.id),
      ip: req.clientIp,
    });
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------

async function displayNameFor(userId) {
  const row = await db.one(
    `SELECT identifier FROM user_identities
      WHERE user_id = ? AND type IN ('email','phone') AND revoked_at IS NULL
      ORDER BY is_recovery, created_at LIMIT 1`,
    [userId],
  );
  return row ? row.identifier : 'Vesopa user';
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
    console.error('[mfa] notification failed:', error.message);
  }
}

module.exports = router;
module.exports.issueRecoveryCodes = issueRecoveryCodes;
