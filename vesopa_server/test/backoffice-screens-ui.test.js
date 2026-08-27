/**
 * The screen-programming editor, without a browser.
 *
 * No DOM here: the parts of public/screens.js that decide things — rather than
 * draw them — are lifted out and run on their own, the same trick
 * backoffice-kitchen-ui.test.js uses on the kitchen editors.
 *
 * What is worth guarding is the agreement between this editor and the server.
 * They both hold the rule that a button carries exactly one reference, and they
 * hold it in two languages; the day they disagree, a manager saves a layout
 * that comes back different from the one they arranged.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'screens.js'),
  'utf8'
);

/**
 * Lift declarations by name into a bare context.
 *
 * Each is taken from its `function name(` or `const NAME =` up to the first
 * line that closes it at column zero, which is enough for this file's style and
 * avoids parsing JavaScript to test it.
 */
function lift(names) {
  const context = { Number, Set, Map, JSON, Math, Object, Array, String };
  vm.createContext(context);

  for (const name of names) {
    let from = source.indexOf(`function ${name}(`);
    let terminator = '\n}\n';
    if (from < 0) {
      from = source.indexOf(`const ${name} = `);
      // An array literal ends `];`, a `new Map([…])` ends `]);`. Both are used
      // for the same kind of thing in that file — a fixed list written out for
      // people to read — and neither is worth a real parser to lift.
      terminator = source.startsWith(`const ${name} = new Map(`, from)
        ? '\n]);\n'
        : '\n];\n';
    }
    assert.ok(from > 0, `${name} not found in public/screens.js`);

    const rest = source.slice(from);
    const end = rest.indexOf(terminator);
    assert.ok(end > 0, `could not find the end of ${name}`);
    vm.runInContext(rest.slice(0, end + terminator.length), context);
  }
  return context;
}

const ctx = lift([
  'SP_FUNCTIONS',
  'SP_BAR_GROUPS',
  'SP_FUNCTION_LABEL',
  'SP_WIDGET_KEYS',
  'spFunctionsFor',
  'spLimits',
  'spIssues',
  'spFaceFor',
  'spSetKind',
  'spCovered',
  'spOrigin',
  'spHoldsSpace',
  'spTidy',
  'spShape',
  'spCellFromPoint',
  'spProductName',
  'spLabelFor',
  'spMissing',
]);

/** The module-level state those functions read. */
function withState({
  current = null,
  products = [],
  screens = [],
  selection = [],
} = {}) {
  ctx.spCurrent = current;
  ctx.spProducts = products;
  ctx.spScreens = screens;
  ctx.spSelection = new Set(selection);
  // spCovered uses spKey, which is an arrow const the lifter does not take.
  ctx.spKey = (row, col) => `${row}:${col}`;
  ctx.spIsBar = (surface) => surface === 'topbar' || surface === 'bottombar';
  ctx.spCurrentSurface = () => (current && current.surface) || 'sale';
  ctx.spCellTitle = () => '';
}

// Scalars the lifter cannot take — it works on `function name(` and
// `const NAME = [`, and a bare number matches neither. Repeated here rather
// than parsed, and the parity check below is what keeps them honest.
ctx.SP_MAX_ROWS = 10;
ctx.SP_MAX_COLS = 12;
ctx.SP_MAX_BAR_ROWS = 2;
ctx.SP_MAX_BAR_COLS = 16;

/** A cell as "row:col". An object made inside the vm carries that realm's
    prototype, so deepStrictEqual refuses it however alike the two look —
    anything coming back from lifted code is reduced to a string first. */
const cell = (c) => `${c.row}:${c.col}`;

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

console.log('Back office: the screen editor\n');

// ---- The rule both halves hold -------------------------------------------

