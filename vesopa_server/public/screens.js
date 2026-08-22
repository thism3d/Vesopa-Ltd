/**
 * Screen programming — the back office editor.
 *
 * The venue's own sale-screen layouts. See
 * vesopa_epos/docs/screen-programming.md for the model; the short version is
 * that every button on the grid is one of four things, and a "category" is
 * simply a button that points at another screen.
 *
 * Its own file rather than another four hundred lines of app.js, following
 * charts.js. Loaded after app.js, and it uses that file's `$`, `api` and `esc`
 * — the navigation table there resolves `loadScreens` when a view is opened,
 * by which time this has parsed.
 *
 * The editor holds the whole layout locally and sends it in one PUT. A layout
 * is a few dozen rows, and "here is the screen as it now is" cannot half-apply
 * the way a stream of individual edits can.
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

let spScreens = [];
let spProducts = [];
let spHomeId = null;

/** The screen being edited, as a working copy so Revert has a target. */
let spCurrent = null;

/** Cells the manager has selected, as "row:col". */
let spSelection = new Set();

let spDirty = false;
let spBound = false;

async function loadScreens() {
  const [screens, products, settings] = await Promise.all([
    api('/screens'),
    api('/products'),
    api('/till-settings'),
  ]);

  spScreens = screens;
  spProducts = products;
  spHomeId = settings.home_screen_id ?? null;

  // Stay on the screen being edited across a reload, so saving does not bounce
  // the manager back to the first one in the list.
  const keep = spCurrent && spScreens.find((s) => s.id === spCurrent.id);
  spSelect(keep ? keep.id : (spScreens[0] ? spScreens[0].id : null));

  spBind();
  spRenderChrome();
}

function spSelect(id) {
  const found = spScreens.find((s) => s.id === id) || null;
  spCurrent = found ? JSON.parse(JSON.stringify(found)) : null;
  spSelection = new Set();
  spDirty = false;
}

const spKey = (row, col) => `${row}:${col}`;

function spAt(row, col) {
  if (!spCurrent) return null;
  return spCurrent.buttons.find((b) => b.row === row && b.col === col) || null;
}

