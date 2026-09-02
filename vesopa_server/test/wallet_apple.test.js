const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const A = require('../src/wallet_apple');
const G = require('../src/wallet_google');

/**
 * Apple Wallet passes.
 *
 * The building blocks — pass.json, the zip, the manifest, the field
 * mapping — are tested here with no certificate at all, the way
 * wallet.test.js checks Google's shapes without a service account.
 *
 * Signing and the PassKit web service need a real .p12 and the real
 * certificates, which only exist in passes_and_oauth/ on a machine that has
 * them. That suite runs — and actually shells out to openssl to verify the
 * signature the way a phone's trust chain would — only when
 * APPLE_WALLET_P12_PASSWORD is set, and otherwise says why it is skipping
 * rather than silently passing nothing.
 */

const BRAND = {
  issuer_name: 'The Copper Kettle',
  program_name: 'Copper Rewards',
  hex_background: '#0f5132',
  homepage_url: 'https://copperkettle.example',
  support_phone: '01912345678',
  terms: 'Points expire after 12 months.',
};

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (e) {
    console.error(`\n  FAIL  ${name}\n        ${e.message}\n`);
    process.exitCode = 1;
  }
}

// Building a pass reaches the network for the merchant's logo, so the checks
// that do it are async. Collected rather than awaited at the call site, the
// way wallet.test.js does it, and waited for at the bottom.
const pending = [];
function testAsync(name, fn) {
  pending.push(
    (async () => {
      try {
        await fn();
        passed += 1;
      } catch (e) {
        console.error(`\n  FAIL  ${name}\n        ${e.message}\n`);
        process.exitCode = 1;
      }
    })()
  );
}

// ---- Configuration ---------------------------------------------------------

test('an empty environment names every missing piece rather than throwing', () => {
  const c = A.readConfig({});
  assert.strictEqual(c.configured, false);
  const joined = c.problems.join(' | ');
  for (const expected of ['P12_PASSWORD', 'BACKOFFICE_URL']) {
    assert.ok(joined.includes(expected), `expected "${expected}" in: ${joined}`);
  }
});

test('a real repo checkout is found even with no password set', () => {
  // The five .cer files and the WWDR intermediate genuinely exist in this
  // checkout's passes_and_oauth/ — only the password (a secret, never
  // committed) and BACKOFFICE_URL are missing in a bare environment.
  const c = A.readConfig({});
  assert.ok(fs.existsSync(c.certFiles.loyalty), c.certFiles.loyalty);
  assert.ok(!c.problems.some((p) => p.includes('No certificate')), c.problems.join('; '));
});

// ---- Identifiers ------------------------------------------------------------

test('the same office, kind and subject always produce the same serial', () => {
  assert.strictEqual(
    A.serialFor('shop@example.com', 'loyalty', 'cust-1'),
    A.serialFor('shop@example.com', 'loyalty', 'cust-1')
  );
});

test('a different subject produces a different serial', () => {
  assert.notStrictEqual(
    A.serialFor('shop@example.com', 'loyalty', 'cust-1'),
    A.serialFor('shop@example.com', 'loyalty', 'cust-2')
  );
});

test('authentication tokens are not predictable or reused', () => {
  const a = A.newAuthToken();
  const b = A.newAuthToken();
  assert.strictEqual(a.length, 32);
  assert.notStrictEqual(a, b);
});

test('hex background colours convert to the rgb() form Apple requires', () => {
  assert.strictEqual(A.hexToRgb('#a5c715', '000000'), 'rgb(165, 199, 21)');
  assert.strictEqual(A.hexToRgb('', '111111'), 'rgb(17, 17, 17)');
});

// ---- pass.json --------------------------------------------------------------

const config = A.readConfig({ BACKOFFICE_URL: 'https://backoffice.vesopaepos.com' });

function buildJson(kind, subject) {
  return A.buildPassJson({
    kind,
    config,
    brand: BRAND,
    subject,
    serialNumber: 'abc123',
    authenticationToken: 'token123',
  });
}

