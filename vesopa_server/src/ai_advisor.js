/**
 * Vesopa AI Business Advisor (owner, 2026-11-16): "Vesopa Go currently helps
 * business owners manage their business. Vesopa AI should help them
 * understand and improve their business."
 *
 * The same routes serve the back office (a session token) and Vesopa Go (a
 * short-lived `ai` token a manager's PIN buys from the phone's terminal token):
 *
 *   GET    /api/ai/me                   what this person may see
 *   GET    /api/ai/briefing?site=       the daily briefing and alerts
 *   POST   /api/ai/ask                  { question, conversation_id?, site? }
 *   GET    /api/ai/conversations        this person's conversations
 *   GET    /api/ai/conversations/:id    one, with every answer
 *   DELETE /api/ai/conversations/:id
 *   GET    /api/ai/records?kind=&from=&to=&site=   the rows behind an answer
 *   GET    /api/ai/invites              people invited (owner and managers)
 *   POST   /api/ai/invites              { email, name, sites:[], profit, staff }
 *   DELETE /api/ai/invites/:id          take access away
 *   GET    /api/ai/invite/:token        an invitation, for its accept page
 *   POST   /api/ai/invite/:token/accept { name, password }
 *   POST   /api/tap/ai/session          Go: { clerk_id, pin } -> ai token
 *
 * WHO (owner, 2026-11-16): "Owner and manager can only access, and if they
 * want they can invite people through mail."
 *
 *   back office   a login with no role (the owner, as every login was before
 *                 roles), a role named Owner or Manager, or a role holding
 *                 ai.advisor. Profit and staff figures likewise, or ai.profit
 *                 / ai.staff.
 *   invited       a login made from an invitation: Vesopa AI only, only the
 *                 sites the inviter ticked, profit and staff only if ticked.
 *   Vesopa Go     a member of staff who is a manager (the till's own
 *                 is_manager, checked here against their PIN, not on the
 *                 phone). An ai token lasts two hours and opens these routes
 *                 and nothing else: requireAuth refuses any scoped token.
 *
 * TENANCY: the office always comes from the token, never from the request.
 *
 * READ-ONLY: nothing here changes a sale, a product, a price or a stock count.
 * The only writes are Vesopa AI's own: conversations and invitations.
 */
'use strict';

const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const { requireTerminal } = require('./auth');
const M = require('./ai_metrics');
const A = require('./ai_answers');
const X = require('./ai_explain');

