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
      terminator = '\n];\n';
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
  'spSetKind',
  'spCovered',
  'spProductName',
  'spLabelFor',
  'spMissing',
]);

/** The module-level state those functions read. */
function withState({ current = null, products = [], screens = [] } = {}) {
  ctx.spCurrent = current;
  ctx.spProducts = products;
  ctx.spScreens = screens;
  // spCovered uses spKey, which is an arrow const the lifter does not take.
  ctx.spKey = (row, col) => `${row}:${col}`;
}

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
check('no editor calls prompt', () => {
  const live = source
    .split('\n')
    .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
    .join('\n');
  assert.ok(!/\bprompt\s*\(/.test(live), 'public/screens.js calls prompt()');
});

console.log(`\n${passed} checks passed`);
