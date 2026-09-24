/**
 * Read every translatable string out of the source, and merge it into the
 * Bangla catalogue without ever touching a translation already written.
 *
 *     npm run i18n:extract            # merge new keys in, report what changed
 *     npm run i18n:extract -- --dry   # say what it would do, write nothing
 *     npm run i18n:extract -- --prune # also DELETE keys the source no longer has
 *
 * Pruning is off by default and should stay that way for ordinary use: a key
 * that has gone missing is usually a template mid-edit or a file not saved,
 * and deleting its translation loses work that cannot be got back from the
 * source. Run it deliberately, after a rename or a rewrite, and read the list.
 *
 * The English text IS the key (see src/i18n), so there is nothing to invent
 * here: it finds `t('Web hosting')` and puts `"Web hosting": ""` in the right
 * file for somebody to fill in. An empty string means "not translated yet" and
 * `npm run i18n:check` fails on it; the runtime treats it as missing too and
 * falls back to the English, so a half-finished catalogue is never a broken
 * page.
 *
 * WHICH FILE A KEY LANDS IN
 * -------------------------
 * A key is written to exactly one file, because two files disagreeing about
 * one string is the one thing the loader has to warn about:
 *
 *   client.json   anything a browser script shows (VT.t). It is the only file
 *                 served to the browser, so a string used on both sides has to
 *                 live here — the server reads every file regardless.
 *   common.json   used by more than one area (a button in both the public site
 *                 and the panel).
 *   public.json   the marketing pages and their routes.
 *   panel.json    the signed-in control panel.
 *   auth.json     sign-in, registration, the account screens.
 *   mail.json     the transactional emails.
 *
 * Move a key by hand and it stays moved: placement is only decided for keys
 * that are not in the catalogue yet.
 *
 * WHAT IT DOES NOT FIND
 * ---------------------
 * A key built at runtime — t(row.label), t('Plan ' + name) — is invisible to a
 * regular expression and always will be. Those are reported as "dynamic" so
 * they can be given a fixed list of strings instead of being silently missed.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DRY = process.argv.includes('--dry');
const PRUNE = process.argv.includes('--prune');

/*
 * Every language the site has, asked of src/i18n rather than written here — so
 * adding one to LOCALES is the only edit adding one takes. A code on the
 * command line does just that language: `npm run i18n:extract -- bn`.
 */
const { LOCALES, DEFAULT_LOCALE } = require('../src/i18n');
const asked = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const TARGETS = (asked.length ? asked : Object.keys(LOCALES))
  .filter((code) => LOCALES[code] && code !== DEFAULT_LOCALE);

if (!TARGETS.length) {
  console.error(`  Nothing to extract for. Languages: ${Object.keys(LOCALES).filter((c) => c !== DEFAULT_LOCALE).join(', ') || '(none but English)'}`);
  process.exit(1);
}

const norm = (s) => String(s).replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------------------
// Where to look, and what each place is called
// ---------------------------------------------------------------------------
/*
 * Admin is deliberately absent. It is staff-only, never indexed and read by
 * the two people who run the platform in English; translating it would be
 * several hundred strings nobody will ever read in Bangla.
 */
const AREAS = [
  { group: 'client', dirs: ['public/assets/js'], exts: ['.js'] },
  { group: 'public', dirs: ['views/public', 'views/partials'], exts: ['.ejs'] },
  { group: 'public', dirs: ['src/routes'], exts: ['.js'], only: ['pages.js', 'domains.js', 'cart.js', 'pay.js', 'legal.js', 'build.js'] },
  { group: 'panel', dirs: ['views/panel'], exts: ['.ejs'] },
  { group: 'panel', dirs: ['src/routes'], exts: ['.js'], only: ['panel.js', 'panel-apps.js', 'panel-databases.js', 'panel-files.js', 'panel-mail.js', 'domains-api.js'] },
  { group: 'auth', dirs: ['views/auth'], exts: ['.ejs'] },
  { group: 'auth', dirs: ['src/routes'], exts: ['.js'], only: ['auth-routes.js', 'setup.js', 'vesopa-sso.js'] },
  { group: 'mail', dirs: ['src/mail', 'views/mail'], exts: ['.js', '.ejs'] },
  { group: 'common', dirs: ['src'], exts: ['.js'], only: ['server.js', 'notifications.js', 'currency.js', 'countries.js', 'plans.js', 'linking.js', 'jobs.js'] },
];

const FILES = { client: 'client.json', common: 'common.json', public: 'public.json', panel: 'panel.json', auth: 'auth.json', mail: 'mail.json' };

