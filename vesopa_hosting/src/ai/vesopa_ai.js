/**
 * Vesopa AI client: every model call from every Vesopa service goes through here.
 *
 * ONE FILE, EVERY SERVICE
 *
 * This is the canonical copy. `tool/sync-ai-client.sh` copies it into each Node
 * service (vesopa_hosting/src/ai/vesopa_ai.js, vesopasoftware/server/lib/
 * vesopa_ai.cjs) because each service is deployed on its own and cannot reach
 * a sibling folder at runtime. `shared/ai-client/test` fails if a copy drifts.
 * Edit here, then sync. No dependencies beyond Node 18+ (global fetch).
 *
 * THE POLICY (owner-approved 2026-10-03, /mnt/project-files/ai/
 * deepseek-model-policy-plan.md), in code:
 *
 *   - DeepSeek `deepseek-flash` for everything. It reads images; v4-pro costs
 *     about 4.4x, cannot see images, and DeepSeek's own notes rank it below
 *     V4.1-Flash. Quality is bought with thinking effort, not a bigger model.
 *   - Tiers: T0 thinking off, T1 low, T2 high, T3 max. Thinking is ON by
 *     default at DeepSeek, so every request states it explicitly, and every
 *     request sets max_tokens (the defaults are 8K / 64K).
 *   - Each purpose starts cheap and may climb one tier, never past its cap,
 *     when an answer fails its check or comes back empty.
 *   - NO CUSTOMER PERSONAL DATA GOES TO DEEPSEEK (servers in China; owner's
 *     decision). A call marked `personal: true` is refused here; the caller
 *     keeps those on its own UK/EU-side model. `redact()` strips the obvious
 *     identifiers from free text the caller cannot vouch for.
 *   - Gemini is the backup when DeepSeek is down, out of credit or busy. It
 *     is never used to get round the daily spending cap.
 *   - Every call is logged (no prompt text, only counts and cost) to
 *     <logDir>/ai-usage-YYYY-MM-DD.jsonl, and a daily cap per service stops
 *     spending before it surprises anybody.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DEEPSEEK_URL = 'https://api.deepseek.com';
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';
const MODEL = 'deepseek-flash';
const GEMINI_MODEL = 'gemini-3.5-flash-lite';

/* US dollars per million tokens, at PEAK. DeepSeek charges half off-peak;
   Gemini has no off-peak. Checked 2026-10-03 on api-docs.deepseek.com and
   ai.google.dev pricing. */
const PRICES = {
  'deepseek-flash': { hit: 0.006, miss: 0.30, out: 1.20, offPeakHalf: true },
  'deepseek-v4-pro': { hit: 0.044, miss: 1.32, out: 3.96, offPeakHalf: true },
  'gemini-3.5-flash-lite': { hit: 0.03, miss: 0.30, out: 2.50, offPeakHalf: false },
};

const TIERS = [
  { thinking: { type: 'disabled' } },
  { thinking: { type: 'enabled' }, reasoning_effort: 'low' },
  { thinking: { type: 'enabled' }, reasoning_effort: 'high' },
  { thinking: { type: 'enabled' }, reasoning_effort: 'max' },
];

/* Where each kind of work starts, and the highest it may climb. Public-facing
   purposes stop at T1; T3 is for internal developer tools only. */
const PURPOSES = {
  'site-chat':  { tier: 0, maxTier: 1, maxTokens: 700,   temperature: 0.4 }, // vesopasoftware.com AI bar
  'cloud-guide':{ tier: 0, maxTier: 1, maxTokens: 900,   temperature: 0.5 }, // Vesopa Cloud assistant, no personal data
  'studio':     { tier: 0, maxTier: 1, maxTokens: 9000,  temperature: 0.6 }, // Vesopa Studio, streamed HTML
  'summary':    { tier: 0, maxTier: 1, maxTokens: 1500,  temperature: 0.2 },
  'extract':    { tier: 0, maxTier: 1, maxTokens: 4000,  temperature: 0.2 },
  'translate':  { tier: 0, maxTier: 1, maxTokens: 4000,  temperature: 0.2 },
  'vision':     { tier: 0, maxTier: 1, maxTokens: 1000,  temperature: 0.2 },
  'code':       { tier: 2, maxTier: 3, maxTokens: 16000, temperature: 0.2 },
};

