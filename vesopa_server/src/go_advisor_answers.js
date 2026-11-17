/**
 * Vesopa AI: turning computed figures into an answer the phone can draw.
 *
 * One function per kind of question. Each takes the figures go_advisor.js
 * fetched and go_advisor_engine.js worked out, and returns:
 *
 *   title      what the answer is about
 *   headline   one sentence with the main figure (always from the numbers)
 *   why        up to four plain reasons, each resting on a figure
 *   next       up to three things the owner could do
 *   cards      what Go draws: kpis, bars, table, drivers, alerts
 *   facts      the figures a model may use to word the answer, and nothing
 *              else (staff names already swapped for "Staff A" by the caller)
 *   records    which supporting rows "View data" opens
 *
 * No database, no network: test/go-advisor.test.js drives it with rows.
 */
'use strict';

const E = require('./go_advisor_engine');

const { money } = E;
/** A label mid-sentence: only its first letter lowered, so "Last Tuesday" stays a Tuesday. */
const lc = (s) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : '');
/** ", up 4.5%" / ", down 2%" / ", level"; nothing when there is nothing to compare. */
const trend = (p) => (p == null ? '' : p === 0 ? ', level with before' : `, ${p > 0 ? 'up' : 'down'} ${Math.abs(p)}%`);
const signed = (minor) => (minor < 0 ? `-${money(-minor)}` : `+${money(minor)}`);
const updown = (p) => (p == null ? 'with nothing to compare against' : p === 0 ? 'level with' : p > 0 ? `up ${p}% on` : `down ${Math.abs(p)}% on`);

function kpi(label, value, kind, changePct = null, goodWhen = 'up') {
  return { label, value, kind, change_pct: changePct, good_when: goodWhen };
}

function salesKpis(now, before) {
  return {
    type: 'kpis',
    items: [
      kpi('Revenue', now.revenue_minor, 'money', E.change(now.revenue_minor, before.revenue_minor)),
      kpi('Sales', now.sales, 'count', E.change(now.sales, before.sales)),
      kpi('Average spend', now.average_minor, 'money', E.change(now.average_minor, before.average_minor)),
      kpi('Discounts', now.discount_minor, 'money', E.change(now.discount_minor, before.discount_minor), 'down'),
    ],
  };
}

/** The shape of the day or the period: by hour for a day, by day otherwise. */
function trendCard(d, ctx) {
  const single = ctx.period.key === 'today' || ctx.period.key === 'yesterday';
  if (single) {
    const byHour = (rows) => new Map((rows || []).map((r) => [Number(r.hour), Number(r.gross_minor) || 0]));
    const a = byHour(d.hours);
    const b = byHour(d.hoursBefore);
    const hours = [...new Set([...a.keys(), ...b.keys()])].sort((x, y) => x - y);
    return {
      type: 'bars',
      title: 'Revenue by hour',
      kind: 'money',
      compare_label: ctx.period.compare.label,
      items: hours.map((h) => ({ label: E.hourLabel(h).slice(0, 2), value: a.get(h) || 0, compare: b.get(h) || 0 })),
    };
  }
  return {
    type: 'bars',
    title: 'Revenue by day',
    kind: 'money',
    items: (d.days || []).map((r) => {
      const day = new Date(String(r.day).slice(0, 10) + 'T12:00:00');
      const label = Number.isNaN(day.getTime()) ? String(r.day).slice(5, 10) : `${day.toLocaleString('en-GB', { weekday: 'short' })} ${day.getDate()}`;
      return { label, value: Number(r.gross_minor) || 0 };
    }),
  };
}

function productTable(rows, title, { profit = false, limit = 10 } = {}) {
  const total = rows.reduce((s, p) => s + p.gross_minor, 0);
  const columns = [
    { key: 'name', label: 'Product', kind: 'text' },
    { key: 'qty', label: 'Sold', kind: 'count' },
    { key: 'gross_minor', label: 'Revenue', kind: 'money' },
  ];
  if (profit) {
    columns.push({ key: 'gp_minor', label: 'Gross profit', kind: 'money' }, { key: 'margin_pct', label: 'Margin', kind: 'pct' });
  } else {
    columns.push({ key: 'share_pct', label: 'Share', kind: 'pct' });
  }
  return {
    type: 'table',
    title,
    columns,
    rows: rows.slice(0, limit).map((p) => ({ ...p, share_pct: total ? Math.round((p.gross_minor / total) * 1000) / 10 : null })),
  };
}