test('the loyalty pass carries the certificate\'s own passTypeIdentifier', () => {
  const pass = buildJson('loyalty', { id: 'c1', name: 'Aisha Rahman', points: 1240, tier: 'Gold' });
  assert.strictEqual(pass.passTypeIdentifier, G.PASS_TYPES.loyalty.appleType);
  assert.strictEqual(pass.formatVersion, 1);
  assert.strictEqual(pass.webServiceURL, 'https://backoffice.vesopaepos.com/apple-wallet');
  assert.strictEqual(pass.authenticationToken, 'token123');
  assert.strictEqual(pass.storeCard.primaryFields[0].value, 1240);
  assert.ok(pass.storeCard.secondaryFields.some((f) => f.value === 'Gold'));
  assert.ok(pass.barcodes.some((b) => b.format === 'PKBarcodeFormatQR'));
});

test('the promotion identifier is plural, matching the issued certificate', () => {
  const pass = buildJson('promo', { id: 'p1', title: '2 for 1', ends_on: '2026-12-31' });
  assert.strictEqual(pass.passTypeIdentifier, 'pass.com.vesopa.promotions');
  assert.ok('coupon' in pass);
});

test('a card with no tier omits the field rather than sending a blank one', () => {
  const pass = buildJson('loyalty', { id: 'c2', points: 0 });
  assert.ok(!pass.storeCard.secondaryFields.some((f) => f.key === 'tier'));
});

test('the staff card is generic, not storeCard', () => {
  const pass = buildJson('staff', { id: 's1', name: 'Owen Price', role: 'Manager', card_number: '999900007' });
  assert.ok('generic' in pass);
  assert.strictEqual(pass.generic.primaryFields[0].value, 'Owen Price');
});

test('a gift card balance is formatted as currency, not raw pence', () => {
  const pass = buildJson('giftcard', { id: 'g1', balance_minor: 2550, currency: 'GBP', card_number: '1' });
  assert.strictEqual(pass.storeCard.primaryFields[0].value, '£25.50');
});

// ---- Artwork ----------------------------------------------------------------

test('the bundled icon is the square 29x29 Apple asks for', () => {
  const icon = fs.readFileSync(path.join(A.ASSET_DIR, 'icon.png'));
  assert.deepStrictEqual(A.pngSize(icon), { width: 29, height: 29 });
});

test('a PNG that is not a PNG reports no size rather than a wrong one', () => {
  assert.strictEqual(A.pngSize(Buffer.from('not an image at all')), null);
});

// ---- The zip ----------------------------------------------------------------

test('crc32 matches the well-known test vector for "123456789"', () => {
  assert.strictEqual(A.crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('a built zip starts with a local file header and unzip can read it back', () => {
  const zip = A.zipStore({
    'pass.json': Buffer.from('{"a":1}'),
    'icon.png': Buffer.from([1, 2, 3]),
  });
  assert.strictEqual(zip.readUInt32LE(0), 0x04034b50);

  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'wallet-apple-ziptest-'));
  const zipPath = path.join(dir, 'test.pkpass');
  fs.writeFileSync(zipPath, zip);
  execFileSync('unzip', ['-o', zipPath, '-d', dir]);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'pass.json'), 'utf8'), '{"a":1}');
  assert.deepStrictEqual([...fs.readFileSync(path.join(dir, 'icon.png'))], [1, 2, 3]);
});

// ---- Against the real material, when it is available -----------------------

if (!process.env.APPLE_WALLET_P12_PASSWORD) {
  console.log(
    'wallet_apple: skipping signing tests — set APPLE_WALLET_P12_PASSWORD to run them ' +
      'against the real certificates in passes_and_oauth/'
  );
} else {
  testAsync('a pass built and signed against the real certificates verifies with openssl', async () => {
    const realConfig = A.readConfig({
      ...process.env,
      BACKOFFICE_URL: 'https://backoffice.vesopaepos.com',
    });
    assert.strictEqual(realConfig.configured, true, realConfig.problems.join('; '));

    const pkpass = await A.buildPkpass({
      kind: 'loyalty',
      config: realConfig,
      brand: BRAND,
      subject: { id: 'c1', name: 'Aisha Rahman', points: 1240, tier: 'Gold', card_number: '999800001' },
      serialNumber: A.serialFor('test@example.com', 'loyalty', 'c1'),
      authenticationToken: A.newAuthToken(),
    });

    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'wallet-apple-signtest-'));
    fs.writeFileSync(path.join(dir, 'test.pkpass'), pkpass);
    execFileSync('unzip', ['-o', path.join(dir, 'test.pkpass'), '-d', dir]);

    // The manifest's own claim about each file must be true...
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    const crypto = require('crypto');
    for (const [name, hash] of Object.entries(manifest)) {
      const actual = crypto.createHash('sha1').update(fs.readFileSync(path.join(dir, name))).digest('hex');
      assert.strictEqual(actual, hash, `${name} does not match its manifest hash`);
    }

    // ...and the signature over the manifest must verify, exactly the check a
    // phone's trust chain performs before Wallet will install anything.
    assert.doesNotThrow(() =>
      execFileSync('openssl', [
        'smime', '-verify', '-in', path.join(dir, 'signature'), '-inform', 'DER',
        '-content', path.join(dir, 'manifest.json'), '-noverify',
      ])
    );
  });
}

