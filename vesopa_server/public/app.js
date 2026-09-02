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


// ---- Appearance -----------------------------------------------------------
//
// Day, Night, or whatever the machine is set to. Applied to <html> as a
// `data-theme` attribute, which every colour in style.css is expressed
// against — so this is three lines of JavaScript and not a second stylesheet.
//
// Written before anything else runs, and read straight out of localStorage
// rather than waiting for a session, because a manager who has chosen Night
// must not be shown a white page for the length of a sign-in.
const THEME_KEY = 'vesopa.theme';

function readTheme() {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    return stored === 'light' || stored === 'dark' ? stored : 'system';
  } catch {
    // Site data switched off. The system's own preference still applies,
    // through the media query in style.css; it just cannot be overridden.
    return 'system';
  }
}

function applyTheme(choice) {
  const root = document.documentElement;
  if (choice === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);

  document.querySelectorAll('[data-theme-set]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.themeSet === choice));
  });
}

function setTheme(choice) {
  try {
    if (choice === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, choice);
  } catch {
    // Not remembered, but still applied for this session.
  }
  applyTheme(choice);
}

applyTheme(readTheme());

document.addEventListener('click', (e) => {
  const key = e.target.closest?.('[data-theme-set]');
  if (key) setTheme(key.dataset.themeSet);
});

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
    // The screen editor names its keys from the catalogue, so a product renamed
    // on another machine should relabel them here. Safe to reload now that
    // loadScreens keeps an unsaved layout rather than replacing it.
    if (msg.type === 'catalogue.updated' && ['products', 'stock', 'screens'].includes(currentView)) render();
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
  timesheets: '/timesheets',
  products: '/products',
  stock: '/stock',
  screens: '/screen-programming',
  program_departments: '/program-departments',
  program_groups: '/program-groups',
  import: '/import',
  run_report: '/reports/financial-summary',
  report_schedules: '/reports/schedules',
  modifiers: '/modifiers',
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
  cards: '/cards',
  wallet: '/wallet',
  devices: '/devices',
  tender: '/tender',
  rules: '/rules',
  templates: '/templates',
  subscriptions: '/subscriptions',
  offices: '/offices',
  billing: '/billing',
};

const viewForPath = (path) =>
  Object.keys(ROUTES).find((v) => ROUTES[v] === path) || 'dashboard';

function show(view, { push = true, userInitiated = false } = {}) {
  if (!$(`view-${view}`)) view = 'dashboard';

  // The screen editor holds a whole layout in the browser, and leaving the view
  // is the one way out of it that used to throw the layout away without a word.
  // Asked here rather than in screens.js because this is the function that
  // actually leaves — including via the back button, which is why a refusal has
  // to put the address bar back where it was.
  if (
    currentView === 'screens' &&
    view !== 'screens' &&
    typeof spDirty === 'function' &&
    spDirty() &&
    !confirm('This screen has changes that have not been saved. Leave them behind?')
  ) {
    if (!push) history.pushState({ view: 'screens' }, '', ROUTES.screens);
    return;
  }

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

  // The screen editor opens in a window of its own, and this tab draws a card
  // saying where it went. Asked here rather than inside loadScreens because it
  // has to happen on *entering* the view — loadScreens also runs on every save
  // and on every push from the server, and a window that reopened itself on
  // each of those would be unusable.
  if (view === 'screens' && typeof spEnterView === 'function') {
    spEnterView({ userInitiated });
  }

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
      { name: 'group_name', label: 'Sub Department' },
      { name: 'accounting_code', label: 'Accounting code' },
      // The category button on the till, rendered square there — so unlike a
      // product's picture this one keeps the cropper's default square crop.
      { name: 'image_url', label: 'Button image', type: 'image' },
      { name: 'emoji', label: 'Emoji (used when there is no image)' },
      { name: 'button_color', label: 'Button colour', type: 'color' },
    ],
  },
  groups: {
    path: 'groups', title: 'sub department', sortable: true,
    fields: [
      { name: 'group_name', label: 'Sub Department', required: true },
      { name: 'accounting_code', label: 'Accounting code' },
    ],
  },
  /**
   * Modifier groups: the questions a product asks before it goes on the bill.
   *
   * The two numbers are the whole behaviour of the prompt on the till, so they
   * are labelled as what they *do* rather than as min_select and max_select —
   * a manager setting up a steak should not have to work out that "most they
   * may pick: 1" is what closes the box on the first tap.
   *
   * The answers themselves are not edited here. They are a grid of buttons, so
   * they are laid out in the screen editor like every other grid of buttons —
   * which is what the "Edit answers" key opens. See schema_screens_modifiers.sql.
   */
  modifiers: {
    path: 'modifier-groups', title: 'modifier group',
    fields: [
      { name: 'name', label: 'Question (e.g. Mixers, How is it cooked?)', required: true },
      {
        name: 'min_select',
        label: 'Fewest they may pick (0 lets the operator skip)',
        type: 'number',
      },
      {
        name: 'max_select',
        label: 'Most they may pick (1 closes the box on the first tap, 0 = no limit)',
        type: 'number',
      },
    ],
    extraColumns: [
      {
        // The number worth spotting is 0: a group nobody laid out asks nothing,
        // and the till skips it rather than opening an empty box.
        cell: (r) =>
          Number(r.option_count)
            ? `${r.option_count} answer${Number(r.option_count) === 1 ? '' : 's'}`
            : '<span class="badge archived" title="No answers laid out yet, so the till skips this question.">empty</span>',
      },
      {
        cell: (r) =>
          Number(r.product_count)
            ? `${r.product_count} product${Number(r.product_count) === 1 ? '' : 's'}`
            : '<span class="muted">unused</span>',
      },
    ],
    rowActions: (r) =>
      r.screen_id
        ? `<button class="btn small ghost" data-edit-answers="${r.screen_id}">Edit answers</button>`
        : '',
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
    // A voucher prints and a voucher does not go in a wallet, and both halves
    // of that are deliberate. A wallet pass is a card that belongs to one named
    // person and updates in their pocket; a voucher is a code anybody holding
    // it can spend once. Putting one on a phone as a "card" would promise a
    // relationship the voucher does not have -- an offer that should live on a
    // phone is a Promotion, which has a pass type of its own.
    rowActions: (r) => printOnlyAction({
      what: 'voucher', id: r.id, name: r.name || r.code,
      why: 'A voucher is a code, not a card. Use Promotions for an offer that '
        + 'goes on a phone.',
    }),
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

/**
 * Let a table become a stack of cards on a phone.
 *
 * Below 760px `.table-cards` drops the heading row, so every cell has to carry
 * its own heading — and it takes it from the very `<th>` it sits under rather
 * than from a second list written beside the row. A duplicate list is a list
 * that goes stale: a column renamed in the markup would go on being labelled
 * with the old word on every phone, and nothing on a desktop would ever show
 * it. Read it from the table and the two cannot disagree.
 *
 * An empty heading — the drag handle's column, the actions column on a
 * programming screen — labels nothing, which is what the CSS wants: those
 * cells show their contents alone.
 */
function cardsOnPhone(table) {
  if (!table) return;

  const headings = [...(table.tHead?.rows[0]?.cells || [])].map((th) =>
    th.textContent.trim()
  );
  // A table with no headings has nothing to label its cells with, and a card
  // of unlabelled values is worse than a row of them. It keeps scrolling.
  if (!headings.some(Boolean)) return;

  const body = table.tBodies[0];
  if (!body) return;

  table.classList.add('table-cards');
  labelRows(body, headings);

  // Rows are re-drawn by all sorts of things that never come back through
  // here: a save, a delete, a websocket nudge, a filter box. The class stays on
  // the table when they do, so without this the new rows would be cards whose
  // cells had lost their headings — labels that vanish on the second render
  // are worse than labels that were never there, because nobody can reproduce
  // it. Watching the tbody costs nothing and cannot get out of step.
  //
  // childList only, so writing the attributes below does not re-trigger it.
  if (!table.dataset.cardsWatched) {
    table.dataset.cardsWatched = '1';
    new MutationObserver(() => labelRows(body, headings)).observe(body, {
      childList: true,
    });
  }
}

/** Put each cell under the heading it belongs to. */
function labelRows(body, headings) {
  for (const row of body.rows) {
    // The "Nothing yet." row spans the lot and is under no column at all.
    if (row.cells.length === 1 && row.cells[0].hasAttribute('colspan')) continue;
    [...row.cells].forEach((cell, i) => {
      if (isActionsCell(cell)) cell.classList.add('row-actions-cell');
      else if (headings[i]) cell.setAttribute('data-label', headings[i]);
    });
  }
}

/**
 * Is this cell the row's buttons and nothing else?
 *
 * Asked rather than declared, because twenty screens put their Edit and Delete
 * in the last cell and not one of them marks it as anything. On a phone that
 * cell needs the full width of the card instead of being squeezed against the
 * right-hand edge — which, in a table being dragged sideways, is where it was
 * hiding in the first place.
 *
 * Deliberately strict: buttons, or a wrapper full of them, and no loose text.
 * A cell reading "£4.60 [Refund]" is a value with a button after it and should
 * stay a labelled row like any other.
 */
function isActionsCell(cell) {
  const kids = [...cell.children];
  if (!kids.length) return false;
  if (!kids.every((el) => el.matches('.btn, .icon-btn, .row-actions'))) return false;
  return ![...cell.childNodes].some(
    (node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim()
  );
}

/**
 * Every table on the view that has just loaded becomes cards on a phone.
 *
 * Done once, here, rather than in each of the twenty loaders. Back office
 * users, Customers, Vouchers, Promotions, Gift cards, Deposits, Automation
 * rules, Tax, Mix and match, Error reasons — every one of them was a table
 * eight or ten columns wide that a phone could only be dragged sideways
 * through, with the row's own buttons off the right-hand edge. They are one
 * shape and they get one fix, and the next screen someone adds gets it without
 * having to know about it.
 *
 * `data-no-cards` opts a table out. Only the report sections do: they are read
 * column against column, and seven money columns stacked into label/value pairs
 * is a page nobody can total by eye. The catalogue, which is edited in place,
 * does become cards — its editable cells stack, label above control, which is a
 * better form on a phone than a row of squeezed inputs.
 */
function cardsInView() {
  document
    .querySelectorAll('.view:not([hidden]) table:not([data-no-cards])')
    .forEach(cardsOnPhone);
}

async function loadCrud(key) {
  const cfg = CRUD[key];
  const rows = await api(`/${cfg.path}`);
  const body = $(key);
  if (!body) return;

  // Some fields exist only to be edited (the voucher button styling, say) and
  // would make the table unreadable if every one got a column.
  const columns = cfg.fields.filter((f) => !f.hideInTable);
  // Columns the server computes and the form never edits — how many answers a
  // modifier group holds, how many products ask it. Read-only by construction:
  // they are not fields, so nothing tries to save them back.
  const extras = cfg.extraColumns || [];
  const span = columns.length + extras.length + 1 + (cfg.sortable ? 1 : 0);
  body.innerHTML = rows
    .map(
      (r) => `<tr data-row-id="${r.id}">
        ${cfg.sortable ? '<td class="drag-cell"><span class="drag-handle" title="Drag to reorder">⋮⋮</span></td>' : ''}
        ${columns
          .map((f, i) =>
            // The first column is the card's title on a phone rather than
            // another label/value pair: on Departments that is the department's
            // own name, which is what somebody scanning the list is looking
            // for. The rest are labelled by cardLabels() below.
            i === 0
              ? `<td class="card-title">${cellText(f, r[f.name])}</td>`
              : `<td>${cellText(f, r[f.name])}</td>`
          )
          .join('')}
        ${extras.map((c) => `<td>${c.cell(r)}</td>`).join('')}
        <td class="right nowrap row-actions-cell">
          ${cfg.rowActions ? cfg.rowActions(r) : ''}
          <button class="btn small ghost" data-edit="${key}" data-id="${r.id}">Edit</button>
          <button class="btn small danger" data-del="${cfg.path}" data-id="${r.id}">Delete</button>
        </td>
      </tr>`
    )
    .join('') ||
    `<tr><td colspan="${span}" class="empty">Nothing yet.</td></tr>`;

  // Stated here rather than on nine <table>s in index.html, so a programming
  // screen added later gets the phone layout without anybody remembering to.
  cardsOnPhone(body.closest('table'));

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
    timesheets: loadTimesheets,
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
    import: loadImport,
    run_report: loadRunReport,
    report_schedules: loadReportSchedules,
    modifiers: () => loadCrud('modifiers'),
    mix_match: () => loadCrud('mix-match'),
    finalise_keys: () => loadCrud('finalise-keys'),
    error_reasons: () => loadCrud('error-reasons'),
    tax: () => loadCrud('tax'),
    idle: loadIdle,
    kitchen: loadKitchen,
    screens: loadScreens,
    vouchers: () => loadCrud('vouchers'),
    receipt_designer: loadReceiptDesigner,
    promotions: loadPromotions,
    gift_cards: loadGiftCards,
    deposits: loadDeposits,
    loyalty: loadLoyalty,
    cards: loadCards,
    wallet: loadWallet,
    devices: loadDevices,
    tender: loadTender,
    rules: loadRules,
    templates: loadTemplates,
    subscriptions: loadSubscriptions,
  }[currentView];

  if (load) {
    Promise.resolve(load())
      .then(cardsInView)
      .catch((e) => console.error(e));
  }
}

// ---- New reports ----------------------------------------------------------

/**
 * Sales Explorer: a page at a time, fetched before the scroll gets there.
 *
 * This page used to ask for five hundred lines and draw all of them. A venue
 * with a busy Saturday has five hundred lines by lunchtime, and on a phone —
 * where every one of them is a card of five fields — that is a wait, a scroll
 * bar that lies about how much is left, and a page that janks all the way
 * down.
 *
 * So it loads sixty, and the next sixty are already on their way by the time
 * the last of them comes into view: the sentinel below the table is watched
 * with 500px of margin, which at a normal scrolling speed is about a second of
 * warning. Done well this is invisible — the list simply never ends and never
 * stalls — which is the whole point.
 *
 * `token` guards against a race that is easy to hit here: change the date and
 * press Search while a page is still in flight, and the old request comes back
 * afterwards and appends yesterday's lines under today's heading. Each search
 * takes a number, and a reply carrying the wrong one is dropped.
 */
const EX_PAGE = 60;
let exFeed = { token: 0, offset: 0, done: false, loading: false, watcher: null };

async function loadExplorer() {
  exFeed.watcher?.disconnect();
  exFeed = { token: exFeed.token + 1, offset: 0, done: false, loading: false, watcher: null };

  $('explorer').innerHTML = '';
  exSay('');
  exWatch();
  await exFill();
}

/** The line under the table: loading, finished, or nothing at all. */
function exSay(text, spinning = false) {
  feedSay('ex-more', text, spinning);
}

/** Fetch and append the next page. */
async function exNextPage() {
  if (exFeed.loading || exFeed.done) return;
  const mine = exFeed.token;
  exFeed.loading = true;
  if (exFeed.offset) exSay('Loading more…', true);

  const params = new URLSearchParams();
  if ($('ex-from').value) params.set('from', $('ex-from').value);
  if ($('ex-to').value) params.set('to', $('ex-to').value);
  if ($('ex-dept').value) params.set('department', $('ex-dept').value);
  params.set('limit', String(EX_PAGE));
  params.set('offset', String(exFeed.offset));

  try {
    const rows = await api(`/sales-explorer?${params}`);
    // A reply to a search that has since been replaced.
    if (mine !== exFeed.token) return;

    $('explorer').insertAdjacentHTML(
      'beforeend',
      rows
        .map(
          (r) => `<tr class="clickable" data-receipt="${esc(r.id)}">
        <td>${date(r.closed_at)} ${time(r.closed_at)}</td>
        <td>${esc(r.name)}</td>
        <td>${esc(r.department)}</td>
        <td class="right">${r.quantity}</td>
        <td class="right">${money(r.line_total_minor)}</td>
      </tr>`
        )
        .join('')
    );

    exFeed.offset += rows.length;
    // A short page is the last page. Asking again to be told "none" costs a
    // round trip and a query to learn nothing.
    exFeed.done = rows.length < EX_PAGE;

    if (!exFeed.offset) {
      $('explorer').innerHTML =
        '<tr><td colspan="5" class="empty">No matching sales.</td></tr>';
      exSay('');
    } else if (exFeed.done) {
      exSay(`All ${exFeed.offset} lines.`);
    } else {
      exSay('');
    }
  } catch (e) {
    if (mine === exFeed.token) exSay(e.message);
  } finally {
    if (mine === exFeed.token) exFeed.loading = false;
  }
}

function exFill() {
  return feedFill('ex-more', exFeed, exNextPage);
}

function exWatch() {
  exFeed.watcher = feedWatch('ex-more', exFill);
}

/* ---------------------------------------------------------------------------
   A list that loads as it is scrolled

   Two tables in the back office are unbounded — every sale line in the Sales
   Explorer, every bill in the Bill Report — and both have to answer the same
   two questions: when is the next page wanted, and what stops it. Written once
   here; each page brings its own fetch, its own row, and a `feed` holding
   `{ token, offset, done, loading, watcher }`.
   --------------------------------------------------------------------------- */

/** How much warning the foot of a list gets, in pixels of scroll. */
const FEED_MARGIN = 500;

/**
 * Load until the foot of the list is off the bottom of the screen.
 *
 * An IntersectionObserver reports *changes*, not states, and that is the whole
 * difficulty with a sentinel: if a page arrives and the sentinel is still in
 * view, nothing has changed, no callback runs, and the feed stalls with the
 * "load more" marker sitting in plain sight. That is guaranteed on the first
 * page of a short result and on any tall screen, and it is why the Sales
 * Explorer used to stop dead — on a phone, on a tablet and on a desktop alike.
 *
 * So the observer's job is only to notice that the foot has come into view; the
 * filling is done here, in a loop, until it is not. Bounded, so a server that
 * answers a full page for ever cannot spin the tab, and it stops the moment a
 * page adds nothing.
 */
async function feedFill(footId, feed, nextPage) {
  const sentinel = $(footId);
  if (!sentinel) return;

  for (let guard = 0; guard < 40; guard++) {
    if (feed.done) return;
    const box = sentinel.getBoundingClientRect();
    // The same margin the observer is given, asked directly.
    const fold = window.innerHeight || document.documentElement.clientHeight;
    if (box.top > fold + FEED_MARGIN) return;

    const before = feed.offset;
    const token = feed.token;
    await nextPage();
    // A newer search replaced this one, or the page brought nothing back.
    if (token !== feed.token || feed.offset === before) return;
  }
}

/**
 * Watch the foot of a list.
 *
 * Against the viewport, not `main`. `#app` is `min-height: 100vh`, so it grows
 * with its content and `main` — a flex item in it with no height to be held to
 * — grows with it: `overflow: auto` on an element that never overflows makes no
 * scroll container. The document is what scrolls, at every width. Rooting the
 * observer on `main` therefore measured the sentinel against a box that always
 * contained it, so `isIntersecting` was true from the first frame and never
 * changed again: one extra page arrived and the feed stopped for ever.
 */
function feedWatch(footId, fill) {
  const sentinel = $(footId);
  if (!sentinel || typeof IntersectionObserver !== 'function') return null;

  const watcher = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) fill();
    },
    { root: null, rootMargin: `${FEED_MARGIN}px 0px` }
  );
  watcher.observe(sentinel);
  return watcher;
}

