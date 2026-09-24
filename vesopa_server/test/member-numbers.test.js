/**
 * One member, one number.
 *
 * This is the half of the card system that had no tests at all. The till's
 * reader is covered by 35 checks in vesopa_epos/test/swipe_cards_test.dart --
 * what a stripe looks like, what breaks a swipe, what a scanner sends -- and
 * everything on this side of the counter, the part that decides *which number a
 * person gets*, was covered by none.
 *
 * The failure that matters here is silent and permanent: two members with the
 * same number, discovered when one of them scans and the till loads the other
 * one's points. A number that has been issued cannot be taken back, because the
 * pass carrying it is already on somebody's phone.
 */

const assert = require('assert');

const M = require('../src/member_numbers');

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

console.log('\nMember numbers\n');

/**
 * A database with just enough behaviour to be wrong in the ways that matter.
 *
 * The sequence row and the `member_no IS NULL` guard are modelled honestly,
 * because those two together are the whole concurrency story.
 */
function makeDb({ customers = [], sequences = {}, failOn = null } = {}) {
  const state = {
    customers: customers.map((c) => ({ ...c })),
    sequences: { ...sequences },
    allocations: 0,
  };

  const run = async (sql, params = []) => {
    if (failOn && sql.includes(failOn)) throw new Error('database is unhappy');

    if (sql.includes('SELECT member_no FROM epos_customers')) {
      const found = state.customers.find(
        (c) => c.id === params[0] && c.email_key === params[1]
      );
      return [found ? [{ member_no: found.member_no }] : []];
    }

    if (sql.includes('INSERT IGNORE INTO epos_card_sequences')) {
      const [office, kind] = params;
      const key = `${office}/${kind}`;
      if (state.sequences[key] === undefined) {
        const highest = state.customers
          .filter((c) => c.email_key === office && c.member_no != null)
          .reduce((max, c) => Math.max(max, Number(c.member_no)), 0);
        state.sequences[key] = highest + 1;
      }
      return [{ affectedRows: 1 }];
    }

    if (sql.includes('UPDATE epos_card_sequences')) {
      const key = `${params[0]}/${params[1]}`;
      state.sequences[key] = (state.sequences[key] || 1) + 1;
      return [{ affectedRows: 1 }];
    }

    if (sql.includes('SELECT next_number FROM epos_card_sequences')) {
      return [[{ next_number: state.sequences[`${params[0]}/${params[1]}`] }]];
    }

    if (sql.includes('UPDATE epos_customers SET member_no')) {
      const [number, id, office] = params;
      const found = state.customers.find(
        (c) => c.id === id && c.email_key === office && c.member_no == null
      );
      if (!found) return [{ affectedRows: 0 }];
      found.member_no = number;
      state.allocations++;
      return [{ affectedRows: 1 }];
    }

    if (sql.includes('SELECT id FROM epos_customers')) {
      return [
        state.customers.filter((c) => c.email_key === params[0] && c.member_no == null),
      ];
    }

    return [[]];
  };

  const pool = {
    query: run,
    execute: run,
    async getConnection() {
      return {
        query: run,
        execute: run,
        beginTransaction: async () => {},
        commit: async () => {},
        rollback: async () => {},
        release: () => {},
      };
    },
    state,
  };
  return pool;
}

const OFFICE = 'manager@vesopa.co.uk';

