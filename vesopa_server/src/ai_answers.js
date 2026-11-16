/**
 * Vesopa AI: from a question to an answer built only of the venue's figures.
 *
 *   parseQuestion()  what is being asked: the subject (takings, why it
 *                    changed, products, profit, stock, staff, sites, what to
 *                    focus on tomorrow), the period, what to compare it with,
 *                    and the site. Plain rules first, so the common questions
 *                    are answered instantly and with no model at all; a
 *                    question the rules cannot place goes to the model to
 *                    classify (ai_explain.js), which only ever picks from the
 *                    same list.
 *
 *   answer()         runs the figures (ai_metrics.js) and returns:
 *                      facts     every number, labelled, with its unit
 *                      charts    what to draw, from those facts only
 *                      headline / why / next   a plain-English reading,
 *                                written from the facts by rules, which the
 *                                model may rewrite (ai_explain.js) but never
 *                                with a number that is not in `facts`
 *                      meta      period, site, definition, data freshness
 *                      records   how to open the rows behind the answer
 *                      follow_ups  the questions worth asking next
 *
 * Read-only. Nothing in here writes to a venue's records; a recommendation
 * that would (order stock, change a price) says where to do it, and a person
 * does it there.
 */
'use strict';

const M = require('./ai_metrics');

const { money, pct } = M;

/** 'The Sunday before (Sun 8 Nov)' -> 'the Sunday before (Sun 8 Nov)': only the first letter. */
const lower = (t) => {
  const x = String(t || '');
  if (/^Last \d+ days/.test(x)) return 'the l' + x.slice(1);
  return x.charAt(0).toLowerCase() + x.slice(1);
};
/** '1 bill', '6 bills'. */
const bills = (n) => `${n} bill${Number(n) === 1 ? '' : 's'}`;
/** Stock as a person says it: never "-10 in stock". */
const inStock = (n) => (n > 0 ? `${n} in stock` : n === 0 ? 'none in stock' : `none in stock, the count shows ${n}`);
/** A void with no member of staff on it is not somebody called Unknown. */
const unnamed = (name) => !name || /^(Unknown|PIN )/.test(name);
/** A difference in words: 'down £132.00' / 'up £4.00'. */
const moved = (minor) => `${minor < 0 ? 'down' : 'up'} ${money(Math.abs(minor))}`;

// ---- the question --------------------------------------------------------------

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const INTENTS = ['briefing', 'takings', 'compare', 'products', 'profit', 'stock', 'staff', 'sites', 'focus'];

