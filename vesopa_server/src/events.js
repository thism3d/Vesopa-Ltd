const crypto = require('crypto');
const express = require('express');
const PDFDocument = require('pdfkit');
const { requireAuth, requireTerminal } = require('./auth');
const { moduleOn } = require('./modules');
const dojo = require('./dojo_client');
const { paymentKeyFor } = require('./memberships');
const { sendMail } = require('./mailer');
const QR = require('./qr');

/**
 * Events & tickets: matches and events, tickets bought online, the gate.
 *
 * The Events & tickets module (src/modules.js). Asked for by Pontardawe RFC
 * (2026-10-11): tickets for home matches and club events bought on
 * pontardawerfc.com, managed by the club in the back office, scanned at the
 * gate by the till. Everything below refuses with 404 while the module is not
 * on for the venue, as Memberships does.
 *
 * FOUR WAYS IN
 *
 *   /api/events/*                    the back office (session token)
 *   /till/events/*                   a till at the gate (terminal token)
 *   /api/public/events/:slug/*       the venue's website: list, buy, the
 *                                    order page Dojo sends the buyer back to
 *   /api/public/events/ticket/:code  a ticket's QR, as an SVG
 *
 * The website is told its venue by the same slug its menu uses
 * (dinein_venue.slug, "pontardawe-rfc"). CORS is the server-wide cors() in
 * server.js, which already answers any origin; what keeps a checkout honest is
 * that Dojo only ever sends the buyer back to one of the venue's own websites
 * (epos_event_settings.site_origins), never to an address the request names.
 *
 * MONEY
 *
 * Paid on Dojo's hosted checkout with the venue's own Dojo key, exactly as a
 * membership is paid online (memberships.js, paymentKeyFor). The order moves
 * to paid only when the intent itself says so; `applied_at` is claimed with a
 * conditional UPDATE so the tickets are made and emailed once, however many
 * times the return page is opened. Tickets issued in the back office (a
 * complimentary ticket, or one paid for at the bar) are paid orders with
 * source 'backoffice'.
 *
 * THE TICKET
 *
 * Ten characters of base32, carried by its QR as "VT:<code>". The till scans
 * it, or a steward types it; checking in is one conditional UPDATE, so the
 * same ticket at two gates gets in once and the second is told when.
 */

const KINDS = ['match', 'event'];
const STATUSES = ['pending', 'paid', 'failed', 'refunded'];
// A pending order holds its tickets this long while the buyer is on the card
// page; after it, an unfinished checkout stops counting against capacity.
const HOLD_MINUTES = 30;

/**
 * What a venue gets before it has saved settings of its own. Keyed by the
 * back office office id. Pontardawe RFC is office 35 and club 165 on the WRU.
 */
const DEFAULTS = {
  35: {
    wru_org_id: 165,
    home_name: 'Pontardawe',
    site_origins: ['https://pontardawerfc.com', 'https://www.pontardawerfc.com'],
  },
};

const WRU_FIXTURES = 'https://api.wru.wales/fixtures-results/organisation-fixtures';

