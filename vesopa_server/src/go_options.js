'use strict';

/**
 * Vesopa Go's options: everything a venue can switch on or off for its Go
 * iPads and phones, set in the back office (Vesopa Tap > Vesopa Go) and read
 * by the app with /api/tap/config. Kept as one JSON document per venue so a new
 * option is a line in GO_DEFAULTS, not a schema change.
 *
 * The table makes itself on first use (CREATE TABLE IF NOT EXISTS): a venue
 * with no row gets the defaults, and nothing is ever deleted from it.
 */

const GO_DEFAULTS = Object.freeze({
  // What finishing an order does: take payment on Go, or put it on the till to settle there.
  order_mode: 'pay_on_go', // pay_on_go | send_to_till
  // Same product tapped again: follow the till's "consolidate lines", or force on/off.
  stack_lines: 'till', // till | on | off
  floor_view: 'plan', // plan | list
  product_images: true,
  // Card payments, per platform.
  card_ios: 'tap', // tap | machine
  card_android: 'machine', // tap | machine | pocket
  // Signing in.
  login_pin: true,
  login_photos: true,
  login_nfc: true,
  login_biometrics: true,
  login_clock_in: false,
  // Idle: follows the till's idle screen and wallpaper; Go's own timeout.
  idle_enabled: true,
  idle_seconds: 120,
  idle_require_pin: true,
  // Sounds (0-100 volume; 0 is off).
  sound_add: 40,
  sound_approved: 70,
  sound_declined: 70,
  sound_kitchen_ready: 70,
  sound_allergen: 60,
  haptics: true,
  // Scanning.
  scan_table_qr: true,
  scan_barcode: true,
  scan_gift_member: true,
  scan_nfc_table: true,
  // Notes and instructions.
  note_chips: 'No ice,Well done,On the side,No salt,Extra sauce,Allergy - see note',
  note_long_press: true,
  note_order: true,
  allergen_alerts: true,
  // Paying: what the customer sees when the device is handed over.
  customer_tip: true,
  customer_receipt_choice: true,
  customer_loyalty: true,
  customer_handover: true,
  // Printing: the venue's receipt printer (ESC/POS over the network), AirPrint if none.
  print_receipt_auto: false,
  print_airprint_fallback: true,
  print_kitchen: true,
  // Reports.
  reports_clerks: false, // clerks (not only managers) can open Reports
  reports_hourly: true,
  reports_staff: true,
  reports_products: true,
  reports_z: true,
  // Memberships and Events & tickets on Go: who may use them (the till's own
  // module still has to be on). staff = every clerk, managers = a manager or
  // a manager's PIN, off = not on Go.
  memberships_access: 'managers', // staff | managers | off
  memberships_cancel: 'managers', // staff | managers: who may cancel or reinstate
  events_access: 'staff', // staff | managers | off: selling tickets and the gate
  // Screens: the till's programmed screens by default, rearranged per form factor.
  layout_tablet: '', // JSON list of screen ids in order, '' = the till's order
  layout_phone: '',
  allow_rearrange: true,
});

const CHOICES = {
  order_mode: ['pay_on_go', 'send_to_till'],
  stack_lines: ['till', 'on', 'off'],
  floor_view: ['plan', 'list'],
  card_ios: ['tap', 'machine'],
  card_android: ['tap', 'machine', 'pocket'],
  memberships_access: ['staff', 'managers', 'off'],
  memberships_cancel: ['staff', 'managers'],
  events_access: ['staff', 'managers', 'off'],
};

