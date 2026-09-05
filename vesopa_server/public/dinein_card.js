/**
 * The table card designer.
 *
 * WHAT THIS REPLACED
 *
 * Four number boxes per element — Left %, Top %, Width %, Height % — and a
 * preview beside them. That is not an editor, it is a coordinate form: you type
 * 22, look up, type 24, look up again. Nobody lays out a printed card that way,
 * and the venue said so.
 *
 * So: a canvas you drag on. Click a thing to select it, drag it to move it,
 * pull a corner to resize it, and the panel on the right edits whatever is
 * selected. Layers reorder with two buttons. Themes are a starting point rather
 * than a blank page, and the picture library means a venue with no designer can
 * still print something that does not look homemade.
 *
 * WHY IT IS STILL PERCENTAGES UNDERNEATH
 *
 * Because one design has to print on an A4 sheet and on a 60mm sticker, and a
 * position in millimetres cannot do both. The canvas works in screen pixels for
 * the duration of a drag and converts on drop, so the stored document is the
 * same JSON it always was — which is what keeps the print path, and every card
 * already saved, working unchanged.
 *
 * WHAT IS DELIBERATELY NOT HERE
 *
 * A z-index field, a rotation handle, and grouping. Each is a real feature of a
 * real design tool and each is a thing a publican does not want to learn to
 * print a QR code. Order is "bring forward / send back", which is the same
 * capability without the concept.
 */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Index of the selected element, or -1. */
let dcSelected = -1;

/** Set while a drag is in flight, so the preview does not fight the pointer. */
let dcDragging = null;

/** Undo, shallow and short. Enough for "I did not mean that". */
const dcHistory = [];

const DC_MAX_HISTORY = 40;

function dcPushHistory() {
  if (!diDesign) return;
  dcHistory.push(JSON.stringify(diDesign.elements));
  if (dcHistory.length > DC_MAX_HISTORY) dcHistory.shift();
}

function dcUndo() {
  const previous = dcHistory.pop();
  if (!previous) return;
  diDesign.elements = JSON.parse(previous);
  dcSelected = Math.min(dcSelected, diDesign.elements.length - 1);
  dcRender();
}

// ---------------------------------------------------------------------------
// What a venue can put on a card
// ---------------------------------------------------------------------------

const DC_KINDS = {
  qr: { label: 'The code', icon: '▦', fixedRatio: true },
  venue_name: { label: 'Venue name', icon: 'A' },
  table_name: { label: 'Table name', icon: 'A' },
  text: { label: 'Text', icon: 'A' },
  link: { label: 'Web address', icon: 'A' },
  image: { label: 'Picture', icon: '▣' },
  box: { label: 'Panel', icon: '▬' },
};

/** The fonts offered. Web-safe only — this is going to a printer, and a font
    that resolves on one machine and not another prints two different cards. */
const DC_FONTS = [
  ['system-ui, -apple-system, "Segoe UI", Roboto, sans-serif', 'System'],
  ['Georgia, "Times New Roman", serif', 'Serif'],
  ['"Segoe UI", Tahoma, sans-serif', 'Sans'],
  ['"Courier New", ui-monospace, monospace', 'Typewriter'],
  ['Impact, "Arial Black", sans-serif', 'Poster'],
];

/**
 * Starting points, so a new card is never an empty page.
 *
 * Each is a complete card that would print acceptably as it stands. A venue
 * that changes nothing still gets something that looks deliberate, which is the
 * whole point of shipping themes rather than a blank canvas and good luck.
 */