// The server enforces this too, in normaliseButton. They are the same rule
// written twice, and this is the half a manager meets first: a button changed
// from a product to a page that kept its pluId gives the till two things to
// dispatch on, and it picks whichever the renderer happens to check first.
check('changing a kind clears the other kinds’ references', () => {
  const button = {
    kind: 'product',
    pluId: 42,
    targetScreenId: 3,
    functionKey: 'qty',
  };

  ctx.spSetKind(button, 'page');
  assert.strictEqual(button.kind, 'page');
  assert.strictEqual(button.pluId, null);
  assert.strictEqual(button.functionKey, null);
  assert.strictEqual(button.targetScreenId, 3, 'it cleared the one it needs');

  ctx.spSetKind(button, 'blank');
  assert.strictEqual(button.targetScreenId, null);
  assert.strictEqual(button.pluId, null);
  assert.strictEqual(button.functionKey, null);
});

check('every function offered here is one the server accepts', () => {
  // The two lists are written out separately, so this is the check that they
  // have not drifted. A key offered in the editor and refused by the server
  // saves as a button that does nothing.
  const { FUNCTION_KEYS } = require('../src/screens');
  // Read back through the context rather than off it: `const` in a vm creates a
  // lexical binding in the script scope, not a property of the global object,
  // so ctx.SP_FUNCTIONS is undefined even though code in there can see it.
  const offered = vm
    .runInContext('SP_FUNCTIONS', ctx)
    .map(([key]) => key);

  for (const key of offered) {
    assert.ok(FUNCTION_KEYS.includes(key), `${key} is not a server function key`);
  }
  assert.strictEqual(
    offered.length,
    FUNCTION_KEYS.length,
    'the server knows functions the editor does not offer'
  );
});

// ---- Spans ---------------------------------------------------------------

check('a spanning button swallows the cells under it', () => {
  withState({
    current: {
      rows: 3,
      cols: 3,
      buttons: [{ row: 0, col: 0, rowSpan: 2, colSpan: 2, kind: 'blank' }],
    },
  });

  const covered = ctx.spCovered();
  // Its own cell is not "covered" — that is where it draws.
  assert.ok(!covered.has('0:0'));
  for (const cell of ['0:1', '1:0', '1:1']) {
    assert.ok(covered.has(cell), `${cell} was left as an empty key`);
  }
  assert.ok(!covered.has('2:2'));
});

check('a plain button covers nothing', () => {
  withState({
    current: { rows: 2, cols: 2, buttons: [{ row: 0, col: 0, kind: 'blank' }] },
  });
  assert.strictEqual(ctx.spCovered().size, 0);
});

// ---- What a button says --------------------------------------------------

check('a button shows the product’s own name until it is overridden', () => {
  withState({ products: [{ pluid: 7, product_name: 'Carling' }] });

  assert.strictEqual(
    ctx.spLabelFor({ kind: 'product', pluId: 7 }),
    'Carling'
  );
  assert.strictEqual(
    ctx.spLabelFor({ kind: 'product', pluId: 7, label: '1/2 Carling' }),
    '1/2 Carling'
  );
});

check('a page button shows the screen it points at', () => {
  withState({ screens: [{ id: 3, name: 'Draughts' }] });
  assert.strictEqual(
    ctx.spLabelFor({ kind: 'page', targetScreenId: 3 }),
    'Draughts'
  );
});

check('a function button shows the function’s name, not its key', () => {
  withState();
  assert.strictEqual(
    ctx.spLabelFor({ kind: 'function', functionKey: 'open_drawer' }),
    'No sale (open drawer)'
  );
});

// ---- What has gone missing -----------------------------------------------

// The point of the editor knowing about this at all. A product deleted from
// the catalogue leaves a button behind — deliberately, because the alternative
// is a layout that rearranges itself — and the manager has to be able to see
// which one, here, rather than a clerk finding it at a counter.
check('a deleted product leaves a button that says so', () => {
  withState({ products: [] });

  assert.strictEqual(
    ctx.spLabelFor({ kind: 'product', pluId: 99 }),
    'Missing product'
  );
  assert.ok(ctx.spMissing({ kind: 'product', pluId: 99 }));
});

