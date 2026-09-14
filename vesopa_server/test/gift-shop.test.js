/**
 * Gift cards held, spent, given back and sold online -- against the real
 * server, on a database shaped like live.
 *
 *   EXPRESS_TEST_USER=vesopa_test EXPRESS_TEST_PASS=vesopa_test node test/gift-shop.test.js
 *
 * Same method as five-features.test.js: live's structure copied into a scratch
 * database, every migration replayed twice over it, src/server.js started as a
 * child process exactly as pm2 runs it, and everything below plain HTTP. Two
 * servers: one as live runs today (unsigned tills allowed, the gift shop
 * connected), and one with COMMERCE_REQUIRE_TERMINAL=1 and no gift shop key.
 *
 * Skipped, not failed, where there is no database or no live-shaped template.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const DB = process.env.GIFT_TEST_DB || 'vesopa_gift_selftest';
const TEMPLATE = process.env.FIVE_TEST_TEMPLATE || 'vesopa_live_shape';
const USER = process.env.EXPRESS_TEST_USER || 'root';
const PASS = process.env.EXPRESS_TEST_PASS || '';
const HOST = process.env.EXPRESS_TEST_HOST || '127.0.0.1';
const SECRET = 'gift-shop-test-secret';
const SERVICE_KEY = 'gift-shop-test-service-key-that-is-long-enough-0123456789';

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

const A = { id: 911, email: 'gift-a@shop.test', name: 'The Gift Arms' };
const B = { id: 912, email: 'gift-b@shop.test', name: 'The Other Bar' };
const PASSWORD = 'correct horse 42';

function statementsOf(sql) {
  const out = [];
  let delimiter = ';';
  let buffer = '';
  for (const line of sql.split('\n')) {
    const d = /^DELIMITER\s+(\S+)/.exec(line.trim());
    if (d) { delimiter = d[1]; continue; }
    if (line.trim().startsWith('--') && !buffer.trim()) continue;
    buffer += line + '\n';
    if (buffer.trimEnd().endsWith(delimiter)) {
      const s = buffer.trimEnd().slice(0, -delimiter.length).trim();
      if (s) out.push(s);
      buffer = '';
    }
  }
  if (buffer.trim()) out.push(buffer.trim());
  return out;
}

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function startServer(extraEnv) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'test',
      JWT_SECRET: SECRET,
      DB_HOST: HOST,
      DB_PORT: '3306',
      DB_USER: USER,
      DB_PASSWORD: PASS,
      DB_NAME: DB,
      SMTP_HOST: '',
      VESOPA_AUTH_ENABLED: '',
      VESOPA_AUTH_BACKOFFICE_ENABLED: '',
      VESOPA_AUTH_TILL_ENABLED: '',
      EXPRESS_SECRET_KEY: 'gift-test-sealing-key',
      EXPRESS_DOJO_API_KEY: '',
      DOJO_API_KEY: '',
      BACKOFFICE_URL: 'https://backoffice.example.test',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });

  const call = async (method, url, { token, body } = {}) => {
    const res = await fetch(base + url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, body: json };
  };

  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    await new Promise((r) => setTimeout(r, 150));
    try { up = (await fetch(`${base}/health`)).ok; } catch { /* not yet */ }
  }
  if (!up) throw new Error(`the server did not start:\n${log.slice(-2000)}`);
  return { child, call, log: () => log };
}