// ---- one per intent ---------------------------------------------------------------

function summaryAnswer(d, ctx) {
  const { now, before } = d;
  const ch = E.change(now.revenue_minor, before.revenue_minor);
  const top = [...d.products].sort((a, b) => b.gross_minor - a.gross_minor);
  const why = [];
  if (before.sales || now.sales) why.push(`${now.sales} sales against ${before.sales}, average spend ${money(now.average_minor)} against ${money(before.average_minor)}.`);
  if (top[0]) why.push(`${top[0].name} brought in the most: ${money(top[0].gross_minor)} from ${top[0].qty} sold.`);
  if (now.discount_minor) why.push(`Discounts given: ${money(now.discount_minor)}.`);
  const headline = now.sales
    ? `${money(now.revenue_minor)} from ${now.sales} sale${now.sales === 1 ? '' : 's'}, ${updown(ch)} ${lc(ctx.period.compare.label)}.`
    : `No closed sales yet in ${lc(ctx.period.label)}.`;
  return {
    title: 'Sales',
    headline,
    why,
    cards: [salesKpis(now, before), trendCard(d, ctx), productTable(top, 'Best sellers', { limit: 5 })],
    facts: { revenue: money(now.revenue_minor), revenue_before: money(before.revenue_minor), change_pct: ch, sales: now.sales, sales_before: before.sales, average: money(now.average_minor), average_before: money(before.average_minor), discounts: money(now.discount_minor), top_products: top.slice(0, 3).map((p) => ({ name: p.name, revenue: money(p.gross_minor), qty: p.qty })) },
    records: 'orders',
  };
}

function whyAnswer(d, ctx) {
  const { now, before } = d;
  const x = E.explainChange({
    now, before,
    productsNow: d.products, productsBefore: d.productsBefore,
    hoursNow: d.hours, hoursBefore: d.hoursBefore,
    staffNow: d.staff, staffBefore: d.staffBefore,
    sitesNow: d.sites, sitesBefore: d.sitesBefore,
  });
  const fell = x.diff_minor < 0;
  const word = fell ? 'lower' : 'higher';
  const headline = !now.sales && !before.sales
    ? 'There were no sales in either period, so there is nothing to explain yet.'
    : x.diff_minor === 0
      ? `Revenue was ${money(now.revenue_minor)}, exactly level with ${lc(ctx.period.compare.label)}.`
      : `Revenue was ${money(now.revenue_minor)}, ${money(Math.abs(x.diff_minor))}${x.change_pct != null ? ` (${Math.abs(x.change_pct)}%)` : ''} ${word} than ${lc(ctx.period.compare.label)}.`;
  const why = [];
  if (x.diff_minor !== 0) {
    const volumeBigger = Math.abs(x.volume_minor) >= Math.abs(x.spend_minor);
    const salesPart = `${Math.abs(x.sales_change)} ${x.sales_change < 0 ? 'fewer' : 'more'} sales (${now.sales} against ${before.sales}) account for about ${money(Math.abs(x.volume_minor))}`;
    const spendPart = `average spend ${x.average_change_minor < 0 ? 'fell' : 'rose'} by ${money(Math.abs(x.average_change_minor))} to ${money(now.average_minor)}, worth about ${money(Math.abs(x.spend_minor))}`;
    why.push(volumeBigger ? `Mostly footfall: ${salesPart}; ${spendPart}.` : `Mostly spend per sale: ${spendPart}; ${salesPart}.`);
    if (x.products.length) why.push(`Products: ${x.products.map((m) => `${m.name} ${signed(m.diff_minor)}`).join(', ')}.`);
    if (x.hours.length) why.push(`Hours: ${x.hours.map((m) => `${m.name} ${signed(m.diff_minor)}`).join(', ')}.`);
    if (x.sites.length) why.push(`Sites: ${x.sites.map((m) => `${m.name} ${signed(m.diff_minor)}`).join(', ')}.`);
    else if (x.staff.length) why.push(`Staff: ${x.staff.map((m) => `${m.name} ${signed(m.diff_minor)}`).join(', ')}.`);
  }
  const drivers = {
    type: 'drivers',
    title: 'What made the difference',
    total_minor: x.diff_minor,
    items: [
      { label: 'Number of sales', value_minor: x.volume_minor, detail: `${now.sales} against ${before.sales}` },
      { label: 'Spend per sale', value_minor: x.spend_minor, detail: `${money(now.average_minor)} against ${money(before.average_minor)}` },
    ],
  };
  const moverBars = (title, list) => ({ type: 'bars', title, kind: 'money', signed: true, items: list.map((m) => ({ label: m.name, value: m.diff_minor })) });
  const cards = [salesKpis(now, before), drivers];
  if (x.products.length || x.against.length) cards.push(moverBars('Products that moved it', [...x.products, ...x.against]));
  if (x.hours.length) cards.push(moverBars('Hours that moved it', x.hours));
  if (x.sites.length) cards.push(moverBars('Sites that moved it', x.sites));
  else if (x.staff.length) cards.push(moverBars('Staff that moved it', x.staff));
  return {
    title: fell ? 'Why sales fell' : 'Why sales rose',
    headline,
    why,
    cards,
    facts: {
      revenue: money(now.revenue_minor), revenue_before: money(before.revenue_minor), difference: money(Math.abs(x.diff_minor)), direction: fell ? 'down' : 'up', change_pct: x.change_pct,
      sales: now.sales, sales_before: before.sales, sales_change: x.sales_change, volume_effect: money(Math.abs(x.volume_minor)),
      average: money(now.average_minor), average_before: money(before.average_minor), spend_effect: money(Math.abs(x.spend_minor)),
      products: x.products.map((m) => ({ name: m.name, change: signed(m.diff_minor) })),
      hours: x.hours.map((m) => ({ hour: m.name, change: signed(m.diff_minor) })),
      staff: x.staff.map((m) => ({ name: m.name, change: signed(m.diff_minor) })),
      sites: x.sites.map((m) => ({ name: m.name, change: signed(m.diff_minor) })),
    },
    explain: x,
    records: 'orders',
  };
}

