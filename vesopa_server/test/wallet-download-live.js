/**
 * A real pass, over the real route, and the log row it leaves behind.
 *
 *     node test/wallet-download-live.js        (ON the server, in the app dir)
 *
 * The last link in the chain. `wallet-log.test.js` proves the module behaves;
 * `wallet-events-live.js` proves its rows reach the real table. This proves the
 * SERVICE calls it — that asking the live HTTP endpoint for a card produces a
 * signed `.pkpass` AND the history that goes with it.
 *
 * It is the check that catches the failure this whole subsystem is prone to:
 * every log call is fire-and-forget and every error is swallowed on purpose, so
 * a service that simply never calls the logger looks identical to a quiet day.
 *
 * Only `manager@vesopa.co.uk` is touched. Every other venue on this server is a
 * real customer, and building a card is a read — but a log row is a write, and
 * writing into somebody's venue to satisfy a test is not on.
 */

require('dotenv').config();

const mysql = require('mysql2/promise');

const OFFICE = 'manager@vesopa.co.uk';

/*
 * THE PUBLIC ADDRESS, not 127.0.0.1 — and not by preference.
 *
 * This server listens on 5060, and `fetch()` REFUSES to connect to port 5060.
 * It is on the WHATWG blocked-port list (SIP), so every attempt fails with
 * "bad port" before a packet is sent. Nothing is wrong with the server: real
 * traffic arrives through nginx on 443, and only a Node-side call to the
 * loopback port hits this.
 *
 * Going through the public name is the better test anyway. It exercises nginx,
 * the TLS certificate and the proxy headers — the whole path a customer's phone
 * actually takes — rather than the one hop underneath them.
 */
const BASE = process.env.WALLET_TEST_BASE || 'https://backoffice.vesopaepos.com';

// A real iPhone's, near enough. The route serves a `.pkpass` to Apple devices
// and redirects everything else to Google Wallet, so this string is what
// decides which half of the code runs.
const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

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

  console.log('\na real pass, over the real route\n');

  const [[pass]] = await pool.query(
    `SELECT kind, subject_id, apple_serial FROM epos_wallet_passes
      WHERE office = ? AND apple_serial <> '' LIMIT 1`,
    [OFFICE],
  );
  if (!pass) {
    console.log('  No pass exists for the test venue; nothing to download.');
    await pool.end();
    process.exit(0);
  }
  check('the test venue has a card to fetch', true, '');

  const [[before]] = await pool.query(
    'SELECT COUNT(*) AS n FROM epos_wallet_events WHERE office = ?',
    [OFFICE],
  );

  const url = `${BASE}/wallet/apple/${encodeURIComponent(OFFICE)}/${pass.kind}/${pass.subject_id}.pkpass`;
  const response = await fetch(url, { headers: { 'user-agent': IPHONE } });
  const body = Buffer.from(await response.arrayBuffer());

  check('the route answers 200', response.status === 200, `status ${response.status}`);
  check(
    'with an Apple pass',
    (response.headers.get('content-type') || '').includes('apple.pkpass'),
    response.headers.get('content-type') || '(none)',
  );
  /*
   * `inline`, and this one matters more than it looks.
   *
   * `attachment` sends the file into Safari's download manager, where a
   * `.pkpass` lands in Files and simply never installs. It is the difference
   * between a card that works and one that silently does not.
   */
  check(
    'served inline, so iOS opens it rather than filing it',
    (response.headers.get('content-disposition') || '').startsWith('inline'),
    response.headers.get('content-disposition') || '(none)',
  );

  const text = body.toString('latin1');
  check('it is a zip', body[0] === 0x50 && body[1] === 0x4b);
  check('holding pass.json', text.includes('pass.json'));
  check('a manifest', text.includes('manifest.json'));
  check('and a signature', text.includes('signature'));
  check('of a plausible size', body.length > 2000, `${body.length} bytes`);

  // The log write is fire-and-forget, so give it a moment to land.
  let rows = [];
  for (let i = 0; i < 40; i += 1) {
    const [found] = await pool.query(
      `SELECT event, kind, serial_number, bytes, ms, ok, user_agent
         FROM epos_wallet_events WHERE office = ? ORDER BY id DESC LIMIT 4`,
      [OFFICE],
    );
    if (found.length >= 2 && Number(before.n) + 2 <= (await count(pool))) {
      rows = found;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    rows = found;
  }

  const built = rows.find((r) => r.event === 'built');
  const downloaded = rows.find((r) => r.event === 'downloaded');

  check('the build was recorded', Boolean(built), rows.map((r) => r.event).join(', ') || 'nothing');
  check('the download was recorded', Boolean(downloaded), rows.map((r) => r.event).join(', ') || 'nothing');

  if (built) {
    check('with this card’s serial', built.serial_number === pass.apple_serial, built.serial_number);
    check('the size it actually was', Number(built.bytes) === body.length, `${built.bytes} vs ${body.length}`);
    check('how long signing took', Number(built.ms) > 0, String(built.ms));
    check('marked as having worked', Number(built.ok) === 1);
    check(
      'and the iPhone that asked',
      String(built.user_agent || '').includes('iPhone'),
      built.user_agent || '(none)',
    );
  }

  // ------------------------------------------------- and a failure is kept
  const bad = await fetch(
    `${BASE}/wallet/apple/${encodeURIComponent(OFFICE)}/loyalty/no-such-subject.pkpass`,
    { headers: { 'user-agent': IPHONE } },
  );
  check('a card that cannot be built is refused', bad.status >= 400, `status ${bad.status}`);

  let failure = null;
  for (let i = 0; i < 40; i += 1) {
    const [found] = await pool.query(
      `SELECT event, detail, ok FROM epos_wallet_events
        WHERE office = ? AND ok = 0 ORDER BY id DESC LIMIT 1`,
      [OFFICE],
    );
    if (found.length) {
      failure = found[0];
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  check('and the REASON is kept, which is the whole point', Boolean(failure), 'no failure row appeared');
  if (failure) {
    check('with something a human can read', String(failure.detail || '').length > 5, failure.detail);
  }

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  await pool.end();
  process.exit(failed === 0 ? 0 : 1);
}

async function count(pool) {
  const [[row]] = await pool.query(
    'SELECT COUNT(*) AS n FROM epos_wallet_events WHERE office = ?',
    [OFFICE],
  );
  return Number(row.n);
}

main().catch((error) => {
  console.error('\nlive wallet download test failed:', error);
  process.exit(1);
});
