/**
 * Copy the Vesopa brand book's own typefaces into the built-in font catalogue.
 *
 * The brand package (`brand_assets/`) ships four families. Montserrat was
 * already here from the Google set; Orbitron, Michroma and Blinker were not,
 * and they are the ones that matter — the brand book names Orbitron and
 * Michroma as the display faces used for headlines, the logo and product names,
 * and Blinker as one of its two body faces.
 *
 * So a venue that wants its tills lettered the way the brand book letters
 * everything else picks them from the list, rather than being told to go and
 * find the files and upload them one weight at a time.
 *
 *   node tool/add_brand_fonts.js
 *
 * Re-running is a no-op for a family already in the catalogue. When the brand
 * package is updated, delete the family's directory and its catalogue entry and
 * run this again — which is why this is a script and not a one-off paste.
 *
 * Regular and bold only, and Michroma only has a regular. See the header of
 * tool/fetch_fonts.js for why a till gets two weights and not eleven, and
 * public/assets/fonts/LICENSES.md for the licences.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const BRAND = path.join(__dirname, '..', '..', 'brand_assets', 'Fonts');
const OUT = path.join(__dirname, '..', 'public', 'assets', 'fonts');

/** slug, display name, and [weight, path within the brand package]. */
const FAMILIES = [
  ['orbitron', 'Orbitron', [
    [400, 'Orbitron/Orbitron-Regular.ttf'],
    [700, 'Orbitron/Orbitron-Bold.ttf'],
  ]],
  ['michroma', 'Michroma', [
    [400, 'Michroma/Michroma-Regular.ttf'],
  ]],
  ['blinker', 'Blinker', [
    [400, 'Blinker/Blinker-Regular.ttf'],
    [700, 'Blinker/Blinker-Bold.ttf'],
  ]],
];

function main() {
  if (!fs.existsSync(BRAND)) {
    process.stderr.write(
      `The brand package is not here: ${BRAND}\n` +
        'It is not part of this repository — point BRAND at wherever the ' +
        'brand book was unpacked, or clone it beside this one.\n'
    );
    process.exit(1);
  }

  const cataloguePath = path.join(OUT, 'catalogue.json');
  const catalogue = JSON.parse(fs.readFileSync(cataloguePath, 'utf8'));
  const have = new Set(catalogue.map((f) => f.slug));

  let added = 0;
  for (const [slug, family, faces] of FAMILIES) {
    if (have.has(slug)) {
      process.stdout.write(`  ${family} is already in the catalogue\n`);
      continue;
    }

    const dir = path.join(OUT, slug);
    fs.mkdirSync(dir, { recursive: true });

    const entry = { slug, family, faces: [] };
    for (const [weight, rel] of faces) {
      const source = path.join(BRAND, rel);
      if (!fs.existsSync(source)) {
        process.stderr.write(`  missing: ${rel}\n`);
        process.exit(1);
      }
      const file = `${slug}-${weight}.ttf`;
      fs.copyFileSync(source, path.join(dir, file));
      const bytes = fs.statSync(path.join(dir, file)).size;
      entry.faces.push({ weight, file, bytes });
      process.stdout.write(
        `  ${family} ${weight}  ${(bytes / 1024).toFixed(0)} KB\n`
      );
    }

    catalogue.push(entry);
    added++;
  }

  if (added) {
    fs.writeFileSync(cataloguePath, `${JSON.stringify(catalogue, null, 2)}\n`);
  }
  process.stdout.write(
    `\n${catalogue.length} families in the catalogue` +
      (added ? ` (${added} added)\n` : '\n')
  );
}

main();