const DC_THEMES = {
  clean: {
    label: 'Clean',
    background: '#FFFFFF',
    elements: () => [
      { kind: 'venue_name', x: 8, y: 7, w: 84, h: 9, size: 26, align: 'center', bold: true, colour: '#14161A' },
      { kind: 'qr', x: 25, y: 21, w: 50, h: 36 },
      { kind: 'table_name', x: 8, y: 61, w: 84, h: 8, size: 22, align: 'center', bold: true, colour: '#14161A' },
      { kind: 'text', x: 8, y: 71, w: 84, h: 6, size: 13, align: 'center', text: 'Scan to see the menu and order', colour: '#63696F' },
      { kind: 'link', x: 8, y: 89, w: 84, h: 5, size: 10, align: 'center', colour: '#9AA0A6' },
    ],
  },
  banner: {
    label: 'Banner',
    background: '#FFFFFF',
    elements: () => [
      { kind: 'box', x: 0, y: 0, w: 100, h: 18, fill: '#A5C715' },
      { kind: 'venue_name', x: 6, y: 4, w: 88, h: 10, size: 26, align: 'center', bold: true, colour: '#10130A' },
      { kind: 'qr', x: 26, y: 25, w: 48, h: 34 },
      { kind: 'table_name', x: 6, y: 63, w: 88, h: 8, size: 24, align: 'center', bold: true, colour: '#14161A' },
      { kind: 'text', x: 6, y: 73, w: 88, h: 6, size: 13, align: 'center', text: 'Order from your phone — no app needed', colour: '#63696F' },
      { kind: 'box', x: 0, y: 94, w: 100, h: 6, fill: '#A5C715' },
    ],
  },
  dark: {
    label: 'Dark',
    background: '#14161A',
    elements: () => [
      { kind: 'venue_name', x: 8, y: 8, w: 84, h: 9, size: 26, align: 'center', bold: true, colour: '#FFFFFF' },
      { kind: 'box', x: 24, y: 21, w: 52, h: 38, fill: '#FFFFFF' },
      { kind: 'qr', x: 26, y: 23, w: 48, h: 34 },
      { kind: 'table_name', x: 8, y: 63, w: 84, h: 8, size: 22, align: 'center', bold: true, colour: '#A5C715' },
      { kind: 'text', x: 8, y: 73, w: 84, h: 6, size: 13, align: 'center', text: 'Scan to see the menu and order', colour: '#9AA0A6' },
    ],
  },
  minimal: {
    label: 'Just the code',
    background: '#FFFFFF',
    elements: () => [
      { kind: 'qr', x: 12, y: 12, w: 76, h: 60 },
      { kind: 'table_name', x: 8, y: 77, w: 84, h: 10, size: 26, align: 'center', bold: true, colour: '#14161A' },
    ],
  },
};

/**
 * Pictures a venue can drop on without owning any.
 *
 * Served from the back office's own assets, so they work offline in the panel
 * and cannot disappear when somebody else's CDN does.
 */
const DC_LIBRARY = [
  ['/assets/vesopa_logo.png', 'Vesopa mark'],
];

const DC_PAGES = {
  a4: [210, 297, 'A4 sheet'],
  a5: [148, 210, 'A5 card'],
  a6: [105, 148, 'A6 card'],
  sticker80: [80, 80, 'Square sticker 80mm'],
  sticker60: [60, 60, 'Square sticker 60mm'],
  tent: [100, 210, 'Table tent'],
};

// ---------------------------------------------------------------------------
// The editor
// ---------------------------------------------------------------------------

function dcPageSize() {
  if (!diDesign) return [148, 210];
  if (diDesign.page_size === 'custom') {
    return [diDesign.page_w_mm || 148, diDesign.page_h_mm || 210];
  }
  const page = DC_PAGES[diDesign.page_size];
  return page ? [page[0], page[1]] : [148, 210];
}

