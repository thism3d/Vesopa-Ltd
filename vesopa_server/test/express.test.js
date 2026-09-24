/**
 * Vesopa Express, against a real database.
 *
 * WHY THIS ONE IS NOT A MOCK
 *
 * The things that can go wrong with a kiosk are the things a recording pool has
 * no opinion about: whether a payment captured twice -- by the kiosk's poll and
 * by Dojo's webhook in the same instant -- becomes one sale or two; whether the
 * number counter hands two kiosks the same number; whether the sale lands in
 * the same rows the Z report reads; whether a kitchen ticket's station routing
 * agrees with the till's. Each of those is a transaction, a lock or a join.
 *
 * So this stands up a scratch MariaDB schema -- the live tables' own column
 * types and collations, copied from a structure-only dump of production -- and
 * drives the real router. Only two things are faked, both at the edge:
 *
 *   * Dojo, by replacing `fetch`. Every request the server makes to Dojo is
 *     recorded, which is how "the intent is created once" is actually checked.
 *   * auth.vesopa.com, by replacing verifyTillToken. Its own checks are tested
 *     where it lives; here the question is what Express does with the answer.
 *
 * Needs a local MySQL or MariaDB, exactly as dinein.test.js does -- see the
 * note at the top of that file for the vesopa_test user. With no server
 * reachable it says so and exits 0.
 */

const assert = require('assert');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const express = require('express');
const mysql = require('mysql2/promise');
const jwt = require('jsonwebtoken');

// Before the module is loaded: these are read when it is.
process.env.EXPRESS_SECRET_KEY = 'express-test-sealing-key';
// Only the prefix matters (it is what marks a key as sandbox); the rest is
// deliberately not shaped like a key, so nothing mistakes it for one.
process.env.EXPRESS_DOJO_API_KEY = 'sk_sandbox_' + 'test-only-not-a-key';
process.env.EXPRESS_SESSION_CACHE_MS = '0';
process.env.EXPRESS_SWEEP_MS = '0';

const terminalVesopa = require('../src/terminal_vesopa');
const kiosk = require('../src/express_kiosk');

