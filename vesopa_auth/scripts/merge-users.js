/**
 * Fold one Vesopa account into another: one person, one account.
 *
 *     node scripts/merge-users.js --list                  every address held by two accounts
 *     node scripts/merge-users.js <from> <into> --dry     what would move
 *     node scripts/merge-users.js <from> <into>           do it
 *
 * `<from>` and `<into>` are user ids or public ids. Everything `from` holds
 * moves to `into`; `from` is left as a tombstone — status 'merged',
 * merged_into_user_id set — so anything that still names its subject can be
 * followed to the survivor, and its public id is never handed to anybody else.
 *
 * HOW THIS CAME ABOUT. On 2026-09-09 the owner signed in with GitHub, which
 * made an account holding muzahid@onzep.uk from GitHub's say-so; an hour later
 * he typed the same address on the sign-in page, and that made a second one.
 * The sign-in code now refuses to do that in either direction
 * (identity.findLinkCandidate, identity.findByAssertedEmail) — but a guard
 * added afterwards does nothing for the two rows that already exist, and one
 * of them is the account every application knows him by. This is for those.
 *
 * WHAT MOVES, AND HOW COLLISIONS ARE DECIDED. `into` is the account being
 * kept, so where both hold the same thing, `into`'s copy wins and `from`'s is
 * dropped:
 *
 *   identities            every live one moves; the survivor's primary address
 *                         stays its primary, and is filled in if it had none
 *   application members   moved; a membership `into` already has is kept as is
 *   consents              moved; an active consent `into` already has is kept
 *   developer roles,      moved; duplicates dropped
 *   organisation members
 *   subscriptions,        moved
 *   devices, refresh
 *   tokens, recoveries
 *   password, TOTP,       moved ONLY if `into` has none — a second active
 *   recovery codes        password is refused by the schema, and silently
 *                         swapping somebody's password is not a merge
 *   passkeys              moved; each is bound to its own credential id
 *   profile               name, avatar, given/family name copied where `into`
 *                         is blank; `into`'s own values are never overwritten
 *   sessions              `from`'s are revoked — a session is a fact about a
 *                         browser and an account, and that account is closing
 *
 * One transaction. Either everything moves or nothing does.
 *
 * WHAT IT WILL NOT DO. Merge two accounts that do not share a verified
 * address, unless --force is given: sharing an address is the evidence that
 * they are one person, and without it this is somebody handing one account's
 * everything to another.
 */

const db = require('../src/db');
const { recordAudit } = require('../src/events');

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const FORCE = args.includes('--force');
const LIST = args.includes('--list');
const ids = args.filter((a) => !a.startsWith('--'));

async function resolveUser(ref) {
  const byId = /^\d+$/.test(ref) ? await db.one('SELECT * FROM users WHERE id = ?', [Number(ref)]) : null;
  return byId || db.one('SELECT * FROM users WHERE public_id = ?', [ref]);
}

async function listDuplicates() {
  const rows = await db.query(
    `SELECT norm, GROUP_CONCAT(DISTINCT user_id ORDER BY user_id) AS users, COUNT(DISTINCT user_id) AS n
       FROM (
         SELECT i.user_id, i.identifier_norm AS norm
           FROM user_identities i JOIN users u ON u.id = i.user_id
          WHERE i.type = 'email' AND i.revoked_at IS NULL AND i.verified_at IS NOT NULL
            AND u.status = 'active'
         UNION ALL
         SELECT i.user_id, i.asserted_email_norm
           FROM user_identities i JOIN users u ON u.id = i.user_id
          WHERE i.type NOT IN ('email', 'phone') AND i.revoked_at IS NULL
            AND i.asserted_email_verified = 1 AND i.asserted_email_norm <> ''
            AND u.status = 'active'
       ) held
      GROUP BY norm HAVING n > 1
      ORDER BY norm`,
  );
  if (!rows.length) {
    console.log('No address is held by more than one active account.');
    return;
  }
  console.log('Addresses held by more than one active account:');
  for (const r of rows) console.log(`  ${r.norm}  →  users ${r.users}`);
  console.log('\nMerge each pair with: node scripts/merge-users.js <from> <into> --dry');
}

