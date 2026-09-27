/**
 * Make a customer's own administrator for one of the applications Vesopa runs
 * for them.
 *
 *     node scripts/make-org-admin.js <email> "<display name>" <org-slug> "<org name>" <app-slug>
 *
 *     node scripts/make-org-admin.js m.hammond@metricgroup.co.uk "Matt Hammond" \
 *          metric-group "Metric Group" vesopa-metric
 *
 * FIRST USED 2026-09-27, when the owner made Matt Hammond (Metric Group) the
 * administrator of the Metric Membership sign-in: "create an oauth apps ...
 * add rest everything on this account except customer".
 *
 * So, idempotently:
 *
 *   - the account, with its address verified on the owner's word
 *     (`verified_via = 'owner'`, as create-person.js), or the existing one
 *   - `users.is_developer`, so /developers opens for them
 *   - the customer's organisation, owned by them, and the application moved
 *     into it: the consent screen then names the customer, and whoever they
 *     add to their organisation later reaches their application and nothing
 *     of Vesopa's
 *   - `admin` on the application itself as well, in case the organisation is
 *     ever changed by hand
 *
 * And deliberately NOT:
 *
 *   - `users.is_staff`. That is Vesopa's own admin console, over every
 *     customer; a customer's administrator never gets it.
 *   - a customer membership of the application (`application_members`). The
 *     owner said "except customer", and signing in creates that row by itself
 *     only if they ever use the app as a member.
 *
 * No password here: that is scripts/set-password.js, whose allow-list names
 * the address.
 */

const crypto = require('crypto');

const db = require('../src/db');
const { newId } = require('../src/crypto');
const { normaliseEmail } = require('../src/normalise');

async function main() {
  const [rawEmail, displayName, orgSlug, orgName, appSlug] = process.argv.slice(2).map((a) => String(a || '').trim());
  const email = normaliseEmail(rawEmail);
  if (!email || !email.includes('@') || !displayName || !orgSlug || !orgName || !appSlug) {
    console.error('usage: make-org-admin.js <email> "<display name>" <org-slug> "<org name>" <app-slug>');
    process.exit(2);
  }

  const application = await db.one(
    'SELECT id, name, client_id, organisation_id FROM applications WHERE slug = ? AND deleted_at IS NULL',
    [appSlug],
  );
  if (!application) {
    console.error(`No application "${appSlug}".`);
    process.exit(3);
  }

  await db.transaction(async (tx) => {
    let user = await tx.one(
      `SELECT u.id, u.public_id, i.id AS identity_id, i.verified_at FROM users u
         JOIN user_identities i ON i.user_id = u.id
        WHERE i.type = 'email' AND i.identifier_norm = ? AND i.revoked_at IS NULL`,
      [email],
    );
    if (!user) {
      const publicId = newId();
      const made = await tx.execute(
        'INSERT INTO users (public_id, display_name, webauthn_handle) VALUES (?, ?, ?)',
        [publicId, displayName, crypto.randomBytes(32)],
      );
      const identity = await tx.execute(
        `INSERT INTO user_identities (user_id, type, identifier, identifier_norm, verified_at, verified_via)
         VALUES (?, 'email', ?, ?, NOW(), 'owner')`,
        [made.insertId, rawEmail, email],
      );
      await tx.execute('UPDATE users SET primary_email_id = ? WHERE id = ?', [identity.insertId, made.insertId]);
      user = { id: made.insertId, public_id: publicId };
      console.log(`  created ${email} (${publicId}), address verified on the owner's word`);
    } else {
      if (!user.verified_at) {
        await tx.execute("UPDATE user_identities SET verified_at = NOW(), verified_via = 'owner' WHERE id = ?", [user.identity_id]);
      }
      await tx.execute("UPDATE users SET display_name = ? WHERE id = ? AND (display_name IS NULL OR display_name = '')", [displayName, user.id]);
      console.log(`  ${email} already has an account (${user.public_id})`);
    }

    await tx.execute('UPDATE users SET is_developer = 1 WHERE id = ?', [user.id]);

    let org = await tx.one('SELECT id, owner_user_id FROM organisations WHERE slug = ?', [orgSlug]);
    if (!org) {
      const made = await tx.execute(
        'INSERT INTO organisations (public_id, name, slug, owner_user_id, is_first_party) VALUES (?, ?, ?, ?, 0)',
        [newId(), orgName, orgSlug, user.id],
      );
      org = { id: made.insertId, owner_user_id: user.id };
      console.log(`  created organisation ${orgName} (${orgSlug})`);
    } else if (org.owner_user_id !== user.id) {
      console.log(`  organisation ${orgSlug} exists with another owner; ${email} is added as admin, not owner`);
    }
    const orgRole = org.owner_user_id === user.id ? 'owner' : 'admin';
    await tx.execute(
      `INSERT INTO organisation_members (organisation_id, user_id, role) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE role = VALUES(role)`,
      [org.id, user.id, orgRole],
    );

    if (application.organisation_id !== org.id) {
      await tx.execute('UPDATE applications SET organisation_id = ? WHERE id = ?', [org.id, application.id]);
      console.log(`  moved ${application.name} into ${orgName}`);
    }

    await tx.execute(
      `INSERT INTO application_developers (application_id, user_id, role, granted_by)
       VALUES (?, ?, 'admin', NULL)
       ON DUPLICATE KEY UPDATE role = 'admin'`,
      [application.id, user.id],
    );

    await tx.execute(
      `INSERT INTO audit_log (actor_user_id, actor_type, action, target_type, target_id,
                              application_id, detail, ip, user_agent)
       VALUES (NULL, 'system', 'application.developer_granted', 'application', ?, ?, ?, '', 'make-org-admin.js')`,
      [application.client_id, application.id, JSON.stringify({ user: user.public_id, role: 'admin', organisation: orgSlug, orgRole })],
    );

    console.log(`  ${email} is ${orgRole} of ${orgName} and admin of ${application.name} (client ${application.client_id})`);
    console.log('  they manage it at https://auth.vesopa.com/developers');
  });

  await db.close();
}

main().catch((error) => {
  console.error('failed:', error.message);
  process.exit(1);
});
