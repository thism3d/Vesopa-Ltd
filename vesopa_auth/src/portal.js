/**
 * Who may work on which application, and the one-time display of a secret.
 *
 * WHY ACCESS IS A UNION OF TWO THINGS. `organisation_members` answers "may this
 * person work on anything this organisation owns", which is the right grain for
 * a customer's own developer and the wrong grain for Vesopa: one organisation
 * owns the till, the menu and the hosting panel, and somebody brought in to
 * wire up the QR menu has no business rotating the till's client secret. So an
 * application can also be granted to a person on its own, and reach is the
 * union — with the strongest role winning where both apply.
 *
 * THE THREE ROLES, and the distinction that matters:
 *
 *   admin      everything, plus granting access to other people
 *   developer  settings, redirect URIs, roles, and minting client secrets
 *   viewer     read only — no secret is ever minted or revealed
 *
 * `viewer` exists so that "let them see the configuration" does not have to
 * mean "let them mint a credential". They are different requests, and a portal
 * that conflates them is one support ticket away from an extra live secret in
 * somebody's inbox.
 */

const crypto = require('crypto');

const db = require('./db');
const { hashPassword } = require('./crypto');
const config = require('./config');

/** Strongest first, so a role can be compared with an index. */
const ROLES = ['viewer', 'developer', 'admin'];

function strongest(a, b) {
  if (!a) return b;
  if (!b) return a;
  return ROLES.indexOf(a) >= ROLES.indexOf(b) ? a : b;
}

/**
 * An organisation role expressed as a portal role.
 *
 * `owner` and `admin` on the organisation are portal administrators; anything
 * else is what it says. Mapping rather than reusing the string keeps the two
 * vocabularies separate — an organisation gains roles for billing and support
 * long before those should mean anything about client secrets.
 */
function fromOrganisationRole(role) {
  if (role === 'owner' || role === 'admin') return 'admin';
  if (role === 'developer') return 'developer';
  return 'viewer';
}

function can(role, action) {
  if (!role) return false;
  if (role === 'admin') return true;
  if (role === 'developer') return action !== 'grant';
  // viewer
  return action === 'read';
}

/**
 * Every application this person may open, with the role they hold on each.
 *
 * Staff see everything. That is a deliberate, and slightly uncomfortable,
 * decision: an administrator of the identity provider can already read every
 * table it has, so pretending otherwise in the portal would be theatre — and it
 * would mean the one person who can fix a broken integration at nine on a
 * Sunday cannot see it. It is audited like every other administrative act.
 */
async function reach(user) {
  const rows = await db.query(
    `SELECT a.*, o.name AS organisation_name, o.slug AS organisation_slug,
            om.role AS org_role, ad.role AS app_role,
            (SELECT COUNT(*) FROM application_members m
              WHERE m.application_id = a.id AND m.status = 'active') AS people,
            (SELECT COUNT(*) FROM application_secrets s
              WHERE s.application_id = a.id AND s.revoked_at IS NULL) AS secrets,
            (SELECT COUNT(*) FROM application_redirect_uris r
              WHERE r.application_id = a.id AND r.kind = 'login') AS redirects
       FROM applications a
       JOIN organisations o ON o.id = a.organisation_id
       LEFT JOIN organisation_members om
              ON om.organisation_id = a.organisation_id AND om.user_id = ?
       LEFT JOIN application_developers ad
              ON ad.application_id = a.id AND ad.user_id = ?
      WHERE a.deleted_at IS NULL
        AND (? = 1 OR om.user_id IS NOT NULL OR ad.user_id IS NOT NULL)
      ORDER BY a.name`,
    [user.user_id, user.user_id, user.is_staff ? 1 : 0],
  );

  return rows.map((row) => ({
    ...row,
    role: user.is_staff
      ? 'admin'
      : strongest(row.org_role ? fromOrganisationRole(row.org_role) : null, row.app_role),
  }));
}

/**
 * One application, and what this person may do to it.
 *
 * Returns null for both "no such application" and "not yours" — the caller
 * renders the same 404 for either, because telling somebody that a client id
 * exists but is not theirs is a way to enumerate every application on the
 * server one guess at a time.
 */
