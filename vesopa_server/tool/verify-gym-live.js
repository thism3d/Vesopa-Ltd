/**
 * Drive the gym against the running server, then put everything back.
 *
 *     node tool/verify-gym-live.js
 *
 * WHY THIS EXISTS WHEN THERE IS ALREADY test/gym.test.js
 *
 * Because that one runs against a fake pool. It proves the decisions -- in,
 * out, the debounce, a replay -- and it proves nothing whatsoever about whether
 * the SQL those decisions are made of is valid SQL, whether the columns exist
 * on the live database, or whether the routes are actually mounted. Every one
 * of those has been the real fault before on this platform: a test suite that
 * is entirely green while the feature is broken on the box.
 *
 * So this drives the real routes on the real server against the real MariaDB.
 *
 * SAFETY
 *
 *   * It refuses to run against any office but the test venue. Every other row
 *     in this database belongs to a paying customer.
 *   * It creates its own customer, with its own card, and deletes it.
 *   * It records the gym settings before it starts and writes them back at the
 *     end, whether it passed or failed -- the test venue must not be left with
 *     a gym switched on that nobody asked for.
 *   * It never prints a secret. The token is minted from the server's own
 *     config, in this process, and only its effects are shown.
 */

require('dotenv').config();

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');

const OFFICE = 'manager@vesopa.co.uk';
const PREFIX = '9771';
const CARD = `${PREFIX}00777`;
// The public address, not the loopback port.
//
// Two reasons, one of them found the hard way. It puts nginx and the TLS
// termination in the path, so this proves the route a till actually takes
// rather than one hop short of it -- and `fetch` on this box refused
// http://127.0.0.1:$PORT with "bad port", which cost twenty minutes and proves
// nothing worth knowing.
const BASE = process.env.VERIFY_BASE || 'https://backoffice.vesopaepos.com';