/** The line under a list: loading, finished, or nothing at all. */
function feedSay(footId, text, spinning = false) {
  const box = $(footId);
  if (!box) return;
  box.textContent = text;
  box.className = spinning ? 'ex-more loading' : 'ex-more';
}

/**
 * Shifts, newest first, with the hours already worked out.
 *
 * The minutes come from the server rather than being computed here, so an
 * export and the screen can never disagree -- and so an open shift counts to
 * the *server's* now rather than to whatever this browser's clock says, which
 * on a back-office machine nobody has restarted for a month is a real
 * difference.
 */
async function loadTimesheets() {
  const from = $('ts-from').value;
  const to = $('ts-to').value;
  const query = new URLSearchParams();
  if (from) query.set('from', from);
  if (to) query.set('to', to);

  const rows = await api('/timesheets' + (query.toString() ? '?' + query : ''));

  // Totalled per person, because "how many hours did Sam do" is the question
  // this page is opened for, and adding a column of shifts up by eye is how it
  // gets answered wrong.
  const byPerson = new Map();
  for (const r of rows) {
    const held = byPerson.get(r.staff_id) || {
      name: r.staff_name || '#' + r.staff_id,
      minutes: 0,
      shifts: 0,
      open: 0,
    };
    held.minutes += Number(r.minutes) || 0;
    held.shifts += 1;
    if (!r.clocked_out_at) held.open += 1;
    byPerson.set(r.staff_id, held);
  }

  $('ts-summary').innerHTML = byPerson.size
    ? [...byPerson.values()]
        .sort((a, b) => b.minutes - a.minutes)
        .map(
          (p) =>
            '<div class="card stat"><span class="label">' +
            esc(p.name) +
            (p.open ? ' <span class="badge active">on now</span>' : '') +
            '</span><strong>' +
            hours(p.minutes) +
            '</strong><span class="muted small">' +
            p.shifts +
            (p.shifts === 1 ? ' shift' : ' shifts') +
            '</span></div>'
        )
        .join('')
    : '';

  $('timesheets').innerHTML = rows.length
    ? rows
        .map(
          (r) =>
            '<tr>' +
            '<td>' + esc(r.staff_name || '#' + r.staff_id) + '</td>' +
            '<td>' + date(r.clocked_in_at) + ' ' + time(r.clocked_in_at) + '</td>' +
            '<td>' +
            (r.clocked_out_at
              ? date(r.clocked_out_at) + ' ' + time(r.clocked_out_at)
              : '<span class="badge active">still on</span>') +
            '</td>' +
            '<td class="right">' + hours(r.minutes) + '</td>' +
            '<td class="muted small">' +
            esc([r.in_terminal, r.out_terminal].filter(Boolean).join(' \u2192 ') || '\u2014') +
            '</td>' +
            '<td class="muted small">' +
            esc(r.note || '') +
            (r.adjusted_by
              ? ' <span class="badge archived" title="Edited by ' +
                esc(r.adjusted_by) +
                '">edited</span>'
              : '') +
            '</td>' +
            '<td class="right">' +
            '<button class="btn small ghost" data-edit-shift="' + r.id + '">Correct</button> ' +
            '<button class="btn small danger-ghost" data-del-shift="' + r.id + '">Delete</button>' +
            '</td></tr>'
        )
        .join('')
    : '<tr><td colspan="7" class="muted">No shifts in that period. Staff clock in from the till &mdash; Functions &rsaquo; Clock In / Out.</td></tr>';
}