/** Peak is 01:00-04:00 and 06:00-10:00 UTC, Monday to Friday. */
function isPeak(date = new Date()) {
  const day = date.getUTCDay();
  if (day === 0 || day === 6) return false;
  const h = date.getUTCHours();
  return (h >= 1 && h < 4) || (h >= 6 && h < 10);
}

/** What a call cost, from the usage block the API returned. */
function cost(model, usage, date = new Date()) {
  const p = PRICES[model] || PRICES[MODEL];
  const u = usage || {};
  const prompt = Number(u.prompt_tokens) || 0;
  const hit = Number(u.prompt_cache_hit_tokens != null ? u.prompt_cache_hit_tokens
    : (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens)) || 0;
  const miss = u.prompt_cache_miss_tokens != null ? Number(u.prompt_cache_miss_tokens) || 0 : Math.max(0, prompt - hit);
  const out = Number(u.completion_tokens) || 0;
  const factor = p.offPeakHalf && !isPeak(date) ? 0.5 : 1;
  return ((hit * p.hit + miss * p.miss + out * p.out) / 1e6) * factor;
}

/*
 * The identifiers that must not ride along in free text: email addresses,
 * phone numbers and card-like numbers. Business addresses and names are left
 * alone; a sentence about a bakery's opening hours is not personal data.
 */
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const CARD = /\b(?:\d[ -]?){13,19}\b/g;
const PHONE = /(?:\+?\d[\d ()-]{8,}\d)/g;
function redact(text) {
  return String(text == null ? '' : text)
    .replace(EMAIL, '[email removed]')
    .replace(CARD, (m) => (m.replace(/\D/g, '').length >= 13 ? '[number removed]' : m))
    .replace(PHONE, (m) => (m.replace(/\D/g, '').length >= 10 ? '[phone removed]' : m));
}
function looksPersonal(text) {
  return redact(text) !== String(text == null ? '' : text);
}

class BudgetError extends Error {
  constructor(app) {
    super(`AI daily spending cap reached for ${app}`);
    this.name = 'BudgetError';
    this.budget = true;
  }
}

