/**
 * Screen programming — the back office editor.
 *
 * The venue's own sale-screen layouts. See
 * vesopa_epos/docs/screen-programming.md for the model; the short version is
 * that every button on the grid is one of four things, and a "category" is
 * simply a button that points at another screen.
 *
 * Its own file rather than another thousand lines of app.js, following
 * charts.js. Loaded after app.js, and it uses that file's `$`, `api`, `esc`,
 * `modal` and `kdsInkOn` — the navigation table there resolves `loadScreens`
 * when a view is opened, by which time this has parsed.
 *
 * The editor holds the whole layout locally and sends it in one PUT. A layout
 * is a few dozen rows, and "here is the screen as it now is" cannot half-apply
 * the way a stream of individual edits can. That local copy is also what makes
 * undo, drag-to-move and a grid resize possible without a round trip each —
 * and what makes it a hard rule here that nothing throws it away without
 * asking. Every place that used to reload behind the manager's back now checks
 * `spDirty()` first: a push from another browser, a resize, switching screen,
 * leaving the view, closing the tab.
 *
 * THE POINTER MODEL, because it is the part that was wrong.
 *
 * Selection used to be `pointerover` on the cells plus a full re-render of the
 * grid on every event. Two things fall out of that, and both were reported as
 * "the editor is buggy on Windows":
 *
 *   * A touch or pen pointer is implicitly captured by the element it went
 *     down on, so `pointerover` never fires on the other cells. Drag-select
 *     did nothing at all on a touchscreen — and a Windows 11 laptop very often
 *     is one.
 *   * Re-rendering the grid destroys the element the pointer is over, so even
 *     with a mouse the events arrive on nodes that no longer exist, and the
 *     inspector's product list — every product in the venue — was rebuilt on
 *     every pixel of the drag.
 *
 * So: the grid captures the pointer itself, and the cell under the finger is
 * worked out from the grid's own geometry rather than by hit-testing a node.
 * That reads the same for mouse, pen and touch, it keeps working over a cell
 * swallowed by a 2x2, and during a drag nothing is rebuilt — only the
 * `selected` class is toggled.
 */

/** The till functions a button may be bound to. Mirrors FUNCTION_KEYS. */
const SP_FUNCTIONS = [
  ['qty', 'Quantity'],
  ['note', 'Note'],
  ['covers', 'Covers'],
  ['customer', 'Customer'],
  ['open_drawer', 'No sale (open drawer)'],
  ['print_bill', 'Print bill'],
];

/**
 * Swatches, not a colour wheel.
 *
 * The same argument as the kitchen's branding editor: a wheel on a screen picks
 * a colour nobody meant, and the failure it produces — a key that cannot be
 * read across a counter — is only discovered in service. Every one of these
 * works with the ink the till picks for it.
 */
const SP_FILLS = [
  '#111111', '#1e2430', '#3a1e1e', '#14312b', '#2b1e3a', '#a5c715',
  '#4b57e8', '#21a73e', '#ce7a0a', '#d03227', '#00a6a6', '#f4f6fa',
];

/** The ceilings the server holds, repeated so the editor cannot offer more. */
const SP_MAX_ROWS = 10;
const SP_MAX_COLS = 12;

/** Deep enough to cover a session's mistakes, shallow enough to hold in hand. */
const SP_UNDO_LIMIT = 60;

let spScreens = [];
let spProducts = [];
let spHomeId = null;

/** The screen being edited, as a working copy so Revert has a target. */
let spCurrent = null;

/** The layout as the server last confirmed it — Revert's target, and the
    thing `spDirty()` compares against. */
let spSavedShape = '';

/** Cells the manager has selected, as "row:col" — always a button's own cell. */
let spSelection = new Set();

/** Where the keyboard is, and the corner Shift+arrow extends from. */
let spFocusCell = null;
let spAnchorCell = null;

let spUndoStack = [];
let spRedoStack = [];

/** Buttons copied, as offsets from the top-left of what was selected. */
let spClipboard = null;

/** key -> the cell element, so selection is painted without a re-render. */
let spCells = new Map();

let spBound = false;
let spPreview = false;

/** The product list as it was last rendered into the picker, so a redraw of
    the inspector does not rebuild a thousand options for nothing. */
let spProductOptionsSig = '';

/**
 * What an empty cell is being turned into, before it is anything.
 *
 * "Ring up a product" on six empty cells used to make six buttons that pointed
 * at no product — red, flagged as broken, and cleared again by anybody who
 * changed their mind. Now it only opens the picker, and the buttons come into
 * being when a product is chosen. Cleared as soon as the selection moves.
 */
let spPendingKind = null;
let spSelectionSig = '';

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Fetch everything the editor draws from.
 *
 * Called by app.js's render() — which is also what a socket push runs. That is
 * why the working copy is only replaced when there is nothing to lose: a price
 * changed on another machine used to wipe a half-finished layout here, and the
 * manager's only clue was that the grid blinked.
 */
async function loadScreens() {
  const [screens, products, settings] = await Promise.all([
    api('/screens'),
    api('/products'),
    api('/till-settings'),
  ]);

  spScreens = screens;
  spProducts = products;
  spHomeId = settings.home_screen_id ?? null;
  spProductOptionsSig = '';

  const keep = spCurrent && spScreens.find((s) => s.id === spCurrent.id);

  if (keep && spDirty()) {
    // Unsaved work in hand. The lists behind the pickers are refreshed — a
    // product added in another tab should be selectable here — but the layout
    // on the grid is the manager's, and it stays.
    spCurrent.name = keep.name;
  } else {
    // Stay on the screen being edited across a reload, so saving does not
    // bounce the manager back to the first one in the list.
    spSelect(keep ? keep.id : spScreens[0] ? spScreens[0].id : null);
  }

  spBind();
  spRenderChrome();
}

/** Point the editor at a screen, discarding whatever was in hand. */
function spSelect(id) {
  const found = spScreens.find((s) => s.id === id) || null;
  spCurrent = found ? JSON.parse(JSON.stringify(found)) : null;
  spSavedShape = spShape(spCurrent);
  spSelection = new Set();
  spFocusCell = null;
  spAnchorCell = null;
  spUndoStack = [];
  spRedoStack = [];
}

// ---------------------------------------------------------------------------
// The layout in hand
// ---------------------------------------------------------------------------

const spKey = (row, col) => `${row}:${col}`;

function spAt(row, col) {
  if (!spCurrent) return null;
  return spCurrent.buttons.find((b) => b.row === row && b.col === col) || null;
}

/**
 * Cells swallowed by a button's span.
 *
 * Rendered as nothing at all rather than as empty keys, so a 2x2 reads as one
 * button instead of one button and three holes. The map answers with the
 * button doing the swallowing, which is what lets a press anywhere inside a
 * 2x2 select the button rather than the hole under it.
 */
function spCovered() {
  const covered = new Map();
  for (const b of (spCurrent ? spCurrent.buttons : [])) {
    for (let r = b.row; r < b.row + (b.rowSpan || 1); r++) {
      for (let c = b.col; c < b.col + (b.colSpan || 1); c++) {
        if (r !== b.row || c !== b.col) covered.set(spKey(r, c), b);
      }
    }
  }
  return covered;
}