check('a deleted screen leaves a page button that says so', () => {
  withState({ screens: [{ id: 1, name: 'Food' }] });

  assert.strictEqual(
    ctx.spLabelFor({ kind: 'page', targetScreenId: 42 }),
    'Missing screen'
  );
  assert.ok(ctx.spMissing({ kind: 'page', targetScreenId: 42 }));
});

check('a function button with nothing chosen is flagged', () => {
  withState();
  assert.ok(ctx.spMissing({ kind: 'function', functionKey: null }));
  assert.ok(!ctx.spMissing({ kind: 'function', functionKey: 'qty' }));
});

check('a button that resolves is not flagged', () => {
  withState({
    products: [{ pluid: 7, product_name: 'Carling' }],
    screens: [{ id: 3, name: 'Draughts' }],
  });
  assert.ok(!ctx.spMissing({ kind: 'product', pluId: 7 }));
  assert.ok(!ctx.spMissing({ kind: 'page', targetScreenId: 3 }));
  assert.ok(!ctx.spMissing(null));
});

// ---- The one this back office has been bitten by -------------------------

// Chrome offers "stop showing dialogs" on the SECOND dialog in a row, so a
// chained prompt-then-confirm returns null from everything after it: the
// function bails at its first null check and does nothing, and the alert() that
// would have explained is suppressed by the same tick box. The kitchen editors
// were rewritten out of exactly this. A single confirm() before a destructive
// act is fine and is used elsewhere; a chain is not.
// ---- The cell a press belongs to -----------------------------------------

// A cell swallowed by a 2x2 is not a cell you can programme: it is part of the
// button above it. The editor used to let a drag select those holes and then
// created buttons in them — invisible on the grid, saved to the server, drawn
// by nothing at all. Every press and every drag goes through this now.
check('a cell under a span answers as the button covering it', () => {
  withState({
    current: {
      rows: 3,
      cols: 3,
      buttons: [{ row: 0, col: 0, rowSpan: 2, colSpan: 2, kind: 'product', pluId: 1 }],
    },
  });

  assert.strictEqual(cell(ctx.spOrigin(1, 1)), '0:0');
  assert.strictEqual(cell(ctx.spOrigin(0, 1)), '0:0');
  assert.strictEqual(cell(ctx.spOrigin(2, 2)), '2:2');
});

// ---- Making a layout legal again -----------------------------------------

check('a blank is not a row, here or on the server', () => {
  withState({
    current: {
      rows: 2,
      cols: 2,
      buttons: [
        { row: 0, col: 0, kind: 'blank' },
        { row: 1, col: 1, kind: 'product', pluId: 4 },
      ],
    },
  });
  ctx.spTidy();
  assert.strictEqual(ctx.spCurrent.buttons.length, 1);
  assert.strictEqual(ctx.spCurrent.buttons[0].kind, 'product');
});

// Shrinking a grid, and the same rule the server holds: a button outside it is
// dropped, never clamped. Clamping does not lose a button, it moves it on top
// of another one and calls the result a save.
// The other half of that rule, and the reason the editor learned to resize a
// key that is not a key yet: a blank that *spans* is a space the manager set
// aside, and it has to survive being saved or the whole gesture is pointless.
check('a blank that holds ground is a row, and stops being one at 1x1', () => {
  withState({
    current: {
      rows: 3,
      cols: 3,
      buttons: [
        { row: 0, col: 0, kind: 'blank', rowSpan: 2, colSpan: 2 },
        { row: 2, col: 2, kind: 'blank', rowSpan: 1, colSpan: 1 },
      ],
    },
  });
  ctx.spTidy();
  assert.strictEqual(ctx.spCurrent.buttons.length, 1);
  assert.strictEqual(ctx.spCurrent.buttons[0].kind, 'blank');
  assert.strictEqual(ctx.spCurrent.buttons[0].rowSpan, 2);

  // And it stops being a row the moment it stops holding anything — including
  // when the grid is cut down around it, which is the case the second pass in
  // spTidy exists for: the clamp above it takes the span back to 1x1.
  ctx.spCurrent.rows = 1;
  ctx.spCurrent.cols = 1;
  ctx.spTidy();
  assert.strictEqual(ctx.spCurrent.buttons.length, 0);
});