/** Draw the whole editor into its host element. */
function dcRender() {
  const host = $('di-card-editor');
  if (!host || !diDesign) return;

  const [w, h] = dcPageSize();

  // Fit the page into the space available, so an A4 and a 60mm sticker are both
  // workable without scrolling. This is a scale, not a size: everything inside
  // stays in percentages.
  //
  // The floor matters. `host.clientWidth` is 0 on the first paint after the
  // element is inserted, and `0 - 360` is a negative number that is also
  // truthy — so the fallback never fired, the scale went negative, and the card
  // rendered at no size at all. Which is to say: an empty panel where the
  // editor should be.
  const available = host.clientWidth > 0 ? host.clientWidth - 360 : 0;
  const boxW = Math.max(260, Math.min(460, available || 460));
  const scale = Math.max(0.2, Math.min(boxW / w, 560 / h));

  host.innerHTML = `
    <div class="dc-wrap">
      <div class="dc-tools">
        <div class="dc-toolgroup">
          ${Object.entries(DC_KINDS).map(([kind, meta]) =>
            `<button class="btn dc-add" data-add-kind="${kind}" type="button"
                     title="Add ${esc(meta.label)}">+ ${esc(meta.label)}</button>`
          ).join('')}
        </div>
        <div class="dc-toolgroup">
          <button class="btn" id="dc-undo" type="button" ${dcHistory.length ? '' : 'disabled'}>Undo</button>
          <button class="btn" id="dc-forward" type="button">Bring forward</button>
          <button class="btn" id="dc-back" type="button">Send back</button>
          <button class="btn danger" id="dc-delete" type="button">Delete</button>
        </div>
      </div>

      <div class="dc-body">
        <div class="dc-stage">
          <div class="dc-page" id="dc-page"
               style="width:${w * scale}px;height:${h * scale}px;
                      background:${esc(diDesign.background || '#FFFFFF')}">
            ${diDesign.elements.map((el, i) => dcElementHtml(el, i, scale)).join('')}
          </div>
          <p class="muted small" style="text-align:center;margin-top:8px">
            ${w} × ${h} mm — drag to move, pull a corner to resize
          </p>
        </div>

        <aside class="dc-panel" id="dc-panel"></aside>
      </div>
    </div>`;

  dcWireStage();
  dcWirePanel();
}

/**
 * One element, drawn at the canvas's scale.
 *
 * [scale] is pixels per millimetre on screen. It has to reach the type as well
 * as the boxes: a point is an absolute unit, so 26pt drew at full print size on
 * a card shrunk to fit the panel — the venue name overflowed its box in the
 * editor and fitted perfectly on the paper, which is the editor lying about the
 * one thing it exists to show. 3.7795 is pixels per millimetre at 96dpi, so
 * `scale / 3.7795` is how much smaller the editor is than the printed card.
 */
function dcElementHtml(el, i, scale) {
  const type = (el.size || 14) * (scale / 3.7795);
  const selected = i === dcSelected;
  const box =
    `left:${el.x}%;top:${el.y}%;width:${el.w}%;height:${el.h}%;`;

  let inner = '';
  switch (el.kind) {
    case 'qr':
      inner = `<div class="dc-qr">${diCodes[dcPreviewTable().public_id] || '▦'}</div>`;
      break;
    case 'image':
      inner = el.url
        ? `<img src="${esc(el.url)}" alt="" draggable="false">`
        : '<div class="dc-placeholder">Picture</div>';
      break;
    case 'box':
      inner = '';
      break;
    default:
      inner = `<div class="dc-text" style="
        font-size:${type.toFixed(2)}pt;
        text-align:${el.align || 'center'};
        font-weight:${el.bold ? 800 : 400};
        font-family:${esc(el.font || DC_FONTS[0][0])};
        color:${esc(el.colour || '#14161A')};
        justify-content:${el.align === 'left' ? 'flex-start' : el.align === 'right' ? 'flex-end' : 'center'}
      ">${esc(dcTextOf(el))}</div>`;
  }

  return `<div class="dc-el${selected ? ' is-selected' : ''}"
               data-el-index="${i}"
               style="${box}${el.kind === 'box' ? `background:${esc(el.fill || '#EEEEEE')};` : ''}">
            ${inner}
            ${selected ? '<span class="dc-handle" data-resize="1"></span>' : ''}
          </div>`;
}

