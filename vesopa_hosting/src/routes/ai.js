/**
 * Vesopa AI, over the wire. Mounted at /ai only when config.AI has a key.
 *
 *   GET  /ai/session   is the assistant on; is the customer signed in; for a
 *                      signed-in customer, their memory and recent transcript;
 *                      and the widget token every turn must carry
 *   POST /ai/turn      one turn: what they said (text or a clip), the page,
 *                      the language switch, and for a visitor what the
 *                      browser remembers
 *   POST /ai/speak     one line of a reply, spoken (src/ai/voice.js): only a
 *                      line a turn signed, so this is nobody's free TTS
 *   POST /ai/hear      a clip of speech, written down (Vesopa Studio's microphone)
 *   POST /ai/build/turn      Vesopa Studio: one turn of building a website,
 *                            streamed back as server-sent events
 *   POST /ai/build/render    the finished page, for a download
 *   GET  /ai/build/domains   where this customer could publish
 *   GET  /ai/build/source    the Studio source kept beside a published site
 *   POST /ai/build/publish   put the site live on one of those domains
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
const bedrock = require('../ai/bedrock');
const studio = require('../builder/agent');
const studioKit = require('../builder/kit');
const studioPublish = require('../builder/publish');
const studioPhotos = require('../builder/photos');
const voice = require('../ai/voice');
const { normaliseLang } = require('../ai/rules');

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

/** The customer's language for our own messages: the widget sends its switch. */
function words(req, en, bn) {
  return normaliseLang(req.body && req.body.lang) === 'bn' ? bn : en;
}

router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (req.method !== 'POST') return next();
  if (!auth.checkCsrf(req)) return res.status(403).json({ error: words(req, 'That page had been open too long. Reload it and try again.', 'পেজটা অনেকক্ষণ খোলা ছিল। একবার রিলোড করে আবার চেষ্টা করুন।') });
  if (!sameSite(req)) return res.status(403).json({ error: 'Not from this site.' });
  if (!tokenOk(req)) return res.status(401).json({ error: 'expired', reload: true });
  next();
});

router.get('/session', async (req, res) => {
  const customer = req.customer || null;
  const out = {
    enabled: true,
    signed_in: Boolean(customer),
    name: customer ? (customer.name || '') : '',
    token: mintToken(req),
    // The assistant's own voice is up; and the lines it says without a turn.
    voice: voice.available(),
    // The server's voice model can hear. The widget uses it for every
    // language: it is the only one of the two ears that follows a customer
    // who says "domain ta available kina dekhen" in one breath.
    hears: bedrock.ENABLED,
    phrases: voice.available() ? voice.phrases() : null,
  };
  if (customer) {
    out.memory = await agent.readMemory(customer);
    out.history = (await agent.readHistory(customer)).slice(-16);
  }
  res.json(out);
});

