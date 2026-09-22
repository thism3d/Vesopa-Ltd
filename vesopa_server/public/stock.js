/**
 * Stock Control: eight pages over the ledger stock.js (server) keeps.
 *
 *   Stock Levels     -- every product, what is on the shelf, what it is worth,
 *                       and the settings that make it orderable.
 *   Suppliers        -- who a venue buys from.
 *   Case Sizes       -- a case of 24, an 11g keg of 88 pints.
 *   Recipes          -- a cocktail made of other products (2026-09-22).
 *   Orders & Deliveries -- raise an order in packs, send it, book it in.
 *   Wastage, Adjustments, Stock Takes, Spot Checks -- four kinds of one
 *                       document: lines, a draft, and a Complete that writes
 *                       the ledger once.
 *
 * Loaded before app.js, like screens.js and permissions.js: app.js's view map
 * names these loaders, and they use app.js's `$`, `api`, `esc`, `modal`,
 * `confirmDialog`, `toast` and `iconBtn` only from inside a call, which is
 * always after everything has parsed.
 *
 * THE ONE RULE THE EDITORS FOLLOW
 *
 * Nothing moves stock until Complete is pressed, and Complete asks first. A
 * draft can be saved, reopened and thrown away; a completed document is
 * history and the buttons that could change it are not drawn.
 */

/* global $, api, esc, modal, confirmDialog, toast, iconBtn, render, token */

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

const SK_DOC = {
  wastage: {
    title: 'Wastage',
    blurb: 'What was thrown away, spilled or sent back. Completing a wastage takes the quantity off the shelf and costs it.',
    qty: 'Wasted',
    reason: true,
    verb: 'Record wastage',
  },
  adjustment: {
    title: 'Adjustments',
    blurb: 'A correction that is neither a sale nor a delivery — a box found in the cellar, a miscount put right. Positive adds, negative takes away.',
    qty: 'Adjust by',
    reason: true,
    verb: 'Record an adjustment',
  },
  stocktake: {
    title: 'Stock Takes',
    blurb: 'Count what is on the shelf. Completing a stock take SETS each product’s count to what you typed, and the Stock Variance report shows the difference.',
    qty: 'Counted',
    reason: false,
    verb: 'Start a stock take',
    counting: true,
  },
  spot_check: {
    title: 'Spot Checks',
    blurb: 'A stock take of a few products. Same rules: what you type becomes the count.',
    qty: 'Counted',
    reason: false,
    verb: 'Start a spot check',
    counting: true,
  },
};

