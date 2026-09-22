/**
 * Make every customer venue an organisation on auth.vesopa.com, and link it.
 *
 *     node scripts/provision-venue-orgs.js            # dry run: say what would happen
 *     node scripts/provision-venue-orgs.js --apply    # do it
 *     node scripts/provision-venue-orgs.js --office 35 [--apply]   # one venue
 *
 * Run from the site's own directory on the server, so it reads the same .env
 * (database, and the Vesopa EPOS Administration client credentials).
 *
 * THE DRY RUN IS NOT A GUESS. It sends the real request with dry_run: true,
 * and auth runs the real code inside a transaction it rolls back. What it
 * prints is what --apply will do.
 *
 * WHAT --apply CHANGES
 *
 *   On auth: organisations, silent unverified accounts for people who have
 *   none, memberships, subscriptions. Additive only — see src/vesopa-venues.js.
 *   Nothing is emailed.
 *
 *   Here: offices.auth_organisation_id, only where it is still NULL.
 *
 * THE CONSEQUENCE WORTH KNOWING. Once linked, the back office starts caching
 * that venue's device limits from auth (entitlements.js). No venue has licence
 * locking switched on today, so nothing is refused — but read the quantities
 * before switching locking on for anyone.
 */

require('dotenv').config();

const { pool } = require('../src/db');
const venues = require('../src/vesopa-venues');

const APPLY = process.argv.includes('--apply');
const only = (() => {
  const i = process.argv.indexOf('--office');
  return i > 0 ? Number(process.argv[i + 1]) : null;
})();

const say = (line = '') => console.log(line);

function describe(action) {
  const { do: verb, ...rest } = action;
  const detail = Object.entries(rest).map(([k, v]) => `${k}=${v}`).join(' ');
  return `    ${verb.padEnd(20)} ${detail}`;
}

async function main() {
  if (!venues.configured()) {
    throw new Error('VESOPA_AUTH_ADMIN_CLIENT_ID / _SECRET are not set in .env.');
  }
  say(APPLY ? 'Provisioning venues on auth.vesopa.com.\n' : 'DRY RUN — nothing will change. Add --apply to do it.\n');

  const [offices] = await pool.query(
    only ? 'SELECT id FROM offices WHERE id = ?' : 'SELECT id FROM offices ORDER BY id',
    only ? [only] : []
  );

  const tally = { done: 0, skipped: 0, failed: 0 };
  for (const { id } of offices) {
    // eslint-disable-next-line no-await-in-loop -- nine venues, in order, readable
    const data = await venues.loadOffice(id);
    const label = `#${id} ${data.office.name} <${data.office.contact_email}>`;

    const why = venues.skipReason(data);
    if (why) {
      say(`SKIP ${label}\n    ${why}\n`);
      tally.skipped += 1;
      continue;
    }

    const payload = venues.buildPayload(data);
    if (!payload) {
      say(`SKIP ${label}\n    no approved venue user to own it\n`);
      tally.skipped += 1;
      continue;
    }

    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await venues.provision(payload, { dryRun: !APPLY });
      say(`${APPLY ? 'DONE' : 'WOULD'} ${label}  → organisation ${result.dry_run ? '(new)' : result.organisation_id}`);
      say(`    owner ${payload.owner.email}; ${payload.members.length} other member(s)`);
      for (const s of payload.subscriptions) say(`    sells ${s.product} × ${s.quantity} (${s.status})`);
      for (const a of result.actions) say(describe(a));

      if (APPLY) {
        // eslint-disable-next-line no-await-in-loop
        const linked = await venues.link(id, result.organisation_id);
        say(linked ? `    linked offices.auth_organisation_id = ${result.organisation_id}` : '    ! not linked: the venue was linked by somebody else meanwhile');
      }
      tally.done += 1;
    } catch (error) {
      say(`FAIL ${label}\n    ${error.message}`);
      tally.failed += 1;
    }
    say();
  }

  say(`${APPLY ? 'Provisioned' : 'Would provision'} ${tally.done}, skipped ${tally.skipped}, failed ${tally.failed}.`);
  if (!APPLY) say('Nothing was changed.');
  return tally.failed ? 1 : 0;
}

main()
  .then(async (code) => { await pool.end(); process.exit(code); })
  .catch(async (error) => { console.error(error.message); await pool.end().catch(() => {}); process.exit(1); });
