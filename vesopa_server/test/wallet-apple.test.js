/**
 * Apple Wallet: the parts that can be checked without a private key.
 *
 * Signing needs the five `.p12` bundles, which are deliberately not in this
 * repository and never will be — so `buildPkpass` end to end is not testable
 * here and is not pretended to be. What *is* testable is everything that
 * decides whether the pass Apple receives is correct: the JSON, the colours,
 * the archive, and the image set.
 *
 * That split matters, because a `.pkpass` fails with no diagnostic. Every
 * assertion below is a mistake that would otherwise present as "Safari cannot
 * download this file" with nothing to go on.
 */

const assert = require('assert');
const path = require('path');
const zlib = require('zlib');

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

console.log('\nApple Wallet\n');

const config = { teamId: 'G238FR2ZC9', webServiceUrl: '' };

const brand = {
  issuer_name: 'The Crown',
  program_name: 'Crown Rewards',
  hex_background: '#111111',
  hex_foreground: '#F2F4F0',
  hex_label: '#A5C715',
  homepage_url: 'https://thecrown.example',
  support_phone: '01792 316282',
  terms: 'Points expire after 24 months.',
};

const member = {
  id: 'cust-1',
  name: 'Sarah Jones',
  card_number: '999800001',
  member_no: '1',
  points: 240,
  tier: 'Gold',
  discount: '10% off',
  member_since: '2024-03-02',
};

const build = (kind, subject) =>
  A.buildPassJson({
    kind,
    config,
    brand,
    subject,
    serial: 'serial-1',
    authToken: 'token-1',
  });

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

check('the pass type identifier matches the certificate that signs it', () => {
  // The single highest-value assertion in this file. A .pkpass whose
  // passTypeIdentifier differs from its signing certificate by one character is
  // rejected with an error that does not name the field — half a day of
  // debugging, avoided here.
  for (const [kind, type] of Object.entries(G.PASS_TYPES)) {
    const pass = build(kind, member);
    assert.strictEqual(pass.passTypeIdentifier, type.appleType, kind);
  }
});

check('promotions is plural, because the certificate says so', () => {
  assert.strictEqual(
    build('promo', { id: '1', title: '2 for 1', card_number: 'PROMO1' })
      .passTypeIdentifier,
    'pass.com.vesopa.promotions'
  );
});

check('the team identifier is the one on the certificates', () => {
  assert.strictEqual(build('loyalty', member).teamIdentifier, 'G238FR2ZC9');
});

check('every kind uses the Apple style its certificate was issued for', () => {
  // storeCard, generic and coupon lay out differently and are not
  // interchangeable: the body has to sit under the key Apple expects or the
  // card renders with no fields at all.
  for (const [kind, type] of Object.entries(G.PASS_TYPES)) {
    const pass = build(kind, member);
    assert.ok(pass[type.appleStyle], `${kind} has no ${type.appleStyle} body`);
  }
});

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------

check('colours are rgb(), not hex', () => {
  // Apple silently ignores a colour it cannot parse, which presents as a card
  // in the default white rather than as an error.
  const pass = build('loyalty', member);
  assert.strictEqual(pass.backgroundColor, 'rgb(17, 17, 17)');
  assert.strictEqual(pass.foregroundColor, 'rgb(242, 244, 240)');
  assert.strictEqual(pass.labelColor, 'rgb(165, 199, 21)');
});

check('a hex colour with no hash still parses', () => {
  assert.strictEqual(A.rgb('A5C715', 'x'), 'rgb(165, 199, 21)');
});

check('a three-digit hex expands', () => {
  assert.strictEqual(A.rgb('#111', 'x'), 'rgb(17, 17, 17)');
});

check('rubbish falls back to the brand rather than to nothing', () => {
  assert.strictEqual(A.rgb('chartreuse', A.BRAND.label), A.BRAND.label);
  assert.strictEqual(A.rgb('', A.BRAND.background), A.BRAND.background);
  assert.strictEqual(A.rgb(null, A.BRAND.background), A.BRAND.background);
});

check('a venue that has chosen nothing gets the Vesopa palette', () => {
  const pass = A.buildPassJson({
    kind: 'loyalty',
    config,
    brand: { issuer_name: 'Nowhere' },
    subject: member,
    serial: 's',
    authToken: 't',
  });
  // Not Apple's defaults, which on a dark card are dark grey on near-black.
  assert.strictEqual(pass.backgroundColor, A.BRAND.background);
  assert.strictEqual(pass.labelColor, A.BRAND.label);
});

// ---------------------------------------------------------------------------
// What each card says
// ---------------------------------------------------------------------------

check('a loyalty card leads with the points', () => {
  const pass = build('loyalty', member);
  const primary = pass.storeCard.primaryFields[0];
  assert.strictEqual(primary.key, 'points');
  assert.strictEqual(primary.value, 240);
});