function topProductsAnswer(d) {
  const top = [...d.products].sort((a, b) => b.gross_minor - a.gross_minor);
  const prev = new Map((d.productsBefore || []).map((p) => [p.name, p]));
  const total = top.reduce((s, p) => s + p.gross_minor, 0);
  const why = top.slice(0, 3).map((p) => {
    const b = prev.get(p.name);
    const ch = b ? E.change(p.gross_minor, b.gross_minor) : null;
    return `${p.name}: ${money(p.gross_minor)} from ${p.qty} sold${ch != null ? ` (${ch >= 0 ? 'up' : 'down'} ${Math.abs(ch)}%)` : ''}.`;
  });
  return {
    title: 'Best sellers',
    headline: top.length
      ? `${top[0].name} is your best seller: ${money(top[0].gross_minor)}, ${total ? Math.round((top[0].gross_minor / total) * 1000) / 10 : 0}% of product revenue.`
      : 'No products sold in this period yet.',
    why,
    cards: [
      { type: 'bars', title: 'Revenue by product', kind: 'money', items: top.slice(0, 8).map((p) => ({ label: p.name, value: p.gross_minor, compare: prev.get(p.name) ? prev.get(p.name).gross_minor : 0 })), compare_label: 'Before' },
      productTable(top, 'Products by revenue', { limit: 15 }),
    ],
    facts: { products: top.slice(0, 8).map((p) => ({ name: p.name, revenue: money(p.gross_minor), qty: p.qty, before: prev.get(p.name) ? money(prev.get(p.name).gross_minor) : null })), product_revenue: money(total) },
    records: 'products',
  };
}

