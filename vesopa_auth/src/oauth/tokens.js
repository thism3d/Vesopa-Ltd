/**
 * Minting tokens, and the rotation rule that catches a stolen one.
 *
 * HOW REUSE DETECTION ACTUALLY CATCHES A THIEF
 *
 * Every refresh mints a new token and spends the old one, all of them sharing a
 * `family_id`. A spent token is kept, not deleted — that is the whole
 * mechanism. If a spent token is ever presented again, exactly one of two
 * things happened: the honest client lost the response and retried, or somebody
 * stole a copy. We cannot tell which from the request, so we assume the worse
 * and revoke the entire family. The honest client signs in again; the thief
 * gets nothing, and the person is told.
 *
 * Deleting spent tokens instead makes that impossible: a stolen token then
 * looks exactly like an unknown one, and an unknown token is just a 400.
 *
 * THE EXCEPTION THAT KEEPS A PUB TRADING. A till on bad wifi sends /token twice
 * and both arrive. With no allowance, that revokes the family and the venue
 * loses its till in the middle of service — a self-inflicted outage caused by a
 * security feature working as designed. So a second presentation from the same
 * device and address, within a few seconds, returns the successor that was
 * already issued rather than raising the alarm.
 */

const db = require('../db');
const config = require('../config');
const keys = require('../keys');
const clients = require('./clients');
const { newId, newToken, hashToken, pairwiseSubject } = require('../crypto');

/**
 * The `sub` this application sees for this person.
 *
 * First-party Vesopa products get the person's own public id, because the till
 * and the back office are talking about the same member of staff and have to
 * agree who that is. A third party gets a value derived from (person,
 * application): stable for them for ever, and meaningless to anybody else — so
 * two unrelated developers cannot compare user lists and discover they share
 * customers.
 */
function subjectFor(application, userPublicId) {
  if (application.subject_type === 'public') return userPublicId;
  return pairwiseSubject(userPublicId, application.sector_salt || '', config.secrets.subjectPepper);
}

/**
 * An access token.
 *
 * One audience per token, and `typ: at+jwt` in the header. Both are what stop a
 * token minted for one resource server being replayed at another — and stop an
 * access token being accepted anywhere an ID token is expected, which is a
 * confusion that has produced real vulnerabilities.
 */
async function issueAccessToken({ application, user, scope, sessionId, amr, acr, roles }) {
  return keys.sign(
    {
      sub: subjectFor(application, user.public_id),
      client_id: application.client_id,
      scope: Array.isArray(scope) ? scope.join(' ') : scope,
      ...(roles && roles.length ? { roles } : {}),
      ...(sessionId ? { sid: sessionId } : {}),
      ...(amr ? { amr } : {}),
      ...(acr ? { acr } : {}),
    },
    {
      audience: application.client_id,
      expiresIn: application.access_token_ttl || config.tokens.accessTtlSeconds,
      type: 'at+jwt',
    },
  );
}

/**
 * An ID token: who the person is, at the moment they proved it.
 *
 * `auth_time`, `amr` and `acr` are what let an application decide the session
 * is not fresh enough or not strong enough for what is being attempted — the
 * basis of step-up. `nonce` must be echoed exactly: it is what binds this token
 * to the request that asked for it.
 */
async function issueIdToken({ application, user, nonce, sessionId, amr, acr, authTime, claims }) {
  return keys.sign(
    {
      sub: subjectFor(application, user.public_id),
      ...(nonce ? { nonce } : {}),
      ...(sessionId ? { sid: sessionId } : {}),
      ...(amr ? { amr } : {}),
      ...(acr ? { acr } : {}),
      ...(authTime ? { auth_time: Math.floor(new Date(authTime).getTime() / 1000) } : {}),
      ...claims,
    },
    {
      audience: application.client_id,
      expiresIn: config.tokens.idTtlSeconds,
      type: 'JWT',
    },
  );
}

/** Start a refresh-token family. */
async function issueRefreshToken({
  application,
  userId,
  sessionId,
  deviceId,
  scope,
  familyId = null,
  parentId = null,
  ip = '',
}) {
  const token = newToken(32);
  const result = await db.execute(
    `INSERT INTO oauth_refresh_tokens
       (token_hash, family_id, parent_id, application_id, user_id, session_id,
        device_id, scope, expires_at, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? SECOND), ?)`,
    [
      hashToken(token),
      familyId || newId(),
      parentId,
      application.id,
      userId,
      sessionId,
      deviceId,
      Array.isArray(scope) ? scope.join(' ') : scope,
      application.refresh_token_ttl || config.tokens.refreshTtlSeconds,
      String(ip).slice(0, 45),
    ],
  );
  return { token, id: result.insertId };
}

/**
 * Spend a refresh token and issue its successor.
 *
 * Returns `{ ok, replay, token, row }`. `replay: true` means the family has
 * been revoked and the caller must tell the user.
 */