check('a gift card leads with the balance, as money', () => {
  const pass = build('giftcard', {
    id: 'g1',
    card_number: '987800001',
    balance_minor: 2550,
    currency: 'GBP',
  });
  assert.strictEqual(pass.storeCard.primaryFields[0].value, '£25.50');
});

check('a staff card leads with the name', () => {
  const pass = build('staff', {
    id: '7',
    name: 'Owen Price',
    role: 'Manager',
    card_number: '999900007',
  });
  assert.strictEqual(pass.generic.primaryFields[0].value, 'Owen Price');
});

check('a staff PIN never reaches the card', () => {
  // The subject loader does not put one there, and nothing in the builder
  // reads one. Asserted anyway: a PIN on something carried in public defeats
  // the point of having one, and this is the test that would catch it being
  // added by accident.
  const pass = build('staff', {
    id: '7',
    name: 'Owen Price',
    card_number: '999900007',
    pin: '4821',
  });
  assert.ok(!JSON.stringify(pass).includes('4821'));
});

check('an empty field is left out rather than shown blank', () => {
  const pass = build('loyalty', {
    id: 'c2',
    name: 'Nobody',
    card_number: '999800002',
    points: 0,
    tier: '',
    member_no: '',
    discount: '',
  });
  const keys = [
    ...pass.storeCard.secondaryFields,
    ...pass.storeCard.auxiliaryFields,
  ].map((f) => f.key);
  assert.ok(!keys.includes('tier'));
  assert.ok(!keys.includes('number'));
  assert.ok(!keys.includes('discount'));
});

check('a spent gift card is voided, not hidden', () => {
  // It greys out in the wallet. A card that vanished would read as a bug in
  // the wallet, and the holder rings the venue about it.
  const pass = build('giftcard', {
    id: 'g2',
    card_number: '987800002',
    balance_minor: 0,
    state: 'EXPIRED',
  });
  assert.strictEqual(pass.voided, true);
});

// ---------------------------------------------------------------------------
// The barcode
// ---------------------------------------------------------------------------

check('the barcode carries the card number and no sentinels', () => {
  // The whole point of the exercise: a phone at the counter scans to exactly
  // what a piece of plastic would. The `;` and `?` are the stripe reader's
  // framing and would break the scan.
  const pass = build('loyalty', member);
  for (const barcode of pass.barcodes) {
    assert.strictEqual(barcode.message, '999800001');
    assert.ok(!barcode.message.includes(';'));
    assert.ok(!barcode.message.includes('?'));
  }
});

check('both a QR and a Code 128 are offered', () => {
  // A supermarket-style laser scanner cannot read a QR at all.
  const formats = build('loyalty', member).barcodes.map((b) => b.format);
  assert.ok(formats.includes('PKBarcodeFormatQR'));
  assert.ok(formats.includes('PKBarcodeFormatCode128'));
});

check('a customer with no card number still gets a scannable pass', () => {
  const pass = build('loyalty', { id: 'cust-9', name: 'New', points: 0 });
  assert.strictEqual(pass.barcodes[0].message, 'cust-9');
});

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------

check('no web service means neither half is written', () => {
  // Apple ignores one without the other, so a half-configured pass would look
  // updatable and never update.
  const pass = build('loyalty', member);
  assert.ok(!('webServiceURL' in pass));
  assert.ok(!('authenticationToken' in pass));
});

check('a configured web service writes both', () => {
  const pass = A.buildPassJson({
    kind: 'loyalty',
    config: { ...config, webServiceUrl: 'https://example.test/wallet' },
    brand,
    subject: member,
    serial: 'serial-1',
    authToken: 'token-1',
  });
  assert.strictEqual(pass.webServiceURL, 'https://example.test/wallet');
  assert.strictEqual(pass.authenticationToken, 'token-1');
});

// ---------------------------------------------------------------------------
// The archive
// ---------------------------------------------------------------------------

check('the zip round-trips through an independent reader', () => {
  // Written by hand against zlib, so it is checked by decompressing the entries
  // out of the bytes rather than by trusting the writer that made them.
  const files = {
    'pass.json': Buffer.from('{"a":1}'),
    'icon.png': A.solidPng(29, 29, 'rgb(17, 17, 17)'),
  };
  const zip = A.zip(files);

  // End of central directory, last 22 bytes.
  assert.strictEqual(zip.readUInt32LE(zip.length - 22), 0x06054b50);
  assert.strictEqual(zip.readUInt16LE(zip.length - 22 + 10), 2, 'entry count');

  // First local header, and the deflated bytes right behind it.
  assert.strictEqual(zip.readUInt32LE(0), 0x04034b50);
  const nameLen = zip.readUInt16LE(26);
  const compressed = zip.readUInt32LE(18);
  const body = zip.subarray(30 + nameLen, 30 + nameLen + compressed);
  assert.strictEqual(zlib.inflateRawSync(body).toString(), '{"a":1}');
});

check('the crc in the header is the crc of the content', () => {
  // A wrong CRC is the classic hand-rolled-zip bug, and iOS reports it as a
  // pass it cannot read rather than as a corrupt archive.
  const content = Buffer.from('the quick brown fox');
  const zip = A.zip({ 'a.txt': content });
  assert.strictEqual(zip.readUInt32LE(14), A.crc32(content));
});

