/**
 * The dashboard's cards, arranged by the person looking at them (2026-09-24).
 *
 * "Can you also add a note to be able to move widgets around on the
 * dashboard, so customers can choose what they see first."
 *
 * Every card on the dashboard is a `.dash-widget` with a key. Customise puts
 * the page into an edit mode where each card can be dragged by its handle (a
 * mouse or a finger -- pointer events, so an iPad works), nudged with arrows
 * (a keyboard works too), switched between half and full width, or hidden.
 * Hidden cards wait in a tray at the top of the page to be put back.
 *
 * The layout is each person's own: a manager who lives on Top products and a
 * owner who wants Takings first can both have it. Kept on the server
 * (GET/PUT /dashboard/layout) so it follows them to the iPad, with the
 * browser's copy as a fallback for a server that has not been migrated yet.
 *
 * Loaded before app.js like stock.js: app.js's loadDashboard() calls
 * dwApply(); everything here uses app.js's `$`, `api`, `esc` and `toast` only
 * from inside calls.
 */

/* global $, api, esc, toast, loadDashboardAnalytics */

const DW_STORE = 'vesopa_dashboard_layout_v1';

/** The standard layout: the order and widths index.html ships with. */
function dwDefault() {
  return [...document.querySelectorAll('#dash-widgets .dash-widget')]
    .sort((a, b) => Number(a.dataset.dwHome) - Number(b.dataset.dwHome))
    .map((w) => ({ key: w.dataset.widget, size: w.dataset.sizeHome || w.dataset.size || 'half', hidden: false }));
}

/**
 * A saved layout made safe to apply: unknown keys dropped (a card that no
 * longer exists), cards it does not mention added at the end in their standard
 * width (a card added in a later release shows up rather than being lost).
 */
function dwNormalise(saved, defaults) {
  const known = new Map(defaults.map((d) => [d.key, d]));
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(saved) ? saved : []) {
    if (!item || !known.has(item.key) || seen.has(item.key)) continue;
    seen.add(item.key);
    out.push({ key: item.key, size: item.size === 'full' ? 'full' : 'half', hidden: Boolean(item.hidden) });
  }
  for (const d of defaults) if (!seen.has(d.key)) out.push({ ...d });
  return out;
}

let dwLayout = null;
let dwEditing = false;
let dwLoaded = false;

function dwReadLocal() {
  try {
    return JSON.parse(localStorage.getItem(DW_STORE) || 'null');
  } catch {
    return null;
  }
}
function dwWriteLocal(layout) {
  try {
    localStorage.setItem(DW_STORE, JSON.stringify(layout));
  } catch {
    // Private mode: the server copy is the one that matters.
  }
}

/** Remember each card's shipped position once, so Reset can go back to it. */
function dwStampHome() {
  document.querySelectorAll('#dash-widgets .dash-widget').forEach((w, i) => {
    if (w.dataset.dwHome === undefined) {
      w.dataset.dwHome = String(i);
      w.dataset.sizeHome = w.dataset.size || 'half';
    }
  });
}

/** Put the cards in the layout's order, widths and visibility. */
function dwRender() {
  const host = $('dash-widgets');
  if (!host || !dwLayout) return;
  for (const item of dwLayout) {
    const w = host.querySelector(`.dash-widget[data-widget="${CSS.escape(item.key)}"]`);
    if (!w) continue;
    w.dataset.size = item.size;
    w.hidden = item.hidden;
    host.appendChild(w);
  }
  host.classList.toggle('editing', dwEditing);
  document.querySelectorAll('#dash-widgets .dash-widget').forEach((w) => dwChrome(w));
  const tray = $('dash-hidden-tray');
  const hidden = dwLayout.filter((i) => i.hidden);
  if (tray) {
    tray.hidden = !dwEditing || !hidden.length;
    tray.innerHTML = hidden.length
      ? `<span class="muted small">Hidden:</span>${hidden.map((i) => {
          const w = host.querySelector(`.dash-widget[data-widget="${CSS.escape(i.key)}"]`);
          return `<button type="button" class="dash-chip" data-dw-show="${esc(i.key)}">+ ${esc((w && w.dataset.title) || i.key)}</button>`;
        }).join('')}`
      : '';
  }
  const bar = $('dash-edit-bar');
  if (bar) bar.hidden = !dwEditing;
  const btn = $('dash-customise');
  if (btn) btn.hidden = dwEditing;
}

/** The edit strip on top of one card: handle, title, arrows, width, hide. */
function dwChrome(w) {
  let bar = w.querySelector(':scope > .dash-widget-bar');
  if (!dwEditing) {
    if (bar) bar.remove();
    return;
  }
  const key = w.dataset.widget;
  const i = dwLayout.findIndex((x) => x.key === key);
  const visible = dwLayout.filter((x) => !x.hidden);
  const vi = visible.findIndex((x) => x.key === key);
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'dash-widget-bar';
    w.prepend(bar);
  }
  bar.innerHTML = `
    <span class="dash-handle" data-dw-drag="${esc(key)}" title="Drag to move" aria-hidden="true">⠿</span>
    <strong class="dash-widget-name">${esc(w.dataset.title || key)}</strong>
    <span class="dash-widget-tools">
      <button type="button" data-dw-move="-1" data-dw-key="${esc(key)}" aria-label="Move ${esc(w.dataset.title || key)} earlier" ${vi <= 0 ? 'disabled' : ''}>↑</button>
      <button type="button" data-dw-move="1" data-dw-key="${esc(key)}" aria-label="Move ${esc(w.dataset.title || key)} later" ${vi >= visible.length - 1 ? 'disabled' : ''}>↓</button>
      <button type="button" data-dw-size data-dw-key="${esc(key)}" title="Half or full width">${dwLayout[i] && dwLayout[i].size === 'full' ? 'Half width' : 'Full width'}</button>
      <button type="button" data-dw-hide data-dw-key="${esc(key)}" title="Hide this card">Hide</button>
    </span>`;
}

