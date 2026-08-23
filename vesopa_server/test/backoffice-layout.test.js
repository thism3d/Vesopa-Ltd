/**
 * Back office layout: does every section actually get its padding?
 *
 * No browser and no screenshots — the CSS and the markup are read as text and
 * checked against each other. That is enough, because the failure this exists
 * to catch is not subtle rendering: it is a card class that nobody ever wrote a
 * `padding` rule for, so seven whole sections put their headings hard against
 * the border while the rest breathed.
 *
 * `.card` deliberately draws only the box — background, border, radius, shadow
 * — because a card holding a table wants its padding on the cells, not on the
 * card. That is a reasonable split and it stays. What it costs is that every
 * *other* kind of card has to remember to bring padding of its own, and
 * `.rd-card` — the form card, used by Till & printers, Kitchen screens, Screen
 * programming, the receipt designer, promotions, loyalty and tender — never
 * did. This is the rule that would have said so.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'index.html'),
  'utf8'
);
const css = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'style.css'),
  'utf8'
);

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.log(`FAIL  ${name}\n      ${e.message}`);
    process.exitCode = 1;
  }
}

console.log('Back office: layout and spacing\n');

// ---- Reading the stylesheet ----------------------------------------------

/** Every rule as `{ selectors: [...], body }`, comments stripped, @media flat. */
function rules(source) {
  const bare = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(bare))) {
    const selector = m[1].trim();
    if (!selector || selector.startsWith('@')) continue;
    out.push({
      selectors: selector.split(',').map((s) => s.trim()),
      body: m[2],
    });
  }
  return out;
}

const ALL = rules(css);

/** The class names whose own rule sets a padding of some kind. */
const padded = new Set();
for (const rule of ALL) {
  if (!/(^|[;\s])padding(-[a-z]+)?\s*:/.test(rule.body)) continue;
  for (const selector of rule.selectors) {
    // Only single-class selectors — `.rd-card`, not `.rd-card h3` — because a
    // descendant rule pads the child, not the card.
    const m = /^\.([a-z0-9-]+)$/.exec(selector);
    if (m) padded.add(m[1]);
  }
}

// ---- Every card in the markup ---------------------------------------------

/** Each `class="card …"` element, with the classes it carries. */
function cards() {
  const out = [];
  const re = /<div class="(card[^"]*)"([^>]*)>/g;
  let m;
  while ((m = re.exec(html))) {
    out.push({
      classes: m[1].split(/\s+/).filter(Boolean),
      attrs: m[2],
      // A card whose padding comes from the table inside it.
      table: html.slice(m.index, m.index + 400).includes('<table'),
      at: html.slice(0, m.index).split('\n').length,
    });
  }
  return out;
}

const CARDS = cards();

check('the markup actually has cards to check', () => {
  assert.ok(CARDS.length > 30, `only found ${CARDS.length}`);
});

// The one that was broken. Seven sections, thirty cards, no padding at all.
check('every card gets padding from somewhere', () => {
  const bare = CARDS.filter(
    (c) => !c.table && !c.classes.some((cls) => padded.has(cls))
  );
  assert.deepStrictEqual(
    bare.map((c) => `line ${c.at}: ${c.classes.join('.')}`),
    [],
    'these cards draw a box with nothing inside it'
  );
});

check('the form card carries its own padding', () => {
  assert.ok(padded.has('rd-card'), '.rd-card has no padding rule');
});

// A number in six places is a number that will be five places next time.
check('card padding is one token, not six numbers', () => {
  for (const cls of ['panel', 'rd-card', 'inspector']) {
    const rule = ALL.find((r) => r.selectors.includes(`.${cls}`) && /padding/.test(r.body));
    assert.ok(rule, `.${cls} has no padding rule`);
    assert.ok(
      /var\(--card-pad\)/.test(rule.body),
      `.${cls} sets its padding as a literal instead of var(--card-pad)`
    );
  }
});

check('the token is defined, and tightened on narrow screens', () => {
  assert.ok(/--card-pad:\s*\d+px/.test(css), '--card-pad is never defined');
  const narrow = css.slice(css.indexOf('@media (max-width: 960px)'));
  assert.ok(
    /--card-pad:\s*\d+px/.test(narrow),
    'a phone gets the full desktop inset on both sides'
  );
});

// ---- Rhythm ---------------------------------------------------------------

// Cards have no margin of their own, so before this rule two of them in a row
// touched unless somebody remembered an inline margin — and the newer sections
// did not.
check('blocks down a view are separated by a rule, not by hand', () => {
  const rule = ALL.find((r) => r.selectors.includes('.view > * + *'));
  assert.ok(rule, 'nothing sets the gap between the blocks in a view');
  assert.ok(/margin-top:\s*var\(--stack\)/.test(rule.body));
});

check('no card patches its own spacing inline', () => {
  const patched = CARDS.filter((c) => /style="[^"]*margin/.test(c.attrs));
  assert.deepStrictEqual(
    patched.map((c) => `line ${c.at}`),
    [],
    'an inline margin on a card means the rhythm rule is not reaching it'
  );
});

// ---- Page heads -----------------------------------------------------------

/** Every `<section id="view-…">` and its markup. */
function views() {
  return html
    .split('<section id="view-')
    .slice(1)
    .map((part) => ({
      name: part.slice(0, part.indexOf('"')),
      body: part.split('</section>')[0],
    }));
}

const VIEWS = views();

check('every view opens with a page head', () => {
  const missing = VIEWS.filter((v) => !v.body.includes('<div class="page-head">'));
  assert.deepStrictEqual(missing.map((v) => v.name), []);
});

// A head whose heading is a bare flex child sits differently from one whose
// heading is wrapped with its description, so the title line moved as you
// walked between sections.
check('every page head wraps its heading with its description', () => {
  const loose = VIEWS.filter(
    (v) => !/<div class="page-head">\s*<div>/.test(v.body)
  );
  assert.deepStrictEqual(loose.map((v) => v.name), []);
});

check('every view says what it is for', () => {
  const silent = VIEWS.filter(
    (v) => !/page-head">[\s\S]{0,700}?<p class="muted small"/.test(v.body)
  );
  assert.deepStrictEqual(
    silent.map((v) => v.name),
    [],
    'a section with a bare title reads as unfinished next to one without'
  );
});

console.log(`\n${passed} checks passed`);
