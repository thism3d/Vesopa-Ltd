/**
 * Memberships on Vesopa Express: joining and renewing at the kiosk, against a
 * real MySQL/MariaDB like express.test.js and memberships.test.js. Skips
 * cleanly when no database is reachable.
 *
 * THE RULES THAT MATTER
 *
 *   1. Nothing about memberships answers -- and the kiosk is not told to offer
 *      them -- for a venue without the Memberships module on.
 *   2. Finding a member says a first name, a plan, a state, a date and a price,
 *      never an email address or a phone number; and a wrong surname is the
 *      same "not found" as an unknown email.
 *   3. The price is the server's: the plan's fee to renew, fee plus joining
 *      fee to join, whatever the kiosk sends.
 *   4. Nothing moves until the money is in, and then it moves once -- however
 *      many times the poll, the webhook and the sweep say "paid".
 *
 * Dojo is faked at the edge by replacing `fetch`, as express.test.js does.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');

// Read when the module loads.
process.env.EXPRESS_SECRET_KEY = 'express-memberships-sealing-key';
process.env.EXPRESS_DOJO_API_KEY = 'sk_sandbox_' + 'test-only-not-a-key';
process.env.EXPRESS_SESSION_CACHE_MS = '0';
process.env.EXPRESS_SWEEP_MS = '0';

const SECRET = 'express-memberships-test-secret';
const kiosk = require('../src/express_kiosk');
const { setAllowed } = require('../src/modules');
const memberships = require('../src/memberships');

const DB = process.env.EXPRESS_MEMBERSHIPS_TEST_DB || 'vesopa_express_memberships_selftest';
const USER = process.env.EXPRESS_TEST_USER || process.env.DINEIN_TEST_USER || 'root';
const PASS = process.env.EXPRESS_TEST_PASS || process.env.DINEIN_TEST_PASS || '';
const HOST = process.env.EXPRESS_TEST_HOST || '127.0.0.1';

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
    console.error(`        ${e.stack || e.message}`);
    process.exitCode = 1;
  }
}

const GYM = { id: 1, name: 'Iron Gym', email: 'iron@kiosk-members.test' };
const PUB = { id: 2, name: 'The Arms', email: 'arms@kiosk-members.test' };

async function applySchema(conn, file) {
  const migration = fs.readFileSync(path.join(__dirname, '..', 'schema', file), 'utf8');
  let delimiter = ';';
  let buffer = '';
  for (const line of migration.split(/\r?\n/)) {
    const d = /^DELIMITER\s+(\S+)/.exec(line.trim());
    if (d) { delimiter = d[1]; continue; }
    if (line.trim().startsWith('--') && !buffer.trim()) continue;
    buffer += line + '\n';
    if (buffer.trimEnd().endsWith(delimiter)) {
      const sql = buffer.trimEnd().slice(0, -delimiter.length).trim();
      if (sql) await conn.query(sql);
      buffer = '';
    }
  }
}

// ---------------------------------------------------------------------------
// A pretend Dojo (the same shape as express.test.js's)
// ---------------------------------------------------------------------------
const sessions = {};
const intents = {};
let nextIntent = 1;
let nextSession = 1;
const reply = (status, json) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: String(status),
  text: async () => JSON.stringify(json),
});
const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  if (u.hostname !== 'api.dojo.tech') return realFetch(url, opts);
  const method = opts.method || 'GET';
  const body = opts.body ? JSON.parse(opts.body) : null;
  let m;
  if (u.pathname === '/payment-intents' && method === 'POST') {
    const id = 'pi_sandbox_m' + nextIntent++;
    intents[id] = { status: 'Created', amount: body.Amount.Value };
    return reply(200, { id, status: 'Created' });
  }
  if ((m = /^\/payment-intents\/([^/]+)$/.exec(u.pathname)) && method === 'GET') {
    return reply(200, { id: m[1], status: (intents[m[1]] || {}).status || 'Created' });
  }
  if (u.pathname === '/terminal-sessions' && method === 'POST') {
    const id = 'ts_m' + nextSession++;
    sessions[id] = {
      status: 'InitiateRequested',
      events: [{ notificationType: 'PresentCard' }],
      intent: body.details.sale.paymentIntentId,
    };
    return reply(200, { id, status: 'InitiateRequested' });
  }
  if ((m = /^\/terminal-sessions\/([^/]+)$/.exec(u.pathname)) && method === 'GET') {
    const s = sessions[m[1]];
    return reply(200, { id: m[1], status: s.status, notificationEvents: s.events });
  }
  return reply(404, { title: 'Not faked: ' + method + ' ' + u.pathname });
};

function capture(sessionId) {
  const s = sessions[sessionId];
  s.status = 'Captured';
  s.events.push({ notificationType: 'RemoveCard' });
  intents[s.intent].status = 'Captured';
}

function call(server, method, url, token, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: server.address().port, method, path: url,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function main() {
  let admin;
  try {
    admin = await mysql.createConnection({ host: HOST, user: USER, password: PASS, multipleStatements: true });
  } catch (e) {
    console.log(`-- no database reachable, skipping (${e.code || e.message})`);
    return;
  }
  await admin.query(`DROP DATABASE IF EXISTS ${DB}; CREATE DATABASE ${DB} CHARACTER SET utf8mb4;`);
  await admin.query(`USE ${DB}`);
  // The two tables schema.sql does not make and the others alter.
  await admin.query(`CREATE TABLE backoffice_users (
    id INT AUTO_INCREMENT PRIMARY KEY, email VARCHAR(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
    password VARCHAR(255), name VARCHAR(190), company VARCHAR(190), approved CHAR(1), office_id INT NULL,
    UNIQUE KEY email (email)) ENGINE=InnoDB`);
  await admin.query(`CREATE TABLE bo_products (
    id int(11) NOT NULL AUTO_INCREMENT PRIMARY KEY, email varchar(255) NOT NULL, pluid int(11) NOT NULL,
    product_name varchar(255) DEFAULT NULL, price double DEFAULT NULL, tax_percentage double DEFAULT NULL,
    stock_quantity double DEFAULT NULL, cost_price double DEFAULT NULL, low_stock_at double DEFAULT NULL,
    printer_route varchar(32) DEFAULT NULL, printer_routes varchar(64) DEFAULT NULL,
    UNIQUE KEY uq_bo_products_venue_plu (email, pluid)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb3`);

  // Every schema file, in the deploy's order, twice: the second pass proves
  // each is safe to run again. schema_till_express_memberships.sql sorts after
  // schema_till_express.sql, which makes epos_express_orders.
  const mustApply = /^schema_(customers|loyalty_schemes|venue_modules|memberships|till_express|till_express_memberships)\.sql$/;
  const files = ['schema.sql', ...fs.readdirSync(path.join(__dirname, '..', 'schema'))
    .filter((f) => /^schema_.*\.sql$/.test(f)).sort()];
  for (let pass = 0; pass < 2; pass++) {
    for (const f of files) {
      try {
        await applySchema(admin, f);
      } catch (e) {
        if (mustApply.test(f)) throw new Error(`${f} (pass ${pass + 1}): ${e.message}`);
      }
    }
  }
  await admin.end();

  const pool = mysql.createPool({ host: HOST, user: USER, password: PASS, database: DB, connectionLimit: 6, dateStrings: false });
  await pool.query('INSERT INTO offices (id, name, contact_email) VALUES (?,?,?), (?,?,?)',
    [GYM.id, GYM.name, GYM.email, PUB.id, PUB.name, PUB.email]);
  for (const o of [GYM, PUB]) {
    await pool.query(
      'INSERT INTO epos_express_settings (office, enabled, eat_in, take_away, pay_card) VALUES (?, 1, 1, 1, 1)',
      [o.email]
    );
  }
  const kioskIds = { gym: crypto.randomUUID(), gym2: crypto.randomUUID(), pub: crypto.randomUUID() };
  await pool.query(
    "INSERT INTO epos_express_kiosks (id, office, name, dojo_terminal_id) VALUES (?, ?, 'Gym door', 'tm_sandbox_1')," +
      " (?, ?, 'Gym bar', 'tm_sandbox_2'), (?, ?, 'Pub kiosk', 'tm_sandbox_3')",
    [kioskIds.gym, GYM.email, kioskIds.gym2, GYM.email, kioskIds.pub, PUB.email]
  );
  const tokenFor = (office, id) =>
    jwt.sign({ scope: 'express', office: office.email, officeId: office.id, kiosk: id }, SECRET, { expiresIn: '1h' });
  const gymKiosk = tokenFor(GYM, kioskIds.gym);
  const gymKiosk2 = tokenFor(GYM, kioskIds.gym2);
  const pubKiosk = tokenFor(PUB, kioskIds.pub);

  const broadcasts = [];
  const router = kiosk.expressKioskRoutes({ pool, broadcast: (m) => broadcasts.push(m), secret: SECRET });
  const app = express();
  app.use(express.json());
  app.use(router);
  app.use((err, _req, res, _next) => { console.error(err); res.status(500).json({ error: err.message }); });
  const server = app.listen(0);

  const count = async (sql, params) => Number((await pool.query(sql, params))[0][0].n);
  const sessionOf = async (publicId) =>
    (await pool.query('SELECT dojo_session_id FROM epos_express_orders WHERE public_id = ?', [publicId]))[0][0].dojo_session_id;
  const orderRow = async (publicId) =>
    (await pool.query('SELECT * FROM epos_express_orders WHERE public_id = ?', [publicId]))[0][0];
  const events = (customerId, kind) => count(
    'SELECT COUNT(*) AS n FROM epos_membership_events WHERE customer_id = ? AND kind = ?', [customerId, kind]);
  const day = async (sql) => (await pool.query(`SELECT DATE_FORMAT(${sql}, '%Y-%m-%d') AS d`))[0][0].d;

  try {
    console.log('Memberships on Vesopa Express, against a real database\n');

    // ---- Off ---------------------------------------------------------------
    await check('a venue without Memberships is not told to offer them, and every route is a 404', async () => {
      const c = await call(server, 'GET', '/api/express/kiosk/config', gymKiosk);
      assert.strictEqual(c.status, 200);
      assert.strictEqual(c.body.memberships, false);
      const p = await call(server, 'GET', '/api/express/kiosk/memberships/plans', gymKiosk);
      assert.strictEqual(p.status, 404);
      assert.strictEqual(p.body.code, 'memberships_off');
      const l = await call(server, 'POST', '/api/express/kiosk/memberships/lookup', gymKiosk, { card_number: '4001' });
      assert.strictEqual(l.status, 404);
      assert.strictEqual(l.body.code, 'memberships_off');
      const o = await call(server, 'POST', '/api/express/kiosk/memberships/orders', gymKiosk,
        { kind: 'join', scheme_id: 1, name: 'A B', email: 'a@b.cd', phone: '07700900000', payment: 'card' });
      assert.strictEqual(o.status, 404);
      assert.strictEqual(await count('SELECT COUNT(*) AS n FROM epos_express_orders'), 0);
    });

    await setAllowed(pool, GYM.id, { memberships: { allowed: true } }, 'test');

    const [gold] = await pool.query(
      `INSERT INTO epos_loyalty_schemes (office, name, is_membership, membership_fee_minor, membership_term_months,
         joining_fee_minor) VALUES (?, 'Gold', 1, 3500, 1, 1000)`, [GYM.email]);
    const [retired] = await pool.query(
      `INSERT INTO epos_loyalty_schemes (office, name, is_membership, membership_fee_minor, membership_term_months, active)
       VALUES (?, 'Old Silver', 1, 2000, 12, 0)`, [GYM.email]);
    await pool.query("INSERT INTO epos_loyalty_schemes (office, name) VALUES (?, 'Regulars')", [GYM.email]);

    const ann = await memberships.join(pool, GYM.email, {
      scheme_id: gold.insertId,
      customer: { name: 'Ann Lloyd-Jones', email: 'Ann@Example.com', phone: '07700 900123', card_number: '4001' },
    }, { via: 'till' });
    const inMonth = await day('CURDATE() + INTERVAL 1 MONTH');
    const inTwo = await day('CURDATE() + INTERVAL 2 MONTH');
    assert.strictEqual(ann.membership_expiry, inMonth);

    // ---- On ----------------------------------------------------------------
    await check('with the module on, the kiosk is told to offer memberships', async () => {
      const c = await call(server, 'GET', '/api/express/kiosk/config', gymKiosk);
      assert.strictEqual(c.body.memberships, true);
      const other = await call(server, 'GET', '/api/express/kiosk/config', pubKiosk);
      assert.strictEqual(other.body.memberships, false, 'only the venue that has the module');
    });

    await check('the plans are the active membership plans, with the joining price worked out', async () => {
      const r = await call(server, 'GET', '/api/express/kiosk/memberships/plans', gymKiosk);
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(r.body.plans.map((p) => p.name), ['Gold']);
      assert.strictEqual(r.body.plans[0].fee_minor, 3500);
      assert.strictEqual(r.body.plans[0].join_minor, 4500);
    });

    let token;
    await check('a card finds a member, and says nothing a stranger should not see', async () => {
      const r = await call(server, 'POST', '/api/express/kiosk/memberships/lookup', gymKiosk, { card_number: ';4001?' });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.strictEqual(r.body.first_name, 'Ann');
      assert.strictEqual(r.body.plan_name, 'Gold');
      assert.strictEqual(r.body.state, 'active');
      assert.strictEqual(r.body.expiry, inMonth);
      assert.strictEqual(r.body.renew_minor, 3500);
      assert.strictEqual(r.body.can_renew, true);
      assert.deepStrictEqual(Object.keys(r.body).sort(),
        ['can_renew', 'expiry', 'first_name', 'member_token', 'plan_name', 'reason', 'renew_minor', 'state']);
      const text = JSON.stringify(r.body);
      for (const secret of ['example.com', '900123', 'Lloyd', ann.id]) {
        assert.ok(!text.includes(secret), `the lookup leaked ${secret}`);
      }
      token = r.body.member_token;
    });

    await check('email or phone needs the surname, and a wrong one is just "not found"', async () => {
      const none = await call(server, 'POST', '/api/express/kiosk/memberships/lookup', gymKiosk, { email: 'ann@example.com' });
      assert.strictEqual(none.status, 400);
      const wrong = await call(server, 'POST', '/api/express/kiosk/memberships/lookup', gymKiosk,
        { email: 'ann@example.com', surname: 'Smith' });
      const unknown = await call(server, 'POST', '/api/express/kiosk/memberships/lookup', gymKiosk,
        { email: 'nobody@example.com', surname: 'Smith' });
      assert.strictEqual(wrong.status, 404);
      assert.deepStrictEqual(wrong.body, unknown.body, 'the same answer either way');
      const right = await call(server, 'POST', '/api/express/kiosk/memberships/lookup', gymKiosk,
        { email: ' ANN@example.com ', surname: 'lloyd jones' });
      assert.strictEqual(right.status, 200, JSON.stringify(right.body));
      assert.strictEqual(right.body.first_name, 'Ann');
      const phone = await call(server, 'POST', '/api/express/kiosk/memberships/lookup', gymKiosk,
        { phone: '+44 7700 900123', surname: 'Jones' });
      assert.strictEqual(phone.status, 200, JSON.stringify(phone.body));
      const card = await call(server, 'POST', '/api/express/kiosk/memberships/lookup', gymKiosk, { card_number: '9999' });
      assert.strictEqual(card.status, 404);
    });

    await check('another venue cannot find this venue\'s members', async () => {
      const r = await call(server, 'POST', '/api/express/kiosk/memberships/lookup', pubKiosk, { card_number: '4001' });
      assert.strictEqual(r.status, 404);
    });

    let renewal;
    await check('a renewal is priced by the server, whatever the kiosk sends', async () => {
      const r = await call(server, 'POST', '/api/express/kiosk/memberships/orders', gymKiosk, {
        client_ref: crypto.randomUUID(),
        kind: 'renew',
        member_token: token,
        payment: 'card',
        // None of these is read.
        amount_minor: 1, total_minor: 1, scheme_id: retired.insertId,
        lines: [{ name: 'Membership: Gold renewal', unit: 1, qty: 1 }],
      });
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      renewal = r.body;
      assert.strictEqual(renewal.total_minor, 3500);
      assert.strictEqual(renewal.order_type, 'membership');
      assert.strictEqual(renewal.lines.length, 1);
      assert.strictEqual(renewal.lines[0].name, 'Membership: Gold renewal');
      assert.strictEqual(renewal.lines[0].unit, 3500);
      assert.strictEqual(renewal.stage, 'present_card');
      assert.strictEqual(renewal.membership.applied, false);
      assert.strictEqual(intents[Object.keys(intents).pop()].amount, 3500, 'the card machine asks for the server\'s price');
    });

    await check('nothing moves until the money is in', async () => {
      const poll = await call(server, 'GET', `/api/express/kiosk/orders/${renewal.public_id}`, gymKiosk);
      assert.strictEqual(poll.body.stage, 'present_card');
      const m = await memberships.memberById(pool, GYM.email, ann.id);
      assert.strictEqual(m.membership_expiry, inMonth);
      assert.strictEqual(await events(ann.id, 'renew'), 0);
    });

    await check('paid: the renewal goes on once, with the sale, and leaves the board alone', async () => {
      capture(await sessionOf(renewal.public_id));
      const poll = await call(server, 'GET', `/api/express/kiosk/orders/${renewal.public_id}`, gymKiosk);
      assert.strictEqual(poll.body.stage, 'paid', JSON.stringify(poll.body));
      assert.strictEqual(poll.body.membership.applied, true);
      assert.strictEqual(poll.body.membership.expiry, inTwo);
      assert.strictEqual(poll.body.membership.first_name, 'Ann');
      const m = await memberships.memberById(pool, GYM.email, ann.id);
      assert.strictEqual(m.membership_expiry, inTwo);
      const [[event]] = await pool.query(
        "SELECT via, amount_minor FROM epos_membership_events WHERE customer_id = ? AND kind = 'renew'", [ann.id]);
      assert.strictEqual(event.via, 'kiosk');
      assert.strictEqual(event.amount_minor, 3500);
      const row = await orderRow(renewal.public_id);
      assert.strictEqual(row.status, 'collected', 'never on the board or in a till\'s queue');
      const [[sale]] = await pool.query('SELECT total_minor FROM epos_orders WHERE id = ?', [row.sale_id]);
      assert.strictEqual(sale.total_minor, 3500);
      const [[line]] = await pool.query('SELECT name, plu_id FROM epos_order_lines WHERE order_id = ?', [row.sale_id]);
      assert.strictEqual(line.name, 'Membership: Gold renewal');
      assert.strictEqual(line.plu_id, -1, 'the till\'s own membership sentinel');
      assert.ok(!broadcasts.some((b) => b.type === 'express.order' && b.public_id === renewal.public_id),
        'no "food to make" for the till');
      assert.ok(!row.ticket_id, 'no kitchen ticket');
    });

    await check('a second, third and fourth "paid" change nothing', async () => {
      const intent = (await orderRow(renewal.public_id)).dojo_intent_id;
      await call(server, 'GET', `/api/express/kiosk/orders/${renewal.public_id}`, gymKiosk);
      await call(server, 'POST', `/api/express/kiosk/orders/${renewal.public_id}/retry`, gymKiosk);
      await router.onDojoEvent({ paymentIntentId: intent, status: 'Captured' });
      assert.strictEqual(await events(ann.id, 'renew'), 1);
      assert.strictEqual(await count('SELECT COUNT(*) AS n FROM epos_orders WHERE email = ?', [GYM.email]), 1);

      // Even an order somehow put back to awaiting payment does not apply
      // twice: the order carries its own record that it was applied.
      await pool.query("UPDATE epos_express_orders SET status = 'awaiting_payment' WHERE public_id = ?", [renewal.public_id]);
      await router.onDojoEvent({ paymentIntentId: intent, status: 'Captured' });
      assert.strictEqual(await events(ann.id, 'renew'), 1);
      assert.strictEqual((await memberships.memberById(pool, GYM.email, ann.id)).membership_expiry, inTwo);
    });

    await check('a member token is for the kiosk and venue it was given to', async () => {
      const other = await call(server, 'POST', '/api/express/kiosk/memberships/orders', gymKiosk2,
        { kind: 'renew', member_token: token, payment: 'card' });
      assert.strictEqual(other.status, 401);
      const forged = await call(server, 'POST', '/api/express/kiosk/memberships/orders', gymKiosk,
        { kind: 'renew', member_token: jwt.sign({ scope: 'express_member', office: GYM.email, kiosk: kioskIds.gym, cid: ann.id }, 'not-the-secret'), payment: 'card' });
      assert.strictEqual(forged.status, 401);
      const pub = await call(server, 'POST', '/api/express/kiosk/memberships/orders', pubKiosk,
        { kind: 'renew', member_token: token, payment: 'card' });
      assert.strictEqual(pub.status, 404, 'and nowhere without the module');
    });

    await check('joining asks for a plan that is taking members, a full name, an email and a phone', async () => {
      const base = { kind: 'join', scheme_id: gold.insertId, name: 'Bea Evans', email: 'bea@example.com', phone: '07700 900456', payment: 'card' };
      const bad = [
        { scheme_id: retired.insertId },
        { name: 'Bea' },
        { email: 'not-an-email' },
        { phone: '12' },
        { kind: 'gift' },
      ];
      for (const change of bad) {
        const r = await call(server, 'POST', '/api/express/kiosk/memberships/orders', gymKiosk, { ...base, ...change });
        assert.strictEqual(r.status, 400, JSON.stringify(change));
      }
    });

    let joining;
    await check('a join costs the fee and the joining fee, and makes nobody a member before payment', async () => {
      const r = await call(server, 'POST', '/api/express/kiosk/memberships/orders', gymKiosk, {
        client_ref: crypto.randomUUID(),
        kind: 'join', scheme_id: gold.insertId,
        name: '  Bea   Evans ', email: 'Bea@Example.com', phone: '07700 900456',
        payment: 'card', total_minor: 0,
      });
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      joining = r.body;
      assert.strictEqual(joining.total_minor, 4500);
      assert.strictEqual(joining.lines[0].name, 'Membership: Gold joining');
      assert.strictEqual(joining.customer_name, 'Bea');
      assert.ok(!JSON.stringify(joining).includes('example.com'), 'the order shown to the kiosk carries no email');
      assert.strictEqual(await count("SELECT COUNT(*) AS n FROM epos_customers WHERE email = 'bea@example.com'"), 0);
    });

    await check('paid: the new member is joined once, from today, and gets a number', async () => {
      capture(await sessionOf(joining.public_id));
      const poll = await call(server, 'GET', `/api/express/kiosk/orders/${joining.public_id}`, gymKiosk);
      assert.strictEqual(poll.body.stage, 'paid');
      assert.strictEqual(poll.body.membership.applied, true);
      assert.strictEqual(poll.body.membership.expiry, inMonth);
      assert.ok(poll.body.membership.member_number, 'a member number to keep');
      await router.onDojoEvent({ paymentIntentId: (await orderRow(joining.public_id)).dojo_intent_id, status: 'Captured' });
      const [rows] = await pool.query("SELECT id, name, phone FROM epos_customers WHERE email = 'bea@example.com'");
      assert.strictEqual(rows.length, 1, 'one customer');
      assert.strictEqual(rows[0].name, 'Bea Evans');
      const bea = await memberships.memberById(pool, GYM.email, rows[0].id);
      assert.strictEqual(bea.state, 'active');
      assert.strictEqual(bea.plan.name, 'Gold');
      assert.strictEqual(await events(bea.id, 'join'), 1);
      const [[event]] = await pool.query(
        "SELECT via, amount_minor FROM epos_membership_events WHERE customer_id = ? AND kind = 'join'", [bea.id]);
      assert.strictEqual(event.via, 'kiosk');
      assert.strictEqual(event.amount_minor, 4500);
      const kept = JSON.parse((await orderRow(joining.public_id)).membership_json);
      assert.ok(!JSON.stringify(kept).includes('900456'), 'the contact details live on the customer, not the order');
    });

    await check('joining again with a member\'s email is sent to renew instead', async () => {
      const r = await call(server, 'POST', '/api/express/kiosk/memberships/orders', gymKiosk, {
        kind: 'join', scheme_id: gold.insertId, name: 'Bea Evans', email: 'bea@example.com', phone: '07700900456', payment: 'card',
      });
      assert.strictEqual(r.status, 409);
      assert.strictEqual(r.body.code, 'already_member');
    });

    await check('a cancelled membership is found but not renewed here', async () => {
      await memberships.cancel(pool, GYM.email, ann.id, { now: true });
      const r = await call(server, 'POST', '/api/express/kiosk/memberships/lookup', gymKiosk, { card_number: '4001' });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.can_renew, false);
      assert.strictEqual(r.body.renew_minor, null);
      const o = await call(server, 'POST', '/api/express/kiosk/memberships/orders', gymKiosk,
        { kind: 'renew', member_token: r.body.member_token, payment: 'card' });
      assert.strictEqual(o.status, 409);
    });

    await check('switched off again, the kiosk stops offering it and the routes are 404', async () => {
      await setAllowed(pool, GYM.id, { memberships: { allowed: false } }, 'test');
      const c = await call(server, 'GET', '/api/express/kiosk/config', gymKiosk);
      assert.strictEqual(c.body.memberships, false);
      const l = await call(server, 'POST', '/api/express/kiosk/memberships/lookup', gymKiosk, { card_number: '4001' });
      assert.strictEqual(l.status, 404);
    });
  } finally {
    server.close();
    await pool.end();
  }
  console.log(`\n  ${passed} passed, ${failed} failed`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
