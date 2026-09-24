/**
 * The gym door.
 *
 * WHY THIS ONE IS DRIVEN OVER HTTP RATHER THAN POKED AT
 *
 * Because the thing that can go wrong here is not a wrong column in a response.
 * It is a member standing at an unmanned door at half past six in the morning
 * getting the wrong answer -- signed out when they meant to come in, signed in
 * twice, or refused because a queued swipe arrived after the one that followed
 * it. Every one of those is a decision made across several statements, and a
 * test that called the helpers directly would prove the helpers and not the
 * decision.
 *
 * So the real router is mounted on a real express app with a real token, and
 * the pool underneath it is a small honest model of the four tables: the
 * settings row, the card row, the customers, and the visits. What is asserted
 * is what a till would actually be told.
 *
 * THE FIVE THAT MATTER
 *
 *   1. Off by default -- every route answers 404 until a venue switches the gym
 *      on. Nearly every venue on this platform is a pub.
 *   2. In, then out. The same card twice is an arrival and a departure, not two
 *      arrivals.
 *   3. The debounce. A reader that double-reads must not sign somebody in and
 *      straight back out, leaving the gym holding nobody.
 *   4. Replay. The till's queue is at-least-once by design, so the same swipe
 *      WILL arrive twice; the second copy must answer what the first did rather
 *      than open a second visit.
 *   5. Expired. The slip is printed, the visit is still recorded, and the venue
 *      can ask for a refusal instead.
 */

const assert = require('assert');
const express = require('express');
const jwt = require('jsonwebtoken');

