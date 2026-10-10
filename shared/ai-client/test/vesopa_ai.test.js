// node --test shared/ai-client/test
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createClient, isPeak, cost, redact, looksPersonal, BudgetError } = require('../vesopa_ai');

const repo = path.resolve(__dirname, '../../..');

/** A fetch that answers from a list and remembers what it was sent. */
function fakeFetch(answers) {
  const sent = [];
  const fn = async (url, init) => {
    sent.push({ url, body: JSON.parse(init.body) });
    const a = answers.shift();
    if (a instanceof Error) throw a;
    if (a.status && a.status !== 200) return { ok: false, status: a.status, text: async () => 'busy' };
    return { ok: true, status: 200, json: async () => a };
  };
  fn.sent = sent;
  return fn;
}
const reply = (content, extra = {}) => ({
  choices: [{ message: { role: 'assistant', content }, finish_reason: extra.finish || 'stop' }],
  usage: { prompt_tokens: 1000, completion_tokens: 100, prompt_cache_hit_tokens: 800, prompt_cache_miss_tokens: 200, ...(extra.usage || {}) },
});
const offPeak = () => new Date('2026-10-03T12:00:00Z'); // a Saturday

test('every copy of the client matches the shared one', () => {
  const canonical = fs.readFileSync(path.join(__dirname, '../vesopa_ai.js'), 'utf8');
  for (const copy of ['vesopa_hosting/src/ai/vesopa_ai.js', 'vesopasoftware/server/lib/vesopa_ai.cjs', 'PontardaweRFC/website/src/vesopa_ai.js']) {
    assert.strictEqual(fs.readFileSync(path.join(repo, copy), 'utf8'), canonical, `${copy} has drifted: run tool/sync-ai-client.sh`);
  }
});

test('peak hours are 01-04 and 06-10 UTC on weekdays only', () => {
  assert.strictEqual(isPeak(new Date('2026-10-05T02:30:00Z')), true); // Monday
  assert.strictEqual(isPeak(new Date('2026-10-05T07:00:00Z')), true);
  assert.strictEqual(isPeak(new Date('2026-10-05T05:00:00Z')), false);
  assert.strictEqual(isPeak(new Date('2026-10-05T10:00:00Z')), false);
  assert.strictEqual(isPeak(new Date('2026-10-04T07:00:00Z')), false); // Sunday
});

test('cost uses cache hits, misses and output, and halves off-peak', () => {
  const usage = { prompt_tokens: 1e6, prompt_cache_hit_tokens: 5e5, prompt_cache_miss_tokens: 5e5, completion_tokens: 1e6 };
  const peak = cost('deepseek-flash', usage, new Date('2026-10-05T07:00:00Z'));
  assert.ok(Math.abs(peak - (0.003 + 0.15 + 1.2)) < 1e-9);
  assert.ok(Math.abs(cost('deepseek-flash', usage, offPeak()) - peak / 2) < 1e-9);
});

test('redact removes emails, phone numbers and card numbers, and keeps prices and dates', () => {
  const s = redact('Mail jo@shop.co.uk or ring 01792 316282, card 4111 1111 1111 1111. Hosting is £4.50 from 2026-10-03.');
  assert.ok(!s.includes('jo@shop'));
  assert.ok(!s.includes('316282'));
  assert.ok(!s.includes('4111'));
  assert.ok(s.includes('£4.50') && s.includes('2026-10-03'));
  assert.strictEqual(looksPersonal('What does hosting cost?'), false);
  assert.strictEqual(looksPersonal('I am jo@shop.co.uk'), true);
});

