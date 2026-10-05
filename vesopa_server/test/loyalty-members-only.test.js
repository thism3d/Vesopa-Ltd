/**
 * A loyalty app for paid-up members only (2026-10-05). No database: the rule
 * is a pure function and the switch is read through a scripted pool.
 */
const assert = require('assert');
const gate = require('../src/loyalty_members_only');

let passed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); } catch (e) {
    console.error(`  FAIL  ${name}\n        ${e.message}`); process.exitCode = 1;
  }
}

(async () => {
  console.log('\nLoyalty app: paid-up members only\n');
  const day = '2026-10-05';

  await check('an expiry date in the future is paid up, a past one is not', () => {
    assert.strictEqual(gate.paidUpRow({ membership_expiry: '2027-05-31' }, day), true);
    assert.strictEqual(gate.paidUpRow({ membership_expiry: '2026-10-05' }, day), true, 'the last day still counts');
    assert.strictEqual(gate.paidUpRow({ membership_expiry: '2026-10-04' }, day), false);
  });

  await check('somebody who never paid is not let in', () => {
    assert.strictEqual(gate.paidUpRow({}, day), false);
    assert.strictEqual(gate.paidUpRow(null, day), false);
  });

  await check('a plan member follows the plan: frozen is paid time, pending and cancelled are not', () => {
    assert.strictEqual(gate.paidUpRow({ membership_status: 'active', membership_expiry: '2027-01-01' }, day), true);
    assert.strictEqual(gate.paidUpRow({ membership_status: 'active', membership_expiry: '2026-01-01' }, day), false);
    assert.strictEqual(gate.paidUpRow({ membership_status: 'frozen', membership_expiry: '2026-01-01' }, day), true);
    assert.strictEqual(gate.paidUpRow({ membership_status: 'pending', membership_expiry: '2027-01-01' }, day), false);
    assert.strictEqual(gate.paidUpRow({ membership_status: 'cancelled', membership_expiry: '2027-01-01' }, day), false);
  });

  await check('a DATE read as a Date object is its own calendar day', () => {
    assert.strictEqual(gate.paidUpRow({ membership_expiry: new Date(2027, 4, 31) }, day), true);
  });

  await check('the switch is off where the column has not arrived', async () => {
    const db = { query: async () => { const e = new Error('no'); e.code = 'ER_BAD_FIELD_ERROR'; throw e; } };
    assert.strictEqual(await gate.membersOnly(db, 'old@vesopa.test'), false);
  });

  await check('the switch is read, and forgotten when it changes', async () => {
    let on = 1;
    const db = { query: async () => [[{ members_only: on }]] };
    assert.strictEqual(await gate.membersOnly(db, 'club@vesopa.test'), true);
    on = 0;
    assert.strictEqual(await gate.membersOnly(db, 'club@vesopa.test'), true, 'cached for a minute');
    gate.forget('club@vesopa.test');
    assert.strictEqual(await gate.membersOnly(db, 'club@vesopa.test'), false);
  });

  console.log(`\n${passed} checks passed`);
})();
