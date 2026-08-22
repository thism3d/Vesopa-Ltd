const $ = (id) => document.getElementById(id);
const money = (minor) =>
  new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' })
    .format((Number(minor) || 0) / 100);
const time = (iso) =>
  iso ? new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '—';
const date = (iso) =>
  iso ? new Date(iso).toLocaleDateString('en-GB') : '—';

// User-supplied text is injected as HTML, so it must be escaped or a product
// named `<img onerror=…>` would execute.
const esc = (s) => {
  const d = document.createElement('div');
  d.textContent = s ?? '';
  return d.innerHTML;
};

// ---- Session --------------------------------------------------------------
//
// "Keep me signed in" decides which store the session lives in. sessionStorage
// dies with the tab, so an unticked sign-in on a shared back-office machine is
// gone when the browser closes; localStorage survives, and the server issues a
// correspondingly longer token so the two halves agree.
const SESSION_KEYS = { token: 'vesopa_token', user: 'vesopa_user' };

const readSession = (key) =>
  localStorage.getItem(key) ?? sessionStorage.getItem(key);

function saveSession(remember) {
  const store = remember ? localStorage : sessionStorage;
  const other = remember ? sessionStorage : localStorage;
  // Clear the store we are not using, or an earlier choice would linger and
  // outlive this one.
  other.removeItem(SESSION_KEYS.token);
  other.removeItem(SESSION_KEYS.user);
  store.setItem(SESSION_KEYS.token, token);
  store.setItem(SESSION_KEYS.user, JSON.stringify(me));
}

function clearSession() {
  for (const store of [localStorage, sessionStorage]) {
    store.removeItem(SESSION_KEYS.token);
    store.removeItem(SESSION_KEYS.user);
  }
}

let token = readSession(SESSION_KEYS.token);
let me = JSON.parse(readSession(SESSION_KEYS.user) || 'null');
let socket = null;
let currentView = 'dashboard';

// ---- API ------------------------------------------------------------------

async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });

  // An expired session drops back to sign-in rather than silently rendering
  // empty tables.
  if (res.status === 401) { signOut(); throw new Error('Session expired'); }
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.status === 204 ? null : res.json();
}

// ---- Realtime -------------------------------------------------------------

/**
 * The back office runs on the same socket as the tills. A sale rung up on the
 * floor lands here without a refresh; a price changed here is pushed to every
 * till immediately.
 */
function connectSocket() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  socket = new WebSocket(`${proto}://${location.host}/ws`);

  socket.onopen = () => {
    setLive(true);
    // Which venue this browser is watching. Only office-scoped pushes need it,
    // and only kitchen tickets are office-scoped today — without it the live
    // board would sit there polling while every other panel updated instantly.
    //
    // Not a credential, and not treated as one: what arrives over the socket is
    // a nudge carrying an id, and the board itself is fetched over HTTP with
    // this session's token deciding what may be read.
    // `officeEmail` is the tenant key the API scopes by; `email` is the
    // informal one every older row is keyed on, and what tenantEmail() falls
    // back to server side. A session stored before offices existed has only
    // the second, so both are tried.
    const office = me && (me.officeEmail || me.email);
    if (office) socket.send(JSON.stringify({ type: 'subscribe', office }));
  };
  socket.onerror = () => setLive(false);
  socket.onclose = () => {
    setLive(false);
    // A dashboard that quietly stops updating is worse than one that admits it
    // is offline — so reconnect, and say so meanwhile.
    setTimeout(() => { if (token) connectSocket(); }, 3000);
  };

  socket.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'order.created') onNewSale(msg);
    if (msg.type === 'catalogue.updated' && ['products', 'stock'].includes(currentView)) render();
    if (msg.type === 'staff.updated' && currentView === 'staff') render();
    if (msg.type === 'users.updated' && currentView === 'users') render();
    if (msg.type === 'customers.updated' && currentView === 'customers') render();
    if (msg.type === 'offices.updated' && ['offices', 'billing'].includes(currentView)) render();
    if (msg.type === 'programming.updated') render();
    // The kitchen monitor polls, but a ticket firing while a manager is
    // watching should appear when it fires rather than up to ten seconds
    // later — that gap is exactly the one that makes somebody think the
    // screen is not working.
    if (msg.type === 'kitchen.ticket' && currentView === 'kitchen') {
      refreshKitchenBoard();
    }
    // Do NOT reload the plan mid-edit: it would throw away the manager's
    // unsaved drag work.
    if (msg.type === 'floor.updated' && currentView === 'tables' && !dirty) loadFloor();
  };
}

function setLive(on) {
  $('live-dot').className = `dot ${on ? 'online' : 'offline'}`;
  $('live-text').textContent = on ? 'Live' : 'Offline';
  $('live-text').style.color = on ? '#35d07f' : '';
  // The mobile top bar carries the same indicator, because the rail it normally
  // lives in is off-canvas there.
  const mobileDot = $('live-dot-m');
  if (mobileDot) mobileDot.className = `dot ${on ? 'online' : 'offline'}`;
}

// ---- Mobile navigation drawer ---------------------------------------------

/**
 * Below 960px the rail is a drawer over the page. Everything that dismisses it
 * routes through here so the button's aria-expanded and the scrim can never
 * disagree with what is on screen.
 */
function setRailOpen(open) {
  const app = $('app');
  if (!app) return;
  app.classList.toggle('rail-open', open);
  $('rail-scrim').hidden = !open;
  $('rail-toggle').setAttribute('aria-expanded', String(open));
  $('rail-toggle').setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
  // Stop the page behind the drawer from scrolling under it.
  document.body.style.overflow = open ? 'hidden' : '';
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') setRailOpen(false);
});

// Growing past the breakpoint puts the rail back in the layout; leaving the
// open class on would then also leave the scrim covering the page.
window.addEventListener('resize', () => {
  if (window.innerWidth > 960) setRailOpen(false);
});

function onNewSale(msg) {
  if (currentView !== 'dashboard') return;

  // Re-read the totals from the server rather than incrementing locally: two
  // tills can settle at once and a client-side counter would drift.
  loadDashboard();

  const tr = document.createElement('tr');
  tr.className = 'new';
  tr.innerHTML = `<td>${time(new Date().toISOString())}</td>
    <td>${msg.tableNumber ?? '—'}</td>
    <td class="muted small">${esc(String(msg.id).slice(0, 8))}</td>
    <td class="right">${money(msg.totalMinor)}</td>`;
  $('recent').prepend(tr);
}

// ---- Bars -----------------------------------------------------------------

/** A proportional bar list — a chart, without shipping a charting library. */
function bars(el, rows, color) {
  if (!rows?.length) {
    el.innerHTML = '<p class="muted small">No data yet.</p>';
    return;
  }
  const max = Math.max(...rows.map((r) => Number(r.amount_minor) || 0), 1);
  el.innerHTML = rows
    .map((r) => {
      const pct = Math.round(((Number(r.amount_minor) || 0) / max) * 100);
      return `<div class="bar-row">
        <span class="small">${esc(r.label)}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${pct}%${color ? `;background:${color}` : ''}"></span></span>
        <span class="amount">${money(r.amount_minor)}</span>
      </div>`;
    })
    .join('');
}

// ---- Views ----------------------------------------------------------------

/**
 * Every section gets its own URL (/products, /reports/till, …) so the address
 * bar reflects where you are, the back button works, and a page can be
 * bookmarked or shared. Without this the whole back office sat on "/".
 */
const ROUTES = {
  dashboard: '/dashboard',
  report: '/report',
  sales_explorer: '/sales-explorer',
  till_report: '/till-report',
  bill_report: '/bill-report',
  products: '/products',
  stock: '/stock',
  program_departments: '/program-departments',
  program_groups: '/program-groups',
  mix_match: '/mix-match',
  finalise_keys: '/finalise-keys',
  error_reasons: '/error-reasons',
  tax: '/tax',
  idle: '/idle-screen',
  kitchen: '/kitchen-screens',
  tables: '/tables',
  users: '/users',
  staff: '/staff',
  customers: '/customers',
  vouchers: '/vouchers',
  receipt_designer: '/receipt-designer',
  promotions: '/promotions',
  gift_cards: '/gift-cards',
  deposits: '/deposits',
  loyalty: '/loyalty',
  tender: '/tender',
  rules: '/rules',
  templates: '/templates',
  subscriptions: '/subscriptions',
  offices: '/offices',
  billing: '/billing',
};

const viewForPath = (path) =>
  Object.keys(ROUTES).find((v) => ROUTES[v] === path) || 'dashboard';

function show(view, { push = true } = {}) {
  if (!$(`view-${view}`)) view = 'dashboard';

  currentView = view;
  document.querySelectorAll('.view').forEach((v) => (v.hidden = true));
  $(`view-${view}`).hidden = false;
  document.querySelectorAll('.nav').forEach((b) =>
    b.classList.toggle('active', b.dataset.view === view)
  );

  const path = ROUTES[view] || '/dashboard';
  if (push && location.pathname !== path) {
    history.pushState({ view }, '', path);
  }
  document.title = `Vesopa EPOS — ${view.replace(/_/g, ' ')}`;

  render();
}

// The browser's back and forward buttons drive the view, rather than leaving
// the page and losing the session.
window.addEventListener('popstate', () => {
  if (token) show(viewForPath(location.pathname), { push: false });
});

// ---- Collapsible nav groups ----------------------------------------------

/** The nav buttons that belong to a group heading: everything up to the next
    heading (or the end of that group's container). */
function navItemsFor(heading) {
  const items = [];
  let el = heading.nextElementSibling;
  while (el && !el.classList.contains('nav-group')) {
    if (el.classList.contains('nav')) items.push(el);
    el = el.nextElementSibling;
  }
  return items;
}

function applyGroupState(heading, collapsed) {
  heading.classList.toggle('collapsed', collapsed);
  navItemsFor(heading).forEach((n) => n.classList.toggle('hidden-by-group', collapsed));
  const open = JSON.parse(localStorage.getItem('vesopa_nav_open') || '{}');
  open[heading.dataset.group] = !collapsed;
  localStorage.setItem('vesopa_nav_open', JSON.stringify(open));
}

function toggleGroup(heading) {
  applyGroupState(heading, !heading.classList.contains('collapsed'));
}

/**
 * Set the initial fold state. Bigger sections start minimised so the rail is
 * short and scannable; the operator's own choices (saved above) win over the
 * defaults, and whichever group holds the current view is always opened.
 */
function initNavGroups() {
  const defaultCollapsed = ['programming', 'people', 'administration'];
  const saved = JSON.parse(localStorage.getItem('vesopa_nav_open') || '{}');

  document.querySelectorAll('.nav-group').forEach((heading) => {
    const g = heading.dataset.group;
    let collapsed = g in saved ? !saved[g] : defaultCollapsed.includes(g);
    // Never hide the section the user is currently looking at.
    if (navItemsFor(heading).some((n) => n.dataset.view === currentView)) {
      collapsed = false;
    }
    applyGroupState(heading, collapsed);
  });
}

/**
 * Programming screens are all the same shape: a draggable table, an add button,
 * inline edit and delete.
 *
 * Each field carries its own type so the modal renders a real control (number,
 * date, checkbox, select) rather than a bare text box, and so an edit form can
 * be prefilled from the row. `render` optionally formats a value for the table
 * cell (e.g. pence → £, 1/0 → Yes/No).
 */
const yesNo = (v) => (Number(v) ? 'Yes' : '—');

const CRUD = {
  departments: {
    path: 'departments', title: 'department', sortable: true,
    fields: [
      { name: 'department_name', label: 'Department', required: true },
      { name: 'group_name', label: 'Group' },
      { name: 'accounting_code', label: 'Accounting code' },
      // The category button on the till, rendered square there — so unlike a
      // product's picture this one keeps the cropper's default square crop.
      { name: 'image_url', label: 'Button image', type: 'image' },
      { name: 'emoji', label: 'Emoji (used when there is no image)' },
      { name: 'button_color', label: 'Button colour', type: 'color' },
    ],
  },
  groups: {
    path: 'groups', title: 'group', sortable: true,
    fields: [
      { name: 'group_name', label: 'Group', required: true },
      { name: 'accounting_code', label: 'Accounting code' },
    ],
  },
  'mix-match': {
    path: 'mix-match', title: 'deal', sortable: true,
    fields: [
      { name: 'name', label: 'Deal name', required: true },
      { name: 'trigger_qty', label: 'Trigger quantity', type: 'number' },
      { name: 'deal_price_minor', label: 'Deal price (£)', type: 'money' },
      { name: 'active', label: 'Active', type: 'checkbox', render: yesNo },
    ],
  },
  'finalise-keys': {
    path: 'finalise-keys', title: 'finalise key', sortable: true,
    fields: [
      { name: 'name', label: 'Name', required: true },
      { name: 'kind', label: 'Kind', type: 'select', options: ['cash', 'card', 'voucher', 'other'] },
      { name: 'opens_drawer', label: 'Opens drawer', type: 'checkbox', render: yesNo },
    ],
  },
  'error-reasons': {
    path: 'error-reasons', title: 'error reason', sortable: true,
    fields: [
      { name: 'reason', label: 'Reason', required: true },
      { name: 'applies_to', label: 'Applies to', type: 'select', options: ['void', 'refund', 'discount'] },
    ],
  },
  tax: {
    path: 'tax', title: 'tax rate', sortable: true,
    fields: [
      { name: 'name', label: 'Name', required: true },
      { name: 'percentage', label: 'Percentage', type: 'number' },
      { name: 'is_default', label: 'Default', type: 'checkbox', render: yesNo },
    ],
  },
  vouchers: {
    path: 'vouchers', title: 'voucher', sortable: true,
    fields: [
      { name: 'code', label: 'Code', required: true },
      { name: 'name', label: 'Name' },
      { name: 'discount_type', label: 'Discount type', type: 'select', options: ['percent', 'amount'] },
      // `value` means one of two things depending on the type above, and the
      // old "(% or £)" label was wrong for half of them: an amount voucher is
      // stored in PENCE, so "5" there is 5p off, not £5. Spelling it out beats
      // a silent order-of-magnitude error on every amount voucher issued.
      { name: 'value', label: 'Value — whole percent, or PENCE for an amount (£5 = 500)', type: 'number' },
      { name: 'expires_on', label: 'Expires', type: 'date', render: (v) => (v ? date(v) : '—') },
      { name: 'starts_on', label: 'Valid from', type: 'date', hideInTable: true },
      { name: 'min_spend_minor', label: 'Minimum spend (pence, 0 = none)', type: 'number', hideInTable: true },
      { name: 'reusable', label: 'Can be used more than once', type: 'checkbox', hideInTable: true },
      { name: 'max_uses', label: 'Maximum uses (0 = unlimited)', type: 'number', hideInTable: true },
      { name: 'free_product_pluid', label: 'Free product PLU (optional)', type: 'number', nullable: true, hideInTable: true },
      // Visual editor: how the voucher key looks on the till.
      { name: 'button_label', label: 'Button label (blank = name)', hideInTable: true },
      { name: 'button_colour', label: 'Button colour', type: 'color', hideInTable: true },
      { name: 'button_size', label: 'Button size', type: 'select',
        options: ['small', 'medium', 'large'], hideInTable: true },
      { name: 'icon', label: 'Icon (emoji)', hideInTable: true },
      { name: 'active', label: 'Active', type: 'checkbox', render: yesNo },
    ],
  },
};

/** How a field's stored value is shown in a table cell. */
function cellText(field, value) {
  if (field.render) return field.render(value);
  if (field.type === 'money') return money(value);
  // Show a picture as a picture and a colour as a swatch. A raw URL in a table
  // cell is unreadable and stretches the column past everything beside it.
  if (field.type === 'image') {
    return value ? `<img class="thumb" src="${esc(value)}" alt="" />` : '—';
  }
  if (field.type === 'color') {
    return value
      ? `<span class="swatch" style="background:${esc(value)}"></span>${esc(value)}`
      : '—';
  }
  return esc(String(value ?? '—'));
}

async function loadCrud(key) {
  const cfg = CRUD[key];
  const rows = await api(`/${cfg.path}`);
  const body = $(key);
  if (!body) return;

  // Some fields exist only to be edited (the voucher button styling, say) and
  // would make the table unreadable if every one got a column.
  const columns = cfg.fields.filter((f) => !f.hideInTable);
  const span = columns.length + 1 + (cfg.sortable ? 1 : 0);
  body.innerHTML = rows
    .map(
      (r) => `<tr data-row-id="${r.id}">
        ${cfg.sortable ? '<td class="drag-cell"><span class="drag-handle" title="Drag to reorder">⋮⋮</span></td>' : ''}
        ${columns.map((f) => `<td>${cellText(f, r[f.name])}</td>`).join('')}
        <td class="right nowrap">
          <button class="btn small ghost" data-edit="${key}" data-id="${r.id}">Edit</button>
          <button class="btn small danger" data-del="${cfg.path}" data-id="${r.id}">Delete</button>
        </td>
      </tr>`
    )
    .join('') ||
    `<tr><td colspan="${span}" class="empty">Nothing yet.</td></tr>`;

  if (cfg.sortable) makeSortable(body, cfg.path);
}

/**
 * Build the modal fields for a CRUD row, prefilled from `row` on edit.
 * Money fields store pence but edit in pounds, so they convert both ways.
 */
function crudModalFields(cfg, row = {}) {
  return cfg.fields.map((f) => {
    let value = row[f.name];
    if (f.type === 'money' && value != null) value = (Number(value) / 100).toFixed(2);
    if (f.type === 'checkbox') value = Number(value) ? 1 : 0;
    if (f.type === 'date' && value) value = String(value).slice(0, 10);
    return { ...f, value: value ?? (f.type === 'checkbox' ? 0 : '') };
  });
}

/** Turn modal form data back into the API's expected shape (pence, 1/0). */
function crudPayload(cfg, data) {
  const out = { ...data };
  for (const f of cfg.fields) {
    if (f.type === 'money') out[f.name] = Math.round(parseFloat(out[f.name] || '0') * 100);
    if (f.type === 'checkbox') out[f.name] = out[f.name] ? 1 : 0;
    // A blank number means "none", which for a NOT NULL DEFAULT 0 column is 0,
    // not NULL — MySQL rejects NULL there under strict mode, so leaving
    // "minimum spend" empty would fail the entire save with a 500. Columns that
    // are genuinely nullable opt in with `nullable: true`.
    if (f.type === 'number') {
      out[f.name] = out[f.name] === ''
        ? (f.nullable ? null : 0)
        : Number(out[f.name]);
    }
  }
  return out;
}

/**
 * Make a table body's rows drag-reorderable by their handle, then persist the
 * new order to `/{path}/reorder` on drop.
 *
 * Built on the native HTML5 drag API rather than a library — the whole back
 * office ships as three plain files with no build step, and pulling in a
 * sortable dependency would break that. The row being dragged is tracked in a
 * closure; on drop we read the DOM's row order and send just the id list.
 */
function makeSortable(tbody, path) {
  let dragging = null;

  tbody.querySelectorAll('tr[data-row-id]').forEach((tr) => {
    const handle = tr.querySelector('.drag-handle');
    if (!handle) return;

    // Only the handle starts a drag, so selecting text in a cell still works.
    handle.addEventListener('mousedown', () => (tr.draggable = true));
    tr.addEventListener('mouseup', () => (tr.draggable = false));

    tr.addEventListener('dragstart', (e) => {
      dragging = tr;
      tr.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });

    tr.addEventListener('dragend', async () => {
      tr.classList.remove('dragging');
      tr.draggable = false;
      dragging = null;
      // The order the rows now sit in is the order to save.
      const order = [...tbody.querySelectorAll('tr[data-row-id]')].map(
        (r) => Number(r.dataset.rowId)
      );
      try {
        await api(`/${path}/reorder`, {
          method: 'PUT',
          body: JSON.stringify({ order }),
        });
      } catch (err) {
        alert(err.message);
        render();
      }
    });

    tr.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (!dragging || dragging === tr) return;
      const rect = tr.getBoundingClientRect();
      // Insert above or below the row under the cursor depending on which half
      // it is over, so the drop lands where the manager is aiming.
      const after = e.clientY - rect.top > rect.height / 2;
      tbody.insertBefore(dragging, after ? tr.nextSibling : tr);
    });
  });
}

