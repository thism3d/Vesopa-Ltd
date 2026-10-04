/**
 * Members and plans from Vesopa EPOS into this server's own tables.
 *
 * Owner, 2026-10: members and plans live in EPOS. This server keeps its own
 * cars, plates, sites, gates and cameras, and a copy of each EPOS member and
 * plan so a barrier decision never waits on the internet. The copy is
 * refreshed every EPOS_SYNC_EVERY_MS (5 minutes), on demand from the console,
 * and after every change this server makes through EPOS.
 *
 *   plans    matched by epos_plan_id; name, description, max_vehicles and
 *            active come from EPOS. Which sites a plan covers stays local.
 *   members  matched by epos_member_id, then Vesopa account (vesopa_sub),
 *            then email. An EPOS member nobody here has seen is added with
 *            vesopa_sub 'epos:<id>' until they sign in. A member here that
 *            EPOS does not have yet is created there -- active if Metric had
 *            already approved them, so switching EPOS on shuts nobody out.
 *
 * Local status follows the EPOS state: active -> active, pending/none ->
 * pending, anything else (frozen, expired, cancelled) -> suspended. 'closed'
 * (the member deleted their account here) is never changed by a sync.
 */

const db = require('./db');
const config = require('./config');
const epos = require('./epos');
const sync = require('./sync');
const activity = require('./activity');

const SYSTEM = { type: 'system', label: 'EPOS sync' };
const day = (v) => (v ? String(v).slice(0, 10) : null);

function statusFor(state) {
  if (state === 'active') return 'active';
  if (state === 'pending' || state === 'none' || !state) return 'pending';
  return 'suspended';
}

/** The local plan for an EPOS plan ({id, name, max_vehicles, ...}), made if new. */
async function upsertPlan(p) {
  if (!p || p.id == null) return null;
  const id = String(p.id);
  const max = Math.max(1, Math.min(20, Number(p.max_vehicles) || config.DEFAULT_MAX_VEHICLES));
  const active = p.active === undefined ? 1 : (p.active ? 1 : 0);
  const name = String(p.name || 'Membership').slice(0, 80);
  const existing = await db.one('SELECT id FROM plans WHERE epos_plan_id = ?', [id]);
  if (existing) {
    // A member's embedded plan carries no description or active flag: keep ours.
    await db.run(
      `UPDATE plans SET name = ?, max_vehicles = ?, description = COALESCE(?, description), active = COALESCE(?, active), epos_synced_at = NOW()
        WHERE id = ?`,
      [name, max, p.description != null ? String(p.description).slice(0, 255) : null, p.active === undefined ? null : active, existing.id],
    );
    return existing.id;
  }
  const res = await db.run(
    'INSERT INTO plans (name, description, max_vehicles, active, epos_plan_id, epos_synced_at) VALUES (?, ?, ?, ?, ?, NOW())',
    [name, String(p.description || '').slice(0, 255), max, active, id],
  );
  return res.insertId;
}

/** Write what EPOS says about a member onto the local row. Returns the row. */
async function apply(localId, em) {
  const before = await db.one('SELECT * FROM members WHERE id = ?', [localId]);
  const planId = em.plan ? await upsertPlan(em.plan) : null;
  const state = String(em.state || 'none').slice(0, 20);
  await db.run(
    `UPDATE members SET epos_member_id = ?, epos_state = ?, epos_access = ?, epos_plan_name = ?, epos_member_no = ?,
            epos_synced_at = NOW(),
            status = IF(status = 'closed', 'closed', ?),
            plan_id = ?, valid_from = ?, valid_to = ?,
            name = COALESCE(NULLIF(?, ''), name), phone = COALESCE(NULLIF(?, ''), phone),
            email = COALESCE(NULLIF(?, ''), email)
      WHERE id = ?`,
    [String(em.id), state, em.access == null ? null : (em.access ? 1 : 0),
      em.plan ? String(em.plan.name || '').slice(0, 80) : '', String(em.member_number || em.member_no || '').slice(0, 40),
      statusFor(state), planId, day(em.valid_from), day(em.valid_to),
      String(em.name || '').slice(0, 120), String(em.phone || '').slice(0, 40), String(em.email || '').slice(0, 191),
      localId],
  );
  const after = await db.one('SELECT * FROM members WHERE id = ?', [localId]);
  if (!before || before.status !== after.status || String(before.plan_id) !== String(after.plan_id)
      || day(before.valid_to) !== day(after.valid_to) || before.epos_state !== after.epos_state) {
    sync.soon();
  }
  return after;
}

