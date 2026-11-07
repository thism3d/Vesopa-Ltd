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
const { isPrivateRelay, normaliseEmail } = require('./normalise');

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
  return db.transaction(async (tx) => {
    const id = await insertIdentity(tx, { userId, ...fields });
    // In the same transaction, so an account never exists with an address it
    // does not point at — see the note on ensurePrimary for what that cost.
    await ensurePrimary(userId, tx);
    return id;
  });
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
        asserted_email, asserted_email_norm, asserted_email_verified)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      /*
       * The SAME normalisation as every other identifier in this system.
       *
       * `asserted_email` used to be stored raw and only raw, which broke the
       * rule at the top of normalise.js — store it as written, and store it
       * again in the one form we compare against. The consequence was that
       * `findByAssertedEmail` could not exist, so an address Google or GitHub
       * had already proved could not be matched to the same address typed on
       * the sign-in page, and one person ended up with two accounts.
       */
      normaliseEmail(assertedEmail) || '',
      assertedEmailVerified === null ? null : assertedEmailVerified ? 1 : 0,
    ],
  );
  return result.insertId;
}

/**
 * Make sure the account points at an address and a number, if it has them.
 *
 * WHY THIS IS NEEDED AT ALL. `createUser` sets `primary_email_id` when the
 * FIRST identity is an email — which is right for somebody who signed in with
 * an address, and silently wrong for everybody else. An account created by
 * signing in with GitHub has a provider identity first and an email attached a
 * moment later, so the pointer stays null; so does one created by phone and
 * given an address afterwards.
 *
 * That was invisible until something needed to NAME the account. Then it is
 * everywhere at once: the account chooser said "no address on this account"
 * for a person who plainly has one, the consent screen could not say whose
 * account was about to be connected, and "confirm it is you" had nowhere to
 * send a code. All three read `primary_email_id`, and all three were reading a
 * null that nothing had ever been responsible for filling in.
 *
 * A VERIFIED ADDRESS, AND NEVER A RECOVERY-ONLY ONE. A recovery address exists
 * precisely so that it is NOT the account's public identity, and pointing the
 * account at one would put it on the consent screen of every application.
 */
async function ensurePrimary(userId, tx = db) {
  await tx.execute(
    `UPDATE users u
        SET u.primary_email_id = (
              SELECT i.id FROM user_identities i
               WHERE i.user_id = u.id AND i.type = 'email'
                 AND i.revoked_at IS NULL AND i.is_recovery = 0
               ORDER BY i.verified_at IS NULL, i.id
               LIMIT 1)
      WHERE u.id = ? AND u.primary_email_id IS NULL`,
    [userId],
  );
  await tx.execute(
    `UPDATE users u
        SET u.primary_phone_id = (
              SELECT i.id FROM user_identities i
               WHERE i.user_id = u.id AND i.type = 'phone'
                 AND i.revoked_at IS NULL AND i.is_recovery = 0
               ORDER BY i.verified_at IS NULL, i.id
               LIMIT 1)
      WHERE u.id = ? AND u.primary_phone_id IS NULL`,
    [userId],
  );
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
  if (isPrivateRelay(assertedEmail)) return null;
  const existing = await findIdentity('email', normalised);
  // An address we have never proved ourselves is not a safe thing to match on
  // from either direction, unless nobody has ever used the account that names
  // it: then this proof is what it was made to wait for.
  if (existing) {
    if (existing.verified_at) return existing;
    return (await isUnclaimedPlaceholder(existing.user_id)) ? existing : null;
  }
  /*
   * No email row — but another PROVIDER may already hold this address for
   * somebody. Google first, GitHub second, each asserting the same verified
   * address, and neither ever typed it on the sign-in page: the first made an
   * account with the address on its provider row only, so a lookup of email
   * rows finds nothing and the second would make a second account. The same
   * two-proofs argument as findByAssertedEmail applies — a provider we trust
   * verified it then, and one we trust has verified it now.
   */
  return findByAssertedEmail(normalised);
}

/**
 * The account that already holds this address because a provider proved it.
 *
 * THE OTHER HALF OF `findLinkCandidate`, and the fault it fixes is the one the
 * owner reported: signing in with GitHub made an account holding
 * `muzahid@onzep.uk`; typing that same address on the sign-in page made a
 * SECOND account. His words — *"any user link their account has the same email
 * linked to the one account"* — and he is right.
 *
 * `findLinkCandidate` answers "Google says this address is theirs; do we
 * already know it?". This answers the mirror image: "somebody has just read a
 * code we sent to this address; does an account already exist that a provider
 * told us owns it?".
 *
 * WHY THIS IS SAFE, WHEN THE SILENT LINK IN THE OTHER DIRECTION WOULD NOT BE.
 * The classic attack on email matching is that an UNPROVEN claim gets welded to
 * a proven one — somebody registers victim@gmail.com without verifying it, and
 * later the real owner's Google sign-in hands them the account. Nothing like
 * that is possible here, because BOTH sides are proofs of the same fact:
 *
 *   the provider verified that address (asserted_email_verified), and
 *   the person just received a code AT that address, this minute.
 *
 * Two independent demonstrations of control over one mailbox. If they are
 * different people, the mailbox is already shared, and no account boundary was
 * ever going to survive that.
 *
 * Apple relay addresses are excluded by `isPrivateRelay`: they are per-app
 * aliases that can be switched off, and they are not evidence about a person.
 */