const skMoney = (minor) => `£${(Math.round(Number(minor) || 0) / 100).toFixed(2)}`;
const skQty = (n) => {
  const v = Number(n) || 0;
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
};
const skWhen = (value) => {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const skShort = (id) => String(id || '').slice(0, 8).toUpperCase();

/** The catalogue as the stock pages see it: fetched once per page open. */
let skProducts = [];
async function skLoadProducts() {
  skProducts = await api('/stock/products');
  return skProducts;
}
const skDepartments = () =>
  [...new Set(skProducts.map((p) => p.department_name || 'Unassigned'))].sort();

/** Whether a product answers a search: every word somewhere in it. */
function skMatches(p, query) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = `${p.product_name || ''} ${p.pluid} ${p.barcode || ''} ${p.department_name || ''} ${p.group_name || ''}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

/**
 * What a typed box means: the products it could be.
 *
 * It used to accept only the exact full name or a PLU, so "guinness" or
 * "pint" -- what anybody actually types, and all an iPad's product box lets
 * them type, since Safari barely shows a datalist -- was refused with "Type a
 * product name or PLU" (reported as "products won't add", 2026-09-22). Now an
 * exact PLU, barcode or name wins outright, and otherwise every product with
 * all the typed words in it is a candidate.
 */
function skResolve(typed) {
  const text = String(typed || '').trim();
  if (!text) return [];
  const tagged = /PLU\s+(\d+)/i.exec(text);
  if (tagged) return skProducts.filter((p) => p.pluid === Number(tagged[1]));
  const lower = text.toLowerCase();
  const exact = skProducts.filter((p) => String(p.pluid) === text || String(p.barcode || '') === text
    || String(p.product_name || '').toLowerCase() === lower);
  if (exact.length) return exact;
  return skProducts.filter((p) => skMatches(p, text));
}

/** The case size, in a few words, for a picker row. */
const skCaseLabel = (p) => (p.pack_name ? `${p.pack_name}${p.pack_units > 1 ? ` (${skQty(p.pack_units)})` : ''}` : 'No case size');

let skPickCssDone = false;
function skPickCss() {
  if (skPickCssDone) return;
  skPickCssDone = true;
  const style = document.createElement('style');
  style.textContent = `
    .sk-pick{width:min(760px,96vw);max-height:92vh;display:flex;flex-direction:column}
    .sk-pick-filters{display:grid;grid-template-columns:2fr 1fr 1fr;gap:8px;margin:8px 0}
    .sk-pick-filters input[type=search]{grid-column:1/-1}
    .sk-pick-bar{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:4px 0 6px;flex-wrap:wrap}
    .sk-pick-bar label{display:flex;align-items:center;gap:6px;margin:0;font-weight:500}
    .sk-pick-list{overflow:auto;border:1px solid var(--line,#e3e3e3);border-radius:10px;min-height:180px;max-height:52vh}
    .sk-pick-row{display:grid;grid-template-columns:28px 1fr auto;gap:8px;align-items:center;padding:9px 12px;border-bottom:1px solid var(--line,#eee);cursor:pointer;margin:0}
    .sk-pick-row:hover{background:rgba(165,199,21,.08)}
    .sk-pick-row small{display:block;color:var(--muted,#777);font-weight:400}
    .sk-pick-tag{font-size:.72rem;padding:2px 7px;border-radius:999px;background:#f1f1f1;color:#555;white-space:nowrap;margin-left:4px}
    .sk-pick-empty{padding:24px;text-align:center;color:var(--muted,#777)}
    .sk-pick label.sk-pick-opt{display:inline-flex;flex-direction:row;align-items:center;gap:8px;white-space:nowrap;width:auto;margin:0;font-weight:500}
    .sk-pick input[type=checkbox]{width:18px;height:18px;min-width:18px;margin:0;padding:0;box-shadow:none;flex:none}
    .sk-pick .sk-pick-row{display:grid}
    @media (max-width:620px){.sk-pick-filters{grid-template-columns:1fr 1fr}}
  `;
  document.head.appendChild(style);
}

/**
 * Choose products: many at once, by search, department or sub-department.
 * "Look at Newbridge" (2026-09-22): adding a stock take one product at a time
 * was the slowest part of the job.
 *
 * Resolves to the chosen PLUs (possibly none). `single` picks one and closes;
 * `stockOnly` starts with "stock items only" ticked -- products with a case
 * size that are not non-stock, linked or a recipe, the ones a count is of.
 */
function skPick({ title = 'Choose products', stockOnly = false, exclude = [], single = false, search = '', okLabel = 'Add' } = {}) {
  skPickCss();
  return new Promise((resolve) => {
    const skip = new Set(exclude.map(Number));
    const chosen = new Set();
    const depts = skDepartments();
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `
      <div class="modal sk-pick" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <h3>${esc(title)}</h3>
        <div class="sk-pick-filters">
          <input type="search" data-pk-q placeholder="Search part of a name, a PLU or a barcode" value="${esc(search)}" autocomplete="off">
          <select data-pk-dept><option value="">All departments</option>${depts.map((d) => `<option value="${esc(d)}">${esc(d)}</option>`).join('')}</select>
          <select data-pk-sub><option value="">All sub-departments</option></select>
          <label class="sk-pick-opt"><input type="checkbox" data-pk-stock ${stockOnly ? 'checked' : ''}> Stock items only</label>
        </div>
        ${single ? '' : '<div class="sk-pick-bar"><label class="sk-pick-opt"><input type="checkbox" data-pk-all> Select all shown</label><span class="muted small" data-pk-count></span></div>'}
        <div class="sk-pick-list" data-pk-list></div>
        <div class="modal-actions">
          <button type="button" class="btn ghost" data-pk-cancel>Cancel</button>
          ${single ? '' : `<button type="button" class="btn primary" data-pk-ok disabled>${esc(okLabel)}</button>`}
        </div>
      </div>`;
    document.body.appendChild(back);
    const q = back.querySelector('[data-pk-q]');
    const dept = back.querySelector('[data-pk-dept]');
    const sub = back.querySelector('[data-pk-sub]');
    const stock = back.querySelector('[data-pk-stock]');
    const list = back.querySelector('[data-pk-list]');
    const all = back.querySelector('[data-pk-all]');
    const count = back.querySelector('[data-pk-count]');
    const ok = back.querySelector('[data-pk-ok]');

    const subsFor = (d) => [...new Set(skProducts
      .filter((p) => !d || (p.department_name || 'Unassigned') === d)
      .map((p) => p.group_name).filter(Boolean))].sort();
    const fillSubs = () => {
      const keep = sub.value;
      sub.innerHTML = '<option value="">All sub-departments</option>'
        + subsFor(dept.value).map((g) => `<option value="${esc(g)}"${g === keep ? ' selected' : ''}>${esc(g)}</option>`).join('');
    };
    const shown = () => skProducts.filter((p) => !skip.has(p.pluid)
      && (!dept.value || (p.department_name || 'Unassigned') === dept.value)
      && (!sub.value || p.group_name === sub.value)
      && (!stock.checked || p.stock_item)
      && skMatches(p, q.value));
    const finish = (value) => { back.remove(); resolve(value); };

    const draw = () => {
      const rows = shown();
      list.innerHTML = rows.slice(0, 600).map((p) => `
        <label class="sk-pick-row" data-pk-row="${p.pluid}">
          ${single ? '<span></span>' : `<input type="checkbox" data-pk-pick="${p.pluid}" ${chosen.has(p.pluid) ? 'checked' : ''}>`}
          <span><strong>${esc(p.product_name)}</strong><small>${esc([p.department_name, p.group_name].filter(Boolean).join(' · ') || 'No department')} · PLU ${p.pluid}</small></span>
          <span class="nowrap"><span class="sk-pick-tag">${esc(skCaseLabel(p))}</span>${p.non_stock ? '<span class="sk-pick-tag">Non-stock</span>' : ''}${p.is_linked ? '<span class="sk-pick-tag">Linked</span>' : ''}${p.is_recipe ? '<span class="sk-pick-tag">Recipe</span>' : ''}</span>
        </label>`).join('')
        || `<div class="sk-pick-empty">${stock.checked ? 'No stock items match. Untick “Stock items only” to see everything — or give products a case size.' : 'Nothing matches.'}</div>`;
      if (count) count.textContent = `${rows.length} shown · ${chosen.size} chosen`;
      if (all) all.checked = rows.length > 0 && rows.every((p) => chosen.has(p.pluid));
      if (ok) {
        ok.disabled = chosen.size === 0;
        ok.textContent = chosen.size ? `${okLabel} ${chosen.size} product${chosen.size === 1 ? '' : 's'}` : okLabel;
      }
    };

    q.addEventListener('input', draw);
    dept.addEventListener('change', () => { fillSubs(); draw(); });
    sub.addEventListener('change', draw);
    stock.addEventListener('change', draw);
    if (all) {
      all.addEventListener('change', () => {
        for (const p of shown()) {
          if (all.checked) chosen.add(p.pluid);
          else chosen.delete(p.pluid);
        }
        draw();
      });
    }
    list.addEventListener('click', (e) => {
      const row = e.target.closest('[data-pk-row]');
      if (!row) return;
      const plu = Number(row.dataset.pkRow);
      if (single) { e.preventDefault(); finish([plu]); return; }
      if (e.target.matches('[data-pk-pick]')) {
        if (e.target.checked) chosen.add(plu);
        else chosen.delete(plu);
      } else {
        e.preventDefault();
        if (chosen.has(plu)) chosen.delete(plu);
        else chosen.add(plu);
      }
      draw();
    });
    back.querySelector('[data-pk-cancel]').addEventListener('click', () => finish([]));
    if (ok) ok.addEventListener('click', () => finish([...chosen]));
    back.addEventListener('keydown', (e) => { if (e.key === 'Escape') finish([]); });
    fillSubs();
    draw();
    setTimeout(() => q.focus(), 30);
  });
}

const skProduct = (pluid) => skProducts.find((p) => p.pluid === Number(pluid));

const skLevelBadge = (p) => {
  switch (p.level) {
    case 'out':
      return '<span class="badge paused">Out of stock</span>';
    case 'low':
      return '<span class="badge due">Low</span>';
    case 'untracked':
      return '<span class="badge archived">Not tracked</span>';
    default:
      return '<span class="badge active">In stock</span>';
  }
};

// ---------------------------------------------------------------------------
// Stock Levels
// ---------------------------------------------------------------------------

let skSuppliers = [];
let skPacks = [];

async function loadStockLevels() {
  const [products, suppliers, packs] = await Promise.all([
    skLoadProducts(),
    api('/stock/suppliers'),
    api('/stock/pack-sizes'),
  ]);
  skSuppliers = suppliers;
  skPacks = packs;

  const dept = $('sk-dept');
  const keep = dept.value;
  dept.innerHTML =
    '<option value="">Every department</option>' +
    skDepartments().map((d) => `<option value="${esc(d)}">${esc(d)}</option>`).join('');
  dept.value = keep;

  const tracked = products.filter((p) => p.level !== 'untracked');
  const value = tracked.reduce((a, p) => a + (p.stock_value_minor || 0), 0);
  $('sk-tiles').innerHTML = [
    ['Stock value', skMoney(value), `${tracked.length} tracked product${tracked.length === 1 ? '' : 's'}`, true],
    ['Out of stock', String(products.filter((p) => p.level === 'out').length), 'Count is zero or below'],
    ['Low', String(products.filter((p) => p.level === 'low').length), 'At or under the minimum'],
    ['Not tracked', String(products.filter((p) => p.level === 'untracked').length), 'No count kept'],
  ]
    .map(
      ([label, v, hint, hero]) => `<div class="rr-tile${hero ? ' hero' : ''}">
        <div class="rr-tile-label">${esc(label)}</div>
        <div class="rr-tile-value">${esc(v)}</div>
        <div class="rr-tile-hint">${esc(hint)}</div>
      </div>`
    )
    .join('');

  skRenderLevels();
}

function skRenderLevels() {
  const dept = $('sk-dept').value;
  const level = $('sk-level').value;
  const needle = ($('sk-search').value || '').trim().toLowerCase();
  const rank = { out: 0, low: 1, ok: 2, untracked: 3 };
  const rows = skProducts
    .filter((p) => !dept || (p.department_name || 'Unassigned') === dept)
    .filter((p) => !level || p.level === level)
    .filter(
      (p) =>
        !needle ||
        String(p.product_name || '').toLowerCase().includes(needle) ||
        String(p.pluid).includes(needle) ||
        String(p.supplier_name || '').toLowerCase().includes(needle)
    )
    .sort((a, b) => rank[a.level] - rank[b.level] || String(a.product_name).localeCompare(String(b.product_name)));

  $('sk-levels').innerHTML =
    rows
      .map(
        (p) => `<tr>
        <td data-label="PLU">${p.pluid}</td>
        <td data-label="Product"><strong>${esc(p.product_name)}</strong><div class="muted small">${esc(p.department_name || '—')}${p.group_name ? ` · ${esc(p.group_name)}` : ''}</div></td>
        <td data-label="Supplier">${esc(p.supplier_name || '—')}${p.supplier_code ? `<div class="muted small">${esc(p.supplier_code)}</div>` : ''}</td>
        <td data-label="Pack">${p.pack_name ? esc(`${p.pack_name} (${skQty(p.pack_units)})`) : '—'}</td>
        <td data-label="In stock" class="right nowrap">${p.level === 'untracked' ? '<span class="muted small">Not tracked</span>' : esc(p.stock_display)}</td>
        <td data-label="Min / Max" class="right nowrap">${p.min_stock !== null ? skQty(p.min_stock) : '—'} / ${p.max_stock !== null ? skQty(p.max_stock) : '—'}</td>
        <td data-label="Unit cost" class="right nowrap">${skMoney(p.unit_cost_minor)}</td>
        <td data-label="Value" class="right nowrap">${p.level === 'untracked' ? '—' : skMoney(p.stock_value_minor)}</td>
        <td data-label="Status">${skLevelBadge(p)}</td>
        <td class="right nowrap row-actions-cell">
          ${iconBtn('topup', 'Book a delivery', `data-sk-in="${p.pluid}"`)}
          ${iconBtn('check', 'Set the count', `data-sk-count="${p.pluid}"`)}
          ${iconBtn('history', 'Movements', `data-sk-history="${p.pluid}"`)}
          ${iconBtn('tune', 'Stock settings', `data-sk-settings="${p.id}"`)}
        </td>
      </tr>`
      )
      .join('') || '<tr><td colspan="10" class="empty">Nothing matches.</td></tr>';
}

/** "GP 68.2% at £4.50. At your 70% target, charge £4.80." -- or why not. */
function skGpLine(p) {
  const g = p.gp || {};
  if (!g.has_cost) return 'Add a cost to see the GP and a recommended price.';
  const now = g.current_gp === null || g.current_gp === undefined
    ? 'No price set yet.'
    : `GP ${g.current_gp}% at £${Number(p.price || 0).toFixed(2)}.`;
  return `${now} At a ${g.target_gp}% target, charge ${skMoney(g.recommended_price_minor)} (incl. VAT).`;
}

/**
 * The stock settings of one product: supplier, case size, cost, and -- since
 * 2026-09-22 -- non-stock, what it sells from, and the GP it should make.
 *
 * Opened from Stock Levels and from the product list (skOpenStockInfo), so it
 * loads what it needs rather than assuming the Stock Levels page did.
 */
function skSettings(id) {
  const p = skProducts.find((x) => String(x.id) === String(id));
  if (!p) return;
  // What it can sell from: anything that is not itself linked, and not it.
  const parents = skProducts
    .filter((x) => x.pluid !== p.pluid && !x.stock_parent_pluid)
    .map((x) => ({ value: x.pluid, label: `${x.product_name} — PLU ${x.pluid}${x.pack_name ? ` · ${x.pack_name}` : ''}` }));
  modal(
    `Stock info — ${p.product_name}`,
    [
      {
        name: 'supplier_id',
        label: 'Supplier',
        type: 'select',
        value: p.supplier_id ?? '',
        options: [{ value: '', label: 'None' }].concat(skSuppliers.filter((s) => s.active || s.id === p.supplier_id).map((s) => ({ value: s.id, label: s.name }))),
        hint: skSuppliers.length ? '' : 'No suppliers yet — add them under Stock Control → Suppliers.',
      },
      { name: 'supplier_code', label: 'Supplier’s code for it (optional)', value: p.supplier_code || '' },
      {
        name: 'pack_size_id',
        label: 'Case size',
        type: 'select',
        value: p.pack_size_id ?? '',
        options: [{ value: '', label: 'No case size (not counted on a stock take)' }].concat(skPacks.map((k) => ({ value: k.id, label: `${k.name} — ${skQty(k.units)} units` }))),
      },
      { name: 'pack_cost', label: 'Cost of one case £', type: 'money', value: p.pack_cost ?? '', hint: 'Sets the unit cost from the case. Leave blank to type the unit cost below.' },
      { name: 'cost_price', label: 'Unit cost £', type: 'money', value: p.cost_price ?? '', hint: skGpLine(p) },
      { name: 'target_gp', label: 'Target GP %', type: 'number', value: p.target_gp ?? '', placeholder: String((p.gp && p.gp.target_gp) || 70), hint: 'The GP the recommended price aims for. Blank uses 70%.' },
      {
        name: 'non_stock',
        label: 'Non-stock item — never counted on a stock take',
        type: 'checkbox',
        value: p.non_stock ? 1 : 0,
      },
      {
        name: 'stock_parent_pluid',
        label: 'Sells from another product (linked)',
        type: 'select',
        value: p.stock_parent_pluid ?? '',
        options: [{ value: '', label: 'No — it has its own stock' }].concat(parents),
        hint: 'A half pint sells from the pint; a glass of wine from the bottle. Selling this takes stock off that product instead.',
      },
      { name: 'stock_ratio', label: 'Uses how much of it', type: 'number', value: p.stock_ratio ?? '', placeholder: 'e.g. 0.5 for a half pint, 0.25 for a 175ml glass of a 70cl bottle', hint: 'In the linked product’s units. Leave blank if not linked.' },
      { name: 'min_stock', label: 'Minimum units to keep', type: 'number', value: p.min_stock ?? '', hint: 'At or under this the product is "low" and a suggested order includes it.' },
      { name: 'max_stock', label: 'Order back up to (units)', type: 'number', value: p.max_stock ?? '' },
      { name: 'stock_unit', label: 'Sold as (pint, bottle, portion…)', value: p.stock_unit || '' },
    ],
    async (d) => {
      await api(`/stock/products/${p.id}/settings`, { method: 'PUT', body: JSON.stringify(d) });
      await skLoadProducts();
      toast(`${p.product_name}: stock info saved.`);
      if (typeof render === 'function') render();
    }
  );
}

/**
 * Open a product's stock info from anywhere -- the product list's row button
 * uses this. Loads the catalogue, suppliers and case sizes it needs first.
 */
async function skOpenStockInfo(productId) {
  try {
    const [, suppliers, packs] = await Promise.all([
      skLoadProducts(),
      api('/stock/suppliers').catch(() => []),
      api('/stock/pack-sizes').catch(() => []),
    ]);
    skSuppliers = suppliers;
    skPacks = packs;
    skSettings(productId);
  } catch (err) {
    toast(err.message, 'error');
  }
}

/** A one-line document from the levels page: a delivery or a count. */
function skQuickDoc(pluid, kind) {
  const p = skProduct(pluid);
  if (!p) return;
  const counting = kind === 'stocktake';
  modal(
    counting ? `Set the count — ${p.product_name}` : `Book a delivery — ${p.product_name}`,
    [
      {
        name: 'quantity',
        label: counting
          ? `How many are on the shelf?${p.level !== 'untracked' ? ` (the system says ${skQty(p.stock_quantity)})` : ''}`
          : `How many units arrived?${p.pack_name && p.pack_units > 1 ? ` (${p.pack_name} = ${skQty(p.pack_units)})` : ''}`,
        type: 'number',
        value: counting && p.level !== 'untracked' ? skQty(p.stock_quantity) : '',
        required: true,
      },
      { name: 'reason', label: counting ? 'Note (optional)' : 'Delivery note or supplier (optional)', value: '' },
    ],
    async (d) => {
      const n = Number(d.quantity);
      if (!Number.isFinite(n)) throw new Error('Give a number.');
      if (!counting && n <= 0) throw new Error('A delivery has to bring something.');
      const r = await api('/stock/docs', {
        method: 'POST',
        body: JSON.stringify({ kind: counting ? 'stocktake' : 'delivery', complete: true, notes: d.reason || null, lines: [{ pluid: p.pluid, quantity: n, reason: d.reason || null }] }),
      });
      if (!r.completed) throw new Error('The document was saved but not completed.');
      toast(counting ? `${p.product_name}: count set to ${skQty(n)}.` : `${p.product_name}: ${skQty(n)} booked in.`);
    }
  );
}

/** The ledger for one product, most recent first. */
async function skHistory(pluid) {
  const p = skProduct(pluid);
  if (!p) return;
  const rows = await api(`/stock/movements?pluid=${pluid}&limit=200`);
  const label = { sale: 'Sale', refund: 'Refund', wastage: 'Wastage', delivery: 'Delivery', adjustment: 'Adjustment', stocktake: 'Stock take', spot_check: 'Spot check' };
  const root = $('modal-root');
  root.innerHTML = `
    <div class="modal-back">
      <div class="modal sk-wide">
        <h3>${esc(p.product_name)} — movements</h3>
        <p class="muted small">Now ${esc(p.stock_display)}. The most recent two hundred, newest first.</p>
        <div class="rr-scroll">
          <table class="table" data-no-cards>
            <thead><tr><th>When</th><th>Movement</th><th class="right">Quantity</th><th>Reason</th><th>By</th><th>Terminal</th></tr></thead>
            <tbody>${
              rows
                .map(
                  (m) => `<tr>
                    <td class="nowrap">${esc(skWhen(m.moved_at))}</td>
                    <td>${esc(label[m.kind] || m.kind)}</td>
                    <td class="right nowrap">${Number(m.quantity) > 0 ? '+' : ''}${skQty(m.quantity)}</td>
                    <td>${esc(m.reason || (m.order_id ? `Order ${skShort(m.order_id)}` : ''))}</td>
                    <td>${esc(m.staff_name || '')}</td>
                    <td>${esc(m.terminal || '')}</td>
                  </tr>`
                )
                .join('') || '<tr><td colspan="6" class="muted small">Nothing has moved yet.</td></tr>'
            }</tbody>
          </table>
        </div>
        <div class="modal-actions"><button type="button" class="btn primary" id="modal-cancel">Close</button></div>
      </div>
    </div>`;
  root.querySelector('#modal-cancel').onclick = () => { root.innerHTML = ''; };
}

// ---------------------------------------------------------------------------
// Suppliers
// ---------------------------------------------------------------------------

async function loadStockSuppliers() {
  skSuppliers = await api('/stock/suppliers');
  $('sk-suppliers').innerHTML =
    skSuppliers
      .map(
        (s) => `<tr>
        <td data-label="Supplier"><strong>${esc(s.name)}</strong>${s.account_ref ? `<div class="muted small">Account ${esc(s.account_ref)}</div>` : ''}</td>
        <td data-label="Contact">${esc(s.contact_name || '')}</td>
        <td data-label="Phone">${esc(s.phone || '')}</td>
        <td data-label="Email">${esc(s.email || '')}</td>
        <td data-label="Products" class="right">${Number(s.product_count) || 0}</td>
        <td data-label="Orders" class="right">${Number(s.order_count) || 0}</td>
        <td data-label="Status">${s.active ? '<span class="badge active">Active</span>' : '<span class="badge archived">Inactive</span>'}</td>
        <td class="right nowrap row-actions-cell">
          ${iconBtn('edit', 'Edit', `data-sk-supplier-edit="${s.id}"`)}
          ${iconBtn('del', 'Delete', `data-sk-supplier-del="${s.id}"`, 'danger')}
        </td>
      </tr>`
      )
      .join('') || '<tr><td colspan="8" class="empty">No suppliers yet. Add the ones you order from, then put each product under its supplier in Stock Levels.</td></tr>';
}

function skSupplierForm(existing) {
  modal(
    existing ? `Edit ${existing.name}` : 'Add a supplier',
    [
      { name: 'name', label: 'Name', value: existing ? existing.name : '', required: true },
      { name: 'contact_name', label: 'Contact (optional)', value: existing ? existing.contact_name || '' : '' },
      { name: 'phone', label: 'Phone', value: existing ? existing.phone || '' : '' },
      { name: 'email', label: 'Email for orders', type: 'email', value: existing ? existing.email || '' : '' },
      { name: 'account_ref', label: 'Your account number with them (optional)', value: existing ? existing.account_ref || '' : '' },
      { name: 'notes', label: 'Notes', value: existing ? existing.notes || '' : '' },
      { name: 'active', label: 'Active', type: 'checkbox', value: existing ? (existing.active ? 1 : 0) : 1 },
    ],
    async (d) => {
      await api(existing ? `/stock/suppliers/${existing.id}` : '/stock/suppliers', {
        method: existing ? 'PUT' : 'POST',
        body: JSON.stringify({ ...d, active: Number(d.active) === 1 }),
      });
    }
  );
}

// ---------------------------------------------------------------------------
// Pack sizes
// ---------------------------------------------------------------------------

async function loadStockPackSizes() {
  skPacks = await api('/stock/pack-sizes');
  $('sk-packs').innerHTML =
    skPacks
      .map(
        (k) => `<tr>
        <td data-label="Pack"><strong>${esc(k.name)}</strong></td>
        <td data-label="Units per pack" class="right">${skQty(k.units)}</td>
        <td class="right nowrap row-actions-cell">
          ${iconBtn('edit', 'Edit', `data-sk-pack-edit="${k.id}"`)}
          ${iconBtn('del', 'Delete', `data-sk-pack-del="${k.id}"`, 'danger')}
        </td>
      </tr>`
      )
      .join('') || '<tr><td colspan="3" class="empty">No pack sizes.</td></tr>';
}

function skPackForm(existing) {
  modal(
    existing ? `Edit ${existing.name}` : 'Add a pack size',
    [
      { name: 'name', label: 'Name (Pack of 24, 11g Keg, 70cl Bottle)', value: existing ? existing.name : '', required: true },
      { name: 'units', label: 'Units in one pack (pints in a keg, cans in a case, measures in a bottle)', type: 'number', value: existing ? skQty(existing.units) : '', required: true },
    ],
    async (d) => {
      await api(existing ? `/stock/pack-sizes/${existing.id}` : '/stock/pack-sizes', {
        method: existing ? 'PUT' : 'POST',
        body: JSON.stringify(d),
      });
    }
  );
}

// ---------------------------------------------------------------------------
// Documents: wastage, adjustments, stock takes, spot checks
// ---------------------------------------------------------------------------

/** Which document is open in which page's editor. Keyed by kind. */
const skOpen = {};
/** The document page on screen, so a click knows which editor it is in. */
let skActiveKind = null;

async function loadStockDocs(kind) {
  const def = SK_DOC[kind];
  const host = $(`sk-docs-${kind}`);
  skActiveKind = kind;
  await skLoadProducts();
  if (skOpen[kind]) return skRenderDocEditor(kind, skOpen[kind]);
  const docs = await api(`/stock/docs?kind=${kind}`);
  skHead(kind, def.title, def.blurb, `
    ${def.counting ? `<button type="button" class="btn ghost" data-sk-count-sheet="${kind}">Download count sheet</button>` : ''}
    <button type="button" class="btn primary" data-sk-doc-new="${kind}">${esc(def.verb)}</button>`);
  host.innerHTML = `
    <div class="card">
      <table class="table table-cards">
        <thead><tr><th>Date</th><th>Status</th><th>By</th><th>Notes</th><th class="right">Lines</th><th class="right">Value</th><th></th></tr></thead>
        <tbody>${
          docs
            .map(
              (d) => `<tr>
              <td data-label="Date" class="nowrap">${esc(skWhen(d.completed_at || d.created_at))}</td>
              <td data-label="Status">${d.status === 'completed' ? '<span class="badge active">Completed</span>' : '<span class="badge due">Draft</span>'}</td>
              <td data-label="By">${esc(d.staff_name || '')}${d.terminal ? `<div class="muted small">${esc(d.terminal)}</div>` : ''}</td>
              <td data-label="Notes">${esc(d.notes || '')}${d.order_id ? `<div class="muted small">Order ${esc(skShort(d.order_id))}</div>` : ''}</td>
              <td data-label="Lines" class="right">${Number(d.line_count) || 0}</td>
              <td data-label="Value" class="right nowrap">${skMoney(d.value_minor)}</td>
              <td class="right nowrap row-actions-cell">
                ${iconBtn(d.status === 'completed' ? 'eye' : 'edit', d.status === 'completed' ? 'View' : 'Edit', `data-sk-doc-open="${d.id}" data-sk-kind="${kind}"`)}
                ${d.status !== 'completed' ? iconBtn('del', 'Delete draft', `data-sk-doc-del="${d.id}" data-sk-kind="${kind}"`, 'danger') : ''}
              </td>
            </tr>`
            )
            .join('') || `<tr><td colspan="7" class="empty">None yet.</td></tr>`
        }</tbody>
      </table>
    </div>`;
}

/** The fixed page head: its words and its buttons, for the state on screen. */
function skHead(kind, title, blurb, actions) {
  $(`sk-title-${kind}`).textContent = title;
  $(`sk-blurb-${kind}`).textContent = blurb;
  $(`sk-actions-${kind}`).innerHTML = actions;
}

/** A fresh draft, in memory until Save draft or Complete. */
function skNewDoc(kind) {
  return { id: null, kind, status: 'draft', notes: '', lines: [] };
}

function skRenderDocEditor(kind, doc) {
  const def = SK_DOC[kind];
  const host = $(`sk-docs-${kind}`);
  const done = doc.status === 'completed';
  const total = doc.lines.reduce((a, l) => {
    const cost = Number(l.unit_cost_minor) || 0;
    const q = def.counting ? Number(l.quantity) - Number(l.expected ?? l.current_stock ?? 0) : Number(l.quantity);
    return a + (kind === 'wastage' ? -1 : 1) * q * cost;
  }, 0);
  skHead(
    kind,
    `${def.title} — ${done ? `completed ${skWhen(doc.completed_at)}` : doc.id ? 'draft' : 'new'}`,
    done ? 'This document has been applied to the stock ledger and cannot be changed. To reverse it, record an adjustment.' : def.blurb,
    `<button type="button" class="btn ghost" data-sk-doc-back="${kind}">${done ? 'Back to the list' : 'Cancel'}</button>
     ${done ? '' : `<button type="button" class="btn ghost" data-sk-doc-save="${kind}">Save draft</button>
     <button type="button" class="btn primary" data-sk-doc-complete="${kind}">Complete</button>`}`
  );
  host.innerHTML = `
    <div class="card rd-card">
      <div class="rr-controls">
        <label>Notes
          <input type="text" id="sk-doc-notes" value="${esc(doc.notes || '')}" ${done ? 'readonly' : ''} placeholder="${def.counting ? 'Sunday count, cellar only…' : 'What happened'}">
        </label>
        ${done ? '' : `<label>Add a product
          <input type="text" id="sk-doc-product" placeholder="Type part of a name, a PLU or a barcode" autocomplete="off">
        </label>`}
      </div>
      ${done ? '' : `<div class="rr-actions">
        <button type="button" class="btn" data-sk-doc-add="${kind}">Add</button>
        <button type="button" class="btn primary" data-sk-doc-pick="${kind}">Choose products…</button>
        ${def.counting ? `<button type="button" class="btn ghost" data-sk-doc-add-all="${kind}">Add all stock items</button>
        <select id="sk-doc-add-dept"><option value="">Add a department…</option>${skDepartments().map((d) => `<option value="${esc(d)}">${esc(d)}</option>`).join('')}</select>
        <select id="sk-doc-add-sub"><option value="">Add a sub-department…</option>${skSubDepartmentOptions()}</select>` : ''}
        <span class="muted small">${doc.lines.length} line${doc.lines.length === 1 ? '' : 's'} · ${kind === 'wastage' ? 'cost' : 'value'} ${skMoney(total)}</span>
      </div>`}
    </div>
    <div class="card">
      <div class="rr-scroll">
        <table class="table" data-no-cards>
          <thead><tr>
            <th>Product</th>
            ${def.counting ? `<th class="right">${done ? 'Expected' : 'System count'}</th>` : ''}
            <th class="right">${esc(def.qty)}</th>
            ${def.counting ? '<th class="right">Difference</th>' : ''}
            ${def.reason ? '<th>Reason</th>' : ''}
            <th class="right">Unit cost</th>
            ${done ? '' : '<th></th>'}
          </tr></thead>
          <tbody id="sk-doc-lines">${
            doc.lines
              .map((l, i) => {
                const p = skProduct(l.pluid) || {};
                const expected = done ? Number(l.expected ?? 0) : Number(p.stock_quantity ?? 0);
                const untracked = !done && p.level === 'untracked';
                const diff = def.counting ? Number(l.quantity) - expected : null;
                return `<tr data-sk-line="${i}">
                  <td><strong>${esc(l.product_name || p.product_name || `PLU ${l.pluid}`)}</strong><div class="muted small">PLU ${l.pluid}${p.pack_name && p.pack_units > 1 ? ` · ${esc(p.pack_name)} = ${skQty(p.pack_units)}` : ''}</div></td>
                  ${def.counting ? `<td class="right nowrap">${untracked ? '<span class="muted small">Not tracked</span>' : skQty(expected)}</td>` : ''}
                  <td class="right">${done ? skQty(l.quantity) : `<input type="number" step="any" class="sk-qty" value="${esc(l.quantity ?? '')}" data-sk-qty="${i}" style="width:7em;text-align:right">`}</td>
                  ${def.counting ? `<td class="right nowrap ${diff < 0 ? 'sk-neg' : diff > 0 ? 'sk-pos' : ''}">${l.quantity === '' || l.quantity === null ? '' : (diff > 0 ? '+' : '') + skQty(diff)}</td>` : ''}
                  ${def.reason ? `<td>${done ? esc(l.reason || '') : `<input type="text" value="${esc(l.reason || '')}" data-sk-reason="${i}" placeholder="Why">`}</td>` : ''}
                  <td class="right nowrap">${skMoney(l.unit_cost_minor ?? p.unit_cost_minor)}</td>
                  ${done ? '' : `<td class="right row-actions-cell">${iconBtn('del', 'Remove', `data-sk-line-del="${i}"`, 'danger')}</td>`}
                </tr>`;
              })
              .join('') || `<tr><td colspan="7" class="muted small">No products on it yet.</td></tr>`
          }</tbody>
        </table>
      </div>
    </div>`;
}

/** Read the editor's inputs back into the open document. */
function skReadDoc(kind) {
  const doc = skOpen[kind];
  if (!doc || doc.status === 'completed') return doc;
  doc.notes = $('sk-doc-notes').value;
  document.querySelectorAll('[data-sk-qty]').forEach((el) => {
    doc.lines[Number(el.dataset.skQty)].quantity = el.value;
  });
  document.querySelectorAll('[data-sk-reason]').forEach((el) => {
    doc.lines[Number(el.dataset.skReason)].reason = el.value;
  });
  return doc;
}

function skAddLine(kind, pluid, quantity = '') {
  const doc = skReadDoc(kind);
  const p = skProduct(pluid);
  if (!p) return toast('No product by that name or PLU.', 'error');
  if (doc.lines.some((l) => Number(l.pluid) === p.pluid)) return toast(`${p.product_name} is already on it.`, 'error');
  doc.lines.push({
    pluid: p.pluid,
    product_name: p.product_name,
    quantity: quantity === '' && SK_DOC[kind].counting && p.level !== 'untracked' ? '' : quantity,
    reason: '',
    unit_cost_minor: p.unit_cost_minor,
  });
  skRenderDocEditor(kind, doc);
}

/** "Bar › Draught" options, grouped by department, for adding a whole sub-department. */
function skSubDepartmentOptions() {
  const byDept = new Map();
  for (const p of skProducts) {
    if (!p.group_name) continue;
    const d = p.department_name || 'Unassigned';
    if (!byDept.has(d)) byDept.set(d, new Set());
    byDept.get(d).add(p.group_name);
  }
  return [...byDept.keys()].sort().map((d) => `<optgroup label="${esc(d)}">${[...byDept.get(d)].sort()
    // "Department||Sub-department": a separator no name uses, and one an HTML
    // attribute keeps as it is (a NUL would come back as U+FFFD and never match).
    .map((g) => `<option value="${esc(`${d}||${g}`)}">${esc(g)}</option>`).join('')}</optgroup>`).join('');
}

/**
 * Put many products on a document at once. Ones already on it are skipped
 * and said so, rather than refused one by one -- adding a sub-department that
 * overlaps what is there should just add what is missing.
 */
function skAddLines(kind, pluids) {
  const doc = skReadDoc(kind);
  let added = 0;
  let already = 0;
  for (const plu of pluids) {
    const p = skProduct(plu);
    if (!p) continue;
    if (doc.lines.some((l) => Number(l.pluid) === p.pluid)) { already += 1; continue; }
    doc.lines.push({ pluid: p.pluid, product_name: p.product_name, quantity: '', reason: '', unit_cost_minor: p.unit_cost_minor });
    added += 1;
  }
  skRenderDocEditor(kind, doc);
  if (added || already) {
    toast(`Added ${added} product${added === 1 ? '' : 's'}${already ? ` · ${already} already on it` : ''}.`);
  }
  return added;
}

/** What a stock take is of: products with a case size, not non-stock, linked or a recipe. */
const skCountable = (p) => p.stock_item;

/**
 * The typed box: one match adds it, several open the chooser already searched,
 * none says so plainly (not "Type a product name or PLU" at somebody who did).
 */
async function skTypedAdd(kind) {
  const box = $('sk-doc-product');
  const typed = box ? box.value : '';
  if (!String(typed).trim()) {
    const chosen = await skPick({ title: `Add to ${SK_DOC[kind].title}`, stockOnly: Boolean(SK_DOC[kind].counting), exclude: skReadDoc(kind).lines.map((l) => l.pluid) });
    if (chosen.length) skAddLines(kind, chosen);
    return;
  }
  const hits = skResolve(typed);
  if (hits.length === 1) {
    skAddLine(kind, hits[0].pluid);
    const again = $('sk-doc-product');
    if (again) { again.value = ''; again.focus(); }
    return;
  }
  if (!hits.length) return toast(`Nothing matches “${String(typed).trim()}”.`, 'error');
  const chosen = await skPick({ title: `Add to ${SK_DOC[kind].title}`, search: typed, exclude: skReadDoc(kind).lines.map((l) => l.pluid) });
  if (chosen.length) skAddLines(kind, chosen);
}

/** The same for a purchase order. */
async function skOrderTypedAdd() {
  const box = $('sk-order-product');
  const typed = box ? box.value : '';
  const o = skReadOrder();
  const on = o.lines.map((l) => l.pluid);
  let chosen = [];
  if (!String(typed).trim()) {
    chosen = await skPick({ title: 'Add to the order', exclude: on });
  } else {
    const hits = skResolve(typed);
    if (hits.length === 1) return skOrderAdd(hits[0].pluid);
    if (!hits.length) return toast(`Nothing matches “${String(typed).trim()}”.`, 'error');
    chosen = await skPick({ title: 'Add to the order', search: typed, exclude: on });
  }
  if (!chosen.length) return;
  const order = skReadOrder();
  for (const plu of chosen) {
    const p = skProduct(plu);
    if (p && !order.lines.some((l) => Number(l.pluid) === p.pluid)) skOrderAddSilently(order, p, '');
  }
  skRenderOrderEditor(order);
}

function skDocPayload(kind) {
  const doc = skReadDoc(kind);
  const lines = [];
  for (const l of doc.lines) {
    const n = Number(l.quantity);
    if (l.quantity === '' || !Number.isFinite(n)) {
      throw new Error(`${l.product_name}: give a ${SK_DOC[kind].counting ? 'count' : 'quantity'}.`);
    }
    lines.push({ pluid: l.pluid, quantity: n, reason: l.reason || null });
  }
  if (!lines.length) throw new Error('Add at least one product.');
  return { kind, notes: doc.notes || null, lines };
}

async function skSaveDoc(kind, { complete } = {}) {
  let payload;
  try {
    payload = skDocPayload(kind);
  } catch (e) {
    return toast(e.message, 'error');
  }
  const doc = skOpen[kind];
  if (complete) {
    const def = SK_DOC[kind];
    const ok = await confirmDialog(
      def.counting
        ? `Set the count of ${payload.lines.length} product${payload.lines.length === 1 ? '' : 's'} to what you typed? The difference is written to the stock ledger.`
        : `Apply this ${kind} to the stock ledger? ${payload.lines.length} product${payload.lines.length === 1 ? '' : 's'} will move.`,
      { title: 'Complete this document?', confirmLabel: 'Complete' }
    );
    if (!ok) return;
  }
  try {
    if (doc.id) {
      await api(`/stock/docs/${doc.id}`, { method: 'PUT', body: JSON.stringify(payload) });
      if (complete) await api(`/stock/docs/${doc.id}/complete`, { method: 'POST' });
    } else {
      const r = await api('/stock/docs', { method: 'POST', body: JSON.stringify({ ...payload, complete: !!complete }) });
      doc.id = r.id;
    }
    toast(complete ? 'Completed and applied to stock.' : 'Draft saved.');
    delete skOpen[kind];
    render();
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ---------------------------------------------------------------------------
// Orders & Deliveries
// ---------------------------------------------------------------------------

let skOrderOpen = null;

const SK_ORDER_STATUS = {
  new: ['New', 'due'],
  sent: ['Sent', 'active'],
  part_delivered: ['Part delivered', 'due'],
  delivered: ['Delivered', 'active'],
  cancelled: ['Cancelled', 'archived'],
};

async function loadStockOrders() {
  const [, suppliers] = await Promise.all([skLoadProducts(), api('/stock/suppliers')]);
  skSuppliers = suppliers;
  if (skOrderOpen) return skRenderOrderEditor(skOrderOpen);
  const orders = await api('/stock/orders');
  skHead(
    'orders',
    'Orders & Deliveries',
    'Raise an order in packs, send it to the supplier, and book it in when it arrives. Booking in adds the units to stock and updates what each product cost.',
    '<button type="button" class="btn primary" id="sk-order-new">New order</button>'
  );
  $('sk-orders-host').innerHTML = `
    <div class="card">
      <table class="table table-cards">
        <thead><tr><th>Raised</th><th>Order</th><th>Supplier</th><th>Status</th><th class="right">Packs</th><th class="right">Value</th><th>By</th><th></th></tr></thead>
        <tbody>${
          orders
            .map((o) => {
              const [label, badge] = SK_ORDER_STATUS[o.status] || [o.status, 'archived'];
              return `<tr>
              <td data-label="Raised" class="nowrap">${esc(skWhen(o.created_at))}</td>
              <td data-label="Order"><strong>${esc(skShort(o.id))}</strong>${o.notes ? `<div class="muted small">${esc(o.notes)}</div>` : ''}</td>
              <td data-label="Supplier">${esc(o.supplier_name || '—')}</td>
              <td data-label="Status"><span class="badge ${badge}">${esc(label)}</span></td>
              <td data-label="Packs" class="right nowrap">${skQty(o.packs_delivered)} / ${skQty(o.packs_ordered)}</td>
              <td data-label="Value" class="right nowrap">${skMoney(o.total_minor)}</td>
              <td data-label="By">${esc(o.staff_name || '')}</td>
              <td class="right nowrap row-actions-cell">
                ${iconBtn('eye', 'Open', `data-sk-order-open="${o.id}"`)}
                ${iconBtn('print', 'PDF', `data-sk-order-pdf="${o.id}"`)}
                ${['new', 'sent', 'part_delivered'].includes(o.status) ? iconBtn('topup', 'Book a delivery', `data-sk-order-deliver="${o.id}"`) : ''}
                ${['new', 'sent'].includes(o.status) ? iconBtn('del', 'Cancel order', `data-sk-order-cancel="${o.id}"`, 'danger') : ''}
              </td>
            </tr>`;
            })
            .join('') || '<tr><td colspan="8" class="empty">No orders yet.</td></tr>'
        }</tbody>
      </table>
    </div>`;
}

function skRenderOrderEditor(order) {
  const editable = !order.id || ['new', 'sent'].includes(order.status);
  const total = order.lines.reduce((a, l) => a + (Number(l.pack_cost_minor) || 0) * (Number(l.packs) || 0), 0);
  const supplier = skSuppliers.find((s) => String(s.id) === String(order.supplier_id));
  skHead(
    'orders',
    `${order.id ? `Order ${skShort(order.id)}` : 'New order'}${order.status ? ` — ${(SK_ORDER_STATUS[order.status] || [order.status])[0]}` : ''}`,
    editable ? 'In packs. The pack price starts from what the product knows and can be changed here.' : 'Deliveries have been booked against this order, so its lines are fixed.',
    `<button type="button" class="btn ghost" id="sk-order-back">${editable ? 'Cancel' : 'Back to the list'}</button>
     ${order.id ? `<button type="button" class="btn ghost" data-sk-order-pdf="${order.id}">PDF</button>` : ''}
     ${editable ? `<button type="button" class="btn ghost" id="sk-order-save">Save</button>
     <button type="button" class="btn primary" id="sk-order-send">Save and send</button>` : ''}
     ${order.id && ['new', 'sent', 'part_delivered'].includes(order.status) ? `<button type="button" class="btn primary" data-sk-order-deliver="${order.id}">Book a delivery</button>` : ''}`
  );
  $('sk-orders-host').innerHTML = `
    <div class="card rd-card">
      <div class="rr-controls">
        <label>Supplier
          <select id="sk-order-supplier" ${editable ? '' : 'disabled'}>
            <option value="">Choose…</option>
            ${skSuppliers.filter((s) => s.active || String(s.id) === String(order.supplier_id)).map((s) => `<option value="${s.id}" ${String(s.id) === String(order.supplier_id) ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
          </select>
        </label>
        <label>Send by
          <select id="sk-order-method" ${editable ? '' : 'disabled'}>
            <option value="email" ${order.send_method !== 'phone' ? 'selected' : ''}>Email</option>
            <option value="phone" ${order.send_method === 'phone' ? 'selected' : ''}>Phone (just mark it sent)</option>
          </select>
        </label>
        <label>Supplier email
          <input type="email" id="sk-order-email" value="${esc(order.supplier_email || (supplier && supplier.email) || '')}" ${editable ? '' : 'readonly'}>
        </label>
        <label>Notes
          <input type="text" id="sk-order-notes" value="${esc(order.notes || '')}" ${editable ? '' : 'readonly'}>
        </label>
        ${editable ? `<label>Add a product
          <input type="text" id="sk-order-product" placeholder="Type part of a name, a PLU or a barcode" autocomplete="off">
        </label>` : ''}
      </div>
      ${editable ? `<div class="rr-actions">
        <button type="button" class="btn" id="sk-order-add">Add</button>
        <button type="button" class="btn primary" id="sk-order-pick">Choose products…</button>
        <button type="button" class="btn ghost" id="sk-order-suggest">Suggest an order</button>
        <button type="button" class="btn ghost" id="sk-order-add-supplier">Add everything from this supplier</button>
        <span class="muted small">${order.lines.length} line${order.lines.length === 1 ? '' : 's'} · ${skMoney(total)}</span>
      </div>` : ''}
    </div>
    <div class="card">
      <div class="rr-scroll">
        <table class="table" data-no-cards>
          <thead><tr><th>Product</th><th>Supplier code</th><th class="right">In stock</th><th class="right">Min / Max</th><th>Pack</th><th class="right">Pack price £</th><th class="right">Packs</th><th class="right">Delivered</th><th class="right">Total</th>${editable ? '<th></th>' : ''}</tr></thead>
          <tbody>${
            order.lines
              .map((l, i) => {
                const p = skProduct(l.pluid) || {};
                return `<tr>
                  <td><strong>${esc(l.product_name || p.product_name || `PLU ${l.pluid}`)}</strong><div class="muted small">PLU ${l.pluid}</div></td>
                  <td>${esc(l.supplier_code || p.supplier_code || '')}</td>
                  <td class="right nowrap">${p.level === 'untracked' || p.level === undefined ? '—' : skQty(p.stock_quantity)}</td>
                  <td class="right nowrap">${p.min_stock != null ? skQty(p.min_stock) : '—'} / ${p.max_stock != null ? skQty(p.max_stock) : '—'}</td>
                  <td>${esc(l.pack_name || p.pack_name || 'Each')} (${skQty(l.pack_units || p.pack_units || 1)})</td>
                  <td class="right">${editable ? `<input type="number" step="0.01" value="${((Number(l.pack_cost_minor) || 0) / 100).toFixed(2)}" data-sk-oprice="${i}" style="width:7em;text-align:right">` : skMoney(l.pack_cost_minor)}</td>
                  <td class="right">${editable ? `<input type="number" step="any" min="0" value="${esc(l.packs ?? '')}" data-sk-opacks="${i}" style="width:6em;text-align:right">` : skQty(l.packs)}</td>
                  <td class="right nowrap">${skQty(l.packs_delivered || 0)}</td>
                  <td class="right nowrap">${skMoney((Number(l.pack_cost_minor) || 0) * (Number(l.packs) || 0))}</td>
                  ${editable ? `<td class="right row-actions-cell">${iconBtn('del', 'Remove', `data-sk-oline-del="${i}"`, 'danger')}</td>` : ''}
                </tr>`;
              })
              .join('') || '<tr><td colspan="10" class="muted small">Nothing on the order yet.</td></tr>'
          }</tbody>
        </table>
      </div>
    </div>`;
}

function skReadOrder() {
  const o = skOrderOpen;
  if (!o) return null;
  const supplierEl = $('sk-order-supplier');
  if (supplierEl && !supplierEl.disabled) {
    o.supplier_id = supplierEl.value || null;
    o.send_method = $('sk-order-method').value;
    o.supplier_email = $('sk-order-email').value;
    o.notes = $('sk-order-notes').value;
  }
  document.querySelectorAll('[data-sk-opacks]').forEach((el) => {
    o.lines[Number(el.dataset.skOpacks)].packs = el.value;
  });
  document.querySelectorAll('[data-sk-oprice]').forEach((el) => {
    o.lines[Number(el.dataset.skOprice)].pack_cost_minor = Math.round(Number(el.value || 0) * 100);
  });
  return o;
}

function skOrderAdd(pluid, packs = '') {
  const o = skReadOrder();
  const p = skProduct(pluid);
  if (!p) return toast('No product by that name or PLU.', 'error');
  if (o.lines.some((l) => Number(l.pluid) === p.pluid)) return toast(`${p.product_name} is already on it.`, 'error');
  o.lines.push({
    pluid: p.pluid,
    product_name: p.product_name,
    supplier_code: p.supplier_code,
    pack_name: p.pack_name || 'Each',
    pack_units: p.pack_units || 1,
    pack_cost_minor: p.pack_cost != null ? Math.round(Number(p.pack_cost) * 100) : (p.unit_cost_minor || 0) * (p.pack_units || 1),
    packs,
    packs_delivered: 0,
  });
  skRenderOrderEditor(o);
}

function skOrderPayload() {
  const o = skReadOrder();
  const lines = [];
  for (const l of o.lines) {
    const n = Number(l.packs);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${l.product_name}: how many packs?`);
    lines.push({ pluid: l.pluid, packs: n, pack_cost: (Number(l.pack_cost_minor) || 0) / 100 });
  }
  if (!lines.length) throw new Error('Add at least one product.');
  return { supplier_id: o.supplier_id || null, send_method: o.send_method, supplier_email: o.supplier_email, notes: o.notes, lines };
}

async function skOrderSave({ send } = {}) {
  let payload;
  try {
    payload = skOrderPayload();
  } catch (e) {
    return toast(e.message, 'error');
  }
  try {
    const o = skOrderOpen;
    if (o.id) {
      await api(`/stock/orders/${o.id}`, { method: 'PUT', body: JSON.stringify(payload) });
    } else {
      const r = await api('/stock/orders', { method: 'POST', body: JSON.stringify(payload) });
      o.id = r.id;
    }
    if (send) {
      const r = await api(`/stock/orders/${o.id}/send`, { method: 'POST' });
      toast(r.mailed ? 'Order emailed to the supplier.' : 'Order marked as sent.');
    } else {
      toast('Order saved.');
    }
    skOrderOpen = null;
    render();
  } catch (e) {
    toast(e.message, 'error');
  }
}

/** Book packs in against an order: a modal with one box per line. */
async function skOrderDeliver(id) {
  const o = await api(`/stock/orders/${id}`);
  const open = o.lines.filter((l) => Number(l.packs_ordered) - Number(l.packs_delivered) > 0);
  if (!open.length) return toast('Everything on this order has been delivered.', 'error');
  modal(
    `Book a delivery — order ${skShort(o.id)}`,
    open.map((l) => ({
      name: `line_${l.id}`,
      label: `${l.product_name} — ${l.pack_name} (${skQty(l.pack_units)} units): packs arrived`,
      type: 'number',
      value: skQty(Number(l.packs_ordered) - Number(l.packs_delivered)),
      hint: `${skQty(l.packs_delivered)} of ${skQty(l.packs_ordered)} already in`,
    })),
    async (d) => {
      const lines = open
        .map((l) => ({ id: l.id, packs: Number(d[`line_${l.id}`] || 0) }))
        .filter((l) => l.packs > 0);
      if (!lines.length) throw new Error('Nothing was delivered.');
      const r = await api(`/stock/orders/${o.id}/deliver`, { method: 'POST', body: JSON.stringify({ lines }) });
      toast(r.order_status === 'delivered' ? 'Delivery booked in; the order is complete.' : 'Delivery booked in; some packs are still to come.');
      skOrderOpen = null;
    }
  );
}

/** Open a PDF that needs the session token: fetch, then show the blob. */
async function skOpenPdf(path, name) {
  // `token` is app.js's session token, the one `api()` sends.
  const res = await fetch(`/api${path}`, { headers: { Authorization: `Bearer ${token || ''}` } });
  if (!res.ok) return toast('The PDF could not be made.', 'error');
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.target = '_blank';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// ---------------------------------------------------------------------------
// Wiring: one listener for every stock page
// ---------------------------------------------------------------------------

document.addEventListener('click', async (e) => {
  const t = e.target.closest('button, a');
  if (!t) return;
  const d = t.dataset;

  // Stock Levels
  if (d.skSettings) return skSettings(d.skSettings);
  if (d.skIn) return skQuickDoc(d.skIn, 'delivery');
  if (d.skCount) return skQuickDoc(d.skCount, 'stocktake');
  if (d.skHistory) return skHistory(d.skHistory);

  // Suppliers
  if (t.id === 'sk-add-supplier') return skSupplierForm(null);
  if (d.skSupplierEdit) return skSupplierForm(skSuppliers.find((s) => String(s.id) === d.skSupplierEdit));
  if (d.skSupplierDel) {
    const s = skSuppliers.find((x) => String(x.id) === d.skSupplierDel);
    if (s && (await confirmDialog(`Delete ${s.name}? Products under it keep their stock but lose the supplier.`, { danger: true, confirmLabel: 'Delete' }))) {
      try {
        await api(`/stock/suppliers/${s.id}`, { method: 'DELETE' });
        render();
      } catch (err) {
        toast(err.message, 'error');
      }
    }
    return;
  }

  // Pack sizes
  if (t.id === 'sk-add-pack') return skPackForm(null);
  if (d.skPackEdit) return skPackForm(skPacks.find((k) => String(k.id) === d.skPackEdit));
  if (d.skPackDel) {
    const k = skPacks.find((x) => String(x.id) === d.skPackDel);
    if (k && (await confirmDialog(`Delete ${k.name}?`, { danger: true, confirmLabel: 'Delete' }))) {
      try {
        await api(`/stock/pack-sizes/${k.id}`, { method: 'DELETE' });
        render();
      } catch (err) {
        toast(err.message, 'error');
      }
    }
    return;
  }

  // Documents
  if (d.skDocNew) {
    skOpen[d.skDocNew] = skNewDoc(d.skDocNew);
    return skRenderDocEditor(d.skDocNew, skOpen[d.skDocNew]);
  }
  if (d.skDocOpen) {
    const doc = await api(`/stock/docs/${d.skDocOpen}`);
    doc.lines = doc.lines.map((l) => ({ ...l, quantity: l.quantity }));
    skOpen[d.skKind] = doc;
    return skRenderDocEditor(d.skKind, doc);
  }
  if (d.skDocDel) {
    if (await confirmDialog('Delete this draft?', { danger: true, confirmLabel: 'Delete' })) {
      try {
        await api(`/stock/docs/${d.skDocDel}`, { method: 'DELETE' });
        render();
      } catch (err) {
        toast(err.message, 'error');
      }
    }
    return;
  }
  if (d.skDocBack) {
    delete skOpen[d.skDocBack];
    return render();
  }
  if (d.skDocSave) return skSaveDoc(d.skDocSave);
  if (d.skDocComplete) return skSaveDoc(d.skDocComplete, { complete: true });
  if (d.skDocAdd) return skTypedAdd(d.skDocAdd);
  if (d.skDocPick) {
    const kind = d.skDocPick;
    const chosen = await skPick({
      title: `Add to ${SK_DOC[kind].title}`,
      stockOnly: Boolean(SK_DOC[kind].counting),
      exclude: skReadDoc(kind).lines.map((l) => l.pluid),
    });
    if (chosen.length) skAddLines(kind, chosen);
    return;
  }
  if (d.skDocAddAll) {
    // Every STOCK ITEM: a case size, and not non-stock, linked or a recipe.
    // It used to be every product with a count, which put the whole catalogue
    // on a stock take ("we don't want all products showing", 2026-09-22).
    const items = skProducts.filter(skCountable);
    if (!items.length) return toast('No stock items yet — give products a case size first (Catalogue → Products, or Stock Levels).', 'error');
    skAddLines(d.skDocAddAll, items.map((p) => p.pluid));
    return;
  }
  if (d.skLineDel !== undefined) {
    const kind = skActiveKind;
    const doc = skReadDoc(kind);
    doc.lines.splice(Number(d.skLineDel), 1);
    return skRenderDocEditor(kind, doc);
  }
  if (d.skCountSheet) {
    return skOpenPdf('/stock/count-sheet.pdf', 'stock-count-sheet.pdf');
  }

  // Orders
  if (t.id === 'sk-order-new') {
    skOrderOpen = { id: null, status: null, supplier_id: '', send_method: 'email', supplier_email: '', notes: '', lines: [] };
    return skRenderOrderEditor(skOrderOpen);
  }
  if (d.skOrderOpen) {
    const o = await api(`/stock/orders/${d.skOrderOpen}`);
    o.lines = o.lines.map((l) => ({ ...l, packs: l.packs_ordered }));
    skOrderOpen = o;
    return skRenderOrderEditor(o);
  }
  if (t.id === 'sk-order-back') {
    skOrderOpen = null;
    return render();
  }
  if (t.id === 'sk-order-save') return skOrderSave();
  if (t.id === 'sk-order-send') return skOrderSave({ send: true });
  if (t.id === 'sk-order-add') return skOrderTypedAdd();
  if (t.id === 'sk-order-pick') {
    const box = $('sk-order-product');
    if (box) box.value = '';
    return skOrderTypedAdd();
  }
  if (t.id === 'sk-order-suggest') {
    const o = skReadOrder();
    const supplier = o.supplier_id ? `?supplier=${encodeURIComponent(o.supplier_id)}` : '';
    const list = await api(`/stock/orders/suggest${supplier}`);
    if (!list.length) return toast(o.supplier_id ? 'Nothing from this supplier is at or under its minimum.' : 'Nothing is at or under its minimum. Set minimums in Stock Levels first.', 'error');
    for (const p of list) {
      if (!o.lines.some((l) => Number(l.pluid) === p.pluid)) skOrderAddSilently(o, p, p.packs);
    }
    skRenderOrderEditor(o);
    return toast(`${list.length} product${list.length === 1 ? '' : 's'} added at the packs needed to reach the maximum.`);
  }
  if (t.id === 'sk-order-add-supplier') {
    const o = skReadOrder();
    if (!o.supplier_id) return toast('Choose a supplier first.', 'error');
    const mine = skProducts.filter((p) => String(p.supplier_id) === String(o.supplier_id));
    if (!mine.length) return toast('No products are under this supplier yet. Set the supplier in Stock Levels › settings.', 'error');
    for (const p of mine) if (!o.lines.some((l) => Number(l.pluid) === p.pluid)) skOrderAddSilently(o, p, '');
    return skRenderOrderEditor(o);
  }
  if (d.skOlineDel !== undefined) {
    const o = skReadOrder();
    o.lines.splice(Number(d.skOlineDel), 1);
    return skRenderOrderEditor(o);
  }
  if (d.skOrderPdf) return skOpenPdf(`/stock/orders/${d.skOrderPdf}/pdf`, `order-${skShort(d.skOrderPdf)}.pdf`);
  if (d.skOrderDeliver) return skOrderDeliver(d.skOrderDeliver);
  if (d.skOrderCancel) {
    if (await confirmDialog('Cancel this order? It is kept in the list as cancelled.', { danger: true, confirmLabel: 'Cancel the order' })) {
      try {
        await api(`/stock/orders/${d.skOrderCancel}`, { method: 'DELETE' });
        render();
      } catch (err) {
        toast(err.message, 'error');
      }
    }
  }
});

function skOrderAddSilently(o, p, packs) {
  o.lines.push({
    pluid: p.pluid,
    product_name: p.product_name,
    supplier_code: p.supplier_code,
    pack_name: p.pack_name || 'Each',
    pack_units: p.pack_units || 1,
    pack_cost_minor: p.pack_cost != null ? Math.round(Number(p.pack_cost) * 100) : (p.unit_cost_minor || 0) * (p.pack_units || 1),
    packs,
    packs_delivered: 0,
  });
}

// Live inputs: the levels filters, the stock take department picker, and a
// count typed into a document (its difference column updates as you type).
document.addEventListener('input', (e) => {
  if (['sk-dept', 'sk-level', 'sk-search'].includes(e.target.id)) return skRenderLevels();
  if (e.target.dataset && e.target.dataset.skQty !== undefined) {
    const kind = skActiveKind;
    if (!kind || !SK_DOC[kind].counting) return;
    const i = Number(e.target.dataset.skQty);
    const row = e.target.closest('tr');
    const doc = skOpen[kind];
    const p = skProduct(doc.lines[i].pluid) || {};
    const expected = doc.status === 'completed' ? Number(doc.lines[i].expected ?? 0) : Number(p.stock_quantity ?? 0);
    const cell = row.children[3];
    if (!cell) return;
    const diff = Number(e.target.value) - expected;
    cell.textContent = e.target.value === '' ? '' : `${diff > 0 ? '+' : ''}${skQty(diff)}`;
    cell.className = `right nowrap ${diff < 0 ? 'sk-neg' : diff > 0 ? 'sk-pos' : ''}`;
  }
});
document.addEventListener('change', (e) => {
  // A whole department, or a whole sub-department, of STOCK ITEMS -- the way
  // Newbridge builds a count, rather than one product at a time.
  if (e.target.id === 'sk-doc-add-dept' && e.target.value) {
    const kind = skActiveKind;
    const items = skProducts.filter((x) => (x.department_name || 'Unassigned') === e.target.value && skCountable(x));
    if (!items.length) return toast(`No stock items in ${e.target.value} — give its products a case size first.`, 'error');
    skAddLines(kind, items.map((p) => p.pluid));
  }
  if (e.target.id === 'sk-doc-add-sub' && e.target.value) {
    const kind = skActiveKind;
    const cut = e.target.value.indexOf('||');
    const dept = e.target.value.slice(0, cut);
    const group = e.target.value.slice(cut + 2);
    const items = skProducts.filter((x) => (x.department_name || 'Unassigned') === dept && x.group_name === group && skCountable(x));
    if (!items.length) return toast(`No stock items in ${group} — give its products a case size first.`, 'error');
    skAddLines(kind, items.map((p) => p.pluid));
  }
});

// Enter in a product box adds it, rather than submitting nothing.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (e.target.id === 'sk-doc-product') {
    e.preventDefault();
    if (skActiveKind) skTypedAdd(skActiveKind);
  }
  if (e.target.id === 'sk-order-product') {
    e.preventDefault();
    skOrderTypedAdd();
  }
});

// ---------------------------------------------------------------------------
// Recipes (2026-09-22): a product made of other products
// ---------------------------------------------------------------------------
//
// "There needs to be a recipe section where you can build recipes for certain
// products like cocktails ... add multiple products and configure the
// quantities for each item." Selling or wasting the product then takes each
// ingredient off by its measure (server: stock_effects.js), and the recipe's
// cost becomes the product's, so its GP is real.

/** The recipe open in the editor, or null for the list. */
let rcOpen = null;

const RC_DEFAULT_BLURB = 'Cocktails and anything else made from other products. Selling or wasting one takes each ingredient off by its measure, and its cost is the recipe’s.';

function rcHead(title, blurb, actions) {
  $('sk-title-recipes').textContent = title;
  $('sk-blurb-recipes').textContent = blurb;
  $('sk-actions-recipes').innerHTML = actions;
}

/** The same sums the server does (stock.js gpFigures), for the live editor. */
function rcGp(price, taxPercentage, costMinor, targetGp) {
  const cost = Number(costMinor) || 0;
  const vat = 1 + (Number(taxPercentage) || 0) / 100;
  const target = targetGp === null || targetGp === undefined || targetGp === '' ? 70 : Number(targetGp);
  if (!cost) return { has_cost: false, target_gp: target };
  const net = Math.round((Number(price) || 0) * 100) / vat;
  const t = Math.min(Math.max(target, 0), 99) / 100;
  return {
    has_cost: true,
    target_gp: target,
    current_gp: net > 0 ? Number((((net - cost) / net) * 100).toFixed(1)) : null,
    recommended_price_minor: Math.ceil(((cost / (1 - t)) * vat) / 5) * 5,
  };
}

async function loadStockRecipes() {
  await skLoadProducts();
  if (rcOpen) return rcRenderEditor();
  const recipes = await api('/stock/recipes');
  rcHead('Recipes', RC_DEFAULT_BLURB, '<button type="button" class="btn primary" data-rc-new>New recipe</button>');
  $('sk-recipes').innerHTML = `
    <div class="card">
      <table class="table table-cards">
        <thead><tr><th>Product</th><th class="right">Ingredients</th><th class="right">Recipe cost</th><th class="right">Price</th><th class="right">GP</th><th></th></tr></thead>
        <tbody>${recipes.map((r) => {
          const g = r.recipe_gp || {};
          const gp = g.current_gp === null || g.current_gp === undefined ? '—' : `${g.current_gp}%`;
          const under = g.has_cost && g.current_gp !== null && g.current_gp < g.target_gp;
          return `<tr>
            <td data-label="Product"><strong>${esc(r.product_name)}</strong><div class="muted small">${esc([r.department_name, r.group_name].filter(Boolean).join(' · '))} · PLU ${r.pluid}</div></td>
            <td data-label="Ingredients" class="right">${Number(r.line_count) || 0}</td>
            <td data-label="Recipe cost" class="right nowrap">${skMoney(r.recipe_cost_minor)}</td>
            <td data-label="Price" class="right nowrap">£${Number(r.price || 0).toFixed(2)}</td>
            <td data-label="GP" class="right nowrap ${under ? 'sk-neg' : ''}" title="Target ${esc(String(g.target_gp ?? 70))}%">${gp}${under ? `<div class="muted small">target ${g.target_gp}% → ${skMoney(g.recommended_price_minor)}</div>` : ''}</td>
            <td class="right nowrap row-actions-cell">
              ${iconBtn('edit', 'Edit recipe', `data-rc-edit="${r.pluid}"`)}
              ${iconBtn('del', 'Delete recipe', `data-rc-remove="${r.pluid}"`, 'danger')}
            </td>
          </tr>`;
        }).join('') || '<tr><td colspan="6" class="empty">No recipes yet. Press “New recipe”, choose the cocktail, then add what it is made of.</td></tr>'}</tbody>
      </table>
    </div>`;
}

async function rcOpenFor(pluid) {
  const r = await api(`/stock/recipes/${pluid}`);
  rcOpen = { product: r.product, lines: r.lines.map((l) => ({ ...l })) };
  rcRenderEditor();
}

/** Read the measures typed into the editor back onto the open recipe. */
function rcRead() {
  document.querySelectorAll('[data-rc-qty]').forEach((el) => {
    const line = rcOpen.lines[Number(el.dataset.rcQty)];
    if (line) line.quantity = el.value;
  });
}

function rcTotals() {
  const cost = rcOpen.lines.reduce((a, l) => a + Math.round((Number(l.unit_cost_minor) || 0) * (Number(l.quantity) || 0)), 0);
  const p = rcOpen.product;
  return { cost, gp: rcGp(p.price, p.tax_percentage, cost, p.target_gp) };
}

function rcTotalsHtml() {
  const { cost, gp } = rcTotals();
  const p = rcOpen.product;
  const now = gp.has_cost && gp.current_gp !== null ? `${gp.current_gp}%` : '—';
  return `
    <div class="rr-controls" style="gap:24px;flex-wrap:wrap">
      <div><div class="muted small">Recipe cost</div><strong style="font-size:1.25rem">${skMoney(cost)}</strong></div>
      <div><div class="muted small">Selling price</div><strong style="font-size:1.25rem">£${Number(p.price || 0).toFixed(2)}</strong></div>
      <div><div class="muted small">GP now</div><strong style="font-size:1.25rem" class="${gp.has_cost && gp.current_gp < gp.target_gp ? 'sk-neg' : ''}">${now}</strong></div>
      <div><div class="muted small">At a ${esc(String(gp.target_gp))}% target, charge</div><strong style="font-size:1.25rem">${gp.has_cost ? skMoney(gp.recommended_price_minor) : '—'}</strong></div>
    </div>
    <p class="muted small" style="margin:.4rem 0 0">Prices include VAT. Change the selling price or the target GP on the product (Catalogue → Products, or its Stock info).</p>`;
}

function rcRenderEditor() {
  const r = rcOpen;
  const p = r.product;
  rcHead(
    `Recipe — ${p.product_name}`,
    'Add what one of these is made of, and how much of each. Measures are in each ingredient’s own units — the ones its stock is counted in.',
    `<button type="button" class="btn ghost" data-rc-back>Back to recipes</button>
     <button type="button" class="btn primary" data-rc-save>Save recipe</button>`
  );
  $('sk-recipes').innerHTML = `
    <div class="card rd-card">
      <div class="rr-actions">
        <button type="button" class="btn primary" data-rc-add>Add ingredients…</button>
        <span class="muted small">${r.lines.length} ingredient${r.lines.length === 1 ? '' : 's'}</span>
      </div>
    </div>
    <div class="card">
      <div class="rr-scroll">
        <table class="table" data-no-cards>
          <thead><tr><th>Ingredient</th><th class="right">Measure</th><th class="right">Unit cost</th><th class="right">Cost</th><th></th></tr></thead>
          <tbody>${r.lines.map((l, i) => `<tr>
            <td><strong>${esc(l.product_name)}</strong><div class="muted small">PLU ${l.pluid}${l.pack_name && l.pack_units > 1 ? ` · ${esc(l.pack_name)} = ${skQty(l.pack_units)} ${esc(l.stock_unit || 'units')}` : ''}${l.missing ? ' · <span class="sk-neg">no longer in the catalogue</span>' : ''}</div></td>
            <td class="right nowrap"><input type="number" step="any" min="0" value="${esc(String(l.quantity ?? ''))}" data-rc-qty="${i}" style="width:7em;text-align:right"> <span class="muted small">${esc(l.stock_unit || 'units')}</span></td>
            <td class="right nowrap">${skMoney(l.unit_cost_minor)}</td>
            <td class="right nowrap" data-rc-line-cost="${i}">${skMoney(Math.round((Number(l.unit_cost_minor) || 0) * (Number(l.quantity) || 0)))}</td>
            <td class="right row-actions-cell">${iconBtn('del', 'Remove', `data-rc-del="${i}"`, 'danger')}</td>
          </tr>`).join('') || '<tr><td colspan="5" class="muted small">No ingredients yet — press “Add ingredients…”.</td></tr>'}</tbody>
        </table>
      </div>
    </div>
    <div class="card rd-card" data-rc-totals>${rcTotalsHtml()}</div>`;
}

document.addEventListener('click', async (e) => {
  const t = e.target.closest('button, a');
  if (!t) return;
  const d = t.dataset;
  try {
    if (d.rcNew !== undefined) {
      const [plu] = await skPick({ title: 'Which product is this a recipe for?', single: true });
      if (plu) await rcOpenFor(plu);
      return;
    }
    if (d.rcEdit) return rcOpenFor(Number(d.rcEdit));
    if (d.rcRemove) {
      const p = skProduct(d.rcRemove);
      if (await confirmDialog(`Delete the recipe for ${p ? p.product_name : `PLU ${d.rcRemove}`}? Selling it will no longer take its ingredients off.`, { danger: true, confirmLabel: 'Delete' })) {
        await api(`/stock/recipes/${d.rcRemove}`, { method: 'DELETE' });
        toast('Recipe deleted.');
        render();
      }
      return;
    }
    if (d.rcBack !== undefined) { rcOpen = null; return render(); }
    if (!rcOpen) return;
    if (d.rcAdd !== undefined) {
      rcRead();
      const chosen = await skPick({
        title: `Add ingredients to ${rcOpen.product.product_name}`,
        exclude: [rcOpen.product.pluid, ...rcOpen.lines.map((l) => l.pluid)],
        okLabel: 'Add',
      });
      for (const plu of chosen) {
        const p = skProduct(plu);
        if (!p) continue;
        rcOpen.lines.push({
          pluid: p.pluid, product_name: p.product_name, stock_unit: p.stock_unit,
          pack_name: p.pack_name, pack_units: p.pack_units, quantity: '', unit_cost_minor: p.unit_cost_minor,
        });
      }
      return rcRenderEditor();
    }
    if (d.rcDel !== undefined) {
      rcRead();
      rcOpen.lines.splice(Number(d.rcDel), 1);
      return rcRenderEditor();
    }
    if (d.rcSave !== undefined) {
      rcRead();
      const lines = [];
      for (const l of rcOpen.lines) {
        const q = Number(l.quantity);
        if (l.quantity === '' || !Number.isFinite(q) || q <= 0) throw new Error(`${l.product_name}: give a measure above nothing.`);
        lines.push({ pluid: l.pluid, quantity: q });
      }
      if (!lines.length) throw new Error('Add at least one ingredient — or go back and delete the recipe.');
      const saved = await api(`/stock/recipes/${rcOpen.product.pluid}`, { method: 'PUT', body: JSON.stringify({ lines }) });
      toast(`Recipe saved. ${rcOpen.product.product_name} now costs ${skMoney(saved.cost_minor)} to make.`);
      rcOpen = null;
      return render();
    }
  } catch (err) {
    toast(err.message, 'error');
  }
});

// A measure typed changes the line's cost and the totals as it is typed.
document.addEventListener('input', (e) => {
  if (!rcOpen || !e.target.dataset || e.target.dataset.rcQty === undefined) return;
  const i = Number(e.target.dataset.rcQty);
  const line = rcOpen.lines[i];
  if (!line) return;
  line.quantity = e.target.value;
  const cell = document.querySelector(`[data-rc-line-cost="${i}"]`);
  if (cell) cell.textContent = skMoney(Math.round((Number(line.unit_cost_minor) || 0) * (Number(line.quantity) || 0)));
  const totals = document.querySelector('[data-rc-totals]');
  if (totals) totals.innerHTML = rcTotalsHtml();
});
