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
const fs = require('fs');
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

/**
 * The field body of a built pass, whatever style it is written under.
 *
 * Read from PASS_TYPES rather than named, because the style is a decision that
 * has already changed once: all five moved to `eventTicket` to get
 * `groupingIdentifier`, which iOS honours on nothing else. A test that spelled
 * `pass.storeCard` was asserting the layout key rather than the layout, and
 * broke on a change it had no opinion about.
 */
const body = (pass, kind) => pass[G.PASS_TYPES[kind].appleStyle];

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
  const primary = body(pass, 'loyalty').primaryFields[0];
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
  assert.strictEqual(body(pass, 'giftcard').primaryFields[0].value, '£25.50');
});

check('a staff card leads with the name', () => {
  const pass = build('staff', {
    id: '7',
    name: 'Owen Price',
    role: 'Manager',
    card_number: '999900007',
  });
  assert.strictEqual(body(pass, 'staff').primaryFields[0].value, 'Owen Price');
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
    ...body(pass, 'loyalty').secondaryFields,
    ...body(pass, 'loyalty').auxiliaryFields,
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
  assert.ok(config.problems.some((p) => p.includes('holds the key')));
});

check('the bundle is chosen by testing the key, not by its name', () => {
  // This is not hypothetical. The first real folder held two exports — one for
  // these certificates and one from an unrelated CSR — and the wrong one sorted
  // first alphabetically. Keychain Access names an export after whatever was
  // selected, so a filename says nothing about which key is inside.
  const dir = path.join(__dirname, '..', '..', 'passes_and_oauth');
  if (!require('fs').existsSync(dir)) return;

  const bundles = require('fs')
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.p12'));
  if (bundles.length < 2 || !process.env.APPLE_WALLET_P12_PASSWORD) return;

  const chosen = A.findBundle(dir, {
    certDir: dir,
    passphrase: process.env.APPLE_WALLET_P12_PASSWORD,
  });
  assert.ok(chosen, 'nothing matched the certificates');

  // Whatever was chosen, its key has to fit the certificates.
  const { execFileSync } = require('child_process');
  const key = execFileSync('openssl', [
    'pkcs12', '-in', chosen, '-nocerts', '-nodes',
    '-passin', 'env:APPLE_WALLET_P12_PASSWORD', '-legacy',
  ], { stdio: 'pipe' });
  const fromKey = execFileSync('openssl', ['pkey', '-pubout'], {
    input: key, stdio: 'pipe',
  }).toString().trim();
  const fromCert = execFileSync('openssl', [
    'x509', '-inform', 'DER',
    '-in', path.join(dir, A.CER_FILES.loyalty), '-pubkey', '-noout',
  ], { stdio: 'pipe' }).toString().trim();

  assert.strictEqual(fromKey, fromCert, `${path.basename(chosen)} is the wrong key`);
});

/**
 * The two response headers a served pass lives or dies by.
 *
 * Checked against the source rather than a live response, because `serve`
 * is a closure inside the router factory. That is a weaker test than
 * mounting the app, and it is still worth having: the regression it catches
 * is one word in a string literal, and the symptom is a customer at a
 * counter unable to add a card, with nothing logged anywhere.
 */
check('a served pass is inline, not an attachment', () => {
  const src = require('fs').readFileSync(
    path.join(__dirname, '..', 'src', 'wallet_apple_service.js'),
    'utf8'
  );

  assert.ok(
    src.includes("'Content-Type': 'application/vnd.apple.pkpass'"),
    'the pkpass MIME type is what makes a phone offer Wallet at all'
  );

  const header = src
    .split('\n')
    .find((line) => line.includes("'Content-Disposition'"));
  assert.ok(header, 'no Content-Disposition is set on a served pass');

  // `attachment` sends the file into Safari’s download manager and thence to
  // the Files app, where a `.pkpass` cannot be opened at all — there is no
  // Quick Look generator for the type, so tapping it does nothing.
  assert.ok(
    !header.includes('attachment'),
    'attachment sends the pass to Files, which cannot open it'
  );
  assert.ok(
    header.includes('inline'),
    'inline is what hands the bytes straight to Wallet'
  );
});

// ---------------------------------------------------------------------------
// Stacking a venue's cards together
// ---------------------------------------------------------------------------

// iOS honours groupingIdentifier on eventTicket and boardingPass and nothing
// else. If a kind ever moves back to storeCard, its cards silently stop
// stacking -- no error, they just scatter across the wallet. This is the test
// that says why the style is what it is.
check('every kind is eventTicket, which is what makes grouping work', () => {
  for (const [kind, type] of Object.entries(G.PASS_TYPES)) {
    assert.strictEqual(
      type.appleStyle,
      'eventTicket',
      `${kind} is ${type.appleStyle}, so its cards will not stack`
    );
  }
});