async function findByAssertedEmail(normalised) {
  if (!normalised || isPrivateRelay(normalised)) return null;
  return db.one(
    `SELECT i.*, u.public_id AS user_public_id, u.status AS user_status,
            u.display_name
       FROM user_identities i
       JOIN users u ON u.id = i.user_id
      WHERE i.asserted_email_norm = ?
        AND i.asserted_email_verified = 1
        AND i.revoked_at IS NULL
        AND i.type NOT IN ('email', 'phone')
        AND u.status = 'active'
      ORDER BY i.id
      LIMIT 1`,
    [normalised],
  );
}

/**
 * The address a linked provider confirmed for this person (owner, 2026-11-07:
 * "account linked with that mail means mail confirmed").
 *
 * The same bar as findByAssertedEmail: a provider's verified assertion, never
 * an Apple relay address. It answers for the moment before adoptProviderEmail
 * has run, or where another account holds the row; every other reader of
 * confirmed addresses reads the email row adoption makes.
 */
async function providerConfirmedEmail(userId) {
  const row = await db.one(
    `SELECT asserted_email, asserted_email_norm
       FROM user_identities
      WHERE user_id = ?
        AND type NOT IN ('email', 'phone')
        AND asserted_email_verified = 1
        AND asserted_email_norm <> ''
        AND revoked_at IS NULL
      ORDER BY id
      LIMIT 1`,
    [userId],
  );
  if (!row || isPrivateRelay(row.asserted_email_norm)) return null;
  return { email: row.asserted_email, normalised: row.asserted_email_norm };
}

/**
 * A provider has just proved this address for this person: make it theirs.
 *
 * Sign-in checks, recovery, invitations and step-up all read a confirmed email
 * ROW, so the proof has to end up as one. Otherwise an account made through
 * Google works until the first thing asks for its address, and is then told it
 * has none. Safe to call on every sign-in, and from a repair script.
 *
 *   'confirmed'  the person's own row, already confirmed or now so
 *   'added'      a new confirmed row
 *   'held'       another account has the address; nothing changed
 *   'skipped'    no address, or an Apple relay address
 */
async function adoptProviderEmail(userId, { email, normalised, via }) {
  if (!normalised || isPrivateRelay(normalised)) return 'skipped';
  const row = await findIdentity('email', normalised);
  if (row && row.user_id !== userId) return 'held';
  if (row) {
    if (!row.verified_at) await markVerified(row.id, via);
    await ensurePrimary(userId);
    return 'confirmed';
  }
  try {
    await attachIdentity(userId, { type: 'email', identifier: email, normalised, verified: true, verifiedVia: via });
    return 'added';
  } catch (error) {
    if (db.isDuplicate(error)) return 'held';
    throw error;
  }
}

/** Keep what a provider says about an identity current, for rows made before it was stored. */
async function recordAssertion(identityId, { email, normalised, verified }) {
  await db.execute(
    `UPDATE user_identities
        SET asserted_email = ?, asserted_email_norm = ?, asserted_email_verified = ?
      WHERE id = ?`,
    [email, normalised, verified ? 1 : 0, identityId],
  );
}

/**
 * Is this account a silent placeholder nobody has ever used?
 *
 * Venue provisioning makes accounts from an address in a database, unverified
 * and with no way in, until the person first proves the address. One that has
 * only that row, never used, has no owner to protect: a provider's proof of the
 * address is the proof the placeholder was waiting for. An account with a
 * password or anything else is NOT this, which is what keeps the attack in
 * findLinkCandidate's comment closed.
 */
async function isUnclaimedPlaceholder(userId) {
  const row = await db.one(
    `SELECT
       (SELECT COUNT(*) FROM user_identities
         WHERE user_id = ? AND revoked_at IS NULL) AS identities,
       (SELECT COUNT(*) FROM user_identities
         WHERE user_id = ? AND revoked_at IS NULL AND (verified_at IS NOT NULL OR last_used_at IS NOT NULL)) AS used,
       (SELECT COUNT(*) FROM user_passwords
         WHERE user_id = ? AND retired_at IS NULL) AS passwords,
       (SELECT COUNT(*) FROM user_passkeys
         WHERE user_id = ? AND revoked_at IS NULL) AS passkeys`,
    [userId, userId, userId, userId],
  );
  return Boolean(row) && Number(row.identities) === 1 && Number(row.used) === 0
    && Number(row.passwords) === 0 && Number(row.passkeys) === 0;
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
  ensurePrimary,
  touchIdentity,
  revokeIdentity,
  findLinkCandidate,
  findByAssertedEmail,
  providerConfirmedEmail,
  adoptProviderEmail,
  recordAssertion,
  isUnclaimedPlaceholder,
  getUser,
  getUserByPublicId,
};
