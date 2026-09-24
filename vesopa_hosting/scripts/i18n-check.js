/**
 * Is the Bangla finished, and is it safe?
 *
 *     npm run i18n:check
 *
 * src/i18n says this check, not the code, is what "complete" means. It fails
 * the build on four things, in the order they cost a customer something:
 *
 *   MISSING      a string with no Bangla. The page still works — it falls back
 *                to English — which is exactly why nobody notices, and why it
 *                has to fail here instead.
 *   PLACEHOLDER  {name} in the English and not in the Bangla, or the other way
 *                about. A dropped placeholder prints a sentence with a hole in
 *                it; an invented one prints a literal "{days}" to a customer.
 *   MARKUP       a <tag> in one and not the other. These strings are printed
 *                with <%- %>, so an unbalanced tag breaks the page around it.
 *   TWICE        one English string with two different Banglas, in two files.
 *                The loader picks whichever sorts last, so the page you are
 *                looking at is not the one you edited.
 *   NOT SERVED   a string a browser script shows that is not in client.json.
 *                This is the one placement mistake nothing else catches:
 *                `clientMessages` serves ONLY client.json, but the extractor
 *                leaves a key in whichever file it is already in — so a string
 *                that was server-side first and later became a VT.t() call is
 *                translated, passes every other check here, and is still
 *                English in the browser. Measured: "Add it" did exactly that.
 *
 * It also reports, without failing, strings that are still English on purpose
 * (a brand name, a TLD) so that "untranslated" and "deliberately English" are
 * different things rather than the same silence.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const norm = (s) => String(s).replace(/\s+/g, ' ').trim();

/*
 * Every language but the one the source is written in, from src/i18n — a
 * language added there is checked here without an edit. One on the command
 * line does just that one: `npm run i18n:check -- bn`.
 */
const { LOCALES, DEFAULT_LOCALE } = require('../src/i18n');
const asked = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const TARGETS = (asked.length ? asked : Object.keys(LOCALES))
  .filter((code) => LOCALES[code] && code !== DEFAULT_LOCALE);

/*
 * The extractor is the one place that knows where strings live, so this runs
 * it (writing nothing) rather than keeping a second copy of that list.
 */
let report = '';
try {
  report = execFileSync(process.execPath, [path.join(__dirname, 'i18n-extract.js'), '--dry'], { encoding: 'utf8' });
} catch (err) {
  console.error('  Could not read the source:', err.message);
  process.exit(1);
}

if (!/([0-9]+) string\(s\) to translate/.test(report)) {
  console.error('  The extractor said nothing this check understands.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// The tests, per language
// ---------------------------------------------------------------------------
/** {name} and {n}, the only interpolation the catalogue has. */
const vars = (s) => (String(s).match(/\{(\w+)\}/g) || []).sort().join(',');
/** <b>, <a href=…>, </b> — the tag names, not their attributes. */
const tags = (s) => (String(s).match(/<\/?([a-z][a-z0-9]*)\b/gi) || [])
  .map((t) => t.toLowerCase().replace(/\s.*$/, '')).sort().join(',');

/*
 * "Is this actually in the language?" — the script it is written in.
 *
 * A catalogue entry that is still Latin is either a deliberate "SSL" or a line
 * somebody pasted and forgot, and those two look identical in a diff. The
 * range is per language because it is the only test here that can be: Bengali
 * is U+0980–09FF, and a language in Latin script has none to check against, so
 * it simply skips this and loses nothing it ever had.
 */
const SCRIPTS = { bn: /[ঀ-৿]/ };

function check(code) {
  const dir = path.join(ROOT, 'src', 'i18n', code);
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
    : [];

  const seen = new Map(); // key -> { file, text }
  const problems = { missing: [], placeholder: [], markup: [], twice: [] };
  const untranslated = [];
  const script = SCRIPTS[code];

  for (const file of files) {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    } catch (err) {
      console.error(`  ${code}/${file} is not valid JSON: ${err.message}`);
      process.exit(1);
    }
    for (const [rawKey, text] of Object.entries(data)) {
      const key = norm(rawKey);
      const value = String(text == null ? '' : text);

      if (seen.has(key) && seen.get(key).text !== value) {
        problems.twice.push(`${key.slice(0, 60)}\n        ${seen.get(key).file}: ${seen.get(key).text.slice(0, 40)}\n        ${file}: ${value.slice(0, 40)}`);
      }
      seen.set(key, { file, text: value });

      if (!value.trim()) {
        problems.missing.push(`${file}  ${key.slice(0, 78)}`);
        continue;
      }
      if (vars(key) !== vars(value)) {
        problems.placeholder.push(`${file}  ${key.slice(0, 50)}\n        English: ${vars(key) || '(none)'}   ${code}: ${vars(value) || '(none)'}`);
      }
      if (tags(key) !== tags(value)) {
        problems.markup.push(`${file}  ${key.slice(0, 50)}\n        English: ${tags(key) || '(none)'}   ${code}: ${tags(value) || '(none)'}`);
      }
      if (script && !script.test(value)) untranslated.push(`${file}  ${key.slice(0, 60)} → ${value.slice(0, 30)}`);
    }
  }

  return { files, strings: seen.size, problems, untranslated };
}

// ---------------------------------------------------------------------------
// Is every string a browser script shows actually served to the browser?
// ---------------------------------------------------------------------------
/*
 * The same comment problem the extractor has: public/assets/js/i18n.js
 * documents itself with `VT.t('Saved {name}')`, and a scanner that reads
 * comments reports its own examples as missing. Stripping block and line
 * comments is enough here — these files have no prose containing `/*`.
 */
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => {
      // A `//` inside a string is not a comment, and `https://` is the case
      // that proves it, so only cut at one that follows whitespace or a start.
      const at = line.search(/(^|[\s;{}(),])\/\//);
      return at === -1 ? line : line.slice(0, at);
    })
    .join('\n');
}

