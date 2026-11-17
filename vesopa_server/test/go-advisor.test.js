/**
 * Vesopa AI in Vesopa Go (src/go_advisor.js, go_advisor_engine.js,
 * go_advisor_answers.js). No database and no model: the pool answers from
 * rows written here, and the "model" is a function.
 *
 * THE RULES THAT MATTER
 *
 *   1. Figures are arithmetic, not a model's: revenue, the why-it-changed
 *      split (which adds up exactly), margins, days of stock.
 *   2. A model's sentence quoting a figure that is not in the facts is thrown
 *      away; the plain wording is used.
 *   3. Staff names never reach the model; they are put back in its answer.
 *   4. Only a manager, or somebody a manager invited, gets in; an invite for
 *      one site sees that site only; revoking works at once.
 *   5. Every statement is scoped by the venue, first.
 *   6. Vesopa AI changes nothing: a request to change something is refused.
 */
const assert = require('assert');
const http = require('http');
const express = require('express');

const { issueTerminalToken } = require('../src/auth');
const E = require('../src/go_advisor_engine');
const { BUILDERS } = require('../src/go_advisor_answers');
const { goAdvisorRoutes, hashCode } = require('../src/go_advisor');

const SECRET = 'go-advisor-test-secret';
const OFFICE = 'the-bridge@vesopa.co.uk';
const THEIRS = 'someone-else@vesopa.co.uk'; // the venue next door
const NOW = new Date(2026, 10, 17, 14, 30, 0); // Tue 17 Nov 2026, 14:30 local

let passed = 0;
const ok = (name) => { passed++; console.log('  ok -', name); };

// ---- 1. the engine ---------------------------------------------------------------

