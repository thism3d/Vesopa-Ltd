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

/**
 * What a screen lays out.
 *
 * A bar is a screen. The strip of open tables along the top of the till and the
 * strip of keys along the bottom are one or two rows of the same buttons the
 * sale grid is made of, so everything below — the drag, the undo, the bulk
 * colour, the whole-grid save — works on them without knowing they are bars.
 * Only three things differ: the ceilings, the list of functions on offer, and
 * the shape the editor draws them in.
 */
const SP_SURFACES = [
  ['sale', 'Sale screens'],
  ['topbar', 'Top bars'],
  ['bottombar', 'Bottom bars'],
];

const spIsBar = (surface) => surface === 'topbar' || surface === 'bottombar';

/** The till functions a button on a sale screen may be bound to. */
const SP_FUNCTIONS = [
  ['qty', 'Quantity'],
  ['note', 'Note'],
  ['covers', 'Covers'],
  ['customer', 'Customer'],
  ['open_drawer', 'No sale (open drawer)'],
  ['print_bill', 'Print bill'],
];

/**
 * And on a bar. Mirrors BAR_KEYS in vesopa_server/src/screens.js.
 *
 * Grouped, because it is a long list and a flat one of twenty-eight options is
 * a list nobody reads to the end of. The last group is the one that makes the
 * feature safe: `open_bills` is the strip of open tables the top bar *is*
 * today, offered as a key you can place, widen and colour — so a venue that
 * programs its own top bar does not silently lose the ability to run two bills
 * at once and find out at the counter.
 */
const SP_BAR_GROUPS = [
  ['The bill', [
    ['pay', 'Pay'],
    ['void', 'Void'],
    ['cancel', 'Cancel'],
    ['save_table', 'Save to table'],
    ['new_bill', 'New bill'],
    ['qty', 'Quantity'],
    ['note', 'Note'],
    ['covers', 'Covers'],
    ['customer', 'Customer'],
  ]],
  ['Paper and cash', [
    ['print_bill', 'Print bill'],
    ['last_bill', 'Last bill'],
    ['open_drawer', 'No sale (open drawer)'],
  ]],
  ['Go to', [
    ['go_sale', 'Sale'],
    ['go_tables', 'Tables'],
    ['go_receipts', 'Receipts'],
    ['go_reports', 'Reports'],
    ['go_products', 'Products'],
    ['go_functions', 'Functions'],
    ['go_settings', 'Settings'],
    ['sign_off', 'Sign off'],
  ]],
  ['Live displays', [
    ['open_bills', 'Open bills — the table strip'],
    ['order_total', 'Bill total'],
    ['clock', 'Clock'],
    ['venue_name', 'Venue name'],
    ['staff_name', 'Who is signed on'],
    ['sync_status', 'Online / offline'],
    ['print_status', 'Did the kitchen ticket land'],
    ['screen_name', 'Name of the open screen'],
    ['spacer', 'Blank space'],
  ]],
];

/** Every function name in one lookup, whatever surface it belongs to. */
const SP_FUNCTION_LABEL = new Map([
  ...SP_FUNCTIONS,
  ...SP_BAR_GROUPS.flatMap(([, keys]) => keys),
]);

/** The functions on offer for a surface, as [group, [[key, label], …]] pairs. */
function spFunctionsFor(surface) {
  return spIsBar(surface) ? SP_BAR_GROUPS : [['', SP_FUNCTIONS]];
}

/** Keys that draw something live rather than waiting to be pressed. */
const SP_WIDGET_KEYS = new Set([
  'open_bills',
  'order_total',
  'clock',
  'venue_name',
  'staff_name',
  'sync_status',
  'print_status',
  'screen_name',
  'spacer',
]);

/**
 * A starting point for the emoji field.
 *
 * A palette rather than a picker, for the same reason the colours are swatches:
 * an emoji keyboard on a back-office screen is a search box, and what a venue
 * actually wants is the twenty pictures that mean something on a till. Anything
 * else can still be typed or pasted into the box beside it — this is a shortcut,
 * not a whitelist.
 */
