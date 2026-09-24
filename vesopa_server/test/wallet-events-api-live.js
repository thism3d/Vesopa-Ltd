/**
 * The back office reads the wallet log.
 *
 *     node test/wallet-events-api-live.js       (ON the server, in the app dir)
 *
 * The screen is the reason the log exists — a table nobody can read is not a
 * diagnostic, it is a table. So this drives `/api/wallet/apple/events` exactly
 * as the page does, with a real signed token, over the public address.
 *
 * The token is minted here with the server's own `issueToken`, which is
 * legitimate on this machine and only here: it holds the secret already. What
 * it must NOT do is skip the scoping, so the sharpest check below is the one
 * that proves a venue cannot ask for another venue's history.
 */

require('dotenv').config();

const mysql = require('mysql2/promise');

const { issueToken } = require('../src/auth');

const BASE = process.env.WALLET_TEST_BASE || 'https://backoffice.vesopaepos.com';
const OFFICE = 'manager@vesopa.co.uk';
const OTHER = 'muzahid@onzep.uk';

let passed = 0;
let failed = 0;

function check(label, condition, detail = '') {
  console.log(`  ${condition ? 'ok  ' : '✗   '}${label}${condition ? '' : ` — ${detail}`}`);
  if (condition) passed += 1;
  else failed += 1;
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

  console.log('\nthe back office reads the wallet log\n');

  const [[staff]] = await pool.query(
    `SELECT u.id, u.email, u.name, u.role, u.office_id, o.contact_email AS office_email
       FROM backoffice_users u LEFT JOIN offices o ON o.id = u.office_id
      WHERE LOWER(u.email) = ? LIMIT 1`,
    [OFFICE],
  );
  check('the test manager exists', Boolean(staff));
  check(
    'and belongs to the test venue',
    staff && staff.office_email === OFFICE,
    staff && staff.office_email,
  );

  const token = issueToken(
    {
      id: staff.id,
      email: staff.email,
      name: staff.name,
      role: staff.role,
      officeId: staff.office_id,
    },
    process.env.JWT_SECRET,
  );

  const ask = (query = '') =>
    fetch(`${BASE}/api/wallet/apple/events${query}`, {
      headers: { authorization: `Bearer ${token}` },
    });

  // ------------------------------------------------------------- it answers
  const response = await ask('?limit=50');
  check('the endpoint answers', response.status === 200, `status ${response.status}`);

  const body = await response.json();
  check('with events', Array.isArray(body.events), typeof body.events);
  check('and a summary', Boolean(body.summary), JSON.stringify(body).slice(0, 120));
  check('naming the retention', Number(body.retain_days) === 90, String(body.retain_days));

  /*
   * Numbers, not nulls.
   *
   * SUM() over an empty range returns null, and a screen that reads "null cards
   * built" is worse than one that reads zero — it looks like a bug in the
   * product to whoever is reading it.
   */
  const numeric = Object.entries(body.summary)
    .filter(([key]) => key !== 'avg_build_ms')
    .every(([, value]) => typeof value === 'number');
  check('every count is a number', numeric, JSON.stringify(body.summary));

  // --------------------------------------------------------------- scoping
  check(
    'every row belongs to the caller’s venue',
    body.events.every((row) => !row.office || row.office === OFFICE),
    'a row from another venue was returned',
  );

  /*
   * THE IMPORTANT ONE.
   *
   * The office comes from the signed token and must not be steerable from the
   * query string. If it were, one venue could read another's card history —
   * which is a customer list.
   */
  const injected = await ask(`?office=${encodeURIComponent(OTHER)}&limit=50`);
  const injectedBody = await injected.json();
  const [[otherCount]] = await pool.query(
    'SELECT COUNT(*) AS n FROM epos_wallet_events WHERE office = ?',
    [OTHER],
  );
  check(
    'asking for ANOTHER venue’s history is ignored, not obeyed',
    injectedBody.events.every((row) => !row.serial_number || true) &&
      JSON.stringify(injectedBody.events) === JSON.stringify(body.events),
    `the other venue has ${otherCount.n} rows; the response must not contain them`,
  );

  // --------------------------------------------------------------- filters
  const trouble = await (await ask('?trouble=1&limit=50')).json();
  check(
    'the trouble filter returns only failures',
    trouble.events.every((row) => Number(row.ok) === 0),
    `${trouble.events.filter((r) => Number(r.ok) !== 0).length} successful rows leaked in`,
  );

  const [[anySerial]] = await pool.query(
    "SELECT serial_number FROM epos_wallet_events WHERE office = ? AND serial_number IS NOT NULL LIMIT 1",
    [OFFICE],
  );
  if (anySerial) {
    const bySerial = await (
      await ask(`?serial=${encodeURIComponent(anySerial.serial_number)}&limit=50`)
    ).json();
    check(
      'and the serial filter narrows to one card',
      bySerial.events.length > 0 &&
        bySerial.events.every((row) => row.serial_number === anySerial.serial_number),
      `${bySerial.events.length} rows`,
    );
  }

  const capped = await (await ask('?limit=9999')).json();
  check('an absurd limit is capped rather than obeyed', capped.events.length <= 500, String(capped.events.length));

  // ---------------------------------------------------------- and it is shut
  const anonymous = await fetch(`${BASE}/api/wallet/apple/events`);
  check(
    'without a token there is nothing to read',
    anonymous.status === 401 || anonymous.status === 403,
    `status ${anonymous.status}`,
  );

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  await pool.end();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('\nlive wallet events API test failed:', error);
  process.exit(1);
});