check('a button outside the grid is dropped rather than moved', () => {
  withState({
    current: {
      rows: 2,
      cols: 2,
      buttons: [
        { row: 0, col: 0, kind: 'product', pluId: 1 },
        { row: 4, col: 0, kind: 'product', pluId: 2 },
        { row: 0, col: 7, kind: 'product', pluId: 3 },
      ],
    },
  });
  ctx.spTidy();
  assert.strictEqual(ctx.spCurrent.buttons.map((b) => b.pluId).join(','), '1');
});

check('a span is clamped to the edge of the grid', () => {
  withState({
    current: {
      rows: 3,
      cols: 3,
      buttons: [{ row: 2, col: 2, rowSpan: 4, colSpan: 9, kind: 'product', pluId: 1 }],
    },
  });
  ctx.spTidy();
  assert.strictEqual(ctx.spCurrent.buttons[0].rowSpan, 1);
  assert.strictEqual(ctx.spCurrent.buttons[0].colSpan, 1);
});

// Growing a button over its neighbours is a thing a manager does on purpose,
// and the neighbours cannot simply be left underneath: they are unreachable,
// they still save, and they reappear the day the span shrinks again.
check('a button stranded under another’s span is dropped', () => {
  withState({
    current: {
      rows: 2,
      cols: 2,
      buttons: [
        { row: 0, col: 0, rowSpan: 2, colSpan: 2, kind: 'product', pluId: 1 },
        { row: 1, col: 1, kind: 'product', pluId: 2 },
      ],
    },
  });
  ctx.spTidy();
  assert.strictEqual(
    ctx.spCurrent.buttons.map((b) => b.pluId).join(','),
    '1',
    'the buried button survived where nobody can press it'
  );
});

check('a selection pointing at nothing does not survive a resize', () => {
  withState({
    current: { rows: 2, cols: 2, buttons: [] },
    selection: ['0:0', '5:5', '0:9'],
  });
  ctx.spTidy();
  assert.strictEqual([...ctx.spSelection].join(','), '0:0');
});

// ---- Unsaved work --------------------------------------------------------

// The warning has to be true or it is worse than nothing: a manager who is
// asked "leave these behind?" after changing nothing learns to click through
// the question on the day it matters.
check('the same layout in a different order is not a change', () => {
  const a = {
    rows: 2,
    cols: 2,
    buttons: [
      { row: 0, col: 0, kind: 'product', pluId: 1 },
      { row: 1, col: 1, kind: 'product', pluId: 2 },
    ],
  };
  const b = {
    rows: 2,
    cols: 2,
    buttons: [
      { row: 1, col: 1, kind: 'product', pluId: 2 },
      { row: 0, col: 0, kind: 'product', pluId: 1 },
    ],
  };
  assert.strictEqual(ctx.spShape(a), ctx.spShape(b));
});

check('a resized grid is a change even with the same buttons', () => {
  const before = { rows: 5, cols: 6, buttons: [] };
  const after = { rows: 6, cols: 6, buttons: [] };
  assert.notStrictEqual(ctx.spShape(before), ctx.spShape(after));
});

// ---- The hit test --------------------------------------------------------

