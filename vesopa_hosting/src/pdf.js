/**
 * A very small PDF writer — enough to produce an invoice, and nothing else.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS RATHER THAN A DEPENDENCY
 * ---------------------------------------------------------------------------
 * The two usual answers are both wrong for this app.
 *
 * Headless Chrome (which is how the EPOS order-plan PDFs are made) means
 * installing a browser on the hosting node and keeping it patched. That is
 * ~400MB and a permanent security surface, on a box whose entire job is serving
 * other people's websites, to render one page of text.
 *
 * A PDF library (pdfkit and friends) pulls a font stack and a stream toolchain
 * for the same one page, and would have to survive `npm ci` on a server that is
 * deployed by rsync.
 *
 * An invoice is text, horizontal rules, and a logo made of two triangles. The
 * PDF format renders all three with the fourteen fonts every reader has built
 * in, so nothing needs embedding and the output is a few kilobytes. This file
 * is the smallest thing that does that correctly.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT SUPPORTS, DELIBERATELY
 * ---------------------------------------------------------------------------
 * Helvetica and Helvetica-Bold, WinAnsi-encoded, at any size; text left, right
 * or centre aligned; filled rectangles; lines; and filled paths. That is the
 * whole vocabulary of an invoice. It is not a general PDF library and should
 * not grow into one — if something here needs images or tables spanning pages,
 * that is the moment to reach for a real dependency instead.
 *
 * ---------------------------------------------------------------------------
 * THE PART THAT IS EASY TO GET WRONG
 * ---------------------------------------------------------------------------
 * The xref table is byte offsets into the finished file. Every offset has to be
 * counted in BYTES, not characters, and an invoice carrying a "£" or a customer
 * called "Müller" is not ASCII. Everything below is assembled as Buffers and
 * measured with Buffer.byteLength for that reason; building it as a JavaScript
 * string and calling .length would produce a file that opens fine in a
 * forgiving reader and is rejected as corrupt by a strict one — which is the
 * worst kind of bug, because it works on your machine and fails at the
 * customer's accountant.
 */

// ---------------------------------------------------------------------------
// Font metrics
// ---------------------------------------------------------------------------

/*
 * Advance widths in 1/1000 em, from Adobe's AFM files for the standard 14.
 *
 * Needed because a right-aligned number has to be positioned by us: PDF has no
 * text alignment: it has "draw this string starting here". Without real metrics
 * the totals column would be ragged, which on an invoice reads as amateurish
 * before it reads as anything else.
 */
const HELVETICA = {
  32: 278, 33: 278, 34: 355, 35: 556, 36: 556, 37: 889, 38: 667, 39: 191,
  40: 333, 41: 333, 42: 389, 43: 584, 44: 278, 45: 333, 46: 278, 47: 278,
  48: 556, 49: 556, 50: 556, 51: 556, 52: 556, 53: 556, 54: 556, 55: 556,
  56: 556, 57: 556, 58: 278, 59: 278, 60: 584, 61: 584, 62: 584, 63: 556,
  64: 1015, 65: 667, 66: 667, 67: 722, 68: 722, 69: 667, 70: 611, 71: 778,
  72: 722, 73: 278, 74: 500, 75: 667, 76: 556, 77: 833, 78: 722, 79: 778,
  80: 667, 81: 778, 82: 722, 83: 667, 84: 611, 85: 722, 86: 667, 87: 944,
  88: 667, 89: 667, 90: 611, 91: 278, 92: 278, 93: 278, 94: 469, 95: 556,
  96: 333, 97: 556, 98: 556, 99: 500, 100: 556, 101: 556, 102: 278, 103: 556,
  104: 556, 105: 222, 106: 222, 107: 500, 108: 222, 109: 833, 110: 556,
  111: 556, 112: 556, 113: 556, 114: 333, 115: 500, 116: 278, 117: 556,
  118: 500, 119: 722, 120: 500, 121: 500, 122: 500, 123: 334, 124: 260,
  125: 334, 126: 584,
  // WinAnsi upper range, only the ones an invoice can actually contain.
  128: 556, 145: 222, 146: 222, 147: 333, 148: 333, 150: 556, 151: 1000,
  163: 556, 169: 737, 174: 737, 176: 400, 233: 556, 246: 556, 252: 556,
};

