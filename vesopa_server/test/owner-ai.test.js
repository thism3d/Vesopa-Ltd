/**
 * Vesopa AI for the owner of Vesopa (src/owner_ai.js, owner_ai_engine.js).
 * No database and no model: the pool answers from rows written here.
 *
 * THE RULES THAT MATTER
 *
 *   1. Only admin.vesopa.com's service key (or a platform admin) gets in: no
 *      key, a venue's own sign-in and a wrong key are all refused.
 *   2. The figures are arithmetic: takings per venue added up, monthly
 *      recurring revenue, overdue, devices, sign-ups, payments.
 *   3. Practice (demo) venues are left out.
 *   4. A model's sentence with a figure not in the facts is thrown away, and
 *      no email address is ever sent to the model.
 *   5. Read-only: no statement writes.
 */
process.env.ADMIN_SERVICE_KEY = 'k'.repeat(40);
const assert = require('assert');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');

const E = require('../src/owner_ai_engine');
const { ownerAiRoutes } = require('../src/owner_ai');

const SECRET = 'owner-ai-test-secret';
const NOW = new Date(2026, 10, 21, 15, 0, 0); // Sat 21 Nov 2026, 15:00
let passed = 0;
const ok = (n) => { passed++; console.log('  ok -', n); };

// ---- the engine ------------------------------------------------------------------