// The editor works out which key is under a finger from the grid's own
// geometry rather than by asking the browser what node is there. That is what
// makes drag-select work with a touchscreen — a touch pointer is captured by
// the element it went down on, so the pointerover events the old editor waited
// for never arrived at all.
check('a point lands in the cell it is drawn in', () => {
  // A 300x200 grid, 10px padding, 10px gaps, 3 columns and 2 rows: cells are
  // 20px shy of a third and a half respectively.
  const g = {
    box: { left: 0, top: 0, width: 300, height: 200 },
    padL: 10,
    padT: 10,
    gapX: 10,
    gapY: 10,
    rows: 2,
    cols: 3,
    cellW: (300 - 20 - 20) / 3,
    cellH: (200 - 20 - 10) / 2,
  };

  assert.strictEqual(cell(ctx.spCellFromPoint(g, 15, 15)), '0:0');
  assert.strictEqual(cell(ctx.spCellFromPoint(g, 150, 15)), '0:1');
  assert.strictEqual(cell(ctx.spCellFromPoint(g, 285, 190)), '1:2');
});

check('a drag past the edge keeps selecting to the edge', () => {
  const g = {
    box: { left: 0, top: 0, width: 300, height: 200 },
    padL: 10,
    padT: 10,
    gapX: 10,
    gapY: 10,
    rows: 2,
    cols: 3,
    cellW: (300 - 20 - 20) / 3,
    cellH: (200 - 20 - 10) / 2,
  };

  assert.strictEqual(cell(ctx.spCellFromPoint(g, -400, -400)), '0:0');
  assert.strictEqual(cell(ctx.spCellFromPoint(g, 4000, 4000)), '1:2');
});

// ---------------------------------------------------------------------------
// The bars
//
// A bar is a screen — one or two rows of the same buttons — so nearly nothing
// about it needs its own test. These cover the three places where it is not the
// same: the list of functions on offer, the ceilings, and the advice that stops
// a venue saving a bar that looks finished and cannot take money.
// ---------------------------------------------------------------------------

check('every bar function offered here is one the server accepts', () => {
  // The same drift check as the sale list above, and it matters more here: the
  // bar list is twenty-eight keys long and was written out twice.
  const { BAR_KEYS } = require('../src/screens');
  const offered = vm
    .runInContext('SP_BAR_GROUPS', ctx)
    .flatMap(([, keys]) => keys.map(([key]) => key));

  for (const key of offered) {
    assert.ok(BAR_KEYS.includes(key), `${key} is not a server bar key`);
  }
  assert.strictEqual(
    new Set(offered).size,
    BAR_KEYS.length,
    'the server knows bar functions the editor does not offer'
  );
});

check('a bar is offered the bar functions and a sale screen is not', () => {
  const keysOn = (surface) =>
    vm
      .runInContext('spFunctionsFor', ctx)(surface)
      .flatMap(([, keys]) => keys.map(([key]) => key));

  assert.ok(keysOn('bottombar').includes('pay'), 'a bottom bar cannot take money');
  assert.ok(keysOn('topbar').includes('open_bills'), 'a top bar cannot show its tables');
  // The one that matters. A Pay key in the middle of a page of lagers, one row
  // above Cancel, is a mis-press that costs a venue a bill.
  assert.ok(!keysOn('sale').includes('pay'), 'Pay is on offer in the sale grid');
  assert.ok(!keysOn('sale').includes('open_bills'), 'a widget is on offer in the sale grid');
});

check('a bar has a bar’s ceilings, not a screen’s', () => {
  const limits = vm.runInContext('spLimits', ctx);
  assert.strictEqual(limits('bottombar').rows, 2, 'a bar may be three rows deep');
  assert.strictEqual(limits('bottombar').cols, 16);
  assert.strictEqual(limits('sale').rows, 10);
  assert.strictEqual(limits('sale').cols, 12);
  // The default a New… dialog offers. One row, because that is what a bar is.
  assert.strictEqual(limits('topbar').defRows, 1);
});

