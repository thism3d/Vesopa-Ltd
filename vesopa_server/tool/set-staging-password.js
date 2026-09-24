#!/usr/bin/env node
/**
 * Give a back-office account a password on STAGING.
 *
 *   node tool/set-staging-password.js manager@vesopa.co.uk 'some password'
 *   node tool/set-staging-password.js manager@vesopa.co.uk        # generates one
 *
 * WHY THIS EXISTS
 *
 * tool/scrub-staging.sql empties every password hash, which is right — a
 * staging dump must not be a list of live passwords. But it leaves staging with
 * no way in at all, which makes it useless for the one thing it is for. This is
 * the other half: a deliberate, per-account way back in, run by a person.
 *
 * NO PASSWORD IS STORED IN THIS REPOSITORY. The repository is public. One is
 * passed on the command line or generated here and printed once.
 *
 * IT REFUSES TO RUN ANYWHERE BUT STAGING. The check is on the database name,
 * the same rule the scrub uses, because the failure this prevents — setting a
 * known password on a live back-office account — is the worst thing in this
 * directory.
 */
const crypto = require('crypto');

require('dotenv').config();
const bcrypt = require('bcryptjs');
const mysql = require('mysql2/promise');

async function main() {
  const [, , email, given] = process.argv;
  if (!email) {
    console.error('Usage: node tool/set-staging-password.js <email> [password]');
    process.exit(1);
  }

  const database = process.env.DB_NAME || '';
  if (!database.endsWith('_staging')) {
    console.error(
      `Refusing: DB_NAME is "${database}", which is not a staging database.\n` +
        'This only ever runs against a database whose name ends in _staging.'
    );
    process.exit(2);
  }

  // Generated rather than defaulted: a script with a default password is a
  // script that puts the same password on every environment that ever runs it.
  const password =
    given || crypto.randomBytes(18).toString('base64').replace(/[/+=]/g, '').slice(0, 20);

  const pool = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database,
  });

  try {
    const hash = await bcrypt.hash(password, 12);
    const [res] = await pool.execute(
      'UPDATE backoffice_users SET password = ? WHERE email = ?',
      [hash, email]
    );
    if (!res.affectedRows) {
      console.error(`No account ${email} in ${database}.`);
      process.exitCode = 3;
      return;
    }
    console.log(`Set the password for ${email} in ${database}.`);
    if (!given) console.log(`Password: ${password}`);
    console.log('It is bcrypt-hashed in the database; this is the only time it is shown.');
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