(function engine() {
  const offices = [
    { id: 1, name: 'The Bridge', contact_email: 'bridge@x.test', status: 'active', plan: 'Pro' },
    { id: 2, name: 'Neath Arms', contact_email: 'neath@x.test', status: 'active', plan: 'Pro' },
    { id: 3, name: 'Quiet Cafe', contact_email: 'quiet@x.test', status: 'active', plan: 'Lite' },
  ];
  const v = E.venueTable(offices,
    [{ office: 'bridge@x.test', sales: 40, gross_minor: 80000 }, { office: 'NEATH@x.test', sales: 10, gross_minor: 20000 }],
    [{ office: 'bridge@x.test', sales: 50, gross_minor: 100000 }, { office: 'quiet@x.test', sales: 5, gross_minor: 15000 }]);
  assert.strictEqual(v[0].name, 'The Bridge');
  assert.strictEqual(v[0].diff_minor, -20000);
  assert.strictEqual(v[1].name, 'Neath Arms', 'venues matched whatever the letter case');
  const q = v.find((x) => x.name === 'Quiet Cafe');
  assert.strictEqual(q.sales, 0);
  assert.strictEqual(q.before_minor, 15000);
  const t = E.platformTotals(v);
  assert.deepStrictEqual([t.gross_minor, t.before_minor, t.trading, t.venues], [100000, 115000, 2, 3]);
  ok('takings per venue, added up, and compared');

  const period = E.resolvePeriod('this_month', NOW);
  const inc = E.income(
    [
      { office_id: 1, name: 'The Bridge', amount_minor: 2900, interval_unit: 'month', status: 'active', created_at: '2026-11-03 10:00:00' },
      { office_id: 2, name: 'Neath Arms', amount_minor: 30000, interval_unit: 'year', status: 'active', created_at: '2025-01-01 10:00:00' },
      { office_id: 3, name: 'Quiet Cafe', amount_minor: 2900, interval_unit: 'month', status: 'cancelled', created_at: '2025-01-01 10:00:00' },
    ],
    [
      { office_id: 1, name: 'The Bridge', amount_minor: 2900, status: 'paid', paid_at: '2026-11-05 09:00:00' },
      { office_id: 2, name: 'Neath Arms', amount_minor: 2900, status: 'overdue', due_on: '2026-10-01' },
      { office_id: 2, name: 'Neath Arms', amount_minor: 2900, status: 'overdue', due_on: '2026-09-01' },
    ], period);
  assert.strictEqual(inc.mrr_minor, 2900 + 2500, 'a yearly subscription counts a twelfth; cancelled ones none');
  assert.strictEqual(inc.arr_minor, 5400 * 12);
  assert.strictEqual(inc.paid_minor, 2900);
  assert.strictEqual(inc.overdue_minor, 5800);
  assert.deepStrictEqual([inc.overdue_venues[0].name, inc.overdue_venues[0].count, inc.overdue_venues[0].oldest_due], ['Neath Arms', 2, '2026-09-01']);
  assert.strictEqual(inc.new_subscriptions, 1);
  ok('Vesopa income: monthly recurring, paid, overdue by venue, new subscriptions');

  const dev = E.devices({ venues: [
    { name: 'The Bridge', status: 'active', device_count: 3, online: 2, devices: { till: { total: 2, online: 2 }, go: { total: 1, online: 0 } }, last_seen_at: NOW.toISOString() },
    { name: 'Quiet Cafe', status: 'active', device_count: 1, online: 0, devices: { till: { total: 1, online: 0 } }, last_seen_at: new Date(NOW.getTime() - 50 * 3600e3).toISOString() },
  ] }, [{ app: 'epos', version: '1.16.56', devices: 2 }, { app: 'epos', version: '1.16.54', devices: 1 }], NOW.getTime());
  assert.deepStrictEqual([dev.total, dev.online, dev.offline], [4, 2, 2]);
  assert.strictEqual(dev.quiet_venues[0].name, 'Quiet Cafe');
  assert.strictEqual(dev.quiet_venues[0].hours, 50);
  assert.strictEqual(dev.apps[0].versions[0].version, '1.16.56');
  ok('devices: online, venues gone quiet, versions in use');

  const su = E.signups([...offices.map((o) => ({ ...o, created_at: '2025-05-01 10:00:00' })), { id: 4, name: 'New Place', status: 'active', created_at: '2026-11-10 12:00:00' }],
    [{ identity_status: 'verified', licence_status: 'trialing', trial_end: '2026-11-28 00:00:00', name: 'New Place' }, { identity_status: 'requires_input', licence_status: null }], period);
  assert.strictEqual(su.new_venues, 1);
  assert.deepStrictEqual(su.pipeline, { identity: 1, licence: 0, ready: 1 });
  assert.strictEqual(su.trials_ending[0].name, 'New Place');
  ok('sign-ups: new venues, the checks, trials ending');

  const pay = E.payments([{ method: 'card', count: 30, total_minor: 60000 }, { method: 'stripe_tap', count: 5, total_minor: 10000 }, { method: 'cash', count: 10, total_minor: 30000 }], []);
  assert.strictEqual(pay.card_minor, 70000);
  assert.strictEqual(pay.card_share_pct, 70);
  ok('payments: card, cash and the rest');

  const a = E.alerts({ venues: v, income: inc, devices: dev, signups: su, licences: E.licences(offices, null) });
  assert.ok(a.alerts.some((x) => /overdue/.test(x.title)));
  assert.ok(a.actions[0].title.includes('Neath Arms'), 'chase the overdue venue first');
  ok('what needs the owner: overdue, quiet venues, trials');

  const p = (s, prev) => E.parseQuestion(s, prev);
  assert.strictEqual(p('How much did all venues take today?').intent, 'summary');
  assert.strictEqual(p('Which venues are doing best this week?').intent, 'venues');
  assert.strictEqual(p('Who owes us money?').intent, 'revenue');
  assert.strictEqual(p('How much is Vesopa earning each month?').intent, 'revenue');
  assert.strictEqual(p('Which venues have devices offline?').intent, 'devices');
  assert.strictEqual(p('How many new venues signed up this month?').intent, 'signups');
  assert.strictEqual(p('Why did takings change this week?').intent, 'why_change');
  assert.strictEqual(p('What should I focus on this week?').intent, 'focus');
  assert.strictEqual(p('and yesterday?', { intent: 'venues', period: 'this_week' }).intent, 'venues');
  assert.strictEqual(p('write me a poem').intent, 'unknown');
  ok('questions understood by rule');
})();

