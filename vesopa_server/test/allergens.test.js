/**
 * The fourteen allergens.
 *
 * The shape of this module carries a legal obligation, so the tests are about
 * the distinctions rather than the plumbing: an unanswered question must never
 * read as "contains nothing", and a client that has never heard of allergens
 * must never be able to erase what a venue has declared.
 */

const assert = require('assert');
const {
  ALLERGENS,
  cleanAllergens,
  readAllergens,
  labelsFor,
  effectiveAllergens,
} = require('../src/allergens');

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.log(`FAIL  ${name}\n      ${e.message}`);
    process.exitCode = 1;
  }
}

console.log('\nAllergens\n');

check('the list is the statutory fourteen', () => {
  assert.strictEqual(ALLERGENS.length, 14);
});

check('every code is unique and every one has a label', () => {
  const codes = new Set(ALLERGENS.map((a) => a.code));
  assert.strictEqual(codes.size, 14, 'a code is duplicated');
  for (const a of ALLERGENS) {
    assert.ok(a.label && a.label.trim().length > 1, `${a.code} has no label`);
  }
});

check('the list cannot be edited by whatever reads it', () => {
  // Four surfaces share this object. One of them pushing onto it would change
  // what the others show, and the failure would look like a rendering bug.
  assert.throws(() => ALLERGENS.push({ code: 'x', label: 'X' }));
});

check('nobody having said is null, not an empty list', () => {
  // The distinction the whole design rests on.
  assert.strictEqual(cleanAllergens(null), null);
  assert.strictEqual(cleanAllergens(undefined), null);
  assert.strictEqual(cleanAllergens(''), null);
});

check('"none of the fourteen" is a real, storable answer', () => {
  assert.strictEqual(cleanAllergens([]), '[]');
  assert.deepStrictEqual(readAllergens('[]'), []);
});

check('codes are stored in the statutory order, not the order ticked', () => {
  // So two products with the same allergens compare equal as strings.
  assert.strictEqual(cleanAllergens(['milk', 'celery']), '["celery","milk"]');
  assert.strictEqual(cleanAllergens(['celery', 'milk']), '["celery","milk"]');
});

check('a duplicate tick is stored once', () => {
  assert.strictEqual(cleanAllergens(['eggs', 'eggs']), '["eggs"]');
});

check('a code nothing has heard of is dropped, not refused', () => {
  // A back office one release ahead of a till must not make the till unable to
  // save a product.
  assert.strictEqual(cleanAllergens(['milk', 'moon_dust']), '["milk"]');
});

check('a comma-separated string is accepted rather than lost', () => {
  assert.strictEqual(cleanAllergens('eggs, fish'), '["eggs","fish"]');
});

check('a column with a bad byte in it reads as unanswered', () => {
  // A product row that cannot be parsed must not take down the menu listing it.
  assert.deepStrictEqual(readAllergens('not json'), []);
  assert.deepStrictEqual(readAllergens('{"not":"a list"}'), []);
});

check('labels come from the one list', () => {
  assert.deepStrictEqual(labelsFor('["milk","tree_nuts"]'), [
    'Milk',
    'Tree nuts',
  ]);
});

check('a menu item with no answer inherits the product', () => {
  assert.deepStrictEqual(
    effectiveAllergens(null, '["peanuts"]'),
    ['peanuts']
  );
});

check('a menu item saying "none" overrides a product that says otherwise', () => {
  // The override that matters: a venue whose menu entry genuinely differs.
  assert.deepStrictEqual(effectiveAllergens('[]', '["peanuts"]'), []);
});

check('a menu item with its own list wins', () => {
  assert.deepStrictEqual(
    effectiveAllergens('["fish"]', '["peanuts"]'),
    ['fish']
  );
});

console.log(`\n${passed} checks passed\n`);
