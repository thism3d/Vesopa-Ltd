/**
 * Sessions: a random token in a __Host- cookie (Secure, HttpOnly, SameSite=Lax)
 * and its SHA-256 in adm_sessions. What the session may do is re-read from
 * adm_admins on every request, so removing an admin takes effect on their next
 * click. Every form carries the session's CSRF token.
 */
const crypto = require('crypto');
const db = require('./db');
const config = require('./config');
const roles = require('./roles');

const COOKIE = config.production ? '__Host-va_sid' : 'va_sid';
const HOURS = 10;
const hash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

async function create(res, person, ip) {
  const token = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(16).toString('hex');
  await db.run(
    `INSERT INTO adm_sessions (id, email, name, csrf, ip, expires_at)
     VALUES (?, ?, ?, ?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? HOUR))`,
    [hash(token), person.email, person.name || null, csrf, String(ip || '').slice(0, 45), HOURS]
  );
  res.cookie(COOKIE, token, { httpOnly: true, secure: config.production, sameSite: 'lax', path: '/', maxAge: HOURS * 3600 * 1000 });
}

async function adminRow(email) {
  return db.one('SELECT * FROM adm_admins WHERE email = ?', [email]);
}

async function read(req) {
  const raw = req.cookies && req.cookies[COOKIE];
  if (!raw) return null;
  const row = await db.one(
    'SELECT * FROM adm_sessions WHERE id = ? AND revoked_at IS NULL AND expires_at > UTC_TIMESTAMP()',
    [hash(raw)]
  );
  if (!row) return null;
  const who = roles.principal({ email: row.email, name: row.name, row: await adminRow(row.email), ownerEmail: config.OWNER_EMAIL });
  if (!who.active) return null;
  return { ...who, id: row.id, csrf: row.csrf };
}

async function destroy(req, res) {
  const raw = req.cookies && req.cookies[COOKIE];
  if (raw) await db.run('UPDATE adm_sessions SET revoked_at = UTC_TIMESTAMP() WHERE id = ?', [hash(raw)]);
  res.clearCookie(COOKIE, { path: '/' });
}

function csrfOk(req, session) {
  const given = String((req.body && req.body._csrf) || req.get('x-csrf-token') || '');
  if (!session || given.length !== session.csrf.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(session.csrf));
}

module.exports = { create, read, destroy, csrfOk, adminRow, COOKIE, hash };
