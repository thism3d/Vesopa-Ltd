/**
 * The reports screens: is the wiring actually connected?
 *
 * No browser here — the markup, the stylesheet and app.js are read as text and
 * checked against each other, the same way backoffice-layout.test.js does. That
 * is enough for the failure this exists to catch, which is not subtle
 * rendering. It is the one that took the Financial Summary screen down while it
 * was being rebuilt: an element was renamed in index.html and app.js went on
 * reaching for the old id, so `$('rr-window').textContent` threw, the whole
 * render aborted, and the page went blank with nothing in the console anybody
 * was looking at.
 *
 * Three rules, all of them cheap:
 *
 *   1. Every id the reports code reaches for exists in the markup.
 *   2. Every reports class the markup or the code writes has a rule.
 *   3. The row of actions on a schedule is icon buttons, not full-size ones.
 *      Six `.btn`s in the last cell of a nine column table is a row wider than
 *      the laptop it is read on, which is where this started.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const read = (name) =>
  fs.readFileSync(path.join(__dirname, '..', 'public', name), 'utf8');

const html = read('index.html');
const css = read('style.css');
const app = read('app.js');

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

console.log('Back office: the reports screens\n');

/** The prefixes that belong to these two screens and their viewer. */
const OURS = /^(rr-|rs-|pdfv)/;

// ---------------------------------------------------------------------------
// 1. Ids
// ---------------------------------------------------------------------------

const declared = new Set(
  [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1])
);

const reached = new Set(
  [...app.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]).filter((id) => OURS.test(id))
);

check('the screens have ids to check', () => {
  assert.ok(reached.size > 12, `only ${reached.size} ids reached for`);
});

check('every element the reports code reaches for is in the markup', () => {
  const missing = [...reached].filter((id) => !declared.has(id));
  assert.deepStrictEqual(missing, []);
});

// ---------------------------------------------------------------------------
// 2. Classes
// ---------------------------------------------------------------------------

/** Every class name a rule in the stylesheet actually selects. */
const styled = new Set(
  [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/\.([a-z][a-z0-9-]*)/g)].map(
    (m) => m[1]
  )
);

/**
 * Every class written onto an element, in the markup and in app.js alike.
 *
 * A class attribute in app.js is a template literal — `class="rr-tile${hero}"`
 * — so interpolations are flattened rather than skipped, and what falls out is
 * filtered down to these screens' own prefixes afterwards. The junk a flattened
 * expression leaves behind never starts with rr-, rs- or pdfv; a class name
 * hiding inside one is exactly what skipping the attribute would miss.
 */
function classesIn(source) {
  const out = new Set();
  for (const m of source.matchAll(/class="([^"]*)"/g)) {
    for (const name of m[1].split(/[^a-z0-9-]+/)) if (name) out.add(name);
  }
  return out;
}

const used = new Set(
  [...classesIn(html), ...classesIn(app)].filter((name) => OURS.test(name))
);

check('the screens have classes to check', () => {
  assert.ok(used.size > 8, `only ${used.size} classes used`);
});

check('every class these screens write has a rule behind it', () => {
  const unstyled = [...used].filter((name) => !styled.has(name));
  assert.deepStrictEqual(
    unstyled,
    [],
    'a class with no rule is a layout somebody thinks they wrote'
  );
});

check('and every rule these screens carry is on something', () => {
  const orphans = [...styled].filter(
    (name) => OURS.test(name) && !used.has(name)
  );
  assert.deepStrictEqual(orphans, [], 'dead rules outlive the markup that needed them');
});

// ---------------------------------------------------------------------------
// 3. The shapes that were the actual complaint
// ---------------------------------------------------------------------------

const rsRow = app.slice(app.indexOf('function rsRow('), app.indexOf('async function rsAction('));

