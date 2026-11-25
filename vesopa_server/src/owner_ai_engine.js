/**
 * Vesopa AI for the owner of Vesopa (admin.vesopa.com): the arithmetic.
 *
 * Every figure the owner reads is worked out here, from rows the back office
 * read across every venue, before any model sees it. The model only words
 * these figures, and its words are checked against them (checkNarrative): a
 * sentence quoting a figure that is not in the facts is thrown away.
 *
 * No database and no network: test/owner-ai.test.js drives it with rows.
 *
 * WHAT THE WORDS MEAN (shown under every answer)
 *
 *   Takings        what customers paid at every venue on closed sales, VAT
 *                  included, after discounts (as each venue's Z report counts)
 *   Vesopa income  invoices paid to Vesopa in the period
 *   Monthly recurring revenue (MRR)  active subscriptions as a month (a
 *                  yearly one counts a twelfth)
 *   Overdue        invoices past their due date and not paid
 *   Online         a device heard from in the last 15 minutes (admin overview)
 */
'use strict';

const DAY = 86400000;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

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


/** A label mid-sentence: only its first letter lowered ("Last Tuesday" keeps its capital). */
const lc = (s) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : '');
const trend = (p) => (p == null ? '' : p === 0 ? ', level with before' : `, ${p > 0 ? 'up' : 'down'} ${Math.abs(p)}%`);
const signedMoney = (minor) => (minor < 0 ? `-${money(-minor)}` : `+${money(minor)}`);

// ---- venues' takings ------------------------------------------------------------------

/**
 * Each venue's takings in a period and the one before, side by side.
 * @param offices  [{id, name, contact_email, status}]
 * @param now      rows {office, sales, gross_minor, last_sale_at} for the period
 * @param before   the same for the comparison period
 */
function venueTable(offices, now, before) {
  const cur = new Map((now || []).map((r) => [String(r.office).toLowerCase(), r]));
  const prev = new Map((before || []).map((r) => [String(r.office).toLowerCase(), r]));
  const rows = offices.map((o) => {
    const k = String(o.contact_email).toLowerCase();
    const a = cur.get(k) || {};
    const b = prev.get(k) || {};
    const sales = Number(a.sales) || 0;
    const gross = Number(a.gross_minor) || 0;
    const was = Number(b.gross_minor) || 0;
    return {
      id: o.id,
      name: String(o.name || 'Venue'),
      status: o.status || 'active',
      sales,
      gross_minor: gross,
      before_minor: was,
      diff_minor: gross - was,
      change_pct: change(gross, was),
      average_minor: sales ? Math.round(gross / sales) : 0,
      last_sale_at: a.last_sale_at || null,
    };
  });
  rows.sort((x, y) => y.gross_minor - x.gross_minor);
  const total = rows.reduce((s, r) => s + r.gross_minor, 0);
  for (const r of rows) r.share_pct = pct(r.gross_minor, total);
  return rows;
}

function platformTotals(rows) {
  const sales = rows.reduce((s, r) => s + r.sales, 0);
  const gross = rows.reduce((s, r) => s + r.gross_minor, 0);
  const before = rows.reduce((s, r) => s + r.before_minor, 0);
  return {
    sales,
    gross_minor: gross,
    before_minor: before,
    change_pct: change(gross, before),
    average_minor: sales ? Math.round(gross / sales) : 0,
    trading: rows.filter((r) => r.sales > 0).length,
    venues: rows.length,
  };
}

// ---- Vesopa's own income ------------------------------------------------------------------

/** A subscription as a month: yearly counts a twelfth, weekly x 52 / 12. */
function monthly(amountMinor, unit) {
  const a = Number(amountMinor) || 0;
  if (unit === 'year') return Math.round(a / 12);
  if (unit === 'week') return Math.round((a * 52) / 12);
  return a;
}

/**
 * @param subs     [{office_id, name, amount_minor, interval_unit, status, created_at}]
 * @param invoices [{office_id, name, amount_minor, status, due_on, paid_at}]
 * @param period   resolvePeriod(...)
 */