/** Minutes as a manager reads them off a rota. */
function hours(minutes) {
  const m = Math.max(0, Number(minutes) || 0);
  return Math.floor(m / 60) + 'h ' + String(m % 60).padStart(2, '0') + 'm';
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

/**
 * Every bill, loaded as it is scrolled.
 *
 * The same feed as the Sales Explorer, on the same parts — see feedFill(). It
 * used to be one request for a flat `LIMIT 200`, which is not a first page but
 * a ceiling: a venue six months old had bills that could not be reached from
 * anywhere in the back office, and nothing on the screen said so. Nobody
 * scrolls two hundred rows to discover a limit.
 */
const BR_PAGE = 60;
let brFeed = { token: 0, offset: 0, done: false, loading: false, watcher: null };

async function loadBillReport() {
  brFeed.watcher?.disconnect();
  brFeed = { token: brFeed.token + 1, offset: 0, done: false, loading: false, watcher: null };

  $('billreport').innerHTML = '';
  feedSay('br-more', '');
  brWatch();
  await feedFill('br-more', brFeed, brNextPage);
}

async function brNextPage() {
  if (brFeed.loading || brFeed.done) return;
  const mine = brFeed.token;
  brFeed.loading = true;
  if (brFeed.offset) feedSay('br-more', 'Loading more…', true);

  const params = new URLSearchParams();
  params.set('limit', String(BR_PAGE));
  params.set('offset', String(brFeed.offset));

  try {
    const rows = await api(`/bill-report?${params}`);
    // A reload that has since been replaced — the view was left and reopened.
    if (mine !== brFeed.token) return;

    $('billreport').insertAdjacentHTML(
      'beforeend',
      rows
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
        .join('')
    );

    brFeed.offset += rows.length;
    // A short page is the last page; asking again to be told "none" costs a
    // round trip and a query to learn nothing.
    brFeed.done = rows.length < BR_PAGE;

    if (!brFeed.offset) {
      $('billreport').innerHTML =
        '<tr><td colspan="6" class="empty">No bills.</td></tr>';
      feedSay('br-more', '');
    } else if (brFeed.done) {
      feedSay('br-more', `All ${brFeed.offset} bills.`);
    } else {
      feedSay('br-more', '');
    }
  } catch (e) {
    if (mine === brFeed.token) feedSay('br-more', e.message);
  } finally {
    if (mine === brFeed.token) brFeed.loading = false;
  }
}

function brFill() {
  return feedFill('br-more', brFeed, brNextPage);
}

function brWatch() {
  brFeed.watcher = feedWatch('br-more', brFill);
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

// ---- The catalogue --------------------------------------------------------
//
// The list as it came from the server, plus how the manager is looking at it.
// Held here rather than re-fetched, so a search, a sort or a socket push does
// not cost a round trip — and so a push does not throw away the filter somebody
// is halfway through typing.
let productRows = [];
let productQuery = '';
let productDept = '';
let productSort = { key: null, dir: 1 };
let productsBound = false;

/// Which products are picked for a bulk edit, by id. Held across a re-render
/// (a socket push, a sort) so a manager part-way through choosing ten drinks
/// does not lose them because somebody else saved a price.
let productPicks = new Set();

// What the product form's list boxes are built from: the departments, sub
// departments and VAT rates this venue has already set up. Fetched beside the
// catalogue rather than when the form opens, so picking a department is a
// choice from a list instead of a spelling test — and so the list is on screen
// the instant the modal is.
let productRefs = { departments: [], groups: [], tax: [], modifierGroups: [] };

async function loadProducts() {
  await ensurePrinterNames();
  // One round of requests, not four in series. The reference lists are small
  // and a failure in any of them must not leave the catalogue unreachable, so
  // each falls back to empty rather than rejecting the lot.
  const [rows, departments, groups, tax, modifierGroups] = await Promise.all([
    api('/products'),
    api('/departments').catch(() => []),
    api('/groups').catch(() => []),
    api('/tax').catch(() => []),
    api('/modifier-groups').catch(() => []),
  ]);
  productRows = rows;
  productRefs = { departments, groups, tax, modifierGroups };
  bindProducts();
  renderProducts();
}

function bindProducts() {
  if (productsBound) return;
  productsBound = true;

  const table = $('products');

  /**
   * Save one cell, the moment it is left.
   *
   * On `change` rather than on every keystroke: a manager typing a name should
   * not send eleven requests, and `change` fires on blur and on Enter, which is
   * exactly when they have finished. The row is re-read from `productRows`
   * rather than from the other cells, so an edit sends the product as it is
   * plus the one field that moved.
   */
  const saveCell = async (input) => {
    const tr = input.closest('tr');
    const id = tr?.dataset.product;
    const field = input.dataset.cell;
    if (!id || !field) return;

    const row = productRows.find((r) => String(r.id) === String(id));
    if (!row) return;

    const value = field === 'price' ? Number(input.value) : input.value.trim();
    if (field === 'price' && (!Number.isFinite(value) || value < 0)) {
      input.value = Number(row.price || 0).toFixed(2);
      return;
    }
    // Nothing actually moved — a click into a cell and back out again.
    if (String(row[field] ?? '') === String(value ?? '')) return;

    input.classList.add('saving');
    try {
      // The whole product, with the one field changed. PUT replaces the row, so
      // sending the field alone would blank everything it did not mention.
      const full = await api(`/products/${id}`);
      await api(`/products/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ ...full, [field]: value }),
      });
      row[field] = value;
      input.classList.remove('saving');
      input.classList.add('saved');
      setTimeout(() => input.classList.remove('saved'), 900);
    } catch (err) {
      input.classList.remove('saving');
      alert(err.message);
      // Put back what is actually stored, rather than leaving a value on screen
      // that the catalogue does not have.
      input.value = field === 'price'
        ? Number(row.price || 0).toFixed(2)
        : row[field] ?? '';
    }
  };

  table.addEventListener('change', (e) => {
    const cell = e.target.closest('.cell-edit');
    if (cell) return void saveCell(cell);

    const pick = e.target.closest('[data-pick]');
    if (pick) {
      const id = String(pick.dataset.pick);
      if (pick.checked) productPicks.add(id);
      else productPicks.delete(id);
      renderBulkBar();
    }
  });

  // Enter commits and moves on rather than submitting anything — there is no
  // form here, and a manager working down a column of prices should not have to
  // reach for the mouse between them.
  table.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.closest('.cell-edit')) {
      e.preventDefault();
      e.target.blur();
    }
  });

  $('prod-pick-all').addEventListener('change', (e) => {
    // Every product *shown*, not every product: a manager who has filtered to
    // "gin" and ticks the header means those, and a select-all that quietly
    // included the other four hundred would be found out later.
    for (const row of visibleProducts()) {
      if (e.target.checked) productPicks.add(String(row.id));
      else productPicks.delete(String(row.id));
    }
    renderProducts();
    renderBulkBar();
  });

  $('prod-bulk-clear').addEventListener('click', () => {
    productPicks.clear();
    renderProducts();
    renderBulkBar();
  });

  $('prod-bulk-edit').addEventListener('click', bulkEditProducts);

  $('prod-q').addEventListener('input', (e) => {
    productQuery = e.target.value.trim().toLowerCase();
    renderProducts();
  });
  $('prod-dept').addEventListener('change', (e) => {
    productDept = e.target.value;
    renderProducts();
  });
  $('prod-clear').addEventListener('click', () => {
    productQuery = '';
    productDept = '';
    productSort = { key: null, dir: 1 };
    $('prod-q').value = '';
    renderProducts();
  });

  // Sorting by column, because "which of these has no button position" and
  // "what is dearest" are both questions a manager asks of this table and
  // neither could be asked of it before.
  document
    .querySelectorAll('#view-products th[data-sort]')
    .forEach((th) =>
      th.addEventListener('click', () => {
        const key = th.dataset.sort;
        productSort =
          productSort.key === key
            ? { key, dir: -productSort.dir }
            : { key, dir: 1 };
        renderProducts();
      })
    );
}

/**
 * The rows to draw: filtered, then sorted.
 *
 * The server's own order — department, then button position, then name — is
 * what a manager sees until they ask for something else, because it is the
 * order the till lays the products out in.
 */
function visibleProducts() {
  const rows = productRows.filter((p) => {
    if (productDept && (p.department_name || '') !== productDept) return false;
    if (!productQuery) return true;
    return (
      String(p.product_name || '').toLowerCase().includes(productQuery) ||
      String(p.department_name || '').toLowerCase().includes(productQuery) ||
      String(p.pluid).includes(productQuery)
    );
  });

  const { key, dir } = productSort;
  if (!key) return rows;
  const numeric = ['pluid', 'price', 'tax_percentage'];
  return rows.sort((a, b) => {
    if (numeric.includes(key)) {
      // A product with no button position sorts last either way round: it is
      // the absence that is being looked for, and it belongs together.
      const x = a[key] == null ? Infinity : Number(a[key]);
      const y = b[key] == null ? Infinity : Number(b[key]);
      return (x - y) * dir;
    }
    return String(a[key] ?? '').localeCompare(String(b[key] ?? '')) * dir;
  });
}

/**
 * A dropdown that edits its cell where it sits.
 *
 * The list is what the venue has already set up, plus whatever this product
 * currently holds — a department since renamed still shows, rather than the row
 * silently re-filing itself under the first option the moment anyone touches it.
 */
/**
 * The till's six kitchen slots, plus the receipt printer at the end.
 *
 * Six kitchen stations and no more: offering a seventh would let a manager
 * route food to a station no terminal can print to, and the failure would show
 * up in a kitchen at service rather than in the form.
 *
 * The receipt printer is a routing target too, because a counter often wants
 * its own ticket for an item — a coffee the barista behind the till makes —
 * and the alternative was a kitchen printer pointed at the counter.
 *
 * Top level because both the product form and the bulk editor offer it, and a
 * second copy of "which stations exist" is how the two drift apart.
 */
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

/** The "3 selected" bar, shown only when there is a selection to act on. */
function renderBulkBar() {
  const bar = $('prod-bulk');
  if (!bar) return;
  const n = productPicks.size;
  bar.hidden = n === 0;
  $('prod-bulk-count').textContent = `${n} selected`;
}

/**
 * Change one thing about every picked product.
 *
 * Every field starts blank and blank means "leave alone", which is the only
 * safe default for a form that writes to ten rows at once: a manager who opens
 * this to set a printer route must not have to notice that the price box was
 * pre-filled with something.
 *
 * The one exception is spelled out on screen — clearing a department is said
 * with the explicit "— clear it —" option rather than by leaving a box empty,
 * because those two intentions cannot both be the empty string.
 */
async function bulkEditProducts() {
  const ids = [...productPicks];
  if (!ids.length) return;

  // A value no department could ever be called, so it cannot collide with a
  // real name. Says "clear this field" as distinct from "leave it alone",
  // which is what the empty string already means here.
  const CLEAR = '__clear__';
  const optional = (values) => [
    { value: '', label: 'Leave as they are' },
    { value: CLEAR, label: '— clear it —' },
    ...[...new Set(values.filter(Boolean))].map((v) => ({ value: v, label: v })),
  ];

  return modal(
    `Edit ${ids.length} product${ids.length === 1 ? '' : 's'}`,
    [
      {
        label: 'Department',
        name: 'department_name',
        type: 'select',
        options: optional(productRefs.departments.map((d) => d.department_name)),
        value: '',
      },
      {
        label: 'Sub Department',
        name: 'group_name',
        type: 'select',
        options: optional(productRefs.groups.map((g) => g.group_name)),
        value: '',
      },
      {
        label: 'VAT rate',
        name: 'tax_percentage',
        type: 'select',
        options: [
          { value: '', label: 'Leave as they are' },
          ...productRefs.tax.map((t) => ({
            value: String(Number(t.percentage)),
            label: t.name
              ? `${Number(t.percentage)}% ${t.name}`
              : `${Number(t.percentage)}%`,
          })),
        ],
        value: '',
      },
      { label: 'Price (£) — blank leaves them alone', name: 'price', type: 'money', value: '' },
      {
        label: 'Printers — ticking any replaces what these products had',
        name: 'printer_routes',
        type: 'stations',
        options: printerStations(),
        value: '',
      },
      {
        label: 'Change the printers',
        name: 'routes_touched',
        type: 'checkbox',
        value: 0,
      },
    ],
    async (d) => {
      const fields = {};
      for (const key of ['department_name', 'group_name']) {
        if (d[key] === CLEAR) fields[key] = '';
        else if (d[key]) fields[key] = d[key];
      }
      if (d.tax_percentage) fields.tax_percentage = d.tax_percentage;
      if (d.price !== '' && d.price !== undefined) fields.price = d.price;

      // Routing is opt-in through its own tick, because "no stations ticked" is
      // a real instruction — route these nowhere — and is indistinguishable
      // from "I did not touch this section" otherwise.
      if (ticked(d.routes_touched)) {
        fields.printer_routes = [].concat(d.printer_routes ?? []).filter(Boolean);
      }

      if (!Object.keys(fields).length) {
        throw new Error('Nothing was chosen to change.');
      }

      const res = await api('/products/bulk', {
        method: 'PATCH',
        body: JSON.stringify({ ids, fields }),
      });
      productPicks.clear();
      renderBulkBar();
      alert(`Updated ${res.updated} product${res.updated === 1 ? '' : 's'}.`);
    }
  );
}

function cellSelect(field, values, current) {
  const options = ['<option value="">—</option>'];
  const seen = new Set();
  for (const v of values) {
    if (!v || seen.has(v)) continue;
    seen.add(v);
    options.push(
      `<option value="${esc(v)}"${v === current ? ' selected' : ''}>${esc(v)}</option>`
    );
  }
  if (current && !seen.has(current)) {
    options.push(`<option value="${esc(current)}" selected>${esc(current)}</option>`);
  }
  return `<select class="cell-edit" data-cell="${field}">${options.join('')}</select>`;
}

function renderProducts() {
  const rows = visibleProducts();

  // Two products sharing a PLU is a real fault, not a curiosity: a screen
  // button carries a PLU, and the till indexes the catalogue by it — so one of
  // the two is unreachable and nobody finds out until a clerk rings up the
  // wrong thing. Flagged where the catalogue is edited.
  const plus = new Map();
  for (const p of productRows) {
    plus.set(String(p.pluid), (plus.get(String(p.pluid)) || 0) + 1);
  }

  const departments = [
    ...new Set(productRows.map((p) => p.department_name).filter(Boolean)),
  ].sort();
  $('prod-dept').innerHTML =
    '<option value="">All departments</option>' +
    departments
      .map(
        (d) =>
          `<option value="${esc(d)}"${d === productDept ? ' selected' : ''}>${esc(d)}</option>`
      )
      .join('');

  // Picks for products that have since been deleted are dropped, so the bar
  // cannot offer to edit rows that are not there.
  const live = new Set(productRows.map((r) => String(r.id)));
  for (const id of [...productPicks]) {
    if (!live.has(id)) productPicks.delete(id);
  }
  renderBulkBar();

  $('prod-count').textContent =
    rows.length === productRows.length
      ? `${productRows.length} product${productRows.length === 1 ? '' : 's'}`
      : `${rows.length} of ${productRows.length} products`;

  document.querySelectorAll('#view-products th[data-sort]').forEach((th) => {
    th.classList.toggle('sorted', th.dataset.sort === productSort.key);
    th.dataset.dir = th.dataset.sort === productSort.key
      ? productSort.dir > 0 ? 'up' : 'down'
      : '';
  });

  $('products').innerHTML = rows
    .map(
      (p) => `<tr data-product="${p.id}">
        <td class="pick-col"><input type="checkbox" data-pick="${p.id}"${
          productPicks.has(String(p.id)) ? ' checked' : ''
        }></td>
        <td>${p.image_url
          ? `<img class="thumb" src="${esc(p.image_url)}" alt="" />`
          : p.emoji
          ? `<span class="emoji">${esc(p.emoji)}</span>`
          : ''}<input class="cell-edit" data-cell="product_name" value="${esc(p.product_name)}" />${
          plus.get(String(p.pluid)) > 1
          ? ' <span class="badge archived" title="Another product in this catalogue has the same PLU. The till can only reach one of them.">duplicate PLU</span>'
          : ''}</td>
        <td>${cellSelect('department_name', productRefs.departments.map((d) => d.department_name), p.department_name)}</td>
        <td>${cellSelect('group_name', productRefs.groups.map((g) => g.group_name), p.group_name)}</td>
        <td class="right"><input class="cell-edit right" data-cell="price" type="number" step="0.01" min="0" value="${Number(p.price || 0).toFixed(2)}" /></td>
        <td class="right">${p.tax_percentage || 0}%</td>
        <td>${routeChips(p)}</td>
        <td class="right">
          <button class="btn small ghost" data-edit-product="${p.id}">Edit</button>
          <button class="btn small ghost" data-dup-product="${p.id}">Duplicate</button>
          <button class="btn small danger" data-del-product="${p.id}">Delete</button>
        </td>
      </tr>`
    )
    .join('') ||
    `<tr><td colspan="8" class="empty">${
      productRows.length ? 'No products match that search.' : 'No products.'
    }</td></tr>`;
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
        <td class="right nowrap">
          ${u.staff_id
            // A back-office login and a till operator are two different records
            // that often describe one person: bo_clarks is who signs on at the
            // counter, and the staff pass belongs to that row. Where the two are
            // matched by email, this row can issue and print it; where they are
            // not, the icons say so rather than going missing.
            ? rowCardActions({ kind: 'staff', id: u.staff_id, name: u.name })
            : rowCardActions({ kind: 'staff', id: '', name: u.name, print: false,
                disabled: 'No staff record matches this email, so there is no '
                  + 'card to issue. Add them under Staff first.' })}
          <button class="btn small ghost" data-pw-user="${u.id}">Reset password</button>
          ${u.role !== 'admin'
            ? `<button class="btn small danger" data-del-user="${u.id}">Delete</button>` : ''}
        </td>
      </tr>`
    )
    .join('') || '<tr><td colspan="5" class="empty">No users.</td></tr>';
}

/**
 * How many of each product remain.
 *
 * The count on its own was not telling anybody anything. Every product that
 * does not track stock came out as a flat "0", so a catalogue where nothing is
 * counted looked exactly like a catalogue where everything has run out — a
 * page of zeros that reads as an emergency and means nothing. Three states now,
 * and they are different states:
 *
 *   * **Not tracked** — no figure has ever been set. Said in words, greyed,
 *     because it is the absence of a number rather than the number nought.
 *   * **Out of stock** — tracked, and at or below zero. This is the emergency,
 *     and it is now the only thing that looks like one.
 *   * **Low** — tracked, and at or under the product's own low_stock_at. The
 *     dashboard has counted these for a while; this is the list that says which
 *     ones they are.
 *
 * Out of stock first, then low, then the rest in catalogue order: a stock list
 * is opened to find what needs ordering, and that should not need scrolling to.
 */
async function loadStock() {
  const rows = await api('/products');

  const level = (p) => {
    if (p.stock_quantity === null || p.stock_quantity === undefined) return 'none';
    const left = Number(p.stock_quantity);
    if (!Number.isFinite(left)) return 'none';
    if (left <= 0) return 'out';
    const at = Number(p.low_stock_at);
    return Number.isFinite(at) && p.low_stock_at !== null && left <= at ? 'low' : 'ok';
  };

  const rank = { out: 0, low: 1, ok: 2, none: 3 };
  const sorted = [...rows].sort((a, b) => rank[level(a)] - rank[level(b)]);

  const count = (p) => {
    const left = Number(p.stock_quantity);
    // Stock is a DOUBLE — half a kilo of something is a real quantity — but
    // almost every product is whole, and "12.00 in stock" reads as an error.
    return Number.isInteger(left) ? String(left) : left.toFixed(2);
  };

  const cell = (p) => {
    switch (level(p)) {
      case 'none':
        return '<span class="muted small">Not tracked</span>';
      case 'out':
        return '<span class="badge paused">Out of stock</span>';
      case 'low':
        return `${count(p)} <span class="badge due">Low</span>`;
      default:
        return count(p);
    }
  };

  $('stock').innerHTML =
    sorted
      .map(
        (p) => `<tr>
        <td>${p.pluid}</td>
        <td>${esc(p.product_name)}</td>
        <td>${esc(p.department_name || '—')}</td>
        <td class="right nowrap">${cell(p)}</td>
      </tr>`
      )
      .join('') ||
    '<tr><td colspan="4" class="empty">No products yet.</td></tr>';
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
          ${rowCardActions({ kind: 'staff', id: c.id, name: c.clark_name })}
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
        <td class="muted small">${c.card_number
          // The number on the stripe, and the membership number under it.
          // Two different things a member is asked for: one is swiped, the
          // other is quoted down the phone, and a venue that only ever saw the
          // first could not answer "I am member 42".
          ? `<code>${esc(c.card_number)}</code>${c.member_no
              ? ` <span class="muted">no. ${esc(String(c.member_no))}</span>` : ''}`
          : '—'}</td>
        <td class="muted small">${esc(c.phone || '—')}</td>
        <td class="muted small">${esc(c.email || '—')}</td>
        <td>${discountLabel(c)}</td>
        <td class="right">${c.points_balance || 0}</td>
        <td>${expiry
          ? `<span class="badge ${lapsed ? 'overdue' : 'active'}">${date(expiry)}</span>`
          : '<span class="muted">—</span>'}</td>
        <td class="right nowrap">
          ${rowCardActions({ kind: 'loyalty', id: c.id, name: c.name })}
          <button class="btn small ghost" data-edit-customer="${c.id}">Edit</button>
          <button class="btn small danger" data-del-customer="${c.id}">Delete</button>
        </td>
      </tr>`;
    })
    .join('') || '<tr><td colspan="8" class="empty">No customers yet.</td></tr>';
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

/**
 * How big a room is, in grid units.
 *
 * A floor plan describes a floor. It cannot mean one thing on the laptop it was
 * drawn on and another on the tablet it is opened on, which is what happened
 * while the room was "however wide the browser is": a plan arranged on a
 * desktop had tables sitting outside the room on an iPad, painted and then
 * clipped, unreachable — and the drag clamp below, which measured
 * `canvas.clientWidth`, would not let anything be dragged back into view.
 *
 * 24 x 15 at 40px is 960 x 600, which is a generous dining room and fits a
 * laptop without scrolling. A venue that has already saved something wider
 * keeps it: `roomSize` stretches to hold whatever is there.
 */
const ROOM_COLS = 24;
const ROOM_ROWS = 15;

/**
 * The room this plan needs, never smaller than the plan already in it.
 *
 * The stretch is not a nicety. Without it, opening a plan drawn on a wide
 * screen would clamp every table outside 24 columns back into the room the
 * moment somebody dragged one — silently rearranging a layout a venue had
 * already agreed with its staff.
 */
function roomSize(room) {
  let cols = ROOM_COLS;
  let rows = ROOM_ROWS;
  for (const t of (room && room.tables) || []) {
    cols = Math.max(cols, (t.pos_x || 0) + (t.width || 1));
    rows = Math.max(rows, (t.pos_y || 0) + (t.height || 1));
  }
  return { cols, rows };
}
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

  // The room's own size, handed to the CSS spacer that gives #canvas something
  // to scroll to. Set before the tables are drawn so the box is the right shape
  // on the first paint rather than a frame later.
  const { cols, rows } = roomSize(room);
  canvas.style.setProperty('--room-w', `${cols * GRID}px`);
  canvas.style.setProperty('--room-h', `${rows * GRID}px`);

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
    // Measured once. The room cannot change mid-drag, and walking every table
    // on every pointermove is work done while a finger is moving.
    const size = roomSize(room);

    el.classList.add('dragging');
    el.setPointerCapture(e.pointerId);

    const onMove = (ev) => {
      const dx = Math.round((ev.clientX - startX) / GRID);
      const dy = Math.round((ev.clientY - startY) / GRID);

      // Keep the table in the room: one dragged past the edge would be
      // invisible on the till and unreachable here.
      //
      // Measured against the ROOM, not against `canvas.clientWidth`. The
      // element is as wide as the browser window happens to be, so clamping to
      // it meant the same drag stopped in a different place on a laptop and on
      // a tablet — and on the tablet it stopped a third of the way across a
      // plan the venue had already arranged.
      const maxX = size.cols - table.width;
      const maxY = size.rows - table.height;

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

/**
 * Whether a checkbox in a `modal()` form was ticked.
 *
 * Not `!!value`, and this is not a nicety. The checkbox field submits a hidden
 * input carrying the *string* "0" when it is clear (see fieldHtml), and "0" is
 * truthy in JavaScript — so `!!data.whatever` is true whether the box was
 * ticked or not, and every one of these was reading as ticked.
 *
 * It was found through "creating a new page still copies the page", which is
 * the harmless end of it. The dangerous end was "Replace the existing catalogue
 * first" on the starter-template dialog, which wiped a venue's catalogue
 * whether or not anybody asked it to.
 */
const ticked = (value) => Number(value) === 1;

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
  if (f.type === 'modifiers') {
    // An ordered list, not a set of tick boxes, because the order is the
    // meaning: a bar asks "single or double" before it asks "which mixer", and
    // a product that asks them the other way round is wrong in a way no amount
    // of correct membership fixes.
    //
    // The chosen list carries one hidden input per group, written in list
    // order. That is what the form submits, so the order on screen and the
    // order stored are the same thing rather than two things kept in step.
    const chosen = Array.isArray(f.value) ? f.value : [];
    const byId = new Map(f.options.map((o) => [String(o.id), o]));
    const rowFor = (id) => {
      const g = byId.get(String(id));
      if (!g) return '';
      const rule = Number(g.max_select) === 1
        ? 'pick one'
        : Number(g.max_select) === 0
        ? `pick ${g.min_select || 0}+`
        : `pick ${g.min_select || 0}–${g.max_select}`;
      return `<li class="mod-row" data-mod-id="${g.id}">
        <input type="hidden" name="${f.name}" value="${g.id}" />
        <span class="mod-name">${esc(g.name)}</span>
        <span class="muted small">${esc(rule)}${Number(g.min_select) ? '' : ', skippable'}</span>
        <span class="mod-keys">
          <button type="button" class="btn small ghost" data-mod-up>↑</button>
          <button type="button" class="btn small ghost" data-mod-down>↓</button>
          <button type="button" class="btn small danger" data-mod-remove>✕</button>
        </span>
      </li>`;
    };
    return `<div class="mod-field" data-mod-field>
      <ol class="mod-list">${chosen.map(rowFor).join('')}</ol>
      <div class="mod-add">
        <select data-mod-pick>
          <option value="">Add a question…</option>
          ${f.options
            .map((o) => `<option value="${o.id}">${esc(o.name)}</option>`)
            .join('')}
        </select>
        <button type="button" class="btn small" data-mod-add>Add</button>
      </div>
      ${f.options.length
        ? ''
        : '<p class="muted small">No modifier groups yet — make one under Programming › Modifiers.</p>'}
      <template data-mod-template>${f.options.map((o) => rowFor(o.id)).join('')}</template>
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
 * The two reference scales for fitting a picture into a crop frame, and the
 * floor the zoom slider is allowed to reach.
 *
 *   cover   — the shortest side fills the frame; the long side is cropped off.
 *   contain — the longest side fits inside it, so the whole picture is visible
 *             with clear space around it.
 *
 * `minZoom` is contain expressed as a multiple of cover, because that is what
 * the slider speaks in. It is always <= 1, and exactly 1 for a picture already
 * the frame's shape — there is nothing to zoom out to.
 *
 * At module scope rather than inside openCropper so it can be tested without a
 * canvas: everything below this line is DOM, and everything in here is
 * arithmetic. See test/backoffice-cropper.test.js.
 */
function cropGeometry(imgW, imgH, viewW, viewH) {
  const cover = Math.max(viewW / imgW, viewH / imgH);
  const contain = Math.min(viewW / imgW, viewH / imgH);
  return { cover, contain, minZoom: Math.min(1, contain / cover) };
}

/**
 * Where the drawn picture sits along one axis.
 *
 * Pinned to the frame while it still covers it, centred once it no longer does.
 * The second half is what zooming out needs: a gap is a legitimate thing to ask
 * for now, and a fitted picture shoved into a corner by the old "never show a
 * gap" rule looks like a bug rather than a choice.
 */
function clampCropOffset(drawn, view, off) {
  if (drawn <= view) return (view - drawn) / 2;
  return Math.min(0, Math.max(view - drawn, off));
}

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
            <p class="muted small">Zoom out past the frame to fit a whole picture in — the space around it stays clear.</p>
            <div class="crop-stage" style="width:${VIEW_W}px;height:${VIEW_H}px">
              <canvas id="crop-canvas" width="${VIEW_W}" height="${VIEW_H}"></canvas>
              <div class="crop-frame"></div>
            </div>
            <label class="crop-zoom">Zoom
              <input type="range" id="crop-zoom" min="1" max="4" step="0.01" value="1" />
            </label>
            <div class="crop-presets">
              <button type="button" class="btn ghost small" id="crop-fit">Fit whole picture</button>
              <button type="button" class="btn ghost small" id="crop-fill">Fill the frame</button>
            </div>
            <div class="modal-actions">
              <button type="button" class="btn ghost" id="crop-cancel">Cancel</button>
              <button type="button" class="btn primary" id="crop-save">Use picture</button>
            </div>
          </div>
        </div>`;

      const canvas = $('crop-canvas');
      const ctx = canvas.getContext('2d');

      // Two reference scales, and the difference between them is the whole of
      // this control.
      //
      //   cover   — the shortest side fills the frame. The long side is cropped
      //             off. This is where the slider starts, because it is what a
      //             till tile wants most of the time.
      //   contain — the LONGEST side fits inside the frame, so the entire
      //             picture is visible with clear space around it.
      //
      // The slider used to bottom out at cover, which meant a picture could
      // only ever be cropped and never fitted: a tall bottle shot lost its top
      // and bottom and there was no way to get them back. That is the "too
      // zoomed in" complaint — not that the zoom was wrong, but that the floor
      // was in the wrong place.
      const { cover, minZoom } = cropGeometry(
        img.width, img.height, VIEW_W, VIEW_H
      );

      let zoom = 1;
      let offX = (VIEW_W - img.width * cover) / 2;
      let offY = (VIEW_H - img.height * cover) / 2;

      const scale = () => cover * zoom;

      // Clamped to the frame while the picture covers it, centred once it no
      // longer does. Without the second half, zooming out would leave the
      // picture pinned to a corner by the old "never show a gap" rule — a gap
      // is now a legitimate thing to ask for, and a fitted picture that sits
      // off to one side looks like a bug rather than a choice.
      function clamp() {
        offX = clampCropOffset(img.width * scale(), VIEW_W, offX);
        offY = clampCropOffset(img.height * scale(), VIEW_H, offY);
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

      // The slider can now go below 1. Set here rather than in the markup
      // because it depends on the picture's own proportions — a panorama can
      // zoom a long way out, a square cannot zoom out at all.
      const zoomEl = $('crop-zoom');
      zoomEl.min = minZoom.toFixed(4);
      zoomEl.value = 1;

      // Zoom keeps the viewport centre stable so the framing does not lurch.
      function setZoom(next) {
        const wanted = Math.min(4, Math.max(minZoom, next));
        const cx = VIEW_W / 2, cy = VIEW_H / 2;
        const k = (cover * wanted) / scale();
        offX = cx - (cx - offX) * k;
        offY = cy - (cy - offY) * k;
        zoom = wanted;
        zoomEl.value = wanted;
        draw();
      }

      zoomEl.addEventListener('input', (e) => setZoom(parseFloat(e.target.value)));

      // The two ends of the slider, as buttons. A manager who wants the whole
      // bottle in the picture should not have to discover that by dragging a
      // slider to a place it previously refused to go.
      $('crop-fit').onclick = () => setZoom(minZoom);
      $('crop-fill').onclick = () => setZoom(1);

      const done = (blob) => { URL.revokeObjectURL(url); root.innerHTML = ''; blob ? resolve(blob) : reject(new Error('cancelled')); };
      $('crop-cancel').onclick = () => done(null);
      $('crop-save').onclick = () => {
        // Redraw the framed region at output resolution.
        const out = document.createElement('canvas');
        out.width = OUT_W; out.height = OUT_H;
        const octx = out.getContext('2d');
        // Transparent, not white. A zoomed-out picture now has space around it,
        // and on the till that space should let the tile's own colour through —
        // a white box on a coloured button reads as a broken image. PNG carries
        // the alpha; the upload is already PNG.
        octx.clearRect(0, 0, OUT_W, OUT_H);
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

  // The ordered modifier picker: add, reorder, remove. Everything it does is a
  // move of one <li>, because the list *is* the value — each row carries the
  // hidden input that gets submitted, so re-ordering the rows re-orders what is
  // saved without anything having to be kept in step.
  root.querySelectorAll('[data-mod-field]').forEach((field) => {
    const list = field.querySelector('.mod-list');
    const template = field.querySelector('[data-mod-template]');

    const has = (id) => !!list.querySelector(`[data-mod-id="${CSS.escape(String(id))}"]`);

    field.querySelector('[data-mod-add]')?.addEventListener('click', () => {
      const pick = field.querySelector('[data-mod-pick]');
      const id = pick.value;
      // Asking the same question twice about one product is always a mistake,
      // and the database refuses it anyway — so it is refused here quietly
      // rather than saved and rejected.
      if (!id || has(id)) return;
      const row = template.content
        ? template.content.querySelector(`[data-mod-id="${CSS.escape(id)}"]`)
        : null;
      // The template is inert markup in some browsers and parsed content in
      // others; fall back to re-parsing rather than depending on which.
      if (row) {
        list.appendChild(row.cloneNode(true));
      } else {
        const holder = document.createElement('div');
        holder.innerHTML = template.innerHTML;
        const found = holder.querySelector(`[data-mod-id="${CSS.escape(id)}"]`);
        if (found) list.appendChild(found);
      }
      pick.value = '';
    });

    list.addEventListener('click', (e) => {
      const row = e.target.closest('.mod-row');
      if (!row) return;
      if (e.target.closest('[data-mod-remove]')) row.remove();
      else if (e.target.closest('[data-mod-up]')) {
        if (row.previousElementSibling) {
          list.insertBefore(row, row.previousElementSibling);
        }
      } else if (e.target.closest('[data-mod-down]')) {
        if (row.nextElementSibling) {
          list.insertBefore(row.nextElementSibling, row);
        }
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
    // This is a press, which is what lets the screen editor open a window of
    // its own — see spEnterView. A deep link or the back button is not.
    return show(t.dataset.view, { userInitiated: true });
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
  // A modifier group's answers are a grid of buttons, so they are laid out in
  // the screen editor rather than in a form of their own. The editor cannot be
  // pointed at a screen until it has loaded, so the id is left for it to pick
  // up — see spOpenScreen in screens.js.
  if (t.dataset.editAnswers) {
    // Straight into the editor window, rather than into the tab and then out
    // to the window: a manager who presses "Edit answers" wants the grid, and
    // the two-step version put the Modifiers page behind them for no reason.
    // `spPopOut` returns false when the browser blocked it, and then the
    // ordinary in-tab route is exactly what it always was.
    if (typeof spPopOut === 'function' && spWantsOwnWindow()) {
      if (spPopOut(t.dataset.editAnswers)) return;
    }
    spOpenScreen(t.dataset.editAnswers);
    show('screens');
    return;
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

  if (t.id === 'ts-run') return loadTimesheets();

  // Somebody forgets to clock out and goes home; without this the row runs for
  // ever and the week's total is nonsense. Every edit is stamped by the server,
  // and an edited row says so on the page.
  if (t.dataset.editShift) {
    const rows = await api('/timesheets');
    const row = rows.find((r) => String(r.id) === String(t.dataset.editShift));
    if (!row) return;
    // <input type="datetime-local"> wants local wall-clock time with no zone.
    const local = (iso) => {
      if (!iso) return '';
      const d = new Date(iso);
      const pad = (n) => String(n).padStart(2, '0');
      return (
        d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
        'T' + pad(d.getHours()) + ':' + pad(d.getMinutes())
      );
    };
    return modal(
      'Correct ' + (row.staff_name || 'this shift'),
      [
        {
          name: 'clocked_in_at',
          label: 'Clocked in',
          type: 'datetime-local',
          value: local(row.clocked_in_at),
        },
        {
          name: 'clocked_out_at',
          label: 'Clocked out \u2014 leave empty to reopen the shift',
          type: 'datetime-local',
          value: local(row.clocked_out_at),
        },
        { name: 'note', label: 'Why it was corrected', value: row.note || '' },
      ],
      (d) =>
        api('/timesheets/' + row.id, {
          method: 'PUT',
          body: JSON.stringify({
            clocked_in_at: d.clocked_in_at ? d.clocked_in_at.replace('T', ' ') : null,
            clocked_out_at: d.clocked_out_at ? d.clocked_out_at.replace('T', ' ') : null,
            note: d.note || null,
          }),
        })
    );
  }

  if (t.dataset.delShift && confirm('Delete this shift? The hours go with it.')) {
    await api('/timesheets/' + t.dataset.delShift, { method: 'DELETE' });
    return loadTimesheets();
  }

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

  /** The pre-numbering routing names, as the station they now mean. */
  const legacyStation = (route) => {
    const key = String(route ?? '').trim().toLowerCase();
    return key === 'kitchen' ? 'kp1' : key === 'bar' ? 'kp2' : key;
  };

  /**
   * The choices for a list box, as {value,label} pairs, with a blank first
   * entry so "not set yet" stays sayable. Anything the product already holds
   * that is no longer in the list is added back on the end: a department that
   * was renamed or deleted must not silently re-file every product under it
   * the next time somebody opens the form to change a price.
   */
  const pickList = (values, current, blank = 'Please select…') => {
    const options = [{ value: '', label: blank }];
    const seen = new Set();
    for (const v of values) {
      if (v === undefined || v === null || v === '' || seen.has(String(v))) continue;
      seen.add(String(v));
      options.push({ value: v, label: v });
    }
    if (current && !seen.has(String(current))) {
      options.push({ value: current, label: `${current} (no longer listed)` });
    }
    return options;
  };

  const productFields = (p = {}) => [
    // No PLU field. The number still exists and still matters — the till
    // indexes by it and order lines reference it — but it is the server's job
    // to allocate, not a question to ask somebody adding a bottle of coke.
    // See POST /products, which fills in the next free one.
    { label: 'Name', name: 'product_name', required: true, value: p.product_name ?? '' },
    {
      label: 'Department',
      name: 'department_name',
      type: 'select',
      options: pickList(
        productRefs.departments.map((d) => d.department_name),
        p.department_name
      ),
      value: p.department_name ?? '',
    },
    {
      label: 'Sub Department',
      name: 'group_name',
      type: 'select',
      options: pickList(
        productRefs.groups.map((g) => g.group_name),
        p.group_name
      ),
      value: p.group_name ?? '',
    },
    // `money`, not `number`: a bare number input steps in whole units, so the
    // browser rejected £2.05 and offered the two "nearest valid values", 2 and
    // 3. Every price with pence in it was unenterable.
    { label: 'Price (£)', name: 'price', type: 'money', value: p.price ?? 0 },
    {
      label: 'VAT rate',
      name: 'tax_percentage',
      type: 'select',
      // Built from the rates set up under Programming › Tax, so a venue picks
      // "20% Standard Rate" rather than typing a number that has to match one.
      options: (() => {
        const rates = productRefs.tax.map((t) => ({
          value: String(Number(t.percentage)),
          label: t.name ? `${Number(t.percentage)}% ${t.name}` : `${Number(t.percentage)}%`,
        }));
        const current = p.tax_percentage ?? '';
        if (!rates.length) return pickList(['0', '5', '20'], String(Number(current || 0)));
        if (current !== '' && !rates.some((r) => r.value === String(Number(current)))) {
          rates.push({
            value: String(Number(current)),
            label: `${Number(current)}% (no longer listed)`,
          });
        }
        return rates;
      })(),
      value: String(Number(p.tax_percentage ?? 20)),
    },
    { label: 'Stock', name: 'stock_quantity', type: 'number', value: p.stock_quantity ?? 0 },
    // No button colour, no button position, no emoji. All three belong to the
    // screen editor now — that is where the layout, the colour, the size, the
    // lettering and the face of every key are set. Two places to style one
    // button meant the one you did not use won, and "button position" was a
    // number a manager had to hold in their head to arrange a grid they could
    // not see.
    //
    // The columns are not gone and are not cleared: a save that does not
    // mention a field leaves it alone (see PUT /products/:id). button_position
    // still orders the built-in Default screen for venues that have programmed
    // nothing, and a product's emoji is still the face a key falls back to.
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
      label: 'Modifiers — the questions this product asks, in order',
      name: 'modifier_group_ids',
      type: 'modifiers',
      options: productRefs.modifierGroups,
      value: p.modifier_group_ids || [],
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

  /**
   * The questions, saved after the product itself.
   *
   * A separate call because it is a separate table with its own ordering, and
   * because a product must be saved before it can be keyed off — a new one has
   * no PLU until the server allocates it.
   *
   * A failure here is reported rather than swallowed: silently keeping the
   * price change and dropping the modifier wiring is exactly the false success
   * the reference back office shows, where "updated successfully" appears over
   * a modifier that was never attached.
   */
  const saveModifiers = async (plu, data) => {
    if (!plu || data.modifier_group_ids === undefined) return;
    const ids = []
      .concat(data.modifier_group_ids)
      .map((n) => Number(n))
      .filter(Number.isFinite);
    await api(`/products/${plu}/modifiers`, {
      method: 'PUT',
      body: JSON.stringify({ group_ids: ids }),
    });
  };

  if (t.id === 'add-product') {
    return modal('Add product', productFields(), async (d) => {
      const made = await api('/products', { method: 'POST', body: JSON.stringify(d) });
      await saveModifiers(made.pluid, d);
    });
  }
  if (t.dataset.editProduct) {
    const p = await api(`/products/${t.dataset.editProduct}`);
    const attached = await api(`/products/${p.pluid}/modifiers`).catch(() => []);
    p.modifier_group_ids = attached.map((g) => g.id);
    return modal('Edit product', productFields(p), async (d) => {
      await api(`/products/${p.id}`, { method: 'PUT', body: JSON.stringify(d) });
      await saveModifiers(p.pluid, d);
    });
  }
  // Half a catalogue is a variant of the other half — the same burger with
  // cheese, the same wine by the glass. This opens the add form with everything
  // already filled in, including a PLU that is free, because "which numbers am I
  // not using" is not a question this form should send somebody away to answer.
  if (t.dataset.dupProduct) {
    const p = await api(`/products/${t.dataset.dupProduct}`);
    const attached = await api(`/products/${p.pluid}/modifiers`).catch(() => []);
    p.modifier_group_ids = attached.map((g) => g.id);
    // No longer hunts for a free PLU before opening the form — the server
    // allocates one on save, which is the only place that can do it without
    // racing another manager doing the same thing.
    return modal(
      'Duplicate product',
      productFields({ ...p, product_name: `${p.product_name} (copy)` }),
      async (d) => {
        const made = await api('/products', { method: 'POST', body: JSON.stringify(d) });
        await saveModifiers(made.pluid, d);
      }
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
      <td class="right nowrap">
        ${rowCardActions({ kind: 'promo', id: r.id, name: r.name })}
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
    stackable: ticked(data.stackable),
    active: ticked(data.active),
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
      <td class="right nowrap">
        ${rowCardActions({
          kind: 'giftcard', id: r.id, name: r.recipient_name || r.code,
          // A voided or spent card still prints and still opens: the holder has
          // to be able to see that the card was theirs and is empty, which is
          // the same reason loadSubject() keeps returning it.
        })}
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
      <td class="right nowrap">
        ${printOnlyAction({
          what: 'deposit', id: r.id, name: r.customer_name || r.reference,
          why: 'A deposit is money held against a bill, not a card. It prints as '
            + 'a receipt.',
        })}
        <button class="btn small" data-deposit-edit="${r.id}">Edit</button>
      </td>
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

// ---- Wallet passes --------------------------------------------------------
//
// One set of branding, two platforms. The venue fills this in once and both an
// iPhone and an Android phone get a card that looks like the venue rather than
// like a default.
//
// The preview is the point of the page. A pass is a thing a customer looks at,
// and a form of colour pickers with no picture beside it is a form nobody can
// tell they have got right.

let walletState = null;
let walletApple = null;

const WALLET_KINDS = [
  { key: 'loyalty', label: 'Loyalty', field: 'Points', value: '240' },
  { key: 'customer', label: 'Membership', field: 'Member', value: 'S. Jones' },
  { key: 'giftcard', label: 'Gift card', field: 'Balance', value: '£25.50' },
  { key: 'staff', label: 'Staff', field: 'Staff', value: 'O. Price' },
  { key: 'promo', label: 'Offer', field: 'Offer', value: '2 for 1' },
];

async function loadWallet() {
  walletState = await api('/wallet/settings');

  for (const el of document.querySelectorAll('[data-wal]')) {
    const value = walletState[el.dataset.wal];
    if (el.type === 'checkbox') el.checked = !!Number(value);
    else if (el.type === 'color') el.value = normaliseHex(value, el.defaultValue);
    else el.value = value ?? '';
  }

  const live = WALLET_KINDS.filter((k) => Number(walletState[`${k.key}_enabled`]));
  statCards($('wallet-stats'), [
    {
      label: 'Passes',
      value: Number(walletState.enabled) ? 'On' : 'Off',
      tone: Number(walletState.enabled) ? 'green' : 'red',
    },
    { label: 'Cards offered', value: String(live.length), tone: 'primary',
      hint: live.map((k) => k.label).join(', ') || 'None' },
    // Filled in by loadWalletApple once it has asked. Not guessed from the
    // settings row: whether a pass can be *signed* is a property of the
    // deployment, not of what the venue has typed.
    { label: 'Apple Wallet', value: '…', tone: '' },
    { label: 'Cards issued', value: '…', tone: '' },
  ]);

  renderWalletArt();
  walletPreview();
  await Promise.all([
    loadWalletDesign(), loadWalletApple(), loadWalletPasses(), walletJoinCode(),
  ]);
  // The designer inherits from the form above, which is only filled in once
  // the settings have arrived -- so the first draw has to come after both.
  renderWalletKinds();
  walletDesignPreview();
}

/** A colour input will not accept an empty value, so blank means "the brand". */
function normaliseHex(value, fallback) {
  const hex = String(value || '').trim();
  return /^#?[0-9a-f]{6}$/i.test(hex) ? (hex.startsWith('#') ? hex : `#${hex}`) : fallback;
}

/**
 * The venue's initials, exactly as memberNumber() builds them in
 * src/wallet_apple.js: articles dropped, capped at three. Shown in the preview
 * so a venue can see what their members' numbers will actually read as before
 * anybody is handed one.
 */
const WAL_NOISE = ['the', 'a', 'an', 'of', 'and', 'at', 'on', '&'];
function walletInitials(venue) {
  return String(venue || '')
    .split(/[\s-]+/)
    .map((w) => w.replace(/[^A-Za-z]/g, ''))
    .filter((w) => w && !WAL_NOISE.includes(w.toLowerCase()))
    .slice(0, 3)
    .map((w) => w[0].toUpperCase())
    .join('') || 'V';
}

// The header field, top right of the card. Every kind but staff has one, and it
// is the field the push notification speaks through.
const WAL_HEADER = {
  loyalty: ['NEXT REWARD', '40 to go'],
  customer: ['TIER', 'Gold'],
  giftcard: ['GIFT CARD', '···· 0001'],
  promo: ['ENDS IN', '3 days'],
  staff: null,
};

// The loyalty strip carries a progress bar, and it is baked into the image
// rather than drawn by Wallet — PassKit has fields and images and nothing in
// between, so tools/wallet_art renders eleven states and the server picks one.
// The preview shows the 40% band so the bar is visible at all; a real card
// picks the step nearest that customer's balance.
const WAL_STRIP = { loyalty: 'strip_loyalty_p040' };

/** One row of "label / value" under the strip, per kind. */
function walletDetails(kind, venue) {
  const initials = walletInitials(venue);
  return ({
    loyalty: [['MEMBER', 'Sarah Jones'], ['TIER', 'Gold · 10% off'],
              ['MEMBER NO.', `${initials} · 0241`]],
    customer: [['YOUR DISCOUNT', '10% off'], ['MEMBER SINCE', 'March 2024'],
               ['MEMBER NO.', `${initials} · 0241`]],
    giftcard: [['FOR', 'Owen Price'], ['LOADED', 'of £50.00'], ['EXPIRES', '2027-01-14']],
    staff: [['ROLE', 'Manager'], ['SITE', venue], ['CARD', '999900007']],
    promo: [['WHEN', 'Mon–Fri, 5pm–7pm'], ['ENDS', '2026-12-31']],
  })[kind] || [];
}

/**
 * One card, drawn.
 *
 * Not a mock-up of Apple's chrome — that would be a promise this page cannot
 * keep, because iOS draws the card and its rendering is not ours. It is the
 * four things the venue actually controls: the artwork, the colours, the words
 * and which fields carry them, in the arrangement the pass puts them in.
 *
 * Apple lays a pass out at 375pt wide and this is capped to match. It used to
 * render at whatever width the panel happened to be, which made a loyalty card
 * look like a poster and hid how little room the fields actually have. A design
 * that only works at 600px wide is a design that does not work.
 *
 * The fields shown are the ones buildPassJson() actually writes, in the same
 * order and the same three tiers, so this stops being decoration and starts
 * being a rehearsal.
 */
function walletCardHtml(kind, d) {
  const meta = WALLET_KINDS.find((k) => k.key === kind) || WALLET_KINDS[0];
  const background = d.hex_background || '#111111';
  const foreground = d.hex_foreground || '#F2F4F0';
  const label = d.hex_label || '#A5C715';
  const programme = d.program_name || 'Your Rewards';
  const venue = d.issuer_name || 'Your venue';

  const details = walletDetails(kind, venue)
    .map(([l, v]) => `
      <div class="wal-pass-field">
        <span class="wal-pass-label" style="color:${esc(label)}">${esc(l)}</span>
        <span class="wal-pass-small">${esc(v)}</span>
      </div>`)
    .join('');

  const header = WAL_HEADER[kind];

  // The venue's own band when they have uploaded one, otherwise the artwork
  // generated for this kind. Same order of preference as artworkFor() on the
  // server, so the preview and the card agree about which picture wins.
  const strip = d.strip_url
    ? esc(d.strip_url)
    : `/assets/wallet/${esc(WAL_STRIP[kind] || `strip_${kind}`)}.png`;

  return `
    <figure class="wal-pass" style="background:${esc(background)};color:${esc(foreground)}">
      <div class="wal-pass-head">
        <img class="wal-pass-mark" src="${d.logo_url ? esc(d.logo_url) : '/assets/wallet/logo@2x.png'}" alt="">
        <span class="wal-pass-logo">${esc(venue)}</span>
        ${header ? `
        <span class="wal-pass-header">
          <span class="wal-pass-label" style="color:${esc(label)}">${esc(header[0])}</span>
          <span class="wal-pass-small">${esc(header[1])}</span>
        </span>` : ''}
      </div>
      <div class="wal-pass-strip" style="background-image:url('${strip}')">
        <div class="wal-pass-primary">
          <span class="wal-pass-label" style="color:${esc(label)}">${esc(meta.field)}</span>
          <span class="wal-pass-value">${esc(meta.value)}</span>
        </div>
      </div>
      ${details ? `<div class="wal-pass-fields">${details}</div>` : ''}
      <div class="wal-pass-foot">
        <span class="wal-pass-code"></span>
        <span class="wal-pass-venue" style="color:${esc(label)}">${esc(programme)}</span>
      </div>
    </figure>`;
}

/**
 * The venue-wide preview: every card they have switched on, in their colours.
 *
 * Reads the form rather than the saved row, so it moves while a colour is being
 * dragged. Per-card overrides are deliberately not applied here — this tab is
 * the look everything starts from, and showing five already-overridden cards
 * would hide the thing being edited.
 */
function walletPreview() {
  const read = (name) => {
    const el = document.querySelector(`[data-wal="${name}"]`);
    return el ? el.value : '';
  };
  const base = {
    hex_background: read('hex_background'),
    hex_foreground: read('hex_foreground'),
    hex_label: read('hex_label'),
    program_name: read('program_name'),
    issuer_name: read('issuer_name'),
    // The two pictures live on walletState rather than in an input, so they are
    // taken from there — and the venue's band is `photo_url`, which is what a
    // card with no design of its own falls back to.
    strip_url: (walletState && walletState.photo_url) || '',
    logo_url: (walletState && walletState.logo_url) || '',
  };

  const cards = WALLET_KINDS.filter((k) =>
    document.querySelector(`[data-wal="${k.key}_enabled"]`)?.checked
  );

  const box = $('wallet-preview');
  if (box) {
    box.innerHTML = (cards.length ? cards : [WALLET_KINDS[0]])
      .map((k) => walletCardHtml(k.key, base)).join('');
  }

  // The designer's card sits on another tab and shows the same venue defaults
  // under whatever that card overrides, so it has to move too.
  walletDesignPreview();
}


// ---------------------------------------------------------------------------
// The pass designer
// ---------------------------------------------------------------------------
//
// Five cards, designed one at a time, each against a live drawing of itself.
//
// WHAT WAS WRONG WITH WHAT THIS REPLACED
//
// One set of colours for all five cards, and a column of free-text boxes. A
// venue whose gift card should look nothing like its staff card had no way to
// say so -- and epos_wallet_programs, which exists precisely to hold that, had
// no route pointing at it. So the answer to "where do I design the cards" was
// "you cannot", given by a screen that looked as though you could.
//
// THE RULE THE WHOLE SCREEN RESTS ON
//
// Blank means inherit. A venue sets its look once on the Programme tab, opens
// one card, changes the two things that should differ, and the other four stay
// in step with the venue's brand for ever after. That is why every box here
// shows the inherited value as its placeholder and why "Use the venue's look"
// clears rather than copies: copying would freeze today's brand into a card
// nobody remembers overriding.

/** The five designs as the server resolved them, and which one is open. */
let walletPrograms = null;
let walletDesignKind = 'loyalty';
/** Edits not yet saved, per kind. Cleared when a card is saved or reset. */
let walletDesignDraft = {};

/**
 * Apple's own pixel sizes. The browser is the codec; see POST /wallet/artwork.
 *
 * OUT_* is @1x and the upload sends @2x alongside it. These are Apple's
 * published sizes for a storeCard: 375x123 for the strip, 160x50 for the logo.
 * Google accepts anything and crops to its own ratio, so matching Apple exactly
 * is the constraint that satisfies both.
 */
const WAL_ART = {
  strip: { OUT_W: 375, OUT_H: 123, VIEW_W: 330, VIEW_H: 108 },
  logo: { OUT_W: 160, OUT_H: 50, VIEW_W: 288, VIEW_H: 90 },
};

async function loadWalletDesign() {
  try {
    walletPrograms = await api('/wallet/programs');
  } catch {
    // A server without the migration. The rest of the Wallet screen works, and
    // saying so beats an empty panel that reads as a card with no design.
    $('wal-design-editor').innerHTML =
      '<p class="muted small">The pass designer is not available on this server yet.</p>';
    return;
  }
  walletDesignDraft = {};
  renderWalletKinds();
  renderWalletDesignEditor();
}

/** The design currently on screen: what was saved, plus anything unsaved. */
function walletDesignOf(kind) {
  const saved = (walletPrograms || []).find((p) => p.kind === kind) || { kind };
  return { ...saved, ...(walletDesignDraft[kind] || {}) };
}

/**
 * What the card will actually look like: the venue's own branding with this
 * card's overrides laid on top.
 *
 * The same merge readProgramBrand() does on the server, and it has to stay the
 * same one — a preview that resolves inheritance differently from the thing
 * that builds the pass is worse than no preview, because it is believed.
 */
function walletResolved(kind) {
  const design = walletDesignOf(kind);
  const venue = (name) => {
    const el = document.querySelector(`[data-wal="${name}"]`);
    return el ? el.value : (walletState ? walletState[name] : '') || '';
  };
  const pick = (field) => {
    const own = String(design[field] ?? '').trim();
    return own || venue(field);
  };
  return {
    hex_background: pick('hex_background'),
    hex_foreground: pick('hex_foreground'),
    hex_label: pick('hex_label'),
    program_name: pick('program_name'),
    issuer_name: venue('issuer_name'),
    logo_url: venue('logo_url'),
    // This card's own band, then the venue's. Same order artworkFor() uses on
    // the server, so the preview and the issued card agree about which picture
    // wins.
    strip_url: String(design.strip_url ?? '').trim() || venue('photo_url'),
  };
}

function renderWalletKinds() {
  const nav = $('wal-kinds');
  if (!nav) return;

  nav.innerHTML = WALLET_KINDS.map((k) => {
    const design = walletDesignOf(k.key);
    const on = document.querySelector(`[data-wal="${k.key}_enabled"]`)?.checked;
    // "Own look" is the honest word for it: the row exists in the table either
    // way, and what a manager wants to know at a glance is which of the five
    // they have actually changed.
    const own = ['program_name', 'hex_background', 'hex_foreground', 'hex_label',
      'strip_url', 'terms', 'change_message']
      .some((f) => String(design[f] ?? '').trim());
    const dirty = Boolean(walletDesignDraft[k.key]);
    return `
      <button class="wal-kind${k.key === walletDesignKind ? ' on' : ''}"
              data-walkind="${esc(k.key)}" role="tab">
        <span class="wal-kind-name">${esc(k.label)}</span>
        <span class="wal-kind-meta">
          ${on ? '' : '<span class="pill">not issued</span>'}
          ${own ? '<span class="pill on">own look</span>' : ''}
          ${dirty ? '<span class="pill amber">unsaved</span>' : ''}
        </span>
      </button>`;
  }).join('');
}

function renderWalletDesignEditor() {
  const box = $('wal-design-editor');
  if (!box || !walletPrograms) return;

  const kind = walletDesignKind;
  const design = walletDesignOf(kind);
  const meta = WALLET_KINDS.find((k) => k.key === kind) || WALLET_KINDS[0];
  const venue = (name) => {
    const el = document.querySelector(`[data-wal="${name}"]`);
    return el ? el.value : '';
  };

  // Every colour input needs a value -- a browser will not accept an empty one
  // -- so an inherited colour shows the venue's, and the switch beside it is
  // what says whether this card owns it. Without that switch there would be no
  // way to tell "the same as the venue" from "deliberately this colour", and no
  // way back to inheriting once anything was touched.
  const colour = (field, label) => {
    const own = String(design[field] ?? '').trim();
    return `
      <div class="wal-colour">
        <label>${esc(label)}
          <input type="color" data-design="${esc(field)}"
                 value="${esc(normaliseHex(own || venue(field), '#111111'))}">
        </label>
        <label class="check small">
          <input type="checkbox" data-design-own="${esc(field)}" ${own ? 'checked' : ''}>
          Own colour
        </label>
      </div>`;
  };

  box.innerHTML = `
    <div class="card rd-card">
      <h3>${esc(meta.label)} card</h3>
      <p class="muted small">
        Anything left alone here follows the venue's own look, so changing the
        brand later changes this card with it. Fill something in and this card
        keeps it.
      </p>

      <label>Name on the card
        <input type="text" maxlength="120" data-design="program_name"
               value="${esc(design.program_name || '')}"
               placeholder="${esc(venue('program_name') || 'Your Rewards')}">
      </label>

      <h4>Colours</h4>
      <div class="wal-colours-grid">
        ${colour('hex_background', 'Background')}
        ${colour('hex_foreground', 'Text')}
        ${colour('hex_label', 'Labels')}
      </div>

      <h4>Artwork</h4>
      <p class="muted small">
        The band across the card. Choose a picture and you get a frame to move
        and zoom it in — what you frame is what is saved, at the two sizes Apple
        needs and the one Google fetches. Both phones show the same band.
      </p>
      <div class="wal-art">
        <div class="wal-art-preview">
          ${design.strip_url
            ? `<img src="${esc(design.strip_url)}" alt="Card artwork">`
            : '<span class="muted small">Using the generated artwork</span>'}
        </div>
        <div class="wal-art-actions">
          <label class="btn small">Choose a picture
            <input type="file" accept="image/*" id="wal-art-file" hidden>
          </label>
          ${design.strip_url
            ? '<button class="btn small ghost" id="wal-art-clear">Use the generated artwork</button>'
            : ''}
        </div>
      </div>

      <h4>Words</h4>
      <label>What the phone says when this card changes
        <input type="text" maxlength="255" data-design="change_message"
               value="${esc(design.change_message || '')}"
               placeholder="Your balance is now %@">
      </label>
      <p class="muted small">
        <code>%@</code> is replaced by the new value. Leave it blank and the
        card updates silently.
      </p>
      <label>Terms for this card
        <textarea rows="3" data-design="terms"
                  placeholder="${esc(venue('terms') || 'Follows the venue’s terms')}">${esc(design.terms || '')}</textarea>
      </label>

      <div class="wal-design-actions">
        <button class="btn primary" id="wal-design-save">Save this card</button>
        <button class="btn ghost" id="wal-design-reset">Use the venue's look</button>
        <span class="muted small" id="wal-design-note"></span>
      </div>
    </div>`;

  walletDesignPreview();
}

function walletDesignPreview() {
  const box = $('wal-design-card');
  if (!box || !walletPrograms) return;
  box.innerHTML = walletCardHtml(walletDesignKind, walletResolved(walletDesignKind));
}

/** Record one edit without redrawing the editor out from under the cursor. */
function walletDesignEdit(field, value) {
  const kind = walletDesignKind;
  walletDesignDraft[kind] = { ...(walletDesignDraft[kind] || {}), [field]: value };
  walletDesignPreview();
  renderWalletKinds();
}

document.addEventListener('click', async (e) => {
  // ---- Tabs ----
  const tab = e.target.closest && e.target.closest('[data-waltab]');
  if (tab) {
    const want = tab.dataset.waltab;
    document.querySelectorAll('[data-waltab]').forEach((t) =>
      t.classList.toggle('on', t === tab));
    document.querySelectorAll('[data-walpanel]').forEach((p) => {
      p.hidden = p.dataset.walpanel !== want;
    });
    // The join code draws into a panel that was display:none when it was first
    // asked for, and an SVG measured at zero stays at zero. Redrawn on arrival.
    if (want === 'programme') walletJoinCode();
    return;
  }

  // ---- Which card ----
  const kindBtn = e.target.closest && e.target.closest('[data-walkind]');
  if (kindBtn) {
    walletDesignKind = kindBtn.dataset.walkind;
    renderWalletKinds();
    renderWalletDesignEditor();
    return;
  }

  // ---- Clear the artwork ----
  if (e.target.id === 'wal-art-clear') {
    walletDesignEdit('strip_url', '');
    renderWalletDesignEditor();
    return;
  }

  // ---- Save one card ----
  if (e.target.id === 'wal-design-save') {
    const kind = walletDesignKind;
    const body = {};
    for (const el of document.querySelectorAll('#wal-design-editor [data-design]')) {
      body[el.dataset.design] = el.value;
    }
    // A colour whose "Own colour" box is clear is stored as '' — which the
    // server and readProgramBrand() both read as "inherit". This is the only
    // way back to the venue's look once a colour has been picked, because the
    // input itself can never be empty.
    for (const el of document.querySelectorAll('#wal-design-editor [data-design-own]')) {
      if (!el.checked) body[el.dataset.designOwn] = '';
    }
    body.strip_url = walletDesignOf(kind).strip_url || '';

    e.target.disabled = true;
    try {
      const saved = await api(`/wallet/programs/${encodeURIComponent(kind)}`, {
        method: 'PUT', body: JSON.stringify(body),
      });
      walletPrograms = (walletPrograms || []).map((p) => (p.kind === kind ? saved : p));
      delete walletDesignDraft[kind];
      renderWalletKinds();
      renderWalletDesignEditor();
      $('wal-design-note').textContent = 'Saved ✓';
      setTimeout(() => {
        const note = $('wal-design-note');
        if (note) note.textContent = '';
      }, 1500);
    } catch (err) {
      alert(String(err && err.message ? err.message : err));
    } finally {
      e.target.disabled = false;
    }
    return;
  }

  // ---- Back to the venue's look ----
  if (e.target.id === 'wal-design-reset') {
    if (!confirm(
      'Put this card back to the venue’s own look?\n\n'
      + 'Its name, colours, artwork and words are cleared, and it follows the '
      + 'Programme tab again from now on.'
    )) return;
    const kind = walletDesignKind;
    try {
      const saved = await api(`/wallet/programs/${encodeURIComponent(kind)}`, {
        method: 'PUT',
        body: JSON.stringify({
          program_name: '', hex_background: '', hex_foreground: '', hex_label: '',
          strip_url: '', terms: '', change_message: '',
        }),
      });
      walletPrograms = (walletPrograms || []).map((p) => (p.kind === kind ? saved : p));
      delete walletDesignDraft[kind];
      renderWalletKinds();
      renderWalletDesignEditor();
    } catch (err) {
      alert(String(err && err.message ? err.message : err));
    }
  }
});

document.addEventListener('input', (e) => {
  if (e.target.matches('#wal-design-editor [data-design]')) {
    walletDesignEdit(e.target.dataset.design, e.target.value);
  }
});

document.addEventListener('change', async (e) => {
  // "Own colour" off means inherit; on means keep what the swatch is showing.
  if (e.target.matches('#wal-design-editor [data-design-own]')) {
    const field = e.target.dataset.designOwn;
    const swatch = document.querySelector(`#wal-design-editor [data-design="${field}"]`);
    walletDesignEdit(field, e.target.checked && swatch ? swatch.value : '');
    return;
  }

  // ---- The artwork ----
  if (e.target.id === 'wal-art-file') {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;

    let blobs;
    try {
      blobs = await cropWalletArt(file);
    } catch {
      return; // cancelled, or not an image
    }

    try {
      walletDesignEdit('strip_url', await uploadWalletArt(blobs));
      renderWalletDesignEditor();
    } catch (err) {
      alert(String(err && err.message ? err.message : err));
    }
    return;
  }

  // ---- The venue's own band and mark, on the Programme tab ----
  const field = e.target.closest && e.target.closest('.wal-art[data-artfield]');
  if (field && e.target.type === 'file') {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;

    let blobs;
    try {
      blobs = await cropWalletArt(file, field.dataset.artshape);
    } catch {
      return; // cancelled, or not an image
    }
    try {
      walletSetArt(field.dataset.artfield, await uploadWalletArt(blobs));
    } catch (err) {
      alert(String(err && err.message ? err.message : err));
    }
  }
});

/** Send both scales, and hand back the address they are served at. */
async function uploadWalletArt(blobs) {
  const body = new FormData();
  body.append('x1', blobs.x1, 'art.png');
  body.append('x2', blobs.x2, 'art@2x.png');
  const res = await fetch('/api/wallet/artwork', {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Upload failed');
  return data.url;
}

/**
 * Hold one of the venue's two pictures.
 *
 * Kept on walletState rather than in a hidden input, because there is no input
 * to keep it in — the control is a thumbnail and two buttons. The Save branding
 * button reads walletState for exactly these two fields, so an upload is not
 * live until it is saved, which matches every other field on the tab.
 */
function walletSetArt(fieldName, url) {
  if (!walletState) return;
  walletState[fieldName] = url || '';
  renderWalletArt();
  walletPreview();
}

/** Draw both venue pictures from whatever walletState currently holds. */
function renderWalletArt() {
  for (const box of document.querySelectorAll('.wal-art[data-artfield]')) {
    const url = walletState ? walletState[box.dataset.artfield] || '' : '';
    const preview = box.querySelector('.wal-art-preview');
    preview.innerHTML = url
      ? `<img src="${esc(url)}" alt="">`
      : '<span class="muted small">Vesopa artwork</span>';
    const clear = box.querySelector('[data-artclear]');
    if (clear) clear.hidden = !url;
  }
}

document.addEventListener('click', (e) => {
  const clear = e.target.closest && e.target.closest('.wal-art [data-artclear]');
  if (clear) walletSetArt(clear.closest('.wal-art').dataset.artfield, '');
});

/**
 * Frame one picture, and hand back the two sizes Apple wants.
 *
 * openCropper() is the back office's existing zoom/pan/crop frame, already used
 * for product pictures and already tested. It returns one PNG at the shape it
 * was given, so this asks it once at @2x -- the larger of the two, so nothing
 * is upscaled -- and halves that on a canvas for the @1x. Downscaling a picture
 * the browser has already decoded is the one image operation that needs no
 * library and cannot go wrong.
 */
async function cropWalletArt(file, which = 'strip') {
  const shape = WAL_ART[which] || WAL_ART.strip;
  CROP_SHAPES.wallet_strip = {
    OUT_W: shape.OUT_W * 2, OUT_H: shape.OUT_H * 2,
    VIEW_W: shape.VIEW_W, VIEW_H: shape.VIEW_H,
  };
  const x2 = await openCropper(file, 'wallet_strip');
  if (!x2) throw new Error('cancelled');
  return { x2, x1: await halveBlob(x2, shape.OUT_W, shape.OUT_H) };
}

/** The same picture at half the size, as a PNG blob. */
function halveBlob(blob, width, height) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, width, height);
      URL.revokeObjectURL(url);
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('resize failed'))), 'image/png');
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('bad image')); };
    img.src = url;
  });
}

