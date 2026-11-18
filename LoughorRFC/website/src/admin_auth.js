/**
 * Who may use /admin: the club's editors, in data/users.json, each with a
 * password kept only as a scrypt hash.
 *
 * The first login is made at /admin/setup with ADMIN_SETUP_CODE from the
 * site's .env (scripts/remote-install.sh writes one and prints it while
 * there is nobody yet); that page closes once anyone exists. More editors
 * are added from the admin itself (Editors), by the owner.
 *
 * Signed in = a cookie holding who and until when, signed with
 * SESSION_SECRET (or data/.session-secret, made on first use). Changing a
 * password signs that person out everywhere. Every form carries a token
 * tied to the session, and a POST from another site is refused.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA } = require('./posts');

const USERS = path.join(DATA, 'users.json');
const COOKIE = 'prfc_admin';
const DAYS = 14;

function secret() {
  if (process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32) return process.env.SESSION_SECRET;
  const file = path.join(DATA, '.session-secret');
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    fs.mkdirSync(DATA, { recursive: true });
    const s = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(file, s, { mode: 0o600 });
    return s;
  }
}
const SECRET = secret();
const sign = (s) => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');
function same(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ---- People ----------------------------------------------------------------------

function load() {
  try { return JSON.parse(fs.readFileSync(USERS, 'utf8')).users || []; } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}
function store(users) {
  fs.mkdirSync(DATA, { recursive: true });
  const tmp = `${USERS}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ users }, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, USERS);
}
const users = () => load().map(({ hash, salt, ...u }) => u);
const anyone = () => load().length > 0;

const hashOf = (password, salt) => crypto.scryptSync(String(password), salt, 64, { N: 16384, r: 8, p: 1 }).toString('base64');

function checkPassword(pw) {
  if (String(pw || '').length < 10) throw new Error('Use a password of at least 10 characters.');
}

function addUser({ email, name, password, role = 'editor' }) {
  const list = load();
  email = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter an email address.');
  if (list.some((u) => u.email === email)) throw new Error('There is already a login for that email address.');
  checkPassword(password);
  const salt = crypto.randomBytes(16).toString('base64');
  const user = {
    id: crypto.randomBytes(6).toString('hex'), email, name: String(name || '').trim().slice(0, 60) || email.split('@')[0],
    role: role === 'owner' ? 'owner' : 'editor', ver: 1, created: new Date().toISOString(), salt, hash: hashOf(password, salt),
  };
  list.push(user);
  store(list);
  return user;
}

function setPassword(id, password) {
  checkPassword(password);
  const list = load();
  const u = list.find((x) => x.id === id);
  if (!u) throw new Error('No such login.');
  u.salt = crypto.randomBytes(16).toString('base64');
  u.hash = hashOf(password, u.salt);
  u.ver += 1;
  store(list);
}

function removeUser(id) {
  const list = load();
  const u = list.find((x) => x.id === id);
  if (!u) return;
  if (u.role === 'owner' && list.filter((x) => x.role === 'owner').length === 1) throw new Error('The last owner cannot be removed.');
  store(list.filter((x) => x.id !== id));
}

function verify(email, password) {
  const u = load().find((x) => x.email === String(email || '').trim().toLowerCase());
  // The same work whether or not the email exists, so it cannot be told apart.
  const h = hashOf(password, u ? u.salt : 'no-such-user');
  return u && same(h, u.hash) ? u : null;
}

// ---- Too many tries --------------------------------------------------------------

const tries = new Map();
const LIMIT = 8;
const WINDOW = 15 * 60 * 1000;
function blocked(key, limit = LIMIT) {
  const t = tries.get(key);
  if (t && t.until < Date.now()) tries.delete(key);
  return (tries.get(key) || { n: 0 }).n >= limit;
}
function failed(key) {
  const t = tries.get(key) || { n: 0, until: Date.now() + WINDOW };
  t.n += 1;
  tries.set(key, t);
}

// ---- The session -----------------------------------------------------------------

function issue(res, user, req) {
  const exp = Date.now() + DAYS * 864e5;
  const body = Buffer.from(JSON.stringify({ u: user.id, v: user.ver, exp })).toString('base64url');
  res.cookie(COOKIE, `${body}.${sign(body)}`, {
    httpOnly: true, sameSite: 'strict', secure: req.secure, path: '/admin', maxAge: DAYS * 864e5,
  });
}
const clear = (res) => res.clearCookie(COOKIE, { path: '/admin' });

function readCookie(req) {
  const raw = String(req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`));
  if (!raw) return null;
  const [body, mac] = raw.slice(COOKIE.length + 1).split('.');
  if (!body || !mac || !same(sign(body), mac)) return null;
  try {
    const s = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (s.exp < Date.now()) return null;
    const u = load().find((x) => x.id === s.u && x.ver === s.v);
    if (!u) return null;
    const { hash, salt, ...user } = u;
    return { user, token: sign(`csrf.${body}`) };
  } catch {
    return null;
  }
}

/** A POST must come from this site's own pages. */
function sameSite(req) {
  const from = req.get('origin') || req.get('referer') || '';
  if (!from) return true; // some browsers send neither; the token below still has to match
  try { return new URL(from).host === req.get('host'); } catch { return false; }
}

/** Signed in, or off to the sign-in page; POSTs need the form's token too. */
function required(req, res, next) {
  const s = readCookie(req);
  if (!s) {
    if (req.method !== 'GET') return res.status(401).json({ error: 'You have been signed out. Sign in again (your work is still in this page).' });
    return res.redirect(303, `/admin/login?next=${encodeURIComponent(req.originalUrl)}`);
  }
  req.admin = s.user;
  res.locals.csrf = s.token;
  if (req.method !== 'GET') {
    const t = String((req.body && req.body._csrf) || req.get('x-csrf-token') || '');
    if (!sameSite(req) || !same(t, s.token)) return res.status(403).type('text/plain').send('This form has expired. Go back, reload the page and try again.');
  }
  return next();
}

const SETUP_CODE = () => String(process.env.ADMIN_SETUP_CODE || '');

module.exports = {
  users, anyone, addUser, setPassword, removeUser, verify, blocked, failed, issue, clear, readCookie, required, sameSite, SETUP_CODE, same,
};
