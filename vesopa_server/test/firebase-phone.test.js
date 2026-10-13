// Firebase phone tokens (2026-10-13): checked against Google's certificates,
// here a certificate made for the test.
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.FIREBASE_PROJECT_ID = 'vesopa';
const fp = require('../src/firebase_phone');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbp-'));
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
fs.writeFileSync(path.join(dir, 'k.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }));
let certPem = null;
try {
  execFileSync('openssl', ['req', '-new', '-x509', '-key', path.join(dir, 'k.pem'), '-subj', '/CN=t', '-days', '1', '-out', path.join(dir, 'c.pem')], { stdio: 'ignore' });
  certPem = fs.readFileSync(path.join(dir, 'c.pem'), 'utf8');
} catch {
  // No openssl here: verify against the public key, which createVerify also takes.
  certPem = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
}

function token(claims, kid = 'k1') {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = enc({ alg: 'RS256', kid, typ: 'JWT' });
  const body = enc(claims);
  const sig = crypto.createSign('RSA-SHA256').update(`${head}.${body}`).sign(privateKey).toString('base64url');
  return `${head}.${body}.${sig}`;
}
const fetchImpl = async () => ({ ok: true, headers: { get: () => 'max-age=600' }, json: async () => ({ k1: certPem }) });
const now = Date.now();
const good = { aud: 'vesopa', iss: 'https://securetoken.google.com/vesopa', sub: 'u1', iat: Math.floor(now / 1000) - 10, exp: Math.floor(now / 1000) + 3600, phone_number: '+8801714526039' };

test('a good token gives the proved number', async () => {
  fp.resetCache();
  assert.deepStrictEqual(await fp.verifyPhoneToken(token(good), { fetchImpl, now }), { phone: '+8801714526039', uid: 'u1' });
});

test('another project, an expired token or a forged signature is refused', async () => {
  for (const bad of [
    token({ ...good, aud: 'other' }),
    token({ ...good, exp: Math.floor(now / 1000) - 1 }),
    token(good).slice(0, -6) + 'AAAAAA',
    token(good, 'unknown-kid'),
    token({ ...good, phone_number: undefined }),
  ]) {
    await assert.rejects(fp.verifyPhoneToken(bad, { fetchImpl, now }));
  }
});