function dayKey(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * @param {object} o
 * @param {string} o.app             service name, for the log
 * @param {string} o.apiKey          DeepSeek key ('' turns DeepSeek off)
 * @param {string} [o.baseUrl]
 * @param {{apiKey:string, model?:string}} [o.gemini]  the backup
 * @param {number} [o.dailyCapUsd]   0 = no cap
 * @param {string} [o.logDir]        where ai-usage-*.jsonl go; '' = no file
 * @param {Function} [o.fetch]       for tests
 * @param {Function} [o.now]         for tests
 */
function createClient(o = {}) {
  const app = String(o.app || 'vesopa');
  const apiKey = String(o.apiKey || '');
  const baseUrl = String(o.baseUrl || DEEPSEEK_URL).replace(/\/+$/, '');
  const gemini = o.gemini && o.gemini.apiKey ? { apiKey: o.gemini.apiKey, model: o.gemini.model || GEMINI_MODEL, baseUrl: (o.gemini.baseUrl || GEMINI_URL).replace(/\/+$/, '') } : null;
  const cap = Number(o.dailyCapUsd) || 0;
  const logDir = o.logDir || '';
  const doFetch = o.fetch || ((...a) => fetch(...a));
  const now = o.now || (() => new Date());
  const log = o.log || ((...a) => console.error(...a));

  let spent = { day: '', usd: 0 };

  function spentToday() {
    const day = dayKey(now());
    if (spent.day !== day) {
      spent = { day, usd: 0 };
      // Seed from today's file, so a restart does not reset the cap.
      if (logDir) {
        try {
          const file = path.join(logDir, `ai-usage-${day}.jsonl`);
          for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
            if (!line) continue;
            try { spent.usd += Number(JSON.parse(line).usd) || 0; } catch { /* a torn line */ }
          }
        } catch { /* no file yet */ }
      }
    }
    return spent.usd;
  }

  function record(row) {
    spentToday();
    spent.usd += row.usd || 0;
    if (!logDir) return;
    try {
      fs.mkdirSync(logDir, { recursive: true });
      fs.appendFileSync(path.join(logDir, `ai-usage-${dayKey(now())}.jsonl`), JSON.stringify(row) + '\n');
    } catch (err) {
      log('[ai-usage] could not write:', err.message);
    }
  }

  async function post(provider, body, { signal, timeoutMs }) {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const url = provider === 'gemini' ? `${gemini.baseUrl}/chat/completions` : `${baseUrl}/chat/completions`;
    const key = provider === 'gemini' ? gemini.apiKey : apiKey;
    try {
      const res = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const detail = (await res.text().catch(() => '')).slice(0, 300);
        const err = new Error(`${provider} ${res.status}: ${detail}`);
        err.status = res.status;
        throw err;
      }
      return { res, done: () => { clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); } };
    } catch (err) {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (err.name === 'AbortError' && !(signal && signal.aborted)) {
        const t = new Error(`${provider} timed out`);
        t.timeout = true;
        throw t;
      }
      throw err;
    }
  }

  /** Read an OpenAI-shaped SSE stream into one message, calling onDelta for visible text. */
  async function readStream(res, onDelta) {
    const decoder = new TextDecoder();
    let buf = '';
    let content = '';
    let finish = null;
    let usage = null;
    const calls = [];
    const handle = (data) => {
      let json;
      try { json = JSON.parse(data); } catch { return; }
      if (json.usage) usage = json.usage;
      const choice = json.choices && json.choices[0];
      if (!choice) return;
      if (choice.finish_reason) finish = choice.finish_reason;
      const d = choice.delta || {};
      if (d.content) {
        content += d.content;
        if (onDelta) onDelta(d.content);
      }
      if (Array.isArray(d.tool_calls)) {
        for (const tc of d.tool_calls) {
          const i = tc.index || 0;
          calls[i] = calls[i] || { id: '', type: 'function', function: { name: '', arguments: '' } };
          if (tc.id) calls[i].id = tc.id;
          if (tc.function && tc.function.name) calls[i].function.name += tc.function.name;
          if (tc.function && tc.function.arguments) calls[i].function.arguments += tc.function.arguments;
        }
      }
    };
    for await (const part of res.body) {
      buf += decoder.decode(part, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data && data !== '[DONE]') handle(data);
      }
    }
    const tool_calls = calls.filter(Boolean);
    return {
      message: { role: 'assistant', content, ...(tool_calls.length ? { tool_calls } : {}) },
      finish,
      usage: usage || {},
    };
  }

  async function once(provider, req, tier, maxTokens) {
    const isGemini = provider === 'gemini';
    const body = {
      model: isGemini ? gemini.model : MODEL,
      messages: req.messages,
      max_tokens: maxTokens,
      stream: Boolean(req.stream),
    };
    if (isGemini) {
      // The backup is Flash-Lite at its default effort (it refuses
      // reasoning_effort "none"). Gemini 3 tool calls carry a
      // thought_signature in extra_content; non-streamed messages keep it, so
      // a caller that appends `message` as returned stays valid.
      body.temperature = req.temperature;
    } else {
      Object.assign(body, TIERS[tier]);
      if (tier === 0) body.temperature = req.temperature; // ignored in thinking mode anyway
      if (req.userId) body.user_id = String(req.userId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || undefined;
    }
    if (req.stream) body.stream_options = { include_usage: true };
    if (req.tools && req.tools.length) {
      body.tools = req.tools;
      body.tool_choice = req.toolChoice || 'auto';
    }
    if (req.json) body.response_format = { type: 'json_object' };

    let emitted = false;
    const onDelta = req.onDelta ? (t) => { emitted = true; req.onDelta(t); } : null;
    const started = Date.now();
    try {
      const { res, done } = await post(provider, body, { signal: req.signal, timeoutMs: req.timeoutMs });
      let out;
      try {
        if (req.stream) {
          out = await readStream(res, onDelta);
        } else {
          const data = await res.json();
          const choice = data.choices && data.choices[0];
          if (!choice || !choice.message) throw new Error(`${provider}: empty answer`);
          out = { message: choice.message, finish: choice.finish_reason, usage: data.usage || {} };
        }
      } finally {
        done();
      }
      const model = body.model;
      const usd = cost(model, out.usage, now());
      record({
        ts: now().toISOString(), app, purpose: req.purpose, provider, model, tier: isGemini ? null : tier,
        hit: Number(out.usage.prompt_cache_hit_tokens) || 0,
        miss: Number(out.usage.prompt_cache_miss_tokens != null ? out.usage.prompt_cache_miss_tokens : out.usage.prompt_tokens) || 0,
        out: Number(out.usage.completion_tokens) || 0,
        usd: Math.round(usd * 1e7) / 1e7,
        ms: Date.now() - started,
        finish: out.finish || null,
        escalated: req._escalatedFrom != null ? req._escalatedFrom : null,
        reason: req._reason || null,
      });
      return { ...out, provider, model, tier, usd };
    } catch (err) {
      err.emitted = emitted;
      if (!(req.signal && req.signal.aborted)) {
        record({ ts: now().toISOString(), app, purpose: req.purpose, provider, model: body.model, tier, usd: 0, ms: Date.now() - started, error: String(err.status || err.message).slice(0, 80) });
      }
      throw err;
    }
  }

  /** DeepSeek trouble that the backup should cover: down, busy, out of credit, timed out. */
  function shouldFallBack(err) {
    if (!gemini || err.emitted) return false;
    if (err.timeout) return true;
    if (!err.status) return err.name !== 'AbortError';
    return err.status === 402 || err.status === 429 || err.status >= 500;
  }

  /**
   * One request.
   * @param {object} req
   * @param {string} req.purpose          a key of PURPOSES
   * @param {object[]} req.messages
   * @param {object[]} [req.tools]
   * @param {boolean} [req.stream]        with onDelta(text) for visible text
   * @param {number} [req.tier]           start here instead of the purpose's default
   * @param {Function} [req.validate]     (result) => true, or a reason string to climb a tier
   * @param {boolean} [req.personal]      the request carries personal data: refused
   * @param {string} [req.userId]         an opaque id, never an email or a name
   * @returns {Promise<{message, content, toolCalls, finish, usage, provider, model, tier, usd}>}
   */
  async function chat(req) {
    if (req.personal) throw new Error('Personal data is never sent to DeepSeek (Vesopa policy). Use the UK-side model.');
    const policy = PURPOSES[req.purpose];
    if (!policy) throw new Error(`unknown AI purpose ${req.purpose}`);
    if (!apiKey && !gemini) throw new Error('AI is not configured');
    if (cap && spentToday() >= cap) throw new BudgetError(app);

    const r = {
      ...req,
      temperature: req.temperature != null ? req.temperature : policy.temperature,
      timeoutMs: req.timeoutMs || (req.stream ? 120_000 : 90_000),
    };
    let tier = Math.min(req.tier != null ? req.tier : policy.tier, policy.maxTier);
    let maxTokens = req.maxTokens || policy.maxTokens;

    for (;;) {
      let result;
      try {
        if (!apiKey) throw Object.assign(new Error('deepseek not configured'), { status: 503 });
        result = await once('deepseek', r, tier, maxTokens);
      } catch (err) {
        if (!shouldFallBack(err)) throw err;
        log(`[ai] ${app}/${req.purpose}: DeepSeek failed (${String(err.status || err.message).slice(0, 60)}), using Gemini`);
        result = await once('gemini', r, 0, maxTokens);
      }
      const message = result.message || {};
      const content = String(message.content || '');
      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      const out = { ...result, content, toolCalls };

      // Streams cannot be taken back once shown, so they never climb here.
      if (req.stream || result.provider !== 'deepseek') return out;

      let reason = null;
      if (result.finish === 'length' && !content && !toolCalls.length) reason = 'empty, hit max_tokens';
      else if (typeof req.validate === 'function') {
        const v = req.validate(out);
        if (v !== true && v != null && v !== undefined) reason = String(v);
      }
      if (!reason) return out;
      if (tier >= policy.maxTier) {
        if (result.finish === 'length' && maxTokens < policy.maxTokens * 4) {
          maxTokens *= 2;
          r._escalatedFrom = tier;
          r._reason = reason;
          continue;
        }
        return out;
      }
      if (cap && spentToday() >= cap) return out;
      r._escalatedFrom = tier;
      r._reason = reason;
      tier += 1;
      if (result.finish === 'length') maxTokens *= 2;
    }
  }

  return {
    enabled: Boolean(apiKey || gemini),
    deepseek: Boolean(apiKey),
    backup: Boolean(gemini),
    chat,
    spentToday,
    overBudget: () => Boolean(cap) && spentToday() >= cap,
  };
}

module.exports = { createClient, PURPOSES, TIERS, PRICES, MODEL, GEMINI_MODEL, isPeak, cost, redact, looksPersonal, BudgetError };