/**
 * The cell that actually answers for this one.
 *
 * A cell under a span belongs to the button covering it. Without this, a drag
 * across a 2x2 selected the hidden cells underneath and the inspector quietly
 * created buttons there — invisible in the editor, saved to the server, drawn
 * by nothing.
 */
function spOrigin(row, col, covered) {
  const owner = (covered || spCovered()).get(spKey(row, col));
  return owner ? { row: owner.row, col: owner.col } : { row, col };
}

function spProductName(pluId) {
  const p = spProducts.find((x) => Number(x.pluid) === Number(pluId));
  return p ? p.product_name : null;
}

/** What a button says on the till. Mirrors the renderer's fallback chain. */
function spLabelFor(b) {
  if (b.label) return b.label;
  if (b.kind === 'product') {
    // A product deleted since the layout was made. Named as such rather than
    // left blank: a blank key on a till is a key a clerk presses twice before
    // asking anybody about it.
    return spProductName(b.pluId) || 'Missing product';
  }
  if (b.kind === 'page') {
    const target = spScreens.find((s) => s.id === b.targetScreenId);
    return target ? target.name : 'Missing screen';
  }
  if (b.kind === 'function') {
    const found = SP_FUNCTIONS.find(([k]) => k === b.functionKey);
    return found ? found[1] : 'Unset function';
  }
  return '';
}

function spMissing(b) {
  if (!b) return false;
  if (b.kind === 'product') return !spProductName(b.pluId);
  if (b.kind === 'page') {
    return !spScreens.some((s) => s.id === b.targetScreenId);
  }
  if (b.kind === 'function') return !b.functionKey;
  return false;
}

/** Set the kind, clearing the references the other kinds carry. */
function spSetKind(button, kind) {
  button.kind = kind;
  // The same rule the server enforces: one reference per button. A button
  // changed from a product to a page that kept its pluId gives the renderer two
  // things to dispatch on.
  if (kind !== 'product') button.pluId = null;
  if (kind !== 'page') button.targetScreenId = null;
  if (kind !== 'function') button.functionKey = null;
}

/**
 * The layout as one comparable string.
 *
 * Sorted, so two arrays holding the same buttons in a different order compare
 * equal — otherwise moving a button and moving it back would leave the editor
 * claiming unsaved changes for ever, and a warning that cries wolf is one a
 * manager learns to click through.
 */
function spShape(screen) {
  if (!screen) return '';
  const buttons = (screen.buttons || [])
    .map((b) =>
      [
        b.row,
        b.col,
        b.rowSpan || 1,
        b.colSpan || 1,
        b.kind,
        b.pluId ?? '',
        b.targetScreenId ?? '',
        b.functionKey ?? '',
        b.label ?? '',
        b.fill ?? '',
        b.ink ?? '',
      ].join('|')
    )
    .sort();
  return JSON.stringify({ rows: screen.rows, cols: screen.cols, buttons });
}

