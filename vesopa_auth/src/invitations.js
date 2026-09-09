/**
 * Inviting somebody in.
 *
 * WHAT AN INVITATION IS, AND WHAT IT IS NOT. It is not a way to sign in. It is
 * a bundle of *grants* — developer access, an application role, staff — that
 * are applied to whoever proves they own the invited address. The proving is
 * the ordinary sign-in flow, unchanged.
 *
 * That distinction is the whole security of the feature. An invitation link
 * that signed somebody in would be a password sent by email to an address
 * nobody had verified, forwardable, and sitting in a mailbox for a week. Here
 * the link opens the sign-in page; the grants are applied afterwards, and only
 * if the address they proved matches the address that was invited.
 *
 * So an invitation intercepted in transit is worth nothing on its own. The
 * interceptor must also be able to receive at the address it was sent to — at
 * which point they did not need the invitation.
 */

const config = require('./config');
const db = require('./db');
const mailer = require('./mailer');
const events = require('./events');
const { newId, newToken, hashToken } = require('./crypto');
const { normaliseEmail } = require('./normalise');

const TTL_DAYS = 7;

/**
 * Create one, and send it.
 *
 * Returns `{ ok, publicId, url }`. The URL is returned as well as sent so an
 * administrator can pass it on another way — somebody whose email is exactly
 * the thing that is broken is a common reason for an invitation in the first
 * place.
 */
async function create({
  email,
  invitedBy,
  organisationId = null,
  organisationRole = 'developer',
  applicationId = null,
  roleId = null,
  grantsDeveloper = false,
  grantsStaff = false,
  message = '',
  ip = '',
}) {
  const norm = normaliseEmail(email);
  if (!norm) return { ok: false, error: 'That does not look like an email address.' };

  /*
   * An invitation to somebody who already has an account is fine and common —
   * it is how an existing user is granted developer access. What is refused is
   * a SECOND live invitation to the same address, because two links granting
   * different things is a race whose outcome depends on which one they click.
   */
  const existing = await db.one(
    `SELECT public_id FROM invitations
      WHERE email_norm = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()`,
    [norm],
  );
  if (existing) {
    return {
      ok: false,
      error: 'There is already an invitation waiting for that address. Revoke it first, or resend it.',
    };
  }

  const token = newToken(32);
  const publicId = newId();

  await db.execute(
    `INSERT INTO invitations
       (public_id, token_hash, email, email_norm, invited_by, organisation_id,
        organisation_role, application_id, role_id, grants_developer, grants_staff,
        message, expires_at, last_sent_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? DAY), NOW())`,
    [
      publicId,
      hashToken(token),
      String(email).trim().slice(0, 255),
      norm,
      invitedBy,
      organisationId,
      organisationRole,
      applicationId,
      roleId,
      grantsDeveloper ? 1 : 0,
      grantsStaff ? 1 : 0,
      String(message || '').slice(0, 500),
      TTL_DAYS,
    ],
  );

  const url = `${config.issuer}/invite/${token}`;
  await send({ email, url, message, invitedBy, grantsStaff, grantsDeveloper });

  await events.recordAudit({
    actorUserId: invitedBy,
    actorType: 'admin',
    action: 'invitation.created',
    targetType: 'invitation',
    targetId: publicId,
    detail: { email: norm, developer: !!grantsDeveloper, staff: !!grantsStaff },
    ip,
  });

  return { ok: true, publicId, url };
}

async function send({ email, url, message, invitedBy, grantsStaff, grantsDeveloper }) {
  const inviter = invitedBy
    ? await db.one('SELECT display_name FROM users WHERE id = ?', [invitedBy])
    : null;

  const what = grantsStaff
    ? 'administer Vesopa OAuth'
    : grantsDeveloper
      ? 'build applications on Vesopa OAuth'
      : 'use a Vesopa application';

  try {
    await mailer.sendSecurityNotice({
      to: email,
      heading: 'You have been invited to Vesopa',
      body:
        `${inviter && inviter.display_name ? inviter.display_name : 'Somebody at Vesopa'} has invited you to ${what}. ` +
        (message ? `They said: "${message}" ` : '') +
        `Open ${url} to accept. The link works for ${TTL_DAYS} days, and you will be asked to sign in — ` +
        'or to create an account, which is the same thing here.',
      when: new Date().toUTCString(),
      ip: '',
      device: '',
    });
  } catch (error) {
    // The invitation exists whether or not the mail went; an administrator can
    // resend or hand over the URL. Failing the whole thing would lose the row.
    console.error('[invitations] could not send:', error.message);
  }
}

/** The live invitation for this token, or null. */
async function findByToken(token) {
  if (!token) return null;
  return db.one(
    `SELECT i.*, o.name AS organisation_name, a.name AS application_name, r.name AS role_name
       FROM invitations i
       LEFT JOIN organisations o ON o.id = i.organisation_id
       LEFT JOIN applications a ON a.id = i.application_id
       LEFT JOIN application_roles r ON r.id = i.role_id
      WHERE i.token_hash = ? AND i.accepted_at IS NULL AND i.revoked_at IS NULL
        AND i.expires_at > NOW()`,
    [hashToken(token)],
  );
}