async function main() {
  let admin;
  try {
    admin = await mysql.createConnection({ host: HOST, user: USER, password: PASS, multipleStatements: true });
  } catch (e) {
    console.log(`-- no database reachable, skipping (${e.code || e.message})`);
    return;
  }
  const [[tpl]] = await admin.query(
    'SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ?', [TEMPLATE]
  );
  if (!tpl.n) {
    console.log(`-- no ${TEMPLATE} template database, skipping`);
    await admin.end();
    return;
  }

  await admin.query(`DROP DATABASE IF EXISTS ${DB}; CREATE DATABASE ${DB} CHARACTER SET utf8mb4;`);
  const [tables] = await admin.query(
    "SELECT table_name AS t FROM information_schema.tables WHERE table_schema = ? AND table_type = 'BASE TABLE'",
    [TEMPLATE]
  );
  await admin.query(`USE ${DB}`);
  await admin.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const { t } of tables) {
    const [[row]] = await admin.query(`SHOW CREATE TABLE \`${TEMPLATE}\`.\`${t}\``);
    await admin.query(row['Create Table']);
  }
  await admin.query('SET FOREIGN_KEY_CHECKS = 1');

  const dir = path.join(__dirname, '..', 'schema');
  const files = ['schema.sql', ...fs.readdirSync(dir).filter((f) => /^schema_.*\.sql$/.test(f)).sort()];
  await check('every migration applies over live\'s shape, and again', async () => {
    for (let run = 0; run < 2; run++) {
      for (const file of files) {
        for (const sql of statementsOf(fs.readFileSync(path.join(dir, file), 'utf8'))) {
          try {
            await admin.query(sql);
          } catch (e) {
            throw new Error(`${file} (run ${run + 1}): ${e.message}\n        ${sql.slice(0, 120)}`);
          }
        }
      }
    }
  });
  await admin.end();

  const pool = mysql.createPool({ host: HOST, user: USER, password: PASS, database: DB, connectionLimit: 6 });

  const hash = await bcrypt.hash(PASSWORD, 4);
  await pool.query(
    'INSERT INTO offices (id, name, contact_email, status) VALUES (?,?,?,?),(?,?,?,?)',
    [A.id, A.name, A.email, 'active', B.id, B.name, B.email, 'active']
  );
  const [owner] = await pool.query(
    "INSERT INTO backoffice_users (email, password, name, approved, office_id, role) VALUES (?, ?, 'Owner', 'Y', ?, 'office')",
    [A.email, hash, A.id]
  );
  await pool.query(
    "INSERT INTO backoffice_users (email, password, name, approved, office_id, role) VALUES (?, ?, 'Other', 'Y', ?, 'office')",
    [B.email, hash, B.id]
  );

  // The live default is 240 a minute; 60 here keeps the limit test quick.
  const lenient = await startServer({ GIFT_SERVICE_KEY: SERVICE_KEY, COMMERCE_UNSIGNED_LOOKUPS_PER_MIN: '60' });
  const strict = await startServer({ COMMERCE_REQUIRE_TERMINAL: '1', GIFT_SERVICE_KEY: '' });
  const call = lenient.call;

  const session = jwt.sign(
    { sub: owner.insertId, email: A.email, name: 'Owner', role: 'office', officeId: A.id },
    SECRET, { expiresIn: '1h' }
  );
  const svc = (method, url, body) => call(method, url, { token: SERVICE_KEY, body });

  try {
    // A till signed in the way a till signs in.
    const login = await call('POST', '/api/login', {
      body: { email: A.email, password: PASSWORD, terminal: true, device_id: 'dev-bar', device_name: 'Bar' },
    });
    const till = login.body && login.body.terminalToken;
    await check('the till signs in and holds a terminal token', async () => {
      assert.strictEqual(login.status, 200, JSON.stringify(login.body));
      assert.ok(till);
    });

    // A card issued in the back office, the old way.
    const made = await call('POST', '/api/gift-cards', { token: session, body: { initial_minor: 5000 } });
    const code = made.body && made.body.code;
    await check('the back office issues a £50 card', async () => {
      assert.strictEqual(made.status, 201, JSON.stringify(made.body));
      assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    });
    const q = (extra = '') => `office=${encodeURIComponent(A.email)}&code=${encodeURIComponent(code)}${extra}`;

    // ==================================================================
    // Which till is calling
    // ==================================================================

    await check('an unsigned till can still look a card up, and is counted', async () => {
      const r = await call('GET', `/api/gift-cards/lookup?${q()}`);
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.strictEqual(r.body.available_minor, 5000);
      await new Promise((res) => setTimeout(res, 150));
      const [[row]] = await pool.query(
        "SELECT calls, reason FROM epos_commerce_unsigned WHERE office = ? AND route = '/gift-cards/lookup'",
        [A.email]
      );
      assert.ok(row && row.calls >= 1, 'the unsigned call was recorded');
      assert.strictEqual(row.reason, 'none');
    });

    await check('a signed till needs no office, and is not counted as unsigned', async () => {
      const before = await pool.query('SELECT COALESCE(SUM(calls),0) n FROM epos_commerce_unsigned').then(([[r]]) => Number(r.n));
      const r = await call('GET', `/api/gift-cards/lookup?code=${encodeURIComponent(code)}`, { token: till });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.strictEqual(r.body.code, code);
      await new Promise((res) => setTimeout(res, 150));
      const after = await pool.query('SELECT COALESCE(SUM(calls),0) n FROM epos_commerce_unsigned').then(([[r]]) => Number(r.n));
      assert.strictEqual(after, before);
    });

    await check('a signed till cannot act for another venue', async () => {
      const r = await call('GET', `/api/gift-cards/lookup?office=${encodeURIComponent(B.email)}&code=${code}`, { token: till });
      assert.strictEqual(r.status, 403, JSON.stringify(r.body));
    });

    await check('a back-office session on a till route behaves as before', async () => {
      const r = await call('GET', `/api/gift-cards/lookup?${q()}`, { token: session });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    });

    await check('with the check switched on, an unsigned till is refused and a signed one is not', async () => {
      const r1 = await strict.call('GET', `/api/gift-cards/lookup?${q()}`);
      assert.strictEqual(r1.status, 401);
      assert.strictEqual(r1.body.needs_terminal, true);
      const r2 = await strict.call('GET', `/api/gift-cards/lookup?code=${encodeURIComponent(code)}`, { token: till });
      assert.strictEqual(r2.status, 200, JSON.stringify(r2.body));
      const r3 = await strict.call('GET', `/api/tender-settings/public?office=${encodeURIComponent(A.email)}`);
      assert.strictEqual(r3.status, 401);
    });

    await check('a stranger is limited to sixty lookups a minute', async () => {
      let limitedAt = 0;
      for (let i = 0; i < 70 && !limitedAt; i++) {
        const r = await call('GET', `/api/gift-cards/lookup?office=${encodeURIComponent(B.email)}&code=NOPE-NOPE-NOPE`);
        if (r.status === 429) limitedAt = i + 1;
      }
      assert.ok(limitedAt > 50 && limitedAt <= 62, `limited at call ${limitedAt}`);
    });

    // ==================================================================
    // Hold, capture, release, reverse
    // ==================================================================

    const order1 = '11111111-1111-4111-8111-111111111111';
    const order2 = '22222222-2222-4222-8222-222222222222';
    const hold1 = await call('POST', '/api/gift-cards/hold', {
      token: till, body: { code, amount_minor: 3000, order_id: order1, clerk_name: 'Alice' },
    });

    await check('a hold reserves money without moving it', async () => {
      assert.strictEqual(hold1.status, 200, JSON.stringify(hold1.body));
      assert.ok(hold1.body.hold_id);
      const [[card]] = await pool.query('SELECT balance_minor FROM epos_gift_cards WHERE code = ?', [code]);
      assert.strictEqual(card.balance_minor, 5000);
      const r = await call('GET', `/api/gift-cards/lookup?code=${code}`, { token: till });
      assert.strictEqual(r.body.available_minor, 2000);
    });

    await check('a second till cannot hold money the first is holding', async () => {
      const r = await call('POST', '/api/gift-cards/hold', { token: till, body: { code, amount_minor: 2500 } });
      assert.strictEqual(r.status, 409);
      assert.strictEqual(r.body.available_minor, 2000);
    });

    await check('an old till cannot spend held money with a plain redeem', async () => {
      const r = await call('POST', '/api/gift-cards/redeem', {
        body: { office: A.email, code, amount_minor: 2500, order_id: order2 },
      });
      assert.strictEqual(r.status, 409, JSON.stringify(r.body));
    });

    await check('capturing spends exactly what was held, once', async () => {
      const c1 = await call('POST', '/api/gift-cards/capture', { token: till, body: { hold_id: hold1.body.hold_id, order_id: order1 } });
      assert.strictEqual(c1.status, 200, JSON.stringify(c1.body));
      assert.strictEqual(c1.body.card.balance_minor, 2000);
      const c2 = await call('POST', '/api/gift-cards/capture', { token: till, body: { hold_id: hold1.body.hold_id } });
      assert.strictEqual(c2.status, 200);
      assert.strictEqual(c2.body.repeated, true);
      const [[card]] = await pool.query('SELECT balance_minor FROM epos_gift_cards WHERE code = ?', [code]);
      assert.strictEqual(card.balance_minor, 2000);
      const [[txn]] = await pool.query(
        "SELECT hold_id, amount_minor FROM epos_gift_card_txns WHERE kind = 'redeem' AND order_id = ?", [order1]
      );
      assert.strictEqual(txn.hold_id, hold1.body.hold_id);
      assert.strictEqual(txn.amount_minor, -3000);
    });

    await check('releasing a captured hold changes nothing', async () => {
      const r = await call('POST', '/api/gift-cards/release', { token: till, body: { hold_id: hold1.body.hold_id } });
      assert.strictEqual(r.body.released, false);
    });

    await check('Undo: a released hold gives the money back to spend', async () => {
      const h = await call('POST', '/api/gift-cards/hold', { token: till, body: { code, amount_minor: 1500, order_id: order2 } });
      assert.strictEqual(h.status, 200, JSON.stringify(h.body));
      const r = await call('POST', '/api/gift-cards/release', { token: till, body: { hold_id: h.body.hold_id } });
      assert.strictEqual(r.body.released, true);
      const l = await call('GET', `/api/gift-cards/lookup?code=${code}`, { token: till });
      assert.strictEqual(l.body.available_minor, 2000);
      const c = await call('POST', '/api/gift-cards/capture', { token: till, body: { hold_id: h.body.hold_id } });
      assert.strictEqual(c.status, 409, 'a released hold cannot be captured');
    });

    await check('a refund puts back what that sale took, and never more', async () => {
      const r1 = await call('POST', '/api/gift-cards/reverse', { token: till, body: { code, order_id: order1, amount_minor: 1000 } });
      assert.strictEqual(r1.status, 200, JSON.stringify(r1.body));
      assert.strictEqual(r1.body.reversed_minor, 1000);
      const r2 = await call('POST', '/api/gift-cards/reverse', { token: till, body: { code, order_id: order1, amount_minor: 5000 } });
      assert.strictEqual(r2.body.reversed_minor, 2000, 'capped at what is still owed');
      const r3 = await call('POST', '/api/gift-cards/reverse', { token: till, body: { code, order_id: order1 } });
      assert.strictEqual(r3.status, 409);
      const [[card]] = await pool.query('SELECT balance_minor FROM epos_gift_cards WHERE code = ?', [code]);
      assert.strictEqual(card.balance_minor, 5000);
    });

    await check('a refund off a receipt finds the card from the sale alone', async () => {
      // The refund screen knows the sale and that a gift card paid, not which one.
      const order3 = '33333333-3333-4333-8333-333333333333';
      const h = await call('POST', '/api/gift-cards/hold', { token: till, body: { code, amount_minor: 1200, order_id: order3 } });
      await call('POST', '/api/gift-cards/capture', { token: till, body: { hold_id: h.body.hold_id, order_id: order3 } });
      const r1 = await call('POST', '/api/gift-cards/reverse', { token: till, body: { order_id: order3, amount_minor: 700 } });
      assert.strictEqual(r1.status, 200, JSON.stringify(r1.body));
      assert.strictEqual(r1.body.reversed_minor, 700);
      assert.deepStrictEqual(r1.body.cards.map((c) => [c.code, c.reversed_minor]), [[code, 700]]);
      const r2 = await call('POST', '/api/gift-cards/reverse', { token: till, body: { order_id: order3 } });
      assert.strictEqual(r2.body.reversed_minor, 500, 'the rest, and no more');
      const r3 = await call('POST', '/api/gift-cards/reverse', { token: till, body: { order_id: order3 } });
      assert.strictEqual(r3.status, 409);
      const none = await call('POST', '/api/gift-cards/reverse', { token: till, body: { order_id: '44444444-4444-4444-8444-444444444444' } });
      assert.strictEqual(none.status, 409, 'a sale no card paid for gives nothing back');
      const [[card]] = await pool.query('SELECT balance_minor FROM epos_gift_cards WHERE code = ?', [code]);
      assert.strictEqual(card.balance_minor, 5000);
    });

    // ==================================================================
    // The gift shop's own API
    // ==================================================================

    await check('the gift shop API refuses anybody without its key', async () => {
      const r1 = await call('GET', '/api/integrations/gift/venues');
      assert.strictEqual(r1.status, 401);
      const r2 = await call('GET', '/api/integrations/gift/venues', { token: 'wrong' });
      assert.strictEqual(r2.status, 401);
      const r3 = await call('GET', '/api/integrations/gift/venues', { token: till });
      assert.strictEqual(r3.status, 401, 'a till is not the gift shop');
      const r4 = await strict.call('GET', '/api/integrations/gift/venues', { token: SERVICE_KEY });
      assert.strictEqual(r4.status, 503, 'no key configured means the surface is closed');
    });

    await check('it lists venues with their branding and how they get paid', async () => {
      const r = await svc('GET', '/api/integrations/gift/venues');
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      const v = r.body.venues.find((x) => x.id === A.id);
      assert.ok(v, 'our venue is listed');
      assert.strictEqual(v.brand.name, A.name);
      assert.strictEqual(v.payments.source, 'none', 'no key anywhere: cannot take payments');
    });

    const ref = 'VG-1001/1';
    const issued = await svc('POST', `/api/integrations/gift/venues/${A.id}/cards`, {
      amount_minor: 4800, external_ref: ref, label: 'Sunday lunch for two',
      recipient_name: 'Alex', expires_on: '2027-10-24', single_use: true, notes: 'Order VG-1001',
    });

    await check('it issues a card for an order line, and a retry gets the same card', async () => {
      assert.strictEqual(issued.status, 201, JSON.stringify(issued.body));
      assert.strictEqual(issued.body.card.balance_minor, 4800);
      assert.strictEqual(issued.body.card.source, 'gift');
      assert.strictEqual(issued.body.card.kind, 'paper');
      const again = await svc('POST', `/api/integrations/gift/venues/${A.id}/cards`, { amount_minor: 4800, external_ref: ref });
      assert.strictEqual(again.status, 200);
      assert.strictEqual(again.body.repeated, true);
      assert.strictEqual(again.body.card.id, issued.body.card.id);
    });

    await check('the till sees a card sold online, label and all', async () => {
      const r = await call('GET', `/api/gift-cards/lookup?code=${issued.body.card.code}`, { token: till });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.strictEqual(r.body.label, 'Sunday lunch for two');
      assert.strictEqual(r.body.redeemable, true);
    });

    await check('another venue cannot read it, and the balance page only answers for shop cards', async () => {
      const r1 = await svc('GET', `/api/integrations/gift/venues/${B.id}/cards/${issued.body.card.id}`);
      assert.strictEqual(r1.status, 404);
      const r2 = await svc('GET', `/api/integrations/gift/venues/${A.id}/lookup?code=${issued.body.card.code}`);
      assert.strictEqual(r2.status, 200);
      const r3 = await svc('GET', `/api/integrations/gift/venues/${A.id}/lookup?code=${code}`);
      assert.strictEqual(r3.status, 404, 'a back-office card is not the shop\'s to describe');
    });

    await check('a voucher still in its waiting period cannot be spent yet', async () => {
      const later = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
      const held = await svc('POST', `/api/integrations/gift/venues/${A.id}/cards`, {
        amount_minor: 30000, external_ref: 'VG-1002/1', usable_from: later,
      });
      assert.strictEqual(held.status, 201, JSON.stringify(held.body));
      const l = await call('GET', `/api/gift-cards/lookup?code=${held.body.card.code}`, { token: till });
      assert.strictEqual(l.body.not_yet, true);
      assert.strictEqual(l.body.redeemable, false);
      const h = await call('POST', '/api/gift-cards/hold', { token: till, body: { code: held.body.card.code, amount_minor: 100 } });
      assert.strictEqual(h.status, 409);
      assert.match(h.body.error, /can be used from/);
      const p = await svc('PATCH', `/api/integrations/gift/venues/${A.id}/cards/${held.body.card.id}`, { usable_from: null });
      assert.strictEqual(p.status, 200);
      const h2 = await call('POST', '/api/gift-cards/hold', { token: till, body: { code: held.body.card.code, amount_minor: 100 } });
      assert.strictEqual(h2.status, 200, 'released early, it can be spent');
      await call('POST', '/api/gift-cards/release', { token: till, body: { hold_id: h2.body.hold_id } });
    });

    await check('a paper voucher spent in full is done, and a refund brings it back', async () => {
      const c = issued.body.card.code;
      const h = await call('POST', '/api/gift-cards/hold', { token: till, body: { code: c, amount_minor: 4800, order_id: order2 } });
      const cap = await call('POST', '/api/gift-cards/capture', { token: till, body: { hold_id: h.body.hold_id, order_id: order2 } });
      assert.strictEqual(cap.body.card.status, 'redeemed');
      const rev = await call('POST', '/api/gift-cards/reverse', { token: till, body: { code: c, order_id: order2 } });
      assert.strictEqual(rev.body.card.status, 'active');
      assert.strictEqual(rev.body.card.balance_minor, 4800);
    });

    await check('cancelling a shop card refunds only what is left, once', async () => {
      const c = issued.body.card.code;
      const h = await call('POST', '/api/gift-cards/hold', { token: till, body: { code: c, amount_minor: 800, order_id: order1 } });
      const blocked = await svc('POST', `/api/integrations/gift/venues/${A.id}/cards/${issued.body.card.id}/void`, {});
      assert.strictEqual(blocked.status, 409, 'not while a till is holding it');
      await call('POST', '/api/gift-cards/capture', { token: till, body: { hold_id: h.body.hold_id } });
      const v1 = await svc('POST', `/api/integrations/gift/venues/${A.id}/cards/${issued.body.card.id}/void`, { reason: 'test' });
      assert.strictEqual(v1.status, 200, JSON.stringify(v1.body));
      assert.strictEqual(v1.body.refundable_minor, 4000);
      const v2 = await svc('POST', `/api/integrations/gift/venues/${A.id}/cards/${issued.body.card.id}/void`, {});
      assert.strictEqual(v2.body.refundable_minor, 0);
      assert.strictEqual(v2.body.repeated, true);
      const l = await call('GET', `/api/gift-cards/lookup?code=${c}`, { token: till });
      assert.strictEqual(l.body.redeemable, false);
    });

    await check('the summary counts only what the shop sold', async () => {
      const r = await svc('GET', `/api/integrations/gift/venues/${A.id}/summary`);
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.strictEqual(r.body.cards, 2);
      assert.strictEqual(r.body.issued_minor, 4800 + 30000);
      assert.strictEqual(r.body.outstanding_minor, 30000);
      const spent = r.body.spent_by_week.reduce((s, w) => s + w.spent_minor, 0);
      assert.strictEqual(spent, 800, 'spent 4800, refunded 4800, spent 800');
    });

    await check('a venue with no Dojo key cannot start a payment', async () => {
      const r = await svc('POST', `/api/integrations/gift/venues/${A.id}/payments`, {
        amount_minor: 5000, reference: 'VG-1003', redirect_url: 'https://gift.example.test/return',
      });
      assert.strictEqual(r.status, 409, JSON.stringify(r.body));
    });
  } finally {
    if (failed && process.env.GIFT_TEST_LOG) {
      console.log('\n---- server log ----\n' + lenient.log().slice(-6000));
    }
    lenient.child.kill();
    strict.child.kill();
    await pool.end();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