(async () => {
  await check('a new member gets number 1', async () => {
    const db = makeDb({ customers: [{ id: 'c1', email_key: OFFICE, member_no: null }] });
    assert.strictEqual(await M.ensureMemberNumber(db, OFFICE, 'c1'), 1);
    assert.strictEqual(db.state.customers[0].member_no, 1);
  });

  await check('members are numbered in the order they enrol', async () => {
    const db = makeDb({
      customers: [
        { id: 'c1', email_key: OFFICE, member_no: null },
        { id: 'c2', email_key: OFFICE, member_no: null },
        { id: 'c3', email_key: OFFICE, member_no: null },
      ],
    });
    assert.strictEqual(await M.ensureMemberNumber(db, OFFICE, 'c1'), 1);
    assert.strictEqual(await M.ensureMemberNumber(db, OFFICE, 'c2'), 2);
    assert.strictEqual(await M.ensureMemberNumber(db, OFFICE, 'c3'), 3);
  });

  // Called on every enrolment path and again whenever a card is issued. If it
  // allocated twice, a member's number would change the day they were handed
  // plastic -- and the pass already on their phone would disagree with the till.
  await check('calling it again does not hand out a second number', async () => {
    const db = makeDb({ customers: [{ id: 'c1', email_key: OFFICE, member_no: null }] });
    const first = await M.ensureMemberNumber(db, OFFICE, 'c1');
    for (let i = 0; i < 5; i++) {
      assert.strictEqual(await M.ensureMemberNumber(db, OFFICE, 'c1'), first);
    }
    assert.strictEqual(db.state.allocations, 1, 'allocated more than once');
  });

  // THE ONE THAT WOULD HAVE BITTEN. member_no has been written since cards
  // existed, from the card sequence. A counter starting at 1 would re-issue
  // every number a venue had already handed out.
  await check('an existing venue does not start re-issuing numbers it has used', async () => {
    const db = makeDb({
      customers: [
        { id: 'old1', email_key: OFFICE, member_no: 1 },
        { id: 'old2', email_key: OFFICE, member_no: 50 },
        { id: 'new1', email_key: OFFICE, member_no: null },
      ],
    });
    const number = await M.ensureMemberNumber(db, OFFICE, 'new1');
    assert.strictEqual(number, 51, `got ${number}, which collides with an issued card`);
  });

  await check('one venue’s numbering does not touch another’s', async () => {
    const other = 'other@venue.example';
    const db = makeDb({
      customers: [
        { id: 'a', email_key: OFFICE, member_no: 40 },
        { id: 'b', email_key: other, member_no: null },
      ],
    });
    // A different venue starts at 1 even though the first is up to 40: the
    // number is the member's identity *at this venue* and nowhere else.
    assert.strictEqual(await M.ensureMemberNumber(db, other, 'b'), 1);
  });

  await check('two enrolments racing for the same person settle on one number', async () => {
    const db = makeDb({ customers: [{ id: 'c1', email_key: OFFICE, member_no: null }] });
    const [a, b] = await Promise.all([
      M.ensureMemberNumber(db, OFFICE, 'c1'),
      M.ensureMemberNumber(db, OFFICE, 'c1'),
    ]);
    assert.strictEqual(a, b, 'the same member ended up with two different numbers');
    assert.strictEqual(db.state.allocations, 1, 'the row was written twice');
  });

  await check('an unknown customer is not given a number', async () => {
    const db = makeDb({ customers: [] });
    assert.strictEqual(await M.ensureMemberNumber(db, OFFICE, 'ghost'), null);
  });

  await check('a missing office or customer is a no-op, not a crash', async () => {
    const db = makeDb({ customers: [] });
    assert.strictEqual(await M.ensureMemberNumber(db, '', 'c1'), null);
    assert.strictEqual(await M.ensureMemberNumber(db, OFFICE, ''), null);
  });

  // The callers are a sale, a sign-up form and a back-office save. A member
  // without a number is a cosmetic gap; a sign-up that failed because a counter
  // was locked is a customer at a poster with nothing to show for it.
  await check('a broken database never fails the enrolment', async () => {
    const db = makeDb({
      customers: [{ id: 'c1', email_key: OFFICE, member_no: null }],
      failOn: 'INSERT IGNORE INTO epos_card_sequences',
    });
    const quiet = console.error;
    console.error = () => {};
    try {
      assert.strictEqual(await M.ensureMemberNumber(db, OFFICE, 'c1'), null);
    } finally {
      console.error = quiet;
    }
  });

  // ---------------------------------------------------------------------------
  // Backfill
  // ---------------------------------------------------------------------------

  await check('existing members are given numbers oldest first', async () => {
    const db = makeDb({
      customers: [
        { id: 'c1', email_key: OFFICE, member_no: null },
        { id: 'c2', email_key: OFFICE, member_no: null },
        { id: 'c3', email_key: OFFICE, member_no: null },
      ],
    });
    assert.strictEqual(await M.backfill(db, OFFICE), 3);
    assert.deepStrictEqual(
      db.state.customers.map((c) => c.member_no),
      [1, 2, 3]
    );
  });

  await check('backfill leaves members who already have a number alone', async () => {
    const db = makeDb({
      customers: [
        { id: 'c1', email_key: OFFICE, member_no: 7 },
        { id: 'c2', email_key: OFFICE, member_no: null },
      ],
    });
    await M.backfill(db, OFFICE);
    assert.strictEqual(db.state.customers[0].member_no, 7, 'an issued number changed');
    assert.strictEqual(db.state.customers[1].member_no, 8);
  });

  await check('backfill on a venue with nothing to do is harmless', async () => {
    const db = makeDb({ customers: [{ id: 'c1', email_key: OFFICE, member_no: 1 }] });
    assert.strictEqual(await M.backfill(db, OFFICE), 0);
  });

  // ---------------------------------------------------------------------------
  // The number as it reaches the card
  // ---------------------------------------------------------------------------

  await check('every enrolment route allocates a number', () => {
    const fs = require('fs');
    const path = require('path');
    // Four doors into membership, and the whole point of this module is that
    // all four go through it. A fifth added without one would be a member who
    // silently has no number.
    const doors = ['wallet.js', 'commerce.js', 'backoffice.js', 'server.js'];
    for (const file of doors) {
      const src = fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8');
      if (!src.includes('INSERT INTO epos_customers')) continue;
      assert.ok(
        src.includes('ensureMemberNumber'),
        `${file} creates customers without giving them a member number`
      );
    }
  });

  // Issuing plastic must not change who somebody is.
  await check('issuing a card no longer overwrites the member number', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'src', 'cards.js'),
      'utf8'
    );
    assert.ok(
      !/SET card_number = \?, member_no = \?/.test(src),
      'cards.js still writes member_no from the card sequence'
    );
    assert.ok(src.includes('ensureMemberNumber'), 'cards.js does not reuse the member number');
  });

  console.log(`\n${passed} checks passed\n`);
})();