const HELVETICA_BOLD = {
  32: 278, 33: 333, 34: 474, 35: 556, 36: 556, 37: 889, 38: 722, 39: 238,
  40: 333, 41: 333, 42: 389, 43: 584, 44: 278, 45: 333, 46: 278, 47: 278,
  48: 556, 49: 556, 50: 556, 51: 556, 52: 556, 53: 556, 54: 556, 55: 556,
  56: 556, 57: 556, 58: 333, 59: 333, 60: 584, 61: 584, 62: 584, 63: 611,
  64: 975, 65: 722, 66: 722, 67: 722, 68: 722, 69: 667, 70: 611, 71: 778,
  72: 722, 73: 278, 74: 556, 75: 722, 76: 611, 77: 833, 78: 722, 79: 778,
  80: 667, 81: 778, 82: 722, 83: 667, 84: 611, 85: 722, 86: 667, 87: 944,
  88: 667, 89: 667, 90: 611, 91: 333, 92: 278, 93: 333, 94: 584, 95: 556,
  96: 333, 97: 556, 98: 611, 99: 556, 100: 611, 101: 556, 102: 333, 103: 611,
  104: 611, 105: 278, 106: 278, 107: 556, 108: 278, 109: 889, 110: 611,
  111: 611, 112: 611, 113: 611, 114: 389, 115: 556, 116: 333, 117: 611,
  118: 556, 119: 778, 120: 556, 121: 556, 122: 500, 123: 389, 124: 280,
  125: 389, 126: 584,
  128: 556, 145: 278, 146: 278, 147: 500, 148: 500, 150: 556, 151: 1000,
  163: 556, 169: 737, 174: 737, 176: 400, 233: 556, 246: 611, 252: 611,
};

/**
 * Unicode into the WinAnsiEncoding byte a PDF viewer expects.
 *
 * Only the characters an invoice realistically carries. Anything unmapped
 * becomes '?' rather than a random glyph — a wrong character is confusing, but
 * a byte the encoding does not define can render as anything at all, including
 * nothing, which silently drops part of somebody's name.
 */
const WIN_ANSI = {
  0x20AC: 128, 0x2018: 145, 0x2019: 146, 0x201C: 147, 0x201D: 148,
  0x2013: 150, 0x2014: 151, 0x00A3: 163, 0x00A9: 169, 0x00AE: 174,
  0x00B0: 176,
};

function toWinAnsi(str) {
  const out = [];
  for (const ch of String(str == null ? '' : str)) {
    const cp = ch.codePointAt(0);
    if (cp >= 32 && cp <= 126) out.push(cp);
    else if (WIN_ANSI[cp]) out.push(WIN_ANSI[cp]);
    else if (cp >= 160 && cp <= 255) out.push(cp); // Latin-1 agrees with WinAnsi here
    else out.push(63); // '?'
  }
  return out;
}

/** Width of `text` at `size`, in points. */
function widthOf(text, size, bold = false) {
  const table = bold ? HELVETICA_BOLD : HELVETICA;
  let units = 0;
  for (const b of toWinAnsi(text)) units += table[b] ?? 556;
  return (units * size) / 1000;
}

/**
 * A PDF string literal: WinAnsi bytes with \ ( ) escaped.
 *
 * Built as a Buffer because the bytes above 127 are not valid UTF-8 sequences —
 * round-tripping them through a JS string and encoding as UTF-8 would turn one
 * byte into two and corrupt every "£" in the document.
 */
function pdfString(text) {
  const bytes = [0x28]; // (
  for (const b of toWinAnsi(text)) {
    if (b === 0x28 || b === 0x29 || b === 0x5C) bytes.push(0x5C);
    bytes.push(b);
  }
  bytes.push(0x29); // )
  return Buffer.from(bytes);
}

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

/** A4 in PostScript points, which is the unit PDF works in. */
const A4 = { width: 595.28, height: 841.89 };

class Pdf {
  constructor({ title = '', author = 'Vesopa Software Ltd' } = {}) {
    this.ops = [];
    this.title = title;
    this.author = author;
    this.width = A4.width;
    this.height = A4.height;
  }

  /*
   * PDF's origin is the BOTTOM-left corner and y grows upward, which is upside
   * down from how anybody lays out a page. Every method here takes y measured
   * DOWN FROM THE TOP and flips it once, at the boundary, so the calling code
   * reads like the page looks.
   */
  #y(y) { return this.height - y; }

