/**
 * The models behind Vesopa AI, through Amazon Bedrock's OpenAI-compatible
 * endpoint ("Mantle"). Plain fetch: the panel loads nothing from a third
 * party and adds no SDK for two calls.
 *
 *   chat()        the task model (AI_TASK_MODEL, Qwen3-coder-next): decides
 *                 what to say and which tools to call
 *   transcribe()  the voice model (AI_VOICE_MODEL, Voxtral): hears a clip and
 *                 writes down what was said. Sent as a chat message part —
 *                 Mantle has no /audio/transcriptions (tested: 404) — and
 *                 asked for the words alone.
 *
 * Nothing here knows about customers. The agent decides what the model is
 * allowed to see; this only carries it.
 */

const config = require('../config');

const ENABLED = Boolean(config.AI.API_KEY && config.AI.BASE_URL);

/**
 * One request, with one retry when the endpoint is momentarily full: Bedrock
 * answers 503 "Exceeded on-demand capacity" or 429 in a busy minute, and a
 * second try a moment later almost always goes through.
 */
async function call(path, body, opts = {}) {
  try {
    return await once(path, body, opts);
  } catch (err) {
    if (err.status !== 429 && err.status !== 503) throw err;
    await new Promise((r) => setTimeout(r, 1200 + Math.random() * 800));
    return once(path, body, opts);
  }
}

async function once(path, body, { timeoutMs = 60_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${config.AI.BASE_URL}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.AI.API_KEY}`,
        ...(config.AI.PROJECT_ID ? { 'openai-project': config.AI.PROJECT_ID } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
    if (!res.ok) {
      const message = (data && data.error && (data.error.message || data.error)) || text.slice(0, 300);
      const err = new Error(`AI ${res.status}: ${message}`);
      err.status = res.status;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One turn of the task model.
 * @returns {{message: object, usage: object}} the assistant message (content,
 *   tool_calls) as the API returned it.
 */
async function chat({ messages, tools, maxTokens = 700, temperature = 0.2 }) {
  const body = {
    model: config.AI.TASK_MODEL,
    messages,
    max_tokens: maxTokens,
    temperature,
  };
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  const data = await call('/chat/completions', body);
  const choice = data.choices && data.choices[0];
  if (!choice || !choice.message) throw new Error('AI: empty answer');
  return { message: choice.message, usage: data.usage || {} };
}

/**
 * What was said in a clip. `format` is what the browser recorded: the widget
 * sends 16 kHz mono WAV, which is the shape Voxtral was verified with.
 */
async function transcribe({ data, format = 'wav', language = 'en' }) {
  const body = {
    model: config.AI.VOICE_MODEL,
    max_tokens: 300,
    temperature: 0,
    // No system message: Voxtral on this endpoint refuses "system messages
    // ... and audio chunks" in one request. The instruction rides with the clip.
    messages: [
      {
        role: 'user',
        content: [
          { type: 'input_audio', input_audio: { data, format } },
          { type: 'text', text: `Transcribe this short voice message from a customer of a UK web-hosting company. Write exactly the words spoken in ${language === 'en' ? 'English' : language}, with normal punctuation, and nothing else: no commentary, no quotes, no translation. Domain names are written as one word with dots, e.g. "example dot co dot uk" -> example.co.uk, "my shop dot com" -> myshop.com. If there is no speech, reply with the single word: [silence]` },
        ],
      },
    ],
  };
  const out = await call('/chat/completions', body, { timeoutMs: 30_000 });
  const text = String((out.choices && out.choices[0] && out.choices[0].message && out.choices[0].message.content) || '').trim();
  if (!text || /^\[?silence\]?\.?$/i.test(text)) return '';
  return text.replace(/^["'“”]+|["'“”]+$/g, '').trim();
}

module.exports = { ENABLED, chat, transcribe };