function income(subs, invoices, period) {
  const active = (subs || []).filter((s) => s.status === 'active' && s.office_status !== 'archived');
  const mrr = active.reduce((s, x) => s + monthly(x.amount_minor, x.interval_unit), 0);
  const inWin = (t, from, to) => t && String(t).slice(0, 19) >= from && String(t).slice(0, 19) < to;
  const paid = (invoices || []).filter((i) => i.status === 'paid' && inWin(i.paid_at, period.from, period.to));
  const paidBefore = (invoices || []).filter((i) => i.status === 'paid' && inWin(i.paid_at, period.compare.from, period.compare.to));
  const overdue = (invoices || []).filter((i) => i.status === 'overdue');
  const sum = (l) => l.reduce((s, i) => s + (Number(i.amount_minor) || 0), 0);
  const byVenue = new Map();
  for (const i of overdue) {
    const v = byVenue.get(i.name) || { name: i.name, count: 0, amount_minor: 0, oldest_due: i.due_on };
    v.count += 1;
    v.amount_minor += Number(i.amount_minor) || 0;
    if (String(i.due_on) < String(v.oldest_due)) v.oldest_due = i.due_on;
    byVenue.set(i.name, v);
  }
  const newSubs = (subs || []).filter((s) => inWin(s.created_at, period.from, period.to));
  return {
    mrr_minor: mrr,
    arr_minor: mrr * 12,
    paying_venues: new Set(active.filter((s) => Number(s.amount_minor) > 0).map((s) => s.office_id)).size,
    paid_minor: sum(paid),
    paid_count: paid.length,
    paid_before_minor: sum(paidBefore),
    paid_change_pct: change(sum(paid), sum(paidBefore)),
    overdue_minor: sum(overdue),
    overdue_count: overdue.length,
    overdue_venues: [...byVenue.values()].sort((a, b) => b.amount_minor - a.amount_minor),
    new_subscriptions: newSubs.length,
    top_payers: active
      .map((s) => ({ name: s.name, monthly_minor: monthly(s.amount_minor, s.interval_unit) }))
      .sort((a, b) => b.monthly_minor - a.monthly_minor)
      .slice(0, 10),
  };
}

// ---- licences, devices, sign-ups ------------------------------------------------------------

function licences(offices, overview) {
  const counts = { active: 0, paused: 0, archived: 0 };
  for (const o of offices) counts[o.status] = (counts[o.status] || 0) + 1;
  const plans = new Map();
  for (const o of offices.filter((x) => x.status !== 'archived')) {
    const p = o.plan || 'No plan';
    plans.set(p, (plans.get(p) || 0) + 1);
  }
  const paused = offices.filter((o) => o.status === 'paused').map((o) => ({ name: o.name, since: o.paused_at ? String(o.paused_at).slice(0, 10) : null, reason: o.pause_reason || null }));
  const holds = (overview && overview.totals) || {};
  return {
    counts,
    plans: [...plans.entries()].map(([name, venues]) => ({ name, venues })).sort((a, b) => b.venues - a.venues),
    paused,
    holds_in_grace: Number(holds.holds_in_grace) || 0,
    holds_stopped: Number(holds.holds_stopped) || 0,
  };
}

/**
 * @param overview  admin_overview.overview() (venues with devices by kind and online counts)
 * @param versions  [{app, version, devices}]
 */