/** body's known keys, typed and bounded like the defaults; unknown keys dropped. */
function cleanGoOptions(body = {}, old = GO_DEFAULTS) {
  const out = {};
  for (const [key, def] of Object.entries(GO_DEFAULTS)) {
    const has = body && Object.prototype.hasOwnProperty.call(body, key);
    const prev = old && Object.prototype.hasOwnProperty.call(old, key) ? old[key] : def;
    const v = has ? body[key] : prev;
    if (typeof def === 'boolean') {
      out[key] = v === true || v === 1 || v === '1' || v === 'true';
    } else if (typeof def === 'number') {
      const n = Math.round(Number(v));
      const max = key === 'idle_seconds' ? 3600 : 100;
      out[key] = Number.isFinite(n) ? Math.min(Math.max(n, 0), max) : def;
    } else if (CHOICES[key]) {
      out[key] = CHOICES[key].includes(v) ? v : (CHOICES[key].includes(prev) ? prev : def);
    } else if (key === 'note_chips') {
      out[key] = String(v ?? '').split(',').map((s) => s.trim().slice(0, 40)).filter(Boolean).slice(0, 24).join(',');
    } else if (key.startsWith('layout_')) {
      let ids = [];
      try { ids = Array.isArray(v) ? v : (v ? JSON.parse(v) : []); } catch (_) { ids = []; }
      ids = ids.map((x) => Number(x)).filter((x) => Number.isInteger(x) && x > 0).slice(0, 200);
      out[key] = ids.length ? JSON.stringify(ids) : '';
    } else {
      out[key] = String(v ?? '').slice(0, 2000);
    }
  }
  return out;
}

let ensured = false;
async function ensureTable(pool) {
  if (ensured) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS epos_go_options (
    office      VARCHAR(255) NOT NULL PRIMARY KEY,
    options     TEXT         NOT NULL,
    updated_by  VARCHAR(255) NULL,
    updated_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  ensured = true;
}

/** The venue's options, defaults filled in. */
async function goOptionsFor(pool, office) {
  try {
    await ensureTable(pool);
    const [[row]] = await pool.query('SELECT options FROM epos_go_options WHERE office = ?', [office]);
    let saved = {};
    try { saved = row ? JSON.parse(row.options) : {}; } catch (_) { saved = {}; }
    return cleanGoOptions(saved, GO_DEFAULTS);
  } catch (e) {
    console.warn('[go] options:', e.message);
    return { ...GO_DEFAULTS };
  }
}

async function saveGoOptions(pool, office, body, by) {
  await ensureTable(pool);
  const next = cleanGoOptions(body || {}, await goOptionsFor(pool, office));
  await pool.query(
    `INSERT INTO epos_go_options (office, options, updated_by) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE options = VALUES(options), updated_by = VALUES(updated_by)`,
    [office, JSON.stringify(next), String(by || '').slice(0, 255)]);
  return next;
}

// ---- Go's own layouts --------------------------------------------------------
//
// The till's programmed screens are Go's by default. A manager can rearrange a
// screen on an iPad or a phone (owner, 2026-10-27: "separately for iPad and
// Android/iPhone"), which is kept here as that screen's buttons for that kind
// of device, and never touches the till's own screen. Null buttons = back to
// the till's (the row stays, so nothing is ever deleted).

const FORMS = ['tablet', 'phone'];
let layoutsEnsured = false;
async function ensureLayouts(pool) {
  if (layoutsEnsured) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS epos_go_layouts (
    office      VARCHAR(255) NOT NULL,
    form        VARCHAR(12)  NOT NULL,
    screen_id   INT          NOT NULL,
    buttons     MEDIUMTEXT   NULL,
    updated_by  VARCHAR(255) NULL,
    updated_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (office, form, screen_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  layoutsEnsured = true;
}

/** { screenId: buttons } for one kind of device; screens back on the till's are left out. */
async function goLayoutsFor(pool, office, form) {
  if (!FORMS.includes(form)) return {};
  try {
    await ensureLayouts(pool);
    const [rows] = await pool.query(
      'SELECT screen_id, buttons FROM epos_go_layouts WHERE office = ? AND form = ? AND buttons IS NOT NULL', [office, form]);
    const out = {};
    for (const r of rows) {
      try { out[String(r.screen_id)] = JSON.parse(r.buttons); } catch (_) { /* a broken row reads as the till's */ }
    }
    return out;
  } catch (e) {
    console.warn('[go] layouts:', e.message);
    return {};
  }
}

async function saveGoLayout(pool, office, form, screenId, buttons, by) {
  await ensureLayouts(pool);
  await pool.query(
    `INSERT INTO epos_go_layouts (office, form, screen_id, buttons, updated_by) VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE buttons = VALUES(buttons), updated_by = VALUES(updated_by)`,
    [office, form, screenId, buttons == null ? null : JSON.stringify(buttons), String(by || '').slice(0, 255)]);
}

module.exports = { GO_DEFAULTS, CHOICES, FORMS, cleanGoOptions, goOptionsFor, saveGoOptions, goLayoutsFor, saveGoLayout };