function spDirty() {
  return !!spCurrent && spShape(spCurrent) !== spSavedShape;
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

/** A deep copy of everything an undo has to put back. */
function spSnapshot() {
  return {
    rows: spCurrent.rows,
    cols: spCurrent.cols,
    buttons: JSON.parse(JSON.stringify(spCurrent.buttons)),
    selection: [...spSelection],
  };
}

function spRestore(snapshot) {
  spCurrent.rows = snapshot.rows;
  spCurrent.cols = snapshot.cols;
  spCurrent.buttons = JSON.parse(JSON.stringify(snapshot.buttons));
  spSelection = new Set(snapshot.selection);
}

/**
 * Make the layout legal again after an edit.
 *
 * Everything that can be produced by dragging, spanning or pasting is bounded
 * here rather than at each call site, and in the same order the server does it
 * — so what the editor shows after an edit is what comes back from a save.
 */
function spTidy() {
  const grid = spCurrent;

  // Blanks are not stored — an empty cell already means empty — and anything
  // off the grid is gone rather than clamped, because clamping moves a button
  // on top of another one and calls that a save.
  let buttons = grid.buttons.filter(
    (b) =>
      b &&
      b.kind !== 'blank' &&
      Number.isFinite(b.row) &&
      Number.isFinite(b.col) &&
      b.row >= 0 &&
      b.row < grid.rows &&
      b.col >= 0 &&
      b.col < grid.cols
  );

  for (const b of buttons) {
    b.row = Math.round(b.row);
    b.col = Math.round(b.col);
    b.rowSpan = Math.max(1, Math.min(grid.rows - b.row, Number(b.rowSpan) || 1));
    b.colSpan = Math.max(1, Math.min(grid.cols - b.col, Number(b.colSpan) || 1));
  }

  // One button per cell. The last one placed wins, which is what a drop on top
  // of something means.
  const byCell = new Map();
  for (const b of buttons) byCell.set(spKey(b.row, b.col), b);
  buttons = [...byCell.values()].sort((a, b) => a.row - b.row || a.col - b.col);

  // A button whose own cell is underneath somebody else's span cannot be seen
  // or pressed. Reading order decides which survives, so the one further up and
  // left keeps its ground.
  const kept = [];
  const taken = new Set();
  for (const b of buttons) {
    if (taken.has(spKey(b.row, b.col))) continue;
    kept.push(b);
    for (let r = b.row; r < b.row + b.rowSpan; r++) {
      for (let c = b.col; c < b.col + b.colSpan; c++) taken.add(spKey(r, c));
    }
  }
  grid.buttons = kept;

  // A selection can survive a resize or a delete pointing at nothing. Cells
  // that no longer exist are dropped; cells now under a span move to it.
  const covered = spCovered();
  const selection = new Set();
  for (const key of spSelection) {
    const [row, col] = key.split(':').map(Number);
    if (row >= grid.rows || col >= grid.cols) continue;
    const origin = spOrigin(row, col, covered);
    selection.add(spKey(origin.row, origin.col));
  }
  spSelection = selection;
}

/**
 * Run one edit, with undo around it.
 *
 * A mutation that changes nothing leaves no undo step behind — otherwise
 * clicking the same swatch twice costs two presses of Ctrl+Z, and undo stops
 * being trustworthy.
 */
function spEdit(mutate) {
  if (!spCurrent) return false;
  const before = spSnapshot();
  if (mutate() === false) return false;
  spTidy();
  if (spShape(spCurrent) === spShape(before)) {
    spRenderStatus();
    return false;
  }
  spUndoStack.push(before);
  if (spUndoStack.length > SP_UNDO_LIMIT) spUndoStack.shift();
  spRedoStack = [];
  spAfterChange();
  return true;
}

function spUndo() {
  if (!spCurrent || !spUndoStack.length) return;
  const now = spSnapshot();
  spRestore(spUndoStack.pop());
  spRedoStack.push(now);
  spAfterChange();
}

function spRedo() {
  if (!spCurrent || !spRedoStack.length) return;
  const now = spSnapshot();
  spRestore(spRedoStack.pop());
  spUndoStack.push(now);
  spAfterChange();
}

function spAfterChange() {
  // The row and column boxes are part of the layout, so an undo has to put
  // them back too — otherwise the grid says five rows and the box says six.
  spSet($('sp-rows'), String(spCurrent.rows));
  spSet($('sp-cols'), String(spCurrent.cols));
  spRenderGrid();
  spRenderInspector();
  spRenderStatus();
}

/**
 * Apply a change to every selected cell.
 *
 * `create` is the difference between "make this a product" — which has to
 * bring a button into being on an empty cell — and "colour this" — which does
 * not, because a coloured blank is dropped on the way to the server and the
 * manager is left wondering why the colour did not stick.
 */
function spApplyToSelection(mutate, { create = true } = {}) {
  if (!spCurrent || !spSelection.size) return false;
  return spEdit(() => {
    for (const key of spSelection) {
      const [row, col] = key.split(':').map(Number);
      let button = spAt(row, col);
      if (!button) {
        if (!create) continue;
        button = { row, col, rowSpan: 1, colSpan: 1, kind: 'blank' };
        spCurrent.buttons.push(button);
      }
      mutate(button);
    }
  });
}

/** The buttons under the current selection, in reading order. */
function spSelectedButtons() {
  return [...spSelection]
    .map((k) => k.split(':').map(Number))
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
    .map(([row, col]) => spAt(row, col))
    .filter(Boolean);
}

/**
 * Move — or copy — the selected buttons by a delta.
 *
 * Refused outright if any of them would land off the grid, rather than moving
 * the ones that fit: half a moved block is a layout nobody arranged, and the
 * manager cannot see what they have lost.
 */
function spMoveSelection(dRow, dCol, { copy = false } = {}) {
  if (!spCurrent || (!dRow && !dCol)) return false;
  const moving = spSelectedButtons();
  if (!moving.length) return false;

  for (const b of moving) {
    const row = b.row + dRow;
    const col = b.col + dCol;
    if (row < 0 || col < 0) return false;
    if (row + b.rowSpan > spCurrent.rows) return false;
    if (col + b.colSpan > spCurrent.cols) return false;
  }

  return spEdit(() => {
    const clones = moving.map((b) => ({ ...b, row: b.row + dRow, col: b.col + dCol }));
    if (!copy) {
      const lifted = new Set(moving.map((b) => spKey(b.row, b.col)));
      spCurrent.buttons = spCurrent.buttons.filter(
        (b) => !lifted.has(spKey(b.row, b.col))
      );
    }
    // Anything already sitting where the block lands is displaced, the way a
    // drop on top of something has to mean.
    const landing = new Set(clones.map((b) => spKey(b.row, b.col)));
    spCurrent.buttons = spCurrent.buttons.filter(
      (b) => !landing.has(spKey(b.row, b.col))
    );
    spCurrent.buttons.push(...clones);
    spSelection = new Set(clones.map((b) => spKey(b.row, b.col)));
  });
}

/** Copy the selection, keeping its shape so a paste lands as it was arranged. */
function spCopySelection() {
  const chosen = spSelectedButtons();
  if (!chosen.length) return false;
  const row0 = Math.min(...chosen.map((b) => b.row));
  const col0 = Math.min(...chosen.map((b) => b.col));
  spClipboard = chosen.map((b) => ({
    ...JSON.parse(JSON.stringify(b)),
    row: b.row - row0,
    col: b.col - col0,
  }));
  spRenderStatus();
  spRenderInspector();
  return true;
}

/** Paste at the top-left of the selection, or at the keyboard's cell. */
function spPasteClipboard() {
  if (!spCurrent || !spClipboard || !spClipboard.length) return false;
  const target =
    spSelection.size
      ? [...spSelection]
          .map((k) => k.split(':').map(Number))
          .sort((a, b) => a[0] - b[0] || a[1] - b[1])[0]
      : spFocusCell
        ? [spFocusCell.row, spFocusCell.col]
        : [0, 0];

  return spEdit(() => {
    const placed = [];
    for (const b of spClipboard) {
      const row = target[0] + b.row;
      const col = target[1] + b.col;
      // Whatever runs off the edge is simply not pasted. Refusing the whole
      // paste for one button that will not fit is the less useful of the two.
      if (row >= spCurrent.rows || col >= spCurrent.cols) continue;
      placed.push({ ...b, row, col });
    }
    if (!placed.length) return false;
    const landing = new Set(placed.map((b) => spKey(b.row, b.col)));
    spCurrent.buttons = spCurrent.buttons.filter(
      (b) => !landing.has(spKey(b.row, b.col))
    );
    spCurrent.buttons.push(...placed);
    spSelection = landing;
  });
}

/**
 * Resize the grid, in hand rather than on the server.
 *
 * This used to PUT immediately and reload, which threw away every unsaved
 * button on the screen — change the row count after twenty minutes of work and
 * the twenty minutes went with it. Now it is an edit like any other: undoable,
 * and saved with the rest.
 */
function spResizeGrid(rows, cols) {
  if (!spCurrent) return;
  const wanted = {
    rows: Math.max(1, Math.min(SP_MAX_ROWS, Number(rows) || spCurrent.rows)),
    cols: Math.max(1, Math.min(SP_MAX_COLS, Number(cols) || spCurrent.cols)),
  };
  if (wanted.rows === spCurrent.rows && wanted.cols === spCurrent.cols) return;

  const lost = spCurrent.buttons.filter(
    (b) => b.row >= wanted.rows || b.col >= wanted.cols
  );
  if (
    lost.length &&
    !confirm(
      `${lost.length} button${lost.length === 1 ? '' : 's'} fall outside a ` +
        `${wanted.rows} × ${wanted.cols} grid and will be removed. Continue?`
    )
  ) {
    $('sp-rows').value = spCurrent.rows;
    $('sp-cols').value = spCurrent.cols;
    return;
  }

  spEdit(() => {
    spCurrent.rows = wanted.rows;
    spCurrent.cols = wanted.cols;
  });
}

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------

function spRenderChrome() {
  const picker = $('sp-screen');
  picker.innerHTML = spScreens.length
    ? spScreens
        .map(
          (s) =>
            `<option value="${s.id}"${s.id === (spCurrent && spCurrent.id) ? ' selected' : ''}>` +
            esc(s.name) +
            (s.id === spHomeId ? ' — opens on tills' : '') +
            '</option>'
        )
        .join('')
    : '<option value="">No screens yet</option>';

  const has = !!spCurrent;
  const at = has ? spScreens.findIndex((s) => s.id === spCurrent.id) : -1;
  for (const id of [
    'sp-rename',
    'sp-duplicate',
    'sp-delete',
    'sp-save',
    'sp-revert',
    'sp-fill',
  ]) {
    $(id).disabled = !has;
  }
  $('sp-up').disabled = at <= 0;
  $('sp-down').disabled = at < 0 || at >= spScreens.length - 1;

  $('sp-rows').value = has ? spCurrent.rows : '';
  $('sp-cols').value = has ? spCurrent.cols : '';
  $('sp-rows').disabled = !has;
  $('sp-cols').disabled = !has;
  $('sp-home').checked = has && spCurrent.id === spHomeId;
  $('sp-home').disabled = !has;
  $('sp-preview').checked = spPreview;
  $('sp-preview').disabled = !has;

  $('sp-dept').innerHTML = [
    ...new Set(spProducts.map((p) => p.department_name).filter(Boolean)),
  ]
    .sort()
    .map((d) => `<option value="${esc(d)}">${esc(d)}</option>`)
    .join('');

  spRenderGrid();
  spRenderInspector();
  spRenderStatus();
}

// ---------------------------------------------------------------------------
// The grid
// ---------------------------------------------------------------------------

function spRenderGrid() {
  const box = $('sp-grid');
  spCells = new Map();

  if (!spCurrent) {
    box.removeAttribute('style');
    box.classList.remove('preview');
    box.innerHTML =
      '<p class="muted small" style="padding:24px">This venue has no programmed screens, so ' +
      'tills are showing the built-in <strong>Default</strong> — the one drawn from your ' +
      'product list. Press <strong>New…</strong> to lay one out.</p>';
    return;
  }

  const covered = spCovered();
  box.classList.toggle('preview', spPreview);
  box.style.gridTemplateColumns = `repeat(${spCurrent.cols}, 1fr)`;
  box.style.gridTemplateRows = `repeat(${spCurrent.rows}, 1fr)`;
  box.innerHTML = '';

  const fragment = document.createDocumentFragment();
  for (let r = 0; r < spCurrent.rows; r++) {
    for (let c = 0; c < spCurrent.cols; c++) {
      if (covered.has(spKey(r, c))) continue;

      const b = spAt(r, c);
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'sp-cell';
      cell.dataset.row = r;
      cell.dataset.col = c;
      // The cell is never a tab stop of its own: the grid takes the focus and
      // the arrow keys walk it, so Tab still leaves for the inspector rather
      // than crawling through sixty keys.
      cell.tabIndex = -1;

      cell.style.gridRow = `${r + 1} / span ${b ? b.rowSpan || 1 : 1}`;
      cell.style.gridColumn = `${c + 1} / span ${b ? b.colSpan || 1 : 1}`;
      if (b && b.fill) {
        cell.style.background = b.fill;
        cell.style.color = b.ink || kdsInkOn(b.fill);
      }
      if (b) {
        cell.classList.add('filled');
        if (spMissing(b)) cell.classList.add('missing');
        cell.title = spCellTitle(b);
      }

      const text = document.createElement('span');
      text.textContent = b ? spLabelFor(b) : '';
      cell.append(text);

      if (b && b.kind === 'page') {
        const arrow = document.createElement('em');
        arrow.className = 'sp-arrow';
        arrow.textContent = '›››';
        cell.append(arrow);
      }
      if (b && b.kind === 'function') {
        const mark = document.createElement('em');
        mark.className = 'sp-arrow';
        mark.textContent = 'ƒ';
        cell.append(mark);
      }

      spCells.set(spKey(r, c), cell);
      fragment.append(cell);
    }
  }
  box.append(fragment);
  spPaintSelection();
}

/** What hovering a key says. Worth having: the grid shows a name, not a PLU. */
function spCellTitle(b) {
  if (b.kind === 'product') {
    const name = spProductName(b.pluId);
    return name
      ? `Product ${b.pluId} — ${name}`
      : `Product ${b.pluId} — no longer in the catalogue`;
  }
  if (b.kind === 'page') {
    const target = spScreens.find((s) => s.id === b.targetScreenId);
    return target ? `Goes to ${target.name}` : 'Goes to a screen that has been deleted';
  }
  if (b.kind === 'function') {
    const found = SP_FUNCTIONS.find(([k]) => k === b.functionKey);
    return found ? `Till function — ${found[1]}` : 'Till function — none chosen';
  }
  return '';
}

/** Selection is a class, not a redraw. This runs on every pixel of a drag. */
function spPaintSelection() {
  for (const [key, cell] of spCells) {
    cell.classList.toggle('selected', spSelection.has(key));
    cell.classList.toggle(
      'caret',
      !!spFocusCell && key === spKey(spFocusCell.row, spFocusCell.col)
    );
  }
}

function spPaintDrop(target, anchor) {
  const dRow = target.row - anchor.row;
  const dCol = target.col - anchor.col;
  const landing = new Set(
    spSelectedButtons().map((b) => spKey(b.row + dRow, b.col + dCol))
  );
  for (const [key, cell] of spCells) cell.classList.toggle('drop', landing.has(key));
}

function spClearDrop() {
  for (const cell of spCells.values()) cell.classList.remove('drop');
}

// ---------------------------------------------------------------------------
// Status and the check list
// ---------------------------------------------------------------------------

function spRenderStatus() {
  const status = $('sp-status');
  if (!spCurrent) {
    status.textContent = '';
    $('sp-undo').disabled = true;
    $('sp-redo').disabled = true;
    $('sp-issues-card').hidden = true;
    return;
  }

  const cells = spCurrent.rows * spCurrent.cols;
  const used = spCurrent.buttons.reduce(
    (n, b) => n + (b.rowSpan || 1) * (b.colSpan || 1),
    0
  );
  const broken = spCurrent.buttons.filter(spMissing);

  const parts = [
    `${spCurrent.buttons.length} button${spCurrent.buttons.length === 1 ? '' : 's'} ` +
      `over ${used} of ${cells} cells`,
  ];
  if (spSelection.size) parts.push(`${spSelection.size} selected`);
  if (spClipboard && spClipboard.length) {
    parts.push(`${spClipboard.length} copied`);
  }
  status.innerHTML =
    `<span>${esc(parts.join(' · '))}</span>` +
    (spDirty()
      ? '<span class="sp-flag warn">Unsaved changes</span>'
      : '<span class="sp-flag ok">Saved</span>') +
    (broken.length
      ? `<span class="sp-flag bad">${broken.length} broken</span>`
      : '');

  $('sp-undo').disabled = !spUndoStack.length;
  $('sp-redo').disabled = !spRedoStack.length;

  // The check list. Only shown when there is something wrong with the layout,
  // because a permanently empty panel is one nobody reads when it fills up.
  const issues = $('sp-issues');
  $('sp-issues-card').hidden = !broken.length;
  issues.innerHTML = broken
    .map(
      (b) =>
        `<button type="button" class="sp-issue" data-row="${b.row}" data-col="${b.col}">` +
        `<strong>Row ${b.row + 1}, column ${b.col + 1}</strong>` +
        `<span class="muted small">${esc(spCellTitle(b))}</span></button>`
    )
    .join('');
}

// ---------------------------------------------------------------------------
// The inspector
// ---------------------------------------------------------------------------

function spRenderInspector() {
  const count = spSelection.size;
  const chosen = spSelectedButtons();

  // A kind chosen for empty cells belongs to those cells and nothing else.
  const sig = [...spSelection].sort().join(',');
  if (sig !== spSelectionSig) {
    spSelectionSig = sig;
    spPendingKind = null;
  }

  $('sp-sel-title').textContent =
    count === 0 ? 'Nothing selected' : count === 1 ? 'One button' : `${count} buttons`;
  $('sp-sel-hint').textContent =
    count === 0
      ? 'Pick a button on the left to change what it does.'
      : count === 1
        ? 'Changes apply as you make them.'
        : 'Changes apply to all of them at once.';

  $('sp-inspector').hidden = count === 0;
  $('sp-paste').disabled = !spClipboard || !spClipboard.length;
  $('sp-copy').disabled = !chosen.length;
  if (!count) return;

  // With a mixed selection the controls show the first one's value and applying
  // any of them sets the lot. That is the honest behaviour for a bulk edit, and
  // it is what makes "colour these six the same" a single action.
  const first = chosen[0] || { kind: 'blank' };

  spSet($('sp-kind'), chosen.length ? first.kind || 'blank' : spPendingKind || 'blank');
  const kind = $('sp-kind').value;
  document.querySelectorAll('#sp-inspector .sp-field').forEach((el) => {
    el.hidden = el.dataset.for !== kind;
  });

  spRenderProductOptions(first.pluId);

  $('sp-target').innerHTML =
    '<option value="">Choose a screen…</option>' +
    spScreens
      // A screen may not point at itself: the button would do nothing and look
      // broken, and there is no reading of it that is useful.
      .filter((s) => s.id !== spCurrent.id)
      .map(
        (s) =>
          `<option value="${s.id}"${
            s.id === first.targetScreenId ? ' selected' : ''
          }>${esc(s.name)}</option>`
      )
      .join('');

  $('sp-function').innerHTML =
    '<option value="">Choose a function…</option>' +
    SP_FUNCTIONS.map(
      ([key, label]) =>
        `<option value="${key}"${key === first.functionKey ? ' selected' : ''}>` +
        esc(label) +
        '</option>'
    ).join('');

  spSet($('sp-label'), first.label || '');
  spSet($('sp-rowspan'), String(first.rowSpan || 1));
  spSet($('sp-colspan'), String(first.colSpan || 1));
  // A span is a single-button idea. Applied to a multi-selection, buttons grow
  // over each other.
  $('sp-rowspan').disabled = count !== 1 || !chosen.length;
  $('sp-colspan').disabled = count !== 1 || !chosen.length;

  // Styling and labelling a cell that does nothing is styling something that is
  // never stored — the server drops blanks, and so does this editor. Saying so
  // beats letting a manager colour six empty cells and wonder where it went.
  const styleable = chosen.length > 0;
  $('sp-label').disabled = !styleable;
  $('sp-clear-style').disabled = !styleable;
  $('sp-ink').disabled = !styleable;
  $('sp-style-note').hidden = styleable;

  spSet($('sp-ink'), first.ink ? 'dark' : 'auto');
  if (first.ink) {
    // Only two overrides are offered, and which one this is comes from the ink
    // itself rather than a third stored field.
    spSet($('sp-ink'), first.ink === '#f4f6fa' ? 'light' : 'dark');
  }

  $('sp-fills').innerHTML = SP_FILLS.map(
    (fill) =>
      `<button type="button" class="sp-swatch${
        first.fill === fill ? ' on' : ''
      }" style="background:${fill}" data-fill="${fill}" title="${fill}"></button>`
  ).join('');
}

/**
 * Write a value into a control the manager is not currently in.
 *
 * The label field used to be rewritten on every keystroke by the redraw the
 * keystroke itself caused: the trimmed value went back in, the caret jumped to
 * the end, and a trailing space could not be typed at all. Nothing writes over
 * a focused control now.
 */
function spSet(el, value) {
  if (document.activeElement === el) return;
  el.value = value;
}

/**
 * The product picker, filtered.
 *
 * A venue with nine hundred products had a select with nine hundred options in
 * it, rebuilt on every render. It is built when the list or the search changes
 * and not otherwise, and the search is the reason it is usable at all.
 */
function spRenderProductOptions(selectedPlu) {
  const query = $('sp-product-q').value.trim().toLowerCase();
  const matches = spProducts.filter((p) => {
    if (!query) return true;
    return (
      String(p.product_name || '').toLowerCase().includes(query) ||
      String(p.department_name || '').toLowerCase().includes(query) ||
      String(p.pluid).includes(query)
    );
  });

  const sig = `${query}|${spProducts.length}|${matches.length}`;
  if (sig !== spProductOptionsSig) {
    spProductOptionsSig = sig;
    $('sp-product').innerHTML =
      '<option value="">Choose a product…</option>' +
      matches
        .map(
          (p) =>
            `<option value="${p.pluid}">${esc(p.product_name)}${
              p.department_name ? ' — ' + esc(p.department_name) : ''
            }</option>`
        )
        .join('');
    $('sp-product-count').textContent = query
      ? `${matches.length} of ${spProducts.length} products`
      : `${spProducts.length} products`;
  }
  spSet($('sp-product'), selectedPlu == null ? '' : String(selectedPlu));
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

function spSelectRect(from, to, { additive = false, base = null } = {}) {
  const covered = spCovered();
  const r0 = Math.min(from.row, to.row);
  const r1 = Math.max(from.row, to.row);
  const c0 = Math.min(from.col, to.col);
  const c1 = Math.max(from.col, to.col);

  const selection = additive ? new Set(base || spSelection) : new Set();
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const origin = spOrigin(r, c, covered);
      selection.add(spKey(origin.row, origin.col));
    }
  }
  spSelection = selection;
}

