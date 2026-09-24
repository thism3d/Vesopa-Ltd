/**
 * Create or reset the bootstrap admin.
 *
 * Reads ADMIN_EMAIL and ADMIN_PASSWORD from .env, hashes the password and
 * writes the row. The plaintext never reaches the database and never reaches
 * git — which is the entire reason this is a script rather than a row in
 * seed.sql, where the password would have been committed.
 *
 *   npm run seed:admin
 *
 * Safe to re-run: it updates the existing row rather than failing, so it also
 * serves as "I have locked myself out, reset the owner password".
 */

require('dotenv').config();
const db = require('../src/db');
const auth = require('../src/auth');

(async () => {
  const email = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = String(process.env.ADMIN_PASSWORD || '');

  if (!email || !password) {
    console.error('\n  Set ADMIN_EMAIL and ADMIN_PASSWORD in .env first, then run this again.\n');
    process.exit(1);
  }

  const problem = auth.passwordProblem(password);
  if (problem) {
    console.error(`\n  That password will not do: ${problem}\n`);
    process.exit(1);
  }

  try {
    const hash = await auth.hashPassword(password);
    const existing = await db.one('SELECT id FROM hosting_admins WHERE email = ? LIMIT 1', [email]);

    if (existing) {
      await db.query(
        "UPDATE hosting_admins SET password_hash = ?, role = 'owner', active = 1 WHERE id = ?",
        [hash, existing.id],
      );
      console.log(`\n  Reset the password for ${email} (owner).`);
    } else {
      await db.query(
        "INSERT INTO hosting_admins (email, name, password_hash, role) VALUES (?, ?, ?, 'owner')",
        [email, email.split('@')[0], hash],
      );
      console.log(`\n  Created ${email} as owner.`);
    }

    console.log('  Sign in at /admin\n');
    console.log('  Now blank ADMIN_PASSWORD in .env — it has done its job and');
    console.log('  a password sitting in a file is a password waiting to leak.\n');
    process.exit(0);
  } catch (err) {
    console.error('\n  Failed:', err.message);
    console.error('  Has schema.sql been applied to the database?\n');
    process.exit(1);
  }
})();
