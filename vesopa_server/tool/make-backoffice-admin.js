#!/usr/bin/env node
/**
 * Make an address the back office's platform administrator.
 *
 *   node tool/make-backoffice-admin.js info@vesopasoftware.com
 *
 * Owner, 2026-10-05: "Make this account the main administration", of
 * info@vesopasoftware.com, so it opens Administration (Offices, Licences,
 * Modules, Billing...) after Continue with Vesopa.
 *
 * An existing row is raised to role 'admin' and approved; its office link is
 * kept, so a venue it already manages stays reachable. Otherwise a row is made
 * with no office and a random password nobody knows: sign-in is Continue with
 * Vesopa, which links the row by verified email (src/backoffice_auth.js).
 * Idempotent. Prints what it did, never a password.
 */
require('dotenv').config({ quiet: true });
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const mysql = require('mysql2/promise');

(async () => {
  const email = String(process.argv[2] || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('usage: node tool/make-backoffice-admin.js <email>');
  const db = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'vesopa_eposdb',
  });
  try {
    const [[row]] = await db.query('SELECT id, role, approved, office_id FROM backoffice_users WHERE LOWER(email) = ? LIMIT 1', [email]);
    if (row) {
      await db.execute("UPDATE backoffice_users SET role = 'admin', approved = 'Y' WHERE id = ?", [row.id]);
      console.log(row.role === 'admin' && row.approved === 'Y'
        ? `  ${email} was already the administrator (user ${row.id})`
        : `  ${email} is now the administrator (user ${row.id}, was ${row.role})`);
    } else {
      const hash = await bcrypt.hash(crypto.randomBytes(32).toString('base64url'), 12);
      const [r] = await db.execute(
        "INSERT INTO backoffice_users (email, password, name, company, approved, role, office_id) VALUES (?, ?, 'Vesopa Administration', 'Vesopa Software Ltd', 'Y', 'admin', NULL)",
        [email, hash]);
      console.log(`  ${email} created as the administrator (user ${r.insertId})`);
    }
  } finally {
    await db.end();
  }
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