  text(str, x, y, { size = 10, bold = false, align = 'left', color = '#111111' } = {}) {
    const s = String(str == null ? '' : str);
    if (!s) return this;
    let tx = x;
    if (align === 'right') tx = x - widthOf(s, size, bold);
    else if (align === 'center') tx = x - widthOf(s, size, bold) / 2;

    const [r, g, b] = hexRgb(color);
    this.ops.push(Buffer.from(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${r} ${g} ${b} rg ${round(tx)} ${round(this.#y(y))} Td `));
    this.ops.push(pdfString(s));
    this.ops.push(Buffer.from(' Tj ET\n'));
    return this;
  }

  /** Wrap `str` to `maxWidth` and draw it, returning the y after the last line. */
  paragraph(str, x, y, maxWidth, { size = 10, bold = false, leading = 1.45, color = '#111111' } = {}) {
    const words = String(str || '').split(/\s+/).filter(Boolean);
    const lineHeight = size * leading;
    let line = '';
    let cursor = y;
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (widthOf(next, size, bold) > maxWidth && line) {
        this.text(line, x, cursor, { size, bold, color });
        cursor += lineHeight;
        line = word;
      } else {
        line = next;
      }
    }
    if (line) { this.text(line, x, cursor, { size, bold, color }); cursor += lineHeight; }
    return cursor;
  }

  line(x1, y1, x2, y2, { width = 0.75, color = '#e1e3da' } = {}) {
    const [r, g, b] = hexRgb(color);
    this.ops.push(Buffer.from(
      `${r} ${g} ${b} RG ${width} w ${round(x1)} ${round(this.#y(y1))} m ${round(x2)} ${round(this.#y(y2))} l S\n`,
    ));
    return this;
  }

  rect(x, y, w, h, { color = '#f8f9f4' } = {}) {
    const [r, g, b] = hexRgb(color);
    this.ops.push(Buffer.from(
      `${r} ${g} ${b} rg ${round(x)} ${round(this.#y(y + h))} ${round(w)} ${round(h)} re f\n`,
    ));
    return this;
  }

  /**
   * The Vesopa V, drawn rather than embedded.
   *
   * The same two paths as public/assets/img/brand/mark.svg, on the same
   * 100x70 grid, scaled and flipped into PDF's coordinate space. Drawing it
   * means the logo is vector, weighs nothing, and cannot be the wrong file.
   */
  mark(x, y, h, { ink = '#111111' } = {}) {
    const s = h / 70;
    const px = (vx) => round(x + vx * s);
    const py = (vy) => round(this.#y(y + vy * s));
    const path = (pts, color) => {
      const [r, g, b] = hexRgb(color);
      const [first, ...rest] = pts;
      this.ops.push(Buffer.from(
        `${r} ${g} ${b} rg ${px(first[0])} ${py(first[1])} m `
        + rest.map(([vx, vy]) => `${px(vx)} ${py(vy)} l `).join('')
        + 'h f\n',
      ));
    };
    path([[0, 0], [22.7, 0], [50.7, 49], [77.3, 0], [100, 0], [62, 70], [40, 70]], '#a5c715');
    path([[58.3, 35], [81, 35], [62, 70], [40, 70], [50.7, 49]], ink);
    return this;
  }

  /** Assemble the file. */
  build() {
    const content = Buffer.concat(this.ops);

    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${round(this.width)} ${round(this.height)}] `
        + '/Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>',
      null, // 4: the content stream, spliced in as bytes below
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
      null, // 7: Info, spliced in for the same reason (the title may be non-ASCII)
    ];

    const chunks = [Buffer.from('%PDF-1.4\n')];
    // A binary comment line marks the file as binary for tools that sniff it.
    chunks.push(Buffer.from([0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A]));

    const offsets = [];
    let position = chunks.reduce((n, c) => n + c.length, 0);

    objects.forEach((body, i) => {
      const num = i + 1;
      offsets[num] = position;
      let buf;
      if (num === 4) {
        buf = Buffer.concat([
          Buffer.from(`4 0 obj\n<< /Length ${content.length} >>\nstream\n`),
          content,
          Buffer.from('\nendstream\nendobj\n'),
        ]);
      } else if (num === 7) {
        buf = Buffer.concat([
          Buffer.from('7 0 obj\n<< /Title '),
          pdfString(this.title),
          Buffer.from(' /Author '),
          pdfString(this.author),
          Buffer.from(` /Producer ${'(Vesopa Cloud Hosting)'} /CreationDate (D:${pdfDate()}) >>\nendobj\n`),
        ]);
      } else {
        buf = Buffer.from(`${num} 0 obj\n${body}\nendobj\n`);
      }
      chunks.push(buf);
      position += buf.length;
    });

    const xrefAt = position;
    let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (let n = 1; n <= objects.length; n += 1) {
      xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
    }
    xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 7 0 R >>\n`
      + `startxref\n${xrefAt}\n%%EOF\n`;
    chunks.push(Buffer.from(xref));

    return Buffer.concat(chunks);
  }
}

function round(n) { return Math.round(Number(n) * 100) / 100; }

/** '#a5c715' into the 0–1 triple PDF wants. */
function hexRgb(hex) {
  const h = String(hex).replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [
    round(((n >> 16) & 255) / 255),
    round(((n >> 8) & 255) / 255),
    round((n & 255) / 255),
  ];
}

function pdfDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`
    + `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

module.exports = { Pdf, widthOf, A4 };
