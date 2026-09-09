/**
 * Finding people, making people, and the rules about what may be attached to
 * whom.
 *
 * This is the file where the owner's account rules actually live, so they are
 * worth restating:
 *
 *   * One Gmail (or GitHub, or address, or number) belongs to exactly one
 *     Vesopa account WHILE ACTIVE. Revoked, it is free for anybody.
 *   * Nothing is ever deleted; the history stays.
 *   * A new email typed here is verified once by code. An email that arrives
 *     from Google, Apple or Microsoft is not re-verified.
 *   * The login page is the registration page: a person who signs in with an
 *     unknown address is being registered, and does not need to be told which
 *     of the two happened.
 */

const crypto = require('crypto');
const db = require('./db');
const { newId } = require('./crypto');
const { isPrivateRelay } = require('./normalise');

/**
 * The live identity for this identifier, with its owner — or null.
 *
 * Only ACTIVE rows. A revoked one is history: it says who used to hold this
 * address, and must never sign anybody in.
 */
async function findIdentity(type, normalised) {
  if (!normalised) return null;
  return db.one(
    `SELECT i.*, u.public_id AS user_public_id, u.status AS user_status,
            u.display_name, u.merged_into_user_id
       FROM user_identities i
       JOIN users u ON u.id = i.user_id
      WHERE i.type = ? AND i.identifier_norm = ? AND i.revoked_at IS NULL
      LIMIT 1`,
    [type, normalised],
  );
}

/** Every live identity a person holds, for the linked-accounts page. */
async function identitiesOf(userId) {
  return db.query(
    `SELECT id, type, identifier, display, verified_at, verified_via,
            is_recovery, is_private_relay, created_at, last_used_at
       FROM user_identities
      WHERE user_id = ? AND revoked_at IS NULL
      ORDER BY FIELD(type, 'email', 'phone'), created_at`,
    [userId],
  );
}

/**
 * How many separate ways this person can get in.
 *
 * Counts live identities plus a live password, and is the guard behind
 * "you cannot unlink your last way of signing in". An account nobody can reach
 * is not a tidy account: it is a permanent support ticket, and the support
 * route that rescues it is a way in for whoever asks convincingly enough.
 */
async function countAuthMethods(userId, tx = db) {
  const row = await tx.one(
    `SELECT
       (SELECT COUNT(*) FROM user_identities
         WHERE user_id = ? AND revoked_at IS NULL AND is_recovery = 0) AS identities,
       (SELECT COUNT(*) FROM user_passwords
         WHERE user_id = ? AND retired_at IS NULL) AS passwords,
       (SELECT COUNT(*) FROM user_passkeys
         WHERE user_id = ? AND revoked_at IS NULL) AS passkeys`,
    [userId, userId, userId],
  );
  return Number(row.identities) + Number(row.passwords) + Number(row.passkeys);
}

/**
 * Create a person and their first identity, in one transaction.
 *
 * Both or neither: a `users` row with no way to sign in is an orphan nobody
 * will ever notice, and an identity with no user violates a foreign key. The
 * caller must handle a duplicate — see the note on `attachIdentity`.
 */
async function createUser({
  type,
  identifier,
  normalised,
  display = '',
  verified = false,
  verifiedVia = '',
  displayName = '',
  profile = null,
  assertedEmail = '',
  assertedEmailVerified = null,
}) {
  return db.transaction(async (tx) => {
    const publicId = newId();
    const result = await tx.execute(
      `INSERT INTO users (public_id, display_name, webauthn_handle)
       VALUES (?, ?, ?)`,
      [publicId, String(displayName).slice(0, 120), crypto.randomBytes(32)],
    );
    const userId = result.insertId;

    const identityId = await insertIdentity(tx, {
      userId,
      type,
      identifier,
      normalised,
      display,
      verified,
      verifiedVia,
      profile,
      assertedEmail,
      assertedEmailVerified,
    });

    // Point the person at their first address or number, so "your email" has an
    // answer from the very first request.
    if (type === 'email') {
      await tx.execute('UPDATE users SET primary_email_id = ? WHERE id = ?', [identityId, userId]);
    } else if (type === 'phone') {
      await tx.execute('UPDATE users SET primary_phone_id = ? WHERE id = ?', [identityId, userId]);
    }

    return { userId, publicId, identityId, created: true };
  });
}

/**
 * Attach an identity to an existing person.
 *
 * THE CALLER MUST CATCH ER_DUP_ENTRY. That error is not an exception here, it
 * is the mechanism: the unique index on (type, identifier_norm, active_flag) is
 * what makes "one active owner" true in the face of two requests arriving in
 * the same millisecond. A SELECT-then-INSERT in this function would let both
 * see "free" and both proceed. So the index decides, and a duplicate means
 * "somebody else has this" — which is a 409 and a sentence, not a 500.
 */
