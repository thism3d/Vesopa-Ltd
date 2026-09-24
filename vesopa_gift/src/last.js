/**
 * Who this browser last signed in as, so the button can say "Continue as …".
 *
 * A name and an address in a cookie -- what the person would see on the page
 * anyway -- and never a credential: pressing the button still goes through
 * Vesopa Auth, which decides whether that account is signed in there. The
 * address rides along as login_hint so Auth picks the right one of several
 * without asking, exactly as Google's "Continue as" does. "Use another
 * account" asks Auth for its chooser instead.
 */

const config = require('./config');

function name(kind) {
  return `${config.production ? '__Host-' : ''}vg_last_${kind}`;
}

function read(req, kind) {
  const raw = req.cookies && req.cookies[name(kind)];
  if (!raw) return null;
  try {
    const v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (!v || typeof v.e !== 'string' || !v.e.includes('@')) return null;
    return { email: v.e.toLowerCase().slice(0, 190), name: String(v.n || '').slice(0, 120) };
  } catch {
    return null;
  }
}

function write(res, kind, person) {
  if (!person || !person.email) return;
  res.cookie(name(kind), Buffer.from(JSON.stringify({ e: person.email, n: person.name || '' })).toString('base64url'), {
    httpOnly: true, secure: config.production, sameSite: 'lax', path: '/', maxAge: 180 * 86400 * 1000,
  });
}

function forget(res, kind) {
  res.clearCookie(name(kind), { path: '/' });
}

module.exports = { read, write, forget };
