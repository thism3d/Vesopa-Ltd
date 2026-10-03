/* Vesopa AI — the assistant bar on vesopasoftware.com.
 *
 * DeepSeek (deepseek-flash, thinking off) through the shared client in
 * lib/vesopa_ai.cjs, with Gemini as the backup when DeepSeek is down. The
 * browser never sees a key: the page posts what the visitor typed, this
 * answers as Server-Sent Events. The model policy and its reasons live in the
 * shared client (shared/ai-client/vesopa_ai.js); only what is particular to
 * this page lives here.
 *
 *  - Grounding. SYSTEM below is everything the assistant may state as fact
 *    about Vesopa. It is sent first and never changes per request, so DeepSeek
 *    serves it from its context cache at 2% of the normal input price. Nothing
 *    variable (dates, the device) goes in it; that rides at the end.
 *  - No personal data to DeepSeek. Visitors are anonymous, and email
 *    addresses, phone numbers and card numbers are taken out of what they type
 *    before it leaves this server (redact()).
 *  - Saved conversations. A visitor gets a random key in their own browser and
 *    each conversation a random id; the transcript is kept here (ai_sessions)
 *    for 30 days so a reload, or coming back tomorrow, carries on. Nothing in
 *    it identifies the visitor, and "Forget" deletes it at once.
 *  - "Try again" asks once more with a little thinking (tier 1). That is as
 *    high as the public site goes.
 *  - Cost. Every call is logged to logs/ai-usage-*.jsonl and a daily cap
 *    (AI_DAILY_CAP_USD, $1 by default) stops spending; past it the bar says
 *    it is busy and points at info@vesopa.com.
 *
 * Only `user` and `assistant` turns are ever replayed, so the page cannot post
 * a `system` role and rewrite the rules.
 */
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { config } from "../lib/config.js";
import { q, one, exec } from "../lib/db.js";

const require = createRequire(import.meta.url);
const { createClient, redact, BudgetError } = require("../lib/vesopa_ai.cjs");

const router = Router();

const MAX_TURNS = 16;         // conversation depth replayed to the model
const MAX_CHARS = 1500;       // per message
const KEEP_DAYS = 30;         // how long a saved conversation lives
const ID = /^[A-Za-z0-9_-]{16,32}$/;

const ai = createClient({
  app: "vesopasoftware",
  apiKey: config.ai.deepseekKey,
  gemini: { apiKey: config.ai.geminiKey },
  dailyCapUsd: config.ai.dailyCapUsd,
  logDir: config.ai.logDir,
});

/* Grounding. Everything the assistant is allowed to state as fact about
   Vesopa lives here — if it is not in this block, the model is told to say it
   does not know rather than fill the gap. The alternative is an assistant on
   the front page of the company confidently inventing a price list. */