const DB = process.env.EXPRESS_TEST_DB || 'vesopa_express_selftest';
const USER = process.env.EXPRESS_TEST_USER || process.env.DINEIN_TEST_USER || 'root';
const PASS = process.env.EXPRESS_TEST_PASS || process.env.DINEIN_TEST_PASS || '';
const HOST = process.env.EXPRESS_TEST_HOST || '127.0.0.1';
const SECRET = 'express-test-secret';

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${e.message}`);
    process.exitCode = 1;
  }
}

const ARMS = { id: 901, email: 'kiosk@express.test', name: 'The Kiosk Arms' };
const OTHER = { id: 902, email: 'other@express.test', name: 'The Other Inn' };

// ---------------------------------------------------------------------------
// The tables this touches, as live has them (types and collations copied from
// a structure-only dump; columns nothing here reads are left out).
// ---------------------------------------------------------------------------
const SCHEMA = `
CREATE TABLE offices (
  id int(11) NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name varchar(255) NOT NULL,
  contact_email varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  status enum('active','paused','archived') NOT NULL DEFAULT 'active',
  UNIQUE KEY uq_offices_email (contact_email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE backoffice_users (
  id int(11) NOT NULL AUTO_INCREMENT PRIMARY KEY,
  email varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  password varchar(255) DEFAULT NULL,
  name varchar(255) NOT NULL,
  approved enum('Y','N') NOT NULL DEFAULT 'N',
  office_id int(11) DEFAULT NULL,
  role enum('admin','office') NOT NULL DEFAULT 'office',
  vesopa_sub varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  vesopa_linked_at datetime DEFAULT NULL,
  UNIQUE KEY email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb3 COLLATE=utf8mb3_unicode_ci;

CREATE TABLE bo_products (
  id int(11) NOT NULL AUTO_INCREMENT PRIMARY KEY,
  email varchar(255) NOT NULL,
  pluid int(11) NOT NULL,
  product_name varchar(255) DEFAULT NULL,
  price double DEFAULT NULL,
  tax_percentage double DEFAULT NULL,
  stock_quantity double DEFAULT NULL,
  printer_route varchar(32) DEFAULT NULL,
  printer_routes varchar(64) DEFAULT NULL,
  allergens text DEFAULT NULL,
  image_url varchar(500) DEFAULT NULL,
  UNIQUE KEY uq_bo_products_venue_plu (email, pluid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb3 COLLATE=utf8mb3_general_ci;

CREATE TABLE dinein_venue (
  office_id int(11) NOT NULL PRIMARY KEY,
  display_name varchar(160) DEFAULT NULL,
  logo_url varchar(500) DEFAULT NULL,
  banner_url varchar(500) DEFAULT NULL,
  accent_colour varchar(16) NOT NULL DEFAULT '#A5C715'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE dinein_sections (
  id int(11) NOT NULL AUTO_INCREMENT PRIMARY KEY,
  office_id int(11) NOT NULL,
  name varchar(120) NOT NULL,
  blurb varchar(300) DEFAULT NULL,
  image_url varchar(500) DEFAULT NULL,
  sort_order int(11) NOT NULL DEFAULT 0,
  active tinyint(1) NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE dinein_items (
  id int(11) NOT NULL AUTO_INCREMENT PRIMARY KEY,
  section_id int(11) NOT NULL,
  office_id int(11) NOT NULL,
  plu_id int(11) NOT NULL,
  name varchar(160) DEFAULT NULL,
  description varchar(500) DEFAULT NULL,
  image_url varchar(500) DEFAULT NULL,
  available tinyint(1) NOT NULL DEFAULT 1,
  sort_order int(11) NOT NULL DEFAULT 0,
  is_popular tinyint(1) NOT NULL DEFAULT 0,
  diet_tag varchar(24) DEFAULT NULL,
  is_featured tinyint(1) NOT NULL DEFAULT 0,
  allergens text DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE epos_product_modifiers (
  id int(11) NOT NULL AUTO_INCREMENT PRIMARY KEY,
  office varchar(190) NOT NULL,
  plu_id int(11) NOT NULL,
  group_id int(11) NOT NULL,
  sort_order int(11) NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE epos_modifier_groups (
  id int(11) NOT NULL AUTO_INCREMENT PRIMARY KEY,
  office varchar(190) NOT NULL,
  name varchar(120) NOT NULL,
  min_select int(11) NOT NULL DEFAULT 0,
  max_select int(11) NOT NULL DEFAULT 1,
  screen_id int(11) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE epos_screen_buttons (
  id int(11) NOT NULL AUTO_INCREMENT PRIMARY KEY,
  office varchar(190) NOT NULL,
  screen_id int(11) NOT NULL,
  kind varchar(16) NOT NULL DEFAULT 'product',
  plu_id int(11) DEFAULT NULL,
  label varchar(120) DEFAULT NULL,
  grid_row int(11) NOT NULL DEFAULT 0,
  grid_col int(11) NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE epos_till_settings (
  office varchar(190) NOT NULL PRIMARY KEY,
  kitchen_mode_kp1 varchar(8) NOT NULL DEFAULT 'printer',
  kitchen_mode_kp2 varchar(8) NOT NULL DEFAULT 'printer',
  kitchen_mode_kp3 varchar(8) NOT NULL DEFAULT 'printer',
  kitchen_mode_kp4 varchar(8) NOT NULL DEFAULT 'printer',
  kitchen_mode_kp5 varchar(8) NOT NULL DEFAULT 'printer',
  kitchen_mode_kp6 varchar(8) NOT NULL DEFAULT 'printer',
  printer_name_kp1 varchar(40) DEFAULT NULL,
  printer_name_kp2 varchar(40) DEFAULT NULL,
  printer_name_kp3 varchar(40) DEFAULT NULL,
  printer_name_kp4 varchar(40) DEFAULT NULL,
  printer_name_kp5 varchar(40) DEFAULT NULL,
  printer_name_kp6 varchar(40) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE epos_branding (
  office varchar(190) NOT NULL PRIMARY KEY,
  venue_name varchar(120) DEFAULT NULL,
  address_line1 varchar(160) DEFAULT NULL,
  address_line2 varchar(160) DEFAULT NULL,
  city varchar(80) DEFAULT NULL,
  postcode varchar(20) DEFAULT NULL,
  phone varchar(40) DEFAULT NULL,
  vat_number varchar(40) DEFAULT NULL,
  company_number varchar(40) DEFAULT NULL,
  footer_message varchar(255) DEFAULT NULL,
  footer_note varchar(255) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE epos_orders (
  id char(36) NOT NULL PRIMARY KEY,
  email varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  table_number int(11) DEFAULT NULL,
  clerk_pin varchar(255) DEFAULT NULL,
  subtotal_minor int(11) NOT NULL DEFAULT 0,
  discount_minor int(11) NOT NULL DEFAULT 0,
  tax_minor int(11) NOT NULL DEFAULT 0,
  total_minor int(11) NOT NULL DEFAULT 0,
  closed_at datetime DEFAULT NULL,
  created_at timestamp NOT NULL DEFAULT current_timestamp(),
  covers int(11) DEFAULT NULL,
  notes varchar(500) DEFAULT NULL,
  customer_name varchar(255) DEFAULT NULL,
  session_id char(36) DEFAULT NULL,
  voucher_code varchar(60) DEFAULT NULL,
  voucher_minor int(11) NOT NULL DEFAULT 0,
  service_minor int(11) NOT NULL DEFAULT 0,
  points_earned int(11) NOT NULL DEFAULT 0,
  points_balance int(11) DEFAULT NULL,
  clerk_name varchar(80) DEFAULT NULL,
  order_note varchar(500) DEFAULT NULL,
  gratuity_minor int(11) NOT NULL DEFAULT 0,
  gratuity_bp smallint(6) NOT NULL DEFAULT 0,
  gift_card_minor int(11) NOT NULL DEFAULT 0,
  gift_card_code varchar(64) DEFAULT NULL,
  deposit_minor int(11) NOT NULL DEFAULT 0,
  deposit_reference varchar(60) DEFAULT NULL,
  points_redeemed int(11) NOT NULL DEFAULT 0,
  points_value_minor int(11) NOT NULL DEFAULT 0,
  promo_minor int(11) NOT NULL DEFAULT 0,
  customer_id char(36) DEFAULT NULL,
  customer_phone varchar(64) DEFAULT NULL,
  split_group char(36) DEFAULT NULL,
  split_index tinyint(4) NOT NULL DEFAULT 0,
  split_count tinyint(4) NOT NULL DEFAULT 0,
  staff_id int(11) DEFAULT NULL,
  room_id int(11) DEFAULT NULL,
  terminal varchar(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE epos_order_lines (
  id char(36) NOT NULL PRIMARY KEY,
  order_id char(36) NOT NULL,
  plu_id int(11) NOT NULL,
  name varchar(255) NOT NULL,
  quantity double NOT NULL DEFAULT 1,
  unit_price_minor int(11) NOT NULL,
  tax_percentage double NOT NULL DEFAULT 0,
  note varchar(255) DEFAULT NULL,
  discount_minor int(11) NOT NULL DEFAULT 0,
  promotion_id int(11) DEFAULT NULL,
  promotion_name varchar(120) DEFAULT NULL,
  added_by varchar(80) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  added_at datetime DEFAULT NULL,
  is_modifier tinyint(1) NOT NULL DEFAULT 0,
  line_no int(11) NOT NULL DEFAULT 0,
  CONSTRAINT fk_lines_order FOREIGN KEY (order_id) REFERENCES epos_orders (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE epos_payments (
  id char(36) NOT NULL PRIMARY KEY,
  order_id char(36) NOT NULL,
  method varchar(32) NOT NULL,
  amount_minor int(11) NOT NULL,
  taken_at timestamp NOT NULL DEFAULT current_timestamp(),
  reference varchar(120) DEFAULT NULL,
  gratuity_minor int(11) NOT NULL DEFAULT 0,
  entry_mode varchar(16) DEFAULT NULL,
  cash_breakdown varchar(255) DEFAULT NULL,
  CONSTRAINT fk_payments_order FOREIGN KEY (order_id) REFERENCES epos_orders (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE epos_kitchen_tickets (
  id char(36) NOT NULL PRIMARY KEY,
  office varchar(190) NOT NULL,
  order_id char(36) NOT NULL,
  ticket_no varchar(40) DEFAULT NULL,
  kind varchar(16) NOT NULL DEFAULT 'sale',
  table_number int(11) DEFAULT NULL,
  room_name varchar(120) DEFAULT NULL,
  staff_name varchar(80) DEFAULT NULL,
  covers int(11) DEFAULT NULL,
  note varchar(500) DEFAULT NULL,
  rushed tinyint(1) NOT NULL DEFAULT 0,
  placed_at datetime NOT NULL,
  created_at timestamp NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE epos_kitchen_ticket_lines (
  id char(36) NOT NULL PRIMARY KEY,
  ticket_id char(36) NOT NULL,
  seq int(11) NOT NULL DEFAULT 0,
  quantity double NOT NULL DEFAULT 1,
  name varchar(255) NOT NULL,
  note varchar(500) DEFAULT NULL,
  stations varchar(64) DEFAULT NULL,
  made_at datetime DEFAULT NULL,
  made_by varchar(120) DEFAULT NULL,
  is_modifier tinyint(1) NOT NULL DEFAULT 0,
  allergens text DEFAULT NULL,
  CONSTRAINT fk_kitchen_line_ticket FOREIGN KEY (ticket_id) REFERENCES epos_kitchen_tickets (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE epos_kitchen_ticket_stations (
  ticket_id char(36) NOT NULL,
  station varchar(16) NOT NULL,
  status varchar(8) NOT NULL DEFAULT 'open',
  done_at datetime DEFAULT NULL,
  done_by varchar(120) DEFAULT NULL,
  PRIMARY KEY (ticket_id, station),
  CONSTRAINT fk_kitchen_state_ticket FOREIGN KEY (ticket_id) REFERENCES epos_kitchen_tickets (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE dinein_orders (
  id int(11) NOT NULL AUTO_INCREMENT PRIMARY KEY,
  public_id char(32) NOT NULL,
  office_id int(11) NOT NULL,
  table_id int(11) DEFAULT NULL,
  table_label varchar(60) DEFAULT NULL,
  customer_name varchar(120) DEFAULT NULL,
  customer_phone varchar(40) DEFAULT NULL,
  note varchar(500) DEFAULT NULL,
  status enum('placed','accepted','ready','served','rejected','cancelled') NOT NULL DEFAULT 'placed',
  status_note varchar(300) DEFAULT NULL,
  order_id varchar(64) DEFAULT NULL,
  total_minor int(11) NOT NULL DEFAULT 0,
  placed_at timestamp NOT NULL DEFAULT current_timestamp(),
  diner_id int(11) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE dinein_order_lines (
  id int(11) NOT NULL AUTO_INCREMENT PRIMARY KEY,
  dinein_order_id int(11) NOT NULL,
  plu_id int(11) NOT NULL,
  name varchar(160) NOT NULL,
  qty int(11) NOT NULL DEFAULT 1,
  unit_price_minor int(11) NOT NULL DEFAULT 0,
  note varchar(300) DEFAULT NULL,
  parent_line_id int(11) DEFAULT NULL,
  is_modifier tinyint(1) NOT NULL DEFAULT 0,
  unavailable_action varchar(16) NOT NULL DEFAULT 'remove'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;
`;

// ---------------------------------------------------------------------------
// A pretend Dojo, recording everything it is asked
// ---------------------------------------------------------------------------
const dojoCalls = [];
const sessions = {};
const intents = {};
let nextIntent = 1;
let nextSession = 1;

function reply(status, json) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    text: async () => JSON.stringify(json),
  };
}

const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  if (u.hostname !== 'api.dojo.tech') return realFetch(url, opts);
  const method = opts.method || 'GET';
  const body = opts.body ? JSON.parse(opts.body) : null;
  dojoCalls.push({ method, path: u.pathname, headers: opts.headers || {}, body });

  let m;
  if (u.pathname === '/payment-intents' && method === 'POST') {
    const id = 'pi_sandbox_' + nextIntent++;
    intents[id] = { status: 'Created', amount: body.Amount.Value };
    return reply(200, { id, status: 'Created' });
  }
  if ((m = /^\/payment-intents\/([^/]+)$/.exec(u.pathname)) && method === 'GET') {
    return reply(200, { id: m[1], status: (intents[m[1]] || {}).status || 'Created' });
  }
  if (u.pathname === '/terminal-sessions' && method === 'POST') {
    const id = 'ts_' + nextSession++;
    sessions[id] = {
      status: 'InitiateRequested',
      events: [{ notificationType: 'PresentCard' }],
      intent: body.details.sale.paymentIntentId,
      terminal: body.terminalId,
    };
    return reply(200, { id, status: 'InitiateRequested' });
  }
  if ((m = /^\/terminal-sessions\/([^/]+)$/.exec(u.pathname)) && method === 'GET') {
    const s = sessions[m[1]];
    return reply(200, { id: m[1], status: s.status, notificationEvents: s.events });
  }
  if ((m = /^\/terminal-sessions\/([^/]+)\/signature$/.exec(u.pathname)) && method === 'PUT') {
    sessions[m[1]].signature = body.accepted;
    return reply(200, {});
  }
  if ((m = /^\/terminal-sessions\/([^/]+)\/cancel$/.exec(u.pathname)) && method === 'PUT') {
    const s = sessions[m[1]];
    if (s.status === 'InitiateRequested') {
      s.status = 'Canceled';
      return reply(200, {});
    }
    return reply(409, { title: 'The session can no longer be cancelled.' });
  }
  if (u.pathname === '/terminals') {
    return reply(200, [{ id: 'tm_sandbox_1', status: 'Available', properties: { tid: 'VCMtestSIS0' } }]);
  }
  return reply(404, { title: 'Not faked: ' + method + ' ' + u.pathname });
};

/** Make the machine report a capture: the session and the intent together. */
function capture(sessionId) {
  const s = sessions[sessionId];
  s.status = 'Captured';
  s.events.push({ notificationType: 'RemoveCard' });
  intents[s.intent].status = 'Captured';
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------
const broadcasts = [];
function broadcast(message, options = {}) {
  broadcasts.push({ message, office: options.office || null });
}

function call(base, method, url, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      base + url,
      {
        method,
        headers: {
          Accept: 'application/json',
          ...(token ? { Authorization: 'Bearer ' + token } : {}),
          ...(payload
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
            : {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          let parsed = raw;
          try { parsed = JSON.parse(raw); } catch { /* html */ }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const sessionFor = (office) =>
  jwt.sign({ email: office.email, officeId: office.id, role: 'office' }, SECRET, { expiresIn: '1h' });

/** A commissioned till's token, shaped as issueTerminalToken makes it. */
const tillFor = (office) =>
  jwt.sign({ scope: 'terminal', office: office.email, officeId: office.id }, SECRET, { expiresIn: '1h' });

async function main() {
  let admin;
  try {
    admin = await mysql.createConnection({
      host: HOST, user: USER, password: PASS, multipleStatements: true,
    });
  } catch (e) {
    console.log(`-- no database reachable, skipping (${e.code || e.message})`);
    return;
  }

  await admin.query(`DROP DATABASE IF EXISTS ${DB}; CREATE DATABASE ${DB} CHARACTER SET utf8mb4;`);
  await admin.query(`USE ${DB}`);
  await admin.query(SCHEMA);

  // The migration itself, exactly as the deploy would run it -- twice, because
  // it must survive being replayed.
  const migration = fs.readFileSync(
    path.join(__dirname, '..', 'schema', 'schema_till_express.sql'),
    'utf8'
  );
  // The mysql client understands DELIMITER; the driver does not. Split the
  // file the way the client would.
  const statements = [];
  let delimiter = ';';
  let buffer = '';
  for (const line of migration.split('\n')) {
    const d = /^DELIMITER\s+(\S+)/.exec(line.trim());
    if (d) { delimiter = d[1]; continue; }
    if (line.trim().startsWith('--') && !buffer.trim()) continue;
    buffer += line + '\n';
    if (buffer.trimEnd().endsWith(delimiter)) {
      const sql = buffer.trimEnd().slice(0, -delimiter.length).trim();
      if (sql) statements.push(sql);
      buffer = '';
    }
  }
  for (let run = 0; run < 2; run++) {
    for (const sql of statements) await admin.query(sql);
  }

  await admin.end();

  const pool = mysql.createPool({
    host: HOST, user: USER, password: PASS, database: DB,
    connectionLimit: 8, dateStrings: false,
  });

  // ---- Seed --------------------------------------------------------------
  await pool.query('INSERT INTO offices (id, name, contact_email) VALUES (?, ?, ?), (?, ?, ?)',
    [ARMS.id, ARMS.name, ARMS.email, OTHER.id, OTHER.name, OTHER.email]);
  await pool.query(
    "INSERT INTO backoffice_users (email, name, approved, office_id) VALUES (?, 'Manager', 'Y', ?), (?, 'Other', 'Y', ?)",
    ['manager@express.test', ARMS.id, 'boss@other.test', OTHER.id]
  );
  await pool.query(
    'INSERT INTO bo_products (email, pluid, product_name, price, tax_percentage, printer_routes, stock_quantity) VALUES ' +
      "(?, 101, 'Cheeseburger', 8.50, 20, 'kp1', 50)," +
      "(?, 102, 'Fries', 3.00, 20, 'kp2', NULL)," +
      "(?, 103, 'Cola', 2.50, 20, NULL, NULL)," +
      "(?, 104, 'Extra cheese', 1.00, 20, NULL, NULL)," +
      "(?, 105, 'Steak pie', 12.00, 20, 'kp1', NULL)," +
      "(?, 201, 'Other burger', 9.99, 20, 'kp1', NULL)",
    [ARMS.email, ARMS.email, ARMS.email, ARMS.email, ARMS.email, OTHER.email]
  );
  const [burgers] = await pool.query("INSERT INTO dinein_sections (office_id, name, sort_order) VALUES (?, 'Burgers', 1)", [ARMS.id]);
  const [sides] = await pool.query("INSERT INTO dinein_sections (office_id, name, sort_order) VALUES (?, 'Sides and drinks', 2)", [ARMS.id]);
  const [otherSec] = await pool.query("INSERT INTO dinein_sections (office_id, name) VALUES (?, 'Other')", [OTHER.id]);
  const item = {};
  for (const [key, section, office, plu, extra] of [
    ['burger', burgers.insertId, ARMS.id, 101, { is_popular: 1 }],
    ['pie', burgers.insertId, ARMS.id, 105, { available: 0 }],
    ['fries', sides.insertId, ARMS.id, 102, {}],
    ['cola', sides.insertId, ARMS.id, 103, {}],
    ['other', otherSec.insertId, OTHER.id, 201, {}],
  ]) {
    const [r] = await pool.query(
      'INSERT INTO dinein_items (section_id, office_id, plu_id, available, is_popular) VALUES (?, ?, ?, ?, ?)',
      [section, office, plu, extra.available ?? 1, extra.is_popular ?? 0]
    );
    item[key] = r.insertId;
  }
  // The cheeseburger asks one question, "Extras", answered by the cheese.
  await pool.query("INSERT INTO epos_modifier_groups (id, office, name, min_select, max_select, screen_id) VALUES (1, ?, 'Extras', 0, 3, 77)", [ARMS.email]);
  await pool.query('INSERT INTO epos_product_modifiers (office, plu_id, group_id) VALUES (?, 101, 1)', [ARMS.email]);
  await pool.query("INSERT INTO epos_screen_buttons (office, screen_id, kind, plu_id) VALUES (?, 77, 'product', 104)", [ARMS.email]);
  // The grill (kp1) is a screen, the fryer (kp2) prints AND has a screen.
  await pool.query(
    "INSERT INTO epos_till_settings (office, kitchen_mode_kp1, kitchen_mode_kp2, printer_name_kp2) VALUES (?, 'screen', 'both', 'Fryer')",
    [ARMS.email]
  );

  // A meal: "Cheeseburger Meal" is its own product at its own price, and asks
  // three questions -- a side (one, required), a drink (one, required), and
  // sauces (as many as you like: max_select 0). The answers are products
  // priced as the upgrade. "Meal Fries" routes to the fryer on its own, and
  // must still travel on the meal's ticket.
  await pool.query(
    'INSERT INTO bo_products (email, pluid, product_name, price, tax_percentage, printer_routes) VALUES ' +
      "(?, 301, 'Cheeseburger Meal', 11.00, 20, 'kp1')," +
      "(?, 302, 'Meal Fries', 0, 20, 'kp2')," +
      "(?, 303, 'Meal Large Fries', 0.60, 20, 'kp2')," +
      "(?, 304, 'Meal Cola', 0, 20, NULL)," +
      "(?, 305, 'Ketchup', 0, 20, NULL)," +
      "(?, 306, 'Mayonnaise', 0.20, 20, NULL)",
    [ARMS.email, ARMS.email, ARMS.email, ARMS.email, ARMS.email, ARMS.email]
  );
  await pool.query(
    'INSERT INTO epos_modifier_groups (id, office, name, min_select, max_select, screen_id) VALUES ' +
      "(2, ?, 'Choose your side', 1, 1, 88), (3, ?, 'Choose your drink', 1, 1, 89), (4, ?, 'Sauces', 0, 0, 90)",
    [ARMS.email, ARMS.email, ARMS.email]
  );
  await pool.query(
    'INSERT INTO epos_product_modifiers (office, plu_id, group_id, sort_order) VALUES (?, 301, 2, 0), (?, 301, 3, 1), (?, 301, 4, 2)',
    [ARMS.email, ARMS.email, ARMS.email]
  );
  await pool.query(
    "INSERT INTO epos_screen_buttons (office, screen_id, kind, plu_id, label, grid_col) VALUES " +
      "(?, 88, 'product', 302, 'Fries', 0), (?, 88, 'product', 303, NULL, 1)," +
      "(?, 89, 'product', 304, 'Cola', 0), (?, 90, 'product', 305, NULL, 0), (?, 90, 'product', 306, NULL, 1)",
    [ARMS.email, ARMS.email, ARMS.email, ARMS.email, ARMS.email]
  );
  // The menu has a photograph of its fries, which the meal's "Fries" borrows;
  // the large fries and the meal have pictures of their own in Products.
  await pool.query("UPDATE dinein_items SET image_url = '/uploads/fries.jpg' WHERE id = ?", [item.fries]);
  await pool.query(
    "UPDATE bo_products SET image_url = CASE pluid WHEN 303 THEN '/uploads/large.jpg' WHEN 301 THEN '/uploads/meal.jpg' END WHERE email = ? AND pluid IN (301, 303)",
    [ARMS.email]
  );
  await pool.query(
    "INSERT INTO epos_branding (office, venue_name, address_line1, city, postcode, vat_number, footer_message) VALUES (?, 'The Kiosk Arms', '1 High Street', 'Llanelli', 'SA14 8TU', 'GB123456789', 'Diolch!')",
    [ARMS.email]
  );

  // ---- Server --------------------------------------------------------------
  const router = kiosk.expressKioskRoutes({ pool, broadcast, secret: SECRET });
  const app = express();
  app.use(express.json());
  app.use(router);
  app.use((err, _req, res, _next) => {
    console.error('        server error:', err.message);
    res.status(500).json({ error: err.message });
  });
  const server = app.listen(0);
  const base = 'http://127.0.0.1:' + server.address().port;

  // auth.vesopa.com, at the edge.
  terminalVesopa.ENABLED = true;
  let nextClaims = null;
  terminalVesopa.verifyTillToken = async (token) => {
    if (token !== 'good-token' || !nextClaims) throw new Error('bad token');
    return nextClaims;
  };
  const claimsFor = (email) => ({
    sub: 'vesopa|' + email, email, email_verified: true, name: 'Manager', jti: crypto.randomUUID(),
  });

  const armsSession = sessionFor(ARMS);
  const count = async (sql, params) => Number((await pool.query(sql, params))[0][0].n);
  const salesAtArms = () => count('SELECT COUNT(*) AS n FROM epos_orders WHERE email = ?', [ARMS.email]);
  const sessionOf = async (publicId) =>
    (await pool.query('SELECT dojo_session_id FROM epos_express_orders WHERE public_id = ?', [publicId]))[0][0].dojo_session_id;

  let kioskToken = null;
  let kioskId = null;
  const basket = () => [
    { item_id: item.burger, qty: 2, add_ons: [104] },
    { item_id: item.fries, qty: 1 },
  ];
  const cardOrder = (extra = {}) => call(base, 'POST', '/api/express/kiosk/orders', {
    token: kioskToken,
    body: {
      client_ref: crypto.randomUUID(),
      order_type: 'take_away',
      payment: 'card',
      lines: basket(),
      ...extra,
    },
  });

  try {
    console.log('Vesopa Express, against a real database\n');

    // ---- Off by default ----------------------------------------------------
    await check('it is off for a venue that has never opened the page', async () => {
      const res = await call(base, 'GET', '/api/express/settings', { token: armsSession });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(Number(res.body.enabled), 0);
      assert.strictEqual(res.body.passcode_set, false);
      assert.strictEqual(res.body.dojo_key_source, 'platform');
      assert.strictEqual(res.body.dojo_sandbox, true);
    });

    await check('a kiosk cannot be set up while it is off', async () => {
      nextClaims = claimsFor('manager@express.test');
      const res = await call(base, 'POST', '/api/express/commission', { body: { id_token: 'good-token' } });
      assert.strictEqual(res.status, 403);
      assert.strictEqual(res.body.code, 'express_off');
      assert.strictEqual(await count('SELECT COUNT(*) AS n FROM epos_express_kiosks'), 0);
    });

    await check('switching it on needs a way to start an order and a way to pay', async () => {
      let res = await call(base, 'PUT', '/api/express/settings', {
        token: armsSession, body: { enabled: true, eat_in: false, take_away: false },
      });
      assert.strictEqual(res.status, 400);
      res = await call(base, 'PUT', '/api/express/settings', {
        token: armsSession, body: { enabled: true, pay_card: false, pay_counter: false },
      });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(await count('SELECT COUNT(*) AS n FROM epos_express_settings'), 0,
        'a refused save must write nothing');
    });

    await check('the passcode is stored as PBKDF2, never returned, and checks', async () => {
      const res = await call(base, 'PUT', '/api/express/settings', {
        token: armsSession, body: { enabled: true, passcode: '2468' },
      });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(res.body.passcode_set, true);
      for (const secret of ['exit_hash', 'exit_salt', 'dojo_key_enc']) {
        assert.ok(!(secret in res.body), secret + ' was sent to the browser');
      }
      const [[row]] = await pool.query('SELECT exit_salt, exit_hash FROM epos_express_settings WHERE office = ?', [ARMS.email]);
      assert.strictEqual(row.exit_hash.length, 64);
      assert.ok(!row.exit_hash.includes('2468'));
      assert.ok(kiosk.passcodeMatches('2468', row.exit_salt, row.exit_hash));
      assert.ok(!kiosk.passcodeMatches('2469', row.exit_salt, row.exit_hash));
    });

    await check('a passcode that is not 4 to 8 digits is refused', async () => {
      const res = await call(base, 'PUT', '/api/express/settings', {
        token: armsSession, body: { passcode: '12ab' },
      });
      assert.strictEqual(res.status, 400);
    });

    await check("a venue's own Dojo key is sealed, and only its last four come back", async () => {
      const key = 'sk_sandbox_' + 'A'.repeat(30) + 'WXYZ';
      let res = await call(base, 'PUT', '/api/express/settings', { token: armsSession, body: { dojo_key: key } });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(res.body.dojo_key_source, 'venue');
      assert.strictEqual(res.body.dojo_key_hint, 'WXYZ');
      assert.ok(!JSON.stringify(res.body).includes('AAAA'), 'the key came back');
      const [[row]] = await pool.query('SELECT dojo_key_enc FROM epos_express_settings WHERE office = ?', [ARMS.email]);
      assert.ok(row.dojo_key_enc.startsWith('v1:'));
      assert.ok(!row.dojo_key_enc.includes('AAAA'));
      assert.strictEqual(kiosk.unseal(row.dojo_key_enc), key);
      res = await call(base, 'PUT', '/api/express/settings', { token: armsSession, body: { clear_dojo_key: true } });
      assert.strictEqual(res.body.dojo_key_source, 'platform');
    });

    await check('the board has a secret address as soon as it is on', async () => {
      const res = await call(base, 'GET', '/api/express/settings', { token: armsSession });
      assert.match(res.body.board_url, /\/express\/board\/[0-9a-f]{32}$/);
    });

    // ---- Commissioning -----------------------------------------------------
    await check('Continue with Vesopa sets a kiosk up and hands it its own token', async () => {
      nextClaims = claimsFor('manager@express.test');
      const res = await call(base, 'POST', '/api/express/commission', {
        body: { id_token: 'good-token', name: 'Kiosk by the door', app_version: '1.0.0+1' },
      });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(res.body.passcode_set, true);
      const claims = jwt.verify(res.body.token, SECRET);
      assert.strictEqual(claims.scope, 'express');
      assert.strictEqual(claims.office, ARMS.email);
      kioskToken = res.body.token;
      kioskId = res.body.kiosk.id;
    });

    await check('a sign-in that cannot be verified is refused, without saying why', async () => {
      const res = await call(base, 'POST', '/api/express/commission', { body: { id_token: 'forged' } });
      assert.strictEqual(res.status, 401);
      assert.strictEqual(res.body.error, 'That sign-in could not be accepted.');
    });

    await check('somebody with no back-office account cannot set a kiosk up', async () => {
      nextClaims = claimsFor('stranger@express.test');
      const res = await call(base, 'POST', '/api/express/commission', { body: { id_token: 'good-token' } });
      assert.strictEqual(res.status, 403);
    });

    await check("the kiosk's token opens the kiosk and none of the back office", async () => {
      for (const url of ['/api/express/settings', '/api/express/kiosks', '/api/express/orders']) {
        const res = await call(base, 'GET', url, { token: kioskToken });
        assert.strictEqual(res.status, 401, url + ' answered a kiosk token');
      }
    });

    await check('a session token is not a kiosk token', async () => {
      const res = await call(base, 'GET', '/api/express/kiosk/config', { token: armsSession });
      assert.strictEqual(res.status, 401);
    });

    // ---- Config and menu ---------------------------------------------------
    await check('the kiosk reads its config: an exit check, and no card until it has a machine', async () => {
      const res = await call(base, 'GET', '/api/express/kiosk/config', { token: kioskToken });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.enabled, true);
      assert.strictEqual(res.body.payments.card, false);
      assert.strictEqual(res.body.exit.algorithm, 'pbkdf2-sha256');
      assert.strictEqual(res.body.exit.iterations, kiosk.PBKDF2_ITERATIONS);
      const again = crypto.pbkdf2Sync('2468', res.body.exit.salt, res.body.exit.iterations, 32, 'sha256').toString('hex');
      assert.strictEqual(again, res.body.exit.hash, 'the kiosk could not check the passcode offline');
    });

    await check('the menu is priced from the catalogue, with its add-ons, and says what is off', async () => {
      const res = await call(base, 'GET', '/api/express/kiosk/menu', { token: kioskToken });
      assert.strictEqual(res.status, 200);
      const all = res.body.sections.flatMap((s) => s.items);
      const burger = all.find((i) => i.id === item.burger);
      assert.strictEqual(burger.price_minor, 850);
      assert.strictEqual(burger.add_ons[0].options[0].plu_id, 104);
      assert.strictEqual(burger.add_ons[0].options[0].price_minor, 100);
      assert.strictEqual(all.find((i) => i.id === item.pie).available, false);
      assert.ok(!all.some((i) => i.id === item.other), "another venue's dish is on this menu");
      assert.deepStrictEqual(res.body.upsell, [item.burger], 'popular dishes are suggested by default');
    });

    await check('the card machine list comes from Dojo, with the number on the device', async () => {
      const res = await call(base, 'GET', '/api/express/terminals', { token: armsSession });
      assert.deepStrictEqual(res.body.terminals, [{ id: 'tm_sandbox_1', tid: 'VCMtestSIS0', status: 'Available' }]);
    });

    await check('pairing a kiosk with a card machine turns card payments on', async () => {
      let res = await call(base, 'PUT', '/api/express/kiosks/' + kioskId, {
        token: armsSession, body: { dojo_terminal_id: 'tm_sandbox_1' },
      });
      assert.strictEqual(res.status, 200);
      res = await call(base, 'GET', '/api/express/kiosk/config', { token: kioskToken });
      assert.strictEqual(res.body.payments.card, true);
      assert.strictEqual(res.body.payments.sandbox, true);
    });

    await check('the kiosk is told to offer English only while the Welsh waits to be checked', async () => {
      const res = await call(base, 'GET', '/api/express/kiosk/config', { token: kioskToken });
      assert.deepStrictEqual(res.body.languages, ['en']);
    });

    await check("a kiosk ticket carries the venue's own receipt branding, and asks by default", async () => {
      const res = await call(base, 'GET', '/api/express/kiosk/config', { token: kioskToken });
      assert.deepStrictEqual(res.body.receipt, {
        mode: 'ask',
        venue_name: 'The Kiosk Arms',
        address: ['1 High Street', 'Llanelli SA14 8TU'],
        phone: null,
        vat_number: 'GB123456789',
        company_number: null,
        footer: 'Diolch!',
        footer_note: null,
      });
    });

    await check('receipts are printed always, when asked, or never, and nothing else', async () => {
      let res = await call(base, 'PUT', '/api/express/settings', { token: armsSession, body: { receipt_mode: 'sometimes' } });
      assert.strictEqual(res.status, 400);
      res = await call(base, 'PUT', '/api/express/settings', { token: armsSession, body: { receipt_mode: 'always' } });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(res.body.receipt_mode, 'always');
      const config = await call(base, 'GET', '/api/express/kiosk/config', { token: kioskToken });
      assert.strictEqual(config.body.receipt.mode, 'always');
      await call(base, 'PUT', '/api/express/settings', { token: armsSession, body: { receipt_mode: 'ask' } });
    });

    // ---- A card order, start to finish ------------------------------------
    let first = null;
    await check('an order is priced by the server and sent to the card machine once', async () => {
      const before = dojoCalls.length;
      const res = await cardOrder({ lines: [...basket(), { item_id: item.burger, qty: 1, price_minor: 1 }].slice(0, 2) });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      // 2 x (8.50 + 1.00 cheese) + 3.00 fries
      assert.strictEqual(res.body.total_minor, 2200);
      assert.strictEqual(res.body.tax_minor, Math.round(2200 * 20 / 120));
      assert.strictEqual(res.body.number, 1);
      assert.strictEqual(res.body.stage, 'present_card');
      const made = dojoCalls.slice(before);
      const intentsMade = made.filter((c) => c.method === 'POST' && c.path === '/payment-intents');
      assert.strictEqual(intentsMade.length, 1);
      assert.strictEqual(intentsMade[0].body.Amount.Value, 2200);
      assert.strictEqual(intentsMade[0].headers.Authorization, 'Basic ' + process.env.EXPRESS_DOJO_API_KEY);
      const started = made.filter((c) => c.method === 'POST' && c.path === '/terminal-sessions');
      assert.strictEqual(started.length, 1);
      assert.strictEqual(started[0].body.terminalId, 'tm_sandbox_1');
      assert.strictEqual(started[0].headers['software-house-id'], 'softwareHouse1');
      assert.strictEqual(started[0].headers['reseller-id'], 'reseller1');
      first = res.body;
    });

    await check('the same basket sent twice is the same order and the same number', async () => {
      const ref = crypto.randomUUID();
      const a = await cardOrder({ client_ref: ref });
      const intentsBefore = dojoCalls.filter((c) => c.path === '/payment-intents' && c.method === 'POST').length;
      const b = await cardOrder({ client_ref: ref });
      assert.strictEqual(b.body.public_id, a.body.public_id);
      assert.strictEqual(b.body.number, a.body.number);
      assert.strictEqual(
        dojoCalls.filter((c) => c.path === '/payment-intents' && c.method === 'POST').length,
        intentsBefore,
        'a retried POST made a second charge'
      );
      await call(base, 'POST', '/api/express/kiosk/orders/' + a.body.public_id + '/cancel', { token: kioskToken });
    });

    await check('nothing is a sale while the card is still on the machine', async () => {
      const res = await call(base, 'GET', '/api/express/kiosk/orders/' + first.public_id, { token: kioskToken });
      assert.strictEqual(res.body.stage, 'present_card');
      assert.strictEqual(await salesAtArms(), 0);
    });

    await check('a signature is accepted for an unattended kiosk', async () => {
      const sid = await sessionOf(first.public_id);
      sessions[sid].status = 'SignatureVerificationRequired';
      const res = await call(base, 'GET', '/api/express/kiosk/orders/' + first.public_id, { token: kioskToken });
      assert.strictEqual(res.body.stage, 'processing');
      assert.strictEqual(sessions[sid].signature, true);
      assert.strictEqual(await salesAtArms(), 0, 'Authorized is not paid');
    });

    let sale = null;
    await check('Captured becomes one sale, in the rows the reports read', async () => {
      capture(await sessionOf(first.public_id));
      broadcasts.length = 0;
      const res = await call(base, 'GET', '/api/express/kiosk/orders/' + first.public_id, { token: kioskToken });
      assert.strictEqual(res.body.stage, 'paid');
      assert.strictEqual(await salesAtArms(), 1);
      [[sale]] = await pool.query('SELECT * FROM epos_orders WHERE email = ?', [ARMS.email]);
      assert.strictEqual(sale.total_minor, 2200);
      assert.strictEqual(sale.tax_minor, 367);
      assert.strictEqual(sale.clerk_name, 'Vesopa Express');
      assert.strictEqual(sale.terminal, 'Kiosk by the door');
      const [lines] = await pool.query('SELECT * FROM epos_order_lines WHERE order_id = ? ORDER BY line_no', [sale.id]);
      assert.deepStrictEqual(lines.map((l) => [l.name, l.quantity, l.unit_price_minor, l.is_modifier]), [
        ['Cheeseburger', 2, 850, 0],
        ['Extra cheese', 2, 100, 1],
        ['Fries', 1, 300, 0],
      ]);
      const [[pay]] = await pool.query('SELECT * FROM epos_payments WHERE order_id = ?', [sale.id]);
      assert.strictEqual(pay.method, 'card');
      assert.strictEqual(pay.amount_minor, 2200);
      assert.strictEqual(pay.entry_mode, 'terminal');
      assert.strictEqual(pay.reference, sessions[await sessionOf(first.public_id)].intent);
      const [[stock]] = await pool.query('SELECT stock_quantity FROM bo_products WHERE email = ? AND pluid = 101', [ARMS.email]);
      assert.strictEqual(Number(stock.stock_quantity), 48, 'the sale did not move stock like a till sale');
    });

    await check("the kitchen ticket is the one a till would have fired", async () => {
      const [[ticket]] = await pool.query('SELECT * FROM epos_kitchen_tickets WHERE order_id = ?', [sale.id]);
      assert.ok(ticket, 'no ticket');
      assert.strictEqual(ticket.office, ARMS.email);
      assert.strictEqual(ticket.ticket_no, '1');
      assert.strictEqual(ticket.room_name, 'Take away');
      const [lines] = await pool.query('SELECT name, stations, is_modifier FROM epos_kitchen_ticket_lines WHERE ticket_id = ? ORDER BY seq', [ticket.id]);
      assert.deepStrictEqual(lines.map((l) => [l.name, l.stations, l.is_modifier]), [
        ['Cheeseburger', 'kp1', 0],
        // No station of its own: it goes where its burger goes.
        ['Extra cheese', 'kp1', 1],
        ['Fries', 'kp2', 0],
      ]);
      const [stations] = await pool.query('SELECT station FROM epos_kitchen_ticket_stations WHERE ticket_id = ? ORDER BY station', [ticket.id]);
      assert.deepStrictEqual(stations.map((s) => s.station), ['kp1', 'kp2']);
    });

    await check('the venue is told once it is durable, and only that venue', async () => {
      const kinds = broadcasts.map((b) => b.message.type);
      assert.ok(kinds.includes('kitchen.ticket'));
      const announced = broadcasts.find((b) => b.message.type === 'express.order');
      assert.ok(announced, 'no express.order');
      assert.strictEqual(announced.message.number, 1);
      assert.strictEqual(announced.message.notify_till, true);
      assert.ok(broadcasts.every((b) => b.office === ARMS.email), 'something went to every socket');
    });

    await check('the stations that print become jobs for a till, and the tills are told', async () => {
      // kp1 is a screen and gets no paper; kp2 is Both, so it gets the screen
      // ticket above AND a print job.
      const [jobs] = await pool.query(
        'SELECT station, status, attempts FROM epos_express_prints WHERE order_id = (SELECT id FROM epos_express_orders WHERE public_id = ?)',
        [first.public_id]
      );
      assert.deepStrictEqual(jobs.map((j) => [j.station, j.status, j.attempts]), [['kp2', 'waiting', 0]]);
      const told = broadcasts.find((b) => b.message.type === 'express.print');
      assert.ok(told, 'no express.print');
      assert.deepStrictEqual(told.message.stations, ['kp2']);
    });

    await check('a Dojo webhook for the same payment changes nothing', async () => {
      const intent = sessions[await sessionOf(first.public_id)].intent;
      await router.onDojoEvent({ paymentIntentId: intent, status: 'Captured' });
      assert.strictEqual(await salesAtArms(), 1);
      assert.strictEqual(await count('SELECT COUNT(*) AS n FROM epos_kitchen_tickets'), 1);
    });

    await check('a poll and a webhook racing each other make exactly one sale', async () => {
      const res = await cardOrder();
      const sid = await sessionOf(res.body.public_id);
      capture(sid);
      await Promise.all([
        call(base, 'GET', '/api/express/kiosk/orders/' + res.body.public_id, { token: kioskToken }),
        router.onDojoEvent({ paymentIntentId: sessions[sid].intent, status: 'Captured' }),
        call(base, 'GET', '/api/express/kiosk/orders/' + res.body.public_id, { token: kioskToken }),
        router.onDojoEvent({ paymentIntentId: sessions[sid].intent, status: 'Captured' }),
      ]);
      assert.strictEqual(await salesAtArms(), 2);
      assert.strictEqual(await count('SELECT COUNT(*) AS n FROM epos_kitchen_tickets'), 2);
      assert.strictEqual(
        await count('SELECT COUNT(*) AS n FROM epos_payments WHERE reference = ?', [sessions[sid].intent]), 1
      );
    });

    await check('a declined card keeps the order, and trying again uses the same intent', async () => {
      const res = await cardOrder();
      const sid = await sessionOf(res.body.public_id);
      sessions[sid].status = 'Declined';
      let polled = await call(base, 'GET', '/api/express/kiosk/orders/' + res.body.public_id, { token: kioskToken });
      assert.strictEqual(polled.body.stage, 'declined');
      assert.strictEqual(polled.body.status, 'awaiting_payment');
      assert.match(polled.body.message, /declined/i);

      const intentsBefore = dojoCalls.filter((c) => c.path === '/payment-intents' && c.method === 'POST').length;
      polled = await call(base, 'POST', '/api/express/kiosk/orders/' + res.body.public_id + '/retry', { token: kioskToken });
      assert.strictEqual(polled.body.stage, 'present_card');
      assert.strictEqual(
        dojoCalls.filter((c) => c.path === '/payment-intents' && c.method === 'POST').length,
        intentsBefore,
        'trying again created a second payment'
      );
      const sid2 = await sessionOf(res.body.public_id);
      assert.notStrictEqual(sid2, sid);
      assert.strictEqual(sessions[sid2].intent, sessions[sid].intent);
      capture(sid2);
      polled = await call(base, 'GET', '/api/express/kiosk/orders/' + res.body.public_id, { token: kioskToken });
      assert.strictEqual(polled.body.stage, 'paid');
      assert.strictEqual(await salesAtArms(), 3);
    });

    await check('a machine that stops answering is not a decline when the money went through', async () => {
      const res = await cardOrder();
      const sid = await sessionOf(res.body.public_id);
      sessions[sid].status = 'Expired';
      intents[sessions[sid].intent].status = 'Captured';
      const polled = await call(base, 'GET', '/api/express/kiosk/orders/' + res.body.public_id, { token: kioskToken });
      assert.strictEqual(polled.body.stage, 'paid');
      assert.strictEqual(await salesAtArms(), 4);
    });

    await check('cancelling before a card is presented leaves nothing behind', async () => {
      const res = await cardOrder();
      const cancelled = await call(base, 'POST', '/api/express/kiosk/orders/' + res.body.public_id + '/cancel', { token: kioskToken });
      assert.strictEqual(cancelled.body.status, 'cancelled');
      assert.strictEqual(sessions[await sessionOf(res.body.public_id)].status, 'Canceled');
      assert.strictEqual(await salesAtArms(), 4);
    });

    await check('a card already on the machine is not walked away from', async () => {
      const res = await cardOrder();
      const sid = await sessionOf(res.body.public_id);
      sessions[sid].status = 'Authorized';
      sessions[sid].events.push({ notificationType: 'EnterPin' });
      const refused = await call(base, 'POST', '/api/express/kiosk/orders/' + res.body.public_id + '/cancel', { token: kioskToken });
      assert.strictEqual(refused.status, 409);
      assert.strictEqual(refused.body.code, 'in_progress');
      capture(sid);
      await call(base, 'GET', '/api/express/kiosk/orders/' + res.body.public_id, { token: kioskToken });
      assert.strictEqual(await salesAtArms(), 5);
    });

    await check('a sold-out dish is refused rather than quietly dropped', async () => {
      const res = await cardOrder({ lines: [{ item_id: item.pie, qty: 1 }] });
      assert.strictEqual(res.status, 409);
      assert.match(res.body.error, /sold out/);
    });

    await check("another venue's dish cannot be bought at this kiosk", async () => {
      const res = await cardOrder({ lines: [{ item_id: item.other, qty: 1 }] });
      assert.strictEqual(res.status, 409);
    });

    await check('an empty basket is refused', async () => {
      const res = await cardOrder({ lines: [] });
      assert.strictEqual(res.status, 400);
    });

    // ---- Pay at the counter, and demo ---------------------------------------
    await check('pay at the counter goes to the till queue, unpaid, and is not a sale', async () => {
      await call(base, 'PUT', '/api/express/settings', { token: armsSession, body: { pay_counter: true, ask_name: true } });
      const missingName = await cardOrder({ payment: 'counter' });
      assert.strictEqual(missingName.status, 400, 'a venue that asks for a name got an order without one');
      broadcasts.length = 0;
      const res = await cardOrder({ payment: 'counter', name: '  Rhys  ', order_type: 'eat_in' });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      assert.strictEqual(res.body.status, 'counter');
      assert.strictEqual(res.body.customer_name, 'Rhys');
      const [[queued]] = await pool.query('SELECT * FROM dinein_orders WHERE office_id = ?', [ARMS.id]);
      assert.strictEqual(queued.status, 'placed');
      assert.strictEqual(queued.total_minor, 2200);
      assert.strictEqual(queued.table_label, 'Kiosk ' + res.body.number);
      const [lines] = await pool.query('SELECT name, parent_line_id, is_modifier FROM dinein_order_lines WHERE dinein_order_id = ? ORDER BY id', [queued.id]);
      assert.strictEqual(lines.length, 3);
      assert.strictEqual(lines[1].is_modifier, 1);
      assert.ok(lines[1].parent_line_id, 'the cheese lost its burger');
      assert.ok(broadcasts.some((b) => b.message.type === 'dinein.order' && b.office === ARMS.email));
      assert.strictEqual(await salesAtArms(), 5);
      await call(base, 'PUT', '/api/express/settings', { token: armsSession, body: { ask_name: false } });
    });

    await check('demo mode takes no money and sends nothing to the kitchen', async () => {
      await call(base, 'PUT', '/api/express/settings', { token: armsSession, body: { demo_mode: true } });
      const calls = dojoCalls.length;
      const tickets = await count('SELECT COUNT(*) AS n FROM epos_kitchen_tickets');
      const res = await cardOrder();
      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.body.status, 'demo');
      assert.strictEqual(dojoCalls.length, calls, 'demo mode talked to Dojo');
      assert.strictEqual(await salesAtArms(), 5);
      assert.strictEqual(await count('SELECT COUNT(*) AS n FROM epos_kitchen_tickets'), tickets);
      await call(base, 'PUT', '/api/express/settings', { token: armsSession, body: { demo_mode: false } });
    });

    // ---- The board ---------------------------------------------------------
    let boardToken = null;
    await check('the board shows numbers and nothing else', async () => {
      const settings = await call(base, 'GET', '/api/express/settings', { token: armsSession });
      boardToken = settings.body.board_url.split('/').pop();
      const res = await call(base, 'GET', '/express/board/' + boardToken + '/data');
      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(Object.keys(res.body).sort(), ['preparing', 'ready', 'server_time']);
      assert.ok(res.body.preparing.includes(1));
      assert.ok(res.body.preparing.every((n) => typeof n === 'number'));
      const page = await call(base, 'GET', '/express/board/' + boardToken);
      assert.strictEqual(page.status, 200);
      assert.ok(String(page.body).includes('Ready to collect'));
      assert.ok(String(page.body).includes(ARMS.name));
    });

    await check('a number moves to Ready when the kitchen finishes it', async () => {
      await pool.query(
        "UPDATE epos_kitchen_ticket_stations s JOIN epos_kitchen_tickets t ON t.id = s.ticket_id SET s.status = 'done' WHERE t.ticket_no = '1'"
      );
      const res = await call(base, 'GET', '/express/board/' + boardToken + '/data');
      assert.ok(res.body.ready.includes(1), JSON.stringify(res.body));
      assert.ok(!res.body.preparing.includes(1));
    });

    await check('a board address that is wrong, or was replaced, shows nothing', async () => {
      assert.strictEqual((await call(base, 'GET', '/express/board/' + 'f'.repeat(32) + '/data')).status, 404);
      assert.strictEqual((await call(base, 'GET', '/express/board/not-a-token/data')).status, 404);
      await call(base, 'PUT', '/api/express/settings', { token: armsSession, body: { rotate_board: true } });
      assert.strictEqual((await call(base, 'GET', '/express/board/' + boardToken + '/data')).status, 404);
    });

    // ---- Looking after payments nobody is watching ---------------------------
    await check('the sweep finishes a payment the kiosk walked away from', async () => {
      const res = await cardOrder();
      const sid = await sessionOf(res.body.public_id);
      intents[sessions[sid].intent].status = 'Captured';
      await pool.query("UPDATE epos_express_orders SET created_at = NOW() - INTERVAL 5 MINUTE WHERE public_id = ?", [res.body.public_id]);
      const before = await salesAtArms();
      await call(base, 'GET', '/api/express/orders', { token: armsSession });
      assert.strictEqual(await salesAtArms(), before + 1);
    });

    await check('and closes a basket nobody paid for', async () => {
      const res = await cardOrder();
      await pool.query("UPDATE epos_express_orders SET created_at = NOW() - INTERVAL 40 MINUTE WHERE public_id = ?", [res.body.public_id]);
      await call(base, 'GET', '/api/express/orders', { token: armsSession });
      const [[row]] = await pool.query('SELECT status FROM epos_express_orders WHERE public_id = ?', [res.body.public_id]);
      assert.strictEqual(row.status, 'failed');
    });

    await check('staff can move a number along by hand', async () => {
      const [[paid]] = await pool.query("SELECT id FROM epos_express_orders WHERE office = ? AND status = 'paid' LIMIT 1", [ARMS.email]);
      let res = await call(base, 'POST', '/api/express/orders/' + paid.id + '/collected', { token: armsSession });
      assert.strictEqual(res.body.status, 'collected');
      res = await call(base, 'POST', '/api/express/orders/' + paid.id + '/ready', { token: armsSession });
      assert.strictEqual(res.status, 409, 'a collected order went backwards');
    });

    // ---- The till: kiosk orders, and the kitchen printers -------------------
    const till = tillFor(ARMS);
    let printed = null;
    await check('a till sees the paid kiosk orders; a kiosk or back-office token does not', async () => {
      const res = await cardOrder();
      capture(await sessionOf(res.body.public_id));
      await call(base, 'GET', '/api/express/kiosk/orders/' + res.body.public_id, { token: kioskToken });
      [[printed]] = await pool.query('SELECT * FROM epos_express_orders WHERE public_id = ?', [res.body.public_id]);
      assert.strictEqual(printed.status, 'paid');

      const list = await call(base, 'GET', '/till/express/orders', { token: till });
      assert.strictEqual(list.status, 200, JSON.stringify(list.body));
      assert.strictEqual(list.body.enabled, true);
      assert.strictEqual(list.body.notify_till, true);
      const mine = list.body.orders.find((o) => o.id === printed.id);
      assert.ok(mine, 'the paid order is not on the till');
      assert.strictEqual(mine.number, printed.number);
      assert.strictEqual(mine.kiosk, 'Kiosk by the door');
      assert.deepStrictEqual(mine.lines.map((l) => [l.name, l.qty, l.is_modifier]), [
        ['Cheeseburger', 2, false], ['Extra cheese', 2, true], ['Fries', 1, false],
      ]);
      assert.ok(list.body.orders.every((o) => ['paid', 'ready'].includes(o.status)));

      for (const token of [kioskToken, armsSession]) {
        const refused = await call(base, 'GET', '/till/express/orders', { token });
        assert.strictEqual(refused.status, 401);
      }
    });

    let won = null;
    await check('two tills claiming one ticket: exactly one of them prints it', async () => {
      const queue = await call(base, 'GET', '/till/express/print-queue', { token: till });
      const job = queue.body.jobs.find((j) => j.order_id === printed.id);
      assert.deepStrictEqual(job, { order_id: printed.id, stations: ['kp2'] });

      const [a, b] = await Promise.all([
        call(base, 'POST', '/till/express/print-queue/' + printed.id + '/claim', { token: till, body: { stations: ['kp2'], terminal: 'Till 1' } }),
        call(base, 'POST', '/till/express/print-queue/' + printed.id + '/claim', { token: till, body: { stations: ['kp2'], terminal: 'Till 2' } }),
      ]);
      const winners = [a, b].filter((r) => r.body.stations.length);
      assert.strictEqual(winners.length, 1, JSON.stringify([a.body, b.body]));
      won = winners[0].body;
      // The same thing in a fixed order, which the pair above cannot promise to
      // exercise: a third till asking a moment later gets nothing, and the
      // claim on the row is still the winner's.
      const late = await call(base, 'POST', '/till/express/print-queue/' + printed.id + '/claim', {
        token: till, body: { stations: ['kp2'], terminal: 'Till 3' },
      });
      assert.deepStrictEqual(late.body.stations, [], 'a claimed ticket was taken off its till');
      const [[row]] = await pool.query('SELECT claim_id FROM epos_express_prints WHERE order_id = ?', [printed.id]);
      assert.strictEqual(row.claim_id, won.claim_id);
      assert.deepStrictEqual(won.stations, ['kp2']);
      // The fryer's paper carries the fryer's lines and nothing else.
      assert.strictEqual(won.ticket.number, printed.number);
      assert.strictEqual(won.ticket.order_type_label, 'Take away');
      assert.strictEqual(won.ticket.kiosk, 'Kiosk by the door');
      assert.deepStrictEqual(won.ticket.lines.map((l) => [l.name, l.qty, l.stations]), [['Fries', 1, ['kp2']]]);

      const again = await call(base, 'GET', '/till/express/print-queue', { token: till });
      assert.ok(!again.body.jobs.some((j) => j.order_id === printed.id), 'a claimed ticket was offered again');
    });

    await check("a printer that fails puts the ticket back, in the printer's own words", async () => {
      await call(base, 'POST', '/till/express/print-queue/' + printed.id + '/result', {
        token: till, body: { claim_id: won.claim_id, results: [{ station: 'kp2', ok: false, error: 'Out of paper' }] },
      });
      const [[job]] = await pool.query('SELECT status, error, attempts FROM epos_express_prints WHERE order_id = ?', [printed.id]);
      assert.deepStrictEqual([job.status, job.error, job.attempts], ['failed', 'Out of paper', 1]);
      const queue = await call(base, 'GET', '/till/express/print-queue', { token: till });
      assert.ok(queue.body.jobs.some((j) => j.order_id === printed.id), 'a failed ticket was not offered again');

      const retry = await call(base, 'POST', '/till/express/print-queue/' + printed.id + '/claim', {
        token: till, body: { stations: ['kp2'], terminal: 'Till 1' },
      });
      assert.deepStrictEqual(retry.body.stations, ['kp2']);
      won = retry.body;
    });

    await check('a ticket that printed is done, and the back office says where', async () => {
      // A result under somebody else's claim changes nothing.
      const wrong = await call(base, 'POST', '/till/express/print-queue/' + printed.id + '/result', {
        token: till, body: { claim_id: crypto.randomUUID(), results: [{ station: 'kp2', ok: true }] },
      });
      assert.strictEqual(wrong.body.updated, 0);
      const ok = await call(base, 'POST', '/till/express/print-queue/' + printed.id + '/result', {
        token: till, body: { claim_id: won.claim_id, results: [{ station: 'kp2', ok: true }] },
      });
      assert.strictEqual(ok.body.updated, 1);
      const queue = await call(base, 'GET', '/till/express/print-queue', { token: till });
      assert.ok(!queue.body.jobs.some((j) => j.order_id === printed.id));
      const orders = await call(base, 'GET', '/api/express/orders', { token: armsSession });
      const row = orders.body.orders.find((o) => o.id === printed.id);
      assert.deepStrictEqual(row.prints, [{ station: 'kp2', name: 'Fryer', status: 'printed', by: 'Till 1', error: null }]);
    });

    await check("another venue's till can neither see nor take this venue's ticket", async () => {
      const res = await cardOrder();
      capture(await sessionOf(res.body.public_id));
      await call(base, 'GET', '/api/express/kiosk/orders/' + res.body.public_id, { token: kioskToken });
      const [[order]] = await pool.query('SELECT id FROM epos_express_orders WHERE public_id = ?', [res.body.public_id]);
      const other = tillFor(OTHER);
      await call(base, 'PUT', '/api/express/settings', { token: sessionFor(OTHER), body: { enabled: true } });
      const queue = await call(base, 'GET', '/till/express/print-queue', { token: other });
      assert.ok(!queue.body.jobs.some((j) => j.order_id === order.id));
      const claim = await call(base, 'POST', '/till/express/print-queue/' + order.id + '/claim', {
        token: other, body: { stations: ['kp2'], terminal: 'Their till' },
      });
      assert.deepStrictEqual(claim.body.stations, []);
      const move = await call(base, 'POST', '/till/express/orders/' + order.id + '/ready', { token: other });
      assert.strictEqual(move.status, 409);
      await call(base, 'PUT', '/api/express/settings', { token: sessionFor(OTHER), body: { enabled: false } });
    });

    await check('a claim that went quiet is offered again, and a stale ticket is never printed', async () => {
      const [[job]] = await pool.query(
        "SELECT order_id FROM epos_express_prints WHERE office = ? AND status = 'waiting' ORDER BY order_id DESC LIMIT 1",
        [ARMS.email]
      );
      const first = await call(base, 'POST', '/till/express/print-queue/' + job.order_id + '/claim', {
        token: till, body: { stations: ['kp2'], terminal: 'Till 3' },
      });
      assert.deepStrictEqual(first.body.stations, ['kp2']);
      await pool.query('UPDATE epos_express_prints SET claimed_at = NOW() - INTERVAL 3 MINUTE WHERE order_id = ?', [job.order_id]);
      let queue = await call(base, 'GET', '/till/express/print-queue', { token: till });
      assert.ok(queue.body.jobs.some((j) => j.order_id === job.order_id), 'a dead claim held the ticket for ever');

      await pool.query('UPDATE epos_express_prints SET created_at = NOW() - INTERVAL 31 MINUTE WHERE order_id = ?', [job.order_id]);
      queue = await call(base, 'GET', '/till/express/print-queue', { token: till });
      assert.ok(!queue.body.jobs.some((j) => j.order_id === job.order_id), 'lunch printed at six');
      const [[after]] = await pool.query('SELECT status FROM epos_express_prints WHERE order_id = ?', [job.order_id]);
      assert.strictEqual(after.status, 'expired');
      const late = await call(base, 'POST', '/till/express/print-queue/' + job.order_id + '/claim', {
        token: till, body: { stations: ['kp2'], terminal: 'Till 3' },
      });
      assert.deepStrictEqual(late.body.stations, []);
    });

    await check('a till moves a number to Ready and then Collected', async () => {
      let res = await call(base, 'POST', '/till/express/orders/' + printed.id + '/ready', { token: till });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(res.body.status, 'ready');
      res = await call(base, 'POST', '/till/express/orders/' + printed.id + '/ready', { token: till });
      assert.strictEqual(res.status, 409);
      res = await call(base, 'POST', '/till/express/orders/' + printed.id + '/collected', { token: till });
      assert.strictEqual(res.body.status, 'collected');
      const list = await call(base, 'GET', '/till/express/orders', { token: till });
      assert.ok(!list.body.orders.some((o) => o.id === printed.id), 'a collected order stayed on the till');
    });

    await check('a venue that sends kiosk orders to no kitchen gets no paper either', async () => {
      await call(base, 'PUT', '/api/express/settings', { token: armsSession, body: { notify_kitchen: false } });
      const res = await cardOrder();
      capture(await sessionOf(res.body.public_id));
      await call(base, 'GET', '/api/express/kiosk/orders/' + res.body.public_id, { token: kioskToken });
      assert.strictEqual(
        await count('SELECT COUNT(*) AS n FROM epos_express_prints WHERE order_id = (SELECT id FROM epos_express_orders WHERE public_id = ?)', [res.body.public_id]),
        0
      );
      const queue = await call(base, 'GET', '/till/express/print-queue', { token: till });
      assert.deepStrictEqual(queue.body.jobs, []);
      await call(base, 'PUT', '/api/express/settings', { token: armsSession, body: { notify_kitchen: true } });
    });

    // ---- Meals -----------------------------------------------------------------
    let mealId = null;
    await check('a meal has to be its own product, offered on one of your own dishes', async () => {
      const add = (body, token = armsSession) => call(base, 'POST', '/api/express/meals', { token, body });
      let res = await add({ item_id: item.burger, plu_id: 101 });
      assert.strictEqual(res.status, 400, 'the burger became its own meal');
      res = await add({ item_id: item.other, plu_id: 301 });
      assert.strictEqual(res.status, 404, "a meal went onto another venue's dish");
      res = await add({ item_id: item.burger, plu_id: 9999 });
      assert.strictEqual(res.status, 404);
      res = await add({ item_id: item.burger, plu_id: 301, label: 'Regular' });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      mealId = res.body.id;
      res = await add({ item_id: item.burger, plu_id: 301 });
      assert.strictEqual(res.status, 409);
      res = await add({ item_id: item.burger, plu_id: 301 }, sessionFor(OTHER));
      assert.strictEqual(res.status, 404);
    });

    await check('the Meals page shows each meal with its price and the steps it walks through', async () => {
      const res = await call(base, 'GET', '/api/express/meals', { token: armsSession });
      assert.strictEqual(res.status, 200);
      const burger = res.body.items.find((i) => i.id === item.burger);
      assert.strictEqual(burger.meals.length, 1);
      const meal = burger.meals[0];
      assert.deepStrictEqual([meal.name, meal.label, meal.price_minor], ['Cheeseburger Meal', 'Regular', 1100]);
      assert.deepStrictEqual(
        meal.steps.map((s) => [s.name, s.min_select, s.max_select, s.options.length]),
        // "As many as you like" arrives as the number of answers, not 0 or 1.
        [['Choose your side', 1, 1, 2], ['Choose your drink', 1, 1, 1], ['Sauces', 0, 2, 2]]
      );
      const fries = res.body.items.find((i) => i.id === item.fries);
      assert.deepStrictEqual(fries.meals, []);
    });

    await check("the kiosk menu offers the meal, its steps, and the menu's own pictures", async () => {
      const res = await call(base, 'GET', '/api/express/kiosk/menu', { token: kioskToken });
      const burger = res.body.sections.flatMap((s) => s.items).find((i) => i.id === item.burger);
      const side = burger.meals[0].steps[0];
      assert.deepStrictEqual(
        side.options.map((o) => [o.plu_id, o.name, o.price_minor, o.image_url]),
        [[302, 'Fries', 0, '/uploads/fries.jpg'], [303, 'Meal Large Fries', 60, '/uploads/large.jpg']]
      );
      assert.strictEqual(burger.meals[0].image_url, '/uploads/meal.jpg');
      assert.strictEqual(burger.meals[0].steps[1].options[0].image_url, null, 'a picture came from nowhere');
      assert.deepStrictEqual(burger.add_ons.map((g) => g.name), ['Extras'], 'the dish kept its own questions');
    });

    let mealOrder = null;
    await check('a meal is priced from the meal product, and its answers from the catalogue', async () => {
      const res = await cardOrder({
        lines: [{ item_id: item.burger, qty: 2, meal_plu: 301, add_ons: [303, 304, 306] }],
      });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      // 2 x (11.00 meal + 0.60 large fries + 0 cola + 0.20 mayonnaise)
      assert.strictEqual(res.body.total_minor, 2360);
      assert.deepStrictEqual(res.body.lines.map((l) => [l.name, l.plu_id, l.qty, l.unit, l.isModifier]), [
        ['Cheeseburger Meal', 301, 2, 1100, false],
        ['Meal Large Fries', 303, 2, 60, true],
        ['Meal Cola', 304, 2, 0, true],
        ['Mayonnaise', 306, 2, 20, true],
      ]);
      mealOrder = res.body;
    });

    await check('a meal without its drink, or with two sides, is refused', async () => {
      let res = await cardOrder({ lines: [{ item_id: item.burger, qty: 1, meal_plu: 301, add_ons: [302] }] });
      assert.strictEqual(res.status, 400);
      assert.match(res.body.error, /still needs: Choose your drink/);
      res = await cardOrder({ lines: [{ item_id: item.burger, qty: 1, meal_plu: 301, add_ons: [302, 303, 304] }] });
      assert.strictEqual(res.status, 400);
      assert.match(res.body.error, /too many choices for Choose your side/);
    });

    await check('a meal the dish does not offer is refused rather than priced', async () => {
      let res = await cardOrder({ lines: [{ item_id: item.burger, qty: 1, meal_plu: 102, add_ons: [] }] });
      assert.strictEqual(res.status, 409, 'a crafted meal_plu was priced');
      res = await cardOrder({ lines: [{ item_id: item.fries, qty: 1, meal_plu: 301, add_ons: [302, 304] }] });
      assert.strictEqual(res.status, 409, "the fries were sold as the burger's meal");
    });

    await check("answers are checked against the line's own questions, not the whole basket's", async () => {
      // The cheese answers the burger's question, not the meal's and not the
      // fries'. On either of those it is dropped, and not charged.
      const res = await cardOrder({
        lines: [
          { item_id: item.burger, qty: 1, meal_plu: 301, add_ons: [302, 304, 104] },
          { item_id: item.fries, qty: 1, add_ons: [104] },
          { item_id: item.burger, qty: 1, add_ons: [104] },
        ],
      });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      // 11.00 + 0 + 0, then 3.00, then 8.50 + 1.00
      assert.strictEqual(res.body.total_minor, 2350);
      await call(base, 'POST', '/api/express/kiosk/orders/' + res.body.public_id + '/cancel', { token: kioskToken });
    });

    await check("a meal's side and drink travel on the meal's ticket, as the till sends them", async () => {
      capture(await sessionOf(mealOrder.public_id));
      await call(base, 'GET', '/api/express/kiosk/orders/' + mealOrder.public_id, { token: kioskToken });
      const [[order]] = await pool.query('SELECT sale_id, ticket_id, id FROM epos_express_orders WHERE public_id = ?', [mealOrder.public_id]);
      const [lines] = await pool.query('SELECT name, stations FROM epos_kitchen_ticket_lines WHERE ticket_id = ? ORDER BY seq', [order.ticket_id]);
      assert.deepStrictEqual(lines.map((l) => [l.name, l.stations]), [
        ['Cheeseburger Meal', 'kp1'],
        // Routed to the fryer on its own, and still on the grill's ticket: an
        // answer goes where its dish goes.
        ['Meal Large Fries', 'kp1'],
        ['Meal Cola', 'kp1'],
        ['Mayonnaise', 'kp1'],
      ]);
      const [saleLines] = await pool.query('SELECT name, unit_price_minor FROM epos_order_lines WHERE order_id = ? ORDER BY line_no', [order.sale_id]);
      assert.deepStrictEqual(saleLines.map((l) => [l.name, l.unit_price_minor]),
        [['Cheeseburger Meal', 1100], ['Meal Large Fries', 60], ['Meal Cola', 0], ['Mayonnaise', 20]]);
      assert.strictEqual(
        await count('SELECT COUNT(*) AS n FROM epos_express_prints WHERE order_id = ?', [order.id]), 0,
        'the grill is a screen: nothing to print'
      );
    });

    await check('a meal can be renamed and taken away again', async () => {
      let res = await call(base, 'PUT', '/api/express/meals/' + mealId, { token: armsSession, body: { label: 'Large' } });
      assert.strictEqual(res.status, 200);
      res = await call(base, 'PUT', '/api/express/meals/' + mealId, { token: sessionFor(OTHER), body: { label: 'Theirs' } });
      assert.strictEqual(res.status, 404);
      res = await call(base, 'DELETE', '/api/express/meals/' + mealId, { token: sessionFor(OTHER) });
      assert.strictEqual(res.status, 404);
      res = await call(base, 'DELETE', '/api/express/meals/' + mealId, { token: armsSession });
      assert.strictEqual(res.status, 200);
      const menu = await call(base, 'GET', '/api/express/kiosk/menu', { token: kioskToken });
      const burger = menu.body.sections.flatMap((s) => s.items).find((i) => i.id === item.burger);
      assert.deepStrictEqual(burger.meals, []);
    });

    // ---- Tenancy -----------------------------------------------------------
    await check("another venue's kiosk cannot read this venue's order", async () => {
      await call(base, 'PUT', '/api/express/settings', { token: sessionFor(OTHER), body: { enabled: true } });
      nextClaims = claimsFor('boss@other.test');
      const other = await call(base, 'POST', '/api/express/commission', { body: { id_token: 'good-token' } });
      assert.strictEqual(other.status, 200, JSON.stringify(other.body));
      const res = await call(base, 'GET', '/api/express/kiosk/orders/' + first.public_id, { token: other.body.token });
      assert.strictEqual(res.status, 404);
      const orders = await call(base, 'GET', '/api/express/orders', { token: sessionFor(OTHER) });
      assert.strictEqual(orders.body.orders.length, 0);
    });

    // ---- Switching off, and taking a kiosk away ------------------------------
    await check('switched off: the kiosk is told, and orders are refused', async () => {
      await call(base, 'PUT', '/api/express/settings', { token: armsSession, body: { enabled: false } });
      const config = await call(base, 'GET', '/api/express/kiosk/config', { token: kioskToken });
      assert.strictEqual(config.status, 200);
      assert.strictEqual(config.body.enabled, false);
      assert.ok(config.body.exit, 'a switched-off kiosk must still be leavable');
      const order = await cardOrder();
      assert.strictEqual(order.status, 403);
      assert.strictEqual(order.body.code, 'express_off');
      await call(base, 'PUT', '/api/express/settings', { token: armsSession, body: { enabled: true } });
    });

    await check('a removed kiosk stops at once', async () => {
      const res = await call(base, 'DELETE', '/api/express/kiosks/' + kioskId, { token: armsSession });
      assert.strictEqual(res.status, 200);
      const config = await call(base, 'GET', '/api/express/kiosk/config', { token: kioskToken });
      assert.strictEqual(config.status, 401);
      assert.strictEqual(config.body.code, 'kiosk_revoked');
    });

    // ---- The pure pieces -----------------------------------------------------
    await check('what the kiosk is told, for every state an order can be in', async () => {
      const s = (o) => kiosk.paymentStage({ status: 'awaiting_payment', dojo_session_id: 'ts', ...o });
      assert.strictEqual(s({ dojo_session_id: null }), 'starting');
      assert.strictEqual(s({ dojo_status: 'InitiateRequested', dojo_prompt: 'PresentCard' }), 'present_card');
      assert.strictEqual(s({ dojo_status: 'Authorized', dojo_prompt: 'EnterPin' }), 'processing');
      assert.strictEqual(s({ dojo_status: 'SignatureVerificationRequired' }), 'processing');
      assert.strictEqual(s({ dojo_status: 'Declined' }), 'declined');
      assert.strictEqual(s({ dojo_status: 'Expired' }), 'uncertain');
      assert.strictEqual(s({ dojo_status: 'Unavailable', dojo_session_id: null }), 'unavailable');
      assert.strictEqual(s({ status: 'paid' }), 'paid');
      assert.strictEqual(s({ status: 'collected' }), 'paid');
      assert.strictEqual(s({ status: 'cancelled' }), 'cancelled');
    });

    await check("the business day is the UK's, not the server clock's", async () => {
      // 23:30 UTC on 30 June is half past midnight on 1 July in London.
      assert.strictEqual(kiosk.businessDate(new Date('2026-06-30T23:30:00Z')), '2026-07-01');
      assert.strictEqual(kiosk.businessDate(new Date('2026-12-31T23:30:00Z')), '2026-12-31');
    });
  } finally {
    server.close();
    await pool.end();
    const drop = await mysql.createConnection({ host: HOST, user: USER, password: PASS });
    await drop.query(`DROP DATABASE IF EXISTS ${DB}`);
    await drop.end();
  }

  console.log(`\n  ${passed} passed, ${failed} failed`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