function spSelectAll() {
  if (!spCurrent) return;
  const covered = spCovered();
  const selection = new Set();
  for (let r = 0; r < spCurrent.rows; r++) {
    for (let c = 0; c < spCurrent.cols; c++) {
      if (covered.has(spKey(r, c))) continue;
      selection.add(spKey(r, c));
    }
  }
  spSelection = selection;
  spPaintSelection();
  spRenderInspector();
  spRenderStatus();
}

// ---------------------------------------------------------------------------
// The pointer
// ---------------------------------------------------------------------------

let spDrag = null;

/**
 * Where the cells are, measured rather than assumed.
 *
 * Taken from the grid's own computed padding and gaps so a change to the
 * stylesheet cannot put the hit-testing out by a few pixels — the sort of bug
 * that shows up as "sometimes it selects the wrong key".
 */
function spGridGeometry() {
  const grid = $('sp-grid');
  const box = grid.getBoundingClientRect();
  const style = getComputedStyle(grid);
  const padL = parseFloat(style.paddingLeft) || 0;
  const padR = parseFloat(style.paddingRight) || 0;
  const padT = parseFloat(style.paddingTop) || 0;
  const padB = parseFloat(style.paddingBottom) || 0;
  const gapX = parseFloat(style.columnGap) || 0;
  const gapY = parseFloat(style.rowGap) || 0;
  const cols = spCurrent.cols;
  const rows = spCurrent.rows;

  return {
    box,
    padL,
    padT,
    gapX,
    gapY,
    rows,
    cols,
    cellW: (box.width - padL - padR - gapX * (cols - 1)) / cols,
    cellH: (box.height - padT - padB - gapY * (rows - 1)) / rows,
  };
}

