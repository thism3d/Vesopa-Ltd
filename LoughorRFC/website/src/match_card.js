/**
 * The picture on a post with no photo of its own, and on an automatic match
 * post (src/autonews.js): a programme page, the same look as the site (cream
 * paper, a double frame, navy Fraunces title, gold small capitals) with the
 * club's crest. 1200x630, the shape a shared link shows. Only the club's own
 * crest is drawn; other clubs' badges are theirs, so their names are written.
 *
 *   card({ label: 'Full time', lines: ['Loughor RFC 18', 'Penlan RFC 67'], foot: '...' })
 *
 * The fonts are static cuts of the site's own (src/fonts/, SIL Open Font
 * Licence), made from public/fonts/ with fontTools.
 */
'use strict';

const path = require('path');
const sharp = require('sharp');

const W = 1200;
const H = 630;
const FONTS = {
  title: { file: path.join(__dirname, 'fonts', 'Fraunces-SemiBold.ttf'), family: 'Fraunces' },
  italic: { file: path.join(__dirname, 'fonts', 'Fraunces-Italic.ttf'), family: 'Fraunces Italic' },
  small: { file: path.join(__dirname, 'fonts', 'SourceSans3-SemiBold.ttf'), family: 'Source Sans 3' },
};
const CREST = path.join(__dirname, '..', 'public', 'img', 'crest-512.png');
const NAVY = '#0b1a44';
const GOLD = '#b8901c';

const xml = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/** One line of text as a picture, at most `width` wide. */
async function line(text, { size, face = 'title', color = NAVY, width = 720, spacing = 0 }) {
  const f = FONTS[face];
  const img = sharp({
    text: {
      text: `<span foreground="${color}"${spacing ? ` letter_spacing="${spacing * 1024}"` : ''}>${xml(text)}</span>`,
      font: `${f.family} ${size}`,
      fontfile: f.file,
      rgba: true,
      width,
    },
  });
  return { input: await img.png().toBuffer(), meta: await img.metadata() };
}

async function card({ label, lines, foot, size = null }) {
  const bg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="#f6f0e1"/>
  <rect x="0" y="0" width="${W}" height="12" fill="${NAVY}"/><rect x="0" y="${H - 12}" width="${W}" height="12" fill="${NAVY}"/>
  <rect x="24" y="24" width="${W - 48}" height="${H - 48}" fill="none" stroke="#cdbd94" stroke-width="2"/>
  <rect x="36" y="36" width="${W - 72}" height="${H - 72}" fill="none" stroke="#cdbd94" stroke-width="1"/>
  <rect x="80" y="${H - 108}" width="150" height="3" fill="${GOLD}"/>
</svg>`);
  const crest = await sharp(CREST).resize(320, 320, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
  const parts = [{ input: crest, left: W - 80 - 320, top: (H - 320) / 2 }];
  const head = await line(String(label).toUpperCase(), { size: 22, face: 'small', color: GOLD, spacing: 3 });
  parts.push({ input: head.input, left: 84, top: 92 });
  let y = 92 + head.meta.height + 26;
  for (const t of lines) {
    const l = await line(t, { size: size || (lines.length > 2 ? 46 : 58) });
    parts.push({ input: l.input, left: 80, top: y });
    y += l.meta.height + 8;
  }
  const f = await line(foot, { size: 24, face: 'italic', color: '#3c4566', width: 680 });
  parts.push({ input: f.input, left: 84, top: H - 90 });
  return sharp(bg).composite(parts).jpeg({ quality: 88, mozjpeg: true }).toBuffer();
}

module.exports = { card };
