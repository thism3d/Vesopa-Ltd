/**
 * The product page's own logic, lifted out of public/app.js.
 *
 * Two things are pinned here, and both were bugs rather than theory.
 *
 * `ticked` is the one that matters. The checkbox field submits a hidden input
 * carrying the *string* "0" when it is clear, and "0" is truthy — so every
 * `!!data.whatever` in the back office read as ticked whatever the manager did.
 * The harmless end of that was "creating a new page still copies the page". The
 * dangerous end was "Replace the existing catalogue first", which wiped a
 * venue's catalogue whether or not anybody asked it to.
 *
 * `cellSelect` is the inline department picker. Its job is to offer what the
 * venue has set up *without* silently re-filing a product whose department has
 * since been renamed — a row that quietly changes meaning the moment somebody
 * clicks into it is worse than one that will not save.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'app.js'),
  'utf8'
);

/** Lift a named function declaration, as the cropper suite does. */
function liftFunction(name) {
  const from = source.indexOf(`function ${name}(`);
  assert.ok(from > 0, `${name} not found in public/app.js`);
  const rest = source.slice(from);
  const end = rest.indexOf('\n}\n');
  assert.ok(end > 0, `could not find the end of ${name}`);
  return rest.slice(0, end + 3);
}

/** Lift a single-expression arrow const. */
function liftConst(name) {
  const match = source.match(
    new RegExp(`^const ${name} = [^;]+;`, 'm')
  );
  assert.ok(match, `${name} not found in public/app.js`);
  return match[0];
}

const NEWLINE = String.fromCharCode(10);

const context = { Number, String, Set, Math };
vm.createContext(context);

// One script, and an explicit hand-off at the end. `const` inside a vm script
// is a lexical binding, not a property of the context — run separately, each
// piece would be invisible both to the test and to the others.
//
// esc() is a dependency of cellSelect; this is the real one's behaviour.
vm.runInContext(
  [
    "const esc = (s) => String(s ?? '').replace(/[&<>\"']/g, (c) => " +
      "({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[c]));",
    liftConst('ticked'),
    liftFunction('cellSelect'),
    'globalThis.ticked = ticked; globalThis.cellSelect = cellSelect;',
  ].join(NEWLINE),
  context
);

let passed = 0;
function test(name, fn) {
  fn();
  console.log('  ok  ', name);
  passed++;
}

console.log('\nback office: products');

test('a cleared checkbox is not ticked', () => {
  // The whole bug: this arrives as the string "0", not the number 0.
  assert.strictEqual(context.ticked('0'), false);
  assert.strictEqual(context.ticked(0), false);
  assert.strictEqual(context.ticked(''), false);
  assert.strictEqual(context.ticked(undefined), false);
  assert.strictEqual(context.ticked(null), false);
});

test('a ticked checkbox is ticked', () => {
  assert.strictEqual(context.ticked('1'), true);
  assert.strictEqual(context.ticked(1), true);
});

test('the current department is the selected option', () => {
  const html = context.cellSelect('department_name', ['Food', 'Drink'], 'Drink');
  assert.match(html, /<option value="Drink" selected>Drink<\/option>/);
  assert.match(html, /data-cell="department_name"/);
});

test('a department that no longer exists is kept, not silently swapped', () => {
  // A product filed under a department since renamed. Dropping it here would
  // re-file the product under whatever happened to be first the moment anyone
  // clicked the cell.
  const html = context.cellSelect('department_name', ['Food'], 'Cellar');
  assert.match(html, /<option value="Cellar" selected>Cellar<\/option>/);
  assert.match(html, /<option value="Food">Food<\/option>/);
});

test('a product with no department offers a blank, chosen', () => {
  const html = context.cellSelect('group_name', ['Snacks'], null);
  assert.match(html, /<option value="">—<\/option>/);
  assert.ok(!/selected/.test(html), 'nothing should be pre-selected');
});

test('duplicate and empty names are dropped from the list', () => {
  const html = context.cellSelect('group_name', ['Snacks', 'Snacks', '', null], '');
  assert.strictEqual((html.match(/<option/g) || []).length, 2);
});

test('a name with a quote in it cannot break out of the attribute', () => {
  const html = context.cellSelect('department_name', ['Bob\'s "Bar"'], null);
  assert.ok(!html.includes('value="Bob\'s "Bar""'), 'must be escaped');
  assert.match(html, /&quot;/);
});

console.log(`\nback office products: ${passed}/${passed} passed\n`);