const SP_EMOJI = [
  '🍔', '🍟', '🍕', '🌭', '🥪', '🍗', '🐟', '🥗', '🍜', '🍝',
  '🍰', '🍨', '🍩', '🍪', '☕', '🫖', '🍺', '🍷', '🥃', '🍸',
  '🥤', '🧃', '🧊', '🔥', '⭐', '❤️', '🎁', '🧾', '💷', '💳',
  '🔙', '➡️', '🏠', '🧑‍🍳', '🪑', '🚬', '🥡', '📦', '🕒', '🔔',
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

/** A bar's own. Mirrors MAX_BAR_ROWS / MAX_BAR_COLS. */
const SP_MAX_BAR_ROWS = 2;
const SP_MAX_BAR_COLS = 16;

function spLimits(surface) {
  return spIsBar(surface)
    ? { rows: SP_MAX_BAR_ROWS, cols: SP_MAX_BAR_COLS, defRows: 1, defCols: 10 }
    : { rows: SP_MAX_ROWS, cols: SP_MAX_COLS, defRows: 5, defCols: 6 };
}

/** Deep enough to cover a session's mistakes, shallow enough to hold in hand. */
const SP_UNDO_LIMIT = 60;

let spScreens = [];
let spProducts = [];

/**
 * The three screens this venue's tills wear, by id. Null means the built-in.
 *
 * All three together rather than a lone `spHomeId`, because they are one
 * decision — "this is what my tills look like" — and the page now draws them
 * as one.
 */
let spDefaults = { home: null, top: null, bottom: null };

/** Which kind of layout is being edited: the tab across the top. */
let spSurface = 'sale';

/**
 * A screen the editor should open as soon as it has loaded, or null.
 *
 * Set by `spOpenScreen` from outside the editor — today by the Modifiers page,
 * whose "Edit answers" key has a screen id and no editor to put it in yet.
 * Cleared the moment it is used; see loadScreens.
 */
let spPendingOpen = null;

/* ---------------------------------------------------------------------------
   Double-click a key: search everything it could be
   ---------------------------------------------------------------------------
   The inspector has three separate pickers — a product list, a page list and a
   function list — and using them means knowing which of the three the thing you
   want lives in before you can start looking for it. That is fine when you are
   laying out a screen from scratch and terrible when you are changing one key
   on a screen somebody else made.

   So: double-click the key, type what you want, press Enter. One list, drawn
   from all three sources, filtered as you type. The inspector stays exactly as
   it is — this is a faster road to the same place, not a replacement.
   --------------------------------------------------------------------------- */

/** Everything a key on this surface could be bound to, as one searchable list. */
function spPaletteEntries() {
  const surface = spCurrentSurface();
  const entries = [];

  for (const p of spProducts) {
    entries.push({
      group: 'Product',
      label: p.product_name,
      // Searchable on the things a manager actually knows about a product.
      hay: `${p.product_name} ${p.department_name || ''} ${p.group_name || ''} ${p.pluid}`,
      note: [p.department_name, p.group_name].filter(Boolean).join(' · '),
      apply: (b) => {
        spSetKind(b, 'product');
        b.pluId = Number(p.pluid);
      },
    });
  }

  // Only pages on the same surface. A sale screen cannot jump to a bar, and
  // offering it would place a key that silently does nothing.
  for (const screen of spOnSurface(surface)) {
    if (spCurrent && screen.id === spCurrent.id) continue;
    entries.push({
      group: 'Navigation',
      label: screen.name,
      hay: `${screen.name} page screen navigation`,
      note: 'Go to this screen',
      apply: (b) => {
        spSetKind(b, 'page');
        b.targetScreenId = screen.id;
      },
    });
  }

  for (const [, keys] of spFunctionsFor(surface)) {
    for (const [key, label] of keys) {
      entries.push({
        group: 'Function',
        label,
        hay: `${label} ${key} function`,
        note: key,
        apply: (b) => {
          spSetKind(b, 'function');
          b.functionKey = key;
        },
      });
    }
  }

  entries.push({
    group: 'Function',
    label: 'Clear this key',
    hay: 'clear blank empty remove',
    note: 'Leaves an empty cell',
    apply: (b) => spSetKind(b, 'blank'),
  });

  return entries;
}


/**
 * Open the editor in a window of its own.
 *
 * The editor is the one page in the back office that wants the whole screen: a
 * grid, an inspector beside it and a till preview under it, on a page that also
 * carries a sidebar, a page heading and three paragraphs of explanation. On a
 * laptop that means scrolling up to change a screen and down to see the result.
 *
 * The same page, opened with `?popup=1`, which hides the chrome and lets the
 * editor have the height. Not a second copy of the editor — one editor, drawn
 * without the furniture — because a second copy is a second thing to fix.
 *
 * Falls back to the tab it was clicked in when the browser blocks the window,
 * which is the sane failure: the manager still gets the roomy editor.
 */
function spPopOut() {
  const url = `${location.origin}/screen-programming?popup=1`;
  // Sized to the screen it is opening on, less the browser's own chrome.
  const w = Math.min(1600, Math.max(1100, screen.availWidth - 80));
  const h = Math.min(1100, Math.max(700, screen.availHeight - 80));
  const win = window.open(
    url,
    'vesopa-screen-editor',
    `popup=1,width=${w},height=${h},left=${Math.max(0, (screen.availWidth - w) / 2)},top=${Math.max(0, (screen.availHeight - h) / 2)}`
  );
  if (win) win.focus();
  else location.href = url;
}

/**
 * Strip the page back to the editor when opened with `?popup=1`.
 *
 * Done by a class on <body> rather than by a different template, so there is
 * one page to maintain and the editor cannot behave differently in the window
 * a manager actually uses.
 */
function spApplyPopupMode() {
  const popup = new URLSearchParams(location.search).get('popup') === '1';
  document.body.classList.toggle('sp-popup', popup);
  return popup;
}

let spPaletteOpen = false;

/** Open the search palette against whatever is selected. */
function spOpenPalette() {
  if (!spCurrent || !spSelection.size || spPaletteOpen) return;
  spPaletteOpen = true;

  const entries = spPaletteEntries();
  const root = document.createElement('div');
  root.className = 'sp-palette-back';
  root.innerHTML = `
    <div class="sp-palette" role="dialog" aria-label="Search for what this key should do">
      <input class="sp-palette-q" type="search" autocomplete="off"
             placeholder="Search products, screens and functions…" />
      <ul class="sp-palette-list"></ul>
      <p class="sp-palette-hint muted small">
        ↑ ↓ to move, Enter to place it, Esc to close
      </p>
    </div>`;
  document.body.appendChild(root);

  const query = root.querySelector('.sp-palette-q');
  const list = root.querySelector('.sp-palette-list');
  let shown = [];
  let cursor = 0;

  const close = () => {
    spPaletteOpen = false;
    root.remove();
    // Back to the grid, so the arrow keys keep walking the layout.
    $('sp-grid')?.focus();
  };

  const draw = () => {
    const q = query.value.trim().toLowerCase();
    shown = (q
      ? entries.filter((e) => e.hay.toLowerCase().includes(q))
      : entries
    ).slice(0, 60);
    if (cursor >= shown.length) cursor = Math.max(0, shown.length - 1);

    list.innerHTML = shown.length
      ? shown
          .map(
            (e, i) => `<li class="sp-palette-row${i === cursor ? ' on' : ''}" data-i="${i}">
              <span class="sp-palette-kind">${spEsc(e.group)}</span>
              <span class="sp-palette-label">${spEsc(e.label)}</span>
              <span class="sp-palette-note muted small">${spEsc(e.note || '')}</span>
            </li>`
          )
          .join('')
      : '<li class="sp-palette-empty muted">Nothing matches that.</li>';

    list.querySelector('.sp-palette-row.on')?.scrollIntoView({ block: 'nearest' });
  };

  const choose = (i) => {
    const entry = shown[i];
    if (!entry) return;
    spApplyToSelection((b) => entry.apply(b));
    spRenderGrid();
    spRenderInspector();
    close();
  };

  query.addEventListener('input', () => {
    cursor = 0;
    draw();
  });
  query.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      cursor = Math.min(cursor + 1, shown.length - 1);
      draw();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      cursor = Math.max(cursor - 1, 0);
      draw();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(cursor);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  });
  list.addEventListener('click', (e) => {
    const row = e.target.closest('.sp-palette-row');
    if (row) choose(Number(row.dataset.i));
  });
  // A click on the backdrop, but not one inside the box.
  root.addEventListener('pointerdown', (e) => {
    if (e.target === root) close();
  });

  draw();
  query.focus();
}