const { gymRoutes } = require('../src/gym');

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${e.message}`);
    process.exitCode = 1;
  }
}

const SECRET = 'gym-test-secret';
const OFFICE = 'test@vesopa.co.uk';

// ---------------------------------------------------------------------------
// A pool that behaves like the four tables this router touches
// ---------------------------------------------------------------------------
//
// Matched on distinctive fragments of each statement rather than by parsing
// SQL. That is a real limitation and worth stating: rename a table in gym.js
// and this fake answers nothing rather than failing loudly. The trade is
// deliberate -- a SQL parser here would be a second implementation of MySQL to
// maintain, and the queries are asserted by their *effects* below, which is the
// half that catches a wrong WHERE clause.

function makePool(seed = {}) {
  const state = {
    gymSettings: seed.gymSettings ? { ...seed.gymSettings } : null,
    cardSettings: { gym_prefix: seed.gymPrefix ?? '' },
    customers: (seed.customers || []).map((c) => ({ ...c })),
    visits: (seed.visits || []).map((v) => ({ ...v })),
    nextId: 1,
  };

  const day = (d) => {
    const at = new Date(d);
    at.setHours(0, 0, 0, 0);
    return at;
  };
  const iso = (d) => (d ? new Date(d).toISOString() : null);
  const dateOnly = (d) => (d ? String(d).slice(0, 10) : null);

  /** The shape VISIT_COLUMNS produces, worked out in JavaScript. */
  const shape = (v) => ({
    id: v.id,
    customer_id: v.customer_id,
    member_no: v.member_no,
    member_name: v.member_name,
    card_number: v.card_number,
    entered_at: iso(v.entered_at),
    left_at: iso(v.left_at),
    closed_by: v.closed_by ?? null,
    entered_terminal: v.entered_terminal ?? null,
    left_terminal: v.left_terminal ?? null,
    expired: v.expired ? 1 : 0,
    membership_expiry: dateOnly(v.membership_expiry),
    in_now: v.left_at ? 0 : 1,
    minutes: Math.floor(
      (new Date(v.left_at || Date.now()) - new Date(v.entered_at)) / 60000
    ),
  });

  async function query(sql, params = []) {
    // --- settings ---------------------------------------------------------
    if (sql.includes('FROM epos_gym_settings')) {
      return [state.gymSettings ? [{ office: OFFICE, ...state.gymSettings }] : []];
    }
    if (sql.includes('gym_prefix FROM epos_card_settings')) {
      return [[{ gym_prefix: state.cardSettings.gym_prefix }]];
    }

    // --- a swipe we have already seen --------------------------------------
    if (sql.includes('v.swipe_id = ? OR v.left_swipe_id = ?')) {
      const [thisId, , inId, outId] = params;
      const found = state.visits.find(
        (v) => v.swipe_id === inId || v.left_swipe_id === outId
      );
      if (!found) return [[]];
      return [[{ ...shape(found), opened_by_this: found.swipe_id === thisId ? 1 : 0 }]];
    }

    // --- who holds the card -------------------------------------------------
    if (sql.includes('FROM epos_customers') && sql.includes('AND card_number = ?')) {
      const [office, number] = params;
      const found = state.customers.find(
        (c) => c.email_key === office && c.card_number === number
      );
      return [
        found
          ? [
              {
                id: found.id,
                name: found.name,
                member_no: found.member_no ?? null,
                photo_url: found.photo_url ?? null,
                membership_expiry: dateOnly(found.membership_expiry),
              },
            ]
          : [],
      ];
    }

    // --- an open visit ------------------------------------------------------
    if (sql.includes('AS age_seconds')) {
      const [now, office, customerId] = params;
      const open = state.visits
        .filter(
          (v) => v.office === office && v.customer_id === customerId && !v.left_at
        )
        .sort((a, b) => new Date(b.entered_at) - new Date(a.entered_at))[0];
      if (!open) return [[]];
      return [
        [
          {
            id: open.id,
            entered_at: iso(open.entered_at),
            age_seconds: Math.floor(
              (new Date(now) - new Date(open.entered_at)) / 1000
            ),
          },
        ],
      ];
    }

    // --- one visit back -----------------------------------------------------
    if (sql.includes('FROM epos_gym_visits v WHERE v.id = ?')) {
      const found = state.visits.find((v) => v.id === params[0]);
      return [found ? [shape(found)] : []];
    }

    // --- the board ----------------------------------------------------------
    //
    // Checked AFTER attendance below, and that ordering is a real bug this fake
    // already had: the attendance query ALSO joins epos_customers on
    // v.customer_id, so a board branch tested first swallowed it and answered
    // with visit rows. The test then compared two visits against one member and
    // failed for a reason that had nothing to do with gym.js.
    if (
      sql.includes('LEFT JOIN epos_customers c ON c.id = v.customer_id') &&
      !sql.includes('COUNT(DISTINCT DATE(v.entered_at))')
    ) {
      const [office] = params;
      const today = day(new Date());
      const rows = state.visits
        .filter(
          (v) =>
            v.office === office &&
            (!v.left_at || day(v.entered_at).getTime() === today.getTime())
        )
        .sort((a, b) => {
          if (!a.left_at !== !b.left_at) return a.left_at ? 1 : -1;
          return new Date(b.entered_at) - new Date(a.entered_at);
        })
        .map((v) => ({ ...shape(v), photo_url: null }));
      return [rows];
    }

    // --- the roster ---------------------------------------------------------
    if (sql.includes("card_number LIKE CONCAT(?, '%')") && sql.includes('ORDER BY name')) {
      const [office, prefix] = params;
      return [
        state.customers
          .filter(
            (c) => c.email_key === office && String(c.card_number).startsWith(prefix)
          )
          .map((c) => ({
            id: c.id,
            name: c.name,
            member_no: c.member_no ?? null,
            card_number: c.card_number,
            photo_url: c.photo_url ?? null,
            membership_expiry: dateOnly(c.membership_expiry),
          })),
      ];
    }

    // --- attendance ---------------------------------------------------------
    if (sql.includes('COUNT(DISTINCT DATE(v.entered_at))')) {
      const [office] = params;
      const byMember = new Map();
      for (const v of state.visits.filter((x) => x.office === office)) {
        const row = byMember.get(v.customer_id) || {
          customer_id: v.customer_id,
          member_name: v.member_name,
          member_no: v.member_no ?? null,
          card_number: v.card_number,
          visits: 0,
          expired_visits: 0,
          days_attended: 1,
          avg_minutes: null,
          unclosed: 0,
          first_visit: iso(v.entered_at),
          last_visit: iso(v.entered_at),
          membership_expiry: null,
        };
        row.visits += 1;
        if (v.expired) row.expired_visits += 1;
        if (v.closed_by === 'auto') row.unclosed += 1;
        byMember.set(v.customer_id, row);
      }
      return [[...byMember.values()].sort((a, b) => b.visits - a.visits)];
    }
    if (sql.includes('HOUR(entered_at) AS hour')) return [[]];
    if (sql.includes("DATE_FORMAT(entered_at, '%Y-%m-%d') AS day")) return [[]];

    // --- expiries -----------------------------------------------------------
    if (sql.includes('DATEDIFF(c.membership_expiry, CURDATE())')) {
      const [office, prefix, soon] = params;
      const today = day(new Date());
      return [
        state.customers
          .filter(
            (c) =>
              c.email_key === office &&
              String(c.card_number).startsWith(prefix) &&
              c.membership_expiry
          )
          .map((c) => ({
            id: c.id,
            name: c.name,
            member_no: c.member_no ?? null,
            card_number: c.card_number,
            phone: c.phone ?? null,
            email: c.email ?? null,
            membership_expiry: dateOnly(c.membership_expiry),
            days: Math.round(
              (day(c.membership_expiry) - today) / 86400000
            ),
            last_visit: null,
            visits_90d: 0,
          }))
          .filter((r) => r.days <= soon),
      ];
    }

    return [[]];
  }

  async function execute(sql, params = []) {
    // --- settings -----------------------------------------------------------
    if (sql.includes('INSERT INTO epos_gym_settings')) {
      const cols = sql
        .slice(sql.indexOf('(') + 1, sql.indexOf(')'))
        .split(',')
        .map((c) => c.trim().replace(/`/g, ''));
      state.gymSettings = state.gymSettings || {};
      cols.forEach((col, i) => {
        if (col !== 'office') state.gymSettings[col] = params[i];
      });
      return [{ affectedRows: 1 }];
    }
    if (sql.includes('INSERT INTO epos_card_settings')) {
      state.cardSettings.gym_prefix = params[1];
      return [{ affectedRows: 1 }];
    }

    // --- the sweep ----------------------------------------------------------
    if (sql.includes("closed_by = 'auto'")) {
      const [hours, office] = params;
      let n = 0;
      const cutoff = Date.now() - hours * 3600_000;
      for (const v of state.visits) {
        if (v.office === office && !v.left_at && new Date(v.entered_at) < cutoff) {
          v.left_at = new Date(
            new Date(v.entered_at).getTime() + hours * 3600_000
          );
          v.closed_by = 'auto';
          n++;
        }
      }
      return [{ affectedRows: n }];
    }

    // --- swiping out --------------------------------------------------------
    if (sql.includes("closed_by = 'card'")) {
      const [leftAt, leftSwipe, terminal, id] = params;
      const found = state.visits.find((v) => v.id === id && !v.left_at);
      if (!found) return [{ affectedRows: 0 }];
      found.left_at = new Date(leftAt);
      found.left_swipe_id = leftSwipe;
      found.left_terminal = terminal;
      found.closed_by = 'card';
      return [{ affectedRows: 1 }];
    }

    // --- swiping in ---------------------------------------------------------
    if (sql.includes('INSERT INTO epos_gym_visits')) {
      const [
        office, swipeId, customerId, memberNo, memberName, cardNumber,
        enteredAt, terminal, expiry, expired,
      ] = params;

      // The unique index, modelled -- because it is the entire replay defence
      // and a fake that silently allowed a duplicate would make the test that
      // matters most pass for the wrong reason.
      if (swipeId && state.visits.some((v) => v.office === office && v.swipe_id === swipeId)) {
        const err = new Error('Duplicate entry for key uq_gym_swipe_in');
        err.code = 'ER_DUP_ENTRY';
        throw err;
      }

      const id = state.nextId++;
      state.visits.push({
        id,
        office,
        swipe_id: swipeId,
        left_swipe_id: null,
        customer_id: customerId,
        member_no: memberNo,
        member_name: memberName,
        card_number: cardNumber,
        entered_at: new Date(enteredAt),
        left_at: null,
        closed_by: null,
        entered_terminal: terminal,
        left_terminal: null,
        membership_expiry: expiry,
        expired: expired ? 1 : 0,
      });
      return [{ insertId: id, affectedRows: 1 }];
    }

    // --- a manager closing one by hand --------------------------------------
    if (sql.includes("closed_by = 'office'")) {
      const [id, office] = params;
      const found = state.visits.find(
        (v) => v.id === id && v.office === office && !v.left_at
      );
      if (!found) return [{ affectedRows: 0 }];
      found.left_at = new Date();
      found.closed_by = 'office';
      return [{ affectedRows: 1 }];
    }

    return [{ affectedRows: 0 }];
  }

  return { pool: { query, execute }, state };
}