/** Every period named in the text, in the order they appear. */
function periodsIn(text, now) {
  const found = [];
  const add = (at, spec) => { if (at >= 0) found.push({ at, spec }); };
  const t = text;
  let m;
  add(t.search(/\b(today|so far|tonight|this (morning|afternoon|evening))\b/), { kind: 'today' });
  add(t.search(/\b(yesterday|last night)\b/), { kind: 'yesterday' });
  add(t.search(/\bthis week\b/), { kind: 'this_week' });
  add(t.search(/\b(last|previous|past) week\b/), { kind: 'last_week' });
  add(t.search(/\bthis month\b/), { kind: 'this_month' });
  add(t.search(/\b(last|previous) month\b/), { kind: 'last_month' });
  add(t.search(/\b(last|past) fortnight\b/), { kind: 'last_days', days: 14 });
  if ((m = /\b(?:last|past) (\d{1,3}) days?\b/.exec(t))) add(m.index, { kind: 'last_days', days: Number(m[1]) });
  if ((m = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(t))) add(m.index, { kind: 'day', date: `${m[1]}-${m[2]}-${m[3]}` });
  const year = new Date(now).getUTCFullYear();
  if ((m = /\b(\d{1,2})(?:st|nd|rd|th)? (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/.exec(t))) {
    const mon = MONTHS.indexOf(m[2]);
    let ms = Date.UTC(year, mon, Number(m[1]));
    if (ms > now) ms = Date.UTC(year - 1, mon, Number(m[1]));
    add(m.index, { kind: 'day', date: M.naive(ms).slice(0, 10) });
  }
  if ((m = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/.exec(t))) {
    const y = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : year;
    let ms = Date.UTC(y, Number(m[2]) - 1, Number(m[1]));
    if (!m[3] && ms > now) ms = Date.UTC(y - 1, Number(m[2]) - 1, Number(m[1]));
    if (Number.isFinite(ms)) add(m.index, { kind: 'day', date: M.naive(ms).slice(0, 10) });
  }
  WEEKDAYS.forEach((d, i) => {
    const r = new RegExp(`\\b(?:last |on )?${d}s?\\b`);
    const x = r.exec(t);
    if (x) add(x.index, { kind: 'weekday', dow: i });
  });
  // "last week" also contains "week", "last night" contains "night": keep the
  // earliest spec at each position and drop specs that sit inside another.
  found.sort((a, b) => a.at - b.at);
  return found.filter((f, i) => i === 0 || f.at !== found[i - 1].at).map((f) => f.spec);
}

/** Which subject the words point at, or null. Order matters: most specific first. */
function intentIn(t) {
  if (/\b(tomorrow|focus|prepare|plan for|get ready|what should (i|we) (do|look at|watch))\b/.test(t)) return 'focus';
  if (/\b(stock|re-?order|order more|run(ning)? out|low on|stockouts?|inventory|slow[- ]mov\w*|fast[- ]mov\w*|dead stock|shelf|cellar|what should i (buy|order))\b/.test(t)) return 'stock';
  if (/\b(profit|margin|gp\b|gross profit|loss[- ]making|losing money|making money on|cost price|markup)\b/.test(t)) return 'profit';
  if (/\b(staff|team|employees?|clerks?|servers?|waiters?|waitress|bar ?staff|bartenders?|who sold|who took|sales by (person|employee)|voids?)\b/.test(t)) return 'staff';
  if (/\b(branch(es)?|sites?|locations?|venues?|shops?|stores?|outlets?)\b/.test(t)) return 'sites';
  if (/\b(why|reason|drop(ped)?|decrease[d]?|down|fell|fall(en)?|slump|quiet(er)?|worse|increase[d]?|rose|rise|up on|better|busier|compare[d]?|comparison|vs\.?|versus|against)\b/.test(t)) return 'compare';
  if (/\b(best[- ]?sell\w*|top (products?|items?|sellers?)|best products?|most popular|popular|sold (the )?most|worst[- ]?sell\w*|slowest sell\w*|what sold|what (are|were) (people|customers) (buying|ordering))\b/.test(t)) return 'products';
  if (/\b(how much|takings|revenue|turnover|sales|made|make|earn(ed|t)?|money|take)\b/.test(t)) return 'takings';
  if (/\b(how (are|is|did|were) (we|things|it|the (day|week|business))|summary|overview|brief(ing)?|update|catch me up|what happened)\b/.test(t)) return 'briefing';
  return null;
}

/**
 * The question in a form the figures can answer. [prev] is the conversation's
 * last understood question, so "and last week?" or "why?" keep the subject.
 */
function parseQuestion(question, { now, siteNames = [], prev = null } = {}) {
  const t = ` ${String(question || '').toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ')} `;
  let intent = intentIn(t);
  const periods = periodsIn(t, now);
  const followUp = !intent && prev && prev.intent;
  if (followUp) intent = prev.intent;
  // "Why?" on its own after any question about takings is "why did it change".
  if (/^\s*why\b/.test(t) && prev && ['takings', 'briefing'].includes(prev.intent)) intent = 'compare';

  let period = periods[0] || (prev && (followUp || intent === 'compare') ? prev.period : null);
  let compare = null;
  if (periods.length > 1 && /\b(compare|vs\.?|versus|against|with|to)\b/.test(t)) compare = periods[1];
  // Defaults that match how a venue talks: "why did sales drop" means the
  // last full day; "best sellers" a week; stock and focus ignore the period.
  if (!period) {
    if (intent === 'compare') period = { kind: 'yesterday' };
    else if (['products', 'profit', 'staff', 'sites'].includes(intent)) period = { kind: 'last_days', days: 7 };
    else period = { kind: 'today' };
  }
  let site = null;
  for (const s of siteNames) {
    if (s.name && t.includes(` ${s.name.toLowerCase()} `.trim())) { site = s.id; break; }
  }
  if (site == null && prev && followUp) site = prev.site ?? null;
  const direction = /\b(drop(ped)?|decrease[d]?|down|fell|fall(en)?|slump|quiet(er)?|worse|lower)\b/.test(t) ? 'down'
    : /\b(increase[d]?|rose|rise|up on|better|busier|higher|grew)\b/.test(t) ? 'up' : null;
  const order = /\b(worst|least|slow(est)?|bottom|lowest)\b/.test(t) ? 'asc' : 'desc';
  return { intent, period, compare, site, direction, order, understood: Boolean(intent) };
}

// ---- answering ---------------------------------------------------------------

/**
 * A fact the clients and the model may use. `display` is how a person reads it;
 * `value` the raw number (pence for money).
 */
function fact(id, label, value, unit) {
  const v = value == null ? null : Number(value);
  let display;
  if (v == null) display = 'not known';
  else if (unit === 'money') display = money(v);
  else if (unit === 'percent') display = `${v > 0 ? '+' : ''}${v}%`;
  else if (unit === 'pct') display = `${v}%`;
  else if (unit === 'days') display = `${v} days`;
  else display = Number.isInteger(v) ? v.toLocaleString('en-GB') : String(Math.round(v * 100) / 100);
  return { id, label, value: v, unit, display };
}

const hourLabel = (h) => `${String(h).padStart(2, '0')}:00`;

/**
 * The ctx every answer is built with:
 *   { pool, office, now, map, allowed, site, can: { profit, staff } }
 */
async function answer(q, ctx) {
  const p = M.resolvePeriod(q.period, ctx.now);
  let c = q.compare ? M.resolvePeriod(q.compare, ctx.now) : M.comparisonFor(p);
  // "This week against last week" on a Monday afternoon is Monday to now
  // against last Monday to the same time, never against all of last week.
  if (q.compare && p.partial && !c.partial && c.toMs - c.fromMs > p.toMs - p.fromMs) {
    c = M.periodOf(c.key, `${c.label.replace(/\s*\(.*$/, '')} to the same point (${M.dayText(c.fromMs)} to ${M.dayText(c.fromMs + (p.toMs - p.fromMs))} ${M.timeText(c.fromMs + (p.toMs - p.fromMs))})`, c.fromMs, c.fromMs + (p.toMs - p.fromMs), true);
  }
  const f = M.siteFilter(ctx.map, { allowed: ctx.allowed, site: q.site ?? ctx.site });
  const base = { pool: ctx.pool, office: ctx.office, f, p, c, q, ctx };
  const a = await route(q, base, ctx);
  if (a.meta && a.meta.from && !a.meta.last_sale && a.intent !== 'stock') {
    const [[r]] = await ctx.pool.query(
      `SELECT MAX(o.closed_at) AS last_sale FROM epos_orders o
        WHERE o.email = ? AND o.closed_at IS NOT NULL AND o.closed_at >= ? AND o.closed_at < ?${f.sql}`,
      [ctx.office, a.meta.from, a.meta.to, ...f.params]);
    const last = r && r.last_sale ? M.naive(M.wallMs(r.last_sale)) : null;
    a.meta.last_sale = last;
    a.meta.freshness = last ? `Latest sale in this period: ${last.slice(0, 16)}` : 'No sales in this period';
  }
  return a;
}

function route(q, base, ctx) {
  switch (q.intent) {
    case 'takings': return takings(base);
    case 'compare': return compare(base);
    case 'products': return products(base);
    case 'profit':
      if (!ctx.can.profit) return refused('profit', 'Profit figures are not shared with you. Ask the owner to tick Profit on your Vesopa AI invite.');
      return profit(base);
    case 'stock': return stockAnswer(base);
    case 'staff':
      if (!ctx.can.staff) return refused('staff', 'Staff figures are not shared with you. Ask the owner to tick Staff on your Vesopa AI invite.');
      return staff(base);
    case 'sites': return sites(base);
    case 'focus': return focus(base);
    case 'briefing': return briefing(base);
    default: return help(ctx);
  }
}

function refused(intent, message) {
  return { intent, headline: 'Not available to you', summary: message, why: [], next: [], facts: [], charts: [], records: [], follow_ups: ['How much did we make today?'], meta: null };
}

function help() {
  return {
    intent: 'help',
    headline: 'I can answer questions about your sales, products, profit, stock, staff and sites.',
    summary: 'Try one of the questions below, or ask in your own words, for example "How did Saturday compare with the Saturday before?"',
    why: [], next: [], facts: [], charts: [], records: [], meta: null,
    follow_ups: ['How much did we make today?', 'Why did sales drop yesterday?', 'What stock should I reorder?', 'Which products make the most profit?', 'How is my team doing this week?', 'What should I focus on tomorrow?'],
  };
}

async function takings({ pool, office, f, p, c }) {
  const [now, before, hours, hoursBefore] = await Promise.all([
    M.summary(pool, office, f, p), M.summary(pool, office, f, c),
    M.byHour(pool, office, f, p), M.byHour(pool, office, f, c),
  ]);
  const change = pct(now.takings_minor, before.takings_minor);
  const facts = [
    fact('takings', 'Takings', now.takings_minor, 'money'),
    fact('takings_before', `Takings, ${c.label}`, before.takings_minor, 'money'),
    fact('takings_change', 'Change in takings', change, 'percent'),
    fact('bills', 'Bills closed', now.sales, 'count'),
    fact('bills_before', `Bills closed, ${c.label}`, before.sales, 'count'),
    fact('average', 'Average spend per bill', now.average_minor, 'money'),
    fact('average_before', `Average spend, ${c.label}`, before.average_minor, 'money'),
    fact('net', 'Takings without VAT', now.net_minor, 'money'),
    fact('discounts', 'Discounts given', now.discount_minor, 'money'),
  ];
  if (now.covers) facts.push(fact('covers', 'Covers', now.covers, 'count'));
  const best = [...hours].sort((a, b) => b.takings_minor - a.takings_minor)[0];
  if (best) facts.push(fact('best_hour_takings', `Busiest hour (${hourLabel(best.hour)})`, best.takings_minor, 'money'));
  const headline = now.sales
    ? `${money(now.takings_minor)} from ${bills(now.sales)}${change == null ? '' : `, ${change >= 0 ? 'up' : 'down'} ${Math.abs(change)}% on ${lower(c.label)}`}.`
    : `No sales yet in ${lower(p.label)}.`;
  const why = [];
  if (now.sales && before.sales) {
    why.push(`Average spend was ${money(now.average_minor)} against ${money(before.average_minor)}, from ${bills(now.sales)} against ${before.sales}.`);
  }
  if (best) why.push(`The busiest hour was ${hourLabel(best.hour)} with ${money(best.takings_minor)}.`);
  const next = [];
  if (change != null && change < -10) next.push('Ask "why did sales drop" to see which hours, products and staff made the difference.');
  return {
    intent: 'takings',
    headline, summary: headline, why, next, facts,
    charts: [hourPair(hours, hoursBefore, `Takings by hour, ${p.label} against ${c.label}`)],
    meta: M.meta(p, f, M.DEF.takings, now.last_sale, { compare: c.label }),
    records: [{ kind: 'bills', label: `Bills in ${p.label}`, from: p.from, to: p.to }],
    follow_ups: [change != null && change < 0 ? 'Why did sales drop?' : 'Why did sales go up?', 'What were the best sellers?', 'How is the team doing?', 'Compare this week with last week'],
  };
}

function hourPair(hours, before, title) {
  const span = [...hours, ...before].map((h) => h.hour);
  if (!span.length) return { type: 'pair', title, unit: 'money', rows: [] };
  const lo = Math.min(...span);
  const hi = Math.max(...span);
  const rows = [];
  for (let h = lo; h <= hi; h++) {
    rows.push({
      label: hourLabel(h),
      value: (hours.find((x) => x.hour === h) || {}).takings_minor || 0,
      compare: (before.find((x) => x.hour === h) || {}).takings_minor || 0,
    });
  }
  return { type: 'pair', title, unit: 'money', rows, legend: ['This period', 'Compared with'] };
}

/**
 * Why takings moved, worked out rather than guessed:
 *   1. The change splits exactly into fewer/more bills and lower/higher spend:
 *      (bills now - bills before) x spend before  +  (spend now - spend before) x bills now.
 *   2. The hours, products, staff and sites whose takings moved the most.
 *   3. Voids and discounts against the period before.
 *   4. Products that sold before, sold nothing now and have no stock: a
 *      likely stockout rather than a change in demand.
 */
async function compare({ pool, office, f, p, c, q, ctx }) {
  const [now, before, hours, hoursBefore, prods, prodsBefore, clerks, clerksBefore, v, vBefore] = await Promise.all([
    M.summary(pool, office, f, p), M.summary(pool, office, f, c),
    M.byHour(pool, office, f, p), M.byHour(pool, office, f, c),
    M.byProduct(pool, office, f, p), M.byProduct(pool, office, f, c),
    ctx.can.staff ? M.byClerk(pool, office, f, p) : [], ctx.can.staff ? M.byClerk(pool, office, f, c) : [],
    M.voids(pool, office, f, p), M.voids(pool, office, f, c),
  ]);
  const delta = now.takings_minor - before.takings_minor;
  const change = pct(now.takings_minor, before.takings_minor);
  const billsEffect = (now.sales - before.sales) * before.average_minor;
  const spendEffect = delta - billsEffect;
  const facts = [
    fact('takings', `Takings, ${p.label}`, now.takings_minor, 'money'),
    fact('takings_before', `Takings, ${c.label}`, before.takings_minor, 'money'),
    fact('takings_delta', 'Difference', delta, 'money'),
    fact('takings_change', 'Change', change, 'percent'),
    fact('bills', `Bills, ${p.label}`, now.sales, 'count'),
    fact('bills_before', `Bills, ${c.label}`, before.sales, 'count'),
    fact('average', `Average spend, ${p.label}`, now.average_minor, 'money'),
    fact('average_before', `Average spend, ${c.label}`, before.average_minor, 'money'),
    fact('bills_effect', 'Part of the difference from the number of bills', billsEffect, 'money'),
    fact('spend_effect', 'Part of the difference from spend per bill', spendEffect, 'money'),
  ];

  const why = [];
  const drivers = [];
  if (!now.sales && !before.sales) {
    return { ...emptyAnswer('compare', p, c, f), follow_ups: ['How much did we make last week?'] };
  }
  const main = Math.abs(billsEffect) >= Math.abs(spendEffect) ? 'bills' : 'spend';
  if (delta !== 0 && before.sales) {
    why.push(main === 'bills'
      ? `Mostly ${now.sales < before.sales ? 'fewer' : 'more'} customers: ${bills(now.sales)} against ${before.sales}, which moved takings ${moved(billsEffect)}. Spend per bill (${money(now.average_minor)} against ${money(before.average_minor)}) moved them ${moved(spendEffect)}.`
      : `Mostly spend per bill: ${money(now.average_minor)} against ${money(before.average_minor)}, which moved takings ${moved(spendEffect)}. The number of bills (${now.sales} against ${before.sales}) moved them ${moved(billsEffect)}.`);
  }

  // Hours.
  const hourMoves = mergeMoves(hours, hoursBefore, (h) => h.hour, (h) => h.takings_minor);
  const worstHours = hourMoves.filter((h) => Math.sign(h.delta) === Math.sign(delta || -1) && h.delta !== 0).slice(0, 3);
  worstHours.forEach((h, i) => {
    facts.push(fact(`hour_${i}`, `${hourLabel(h.key)} difference`, h.delta, 'money'));
    drivers.push({ label: `${hourLabel(h.key)} to ${hourLabel(h.key + 1)}`, delta_minor: h.delta, kind: 'hour' });
  });
  if (worstHours.length) {
    why.push(`The ${delta < 0 ? 'quietest' : 'strongest'} change was ${worstHours.map((h) => `${hourLabel(h.key)} (${money(h.delta)})`).join(', ')}.`);
  }

  // Products.
  const prodMoves = mergeMoves(prods, prodsBefore, (x) => x.name, (x) => x.takings_minor);
  const prodDown = prodMoves.filter((x) => x.delta < 0).slice(0, 3);
  const prodUp = [...prodMoves].reverse().filter((x) => x.delta > 0).slice(0, 3);
  const lead = delta < 0 ? prodDown : prodUp;
  lead.forEach((x, i) => {
    facts.push(fact(`product_${i}`, `${x.key} difference`, x.delta, 'money'));
    drivers.push({ label: x.key, delta_minor: x.delta, kind: 'product' });
  });
  if (lead.length) {
    why.push(`${delta < 0 ? 'Products down the most' : 'Products up the most'}: ${lead.map((x) => `${x.key} (${money(x.delta)})`).join(', ')}.`);
  }

  // Possible stockouts: sold before, nothing now, nothing on the shelf.
  let stockouts = [];
  if (delta < 0) {
    const zero = prodsBefore.filter((b) => b.qty > 0 && !prods.some((x) => x.name === b.name && x.qty > 0)).map((b) => b.plu).filter((x) => x != null);
    if (zero.length) {
      const stock = await M.stock(pool, office, f, ctx.now);
      stockouts = stock.filter((s) => zero.includes(s.plu) && s.stock <= 0);
      stockouts.slice(0, 3).forEach((s, i) => facts.push(fact(`stockout_${i}`, `${s.name} stock now`, s.stock, 'count')));
      if (stockouts.length) why.push(`${stockouts.slice(0, 3).map((s) => s.name).join(', ')} sold ${lower(c.label).startsWith('the') ? 'in ' + lower(c.label) : 'before'}, sold nothing this time and now show no stock, so they may have run out rather than lost demand.`);
    }
  }

  // Staff.
  if (ctx.can.staff && clerks.length + clerksBefore.length) {
    const staffMoves = mergeMoves(clerks, clerksBefore, (x) => x.clerk, (x) => x.takings_minor);
    const s = (delta < 0 ? staffMoves.filter((x) => x.delta < 0) : [...staffMoves].reverse().filter((x) => x.delta > 0)).slice(0, 2);
    s.forEach((x, i) => facts.push(fact(`staff_${i}`, `${x.key} difference`, x.delta, 'money')));
    if (s.length) why.push(`By member of staff: ${s.map((x) => `${x.key} (${money(x.delta)})`).join(', ')}. This often follows who was on shift rather than how well they sold.`);
  }

  // Voids and discounts.
  const voidNow = v.reduce((a, r) => a + r.total_minor, 0);
  const voidBefore = vBefore.reduce((a, r) => a + r.total_minor, 0);
  facts.push(fact('voids', `Voids, ${p.label}`, voidNow, 'money'), fact('voids_before', `Voids, ${c.label}`, voidBefore, 'money'));
  if (voidNow > voidBefore + 1000 && voidNow > Math.abs(delta) * 0.1) why.push(`Voids rose to ${money(voidNow)} from ${money(voidBefore)}.`);
  facts.push(fact('discounts', `Discounts, ${p.label}`, now.discount_minor, 'money'), fact('discounts_before', `Discounts, ${c.label}`, before.discount_minor, 'money'));
  if (now.discount_minor > before.discount_minor + 1000) why.push(`Discounts rose to ${money(now.discount_minor)} from ${money(before.discount_minor)}.`);

  const next = [];
  if (stockouts.length) next.push(`Check stock of ${stockouts.slice(0, 3).map((s) => s.name).join(', ')} and reorder in Stock Control, Orders & Deliveries.`);
  if (delta < 0 && main === 'bills') next.push(`Fewer customers came in. If ${worstHours[0] ? hourLabel(worstHours[0].key) : 'one time of day'} is often quiet, a promotion or a staffing change for that hour is worth trying.`);
  if (delta < 0 && main === 'spend') next.push('Spend per bill fell. A suggested add-on at the till (a side, a dessert, a larger size) is the usual way to win it back.');
  if (delta > 0) next.push('Find what drove the rise (an event, the weather, a promotion) and plan to repeat it.');

  const headline = delta === 0
    ? `Takings were the same as ${lower(c.label)}.`
    : `Takings were ${money(Math.abs(delta))} ${delta < 0 ? 'lower' : 'higher'}${change == null ? '' : ` (${change > 0 ? '+' : ''}${change}%)`}: ${money(now.takings_minor)} against ${money(before.takings_minor)}.`;
  const charts = [hourPair(hours, hoursBefore, `Takings by hour, ${p.label} against ${c.label}`)];
  if (drivers.filter((d) => d.kind === 'product').length) {
    charts.push({ type: 'diverging', title: 'Products that moved the most', unit: 'money', rows: [...prodDown, ...prodUp].slice(0, 6).map((x) => ({ label: x.key, value: x.delta })) });
  }
  return {
    intent: 'compare', headline, summary: headline, why, next, facts, charts,
    meta: M.meta(p, f, `${M.DEF.takings} Compared with ${c.label}.`, now.last_sale, { compare: c.label, compare_from: c.from, compare_to: c.to }),
    records: [
      { kind: 'bills', label: `Bills in ${p.label}`, from: p.from, to: p.to },
      { kind: 'bills', label: `Bills in ${c.label}`, from: c.from, to: c.to },
      { kind: 'lines', label: `Products sold in ${p.label}`, from: p.from, to: p.to },
    ],
    follow_ups: ['What were the best sellers?', 'What stock should I reorder?', 'How is the team doing?', 'What should I focus on tomorrow?'],
  };
}

function mergeMoves(now, before, keyOf, valueOf) {
  const map = new Map();
  for (const x of before) map.set(keyOf(x), { key: keyOf(x), now: 0, before: valueOf(x) });
  for (const x of now) {
    const k = keyOf(x);
    const e = map.get(k) || { key: k, now: 0, before: 0 };
    e.now += valueOf(x);
    map.set(k, e);
  }
  return [...map.values()].map((e) => ({ ...e, delta: e.now - e.before })).sort((a, b) => a.delta - b.delta);
}

function emptyAnswer(intent, p, c, f) {
  return {
    intent, headline: `No sales in ${lower(p.label)}${c ? ` or ${lower(c.label)}` : ''}.`,
    summary: 'There is nothing to compare yet.', why: [], next: [], facts: [], charts: [], records: [],
    meta: M.meta(p, f, M.DEF.takings, null), follow_ups: [],
  };
}

async function products({ pool, office, f, p, q }) {
  const list = await M.byProduct(pool, office, f, p);
  const sold = list.filter((x) => x.qty > 0);
  const asc = q.order === 'asc';
  const byTakings = [...sold].sort((a, b) => asc ? a.takings_minor - b.takings_minor : b.takings_minor - a.takings_minor).slice(0, 10);
  const total = sold.reduce((a, x) => a + x.takings_minor, 0);
  const facts = [fact('product_takings', 'Product takings', total, 'money'), fact('products_sold', 'Different products sold', sold.length, 'count')];
  byTakings.forEach((x, i) => {
    facts.push(fact(`p${i}_takings`, `${x.name} takings`, x.takings_minor, 'money'), fact(`p${i}_qty`, `${x.name} quantity`, x.qty, 'count'));
  });
  const top3 = byTakings.slice(0, 3).reduce((a, x) => a + x.takings_minor, 0);
  const share = total ? Math.round((top3 / total) * 1000) / 10 : null;
  if (share != null && !asc) facts.push(fact('top3_share', 'Share of product takings from the top three', share, 'pct'));
  const head = byTakings[0];
  const headline = !head ? `Nothing sold in ${lower(p.label)}.`
    : asc ? `The slowest sellers in ${lower(p.label)} start with ${head.name} (${money(head.takings_minor)}).`
      : `${head.name} was the best seller in ${lower(p.label)}: ${money(head.takings_minor)} from ${head.qty} sold.`;
  const why = [];
  if (share != null && !asc && byTakings.length >= 3) why.push(`The top three made ${share}% of product takings.`);
  const next = asc
    ? ['Slow sellers take a key on the till and space in the cellar. Consider a promotion, a better spot on the screen, or taking them off.']
    : ['Keep the best sellers in stock and on the first page of the till screen. Ask "what stock should I reorder" to check.'];
  return {
    intent: 'products', headline, summary: headline, why, next, facts,
    charts: [{ type: 'ranked', title: asc ? 'Slowest sellers by takings' : 'Best sellers by takings', unit: 'money', rows: byTakings.map((x) => ({ label: x.name, value: x.takings_minor, meta: `${x.qty} sold` })) }],
    meta: M.meta(p, f, M.DEF.product, null),
    records: [{ kind: 'lines', label: `Products sold in ${p.label}`, from: p.from, to: p.to }],
    follow_ups: ['Which products make the most profit?', 'What stock should I reorder?', asc ? 'What were the best sellers?' : 'What are the slowest sellers?'],
  };
}

async function profit({ pool, office, f, p, c }) {
  const [list, before] = await Promise.all([M.byProduct(pool, office, f, p), M.byProduct(pool, office, f, c)]);
  const sold = list.filter((x) => x.qty > 0);
  const costed = sold.filter((x) => x.costed);
  const netAll = sold.reduce((a, x) => a + x.net_minor, 0);
  const netCosted = costed.reduce((a, x) => a + x.net_minor, 0);
  const gp = costed.reduce((a, x) => a + x.profit_minor, 0);
  const gpBefore = before.filter((x) => x.costed).reduce((a, x) => a + x.profit_minor, 0);
  const margin = netCosted > 0 ? Math.round((gp / netCosted) * 1000) / 10 : null;
  const coverage = netAll > 0 ? Math.round((netCosted / netAll) * 1000) / 10 : null;
  const best = [...costed].sort((a, b) => b.profit_minor - a.profit_minor).slice(0, 8);
  const losing = costed.filter((x) => x.profit_minor < 0).sort((a, b) => a.profit_minor - b.profit_minor).slice(0, 5);
  const thin = costed.filter((x) => x.margin_pct != null && x.margin_pct >= 0 && x.margin_pct < 30 && x.net_minor > 0).sort((a, b) => a.margin_pct - b.margin_pct).slice(0, 5);
  const uncosted = sold.filter((x) => !x.costed).sort((a, b) => b.takings_minor - a.takings_minor);
  const facts = [
    fact('gross_profit', 'Gross profit (products with a cost price)', gp, 'money'),
    fact('gross_profit_before', `Gross profit, ${c.label}`, gpBefore, 'money'),
    fact('gp_change', 'Change in gross profit', pct(gp, gpBefore), 'percent'),
    fact('margin', 'Gross margin', margin, 'pct'),
    fact('coverage', 'Share of takings (ex VAT) with a cost price', coverage, 'pct'),
    fact('uncosted', 'Products sold with no cost price', uncosted.length, 'count'),
  ];
  best.forEach((x, i) => facts.push(fact(`b${i}_profit`, `${x.name} gross profit`, x.profit_minor, 'money'), fact(`b${i}_margin`, `${x.name} margin`, x.margin_pct, 'pct')));
  losing.forEach((x, i) => facts.push(fact(`l${i}_profit`, `${x.name} gross profit`, x.profit_minor, 'money')));
  thin.forEach((x, i) => facts.push(fact(`t${i}_margin`, `${x.name} margin`, x.margin_pct, 'pct')));

  if (!costed.length) {
    return {
      intent: 'profit',
      headline: 'Profit cannot be worked out yet: none of the products sold have a cost price.',
      summary: 'Add cost prices in Catalogue, Products (the Cost price field), and Vesopa AI will show profit and margins from then on.',
      why: [], next: ['Add cost prices to your best sellers first: they decide most of the profit.'], facts, charts: [],
      meta: M.meta(p, f, M.DEF.profit, null, { notice: 'Missing integration data: no cost prices.' }),
      records: [{ kind: 'lines', label: `Products sold in ${p.label}`, from: p.from, to: p.to }],
      follow_ups: ['What were the best sellers?'],
    };
  }
  const headline = `Gross profit was ${money(gp)} at a ${margin}% margin, on the products that have a cost price.`;
  const why = [];
  if (best[0]) why.push(`${best[0].name} made the most profit: ${money(best[0].profit_minor)} at ${best[0].margin_pct}%.`);
  if (losing.length) why.push(`${losing.length} product${losing.length > 1 ? 's' : ''} sold at a loss: ${losing.map((x) => `${x.name} (${money(x.profit_minor)})`).join(', ')}.`);
  if (thin.length) why.push(`Thin margins (under 30%): ${thin.map((x) => `${x.name} (${x.margin_pct}%)`).join(', ')}.`);
  if (coverage != null && coverage < 90) why.push(`Only ${coverage}% of takings have a cost price, so the real profit is not fully known.`);
  const next = [];
  if (losing.length) next.push(`Check the price and cost of ${losing[0].name}: a cost price may be out of date, or it needs a price rise. Change it in Catalogue, Products.`);
  if (uncosted.length) next.push(`Add cost prices for ${uncosted.slice(0, 3).map((x) => x.name).join(', ')}${uncosted.length > 3 ? ` and ${uncosted.length - 3} more` : ''}.`);
  if (best[0]) next.push(`Promote high-margin products like ${best[0].name}: keep them on the first page of the till and suggest them at the table.`);
  return {
    intent: 'profit', headline, summary: headline, why, next, facts,
    charts: [{ type: 'ranked', title: 'Most profitable products', unit: 'money', rows: best.map((x) => ({ label: x.name, value: x.profit_minor, meta: `${x.margin_pct}% margin` })) },
      ...(losing.length ? [{ type: 'diverging', title: 'Sold at a loss', unit: 'money', rows: losing.map((x) => ({ label: x.name, value: x.profit_minor })) }] : [])],
    meta: M.meta(p, f, M.DEF.profit, null, { compare: c.label, coverage }),
    records: [{ kind: 'lines', label: `Products sold in ${p.label}, with cost`, from: p.from, to: p.to, cost: true }],
    follow_ups: ['Which products sell at a loss?', 'Compare profit with last week', 'What were the best sellers?'],
  };
}

async function stockAnswer({ pool, office, f, ctx }) {
  const list = await M.stock(pool, office, f, ctx.now);
  if (!list.length) {
    return {
      intent: 'stock', headline: 'No products have a stock count yet.',
      summary: 'Turn on stock for a product and enter a count in Stock Control, Stock Levels. Vesopa AI then predicts when it runs out and what to reorder.',
      why: [], next: [], facts: [], charts: [], records: [],
      meta: { period: `Last ${M.VELOCITY_DAYS} days of sales`, site: f.label, definition: M.DEF.stock, freshness: 'Stock counts as they are now', notice: 'Missing data: no stock counts.' },
      follow_ups: ['What were the best sellers?'],
    };
  }
  const out = list.filter((s) => s.stock <= 0 && s.sold_28d > 0).sort((a, b) => b.per_day - a.per_day);
  const soon = list.filter((s) => s.stock > 0 && s.days_cover != null && s.days_cover <= 7).sort((a, b) => a.days_cover - b.days_cover);
  const reorder = list.filter((s) => s.reorder_qty > 0).sort((a, b) => (a.days_cover ?? 0) - (b.days_cover ?? 0)).slice(0, 12);
  const fast = [...list].filter((s) => s.per_day > 0).sort((a, b) => b.per_day - a.per_day).slice(0, 5);
  const slow = list.filter((s) => s.stock > 0 && s.sold_28d === 0).sort((a, b) => (b.value_minor || 0) - (a.value_minor || 0));
  const slowValue = slow.reduce((a, s) => a + (s.value_minor || 0), 0);
  const facts = [
    fact('out', 'Out of stock and selling', out.length, 'count'),
    fact('soon', 'Running out within 7 days', soon.length, 'count'),
    fact('reorder', 'Products to reorder', reorder.length, 'count'),
    fact('slow', `Products in stock with no sales in ${M.VELOCITY_DAYS} days`, slow.length, 'count'),
    fact('slow_value', 'Value of that stock at cost', slowValue, 'money'),
  ];
  reorder.forEach((s, i) => facts.push(
    fact(`r${i}_stock`, `${s.name} in stock`, s.stock, 'count'),
    fact(`r${i}_rate`, `${s.name} sold per day`, s.per_day, 'count'),
    fact(`r${i}_cover`, `${s.name} days of cover`, s.days_cover, 'days'),
    fact(`r${i}_order`, `${s.name} suggested order`, s.reorder_qty, 'count')));
  const headline = out.length || soon.length
    ? `${out.length} selling product${out.length === 1 ? ' is' : 's are'} out of stock and ${soon.length} will run out within a week.`
    : `Nothing is predicted to run out this week. ${reorder.length} product${reorder.length === 1 ? '' : 's'} could be topped up to two weeks' cover.`;
  const why = [];
  if (out.length) why.push(`Out now: ${out.slice(0, 5).map((s) => `${s.name} (sells ${s.per_day} a day)`).join(', ')}.`);
  if (soon.length) why.push(`Running out: ${soon.slice(0, 5).map((s) => `${s.name} in ${s.days_cover} days (around ${M.dayText(M.parseNaive(s.stockout))})`).join(', ')}.`);
  if (fast.length) why.push(`Fastest movers: ${fast.map((s) => `${s.name} (${s.per_day} a day)`).join(', ')}.`);
  if (slow.length) why.push(`${slow.length} product${slow.length === 1 ? ' has' : 's have'} stock but no sales in ${M.VELOCITY_DAYS} days${slowValue ? `, ${money(slowValue)} at cost` : ''}: ${slow.slice(0, 4).map((s) => s.name).join(', ')}.`);
  const next = [];
  if (reorder.length) next.push('Place the suggested orders in Stock Control, Orders & Deliveries. Vesopa AI does not order anything itself: you check and approve every order.');
  if (slow.length) next.push(`Run a promotion on slow stock or stop buying it: ${slow.slice(0, 3).map((s) => s.name).join(', ')}.`);
  return {
    intent: 'stock', headline, summary: headline, why, next, facts,
    charts: [{ type: 'table', title: 'Suggested reorders', unit: 'count', columns: ['Product', 'In stock', 'Per day', 'Days left', 'Order'], rows: reorder.map((s) => ({ label: s.name, cells: [s.stock, s.per_day, s.days_cover ?? '—', s.reorder_qty] })) }],
    meta: { period: `Last ${M.VELOCITY_DAYS} days of sales, stock as counted now`, site: f.label, definition: M.DEF.stock, freshness: `Stock counts as they are now (${M.naive(ctx.now).slice(0, 16)})`, from: null, to: null },
    records: [{ kind: 'stock', label: 'Every product with a stock count' }],
    follow_ups: ['What are the slowest sellers?', 'Which products make the most profit?', 'What should I focus on tomorrow?'],
  };
}

async function staff({ pool, office, f, p, c }) {
  const [list, before, v] = await Promise.all([M.byClerk(pool, office, f, p), M.byClerk(pool, office, f, c), M.voids(pool, office, f, p)]);
  const rows = list.sort((a, b) => b.takings_minor - a.takings_minor);
  const facts = [fact('staff_count', 'Staff who closed bills', rows.length, 'count')];
  rows.slice(0, 10).forEach((x, i) => {
    const b = before.find((y) => y.clerk === x.clerk);
    const vd = v.find((y) => y.clerk === x.clerk);
    facts.push(
      fact(`s${i}_takings`, `${x.clerk} takings`, x.takings_minor, 'money'),
      fact(`s${i}_bills`, `${x.clerk} bills`, x.sales, 'count'),
      fact(`s${i}_average`, `${x.clerk} average spend`, x.average_minor, 'money'),
      fact(`s${i}_before`, `${x.clerk} takings, ${c.label}`, b ? b.takings_minor : 0, 'money'));
    if (vd) facts.push(fact(`s${i}_voids`, `${x.clerk} voids`, vd.total_minor, 'money'), fact(`s${i}_void_count`, `${x.clerk} void count`, vd.count, 'count'));
    if (x.discount_minor) facts.push(fact(`s${i}_discounts`, `${x.clerk} discounts`, x.discount_minor, 'money'));
  });
  if (!rows.length) return { ...emptyAnswer('staff', p, null, f), follow_ups: ['How much did we make last week?'] };
  const top = rows[0];
  const bestSpend = [...rows].filter((x) => x.sales >= 5).sort((a, b) => b.average_minor - a.average_minor)[0];
  const bigVoid = [...v].filter((x) => !unnamed(x.clerk)).sort((a, b) => b.total_minor - a.total_minor)[0];
  const anon = v.filter((x) => unnamed(x.clerk)).reduce((a, x) => ({ count: a.count + x.count, total: a.total + x.total_minor }), { count: 0, total: 0 });
  const headline = `${top.clerk} took the most in ${lower(p.label)}: ${money(top.takings_minor)} from ${bills(top.sales)}.`;
  const why = [];
  if (bestSpend) why.push(`Highest average spend (5 bills or more): ${bestSpend.clerk}, ${money(bestSpend.average_minor)} a bill.`);
  if (bigVoid && bigVoid.total_minor > 0) why.push(`Most voided: ${bigVoid.clerk}, ${bigVoid.count} void${bigVoid.count === 1 ? '' : 's'} worth ${money(bigVoid.total_minor)}.`);
  if (anon.count) {
    facts.push(fact('anon_voids', 'Voids with no member of staff recorded', anon.total, 'money'), fact('anon_void_count', 'Number of those voids', anon.count, 'count'));
    why.push(`${anon.count} void${anon.count === 1 ? '' : 's'} worth ${money(anon.total)} had no member of staff recorded on them.`);
  }
  why.push('Takings follow shifts and sections: someone on a busy Saturday night will always take more. Average spend and voids say more about how someone sells.');
  return {
    intent: 'staff', headline, summary: headline, why,
    next: anon.count ? ['Voids with no name on them cannot be followed up. Make sure staff sign in on every till before they ring anything up.', ...(bigVoid && bigVoid.total_minor > 2000 ? [`Look at ${bigVoid.clerk}'s voids in Reports, Voids & Cancels.`] : [])] : bigVoid && bigVoid.total_minor > 2000 ? [`Look at ${bigVoid.clerk}'s voids in Reports, Voids & Cancels. Most are honest mistakes; a pattern is worth a conversation.`] : ['Share the average spend with the team: it is the figure each person can improve.'],
    facts,
    charts: [{ type: 'ranked', title: 'Takings by member of staff', unit: 'money', rows: rows.slice(0, 10).map((x) => ({ label: x.clerk, value: x.takings_minor, meta: `${x.sales} bills, ${money(x.average_minor)} avg` })) }],
    meta: M.meta(p, f, M.DEF.staff, null, { compare: c.label }),
    records: [{ kind: 'bills', label: `Bills in ${p.label}`, from: p.from, to: p.to }, { kind: 'voids', label: `Voids in ${p.label}`, from: p.from, to: p.to }],
    follow_ups: ['Compare the team with last week', 'Why did sales drop?', 'Which site performed best?'],
  };
}

async function sites({ pool, office, f, p, c, ctx }) {
  if (ctx.map.sites.length < 2 && !(ctx.allowed && ctx.allowed.length > 1)) {
    const t = await takings({ pool, office, f, p, c });
    return { ...t, intent: 'sites', why: [`This venue has ${ctx.map.sites.length ? 'one site' : 'no sites set up'}, so there is nothing to compare between sites. Sites are set up in the back office under Devices.`, ...t.why] };
  }
  const [now, before] = await Promise.all([M.bySite(pool, office, ctx.map, ctx.allowed, p), M.bySite(pool, office, ctx.map, ctx.allowed, c)]);
  const rows = now.map((s) => {
    const b = before.find((x) => x.id === s.id) || { takings_minor: 0, sales: 0 };
    return { ...s, before_minor: b.takings_minor, change: pct(s.takings_minor, b.takings_minor), average_minor: s.sales ? Math.round(s.takings_minor / s.sales) : 0 };
  }).sort((a, b) => b.takings_minor - a.takings_minor);
  const facts = [];
  rows.forEach((s, i) => facts.push(
    fact(`site${i}_takings`, `${s.name} takings`, s.takings_minor, 'money'),
    fact(`site${i}_before`, `${s.name} takings, ${c.label}`, s.before_minor, 'money'),
    fact(`site${i}_change`, `${s.name} change`, s.change, 'percent'),
    fact(`site${i}_bills`, `${s.name} bills`, s.sales, 'count'),
    fact(`site${i}_average`, `${s.name} average spend`, s.average_minor, 'money')));
  const top = rows[0];
  const headline = top ? `${top.name} performed best in ${lower(p.label)} with ${money(top.takings_minor)}.` : 'No sales at any site.';
  const why = rows.map((s) => `${s.name}: ${money(s.takings_minor)}, ${s.change == null ? `no sales in ${lower(c.label)} to compare with` : `${s.change >= 0 ? 'up' : 'down'} ${Math.abs(s.change)}% on ${lower(c.label)}`}, ${money(s.average_minor)} a bill.`);
  return {
    intent: 'sites', headline, summary: headline, why,
    next: rows.length > 1 && rows[rows.length - 1].change != null && rows[rows.length - 1].change < -10 ? [`Ask "why did sales drop at ${rows[rows.length - 1].name}" to see what changed there.`] : [],
    facts,
    charts: [{ type: 'pairbars', title: `Takings by site, ${p.label} against ${c.label}`, unit: 'money', rows: rows.map((s) => ({ label: s.name, value: s.takings_minor, compare: s.before_minor })), legend: ['This period', 'Compared with'] }],
    meta: M.meta(p, { label: ctx.allowed ? 'Your sites' : 'All sites' }, M.DEF.sites, null, { compare: c.label }),
    records: [{ kind: 'bills', label: `Bills in ${p.label}`, from: p.from, to: p.to }],
    follow_ups: ['Why did sales drop?', 'How is the team doing?', 'What were the best sellers?'],
  };
}

/**
 * Tomorrow: what the same weekday has taken over the last four weeks, its
 * busy hours, the products it sells most, and the stock that will not last.
 */
async function focus({ pool, office, f, ctx }) {
  const today = M.midnight(ctx.now);
  const tomorrow = today + M.DAY;
  const dow = new Date(tomorrow).getUTCDay();
  const weeks = [1, 2, 3, 4].map((w) => M.periodOf('day', M.dayText(tomorrow - w * 7 * M.DAY), tomorrow - w * 7 * M.DAY, tomorrow - w * 7 * M.DAY + M.DAY));
  const [sums, hours, prods, stock] = await Promise.all([
    Promise.all(weeks.map((w) => M.summary(pool, office, f, w))),
    Promise.all(weeks.map((w) => M.byHour(pool, office, f, w))),
    Promise.all(weeks.map((w) => M.byProduct(pool, office, f, w))),
    M.stock(pool, office, f, ctx.now),
  ]);
  const traded = sums.filter((s) => s.sales > 0);
  const avg = traded.length ? Math.round(traded.reduce((a, s) => a + s.takings_minor, 0) / traded.length) : 0;
  const avgBills = traded.length ? Math.round(traded.reduce((a, s) => a + s.sales, 0) / traded.length) : 0;
  const hourTotals = new Map();
  hours.flat().forEach((h) => hourTotals.set(h.hour, (hourTotals.get(h.hour) || 0) + h.takings_minor));
  const busy = [...hourTotals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([h, v]) => ({ hour: h, avg: Math.round(v / Math.max(1, traded.length)) }));
  const prodTotals = new Map();
  prods.flat().forEach((x) => { const e = prodTotals.get(x.name) || { name: x.name, plu: x.plu, qty: 0 }; e.qty += x.qty; prodTotals.set(x.name, e); });
  const topProds = [...prodTotals.values()].sort((a, b) => b.qty - a.qty).slice(0, 5).map((x) => ({ ...x, avg: Math.round((x.qty / Math.max(1, traded.length)) * 10) / 10 }));
  const shortfall = topProds.map((x) => ({ ...x, s: stock.find((s) => s.plu === x.plu) })).filter((x) => x.s && x.s.stock < x.avg);
  const runningOut = stock.filter((s) => s.days_cover != null && s.days_cover <= 2 && s.stock > 0);
  const facts = [
    fact('tomorrow_avg', `Average takings on the last ${traded.length} ${M.DAYS[dow]}s`, avg, 'money'),
    fact('tomorrow_bills', `Average bills on those ${M.DAYS[dow]}s`, avgBills, 'count'),
    fact('weeks_traded', `${M.DAYS[dow]}s with sales in the last four weeks`, traded.length, 'count'),
  ];
  weeks.forEach((w, i) => facts.push(fact(`week${i}`, `Takings ${w.label}`, sums[i].takings_minor, 'money')));
  busy.forEach((b, i) => facts.push(fact(`busy${i}`, `${hourLabel(b.hour)} average takings`, b.avg, 'money')));
  topProds.forEach((x, i) => facts.push(fact(`tp${i}`, `${x.name} average sold`, x.avg, 'count')));
  shortfall.forEach((x, i) => facts.push(fact(`short${i}`, `${x.name} in stock`, x.s.stock, 'count')));
  const headline = traded.length
    ? `Tomorrow is ${M.DAYS[dow]}. The last ${traded.length} ${M.DAYS[dow]}s averaged ${money(avg)} from ${bills(avgBills)}.`
    : `Tomorrow is ${M.DAYS[dow]}. There were no sales on the last four ${M.DAYS[dow]}s to go on.`;
  const why = [];
  if (busy.length) why.push(`Busiest hours: ${busy.map((b) => `${hourLabel(b.hour)} (around ${money(b.avg)})`).join(', ')}.`);
  if (topProds.length) why.push(`Usual best sellers: ${topProds.map((x) => `${x.name} (about ${x.avg})`).join(', ')}.`);
  const next = [];
  if (busy.length) next.push(`Have your strongest staff on from ${hourLabel(Math.min(...busy.map((b) => b.hour)))}.`);
  if (shortfall.length) next.push(`Stock up before opening: ${shortfall.map((x) => `${x.name} (${inStock(x.s.stock)}, about ${x.avg} usually sold)`).join(', ')}.`);
  if (runningOut.length) next.push(`Running out within two days: ${runningOut.slice(0, 4).map((s) => s.name).join(', ')}.`);
  if (!next.length) next.push('Stock looks fine for a usual day. Check the bookings and the weather: they move a day more than anything else.');
  return {
    intent: 'focus', headline, summary: headline, why, next, facts,
    charts: [{ type: 'bar', title: `Takings on the last four ${M.DAYS[dow]}s`, unit: 'money', rows: weeks.map((w, i) => ({ label: w.label, value: sums[i].takings_minor })).reverse() }],
    meta: { period: `The last four ${M.DAYS[dow]}s (${weeks[3].label} to ${weeks[0].label})`, site: f.label, definition: `${M.DEF.takings} Tomorrow's outlook is the average of the same weekday over the last four weeks; it is a guide, not a forecast of bookings or weather.`, freshness: 'Sales to now; stock counts as they are now', from: weeks[3].from, to: weeks[0].to },
    records: weeks.map((w) => ({ kind: 'bills', label: `Bills on ${w.label}`, from: w.from, to: w.to })),
    follow_ups: ['What stock should I reorder?', 'How did today compare with last week?', 'How is the team doing?'],
  };
}

/**
 * The daily briefing: the opening screen of Vesopa AI. Yesterday against the
 * same day a week before, today so far, the week so far, and the alerts that
 * need someone today.
 */
async function briefing({ pool, office, f, ctx }) {
  const y = M.resolvePeriod({ kind: 'yesterday' }, ctx.now);
  const yc = M.comparisonFor(y);
  const t = M.resolvePeriod({ kind: 'today' }, ctx.now);
  const tc = M.comparisonFor(t);
  const w = M.resolvePeriod({ kind: 'this_week' }, ctx.now);
  const wc = M.comparisonFor(w);
  const [ys, ycs, ts, tcs, ws, wcs, prods, stock, v, vBefore] = await Promise.all([
    M.summary(pool, office, f, y), M.summary(pool, office, f, yc),
    M.summary(pool, office, f, t), M.summary(pool, office, f, tc),
    M.summary(pool, office, f, w), M.summary(pool, office, f, wc),
    M.byProduct(pool, office, f, y),
    M.stock(pool, office, f, ctx.now),
    M.voids(pool, office, f, y), M.voids(pool, office, f, yc),
  ]);
  const yChange = pct(ys.takings_minor, ycs.takings_minor);
  const tChange = pct(ts.takings_minor, tcs.takings_minor);
  const wChange = pct(ws.takings_minor, wcs.takings_minor);
  const facts = [
    fact('y_takings', 'Yesterday\'s takings', ys.takings_minor, 'money'),
    fact('y_before', `Takings, ${yc.label}`, ycs.takings_minor, 'money'),
    fact('y_change', 'Yesterday against the same day last week', yChange, 'percent'),
    fact('y_bills', 'Yesterday\'s bills', ys.sales, 'count'),
    fact('y_average', 'Yesterday\'s average spend', ys.average_minor, 'money'),
    fact('t_takings', 'Today so far', ts.takings_minor, 'money'),
    fact('t_before', `Takings, ${tc.label}`, tcs.takings_minor, 'money'),
    fact('t_change', 'Today against the same time last week', tChange, 'percent'),
    fact('w_takings', 'This week so far', ws.takings_minor, 'money'),
    fact('w_before', `Takings, ${wc.label}`, wcs.takings_minor, 'money'),
    fact('w_change', 'This week against the same point last week', wChange, 'percent'),
  ];
  const costed = prods.filter((x) => x.costed && x.qty > 0);
  const losing = costed.filter((x) => x.profit_minor < 0);
  if (ctx.can.profit && costed.length) {
    const gp = costed.reduce((a, x) => a + x.profit_minor, 0);
    const net = costed.reduce((a, x) => a + x.net_minor, 0);
    facts.push(fact('y_gp', 'Yesterday\'s gross profit (costed products)', gp, 'money'), fact('y_margin', 'Yesterday\'s gross margin', net > 0 ? Math.round((gp / net) * 1000) / 10 : null, 'pct'));
  }
  const top = [...prods].sort((a, b) => b.takings_minor - a.takings_minor).slice(0, 5);
  top.forEach((x, i) => facts.push(fact(`top${i}`, `${x.name} takings yesterday`, x.takings_minor, 'money')));

  // Alerts: each one a figure, a reason it matters, and where to act.
  const alerts = [];
  if (yChange != null && yChange <= -15) alerts.push({ level: 'warn', title: `Yesterday was down ${Math.abs(yChange)}%`, body: `${money(ys.takings_minor)} against ${money(ycs.takings_minor)} on ${lower(yc.label)}.`, ask: 'Why did sales drop yesterday?' });
  if (yChange != null && yChange >= 15) alerts.push({ level: 'good', title: `Yesterday was up ${yChange}%`, body: `${money(ys.takings_minor)} against ${money(ycs.takings_minor)}.`, ask: 'Why did sales go up yesterday?' });
  const out = stock.filter((s) => s.stock <= 0 && s.sold_28d > 0);
  const soon = stock.filter((s) => s.stock > 0 && s.days_cover != null && s.days_cover <= 3);
  if (out.length) alerts.push({ level: 'bad', title: `${out.length} selling product${out.length === 1 ? ' is' : 's are'} out of stock`, body: out.slice(0, 4).map((s) => s.name).join(', '), ask: 'What stock should I reorder?' });
  if (soon.length) alerts.push({ level: 'warn', title: `${soon.length} product${soon.length === 1 ? '' : 's'} will run out within 3 days`, body: soon.slice(0, 4).map((s) => `${s.name} (${s.days_cover} days)`).join(', '), ask: 'What stock should I reorder?' });
  if (ctx.can.profit && losing.length) alerts.push({ level: 'bad', title: `${losing.length} product${losing.length === 1 ? '' : 's'} sold at a loss yesterday`, body: losing.slice(0, 3).map((x) => x.name).join(', '), ask: 'Which products sell at a loss?' });
  const voidNow = v.reduce((a, r) => a + r.total_minor, 0);
  const voidBefore = vBefore.reduce((a, r) => a + r.total_minor, 0);
  if (ctx.can.staff && voidNow > 2000 && voidNow > voidBefore * 2) alerts.push({ level: 'warn', title: `Voids doubled to ${money(voidNow)}`, body: `Against ${money(voidBefore)} on ${lower(yc.label)}.`, ask: 'Who voided the most yesterday?' });
  facts.push(fact('out_count', 'Out of stock and selling', out.length, 'count'), fact('soon_count', 'Running out within 3 days', soon.length, 'count'), fact('voids_y', 'Voids yesterday', voidNow, 'money'), fact('voids_before', `Voids, ${yc.label}`, voidBefore, 'money'));

  const headline = ys.sales
    ? `Yesterday took ${money(ys.takings_minor)}${yChange == null ? '' : `, ${yChange >= 0 ? 'up' : 'down'} ${Math.abs(yChange)}% on ${lower(yc.label)}`}.`
    : 'No sales yesterday.';
  const why = [];
  if (ys.sales) why.push(`${bills(ys.sales)} at ${money(ys.average_minor)} a bill${ycs.sales ? ` (${ycs.sales} at ${money(ycs.average_minor)} the week before)` : ''}.`);
  if (top[0]) why.push(`Best seller: ${top[0].name} with ${money(top[0].takings_minor)}.`);
  why.push(`Today so far: ${money(ts.takings_minor)}${tChange == null ? '' : ` (${tChange >= 0 ? 'up' : 'down'} ${Math.abs(tChange)}% on the same time last week)`}. This week so far: ${money(ws.takings_minor)}${wChange == null ? '' : ` (${wChange >= 0 ? 'up' : 'down'} ${Math.abs(wChange)}%)`}.`);
  const next = [];
  if (out.length) next.push(`Reorder ${out.slice(0, 3).map((x) => x.name).join(', ')} today: they sell and there are none left. Orders are placed in Stock Control, Orders & Deliveries.`);
  if (soon.length) next.push(`Top up ${soon.slice(0, 3).map((x) => x.name).join(', ')} before the weekend trade uses them up.`);
  if (yChange != null && yChange <= -15) next.push('Ask why yesterday was down: Vesopa AI splits it into customers, spend, hours and products.');
  if (ctx.can.profit && losing.length) next.push(`Check the price and cost price of ${losing[0].name}: it sold for less than it cost.`);
  if (!next.length) next.push('Nothing urgent. Ask "what should I focus on tomorrow" to plan ahead.');
  return {
    intent: 'briefing', headline, summary: headline, why, next, facts, alerts,
    tiles: [
      { id: 'y_takings', label: 'Yesterday', value: ys.takings_minor, change: yChange, sub: bills(ys.sales) },
      { id: 't_takings', label: 'Today so far', value: ts.takings_minor, change: tChange, sub: bills(ts.sales) },
      { id: 'w_takings', label: 'This week', value: ws.takings_minor, change: wChange, sub: bills(ws.sales) },
      { id: 'y_average', label: 'Average spend', value: ys.average_minor, change: pct(ys.average_minor, ycs.average_minor), sub: 'yesterday' },
    ],
    charts: [{ type: 'ranked', title: 'Yesterday\'s best sellers', unit: 'money', rows: top.map((x) => ({ label: x.name, value: x.takings_minor, meta: `${x.qty} sold` })) }],
    meta: M.meta(y, f, M.DEF.takings, ys.last_sale || ts.last_sale, { compare: yc.label, freshness: `Latest sale: ${(ts.last_sale || ys.last_sale || 'none').slice(0, 16)}. Figures as of ${M.naive(ctx.now).slice(0, 16)}.` }),
    records: [{ kind: 'bills', label: 'Yesterday\'s bills', from: y.from, to: y.to }, { kind: 'bills', label: 'Today\'s bills', from: t.from, to: t.to }],
    follow_ups: ['Why did sales drop yesterday?', 'What should I focus on tomorrow?', 'What stock should I reorder?', 'Which products make the most profit?', 'How is my team performing?', 'Compare this week with last week'],
  };
}

module.exports = { parseQuestion, answer, INTENTS, fact, mergeMoves, periodsIn, intentIn };