/** Escaping for the palette's own markup. */
function spEsc(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}



/** Open this screen next time the editor loads. */
function spOpenScreen(id) {
  spPendingOpen = Number(id);
}

/** Every picture this venue already has to hand, for the key-face gallery. */
let spGallery = [];

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
  spDefaults = {
    home: settings.home_screen_id ?? null,
    top: settings.top_bar_screen_id ?? null,
    bottom: settings.bottom_bar_screen_id ?? null,
  };
  spProductOptionsSig = '';

  // Pictures this venue already has, offered as a strip to click rather than a
  // path to type. Products first because they are the ones with pictures, then
  // anything already used on a key — so a venue's second FOOD button can wear
  // the same picture as its first without going to find the file again.
  spGallery = [
    ...new Set([
      ...spProducts.map((p) => p.image_url).filter(Boolean),
      ...spScreens.flatMap((s) => (s.buttons || []).map((b) => b.imageUrl)).filter(Boolean),
    ]),
  ].slice(0, 40);

  // Sent here by a modifier group's "Edit answers" key, which knows the screen
  // it wants but cannot select it until the editor has loaded.
  //
  // Honoured once and cleared: without that, every later reload — a save, a
  // push from another manager — would drag the editor back to the modifier
  // screen somebody opened twenty minutes ago.
  if (spPendingOpen != null) {
    const wanted = spScreens.find((s) => s.id === spPendingOpen);
    spPendingOpen = null;
    if (wanted) {
      spSurface = wanted.surface || 'sale';
      spSelect(wanted.id);
      spBind();
      spRenderChrome();
      return;
    }
  }

  // A screen deleted, or the tab moved: keep the editor pointing at something
  // that exists on the surface being shown.
  const keep = spCurrent && spScreens.find((s) => s.id === spCurrent.id);
  if (keep) spSurface = keep.surface || 'sale';

  if (keep && spDirty()) {
    // Unsaved work in hand. The lists behind the pickers are refreshed — a
    // product added in another tab should be selectable here — but the layout
    // on the grid is the manager's, and it stays.
    spCurrent.name = keep.name;
  } else {
    // Stay on the screen being edited across a reload, so saving does not
    // bounce the manager back to the first one in the list.
    const first = spOnSurface()[0];
    spSelect(keep ? keep.id : first ? first.id : null);
  }

  spBind();
  spRenderChrome();
}

/** The screens on the surface being edited, in the order the tills read them. */
function spOnSurface(surface = spSurface) {
  return spScreens.filter((s) => (s.surface || 'sale') === surface);
}

/** The surface of the screen in hand, which is what every limit follows. */
function spCurrentSurface() {
  return (spCurrent && spCurrent.surface) || spSurface;
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
    return SP_FUNCTION_LABEL.get(b.functionKey) || 'Unset function';
  }
  return '';
}

/**
 * The product whose picture a key would borrow, if it borrows one.
 *
 * A key with no face of its own still shows the product's — which is what stops
 * this feature quietly un-decorating every screen a venue has already
 * programmed. The editor draws the borrowed one dimmed, so "this key has a
 * picture" and "this key was given a picture" stay distinguishable.
 */