// ---- the routes ---------------------------------------------------------------------

const asked = [];
const pool = {
  async query(sql, params = []) {
    const s = sql.replace(/\s+/g, ' ').trim();
    asked.push({ sql: s, params });
    if (s.startsWith('SELECT id, name, contact_email, status, plan, created_at, paused_at')) {
      return [[
        { id: 1, name: 'The Bridge', contact_email: 'bridge@x.test', status: 'active', plan: 'Pro', created_at: '2025-05-01 10:00:00' },
        { id: 2, name: 'Neath Arms', contact_email: 'neath@x.test', status: 'paused', plan: 'Pro', created_at: '2026-11-18 10:00:00', paused_at: '2026-11-19', pause_reason: 'Unpaid' },
      ]];
    }
    if (s.startsWith('SELECT o.email AS office, MAX(o.closed_at)')) return [[{ office: 'bridge@x.test', last_sale_at: new Date(2026, 10, 21, 14, 50) }, { office: 'demo@x.test', last_sale_at: new Date(2026, 10, 21, 14, 59) }]];
    if (s.startsWith('SELECT o.email AS office, COUNT(*) AS sales')) {
      const today = params[0].startsWith('2026-11-21') || params[0].startsWith('2026-11-15');
      return [[
        { office: 'bridge@x.test', sales: today ? 40 : 50, gross_minor: today ? 80000 : 100000, last_sale_at: new Date(2026, 10, 21, 14, 50) },
        { office: 'demo@x.test', sales: 999, gross_minor: 9999999 }, // a practice venue: not an office above
      ]];
    }
    if (s.startsWith('SELECT o.email AS office, HOUR')) return [[{ office: 'bridge@x.test', hour: 12, gross_minor: 30000 }, { office: 'bridge@x.test', hour: 13, gross_minor: 50000 }]];
    if (s.startsWith('SELECT o.email AS office, DATE_FORMAT')) return [[{ office: 'bridge@x.test', day: '2026-11-20', gross_minor: 40000 }]];
    if (s.startsWith('SELECT o.email AS office, p.method')) return [[{ office: 'bridge@x.test', method: 'card', count: 30, total_minor: 60000 }, { office: 'bridge@x.test', method: 'cash', count: 10, total_minor: 20000 }]];
    if (s.startsWith('SELECT s.office_id')) return [[{ office_id: 1, name: 'The Bridge', office_status: 'active', amount_minor: 2900, interval_unit: 'month', status: 'active', created_at: '2025-05-01' }]];
    if (s.startsWith('SELECT i.office_id')) return [[{ office_id: 2, name: 'Neath Arms', amount_minor: 2900, status: 'overdue', due_on: '2026-10-01' }]];
    if (s.startsWith('SELECT app, COALESCE(version')) return [[{ app: 'epos', version: '1.16.56', devices: 2 }]];
    if (s.startsWith('SELECT g.office')) return [[]];
    if (s.startsWith('SELECT o.name, i.amount_minor')) return [[{ name: 'Neath Arms', amount_minor: 2900, status: 'overdue', due_on: '2026-10-01', paid_at: null }]];
    // admin_overview.overview()
    if (/FROM offices/.test(s)) return [[{ id: 1, name: 'The Bridge', contact_email: 'bridge@x.test', status: 'active' }]];
    return [[]];
  },
};

const modelCalls = [];
let reply = null;
const model = {
  async chat(req) {
    modelCalls.push(req);
    if (reply instanceof Error) throw reply;
    return { content: JSON.stringify(typeof reply === 'function' ? reply(req) : reply) };
  },
};

