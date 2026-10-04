/**
 * The member app's API: /api/v1/...
 *
 * Every call but /brand and the sign-in carries the member's session as a
 * Bearer token. Every change a member makes -- and every press the app
 * reports through /log -- goes into the activity log with who made it.
 */

const express = require('express');
const db = require('./db');
const config = require('./config');
const session = require('./session');
const vesopa = require('./vesopa');
const members = require('./members');
const activity = require('./activity');
const brand = require('./brand');
const access = require('./access');
const sync = require('./sync');
const eposSync = require('./epos_sync');
const settings = require('./settings');
const themes = require('./themes');
const { webBuild } = require('./web');
const { limiter } = require('./security');

const iso = (d) => (d instanceof Date ? d.toISOString() : d);
const day = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d ? String(d).slice(0, 10) : null);

function memberJson(m, plan) {
  return {
    id: m.id,
    memberNo: m.member_no,
    name: m.name,
    email: m.email,
    phone: m.phone,
    company: m.company,
    status: m.status,
    standing: access.standing(m, plan, null),
    validFrom: day(m.valid_from),
    validTo: day(m.valid_to),
    plan: plan ? { name: plan.name, description: plan.description, maxVehicles: plan.max_vehicles } : null,
    since: iso(m.created_at),
    // Where the membership is held, once Vesopa EPOS is configured.
    epos: m.epos_member_id
      ? { id: m.epos_member_id, state: m.epos_state, plan: m.epos_plan_name || null, memberNo: m.epos_member_no || null, syncedAt: iso(m.epos_synced_at) }
      : null,
  };
}

function vehicleJson(v) {
  return { id: v.id, plate: v.plate, display: v.plate_display, make: v.make, colour: v.colour, nickname: v.nickname, added: iso(v.created_at) };
}

function actor(m) {
  return { type: 'member', id: m.id, label: m.email || m.member_no };
}

/** The member behind this request, or a 401. */
function requireMember() {
  return async (req, res, next) => {
    const h = String(req.get('authorization') || '');
    const claims = session.read(h.startsWith('Bearer ') ? h.slice(7) : '', 'member');
    if (!claims) return res.status(401).json({ error: 'Please sign in again.', code: 'signed_out' });
    const m = await db.one('SELECT * FROM members WHERE id = ?', [claims.mid]);
    if (!m || m.status === 'closed') return res.status(401).json({ error: 'Please sign in again.', code: 'signed_out' });
    req.member = m;
    next();
  };
}

function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch((e) => {
    if (e instanceof members.Refusal) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  });
}

