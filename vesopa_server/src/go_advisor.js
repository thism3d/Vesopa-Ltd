/**
 * Vesopa AI in Vesopa Go: "Don't just see your business. Understand it."
 *
 * An owner opens the AI tab on Go and asks about the business in plain words
 * ("Why did sales drop yesterday?"). This file answers, from the venue's own
 * sales, products, stock and staff, and nothing else.
 *
 * HOW AN ANSWER IS MADE
 *
 *   1. Who is asking. A terminal token (the phone is one of the venue's
 *      tills) AND a Vesopa AI session: a member of staff's id and PIN, checked
 *      here, who is a manager (no permission group, or a group with
 *      is_manager, the same rule as every manager check on the server) or
 *      has redeemed an email invite from one. An invite can be for one site,
 *      and then every figure is for that site only. The session is re-checked
 *      on every request, so revoking an invite takes effect at once.
 *   2. What is asked: go_advisor_engine.parseQuestion, by rule, so it is fast
 *      and works with no model at all. Only a question the rules cannot place
 *      is shown to the model, to pick one of the fixed kinds of question.
 *   3. The figures: SQL here, office first in every WHERE, the site when one
 *      applies, never more than the kind of question needs. The arithmetic
 *      is go_advisor_engine.js and the answer's shape go_advisor_answers.js.
 *   4. The words: the plain wording is always made from the figures. When a
 *      model is set up (DEEPSEEK_API_KEY, GEMINI_API_KEY as its backup,
 *      through the shared Vesopa AI client and its spending cap), it is asked
 *      to explain the same figures more naturally. Staff names go as
 *      "Staff A", "Staff B" and are put back here; no customer data is ever
 *      read. Its sentences are checked: one quoting a figure that is not in
 *      the facts is discarded, and the plain wording is shown instead.
 *
 * READ-ONLY
 *
 * Vesopa AI changes nothing. Every route here reads, except the invites a
 * manager sends. A question asking it to change a price, order stock or
 * refund is answered with where to do it and who must approve it.
 *
 *   POST   /api/go/ai/session            staff id + PIN -> a Vesopa AI session
 *   POST   /api/go/ai/invites/redeem     staff id + PIN + emailed code -> session
 *   GET    /api/go/ai/briefing           today's briefing
 *   POST   /api/go/ai/ask                a question (or a kind of question) -> answer
 *   GET    /api/go/ai/records            the rows behind an answer
 *   GET    /api/go/ai/invites            managers: who is invited
 *   POST   /api/go/ai/invites            managers: invite somebody by email
 *   DELETE /api/go/ai/invites/:id        managers: revoke
 */
'use strict';

const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');

const { requireTerminal } = require('./auth');
const E = require('./go_advisor_engine');
const { BUILDERS, NEEDS, DEFINITIONS } = require('./go_advisor_answers');

const SESSION_TTL = '12h';
const INVITE_DAYS = 14;
const WORDED_PER_HOUR = 200; // per venue; past it, answers carry the plain wording
const PIN_TRIES = 5; // per member of staff per 10 minutes
const AI_TIMEOUT_MS = 12000;

class AdvisorError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** The shared Vesopa AI client, from the server's environment. */
function defaultAi() {
  const deepseek = process.env.DEEPSEEK_API_KEY || '';
  const gemini = process.env.GEMINI_API_KEY || '';
  if (!deepseek && !gemini) return null;
  const { createClient } = require('./ai/vesopa_ai');
  return createClient({
    app: 'vesopa_server',
    apiKey: deepseek,
    gemini: gemini ? { apiKey: gemini } : undefined,
    dailyCapUsd: Number(process.env.AI_DAILY_CAP_USD || 5),
    logDir: process.env.AI_LOG_DIR || '',
  });
}

const hashCode = (code) => crypto.createHash('sha256').update(String(code).trim().toUpperCase()).digest('hex');

/** Eight characters a person can read off an email and type: no 0/O or 1/I. */
function newCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(8);
  let s = '';
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return s;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A request to change something, which Vesopa AI never does. */
const WRITE_RE = /\b(change|set|update|edit|delete|remove|refund|void|cancel|create|raise|lower|increase|reduce|place|send|add)\b.{0,40}\b(price|prices|stock|order|orders|purchase|product|products|staff|rota|discount|refund|menu)\b/i;
const WRITE_HINT = /^(please\s+)?(order|reorder|restock|refund|void|delete|change|set|update)\b/i;

