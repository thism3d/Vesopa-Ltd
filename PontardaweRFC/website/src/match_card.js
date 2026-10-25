/**
 * The picture on an automatic match post (src/autonews.js): club red, the
 * crest, and the match in the club's lettering (Oswald, SIL Open Font
 * Licence, src/fonts/). 1200x630, the shape a shared link shows. Only the
 * club's own crest is drawn; other clubs' badges are theirs, so their names
 * are written instead.
 *
 *   card({ label: 'Full time', lines: ['Pontardawe RFC 18', 'Penlan RFC 67'], foot: '...' })
 */
'use strict';

const path = require('path');
const sharp = require('sharp');

const W = 1200;
const H = 630;
const FONT = (w) => path.join(__dirname, 'fonts', `Oswald-${w}.ttf`);
const CREST = path.join(__dirname, '..', 'public', 'img', 'crest-512.png');

const xml = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/** One line of text as a picture, at most `width` wide. */
async function line(text, { size, weight = 'Bold', color = '#ffffff', width = 760 }) {
  const img = sharp({
    text: {
      text: `<span foreground="${color}">${xml(text)}</span>`,
      font: `Oswald ${size}`,
      fontfile: FONT(weight),
      rgba: true,
      width,
    },
  });
  return { input: await img.png().toBuffer(), meta: await img.metadata() };
}

async function card({ label, lines, foot, size = null }) {
  const bg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8f0000"/><stop offset=".55" stop-color="#5a0000"/><stop offset="1" stop-color="#1e0202"/></linearGradient>
    <radialGradient id="r" cx=".85" cy="-.1" r=".9"><stop offset="0" stop-color="#e8312f" stop-opacity=".55"/><stop offset="1" stop-color="#e8312f" stop-opacity="0"/></radialGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#g)"/><rect width="${W}" height="${H}" fill="url(#r)"/>
  <g stroke="#ffffff" stroke-opacity=".07" stroke-width="34" fill="none">
    <path d="M-100 520 L1300 300"/><path d="M-100 610 L1300 390"/><path d="M-100 700 L1300 480"/>
  </g>
  <rect x="64" y="${H - 92}" width="${W - 128}" height="2" fill="#f2c14e" fill-opacity=".6"/>
</svg>`);
  const crest = await sharp(CREST).resize(300, 300, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
  const parts = [{ input: crest, left: W - 64 - 300, top: 110 }];
  const head = await line(String(label).toUpperCase(), { size: 30, weight: 'Medium', color: '#f2c14e' });
  parts.push({ input: head.input, left: 64, top: 70 });
  let y = 70 + head.meta.height + 26;
  for (const t of lines) {
    const l = await line(t.toUpperCase(), { size: size || (lines.length > 2 ? 52 : 64) });
    parts.push({ input: l.input, left: 64, top: y });
    y += l.meta.height + 10;
  }
  const f = await line(foot, { size: 24, weight: 'Medium', color: '#ffffff', width: W - 128 });
  parts.push({ input: f.input, left: 64, top: H - 72 });
  return sharp(bg).composite(parts).jpeg({ quality: 88, mozjpeg: true }).toBuffer();
}

module.exports = { card };
