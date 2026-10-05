const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const { requireAuth, requireTerminal } = require('./auth');
const { moduleOn } = require('./modules');
const schemes = require('./loyalty_schemes');
const { ensureMemberNumber } = require('./member_numbers');
const dojo = require('./dojo_client');
const { venueKey } = require('./express_kiosk');
const { sendMail } = require('./mailer');
const { appUrl } = require('./loyalty_host');

/**
 * Memberships: plans, members, family, freezes, classes and paying online.
 *
 * The Memberships module (src/modules.js). Built on what was already here --
 * see schema_memberships.sql for why a plan is a loyalty scheme and a member
 * is a customer. Everything below refuses with 404 while the module is not on
 * for the venue, as the gym door does: a pub asking a gym question has asked
 * about a feature that is not part of its system.
 *
 * ONE SET OF RULES, FOUR WAYS IN
 *
 *   /api/memberships/*, /api/classes/*       the back office (session token)
 *   /till/memberships/*, /till/classes/*     a till (terminal token)
 *   /loyalty/v1/me/membership*, ...classes*  the member, in the loyalty app
 *   /partner/v1/memberships/*                another Vesopa system (Metric)
 *
 * Each route is a thin wrapper over the functions in the first half of this
 * file, so joining at the till, in the back office and online cannot drift
 * into three different ideas of what joining means.
 *
 * MONEY
 *
 * At the till, fees are lines on the bill and go through tendering like
 * everything else (see vesopa_epos/lib/data/membership.dart); the till posts
 * the join or renewal once the bill is paid. Online, the member pays on Dojo's
 * hosted checkout with the venue's own Dojo key, and the membership moves only
 * when the intent itself says it is paid.
 */

const STATES = ['pending', 'active', 'frozen', 'cancelled'];

const isMissing = (e) =>
  e && (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR');

function fail(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

const dateText = (v) => {
  if (!v) return null;
  if (v instanceof Date) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
  }
  const s = String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};

/** Today in the database's own day, which is the day every date here is in. */
async function today(db) {
  const [[row]] = await db.query("SELECT DATE_FORMAT(CURDATE(), '%Y-%m-%d') AS d");
  return row.d;
}

async function addDays(db, date, days) {
  const [[row]] = await db.query(
    "SELECT DATE_FORMAT(DATE_ADD(?, INTERVAL ? DAY), '%Y-%m-%d') AS d", [date, days]);
  return row.d;
}

async function addMonths(db, date, months) {
  // In SQL: MySQL already knows a month from the 31st of January is the 28th.
  const [[row]] = await db.query(
    "SELECT DATE_FORMAT(DATE_ADD(?, INTERVAL ? MONTH), '%Y-%m-%d') AS d", [date, months]);
  return row.d;
}

const daysBetween = (a, b) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const MEMBER_FIELDS = [
  ['id'], ['name'], ['email'], ['phone'], ['card_number'], ['member_no'], ['photo_url'],
  ['scheme_id'], ['membership_status'], ['family_head_id'], ['vesopa_sub'],
  ['renewal_reminders'], ['notes'],
  ['membership_expiry', 'date'], ['joined_on', 'date'], ['frozen_from', 'date'],
  ['frozen_until', 'date'], ['cancelled_on', 'date'],
];

/**
 * The member columns, as this database has them.
 *
 * epos_customers is the oldest table here and has been widened by a dozen
 * schema files over the years. A venue's server that missed one of them (a
 * photo column, say) used to answer every member list -- the back office's,
 * the till's and Metric's -- with a bare 500. A column this database does not
 * have is read as NULL instead, and named once in the log so somebody applies
 * the schema file. Looked up once per process.
 */
let memberColumns = null;
async function memberSelect(db) {
  if (memberColumns) return memberColumns;
  let have = null;
  try {
    const [rows] = await db.query(
      `SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'epos_customers'`
    );
    if (rows.length) have = new Set(rows.map((r) => String(r.c).toLowerCase()));
  } catch { /* no information_schema access: assume every column */ }
  const missing = [];
  const list = MEMBER_FIELDS.map(([col, kind]) => {
    if (have && !have.has(col)) {
      missing.push(col);
      return `NULL AS ${col}`;
    }
    return kind === 'date' ? `DATE_FORMAT(c.${col}, '%Y-%m-%d') AS ${col}` : `c.${col}`;
  });
  if (missing.length) console.warn(`[memberships] epos_customers has no ${missing.join(', ')}; read as empty. Apply the schema files.`);
  memberColumns = list.join(', ');
  return memberColumns;
}
/** For tests that change the table under a running process. */
const forgetMemberColumns = () => { memberColumns = null; };

async function venueSettings(db, office) {
  try {
    const [[row]] = await db.query(
      `SELECT membership_term_months, membership_fee_minor,
              DATE_FORMAT(membership_renewal_date, '%Y-%m-%d') AS membership_renewal_date
         FROM epos_loyalty_settings WHERE office = ?`,
      [office]
    );
    return row || {};
  } catch (e) {
    if (isMissing(e)) return {};
    throw e;
  }
}

/** The venue's plans: its schemes that are memberships. */
async function plansFor(db, office, { activeOnly = false } = {}) {
  const all = await schemes.listSchemes(db, office, { activeOnly, withCounts: true });
  const settings = await venueSettings(db, office);
  return all.filter((s) => s.is_membership).map((s) => describePlan(s, settings));
}

/** A plan with the venue's defaults filled in, as every screen shows it. */
function describePlan(s, settings = {}) {
  const term = s.membership_term_months ?? (Number(settings.membership_term_months) || 12);
  const fee = s.membership_fee_minor ?? (Number(settings.membership_fee_minor) || 0);
  return {
    id: s.id,
    name: s.name,
    colour: s.colour,
    description: s.description,
    active: s.active,
    fee_minor: fee,
    term_months: term,
    season_ends: settings.membership_renewal_date || null,
    joining_fee_minor: s.joining_fee_minor || 0,
    family_size: Math.max(1, s.family_size || 1),
    freeze_days_per_year: s.freeze_days_per_year || 0,
    includes_gym: !!s.includes_gym,
    includes_classes: !!s.includes_classes,
    class_credits_per_month: s.class_credits_per_month,
    max_vehicles: s.max_vehicles ?? 3,
    sell_online: !!s.sell_online,
    card_prefix: s.card_prefix,
    members: s.members,
  };
}

async function planById(db, office, id) {
  if (id == null || id === '') return null;
  return (await plansFor(db, office)).find((p) => p.id === Number(id)) || null;
}

/**
 * What a membership is, today: pending, active, frozen, expired or cancelled.
 * `none` for a customer who has never joined a plan.
 */
function stateOf(m, day) {
  const status = m.membership_status || '';
  if (!status) return 'none';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'pending') return 'pending';
  if (status === 'frozen' && m.frozen_from && m.frozen_until
      && m.frozen_from <= day && day <= m.frozen_until) return 'frozen';
  if (m.membership_expiry && m.membership_expiry < day) return 'expired';
  return 'active';
}

/**
 * A freeze whose last day has passed is over. Swept on read, like the gym's
 * forgotten visits: a timer is a second thing to deploy and forget, and the
 * screens that read members are the only place it would show.
 */
async function sweepFreezes(db, office) {
  await db.execute(
    `UPDATE epos_customers
        SET membership_status = 'active', frozen_from = NULL, frozen_until = NULL
      WHERE email_key = ? AND membership_status = 'frozen' AND frozen_until < CURDATE()`,
    [office]
  ).catch((e) => { if (!isMissing(e)) throw e; });
}

async function decorate(db, office, rows) {
  if (!rows.length) return rows;
  const day = await today(db);
  const plans = await plansFor(db, office);
  const byId = Object.fromEntries(plans.map((p) => [p.id, p]));
  await schemes.decorateCustomers(db, office, rows).catch(() => {});
  for (const m of rows) {
    m.state = stateOf(m, day);
    m.plan = m.scheme_id != null ? byId[Number(m.scheme_id)] || null : null;
    m.days_left = m.membership_expiry ? daysBetween(day, m.membership_expiry) : null;
    m.freeze_scheduled = m.membership_status === 'frozen' && m.frozen_from > day;
  }
  return rows;
}

async function memberById(db, office, id) {
  const [rows] = await db.query(
    `SELECT ${await memberSelect(db)} FROM epos_customers c WHERE c.id = ? AND c.email_key = ?`,
    [id, office]
  );
  if (!rows.length) return null;
  return (await decorate(db, office, rows))[0];
}

/** One member with their family, history and upcoming classes. */
async function memberDetail(db, office, id) {
  await sweepFreezes(db, office);
  const m = await memberById(db, office, id);
  if (!m) return null;
  const headId = m.family_head_id || m.id;
  const [family] = await db.query(
    `SELECT ${await memberSelect(db)} FROM epos_customers c
      WHERE c.email_key = ? AND (c.id = ? OR c.family_head_id = ?) ORDER BY c.family_head_id IS NOT NULL, c.name`,
    [office, headId, headId]
  );
  m.family = (await decorate(db, office, family)).map((f) => ({
    id: f.id, name: f.name, member_number: f.member_number, state: f.state, payer: !f.family_head_id,
  }));
  const [events] = await db.query(
    `SELECT id, kind, scheme_id, DATE_FORMAT(expiry_before, '%Y-%m-%d') AS expiry_before,
            DATE_FORMAT(expiry_after, '%Y-%m-%d') AS expiry_after, amount_minor, note, via, by_who, created_at
       FROM epos_membership_events WHERE office = ? AND customer_id = ?
      ORDER BY created_at DESC, id DESC LIMIT 100`,
    [office, id]
  ).catch((e) => { if (isMissing(e)) return [[]]; throw e; });
  m.history = events;
  const [bookings] = await db.query(
    `SELECT b.id, b.status, s.id AS session_id, s.starts_at, k.name AS class_name
       FROM epos_class_bookings b
       JOIN epos_class_sessions s ON s.id = b.session_id
       JOIN epos_classes k ON k.id = s.class_id
      WHERE b.office = ? AND b.customer_id = ? AND s.starts_at >= NOW() - INTERVAL 30 DAY
      ORDER BY s.starts_at DESC LIMIT 50`,
    [office, id]
  ).catch((e) => { if (isMissing(e)) return [[]]; throw e; });
  m.bookings = bookings;
  m.freeze_days_used = await freezeDaysUsed(db, office, id);
  return m;
}