check('a schedule row draws icon buttons, not a row of full-size ones', () => {
  assert.ok(rsRow.includes('row-actions'), 'the actions are not in a wrapping row');
  assert.ok(!/class="btn/.test(rsRow), 'a full-size button is back in the row');
});

check('every cell gets the heading it loses on a phone', () => {
  // The card layout drops the heading row, so a cell with no data-label shows
  // its value with nothing saying what the value is: a bare "08:30". The
  // labels are stamped on from the <th> each cell sits under rather than
  // written out beside the row, so what this checks is that every table that
  // becomes cards is actually passed through that.
  const fn = app.slice(app.indexOf('function cardsOnPhone('), app.indexOf('async function loadCrud('));
  assert.match(fn, /table\.tHead/, 'the labels do not come from the headings');
  assert.match(fn, /setAttribute\('data-label'/, 'nothing is labelled');
  // Half these screens re-draw their rows without going back through render(),
  // and the class stays on the table when they do. Labels that disappear on
  // the second render are worse than labels that were never there.
  assert.match(fn, /MutationObserver/, 'a re-rendered row keeps its headings by luck');

  // Both screens that become cards go through it: the schedules table, and
  // every programming table loadCrud draws — which is Departments, Sub
  // departments, Modifiers and the rest, in one place.
  assert.match(app, /cardsOnPhone\(\$\('rs-table'\)\)/, 'schedules are not labelled');
  assert.match(app, /cardsOnPhone\(body\.closest\('table'\)\)/, 'programming tables are not');
});

check('a wide table stops being a table before it stops fitting', () => {
  const phone = css.slice(css.indexOf('@media (max-width: 760px)'));
  assert.ok(phone.startsWith('@media'), 'no narrow-screen rules for wide tables');
  assert.match(phone, /\.table-cards thead \{ display: none; \}/, 'the heading row survives');

  // The card has to be told to fill the width, and told it in a selector that
  // outranks `.card > table { width: max-content }` — which is a class *and* an
  // element, so a bare `.table-cards` loses to it. That is not hypothetical:
  // it is why every card had a 129px hole down its right-hand side and read as
  // far too much padding.
  const fill = /\.card > \.table-cards,\s*\.table-cards \{([^}]*)\}/.exec(css);
  assert.ok(fill, 'nothing outranks the desktop `width: max-content`');
  assert.match(fill[1], /width:\s*100%/, 'the table does not fill the card');
  assert.match(fill[1], /min-width:\s*0/, 'a min-width floor survives');
  assert.match(
    phone,
    /td::before \{\s*content: attr\(data-label\)/,
    'the headings are dropped without being put back on the cells'
  );
  assert.match(
    phone,
    /\.table-cards td \{[^}]*white-space: normal/,
    'the narrow-screen `nowrap` runs a long name out of the side of its card'
  );
});

check('and the actions land in the card rather than off its right edge', () => {
  const cell = /\.table-cards td\.row-actions-cell \{([^}]*)\}/.exec(css);
  assert.ok(cell, 'the actions cell is left as a table cell on a phone');
  assert.match(cell[1], /display: flex/);

  const icons = /\.table-cards td\.row-actions-cell \.row-actions \{([^}]*)\}/.exec(css);
  assert.ok(icons, 'the six icon actions are left to wrap');
  assert.match(icons[1], /flex-wrap:\s*nowrap/);
});

check('the row of buttons is the cell that gets the treatment', () => {
  assert.ok(rsRow.includes('row-actions-cell'), 'the schedule actions cell is unmarked');
  const crud = app.slice(app.indexOf('async function loadCrud('), app.indexOf('function crudModalFields('));
  assert.ok(crud.includes('row-actions-cell'), 'the programming actions cell is unmarked');
  assert.ok(crud.includes('card-title'), 'a programming card has no title');
});

check('every action in the row has a name a screen reader can read', () => {
  const helper = app.slice(app.indexOf('const iconButton ='), app.indexOf('async function loadRunReport'));
  assert.ok(helper.includes('aria-label='), 'icon buttons with no accessible name');
  assert.ok(helper.includes('title='), 'icon buttons with no tooltip');
});

check('the controls wrap into columns rather than one shrinking line', () => {
  const rule = /\.rr-controls\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule, 'no .rr-controls rule');
  assert.match(rule[1], /grid-template-columns:\s*repeat\(auto-fit/);
});

