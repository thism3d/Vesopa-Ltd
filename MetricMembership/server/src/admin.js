/**
 * The staff console: /admin (the page) and /api/admin/... (what it calls).
 *
 * Metric's staff sign in with Continue with Vesopa, like everybody else; only
 * addresses in METRIC_ADMIN_EMAILS get in. The session is an httpOnly cookie,
 * and every change is written to the activity log with who made it.
 */

const crypto = require('crypto');
const path = require('path');
const express = require('express');
const db = require('./db');
const config = require('./config');
const session = require('./session');
const vesopa = require('./vesopa');
const members = require('./members');
const activity = require('./activity');
const sync = require('./sync');
const settings = require('./settings');
const adapters = require('./adapters');
const { hashKey } = require('./anpr');
const { memberJson, vehicleJson } = require('./api');

const COOKIE = 'mg_admin';
const STATE_COOKIE = 'mg_admin_state';
const cookieOpts = () => ({ httpOnly: true, sameSite: 'lax', secure: config.isProd, path: '/' });

const iso = (d) => (d instanceof Date ? d.toISOString() : d);

function isAdminEmail(email) {
  return Boolean(email) && config.ADMIN_EMAILS.includes(String(email).toLowerCase());
}

function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch((e) => {
    if (e instanceof members.Refusal) return res.status(e.status).json({ error: e.message, code: e.code });
    if (e && e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'That already exists.', code: 'duplicate' });
    next(e);
  });
}

function actor(req) {
  return { type: 'admin', id: req.admin.sub, label: req.admin.email };
}

/** Begin a console sign-in. Called from the /auth/callback owner in server.js too. */
function adminPages() {
  const r = express.Router();

  r.get('/admin/signin', (req, res) => {
    const redirectUri = `${config.BASE_URL}/auth/callback`;
    const start = vesopa.begin(redirectUri);
    res.cookie(STATE_COOKIE, session.packState({ s: start.state, n: start.nonce, v: start.verifier }), { ...cookieOpts(), maxAge: 10 * 60 * 1000 });
    res.redirect(start.url);
  });

  r.post('/admin/signout', (req, res) => {
    res.clearCookie(COOKIE, cookieOpts());
    res.json({ ok: true });
  });

  r.get(['/admin', '/admin/'], (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.join(__dirname, '..', 'public', 'admin', 'index.html'));
  });

  return r;
}

/**
 * The shared callback, /auth/callback. A console sign-in is recognised by its
 * state cookie; anything else is the member web app's, sent back to the app
 * with the code in its address the way the loyalty app's callback does.
 */
async function callback(req, res) {
  const { code, state, error } = req.query;
  const packed = session.read(req.cookies && req.cookies[STATE_COOKIE], 'state');
  if (packed && state && packed.s === state) {
    res.clearCookie(STATE_COOKIE, cookieOpts());
    if (error || !code) return res.redirect('/admin/?signin=cancelled');
    const idToken = await vesopa.exchangeCode({ code: String(code), verifier: packed.v, redirectUri: `${config.BASE_URL}/auth/callback` });
    const claims = idToken ? await vesopa.verify(idToken, { nonce: packed.n }) : null;
    if (!claims) {
      activity.record({ action: 'admin.signin_refused', req, detail: { reason: 'token' } });
      return res.redirect('/admin/?signin=failed');
    }
    if (!isAdminEmail(claims.email)) {
      activity.record({ action: 'admin.signin_refused', req, detail: { reason: 'not_staff', email: claims.email } });
      return res.redirect('/admin/?signin=notstaff');
    }
    res.cookie(COOKIE, session.issueAdmin({ sub: claims.sub, email: claims.email, name: claims.name || '' }), { ...cookieOpts(), maxAge: 12 * 3600 * 1000 });
    activity.record({ actor: { type: 'admin', id: claims.sub, label: claims.email }, action: 'admin.signed_in', req });
    return res.redirect('/admin/');
  }
  // The member web app. Its own state and verifier are in its tab; it checks
  // them when it picks these up (lib/platform/vesopa_sso_web.dart).
  const q = new URLSearchParams();
  if (code) q.set('vesopa_code', String(code));
  if (error) q.set('vesopa_error', String(error));
  if (state) q.set('vesopa_state', String(state));
  return res.redirect(`/?${q}`);
}

