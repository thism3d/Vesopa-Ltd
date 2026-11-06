/**
 * Signing a printer profile (src/profile_signing.js), with a throwaway certificate.
 */
'use strict';

const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { sign } = require('../src/profile_signing');

(async () => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'pipe' });
  } catch {
    console.log('profile-signing: skipped, no openssl here');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-'));
  try {
    assert.strictEqual(await sign('<plist/>', dir), null, 'no certificate, no signature, no failure');

    const at = (n) => path.join(dir, n);
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', at('key.pem'), '-out', at('cert.pem'),
      '-subj', '/CN=Test', '-days', '1'], { stdio: 'pipe' });
    fs.copyFileSync(at('cert.pem'), at('chain.pem'));

    const text = '<?xml version="1.0"?>\n<plist>Vesopa Office</plist>\n';
    const signed = await sign(text, dir);
    assert.ok(Buffer.isBuffer(signed) && signed.length > text.length);
    assert.notStrictEqual(signed.indexOf('Vesopa'), -1, 'the profile is inside the signature, not beside it');
    fs.writeFileSync(at('signed.der'), signed);
    const back = execFileSync('openssl', ['smime', '-verify', '-binary', '-inform', 'der', '-in', at('signed.der'), '-noverify'], { stdio: 'pipe' });
    assert.strictEqual(back.toString('utf8'), text, 'exactly the same bytes come back');

    fs.writeFileSync(at('key.pem'), 'not a key');
    const warn = console.warn;
    console.warn = () => {};
    assert.strictEqual(await sign(text, dir), null, 'a broken key sends the profile unsigned rather than failing');
    console.warn = warn;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('profile-signing: checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
