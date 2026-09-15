/**
 * Accounts this browser has used, whether or not they are signed in now.
 *
 * The roster (accounts.js) is the accounts signed in HERE, held as session
 * tokens; when the last one signs out the roster is empty and the chooser had
 * nothing to show. This is the other half of what Google's chooser does: the
 * accounts it has seen in this browser stay listed, marked "signed out", and
 * picking one goes straight to that account's own sign-in rather than an empty
 * address box. Switching back after signing out becomes one tap and a code.
 *
 * NOTHING IN IT IS A SECRET OR A CREDENTIAL. An address, a display name, an
 * avatar path and a time -- what the person themselves would see on the
 * chooser -- and holding them proves nothing: the row leads to the sign-in
 * page with the address filled in, and every factor still has to be met. That
 * is why it may sit in a cookie for six months. It is still `__Host-`,
 * HttpOnly and Secure like the rest, because it is a list of who uses this
 * browser and that is nobody else's to read.
 *
 * "Remove" on the chooser forgets one; signing out does not, on purpose.
 */

const config = require('./config');
const db = require('./db');

const COOKIE = config.isProduction ? '__Host-vesopa_recent' : 'vesopa_recent';
const MAX = 8;
const DAYS = 180;

function cookieOptions() {
  return { httpOnly: true, secure: config.isProduction, sameSite: 'lax', path: '/', maxAge: DAYS * 86400 * 1000 };
}

/** Whatever is in the cookie, as a clean list. Never throws. */
function list(req) {
  const value = req.cookies ? req.cookies[COOKIE] : null;
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((e) => e && typeof e.e === 'string' && e.e.includes('@') && e.e.length <= 190)
      .map((e) => ({
        email: e.e.toLowerCase(),
        name: typeof e.n === 'string' ? e.n.slice(0, 120) : '',
        avatar: typeof e.a === 'string' && /^\/[A-Za-z0-9_\-./]{1,200}$/.test(e.a) ? e.a : '',
        at: Number(e.t) || 0,
      }))
      .slice(0, MAX);
  } catch {
    return [];
  }
}

function write(res, entries) {
  const compact = entries.slice(0, MAX).map((e) => ({ e: e.email, n: e.name, a: e.avatar, t: e.at }));
  if (!compact.length) return res.clearCookie(COOKIE, cookieOptions());
  return res.cookie(COOKIE, JSON.stringify(compact), cookieOptions());
}

/** Put one account at the front, written only when something changed. */
function remember(req, res, { email, name = '', avatar = '' }) {
  if (!res || !email) return;
  const e = String(email).toLowerCase();
  const had = list(req);
  const existing = had.find((x) => x.email === e);
  const fresh = { email: e, name: String(name || '').slice(0, 120), avatar: avatar || '', at: Date.now() };
  const same = existing && had[0] === existing && existing.name === fresh.name && existing.avatar === fresh.avatar
    && Date.now() - existing.at < 6 * 3600 * 1000;
  if (same) return;
  write(res, [fresh, ...had.filter((x) => x.email !== e)]);
  // Later reads on this same request see the change too.
  if (req.cookies) req.cookies[COOKIE] = JSON.stringify([fresh, ...had.filter((x) => x.email !== e)].map((x) => ({ e: x.email, n: x.name, a: x.avatar, t: x.at })));
}

/** The same, from a user id: one query for the name, the address and the face. */
async function rememberUser(req, res, userId) {
  if (!res || !userId) return;
  try {
    const rows = await db.query(
      `SELECT u.display_name, u.avatar_path,
              COALESCE(
                (SELECT i.identifier FROM user_identities i WHERE i.id = u.primary_email_id AND i.revoked_at IS NULL),
                (SELECT i2.identifier FROM user_identities i2
                  WHERE i2.user_id = u.id AND i2.type = 'email' AND i2.revoked_at IS NULL AND i2.is_recovery = 0
                  ORDER BY i2.verified_at IS NULL, i2.id LIMIT 1)
              ) AS email
         FROM users u WHERE u.id = ? AND u.status = 'active'`,
      [userId],
    );
    const u = rows[0];
    if (u && u.email) remember(req, res, { email: u.email, name: u.display_name, avatar: u.avatar_path });
  } catch {
    // A chooser convenience must never break a sign-in.
  }
}

function forget(req, res, email) {
  const e = String(email || '').toLowerCase();
  write(res, list(req).filter((x) => x.email !== e));
}

module.exports = { COOKIE, MAX, list, remember, rememberUser, forget };
