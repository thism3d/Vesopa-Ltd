/**
 * Offers, promotions and branding.
 *
 * TWO REASONS THIS IS A TEST AND NOT A GLANCE
 *
 * `cleanTheme` decides what gets interpolated into a <style> block on a public
 * page. Anything that reaches it and is not a colour is a way of writing CSS
 * into somebody else's menu — and the venue that types it is not necessarily
 * the venue whose customers read it.
 *
 * `discountFor` decides what somebody pays. The page quotes a figure and the
 * order stores one, and those two disagreeing is a customer being charged
 * something they were never shown. Both are pure functions, so they are driven
 * directly rather than through a route.
 */
const assert = require('assert');

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${e.message}`);
    process.exitCode = 1;
  }
}

const { cleanTheme, cleanPromotions, offerOf, discountFor } = require('../src/dinein');

console.log('\nDine-in offers, promotions and branding\n');

// ---------------------------------------------------------------------------
// The palette
// ---------------------------------------------------------------------------

check('a venue that has set nothing gets the Vesopa palette', () => {
  const t = cleanTheme(null);
  assert.strictEqual(t.accent, '#A5C715');
  assert.strictEqual(t.font, 'system');
  assert.strictEqual(typeof t.radius, 'number');
});

check('a venue that has set colours gets its own', () => {
  const t = cleanTheme({ accent: '#123abc', page: '#FFF8E7', ink: '#101010' });
  assert.strictEqual(t.accent, '#123ABC');
  assert.strictEqual(t.page, '#FFF8E7');
  assert.strictEqual(t.ink, '#101010');
  // Anything not given keeps the default rather than becoming undefined.
  assert.strictEqual(t.onAccent, '#10130A');
});

check('it reads a stored JSON string as well as an object', () => {
  const t = cleanTheme('{"accent":"#ABCDEF"}');
  assert.strictEqual(t.accent, '#ABCDEF');
});

check('anything that is not a colour is refused', () => {
  // Every one of these is an attempt to leave the declaration it is written in.
  const nasty = [
    'red',                       // a keyword is not six hex digits
    '#fff',                      // three is not six
    '#12345g',
    'red;} body{display:none}',
    '#fff;} .add{background:url(https://example.invalid/x)}',
    'url(javascript:alert(1))',
    'var(--anything)',
    '#A5C715 !important',
    '',
    null,
    12345,
  ];
  for (const value of nasty) {
    const t = cleanTheme({ accent: value });
    assert.strictEqual(
      t.accent, '#A5C715',
      'accepted ' + JSON.stringify(String(value)) + ' as ' + t.accent
    );
  }
});

check('a value that stringifies to a colour is allowed to be one', () => {
  // Not a hole. The check is on the string, and the string is a valid colour,
  // so the output is a valid colour — which is the property that matters. It
  // also cannot arrive from either real source: the column is read with
  // JSON.parse and the request body is parsed the same way, and neither can
  // produce an object carrying its own toString.
  const t = cleanTheme({ accent: { toString: () => '#000000' } });
  assert.strictEqual(t.accent, '#000000');
  assert.match(t.accent, /^#[0-9A-F]{6}$/);
});

check('every colour it returns is a plain six-digit hex', () => {
  const t = cleanTheme({
    accent: 'red', onAccent: 'blue', page: '}', card: 'x', ink: '#00ff00', inkSoft: null,
  });
  for (const key of ['accent', 'onAccent', 'page', 'card', 'ink', 'inkSoft']) {
    assert.match(t[key], /^#[0-9A-F]{6}$/, key + ' was ' + t[key]);
  }
});

check('corrupt JSON gives the defaults rather than throwing', () => {
  for (const bad of ['{oh dear', '[1,2,3', 'undefined', '   ']) {
    const t = cleanTheme(bad);
    assert.strictEqual(t.accent, '#A5C715', String(bad));
  }
});

check('the radius is clamped and the font is one of ours', () => {
  assert.strictEqual(cleanTheme({ radius: 9999 }).radius, 28);
  assert.strictEqual(cleanTheme({ radius: -40 }).radius, 0);
  assert.strictEqual(cleanTheme({ radius: 'big' }).radius, 16);
  assert.strictEqual(cleanTheme({ font: 'serif' }).font, 'serif');
  assert.strictEqual(cleanTheme({ font: 'Comic Sans' }).font, 'system');
});

// ---------------------------------------------------------------------------
// Promotions
// ---------------------------------------------------------------------------

check('a promotion with no title is dropped', () => {
  const out = cleanPromotions([
    { title: 'Quiz night', body: 'Thursdays, 8pm' },
    { body: 'no title here' },
    { title: '   ' },
  ]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].title, 'Quiz night');
});

check('at most six, however many are sent', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ title: 'P' + i }));
  assert.strictEqual(cleanPromotions(many).length, 6);
});

check('a date that is not a date is dropped rather than shown', () => {
  assert.strictEqual(cleanPromotions([{ title: 'x', until: 'soon' }])[0].until, null);
  assert.strictEqual(cleanPromotions([{ title: 'x', until: '2026-12-24' }])[0].until, '2026-12-24');
});

check('anything that is not a list gives an empty list', () => {
  for (const bad of [null, undefined, '{}', 'nope', 42, { title: 'x' }]) {
    assert.deepStrictEqual(cleanPromotions(bad), [], String(bad));
  }
});

// ---------------------------------------------------------------------------
// The offer
// ---------------------------------------------------------------------------

const venue = (over) => Object.assign(
  { offer_active: 1, offer_percent: 15, offer_min_spend_minor: 5000, offer_label: null },
  over || {}
);

check('an offer that is switched off is no offer', () => {
  assert.strictEqual(offerOf(venue({ offer_active: 0 })), null);
});

check('an offer of nothing is no offer', () => {
  assert.strictEqual(offerOf(venue({ offer_percent: 0 })), null);
});

check('a percentage is capped at ninety', () => {
  // Past this a discount stops being a discount and becomes a typing mistake.
  assert.strictEqual(offerOf(venue({ offer_percent: 300 })).percent, 90);
  assert.strictEqual(offerOf(venue({ offer_percent: -20 })), null);
});

check('nothing comes off a basket under the minimum', () => {
  const o = offerOf(venue());
  assert.strictEqual(discountFor(o, 4999), 0);
});

check('the discount lands exactly on the minimum', () => {
  const o = offerOf(venue());
  assert.strictEqual(discountFor(o, 5000), 750);
});

check('and scales above it', () => {
  const o = offerOf(venue());
  assert.strictEqual(discountFor(o, 10000), 1500);
});

check('a discount is never a fraction of a penny', () => {
  const o = offerOf(venue({ offer_percent: 15, offer_min_spend_minor: 0 }));
  // 15% of 333 is 49.95. Rounding up would take a penny nobody agreed to.
  assert.strictEqual(discountFor(o, 333), 49);
  assert.ok(Number.isInteger(discountFor(o, 333)));
});

check('no offer takes nothing off', () => {
  assert.strictEqual(discountFor(null, 100000), 0);
});

check('a discount never exceeds the basket', () => {
  const o = offerOf(venue({ offer_percent: 90, offer_min_spend_minor: 0 }));
  for (const basket of [1, 99, 100, 12345]) {
    const off = discountFor(o, basket);
    assert.ok(off >= 0 && off <= basket, `${off} off a basket of ${basket}`);
  }
});

check("a venue's own wording is kept, and blank means we write it", () => {
  assert.strictEqual(offerOf(venue({ offer_label: '  Happy hour  ' })).label, 'Happy hour');
  assert.strictEqual(offerOf(venue({ offer_label: '   ' })).label, null);
  assert.strictEqual(offerOf(venue()).label, null);
});

console.log(`\n${passed} checks passed\n`);