function render() {
  if (CRUD[currentView.replace('program_', '').replace('_', '-')]) {
    // handled below by the map
  }

  const load = {
    dashboard: loadDashboard,
    report: loadReports,
    sales_explorer: loadExplorer,
    till_report: loadTillReport,
    bill_report: loadBillReport,
    products: loadProducts,
    stock: loadStock,
    users: loadUsers,
    staff: loadStaff,
    customers: loadCustomers,
    offices: loadOffices,
    billing: loadBilling,
    tables: loadFloor,
    program_departments: () => loadCrud('departments'),
    program_groups: () => loadCrud('groups'),
    mix_match: () => loadCrud('mix-match'),
    finalise_keys: () => loadCrud('finalise-keys'),
    error_reasons: () => loadCrud('error-reasons'),
    tax: () => loadCrud('tax'),
    idle: loadIdle,
    kitchen: loadKitchen,
    vouchers: () => loadCrud('vouchers'),
    receipt_designer: loadReceiptDesigner,
    promotions: loadPromotions,
    gift_cards: loadGiftCards,
    deposits: loadDeposits,
    loyalty: loadLoyalty,
    tender: loadTender,
    rules: loadRules,
    templates: loadTemplates,
    subscriptions: loadSubscriptions,
  }[currentView];

  if (load) Promise.resolve(load()).catch((e) => console.error(e));
}

// ---- New reports ----------------------------------------------------------

async function loadExplorer() {
  const params = new URLSearchParams();
  if ($('ex-from').value) params.set('from', $('ex-from').value);
  if ($('ex-to').value) params.set('to', $('ex-to').value);
  if ($('ex-dept').value) params.set('department', $('ex-dept').value);

  const rows = await api(`/sales-explorer?${params}`);
  $('explorer').innerHTML = rows
    .map(
      (r) => `<tr class="clickable" data-receipt="${esc(r.id)}">
        <td>${date(r.closed_at)} ${time(r.closed_at)}</td>
        <td>${esc(r.name)}</td>
        <td>${esc(r.department)}</td>
        <td class="right">${r.quantity}</td>
        <td class="right">${money(r.line_total_minor)}</td>
      </tr>`
    )
    .join('') || '<tr><td colspan="5" class="empty">No matching sales.</td></tr>';
}

async function loadTillReport() {
  const rows = await api('/till-report');
  $('tillreport').innerHTML = rows
    .map(
      (r) => `<tr>
        <td>${date(r.day)}</td>
        <td class="right">${r.orders}</td>
        <td class="right">${money(r.discount_minor)}</td>
        <td class="right">${money(r.tax_minor)}</td>
        <td class="right"><strong>${money(r.gross_minor)}</strong></td>
      </tr>`
    )
    .join('') || '<tr><td colspan="5" class="empty">No trading days yet.</td></tr>';
}

async function loadBillReport() {
  const rows = await api('/bill-report');
  $('billreport').innerHTML = rows
    .map(
      (r) => `<tr class="clickable" data-receipt="${esc(r.id)}">
        <td>${date(r.closed_at)} ${time(r.closed_at)}</td>
        <td class="muted small">${esc(String(r.id).slice(0, 8))}</td>
        <td>${r.table_number ?? '—'}</td>
        <td>${r.covers ?? '—'}</td>
        <td>${esc(r.methods || '—')}</td>
        <td class="right">${money(r.total_minor)}</td>
      </tr>`
    )
    .join('') || '<tr><td colspan="6" class="empty">No bills.</td></tr>';
}

async function loadDashboard() {
  // The analytics strip and charts come from the aggregate endpoint; the live
  // sales table below still comes from /live, which is what the WebSocket
  // prepends to as sales land.
  loadDashboardAnalytics();

  const d = await api('/live');

  $('recent').innerHTML = (d.recent || [])
    .map(
      (o) => `<tr>
        <td>${time(o.closed_at)}</td>
        <td>${o.table_number ?? '—'}</td>
        <td class="muted small">${esc(String(o.id).slice(0, 8))}</td>
        <td class="right">${money(o.total_minor)}</td>
      </tr>`
    )
    .join('') || '<tr><td colspan="4" class="empty">No sales yet today.</td></tr>';
}

async function loadReports() {
  const r = await api('/reports');
  bars($('r-groups'), r.groups);
  bars($('r-depts'), r.departments, '#4b8ef5');
  bars($('r-clerks'), r.clerks, '#f5a524');
  bars($('r-plu'), r.plu, '#e5484d');
}

async function loadSales() {
  const rows = await api('/sales');
  $('sales').innerHTML = rows
    .map(
      (o) => `<tr>
        <td>${date(o.closed_at)} ${time(o.closed_at)}</td>
        <td class="muted small">${esc(String(o.id).slice(0, 8))}</td>
        <td>${o.table_number ?? '—'}</td>
        <td class="right">${money(o.tax_minor)}</td>
        <td class="right">${money(o.total_minor)}</td>
      </tr>`
    )
    .join('') || '<tr><td colspan="5" class="empty">No sales recorded.</td></tr>';
}

/**
 * The venue's own name for a printer slot, or '' for the built-in label.
 *
 * Top level on purpose: both the catalogue table and the product editor read
 * it, and they live in different scopes.
 */
const printerSlotName = (slot) =>
  String(idleState?.[`printer_name_${slot}`] ?? '').trim();

/**
 * A product's printing, for the catalogue table.
 *
 * Every station is named rather than counted: a manager scanning this column
 * is checking one specific printer, and "3 printers" does not answer that.
 * "Not on receipt" is called out because it is the unusual setting and the one
 * that surprises somebody looking at a bill with an item missing from it.
 */
function routeChips(p) {
  const stations = String(p.printer_routes ?? p.printer_route ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .map((s) => (s === 'kitchen' ? 'kp1' : s === 'bar' ? 'kp2' : s))
    .map((s) => {
      // The venue's own name for the slot wins over the built-in label. A
      // kitchen that calls KP 3 "Fryer" should read "Fryer" here too, or this
      // column and the printer setup screen disagree about the same printer.
      const named = printerSlotName(s);
      if (named) return named;
      if (/^kp[1-6]$/.test(s)) return `KP ${s.slice(2)}`;
      return s === 'receipt' ? 'Receipt printer' : s;
    });

  const chips = stations.map((s) => `<span class="chip">${esc(s)}</span>`);
  if (Number(p.print_to_receipt) === 0) {
    chips.push('<span class="chip warn">Not on receipt</span>');
  }
  return chips.length ? chips.join(' ') : '<span class="muted">—</span>';
}

/**
 * Make sure the venue's printer names are in hand before anything renders one.
 *
 * They live on the till-settings row, which is only fetched when the Idle
 * screen view is opened — so a manager who goes straight to Products would
 * otherwise see "KP 3" for a station they have named "Fryer". Fetched once,
 * and merged *under* whatever is already in hand so an unsaved edit on the
 * settings form is not overwritten by this.
 */
let printerNamesLoaded = false;
async function ensurePrinterNames() {
  if (printerNamesLoaded) return;
  try {
    const row = await api('/till-settings');
    idleState = { ...row, ...idleState };
    printerNamesLoaded = true;
  } catch {
    // Not worth failing the catalogue over. Every slot falls back to its
    // built-in label, which is what the venue saw before naming existed.
  }
}

async function loadProducts() {
  await ensurePrinterNames();
  const rows = await api('/products');
  $('products').innerHTML = rows
    .map(
      (p) => `<tr>
        <td>${p.pluid}</td>
        <td>${p.image_url
          ? `<img class="thumb" src="${esc(p.image_url)}" alt="" />`
          : p.emoji
          ? `<span class="emoji">${esc(p.emoji)}</span>`
          : ''} ${esc(p.product_name)}</td>
        <td>${esc(p.department_name || '—')}</td>
        <td class="right">${money(Math.round((p.price || 0) * 100))}</td>
        <td class="right">${p.tax_percentage || 0}%</td>
        <td class="right">${p.button_position ?? '—'}</td>
        <td>${p.button_color
          ? `<span class="swatch" style="background:${esc(p.button_color)}"></span>${esc(p.button_color)}`
          : '<span class="muted">default</span>'}</td>
        <td>${routeChips(p)}</td>
        <td class="right">
          <button class="btn small ghost" data-edit-product="${p.id}">Edit</button>
          <button class="btn small danger" data-del-product="${p.id}">Delete</button>
        </td>
      </tr>`
    )
    .join('') || '<tr><td colspan="9" class="empty">No products.</td></tr>';
}

async function loadUsers() {
  const rows = await api('/users');
  $('users').innerHTML = rows
    .map(
      (u) => `<tr>
        <td>${esc(u.name)}</td>
        <td class="muted small">${esc(u.email)}</td>
        <td>${esc(u.office_name || '—')}</td>
        <td><span class="badge ${u.role === 'admin' ? 'active' : 'archived'}">${u.role}</span></td>
        <td class="right">
          <button class="btn small ghost" data-pw-user="${u.id}">Reset password</button>
          ${u.role !== 'admin'
            ? `<button class="btn small danger" data-del-user="${u.id}">Delete</button>` : ''}
        </td>
      </tr>`
    )
    .join('') || '<tr><td colspan="5" class="empty">No users.</td></tr>';
}

async function loadStock() {
  const rows = await api('/products');
  $('stock').innerHTML = rows
    .map(
      (p) => `<tr>
        <td>${p.pluid}</td>
        <td>${esc(p.product_name)}</td>
        <td>${esc(p.department_name || '—')}</td>
        <td class="right">${p.stock_quantity ?? 0}</td>
      </tr>`
    )
    .join('');
}

async function loadStaff() {
  const rows = await api('/staff');
  $('staff').innerHTML = rows
    .map((c) => {
      const active = Number(c.active ?? 1) === 1;
      const pin = String(c.pin_code ?? '');
      const payload = esc(
        JSON.stringify({
          id: c.id,
          clark_name: c.clark_name,
          pluid: c.pluid,
          pin_code: pin,
          active: active ? 1 : 0,
        })
      );
      // A PIN that is not four digits cannot be used at the till — the pad
      // submits on the fourth key — so any legacy row like that is called out
      // here rather than leaving a member of staff who silently cannot sign on.
      const badPin = !/^\d{4}$/.test(pin);
      return `<tr>
        <td>${esc(c.clark_name)}</td>
        <td>${c.pluid}</td>
        <td class="staff-pin">${pin ? esc(pin) : '<span class="muted">not set</span>'}${
          badPin && pin
            ? ' <span class="pin-warn" title="The till pad submits after four digits, so this PIN can never sign on. Edit it to a 4-digit PIN.">needs fixing</span>'
            : ''
        }</td>
        <td>${active ? 'Active' : '<span class="muted">Retired</span>'}</td>
        <td class="right nowrap">
          <button class="btn small ghost" data-edit-staff='${payload}'>Edit</button>
          <button class="btn small danger" data-del-staff="${c.id}">Delete</button>
        </td>
      </tr>`;
    })
    .join('') ||
    '<tr><td colspan="5" class="empty">No staff yet. Add someone so they can sign on at the till.</td></tr>';
}

/**
 * Client-side PIN check, so a typo is caught before a round trip.
 *
 * The server enforces the same two rules and is the authority — this only makes
 * the feedback immediate. Returns an error string, or null when the PIN is fine.
 */
function staffPinError(pin, { required }) {
  const value = String(pin ?? '').trim();
  if (!value) return required ? 'A PIN is required.' : null;
  if (!/^\d{4}$/.test(value)) {
    return 'A PIN must be exactly 4 digits, numbers only — the till pad submits on the fourth key.';
  }
  return null;
}

function discountLabel(c) {
  if (c.discount_type === 'percent') return `${c.discount_value}%`;
  if (c.discount_type === 'amount') return money(c.discount_value);
  return '—';
}

async function loadCustomers() {
  const rows = await api('/customers');
  $('customers').innerHTML = rows
    .map((c) => {
      const expiry = c.membership_expiry ? String(c.membership_expiry).slice(0, 10) : null;
      const lapsed = expiry && expiry < new Date().toISOString().slice(0, 10);
      return `<tr>
        <td>${esc(c.name)}</td>
        <td class="muted small">${esc(c.phone || '—')}</td>
        <td class="muted small">${esc(c.email || '—')}</td>
        <td>${discountLabel(c)}</td>
        <td class="right">${c.points_balance || 0}</td>
        <td>${expiry
          ? `<span class="badge ${lapsed ? 'overdue' : 'active'}">${date(expiry)}</span>`
          : '<span class="muted">—</span>'}</td>
        <td class="right nowrap">
          <button class="btn small ghost" data-edit-customer="${c.id}">Edit</button>
          <button class="btn small danger" data-del-customer="${c.id}">Delete</button>
        </td>
      </tr>`;
    })
    .join('') || '<tr><td colspan="7" class="empty">No customers yet.</td></tr>';
}

// ---- Admin ----------------------------------------------------------------

async function loadOffices() {
  const rows = await api('/admin/offices');
  $('offices').innerHTML = rows
    .map(
      (o) => `<tr>
        <td><strong>${esc(o.name)}</strong></td>
        <td class="muted small">${esc(o.contact_email)}</td>
        <td><span class="badge ${o.status}">${o.status}</span></td>
        <td>${o.user_count}</td>
        <td class="right">${o.amount_minor ? money(o.amount_minor) + ' / ' + o.interval_unit : '—'}</td>
        <td>${o.next_due_on ? date(o.next_due_on) : '—'}</td>
        <td class="right">
          ${o.status === 'active'
            ? `<button class="btn small danger" data-pause="${o.id}">Pause</button>`
            : `<button class="btn small primary" data-resume="${o.id}">Resume</button>`}
        </td>
      </tr>`
    )
    .join('') || '<tr><td colspan="7" class="empty">No offices.</td></tr>';
}

async function loadBilling() {
  const offices = await api('/admin/offices');
  const all = [];
  for (const o of offices) {
    const invoices = await api(`/admin/offices/${o.id}/invoices`);
    invoices.forEach((i) => all.push({ ...i, office: o.name }));
  }
  all.sort((a, b) => new Date(b.due_on) - new Date(a.due_on));

  $('invoices').innerHTML = all
    .map(
      (i) => `<tr>
        <td>${esc(i.office)}</td>
        <td>${date(i.due_on)}</td>
        <td class="right">${money(i.amount_minor)}</td>
        <td><span class="badge ${i.status}">${i.status}</span></td>
        <td class="right">${i.status !== 'paid'
          ? `<button class="btn small primary" data-paid="${i.id}">Mark paid</button>` : ''}</td>
      </tr>`
    )
    .join('') || '<tr><td colspan="5" class="empty">Nothing billed yet.</td></tr>';
}

// ---- Floor designer -------------------------------------------------------

const GRID = 40; // px per grid unit — tables snap to this
let floor = [];
let activeRoom = null;
let selected = null;
let dirty = false;

function markDirty(on) {
  dirty = on;
  $('dirty').innerHTML = on ? '<span class="unsaved">Unsaved changes</span>' : '';
}

async function loadFloor() {
  floor = await api('/floor');

  if (!floor.length) {
    $('canvas').innerHTML =
      '<div class="empty">No rooms yet — create one to start laying out tables.</div>';
    $('room-tabs').innerHTML = '';
    return;
  }

  if (!floor.some((r) => r.id === activeRoom)) activeRoom = floor[0].id;

  $('room-tabs').innerHTML = floor
    .map(
      (r) => `<button class="room-tab ${r.id === activeRoom ? 'active' : ''}"
        data-room="${r.id}">${esc(r.name)}</button>`
    )
    .join('');

  drawRoom();
}

function drawRoom() {
  const room = floor.find((r) => r.id === activeRoom);
  const canvas = $('canvas');
  if (!room) return;

  canvas.innerHTML = room.tables
    .map(
      (t) => `<div class="tbl ${t.shape === 'circle' ? 'circle' : ''}"
        data-table="${t.id}"
        style="left:${t.pos_x * GRID}px; top:${t.pos_y * GRID}px;
               width:${t.width * GRID}px; height:${t.height * GRID}px;">
        <span class="num">${t.label ? esc(t.label) : t.table_number}</span>
        <span class="seats">${t.seats} seats</span>
      </div>`
    )
    .join('');

  canvas.querySelectorAll('.tbl').forEach(makeDraggable);
  showInspector();
}

/**
 * Drag with the pointer, snapped to the grid.
 *
 * Position is written back to the in-memory model on drop, not to the server —
 * the manager may be rearranging a dozen tables, and a write per pixel would
 * hammer the API and push half-finished layouts to the tills.
 */
function makeDraggable(el) {
  const id = Number(el.dataset.table);

  el.addEventListener('pointerdown', (e) => {
    const room = floor.find((r) => r.id === activeRoom);
    const table = room.tables.find((t) => t.id === id);

    selected = id;
    showInspector();
    drawSelection();

    const startX = e.clientX;
    const startY = e.clientY;
    const originX = table.pos_x;
    const originY = table.pos_y;

    el.classList.add('dragging');
    el.setPointerCapture(e.pointerId);

    const onMove = (ev) => {
      const dx = Math.round((ev.clientX - startX) / GRID);
      const dy = Math.round((ev.clientY - startY) / GRID);

      // Keep the table on the canvas: a table dragged off the edge would be
      // invisible on the till and unreachable.
      const maxX = Math.floor($('canvas').clientWidth / GRID) - table.width;
      const maxY = Math.floor($('canvas').clientHeight / GRID) - table.height;

      table.pos_x = Math.max(0, Math.min(originX + dx, maxX));
      table.pos_y = Math.max(0, Math.min(originY + dy, maxY));

      el.style.left = `${table.pos_x * GRID}px`;
      el.style.top = `${table.pos_y * GRID}px`;
    };

    const onUp = () => {
      el.classList.remove('dragging');
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      if (table.pos_x !== originX || table.pos_y !== originY) markDirty(true);
    };

    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
  });
}

function drawSelection() {
  document.querySelectorAll('.tbl').forEach((el) =>
    el.classList.toggle('selected', Number(el.dataset.table) === selected)
  );
}

function showInspector() {
  const body = $('inspector-body');
  const room = floor.find((r) => r.id === activeRoom);
  const table = room?.tables.find((t) => t.id === selected);

  if (!table) {
    body.innerHTML = '<p class="muted small">Select a table to edit it.</p>';
    return;
  }

  body.innerHTML = `
    <label>Number<input id="i-num" type="number" value="${table.table_number}" disabled /></label>
    <label>Label<input id="i-label" value="${esc(table.label || '')}" /></label>
    <label>Seats<input id="i-seats" type="number" value="${table.seats}" /></label>
    <div class="row">
      <label>Width<input id="i-w" type="number" min="1" max="8" value="${table.width}" /></label>
      <label>Height<input id="i-h" type="number" min="1" max="8" value="${table.height}" /></label>
    </div>
    <label>Shape
      <select id="i-shape">
        <option value="rect" ${table.shape === 'rect' ? 'selected' : ''}>Rectangle</option>
        <option value="circle" ${table.shape === 'circle' ? 'selected' : ''}>Circle</option>
      </select>
    </label>
    <button class="btn danger small" id="i-del" style="margin-top:16px">Delete table</button>`;

  const apply = () => {
    table.label = $('i-label').value || null;
    table.seats = Number($('i-seats').value) || 4;
    table.width = Math.max(1, Number($('i-w').value) || 2);
    table.height = Math.max(1, Number($('i-h').value) || 2);
    table.shape = $('i-shape').value;
    markDirty(true);
    drawRoom();
    drawSelection();
  };

  ['i-label', 'i-seats', 'i-w', 'i-h', 'i-shape'].forEach((id) =>
    $(id).addEventListener('change', apply)
  );

  $('i-del').onclick = async () => {
    if (!confirm(`Delete table ${table.table_number}?`)) return;
    await api(`/floor/tables/${table.id}`, { method: 'DELETE' });
    selected = null;
    loadFloor();
  };
}

/** Push the whole room in one request, so the tills never see a partial plan. */
async function saveFloor() {
  const room = floor.find((r) => r.id === activeRoom);
  if (!room) return;

  await api('/floor/tables', {
    method: 'PUT',
    body: JSON.stringify({ tables: room.tables }),
  });
  markDirty(false);
}

// ---- Modal ----------------------------------------------------------------

function fieldHtml(f) {
  if (f.type === 'color') {
    // Paired with a text box: a colour picker alone hides the hex value, and
    // a venue matching a brand colour needs to read and paste it.
    return `<span class="colour-field">
      <input type="color" value="${esc(f.value || '#5e35b1')}"
             oninput="this.nextElementSibling.value = this.value" />
      <input type="text" name="${f.name}" value="${esc(f.value || '#5e35b1')}"
             oninput="this.previousElementSibling.value = this.value" />
    </span>`;
  }
  if (f.type === 'select') {
    // Options are either plain strings or {value,label} pairs — the commerce
    // editors need labels that read differently from the stored value.
    return `<select name="${f.name}">${f.options
      .map((o) => {
        const value = typeof o === 'object' ? o.value : o;
        const label = typeof o === 'object' ? o.label : o;
        return `<option value="${esc(value)}"${
          String(value) === String(f.value) ? ' selected' : ''
        }>${esc(label)}</option>`;
      })
      .join('')}</select>`;
  }
  if (f.type === 'checkbox') {
    // A hidden 0 before the checkbox so an unchecked box submits 0 rather than
    // dropping out of the form entirely; the checkbox's 1 overrides it when set.
    return `<span class="check-field">
      <input type="hidden" name="${f.name}" value="0" />
      <input type="checkbox" value="1" ${Number(f.value) ? 'checked' : ''}
             onchange="this.previousElementSibling.value = this.checked ? 1 : 0" />
    </span>`;
  }
  if (f.type === 'image') {
    // A file picker plus a hidden field holding the uploaded URL, so an
    // unchanged image keeps its existing value on edit.
    return `
      <input type="hidden" name="${f.name}" value="${esc(f.value ?? '')}" />
      <div class="img-field" data-img-for="${f.name}">
        ${f.value ? `<img class="img-preview" src="${esc(f.value)}" alt="" />` : ''}
        <input type="file" accept="image/*" data-upload-for="${f.name}" data-crop-shape="${f.crop || 'square'}" />
      </div>`;
  }
  if (f.type === 'stations') {
    // Every station gets a box, including the ones this venue has not set up:
    // the back office does not know which printers are plugged into which
    // till, and a station hidden here would be a station no product could ever
    // be routed to. Several may be ticked — a dish the grill cooks and the
    // pass plates belongs on both.
    const on = new Set(
      String(f.value ?? '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    );
    return `<div class="station-grid">
      ${f.options
        .map(
          (o) => `<label class="station${on.has(o.value) ? ' on' : ''}">
            <input type="checkbox" name="${f.name}" value="${esc(o.value)}"
                   ${on.has(o.value) ? 'checked' : ''}
                   onchange="this.closest('.station').classList.toggle('on', this.checked)" />
            <span>${esc(o.label)}</span>
          </label>`
        )
        .join('')}
    </div>`;
  }
  // `money` is a pounds amount entered as a decimal number.
  const htmlType = f.type === 'money' ? 'number' : (f.type || 'text');
  const step = f.type === 'money' ? ' step="0.01"' : '';
  return `<input name="${f.name}" type="${htmlType}"${step} ${
    f.required ? 'required' : ''
  } value="${esc(String(f.value ?? ''))}" />`;
}

// Crop-frame shapes, matched to how each picture actually renders on the
// till: a department's category button is a square (_CategoryThumb in
// vesopa_epos/lib/ui/sale_page.dart), a product's sale-grid tile gives the
// picture a wide 16:9-ish band under the name instead (_image(), same file).
// Both use BoxFit.cover on the till, so a mismatched crop shape just gets
// re-cropped unpredictably there — this is what keeps the two in sync.
const CROP_SHAPES = {
  square: { OUT_W: 512, OUT_H: 512, VIEW_W: 320, VIEW_H: 320 },
  landscape: { OUT_W: 512, OUT_H: 288, VIEW_W: 320, VIEW_H: 180 },
};

/**
 * Crop / zoom / resize a chosen image before it is uploaded.
 *
 * Returns a Promise that resolves with a PNG Blob sized per `shape` (see
 * CROP_SHAPES), or rejects if the manager cancels. Hand-rolled on a <canvas>
 * rather than pulling in a cropper library, to keep the back office a
 * dependency-free set of static files.
 *
 * The image is drawn into a viewport shaped like the field's on-till target;
 * the manager drags to pan and uses the slider to zoom. On save we redraw the
 * visible region into an offscreen canvas at the same scale/offset, so what
 * they framed is exactly what uploads.
 */
function openCropper(file, shape = 'square') {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => start();
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Bad image')); };
    img.src = url;

    const { OUT_W, OUT_H, VIEW_W, VIEW_H } = CROP_SHAPES[shape] || CROP_SHAPES.square;

    function start() {
      const root = $('cropper-root');
      root.innerHTML = `
        <div class="modal-back">
          <div class="modal cropper">
            <h3>Position the picture</h3>
            <p class="muted small">Drag to move, slide to zoom. The frame is what appears on the till.</p>
            <div class="crop-stage" style="width:${VIEW_W}px;height:${VIEW_H}px">
              <canvas id="crop-canvas" width="${VIEW_W}" height="${VIEW_H}"></canvas>
              <div class="crop-frame"></div>
            </div>
            <label class="crop-zoom">Zoom
              <input type="range" id="crop-zoom" min="1" max="4" step="0.01" value="1" />
            </label>
            <div class="modal-actions">
              <button type="button" class="btn ghost" id="crop-cancel">Cancel</button>
              <button type="button" class="btn primary" id="crop-save">Use picture</button>
            </div>
          </div>
        </div>`;

      const canvas = $('crop-canvas');
      const ctx = canvas.getContext('2d');

      // Base scale: cover the viewport (shortest side fills it), then the zoom
      // slider multiplies on top. Offset is the top-left of the drawn image in
      // viewport pixels, clamped so the frame is always fully covered.
      const cover = Math.max(VIEW_W / img.width, VIEW_H / img.height);
      let zoom = 1;
      let offX = (VIEW_W - img.width * cover) / 2;
      let offY = (VIEW_H - img.height * cover) / 2;

      const scale = () => cover * zoom;
      function clamp() {
        const w = img.width * scale();
        const h = img.height * scale();
        offX = Math.min(0, Math.max(VIEW_W - w, offX));
        offY = Math.min(0, Math.max(VIEW_H - h, offY));
      }
      function draw() {
        clamp();
        ctx.clearRect(0, 0, VIEW_W, VIEW_H);
        ctx.drawImage(img, offX, offY, img.width * scale(), img.height * scale());
      }
      draw();

      // Drag to pan.
      let dragging = false, lastX = 0, lastY = 0;
      canvas.addEventListener('pointerdown', (e) => {
        dragging = true; lastX = e.clientX; lastY = e.clientY;
        canvas.setPointerCapture(e.pointerId);
      });
      canvas.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        offX += e.clientX - lastX; offY += e.clientY - lastY;
        lastX = e.clientX; lastY = e.clientY;
        draw();
      });
      canvas.addEventListener('pointerup', () => (dragging = false));

      // Zoom keeps the viewport centre stable so the framing does not lurch.
      $('crop-zoom').addEventListener('input', (e) => {
        const next = parseFloat(e.target.value);
        const cx = VIEW_W / 2, cy = VIEW_H / 2;
        const k = (cover * next) / scale();
        offX = cx - (cx - offX) * k;
        offY = cy - (cy - offY) * k;
        zoom = next;
        draw();
      });

      const done = (blob) => { URL.revokeObjectURL(url); root.innerHTML = ''; blob ? resolve(blob) : reject(new Error('cancelled')); };
      $('crop-cancel').onclick = () => done(null);
      $('crop-save').onclick = () => {
        // Redraw the framed region at output resolution.
        const out = document.createElement('canvas');
        out.width = OUT_W; out.height = OUT_H;
        const octx = out.getContext('2d');
        const r = OUT_W / VIEW_W;
        octx.drawImage(
          img,
          offX * r, offY * r,
          img.width * scale() * r, img.height * scale() * r
        );
        out.toBlob((b) => done(b), 'image/png');
      };
    }
  });
}