const isMissing = (e) =>
  e && (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR');

function fail(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// ---------------------------------------------------------------------------
// Time. Every time here is UK wall-clock, whatever the server's zone.
// ---------------------------------------------------------------------------

/** Now in the UK as "YYYY-MM-DD HH:MM:SS". */
function ukNow(at = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(at).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

/** The UK date `days` from today, "YYYY-MM-DD". */
const ukDay = (days = 0) => ukNow(new Date(Date.now() + days * 86400000)).slice(0, 10);

/** "2026-10-17T14:30" or "2026-10-17 14:30:00" to "2026-10-17 14:30:00"; null if not a time. */
function cleanDateTime(v) {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(v ?? '').trim());
  if (!m) return null;
  const [, day, hh, mm, ss] = m;
  if (Number(hh) > 23 || Number(mm) > 59) return null;
  if (Number.isNaN(Date.parse(`${day}T00:00:00Z`))) return null;
  return `${day} ${hh}:${mm}:${ss || '00'}`;
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September',
  'October', 'November', 'December'];

/** "Saturday 17 October 2026, 2:30pm", from a stored wall-clock time. */
function whenText(t) {
  const s = cleanDateTime(t);
  if (!s) return '';
  const d = new Date(`${s.replace(' ', 'T')}Z`);
  // Spelt out rather than toLocaleDateString, whose commas differ between
  // ICU builds -- and so between the server and a developer's laptop.
  const day = `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  const h = d.getUTCHours();
  const m = d.getUTCMinutes();
  return `${day}, ${h % 12 || 12}${m ? `:${String(m).padStart(2, '0')}` : ''}${h < 12 ? 'am' : 'pm'}`;
}

const SQL_MINUTE = "'%Y-%m-%dT%H:%i'";

// ---------------------------------------------------------------------------
// Cleaning what is sent
// ---------------------------------------------------------------------------

const text = (v, max) => {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, max) : null;
};
const flag = (v) => (v === true || v === 1 || v === '1' || v === 'true' || v === 'on' ? 1 : 0);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function cleanEvent(body, { partial = false } = {}) {
  const b = body || {};
  const has = (f) => Object.prototype.hasOwnProperty.call(b, f);
  const out = {};
  if (!partial || has('title')) {
    out.title = text(b.title, 160);
    if (!out.title) throw fail(400, 'Give the event a title.');
  }
  if (!partial || has('kind')) {
    out.kind = KINDS.includes(b.kind) ? b.kind : 'event';
  }
  if (!partial || has('starts_at')) {
    out.starts_at = cleanDateTime(b.starts_at);
    if (!out.starts_at) throw fail(400, 'When does it start?');
  }
  if (!partial || has('ends_at')) {
    out.ends_at = b.ends_at ? cleanDateTime(b.ends_at) : null;
    if (b.ends_at && !out.ends_at) throw fail(400, 'That finish time is not a time.');
  }
  if (out.starts_at && out.ends_at && out.ends_at < out.starts_at) {
    throw fail(400, 'It cannot finish before it starts.');
  }
  if (!partial || has('description')) out.description = text(b.description, 4000);
  if (!partial || has('location')) out.location = text(b.location, 200);
  if (!partial || has('image_url')) {
    out.image_url = text(b.image_url, 500);
    if (out.image_url && !/^https:\/\//i.test(out.image_url)) throw fail(400, 'The picture must be an https:// address.');
  }
  if (!partial || has('on_sale')) out.on_sale = flag(b.on_sale);
  if (!partial || has('published')) out.published = flag(b.published);
  return out;
}

function cleanTicketType(body) {
  const b = body || {};
  const name = text(b.name, 80);
  if (!name) throw fail(400, 'Name the ticket: Adult, Junior, Member...');
  const price = Math.round(Number(b.price_minor ?? 0));
  if (!Number.isFinite(price) || price < 0 || price > 100000) throw fail(400, 'A ticket costs between £0 and £1,000.');
  let capacity = null;
  if (b.capacity !== null && b.capacity !== undefined && String(b.capacity).trim() !== '') {
    capacity = Math.round(Number(b.capacity));
    if (!Number.isFinite(capacity) || capacity < 0) throw fail(400, 'How many can be sold? Leave it empty for no limit.');
  }
  let max = Math.round(Number(b.max_per_order ?? 10));
  if (!Number.isFinite(max) || max < 1) max = 1;
  if (max > 50) max = 50;
  const sort = Math.round(Number(b.sort ?? 0)) || 0;
  return { name, price_minor: price, capacity, max_per_order: max, sort };
}

// ---------------------------------------------------------------------------
// Ticket codes
// ---------------------------------------------------------------------------

// Base32 without 0/O and 1/I, so a code read off a cracked phone screen and
// typed in by a steward means one thing.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE = /^[A-HJ-NP-Z2-9]{10}$/;

function newCode() {
  return [...crypto.randomBytes(10)].map((b) => ALPHABET[b & 31]).join('');
}

/** A scanned "VT:<code>" or a typed code, as the stored code; null if it cannot be one. */
function parseCode(raw) {
  let s = String(raw ?? '').trim();
  if (/^VT:/i.test(s)) s = s.slice(3);
  s = s.toUpperCase().replace(/[\s-]/g, '');
  return CODE.test(s) ? s : null;
}

const qrPayload = (code) => `VT:${code}`;

// ---------------------------------------------------------------------------
// The venue, its settings and its websites
// ---------------------------------------------------------------------------

/** The venue a website names by its menu slug, if Events & tickets is on there. */
async function venueBySlug(db, slug) {
  const s = String(slug || '').toLowerCase().trim();
  if (!/^[a-z0-9-]{1,64}$/.test(s)) return null;
  const [[v]] = await db.query(
    `SELECT d.office_id, d.display_name, o.name, o.contact_email
       FROM dinein_venue d JOIN offices o ON o.id = d.office_id
      WHERE d.slug = ?`,
    [s]
  ).catch((e) => (isMissing(e) ? [[null]] : Promise.reject(e)));
  if (!v || !v.contact_email) return null;
  if (!(await moduleOn(db, v.contact_email, 'events'))) return null;
  return { officeId: v.office_id, office: v.contact_email, name: String(v.display_name || v.name || '').trim() };
}

/** What a venue is called on a ticket. */
async function venueName(db, office) {
  const [[v]] = await db.query(
    `SELECT o.name, d.display_name FROM offices o LEFT JOIN dinein_venue d ON d.office_id = o.id
      WHERE o.contact_email = ? LIMIT 1`,
    [office]
  ).catch(() => [[null]]);
  return v ? String(v.display_name || v.name || '').trim() : '';
}

const cleanOrigin = (o) => {
  try {
    const u = new URL(String(o).trim());
    return u.protocol === 'https:' ? u.origin : null;
  } catch {
    return null;
  }
};

/** The venue's settings, its own row over the defaults. */
async function settingsFor(db, office) {
  const [[o]] = await db.query('SELECT id FROM offices WHERE contact_email = ? LIMIT 1', [office]).catch(() => [[null]]);
  const base = (o && DEFAULTS[o.id]) || {};
  let row = null;
  try {
    [[row]] = await db.query('SELECT * FROM epos_event_settings WHERE office = ?', [office]);
  } catch (e) {
    if (!isMissing(e)) throw e;
  }
  const own = row || {};
  const origins = own.site_origins
    ? String(own.site_origins).split(/[\s,]+/).map(cleanOrigin).filter(Boolean)
    : (base.site_origins || []);
  return {
    wru_org_id: own.wru_org_id ?? base.wru_org_id ?? null,
    home_name: own.home_name || base.home_name || null,
    site_origins: [...new Set(origins)],
    location: own.location || base.location || null,
  };
}

async function saveSettings(db, office, body) {
  const b = body || {};
  let org = null;
  if (b.wru_org_id !== null && b.wru_org_id !== undefined && String(b.wru_org_id).trim() !== '') {
    org = Number(b.wru_org_id);
    if (!Number.isInteger(org) || org <= 0) throw fail(400, 'The WRU club number is a whole number.');
  }
  const list = Array.isArray(b.site_origins) ? b.site_origins : String(b.site_origins || '').split(/[\s,]+/);
  const origins = [];
  for (const raw of list.filter((x) => String(x).trim())) {
    const o = cleanOrigin(raw);
    if (!o) throw fail(400, `${String(raw).slice(0, 80)} is not an https:// website address.`);
    origins.push(o);
  }
  await db.execute(
    `INSERT INTO epos_event_settings (office, wru_org_id, home_name, site_origins, location)
     VALUES (?,?,?,?,?)
     ON DUPLICATE KEY UPDATE wru_org_id = VALUES(wru_org_id), home_name = VALUES(home_name),
       site_origins = VALUES(site_origins), location = VALUES(location)`,
    [office, org, text(b.home_name, 80), origins.length ? [...new Set(origins)].join(',') : null, text(b.location, 200)]
  );
  return settingsFor(db, office);
}

/**
 * Where Dojo sends the buyer back to: `raw` with ?order=<publicId>, if it is on
 * one of the venue's own websites, else null. Compared by origin, so
 * https://pontardawerfc.com.evil.example and https://user@pontardawerfc.com
 * are both turned away.
 */
function returnUrlFor(raw, origins, publicId) {
  let u;
  try {
    u = new URL(String(raw || ''));
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password) return null;
  if (!(origins || []).map(cleanOrigin).includes(u.origin)) return null;
  u.hash = '';
  u.searchParams.set('order', publicId);
  return u.toString();
}

// ---------------------------------------------------------------------------
// Reading events
// ---------------------------------------------------------------------------

const EVENT_COLUMNS = `e.id, e.office, e.title, e.description, e.kind,
  DATE_FORMAT(e.starts_at, ${SQL_MINUTE}) AS starts_at, DATE_FORMAT(e.ends_at, ${SQL_MINUTE}) AS ends_at,
  e.location, e.image_url, e.on_sale, e.published, e.wru_fixture_id`;

function describeEvent(e) {
  return {
    id: e.id,
    title: e.title,
    description: e.description || null,
    kind: e.kind,
    starts_at: e.starts_at,
    ends_at: e.ends_at || null,
    location: e.location || null,
    image_url: e.image_url || null,
    on_sale: !!Number(e.on_sale),
    published: !!Number(e.published),
    wru_fixture_id: e.wru_fixture_id ?? null,
  };
}

async function eventById(db, office, id) {
  if (!/^\d+$/.test(String(id))) return null;
  const [[e]] = await db.query(`SELECT ${EVENT_COLUMNS} FROM epos_events e WHERE e.id = ? AND e.office = ?`, [id, office]);
  return e || null;
}

async function typesFor(db, eventIds, { lock = false } = {}) {
  if (!eventIds.length) return [];
  const [rows] = await db.query(
    `SELECT id, event_id, name, price_minor, capacity, max_per_order, sort
       FROM epos_event_ticket_types WHERE event_id IN (?) ORDER BY sort, id${lock ? ' FOR UPDATE' : ''}`,
    [eventIds]
  );
  return rows.map((t) => ({
    ...t,
    price_minor: Number(t.price_minor),
    capacity: t.capacity === null ? null : Number(t.capacity),
    max_per_order: Number(t.max_per_order),
  }));
}

const parseItems = (raw) => {
  try {
    const list = JSON.parse(raw || '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
};

/**
 * Tickets spoken for, by ticket type: every paid order, and every pending one
 * younger than HOLD_MINUTES. Read from what the orders asked for rather than
 * from the tickets, so an order paid a moment ago whose tickets are still
 * being written counts all the same.
 */
async function takenFor(db, eventIds) {
  const taken = {};
  if (!eventIds.length) return taken;
  const [rows] = await db.query(
    `SELECT items FROM epos_event_orders
      WHERE event_id IN (?) AND (status = 'paid'
        OR (status = 'pending' AND created_at > NOW() - INTERVAL ${HOLD_MINUTES} MINUTE))`,
    [eventIds]
  );
  for (const r of rows) {
    for (const it of parseItems(r.items)) {
      taken[it.ticket_type_id] = (taken[it.ticket_type_id] || 0) + (Number(it.qty) || 0);
    }
  }
  return taken;
}

const remaining = (t, taken) => (t.capacity === null ? null : Math.max(0, t.capacity - (taken[t.id] || 0)));

/** The website's list: published, from today, soonest first. */
async function publicEvents(db, office) {
  const [rows] = await db.query(
    `SELECT ${EVENT_COLUMNS} FROM epos_events e
      WHERE e.office = ? AND e.published = 1 AND e.starts_at >= ?
      ORDER BY e.starts_at, e.id`,
    [office, `${ukDay()} 00:00:00`]
  );
  const ids = rows.map((e) => e.id);
  const types = await typesFor(db, ids);
  const taken = await takenFor(db, ids);
  return rows.map((e) => {
    const d = describeEvent(e);
    return {
      id: d.id,
      title: d.title,
      description: d.description,
      kind: d.kind,
      starts_at: d.starts_at,
      ends_at: d.ends_at,
      location: d.location,
      image_url: d.image_url,
      on_sale: d.on_sale,
      wru_fixture_id: d.wru_fixture_id,
      ticket_types: types.filter((t) => t.event_id === e.id).map((t) => ({
        id: t.id,
        name: t.name,
        price_minor: t.price_minor,
        remaining: remaining(t, taken),
        max_per_order: t.max_per_order,
      })),
    };
  });
}

/** Sold, checked in and taken, per event and per ticket type. */
async function statsFor(db, eventIds) {
  const out = {};
  if (!eventIds.length) return out;
  const [tickets] = await db.query(
    `SELECT t.event_id, t.ticket_type_id, COUNT(*) AS sold, SUM(t.checked_in_at IS NOT NULL) AS checked_in
       FROM epos_event_tickets t JOIN epos_event_orders o ON o.id = t.order_id
      WHERE t.event_id IN (?) AND o.status = 'paid'
      GROUP BY t.event_id, t.ticket_type_id`,
    [eventIds]
  );
  const [money] = await db.query(
    `SELECT event_id, COUNT(*) AS orders, COALESCE(SUM(total_minor), 0) AS revenue_minor
       FROM epos_event_orders WHERE event_id IN (?) AND status = 'paid' GROUP BY event_id`,
    [eventIds]
  );
  for (const id of eventIds) out[id] = { sold: 0, checked_in: 0, orders: 0, revenue_minor: 0, by_type: {} };
  for (const r of tickets) {
    const s = out[r.event_id];
    s.sold += Number(r.sold);
    s.checked_in += Number(r.checked_in || 0);
    s.by_type[r.ticket_type_id] = { sold: Number(r.sold), checked_in: Number(r.checked_in || 0) };
  }
  for (const r of money) {
    out[r.event_id].orders = Number(r.orders);
    out[r.event_id].revenue_minor = Number(r.revenue_minor);
  }
  return out;
}

/** The back office's list: upcoming (from today, soonest first) or past (latest first). */
async function listEvents(db, office, { when = 'upcoming' } = {}) {
  const today = `${ukDay()} 00:00:00`;
  const [rows] = await db.query(
    when === 'past'
      ? `SELECT ${EVENT_COLUMNS} FROM epos_events e WHERE e.office = ? AND e.starts_at < ? ORDER BY e.starts_at DESC LIMIT 200`
      : `SELECT ${EVENT_COLUMNS} FROM epos_events e WHERE e.office = ? AND e.starts_at >= ? ORDER BY e.starts_at, e.id`,
    [office, today]
  );
  const ids = rows.map((e) => e.id);
  const types = await typesFor(db, ids);
  const taken = await takenFor(db, ids);
  const stats = await statsFor(db, ids);
  return rows.map((e) => {
    const s = stats[e.id];
    return {
      ...describeEvent(e),
      sold: s.sold,
      checked_in: s.checked_in,
      orders: s.orders,
      revenue_minor: s.revenue_minor,
      ticket_types: types.filter((t) => t.event_id === e.id).map((t) => ({
        id: t.id,
        name: t.name,
        price_minor: t.price_minor,
        capacity: t.capacity,
        max_per_order: t.max_per_order,
        sort: t.sort,
        sold: (s.by_type[t.id] || {}).sold || 0,
        checked_in: (s.by_type[t.id] || {}).checked_in || 0,
        remaining: remaining(t, taken),
      })),
    };
  });
}

async function eventDetail(db, office, id) {
  const e = await eventById(db, office, id);
  if (!e) return null;
  const when = e.starts_at < ukDay() ? 'past' : 'upcoming';
  const list = await listEvents(db, office, { when });
  return list.find((x) => x.id === e.id) || { ...describeEvent(e), ticket_types: [] };
}

/** The till's list: yesterday to a week ahead, with the gate's counts. */
async function tillEvents(db, office) {
  const [rows] = await db.query(
    `SELECT ${EVENT_COLUMNS} FROM epos_events e
      WHERE e.office = ? AND e.starts_at >= ? AND e.starts_at < ?
      ORDER BY e.starts_at, e.id`,
    [office, `${ukDay(-1)} 00:00:00`, `${ukDay(8)} 00:00:00`]
  );
  const ids = rows.map((e) => e.id);
  const types = await typesFor(db, ids);
  const stats = await statsFor(db, ids);
  return rows.map((e) => ({
    id: e.id,
    title: e.title,
    starts_at: e.starts_at,
    ticket_types: types.filter((t) => t.event_id === e.id)
      .map((t) => ({ id: t.id, name: t.name, price_minor: t.price_minor })),
    sold: stats[e.id].sold,
    checked_in: stats[e.id].checked_in,
  }));
}

// ---------------------------------------------------------------------------
// Writing events
// ---------------------------------------------------------------------------

async function createEvent(db, office, body, extra = {}) {
  const f = { ...cleanEvent(body), ...extra };
  const [r] = await db.execute(
    `INSERT INTO epos_events (office, title, description, kind, starts_at, ends_at, location, image_url,
       on_sale, published, wru_fixture_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [office, f.title, f.description, f.kind, f.starts_at, f.ends_at, f.location, f.image_url,
      f.on_sale, f.published, f.wru_fixture_id ?? null]
  );
  return r.insertId;
}

async function updateEvent(db, office, id, body) {
  const e = await eventById(db, office, id);
  if (!e) throw fail(404, 'No such event.');
  const f = cleanEvent(body, { partial: true });
  const start = f.starts_at || cleanDateTime(e.starts_at);
  const end = Object.prototype.hasOwnProperty.call(f, 'ends_at') ? f.ends_at : cleanDateTime(e.ends_at);
  if (end && end < start) throw fail(400, 'It cannot finish before it starts.');
  const keys = Object.keys(f);
  if (keys.length) {
    await db.execute(
      `UPDATE epos_events SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ? AND office = ?`,
      [...keys.map((k) => f[k]), e.id, office]
    );
  }
  return e.id;
}

async function deleteEvent(db, office, id) {
  const e = await eventById(db, office, id);
  if (!e) throw fail(404, 'No such event.');
  const [[sold]] = await db.query(
    "SELECT COUNT(*) AS n FROM epos_event_orders WHERE event_id = ? AND status IN ('paid', 'refunded')", [e.id]);
  if (Number(sold.n)) throw fail(409, 'Tickets have been sold for this event. Take it off sale and unpublish it instead.');
  await db.execute('DELETE FROM epos_event_orders WHERE event_id = ?', [e.id]);
  await db.execute('DELETE FROM epos_event_ticket_types WHERE event_id = ?', [e.id]);
  await db.execute('DELETE FROM epos_events WHERE id = ? AND office = ?', [e.id, office]);
}

async function typeById(db, office, id) {
  if (!/^\d+$/.test(String(id))) return null;
  const [[t]] = await db.query(
    `SELECT t.* FROM epos_event_ticket_types t JOIN epos_events e ON e.id = t.event_id
      WHERE t.id = ? AND e.office = ?`,
    [id, office]
  );
  return t || null;
}

async function addTicketType(db, office, eventId, body) {
  const e = await eventById(db, office, eventId);
  if (!e) throw fail(404, 'No such event.');
  const t = cleanTicketType(body);
  const [r] = await db.execute(
    `INSERT INTO epos_event_ticket_types (event_id, name, price_minor, capacity, max_per_order, sort)
     VALUES (?,?,?,?,?,?)`,
    [e.id, t.name, t.price_minor, t.capacity, t.max_per_order, t.sort]
  );
  return r.insertId;
}

async function updateTicketType(db, office, id, body) {
  const old = await typeById(db, office, id);
  if (!old) throw fail(404, 'No such ticket.');
  const t = cleanTicketType({ ...old, ...body });
  await db.execute(
    `UPDATE epos_event_ticket_types SET name = ?, price_minor = ?, capacity = ?, max_per_order = ?, sort = ?
      WHERE id = ?`,
    [t.name, t.price_minor, t.capacity, t.max_per_order, t.sort, old.id]
  );
  return old.event_id;
}

async function deleteTicketType(db, office, id) {
  const t = await typeById(db, office, id);
  if (!t) throw fail(404, 'No such ticket.');
  const [orders] = await db.query(
    "SELECT items FROM epos_event_orders WHERE event_id = ? AND status IN ('pending', 'paid', 'refunded')", [t.event_id]);
  if (orders.some((o) => parseItems(o.items).some((it) => Number(it.ticket_type_id) === t.id))) {
    throw fail(409, 'Some of these have been sold. Set how many can be sold to 0 instead.');
  }
  await db.execute('DELETE FROM epos_event_ticket_types WHERE id = ?', [t.id]);
  return t.event_id;
}

// ---------------------------------------------------------------------------
// The WRU's fixture list
// ---------------------------------------------------------------------------

const shortClub = (name) => String(name || '').replace(/\s+RFC$/i, '').trim();

/**
 * The club's HOME fixtures, as events. `fixtures` is the WRU's own list; the
 * date is already UK local ("2026-10-17T14:30:00"). Away matches are not ours
 * to sell tickets for.
 */
function shapeFixtures(fixtures, orgId, homeName) {
  const out = [];
  for (const f of fixtures || []) {
    const home = f && f.homeTeam;
    const away = f && f.awayTeam;
    if (!home || !away || Number(home.orgId) !== Number(orgId)) continue;
    const startsAt = cleanDateTime(f.date);
    if (!f.fixtureId || !startsAt) continue;
    const team = home.childValue && home.childValue !== '1st Team' ? ` ${home.childValue}` : '';
    out.push({
      wru_fixture_id: Number(f.fixtureId),
      title: `${homeName || shortClub(home.organisationName)}${team} v ${shortClub(away.organisationName)}`.slice(0, 160),
      starts_at: startsAt,
      description: f.competitionName ? String(f.competitionName).slice(0, 4000) : null,
    });
  }
  return out;
}

/** Every page of upcoming fixtures for a club (five at most: a season). */
async function fetchWruFixtures(orgId, { fetchImpl = fetch } = {}) {
  const all = [];
  for (let page = 1; page <= 5; page++) {
    const url = `${WRU_FIXTURES}?upcoming=true&organisationId=${encodeURIComponent(orgId)}${page > 1 ? `&page=${page}` : ''}`;
    const res = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw fail(502, `The WRU's fixture list did not answer (${res.status}).`);
    const body = await res.json();
    all.push(...((body && body.fixtures) || []));
    if (!body || !body.hasMore) break;
  }
  return all;
}

/**
 * Bring the club's upcoming home matches in. A match already here (by its WRU
 * fixture id) has its title and kick-off brought up to date and nothing else,
 * so what the club has set -- tickets, on sale, the picture -- stays. A new
 * one is published but not on sale, with the ticket types of the club's most
 * recent match, ready for somebody to check the prices and press On sale.
 */
async function importWru(db, office, { fetchImpl } = {}) {
  const s = await settingsFor(db, office);
  if (!s.wru_org_id) throw fail(409, 'Set your WRU club number first, under Settings on this page.');
  const shaped = shapeFixtures(await fetchWruFixtures(s.wru_org_id, { fetchImpl }), s.wru_org_id, s.home_name);
  const location = s.location || (await venueName(db, office)) || null;
  let created = 0;
  let updated = 0;
  let template = null;
  for (const f of shaped) {
    const [[have]] = await db.query(
      `SELECT id, title, DATE_FORMAT(starts_at, '%Y-%m-%d %H:%i:%s') AS starts_at
         FROM epos_events WHERE office = ? AND wru_fixture_id = ?`,
      [office, f.wru_fixture_id]
    );
    if (have) {
      if (have.title !== f.title || have.starts_at !== f.starts_at) {
        await db.execute('UPDATE epos_events SET title = ?, starts_at = ? WHERE id = ?', [f.title, f.starts_at, have.id]);
        updated++;
      }
      continue;
    }
    if (template === null) {
      const [[last]] = await db.query(
        `SELECT e.id FROM epos_events e
          WHERE e.office = ? AND e.kind = 'match'
            AND EXISTS (SELECT 1 FROM epos_event_ticket_types t WHERE t.event_id = e.id)
          ORDER BY e.starts_at DESC LIMIT 1`,
        [office]
      );
      template = last ? await typesFor(db, [last.id]) : [];
    }
    const id = await createEvent(db, office, {
      title: f.title, kind: 'match', starts_at: f.starts_at, description: f.description,
      location, published: 1, on_sale: 0,
    }, { wru_fixture_id: f.wru_fixture_id });
    for (const t of template) {
      await db.execute(
        `INSERT INTO epos_event_ticket_types (event_id, name, price_minor, capacity, max_per_order, sort)
         VALUES (?,?,?,?,?,?)`,
        [id, t.name, t.price_minor, t.capacity, t.max_per_order, t.sort]
      );
    }
    created++;
  }
  return { fixtures: shaped.length, created, updated };
}

// ---------------------------------------------------------------------------
// Buying
// ---------------------------------------------------------------------------

/**
 * What was asked for, checked against the event's ticket types and what is
 * left. Returns the order's lines and total; throws 400 for a malformed
 * basket and 409 for one that is fine but cannot be had.
 */
function priceItems(items, types, taken, { maxPerOrder = true } = {}) {
  if (!Array.isArray(items) || !items.length) throw fail(400, 'Choose at least one ticket.');
  const qty = {};
  for (const it of items) {
    const id = Number(it && it.ticket_type_id);
    const n = Number(it && it.qty);
    if (!Number.isInteger(id) || !Number.isInteger(n) || n < 0) throw fail(400, 'Each ticket needs a type and a whole number.');
    if (!types.some((t) => t.id === id)) throw fail(400, 'One of those tickets is not for this event.');
    qty[id] = (qty[id] || 0) + n;
  }
  const lines = [];
  let total = 0;
  let count = 0;
  for (const t of types) {
    const n = qty[t.id] || 0;
    if (!n) continue;
    if (maxPerOrder && n > t.max_per_order) throw fail(400, `No more than ${t.max_per_order} ${t.name} tickets in one order.`);
    const left = remaining(t, taken);
    if (left !== null && n > left) {
      throw fail(409, left ? `Only ${left} ${t.name} ticket${left === 1 ? ' is' : 's are'} left.` : `${t.name} tickets are sold out.`);
    }
    lines.push({ ticket_type_id: t.id, name: t.name, qty: n, price_minor: t.price_minor });
    total += n * t.price_minor;
    count += n;
  }
  if (!count) throw fail(400, 'Choose at least one ticket.');
  if (count > 200) throw fail(400, 'That is too many tickets for one order.');
  return { lines, total };
}

/**
 * Hold the tickets and write the order, in one transaction with the event's
 * ticket types locked: two buyers after the last ticket are served one after
 * the other, and the second is told it has gone.
 */
async function placeOrder(pool, office, event, items, buyer, { source = 'online', status = 'pending', total: fixedTotal = null, by = null, maxPerOrder = true } = {}) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const types = await typesFor(conn, [event.id], { lock: true });
    const taken = await takenFor(conn, [event.id]);
    const { lines, total } = priceItems(items, types, taken, { maxPerOrder });
    const publicId = crypto.randomBytes(16).toString('hex');
    const charged = fixedTotal === null ? total : fixedTotal;
    const [r] = await conn.execute(
      `INSERT INTO epos_event_orders (public_id, office, event_id, name, email, phone, items, total_minor,
         status, source, issued_by, paid_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,${status === 'paid' ? 'NOW()' : 'NULL'})`,
      [publicId, office, event.id, buyer.name, buyer.email, buyer.phone, JSON.stringify(lines), charged,
        status, source, by]
    );
    await conn.commit();
    return { id: r.insertId, public_id: publicId, total_minor: charged, lines };
  } catch (e) {
    await conn.rollback().catch(() => {});
    throw e;
  } finally {
    conn.release();
  }
}

function cleanBuyer(body, { emailRequired = true } = {}) {
  const name = text(body && body.name, 120);
  if (!name) throw fail(400, 'Please give your name.');
  const email = text(body && body.email, 190);
  if (emailRequired && !email) throw fail(400, 'Please give your email address, for your tickets.');
  if (email && !EMAIL.test(email)) throw fail(400, 'That email address does not look right.');
  return { name, email: email ? email.toLowerCase() : null, phone: text(body && body.phone, 40) };
}

/** The website's checkout. See the contract in the header comment of the route. */
async function checkout(pool, venue, body, baseUrl) {
  const b = body || {};
  const e = await eventById(pool, venue.office, b.event_id);
  if (!e || !Number(e.published)) throw fail(404, 'That event could not be found.');
  if (!Number(e.on_sale)) throw fail(409, 'Tickets for this event are not on sale.');
  if (e.starts_at.slice(0, 10) < ukDay()) throw fail(409, 'This event has been and gone.');
  const buyer = cleanBuyer(b);

  // Checked before anything is held: a basket that would be refused at the
  // end must not keep tickets from anybody for half an hour.
  const s = await settingsFor(pool, venue.office);
  if (b.return_url && !returnUrlFor(b.return_url, s.site_origins, 'x')) {
    throw fail(400, 'return_url is not on this venue’s website.');
  }
  const types = await typesFor(pool, [e.id]);
  const preview = priceItems(b.items, types, await takenFor(pool, [e.id]));
  let key = null;
  if (preview.total > 0) {
    if (!b.return_url) throw fail(400, 'return_url is required.');
    key = await paymentKeyFor(pool, venue.office);
    if (!key) throw fail(409, 'This venue does not take payments online yet.');
  }

  const order = await placeOrder(pool, venue.office, e, b.items, buyer);
  if (order.total_minor === 0) {
    await claimAndIssue(pool, order.id, baseUrl);
    return { order_id: order.public_id, paid: true };
  }
  let intent;
  try {
    intent = await dojo.createCheckoutIntent(key, {
      amountMinor: order.total_minor,
      reference: `tickets-${order.public_id.slice(0, 12)}`,
      description: `${e.title} tickets`,
      redirectUrl: returnUrlFor(b.return_url, s.site_origins, order.public_id),
    });
  } catch (err) {
    await pool.execute("UPDATE epos_event_orders SET status = 'failed' WHERE id = ?", [order.id]);
    console.error('[events] Dojo checkout failed:', err.message);
    throw fail(502, 'The card payment page could not be opened. Please try again.');
  }
  await pool.execute('UPDATE epos_event_orders SET dojo_intent_id = ? WHERE id = ?', [intent.id, order.id]);
  return { order_id: order.public_id, pay_url: dojo.checkoutUrl(intent.id) };
}

async function insertTicket(db, order, line, holder) {
  for (let i = 0; i < 6; i++) {
    try {
      await db.execute(
        `INSERT INTO epos_event_tickets (order_id, event_id, ticket_type_id, code, holder) VALUES (?,?,?,?,?)`,
        [order.id, order.event_id, line.ticket_type_id, newCode(), holder]
      );
      return;
    } catch (e) {
      if (e.code !== 'ER_DUP_ENTRY') throw e;
    }
  }
  throw new Error('Could not find a free ticket code.');
}

/**
 * Mark an order paid and make its tickets -- once. The conditional UPDATE on
 * `applied_at` is the claim: whichever caller sets it makes the tickets and
 * sends the email, and every other caller is told it was already done.
 */
async function claimAndIssue(pool, orderId, baseUrl, { email = true } = {}) {
  // One transaction, so nobody reads the order as paid before its tickets are
  // all there: a second tab's claim waits on the row lock, finds it taken,
  // and then reads the finished set.
  const conn = await pool.getConnection();
  let order;
  try {
    await conn.beginTransaction();
    const [claim] = await conn.execute(
      `UPDATE epos_event_orders SET status = 'paid', paid_at = COALESCE(paid_at, NOW()), applied_at = NOW()
        WHERE id = ? AND applied_at IS NULL AND status IN ('pending', 'paid')`,
      [orderId]
    );
    if (!claim.affectedRows) {
      await conn.rollback();
      return false;
    }
    [[order]] = await conn.query('SELECT * FROM epos_event_orders WHERE id = ?', [orderId]);
    for (const line of parseItems(order.items)) {
      for (let i = 0; i < Number(line.qty); i++) await insertTicket(conn, order, line, order.name);
    }
    await conn.commit();
  } catch (e) {
    await conn.rollback().catch(() => {});
    throw e;
  } finally {
    conn.release();
  }
  if (email && order.email) await sendTickets(pool, order.id, baseUrl);
  return true;
}

const failedIntent = (intent) =>
  ['canceled', 'cancelled', 'declined', 'reversed', 'failed']
    .includes(String((intent && intent.status) || '').toLowerCase());

/** Ask Dojo about a pending order, and issue its tickets if it is paid. */
async function settleOrder(db, order, baseUrl) {
  if (order.status === 'paid' && !order.applied_at) {
    await claimAndIssue(db, order.id, baseUrl);
  } else if (order.status === 'pending' && order.dojo_intent_id) {
    const key = await paymentKeyFor(db, order.office);
    if (!key) return;
    const intent = await dojo.getIntent(key, order.dojo_intent_id);
    if (dojo.intentPaid(intent)) await claimAndIssue(db, order.id, baseUrl);
    else if (failedIntent(intent)) {
      await db.execute("UPDATE epos_event_orders SET status = 'failed' WHERE id = ? AND status = 'pending'", [order.id]);
    }
  }
}

const qrUrl = (baseUrl, code) => `${baseUrl}/api/public/events/ticket/${code}.svg`;

async function ticketsOf(db, orderId) {
  const [rows] = await db.query(
    `SELECT t.code, t.holder, tt.name AS type,
            DATE_FORMAT(t.checked_in_at, ${SQL_MINUTE}) AS checked_in_at, t.checked_in_by
       FROM epos_event_tickets t LEFT JOIN epos_event_ticket_types tt ON tt.id = t.ticket_type_id
      WHERE t.order_id = ? ORDER BY t.id`,
    [orderId]
  );
  return rows;
}

/** The buyer's view of an order, for the website's return page. */
async function orderView(db, order, baseUrl) {
  const [[e]] = await db.query(`SELECT ${EVENT_COLUMNS} FROM epos_events e WHERE e.id = ?`, [order.event_id]);
  const tickets = order.status === 'paid' ? await ticketsOf(db, order.id) : [];
  return {
    status: STATUSES.includes(order.status) ? order.status : 'pending',
    event: e ? { title: e.title, starts_at: e.starts_at, location: e.location || null } : null,
    name: order.name,
    total_minor: Number(order.total_minor),
    tickets: tickets.map((t) => ({ code: t.code, type: t.type || 'Ticket', holder: t.holder, qr_url: qrUrl(baseUrl, t.code) })),
  };
}

// ---------------------------------------------------------------------------
// The ticket email
// ---------------------------------------------------------------------------

/** One page per ticket, A6, with its QR drawn in vector so it prints sharp. */
function ticketsPdf({ venue, event, tickets }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A6', margin: 24, info: { Title: `${event.title} tickets` } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const width = doc.page.width - 48;
    tickets.forEach((t, i) => {
      if (i) doc.addPage();
      doc.font('Helvetica').fontSize(9).fillColor('#666666').text(venue || '', { width });
      doc.font('Helvetica-Bold').fontSize(15).fillColor('#000000').text(event.title, { width });
      doc.font('Helvetica').fontSize(10).text(whenText(event.starts_at), { width });
      if (event.location) doc.text(event.location, { width });
      doc.moveDown(0.4).font('Helvetica-Bold').text(`${t.type || 'Ticket'}  ·  ${t.holder || ''}`, { width });
      const { matrix } = QR.encode(qrPayload(t.code));
      const n = matrix.length;
      const size = 170;
      const cell = size / (n + 8);
      const x0 = (doc.page.width - size) / 2;
      const y0 = doc.y + 8;
      for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) if (matrix[r][c]) doc.rect(x0 + (c + 4) * cell, y0 + (r + 4) * cell, cell, cell);
      }
      doc.fill('#000000');
      doc.font('Courier-Bold').fontSize(16).text(t.code, 24, y0 + size + 6, { width, align: 'center' });
      doc.font('Helvetica').fontSize(8).fillColor('#666666')
        .text('Show this at the gate. Each ticket gets in once.', { width, align: 'center' });
    });
    doc.end();
  });
}

