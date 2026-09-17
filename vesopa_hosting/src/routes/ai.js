/**
 * Vesopa AI, over the wire. Mounted at /ai only when config.AI has a key.
 *
 *   GET  /ai/session   is the assistant on; is the customer signed in; for a
 *                      signed-in customer, their memory and recent transcript;
 *                      and the widget token every turn must carry
 *   POST /ai/turn      one turn: what they said (text or a clip), the page,
 *                      and for a visitor what the browser remembers
 *   POST /ai/import    a visitor signed in: the browser hands over what it
 *                      kept for them, once, and it becomes account memory
 *   POST /ai/forget    wipe the account's memory and transcript
 *
 * WHO MAY CALL IT. Every model call costs money, so a turn has to come from
 * the widget on this site and from somebody who is not hammering it:
 *
 *   the CSRF token, in a header, like the panel's own JSON calls -- a page on
 *   another site cannot read it;
 *   the Origin (or Referer) of the request must be this site;
 *   a widget token from /ai/session, signed with the session secret, good
 *   for four hours and tied to the caller's address -- a script that skips
 *   the page has nothing to send;
 *   a per-person limit (the customer id, or the address): so many turns in
 *   ten minutes and so many in a day;
 *   a limit for everybody together, so one busy hour cannot become a bill.
 *
 * The customer, when there is one, is whoever the session cookie says -- the
 * same middleware every panel page trusts.
 */

const crypto = require('crypto');
const express = require('express');
const auth = require('../auth');
const config = require('../config');
const db = require('../db');
const { rateLimited } = require('../http-utils');
const agent = require('../ai/agent');

const router = express.Router();
const TOKEN_TTL_MS = 4 * 60 * 60 * 1000;

// ---- The widget token -------------------------------------------------------

function secret() {
  return String(process.env.SESSION_SECRET || '');
}
function ipKey(req) {
  // The first three octets: a phone changing address on the same network keeps its token.
  const ip = String(req.ip || '').replace(/^::ffff:/, '');
  return ip.includes(':') ? ip.split(':').slice(0, 4).join(':') : ip.split('.').slice(0, 3).join('.');
}
function mintToken(req) {
  const body = Buffer.from(JSON.stringify({ ip: ipKey(req), exp: Date.now() + TOKEN_TTL_MS, n: crypto.randomBytes(6).toString('base64url') })).toString('base64url');
  const mac = crypto.createHmac('sha256', secret()).update(`ai:${body}`).digest('base64url');
  return `${body}.${mac}`;
}
function tokenOk(req) {
  const token = String(req.get('x-ai-token') || '');
  const [body, mac] = token.split('.');
  if (!body || !mac) return false;
  const expected = crypto.createHmac('sha256', secret()).update(`ai:${body}`).digest('base64url');
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return false;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return payload.exp > Date.now() && payload.ip === ipKey(req);
  } catch {
    return false;
  }
}
function sameSite(req) {
  const origin = req.get('origin') || req.get('referer') || '';
  if (!origin) return false;
  try {
    return new URL(origin).host === new URL(config.SITE_URL).host;
  } catch {
    return false;
  }
}

// ---- Limits -----------------------------------------------------------------

const DAY_MAX = Number(process.env.AI_TURNS_PER_DAY) || 300;
const GLOBAL_10_MIN = Number(process.env.AI_TURNS_GLOBAL_PER_10_MIN) || 600;

router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (req.method !== 'POST') return next();
  if (!auth.checkCsrf(req)) return res.status(403).json({ error: 'That page had been open too long. Reload it and try again.' });
  if (!sameSite(req)) return res.status(403).json({ error: 'Not from this site.' });
  if (!tokenOk(req)) return res.status(401).json({ error: 'expired', reload: true });
  next();
});

router.get('/session', async (req, res) => {
  const customer = req.customer || null;
  const out = { enabled: true, signed_in: Boolean(customer), name: customer ? (customer.name || '') : '', token: mintToken(req) };
  if (customer) {
    out.memory = await agent.readMemory(customer);
    out.history = (await agent.readHistory(customer)).slice(-16);
  }
  res.json(out);
});

router.post('/turn', async (req, res) => {
  const who = req.customer ? `c${req.customer.id}` : req.ip;
  if (rateLimited('everyone', 'ai-global', { max: GLOBAL_10_MIN, windowMs: 600_000 })) {
    return res.status(503).json({ error: 'The assistant is very busy right now. Try again in a few minutes.' });
  }
  if (rateLimited(who, 'ai-turn', { max: config.AI.TURNS_PER_10_MIN, windowMs: 600_000 })) {
    return res.status(429).json({ error: 'That is a lot of questions in a short time. Give it a few minutes.' });
  }
  if (rateLimited(who, 'ai-day', { max: DAY_MAX, windowMs: 86_400_000 })) {
    return res.status(429).json({ error: 'You have reached today’s limit for the assistant. Support can help with anything else.' });
  }
  const body = req.body || {};
  const audio = body.audio && typeof body.audio.data === 'string' ? body.audio : null;
  if (audio) {
    const bytes = Math.floor((audio.data.length * 3) / 4);
    if (bytes > config.AI.MAX_AUDIO_BYTES) return res.status(413).json({ error: 'That clip is too long. Try a shorter sentence.' });
    if (!/^(wav|mp3|webm|ogg|m4a)$/.test(String(audio.format || 'wav'))) return res.status(400).json({ error: 'Unsupported audio.' });
  }
  const text = typeof body.text === 'string' ? body.text.slice(0, 1000) : '';
  if (!audio && !text.trim() && !body.auto && !body.greet) return res.status(400).json({ error: 'Nothing to answer.' });

  try {
    const result = await agent.runTurn({
      customer: req.customer || null,
      currency: req.currency,
      text,
      audio,
      page: body.page || {},
      voice: Boolean(body.voice),
      auto: Boolean(body.auto),
      pending: body.pending && typeof body.pending === 'object' ? body.pending : null,
      local: req.customer ? null : (body.local && typeof body.local === 'object' ? body.local : null),
    });
    res.json(result);
  } catch (err) {
    console.error('[ai] turn failed:', err.message);
    const busy = err.status === 429 || err.status === 503 || /timeout|abort|capacity/i.test(String(err.message));
    res.status(502).json({ error: busy ? 'The assistant is busy for a moment. Try again shortly.' : 'The assistant could not answer that. Try again, or ask support.' });
  }
});

router.post('/import', async (req, res) => {
  if (!req.customer) return res.status(401).json({ error: 'Not signed in.' });
  const body = req.body || {};
  const memory = Array.isArray(body.memory) ? body.memory.map(String).slice(0, 40) : [];
  const history = Array.isArray(body.history) ? body.history.slice(-16) : [];
  try {
    if (memory.length) {
      const existing = await agent.readMemory(req.customer);
      await agent.writeMemory(req.customer, agent.mergeFacts(existing, memory));
    }
    if (history.length) {
      const have = await agent.readHistory(req.customer);
      if (!have.length) {
        await agent.appendHistory(req.customer, history.filter((h) => h && (h.role === 'user' || h.role === 'assistant') && h.content));
      }
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[ai] import failed:', err.message);
    res.status(500).json({ error: 'Could not keep that.' });
  }
});

router.post('/forget', async (req, res) => {
  if (!req.customer) return res.status(401).json({ error: 'Not signed in.' });
  try {
    await db.query('DELETE FROM ai_memory WHERE customer_id = ?', [req.customer.id]);
    await db.query('DELETE FROM ai_messages WHERE customer_id = ?', [req.customer.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Could not forget that.' });
  }
});

module.exports = router;
