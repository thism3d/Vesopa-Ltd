/**
 * Vesopa AI's words: DeepSeek reads the figures and says what they mean.
 *
 * Two jobs, both optional (no DEEPSEEK_API_KEY, no model: the rule-written
 * answer from ai_answers.js stands, labelled as such):
 *
 *   classify()  a question the rules could not place, put into the same small
 *               shape the rules produce (subject, period, compare, site). The
 *               model can only pick from the lists it is given; anything else
 *               is thrown away.
 *
 *   explain()   the answer's headline, reasons and next steps, rewritten as a
 *               business advisor would say them, in the context of the
 *               conversation. The model is sent the facts and the rule-written
 *               draft and told it may not produce a number of its own.
 *
 * THE CHECK THAT MAKES IT SAFE (owner, 2026-11-16: "never invent sales,
 * profit, stock or staff figures"): every number in the model's text is
 * matched against the numbers in the facts, the draft and the question. One
 * number that matches nothing and the model's text is discarded whole; the
 * draft is shown instead, with `source: 'rules'`. A sum or a percentage the
 * model worked out for itself is treated exactly like an invented one.
 *
 * Nothing about a venue's customers leaves the server: facts are totals by
 * product, hour, site and member of staff (first names as the till holds
 * them), never a customer, a card or a bill.
 */
'use strict';

const ENDPOINT = process.env.DEEPSEEK_API_BASE || 'https://api.deepseek.com';
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
const TIMEOUT = 20000;

const NUMBER = /(£)?\s?(-?\d[\d,]*(?:\.\d+)?)\s?(%|k\b)?/gi;

/** Every number written in [text], as { value, money, percent }. */
function numbersIn(text) {
  const out = [];
  for (const m of String(text || '').matchAll(NUMBER)) {
    const raw = m[2].replace(/,/g, '');
    let value = Number(raw);
    if (!Number.isFinite(value)) continue;
    if (m[3] && m[3].toLowerCase() === 'k') value *= 1000;
    out.push({ value, money: Boolean(m[1]), percent: m[3] === '%', text: m[0].trim() });
  }
  return out;
}

/**
 * The numbers an answer may contain: each fact's value (pounds for money, as
 * written), its absolute value, and every number in the rule-written draft,
 * the metadata and the question.
 */
function allowedNumbers(answer, question) {
  const set = [];
  const add = (v) => { if (Number.isFinite(v)) { set.push(v); set.push(Math.abs(v)); } };
  for (const f of answer.facts || []) {
    if (f.value == null) continue;
    if (f.unit === 'money') add(f.value / 100); else add(f.value);
  }
  const texts = [answer.headline, answer.summary, ...(answer.why || []), ...(answer.next || []),
    question, answer.meta && answer.meta.period, answer.meta && answer.meta.compare, answer.meta && answer.meta.site,
    ...((answer.alerts || []).flatMap((a) => [a.title, a.body]))];
  for (const t of texts) for (const n of numbersIn(t)) add(n.value);
  return set;
}

function matches(n, allowed) {
  return allowed.some((a) => {
    if (Math.abs(n - a) < 0.005) return true;
    // Written rounded: £1,234 for £1,234.56, 12% for 12.4%.
    if (Number.isInteger(n) && Math.abs(Math.round(a) - n) < 0.5 && Math.abs(a) >= 10) return true;
    if (Math.abs(Math.round(a * 10) / 10 - n) < 0.005) return true;
    return false;
  });
}

/**
 * The numbers in [texts] that the facts do not support. Small counting words
 * written as digits ("top 3", "2 things") are let through, never as money or
 * a percentage.
 */
function unsupported(texts, allowed) {
  const bad = [];
  for (const t of texts) {
    for (const n of numbersIn(t)) {
      if (!n.money && !n.percent && Number.isInteger(n.value) && n.value >= 0 && n.value <= 12) continue;
      // Times of day and dates ("19:00", "16 Nov") come through the draft and
      // the period labels; a clock reading is split by the colon above.
      if (!matches(n.value, allowed)) bad.push(n.text);
    }
  }
  return bad;
}