check('a top bar with no open-tables key is called out', () => {
  // The failure this exists to stop: a venue programs its own top bar, the
  // layout is not broken in any way a machine would notice, and the venue
  // silently loses the ability to run two bills at once — discovered at the
  // counter, on a Friday.
  withState({
    current: {
      id: 1,
      surface: 'topbar',
      rows: 1,
      cols: 6,
      buttons: [{ row: 0, col: 0, kind: 'function', functionKey: 'clock' }],
    },
  });
  const issues = vm.runInContext('spIssues', ctx)();
  assert.ok(
    issues.some((i) => i.severity === 'warn' && /open-tables/i.test(i.where)),
    'a top bar with no bills strip was reported as sound'
  );
});

check('a bottom bar with no Pay key is called out', () => {
  withState({
    current: {
      id: 1,
      surface: 'bottombar',
      rows: 1,
      cols: 6,
      buttons: [{ row: 0, col: 0, kind: 'function', functionKey: 'void' }],
    },
  });
  const issues = vm.runInContext('spIssues', ctx)();
  assert.ok(
    issues.some((i) => i.severity === 'warn' && /Pay/.test(i.where)),
    'a bottom bar that cannot take money was reported as sound'
  );
});

check('a bar that has both is not nagged', () => {
  withState({
    current: {
      id: 1,
      surface: 'bottombar',
      rows: 1,
      cols: 6,
      buttons: [
        { row: 0, col: 0, kind: 'function', functionKey: 'void' },
        { row: 0, col: 1, kind: 'function', functionKey: 'pay' },
      ],
    },
  });
  assert.strictEqual(vm.runInContext('spIssues', ctx)().length, 0);
});

check('a sale screen is not asked for a Pay key', () => {
  // The advice is about bars. Offering it on a sale screen would be advice to
  // do something the server refuses.
  withState({
    current: {
      id: 1,
      surface: 'sale',
      rows: 2,
      cols: 2,
      buttons: [{ row: 0, col: 0, kind: 'function', functionKey: 'qty' }],
    },
  });
  assert.strictEqual(vm.runInContext('spIssues', ctx)().length, 0);
});

// ---------------------------------------------------------------------------
// The face on a key
// ---------------------------------------------------------------------------

check('a key with no face of its own borrows the product’s', () => {
  withState({
    products: [{ pluid: 7, product_name: 'Cappuccino', emoji: '☕', image_url: null }],
  });
  const face = vm.runInContext('spFaceFor', ctx)({ kind: 'product', pluId: 7 });
  assert.strictEqual(face.emoji, '☕');
  // The distinction the editor draws faded, and the reason "Remove" is disabled
  // on it: there is nothing on this key to remove.
  assert.strictEqual(face.own, false);
});

check('and its own beats the product’s', () => {
  withState({
    products: [{ pluid: 7, product_name: 'Cappuccino', emoji: '☕', image_url: null }],
  });
  const face = vm
    .runInContext('spFaceFor', ctx)({ kind: 'product', pluId: 7, emoji: '🔥' });
  assert.strictEqual(face.emoji, '🔥');
  assert.strictEqual(face.own, true);
});

check('a page key may carry a picture, which it never could before', () => {
  withState({});
  const face = vm
    .runInContext('spFaceFor', ctx)({ kind: 'page', targetScreenId: 2, emoji: '🍔' });
  assert.strictEqual(face.emoji, '🍔');
});

check('a key with nothing on it has no face at all', () => {
  withState({ products: [{ pluid: 7, product_name: 'Tea', emoji: null, image_url: null }] });
  assert.strictEqual(vm.runInContext('spFaceFor', ctx)({ kind: 'product', pluId: 7 }), null);
});

check('no editor calls prompt', () => {
  const live = source
    .split('\n')
    .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
    .join('\n');
  assert.ok(!/\bprompt\s*\(/.test(live), 'public/screens.js calls prompt()');
});

console.log(`\n${passed} checks passed`);