(async () => {
  const app = express();
  app.use('/api/admin', ownerAiRoutes({ pool, secret: SECRET, ai: model, now: () => NOW }));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  const server = http.createServer(app).listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/admin`;
  const call = async (method, path, body, token = process.env.ADMIN_SERVICE_KEY) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), 'x-vesopa-admin': 'info@vesopasoftware.com' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };

  try {
    let r = await call('GET', '/insights/briefing', null, null);
    assert.strictEqual(r.status, 401, 'no key');
    r = await call('GET', '/insights/briefing', null, 'x'.repeat(40));
    assert.strictEqual(r.status, 401, 'a wrong key');
    const manager = jwt.sign({ id: 5, email: 'bridge@x.test', role: 'manager', officeId: 1 }, SECRET);
    r = await call('GET', '/insights/briefing', null, manager);
    assert.strictEqual(r.status, 403, 'a venue manager never sees the whole business');
    ok('only admin.vesopa.com\'s key gets in: no key, a wrong key and a venue sign-in are refused');

    reply = (req) => {
      const sent = req.messages.map((m) => m.content).join(' ');
      assert.ok(!/@/.test(sent.replace(/info@vesopasoftware\.com/g, '')), 'no email address goes to the model');
      return { answer: 'Every venue together took £800.00 today, down 20% on last Saturday.', why: [], next: [] };
    };
    r = await call('POST', '/insights/ask', { question: 'How much did all venues take today?' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.intent, 'summary');
    assert.ok(r.body.headline.startsWith('Every venue together took £800.00 from 40 sales'), r.body.headline);
    assert.ok(!JSON.stringify(r.body).includes('9,999'), 'the practice venue is left out');
    assert.strictEqual(r.body.ai_status, 'on');
    assert.strictEqual(r.body.meta.site.label, 'All venues (2)');
    assert.strictEqual(r.body.meta.freshness.last_sale_at, '2026-11-21 14:50:00');
    ok('all venues\' takings, demo venues left out, worded by the model, with period, scope and freshness');

    reply = { answer: 'Takings were £950.00.', why: [], next: [] };
    r = await call('POST', '/insights/ask', { question: 'How much did all venues take today?' });
    assert.strictEqual(r.body.ai, null);
    assert.strictEqual(r.body.ai_status, 'rejected');
    ok('a made-up figure is thrown away');

    reply = new Error('down');
    for (const q of ['Which venues are doing best this week?', 'Who owes us money?', 'Which venues have devices offline?', 'How many new venues signed up this month?', 'How do customers pay, card or cash?', 'Which venues are paused?', 'What should I focus on this week?', 'Why did takings change this week?']) {
      r = await call('POST', '/insights/ask', { question: q });
      assert.strictEqual(r.status, 200, q);
      assert.ok(r.body.headline, q);
    }
    r = await call('POST', '/insights/ask', { question: 'Who owes us money?', words: false });
    assert.ok(r.body.headline.includes('£29.00 is overdue'), r.body.headline);
    r = await call('POST', '/insights/ask', { question: 'Which venues are paused?', words: false });
    assert.ok(r.body.headline.includes('1 paused'), r.body.headline);
    ok('every kind of question answers, with plain wording when the model is down');

    r = await call('GET', '/insights/briefing');
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.headline.includes('Monthly recurring revenue is £29.00'));
    assert.ok(r.body.alerts.some((a) => /overdue/.test(a.title)));
    r = await call('GET', '/insights/records?source=invoices&period=this_month');
    assert.strictEqual(r.body.rows[0].name, 'Neath Arms');
    assert.ok(!JSON.stringify(r.body).includes('@'), 'records carry no email address');
    ok('the briefing and the records behind it');

    assert.ok(!asked.some((a) => /^\s*(INSERT|UPDATE|DELETE|REPLACE|ALTER|DROP)/i.test(a.sql)), 'nothing writes');
    ok('read-only');
  } finally {
    server.close();
  }
  console.log(`owner-ai.test.js: ${passed} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
