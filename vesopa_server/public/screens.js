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
 * Swatches first, and a wheel beside them.
 *
 * This list used to be the whole story, and the comment here used to argue
 * that a wheel was a mistake: it picks a colour nobody meant, and the failure —
 * a key that cannot be read across a counter — is only found in service. That
 * argument was half right. It is a good reason for these twelve to be the ones
 * a hurried manager reaches for, and every one of them works with the ink the
 * till picks for it. It is not a reason to make a venue's brand colour
 * unreachable, which is what having only these did.
 *
 * So: twelve safe colours, one press each, and a wheel underneath for the
 * venue that has a hex from a brand book. The thing that made the wheel safe
 * is the lettering control next to it — a custom fill and a custom ink
 * together can always be made readable, and the till's automatic ink is still
 * what happens if neither is touched.
 */
const SP_FILLS = [
  '#111111', '#1e2430', '#3a1e1e', '#14312b', '#2b1e3a', '#a5c715',
  '#4b57e8', '#21a73e', '#ce7a0a', '#d03227', '#00a6a6', '#f4f6fa',
];

/**
 * The two named lettering colours, and the key colour a till uses when a
 * button has none of its own.
 *
 * Named because they are compared against as well as written: the inspector
 * works out which of "Light", "Dark" and "a colour of my own" is showing by
 * looking at the stored ink, and two string literals in two places is how that
 * check quietly stops matching.
 */
const SP_INK_LIGHT = '#f4f6fa';
const SP_INK_DARK = '#111111';

/** Mirrors the till's own default key colour, and .sp-cell.filled in style.css. */
const SP_DEFAULT_FILL = '#2b313d';

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

// ---------------------------------------------------------------------------
// Lettering
// ---------------------------------------------------------------------------

/**
 * Every font this venue may letter a till in — the sixteen built-ins and
 * anything it has uploaded. Fetched with the screens; see src/fonts.js for why
 * the files are served from this back office rather than from Google.
 */
let spFonts = [];

/** The venue's font. Every key without one of its own inherits it. */
let spTillFont = null;

/**
 * The height, in the till's own logical pixels, of the space a sale grid gets.
 *
 * Only here so the editor can draw a font size that means something. A key's
 * size is stored in points and the editor's grid is a few hundred pixels tall,
 * so putting `font-size: 24px` on a preview cell would show a manager lettering
 * twice the size of what the till will actually draw — and they would set 12 to
 * compensate and find the counter unreadable.
 *
 * Taken from a 1280x800 terminal, which is the common cheap one, less the two
 * bars and the bill panel. It is an assumption and it is allowed to be: the
 * preview only has to be in proportion, and every till is in proportion to
 * itself because the grid is laid out into whatever space it has.
 */
const SP_TILL_GRID_HEIGHT = 620;

/**
 * The CSS font stack for a slug.
 *
 * Single quotes, not double, because this string is also written into a
 * `style="…"` attribute in the fonts list, and a double quote there ends the
 * attribute and puts the rest of the family name into the markup.
 *
 * An unknown slug is left in the stack rather than stripped. It resolves to
 * nothing and the browser falls through to system-ui — which is exactly what
 * the till does with a font it cannot find, so a key whose font a venue has
 * since deleted looks the same in both places.
 */
function spFontCss(slug) {
  if (!slug) return '';
  return `'vf-${String(slug).replace(/[^a-z0-9-]/gi, '')}', system-ui, sans-serif`;
}

/**
 * Teach the browser the venue's fonts, once per load of the list.
 *
 * A <style> built here rather than a stylesheet fetched from the server: the
 * list is already in hand, it is a dozen lines of CSS, and a second request
 * would need the office in a query string on a page that authenticates with a
 * bearer token.
 */
function spRenderFontFaces() {
  let tag = document.getElementById('sp-font-faces');
  if (!tag) {
    tag = document.createElement('style');
    tag.id = 'sp-font-faces';
    document.head.append(tag);
  }
  tag.textContent = spFonts
    .flatMap((font) =>
      font.faces.map(
        (face) =>
          `@font-face{font-family:'vf-${font.slug}';font-style:normal;` +
          `font-weight:${face.weight};font-display:swap;` +
          `src:url("${face.url}") format("${
            String(face.url).endsWith('.otf') ? 'opentype' : 'truetype'
          }")}`
      )
    )
    .join('\n');
}

/**
 * The options for a font picker.
 *
 * A venue's own fonts come first. They are the reason this feature exists — a
 * manager opening this list is usually looking for their brand font, not for
 * the eleventh sans-serif — and putting sixteen built-ins above them means
 * scrolling past the answer.
 */
function spFontOptions(selected, noneLabel) {
  const own = spFonts.filter((f) => !f.builtIn);
  const builtIn = spFonts.filter((f) => f.builtIn);
  const opt = (f) =>
    `<option value="${spEsc(f.slug)}"${
      f.slug === selected ? ' selected' : ''
    }>${spEsc(f.family)}</option>`;
  return (
    `<option value=""${selected ? '' : ' selected'}>${spEsc(noneLabel)}</option>` +
    (own.length
      ? `<optgroup label="Your fonts">${own.map(opt).join('')}</optgroup>`
      : '') +
    (builtIn.length
      ? `<optgroup label="Built in">${builtIn.map(opt).join('')}</optgroup>`
      : '')
  );
}

/** The venue's font, and the list of what it has uploaded. */
function spRenderFontsCard() {
  $('sp-till-font').innerHTML = spFontOptions(
    spTillFont,
    'The app’s own lettering'
  );

  const own = spFonts.filter((f) => !f.builtIn);
  $('sp-font-list').innerHTML = own.length
    ? own
        .map(
          (f) => `<div class="sp-font-row">
            <span class="sp-font-name" style="font-family:${spFontCss(f.slug)}"
                  title="${spEsc(f.family)}">${spEsc(f.family)}</span>
            <span class="muted small">${f.faces
              .map((x) => (Number(x.weight) === 700 ? 'Bold' : 'Regular'))
              .join(' · ')}</span>
            <button type="button" class="btn danger-ghost small"
                    data-font-remove="${spEsc(f.slug)}">Remove</button>
          </div>`
        )
        .join('')
    : '<p class="muted small" style="margin:6px 0 0">No fonts of your own yet.</p>';
}

/**
 * Upload a font file.
 *
 * The name and the weight are asked for rather than guessed. A foundry ships
 * `BrandSans-Bd_v2_FINAL.ttf`, and a guess that "Bd" means bold is the kind of
 * cleverness that letters half a venue's screen in the wrong weight — so the
 * filename only seeds the box, and the manager confirms it.
 */