function walk(dir, exts, only) {
  const full = path.join(ROOT, dir);
  let entries = [];
  try { entries = fs.readdirSync(full, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const entry of entries) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(rel, exts, only));
    } else if (exts.includes(path.extname(entry.name))) {
      if (only && !only.includes(entry.name)) continue;
      out.push(rel);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Finding the calls
// ---------------------------------------------------------------------------
/*
 * Comments are not code.
 *
 * Stripping them is not tidiness: src/i18n and public/assets/js/i18n.js both
 * DOCUMENT themselves with `VT.t('Copied')`, and a scanner that reads comments
 * puts those examples in the catalogue for somebody to translate. A regular
 * expression cannot do this — `'https://x'` is a string containing what looks
 * like a comment, and `// a string's apostrophe` is a comment containing what
 * looks like a string — so this walks the text once, in one of four states.
 */
function stripComments(text, ejs) {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    const next = text[i + 1];

    // <%# ... %> — the EJS comment, which may hold anything at all.
    if (ejs && c === '<' && text.startsWith('<%#', i)) {
      const end = text.indexOf('%>', i);
      i = end === -1 ? n : end + 2;
      out += ' ';
      continue;
    }
    if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      out += ' ';
      continue;
    }
    if (c === '/' && next === '/') {
      while (i < n && text[i] !== '\n') i += 1;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const start = i;
      i += 1;
      while (i < n) {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i] === c) { i += 1; break; }
        if (c !== '`' && text[i] === '\n') break; // an unterminated quote: prose, not code
        i += 1;
      }
      out += text.slice(start, i);
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/*
 * One quoted argument, in any of the three quotes, with escapes honoured. The
 * name in front is what tells a translation call from `format(...)` or
 * `submit(...)`: t, th, tn, and the same behind a receiver — req.t, VT.t,
 * i18n.translate(locale, ...).
 *
 * `translate` is only ever matched WITH a receiver, because `translate(` is
 * also CSS: the panel's own scripts build `transform: translate(8px, 0)` and a
 * bare match put a chunk of arithmetic in the catalogue.
 */
const CALL = new RegExp(
  '(?:'
  + String.raw`(?:^|[^A-Za-z0-9_.$])` // not part of a longer name
  + String.raw`(?:(?:req|res\.locals|i18n|VT|it|loc)\.)?`
  + String.raw`(?:t|th|tn)`
  + '|'
  + String.raw`(?:req|res\.locals|i18n|VT|it|loc)\.(?:translate|translateHtml|translatePlural)`
  + ')'
  + String.raw`\s*\(`
  + String.raw`\s*(?:[A-Za-z_$][\w.$]*\s*,\s*)?` // translate(locale, 'key')
  + String.raw`(['"\x60])((?:\\.|(?!\1)[\s\S])*?)\1`,
  'g',
);