async function callModel(messages, { fetchImpl = fetch, key = process.env.DEEPSEEK_API_KEY, maxTokens = 700 } = {}) {
  if (!key) return null;
  const res = await fetchImpl(`${ENDPOINT}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: MODEL, temperature: 0.2, max_tokens: maxTokens, response_format: { type: 'json_object' }, messages }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) throw new Error(`DeepSeek answered ${res.status}`);
  const body = await res.json();
  return JSON.parse(body.choices[0].message.content);
}

const PERIOD_KINDS = ['today', 'yesterday', 'this_week', 'last_week', 'this_month', 'last_month', 'last_days', 'day', 'weekday'];

/** The model's reading of a question the rules could not place, or null. */
async function classify(question, { intents, siteNames = [], today, prev, fetchImpl, key } = {}) {
  let out;
  try {
    out = await callModel([
      { role: 'system', content: [
        'You route questions from a UK pub, bar or restaurant owner to the right report in their EPOS.',
        `Subjects: ${intents.join(', ')}. briefing = overall how are we doing; takings = how much was made; compare = why something changed or a comparison; products = best/worst sellers; profit = profit and margins; stock = stock levels, reorders, stockouts; staff = team or employee performance; sites = comparing branches; focus = what to do tomorrow.`,
        `Period kinds: ${PERIOD_KINDS.join(', ')}. last_days takes "days"; day takes "date" (YYYY-MM-DD); weekday takes "dow" (0 Sunday to 6 Saturday).`,
        `Today is ${today}. Sites: ${siteNames.map((s) => `${s.id}=${s.name}`).join(', ') || 'none'}.`,
        'If the question is not about the business figures at all, use subject "none".',
        'Answer JSON only: {"subject": string, "period": {"kind": string, ...} or null, "compare": {"kind": string, ...} or null, "site": number or null}.',
      ].join(' ') },
      ...(prev ? [{ role: 'user', content: `Previous question understood as: ${JSON.stringify(prev)}` }] : []),
      { role: 'user', content: String(question).slice(0, 500) },
    ], { fetchImpl, key, maxTokens: 200 });
  } catch (e) {
    console.warn('[vesopa-ai] classify failed:', e.message);
    return null;
  }
  if (!out || !intents.includes(out.subject)) return null;
  const clean = (p) => (p && PERIOD_KINDS.includes(p.kind) ? { kind: p.kind, days: Number(p.days) || undefined, date: typeof p.date === 'string' ? p.date.slice(0, 10) : undefined, dow: Number.isInteger(p.dow) ? p.dow : undefined } : null);
  const site = siteNames.some((s) => s.id === Number(out.site)) ? Number(out.site) : null;
  return { intent: out.subject, period: clean(out.period), compare: clean(out.compare), site };
}

/**
 * The answer, explained. Returns { headline, why, next, source } where source
 * is 'ai' when the model's words passed the number check, 'rules' otherwise.
 */
async function explain(question, answer, { history = [], venue = 'the venue', fetchImpl, key } = {}) {
  const draft = { headline: answer.headline, why: answer.why || [], next: answer.next || [] };
  if (!answer.facts || !answer.facts.length || answer.intent === 'help') return { ...draft, source: 'rules' };
  let out;
  try {
    out = await callModel([
      { role: 'system', content: [
        `You are Vesopa AI, the business advisor inside Vesopa EPOS, talking to the owner or manager of ${venue}, a UK hospitality business.`,
        'You are given FACTS worked out from their own sales, and a DRAFT answer written from those facts.',
        'Rewrite the draft as a sharp, warm advisor would say it: what happened, why it matters, and what to do next. British English, plain words, no jargon, no hype.',
        'RULES: Use only numbers that appear in FACTS (their "display") or in the DRAFT, written the same way. Never add, subtract, average or work out a percentage yourself. Never guess causes the facts do not show; you may suggest things to check (weather, events, bookings) as questions, without numbers.',
        'Never promise to change anything: you are read-only, and any change (ordering stock, changing prices) is done by a person in the back office.',
        'Answer JSON only: {"headline": one sentence, "why": [at most 4 short sentences], "next": [at most 3 short, specific actions]}.',
      ].join(' ') },
      ...history.slice(-4).flatMap((h) => [{ role: 'user', content: h.q }, { role: 'assistant', content: h.a }]),
      { role: 'user', content: JSON.stringify({
        question: String(question).slice(0, 500),
        period: answer.meta && answer.meta.period,
        compared_with: answer.meta && answer.meta.compare,
        site: answer.meta && answer.meta.site,
        FACTS: answer.facts.map((f) => ({ label: f.label, display: f.display })),
        DRAFT: draft,
      }) },
    ], { fetchImpl, key });
  } catch (e) {
    console.warn('[vesopa-ai] explain failed:', e.message);
    return { ...draft, source: 'rules' };
  }
  if (!out) return { ...draft, source: 'rules' };
  const headline = String(out.headline || '').trim().slice(0, 300);
  const why = (Array.isArray(out.why) ? out.why : []).map((s) => String(s).trim().slice(0, 300)).filter(Boolean).slice(0, 4);
  const next = (Array.isArray(out.next) ? out.next : []).map((s) => String(s).trim().slice(0, 300)).filter(Boolean).slice(0, 3);
  if (!headline) return { ...draft, source: 'rules' };
  const bad = unsupported([headline, ...why, ...next], allowedNumbers(answer, question));
  if (bad.length) {
    console.warn('[vesopa-ai] discarded an explanation with unsupported numbers:', bad.join(', '));
    return { ...draft, source: 'rules', checked: `AI wording discarded: it used ${bad.length} figure${bad.length === 1 ? '' : 's'} not in your data.` };
  }
  return { headline, why, next: next.length ? next : draft.next, source: 'ai' };
}

const configured = () => Boolean(process.env.DEEPSEEK_API_KEY);

module.exports = { classify, explain, numbersIn, allowedNumbers, unsupported, configured, MODEL };