function spAddFont(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;

  const stem = file.name.replace(/\.[^.]+$/, '');
  const guess = stem
    .replace(/[-_]+/g, ' ')
    .replace(/\b(regular|bold|black|light|medium|italic|v\d+|final)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  modal(
    'Add a font',
    [
      { label: 'What to call it', name: 'family', value: guess, required: true },
      {
        label: 'Which weight this file is',
        name: 'weight',
        type: 'select',
        options: [
          { value: '400', label: 'Regular' },
          { value: '700', label: 'Bold' },
        ],
        value: /bold|black|heavy|semibold|[-_]700/i.test(stem) ? '700' : '400',
      },
    ],
    async (data) => {
      const form = new FormData();
      form.append('font', file);
      form.append('family', data.family || guess);
      form.append('weight', data.weight || '400');
      const res = await fetch('/api/fonts', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
      const body = await res.json().catch(() => ({}));
      // The server's message is the useful one — it is the only thing that can
      // say "a .woff2 works in a browser but not on a till".
      if (!res.ok) throw new Error(body.error || 'That font would not upload.');
      await spLoadFonts();
      spRenderFontsCard();
      spRenderInspector();
      spRenderGrid();
    }
  );
}

/** Remove one of the venue's own fonts. */
async function spRemoveFont(slug) {
  const font = spFonts.find((f) => f.slug === slug);
  if (!font) return;
  if (
    !confirm(
      `Remove ${font.family}? Any key lettered in it goes back to your tills’ ` +
        'font. Nothing else changes.'
    )
  ) {
    return;
  }
  try {
    await api(`/fonts/${encodeURIComponent(slug)}`, { method: 'DELETE' });
  } catch (err) {
    alert(err.message);
    return;
  }
  if (spTillFont === slug) spTillFont = null;
  await spLoadFonts();
  spRenderFontsCard();
  spRenderGrid();
  spRenderInspector();
}

/** Fetch the font list and teach the browser the faces in it. */
async function spLoadFonts() {
  try {
    const body = await api('/fonts');
    spFonts = Array.isArray(body.fonts) ? body.fonts : [];
  } catch {
    // A back office that has not had schema_fonts.sql applied yet, or a network
    // blip. No fonts is a working editor with plain lettering, which beats a
    // screen-programming page that will not open.
    spFonts = [];
  }
  spRenderFontFaces();
}

/**
 * The venue's font, saved as soon as it is chosen.
 *
 * Straight through to /till-settings rather than waiting for Save layout: this
 * is not part of the layout, it belongs to the venue, and a manager who picks a
 * font and then reverts a screen should not lose it.
 */
async function spSetTillFont(slug) {
  const was = spTillFont;
  spTillFont = slug || null;
  spRenderGrid();
  spRenderInspector();
  try {
    await api('/till-settings', {
      method: 'PUT',
      // Stringified. `api()` spreads its options into fetch, so an object here
      // arrives at the server as the literal text "[object Object]" — which
      // parses as nothing, 400s, and looks exactly like the font not sticking.
      body: JSON.stringify({ font_family: spTillFont || '' }),
    });
  } catch (err) {
    spTillFont = was;
    spRenderFontsCard();
    spRenderGrid();
    alert(err.message);
  }
}

/**
 * Draw every preview label at the size the till will draw it.
 *
 * Split out from spRenderGrid and run again whenever the grid changes size,
 * because the grid's height is what a point is measured against and on the
 * first paint of the page that height is zero. Without the observer, opening
 * the editor showed every sized key at its floor until something else redrew it.
 */
function spApplyTypeScale() {
  const box = $('sp-grid');
  const height = box.clientHeight;
  if (!height) return;
  const scale = height / SP_TILL_GRID_HEIGHT;
  for (const cell of spCells.values()) {
    const pt = Number(cell.dataset.pt);
    cell.style.fontSize = pt ? `${Math.max(6, pt * scale).toFixed(1)}px` : '';
  }
}

let spTypeObserver = null;

function spWatchTypeScale() {
  if (spTypeObserver || typeof ResizeObserver === 'undefined') return;
  spTypeObserver = new ResizeObserver(() => spApplyTypeScale());
  spTypeObserver.observe($('sp-grid'));
}

/**
 * Wire a colour wheel and the hex box beside it to one field on a button.
 *
 * The pair exists because neither half is enough on its own. A wheel hides the
 * value, so a venue matching a brand colour cannot read back what it landed on
 * or paste in what the brand book says; a hex box alone is unusable for
 * anybody choosing rather than copying. Same reasoning as the `color` field in
 * app.js's fieldHtml, which pairs them for the same reason.
 *
 * Both commit on `change`, never on `input`. A colour input fires `input` for
 * every pixel the pointer crosses inside the picker, and each of those would be
 * an undo step — two hundred presses of Ctrl+Z to take back one colour.
 */
function spBindColour(wheelId, hexId, field) {
  const wheel = $(wheelId);
  const hex = $(hexId);

  const apply = (value) => {
    const colour = /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : null;
    if (!colour) return;
    spSet(wheel, colour);
    spSet(hex, colour);
    spApplyToSelection(
      (b) => {
        b[field] = colour;
      },
      { create: false }
    );
  };

  wheel.addEventListener('change', () => apply(wheel.value));
  hex.addEventListener('change', () => {
    const typed = hex.value.trim();
    if (!typed) {
      // Cleared, which means "put it back to the till's". Only reachable from
      // the box: a colour input has no empty.
      spApplyToSelection(
        (b) => {
          b[field] = null;
        },
        { create: false }
      );
      spRenderInspector();
      return;
    }
    // A brand book writes `#A5C715` and a person types `a5c715`. Both are the
    // same colour and refusing one of them helps nobody.
    apply(typed.startsWith('#') ? typed : `#${typed}`);
  });
}

// ---------------------------------------------------------------------------
// The corner handle
// ---------------------------------------------------------------------------

/**
 * How big this key may grow before it hits something.
 *
 * A resize refuses to swallow its neighbours, which is a deliberate difference
 * from what spTidy() would do if simply handed overlapping spans: it drops the
 * covered button. Dragging a corner is a gesture where the pointer routinely
 * overshoots by a cell, and a gesture that silently deletes the key next to it
 * on an overshoot is one that costs a venue a layout. The handle stops instead,
 * visibly, and clearing the neighbour first is one extra press.
 *
 * Rows are settled before columns rather than searching for the largest
 * rectangle that fits. A best-fit search can answer a 3x1 to a pointer asking
 * for 2x2, which reads as the handle jumping sideways out from under the
 * finger. Settling one axis and then the other always moves toward the pointer.
 */
function spSpanRoom(button, wantRows, wantCols) {
  const grid = spCurrent;
  const blocked = new Set();
  for (const other of grid.buttons) {
    if (other === button) continue;
    for (let r = other.row; r < other.row + (other.rowSpan || 1); r++) {
      for (let c = other.col; c < other.col + (other.colSpan || 1); c++) {
        blocked.add(spKey(r, c));
      }
    }
  }

  const free = (rs, cs) => {
    for (let r = button.row; r < button.row + rs; r++) {
      for (let c = button.col; c < button.col + cs; c++) {
        if (blocked.has(spKey(r, c))) return false;
      }
    }
    return true;
  };

  let rowSpan = Math.max(1, Math.min(wantRows, grid.rows - button.row));
  while (rowSpan > 1 && !free(rowSpan, 1)) rowSpan--;
  let colSpan = Math.max(1, Math.min(wantCols, grid.cols - button.col));
  while (colSpan > 1 && !free(rowSpan, colSpan)) colSpan--;
  return { rowSpan, colSpan };
}

/**
 * Put the drag handle on the one selected cell, and nowhere else.
 *
 * One cell only. A handle on each of six selected keys asks "which one am I
 * resizing?", and the honest answer — all of them, into each other — is not a
 * gesture anybody wants. Hidden in Preview, which is the mode for looking at
 * the screen as a clerk does.
 *
 * On an *empty* cell as much as on a programmed one, which is what this
 * originally would not do. A manager lays a screen out by arranging the shapes
 * first and saying what each one does afterwards — that is the order the work
 * actually happens in — and a handle that appears only once a key already has a
 * product on it makes that order impossible. See spResizeTarget for what the
 * drag then creates.
 */
function spPaintHandle() {
  for (const cell of spCells.values()) {
    cell.querySelector('.sp-handle')?.remove();
  }
  if (spPreview || spSelection.size !== 1) return;

  const key = [...spSelection][0];
  const cell = spCells.get(key);
  if (!cell) return;

  const handle = document.createElement('span');
  handle.className = 'sp-handle';
  handle.title = spAt(...key.split(':').map(Number))
    ? 'Drag to make this key bigger or smaller'
    : 'Drag to set aside a bigger space — give it a product afterwards';
  cell.append(handle);
}

/**
 * The button a corner drag is about to resize, brought into being if need be.
 *
 * An empty cell has no button behind it, so there is nothing to put a span on.
 * Rather than refuse the gesture, the reservation is created at the moment the
 * handle is picked up — a blank that holds ground, in spHoldsSpace's sense. If
 * the drag ends back at 1x1 the blank is dropped again by spTidy and no undo
 * step is pushed, so picking the handle up and putting it down costs nothing.
 *
 * Returns null when there is nothing sensible to resize.
 */
function spResizeTarget() {
  const chosen = spSelectedButtons();
  if (chosen.length) return chosen[0];
  if (spSelection.size !== 1) return null;

  const [row, col] = [...spSelection][0].split(':').map(Number);
  if (row >= spCurrent.rows || col >= spCurrent.cols) return null;
  const button = { row, col, rowSpan: 1, colSpan: 1, kind: 'blank' };
  spCurrent.buttons.push(button);
  return button;
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

/**
 * The last press on the grid, so a second one on the same key can be told from
 * two presses on two keys.
 *
 * `{ key, at }` — which cell, and when. See spDragStart for why a `dblclick`
 * listener cannot do this job.
 */
let spLastPress = null;

/** How close together two presses have to be to be one double-press. */
const SP_DOUBLE_MS = 450;

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
    // Its own call rather than a fourth entry destructured above, because it
    // swallows its own failure: a back office that has not had the font
    // migration applied yet still opens the editor, lettered plainly.
    spLoadFonts(),
  ]);

  spScreens = screens;
  spProducts = products;
  spDefaults = {
    home: settings.home_screen_id ?? null,
    top: settings.top_bar_screen_id ?? null,
    bottom: settings.bottom_bar_screen_id ?? null,
  };
  spTillFont = settings.font_family ?? null;
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

/**
 * How a picture sits on a key: the fit, the zoom, and the shift.
 *
 * One place for the arithmetic, because three things have to agree about it —
 * the grid preview, the framing stage in the inspector, and the till. See
 * schema_screens_key_images.sql for the model itself, and for why the numbers
 * are integer percentages rather than floats.
 *
 * Every field is allowed to be absent, and absent means the plain answer: fill
 * the key, no zoom, centred. That is what every key drew before there was
 * anything to set, so a venue that never opens this control sees no change.
 */
function spFrameOf(b) {
  const num = (v, lo, hi, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : fallback;
  };
  return {
    fit: b && b.imageFit === 'contain' ? 'contain' : 'cover',
    scale: num(b && b.imageScale, 20, 400, 100),
    x: num(b && b.imageX, -100, 100, 0),
    y: num(b && b.imageY, -100, 100, 0),
  };
}

/**
 * The two CSS properties that frame is.
 *
 * `translate()` before `scale()` in the string, which CSS reads right to left —
 * so the picture is scaled first and then shifted, and the shift is a
 * percentage of the key's own size rather than of the zoomed picture. That
 * order is what makes a drag across the stage move the picture by the distance
 * the pointer moved, at any zoom. The till composes the same two steps in the
 * same order: see `_picture` in programmed_grid.dart.
 */
function spFrameStyle(frame) {
  return {
    objectFit: frame.fit,
    transform: `translate(${frame.x}%, ${frame.y}%) scale(${frame.scale / 100})`,
  };
}

/**
 * Whether this key draws its name as well as its picture.
 *
 * A picture on a key answers "what is this?" better than the word does — a
 * photograph of a burger is a better burger key than BURGER over a sliver of
 * one — so a key with a picture is a picture, and the name is off unless the
 * venue asks for it. A key with no picture always says its name; there would be
 * nothing on it otherwise.
 */
function spDrawsLabel(b) {
  const face = spFaceFor(b);
  if (!face || !face.image) return true;
  return !!b.showLabel;
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
 * Clear a key back to an empty cell — its span with it.
 *
 * The span matters now that a spanning blank is a thing that survives. Without
 * this, Clear on a 2x2 would leave a 2x2 *reservation* behind: the key gone,
 * the ground still held, and the four cells under it unreachable with no key
 * drawn to explain why. Clear has always meant "this cell is empty again", and
 * it still does. A space that is meant to stay set aside is made by dragging
 * the corner handle, which is a deliberate gesture; Backspace is not.
 */
function spClearButton(button) {
  spSetKind(button, 'blank');
  button.rowSpan = 1;
  button.colSpan = 1;
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
        b.imageFit ?? '',
        b.imageScale ?? '',
        b.imageX ?? '',
        b.imageY ?? '',
        b.showLabel ? '1' : '',
        // Every field a key carries has to be in here, and forgetting one is
        // quiet in a way that is worth spelling out: this string is what
        // `spDirty()` compares and what `spEdit()` uses to decide whether
        // anything happened. A field left out means changing it is not a change
        // — no undo step, no unsaved-work warning, and the edit thrown away
        // without a word by the next screen switch. Adding a property to a
        // button? Add it here in the same breath.
        b.fontFamily ?? '',
        b.fontSize ?? '',
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
/**
 * Whether a blank is holding ground rather than being nothing.
 *
 * A key that spans more than one cell is a *reservation*: the manager has said
 * "this space is one key, two wide and two tall", and means to say what it does
 * afterwards. That is how a screen actually gets laid out — the shapes first,
 * because the shapes are what the venue is arranging, and the products second.
 * So a spanning blank is stored, and a 1x1 blank is not: a single empty cell is
 * already what an empty cell means, and storing millions of them would double
 * the size of every screen to say nothing.
 *
 * The same test is applied by the server, in src/screens.js. If it changes
 * here, it changes there in the same breath — the two disagreeing means a
 * manager sizes a space, saves, and watches it come back 1x1.
 */
function spHoldsSpace(b) {
  return (Number(b.rowSpan) || 1) > 1 || (Number(b.colSpan) || 1) > 1;
}

function spTidy() {
  const grid = spCurrent;

  // A blank is kept only while it holds ground — see spHoldsSpace. Anything off
  // the grid is gone rather than clamped, because clamping moves a button on
  // top of another one and calls that a save.
  let buttons = grid.buttons.filter(
    (b) =>
      b &&
      (b.kind !== 'blank' || spHoldsSpace(b)) &&
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

  // Again, after the clamp. A reserved space three rows tall on a grid the
  // manager has just cut to two rows is clamped back to 1x1 by the loop above,
  // and a 1x1 blank is nothing — it must not survive as a stored row that draws
  // no key and blocks the cell it sits on.
  buttons = buttons.filter((b) => b.kind !== 'blank' || spHoldsSpace(b));

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
  spRenderFontsCard();
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

  // The till's own fixed key, drawn beside a top bar so the manager lays out
  // against the width it actually takes. Top bars only: it is the way between
  // sections and it lives at the left of the one strip that is on every screen.
  //
  // It takes width from the bar rather than one of its columns, so a bar laid
  // out before this existed still has every key it had — drawn a little
  // narrower. Nothing here changes the grid's own geometry; see the note on
  // `.sp-bar-row` in the stylesheet for how that is kept true.
  $('sp-fixed-nav').hidden = surface !== 'topbar';
  $('sp-stage').classList.toggle('with-nav', surface === 'topbar');

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
      } else if (b && b.ink) {
        // Lettering colour on a key that kept the till's own background. Was
        // simply not drawn before this, because ink was only ever read
        // alongside a fill — so a manager who set light lettering on a default
        // key saw no change here and a changed key on the till.
        cell.style.color = b.ink;
      }
      // Its font, or the venue's, or nothing — and `pt` rather than a size,
      // because a point is measured against the grid's height and the grid has
      // not been laid out yet. See spApplyTypeScale.
      if (b) {
        const font = spFontCss(b.fontFamily || spTillFont);
        if (font) cell.style.fontFamily = font;
        if (b.fontSize) cell.dataset.pt = String(b.fontSize);
      }
      if (b) {
        // A reservation is not a programmed key and must not be drawn as one:
        // it is a space the manager has set aside and not yet said anything
        // about. Drawn as an empty cell that happens to be bigger, with a
        // dashed edge, so "I have not finished this one" stays readable across
        // a screen that is half laid out.
        cell.classList.add(b.kind === 'blank' ? 'reserved' : 'filled');
        if (spMissing(b)) cell.classList.add('missing');
        cell.title = spCellTitle(b);
      }

      // The key's face, exactly as the till draws it — because this grid is the
      // only place a manager can see whether the framing they set actually
      // works on a key of this shape, and a preview that stacks things
      // differently from the till is a preview that lies.
      //
      // A picture *fills* the key and the name is not drawn over it unless the
      // venue asked for that; an emoji sits above the words as it always has.
      // A face the key has borrowed from its product is drawn faded, so "this
      // key has a picture" and "this key was given one" stay apart — otherwise
      // clearing a key's own emoji looks like it did nothing.
      const face = b && spFaceFor(b);
      if (face && face.image) {
        const art = document.createElement('span');
        art.className = 'sp-face-fill' + (face.own ? '' : ' inherited');
        const img = document.createElement('img');
        img.src = face.image;
        img.alt = '';
        // Never a broken-image frame on a key. A picture that will not load
        // leaves the key looking like one that never had a picture, which is
        // what the till does with a dead URL.
        img.addEventListener('error', () => art.remove());
        const style = spFrameStyle(spFrameOf(b));
        img.style.objectFit = style.objectFit;
        img.style.transform = style.transform;
        art.append(img);
        cell.append(art);
      } else if (face) {
        const art = document.createElement('span');
        art.className = 'sp-face-art' + (face.own ? '' : ' inherited');
        art.textContent = face.emoji;
        cell.append(art);
      }

      const text = document.createElement('span');
      // A reservation says its size rather than nothing. A 2x3 hole in a grid
      // is otherwise indistinguishable from a 2x3 gap the manager left on
      // purpose, and the difference is the whole point of the thing.
      if (b && b.kind === 'blank') {
        text.className = 'sp-reserved-size';
        text.textContent = `${b.rowSpan || 1} × ${b.colSpan || 1}`;
      } else if (b && !spDrawsLabel(b)) {
        // Picture only. The span is still appended, empty, so the cell keeps
        // the same flex layout whether the name is drawn or not.
        text.textContent = '';
      } else {
        text.textContent = b ? spLabelFor(b) : '';
        // Lettering over a photograph needs something behind it, or it is
        // unreadable on whatever the picture happens to be light on.
        if (b && face && face.image) text.className = 'sp-over-art';
      }
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
  spApplyTypeScale();
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
  if (b.kind === 'blank') {
    return `A ${b.rowSpan || 1} × ${b.colSpan || 1} space set aside — ` +
      'double-click to say what it does';
  }
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
  spPaintHandle();
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
  // Only when there is somewhere to go. A page key pointing at a deleted
  // screen already says so on the grid; offering to open it would be a button
  // that does nothing.
  $('sp-open-target').disabled = !(
    kind === 'page' &&
    first.targetScreenId != null &&
    spScreens.some((s) => s.id === first.targetScreenId)
  );

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
  // A span is a single-cell idea. Applied to a multi-selection, buttons grow
  // over each other.
  //
  // Live on an empty cell as well as a programmed one — the same reservation
  // the corner handle makes. Sizing the space and saying what it does are two
  // steps and they happen in that order.
  $('sp-rowspan').disabled = count !== 1;
  $('sp-colspan').disabled = count !== 1;

  // Styling and labelling a cell that does nothing is styling something that is
  // never stored — the server drops blanks, and so does this editor. Saying so
  // beats letting a manager colour six empty cells and wonder where it went.
  //
  // A *reserved* blank is stored, but it is still a cell that does nothing, and
  // a coloured key a clerk cannot press is worse than an obviously unfinished
  // one. Colour it once it has a product.
  const styleable = chosen.some((b) => b.kind !== 'blank');
  $('sp-label').disabled = !styleable;
  $('sp-clear-style').disabled = !styleable;
  $('sp-ink').disabled = !styleable;
  $('sp-font').disabled = !styleable;
  $('sp-font-size').disabled = !styleable;
  $('sp-fill-wheel').disabled = !styleable;
  $('sp-fill-hex').disabled = !styleable;
  $('sp-ink-wheel').disabled = !styleable;
  $('sp-ink-hex').disabled = !styleable;
  $('sp-style-note').hidden = styleable;

  // Three named answers and a wheel, and which one is showing is worked out
  // from the ink itself rather than from a fourth stored field. Anything that
  // is not one of the two presets is a colour the manager picked, so the wheel
  // is what should be open — otherwise typing a brand colour into the box
  // snapped the dropdown back to "Dark" and the row closed under the cursor.
  const inkMode = !first.ink
    ? 'auto'
    : first.ink === SP_INK_LIGHT
      ? 'light'
      : first.ink === SP_INK_DARK
        ? 'dark'
        : 'custom';
  spSet($('sp-ink'), inkMode);
  $('sp-ink-wheel-row').hidden = inkMode !== 'custom';
  if (inkMode === 'custom') {
    spSet($('sp-ink-wheel'), first.ink);
    spSet($('sp-ink-hex'), first.ink);
  }

  $('sp-fills').innerHTML = SP_FILLS.map(
    (fill) =>
      `<button type="button" class="sp-swatch${
        first.fill === fill ? ' on' : ''
      }" style="background:${fill}" data-fill="${fill}" title="${fill}"></button>`
  ).join('');

  // The wheel shows the key's colour when it has one, and the till's default
  // key colour when it does not — so opening the wheel starts from what is on
  // the screen rather than from black.
  spSet($('sp-fill-wheel'), first.fill || SP_DEFAULT_FILL);
  spSet($('sp-fill-hex'), first.fill || '');

  // "The till's font" rather than a blank first option: blank reads as "no
  // font", and a key with no font is not unlettered, it is lettered in the
  // venue's.
  const tillFontName =
    spFonts.find((f) => f.slug === spTillFont)?.family || 'the app’s own';
  $('sp-font').innerHTML = spFontOptions(
    first.fontFamily || null,
    `Your tills’ font (${tillFontName})`
  );
  spSet($('sp-font-size'), first.fontSize == null ? '' : String(first.fontSize));

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

  spRenderFrame(first, styleable);

  $('sp-face-note').textContent = !styleable
    ? ''
    : face && !face.own
      ? 'Showing this product’s own picture. Set one here to override it just on this key.'
      : '';
}

/**
 * The framing stage: this picture, on this key, at this key's real shape.
 *
 * Drawn at the proportions of the actual cell rather than in a fixed square,
 * and that is the whole idea. "Does this picture work here" is a question only
 * the real shape answers, and a venue that arranges 2x2 keys and 1x3 strips
 * gets a different answer for each of them from the same photograph. The
 * measurement comes off the grid itself, so it is right whatever the screen's
 * rows and columns are.
 *
 * Nothing here uploads or crops anything. Four numbers say how to *look* at the
 * file, so the same picture can be framed one way on the FOOD key and another
 * way on the burger it leads to, without a second copy of it and without the
 * product catalogue changing under either.
 */
function spRenderFrame(first, styleable) {
  const wrap = $('sp-frame');
  const face = first && spFaceFor(first);
  const show = !!(styleable && face && face.image);
  wrap.hidden = !show;
  if (!show) return;

  const frame = spFrameOf(first);
  const img = $('sp-frame-img');
  if (img.getAttribute('src') !== face.image) img.src = face.image;
  const style = spFrameStyle(frame);
  img.style.objectFit = style.objectFit;
  img.style.transform = style.transform;

  // The key's own proportions, measured off the grid. Falls back to 4:3 only
  // when the cell is not on screen — a bar being edited while the panel is
  // scrolled, say — because a stage with no aspect ratio collapses to nothing.
  const cell = spCells.get(spKey(first.row, first.col));
  const box = cell && cell.getBoundingClientRect();
  const ratio = box && box.height > 0 ? box.width / box.height : 4 / 3;
  $('sp-frame-stage').style.aspectRatio = String(ratio);

  spSet($('sp-frame-zoom'), String(frame.scale));
  $('sp-frame-zoom-out').textContent = `${frame.scale}%`;
  $('sp-frame-fill').classList.toggle('on', frame.fit === 'cover');
  $('sp-frame-whole').classList.toggle('on', frame.fit === 'contain');
  $('sp-show-label').checked = !!first.showLabel;
}

/**
 * One gesture, one undo step.
 *
 * Panning and zooming are continuous: a drag across the stage is a hundred
 * pointer events and a scroll is twenty, and putting each of them through
 * spEdit would bury the undo stack — the same fault the colour wheel had before
 * it was moved off `input`, and the reason the corner handle takes its snapshot
 * once at the start of the drag. So the buttons are mutated directly while the
 * gesture runs and the step is pushed when it settles.
 *
 * The wheel has no "up" event to settle on, so it settles on a pause. Long
 * enough that a burst of scrolling is one step, short enough that a manager who
 * zooms and then reaches for Ctrl+Z gets what they expect.
 */
let spFrameGesture = null;
let spFrameSettle = null;
const SP_FRAME_SETTLE_MS = 450;

function spFrameChange(mutate) {
  if (!spCurrent) return;
  const targets = spSelectedButtons().filter((b) => {
    const face = spFaceFor(b);
    return face && face.image;
  });
  if (!targets.length) return;

  if (!spFrameGesture) spFrameGesture = spSnapshot();
  for (const b of targets) mutate(b, spFrameOf(b));

  // Redrawn rather than re-rendered: the grid is rebuilt on every settle, not
  // on every pixel. See the pointer model at the top of this file.
  spPaintFrameLive(targets);
  spRenderFrame(targets[0], true);

  clearTimeout(spFrameSettle);
  spFrameSettle = setTimeout(spFrameSettleNow, SP_FRAME_SETTLE_MS);
}

/** Push the gesture's one undo step, if it changed anything. */
function spFrameSettleNow() {
  clearTimeout(spFrameSettle);
  spFrameSettle = null;
  const before = spFrameGesture;
  spFrameGesture = null;
  if (!before || !spCurrent) return;

  if (spShape(spCurrent) === spShape(before)) {
    spRenderStatus();
    return;
  }
  spUndoStack.push(before);
  if (spUndoStack.length > SP_UNDO_LIMIT) spUndoStack.shift();
  spRedoStack = [];
  spAfterChange();
}

/** Move the pictures already on the grid, without rebuilding it. */
function spPaintFrameLive(buttons) {
  for (const b of buttons) {
    const cell = spCells.get(spKey(b.row, b.col));
    const img = cell && cell.querySelector('.sp-face-fill img');
    if (!img) continue;
    const style = spFrameStyle(spFrameOf(b));
    img.style.objectFit = style.objectFit;
    img.style.transform = style.transform;
  }
}

/** Drag to pan, scroll to zoom, on the stage. */
function spBindFrameStage() {
  const stage = $('sp-frame-stage');
  let drag = null;

  stage.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    const box = stage.getBoundingClientRect();
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, w: box.width, h: box.height };
    try {
      stage.setPointerCapture(e.pointerId);
    } catch {
      // Uncapturable pointers still pan; they just stop at the edge of the
      // stage, exactly as the grid's drag does.
    }
    stage.classList.add('dragging');
  });

  stage.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    // Pixels moved, as a percentage of the key — which is the unit the offsets
    // are stored in, so the picture travels exactly as far as the pointer does.
    const dx = ((e.clientX - drag.x) / drag.w) * 100;
    const dy = ((e.clientY - drag.y) / drag.h) * 100;
    drag.x = e.clientX;
    drag.y = e.clientY;
    spFrameChange((b, frame) => {
      b.imageX = Math.min(100, Math.max(-100, Math.round(frame.x + dx)));
      b.imageY = Math.min(100, Math.max(-100, Math.round(frame.y + dy)));
    });
  });

  const end = (e) => {
    if (!drag || (e && e.pointerId !== drag.id)) return;
    try {
      stage.releasePointerCapture(drag.id);
    } catch {
      // Already released.
    }
    drag = null;
    stage.classList.remove('dragging');
    spFrameSettleNow();
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);

  // Zoom about the centre. `passive: false` because the page must not scroll
  // underneath the gesture — a manager zooming a picture and watching the
  // inspector scroll away is the control failing.
  stage.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const step = e.deltaY < 0 ? 1.08 : 1 / 1.08;
      spFrameChange((b, frame) => {
        b.imageScale = Math.min(400, Math.max(20, Math.round(frame.scale * step)));
      });
    },
    { passive: false }
  );
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

  // The corner handle, checked before anything works out which cell is under
  // the pointer — the handle sits on the *edge* of its key, and the cell the
  // geometry answers for a press on it is as often the next one along.
  if (e.target.closest && e.target.closest('.sp-handle')) {
    // One undo step for the whole gesture. The spans are mutated directly as
    // the pointer moves — going through spEdit would push a step per cell
    // crossed — so the state to go back to is taken once, here, and pushed once
    // at the end if anything actually changed.
    //
    // Taken *before* spResizeTarget, which on an empty cell creates the blank
    // it is about to size: an undo has to put back the grid as it was, not the
    // grid with a reservation already on it.
    const before = spSnapshot();
    const button = spResizeTarget();
    if (button) {
      try {
        grid.setPointerCapture(e.pointerId);
      } catch {
        // As below: uncapturable pointers still resize, they just stop at the
        // edge of the grid.
      }
      spDrag = {
        pointerId: e.pointerId,
        g,
        mode: 'resize',
        button,
        before,
      };
      grid.classList.add('resizing');
      return;
    }
  }

  const under = spCellFromPoint(g, e.clientX, e.clientY);
  const anchor = spOrigin(under.row, under.col);
  const key = spKey(anchor.row, anchor.col);
  const toggle = e.ctrlKey || e.metaKey;

  // Is this the second press on the same key?
  //
  // Counted here rather than listened for as `dblclick`, because the
  // preventDefault above suppresses the entire compatibility mouse sequence —
  // see the note where that listener used to be. Counting the pointer stream
  // also means this works with a pen and a finger, which is what a manager
  // laying out a screen on a Windows tablet is using.
  //
  // NOTED HERE AND ACTED ON AT THE RELEASE, which is the part that took a
  // failing test to find. Moving a key is "click it, then drag it" — two
  // presses on the same key, and the second one is the drag. Opening the search
  // on that second press made every move gesture in the editor open a search
  // box instead, because the two presses are naturally well inside any
  // double-click window. So the search opens only if the second press turns out
  // not to have been a drag; see spDragEnd.
  const doublePressed =
    !toggle &&
    !e.shiftKey &&
    spLastPress != null &&
    spLastPress.key === key &&
    e.timeStamp - spLastPress.at < SP_DOUBLE_MS;
  spLastPress = { key, at: e.timeStamp };

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
    doublePressed,
    key,
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

  if (spDrag.mode === 'resize') {
    const b = spDrag.button;
    const to = spCellFromPoint(spDrag.g, e.clientX, e.clientY);
    const want = spSpanRoom(b, to.row - b.row + 1, to.col - b.col + 1);
    // Only when it actually changes. The grid is rebuilt to reflow the key,
    // and rebuilding it on every pixel is what the pointer model at the top of
    // this file exists to avoid.
    if (want.rowSpan === (b.rowSpan || 1) && want.colSpan === (b.colSpan || 1)) {
      return;
    }
    b.rowSpan = want.rowSpan;
    b.colSpan = want.colSpan;
    // The key keeps the selection as it grows, so the handle stays under the
    // finger and the inspector keeps showing the key being resized.
    spSelection = new Set([spKey(b.row, b.col)]);
    spFocusCell = { row: b.row, col: b.col };
    spRenderGrid();
    spRenderStatus();
    return;
  }

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
  $('sp-grid').classList.remove('resizing');
  spClearDrop();

  if (drag.mode === 'resize') {
    spTidy();
    if (spShape(spCurrent) === spShape(drag.before)) {
      // Picked the handle up and put it down again. No undo step, for the same
      // reason spEdit refuses one: a no-op that costs a Ctrl+Z is how undo
      // stops being trustworthy.
      spRenderGrid();
    } else {
      spUndoStack.push(drag.before);
      if (spUndoStack.length > SP_UNDO_LIMIT) spUndoStack.shift();
      spRedoStack = [];
      spAfterChange();
    }
    spRenderInspector();
    spRenderStatus();
    return;
  }

  if (drag.mode === 'move' && drag.target) {
    const copy = drag.copy || (e && e.altKey);
    spMoveSelection(
      drag.target.row - drag.anchor.row,
      drag.target.col - drag.anchor.col,
      { copy }
    );
  }

  // The second press on a key, released without having moved: open the search.
  //
  // `mode !== 'move'` is the whole of the distinction — a second press that
  // travelled is somebody moving the key, and interrupting that with a dialog
  // is how this feature broke every move in the editor the first time it was
  // written. See spDragStart.
  //
  // Narrowed to the one key rather than left on whatever was selected: a
  // double-press is a manager pointing at a button and asking what it should
  // be, and answering for six of them is not what was asked.
  if (drag.doublePressed && drag.mode !== 'move') {
    const [row, col] = drag.key.split(':').map(Number);
    spSelection = new Set([drag.key]);
    spFocusCell = { row, col };
    spAnchorCell = { row, col };
    // The next press starts a fresh count. Without this, a third press on the
    // same key — closing the search and pressing again — reopens it.
    spLastPress = null;
    spPaintSelection();
    spRenderInspector();
    spRenderStatus();
    spOpenPalette();
    return;
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
    return void spApplyToSelection(spClearButton, { create: false });
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

  // Changing page.
  //
  // The `<select>` has already moved by the time this runs and the guard is now
  // asynchronous, so the box is put back to the screen actually open *first* —
  // otherwise the picker sits there naming a page the grid is not showing for as
  // long as the question is on screen, which is its own version of the bug this
  // is fixing.
  $('sp-screen').addEventListener('change', async (e) => {
    const wanted = Number(e.target.value);
    if (!wanted || (spCurrent && wanted === spCurrent.id)) return;
    if (spCurrent) e.target.value = String(spCurrent.id);

    if (!(await spGuardUnsaved())) {
      spRenderChrome();
      return;
    }
    spSelect(wanted);
    spRenderChrome();
  });

  // ---- Which kind of layout ----
  for (const tab of document.querySelectorAll('.sp-surface')) {
    tab.addEventListener('click', async () => {
      if (tab.dataset.surface === spSurface) return;
      if (!(await spGuardUnsaved())) return;
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
  // A point is measured against the grid's height, so the grid changing size —
  // a window resized, the pop-out opening, a row added — has to redraw the
  // sized labels. See spApplyTypeScale.
  spWatchTypeScale();
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
  // Double-click to search is handled in spDragStart, not here.
  //
  // There used to be a `dblclick` listener on this element and it never fired
  // once. spDragStart calls preventDefault() on pointerdown — it has to, or the
  // browser starts a text selection the moment the pointer moves across the
  // grid — and a prevented pointerdown suppresses the whole compatibility mouse
  // sequence that follows it: mousedown, mouseup, click and dblclick. So the
  // feature was written, shipped, and was unreachable with a mouse, a pen or a
  // finger.
  //
  // Counting the presses in the pointer stream is the only thing that works
  // here, and it works the same for all three.

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
    // Only cells that already do something change here. On empty cells — and on
    // reserved spaces, which are empty cells that happen to be bigger — this
    // reveals the picker and nothing else: the key is made when a product, a
    // screen or a function is actually chosen, so a change of mind leaves the
    // grid as it was rather than strewn with keys that point at nothing. The
    // reservation's size is kept, because spApplyToSelection edits the blank
    // that is already there rather than making a new one.
    if (spSelectedButtons().some((b) => b.kind !== 'blank')) {
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
  // Light, dark, or a colour of the venue's own. The till works one out from
  // the fill and gets it right nearly always; the two named answers are for the
  // nearly, and neither of them can produce a key that cannot be read.
  $('sp-ink').addEventListener('change', (e) => {
    const mode = e.target.value;
    $('sp-ink-wheel-row').hidden = mode !== 'custom';
    if (mode === 'custom') {
      // Nothing is applied yet. Choosing "a colour of my own" and having the
      // key immediately turn some arbitrary colour would be the editor
      // answering a question the manager has not finished asking — so the row
      // opens seeded with what the key letters in now, and the wheel commits.
      const first = spSelectedButtons()[0];
      const seed = (first && first.ink) || SP_INK_LIGHT;
      spSet($('sp-ink-wheel'), seed);
      spSet($('sp-ink-hex'), seed);
      $('sp-ink-wheel').focus();
      return;
    }
    const ink = mode === 'light' ? SP_INK_LIGHT : mode === 'dark' ? SP_INK_DARK : null;
    spApplyToSelection(
      (b) => {
        b.ink = ink;
      },
      { create: false }
    );
  });

  // The wheels.
  //
  // `change`, not `input`. A colour input fires `input` for every pixel the
  // pointer crosses inside the picker, and routing that through spApplyToSelection
  // would put two hundred steps on the undo stack for one colour — which is the
  // same fault the label box had before it was moved to `change`, and the reason
  // undo stopped being trustworthy.
  spBindColour('sp-fill-wheel', 'sp-fill-hex', 'fill');
  spBindColour('sp-ink-wheel', 'sp-ink-hex', 'ink');

  // ---- Lettering ----
  $('sp-font').addEventListener('change', (e) => {
    const slug = e.target.value || null;
    spApplyToSelection(
      (b) => {
        b.fontFamily = slug;
      },
      { create: false }
    );
  });
  $('sp-font-size').addEventListener('change', (e) => {
    const raw = e.target.value.trim();
    // Empty is not zero. Empty means "the till decides", which is what most
    // keys should say and what every key said before this box existed.
    const size = raw === '' ? null : Math.min(72, Math.max(8, Number(raw) || 0));
    spSet(e.target, size == null ? '' : String(size));
    spApplyToSelection(
      (b) => {
        b.fontSize = size;
      },
      { create: false }
    );
  });

  $('sp-till-font').addEventListener('change', (e) => spSetTillFont(e.target.value));
  $('sp-font-add').addEventListener('click', () => $('sp-font-file').click());
  $('sp-font-file').addEventListener('change', spAddFont);
  $('sp-font-list').addEventListener('click', (e) => {
    const button = e.target.closest('[data-font-remove]');
    if (button) spRemoveFont(button.dataset.fontRemove);
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
    spApplyToSelection(spClearButton, { create: false })
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

  // ---- Framing the picture ----
  spBindFrameStage();

  // `input`, not `change`, so the picture moves under the slider as it is
  // dragged — a zoom control that only answers when you let go is one nobody
  // can aim. The undo step is still one per gesture; see spFrameChange.
  $('sp-frame-zoom').addEventListener('input', (e) => {
    const scale = Math.min(400, Math.max(20, Number(e.target.value) || 100));
    spFrameChange((b) => {
      b.imageScale = scale;
    });
  });

  // The two answers worth having as one press each. "Fill the key" is what a
  // photograph wants and what every key did before there was a choice; "Whole
  // picture" is what a logo or a tall bottle shot on a wide key wants, and it
  // is the one that was impossible.
  $('sp-frame-fill').addEventListener('click', () =>
    spFrameChange((b) => {
      b.imageFit = 'cover';
    })
  );
  $('sp-frame-whole').addEventListener('click', () =>
    spFrameChange((b) => {
      b.imageFit = 'contain';
    })
  );
  $('sp-frame-reset').addEventListener('click', () =>
    spFrameChange((b) => {
      b.imageFit = null;
      b.imageScale = null;
      b.imageX = null;
      b.imageY = null;
    })
  );

  // Whether the name is lettered over the picture. Its own edit rather than a
  // framing gesture — it is one press with one outcome, and it belongs on the
  // undo stack as itself.
  $('sp-show-label').addEventListener('change', (e) => {
    const on = e.target.checked;
    spApplyToSelection(
      (b) => {
        b.showLabel = on;
      },
      { create: false }
    );
  });

  // Follow a category key to the page it opens.
  //
  // Guarded by spGuardUnsaved for the same reason every other screen change is:
  // the working copy is the manager's, and walking down a menu must not be the
  // thing that throws away twenty minutes of arranging.
  $('sp-open-target').addEventListener('click', async () => {
    const first = spSelectedButtons()[0];
    const target = first && spScreens.find((s) => s.id === first.targetScreenId);
    if (!target) return;
    if (!(await spGuardUnsaved())) return;
    spSurface = target.surface || 'sale';
    spSelect(target.id);
    spRenderChrome();
  });

  $('sp-copy').addEventListener('click', () => spCopySelection());
  $('sp-paste').addEventListener('click', () => spPasteClipboard());

  // The typed spans, clamped exactly as the corner handle is.
  //
  // They used to be applied raw, which meant spTidy() dropped whatever the key
  // now covered: typing 4 into Width where there was room for 2 deleted the key
  // next to it, with no warning and nothing on screen to say what had gone. The
  // handle refuses to swallow a neighbour and so, now, does this — and the box
  // snapping back to 2 is the editor saying why.
  for (const [id, key] of [['sp-rowspan', 'rowSpan'], ['sp-colspan', 'colSpan']]) {
    $(id).addEventListener('change', (e) => {
      const want = Math.max(1, Number(e.target.value) || 1);
      // The same reservation the corner handle makes, for the manager who
      // types the size rather than dragging it. Without this, Width and Height
      // were dead on exactly the cells the handle now works on.
      spEdit(() => {
        const button = spResizeTarget();
        if (!button) return false;
        const room = spSpanRoom(
          button,
          key === 'rowSpan' ? want : button.rowSpan || 1,
          key === 'colSpan' ? want : button.colSpan || 1
        );
        button[key] = room[key];
      });
      spRenderInspector();
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
/**
 * A question with named answers, drawn rather than asked of the browser.
 *
 * Resolves to the `value` of whichever key was pressed, or to `cancel` for Esc
 * and a press on the backdrop. Uses the same `#modal-root` and the same classes
 * as `modal()` in app.js, so it inherits the back office's styling and its
 * stacking rather than inventing either.
 */
function spAsk(title, message, choices) {
  return new Promise((resolve) => {
    const root = $('modal-root');
    root.innerHTML = `
      <div class="modal-back">
        <div class="modal" role="dialog" aria-modal="true" aria-label="${spEsc(title)}">
          <h3>${spEsc(title)}</h3>
          <p class="muted small" style="margin:0 0 16px">${spEsc(message)}</p>
          <div class="modal-actions">
            ${choices
              .map(
                (c) =>
                  `<button type="button" class="btn ${c.style || 'ghost'}"
                           data-choice="${spEsc(c.value)}">${spEsc(c.label)}</button>`
              )
              .join('')}
          </div>
        </div>
      </div>`;

    // Both listeners are taken off again in `done`, and that is not tidiness:
    // `#modal-root` outlives the dialog, so a listener left on it would still be
    // there for the *next* question — and its first act is to empty the root,
    // which would close a dialog it has nothing to do with.
    const done = (value) => {
      document.removeEventListener('keydown', onKey, true);
      root.removeEventListener('click', onClick);
      root.innerHTML = '';
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      done('cancel');
    };
    const onClick = (e) => {
      const key = e.target.closest('[data-choice]');
      if (key) return done(key.dataset.choice);
      if (e.target.classList.contains('modal-back')) done('cancel');
    };

    root.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey, true);
    root.querySelector('[data-choice]')?.focus();
  });
}

/**
 * Ask before unsaved work is left behind. Resolves true to go ahead.
 *
 * A drawn modal, not `confirm()`, and that is the whole of a reported bug:
 * Chrome offers "prevent this page from creating additional dialogs" on the
 * second native dialog in a row, and once it is ticked every `confirm()` on the
 * page returns **false** without drawing anything. This guard reads that as
 * "stay put", the picker is re-rendered back to the screen already open, and
 * the editor silently refuses to change page — which is exactly what "swapping
 * to another page doesn't change to the page, it just shows the page I am
 * currently on" is. The same trap the kitchen editors and spNewScreen were
 * already rewritten out of; this was the last native dialog on the path a
 * manager walks every few minutes.
 *
 * Three answers rather than two, because two was never the real question. A
 * manager who has arranged twenty minutes of keys and reaches for the next page
 * does not want "leave them behind?" — they want the work kept. Saving is the
 * default and the primary key; discarding is available and named as the loss it
 * is; staying is what Esc and the backdrop do.
 */
async function spGuardUnsaved() {
  if (!spDirty()) return true;

  const answer = await spAsk(
    'Save this screen first?',
    `"${spCurrent.name}" has changes that have not been saved.`,
    [
      { value: 'stay', label: 'Stay here', style: 'ghost' },
      { value: 'discard', label: 'Discard changes', style: 'danger-ghost' },
      { value: 'save', label: 'Save and carry on', style: 'primary' },
    ]
  );

  if (answer === 'save') {
    await spSaveLayout({ quiet: true });
    // A save that failed left the work in hand and said so through its own
    // alert. Going on regardless would throw away the very thing the manager
    // just asked to keep.
    return !spDirty();
  }
  return answer === 'discard';
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
async function spNewScreen() {
  if (!(await spGuardUnsaved())) return;
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