check('the buttons sit under the fields, on their own rule', () => {
  const rule = /\.rr-actions\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule, 'no .rr-actions rule');
  assert.match(rule[1], /flex-wrap:\s*wrap/, 'the actions cannot wrap');
  assert.match(rule[1], /border-top/, 'nothing separates them from the fields');
});

check('and on a phone nothing is pushed to the right of a hole', () => {
  const phone = /@media \(max-width: 720px\) \{([\s\S]*?)\n\}/.exec(
    css.slice(css.indexOf('.rr-export-group'))
  );
  assert.ok(phone, 'no narrow-screen rules for the export group');
  assert.match(phone[1], /margin-left:\s*0/);
});

// ---------------------------------------------------------------------------
// 4. Downloading and viewing
// ---------------------------------------------------------------------------

check('a file is fetched with the session token, never plainly linked', () => {
  const fn = app.slice(app.indexOf('async function reportFile('), app.indexOf('function saveBlob('));
  assert.match(fn, /Authorization/, 'the export route is behind auth');
  assert.match(fn, /content-disposition/i, 'the server names the file, not us');
});

check('the viewer asks for a PDF it can actually draw', () => {
  const fn = app.slice(app.indexOf('function rrView('), app.indexOf('// ---- The report viewer'));
  assert.match(fn, /format: 'pdf'/);
  assert.match(fn, /disposition: 'inline'/);
});

check('closing the viewer lets go of the report', () => {
  const fn = app.slice(app.indexOf('function closeViewer('));
  assert.match(fn, /releaseViewer\(\)/, 'the blob is held after the panel closes');
});

// ---------------------------------------------------------------------------
// 5. The Sales Explorer loads as it is scrolled
// ---------------------------------------------------------------------------

const explorer = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'programming.js'),
  'utf8'
);

check('a page of sales is fetched, not five hundred', () => {
  const fn = app.slice(app.indexOf('async function exNextPage('), app.indexOf('function exWatch('));
  assert.match(fn, /params\.set\('limit'/, 'no page size is asked for');
  assert.match(fn, /params\.set\('offset'/, 'every page would be the first one');
  assert.match(fn, /rows\.length < EX_PAGE/, 'a short page is not recognised as the last');
});

check('and the next page is on its way before the scroll arrives', () => {
  const fn = app.slice(app.indexOf('function exWatch('), app.indexOf('function exWatch(') + 800);
  assert.match(fn, /IntersectionObserver/);
  assert.match(fn, /rootMargin/, 'the page is only fetched once the foot is reached');
  // `main` is the scroller — the rail is fixed beside it — so a null root
  // watches a viewport the sentinel never appears to move in, and the list
  // silently stops at the first page.
  assert.match(fn, /root: document\.querySelector\('main'\)/);
});

check('a search that lands late cannot append to a newer one', () => {
  const fn = app.slice(app.indexOf('async function exNextPage('), app.indexOf('function exWatch('));
  assert.match(fn, /mine !== exFeed\.token/, 'no guard against an overtaken request');
});

check('paged sales are ordered by something unique', () => {
  // Every line on one bill shares closed_at to the second. Ordering by that
  // alone leaves the order within a bill undefined, and LIMIT/OFFSET over an
  // undefined order shows one line twice and another never.
  const route = explorer.slice(
    explorer.indexOf("router.get('/sales-explorer'"),
    explorer.indexOf("router.get('/till-report'")
  );
  assert.match(route, /ORDER BY o\.closed_at DESC, l\.id DESC/);
  assert.match(route, /LIMIT \$\{limit\} OFFSET \$\{offset\}/);
  // Interpolated, so they have to be numbers by the time they get there.
  assert.match(route, /const limit = Math\.min\(Math\.max\(Number\(/);
  assert.match(route, /const offset = Math\.max\(Number\(/);
});

check('sending a schedule by email asks first', () => {
  const fn = app.slice(app.indexOf('if (data.rsSend) {'), app.indexOf('if (data.rsDelete) {'));
  assert.match(fn, /confirm\(/, 'one click still mails the whole recipient list');
});

console.log(`\n${passed} checks passed`);
