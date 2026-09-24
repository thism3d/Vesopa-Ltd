/**
 * A real, signed `.pkpass` — end to end, when the material is here.
 *
 * WHY THIS IS SEPARATE AND CONDITIONAL
 *
 * Signing needs a private key, which is deliberately not in this repository and
 * never will be. So this suite **skips itself** unless it can find one, and
 * `wallet-apple.test.js` covers everything that can be checked without it.
 *
 * When the material *is* present — a developer machine, or a deploy box — this
 * is the test that actually matters, because it is the only one that proves the
 * three hand-written pieces work together: the ZIP writer, the SHA-1 manifest,
 * and the detached PKCS#7. Each is checked separately elsewhere; a pass fails
 * if any one of them is subtly wrong, and it fails with no diagnostic at all.
 * iOS says "Safari cannot download this file" whatever the fault is.
 *
 * To run it:
 *
 *     APPLE_WALLET_DIR=../passes_and_oauth \
 *     APPLE_WWDR_CERT=../passes_and_oauth/wwdr.pem \
 *     APPLE_WALLET_P12_PASSWORD=… \
 *     node test/wallet-apple-signing.test.js
 *
 * The WWDR intermediate is fetched from Apple, not committed — it expires, and
 * a stale copy in git outlives the day anybody notices:
 *
 *     curl -o wwdr.cer https://www.apple.com/certificateauthority/AppleWWDRCAG4.cer
 *     openssl x509 -inform DER -in wwdr.cer -out wwdr.pem
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const A = require('../src/wallet_apple');
const G = require('../src/wallet_google');

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

console.log('\nApple Wallet: signing\n');

const config = A.readConfig(process.env);

if (!config.configured) {
  // Not a failure. A machine with no signing key is the normal case for this
  // repository, and saying why beats a suite that silently passes.
  console.log('  -- skipped: no signing material on this machine');
  for (const problem of config.problems) console.log(`     ${problem}`);
  console.log('');
  process.exit(0);
}

const brand = {
  issuer_name: 'The Crown',
  program_name: 'Crown Rewards',
  hex_background: '#111111',
  hex_foreground: '#F2F4F0',
  hex_label: '#A5C715',
};

const subject = {
  id: 'cust-1',
  name: 'Sarah Jones',
  card_number: '999800001',
  points: 240,
  tier: 'Gold',
  balance_minor: 2550,
  currency: 'GBP',
  title: '2 for 1',
  role: 'Manager',
};

const assetsDir = path.join(__dirname, '..', 'assets', 'wallet');

/** Unpack an archive the way iOS would, using the central directory. */
function unzip(bytes) {
  const files = {};
  const end = bytes.length - 22;
  assert.strictEqual(bytes.readUInt32LE(end), 0x06054b50, 'no end-of-central-directory');

  let at = bytes.readUInt32LE(end + 16);
  const count = bytes.readUInt16LE(end + 10);

  for (let i = 0; i < count; i++) {
    assert.strictEqual(bytes.readUInt32LE(at), 0x02014b50, 'bad central header');
    const nameLength = bytes.readUInt16LE(at + 28);
    const extraLength = bytes.readUInt16LE(at + 30);
    const commentLength = bytes.readUInt16LE(at + 32);
    const localAt = bytes.readUInt32LE(at + 42);
    const name = bytes.subarray(at + 46, at + 46 + nameLength).toString('utf8');

    const localNameLength = bytes.readUInt16LE(localAt + 26);
    const localExtraLength = bytes.readUInt16LE(localAt + 28);
    const compressed = bytes.readUInt32LE(localAt + 18);
    const from = localAt + 30 + localNameLength + localExtraLength;

    files[name] = zlib.inflateRawSync(bytes.subarray(from, from + compressed));
    at += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

const built = {};
for (const kind of Object.keys(G.PASS_TYPES)) {
  check(`a ${kind} pass builds and signs`, () => {
    built[kind] = A.buildPkpass({ kind, config, brand, subject, assetsDir });
    assert.ok(built[kind].bytes.length > 1000);
  });
}

check('the archive unpacks, and holds what Apple requires', () => {
  const files = unzip(built.loyalty.bytes);
  for (const required of ['pass.json', 'manifest.json', 'signature', 'icon.png']) {
    assert.ok(files[required], `no ${required} in the archive`);
  }
});

check('every hash in the manifest matches its file', () => {
  const files = unzip(built.loyalty.bytes);
  const manifest = JSON.parse(files['manifest.json'].toString());

  for (const [name, hash] of Object.entries(manifest)) {
    assert.ok(files[name], `manifest names ${name}, which is not in the archive`);
    assert.strictEqual(
      crypto.createHash('sha1').update(files[name]).digest('hex'),
      hash,
      `${name} does not match its manifest hash`
    );
  }
});

check('the signature is not itself in the manifest', () => {
  // It cannot be — it is computed *over* the manifest. Including it would be a
  // circular hash, and iOS rejects the pass.
  const files = unzip(built.loyalty.bytes);
  const manifest = JSON.parse(files['manifest.json'].toString());
  assert.ok(!('signature' in manifest));
});

check('every file in the archive is in the manifest', () => {
  // Other than the two that cannot be. An unlisted file is an unsigned file,
  // which is the hole the manifest exists to close.
  const files = unzip(built.loyalty.bytes);
  const manifest = JSON.parse(files['manifest.json'].toString());
  for (const name of Object.keys(files)) {
    if (name === 'manifest.json' || name === 'signature') continue;
    assert.ok(manifest[name], `${name} is in the archive but not signed`);
  }
});

check('the signature verifies against the manifest', () => {
  // The whole point. openssl is asked to check the detached PKCS#7 over the
  // exact bytes of manifest.json — which is what iOS does before it will
  // install anything.
  const files = unzip(built.loyalty.bytes);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vesopa-verify-'));
  try {
    fs.writeFileSync(path.join(work, 'manifest.json'), files['manifest.json']);
    fs.writeFileSync(path.join(work, 'signature'), files.signature);

    const out = execFileSync('openssl', [
      'smime', '-verify', '-inform', 'DER',
      '-in', path.join(work, 'signature'),
      '-content', path.join(work, 'manifest.json'),
      // The chain is asserted separately below. This checks the signature
      // itself, which is the part this code is responsible for.
      '-noverify',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    assert.ok(out.length > 0);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

check('the signature carries the attributes Wallet expects', () => {
  // The bug this exists to prevent: signing with `-noattr`.
  //
  // A signature with no authenticated attributes verifies perfectly under
  // `openssl smime -verify` — the check above passes — and iOS refuses the
  // pass in silence. No error on the phone, no error in any log, and the pass
  // still renders a preview in Messages, so it looks like a delivery problem
  // rather than a signing one. It cost a day.
  //
  // Apple's own `signpass`, and every library that signs passes in
  // production, emit these three. So must we.
  const files = unzip(built.loyalty.bytes);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vesopa-attrs-'));
  try {
    fs.writeFileSync(path.join(work, 'signature'), files.signature);
    const printed = String(
      execFileSync('openssl', [
        'pkcs7', '-inform', 'DER', '-in', path.join(work, 'signature'), '-print',
      ], { stdio: ['pipe', 'pipe', 'pipe'] })
    );

    for (const attr of ['contentType', 'messageDigest', 'signingTime']) {
      assert.ok(
        printed.includes(attr),
        `the signature is missing the ${attr} authenticated attribute — ` +
          `this pass will verify with openssl and refuse to install on a phone`
      );
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

check('each pass is signed by its own pass type certificate', () => {
  // The mismatch Apple rejects with an error naming no field at all — and the
  // one a single shared key bundle could produce if the certificate were not
  // chosen per kind.
  for (const [kind, type] of Object.entries(G.PASS_TYPES)) {
    const files = unzip(built[kind].bytes);
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vesopa-signer-'));
    try {
      fs.writeFileSync(path.join(work, 'signature'), files.signature);
      const certs = String(
        execFileSync('openssl', [
          'pkcs7', '-inform', 'DER', '-in', path.join(work, 'signature'),
          '-print_certs', '-noout',
        ], { stdio: 'pipe' })
      );
      assert.ok(
        certs.includes(type.appleType),
        `${kind} was signed by something other than ${type.appleType}`
      );
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }
});

check('Apple’s WWDR intermediate travels with the pass', () => {
  // Without it a device has no path from the signer to Apple's root, and the
  // pass will not install on a phone that has not seen the intermediate before.
  const files = unzip(built.loyalty.bytes);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vesopa-chain-'));
  try {
    fs.writeFileSync(path.join(work, 'signature'), files.signature);
    const certs = String(
      execFileSync('openssl', [
        'pkcs7', '-inform', 'DER', '-in', path.join(work, 'signature'),
        '-print_certs', '-noout',
      ], { stdio: 'pipe' })
    );
    assert.ok(/Apple Worldwide Developer Relations/.test(certs));
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

check('pass.json says what the card is', () => {
  const files = unzip(built.loyalty.bytes);
  const pass = JSON.parse(files['pass.json'].toString());
  assert.strictEqual(pass.passTypeIdentifier, 'pass.com.vesopa.loyalty');
  assert.strictEqual(pass.teamIdentifier, config.teamId);
  assert.strictEqual(pass.barcodes[0].message, '999800001');
  assert.ok(pass.serialNumber);
});

check('the same customer gets the same serial twice', () => {
  // A serial is what Apple keys a pass on. Reissuing with a new one gives the
  // holder a second card rather than an updated one.
  const again = A.buildPkpass({
    kind: 'loyalty', config, brand, subject, assetsDir,
    serial: built.loyalty.serial,
    authToken: built.loyalty.authToken,
  });
  const first = JSON.parse(unzip(built.loyalty.bytes)['pass.json'].toString());
  const second = JSON.parse(unzip(again.bytes)['pass.json'].toString());
  assert.strictEqual(first.serialNumber, second.serialNumber);
});

check('a pass is small enough to download at a counter', () => {
  for (const [kind, pass] of Object.entries(built)) {
    assert.ok(
      pass.bytes.length < 900 * 1024,
      `${kind} is ${Math.round(pass.bytes.length / 1024)}KB`
    );
  }
});

console.log(`\n${passed} checks passed\n`);
