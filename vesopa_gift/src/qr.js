/**
 * A QR encoder, in about two hundred lines.
 *
 * WHY THIS IS HERE AND NOT A DEPENDENCY
 *
 * The back office has to show a code a customer can point a phone at, and there
 * is no QR library anywhere in this project's dependency tree. The two Flutter
 * applications each have one — Dart's `qr` package — so this exists to give the
 * *browser* the same capability the till and the customer display already have.
 *
 * Byte mode only, and that is the whole scope: every code this produces is a
 * URL. Numeric and alphanumeric modes pack tighter, kanji mode exists, and none
 * of them would ever be reached.
 *
 * HOW IT IS CHECKED
 *
 * Against Dart's `qr` package, module for module, in `test/qr.test.js`. Two
 * independent implementations agreeing on the exact bit pattern for the same
 * input is a far stronger statement than any structural assertion about finder
 * patterns — and it is the reason a QR encoder written by hand is a reasonable
 * thing to have here rather than a liability.
 */

// ---------------------------------------------------------------------------
// Galois field arithmetic, GF(256) with the QR primitive 0x11d.
// ---------------------------------------------------------------------------

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** The generator polynomial for `degree` error-correction codewords. */
function generator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= mul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/** Reed-Solomon remainder: the error-correction codewords for one block. */
function ecc(data, count) {
  const gen = generator(count);
  const out = new Array(count).fill(0);
  for (const byte of data) {
    const factor = byte ^ out[0];
    out.shift();
    out.push(0);
    if (factor !== 0) {
      for (let i = 0; i < count; i++) out[i] ^= mul(gen[i + 1], factor);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Version tables
// ---------------------------------------------------------------------------

/**
 * Per version (1-based): total codewords, then for level L the
 * error-correction codewords per block and the block counts.
 *
 * Level L only. A wallet QR is shown on a bright screen at close range, where
 * the redundancy of a higher level buys nothing and costs modules — and more
 * modules in the same physical space is a code that scans *worse*.
 */
const VERSIONS = [
  // [totalCodewords, eccPerBlock, group1Blocks, group2Blocks]
  [26, 7, 1, 0],
  [44, 10, 1, 0],
  [70, 15, 1, 0],
  [100, 20, 1, 0],
  [134, 26, 1, 0],
  [172, 18, 2, 0],
  [196, 20, 2, 0],
  [242, 24, 2, 0],
  [292, 30, 2, 0],
  [346, 18, 2, 2],
  [404, 20, 4, 0],
  [466, 24, 2, 2],
  [532, 26, 4, 0],
  [581, 30, 3, 1],
  [655, 22, 5, 1],
  [733, 24, 5, 1],
  [815, 28, 1, 5],
  [901, 30, 5, 1],
  [991, 28, 3, 4],
  [1085, 28, 3, 5],
];

/** Where the alignment pattern centres are, per version. */
const ALIGNMENT = [
  [], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
  [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50], [6, 30, 54],
  [6, 32, 58], [6, 34, 62], [6, 26, 46, 66], [6, 26, 48, 70],
  [6, 26, 50, 74], [6, 30, 54, 78], [6, 30, 56, 82], [6, 30, 58, 86],
  [6, 34, 62, 90],
];

const size = (version) => version * 4 + 17;

/** Data codewords available at a version, once error correction is removed. */
function capacity(version) {
  const [total, eccCount, g1, g2] = VERSIONS[version - 1];
  return total - eccCount * (g1 + g2);
}

/** The smallest version that fits `bytes` in byte mode. */
function versionFor(byteLength) {
  for (let v = 1; v <= VERSIONS.length; v++) {
    // 4 bits of mode, then the length: 8 bits below version 10, 16 above.
    const lengthBits = v < 10 ? 8 : 16;
    const needed = Math.ceil((4 + lengthBits + byteLength * 8) / 8);
    if (needed <= capacity(v)) return v;
  }
  throw new Error(`${byteLength} bytes is too long for a QR code`);
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

function codewords(text, version) {
  const bytes = Buffer.from(text, 'utf8');
  const bits = [];
  const push = (value, count) => {
    for (let i = count - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };

  push(0b0100, 4); // byte mode
  push(bytes.length, version < 10 ? 8 : 16);
  for (const byte of bytes) push(byte, 8);

  const total = capacity(version) * 8;
  // Terminator, up to four zero bits, then pad to a byte boundary.
  for (let i = 0; i < 4 && bits.length < total; i++) bits.push(0);
  while (bits.length % 8) bits.push(0);

  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    data.push(bits.slice(i, i + 8).reduce((n, b) => (n << 1) | b, 0));
  }
  // The two pad bytes the specification names, alternating.
  const PAD = [0xec, 0x11];
  for (let i = 0; data.length < capacity(version); i++) data.push(PAD[i % 2]);

  return interleave(data, version);
}

/**
 * Split into blocks, compute error correction, and interleave.
 *
 * The interleaving is what makes a QR survive a thumb over one corner: a burst
 * of damage lands across many blocks rather than destroying one, and each block
 * can then be repaired independently.
 */
function interleave(data, version) {
  const [, eccCount, g1, g2] = VERSIONS[version - 1];
  const blocks = g1 + g2;
  const shortLength = Math.floor(data.length / blocks);

  const dataBlocks = [];
  const eccBlocks = [];
  let at = 0;
  for (let i = 0; i < blocks; i++) {
    // The longer blocks come last, and carry exactly one extra codeword.
    const length = i < g1 ? shortLength : shortLength + 1;
    const block = data.slice(at, at + length);
    at += length;
    dataBlocks.push(block);
    eccBlocks.push(ecc(block, eccCount));
  }

  const out = [];
  const longest = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < longest; i++) {
    for (const block of dataBlocks) if (i < block.length) out.push(block[i]);
  }
  for (let i = 0; i < eccCount; i++) {
    for (const block of eccBlocks) out.push(block[i]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

function blank(version) {
  const n = size(version);
  return {
    modules: Array.from({ length: n }, () => new Array(n).fill(null)),
    reserved: Array.from({ length: n }, () => new Array(n).fill(false)),
    n,
  };
}

function place(grid, row, col, value, reserve = true) {
  if (row < 0 || col < 0 || row >= grid.n || col >= grid.n) return;
  grid.modules[row][col] = value;
  if (reserve) grid.reserved[row][col] = true;
}

function finder(grid, row, col) {
  for (let r = -1; r <= 7; r++) {
    for (let c = -1; c <= 7; c++) {
      const inside =
        (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
        (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
        (r >= 2 && r <= 4 && c >= 2 && c <= 4);
      place(grid, row + r, col + c, inside);
    }
  }
}

function patterns(grid, version) {
  const n = grid.n;
  finder(grid, 0, 0);
  finder(grid, 0, n - 7);
  finder(grid, n - 7, 0);

  // Timing.
  for (let i = 8; i < n - 8; i++) {
    place(grid, 6, i, i % 2 === 0);
    place(grid, i, 6, i % 2 === 0);
  }

  // Alignment, skipping the three corners the finders already own.
  const centres = ALIGNMENT[version];
  for (const r of centres) {
    for (const c of centres) {
      const corner =
        (r <= 8 && c <= 8) || (r <= 8 && c >= n - 9) || (r >= n - 9 && c <= 8);
      if (corner) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const on = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
          place(grid, r + dr, c + dc, on);
        }
      }
    }
  }

  // The dark module is deliberately *not* set here. It is written by
  // [applyFormat] along with the fifteen format bits, because the mask is
  // scored before any of them exist — see the note in [encode].

  // Format information areas, reserved now and filled once the mask is chosen.
  for (let i = 0; i < 9; i++) {
    if (grid.modules[8][i] === null) place(grid, 8, i, false);
    if (grid.modules[i][8] === null) place(grid, i, 8, false);
  }
  for (let i = 0; i < 8; i++) {
    if (grid.modules[8][n - 1 - i] === null) place(grid, 8, n - 1 - i, false);
    if (grid.modules[n - 1 - i][8] === null) place(grid, n - 1 - i, 8, false);
  }

  // Version information, from version 7 up.
  if (version >= 7) {
    const bits = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const on = ((bits >> i) & 1) === 1;
      place(grid, Math.floor(i / 3), n - 11 + (i % 3), on);
      place(grid, n - 11 + (i % 3), Math.floor(i / 3), on);
    }
  }
}

function versionBits(version) {
  let remainder = version << 12;
  for (let i = 0; i < 6; i++) {
    if (remainder & (1 << (17 - i))) remainder ^= 0x1f25 << (5 - i);
  }
  return (version << 12) | remainder;
}

/** Zig-zag the data up and down the columns, skipping what is reserved. */
function fill(grid, data) {
  const n = grid.n;
  let bit = 0;
  let up = true;

  for (let right = n - 1; right > 0; right -= 2) {
    if (right === 6) right = 5; // the vertical timing column is not a data column
    for (let step = 0; step < n; step++) {
      const row = up ? n - 1 - step : step;
      for (const col of [right, right - 1]) {
        if (grid.reserved[row][col]) continue;
        const byte = data[bit >> 3];
        const on = byte !== undefined && ((byte >> (7 - (bit & 7))) & 1) === 1;
        grid.modules[row][col] = on;
        bit++;
      }
    }
    up = !up;
  }
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function formatBits(mask) {
  // Level L is 01 in the two high bits.
  const data = (0b01 << 3) | mask;
  let remainder = data << 10;
  for (let i = 0; i < 5; i++) {
    if (remainder & (1 << (14 - i))) remainder ^= 0x537 << (4 - i);
  }
  return ((data << 10) | remainder) ^ 0x5412;
}

function applyFormat(grid, mask) {
  const bits = formatBits(mask);
  const n = grid.n;

  for (let i = 0; i < 15; i++) {
    // **Most significant bit first.** The specification numbers these 14 down
    // to 0 and places bit 14 at the start of each run, so `i` here is a
    // position and not a bit index. Getting this backwards produces a code
    // whose data region is perfect and which no scanner will read, because the
    // fifteen bits saying which mask was used come out mirrored.
    const on = ((bits >> (14 - i)) & 1) === 1;

    // Copy one, wrapped around the top-left finder.
    if (i < 6) grid.modules[8][i] = on;
    else if (i === 6) grid.modules[8][7] = on;
    else if (i === 7) grid.modules[8][8] = on;
    else if (i === 8) grid.modules[7][8] = on;
    else grid.modules[14 - i][8] = on;

    // Copy two, split between the bottom-left and top-right finders. Seven
    // modules go down the left edge and the remaining eight along the top —
    // not eight and seven, which is the easy mistake and shifts every module
    // in the second half by one.
    if (i < 7) grid.modules[n - 1 - i][8] = on;
    else grid.modules[8][n - 15 + i] = on;
  }

  // The dark module. Always set, always here, and not part of the format bits.
  grid.modules[n - 8][8] = true;
}

/**
 * How hard a masked code is to read. Lower is better.
 *
 * WHY THIS FOLLOWS `qr.dart` AND NOT THE SPECIFICATION EXACTLY
 *
 * The published rules and the implementation almost everybody actually uses —
 * Kazuhiko Arase's, which `qr.dart` is a port of — differ in the first rule:
 * the specification scores runs of five or more same-coloured modules, and his
 * scores each module by how many of its eight neighbours match it. They pick
 * the same mask most of the time and not always.
 *
 * Matching the one the rest of this product uses is worth more than matching
 * the document. The till and the customer display both draw their codes with
 * `qr.dart`, so following it here means all three surfaces produce a
 * byte-identical QR for the same payload — and it means `test/qr.test.js` can
 * assert that, mask choice included, instead of having to excuse a difference.
 *
 * Both variants produce codes any scanner reads. This is not a correctness
 * question; it is a "two implementations should not disagree" question.
 */
function penalty(m) {
  const n = m.length;
  let score = 0;

  // Rule 1: how much each module looks like its neighbours.
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      let same = 0;
      const dark = m[row][col];
      for (let r = -1; r <= 1; r++) {
        if (row + r < 0 || row + r >= n) continue;
        for (let c = -1; c <= 1; c++) {
          if (col + c < 0 || col + c >= n) continue;
          if (r === 0 && c === 0) continue;
          if (dark === m[row + r][col + c]) same++;
        }
      }
      if (same > 5) score += 3 + same - 5;
    }
  }

  // Rule 2: solid two-by-two blocks.
  for (let row = 0; row < n - 1; row++) {
    for (let col = 0; col < n - 1; col++) {
      let count = 0;
      if (m[row][col]) count++;
      if (m[row + 1][col]) count++;
      if (m[row][col + 1]) count++;
      if (m[row + 1][col + 1]) count++;
      if (count === 0 || count === 4) score += 3;
    }
  }

  // Rule 3: anything in the data that looks like a finder pattern, which is
  // what would send a scanner hunting for a corner that is not there.
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n - 6; col++) {
      if (
        m[row][col] && !m[row][col + 1] && m[row][col + 2] &&
        m[row][col + 3] && m[row][col + 4] && !m[row][col + 5] &&
        m[row][col + 6]
      ) {
        score += 40;
      }
    }
  }
  for (let col = 0; col < n; col++) {
    for (let row = 0; row < n - 6; row++) {
      if (
        m[row][col] && !m[row + 1][col] && m[row + 2][col] &&
        m[row + 3][col] && m[row + 4][col] && !m[row + 5][col] &&
        m[row + 6][col]
      ) {
        score += 40;
      }
    }
  }

  // Rule 4: how far from half the code is dark. A code that is nearly all one
  // colour has little for a camera to lock onto.
  let dark = 0;
  for (const row of m) for (const v of row) if (v) dark++;
  const ratio = Math.abs((100 * dark) / n / n - 50) / 5;

  return score + ratio * 10;
}

/**
 * The module matrix for `text`: `true` is a dark square.
 *
 * The mask is chosen by trying all eight and keeping the lowest penalty, which
 * is what the specification says to do and what stops a code with an unlucky
 * pattern in it from being hard to scan.
 */
function encode(text, forceMask = null) {
  const bytes = Buffer.from(String(text), 'utf8');
  const version = versionFor(bytes.length);
  const data = codewords(String(text), version);

  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    if (forceMask !== null && mask !== forceMask) continue;

    const grid = blank(version);
    patterns(grid, version);
    fill(grid, data);

    for (let r = 0; r < grid.n; r++) {
      for (let c = 0; c < grid.n; c++) {
        if (!grid.reserved[r][c] && MASKS[mask](r, c)) {
          grid.modules[r][c] = !grid.modules[r][c];
        }
      }
    }

    // **Scored before the format bits are written**, with those sixteen
    // modules — the fifteen format ones and the dark module — still light.
    //
    // That is not an optimisation, it is what the reference implementation
    // does, and on a small code it changes the answer: at version 1 those
    // modules are thirty-one of four hundred and forty-one, which is enough to
    // reorder the masks. Scoring the finished matrix instead picks a different
    // mask for short payloads — still a perfectly readable code, but a
    // different one from the till's and the display's for the same input.
    const score = penalty(grid.modules.map((row) => row.map(Boolean)));

    if (!best || score < best.score) {
      applyFormat(grid, mask);
      best = {
        score,
        matrix: grid.modules.map((row) => row.map(Boolean)),
        version,
        mask,
      };
    }
  }

  return best;
}

/**
 * `text` as an SVG.
 *
 * One `<path>` of squares rather than one `<rect>` per module: a version 6 code
 * is over a thousand modules, and a thousand elements in the DOM for something
 * shown beside a table row is a page that scrolls badly.
 *
 * The quiet zone is not optional. Four modules of margin is what the
 * specification requires and what a camera needs to find the code at all — a
 * QR butted against a coloured background is one that will not scan, and it is
 * the single most common way a hand-made QR fails.
 */
function svg(text, { size: pixels = 220, dark = '#111111', light = '#ffffff' } = {}) {
  const { matrix } = encode(text);
  const n = matrix.length;
  const quiet = 4;
  const span = n + quiet * 2;

  let path = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (matrix[r][c]) path += `M${c + quiet} ${r + quiet}h1v1h-1z`;
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${pixels}" height="${pixels}" ` +
    `viewBox="0 0 ${span} ${span}" shape-rendering="crispEdges" role="img" ` +
    `aria-label="QR code">` +
    `<rect width="${span}" height="${span}" fill="${light}"/>` +
    `<path d="${path}" fill="${dark}"/>` +
    `</svg>`
  );
}

module.exports = { encode, svg, versionFor, capacity, crcFree: true };