function clientGap() {
  const jsDir = path.join(ROOT, 'public/assets/js');
  const used = new Set();
  let entries = [];
  try { entries = fs.readdirSync(jsDir); } catch { return []; }
  for (const file of entries) {
    if (!file.endsWith('.js')) continue;
    const src = codeOnly(fs.readFileSync(path.join(jsDir, file), 'utf8'));
    const call = /VT\.(?:t|tn)\(\s*(['"])((?:\\.|(?!\1)[^\\])*)\1/g;
    let m;
    while ((m = call.exec(src)) !== null) used.add(norm(m[2]));
  }

  const out = [];
  for (const code of TARGETS) {
    const dir = path.join(ROOT, 'src', 'i18n', code);
    let inClient = new Set();
    try {
      inClient = new Set(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'client.json'), 'utf8'))).map(norm));
    } catch { /* no client.json yet */ }
    for (const key of used) {
      if (!inClient.has(key)) out.push(`${code}  ${key.slice(0, 78)}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Say it
// ---------------------------------------------------------------------------
const say = (label, list, limit = 30) => {
  if (!list.length) return;
  console.log(`\n  ${label} (${list.length}):`);
  for (const line of list.slice(0, limit)) console.log(`    ${line}`);
  if (list.length > limit) console.log(`    … and ${list.length - limit} more`);
};

let failed = 0;

for (const code of TARGETS) {
  const name = LOCALES[code].name;
  const { files, strings, problems, untranslated } = check(code);
  console.log(`\n  ${name} (${code}): ${files.length} catalogue file(s), ${strings} string(s).`);

  say(`MISSING — no ${name}`, problems.missing);
  say('PLACEHOLDER — {name} does not match', problems.placeholder);
  say('MARKUP — tags do not match', problems.markup);
  say(`TWICE — two different ${name}s`, problems.twice);

  if (untranslated.length) {
    say(`Still in English — deliberate, or forgotten?`, untranslated, 15);
  }

  failed += problems.missing.length + problems.placeholder.length
    + problems.markup.length + problems.twice.length;
}

const notServed = clientGap();
say('NOT SERVED — a browser string that is not in client.json', notServed);
failed += notServed.length;

if (failed) {
  console.log(`\n  ${failed} problem(s). The site still works — every one of these falls back to English — but it is not finished.\n`);
  process.exit(1);
}

console.log(`\n  ${TARGETS.map((c) => LOCALES[c].name).join(' and ')} complete.\n`);