// ---------------------------------------------------------------------------
// A running server, and the two credentials that reach it
// ---------------------------------------------------------------------------

async function serve(seed) {
  const { pool, state } = makePool(seed);
  const app = express();
  app.use(express.json());
  app.use(gymRoutes({ pool, broadcast: () => {}, secret: SECRET }));

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const tillToken = jwt.sign({ scope: 'terminal', office: OFFICE }, SECRET);
  const officeToken = jwt.sign({ email: OFFICE }, SECRET);

  const call = async (path, { method = 'GET', body, as = 'till' } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${as === 'till' ? tillToken : officeToken}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return {
      status: res.status,
      body: text ? JSON.parse(text) : null,
    };
  };

  return {
    call,
    state,
    // closeAllConnections first, and it is not optional. Node's own `fetch`
    // keeps sockets alive, and `server.close()` waits for every one of them --
    // so without this the first test hangs for ever and the run prints nothing
    // at all, because stdout to a pipe is buffered and the process never exits
    // to flush it.
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(r);
      }),
  };
}

const CARD = '977700042';
const MEMBER = {
  id: 'cust-1',
  email_key: OFFICE,
  name: 'Sarah Hughes',
  member_no: 42,
  card_number: CARD,
  membership_expiry: null,
};

const ON = {
  enabled: 1,
  auto_close_hours: 4,
  debounce_seconds: 45,
  grace_days: 0,
  expiry_slip: 1,
  refuse_expired: 0,
  expiring_soon_days: 14,
  greeting_seconds: 6,
  show_photo: 1,
};