function modal(title, fields, onSubmit) {
  const root = $('modal-root');
  root.innerHTML = `
    <div class="modal-back">
      <form class="modal" id="modal-form">
        <h3>${esc(title)}</h3>
        ${fields
          .map((f) => `<label>${esc(f.label)}${fieldHtml(f)}</label>`)
          .join('')}
        <div class="modal-actions">
          <button type="button" class="btn ghost" id="modal-cancel">Cancel</button>
          <button type="submit" class="btn primary">Save</button>
        </div>
      </form>
    </div>`;

  // On file select, open the cropper (zoom / pan / crop). What it returns is
  // a resized PNG in the shape that field displays on the till — never the
  // raw camera image — so till buttons all get a consistent, small picture.
  root.querySelectorAll('[data-upload-for]').forEach((input) => {
    input.addEventListener('change', async () => {
      const file = input.files[0];
      if (!file) return;
      let blob;
      try {
        blob = await openCropper(file, input.dataset.cropShape);
      } catch {
        input.value = '';
        return; // cancelled
      }
      if (!blob) return;

      const body = new FormData();
      body.append('image', blob, 'product.png');
      try {
        const res = await fetch('/api/product-image', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body,
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Upload failed');
        const hidden = root.querySelector(`input[name="${input.dataset.uploadFor}"]`);
        hidden.value = data.url;
        const wrap = input.closest('.img-field');
        wrap.querySelector('.img-preview')?.remove();
        const img = document.createElement('img');
        img.className = 'img-preview';
        img.src = data.url;
        wrap.prepend(img);
      } catch (err) {
        alert(err.message);
      } finally {
        input.value = '';
      }
    });
  });

  $('modal-cancel').onclick = () => (root.innerHTML = '');
  $('modal-form').onsubmit = async (e) => {
    e.preventDefault();
    // Not Object.fromEntries: that keeps only the last value for a repeated
    // name, which would reduce a product ticked for KP 1, KP 3 and KP 5 to
    // KP 5 alone — silently, and only discoverable in a kitchen at service.
    const form = new FormData(e.target);
    const data = {};
    for (const key of new Set(form.keys())) {
      const values = form.getAll(key);
      data[key] = values.length > 1 ? values : values[0];
    }
    try {
      await onSubmit(data);
      root.innerHTML = '';
      render();
    } catch (err) {
      alert(err.message);
    }
  };
}

// ---- Receipt viewer -------------------------------------------------------

/**
 * Show one order as an 80mm-style receipt in a modal, with a Print button.
 * Printing goes through the browser's print dialog (which offers "Save as PDF"
 * everywhere), so there is no PDF library to ship — the same reason the bar
 * charts are hand-rolled. The receipt node is isolated for print via an @media
 * print rule in the stylesheet.
 */
async function showReceipt(id) {
  let data;
  try {
    data = await api(`/receipts/${id}`);
  } catch (err) {
    return alert(err.message);
  }
  const { order, lines, payments } = data;

  const linesHtml = lines
    .map(
      (l) => `<tr>
        <td>${l.quantity}×</td>
        <td>${esc(l.name)}</td>
        <td class="r-line-tot">${money(l.unit_price_minor * l.quantity)}</td>
      </tr>`
    )
    .join('');

  const paysHtml = payments
    .map(
      (p) => `<tr><td colspan="2">${esc(p.method)}</td>
        <td class="r-line-tot">${money(p.amount_minor)}</td></tr>`
    )
    .join('');

  const root = $('modal-root');
  root.innerHTML = `
    <div class="modal-back">
      <div class="modal">
        <div id="receipt-print" class="receipt-view">
          <h3>${esc(me?.officeName || 'Vesopa EPOS')}</h3>
          <p class="r-sub">
            ${date(order.closed_at)} ${time(order.closed_at)}<br/>
            Receipt ${esc(String(order.id).slice(0, 8))}
            ${order.table_number ? ` · Table ${order.table_number}` : ''}
          </p>
          <table>${linesHtml}</table>
          <table>
            <tr><td colspan="2">Subtotal</td><td class="r-line-tot">${money(order.subtotal_minor)}</td></tr>
            ${order.discount_minor ? `<tr><td colspan="2">Discount</td><td class="r-line-tot">−${money(order.discount_minor)}</td></tr>` : ''}
            <tr><td colspan="2">VAT</td><td class="r-line-tot">${money(order.tax_minor)}</td></tr>
            <tr class="r-tot"><td colspan="2">Total</td><td class="r-line-tot">${money(order.total_minor)}</td></tr>
            ${paysHtml}
          </table>
          <p class="r-sub" style="margin-top:14px">Thank you</p>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn ghost" id="receipt-close">Close</button>
          <button type="button" class="btn primary" id="receipt-print-btn">Print / Save PDF</button>
        </div>
      </div>
    </div>`;

  $('receipt-close').onclick = () => (root.innerHTML = '');
  $('receipt-print-btn').onclick = () => {
    document.body.classList.add('printing-receipt');
    window.print();
    document.body.classList.remove('printing-receipt');
  };
}

// ---- Actions --------------------------------------------------------------

document.addEventListener('click', async (e) => {
  const t = e.target;

  // A clickable receipt row (Sales Explorer, Bill Report) opens the viewer.
  const receiptRow = t.closest?.('[data-receipt]');
  if (receiptRow) return showReceipt(receiptRow.dataset.receipt);

  // Export the current report to PDF via the print dialog.
  if (t.hasAttribute?.('data-print-report')) {
    document.body.classList.add('printing-report');
    window.print();
    document.body.classList.remove('printing-report');
    return;
  }

  // ---- Mobile drawer ----
  if (t.closest?.('#rail-toggle')) {
    return setRailOpen(!$('app').classList.contains('rail-open'));
  }
  if (t.id === 'rail-scrim') return setRailOpen(false);

  // A group heading (or its caret) folds its section. Deliberately does NOT
  // close the drawer — folding a section is how you find the view you want.
  const group = t.closest?.('.nav-group');
  if (group) return toggleGroup(group);

  if (t.dataset.view) {
    // Picking a view is the end of the errand the drawer was opened for.
    setRailOpen(false);
    return show(t.dataset.view);
  }

  // ---- Floor designer ----
  if (t.dataset.room) {
    if (dirty && !confirm('Discard unsaved layout changes?')) return;
    activeRoom = Number(t.dataset.room);
    selected = null;
    markDirty(false);
    return loadFloor();
  }
  if (t.id === 'save-floor') return saveFloor();
  if (t.id === 'add-room') {
    const name = prompt('Room name (e.g. Main Floor, Terrace)');
    if (!name) return;
    await api('/floor/rooms', { method: 'POST', body: JSON.stringify({ name }) });
    return loadFloor();
  }
  if (t.id === 'add-table') {
    if (!activeRoom) return alert('Create a room first.');
    const num = parseInt(prompt('Table number') || '', 10);
    if (!num) return;
    try {
      await api('/floor/tables', {
        method: 'POST',
        body: JSON.stringify({
          room_id: activeRoom, table_number: num,
          pos_x: 1, pos_y: 1, width: 2, height: 2, seats: 4, shape: 'rect',
        }),
      });
      return loadFloor();
    } catch (err) {
      return alert(err.message);
    }
  }

  // ---- Generic programming CRUD ----
  if (t.dataset.del && t.dataset.id) {
    if (!confirm('Delete this?')) return;
    await api(`/${t.dataset.del}/${t.dataset.id}`, { method: 'DELETE' });
    return render();
  }
  if (t.dataset.add) {
    const cfg = CRUD[t.dataset.add];
    return modal(`Add ${cfg.title}`, crudModalFields(cfg), (d) =>
      api(`/${cfg.path}`, {
        method: 'POST',
        body: JSON.stringify(crudPayload(cfg, d)),
      })
    );
  }
  if (t.dataset.edit && CRUD[t.dataset.edit]) {
    const cfg = CRUD[t.dataset.edit];
    // Re-fetch the list and pick the row rather than adding a per-row GET the
    // server does not have — these tables are small.
    const rows = await api(`/${cfg.path}`);
    const row = rows.find((r) => String(r.id) === String(t.dataset.id));
    if (!row) return;
    return modal(`Edit ${cfg.title}`, crudModalFields(cfg, row), (d) =>
      api(`/${cfg.path}/${row.id}`, {
        method: 'PUT',
        body: JSON.stringify(crudPayload(cfg, d)),
      })
    );
  }
  if (t.id === 'ex-run') return loadExplorer();

  if (t.dataset.delProduct && confirm('Delete this product?')) {
    await api(`/products/${t.dataset.delProduct}`, { method: 'DELETE' });
    return loadProducts();
  }
  // Deleting removes the person; their past sales keep the name that was
  // printed on them. "Retire" (the Active switch) is the softer option, and the
  // prompt says so, because this is the button a manager reaches for first.
  if (
    t.dataset.delStaff &&
    confirm(
      'Delete this staff member?\n\n' +
        'Their PIN stops working immediately. Sales they have already rung up ' +
        'keep their name. To stop them signing on but keep the record tidy, ' +
        'edit them and clear "Active" instead.'
    )
  ) {
    await api(`/staff/${t.dataset.delStaff}`, { method: 'DELETE' });
    return loadStaff();
  }

  if (t.dataset.pause) {
    const reason = prompt('Reason for pausing (shown to the office):', 'Non-payment');
    if (reason === null) return;
    await api(`/admin/offices/${t.dataset.pause}/status`, {
      method: 'POST',
      body: JSON.stringify({ status: 'paused', reason }),
    });
    return loadOffices();
  }
  if (t.dataset.resume) {
    await api(`/admin/offices/${t.dataset.resume}/status`, {
      method: 'POST',
      body: JSON.stringify({ status: 'active' }),
    });
    return loadOffices();
  }
  if (t.dataset.paid) {
    await api(`/admin/invoices/${t.dataset.paid}/paid`, { method: 'POST' });
    return loadBilling();
  }

  if (t.id === 'sweep') {
    const r = await api('/admin/invoices/sweep-overdue', { method: 'POST' });
    alert(`${r.marked_overdue} invoice(s) flagged overdue.`);
    return loadBilling();
  }

  if (t.id === 'add-office') {
    return modal('New office', [
      { label: 'Office name', name: 'name', required: true },
      { label: 'Contact email (their sign-in)', name: 'contact_email', type: 'email', required: true },
      { label: 'Password', name: 'password', type: 'password', required: true },
      { label: 'Plan', name: 'plan' },
      { label: 'Recurring charge (£)', name: 'amount', type: 'number', value: '0' },
      { label: 'Billed', name: 'interval_unit', type: 'select', options: ['month', 'year'] },
    ], (d) =>
      api('/admin/offices', {
        method: 'POST',
        body: JSON.stringify({
          ...d,
          amount_minor: Math.round(parseFloat(d.amount || '0') * 100),
        }),
      })
    );
  }

  // Shared customer form, used by both add and edit. Discount value is a whole
  // percent for `percent`, or pence for `amount` — matching the till.
  const customerFields = (c = {}) => [
    { label: 'Name', name: 'name', required: true, value: c.name ?? '' },
    { label: 'Phone', name: 'phone', value: c.phone ?? '' },
    { label: 'Email', name: 'email', type: 'email', value: c.email ?? '' },
    { label: 'Loyalty card number', name: 'card_number', value: c.card_number ?? '' },
    { label: 'Discount type', name: 'discount_type', type: 'select', options: ['none', 'percent', 'amount'], value: c.discount_type ?? 'none' },
    { label: 'Discount value (% or pence)', name: 'discount_value', type: 'number', value: c.discount_value ?? 0 },
    { label: 'Loyalty points', name: 'points_balance', type: 'number', value: c.points_balance ?? 0 },
    { label: 'Membership expires (blank = none)', name: 'membership_expiry', type: 'date', value: c.membership_expiry ? String(c.membership_expiry).slice(0, 10) : '' },
    { label: 'Notes', name: 'notes', value: c.notes ?? '' },
  ];
  const customerPayload = (d) => ({
    ...d,
    discount_value: parseInt(d.discount_value || '0', 10),
    points_balance: parseInt(d.points_balance || '0', 10),
    // An empty date field must clear the membership, not send "".
    membership_expiry: d.membership_expiry || null,
  });

  // The till's six kitchen slots, plus the receipt printer at the end.
  //
  // Six kitchen stations and no more: offering a seventh would let a manager
  // route food to a station no terminal can print to, and the failure would
  // show up in a kitchen at service rather than in this form.
  //
  // The receipt printer is a routing target too, because a counter often wants
  // its own ticket for an item — a coffee the barista behind the till makes —
  // and the alternative was a kitchen printer pointed at the counter.
  const printerStations = () => [
    ...[1, 2, 3, 4, 5, 6].map((n) => ({
      value: `kp${n}`,
      label: printerSlotName(`kp${n}`) || `KP ${n}`,
    })),
    {
      value: 'receipt',
      label: printerSlotName('receipt') || 'Receipt printer',
    },
  ];

  /** The pre-numbering routing names, as the station they now mean. */
  const legacyStation = (route) => {
    const key = String(route ?? '').trim().toLowerCase();
    return key === 'kitchen' ? 'kp1' : key === 'bar' ? 'kp2' : key;
  };

  const productFields = (p = {}) => [
    { label: 'PLU number', name: 'pluid', type: 'number', required: true, value: p.pluid ?? '' },
    { label: 'Name', name: 'product_name', required: true, value: p.product_name ?? '' },
    { label: 'Department', name: 'department_name', value: p.department_name ?? '' },
    { label: 'Price (£)', name: 'price', type: 'number', value: p.price ?? 0 },
    { label: 'VAT %', name: 'tax_percentage', type: 'number', value: p.tax_percentage ?? 20 },
    { label: 'Stock', name: 'stock_quantity', type: 'number', value: p.stock_quantity ?? 0 },
    { label: 'Button position (blank = unassigned)', name: 'button_position', type: 'number', value: p.button_position ?? '' },
    { label: 'Button colour (e.g. #4BA3F5)', name: 'button_color', value: p.button_color ?? '' },
    { label: 'Emoji (e.g. 🍔)', name: 'emoji', value: p.emoji ?? '' },
    // The sale-grid button gives a product picture a wide band under the name
    // (see _image() in vesopa_epos/lib/ui/sale_page.dart), unlike a department's
    // square category button — so this one crops to 16:9, not square.
    { label: 'Image', name: 'image_url', type: 'image', crop: 'landscape', value: p.image_url ?? '' },
    {
      label: 'Printers — prints when sold and when saved to a table',
      name: 'printer_routes',
      type: 'stations',
      options: printerStations(),
      // Falls back to the pre-numbering column so a product that has never
      // been re-saved still shows its routing rather than looking unrouted.
      value: p.printer_routes ?? legacyStation(p.printer_route),
    },
    {
      label: 'Show on the customer receipt',
      name: 'print_to_receipt',
      type: 'checkbox',
      // New products default to on. Only an explicit 0 turns it off, so a
      // catalogue imported without the field is not hidden from every bill.
      value: p.print_to_receipt === undefined ? 1 : p.print_to_receipt,
    },
  ];

  if (t.id === 'add-product') {
    return modal('Add product', productFields(), (d) =>
      api('/products', { method: 'POST', body: JSON.stringify(d) })
    );
  }
  if (t.dataset.editProduct) {
    const p = await api(`/products/${t.dataset.editProduct}`);
    return modal('Edit product', productFields(p), (d) =>
      api(`/products/${p.id}`, { method: 'PUT', body: JSON.stringify(d) })
    );
  }

  if (t.id === 'add-user') {
    const offices = me?.role === 'admin' ? await api('/admin/offices') : [];
    return modal('Add back office user', [
      { label: 'Name', name: 'name', required: true },
      { label: 'Email (their sign-in)', name: 'email', type: 'email', required: true },
      { label: 'Password', name: 'password', type: 'password', required: true },
      ...(me?.role === 'admin'
        ? [{ label: 'Office', name: 'office_id', type: 'select',
             options: offices.map((o) => `${o.id} — ${o.name}`) }]
        : []),
    ], (d) => {
      // The select carries "12 — Name"; the API wants the id.
      if (d.office_id) d.office_id = parseInt(d.office_id, 10);
      return api('/users', { method: 'POST', body: JSON.stringify(d) });
    });
  }
  if (t.dataset.pwUser) {
    const pw = prompt('New password (at least 6 characters)');
    if (!pw) return;
    try {
      await api(`/users/${t.dataset.pwUser}/password`, {
        method: 'POST',
        body: JSON.stringify({ password: pw }),
      });
      alert('Password reset.');
    } catch (err) {
      alert(err.message);
    }
    return;
  }
  if (t.dataset.delUser && confirm('Delete this user?')) {
    try {
      await api(`/users/${t.dataset.delUser}`, { method: 'DELETE' });
    } catch (err) {
      alert(err.message);
    }
    return loadUsers();
  }

  if (t.id === 'add-staff') {
    return modal('Add staff', [
      { label: 'Staff name', name: 'clark_name', required: true },
      { label: 'Staff PIN (exactly 4 digits)', name: 'pin_code', required: true },
      { label: 'Staff ID', name: 'pluid', type: 'number', value: '0' },
      { label: 'Active (can sign on at the till)', name: 'active', type: 'checkbox', value: 1 },
    ], (d) => {
      const bad = staffPinError(d.pin_code, { required: true });
      if (bad) throw new Error(bad);
      return api('/staff', { method: 'POST', body: JSON.stringify(d) });
    });
  }
  if (t.dataset.editStaff) {
    const c = JSON.parse(t.dataset.editStaff);
    return modal('Edit staff', [
      { label: 'Staff name', name: 'clark_name', required: true, value: c.clark_name },
      // Pre-filled now that the list shows PINs anyway: a manager editing a name
      // should not have to retype a PIN, and a blank box that silently means
      // "keep the old one" is a worse thing to explain than the PIN itself.
      { label: 'Staff PIN (exactly 4 digits)', name: 'pin_code', value: c.pin_code ?? '' },
      { label: 'Staff ID', name: 'pluid', type: 'number', value: c.pluid },
      { label: 'Active (can sign on at the till)', name: 'active', type: 'checkbox', value: c.active },
    ], (d) => {
      // Blank still means "leave it alone" server-side, so it is only validated
      // when something was actually typed.
      const bad = staffPinError(d.pin_code, { required: false });
      if (bad) throw new Error(bad);
      return api(`/staff/${c.id}`, { method: 'PUT', body: JSON.stringify(d) });
    });
  }

  if (t.dataset.delCustomer && confirm('Delete this customer?')) {
    await api(`/customers/${t.dataset.delCustomer}`, { method: 'DELETE' });
    return loadCustomers();
  }
  if (t.id === 'add-customer') {
    return modal('Add customer', customerFields(), (d) =>
      api('/customers', { method: 'POST', body: JSON.stringify(customerPayload(d)) })
    );
  }
  if (t.dataset.editCustomer) {
    const rows = await api('/customers');
    const c = rows.find((r) => String(r.id) === String(t.dataset.editCustomer));
    if (!c) return;
    return modal('Edit customer', customerFields(c), (d) =>
      api(`/customers/${c.id}`, { method: 'PUT', body: JSON.stringify(customerPayload(d)) })
    );
  }

  if (t.id === 'logout') signOut();
});

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-error').textContent = '';
  const remember = $('remember').checked;

  // The form carries `novalidate` so the browser's bubbles don't fight the
  // error line below the button; the same checks happen here instead.
  if (!$('email').value.trim() || !$('password').value) {
    $('login-error').textContent = 'Enter your email and password.';
    return;
  }

  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: $('email').value.trim(),
        password: $('password').value,
        remember,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Sign-in failed');

    token = data.token;
    me = data.user;
    saveSession(remember);
    start();
  } catch (err) {
    $('login-error').textContent = err.message;
  }
});

