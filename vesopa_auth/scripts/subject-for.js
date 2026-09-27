/**
 * Print the `sub` one application sees for one account.
 *
 *     node scripts/subject-for.js <email> <app-slug>
 *
 * Applications get a pairwise subject (src/oauth/tokens.js subjectFor), so an
 * application's own records of a person can only be prepared ahead of their
 * first sign-in by asking here. FIRST USED 2026-09-27 by
 * MetricMembership/server/scripts/setup-test-account.py, to give the Microsoft
 * Store's testers a Metric membership that is already approved.
 *
 * Prints the subject alone on stdout, nothing else.
 */

const db = require('../src/db');
const { subjectFor } = require('../src/oauth/tokens');
const { normaliseEmail } = require('../src/normalise');

async function main() {
  const email = normaliseEmail(process.argv[2] || '');
  const appSlug = String(process.argv[3] || '').trim();
  if (!email || !appSlug) {
    console.error('usage: subject-for.js <email> <app-slug>');
    process.exit(2);
  }
  const application = await db.one(
    'SELECT id, subject_type, sector_salt FROM applications WHERE slug = ? AND deleted_at IS NULL',
    [appSlug],
  );
  if (!application) {
    console.error(`No application "${appSlug}".`);
    process.exit(3);
  }
  const user = await db.one(
    `SELECT u.public_id FROM users u
       JOIN user_identities i ON i.user_id = u.id
      WHERE i.type = 'email' AND i.identifier_norm = ? AND i.revoked_at IS NULL`,
    [email],
  );
  if (!user) {
    console.error(`No Vesopa account for ${email}.`);
    process.exit(5);
  }
  process.stdout.write(`${subjectFor(application, user.public_id)}\n`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('failed:', error.message);
    process.exit(1);
  });
