/**
 * The models behind Vesopa AI, through Amazon Bedrock's OpenAI-compatible
 * endpoint ("Mantle"). Plain fetch: the panel loads nothing from a third
 * party and adds no SDK for two calls.
 *
 *   chat()        the task model (AI_TASK_MODEL, Qwen3-coder-next): decides
 *                 which tools to call; and, with `model`, the talk model
 *                 (AI_TALK_MODEL) that words the reply
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
async function chat({ messages, tools, maxTokens = 700, temperature = 0.2, model = config.AI.TASK_MODEL, timeoutMs }) {
  const body = {
    model,
    messages,
    max_tokens: maxTokens,
    temperature,
  };
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  const data = await call('/chat/completions', body, timeoutMs ? { timeoutMs } : {});
  const choice = data.choices && data.choices[0];
  if (!choice || !choice.message) throw new Error('AI: empty answer');
  return { message: choice.message, usage: data.usage || {} };
}

/*
 * What the voice model is told. It used to say "the words spoken in
 * English ... no translation" whatever was said, and with Bengali speech it
 * translated, invented ("My name is Ian, I was wondering if you could help
 * me" for "help me set up my email") or answered [silence].
 *
 * Measured 2026-09-17 on Bengali clips (Meta MMS-TTS) and English ones
 * (Windows' voice), Voxtral Small:
 *   - with no language named, Bengali speech comes back in Urdu or
 *     Devanagari script, so Bangla needs the widget's switch;
 *   - naming Bangla and saying "verbatim" gives everyday sentences word for
 *     word; a list of example words in the prompt made it recite the list
 *     back on a short clip, so there is none;
 *   - the same instruction written in Bangla was worse (silence, an invented
 *     email address).
 * English is unchanged by the auto wording.
 */
/*
 * MEASURED, 2026-09-17, on real clips (C:/vtts/clips, the MMS-TTS Bengali
 * set plus stitched code-switched ones), five wordings against this model:
 *
 *   naming a language MAKES IT TRANSLATE. "The speaker is most likely
 *   speaking Bangla" turned a wholly English clip into Bengali script
 *   ("Hi there, could you check whether raheemstore.co.uk is available"
 *   came back as "হ্যালো। আপনি কি চেক করতে পারবেন..."), and naming English
 *   turned a Bangla clip into Urdu. Naming no language at all was right on
 *   every clip the model could hear, and was the only wording that kept
 *   BOTH halves of a sentence that changed language half way through.
 *
 * So there is one instruction for every language, it names none, and it says
 * plainly that a recording may change language part way and all of it is
 * wanted. `language` is still accepted and still passed by the caller, but
 * it no longer picks a different instruction -- that was the bug.
 *
 * What this cannot fix: the model's Bengali itself is poor -- short
 * technical Bengali comes back as nonsense whatever it is asked ("হোস্টিং
 * প্ল্যানের দাম কত?" -> "বোস্টন প্ল্যানেট ডাম।"). That is why the widget
 * still prefers the browser's own recogniser for Bangla and uses this only
 * where there is none.
 */
const HEAR_ANY = "Transcribe this recording word for word. Write every word in the language it was spoken in, using that language's own script: English words in English letters, Bangla words in Bengali script. The speaker may change language in the middle of a sentence; keep both halves. Do not translate anything. Do not leave anything out. Output only the transcript, nothing else. If nobody is speaking, output [silence].";

/**
 * What was said in a clip. `format` is what the browser recorded: the widget
 * sends 16 kHz mono WAV, which is the shape Voxtral was verified with.
 */
async function transcribe({ data, format = 'wav', language = 'en' }) {
  const body = {
    model: config.AI.VOICE_MODEL,
    // Long enough for the whole of a slow, thought-out sentence: the widget
    // now waits for a real pause rather than cutting in after 900ms.
    max_tokens: 600,
    temperature: 0,
    // No system message: Voxtral on this endpoint refuses "system messages
    // ... and audio chunks" in one request. The instruction rides with the clip.
    messages: [
      {
        role: 'user',
        content: [
          { type: 'input_audio', input_audio: { data, format } },
          { type: 'text', text: `${HEAR_ANY} Domain names are written as one word with dots (example.co.uk).` },
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