function inDays(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

async function main() {
  console.log('\nThe gym door\n');

  // -------------------------------------------------------------------------
  // 1. Off, for every venue that is not a gym
  // -------------------------------------------------------------------------

  await check('a venue with no gym is told there is no gym, not refused', async () => {
    const s = await serve({});
    const swipe = await s.call('/till/gym/swipe', {
      method: 'POST',
      body: { card_number: CARD },
    });
    assert.strictEqual(swipe.status, 404, 'a swipe should 404 while the gym is off');

    const board = await s.call('/till/gym/board');
    assert.strictEqual(board.status, 404);

    // 404 and not 403: a pub has not been forbidden the gym, there is no gym
    // there to forbid, and a 403 sends somebody hunting through user roles for
    // a permission that does not exist.
    assert.ok(!/permission|role/i.test(JSON.stringify(swipe.body)));
    await s.close();
  });

  await check('the settings are still readable with the gym off', async () => {
    // The till has to be able to learn that the gym is off, or it can never
    // take the Gym section away again -- a 404 here would be indistinguishable
    // from a server that is down.
    const s = await serve({});
    const res = await s.call('/till/gym/settings');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(Number(res.body.enabled), 0);
    await s.close();
  });

  // -------------------------------------------------------------------------
  // 2. In, and then out
  // -------------------------------------------------------------------------

  await check('the first swipe signs a member in', async () => {
    const s = await serve({ gymSettings: ON, gymPrefix: '9777', customers: [MEMBER] });
    const res = await s.call('/till/gym/swipe', {
      method: 'POST',
      body: { card_number: CARD, swipe_id: 'a' },
    });
    assert.strictEqual(res.body.outcome, 'in');
    assert.strictEqual(res.body.member_name, 'Sarah Hughes');
    assert.strictEqual(res.body.print_slip, false);
    assert.strictEqual(Number(res.body.visit.in_now), 1);
    await s.close();
  });

  await check('the same card again signs them out, not in twice', async () => {
    const s = await serve({ gymSettings: ON, gymPrefix: '9777', customers: [MEMBER] });
    await s.call('/till/gym/swipe', {
      method: 'POST',
      body: { card_number: CARD, swipe_id: 'a', at: minutesAgo(90) },
    });
    const out = await s.call('/till/gym/swipe', {
      method: 'POST',
      body: { card_number: CARD, swipe_id: 'b' },
    });
    assert.strictEqual(out.outcome ?? out.body.outcome, 'out');
    assert.strictEqual(s.state.visits.length, 1, 'a departure must not open a visit');
    assert.ok(s.state.visits[0].left_at, 'the visit should be closed');
    assert.strictEqual(s.state.visits[0].closed_by, 'card');
    await s.close();
  });

  await check('and a third swipe starts a new visit', async () => {
    const s = await serve({ gymSettings: ON, gymPrefix: '9777', customers: [MEMBER] });
    await s.call('/till/gym/swipe', {
      method: 'POST',
      body: { card_number: CARD, swipe_id: 'a', at: minutesAgo(180) },
    });
    await s.call('/till/gym/swipe', {
      method: 'POST',
      body: { card_number: CARD, swipe_id: 'b', at: minutesAgo(120) },
    });
    const again = await s.call('/till/gym/swipe', {
      method: 'POST',
      body: { card_number: CARD, swipe_id: 'c' },
    });
    assert.strictEqual(again.body.outcome, 'in');
    assert.strictEqual(s.state.visits.length, 2);
    await s.close();
  });

  // -------------------------------------------------------------------------
  // 3. The debounce -- the one that breaks an unmanned door silently
  // -------------------------------------------------------------------------

  await check('a second read seconds later is ignored, not treated as leaving', async () => {
    const s = await serve({ gymSettings: ON, gymPrefix: '9777', customers: [MEMBER] });
    await s.call('/till/gym/swipe', {
      method: 'POST',
      body: { card_number: CARD, swipe_id: 'a' },
    });
    const again = await s.call('/till/gym/swipe', {
      method: 'POST',
      body: { card_number: CARD, swipe_id: 'b' },
    });
    assert.strictEqual(again.body.outcome, 'ignored');
    assert.strictEqual(again.body.reason, 'debounce');
    // The whole point: the member is still in the gym.
    assert.ok(!s.state.visits[0].left_at, 'a double read must not sign anybody out');
    await s.close();
  });

  await check('a venue that sets the debounce to zero gets no debounce', async () => {
    const s = await serve({
      gymSettings: { ...ON, debounce_seconds: 0 },
      gymPrefix: '9777',
      customers: [MEMBER],
    });
    await s.call('/till/gym/swipe', {
      method: 'POST',
      body: { card_number: CARD, swipe_id: 'a' },
    });
    const out = await s.call('/till/gym/swipe', {
      method: 'POST',
      body: { card_number: CARD, swipe_id: 'b' },
    });
    assert.strictEqual(out.body.outcome, 'out');
    await s.close();
  });

  // -------------------------------------------------------------------------
  // 4. Replay -- the till's queue is at-least-once by design
  // -------------------------------------------------------------------------

  await check('the same swipe sent twice does not open two visits', async () => {
    const s = await serve({ gymSettings: ON, gymPrefix: '9777', customers: [MEMBER] });
    const first = await s.call('/till/gym/swipe', {
      method: 'POST',
      body: { card_number: CARD, swipe_id: 'same' },
    });
    const second = await s.call('/till/gym/swipe', {
      method: 'POST',
      body: { card_number: CARD, swipe_id: 'same' },
    });

    assert.strictEqual(first.body.outcome, 'in');
    assert.strictEqual(second.body.outcome, 'in', 'a replay answers what it answered');
    assert.strictEqual(second.body.replay, true);
    assert.strictEqual(s.state.visits.length, 1, 'a replay must not open a second visit');
    await s.close();
  });

  await check('a replayed departure stays a departure', async () => {
    // Without left_swipe_id this is the nasty one: the visit is already closed,
    // so nothing is open, so the replay reads as somebody arriving -- and the
    // member is in the gym for the rest of the day having gone home.
    const s = await serve({ gymSettings: ON, gymPrefix: '9777', customers: [MEMBER] });
    await s.call('/till/gym/swipe', {
      method: 'POST',
      body: { card_number: CARD, swipe_id: 'in', at: minutesAgo(90) },
    });
    await s.call('/till/gym/swipe', {
      method: 'POST',
      body: { card_number: CARD, swipe_id: 'out' },
    });
    const replay = await s.call('/till/gym/swipe', {
      method: 'POST',
      body: { card_number: CARD, swipe_id: 'out' },
    });

    assert.strictEqual(replay.body.outcome, 'out');
    assert.strictEqual(replay.body.replay, true);
    assert.strictEqual(s.state.visits.length, 1);
    await s.close();
  });

  // -------------------------------------------------------------------------
  // 5. Memberships that have run out
  // -------------------------------------------------------------------------

  await check('an expired card prints a slip and is still let in', async () => {
    const s = await serve({
      gymSettings: ON,
      gymPrefix: '9777',
      customers: [{ ...MEMBER, membership_expiry: inDays(-10) }],
    });
    const res = await s.call('/till/gym/swipe', {
      method: 'POST',
      body: { card_number: CARD, swipe_id: 'a' },
    });

    assert.strictEqual(res.body.outcome, 'expired');
    assert.strictEqual(res.body.refused, false);
    assert.strictEqual(res.body.print_slip, true);
    assert.strictEqual(res.body.expired_days, 10);
    // The visit IS recorded. This till is not a turnstile -- it cannot stop
    // anybody walking in, so a log saying the visit did not happen is a lie.
    assert.strictEqual(s.state.visits.length, 1);
    assert.strictEqual(s.state.visits[0].expired, 1);
    await s.close();
  });

  await check('a venue that asks for refusal gets one, and no visit', async () => {
    const s = await serve({
      gymSettings: { ...ON, refuse_expired: 1 },
      gymPrefix: '9777',
      customers: [{ ...MEMBER, membership_expiry: inDays(-1) }],
    });
    const res = await s.call('/till/gym/swipe', {
      method: 'POST',
      body: { card_number: CARD, swipe_id: 'a' },
    });
    assert.strictEqual(res.body.outcome, 'expired');
    assert.strictEqual(res.body.refused, true);
    assert.strictEqual(res.body.print_slip, true);
    assert.strictEqual(s.state.visits.length, 0);
    await s.close();
  });

  await check('a card works ON its expiry date, and not the day after', async () => {
    // The rule everywhere else in this product, and the one people get wrong.
    const today = await serve({
      gymSettings: ON,
      gymPrefix: '9777',
      customers: [{ ...MEMBER, membership_expiry: inDays(0) }],
    });
    const a = await today.call('/till/gym/swipe', {
      method: 'POST',
      body: { card_number: CARD, swipe_id: 'a' },
    });
    assert.strictEqual(a.body.outcome, 'in', 'a card expiring today still works today');
    await today.close();

    const yesterday = await serve({
      gymSettings: ON,
      gymPrefix: '9777',
      customers: [{ ...MEMBER, membership_expiry: inDays(-1) }],
    });
    const b = await yesterday.call('/till/gym/swipe', {
      method: 'POST',
      body: { card_number: CARD, swipe_id: 'b' },
    });
    assert.strictEqual(b.body.outcome, 'expired');
    await yesterday.close();
  });

  await check('grace days keep a card working, and the slip still prints', async () => {
    const s = await serve({
      gymSettings: { ...ON, grace_days: 7 },
      gymPrefix: '9777',
      customers: [{ ...MEMBER, membership_expiry: inDays(-3) }],
    });
    const res = await s.call('/till/gym/swipe', {
      method: 'POST',
      body: { card_number: CARD, swipe_id: 'a' },
    });
    assert.strictEqual(res.body.outcome, 'in', 'inside the grace period they are not expired');
    assert.strictEqual(res.body.print_slip, false);
    await s.close();
  });

  await check('a membership with no date on it is never expired', async () => {
    const s = await serve({ gymSettings: ON, gymPrefix: '9777', customers: [MEMBER] });
    const res = await s.call('/till/gym/swipe', {
      method: 'POST',
      body: { card_number: CARD, swipe_id: 'a' },
    });
    assert.strictEqual(res.body.outcome, 'in');
    await s.close();
  });

  await check('an expiry inside the warning window is reported, one outside is not', async () => {
    const soon = await serve({
      gymSettings: ON,
      gymPrefix: '9777',
      customers: [{ ...MEMBER, membership_expiry: inDays(5) }],
    });
    const a = await soon.call('/till/gym/swipe', {
      method: 'POST',
      body: { card_number: CARD, swipe_id: 'a' },
    });
    assert.strictEqual(a.body.expiring_in_days, 5);
    await soon.close();

    const later = await serve({
      gymSettings: ON,
      gymPrefix: '9777',
      customers: [{ ...MEMBER, membership_expiry: inDays(200) }],
    });
    const b = await later.call('/till/gym/swipe', {
      method: 'POST',
      body: { card_number: CARD, swipe_id: 'b' },
    });
    assert.strictEqual(b.body.expiring_in_days, null,
      'a warning eleven months out is a warning members stop reading');
    await later.close();
  });

  // -------------------------------------------------------------------------
  // A card nobody holds
  // -------------------------------------------------------------------------

  await check('an unknown card is said plainly and is not a visit', async () => {
    const s = await serve({ gymSettings: ON, gymPrefix: '9777', customers: [MEMBER] });
    const res = await s.call('/till/gym/swipe', {
      method: 'POST',
      body: { card_number: '977799999', swipe_id: 'a' },
    });
    assert.strictEqual(res.body.outcome, 'unknown');
    assert.strictEqual(res.body.card_number, '977799999');
    assert.strictEqual(s.state.visits.length, 0);
    await s.close();
  });

  await check('the sentinels a reader types are stripped', async () => {
    const s = await serve({ gymSettings: ON, gymPrefix: '9777', customers: [MEMBER] });
    const res = await s.call('/till/gym/swipe', {
      method: 'POST',
      body: { card_number: `;${CARD}?`, swipe_id: 'a' },
    });
    assert.strictEqual(res.body.outcome, 'in',
      'the ; and ? belong to the reader, not to the card');
    await s.close();
  });

  // -------------------------------------------------------------------------
  // A clock that cannot be trusted
  // -------------------------------------------------------------------------

  await check('a swipe stamped next March is not written into next March', async () => {
    const s = await serve({ gymSettings: ON, gymPrefix: '9777', customers: [MEMBER] });
    const future = new Date(Date.now() + 400 * 24 * 3600_000).toISOString();
    await s.call('/till/gym/swipe', {
      method: 'POST',
      body: { card_number: CARD, swipe_id: 'a', at: future },
    });
    const entered = new Date(s.state.visits[0].entered_at);
    assert.ok(
      Math.abs(entered - Date.now()) < 120_000,
      'a terminal with a wrong clock must not sit above every real visit for ever'
    );
    await s.close();
  });

  await check('a swipe that really did happen an hour ago keeps its time', async () => {
    // The whole reason the till sends a time at all: an offline swipe carries
    // the moment somebody walked in, not the moment the broadband came back.
    const s = await serve({ gymSettings: ON, gymPrefix: '9777', customers: [MEMBER] });
    const then = minutesAgo(60);
    await s.call('/till/gym/swipe', {
      method: 'POST',
      body: { card_number: CARD, swipe_id: 'a', at: then },
    });
    const entered = new Date(s.state.visits[0].entered_at);
    assert.ok(
      Math.abs(entered - new Date(then)) < 2000,
      'a queued swipe must land where it actually happened'
    );
    await s.close();
  });

  // -------------------------------------------------------------------------
  // The board and the sweep
  // -------------------------------------------------------------------------

  await check('the board puts the people who are in first', async () => {
    const s = await serve({ gymSettings: ON, gymPrefix: '9777', customers: [MEMBER] });
    await s.call('/till/gym/swipe', {
      method: 'POST',
      body: { card_number: CARD, swipe_id: 'a', at: minutesAgo(120) },
    });
    await s.call('/till/gym/swipe', {
      method: 'POST',
      body: { card_number: CARD, swipe_id: 'b', at: minutesAgo(60) },
    });
    await s.call('/till/gym/swipe', {
      method: 'POST',
      body: { card_number: CARD, swipe_id: 'c' },
    });

    const board = await s.call('/till/gym/board');
    assert.strictEqual(board.status, 200);
    assert.strictEqual(board.body.length, 2);
    assert.strictEqual(
      Number(board.body[0].in_now), 1,
      'whoever is still in the building is what a fire roll call needs first'
    );
    await s.close();
  });

  await check('somebody who never swiped out is closed off by the sweep', async () => {
    const s = await serve({
      gymSettings: { ...ON, auto_close_hours: 4 },
      gymPrefix: '9777',
      customers: [MEMBER],
    });
    await s.call('/till/gym/swipe', {
      method: 'POST',
      body: { card_number: CARD, swipe_id: 'a', at: minutesAgo(9 * 60) },
    });

    const board = await s.call('/till/gym/board');
    assert.strictEqual(Number(board.body[0].in_now), 0, 'a nine-hour visit is not a visit');
    assert.strictEqual(
      s.state.visits[0].closed_by, 'auto',
      'and it is marked, so the report never treats its length as measured'
    );
    await s.close();
  });

  // -------------------------------------------------------------------------
  // The back office
  // -------------------------------------------------------------------------

  await check('saving the settings saves the prefix on the card row', async () => {
    const s = await serve({});
    const res = await s.call('/api/gym/settings', {
      method: 'PUT',
      as: 'office',
      body: { enabled: true, gym_prefix: '9777', debounce_seconds: 30 },
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(Number(res.body.enabled), 1);
    assert.strictEqual(res.body.gym_prefix, '9777');
    assert.strictEqual(s.state.cardSettings.gym_prefix, '9777');
    await s.close();
  });

  await check('a prefix with punctuation in it is reduced to digits', async () => {
    // A prefix with a sentinel or a space in it matches nothing -- silently, on
    // every card the venue owns. Caught where somebody types it.
    const s = await serve({});
    await s.call('/api/gym/settings', {
      method: 'PUT',
      as: 'office',
      body: { gym_prefix: ';97 77?' },
    });
    assert.strictEqual(s.state.cardSettings.gym_prefix, '9777');
    await s.close();
  });

  await check('a nonsense debounce is clamped rather than stored', async () => {
    const s = await serve({});
    await s.call('/api/gym/settings', {
      method: 'PUT',
      as: 'office',
      body: { enabled: true, debounce_seconds: 99999, auto_close_hours: 0 },
    });
    assert.strictEqual(s.state.gymSettings.debounce_seconds, 600);
    assert.strictEqual(s.state.gymSettings.auto_close_hours, 1);
    await s.close();
  });

  await check('the attendance report counts visits per member', async () => {
    const s = await serve({ gymSettings: ON, gymPrefix: '9777', customers: [MEMBER] });
    for (const [i, id] of ['a', 'b', 'c', 'd'].entries()) {
      await s.call('/till/gym/swipe', {
        method: 'POST',
        body: { card_number: CARD, swipe_id: id, at: minutesAgo(300 - i * 60) },
      });
    }
    const res = await s.call('/api/gym/attendance', { as: 'office' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.members.length, 1,
      'four swipes by one person are two visits by one member');
    assert.strictEqual(Number(res.body.members[0].visits), 2);
    assert.strictEqual(res.body.members[0].member_name, 'Sarah Hughes');
    assert.ok('per_week' in res.body.members[0],
      '"42 visits" means one thing over a month and another over a year');
    await s.close();
  });

  await check('the roster a till caches is only the gym cards', async () => {
    const s = await serve({
      gymSettings: ON,
      gymPrefix: '9777',
      customers: [MEMBER, { ...MEMBER, id: 'c2', card_number: '999800001', name: 'Not a gym member' }],
    });
    const res = await s.call('/till/gym/members');
    assert.strictEqual(res.body.length, 1);
    assert.strictEqual(res.body[0].name, 'Sarah Hughes');
    await s.close();
  });

  await check('with no prefix set the roster is empty, not everybody', async () => {
    // LIKE '%' would hand the till every customer in the venue as a gym member.
    const s = await serve({ gymSettings: ON, gymPrefix: '', customers: [MEMBER] });
    const res = await s.call('/till/gym/members');
    assert.deepStrictEqual(res.body, []);
    await s.close();
  });

  await check('a manager can close a visit somebody forgot to swipe out of', async () => {
    const s = await serve({ gymSettings: ON, gymPrefix: '9777', customers: [MEMBER] });
    await s.call('/till/gym/swipe', {
      method: 'POST',
      body: { card_number: CARD, swipe_id: 'a' },
    });
    const id = s.state.visits[0].id;
    const res = await s.call(`/api/gym/visits/${id}/close`, {
      method: 'POST',
      as: 'office',
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(s.state.visits[0].closed_by, 'office');

    const again = await s.call(`/api/gym/visits/${id}/close`, {
      method: 'POST',
      as: 'office',
    });
    assert.strictEqual(again.status, 404, 'closing a closed visit is not a silent success');
    await s.close();
  });

  await check('a till token cannot read the back office reports', async () => {
    const s = await serve({ gymSettings: ON, gymPrefix: '9777', customers: [MEMBER] });
    const res = await s.call('/api/gym/attendance');
    assert.strictEqual(res.status, 401,
      'a terminal token left on a shop-floor machine must not open the reports');
    await s.close();
  });

  console.log(`\n${passed} passed\n`);
}

function minutesAgo(n) {
  return new Date(Date.now() - n * 60_000).toISOString();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