const SYSTEM = `You are Vesopa AI, the assistant on vesopasoftware.com.

WHO VESOPA IS
Vesopa Software Ltd is a software house in Baglan, Port Talbot, Wales (SA12 7AX).
Phone +44 1792 316282. Email info@vesopa.com. They build software and then run
it on their own infrastructure.

SHIPPED PRODUCTS — five Windows apps, all live on the Microsoft Store:
1. Vesopa EPOS — the till. Product ID 9PDMNJXNFZCW. Runs a full bar/restaurant
   service: catalogue, tables, open bills, split bills, cash and card tender,
   discounts, gratuity, receipts, reports. Keeps trading with no internet and
   syncs when the line returns. Card payments are driven from the till via Dojo.
2. Vesopa Kitchen — the kitchen display. Product ID 9P29NN3R5PGS. Orders arrive
   from the till as tickets with table, order ref, server, elapsed time and item
   list; staff mark them done. Open / counts / completed views.
3. Vesopa Customer Display — the second screen facing the customer.
   Product ID 9P8JCLQ5M3SQ. Shows the bill building live as it is rung through,
   with the running total, and plays the venue's own adverts between sales.
4. Vesopa Express — the self-service ordering kiosk. Product ID 9N5W5VLP2948.
   Customers browse the menu with pictures, build a meal, and pay by card on
   a Dojo card machine; the order goes straight to the till and the kitchen.
   A venue manager sets a kiosk up once by signing in with their Vesopa account.
5. Vesopa Loyalty — the customer's loyalty card. Product ID 9N6VWPJ25VPH.
   A member picks their venue, signs in with an emailed code, and shows a QR
   card at the till to collect and spend points. It also shows visits,
   membership details and the venue's news.

SERVICES
- Vesopa Menu (menu.vesopa.com) — the QR dine-in menu: a code on every table,
  the menu live from the till's catalogue, order and pay from the seat, tickets
  straight to the till and the kitchen screen, allergens on every dish. From
  £19 a month, order at the table £39, own domain £59; no commission on orders.
- Vesopa Loyalty online (loyalty.vesopa.com) — a venue's own white-label
  loyalty app: a web app at loyalty.vesopa.com/yourvenue from £29 a month, or
  published on Google Play and the Microsoft Store under the venue's name from
  £59 a month. Both need Vesopa EPOS at the venue. Prices exclude VAT.
- Custom builds — white-label apps for businesses outside hospitality too, for
  example the Metric Group membership app (metric.vesopa.com), where members register
  their number plates for the ANPR barriers at Metric car parks (web, Windows, Android).
  Customers follow their project, quotes and invoices in the client area at
  /portal.
- Vesopa Cloud (cloud.vesopa.com) — hosting: domain search, registration and
  transfer across hundreds of extensions, fast UK NVMe hosting, free SSL
  renewed automatically, mailboxes on your own domain, daily backups on the
  bigger plans, one-click WordPress, and one panel instead of cPanel. Starter,
  Business and Pro plans; prices are on cloud.vesopa.com. Vesopa Studio, inside
  Vesopa Cloud, builds a small-business website while you describe it, by
  typing or talking, and publishes it to your own domain.
- Vesopa ID (auth.vesopa.com) — one Vesopa account for every Vesopa product:
  the till, the dine-in menu, the back office, the kiosk and the hosting panel.
  Sign in with email, phone, a passkey, or Google, Apple, Microsoft or GitHub.
  Two-step verification, Argon2id password hashing, OpenID Connect with PKCE
  for developers, no tracking or advertising.
- Vesopa Mail (mail.vesopa.com) — business email.
- Vesopa Pay (pay.vesopa.com) — a payment layer over BTC and Lightning,
  settling through Vesopa's own self-hosted BTCPay Server.
- Vesopa EPOS (epos.vesopa.com) — the till product's own site.
- Custom build work: they take other people's problems and build for them,
  then host and support the result.

HOW WORK RUNS
Answer four questions on the site's quote builder and you get a costed band
immediately. A person reads every brief and returns a firm figure, usually
within one working day. Clients get a portal account on day one with live
progress, tasks, files, a direct message thread to the builders, and invoices.

LINKS — public pages you may give, as Markdown links [label](url):
- Microsoft Store: Vesopa EPOS https://apps.microsoft.com/detail/9PDMNJXNFZCW ,
  Vesopa Kitchen https://apps.microsoft.com/detail/9P29NN3R5PGS ,
  Vesopa Customer Display https://apps.microsoft.com/detail/9P8JCLQ5M3SQ ,
  Vesopa Express https://apps.microsoft.com/detail/9N5W5VLP2948 ,
  Vesopa Loyalty https://apps.microsoft.com/detail/9N6VWPJ25VPH
- Sites: https://vesopaepos.com (the till's site), https://backoffice.vesopaepos.com
  (the EPOS back office), https://menu.vesopa.com , https://loyalty.vesopa.com ,
  https://cloud.vesopa.com (domains at https://cloud.vesopa.com/domains),
  https://auth.vesopa.com (developer docs https://auth.vesopa.com/docs),
  https://mail.vesopa.com , https://pay.vesopa.com , https://metric.vesopa.com
- This site: get a price /#quote, client area /portal, support /support,
  privacy /privacy, terms /terms, cookies /cookies, delete my data /delete-my-data.
  Product sections on this page: /#epos /#kitchen /#display /#express /#loyalty
  /#online /#cloud /#auth /#pay /#builds /#how

PICTURES — public images on this site. When someone asks to see a product, or
for pictures or screenshots, show one or two with Markdown image syntax
![short caption](path). Use only these paths, exactly as written:
- /assets/screenshots/epos_home.webp — EPOS sale screen: bill, product tiles, categories
- /assets/screenshots/epos_pay.webp — EPOS payment screen: cash and card tender, keypad
- /assets/screenshots/kitchen_home.webp — Kitchen display with open order tickets
- /assets/screenshots/display_home.webp — Customer Display: live bill and advert panel
- /assets/screenshots/express_1.webp — Express kiosk welcome screen
- /assets/screenshots/express_2.webp — Express kiosk menu with pictures and order summary
- /assets/screenshots/express_3.webp — Express kiosk item with allergens and "make it a meal"
- /assets/screenshots/loyalty_1.webp — Loyalty card with QR code and points
- /assets/screenshots/loyalty_3.webp — Loyalty news panel
- /assets/photo/menu_table-800.webp — dine-in menu on a phone beside a table QR stand
- /assets/photo/kiosk_order-800.webp — customer ordering at an Express kiosk
- /assets/photo/loyalty_wallet-800.webp — loyalty card shown at a coffee counter
- /assets/photo/auth_passkey-800.webp — Vesopa ID passkey sign-in on a phone
- /assets/photo/portal_desk-800.webp — the client area: project, quote and invoices
- /assets/photo/gate_anpr-800.webp — Metric car park barrier opening by number plate
- /assets/still/cloud_panel.webp — the Vesopa Cloud hosting panel
Logos and press material beyond these: info@vesopa.com.

HOW TO ANSWER
- When asked for links, give the real ones above. Never say you have no links
  or images: you have the ones listed here. Never make up a URL or image path.
- Keep it short: two or three sentences, unless asked for more. This is a chat
  dock on a web page, not an essay.
- Plain British English. Prose, not bullet lists, unless comparing things.
- The facts above are the full extent of what is known. For anything outside
  them — prices, dates, client names, case studies, staff, unlisted features —
  the honest answer is that you do not have it, followed by info@vesopa.com or
  the quote builder further up this page.
- Vesopa Pay settles BTC and Lightning through Vesopa's own BTCPay Server.
  Card payments are Dojo, driven from the till. Questions about regulatory
  status, licences or FCA registration belong with info@vesopa.com.
- Purchases happen on the Microsoft Store listing; you answer questions rather
  than take orders.
- End every answer with one last line of exactly three short follow-up
  questions the visitor might ask next, relevant to what was just discussed,
  in this form and nothing after it:
  >> First question? | Second question? | Third question?`;

const limiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "That is a lot of questions. Try again shortly." },
});

/** Phone, tablet or desktop, and the system, from the browser's own description. */
function deviceOf(req) {
  const ua = String(req.get("user-agent") || "");
  const kind = /iPad|Tablet|Android(?!.*Mobile)/i.test(ua) ? "tablet" : /Mobi|iPhone|Android/i.test(ua) ? "phone" : "desktop";
  const os = /Windows/i.test(ua) ? "Windows" : /iPhone|iPad|iOS/i.test(ua) ? "iOS" : /Android/i.test(ua) ? "Android"
    : /Mac OS X|Macintosh/i.test(ua) ? "macOS" : /Linux/i.test(ua) ? "Linux" : "";
  return { kind, os };
}

const newId = () => crypto.randomBytes(16).toString("base64url");

function clean(list) {
  return (Array.isArray(list) ? list : [])
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_CHARS) }));
}

async function loadSession(visitor, id) {
  if (!ID.test(String(visitor || "")) || !ID.test(String(id || ""))) return null;
  const row = await one("SELECT id, title, transcript FROM ai_sessions WHERE id = ? AND visitor = ?", [id, visitor]);
  if (!row) return null;
  let transcript = [];
  try { transcript = clean(typeof row.transcript === "string" ? JSON.parse(row.transcript) : row.transcript); } catch { /* a bad row reads as empty */ }
  return { id: row.id, title: row.title, transcript };
}

async function saveSession({ id, visitor, device, transcript, isNew }) {
  const kept = transcript.slice(-40);
  const title = (kept.find((m) => m.role === "user")?.content || "Conversation").replace(/\s+/g, " ").slice(0, 80);
  if (isNew) {
    await exec(
      "INSERT INTO ai_sessions (id, visitor, device, platform, title, transcript) VALUES (?, ?, ?, ?, ?, ?)",
      [id, visitor, device.kind, device.os, title, JSON.stringify(kept)],
    );
  } else {
    await exec("UPDATE ai_sessions SET transcript = ?, device = ?, platform = ?, updated_at = NOW() WHERE id = ? AND visitor = ?",
      [JSON.stringify(kept), device.kind, device.os, id, visitor]);
  }
}

// Old conversations go, a few at a time, whenever the bar is used.
let lastSweep = 0;
function sweep() {
  if (Date.now() - lastSweep < 3600_000) return;
  lastSweep = Date.now();
  exec(`DELETE FROM ai_sessions WHERE updated_at < NOW() - INTERVAL ${KEEP_DAYS} DAY LIMIT 500`).catch(() => {});
}

/** Is the assistant configured at all? The dock asks before it mounts. */
router.get("/ai/status", (req, res) => {
  res.json({ ok: true, enabled: config.ai.enabled });
});