async function dwLoad() {
  dwStampHome();
  const defaults = dwDefault();
  let saved = null;
  try {
    const r = await api('/dashboard/layout');
    saved = r && Array.isArray(r.layout) ? r.layout : null;
    if (!saved) saved = dwReadLocal();
  } catch {
    saved = dwReadLocal();
  }
  dwLayout = dwNormalise(saved, defaults);
  dwLoaded = true;
  dwRender();
}

async function dwSave() {
  dwWriteLocal(dwLayout);
  try {
    await api('/dashboard/layout', { method: 'PUT', body: JSON.stringify({ layout: dwLayout }) });
  } catch {
    // Kept in this browser; the server copy catches up on the next save.
  }
}

/** Called by loadDashboard(): lay the cards out, fetching the layout once. */
function dwApply() {
  if (!dwLoaded) return dwLoad();
  dwRender();
  return Promise.resolve();
}

function dwMove(key, by) {
  // Moves among the VISIBLE cards: a hidden one in between should not make
  // an arrow press look as if it did nothing.
  const visible = dwLayout.filter((x) => !x.hidden);
  const vi = visible.findIndex((x) => x.key === key);
  const target = visible[vi + by];
  if (!target) return;
  const from = dwLayout.findIndex((x) => x.key === key);
  const [item] = dwLayout.splice(from, 1);
  const to = dwLayout.findIndex((x) => x.key === target.key);
  dwLayout.splice(by > 0 ? to + 1 : to, 0, item);
  dwRender();
  dwSave();
}

function dwRedrawCharts() {
  // Charts are drawn to their box; one that changed width is redrawn.
  if (typeof loadDashboardAnalytics === 'function') {
    try { loadDashboardAnalytics(); } catch { /* the next refresh draws it */ }
  }
}

document.addEventListener('click', (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  if (t.id === 'dash-customise') {
    dwEditing = true;
    return dwRender();
  }
  if (t.id === 'dash-done') {
    dwEditing = false;
    dwRender();
    return dwSave();
  }
  if (t.id === 'dash-reset') {
    dwLayout = dwDefault();
    dwRender();
    dwSave();
    dwRedrawCharts();
    return toast('Dashboard back to the standard layout.');
  }
  const d = t.dataset;
  if (d.dwMove) return dwMove(d.dwKey, Number(d.dwMove));
  if (d.dwSize !== undefined) {
    const item = dwLayout.find((x) => x.key === d.dwKey);
    if (item) item.size = item.size === 'full' ? 'half' : 'full';
    dwRender();
    dwSave();
    return dwRedrawCharts();
  }
  if (d.dwHide !== undefined) {
    const item = dwLayout.find((x) => x.key === d.dwKey);
    if (item) item.hidden = true;
    dwRender();
    return dwSave();
  }
  if (d.dwShow) {
    const item = dwLayout.find((x) => x.key === d.dwShow);
    if (item) item.hidden = false;
    dwRender();
    dwSave();
    return dwRedrawCharts();
  }
});

// Dragging, by the handle, with a mouse or a finger.
let dwDrag = null;
document.addEventListener('pointerdown', (e) => {
  const handle = e.target.closest('[data-dw-drag]');
  if (!handle || !dwEditing) return;
  const w = handle.closest('.dash-widget');
  if (!w) return;
  e.preventDefault();
  dwDrag = { key: w.dataset.widget, el: w, id: e.pointerId };
  w.classList.add('dragging');
  document.body.classList.add('dash-dragging');
});
document.addEventListener('pointermove', (e) => {
  if (!dwDrag || e.pointerId !== dwDrag.id) return;
  e.preventDefault();
  const host = $('dash-widgets');
  // What is under the pointer, ignoring the card being carried.
  dwDrag.el.style.pointerEvents = 'none';
  const under = document.elementFromPoint(e.clientX, e.clientY);
  dwDrag.el.style.pointerEvents = '';
  const over = under && under.closest('#dash-widgets .dash-widget');
  if (!over || over === dwDrag.el) return;
  const r = over.getBoundingClientRect();
  // Before or after: which half of the card the pointer is over, across
  // for a half-width card and down for a full-width one.
  const after = over.dataset.size === 'full'
    ? e.clientY > r.top + r.height / 2
    : (e.clientY > r.bottom - r.height * 0.25) || (e.clientX > r.left + r.width / 2 && e.clientY > r.top + r.height * 0.25);
  host.insertBefore(dwDrag.el, after ? over.nextSibling : over);
});
function dwDrop(e) {
  if (!dwDrag || (e && e.pointerId !== dwDrag.id)) return;
  dwDrag.el.classList.remove('dragging');
  document.body.classList.remove('dash-dragging');
  dwDrag = null;
  // The DOM order is the new order; hidden cards keep their place in it.
  const order = [...document.querySelectorAll('#dash-widgets .dash-widget')].map((w) => w.dataset.widget);
  dwLayout.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
  dwRender();
  dwSave();
  dwRedrawCharts();
}
document.addEventListener('pointerup', dwDrop);
document.addEventListener('pointercancel', dwDrop);