/**
 * Apply an invitation to somebody who has just proved who they are.
 *
 * THE ADDRESS MUST MATCH. An invitation sent to alice@ that is accepted by a
 * session belonging to bob@ grants Bob what Alice was offered — which is how a
 * forwarded email becomes an administrator. The check is the point of the
 * whole flow, so it is here rather than in a route where it could be forgotten.
 */
async function accept(token, userId, { ip = '' } = {}) {
  const invitation = await findByToken(token);
  if (!invitation) return { ok: false, error: 'expired' };

  const holds = await db.one(
    `SELECT id FROM user_identities
      WHERE user_id = ? AND type = 'email' AND identifier_norm = ? AND revoked_at IS NULL
        AND verified_at IS NOT NULL`,
    [userId, invitation.email_norm],
  );
  if (!holds) return { ok: false, error: 'wrong_account', invitation };

  await db.transaction(async (tx) => {
    if (invitation.grants_developer) {
      await tx.execute('UPDATE users SET is_developer = 1 WHERE id = ?', [userId]);
    }
    if (invitation.grants_staff) {
      await tx.execute('UPDATE users SET is_staff = 1 WHERE id = ?', [userId]);
    }

    if (invitation.organisation_id) {
      await tx.execute(
        `INSERT INTO organisation_members (organisation_id, user_id, role)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE role = VALUES(role)`,
        [invitation.organisation_id, userId, invitation.organisation_role || 'developer'],
      );
    }

    if (invitation.application_id) {
      await tx.execute(
        `INSERT INTO application_members (application_id, user_id, status)
         VALUES (?, ?, 'active')
         ON DUPLICATE KEY UPDATE status = 'active'`,
        [invitation.application_id, userId],
      );
      if (invitation.role_id) {
        await tx.execute(
          `INSERT IGNORE INTO application_member_roles (member_id, role_id)
           SELECT m.id, ? FROM application_members m
            WHERE m.application_id = ? AND m.user_id = ?`,
          [invitation.role_id, invitation.application_id, userId],
        );
      }
    }

    await tx.execute(
      'UPDATE invitations SET accepted_at = NOW(), accepted_user_id = ? WHERE id = ?',
      [userId, invitation.id],
    );
  });

  await events.recordAudit({
    actorUserId: userId,
    action: 'invitation.accepted',
    targetType: 'invitation',
    targetId: invitation.public_id,
    detail: {
      developer: !!invitation.grants_developer,
      staff: !!invitation.grants_staff,
      application: invitation.application_name || null,
    },
    ip,
  });

  return { ok: true, invitation };
}

async function list({ includeSettled = false } = {}) {
  return db.query(
    `SELECT i.*, u.display_name AS invited_by_name,
            o.name AS organisation_name, a.name AS application_name
       FROM invitations i
       LEFT JOIN users u ON u.id = i.invited_by
       LEFT JOIN organisations o ON o.id = i.organisation_id
       LEFT JOIN applications a ON a.id = i.application_id
      ${includeSettled ? '' : 'WHERE i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > NOW()'}
      ORDER BY i.created_at DESC
      LIMIT 100`,
  );
}

async function revoke(publicId, actorUserId, ip = '') {
  const invitation = await db.one('SELECT * FROM invitations WHERE public_id = ?', [publicId]);
  if (!invitation) return { ok: false };
  await db.execute('UPDATE invitations SET revoked_at = NOW() WHERE id = ? AND revoked_at IS NULL', [
    invitation.id,
  ]);
  await events.recordAudit({
    actorUserId,
    actorType: 'admin',
    action: 'invitation.revoked',
    targetType: 'invitation',
    targetId: publicId,
    ip,
  });
  return { ok: true };
}

/**
 * Send it again — with a NEW token, and the old one dead.
 *
 * Resending the same link would mean a token that has now been in two mailboxes
 * and possibly two forwarded chains. A fresh one costs nothing and means the
 * copy in the first email stops working.
 */
async function resend(publicId, actorUserId, ip = '') {
  const invitation = await db.one(
    `SELECT * FROM invitations
      WHERE public_id = ? AND accepted_at IS NULL AND revoked_at IS NULL`,
    [publicId],
  );
  if (!invitation) return { ok: false, error: 'That invitation is no longer waiting.' };

  const token = newToken(32);
  await db.execute(
    `UPDATE invitations
        SET token_hash = ?, expires_at = DATE_ADD(NOW(), INTERVAL ? DAY),
            sent_count = sent_count + 1, last_sent_at = NOW()
      WHERE id = ?`,
    [hashToken(token), TTL_DAYS, invitation.id],
  );

  const url = `${config.issuer}/invite/${token}`;
  await send({
    email: invitation.email,
    url,
    message: invitation.message,
    invitedBy: invitation.invited_by,
    grantsStaff: invitation.grants_staff,
    grantsDeveloper: invitation.grants_developer,
  });

  await events.recordAudit({
    actorUserId,
    actorType: 'admin',
    action: 'invitation.resent',
    targetType: 'invitation',
    targetId: publicId,
    ip,
  });

  return { ok: true, url };
}

module.exports = { create, findByToken, accept, list, revoke, resend, TTL_DAYS };