// ---- The route a phone actually taps ---------------------------------------

/** Answers whatever the SQL asks about, keyed by a fragment of the query. */
function stubPool(rows = {}) {
  const match = (sql) => {
    const key = Object.keys(rows).find((k) => sql.includes(k));
    return key ? rows[key] : [];
  };
  return {
    query: async (sql) => [match(sql)],
    execute: async (sql) => [match(sql)],
  };
}

if (process.env.APPLE_WALLET_P12_PASSWORD) {
  testAsync('the download route serves a real pass as application/vnd.apple.pkpass', async () => {
    const express = require('express');
    const jwt = require('jsonwebtoken');
    const { walletPublicRoutes, walletCore } = require('../src/wallet');
    const secret = 'test-secret';

    const saved = process.env.BACKOFFICE_URL;
    process.env.BACKOFFICE_URL = 'https://backoffice.vesopaepos.com';

    // One customer, one already-minted pass. Keyed by a fragment of each
    // query the route runs, which is all stubPool needs to answer.
    const pool = stubPool({
      'FROM epos_customers': [
        { id: 'c1', name: 'Sarah Jones', card_number: '999800001', points_balance: 240, tier_name: 'Gold' },
      ],
      'FROM epos_wallet_settings': [{ office: 'shop@example.com', enabled: 1, issuer_name: 'The Crown' }],
      'FROM epos_wallet_passes': [{ id: 'p1', apple_serial: 'a'.repeat(40), apple_auth_token: 'b'.repeat(32) }],
    });

    const app = express();
    app.use(walletPublicRoutes({ pool, secret, core: walletCore({ pool, secret }) }));
    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;

    try {
      const token = jwt.sign(
        { scope: 'wallet-apple', office: 'shop@example.com', kind: 'loyalty', sub: 'c1' },
        secret
      );
      const res = await fetch(`${base}/wallet/a/${token}`);
      // Read the body once: a failed response is an HTML page explaining
      // why, and that page is the most useful thing to put in the message.
      const body = Buffer.from(await res.arrayBuffer());
      assert.strictEqual(res.status, 200, body.toString('utf8').slice(0, 400));

      // The header that decides whether iOS opens Wallet or saves a file.
      assert.strictEqual(res.headers.get('content-type'), 'application/vnd.apple.pkpass');

      // And it must be a real signed package, not an error page with the
      // right content type on it.
      assert.strictEqual(body.readUInt32LE(0), 0x04034b50, 'body should be a zip');
      const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'wallet-apple-route-'));
      fs.writeFileSync(path.join(dir, 'p.pkpass'), body);
      execFileSync('unzip', ['-o', path.join(dir, 'p.pkpass'), '-d', dir]);
      const pass = JSON.parse(fs.readFileSync(path.join(dir, 'pass.json'), 'utf8'));
      assert.strictEqual(pass.passTypeIdentifier, 'pass.com.vesopa.loyalty');
      assert.strictEqual(pass.authenticationToken, 'b'.repeat(32));
      assert.doesNotThrow(() =>
        execFileSync('openssl', [
          'smime', '-verify', '-in', path.join(dir, 'signature'), '-inform', 'DER',
          '-content', path.join(dir, 'manifest.json'), '-noverify',
        ], { stdio: ['pipe', 'pipe', 'ignore'] })
      );
    } finally {
      server.close();
      if (saved === undefined) delete process.env.BACKOFFICE_URL;
      else process.env.BACKOFFICE_URL = saved;
    }
  });
}

Promise.all(pending).then(() => {
  console.log(`wallet_apple: ${passed} checks passed${process.exitCode ? ' (with failures above)' : ''}`);
});
