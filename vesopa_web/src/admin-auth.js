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
  // Either the username or the email address. A contributor is created with an
  // address because that is what they are given, and the profile form caps a
  // username at 20 characters — shorter than most addresses, so storing one
  // there would truncate it into an account nobody could sign in to. An empty
  // parameter can never match a NULL email; see schema_admin_contributor.sql.
  const [rows] = await pool.query(
    `SELECT id, fullname, username, email, password, status
       FROM admin_table
      WHERE (username = ? OR email = ?) AND enabled = ?`,
    [username, username, 'Y']
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
      'SELECT id, fullname, username, email, status, enabled FROM admin_table WHERE id = ?',
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

/**
 * Someone who may add files and write blog posts, and nothing else.
 *
 * The panel had two roles and neither fits. 'Subadmin' was only ever "Admin,
 * minus the admin list" — it still reaches Offices & Billing, the Collection
 * ledger, every demo request and every customer's phone number. There was no
 * way to let somebody write a blog post without also handing them the billing
 * screens, which is what this role exists for.
 *
 * Defined by subtraction, and checked on the *routes* rather than on the
 * buttons. Hiding a link is a layout decision; a role is not enforced until the
 * endpoint behind the link refuses. That distinction is the one the PHP panel
 * got wrong — it hid admin management from Subadmins and left the routes wide
 * open — and it is worth not getting wrong twice.
 */
function isContributor(admin) {
  return !!admin && admin.status === 'Contributor';
}

/**
 * The only paths a contributor may reach. Everything else is refused.
 *
 * An allow-list, not a deny-list, and that is the whole design. A deny-list has
 * to be revisited every time a screen is added to the panel, and the failure
 * mode when somebody forgets is that the new screen is open to a role that was
 * never meant to see it. This way a screen nobody has thought about is denied,
 * which is the right default for a role defined by subtraction.
 *
 * `/settings` is on the list and is not a fourth feature: the admin list on
 * that page is already behind requireFullAdmin, so what a contributor gets
 * there is their own name and their own password. Locking somebody out of
 * changing their own password is not a permission, it is a trap.
 */
const CONTRIBUTOR_PATHS = /^\/(blog|blog-preview|files|settings|logout)(\/|$)/;

/**
 * Refuse a contributor anything outside that list.
 *
 * Mounted once, in front of the feature routers, rather than wrapped around
 * each of them — `router.use(guard, subRouter)` runs the guard on *every*
 * request that reaches it, not only the ones the sub-router handles, so
 * per-router mounts blocked the two screens the role exists for. That was
 * caught by driving the live panel rather than by reading the code, which is
 * the only way this class of Express mistake ever shows up.
 *
 * A redirect rather than a 403 on a GET: somebody following an old bookmark to
 * the dashboard should land where they can work, not on an error page about a
 * screen they will never be allowed to see. A POST gets the flat refusal,
 * because something has gone wrong if one is being submitted at all.
 */
function blockContributor(req, res, next) {
  if (!isContributor(req.admin)) return next();
  if (CONTRIBUTOR_PATHS.test(req.path)) return next();
  if (req.method === 'GET') return res.redirect('/admin/files');
  return res.status(403).send('You do not have permission to do that.');
}

/**
 * The `WHERE` a listing needs so a contributor sees only their own rows.
 *
 * Returns a fragment and its parameters rather than a string to interpolate:
 * `owner_admin_id` is a number off the session and would be safe either way,
 * but a helper that hands back SQL to paste together is one somebody later
 * passes a request parameter to.
 */
function ownScope(admin, column = 'owner_admin_id') {
  if (!isContributor(admin)) return { sql: '', params: [] };
  return { sql: ` AND ${column} = ?`, params: [admin.id] };
}

module.exports = {
  issue, clear, read, authenticate, requireAdmin, requireFullAdmin,
  isContributor, blockContributor, ownScope, COOKIE,
};