(function engine() {
  assert.strictEqual(E.money(123456), '£1,234.56');
  assert.strictEqual(E.money(-5), '-£0.05');
  assert.strictEqual(E.change(110, 100), 10);
  assert.strictEqual(E.change(5, 0), null);
  ok('money and percentage change');

  const today = E.resolvePeriod('today', NOW);
  assert.strictEqual(today.from, '2026-11-17 00:00:00');
  assert.strictEqual(today.to, '2026-11-17 14:30:00');
  assert.strictEqual(today.compare.from, '2026-11-10 00:00:00');
  assert.strictEqual(today.compare.to, '2026-11-10 14:30:00', 'today so far against last Tuesday to the same minute');
  const y = E.resolvePeriod('yesterday', NOW);
  assert.deepStrictEqual([y.from, y.to, y.compare.from], ['2026-11-16 00:00:00', '2026-11-17 00:00:00', '2026-11-09 00:00:00']);
  const w = E.resolvePeriod('this_week', NOW);
  assert.strictEqual(w.from, '2026-11-16 00:00:00', 'weeks start on Monday');
  const lw = E.resolvePeriod('last_week', NOW);
  assert.deepStrictEqual([lw.from, lw.to], ['2026-11-09 00:00:00', '2026-11-16 00:00:00']);
  const m = E.resolvePeriod('this_month', new Date(2026, 2, 31, 9, 0, 0));
  assert.strictEqual(m.compare.to.slice(0, 10), '2026-02-28', '31 March compares to the end of February');
  assert.strictEqual(E.resolvePeriod('nonsense', NOW).key, 'today');
  ok('reporting periods and fair comparisons');

  const p = E.products([
    { plu_id: 1, name: 'Lager', department: 'Draught', tax_percentage: 20, cost_price: 1.2, qty: 10, sales_minor: 6000, discount_minor: 0 },
    { plu_id: 1, name: 'Lager', department: 'Draught', tax_percentage: 0, cost_price: 1.2, qty: 2, sales_minor: 1200, discount_minor: 200 },
    { plu_id: 2, name: 'Crisps', department: 'Snacks', tax_percentage: 20, cost_price: null, qty: 4, sales_minor: 600, discount_minor: 0 },
    { plu_id: 3, name: 'Promo wine', department: 'Wine', tax_percentage: 20, cost_price: 9, qty: 1, sales_minor: 600, discount_minor: 0 },
  ]);
  const lager = p.find((x) => x.name === 'Lager');
  assert.strictEqual(lager.qty, 12);
  assert.strictEqual(lager.gross_minor, 7000);
  assert.strictEqual(lager.net_minor, 5000 + 1000, 'VAT taken out per rate');
  assert.strictEqual(lager.cost_minor, 1440);
  assert.strictEqual(lager.gp_minor, 6000 - 1440);
  const crisps = p.find((x) => x.name === 'Crisps');
  assert.strictEqual(crisps.gp_minor, null, 'no cost price, no profit figure');
  const pr = E.profit(p);
  assert.strictEqual(pr.uncosted_count, 1);
  assert.strictEqual(pr.gp_minor, (6000 - 1440) + (500 - 900));
  ok('product profit, VAT and uncosted products');

  const now = E.summary({ sales: 80, gross_minor: 160000 });
  const before = E.summary({ sales: 100, gross_minor: 250000 });
  const x = E.explainChange({
    now, before,
    productsNow: [{ name: 'Lager', qty: 50, gross_minor: 100000 }, { name: 'Wine', qty: 10, gross_minor: 60000 }],
    productsBefore: [{ name: 'Lager', qty: 60, gross_minor: 120000 }, { name: 'Wine', qty: 20, gross_minor: 130000 }],
    hoursNow: [{ hour: 19, sales: 30, gross_minor: 60000 }], hoursBefore: [{ hour: 19, sales: 50, gross_minor: 140000 }],
  });
  assert.strictEqual(x.diff_minor, -90000);
  assert.strictEqual(x.volume_minor + x.spend_minor, x.diff_minor, 'the two effects add up to the difference');
  assert.strictEqual(x.volume_minor, -20 * 2500);
  assert.strictEqual(x.products[0].name, 'Wine', 'the biggest faller first');
  assert.strictEqual(x.hours[0].name, '19:00');
  ok('why revenue changed: volume and spend add up exactly');

  const s = E.stockForecast([
    { pluid: 1, product_name: 'Lager keg', stock_quantity: 2, low_stock_at: 1, sold_28d: 28, cost_price: 80 },
    { pluid: 2, product_name: 'Gin', stock_quantity: 0, sold_28d: 14 },
    { pluid: 3, product_name: 'Old port', stock_quantity: 6, sold_28d: 0, cost_price: 10 },
    { pluid: 4, product_name: 'Cola', stock_quantity: 500, sold_28d: 280 },
    { pluid: 5, product_name: 'Not counted', stock_quantity: null, sold_28d: 99 },
  ], { now: NOW });
  assert.strictEqual(s.tracked, 4, 'only counted stock is forecast');
  assert.strictEqual(s.out[0].name, 'Gin');
  assert.strictEqual(s.critical[0].name, 'Lager keg');
  assert.strictEqual(s.critical[0].days_cover, 2);
  assert.strictEqual(s.critical[0].runs_out, '2026-11-19');
  assert.strictEqual(s.critical[0].reorder_qty, 12, '14 days at 1 a day, less the 2 on hand');
  assert.strictEqual(s.slow[0].name, 'Old port');
  assert.strictEqual(s.slow[0].value_minor, 6000);
  assert.strictEqual(s.fast[0].name, 'Cola');
  ok('stock: days left, run-out date, reorder, fast and slow');

  const q = (t, prev) => E.parseQuestion(t, prev);
  assert.deepStrictEqual([q('How much did we make today?').intent, q('How much did we make today?').period], ['summary', 'today']);
  assert.deepStrictEqual([q('Why did sales decrease?').intent, q('Why did sales decrease?').period], ['why_change', 'yesterday']);
  assert.strictEqual(q('Which products generate the most profit?').intent, 'profit');
  assert.strictEqual(q('What stock should I reorder?').intent, 'stock');
  assert.strictEqual(q('Which branch performed best?').intent, 'branches');
  assert.strictEqual(q('How is my team performing?').intent, 'staff');
  assert.deepStrictEqual([q('Compare this week with last week').intent, q('Compare this week with last week').period], ['summary', 'this_week']);
  assert.strictEqual(q('What should I focus on tomorrow?').intent, 'focus');
  assert.strictEqual(q('Any products selling below cost?').intent, 'loss_makers');
  const follow = q('and yesterday?', { intent: 'staff', period: 'this_week' });
  assert.deepStrictEqual([follow.intent, follow.period, follow.follow_up], ['staff', 'yesterday', true]);
  assert.strictEqual(q('what is the capital of France').intent, 'unknown');
  ok('questions understood by rule, follow-ups keep the subject');

  const facts = { revenue: '£1,600.00', change_pct: -36, sales: 80, x_minor: 250000 };
  assert.deepStrictEqual(E.checkNarrative('Revenue was £1,600.00, down 36% on 80 sales, against £2,500.', facts), []);
  assert.deepStrictEqual(E.checkNarrative('Revenue was £1,750.00, down 40%.', facts), ['£1,750.00', '40%']);
  assert.deepStrictEqual(E.checkNarrative('Open 7 days, since 2026.', facts), [], 'small counts and years pass');
  ok('a model figure not in the facts is caught');

  const ps = E.pseudonyms(['Alex', 'Bea', 'Alex']);
  assert.strictEqual(ps.hide('Bea'), 'Staff B');
  assert.strictEqual(ps.reveal('Staff A outsold Staff B.'), 'Alex outsold Bea.');
  ok('staff pseudonyms there and back');
})();

// ---- 2. the routes, on an in-memory venue ---------------------------------------------

