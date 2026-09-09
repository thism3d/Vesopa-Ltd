/**
 * The TOTP implementation is checked against RFC 6238's own published vectors.
 *
 * This is the whole reason it was worth writing rather than installing: a
 * hand-rolled authenticator that has not been run against the RFC's table is a
 * guess, and the way it fails is that codes work on the developer's phone and
 * not on somebody else's, which nobody can reproduce.
 *
 *   node --test test/
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  totpCode,
  verifyTotp,
  base32Encode,
  base32Decode,
  newNumericCode,
  hashCode,
  safeEqual,
  encrypt,
  decrypt,
  pairwiseSubject,
} = require('../src/crypto');

// The RFC's seed is the ASCII string "12345678901234567890".
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'));

test('TOTP matches RFC 6238 test vectors', () => {
  const vectors = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ];

  for (const [unixTime, expected] of vectors) {
    const step = Math.floor(unixTime / 30);
    assert.strictEqual(
      totpCode(RFC_SECRET, step, 8),
      expected,
      `T=${unixTime} should give ${expected}`,
    );
  }
});

test('base32 round-trips arbitrary bytes', () => {
  for (const length of [1, 5, 10, 16, 20, 32]) {
    const bytes = Buffer.alloc(length, 0xab);
    assert.deepStrictEqual(base32Decode(base32Encode(bytes)), bytes);
  }
});

test('a spent TOTP step cannot be replayed', () => {
  const now = Math.floor(Date.now() / 1000 / 30);
  const code = totpCode(RFC_SECRET, now, 6);

  const first = verifyTotp(RFC_SECRET, code, { window: 1 });
  assert.strictEqual(first, now, 'the current code should verify');

  const replay = verifyTotp(RFC_SECRET, code, { window: 1, after: first });
  assert.strictEqual(replay, null, 'the same code must not verify twice');
});

test('TOTP rejects the wrong length and non-digits', () => {
  assert.strictEqual(verifyTotp(RFC_SECRET, '12345'), null);
  assert.strictEqual(verifyTotp(RFC_SECRET, 'abcdef'), null);
  assert.strictEqual(verifyTotp(RFC_SECRET, ''), null);
  assert.strictEqual(verifyTotp(RFC_SECRET, null), null);
});

test('numeric codes are the right length and use the whole range', () => {
  const seen = new Set();
  for (let i = 0; i < 2000; i += 1) {
    const code = newNumericCode(6);
    assert.match(code, /^\d{6}$/);
    seen.add(code);
  }
  // A biased or broken generator collapses the space; 2000 draws from a million
  // should almost never repeat.
  assert.ok(seen.size > 1990, `expected near-unique codes, got ${seen.size}`);
});

test('code hashing needs a pepper and is stable', () => {
  assert.throws(() => hashCode('123456', ''), /pepper/);
  const a = hashCode('123456', 'pepper-one');
  const b = hashCode('123456', 'pepper-one');
  const c = hashCode('123456', 'pepper-two');
  assert.strictEqual(a, b);
  assert.notStrictEqual(a, c, 'a different pepper must give a different digest');
});

test('safeEqual compares by value and survives odd input', () => {
  assert.ok(safeEqual('abc', 'abc'));
  assert.ok(!safeEqual('abc', 'abd'));
  assert.ok(!safeEqual('abc', 'abcd'));
  assert.ok(!safeEqual(null, 'abc'));
  assert.ok(safeEqual('', ''));
});

test('AES-GCM round-trips and refuses tampering', () => {
  const key = 'a'.repeat(64);
  const cipher = encrypt('a totp seed', key);
  assert.strictEqual(decrypt(cipher, key), 'a totp seed');

  // Flip one byte of the body: GCM must refuse rather than return rubbish.
  const tampered = Buffer.from(cipher);
  tampered[tampered.length - 1] ^= 0xff;
  assert.throws(() => decrypt(tampered, key));

  // The wrong key must not decrypt.
  assert.throws(() => decrypt(cipher, 'b'.repeat(64)));

  // A key of the wrong size is a configuration error, and must say so.
  assert.throws(() => encrypt('x', 'tooshort'), /64 hex/);
});

test('pairwise subjects differ per application and are stable', () => {
  const one = pairwiseSubject('USER1', 'saltA', 'pepper');
  const two = pairwiseSubject('USER1', 'saltB', 'pepper');
  assert.notStrictEqual(one, two, 'two applications must see different subjects');
  assert.strictEqual(one, pairwiseSubject('USER1', 'saltA', 'pepper'), 'and a stable one');
  assert.notStrictEqual(one, pairwiseSubject('USER2', 'saltA', 'pepper'));
});