/**
 * Cells swallowed by a button's span.
 *
 * Rendered as nothing at all rather than as empty keys, so a 2x2 reads as one
 * button instead of one button and three holes.
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

// ---- Chrome ---------------------------------------------------------------

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
  for (const id of ['sp-rename', 'sp-delete', 'sp-save', 'sp-revert', 'sp-fill']) {
    $(id).disabled = !has;
  }
  $('sp-rows').value = has ? spCurrent.rows : '';
  $('sp-cols').value = has ? spCurrent.cols : '';
  $('sp-rows').disabled = !has;
  $('sp-cols').disabled = !has;
  $('sp-home').checked = has && spCurrent.id === spHomeId;
  $('sp-home').disabled = !has;

  $('sp-dept').innerHTML = [
    ...new Set(spProducts.map((p) => p.department_name).filter(Boolean)),
  ]
    .sort()
    .map((d) => `<option value="${esc(d)}">${esc(d)}</option>`)
    .join('');

  spRenderGrid();
  spRenderInspector();
}

// ---- The grid -------------------------------------------------------------

function spRenderGrid() {
  const box = $('sp-grid');
  if (!spCurrent) {
    box.removeAttribute('style');
    box.innerHTML =
      '<p class="muted small" style="padding:24px">This venue has no programmed screens, so ' +
      'tills are showing the built-in <strong>Default</strong> — the one drawn from your ' +
      'product list. Press <strong>New…</strong> to lay one out.</p>';
    return;
  }

  const covered = spCovered();
  box.style.gridTemplateColumns = `repeat(${spCurrent.cols}, 1fr)`;
  box.style.gridTemplateRows = `repeat(${spCurrent.rows}, 1fr)`;

  const cells = [];
  for (let r = 0; r < spCurrent.rows; r++) {
    for (let c = 0; c < spCurrent.cols; c++) {
      const key = spKey(r, c);
      if (covered.has(key)) continue;

      const b = spAt(r, c);
      const style = [
        `grid-row:${r + 1} / span ${b ? b.rowSpan || 1 : 1}`,
        `grid-column:${c + 1} / span ${b ? b.colSpan || 1 : 1}`,
        b && b.fill ? `background:${esc(b.fill)}` : '',
        b && b.fill ? `color:${esc(b.ink || kdsInkOn(b.fill))}` : '',
      ]
        .filter(Boolean)
        .join(';');

      cells.push(
        `<button type="button" class="sp-cell${b ? ' filled' : ''}` +
          `${spSelection.has(key) ? ' selected' : ''}` +
          `${spMissing(b) ? ' missing' : ''}" style="${style}" ` +
          `data-row="${r}" data-col="${c}">` +
          `<span>${esc(b ? spLabelFor(b) : '')}</span>` +
          (b && b.kind === 'page' ? '<em class="sp-arrow">›››</em>' : '') +
          '</button>'
      );
    }
  }
  box.innerHTML = cells.join('');
}

// ---- The inspector --------------------------------------------------------

function spSelected() {
  return [...spSelection]
    .map((k) => {
      const parts = k.split(':').map(Number);
      return spAt(parts[0], parts[1]);
    })
    .filter(Boolean);
}

function spRenderInspector() {
  const count = spSelection.size;
  $('sp-sel-title').textContent =
    count === 0 ? 'Nothing selected' : count === 1 ? 'One button' : `${count} buttons`;
  $('sp-sel-hint').textContent =
    count === 0
      ? 'Pick a button on the left to change what it does.'
      : count === 1
        ? 'Changes apply as you make them.'
        : 'Changes apply to all of them at once.';

  $('sp-inspector').hidden = count === 0;
  if (!count) return;

  const chosen = spSelected();
  // With a mixed selection the controls show the first one's value and applying
  // any of them sets the lot. That is the honest behaviour for a bulk edit, and
  // it is what makes "colour these six the same" a single action.
  const first = chosen[0] || { kind: 'blank' };

  $('sp-kind').value = first.kind || 'blank';
  document.querySelectorAll('#sp-inspector .sp-field').forEach((el) => {
    el.hidden = el.dataset.for !== $('sp-kind').value;
  });

  $('sp-product').innerHTML =
    '<option value="">Choose a product…</option>' +
    spProducts
      .map(
        (p) =>
          `<option value="${p.pluid}"${
            Number(p.pluid) === Number(first.pluId) ? ' selected' : ''
          }>${esc(p.product_name)}${
            p.department_name ? ' — ' + esc(p.department_name) : ''
          }</option>`
      )
      .join('');

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

  $('sp-label').value = first.label || '';
  $('sp-rowspan').value = first.rowSpan || 1;
  $('sp-colspan').value = first.colSpan || 1;
  // A span is a single-button idea. Applied to a multi-selection, buttons grow
  // over each other.
  $('sp-rowspan').disabled = count !== 1;
  $('sp-colspan').disabled = count !== 1;

  $('sp-fills').innerHTML = SP_FILLS.map(
    (fill) =>
      `<button type="button" class="sp-swatch${
        first.fill === fill ? ' on' : ''
      }" style="background:${fill}" data-fill="${fill}" title="${fill}"></button>`
  ).join('');
}

/** Apply a change to every selected cell, creating buttons where needed. */
function spApply(mutate) {
  if (!spCurrent || !spSelection.size) return;

  for (const key of spSelection) {
    const parts = key.split(':').map(Number);
    let button = spAt(parts[0], parts[1]);
    if (!button) {
      button = { row: parts[0], col: parts[1], rowSpan: 1, colSpan: 1, kind: 'blank' };
      spCurrent.buttons.push(button);
    }
    mutate(button);
  }

  // Blanks are not stored — an empty cell already means empty — so they are
  // dropped here too, keeping the working copy the same shape as what saves.
  spCurrent.buttons = spCurrent.buttons.filter((b) => b.kind !== 'blank');

  spDirty = true;
  spRenderGrid();
  spRenderInspector();
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

// ---- Wiring ---------------------------------------------------------------

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
  $('sp-delete').addEventListener('click', spDeleteScreen);
  $('sp-save').addEventListener('click', spSaveLayout);
  $('sp-revert').addEventListener('click', () => {
    spSelect(spCurrent ? spCurrent.id : null);
    spRenderChrome();
  });

  for (const id of ['sp-rows', 'sp-cols']) {
    $(id).addEventListener('change', spResize);
  }
  $('sp-home').addEventListener('change', spSetHome);

  // ---- The grid itself ----
  const grid = $('sp-grid');

  grid.addEventListener('pointerdown', spDragStart);
  grid.addEventListener('pointerover', spDragOver);
  window.addEventListener('pointerup', spDragEnd);

  // Backspace clears, Escape deselects. Both are what somebody laying out a
  // screen reaches for without being told.
  grid.addEventListener('keydown', (e) => {
    if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault();
      spApply((b) => spSetKind(b, 'blank'));
    }
    if (e.key === 'Escape') {
      spSelection = new Set();
      spRenderGrid();
      spRenderInspector();
    }
  });

  // ---- The inspector ----
  $('sp-kind').addEventListener('change', (e) => {
    spApply((b) => spSetKind(b, e.target.value));
    spRenderInspector();
  });
  $('sp-product').addEventListener('change', (e) => {
    const plu = Number(e.target.value);
    if (!plu) return;
    spApply((b) => {
      spSetKind(b, 'product');
      b.pluId = plu;
    });
  });
  $('sp-target').addEventListener('change', (e) => {
    const id = Number(e.target.value);
    if (!id) return;
    spApply((b) => {
      spSetKind(b, 'page');
      b.targetScreenId = id;
    });
  });
  $('sp-function').addEventListener('change', (e) => {
    if (!e.target.value) return;
    spApply((b) => {
      spSetKind(b, 'function');
      b.functionKey = e.target.value;
    });
  });
  $('sp-label').addEventListener('input', (e) => {
    const label = e.target.value.trim();
    spApply((b) => {
      b.label = label || null;
    });
  });
  $('sp-fills').addEventListener('click', (e) => {
    const swatch = e.target.closest('.sp-swatch');
    if (!swatch) return;
    spApply((b) => {
      b.fill = swatch.dataset.fill;
      b.ink = null;
    });
  });
  $('sp-clear-style').addEventListener('click', () =>
    spApply((b) => {
      b.fill = null;
      b.ink = null;
    })
  );
  $('sp-clear').addEventListener('click', () =>
    spApply((b) => spSetKind(b, 'blank'))
  );

  for (const [id, key] of [['sp-rowspan', 'rowSpan'], ['sp-colspan', 'colSpan']]) {
    $(id).addEventListener('change', (e) => {
      const span = Math.max(1, Number(e.target.value) || 1);
      spApply((b) => {
        b[key] = span;
      });
    });
  }

  $('sp-fill').addEventListener('click', spFillFromDepartment);
}

