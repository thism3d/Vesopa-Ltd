const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// The default when a caller does not ask for anything else — a working day.
// /api/login overrides it for "Keep me signed in".
const TOKEN_TTL = '12h';

// A commissioned till's own credential. Deliberately far longer than any
// browser session: a terminal is set up once and then runs for months without
// anyone signing into it, and the thing it needs the token *for* is unlocking
// itself when a member of staff types their PIN. A terminal that silently
// stopped being able to do that after twelve hours would be a till that cannot
// sell, discovered mid-service.
const TERMINAL_TOKEN_TTL = '3650d';

/**
 * The credentials were right, but the account may not sign in — unapproved, or
 * its office is paused. Typed rather than string-matched, so the route can
 * answer 403 instead of falling through to a 500.
 */
class AccessDeniedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AccessDeniedError';
  }
}

/**
 * Back-office login.
 *
 * The legacy PHP stored passwords in PLAINTEXT. Rather than lock those users
 * out, a correct plaintext password is accepted once and immediately re-saved
 * as a bcrypt hash, so every login silently upgrades the account and the
 * plaintext disappears from the database over time.
 */
async function verifyPassword(pool, email, password) {
  const [rows] = await pool.execute(
    `SELECT u.id, u.email, u.name, u.password, u.approved, u.role, u.office_id,
            o.status AS office_status, o.name AS office_name,
            o.contact_email AS office_email
     FROM backoffice_users u
     LEFT JOIN offices o ON o.id = u.office_id
     WHERE u.email = ?`,
    [email]
  );
  if (rows.length === 0) return null;

  const user = rows[0];
  const stored = user.password || '';
  const isHashed = stored.startsWith('$2');

  if (isHashed) {
    if (!(await bcrypt.compare(password, stored))) return null;
  } else {
    // Legacy plaintext. Compare, then upgrade.
    if (stored !== password) return null;
    const hash = await bcrypt.hash(password, 12);
    await pool.execute('UPDATE backoffice_users SET password = ? WHERE id = ?', [
      hash,
      user.id,
    ]);
  }

  if (user.approved !== 'Y') {
    throw new AccessDeniedError('This account has not been approved.');
  }

  // A paused office cannot sign in. The platform admin has no office and is
  // deliberately exempt, or a billing dispute could lock out the person who
  // needs to resolve it.
  if (user.role !== 'admin' && user.office_status && user.office_status !== 'active') {
    throw new AccessDeniedError(
      `This office is ${user.office_status}. Please contact Vesopa support.`
    );
  }

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role || 'office',
    officeId: user.office_id,
    officeName: user.office_name,
    // The tenant key. A till signs in with a user account but sells from the
    // office's catalogue, which is keyed by this address.
    officeEmail: user.office_email,
  };
}

function issueToken(user, secret, ttl = TOKEN_TTL) {
  return jwt.sign(
    {
      sub: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      officeId: user.officeId,
    },
    secret,
    { expiresIn: ttl }
  );
}

/**
 * A credential for the terminal itself, rather than for the person who
 * commissioned it.
 *
 * Scoped to one office and carrying nothing else: it authorises reading that
 * venue's staff list so the till can check a PIN with no network, and nothing
 * more. It is not interchangeable with a session token — `requireTerminal`
 * refuses a session token and `requireAuth` refuses this one, so a terminal
 * token left on a shop-floor machine cannot be used to read the back office.
 */
function issueTerminalToken(user, secret, ttl = TERMINAL_TOKEN_TTL) {
  return jwt.sign(
    {
      scope: 'terminal',
      office: user.officeEmail,
      officeId: user.officeId,
      // Who set the terminal up. Not used for authorisation — it is here so a
      // support call about one till can be traced back to a person.
      commissionedBy: user.email,
    },
    secret,
    { expiresIn: ttl }
  );
}

/** Express middleware: rejects anything without a valid bearer token. */
function requireAuth(secret) {
  return (req, res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Not signed in' });

    try {
      const claims = jwt.verify(token, secret);
      // **Any** scoped token is refused, not just the terminal one.
      //
      // A session token carries no `scope`; every credential issued to a
      // *device* does — `terminal` for a commissioned till, `kitchen` for a
      // screen on a wall. Naming them one at a time was a bug waiting for the
      // next one to be added, and it duly arrived: the kitchen token passed
      // this check and opened the whole back office to a shared login taped to
      // a wall in a room full of people.
      //
      // Written as "reject anything scoped" so the next device credential is
      // safe the day it is minted rather than the day somebody remembers this
      // line.
      if (claims.scope) {
        return res.status(401).json({ error: 'Not signed in' });
      }
      req.user = claims;
      next();
    } catch {
      res.status(401).json({ error: 'Session expired' });
    }
  };
}

/**
 * Express middleware for routes only a commissioned till may call.
 *
 * Sets `req.office` to the venue the terminal belongs to, so the route reads
 * its tenancy from the signed token rather than from a query parameter anyone
 * could supply. That is the whole point of the exercise: staff PINs must not
 * be reachable by guessing a venue's contact email.
 */
function requireTerminal(secret) {
  return (req, res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) {
      return res.status(401).json({ error: 'This terminal is not commissioned' });
    }

    try {
      const claims = jwt.verify(token, secret);
      if (claims.scope !== 'terminal' || !claims.office) {
        return res.status(401).json({ error: 'Not a terminal token' });
      }
      req.terminal = claims;
      req.office = claims.office;
      next();
    } catch {
      // Says what to do about it: the fix is to sign this till in again, which
      // is not obvious from "expired".
      res.status(401).json({
        error:
          'This terminal needs to be signed in again to enable staff sign-on.',
      });
    }
  };
}

module.exports = {
  verifyPassword,
  issueToken,
  issueTerminalToken,
  requireAuth,
  requireTerminal,
  AccessDeniedError,
};