function profitAnswer(d) {
  const pr = E.profit(d.products);
  const prBefore = E.profit(d.productsBefore || []);
  const costed = d.products.filter((p) => p.gp_minor != null).sort((a, b) => b.gp_minor - a.gp_minor);
  const why = [];
  if (costed[0]) why.push(`${costed[0].name} earns the most: ${money(costed[0].gp_minor)} gross profit at ${costed[0].margin_pct}%.`);
  const lowMargin = costed.filter((p) => p.margin_pct != null && p.margin_pct < 40 && p.qty > 0).sort((a, b) => b.net_minor - a.net_minor)[0];
  if (lowMargin) why.push(`${lowMargin.name} sells well but keeps only ${lowMargin.margin_pct}% (${money(lowMargin.gp_minor)} on ${money(lowMargin.net_minor)} net).`);
  if (pr.uncosted_count) why.push(`${pr.uncosted_count} products with no cost price (${money(pr.uncosted_net_minor)} net sales) are left out of profit.`);
  return {
    title: 'Profit',
    headline: pr.net_minor
      ? `Gross profit ${money(pr.gp_minor)} on ${money(pr.net_minor)} net sales: a ${pr.margin_pct}% margin${prBefore.margin_pct != null ? `, against ${prBefore.margin_pct}% before` : ''}.`
      : 'None of the products sold in this period has a cost price yet, so profit cannot be worked out. Add cost prices in the back office (Products).',
    why,
    cards: [
      { type: 'kpis', items: [
        kpi('Gross profit', pr.gp_minor, 'money', E.change(pr.gp_minor, prBefore.gp_minor)),
        kpi('Margin', pr.margin_pct, 'pct', pr.margin_pct != null && prBefore.margin_pct != null ? Math.round((pr.margin_pct - prBefore.margin_pct) * 10) / 10 : null),
        kpi('Net sales (costed)', pr.net_minor, 'money', E.change(pr.net_minor, prBefore.net_minor)),
        kpi('Not costed', pr.uncosted_share_pct, 'pct', null, 'down'),
      ] },
      { type: 'bars', title: 'Gross profit by product', kind: 'money', items: costed.slice(0, 8).map((p) => ({ label: p.name, value: p.gp_minor })) },
      productTable(costed, 'Most profitable products', { profit: true, limit: 15 }),
    ],
    facts: { gross_profit: money(pr.gp_minor), net_sales: money(pr.net_minor), margin_pct: pr.margin_pct, margin_before_pct: prBefore.margin_pct, uncosted_count: pr.uncosted_count, uncosted_sales: money(pr.uncosted_net_minor), top: costed.slice(0, 5).map((p) => ({ name: p.name, gross_profit: money(p.gp_minor), margin_pct: p.margin_pct })) },
    profit: pr,
    records: 'products',
  };
}

function lossAnswer(d) {
  const pr = E.profit(d.products);
  const losers = d.products.filter((p) => p.gp_minor != null && p.gp_minor < 0).sort((a, b) => a.gp_minor - b.gp_minor);
  const thin = d.products.filter((p) => p.margin_pct != null && p.margin_pct >= 0 && p.margin_pct < 20).sort((a, b) => a.margin_pct - b.margin_pct);
  return {
    title: 'Loss-making products',
    headline: losers.length
      ? `${losers.length} product${losers.length === 1 ? ' is' : 's are'} selling below cost, losing ${money(-losers.reduce((s, p) => s + p.gp_minor, 0))} in total.`
      : `No costed product sold below cost.${pr.uncosted_count ? ` ${pr.uncosted_count} products have no cost price, so they could not be checked.` : ''}`,
    why: [
      ...losers.slice(0, 3).map((p) => `${p.name}: net ${money(p.net_minor)}, cost ${money(p.cost_minor)}, so ${money(-p.gp_minor)} lost on ${p.qty} sold.`),
      ...thin.slice(0, 2).map((p) => `${p.name} only keeps ${p.margin_pct}%.`),
    ],
    cards: [
      productTable(losers, 'Selling below cost', { profit: true }),
      ...(thin.length ? [productTable(thin, 'Thin margins (under 20%)', { profit: true })] : []),
    ],
    facts: { losers: losers.slice(0, 6).map((p) => ({ name: p.name, net: money(p.net_minor), cost: money(p.cost_minor), lost: money(-p.gp_minor), qty: p.qty })), thin: thin.slice(0, 4).map((p) => ({ name: p.name, margin_pct: p.margin_pct })), uncosted_count: pr.uncosted_count },
    records: 'products',
  };
}

