/**
 * Make a Vesopa account for somebody, with a verified email address.
 *
 *     node scripts/create-person.js <email> "<display name>"
 *
 * FOR THE OWNER'S OWN CUSTOMERS, when they are being moved onto Vesopa from
 * somewhere else and the address is one the owner vouches for — the two
 * hosting customers migrated off the old server on 2026-09-17 were the first.
 * Nothing self-registers on Vesopa; this is the owner creating the account,
 * which is the rule.
 *
 * The address is marked verified on the owner's word (`verified_via = 'owner'`),
 * so it can be joined to the customer's hosting account by email the moment
 * they first press Continue with Vesopa. Idempotent: an address that already
 * has an account is reported, not duplicated.
 *
 * No password is set here — that is scripts/set-password.js, on purpose a
 * separate step with its own allow-list.
 */

const crypto = require('crypto');

const db = require('../src/db');
const { newId } = require('../src/crypto');
const { normaliseEmail } = require('../src/normalise');

async function main() {
  const email = normaliseEmail(process.argv[2] || '');
  const displayName = String(process.argv[3] || '').trim();
  if (!email || !email.includes('@')) {
    console.error('usage: create-person.js <email> "<display name>"');
    process.exit(2);
  }

  const existing = await db.one(
    `SELECT u.id, u.public_id FROM users u
       JOIN user_identities i ON i.user_id = u.id
      WHERE i.type = 'email' AND i.identifier_norm = ? AND i.revoked_at IS NULL`,
    [email],
  );
  if (existing) {
    console.log(`${email} already has an account (user ${existing.id}, ${existing.public_id}).`);
    return;
  }

  const publicId = newId();
  await db.transaction(async (tx) => {
    const user = await tx.execute(
      'INSERT INTO users (public_id, display_name, webauthn_handle) VALUES (?, ?, ?)',
      [publicId, displayName, crypto.randomBytes(32)],
    );
    const identity = await tx.execute(
      `INSERT INTO user_identities (user_id, type, identifier, identifier_norm, verified_at, verified_via)
       VALUES (?, 'email', ?, ?, NOW(), 'owner')`,
      [user.insertId, process.argv[2].trim(), email],
    );
    await tx.execute('UPDATE users SET primary_email_id = ? WHERE id = ?', [identity.insertId, user.insertId]);
    console.log(`Created ${email} (user ${user.insertId}, ${publicId}).`);
  });
}

main()
  .then(() => db.close())
  .catch(async (error) => {
    console.error(error.message);
    await db.close().catch(() => {});
    process.exit(1);
  });