function devices(overview, versions, nowMs = Date.now()) {
  const venues = (overview && overview.venues) || [];
  const total = venues.reduce((s, v) => s + (v.device_count || 0), 0);
  const online = venues.reduce((s, v) => s + (v.online || 0), 0);
  const kinds = new Map();
  for (const v of venues) {
    for (const [k, d] of Object.entries(v.devices || {})) {
      const c = kinds.get(k) || { kind: k, total: 0, online: 0 };
      c.total += d.total;
      c.online += d.online;
      kinds.set(k, c);
    }
  }
  const quiet = venues
    .filter((v) => v.status !== 'archived' && v.device_count > 0)
    .map((v) => ({ name: v.name, devices: v.device_count, online: v.online, last_seen_at: v.last_seen_at, hours: v.last_seen_at ? Math.round((nowMs - new Date(v.last_seen_at).getTime()) / 3600e3) : null }))
    .filter((v) => v.online === 0 && (v.hours == null || v.hours >= 24))
    .sort((a, b) => (b.hours ?? 1e9) - (a.hours ?? 1e9));
  const apps = new Map();
  for (const r of versions || []) {
    const a = apps.get(r.app) || { app: r.app, versions: [] };
    a.versions.push({ version: r.version || 'unknown', devices: Number(r.devices) || 0 });
    apps.set(r.app, a);
  }
  for (const a of apps.values()) a.versions.sort((x, y) => y.devices - x.devices);
  return {
    total,
    online,
    offline: total - online,
    online_pct: pct(online, total),
    kinds: [...kinds.values()].sort((a, b) => b.total - a.total),
    quiet_venues: quiet,
    apps: [...apps.values()],
  };
}

function signups(offices, onboarding, period) {
  const inWin = (t, from, to) => t && String(t).slice(0, 19) >= from && String(t).slice(0, 19) < to;
  const fresh = offices.filter((o) => inWin(o.created_at, period.from, period.to));
  const before = offices.filter((o) => inWin(o.created_at, period.compare.from, period.compare.to));
  const ob = onboarding || [];
  const stage = (r) => (r.licence_status === 'active' || r.licence_status === 'trialing'
    ? (r.identity_status === 'verified' ? 'ready' : 'identity')
    : r.identity_status === 'verified' ? 'licence' : 'identity');
  const pipeline = { identity: 0, licence: 0, ready: 0 };
  for (const r of ob) pipeline[stage(r)] += 1;
  const trialsEnding = ob
    .filter((r) => r.trial_end && r.licence_status === 'trialing')
    .map((r) => ({ name: r.name || r.legal_name || 'Venue', trial_end: String(r.trial_end).slice(0, 10) }))
    .sort((a, b) => a.trial_end.localeCompare(b.trial_end))
    .slice(0, 10);
  return {
    new_venues: fresh.length,
    new_before: before.length,
    change_pct: change(fresh.length, before.length),
    list: fresh.map((o) => ({ name: o.name, created: String(o.created_at).slice(0, 10), status: o.status, plan: o.plan || null })),
    pipeline,
    started: ob.length,
    trials_ending: trialsEnding,
  };
}

/** Card, cash and the rest, across every venue. rows: {method, count, total_minor} (all venues) */
function payments(rows, before) {
  const group = (m) => {
    const s = String(m || '').toLowerCase();
    if (/card|contactless|dojo|stripe|teya|tap|apple|google|paymentsense/.test(s)) return 'Card';
    if (/cash/.test(s)) return 'Cash';
    if (/gift/.test(s)) return 'Gift card';
    if (/voucher|points|deposit/.test(s)) return 'Vouchers and points';
    return 'Other';
  };
  const sum = (list) => {
    const m = new Map();
    for (const r of list || []) {
      const g = group(r.method);
      const c = m.get(g) || { method: g, count: 0, total_minor: 0 };
      c.count += Number(r.count) || 0;
      c.total_minor += Number(r.total_minor) || 0;
      m.set(g, c);
    }
    return m;
  };
  const now = sum(rows);
  const prev = sum(before);
  const total = [...now.values()].reduce((s, r) => s + r.total_minor, 0);
  const list = [...now.values()].map((r) => ({ ...r, share_pct: pct(r.total_minor, total), change_pct: change(r.total_minor, (prev.get(r.method) || {}).total_minor || 0) }))
    .sort((a, b) => b.total_minor - a.total_minor);
  const card = now.get('Card') || { total_minor: 0, count: 0 };
  return { total_minor: total, card_minor: card.total_minor, card_count: card.count, card_share_pct: pct(card.total_minor, total), methods: list };
}

// ---- what needs the owner -----------------------------------------------------------------------