function stockTable(items, title) {
  return {
    type: 'table',
    title,
    columns: [
      { key: 'name', label: 'Product', kind: 'text' },
      { key: 'stock', label: 'In stock', kind: 'count' },
      { key: 'per_day', label: 'Sold a day', kind: 'count' },
      { key: 'days_cover', label: 'Days left', kind: 'days' },
      { key: 'reorder_qty', label: 'Reorder', kind: 'count' },
    ],
    rows: items,
  };
}

function stockAnswer(d) {
  const s = d.stock;
  if (!s.tracked) {
    return {
      title: 'Stock',
      headline: 'No product has its stock counted yet, so there is nothing to forecast. Switch on stock for a product in the back office (Products, Stock) and Vesopa AI will start predicting when it runs out.',
      why: [],
      cards: [],
      facts: { tracked: 0 },
      records: 'stock',
    };
  }
  const urgent = [...s.out, ...s.critical, ...s.low];
  return {
    title: 'Stock to reorder',
    headline: urgent.length
      ? `${urgent.length} of ${s.tracked} counted products need attention: ${[s.out.length && `${s.out.length} out of stock`, s.critical.length && `${s.critical.length} with under 3 days left`, s.low.length && `${s.low.length} running low`].filter(Boolean).join(', ')}.`
      : `All ${s.tracked} counted products have at least a week of stock at their usual rate.`,
    why: urgent.slice(0, 4).map((i) => (i.status === 'out'
      ? `${i.name} is out of stock${i.per_day ? ` (usually ${i.per_day} a day)` : ''}.`
      : `${i.name}: ${i.stock} left, about ${i.per_day} a day, so roughly ${i.days_cover} days (around ${i.runs_out}).`)),
    cards: [
      { type: 'kpis', items: [kpi('Counted products', s.tracked, 'count'), kpi('Out of stock', s.out.length, 'count', null, 'down'), kpi('Under 3 days', s.critical.length, 'count', null, 'down'), kpi('To reorder', s.reorder.length, 'count', null, 'down')] },
      stockTable(s.reorder.slice(0, 20), `Suggested reorder (enough for ${s.target_days} days)`),
    ],
    facts: { tracked: s.tracked, out: s.out.length, critical: s.critical.length, low: s.low.length, target_days: s.target_days, items: urgent.slice(0, 8).map((i) => ({ name: i.name, stock: i.stock, per_day: i.per_day, days_cover: i.days_cover, runs_out: i.runs_out, reorder: i.reorder_qty })) },
    records: 'stock',
  };
}

function moversAnswer(d) {
  const s = d.stock;
  return {
    title: 'Fast and slow movers',
    headline: s.tracked
      ? `${s.fast[0] ? `${s.fast[0].name} moves fastest at ${s.fast[0].per_day} a day. ` : ''}${s.slow.length} counted product${s.slow.length === 1 ? ' has' : 's have'} not sold in 28 days.`
      : 'No product has its stock counted yet. Switch on stock in the back office to see what is moving.',
    why: s.slow.slice(0, 3).map((i) => `${i.name}: ${i.stock} on the shelf, none sold in 28 days${i.value_minor ? ` (about ${money(i.value_minor)} at cost)` : ''}.`),
    cards: [
      stockTable(s.fast, 'Fast movers (last 28 days)'),
      { type: 'table', title: 'Not moving (no sales in 28 days)', columns: [{ key: 'name', label: 'Product', kind: 'text' }, { key: 'stock', label: 'In stock', kind: 'count' }, { key: 'value_minor', label: 'Value at cost', kind: 'money' }], rows: s.slow },
    ],
    facts: { fast: s.fast.slice(0, 5).map((i) => ({ name: i.name, per_day: i.per_day })), slow: s.slow.slice(0, 5).map((i) => ({ name: i.name, stock: i.stock, value: i.value_minor != null ? money(i.value_minor) : null })) },
    records: 'stock',
  };
}