/** This visitor's saved conversations, newest first, and the transcript of one. */
router.get("/ai/sessions", async (req, res) => {
  const visitor = String(req.query.visitor || "");
  if (!config.ai.enabled || !ID.test(visitor)) return res.json({ ok: true, sessions: [] });
  try {
    const rows = await q(
      `SELECT id, title, device, platform, updated_at FROM ai_sessions
        WHERE visitor = ? AND updated_at >= NOW() - INTERVAL ${KEEP_DAYS} DAY ORDER BY updated_at DESC LIMIT 10`, [visitor]);
    const open = req.query.session ? await loadSession(visitor, String(req.query.session)) : null;
    res.json({ ok: true, sessions: rows, current: open });
  } catch (err) {
    console.error("ai sessions:", err.message);
    res.json({ ok: true, sessions: [] });
  }
});

/** "Forget this conversation", or every one of them. */
router.post("/ai/forget", limiter, async (req, res) => {
  const visitor = String(req.body?.visitor || "");
  if (!ID.test(visitor)) return res.status(400).json({ ok: false });
  const id = String(req.body?.session || "");
  if (id && ID.test(id)) await exec("DELETE FROM ai_sessions WHERE id = ? AND visitor = ?", [id, visitor]);
  else await exec("DELETE FROM ai_sessions WHERE visitor = ?", [visitor]);
  res.json({ ok: true });
});

router.post("/ai", limiter, async (req, res) => {
  if (!config.ai.enabled) {
    return res.status(503).json({ ok: false, error: "Vesopa AI is not configured." });
  }
  sweep();

  const body = req.body || {};
  const visitor = ID.test(String(body.visitor || "")) ? String(body.visitor) : "";
  const device = deviceOf(req);
  let session = visitor ? await loadSession(visitor, body.session).catch(() => null) : null;
  const isNew = Boolean(visitor) && !session;
  if (isNew) session = { id: newId(), transcript: [] };

  // The conversation so far: from the saved session when there is one, else
  // what the page sent (an older copy of the page, or storage turned off).
  let transcript = session ? session.transcript : clean(body.messages).slice(0, -1);
  const text = typeof body.text === "string" ? body.text.trim().slice(0, MAX_CHARS)
    : (clean(body.messages).filter((m) => m.role === "user").pop()?.content || "");
  const again = Boolean(body.again);
  if (again && session) {
    // Ask the last question once more: drop the answer it got.
    if (transcript.length && transcript[transcript.length - 1].role === "assistant") transcript = transcript.slice(0, -1);
    if (transcript.length && transcript[transcript.length - 1].role === "user") transcript = transcript.slice(0, -1);
  }
  if (!text) return res.status(400).json({ ok: false, error: "Nothing to answer." });

  const sent = [...transcript, { role: "user", content: text }].slice(-MAX_TURNS)
    .map((m) => (m.role === "user" ? { role: "user", content: redact(m.content) } : m));
  // Variable context goes last, so SYSTEM stays a cache hit.
  const note = `(Visitor's device: ${device.kind}${device.os ? `, ${device.os}` : ""}${device.kind === "phone" ? ". Keep it especially short." : ""})`;
  sent[sent.length - 1] = { role: "user", content: `${sent[sent.length - 1].content}\n\n${note}` };

  const ctl = new AbortController();
  res.on("close", () => { if (!res.writableEnded) ctl.abort(); });

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  // nginx buffers proxied responses by default, which holds the whole stream
  // until it completes and turns this back into a non-streaming endpoint.
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
  const write = (obj) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); };
  if (session) write({ session: session.id });

  let answer = "";
  try {
    await ai.chat({
      purpose: "site-chat",
      tier: again ? 1 : 0,
      stream: true,
      signal: ctl.signal,
      userId: visitor || undefined,
      messages: [{ role: "system", content: SYSTEM }, ...sent],
      onDelta: (t) => { answer += t; write({ t }); },
    });
    if (!answer) {
      answer = "Sorry — I could not put that into words. Try asking it a different way.";
      write({ t: answer });
    }
  } catch (err) {
    if (ctl.signal.aborted) return res.end();
    const busy = err instanceof BudgetError;
    console.error("ai failed:", busy ? "daily cap reached" : String(err.message || err).slice(0, 200));
    const sorry = busy
      ? "Vesopa AI is resting for today. Email info@vesopa.com and a person will answer."
      : (answer ? " — sorry, that cut out. Please ask again." : "Vesopa AI could not be reached. Try again, or email info@vesopa.com.");
    write({ t: sorry, error: true });
    if (!res.writableEnded) res.write("data: [DONE]\n\n");
    return res.end();
  }

  if (!res.writableEnded) res.write("data: [DONE]\n\n");
  res.end();

  if (session && visitor) {
    saveSession({ id: session.id, visitor, device, isNew, transcript: [...transcript, { role: "user", content: redact(text) }, { role: "assistant", content: answer }] })
      .catch((err) => console.error("ai session save:", err.message));
  }
});

export default router;
