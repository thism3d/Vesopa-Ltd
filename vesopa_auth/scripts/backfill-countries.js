/**
 * Fill in the country for rows written before the lookup existed.
 *
 *     node scripts/backfill-countries.js [--limit 500] [--dry]
 *
 * `sso_sessions.country`, `devices.last_country` and `login_events.country`
 * have existed since schema_002 and were never written to. Without this, the
 * devices page stays blank for everybody until their next sign-in — and the
 * person most likely to open that page today is the one worried about
 * something that happened yesterday.
 *
 * SAFE TO RE-RUN AND SAFE TO STOP. It only touches rows whose country is still
 * empty, it goes through src/geo.js so every answer is cached and every failure
 * is a blank rather than an exception, and `--limit` bounds how much of a
 * metered lookup quota one run can spend. Run it again tomorrow and it picks up
 * where it left off.
 *
 * ADDRESSES ARE NOT PRINTED. This walks a table of everywhere everybody has
 * signed in from; a log of that on somebody's terminal, and then in their
 * scrollback, is a copy of the thing the geo cache is deliberately hashed to
 * avoid keeping. Counts only.
 */

const db = require('../src/db');
const geo = require('../src/geo');

const LIMIT = (() => {
  const at = process.argv.indexOf('--limit');
  return at > 0 ? Math.max(1, Number(process.argv[at + 1]) || 500) : 500;
})();
const DRY = process.argv.includes('--dry');

/**
 * One table's worth.
 *
 * The lookups are sequential rather than in parallel on purpose: the whole
 * point of geo.js is that it asks a third party as rarely as it can, and firing
 * five hundred requests at once would defeat the in-process cache — the second
 * request for an address would leave before the first had answered, so a
 * hundred sessions from one office would be a hundred lookups.
 */
async function fill(table, ipColumn, countryColumn, key) {
  const rows = await db.query(
    `SELECT ${key} AS id, ${ipColumn} AS ip FROM ${table}
      WHERE ${countryColumn} = '' AND ${ipColumn} <> ''
      ORDER BY ${key} DESC
      LIMIT ?`,
    [LIMIT],
  );

  let filled = 0;
  let unknown = 0;

  for (const row of rows) {
    // eslint-disable-next-line no-await-in-loop -- deliberately one at a time
    const country = await geo.countryFor(row.ip);
    if (!country) {
      unknown += 1;
      continue;
    }
    if (!DRY) {
      // eslint-disable-next-line no-await-in-loop
      await db.execute(`UPDATE ${table} SET ${countryColumn} = ? WHERE ${key} = ?`, [
        country,
        row.id,
      ]);
    }
    filled += 1;
  }

  console.log(
    `  ${table}: ${rows.length} looked at, ${filled} filled, ${unknown} still unknown` +
      (DRY ? ' (dry run — nothing written)' : ''),
  );
}

async function main() {
  console.log(`Filling in countries, up to ${LIMIT} rows per table.\n`);
  await fill('sso_sessions', 'ip', 'country', 'id');
  await fill('devices', 'last_ip', 'last_country', 'id');
  await fill('login_events', 'ip', 'country', 'id');
  console.log('\nDone. Run it again to take another pass.');
  await db.close();
}

main().catch((error) => {
  console.error('failed:', error.message);
  process.exit(1);
});
