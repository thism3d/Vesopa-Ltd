/**
 * Give somebody developer access to one application.
 *
 *     node scripts/grant-developer.js muzahid@vesopa.com vesopa-menu admin
 *
 * Two gates, and this opens both, because opening only one does nothing:
 *
 *   `users.is_developer`   may they reach /developers at all
 *   `application_developers`  which applications they see once they are there
 *
 * IDEMPOTENT, like everything else that touches this database. Running it twice
 * changes nothing the second time, and it never resets a password or touches an
 * existing identity.
 *
 * IT CREATES THE ACCOUNT IF THERE IS NONE — AND LEAVES THE ADDRESS UNVERIFIED.
 *
 * That is the whole design of this script and it is worth being explicit about.
 * The portal's own "grant access" form refuses an address with no account
 * behind it, deliberately: a form that mints identities from an address nobody
 * has proved they own is a form that can create an account in somebody else's
 * name, and the first they hear of it is a credential they never asked for.
 *
 * Run from the server shell, that objection is weaker — whoever is here can
 * write the row by hand anyway — but the protection is kept rather than waived.
 * The row is created with `verified_at` NULL and no password, so it is a
 * placeholder and not a usable account: the person still signs in through the
 * ordinary email-code flow, and THAT is what verifies the address. Nothing here
 * lets anybody in; it only decides what they can see once they have let
 * themselves in.
 */

const crypto = require('crypto');

const db = require('../src/db');
const { newId } = require('../src/crypto');
const { normaliseEmail } = require('../src/normalise');

const ROLES = ['admin', 'developer', 'viewer'];

async function main() {
  const [email, slug, role = 'developer'] = process.argv.slice(2);
  if (!email || !slug) {
    console.error('usage: node scripts/grant-developer.js <email> <app-slug> [admin|developer|viewer]');
    process.exit(1);
  }
  if (!ROLES.includes(role)) {
    console.error(`role must be one of: ${ROLES.join(', ')}`);
    process.exit(1);
  }

  const application = await db.one(
    'SELECT id, name, client_id, organisation_id FROM applications WHERE slug = ? AND deleted_at IS NULL',
    [slug],
  );
  if (!application) {
    const all = await db.query('SELECT slug FROM applications WHERE deleted_at IS NULL ORDER BY slug');
    console.error(`no application with slug "${slug}". There is: ${all.map((r) => r.slug).join(', ')}`);
    process.exit(1);
  }

  const normalised = normaliseEmail(email);
  let user = await db.one(
    `SELECT u.* FROM users u
       JOIN user_identities i ON i.user_id = u.id
      WHERE i.type = 'email' AND i.identifier_norm = ? AND i.revoked_at IS NULL`,
    [normalised],
  );

  if (!user) {
    const publicId = newId();
    const result = await db.execute(
      `INSERT INTO users (public_id, display_name, is_developer, webauthn_handle)
       VALUES (?, ?, 1, ?)`,
      [publicId, email.split('@')[0], crypto.randomBytes(32)],
    );
    const identity = await db.execute(
      `INSERT INTO user_identities (user_id, type, identifier, identifier_norm, verified_at, verified_via)
       VALUES (?, 'email', ?, ?, NULL, 'granted')`,
      [result.insertId, email, normalised],
    );
    await db.execute('UPDATE users SET primary_email_id = ? WHERE id = ?', [
      identity.insertId,
      result.insertId,
    ]);
    user = await db.one('SELECT * FROM users WHERE id = ?', [result.insertId]);
    console.log(`  created account ${publicId} for ${email} (address NOT verified)`);
    console.log('  they verify it themselves by signing in with an emailed code.');
  } else {
    console.log(`  ${email} already has an account (${user.public_id})`);
  }

  await db.execute('UPDATE users SET is_developer = 1 WHERE id = ?', [user.id]);

  await db.execute(
    `INSERT INTO application_developers (application_id, user_id, role, granted_by)
     VALUES (?, ?, ?, NULL)
     ON DUPLICATE KEY UPDATE role = VALUES(role)`,
    [application.id, user.id, role],
  );

  /*
   * Recorded, like every other grant. A developer who can rotate a client
   * secret is a person who can take an application down, and "who gave them
   * that, and when" should never be a matter of memory.
   */
  await db.execute(
    `INSERT INTO audit_log (actor_user_id, actor_type, action, target_type, target_id,
                            application_id, detail, ip, user_agent)
     VALUES (NULL, 'system', 'application.developer_granted', 'application', ?, ?, ?, '', 'grant-developer.js')`,
    [application.client_id, application.id, JSON.stringify({ user: user.public_id, role })],
  );

  console.log(`  ${email} is now ${role} on ${application.name} (${slug})`);
  console.log(`  they will see it at https://auth.vesopa.com/developers`);

  await db.close();
}

main().catch((error) => {
  console.error('failed:', error.message);
  process.exit(1);
});
