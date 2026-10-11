const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256' };
global.fetch = async () => ({ ok: true, json: async () => ({ keys: [jwk] }) });

process.env.LOYALTY_APPLE_AUDIENCES = 'com.vesopaepos.pontardawerfc';
const social = require('../src/loyalty_social');

const sign = (claims) => jwt.sign(claims, privateKey, { algorithm: 'RS256', keyid: 'k1', expiresIn: 600 });

test('an Apple token for this app is accepted, with its confirmed email', async () => {
  const claims = await social.verify('apple', sign({
    iss: 'https://appleid.apple.com', aud: 'com.vesopaepos.pontardawerfc', sub: '1', email: 'A@B.com', email_verified: 'true',
  }));
  assert.ok(claims);
  assert.strictEqual(social.verifiedEmail(claims), 'a@b.com');
});

test("a token minted for somebody else's app is refused", async () => {
  assert.strictEqual(await social.verify('apple', sign({
    iss: 'https://appleid.apple.com', aud: 'com.example.other', sub: '1', email: 'a@b.com',
  })), null);
});

test('the wrong issuer is refused', async () => {
  assert.strictEqual(await social.verify('apple', sign({
    iss: 'https://evil.example', aud: 'com.vesopaepos.pontardawerfc', sub: '1',
  })), null);
});

test('Google with no client ids configured accepts nothing', async () => {
  delete process.env.LOYALTY_GOOGLE_AUDIENCES;
  assert.strictEqual(await social.verify('google', sign({ iss: 'https://accounts.google.com', aud: 'x' })), null);
});

test('an unconfirmed email is not an email', () => {
  assert.strictEqual(social.verifiedEmail({ email: 'a@b.com', email_verified: false }), '');
});
