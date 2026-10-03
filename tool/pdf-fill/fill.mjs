/**
 * Fill named text fields in a PDF and flatten them, so the values print and
 * show in every viewer (iPad Files and Outlook previews ignore live fields).
 *
 *     node fill.mjs <in.pdf> <out.pdf> field=ENV_NAME [field=ENV_NAME ...]
 *
 * Values come from the environment, never argv, so they stay out of the
 * process list and shell history. A field whose variable is empty is left as
 * a blank, fillable box.
 */
import fs from 'node:fs';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const [input, output, ...pairs] = process.argv.slice(2);
if (!input || !output || !pairs.length) {
  console.error('usage: node fill.mjs <in.pdf> <out.pdf> field=ENV_NAME ...');
  process.exit(1);
}
const doc = await PDFDocument.load(fs.readFileSync(input));
const form = doc.getForm();
const font = await doc.embedFont(StandardFonts.Courier);
let filled = 0;
const blank = [];
for (const pair of pairs) {
  const [field, env] = pair.split('=');
  const value = process.env[env] || '';
  if (!value) { blank.push(field); continue; }
  form.getTextField(field).setText(value);
  filled += 1;
}
form.updateFieldAppearances(font);
// Flatten only when every box is filled; a blank one stays fillable.
if (!blank.length) form.flatten();
fs.writeFileSync(output, await doc.save());
console.log(`filled ${filled} field(s)${blank.length ? `, left blank: ${blank.join(', ')}` : ''}`);