function requireAdmin(req, res, next) {
  const claims = session.read(req.cookies && req.cookies[COOKIE], 'admin');
  if (!claims || !isAdminEmail(claims.email)) return res.status(401).json({ error: 'Please sign in.', code: 'signed_out' });
  req.admin = claims;
  next();
}

function gateJson(g) {
  return {
    id: g.id, siteId: g.site_id, name: g.name, direction: g.direction, adapter: g.adapter, mode: g.mode,
    deviceUrl: g.device_url, deviceUser: g.device_user, hasPassword: Boolean(g.device_pass), deviceChannel: g.device_channel,
    fuzzyMatch: Boolean(g.fuzzy_match), keyHint: g.key_hint, active: Boolean(g.active),
    lastSeenAt: iso(g.last_seen_at), lastSyncAt: iso(g.last_sync_at), lastSyncError: g.last_sync_error,
  };
}

function newKey() {
  const key = `mg_${crypto.randomBytes(24).toString('base64url')}`;
  return { key, hash: hashKey(key), hint: key.slice(-6) };
}

function lanes(key) {
  const base = `${config.BASE_URL}/anpr/v1/gates/${key}`;
  return { event: `${base}/event`, allowlist: `${base}/allowlist`, ping: `${base}/ping` };
}

function adminApi() {
  const r = express.Router();
  r.use(requireAdmin);

  r.get('/me', (req, res) => res.json({ email: req.admin.email, name: req.admin.name }));

  r.get('/overview', wrap(async (req, res) => {
    const counts = await db.all('SELECT status, COUNT(*) AS n FROM members GROUP BY status');
    const cars = await db.one('SELECT COUNT(*) AS n FROM vehicles WHERE removed_at IS NULL');
    const today = await db.one("SELECT SUM(decision='open') AS opened, SUM(decision='deny') AS denied FROM access_events WHERE at >= CURDATE()");
    const gates = await db.all('SELECT g.*, s.name AS site FROM gates g JOIN sites s ON s.id = g.site_id WHERE g.active = 1 ORDER BY s.name, g.name');
    res.json({
      members: Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])),
      vehicles: Number(cars.n),
      today: { opened: Number(today.opened || 0), denied: Number(today.denied || 0) },
      gates: gates.map((g) => ({ ...gateJson(g), site: g.site })),
      adapters: adapters.list(),
    });
  }));

  // ---- members ----------------------------------------------------------
  r.get('/members', wrap(async (req, res) => {
    const q = String(req.query.q || '').trim();
    const status = String(req.query.status || '');
    const where = [];
    const params = [];
    if (status) { where.push('m.status = ?'); params.push(status); }
    if (q) {
      where.push(`(m.name LIKE ? OR m.email LIKE ? OR m.member_no LIKE ? OR m.company LIKE ?
                  OR EXISTS (SELECT 1 FROM vehicles v WHERE v.member_id = m.id AND v.plate LIKE ?))`);
      const like = `%${q}%`;
      params.push(like, like, like, like, `%${q.toUpperCase().replace(/[^A-Z0-9]/g, '')}%`);
    }
    const rows = await db.all(
      `SELECT m.*, (SELECT GROUP_CONCAT(v.plate_display ORDER BY v.id SEPARATOR ', ') FROM vehicles v
                     WHERE v.member_id = m.id AND v.removed_at IS NULL) AS plates
         FROM members m ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY FIELD(m.status, 'pending', 'active', 'suspended', 'closed'), m.id DESC LIMIT 300`,
      params,
    );
    res.json({ members: rows.map((m) => ({ ...memberJson(m, null), plates: m.plates || '', notes: m.notes, planId: m.plan_id })) });
  }));

  r.get('/members/:id', wrap(async (req, res) => {
    const m = await db.one('SELECT * FROM members WHERE id = ?', [req.params.id]);
    if (!m) return res.status(404).json({ error: 'No such member.' });
    const plan = await members.planFor(m);
    const vehicles = await db.all('SELECT * FROM vehicles WHERE member_id = ? ORDER BY removed_at IS NOT NULL, id', [m.id]);
    const events = await db.all(
      `SELECT e.*, s.name AS site, g.name AS gate FROM access_events e JOIN sites s ON s.id = e.site_id JOIN gates g ON g.id = e.gate_id
        WHERE e.member_id = ? ORDER BY e.id DESC LIMIT 100`, [m.id]);
    const log = await db.all("SELECT * FROM activity_log WHERE actor_type = 'member' AND actor_id = ? ORDER BY id DESC LIMIT 200", [String(m.id)]);
    res.json({
      member: { ...memberJson(m, plan), notes: m.notes, planId: m.plan_id },
      vehicles: vehicles.map((v) => ({ ...vehicleJson(v), removed: iso(v.removed_at) })),
      events: events.map((e) => ({ ...e, at: iso(e.at) })),
      activity: log.map((l) => ({ ...l, at: iso(l.at), detail: safeJson(l.detail) })),
    });
  }));

  r.patch('/members/:id', wrap(async (req, res) => {
    const m = await db.one('SELECT * FROM members WHERE id = ?', [req.params.id]);
    if (!m) return res.status(404).json({ error: 'No such member.' });
    const b = req.body || {};
    const next = {
      status: ['pending', 'active', 'suspended'].includes(b.status) ? b.status : m.status,
      plan_id: b.planId !== undefined ? (b.planId ? Number(b.planId) : null) : m.plan_id,
      valid_from: b.validFrom !== undefined ? (b.validFrom || null) : m.valid_from,
      valid_to: b.validTo !== undefined ? (b.validTo || null) : m.valid_to,
      notes: b.notes !== undefined ? String(b.notes).slice(0, 500) : m.notes,
      name: b.name !== undefined ? String(b.name).slice(0, 120) : m.name,
      company: b.company !== undefined ? String(b.company).slice(0, 120) : m.company,
      phone: b.phone !== undefined ? String(b.phone).slice(0, 40) : m.phone,
    };
    await db.run(
      'UPDATE members SET status = ?, plan_id = ?, valid_from = ?, valid_to = ?, notes = ?, name = ?, company = ?, phone = ? WHERE id = ?',
      [next.status, next.plan_id, next.valid_from, next.valid_to, next.notes, next.name, next.company, next.phone, m.id],
    );
    activity.record({ actor: actor(req), action: 'admin.member_update', req, detail: { memberId: m.id, memberNo: m.member_no, changes: b } });
    sync.soon();
    res.json({ ok: true });
  }));

  r.post('/members/:id/vehicles', wrap(async (req, res) => {
    const m = await db.one('SELECT * FROM members WHERE id = ?', [req.params.id]);
    if (!m) return res.status(404).json({ error: 'No such member.' });
    const v = await members.addVehicle(m, req.body || {});
    activity.record({ actor: actor(req), action: 'admin.vehicle_add', req, detail: { memberId: m.id, plate: v.plate } });
    res.status(201).json({ vehicle: vehicleJson(v) });
  }));

  r.delete('/members/:id/vehicles/:vid', wrap(async (req, res) => {
    const v = await members.removeVehicle(Number(req.params.id), Number(req.params.vid));
    activity.record({ actor: actor(req), action: 'admin.vehicle_remove', req, detail: { memberId: Number(req.params.id), plate: v.plate } });
    res.json({ ok: true });
  }));

  // ---- appearance ---------------------------------------------------------
  r.get('/settings', wrap(async (req, res) => res.json({ settings: await settings.all(), choices: settings.CHOICES })));

  r.patch('/settings', wrap(async (req, res) => {
    const b = req.body || {};
    for (const [name, value] of Object.entries(b)) {
      if ((await settings.set(name, String(value), req.admin && req.admin.email)) == null) {
        return res.status(400).json({ error: `${name} cannot be ${value}.` });
      }
    }
    activity.record({ actor: actor(req), action: 'admin.settings', req, detail: b });
    res.json({ settings: await settings.all() });
  }));

  // ---- plans ------------------------------------------------------------
  r.get('/plans', wrap(async (req, res) => res.json({ plans: await db.all('SELECT * FROM plans ORDER BY id') })));

  r.post('/plans', wrap(async (req, res) => {
    const b = req.body || {};
    if (!String(b.name || '').trim()) return res.status(400).json({ error: 'A plan needs a name.' });
    const out = await db.run('INSERT INTO plans (name, description, max_vehicles, site_ids) VALUES (?, ?, ?, ?)',
      [String(b.name).slice(0, 80), String(b.description || '').slice(0, 255), Math.max(1, Math.min(20, Number(b.maxVehicles) || 3)), siteList(b.siteIds)]);
    activity.record({ actor: actor(req), action: 'admin.plan_add', req, detail: b });
    res.status(201).json({ id: out.insertId });
  }));

  r.patch('/plans/:id', wrap(async (req, res) => {
    const p = await db.one('SELECT * FROM plans WHERE id = ?', [req.params.id]);
    if (!p) return res.status(404).json({ error: 'No such plan.' });
    const b = req.body || {};
    await db.run('UPDATE plans SET name = ?, description = ?, max_vehicles = ?, site_ids = ?, active = ? WHERE id = ?', [
      b.name != null ? String(b.name).slice(0, 80) : p.name,
      b.description != null ? String(b.description).slice(0, 255) : p.description,
      b.maxVehicles != null ? Math.max(1, Math.min(20, Number(b.maxVehicles) || 3)) : p.max_vehicles,
      b.siteIds !== undefined ? siteList(b.siteIds) : p.site_ids,
      b.active != null ? (b.active ? 1 : 0) : p.active,
      p.id,
    ]);
    if (b.isDefault) {
      await db.run('UPDATE plans SET is_default = (id = ?)', [p.id]);
    }
    activity.record({ actor: actor(req), action: 'admin.plan_update', req, detail: { planId: p.id, ...b } });
    sync.soon();
    res.json({ ok: true });
  }));

  // ---- sites and gates --------------------------------------------------
  r.get('/sites', wrap(async (req, res) => {
    const sites = await db.all('SELECT * FROM sites ORDER BY name');
    const gates = await db.all('SELECT * FROM gates ORDER BY name');
    res.json({
      sites: sites.map((s) => ({ ...s, gates: gates.filter((g) => g.site_id === s.id).map(gateJson) })),
      adapters: adapters.list(),
    });
  }));

  r.post('/sites', wrap(async (req, res) => {
    const b = req.body || {};
    if (!String(b.name || '').trim()) return res.status(400).json({ error: 'A site needs a name.' });
    const out = await db.run('INSERT INTO sites (name, address, public) VALUES (?, ?, ?)', [String(b.name).slice(0, 120), String(b.address || '').slice(0, 255), b.public === false ? 0 : 1]);
    activity.record({ actor: actor(req), action: 'admin.site_add', req, detail: b });
    res.status(201).json({ id: out.insertId });
  }));

  r.patch('/sites/:id', wrap(async (req, res) => {
    const s = await db.one('SELECT * FROM sites WHERE id = ?', [req.params.id]);
    if (!s) return res.status(404).json({ error: 'No such site.' });
    const b = req.body || {};
    await db.run('UPDATE sites SET name = ?, address = ?, public = ?, active = ? WHERE id = ?', [
      b.name != null ? String(b.name).slice(0, 120) : s.name,
      b.address != null ? String(b.address).slice(0, 255) : s.address,
      b.public != null ? (b.public ? 1 : 0) : s.public,
      b.active != null ? (b.active ? 1 : 0) : s.active,
      s.id,
    ]);
    activity.record({ actor: actor(req), action: 'admin.site_update', req, detail: { siteId: s.id, ...b } });
    res.json({ ok: true });
  }));

  r.post('/sites/:id/gates', wrap(async (req, res) => {
    const s = await db.one('SELECT * FROM sites WHERE id = ?', [req.params.id]);
    if (!s) return res.status(404).json({ error: 'No such site.' });
    const b = req.body || {};
    if (!String(b.name || '').trim()) return res.status(400).json({ error: 'A gate needs a name.' });
    const k = newKey();
    const out = await db.run(
      `INSERT INTO gates (site_id, name, direction, adapter, mode, device_url, device_user, device_pass, device_channel, fuzzy_match, key_hash, key_hint)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [s.id, String(b.name).slice(0, 120), enumOr(b.direction, ['entry', 'exit', 'both'], 'both'),
        enumOr(b.adapter, Object.keys(adapters.ADAPTERS), 'generic'), enumOr(b.mode, ['decision', 'allowlist', 'both'], 'decision'),
        String(b.deviceUrl || '').slice(0, 255), String(b.deviceUser || '').slice(0, 80), String(b.devicePass || '').slice(0, 255),
        Math.max(1, Number(b.deviceChannel) || 1), b.fuzzyMatch === false ? 0 : 1, k.hash, k.hint],
    );
    activity.record({ actor: actor(req), action: 'admin.gate_add', req, detail: { siteId: s.id, gateId: out.insertId, name: b.name, adapter: b.adapter, mode: b.mode } });
    sync.soon();
    // The key is shown this once. Afterwards only its last characters are.
    res.status(201).json({ id: out.insertId, key: k.key, urls: lanes(k.key) });
  }));

  r.patch('/gates/:id', wrap(async (req, res) => {
    const g = await db.one('SELECT * FROM gates WHERE id = ?', [req.params.id]);
    if (!g) return res.status(404).json({ error: 'No such gate.' });
    const b = req.body || {};
    await db.run(
      `UPDATE gates SET name = ?, direction = ?, adapter = ?, mode = ?, device_url = ?, device_user = ?, device_pass = ?,
              device_channel = ?, fuzzy_match = ?, active = ? WHERE id = ?`,
      [b.name != null ? String(b.name).slice(0, 120) : g.name,
        b.direction ? enumOr(b.direction, ['entry', 'exit', 'both'], g.direction) : g.direction,
        b.adapter ? enumOr(b.adapter, Object.keys(adapters.ADAPTERS), g.adapter) : g.adapter,
        b.mode ? enumOr(b.mode, ['decision', 'allowlist', 'both'], g.mode) : g.mode,
        b.deviceUrl != null ? String(b.deviceUrl).slice(0, 255) : g.device_url,
        b.deviceUser != null ? String(b.deviceUser).slice(0, 80) : g.device_user,
        // Blank means "leave it": the console never has the old one to send back.
        b.devicePass ? String(b.devicePass).slice(0, 255) : g.device_pass,
        b.deviceChannel != null ? Math.max(1, Number(b.deviceChannel) || 1) : g.device_channel,
        b.fuzzyMatch != null ? (b.fuzzyMatch ? 1 : 0) : g.fuzzy_match,
        b.active != null ? (b.active ? 1 : 0) : g.active,
        g.id],
    );
    const { devicePass, ...shown } = b;
    activity.record({ actor: actor(req), action: 'admin.gate_update', req, detail: { gateId: g.id, ...shown, passwordChanged: Boolean(devicePass) } });
    sync.soon();
    res.json({ ok: true });
  }));

  r.post('/gates/:id/key', wrap(async (req, res) => {
    const g = await db.one('SELECT * FROM gates WHERE id = ?', [req.params.id]);
    if (!g) return res.status(404).json({ error: 'No such gate.' });
    const k = newKey();
    await db.run('UPDATE gates SET key_hash = ?, key_hint = ? WHERE id = ?', [k.hash, k.hint, g.id]);
    activity.record({ actor: actor(req), action: 'admin.gate_new_key', req, detail: { gateId: g.id, name: g.name } });
    res.json({ key: k.key, urls: lanes(k.key) });
  }));

  r.post('/gates/:id/sync', wrap(async (req, res) => {
    const g = await db.one('SELECT * FROM gates WHERE id = ?', [req.params.id]);
    if (!g) return res.status(404).json({ error: 'No such gate.' });
    const out = await sync.syncGate(g);
    activity.record({ actor: actor(req), action: 'admin.gate_sync', req, detail: { gateId: g.id, result: out } });
    res.json(out);
  }));

  r.post('/gates/:id/open', wrap(async (req, res) => {
    const g = await db.one('SELECT * FROM gates WHERE id = ?', [req.params.id]);
    if (!g) return res.status(404).json({ error: 'No such gate.' });
    const adapter = adapters.adapterFor(g);
    if (typeof adapter.open !== 'function' || !g.device_url) return res.status(400).json({ error: 'This gate cannot be opened from here: it has no device address, or its make has no open command.' });
    let out;
    try { out = await adapter.open(g, { plate: '' }); } catch (e) { out = { ok: false, error: e.message }; }
    activity.record({ actor: actor(req), action: 'admin.gate_open', req, detail: { gateId: g.id, name: g.name, result: out } });
    res.status(out.ok ? 200 : 502).json(out);
  }));

  // ---- logs -------------------------------------------------------------
  r.get('/events', wrap(async (req, res) => {
    const where = [];
    const params = [];
    if (req.query.plate) { where.push('e.plate LIKE ?'); params.push(`%${String(req.query.plate).toUpperCase().replace(/[^A-Z0-9]/g, '')}%`); }
    if (req.query.gate) { where.push('e.gate_id = ?'); params.push(Number(req.query.gate)); }
    if (req.query.decision) { where.push('e.decision = ?'); params.push(String(req.query.decision)); }
    const rows = await db.all(
      `SELECT e.*, s.name AS site, g.name AS gate, m.member_no, m.name AS member
         FROM access_events e JOIN sites s ON s.id = e.site_id JOIN gates g ON g.id = e.gate_id
         LEFT JOIN members m ON m.id = e.member_id
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY e.id DESC LIMIT 300`,
      params,
    );
    res.json({ events: rows.map((e) => ({ ...e, at: iso(e.at) })) });
  }));

  r.get('/activity', wrap(async (req, res) => {
    const where = [];
    const params = [];
    if (req.query.actor) { where.push('actor_type = ?'); params.push(String(req.query.actor)); }
    if (req.query.who) { where.push('(actor_label LIKE ? OR actor_id = ?)'); params.push(`%${req.query.who}%`, String(req.query.who)); }
    if (req.query.action) { where.push('action LIKE ?'); params.push(`${String(req.query.action)}%`); }
    if (req.query.from) { where.push('at >= ?'); params.push(String(req.query.from)); }
    const rows = await db.all(`SELECT * FROM activity_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT 500`, params);
    res.json({ activity: rows.map((l) => ({ ...l, at: iso(l.at), detail: safeJson(l.detail) })) });
  }));

  return r;
}

function siteList(v) {
  if (v == null || v === '' || (Array.isArray(v) && !v.length)) return null;
  const ids = (Array.isArray(v) ? v : String(v).split(',')).map((x) => Number(x)).filter((x) => Number.isInteger(x) && x > 0);
  return ids.length ? ids.join(',') : null;
}

function enumOr(v, allowed, fallback) {
  return allowed.includes(v) ? v : fallback;
}

function safeJson(s) {
  try { return s ? JSON.parse(s) : null; } catch { return s; }
}

module.exports = { adminPages, adminApi, callback, isAdminEmail };