const staff = new Map([
  [1, { id: 1, name: 'Owner Olive', pin: '1111', grp: null, is_manager: null, office: OFFICE }],
  [2, { id: 2, name: 'Bar Ben', pin: '2222', grp: 7, is_manager: 0, office: OFFICE }],
  [3, { id: 3, name: 'Shift Sam', pin: '3333', grp: 7, is_manager: 1, office: OFFICE }],
  [9, { id: 9, name: 'Next Door', pin: '9999', grp: null, is_manager: null, office: 'someone-else@vesopa.co.uk' }],
]);
const invites = [];
const asked = [];

function totalsFor(params) {
  // Today's sales are healthy; last week's were bigger (a drop to explain).
  const from = params[1];
  if (from.startsWith('2026-11-17')) return { sales: 40, gross_minor: 80000, discount_minor: 1500, covers: 60, last_sale_at: new Date(2026, 10, 17, 14, 20) };
  if (from.startsWith('2026-11-10')) return { sales: 50, gross_minor: 110000, discount_minor: 500, covers: 70, last_sale_at: null };
  return { sales: 10, gross_minor: 20000, discount_minor: 0, covers: 0, last_sale_at: null };
}

const pool = {
  async query(sql, params = []) {
    const s = sql.replace(/\s+/g, ' ').trim();
    asked.push({ sql: s, params });
    if (s.includes('FROM bo_clarks c')) {
      const c = staff.get(Number(params[0]));
      return [[c && c.office === params[1] ? c : undefined].filter(Boolean)];
    }
    if (s.startsWith('SELECT id, site_id FROM go_ai_invites') && s.includes('clerk_id = ?')) {
      return [invites.filter((i) => i.office === params[0] && i.clerk_id === params[1] && i.accepted_at && !i.revoked_at).slice(-1)];
    }
    if (s.startsWith('SELECT id FROM go_ai_invites')) {
      return [invites.filter((i) => i.office === params[0] && i.code_hash === params[1] && !i.revoked_at && !i.accepted_at && i.expires_at > params[2])];
    }
    if (s.startsWith('UPDATE go_ai_invites SET clerk_id')) {
      const i = invites.find((x) => x.id === params[2] && x.office === params[3]);
      Object.assign(i, { clerk_id: params[0], accepted_at: params[1] });
      return [{ affectedRows: 1 }];
    }
    if (s.startsWith('UPDATE go_ai_invites SET revoked_at')) {
      const i = invites.find((x) => x.id === params[1] && x.office === params[2] && !x.revoked_at);
      if (i) i.revoked_at = params[0];
      return [{ affectedRows: i ? 1 : 0 }];
    }
    if (s.startsWith('INSERT INTO go_ai_invites')) {
      const id = invites.length + 1;
      invites.push({ id, office: params[0], email: params[1], code_hash: params[2], site_id: params[3], invited_by: params[4], expires_at: params[5] });
      return [{ insertId: id }];
    }
    if (s.includes('FROM go_ai_invites i')) return [invites.filter((i) => i.office === params[0]).map((i) => ({ ...i, clerk_name: i.clerk_id ? staff.get(i.clerk_id).name : null }))];
    if (s.startsWith('SELECT id, name FROM bo_till_sites')) return [[{ id: 1, name: 'Swansea' }, { id: 2, name: 'Neath' }]];
    if (s.startsWith('SELECT terminal, label, site_id FROM bo_till_names')) return [[{ terminal: 'TILL-1', label: 'Bar till', site_id: 1 }, { terminal: 'TILL-2', label: 'Neath till', site_id: 2 }]];
    if (s.startsWith('SELECT name FROM offices')) return [[{ name: 'The Bridge' }]];
    if (s.startsWith('SELECT name, contact_email FROM offices')) return [params[0] === OFFICE ? [{ name: 'The Bridge', contact_email: OFFICE }] : []];
    if (s.startsWith('SELECT contact_email FROM offices')) return [params[0] === OFFICE ? [{ contact_email: OFFICE }] : []];
    if (s.startsWith('SELECT id, site_id FROM go_ai_invites WHERE office = ? AND email = ?')) {
      return [invites.filter((i) => i.office === params[0] && i.email === params[1] && !i.revoked_at && i.accepted_at).slice(-1)];
    }
    if (s.startsWith('SELECT id, office, accepted_at FROM go_ai_invites WHERE email = ?')) {
      return [invites.filter((i) => i.email === params[0] && !i.revoked_at && (i.accepted_at || i.expires_at > params[1])).slice(-1)];
    }
    if (s.startsWith('UPDATE go_ai_invites SET accepted_at')) {
      const i = invites.find((x) => x.id === params[1] && x.office === params[2]);
      i.accepted_at = params[0];
      return [{ affectedRows: 1 }];
    }
    if (s.startsWith('SELECT MAX(o.closed_at) AS last')) return [[{ last: new Date(2026, 10, 17, 14, 20) }]];
    if (s.startsWith('SELECT COUNT(*) AS sales')) return [[totalsFor(params)]];
    if (s.startsWith('SELECT HOUR(o.closed_at)')) {
      return [params[1].startsWith('2026-11-17') ? [{ hour: 12, sales: 20, gross_minor: 40000 }, { hour: 13, sales: 20, gross_minor: 40000 }] : [{ hour: 12, sales: 20, gross_minor: 40000 }, { hour: 13, sales: 30, gross_minor: 70000 }]];
    }
    if (s.startsWith("SELECT DATE_FORMAT")) return [[{ day: '2026-11-17', sales: 40, gross_minor: 80000 }]];
    if (s.startsWith("SELECT COALESCE(NULLIF(TRIM(o.clerk_name)")) {
      return [params[1].startsWith('2026-11-17') ? [{ name: 'Bar Ben', sales: 30, gross_minor: 60000, discount_minor: 1500 }, { name: 'Shift Sam', sales: 10, gross_minor: 20000, discount_minor: 0 }] : [{ name: 'Bar Ben', sales: 30, gross_minor: 60000, discount_minor: 0 }, { name: 'Shift Sam', sales: 20, gross_minor: 50000, discount_minor: 0 }]];
    }
    if (s.startsWith("SELECT COALESCE(o.terminal, '')")) {
      return [params[1].startsWith('2026-11-17') ? [{ terminal: 'TILL-1', sales: 30, gross_minor: 60000 }, { terminal: 'TILL-2', sales: 10, gross_minor: 20000 }] : [{ terminal: 'TILL-1', sales: 30, gross_minor: 60000 }, { terminal: 'TILL-2', sales: 20, gross_minor: 50000 }]];
    }
    if (s.startsWith('SELECT l.plu_id, l.name')) {
      return [params[1].startsWith('2026-11-17')
        ? [{ plu_id: 1, name: 'Lager', department: 'Draught', tax_percentage: 20, cost_price: 1, qty: 100, sales_minor: 60000, discount_minor: 0 }, { plu_id: 2, name: 'Burger', department: 'Food', tax_percentage: 20, cost_price: 12, qty: 20, sales_minor: 20000, discount_minor: 0 }]
        : [{ plu_id: 1, name: 'Lager', department: 'Draught', tax_percentage: 20, cost_price: 1, qty: 110, sales_minor: 66000, discount_minor: 0 }, { plu_id: 2, name: 'Burger', department: 'Food', tax_percentage: 20, cost_price: 12, qty: 44, sales_minor: 44000, discount_minor: 0 }]];
    }
    if (s.startsWith('SELECT p.pluid, p.product_name')) {
      return [[{ pluid: 1, product_name: 'Lager', stock_quantity: 30, low_stock_at: 20, sold_28d: 280, cost_price: 1 }, { pluid: 2, product_name: 'Burger', stock_quantity: 0, sold_28d: 100, cost_price: 12 }]];
    }
    if (s.startsWith('SELECT o.id, o.closed_at')) return [[{ id: 'abcdef12-0000', closed_at: new Date(2026, 10, 17, 14, 20), staff: 'Bar Ben', terminal: 'TILL-1', table_number: 4, covers: 2, total_minor: 2450, discount_minor: 0 }]];
    throw new Error('unexpected SQL: ' + s.slice(0, 90));
  },
};