/**
 * Whether this deployment can actually sign an Apple pass, and what is missing.
 *
 * Every problem is named. The whole failure mode of a `.pkpass` is that a bad
 * one produces no diagnostic anywhere — iOS says "Safari cannot download this
 * file" whatever is wrong — so this screen is the only place the reason is ever
 * visible.
 */
async function loadWalletApple() {
  try {
    walletApple = await api('/wallet/apple/status');
  } catch (e) {
    $('wallet-apple-status').innerHTML =
      '<p class="muted small">Apple Wallet is not available on this server.</p>';
    return;
  }

  const stat = document.querySelectorAll('#wallet-stats .stat-card')[2];
  if (stat) {
    stat.querySelector('.stat-value').textContent =
      walletApple.configured ? 'Ready' : 'Not set up';
    stat.classList.add(walletApple.configured ? 'green' : 'amber');
  }

  // The third cell names the file that will actually sign, not the file this
  // page once expected to find. One shared bundle covering all five is the
  // documented arrangement, and the old wording called that "missing".
  const certs = (walletApple.certificates || [])
    .map(
      (c) => `<tr>
        <td>${esc(c.label)}</td>
        <td class="small muted"><code>${esc(c.pass_type_id)}</code></td>
        <td>${c.present
          ? `<span class="pill on">signing</span>
             <span class="muted small">${esc(c.file)}${c.shared ? ' (shared)' : ''}</span>`
          : `<span class="pill">${esc(c.expected_file || c.file)} missing</span>`}</td>
      </tr>`
    )
    .join('');

  $('wallet-apple-status').innerHTML = `
    ${walletApple.configured
      ? `<p class="muted small">Signing as team <code>${esc(walletApple.team_id)}</code>
           using ${esc(walletApple.openssl)}.</p>`
      : `<div class="callout warn"><b>Apple passes cannot be signed yet.</b><ul>${
          (walletApple.problems || []).map((p) => `<li>${esc(p)}</li>`).join('')
        }</ul>
        <p class="small">The five public certificates are in
        <code>passes_and_oauth/</code>. The private keys are not, and must never
        be — they are supplied to the server as <code>.p12</code> files.</p></div>`}
    <table class="table"><tbody>${certs}</tbody></table>
    <p class="muted small">${walletApple.push_updates
      ? 'Passes update themselves in the customer’s wallet.'
      : 'Passes are correct when issued and refresh when the code is scanned again. Automatic updates need a web service URL.'}</p>`;
}

