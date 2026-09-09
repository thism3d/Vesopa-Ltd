/**
 * More than one Vesopa account signed in at once, in one browser.
 *
 * WHAT IT IS FOR. A venue's manager holds a personal account and an
 * administrator account. A developer holds their own and a test one. Somebody
 * on a shared back-office machine is not the only person who uses it. Today
 * every one of those means signing out and back in, and signing out of Vesopa
 * signs you out of the till, the menu and the back office with it — so the cost
 * of looking at something as somebody else is losing four sessions.
 *
 * THE SHAPE, AND WHY IT IS THIS ONE
 *
 * `__Host-vesopa_sid` still holds exactly one session token: the ACTIVE one.
 * Every existing line of code that calls `sessions.load` is untouched and keeps
 * meaning "whoever is signed in right now". That is deliberate — a change that
 * made "who is this?" ambiguous across a hundred call sites on an identity
 * provider would be a bad trade for a convenience.
 *
 * Beside it, `__Host-vesopa_accounts` holds the whole roster: the session
 * TOKENS of every account signed in in this browser, the active one included.
 * Switching moves one of them into the session cookie. Signing out of one
 * removes it from the roster and revokes that session, and if it was the active
 * one the next in the roster takes over.
 *
 * WHY TOKENS AND NOT IDENTIFIERS. The obvious design is a list of session
 * public ids, which are short and not secret — and that is exactly the problem:
 * a public id is not evidence of anything, so a roster of them would let
 * anybody who could set a cookie switch into any session they could name.
 * Possession of the token IS the proof, precisely as it is for the single
 * session today, and the cookie carrying them has every protection that one
 * has: `__Host-`, HttpOnly, Secure, SameSite=Lax, path-locked.
 *
 * WHAT IT COSTS. Eight accounts of 43 characters is under 500 bytes, sent with
 * each request to this origin — against a 4KB limit and only on this domain.
 * The cap is what keeps that true; without one, a shared machine accumulates a
 * roster until requests start failing in ways nobody would connect to this.
 *
 * A ROSTER ENTRY IS NEVER TRUSTED ON ITS OWN. Every read verifies each token
 * against the database and drops the ones that are revoked, expired or belong
 * to a suspended account — so an account signed out on another device
 * disappears from the chooser here rather than offering a switch that fails.
 */

const config = require('./config');
const db = require('./db');
const sessions = require('./sessions');
const { hashToken } = require('./crypto');

const COOKIE = config.isProduction ? '__Host-vesopa_accounts' : 'vesopa_accounts';

/**
 * Eight.
 *
 * Not a technical limit — it is the number beyond which a chooser stops being
 * a list you recognise yourself in and becomes one you have to read. Google
 * uses a comparable bound for the same reason.
 */
const MAX = 8;

function cookieOptions(maxAgeMs) {
  return {
    httpOnly: true,
    secure: config.isProduction,
    // Lax for the same reason the session cookie is: arriving from a link in a
    // verification email must not drop the roster.
    sameSite: 'lax',
    path: '/',
    ...(maxAgeMs ? { maxAge: maxAgeMs } : {}),
  };
}

/** Whatever is in the cookie, as a list of strings. Never throws. */
function raw(req) {
  const value = req.cookies ? req.cookies[COOKIE] : null;
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((token) => typeof token === 'string' && token.length >= 20).slice(0, MAX);
  } catch {
    return [];
  }
}

function write(res, tokens) {
  if (!tokens.length) {
    res.clearCookie(COOKIE, cookieOptions());
    return;
  }
  /*
   * The roster outlives the browser even when the active session does not.
   *
   * A session that was not "remembered" dies with the browser, and that is the
   * promise made to somebody on a shared machine. The roster is not a
   * credential of its own — every token in it is checked against the database
   * and a dead one is dropped — so giving it a lifetime does not extend
   * anybody's session by a second. What it buys is that closing the laptop
   * does not silently reduce three accounts to one.
   */
  res.cookie(
    COOKIE,
    JSON.stringify(tokens.slice(0, MAX)),
    cookieOptions(config.session.rememberedDays * 24 * 3600 * 1000),
  );
}