function signOut() {
  token = null;
  me = null;
  clearSession();
  if (socket) socket.close();
  $('app').hidden = true;
  $('login').hidden = false;
  $('login-note').hidden = true;
  showLoginPanel('login-form');
  history.replaceState({}, '', '/');
  document.title = 'Vesopa EPOS — Back Office';
}

// ---- Forgot / reset password ---------------------------------------------

/** The sign-in column holds three cards; exactly one of them is ever visible. */
function showLoginPanel(id) {
  for (const panel of ['login-form', 'forgot-form', 'reset-form']) {
    $(panel).hidden = panel !== id;
  }
  $(id).querySelector('input:not([type=checkbox])')?.focus();
}

$('forgot').addEventListener('click', () => {
  // Carry whatever they already typed, so nobody retypes their address. Also
  // undoes the "sent" state, or a second visit would find a dead form.
  $('forgot-email').value = $('email').value.trim();
  $('forgot-email').disabled = false;
  $('forgot-submit').hidden = false;
  $('forgot-note').hidden = true;
  $('forgot-error').textContent = '';
  showLoginPanel('forgot-form');
});

$('forgot-back').addEventListener('click', () => {
  $('login-note').hidden = true;
  showLoginPanel('login-form');
});
$('reset-back').addEventListener('click', () => {
  history.replaceState({}, '', '/');
  $('login-note').hidden = true;
  showLoginPanel('login-form');
});

$('forgot-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('forgot-email').value.trim();
  $('forgot-error').textContent = '';
  if (!email.includes('@')) {
    $('forgot-error').textContent = 'Enter the email address you sign in with.';
    return;
  }

  const btn = $('forgot-submit');
  btn.disabled = true;
  btn.textContent = 'Sending…';
  try {
    const res = await fetch('/api/password/forgot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not send the reset link.');

    // The server answers the same whether or not the account exists, so this
    // message must not promise an email actually went out.
    const note = $('forgot-note');
    note.textContent = data.message;
    note.hidden = false;
    // Nothing more to do on this screen — a second press only burns throttle.
    btn.hidden = true;
    $('forgot-email').disabled = true;
  } catch (err) {
    $('forgot-error').textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send reset link';
  }
});

$('reset-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = $('reset-password').value;
  const confirm = $('reset-confirm').value;
  $('reset-error').textContent = '';

  if (password.length < 8) {
    $('reset-error').textContent = 'Choose a password of at least 8 characters.';
    return;
  }
  if (password !== confirm) {
    $('reset-error').textContent = 'The two passwords do not match.';
    return;
  }

  const btn = $('reset-submit');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    const res = await fetch('/api/password/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: resetToken, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not save the new password.');

    // Straight back to sign-in rather than auto-signing them in: the token
    // came from an email, and a link in an inbox should not be a session.
    history.replaceState({}, '', '/');
    $('login-error').textContent = '';
    $('password').value = '';
    $('login-note').textContent = 'Password updated. Sign in with your new password.';
    $('login-note').hidden = false;
    showLoginPanel('login-form');
  } catch (err) {
    $('reset-error').textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save new password';
  }
});

// Both password fields get the same show/hide behaviour.
for (const [toggleId, inputId] of [
  ['pw-toggle', 'password'],
  ['reset-pw-toggle', 'reset-password'],
]) {
  $(toggleId).addEventListener('click', () => {
    const input = $(inputId);
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    $(toggleId).textContent = show ? 'Hide' : 'Show';
    $(toggleId).setAttribute('aria-pressed', String(show));
    $(toggleId).setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    input.focus();
  });
}

/**
 * Landing on /reset?token=… opens the new-password card. The token is checked
 * before the form is shown, so a stale link says so immediately instead of
 * after someone has typed a password twice.
 */
let resetToken = null;

/**
 * Synchronous on purpose. The boot line branches on the return value, and an
 * `async` function hands back a Promise — always truthy — which would stop
 * `start()` running for everyone. The token check that follows is a courtesy
 * and runs on its own.
 */
function openResetIfLinked() {
  const raw = new URLSearchParams(location.search).get('token');
  if (!raw || location.pathname !== '/reset') return false;

  resetToken = raw;
  showLoginPanel('reset-form');
  verifyResetToken(raw);
  return true;
}

async function verifyResetToken(raw) {
  let valid = false;
  try {
    const res = await fetch(`/api/password/reset?token=${encodeURIComponent(raw)}`);
    valid = (await res.json()).valid === true;
  } catch {
    // Offline. Leave the form usable — submitting is the only way to find out,
    // and the POST re-checks the token anyway.
    return;
  }
  if (valid) return;

  for (const el of $('reset-form').querySelectorAll('input, button[type=submit]')) {
    el.disabled = true;
  }
  $('reset-error').textContent =
    'This reset link has expired or has already been used. Request a new one.';
}

function start() {
  $('login').hidden = true;
  $('app').hidden = false;

  // Administration is only shown to the platform admin. The server enforces
  // this too — hiding the buttons alone would not stop anyone.
  $('admin-group').hidden = me?.role !== 'admin';
  $('who').textContent = me?.role === 'admin'
    ? `Signed in as ${me.name} — platform administrator`
    : `${me?.officeName || ''}`;

  connectSocket();

  // Land on whatever the URL asks for, so a refresh or a bookmarked page
  // reopens where the user left off.
  show(viewForPath(location.pathname), { push: false });

  // Fold the rail's bigger sections once the current view is known, so the
  // group holding it is left open.
  initNavGroups();
}


// ---- Receipt designer -----------------------------------------------------
//
// Edits the venue's printed receipt: logo, address, wording and layout. The
// preview mirrors what the till's PDF builder produces, so what is approved
// here is what a customer is handed. Saving broadcasts, and the tills pick the
// change up without being restarted.

/** Defaults must match the server's, or an unsaved venue previews wrongly. */
const RD_DEFAULTS = {
  venue_name: '', logo_url: null, address_line1: '', address_line2: '',
  city: '', postcode: '', phone: '', website: '', vat_number: '',
  company_number: '', header_note: '',
  footer_message: 'Thank you for your custom', footer_note: '', social_line: '',
  paper_width_mm: 80, show_logo: 1, show_vat_breakdown: 1, show_barcode: 1,
  show_qr: 0, qr_url: '', show_served_by: 1, show_powered_by: 1,
};

let rdState = { ...RD_DEFAULTS };
let rdSaved = { ...RD_DEFAULTS };
let rdBound = false;

/** Venue-supplied text goes into innerHTML, so it must be escaped. */
function rdEsc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

async function loadReceiptDesigner() {
  try {
    const row = await api('/branding');
    rdState = { ...RD_DEFAULTS, ...row };
  } catch (err) {
    // A venue that has never saved still gets a usable editor.
    rdState = { ...RD_DEFAULTS };
  }
  rdSaved = { ...rdState };
  rdBind();
  rdFillForm();
  rdRenderPreview();
}

/** Wired once: the view is re-rendered on every navigation. */
function rdBind() {
  if (rdBound) return;
  rdBound = true;

  document.querySelectorAll('[data-rd]').forEach((el) => {
    const key = el.dataset.rd;
    const event = el.type === 'checkbox' || el.tagName === 'SELECT' ? 'change' : 'input';
    el.addEventListener(event, () => {
      if (el.type === 'checkbox') rdState[key] = el.checked ? 1 : 0;
      else if (key === 'paper_width_mm') rdState[key] = Number(el.value);
      else rdState[key] = el.value;
      rdRenderPreview();
    });
  });

  $('rd-save').addEventListener('click', rdSave);
  $('rd-reset').addEventListener('click', () => {
    rdState = { ...rdSaved };
    rdFillForm();
    rdRenderPreview();
  });

  $('rd-logo-pick').addEventListener('click', () => $('rd-logo-file').click());
  $('rd-logo-file').addEventListener('change', rdUploadLogo);
  $('rd-logo-clear').addEventListener('click', () => {
    rdState.logo_url = null;
    rdFillForm();
    rdRenderPreview();
  });

  // Printing the preview is how a venue checks the layout on its real roll
  // before a customer ever sees it.
  $('rd-print').addEventListener('click', () => window.print());
}

function rdFillForm() {
  document.querySelectorAll('[data-rd]').forEach((el) => {
    const value = rdState[el.dataset.rd];
    if (el.type === 'checkbox') el.checked = !!Number(value);
    else el.value = value ?? '';
  });

  const preview = $('rd-logo-preview');
  preview.innerHTML = rdState.logo_url
    ? `<img src="${rdEsc(rdState.logo_url)}" alt="Venue logo">`
    : '<span class="muted small">No logo</span>';
}