function alerts({ venues = [], totals = null, income: inc = null, devices: dev = null, signups: su = null, licences: lic = null }) {
  const out = [];
  const actions = [];
  if (inc && inc.overdue_count) {
    out.push({ tone: 'bad', title: `${money(inc.overdue_minor)} overdue from ${inc.overdue_venues.length} venue${inc.overdue_venues.length === 1 ? '' : 's'}`, detail: inc.overdue_venues.slice(0, 3).map((v) => `${v.name} ${money(v.amount_minor)}`).join(', ') + '.' });
    actions.push({ title: `Chase ${inc.overdue_venues[0].name}`, why: `${money(inc.overdue_venues[0].amount_minor)} overdue on ${inc.overdue_venues[0].count} invoice${inc.overdue_venues[0].count === 1 ? '' : 's'}, oldest due ${String(inc.overdue_venues[0].oldest_due).slice(0, 10)}.`, action: 'revenue' });
  }
  const fallers = venues.filter((v) => v.before_minor >= 10000 && v.change_pct != null && v.change_pct <= -40).sort((a, b) => a.diff_minor - b.diff_minor);
  if (fallers.length) {
    out.push({ tone: 'warn', title: `${fallers.length} venue${fallers.length === 1 ? '' : 's'} trading much lower`, detail: fallers.slice(0, 3).map((v) => `${v.name} down ${Math.abs(v.change_pct)}%`).join(', ') + '.' });
    actions.push({ title: `Call ${fallers[0].name}`, why: `Takings ${money(fallers[0].gross_minor)} against ${money(fallers[0].before_minor)} before: check the tills are working and the venue is happy.`, action: 'venues' });
  }
  const silent = venues.filter((v) => v.status === 'active' && v.sales === 0 && v.before_minor > 0);
  if (silent.length) {
    out.push({ tone: 'warn', title: `${silent.length} active venue${silent.length === 1 ? '' : 's'} with no sales this period`, detail: silent.slice(0, 4).map((v) => v.name).join(', ') + '.' });
  }
  if (dev && dev.quiet_venues.length) {
    out.push({ tone: 'warn', title: `${dev.quiet_venues.length} venue${dev.quiet_venues.length === 1 ? '' : 's'} with every device offline for a day or more`, detail: dev.quiet_venues.slice(0, 3).map((v) => v.name).join(', ') + '.' });
    actions.push({ title: `Check in with ${dev.quiet_venues[0].name}`, why: `${dev.quiet_venues[0].devices} device${dev.quiet_venues[0].devices === 1 ? '' : 's'}, none heard from${dev.quiet_venues[0].hours != null ? ` for ${dev.quiet_venues[0].hours} hours` : ''}.`, action: 'devices' });
  }
  if (su && su.trials_ending.length) {
    out.push({ tone: 'warn', title: `${su.trials_ending.length} free trial${su.trials_ending.length === 1 ? '' : 's'} ending`, detail: su.trials_ending.slice(0, 3).map((t) => `${t.name} (${t.trial_end})`).join(', ') + '.' });
  }
  if (lic && lic.paused.length) {
    out.push({ tone: 'warn', title: `${lic.paused.length} paused venue${lic.paused.length === 1 ? '' : 's'}`, detail: lic.paused.slice(0, 3).map((p) => p.name).join(', ') + '.' });
  }
  const risers = venues.filter((v) => v.before_minor >= 10000 && v.change_pct != null && v.change_pct >= 30).sort((a, b) => b.diff_minor - a.diff_minor);
  if (risers.length) {
    out.push({ tone: 'good', title: `${risers.length} venue${risers.length === 1 ? '' : 's'} growing fast`, detail: risers.slice(0, 3).map((v) => `${v.name} up ${v.change_pct}%`).join(', ') + '.' });
    actions.push({ title: `Ask ${risers[0].name} for a testimonial`, why: `Takings up ${risers[0].change_pct}% to ${money(risers[0].gross_minor)}.`, action: 'venues' });
  }
  if (totals && totals.venues && totals.trading < totals.venues) {
    // Kept in the facts for the model; the alert list stays short.
  }
  return { alerts: out, actions: actions.slice(0, 5) };
}

