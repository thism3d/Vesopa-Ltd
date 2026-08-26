/**
 * Fetch the built-in font catalogue from Google Fonts, once, into the repo.
 *
 * The tills download fonts from *this* back office, not from Google. A till in
 * a cellar bar has no route to fonts.gstatic.com and often no route anywhere at
 * all, and a button whose lettering depends on a CDN is a button that changes
 * shape when the broadband does. So the files are fetched here, committed, and
 * served from public/assets/fonts — the same origin the till already talks to.
 *
 * Regular and Bold only. A till button is a word on a colour; the eleven
 * intermediate weights of a variable family are eleven files nobody presses.
 *
 * Every family here is under the SIL Open Font License 1.1 (Bebas Neue, Fira
 * Sans, Inter, Lato, Manrope, Montserrat, Nunito, Oswald, Playfair Display,
 * Poppins, Raleway, Rubik, Source Sans 3, Work Sans) or the Apache License 2.0
 * (Roboto, Open Sans) — both of which permit redistribution, which is exactly
 * what serving them to a till is. The licence text travels with them in
 * public/assets/fonts/LICENSES.md.
 *
 *   node tool/fetch_fonts.js
 *
 * Re-running it overwrites what is there. It is not part of any build: the
 * files are in the tree so a deploy never depends on Google being up either.
 */

'use strict';

const fs = require('fs');
const path = require('path');

/** slug, family name as Google knows it, and which weights to take. */
const FAMILIES = [
  ['inter', 'Inter', [400, 700]],
  ['roboto', 'Roboto', [400, 700]],
  ['open-sans', 'Open Sans', [400, 700]],
  ['lato', 'Lato', [400, 700]],
  ['montserrat', 'Montserrat', [400, 700]],
  ['poppins', 'Poppins', [400, 700]],
  ['nunito', 'Nunito', [400, 700]],
  ['source-sans-3', 'Source Sans 3', [400, 700]],
  ['work-sans', 'Work Sans', [400, 700]],
  ['rubik', 'Rubik', [400, 700]],
  ['manrope', 'Manrope', [400, 700]],
  ['raleway', 'Raleway', [400, 700]],
  ['fira-sans', 'Fira Sans', [400, 700]],
  ['oswald', 'Oswald', [400, 700]],
  ['bebas-neue', 'Bebas Neue', [400]],
  ['playfair-display', 'Playfair Display', [400, 700]],
];

const OUT = path.join(__dirname, '..', 'public', 'assets', 'fonts');

// The default (old) user agent is what makes the API answer in TrueType rather
// than woff2. Flutter's FontLoader reads ttf and otf; it does not read woff2,
// so asking for the modern format would produce files the till cannot use.
const UA = 'Mozilla/5.0';

async function css(family, weights) {
  const url =
    'https://fonts.googleapis.com/css2?family=' +
    encodeURIComponent(family).replace(/%20/g, '+') +
    ':wght@' +
    weights.join(';');
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`${family}: css ${res.status}`);
  return res.text();
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const manifest = [];

  for (const [slug, family, weights] of FAMILIES) {
    const sheet = await css(family, weights);
    const dir = path.join(OUT, slug);
    fs.mkdirSync(dir, { recursive: true });

    const faces = [];
    // One @font-face block per weight, in the order asked for.
    const blocks = sheet.split('@font-face').slice(1);
    for (const block of blocks) {
      const weight = Number((block.match(/font-weight:\s*(\d+)/) || [])[1]);
      const src = (block.match(/url\((https:[^)]+)\)/) || [])[1];
      if (!weight || !src || !weights.includes(weight)) continue;
      if (faces.some((f) => f.weight === weight)) continue;

      const res = await fetch(src, { headers: { 'User-Agent': UA } });
      if (!res.ok) throw new Error(`${family} ${weight}: ${res.status}`);
      const bytes = Buffer.from(await res.arrayBuffer());
      const file = `${slug}-${weight}.ttf`;
      fs.writeFileSync(path.join(dir, file), bytes);
      faces.push({ weight, file, bytes: bytes.length });
      process.stdout.write(`  ${family} ${weight}  ${(bytes.length / 1024).toFixed(0)} KB\n`);
    }

    if (!faces.length) throw new Error(`${family}: no faces`);
    manifest.push({ slug, family, faces: faces.sort((a, b) => a.weight - b.weight) });
  }

  fs.writeFileSync(
    path.join(OUT, 'catalogue.json'),
    JSON.stringify(manifest, null, 2) + '\n'
  );
  const total = manifest.reduce(
    (n, f) => n + f.faces.reduce((m, x) => m + x.bytes, 0),
    0
  );
  process.stdout.write(
    `\n${manifest.length} families, ${(total / 1024 / 1024).toFixed(1)} MB\n`
  );
}

main().catch((e) => {
  process.stderr.write(String(e && e.stack ? e.stack : e) + '\n');
  process.exit(1);
});
