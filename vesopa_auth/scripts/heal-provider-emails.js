/**
 * Give every account the confirmed email row its linked provider already proved.
 *
 *     node scripts/heal-provider-emails.js            report only
 *     node scripts/heal-provider-emails.js --apply    do it
 *
 * WHAT WAS WRONG. A Google, Apple, Microsoft or GitHub sign-in proved an address,
 * but the confirmed email row only appeared when the account was first made, and
 * not at all if a silent venue account already named the address. Sign-in checks
 * and cloud.vesopa.com then said the person had no confirmed address (owner,
 * 2026-11-07). social.js now adopts the address on every sign-in; this is for the
 * accounts that exist already and have not signed in since.
 *
 * WHAT IT DOES, through the same identity.adoptProviderEmail sign-in uses:
 *
 *   address free, or on this account    adopted
 *   on an unused venue placeholder      the placeholder folds into this account
 *                                       (scripts/merge-users.js, so its venue
 *                                       memberships come too), then adopted
 *   on an account somebody uses         left, and counted: a person decides
 *
 * SAFE TO RE-RUN. Prints user ids and counts, never an address.
 */

const { execFileSync } = require('child_process');
const path = require('path');

const db = require('../src/db');
const identity = require('../src/identity');

const APPLY = process.argv.includes('--apply');

async function main() {
  const rows = await db.query(
    `SELECT i.user_id, i.type, i.asserted_email, i.asserted_email_norm
       FROM user_identities i JOIN users u ON u.id = i.user_id
      WHERE i.type NOT IN ('email', 'phone')
        AND i.asserted_email_verified = 1
        AND i.asserted_email_norm <> ''
        AND i.is_private_relay = 0
        AND i.revoked_at IS NULL
        AND u.status = 'active'
      ORDER BY i.id`,
  );
  const count = { fine: 0, adopted: 0, merged: 0, undecided: 0, relay: 0 };

  for (const row of rows) {
    const held = await identity.findIdentity('email', row.asserted_email_norm);
    const mine = held && held.user_id === row.user_id;
    if (mine && held.verified_at) { count.fine += 1; continue; }

    if (held && !mine) {
      if (held.user_status !== 'active' || !(await identity.isUnclaimedPlaceholder(held.user_id))) {
        count.undecided += 1;
        console.log(`undecided: account ${row.user_id} (${row.type}); address on account ${held.user_id}`);
        continue;
      }
      console.log(`placeholder ${held.user_id} folds into account ${row.user_id}`);
      count.merged += 1;
      if (APPLY) {
        execFileSync(process.execPath,
          [path.join(__dirname, 'merge-users.js'), String(held.user_id), String(row.user_id), '--force'],
          { stdio: 'inherit' });
      }
    }

    if (!APPLY) { if (!held || mine) count.adopted += 1; continue; }
    const outcome = await identity.adoptProviderEmail(row.user_id, {
      email: row.asserted_email,
      normalised: row.asserted_email_norm,
      via: row.type,
    });
    if (outcome === 'added' || outcome === 'confirmed') count.adopted += 1;
    else if (outcome === 'skipped') count.relay += 1;
    else count.undecided += 1;
  }
  console.log(`${APPLY ? 'done' : 'report only'}: ${JSON.stringify(count)}`);
}

main()
  .then(() => db.close())
  .catch(async (error) => {
    console.error(error.message);
    await db.close();
    process.exit(1);
  });