function spCellFromPoint(g, x, y) {
  const col = Math.floor((x - g.box.left - g.padL) / (g.cellW + g.gapX));
  const row = Math.floor((y - g.box.top - g.padT) / (g.cellH + g.gapY));
  // Clamped rather than dropped, so dragging past the edge of the grid keeps
  // extending the box to the edge instead of stopping dead.
  return {
    row: Math.max(0, Math.min(g.rows - 1, row)),
    col: Math.max(0, Math.min(g.cols - 1, col)),
  };
}

function spDragStart(e) {
  if (!spCurrent || (e.pointerType === 'mouse' && e.button !== 0)) return;
  const grid = $('sp-grid');
  if (!grid.contains(e.target)) return;

  e.preventDefault();
  grid.focus();

  const g = spGridGeometry();
  const under = spCellFromPoint(g, e.clientX, e.clientY);
  const anchor = spOrigin(under.row, under.col);
  const key = spKey(anchor.row, anchor.col);
  const toggle = e.ctrlKey || e.metaKey;

  // Capture on the grid, not on the cell. This is the whole fix: every
  // subsequent pointermove arrives here whatever the finger is over, including
  // on a touchscreen, where the cell would otherwise have swallowed the lot.
  try {
    grid.setPointerCapture(e.pointerId);
  } catch {
    // Some pointers cannot be captured (a synthetic event in a test, say).
    // Selection still works, it just stops at the edge of the grid.
  }

  spDrag = {
    pointerId: e.pointerId,
    g,
    anchor,
    base: new Set(spSelection),
    mode: 'select',
    copy: e.altKey,
  };

  if (toggle) {
    if (spSelection.has(key)) spSelection.delete(key);
    else spSelection.add(key);
    spDrag.mode = 'toggle';
  } else if (e.shiftKey && spAnchorCell) {
    // Shift extends from where the last press was, which is what every grid a
    // manager has ever used does.
    spSelectRect(spAnchorCell, anchor);
    spDrag.anchor = spAnchorCell;
  } else if (spAt(anchor.row, anchor.col) && spSelection.has(key)) {
    // A press inside the selection picks it up. Anywhere else — including on a
    // programmed key that is not selected — draws a box.
    //
    // That distinction is the whole gesture, and getting it wrong made the
    // editor unusable on exactly the screens that matter. Treating a press on
    // any filled key as the start of a move meant that on a screen with no
    // empty cells left — which is what a finished layout is — a drag could
    // never select anything, and the panel's bulk edits were unreachable. So
    // moving is "click it, then drag it", which is what every editor a manager
    // has ever used does, and dragging is always a box.
    spDrag.mode = 'maybe-move';
  } else {
    spSelection = new Set([key]);
    spDrag.base = new Set();
    spDrag.mode = 'select';
  }

  spFocusCell = anchor;
  if (!e.shiftKey) spAnchorCell = anchor;
  spPaintSelection();
  spRenderInspector();
  spRenderStatus();
}