const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);

/** Email an order's tickets to its buyer, with the PDF. Resolves false if not sent. */
async function sendTickets(db, orderId, baseUrl, { to = null } = {}) {
  const [[order]] = await db.query('SELECT * FROM epos_event_orders WHERE id = ?', [orderId]);
  if (!order || order.status !== 'paid') return false;
  const address = to || order.email;
  if (!address) return false;
  const [[e]] = await db.query(`SELECT ${EVENT_COLUMNS} FROM epos_events e WHERE e.id = ?`, [order.event_id]);
  const tickets = await ticketsOf(db, order.id);
  if (!e || !tickets.length) return false;
  const venue = await venueName(db, order.office);
  const when = whenText(e.starts_at);
  const pdf = await ticketsPdf({ venue, event: e, tickets });
  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:520px;color:#17141c">
<p>Hello ${esc(order.name)},</p>
<p>Here ${tickets.length === 1 ? 'is your ticket' : `are your ${tickets.length} tickets`} for <b>${esc(e.title)}</b>.</p>
<p>${esc(when)}${e.location ? `<br>${esc(e.location)}` : ''}</p>
<p>Show the QR code at the gate, on your phone or printed. They are also attached as a PDF.</p>
${tickets.map((t) => `<div style="border:1px solid #ddd;border-radius:12px;padding:14px;margin:12px 0;text-align:center">
<div style="font-weight:600">${esc(t.type || 'Ticket')} &middot; ${esc(t.holder || '')}</div>
<img src="${esc(qrUrl(baseUrl, t.code))}" width="200" height="200" alt="QR code for ticket ${esc(t.code)}" style="margin:8px auto;display:block">
<div style="font-family:monospace;font-size:18px;letter-spacing:2px">${esc(t.code)}</div></div>`).join('')}
<p style="color:#666;font-size:13px">${esc(venue)}</p></div>`;
  const plain = [`Hello ${order.name},`, '', `Your tickets for ${e.title}`, when, e.location || '', '',
    ...tickets.map((t) => `${t.type || 'Ticket'} (${t.holder || ''}): ${t.code}  ${qrUrl(baseUrl, t.code)}`), '',
    'Show the QR code at the gate. The tickets are attached as a PDF.'].join('\n');
  return sendMail({
    to: address,
    replyTo: order.office,
    subject: `Your tickets: ${e.title}`,
    html,
    text: plain,
    attachments: [{ filename: 'tickets.pdf', content: pdf, contentType: 'application/pdf' }],
  });
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

function describeTicket(row) {
  return {
    code: row.code,
    event_title: row.event_title,
    starts_at: row.starts_at,
    type: row.type || 'Ticket',
    holder: row.holder,
  };
}

/**
 * Check a ticket in. `{ status, body }` in the till's contract: 200 and ok the
 * first time; 200, not ok and `already` every time after; 404 for a code that
 * is not a ticket of a paid order at this venue.
 */
async function checkIn(db, office, raw, by) {
  const invalid = { status: 404, body: { ok: false, message: 'Not a valid ticket' } };
  const code = parseCode(raw);
  if (!code) return invalid;
  const [[row]] = await db.query(
    `SELECT t.id, t.code, t.holder, tt.name AS type, e.title AS event_title,
            DATE_FORMAT(e.starts_at, ${SQL_MINUTE}) AS starts_at
       FROM epos_event_tickets t
       JOIN epos_event_orders o ON o.id = t.order_id
       JOIN epos_events e ON e.id = t.event_id
       LEFT JOIN epos_event_ticket_types tt ON tt.id = t.ticket_type_id
      WHERE t.code = ? AND o.office = ? AND o.status = 'paid'`,
    [code, office]
  );
  if (!row) return invalid;
  const [claim] = await db.execute(
    'UPDATE epos_event_tickets SET checked_in_at = ?, checked_in_by = ? WHERE id = ? AND checked_in_at IS NULL',
    [ukNow(), text(by, 120), row.id]
  );
  if (claim.affectedRows) return { status: 200, body: { ok: true, ticket: describeTicket(row) } };
  const [[seen]] = await db.query(
    `SELECT DATE_FORMAT(checked_in_at, ${SQL_MINUTE}) AS at FROM epos_event_tickets WHERE id = ?`, [row.id]);
  const at = seen && seen.at;
  return {
    status: 200,
    body: {
      ok: false,
      already: true,
      checked_in_at: at,
      ticket: describeTicket(row),
      message: `Already scanned at ${at ? at.slice(11, 16) : 'an earlier time'}`,
    },
  };
}

async function undoCheckIn(db, office, raw) {
  const code = parseCode(raw);
  if (!code) throw fail(404, 'Not a valid ticket');
  const [r] = await db.execute(
    `UPDATE epos_event_tickets t JOIN epos_event_orders o ON o.id = t.order_id
        SET t.checked_in_at = NULL, t.checked_in_by = NULL
      WHERE t.code = ? AND o.office = ?`,
    [code, office]
  );
  if (!r.affectedRows) throw fail(404, 'Not a valid ticket');
}

// ---------------------------------------------------------------------------
// The back office's sales list
// ---------------------------------------------------------------------------

async function ordersFor(db, office, eventId, baseUrl) {
  const e = await eventById(db, office, eventId);
  if (!e) throw fail(404, 'No such event.');
  // A buyer who paid and closed the tab before Dojo sent them back has not
  // had their tickets yet. Looking at the list asks Dojo about the recent
  // ones, so the club sees, and the buyer gets, what was paid for.
  const [stale] = await db.query(
    `SELECT * FROM epos_event_orders
      WHERE event_id = ? AND status = 'pending' AND dojo_intent_id IS NOT NULL
        AND created_at > NOW() - INTERVAL 2 DAY
      ORDER BY created_at DESC LIMIT 10`,
    [e.id]
  );
  for (const o of stale) await settleOrder(db, o, baseUrl).catch((err) => console.warn('[events] settle:', err.message));

  const [orders] = await db.query(
    `SELECT id, public_id, name, email, phone, items, total_minor, status, source, issued_by,
            DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i') AS created_at
       FROM epos_event_orders WHERE event_id = ? ORDER BY created_at DESC, id DESC`,
    [e.id]
  );
  const [tickets] = await db.query(
    `SELECT t.order_id, t.code, t.holder, t.ticket_type_id, tt.name AS type,
            DATE_FORMAT(t.checked_in_at, ${SQL_MINUTE}) AS checked_in_at, t.checked_in_by
       FROM epos_event_tickets t LEFT JOIN epos_event_ticket_types tt ON tt.id = t.ticket_type_id
      WHERE t.event_id = ? ORDER BY t.id`,
    [e.id]
  );
  const detail = await eventDetail(db, office, e.id);
  const paid = orders.filter((o) => o.status === 'paid');
  const paidIds = new Set(paid.map((o) => o.id));
  const live = tickets.filter((t) => paidIds.has(t.order_id));
  return {
    event: detail,
    orders: orders.map((o) => ({
      id: o.id,
      public_id: o.public_id,
      name: o.name,
      email: o.email,
      phone: o.phone,
      total_minor: Number(o.total_minor),
      status: o.status,
      source: o.source,
      issued_by: o.issued_by,
      created_at: o.created_at,
      items: parseItems(o.items),
      tickets: tickets.filter((t) => t.order_id === o.id)
        .map((t) => ({ code: t.code, type: t.type || 'Ticket', holder: t.holder, checked_in_at: t.checked_in_at, checked_in_by: t.checked_in_by })),
    })),
    totals: {
      orders: paid.length,
      tickets: live.length,
      checked_in: live.filter((t) => t.checked_in_at).length,
      revenue_minor: paid.reduce((n, o) => n + Number(o.total_minor), 0),
      online_minor: paid.filter((o) => o.source === 'online').reduce((n, o) => n + Number(o.total_minor), 0),
      by_type: detail.ticket_types.map((t) => ({ id: t.id, name: t.name, sold: t.sold, checked_in: t.checked_in, remaining: t.remaining })),
    },
  };
}

/** Tickets issued in the back office: complimentary, or paid for at the bar. */
async function issueTickets(pool, office, eventId, body, by, baseUrl) {
  const e = await eventById(pool, office, eventId);
  if (!e) throw fail(404, 'No such event.');
  const b = body || {};
  const buyer = cleanBuyer(b, { emailRequired: false });
  let total = 0;
  if (b.amount_minor !== null && b.amount_minor !== undefined && String(b.amount_minor).trim() !== '') {
    total = Math.round(Number(b.amount_minor));
    if (!Number.isFinite(total) || total < 0) throw fail(400, 'What was paid is an amount of money, or nothing.');
  }
  const order = await placeOrder(pool, office, e, b.items, buyer,
    { source: 'backoffice', status: 'paid', total, by, maxPerOrder: false });
  await claimAndIssue(pool, order.id, baseUrl, { email: b.send_email !== false && b.send_email !== 0 && b.send_email !== '0' });
  return order;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

function eventRoutes({ pool, broadcast = () => {}, secret }) {
  const router = express.Router();
  const auth = requireAuth(secret);
  const terminal = requireTerminal(secret);
  const json = express.json({ limit: '64kb' });

  const send = (res, next) => (e) =>
    (e && e.status ? res.status(e.status).json({ error: e.message }) : next(e));

  const changed = (office) => broadcast({ type: 'events', office });

  const baseUrl = (req) =>
    String(process.env.BACKOFFICE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');

  async function backOfficeOffice(req) {
    if (req.user.officeId) {
      const [[o]] = await pool.query('SELECT contact_email FROM offices WHERE id = ?', [req.user.officeId]);
      if (o) return o.contact_email;
    }
    return req.user.email;
  }

  /** The venue, and refuse unless Events & tickets is on there. */
  const venue = (from) => async (req, res, next) => {
    try {
      const office = from === 'till' ? req.office || (req.terminal && req.terminal.office) : await backOfficeOffice(req);
      if (!(await moduleOn(pool, office, 'events'))) {
        return res.status(404).json({ error: 'Events & tickets are not switched on for this venue.' });
      }
      req.venue = office;
      next();
    } catch (e) { next(e); }
  };
  const bo = [auth, venue('backoffice')];
  const till = [terminal, venue('till')];
  const who = (req) => (req.user ? req.user.email : (req.body && req.body.staff) || (req.terminal && req.terminal.name) || 'till');

  // ---- Back office ---------------------------------------------------------

  router.get('/api/events/settings', ...bo, async (req, res, next) => {
    try { res.json(await settingsFor(pool, req.venue)); } catch (e) { send(res, next)(e); }
  });
  router.put('/api/events/settings', ...bo, json, async (req, res, next) => {
    try { res.json(await saveSettings(pool, req.venue, req.body)); } catch (e) { send(res, next)(e); }
  });
  router.post('/api/events/import-wru', ...bo, async (req, res, next) => {
    try {
      const r = await importWru(pool, req.venue);
      changed(req.venue);
      res.json(r);
    } catch (e) { send(res, next)(e); }
  });
  router.post('/api/events/checkin', ...bo, json, async (req, res, next) => {
    try {
      const r = await checkIn(pool, req.venue, req.body && req.body.code, who(req));
      if (r.body.ok) changed(req.venue);
      res.status(r.status).json(r.body);
    } catch (e) { send(res, next)(e); }
  });
  router.post('/api/events/tickets/:code/undo', ...bo, async (req, res, next) => {
    try {
      await undoCheckIn(pool, req.venue, req.params.code);
      changed(req.venue);
      res.json({ ok: true });
    } catch (e) { send(res, next)(e); }
  });
  router.post('/api/events/orders/:id/resend', ...bo, json, async (req, res, next) => {
    try {
      const [[o]] = await pool.query('SELECT id, status FROM epos_event_orders WHERE id = ? AND office = ?', [req.params.id, req.venue]);
      if (!o) throw fail(404, 'No such order.');
      if (o.status !== 'paid') throw fail(409, 'Only a paid order has tickets to send.');
      const to = text(req.body && req.body.email, 190);
      if (to && !EMAIL.test(to)) throw fail(400, 'That email address does not look right.');
      if (to) await pool.execute('UPDATE epos_event_orders SET email = ? WHERE id = ?', [to.toLowerCase(), o.id]);
      const sent = await sendTickets(pool, o.id, baseUrl(req));
      if (!sent) throw fail(502, 'The email could not be sent. Check the address, or that email is set up on this server.');
      res.json({ ok: true });
    } catch (e) { send(res, next)(e); }
  });
  router.put('/api/events/ticket-types/:id', ...bo, json, async (req, res, next) => {
    try {
      const eventId = await updateTicketType(pool, req.venue, req.params.id, req.body);
      changed(req.venue);
      res.json(await eventDetail(pool, req.venue, eventId));
    } catch (e) { send(res, next)(e); }
  });
  router.delete('/api/events/ticket-types/:id', ...bo, async (req, res, next) => {
    try {
      const eventId = await deleteTicketType(pool, req.venue, req.params.id);
      changed(req.venue);
      res.json(await eventDetail(pool, req.venue, eventId));
    } catch (e) { send(res, next)(e); }
  });
  router.get('/api/events', ...bo, async (req, res, next) => {
    try {
      res.json(await listEvents(pool, req.venue, { when: req.query.when === 'past' ? 'past' : 'upcoming' }));
    } catch (e) { send(res, next)(e); }
  });
  router.post('/api/events', ...bo, json, async (req, res, next) => {
    try {
      const id = await createEvent(pool, req.venue, req.body);
      for (const t of (req.body && Array.isArray(req.body.ticket_types) ? req.body.ticket_types : [])) {
        await addTicketType(pool, req.venue, id, t);
      }
      changed(req.venue);
      res.status(201).json(await eventDetail(pool, req.venue, id));
    } catch (e) { send(res, next)(e); }
  });
  router.get('/api/events/:id', ...bo, async (req, res, next) => {
    try {
      const e = await eventDetail(pool, req.venue, req.params.id);
      if (!e) throw fail(404, 'No such event.');
      res.json(e);
    } catch (e) { send(res, next)(e); }
  });
  router.put('/api/events/:id', ...bo, json, async (req, res, next) => {
    try {
      const id = await updateEvent(pool, req.venue, req.params.id, req.body);
      changed(req.venue);
      res.json(await eventDetail(pool, req.venue, id));
    } catch (e) { send(res, next)(e); }
  });
  router.delete('/api/events/:id', ...bo, async (req, res, next) => {
    try {
      await deleteEvent(pool, req.venue, req.params.id);
      changed(req.venue);
      res.json({ ok: true });
    } catch (e) { send(res, next)(e); }
  });
  router.post('/api/events/:id/ticket-types', ...bo, json, async (req, res, next) => {
    try {
      await addTicketType(pool, req.venue, req.params.id, req.body);
      changed(req.venue);
      res.status(201).json(await eventDetail(pool, req.venue, req.params.id));
    } catch (e) { send(res, next)(e); }
  });
  router.get('/api/events/:id/orders', ...bo, async (req, res, next) => {
    try { res.json(await ordersFor(pool, req.venue, req.params.id, baseUrl(req))); } catch (e) { send(res, next)(e); }
  });
  router.post('/api/events/:id/issue', ...bo, json, async (req, res, next) => {
    try {
      const o = await issueTickets(pool, req.venue, req.params.id, req.body, who(req), baseUrl(req));
      changed(req.venue);
      res.status(201).json({ order_id: o.public_id, id: o.id, tickets: await ticketsOf(pool, o.id) });
    } catch (e) { send(res, next)(e); }
  });

  // ---- Till ----------------------------------------------------------------

  router.get('/till/events', ...till, async (req, res, next) => {
    try { res.json({ events: await tillEvents(pool, req.venue) }); } catch (e) { send(res, next)(e); }
  });
  /**
   * Tickets sold at the counter (Vesopa Go, 2026-10-27): issued exactly as the
   * back office's Issue does, paid at the till, emailed when there is an
   * address. Allowed only when the venue lets that device's staff sell them
   * (back office, Vesopa Go options > Events and tickets).
   */
  router.post('/till/events/:id/sell', ...till, json, async (req, res, next) => {
    try {
      const { goOptionsFor } = require('./go_options');
      const opt = await goOptionsFor(pool, req.venue);
      if (opt.events_access === 'off') return res.status(403).json({ error: 'Selling tickets is switched off for Vesopa Go in the back office.' });
      const o = await issueTickets(pool, req.venue, req.params.id, req.body, who(req), baseUrl(req));
      changed(req.venue);
      res.status(201).json({ order_id: o.public_id, id: o.id, tickets: await ticketsOf(pool, o.id) });
    } catch (e) { send(res, next)(e); }
  });
  router.post('/till/events/checkin', ...till, json, async (req, res, next) => {
    try {
      const r = await checkIn(pool, req.venue, req.body && req.body.code, who(req));
      if (r.body.ok) changed(req.venue);
      res.status(r.status).json(r.body);
    } catch (e) { send(res, next)(e); }
  });

  // ---- Public: the venue's website -----------------------------------------
  //
  // Answers with `{ error }` like the rest of /api/public. A venue without the
  // module, or with no menu slug, is a 404 like a slug nobody has.

  const publicVenue = async (req, res, next) => {
    try {
      const v = await venueBySlug(pool, req.params.slug);
      if (!v) return res.status(404).json({ error: 'No events at that address.' });
      req.venue = v;
      next();
    } catch (e) { next(e); }
  };

  // Ahead of /:slug so "ticket" is never read as a venue.
  router.get('/api/public/events/ticket/:file', async (req, res) => {
    const m = /^(.+)\.svg$/i.exec(String(req.params.file || ''));
    const code = m ? parseCode(m[1]) : null;
    if (!code) return res.status(404).type('text/plain').send('Not a ticket');
    res.set('Cache-Control', 'public, max-age=86400');
    res.type('image/svg+xml').send(QR.svg(qrPayload(code), { size: 240 }));
  });

  router.get('/api/public/events/:slug', publicVenue, async (req, res, next) => {
    try {
      res.json({ venue: { name: req.venue.name }, events: await publicEvents(pool, req.venue.office) });
    } catch (e) { send(res, next)(e); }
  });

  /**
   * POST { event_id, items: [{ ticket_type_id, qty }], name, email, phone, return_url }
   *   free:  { order_id, paid: true }      the tickets are issued and emailed
   *   paid:  { order_id, pay_url }          Dojo's page; it sends the buyer to
   *                                         return_url?order=<order_id>
   */
  router.post('/api/public/events/:slug/checkout', publicVenue, json, async (req, res, next) => {
    try {
      const r = await checkout(pool, req.venue, req.body, baseUrl(req));
      if (r.paid) changed(req.venue.office);
      res.status(201).json(r);
    } catch (e) { send(res, next)(e); }
  });

  /** The order, settled with Dojo first: what the return page shows. */
  router.get('/api/public/events/:slug/orders/:publicId', publicVenue, async (req, res, next) => {
    try {
      const id = String(req.params.publicId || '');
      if (!/^[0-9a-f]{32}$/.test(id)) throw fail(404, 'No such order.');
      const find = async () => {
        const [[o]] = await pool.query('SELECT * FROM epos_event_orders WHERE public_id = ? AND office = ?', [id, req.venue.office]);
        return o;
      };
      let order = await find();
      if (!order) throw fail(404, 'No such order.');
      try {
        await settleOrder(pool, order, baseUrl(req));
      } catch (e) {
        console.warn('[events] could not settle an order:', e.message);
      }
      order = await find();
      if (order.status === 'paid') changed(req.venue.office);
      res.json(await orderView(pool, order, baseUrl(req)));
    } catch (e) { send(res, next)(e); }
  });

  return router;
}

module.exports = {
  eventRoutes,
  DEFAULTS,
  HOLD_MINUTES,
  ukNow,
  cleanDateTime,
  cleanEvent,
  cleanTicketType,
  newCode,
  parseCode,
  returnUrlFor,
  settingsFor,
  shapeFixtures,
  fetchWruFixtures,
  importWru,
  priceItems,
  checkout,
  claimAndIssue,
  checkIn,
  publicEvents,
  tillEvents,
  listEvents,
  ticketsPdf,
  whenText,
};
