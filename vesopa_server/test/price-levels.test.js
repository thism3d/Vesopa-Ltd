/**
 * What a bulk price change actually works out to.
 *
 * The arithmetic is the part nobody can check by looking at the page: a
 * manager sees "7.5% up, nearest 5p" and a list of prices, and has to take on
 * trust that the two agree. These pin it.
 *
 * The rounding cases are the ones worth having. A percentage almost never
 * lands on a price anybody would charge — 7.5% on £3.20 is £3.44 — so a venue
 * picks the shape it prices in, and getting `.99` wrong in the obvious way
 * (always round up) turns £3.44 into £3.99, a 25% rise nobody asked for.
 */

const assert = require('assert');

const { round, repriced } = require('../src/price_levels');

let passed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
    passed += 1;
  } catch (e) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${e.message}`);
    process.exitCode = 1;
  }
}

console.log('\nRounding a price to the shape a venue charges in\n');

check('the exact penny leaves it alone', () => {
  assert.strictEqual(round(344, 'none'), 344);
  assert.strictEqual(round(1, 'none'), 1);
});

check('nearest 5p goes both ways', () => {
  assert.strictEqual(round(344, '5p'), 345);
  assert.strictEqual(round(341, '5p'), 340);
  assert.strictEqual(round(342.5, '5p'), 345);
});

check('nearest 10p goes both ways', () => {
  assert.strictEqual(round(344, '10p'), 340);
  assert.strictEqual(round(346, '10p'), 350);
});

check('a whole pound', () => {
  assert.strictEqual(round(344, 'pound'), 300);
  assert.strictEqual(round(351, 'pound'), 400);
});

check('a .99 ending picks the NEARER one, not always the one above', () => {
  // £3.44 is nearer £2.99 than £3.99. Always rounding up would put 25% on a
  // price the manager asked to move by seven and a half per cent.
  assert.strictEqual(round(344, '99'), 299);
  assert.strictEqual(round(360, '99'), 399);
  assert.strictEqual(round(399, '99'), 399);
});

check('a .95 ending, the same way', () => {
  assert.strictEqual(round(340, '95'), 295);
  assert.strictEqual(round(360, '95'), 395);
});

check('an ending never inflates a price under a pound into that ending', () => {
  // 40p with a .99 ending is 99p, not £1.99 — going up two and a half times
  // is not rounding. It is still a jump, which is why the page shows it.
  assert.strictEqual(round(40, '99'), 99);
  assert.strictEqual(round(10, '95'), 95);
});

check('nothing rounds below zero', () => {
  assert.strictEqual(round(-500, 'none'), 0);
  assert.strictEqual(round(-500, '5p'), 0);
});

console.log('\nWorking out the new price\n');

const at = (o) => repriced({ rounding: 'none', ...o });

check('a percentage up', () => {
  assert.strictEqual(
    at({ basePence: 320, method: 'percent', direction: 'up', amount: 7.5 }),
    344,
  );
});

check('a percentage down', () => {
  assert.strictEqual(
    at({ basePence: 300, method: 'percent', direction: 'down', amount: 10 }),
    270,
  );
});

check('a fixed amount up and down, in pence', () => {
  assert.strictEqual(
    at({ basePence: 300, method: 'amount', direction: 'up', amount: 50 }),
    350,
  );
  assert.strictEqual(
    at({ basePence: 300, method: 'amount', direction: 'down', amount: 50 }),
    250,
  );
});

check('copy takes the base price exactly', () => {
  assert.strictEqual(
    at({ basePence: 337, method: 'copy', direction: 'up', amount: 999 }),
    337,
  );
});

check('a reduction can never make a price negative', () => {
  // Money that goes below zero comes back as change owed. Clamped, and the
  // page shows the result so it is not a silent £0.00.
  assert.strictEqual(
    at({ basePence: 300, method: 'amount', direction: 'down', amount: 900 }),
    0,
  );
  assert.strictEqual(
    at({ basePence: 300, method: 'percent', direction: 'down', amount: 100 }),
    0,
  );
});

check('the rounding is applied to the RESULT, not the base', () => {
  // 10% on £3.20 is £3.52; to the nearest 5p that is £3.50. Rounding the base
  // first would give £3.20 → £3.20 → £3.52 → and a different answer whenever
  // the base is not already round.
  assert.strictEqual(
    repriced({
      basePence: 320,
      method: 'percent',
      direction: 'up',
      amount: 10,
      rounding: '5p',
    }),
    350,
  );
});

check('the venue’s own example: 10% off £9.00 to the nearest 5p', () => {
  assert.strictEqual(
    repriced({
      basePence: 900,
      method: 'percent',
      direction: 'down',
      amount: 10,
      rounding: '5p',
    }),
    810,
  );
});

console.log(`\n${passed} checks passed\n`);