function spDragMove(e) {
  if (!spDrag || e.pointerId !== spDrag.pointerId || !spCurrent) return;
  if (spDrag.mode === 'toggle') return;

  const cell = spCellFromPoint(spDrag.g, e.clientX, e.clientY);
  const over = spOrigin(cell.row, cell.col);

  if (spDrag.mode === 'maybe-move') {
    if (over.row === spDrag.anchor.row && over.col === spDrag.anchor.col) return;
    spDrag.mode = 'move';
    $('sp-grid').classList.add('moving');
  }

  if (spDrag.mode === 'move') {
    spDrag.target = over;
    spPaintDrop(over, spDrag.anchor);
    return;
  }

  spSelectRect(spDrag.anchor, over, { additive: true, base: spDrag.base });
  spFocusCell = over;
  spPaintSelection();
  // The counts, not the controls. Rebuilding the pickers here is what made the
  // drag stutter on a large catalogue.
  spRenderStatus();
}

function spDragEnd(e) {
  if (!spDrag) return;
  const drag = spDrag;
  spDrag = null;

  try {
    $('sp-grid').releasePointerCapture(drag.pointerId);
  } catch {
    // Already released — the pointer left the window, or was cancelled.
  }
  $('sp-grid').classList.remove('moving');
  spClearDrop();

  if (drag.mode === 'move' && drag.target) {
    const copy = drag.copy || (e && e.altKey);
    spMoveSelection(
      drag.target.row - drag.anchor.row,
      drag.target.col - drag.anchor.col,
      { copy }
    );
  }

  spRenderInspector();
  spRenderStatus();
}

// ---------------------------------------------------------------------------
// The keyboard
// ---------------------------------------------------------------------------

