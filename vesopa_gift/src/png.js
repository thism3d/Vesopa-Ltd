/**
 * A QR code as a PNG, for email.
 *
 * WHY A PNG AND NOT THE SVG qr.js ALREADY DRAWS
 *
 * Gmail and Outlook both refuse SVG in a message, so a voucher's code has to
 * arrive as a raster image. There is no image library in this project and a
 * QR code does not need one: it is black and white squares, and a PNG of black
 * and white squares is a few chunks around one zlib stream.
 *
 * Eight-bit greyscale rather than one-bit: one-bit PNGs are smaller and are the
 * format a handful of mail clients render as solid black.
 */

const zlib = require('zlib');
const { encode } = require('./qr');

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/**
 * The matrix, `scale` pixels a module, with the four-module quiet zone every
 * scanner needs around the code.
 */
function qrPng(text, { scale = 8, quiet = 4 } = {}) {
  const { matrix } = encode(String(text));
  const n = matrix.length;
  const size = (n + quiet * 2) * scale;

  const raw = Buffer.alloc((size + 1) * size, 255);
  for (let y = 0; y < size; y++) {
    raw[y * (size + 1)] = 0; // filter: none
    const my = Math.floor(y / scale) - quiet;
    for (let x = 0; x < size; x++) {
      const mx = Math.floor(x / scale) - quiet;
      const dark = my >= 0 && my < n && mx >= 0 && mx < n && matrix[my][mx];
      raw[y * (size + 1) + 1 + x] = dark ? 0 : 255;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // greyscale
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** The matrix itself, for drawing into a PDF. */
function qrMatrix(text) {
  return encode(String(text)).matrix;
}

module.exports = { qrPng, qrMatrix, crc32 };