/** Warn once before throwing away an unsaved layout. */
function spGuardUnsaved() {
  if (!spDirty) return true;
  return confirm(
    'This screen has changes that have not been saved. Leave them behind?'
  );
}

// ---- Selection ------------------------------------------------------------

let spDragging = false;
let spDragAnchor = null;
let spDragAdditive = false;

function spDragStart(e) {
  const cell = e.target.closest('.sp-cell');
  if (!cell) return;
  e.preventDefault();
  $('sp-grid').focus();

  spDragging = true;
  spDragAnchor = { row: Number(cell.dataset.row), col: Number(cell.dataset.col) };
  // Shift adds to what is already selected; a plain press starts fresh. Ctrl
  // toggles a single cell, which is what a manager fixing one mistake wants.
  spDragAdditive = e.shiftKey || e.ctrlKey || e.metaKey;

  if (!spDragAdditive) spSelection = new Set();
  if (e.ctrlKey || e.metaKey) {
    const key = spKey(spDragAnchor.row, spDragAnchor.col);
    if (spSelection.has(key)) spSelection.delete(key);
    else spSelection.add(key);
    spDragging = false;
  } else {
    spSelectRect(spDragAnchor, spDragAnchor);
  }

  spRenderGrid();
  spRenderInspector();
}

function spDragOver(e) {
  if (!spDragging) return;
  const cell = e.target.closest('.sp-cell');
  if (!cell) return;
  spSelectRect(spDragAnchor, {
    row: Number(cell.dataset.row),
    col: Number(cell.dataset.col),
  });
  spRenderGrid();
  spRenderInspector();
}

function spDragEnd() {
  spDragging = false;
}

/** Everything in the box between two corners — the reference's best gesture. */
function spSelectRect(from, to) {
  const r0 = Math.min(from.row, to.row);
  const r1 = Math.max(from.row, to.row);
  const c0 = Math.min(from.col, to.col);
  const c1 = Math.max(from.col, to.col);
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) spSelection.add(spKey(r, c));
  }
}

// ---- Screens --------------------------------------------------------------

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
      await loadScreens();
    }
  );
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
    await loadScreens();
  } catch (e) {
    alert(e.message);
  }
}

async function spResize() {
  if (!spCurrent) return;
  const rows = Math.max(1, Math.min(10, Number($('sp-rows').value) || spCurrent.rows));
  const cols = Math.max(1, Math.min(12, Number($('sp-cols').value) || spCurrent.cols));

  // Shrinking drops whatever falls outside, and the server does the same. Said
  // out loud first, because a layout quietly losing its last column is the kind
  // of thing somebody notices a week later.
  const lost = spCurrent.buttons.filter((b) => b.row >= rows || b.col >= cols);
  if (lost.length && !confirm(`${lost.length} button(s) fall outside the new size and will be removed. Continue?`)) {
    $('sp-rows').value = spCurrent.rows;
    $('sp-cols').value = spCurrent.cols;
    return;
  }

  try {
    await api(`/screens/${spCurrent.id}`, {
      method: 'PUT',
      body: JSON.stringify({ rows, cols }),
    });
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

async function spSaveLayout() {
  if (!spCurrent) return;
  const button = $('sp-save');
  button.disabled = true;
  try {
    await api(`/screens/${spCurrent.id}/buttons`, {
      method: 'PUT',
      body: JSON.stringify({ buttons: spCurrent.buttons }),
    });
    spDirty = false;
    button.textContent = 'Saved ✓';
    setTimeout(() => {
      button.textContent = 'Save layout';
    }, 1500);
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

  cells.forEach(([row, col], i) => {
    const product = products[i];
    let b = spAt(row, col);
    if (!product) return;
    if (!b) {
      b = { row, col, rowSpan: 1, colSpan: 1, kind: 'blank' };
      spCurrent.buttons.push(b);
    }
    spSetKind(b, 'product');
    b.pluId = Number(product.pluid);
    // The product's own name, so renaming it in the catalogue renames the key.
    b.label = null;
  });

  spCurrent.buttons = spCurrent.buttons.filter((b) => b.kind !== 'blank');
  spDirty = true;
  spRenderGrid();
  spRenderInspector();
}