check('crc32 agrees with the known value for "123456789"', () => {
  assert.strictEqual(A.crc32(Buffer.from('123456789')), 0xcbf43926);
});

// ---------------------------------------------------------------------------
// Artwork
// ---------------------------------------------------------------------------

const assetsDir = path.join(__dirname, '..', 'assets', 'wallet');

check('every kind gets its own strip', () => {
  const seen = new Set();
  for (const kind of Object.keys(G.PASS_TYPES)) {
    const art = A.artworkFor(kind, brand, assetsDir);
    assert.ok(art['strip.png'], `${kind} has no strip`);
    seen.add(art['strip.png'].length);
  }
  // Five different images, not one reused five times.
  assert.strictEqual(seen.size, 5);
});

check('an icon is always present, even with no artwork at all', () => {
  // A .pkpass without icon.png is rejected outright, with no message naming
  // the file. There is no path where this is merely missing.
  const art = A.artworkFor('loyalty', brand, '/nowhere-at-all');
  assert.ok(art['icon.png']);
  assert.ok(art['icon@2x.png']);
});

check('the generated fallback icon is a real PNG', () => {
  const png = A.solidPng(29, 29, 'rgb(17, 17, 17)');
  assert.deepStrictEqual(
    [...png.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  );
  assert.strictEqual(png.readUInt32BE(16), 29, 'width');
  assert.strictEqual(png.readUInt32BE(20), 29, 'height');
});

check('the shipped artwork is PNG, which is all Apple accepts', () => {
  const art = A.artworkFor('loyalty', brand, assetsDir);
  for (const [name, bytes] of Object.entries(art)) {
    assert.deepStrictEqual(
      [...bytes.subarray(0, 4)],
      [0x89, 0x50, 0x4e, 0x47],
      `${name} is not a PNG`
    );
  }
});

check('a pass stays small enough to download at a counter', () => {
  // Not Apple's 10MB limit — the limit that matters is a customer on mobile
  // data waiting while the person behind them queues.
  const art = A.artworkFor('giftcard', brand, assetsDir);
  const total = Object.values(art).reduce((n, b) => n + b.length, 0);
  assert.ok(total < 600 * 1024, `artwork is ${Math.round(total / 1024)}KB`);
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

check('an unconfigured deployment says exactly what is missing', () => {
  const config = A.readConfig({});
  assert.strictEqual(config.configured, false);
  assert.ok(config.problems.some((p) => p.includes('APPLE_WALLET_DIR')));
  assert.ok(config.problems.some((p) => p.includes('APPLE_WWDR_CERT')));
});

check('the team id can be overridden without editing code', () => {
  assert.strictEqual(A.readConfig({ APPLE_TEAM_ID: 'ABCDE12345' }).teamId, 'ABCDE12345');
});

check('there is a p12 and a certificate named for every pass type', () => {
  for (const kind of Object.keys(G.PASS_TYPES)) {
    assert.ok(A.P12_FILES[kind], `no signing bundle mapped for ${kind}`);
    assert.ok(A.CER_FILES[kind], `no certificate mapped for ${kind}`);
  }
});

check('every mapped certificate is actually in the repository', () => {
  // The public halves are committed, so a missing one is a typo in the map
  // rather than a deployment problem — and it would present as a pass that
  // cannot be signed for one kind only.
  const dir = path.join(__dirname, '..', '..', 'passes_and_oauth');
  for (const [kind, file] of Object.entries(A.CER_FILES)) {
    assert.ok(require('fs').existsSync(path.join(dir, file)), `${kind}: ${file}`);
  }
});

check('the certificate for each kind carries that pass type identifier', () => {
  // The one mismatch that produces a pass rejected with no diagnostic. Read off
  // the certificates themselves rather than trusted from the table.
  const { execFileSync } = require('child_process');
  const dir = path.join(__dirname, '..', '..', 'passes_and_oauth');
  for (const [kind, file] of Object.entries(A.CER_FILES)) {
    const subject = String(
      execFileSync('openssl', [
        'x509', '-inform', 'DER', '-in', path.join(dir, file),
        '-noout', '-subject',
      ])
    );
    assert.ok(
      subject.includes(G.PASS_TYPES[kind].appleType),
      `${file} is not the certificate for ${G.PASS_TYPES[kind].appleType}`
    );
  }
});

check('one shared bundle is an option, so setup is one export not five', () => {
  assert.strictEqual(A.SHARED_P12, 'vesopa_wallet.p12');
});

check('a folder with no bundle in it says so', () => {
  const config = A.readConfig({
    APPLE_WALLET_DIR: __dirname,
    APPLE_WWDR_CERT: __filename,
  });
  assert.strictEqual(config.configured, false);
  assert.ok(config.problems.some((p) => p.includes('no .p12 found')));
});

console.log(`\n${passed} checks passed\n`);
