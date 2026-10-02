/**
 * Loyalty schemes and the membership number.
 *
 * "If the card number is 999800001, the customer's membership number should
 * be shown as 00001, not 999800001." And: different schemes, each with its own
 * discount, points and card prefix. These are the rules every route shares, in
 * src/loyalty_schemes.js.
 */

const assert = require('assert');
const S = require('../src/loyalty_schemes');

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

const scheme = (over = {}) => S.normaliseScheme({
  id: 1, name: 'VIP', reward_type: 'percent', discount_value: 10,
  card_prefix: '9997', active: 1, ...over,
});

(async () => {
  console.log('\nLoyalty schemes\n');

  await check('the membership number is the card without its prefix', () => {
    const prefixes = S.memberPrefixes({ loyalty_prefix: '9998', membership_prefix: '' }, []);
    assert.strictEqual(S.memberNumber({ card_number: '999800001' }, prefixes, 5), '00001');
  });

  await check('a scheme prefix is stripped too, and the longest prefix wins', () => {
    const prefixes = S.memberPrefixes(
      { loyalty_prefix: '9998' },
      [scheme({ card_prefix: '99981' })]
    );
    assert.deepStrictEqual(prefixes, ['99981', '9998']);
    assert.strictEqual(S.memberNumber({ card_number: '9998100042' }, prefixes), '00042');
  });

  await check('no card falls back to the allocated number, padded like a card', () => {
    assert.strictEqual(S.memberNumber({ member_no: 7 }, ['9998'], 5), '00007');
    assert.strictEqual(S.memberNumber({}, ['9998'], 5), null);
  });

  await check('a card on an unknown prefix shows the allocated number', () => {
    assert.strictEqual(S.memberNumber({ card_number: '12345678', member_no: 3 }, ['9998'], 5), '00003');
  });

  await check('member_no from a card is the digits after the prefix', () => {
    assert.strictEqual(S.memberNoFromCard('999800001', ['9998']), 1);
    assert.strictEqual(S.memberNoFromCard('999800000', ['9998']), null);
    assert.strictEqual(S.memberNoFromCard('12340001', ['9998']), null);
  });

  await check('a card joins the scheme its prefix names', () => {
    const list = [scheme(), scheme({ id: 2, name: 'Member', card_prefix: '9998' })];
    assert.strictEqual(S.schemeForCard(list, '999700012').name, 'VIP');
    assert.strictEqual(S.schemeForCard(list, '999800012').name, 'Member');
    assert.strictEqual(S.schemeForCard(list, '987800012'), null);
  });

  await check('an inactive scheme does not claim cards', () => {
    assert.strictEqual(S.schemeForCard([scheme({ active: 0 })], '999700012'), null);
  });

  await check('a new customer: asked, then card, then default', () => {
    const list = [
      scheme(),
      scheme({ id: 2, name: 'Member', card_prefix: '9998', is_default: 1 }),
      scheme({ id: 3, name: 'Committee', card_prefix: '', reward_type: 'none' }),
    ];
    assert.strictEqual(S.pickSchemeForNewCustomer(list, { schemeId: 3 }).name, 'Committee');
    assert.strictEqual(S.pickSchemeForNewCustomer(list, { cardNumber: '999700001' }).name, 'VIP');
    assert.strictEqual(S.pickSchemeForNewCustomer(list, {}).name, 'Member');
    assert.strictEqual(S.pickSchemeForNewCustomer([scheme()], {}), null);
  });

  await check('a scheme overrides only what it sets', () => {
    const venue = { points_per_pound: 1, point_value_minor: 1, min_spend_minor: 0, min_redeem_points: 100 };
    const merged = S.applyScheme(venue, scheme({ earn_points: 1, points_per_pound: 2 }));
    assert.strictEqual(merged.points_per_pound, 2);
    assert.strictEqual(merged.point_value_minor, 1);
    assert.strictEqual(merged.min_redeem_points, 100);
    assert.strictEqual(merged.earn_points, 1);
    assert.strictEqual(S.applyScheme(venue, null).points_per_pound, 1);
  });

  await check('the discount window follows days and times, across midnight too', () => {
    // Friday 2 October 2026, 19:30.
    const fri = new Date(2026, 9, 2, 19, 30);
    assert.strictEqual(S.discountActiveAt(scheme(), fri), true);
    assert.strictEqual(S.discountActiveAt(scheme({ days_of_week: '1111011' }), fri), false);
    assert.strictEqual(S.discountActiveAt(scheme({ start_time: '17:00', end_time: '19:00' }), fri), false);
    assert.strictEqual(S.discountActiveAt(scheme({ start_time: '18:00', end_time: '02:00' }), fri), true);
    assert.strictEqual(
      S.discountActiveAt(scheme({ start_time: '18:00', end_time: '02:00' }), new Date(2026, 9, 2, 1, 0)),
      true
    );
    assert.strictEqual(S.discountActiveAt(scheme({ reward_type: 'none' }), fri), false);
  });

  await check('input is checked: no negative or over-100 discounts, real price levels', () => {
    assert.ok(S.cleanSchemeInput({ name: '', reward_type: 'none' }).errors.length);
    assert.ok(S.cleanSchemeInput({ name: 'X', reward_type: 'percent', discount_value: 120 }).errors.length);
    assert.ok(S.cleanSchemeInput({ name: 'X', reward_type: 'amount', discount_value: -5 }).errors.length);
    assert.ok(S.cleanSchemeInput({ name: 'X', reward_type: 'price_level', price_level: 9 }).errors.length);
    const ok = S.cleanSchemeInput({
      name: ' Players VIP ', reward_type: 'price_level', price_level: 2,
      discount_departments: ['Beers', 'Wines'], card_prefix: '99-96', days_of_week: '1111100',
    });
    assert.deepStrictEqual(ok.errors, []);
    assert.strictEqual(ok.values.name, 'Players VIP');
    assert.strictEqual(ok.values.card_prefix, '9996');
    assert.strictEqual(ok.values.discount_value, 0);
    assert.strictEqual(ok.values.discount_departments, '["Beers","Wines"]');
  });

  await check('a stored row reads back with its lists and defaults', () => {
    const s = S.normaliseScheme({ id: '4', name: 'Daffs', discount_departments: '["Food"]', days_of_week: 'bad' });
    assert.deepStrictEqual(s.discount_departments, ['Food']);
    assert.strictEqual(s.days_of_week, '1111111');
    assert.strictEqual(s.reward_type, 'none');
    assert.strictEqual(s.offer_at_till, 1);
  });

  await check('a scheme reads as a sentence', () => {
    assert.strictEqual(
      S.describeScheme(scheme({ earn_points: 1, points_per_pound: 2, discount_departments: ['Drinks'] })),
      '10% off Drinks, 2 points per £1'
    );
    assert.strictEqual(S.describeScheme(scheme({ reward_type: 'none' })), 'No rewards');
  });

  await check('no schemes table yet reads as no schemes', async () => {
    const pool = { query: async () => { const e = new Error('no table'); e.code = 'ER_NO_SUCH_TABLE'; throw e; } };
    assert.deepStrictEqual(await S.listSchemes(pool, 'a@b.c'), []);
  });

  console.log(`\n${passed} passed\n`);
})();