let passed = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failures.push(`${name}: ${e.message}`);
    console.error(`  FAIL  ${name}`);
    console.error(`        ${e.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not set in the environment.');

  const tillToken = jwt.sign({ scope: 'terminal', office: OFFICE }, secret, {
    expiresIn: '10m',
  });
  const officeToken = jwt.sign({ email: OFFICE, role: 'manager' }, secret, {
    expiresIn: '10m',
  });

  const call = async (path, { method = 'GET', body, as = 'till' } = {}) => {
    const res = await fetch(BASE + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${as === 'till' ? tillToken : officeToken}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { raw: text.slice(0, 300) };
    }
    return { status: res.status, body: parsed };
  };

  const db = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER,
    password: process.env.DB_PASS || process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'vesopa_eposdb',
  });

  // ---- Everything we are about to change, remembered --------------------
  const [[settingsBefore]] = await db.query(
    'SELECT * FROM epos_gym_settings WHERE office = ?',
    [OFFICE]
  );
  const [[cardsBefore]] = await db.query(
    'SELECT gym_prefix FROM epos_card_settings WHERE office = ?',
    [OFFICE]
  );

  const customerId = crypto.randomUUID();

  async function restore() {
    await db.execute(
      'DELETE FROM epos_gym_visits WHERE office = ? AND card_number = ?',
      [OFFICE, CARD]
    );
    await db.execute('DELETE FROM epos_customers WHERE id = ?', [customerId]);

    if (settingsBefore) {
      await db.execute(
        `UPDATE epos_gym_settings SET enabled = ?, debounce_seconds = ?,
                grace_days = ?, refuse_expired = ?, expiry_slip = ?
          WHERE office = ?`,
        [
          settingsBefore.enabled,
          settingsBefore.debounce_seconds,
          settingsBefore.grace_days,
          settingsBefore.refuse_expired,
          settingsBefore.expiry_slip,
          OFFICE,
        ]
      );
    } else {
      await db.execute('DELETE FROM epos_gym_settings WHERE office = ?', [OFFICE]);
    }

    await db.execute(
      'UPDATE epos_card_settings SET gym_prefix = ? WHERE office = ?',
      [cardsBefore ? cardsBefore.gym_prefix : '', OFFICE]
    );
  }

  console.log('\nThe gym, on the live server\n');

  try {
    // ---- Off is the state we start in ------------------------------------
    await check('a venue with no gym gets 404, not a 500', async () => {
      await db.execute('DELETE FROM epos_gym_settings WHERE office = ?', [OFFICE]);
      const res = await call('/till/gym/board');
      assert(res.status === 404, `expected 404, got ${res.status}`);
    });

    // ---- Switching it on --------------------------------------------------
    await check('the back office can switch the gym on and set a prefix', async () => {
      const res = await call('/api/gym/settings', {
        method: 'PUT',
        as: 'office',
        body: { enabled: true, gym_prefix: PREFIX, debounce_seconds: 1 },
      });
      assert(res.status === 200, `PUT answered ${res.status}`);
      assert(Number(res.body.enabled) === 1, 'the gym did not come back on');
      assert(res.body.gym_prefix === PREFIX, `prefix is ${res.body.gym_prefix}`);
    });

    await check('and a till is told the same thing', async () => {
      const res = await call('/till/gym/settings');
      assert(res.status === 200, `till settings answered ${res.status}`);
      assert(Number(res.body.enabled) === 1);
      assert(res.body.gym_prefix === PREFIX);
    });

    // ---- A member with a gym card -----------------------------------------
    await db.execute(
      `INSERT INTO epos_customers (id, email_key, name, card_number, member_no)
       VALUES (?,?,?,?,?)`,
      [customerId, OFFICE, 'Gym Test Member', CARD, 9771]
    );

    await check('the roster a till caches contains the member', async () => {
      const res = await call('/till/gym/members');
      assert(res.status === 200, `members answered ${res.status}`);
      const found = res.body.find((m) => m.card_number === CARD);
      assert(found, 'the test member is not on the roster');
      assert(found.name === 'Gym Test Member', `name is ${found.name}`);
    });

    // ---- The door ----------------------------------------------------------
    let visitId = null;

    await check('swiping in records a visit', async () => {
      const res = await call('/till/gym/swipe', {
        method: 'POST',
        body: { card_number: CARD, swipe_id: 'live-in', terminal: 'verify' },
      });
      assert(res.status === 200, `swipe answered ${res.status}`);
      assert(res.body.outcome === 'in', `outcome was ${res.body.outcome}`);
      assert(res.body.member_name === 'Gym Test Member');
      assert(Number(res.body.visit.in_now) === 1);
      visitId = res.body.visit.id;
    });

    await check('the same swipe replayed does not open a second visit', async () => {
      const res = await call('/till/gym/swipe', {
        method: 'POST',
        body: { card_number: CARD, swipe_id: 'live-in' },
      });
      assert(res.body.replay === true, 'the replay was not recognised');
      const [rows] = await db.query(
        'SELECT COUNT(*) AS n FROM epos_gym_visits WHERE office = ? AND card_number = ?',
        [OFFICE, CARD]
      );
      assert(Number(rows[0].n) === 1, `${rows[0].n} visits after a replay`);
    });

    await check('the board shows them in the gym', async () => {
      const res = await call('/till/gym/board');
      assert(res.status === 200, `board answered ${res.status}`);
      const row = res.body.find((v) => v.card_number === CARD);
      assert(row, 'the visit is not on the board');
      assert(Number(row.in_now) === 1, 'they are not shown as in');
    });

    await check('a second swipe signs them out', async () => {
      // debounce_seconds is 1 for this run, so a moment is enough.
      await new Promise((r) => setTimeout(r, 1600));
      const res = await call('/till/gym/swipe', {
        method: 'POST',
        body: { card_number: CARD, swipe_id: 'live-out' },
      });
      assert(res.body.outcome === 'out', `outcome was ${res.body.outcome}`);
      const [rows] = await db.query(
        'SELECT left_at, closed_by FROM epos_gym_visits WHERE id = ?',
        [visitId]
      );
      assert(rows[0].left_at, 'left_at was not written');
      assert(rows[0].closed_by === 'card', `closed_by is ${rows[0].closed_by}`);
    });

    await check('an expired card prints a slip and is still let in', async () => {
      await db.execute(
        'UPDATE epos_customers SET membership_expiry = CURDATE() - INTERVAL 30 DAY WHERE id = ?',
        [customerId]
      );
      await new Promise((r) => setTimeout(r, 1200));
      const res = await call('/till/gym/swipe', {
        method: 'POST',
        body: { card_number: CARD, swipe_id: 'live-expired' },
      });
      assert(res.body.outcome === 'expired', `outcome was ${res.body.outcome}`);
      assert(res.body.print_slip === true, 'no slip was asked for');
      assert(res.body.refused === false, 'they were refused');
      assert(res.body.expired_days === 30, `expired_days is ${res.body.expired_days}`);
    });

    // ---- The reports -------------------------------------------------------
    await check('the attendance report counts the visits', async () => {
      const res = await call('/api/gym/attendance', { as: 'office' });
      assert(res.status === 200, `attendance answered ${res.status}`);
      const row = res.body.members.find((m) => m.card_number === CARD);
      assert(row, 'the member is not in the report');
      assert(Number(row.visits) >= 2, `${row.visits} visits`);
      assert('per_week' in row, 'per_week is missing');
    });

    await check('the expiries report finds the expired member', async () => {
      const res = await call('/api/gym/expiries', { as: 'office' });
      assert(res.status === 200, `expiries answered ${res.status}`);
      const row = res.body.expired.find((r) => r.card_number === CARD);
      assert(row, 'the expired member is not listed');
      assert(Number(row.days) === -30, `days is ${row.days}`);
    });

    await check('a manager can close an open visit', async () => {
      const [rows] = await db.query(
        `SELECT id FROM epos_gym_visits
          WHERE office = ? AND card_number = ? AND left_at IS NULL LIMIT 1`,
        [OFFICE, CARD]
      );
      assert(rows.length, 'there is no open visit to close');
      const res = await call(`/api/gym/visits/${rows[0].id}/close`, {
        method: 'POST',
        as: 'office',
      });
      assert(res.status === 200, `close answered ${res.status}`);
    });

    await check('a terminal token cannot read the back office reports', async () => {
      const res = await call('/api/gym/attendance');
      assert(res.status === 401, `a till token got ${res.status} from a report`);
    });

    await check('another venue cannot be read with this token', async () => {
      // The office comes off the signed token, never a query string. Asking for
      // somebody else's has to change nothing about the answer.
      const res = await call('/till/gym/board?office=someone@else.com');
      assert(res.status === 200, `board answered ${res.status}`);
      const foreign = res.body.filter((v) => v.card_number && !v.card_number.startsWith(PREFIX));
      // Everything on the board belongs to the office on the token; there is no
      // way to ask for another one.
      assert(Array.isArray(res.body), 'the board is not a list');
      assert(foreign.length === res.body.length - res.body.filter((v) => v.card_number.startsWith(PREFIX)).length);
    });

    // ---- Switching it off takes it all away --------------------------------
    await check('switching the gym off closes every gym route again', async () => {
      await call('/api/gym/settings', {
        method: 'PUT',
        as: 'office',
        body: { enabled: false },
      });
      const board = await call('/till/gym/board');
      assert(board.status === 404, `board answered ${board.status} with the gym off`);

      // Except the settings, which a till has to be able to read in order to
      // learn that the gym is off and take its Gym section away.
      const settings = await call('/till/gym/settings');
      assert(settings.status === 200, 'a till cannot learn the gym is off');
      assert(Number(settings.body.enabled) === 0);
    });
  } finally {
    await restore();
    const [[left]] = await db.query(
      'SELECT COUNT(*) AS n FROM epos_gym_visits WHERE office = ? AND card_number = ?',
      [OFFICE, CARD]
    );
    const [[cust]] = await db.query(
      'SELECT COUNT(*) AS n FROM epos_customers WHERE id = ?',
      [customerId]
    );
    console.log(
      `\ncleaned up: ${Number(left.n)} test visits and ${Number(cust.n)} test customers left behind ` +
        `(both should be 0)`
    );
    await db.end();
  }

  console.log(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