function staffAnswer(d) {
  const rows = E.staffTable(d.staff, d.staffBefore);
  return {
    title: 'Team performance',
    headline: rows.length
      ? `${rows[0].name} took the most: ${money(rows[0].gross_minor)} from ${rows[0].sales} sales (${rows[0].share_pct}% of the total).`
      : 'No sales with a member of staff on them in this period.',
    why: rows.slice(0, 4).map((r) => `${r.name}: ${money(r.gross_minor)}, ${r.sales} sales, average ${money(r.average_minor)}${trend(r.change_pct)}.`),
    cards: [
      { type: 'bars', title: 'Revenue by member of staff', kind: 'money', items: rows.slice(0, 10).map((r) => ({ label: r.name, value: r.gross_minor })) },
      { type: 'table', title: 'Sales by employee', columns: [{ key: 'name', label: 'Staff', kind: 'text' }, { key: 'sales', label: 'Sales', kind: 'count' }, { key: 'gross_minor', label: 'Revenue', kind: 'money' }, { key: 'average_minor', label: 'Average', kind: 'money' }, { key: 'discount_minor', label: 'Discounts', kind: 'money' }, { key: 'change_pct', label: 'Change', kind: 'pct' }], rows },
    ],
    facts: { staff: rows.slice(0, 10).map((r) => ({ name: r.name, revenue: money(r.gross_minor), sales: r.sales, average: money(r.average_minor), discounts: money(r.discount_minor), share_pct: r.share_pct, change_pct: r.change_pct })) },
    staffRows: rows,
    records: 'staff',
  };
}

function branchesAnswer(d) {
  const bySite = d.sites.length > 1 || (d.sites[0] && d.sites[0].site_id != null);
  const rows = bySite ? d.sites : d.tills;
  const prevRows = bySite ? d.sitesBefore : d.tillsBefore;
  const what = bySite ? 'site' : 'till';
  const table = E.staffTable(rows, prevRows);
  return {
    title: bySite ? 'Branches' : 'Tills',
    headline: !table.length
      ? 'No sales in this period.'
      : `${bySite ? '' : 'No sites are set up, so here are your tills. '}${table[0].name} performed best: ${money(table[0].gross_minor)} from ${table[0].sales} sales${trend(table[0].change_pct)}.`,
    why: table.slice(0, 4).map((r) => `${r.name}: ${money(r.gross_minor)} (${r.share_pct}%), average spend ${money(r.average_minor)}.`),
    cards: [
      { type: 'bars', title: `Revenue by ${what}`, kind: 'money', items: table.map((r) => ({ label: r.name, value: r.gross_minor })) },
      { type: 'table', title: `Performance by ${what}`, columns: [{ key: 'name', label: bySite ? 'Site' : 'Till', kind: 'text' }, { key: 'sales', label: 'Sales', kind: 'count' }, { key: 'gross_minor', label: 'Revenue', kind: 'money' }, { key: 'average_minor', label: 'Average', kind: 'money' }, { key: 'change_pct', label: 'Change', kind: 'pct' }], rows: table },
    ],
    facts: { by: what, rows: table.slice(0, 10).map((r) => ({ name: r.name, revenue: money(r.gross_minor), sales: r.sales, share_pct: r.share_pct, change_pct: r.change_pct })) },
    records: 'orders',
  };
}

function hoursAnswer(d, ctx) {
  const hours = [...(d.hours || [])].sort((a, b) => (Number(b.gross_minor) || 0) - (Number(a.gross_minor) || 0));
  const quiet = [...(d.hours || [])].filter((h) => Number(h.sales) > 0).sort((a, b) => (Number(a.gross_minor) || 0) - (Number(b.gross_minor) || 0));
  return {
    title: 'Busiest hours',
    headline: hours[0] ? `Your busiest hour is ${E.hourLabel(Number(hours[0].hour))}: ${money(hours[0].gross_minor)} from ${hours[0].sales} sales.` : 'No sales in this period.',
    why: [
      ...hours.slice(1, 3).map((h) => `${E.hourLabel(Number(h.hour))}: ${money(h.gross_minor)} from ${h.sales} sales.`),
      ...(quiet[0] && quiet[0] !== hours[0] ? [`Quietest trading hour: ${E.hourLabel(Number(quiet[0].hour))} (${money(quiet[0].gross_minor)}).`] : []),
    ],
    cards: [{ ...trendCard({ ...d, days: [] }, { ...ctx, period: { ...ctx.period, key: 'today' } }), title: 'Revenue by hour' }],
    facts: { hours: hours.slice(0, 6).map((h) => ({ hour: E.hourLabel(Number(h.hour)), revenue: money(h.gross_minor), sales: Number(h.sales) })) },
    records: 'orders',
  };
}