router.post('/turn', async (req, res) => {
  const who = req.customer ? `c${req.customer.id}` : req.ip;
  if (rateLimited('everyone', 'ai-global', { max: GLOBAL_10_MIN, windowMs: 600_000 })) {
    return res.status(503).json({ error: words(req, 'The assistant is very busy right now. Try again in a few minutes.', 'এই মুহূর্তে অনেক ভিড়। কয়েক মিনিট পরে আবার চেষ্টা করুন।') });
  }
  if (rateLimited(who, 'ai-turn', { max: config.AI.TURNS_PER_10_MIN, windowMs: 600_000 })) {
    return res.status(429).json({ error: words(req, 'That is a lot of questions in a short time. Give it a few minutes.', 'অল্প সময়ে অনেক প্রশ্ন হয়ে গেছে। কয়েক মিনিট একটু থামুন।') });
  }
  if (rateLimited(who, 'ai-day', { max: DAY_MAX, windowMs: 86_400_000 })) {
    return res.status(429).json({ error: words(req, 'You have reached today’s limit for the assistant. Support can help with anything else.', 'আজকের জন্য সহকারীর সীমা শেষ। অন্য কিছু লাগলে সাপোর্ট টিম সাহায্য করবে।') });
  }
  const body = req.body || {};
  const audio = body.audio && typeof body.audio.data === 'string' ? body.audio : null;
  if (audio) {
    const bytes = Math.floor((audio.data.length * 3) / 4);
    if (bytes > config.AI.MAX_AUDIO_BYTES) return res.status(413).json({ error: words(req, 'That clip is too long. Try a shorter sentence.', 'কথাটা একটু বেশি লম্বা হয়ে গেছে। ছোট করে বলুন।') });
    if (!/^(wav|mp3|webm|ogg|m4a)$/.test(String(audio.format || 'wav'))) return res.status(400).json({ error: 'Unsupported audio.' });
  }
  const text = typeof body.text === 'string' ? body.text.slice(0, 1000) : '';
  if (!audio && !text.trim() && !body.auto && !body.greet) return res.status(400).json({ error: 'Nothing to answer.' });

  try {
    const result = await agent.runTurn({
      customer: req.customer || null,
      currency: req.currency,
      text,
      spoken: Boolean(body.spoken) && Boolean(text),
      interrupted: Boolean(body.interrupted),
      audio,
      lang: body.lang,
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
    res.status(502).json({
      // The voice model could not hear the clip: the widget falls back to
      // the browser's own recogniser rather than listening into a void.
      deaf: Boolean(err.deaf),
      error: busy
        ? words(req, 'The assistant is busy for a moment. Try again shortly.', 'সহকারী এক মুহূর্ত ব্যস্ত। একটু পরে আবার বলুন।')
        : words(req, 'The assistant could not answer that. Try again, or ask support.', 'এটার উত্তর দিতে পারলাম না। আবার চেষ্টা করুন, বা সাপোর্টে জিজ্ঞেস করুন।'),
    });
  }
});

router.post('/speak', async (req, res) => {
  const body = req.body || {};
  const text = typeof body.text === 'string' ? body.text : '';
  const lang = normaliseLang(body.lang);
  if (!text || text.length > 900 || !voice.verify(text, lang, body.sig)) return res.status(403).json({ error: 'Not a line the assistant said.' });
  if (!voice.available()) return res.status(503).json({ fallback: true });
  const who = req.customer ? `c${req.customer.id}` : req.ip;
  if (rateLimited(who, 'ai-speak', { max: config.AI.SPEAKS_PER_10_MIN, windowMs: 600_000 })
    || rateLimited('everyone', 'ai-speak-global', { max: GLOBAL_10_MIN * 2, windowMs: 600_000 })) {
    return res.status(429).json({ fallback: true });
  }
  try {
    const file = await voice.synthesise(text, lang);
    res.type('audio/wav').send(file);
  } catch (err) {
    res.status(503).json({ fallback: true });
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

// ---- Hearing, for Vesopa Studio's microphone ------------------------------------

router.post('/hear', async (req, res) => {
  const who = req.customer ? `c${req.customer.id}` : req.ip;
  if (rateLimited(who, 'ai-hear', { max: 80, windowMs: 600_000 }) || rateLimited('everyone', 'ai-hear-global', { max: GLOBAL_10_MIN, windowMs: 600_000 })) {
    return res.status(429).json({ error: words(req, 'That is a lot of talking in a short time. Give it a few minutes.', 'অল্প সময়ে অনেক কথা হয়ে গেছে। কয়েক মিনিট একটু থামুন।') });
  }
  const audio = req.body && req.body.audio;
  if (!audio || typeof audio.data !== 'string') return res.status(400).json({ error: 'No audio.' });
  if (Math.floor((audio.data.length * 3) / 4) > config.AI.MAX_AUDIO_BYTES) return res.status(413).json({ error: words(req, 'That clip is too long. Try a shorter sentence.', 'কথাটা একটু বেশি লম্বা হয়ে গেছে। ছোট করে বলুন।') });
  if (!/^(wav|mp3|webm|ogg|m4a)$/.test(String(audio.format || 'wav'))) return res.status(400).json({ error: 'Unsupported audio.' });
  try {
    const text = await bedrock.transcribe({ data: audio.data, format: audio.format || 'wav', language: normaliseLang(req.body.lang) });
    res.json({ text });
  } catch (err) {
    console.error('[ai] hear failed:', err.message);
    res.status(502).json({ error: words(req, 'I could not hear that. Try again.', 'শুনতে পাইনি। আবার বলুন।') });
  }
});

// ---- Vesopa Studio: building a website by talking (src/builder) --------------------

const STUDIO_10_MIN = Number(process.env.AI_STUDIO_TURNS_PER_10_MIN) || 30;
const STUDIO_DAY = Number(process.env.AI_STUDIO_TURNS_PER_DAY) || 200;
const MAX_SITE_BYTES = 400_000;

function studioSite(req) {
  const site = req.body && req.body.site;
  if (!site || typeof site !== 'object') return studioKit.blankSite();
  if (JSON.stringify(site).length > MAX_SITE_BYTES) return null;
  return site;
}

/*
 * One turn, streamed. Each event is a line of JSON the studio applies as it
 * arrives -- a theme, a section while it is being written, a removal -- and
 * the last is {op:'end'}. `Cache-Control: no-transform` keeps compression()
 * from holding the stream back, and X-Accel-Buffering does the same for nginx.
 */
router.post('/build/turn', async (req, res) => {
  const who = req.customer ? `c${req.customer.id}` : req.ip;
  if (rateLimited('everyone', 'ai-global', { max: GLOBAL_10_MIN, windowMs: 600_000 })) {
    return res.status(503).json({ error: words(req, 'The studio is very busy right now. Try again in a few minutes.', 'এই মুহূর্তে অনেক ভিড়। কয়েক মিনিট পরে আবার চেষ্টা করুন।') });
  }
  if (rateLimited(who, 'studio-turn', { max: STUDIO_10_MIN, windowMs: 600_000 }) || rateLimited(who, 'studio-day', { max: STUDIO_DAY, windowMs: 86_400_000 })) {
    return res.status(429).json({ error: words(req, 'That is a lot of changes in a short time. Give it a few minutes.', 'অল্প সময়ে অনেক পরিবর্তন হয়ে গেছে। কয়েক মিনিট একটু থামুন।') });
  }
  const text = String((req.body && req.body.text) || '').trim().slice(0, 1500);
  if (!text) return res.status(400).json({ error: 'Nothing to build.' });
  const site = studioSite(req);
  if (!site) return res.status(413).json({ error: words(req, 'This site has grown too large for one page.', 'এই সাইটটা এক পেজের জন্য অনেক বড় হয়ে গেছে।') });

  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  const controller = new AbortController();
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });
  const send = (event) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`); };
  const lang = normaliseLang(req.body.lang);
  const started = Date.now();
  try {
    const said = await studio.runTurn({
      site,
      history: Array.isArray(req.body.history) ? req.body.history.slice(-10) : [],
      text,
      spoken: Boolean(req.body.spoken),
      selected: req.body.selected || null,
      chatLang: lang,
      emit: send,
      signal: controller.signal,
    });
    send({ op: 'end', say: said.say, ask: said.ask });
    console.log(`[studio] turn ${lang} ${Date.now() - started}ms, ${said.chars} chars`);
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error('[studio] turn failed:', String(err.message).slice(0, 300));
      const busy = err.status === 429 || err.status === 503;
      send({ op: 'error', error: busy
        ? words(req, 'The designer is busy for a moment. Try again shortly.', 'ডিজাইনার এক মুহূর্ত ব্যস্ত। একটু পরে আবার বলুন।')
        : words(req, 'Something went wrong while building. Nothing is lost: try again.', 'বানানোর সময় একটা সমস্যা হয়েছে। কিছু হারায়নি — আবার চেষ্টা করুন।') });
    }
  }
  res.end();
});

router.post('/build/render', (req, res) => {
  const site = studioSite(req);
  if (!site) return res.status(413).json({ error: 'Too large.' });
  res.type('html').send(studioKit.render(site));
});

function studioError(req, res, err, action) {
  if (err.publish || err.name === 'FileError' || err.status) {
    const nohosting = err.code === 'nohosting';
    return res.status(err.status || 400).json({ error: err.message, nohosting });
  }
  console.error(`[studio] ${action} failed:`, err.message);
  return res.status(500).json({ error: words(req, 'That did not work. Nothing was changed.', 'এটা কাজ করেনি। কিছুই বদলায়নি।') });
}

/**
 * Photographs for the tiles the designer marked with `data-photo`.
 *
 * A separate request rather than part of the turn's stream, on purpose: the
 * turn is already the slowest thing the customer waits for, and a photo search
 * is a network round trip to somebody else's API. Doing it here lets the
 * section appear with its emoji art straight away and the photo arrive a
 * moment later, instead of the whole section waiting on Pexels.
 *
 * The keys stay on this side. The browser gets image URLs and the credit it
 * must show; it never sees what was used to find them.
 */
router.post('/build/photos', async (req, res) => {
  if (!studioPhotos.available()) return res.json({ photos: [] });
  const who = req.customer ? `c${req.customer.id}` : req.ip;
  // Generous per person — a new site asks for six or eight at once — and
  // capped overall, because the Unsplash half of this is fifty an hour.
  if (rateLimited(who, 'studio-photos', { max: 120, windowMs: 600_000 })
      || rateLimited('everyone', 'studio-photos-global', { max: 1500, windowMs: 600_000 })) {
    return res.status(429).json({ photos: [] });
  }
  const wanted = (Array.isArray(req.body && req.body.wanted) ? req.body.wanted : [])
    .slice(0, 12)
    .map((w) => ({ query: String((w && w.query) || '').slice(0, 100), orientation: String((w && w.orientation) || '') }));
  const exclude = (Array.isArray(req.body && req.body.exclude) ? req.body.exclude : [])
    .slice(0, 60).map((x) => String(x).slice(0, 60));
  try {
    const photos = await studioPhotos.pick(wanted, exclude);
    return res.json({ photos });
  } catch (err) {
    console.error('[studio photos]', err.message);
    // No photos is a site that keeps its emoji art, not an error to show.
    return res.json({ photos: wanted.map(() => null) });
  }
});

router.get('/build/domains', async (req, res) => {
  if (!req.customer) return res.json({ signedIn: false, domains: [] });
  try {
    res.json({ signedIn: true, hosting: true, domains: await studioPublish.publishableDomains(req.customer) });
  } catch (err) {
    if (err.code === 'nohosting' || err.code === 'auth') return res.json({ signedIn: true, hosting: false, domains: [] });
    studioError(req, res, err, 'domains');
  }
});

router.get('/build/source', async (req, res) => {
  if (!req.customer) return res.status(401).json({ error: 'Sign in first.' });
  try {
    const site = await studioPublish.source(req.customer, req.query.domain);
    if (!site) return res.status(404).json({ error: words(req, 'There is no Studio site on that domain yet.', 'এই ডোমেইনে এখনো কোনো Studio সাইট নেই।') });
    res.json({ site });
  } catch (err) {
    studioError(req, res, err, 'source');
  }
});

router.post('/build/publish', async (req, res) => {
  if (!req.customer) return res.status(401).json({ error: words(req, 'Sign in to publish.', 'প্রকাশ করতে সাইন ইন করুন।') });
  if (req.body.confirm !== true) return res.status(400).json({ error: 'Confirm first.' });
  if (rateLimited(`c${req.customer.id}`, 'studio-publish', { max: 10, windowMs: 600_000 })) {
    return res.status(429).json({ error: words(req, 'That is a lot of publishing in a short time. Give it a few minutes.', 'অল্প সময়ে অনেকবার প্রকাশ হয়েছে। কয়েক মিনিট অপেক্ষা করুন।') });
  }
  const site = studioSite(req);
  if (!site) return res.status(413).json({ error: 'Too large.' });
  try {
    res.json(await studioPublish.publish(req.customer, req.body.domain, site));
  } catch (err) {
    studioError(req, res, err, 'publish');
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