function apiRouter() {
  const r = express.Router();

  r.get('/brand', wrap(async (req, res) => {
    res.set('Cache-Control', 'no-cache');
    const chosen = await settings.all();
    res.json({ ...brand, baseUrl: config.BASE_URL, authClientId: config.AUTH_CLIENT_ID, ...chosen, theme: themes.resolve(chosen) });
  }));

  // What public/theme.js asks every minute and whenever the app comes back to
  // the front: the bar colours staff chose, and which web build is live, so a
  // deploy reaches an open app without anybody refreshing.
  r.get('/theme', wrap(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ theme: themes.resolve(await settings.all()), build: webBuild() });
  }));

  /*
   * CONTINUE WITH VESOPA.
   *
   *   web     { code, verifier, redirectUri }  -- exchanged here
   *   native  { idToken }                      -- checked here
   */
  r.post('/auth/vesopa', limiter({ perMinute: 20 }), wrap(async (req, res) => {
    const { code, verifier, redirectUri, idToken } = req.body || {};
    let token = idToken ? String(idToken) : null;
    if (!token && code) {
      // Only our own callback address may be named: anything else would let a
      // code minted for another app be spent here.
      if (redirectUri !== `${config.BASE_URL}/auth/callback`) {
        return res.status(400).json({ error: 'That sign-in came back to the wrong address.', code: 'bad_redirect' });
      }
      token = await vesopa.exchangeCode({ code: String(code), verifier: String(verifier || ''), redirectUri });
    }
    const claims = token ? await vesopa.verify(token) : null;
    if (!claims) {
      activity.record({ action: 'auth.vesopa_refused', req, detail: { how: idToken ? 'native' : 'web' } });
      return res.status(401).json({ error: 'Vesopa could not sign you in. Please try again.', code: 'refused' });
    }
    const m = await members.fromVesopa(claims);
    activity.record({ actor: actor(m), action: m.isNew ? 'member.joined' : 'member.signed_in', req, detail: { how: idToken ? 'native' : 'web' } });
    const plan = await members.planFor(m);
    res.json({ token: session.issueMember(m), member: memberJson(m, plan) });
  }));

  r.get('/sites', wrap(async (req, res) => {
    const rows = await db.all('SELECT id, name, address FROM sites WHERE active = 1 AND public = 1 ORDER BY name');
    res.json({ sites: rows });
  }));

  r.use(requireMember());

  r.get('/me', wrap(async (req, res) => {
    const plan = await members.planFor(req.member);
    const vehicles = await members.vehiclesOf(req.member.id);
    const where = await members.presence(req.member.id);
    const at = new Map(where.map((w) => [w.vehicle_id, w]));
    res.json({
      member: memberJson(req.member, plan),
      vehicles: vehicles.map((v) => {
        const p = at.get(v.id);
        return { ...vehicleJson(v), lastSeen: p ? { direction: p.direction, at: iso(p.at), site: p.site } : null };
      }),
    });
  }));

  r.patch('/me', wrap(async (req, res) => {
    const b = req.body || {};
    const next = {
      name: b.name != null ? String(b.name).trim().slice(0, 120) : req.member.name,
      phone: b.phone != null ? String(b.phone).trim().slice(0, 40) : req.member.phone,
      company: b.company != null ? String(b.company).trim().slice(0, 120) : req.member.company,
    };
    await db.run('UPDATE members SET name = ?, phone = ?, company = ? WHERE id = ?', [next.name, next.phone, next.company, req.member.id]);
    const changed = Object.keys(next).filter((k) => next[k] !== req.member[k]);
    activity.record({ actor: actor(req.member), action: 'member.update', req, detail: { changed, ...Object.fromEntries(changed.map((k) => [k, next[k]])) } });
    let m = await db.one('SELECT * FROM members WHERE id = ?', [req.member.id]);
    // EPOS holds the member's details too: pass a new name or phone on (best effort).
    if (config.EPOS_ON && (changed.includes('name') || changed.includes('phone'))) m = await eposSync.tryLink(m, { by: 'Metric app' });
    res.json({ member: memberJson(m, await members.planFor(m)) });
  }));

  /*
   * Deleting the account: the membership closes, every car comes off every
   * barrier at once, and personal details are cleared. The visit log keeps
   * the plate reads (a car park's own record of who came and went) but no
   * longer links them to a name.
   */
  r.delete('/me', wrap(async (req, res) => {
    const m = req.member;
    await db.run('UPDATE vehicles SET removed_at = NOW() WHERE member_id = ? AND removed_at IS NULL', [m.id]);
    await db.run("UPDATE members SET status = 'closed', name = '', phone = '', company = '', notes = '' WHERE id = ?", [m.id]);
    sync.soon(100);
    activity.record({ actor: actor(m), action: 'member.deleted_account', req });
    res.json({ ok: true });
  }));

  r.get('/vehicles', wrap(async (req, res) => {
    res.json({ vehicles: (await members.vehiclesOf(req.member.id)).map(vehicleJson) });
  }));

  r.post('/vehicles', limiter({ perMinute: 30, key: (req) => `v${req.member.id}` }), wrap(async (req, res) => {
    const v = await members.addVehicle(req.member, req.body || {});
    activity.record({ actor: actor(req.member), action: 'vehicle.add', req, detail: { plate: v.plate, make: v.make, colour: v.colour } });
    res.status(201).json({ vehicle: vehicleJson(v) });
  }));

  r.patch('/vehicles/:id', wrap(async (req, res) => {
    const v = await members.updateVehicle(req.member.id, Number(req.params.id), req.body || {});
    activity.record({ actor: actor(req.member), action: 'vehicle.update', req, detail: { plate: v.plate, ...req.body } });
    res.json({ vehicle: vehicleJson(v) });
  }));

  r.delete('/vehicles/:id', wrap(async (req, res) => {
    const v = await members.removeVehicle(req.member.id, Number(req.params.id));
    activity.record({ actor: actor(req.member), action: 'vehicle.remove', req, detail: { plate: v.plate } });
    res.json({ ok: true });
  }));

  r.get('/visits', wrap(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const rows = await db.all(
      `SELECT e.id, e.plate, COALESCE(v.plate_display, e.plate) AS display, e.direction, e.decision, e.reason, e.at,
              s.name AS site, g.name AS gate
         FROM access_events e
         JOIN sites s ON s.id = e.site_id
         JOIN gates g ON g.id = e.gate_id
         LEFT JOIN vehicles v ON v.id = e.vehicle_id
        WHERE e.member_id = ?
        ORDER BY e.id DESC LIMIT ?`,
      [req.member.id, limit],
    );
    res.json({ visits: rows.map((v) => ({ ...v, at: iso(v.at) })) });
  }));

  /*
   * WHAT THE MEMBER PRESSED. The app sends its taps and screens in batches
   * (lib/data/activity_log.dart) so a fault report can be matched to exactly
   * what somebody did. Names and screens only -- never what was typed.
   */
  r.post('/log', limiter({ perMinute: 60, key: (req) => `l${req.member.id}` }), wrap(async (req, res) => {
    const events = Array.isArray(req.body && req.body.events) ? req.body.events.slice(0, 50) : [];
    for (const e of events) {
      activity.record({
        actor: actor(req.member),
        action: `ui.${String(e.type || 'event').replace(/[^a-z_.]/gi, '').slice(0, 30)}`,
        req,
        detail: { name: String(e.name || '').slice(0, 80), screen: String(e.screen || '').slice(0, 60), at: String(e.at || '').slice(0, 30), data: e.data && typeof e.data === 'object' ? e.data : undefined },
        app: String(e.app || req.get('X-Metric-App') || '').slice(0, 40),
      });
    }
    res.json({ ok: true, logged: events.length });
  }));

  return r;
}

module.exports = { apiRouter, memberJson, vehicleJson };
