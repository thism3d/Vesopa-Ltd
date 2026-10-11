/**
 * "Ask the club": the helper on every page.
 *
 * Grounded only on content/club.json and the news, through the shared Vesopa
 * AI client (src/vesopa_ai.js, a copy of shared/ai-client; DeepSeek with
 * Gemini as the backup, a daily spending cap, usage logged without prompt
 * text). Visitors are anonymous: nothing identifying is sent, and email
 * addresses, phone numbers and card numbers are taken out of what they type
 * (redact) before it leaves this server. No conversation is stored here; the
 * page keeps its own history and sends the last few turns back.
 *
 * With no key, past the cap, or when the AI is down, the helper still
 * answers: from the club's own FAQ, by matching words. A visitor asking
 * where the club is should never be told to try again later.
 */
'use strict';

const { club, news } = require('./content');
const { createClient, redact, BudgetError } = require('./vesopa_ai');

const MAX_TURNS = 10;
const MAX_CHARS = 500;

const ai = createClient({
  app: 'pontardawerfc',
  apiKey: process.env.DEEPSEEK_API_KEY || '',
  gemini: { apiKey: process.env.GEMINI_API_KEY || '' },
  dailyCapUsd: Number(process.env.AI_DAILY_CAP_USD || 0.5),
  logDir: process.env.LOG_DIR || '',
});

const SITE = (process.env.SITE_URL || club.web.site).replace(/\/+$/, '');
const MEMBERS = (process.env.MEMBERS_URL || club.web.members).replace(/\/+$/, '');

/* Everything the helper may state as fact. Sent first and unchanged on every
   request, so the provider serves it from its cache. */
const SYSTEM = `You are the club helper on pontardawerfc.com, the website of ${club.name} (${club.full_name}, ${club.welsh_name}).

FACTS ABOUT THE CLUB (the whole of what you know):
${JSON.stringify({
    name: club.name, founded: club.founded, short: club.short, company: club.company, address: club.address,
    phone: club.phone, email: club.email, ground: club.ground, league: club.league, league_note: club.league_note,
    coaches: club.coaches, history: club.history, timeline: club.timeline, notable_players: club.notable_players,
    teams: club.teams, clubhouse: club.clubhouse, membership: club.membership, faq: club.faq,
  })}

LATEST NEWS: ${news.map((n) => `${n.date}: ${n.title}. ${n.summary}`).join(' | ')}

PAGES YOU MAY LINK TO, as Markdown links [label](url):
- Home ${SITE}/ ; History ${SITE}/club ; Teams ${SITE}/teams ; Fixtures, results and league table ${SITE}/fixtures ; Match tickets ${SITE}/tickets ; News ${SITE}/news
- Clubhouse, functions and sponsorship ${SITE}/clubhouse ; Menu and ordering ${SITE}/menu
- Membership ${SITE}/membership ; Members' app ${MEMBERS}/ ; Contact ${SITE}/contact
- Privacy ${SITE}/privacy ; Ordering terms ${SITE}/ordering-terms
- WRU fixtures and table ${club.web.wru_league} ; Facebook ${club.web.facebook} ; X ${club.web.x}

HOW TO ANSWER
- Short and friendly: two or three sentences, plain British English, like a helpful person behind the bar.
- Only state what is in the facts above. For anything else (opening hours, prices, today's menu, fixtures, results, people, events), say you don't have that and point to the right page, the phone number ${club.phone} or Facebook.
- Food: the menu and prices are on the Menu & Order page, live from the till. You cannot take orders or bookings yourself.
- Matches: fixtures, kick-off times, results and the league table are on the Fixtures page, live from the WRU; match tickets are on the Tickets page.
- Never ask for or repeat personal details. Never make up a URL.
- If asked who you are: the club helper, an AI that answers from the club's own information.`;

/** Score each FAQ by shared words; the best one, or a general pointer. */
function faqAnswer(question) {
  const words = (s) => new Set(String(s).toLowerCase().match(/[a-z0-9]{3,}/g) || []);
  const stop = new Set(['the', 'and', 'you', 'can', 'how', 'what', 'does', 'for', 'with', 'are', 'your', 'club', 'pontardawe', 'rfc', 'there', 'have', 'any', 'this', 'that', 'want', 'get']);
  const SAME = {
    join: ['member'], membership: ['member'], members: ['member'], sign: ['member'], discount: ['member'],
    food: ['order', 'menu'], eat: ['order', 'food'], takeaway: ['collection', 'order'], collect: ['collection'],
    hire: ['function'], party: ['function'], book: ['function'], find: ['where'], located: ['where'], address: ['where'],
    call: ['phone'], number: ['phone'], ring: ['phone'], games: ['fixtures'], results: ['fixtures'], kids: ['junior'],
    juniors: ['junior'], coach: ['coaches'], history: ['founded'], old: ['founded'], sponsor: ['sponsor'],
  };
  const asked = [...words(question)].filter((w) => !stop.has(w)).flatMap((w) => [w, ...(SAME[w] || [])]);
  let best = null;
  let bestScore = 0;
  for (const f of club.faq) {
    const have = words(`${f.q} ${f.a}`);
    const qWords = words(f.q);
    let score = 0;
    for (const w of asked) {
      if (qWords.has(w)) score += 2;
      else if (have.has(w)) score += 1;
      else if ([...have].some((h) => h.startsWith(w.slice(0, 4)) && w.length > 4)) score += 0.5;
    }
    if (score > bestScore) {
      bestScore = score;
      best = f;
    }
  }
  if (best && bestScore >= 1.5) return best.a;
  return `I'm not sure about that one. Call the club on ${club.phone}, message us on [Facebook](${club.web.facebook}), or have a look at the [contact page](${SITE}/contact).`;
}

/** The turns the page sent, cleaned: user and assistant only, short, redacted. */
function cleanTurns(raw) {
  const turns = Array.isArray(raw) ? raw.slice(-MAX_TURNS) : [];
  return turns
    .filter((t) => t && (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string')
    .map((t) => ({ role: t.role, content: redact(t.content.slice(0, MAX_CHARS * 2)) }));
}

/** Simple per-address limit: 30 questions in 10 minutes. */
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear();
  return recent.length > 30;
}

function helperRoute() {
  return async (req, res) => {
    const body = req.body || {};
    const question = String(body.q || '').trim().slice(0, MAX_CHARS);
    if (!question) return res.status(400).json({ error: 'Ask a question first.' });
    if (limited(req.ip)) return res.status(429).json({ error: 'That is a lot of questions. Try again in a few minutes.' });

    const messages = [{ role: 'system', content: SYSTEM }, ...cleanTurns(body.history), { role: 'user', content: redact(question) }];
    if (!ai.enabled || ai.overBudget()) {
      return res.json({ answer: faqAnswer(question), source: 'faq' });
    }
    try {
      const out = await ai.chat({ purpose: 'site-chat', messages, maxTokens: 450, timeoutMs: 25000 });
      const answer = String(out.content || '').trim();
      return res.json({ answer: answer || faqAnswer(question), source: answer ? 'ai' : 'faq' });
    } catch (err) {
      if (!(err instanceof BudgetError)) console.error('helper:', String(err.message || err).slice(0, 200));
      return res.json({ answer: faqAnswer(question), source: 'faq' });
    }
  };
}

module.exports = { helperRoute, faqAnswer, SYSTEM, ai };
