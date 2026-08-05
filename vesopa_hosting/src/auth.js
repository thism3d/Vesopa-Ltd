/**
 * Sessions and credentials, for customers and for staff.
 *
 * Sessions are stateless signed cookies rather than rows in a table. The payload
 * is tiny (an id, an issue time), the signature is HMAC-SHA256 over a secret
 * that never leaves the server, and comparison is constant-time. That buys
 * horizontal scale for free and means a restart does not log everybody out.
 *
 * The cost is that a session cannot be revoked server-side before it expires.
 * Handled by carrying `pwv` — a fingerprint of the password hash — in the
 * payload: changing a password changes the fingerprint, which invalidates every
 * cookie already issued. That is the one revocation case that actually matters.
 */

const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const CUSTOMER_COOKIE = 'vh_session';
const ADMIN_COOKIE = 'vh_admin';

const CUSTOMER_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const ADMIN_TTL_MS = 12 * 60 * 60 * 1000; //          12 hours

function secretFor(kind) {
  const name = kind === 'admin' ? 'ADMIN_SESSION_SECRET' : 'SESSION_SECRET';
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name} (generate with: openssl rand -hex 32)`);
  }
  return value;
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');

function sign(payload, kind) {
  const body = b64url(JSON.stringify(payload));
  const mac = crypto.createHmac('sha256', secretFor(kind)).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function verify(token, kind) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;

  const expected = crypto.createHmac('sha256', secretFor(kind)).update(body).digest('base64url');
  // Length check first: timingSafeEqual throws on a length mismatch, and that
  // throw would itself be a timing signal.
  if (mac.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * A short fingerprint of the stored password hash.
 *
 * Changing a password rewrites the hash, which changes this, which makes every
 * previously-issued cookie fail validation. That is how "sign out everywhere"
 * works without a session table.
 */
function passwordVersion(passwordHash) {
  return crypto.createHash('sha256').update(String(passwordHash || '')).digest('hex').slice(0, 12);
}

function cookieOptions(maxAge) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    // Set only over TLS. In development the site is plain http, and a Secure
    // cookie there is set and then never sent back — which looks exactly like a
    // broken login.
    secure: process.env.NODE_ENV === 'production',
    maxAge,
    path: '/',
  };
}

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

const BCRYPT_ROUNDS = 12;

async function hashPassword(plain) {
  return bcrypt.hash(String(plain), BCRYPT_ROUNDS);
}

async function checkPassword(plain, hash) {
  if (!hash) {
    // Still spend the time. Returning early on an unknown email tells an
    // attacker which addresses exist, purely from how fast the answer comes.
    await bcrypt.compare(String(plain), '$2b$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin');
    return false;
  }
  return bcrypt.compare(String(plain), hash);
}

/**
 * Password rules, stated as what is wrong rather than as a regex the customer
 * has to reverse-engineer.
 */
function passwordProblem(password) {
  const p = String(password || '');
  if (p.length < 10) return 'Use at least 10 characters.';
  if (p.length > 200) return 'That password is too long.';
  if (!/[a-z]/i.test(p)) return 'Include at least one letter.';
  if (!/[0-9]/.test(p)) return 'Include at least one number.';
  // The passwords that actually get broken are the common ones, not the ones
  // missing a symbol.
  const common = ['password', '12345678', 'qwerty', 'letmein', 'welcome', 'admin123', 'changeme'];
  if (common.some((c) => p.toLowerCase().includes(c))) return 'That password is too easy to guess.';
  return null;
}

/** A strong password for a service account nobody has to type. */
function generatePassword(length = 20) {
  const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length];
  // Guarantee the classes Hestia's own validator insists on.
  return `${out}!7Aa`.slice(0, length + 4);
}

// ---------------------------------------------------------------------------
// Single-use tokens (verify, reset)
// ---------------------------------------------------------------------------

/**
 * Returns the token to email and the hash to store. The database only ever
 * holds the hash, so a leaked backup is not a set of working reset links.
 */
function newToken() {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, hash: crypto.createHash('sha256').update(token).digest('hex') };
}

const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

// ---------------------------------------------------------------------------
// CSRF
// ---------------------------------------------------------------------------

/**
 * Double-submit cookie. The token is signed with the session secret and tied to
 * nothing else, so it survives a load balancer and needs no server state.
 *
 * SameSite=lax already blocks the cross-site POST this defends against in every
 * browser we support; this is the belt to that pair of braces.
 */
function csrfToken(req, res) {
  let token = req.cookies?.vh_csrf;
  if (!token) {
    token = crypto.randomBytes(24).toString('base64url');
    res.cookie('vh_csrf', token, { ...cookieOptions(CUSTOMER_TTL_MS), httpOnly: false });
  }
  return token;
}

function checkCsrf(req) {
  const cookie = req.cookies?.vh_csrf;
  const sent = req.body?._csrf || req.get('X-CSRF-Token');
  if (!cookie || !sent) return false;
  if (cookie.length !== String(sent).length) return false;
  return crypto.timingSafeEqual(Buffer.from(cookie), Buffer.from(String(sent)));
}

// ---------------------------------------------------------------------------
// Issue / read / clear
// ---------------------------------------------------------------------------

function issueCustomerSession(res, customer) {
  const token = sign(
    {
      sub: customer.id,
      pwv: passwordVersion(customer.password_hash),
      iat: Date.now(),
      exp: Date.now() + CUSTOMER_TTL_MS,
    },
    'customer',
  );
  res.cookie(CUSTOMER_COOKIE, token, cookieOptions(CUSTOMER_TTL_MS));
}

function issueAdminSession(res, admin) {
  const token = sign(
    {
      sub: admin.id,
      pwv: passwordVersion(admin.password_hash),
      role: admin.role,
      iat: Date.now(),
      exp: Date.now() + ADMIN_TTL_MS,
    },
    'admin',
  );
  res.cookie(ADMIN_COOKIE, token, cookieOptions(ADMIN_TTL_MS));
}

const readCustomerSession = (req) => verify(req.cookies?.[CUSTOMER_COOKIE], 'customer');
const readAdminSession = (req) => verify(req.cookies?.[ADMIN_COOKIE], 'admin');

function clearCustomerSession(res) {
  res.clearCookie(CUSTOMER_COOKIE, { path: '/' });
}
function clearAdminSession(res) {
  res.clearCookie(ADMIN_COOKIE, { path: '/' });
}

module.exports = {
  CUSTOMER_COOKIE,
  ADMIN_COOKIE,
  CUSTOMER_TTL_MS,
  ADMIN_TTL_MS,
  hashPassword,
  checkPassword,
  passwordProblem,
  generatePassword,
  passwordVersion,
  newToken,
  hashToken,
  csrfToken,
  checkCsrf,
  issueCustomerSession,
  issueAdminSession,
  readCustomerSession,
  readAdminSession,
  clearCustomerSession,
  clearAdminSession,
};
