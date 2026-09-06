/**
 * The customer menu's stylesheet, as a document.
 *
 * WHY THIS EXISTS
 *
 * The menu page is one self-contained document: its CSS is a template literal
 * in src/dinein_pages.js, served inline, and never touched by a build step. So
 * nothing between writing it and a customer reading it will notice that it is
 * broken.
 *
 * And CSS fails quietly in a particular way. An unclosed rule does not throw —
 * the parser keeps consuming, and every rule after it is swallowed into the
 * block that was never closed. The bug this was written for was exactly that:
 * a block edit removed the closing brace of a `@media (min-width:720px)`, so on
 * a phone every rule after it silently stopped applying. The buttons went back
 * to being 16x6 browser defaults, on a page that still loaded, still fetched
 * its menu, and reported no error anywhere.
 *
 * Braces are the whole of it. Everything else CSS will forgive.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${e.message}`);
    process.exitCode = 1;
  }
}

const source = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'dinein_pages.js'),
  'utf8'
);

/** The STYLE template literal, with comments removed. */
function stylesheet() {
  const open = 'const STYLE = `';
  const from = source.indexOf(open);
  assert.notStrictEqual(from, -1, 'STYLE not found');
  const to = source.indexOf('`;', from);
  assert.notStrictEqual(to, -1, 'STYLE is not closed');
  return source.slice(from + open.length, to);
}

const CSS = stylesheet();
const bare = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

console.log('\nThe customer menu stylesheet\n');

check('every brace that opens is closed', () => {
  const open = (bare.match(/\{/g) || []).length;
  const close = (bare.match(/\}/g) || []).length;
  assert.strictEqual(
    open, close,
    `${open} { against ${close} } — every rule after the first unclosed one is ` +
    'silently swallowed by it'
  );
});

check('the nesting never goes negative', () => {
  // A count that balances overall can still be wrong: "} .a{ {" balances and is
  // nonsense. Walking it catches a closing brace that arrives before anything
  // has been opened.
  let depth = 0;
  let line = 1;
  for (let i = 0; i < bare.length; i += 1) {
    const c = bare[i];
    if (c === '\n') line += 1;
    else if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      assert.ok(depth >= 0, `a closing brace with nothing open, near line ${line}`);
    }
  }
  assert.strictEqual(depth, 0, `${depth} block(s) still open at the end`);
});

check('no rule is left with a dangling selector', () => {
  // What the broken edit actually produced: `.items /* … */` followed by a
  // rule at the top level, so the selector ran into whatever came next. A
  // selector is followed by "{" or by a comma, never by another selector on the
  // next line with nothing between them.
  const lines = bare.split('\n');
  const bad = [];
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('@') || line.startsWith('}')) return;
    // A line that names a selector and then simply stops.
    if (/^[.#a-zA-Z][^{};:]*$/.test(line) && !line.endsWith(',')) {
      const next = (lines[i + 1] || '').trim();
      if (!next.startsWith('{') && !/^[.#a-zA-Z@:[]/.test(next)) return;
      if (!next.startsWith('{') && !next.endsWith(',') && !/[{,]/.test(next)) {
        bad.push(`line ${i + 1}: ${line}`);
      }
    }
  });
  assert.deepStrictEqual(bad, []);
});

check('every media query names a real condition', () => {
  // `@media (max-width:400px)` and friends. A typo here does not throw, it just
  // never matches, which is indistinguishable from the rules being absent.
  const queries = bare.match(/@media[^{]*/g) || [];
  assert.ok(queries.length >= 4, `only ${queries.length} media queries`);
  for (const q of queries) {
    assert.match(
      q.trim(),
      /^@media\s*\(\s*(min-width|max-width|prefers-color-scheme|prefers-reduced-motion|pointer)\s*:/,
      `unrecognised: ${q.trim()}`
    );
  }
});

check('the rules the page depends on are all present', () => {
  // Each of these was, at some point, silently switched off by a brace or a
  // slice. A page that renders with any of them missing still loads.
  const required = [
    '.add{', '.qty{', '.item{', '.item .body', '.item .thumb',
    '.pcard', '.pop-grid', '.offerbox', '.promos', '.money',
    '.tabs{', '.hero{', '.basket', '.pop{',
  ];
  const missing = required.filter((sel) => !CSS.includes(sel));
  assert.deepStrictEqual(missing, []);
});

check('the plus is drawn and never typed', () => {
  // The glyph inside the button was removed because it rendered a second,
  // off-centre plus underneath the drawn one. Both halves have to stay: the
  // rules that draw it, and font-size:0 so a cached copy of the markup cannot
  // bring the glyph back.
  assert.ok(/\.add::before[^}]*content/.test(bare), 'the drawn plus is gone');
  assert.ok(/\.add\{[^}]*font-size:0/.test(bare), 'the guard against the glyph is gone');
  assert.ok(
    !/data-add="' \+ id \+ '" '\s*\+\s*'aria-label="Add">\+</.test(source),
    'the glyph is back in the markup'
  );
});

check('no CSS comment contains a backtick', () => {
  // The whole stylesheet lives inside a template literal, so a backtick in a
  // comment ends the literal and the file stops parsing. It has happened twice.
  const comments = CSS.match(/\/\*[\s\S]*?\*\//g) || [];
  const bad = comments.filter((c) => c.includes('`'));
  assert.deepStrictEqual(bad, []);
});

console.log(`\n${passed} checks passed\n`);
