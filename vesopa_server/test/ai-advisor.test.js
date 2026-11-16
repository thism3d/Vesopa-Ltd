/**
 * Vesopa AI (src/ai_advisor.js, ai_answers.js, ai_metrics.js, ai_explain.js)
 * against an in-memory venue. No database, no DeepSeek.
 *
 * THE RULES THAT MATTER
 *
 *   1. Every figure is the venue's own: takings, products, stock and staff
 *      add up to exactly what the sales say.
 *   2. "Why did sales drop" splits the difference exactly into fewer bills
 *      and lower spend, and names the hours and products that moved.
 *   3. The model's words are thrown away if they hold one number the facts
 *      do not, and the rule-written answer is shown instead.
 *   4. Tenancy and access: one venue never sees another's sales; a clerk who
 *      is not a manager gets no Go session; an invited person sees only the
 *      sites ticked, and no profit or staff figures unless ticked.
 *   5. Read-only: no route writes to sales, products or stock.
 */
'use strict';

const assert = require('assert');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');

const { issueToken, issueTerminalToken } = require('../src/auth');
const M = require('../src/ai_metrics');
const A = require('../src/ai_answers');
const X = require('../src/ai_explain');
const { aiRoutes } = require('../src/ai_advisor');

delete process.env.DEEPSEEK_API_KEY;
const { pool, SECRET, NOW, OFFICE, sites, members, writes } = require('./lib/ai_fake_venue');
(async () => {
  const now = M.parseNaive(NOW);

  // ---- periods ----
  assert.strictEqual(M.resolvePeriod({ kind: 'yesterday' }, now).from, '2026-11-15 00:00:00');
  const today = M.resolvePeriod({ kind: 'today' }, now);
  const tc = M.comparisonFor(today);
  assert.strictEqual(tc.from, '2026-11-09 00:00:00', 'today compares with last Monday');
  assert.strictEqual(tc.to, '2026-11-09 15:00:00', '... only up to the same time');
  assert.strictEqual(M.resolvePeriod({ kind: 'this_week' }, now).from, '2026-11-16 00:00:00');
  assert.strictEqual(M.resolvePeriod({ kind: 'last_week' }, now).from, '2026-11-09 00:00:00');
  assert.strictEqual(M.resolvePeriod({ kind: 'weekday', dow: 6 }, now).from, '2026-11-14 00:00:00', 'Saturday = last Saturday');
  assert.strictEqual(M.resolvePeriod({ kind: 'last_month' }, now).from, '2026-10-01 00:00:00');

  // ---- understanding questions ----
  const ask = (t, prev) => A.parseQuestion(t, { now, siteNames: sites, prev });
  assert.strictEqual(ask('How much did we make today?').intent, 'takings');
  assert.deepStrictEqual(ask('How much did we make today?').period, { kind: 'today' });
  assert.strictEqual(ask('Why did sales decrease yesterday?').intent, 'compare');
  assert.strictEqual(ask('Why did sales decrease yesterday?').direction, 'down');
  assert.strictEqual(ask('Which products generate the most profit?').intent, 'profit');
  assert.strictEqual(ask('What stock should I reorder?').intent, 'stock');
  assert.strictEqual(ask('Which branch performed best?').intent, 'sites');
  assert.strictEqual(ask('How is my team performing?').intent, 'staff');
  const cmp = ask('Compare this week with last week');
  assert.strictEqual(cmp.intent, 'compare');
  assert.deepStrictEqual(cmp.period, { kind: 'this_week' });
  assert.deepStrictEqual(cmp.compare, { kind: 'last_week' });
  assert.strictEqual(ask('What should I focus on tomorrow?').intent, 'focus');
  assert.strictEqual(ask('best sellers on saturday').intent, 'products');
  assert.deepStrictEqual(ask('best sellers on saturday').period, { kind: 'weekday', dow: 6 });
  assert.strictEqual(ask('takings at the Lounge today').site, 2);
  const follow = ask('and last week?', { intent: 'products', period: { kind: 'today' }, site: null });
  assert.strictEqual(follow.intent, 'products', 'a follow-up keeps the subject');
  assert.deepStrictEqual(follow.period, { kind: 'last_week' });
  assert.strictEqual(ask('why?', { intent: 'takings', period: { kind: 'today' } }).intent, 'compare');
  assert.strictEqual(ask('tell me a joke').understood, false);

  // ---- answers from the venue's own figures ----
  const map = await M.siteMap(pool, OFFICE);
  const ctx = { pool, office: OFFICE, now, map, allowed: null, site: null, can: { profit: true, staff: true } };
  const t = await A.answer(ask('How much did we make today?'), ctx);
  const factOf = (a, id) => a.facts.find((f) => f.id === id);
  assert.strictEqual(factOf(t, 'takings').value, 4 * 1000, 'today: 4 bills of £10');
  assert.strictEqual(factOf(t, 'takings_before').value, 10 * 2200, 'last Monday to 15:00 only (the 19:00 wine is after)');
  assert.ok(!JSON.stringify(t).includes('50000'), 'the other venue\'s £500 sale never appears');
  assert.ok(t.meta.period && t.meta.site && t.meta.definition && t.meta.freshness, 'period, site, definition, freshness');
  assert.ok(t.records.length && t.records[0].kind === 'bills', 'records behind it');

  const why = await A.answer(ask('Why did sales drop today?'), ctx);
  const d = factOf(why, 'takings_delta').value;
  assert.strictEqual(d, 4000 - 22000);
  assert.strictEqual(factOf(why, 'bills_effect').value + factOf(why, 'spend_effect').value, d, 'the split adds up exactly');
  assert.ok(why.why.some((w) => /Burger/.test(w)), 'names the product that moved');
  assert.ok(why.why.some((w) => /run out/.test(w)), 'burgers sold before, none now, no stock: a likely stockout');

  const st = await A.answer(ask('What stock should I reorder?'), ctx);
  assert.strictEqual(factOf(st, 'out').value, 1, 'Burger: out and selling');
  assert.ok(st.facts.some((f) => /Lager suggested order/.test(f.label)), 'Lager needs reordering');
  assert.ok(st.why.some((w) => /Cider/.test(w)), 'Cider: stock, no sales = slow');

  const pr = await A.answer(ask('Which products make the most profit last week?'), ctx);
  assert.ok(pr.why.some((w) => /Burger/.test(w) && /loss/.test(w)), 'Burger at £12 inc VAT costs £11.50 ex VAT: sold at a loss');

  const si = await A.answer(ask('Which branch performed best last week?'), ctx);
  assert.match(si.headline, /^Bar performed best/);

  // An invited person with the Lounge only sees the Lounge, and no profit.
  const guest = { ...ctx, allowed: [2], can: { profit: false, staff: false } };
  const gt = await A.answer(ask('How much did we make last week?'), guest);
  assert.strictEqual(factOf(gt, 'takings').value, 2000, 'Lounge only: the one wine');
  assert.strictEqual((await A.answer(ask('What is my profit?'), guest)).headline, 'Not available to you');

  // ---- the number check ----
  const allowed = X.allowedNumbers(why, 'Why did sales drop today?');
  assert.deepStrictEqual(X.unsupported(['Takings were £180.00 lower, from 4 bills.'], allowed), []);
  assert.deepStrictEqual(X.unsupported(['Takings fell 81.8%.'], allowed), [], 'a percentage the facts hold');
  assert.deepStrictEqual(X.unsupported(['Takings fell by £175.'], allowed), ['£175'], 'an invented figure is caught');
  assert.deepStrictEqual(X.unsupported(['That is 42% of the week.'], allowed), ['42%']);
  // A model that invents a figure is discarded in favour of the draft.
  const fakeFetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ headline: 'Sales fell by £999 because of rain.', why: [], next: [] }) } }] }) });
  const ex = await X.explain('why', why, { fetchImpl: fakeFetch, key: 'k' });
  assert.strictEqual(ex.source, 'rules');
  assert.strictEqual(ex.headline, why.headline);
  const goodFetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ headline: 'A quieter lunch: 4 bills against 10, and no burgers sold.', why: ['Lager held up.'], next: ['Restock burgers.'] }) } }] }) });
  assert.strictEqual((await X.explain('why', why, { fetchImpl: goodFetch, key: 'k' })).source, 'ai');

  // ---- the routes ----
  const app = express();
  const mail = [];
  app.use(aiRoutes({ pool, secret: SECRET, mailer: async (m) => { mail.push(m); return true; } }));
  const server = http.createServer(app).listen(0);
  const port = server.address().port;
  const call = async (method, path, token, body) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  try {
    const owner = issueToken({ id: 1, email: 'owner@example.com', name: 'Owner', role: 'office', officeId: 1 }, SECRET);
    const staffUser = issueToken({ id: 2, email: 'staff@example.com', name: 'Staff', role: 'office', officeId: 1 }, SECRET);
    assert.strictEqual((await call('GET', '/api/ai/me')).status, 401);
    assert.strictEqual((await call('GET', '/api/ai/me', staffUser)).status, 403, 'a Staff role cannot open Vesopa AI');
    const me = await call('GET', '/api/ai/me', owner);
    assert.strictEqual(me.status, 200);
    assert.strictEqual(me.body.can.profit, true);

    const b = await call('GET', '/api/ai/briefing', owner);
    assert.strictEqual(b.status, 200);
    assert.strictEqual(b.body.source, 'rules', 'no key: rule-written, and labelled so');
    assert.ok(b.body.tiles.length === 4);
    assert.ok(b.body.alerts.some((a) => /out of stock/.test(a.title)));

    const a1 = await call('POST', '/api/ai/ask', owner, { question: 'What were the best sellers last week?' });
    assert.strictEqual(a1.status, 200);
    assert.ok(a1.body.conversation_id);
    const a2 = await call('POST', '/api/ai/ask', owner, { question: 'and today?', conversation_id: a1.body.conversation_id });
    assert.strictEqual(a2.body.intent, 'products', 'follow-up in the same conversation');
    const other = issueToken({ id: 99, email: 'x@example.com', name: 'X', role: 'office', officeId: 2 }, SECRET);
    assert.strictEqual((await call('POST', '/api/ai/ask', other, { question: 'and today?', conversation_id: a1.body.conversation_id })).status, 404, 'another venue cannot read the conversation');

    const rec = await call('GET', `/api/ai/records?kind=bills&from=${encodeURIComponent('2026-11-16 00:00:00')}&to=${encodeURIComponent(NOW)}`, owner);
    assert.strictEqual(rec.body.rows.length, 4, 'the 4 bills today, never the other venue\'s');

    // Go: a manager's PIN buys an ai token; a clerk's does not.
    const till = issueTerminalToken({ officeEmail: OFFICE, officeId: 1, email: 'owner@example.com' }, SECRET);
    assert.strictEqual((await call('POST', '/api/tap/ai/session', till, { clerk_id: 8, pin: '5555' })).status, 403, 'Jo is not a manager');
    assert.strictEqual((await call('POST', '/api/tap/ai/session', till, { clerk_id: 7, pin: '0000' })).status, 403, 'wrong PIN');
    const s = await call('POST', '/api/tap/ai/session', till, { clerk_id: 7, pin: '1234' });
    assert.strictEqual(s.status, 200);
    assert.strictEqual(jwt.verify(s.body.token, SECRET).scope, 'ai');
    assert.strictEqual((await call('GET', '/api/ai/briefing', s.body.token)).status, 200);
    assert.strictEqual((await call('GET', '/api/ai/briefing', till)).status, 401, 'a bare terminal token is not enough');

    // Invitations come from info@vesopasoftware.com.
    const inv = await call('POST', '/api/ai/invites', owner, { email: 'Accountant@Example.com', name: 'Ann', sites: [2, 99], profit: true, staff: false });
    assert.strictEqual(inv.status, 200);
    assert.strictEqual(mail[0].fromAddress, 'info@vesopasoftware.com');
    assert.strictEqual(mail[0].to, 'accountant@example.com');
    assert.strictEqual(members[0].sites, '[2]', 'only sites the venue has');
    assert.strictEqual((await call('POST', '/api/ai/invites', owner, { email: 'accountant@example.com' })).status, 409);

    assert.ok(!writes.some((w) => /epos_orders|epos_order_lines|bo_products/.test(w)), 'nothing written to sales or products');
  } finally {
    server.close();
  }
  console.log('ai-advisor: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