const AI_TOKEN_TTL = '2h';
const INVITE_DAYS = 14;
const MODEL_PER_HOUR = 120;
const missing = (e) => e && (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR');

class AiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const TABLES = [
  `CREATE TABLE IF NOT EXISTS ai_conversations (
     id          BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
     office      VARCHAR(255) NOT NULL,
     user_key    VARCHAR(120) NOT NULL,
     title       VARCHAR(200) NOT NULL,
     state       TEXT         NULL,
     created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
     updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
     KEY by_user (office(120), user_key, updated_at)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS ai_messages (
     id               BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
     conversation_id  BIGINT       NOT NULL,
     office           VARCHAR(255) NOT NULL,
     question         TEXT         NOT NULL,
     answer           MEDIUMTEXT   NOT NULL,
     created_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
     KEY by_conversation (conversation_id, id)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS ai_members (
     id           BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
     office       VARCHAR(255) NOT NULL,
     email        VARCHAR(190) NOT NULL,
     name         VARCHAR(120) NULL,
     user_id      INT          NULL,
     sites        VARCHAR(500) NULL,
     can_profit   TINYINT      NOT NULL DEFAULT 0,
     can_staff    TINYINT      NOT NULL DEFAULT 0,
     status       VARCHAR(12)  NOT NULL DEFAULT 'invited',
     token_hash   CHAR(64)     NULL,
     expires_at   DATETIME     NULL,
     invited_by   VARCHAR(190) NULL,
     invited_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
     accepted_at  DATETIME     NULL,
     KEY by_office (office(120)),
     KEY by_user (user_id),
     UNIQUE KEY by_token (token_hash)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
];

const hash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const OWNERLY = /^(owner|manager)$/i;

function parseSites(text) {
  try {
    const list = JSON.parse(text || '[]');
    return Array.isArray(list) ? list.map(Number).filter(Number.isInteger) : [];
  } catch { return []; }
}

function aiRoutes({ pool, secret, mailer, fetchImpl, publicUrl }) {
  const router = express.Router();
  const terminal = requireTerminal(secret);
  const json = express.json({ limit: '32kb' });
  const sendMail = mailer || ((...a) => require('./mailer').sendMail(...a));
  const base = publicUrl || process.env.BACKOFFICE_URL || 'https://backoffice.vesopaepos.com';
  const calls = new Map();

  let ready = null;
  function tables() {
    if (!ready) ready = (async () => { for (const sql of TABLES) await pool.query(sql); })().catch((e) => { ready = null; throw e; });
    return ready;
  }

  function send(res, e, next) {
    if (e instanceof AiError) return res.status(e.status).json({ error: e.message });
    next(e);
  }

  function modelAllowed(office) {
    const now = Date.now();
    const list = (calls.get(office) || []).filter((t) => now - t < 3600e3);
    if (list.length >= MODEL_PER_HOUR) return false;
    calls.set(office, [...list, now]);
    return true;
  }

  async function officeOf(user) {
    if (user.officeId) {
      const [[o]] = await pool.query('SELECT contact_email, name FROM offices WHERE id = ?', [user.officeId]);
      if (o) return { office: o.contact_email, venue: o.name || 'the venue' };
    }
    return { office: user.email, venue: 'the venue' };
  }

  /**
   * Who is asking and what they may see. Sets req.ai:
   *   { office, venue, userKey, name, allowed (null = every site), can: { profit, staff, invite }, via }
   */
  async function access(req, res, next) {
    try {
      const header = req.headers.authorization || '';
      const token = header.startsWith('Bearer ') ? header.slice(7) : null;
      if (!token) throw new AiError(401, 'Not signed in');
      let claims;
      try { claims = jwt.verify(token, secret); } catch { throw new AiError(401, 'Session expired'); }
      await tables();

      if (claims.scope === 'ai') {
        const [[o]] = await pool.query('SELECT name FROM offices WHERE contact_email = ? LIMIT 1', [claims.office]).catch(() => [[null]]);
        req.ai = {
          office: claims.office, venue: (o && o.name) || 'the venue', userKey: `go:${claims.clerk_id}`, name: claims.clerk,
          allowed: null, can: { profit: true, staff: true, invite: true }, via: 'go', role: 'Manager',
        };
        return next();
      }
      if (claims.scope) throw new AiError(401, 'Not signed in');

      const { office, venue } = await officeOf(claims);
      const base = { office, venue, userKey: `bo:${claims.sub}`, name: claims.name || claims.email, via: 'backoffice' };
      if (claims.role === 'admin') {
        req.ai = { ...base, allowed: null, can: { profit: true, staff: true, invite: true }, role: 'Admin' };
        return next();
      }
      const [[member]] = await pool.query(
        "SELECT * FROM ai_members WHERE user_id = ? AND office = ? AND status = 'active' LIMIT 1", [claims.sub, office]);
      if (member) {
        req.ai = { ...base, allowed: parseSites(member.sites), can: { profit: !!member.can_profit, staff: !!member.can_staff, invite: false }, role: 'Invited' };
        if (!req.ai.allowed.length) req.ai.allowed = null;
        return next();
      }
      let role = null;
      try {
        [[role]] = await pool.query(
          `SELECT r.display_name, r.permissions FROM backoffice_users u
             JOIN bo_user_roles r ON r.id = u.role_id WHERE u.id = ?`, [claims.sub]);
      } catch (e) { if (!missing(e)) throw e; }
      if (!role) {
        // No role: the owner (every login before roles existed).
        req.ai = { ...base, allowed: null, can: { profit: true, staff: true, invite: true }, role: 'Owner' };
        return next();
      }
      const { parsePermissions } = require('./permissions');
      const keys = new Set(parsePermissions(role.permissions));
      const boss = OWNERLY.test(String(role.display_name || '').trim());
      if (!boss && !keys.has('ai.advisor')) {
        throw new AiError(403, 'Vesopa AI is for the owner and managers. Ask the owner to invite you.');
      }
      req.ai = {
        ...base, allowed: null, role: role.display_name,
        can: { profit: boss || keys.has('ai.profit'), staff: boss || keys.has('ai.staff'), invite: boss || keys.has('ai.invite') },
      };
      next();
    } catch (e) { send(res, e, next); }
  }

  /** What every answer is computed with. */
  async function context(req) {
    const now = await M.databaseNow(pool);
    const map = await M.siteMap(pool, req.ai.office);
    const site = req.query.site || (req.body && req.body.site);
    return {
      pool, office: req.ai.office, now, map, allowed: req.ai.allowed, can: req.ai.can,
      site: site != null && site !== '' && /^\d+$/.test(String(site)) ? Number(site) : null,
    };
  }

  function sitesFor(req, map) {
    return map.sites.filter((s) => !req.ai.allowed || req.ai.allowed.includes(s.id));
  }

  // ---- reading --------------------------------------------------------------

  router.get('/api/ai/me', access, async (req, res, next) => {
    try {
      const map = await M.siteMap(pool, req.ai.office);
      res.json({
        name: req.ai.name, venue: req.ai.venue, role: req.ai.role, via: req.ai.via,
        can: req.ai.can, sites: sitesFor(req, map), all_sites: !req.ai.allowed,
        model: X.configured() ? `DeepSeek (${X.MODEL})` : null,
        read_only: true,
      });
    } catch (e) { send(res, e, next); }
  });

  router.get('/api/ai/briefing', access, async (req, res, next) => {
    try {
      const ctx = await context(req);
      const q = { intent: 'briefing', period: { kind: 'yesterday' } };
      const ans = await A.answer(q, ctx);
      const words = modelAllowed(ctx.office) && req.query.words !== '0'
        ? await X.explain('Give me my daily business briefing.', ans, { venue: req.ai.venue, fetchImpl })
        : { headline: ans.headline, why: ans.why, next: ans.next, source: 'rules' };
      res.json({ ...ans, ...words, generated_at: M.naive(ctx.now), sites: sitesFor(req, ctx.map) });
    } catch (e) { send(res, e, next); }
  });

  router.post('/api/ai/ask', access, json, async (req, res, next) => {
    try {
      const question = String((req.body && req.body.question) || '').trim().slice(0, 500);
      if (!question) throw new AiError(400, 'Ask a question.');
      const ctx = await context(req);

      // The conversation, so a follow-up keeps its subject.
      let convo = null;
      const id = Number(req.body.conversation_id) || 0;
      if (id) {
        [[convo]] = await pool.query('SELECT * FROM ai_conversations WHERE id = ? AND office = ? AND user_key = ?', [id, ctx.office, req.ai.userKey]);
        if (!convo) throw new AiError(404, 'That conversation is not here.');
      }
      let prev = null;
      try { prev = convo && convo.state ? JSON.parse(convo.state) : null; } catch { prev = null; }
      const history = [];
      if (convo) {
        const [rows] = await pool.query('SELECT question, answer FROM ai_messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 4', [convo.id]);
        for (const r of rows.reverse()) {
          try { const a = JSON.parse(r.answer); history.push({ q: r.question, a: [a.headline, ...(a.why || [])].join(' ') }); } catch { /* skip */ }
        }
      }

      const siteNames = sitesFor(req, ctx.map);
      let q = A.parseQuestion(question, { now: ctx.now, siteNames, prev });
      const useModel = modelAllowed(ctx.office);
      if (!q.understood && useModel && X.configured()) {
        const c = await X.classify(question, { intents: A.INTENTS, siteNames, today: M.naive(ctx.now).slice(0, 10), prev, fetchImpl });
        if (c) q = { ...q, ...c, period: c.period || q.period, understood: true };
      }
      const ans = await A.answer(q, ctx);
      const words = useModel ? await X.explain(question, ans, { history, venue: req.ai.venue, fetchImpl }) : { headline: ans.headline, why: ans.why, next: ans.next, source: 'rules' };
      const out = { ...ans, ...words, question, asked_at: M.naive(ctx.now), understood: q.understood };

      // The intelligence tabs (Sales, Stock, Profit, Team) ask set questions
      // and keep no conversation.
      if (req.body.save === false) return res.json(out);

      if (!convo) {
        const [made] = await pool.query('INSERT INTO ai_conversations (office, user_key, title, state) VALUES (?, ?, ?, ?)',
          [ctx.office, req.ai.userKey, question.slice(0, 200), null]);
        convo = { id: made.insertId };
      }
      await pool.query('UPDATE ai_conversations SET state = ?, updated_at = NOW() WHERE id = ?',
        [JSON.stringify({ intent: ans.intent === 'help' ? (prev && prev.intent) || null : ans.intent, period: q.period, site: q.site ?? null }), convo.id]);
      await pool.query('INSERT INTO ai_messages (conversation_id, office, question, answer) VALUES (?, ?, ?, ?)',
        [convo.id, ctx.office, question, JSON.stringify(out)]);
      res.json({ ...out, conversation_id: convo.id });
    } catch (e) { send(res, e, next); }
  });

  router.get('/api/ai/conversations', access, async (req, res, next) => {
    try {
      const [rows] = await pool.query(
        `SELECT c.id, c.title, c.updated_at, (SELECT COUNT(*) FROM ai_messages m WHERE m.conversation_id = c.id) AS messages
           FROM ai_conversations c WHERE c.office = ? AND c.user_key = ? ORDER BY c.updated_at DESC LIMIT 50`,
        [req.ai.office, req.ai.userKey]);
      res.json(rows.map((r) => ({ id: Number(r.id), title: r.title, updated_at: M.naive(M.wallMs(r.updated_at)), messages: Number(r.messages) })));
    } catch (e) { send(res, e, next); }
  });

  router.get('/api/ai/conversations/:id', access, async (req, res, next) => {
    try {
      const [[c]] = await pool.query('SELECT id, title FROM ai_conversations WHERE id = ? AND office = ? AND user_key = ?', [Number(req.params.id) || 0, req.ai.office, req.ai.userKey]);
      if (!c) throw new AiError(404, 'That conversation is not here.');
      const [rows] = await pool.query('SELECT question, answer FROM ai_messages WHERE conversation_id = ? ORDER BY id LIMIT 200', [c.id]);
      res.json({ id: Number(c.id), title: c.title, messages: rows.map((r) => { try { return JSON.parse(r.answer); } catch { return { question: r.question, headline: '' }; } }) });
    } catch (e) { send(res, e, next); }
  });

  router.delete('/api/ai/conversations/:id', access, async (req, res, next) => {
    try {
      const [[c]] = await pool.query('SELECT id FROM ai_conversations WHERE id = ? AND office = ? AND user_key = ?', [Number(req.params.id) || 0, req.ai.office, req.ai.userKey]);
      if (!c) throw new AiError(404, 'That conversation is not here.');
      await pool.query('DELETE FROM ai_messages WHERE conversation_id = ?', [c.id]);
      await pool.query('DELETE FROM ai_conversations WHERE id = ?', [c.id]);
      res.json({ ok: true });
    } catch (e) { send(res, e, next); }
  });

  /**
   * The rows behind an answer. Narrowed exactly as the answer was (office from
   * the token, the person's sites), so a link edited by hand can never show
   * more than the person could already ask about.
   */
  router.get('/api/ai/records', access, async (req, res, next) => {
    try {
      const ctx = await context(req);
      const kind = String(req.query.kind || '');
      const from = M.parseNaive(req.query.from);
      const to = M.parseNaive(req.query.to);
      const f = M.siteFilter(ctx.map, { allowed: ctx.allowed, site: ctx.site });
      const window = () => {
        if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > 400 * M.DAY) throw new AiError(400, 'Which dates?');
        return M.periodOf('records', '', from, to);
      };
      if (kind === 'bills') {
        const p = window();
        const [rows] = await pool.query(
          `SELECT o.id, o.closed_at, o.terminal, ${ctx.can.staff ? 'o.clerk_name,' : ''} o.table_number, o.covers,
                  o.total_minor, o.discount_minor, o.tax_minor
             FROM epos_orders o
            WHERE o.email = ? AND o.closed_at IS NOT NULL AND o.closed_at >= ? AND o.closed_at < ?${f.sql}
            ORDER BY o.closed_at DESC LIMIT 300`,
          [ctx.office, p.from, p.to, ...f.params]);
        return res.json({
          kind, site: f.label, columns: ['Closed', 'Till', ...(ctx.can.staff ? ['Staff'] : []), 'Table', 'Covers', 'Total', 'Discount'],
          rows: rows.map((r) => [M.naive(M.wallMs(r.closed_at)).slice(0, 16), r.terminal || '', ...(ctx.can.staff ? [r.clerk_name || ''] : []), r.table_number || '', Number(r.covers) || 0, M.money(r.total_minor), M.money(r.discount_minor)]),
          truncated: rows.length === 300,
        });
      }
      if (kind === 'lines') {
        const p = window();
        const list = (await M.byProduct(pool, ctx.office, f, p)).sort((a, b) => b.takings_minor - a.takings_minor);
        const cost = ctx.can.profit;
        return res.json({
          kind, site: f.label,
          columns: ['Product', 'Department', 'Qty', 'Takings', ...(cost ? ['Ex VAT', 'Cost', 'Gross profit', 'Margin'] : [])],
          rows: list.map((x) => [x.name, x.department, x.qty, M.money(x.takings_minor), ...(cost ? [M.money(x.net_minor), x.costed ? M.money(x.cost_minor) : 'no cost price', x.costed ? M.money(x.profit_minor) : '—', x.margin_pct == null ? '—' : `${x.margin_pct}%`] : [])]),
        });
      }
      if (kind === 'stock') {
        const list = (await M.stock(pool, ctx.office, f, ctx.now)).sort((a, b) => (a.days_cover ?? 1e9) - (b.days_cover ?? 1e9));
        return res.json({
          kind, site: f.label, columns: ['Product', 'In stock', `Sold (${M.VELOCITY_DAYS} days)`, 'Per day', 'Days left', 'Runs out', 'Suggested order'],
          rows: list.map((s) => [s.name, s.stock, s.sold_28d, s.per_day, s.days_cover ?? '—', s.stockout || '—', s.reorder_qty || '—']),
        });
      }
      if (kind === 'voids') {
        if (!ctx.can.staff) throw new AiError(403, 'Staff figures are not shared with you.');
        const p = window();
        const [rows] = await pool.query(
          `SELECT v.voided_at, COALESCE(c.clark_name, CONCAT('PIN ', v.clerk_pin)) AS clerk, v.reason, v.amount_minor
             FROM epos_void_log v LEFT JOIN bo_clarks c ON c.pin_code = v.clerk_pin AND c.email = v.email
            WHERE v.email = ? AND v.voided_at >= ? AND v.voided_at < ?${f.sql.replace(/o\.terminal/g, 'v.terminal')}
            ORDER BY v.voided_at DESC LIMIT 300`,
          [ctx.office, p.from, p.to, ...f.params]).catch((e) => { if (missing(e)) return [[]]; throw e; });
        return res.json({ kind, site: f.label, columns: ['When', 'Staff', 'Reason', 'Amount'], rows: rows.map((r) => [M.naive(M.wallMs(r.voided_at)).slice(0, 16), r.clerk || '', r.reason || '', M.money(r.amount_minor)]) });
      }
      throw new AiError(400, 'Which records?');
    } catch (e) { send(res, e, next); }
  });

  // ---- invitations -----------------------------------------------------------

  function canInvite(req, res, next) {
    if (!req.ai.can.invite) return res.status(403).json({ error: 'Only the owner and managers can invite people to Vesopa AI.' });
    next();
  }

  router.get('/api/ai/invites', access, canInvite, async (req, res, next) => {
    try {
      const [rows] = await pool.query(
        `SELECT id, email, name, sites, can_profit, can_staff, status, invited_by, invited_at, accepted_at, expires_at
           FROM ai_members WHERE office = ? AND status <> 'revoked' ORDER BY invited_at DESC`, [req.ai.office]);
      res.json(rows.map((r) => ({
        id: Number(r.id), email: r.email, name: r.name, sites: parseSites(r.sites), profit: !!r.can_profit, staff: !!r.can_staff,
        status: r.status === 'invited' && r.expires_at && M.wallMs(r.expires_at) < Date.now() ? 'expired' : r.status,
        invited_by: r.invited_by, invited_at: r.invited_at ? M.naive(M.wallMs(r.invited_at)).slice(0, 16) : null,
      })));
    } catch (e) { send(res, e, next); }
  });

  router.post('/api/ai/invites', access, canInvite, json, async (req, res, next) => {
    try {
      const b = req.body || {};
      const email = String(b.email || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 190) throw new AiError(400, 'That is not an email address.');
      const name = String(b.name || '').trim().slice(0, 120) || null;
      const map = await M.siteMap(pool, req.ai.office);
      const mine = sitesFor(req, map).map((s) => s.id);
      const sites = (Array.isArray(b.sites) ? b.sites : []).map(Number).filter((id) => mine.includes(id));
      const [[existing]] = await pool.query("SELECT id FROM ai_members WHERE office = ? AND email = ? AND status <> 'revoked'", [req.ai.office, email]);
      if (existing) throw new AiError(409, `${email} is already invited. Take the old invitation away first to send a new one.`);
      const token = crypto.randomBytes(24).toString('base64url');
      const expires = M.naive(Date.now() + INVITE_DAYS * M.DAY);
      await pool.query(
        `INSERT INTO ai_members (office, email, name, sites, can_profit, can_staff, status, token_hash, expires_at, invited_by)
         VALUES (?, ?, ?, ?, ?, ?, 'invited', ?, ?, ?)`,
        [req.ai.office, email, name, JSON.stringify(sites), b.profit ? 1 : 0, b.staff ? 1 : 0, hash(token), expires, req.ai.name || null]);
      const link = `${base.replace(/\/$/, '')}/vesopa-ai/invite?token=${encodeURIComponent(token)}`;
      const siteText = sites.length ? map.sites.filter((s) => sites.includes(s.id)).map((s) => s.name).join(', ') : 'every site';
      const sent = await sendMail({
        to: email,
        fromName: process.env.AI_INVITE_FROM_NAME || 'Vesopa AI',
        fromAddress: process.env.AI_INVITE_FROM || 'info@vesopasoftware.com',
        replyTo: process.env.AI_INVITE_REPLY_TO || 'info@vesopasoftware.com',
        subject: `${req.ai.name || 'The owner'} invited you to Vesopa AI for ${req.ai.venue}`,
        html: inviteHtml({ who: req.ai.name, venue: req.ai.venue, link, siteText, profit: !!b.profit, staff: !!b.staff, name }),
        text: `${req.ai.name || 'The owner'} invited you to Vesopa AI for ${req.ai.venue}: ask questions about sales, products and stock (${siteText}). Accept within ${INVITE_DAYS} days: ${link}`,
      }).catch((e) => { console.warn('[vesopa-ai] invite mail failed:', e.message); return false; });
      res.json({ ok: true, sent: sent !== false, link: sent === false ? link : undefined });
    } catch (e) { send(res, e, next); }
  });

  router.delete('/api/ai/invites/:id', access, canInvite, async (req, res, next) => {
    try {
      const [[m]] = await pool.query('SELECT id, user_id FROM ai_members WHERE id = ? AND office = ?', [Number(req.params.id) || 0, req.ai.office]);
      if (!m) throw new AiError(404, 'No such invitation.');
      await pool.query("UPDATE ai_members SET status = 'revoked', token_hash = NULL WHERE id = ?", [m.id]);
      // The login made from the invitation can open nothing else, so it goes too.
      if (m.user_id) await pool.query("UPDATE backoffice_users SET approved = 'N' WHERE id = ? AND office_id IS NOT NULL", [m.user_id]).catch(() => {});
      res.json({ ok: true });
    } catch (e) { send(res, e, next); }
  });

  router.get('/api/ai/invite/:token', async (req, res, next) => {
    try {
      await tables();
      const [[m]] = await pool.query(
        `SELECT m.email, m.name, m.status, m.expires_at, m.invited_by, o.name AS venue
           FROM ai_members m LEFT JOIN offices o ON o.contact_email = m.office
          WHERE m.token_hash = ?`, [hash(req.params.token)]);
      if (!m || m.status !== 'invited') throw new AiError(404, 'This invitation has been used or taken away.');
      if (m.expires_at && M.wallMs(m.expires_at) < Date.now()) throw new AiError(410, 'This invitation has expired. Ask for a new one.');
      res.json({ email: m.email, name: m.name, venue: m.venue || 'the venue', invited_by: m.invited_by });
    } catch (e) { send(res, e, next); }
  });

  /**
   * Accepting: a back-office login of its own, in the venue's office, with a
   * role that opens Vesopa AI and nothing else. The email address is the one
   * invited; the person chooses a password (or later signs in with Continue
   * with Vesopa on the same address).
   */
  router.post('/api/ai/invite/:token/accept', json, async (req, res, next) => {
    try {
      await tables();
      const [[m]] = await pool.query('SELECT * FROM ai_members WHERE token_hash = ?', [hash(req.params.token)]);
      if (!m || m.status !== 'invited') throw new AiError(404, 'This invitation has been used or taken away.');
      if (m.expires_at && M.wallMs(m.expires_at) < Date.now()) throw new AiError(410, 'This invitation has expired. Ask for a new one.');
      const password = String((req.body && req.body.password) || '');
      const name = String((req.body && req.body.name) || m.name || '').trim().slice(0, 120);
      if (password.length < 10) throw new AiError(400, 'Choose a password of 10 characters or more.');
      if (!name) throw new AiError(400, 'Your name, please.');
      const [[office]] = await pool.query('SELECT id FROM offices WHERE contact_email = ?', [m.office]);
      if (!office) throw new AiError(404, 'That venue is not here any more.');
      const [[user]] = await pool.query('SELECT id, office_id FROM backoffice_users WHERE email = ?', [m.email]);
      if (user && Number(user.office_id) !== Number(office.id)) {
        throw new AiError(409, 'This email address already signs in to another Vesopa back office. Ask the owner to invite a different address.');
      }
      const roleId = await guestRole(m.office);
      let userId;
      if (user) {
        userId = user.id;
      } else {
        const [made] = await pool.query(
          `INSERT INTO backoffice_users (email, password, name, approved, role, office_id, role_id)
           VALUES (?, ?, ?, 'Y', 'office', ?, ?)`,
          [m.email, await bcrypt.hash(password, 12), name, office.id, roleId]);
        userId = made.insertId;
      }
      await pool.query("UPDATE ai_members SET status = 'active', user_id = ?, name = ?, token_hash = NULL, accepted_at = NOW() WHERE id = ?", [userId, name, m.id]);
      res.json({ ok: true, email: m.email });
    } catch (e) { send(res, e, next); }
  });

  /** The office's "Vesopa AI guest" role: Vesopa AI and nothing else. */
  async function guestRole(office) {
    const NAME = 'Vesopa AI guest';
    const [[r]] = await pool.query('SELECT id FROM bo_user_roles WHERE email = ? AND display_name = ?', [office, NAME]);
    if (r) return r.id;
    const [made] = await pool.query(
      'INSERT INTO bo_user_roles (email, display_name, description, permissions) VALUES (?, ?, ?, ?)',
      [office, NAME, 'People invited to Vesopa AI. Read-only answers about the business; nothing else in the back office.', JSON.stringify(['ai.advisor'])]);
    return made.insertId;
  }

  // ---- Vesopa Go -------------------------------------------------------------

  /**
   * A manager on a Go phone: the clerk id and PIN must be a member of staff of
   * this venue who is a manager (or in no group, which is every key, as on the
   * till). Answers a two-hour token for the /api/ai routes.
   */
  router.post('/api/tap/ai/session', terminal, json, async (req, res, next) => {
    try {
      const b = req.body || {};
      const [[clerk]] = await pool.query(
        `SELECT c.id, c.clark_name AS name, c.pin_code AS pin, c.permission_group_id AS grp, g.is_manager
           FROM bo_clarks c
           LEFT JOIN epos_permission_groups g ON g.id = c.permission_group_id AND g.email = c.email
          WHERE c.id = ? AND c.email = ? AND COALESCE(c.active, 1) = 1`,
        [Number(b.clerk_id) || 0, req.office]);
      const pinOk = clerk && clerk.pin != null && String(b.pin || '').length > 0
        && crypto.timingSafeEqual(Buffer.from(hash(clerk.pin)), Buffer.from(hash(b.pin)));
      if (!pinOk || (clerk.grp != null && !Number(clerk.is_manager))) {
        return res.status(403).json({ error: 'Vesopa AI is for managers. Sign in with a manager\'s PIN.' });
      }
      const token = jwt.sign({ scope: 'ai', office: req.office, clerk_id: clerk.id, clerk: clerk.name }, secret, { expiresIn: AI_TOKEN_TTL });
      res.json({ token, name: clerk.name, expires_in: 7200 });
    } catch (e) { send(res, e, next); }
  });

  return router;
}

const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function inviteHtml({ who, venue, link, siteText, profit, staff, name }) {
  const can = ['sales and takings', 'best sellers', 'stock and reorders', ...(profit ? ['profit and margins'] : []), ...(staff ? ['staff performance'] : [])];
  return `<!doctype html><html><body style="margin:0;background:#F2EFE6;font-family:Archivo,Helvetica,Arial,sans-serif;color:#0B0E0A">
  <div style="max-width:520px;margin:0 auto;padding:32px 20px">
    <div style="background:#0B0E0A;border-radius:16px;padding:28px">
      <div style="color:#A5C715;font-weight:800;letter-spacing:.04em;font-size:13px">VESOPA AI</div>
      <h1 style="color:#F2EFE6;font-size:24px;line-height:1.25;margin:10px 0 0">${escHtml(who || 'The owner')} invited you to Vesopa AI for ${escHtml(venue)}</h1>
    </div>
    <div style="background:#fff;border-radius:16px;padding:24px;margin-top:12px;font-size:15px;line-height:1.55">
      <p style="margin:0 0 12px">${name ? `Hello ${escHtml(name)},` : 'Hello,'}</p>
      <p style="margin:0 0 12px">Vesopa AI answers questions about the business in plain English, from the venue's own figures: ${escHtml(can.join(', '))}. You will see ${escHtml(siteText)}. It is read-only: nothing you ask can change a sale, a price or a stock count.</p>
      <p style="margin:20px 0"><a href="${escHtml(link)}" style="background:#A5C715;color:#0B0E0A;text-decoration:none;font-weight:800;padding:14px 22px;border-radius:12px;display:inline-block">Accept the invitation</a></p>
      <p style="margin:0;color:#5E7A0E;font-size:13px">The link works once and expires in ${INVITE_DAYS} days. If you were not expecting this, ignore it.</p>
    </div>
  </div></body></html>`;
}

module.exports = { aiRoutes, AI_TOKEN_TTL };
