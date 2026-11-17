/**
 * Vesopa AI: the arithmetic. Every figure an owner reads in Vesopa AI is
 * worked out here, from the venue's own rows, before any model sees it.
 *
 * THE RULE THIS FILE EXISTS FOR
 *
 * The model explains; it never counts. Takings, margins, days of stock and
 * staff figures come out of these functions as plain numbers, the answer the
 * phone shows is built from them, and the words a model adds are checked
 * against them afterwards (`checkNarrative`): a sentence quoting a figure that
 * is not in the facts is thrown away and the plain wording is used instead.
 *
 * Nothing here touches the database or the network, so every rule is tested
 * in test/go-advisor.test.js with rows written by hand.
 *
 * WHAT THE WORDS MEAN (shown on the phone, under every answer)
 *
 *   Revenue       what customers paid on closed sales, VAT included, after
 *                 discounts: the till's own total, as the Z report counts it.
 *   Sales         closed bills (a split bill counts once per part).
 *   Average spend revenue / sales.
 *   Net sales     a product line's takings after line discounts, VAT taken out.
 *   Cost          quantity x the product's cost price as it stands now (the
 *                 "notional" cost every EPOS prints; GP Summary has the
 *                 stock-ledger figure).
 *   Gross profit  net sales - cost, only on products that have a cost price.
 *   Margin        gross profit / net sales.
 *   Days of cover stock now / average sold a day over the last 28 days.
 */
'use strict';

const DAY = 86400000;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// ---- money and numbers --------------------------------------------------------