/**
 * Create or find this member in EPOS and link the local row to them. EPOS
 * answers with the member it already has if the Vesopa account or email is
 * known there, so this is safe to repeat.
 */
async function link(member, { by = 'Metric Membership', status } = {}) {
  const plan = member.plan_id ? await db.one('SELECT epos_plan_id FROM plans WHERE id = ?', [member.plan_id]) : null;
  const em = await epos.createMember({
    name: member.name || '',
    email: member.email || '',
    phone: member.phone || '',
    vesopa_sub: String(member.vesopa_sub || '').startsWith('epos:') ? '' : member.vesopa_sub,
    ...(plan && plan.epos_plan_id ? { scheme_id: Number(plan.epos_plan_id) || plan.epos_plan_id } : {}),
    ...(status ? { status } : {}),
    by,
  });
  if (!em || em.id == null) throw new epos.EposError('Vesopa EPOS did not return the member.');
  // Another local row may already hold this EPOS member (two sign-ins, one
  // person): leave that link alone and report it rather than steal it.
  const other = await db.one('SELECT id FROM members WHERE epos_member_id = ? AND id <> ?', [String(em.id), member.id]);
  if (other) throw new epos.EposError(`EPOS member ${em.id} is already linked to member ${other.id} here.`, 409);
  const row = await apply(member.id, em);
  activity.record({ actor: SYSTEM, action: 'epos.linked', detail: { memberId: member.id, eposId: em.id, state: em.state } });
  return row;
}

/** Best effort, for sign-in: never stops somebody signing in. */
async function tryLink(member, opts) {
  if (!epos.enabled()) return member;
  try {
    return await link(member, opts);
  } catch (e) {
    activity.record({ actor: SYSTEM, action: 'epos.link_failed', detail: { memberId: member.id, error: e.message } });
    return member;
  }
}

// Each staff action, as EPOS names it. 'approve' also reinstates a cancelled one.
const ACTIONS = new Set(['approve', 'renew', 'cancel', 'suspend', 'plan']);

/**
 * A staff change, made in EPOS first and only then here. Throws EposError
 * (with EPOS's own message) and changes nothing locally if EPOS refuses.
 */
async function staffAction(member, action, { by, schemeId, now } = {}) {
  if (!ACTIONS.has(action)) throw new epos.EposError('No such action.', 404);
  let m = member;
  if (!m.epos_member_id) m = await link(m, { by });
  const body = { by: String(by || 'Metric staff').slice(0, 190) };
  if (action === 'plan') body.scheme_id = Number(schemeId) || schemeId;
  if (action === 'cancel' && now) body.now = true;
  const em = await epos.action(m.epos_member_id, action, body);
  return apply(m.id, em);
}

let last = { at: null, ok: null, error: null, plans: 0, members: 0, added: 0, linked: 0, created: 0, failed: 0 };
let running = null;

