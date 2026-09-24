/**
 * Signing in with a code.
 *
 * WHY THIS IS A TEST AND NOT A GLANCE
 *
 * This is the front door to somebody's order history, and every part of it is
 * the kind of thing that looks right and is not:
 *
 *   * a phone number typed six different ways has to become one account, or
 *     the rate limit is walked around by adding a space;
 *   * a code comparison that returns early on the first wrong digit leaks the
 *     code one character at a time;
 *   * a six-digit code that comes from Math.random is not six digits of
 *     entropy;
 *   * and a leading zero dropped or kept wrongly texts a stranger.
 *
 * The pure functions are driven directly. The routes need a database and are
 * covered by dinein.test.js's harness.
 */
const assert = require('assert');
const crypto = require('crypto');

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

const {
  COUNTRIES, DEFAULT_COUNTRY, countryFromRequest,
  cleanEmail, cleanPhone, isUkMobile,
  newCode, hashCode, sameHash,
} = require('../src/dinein_otp');

console.log('\nDine-in sign-in codes\n');

// ---------------------------------------------------------------------------
// Countries
// ---------------------------------------------------------------------------

check('the United Kingdom is the default and is first in the list', () => {
  assert.strictEqual(DEFAULT_COUNTRY, 'GB');
  assert.strictEqual(COUNTRIES[0].code, 'GB');
});

check('every country has a code, a dial prefix and a flag', () => {
  for (const c of COUNTRIES) {
    assert.match(c.code, /^[A-Z]{2}$/, JSON.stringify(c));
    assert.match(c.dial, /^\d{1,4}$/, JSON.stringify(c));
    assert.ok(c.flag && c.flag.length >= 2, JSON.stringify(c));
    assert.ok(c.name, JSON.stringify(c));
  }
});

check('the country comes off the edge header when there is one', () => {
  assert.strictEqual(countryFromRequest({ headers: { 'cf-ipcountry': 'ie' } }), 'IE');
  assert.strictEqual(countryFromRequest({ headers: { 'x-geo-country': 'FR' } }), 'FR');
});

check('and falls back to the United Kingdom, never to nothing', () => {
  assert.strictEqual(countryFromRequest({ headers: {} }), 'GB');
  // A country we do not serve is not a country we can dial.
  assert.strictEqual(countryFromRequest({ headers: { 'cf-ipcountry': 'XX' } }), 'GB');
  assert.strictEqual(countryFromRequest({ headers: { 'cf-ipcountry': 'JP' } }), 'GB');
});

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

check('an email is lower-cased and trimmed', () => {
  assert.strictEqual(cleanEmail('  Rhys@Example.CO.UK '), 'rhys@example.co.uk');
});

check('and anything that is not one is refused', () => {
  for (const bad of ['', 'rhys', 'rhys@', '@example.com', 'a b@c.com',
    'rhys@example', null, undefined, 'rhys@@example.com']) {
    assert.strictEqual(cleanEmail(bad), null, JSON.stringify(bad));
  }
});

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

check('one UK mobile typed six ways is one number', () => {
  // If these did not agree, the rate limit could be walked around by adding a
  // space, and one person would end up with six accounts.
  const forms = [
    '07700 900123',
    '07700900123',
    '+44 7700 900123',
    '+447700900123',
    '447700900123',
    '00447700900123',
  ];
  const out = new Set(forms.map((f) => cleanPhone(f, 'GB')));
  assert.strictEqual(out.size, 1, [...out].join(' | '));
  assert.strictEqual([...out][0], '+447700900123');
});

check('the national leading zero is dropped, not carried into the country code', () => {
  // +44 0 7700... is the commonest way to text nobody at all.
  assert.strictEqual(cleanPhone('07700900123', 'GB'), '+447700900123');
  assert.ok(!cleanPhone('07700900123', 'GB').startsWith('+440'));
});

check('the chosen country is what a bare national number is read against', () => {
  assert.strictEqual(cleanPhone('087 1234567', 'IE'), '+353871234567');
  assert.strictEqual(cleanPhone('0612345678', 'FR'), '+33612345678');
});

check('an explicit + wins over the picker', () => {
  // Somebody who typed their own country code means it.
  assert.strictEqual(cleanPhone('+353871234567', 'GB'), '+353871234567');
});