/** A second string argument, for tn('{n} file', '{n} files', n). */
const PLURAL_TAIL = /^\s*,\s*(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/;

/** t(something) with no literal — a key a regular expression cannot see. */
const DYNAMIC = /(?:^|[^A-Za-z0-9_.$])(?:(?:req|res\.locals|i18n|VT)\.)?(t|th|tn)\s*\(\s*[A-Za-z_$`]/g;

function unescape(raw, quote) {
  // Only the escapes that actually appear in this codebase's strings.
  let s = raw.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
  s = s.replace(new RegExp(String.raw`\\${quote}`, 'g'), quote);
  return s.replace(/\\\\/g, '\\');
}

function scan(file) {
  const raw0 = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const text = stripComments(raw0, path.extname(file) === '.ejs');
  const keys = [];
  const dynamic = [];

  CALL.lastIndex = 0;
  let m;
  while ((m = CALL.exec(text)) !== null) {
    const [whole, quote, raw] = m;
    // A backtick key would be a template literal: if it interpolates it is not
    // a key at all, and if it does not it should be a plain quote.
    if (quote === '`' && raw.includes('${')) continue;
    const key = norm(unescape(raw, quote));
    if (key) keys.push(key);
    if (/\b(?:tn|translatePlural)\s*\($/.test(whole.slice(0, whole.indexOf(quote)))) {
      const tail = PLURAL_TAIL.exec(text.slice(CALL.lastIndex));
      // The plural form is only ever printed in English, so it is not a key.
      if (tail) CALL.lastIndex += tail[0].length;
    }
  }

  DYNAMIC.lastIndex = 0;
  while ((m = DYNAMIC.exec(text)) !== null) {
    const line = text.slice(0, m.index).split('\n').length;
    const snippet = norm(text.slice(m.index, m.index + 70));
    // A template literal with nothing in it was already taken above.
    if (/^[^`]*`[^`$]*`/.test(snippet) && !snippet.includes('${')) continue;
    dynamic.push(`${file}:${line}  ${snippet}`);
  }

  return { keys, dynamic };
}

// ---------------------------------------------------------------------------
// Collect
// ---------------------------------------------------------------------------
const seen = new Map(); // key -> Set of groups
const dynamic = [];
let scanned = 0;

for (const area of AREAS) {
  for (const dir of area.dirs) {
    for (const file of walk(dir, area.exts, area.only)) {
      scanned += 1;
      const found = scan(file);
      for (const key of found.keys) {
        if (!seen.has(key)) seen.set(key, new Set());
        seen.get(key).add(area.group);
      }
      dynamic.push(...found.dynamic);
    }
  }
}

/** One file per key: see the note at the top. */
function fileFor(groups) {
  if (groups.has('client')) return FILES.client;
  if (groups.size > 1 || groups.has('common')) return FILES.common;
  return FILES[[...groups][0]];
}

// ---------------------------------------------------------------------------
// Merge, keeping every translation already written
// ---------------------------------------------------------------------------
/*
 * One language at a time, and nothing about the scan above is repeated: the
 * English is the English whatever it is being translated into, so the strings
 * are found once and merged into each catalogue in turn.
 */
function merge(code) {
  const out = path.join(ROOT, 'src', 'i18n', code);
  fs.mkdirSync(out, { recursive: true });

  const existing = {}; // file -> { key: value }
  const placed = new Map(); // key -> the file it is already in
  for (const file of Object.values(FILES)) {
    const at = path.join(out, file);
    let data = {};
    try { data = JSON.parse(fs.readFileSync(at, 'utf8')); } catch { data = {}; }
    existing[file] = data;
    for (const key of Object.keys(data)) placed.set(norm(key), file);
  }

  const added = [];
  const stale = [];

  for (const [key, groups] of seen) {
    const file = placed.get(key) || fileFor(groups);
    if (!existing[file]) existing[file] = {};
    if (!(key in existing[file])) {
      existing[file][key] = '';
      added.push(`${file}  ${key.slice(0, 72)}`);
    }
  }

  for (const [file, data] of Object.entries(existing)) {
    for (const key of Object.keys(data)) {
      if (seen.has(norm(key))) continue;
      stale.push(`${file}  ${key.slice(0, 72)}`);
      if (PRUNE) delete data[key];
    }
  }

  /*
   * Sorted, so that a diff of this file is the strings that changed rather
   * than the order they happened to be found in.
   */
  const write = (file, data) => {
    const keys = Object.keys(data).sort((a, b) => a.localeCompare(b, 'en'));
    const ordered = {};
    for (const key of keys) ordered[key] = data[key];
    const at = path.join(out, file);
    const text = `${JSON.stringify(ordered, null, 2)}\n`;
    const before = fs.existsSync(at) ? fs.readFileSync(at, 'utf8') : null;
    if (before === text) return false;
    if (!DRY) fs.writeFileSync(at, text, 'utf8');
    return true;
  };

  let written = 0;
  for (const [file, data] of Object.entries(existing)) {
    if (!Object.keys(data).length) continue;
    if (write(file, data)) written += 1;
  }

  let done = 0;
  for (const data of Object.values(existing)) {
    for (const [key, value] of Object.entries(data)) {
      if (seen.has(norm(key)) && String(value).trim()) done += 1;
    }
  }

  return { added, stale, written, done };
}

// ---------------------------------------------------------------------------
// Say what happened
// ---------------------------------------------------------------------------
const show = (label, list, limit) => {
  if (!list.length) return;
  console.log(`\n  ${label} (${list.length}):`);
  for (const line of list.slice(0, limit)) console.log(`    ${line}`);
  if (list.length > limit) console.log(`    … and ${list.length - limit} more`);
};

console.log(`\n  ${scanned} file(s) read, ${seen.size} string(s) to translate.`);

let totalWritten = 0;
for (const code of TARGETS) {
  const result = merge(code);
  totalWritten += result.written;
  const name = LOCALES[code].name;
  console.log(`\n  ${name} (${code}): ${result.done} translated, ${seen.size - result.done} not.`);
  show(`  New in ${code}`, result.added, 40);
  show(PRUNE
    ? `  Deleted from ${code} — no longer in the source`
    : `  In ${code} but no longer in the source (--prune deletes these)`, result.stale, 20);
}

show('Built at runtime, so not extractable', dynamic, 20);

console.log(`\n  ${DRY ? 'Nothing written (--dry).' : `${totalWritten} file(s) written.`}\n`);