function focusAnswer(d, ctx) {
  const why = whyAnswer(d, ctx);
  const staff = E.staffTable(d.staff, d.staffBefore);
  const { alerts, actions } = E.alertsAndActions({
    now: d.now, before: d.before, explain: why.explain, stock: d.stock, profitNow: E.profit(d.products), productRows: d.products, staff, hours: d.hours,
  });
  return {
    title: 'What to focus on',
    headline: actions.length
      ? `${actions.length} thing${actions.length === 1 ? '' : 's'} worth your attention, starting with: ${lc(actions[0].title)}.`
      : 'Nothing stands out: sales, stock and margins all look steady.',
    why: alerts.map((a) => `${a.title}. ${a.detail}`).slice(0, 4),
    next: actions.map((a) => ({ title: a.title, why: a.why, action: a.action })),
    cards: [salesKpis(d.now, d.before), ...(alerts.length ? [{ type: 'alerts', items: alerts }] : [])],
    facts: { revenue: money(d.now.revenue_minor), revenue_before: money(d.before.revenue_minor), change_pct: E.change(d.now.revenue_minor, d.before.revenue_minor), alerts, actions },
    records: 'orders',
  };
}

const BUILDERS = {
  summary: summaryAnswer,
  why_change: whyAnswer,
  top_products: topProductsAnswer,
  profit: profitAnswer,
  loss_makers: lossAnswer,
  stock: stockAnswer,
  stock_movers: moversAnswer,
  staff: staffAnswer,
  branches: branchesAnswer,
  hours: hoursAnswer,
  focus: focusAnswer,
};

/** What each kind of answer needs fetched: the caller fetches no more than this. */
const NEEDS = {
  summary: ['totals', 'hours', 'days', 'products'],
  why_change: ['totals', 'hours', 'products', 'staff', 'sites'],
  top_products: ['totals', 'products'],
  profit: ['totals', 'products'],
  loss_makers: ['totals', 'products'],
  stock: ['stock'],
  stock_movers: ['stock'],
  staff: ['totals', 'staff'],
  branches: ['totals', 'sites'],
  hours: ['totals', 'hours'],
  focus: ['totals', 'hours', 'products', 'staff', 'sites', 'stock'],
};

/** The words under every answer: what each figure means. */
const DEFINITIONS = {
  summary: ['Revenue: what customers paid on closed sales, VAT included, after discounts (as the Z report counts it).', 'Sales: closed bills.', 'Average spend: revenue divided by sales.'],
  why_change: ['Revenue: closed sales, VAT included, after discounts.', 'Number of sales effect: the change in sales at last period\'s average spend. Spend per sale effect: the rest. The two add up to the difference.'],
  top_products: ['Product revenue: price charged x quantity, less line discounts, VAT included. Modifiers are counted in the product they belong to.'],
  profit: ['Net sales: product revenue with VAT taken out.', 'Gross profit: net sales minus cost (quantity x the product\'s cost price today).', 'Margin: gross profit / net sales. Products with no cost price are left out and shown as "Not costed".'],
  loss_makers: ['Selling below cost: net sales (VAT out) lower than quantity x cost price.'],
  stock: ['Days left: stock now / average sold a day over the last 28 days, all sites.', 'Reorder: enough for 14 days at that rate, less stock on hand. Supplier lead times are not held yet, so allow for delivery.'],
  stock_movers: ['Fast movers: most sold a day over the last 28 days. Not moving: counted stock with no sales in 28 days.'],
  staff: ['Revenue by staff: closed sales under the name of the member of staff who closed them, VAT included.'],
  branches: ['Revenue by site: closed sales from the tills grouped into each site in the back office (Sites).'],
  hours: ['Revenue by hour: closed sales by the hour the bill was closed.'],
  focus: ['Built from sales, products, staff and stock for the period, compared with the period before. Suggestions only: Vesopa AI never changes anything itself.'],
};

module.exports = { BUILDERS, NEEDS, DEFINITIONS };