check('nonsense is refused rather than dialled', () => {
  for (const bad of ['', '   ', 'phone me', '12', '0', '+', null, undefined,
    '0770090012345678901234']) {
    assert.strictEqual(cleanPhone(bad, 'GB'), null, JSON.stringify(bad));
  }
});

check('only a UK mobile is textable, because only that is what Postcoder sends', () => {
  assert.strictEqual(isUkMobile('+447700900123'), true);
  // A UK landline is not a mobile.
  assert.strictEqual(isUkMobile('+441554123456'), false);
  assert.strictEqual(isUkMobile('+353871234567'), false);
  assert.strictEqual(isUkMobile('+12025550123'), false);
  assert.strictEqual(isUkMobile(''), false);
  assert.strictEqual(isUkMobile(null), false);
});

// ---------------------------------------------------------------------------
// The code
// ---------------------------------------------------------------------------

check('a code is six digits, leading zeros kept', () => {
  for (let i = 0; i < 400; i += 1) {
    const code = newCode();
    assert.match(code, /^\d{6}$/, code);
  }
});

check('and it is not predictable', () => {
  // Not a proof of randomness — that is the generator's job — but it does catch
  // the two ways this goes wrong: a constant, and a counter.
  const seen = new Set();
  for (let i = 0; i < 2000; i += 1) seen.add(newCode());
  assert.ok(seen.size > 1800, `only ${seen.size} distinct codes in 2000`);
});

check('codes with leading zeros really are produced', () => {
  // A code built with Number() somewhere in the chain silently becomes five
  // digits about a tenth of the time, and then never matches.
  let zeros = 0;
  for (let i = 0; i < 3000; i += 1) if (newCode()[0] === '0') zeros += 1;
  assert.ok(zeros > 150, `only ${zeros} of 3000 started with a zero`);
});

check('the stored hash is not the code', () => {
  const salt = 'abcdef0123456789';
  const h = hashCode('123456', salt);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.ok(!h.includes('123456'));
});

check('the same code with a different salt hashes differently', () => {
  // Otherwise one rainbow table covers every challenge ever issued.
  assert.notStrictEqual(hashCode('123456', 'aaa'), hashCode('123456', 'bbb'));
});

check('the comparison is exact', () => {
  const salt = 'salt';
  const right = hashCode('123456', salt);
  assert.strictEqual(sameHash(hashCode('123456', salt), right), true);
  assert.strictEqual(sameHash(hashCode('123457', salt), right), false);
  assert.strictEqual(sameHash(hashCode('000000', salt), right), false);
});

check('a comparison against a different length is false, not a crash', () => {
  // timingSafeEqual throws on unequal lengths, which would turn a wrong code
  // into a 500 — and a 500 is itself an answer.
  assert.strictEqual(sameHash('short', hashCode('123456', 's')), false);
  assert.strictEqual(sameHash('', hashCode('123456', 's')), false);
  assert.strictEqual(sameHash(null, undefined), true);   // both empty
  assert.doesNotThrow(() => sameHash('a', 'bb'));
});

check('the comparison does not stop at the first wrong character', () => {
  // A === on strings can return on the first differing byte. This measures
  // whether a hash differing in byte 0 is distinguishable from one differing in
  // byte 63 by how long the check took. It is a coarse instrument, so it only
  // fails on a large, consistent difference — which is what an early return
  // looks like.
  const target = 'f'.repeat(64);
  const early = '0' + 'f'.repeat(63);
  const late = 'f'.repeat(63) + '0';
  const time = (a) => {
    const start = process.hrtime.bigint();
    for (let i = 0; i < 20000; i += 1) sameHash(a, target);
    return Number(process.hrtime.bigint() - start);
  };
  // Warm up, then measure both twice and take the smaller of each.
  time(early); time(late);
  const e = Math.min(time(early), time(early));
  const l = Math.min(time(late), time(late));
  const ratio = Math.max(e, l) / Math.max(1, Math.min(e, l));
  assert.ok(ratio < 3, `first-byte and last-byte differences timed ${ratio.toFixed(2)}x apart`);
});

check('a hash is what a hash is, whoever computes it', () => {
  // Pinned so that changing the scheme has to be a decision rather than an
  // accident: every code in flight stops working the moment this changes.
  const expected = crypto.createHash('sha256').update('pepper:654321').digest('hex');
  assert.strictEqual(hashCode('654321', 'pepper'), expected);
});

console.log(`\n${passed} checks passed\n`);