/** The verified addresses an account holds, from its own identity or a provider's word. */
async function addressesOf(userId) {
  const rows = await db.query(
    `SELECT identifier_norm AS a FROM user_identities
      WHERE user_id = ? AND type = 'email' AND revoked_at IS NULL AND verified_at IS NOT NULL
     UNION
     SELECT asserted_email_norm FROM user_identities
      WHERE user_id = ? AND type NOT IN ('email','phone') AND revoked_at IS NULL
        AND asserted_email_verified = 1 AND asserted_email_norm <> ''`,
    [userId, userId],
  );
  return new Set(rows.map((r) => r.a).filter(Boolean));
}

async function main() {
  if (LIST) return listDuplicates();
  if (ids.length !== 2) throw new Error('usage: merge-users.js <from> <into> [--dry] [--force], or --list');

  const from = await resolveUser(ids[0]);
  const into = await resolveUser(ids[1]);
  if (!from || !into) throw new Error('no such user');
  if (from.id === into.id) throw new Error('that is one account');
  if (into.status !== 'active') throw new Error(`the account being kept (${into.id}) is ${into.status}`);
  if (from.status !== 'active') throw new Error(`the account being merged (${from.id}) is already ${from.status}`);

  const shared = [...(await addressesOf(from.id))];
  const intoAddrs = await addressesOf(into.id);
  const common = shared.filter((a) => intoAddrs.has(a));
  if (!common.length && !FORCE) {
    throw new Error(
      `${from.id} and ${into.id} share no verified address — not evidence of one person. Pass --force if you are sure.`,
    );
  }

  console.log(`Merging user ${from.id} (${from.public_id}, "${from.display_name}")`);
  console.log(`   into user ${into.id} (${into.public_id}, "${into.display_name}")`);
  console.log(`   shared address: ${common.join(', ') || '(none — forced)'}`);

  const count = async (table, where = 'user_id = ?') =>
    Number((await db.one(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, [from.id])).n);
  const plan = {
    identities: await count('user_identities', 'user_id = ? AND revoked_at IS NULL'),
    members: await count('application_members'),
    consents: await count('oauth_consents', 'user_id = ? AND revoked_at IS NULL'),
    developers: await count('application_developers'),
    organisations: await count('organisation_members'),
    subscriptions: await count('subscriptions'),
    devices: await count('devices'),
    passkeys: await count('user_passkeys'),
    passwords: await count('user_passwords', 'user_id = ? AND retired_at IS NULL'),
    totp: await count('user_totp'),
    recovery_codes: await count('user_recovery_codes'),
    refresh_tokens: await count('oauth_refresh_tokens'),
    sessions_to_revoke: await count('sso_sessions', 'user_id = ? AND revoked_at IS NULL'),
  };
  console.log('   moving:', JSON.stringify(plan));
  if (DRY) {
    console.log('Dry run — nothing written.');
    return;
  }

  await db.transaction(async (tx) => {
    const F = from.id;
    const T = into.id;
    const moved = {};

    // Identities. The survivor's primary stays; a missing one is filled in.
    moved.identities = (await tx.execute(
      'UPDATE user_identities SET user_id = ? WHERE user_id = ? AND revoked_at IS NULL', [T, F],
    )).affectedRows;
    // History rows (revoked) follow too, so the account's past stays in one place.
    await tx.execute('UPDATE user_identities SET user_id = ? WHERE user_id = ?', [T, F]);
    if (!into.primary_email_id) {
      const email = await tx.one(
        `SELECT id FROM user_identities WHERE user_id = ? AND type = 'email' AND revoked_at IS NULL
          ORDER BY verified_at IS NULL, id LIMIT 1`, [T],
      );
      if (email) await tx.execute('UPDATE users SET primary_email_id = ? WHERE id = ?', [email.id, T]);
    }
    if (!into.primary_phone_id) {
      const phone = await tx.one(
        `SELECT id FROM user_identities WHERE user_id = ? AND type = 'phone' AND revoked_at IS NULL
          ORDER BY verified_at IS NULL, id LIMIT 1`, [T],
      );
      if (phone) await tx.execute('UPDATE users SET primary_phone_id = ? WHERE id = ?', [phone.id, T]);
    }

    // Per-application rows: keep the survivor's where both have one.
    const moveUnlessHeld = async (table, key, extra = '') => {
      await tx.execute(
        `DELETE f FROM ${table} f JOIN ${table} t ON t.${key} = f.${key} AND t.user_id = ? ${extra}
          WHERE f.user_id = ?`, [T, F],
      );
      return (await tx.execute(`UPDATE ${table} SET user_id = ? WHERE user_id = ?`, [T, F])).affectedRows;
    };
    moved.members = await moveUnlessHeld('application_members', 'application_id');
    moved.consents = await moveUnlessHeld('oauth_consents', 'application_id', 'AND t.revoked_at IS NULL AND f.revoked_at IS NULL');
    moved.developers = await moveUnlessHeld('application_developers', 'application_id');
    moved.organisations = await moveUnlessHeld('organisation_members', 'organisation_id');

    for (const table of ['subscriptions', 'devices', 'user_passkeys', 'oauth_refresh_tokens', 'account_recoveries']) {
      moved[table] = (await tx.execute(`UPDATE ${table} SET user_id = ? WHERE user_id = ?`, [T, F])).affectedRows;
    }
    await tx.execute('UPDATE organisations SET owner_user_id = ? WHERE owner_user_id = ?', [T, F]);
    await tx.execute('UPDATE account_recoveries SET actor_user_id = ? WHERE actor_user_id = ?', [T, F]);

    // Second factors and the password: only into an account that has none.
    const has = async (table, where = 'user_id = ?') =>
      Number((await tx.one(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, [T])).n) > 0;
    if (!(await has('user_passwords', 'user_id = ? AND retired_at IS NULL'))) {
      moved.passwords = (await tx.execute('UPDATE user_passwords SET user_id = ? WHERE user_id = ?', [T, F])).affectedRows;
    } else {
      moved.passwords = 0;
      await tx.execute('UPDATE user_passwords SET retired_at = NOW() WHERE user_id = ? AND retired_at IS NULL', [F]);
    }
    if (!(await has('user_totp'))) {
      moved.totp = (await tx.execute('UPDATE user_totp SET user_id = ? WHERE user_id = ?', [T, F])).affectedRows;
      moved.recovery_codes = (await tx.execute('UPDATE user_recovery_codes SET user_id = ? WHERE user_id = ?', [T, F])).affectedRows;
    } else {
      moved.totp = 0;
      moved.recovery_codes = 0;
    }

    // Profile: fill the survivor's blanks, never overwrite what it has.
    await tx.execute(
      `UPDATE users t JOIN users f ON f.id = ?
          SET t.display_name = IF(t.display_name = '', f.display_name, t.display_name),
              t.given_name   = IF(t.given_name = '',   f.given_name,   t.given_name),
              t.family_name  = IF(t.family_name = '',  f.family_name,  t.family_name),
              t.avatar_path  = IF(t.avatar_path = '',  f.avatar_path,  t.avatar_path),
              t.date_of_birth = COALESCE(t.date_of_birth, f.date_of_birth)
        WHERE t.id = ?`, [F, T],
    );

    // The closing account's sessions end; the tombstone stays.
    moved.sessions_revoked = (await tx.execute(
      "UPDATE sso_sessions SET revoked_at = NOW(), revoked_reason = 'merged' WHERE user_id = ? AND revoked_at IS NULL", [F],
    )).affectedRows;
    await tx.execute(
      "UPDATE users SET status = 'merged', merged_into_user_id = ?, deleted_at = NOW() WHERE id = ?", [T, F],
    );

    console.log('   moved:', JSON.stringify(moved));
  });

  await recordAudit({
    actorType: 'system',
    action: 'user.merged',
    targetType: 'user',
    targetId: String(into.public_id),
    detail: { from: from.public_id, into: into.public_id, shared: common },
  });
  console.log(`Done. User ${from.id} is a tombstone pointing at ${into.id}.`);
}

main()
  .then(() => db.close())
  .catch(async (error) => {
    console.error('merge failed:', error.message);
    await db.close().catch(() => {});
    process.exit(1);
  });