function spGridKeys(e) {
  if (!spCurrent) return;
  const ctrl = e.ctrlKey || e.metaKey;

  if (ctrl && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    return e.shiftKey ? spRedo() : spUndo();
  }
  if (ctrl && e.key.toLowerCase() === 'y') {
    e.preventDefault();
    return spRedo();
  }
  if (ctrl && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    return spSelectAll();
  }
  if (ctrl && e.key.toLowerCase() === 'c') {
    e.preventDefault();
    return void spCopySelection();
  }
  if (ctrl && e.key.toLowerCase() === 'x') {
    e.preventDefault();
    if (spCopySelection()) spApplyToSelection((b) => spSetKind(b, 'blank'), { create: false });
    return;
  }
  if (ctrl && e.key.toLowerCase() === 'v') {
    e.preventDefault();
    return void spPasteClipboard();
  }
  if (ctrl && e.key.toLowerCase() === 'd') {
    e.preventDefault();
    if (spCopySelection()) spPasteClipboard();
    return;
  }
  if (ctrl && e.key.toLowerCase() === 's') {
    e.preventDefault();
    return void spSaveLayout();
  }

  if (e.key === 'Backspace' || e.key === 'Delete') {
    e.preventDefault();
    return void spApplyToSelection((b) => spSetKind(b, 'blank'), { create: false });
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    spSelection = new Set();
    spPaintSelection();
    spRenderInspector();
    spRenderStatus();
    return;
  }

  const step = {
    ArrowUp: [-1, 0],
    ArrowDown: [1, 0],
    ArrowLeft: [0, -1],
    ArrowRight: [0, 1],
  }[e.key];
  if (!step) return;
  e.preventDefault();

  // Alt turns the arrows into "move what is selected", which is the same
  // gesture as dragging it and the only way to nudge a button by one cell
  // without a steady hand.
  if (e.altKey) return void spMoveSelection(step[0], step[1]);

  const from = spFocusCell || spAnchorCell || { row: 0, col: 0 };
  const to = {
    row: Math.max(0, Math.min(spCurrent.rows - 1, from.row + step[0])),
    col: Math.max(0, Math.min(spCurrent.cols - 1, from.col + step[1])),
  };
  const landing = spOrigin(to.row, to.col);

  if (e.shiftKey) {
    spSelectRect(spAnchorCell || from, landing);
  } else {
    spSelection = new Set([spKey(landing.row, landing.col)]);
    spAnchorCell = landing;
  }
  spFocusCell = landing;
  spPaintSelection();
  spRenderInspector();
  spRenderStatus();
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function spBind() {
  if (spBound) return;
  spBound = true;

  $('sp-screen').addEventListener('change', (e) => {
    if (!spGuardUnsaved()) {
      spRenderChrome();
      return;
    }
    spSelect(Number(e.target.value));
    spRenderChrome();
  });

  $('sp-new').addEventListener('click', spNewScreen);
  $('sp-rename').addEventListener('click', spRenameScreen);
  $('sp-duplicate').addEventListener('click', spDuplicateScreen);
  $('sp-delete').addEventListener('click', spDeleteScreen);
  $('sp-save').addEventListener('click', spSaveLayout);
  $('sp-undo').addEventListener('click', spUndo);
  $('sp-redo').addEventListener('click', spRedo);
  $('sp-up').addEventListener('click', () => spReorder(-1));
  $('sp-down').addEventListener('click', () => spReorder(1));
  $('sp-revert').addEventListener('click', () => {
    if (spDirty() && !confirm('Throw away the changes on this screen?')) return;
    spSelect(spCurrent ? spCurrent.id : null);
    spRenderChrome();
  });

  for (const id of ['sp-rows', 'sp-cols']) {
    $(id).addEventListener('change', () =>
      spResizeGrid($('sp-rows').value, $('sp-cols').value)
    );
  }
  $('sp-home').addEventListener('change', spSetHome);
  $('sp-preview').addEventListener('change', (e) => {
    spPreview = e.target.checked;
    spRenderGrid();
  });

  // ---- The grid itself ----
  const grid = $('sp-grid');
  grid.addEventListener('pointerdown', spDragStart);
  grid.addEventListener('pointermove', spDragMove);
  grid.addEventListener('pointerup', spDragEnd);
  grid.addEventListener('pointercancel', spDragEnd);
  // A pointer released outside the window never reaches the grid even with
  // capture, and a drag that never ends leaves the next click selecting a box.
  window.addEventListener('pointerup', (e) => {
    if (spDrag && e.pointerId === spDrag.pointerId && !grid.contains(e.target)) {
      spDragEnd(e);
    }
  });
  // The browser's own drag-and-drop would otherwise start on a button and
  // cancel the pointer stream halfway through a move.
  grid.addEventListener('dragstart', (e) => e.preventDefault());
  grid.addEventListener('contextmenu', (e) => {
    if (spDrag) e.preventDefault();
  });
  grid.addEventListener('keydown', spGridKeys);

  $('sp-issues').addEventListener('click', (e) => {
    const issue = e.target.closest('.sp-issue');
    if (!issue) return;
    const cell = { row: Number(issue.dataset.row), col: Number(issue.dataset.col) };
    spSelection = new Set([spKey(cell.row, cell.col)]);
    spFocusCell = cell;
    spAnchorCell = cell;
    spPaintSelection();
    spRenderInspector();
    spRenderStatus();
    grid.focus();
  });

  // ---- The inspector ----
  $('sp-kind').addEventListener('change', (e) => {
    spPendingKind = e.target.value;
    // Only cells that already hold a button change here. On empty cells this
    // reveals the picker and nothing else — the buttons are made when a product,
    // a screen or a function is actually chosen, so a change of mind leaves the
    // grid as it was rather than strewn with keys that point at nothing.
    if (spSelectedButtons().length) {
      spApplyToSelection((b) => spSetKind(b, e.target.value), { create: false });
    }
    spRenderInspector();
  });
  $('sp-product-q').addEventListener('input', () => {
    spProductOptionsSig = '';
    const first = spSelectedButtons()[0];
    spRenderProductOptions(first ? first.pluId : null);
  });
  $('sp-product').addEventListener('change', (e) => {
    const plu = Number(e.target.value);
    if (!plu) return;
    spApplyToSelection((b) => {
      spSetKind(b, 'product');
      b.pluId = plu;
    });
  });
  $('sp-target').addEventListener('change', (e) => {
    const id = Number(e.target.value);
    if (!id) return;
    spApplyToSelection((b) => {
      spSetKind(b, 'page');
      b.targetScreenId = id;
    });
  });
  $('sp-function').addEventListener('change', (e) => {
    if (!e.target.value) return;
    spApplyToSelection((b) => {
      spSetKind(b, 'function');
      b.functionKey = e.target.value;
    });
  });
  // On change rather than on input: a label is committed when the manager
  // leaves the field, so the undo stack holds "renamed this key" once instead
  // of once per letter.
  $('sp-label').addEventListener('change', (e) => {
    const label = e.target.value.trim().slice(0, 40);
    spApplyToSelection(
      (b) => {
        b.label = label || null;
      },
      { create: false }
    );
  });
  $('sp-fills').addEventListener('click', (e) => {
    const swatch = e.target.closest('.sp-swatch');
    if (!swatch) return;
    spApplyToSelection(
      (b) => {
        b.fill = swatch.dataset.fill;
        b.ink = null;
      },
      { create: false }
    );
  });
  // Light or dark lettering, rather than a second colour picker. The till works
  // one out from the fill and gets it right nearly always; this is for the
  // nearly, and neither choice can produce a key that cannot be read.
  $('sp-ink').addEventListener('change', (e) => {
    const ink =
      e.target.value === 'light' ? '#f4f6fa' : e.target.value === 'dark' ? '#111111' : null;
    spApplyToSelection(
      (b) => {
        b.ink = ink;
      },
      { create: false }
    );
  });
  $('sp-clear-style').addEventListener('click', () =>
    spApplyToSelection(
      (b) => {
        b.fill = null;
        b.ink = null;
      },
      { create: false }
    )
  );
  $('sp-clear').addEventListener('click', () =>
    spApplyToSelection((b) => spSetKind(b, 'blank'), { create: false })
  );
  $('sp-copy').addEventListener('click', () => spCopySelection());
  $('sp-paste').addEventListener('click', () => spPasteClipboard());

  for (const [id, key] of [['sp-rowspan', 'rowSpan'], ['sp-colspan', 'colSpan']]) {
    $(id).addEventListener('change', (e) => {
      const span = Math.max(1, Number(e.target.value) || 1);
      spApplyToSelection(
        (b) => {
          b[key] = span;
        },
        { create: false }
      );
    });
  }

  $('sp-fill').addEventListener('click', spFillFromDepartment);

  // A tab closed on an unsaved layout is the one loss nothing can undo.
  window.addEventListener('beforeunload', (e) => {
    if (currentView === 'screens' && spDirty()) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}

/** Warn once before throwing away an unsaved layout. */
function spGuardUnsaved() {
  if (!spDirty()) return true;
  return confirm(
    'This screen has changes that have not been saved. Leave them behind?'
  );
}

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

/**
 * A modal form, not a chain of prompt() calls.
 *
 * The same trap the kitchen editors were rewritten out of: Chrome offers "stop
 * showing dialogs" on the *second* dialog in a row, so a chained
 * prompt-then-confirm returns null from everything after it. The function bails
 * at its first null check and does nothing, and the alert() that would have
 * explained is suppressed by the same tick box. One form, one submit.
 */
function spNewScreen() {
  if (!spGuardUnsaved()) return;
  modal(
    'New screen',
    [
      { name: 'name', label: 'What is this screen called?', required: true, value: '' },
      {
        name: 'copy',
        label: spCurrent
          ? 'Start from a copy of "' + spCurrent.name + '" — otherwise it starts empty'
          : 'Start from a copy — there is nothing to copy yet',
        type: 'checkbox',
        value: 0,
      },
      { name: 'rows', label: 'Rows', type: 'number', value: 5 },
      { name: 'cols', label: 'Columns', type: 'number', value: 6 },
    ],
    async (data) => {
      const created = await api('/screens', {
        method: 'POST',
        body: JSON.stringify({
          name: data.name,
          rows: Number(data.rows) || 5,
          cols: Number(data.cols) || 6,
          copyFromId: data.copy && spCurrent ? spCurrent.id : null,
        }),
      });
      spCurrent = created;
      spSavedShape = spShape(created);
      await loadScreens();
    }
  );
}

function spRenameScreen() {
  if (!spCurrent) return;
  modal(
    'Rename screen',
    [{ name: 'name', label: 'Name', required: true, value: spCurrent.name }],
    async (data) => {
      await api('/screens/' + spCurrent.id, {
        method: 'PUT',
        body: JSON.stringify({ name: data.name }),
      });
      // Held locally too, so an unsaved layout keeps the new name rather than
      // reverting to the old one on the next reload.
      spCurrent.name = String(data.name || '').trim();
      await loadScreens();
    }
  );
}

/**
 * Copy this screen, buttons and all.
 *
 * The reference's "Copy Page", and how a venue with a lunch menu and an evening
 * menu gets the second one. Unsaved work is copied only after it is saved —
 * the server copies from its own row, so offering it otherwise would produce a
 * duplicate of a screen the manager is not looking at.
 */
async function spDuplicateScreen() {
  if (!spCurrent) return;
  if (spDirty() && !confirm('Save this screen first, then copy it?')) return;
  if (spDirty()) await spSaveLayout({ quiet: true });

  const base = spCurrent.name.replace(/ \(copy( \d+)?\)$/, '');
  let name = `${base} (copy)`;
  for (let n = 2; spScreens.some((s) => s.name === name); n++) {
    name = `${base} (copy ${n})`;
  }

  try {
    const created = await api('/screens', {
      method: 'POST',
      body: JSON.stringify({ name, copyFromId: spCurrent.id }),
    });
    spCurrent = created;
    spSavedShape = spShape(created);
    await loadScreens();
  } catch (e) {
    alert(e.message);
  }
}

/** Move this screen up or down the list the pickers and the tills read. */
async function spReorder(direction) {
  if (!spCurrent) return;
  const order = spScreens.map((s) => s.id);
  const at = order.indexOf(spCurrent.id);
  const to = at + direction;
  if (at < 0 || to < 0 || to >= order.length) return;

  order.splice(to, 0, ...order.splice(at, 1));
  try {
    // Every screen whose position changed, and only those. The server takes a
    // sortOrder on its own and leaves name and grid alone.
    for (let i = 0; i < order.length; i++) {
      const screen = spScreens.find((s) => s.id === order[i]);
      if (!screen || screen.sortOrder === i) continue;
      await api('/screens/' + order[i], {
        method: 'PUT',
        body: JSON.stringify({ sortOrder: i }),
      });
    }
    await loadScreens();
  } catch (e) {
    alert(e.message);
  }
}

async function spDeleteScreen() {
  if (!spCurrent) return;
  if (
    !confirm(
      `Delete the screen "${spCurrent.name}"?\n\n` +
        'Buttons on other screens that point at it become empty, and if your tills ' +
        'open on it they fall back to the built-in Default.'
    )
  ) {
    return;
  }
  try {
    await api(`/screens/${spCurrent.id}`, { method: 'DELETE' });
    spCurrent = null;
    spSavedShape = '';
    await loadScreens();
  } catch (e) {
    alert(e.message);
  }
}

async function spSetHome(e) {
  if (!spCurrent) return;
  try {
    const res = await api('/screens/home', {
      method: 'PUT',
      body: JSON.stringify({ screenId: e.target.checked ? spCurrent.id : null }),
    });
    spHomeId = res.homeScreenId;
    spRenderChrome();
  } catch (err) {
    alert(err.message);
  }
}

/**
 * Save the screen: its size, then its buttons.
 *
 * Two calls, in that order, because the server normalises the buttons against
 * the grid it has stored — send them first and everything in a newly added row
 * is dropped as out of bounds. The size call also clears anything the shrink
 * orphaned, which the button call would have replaced anyway.
 */
async function spSaveLayout({ quiet = false } = {}) {
  if (!spCurrent) return;
  const button = $('sp-save');
  button.disabled = true;
  try {
    const stored = spScreens.find((s) => s.id === spCurrent.id);
    if (stored && (stored.rows !== spCurrent.rows || stored.cols !== spCurrent.cols)) {
      await api(`/screens/${spCurrent.id}`, {
        method: 'PUT',
        body: JSON.stringify({ rows: spCurrent.rows, cols: spCurrent.cols }),
      });
    }
    await api(`/screens/${spCurrent.id}/buttons`, {
      method: 'PUT',
      body: JSON.stringify({ buttons: spCurrent.buttons }),
    });
    spSavedShape = spShape(spCurrent);
    if (!quiet) {
      button.textContent = 'Saved ✓';
      setTimeout(() => {
        button.textContent = 'Save layout';
      }, 1500);
    }
    await loadScreens();
  } catch (e) {
    alert(e.message);
  } finally {
    button.disabled = false;
  }
}

/**
 * Drop a department's products onto the selected cells.
 *
 * The reference's best idea, and the one thing that turns laying out a screen
 * from an afternoon into a minute. Filled in reading order and in the order the
 * products already appear on the product list, so the result matches what a
 * manager sees there rather than arriving shuffled.
 */
function spFillFromDepartment() {
  if (!spCurrent || !spSelection.size) {
    alert('Select some buttons on the left first.');
    return;
  }

  const department = $('sp-dept').value;
  const products = spProducts.filter((p) => p.department_name === department);
  if (!products.length) {
    alert(`There are no products in ${department}.`);
    return;
  }

  const cells = [...spSelection]
    .map((k) => k.split(':').map(Number))
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  const occupied = cells.filter(([row, col]) => spAt(row, col)).length;
  if (
    occupied &&
    !confirm(
      `${occupied} of the selected buttons are already programmed and will be ` +
        'replaced. Continue?'
    )
  ) {
    return;
  }

  if (products.length > cells.length) {
    if (
      !confirm(
        `${department} has ${products.length} products and you have selected ` +
          `${cells.length} buttons. Fill the ${cells.length} and leave the rest?`
      )
    ) {
      return;
    }
  }

  spEdit(() => {
    cells.forEach(([row, col], i) => {
      const product = products[i];
      if (!product) return;
      let b = spAt(row, col);
      if (!b) {
        b = { row, col, rowSpan: 1, colSpan: 1, kind: 'blank' };
        spCurrent.buttons.push(b);
      }
      spSetKind(b, 'product');
      b.pluId = Number(product.pluid);
      // The product's own name, so renaming it in the catalogue renames the key.
      b.label = null;
    });
  });
}
