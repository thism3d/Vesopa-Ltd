/**
 * Applications: finding them, checking their secrets, and deciding whether a
 * redirect URI is one of theirs.
 *
 * THE REDIRECT RULE IS THE MOST SECURITY-CRITICAL COMPARISON IN THE SYSTEM.
 * The authorisation code is sent to that address. Every open-redirect hole in
 * every OAuth server has begun with somebody being helpful about matching —
 * allowing a trailing slash, allowing a subdirectory, allowing a wildcard
 * subdomain "just for staging". So: exact string equality, with exactly one
 * narrow exception, written out below and confined to native clients.
 */

const db = require('../db');
const { hashToken, safeEqual, verifyPassword } = require('../crypto');
const config = require('../config');

/** An application by its public client_id, with what it is allowed to do. */
async function find(clientId) {
  if (!clientId) return null;
  const application = await db.one(
    `SELECT a.*, o.name AS organisation_name, o.is_first_party AS org_first_party
       FROM applications a
       JOIN organisations o ON o.id = a.organisation_id
      WHERE a.client_id = ? AND a.status = 'active'`,
    [clientId],
  );
  if (!application) return null;

  const [grants, redirects] = await Promise.all([
    db.query('SELECT grant_type FROM application_grants WHERE application_id = ?', [
      application.id,
    ]),
    db.query('SELECT uri, kind FROM application_redirect_uris WHERE application_id = ?', [
      application.id,
    ]),
  ]);

  return {
    ...application,
    grants: grants.map((row) => row.grant_type),
    redirectUris: redirects.filter((r) => r.kind === 'login').map((r) => r.uri),
    logoutUris: redirects.filter((r) => r.kind === 'logout').map((r) => r.uri),
  };
}

/**
 * Is this application public (cannot keep a secret) or confidential?
 *
 * A `spa` runs in a browser and a `native` client runs on somebody's computer;
 * anything shipped inside either can be read by whoever holds it. Treating a
 * secret baked into an Electron app as a secret is the classic hole — and the
 * reason PKCE is required of every client here, confidential ones included.
 */
function isPublic(application) {
  return application.client_type === 'spa' || application.client_type === 'native';
}

/**
 * Check a client secret.
 *
 * Several live secrets per application, on purpose: rotating means adding the
 * new one, deploying, then revoking the old. A single secret column would make
 * every rotation an outage.
 */
async function verifySecret(application, presented) {
  if (!presented) return false;
  const secrets = await db.query(
    `SELECT id, secret_hash FROM application_secrets
      WHERE application_id = ? AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > NOW())`,
    [application.id],
  );

  for (const row of secrets) {
    // eslint-disable-next-line no-await-in-loop -- secrets are few, and the
    // comparison must be sequential: argon2 verification is deliberately slow
    // and running them all at once would multiply the cost of a wrong guess.
    if (await verifyPassword(row.secret_hash, presented, config.secrets.passwordPepper)) {
      await db.execute('UPDATE application_secrets SET last_used_at = NOW() WHERE id = ?', [
        row.id,
      ]);
      return true;
    }
  }
  return false;
}

/**
 * Does this redirect URI belong to this application?
 *
 * Exact string equality against the registered list — no normalisation, no
 * trailing-slash forgiveness, no prefix matching.
 *
 * THE ONE EXCEPTION, and why it is safe. A native client (the Electron till)
 * listens on `http://127.0.0.1:<port>/callback` and the operating system
 * chooses that port at runtime, so it cannot be registered in advance. RFC 8252
 * says to allow any port on the loopback address for exactly this reason. It is
 * safe because loopback is not reachable from anywhere else: to receive a code
 * sent there, an attacker must already be running code on the machine, at which
 * point they have not needed the code for some time.
 *
 * Everything about it is still checked — scheme, host, path — and the exception
 * applies to `native` clients only. A web application registering a loopback
 * URI gets no such leniency.
 */