/**
 * Every card handed out, and when.
 *
 * WHY THE DATES AND THE VENUE ARE ON IT
 *
 * This list is per venue, and it said "No passes issued yet" for a venue that
 * had issued none — while another venue on the same server had. Both are the
 * same sentence on screen, so the honest reading of an empty list was
 * ambiguous: nobody has been given a card, or you are looking at the wrong
 * venue. Naming the venue costs one line and settles it.
 *
 * The dates are here for the same reason. "It is issuing passes but I cannot
 * see them" is answered by a row with a time on it, and by an error column that
 * says when Google refused one — a pass can exist, be recorded, and still never
 * have reached anybody, and nothing else in the system would say so.
 */
async function loadWalletPasses() {
  let rows = [];
  const box = $('wallet-passes');
  const where = walletState && walletState.office
    ? `<p class="muted small">This is ${esc(walletState.office)}. Cards issued by another venue on this server are not listed here.</p>`
    : '';

  try {
    rows = await api('/wallet/passes');
    const stat = document.querySelectorAll('#wallet-stats .stat-card')[3];
    if (stat) stat.querySelector('.stat-value').textContent = String(rows.length);
  } catch (e) {
    box.innerHTML =
      '<p class="muted small">No pass record is available on this server yet.</p>';
    return;
  }

  if (!rows.length) {
    box.innerHTML =
      '<p class="muted small">No passes issued yet. One is created the first time '
      + 'a customer scans a sign-up code, when somebody joins through your sign-up '
      + 'link, or when you press the wallet button on a customer, a member of '
      + 'staff, a gift card or an offer.</p>' + where;
    return;
  }

  const when = (v) => (v ? new Date(v).toLocaleString('en-GB') : '—');

  box.innerHTML =
    '<table class="table"><thead><tr><th>Card</th><th>Kind</th>' +
    '<th>Number</th><th>Issued</th><th>State</th><th></th></tr></thead><tbody>' +
    rows.map((r) => `<tr>
        <td>${esc(r.subject_name || r.subject_id)}</td>
        <td>${esc(walletKindLabel(r.kind))}</td>
        <td class="small muted"><code>${esc(r.card_number || '—')}</code></td>
        <td class="small muted">${esc(when(r.apple_issued_at || r.created_at))}</td>
        <td>${r.apple_issued_at
          ? '<span class="pill on">Apple</span> '
          : ''}${r.state === 'active'
            ? '<span class="pill on">Google</span>'
            : `<span class="pill">${esc(r.state || 'pending')}</span>`}
          ${r.last_error
            // The failure a venue would otherwise never see. A row can exist,
            // look issued, and have been refused by Google on the way out.
            ? `<br><span class="pill" title="${esc(r.last_error)}">refused</span>`
            : ''}</td>
        <td class="right">
          <button class="btn small" data-wallet-qr="${esc(r.kind)}|${esc(r.subject_id)}|${esc(r.subject_name || '')}">Show code</button>
        </td>
      </tr>`).join('') +
    '</tbody></table>' + where;
}

