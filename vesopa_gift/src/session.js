/**
 * The staff console's sessions.
 *
 * A random token in a __Host- cookie -- Secure, HttpOnly, SameSite=Lax, bound to
 * this exact host -- and its SHA-256 in gift_sessions. Nothing in the cookie
 * means anything on its own, so there is no signing key to leak, and signing
 * somebody out is deleting a row.
 *
 * WHAT A SESSION MAY DO is re-read from its row on every request: the roles Auth
 * gave at sign-in, and the venues gift_staff names for that email. A venue
 * removed from somebody takes effect on their next click, not when their
 * cookie lapses.
 *
 * Every form carries the session's CSRF token. SameSite=Lax already stops a
 * cross-site POST carrying the cookie; the token is the second lock, because a
 * console that can refund money should not rely on one browser behaviour.
 */

const crypto = require('crypto');
const db = require('./db');
const config = require('./config');

const COOKIE = config.production ? '__Host-vg_sid' : 'vg_sid';
const HOURS = 12;

const hash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

async function create(res, person, ip) {
  const tokenValue = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(16).toString('hex');
  await db.run(
    `INSERT INTO gift_sessions (id, sub, email, name, roles, csrf, ip, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? HOUR))`,
    [hash(tokenValue), person.sub, person.email, person.name, person.roles.join(','), csrf,
      String(ip || '').slice(0, 45), HOURS]
  );
  res.cookie(COOKIE, tokenValue, {
    httpOnly: true,
    secure: config.production,
    sameSite: 'lax',
    path: '/',
    maxAge: HOURS * 3600 * 1000,
  });
}

async function read(req) {
  const raw = req.cookies && req.cookies[COOKIE];
  if (!raw) return null;
  const row = await db.one(
    `SELECT * FROM gift_sessions WHERE id = ? AND revoked_at IS NULL AND expires_at > UTC_TIMESTAMP()`,
    [hash(raw)]
  );
  if (!row) return null;
  const roles = String(row.roles || '').split(',').filter(Boolean);
  return {
    id: row.id,
    sub: row.sub,
    email: row.email,
    name: row.name || row.email || 'Signed in',
    roles,
    csrf: row.csrf,
    isOwner: roles.includes('owner'),
    isSupport: roles.includes('support'),
    everyVenue: roles.includes('owner') || roles.includes('support'),
  };
}

async function destroy(req, res) {
  const raw = req.cookies && req.cookies[COOKIE];
  if (raw) await db.run('UPDATE gift_sessions SET revoked_at = UTC_TIMESTAMP() WHERE id = ?', [hash(raw)]);
  res.clearCookie(COOKIE, { path: '/' });
}

function csrfOk(req, session) {
  // A multipart form (a picture upload) is not parsed until after this check
  // runs, so its token travels in the query string instead.
  const given = String((req.body && req.body._csrf) || req.get('x-csrf-token') || (req.query && req.query._csrf) || '');
  if (!session || given.length !== session.csrf.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(session.csrf));
}

module.exports = { create, read, destroy, csrfOk, COOKIE, hash };