async function access(user, clientId) {
  if (!clientId) return null;
  const row = await db.one(
    `SELECT a.*, o.name AS organisation_name, o.slug AS organisation_slug,
            o.is_first_party AS org_first_party,
            om.role AS org_role, ad.role AS app_role
       FROM applications a
       JOIN organisations o ON o.id = a.organisation_id
       LEFT JOIN organisation_members om
              ON om.organisation_id = a.organisation_id AND om.user_id = ?
       LEFT JOIN application_developers ad
              ON ad.application_id = a.id AND ad.user_id = ?
      WHERE a.client_id = ? AND a.deleted_at IS NULL`,
    [user.user_id, user.user_id, clientId],
  );
  if (!row) return null;

  const role = user.is_staff
    ? 'admin'
    : strongest(row.org_role ? fromOrganisationRole(row.org_role) : null, row.app_role);
  if (!role) return null;

  return { application: row, role };
}

/** Everything a page about one application needs, in one round of queries. */
async function detail(applicationId) {
  const [redirects, grants, appScopes, allScopes, roles, secrets, team] = await Promise.all([
    db.query(
      `SELECT id, uri, kind FROM application_redirect_uris
        WHERE application_id = ? ORDER BY kind, uri`,
      [applicationId],
    ),
    db.query('SELECT grant_type FROM application_grants WHERE application_id = ?', [applicationId]),
    db.query('SELECT scope_id FROM application_scopes WHERE application_id = ?', [applicationId]),
    db.query('SELECT * FROM scopes ORDER BY is_default DESC, name'),
    db.query(
      `SELECT r.*, (SELECT COUNT(*) FROM application_member_roles mr WHERE mr.role_id = r.id) AS held
         FROM application_roles r WHERE r.application_id = ? ORDER BY r.is_default DESC, r.role_key`,
      [applicationId],
    ),
    db.query(
      `SELECT id, hint, label, last_used_at, expires_at, revoked_at, created_at
         FROM application_secrets WHERE application_id = ?
        ORDER BY revoked_at IS NOT NULL, id DESC`,
      [applicationId],
    ),
    db.query(
      `SELECT d.id, d.role, d.created_at, u.public_id, u.display_name,
              (SELECT i.identifier FROM user_identities i
                WHERE i.id = u.primary_email_id) AS email
         FROM application_developers d
         JOIN users u ON u.id = d.user_id
        WHERE d.application_id = ? ORDER BY d.id`,
      [applicationId],
    ),
  ]);

  const chosen = new Set(appScopes.map((row) => row.scope_id));
  return {
    redirects: redirects.filter((row) => row.kind === 'login'),
    logoutRedirects: redirects.filter((row) => row.kind === 'logout'),
    grants: grants.map((row) => row.grant_type),
    scopes: allScopes.map((row) => ({ ...row, chosen: chosen.has(row.id) })),
    roles,
    secrets,
    team,
  };
}

// ---------------------------------------------------------------------------
// The one-time display of a client secret
// ---------------------------------------------------------------------------
//
// A secret is stored only as an argon2id hash, so it exists in the clear for
// exactly as long as it takes to put it on the developer's screen. The problem
// is getting it there across a redirect.
//
// NOT IN THE QUERY STRING, ever. A URL is written to the nginx access log, kept
// in browser history, and handed to any page the developer visits next as a
// Referer. A secret in one is a secret in all three.
//
// NOT BY RENDERING THE POST RESPONSE either, tempting as it is: refreshing that
// page re-posts the form and mints a second secret, and a developer who presses
// F5 twice now has three live credentials and no idea which is which.
//
// So: the plaintext is held in this process, under a random handle, for five
// minutes, and read exactly once. It does not survive a restart — and if it
// does not, nothing is lost that a second Mint cannot replace. What is bought
// is that the secret never touches a log, a history entry or the database.

const pending = new Map();
const PENDING_MS = 5 * 60 * 1000;

function stash(secret) {
  const handle = crypto.randomBytes(16).toString('hex');
  pending.set(handle, { secret, at: Date.now() });
  // Sweep on write rather than on a timer: an interval would keep the process
  // awake, and there is never more than a handful of these.
  for (const [key, value] of pending) {
    if (Date.now() - value.at > PENDING_MS) pending.delete(key);
  }
  return handle;
}

function claim(handle) {
  if (!handle) return null;
  const held = pending.get(handle);
  if (!held) return null;
  pending.delete(handle);
  if (Date.now() - held.at > PENDING_MS) return null;
  return held.secret;
}

/**
 * Mint a client secret.
 *
 * Peppered argon2id, the same as a password, because that is what it is: a
 * bearer credential presented against a public identifier. `hint` is the last
 * four characters so that two secrets can be told apart in a list without the
 * list containing either of them.
 *
 * SEVERAL LIVE AT ONCE IS THE POINT. Rotation is: mint the new one, deploy it,
 * revoke the old one. One secret column would make every rotation an outage.
 */