async function rotateRefreshToken({ application, presented, ip = '' }) {
  const hash = hashToken(presented);

  const row = await db.one(
    'SELECT * FROM oauth_refresh_tokens WHERE token_hash = ?',
    [hash],
  );
  if (!row) return { ok: false, reason: 'unknown' };
  if (row.application_id !== application.id) return { ok: false, reason: 'wrong_client' };
  if (new Date(row.expires_at) < new Date()) return { ok: false, reason: 'expired' };

  if (row.revoked_at) return { ok: false, reason: 'revoked' };

  /*
   * Already spent. Retry, or theft?
   *
   * A retry looks like: same device, same address, moments ago, and we still
   * have the successor we issued. Anything else is treated as theft.
   */
  if (row.used_at) {
    const secondsAgo = (Date.now() - new Date(row.used_at).getTime()) / 1000;
    const looksLikeRetry =
      secondsAgo <= config.tokens.refreshReplayGraceSeconds &&
      row.ip === String(ip).slice(0, 45) &&
      row.rotated_to_id;

    if (looksLikeRetry) {
      // We cannot hand back the successor's plaintext — it was never stored —
      // so the honest client is told to try once more, by which time the first
      // response has usually arrived. It is not a revocation, which is the
      // thing that mattered.
      return { ok: false, reason: 'retry', retry: true };
    }

    await revokeFamily(row.family_id, 'reuse');
    await db.execute(
      'UPDATE oauth_refresh_tokens SET reuse_detected_at = NOW() WHERE id = ?',
      [row.id],
    );
    return { ok: false, reason: 'reuse', replay: true, row };
  }

  /*
   * Spend it. The conditional UPDATE is the lock: two simultaneous requests
   * cannot both get one row back, so exactly one of them proceeds and the other
   * is treated above.
   */
  const spent = await db.execute(
    'UPDATE oauth_refresh_tokens SET used_at = NOW() WHERE id = ? AND used_at IS NULL',
    [row.id],
  );
  if (spent.affectedRows !== 1) return { ok: false, reason: 'race', retry: true };

  const next = await issueRefreshToken({
    application,
    userId: row.user_id,
    sessionId: row.session_id,
    deviceId: row.device_id,
    scope: row.scope,
    familyId: row.family_id,
    parentId: row.id,
    ip,
  });

  await db.execute(
    'UPDATE oauth_refresh_tokens SET rotated_to_id = ?, rotated_at = NOW() WHERE id = ?',
    [next.id, row.id],
  );

  return { ok: true, token: next.token, row };
}

async function revokeFamily(familyId, reason = 'revoked') {
  await db.execute(
    `UPDATE oauth_refresh_tokens
        SET revoked_at = NOW(), revoked_reason = ?
      WHERE family_id = ? AND revoked_at IS NULL`,
    [String(reason).slice(0, 60), familyId],
  );
}

async function revokeToken(presented, reason = 'revoked') {
  const row = await db.one('SELECT family_id FROM oauth_refresh_tokens WHERE token_hash = ?', [
    hashToken(presented),
  ]);
  if (!row) return false;
  await revokeFamily(row.family_id, reason);
  return true;
}

/** End everything one application holds for one person. */
async function revokeForUserAndApplication(userId, applicationId, reason = 'user') {
  const result = await db.execute(
    `UPDATE oauth_refresh_tokens
        SET revoked_at = NOW(), revoked_reason = ?
      WHERE user_id = ? AND application_id = ? AND revoked_at IS NULL`,
    [String(reason).slice(0, 60), userId, applicationId],
  );
  return result.affectedRows;
}

/**
 * The claims for the ID token and /userinfo, filtered by scope.
 *
 * An application asked for `profile`, or it did not. Handing over a date of
 * birth to something that only asked to know who somebody is would be a quiet
 * breach of exactly the promise the consent screen made.
 */
async function claimsFor(user, scope) {
  const scopes = new Set(Array.isArray(scope) ? scope : String(scope || '').split(/\s+/));
  const claims = {};

  if (scopes.has('profile')) {
    if (user.display_name) claims.name = user.display_name;
    if (user.given_name) claims.given_name = user.given_name;
    if (user.family_name) claims.family_name = user.family_name;
    if (user.avatar_path) claims.picture = `${config.issuer}${user.avatar_path}`;
    if (user.date_of_birth) claims.birthdate = String(user.date_of_birth).slice(0, 10);
    if (user.locale) claims.locale = user.locale;
    if (user.timezone) claims.zoneinfo = user.timezone;
    claims.updated_at = Math.floor(new Date(user.updated_at).getTime() / 1000);
  }

  if (scopes.has('email')) {
    const email = await db.one(
      `SELECT identifier, verified_at FROM user_identities
        WHERE user_id = ? AND type = 'email' AND revoked_at IS NULL AND is_recovery = 0
        ORDER BY (id = (SELECT primary_email_id FROM users WHERE id = ?)) DESC, created_at
        LIMIT 1`,
      [user.id, user.id],
    );
    if (email) {
      claims.email = email.identifier;
      claims.email_verified = Boolean(email.verified_at);
    }
  }

  if (scopes.has('phone')) {
    const phone = await db.one(
      `SELECT identifier, verified_at FROM user_identities
        WHERE user_id = ? AND type = 'phone' AND revoked_at IS NULL AND is_recovery = 0
        ORDER BY (id = (SELECT primary_phone_id FROM users WHERE id = ?)) DESC, created_at
        LIMIT 1`,
      [user.id, user.id],
    );
    if (phone) {
      claims.phone_number = phone.identifier;
      claims.phone_number_verified = Boolean(phone.verified_at);
    }
  }

  return claims;
}

module.exports = {
  subjectFor,
  issueAccessToken,
  issueIdToken,
  issueRefreshToken,
  rotateRefreshToken,
  revokeFamily,
  revokeToken,
  revokeForUserAndApplication,
  claimsFor,
};