function spFaceFor(b) {
  if (!b) return null;
  if (b.emoji || b.imageUrl) {
    return { emoji: b.emoji || '', image: b.imageUrl || '', own: true };
  }
  if (b.kind !== 'product') return null;
  const p = spProducts.find((x) => Number(x.pluid) === Number(b.pluId));
  if (!p || (!p.emoji && !p.image_url)) return null;
  return { emoji: p.emoji || '', image: p.image_url || '', own: false };
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
        b.emoji ?? '',
        b.imageUrl ?? '',
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
  const max = spLimits(spCurrentSurface());
  const wanted = {
    rows: Math.max(1, Math.min(max.rows, Number(rows) || spCurrent.rows)),
    cols: Math.max(1, Math.min(max.cols, Number(cols) || spCurrent.cols)),
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
  const surface = spCurrentSurface();
  const bar = spIsBar(surface);
  const mine = spOnSurface(surface);

  for (const tab of document.querySelectorAll('.sp-surface')) {
    tab.classList.toggle('on', tab.dataset.surface === spSurface);
    tab.setAttribute('aria-selected', String(tab.dataset.surface === spSurface));
  }

  const picker = $('sp-screen');
  picker.innerHTML = mine.length
    ? mine
        .map(
          (s) =>
            `<option value="${s.id}"${s.id === (spCurrent && spCurrent.id) ? ' selected' : ''}>` +
            esc(s.name) +
            (s.id === spDefaultFor(surface) ? ' — on your tills' : '') +
            '</option>'
        )
        .join('')
    : `<option value="">No ${bar ? 'bars' : 'screens'} yet</option>`;

  const has = !!spCurrent;
  const at = has ? mine.findIndex((s) => s.id === spCurrent.id) : -1;
  for (const id of [
    'sp-rename',
    'sp-duplicate',
    'sp-delete',
    'sp-save',
    'sp-revert',
    'sp-fill',
    'sp-preset',
  ]) {
    $(id).disabled = !has;
  }
  $('sp-up').disabled = at <= 0;
  $('sp-down').disabled = at < 0 || at >= mine.length - 1;

  // The ceilings follow the surface, so the number boxes cannot offer a shape
  // the server would clamp back on save — a resize that silently un-does itself
  // is worse than one that will not go past its limit.
  const max = spLimits(surface);
  $('sp-rows').max = max.rows;
  $('sp-cols').max = max.cols;
  $('sp-rows').value = has ? spCurrent.rows : '';
  $('sp-cols').value = has ? spCurrent.cols : '';
  $('sp-rows').disabled = !has;
  $('sp-cols').disabled = !has;

  $('sp-home').checked = has && spCurrent.id === spDefaultFor(surface);
  $('sp-home').disabled = !has;
  $('sp-home-wrap').lastChild.textContent = bar
    ? ' Tills wear this bar'
    : ' Tills open on this';
  $('sp-preview').checked = spPreview;
  $('sp-preview').disabled = !has;

  // A department fill makes no sense on a bar, and the built-in-bar preset
  // makes none on a sale screen. Each card is shown where it is the obvious
  // next thing to press and hidden where it is noise.
  $('sp-fill-card').hidden = bar;
  $('sp-preset-card').hidden = !bar;
  if (bar) {
    $('sp-preset').textContent =
      surface === 'topbar'
        ? 'Lay out the built-in top bar'
        : 'Lay out the built-in bottom bar';
  }

  $('sp-dept').innerHTML = [
    ...new Set(spProducts.map((p) => p.department_name).filter(Boolean)),
  ]
    .sort()
    .map((d) => `<option value="${esc(d)}">${esc(d)}</option>`)
    .join('');

  spRenderDefaults();
  spRenderPerScreenBars();
  spRenderGrid();
  spRenderInspector();
  spRenderStatus();
}

/** Which screen this venue's tills wear on a given surface. */
function spDefaultFor(surface) {
  if (surface === 'topbar') return spDefaults.top;
  if (surface === 'bottombar') return spDefaults.bottom;
  return spDefaults.home;
}

/** The options for a "which layout" dropdown, plus the built-in at the top. */
function spLayoutOptions(surface, selected, builtIn) {
  return (
    `<option value="">${esc(builtIn)}</option>` +
    spOnSurface(surface)
      .map(
        (s) =>
          `<option value="${s.id}"${s.id === selected ? ' selected' : ''}>` +
          esc(s.name) +
          '</option>'
      )
      .join('')
  );
}

/**
 * The three choices, and the till drawn beside them.
 *
 * The drawing is the point. "Which of my three layouts is the bottom one" is a
 * question a picture answers instantly and a list of names does not, and it is
 * the question that had a manager looking straight past the tick box that sets
 * it. Each part of the drawing is also the way in: press the bottom strip and
 * the editor opens the bottom bar.
 */
function spRenderDefaults() {
  $('sp-def-home').innerHTML = spLayoutOptions(
    'sale',
    spDefaults.home,
    'Built-in — drawn from your product list'
  );
  $('sp-def-top').innerHTML = spLayoutOptions(
    'topbar',
    spDefaults.top,
    'Built-in — your open tables'
  );
  $('sp-def-bottom').innerHTML = spLayoutOptions(
    'bottombar',
    spDefaults.bottom,
    'Built-in — Void, Cancel … Pay'
  );

  const named = (surface, fallback) => {
    const id = spDefaultFor(surface);
    const found = spScreens.find((s) => s.id === id);
    return found ? found.name : fallback;
  };

  const preview = $('sp-till-preview');
  const parts = [
    ['topbar', named('topbar', 'Open tables')],
    ['sale', named('sale', 'Your products')],
    ['bottombar', named('bottombar', 'Void … Pay')],
  ];
  for (const [surface, label] of parts) {
    const el = preview.querySelector(`[data-part="${surface}"]`);
    if (!el) continue;
    el.textContent = label;
    el.classList.toggle('custom', spDefaultFor(surface) != null);
    el.classList.toggle('editing', surface === spSurface);
  }

  const set = SP_SURFACES.filter(([k]) => spDefaultFor(k) != null).length;
  const flag = $('sp-defaults-state');
  flag.hidden = set === 0;
  flag.className = 'sp-flag ok';
  flag.textContent =
    set === 3 ? 'All three are yours' : `${set} of 3 set to your own`;
}

/**
 * Which bars this one page wants, when it does not want the venue's.
 *
 * Hidden on the bars themselves, where the question is meaningless, and hidden
 * until the venue has a bar to choose — a dropdown offering nothing but
 * "Venue default" is a feature that looks broken.
 */
function spRenderPerScreenBars() {
  const wrap = $('sp-perscreen');
  const tops = spOnSurface('topbar');
  const bottoms = spOnSurface('bottombar');
  const show =
    !!spCurrent &&
    spCurrentSurface() === 'sale' &&
    (tops.length > 0 || bottoms.length > 0);

  wrap.hidden = !show;
  if (!show) return;

  $('sp-screen-top').innerHTML = spLayoutOptions(
    'topbar',
    spCurrent.topBarId ?? null,
    'Venue default'
  );
  $('sp-screen-bottom').innerHTML = spLayoutOptions(
    'bottombar',
    spCurrent.bottomBarId ?? null,
    'Venue default'
  );
  $('sp-screen-top').disabled = !tops.length;
  $('sp-screen-bottom').disabled = !bottoms.length;
}

// ---------------------------------------------------------------------------
// The grid
// ---------------------------------------------------------------------------

function spRenderGrid() {
  const box = $('sp-grid');
  spCells = new Map();

  const surface = spCurrentSurface();
  const bar = spIsBar(surface);
  box.classList.toggle('bar', bar);
  $('sp-ghost-top').hidden = surface !== 'bottombar';
  $('sp-ghost-bottom').hidden = surface !== 'topbar';
  $('sp-stage').classList.toggle('framed', bar);

  if (!spCurrent) {
    box.removeAttribute('style');
    box.classList.remove('preview');
    box.innerHTML = bar
      ? '<p class="muted small" style="padding:24px">Your tills are wearing the built-in ' +
        (surface === 'topbar'
          ? '<strong>top bar</strong> — the strip of open tables. '
          : '<strong>bottom bar</strong> — Void, Cancel, Save Table … Pay. ') +
        'Press <strong>New…</strong> to lay out your own, then ' +
        '<strong>Lay out the built-in bar</strong> to start from what you have today.</p>'
      : '<p class="muted small" style="padding:24px">This venue has no programmed screens, so ' +
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

      // The key's face, above its words, exactly as the till stacks them. A
      // picture the key has borrowed from its product is drawn faded, so
      // "this key has a picture" and "this key was given one" stay apart —
      // otherwise clearing a key's own emoji looks like it did nothing.
      const face = b && spFaceFor(b);
      if (face) {
        const art = document.createElement('span');
        art.className = 'sp-face-art' + (face.own ? '' : ' inherited');
        if (face.image) {
          art.style.backgroundImage = `url("${face.image.replace(/"/g, '%22')}")`;
          art.classList.add('img');
        } else {
          art.textContent = face.emoji;
        }
        cell.append(art);
      }

      const text = document.createElement('span');
      text.textContent = b ? spLabelFor(b) : '';
      cell.append(text);

      // A live display is not a key, and drawing it as one is how a manager
      // ends up sizing the open-tables strip like a button. Each shows a sketch
      // of what the till will put there.
      if (b && b.kind === 'function' && SP_WIDGET_KEYS.has(b.functionKey)) {
        cell.classList.add('widget');
        const mock = document.createElement('span');
        mock.className = 'sp-widget';
        mock.innerHTML = spWidgetSketch(b.functionKey);
        cell.append(mock);
      } else if (b && b.kind === 'page') {
        const arrow = document.createElement('em');
        arrow.className = 'sp-arrow';
        arrow.textContent = '›››';
        cell.append(arrow);
      } else if (b && b.kind === 'function') {
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

/**
 * A sketch of what a live display puts on the till.
 *
 * Deliberately fake numbers and a fixed clock: this is a drawing of a shape,
 * not a preview of data, and a real total here would be read as one. The shapes
 * are what matter — the open-tables strip is chips, the total is money, the
 * clock is short — because they are what tells a manager how wide to make it.
 */
function spWidgetSketch(key) {
  switch (key) {
    case 'open_bills':
      return (
        '<i class="sp-chip on">Current</i><i class="sp-chip">Table 6</i>' +
        '<i class="sp-chip">Table 8</i><i class="sp-chip">Table 12</i>'
      );
    case 'order_total':
      return '<i class="sp-mono">£32.85</i>';
    case 'clock':
      return '<i class="sp-mono">12:46</i>';
    case 'venue_name':
      return '<i>THE BRIDGE</i>';
    case 'staff_name':
      return '<i>👤 Muzahid</i>';
    case 'sync_status':
      return '<i>● Online</i>';
    case 'print_status':
      // Draws nothing on the till when there is nothing to report, which is
      // most of the time — the preview says what it is rather than showing a
      // blank cell the manager would take for a broken key.
      return '<i>🖨 Kitchen</i>';
    case 'screen_name':
      return '<i>Drinks</i>';
    case 'spacer':
      return '';
    default:
      return '';
  }
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
    const name = SP_FUNCTION_LABEL.get(b.functionKey);
    return name ? `Till function — ${name}` : 'Till function — none chosen';
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
  const found = spIssues();
  const broken = found.filter((i) => i.severity === 'bad');

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
      : '') +
    (found.length > broken.length
      ? `<span class="sp-flag warn">${found.length - broken.length} to check</span>`
      : '');

  $('sp-undo').disabled = !spUndoStack.length;
  $('sp-redo').disabled = !spRedoStack.length;

  // The check list. Only shown when there is something to say, because a
  // permanently empty panel is one nobody reads when it fills up.
  const issues = $('sp-issues');
  $('sp-issues-card').hidden = !found.length;
  issues.innerHTML = found
    .map(
      (i) =>
        `<button type="button" class="sp-issue ${i.severity}"` +
        (i.row == null ? '' : ` data-row="${i.row}" data-col="${i.col}"`) +
        `><strong>${esc(i.where)}</strong>` +
        `<span class="muted small">${esc(i.what)}</span></button>`
    )
    .join('');
}

/**
 * Everything wrong with this layout, in the order a manager should look at it.
 *
 * Two severities, and the second one is why this function exists rather than a
 * filter over `spMissing`:
 *
 *   bad   a key that points at something no longer there. The clerk meets it as
 *         a key that refuses the press.
 *   warn  a bar that is missing the thing that made it worth having. A top bar
 *         with no open-tables key looks finished and quietly costs the venue the
 *         ability to run two bills at once; a bottom bar with no Pay key looks
 *         finished and cannot take money. Neither is broken — both are a layout
 *         somebody will save, walk away from, and discover in service.
 *
 * That second class is the whole risk in letting a venue replace its chrome, so
 * it is checked here rather than hoped for.
 */
function spIssues() {
  if (!spCurrent) return [];
  const surface = spCurrentSurface();
  const buttons = spCurrent.buttons || [];
  const out = [];

  for (const b of buttons.filter(spMissing)) {
    out.push({
      severity: 'bad',
      row: b.row,
      col: b.col,
      where: `Row ${b.row + 1}, column ${b.col + 1}`,
      what: spCellTitle(b),
    });
  }

  const hasKey = (key) =>
    buttons.some((b) => b.kind === 'function' && b.functionKey === key);

  if (spIsBar(surface) && !buttons.length) {
    out.push({
      severity: 'warn',
      row: null,
      where: 'This bar is empty',
      what: 'Tills wearing it would show a blank strip. Press "Lay out the built-in bar" to start from what you have today.',
    });
  }

  if (surface === 'topbar' && buttons.length && !hasKey('open_bills')) {
    out.push({
      severity: 'warn',
      row: null,
      where: 'No open-tables key',
      what: 'The strip of open bills is the top bar today. Without it staff cannot switch between tables, and there is no other way to reach a bill that is sitting on one.',
    });
  }

  if (surface === 'bottombar' && buttons.length && !hasKey('pay')) {
    out.push({
      severity: 'warn',
      row: null,
      where: 'No Pay key',
      what: 'Nothing on this bar takes money. A clerk would have to leave the sale screen to settle a bill.',
    });
  }

  return out;
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
    spOnSurface('sale')
      // Sale screens only. A key that jumped to a bottom bar would open a strip
      // of eleven keys where a page of products belongs, and there is no reading
      // of it that is useful — the same argument as the line below.
      //
      // A screen may not point at itself: the button would do nothing and look
      // broken.
      .filter((s) => s.id !== spCurrent.id)
      .map(
        (s) =>
          `<option value="${s.id}"${
            s.id === first.targetScreenId ? ' selected' : ''
          }>${esc(s.name)}</option>`
      )
      .join('');

  const groups = spFunctionsFor(spCurrentSurface());
  $('sp-function').innerHTML =
    '<option value="">Choose a function…</option>' +
    groups
      .map(([group, keys]) => {
        const options = keys
          .map(
            ([key, label]) =>
              `<option value="${key}"${key === first.functionKey ? ' selected' : ''}>` +
              esc(label) +
              '</option>'
          )
          .join('');
        return group ? `<optgroup label="${esc(group)}">${options}</optgroup>` : options;
      })
      .join('');

  // What a live display will actually put there, said in words next to the
  // dropdown — the grid draws a sketch of it, but the sketch cannot say that
  // this key is the only way staff reach a bill sitting on a table.
  const note = $('sp-function-note');
  note.textContent =
    first.functionKey === 'open_bills'
      ? 'Draws the strip of open bills — this bill plus every booked table. Give it plenty of width; it scrolls sideways when there are more tables than fit.'
      : SP_WIDGET_KEYS.has(first.functionKey)
        ? 'Draws something live. It is not pressed.'
        : '';

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

  spRenderFace(first, styleable);
}

/**
 * The picture on the key.
 *
 * An emoji, or an uploaded picture, or neither — and neither is the common case
 * and has to cost nothing, because most keys on most screens are a word on a
 * colour and that is the layout the venue arranged.
 *
 * The inherited case is the one worth being careful about. A product key with
 * no face of its own already shows the product's picture on the till, and has
 * for years. Showing that here as though the key had been given it would make
 * "Remove" look broken; showing nothing would make the till look like it had
 * invented a picture. So it is shown, faded, and said in words.
 */
function spRenderFace(first, styleable) {
  const face = spFaceFor(first);
  const own = face && face.own;

  spSet($('sp-emoji'), (own && face.emoji) || '');
  $('sp-emoji').disabled = !styleable;
  $('sp-image-upload').disabled = !styleable;
  $('sp-face-clear').disabled = !styleable || !own;

  const preview = $('sp-image-preview');
  preview.className = 'sp-image-preview';
  preview.textContent = '';
  preview.style.backgroundImage = '';
  if (face && face.image) {
    preview.classList.add('img', ...(own ? [] : ['inherited']));
    preview.style.backgroundImage = `url("${face.image.replace(/"/g, '%22')}")`;
  } else if (face && face.emoji) {
    preview.classList.add(...(own ? [] : ['inherited']));
    preview.textContent = face.emoji;
  } else {
    preview.classList.add('empty');
    preview.textContent = '—';
  }

  $('sp-emoji-palette').innerHTML = SP_EMOJI.map(
    (e) =>
      `<button type="button" class="sp-emoji-key${
        own && face.emoji === e ? ' on' : ''
      }" data-emoji="${e}">${e}</button>`
  ).join('');

  $('sp-gallery').innerHTML = spGallery
    .map(
      (url) =>
        `<button type="button" class="sp-gallery-key${
          own && face.image === url ? ' on' : ''
        }" data-image="${esc(url)}" style="background-image:url('${esc(url)}')"></button>`
    )
    .join('');

  $('sp-face-note').textContent = !styleable
    ? ''
    : face && !face.own
      ? 'Showing this product’s own picture. Set one here to override it just on this key.'
      : '';
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

  // Geometry FIRST, focus second, and the focus must not scroll.
  //
  // `grid.focus()` used to run above this line, and on any page tall enough to
  // scroll it moved the grid between the pointer's coordinates being taken and
  // the grid's box being measured — so `e.clientY` was pre-scroll and `box.top`
  // was post-scroll, and the first press after landing on the page selected a
  // key one or two rows away from the one under the finger. Every press after
  // it was right, because nothing scrolled the second time. That is precisely
  // the shape of "the editor is buggy on my Windows 11 laptop": intermittent,
  // only on a short window, and impossible to reproduce on the machine of
  // whoever it is reported to.
  //
  // `preventScroll` because the grid is already under the pointer. There is
  // nothing to bring into view, and the browser's idea of "into view" is what
  // moved it.
  grid.focus({ preventScroll: true });

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

  // ---- Which kind of layout ----
  for (const tab of document.querySelectorAll('.sp-surface')) {
    tab.addEventListener('click', () => {
      if (tab.dataset.surface === spSurface) return;
      if (!spGuardUnsaved()) return;
      spSurface = tab.dataset.surface;
      const first = spOnSurface()[0];
      spSelect(first ? first.id : null);
      spRenderChrome();
    });
  }

  // ---- What the tills wear ----
  for (const [id, surface] of [
    ['sp-def-home', 'sale'],
    ['sp-def-top', 'topbar'],
    ['sp-def-bottom', 'bottombar'],
  ]) {
    $(id).addEventListener('change', (e) =>
      spSetDefault(surface, e.target.value ? Number(e.target.value) : null)
    );
  }

  // The drawing is the way in as well as the answer: press the strip along the
  // bottom of the little till and the editor opens the bottom bars.
  $('sp-till-preview').addEventListener('click', (e) => {
    const part = e.target.closest('[data-part]');
    if (!part) return;
    const tab = document.querySelector(
      `.sp-surface[data-surface="${part.dataset.part}"]`
    );
    if (tab) tab.click();
  });

  for (const [id, field] of [
    ['sp-screen-top', 'topBarId'],
    ['sp-screen-bottom', 'bottomBarId'],
  ]) {
    $(id).addEventListener('change', (e) =>
      spSetScreenBar(field, e.target.value ? Number(e.target.value) : null)
    );
  }

  $('sp-new').addEventListener('click', spNewScreen);
  $('sp-rename').addEventListener('click', spRenameScreen);
  $('sp-duplicate').addEventListener('click', spDuplicateScreen);
  $('sp-delete').addEventListener('click', spDeleteScreen);
  $('sp-popout')?.addEventListener('click', spPopOut);
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
  // Double-click a key to search for what it should be. The cell is selected
  // by the pointerdown that precedes the double-click, so by the time this
  // fires the selection is already the key that was hit.
  grid.addEventListener('dblclick', (e) => {
    if (!e.target.closest('.sp-cell')) return;
    e.preventDefault();
    spOpenPalette();
  });

  grid.addEventListener('keydown', spGridKeys);

  $('sp-issues').addEventListener('click', (e) => {
    const issue = e.target.closest('.sp-issue');
    // An advisory about the layout as a whole — "no Pay key on this bar" — has
    // no cell to jump to. It is still worth showing; it is just not a link.
    if (!issue || issue.dataset.row === undefined) return;
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
  // A face is committed on change, not on every keystroke, so the undo stack
  // holds "put an emoji on this key" once rather than once per character —
  // the same rule the label field follows and for the same reason.
  $('sp-emoji').addEventListener('change', (e) => {
    const emoji = e.target.value.trim().slice(0, 16);
    spApplyToSelection(
      (b) => {
        b.emoji = emoji || null;
      },
      { create: false }
    );
  });
  $('sp-emoji-palette').addEventListener('click', (e) => {
    const key = e.target.closest('.sp-emoji-key');
    if (!key) return;
    // Pressing the one already on the key takes it off, so the palette is a
    // toggle rather than a one-way door with an undo.
    const chosen = key.classList.contains('on') ? null : key.dataset.emoji;
    spApplyToSelection(
      (b) => {
        b.emoji = chosen;
      },
      { create: false }
    );
  });
  $('sp-gallery').addEventListener('click', (e) => {
    const key = e.target.closest('.sp-gallery-key');
    if (!key) return;
    const chosen = key.classList.contains('on') ? null : key.dataset.image;
    spApplyToSelection(
      (b) => {
        b.imageUrl = chosen;
      },
      { create: false }
    );
  });
  $('sp-face-clear').addEventListener('click', () =>
    spApplyToSelection(
      (b) => {
        b.emoji = null;
        b.imageUrl = null;
      },
      { create: false }
    )
  );
  $('sp-image-upload').addEventListener('click', () => $('sp-image-file').click());
  $('sp-image-file').addEventListener('change', spUploadKeyImage);

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
  $('sp-preset').addEventListener('click', spLayOutBuiltInBar);

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
  const surface = spSurface;
  const max = spLimits(surface);
  const noun =
    surface === 'topbar' ? 'top bar' : surface === 'bottombar' ? 'bottom bar' : 'screen';

  modal(
    `New ${noun}`,
    [
      { name: 'name', label: `What is this ${noun} called?`, required: true, value: '' },
      {
        name: 'copy',
        label: spCurrent
          ? 'Start from a copy of "' + spCurrent.name + '" — otherwise it starts empty'
          : 'Start from a copy — there is nothing to copy yet',
        type: 'checkbox',
        value: 0,
      },
      { name: 'rows', label: 'Rows', type: 'number', value: max.defRows },
      { name: 'cols', label: 'Columns', type: 'number', value: max.defCols },
    ],
    async (data) => {
      const created = await api('/screens', {
        method: 'POST',
        body: JSON.stringify({
          name: data.name,
          surface,
          rows: Number(data.rows) || max.defRows,
          cols: Number(data.cols) || max.defCols,
          // Only ever a copy of something on the same surface. The server
          // refuses a cross-surface copy outright — a Pay key has nowhere to go
          // on a page of lagers — and the tab this was opened from is the
          // surface being made.
          //
          // `Number(...)`, not the value itself. A checkbox in this form submits
          // the *string* "0" when it is clear, and "0" is truthy in JavaScript —
          // so every new screen was made as a copy of whichever one was open,
          // however carefully the box was left unticked. That is the whole of
          // "creating a new page still copies the page".
          copyFromId:
            Number(data.copy) && spCurrent && spCurrentSurface() === surface
              ? spCurrent.id
              : null,
        }),
      });
      spSurface = created.surface || 'sale';
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

  // Unique on this surface, which is what the database's key is: (office,
  // surface, name). A bottom bar called "Main" and a sale screen called "Main"
  // are allowed to coexist, so a copy must not be renamed to dodge a clash that
  // is not one.
  const surface = spCurrentSurface();
  const base = spCurrent.name.replace(/ \(copy( \d+)?\)$/, '');
  let name = `${base} (copy)`;
  for (let n = 2; spOnSurface(surface).some((s) => s.name === name); n++) {
    name = `${base} (copy ${n})`;
  }

  try {
    const created = await api('/screens', {
      method: 'POST',
      body: JSON.stringify({ name, surface, copyFromId: spCurrent.id }),
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
  const order = spOnSurface(spCurrentSurface()).map((s) => s.id);
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
      `Delete "${spCurrent.name}"?\n\n` +
        (spIsBar(spCurrentSurface())
          ? 'Any till or screen wearing it goes back to the built-in bar.'
          : 'Buttons on other screens that point at it become empty, and if your tills ' +
            'open on it they fall back to the built-in Default.')
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

/** The tick box beside the screen picker: "my tills wear this one". */
async function spSetHome(e) {
  if (!spCurrent) return;
  await spSetDefault(spCurrentSurface(), e.target.checked ? spCurrent.id : null);
}

/**
 * Set one of the three things a till wears, or clear it back to the built-in.
 *
 * Applied straight away rather than on Save. It is not part of the layout in
 * hand — a manager who ticks this and then reverts their button changes has not
 * asked to un-set their home screen — and it is the one setting on this page
 * that every till in the building acts on.
 */
async function spSetDefault(surface, id) {
  const field =
    surface === 'topbar'
      ? 'topBarScreenId'
      : surface === 'bottombar'
        ? 'bottomBarScreenId'
        : 'homeScreenId';
  try {
    await api('/screens/defaults', {
      method: 'PUT',
      body: JSON.stringify({ [field]: id }),
    });
    if (surface === 'topbar') spDefaults.top = id;
    else if (surface === 'bottombar') spDefaults.bottom = id;
    else spDefaults.home = id;
    spRenderChrome();
  } catch (err) {
    alert(err.message);
    spRenderChrome();
  }
}

/**
 * Give this one page a different bar from the rest of the venue.
 *
 * Saved on the screen row rather than with the buttons, so it takes effect
 * without a layout save — the same reasoning as the defaults above, and the
 * same reason it is written through even when the grid is dirty.
 */
async function spSetScreenBar(field, id) {
  if (!spCurrent) return;
  try {
    await api('/screens/' + spCurrent.id, {
      method: 'PUT',
      body: JSON.stringify({ [field]: id }),
    });
    spCurrent[field] = id;
    const stored = spScreens.find((s) => s.id === spCurrent.id);
    if (stored) stored[field] = id;
    spRenderChrome();
  } catch (err) {
    alert(err.message);
    spRenderChrome();
  }
}

/**
 * Put a picture on the selected keys.
 *
 * Uploaded through the same route product pictures use, so it lands under
 * /uploads and is served by this server — the till has to be able to fetch it
 * on a venue network with no route to the open internet, which is why the
 * server refuses an off-site URL outright.
 */
async function spUploadKeyImage(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;

  const button = $('sp-image-upload');
  const was = button.textContent;
  button.disabled = true;
  button.textContent = 'Uploading…';
  try {
    const form = new FormData();
    form.append('image', file);
    const res = await fetch('/api/product-image', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || 'The picture would not upload.');

    spApplyToSelection(
      (b) => {
        b.imageUrl = body.url;
      },
      { create: false }
    );
    if (!spGallery.includes(body.url)) spGallery.unshift(body.url);
    spRenderInspector();
  } catch (err) {
    alert(err.message);
  } finally {
    button.disabled = false;
    button.textContent = was;
  }
}

/**
 * Lay the built-in bar into this one, key for key.
 *
 * The reason a venue ever gets a bar finished. Eleven keys placed, coloured and
 * labelled one at a time is where this feature would otherwise be abandoned
 * half-done — and a half-done bottom bar is one with no way to take money on it.
 *
 * These lists mirror the till's own: PosActionBar's `actions` in sale_page.dart
 * for the bottom, and _OpenOrdersBar for the top. They are a starting point,
 * not a contract — a venue is expected to change them, which is the point.
 */
function spLayOutBuiltInBar() {
  if (!spCurrent || !spIsBar(spCurrentSurface())) return;
  const top = spCurrentSurface() === 'topbar';

  const keys = top
    ? [
        ['open_bills', null, null, 8],
        ['staff_name', null, null, 2],
        ['clock', null, null, 2],
      ]
    : [
        ['void', 'Void', '#d03227', 1],
        ['cancel', 'Cancel', '#d03227', 1],
        ['save_table', 'Save Table', null, 1],
        ['covers', 'Covers', null, 1],
        ['customer', 'Customer', null, 1],
        ['note', 'Notes', null, 1],
        ['open_drawer', 'No Sale', null, 1],
        ['print_bill', 'Print', null, 1],
        ['last_bill', 'Last Bill', null, 1],
        ['pay', 'Pay', '#a5c715', 3],
      ];

  const width = keys.reduce((n, k) => n + k[3], 0);
  const message = top
    ? 'Your tills\u2019 top bar today is the strip of open tables and nothing else. ' +
      'This lays that in across most of the width, with who is signed on and a clock ' +
      'beside it \u2014 delete either if you do not want them.\n\nAnything already on ' +
      'this bar is replaced.'
    : 'This lays in the bottom bar your tills show today, key for key, ending with a ' +
      'wide green Pay.\n\nAnything already on this bar is replaced.';
  if (spCurrent.buttons.length && !confirm(message)) return;

  spEdit(() => {
    spCurrent.rows = 1;
    spCurrent.cols = width;
    spCurrent.buttons = keys.map(([key, label, fill, span], i) => ({
      row: 0,
      col: keys.slice(0, i).reduce((n, k) => n + k[3], 0),
      rowSpan: 1,
      colSpan: span,
      kind: 'function',
      pluId: null,
      targetScreenId: null,
      functionKey: key,
      // Null where the built-in label is already right, so a key renamed in a
      // later release renames itself here too.
      label: label,
      fill,
      ink: null,
      emoji: null,
      imageUrl: null,
    }));
    spSelection = new Set();
  });
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

// Applied before anything draws, so the editor never flashes the full page
// chrome on its way to being a window of its own. Self-contained here rather
// than in app.js's boot, because it is entirely the editor's business.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', spApplyPopupMode);
} else {
  spApplyPopupMode();
}
