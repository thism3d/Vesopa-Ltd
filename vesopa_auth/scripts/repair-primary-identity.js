/**
 * Point every account at the address and number it already holds.
 *
 *     node scripts/repair-primary-identity.js [--dry]
 *
 * WHAT WAS WRONG. `createUser` sets `users.primary_email_id` only when the
 * FIRST identity on the account is an email. That is right for somebody who
 * signed in with an address and silently wrong for everybody else: an account
 * created through GitHub has a provider identity first and its address attached
 * a moment later, so the pointer stayed null for ever.
 *
 * Nothing read it, so nothing noticed — until three things did at once. The
 * account chooser said "no address on this account" for a person who plainly
 * has one; the consent screen could not say whose account was about to be
 * connected to an application; and "confirm it is you" had nowhere to send a
 * code. All three were reading a null that nothing had ever been responsible
 * for filling in.
 *
 * `identity.ensurePrimary` fills it in from now on, in the same transaction
 * that attaches the identity. This is for the accounts that already exist.
 *
 * SAFE TO RE-RUN. It only ever writes where the pointer is NULL, and only ever
 * to an identity that account already holds — it cannot move anybody's address
 * or choose a different one. `--dry` counts without writing.
 *
 * A RECOVERY-ONLY ADDRESS IS NEVER CHOSEN. It exists precisely so that it is
 * not the account's public identity; promoting one would put it on the consent
 * screen of every application the person uses.
 */

const db = require('./../src/db');

const DRY = process.argv.includes('--dry');

async function main() {
  const before = await db.one(
    `SELECT
       SUM(u.primary_email_id IS NULL) AS no_email,
       SUM(u.primary_phone_id IS NULL) AS no_phone,
       COUNT(*) AS total
     FROM users u WHERE u.status = 'active'`,
  );
  console.log(
    `${before.total} active accounts: ${before.no_email} with no primary address, ` +
      `${before.no_phone} with no primary number.`,
  );

  const fixable = await db.one(
    `SELECT COUNT(*) AS n FROM users u
      WHERE u.status = 'active' AND u.primary_email_id IS NULL
        AND EXISTS (SELECT 1 FROM user_identities i
                     WHERE i.user_id = u.id AND i.type = 'email'
                       AND i.revoked_at IS NULL AND i.is_recovery = 0)`,
  );
  console.log(`${fixable.n} of those DO hold an address that can be pointed at.`);

  if (DRY) {
    console.log('\n--dry: nothing written.');
    await db.close();
    return;
  }

  const email = await db.execute(
    `UPDATE users u
        SET u.primary_email_id = (
              SELECT i.id FROM user_identities i
               WHERE i.user_id = u.id AND i.type = 'email'
                 AND i.revoked_at IS NULL AND i.is_recovery = 0
               ORDER BY i.verified_at IS NULL, i.id
               LIMIT 1)
      WHERE u.primary_email_id IS NULL`,
  );
  const phone = await db.execute(
    `UPDATE users u
        SET u.primary_phone_id = (
              SELECT i.id FROM user_identities i
               WHERE i.user_id = u.id AND i.type = 'phone'
                 AND i.revoked_at IS NULL AND i.is_recovery = 0
               ORDER BY i.verified_at IS NULL, i.id
               LIMIT 1)
      WHERE u.primary_phone_id IS NULL`,
  );

  console.log(`\n  ✓ ${email.affectedRows} rows given a primary address`);
  console.log(`  ✓ ${phone.affectedRows} rows given a primary number`);
  console.log('\nAccounts with neither are left alone; there is nothing to point at.');
  await db.close();
}

main().catch((error) => {
  console.error('failed:', error.message);
  process.exit(1);
});
