/**
 * The back office image cropper's geometry.
 *
 * The bug these were written for: the zoom slider bottomed out at *cover* —
 * the shortest side filling the frame — so a picture could only ever be
 * cropped, never fitted. A tall bottle shot lost its top and bottom and there
 * was no way to get them back, which is what "the images are too zoomed in"
 * actually meant. The floor was in the wrong place, not the zoom.
 *
 * No DOM and no canvas here: the arithmetic is lifted out of public/app.js and
 * run on its own, the same trick backoffice-kitchen-ui.test.js uses on the
 * editors. Everything below the crop helpers in that file is DOM; everything in
 * them is numbers.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

/**
 * app.js, with its line endings normalised.
 *
 * `lift` below finds the end of a function by looking for a line containing
 * only `}`, spelled as a newline, a brace and a newline. On a Windows checkout
 * with `core.autocrlf=true` — the default, and what a fresh clone gets — every
 * line ends with a carriage return first, so that never matches and the whole
 * suite stopped on "could not find the end of cropGeometry" before reaching
 * anything else.
 *
 * Nothing was ever wrong with app.js: it is LF in the repository and converted
 * on the way out. Reading it the same way on every platform is the fix.
 */
const source = fs
  .readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8')
  .replace(/\r\n/g, '\n');

/** Lift a named function, and whatever follows it, into a bare context. */
function lift(names) {
  const context = { Math };
  vm.createContext(context);
  for (const name of names) {
    const from = source.indexOf(`function ${name}(`);
    assert.ok(from > 0, `${name} not found in public/app.js`);
    // Up to the blank line before the next top-level comment or function.
    const rest = source.slice(from);
    const end = rest.indexOf('\n}\n');
    assert.ok(end > 0, `could not find the end of ${name}`);
    vm.runInContext(rest.slice(0, end + 3), context);
  }
  return context;
}

const { cropGeometry, clampCropOffset } = lift([
  'cropGeometry',
  'clampCropOffset',
]);

// The product tile's frame, from CROP_SHAPES.landscape.
const VIEW_W = 320;
const VIEW_H = 180;

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.log(`FAIL  ${name}\n      ${e.message}`);
    process.exitCode = 1;
  }
}

console.log('Back office cropper\n');

// ---- The floor ------------------------------------------------------------

check('a tall picture can be zoomed out below the frame', () => {
  // A portrait bottle shot in a 16:9 tile — the case from the report.
  const { minZoom } = cropGeometry(1000, 2000, VIEW_W, VIEW_H);
  assert.ok(minZoom < 1, `minZoom was ${minZoom}, so it still cannot fit`);
});

check('zooming fully out shows the whole picture', () => {
  const imgW = 1000;
  const imgH = 2000;
  const { cover, minZoom } = cropGeometry(imgW, imgH, VIEW_W, VIEW_H);

  const scale = cover * minZoom;
  // Both sides inside the frame, give or take a rounding error.
  assert.ok(imgW * scale <= VIEW_W + 0.001, 'the width still overflows');
  assert.ok(imgH * scale <= VIEW_H + 0.001, 'the height still overflows');
  // And one of them touching it — "contain", not "shrunk to nothing".
  assert.ok(
    Math.abs(imgH * scale - VIEW_H) < 0.001 ||
      Math.abs(imgW * scale - VIEW_W) < 0.001,
    'it fits, but with slack on both sides'
  );
});

check('a wide panorama can be zoomed out a long way', () => {
  const { minZoom } = cropGeometry(4000, 1000, VIEW_W, VIEW_H);
  assert.ok(minZoom < 0.5, `minZoom was ${minZoom}`);
});

// The one case where there is genuinely nothing to zoom out to. It must come
// out as exactly 1 rather than as 0.9999-something, or the slider starts a
// hair below its own default and the picture looks subtly inset.
check('a picture already the frame’s shape has no room to zoom out', () => {
  const { minZoom } = cropGeometry(1600, 900, VIEW_W, VIEW_H);
  assert.strictEqual(minZoom, 1);
});

check('a square picture in a square frame is the same', () => {
  const { minZoom } = cropGeometry(512, 512, 320, 320);
  assert.strictEqual(minZoom, 1);
});

// ---- Cover still means cover ---------------------------------------------

// The default has not moved. Zoom 1 is still "fill the frame", so a manager who
// never touches the slider gets exactly the crop they got before this changed.
check('zoom 1 still fills the frame, on any shape', () => {
  for (const [w, h] of [[1000, 2000], [4000, 1000], [512, 512], [1600, 900]]) {
    const { cover } = cropGeometry(w, h, VIEW_W, VIEW_H);
    assert.ok(
      w * cover >= VIEW_W - 0.001 && h * cover >= VIEW_H - 0.001,
      `${w}x${h} left a gap at zoom 1`
    );
  }
});

// ---- Where it sits --------------------------------------------------------

check('a picture larger than the frame is pinned to it', () => {
  // Drawn 400 wide in a 320 frame, dragged 60px right: not allowed to expose
  // the left edge, so it pins at 0.
  assert.strictEqual(clampCropOffset(400, VIEW_W, 60), 0);
  // Dragged far left: pins at the right edge instead.
  assert.strictEqual(clampCropOffset(400, VIEW_W, -500), -80);
  // Somewhere legitimate in between is left alone.
  assert.strictEqual(clampCropOffset(400, VIEW_W, -40), -40);
});

check('a picture smaller than the frame is centred, not cornered', () => {
  // 200 wide in a 320 frame leaves 120 of clear space, half either side —
  // whatever the drag said. Before this, the old rule clamped it to 0 and the
  // fitted picture sat against the left edge looking like a bug.
  assert.strictEqual(clampCropOffset(200, VIEW_W, -999), 60);
  assert.strictEqual(clampCropOffset(200, VIEW_W, 999), 60);
  assert.strictEqual(clampCropOffset(200, VIEW_W, 0), 60);
});

check('a picture exactly the frame’s size sits flush', () => {
  assert.strictEqual(clampCropOffset(VIEW_W, VIEW_W, 37), 0);
});

console.log(`\n${passed} checks passed`);
