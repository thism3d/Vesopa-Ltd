/**
 * Stage 1: every venue, everything it has, and add / seats / pause / resume /
 * remove for each (2026-10-05).
 *
 * Reads come from the apps that own the facts (the back office's overview,
 * licences, modules and holds; Gift's venues) and are put together here by
 * catalogue.lineFor, so every screen shows the same state for the same thing.
 * Changes go back to the owning app; nothing is written anywhere but here and
 * there.
 */
const db = require('./db');
const epos = require('./apps/epos');
const gift = require('./apps/gift');
const { connected, UpstreamError } = require('./upstream');
const catalogue = require('./catalogue');
const roles = require('./roles');
const audit = require('./audit');
const mail = require('./mail');

function refuse(message, status = 403) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/** The overview, with Gift folded in when it is connected. */
async function overview(as) {
  const o = await epos.overview(as);
  const giftRows = connected('gift') ? await gift.venues(as).catch(() => null) : null;
  const pending = await db.all(
    "SELECT * FROM adm_scheduled WHERE done_at IS NULL AND cancelled_at IS NULL AND app = 'gift'"
  ).catch(() => []);
  const giftBy = Object.fromEntries((giftRows || []).map((g) => [g.office_id, g]));
  const pendingBy = Object.fromEntries(pending.map((p) => [p.venue_id, p]));
  for (const v of o.venues) {
    v.gift = giftRows ? { ...(giftBy[v.id] || { enabled: false }), pending: pendingBy[v.id] || null } : null;
  }
  o.connected = { epos: true, gift: !!giftRows, hosting: connected('hosting') };
  return o;
}

/** One venue, every catalogue line. */
async function venue(id, as) {
  const o = await overview(as);
  const v = o.venues.find((x) => Number(x.id) === Number(id));
  if (!v) throw refuse('There is no such venue.', 404);
  const [limits, modules] = await Promise.all([epos.limits(id, as), epos.modules(id, as)]);
  const inUse = {};
  try {
    const all = await epos.licences(as);
    const row = (all.venues || []).find((x) => Number(x.id) === Number(id));
    for (const p of (row && row.products) || []) inUse[p.kind] = p.in_use;
  } catch { /* the counts are a nicety */ }
  const holds = Object.fromEntries((v.holds || []).map((h) => [h.item, h]));
  const byModule = Object.fromEntries((modules || []).map((m) => [m.key, m]));
  const lines = catalogue.ITEMS.map((item) => catalogue.lineFor(item, {
    limits: limits.limits || {}, inUse, modules: byModule, holds, gift: v.gift,
  }));
  return { venue: v, lines, keys: limits.keys || [], connected: o.connected };
}

const PERMISSION = { add: 'licences.sell', remove: 'licences.sell', seats: 'licences.sell', pause: 'licences.run', resume: 'licences.run' };

/**
 * Do one thing to one item at one venue.
 *
 * `who` is the session principal. `opts`: seats, reason, graceHours (24 by
 * default, the owner's grace day; 0 stops at once).
 */
async function act(who, venueId, itemKey, action, opts = {}) {
  const item = catalogue.BY_KEY[itemKey];
  if (!item) throw refuse('There is nothing called that to change.', 400);
  const permission = PERMISSION[action];
  if (!permission) throw refuse('Choose add, seats, pause, resume or remove.', 400);
  if (!roles.can(who, permission, item.app)) {
    throw refuse(`Your role (${who.roleLabel}) cannot ${action} ${item.label}.`);
  }
  const as = who.email;
  const { venue: v } = await venue(venueId, as);
  const graceHours = opts.graceHours === undefined || opts.graceHours === '' ? catalogue.GRACE_HOURS
    : Math.max(0, Math.min(720, Number(opts.graceHours) || 0));
  const reason = opts.reason ? String(opts.reason).slice(0, 255) : null;
  let until = null;

  try {
    if (item.hold === 'epos') {
      if (action === 'pause' || action === 'remove') {
        const r = await epos.setHold(v.id, item.holdKey, { action, reason, grace_hours: graceHours }, as);
        until = r.hold && r.hold.graceUntil;
      } else if (action === 'resume') {
        await epos.setHold(v.id, item.holdKey, { action: 'resume' }, as);
      } else if (action === 'add') {
        if (item.seats) {
          const n = opts.seats === undefined || opts.seats === '' ? null : Math.max(1, Number(opts.seats) || 1);
          await epos.setLimits(v.id, { [item.key]: n }, as);
        } else if (item.module) {
          await epos.setModules(v.id, { [item.module]: { allowed: true } }, as);
        }
        await epos.setHold(v.id, item.holdKey, { action: 'resume' }, as);
      } else if (action === 'seats') {
        if (!item.seats) throw refuse(`${item.label} has no seats to set.`, 400);
        const n = opts.seats === undefined || opts.seats === '' ? null : Math.max(0, Number(opts.seats) || 0);
        await epos.setLimits(v.id, { [item.key]: n }, as);
      }
    } else if (item.key === 'gift') {
      if (!connected('gift')) throw new UpstreamError('gift', 0, 'admin.vesopa.com is not connected to Vesopa Gift yet.');
      await db.run(
        "UPDATE adm_scheduled SET cancelled_at = UTC_TIMESTAMP() WHERE app = 'gift' AND venue_id = ? AND done_at IS NULL AND cancelled_at IS NULL",
        [v.id]
      );
      if (action === 'add' || action === 'resume') {
        await gift.enable(v.id, as);
      } else if (action === 'pause' || action === 'remove') {
        if (graceHours === 0) {
          await gift.disable(v.id, as);
        } else {
          await db.run(
            `INSERT INTO adm_scheduled (due_at, app, venue_id, item, action, actor)
             VALUES (DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? HOUR), 'gift', ?, 'gift', ?, ?)`,
            [graceHours, v.id, action, as]
          );
          until = new Date(Date.now() + graceHours * 3600 * 1000).toISOString();
        }
      } else {
        throw refuse(`${item.label} has no seats to set.`, 400);
      }
    }
  } catch (e) {
    await audit.record({ actor: as, action: `${itemKey}.${action}`, app: item.app, venueId: v.id, venueName: v.name, item: itemKey, detail: { error: e.message, seats: opts.seats, reason }, ok: false });
    throw e;
  }

  await audit.record({
    actor: as, action: `${itemKey}.${action}`, app: item.app, venueId: v.id, venueName: v.name, item: itemKey,
    detail: { seats: opts.seats ?? null, reason, grace_hours: action === 'pause' || action === 'remove' ? graceHours : undefined, until },
  });

  // "Owner and venue": the venue hears about anything it would notice.
  if (['add', 'pause', 'resume', 'remove'].includes(action) && v.email && opts.notify !== false) {
    const m = mail.venueChange({ venueName: v.name, label: item.label, action, until: until || new Date().toISOString() });
    await mail.send({ to: v.email, ...m });
  }
  return { ok: true, until };
}

module.exports = { overview, venue, act, PERMISSION };