/**
 * Every account signed in in this browser, checked and in order.
 *
 * Returns `[{ token, session, user, active }]`, newest sign-in last, with dead
 * entries dropped — and writes the pruned roster back, so a chooser never
 * offers a switch that cannot work and the cookie does not grow a tail of
 * tokens that stopped meaning anything weeks ago.
 */
async function list(req, res) {
  const tokens = raw(req);
  const activeToken = req.cookies ? req.cookies[sessions.SESSION_COOKIE] : null;

  // The active session is part of the roster whether or not the cookie says so
  // — a browser that signed in before this feature existed has one session and
  // an empty roster, and it must still see itself in the chooser.
  const wanted = [];
  for (const token of tokens) if (!wanted.includes(token)) wanted.push(token);
  if (activeToken && !wanted.includes(activeToken)) wanted.unshift(activeToken);
  if (!wanted.length) return [];

  /*
   * THE ADDRESS: the pointer first, then any verified one.
   *
   * `primary_email_id` is kept up to date by identity.ensurePrimary now, but an
   * account untouched since may still hold a null — and a chooser that says "no
   * address on this account" to somebody who plainly has one is the single most
   * confusing thing this page could do. The fallback costs one subquery and
   * cannot be wrong.
   *
   * It is written HERE rather than beside the COALESCE because that column list
   * is inside a template literal, and the backticks this paragraph needs would
   * have ended the string. They did, once, and the error named a line thirty
   * rows further down.
   */
  const rows = await db.query(
    `SELECT s.id, s.public_id, s.token_hash, s.user_id, s.acr, s.remembered,
            s.created_at, s.last_seen_at,
            u.public_id AS user_public_id, u.display_name, u.avatar_path, u.status AS user_status,
            COALESCE(
              (SELECT i.identifier FROM user_identities i
                WHERE i.id = u.primary_email_id AND i.revoked_at IS NULL),
              (SELECT i2.identifier FROM user_identities i2
                WHERE i2.user_id = u.id AND i2.type = 'email'
                  AND i2.revoked_at IS NULL AND i2.is_recovery = 0
                ORDER BY i2.verified_at IS NULL, i2.id LIMIT 1)
            ) AS email
       FROM sso_sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash IN (${wanted.map(() => '?').join(',')})
        AND s.revoked_at IS NULL
        AND s.expires_at > NOW() AND s.idle_expires_at > NOW()`,
    wanted.map(hashToken),
  );

  const byHash = new Map(rows.map((row) => [row.token_hash, row]));

  const live = [];
  const seenUsers = new Set();
  for (const token of wanted) {
    const row = byHash.get(hashToken(token));
    if (!row || row.user_status !== 'active') continue;
    /*
     * ONE ROW PER ACCOUNT, not per session.
     *
     * Signing into the same account twice — which happens the moment somebody
     * presses "Use another account" and then types the address they are
     * already signed in with — would otherwise put the same face in the
     * chooser twice and make the two indistinguishable.
     */
    if (seenUsers.has(row.user_id)) continue;
    seenUsers.add(row.user_id);
    live.push({ token, session: row, active: token === activeToken });
  }

  const kept = live.map((entry) => entry.token);
  if (res && (kept.length !== tokens.length || kept.some((t, i) => t !== tokens[i]))) {
    write(res, kept);
  }

  return live;
}

/** Put this session in the roster and make it the one in use. */
function add(res, roster, token) {
  const tokens = [token, ...roster.map((entry) => entry.token).filter((t) => t !== token)];
  write(res, tokens.slice(0, MAX));
}

/** Take one out — used when a session is signed out or has died. */
function remove(res, roster, token) {
  write(res, roster.map((entry) => entry.token).filter((t) => t !== token));
}

/** Everything goes: the roster cookie and nothing else. Sessions are the caller's. */
function clear(res) {
  res.clearCookie(COOKIE, cookieOptions());
}

/**
 * Is there room for another?
 *
 * Answered rather than enforced silently. Somebody who has hit the limit and is
 * told nothing simply finds that adding an account quietly drops a different
 * one, which on an identity provider looks like being signed out at random.
 */
function full(roster) {
  return roster.length >= MAX;
}

module.exports = { COOKIE, MAX, list, add, remove, clear, full, write };