/** What a text element says in the editor, with the placeholders filled in. */
function dcTextOf(el) {
  switch (el.kind) {
    case 'venue_name':
      return (diVenue && (diVenue.display_name || diVenue.fallback_name)) || 'Your venue';
    case 'table_name':
      return dcPreviewTable().display_name;
    case 'link':
      return ((diTables.base || '').replace(/^https?:\/\//, '') || 'menu.vesopaepos.com') +
             '/' + ((diVenue && diVenue.slug) || 'your-venue');
    default:
      return el.text || '';
  }
}

function dcPreviewTable() {
  return (
    diTables.tables.find((t) => t.public_id) || {
      public_id: '0'.repeat(32),
      display_name: 'Table 1',
    }
  );
}

// ---------------------------------------------------------------------------
// Dragging and resizing
// ---------------------------------------------------------------------------

function dcWireStage() {
  const page = $('dc-page');
  if (!page) return;

  page.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('[data-resize]');
    const node = e.target.closest('[data-el-index]');

    if (!node) {
      dcSelected = -1;
      dcRender();
      return;
    }

    const index = Number(node.dataset.elIndex);
    if (index !== dcSelected) {
      dcSelected = index;
      dcRender();
      return;
    }

    const el = diDesign.elements[index];
    const rect = page.getBoundingClientRect();
    dcPushHistory();

    dcDragging = {
      index,
      mode: handle ? 'resize' : 'move',
      startX: e.clientX,
      startY: e.clientY,
      origin: { x: el.x, y: el.y, w: el.w, h: el.h },
      rect,
    };
    page.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  page.addEventListener('pointermove', (e) => {
    if (!dcDragging) return;
    const { index, mode, startX, startY, origin, rect } = dcDragging;
    const el = diDesign.elements[index];

    // Pixels to percent of the page, which is the unit everything is stored in.
    const dx = ((e.clientX - startX) / rect.width) * 100;
    const dy = ((e.clientY - startY) / rect.height) * 100;

    if (mode === 'move') {
      // Clamped so an element cannot be dragged off the card and lost. It can
      // still be put half off the edge, which is a legitimate design.
      el.x = Math.max(-el.w + 5, Math.min(95, origin.x + dx));
      el.y = Math.max(-el.h + 5, Math.min(95, origin.y + dy));
    } else {
      el.w = Math.max(4, Math.min(100 - el.x, origin.w + dx));
      el.h = Math.max(3, Math.min(100 - el.y, origin.h + dy));
      // The code has to stay square or it will not scan.
      if (DC_KINDS[el.kind] && DC_KINDS[el.kind].fixedRatio) {
        const [pw, ph] = dcPageSize();
        el.h = (el.w * pw) / ph;
      }
    }

    const node = page.querySelector(`[data-el-index="${index}"]`);
    if (node) {
      node.style.left = el.x + '%';
      node.style.top = el.y + '%';
      node.style.width = el.w + '%';
      node.style.height = el.h + '%';
    }
    dcPaintPanelNumbers(el);
  });

  const endDrag = () => {
    if (!dcDragging) return;
    dcDragging = null;
    dcRender();
  };
  page.addEventListener('pointerup', endDrag);
  page.addEventListener('pointercancel', endDrag);

  document.querySelectorAll('[data-add-kind]').forEach((b) => {
    b.onclick = () => dcAdd(b.dataset.addKind);
  });
  $('dc-undo').onclick = dcUndo;
  $('dc-forward').onclick = () => dcReorder(1);
  $('dc-back').onclick = () => dcReorder(-1);
  $('dc-delete').onclick = dcDelete;
}

function dcAdd(kind) {
  dcPushHistory();
  const base = { kind, x: 20, y: 40, w: 60, h: 10 };
  const made = {
    qr: { ...base, x: 25, y: 25, w: 50, h: 36 },
    image: { ...base, url: '', h: 20 },
    box: { ...base, h: 12, fill: '#EFF6D8' },
    text: { ...base, size: 14, align: 'center', text: 'New text', colour: '#14161A' },
  }[kind] || { ...base, size: 18, align: 'center', bold: true, colour: '#14161A' };

  diDesign.elements.push(made);
  dcSelected = diDesign.elements.length - 1;
  dcRender();
}

function dcDelete() {
  if (dcSelected < 0) return;
  dcPushHistory();
  diDesign.elements.splice(dcSelected, 1);
  dcSelected = -1;
  dcRender();
}

/** Move the selection up or down the stack. Later in the array draws on top. */
function dcReorder(by) {
  if (dcSelected < 0) return;
  const to = dcSelected + by;
  if (to < 0 || to >= diDesign.elements.length) return;
  dcPushHistory();
  const [moved] = diDesign.elements.splice(dcSelected, 1);
  diDesign.elements.splice(to, 0, moved);
  dcSelected = to;
  dcRender();
}

// ---------------------------------------------------------------------------
// The panel beside the canvas
// ---------------------------------------------------------------------------

function dcWirePanel() {
  const panel = $('dc-panel');
  if (!panel) return;

  if (dcSelected < 0) {
    panel.innerHTML = `
      <h4>The card</h4>
      <label>Paper
        <select id="dc-page-size">
          ${Object.entries(DC_PAGES).map(([k, v]) =>
            `<option value="${k}" ${diDesign.page_size === k ? 'selected' : ''}>
               ${esc(v[2])} — ${v[0]}×${v[1]}mm</option>`
          ).join('')}
          <option value="custom" ${diDesign.page_size === 'custom' ? 'selected' : ''}>Custom</option>
        </select>
      </label>
      <div id="dc-custom" class="row" style="gap:8px" ${diDesign.page_size === 'custom' ? '' : 'hidden'}>
        <label style="flex:1">Width mm<input id="dc-pw" type="number" value="${diDesign.page_w_mm}"></label>
        <label style="flex:1">Height mm<input id="dc-ph" type="number" value="${diDesign.page_h_mm}"></label>
      </div>
      <label>Background
        <input id="dc-bg" type="color" value="${esc(diDesign.background || '#FFFFFF')}"
               style="width:64px;height:38px;padding:3px;border-radius:8px">
      </label>

      <h4 style="margin-top:18px">Start from</h4>
      <div class="dc-themes">
        ${Object.entries(DC_THEMES).map(([k, t]) =>
          `<button class="btn" data-theme="${k}" type="button">${esc(t.label)}</button>`
        ).join('')}
      </div>
      <p class="muted small">Replaces everything on the card. Undo puts it back.</p>

      <h4 style="margin-top:18px">Layers</h4>
      <ol class="dc-layers">
        ${diDesign.elements.map((el, i) =>
          `<li><button type="button" data-pick="${i}">
             <span class="dc-layer-icon">${DC_KINDS[el.kind] ? DC_KINDS[el.kind].icon : '?'}</span>
             ${esc(DC_KINDS[el.kind] ? DC_KINDS[el.kind].label : el.kind)}
             <span class="muted small">${esc((dcTextOf(el) || '').slice(0, 18))}</span>
           </button></li>`
        ).reverse().join('')}
      </ol>
      <p class="muted small">Top of the list is on top of the card.</p>`;

    $('dc-page-size').onchange = (e) => {
      diDesign.page_size = e.target.value;
      dcRender();
    };
    const pw = $('dc-pw'); const ph = $('dc-ph');
    if (pw) pw.oninput = () => { diDesign.page_w_mm = Number(pw.value) || 148; dcRender(); };
    if (ph) ph.oninput = () => { diDesign.page_h_mm = Number(ph.value) || 210; dcRender(); };
    $('dc-bg').oninput = (e) => {
      diDesign.background = e.target.value;
      const page = $('dc-page');
      if (page) page.style.background = e.target.value;
    };
    panel.querySelectorAll('[data-theme]').forEach((b) => {
      b.onclick = () => {
        const theme = DC_THEMES[b.dataset.theme];
        if (!theme) return;
        dcPushHistory();
        diDesign.background = theme.background;
        diDesign.elements = theme.elements();
        dcSelected = -1;
        dcRender();
      };
    });
    panel.querySelectorAll('[data-pick]').forEach((b) => {
      b.onclick = () => { dcSelected = Number(b.dataset.pick); dcRender(); };
    });
    return;
  }

  const el = diDesign.elements[dcSelected];
  const isText = !['qr', 'image', 'box'].includes(el.kind);

  panel.innerHTML = `
    <h4>${esc(DC_KINDS[el.kind] ? DC_KINDS[el.kind].label : el.kind)}</h4>

    ${el.kind === 'text' ? `
      <label>Words
        <textarea id="dc-text" rows="2">${esc(el.text || '')}</textarea>
      </label>` : ''}

    ${el.kind === 'image' ? `
      <label>Picture
        <input id="dc-url" value="${esc(el.url || '')}" placeholder="Paste a URL, or choose below">
      </label>
      <div class="row" style="gap:8px;margin-top:6px">
        <button class="btn" id="dc-upload" type="button">Upload a file</button>
      </div>
      <div class="dc-library">
        ${DC_LIBRARY.map(([url, label]) =>
          `<button type="button" data-lib="${esc(url)}" title="${esc(label)}">
             <img src="${esc(url)}" alt="${esc(label)}"></button>`
        ).join('')}
      </div>` : ''}

    ${el.kind === 'box' ? `
      <label>Colour
        <input id="dc-fill" type="color" value="${esc(el.fill || '#EFF6D8')}"
               style="width:64px;height:38px;padding:3px;border-radius:8px">
      </label>` : ''}

    ${isText ? `
      <label>Font
        <select id="dc-font">
          ${DC_FONTS.map(([value, label]) =>
            `<option value="${esc(value)}" ${(el.font || DC_FONTS[0][0]) === value ? 'selected' : ''}>${esc(label)}</option>`
          ).join('')}
        </select>
      </label>
      <div class="row" style="gap:8px">
        <label style="flex:1">Size (pt)
          <input id="dc-size" type="number" min="6" max="96" value="${el.size || 14}">
        </label>
        <label style="flex:1">Colour
          <input id="dc-colour" type="color" value="${esc(el.colour || '#14161A')}"
                 style="width:100%;height:38px;padding:3px;border-radius:8px">
        </label>
      </div>
      <div class="row" style="gap:6px;margin-top:6px">
        ${['left', 'center', 'right'].map((a) =>
          `<button class="btn ${el.align === a ? 'primary' : ''}" data-align="${a}" type="button">${a}</button>`
        ).join('')}
        <button class="btn ${el.bold ? 'primary' : ''}" id="dc-bold" type="button"><b>B</b></button>
      </div>` : ''}

    <h4 style="margin-top:18px">Position</h4>
    <div class="row" style="gap:8px">
      <label style="flex:1">Left %<input type="number" data-num="x" value="${Math.round(el.x)}"></label>
      <label style="flex:1">Top %<input type="number" data-num="y" value="${Math.round(el.y)}"></label>
    </div>
    <div class="row" style="gap:8px">
      <label style="flex:1">Width %<input type="number" data-num="w" value="${Math.round(el.w)}"></label>
      <label style="flex:1">Height %<input type="number" data-num="h" value="${Math.round(el.h)}"></label>
    </div>
    <p class="muted small">Dragging on the card sets these. They are here for
       when two things have to line up exactly.</p>

    <div class="row" style="gap:8px;margin-top:14px">
      <button class="btn" id="dc-centre-h" type="button">Centre across</button>
      <button class="btn" id="dc-deselect" type="button">Done</button>
    </div>`;

  const redraw = () => dcRender();

  const text = $('dc-text');
  if (text) text.oninput = () => { el.text = text.value; dcLive(); };

  const url = $('dc-url');
  if (url) url.oninput = () => { el.url = url.value.trim(); redraw(); };

  const upload = $('dc-upload');
  if (upload) upload.onclick = () => dcUpload(el);

  panel.querySelectorAll('[data-lib]').forEach((b) => {
    b.onclick = () => { el.url = b.dataset.lib; redraw(); };
  });

  const fill = $('dc-fill');
  if (fill) fill.oninput = () => { el.fill = fill.value; dcLive(); };

  const font = $('dc-font');
  if (font) font.onchange = () => { el.font = font.value; redraw(); };

  const size = $('dc-size');
  if (size) size.oninput = () => { el.size = Number(size.value) || 14; dcLive(); };

  const colour = $('dc-colour');
  if (colour) colour.oninput = () => { el.colour = colour.value; dcLive(); };

  panel.querySelectorAll('[data-align]').forEach((b) => {
    b.onclick = () => { el.align = b.dataset.align; redraw(); };
  });
  const bold = $('dc-bold');
  if (bold) bold.onclick = () => { el.bold = !el.bold; redraw(); };

  panel.querySelectorAll('[data-num]').forEach((input) => {
    input.oninput = () => {
      el[input.dataset.num] = Number(input.value) || 0;
      dcLive();
    };
  });

  $('dc-centre-h').onclick = () => {
    dcPushHistory();
    el.x = (100 - el.w) / 2;
    redraw();
  };
  $('dc-deselect').onclick = () => { dcSelected = -1; dcRender(); };
}

/** Repaint just the selected element, without rebuilding the whole editor —
    so typing in a text box does not lose the caret on every keystroke. */
function dcLive() {
  const page = $('dc-page');
  if (!page || dcSelected < 0) return;
  const node = page.querySelector(`[data-el-index="${dcSelected}"]`);
  if (!node) return;
  const el = diDesign.elements[dcSelected];
  node.style.left = el.x + '%';
  node.style.top = el.y + '%';
  node.style.width = el.w + '%';
  node.style.height = el.h + '%';
  if (el.kind === 'box') node.style.background = el.fill || '#EEEEEE';
  const text = node.querySelector('.dc-text');
  if (text) {
    text.textContent = dcTextOf(el);
    // Same conversion as dcElementHtml — the live repaint has to agree with the
    // full draw or the type jumps size the moment you stop typing.
    const [pw] = dcPageSize();
    const scale = page.getBoundingClientRect().width / pw;
    text.style.fontSize = ((el.size || 14) * (scale / 3.7795)).toFixed(2) + 'pt';
    text.style.color = el.colour || '#14161A';
  }
}

function dcPaintPanelNumbers(el) {
  document.querySelectorAll('[data-num]').forEach((input) => {
    input.value = Math.round(el[input.dataset.num]);
  });
}

/**
 * Put a picture from this machine onto the card.
 *
 * Read as a data URL rather than uploaded, so it travels inside the saved
 * design and there is no second thing to keep — no orphaned file when a card is
 * deleted, and no broken picture when somebody tidies an uploads folder. Capped,
 * because a design is stored as one JSON column and a phone photograph is four
 * megabytes.
 */
function dcUpload(el) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/png,image/jpeg,image/svg+xml,image/webp';
  input.onchange = () => {
    const file = input.files && input.files[0];
    if (!file) return;
    if (file.size > 1_500_000) {
      alert(
        'That picture is ' + Math.round(file.size / 1024) + 'KB. Cards hold ' +
        'pictures up to about 1.5MB — resize it, or paste a web address ' +
        'instead.'
      );
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      el.url = String(reader.result);
      dcRender();
    };
    reader.readAsDataURL(file);
  };
  input.click();
}