function goAdvisorRoutes({ pool, secret, ai = undefined, mail = undefined, now = () => new Date(), goClient = null, verifyIdToken = null, fetchImpl = (...a) => fetch(...a) }) {
  const router = express.Router();
  const terminal = requireTerminal(secret);
  const model = ai === undefined ? defaultAi() : ai;
  const send = mail || ((m) => require('./mailer').sendMail(m));
  const tries = new Map(); // office:clerk -> [failure times]
  const worded = new Map(); // office -> [times]
  const briefingWords = new Map(); // office:site:key -> {at, words}

  // ---- who is asking ------------------------------------------------------------

  async function clerkById(office, clerkId) {
    const [[c]] = await pool.query(
      `SELECT c.id, c.clark_name AS name, c.pin_code AS pin, c.permission_group_id AS grp, g.is_manager
         FROM bo_clarks c
         LEFT JOIN epos_permission_groups g ON g.id = c.permission_group_id AND g.email = c.email
        WHERE c.id = ? AND c.email = ? AND COALESCE(c.active, 1) = 1`,
      [Number(clerkId) || 0, office]);
    return c || null;
  }

  const isManager = (c) => c.grp == null || Number(c.is_manager) === 1;

  async function inviteFor(office, clerkId) {
    try {
      const [[inv]] = await pool.query(
        `SELECT id, site_id FROM go_ai_invites
          WHERE office = ? AND clerk_id = ? AND accepted_at IS NOT NULL AND revoked_at IS NULL
          ORDER BY id DESC LIMIT 1`,
        [office, Number(clerkId) || 0]);
      return inv || null;
    } catch (e) {
      if (e.code === 'ER_NO_SUCH_TABLE') return null;
      throw e;
    }
  }

  /** The PIN, with a limit on wrong guesses so a phone cannot be used to try them all. */
  async function checkPin(office, clerkId, pin) {
    const key = `${office}:${clerkId}`;
    const t = Date.now();
    const recent = (tries.get(key) || []).filter((x) => t - x < 600e3);
    if (recent.length >= PIN_TRIES) throw new AdvisorError(429, 'Too many wrong PINs. Try again in 10 minutes.');
    const c = await clerkById(office, clerkId);
    if (!c || String(c.pin) !== String(pin || '')) {
      tries.set(key, [...recent, t]);
      throw new AdvisorError(403, 'That PIN is not right.', 'bad_pin');
    }
    tries.delete(key);
    return c;
  }

  async function sites(office) {
    try {
      const [s] = await pool.query('SELECT id, name FROM bo_till_sites WHERE office = ? ORDER BY sort, name', [office]);
      const [t] = await pool.query('SELECT terminal, label, site_id FROM bo_till_names WHERE office = ?', [office]);
      return { sites: s, tills: t };
    } catch (e) {
      if (e.code === 'ER_NO_SUCH_TABLE') return { sites: [], tills: [] };
      throw e;
    }
  }

  async function access(office, clerk) {
    if (isManager(clerk)) return { role: 'manager', site: null };
    const inv = await inviteFor(office, clerk.id);
    if (inv) return { role: 'invited', site: inv.site_id == null ? null : Number(inv.site_id) };
    return null;
  }

  async function sessionFor(office, clerk) {
    const a = await access(office, clerk);
    if (!a) {
      throw new AdvisorError(403, `${clerk.name} has not been invited to Vesopa AI. A manager can invite you by email from the AI tab.`, 'not_invited');
    }
    const s = await sites(office);
    const token = jwt.sign({ scope: 'go-ai', office, clerk_id: clerk.id, role: a.role, site: a.site }, secret, { expiresIn: SESSION_TTL });
    return {
      token,
      name: clerk.name,
      role: a.role,
      site: a.site,
      sites: a.site == null ? s.sites.map((x) => ({ id: Number(x.id), name: x.name })) : s.sites.filter((x) => Number(x.id) === a.site).map((x) => ({ id: Number(x.id), name: x.name })),
      can_invite: a.role === 'manager',
      ai: model ? { on: true } : { on: false, why: 'AI wording is not switched on for this server (no DEEPSEEK_API_KEY or GEMINI_API_KEY). Every figure still works; explanations use plain wording.' },
      suggestions: E.SUGGESTIONS,
    };
  }

  /** The Vesopa AI session on this request, re-checked against the staff list and invites. */
  const advisor = async (req, res, next) => {
    try {
      const raw = String(req.headers['x-vesopa-ai'] || '');
      let claims;
      try {
        claims = jwt.verify(raw, secret);
      } catch {
        throw new AdvisorError(401, 'Sign in to Vesopa AI again.', 'session');
      }
      if (claims.scope !== 'go-ai' || claims.office !== req.office) throw new AdvisorError(401, 'Sign in to Vesopa AI again.', 'session');
      const clerk = await clerkById(req.office, claims.clerk_id);
      const a = clerk && (await access(req.office, clerk));
      if (!a) throw new AdvisorError(403, 'Your access to Vesopa AI has been withdrawn.', 'not_invited');
      req.ai = { clerk, role: a.role, site: a.site };
      next();
    } catch (e) { fail(res, e, next); }
  };

  // ---- on the web: go.vesopa.com/ai, for a PC or a laptop ----------------------
  //
  // The venue's owner (the email the venue is registered under) signs in with
  // Continue with Vesopa; so does anybody a manager invited by email, whose
  // invite is for that same email. Vesopa Auth has confirmed the address, so
  // no PIN is involved. The session is re-checked on every request, as the
  // phone's is: a revoked invite stops at once.

  async function webAccess(office, email) {
    const [[o]] = await pool.query('SELECT name, contact_email FROM offices WHERE contact_email = ?', [office]);
    if (!o) return null;
    if (String(o.contact_email).toLowerCase() === email) return { role: 'owner', site: null, venue: o.name };
    try {
      const [[inv]] = await pool.query(
        `SELECT id, site_id FROM go_ai_invites
          WHERE office = ? AND email = ? AND revoked_at IS NULL AND accepted_at IS NOT NULL
          ORDER BY id DESC LIMIT 1`,
        [office, email]);
      if (inv) return { role: 'invited', site: inv.site_id == null ? null : Number(inv.site_id), venue: o.name };
    } catch (e) {
      if (e.code !== 'ER_NO_SUCH_TABLE') throw e;
    }
    return null;
  }

  /** The venue this email may look at: its own first, else the newest live invite (accepted here). */
  async function webVenueFor(email) {
    const [[own]] = await pool.query('SELECT contact_email FROM offices WHERE contact_email = ? LIMIT 1', [email]);
    if (own) return own.contact_email;
    let inv;
    try {
      [[inv]] = await pool.query(
        `SELECT id, office, accepted_at FROM go_ai_invites
          WHERE email = ? AND revoked_at IS NULL AND (accepted_at IS NOT NULL OR expires_at > ?)
          ORDER BY id DESC LIMIT 1`,
        [email, E.sqlTime(now())]);
    } catch (e) {
      if (e.code !== 'ER_NO_SUCH_TABLE') throw e;
    }
    if (!inv) return null;
    if (!inv.accepted_at) {
      await pool.query('UPDATE go_ai_invites SET accepted_at = ? WHERE id = ? AND office = ?', [E.sqlTime(now()), inv.id, inv.office]);
    }
    return inv.office;
  }

  router.post('/api/go/ai/web/exchange', express.json(), async (req, res, next) => {
    try {
      const b = req.body || {};
      const redirect = String(b.redirect_uri || '');
      if (!/^https:\/\/(go\.vesopa\.com|go\.vesopaepos\.com|staging\.go\.vesopa\.com)\/ai\/?$/.test(redirect)
        && !(process.env.NODE_ENV === 'test' && /^http:\/\/127\.0\.0\.1/.test(redirect))) {
        throw new AdvisorError(400, 'That sign-in did not come from go.vesopa.com.');
      }
      const c = goClient && goClient();
      if (!c || !c.clientId || !verifyIdToken) throw new AdvisorError(503, 'Continue with Vesopa is not switched on for Vesopa AI yet.');
      const r = await fetchImpl(`${c.issuer}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: String(b.code || ''),
          redirect_uri: redirect,
          client_id: c.clientId,
          code_verifier: String(b.code_verifier || ''),
        }).toString(),
      });
      const tok = await r.json().catch(() => ({}));
      if (!r.ok || !tok.id_token) throw new AdvisorError(401, 'Vesopa refused that sign-in. Try again.');
      let claims;
      try {
        claims = await verifyIdToken(tok.id_token, 'go');
      } catch {
        throw new AdvisorError(401, 'That Vesopa sign-in could not be accepted. Try again.');
      }
      const email = String(claims.email || '').trim().toLowerCase();
      if (!email || claims.email_verified === false) throw new AdvisorError(403, 'Your Vesopa account needs a confirmed email address.');
      const office = await webVenueFor(email);
      const a = office && (await webAccess(office, email));
      if (!a) {
        throw new AdvisorError(403, `${email} is not a venue owner on Vesopa, and has no invite to Vesopa AI. Ask the venue's owner or a manager to invite this email.`, 'not_invited');
      }
      const name = String(claims.name || '').trim().slice(0, 80) || email;
      const s = await sites(office);
      res.json({
        token: jwt.sign({ scope: 'go-ai-web', office, email, name }, secret, { expiresIn: SESSION_TTL }),
        name,
        email,
        venue: a.venue,
        role: a.role,
        site: a.site,
        sites: (a.site == null ? s.sites : s.sites.filter((x) => Number(x.id) === a.site)).map((x) => ({ id: Number(x.id), name: x.name })),
        can_invite: a.role === 'owner',
        ai: model ? { on: true } : { on: false, why: 'AI wording is not switched on for this server. Every figure still works; explanations use plain wording.' },
        suggestions: E.SUGGESTIONS,
      });
    } catch (e) { fail(res, e, next); }
  });

  /** A phone (terminal token and a PIN session), or the website (a web session). */
  const aiAuth = async (req, res, next) => {
    let claims = null;
    try { claims = jwt.verify(String(req.headers['x-vesopa-ai'] || ''), secret); } catch { /* the phone's way, below */ }
    if (claims && claims.scope === 'go-ai-web') {
      try {
        const a = await webAccess(claims.office, claims.email);
        if (!a) throw new AdvisorError(403, 'Your access to Vesopa AI has been withdrawn.', 'not_invited');
        req.office = claims.office;
        req.ai = { clerk: { id: null, name: claims.name || claims.email }, role: a.role, site: a.site, web: true };
        return next();
      } catch (e) { return fail(res, e, next); }
    }
    return terminal(req, res, (err) => (err ? next(err) : advisor(req, res, next)));
  };

  const fail = (res, e, next) => (e instanceof AdvisorError ? res.status(e.status).json({ error: e.message, code: e.code || null }) : next(e));

  // ---- the site in scope ------------------------------------------------------------

  async function scope(req, wanted) {
    const s = await sites(req.office);
    let site = wanted == null || wanted === '' || wanted === 'all' ? null : Number(wanted);
    if (site != null && !Number.isInteger(site)) site = null;
    if (req.ai.site != null) {
      if (site != null && site !== req.ai.site) throw new AdvisorError(403, 'Your invite is for one site only.');
      site = req.ai.site;
    }
    const terminalSite = new Map(s.tills.filter((t) => t.site_id != null).map((t) => [String(t.terminal), Number(t.site_id)]));
    const siteNames = new Map(s.sites.map((x) => [Number(x.id), x.name]));
    const tillNames = new Map(s.tills.map((t) => [String(t.terminal), t.label || t.terminal]));
    if (site != null && !siteNames.has(site)) throw new AdvisorError(404, 'No such site at this venue.');
    return {
      site,
      label: site == null ? (s.sites.length ? 'All sites' : 'Whole venue') : siteNames.get(site),
      sql: site == null ? '' : ' AND o.terminal IN (SELECT terminal FROM bo_till_names WHERE office = ? AND site_id = ?)',
      params: site == null ? [] : [req.office, site],
      terminalSite,
      siteNames,
      tillNames,
    };
  }

  // ---- the figures --------------------------------------------------------------------

  async function periodFacts(office, sc, from, to, needs) {
    const win = ' AND o.closed_at IS NOT NULL AND o.closed_at >= ? AND o.closed_at < ?';
    const p = [office, from, to, ...sc.params];
    const out = {};
    const q = async (sql) => (await pool.query(sql, p))[0];
    if (needs.includes('totals')) {
      const [t] = await q(
        `SELECT COUNT(*) AS sales, COALESCE(SUM(o.total_minor), 0) AS gross_minor,
                COALESCE(SUM(o.discount_minor), 0) AS discount_minor, COALESCE(SUM(o.covers), 0) AS covers,
                MAX(o.closed_at) AS last_sale_at
           FROM epos_orders o WHERE o.email = ?${win}${sc.sql}`);
      out.totals = t || {};
    }
    if (needs.includes('hours')) {
      out.hours = await q(
        `SELECT HOUR(o.closed_at) AS hour, COUNT(*) AS sales, COALESCE(SUM(o.total_minor), 0) AS gross_minor
           FROM epos_orders o WHERE o.email = ?${win}${sc.sql}
          GROUP BY HOUR(o.closed_at) ORDER BY hour`);
    }
    if (needs.includes('days')) {
      out.days = await q(
        `SELECT DATE_FORMAT(o.closed_at, '%Y-%m-%d') AS day, COUNT(*) AS sales, COALESCE(SUM(o.total_minor), 0) AS gross_minor
           FROM epos_orders o WHERE o.email = ?${win}${sc.sql}
          GROUP BY day ORDER BY day`);
    }
    if (needs.includes('staff')) {
      out.staff = await q(
        `SELECT COALESCE(NULLIF(TRIM(o.clerk_name), ''), 'Unknown') AS name, COUNT(*) AS sales,
                COALESCE(SUM(o.total_minor), 0) AS gross_minor, COALESCE(SUM(o.discount_minor), 0) AS discount_minor
           FROM epos_orders o WHERE o.email = ?${win}${sc.sql}
          GROUP BY name ORDER BY gross_minor DESC`);
    }
    if (needs.includes('sites')) {
      out.terminals = await q(
        `SELECT COALESCE(o.terminal, '') AS terminal, COUNT(*) AS sales, COALESCE(SUM(o.total_minor), 0) AS gross_minor
           FROM epos_orders o WHERE o.email = ?${win}${sc.sql}
          GROUP BY terminal`);
    }
    if (needs.includes('products')) {
      out.products = await q(
        `SELECT l.plu_id, l.name, COALESCE(NULLIF(TRIM(p.department_name), ''), 'Unassigned') AS department,
                l.tax_percentage, p.cost_price,
                SUM(l.quantity) AS qty, SUM(l.unit_price_minor * l.quantity) AS sales_minor,
                SUM(COALESCE(l.discount_minor, 0)) AS discount_minor
           FROM epos_order_lines l
           JOIN epos_orders o ON o.id = l.order_id
           LEFT JOIN bo_products p ON p.pluid = l.plu_id AND p.email = o.email
          WHERE o.email = ?${win}${sc.sql} AND COALESCE(l.is_modifier, 0) = 0
          GROUP BY l.plu_id, l.name, department, l.tax_percentage, p.cost_price`);
    }
    return out;
  }

  async function stockFacts(office) {
    const since = E.sqlTime(new Date(now().getTime() - 28 * 86400000));
    const [rows] = await pool.query(
      `SELECT p.pluid, p.product_name, p.department_name, p.stock_quantity, p.low_stock_at, p.cost_price,
              COALESCE(s.qty, 0) AS sold_28d
         FROM bo_products p
         LEFT JOIN (
           SELECT l.plu_id, SUM(l.quantity) AS qty
             FROM epos_order_lines l
             JOIN epos_orders o ON o.id = l.order_id
            WHERE o.email = ? AND o.closed_at IS NOT NULL AND o.closed_at >= ?
            GROUP BY l.plu_id
         ) s ON s.plu_id = p.pluid
        WHERE p.email = ? AND p.stock_quantity IS NOT NULL
        LIMIT 3000`,
      [office, since, office]);
    return E.stockForecast(rows, { now: now() });
  }

  async function lastSale(office, sc) {
    const [[r]] = await pool.query(
      `SELECT MAX(o.closed_at) AS last FROM epos_orders o WHERE o.email = ? AND o.closed_at IS NOT NULL${sc.sql}`,
      [office, ...sc.params]);
    return r && r.last ? r.last : null;
  }

  /** Everything one kind of answer needs, for the period and the one it is compared with. */
  async function facts(office, sc, period, intent) {
    const needs = NEEDS[intent] || NEEDS.summary;
    const sqlNeeds = needs.filter((n) => n !== 'stock');
    const [cur, prev, stock] = await Promise.all([
      sqlNeeds.length ? periodFacts(office, sc, period.from, period.to, sqlNeeds) : {},
      sqlNeeds.length ? periodFacts(office, sc, period.compare.from, period.compare.to, sqlNeeds.filter((n) => n !== 'days')) : {},
      needs.includes('stock') ? stockFacts(office) : null,
    ]);
    // By till, under the name the back office gave it, for a venue with no sites.
    const tills = (rows) => (rows || []).map((r) => ({
      name: sc.tillNames.get(String(r.terminal)) || r.terminal || 'Unknown till',
      sales: Number(r.sales) || 0,
      gross_minor: Number(r.gross_minor) || 0,
    }));
    return {
      now: E.summary(cur.totals),
      before: E.summary(prev.totals),
      hours: cur.hours || [],
      hoursBefore: prev.hours || [],
      days: cur.days || [],
      products: E.products(cur.products),
      productsBefore: E.products(prev.products),
      staff: cur.staff || [],
      staffBefore: prev.staff || [],
      sites: E.sitesFromTerminals(cur.terminals, sc.terminalSite, sc.siteNames),
      sitesBefore: E.sitesFromTerminals(prev.terminals, sc.terminalSite, sc.siteNames),
      tills: tills(cur.terminals),
      tillsBefore: tills(prev.terminals),
      stock,
    };
  }

  // ---- the words ------------------------------------------------------------------------

  function wordingAllowed(office) {
    const t = Date.now();
    const list = (worded.get(office) || []).filter((x) => t - x < 3600e3);
    if (list.length >= WORDED_PER_HOUR) return false;
    worded.set(office, [...list, t]);
    return true;
  }

  /** The same figures with staff names swapped for "Staff A"... for the model. */
  function hidden(d) {
    const names = [...(d.staff || []), ...(d.staffBefore || [])].map((r) => r.name);
    const pseudo = E.pseudonyms(names);
    const swap = (rows) => (rows || []).map((r) => ({ ...r, name: pseudo.hide(r.name) }));
    return { d: { ...d, staff: swap(d.staff), staffBefore: swap(d.staffBefore) }, pseudo, names };
  }

  /**
   * Ask the model to explain figures we have already worked out. Returns
   * null (and the plain wording is used) when there is no model, it is busy,
   * over its budget, slow, or quotes a figure that is not in the facts.
   */
  async function word({ question, title, headline, why, factsForAi, pseudo, names }) {
    if (!model) return { words: null, status: 'off' };
    let q = String(question || title).slice(0, 400);
    for (const n of names) if (n && n.length > 2) q = q.split(n).join(pseudo.hide(n));
    const { redact } = require('./ai/vesopa_ai');
    const facts = { question_period_and_site: factsForAi.context, figures: factsForAi.figures, plain_answer: { headline: factsForAi.headline, why: factsForAi.why } };
    try {
      const r = await model.chat({
        purpose: 'advisor',
        json: true,
        timeoutMs: AI_TIMEOUT_MS,
        messages: [
          {
            role: 'system',
            content: [
              'You are Vesopa AI, the business advisor inside Vesopa Go, the EPOS app of a UK hospitality or retail business.',
              'You explain figures that have ALREADY been calculated by the EPOS server. Use ONLY figures that appear in FACTS, written exactly as they appear there. Never calculate, estimate, round differently or invent a figure, a product, a person or a reason that the facts do not support.',
              'Write in clear, warm British English for a busy owner: say what happened, why it matters, and what they could do next. No jargon, no markdown, no emojis.',
              'Vesopa AI is read-only: suggest, never claim to have changed anything.',
              'Answer JSON only: {"answer": "2 or 3 sentences that answer the question directly", "why": ["up to 3 short reasons, each citing a figure"], "next": [{"title": "a short action", "why": "one sentence"}] (up to 3)}.',
            ].join(' '),
          },
          { role: 'user', content: `QUESTION: ${redact(q)}\nFACTS: ${JSON.stringify(facts)}` },
        ],
      });
      let j;
      try { j = JSON.parse(r.content); } catch { return { words: null, status: 'unusable' }; }
      const answer = String(j.answer || '').trim().slice(0, 700);
      const whyOut = (Array.isArray(j.why) ? j.why : []).map((x) => String(x).trim().slice(0, 240)).filter(Boolean).slice(0, 3);
      const next = (Array.isArray(j.next) ? j.next : []).map((x) => ({ title: String((x && x.title) || '').trim().slice(0, 80), why: String((x && x.why) || '').trim().slice(0, 240) })).filter((x) => x.title).slice(0, 3);
      if (!answer) return { words: null, status: 'unusable' };
      const all = [answer, ...whyOut, ...next.map((n) => `${n.title} ${n.why}`)].join(' ');
      const bad = E.checkNarrative(all, facts);
      if (bad.length) return { words: null, status: 'rejected', rejected: bad.slice(0, 5) };
      return {
        words: { answer: pseudo.reveal(answer), why: whyOut.map((x) => pseudo.reveal(x)), next: next.map((n) => ({ title: pseudo.reveal(n.title), why: pseudo.reveal(n.why) })) },
        status: 'on',
        provider: r.provider,
      };
    } catch (e) {
      return { words: null, status: e.budget ? 'budget' : 'unavailable' };
    }
  }

  const AI_NOTES = {
    off: 'Plain wording: no AI model is set up on this server. The figures are exact either way.',
    budget: 'Plain wording: today\'s AI budget is used up. The figures are exact either way.',
    unavailable: 'Plain wording: the AI model did not answer in time. The figures are exact either way.',
    unusable: 'Plain wording: the AI model\'s answer could not be used. The figures are exact either way.',
    rejected: 'Plain wording: the AI model quoted a figure that is not in your data, so its answer was discarded.',
    limit: 'Plain wording: this venue has asked a lot this hour. The figures are exact either way.',
  };

  // ---- one answer -------------------------------------------------------------------------

  async function answer(req, { intent, periodKey, question, wantWords }) {
    const sc = await scope(req, req.body && req.body.site != null ? req.body.site : req.query.site);
    const period = E.resolvePeriod(periodKey, now());
    const d = await facts(req.office, sc, period, intent);
    const ctx = { period, site: sc };
    const built = BUILDERS[intent](d, ctx);
    let words = null;
    let status = 'off';
    let provider = null;
    let rejected;
    if (wantWords) {
      if (!model) status = 'off';
      else if (!wordingAllowed(req.office)) status = 'limit';
      else {
        const h = hidden(d);
        const forAi = BUILDERS[intent](h.d, ctx);
        const w = await word({
          question,
          title: built.title,
          headline: built.headline,
          why: built.why,
          factsForAi: { context: { period: period.label, compared_with: period.compare.label, site: sc.label }, figures: forAi.facts, headline: forAi.headline, why: forAi.why },
          pseudo: h.pseudo,
          names: h.names,
        });
        ({ words, status, provider, rejected } = w);
      }
    }
    const last = await lastSale(req.office, sc);
    return {
      intent,
      title: built.title,
      headline: built.headline,
      why: built.why || [],
      next: built.next || [],
      ai: words, // the model's wording of the same figures, when there is one
      ai_status: wantWords ? status : 'not_asked',
      ai_note: wantWords && status !== 'on' ? AI_NOTES[status] || null : null,
      ai_provider: provider || null,
      ai_rejected: rejected || undefined,
      cards: built.cards,
      follow_ups: E.FOLLOW_UPS[intent] || [],
      meta: {
        period: { key: period.key, label: period.label, from: period.from, to: period.to },
        compare: period.compare,
        site: { id: sc.site, label: sc.label },
        definitions: DEFINITIONS[intent] || [],
        freshness: {
          last_sale_at: last ? E.sqlTime(new Date(last)) : null,
          computed_at: E.sqlTime(now()),
          note: 'Sales count once a till has sent them to Vesopa; a till that is offline sends them when it reconnects.' + (NEEDS[intent].includes('stock') && sc.site != null ? ' Stock is held for the whole venue, not per site.' : ''),
        },
        records: { source: built.records, period: period.key, site: sc.site },
        read_only: true,
      },
    };
  }

  // ---- routes ----------------------------------------------------------------------------

  router.post('/api/go/ai/session', terminal, express.json(), async (req, res, next) => {
    try {
      const b = req.body || {};
      const clerk = await checkPin(req.office, b.clerk_id, b.pin);
      res.json(await sessionFor(req.office, clerk));
    } catch (e) { fail(res, e, next); }
  });

  router.post('/api/go/ai/invites/redeem', terminal, express.json(), async (req, res, next) => {
    try {
      const b = req.body || {};
      const clerk = await checkPin(req.office, b.clerk_id, b.pin);
      const code = String(b.code || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
      if (code.length < 6) throw new AdvisorError(400, 'Type the code from the invite email.');
      const [[inv]] = await pool.query(
        `SELECT id FROM go_ai_invites
          WHERE office = ? AND code_hash = ? AND revoked_at IS NULL AND accepted_at IS NULL AND expires_at > ?`,
        [req.office, hashCode(code), E.sqlTime(now())]);
      if (!inv) throw new AdvisorError(404, 'That code is not valid here: it may have been used, revoked or have expired. Ask for a new invite.', 'bad_code');
      await pool.query(
        'UPDATE go_ai_invites SET clerk_id = ?, accepted_at = ? WHERE id = ? AND office = ?',
        [clerk.id, E.sqlTime(now()), inv.id, req.office]);
      res.json(await sessionFor(req.office, clerk));
    } catch (e) { fail(res, e, next); }
  });

  router.post('/api/go/ai/ask', aiAuth, express.json(), async (req, res, next) => {
    try {
      const b = req.body || {};
      const question = String(b.question || '').trim().slice(0, 500);
      const previous = b.previous && typeof b.previous === 'object' ? { intent: E.INTENTS.includes(b.previous.intent) ? b.previous.intent : null, period: E.PERIODS.includes(b.previous.period) ? b.previous.period : null } : null;
      // A change to the business: never done here.
      if (question && (WRITE_RE.test(question) || WRITE_HINT.test(question)) && !/\bshould\b|\bwhat\b|\bwhich\b|\bwhy\b|\bhow\b/i.test(question)) {
        return res.json({
          intent: 'read_only',
          title: 'Vesopa AI only reads',
          headline: 'Vesopa AI looks at your figures but never changes them. Changes to prices, stock, orders, staff or refunds need a manager to approve them where they are made: in the back office, or with a manager\'s PIN on the till or Go.',
          why: ['Ask me what to reorder, which prices to look at or who needs support, and then make the change yourself.'],
          next: [],
          cards: [],
          follow_ups: ['What stock should I reorder?', 'Any products selling below cost?'],
          meta: { read_only: true },
        });
      }
      let intent = E.INTENTS.includes(b.intent) ? b.intent : null;
      let periodKey = E.PERIODS.includes(b.period) ? b.period : null;
      if (!intent) {
        const parsed = E.parseQuestion(question, previous);
        intent = parsed.intent;
        periodKey = periodKey || parsed.period;
        if (intent === 'unknown' && model && question) {
          // Only a question the rules cannot place goes to the model, and only to pick a kind.
          try {
            const { redact } = require('./ai/vesopa_ai');
            const r = await model.chat({
              purpose: 'advisor', json: true, timeoutMs: 8000, maxTokens: 120,
              messages: [
                { role: 'system', content: `Classify a business owner's question about their EPOS data. Answer JSON only: {"intent": one of ${JSON.stringify([...E.INTENTS, 'unknown'])}, "period": one of ${JSON.stringify(E.PERIODS)}}. Use "unknown" for anything that is not about their sales, products, profit, stock, staff, branches or busy hours.` },
                { role: 'user', content: redact(question) },
              ],
            });
            const j = JSON.parse(r.content);
            if (E.INTENTS.includes(j.intent)) intent = j.intent;
            if (E.PERIODS.includes(j.period)) periodKey = j.period;
          } catch { /* the rules' answer stands */ }
        }
      }
      if (intent === 'unknown') {
        return res.json({
          intent: 'unknown',
          title: 'Ask about your business',
          headline: 'I can answer questions about your sales, products, profit, stock, staff and branches, from your own Vesopa EPOS figures. Try one of these.',
          why: [],
          next: [],
          cards: [],
          follow_ups: E.SUGGESTIONS.slice(0, 6),
          meta: { read_only: true },
        });
      }
      const out = await answer(req, { intent, periodKey: periodKey || 'today', question, wantWords: b.words !== false });
      res.json({ ...out, question });
    } catch (e) { fail(res, e, next); }
  });

  /**
   * The briefing: today so far against the same time last week, yesterday
   * against the same day last week, what needs attention and what to do.
   */
  router.get('/api/go/ai/briefing', aiAuth, async (req, res, next) => {
    try {
      const sc = await scope(req, req.query.site);
      const today = E.resolvePeriod('today', now());
      const yesterday = E.resolvePeriod('yesterday', now());
      const week = E.resolvePeriod('last_7_days', now());
      const [dToday, dYesterday, dWeek] = await Promise.all([
        facts(req.office, sc, today, 'summary'),
        facts(req.office, sc, yesterday, 'why_change'),
        facts(req.office, sc, week, 'focus'),
      ]);
      const focus = BUILDERS.focus(dWeek, { period: week, site: sc });
      const why = BUILDERS.why_change(dYesterday, { period: yesterday, site: sc });
      const todaySummary = BUILDERS.summary(dToday, { period: today, site: sc });
      const headline = [todaySummary.headline, `Yesterday: ${why.headline.charAt(0).toLowerCase()}${why.headline.slice(1)}`].join(' ');
      let ai = null;
      let status = model ? 'on' : 'off';
      if (model && wordingAllowed(req.office)) {
        const key = `${req.office}:${sc.site}:${dToday.now.sales}:${dToday.now.revenue_minor}:${dYesterday.now.revenue_minor}`;
        const cached = briefingWords.get(key);
        if (cached && Date.now() - cached.at < 600e3) {
          ai = cached.words;
        } else {
          const h = hidden(dWeek);
          const hy = hidden(dYesterday);
          const w = await word({
            question: 'Give me my daily business briefing: how today is going, what happened yesterday and why, and what I should focus on.',
            title: 'Daily briefing',
            factsForAi: {
              context: { site: sc.label, today: today.label, yesterday: yesterday.label, week: week.label },
              figures: { today: todaySummary.facts, yesterday: BUILDERS.why_change(hy.d, { period: yesterday, site: sc }).facts, last_7_days: BUILDERS.focus(h.d, { period: week, site: sc }).facts },
              headline,
              why: [...why.why, ...focus.why].slice(0, 6),
            },
            pseudo: E.pseudonyms([...h.names, ...hy.names]),
            names: [...h.names, ...hy.names],
          });
          ai = w.words;
          status = w.status;
          if (ai) briefingWords.set(key, { at: Date.now(), words: ai });
        }
      } else if (model) status = 'limit';
      const last = await lastSale(req.office, sc);
      const hour = now().getHours();
      res.json({
        greeting: hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening',
        name: req.ai.clerk.name,
        headline,
        ai,
        ai_status: status,
        ai_note: status !== 'on' ? AI_NOTES[status] : null,
        today: { label: today.label, compare: today.compare.label, cards: todaySummary.cards.slice(0, 2) },
        yesterday: { label: yesterday.label, compare: yesterday.compare.label, headline: why.headline, why: why.why, cards: why.cards.slice(0, 2) },
        alerts: (focus.cards.find((c) => c.type === 'alerts') || { items: [] }).items,
        actions: focus.next,
        meta: {
          period: { key: 'today', label: today.label, from: today.from, to: today.to },
          compare: today.compare,
          site: { id: sc.site, label: sc.label },
          definitions: [...DEFINITIONS.summary, 'Alerts and suggestions look at the last 7 days against the 7 before, and at stock over the last 28 days.'],
          freshness: { last_sale_at: last ? E.sqlTime(new Date(last)) : null, computed_at: E.sqlTime(now()), note: 'Sales count once a till has sent them to Vesopa.' },
          records: { source: 'orders', period: 'today', site: sc.site },
          read_only: true,
        },
      });
    } catch (e) { fail(res, e, next); }
  });

  /** The rows behind an answer: what "View data" opens. Never customer details. */
  router.get('/api/go/ai/records', aiAuth, async (req, res, next) => {
    try {
      const sc = await scope(req, req.query.site);
      const period = E.resolvePeriod(String(req.query.period || 'today'), now());
      const source = String(req.query.source || 'orders');
      const win = ' AND o.closed_at IS NOT NULL AND o.closed_at >= ? AND o.closed_at < ?';
      let columns;
      let rows;
      if (source === 'orders') {
        const [r] = await pool.query(
          `SELECT o.id, o.closed_at, COALESCE(NULLIF(TRIM(o.clerk_name), ''), 'Unknown') AS staff, o.terminal, o.table_number,
                  o.covers, o.total_minor, o.discount_minor
             FROM epos_orders o WHERE o.email = ?${win}${sc.sql}
            ORDER BY o.closed_at DESC LIMIT 201`,
          [req.office, period.from, period.to, ...sc.params]);
        columns = [
          { key: 'time', label: 'Closed', kind: 'text' },
          { key: 'ref', label: 'Sale', kind: 'text' },
          { key: 'staff', label: 'Staff', kind: 'text' },
          { key: 'till', label: 'Till', kind: 'text' },
          { key: 'table_number', label: 'Table', kind: 'text' },
          { key: 'total_minor', label: 'Total', kind: 'money' },
          { key: 'discount_minor', label: 'Discount', kind: 'money' },
        ];
        rows = r.map((o) => ({
          time: o.closed_at ? E.sqlTime(new Date(o.closed_at)).slice(0, 16) : '',
          ref: String(o.id).slice(0, 8),
          staff: o.staff,
          till: sc.tillNames.get(String(o.terminal)) || o.terminal || '',
          table_number: o.table_number == null ? '' : String(o.table_number),
          total_minor: Number(o.total_minor) || 0,
          discount_minor: Number(o.discount_minor) || 0,
        }));
      } else if (source === 'products') {
        const d = await periodFacts(req.office, sc, period.from, period.to, ['products']);
        columns = [
          { key: 'name', label: 'Product', kind: 'text' },
          { key: 'department', label: 'Department', kind: 'text' },
          { key: 'qty', label: 'Sold', kind: 'count' },
          { key: 'gross_minor', label: 'Revenue', kind: 'money' },
          { key: 'net_minor', label: 'Net (no VAT)', kind: 'money' },
          { key: 'cost_minor', label: 'Cost', kind: 'money' },
          { key: 'gp_minor', label: 'Gross profit', kind: 'money' },
          { key: 'margin_pct', label: 'Margin', kind: 'pct' },
        ];
        rows = E.products(d.products).sort((a, b) => b.gross_minor - a.gross_minor).map((p) => ({ ...p, cost_minor: p.has_cost ? p.cost_minor : null }));
      } else if (source === 'stock') {
        const s = await stockFacts(req.office);
        columns = [
          { key: 'name', label: 'Product', kind: 'text' },
          { key: 'stock', label: 'In stock', kind: 'count' },
          { key: 'sold_28d', label: 'Sold (28 days)', kind: 'count' },
          { key: 'per_day', label: 'A day', kind: 'count' },
          { key: 'days_cover', label: 'Days left', kind: 'days' },
          { key: 'runs_out', label: 'Runs out', kind: 'text' },
          { key: 'reorder_qty', label: 'Reorder', kind: 'count' },
        ];
        rows = s.items;
      } else if (source === 'staff') {
        const d = await periodFacts(req.office, sc, period.from, period.to, ['staff']);
        columns = [
          { key: 'name', label: 'Staff', kind: 'text' },
          { key: 'sales', label: 'Sales', kind: 'count' },
          { key: 'gross_minor', label: 'Revenue', kind: 'money' },
          { key: 'average_minor', label: 'Average', kind: 'money' },
          { key: 'discount_minor', label: 'Discounts', kind: 'money' },
        ];
        rows = E.staffTable(d.staff);
      } else {
        throw new AdvisorError(400, 'Which records?');
      }
      const truncated = rows.length > 200;
      res.json({
        source,
        title: { orders: 'Sales', products: 'Products sold', stock: 'Stock', staff: 'Sales by staff' }[source],
        period: { key: period.key, label: period.label, from: period.from, to: period.to },
        site: { id: sc.site, label: sc.label },
        columns,
        rows: rows.slice(0, 200),
        truncated,
        note: truncated ? 'The latest 200 are shown. The back office Reports have the full list.' : null,
      });
    } catch (e) { fail(res, e, next); }
  });

  // ---- invites (managers) -----------------------------------------------------------------

  const managerOnly = (req) => {
    if (req.ai.role !== 'manager' && req.ai.role !== 'owner') throw new AdvisorError(403, 'Only a manager can invite people to Vesopa AI.');
  };

  router.get('/api/go/ai/invites', aiAuth, async (req, res, next) => {
    try {
      managerOnly(req);
      const [rows] = await pool.query(
        `SELECT i.id, i.email, i.site_id, i.invited_by, i.clerk_id, i.accepted_at, i.revoked_at, i.expires_at, i.created_at,
                c.clark_name AS clerk_name, s.name AS site_name
           FROM go_ai_invites i
           LEFT JOIN bo_clarks c ON c.id = i.clerk_id AND c.email = i.office
           LEFT JOIN bo_till_sites s ON s.id = i.site_id AND s.office = i.office
          WHERE i.office = ?
          ORDER BY i.id DESC LIMIT 100`,
        [req.office]);
      const t = now();
      res.json({
        invites: rows.map((r) => ({
          id: r.id,
          email: r.email,
          site: r.site_id == null ? null : { id: Number(r.site_id), name: r.site_name || `Site ${r.site_id}` },
          invited_by: r.invited_by,
          staff: r.clerk_name || null,
          status: r.revoked_at ? 'revoked' : r.accepted_at ? 'active' : new Date(r.expires_at) < t ? 'expired' : 'pending',
          created_at: r.created_at ? E.sqlTime(new Date(r.created_at)) : null,
        })),
      });
    } catch (e) { fail(res, e, next); }
  });

  router.post('/api/go/ai/invites', aiAuth, express.json(), async (req, res, next) => {
    try {
      managerOnly(req);
      const b = req.body || {};
      const email = String(b.email || '').trim().toLowerCase().slice(0, 255);
      if (!EMAIL_RE.test(email)) throw new AdvisorError(400, 'That does not look like an email address.');
      let siteId = b.site_id == null || b.site_id === '' ? null : Number(b.site_id);
      if (siteId != null) {
        const s = await sites(req.office);
        if (!s.sites.some((x) => Number(x.id) === siteId)) throw new AdvisorError(404, 'No such site at this venue.');
      }
      const code = newCode();
      const expires = new Date(now().getTime() + INVITE_DAYS * 86400000);
      const [ins] = await pool.query(
        `INSERT INTO go_ai_invites (office, email, code_hash, site_id, invited_by, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [req.office, email, hashCode(code), siteId, req.ai.clerk.name, E.sqlTime(expires)]);
      let venue = '';
      try {
        const [[o]] = await pool.query('SELECT name FROM offices WHERE contact_email = ? LIMIT 1', [req.office]);
        venue = (o && o.name) || '';
      } catch { /* the name is only for the email */ }
      const where = venue ? ` at ${venue}` : '';
      let emailed = false;
      try {
        emailed = Boolean(await send({
          to: email,
          subject: `${req.ai.clerk.name} invited you to Vesopa AI${where}`,
          text: [
            `${req.ai.clerk.name} has invited you to Vesopa AI${where}: ask questions about the business's sales, profit, stock and team in Vesopa Go.`,
            '',
            `Your code: ${code}`,
            '',
            'On a phone or iPad: open Vesopa Go, sign on with your own staff PIN, open Vesopa AI, choose "I have an invite code" and type the code above.',
            `On a PC or laptop: go to https://go.vesopa.com/ai/ and sign in with your Vesopa account for ${email}. No code is needed there.`,
            `The code works once and expires in ${INVITE_DAYS} days. If you were not expecting this, you can ignore it.`,
          ].join('\n'),
          html: `<p>${escapeHtml(req.ai.clerk.name)} has invited you to <b>Vesopa AI</b>${escapeHtml(where)}: ask questions about the business's sales, profit, stock and team in Vesopa Go.</p>`
            + `<p style="font-size:28px;font-weight:800;letter-spacing:4px;font-family:monospace">${code}</p>`
            + '<p><b>On a phone or iPad:</b> open Vesopa Go, sign on with your own staff PIN, open <b>Vesopa AI</b>, choose <b>I have an invite code</b> and type the code above.</p>'
            + `<p><b>On a PC or laptop:</b> go to <a href="https://go.vesopa.com/ai/">go.vesopa.com/ai</a> and sign in with your Vesopa account for ${escapeHtml(email)}. No code is needed there.</p>`
            + `<p style="color:#666">The code works once and expires in ${INVITE_DAYS} days. If you were not expecting this, you can ignore it.</p>`,
        }));
      } catch (e) {
        console.warn('[go_advisor] invite email failed:', e.message);
      }
      res.json({
        id: ins && ins.insertId,
        emailed,
        // Only when the email could not be sent, so the manager can pass the code on by hand.
        code: emailed ? undefined : code,
        message: emailed ? `Invite sent to ${email}.` : `The email could not be sent from this server, so give ${email} this code yourself: ${code}`,
      });
    } catch (e) { fail(res, e, next); }
  });

  router.delete('/api/go/ai/invites/:id', aiAuth, async (req, res, next) => {
    try {
      managerOnly(req);
      const [r] = await pool.query(
        'UPDATE go_ai_invites SET revoked_at = ? WHERE id = ? AND office = ? AND revoked_at IS NULL',
        [E.sqlTime(now()), Number(req.params.id) || 0, req.office]);
      if (!r || !r.affectedRows) throw new AdvisorError(404, 'No such invite.');
      res.json({ ok: true });
    } catch (e) { fail(res, e, next); }
  });

  return router;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

module.exports = { goAdvisorRoutes, AdvisorError, hashCode };