const walletKindLabel = (kind) => ({
  loyalty: 'Loyalty', customer: 'Membership', giftcard: 'Gift card',
  staff: 'Staff', promo: 'Offer',
}[kind] || kind);

/**
 * The poster code: one link that enrols a customer and hands them a card.
 *
 * The SVG is fetched rather than dropped into an <img src>, which is what this
 * did and why no code ever appeared. /api/qr.svg is behind the session, the
 * session is a bearer token in a header, and an <img> cannot send a header —
 * so every one of those requests came back 401 and rendered as a broken image
 * with no error anywhere but the network tab.
 *
 * The link carries the venue's own sign-up code. It falls back to the office
 * email only for a venue whose settings have not been saved since codes
 * existed, which is the same address the old posters already carry.
 */
async function walletJoinCode() {
  const box = $('wallet-join-qr');
  if (!box || !walletState) return;

  const handle = walletState.join_slug || walletState.office;
  if (!handle) return;
  const url = `${location.origin}/wallet/join/${encodeURIComponent(handle)}`;

  box.innerHTML = `<p class="small muted">${esc(url)}</p>`;
  try {
    const res = await fetch(`/api/qr.svg?size=220&text=${encodeURIComponent(url)}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error(await res.text());
    box.innerHTML =
      `<div class="wal-qr-img">${await res.text()}</div>
       <p class="small muted">${esc(url)}</p>
       <p class="small"><a href="${esc(url)}" target="_blank" rel="noopener">Open the sign-up page</a></p>`;
  } catch (e) {
    // Said out loud rather than left blank: a missing code on this screen is
    // the venue's poster not existing.
    box.innerHTML =
      `<p class="small muted">${esc(url)}</p>
       <p class="small err">The code could not be drawn: ${esc(e.message || 'unknown error')}</p>`;
  }
}

document.addEventListener('input', (e) => {
  // Live, because the preview is the whole reason the colours are on this page
  // rather than in a config file.
  if (e.target.matches('[data-wal]') && walletState) walletPreview();
});

document.addEventListener('change', (e) => {
  if (e.target.matches('[data-wal]') && walletState) walletPreview();
});

document.addEventListener('click', async (e) => {
  if (e.target.id === 'wallet-save') {
    const body = {};
    for (const el of document.querySelectorAll('[data-wal]')) {
      body[el.dataset.wal] = el.type === 'checkbox' ? el.checked : el.value;
    }
    // The two pictures have no input to be read out of — the control is a
    // thumbnail and two buttons — so they come off walletState, which is where
    // an upload or a Remove put them.
    for (const field of ['photo_url', 'logo_url']) {
      body[field] = (walletState && walletState[field]) || '';
    }
    await api('/wallet/settings', { method: 'PUT', body: JSON.stringify(body) });
    e.target.textContent = 'Saved ✓';
    setTimeout(() => { e.target.textContent = 'Save branding'; }, 1500);
    loadWallet();
  }

  const show = e.target.dataset && e.target.dataset.walletQr;
  if (show) {
    const [kind, subjectId, name] = show.split('|');
    e.target.disabled = true;
    try {
      // Issuing and showing are the same action on purpose: a code that pointed
      // at a pass which had never been built would fail in the customer's hand
      // rather than here.
      const out = await api(
        `/wallet/apple/${encodeURIComponent(kind)}/${encodeURIComponent(subjectId)}`,
        { method: 'POST' }
      );
      walletShowCode(name || subjectId, out.scan_url, out.card_number);
    } catch (err) {
      alert(String(err && err.message ? err.message : err));
    } finally {
      e.target.disabled = false;
    }
  }
});

/** The code, big enough to scan off the screen. */
async function walletShowCode(name, url, cardNumber) {
  const wrap = document.createElement('div');
  wrap.className = 'wal-modal';
  wrap.innerHTML = `
    <div class="wal-modal-card">
      <h3>${esc(name)}</h3>
      <div class="wal-qr-box">Drawing the code…</div>
      <p class="small muted">Point a phone at this. An iPhone gets an Apple
        pass, anything else gets a Google one.</p>
      ${cardNumber ? `<p class="small"><code>${esc(cardNumber)}</code></p>` : ''}
      <button class="btn" data-wal-close>Close</button>
    </div>`;
  wrap.addEventListener('click', (ev) => {
    if (ev.target === wrap || ev.target.hasAttribute('data-wal-close')) wrap.remove();
  });
  document.body.appendChild(wrap);

  // Fetched, not dropped into an <img src>. /api/qr.svg is behind the session,
  // the session is a bearer token in a header, and an <img> cannot send a
  // header — so every one of those requests came back 401 and rendered as a
  // broken image with no error anywhere but the network tab. walletJoinCode()
  // already learned this; this call site had not.
  wrap.querySelector('.wal-qr-box').innerHTML =
    (await qrSvg(url, 260)) || '<p class="small muted">The code could not be drawn.</p>';
}

// ---------------------------------------------------------------------------
// Cards and passes, from wherever the person is
// ---------------------------------------------------------------------------
//
// The two things a venue does with a named person, a gift card or an offer are
// hand them a card and put that card on their phone. Both used to live on one
// screen each — Swipe cards for the plastic, Wallet passes for the phone — so
// doing either for the customer in front of you meant leaving the page you
// found them on, finding them again somewhere else, and coming back.
//
// So the two actions travel to the rows instead. Every list that holds a pass
// subject carries the same pair of icons, they do the same thing everywhere,
// and they are the same two actions the till offers at the counter — which is
// what makes them learnable in one place and usable in six.

/** Which pass kind each list issues, and what to call it. */
const ROW_PASS = {
  loyalty: { label: 'loyalty card' },
  customer: { label: 'membership card' },
  giftcard: { label: 'gift card' },
  staff: { label: 'staff card' },
  promo: { label: 'offer' },
};

/**
 * A QR code as inline SVG.
 *
 * Returns '' rather than throwing: a code that cannot be drawn should leave the
 * rest of the panel — the number, the link, the print button — perfectly
 * usable, because the number under the code is the fallback the whole system
 * already depends on.
 */
async function qrSvg(text, size = 240) {
  try {
    const res = await fetch(
      `/api/qr.svg?size=${encodeURIComponent(size)}&text=${encodeURIComponent(text)}`,
      { headers: token ? { Authorization: `Bearer ${token}` } : {} }
    );
    return res.ok ? await res.text() : '';
  } catch {
    return '';
  }
}

/**
 * The pair of icon buttons for one row.
 *
 * `kind` and `id` name the pass subject. `disabled` carries the reason a row
 * cannot do this — a back-office user with no staff record, say — and it is put
 * in the tooltip rather than hidden, because a button that is missing on some
 * rows and present on others reads as a rendering fault.
 */
function rowCardActions({ kind, id, name = '', print = true, disabled = '' }) {
  const key = esc(`${kind}|${id}|${name}`);
  const off = disabled ? ' disabled' : '';
  const why = disabled ? ` title="${esc(disabled)}"` : '';

  return `
    <button class="icon-btn" data-row-pass="${key}"${off}${why}
            aria-label="Wallet pass for ${esc(name || id)}"
            title="${disabled ? esc(disabled) : 'Put this card on a phone'}">
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M4 7.5A2.5 2.5 0 0 1 6.5 5h11A2.5 2.5 0 0 1 20 7.5v9a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 16.5z"/>
        <path d="M4 10h16"/><path d="M15.5 14.5h2"/>
      </svg>
    </button>${print ? `
    <button class="icon-btn" data-row-print="${key}"
            aria-label="Print a card for ${esc(name || id)}"
            title="Print the card">
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M7 9V4h10v5"/>
        <path d="M6.5 9h11A2.5 2.5 0 0 1 20 11.5V16h-3v4H7v-4H4v-4.5A2.5 2.5 0 0 1 6.5 9z"/>
        <path d="M17 12.5h.01"/>
      </svg>
    </button>` : ''}`;
}

/**
 * Put a card on somebody's phone.
 *
 * Issuing and showing are one action, deliberately. A code that pointed at a
 * pass which had never been built would fail in the customer's hand rather than
 * here, and the customer is the worst possible place to find that out.
 */
async function openRowPass(kind, id, name) {
  const out = await api(
    `/wallet/apple/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`,
    { method: 'POST' }
  );
  await walletShowCode(name || (ROW_PASS[kind] || {}).label || 'Card',
    out.scan_url, out.card_number);
}

/**
 * The printed card.
 *
 * A sheet, not a receipt. The till prints the track to encode on a stripe
 * because that is what a card writer needs; this is the other half — something
 * to hand over, or to hold against a blank while it is written — so it shows
 * the card at card size with the code on it, and the track underneath where the
 * scissors go rather than in the middle of the artwork.
 *
 * Printed through a hidden iframe rather than a new window: a pop-up blocker
 * silently eating the print is indistinguishable from a printer that is off.
 */
async function openRowPrint(kind, id, name) {
  const data = await api(
    `/wallet/card/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`
  );

  const svg = await qrSvg(data.scan_url || data.card_number || String(id), 320);

  showPanel(`Print — ${name || data.name || 'card'}`, `
    <div class="print-card-wrap">
      <div class="print-card" id="print-card">
        <div class="pc-head">
          <span class="pc-venue">${esc(data.issuer_name || '')}</span>
          <span class="pc-prog">${esc(data.program_name || '')}</span>
        </div>
        <div class="pc-body">
          <div class="pc-qr">${svg || ''}</div>
          <div class="pc-who">
            <span class="pc-name">${esc(data.name || name || '')}</span>
            ${data.member_no ? `<span class="pc-line">Member no. ${esc(data.member_no)}</span>` : ''}
            ${data.card_number && data.has_plastic
              ? `<span class="pc-num">${esc(data.card_number)}</span>` : ''}
          </div>
        </div>
      </div>
      ${data.track ? `
        <p class="small muted">Encode on track 2: <code>${esc(data.track)}</code><br>
        The <code>;</code> and <code>?</code> belong to the reader and must be on
        the stripe, but they are never stored and never appear in the code above.</p>`
        : `<p class="small muted">This one has no card number yet, so there is
           nothing to encode on a stripe — the code above identifies them on its
           own. Issue a card at the till, or from the Cards screen, to give them
           a number a reader can send.</p>`}
      <div class="print-card-actions">
        <button class="btn primary" id="print-card-go">Print</button>
      </div>
    </div>`);

  $('print-card-go').addEventListener('click', () => printNode($('print-card')));
}

/** Print one element on its own page, without leaving this one. */
function printNode(node) {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
  document.body.appendChild(frame);

  const doc = frame.contentDocument;
  doc.open();
  doc.write(`<!doctype html><html><head><meta charset="utf-8">
    <title>Card</title>
    <link rel="stylesheet" href="/style.css">
    <style>
      @page { margin: 12mm; }
      body { background:#fff; margin:0; display:flex; justify-content:center; }
    </style></head><body></body></html>`);
  doc.close();

  const go = () => {
    doc.body.appendChild(doc.importNode(node, true));
    // The stylesheet is fetched by the frame and the card is laid out against
    // it; printing before it lands produces an unstyled rectangle. One frame's
    // grace after load is enough and costs nothing anybody notices.
    setTimeout(() => {
      frame.contentWindow.focus();
      frame.contentWindow.print();
      setTimeout(() => frame.remove(), 1000);
    }, 250);
  };

  if (doc.readyState === 'complete') go();
  else frame.addEventListener('load', go, { once: true });
}

/**
 * The same pair of icons for a row that prints but has no card on a phone.
 *
 * The wallet icon is drawn and disabled rather than left out. A control that is
 * present on four lists and absent on two reads as a rendering fault and gets
 * reported as one; a disabled control with the reason in its tooltip answers
 * the question instead of raising it.
 */
function printOnlyAction({ what, id, name = '', why = '' }) {
  const key = esc(`${what}|${id}|${name}`);
  return `
    <button class="icon-btn" disabled title="${esc(why)}"
            aria-label="${esc(why)}">
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M4 7.5A2.5 2.5 0 0 1 6.5 5h11A2.5 2.5 0 0 1 20 7.5v9a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 16.5z"/>
        <path d="M4 10h16"/><path d="M15.5 14.5h2"/>
      </svg>
    </button>
    <button class="icon-btn" data-row-slip="${key}"
            aria-label="Print this ${esc(what)}" title="Print it">
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M7 9V4h10v5"/>
        <path d="M6.5 9h11A2.5 2.5 0 0 1 20 11.5V16h-3v4H7v-4H4v-4.5A2.5 2.5 0 0 1 6.5 9z"/>
        <path d="M17 12.5h.01"/>
      </svg>
    </button>`;
}

/**
 * A voucher or a deposit, on paper.
 *
 * Both are a code somebody carries back to the counter, so both print the same
 * shape: the code as something scannable, the code as something readable under
 * it, and the two or three facts that decide whether it is still good. The
 * readable line is not decoration — it is what gets used when the print is
 * creased, and it is why the code is never only a barcode.
 */
async function openRowSlip(what, id, name) {
  const rows = await api(what === 'voucher' ? '/vouchers' : '/deposits');
  const row = rows.find((r) => String(r.id) === String(id));
  if (!row) throw new Error('That row is no longer there.');

  const code = String(row.code || row.reference || '');
  const svg = await qrSvg(code, 280);

  const lines = what === 'voucher'
    ? [
        ['Voucher', row.name || ''],
        ['Worth', row.discount_type === 'percent'
          ? `${row.value}% off`
          : `£${pounds(row.value)} off`],
        ['Minimum spend', row.min_spend_minor ? `£${pounds(row.min_spend_minor)}` : 'None'],
        ['Valid from', row.starts_on ? date(row.starts_on) : 'Now'],
        ['Expires', row.expires_on ? date(row.expires_on) : 'No end date'],
      ]
    : [
        ['Customer', row.customer_name || ''],
        ['For', row.description || ''],
        ['Deposit paid', `£${pounds(row.amount_minor)}`],
        ['Already redeemed', `£${pounds(row.redeemed_minor || 0)}`],
        ['Still held', `£${pounds((row.amount_minor || 0) - (row.redeemed_minor || 0))}`],
        ['Due', row.due_on ? date(row.due_on) : '—'],
      ];

  showPanel(`Print — ${name || code}`, `
    <div class="print-card-wrap">
      <div class="print-slip" id="print-card">
        <h4>${what === 'voucher' ? 'Voucher' : 'Deposit receipt'}</h4>
        <div class="ps-qr">${svg || ''}</div>
        <div class="ps-code">${esc(code)}</div>
        <dl class="ps-lines">
          ${lines.filter(([, v]) => String(v).trim())
            .map(([l, v]) => `<dt>${esc(l)}</dt><dd>${esc(String(v))}</dd>`)
            .join('')}
        </dl>
      </div>
      <div class="print-card-actions">
        <button class="btn primary" id="print-card-go">Print</button>
      </div>
    </div>`);

  $('print-card-go').addEventListener('click', () => printNode($('print-card')));
}

document.addEventListener('click', async (e) => {
  const slipBtn = e.target.closest && e.target.closest('[data-row-slip]');
  if (slipBtn && !slipBtn.disabled) {
    const [what, id, ...rest] = slipBtn.dataset.rowSlip.split('|');
    slipBtn.disabled = true;
    try {
      await openRowSlip(what, id, rest.join('|'));
    } catch (err) {
      alert(String(err && err.message ? err.message : err));
    } finally {
      slipBtn.disabled = false;
    }
    return;
  }

  const passBtn = e.target.closest && e.target.closest('[data-row-pass]');
  if (passBtn && !passBtn.disabled) {
    const [kind, id, ...rest] = passBtn.dataset.rowPass.split('|');
    passBtn.disabled = true;
    try {
      await openRowPass(kind, id, rest.join('|'));
    } catch (err) {
      alert(String(err && err.message ? err.message : err));
    } finally {
      passBtn.disabled = false;
    }
    return;
  }

  const printBtn = e.target.closest && e.target.closest('[data-row-print]');
  if (printBtn && !printBtn.disabled) {
    const [kind, id, ...rest] = printBtn.dataset.rowPrint.split('|');
    printBtn.disabled = true;
    try {
      await openRowPrint(kind, id, rest.join('|'));
    } catch (err) {
      alert(String(err && err.message ? err.message : err));
    } finally {
      printBtn.disabled = false;
    }
  }
});

// ---- Swipe cards ----------------------------------------------------------
//
// A card reader on a till counter is a keyboard: swipe a card and it types
// `;999800001?`. The prefix on the front is what tells the till which programme
// the card belongs to before anything is looked up, which is why this page is
// four numbers and not much else.
//
// The prefixes live here, for the venue, rather than on each till. Cards are
// programmed once and then carried around in customers' wallets, so two tills
// that disagreed about what 9998 means would be two tills where the same card
// does different things depending on which end of the bar somebody is standing
// at — and the one that is wrong fails silently, by finding no member and
// offering to enrol a customer who has been with the venue for years.

let cardsState = null;

const CARD_KINDS = [
  { key: 'clerk_prefix', label: 'Staff' },
  { key: 'loyalty_prefix', label: 'Loyalty' },
  { key: 'gift_prefix', label: 'Gift' },
  { key: 'membership_prefix', label: 'Membership' },
];

const cardKindLabel = (kind) => ({
  clerk: 'Staff', loyalty: 'Loyalty', gift: 'Gift', membership: 'Membership',
}[kind] || kind);

async function loadCards() {
  cardsState = await api('/cards/settings');

  for (const el of document.querySelectorAll('[data-card]')) {
    const value = cardsState[el.dataset.card];
    if (el.type === 'checkbox') el.checked = !!Number(value);
    else el.value = value ?? '';
  }

  const running = CARD_KINDS.filter((k) => String(cardsState[k.key] || '').length);
  statCards($('cards-stats'), [
    { label: 'Reading cards', value: cardsState.enabled ? 'On' : 'Off',
      tone: cardsState.enabled ? 'green' : 'red' },
    { label: 'Programmes', value: String(running.length), tone: 'primary',
      hint: running.map((k) => k.label).join(', ') || 'None set' },
    { label: 'Digits after prefix', value: String(cardsState.number_digits || 5) },
    { label: 'Enrol at the till', value: cardsState.auto_enrol ? 'Yes' : 'No',
      tone: cardsState.auto_enrol ? 'green' : '' },
  ]);

  cardsPreview();
  await loadCardIssues();
}

/**
 * What a card of each kind will actually look like.
 *
 * Worth showing rather than describing. The one thing a venue has to get right
 * on this page is that these numbers match the cards already in their
 * customers' wallets, and a worked example is how somebody checks that in two
 * seconds instead of reasoning about it.
 */
function cardsPreview() {
  const digits = document.querySelector('[data-card="number_digits"]');
  const width = Math.min(Math.max(Number(digits && digits.value) || 5, 4), 12);

  const rows = CARD_KINDS.map((kind) => {
    const field = document.querySelector('[data-card="' + kind.key + '"]');
    const prefix = String((field && field.value) || '').replace(/\D/g, '');

    if (!prefix) {
      return '<div class="card-eg off">'
        + '<span class="card-eg-label">' + esc(kind.label) + '</span> '
        + '<span class="muted small">not used — nothing will match</span>'
        + '</div>';
    }

    const number = prefix + '1'.padStart(width, '0');
    return '<div class="card-eg">'
      + '<span class="card-eg-label">' + esc(kind.label) + '</span> '
      + '<code class="card-eg-track">;' + esc(number) + '?</code> '
      + '<span class="muted small">card ' + esc(number) + ' — member 1</span>'
      + '</div>';
  });

  $('cards-preview').innerHTML = rows.join('')
    + '<p class="muted small">The <code>;</code> and <code>?</code> belong to '
    + 'the reader, not to the card. They are typed by the reader and must be '
    + 'encoded on the stripe, but they are never stored and never appear in a '
    + 'barcode or a wallet pass.</p>';
}

async function loadCardIssues() {
  let rows = [];
  try {
    rows = await api('/cards/issues?limit=200');
  } catch (e) {
    // A server that has not had schema_swipe_cards.sql applied yet. The
    // prefixes above still save; only the record is missing, and saying so is
    // better than an empty list that reads as "no cards have been issued".
    $('cards-issues').innerHTML =
      '<p class="muted small">The card record is not available on this server yet.</p>';
    return;
  }

  if (!rows.length) {
    $('cards-issues').innerHTML = '<p class="muted small">No cards issued yet.</p>';
    return;
  }

  $('cards-issues').innerHTML = '<table class="table"><thead><tr>'
    + '<th>Card</th><th>Kind</th><th>Who</th><th>Issued</th><th>By</th><th></th>'
    + '</tr></thead><tbody>'
    + rows.map((r) => '<tr class="' + (r.voided_at ? 'muted' : '') + '">'
      + '<td><code>' + esc(r.card_number) + '</code></td>'
      + '<td>' + esc(cardKindLabel(r.kind)) + '</td>'
      + '<td>' + esc(r.subject_name || '—') + '</td>'
      + '<td class="small muted">' + new Date(r.at).toLocaleString('en-GB') + '</td>'
      + '<td class="small muted">' + esc(r.issued_by || '—') + '</td>'
      + '<td class="right">' + (r.voided_at
        ? '<span class="pill">cancelled</span>'
        : '<button class="btn small danger-ghost" data-card-void="' + r.id + '">Cancel</button>')
      + '</td></tr>').join('')
    + '</tbody></table>';
}

document.addEventListener('input', (e) => {
  // Live, because the preview is the check: somebody typing a prefix here is
  // comparing it against a card in their hand.
  if (e.target.matches('[data-card]') && cardsState) cardsPreview();
});

document.addEventListener('click', async (e) => {
  if (e.target.id === 'cards-save') {
    const body = {};
    for (const el of document.querySelectorAll('[data-card]')) {
      body[el.dataset.card] = el.type === 'checkbox' ? el.checked : el.value;
    }
    await api('/cards/settings', { method: 'PUT', body: JSON.stringify(body) });
    e.target.textContent = 'Saved ✓';
    setTimeout(() => { e.target.textContent = 'Save cards'; }, 1500);
    loadCards();
  }

  const voidId = e.target.dataset && e.target.dataset.cardVoid;
  if (voidId) {
    // Spelled out, because this is the one destructive thing on the page and
    // what it does to the person holding the card is not obvious from "cancel".
    if (!confirm(
      'Cancel this card?\n\n'
      + 'It stops working at the till immediately and is detached from whoever '
      + 'held it. The number is never reissued — the card itself is still out '
      + 'there.'
    )) return;
    const reason = prompt('Why? (kept on the record)', 'Lost') || 'Cancelled';
    await api('/cards/issues/' + voidId + '/void', {
      method: 'POST', body: JSON.stringify({ reason }),
    });
    loadCards();
  }
});

// ---- Devices --------------------------------------------------------------
//
// Which machines a venue has. A till registers itself and every customer
// display paired to it — the display ships with no network capability at all,
// deliberately, so the till speaks for it.

const deviceKindLabel = (kind) => ({
  till: 'Till', display: 'Customer display', kitchen: 'Kitchen screen',
}[kind] || kind);

async function loadDevices() {
  let rows = [];
  try {
    rows = await api('/devices');
  } catch (e) {
    $('devices-list').innerHTML =
      '<p class="muted small">Device registration is not available on this server yet.</p>';
    return;
  }

  const online = rows.filter((d) => d.online && !d.stale);
  statCards($('devices-stats'), [
    { label: 'Machines', value: String(rows.length), tone: 'primary' },
    { label: 'On now', value: String(online.length), tone: online.length ? 'green' : '' },
    { label: 'Tills', value: String(rows.filter((d) => d.kind === 'till').length) },
    { label: 'Customer displays',
      value: String(rows.filter((d) => d.kind === 'display').length) },
  ]);

  $('devices-list').innerHTML = rows.length
    ? '<table class="table"><thead><tr>'
      + '<th>Machine</th><th>Kind</th><th>Version</th><th>Signed in as</th>'
      + '<th>Last seen</th><th></th></tr></thead><tbody>'
      + rows.map((d) => '<tr>'
        + '<td><b>' + esc(d.name || d.device_id) + '</b></td>'
        + '<td>' + esc(deviceKindLabel(d.kind)) + '</td>'
        + '<td class="small muted">' + esc(d.app_version || '—') + '</td>'
        + '<td class="small muted">' + esc(d.signed_in_as || '—') + '</td>'
        + '<td>' + (d.online && !d.stale
          ? '<span class="pill on">on now</span>'
          : '<span class="small muted">'
            + new Date(d.last_seen_at).toLocaleString('en-GB') + '</span>')
        + '</td>'
        + '<td class="right"><button class="btn small danger-ghost" '
        + 'data-device-forget="' + esc(d.device_id) + '">Forget</button></td>'
        + '</tr>').join('')
      + '</tbody></table>'
    : '<p class="muted small">No machines have registered yet. A till registers '
      + 'itself when it starts, so this fills in the next time one is switched '
      + 'on.</p>';

  await loadDeviceLog();
}

async function loadDeviceLog() {
  let rows = [];
  try {
    rows = await api('/devices/log?limit=100');
  } catch (e) {
    return;
  }
  $('devices-log').innerHTML = rows.length
    ? '<table class="table"><thead><tr><th>When</th><th>Machine</th>'
      + '<th>What</th><th>Who</th></tr></thead><tbody>'
      + rows.map((r) => '<tr>'
        + '<td class="small muted">' + new Date(r.at).toLocaleString('en-GB') + '</td>'
        + '<td>' + esc(r.device_name || r.device_id) + '</td>'
        + '<td>' + esc(r.event) + '</td>'
        + '<td class="small muted">' + esc(r.actor || '—') + '</td>'
        + '</tr>').join('')
      + '</tbody></table>'
    : '<p class="muted small">Nothing recorded yet.</p>';
}

document.addEventListener('click', async (e) => {
  if (e.target.id === 'devices-refresh') return loadDevices();

  const forget = e.target.dataset && e.target.dataset.deviceForget;
  if (forget) {
    if (!confirm(
      'Forget this machine?\n\n'
      + 'It disappears from this list. If it is still running it will register '
      + 'again the next time it starts — this is for a screen that has been '
      + 'taken off the wall, not a way to stop one reporting.\n\n'
      + 'What it did stays in the log below.'
    )) return;
    await api('/devices/' + encodeURIComponent(forget), { method: 'DELETE' });
    loadDevices();
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
    active: ticked(data.active),
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
            is_default: ticked(data.is_default), payload: {},
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
          is_demo: ticked(data.is_demo),
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
          replace: ticked(data.replace),
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

  // This table lives inside a div rather than straight in a card, so it never
  // got the card's own horizontal scroll either — on a phone it simply ran out
  // of the side of the panel. Re-rendered on every add, edit and delete, so it
  // cannot rely on the pass render() makes when the view first opens.
  cardsOnPhone(box.querySelector('table'));
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

  cardsOnPhone(box.querySelector('table'));
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

// ---- Catalogue import -----------------------------------------------------

/**
 * Bringing departments, sub departments and products in from a spreadsheet.
 *
 * The shape of the screen is the shape of the promise: download the template,
 * upload the file, **check**, and only then import. Check is not optional
 * decoration — the Import button stays disabled until one has run against the
 * file currently chosen, because an import is the one action in the back office
 * that can rewrite a whole catalogue and it should never be one click away from
 * a file nobody has read.
 *
 * Choosing a different file disarms Import again, so a check run against one
 * spreadsheet can never authorise a different one.
 *
 * See vesopa_server/src/imports.js for what the server does with it.
 */
function loadImport() {
  const file = $('import-file');
  const check = $('import-check');
  const apply = $('import-apply');
  const result = $('import-result');

  // Bound once. `loadImport` runs on every visit to the view, and a second set
  // of listeners would run every action twice — which on the Import button
  // means importing the file twice.
  if (!file.dataset.bound) {
    file.dataset.bound = '1';

    $('import-template').addEventListener('click', importTemplate);

    file.addEventListener('change', () => {
      check.disabled = !file.files.length;
      // A new file has not been checked, whatever the last one's result was.
      apply.disabled = true;
      result.hidden = true;
    });

    check.addEventListener('click', () => importRun(false));
    apply.addEventListener('click', () => importRun(true));
  }

  check.disabled = !file.files.length;
  apply.disabled = true;
  result.hidden = true;
}

/**
 * Download the template.
 *
 * Fetched rather than linked, because the route is behind the session token and
 * a plain `<a href>` carries no Authorization header — it would land on the
 * sign-in page and download an HTML error as "template.xlsx".
 */
async function importTemplate() {
  const button = $('import-template');
  button.disabled = true;
  try {
    const res = await fetch('/api/import/template', {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (res.status === 401) return signOut();
    if (!res.ok) throw new Error('The template could not be built.');

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'vesopa-catalogue-template.xlsx';
    document.body.appendChild(link);
    link.click();
    link.remove();
    // Revoked on the next turn of the event loop: revoking synchronously can
    // beat the click in some browsers and download nothing at all.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  } catch (e) {
    alert(e.message || 'The template could not be downloaded.');
  } finally {
    button.disabled = false;
  }
}

/** Check the chosen file, or import it. Same request, different route. */
async function importRun(commit) {
  const input = $('import-file');
  if (!input.files.length) return;

  const check = $('import-check');
  const apply = $('import-apply');
  check.disabled = true;
  apply.disabled = true;

  const form = new FormData();
  form.append('file', input.files[0]);

  try {
    const res = await fetch(
      commit ? '/api/import/catalogue' : '/api/import/catalogue/preview',
      {
        method: 'POST',
        // No Content-Type: the browser sets it, with the multipart boundary
        // that the server cannot parse the body without.
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: form,
      }
    );
    if (res.status === 401) return signOut();

    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || 'That file could not be read.');

    importRender(body, commit);

    if (body.applied) {
      // No alert on success: the panel below now says exactly what changed,
      // which is more than "Catalogue imported" could, and one fewer dialog on
      // a page where a chain of them is how Chrome starts suppressing them.
      // Checked once and spent. Pressing Import again would apply the same
      // file a second time, which for products without a PLU means a second
      // copy of every one of them.
      input.value = '';
      apply.disabled = true;
      check.disabled = true;
    } else {
      apply.disabled = body.blocked;
    }
  } catch (e) {
    alert(e.message);
    apply.disabled = true;
  } finally {
    check.disabled = !input.files.length;
  }
}

/** The preview, or what the import did. */
function importRender(body, commit) {
  const result = $('import-result');
  result.hidden = false;

  $('import-result-title').textContent = body.applied
    ? 'What this file changed'
    : body.blocked
      ? 'This file cannot be imported yet'
      : 'What this file would do';

  const past = body.applied;
  const line = (what, counts) => {
    if (!counts.created && !counts.updated) return '';
    const parts = [];
    if (counts.created) {
      parts.push(`${counts.created} new`);
    }
    if (counts.updated) {
      parts.push(`${counts.updated} ${past ? 'updated' : 'to update'}`);
    }
    return `<li><strong>${esc(what)}</strong> — ${esc(parts.join(', '))}</li>`;
  };

  const rows =
    line('Departments', body.summary.departments) +
    line('Sub departments', body.summary.groups) +
    line('Products', body.summary.products);

  $('import-summary').innerHTML = rows
    ? `<ul class="import-summary">${rows}</ul>`
    : '<p class="muted small">There is nothing in this file to import.</p>';

  // Problems last and in full. A heading we did not recognise is a warning
  // rather than an error — the row still imports — but it is said out loud,
  // because a venue that adds a "Supplier" column should find out now and not
  // in six months.
  const problems = [];
  for (const sheet of body.sheets) {
    if (!sheet.present) continue;
    if (sheet.unknownColumns.length) {
      problems.push(
        `<p class="muted small"><strong>${esc(sheet.sheet)}</strong>: ` +
          `${esc(sheet.unknownColumns.join(', '))} ` +
          `${sheet.unknownColumns.length === 1 ? 'is a column' : 'are columns'} ` +
          'we do not import. Everything else on the sheet was read.</p>'
      );
    }
    if (sheet.errors.length) {
      problems.push(
        `<p class="error"><strong>${esc(sheet.sheet)}</strong></p><ul class="import-errors">` +
          sheet.errors
            .map((e) => `<li>Row ${e.row}: ${esc(e.message)}</li>`)
            .join('') +
          '</ul>'
      );
    }
  }
  if (body.blocked) {
    problems.push(
      '<p class="muted small">Nothing has been written. Fix the rows above and ' +
        'upload the file again — an import is all or nothing, so half a ' +
        'catalogue can never be left behind.</p>'
    );
  } else if (!commit && !body.applied) {
    problems.push(
      '<p class="muted small">Nothing has been written yet. Press Import to apply it.</p>'
    );
  }
  $('import-problems').innerHTML = problems.join('');
}
// ---- Running a report -----------------------------------------------------

/**
 * The report a venue hands to its accountant.
 *
 * Pick a window, run it, read it, look at the PDF, save it. Everything on
 * screen — the dark header band, the four meta cells, the six figure tiles, the
 * sections in order — is the furniture the PDF prints, in the same order and
 * the same colours, because they are one document in two media. See
 * vesopa_server/src/reports.js, which builds both from the same object.
 */
let rrCatalogue = null;

/**
 * The icons the row actions are drawn with.
 *
 * Inline rather than a font or a sprite: there are six of them, they never
 * change, and a webfont that has not loaded yet turns a row of actions into a
 * row of empty boxes. Every one is a 24-unit stroked path, so they all sit at
 * the same weight beside each other.
 */
const ICON = {
  eye:
    '<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/>' +
    '<circle cx="12" cy="12" r="3"/>',
  download:
    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>' +
    '<polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  send: '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>',
  history:
    '<path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/>' +
    '<path d="M12 7v5l4 2"/>',
  edit:
    '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>' +
    '<path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z"/>',
  trash:
    '<polyline points="3 6 5 6 21 6"/>' +
    '<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
};

/** An icon button: a picture, a tooltip, and a name a screen reader can read. */
const iconButton = (icon, label, data, extra = '') =>
  `<button type="button" class="icon-btn ${extra}" ${data} title="${esc(label)}"
           aria-label="${esc(label)}">
     <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
          stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icon}</svg>
   </button>`;

async function loadRunReport() {
  if (!rrCatalogue) {
    rrCatalogue = await api('/reports/catalogue');
    $('rr-report').innerHTML = rrCatalogue.reports
      .map((r) => `<option value="${esc(r.key)}">${esc(r.label)}</option>`)
      .join('');
    $('rr-period').innerHTML = rrCatalogue.ranges
      .map((r) => `<option value="${esc(r.key)}">${esc(r.label)}</option>`)
      .join('');
    $('rr-format').innerHTML = rrCatalogue.formats
      .map((f) => `<option value="${esc(f.key)}">${esc(f.label)}</option>`)
      .join('');
    rrFillTerminals();

    // Yesterday rather than Today, because the question a manager opens this
    // page to answer is almost always about a day that has finished.
    $('rr-period').value = 'yesterday';

    $('rr-period').addEventListener('change', rrToggleCustom);
    $('rr-run').addEventListener('click', rrRun);
    $('rr-export').addEventListener('click', rrExport);
    $('rr-view').addEventListener('click', rrView);
    rrToggleCustom();
  }

  // Nothing is run on arrival. A report is a query over the whole ledger, and
  // firing one because somebody clicked a menu item is how a back office comes
  // to feel slow at the venue with three years of trading in it.
  $('rr-result').innerHTML =
    '<p class="muted small">Choose a period and press Run report.</p>';
  rrReady(false);
}

/** View and Download only mean anything once something has been run. */
function rrReady(ready) {
  $('rr-export').disabled = !ready;
  $('rr-view').disabled = !ready;
}

/**
 * The terminal list, with the sale count beside each name.
 *
 * The count is there to answer the question the dropdown provokes -- "is Bar 2
 * the one that's been quiet, or is Bar 2 just not connected?" -- before a
 * manager runs three reports to find out.
 *
 * Rebuilt from the catalogue rather than cached separately: a till that took
 * its first sale this morning has to appear without a page reload.
 */
function rrFillTerminals() {
  const list = (rrCatalogue && rrCatalogue.terminals) || [];
  $('rr-terminal').innerHTML =
    '<option value="">All terminals</option>' +
    list
      .map(
        (t) =>
          `<option value="${esc(t.value)}">${esc(t.label)} (${t.sales})</option>`
      )
      .join('');
}

/** The two date boxes only exist for Custom Range. */
function rrToggleCustom() {
  const custom = $('rr-period').value === 'custom';
  $('rr-from-field').hidden = !custom;
  $('rr-to-field').hidden = !custom;
  if (custom && !$('rr-from').value) {
    // Seeded with a sensible week rather than left blank, so the first press of
    // Run does something instead of complaining.
    const today = new Date();
    const weekAgo = new Date(today);
    weekAgo.setDate(weekAgo.getDate() - 6);
    $('rr-from').value = weekAgo.toISOString().slice(0, 10);
    $('rr-to').value = today.toISOString().slice(0, 10);
  }
}

/** What the run, the preview and the download all send. */
function rrSpec() {
  return {
    report: $('rr-report').value,
    period: $('rr-period').value,
    from: $('rr-from').value || undefined,
    to: $('rr-to').value || undefined,
    // Empty string means every terminal. Sent as undefined rather than '' so
    // the server's own "unfiltered" default is the one thing deciding it.
    terminal: $('rr-terminal').value || undefined,
  };
}

async function rrRun() {
  const button = $('rr-run');
  button.disabled = true;
  $('rr-result').innerHTML = '<p class="muted small">Running…</p>';
  try {
    const report = await api('/reports/run', {
      method: 'POST',
      body: JSON.stringify(rrSpec()),
    });
    rrRender(report);
    rrReady(true);
  } catch (e) {
    $('rr-result').innerHTML = `<p class="error">${esc(e.message)}</p>`;
    rrReady(false);
  } finally {
    button.disabled = false;
  }
}

/** dd/MM/yyyy HH:mm:ss — the same stamp every export prints. */
function rrWhen(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

function rrRender(report) {
  const meta = [
    ['Site', report.site],
    ['Period covered', `${rrWhen(report.from)} — ${rrWhen(report.to)}`],
    ['Terminal', report.terminalLabel || 'All terminals'],
    ['Generated', rrWhen(report.generatedAt)],
  ];

  const head = `
    <div class="rr-head">
      <div class="rr-head-band">
        <div>
          <img src="/assets/vesopa_logo_on_dark.png" alt="Vesopa" class="rr-head-logo">
          <h3>${esc(report.name)}</h3>
          <p class="rr-head-kicker">EPOS reporting</p>
        </div>
        <div class="rr-head-site">
          <strong>${esc(report.site)}</strong>
          <span>${esc(rrWhen(report.from))} — ${esc(rrWhen(report.to))}</span>
        </div>
      </div>
      <dl class="rr-meta">
        ${meta
          .map(
            ([label, value]) =>
              `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`
          )
          .join('')}
      </dl>
    </div>`;

  // The headline figures come from the report itself rather than being added up
  // here, so the tiles, the PDF's tiles and the emailed summary are the same
  // arithmetic done once.
  const tiles = (report.highlights || []).length
    ? `<div class="rr-tiles">${report.highlights
        .map(
          (item, i) => `<div class="rr-tile${i === 0 ? ' hero' : ''}">
            <div class="rr-tile-label">${esc(item.label)}</div>
            <div class="rr-tile-value">${esc(item.value)}</div>
            ${item.hint ? `<div class="rr-tile-hint">${esc(item.hint)}</div>` : ''}
          </div>`
        )
        .join('')}</div>`
    : '';

  const cell = (tag, value, i) =>
    `<${tag}${i === 0 ? '' : ' class="num"'}>${esc(value)}</${tag}>`;

  const sections = report.sections
    .map((part) => {
      const head_ = part.columns.map((c, i) => cell('th', c.label, i)).join('');

      const body = part.rows.length
        ? part.rows
            .map(
              (row) =>
                '<tr>' + row.values.map((v, i) => cell('td', v, i)).join('') + '</tr>'
            )
            .join('')
        : `<tr><td colspan="${part.columns.length}" class="muted small">` +
          'Nothing in this period.</td></tr>';

      const total = part.total
        ? '<tfoot><tr>' +
          part.total.values.map((v, i) => cell('td', v, i)).join('') +
          '</tr></tfoot>'
        : '';

      return `<div class="card rd-card" style="margin-bottom:var(--stack)">
        <div class="rr-section-head">
          <h3>${esc(part.title)}</h3>
          <span class="muted small">${
            part.rows.length === 1 ? '1 row' : `${part.rows.length} rows`
          }</span>
        </div>
        <div class="rr-scroll">
          <!-- data-no-cards: a report section is read column against column,
               and seven money columns stacked into fifteen cards of seven
               label/value pairs is a page nobody can total by eye. It scrolls,
               and the better read on a phone is View PDF. -->
          <table class="table rr-table" data-no-cards>
            <thead><tr>${head_}</tr></thead>
            <tbody>${body}</tbody>
            ${total}
          </table>
        </div>
      </div>`;
    })
    .join('');

  $('rr-result').innerHTML = head + tiles + sections;
}

/**
 * Ask the server to build one of the three files.
 *
 * Posted and read as a blob rather than linked, and that is not a preference:
 * the route is behind the session token, and a plain <a href> carries no
 * Authorization header. It would land on the sign-in page and save an HTML
 * error page as "report.pdf" — which is exactly what a download that silently
 * does nothing looks like from the outside.
 */
async function reportFile(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (res.status === 401) {
    signOut();
    return null;
  }
  if (!res.ok) {
    const problem = await res.json().catch(() => ({}));
    throw new Error(problem.error || 'The report could not be built.');
  }

  // The server has already named the file. Taking its name rather than
  // inventing a second one keeps a downloaded report and an emailed one
  // identical, which matters when somebody is comparing the two.
  const disposition = res.headers.get('content-disposition') || '';
  const match = /filename="([^"]+)"/.exec(disposition);
  return { blob: await res.blob(), filename: match ? match[1] : 'report' };
}

/** Hand a blob to the browser as a save. */
function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename || 'report';
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoked on the next tick rather than immediately: Safari has not finished
  // with the URL when click() returns, and revoking under it saves nothing.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Download the report on screen in the chosen format. */
async function rrExport() {
  const button = $('rr-export');
  const label = button.textContent;
  button.disabled = true;
  button.textContent = 'Preparing…';
  try {
    const file = await reportFile('/api/reports/export', {
      ...rrSpec(),
      format: $('rr-format').value,
    });
    if (file) saveBlob(file.blob, file.filename);
  } catch (e) {
    alert(e.message);
  } finally {
    button.textContent = label;
    button.disabled = false;
  }
}

/**
 * Read the report as a PDF, on screen, without saving anything.
 *
 * Always PDF, whatever the export dropdown says: it is the one of the three a
 * browser can draw, and "View" that hands back a spreadsheet is a download with
 * a misleading name on it.
 */
function rrView() {
  const period = $('rr-period');
  const window_ = period.options[period.selectedIndex];
  viewReport({
    path: '/api/reports/export',
    body: { ...rrSpec(), format: 'pdf', disposition: 'inline' },
    title: $('rr-report').options[$('rr-report').selectedIndex].text,
    subtitle: `${window_ ? window_.text : ''} · ${
      $('rr-terminal').options[$('rr-terminal').selectedIndex].text
    }`,
  });
}

// ---- The report viewer ----------------------------------------------------

/**
 * A report on screen, in the shape it prints.
 *
 * The alternative — and what this replaces — is downloading a file, finding it,
 * opening it in something else, and doing that again for every date you were
 * not sure about. The bytes are the same bytes the download gets, held as a
 * blob and pointed at an iframe, so a preview can never be a different document
 * from the file.
 */
let viewerUrl = null;
let viewerBlob = null;
let viewerFile = null;
let viewerWired = false;

function wireViewer() {
  if (viewerWired) return;
  viewerWired = true;

  $('pdfv').addEventListener('click', (e) => {
    if (e.target.closest('[data-pdfv-close]')) closeViewer();
  });
  $('pdfv-download').addEventListener('click', () => {
    if (viewerUrl) saveBlob(viewerBlob, viewerFile);
  });
  // Some browsers will not print or search inside a framed PDF. Rather than
  // reimplement a PDF reader, hand the same blob to the one the browser already
  // has.
  $('pdfv-tab').addEventListener('click', () => {
    if (viewerUrl) window.open(viewerUrl, '_blank', 'noopener');
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('pdfv').hidden) closeViewer();
  });
}

/** Open the viewer, then fill it when the server has built the report. */
async function viewReport({ path, body, title, subtitle }) {
  wireViewer();

  const frame = $('pdfv-frame');
  const state = $('pdfv-state');

  $('pdfv-title').textContent = title || 'Report';
  $('pdfv-sub').textContent = subtitle || '';
  frame.hidden = true;
  frame.removeAttribute('src');
  state.hidden = false;
  state.className = 'pdfv-state';
  state.textContent = 'Building the report…';
  $('pdfv-download').disabled = true;
  $('pdfv-tab').disabled = true;
  $('pdfv').hidden = false;
  // The page behind must not scroll under the overlay on a phone, where the
  // two scrolls fight each other and the report is the one that loses.
  document.body.style.overflow = 'hidden';

  try {
    const file = await reportFile(path, body);
    if (!file) return; // signed out; signOut() has taken the page

    releaseViewer();
    viewerBlob = file.blob;
    viewerFile = file.filename;
    viewerUrl = URL.createObjectURL(file.blob);

    frame.src = viewerUrl;
    frame.hidden = false;
    state.hidden = true;
    $('pdfv-download').disabled = false;
    $('pdfv-tab').disabled = false;
  } catch (e) {
    state.className = 'pdfv-state error';
    state.textContent = e.message;
  }
}

/** Let go of the blob. A held object URL is a held copy of the whole report. */
function releaseViewer() {
  if (viewerUrl) URL.revokeObjectURL(viewerUrl);
  viewerUrl = null;
}

function closeViewer() {
  const frame = $('pdfv-frame');
  frame.hidden = true;
  frame.removeAttribute('src');
  releaseViewer();
  viewerBlob = null;
  $('pdfv').hidden = true;
  document.body.style.overflow = '';
}

// ---- Scheduled reports ----------------------------------------------------

let rsOptions = null;

async function loadReportSchedules() {
  if (!rsOptions) {
    rsOptions = await api('/reports/schedule-options');
    $('rs-new').addEventListener('click', () => rsEdit(null));
  }

  // Said once, at the top, rather than discovered when the first report fails
  // to arrive: a schedule on a server with no mailbox configured runs happily,
  // builds the report, and then has nowhere to send it.
  const warning = $('rs-mail-warning');
  warning.hidden = !!rsOptions.mailEnabled;
  warning.className = 'error';
  warning.textContent = rsOptions.mailEnabled
    ? ''
    : 'This server has no mailbox configured, so scheduled reports will be ' +
      'built but not sent. Set SMTP_HOST and SMTP_PASSWORD on the server.';

  const rows = await api('/reports/schedules');
  $('rs-rows').innerHTML = rows.length
    ? rows.map(rsRow).join('')
    : '<tr><td colspan="9" class="muted small">No scheduled reports yet.</td></tr>';
  cardsOnPhone($('rs-table'));

  $('rs-rows').onclick = (e) => rsAction(e, rows);
  $('rs-runs').innerHTML = '';
}

/**
 * One schedule, and the six things you can do to it.
 *
 * Icons rather than words, in one fixed order — look, save, send, history,
 * edit, delete — because six labelled buttons in the last cell of a nine column
 * table is a row wider than the screen it is read on. The destructive one is
 * last and is the only one with a colour.
 *
 * View and Download come first deliberately. Until they existed the only way to
 * find out what a schedule produces was Send now, which mails it to everybody
 * on the list: setting up a Monday report meant sending the whole office a
 * test.
 */
function rsRow(r) {
  // The cells are unlabelled here on purpose: cardsOnPhone() takes each one's
  // heading off the <th> it sits under, so the phone layout and the desktop
  // column cannot end up calling the same thing two different names.
  return `<tr>
    <td class="card-title">${esc(r.name)}${r.active ? '' : ' <span class="badge paused">paused</span>'}</td>
    <td>${esc(r.report_label)} <span class="muted small">${esc(String(r.format).toUpperCase())}</span></td>
    <td class="muted small">${esc(r.terminal_label || 'All terminals')}</td>
    <td>${esc(r.frequency_label)}</td>
    <td>${esc(r.time)}</td>
    <td>${esc(r.period_label)}</td>
    <td>${r.last_run_at ? esc(rsWhen(r.last_run_at)) : '<span class="muted small">never</span>'}</td>
    <td>${r.next_run_at ? esc(rsWhen(r.next_run_at)) : '<span class="muted small">—</span>'}</td>
    <td class="row-actions-cell">
      <div class="row-actions">
        ${iconButton(ICON.eye, 'View the report', `data-rs-view="${r.id}"`)}
        ${iconButton(ICON.download, `Download as ${String(r.format).toUpperCase()}`, `data-rs-download="${r.id}"`)}
        ${iconButton(ICON.send, 'Email it now', `data-rs-send="${r.id}"`)}
        ${iconButton(ICON.history, 'Recent runs', `data-rs-runs="${r.id}"`)}
        ${iconButton(ICON.edit, 'Edit the schedule', `data-rs-edit="${r.id}"`)}
        ${iconButton(ICON.trash, 'Delete the schedule', `data-rs-delete="${r.id}"`, 'danger')}
      </div>
    </td>
  </tr>`;
}

async function rsAction(e, rows) {
  const button = e.target.closest('button');
  if (!button) return;
  const data = button.dataset;
  const row = (id) => rows.find((r) => String(r.id) === id);

  if (data.rsRuns) return rsShowRuns(data.rsRuns);
  if (data.rsEdit) return rsEdit(row(data.rsEdit));

  if (data.rsView) {
    const schedule = row(data.rsView);
    return viewReport({
      path: `/api/reports/schedules/${data.rsView}/export`,
      body: { format: 'pdf', disposition: 'inline' },
      title: schedule ? schedule.name : 'Scheduled report',
      subtitle: schedule
        ? `${schedule.report_label} · ${schedule.period_label} · ${schedule.terminal_label}`
        : '',
    });
  }

  if (data.rsDownload) {
    button.disabled = true;
    try {
      const file = await reportFile(
        `/api/reports/schedules/${data.rsDownload}/export`,
        {}
      );
      if (file) saveBlob(file.blob, file.filename);
    } catch (err) {
      alert(err.message);
    } finally {
      button.disabled = false;
    }
    return;
  }

  if (data.rsSend) {
    // Asked first. This posts a real report to a real list of addresses, and
    // it used to be the only button here that did anything — so it got pressed
    // by anybody wanting to see what the schedule produced, and the whole
    // office got the test.
    const schedule = row(data.rsSend);
    const to = schedule ? schedule.recipients : 'its recipients';
    if (!confirm(`Email this report now to ${to}?`)) return;

    button.disabled = true;
    try {
      const outcome = await api(`/reports/schedules/${data.rsSend}/run`, {
        method: 'POST',
      });
      alert(
        outcome.status === 'sent'
          ? outcome.detail
          : `Not sent: ${outcome.detail || outcome.status}`
      );
      render();
    } catch (err) {
      alert(err.message);
    } finally {
      button.disabled = false;
    }
    return;
  }

  if (data.rsDelete) {
    const schedule = row(data.rsDelete);
    if (!confirm(`Delete "${schedule.name}"? It will stop sending.`)) return;
    await api(`/reports/schedules/${data.rsDelete}`, { method: 'DELETE' });
    render();
  }
}

/** A timestamp as somebody standing at a counter reads it. */
function rsWhen(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * The six things a schedule needs, in the order they were asked for: what it
 * is called, which report and in what format, which till it covers, how often
 * and when, what period it covers, and who gets it.
 *
 * One modal rather than a six-tab wizard. Nine fields fit on one screen, and a
 * wizard over nine fields costs four presses to check what you typed on the
 * first page. It is also the back office's own editor shape — see the note in
 * app.js about native dialogs, which is why this is a drawn modal and not a
 * chain of prompts.
 */
function rsEdit(existing) {
  modal(
    existing ? `Edit "${existing.name}"` : 'New scheduled report',
    [
      { name: 'name', label: 'Name', value: existing ? existing.name : '', required: true },
      {
        name: 'description',
        label: 'Description (optional)',
        value: existing && existing.description ? existing.description : '',
      },
      {
        name: 'report_key',
        label: 'Report',
        type: 'select',
        value: existing ? existing.report_key : rsOptions.reports[0].key,
        options: rsOptions.reports.map((r) => ({ value: r.key, label: r.label })),
      },
      {
        name: 'format',
        label: 'Format',
        type: 'select',
        value: existing ? existing.format : 'pdf',
        options: rsOptions.formats.map((f) => ({ value: f.key, label: f.label })),
      },
      {
        // The same list the Financial Summary screen offers, so a manager who
        // has just run a report for Bar 2 can schedule exactly that. Empty is
        // the whole venue, which is what every schedule made before the filter
        // existed already means.
        name: 'terminal',
        label: 'Terminal',
        type: 'select',
        value: existing ? existing.terminal || '' : '',
        options: [{ value: '', label: 'All terminals' }].concat(
          (rsOptions.terminals || []).map((t) => ({
            value: t.value,
            label: `${t.label} (${t.sales})`,
          }))
        ),
      },
      {
        name: 'frequency',
        label: 'How often it runs',
        type: 'select',
        value: existing ? existing.frequency : 'daily',
        options: rsOptions.frequencies.map((f) => ({ value: f.key, label: f.label })),
      },
      {
        name: 'time',
        label: 'Time of day',
        type: 'time',
        value: existing ? existing.time : '08:30',
      },
      {
        name: 'period',
        label: 'Period it covers',
        type: 'select',
        value: existing ? existing.period : 'yesterday',
        options: rsOptions.periods.map((p) => ({ value: p.key, label: p.label })),
      },
      {
        name: 'recipients',
        label: 'Send to (separate addresses with commas)',
        value: existing ? existing.recipients : '',
        required: true,
      },
      {
        name: 'active',
        label: 'Active',
        type: 'checkbox',
        value: existing ? (existing.active ? 1 : 0) : 1,
      },
    ],
    async (data) => {
      await api(
        existing ? `/reports/schedules/${existing.id}` : '/reports/schedules',
        {
          method: existing ? 'PUT' : 'POST',
          body: JSON.stringify({ ...data, active: Number(data.active) === 1 }),
        }
      );
    }
  );
}

/** What happened each time it fired. The answer to "it never arrived". */
async function rsShowRuns(id) {
  const runs = await api(`/reports/schedules/${id}/runs`);
  const body = runs.length
    ? runs
        .map(
          (r) => `<tr>
            <td>${esc(rsWhen(r.ran_at))}</td>
            <td><span class="badge ${r.status === 'sent' ? 'active' : 'paused'}">${esc(r.status)}</span></td>
            <td>${r.covered_from ? esc(`${rsWhen(r.covered_from)} – ${rsWhen(r.covered_to)}`) : '—'}</td>
            <td>${esc(r.recipients || '')}</td>
            <td class="muted small">${esc(r.detail || '')}</td>
          </tr>`
        )
        .join('')
    : '<tr><td colspan="5" class="muted small">It has not run yet.</td></tr>';

  $('rs-runs').innerHTML = `<div class="card">
    <div class="rr-section-head"><h3>Recent runs</h3></div>
    <div class="rr-scroll">
      <table class="table">
        <thead><tr><th>When</th><th>Outcome</th><th>Covered</th><th>Sent to</th><th>Detail</th></tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
  </div>`;
  // Written after the view loaded, so it missed the pass in render().
  cardsOnPhone($('rs-runs').querySelector('table'));
  $('rs-runs').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