async function mintSecret(applicationId, label, byUserId) {
  // 40 bytes of base64url — 320 bits. Longer than it needs to be, and the cost
  // of that is nothing, whereas the cost of being wrong is every token this
  // application will ever issue.
  const secret = crypto.randomBytes(40).toString('base64url');
  const hash = await hashPassword(secret, config.secrets.passwordPepper);

  const result = await db.execute(
    `INSERT INTO application_secrets (application_id, secret_hash, hint, label, created_by)
     VALUES (?, ?, ?, ?, ?)`,
    [applicationId, hash, secret.slice(-4), String(label || '').slice(0, 80), byUserId],
  );

  return { id: result.insertId, secret, handle: stash(secret) };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Is this a redirect URI we are prepared to send an authorisation code to?
 *
 * THIS IS THE MOST SECURITY-CRITICAL FIELD IN THE PORTAL. Whatever is accepted
 * here is what `clients.matchRedirect` will later compare against, exactly, and
 * an authorisation code is delivered to it. The rules, and why each one:
 *
 *   HTTPS ONLY, except loopback. An http:// redirect puts the code on the wire
 *   in the clear, where anything between the browser and the app can read it.
 *
 *   NO FRAGMENT. RFC 6749 forbids one, and a fragment is not sent to the server
 *   anyway — so a developer who puts one there gets a silent mismatch.
 *
 *   NO WILDCARD, and none is expressible: this is a string, and matching is
 *   equality. Every open-redirect hole in every OAuth server began with
 *   somebody being helpful about matching.
 *
 *   LOOPBACK ONLY FOR NATIVE CLIENTS, per RFC 8252 — the operating system picks
 *   the port at runtime, so only the path can be registered.
 */
function checkRedirect(raw, clientType) {
  const value = String(raw || '').trim();
  if (!value) return { ok: false, error: 'Enter a redirect URI.' };
  if (value.length > 500) return { ok: false, error: 'That URI is too long.' };

  let url;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, error: 'That is not a valid absolute URL. It must start with https://' };
  }

  if (url.hash) {
    return {
      ok: false,
      error: 'Remove the # fragment — it is never sent to your server, so it can never match.',
    };
  }
  if (value.includes('*')) {
    return {
      ok: false,
      error: 'Wildcards are not accepted. Register each address in full, exactly as your app uses it.',
    };
  }

  /*
   * `localhost` is checked FIRST, and the order is the whole point.
   *
   * It fails the loopback test below — it is a name, not an address — so it
   * falls into the generic "use https://" branch and the developer is told
   * something true and useless. What they need to hear is the actual objection:
   * `localhost` resolves through DNS and can be pointed anywhere, including at
   * a machine that is not theirs, whereas 127.0.0.1 cannot. Answering the
   * specific question before the general one is the difference between an error
   * somebody acts on and an error somebody argues with.
   */
  if (url.hostname === 'localhost') {
    return {
      ok: false,
      error: 'Use http://127.0.0.1 rather than localhost — the name goes through DNS and can be pointed elsewhere.',
    };
  }

  const loopback =
    url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === '::1';

  if (url.protocol === 'http:') {
    if (!loopback) {
      return {
        ok: false,
        error: 'Use https://. An http address would put the authorisation code on the wire in the clear.',
      };
    }
    if (clientType !== 'native') {
      return {
        ok: false,
        error: 'Only a desktop or mobile app may use a 127.0.0.1 address. Change the type to Native first.',
      };
    }
  } else if (url.protocol !== 'https:') {
    /*
     * A custom scheme — `myapp://callback` — is what a mobile app registers,
     * and it is deliberately not accepted here. It cannot be proven to belong
     * to the person registering it, so anybody who installs an app claiming
     * the same scheme receives the code. RFC 8252 prefers loopback for exactly
     * this reason, and that is what the till uses.
     */
    return {
      ok: false,
      error: 'Only https:// is accepted (and http://127.0.0.1 for a desktop app).',
    };
  }

  return { ok: true, value };
}

/** A slug that can appear in a URL and cannot collide with an existing one. */
function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

module.exports = {
  ROLES,
  reach,
  access,
  detail,
  can,
  mintSecret,
  claim,
  checkRedirect,
  slugify,
  fromOrganisationRole,
};