async function attachIdentity(userId, fields) {
  return db.transaction(async (tx) => insertIdentity(tx, { userId, ...fields }));
}

async function insertIdentity(
  tx,
  {
    userId,
    type,
    identifier,
    normalised,
    display = '',
    verified = false,
    verifiedVia = '',
    isRecovery = false,
    profile = null,
    assertedEmail = '',
    assertedEmailVerified = null,
  },
) {
  const result = await tx.execute(
    `INSERT INTO user_identities
       (user_id, type, identifier, identifier_norm, display, verified_at,
        verified_via, is_recovery, is_private_relay, profile,
        asserted_email, asserted_email_verified)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      userId,
      type,
      String(identifier).slice(0, 255),
      normalised,
      String(display).slice(0, 255),
      verified ? new Date() : null,
      String(verifiedVia).slice(0, 24),
      isRecovery ? 1 : 0,
      type === 'email' && isPrivateRelay(identifier) ? 1 : 0,
      profile ? JSON.stringify(profile) : null,
      String(assertedEmail).slice(0, 255),
      assertedEmailVerified === null ? null : assertedEmailVerified ? 1 : 0,
    ],
  );
  return result.insertId;
}

/** Mark an identity proved, and note how. */
async function markVerified(identityId, via) {
  await db.execute(
    `UPDATE user_identities
        SET verified_at = COALESCE(verified_at, NOW()), verified_via = ?, last_used_at = NOW()
      WHERE id = ? AND revoked_at IS NULL`,
    [String(via).slice(0, 24), identityId],
  );
}

async function touchIdentity(identityId) {
  await db.execute('UPDATE user_identities SET last_used_at = NOW() WHERE id = ?', [identityId]);
}

/**
 * Unlink an identity, freeing the identifier for somebody else.
 *
 * Refuses to remove the last way in. The check and the update are in one
 * transaction with the user row locked, because otherwise a person with two
 * tabs open can unlink their phone in one and Google in the other, each check
 * passing because it counted before the other committed.
 */
async function revokeIdentity(userId, identityId, reason = 'user') {
  return db.transaction(async (tx) => {
    await tx.one('SELECT id FROM users WHERE id = ? FOR UPDATE', [userId]);

    const identity = await tx.one(
      'SELECT * FROM user_identities WHERE id = ? AND user_id = ? AND revoked_at IS NULL',
      [identityId, userId],
    );
    if (!identity) return { ok: false, error: 'not_found' };

    if (!identity.is_recovery) {
      const remaining = await countAuthMethods(userId, tx);
      if (remaining <= 1) return { ok: false, error: 'last_auth_method' };
    }

    await tx.execute(
      'UPDATE user_identities SET revoked_at = NOW(), revoked_reason = ? WHERE id = ?',
      [String(reason).slice(0, 120), identityId],
    );

    // Do not leave the user pointing at a revoked row.
    await tx.execute(
      'UPDATE users SET primary_email_id = NULL WHERE id = ? AND primary_email_id = ?',
      [userId, identityId],
    );
    await tx.execute(
      'UPDATE users SET primary_phone_id = NULL WHERE id = ? AND primary_phone_id = ?',
      [userId, identityId],
    );

    return { ok: true, identity };
  });
}

/**
 * Does an account already exist for the email a social provider asserted?
 *
 * USED TO OFFER A LINK, NEVER TO PERFORM ONE.
 *
 * The attack this refuses to enable: somebody registers `victim@gmail.com` here
 * with a password and never verifies it. Weeks later the real owner signs in
 * with Google. If a matching email silently welded the two together, the
 * attacker's password would now open the victim's account — and the victim
 * would never know, because from their side it simply worked.
 *
 * So a match produces an interrupt — "you already have an account, sign in to
 * link it" — and the link is only made after the person has authenticated
 * against the EXISTING account. And only a provider we trust to have verified
 * the address gets even that far: an unverified GitHub email is not evidence of
 * anything.
 */
async function findLinkCandidate(assertedEmail, normalised, providerTrustsEmail) {
  if (!providerTrustsEmail || !normalised) return null;
  const existing = await findIdentity('email', normalised);
  if (!existing) return null;
  // An address we have never proved ourselves is not a safe thing to match on
  // from either direction.
  if (!existing.verified_at) return null;
  if (isPrivateRelay(assertedEmail)) return null;
  return existing;
}

/** The person, by internal id. */
async function getUser(userId) {
  return db.one('SELECT * FROM users WHERE id = ?', [userId]);
}

/** The person, by the id that appears outside this server. */
async function getUserByPublicId(publicId) {
  return db.one('SELECT * FROM users WHERE public_id = ?', [publicId]);
}

module.exports = {
  findIdentity,
  identitiesOf,
  countAuthMethods,
  createUser,
  attachIdentity,
  markVerified,
  touchIdentity,
  revokeIdentity,
  findLinkCandidate,
  getUser,
  getUserByPublicId,
};