/** A model that answers with whatever the test sets, and remembers what it was sent. */
const modelCalls = [];
let modelReply = null;
const fakeModel = {
  async chat(req) {
    modelCalls.push(req);
    if (modelReply instanceof Error) throw modelReply;
    return { content: JSON.stringify(typeof modelReply === 'function' ? modelReply(req) : modelReply), provider: 'deepseek' };
  },
};
const mails = [];

(async () => {
  const app = express();
  app.use(goAdvisorRoutes({ pool, secret: SECRET, ai: fakeModel, mail: async (m) => { mails.push(m); return true; }, now: () => NOW }));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  const server = http.createServer(app).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const terminal = issueTerminalToken({ officeEmail: OFFICE, officeId: 1, email: OFFICE }, SECRET);
  const call = async (method, path, body, aiToken) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${terminal}`, ...(aiToken ? { 'x-vesopa-ai': aiToken } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const out = { status: res.status, body: await res.json() };
    saved.push({ method, path, request: body || null, status: out.status, body: out.body });
    return out;
  };
  // ADVISOR_FIXTURES=<dir>: keep the real answers, for Go's widget tests
  // (vesopa_go/test/fixtures/advisor), so the app is tested against what this
  // server really sends.
  const saved = [];

  try {
    // Who gets in.
    let r = await call('POST', '/api/go/ai/session', { clerk_id: 1, pin: '0000' });
    assert.strictEqual(r.status, 403);
    r = await call('POST', '/api/go/ai/session', { clerk_id: 9, pin: '9999' });
    assert.strictEqual(r.status, 403, 'another venue\'s member of staff');
    r = await call('POST', '/api/go/ai/session', { clerk_id: 2, pin: '2222' });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.body.code, 'not_invited');
    const owner = await call('POST', '/api/go/ai/session', { clerk_id: 1, pin: '1111' });
    assert.strictEqual(owner.status, 200);
    assert.strictEqual(owner.body.role, 'manager');
    assert.strictEqual(owner.body.can_invite, true);
    assert.strictEqual(owner.body.sites.length, 2);
    const shift = await call('POST', '/api/go/ai/session', { clerk_id: 3, pin: '3333' });
    assert.strictEqual(shift.body.role, 'manager', 'a group with is_manager');
    r = await call('GET', '/api/go/ai/briefing', null, 'not-a-token');
    assert.strictEqual(r.status, 401);
    ok('managers get in; staff without an invite, wrong PINs and other venues do not');

    for (let i = 0; i < 5; i++) await call('POST', '/api/go/ai/session', { clerk_id: 3, pin: '0000' });
    r = await call('POST', '/api/go/ai/session', { clerk_id: 3, pin: '3333' });
    assert.strictEqual(r.status, 429, 'five wrong PINs and it waits');
    ok('wrong PINs are limited');

    const T = owner.body.token;

    // An answer, with the model's wording checked.
    modelReply = (req) => {
      const facts = req.messages[1].content;
      assert.ok(!facts.includes('Bar Ben') && !facts.includes('Shift Sam'), 'no staff name reaches the model');
      return { answer: 'Revenue was £800.00, down 27.3% on last Tuesday. Staff B took less than last week.', why: ['Burger sales fell.'], next: [{ title: 'Push Burger', why: 'It fell most.' }] };
    };
    r = await call('POST', '/api/go/ai/ask', { question: 'Why did sales drop today?', period: 'today' }, T);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.intent, 'why_change');
    assert.strictEqual(r.body.ai_status, 'on');
    assert.ok(r.body.ai.answer.includes('Shift Sam took less'), 'the name is put back');
    assert.ok(r.body.headline.includes('£800.00') && r.body.headline.includes('£300.00'));
    const drivers = r.body.cards.find((c) => c.type === 'drivers');
    assert.strictEqual(drivers.items[0].value_minor + drivers.items[1].value_minor, -30000);
    assert.strictEqual(r.body.meta.period.label.startsWith('Today so far'), true);
    assert.strictEqual(r.body.meta.site.label, 'All sites');
    assert.ok(r.body.meta.definitions.length);
    assert.strictEqual(r.body.meta.freshness.last_sale_at, '2026-11-17 14:20:00');
    assert.strictEqual(r.body.meta.records.source, 'orders');
    assert.ok(r.body.follow_ups.length);
    ok('an answer: figures, drivers that add up, period, site, definitions, freshness, records');

    modelReply = { answer: 'Revenue was £950.00, down 12%.', why: [], next: [] };
    r = await call('POST', '/api/go/ai/ask', { question: 'How much did we make today?' }, T);
    assert.strictEqual(r.body.ai, null, 'invented figures are discarded');
    assert.strictEqual(r.body.ai_status, 'rejected');
    assert.ok(r.body.headline.startsWith('£800.00 from 40 sales'));
    ok('a model answer with an invented figure is thrown away');

    modelReply = new Error('busy');
    r = await call('POST', '/api/go/ai/ask', { intent: 'profit', period: 'today' }, T);
    assert.strictEqual(r.body.ai_status, 'unavailable');
    assert.ok(r.body.headline.includes('Gross profit'));
    assert.ok(r.body.ai_note);
    ok('no model, still an exact answer in plain words');

    // Each kind of question answers.
    for (const q of ['What stock should I reorder?', 'Which branch performed best this week?', 'How is my team performing?', 'What should I focus on tomorrow?', 'Which products are not moving?', 'What were the busiest hours?', 'Any products selling below cost?', 'What were the best sellers?']) {
      r = await call('POST', '/api/go/ai/ask', { question: q, words: false }, T);
      assert.strictEqual(r.status, 200, q);
      assert.ok(r.body.headline, q);
      assert.strictEqual(r.body.ai_status, 'not_asked');
    }
    r = await call('POST', '/api/go/ai/ask', { question: 'What stock should I reorder?', words: false }, T);
    assert.ok(r.body.headline.includes('Burger') || r.body.why.join(' ').includes('Burger is out of stock'));
    r = await call('POST', '/api/go/ai/ask', { question: 'Which branch performed best this week?', words: false }, T);
    assert.ok(r.body.headline.startsWith('Swansea performed best'));
    ok('every kind of question answers');

    r = await call('POST', '/api/go/ai/ask', { question: 'Change the price of lager to £5' }, T);
    assert.strictEqual(r.body.intent, 'read_only');
    r = await call('POST', '/api/go/ai/ask', { question: 'Reorder 20 kegs of lager' }, T);
    assert.strictEqual(r.body.intent, 'read_only');
    ok('Vesopa AI changes nothing');

    modelReply = { intent: 'unknown', period: 'today' };
    r = await call('POST', '/api/go/ai/ask', { question: 'Tell me a joke' }, T);
    assert.strictEqual(r.body.intent, 'unknown');
    assert.ok(r.body.follow_ups.length);
    ok('off-topic questions get suggestions, not invented answers');

    // The briefing.
    modelReply = { answer: 'Today is quieter: £800.00 so far.', why: [], next: [] };
    r = await call('GET', '/api/go/ai/briefing', null, T);
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.headline.startsWith('£800.00 from 40 sales'));
    assert.ok(r.body.actions.length);
    assert.ok(r.body.alerts.some((a) => /out of stock/.test(a.title)));
    assert.strictEqual(r.body.ai.answer, 'Today is quieter: £800.00 so far.');
    ok('the daily briefing');

    // Supporting records.
    r = await call('GET', '/api/go/ai/records?source=orders&period=today', null, T);
    assert.strictEqual(r.body.rows[0].till, 'Bar till');
    assert.strictEqual(r.body.rows[0].total_minor, 2450);
    r = await call('GET', '/api/go/ai/records?source=products&period=today', null, T);
    assert.strictEqual(r.body.rows[0].name, 'Lager');
    r = await call('GET', '/api/go/ai/records?source=stock', null, T);
    assert.strictEqual(r.body.rows.length, 2);
    ok('the records behind an answer');

    // Invites: by email, redeemed with the code, for one site, revoked.
    r = await call('POST', '/api/go/ai/invites', { email: 'ben@example.com', site_id: 2 }, T);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.emailed, true);
    assert.strictEqual(r.body.code, undefined, 'the code only travels by email');
    assert.strictEqual(mails[0].to, 'ben@example.com');
    const code = /Your code: ([A-Z0-9]{8})/.exec(mails[0].text)[1];
    assert.strictEqual(invites[0].code_hash, hashCode(code), 'only a hash is kept');
    r = await call('POST', '/api/go/ai/invites/redeem', { clerk_id: 2, pin: '2222', code: 'WRONGCODE' });
    assert.strictEqual(r.status, 404);
    const ben = await call('POST', '/api/go/ai/invites/redeem', { clerk_id: 2, pin: '2222', code: code.toLowerCase() });
    assert.strictEqual(ben.status, 200);
    assert.strictEqual(ben.body.role, 'invited');
    assert.strictEqual(ben.body.site, 2);
    assert.deepStrictEqual(ben.body.sites, [{ id: 2, name: 'Neath' }]);
    assert.strictEqual(ben.body.can_invite, false);
    r = await call('POST', '/api/go/ai/invites/redeem', { clerk_id: 2, pin: '2222', code });
    assert.strictEqual(r.status, 404, 'a code works once');
    r = await call('POST', '/api/go/ai/ask', { question: 'How much today?', site: 1, words: false }, ben.body.token);
    assert.strictEqual(r.status, 403, 'an invite for Neath cannot read Swansea');
    asked.length = 0;
    r = await call('POST', '/api/go/ai/ask', { question: 'How much today?', words: false }, ben.body.token);
    assert.strictEqual(r.body.meta.site.label, 'Neath');
    const totals = asked.find((a) => a.sql.startsWith('SELECT COUNT(*) AS sales'));
    assert.ok(totals.sql.includes('site_id = ?') && totals.params.includes(2), 'every figure for Neath only');
    r = await call('POST', '/api/go/ai/invites', { email: 'x@example.com' }, ben.body.token);
    assert.strictEqual(r.status, 403, 'only managers invite');
    r = await call('GET', '/api/go/ai/invites', null, T);
    assert.strictEqual(r.body.invites[0].status, 'active');
    assert.strictEqual(r.body.invites[0].staff, 'Bar Ben');
    r = await call('DELETE', `/api/go/ai/invites/${invites[0].id}`, null, T);
    assert.strictEqual(r.status, 200);
    r = await call('POST', '/api/go/ai/ask', { question: 'How much today?', words: false }, ben.body.token);
    assert.strictEqual(r.status, 403, 'revoked at once');
    ok('email invites: one code, one site, managers only, revoked at once');

    // Every statement scoped by the venue, first.
    asked.length = 0;
    await call('GET', '/api/go/ai/briefing', null, T);
    await call('GET', '/api/go/ai/records?source=orders', null, T);
    for (const a of asked) {
      if (/epos_orders|bo_products|bo_clarks|go_ai_invites|bo_till/.test(a.sql)) {
        assert.ok(a.params.includes(OFFICE), 'scoped: ' + a.sql.slice(0, 80));
      }
      if (/FROM epos_orders o WHERE/.test(a.sql)) assert.ok(/WHERE o\.email = \?/.test(a.sql) && a.params[0] === OFFICE, a.sql.slice(0, 80));
    }
    ok('every statement is scoped by the venue');

    // Another venue: nothing a phone or a page sends can reach it.
    {
      const jwt = require('jsonwebtoken');
      const theirTerminal = issueTerminalToken({ officeEmail: THEIRS, officeId: 2, email: THEIRS }, SECRET);
      const asThem = async (path, aiToken, body) => {
        const res = await fetch(base + path, {
          method: body ? 'POST' : 'GET',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${theirTerminal}`, 'x-vesopa-ai': aiToken },
          body: body ? JSON.stringify(body) : undefined,
        });
        return { status: res.status, body: await res.json() };
      };
      // Our Vesopa AI session on the next venue's phone: refused.
      let r = await asThem('/api/go/ai/briefing', T);
      assert.strictEqual(r.status, 401, 'a session for one venue does not open on another venue\'s device');
      // A session made up for the other venue without our server's key: refused.
      const forged = jwt.sign({ scope: 'go-ai', office: THEIRS, clerk_id: 9, role: 'manager', site: null }, 'not-the-server-key');
      r = await asThem('/api/go/ai/briefing', forged);
      assert.strictEqual(r.status, 401);
      const forgedWeb = jwt.sign({ scope: 'go-ai-web', office: THEIRS, email: OFFICE }, 'not-the-server-key');
      r = await call('GET', '/api/go/ai/briefing', null, forgedWeb);
      assert.strictEqual(r.status, 401, 'a made-up web session is refused');
      // Our own session naming the other venue's site: refused, not quietly answered.
      r = await call('POST', '/api/go/ai/ask', { question: 'How much today?', site: 77, words: false }, T);
      assert.strictEqual(r.status, 404, 'a site that is not this venue\'s');
      // An office named in the body or the address is ignored: the answer is still ours.
      asked.length = 0;
      r = await call('POST', '/api/go/ai/ask', { question: 'How much today?', office: THEIRS, email: THEIRS, words: false }, T);
      assert.strictEqual(r.status, 200);
      r = await call('GET', `/api/go/ai/records?source=orders&period=today&office=${encodeURIComponent(THEIRS)}`, null, T);
      assert.strictEqual(r.status, 200);
      for (const a of asked) assert.ok(!a.params.includes(THEIRS), 'never asked about the other venue: ' + a.sql.slice(0, 70));
      // Removing an invite by number only ever touches our own invites.
      r = await call('DELETE', '/api/go/ai/invites/999999', null, T);
      assert.strictEqual(r.status, 404);
      ok('another venue is out of reach: other devices, forged sessions, other sites, office in the request, other invites');
    }

    // A plain-wording view of the answer builders (what Go draws with no model).
    const d = {
      now: E.summary({ sales: 0, gross_minor: 0 }), before: E.summary({}), hours: [], hoursBefore: [], days: [], products: [], productsBefore: [],
      staff: [], staffBefore: [], sites: [], sitesBefore: [], tills: [], tillsBefore: [], stock: E.stockForecast([]),
    };
    const ctx = { period: E.resolvePeriod('today', NOW), site: { label: 'Whole venue' } };
    for (const [k, b] of Object.entries(BUILDERS)) assert.ok(b(d, ctx).headline, `${k} answers an empty venue`);
    ok('an empty venue gets a sensible answer to everything');
    // On the web (go.vesopa.com/ai): Continue with Vesopa, no phone and no PIN.
    {
      const idTokens = { 'tok-owner': OFFICE, 'tok-ana': 'ana@example.com', 'tok-stranger': 'who@example.com' };
      const web = express();
      web.use(goAdvisorRoutes({
        pool, secret: SECRET, ai: null, mail: async (m) => { mails.push(m); return true; }, now: () => NOW,
        goClient: () => ({ issuer: 'https://auth.test', clientId: 'go-client' }),
        verifyIdToken: async (t) => ({ email: idTokens[t], email_verified: true, name: 'Web ' + idTokens[t] }),
        fetchImpl: async (url, init) => {
          assert.strictEqual(url, 'https://auth.test/oauth/token');
          const code = new URLSearchParams(init.body).get('code');
          return { ok: true, json: async () => ({ id_token: code }) };
        },
      }));
      web.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
      const ws = http.createServer(web).listen(0);
      const wbase = `http://127.0.0.1:${ws.address().port}`;
      const wcall = async (method, path, body, aiToken) => {
        const res = await fetch(wbase + path, {
          method,
          headers: { 'content-type': 'application/json', ...(aiToken ? { 'x-vesopa-ai': aiToken } : {}) },
          body: body ? JSON.stringify(body) : undefined,
        });
        return { status: res.status, body: await res.json() };
      };
      const ex = (code) => wcall('POST', '/api/go/ai/web/exchange', { code, code_verifier: 'v', redirect_uri: 'https://go.vesopa.com/ai/' });
      try {
        let w = await wcall('POST', '/api/go/ai/web/exchange', { code: 'tok-owner', code_verifier: 'v', redirect_uri: 'https://evil.example/ai/' });
        assert.strictEqual(w.status, 400, 'only go.vesopa.com may sign in');
        w = await ex('tok-stranger');
        assert.strictEqual(w.status, 403);
        assert.strictEqual(w.body.code, 'not_invited');
        const owner = await ex('tok-owner');
        assert.strictEqual(owner.status, 200);
        assert.strictEqual(owner.body.role, 'owner');
        assert.strictEqual(owner.body.can_invite, true);
        assert.strictEqual(owner.body.sites.length, 2);
        w = await wcall('GET', '/api/go/ai/briefing', null, owner.body.token);
        assert.strictEqual(w.status, 200, 'the web session needs no phone');
        assert.strictEqual(w.body.name, 'Web ' + OFFICE);
        w = await wcall('GET', '/api/go/ai/briefing', null, 'forged');
        assert.strictEqual(w.status, 401, 'no web session and no phone: refused');
        // An owner invites by email from the web; that person signs in with the same email.
        w = await wcall('POST', '/api/go/ai/invites', { email: 'ana@example.com', site_id: 1 }, owner.body.token);
        assert.strictEqual(w.status, 200);
        const ana = await ex('tok-ana');
        assert.strictEqual(ana.status, 200);
        assert.strictEqual(ana.body.role, 'invited');
        assert.strictEqual(ana.body.site, 1);
        assert.strictEqual(ana.body.can_invite, false);
        w = await wcall('POST', '/api/go/ai/ask', { question: 'How much today?', words: false }, ana.body.token);
        assert.strictEqual(w.body.meta.site.label, 'Swansea', 'an invite for one site sees that site on the web too');
        w = await wcall('POST', '/api/go/ai/ask', { question: 'How much today?', site: 2, words: false }, ana.body.token);
        assert.strictEqual(w.status, 403);
        const anaInvite = invites.find((i) => i.email === 'ana@example.com');
        w = await wcall('DELETE', `/api/go/ai/invites/${anaInvite.id}`, null, owner.body.token);
        assert.strictEqual(w.status, 200);
        w = await wcall('GET', '/api/go/ai/briefing', null, ana.body.token);
        assert.strictEqual(w.status, 403, 'revoked at once on the web too');
        ok('on the web: owners sign in, invited emails see their site, strangers and revoked invites do not');
      } finally {
        ws.close();
      }
    }

    if (process.env.ADVISOR_FIXTURES) {
      const fs = require('fs');
      const path = require('path');
      const dir = process.env.ADVISOR_FIXTURES;
      fs.mkdirSync(dir, { recursive: true });
      const pick = (fn) => saved.find(fn);
      const files = {
        'session.json': pick((x) => x.path === '/api/go/ai/session' && x.status === 200 && x.request.clerk_id === 1),
        'not_invited.json': pick((x) => x.body.code === 'not_invited'),
        'redeemed.json': pick((x) => x.path === '/api/go/ai/invites/redeem' && x.status === 200),
        'briefing.json': pick((x) => x.path === '/api/go/ai/briefing' && x.status === 200 && x.body.ai),
        'ask_why.json': pick((x) => x.path === '/api/go/ai/ask' && x.body.intent === 'why_change' && x.body.ai),
        'ask_stock.json': pick((x) => x.path === '/api/go/ai/ask' && x.body.intent === 'stock'),
        'ask_branches.json': pick((x) => x.path === '/api/go/ai/ask' && x.body.intent === 'branches'),
        'ask_staff.json': pick((x) => x.path === '/api/go/ai/ask' && x.body.intent === 'staff'),
        'ask_profit.json': pick((x) => x.path === '/api/go/ai/ask' && x.body.intent === 'profit'),
        'ask_summary.json': pick((x) => x.path === '/api/go/ai/ask' && x.body.intent === 'summary'),
        'records_orders.json': pick((x) => x.path.startsWith('/api/go/ai/records?source=orders') && x.status === 200),
        'invites.json': pick((x) => x.path === '/api/go/ai/invites' && x.method === 'GET'),
      };
      for (const [f, x] of Object.entries(files)) {
        assert.ok(x, 'no fixture for ' + f);
        fs.writeFileSync(path.join(dir, f), JSON.stringify(x.body, null, 2) + '\n');
      }
      console.log(`  fixtures written to ${dir}`);
    }
  } finally {
    server.close();
  }
  console.log(`go-advisor.test.js: ${passed} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