check("a venue's five cards all carry the same grouping identifier", () => {
  const branded = { ...brand, join_slug: 'vesopa-kitchen' };
  const groups = Object.keys(G.PASS_TYPES).map(
    (kind) =>
      A.buildPassJson({
        kind,
        config,
        brand: branded,
        subject: { id: 'x', name: 'Sarah Jones', card_number: '1', title: 'Offer' },
        serial: 's',
        authToken: 't',
      }).groupingIdentifier
  );

  assert.strictEqual(new Set(groups).size, 1, 'the five kinds disagree, so they will not stack');
  assert.strictEqual(groups[0], 'venue:vesopa-kitchen');
});

check('two venues never share a stack', () => {
  const one = A.buildPassJson({
    kind: 'loyalty', config, brand: { ...brand, join_slug: 'crown' },
    subject: member, serial: 's', authToken: 't',
  });
  const two = A.buildPassJson({
    kind: 'loyalty', config, brand: { ...brand, join_slug: 'kitchen' },
    subject: member, serial: 's', authToken: 't',
  });
  assert.notStrictEqual(one.groupingIdentifier, two.groupingIdentifier);
});

// The venue's contact email is the primary key of epos_wallet_settings, and
// pass.json sits unencrypted inside a zip the holder can open. A venue that has
// not set a sign-up code must still group, and must still not leak its address.
check('a venue with no sign-up code groups without leaking its email', () => {
  const office = 'manager@vesopa.co.uk';
  const built = A.buildPassJson({
    kind: 'loyalty',
    config,
    brand: { ...brand, office, join_slug: '' },
    subject: member,
    serial: 's',
    authToken: 't',
  });

  assert.ok(built.groupingIdentifier, 'no grouping identifier at all');
  assert.ok(
    !JSON.stringify(built).includes(office),
    "the venue's email address is inside the pass"
  );

  // Stable, or a rebuild would drop the card out of its own stack.
  const again = A.buildPassJson({
    kind: 'giftcard', config, brand: { ...brand, office, join_slug: '' },
    subject: { id: 'g', card_number: '1', balance_minor: 100 }, serial: 's2', authToken: 't2',
  });
  assert.strictEqual(built.groupingIdentifier, again.groupingIdentifier);
});

// ---------------------------------------------------------------------------
// The venue owns the card
// ---------------------------------------------------------------------------

check('the top line is the venue, not the programme', () => {
  const pass = build('loyalty', member);
  assert.strictEqual(pass.logoText, 'The Crown');
  assert.notStrictEqual(pass.logoText, brand.program_name);
});

check('the programme name is kept on the back rather than dropped', () => {
  const pass = build('loyalty', member);
  const programme = body(pass, 'loyalty').backFields.find((f) => f.key === 'programme');
  assert.ok(programme, 'program_name vanished when it lost the top line');
  assert.strictEqual(programme.value, brand.program_name);
});

// ---------------------------------------------------------------------------
// Member numbers
// ---------------------------------------------------------------------------

check('a member number is prefixed by the venue and zero padded', () => {
  const pass = build('loyalty', member);
  const number = body(pass, 'loyalty').auxiliaryFields.find((f) => f.key === 'number');
  assert.ok(number, 'the member number is not on the card');
  // "The Crown" -> C. The article is dropped: it is not what anybody calls it.
  assert.strictEqual(number.value, 'C · 0001');
});

check('a member with no number gets no empty row', () => {
  const pass = build('loyalty', { ...member, member_no: '' });
  const keys = body(pass, 'loyalty').auxiliaryFields.map((f) => f.key);
  assert.ok(!keys.includes('number'));
});

check('the same person has the same number on both their cards', () => {
  const loyalty = build('loyalty', member);
  const membership = build('customer', member);
  const find = (pass, kind) =>
    body(pass, kind).auxiliaryFields.find((f) => f.key === 'number').value;
  assert.strictEqual(find(loyalty, 'loyalty'), find(membership, 'customer'));
});

// ---------------------------------------------------------------------------
// The back of the card
// ---------------------------------------------------------------------------

check('back fields come out in the documented order', () => {
  const pass = build('loyalty', {
    ...member,
    history: [{ at: '2026-09-01', kind: 'earn', points: 12, balance_after: 240 }],
  });
  const keys = body(pass, 'loyalty').backFields.map((f) => f.key);

  const expected = ['history', 'earning', 'scanfail', 'phone', 'website', 'programme',
                    'since', 'terms'];
  const present = expected.filter((k) => keys.includes(k));
  const actual = keys.filter((k) => present.includes(k));
  assert.deepStrictEqual(
    actual, present,
    `back fields are out of order: ${keys.join(', ')}`
  );
});

