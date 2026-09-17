/**
 * Vesopa AI's own voice: the reply, spoken by a text-to-speech model that
 * sounds like a person, in English or Bangla.
 *
 * WHY THIS EXISTS. The first version spoke with the browser's built-in
 * voices. The owner's word for it was "a robot", and on Chrome for Windows
 * there is no Bangla voice at all, so a Bangla reply could not be spoken.
 * Bedrock has no speech model (checked again 2026-09-17: 38 models, none
 * speak), so the voice comes from Google's Gemini TTS, which does both
 * languages with natural voices.
 *
 * OFF UNLESS CONFIGURED, AND IT STEPS ASIDE WHEN IT FAILS. With no
 * AI_TTS_API_KEY nothing here runs and the widget uses the browser's voices
 * exactly as before. When the provider refuses (no credit, bad key, busy),
 * this rests for a while and the widget is told to use the browser's voices
 * until it comes back -- a customer hears a plainer voice, never silence.
 *
 * ONLY WHAT THE ASSISTANT SAID. Speech costs money per second, so /ai/speak
 * is not a text-to-speech service for anybody's text: each line it will
 * speak is signed by the turn that produced it (sign()), and anything else
 * is refused.
 */

const crypto = require('crypto');
const config = require('../config');

const ENABLED = Boolean(config.AI.TTS_API_KEY);
const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

let restingUntil = 0;

/** Is the voice worth asking right now? */
function available() {
  return ENABLED && Date.now() >= restingUntil;
}

function rest(ms, why) {
  restingUntil = Date.now() + ms;
  console.error(`[ai] voice resting ${Math.round(ms / 1000)}s: ${String(why).slice(0, 160)}`);
}

// ---- Signing ------------------------------------------------------------------

function secret() {
  return String(process.env.SESSION_SECRET || '');
}

function sign(text, lang) {
  return crypto.createHmac('sha256', secret()).update(`speak:${lang}:${text}`).digest('base64url');
}

function verify(text, lang, sig) {
  const expected = sign(text, lang);
  const given = String(sig || '');
  return given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

/**
 * A reply as the lines to speak, each signed. The first sentence goes on its
 * own so it can start playing while the rest is still being made.
 */
function lines(text, lang) {
  const s = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 900);
  if (!s) return [];
  const m = s.match(/^(.{12,220}?[.!?।](?=\s))\s+(.+)$/u);
  const parts = m ? [m[1], m[2]] : [s];
  return parts.map((t) => ({ text: t, lang, sig: sign(t, lang) }));
}

// ---- Speaking -----------------------------------------------------------------

const DIRECTION = {
  en: 'Say this in a warm, friendly, natural British voice, relaxed and unhurried, like a helpful person talking to a customer on the phone',
  bn: 'Say this in natural, everyday Bangladeshi Bangla, in a warm, friendly voice, relaxed and unhurried, like a helpful person talking to a customer on the phone',
};

/** 16-bit mono PCM -> a WAV file the browser can decode. */
function wav(pcm, rate) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

// The same few lines (a question, "switched to Bangla") come round often.
const cache = new Map();
const CACHE_MAX = 40;

/**
 * Speak one line.
 * @returns {Promise<Buffer>} a WAV file
 */
async function synthesise(text, lang) {
  if (!available()) throw Object.assign(new Error('voice unavailable'), { status: 503 });
  const key = `${lang}:${text}`;
  if (cache.has(key)) return cache.get(key);

  const voiceName = lang === 'bn' ? config.AI.TTS_VOICE_BN : config.AI.TTS_VOICE_EN;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  let res;
  let data;
  try {
    res = await fetch(`${BASE}/${encodeURIComponent(config.AI.TTS_MODEL)}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': config.AI.TTS_API_KEY },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `${DIRECTION[lang] || DIRECTION.en}: ${text}` }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
        },
      }),
      signal: controller.signal,
    });
    data = await res.json().catch(() => ({}));
  } catch (err) {
    rest(30_000, err.name === 'AbortError' ? 'timed out' : err.message);
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const message = String((data && data.error && data.error.message) || res.status);
    if (res.status === 401 || res.status === 403) rest(30 * 60_000, message);
    else if (res.status === 429 && /credit|billing|prepay|quota/i.test(message)) rest(15 * 60_000, message);
    else if (res.status === 429 || res.status >= 500) rest(30_000, message);
    throw Object.assign(new Error(`voice ${res.status}`), { status: res.status });
  }

  const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
  const audio = parts.find((p) => p.inlineData && p.inlineData.data);
  if (!audio) throw new Error('voice: no audio in the answer');
  const rate = Number((/rate=(\d+)/.exec(audio.inlineData.mimeType || '') || [])[1]) || 24000;
  const file = wav(Buffer.from(audio.inlineData.data, 'base64'), rate);

  if (text.length <= 160) {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, file);
  }
  return file;
}

/** Lines the widget says on its own, without a turn: the language switch. */
const PHRASES = {
  bn: 'ঠিক আছে, এখন থেকে বাংলায় কথা বলব।',
  en: "Okay, I'll speak English from now on.",
};

function phrases() {
  return Object.fromEntries(Object.entries(PHRASES).map(([lang, text]) => [lang, { text, lang, sig: sign(text, lang) }]));
}

module.exports = { ENABLED, available, sign, verify, lines, synthesise, phrases, wav };
