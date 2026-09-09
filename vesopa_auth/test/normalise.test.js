/**
 * Normalisation decides whether two strings are the same person. Both possible
 * mistakes are damaging in opposite directions, so both are tested here:
 *
 *   too eager  — two different people share an account
 *   too shy    — one person cannot get back into their own account
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  normaliseEmail,
  normalisePhone,
  normaliseIdentifier,
  isPrivateRelay,
  guessIdentifierType,
} = require('../src/normalise');

test('email case and surrounding space never make a second account', () => {
  assert.strictEqual(normaliseEmail('  Sam@Example.COM '), 'sam@example.com');
  assert.strictEqual(normaliseEmail('SAM@EXAMPLE.COM'), 'sam@example.com');
});

test('gmail dots and plus tags are one mailbox, because Google says so', () => {
  assert.strictEqual(normaliseEmail('s.a.m@gmail.com'), 'sam@gmail.com');
  assert.strictEqual(normaliseEmail('sam+shopping@gmail.com'), 'sam@gmail.com');
  assert.strictEqual(normaliseEmail('S.A.M+x@googlemail.com'), 'sam@gmail.com');
});

test('dots are NOT stripped anywhere else — that would fuse two colleagues', () => {
  assert.strictEqual(normaliseEmail('j.smith@company.com'), 'j.smith@company.com');
  assert.notStrictEqual(normaliseEmail('j.smith@company.com'), normaliseEmail('jsmith@company.com'));
});

test('plus tags survive at other providers, because they are the user’s filing system', () => {
  assert.strictEqual(normaliseEmail('sam+bills@outlook.com'), 'sam+bills@outlook.com');
});

test('malformed addresses are refused rather than half-accepted', () => {
  for (const bad of ['', '   ', 'no-at-sign', '@example.com', 'sam@', 'sam@nodot', 'sam@a..b', 'a b@c.com', null, undefined]) {
    assert.strictEqual(normaliseEmail(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
});

test('Apple private relay addresses are recognised', () => {
  assert.ok(isPrivateRelay('abc123@privaterelay.appleid.com'));
  assert.ok(isPrivateRelay('ABC@PrivateRelay.AppleId.Com'));
  assert.ok(!isPrivateRelay('sam@icloud.com'));
  assert.ok(!isPrivateRelay(''));
});

test('phones normalise to E.164 however they were typed', () => {
  // A real UK mobile format. Deliberately NOT 07700 900xxx: that is Ofcom's
  // reserved drama range, libphonenumber knows it is not a real number, and a
  // test built on one proves the opposite of what it looks like it proves.
  const expected = '+447911123456';
  for (const written of ['07911 123456', '+44 7911 123456', '(07911) 123456', '447911123456']) {
    assert.strictEqual(normalisePhone(written, 'GB'), expected, `failed on ${written}`);
  }
});

test('numbers reserved for television drama are refused', () => {
  // Ofcom keeps 07700 900xxx aside so that a number said aloud on the radio
  // never rings a real person. Somebody typing one into a live sign-in form has
  // made a mistake, and an SMS to it will be silently swallowed.
  assert.strictEqual(normalisePhone('07700 900123', 'GB'), null);
});

test('a non-UK number is stored, not rejected — the SMS gateway decides that', () => {
  assert.strictEqual(normalisePhone('+33 6 12 34 56 78'), '+33612345678');
});

test('rubbish phone numbers are refused', () => {
  for (const bad of ['', 'abc', '123', '+', null]) {
    assert.strictEqual(normalisePhone(bad, 'GB'), null, `should reject ${JSON.stringify(bad)}`);
  }
});

test('provider subjects are left exactly alone, including their case', () => {
  assert.strictEqual(normaliseIdentifier('github', 'MDQ6VXNlcjE='), 'MDQ6VXNlcjE=');
  assert.notStrictEqual(
    normaliseIdentifier('github', 'AbC'),
    normaliseIdentifier('github', 'abc'),
    'subject ids are case-sensitive and must not be folded',
  );
});

test('the toggle is guessed correctly when somebody types the wrong sort of thing', () => {
  assert.strictEqual(guessIdentifierType('sam@example.com'), 'email');
  assert.strictEqual(guessIdentifierType('07700 900123'), 'phone');
  assert.strictEqual(guessIdentifierType('+44 7700 900123'), 'phone');
  assert.strictEqual(guessIdentifierType('sam'), null);
  assert.strictEqual(guessIdentifierType(''), null);
});
