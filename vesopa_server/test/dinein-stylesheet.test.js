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
    // .qbadge replaced .qty: the quantity is now the button, and the stepper
    // is what it opens into. All three layouts position it, so all three
    // selectors have to survive a careless slice.
    '.add{', '.qbadge{', '.qbadge.open{',
    '.item .thumb .qbadge', '.pcard .qbadge', '.item .end .qbadge',
    '.item{', '.item .body', '.item .thumb',
    '.pcard', '.pop-grid', '.offerbox', '.promos', '.money',
    '.tabs{', '.hero{', '.basket', '.pop{',
    // The dish sheet. Its footer being sticky is the whole reason the price
    // and the Add button are reachable on a dish with four add-on groups.
    '.sheet.dish', '.dfoot{', '.dopt{', '.dgroup{', '.dadd{',
    // The offer sparkle, and the pill that asks which table.
    '.sparks{', '.where.pick.ask{',
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

check('nothing in the page script contains a backtick either', () => {
  // The same trap, and the more likely half of it: the entire customer-facing
  // script is in that literal too, so one backtick in one JSDoc comment ends
  // the literal hundreds of lines early. The file then either fails to parse or
  // — worse — parses into something that serves a truncated page.
  const from = source.indexOf('<script>', source.indexOf('</style>'));
  const to = source.indexOf('</' + 'script>', from);
  assert.ok(from > 0 && to > from, 'the page script could not be located');
  // Everything inside a ${...} hole is ordinary JavaScript, evaluated while the
  // page is being built, so a backtick there is a nested literal and perfectly
  // safe. It is a backtick in the *text* of the page that ends it early.
  //
  // Holes nest — ${table ? `"${esc(table)}"` : 'null'} — so they come out from
  // the inside first, a layer at a time, until none is left.
  let script = source.slice(from, to);
  for (let i = 0; i < 20 && /\$\{[^{}]*\}/.test(script); i++) {
    script = script.replace(/\$\{[^{}]*\}/g, '');
  }
  const bad = script
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.includes('`'));
  assert.deepStrictEqual(bad, [], 'a backtick would end the page');
});

// ---------------------------------------------------------------------------
// The table picker
// ---------------------------------------------------------------------------
//
// The plan is built by string concatenation and styled by a stylesheet written
// a thousand lines away from it. Nothing checks that a class the markup emits
// is a class the stylesheet knows about — a renamed rule leaves the plan on the
// page as a stack of unpositioned buttons, which still works and looks broken.

check('no code in the page relies on a backslash escape', () => {
  // THE TRAP THIS PAGE KEEPS FALLING INTO.
  //
  // The whole customer page — markup, stylesheet and script — is one template
  // literal in dinein_pages.js. A backslash inside a template literal is an
  // escape, so a backslash-s written in the source arrives at the browser as a
  // bare "s" and a backslash-d as a bare "d". The regex still compiles. It just
  // quietly matches something else, on the served page only, where nothing in
  // this repository is looking.
  //
  // Three bugs so far:
  //   * times rendered as "11:00" once the digit class became a literal d,
  //   * "Rhys" shortened to "Rhy" once the space class became a literal s,
  //   * every seat on the floor plan labelled "Table 2" and clipped to
  //     "Tabl..." once /^tables?\s+/ became /^tables?s+/ and matched nothing.
  //
  // Character classes carry no backslash and cannot be eaten: [0-9] for a
  // digit, [ ] for a space, [A-Za-z0-9_] for a word character. Use those.
  //
  // Comments are stripped first, because the comments above — and the ones on
  // the page itself — necessarily name the very sequences being banned.
  const from = source.indexOf('<script>', source.indexOf('</style>'));
  const to = source.indexOf('</' + 'script>', from);
  assert.ok(from > 0 && to > from, 'the page script could not be located');

  const code = source
    .slice(from, to)
    .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments
    .replace(/^\s*\/\/.*$/gm, '')       // whole-line comments
    .replace(/([^:])\/\/.*$/gm, '$1');  // trailing comments, sparing http://

  const banned = [...code.matchAll(/\\[dswbDSWB]/g)].map((m) => {
    const at = code.slice(0, m.index).split('\n').length;
    const line = code.split('\n')[at - 1].trim();
    return `line ${at}: ${line.slice(0, 70)}`;
  });

  assert.deepStrictEqual(banned, [],
    'these lose their backslash inside the template literal — use a character class');
});

check('every class the floor plan draws has a rule behind it', () => {
  const drawn = [
    'floor', 'fseat', 'round', 'busy', 'picked', 'fname', 'fseats',
    'floor-tabs', 'floor-key', 'floor-say', 'floor-wait', 'floor-empty',
    'floor-count', 'totable',
  ];
  const missing = drawn.filter((c) => !new RegExp('\\.' + c + '[\\s,{:.]').test(CSS));
  assert.deepStrictEqual(missing, [], 'the plan draws classes nothing styles');
});

check('a seat is positioned, or the plan is a pile of buttons', () => {
  // Every seat is placed by a percentage into a box that holds the room's
  // proportions. Without position:absolute on the seat and position:relative on
  // the room, all of them stack at the top left and the plan means nothing.
  assert.match(CSS, /\.floor\{[^}]*position:relative/, 'the room is not a containing block');
  assert.match(CSS, /\.fseat\{[^}]*position:absolute/, 'seats are not placed');
});

check('a table in use is marked but never disabled', () => {
  // The commonest table for somebody to pick is the one they are already
  // sitting at, and a second round belongs on the bill that is open on it. A
  // busy seat is drawn differently and stays pressable.
  const seats = source.slice(source.indexOf('function planHtml('));
  const body = seats.slice(0, seats.indexOf('\n  }'));
  assert.ok(body.includes("' busy'"), 'a table in use is not marked at all');
  assert.ok(!/disabled/.test(body), 'a table in use was made unpressable');
});

check('the question is asked once, at the end', () => {
  // Not at the door. Somebody reading a menu has not decided they want anything
  // yet, and a venue's own web address is a perfectly good place to just read.
  const checkout = source.slice(source.indexOf('function openCheckout(){'));
  const head = checkout.slice(0, checkout.indexOf('var v = data.venue;'));
  assert.match(head, /if \(!TABLE\) \{ askTable\(openCheckout\); return; \}/,
    'checkout no longer asks which table');
});

check('an order is never posted to nowhere', () => {
  // The order endpoint is addressed by a table's public id. Sending without one
  // builds a URL with `undefined` in it, which is a customer watching a
  // spinner while their dinner goes to a route that does not exist.
  // Two functions on this page are called send() — the sign-in code and the
  // order. Anchored past openCheckout so this is unambiguously the order, which
  // is the one with somewhere to go wrong.
  const send = source.slice(
    source.indexOf('function send(){', source.indexOf('function openCheckout(){'))
  );
  const head = send.slice(0, send.indexOf('var btn ='));
  assert.match(head, /if \(!TABLE\)/, 'send lost its guard');
});

check('choosing a table re-reads the menu through that table', () => {
  // A table can be on the plan and switched off for phone orders. Patching
  // `data.table` in place from the floor payload would skip the one endpoint
  // that knows that, and the refusal would arrive at send time instead.
  const choose = source.slice(source.indexOf('function chooseTable('));
  const body = choose.slice(0, choose.indexOf('\n  }'));
  assert.ok(body.includes("'/api/public/dinein/table/'"),
    'the chosen table is not verified against its own endpoint');
  assert.ok(body.includes('history.replaceState'),
    'a reload would lose the table that was just chosen');
});

console.log(`\n${passed} checks passed\n`);