// ---- understanding the question -------------------------------------------------------------------

const INTENTS = ['summary', 'venues', 'why_change', 'revenue', 'licences', 'devices', 'signups', 'payments', 'focus'];

function parseQuestion(text, previous = null) {
  const q = ` ${String(text || '').toLowerCase().replace(/[^a-z0-9£%' ]+/g, ' ')} `;
  const has = (...w) => w.some((x) => q.includes(x));
  let period = null;
  if (has(' yesterday', 'last night')) period = 'yesterday';
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
  if (has('focus', 'priorit', 'what should', 'should i', 'advice', 'recommend', 'attention', 'worry')) intent = 'focus';
  else if (has('why', 'reason', 'drop', 'decreas', 'fell', 'fall', 'went down', 'increas', 'went up', 'grew')) intent = 'why_change';
  else if (has('overdue', 'unpaid', 'invoice', 'mrr', 'recurring', 'income', 'earning', 'we earn', 'we make', 'our revenue', 'vesopa make', 'vesopa earn', 'vesopa take', 'arr ', 'subscription', 'billing', 'owe')) intent = 'revenue';
  else if (has('licen', 'plan', 'paused', 'cancel', 'archiv', 'seats')) intent = 'licences';
  else if (has('device', 'till', 'offline', 'online', 'version', 'health', 'server', 'tablet', 'phones')) intent = 'devices';
  else if (has('sign up', 'signup', 'signed up', 'new venue', 'new customer', 'onboard', 'trial', 'identity', 'stripe')) intent = 'signups';
  else if (has('card', 'cash', 'payment', 'tender', 'gift card', 'contactless')) intent = 'payments';
  else if (has('which venue', 'best venue', 'top venue', 'busiest venue', 'ranking', 'rank ', 'compare venue', 'biggest', 'smallest', 'worst', 'league')) intent = 'venues';
  else if (has('takings', 'how much', 'sales', 'turnover', 'revenue', 'how are', 'how is', 'doing', 'compare', ' vs ', 'business')) intent = 'summary';
  const followUp = !intent && previous && previous.intent;
  if (followUp) intent = previous.intent;
  if (!period && previous && previous.period && (followUp || intent === previous.intent)) period = previous.period;
  if (!period) period = intent === 'revenue' || intent === 'signups' ? 'this_month' : intent === 'focus' || intent === 'venues' || intent === 'why_change' || intent === 'payments' ? 'last_7_days' : 'today';
  return { intent: intent || 'unknown', period, follow_up: Boolean(followUp) };
}

const SUGGESTIONS = [
  'How much did all venues take today?',
  'Which venues are doing best this week?',
  'Why did takings change this week?',
  'How much is Vesopa earning each month?',
  'Who owes us money?',
  'Which venues have devices offline?',
  'How many new venues signed up this month?',
  'What should I focus on this week?',
];

const FOLLOW_UPS = {
  summary: ['Which venues are doing best?', 'Why did takings change?', 'What about yesterday?'],
  venues: ['Why did takings change?', 'Which venues have devices offline?', 'Who owes us money?'],
  why_change: ['Which venues are doing best?', 'What should I focus on this week?'],
  revenue: ['Who owes us money?', 'How many new venues signed up this month?', 'Which venues are paused?'],
  licences: ['How much is Vesopa earning each month?', 'Which venues have devices offline?'],
  devices: ['Which venues are doing best this week?', 'What should I focus on this week?'],
  signups: ['How much is Vesopa earning each month?', 'Which free trials are ending?'],
  payments: ['How much did all venues take today?', 'Which venues are doing best this week?'],
  focus: ['Who owes us money?', 'Which venues have devices offline?', 'Why did takings change this week?'],
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

module.exports = {
  money, change, pct, sqlTime, resolvePeriod, PERIODS, lc, trend, signedMoney,
  venueTable, platformTotals, monthly, income, licences, devices, signups, payments, alerts,
  parseQuestion, INTENTS, SUGGESTIONS, FOLLOW_UPS, checkNarrative,
};
