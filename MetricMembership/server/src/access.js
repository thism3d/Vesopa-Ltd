/**
 * Who may pass which barrier: the one place that decides.
 *
 * Both routes to the barrier use it -- the decision a camera asks for on every
 * read (`decide`) and the list pushed onto cameras that decide for themselves
 * (`allowedPlates`) -- so a car is never let in one way and refused the other.
 */

const db = require('./db');
const config = require('./config');
const plates = require('./plates');
const activity = require('./activity');

function today() {
  return new Date().toISOString().slice(0, 10);
}

const iso = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d ? String(d).slice(0, 10) : null);

/**
 * Why a member may or may not use a site, as one reason word.
 * 'ok' is the only one that opens anything.
 */
// What each EPOS membership state (vesopa_server memberships.js stateOf) is
// called here when it keeps the barrier shut.
const EPOS_REFUSAL = { pending: 'pending', none: 'pending', frozen: 'frozen', expired: 'expired', cancelled: 'cancelled' };

function standing(member, plan, siteId) {
  if (!member) return 'unknown_plate';
  if (member.status === 'closed') return 'closed';
  // Members live in Vesopa EPOS once it is configured: only EPOS 'active'
  // opens. A member not linked to EPOS yet (EPOS was down when they signed
  // up) keeps the local status until the next sync links them.
  if (config.EPOS_ON && member.epos_member_id) {
    if (member.epos_state !== 'active') return EPOS_REFUSAL[member.epos_state] || 'suspended';
  }
  if (member.status === 'pending') return 'pending';
  if (member.status === 'suspended') return 'suspended';
  if (member.status !== 'active') return 'closed';
  const t = today();
  if (member.valid_from && iso(member.valid_from) > t) return 'not_started';
  if (member.valid_to && iso(member.valid_to) < t) return 'expired';
  if (plan && plan.site_ids) {
    const ids = String(plan.site_ids).split(',').map((s) => Number(s.trim())).filter(Boolean);
    if (siteId && !ids.includes(Number(siteId))) return 'not_this_site';
  }
  return 'ok';
}

/** The live vehicle a read belongs to, exact first, then fuzzy if the lane allows. */
async function findVehicle(plate, { fuzzy }) {
  const exact = await db.one('SELECT * FROM vehicles WHERE live_plate = ?', [plate]);
  if (exact) return { vehicle: exact, how: 'exact' };
  if (!fuzzy) return { vehicle: null };
  const rows = await db.all('SELECT * FROM vehicles WHERE removed_at IS NULL AND plate_fuzzy = ? LIMIT 2', [plates.fuzzy(plate)]);
  // Two cars that fold to the same thing: open for neither rather than guess.
  if (rows.length === 1) return { vehicle: rows[0], how: 'fuzzy' };
  return { vehicle: null, ambiguous: rows.length > 1 };
}

function directionOf(gate, reported) {
  if (gate.direction === 'entry' || gate.direction === 'exit') return gate.direction;
  const r = String(reported || '').toLowerCase();
  if (/^(in|entry|enter|entrance|approach|arrive|arrival)$/.test(r)) return 'entry';
  if (/^(out|exit|leave|leaving|departure|depart|away)$/.test(r)) return 'exit';
  return 'unknown';
}

// Cameras send a burst of reads for one car. Answer the burst once.
const recent = new Map();
const BURST_MS = 15000;

/**
 * A camera has read a plate at a gate. Decide, record, answer.
 */
async function decide(gate, { plate: raw, direction: reported, confidence, source = '' }) {
  const plate = plates.normalise(raw);
  const direction = directionOf(gate, reported);
  if (!plate) return { open: false, decision: 'deny', reason: 'no_plate', plate: '', direction };

  const burstKey = `${gate.id}:${plate}`;
  const prior = recent.get(burstKey);
  if (prior && Date.now() - prior.at < BURST_MS) return { ...prior.answer, repeat: true };

  const { vehicle, how, ambiguous } = await findVehicle(plate, { fuzzy: Boolean(gate.fuzzy_match) });
  let member = null;
  let plan = null;
  if (vehicle) {
    member = await db.one('SELECT * FROM members WHERE id = ?', [vehicle.member_id]);
    if (member && member.plan_id) plan = await db.one('SELECT * FROM plans WHERE id = ?', [member.plan_id]);
  }
  let reason = ambiguous ? 'ambiguous_read' : standing(member, plan, gate.site_id);
  let open = reason === 'ok';
  if (open) reason = how === 'fuzzy' ? 'member_fuzzy' : 'member';

  const answer = {
    open,
    decision: open ? 'open' : 'deny',
    reason,
    plate,
    direction,
    ...(vehicle ? { matched: vehicle.plate } : {}),
  };

  await db.run(
    `INSERT INTO access_events (gate_id, site_id, plate, direction, decision, reason, member_id, vehicle_id, confidence, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [gate.id, gate.site_id, plate, direction, answer.decision, reason,
      member ? member.id : null, vehicle ? vehicle.id : null,
      Number.isFinite(Number(confidence)) && confidence !== '' && confidence != null ? Number(confidence) : null,
      String(source).slice(0, 30)],
  );
  await db.run('UPDATE gates SET last_seen_at = NOW() WHERE id = ?', [gate.id]);
  activity.record({
    actor: { type: 'gate', id: gate.id, label: gate.name },
    action: 'gate.read',
    detail: { plate, direction, decision: answer.decision, reason, memberId: member ? member.id : null, source },
  });

  recent.set(burstKey, { at: Date.now(), answer });
  if (recent.size > 5000) {
    const now = Date.now();
    for (const [k, v] of recent) if (now - v.at > BURST_MS) recent.delete(k);
  }
  return answer;
}

/**
 * Every plate that should open a barrier at this site right now: the live
 * cars of members in good standing whose plan covers the site.
 */
async function allowedPlates(siteId) {
  const rows = await db.all(
    `SELECT v.plate, m.status, m.valid_from, m.valid_to, m.epos_member_id, m.epos_state, p.site_ids
       FROM vehicles v
       JOIN members m ON m.id = v.member_id
       LEFT JOIN plans p ON p.id = m.plan_id
      WHERE v.removed_at IS NULL AND m.status = 'active'`,
  );
  return rows
    .filter((r) => standing({ status: r.status, valid_from: r.valid_from, valid_to: r.valid_to, epos_member_id: r.epos_member_id, epos_state: r.epos_state }, { site_ids: r.site_ids }, siteId) === 'ok')
    .map((r) => r.plate)
    .sort();
}

function _resetBursts() { recent.clear(); }

module.exports = { decide, allowedPlates, standing, directionOf, _resetBursts };
