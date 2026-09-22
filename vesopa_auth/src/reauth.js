/**
 * "Confirm it is you" — proving the account again, without signing anybody out.
 *
 * WHAT IT IS FOR. Changing a recovery address is the single most valuable edit
 * on the whole account: whoever holds the recovery address gets the account back
 * after everything else is lost, so an attacker who has borrowed a signed-in
 * session — a shared computer, a phone left on a table, a stolen cookie —
 * changes it first and then locks the owner out at leisure. Every other change
 * on this site is reversible by the owner. That one is not.
 *
 * WHY IT IS NOT `/step-up`. Step-up raises the session's assurance and can only
 * be satisfied by a SECOND factor: an authenticator, a texted code, a recovery
 * code. Most people here have none of those enrolled, so demanding step-up for
 * this would mean the people most likely to be locked out are the only ones who
 * cannot set a recovery address — which is precisely backwards.
 *
 * So this accepts any ONE of:
 *
 *   the password, if they have one
 *   a code from the authenticator, if it is enrolled
 *   a code emailed to the address already on the account
 *
 * Each is a fresh demonstration, right now, that this is the owner and not
 * somebody who found the session. The emailed code is the one everybody can do,
 * and is exactly the proof an attacker holding only a session cookie cannot
 * produce.
 *
 * IT IS SHORT-LIVED ON PURPOSE. Fifteen minutes: long enough to change two
 * things without being asked twice, short enough that a session left open on a
 * counter is not permanently confirmed.
 */

const db = require('./db');

const WINDOW_MINUTES = 15;

/** Has this session proved itself recently enough? */
function fresh(session) {
  if (!session || !session.reauth_at) return false;
  const at = new Date(session.reauth_at).getTime();
  if (!Number.isFinite(at)) return false;
  return Date.now() - at < WINDOW_MINUTES * 60 * 1000;
}

/** Write the proof down. */
async function mark(sessionId) {
  await db.execute('UPDATE sso_sessions SET reauth_at = NOW() WHERE id = ?', [sessionId]);
}

/**
 * Guard a route. Returns true when the caller may carry on.
 *
 * Sends them to the confirmation page otherwise, with this URL to come back
 * to — so the interruption costs one step and never loses what they were doing.
 */
function guard(req, res, session) {
  if (fresh(session)) return true;
  res.redirect(303, `/account/confirm?next=${encodeURIComponent(req.originalUrl)}`);
  return false;
}

module.exports = { fresh, mark, guard, WINDOW_MINUTES };
