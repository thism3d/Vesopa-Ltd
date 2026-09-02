/**
 * The QR encoder, against a second implementation.
 *
 * `src/qr.js` is written by hand, because no dependency in this project can
 * produce a QR code and the back office has to show one. A hand-written encoder
 * is only a reasonable thing to have if it is checked properly — and the
 * strongest check available is a completely independent encoder, on the same
 * inputs, agreeing on every module.
 *
 * `qr_reference.json` is produced by Dart's `qr` package, which is what the till
 * and the customer display use to draw the same codes. Regenerate it with:
 *
 *     cd tools/wallet_art && dart run bin/qr_reference.dart > ../../test/qr_reference.json
 *
 * A structural test — "the finder patterns are in the corners" — would pass on
 * a code no scanner can read. This one cannot.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const QR = require('../src/qr');

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

console.log('\nQR encoder\n');

const reference = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'qr_reference.json'), 'utf8')
);

check('there is a reference to compare against', () => {
  assert.ok(reference.length >= 4, 'qr_reference.json looks empty');
});

for (const sample of reference) {
  const label = sample.text.length > 40
    ? `${sample.text.slice(0, 37)}…`
    : sample.text;

  check(`every mask matches Dart's encoder for "${label}"`, () => {
    // All eight, not just the chosen one. Comparing only the chosen mask
    // conflates two things: whether the bits underneath are right, and whether
    // both implementations scored the masks the same way. This asserts the
    // first — which is what decides whether a scanner can read the code — and
    // does it eight times over.
    //
    // It is also how the one bug in this encoder was found: the data region,
    // error correction and placement were byte-identical from the start, and
    // all seventeen differing modules were the format bits, placed
    // least-significant-first instead of most.
    for (let mask = 0; mask < 8; mask++) {
      const { matrix } = QR.encode(sample.text, mask);
      assert.strictEqual(
        matrix.length,
        sample.size,
        `chose version giving ${matrix.length} modules, Dart chose ${sample.size}`
      );
      for (let r = 0; r < sample.size; r++) {
        const ours = matrix[r].map((on) => (on ? '1' : '0')).join('');
        assert.strictEqual(ours, sample.masks[String(mask)][r], `mask ${mask}, row ${r}`);
      }
    }
  });

  check(`picks the same mask as Dart for "${label}"`, () => {
    // The specification says to score all eight and keep the lowest penalty.
    // Two implementations following it land on the same one — and where they
    // did not, it would mean the penalty scoring here is wrong, which produces
    // a valid code that is simply harder to scan than it should be.
    assert.strictEqual(QR.encode(sample.text).mask, sample.chosen_mask);
  });
}

// ---------------------------------------------------------------------------
// The things a wallet QR has to survive
// ---------------------------------------------------------------------------

check('a signed save link fits', () => {
  // The real payload: a short link carrying a JWT. If this does not fit, the
  // back office cannot show a scannable code at all.
  const link =
    'https://back.vesopa.co.uk/wallet/c/' + 'e'.repeat(180);
  const { matrix } = QR.encode(link);
  assert.ok(matrix.length >= 21);
});

check('something far too long is refused rather than mangled', () => {
  // A code that silently truncated its payload would produce a QR that scans
  // perfectly and goes to the wrong place, which is the worst of both.
  assert.throws(() => QR.encode('x'.repeat(5000)), /too long/);
});

check('the smallest version that fits is the one chosen', () => {
  // More modules in the same physical space is a code that scans worse, so
  // this is not merely tidiness.
  assert.strictEqual(QR.versionFor(10), 1);
  assert.ok(QR.versionFor(200) > QR.versionFor(10));
});

// ---------------------------------------------------------------------------
// SVG
// ---------------------------------------------------------------------------

check('the svg has a quiet zone', () => {
  // Four modules of margin, and not optional: a QR butted against a coloured
  // background is one a camera cannot find, and it is the most common way a
  // hand-made QR fails.
  const out = QR.svg('https://epos.vesopa.com');
  const viewBox = /viewBox="0 0 (\d+) (\d+)"/.exec(out);
  const { matrix } = QR.encode('https://epos.vesopa.com');
  assert.strictEqual(Number(viewBox[1]), matrix.length + 8);
});

check('the svg draws one path, not a thousand rects', () => {
  const out = QR.svg('https://epos.vesopa.com/wallet/c/abcdefghijklmnop');
  assert.strictEqual((out.match(/<path/g) || []).length, 1);
  assert.strictEqual((out.match(/<rect/g) || []).length, 1, 'just the background');
});

check('the svg carries no script and no external reference', () => {
  // It is inlined into a back-office page and into an email.
  const out = QR.svg('https://epos.vesopa.com');
  assert.ok(!/<script/i.test(out));
  assert.ok(!/href|xlink/i.test(out));
});

check('the colours can be set for a dark page', () => {
  const out = QR.svg('x'.repeat(20), { dark: '#000000', light: '#F2F4F0' });
  assert.ok(out.includes('#F2F4F0'));
  assert.ok(out.includes('#000000'));
});

console.log(`\n${passed} checks passed\n`);
