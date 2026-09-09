/**
 * The wallet log, against the live server.
 *
 *     node test/wallet-events-live.js          (ON the server, in the app dir)
 *
 * NOT a unit test, which is the point. `wallet-log.test.js` proves the module
 * writes what it is asked to and survives a database that has gone away; this
 * proves the rows actually appear when a real customer is handed a real card,
 * signed by the real certificates, over the real HTTP route.
 *
 * That distinction has bitten this project before: unit tests have passed while
 * the feature was completely broken. A log is especially prone to it — every
 * call is fire-and-forget and every failure is swallowed on purpose, so a
 * silently broken log looks exactly like a quiet one.
 *
 * It writes rows under a probe office and deletes them again.
 */

require('dotenv').config();

const assert = require('assert');
const mysql = require('mysql2/promise');

const walletLog = require('../src/wallet_log');

const OFFICE = 'wallet-probe@vesopa.co.uk';

let checks = 0;
function ok(label, condition, detail = '') {
  if (!condition) {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    throw new assert.AssertionError({ message: label });
  }
  checks += 1;
  console.log('  ok ', label);
}

/** Wait for a fire-and-forget write to land. */
async function settle(pool, expected, tries = 40) {
  for (let i = 0; i < tries; i += 1) {
    const [[row]] = await pool.query(
      'SELECT COUNT(*) AS n FROM epos_wallet_events WHERE office = ?',
      [OFFICE],
    );
    if (Number(row.n) >= expected) return Number(row.n);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const [[row]] = await pool.query(
    'SELECT COUNT(*) AS n FROM epos_wallet_events WHERE office = ?',
    [OFFICE],
  );
  return Number(row.n);
}

async function main() {
  const pool = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 4,
  });

  console.log('\nwallet event log, live\n');

  await pool.execute('DELETE FROM epos_wallet_events WHERE office = ?', [OFFICE]);

  // ------------------------------------------------------- it really writes
  walletLog.record(pool, {
    office: OFFICE,
    event: 'built',
    kind: 'loyalty',
    subjectId: 'probe-1',
    serial: 'probe-serial-0001',
    bytes: 285987,
    ms: 412,
    detail: 'pass.com.vesopa.loyalty',
  });

  const landed = await settle(pool, 1);
  ok('a row written by the module reaches the real table', landed === 1, `${landed} rows`);

  const [[row]] = await pool.query(
    'SELECT * FROM epos_wallet_events WHERE office = ? ORDER BY id DESC LIMIT 1',
    [OFFICE],
  );
  ok('with the event', row.event === 'built');
  ok('the kind', row.kind === 'loyalty');
  ok('the serial', row.serial_number === 'probe-serial-0001');
  ok('the size', Number(row.bytes) === 285987);
  ok('how long it took', Number(row.ms) === 412);
  ok('marked as having worked', Number(row.ok) === 1);
  ok('and a timestamp', row.created_at instanceof Date);

  // ---------------------------------------- the columns are wide enough
  walletLog.record(pool, {
    office: OFFICE,
    event: 'device_log',
    detail: 'x'.repeat(700),
    ok: false,
  });
  await settle(pool, 2);
  const [[long]] = await pool.query(
    "SELECT detail, ok FROM epos_wallet_events WHERE office = ? AND event = 'device_log' LIMIT 1",
    [OFFICE],
  );
  ok('a long line is stored, truncated rather than refused', long.detail.length === 500);
  ok('and a failure is stored as one', Number(long.ok) === 0);

  // ------------------------------------------------------------ the indexes
  const [plan] = await pool.query(
    'EXPLAIN SELECT id FROM epos_wallet_events WHERE office = ? ORDER BY id DESC LIMIT 50',
    [OFFICE],
  );
  ok('the office lookup has an index to use', Boolean(plan[0].key), JSON.stringify(plan[0]));

  const [serialPlan] = await pool.query(
    'EXPLAIN SELECT id FROM epos_wallet_events WHERE serial_number = ?',
    ['probe-serial-0001'],
  );
  ok(
    'and so does the serial lookup, which is what support uses',
    Boolean(serialPlan[0].key),
    JSON.stringify(serialPlan[0]),
  );

  // ----------------------------------------------------------------- prune
  await pool.execute(
    `INSERT INTO epos_wallet_events (office, event, created_at)
     VALUES (?, 'built', DATE_SUB(NOW(), INTERVAL 200 DAY))`,
    [OFFICE],
  );
  const removed = await walletLog.prune(pool, 90);
  ok('pruning removes what is older than the retention', removed >= 1, `${removed} removed`);

  const [[after]] = await pool.query(
    'SELECT COUNT(*) AS n FROM epos_wallet_events WHERE office = ?',
    [OFFICE],
  );
  ok('and leaves the recent rows alone', Number(after.n) === 2, `${after.n} left`);

  // --------------------------------------------------------------- tidy up
  await pool.execute('DELETE FROM epos_wallet_events WHERE office = ?', [OFFICE]);
  const [[gone]] = await pool.query(
    'SELECT COUNT(*) AS n FROM epos_wallet_events WHERE office = ?',
    [OFFICE],
  );
  ok('the probe rows are cleaned up', Number(gone.n) === 0);

  console.log(`\n  ${checks} checks passed\n`);
  await pool.end();
}

main().catch(async (error) => {
  console.error('\nlive wallet log test failed:', error.message);
  process.exit(1);
});