async function listMembers(db, office, { state, plan, q, limit = 500 } = {}) {
  await sweepFreezes(db, office);
  const where = ["c.email_key = ?", "c.membership_status <> ''"];
  const params = [office];
  if (plan) { where.push('c.scheme_id = ?'); params.push(Number(plan)); }
  if (q) {
    const like = `%${String(q).trim()}%`;
    where.push('(c.name LIKE ? OR c.email LIKE ? OR c.phone LIKE ? OR c.card_number LIKE ?)');
    params.push(like, like, like, like);
  }
  const [rows] = await db.query(
    `SELECT ${await memberSelect(db)} FROM epos_customers c WHERE ${where.join(' AND ')}
      ORDER BY c.name LIMIT ${Math.min(Math.max(Number(limit) || 500, 1), 2000)}`,
    params
  );
  const out = await decorate(db, office, rows);
  return state ? out.filter((m) => m.state === state) : out;
}

async function summary(db, office) {
  const all = await listMembers(db, office, { limit: 2000 });
  const count = (s) => all.filter((m) => m.state === s).length;
  const [[joins]] = await db.query(
    `SELECT COUNT(*) AS n FROM epos_membership_events
      WHERE office = ? AND kind = 'join' AND created_at >= DATE_FORMAT(CURDATE(), '%Y-%m-01')`,
    [office]
  ).catch(() => [[{ n: 0 }]]);
  const [[online]] = await db.query(
    `SELECT COALESCE(SUM(amount_minor), 0) AS total FROM epos_membership_payments
      WHERE office = ? AND status = 'paid' AND paid_at >= DATE_FORMAT(CURDATE(), '%Y-%m-01')`,
    [office]
  ).catch(() => [[{ total: 0 }]]);
  return {
    members: all.length,
    active: count('active'),
    frozen: count('frozen'),
    expired: count('expired'),
    pending: count('pending'),
    cancelled: count('cancelled'),
    expiring_soon: all.filter((m) => m.state === 'active' && m.days_left != null && m.days_left <= 14).length,
    joined_this_month: Number(joins.n) || 0,
    paid_online_this_month_minor: Number(online.total) || 0,
  };
}

// ---------------------------------------------------------------------------
// Changing a membership
// ---------------------------------------------------------------------------

