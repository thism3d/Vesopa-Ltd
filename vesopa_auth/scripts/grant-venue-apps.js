/**
 * Let an existing Vesopa account into every application a venue's manager
 * uses: the back office, the till, the kitchen screen, the customer display
 * and the kiosk.
 *
 *     node scripts/grant-venue-apps.js m.hammond@metricgroup.co.uk
 *
 * FIRST USED 2026-10-05, when the owner set up Metric Group UK as a venue on
 * Matt Hammond's account: "grant the applications for Metric Group".
 *
 * Those applications have `allow_self_enroll = 0`, so without a membership row
 * the person is turned away at the authorize step however well they sign in
 * (see provision-venues.js). This writes those rows, with the manager roles
 * provision-venues.js gives every venue.
 *
 * IT NEVER CREATES AN ACCOUNT. The address must already belong to somebody
 * here; anything else is refused, so a typo cannot mint an identity.
 * IDEMPOTENT and only ever adds: a removed membership is made active again,
 * nothing is lowered. Sends no email.
 */

const db = require('../src/db');
const { normaliseEmail } = require('../src/normalise');
const { VENUE_APPLICATIONS } = require('../src/venues');

const ROLES = ['backoffice.admin', 'till.manager'];

async function main() {
  const email = normaliseEmail(String(process.argv[2] || ''));
  if (!email) throw new Error('usage: node scripts/grant-venue-apps.js <email>');

  const user = await db.one(
    `SELECT u.id, u.display_name FROM users u
       JOIN user_identities i ON i.user_id = u.id
      WHERE i.type = 'email' AND i.identifier_norm = ? AND i.revoked_at IS NULL
      LIMIT 1`,
    [email],
  );
  if (!user) throw new Error(`${email} has no Vesopa account. Nothing was changed.`);
  console.log(`${user.display_name || email} (user ${user.id})`);

  for (const slug of VENUE_APPLICATIONS) {
    const app = await db.one('SELECT id FROM applications WHERE slug = ? AND deleted_at IS NULL', [slug]);
    if (!app) {
      console.log(`  - ${slug.padEnd(18)} not on this server, skipped`);
      continue;
    }
    const before = await db.one(
      'SELECT status FROM application_members WHERE application_id = ? AND user_id = ?',
      [app.id, user.id],
    );
    await db.execute(
      `INSERT INTO application_members (application_id, user_id, status)
       VALUES (?, ?, 'active')
       ON DUPLICATE KEY UPDATE status = IF(status = 'removed', 'active', status)`,
      [app.id, user.id],
    );
    const member = await db.one(
      'SELECT id FROM application_members WHERE application_id = ? AND user_id = ?',
      [app.id, user.id],
    );
    await db.execute(
      `INSERT IGNORE INTO application_member_roles (member_id, role_id)
       SELECT ?, r.id FROM application_roles r WHERE r.application_id = ? AND r.is_default = 1`,
      [member.id, app.id],
    );
    const granted = [];
    for (const key of ROLES) {
      const role = await db.one(
        'SELECT id FROM application_roles WHERE application_id = ? AND role_key = ?',
        [app.id, key],
      );
      if (!role) continue;
      await db.execute(
        'INSERT IGNORE INTO application_member_roles (member_id, role_id) VALUES (?, ?)',
        [member.id, role.id],
      );
      granted.push(key);
    }
    const was = before ? (before.status === 'removed' ? 'restored' : 'already in') : 'let in';
    console.log(`  ✓ ${slug.padEnd(18)} ${was}${granted.length ? ` · ${granted.join(', ')}` : ''}`);
  }
}

main()
  .then(() => db.close())
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