test('T0 states thinking off, sets max_tokens and temperature, and logs the cost', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-'));
  const f = fakeFetch([reply('Hello')]);
  const c = createClient({ app: 'test', apiKey: 'k', fetch: f, logDir: dir, now: offPeak });
  const r = await c.chat({ purpose: 'site-chat', messages: [{ role: 'user', content: 'secret-question' }], userId: 'v_123' });
  assert.strictEqual(r.content, 'Hello');
  const body = f.sent[0].body;
  assert.deepStrictEqual(body.thinking, { type: 'disabled' });
  assert.strictEqual(body.model, 'deepseek-flash');
  assert.strictEqual(body.max_tokens, 700);
  assert.strictEqual(body.temperature, 0.4);
  assert.strictEqual(body.user_id, 'v_123');
  const rows = fs.readFileSync(path.join(dir, 'ai-usage-2026-10-03.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].purpose, 'site-chat');
  assert.strictEqual(rows[0].hit, 800);
  assert.ok(rows[0].usd > 0);
  assert.ok(!JSON.stringify(rows[0]).includes('secret-question'), 'no prompt text in the log');
});

test('a failed check climbs one tier, and never past the purpose cap', async () => {
  const f = fakeFetch([reply('bad'), reply('still bad')]);
  const c = createClient({ app: 'test', apiKey: 'k', fetch: f });
  const r = await c.chat({ purpose: 'extract', messages: [{ role: 'user', content: 'x' }], validate: (o) => (o.content === 'good' ? true : 'not JSON') });
  assert.strictEqual(f.sent.length, 2, 'site-facing purposes stop at T1');
  assert.deepStrictEqual(f.sent[1].body.thinking, { type: 'enabled' });
  assert.strictEqual(f.sent[1].body.reasoning_effort, 'low');
  assert.strictEqual(r.content, 'still bad');
});

test('an empty answer that ran out of tokens climbs with a bigger budget', async () => {
  const f = fakeFetch([reply('', { finish: 'length' }), reply('ok')]);
  const c = createClient({ app: 'test', apiKey: 'k', fetch: f });
  const r = await c.chat({ purpose: 'summary', messages: [{ role: 'user', content: 'x' }] });
  assert.strictEqual(r.content, 'ok');
  assert.strictEqual(f.sent[1].body.max_tokens, 3000);
});

test('personal data is refused before anything is sent', async () => {
  const f = fakeFetch([]);
  const c = createClient({ app: 'test', apiKey: 'k', fetch: f });
  await assert.rejects(c.chat({ purpose: 'cloud-guide', personal: true, messages: [] }), /never sent to DeepSeek/);
  assert.strictEqual(f.sent.length, 0);
});

test('DeepSeek down or out of credit falls back to Gemini', async () => {
  for (const failure of [{ status: 503 }, { status: 402 }, { status: 429 }, new TypeError('fetch failed')]) {
    const f = fakeFetch([failure, reply('from gemini')]);
    const c = createClient({ app: 'test', apiKey: 'k', gemini: { apiKey: 'g' }, fetch: f });
    const r = await c.chat({ purpose: 'site-chat', messages: [{ role: 'user', content: 'hi' }] });
    assert.strictEqual(r.provider, 'gemini');
    assert.ok(f.sent[1].url.includes('generativelanguage.googleapis.com'));
    assert.strictEqual(f.sent[1].body.thinking, undefined, 'DeepSeek-only fields stay off the Gemini request');
  }
});

test('a bad request is not retried on Gemini', async () => {
  const f = fakeFetch([{ status: 400 }]);
  const c = createClient({ app: 'test', apiKey: 'k', gemini: { apiKey: 'g' }, fetch: f });
  await assert.rejects(c.chat({ purpose: 'site-chat', messages: [] }), /400/);
  assert.strictEqual(f.sent.length, 1);
});

test('the daily cap stops spending and survives a restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-'));
  const big = reply('x', { usage: { prompt_tokens: 0, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 0, completion_tokens: 2e6 } });
  const c1 = createClient({ app: 'test', apiKey: 'k', fetch: fakeFetch([big]), logDir: dir, dailyCapUsd: 1, now: offPeak });
  await c1.chat({ purpose: 'site-chat', messages: [] }); // $1.20 off-peak
  const f = fakeFetch([reply('never')]);
  const c2 = createClient({ app: 'test', apiKey: 'k', gemini: { apiKey: 'g' }, fetch: f, logDir: dir, dailyCapUsd: 1, now: offPeak });
  await assert.rejects(c2.chat({ purpose: 'site-chat', messages: [] }), (e) => e instanceof BudgetError);
  assert.strictEqual(f.sent.length, 0, 'the backup is not a way round the cap');
});

test('streams are read into one message with visible text passed on', async () => {
  const chunks = [
    'data: {"choices":[{"delta":{"reasoning_content":"hmm"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\ndata: {"choices":[{"delta":{"con',
    'tent":"lo"},"finish_reason":"stop"}]}\n\n',
    'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\ndata: [DONE]\n\n',
  ];
  const f = async () => ({ ok: true, status: 200, body: (async function* () { for (const c of chunks) yield Buffer.from(c); })() });
  const c = createClient({ app: 'test', apiKey: 'k', fetch: f });
  let seen = '';
  const r = await c.chat({ purpose: 'studio', stream: true, onDelta: (d) => { seen += d; }, messages: [] });
  assert.strictEqual(seen, 'Hello');
  assert.strictEqual(r.content, 'Hello');
  assert.strictEqual(r.finish, 'stop');
  assert.strictEqual(r.usage.completion_tokens, 2);
});