/** £1,234.56 from pence; whole pounds when `whole`. */
function money(minor, whole = false) {
  const n = Math.round(Number(minor) || 0);
  const neg = n < 0;
  const abs = Math.abs(n);
  const pounds = whole ? Math.round(abs / 100) : Math.floor(abs / 100);
  const text = pounds.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}£${text}${whole ? '' : '.' + String(abs % 100).padStart(2, '0')}`;
}

/** Percentage change, one decimal; null when there is nothing to compare with. */
function change(now, before) {
  const a = Number(now) || 0;
  const b = Number(before) || 0;
  if (!b) return null;
  return Math.round(((a - b) / Math.abs(b)) * 1000) / 10;
}

const pct = (part, whole) => (whole ? Math.round((part / whole) * 1000) / 10 : null);
const round1 = (n) => Math.round((Number(n) || 0) * 10) / 10;

/** VAT inside a VAT-inclusive amount (the back office's own taxWithin). */
function taxWithin(minor, percentage) {
  const rate = Number(percentage) || 0;
  if (rate <= 0) return 0;
  return Math.round(minor - minor / (1 + rate / 100));
}

// ---- reporting periods ----------------------------------------------------------

/**
 * Wall-clock text for SQL. Sales are stored in the server's local time (the
 * driver writes a Date in local time), so local time is what we compare in.
 */
function sqlTime(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const midnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes(), d.getSeconds());
const monday = (d) => addDays(midnight(d), -((d.getDay() + 6) % 7));
const shortDate = (d) => `${WEEKDAYS[d.getDay()].slice(0, 3)} ${d.getDate()} ${d.toLocaleString('en-GB', { month: 'short' })}`;
const clock = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

const PERIODS = ['today', 'yesterday', 'this_week', 'last_week', 'last_7_days', 'this_month', 'last_month', 'last_30_days'];

/**
 * A period and the one it is fairly compared with.
 *
 * "So far" periods are compared with the same stretch of the one before, to
 * the same minute: 2pm on a Tuesday against 2pm last Tuesday, never against
 * the whole of last Tuesday, which would make every afternoon look like a
 * slump. Single days are compared with the same weekday a week earlier,
 * because a Saturday is not a Friday.
 */
function resolvePeriod(key, now = new Date()) {
  const today = midnight(now);
  const k = PERIODS.includes(key) ? key : 'today';
  let from;
  let to;
  let pFrom;
  let pTo;
  let label;
  let compareLabel;
  switch (k) {
    case 'yesterday':
      from = addDays(today, -1); to = today;
      pFrom = addDays(from, -7); pTo = addDays(to, -7);
      label = `Yesterday (${shortDate(from)})`;
      compareLabel = `The ${WEEKDAYS[pFrom.getDay()]} before (${shortDate(pFrom)})`;
      break;
    case 'this_week':
      from = monday(now); to = now;
      pFrom = addDays(from, -7); pTo = addDays(now, -7);
      label = `This week so far (from ${shortDate(from)})`;
      compareLabel = `Last week to the same point (${shortDate(pFrom)} to ${shortDate(pTo)} ${clock(pTo)})`;
      break;
    case 'last_week':
      to = monday(now); from = addDays(to, -7);
      pTo = from; pFrom = addDays(from, -7);
      label = `Last week (${shortDate(from)} to ${shortDate(addDays(to, -1))})`;
      compareLabel = `The week before (${shortDate(pFrom)} to ${shortDate(addDays(pTo, -1))})`;
      break;
    case 'last_7_days':
      from = addDays(today, -6); to = now;
      pFrom = addDays(from, -7); pTo = from;
      label = `Last 7 days (${shortDate(from)} to today)`;
      compareLabel = `The 7 days before (${shortDate(pFrom)} to ${shortDate(addDays(pTo, -1))})`;
      break;
    case 'last_30_days':
      from = addDays(today, -29); to = now;
      pFrom = addDays(from, -30); pTo = from;
      label = `Last 30 days (${shortDate(from)} to today)`;
      compareLabel = `The 30 days before (${shortDate(pFrom)} to ${shortDate(addDays(pTo, -1))})`;
      break;
    case 'this_month': {
      from = new Date(now.getFullYear(), now.getMonth(), 1); to = now;
      pFrom = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      // The same day of last month, clipped to its end (31 March -> 28 Feb).
      const lastDay = new Date(now.getFullYear(), now.getMonth(), 0).getDate();
      pTo = new Date(pFrom.getFullYear(), pFrom.getMonth(), Math.min(now.getDate(), lastDay), now.getHours(), now.getMinutes(), now.getSeconds());
      label = `This month so far (${now.toLocaleString('en-GB', { month: 'long' })})`;
      compareLabel = `Last month to the same day (${pFrom.toLocaleString('en-GB', { month: 'long' })})`;
      break;
    }
    case 'last_month':
      from = new Date(now.getFullYear(), now.getMonth() - 1, 1); to = new Date(now.getFullYear(), now.getMonth(), 1);
      pFrom = new Date(now.getFullYear(), now.getMonth() - 2, 1); pTo = from;
      label = `Last month (${from.toLocaleString('en-GB', { month: 'long', year: 'numeric' })})`;
      compareLabel = `The month before (${pFrom.toLocaleString('en-GB', { month: 'long', year: 'numeric' })})`;
      break;
    default: // today
      from = today; to = now;
      pFrom = addDays(today, -7); pTo = addDays(now, -7);
      label = `Today so far (${shortDate(today)}, to ${clock(now)})`;
      compareLabel = `Last ${WEEKDAYS[pFrom.getDay()]} to the same time (${clock(pTo)})`;
  }
  return {
    key: k,
    label,
    from: sqlTime(from),
    to: sqlTime(to),
    compare: { label: compareLabel, from: sqlTime(pFrom), to: sqlTime(pTo) },
    days: Math.max(1, Math.ceil((to - from) / DAY)),
  };
}

// ---- what the rows add up to ------------------------------------------------------

/**
 * One period's headline figures from the totals row.
 * @param {{sales, gross_minor, discount_minor, covers, last_sale_at}} t
 */
function summary(t) {
  const sales = Number(t && t.sales) || 0;
  const revenue = Number(t && t.gross_minor) || 0;
  return {
    sales,
    revenue_minor: revenue,
    average_minor: sales ? Math.round(revenue / sales) : 0,
    discount_minor: Number(t && t.discount_minor) || 0,
    covers: Number(t && t.covers) || 0,
    last_sale_at: (t && t.last_sale_at) || null,
  };
}

/** Product rows (grouped by product and VAT rate in SQL) into one row per product, with profit. */
function products(rows) {
  const map = new Map();
  for (const r of rows || []) {
    const key = r.plu_id != null ? `p${r.plu_id}` : `n${r.name}`;
    const qty = Number(r.qty) || 0;
    const sales = Math.round(Number(r.sales_minor) || 0);
    const discount = Math.round(Number(r.discount_minor) || 0);
    const gross = sales - discount;
    const net = gross - taxWithin(gross, r.tax_percentage);
    const hasCost = r.cost_price != null && Number(r.cost_price) > 0;
    const cost = hasCost ? Math.round(qty * Number(r.cost_price) * 100) : 0;
    if (!map.has(key)) {
      map.set(key, {
        plu: r.plu_id != null ? Number(r.plu_id) : null,
        name: String(r.name || 'Unknown'),
        department: String(r.department || 'Unassigned'),
        qty: 0, gross_minor: 0, net_minor: 0, cost_minor: 0, has_cost: hasCost,
      });
    }
    const p = map.get(key);
    p.qty += qty;
    p.gross_minor += gross;
    p.net_minor += net;
    p.cost_minor += cost;
    p.has_cost = p.has_cost && hasCost;
  }
  return [...map.values()].map((p) => {
    const gp = p.has_cost ? p.net_minor - p.cost_minor : null;
    return { ...p, qty: round1(p.qty), gp_minor: gp, margin_pct: gp == null ? null : pct(gp, p.net_minor) };
  });
}

/** The venue's gross profit over the products that have a cost price, and what it leaves out. */
function profit(productRows) {
  let net = 0;
  let cost = 0;
  let uncostedNet = 0;
  const uncosted = [];
  for (const p of productRows) {
    if (p.has_cost) {
      net += p.net_minor;
      cost += p.cost_minor;
    } else {
      uncostedNet += p.net_minor;
      uncosted.push(p.name);
    }
  }
  const gp = net - cost;
  const total = net + uncostedNet;
  return {
    net_minor: net,
    cost_minor: cost,
    gp_minor: gp,
    margin_pct: pct(gp, net),
    uncosted_net_minor: uncostedNet,
    uncosted_count: uncosted.length,
    uncosted_share_pct: pct(uncostedNet, total),
    uncosted: uncosted.slice(0, 20),
  };
}

/** Group a list into a Map of name -> {sales, gross_minor}. */
function byName(rows, nameOf) {
  const m = new Map();
  for (const r of rows || []) {
    const name = nameOf(r);
    const cur = m.get(name) || { name, sales: 0, gross_minor: 0, discount_minor: 0 };
    cur.sales += Number(r.sales) || 0;
    cur.gross_minor += Number(r.gross_minor) || 0;
    cur.discount_minor += Number(r.discount_minor) || 0;
    m.set(name, cur);
  }
  return m;
}

/** Two periods side by side by name, with the difference, biggest change first. */
function movers(cur, prev) {
  const names = new Set([...cur.keys(), ...prev.keys()]);
  const out = [];
  for (const name of names) {
    const a = cur.get(name) || { gross_minor: 0, sales: 0 };
    const b = prev.get(name) || { gross_minor: 0, sales: 0 };
    out.push({
      name,
      now_minor: Math.round(a.gross_minor),
      before_minor: Math.round(b.gross_minor),
      diff_minor: Math.round(a.gross_minor - b.gross_minor),
      change_pct: change(a.gross_minor, b.gross_minor),
      now_sales: a.sales,
      before_sales: b.sales,
    });
  }
  return out.sort((x, y) => Math.abs(y.diff_minor) - Math.abs(x.diff_minor));
}

const hourLabel = (h) => `${String(h).padStart(2, '0')}:00`;

/**
 * Why revenue moved: how much of the difference is fewer (or more) sales and
 * how much is spend per sale, then which products, hours, staff and sites the
 * difference sits in. The two parts add up exactly to the difference.
 */
function explainChange({ now, before, productsNow = [], productsBefore = [], hoursNow = [], hoursBefore = [], staffNow = [], staffBefore = [], sitesNow = [], sitesBefore = [] }) {
  const diff = now.revenue_minor - before.revenue_minor;
  // Volume at last period's spend, and the spend difference on this period's volume.
  const volume = Math.round((now.sales - before.sales) * before.average_minor);
  const spend = diff - volume;
  const prodMap = (rows) => new Map(rows.map((p) => [p.name, { name: p.name, sales: p.qty, gross_minor: p.gross_minor }]));
  const productMovers = movers(prodMap(productsNow), prodMap(productsBefore));
  const hourMovers = movers(byName(hoursNow, (r) => hourLabel(Number(r.hour))), byName(hoursBefore, (r) => hourLabel(Number(r.hour))));
  const staffMovers = movers(byName(staffNow, (r) => r.name), byName(staffBefore, (r) => r.name));
  const siteMovers = movers(byName(sitesNow, (r) => r.name), byName(sitesBefore, (r) => r.name));
  const direction = diff < 0 ? -1 : 1;
  // The drivers that pushed the same way as the total, biggest first.
  const along = (list) => list.filter((m) => Math.sign(m.diff_minor) === direction && m.diff_minor !== 0).slice(0, 3);
  return {
    diff_minor: diff,
    change_pct: change(now.revenue_minor, before.revenue_minor),
    volume_minor: volume,
    spend_minor: spend,
    sales_change: now.sales - before.sales,
    average_change_minor: now.average_minor - before.average_minor,
    products: along(productMovers),
    hours: along(hourMovers),
    staff: along(staffMovers),
    sites: sitesNow.length + sitesBefore.length > 1 ? along(siteMovers) : [],
    against: productMovers.filter((m) => Math.sign(m.diff_minor) === -direction && m.diff_minor !== 0).slice(0, 2),
  };
}

// ---- stock -------------------------------------------------------------------------

/**
 * Stock forecast from what is on hand and the last 28 days of sales.
 *
 * Only products whose stock is counted (stock_quantity set) are forecast.
 * Reorder suggestion: enough for `targetDays` of sales at the 28-day rate,
 * less what is on hand, rounded up. Stated as an assumption on the phone,
 * because supplier lead times are not held anywhere yet.
 */
function stockForecast(rows, { targetDays = 14, now = new Date() } = {}) {
  const items = [];
  for (const r of rows || []) {
    if (r.stock_quantity == null || r.stock_quantity === '') continue;
    const stock = Number(r.stock_quantity) || 0;
    const sold = Number(r.sold_28d) || 0;
    const perDay = sold / 28;
    const cover = perDay > 0 ? stock / perDay : null;
    const low = r.low_stock_at != null && r.low_stock_at !== '' ? Number(r.low_stock_at) : null;
    const reorder = perDay > 0 ? Math.max(0, Math.ceil(perDay * targetDays - stock)) : 0;
    let status = 'ok';
    if (stock <= 0) status = 'out';
    else if (cover != null && cover < 3) status = 'critical';
    else if ((low != null && stock <= low) || (cover != null && cover < 7)) status = 'low';
    else if (sold === 0) status = 'not_moving';
    items.push({
      plu: r.pluid != null ? Number(r.pluid) : null,
      name: String(r.product_name || 'Unknown'),
      department: String(r.department_name || 'Unassigned'),
      stock: round1(stock),
      low_at: low,
      sold_28d: round1(sold),
      per_day: round1(perDay),
      days_cover: cover == null ? null : round1(cover),
      runs_out: cover == null || stock <= 0 ? null : sqlTime(new Date(now.getTime() + cover * DAY)).slice(0, 10),
      reorder_qty: status === 'ok' || status === 'not_moving' ? 0 : reorder,
      cost_minor: r.cost_price != null ? Math.round(Number(r.cost_price) * 100) : null,
      status,
    });
  }
  const rank = { out: 0, critical: 1, low: 2, ok: 3, not_moving: 4 };
  items.sort((a, b) => rank[a.status] - rank[b.status] || (a.days_cover ?? 1e9) - (b.days_cover ?? 1e9));
  const tracked = items.length;
  const moving = items.filter((i) => i.per_day > 0).sort((a, b) => b.per_day - a.per_day);
  return {
    tracked,
    target_days: targetDays,
    out: items.filter((i) => i.status === 'out'),
    critical: items.filter((i) => i.status === 'critical'),
    low: items.filter((i) => i.status === 'low'),
    reorder: items.filter((i) => i.reorder_qty > 0),
    fast: moving.slice(0, 8),
    slow: items
      .filter((i) => i.status === 'not_moving' && i.stock > 0)
      .map((i) => ({ ...i, value_minor: i.cost_minor != null ? Math.round(i.cost_minor * i.stock) : null }))
      .sort((a, b) => (b.value_minor || 0) - (a.value_minor || 0))
      .slice(0, 8),
    items,
  };
}

// ---- staff and sites ------------------------------------------------------------------

function staffTable(rows, prevRows = []) {
  const total = (rows || []).reduce((s, r) => s + (Number(r.gross_minor) || 0), 0);
  const prev = byName(prevRows, (r) => r.name);
  return (rows || [])
    .map((r) => {
      const sales = Number(r.sales) || 0;
      const gross = Number(r.gross_minor) || 0;
      const p = prev.get(r.name);
      return {
        name: r.name,
        sales,
        gross_minor: gross,
        average_minor: sales ? Math.round(gross / sales) : 0,
        discount_minor: Number(r.discount_minor) || 0,
        share_pct: pct(gross, total),
        change_pct: p ? change(gross, p.gross_minor) : null,
      };
    })
    .sort((a, b) => b.gross_minor - a.gross_minor);
}

/** Terminal rows into site rows, with the site map from bo_till_names / bo_till_sites. */
function sitesFromTerminals(rows, terminalSite, siteNames) {
  const m = new Map();
  for (const r of rows || []) {
    const siteId = terminalSite.get(String(r.terminal || ''));
    const name = siteId != null ? (siteNames.get(siteId) || `Site ${siteId}`) : 'Not in a site';
    const cur = m.get(name) || { name, site_id: siteId ?? null, sales: 0, gross_minor: 0, discount_minor: 0 };
    cur.sales += Number(r.sales) || 0;
    cur.gross_minor += Number(r.gross_minor) || 0;
    m.set(name, cur);
  }
  return [...m.values()].sort((a, b) => b.gross_minor - a.gross_minor);
}

// ---- alerts and recommendations ---------------------------------------------------------

/**
 * What an owner should know and could do, from the computed facts only. Each
 * one carries the figures it rests on, so the phone can show why.
 */
function alertsAndActions({ now, before, explain, stock, profitNow, productRows = [], staff = [], hours = [] }) {
  const alerts = [];
  const actions = [];
  const ch = change(now.revenue_minor, before.revenue_minor);
  if (ch != null && ch <= -15 && before.revenue_minor >= 5000) {
    alerts.push({ tone: 'bad', title: `Revenue down ${Math.abs(ch)}%`, detail: `${money(now.revenue_minor)} against ${money(before.revenue_minor)}.` });
  } else if (ch != null && ch >= 15 && before.revenue_minor >= 5000) {
    alerts.push({ tone: 'good', title: `Revenue up ${ch}%`, detail: `${money(now.revenue_minor)} against ${money(before.revenue_minor)}.` });
  }
  if (stock) {
    if (stock.out.length) {
      alerts.push({ tone: 'bad', title: `${stock.out.length} counted product${stock.out.length === 1 ? '' : 's'} out of stock`, detail: stock.out.slice(0, 4).map((i) => i.name).join(', ') + '.' });
    }
    const soon = [...stock.critical, ...stock.low].filter((i) => i.days_cover != null);
    if (soon.length) {
      const first = soon[0];
      alerts.push({ tone: 'warn', title: `${soon.length} product${soon.length === 1 ? '' : 's'} running low`, detail: `${first.name} has about ${first.days_cover} days left at its usual rate.` });
      actions.push({
        title: `Reorder ${soon.length === 1 ? first.name : soon.length + ' products'}`,
        why: `${first.name}: ${first.stock} in stock, about ${first.per_day} sold a day, so roughly ${first.days_cover} days of cover.`,
        action: 'stock',
      });
    }
  }
  const losers = productRows.filter((p) => p.gp_minor != null && p.gp_minor < 0 && p.qty > 0).sort((a, b) => a.gp_minor - b.gp_minor);
  if (losers.length) {
    alerts.push({ tone: 'bad', title: `${losers.length} product${losers.length === 1 ? '' : 's'} selling below cost`, detail: `${losers[0].name} lost ${money(-losers[0].gp_minor)} on ${losers[0].qty} sold.` });
    actions.push({ title: `Check the price or cost of ${losers[0].name}`, why: `Net sales ${money(losers[0].net_minor)} against a cost of ${money(losers[0].cost_minor)}.`, action: 'profit' });
  }
  if (profitNow && profitNow.uncosted_share_pct != null && profitNow.uncosted_share_pct >= 20) {
    actions.push({
      title: 'Add cost prices to see your real profit',
      why: `${profitNow.uncosted_count} products (${profitNow.uncosted_share_pct}% of net sales) have no cost price, so they are left out of gross profit.`,
      action: 'profit',
    });
  }
  if (explain && explain.diff_minor < 0) {
    if (explain.volume_minor < explain.spend_minor) {
      actions.push({ title: 'Bring more customers in', why: `${Math.abs(explain.sales_change)} fewer sales cost about ${money(-explain.volume_minor)}; spend per sale held up better.`, action: 'sales' });
    } else {
      actions.push({ title: 'Lift spend per sale', why: `Average spend fell by ${money(-explain.average_change_minor)}, worth about ${money(-explain.spend_minor)}. Try suggesting sides, desserts or a second drink.`, action: 'sales' });
    }
  }
  const top = productRows.filter((p) => p.margin_pct != null && p.qty > 0).sort((a, b) => b.gp_minor - a.gp_minor)[0];
  if (top) {
    actions.push({ title: `Push ${top.name}`, why: `Your biggest profit earner: ${money(top.gp_minor)} gross profit at a ${top.margin_pct}% margin.`, action: 'profit' });
  }
  const busiest = [...hours].sort((a, b) => (Number(b.gross_minor) || 0) - (Number(a.gross_minor) || 0))[0];
  if (busiest && Number(busiest.gross_minor) > 0) {
    actions.push({ title: `Staff up for ${hourLabel(Number(busiest.hour))}`, why: `Your busiest hour: ${money(busiest.gross_minor)} from ${busiest.sales} sales.`, action: 'sales' });
  }
  const heavyDiscount = staff.filter((s) => s.gross_minor > 0 && s.discount_minor / (s.gross_minor + s.discount_minor) > 0.1)[0];
  if (heavyDiscount) {
    alerts.push({ tone: 'warn', title: `High discounts from ${heavyDiscount.name}`, detail: `${money(heavyDiscount.discount_minor)} discounted on ${money(heavyDiscount.gross_minor)} of sales.` });
  }
  return { alerts, actions: actions.slice(0, 5) };
}

// ---- understanding the question ----------------------------------------------------------

/**
 * What is being asked, without a model: the intent, the period and anything
 * named. Fast and predictable, and it is what runs when no model is set up.
 * A follow-up ("and yesterday?") keeps the last question's intent.
 */
function parseQuestion(text, previous = null) {
  const q = ` ${String(text || '').toLowerCase().replace(/[^a-z0-9£%' ]+/g, ' ')} `;
  const has = (...words) => words.some((w) => q.includes(w));
  let period = null;
  if (has(' yesterday', 'last night')) period = 'yesterday';
  // "This week with last week" is this week: every period is already compared with the one before.
  else if (has('this week', 'week so far')) period = 'this_week';
  else if (has('last week', 'previous week')) period = 'last_week';
  else if (has('weekly', ' week ')) period = 'this_week';
  else if (has('this month', 'month so far')) period = 'this_month';
  else if (has('last month', 'previous month')) period = 'last_month';
  else if (has('monthly', ' month ')) period = 'this_month';
  else if (has('30 days', 'thirty days')) period = 'last_30_days';
  else if (has('7 days', 'seven days')) period = 'last_7_days';
  else if (has('today', 'tonight', 'so far')) period = 'today';

  let intent = null;
  if (has('tomorrow', 'focus', 'priorit', 'should i do', 'what should', 'advice', 'recommend', 'improve')) intent = 'focus';
  else if (has('why', 'reason', 'drop', 'decreas', 'fell', 'fall', 'down ', 'went down', 'increas', 'went up', 'grew', 'rise')) intent = 'why_change';
  else if (has('reorder', 'restock', 'order more', 'running out', 'run out', 'stockout', 'low stock', 'stock', 'inventory')) {
    intent = has('slow', 'fast', 'moving', 'not selling', 'dead') ? 'stock_movers' : 'stock';
  } else if (has('slow moving', 'fast moving', 'not selling', 'slow seller', 'dead stock')) intent = 'stock_movers';
  else if (has('loss', 'losing', 'below cost', 'unprofitable', 'loss making')) intent = 'loss_makers';
  else if (has('profit', 'margin', ' gp ', 'gross profit', 'cost of sales')) intent = 'profit';
  else if (has('branch', 'site', 'location', 'venue performed', 'shops', 'stores')) intent = 'branches';
  else if (has('staff', 'team', 'employee', 'clerk', 'server', 'waiter', 'bartender', 'who sold', 'people')) intent = 'staff';
  else if (has('busiest', 'busy', 'hour', 'peak', 'quiet')) intent = 'hours';
  else if (has('best sell', 'best-sell', 'top product', 'top sell', 'most popular', 'popular', 'best product', 'products', 'what sold', 'selling')) intent = 'top_products';
  else if (has('compare', ' vs ', 'versus', 'against', 'compared')) intent = 'summary';
  else if (has('how much', 'make', 'made', 'takings', 'revenue', 'sales', 'turnover', 'earn', 'how are we', 'how did we', 'how is business', 'doing')) intent = 'summary';

  const followUp = !intent && previous && previous.intent;
  if (followUp) intent = previous.intent;
  if (!period && previous && previous.period && (followUp || intent === previous.intent)) period = previous.period;
  if (!period) period = intent === 'focus' ? 'last_7_days' : intent === 'stock' || intent === 'stock_movers' ? 'last_30_days' : intent === 'profit' || intent === 'loss_makers' ? 'last_30_days' : intent === 'staff' || intent === 'branches' ? 'this_week' : intent === 'why_change' ? 'yesterday' : 'today';
  return { intent: intent || 'unknown', period, follow_up: Boolean(followUp) };
}

const INTENTS = ['summary', 'why_change', 'top_products', 'profit', 'loss_makers', 'stock', 'stock_movers', 'staff', 'branches', 'hours', 'focus'];

const SUGGESTIONS = [
  'How much did we make today?',
  'Why did sales drop yesterday?',
  'Which products make the most profit?',
  'What stock should I reorder?',
  'Which branch performed best this week?',
  'How is my team performing?',
  'Compare this week with last week',
  'What should I focus on tomorrow?',
];

const FOLLOW_UPS = {
  summary: ['Why did it change?', 'What were the best sellers?', 'What about yesterday?'],
  why_change: ['Which products made money?', 'How did the team do?', 'What should I focus on tomorrow?'],
  top_products: ['Which products make the most profit?', 'Any products selling below cost?', 'What stock should I reorder?'],
  profit: ['Any products selling below cost?', 'What were the best sellers?', 'What should I focus on tomorrow?'],
  loss_makers: ['Which products make the most profit?', 'What should I focus on tomorrow?'],
  stock: ['Which products are not moving?', 'What were the best sellers this week?'],
  stock_movers: ['What stock should I reorder?', 'Which products make the most profit?'],
  staff: ['Compare with last week', 'Which branch performed best?', 'What were the busiest hours?'],
  branches: ['How is my team performing?', 'Why did sales change this week?'],
  hours: ['How is my team performing?', 'What about yesterday?'],
  focus: ['What stock should I reorder?', 'Why did sales change?', 'Which products make the most profit?'],
};

// ---- keeping the model honest --------------------------------------------------------------

/**
 * Every figure in a model's sentence must be one we gave it. Money is matched
 * to the penny or to the whole pound, percentages to one decimal, counts
 * exactly; small numbers (dates, "3 things") are let through. Returns the
 * figures that are not in the facts.
 */
function checkNarrative(text, facts) {
  const allowed = new Set();
  const add = (v) => allowed.add(String(v).replace(/,/g, ''));
  (function walk(v, key) {
    if (v == null) return;
    if (Array.isArray(v)) return v.forEach((x) => walk(x, key));
    if (typeof v === 'object') return Object.entries(v).forEach(([k, x]) => walk(x, k));
    if (typeof v === 'number') {
      if (/minor$/.test(key || '')) {
        const pounds = Math.abs(v) / 100;
        add(pounds.toFixed(2));
        add(Math.round(pounds));
        add(Math.floor(pounds));
      } else {
        add(Math.abs(v));
        add(Math.abs(Math.round(v)));
        add(Math.abs(round1(v)));
        add(Math.abs(v).toFixed(1));
      }
      return;
    }
    if (typeof v === 'string') {
      for (const m of v.match(/\d[\d,]*(?:\.\d+)?/g) || []) add(m);
    }
  })(facts, '');
  const bad = [];
  for (const m of String(text || '').match(/£?\d[\d,]*(?:\.\d+)?%?/g) || []) {
    const n = m.replace(/[£%,]/g, '');
    const value = Number(n);
    if (!m.startsWith('£') && !m.endsWith('%') && Number.isInteger(value) && value <= 31) continue;
    if (/^20\d\d$/.test(n)) continue;
    const variants = [n, String(value), value.toFixed(2), value.toFixed(1), String(Math.round(value))];
    if (!variants.some((x) => allowed.has(x))) bad.push(m);
  }
  return bad;
}

/** Staff names to "Staff A", "Staff B" (and back), so no name leaves the server. */
function pseudonyms(names) {
  const forward = new Map();
  const back = new Map();
  let i = 0;
  for (const n of names) {
    if (!n || forward.has(n)) continue;
    const alias = `Staff ${i < 26 ? String.fromCharCode(65 + i) : i + 1}`;
    i++;
    forward.set(n, alias);
    back.set(alias, n);
  }
  return {
    hide: (name) => forward.get(name) || name,
    reveal: (text) => String(text || '').replace(/Staff (?:[A-Z]|\d+)\b/g, (a) => back.get(a) || a),
  };
}

module.exports = {
  money,
  change,
  taxWithin,
  sqlTime,
  resolvePeriod,
  PERIODS,
  summary,
  products,
  profit,
  movers,
  explainChange,
  stockForecast,
  staffTable,
  sitesFromTerminals,
  alertsAndActions,
  parseQuestion,
  INTENTS,
  SUGGESTIONS,
  FOLLOW_UPS,
  checkNarrative,
  pseudonyms,
  hourLabel,
};
