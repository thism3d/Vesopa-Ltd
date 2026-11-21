/**
 * Vesopa AI for the owner of Vesopa, on admin.vesopa.com (owner, 2026-11-21:
 * "create this AI for my client only, the Vesopa owner, so he can track
 * everything, and only those people invited by the owner").
 *
 * The whole business in one place: every venue's takings, Vesopa's own
 * income (subscriptions, invoices paid and overdue), licences, devices and
 * their health, new venues signing up, and how customers pay.
 *
 * WHO GETS IN
 *
 * Only admin.vesopa.com, with its service key (auth.js adminService): these
 * routes sit under /api/admin, behind the platform admin gate, and check it
 * again here. admin.vesopa.com decides who of its admins may open Vesopa AI:
 * the owner (info@vesopasoftware.com) and the people the owner gives the
 * "Vesopa AI" role (vesopa_admin/src/roles.js). Nothing here is reachable
 * from a venue's back office or a till.
 *
 * READ-ONLY
 *
 * Every route reads. Nothing changes a venue, a licence or an invoice.
 *
 * HOW AN ANSWER IS MADE
 *
 * The figures are SQL and owner_ai_engine.js; takings are read grouped by
 * venue (one row per venue), so each venue's figures stay its own and are only
 * added up for the owner. The plain wording is made from the figures. When a
 * model is set up (DEEPSEEK_API_KEY, GEMINI_API_KEY as backup) it words the
 * same figures; it is given venue names and amounts, never an email address,
 * a person's name or a customer's details, and a sentence that quotes a figure
 * not in the facts is thrown away.
 *
 *   GET  /api/admin/insights/briefing           the owner's daily briefing
 *   POST /api/admin/insights/ask                a question (or a kind) -> answer
 *   GET  /api/admin/insights/records?source=    the rows behind an answer
 */
'use strict';

const express = require('express');
const { requireAuth } = require('./auth');
const E = require('./owner_ai_engine');

const { money, lc, trend, signedMoney } = E;
const AI_TIMEOUT_MS = 12000;
const WORDED_PER_HOUR = 300;