function matchRedirect(application, presented, kind = 'login') {
  const registered = kind === 'logout' ? application.logoutUris : application.redirectUris;
  if (!presented) return false;

  if (registered.some((uri) => uri === presented)) return true;

  if (application.client_type !== 'native') return false;

  let candidate;
  try {
    candidate = new URL(presented);
  } catch {
    return false;
  }
  const loopback =
    candidate.hostname === '127.0.0.1' || candidate.hostname === '[::1]' || candidate.hostname === '::1';
  if (candidate.protocol !== 'http:' || !loopback) return false;

  return registered.some((uri) => {
    let known;
    try {
      known = new URL(uri);
    } catch {
      return false;
    }
    return (
      known.protocol === 'http:' &&
      (known.hostname === '127.0.0.1' || known.hostname === '[::1]' || known.hostname === '::1') &&
      known.pathname === candidate.pathname
    );
  });
}

function allowsGrant(application, grantType) {
  return application.grants.includes(grantType);
}

/**
 * Narrow what was asked for down to what this application may have.
 *
 * Silently dropping the rest rather than failing is what the specification asks
 * for, and it is also kinder: a client that adds a scope it has not been
 * granted still works for everything else, and the missing claim is a far
 * easier thing to debug than a blanket refusal.
 */
async function permittedScopes(application, requested) {
  const asked = String(requested || '')
    .split(/\s+/)
    .filter(Boolean);

  const allowed = await db.query(
    `SELECT s.name, s.title, s.description, s.is_default
       FROM application_scopes a
       JOIN scopes s ON s.id = a.scope_id
      WHERE a.application_id = ?`,
    [application.id],
  );
  const allowedNames = new Set(allowed.map((row) => row.name));

  // `openid` is what makes this OpenID Connect rather than plain OAuth, and it
  // is always available — an application cannot be configured out of it.
  allowedNames.add('openid');

  const granted = asked.filter((scope) => allowedNames.has(scope));
  if (!granted.includes('openid') && asked.includes('openid')) granted.unshift('openid');

  return {
    granted,
    dropped: asked.filter((scope) => !allowedNames.has(scope)),
    describe: allowed.filter((row) => granted.includes(row.name)),
  };
}

/** The roles this person holds in this application, for the token. */
async function rolesFor(applicationId, userId) {
  const rows = await db.query(
    `SELECT r.role_key
       FROM application_members m
       JOIN application_member_roles mr ON mr.member_id = m.id
       JOIN application_roles r ON r.id = mr.role_id
      WHERE m.application_id = ? AND m.user_id = ? AND m.status = 'active'`,
    [applicationId, userId],
  );
  return rows.map((row) => row.role_key);
}

/**
 * Is this person a user of this application at all?
 *
 * This is where the owner's "each application system will be isolated from each
 * other" actually bites. There is one pool of people — a Vesopa account is a
 * Vesopa account — but an application only ever sees the ones with a membership
 * row for it. An application that does not allow self-enrolment refuses
 * everybody else, which is what a back office wants and a QR menu does not.
 */
async function membership(applicationId, userId) {
  return db.one(
    'SELECT * FROM application_members WHERE application_id = ? AND user_id = ?',
    [applicationId, userId],
  );
}

async function enrol(applicationId, userId) {
  await db.execute(
    `INSERT INTO application_members (application_id, user_id, status, last_seen_at)
     VALUES (?, ?, 'active', NOW())
     ON DUPLICATE KEY UPDATE last_seen_at = NOW(),
       status = IF(status = 'removed', 'active', status)`,
    [applicationId, userId],
  );

  // Give them whatever the application says every member gets.
  await db.execute(
    `INSERT IGNORE INTO application_member_roles (member_id, role_id)
     SELECT m.id, r.id
       FROM application_members m
       JOIN application_roles r ON r.application_id = m.application_id AND r.is_default = 1
      WHERE m.application_id = ? AND m.user_id = ?`,
    [applicationId, userId],
  );
}

/** Look up a secret's owner without leaking which half was wrong. */
function timingSafeClientId(a, b) {
  return safeEqual(hashToken(a || ''), hashToken(b || ''));
}

module.exports = {
  find,
  isPublic,
  verifySecret,
  matchRedirect,
  allowsGrant,
  permittedScopes,
  rolesFor,
  membership,
  enrol,
  timingSafeClientId,
};