async function rdUploadLogo(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  const body = new FormData();
  body.append('image', file);
  try {
    // FormData sets its own multipart boundary, so the JSON content-type the
    // api() helper adds must not be used here.
    const res = await fetch('/api/branding/logo', {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body,
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Upload failed');
    const { url } = await res.json();
    rdState.logo_url = url;
    rdFillForm();
    rdRenderPreview();
  } catch (err) {
    alert(err.message);
  } finally {
    // Let the same file be picked again after a failure.
    event.target.value = '';
  }
}

async function rdSave() {
  const button = $('rd-save');
  button.disabled = true;
  button.textContent = 'Saving…';
  try {
    const row = await api('/branding', {
      method: 'PUT',
      body: JSON.stringify(rdState),
    });
    rdState = { ...RD_DEFAULTS, ...row };
    rdSaved = { ...rdState };
    rdFillForm();
    rdRenderPreview();
    button.textContent = 'Saved ✓';
    setTimeout(() => { button.textContent = 'Save receipt'; }, 1600);
  } catch (err) {
    alert(err.message);
    button.textContent = 'Save receipt';
  } finally {
    button.disabled = false;
  }
}

/**
 * A representative sale, so the preview exercises the parts that are easy to
 * get wrong: a discount, a voucher, mixed VAT rates and a line note.
 */
const RD_SAMPLE = {
  lines: [
    { name: 'Chicken Biryani', qty: 2, unit: 895, tax: 20, note: 'extra spicy' },
    { name: 'Mango Lassi', qty: 1, unit: 360, tax: 0 },
    { name: 'Garlic Naan', qty: 2, unit: 320, tax: 20 },
  ],
  discount: 200,
  voucher: 500,
  voucherCode: 'WELCOME5',
  table: 12,
  covers: 4,
  clerk: 'Sam',
  customer: 'A. Khan',
};

function rdRenderPreview() {
  const s = rdState;
  const paper = $('rd-paper');
  paper.classList.toggle('narrow', Number(s.paper_width_mm) === 58);

  const lines = RD_SAMPLE.lines;
  const gross = lines.reduce((sum, l) => sum + l.unit * l.qty, 0);
  const total = gross - RD_SAMPLE.discount - RD_SAMPLE.voucher;

  // VAT is backed out of the gross, matching the till's calculation.
  const vat = {};
  lines.forEach((l) => {
    if (!l.tax) return;
    const lineGross = l.unit * l.qty;
    const net = Math.round(lineGross / (1 + l.tax / 100));
    vat[l.tax] = vat[l.tax] || { net: 0, vat: 0 };
    vat[l.tax].net += net;
    vat[l.tax].vat += lineGross - net;
  });

  const now = new Date();
  const row = (left, right, cls = '') =>
    `<div class="rp-row ${cls}"><span>${rdEsc(left)}</span><span>${rdEsc(right)}</span></div>`;

  const address = [s.address_line1, s.address_line2,
    [s.city, s.postcode].filter(Boolean).join(' ')].filter((v) => v && v.trim());

  let html = '';

  if (Number(s.show_logo) && s.logo_url) {
    html += `<div class="rp-logo"><img src="${rdEsc(s.logo_url)}" alt=""></div>`;
  }
  html += `<div class="rp-name">${rdEsc((s.venue_name || 'Your venue').toUpperCase())}</div>`;
  address.forEach((l) => { html += `<div class="rp-centre">${rdEsc(l)}</div>`; });
  if (s.phone) html += `<div class="rp-centre">Tel ${rdEsc(s.phone)}</div>`;
  if (s.website) html += `<div class="rp-centre">${rdEsc(s.website)}</div>`;
  if (s.vat_number) html += `<div class="rp-centre">VAT No ${rdEsc(s.vat_number)}</div>`;
  if (s.header_note) html += `<div class="rp-centre rp-note">${rdEsc(s.header_note)}</div>`;

  html += '<div class="rp-rule"></div>';
  html += row('Date', now.toLocaleDateString('en-GB',
    { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }));
  html += row('Time', now.toLocaleTimeString('en-GB',
    { hour: '2-digit', minute: '2-digit' }));
  html += row('Table', String(RD_SAMPLE.table));
  html += row('Covers', String(RD_SAMPLE.covers));
  if (Number(s.show_served_by)) html += row('Served by', RD_SAMPLE.clerk);
  html += row('Customer', RD_SAMPLE.customer);
  html += '<div class="rp-rule"></div>';

  lines.forEach((l) => {
    html += row(`${l.qty}  ${l.name}`, money(l.unit * l.qty));
    if (l.qty !== 1) html += `<div class="rp-sub">@ ${money(l.unit)} each</div>`;
    if (l.note) html += `<div class="rp-sub rp-italic">* ${rdEsc(l.note)}</div>`;
  });

  html += '<div class="rp-rule"></div>';
  html += row('Subtotal', money(gross));
  html += row('Discount', `-${money(RD_SAMPLE.discount)}`);
  html += row(`Voucher ${RD_SAMPLE.voucherCode}`, `-${money(RD_SAMPLE.voucher)}`);
  html += `<div class="rp-total"><span>TOTAL</span><span>${money(total)}</span></div>`;
  html += row('Card', money(total));

  if (Number(s.show_vat_breakdown) && Object.keys(vat).length) {
    html += '<div class="rp-rule"></div><div class="rp-sub">VAT ANALYSIS</div>';
    html += '<div class="rp-row rp-sub"><span>Rate</span><span>Net / VAT</span></div>';
    Object.keys(vat).sort().forEach((rate) => {
      html += `<div class="rp-row rp-sub"><span>${rdEsc(rate)}%</span>` +
        `<span>${money(vat[rate].net)} / ${money(vat[rate].vat)}</span></div>`;
    });
  }

  html += '<div class="rp-rule heavy"></div>';
  if (s.footer_message) html += `<div class="rp-footer">${rdEsc(s.footer_message)}</div>`;
  if (s.footer_note) html += `<div class="rp-centre rp-note">${rdEsc(s.footer_note)}</div>`;
  if (s.social_line) html += `<div class="rp-centre rp-note">${rdEsc(s.social_line)}</div>`;
  if (Number(s.show_barcode)) html += '<div class="rp-barcode"></div>';
  if (Number(s.show_qr) && s.qr_url) html += '<div class="rp-qr">QR</div>';
  html += '<div class="rp-centre rp-note">Receipt 3F2A91B4</div>';
  if (s.company_number) {
    html += `<div class="rp-centre rp-note">Co. No ${rdEsc(s.company_number)}</div>`;
  }
  if (Number(s.show_powered_by)) {
    html += '<div class="rp-centre rp-note">Powered by VESOPA EPOS</div>';
  }

  paper.innerHTML = html;
}

// ---- Commerce: promotions, gift cards, deposits, loyalty, tender, rules ----
//
// These share a shape: a stats strip, a table, and a chart where the numbers
// mean something over time. Money is always handled in minor units and only
// formatted at the edge, so no rounding creeps in through the UI.

const pence = (v) => Math.round((Number(v) || 0) * 100);
const pounds = (minor) => ((Number(minor) || 0) / 100).toFixed(2);

/// MySQL sends SUM()/AVG() as strings; adding them without coercion
/// concatenates. Every aggregate goes through this before arithmetic.
const num = (v) => Number(v) || 0;

/** Renders the small headline cards above a table. */
function statCards(el, cards) {
  el.innerHTML = cards
    .map((c) => `<div class="card stat-card ${c.tone || ''}">
      <span class="stat-label">${esc(c.label)}</span>
      <span class="stat-value">${esc(c.value)}</span>
      ${c.hint ? `<span class="stat-hint">${esc(c.hint)}</span>` : ''}
    </div>`)
    .join('');
}

// ---- Dashboard analytics --------------------------------------------------

// Today, matching the button marked active in the markup. The two have to
// agree or the dashboard opens showing one range with another highlighted.
let dashDays = 1;

async function loadDashboardAnalytics() {
  let data;
  try {
    data = await api(`/analytics/overview?days=${dashDays}`);
  } catch (err) {
    // The dashboard must still render its live-sales table if analytics fail —
    // but the failure has to be visible, not swallowed. A silent catch here
    // once hid a load-order bug that left every chart blank.
    console.error('Dashboard analytics failed:', err);
    const strip = $('dash-stats');
    if (strip) {
      strip.innerHTML =
        '<p class="muted small">Could not load analytics. ' +
        'The live sales table below is unaffected.</p>';
    }
    return;
  }

  const t = data.totals || {};
  const p = data.previous || {};
  const net = num(t.gross_minor) - num(t.tax_minor);

  statCards($('dash-stats'), [
    { label: 'Gross takings', value: `£${pounds(t.gross_minor)}`,
      hint: trendHint(t.gross_minor, p.gross_minor), tone: 'primary' },
    { label: 'Net of VAT', value: `£${pounds(net)}` },
    { label: 'VAT', value: `£${pounds(t.tax_minor)}`, tone: 'amber' },
    { label: 'Sales', value: String(t.sales || 0),
      hint: trendHint(t.sales, p.sales), tone: 'blue' },
    { label: 'Average sale', value: `£${pounds(t.average_minor)}` },
    { label: 'Gratuity', value: `£${pounds(t.gratuity_minor)}`, tone: 'green' },
    { label: 'Discounts',
      value: `£${pounds(num(t.discount_minor) + num(t.promo_minor) + num(t.voucher_minor))}`,
      tone: 'red' },
    { label: 'Covers', value: String(t.covers || 0) },
  ]);

  // Named the way the range button is, so the figure on screen and the button
  // that produced it agree. "Last 1 days" was the giveaway that they did not.
  $('dash-window').textContent = data.window_days === 1
    ? 'Today'
    : `Last ${data.window_days} days`;

  Charts.line($('dash-line'), (data.daily || []).map((d) => ({
    label: shortDate(d.day),
    value: d.gross_minor,
  })));

  Charts.bar($('dash-hourly'), (data.hourly || []).map((h) => ({
    label: `${String(h.hour).padStart(2, '0')}`,
    value: h.gross_minor,
  })), { colour: '#4361ee' });

  Charts.donut($('dash-tenders'), (data.tenders || []).map((x) => ({
    label: tenderLabel(x.method),
    value: x.total_minor,
  })));

  Charts.ranked($('dash-products'), (data.top_products || []).map((x) => ({
    label: x.name,
    value: x.gross_minor,
    meta: `${Number(x.qty || 0)} sold`,
  })));

  Charts.ranked($('dash-departments'), (data.departments || []).map((x) => ({
    label: x.department,
    value: x.gross_minor,
  })), { colour: '#4cc9f0' });

  // MySQL DAYOFWEEK is 1=Sunday.
  const DOW = ['', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  Charts.bar($('dash-weekday'), (data.weekday || []).map((w) => ({
    label: DOW[w.dow] || String(w.dow),
    value: w.gross_minor,
  })), { colour: '#7209b7' });

  const l = data.liabilities || {};
  const s = data.stock || {};
  const c = data.customers || {};
  $('dash-liabilities').innerHTML = `
    <div class="mini-list">
      <div><span>Gift card balances outstanding</span><b>£${pounds(l.gift_card_minor)}</b></div>
      <div><span>Deposits held</span><b>£${pounds(l.deposit_minor)}</b></div>
      <div><span>Loyalty points outstanding</span><b>${Number(c.points_outstanding || 0)}</b></div>
      <div><span>Customers active (30d)</span><b>${Number(c.active_30d || 0)} of ${Number(c.total || 0)}</b></div>
      <div class="${Number(s.out_of_stock) ? 'warn' : ''}"><span>Out of stock</span><b>${Number(s.out_of_stock || 0)}</b></div>
      <div class="${Number(s.low_stock) ? 'warn' : ''}"><span>Low stock</span><b>${Number(s.low_stock || 0)}</b></div>
    </div>`;
}

function trendHint(now, before) {
  const a = Number(now) || 0;
  const b = Number(before) || 0;
  if (!b) return '';
  const change = ((a - b) / b) * 100;
  return `${change >= 0 ? '▲' : '▼'} ${Math.abs(change).toFixed(1)}% vs previous`;
}

function shortDate(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? String(value).slice(5)
    : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function tenderLabel(method) {
  const m = String(method || '').toLowerCase();
  return {
    cash: 'Cash', card: 'Card', voucher: 'Voucher', giftcard: 'Gift card',
    gift_card: 'Gift card', deposit: 'Deposit', account: 'On account',
    points: 'Loyalty points',
  }[m] || (m ? m[0].toUpperCase() + m.slice(1) : 'Other');
}

// Range switcher on the dashboard.
document.addEventListener('click', (e) => {
  const btn = e.target.closest('#dash-range .seg-btn');
  if (!btn) return;
  dashDays = Number(btn.dataset.days) || 1;
  document.querySelectorAll('#dash-range .seg-btn')
    .forEach((b) => b.classList.toggle('active', b === btn));
  loadDashboardAnalytics();
});

// ---- Promotions -----------------------------------------------------------

const PROMO_KINDS = {
  percent: 'Percentage off',
  amount: 'Amount off',
  fixed_price: 'Fixed price',
  multibuy: 'Multi-buy',
  bogof: 'Buy one get one',
};

async function loadPromotions() {
  const rows = await api('/promotions');
  const live = rows.filter((r) => r.active).length;

  statCards($('promo-stats'), [
    { label: 'Promotions', value: String(rows.length), tone: 'primary' },
    { label: 'Live now', value: String(live), tone: 'green' },
    { label: 'Multi-buy deals', value: String(rows.filter((r) => r.kind === 'multibuy').length) },
    { label: 'Scheduled', value: String(rows.filter((r) => r.starts_on).length), tone: 'blue' },
  ]);

  $('promotions').innerHTML = rows.map((r) => `
    <tr>
      <td><b>${esc(r.name)}</b></td>
      <td>${esc(PROMO_KINDS[r.kind] || r.kind)}</td>
      <td class="small">${esc(promoScope(r))}</td>
      <td>${esc(promoValue(r))}</td>
      <td class="small muted">${esc(promoWindow(r))}</td>
      <td>${r.badge_text
        ? `<span class="promo-badge" style="background:${esc(r.badge_colour || '#d81b60')}">${esc(r.badge_text)}</span>`
        : '<span class="muted small">—</span>'}</td>
      <td>${r.active ? '<span class="pill on">Live</span>' : '<span class="pill">Off</span>'}</td>
      <td class="right">
        <button class="btn small" data-promo-edit="${r.id}">Edit</button>
        <button class="btn small danger-ghost" data-promo-del="${r.id}">Delete</button>
      </td>
    </tr>`).join('') || '<tr><td colspan="8" class="muted">No promotions yet.</td></tr>';

  // Performance, when there is any.
  try {
    const perf = await api(`/analytics/promotions?days=90`);
    Charts.ranked($('promo-chart'), (perf.promotions || []).map((p) => ({
      label: p.name,
      value: p.discount_minor,
      meta: `${p.uses} uses`,
    })), { colour: '#f72585' });
  } catch { /* chart is a nicety; the table is the page */ }
}

function promoScope(r) {
  if (r.scope === 'order') return 'Whole sale';
  if (r.scope === 'department') return `Department: ${r.scope_value || 'any'}`;
  if (r.scope === 'group') return `Group: ${r.scope_value || 'any'}`;
  const count = (r.products || []).length;
  return count ? `${count} product${count === 1 ? '' : 's'}` : 'No products yet';
}

function promoValue(r) {
  switch (r.kind) {
    case 'percent': return `${(r.value / 10).toFixed(1)}%`;
    case 'amount': return `£${pounds(r.value)} off`;
    case 'fixed_price': return `£${pounds(r.value)}`;
    case 'multibuy': return `${r.buy_qty} for £${pounds(r.deal_price_minor)}`;
    case 'bogof': return `Buy ${r.buy_qty} get ${r.free_qty} free`;
    default: return '—';
  }
}

function promoWindow(r) {
  const from = r.starts_on ? new Date(r.starts_on).toLocaleDateString('en-GB') : null;
  const to = r.ends_on ? new Date(r.ends_on).toLocaleDateString('en-GB') : null;
  if (!from && !to) return 'Always';
  return `${from || '…'} → ${to || '…'}`;
}

function promoFields(row = {}) {
  return [
    { name: 'name', label: 'Name', value: row.name || '' },
    { name: 'kind', label: 'Type', type: 'select', value: row.kind || 'percent',
      options: Object.entries(PROMO_KINDS).map(([v, l]) => ({ value: v, label: l })) },
    { name: 'value', label: 'Value (percent ×10, or pence)', type: 'number',
      value: row.value ?? 0 },
    { name: 'buy_qty', label: 'Multi-buy: buy quantity', type: 'number', value: row.buy_qty ?? 0 },
    { name: 'free_qty', label: 'Multi-buy: free quantity', type: 'number', value: row.free_qty ?? 0 },
    { name: 'deal_price_minor', label: 'Multi-buy: deal price (pence)', type: 'number',
      value: row.deal_price_minor ?? 0 },
    { name: 'scope', label: 'Applies to', type: 'select', value: row.scope || 'product',
      options: [
        { value: 'product', label: 'Named products' },
        { value: 'department', label: 'A department' },
        { value: 'group', label: 'A group' },
        { value: 'order', label: 'The whole sale' },
      ] },
    { name: 'scope_value', label: 'Department / group name', value: row.scope_value || '' },
    { name: 'products', label: 'Product PLUs (comma separated)',
      value: (row.products || []).join(',') },
    { name: 'min_spend_minor', label: 'Minimum spend (pence)', type: 'number',
      value: row.min_spend_minor ?? 0 },
    { name: 'starts_on', label: 'Starts', type: 'date', value: dateVal(row.starts_on) },
    { name: 'ends_on', label: 'Ends', type: 'date', value: dateVal(row.ends_on) },
    { name: 'badge_text', label: 'Badge on the till button', value: row.badge_text || '' },
    { name: 'badge_colour', label: 'Badge colour', type: 'color',
      value: row.badge_colour || '#d81b60' },
    { name: 'priority', label: 'Priority (higher wins)', type: 'number', value: row.priority ?? 0 },
    { name: 'stackable', label: 'Can combine with other offers', type: 'checkbox',
      value: !!row.stackable },
    { name: 'active', label: 'Active', type: 'checkbox', value: row.active !== 0 },
  ];
}

function dateVal(v) {
  if (!v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

function promoPayload(data) {
  return {
    ...data,
    value: Number(data.value) || 0,
    buy_qty: Number(data.buy_qty) || 0,
    free_qty: Number(data.free_qty) || 0,
    deal_price_minor: Number(data.deal_price_minor) || 0,
    min_spend_minor: Number(data.min_spend_minor) || 0,
    priority: Number(data.priority) || 0,
    stackable: !!data.stackable,
    active: !!data.active,
    // The PLU list is typed as text; anything non-numeric is dropped rather
    // than sent as NaN.
    products: String(data.products || '')
      .split(',').map((s) => Number(s.trim())).filter(Number.isFinite),
  };
}

document.addEventListener('click', async (e) => {
  if (e.target.id === 'promo-add') {
    modal('New promotion', promoFields(), async (data) => {
      await api('/promotions', { method: 'POST', body: JSON.stringify(promoPayload(data)) });
      loadPromotions();
    });
  }
  const edit = e.target.dataset?.promoEdit;
  if (edit) {
    const rows = await api('/promotions');
    const row = rows.find((r) => String(r.id) === edit);
    if (row) {
      modal('Edit promotion', promoFields(row), async (data) => {
        await api(`/promotions/${edit}`, { method: 'PUT', body: JSON.stringify(promoPayload(data)) });
        loadPromotions();
      });
    }
  }
  const del = e.target.dataset?.promoDel;
  if (del && confirm('Delete this promotion?')) {
    await api(`/promotions/${del}`, { method: 'DELETE' });
    loadPromotions();
  }
});

// ---- Gift cards -----------------------------------------------------------

async function loadGiftCards() {
  const rows = await api('/gift-cards');
  const active = rows.filter((r) => r.status === 'active');
  const outstanding = active.reduce((s, r) => s + (r.balance_minor || 0), 0);
  const issued = rows.reduce((s, r) => s + (r.initial_minor || 0), 0);

  statCards($('gift-stats'), [
    { label: 'Cards issued', value: String(rows.length), tone: 'primary' },
    { label: 'Active', value: String(active.length), tone: 'green' },
    { label: 'Balance outstanding', value: `£${pounds(outstanding)}`, tone: 'amber',
      hint: 'Money owed in goods' },
    { label: 'Total issued', value: `£${pounds(issued)}` },
  ]);

  $('gift-cards').innerHTML = rows.map((r) => `
    <tr>
      <td><code>${esc(r.code)}</code></td>
      <td>${r.kind === 'paper' ? 'Paper' : 'Smart'}</td>
      <td>${esc(r.recipient_name || '—')}</td>
      <td class="right">£${pounds(r.initial_minor)}</td>
      <td class="right"><b>£${pounds(r.balance_minor)}</b></td>
      <td class="small muted">${r.expires_on ? new Date(r.expires_on).toLocaleDateString('en-GB') : '—'}</td>
      <td><span class="pill ${r.status === 'active' ? 'on' : ''}">${esc(r.status)}</span></td>
      <td class="right">
        ${r.reloadable && r.status === 'active'
          ? `<button class="btn small" data-gift-reload="${r.id}">Top up</button>` : ''}
        <button class="btn small" data-gift-history="${r.id}">History</button>
        ${r.status === 'active'
          ? `<button class="btn small danger-ghost" data-gift-void="${r.id}">Void</button>` : ''}
      </td>
    </tr>`).join('') || '<tr><td colspan="8" class="muted">No gift cards issued yet.</td></tr>';
}

document.addEventListener('click', async (e) => {
  if (e.target.id === 'gift-add') {
    modal('Issue gift card', [
      { name: 'amount', label: 'Value (£)', type: 'number', value: '25' },
      { name: 'kind', label: 'Type', type: 'select', value: 'smart', options: [
        { value: 'smart', label: 'Smart — keeps a balance, reloadable' },
        { value: 'paper', label: 'Paper — redeemed once for its face value' },
      ] },
      { name: 'recipient_name', label: 'Recipient', value: '' },
      { name: 'expires_on', label: 'Expires', type: 'date', value: '' },
      { name: 'code', label: 'Code (blank to generate)', value: '' },
    ], async (data) => {
      await api('/gift-cards', {
        method: 'POST',
        body: JSON.stringify({
          initial_minor: pence(data.amount),
          kind: data.kind,
          recipient_name: data.recipient_name || null,
          expires_on: data.expires_on || null,
          code: data.code || undefined,
        }),
      });
      loadGiftCards();
    });
  }

  const reload = e.target.dataset?.giftReload;
  if (reload) {
    modal('Top up gift card', [
      { name: 'amount', label: 'Add (£)', type: 'number', value: '10' },
    ], async (data) => {
      await api(`/gift-cards/${reload}/reload`, {
        method: 'POST',
        body: JSON.stringify({ amount_minor: pence(data.amount) }),
      });
      loadGiftCards();
    });
  }

  const history = e.target.dataset?.giftHistory;
  if (history) {
    const txns = await api(`/gift-cards/${history}/transactions`);
    showPanel('Gift card history', `
      <table class="plain"><thead>
        <tr><th>When</th><th>Type</th><th class="right">Amount</th><th class="right">Balance</th><th>Note</th></tr>
      </thead><tbody>
        ${txns.map((t) => `<tr>
          <td class="small">${new Date(t.created_at).toLocaleString('en-GB')}</td>
          <td>${esc(t.kind)}</td>
          <td class="right ${t.amount_minor < 0 ? 'neg' : 'pos'}">£${pounds(Math.abs(t.amount_minor))}</td>
          <td class="right">£${pounds(t.balance_after)}</td>
          <td class="small muted">${esc(t.note || '')}</td>
        </tr>`).join('') || '<tr><td colspan="5" class="muted">No movements.</td></tr>'}
      </tbody></table>`);
  }

  const voidId = e.target.dataset?.giftVoid;
  if (voidId && confirm('Void this gift card? Its balance will no longer be redeemable.')) {
    await api(`/gift-cards/${voidId}/void`, { method: 'PUT' });
    loadGiftCards();
  }
});

// ---- Deposits -------------------------------------------------------------

async function loadDeposits() {
  const rows = await api('/deposits');
  const held = rows.filter((r) => r.status === 'held');
  const outstanding = held.reduce((s, r) => s + (r.amount_minor - r.redeemed_minor), 0);

  statCards($('deposit-stats'), [
    { label: 'Deposits', value: String(rows.length), tone: 'primary' },
    { label: 'Currently held', value: String(held.length), tone: 'blue' },
    { label: 'Value held', value: `£${pounds(outstanding)}`, tone: 'amber',
      hint: 'Owed against future bills' },
    { label: 'Redeemed', value: String(rows.filter((r) => r.status === 'redeemed').length),
      tone: 'green' },
  ]);

  $('deposits').innerHTML = rows.map((r) => `
    <tr>
      <td><code>${esc(r.reference)}</code></td>
      <td>${esc(r.customer_name || '—')}<br><span class="muted small">${esc(r.customer_phone || '')}</span></td>
      <td class="small">${esc(r.description || '—')}</td>
      <td class="right">£${pounds(r.amount_minor)}</td>
      <td class="right">£${pounds(r.redeemed_minor)}</td>
      <td class="small muted">${r.due_on ? new Date(r.due_on).toLocaleDateString('en-GB') : '—'}</td>
      <td><span class="pill ${r.status === 'held' ? 'on' : ''}">${esc(r.status)}</span></td>
      <td class="right"><button class="btn small" data-deposit-edit="${r.id}">Edit</button></td>
    </tr>`).join('') || '<tr><td colspan="8" class="muted">No deposits taken yet.</td></tr>';
}

document.addEventListener('click', async (e) => {
  if (e.target.id === 'deposit-add') {
    modal('Take deposit', [
      { name: 'amount', label: 'Deposit (£)', type: 'number', value: '50' },
      { name: 'customer_name', label: 'Customer', value: '' },
      { name: 'customer_phone', label: 'Phone', value: '' },
      { name: 'description', label: 'What it is for', value: '' },
      { name: 'order_total', label: 'Expected total (£)', type: 'number', value: '' },
      { name: 'due_on', label: 'Due date', type: 'date', value: '' },
      { name: 'reference', label: 'Reference (blank to generate)', value: '' },
    ], async (data) => {
      await api('/deposits', {
        method: 'POST',
        body: JSON.stringify({
          amount_minor: pence(data.amount),
          customer_name: data.customer_name || null,
          customer_phone: data.customer_phone || null,
          description: data.description || null,
          order_total_minor: data.order_total ? pence(data.order_total) : null,
          due_on: data.due_on || null,
          reference: data.reference || undefined,
        }),
      });
      loadDeposits();
    });
  }

  const edit = e.target.dataset?.depositEdit;
  if (edit) {
    const rows = await api('/deposits');
    const row = rows.find((r) => r.id === edit);
    if (!row) return;
    modal('Edit deposit', [
      { name: 'customer_name', label: 'Customer', value: row.customer_name || '' },
      { name: 'customer_phone', label: 'Phone', value: row.customer_phone || '' },
      { name: 'description', label: 'What it is for', value: row.description || '' },
      { name: 'due_on', label: 'Due date', type: 'date', value: dateVal(row.due_on) },
      { name: 'status', label: 'Status', type: 'select', value: row.status, options: [
        { value: 'held', label: 'Held' },
        { value: 'redeemed', label: 'Redeemed' },
        { value: 'refunded', label: 'Refunded' },
        { value: 'forfeited', label: 'Forfeited' },
      ] },
      { name: 'notes', label: 'Notes', value: row.notes || '' },
    ], async (data) => {
      await api(`/deposits/${edit}`, { method: 'PUT', body: JSON.stringify(data) });
      loadDeposits();
    });
  }
});

// ---- Loyalty --------------------------------------------------------------

let loyaltyState = null;

async function loadLoyalty() {
  loyaltyState = await api('/loyalty');
  fillLoyaltyForm();
  renderTiers();
  loyaltyExample();

  try {
    const stats = await api('/analytics/loyalty?days=90');
    const byDay = {};
    (stats.movement || []).forEach((m) => {
      byDay[m.day] = byDay[m.day] || { earn: 0, redeem: 0 };
      byDay[m.day][m.kind] = Number(m.points) || 0;
    });
    Charts.line($('loyalty-chart'),
      Object.entries(byDay).map(([day, v]) => ({
        label: shortDate(day), value: v.earn,
      })),
      { colour: '#06d6a0', format: (v) => `${v} pts` });

    Charts.ranked($('loyalty-top'), (stats.top_customers || []).map((c) => ({
      label: c.name || 'Guest',
      value: c.lifetime_spend_minor,
      meta: `${c.points_balance} pts${c.tier_name ? ` · ${c.tier_name}` : ''}`,
    })), { limit: 8, colour: '#4361ee' });

    const totals = (stats.tiers || []).reduce((s, t) => s + Number(t.customers || 0), 0);
    const points = (stats.tiers || []).reduce((s, t) => s + Number(t.points || 0), 0);
    statCards($('loyalty-stats'), [
      { label: 'Members', value: String(totals), tone: 'primary' },
      { label: 'Points outstanding', value: String(points), tone: 'amber',
        hint: `Worth £${pounds(points * (loyaltyState.point_value_minor || 1))}` },
      { label: 'Tiers', value: String((loyaltyState.tiers || []).length), tone: 'blue' },
      { label: 'Programme', value: loyaltyState.enabled ? 'On' : 'Off',
        tone: loyaltyState.enabled ? 'green' : 'red' },
    ]);
  } catch { /* stats are supplementary */ }
}

function fillLoyaltyForm() {
  document.querySelectorAll('[data-loy]').forEach((el) => {
    const v = loyaltyState[el.dataset.loy];
    if (el.type === 'checkbox') el.checked = !!Number(v);
    else el.value = v ?? 0;
  });
}

function renderTiers() {
  const tiers = loyaltyState.tiers || [];
  $('loyalty-tiers').innerHTML = tiers.map((t, i) => `
    <div class="tier-row" data-tier="${i}">
      <input class="tier-name" value="${esc(t.name)}" placeholder="Tier name">
      <label class="tier-field">From £<input type="number" class="tier-spend"
        value="${((t.min_spend_minor || 0) / 100).toFixed(0)}"></label>
      <label class="tier-field">Disc %<input type="number" step="0.1" class="tier-disc"
        value="${Number(t.discount_percent || 0)}"></label>
      <label class="tier-field">×pts<input type="number" step="0.1" class="tier-mult"
        value="${Number(t.points_multiplier || 1)}"></label>
      <input type="color" class="tier-colour" value="${esc(t.colour || '#8e8e93')}">
      <button class="btn small danger-ghost" data-tier-del="${i}">Remove</button>
    </div>`).join('') || '<p class="muted small">No tiers. Everyone earns at the base rate.</p>';
}

function loyaltyExample() {
  const perPound = Number($('loyalty-tiers') && loyaltyState.points_per_pound) || 0;
  const value = Number(loyaltyState.point_value_minor) || 0;
  const minRedeem = Number(loyaltyState.min_redeem_points) || 0;
  const el = $('loyalty-example');
  if (!el) return;
  el.textContent = `A £25 sale earns ${Math.floor(25) * perPound} points. ` +
    `${minRedeem} points is worth £${pounds(minRedeem * value)}.`;
}

document.addEventListener('input', (e) => {
  if (!loyaltyState || !e.target.dataset?.loy) return;
  const key = e.target.dataset.loy;
  loyaltyState[key] = e.target.type === 'checkbox'
    ? (e.target.checked ? 1 : 0)
    : Number(e.target.value) || 0;
  loyaltyExample();
});

document.addEventListener('click', async (e) => {
  if (e.target.id === 'tier-add') {
    loyaltyState.tiers = loyaltyState.tiers || [];
    loyaltyState.tiers.push({
      name: `Tier ${loyaltyState.tiers.length + 1}`,
      min_spend_minor: 0, discount_percent: 0, points_multiplier: 1,
      colour: Charts.PALETTE[loyaltyState.tiers.length % Charts.PALETTE.length],
    });
    renderTiers();
  }
  const del = e.target.dataset?.tierDel;
  if (del != null && loyaltyState) {
    loyaltyState.tiers.splice(Number(del), 1);
    renderTiers();
  }
  if (e.target.id === 'loyalty-save') {
    // Read the tier rows back out of the DOM: they are edited in place.
    const tiers = [...document.querySelectorAll('.tier-row')].map((row) => ({
      name: row.querySelector('.tier-name').value,
      min_spend_minor: pence(row.querySelector('.tier-spend').value),
      discount_percent: Number(row.querySelector('.tier-disc').value) || 0,
      points_multiplier: Number(row.querySelector('.tier-mult').value) || 1,
      colour: row.querySelector('.tier-colour').value,
    }));
    await api('/loyalty', {
      method: 'PUT',
      body: JSON.stringify({ ...loyaltyState, tiers }),
    });
    e.target.textContent = 'Saved ✓';
    setTimeout(() => { e.target.textContent = 'Save loyalty'; }, 1500);
    loadLoyalty();
  }
});

// ---- Tender & gratuity ----------------------------------------------------

let tenderState = null;

async function loadTender() {
  tenderState = await api('/tender-settings');
  document.querySelectorAll('[data-tender]').forEach((el) => {
    const v = tenderState[el.dataset.tender];
    if (el.type === 'checkbox') el.checked = !!Number(v);
    else el.value = v ?? '';
  });
  renderTenderPreview();
  await loadDenominations();
}

// ---- Idle screen ----------------------------------------------------------
//
// What the till shows between customers. Held as a whole object and saved in
// one go, like the tender settings: the switches interact (a PIN prompt makes
// no sense with the idle screen off), so saving one field at a time would let
// a half-applied combination reach the counter.

let idleState = {};

async function loadIdle() {
  idleState = await api('/till-settings');
  document.querySelectorAll('[data-idle]').forEach((el) => {
    const v = idleState[el.dataset.idle];
    if (el.type === 'checkbox') el.checked = !!Number(v);
    else el.value = v ?? '';
  });
  renderIdlePreview();
}

/**
 * Draw the preview.
 *
 * With no image this mirrors what the terminal actually draws — the on-dark
 * lockup over the lime rule — rather than showing an empty box. A manager
 * should be able to see that "no image" is a designed screen and not a fault.
 */
function renderIdlePreview() {
  const box = $('idle-preview');
  if (!box) return;

  const message = String(idleState.idle_message ?? '').trim();
  const caption = message ? `<span class="idle-msg">${esc(message)}</span>` : '';

  box.innerHTML = idleState.idle_image_url
    ? `<img src="${esc(idleState.idle_image_url)}" alt="Idle screen background">${caption}`
    : `<span class="idle-fallback">
         <img src="/assets/vesopa_logo_on_dark.png" alt="Vesopa">
         <span class="idle-rule"></span>
       </span>${caption}`;
}

async function idleUploadImage(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  const body = new FormData();
  body.append('image', file);
  try {
    // FormData sets its own multipart boundary, so the JSON content-type the
    // api() helper adds must not be used here.
    const res = await fetch('/api/till-settings/idle-image', {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body,
    });
    if (!res.ok) {
      throw new Error(
        (await res.json().catch(() => ({}))).error || 'Upload failed'
      );
    }
    const { url } = await res.json();
    idleState.idle_image_url = url;
    renderIdlePreview();
  } catch (err) {
    alert(err.message);
  } finally {
    // Let the same file be picked again after a failure.
    event.target.value = '';
  }
}

document.addEventListener('change', (e) => {
  if (e.target.id === 'idle-image') return idleUploadImage(e);
  if (!e.target.dataset?.idle) return;
  idleState[e.target.dataset.idle] = e.target.type === 'checkbox'
    ? (e.target.checked ? 1 : 0)
    : e.target.value;
  renderIdlePreview();
});

document.addEventListener('click', async (e) => {
  if (e.target.id === 'idle-image-clear') {
    idleState.idle_image_url = null;
    return renderIdlePreview();
  }

  if (e.target.id !== 'idle-save') return;
  const button = e.target;
  button.disabled = true;
  try {
    idleState = await api('/till-settings', {
      method: 'PUT',
      body: JSON.stringify(idleState),
    });
    // The server clamps the timer, so read the saved row back into the form
    // rather than leaving a rejected 5 sitting in the box looking accepted.
    await loadIdle();
    button.textContent = 'Saved ✓';
    setTimeout(() => { button.textContent = 'Save settings'; }, 1500);
  } catch (err) {
    alert(err.message);
  } finally {
    button.disabled = false;
  }
});

// ---- Note keys ------------------------------------------------------------
//
// The picture buttons the till shows while a customer counts notes out. Held
// as a local array and saved as a whole set, because the order of the keys is
// part of what is being edited — saving row by row would let a reorder land
// half-applied on the counter.

let denominations = [];
let denominationsInherited = true;

async function loadDenominations() {
  const data = await api('/denominations');
  denominations = data.denominations.map((d) => ({
    value_minor: d.value_minor,
    label: d.label,
    image_url: d.image_url,
    active: d.active !== 0,
  }));
  denominationsInherited = data.inherited;
  renderDenominations();
}

function renderDenominations() {
  const origin = $('denom-origin');
  if (origin) {
    origin.textContent = denominationsInherited
      ? 'Showing the Vesopa specimen notes. Change anything below and this office gets its own set.'
      : 'This office has its own note keys.';
  }

  const host = $('denom-rows');
  if (!host) return;

  host.innerHTML = denominations.map((d, i) => `
    <div class="denom-row" data-denom="${i}">
      <div class="denom-thumb${d.image_url ? ' has-image' : ''}"
           data-denom-image="${i}"
           title="Click to replace this picture"
           ${d.image_url ? `style="background-image:url('${esc(d.image_url)}')"` : ''}>
        ${d.image_url ? '' : 'Add a picture'}
      </div>
      <label class="small muted">Value (pence)
        <input type="number" min="1" step="1" data-denom-value="${i}"
               value="${d.value_minor}" />
      </label>
      <label class="small muted">Label on the key
        <input type="text" maxlength="32" data-denom-label="${i}"
               value="${esc(d.label)}" />
      </label>
      <button type="button" class="btn ghost small" data-denom-remove="${i}">
        Remove
      </button>
    </div>`).join('');
}

/** Keep the local array in step as the operator types. */
document.addEventListener('input', (e) => {
  const value = e.target.dataset?.denomValue;
  const label = e.target.dataset?.denomLabel;
  if (value !== undefined) {
    denominations[Number(value)].value_minor = Number(e.target.value);
  } else if (label !== undefined) {
    denominations[Number(label)].label = e.target.value;
  }
});

document.addEventListener('click', async (e) => {
  const removeAt = e.target.dataset?.denomRemove;
  if (removeAt !== undefined) {
    denominations.splice(Number(removeAt), 1);
    renderDenominations();
    return;
  }

  const imageAt = e.target.closest('[data-denom-image]')?.dataset?.denomImage;
  if (imageAt !== undefined) {
    await pickDenominationImage(Number(imageAt));
    return;
  }

  if (e.target.id === 'denom-add') {
    denominations.push({
      value_minor: 0,
      label: '',
      image_url: null,
      active: true,
    });
    renderDenominations();
    return;
  }

  if (e.target.id === 'denom-reset') {
    if (!confirm('Drop this office\'s note keys and go back to the Vesopa specimen notes?')) {
      return;
    }
    $('denom-error').textContent = '';
    const data = await api('/denominations', { method: 'DELETE' });
    denominations = data.denominations.map((d) => ({
      value_minor: d.value_minor,
      label: d.label,
      image_url: d.image_url,
      active: d.active !== 0,
    }));
    denominationsInherited = data.inherited;
    renderDenominations();
    return;
  }

  if (e.target.id === 'denom-save') {
    $('denom-error').textContent = '';
    try {
      const data = await api('/denominations', {
        method: 'PUT',
        body: JSON.stringify({ denominations }),
      });
      denominationsInherited = data.inherited;
      renderDenominations();
      e.target.textContent = 'Saved ✓';
      setTimeout(() => { e.target.textContent = 'Save note keys'; }, 1500);
    } catch (err) {
      // The server validates values, duplicates and image origins; surface its
      // wording rather than inventing a second, vaguer set of messages.
      $('denom-error').textContent = err.message;
    }
  }
});

/** Upload a replacement picture for one note key. */
async function pickDenominationImage(index) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;

    $('denom-error').textContent = '';
    const body = new FormData();
    body.append('image', file);
    try {
      const res = await fetch('/api/denomination-image', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      denominations[index].image_url = data.url;
      renderDenominations();
    } catch (err) {
      $('denom-error').textContent = err.message;
    }
  });
  input.click();
}

function renderTenderPreview() {
  if (!tenderState) return;
  const grat = String(tenderState.gratuity_presets || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const cash = String(tenderState.cash_presets || '')
    .split(',').map((s) => Number(s.trim())).filter(Number.isFinite);

  $('tender-preview').innerHTML = `
    <div class="till-preview">
      <div class="till-row"><span>Total due</span><b>£42.60</b></div>
      ${Number(tenderState.gratuity_enabled) && tenderState.gratuity_mode !== 'off' ? `
        <p class="muted small" style="margin-top:10px">Gratuity ${
          tenderState.gratuity_mode === 'auto' ? '(added automatically)' : '(clerk is asked)'}</p>
        <div class="till-keys">
          ${grat.map((g) => `<span class="till-key">${esc(g)}%</span>`).join('')}
          <span class="till-key">Custom</span>
        </div>` : '<p class="muted small">Gratuity is off.</p>'}
      <p class="muted small" style="margin-top:12px">Cash keys</p>
      <div class="till-keys">
        ${cash.map((c) => `<span class="till-key cash">£${pounds(c)}</span>`).join('')}
        ${Number(tenderState.cash_quick_round) ? '<span class="till-key cash">Round up</span>' : ''}
        <span class="till-key cash">Exact</span>
      </div>
      <p class="muted small" style="margin-top:12px">Tenders</p>
      <div class="till-keys">
        <span class="till-key">Cash</span>
        <span class="till-key">Card</span>
        <span class="till-key">Manual card</span>
        ${Number(tenderState.allow_partial_card) ? '<span class="till-key">Part card</span>' : ''}
        ${Number(tenderState.allow_split_bill) ? '<span class="till-key">Split bill</span>' : ''}
        <span class="till-key">Gift card</span>
        <span class="till-key">Voucher</span>
        <span class="till-key">Deposit</span>
        <span class="till-key">Points</span>
      </div>
    </div>`;
}

document.addEventListener('input', (e) => {
  if (!tenderState || !e.target.dataset?.tender) return;
  const key = e.target.dataset.tender;
  tenderState[key] = e.target.type === 'checkbox'
    ? (e.target.checked ? 1 : 0)
    : e.target.value;
  renderTenderPreview();
});
document.addEventListener('change', (e) => {
  if (!tenderState || !e.target.dataset?.tender) return;
  tenderState[e.target.dataset.tender] = e.target.type === 'checkbox'
    ? (e.target.checked ? 1 : 0)
    : e.target.value;
  renderTenderPreview();
});

document.addEventListener('click', async (e) => {
  if (e.target.id !== 'tender-save') return;
  await api('/tender-settings', { method: 'PUT', body: JSON.stringify(tenderState) });
  e.target.textContent = 'Saved ✓';
  setTimeout(() => { e.target.textContent = 'Save settings'; }, 1500);
});

// ---- Automation rules -----------------------------------------------------

const RULE_TRIGGERS = {
  sale_total: 'Sale total reaches',
  item_qty: 'Item quantity reaches',
  customer_tier: 'Customer is in tier',
  time_window: 'Time of day is within',
  covers: 'Covers reach',
};

const RULE_ACTIONS = {
  discount_percent: 'Take a percentage off',
  discount_amount: 'Take an amount off',
  add_gratuity: 'Add gratuity',
  issue_voucher: 'Issue a voucher',
  award_points: 'Award bonus points',
  free_item: 'Add a free item',
};

async function loadRules() {
  const rows = await api('/rules');
  $('rules').innerHTML = rows.map((r) => `
    <tr>
      <td><b>${esc(r.name)}</b></td>
      <td class="small">${esc(RULE_TRIGGERS[r.trigger_kind] || r.trigger_kind)}
        <b>${esc(String(r.conditions?.value ?? ''))}</b></td>
      <td class="small">${esc(RULE_ACTIONS[r.actions?.kind] || r.actions?.kind || '—')}
        <b>${esc(String(r.actions?.value ?? ''))}</b></td>
      <td>${r.priority}</td>
      <td>${r.active ? '<span class="pill on">On</span>' : '<span class="pill">Off</span>'}</td>
      <td class="right">
        <button class="btn small" data-rule-edit="${r.id}">Edit</button>
        <button class="btn small danger-ghost" data-rule-del="${r.id}">Delete</button>
      </td>
    </tr>`).join('') || '<tr><td colspan="6" class="muted">No rules yet.</td></tr>';
}

function ruleFields(row = {}) {
  return [
    { name: 'name', label: 'Rule name', value: row.name || '' },
    { name: 'trigger_kind', label: 'When…', type: 'select',
      value: row.trigger_kind || 'sale_total',
      options: Object.entries(RULE_TRIGGERS).map(([v, l]) => ({ value: v, label: l })) },
    { name: 'condition_value', label: '…this value (pence, quantity, or tier name)',
      value: row.conditions?.value ?? '' },
    { name: 'action_kind', label: 'Then…', type: 'select',
      value: row.actions?.kind || 'discount_percent',
      options: Object.entries(RULE_ACTIONS).map(([v, l]) => ({ value: v, label: l })) },
    { name: 'action_value', label: '…by this much (percent ×10, pence, or points)',
      value: row.actions?.value ?? '' },
    { name: 'priority', label: 'Priority (higher wins)', type: 'number', value: row.priority ?? 0 },
    { name: 'active', label: 'Active', type: 'checkbox', value: row.active !== 0 },
  ];
}

function rulePayload(data) {
  return {
    name: data.name,
    trigger_kind: data.trigger_kind,
    conditions: { value: data.condition_value },
    actions: { kind: data.action_kind, value: data.action_value },
    priority: Number(data.priority) || 0,
    active: !!data.active,
  };
}

document.addEventListener('click', async (e) => {
  if (e.target.id === 'rule-add') {
    modal('New rule', ruleFields(), async (data) => {
      await api('/rules', { method: 'POST', body: JSON.stringify(rulePayload(data)) });
      loadRules();
    });
  }
  const edit = e.target.dataset?.ruleEdit;
  if (edit) {
    const rows = await api('/rules');
    const row = rows.find((r) => String(r.id) === edit);
    if (row) {
      modal('Edit rule', ruleFields(row), async (data) => {
        await api(`/rules/${edit}`, { method: 'PUT', body: JSON.stringify(rulePayload(data)) });
        loadRules();
      });
    }
  }
  const del = e.target.dataset?.ruleDel;
  if (del && confirm('Delete this rule?')) {
    await api(`/rules/${del}`, { method: 'DELETE' });
    loadRules();
  }
});

// ---- Templates & subscriptions (super admin) ------------------------------

async function loadTemplates() {
  const rows = await api('/admin/templates');
  $('templates').innerHTML = rows.map((r) => {
    const p = r.payload || {};
    const contents = ['departments', 'groups', 'products', 'tax_rates']
      .filter((k) => (p[k] || []).length)
      .map((k) => `${(p[k] || []).length} ${k.replace('_', ' ')}`)
      .join(', ') || 'Empty';
    return `<tr>
      <td><b>${esc(r.name)}</b><br><span class="muted small">${esc(r.description || '')}</span></td>
      <td>${esc(r.kind)}</td>
      <td class="small">${esc(contents)}</td>
      <td>${r.is_default ? '<span class="pill on">Default</span>' : ''}</td>
      <td>${r.active ? '<span class="pill on">Active</span>' : '<span class="pill">Off</span>'}</td>
      <td class="right">
        <button class="btn small" data-template-edit="${r.id}">Edit</button>
        <button class="btn small danger-ghost" data-template-del="${r.id}">Delete</button>
      </td>
    </tr>`;
  }).join('') || '<tr><td colspan="6" class="muted">No templates yet.</td></tr>';
}

document.addEventListener('click', async (e) => {
  if (e.target.id === 'template-add') {
    const offices = await api('/admin/offices').catch(() => []);
    modal('New template', [
      { name: 'name', label: 'Template name', value: '' },
      { name: 'description', label: 'Description', value: '' },
      { name: 'kind', label: 'Kind', type: 'select', value: 'restaurant', options: [
        { value: 'restaurant', label: 'Restaurant' },
        { value: 'cafe', label: 'Café' },
        { value: 'bar', label: 'Bar' },
        { value: 'retail', label: 'Retail' },
        { value: 'custom', label: 'Custom' },
      ] },
      { name: 'from_office', label: 'Copy catalogue from office (optional)',
        type: 'select', value: '', options: [
          { value: '', label: 'Start empty' },
          ...offices.map((o) => ({ value: String(o.id), label: o.name })),
        ] },
      { name: 'is_default', label: 'Use for new offices by default', type: 'checkbox', value: false },
    ], async (data) => {
      if (data.from_office) {
        await api(`/admin/templates/from-office/${data.from_office}`, {
          method: 'POST',
          body: JSON.stringify({ name: data.name, description: data.description, kind: data.kind }),
        });
      } else {
        await api('/admin/templates', {
          method: 'POST',
          body: JSON.stringify({
            name: data.name, description: data.description, kind: data.kind,
            is_default: !!data.is_default, payload: {},
          }),
        });
      }
      loadTemplates();
    });
  }

  const del = e.target.dataset?.templateDel;
  if (del && confirm('Delete this template? Offices already created from it are unaffected.')) {
    await api(`/admin/templates/${del}`, { method: 'DELETE' });
    loadTemplates();
  }
});

async function loadSubscriptions() {
  const rows = await api('/admin/offices/subscriptions');
  const monthly = rows.reduce((s, r) => s + (r.monthly_fee_minor || 0), 0);

  statCards($('subscription-stats'), [
    { label: 'Offices', value: String(rows.length), tone: 'primary' },
    { label: 'Monthly recurring', value: `£${pounds(monthly)}`, tone: 'green' },
    { label: 'Demo accounts', value: String(rows.filter((r) => r.is_demo).length), tone: 'blue' },
    { label: 'Paused', value: String(rows.filter((r) => r.status !== 'active').length),
      tone: 'red' },
  ]);

  $('subscriptions').innerHTML = rows.map((r) => `
    <tr>
      <td><b>${esc(r.name)}</b>${r.is_demo ? ' <span class="pill">demo</span>' : ''}</td>
      <td class="small">${esc(r.contact_email)}</td>
      <td class="small muted">${new Date(r.created_at).toLocaleDateString('en-GB')}</td>
      <td class="small">${esc(r.template_name || '—')}</td>
      <td class="right">£${pounds(r.monthly_fee_minor)}</td>
      <td>${r.billing_day}</td>
      <td class="small">${r.next_due_on ? new Date(r.next_due_on).toLocaleDateString('en-GB') : '—'}</td>
      <td><span class="pill ${r.status === 'active' ? 'on' : ''}">${esc(r.status)}</span></td>
      <td class="right">
        <button class="btn small" data-sub-edit="${r.id}">Billing</button>
        <button class="btn small" data-sub-template="${r.id}">Template</button>
        <button class="btn small danger-ghost" data-sub-wipe="${r.id}">Wipe</button>
      </td>
    </tr>`).join('') || '<tr><td colspan="9" class="muted">No offices yet.</td></tr>';
}

document.addEventListener('click', async (e) => {
  const edit = e.target.dataset?.subEdit;
  if (edit) {
    const rows = await api('/admin/offices/subscriptions');
    const row = rows.find((r) => String(r.id) === edit);
    if (!row) return;
    modal(`Billing — ${row.name}`, [
      { name: 'monthly_fee', label: 'Monthly fee (£)', type: 'number',
        value: pounds(row.monthly_fee_minor) },
      { name: 'billing_day', label: 'Recurring day of month (1–28)', type: 'number',
        value: row.billing_day || 1 },
      { name: 'next_due_on', label: 'Next due', type: 'date', value: dateVal(row.next_due_on) },
      { name: 'plan', label: 'Plan name', value: row.plan || '' },
      { name: 'is_demo', label: 'Demo account', type: 'checkbox', value: !!row.is_demo },
      { name: 'trial_ends_on', label: 'Trial ends', type: 'date', value: dateVal(row.trial_ends_on) },
    ], async (data) => {
      await api(`/admin/offices/${edit}/subscription`, {
        method: 'PUT',
        body: JSON.stringify({
          monthly_fee_minor: pence(data.monthly_fee),
          billing_day: Number(data.billing_day) || 1,
          next_due_on: data.next_due_on || null,
          plan: data.plan || null,
          is_demo: !!data.is_demo,
          trial_ends_on: data.trial_ends_on || null,
        }),
      });
      loadSubscriptions();
    });
  }

  const tpl = e.target.dataset?.subTemplate;
  if (tpl) {
    const templates = await api('/admin/templates');
    modal('Apply starter template', [
      { name: 'template_id', label: 'Template', type: 'select', value: '',
        options: templates.map((t) => ({ value: String(t.id), label: t.name })) },
      { name: 'replace', label: 'Replace the existing catalogue first', type: 'checkbox',
        value: false },
    ], async (data) => {
      const res = await api(`/admin/offices/${tpl}/apply-template`, {
        method: 'POST',
        body: JSON.stringify({
          template_id: Number(data.template_id),
          replace: !!data.replace,
        }),
      });
      alert(`Applied: ${Object.entries(res.applied || {})
        .map(([k, v]) => `${v} ${k}`).join(', ')}`);
      loadSubscriptions();
    });
  }

  const wipe = e.target.dataset?.subWipe;
  if (wipe) {
    const rows = await api('/admin/offices/subscriptions');
    const row = rows.find((r) => String(r.id) === wipe);
    if (!row) return;
    modal(`Wipe data — ${row.name}`, [
      { name: 'scope', label: 'What to remove', type: 'select', value: 'sales', options: [
        { value: 'sales', label: 'Sales history only' },
        { value: 'all', label: 'Everything — sales, catalogue and customers' },
      ] },
      { name: 'confirm', label: `Type "${row.contact_email}" to confirm`, value: '' },
    ], async (data) => {
      const res = await api(`/admin/offices/${wipe}/wipe`, {
        method: 'POST',
        body: JSON.stringify({ scope: data.scope, confirm: data.confirm }),
      });
      alert(`Removed ${res.removed.orders} sales.`);
      loadSubscriptions();
    });
  }
});

/** A read-only slide-over for history tables. */
function showPanel(title, html) {
  const root = $('modal-root');
  root.innerHTML = `
    <div class="modal-back">
      <div class="modal wide">
        <h3>${esc(title)}</h3>
        <div class="panel-body">${html}</div>
        <div class="modal-actions">
          <button type="button" class="btn primary" id="panel-close">Close</button>
        </div>
      </div>
    </div>`;
  $('panel-close').addEventListener('click', () => { root.innerHTML = ''; });
}

// ---- Boot -----------------------------------------------------------------
//
// Deliberately the last statement in the file. `start()` renders the current
// view immediately, and the view loaders reach for module-level state (such as
// the dashboard's `dashDays`) declared with `let`/`const` further down. Calling
// it earlier puts those bindings in their temporal dead zone, which throws
// inside the loader's own error handling and leaves the page silently blank.
// A /reset?token=… link wins over a live session: someone who followed a reset
// email means to change their password, not to be dropped into the dashboard.
if (!openResetIfLinked() && token) start();

// ---- Kitchen screens ------------------------------------------------------
//
// Vesopa Kitchen: the touch screen that replaces a station's printer.
// Three things are edited here and they belong to three different places,
// which is worth keeping straight:
//
//   * **Delivery** is a property of the venue's stations, and lives on the
//     till-settings row beside the station names. Every till re-reads it.
//   * **Logins** are what gets typed into a screen on a wall. They belong to
//     the screen, not to a member of staff.
//   * **Screens** are named boards. Which board a given machine *is* stays on
//     that machine — the same split the till draws between printer names (the
//     venue's) and printer hardware (the terminal's).
//
// See vesopa_epos_kitchen/docs/architecture.md.

const KDS_STATIONS = ['kp1', 'kp2', 'kp3', 'kp4', 'kp5', 'kp6'];

/** Per-station product counts from /kitchen/routing. */
let kdsRouting = { counts: {}, products: 0, routed: 0 };

const KDS_MODES = [
  ['printer', 'Printer', 'A ticket prints at that station, as it does today.'],
  ['screen', 'Screen', 'It appears on the kitchen screens. No paper.'],
  ['both', 'Both', 'Paper and screen, for a venue still building trust in it.'],
];

let kdsSettings = {};
let kdsUsers = [];
let kdsScreens = [];
let kdsBoardTimer = null;

/**
 * White-label branding for the screens, and the copy last saved.
 *
 * Two objects rather than one so Revert has something to revert *to* — the same
 * shape the receipt designer uses, and for the same reason: a manager who has
 * changed four fields and thought better of it should not have to remember what
 * three of them were.
 */
let kdsBranding = {};
let kdsBrandingSaved = {};

/** The built-in look, mirroring ui/theme.dart in the kitchen app. */
const KDS_BRAND_FALLBACK = {
  bg: '#111111',
  accent: '#a5c715',
  name: 'Vesopa Kitchen',
};

/** What the venue calls a station, or its slot number. */
function kdsLabel(station) {
  const named = String(kdsSettings['printer_name_' + station] || '').trim();
  return named || station.toUpperCase().replace('KP', 'KP ');
}

async function loadKitchen() {
  // The station names and the delivery modes are on the same row, so one fetch
  // answers both — and reading it here rather than reusing whatever loadIdle()
  // last left in `idleState` means this page is correct when it is the first
  // one opened.
  const [settings, users, screens, routing, branding] = await Promise.all([
    api('/till-settings'),
    api('/kitchen/users'),
    api('/kitchen/screens'),
    // How many products point at each station. Without it the six toggles
    // below are unlabelled guesses — see the note on the route.
    api('/kitchen/routing'),
    api('/kitchen/branding'),
  ]);
  kdsSettings = settings;
  kdsUsers = users;
  kdsScreens = screens;
  kdsRouting = routing;
  kdsBranding = { ...branding };
  kdsBrandingSaved = { ...branding };

  renderKitchenModes();
  renderKitchenUsers();
  renderKitchenScreens();
  kdsFillBranding();
  kdsBindBranding();
  await refreshKitchenBoard();

  // The board is a live view, so it keeps itself current while the page is
  // open. It stops itself the moment the view changes — see the guard in
  // refreshKitchenBoard — so a manager who navigates away is not polling the
  // kitchen all afternoon.
  clearInterval(kdsBoardTimer);
  kdsBoardTimer = setInterval(refreshKitchenBoard, 10000);
}

function renderKitchenModes() {
  const box = $('kitchen-modes');
  if (!box) return;

  box.innerHTML = KDS_STATIONS.map((station) => {
    const current = kdsSettings['kitchen_mode_' + station] || 'printer';
    const slot = station.toUpperCase().replace('KP', 'KP ');
    const buttons = KDS_MODES.map(([value, label, hint]) =>
      '<button type="button" class="seg-btn' +
      (current === value ? ' active' : '') +
      '" data-mode="' + value + '" title="' + esc(hint) + '">' + label +
      '</button>'
    ).join('');

    // What actually points here, and whether that is going anywhere.
    const routed = (kdsRouting.counts || {})[station] || 0;
    let note = '<span class="muted small">' + slot + '</span>';
    if (routed > 0) {
      note += '<span class="kds-routed">' + routed + ' product' +
        (routed === 1 ? '' : 's') + '</span>';
    }

    // The exact shape of the fault this page could not explain: a station
    // every product on the menu points at, still set to paper. Said plainly,
    // because a manager reading "Printer" has no way to know it is wrong.
    const stranded = routed > 0 && current === 'printer';

    return '<div class="kds-mode-row' + (stranded ? ' kds-stranded' : '') + '">' +
      '<div class="kds-mode-name">' + esc(kdsLabel(station)) + note + '</div>' +
      '<div class="seg kds-mode-seg" data-station="' + station + '">' +
        buttons + '</div>' +
    '</div>';
  }).join('');
}

function renderKitchenUsers() {
  const box = $('kitchen-users');
  if (!box) return;

  if (kdsUsers.length === 0) {
    box.innerHTML = '<p class="muted small">No kitchen logins yet. ' +
      'A screen cannot sign in until there is one.</p>';
    return;
  }

  box.innerHTML =
    '<table class="table"><thead><tr>' +
      '<th>Login</th><th>Name</th><th>Last used</th><th>Active</th><th></th>' +
    '</tr></thead><tbody>' +
    kdsUsers.map((u) =>
      '<tr>' +
        '<td><strong>' + esc(u.username) + '</strong></td>' +
        '<td>' + esc(u.display_name || '—') + '</td>' +
        '<td class="muted small">' +
          (u.last_seen_at ? date(u.last_seen_at) : 'Never') + '</td>' +
        '<td>' + (u.active ? 'Yes' : 'No') + '</td>' +
        '<td class="right">' +
          '<button class="btn ghost small" data-kds-user-edit="' + u.id +
            '">Edit</button> ' +
          '<button class="btn ghost small" data-kds-user-del="' + u.id +
            '">Delete</button>' +
        '</td>' +
      '</tr>'
    ).join('') +
    '</tbody></table>';
}

function renderKitchenScreens() {
  const box = $('kitchen-screens');
  if (!box) return;

  if (kdsScreens.length === 0) {
    box.innerHTML = '<p class="muted small">No named screens. Every kitchen ' +
      'screen shows all six stations until you add one — which is exactly ' +
      'right for a kitchen with a single screen.</p>';
    return;
  }

  box.innerHTML =
    '<table class="table"><thead><tr>' +
      '<th>Screen</th><th>Stations</th><th>Amber / red</th>' +
      '<th>Recall</th><th></th>' +
    '</tr></thead><tbody>' +
    kdsScreens.map((s) =>
      '<tr>' +
        '<td><strong>' + esc(s.name) + '</strong></td>' +
        '<td>' + (s.stations.length
          ? esc(s.stations.map(kdsLabel).join(', '))
          : '<span class="muted">Every station</span>') + '</td>' +
        '<td class="muted small">' + Math.round(s.warn_seconds / 60) + 'm / ' +
          Math.round(s.late_seconds / 60) + 'm</td>' +
        '<td class="muted small">' + s.recall_minutes + 'm</td>' +
        '<td class="right">' +
          '<button class="btn ghost small" data-kds-screen-edit="' + s.id +
            '">Edit</button> ' +
          '<button class="btn ghost small" data-kds-screen-del="' + s.id +
            '">Delete</button>' +
        '</td>' +
      '</tr>'
    ).join('') +
    '</tbody></table>';
}

/**
 * The live board.
 *
 * Read-only, and deliberately: bumping an order is a decision made by somebody
 * who can see the plate. This exists to answer "is the kitchen actually getting
 * these?", which is the first question anybody asks after moving a station onto
 * a screen, and which otherwise means walking into the kitchen.
 */
async function refreshKitchenBoard() {
  const box = $('kitchen-board');
  if (!box || currentView !== 'kitchen') {
    clearInterval(kdsBoardTimer);
    kdsBoardTimer = null;
    return;
  }

  try {
    // The back office's own view of the board. A separate path from the one
    // the screens use — see the note in src/kitchen.js, where sharing it would
    // have put this router's auth in front of every kitchen screen's fetch.
    const data = await api('/kitchen/monitor?minutes=30');
    const now = new Date(data.serverTime).getTime();
    const open = data.tickets.filter((t) =>
      t.stations.some((s) => s.status !== 'done')
    );

    $('kitchen-board-status').textContent = open.length === 0
      ? 'Nothing outstanding'
      : open.length + ' open · updated ' + time(data.serverTime);

    if (open.length === 0) {
      box.innerHTML = '<p class="muted small">Nothing is waiting in the ' +
        'kitchen. Orders appear here the moment a till rings up something ' +
        'routed to a station set to Screen or Both.</p>';
      return;
    }

    box.innerHTML = open.map((t) => {
      const minutes = Math.max(
        0,
        Math.round((now - new Date(t.placedAt).getTime()) / 60000)
      );
      const lines = t.lines.map((l) =>
        '<div class="kds-ticket-line">' +
          '<span class="kds-qty">' + esc(String(l.quantity)) + '</span>' +
          '<span>' + esc(l.name) + '</span>' +
          (l.note ? '<em class="kds-note">' + esc(l.note) + '</em>' : '') +
        '</div>'
      ).join('');
      const waiting = t.stations
        .filter((s) => s.status !== 'done')
        .map((s) => kdsLabel(s.station))
        .join(', ');

      return '<div class="kds-ticket">' +
        '<div class="kds-ticket-head">' +
          '<strong>' +
            esc(t.tableNumber ? 'Table #' + t.tableNumber : 'Counter') +
          '</strong>' +
          '<span class="muted small">' + minutes + 'm · ' +
            esc(t.staffName || '') + '</span>' +
        '</div>' + lines +
        '<div class="muted small">' + esc(waiting) + '</div>' +
      '</div>';
    }).join('');
  } catch (err) {
    $('kitchen-board-status').textContent = 'Could not read the board';
    box.innerHTML = '<p class="muted small">' + esc(err.message) + '</p>';
  }
}

// ---- Branding -------------------------------------------------------------
//
// What the venue's screens call themselves and what they show while starting
// up. Venue-wide, and stored beside the receipt branding but never on the same
// columns — restyling a kitchen screen must not restyle a customer's VAT
// receipt. See schema_kitchen_branding.sql.

let kdsBrandingBound = false;

/** Wired once; the view is re-rendered on every navigation. */
function kdsBindBranding() {
  if (kdsBrandingBound) return;
  kdsBrandingBound = true;

  document.querySelectorAll('[data-kb]').forEach((el) => {
    const key = el.dataset.kb;
    const event = el.type === 'checkbox' || el.type === 'color' ? 'change' : 'input';
    el.addEventListener(event, () => {
      if (el.type === 'checkbox') kdsBranding[key] = el.checked;
      else if (el.type === 'number') kdsBranding[key] = Number(el.value);
      else kdsBranding[key] = el.value;
      kdsRenderSplashPreview();
    });
  });

  $('kitchen-logo-pick').addEventListener('click', () => $('kitchen-logo-file').click());
  $('kitchen-logo-file').addEventListener('change', kdsUploadLogo);
  $('kitchen-logo-clear').addEventListener('click', () => {
    // Null, not '': the screen falls back to the receipt logo and then to the
    // built-in mark, so "Remove" means "stop overriding" rather than "show
    // nothing at all".
    kdsBranding.logoUrl = null;
    kdsFillBranding();
  });

  $('kitchen-colours-clear').addEventListener('click', () => {
    kdsBranding.splashBg = '';
    kdsBranding.accent = '';
    kdsFillBranding();
  });

  $('kitchen-branding-save').addEventListener('click', kdsSaveBranding);
  $('kitchen-branding-reset').addEventListener('click', () => {
    kdsBranding = { ...kdsBrandingSaved };
    kdsFillBranding();
  });
}

function kdsFillBranding() {
  document.querySelectorAll('[data-kb]').forEach((el) => {
    const value = kdsBranding[el.dataset.kb];
    if (el.type === 'checkbox') el.checked = !!value;
    else if (el.type === 'color') {
      // A colour input has no empty state — it shows black for '' and a manager
      // reads that as a choice they made. Show the fallback instead, so the
      // swatch always says what the screen will actually do.
      el.value = value || (el.dataset.kb === 'accent'
        ? KDS_BRAND_FALLBACK.accent
        : KDS_BRAND_FALLBACK.bg);
    } else el.value = value ?? '';
  });

  const preview = $('kitchen-logo-preview');
  if (preview) {
    preview.innerHTML = kdsBranding.logoUrl
      ? '<img src="' + esc(kdsBranding.logoUrl) + '" alt="Kitchen screen logo">'
      : '<span class="muted small">No logo</span>';
  }

  kdsRenderSplashPreview();
}

/** The wall's start screen, as this venue has it configured. */
function kdsRenderSplashPreview() {
  const box = $('kitchen-splash-preview');
  if (!box) return;

  const bg = kdsBranding.splashBg || KDS_BRAND_FALLBACK.bg;
  const accent = kdsBranding.accent || KDS_BRAND_FALLBACK.accent;
  const name = (kdsBranding.appName || '').trim() || KDS_BRAND_FALLBACK.name;
  const tagline = (kdsBranding.tagline || '').trim();

  box.style.background = bg;
  box.style.color = kdsInkOn(bg);

  if (!kdsBranding.splashEnabled) {
    box.innerHTML =
      '<span class="small" style="opacity:.7">' +
      'The start screen is switched off — screens go straight to the board.</span>';
    return;
  }

  const mark = kdsBranding.logoUrl
    ? '<img class="kds-splash-mark" src="' + esc(kdsBranding.logoUrl) + '" alt="">'
    : '<span class="kds-splash-mark" style="background:' + esc(accent) +
      ';color:' + esc(kdsInkOn(accent)) + '">V</span>';

  box.innerHTML =
    mark +
    '<div class="kds-splash-name">' + esc(name) + '</div>' +
    (tagline ? '<div class="kds-splash-tagline">' + esc(tagline) + '</div>' : '') +
    '<div class="kds-splash-rule" style="background:' + esc(accent) + '"></div>' +
    (kdsBranding.showPoweredBy
      ? '<div class="kds-splash-powered">POWERED BY VESOPA</div>'
      : '');
}

/**
 * Readable ink for a chosen background.
 *
 * The same rule the app uses (`Kds.inkOn` in ui/theme.dart): pick the
 * higher-contrast of the two rather than guessing from brightness. A manager
 * who picks lime as a background should see the preview go dark, because that
 * is what the wall will do.
 */
function kdsInkOn(hex) {
  const rgb = String(hex || '').replace('#', '');
  if (rgb.length !== 6) return '#ffffff';
  const channel = (i) => {
    const c = parseInt(rgb.slice(i * 2, i * 2 + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const l = 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
  return (l + 0.05) / 0.05 > 1.05 / (l + 0.05) ? '#10130a' : '#ffffff';
}

async function kdsUploadLogo(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;

  const body = new FormData();
  body.append('image', file);
  try {
    // FormData sets its own multipart boundary, so the JSON content-type that
    // api() adds must not be used here. Same endpoint the receipt designer
    // uploads to — it stores a file and hands back a URL, and says nothing
    // about what the picture is for.
    const res = await fetch('/api/branding/logo', {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body,
    });
    if (!res.ok) {
      throw new Error((await res.json().catch(() => ({}))).error || 'Upload failed');
    }
    const { url } = await res.json();
    kdsBranding.logoUrl = url;
    kdsFillBranding();
  } catch (err) {
    alert(err.message);
  } finally {
    // Cleared so choosing the same file twice in a row still fires a change.
    event.target.value = '';
  }
}

async function kdsSaveBranding() {
  const button = $('kitchen-branding-save');
  button.disabled = true;
  try {
    const saved = await api('/kitchen/branding', {
      method: 'PUT',
      body: JSON.stringify({
        splashEnabled: !!kdsBranding.splashEnabled,
        splashMs: Number(kdsBranding.splashMs) || 0,
        appName: kdsBranding.appName || '',
        tagline: kdsBranding.tagline || '',
        logoUrl: kdsBranding.logoUrl || '',
        splashBg: kdsBranding.splashBg || '',
        accent: kdsBranding.accent || '',
        showPoweredBy: !!kdsBranding.showPoweredBy,
      }),
    });
    // Redrawn from what came back rather than from what was sent: the server
    // clamps the hold and drops a colour it could not parse, and a manager
    // should be looking at the value the screens will actually use.
    kdsBranding = { ...saved };
    kdsBrandingSaved = { ...saved };
    kdsFillBranding();
    button.textContent = 'Saved ✓';
    setTimeout(() => { button.textContent = 'Save branding'; }, 1500);
  } catch (err) {
    alert(err.message);
  } finally {
    button.disabled = false;
  }
}

// ---- Editing --------------------------------------------------------------

document.addEventListener('click', async (e) => {
  // Delivery mode. Held locally until Save, so a manager can set all six and
  // send one write — six separate saves would broadcast six till-settings
  // reloads to every terminal in the venue.
  const modeButton = e.target.closest && e.target.closest('.kds-mode-seg button');
  if (modeButton) {
    const station = modeButton.closest('.kds-mode-seg').dataset.station;
    kdsSettings['kitchen_mode_' + station] = modeButton.dataset.mode;
    renderKitchenModes();
    return;
  }

  if (e.target.id === 'kitchen-save-modes') {
    const button = e.target;
    button.disabled = true;
    try {
      const body = {};
      for (const station of KDS_STATIONS) {
        body['kitchen_mode_' + station] =
          kdsSettings['kitchen_mode_' + station] || 'printer';
      }
      kdsSettings = await api('/till-settings', {
        method: 'PUT',
        body: JSON.stringify(body),
      });
      renderKitchenModes();
      button.textContent = 'Saved ✓';
      setTimeout(() => { button.textContent = 'Save delivery'; }, 1500);
    } catch (err) {
      alert(err.message);
    } finally {
      button.disabled = false;
    }
    return;
  }

  if (e.target.id === 'kitchen-user-add') return kdsEditUser(null);

  if (e.target.dataset && e.target.dataset.kdsUserEdit) {
    const id = e.target.dataset.kdsUserEdit;
    return kdsEditUser(kdsUsers.find((u) => String(u.id) === id));
  }

  if (e.target.dataset && e.target.dataset.kdsUserDel) {
    const id = e.target.dataset.kdsUserDel;
    const user = kdsUsers.find((u) => String(u.id) === id);
    if (!user) return;
    // Named in the prompt, because these are short and similar and deleting
    // the wrong one blinds a kitchen mid-service.
    if (!confirm('Delete the kitchen login "' + user.username + '"? ' +
        'Any screen signed in with it stops working.')) return;
    await api('/kitchen/users/' + user.id, { method: 'DELETE' });
    return loadKitchen();
  }

  if (e.target.id === 'kitchen-screen-add') return kdsEditScreen(null);

  if (e.target.dataset && e.target.dataset.kdsScreenEdit) {
    const id = e.target.dataset.kdsScreenEdit;
    return kdsEditScreen(kdsScreens.find((s) => String(s.id) === id));
  }

  if (e.target.dataset && e.target.dataset.kdsScreenDel) {
    const id = e.target.dataset.kdsScreenDel;
    const screen = kdsScreens.find((s) => String(s.id) === id);
    if (!screen) return;
    if (!confirm('Delete the screen "' + screen.name + '"? Any machine set ' +
        'to it falls back to showing every station.')) return;
    await api('/kitchen/screens/' + screen.id, { method: 'DELETE' });
    return loadKitchen();
  }
});

/**
 * The kitchen-login editor.
 *
 * A form in a modal, like every other editor in this back office. It used to
 * be three `prompt()` calls in a row, and that is why nothing could be added:
 * a browser that has been asked to stop showing dialogs — Chrome offers the
 * tick box on the *second* one, which is exactly where a three-prompt chain
 * puts it — makes every later `prompt()` return null instantly. The function
 * then returned at its first `if (x === null) return;` and did nothing at all,
 * and the `alert()` that would have explained was suppressed by the same
 * setting. Silent, permanent, and un-recoverable without clearing site data.
 *
 * The username is settable only on create. It is what somebody types into a
 * screen on a wall, and the server has never accepted a change to it — a
 * renamed login would sign out a kitchen with no warning.
 */
function kdsEditUser(user) {
  const fields = [];

  if (!user) {
    fields.push({
      name: 'username',
      label: 'Login — short, lower case, no spaces. Typed on glass with a finger.',
      required: true,
      value: '',
    });
  }

  fields.push(
    {
      name: 'display_name',
      label: 'Name for it, shown on the screen’s info panel (optional)',
      value: user ? user.display_name || '' : '',
    },
    {
      // Deliberately not type="password". The manager setting this has to read
      // it back to write it on a card for the kitchen, and it is a shared
      // login for a screen on a wall rather than anybody's personal password.
      // The old prompt() showed it in clear too.
      name: 'password',
      label: user
        ? 'New password — leave blank to keep the current one'
        : 'Password — at least 4 characters',
      value: '',
    }
  );

  if (user) {
    fields.push({
      name: 'active',
      label: 'Active — a screen cannot sign in while this is off',
      type: 'checkbox',
      value: user.active ? 1 : 0,
    });
  }

  modal(user ? 'Kitchen login — ' + user.username : 'New kitchen login', fields,
    async (data) => {
      if (user) {
        const body = {
          display_name: data.display_name,
          active: data.active === '1',
        };
        // Blank means "leave it alone". Sending an empty string would be a
        // password change to nothing, which the server rejects — but only
        // after the manager thought they had merely renamed the login.
        if (data.password) body.password = data.password;
        await api('/kitchen/users/' + user.id, {
          method: 'PUT',
          body: JSON.stringify(body),
        });
      } else {
        await api('/kitchen/users', {
          method: 'POST',
          body: JSON.stringify({
            username: data.username,
            password: data.password,
            display_name: data.display_name,
          }),
        });
      }
    });
}

/**
 * The screen editor. Five chained prompts before, for the same reason.
 *
 * Columns and sound are on the form now. They are stored per screen and were
 * previously settable from nowhere at all — the old dialog sent whatever the
 * row already held, so a screen created with the defaults kept them forever.
 */
function kdsEditScreen(screen) {
  const stationOptions = KDS_STATIONS.map((s) => ({
    value: s,
    label: kdsLabel(s),
  }));

  modal(screen ? 'Screen — ' + screen.name : 'New screen', [
    {
      name: 'name',
      label: 'What this screen is called — Grill, Pass, Bar',
      required: true,
      value: screen ? screen.name : '',
    },
    {
      name: 'stations',
      label: 'Stations it shows — none ticked means every station, which is ' +
        'what a one-screen kitchen wants',
      type: 'stations',
      options: stationOptions,
      value: screen ? screen.stations.join(',') : '',
    },
    {
      name: 'warn_minutes',
      label: 'Minutes before an order turns amber',
      type: 'number',
      value: screen ? Math.round(screen.warn_seconds / 60) : 8,
    },
    {
      name: 'late_minutes',
      label: 'Minutes before it turns red and starts pulsing',
      type: 'number',
      value: screen ? Math.round(screen.late_seconds / 60) : 15,
    },
    {
      name: 'recall_minutes',
      label: 'Minutes a completed order stays recallable',
      type: 'number',
      value: screen ? screen.recall_minutes : 60,
    },
    {
      name: 'columns_count',
      label: 'Columns — 0 for as many as fit, which suits most panels',
      type: 'number',
      value: screen ? screen.columns_count : 0,
    },
    {
      name: 'sound',
      label: 'Chime when an order lands',
      type: 'checkbox',
      value: screen ? screen.sound : 1,
    },
  ], async (data) => {
    // A checkbox set of one submits a string, a set of several an array, and
    // a set of none does not submit at all — so all three are normalised here
    // rather than trusted. None ticked is meaningful: it means every station.
    const stations = data.stations === undefined
      ? []
      : [].concat(data.stations);

    await api(screen ? '/kitchen/screens/' + screen.id : '/kitchen/screens', {
      method: screen ? 'PUT' : 'POST',
      body: JSON.stringify({
        name: data.name,
        stations: stations,
        warn_seconds: Math.round(Number(data.warn_minutes) * 60),
        late_seconds: Math.round(Number(data.late_minutes) * 60),
        recall_minutes: Math.round(Number(data.recall_minutes)),
        columns_count: Math.round(Number(data.columns_count)) || 0,
        // The server reads `false` and nothing else as off, so the hidden
        // field's "0" has to become a boolean before it is sent.
        sound: data.sound === '1',
      }),
    });
  });
}