async function logEvent(db, e) {
  try {
    await db.execute(
      `INSERT INTO epos_membership_events
         (office, customer_id, kind, scheme_id, expiry_before, expiry_after, amount_minor, note, via, by_who)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [e.office, e.customer_id, e.kind, e.scheme_id ?? null, e.before ?? null, e.after ?? null,
        e.amount ?? null, e.note ? String(e.note).slice(0, 255) : null, e.via || 'backoffice', e.by || null]
    );
  } catch (err) {
    if (!isMissing(err)) throw err;
  }
}

/**
 * Everybody on a family plan shares the payer's plan, dates and state. Copied
 * onto their rows rather than looked up through the payer on every read, so
 * the gym door, the till and the app -- which all read a customer row -- see
 * the right answer without each learning about families.
 */
async function syncFamily(db, office, headId) {
  await db.execute(
    `UPDATE epos_customers f
       JOIN epos_customers h ON h.id = ? AND h.email_key = ?
        SET f.scheme_id = h.scheme_id,
            f.membership_expiry = h.membership_expiry,
            f.membership_status = h.membership_status,
            f.frozen_from = h.frozen_from,
            f.frozen_until = h.frozen_until,
            f.cancelled_on = h.cancelled_on
      WHERE f.family_head_id = h.id AND f.email_key = h.email_key`,
    [headId, office]
  );
}

/**
 * Where a renewal runs to, from today or from the expiry it already has if
 * that is still ahead -- an early renewal extends, it never shortens. A season
 * date the venue set wins while it is in the future, exactly as the till's
 * renewal (commerce.js /loyalty/renew) does.
 */
async function renewalDate(db, office, member, plan) {
  const day = await today(db);
  const settings = await venueSettings(db, office);
  const season = settings.membership_renewal_date;
  if (season && season >= day) return season;
  const from = member.membership_expiry && member.membership_expiry > day ? member.membership_expiry : day;
  const months = Math.min(Math.max(Number(plan ? plan.term_months : settings.membership_term_months) || 12, 1), 60);
  return addMonths(db, from, months);
}

/** Create a customer for somebody joining who is not one yet. */
async function newCustomer(db, office, fields) {
  const name = String(fields.name || '').trim().slice(0, 255);
  if (!name) throw fail(400, 'A new member needs a name.');
  const id = crypto.randomUUID();
  await db.execute(
    `INSERT INTO epos_customers (id, email_key, name, phone, email, card_number)
     VALUES (?,?,?,?,?,?)`,
    [id, office, name,
      String(fields.phone || '').trim().slice(0, 64) || null,
      String(fields.email || '').trim().slice(0, 255) || null,
      String(fields.card_number || '').replace(/\D/g, '').slice(0, 64) || null]
  );
  return id;
}

/**
 * Join a plan.
 *
 * `customer_id` for somebody the venue already knows, or `customer` fields for
 * a new one. `family_head_id` puts them on another member's family plan, which
 * must have room. `status: 'pending'` holds them for approval (Metric's new
 * members wait for staff); anything else starts the membership today.
 */
async function join(db, office, input, { via = 'backoffice', by = null, amount = null } = {}) {
  let customerId = input.customer_id ? String(input.customer_id) : null;
  let head = null;
  let plan = null;

  if (input.family_head_id) {
    head = await memberById(db, office, String(input.family_head_id));
    if (!head || !head.membership_status) throw fail(404, 'That family payer is not a member.');
    if (head.family_head_id) throw fail(400, 'Add family to the person who pays, not to another family member.');
    plan = head.plan;
    if (!plan) throw fail(400, "The payer's plan no longer exists.");
    const [[{ n }]] = await db.query(
      'SELECT COUNT(*) AS n FROM epos_customers WHERE email_key = ? AND family_head_id = ?',
      [office, head.id]
    );
    if (Number(n) + 1 >= plan.family_size) {
      throw fail(409, `${plan.name} covers ${plan.family_size} ${plan.family_size === 1 ? 'person' : 'people'}, and it is full.`);
    }
  } else {
    plan = await planById(db, office, input.scheme_id);
    if (!plan) throw fail(400, 'Pick a membership plan.');
    if (!plan.active) throw fail(400, `${plan.name} is not taking new members.`);
  }

  if (customerId) {
    const existing = await memberById(db, office, customerId);
    if (!existing) throw fail(404, 'No such customer.');
    if (existing.membership_status && !['cancelled'].includes(existing.membership_status)
        && existing.state !== 'expired') {
      throw fail(409, `${existing.name} is already a member.`);
    }
  } else {
    customerId = await newCustomer(db, office, input.customer || input);
  }

  const day = await today(db);
  const status = input.status === 'pending' ? 'pending' : 'active';
  const member = await memberById(db, office, customerId);
  const expiry = head ? head.membership_expiry : await renewalDate(db, office, { membership_expiry: null }, plan);

  await db.execute(
    `UPDATE epos_customers
        SET scheme_id = ?, membership_status = ?, joined_on = ?, membership_expiry = ?,
            family_head_id = ?, frozen_from = NULL, frozen_until = NULL, cancelled_on = NULL
      WHERE id = ? AND email_key = ?`,
    [plan.id, head ? head.membership_status : status, day, expiry, head ? head.id : null, customerId, office]
  );
  await ensureMemberNumber(db, office, customerId).catch(() => null);
  await logEvent(db, {
    office, customer_id: customerId, kind: 'join', scheme_id: plan.id,
    before: member.membership_expiry, after: expiry, amount, via, by,
    note: head ? `Family of ${head.name}` : (status === 'pending' ? 'Waiting for approval' : null),
  });
  return memberDetail(db, office, customerId);
}

async function requireMember(db, office, id) {
  const m = await memberById(db, office, id);
  if (!m || !m.membership_status) throw fail(404, 'No such member.');
  return m;
}

/** Changes go to the payer; a family member's row follows. */
async function payerOf(db, office, m) {
  return m.family_head_id ? requireMember(db, office, m.family_head_id) : m;
}

async function renew(db, office, id, { via = 'backoffice', by = null, amount = null } = {}) {
  const m = await payerOf(db, office, await requireMember(db, office, id));
  if (m.membership_status === 'cancelled') throw fail(409, 'This membership is cancelled. Reinstate it first.');
  const expiry = await renewalDate(db, office, m, m.plan);
  await db.execute(
    `UPDATE epos_customers SET membership_expiry = ?,
            membership_status = IF(membership_status = 'pending', 'active', membership_status)
      WHERE id = ? AND email_key = ?`,
    [expiry, m.id, office]
  );
  await syncFamily(db, office, m.id);
  await logEvent(db, { office, customer_id: m.id, kind: 'renew', scheme_id: m.scheme_id,
    before: m.membership_expiry, after: expiry, amount, via, by });
  return memberDetail(db, office, id);
}

async function freezeDaysUsed(db, office, id) {
  try {
    const [[row]] = await db.query(
      `SELECT COALESCE(SUM(DATEDIFF(expiry_after, expiry_before)), 0) AS days
         FROM epos_membership_events
        WHERE office = ? AND customer_id = ? AND kind IN ('freeze', 'unfreeze')
          AND created_at >= NOW() - INTERVAL 365 DAY`,
      [office, id]
    );
    return Math.max(0, Number(row.days) || 0);
  } catch (e) {
    if (isMissing(e)) return 0;
    throw e;
  }
}

/**
 * Freeze a membership from one day to another.
 *
 * The expiry moves on by the length of the freeze at once, so a member who
 * freezes for a month gets the month back -- the thing a freeze is for -- and
 * every screen shows the date they will actually run to. Unfreezing early
 * takes back the days not used. The plan says how many days a year are
 * allowed, counted from the history so it cannot be reset by editing a row.
 */
async function freeze(db, office, id, { from, until, note }, { via = 'backoffice', by = null } = {}) {
  const m = await payerOf(db, office, await requireMember(db, office, id));
  if (m.state === 'cancelled') throw fail(409, 'A cancelled membership cannot be frozen.');
  if (m.state === 'frozen' || m.freeze_scheduled) throw fail(409, 'This membership is already frozen.');
  const day = await today(db);
  const start = dateText(from) || day;
  const end = dateText(until);
  if (!end) throw fail(400, 'Say when the freeze ends.');
  if (start < day) throw fail(400, 'A freeze cannot start in the past.');
  if (end < start) throw fail(400, 'A freeze must end on or after the day it starts.');
  const length = daysBetween(start, end) + 1;
  const allowed = m.plan ? m.plan.freeze_days_per_year : 0;
  const used = await freezeDaysUsed(db, office, m.id);
  if (!allowed) throw fail(409, `${m.plan ? m.plan.name : 'This plan'} does not allow freezing.`);
  if (used + length > allowed) {
    throw fail(409, `That is ${length} days; ${Math.max(0, allowed - used)} of this plan's ${allowed} freeze days a year are left.`);
  }
  const base = m.membership_expiry || day;
  const expiry = await addDays(db, base, length);
  await db.execute(
    `UPDATE epos_customers
        SET membership_status = 'frozen', frozen_from = ?, frozen_until = ?, membership_expiry = ?
      WHERE id = ? AND email_key = ?`,
    [start, end, expiry, m.id, office]
  );
  await syncFamily(db, office, m.id);
  await logEvent(db, { office, customer_id: m.id, kind: 'freeze', scheme_id: m.scheme_id,
    before: m.membership_expiry, after: expiry, via, by,
    note: `${start} to ${end}${note ? `: ${note}` : ''}` });
  return memberDetail(db, office, id);
}

async function unfreeze(db, office, id, { via = 'backoffice', by = null } = {}) {
  const m = await payerOf(db, office, await requireMember(db, office, id));
  if (m.membership_status !== 'frozen') throw fail(409, 'This membership is not frozen.');
  const day = await today(db);
  // Days of the freeze still to come, which the member did not use.
  const restart = m.frozen_from > day ? m.frozen_from : day;
  const unused = Math.max(0, daysBetween(restart, m.frozen_until) + (m.frozen_from > day ? 1 : 0));
  const expiry = unused > 0 ? await addDays(db, m.membership_expiry, -unused) : m.membership_expiry;
  await db.execute(
    `UPDATE epos_customers
        SET membership_status = 'active', frozen_from = NULL, frozen_until = NULL, membership_expiry = ?
      WHERE id = ? AND email_key = ?`,
    [expiry, m.id, office]
  );
  await syncFamily(db, office, m.id);
  await logEvent(db, { office, customer_id: m.id, kind: 'unfreeze', scheme_id: m.scheme_id,
    before: m.membership_expiry, after: expiry, via, by,
    note: unused ? `${unused} unused day${unused === 1 ? '' : 's'} taken back` : null });
  return memberDetail(db, office, id);
}

/**
 * Cancel. By default the member keeps what they paid for and the card stops
 * at its expiry date; `now` ends it today.
 */
async function cancel(db, office, id, { now = false, note } = {}, { via = 'backoffice', by = null } = {}) {
  const m = await payerOf(db, office, await requireMember(db, office, id));
  if (m.membership_status === 'cancelled') throw fail(409, 'This membership is already cancelled.');
  const day = await today(db);
  const expiry = now ? await addDays(db, day, -1) : m.membership_expiry;
  await db.execute(
    `UPDATE epos_customers
        SET membership_status = 'cancelled', cancelled_on = ?, membership_expiry = ?,
            frozen_from = NULL, frozen_until = NULL
      WHERE id = ? AND email_key = ?`,
    [day, expiry, m.id, office]
  );
  await syncFamily(db, office, m.id);
  await logEvent(db, { office, customer_id: m.id, kind: 'cancel', scheme_id: m.scheme_id,
    before: m.membership_expiry, after: expiry, via, by, note: now ? `Ended today${note ? `: ${note}` : ''}` : note });
  return memberDetail(db, office, id);
}

/** Undo a cancellation, or approve a pending member. */
async function reinstate(db, office, id, { via = 'backoffice', by = null } = {}) {
  const m = await payerOf(db, office, await requireMember(db, office, id));
  if (!['cancelled', 'pending'].includes(m.membership_status)) throw fail(409, 'This membership is already active.');
  const kind = m.membership_status === 'pending' ? 'approve' : 'reinstate';
  await db.execute(
    "UPDATE epos_customers SET membership_status = 'active', cancelled_on = NULL WHERE id = ? AND email_key = ?",
    [m.id, office]
  );
  await syncFamily(db, office, m.id);
  await logEvent(db, { office, customer_id: m.id, kind, scheme_id: m.scheme_id,
    before: m.membership_expiry, after: m.membership_expiry, via, by });
  return memberDetail(db, office, id);
}

async function changePlan(db, office, id, schemeId, { via = 'backoffice', by = null } = {}) {
  const m = await payerOf(db, office, await requireMember(db, office, id));
  const plan = await planById(db, office, schemeId);
  if (!plan) throw fail(400, 'Pick a membership plan.');
  const [[{ n }]] = await db.query(
    'SELECT COUNT(*) AS n FROM epos_customers WHERE email_key = ? AND family_head_id = ?',
    [office, m.id]
  );
  if (Number(n) + 1 > plan.family_size) {
    throw fail(409, `${plan.name} covers ${plan.family_size}; take family members off first.`);
  }
  await db.execute('UPDATE epos_customers SET scheme_id = ? WHERE id = ? AND email_key = ?', [plan.id, m.id, office]);
  await syncFamily(db, office, m.id);
  await logEvent(db, { office, customer_id: m.id, kind: 'plan', scheme_id: plan.id,
    before: m.membership_expiry, after: m.membership_expiry, via, by, note: `${m.plan ? m.plan.name : 'No plan'} to ${plan.name}` });
  return memberDetail(db, office, id);
}

/** Take somebody off a family plan. They stay a customer, with no membership. */
async function leaveFamily(db, office, id, { via = 'backoffice', by = null } = {}) {
  const m = await requireMember(db, office, id);
  if (!m.family_head_id) throw fail(400, 'This member pays for their own membership.');
  await db.execute(
    `UPDATE epos_customers
        SET family_head_id = NULL, membership_status = '', membership_expiry = NULL,
            frozen_from = NULL, frozen_until = NULL
      WHERE id = ? AND email_key = ?`,
    [m.id, office]
  );
  await logEvent(db, { office, customer_id: m.id, kind: 'leave', scheme_id: m.scheme_id,
    before: m.membership_expiry, after: null, via, by, note: 'Taken off the family plan' });
  return memberDetail(db, office, m.family_head_id);
}

/**
 * What the gym door should do with this member, beyond expiry (which gym.js
 * already answers). Null lets them in.
 */
function doorRefusal(m, day) {
  const state = stateOf(m, day);
  if (state === 'frozen') return { reason: 'frozen', message: `Membership frozen until ${m.frozen_until}` };
  if (state === 'pending') return { reason: 'pending', message: 'Membership waiting for approval' };
  if (state === 'cancelled' && m.membership_expiry && m.membership_expiry < day) {
    return { reason: 'cancelled', message: 'Membership cancelled' };
  }
  if (m.plan && !m.plan.includes_gym) return { reason: 'no_gym', message: `${m.plan.name} does not include the gym` };
  return null;
}

/**
 * The gym door's question, for one card holder: refuse them for anything
 * beyond expiry? Null for a venue without Memberships, for a customer who
 * never joined a plan (the door has always let them in), and when anything
 * here fails -- a door that throws is worse than one that only checks expiry.
 */
async function doorCheck(db, office, customerId) {
  try {
    if (!(await moduleOn(db, office, 'memberships'))) return null;
    await sweepFreezes(db, office);
    const m = await memberById(db, office, customerId);
    if (!m || !m.membership_status) return null;
    return doorRefusal(m, await today(db));
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Classes
// ---------------------------------------------------------------------------

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function cleanClass(body) {
  const name = String(body.name || '').trim().slice(0, 80);
  if (!name) throw fail(400, 'A class needs a name.');
  const int = (v, lo, hi, d, label) => {
    if (v === undefined || v === null || v === '') return d;
    const n = Math.round(Number(v));
    if (!Number.isFinite(n) || n < lo || n > hi) throw fail(400, `${label} must be from ${lo} to ${hi}.`);
    return n;
  };
  return {
    name,
    description: String(body.description || '').trim().slice(0, 500) || null,
    colour: /^#[0-9a-f]{6}$/i.test(String(body.colour || '')) ? String(body.colour) : '#a5c715',
    duration_min: int(body.duration_min, 5, 600, 60, 'Minutes'),
    capacity: int(body.capacity, 1, 500, 20, 'Places'),
    instructor: String(body.instructor || '').trim().slice(0, 80) || null,
    room: String(body.room || '').trim().slice(0, 80) || null,
    drop_in_minor: body.drop_in_minor === '' || body.drop_in_minor == null
      ? null : int(body.drop_in_minor, 0, 1_000_000, null, 'The drop-in price'),
    active: body.active === undefined || body.active ? 1 : 0,
  };
}

function cleanSlot(body) {
  const weekday = Math.round(Number(body.weekday));
  if (!(weekday >= 1 && weekday <= 7)) throw fail(400, 'Pick a day of the week.');
  const start = String(body.start_time || '').trim();
  if (!HHMM.test(start)) throw fail(400, 'A start time is like 18:30.');
  const opt = (v, lo, hi, label) => {
    if (v === undefined || v === null || v === '') return null;
    const n = Math.round(Number(v));
    if (!Number.isFinite(n) || n < lo || n > hi) throw fail(400, `${label} must be from ${lo} to ${hi}.`);
    return n;
  };
  return {
    class_id: Math.round(Number(body.class_id)),
    weekday,
    start_time: start,
    duration_min: opt(body.duration_min, 5, 600, 'Minutes'),
    capacity: opt(body.capacity, 1, 500, 'Places'),
    instructor: String(body.instructor || '').trim().slice(0, 80) || null,
    room: String(body.room || '').trim().slice(0, 80) || null,
    starts_on: dateText(body.starts_on),
    ends_on: dateText(body.ends_on),
    active: body.active === undefined || body.active ? 1 : 0,
  };
}

/**
 * Make the sessions the timetable says exist between two days, then read
 * them. INSERT IGNORE against the (timetable_id, starts_at) key, so the same
 * day opened on two screens at once makes each session once.
 */
async function sessionsBetween(db, office, from, to, { customerId = null } = {}) {
  const span = daysBetween(from, to);
  if (span < 0 || span > 62) throw fail(400, 'Ask for at most two months of classes at a time.');
  const [slots] = await db.query(
    `SELECT t.*, k.duration_min AS class_minutes, k.capacity AS class_capacity,
            k.instructor AS class_instructor, k.room AS class_room
       FROM epos_class_timetable t JOIN epos_classes k ON k.id = t.class_id
      WHERE t.office = ? AND t.active = 1 AND k.active = 1`,
    [office]
  );
  for (let i = 0; i <= span; i++) {
    const day = await addDays(db, from, i);
    const iso = ((new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;
    for (const s of slots) {
      if (Number(s.weekday) !== iso) continue;
      if (s.starts_on && dateText(s.starts_on) > day) continue;
      if (s.ends_on && dateText(s.ends_on) < day) continue;
      const minutes = s.duration_min || s.class_minutes;
      await db.execute(
        `INSERT IGNORE INTO epos_class_sessions
           (office, class_id, timetable_id, starts_at, ends_at, capacity, instructor, room)
         VALUES (?, ?, ?, ?, DATE_ADD(?, INTERVAL ? MINUTE), ?, ?, ?)`,
        [office, s.class_id, s.id, `${day} ${s.start_time}:00`, `${day} ${s.start_time}:00`, minutes,
          s.capacity || s.class_capacity, s.instructor || s.class_instructor, s.room || s.class_room]
      );
    }
  }
  const [rows] = await db.query(
    `SELECT s.id, s.class_id, k.name, k.colour, k.description, k.drop_in_minor,
            DATE_FORMAT(s.starts_at, '%Y-%m-%dT%H:%i') AS starts_at,
            DATE_FORMAT(s.ends_at, '%Y-%m-%dT%H:%i') AS ends_at,
            s.capacity, s.instructor, s.room, s.cancelled, s.note,
            (SELECT COUNT(*) FROM epos_class_bookings b WHERE b.session_id = s.id AND b.status IN ('booked','attended')) AS booked,
            (SELECT COUNT(*) FROM epos_class_bookings b WHERE b.session_id = s.id AND b.status = 'waitlist') AS waiting,
            (SELECT COUNT(*) FROM epos_class_bookings b WHERE b.session_id = s.id AND b.status = 'attended') AS attended
            ${customerId ? ', (SELECT b.status FROM epos_class_bookings b WHERE b.session_id = s.id AND b.customer_id = ?) AS my_status' : ''}
       FROM epos_class_sessions s JOIN epos_classes k ON k.id = s.class_id
      WHERE s.office = ? AND s.starts_at >= ? AND s.starts_at < DATE_ADD(?, INTERVAL 1 DAY)
      ORDER BY s.starts_at, k.name`,
    customerId ? [customerId, office, from, to] : [office, from, to]
  );
  return rows.map((r) => ({
    ...r,
    booked: Number(r.booked) || 0,
    waiting: Number(r.waiting) || 0,
    attended: Number(r.attended) || 0,
    cancelled: !!Number(r.cancelled),
    spaces: Math.max(0, Number(r.capacity) - (Number(r.booked) || 0)),
  }));
}

async function sessionById(db, office, id) {
  const [[s]] = await db.query(
    `SELECT s.*, k.name, k.drop_in_minor, DATE_FORMAT(s.starts_at, '%Y-%m-%d') AS day,
            (s.starts_at < NOW()) AS started
       FROM epos_class_sessions s JOIN epos_classes k ON k.id = s.class_id
      WHERE s.id = ? AND s.office = ?`,
    [id, office]
  );
  if (!s) throw fail(404, 'No such class.');
  return s;
}

async function bookingsFor(db, office, sessionId) {
  const [rows] = await db.query(
    `SELECT b.id, b.status, b.via, b.created_at, c.id AS customer_id, c.name, c.member_no, c.photo_url
       FROM epos_class_bookings b JOIN epos_customers c ON c.id = b.customer_id
      WHERE b.office = ? AND b.session_id = ? AND b.status <> 'cancelled'
      ORDER BY FIELD(b.status, 'attended', 'booked', 'waitlist', 'no_show'), b.created_at`,
    [office, sessionId]
  );
  return rows;
}

/**
 * Book a place. A member whose plan includes classes and who has credits left
 * this month gets a place, or the waiting list when the class is full. Anybody
 * else can be booked only as a drop-in, at the till or in the back office,
 * where somebody takes the money; the app refuses them.
 */
async function book(db, office, sessionId, customerId, { via = 'backoffice', dropIn = false } = {}) {
  const s = await sessionById(db, office, sessionId);
  if (Number(s.cancelled)) throw fail(409, 'This class is cancelled.');
  if (Number(s.started) && via === 'app') throw fail(409, 'This class has already started.');
  const m = await memberById(db, office, customerId);
  if (!m) throw fail(404, 'No such customer.');

  const memberOk = ['active'].includes(m.state) && m.plan && m.plan.includes_classes;
  if (!memberOk) {
    if (via === 'app') {
      throw fail(409, m.state === 'frozen' ? 'Your membership is frozen.'
        : m.state === 'expired' ? 'Your membership has expired. Renew it to book.'
          : 'Your membership does not include classes.');
    }
    if (!dropIn) {
      throw fail(409, s.drop_in_minor != null
        ? `Not covered by a membership. Book as a drop-in (${(s.drop_in_minor / 100).toFixed(2)}).`
        : 'This class is for members only.');
    }
    if (s.drop_in_minor == null) throw fail(409, 'This class is for members only.');
  }

  if (memberOk && m.plan.class_credits_per_month != null) {
    const [[{ n }]] = await db.query(
      `SELECT COUNT(*) AS n FROM epos_class_bookings b JOIN epos_class_sessions x ON x.id = b.session_id
        WHERE b.office = ? AND b.customer_id = ? AND b.status IN ('booked','attended','waitlist')
          AND DATE_FORMAT(x.starts_at, '%Y-%m') = DATE_FORMAT(?, '%Y-%m') AND b.session_id <> ?`,
      [office, customerId, s.starts_at, sessionId]
    );
    if (Number(n) >= m.plan.class_credits_per_month) {
      throw fail(409, `${m.plan.name} includes ${m.plan.class_credits_per_month} classes a month, and they are all booked.`);
    }
  }

  const [[existing]] = await db.query(
    'SELECT id, status FROM epos_class_bookings WHERE session_id = ? AND customer_id = ?',
    [sessionId, customerId]
  );
  if (existing && existing.status !== 'cancelled') throw fail(409, `${m.name} is already booked on this class.`);

  const [[{ n: taken }]] = await db.query(
    "SELECT COUNT(*) AS n FROM epos_class_bookings WHERE session_id = ? AND status IN ('booked','attended')",
    [sessionId]
  );
  const status = Number(taken) >= Number(s.capacity) ? 'waitlist' : 'booked';
  if (existing) {
    await db.execute('UPDATE epos_class_bookings SET status = ?, via = ? WHERE id = ?', [status, via, existing.id]);
  } else {
    await db.execute(
      'INSERT INTO epos_class_bookings (office, session_id, customer_id, status, via) VALUES (?,?,?,?,?)',
      [office, sessionId, customerId, status, via]
    );
  }
  return { status, session_id: Number(sessionId), customer_id: customerId, name: m.name };
}

/** Cancel a booking, and give the place to whoever has waited longest. */
async function unbook(db, office, sessionId, customerId) {
  const [r] = await db.execute(
    `UPDATE epos_class_bookings SET status = 'cancelled'
      WHERE office = ? AND session_id = ? AND customer_id = ? AND status IN ('booked','waitlist')`,
    [office, sessionId, customerId]
  );
  if (!r.affectedRows) throw fail(404, 'There is no booking to cancel.');
  const s = await sessionById(db, office, sessionId);
  const [[{ n }]] = await db.query(
    "SELECT COUNT(*) AS n FROM epos_class_bookings WHERE session_id = ? AND status IN ('booked','attended')",
    [sessionId]
  );
  if (Number(n) < Number(s.capacity)) {
    await db.execute(
      `UPDATE epos_class_bookings SET status = 'booked'
        WHERE session_id = ? AND status = 'waitlist' ORDER BY created_at LIMIT 1`,
      [sessionId]
    );
  }
  return { ok: true };
}

/** Arrived. Books them first if they walked in without booking and there is room. */
async function checkIn(db, office, sessionId, customerId, { via = 'till', dropIn = false } = {}) {
  const [[existing]] = await db.query(
    "SELECT id, status FROM epos_class_bookings WHERE session_id = ? AND customer_id = ? AND status <> 'cancelled'",
    [sessionId, customerId]
  );
  if (!existing) {
    const booked = await book(db, office, sessionId, customerId, { via, dropIn });
    if (booked.status === 'waitlist') throw fail(409, 'This class is full.');
  }
  await db.execute(
    "UPDATE epos_class_bookings SET status = 'attended' WHERE session_id = ? AND customer_id = ? AND office = ?",
    [sessionId, customerId, office]
  );
  return { ok: true, status: 'attended' };
}

// ---------------------------------------------------------------------------
// Paying online
// ---------------------------------------------------------------------------

async function paymentKeyFor(db, office) {
  let settings = null;
  try {
    const [[row]] = await db.query('SELECT * FROM epos_express_settings WHERE office = ?', [office]);
    settings = row || null;
  } catch (e) {
    if (!isMissing(e)) throw e;
  }
  const { key, source } = venueKey(settings);
  // The platform's key takes money for Vesopa, not for the venue: only ever
  // the sandbox one, for testing.
  if (source === 'platform' && !dojo.isSandboxKey(key)) return null;
  return key || null;
}

/** What paying online for `kind` costs this member. */
function priceOf(plan, kind) {
  if (!plan) return 0;
  return plan.fee_minor + (kind === 'join' ? plan.joining_fee_minor : 0);
}

async function startCheckout(db, office, customerId, { kind, scheme_id: schemeId }, baseUrl) {
  const m = await memberById(db, office, customerId);
  if (!m) throw fail(404, 'Your membership could not be found.');
  if (m.family_head_id) throw fail(409, 'Your membership is paid by the person whose family plan you are on.');
  let plan;
  if (kind === 'renew') {
    if (!m.membership_status) throw fail(409, 'You are not a member yet.');
    if (m.state === 'cancelled') throw fail(409, 'Your membership is cancelled. Please ask the venue.');
    plan = m.plan;
  } else if (kind === 'join') {
    if (m.membership_status && !['cancelled'].includes(m.membership_status) && m.state !== 'expired') {
      throw fail(409, 'You are already a member.');
    }
    plan = await planById(db, office, schemeId);
    if (!plan || !plan.active || !plan.sell_online) throw fail(400, 'That plan cannot be joined online.');
  } else {
    throw fail(400, 'Join or renew?');
  }
  if (!plan) throw fail(409, 'Your plan is not available online. Please ask the venue.');
  const amount = priceOf(plan, kind);
  if (amount < 50) throw fail(409, 'There is nothing to pay online for this plan.');
  const key = await paymentKeyFor(db, office);
  if (!key) throw fail(409, 'This venue does not take membership payments online yet.');

  const publicId = crypto.randomBytes(16).toString('hex');
  const redirectUrl = `${baseUrl}/membership/paid/${publicId}`;
  const intent = await dojo.createCheckoutIntent(key, {
    amountMinor: amount,
    reference: `member-${publicId.slice(0, 12)}`,
    description: `${plan.name} ${kind === 'join' ? 'membership' : 'renewal'}`,
    redirectUrl,
  });
  await db.execute(
    `INSERT INTO epos_membership_payments
       (public_id, office, customer_id, scheme_id, kind, amount_minor, intent_id)
     VALUES (?,?,?,?,?,?,?)`,
    [publicId, office, customerId, plan.id, kind, amount, intent.id]
  );
  return { url: dojo.checkoutUrl(intent.id), payment_id: publicId, amount_minor: amount };
}

/**
 * Ask Dojo whether a checkout was paid, and if it was, apply it -- once.
 * `applied_at` is claimed with a conditional UPDATE before anything moves, so
 * the return page and a second tab cannot both renew.
 */
async function settleCheckout(db, publicId) {
  const [[p]] = await db.query('SELECT * FROM epos_membership_payments WHERE public_id = ?', [publicId]);
  if (!p) throw fail(404, 'No such payment.');
  if (p.applied_at) return { payment: p, applied: false, already: true };
  const key = await paymentKeyFor(db, p.office);
  if (!key) throw fail(409, 'This venue cannot check payments right now.');
  const intent = await dojo.getIntent(key, p.intent_id);
  if (!dojo.intentPaid(intent)) {
    return { payment: p, applied: false, paid: false, status: intent && intent.status };
  }
  const [claim] = await db.execute(
    `UPDATE epos_membership_payments SET status = 'paid', paid_at = COALESCE(paid_at, NOW()), applied_at = NOW()
      WHERE id = ? AND applied_at IS NULL`,
    [p.id]
  );
  if (!claim.affectedRows) return { payment: p, applied: false, already: true };
  const opts = { via: 'online', by: 'Dojo checkout', amount: p.amount_minor };
  const member = p.kind === 'join'
    ? await join(db, p.office, { customer_id: p.customer_id, scheme_id: p.scheme_id }, opts)
    : await renew(db, p.office, p.customer_id, opts);
  return { payment: p, applied: true, member };
}

// ---------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------

/**
 * Email members whose membership runs out in the next week, once per expiry
 * date, with the way to renew. Run from a timer in server.js; never in tests.
 */
async function sendReminders(db, { days = 7 } = {}) {
  let rows;
  try {
    [rows] = await db.query(
      `SELECT c.id, c.email_key AS office, c.name, c.email,
              DATE_FORMAT(c.membership_expiry, '%Y-%m-%d') AS membership_expiry,
              a.slug, a.enabled AS app_enabled, o.name AS venue
         FROM epos_customers c
         JOIN offices o ON o.contact_email = c.email_key COLLATE utf8mb4_general_ci
         LEFT JOIN epos_loyalty_app a ON a.office = c.email_key COLLATE utf8mb4_general_ci
        WHERE c.membership_status = 'active' AND c.family_head_id IS NULL
          AND c.renewal_reminders = 1 AND c.email IS NOT NULL AND c.email <> ''
          AND c.membership_expiry BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL ? DAY)
          AND (c.reminder_sent_for IS NULL OR c.reminder_sent_for <> c.membership_expiry)
        LIMIT 200`,
      [days]
    );
  } catch (e) {
    if (isMissing(e)) return 0;
    throw e;
  }
  let sent = 0;
  for (const r of rows) {
    if (!(await moduleOn(db, r.office, 'memberships'))) continue;
    const link = r.slug && Number(r.app_enabled) ? appUrl(r.slug) : null;
    const esc = (t) => String(t).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
    const ok = await sendMail({
      to: r.email,
      subject: `Your ${r.venue} membership runs out on ${r.membership_expiry}`,
      text: `Hello ${r.name},\n\nYour membership at ${r.venue} runs out on ${r.membership_expiry}.\n\n`
        + (link ? `Renew in the app: ${link}\n\n` : 'Renew at the desk on your next visit.\n\n')
        + `${r.venue}`,
      html: `<p>Hello ${esc(r.name)},</p><p>Your membership at ${esc(r.venue)} runs out on <b>${esc(r.membership_expiry)}</b>.</p>`
        + (link ? `<p><a href="${esc(link)}">Renew in the app</a></p>` : '<p>Renew at the desk on your next visit.</p>')
        + `<p>${esc(r.venue)}</p>`,
    }).catch(() => false);
    if (ok) {
      sent++;
      await db.execute('UPDATE epos_customers SET reminder_sent_for = membership_expiry WHERE id = ?', [r.id]);
    }
  }
  return sent;
}

// ---------------------------------------------------------------------------
// Partner keys (Metric)
// ---------------------------------------------------------------------------

const hashKey = (key) => crypto.createHash('sha256').update(String(key)).digest('hex');

async function issuePartnerKey(db, office, label, by) {
  const key = `vpk_${crypto.randomBytes(24).toString('base64url')}`;
  await db.execute(
    'INSERT INTO epos_partner_keys (office, label, key_hash, created_by) VALUES (?,?,?,?)',
    [office, String(label || '').slice(0, 80), hashKey(key), by || null]
  );
  return key;
}

/** A member as another system needs one: who, what plan, and may they in. */
async function partnerMember(db, office, m) {
  const day = await today(db);
  return {
    id: m.id,
    vesopa_sub: m.vesopa_sub || null,
    name: m.name,
    email: m.email,
    phone: m.phone,
    member_number: m.member_number || null,
    state: m.state,
    status: m.membership_status,
    plan: m.plan ? { id: m.plan.id, name: m.plan.name, max_vehicles: m.plan.max_vehicles } : null,
    valid_from: m.joined_on,
    valid_to: m.membership_expiry,
    access: !doorRefusal(m, day) && m.state === 'active',
    family_head_id: m.family_head_id || null,
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

function membershipRoutes({ pool, broadcast, secret }) {
  const router = express.Router();
  const auth = requireAuth(secret);
  const terminal = requireTerminal(secret);
  const json = express.json({ limit: '64kb' });

  const send = (res, next) => (e) =>
    (e && e.status ? res.status(e.status).json({ error: e.message }) : next(e));

  /**
   * A partner (Metric's server) is told what actually went wrong. Its staff
   * see this on their console's EPOS bar, which is the only place a fault on
   * this side shows up for them: a bare "internal error" left them, and us,
   * guessing until somebody could read this server's log.
   */
  const partnerSend = (res, next) => (e) => {
    if (e && e.status) return res.status(e.status).json({ error: e.message });
    console.error('[partner]', e);
    return res.status(500).json({ error: `Vesopa EPOS failed: ${String((e && (e.sqlMessage || e.message)) || e).slice(0, 200)}` });
  };

  const changed = (office) => {
    broadcast({ type: 'memberships', office });
    broadcast({ type: 'customers.updated' });
  };

  async function backOfficeOffice(req) {
    if (req.user.officeId) {
      const [[o]] = await pool.query('SELECT contact_email FROM offices WHERE id = ?', [req.user.officeId]);
      if (o) return o.contact_email;
    }
    return req.user.email;
  }

  /** The venue, and refuse unless Memberships is on there. */
  const venue = (from) => async (req, res, next) => {
    try {
      const office = from === 'till' ? req.office : await backOfficeOffice(req);
      if (!(await moduleOn(pool, office, 'memberships'))) {
        return res.status(404).json({ error: 'Memberships are not switched on for this venue.' });
      }
      req.venue = office;
      next();
    } catch (e) { next(e); }
  };
  const bo = [auth, venue('backoffice')];
  const till = [terminal, venue('till')];
  const who = (req) => (req.user ? req.user.email : (req.terminal && (req.body?.staff || req.terminal.name)) || 'till');

  // A member in the loyalty app. The same token loyalty_app.js issues; the
  // session row is checked so signing out there signs out here.
  async function customer(req, res, next) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    let claims;
    try {
      claims = jwt.verify(token, secret);
    } catch {
      return res.status(401).json({ error: 'Please sign in again.' });
    }
    if (claims.scope !== 'loyalty' || !claims.office || !claims.cid || !claims.jti) {
      return res.status(401).json({ error: 'Please sign in again.' });
    }
    try {
      const [[row]] = await pool.query(
        'SELECT revoked_at FROM epos_loyalty_app_sessions WHERE id = ? AND office = ?',
        [claims.jti, claims.office]
      );
      if (!row || row.revoked_at) return res.status(401).json({ error: 'You have been signed out. Please sign in again.' });
      if (!(await moduleOn(pool, claims.office, 'memberships'))) {
        return res.status(404).json({ error: 'Memberships are not offered here.' });
      }
    } catch (e) { return next(e); }
    req.venue = claims.office;
    req.customerId = claims.cid;
    next();
  }

  async function partner(req, res, next) {
    const header = req.headers.authorization || '';
    const key = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!key.startsWith('vpk_')) return res.status(401).json({ error: 'A partner key is required.' });
    try {
      const [[row]] = await pool.query(
        'SELECT id, office FROM epos_partner_keys WHERE key_hash = ? AND revoked_at IS NULL',
        [hashKey(key)]
      );
      if (!row) return res.status(401).json({ error: 'That partner key is not valid.' });
      if (!(await moduleOn(pool, row.office, 'memberships'))) {
        return res.status(404).json({ error: 'Memberships are not switched on for this venue.' });
      }
      pool.execute('UPDATE epos_partner_keys SET last_used_at = NOW() WHERE id = ?', [row.id]).catch(() => {});
      req.venue = row.office;
      next();
    } catch (e) { next(e); }
  }

  const baseUrl = (req) =>
    String(process.env.BACKOFFICE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');

  // ---- Shared handlers ---------------------------------------------------

  const handlers = (via) => ({
    plans: async (req, res, next) => {
      try { res.json(await plansFor(pool, req.venue)); } catch (e) { next(e); }
    },
    member: async (req, res, next) => {
      try {
        const m = await memberDetail(pool, req.venue, req.params.id);
        if (!m) return res.status(404).json({ error: 'No such member.' });
        res.json(m);
      } catch (e) { next(e); }
    },
    join: async (req, res, next) => {
      try {
        const m = await join(pool, req.venue, req.body || {},
          { via, by: who(req), amount: req.body?.amount_minor ?? null });
        changed(req.venue);
        res.status(201).json(m);
      } catch (e) { send(res, next)(e); }
    },
    renew: async (req, res, next) => {
      try {
        const m = await renew(pool, req.venue, req.params.id,
          { via, by: who(req), amount: req.body?.amount_minor ?? null });
        changed(req.venue);
        res.json(m);
      } catch (e) { send(res, next)(e); }
    },
    freeze: async (req, res, next) => {
      try {
        const m = await freeze(pool, req.venue, req.params.id, req.body || {}, { via, by: who(req) });
        changed(req.venue);
        res.json(m);
      } catch (e) { send(res, next)(e); }
    },
    unfreeze: async (req, res, next) => {
      try {
        const m = await unfreeze(pool, req.venue, req.params.id, { via, by: who(req) });
        changed(req.venue);
        res.json(m);
      } catch (e) { send(res, next)(e); }
    },
    cancel: async (req, res, next) => {
      try {
        const m = await cancel(pool, req.venue, req.params.id, req.body || {}, { via, by: who(req) });
        changed(req.venue);
        res.json(m);
      } catch (e) { send(res, next)(e); }
    },
    reinstate: async (req, res, next) => {
      try {
        const m = await reinstate(pool, req.venue, req.params.id, { via, by: who(req) });
        changed(req.venue);
        res.json(m);
      } catch (e) { send(res, next)(e); }
    },
    sessions: async (req, res, next) => {
      try {
        const day = await today(pool);
        const from = dateText(req.query.from) || day;
        const to = dateText(req.query.to) || from;
        res.json(await sessionsBetween(pool, req.venue, from, to));
      } catch (e) { send(res, next)(e); }
    },
    session: async (req, res, next) => {
      try {
        const s = await sessionById(pool, req.venue, req.params.id);
        res.json({ ...s, bookings: await bookingsFor(pool, req.venue, s.id) });
      } catch (e) { send(res, next)(e); }
    },
    book: async (req, res, next) => {
      try {
        const r = await book(pool, req.venue, req.params.id, String(req.body?.customer_id || ''),
          { via, dropIn: !!req.body?.drop_in });
        broadcast({ type: 'classes', office: req.venue });
        res.status(201).json(r);
      } catch (e) { send(res, next)(e); }
    },
    unbook: async (req, res, next) => {
      try {
        const r = await unbook(pool, req.venue, req.params.id, String(req.body?.customer_id || ''));
        broadcast({ type: 'classes', office: req.venue });
        res.json(r);
      } catch (e) { send(res, next)(e); }
    },
    checkin: async (req, res, next) => {
      try {
        const r = await checkIn(pool, req.venue, req.params.id, String(req.body?.customer_id || ''),
          { via, dropIn: !!req.body?.drop_in });
        broadcast({ type: 'classes', office: req.venue });
        res.json(r);
      } catch (e) { send(res, next)(e); }
    },
  });

  // ---- Back office ---------------------------------------------------------

  const B = handlers('backoffice');
  router.get('/api/memberships/summary', ...bo, async (req, res, next) => {
    try { res.json(await summary(pool, req.venue)); } catch (e) { next(e); }
  });
  router.get('/api/memberships/plans', ...bo, B.plans);
  router.get('/api/memberships/members', ...bo, async (req, res, next) => {
    try {
      res.json(await listMembers(pool, req.venue, {
        state: req.query.state || null, plan: req.query.plan || null, q: req.query.q || null,
      }));
    } catch (e) { next(e); }
  });
  router.get('/api/memberships/members/:id', ...bo, B.member);
  router.post('/api/memberships/members', ...bo, json, B.join);
  router.post('/api/memberships/members/:id/renew', ...bo, json, B.renew);
  router.post('/api/memberships/members/:id/freeze', ...bo, json, B.freeze);
  router.post('/api/memberships/members/:id/unfreeze', ...bo, json, B.unfreeze);
  router.post('/api/memberships/members/:id/cancel', ...bo, json, B.cancel);
  router.post('/api/memberships/members/:id/reinstate', ...bo, json, B.reinstate);
  router.post('/api/memberships/members/:id/plan', ...bo, json, async (req, res, next) => {
    try {
      const m = await changePlan(pool, req.venue, req.params.id, req.body?.scheme_id, { by: who(req) });
      changed(req.venue);
      res.json(m);
    } catch (e) { send(res, next)(e); }
  });
  router.post('/api/memberships/members/:id/leave-family', ...bo, json, async (req, res, next) => {
    try {
      const m = await leaveFamily(pool, req.venue, req.params.id, { by: who(req) });
      changed(req.venue);
      res.json(m);
    } catch (e) { send(res, next)(e); }
  });
  router.put('/api/memberships/members/:id/reminders', ...bo, json, async (req, res, next) => {
    try {
      await pool.execute('UPDATE epos_customers SET renewal_reminders = ? WHERE id = ? AND email_key = ?',
        [req.body?.on ? 1 : 0, req.params.id, req.venue]);
      res.json(await memberDetail(pool, req.venue, req.params.id));
    } catch (e) { next(e); }
  });
  router.get('/api/memberships/payments', ...bo, async (req, res, next) => {
    try {
      const [rows] = await pool.query(
        `SELECT p.public_id, p.kind, p.amount_minor, p.status, p.created_at, p.paid_at,
                c.name, s.name AS plan_name
           FROM epos_membership_payments p
           LEFT JOIN epos_customers c ON c.id = p.customer_id
           LEFT JOIN epos_loyalty_schemes s ON s.id = p.scheme_id
          WHERE p.office = ? ORDER BY p.created_at DESC LIMIT 300`,
        [req.venue]
      );
      res.json(rows);
    } catch (e) { next(e); }
  });

  // Classes and the weekly timetable.
  router.get('/api/classes', ...bo, async (req, res, next) => {
    try {
      const [classes] = await pool.query('SELECT * FROM epos_classes WHERE office = ? ORDER BY active DESC, name', [req.venue]);
      const [slots] = await pool.query(
        `SELECT t.*, DATE_FORMAT(t.starts_on, '%Y-%m-%d') AS starts_on, DATE_FORMAT(t.ends_on, '%Y-%m-%d') AS ends_on
           FROM epos_class_timetable t WHERE t.office = ? ORDER BY t.weekday, t.start_time`,
        [req.venue]
      );
      res.json({ classes, timetable: slots });
    } catch (e) { next(e); }
  });
  router.post('/api/classes', ...bo, json, async (req, res, next) => {
    try {
      const v = cleanClass(req.body || {});
      const cols = Object.keys(v);
      const [r] = await pool.execute(
        `INSERT INTO epos_classes (office, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`,
        [req.venue, ...cols.map((c) => v[c])]
      );
      broadcast({ type: 'classes', office: req.venue });
      res.status(201).json({ id: r.insertId, ...v });
    } catch (e) { send(res, next)(e); }
  });
  router.put('/api/classes/:id', ...bo, json, async (req, res, next) => {
    try {
      const v = cleanClass(req.body || {});
      const cols = Object.keys(v);
      const [r] = await pool.execute(
        `UPDATE epos_classes SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ? AND office = ?`,
        [...cols.map((c) => v[c]), req.params.id, req.venue]
      );
      if (!r.affectedRows) return res.status(404).json({ error: 'No such class.' });
      broadcast({ type: 'classes', office: req.venue });
      res.json({ id: Number(req.params.id), ...v });
    } catch (e) { send(res, next)(e); }
  });
  router.post('/api/classes/timetable', ...bo, json, async (req, res, next) => {
    try {
      const v = cleanSlot(req.body || {});
      const [[k]] = await pool.query('SELECT id FROM epos_classes WHERE id = ? AND office = ?', [v.class_id, req.venue]);
      if (!k) throw fail(400, 'Pick a class.');
      const cols = Object.keys(v);
      const [r] = await pool.execute(
        `INSERT INTO epos_class_timetable (office, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`,
        [req.venue, ...cols.map((c) => v[c])]
      );
      broadcast({ type: 'classes', office: req.venue });
      res.status(201).json({ id: r.insertId, ...v });
    } catch (e) { send(res, next)(e); }
  });
  router.put('/api/classes/timetable/:id', ...bo, json, async (req, res, next) => {
    try {
      const v = cleanSlot(req.body || {});
      const cols = Object.keys(v);
      const [r] = await pool.execute(
        `UPDATE epos_class_timetable SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ? AND office = ?`,
        [...cols.map((c) => v[c]), req.params.id, req.venue]
      );
      if (!r.affectedRows) return res.status(404).json({ error: 'No such timetable slot.' });
      // Sessions not yet booked follow the new time; booked ones are kept, so
      // nobody's place silently moves.
      await pool.execute(
        `DELETE s FROM epos_class_sessions s
          WHERE s.timetable_id = ? AND s.starts_at > NOW()
            AND NOT EXISTS (SELECT 1 FROM epos_class_bookings b WHERE b.session_id = s.id)`,
        [req.params.id]
      );
      broadcast({ type: 'classes', office: req.venue });
      res.json({ id: Number(req.params.id), ...v });
    } catch (e) { send(res, next)(e); }
  });
  router.post('/api/classes/sessions', ...bo, json, async (req, res, next) => {
    // A one-off session, outside the timetable.
    try {
      const b = req.body || {};
      const [[k]] = await pool.query('SELECT * FROM epos_classes WHERE id = ? AND office = ?', [b.class_id, req.venue]);
      if (!k) throw fail(400, 'Pick a class.');
      const day = dateText(b.date);
      if (!day || !HHMM.test(String(b.start_time || ''))) throw fail(400, 'Give the day and the start time.');
      const starts = `${day} ${b.start_time}:00`;
      const [r] = await pool.execute(
        `INSERT INTO epos_class_sessions (office, class_id, starts_at, ends_at, capacity, instructor, room, note)
         VALUES (?, ?, ?, DATE_ADD(?, INTERVAL ? MINUTE), ?, ?, ?, ?)`,
        [req.venue, k.id, starts, starts, Number(b.duration_min) || k.duration_min,
          Number(b.capacity) || k.capacity, b.instructor || k.instructor, b.room || k.room,
          String(b.note || '').slice(0, 190) || null]
      );
      broadcast({ type: 'classes', office: req.venue });
      res.status(201).json({ id: r.insertId });
    } catch (e) { send(res, next)(e); }
  });
  router.post('/api/classes/sessions/:id/cancel', ...bo, json, async (req, res, next) => {
    try {
      const [r] = await pool.execute(
        'UPDATE epos_class_sessions SET cancelled = ?, note = ? WHERE id = ? AND office = ?',
        [req.body?.restore ? 0 : 1, String(req.body?.note || '').slice(0, 190) || null, req.params.id, req.venue]
      );
      if (!r.affectedRows) return res.status(404).json({ error: 'No such class.' });
      broadcast({ type: 'classes', office: req.venue });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });
  router.get('/api/classes/sessions', ...bo, B.sessions);
  router.get('/api/classes/sessions/:id', ...bo, B.session);
  router.post('/api/classes/sessions/:id/book', ...bo, json, B.book);
  router.post('/api/classes/sessions/:id/unbook', ...bo, json, B.unbook);
  router.post('/api/classes/sessions/:id/checkin', ...bo, json, B.checkin);

  // ---- Till ----------------------------------------------------------------

  const T = handlers('till');
  router.get('/till/memberships/plans', ...till, T.plans);
  router.get('/till/memberships/members', ...till, async (req, res, next) => {
    try {
      res.json(await listMembers(pool, req.venue, { q: req.query.q || null, state: req.query.state || null, limit: 200 }));
    } catch (e) { next(e); }
  });
  router.get('/till/memberships/members/:id', ...till, T.member);
  router.post('/till/memberships/members', ...till, json, T.join);
  router.post('/till/memberships/members/:id/renew', ...till, json, T.renew);
  router.post('/till/memberships/members/:id/freeze', ...till, json, T.freeze);
  router.post('/till/memberships/members/:id/unfreeze', ...till, json, T.unfreeze);
  router.post('/till/memberships/members/:id/cancel', ...till, json, T.cancel);
  router.post('/till/memberships/members/:id/reinstate', ...till, json, T.reinstate);
  router.get('/till/classes/sessions', ...till, T.sessions);
  router.get('/till/classes/sessions/:id', ...till, T.session);
  router.post('/till/classes/sessions/:id/book', ...till, json, T.book);
  router.post('/till/classes/sessions/:id/unbook', ...till, json, T.unbook);
  router.post('/till/classes/sessions/:id/checkin', ...till, json, T.checkin);

  // ---- The member, in the loyalty app --------------------------------------

  router.get('/loyalty/v1/me/membership', customer, async (req, res, next) => {
    try {
      const m = await memberDetail(pool, req.venue, req.customerId);
      if (!m) return res.status(404).json({ error: 'Your membership could not be found.' });
      const plans = (await plansFor(pool, req.venue, { activeOnly: true })).filter((p) => p.sell_online);
      const online = !!(await paymentKeyFor(pool, req.venue));
      const payer = !m.family_head_id;
      res.json({
        state: m.state,
        plan: m.plan,
        expiry: m.membership_expiry,
        days_left: m.days_left,
        joined_on: m.joined_on,
        frozen_from: m.frozen_from,
        frozen_until: m.frozen_until,
        member_number: m.member_number || null,
        family: m.family,
        payer,
        renew_minor: payer && m.plan ? priceOf(m.plan, 'renew') : null,
        can_pay_online: online && payer,
        plans_for_sale: m.state === 'none' || m.state === 'cancelled' || m.state === 'expired'
          ? plans.map((p) => ({ ...p, join_minor: priceOf(p, 'join') }))
          : [],
        history: m.history.slice(0, 20).map((h) => ({ kind: h.kind, at: h.created_at, expiry_after: h.expiry_after, amount_minor: h.amount_minor })),
      });
    } catch (e) { next(e); }
  });
  router.post('/loyalty/v1/me/membership/checkout', customer, json, async (req, res, next) => {
    try {
      res.status(201).json(await startCheckout(pool, req.venue, req.customerId, req.body || {}, baseUrl(req)));
    } catch (e) { send(res, next)(e); }
  });
  router.post('/loyalty/v1/me/membership/checkout/:paymentId/check', customer, async (req, res, next) => {
    try {
      const [[p]] = await pool.query(
        'SELECT public_id FROM epos_membership_payments WHERE public_id = ? AND customer_id = ?',
        [req.params.paymentId, req.customerId]
      );
      if (!p) return res.status(404).json({ error: 'No such payment.' });
      const r = await settleCheckout(pool, p.public_id);
      if (r.applied) changed(req.venue);
      res.json({ paid: !!(r.applied || r.already), applied: !!r.applied });
    } catch (e) { send(res, next)(e); }
  });
  router.get('/loyalty/v1/me/classes', customer, async (req, res, next) => {
    try {
      const day = await today(pool);
      const to = await addDays(pool, day, Math.min(Math.max(Number(req.query.days) || 14, 1), 31));
      const list = await sessionsBetween(pool, req.venue, day, to, { customerId: req.customerId });
      res.json(list.filter((s) => !s.cancelled || s.my_status));
    } catch (e) { send(res, next)(e); }
  });
  router.post('/loyalty/v1/me/classes/:id/book', customer, async (req, res, next) => {
    try {
      const r = await book(pool, req.venue, req.params.id, req.customerId, { via: 'app' });
      broadcast({ type: 'classes', office: req.venue });
      res.status(201).json(r);
    } catch (e) { send(res, next)(e); }
  });
  router.post('/loyalty/v1/me/classes/:id/cancel', customer, async (req, res, next) => {
    try {
      const r = await unbook(pool, req.venue, req.params.id, req.customerId);
      broadcast({ type: 'classes', office: req.venue });
      res.json(r);
    } catch (e) { send(res, next)(e); }
  });

  /**
   * Where Dojo sends the member back. The redirect proves nothing; the intent
   * is asked. A small page either way, with the way back to the app.
   */
  router.get('/membership/paid/:paymentId', async (req, res) => {
    let title = 'Payment received';
    let body = 'Thank you. Your membership has been updated. You can close this page and go back to the app.';
    let back = null;
    try {
      const r = await settleCheckout(pool, req.params.paymentId);
      const [[app]] = await pool.query('SELECT slug, enabled FROM epos_loyalty_app WHERE office = ?', [r.payment.office]).catch(() => [[null]]);
      back = app && app.slug ? appUrl(app.slug) : null;
      if (r.applied) {
        changed(r.payment.office);
        body = `Thank you. Your membership now runs to ${r.member.membership_expiry}.`;
      } else if (!r.already) {
        title = 'Payment not finished';
        body = 'We have not received this payment yet. If you paid, it will show in the app shortly; otherwise you can try again from the app.';
      }
    } catch (e) {
      title = 'Something went wrong';
      body = e.status === 404 ? 'We could not find this payment.' : 'We could not check this payment just now. Please open the app to see your membership.';
    }
    const esc = (t) => String(t).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
    res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font-family:system-ui,sans-serif;background:#f5f4f7;color:#17141c;margin:0;display:grid;place-items:center;min-height:100vh;padding:16px}
main{background:#fff;border-radius:16px;padding:28px;max-width:420px;box-shadow:0 2px 12px rgba(0,0,0,.06)}
h1{font-size:20px;margin:0 0 8px}a{display:inline-block;margin-top:16px;background:#a5c715;color:#10130a;padding:10px 16px;border-radius:10px;text-decoration:none;font-weight:600}
@media (prefers-color-scheme:dark){body{background:#121014;color:#f1eff4}main{background:#1d1a21}}</style></head>
<body><main><h1>${esc(title)}</h1><p>${esc(body)}</p>${back ? `<a href="${esc(back)}">Back to the app</a>` : ''}</main></body></html>`);
  });

  // ---- Partner (Metric) ----------------------------------------------------

  router.get('/partner/v1/memberships/plans', partner, async (req, res, next) => {
    try { res.json(await plansFor(pool, req.venue)); } catch (e) { partnerSend(res, next)(e); }
  });
  router.get('/partner/v1/memberships/members', partner, async (req, res, next) => {
    try {
      const list = await listMembers(pool, req.venue, { limit: 2000 });
      const out = [];
      for (const m of list) out.push(await partnerMember(pool, req.venue, m));
      res.json(out);
    } catch (e) { partnerSend(res, next)(e); }
  });
  /**
   * Somebody signed up in the partner's app. Found by their Vesopa account (or
   * email) and joined to a plan, pending until the venue approves them -- or
   * updated, if they are already here.
   */
  router.post('/partner/v1/memberships/members', partner, json, async (req, res, next) => {
    try {
      const b = req.body || {};
      const sub = String(b.vesopa_sub || '').slice(0, 64) || null;
      const email = String(b.email || '').trim().toLowerCase().slice(0, 255) || null;
      let [[c]] = sub
        ? await pool.query('SELECT id FROM epos_customers WHERE email_key = ? AND vesopa_sub = ? LIMIT 1', [req.venue, sub])
        : [[null]];
      if (!c && email) {
        [[c]] = await pool.query('SELECT id FROM epos_customers WHERE email_key = ? AND LOWER(email) = ? LIMIT 1', [req.venue, email]);
      }
      let id = c ? c.id : null;
      if (!id) id = await newCustomer(pool, req.venue, { name: b.name || email || 'Member', email, phone: b.phone });
      await pool.execute(
        `UPDATE epos_customers SET vesopa_sub = COALESCE(vesopa_sub, ?),
                name = COALESCE(NULLIF(?, ''), name), phone = COALESCE(NULLIF(?, ''), phone)
          WHERE id = ? AND email_key = ?`,
        [sub, String(b.name || '').slice(0, 255), String(b.phone || '').slice(0, 64), id, req.venue]
      );
      let m = await memberById(pool, req.venue, id);
      if (!m.membership_status) {
        const planId = b.scheme_id || ((await plansFor(pool, req.venue, { activeOnly: true }))[0] || {}).id;
        await join(pool, req.venue, { customer_id: id, scheme_id: planId, status: b.status === 'active' ? 'active' : 'pending' },
          { via: 'partner', by: String(b.by || 'partner').slice(0, 190) });
        m = await memberById(pool, req.venue, id);
      }
      changed(req.venue);
      res.status(201).json(await partnerMember(pool, req.venue, m));
    } catch (e) { partnerSend(res, next)(e); }
  });
  /** The partner's staff approving, suspending or closing a member. */
  router.post('/partner/v1/memberships/members/:id/:action', partner, json, async (req, res, next) => {
    try {
      const by = String(req.body?.by || 'partner').slice(0, 190);
      const opts = { via: 'partner', by };
      const id = req.params.id;
      let m;
      switch (req.params.action) {
        case 'approve': m = await reinstate(pool, req.venue, id, opts); break;
        case 'renew': m = await renew(pool, req.venue, id, opts); break;
        case 'cancel': m = await cancel(pool, req.venue, id, { now: !!req.body?.now }, opts); break;
        case 'suspend': m = await cancel(pool, req.venue, id, { now: true, note: 'Suspended' }, opts); break;
        case 'plan': m = await changePlan(pool, req.venue, id, req.body?.scheme_id, opts); break;
        default: return res.status(404).json({ error: 'No such action.' });
      }
      changed(req.venue);
      res.json(await partnerMember(pool, req.venue, m));
    } catch (e) { partnerSend(res, next)(e); }
  });

  // ---- Admin: partner keys --------------------------------------------------

  const admin = (req, res, nx) => (req.user?.role === 'admin' ? nx() : res.status(403).json({ error: 'Administrator access only' }));
  router.get('/api/admin/offices/:id/partner-keys', auth, admin, async (req, res, next) => {
    try {
      const [[o]] = await pool.query('SELECT contact_email FROM offices WHERE id = ?', [req.params.id]);
      if (!o) return res.status(404).json({ error: 'No such office.' });
      const [rows] = await pool.query(
        'SELECT id, label, created_by, created_at, last_used_at, revoked_at FROM epos_partner_keys WHERE office = ? ORDER BY created_at DESC',
        [o.contact_email]
      );
      res.json(rows);
    } catch (e) { next(e); }
  });
  router.post('/api/admin/offices/:id/partner-keys', auth, admin, json, async (req, res, next) => {
    try {
      const [[o]] = await pool.query('SELECT contact_email FROM offices WHERE id = ?', [req.params.id]);
      if (!o) return res.status(404).json({ error: 'No such office.' });
      const key = await issuePartnerKey(pool, o.contact_email, req.body?.label || 'Metric Membership', req.user.email);
      res.status(201).json({ key });
    } catch (e) { next(e); }
  });
  router.post('/api/admin/partner-keys/:id/revoke', auth, admin, async (req, res, next) => {
    try {
      await pool.execute('UPDATE epos_partner_keys SET revoked_at = NOW() WHERE id = ? AND revoked_at IS NULL', [req.params.id]);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  return router;
}

module.exports = {
  STATES,
  membershipRoutes,
  plansFor,
  describePlan,
  memberById,
  memberDetail,
  listMembers,
  join,
  renew,
  freeze,
  unfreeze,
  cancel,
  reinstate,
  changePlan,
  leaveFamily,
  logEvent,
  syncFamily,
  stateOf,
  doorRefusal,
  doorCheck,
  sessionsBetween,
  book,
  unbook,
  checkIn,
  startCheckout,
  settleCheckout,
  sendReminders,
  issuePartnerKey,
  forgetMemberColumns,
};
