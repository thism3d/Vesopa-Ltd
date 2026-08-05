/**
 * Admin sessions for /admin.
 *
 * What the PHP did, and why none of it survives:
 *
 *   - the login query interpolated the username and password straight into SQL,
 *     so `" OR "1"="1` logged anyone in as the first admin;
 *   - passwords were stored and compared in plaintext;
 *   - the session was three cookies holding the name, username and role,
 *     AES-encrypted with a key committed to the repo — anyone with the source
 *     could mint a cookie saying they were an Admin.
 *
 * Here: parameterised queries, bcrypt, and one HMAC-signed cookie whose key
 * lives in the environment. Layout and screens are unchanged.
 */

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { pool } = require('./db');

const COOKIE = 'vesopa_admin';
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // matched to the PHP's one-day cookie

function secret() {
  const value = process.env.SESSION_SECRET;
  if (!value) throw new Error('Missing required environment variable: SESSION_SECRET');
  return value;
}

function sign(payloadB64) {
  return crypto.createHmac('sha256', secret()).update(payloadB64).digest('base64url');
}

function issue(res, admin) {
  const payload = {
    id: admin.id,
    username: admin.username,
    fullname: admin.fullname,
    status: admin.status,
    exp: Date.now() + MAX_AGE_MS,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');

  res.cookie(COOKIE, `${body}.${sign(body)}`, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: MAX_AGE_MS,
    path: '/',
  });
}

function clear(res) {
  res.clearCookie(COOKIE, { path: '/' });
}

/** Returns the session payload, or null if absent, tampered with or expired. */
function read(req) {
  const raw = req.cookies && req.cookies[COOKIE];
  if (!raw) return null;

  const [body, signature] = raw.split('.');
  if (!body || !signature) return null;

  const expected = sign(body);
  // timingSafeEqual throws on a length mismatch, which a forged cookie can cause.
  if (
    signature.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  ) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * Check a submitted password against the stored one.
 *
 * Rows migrated from the PHP database hold plaintext. Those are accepted once,
 * then immediately re-stored as bcrypt, so the table converts itself as people
 * log in and no admin has to be told to reset anything.
 */
async function verifyPassword(admin, submitted) {
  const stored = admin.password || '';

  if (stored.startsWith('$2')) {
    return bcrypt.compare(submitted, stored);
  }

  // Legacy plaintext. Compared without early exit so the comparison does not
  // leak the password's length or prefix through timing.
  const a = Buffer.from(stored);
  const b = Buffer.from(submitted);
  const matches = a.length === b.length && crypto.timingSafeEqual(a, b);

  if (matches) {
    const hash = await bcrypt.hash(submitted, 12);
    await pool.query('UPDATE admin_table SET password = ? WHERE id = ?', [hash, admin.id]);
    console.log(`[admin] upgraded stored password to bcrypt for "${admin.username}"`);
  }
  return matches;
}

/**
 * Authenticate a username/password pair.
 * Returns the admin row on success, null otherwise — deliberately without
 * saying which half was wrong.
 */
async function authenticate(username, password) {
  const [rows] = await pool.query(
    'SELECT id, fullname, username, password, status FROM admin_table WHERE username = ? AND enabled = ?',
    [username, 'Y']
  );
  if (!rows.length) {
    // Spend roughly the time a real check would, so a missing username is not
    // distinguishable from a wrong password by how fast we answer.
    await bcrypt.hash(password, 12);
    return null;
  }

  const admin = rows[0];
  return (await verifyPassword(admin, password)) ? admin : null;
}

/**
 * Gate for every /admin route except the login page.
 * Re-reads the admin from the database on each request, so a deleted or
 * disabled account stops working immediately instead of when its cookie lapses.
 */
async function requireAdmin(req, res, next) {
  const session = read(req);
  if (!session) return res.redirect('/admin');

  try {
    const [rows] = await pool.query(
      'SELECT id, fullname, username, status, enabled FROM admin_table WHERE id = ?',
      [session.id]
    );
    if (!rows.length || rows[0].enabled !== 'Y') {
      clear(res);
      return res.redirect('/admin');
    }

    req.admin = rows[0];
    // Every admin template shows the signed-in name and hides the "All Admins"
    // panel from Subadmins.
    res.locals.admin = rows[0];
    next();
  } catch (e) {
    next(e);
  }
}

/** Guard for the actions only a full Admin may take. */
function requireFullAdmin(req, res, next) {
  if (!req.admin || req.admin.status !== 'Admin') {
    return res.status(403).send('You do not have permission to do that.');
  }
  next();
}

module.exports = { issue, clear, read, authenticate, requireAdmin, requireFullAdmin, COOKIE };