const isSoft = (e) => e && (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR');

function defaultAi() {
  const deepseek = process.env.DEEPSEEK_API_KEY || '';
  const gemini = process.env.GEMINI_API_KEY || '';
  if (!deepseek && !gemini) return null;
  const { createClient } = require('./ai/vesopa_ai');
  return createClient({
    app: 'vesopa_server',
    apiKey: deepseek,
    gemini: gemini ? { apiKey: gemini } : undefined,
    dailyCapUsd: Number(process.env.AI_DAILY_CAP_USD || 5),
    logDir: process.env.AI_LOG_DIR || '',
  });
}

const kpi = (label, value, kind, changePct = null, goodWhen = 'up') => ({ label, value, kind, change_pct: changePct, good_when: goodWhen });

// ---- the answers ----------------------------------------------------------------

const DEFINITIONS = {
  takings: 'Takings: what customers paid at every venue on closed sales, VAT included, after discounts, as each venue\'s Z report counts them. Practice (demo) venues are left out.',
  income: 'Vesopa income: invoices marked paid in the period. Monthly recurring revenue: every active subscription as a month (a yearly one counts a twelfth). Overdue: invoices past their due date and not paid.',
  devices: 'Online: a device heard from in the last 15 minutes (a till starting, an update check-in or its hardware report, every ten minutes). Versions: devices seen in the last 30 days.',
  signups: 'New venues: venues created in the period. Sign-up checks: venues that started signing up from Vesopa Go or go.vesopa.com (identity, then the licence).',
  payments: 'Payments by how customers paid, across every venue, on closed sales.',
};

function trendBars(daily, hourly, period) {
  const single = period.key === 'today' || period.key === 'yesterday';
  if (single) {
    const h = new Map();
    for (const r of hourly || []) h.set(Number(r.hour), (h.get(Number(r.hour)) || 0) + (Number(r.gross_minor) || 0));
    const hours = [...h.keys()].sort((a, b) => a - b);
    return { type: 'bars', title: 'Takings by hour, every venue', kind: 'money', items: hours.map((x) => ({ label: String(x).padStart(2, '0'), value: h.get(x) })) };
  }
  const d = new Map();
  for (const r of daily || []) d.set(String(r.day), (d.get(String(r.day)) || 0) + (Number(r.gross_minor) || 0));
  return {
    type: 'bars',
    title: 'Takings by day, every venue',
    kind: 'money',
    items: [...d.keys()].sort().map((k) => {
      const day = new Date(k + 'T12:00:00');
      return { label: `${day.toLocaleString('en-GB', { weekday: 'short' })} ${day.getDate()}`, value: d.get(k) };
    }),
  };
}

const venueColumns = [
  { key: 'name', label: 'Venue', kind: 'text' },
  { key: 'gross_minor', label: 'Takings', kind: 'money' },
  { key: 'sales', label: 'Sales', kind: 'count' },
  { key: 'average_minor', label: 'Average', kind: 'money' },
  { key: 'change_pct', label: 'Change', kind: 'pct' },
];

const BUILDERS = {
  summary(d, ctx) {
    const t = E.platformTotals(d.venues);
    const top = d.venues.filter((v) => v.gross_minor > 0).slice(0, 5);
    return {
      title: 'Takings across Vesopa',
      headline: t.sales
        ? `Every venue together took ${money(t.gross_minor)} from ${t.sales} sales${t.change_pct == null ? '' : `${trend(t.change_pct)} against ${lc(ctx.period.compare.label)}`}. ${t.trading} of ${t.venues} venues traded.`
        : `No closed sales at any venue yet in ${lc(ctx.period.label)}.`,
      why: top.slice(0, 3).map((v) => `${v.name}: ${money(v.gross_minor)} from ${v.sales} sales${trend(v.change_pct)}.`),
      cards: [
        { type: 'kpis', items: [kpi('Takings', t.gross_minor, 'money', t.change_pct), kpi('Sales', t.sales, 'count'), kpi('Average spend', t.average_minor, 'money'), kpi('Venues trading', t.trading, 'count')] },
        trendBars(d.daily, d.hourly, ctx.period),
        { type: 'bars', title: 'Top venues', kind: 'money', items: top.map((v) => ({ label: v.name, value: v.gross_minor, compare: v.before_minor })), compare_label: 'Before' },
      ],
      facts: { takings: money(t.gross_minor), before: money(t.before_minor), change_pct: t.change_pct, sales: t.sales, average: money(t.average_minor), venues_trading: t.trading, venues: t.venues, top: top.map((v) => ({ venue: v.name, takings: money(v.gross_minor), change_pct: v.change_pct })) },
      definitions: [DEFINITIONS.takings],
      records: 'venues',
    };
  },

  venues(d) {
    const rows = d.venues;
    const live = rows.filter((v) => v.status !== 'archived');
    const silent = live.filter((v) => v.sales === 0);
    return {
      title: 'Venues',
      headline: live.length
        ? `${live[0].name} took the most: ${money(live[0].gross_minor)}${trend(live[0].change_pct)}. ${silent.length} of ${live.length} venues had no sales.`
        : 'No venues yet.',
      why: live.slice(0, 4).map((v) => `${v.name}: ${money(v.gross_minor)} (${v.share_pct ?? 0}% of all takings), average spend ${money(v.average_minor)}.`),
      cards: [
        { type: 'bars', title: 'Takings by venue', kind: 'money', items: live.filter((v) => v.gross_minor > 0).slice(0, 12).map((v) => ({ label: v.name, value: v.gross_minor, compare: v.before_minor })), compare_label: 'Before' },
        { type: 'table', title: 'Every venue', columns: venueColumns, rows: live },
      ],
      facts: { venues: live.slice(0, 15).map((v) => ({ venue: v.name, takings: money(v.gross_minor), sales: v.sales, change_pct: v.change_pct, share_pct: v.share_pct })), no_sales: silent.length },
      definitions: [DEFINITIONS.takings],
      records: 'venues',
    };
  },

  why_change(d, ctx) {
    const t = E.platformTotals(d.venues);
    const diff = t.gross_minor - t.before_minor;
    const movers = [...d.venues].filter((v) => v.diff_minor !== 0).sort((a, b) => Math.abs(b.diff_minor) - Math.abs(a.diff_minor));
    const along = movers.filter((v) => Math.sign(v.diff_minor) === Math.sign(diff)).slice(0, 5);
    const against = movers.filter((v) => Math.sign(v.diff_minor) === -Math.sign(diff)).slice(0, 3);
    const lost = d.venues.filter((v) => v.sales === 0 && v.before_minor > 0);
    return {
      title: diff < 0 ? 'Why takings fell' : 'Why takings rose',
      headline: !t.gross_minor && !t.before_minor
        ? 'No sales in either period, so there is nothing to explain yet.'
        : `Every venue together took ${money(t.gross_minor)}, ${money(Math.abs(diff))}${t.change_pct != null ? ` (${Math.abs(t.change_pct)}%)` : ''} ${diff < 0 ? 'lower' : 'higher'} than ${lc(ctx.period.compare.label)}.`,
      why: [
        ...(along.length ? [`Most of it: ${along.slice(0, 3).map((v) => `${v.name} ${signedMoney(v.diff_minor)}`).join(', ')}.`] : []),
        ...(against.length ? [`Going the other way: ${against.map((v) => `${v.name} ${signedMoney(v.diff_minor)}`).join(', ')}.`] : []),
        ...(lost.length ? [`${lost.length} venue${lost.length === 1 ? '' : 's'} that traded before took nothing: ${lost.slice(0, 3).map((v) => v.name).join(', ')}.`] : []),
      ],
      cards: [
        { type: 'kpis', items: [kpi('Takings', t.gross_minor, 'money', t.change_pct), kpi('Difference', diff, 'money')] },
        { type: 'bars', title: 'Venues that moved it', kind: 'money', signed: true, items: [...along, ...against].map((v) => ({ label: v.name, value: v.diff_minor })) },
      ],
      facts: { takings: money(t.gross_minor), before: money(t.before_minor), difference: money(Math.abs(diff)), direction: diff < 0 ? 'down' : 'up', change_pct: t.change_pct, movers: along.map((v) => ({ venue: v.name, change: signedMoney(v.diff_minor) })), against: against.map((v) => ({ venue: v.name, change: signedMoney(v.diff_minor) })), stopped_trading: lost.map((v) => v.name) },
      definitions: [DEFINITIONS.takings],
      records: 'venues',
    };
  },

  revenue(d, ctx) {
    const i = d.income;
    return {
      title: 'Vesopa income',
      headline: `Monthly recurring revenue is ${money(i.mrr_minor)} from ${i.paying_venues} paying venue${i.paying_venues === 1 ? '' : 's'} (${money(i.arr_minor)} a year). ${money(i.paid_minor)} was paid in ${lc(ctx.period.label)}${trend(i.paid_change_pct)}; ${money(i.overdue_minor)} is overdue.`,
      why: [
        ...(i.overdue_venues.length ? [`Overdue: ${i.overdue_venues.slice(0, 3).map((v) => `${v.name} ${money(v.amount_minor)}`).join(', ')}.`] : ['Nothing is overdue.']),
        ...(i.top_payers.length ? [`Biggest subscriptions: ${i.top_payers.slice(0, 3).map((p) => `${p.name} ${money(p.monthly_minor)} a month`).join(', ')}.`] : []),
        `${i.new_subscriptions} new subscription${i.new_subscriptions === 1 ? '' : 's'} in the period.`,
      ],
      cards: [
        { type: 'kpis', items: [kpi('Monthly recurring', i.mrr_minor, 'money'), kpi('Paid in period', i.paid_minor, 'money', i.paid_change_pct), kpi('Overdue', i.overdue_minor, 'money', null, 'down'), kpi('Paying venues', i.paying_venues, 'count')] },
        { type: 'table', title: 'Overdue invoices by venue', columns: [{ key: 'name', label: 'Venue', kind: 'text' }, { key: 'amount_minor', label: 'Overdue', kind: 'money' }, { key: 'count', label: 'Invoices', kind: 'count' }, { key: 'oldest_due', label: 'Oldest due', kind: 'text' }], rows: i.overdue_venues.map((v) => ({ ...v, oldest_due: String(v.oldest_due).slice(0, 10) })) },
        { type: 'bars', title: 'Biggest subscriptions (a month)', kind: 'money', items: i.top_payers.slice(0, 8).map((p) => ({ label: p.name, value: p.monthly_minor })) },
      ],
      facts: { mrr: money(i.mrr_minor), arr: money(i.arr_minor), paying_venues: i.paying_venues, paid: money(i.paid_minor), paid_before: money(i.paid_before_minor), paid_change_pct: i.paid_change_pct, overdue: money(i.overdue_minor), overdue_invoices: i.overdue_count, overdue_venues: i.overdue_venues.slice(0, 6).map((v) => ({ venue: v.name, overdue: money(v.amount_minor) })), new_subscriptions: i.new_subscriptions },
      definitions: [DEFINITIONS.income],
      records: 'invoices',
    };
  },

  licences(d) {
    const l = d.licences;
    return {
      title: 'Licences',
      headline: `${l.counts.active || 0} venues active, ${l.counts.paused || 0} paused, ${l.counts.archived || 0} archived.${l.holds_in_grace ? ` ${l.holds_in_grace} app or module holds are in their grace day.` : ''}`,
      why: [
        ...(l.plans.length ? [`Plans: ${l.plans.slice(0, 4).map((p) => `${p.name} ${p.venues}`).join(', ')}.`] : []),
        ...(l.paused.length ? [`Paused: ${l.paused.slice(0, 3).map((p) => `${p.name}${p.reason ? ` (${p.reason})` : ''}`).join(', ')}.`] : []),
      ],
      cards: [
        { type: 'kpis', items: [kpi('Active venues', l.counts.active || 0, 'count'), kpi('Paused', l.counts.paused || 0, 'count', null, 'down'), kpi('Archived', l.counts.archived || 0, 'count', null, 'down'), kpi('Holds stopped', l.holds_stopped, 'count', null, 'down')] },
        { type: 'bars', title: 'Venues by plan', kind: 'count', items: l.plans.map((p) => ({ label: p.name, value: p.venues })) },
        { type: 'table', title: 'Paused venues', columns: [{ key: 'name', label: 'Venue', kind: 'text' }, { key: 'since', label: 'Since', kind: 'text' }, { key: 'reason', label: 'Reason', kind: 'text' }], rows: l.paused },
      ],
      facts: { active: l.counts.active || 0, paused: l.counts.paused || 0, archived: l.counts.archived || 0, plans: l.plans, paused_venues: l.paused.map((p) => p.name) },
      definitions: ['Active, paused and archived as set on admin.vesopa.com. Practice (demo) venues are left out.'],
      records: 'venues',
    };
  },

  devices(d) {
    const v = d.devices;
    return {
      title: 'Devices and health',
      headline: v.total
        ? `${v.online} of ${v.total} devices are online now (${v.online_pct}%). ${v.quiet_venues.length} venue${v.quiet_venues.length === 1 ? ' has' : 's have'} every device offline for a day or more.`
        : 'No devices have reported in yet.',
      why: [
        ...v.quiet_venues.slice(0, 3).map((q) => `${q.name}: ${q.devices} device${q.devices === 1 ? '' : 's'}, none online${q.hours != null ? ` for ${q.hours} hours` : ''}.`),
        ...v.apps.slice(0, 3).map((a) => `${a.app}: ${a.versions.slice(0, 2).map((x) => `${x.version} on ${x.devices}`).join(', ')}.`),
      ],
      cards: [
        { type: 'kpis', items: [kpi('Devices', v.total, 'count'), kpi('Online now', v.online, 'count'), kpi('Offline', v.offline, 'count', null, 'down'), kpi('Venues gone quiet', v.quiet_venues.length, 'count', null, 'down')] },
        { type: 'bars', title: 'Devices by kind (online / all)', kind: 'count', items: v.kinds.map((k) => ({ label: k.kind, value: k.online, compare: k.total })), compare_label: 'All' },
        { type: 'table', title: 'Venues with every device offline', columns: [{ key: 'name', label: 'Venue', kind: 'text' }, { key: 'devices', label: 'Devices', kind: 'count' }, { key: 'hours', label: 'Hours quiet', kind: 'count' }], rows: v.quiet_venues },
      ],
      facts: { devices: v.total, online: v.online, offline: v.offline, online_pct: v.online_pct, quiet_venues: v.quiet_venues.slice(0, 8).map((q) => ({ venue: q.name, devices: q.devices, hours: q.hours })), versions: v.apps.map((a) => ({ app: a.app, versions: a.versions.slice(0, 3) })) },
      definitions: [DEFINITIONS.devices],
      records: 'devices',
    };
  },

  signups(d, ctx) {
    const s = d.signups;
    return {
      title: 'New venues',
      headline: `${s.new_venues} new venue${s.new_venues === 1 ? '' : 's'} in ${lc(ctx.period.label)}${trend(s.change_pct)}. ${s.pipeline.ready} sign-up${s.pipeline.ready === 1 ? ' has' : 's have'} passed every check; ${s.pipeline.identity + s.pipeline.licence} still to finish.`,
      why: [
        ...(s.list.length ? [`New: ${s.list.slice(0, 4).map((v) => v.name).join(', ')}.`] : []),
        `Sign-up checks: ${s.pipeline.identity} at identity, ${s.pipeline.licence} at the licence, ${s.pipeline.ready} done.`,
        ...(s.trials_ending.length ? [`Free trials ending first: ${s.trials_ending.slice(0, 3).map((t) => `${t.name} (${t.trial_end})`).join(', ')}.`] : []),
      ],
      cards: [
        { type: 'kpis', items: [kpi('New venues', s.new_venues, 'count', s.change_pct), kpi('Sign-ups started', s.started, 'count'), kpi('Checks passed', s.pipeline.ready, 'count'), kpi('Trials ending', s.trials_ending.length, 'count', null, 'down')] },
        { type: 'table', title: 'New venues', columns: [{ key: 'name', label: 'Venue', kind: 'text' }, { key: 'created', label: 'Created', kind: 'text' }, { key: 'plan', label: 'Plan', kind: 'text' }, { key: 'status', label: 'Status', kind: 'text' }], rows: s.list },
        { type: 'table', title: 'Free trials ending', columns: [{ key: 'name', label: 'Venue', kind: 'text' }, { key: 'trial_end', label: 'Trial ends', kind: 'text' }], rows: s.trials_ending },
      ],
      facts: { new_venues: s.new_venues, before: s.new_before, change_pct: s.change_pct, started: s.started, pipeline: s.pipeline, new: s.list.slice(0, 10).map((v) => v.name), trials_ending: s.trials_ending },
      definitions: [DEFINITIONS.signups],
      records: 'signups',
    };
  },

  payments(d) {
    const p = d.payments;
    return {
      title: 'How customers pay',
      headline: p.total_minor
        ? `${p.card_share_pct}% of everything paid at Vesopa venues was by card: ${money(p.card_minor)} of ${money(p.total_minor)}, ${p.card_count} card payments.`
        : 'No payments in this period yet.',
      why: p.methods.slice(0, 4).map((m) => `${m.method}: ${money(m.total_minor)} (${m.share_pct}%)${trend(m.change_pct)}.`),
      cards: [
        { type: 'kpis', items: [kpi('All payments', p.total_minor, 'money'), kpi('By card', p.card_minor, 'money'), kpi('Card share', p.card_share_pct, 'pct'), kpi('Card payments', p.card_count, 'count')] },
        { type: 'bars', title: 'By how they paid', kind: 'money', items: p.methods.map((m) => ({ label: m.method, value: m.total_minor })) },
      ],
      facts: { total: money(p.total_minor), card: money(p.card_minor), card_share_pct: p.card_share_pct, card_payments: p.card_count, methods: p.methods.map((m) => ({ method: m.method, total: money(m.total_minor), share_pct: m.share_pct, change_pct: m.change_pct })) },
      definitions: [DEFINITIONS.payments],
      records: 'venues',
    };
  },

  focus(d, ctx) {
    const t = E.platformTotals(d.venues);
    const { alerts, actions } = E.alerts({ venues: d.venues, totals: t, income: d.income, devices: d.devices, signups: d.signups, licences: d.licences });
    return {
      title: 'What needs you',
      headline: actions.length ? `${actions.length} thing${actions.length === 1 ? '' : 's'} worth your attention, starting with: ${lc(actions[0].title)}.` : 'Nothing stands out: takings, payments and devices look steady.',
      why: alerts.slice(0, 4).map((a) => `${a.title}. ${a.detail}`),
      next: actions,
      cards: [
        { type: 'kpis', items: [kpi('Takings', t.gross_minor, 'money', t.change_pct), kpi('Monthly recurring', d.income.mrr_minor, 'money'), kpi('Overdue', d.income.overdue_minor, 'money', null, 'down'), kpi('Devices online', d.devices.online, 'count')] },
        ...(alerts.length ? [{ type: 'alerts', items: alerts }] : []),
      ],
      facts: { takings: money(t.gross_minor), change_pct: t.change_pct, mrr: money(d.income.mrr_minor), overdue: money(d.income.overdue_minor), alerts, actions },
      definitions: [DEFINITIONS.takings, DEFINITIONS.income, DEFINITIONS.devices],
      records: 'venues',
    };
  },
};

const NEEDS = {
  summary: ['takings', 'trend'],
  venues: ['takings'],
  why_change: ['takings'],
  revenue: ['income'],
  licences: ['overview'],
  devices: ['overview', 'versions'],
  signups: ['signups'],
  payments: ['payments'],
  focus: ['takings', 'income', 'overview', 'signups'],
  revenue_and_signups: ['income', 'signups'],
};

// ---- the routes ---------------------------------------------------------------------

function ownerAiRoutes({ pool, secret, ai = undefined, now = () => new Date() }) {
  const router = express.Router();
  const model = ai === undefined ? defaultAi() : ai;
  const worded = [];

  // Platform admin only, checked here as well as by the gate in front.
  const gate = [
    secret ? requireAuth(secret) : (req, _res, next) => next(),
    (req, res, next) => (req.user && req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Administrator access only' })),
  ];

  async function rows(sql, params = []) {
    try {
      const [r] = await pool.query(sql, params);
      return r;
    } catch (e) {
      if (isSoft(e)) return [];
      throw e;
    }
  }

  async function offices() {
    let list = await rows(
      `SELECT id, name, contact_email, status, plan, created_at, paused_at, pause_reason
         FROM offices WHERE demo_of IS NULL ORDER BY name`);
    if (!list.length) list = await rows('SELECT id, name, contact_email, status, plan, created_at FROM offices ORDER BY name');
    return list;
  }

  /** Each venue's takings in a window: one row per venue (grouped by the venue). */
  const takings = (from, to) => rows(
    `SELECT o.email AS office, COUNT(*) AS sales, COALESCE(SUM(o.total_minor), 0) AS gross_minor, MAX(o.closed_at) AS last_sale_at
       FROM epos_orders o
      WHERE o.closed_at IS NOT NULL AND o.closed_at >= ? AND o.closed_at < ?
      GROUP BY o.email`, [from, to]);

  const byDay = (from, to) => rows(
    `SELECT o.email AS office, DATE_FORMAT(o.closed_at, '%Y-%m-%d') AS day, COALESCE(SUM(o.total_minor), 0) AS gross_minor
       FROM epos_orders o
      WHERE o.closed_at IS NOT NULL AND o.closed_at >= ? AND o.closed_at < ?
      GROUP BY o.email, day`, [from, to]);

  const byHour = (from, to) => rows(
    `SELECT o.email AS office, HOUR(o.closed_at) AS hour, COALESCE(SUM(o.total_minor), 0) AS gross_minor
       FROM epos_orders o
      WHERE o.closed_at IS NOT NULL AND o.closed_at >= ? AND o.closed_at < ?
      GROUP BY o.email, hour`, [from, to]);

  const payMethods = (from, to) => rows(
    `SELECT o.email AS office, p.method, COUNT(*) AS count, COALESCE(SUM(COALESCE(p.applied_minor, p.amount_minor)), 0) AS total_minor
       FROM epos_payments p
       JOIN epos_orders o ON o.id = p.order_id
      WHERE o.closed_at IS NOT NULL AND o.closed_at >= ? AND o.closed_at < ?
      GROUP BY o.email, p.method`, [from, to]);

  async function facts(period, intent) {
    const needs = NEEDS[intent] || NEEDS.summary;
    const list = await offices();
    const known = new Set(list.map((o) => String(o.contact_email).toLowerCase()));
    const ours = (r) => known.has(String(r.office).toLowerCase()); // demo venues out
    const single = period.key === 'today' || period.key === 'yesterday';
    const [latest, cur, prev, daily, hourly, subs, invoices, overview, versions, onboarding, payNow, payBefore] = await Promise.all([
      // When the newest sale reached Vesopa, for every answer's freshness line.
      rows(`SELECT o.email AS office, MAX(o.closed_at) AS last_sale_at FROM epos_orders o
             WHERE o.closed_at IS NOT NULL AND o.closed_at >= ? GROUP BY o.email`, [E.sqlTime(new Date(now().getTime() - 3 * 86400000))]),
      needs.includes('takings') || needs.includes('trend') ? takings(period.from, period.to) : [],
      needs.includes('takings') || needs.includes('trend') ? takings(period.compare.from, period.compare.to) : [],
      needs.includes('trend') && !single ? byDay(period.from, period.to) : [],
      needs.includes('trend') && single ? byHour(period.from, period.to) : [],
      needs.includes('income') ? rows(
        `SELECT s.office_id, o.name, o.status AS office_status, s.amount_minor, s.interval_unit, s.status, s.created_at
           FROM subscriptions s JOIN offices o ON o.id = s.office_id
          WHERE o.demo_of IS NULL`) : [],
      needs.includes('income') ? rows(
        `SELECT i.office_id, o.name, i.amount_minor, i.status, i.due_on, i.paid_at
           FROM subscription_invoices i JOIN offices o ON o.id = i.office_id
          WHERE o.demo_of IS NULL AND (i.status <> 'paid' OR i.paid_at >= ?)`, [period.compare.from]) : [],
      needs.includes('overview') ? require('./admin_overview').overview(pool) : null,
      needs.includes('versions') ? rows(
        `SELECT app, COALESCE(version, 'unknown') AS version, COUNT(*) AS devices
           FROM bo_app_installs WHERE last_seen_at > (NOW() - INTERVAL 30 DAY)
          GROUP BY app, version`) : [],
      needs.includes('signups') ? rows(
        `SELECT g.office, g.legal_name, g.identity_status, g.licence_status, g.trial_end, o.name
           FROM go_onboarding g LEFT JOIN offices o ON o.contact_email = g.office`) : [],
      needs.includes('payments') ? payMethods(period.from, period.to) : [],
      needs.includes('payments') ? payMethods(period.compare.from, period.compare.to) : [],
    ]);
    return {
      offices: list,
      venues: E.venueTable(list, cur.filter(ours), prev.filter(ours)),
      daily: daily.filter(ours),
      hourly: hourly.filter(ours),
      income: E.income(subs, invoices, period),
      licences: E.licences(list, overview),
      devices: E.devices(overview, versions, now().getTime()),
      signups: E.signups(list, onboarding, period),
      payments: E.payments(payNow.filter(ours), payBefore.filter(ours)),
      last_sale_at: latest.filter(ours).reduce((m, r) => (r.last_sale_at && (!m || new Date(r.last_sale_at) > m) ? new Date(r.last_sale_at) : m), null),
    };
  }

  function wordingAllowed() {
    const t = Date.now();
    while (worded.length && t - worded[0] > 3600e3) worded.shift();
    if (worded.length >= WORDED_PER_HOUR) return false;
    worded.push(t);
    return true;
  }

  async function word(question, built, context) {
    if (!model) return { words: null, status: 'off' };
    if (!wordingAllowed()) return { words: null, status: 'limit' };
    const { redact } = require('./ai/vesopa_ai');
    const facts = { context, figures: built.facts, plain_answer: { headline: built.headline, why: built.why } };
    try {
      const r = await model.chat({
        purpose: 'advisor',
        json: true,
        timeoutMs: AI_TIMEOUT_MS,
        messages: [
          {
            role: 'system',
            content: [
              'You are Vesopa AI, the business advisor for the owner of Vesopa, a UK company that sells EPOS tills, the Vesopa Go app and services to hospitality and retail venues.',
              'You explain figures that have ALREADY been calculated from Vesopa\'s systems: every venue\'s takings, Vesopa\'s own income, licences, devices and sign-ups. Use ONLY figures that appear in FACTS, written exactly as they appear there. Never calculate, estimate or invent a figure, a venue or a reason.',
              'Write in clear, warm British English for a busy company owner: what happened, why it matters, what he could do next. No jargon, no markdown, no emojis. Read-only: suggest, never claim to have changed anything.',
              'Answer JSON only: {"answer": "2 or 3 sentences that answer the question directly", "why": ["up to 3 short reasons, each citing a figure"], "next": [{"title": "a short action", "why": "one sentence"}] (up to 3)}.',
            ].join(' '),
          },
          { role: 'user', content: `QUESTION: ${redact(String(question || built.title).slice(0, 400))}\nFACTS: ${JSON.stringify(facts)}` },
        ],
      });
      let j;
      try { j = JSON.parse(r.content); } catch { return { words: null, status: 'unusable' }; }
      const answer = String(j.answer || '').trim().slice(0, 700);
      const why = (Array.isArray(j.why) ? j.why : []).map((x) => String(x).trim().slice(0, 240)).filter(Boolean).slice(0, 3);
      const next = (Array.isArray(j.next) ? j.next : []).map((x) => ({ title: String((x && x.title) || '').trim().slice(0, 80), why: String((x && x.why) || '').trim().slice(0, 240) })).filter((x) => x.title).slice(0, 3);
      if (!answer) return { words: null, status: 'unusable' };
      const bad = E.checkNarrative([answer, ...why, ...next.map((n) => `${n.title} ${n.why}`)].join(' '), facts);
      if (bad.length) return { words: null, status: 'rejected' };
      return { words: { answer, why, next }, status: 'on' };
    } catch (e) {
      return { words: null, status: e.budget ? 'budget' : 'unavailable' };
    }
  }

  const NOTES = {
    off: 'Plain wording: no AI model is set up on the server. The figures are exact either way.',
    budget: 'Plain wording: today\'s AI budget is used up. The figures are exact either way.',
    unavailable: 'Plain wording: the AI model did not answer in time. The figures are exact either way.',
    unusable: 'Plain wording: the AI model\'s answer could not be used. The figures are exact either way.',
    rejected: 'Plain wording: the AI model quoted a figure that is not in the data, so its answer was discarded.',
    limit: 'Plain wording: many questions this hour. The figures are exact either way.',
  };

  function meta(period, built, d) {
    return {
      period: { key: period.key, label: period.label, from: period.from, to: period.to },
      compare: period.compare,
      site: { id: null, label: `All venues (${d.offices.filter((o) => o.status !== 'archived').length})` },
      definitions: built.definitions || [],
      freshness: {
        last_sale_at: d.last_sale_at ? E.sqlTime(d.last_sale_at) : null,
        computed_at: E.sqlTime(now()),
        note: 'Sales count once a till has sent them to Vesopa; a till that is offline sends them when it reconnects.',
      },
      records: { source: built.records, period: period.key, site: null },
      read_only: true,
    };
  }

  async function answer({ intent, periodKey, question, wantWords }) {
    const period = E.resolvePeriod(periodKey, now());
    const d = await facts(period, intent);
    const built = BUILDERS[intent](d, { period });
    const w = wantWords ? await word(question, built, { period: period.label, compared_with: period.compare.label }) : { words: null, status: 'not_asked' };
    return {
      intent,
      title: built.title,
      headline: built.headline,
      why: built.why || [],
      next: built.next || [],
      ai: w.words,
      ai_status: w.status,
      ai_note: wantWords && w.status !== 'on' ? NOTES[w.status] || null : null,
      cards: built.cards,
      follow_ups: E.FOLLOW_UPS[intent] || [],
      meta: meta(period, built, d),
    };
  }

  router.post('/insights/ask', ...gate, express.json(), async (req, res, next) => {
    try {
      const b = req.body || {};
      const question = String(b.question || '').trim().slice(0, 500);
      const prev = b.previous && typeof b.previous === 'object'
        ? { intent: E.INTENTS.includes(b.previous.intent) ? b.previous.intent : null, period: E.PERIODS.includes(b.previous.period) ? b.previous.period : null }
        : null;
      let intent = E.INTENTS.includes(b.intent) ? b.intent : null;
      let periodKey = E.PERIODS.includes(b.period) ? b.period : null;
      if (!intent) {
        const p = E.parseQuestion(question, prev);
        intent = p.intent;
        periodKey = periodKey || p.period;
        if (intent === 'unknown' && model && question) {
          try {
            const { redact } = require('./ai/vesopa_ai');
            const r = await model.chat({
              purpose: 'advisor', json: true, timeoutMs: 8000, maxTokens: 120,
              messages: [
                { role: 'system', content: `Classify a question from the owner of Vesopa (an EPOS company) about his business. Answer JSON only: {"intent": one of ${JSON.stringify([...E.INTENTS, 'unknown'])}, "period": one of ${JSON.stringify(E.PERIODS)}}. summary = all venues' takings; venues = ranking venues; why_change = why takings changed; revenue = Vesopa's own income, subscriptions, overdue invoices; licences = active/paused venues and plans; devices = tills and devices online, versions; signups = new venues; payments = card/cash; focus = what needs attention. "unknown" for anything else.` },
                { role: 'user', content: redact(question) },
              ],
            });
            const j = JSON.parse(r.content);
            if (E.INTENTS.includes(j.intent)) intent = j.intent;
            if (E.PERIODS.includes(j.period)) periodKey = j.period;
          } catch { /* the rules' answer stands */ }
        }
      }
      if (intent === 'unknown') {
        return res.json({
          intent: 'unknown',
          title: 'Ask about the business',
          headline: 'I can answer about every venue\'s takings, Vesopa\'s income and overdue invoices, licences, devices, new venues and how customers pay. Try one of these.',
          why: [], next: [], cards: [], follow_ups: E.SUGGESTIONS.slice(0, 6), meta: { read_only: true },
        });
      }
      res.json({ ...(await answer({ intent, periodKey: periodKey || 'today', question, wantWords: b.words !== false })), question });
    } catch (e) { next(e); }
  });

  router.get('/insights/briefing', ...gate, async (req, res, next) => {
    try {
      const week = E.resolvePeriod('last_7_days', now());
      const today = E.resolvePeriod('today', now());
      const month = E.resolvePeriod('this_month', now());
      const [dToday, dWeek, dMonth] = await Promise.all([facts(today, 'summary'), facts(week, 'focus'), facts(month, 'revenue_and_signups')]);
      const sToday = BUILDERS.summary(dToday, { period: today });
      const focus = BUILDERS.focus(dWeek, { period: week });
      // Invoices are monthly, so the briefing's income is the month so far.
      const revenue = BUILDERS.revenue(dMonth, { period: month });
      const signupsB = BUILDERS.signups(dMonth, { period: month });
      const headline = `${sToday.headline} ${revenue.headline}`;
      const w = await word('Give me my daily briefing on the whole of Vesopa: how the venues are trading today, our income and overdue invoices, and what needs my attention.',
        { title: 'Daily briefing', headline, why: focus.why, facts: { today: sToday.facts, last_7_days: focus.facts, income: revenue.facts, new_venues_this_month: signupsB.facts } },
        { today: today.label, week: week.label, month: month.label });
      const hour = now().getHours();
      res.json({
        greeting: hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening',
        name: String(req.user && req.user.email || '').replace(/ \(admin\.vesopa\.com\)$/, '').split('@')[0] || 'there',
        headline,
        ai: w.words,
        ai_status: w.status,
        ai_note: w.status !== 'on' ? NOTES[w.status] || null : null,
        today: { label: today.label, compare: today.compare.label, cards: sToday.cards.slice(0, 2) },
        income: { headline: revenue.headline, cards: revenue.cards.slice(0, 1) },
        signups: { headline: signupsB.headline },
        alerts: (focus.cards.find((c) => c.type === 'alerts') || { items: [] }).items,
        actions: focus.next,
        meta: meta(today, { definitions: [DEFINITIONS.takings, DEFINITIONS.income, 'Alerts and suggestions look at the last 7 days against the 7 before.'], records: 'venues' }, dToday),
      });
    } catch (e) { next(e); }
  });

  /** The rows behind an answer. Venue names and figures; no contact details. */
  router.get('/insights/records', ...gate, async (req, res, next) => {
    try {
      const period = E.resolvePeriod(String(req.query.period || 'today'), now());
      const source = String(req.query.source || 'venues');
      let title;
      let columns;
      let list;
      if (source === 'venues') {
        const d = await facts(period, 'venues');
        title = 'Takings by venue';
        columns = [...venueColumns, { key: 'before_minor', label: 'Before', kind: 'money' }, { key: 'status', label: 'Status', kind: 'text' }];
        list = d.venues;
      } else if (source === 'invoices') {
        const inv = await rows(
          `SELECT o.name, i.amount_minor, i.status, i.due_on, i.paid_at
             FROM subscription_invoices i JOIN offices o ON o.id = i.office_id
            WHERE o.demo_of IS NULL AND (i.status <> 'paid' OR i.paid_at >= ?)
            ORDER BY i.due_on DESC LIMIT 300`, [period.from]);
        title = 'Invoices';
        columns = [{ key: 'name', label: 'Venue', kind: 'text' }, { key: 'amount_minor', label: 'Amount', kind: 'money' }, { key: 'status', label: 'Status', kind: 'text' }, { key: 'due_on', label: 'Due', kind: 'text' }, { key: 'paid', label: 'Paid', kind: 'text' }];
        list = inv.map((i) => ({ name: i.name, amount_minor: Number(i.amount_minor) || 0, status: i.status, due_on: String(i.due_on || '').slice(0, 10), paid: i.paid_at ? E.sqlTime(new Date(i.paid_at)).slice(0, 16) : '' }));
      } else if (source === 'devices') {
        const ov = await require('./admin_overview').overview(pool);
        title = 'Devices by venue';
        columns = [{ key: 'name', label: 'Venue', kind: 'text' }, { key: 'device_count', label: 'Devices', kind: 'count' }, { key: 'online', label: 'Online', kind: 'count' }, { key: 'last_seen', label: 'Last heard', kind: 'text' }];
        list = (ov.venues || []).map((v) => ({ name: v.name, device_count: v.device_count, online: v.online, last_seen: v.last_seen_at ? String(v.last_seen_at).slice(0, 16).replace('T', ' ') : '' }));
      } else if (source === 'signups') {
        const d = await facts(period, 'signups');
        title = 'New venues';
        columns = [{ key: 'name', label: 'Venue', kind: 'text' }, { key: 'created', label: 'Created', kind: 'text' }, { key: 'plan', label: 'Plan', kind: 'text' }, { key: 'status', label: 'Status', kind: 'text' }];
        list = d.signups.list;
      } else {
        return res.status(400).json({ error: 'Which records?' });
      }
      res.json({
        source, title,
        period: { key: period.key, label: period.label, from: period.from, to: period.to },
        site: { id: null, label: 'All venues' },
        columns, rows: list.slice(0, 300),
        truncated: list.length > 300,
        note: list.length > 300 ? 'The first 300 are shown.' : null,
      });
    } catch (e) { next(e); }
  });

  return router;
}

module.exports = { ownerAiRoutes, BUILDERS };