async function run() {
  const out = { plans: 0, members: 0, added: 0, linked: 0, created: 0, failed: 0, errors: [] };

  // Plans first, so every member's plan is here when the members come.
  const plans = await epos.plans();
  const seenPlans = [];
  for (const p of plans) {
    if (p.id == null) continue;
    await upsertPlan(p);
    seenPlans.push(String(p.id));
    out.plans++;
  }
  if (seenPlans.length) {
    await db.run('UPDATE plans SET active = 0 WHERE epos_plan_id IS NOT NULL AND epos_plan_id NOT IN (?)', [seenPlans]);
  }

  const list = await epos.members();
  const seen = new Set();
  for (const em of list) {
    if (em.id == null) continue;
    const eid = String(em.id);
    seen.add(eid);
    try {
      let local = await db.one('SELECT * FROM members WHERE epos_member_id = ?', [eid]);
      if (!local && em.vesopa_sub) {
        local = await db.one('SELECT * FROM members WHERE vesopa_sub = ? AND epos_member_id IS NULL', [String(em.vesopa_sub)]);
      }
      if (!local && em.email) {
        const rows = await db.all('SELECT * FROM members WHERE LOWER(email) = ? AND epos_member_id IS NULL LIMIT 2', [String(em.email).toLowerCase()]);
        if (rows.length === 1) local = rows[0];
      }
      if (!local) {
        let sub = em.vesopa_sub ? String(em.vesopa_sub) : `epos:${eid}`;
        // That Vesopa account is here but linked to another EPOS member.
        if (await db.one('SELECT id FROM members WHERE vesopa_sub = ?', [sub])) sub = `epos:${eid}`;
        const res = await db.run('INSERT INTO members (vesopa_sub, email, name, status) VALUES (?, ?, ?, ?)',
          [sub, String(em.email || '').slice(0, 191), String(em.name || '').slice(0, 120), 'pending']);
        await db.run('UPDATE members SET member_no = ? WHERE id = ?', [`MG${String(100000 + res.insertId)}`, res.insertId]);
        local = await db.one('SELECT * FROM members WHERE id = ?', [res.insertId]);
        out.added++;
      } else if (!local.epos_member_id) {
        out.linked++;
      }
      await apply(local.id, em);
      out.members++;
    } catch (e) {
      out.failed++;
      out.errors.push(`EPOS member ${eid}: ${e.message}`);
    }
  }

  // EPOS no longer lists them (membership removed there): no access. EPOS
  // returns at most 2000, so a full page proves nothing about the rest.
  if (list.length < 2000) {
    const linked = await db.all("SELECT id, epos_member_id FROM members WHERE epos_member_id IS NOT NULL AND status <> 'closed'");
    for (const r of linked) {
      if (seen.has(String(r.epos_member_id))) continue;
      await db.run("UPDATE members SET epos_state = 'none', status = 'pending', epos_synced_at = NOW() WHERE id = ?", [r.id]);
      sync.soon();
    }
  }

  // Members who signed up here but are not in EPOS yet (EPOS was down, or
  // this is the first sync after the key was set): create them there.
  const unlinked = await db.all(
    "SELECT * FROM members WHERE epos_member_id IS NULL AND status <> 'closed' AND vesopa_sub NOT LIKE 'epos:%' ORDER BY id",
  );
  for (const m of unlinked) {
    try {
      await link(m, { status: m.status === 'active' ? 'active' : undefined });
      out.created++;
    } catch (e) {
      out.failed++;
      out.errors.push(`member ${m.id}: ${e.message}`);
    }
  }
  return out;
}

/** One sync at a time; a second ask while one runs gets the same result. */
async function syncAll() {
  if (!epos.enabled()) return { skipped: 'EPOS is not configured' };
  if (running) return running;
  running = (async () => {
    try {
      const out = await run();
      last = { at: new Date().toISOString(), ok: out.failed === 0, error: out.errors[0] || null, ...out, errors: out.errors.slice(0, 20) };
      if (out.added || out.linked || out.created || out.failed) {
        activity.record({ actor: SYSTEM, action: 'epos.sync', detail: { ...out, errors: out.errors.slice(0, 20) } });
      }
      return last;
    } catch (e) {
      last = { ...last, at: new Date().toISOString(), ok: false, error: e.message };
      activity.record({ actor: SYSTEM, action: 'epos.sync_failed', detail: { error: e.message } });
      throw e;
    } finally {
      running = null;
    }
  })();
  return running;
}

function status() {
  return { enabled: epos.enabled(), baseUrl: epos.enabled() ? config.EPOS_BASE_URL : null, everyMs: config.EPOS_SYNC_EVERY_MS, last };
}

module.exports = { syncAll, link, tryLink, staffAction, apply, upsertPlan, statusFor, status, ACTIONS };