// A venue that has filled nothing in still gets a working card. That is the
// rule the whole feature is built on, and eight new nullable columns are eight
// new ways to break it.
check('a venue that has filled nothing in still gets a card', () => {
  const bare = { issuer_name: 'Bare Venue', office: 'bare@example.com' };
  const pass = A.buildPassJson({
    kind: 'loyalty', config, brand: bare, subject: member, serial: 's', authToken: 't',
  });
  const fields = body(pass, 'loyalty').backFields;
  assert.ok(fields.every((f) => f.value !== '' && f.value != null), 'a blank row was drawn');
  assert.ok(pass.groupingIdentifier, 'no grouping without a sign-up code');
});

// The one field that is about the card itself. A venue that has not thought
// about a failed scan needs the answer more than one that has.
check('there is always advice for when the scan fails', () => {
  const bare = { issuer_name: 'Bare Venue', office: 'bare@example.com' };
  const pass = A.buildPassJson({
    kind: 'loyalty', config, brand: bare, subject: member, serial: 's', authToken: 't',
  });
  const scanfail = body(pass, 'loyalty').backFields.find((f) => f.key === 'scanfail');
  assert.ok(scanfail && scanfail.value, 'no advice at all when the QR will not read');
});

// ---------------------------------------------------------------------------
// What a push actually says
// ---------------------------------------------------------------------------

// Wallet shows changeMessage on the lock screen when that field moves. Without
// one the update is silent, which is the whole feature not working. "Your pass
// was updated" is why people turn these off, so every message carries the
// number and what it means.
check('the field that moves carries a message with the number in it', () => {
  const cases = {
    loyalty: ['points', member],
    giftcard: ['balance', { id: 'g', card_number: '987800001', balance_minor: 2550 }],
    customer: ['tier', member],
    promo: ['endsin', { id: 'p', title: 'Two for one', ends_on: '2099-01-01' }],
  };

  for (const [kind, [key, subject]] of Object.entries(cases)) {
    const b = body(build(kind, subject), kind);
    const field = [...b.headerFields, ...b.primaryFields].find((f) => f.key === key);
    assert.ok(field, `${kind} has no ${key} field to notify through`);
    assert.ok(field.changeMessage, `${kind}.${key} would update silently`);
    assert.ok(
      field.changeMessage.includes('%@'),
      `${kind}.${key} notifies without saying the new value`
    );
  }
});

check('a staff card never notifies anybody', () => {
  const pass = build('staff', { id: '7', name: 'Owen Price', role: 'Manager', card_number: '9' });
  assert.ok(
    !JSON.stringify(pass).includes('changeMessage'),
    'an administrative edit would ping a phone on a day off'
  );
});

// ---------------------------------------------------------------------------
// Gift cards are bearer instruments
// ---------------------------------------------------------------------------

check('only the last four of a gift card number is printed', () => {
  const pass = build('giftcard', {
    id: 'g1', card_number: '987800001', balance_minor: 2550, currency: 'GBP',
  });
  const header = body(pass, 'giftcard').headerFields.find((f) => f.key === 'last4');
  assert.ok(header, 'no gift card number on the front at all');
  assert.ok(header.value.endsWith('0001'), 'the last four are not shown');
  assert.ok(
    !header.value.includes('987800001'),
    'the whole number is readable across a table'
  );
  // Still scannable: the full number belongs in the barcode, where it is needed.
  assert.strictEqual(pass.barcodes[0].message, '987800001');
});

// ---------------------------------------------------------------------------
// When an offer is on
// ---------------------------------------------------------------------------

check('a happy-hour offer says which days and what time', () => {
  const pass = build('promo', {
    id: 'p1',
    title: '2 for 1',
    details: 'Two for one on mains',
    ends_on: '2026-12-31',
    when: 'Mon–Fri, 5pm–7pm',
  });
  const when = body(pass, 'promo').secondaryFields.find((f) => f.key === 'when');
  assert.ok(when, 'the offer does not say when it is on');
  assert.strictEqual(when.value, 'Mon–Fri, 5pm–7pm');
});

// An offer with no restriction does not need a line saying it has none, and
// the row is better spent on the end date.
check('an all-week offer does not waste a row saying so', () => {
  const pass = build('promo', {
    id: 'p1', title: '2 for 1', ends_on: '2026-12-31', when: 'Every day',
  });
  const keys = body(pass, 'promo').secondaryFields.map((f) => f.key);
  assert.ok(!keys.includes('when'), '"Every day" was printed as a field');
});

