/* A very small PDF writer.
 *
 * Enough to set type, rule lines and draw filled boxes on A4 — which is all an
 * invoice is. Deliberately not a library:
 *
 *   - Rendering HTML to PDF means headless Chrome, and there is no Chrome on
 *     the production box. `npm ci --omit=dev` does not install Playwright, and
 *     putting a browser on a shared multi-tenant server to typeset an invoice
 *     is a lot of attack surface for one page of text.
 *   - The alternative is a PDF library, and the two common ones are a few
 *     hundred kilobytes and a stack of transitive dependencies for a document
 *     that has no images, no tables to reflow and one font.
 *
 * PDF's text model is simple enough that this is ~150 lines: a catalogue, a
 * page, a content stream, and an xref table with byte offsets. The offsets are
 * the only fiddly part, and they are why this builds the file as a list of
 * buffers and measures as it goes rather than concatenating strings at the end.
 *
 * The 14 standard fonts need no embedding, so Helvetica is free and present in
 * every reader.
 */

const A4 = { w: 595.28, h: 841.89 };          // points, 72 per inch

/* PDF strings are Latin-1 (WinAnsi for the standard fonts). £ is 0xA3 there,
   and an unescaped ( ) or \ ends the string early and corrupts the file. */
function pdfString(s) {
  const text = String(s ?? "")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/ /g, " ")
    .replace(/[^\x20-\x7E -ÿ]/g, "?");
  return text.replace(/[\\()]/g, (c) => "\\" + c);
}

/** Helvetica advance widths, per 1000 units, for the ASCII range we use. */
const W = (() => {
  const t = new Array(256).fill(556);
  const set = (str, w) => { for (const ch of str) t[ch.charCodeAt(0)] = w; };
  set(" !\"#$%&'()*+,-./", 278); set("(", 333); set(")", 333);
  set("0123456789", 556);
  set(":;", 278); set("<=>", 584); set("?", 556); set("@", 1015);
  set("ABCDEFGHIJKLMNOPQRSTUVWXYZ", 667);
  set("IJ", 278); set("M", 833); set("W", 944);
  set("abcdefghijklmnopqrstuvwxyz", 556);
  set("fijlt", 278); set("mw", 833); set("r", 333); set("s", 500);
  set(".,", 278); set("-", 333); set("'", 191); set('"', 355);
  t[0xA3] = 556;                                   // £
  return t;
})();

/** Width of `text` at `size`, in points. Used for right-alignment. */
export function textWidth(text, size, bold = false) {
  let w = 0;
  for (const ch of String(text ?? "")) {
    const c = ch.charCodeAt(0);
    w += (W[c] ?? 556) * (bold ? 1.06 : 1);        // Helvetica-Bold runs wider
  }
  return (w / 1000) * size;
}

export function createPDF() {
  const ops = [];
  let fill = null;

  const setFill = (hex) => {
    if (fill === hex) return;
    fill = hex;
    const n = parseInt(hex.replace("#", ""), 16);
    const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
    ops.push(`${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} rg`);
  };

  const api = {
    W: A4.w, H: A4.h,

    /** Text at (x, y) measured from the TOP of the page, which is how anyone
     *  laying out a document thinks; PDF's origin is bottom-left. */
    text(x, y, str, { size = 10, bold = false, colour = "#000000", align = "left", width = 0 } = {}) {
      const s = pdfString(str);
      if (!s) return api;
      setFill(colour);
      let tx = x;
      if (align === "right") tx = x + width - textWidth(str, size, bold);
      else if (align === "center") tx = x + (width - textWidth(str, size, bold)) / 2;
      ops.push("BT", `/${bold ? "FB" : "FR"} ${size} Tf`,
        `1 0 0 1 ${tx.toFixed(2)} ${(A4.h - y).toFixed(2)} Tm`, `(${s}) Tj`, "ET");
      return api;
    },

    /** Wrap `str` into `width`, returning the y after the last line. */
    paragraph(x, y, str, { size = 10, leading = 13, width = 300, colour = "#000000" } = {}) {
      const words = String(str ?? "").split(/\s+/).filter(Boolean);
      let line = "", cy = y;
      for (const word of words) {
        const test = line ? line + " " + word : word;
        if (textWidth(test, size) > width && line) {
          api.text(x, cy, line, { size, colour });
          cy += leading; line = word;
        } else line = test;
      }
      if (line) { api.text(x, cy, line, { size, colour }); cy += leading; }
      return cy;
    },

    rule(x, y, w, { colour = "#CCCCCC", thickness = 0.6 } = {}) {
      const n = parseInt(colour.replace("#", ""), 16);
      ops.push("q", `${(((n >> 16) & 255) / 255).toFixed(3)} ${(((n >> 8) & 255) / 255).toFixed(3)} ${((n & 255) / 255).toFixed(3)} RG`,
        `${thickness} w`, `${x.toFixed(2)} ${(A4.h - y).toFixed(2)} m ${(x + w).toFixed(2)} ${(A4.h - y).toFixed(2)} l S`, "Q");
      return api;
    },

    box(x, y, w, h, colour = "#F2F2F2") {
      setFill(colour);
      ops.push(`${x.toFixed(2)} ${(A4.h - y - h).toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f`);
      return api;
    },

    /** Assemble the file. */
    end() {
      const stream = ops.join("\n");
      const objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4.w} ${A4.h}] `
          + `/Resources << /Font << /FR 5 0 R /FB 6 0 R >> >> /Contents 4 0 R >>`,
        `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`,
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
      ];

      const chunks = [];
      let offset = 0;
      const push = (s) => { const b = Buffer.from(s, "latin1"); chunks.push(b); offset += b.length; };

      push("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
      const xref = [];
      objects.forEach((body, i) => {
        xref.push(offset);
        push(`${i + 1} 0 obj\n${body}\nendobj\n`);
      });

      const startxref = offset;
      let table = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
      for (const o of xref) table += `${String(o).padStart(10, "0")} 00000 n \n`;
      push(table);
      push(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`);

      return Buffer.concat(chunks);
    },
  };
  return api;
}
