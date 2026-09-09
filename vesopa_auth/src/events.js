/**
 * Writing down what happened.
 *
 * TWO LOGS, ON PURPOSE.
 *
 * `login_events` answers "who tried to get in, how, and did it work" — it is
 * what the person sees on their own history page and what the analytics
 * dashboard is built from.
 *
 * `audit_log` answers "what did somebody DO once inside" — an admin resetting a
 * factor, a developer rotating a secret, a person unlinking Google. Admin-
 * assisted recovery is only safe because this table exists; without it, the
 * support route is an unobservable way into any account.
 *
 * NEITHER EVER BLOCKS A SIGN-IN. Every function here swallows its own errors
 * and reports to the console. A full disk or a locked table must not be able to
 * stop people logging in — an identity provider that fails closed on its
 * logging is an identity provider that is down.
 */

const db = require('./db');

/** Something a person tried, whether or not it worked. */
async function recordLogin({
  userId = null,
  applicationId = null,
  sessionId = null,
  method,
  outcome,
  failureReason = '',
  identifier = '',
  ip = '',
  country = '',
  userAgent = '',
  deviceId = null,
}) {
  try {
    await db.execute(
      `INSERT INTO login_events
         (user_id, application_id, session_id, method, outcome, failure_reason,
          identifier_shown, ip, country, user_agent, device_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId,
        applicationId,
        sessionId,
        method,
        outcome,
        String(failureReason).slice(0, 60),
        String(identifier).slice(0, 255),
        String(ip).slice(0, 45),
        String(country).slice(0, 2),
        String(userAgent).slice(0, 400),
        deviceId,
      ],
    );
  } catch (error) {
    console.error('[events] login event not written:', error.message);
  }
}

/** Something somebody changed. */
async function recordAudit({
  actorUserId = null,
  actorType = 'user',
  action,
  targetType = '',
  targetId = '',
  applicationId = null,
  detail = null,
  ip = '',
  userAgent = '',
}) {
  try {
    await db.execute(
      `INSERT INTO audit_log
         (actor_user_id, actor_type, action, target_type, target_id,
          application_id, detail, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        actorUserId,
        actorType,
        String(action).slice(0, 64),
        String(targetType).slice(0, 40),
        String(targetId).slice(0, 64),
        applicationId,
        detail ? JSON.stringify(detail) : null,
        String(ip).slice(0, 45),
        String(userAgent).slice(0, 400),
      ],
    );
  } catch (error) {
    console.error('[events] audit entry not written:', error.message);
  }
}

module.exports = { recordLogin, recordAudit };