check('an offer with too much to say pushes the wording to the back', () => {
  const pass = build('promo', {
    id: 'p1',
    title: '2 for 1',
    details: 'Two for one on mains, excluding steak',
    ends_on: '2026-12-31',
    when: 'Mon–Fri, 5pm–7pm',
  });
  const b = body(pass, 'promo');
  // Apple draws four secondary and auxiliary fields between them. When `when`
  // and `ends` both have something to say, the wording goes on the back rather
  // than off the edge.
  assert.ok(b.secondaryFields.length <= 2, 'more fields than Apple will draw');
  assert.ok(
    b.backFields.some((f) => f.key === 'conditions'),
    'the offer wording was dropped rather than moved'
  );
});

// ---------------------------------------------------------------------------
// Where a gift card's money went
// ---------------------------------------------------------------------------

check('a gift card carries its recent spend on the back', () => {
  const pass = build('giftcard', {
    id: 'g1',
    card_number: '987800001',
    balance_minor: 2550,
    loaded_minor: 5000,
    currency: 'GBP',
    movements: [
      { kind: 'redeem', amount_minor: -2450, balance_after: 2550, created_at: '2026-08-02' },
      { kind: 'issue', amount_minor: 5000, balance_after: 5000, created_at: '2026-01-05' },
    ],
  });
  const spend = body(pass, 'giftcard').backFields.find((f) => f.key === 'spend_history');
  assert.ok(spend, 'no spend history at all');
  assert.ok(spend.value.includes('Spent'), 'a redemption is not named');
  assert.ok(spend.value.includes('£24.50'), 'the amount is missing');
  // The arrow is the balance after the movement, which is what makes the list
  // explain the number on the front rather than sit beside it.
  assert.ok(spend.value.includes('→ £25.50'), 'the running balance is missing');
});

check('a gift card says how much of it has been used', () => {
  const pass = build('giftcard', {
    id: 'g1', card_number: '987800001', balance_minor: 2550,
    loaded_minor: 5000, currency: 'GBP',
  });
  const loaded = body(pass, 'giftcard').secondaryFields.find((f) => f.key === 'loaded');
  assert.ok(loaded, 'nothing says what was loaded');
  assert.strictEqual(loaded.value, 'of £50.00');
});

check('an untouched gift card does not say "of" its own balance', () => {
  const pass = build('giftcard', {
    id: 'g1', card_number: '987800001', balance_minor: 5000,
    loaded_minor: 5000, currency: 'GBP',
  });
  const keys = body(pass, 'giftcard').secondaryFields.map((f) => f.key);
  assert.ok(!keys.includes('loaded'), 'a full card claims it has been spent');
});

// ---------------------------------------------------------------------------
// The progress bar, which is an image and not a field
// ---------------------------------------------------------------------------

const artworkDir = path.join(__dirname, '..', 'assets', 'wallet');

check('a loyalty card gets the strip banded to its progress', () => {
  const at = (p) => A.artworkFor('loyalty', brand, artworkDir, p)['strip@2x.png'];
  const empty = at(0);
  const part = at(0.4);
  const full = at(1);

  assert.ok(empty && part && full, 'a banded strip is missing');
  assert.ok(!empty.equals(part), '0% and 40% are the same image');
  assert.ok(!part.equals(full), '40% and 100% are the same image');
});

check('a venue with no redemption floor gets the plain strip', () => {
  const plain = A.artworkFor('loyalty', brand, artworkDir, null)['strip@2x.png'];
  const banded = A.artworkFor('loyalty', brand, artworkDir, 0)['strip@2x.png'];
  assert.ok(plain && banded);
  assert.ok(!plain.equals(banded), 'a venue with no rules got a 0% bar drawn on it');
});

check('a balance past the reward still fills the bar rather than overflowing', () => {
  const at = (p) => A.artworkFor('loyalty', brand, artworkDir, p)['strip@2x.png'];
  assert.ok(at(1).equals(at(4)), 'four times the target picked a different file');
});

// Only loyalty has a bar. The other three decorations the design asked for —
// the tier chip, the spend bar, the initials disc — restate text already on the
// card, and an image per customer to draw them again is cost with no answer.
check('the other kinds are unaffected by progress', () => {
  for (const kind of ['customer', 'giftcard', 'staff', 'promo']) {
    const plain = A.artworkFor(kind, brand, artworkDir, null)['strip@2x.png'];
    const withProgress = A.artworkFor(kind, brand, artworkDir, 0.5)['strip@2x.png'];
    assert.ok(plain.equals(withProgress), `${kind} changed with a progress value`);
  }
});

// A half-run of tools/wallet_art must cost a progress bar, not a card.
check('a missing band file falls back to the plain strip', () => {
  const os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vesopa-art-'));
  try {
    fs.copyFileSync(
      path.join(artworkDir, 'strip_loyalty@2x.png'),
      path.join(tmp, 'strip_loyalty@2x.png')
    );
    const files = A.artworkFor('loyalty', brand, tmp, 0.4);
    assert.ok(files['strip@2x.png'], 'no strip at all when the band is missing');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

console.log(`\n${passed} checks passed\n`);
