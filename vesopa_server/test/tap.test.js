/**
 * Vesopa Tap's server half (src/tap.js), with Dojo faked at the edge and the
 * two tables kept in memory. No database needed.
 *
 * THE RULES THAT MATTER
 *
 *   1. Only a terminal token gets in; the Dojo key never leaves the server.
 *   2. A venue on sandbox (or with nothing saved) uses Dojo's Tap to Pay
 *      sandbox on Dojo's staging host; a live venue uses its own key.
 *   3. The same payment id sent twice is one intent, never two charges.
 *   4. A payment is paid only when Dojo's intent says Captured, and it moves
 *      once: the card log gets one row however often the phone asks.
 *   5. Android is told plainly that it waits for Dojo's SDK.
 */

process.env.EXPRESS_SECRET_KEY = process.env.EXPRESS_SECRET_KEY || 'tap-test-sealing-key';

const assert = require('assert');
const http = require('http');
const express = require('express');

const { issueTerminalToken } = require('../src/auth');
const { seal } = require('../src/express_kiosk');
const tap = require('../src/tap');

const SECRET = 'tap-test-secret';
const LIVE_KEY = 'sk_prod_' + 'test-only-not-a-key';

// ---- an in-memory pool for the two tables tap.js touches --------------------
const settings = new Map();
const tapSettings = new Map();
const payments = new Map();
const cardLog = new Map();
const offices = new Map(); // email -> {id, name, plan}
const users = new Map();
const pool = {
  async getConnection() {
    return {
      query: (sql, args) => pool.query(sql, args),
      execute: (sql, args) => pool.query(sql, args),
      beginTransaction: async () => {},
      commit: async () => {},
      rollback: async () => {},
      release() {},
    };
  },
  async query(sql, args = []) {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.startsWith('SELECT * FROM epos_tap_settings')) {
      const row = tapSettings.get(args[0]);
      return [row ? [row] : []];
    }
    if (s.startsWith('INSERT INTO epos_tap_settings')) {
      tapSettings.set(args[0], { office: args[0], enabled: 1, tips_enabled: 1, tip_percents: args[1], service_percents: args[2], allow_cash: 1, receipt_email: 1 });
      return [{ affectedRows: 1 }];
    }
    if (s.startsWith('SELECT id FROM backoffice_users WHERE email')) return [users.has(args[0]) ? [{ id: 1 }] : []];
    if (s.startsWith('SELECT id FROM offices WHERE contact_email')) return [offices.has(args[0]) ? [offices.get(args[0])] : []];
    if (s.startsWith('INSERT INTO offices')) {
      const id = offices.size + 100;
      offices.set(args[1], { id, name: args[0], plan: 'tap' });
      return [{ insertId: id }];
    }
    if (s.startsWith('INSERT INTO backoffice_users')) {
      users.set(args[0], { password: args[1] });
      return [{ affectedRows: 1 }];
    }
    if (s.startsWith("SELECT * FROM epos_tap_payments WHERE intent_id = ? AND state = 'waiting'")) {
      const row = [...payments.values()].find((p) => p.intent_id === args[0] && p.state === 'waiting');
      return [row ? [{ ...row }] : []];
    }
    if (s.startsWith("UPDATE epos_tap_payments SET state = ?, dojo_status = ? WHERE id = ? AND state = 'waiting'")) {
      const row = payments.get(args[2]);
      if (!row || row.state !== 'waiting') return [{ affectedRows: 0 }];
      Object.assign(row, { state: args[0], dojo_status: args[1] });
      return [{ affectedRows: 1 }];
    }
    if (s.startsWith('SELECT api_key_enc, environment FROM epos_dojo_settings')) {
      const row = settings.get(args[0]);
      return [row ? [row] : []];
    }
    if (s.startsWith('SELECT * FROM epos_tap_payments')) {
      const row = payments.get(args[0]);
      return [row && row.office === args[1] ? [{ ...row }] : []];
    }
    if (s.startsWith('INSERT INTO epos_tap_payments')) {
      const [id, office, terminal, intent_id, amount_minor, tip_minor, bill_ref, clerk, state, environment, via, session_id] = args;
      payments.set(id, { id, office, terminal, intent_id, amount_minor, tip_minor, bill_ref, clerk, state, environment, via, session_id, refunded_minor: 0 });
      return [{ affectedRows: 1 }];
    }
    if (s.startsWith('SELECT api_key_enc, environment, terminal_id FROM epos_dojo_settings') || s.startsWith('SELECT api_key_enc, environment, terminal_id, platform, base_url FROM epos_dojo_settings')) {
      const row = settings.get(args[0]);
      return [row ? [row] : []];
    }
    if (s.startsWith('UPDATE epos_tap_payments SET refunded_minor')) {
      const row = payments.get(args[2]);
      Object.assign(row, { refunded_minor: args[0], state: args[1] });
      return [{ affectedRows: 1 }];
    }
    if (s.startsWith('UPDATE epos_tap_payments SET state = ?')) {
      const [state, dojoStatus, id, office] = args;
      const row = payments.get(id);
      if (!row || row.office !== office || row.state !== 'waiting') return [{ affectedRows: 0 }];
      Object.assign(row, { state, dojo_status: dojoStatus });
      return [{ affectedRows: 1 }];
    }
    if (s.startsWith("UPDATE epos_tap_payments SET state = 'cancelled'")) {
      const row = payments.get(args[0]);
      if (!row || row.office !== args[1] || row.state !== 'waiting') return [{ affectedRows: 0 }];
      row.state = 'cancelled';
      return [{ affectedRows: 1 }];
    }
    if (s.startsWith('INSERT IGNORE INTO epos_card_transactions')) {
      if (!cardLog.has(args[0])) cardLog.set(args[0], { office: args[1], outcome: args[3], amount: args[4] });
      return [{ affectedRows: 1 }];
    }
    throw new Error('unexpected SQL in test: ' + s.slice(0, 80));
  },
};

// ---- Dojo, faked ------------------------------------------------------------
const calls = [];
let intentStatus = 'Created';
let intentCount = 0;
async function fakeFetch(url, init) {
  calls.push({ url, init });
  const reply = (status, body) => ({ ok: status < 300, status, statusText: '', text: async () => JSON.stringify(body) });
  if (url.endsWith('/tap/apple-terminal/secret')) return reply(200, { secret: 'tap-secret-123' });
  if (url.endsWith('/terminal-sessions') && init.method === 'POST') return reply(200, { id: 'ts_1', status: 'InitiateRequested' });
  if (url.endsWith('/refunds') && init.method === 'POST') return reply(200, { refundId: 'rf_1' });
  if (url.endsWith('/payment-intents') && init.method === 'POST') {
    intentCount += 1;
    return reply(200, { id: `pi_test_${intentCount}`, status: 'Created' });
  }
  if (/\/payment-intents\/[^/]+\/cancel$/.test(url)) return reply(200, { status: 'Canceled' });
  if (/\/payment-intents\/[^/]+$/.test(url)) return reply(200, { status: intentStatus });
  return reply(404, { title: 'not here' });
}

async function main() {
  const app = express();
  app.use(express.json());
  // A Vesopa ID token, faked: "verified:<email>" or "unverified:<email>".
  const verifyIdToken = async (t) => {
    const [kind, email] = String(t || '').split(':');
    if (!email) throw new Error('bad token');
    return { email, email_verified: kind === 'verified', name: 'Jo' };
  };
  const seats = [];
  const signInDevice = async (_db, d) => { seats.push(d); return `seat-${seats.length}`; };
  const routes = tap.tapRoutes({ pool, secret: SECRET, fetchImpl: fakeFetch, verifyIdToken, signInDevice });
  app.use(routes);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const token = (office) => issueTerminalToken({ officeEmail: office, officeId: 1, email: 'manager@example.com' }, SECRET);
  const go = async (method, path, { auth = token('sandbox@venue.test'), body } = {}) => {
    const r = await fetch(base + path, {
      method,
      headers: { ...(auth ? { Authorization: 'Bearer ' + auth } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  try {
    // 1. Only terminals.
    assert.strictEqual((await go('GET', '/api/tap/config', { auth: null })).status, 401);

    // 2. Sandbox venue: Dojo's Tap sandbox key, on the staging host.
    const config = await go('GET', '/api/tap/config');
    assert.strictEqual(config.status, 200);
    assert.strictEqual(config.body.environment, 'sandbox');
    assert.strictEqual(config.body.android, false);
    const secret = await go('POST', '/api/tap/secret', { body: { platform: 'ios' } });
    assert.strictEqual(secret.status, 200);
    assert.strictEqual(secret.body.secret, 'tap-secret-123');
    const sent = calls.at(-1);
    assert.strictEqual(sent.url, 'https://staging-api.dojo.dev/integration-test/tap/apple-terminal/secret');
    assert.strictEqual(sent.init.headers.Authorization, 'Basic ' + tap.TAP_SANDBOX_KEY);
    assert.strictEqual(sent.init.headers.Version, '2023-12-12');
    assert.strictEqual(sent.init.headers['software-house-id'], 'SL942X04');
    assert.ok(!JSON.stringify(secret.body).includes('sk_'), 'no key ever goes to the phone');

    // 5. Android waits for Dojo.
    const android = await go('POST', '/api/tap/secret', { body: { platform: 'android' } });
    assert.strictEqual(android.status, 501);
    assert.match(android.body.error, /Android SDK/);

    // Live venue: its own key, Dojo's production host.
    settings.set('live@venue.test', { api_key_enc: seal(LIVE_KEY), environment: 'live' });
    await go('POST', '/api/tap/secret', { auth: token('live@venue.test'), body: { platform: 'ios' } });
    assert.strictEqual(calls.at(-1).url, 'https://api.dojo.tech/tap/apple-terminal/secret');
    assert.strictEqual(calls.at(-1).init.headers.Authorization, 'Basic ' + LIVE_KEY);

    // 3. One payment id, one intent.
    const pay = { id: 'pay-0001-abcd', amount_minor: 2450, tip_minor: 250, bill_ref: 'table-6', clerk: 'Sam' };
    const first = await go('POST', '/api/tap/payments', { body: pay });
    assert.strictEqual(first.status, 201);
    assert.strictEqual(first.body.state, 'waiting');
    const intentBody = JSON.parse(calls.at(-1).init.body);
    assert.deepStrictEqual(intentBody.Amount, { Value: 2700, CurrencyCode: 'GBP' }, 'tip on top, in pence');
    const again = await go('POST', '/api/tap/payments', { body: pay });
    assert.strictEqual(again.body.intent_id, first.body.intent_id);
    assert.strictEqual(intentCount, 1, 'never a second charge');
    assert.strictEqual((await go('POST', '/api/tap/payments', { body: { ...pay, id: 'x' } })).status, 400);
    assert.strictEqual((await go('POST', '/api/tap/payments', { body: { ...pay, id: 'pay-0002-abcd', amount_minor: -5 } })).status, 400);

    // Another venue cannot read it.
    assert.strictEqual((await go('GET', '/api/tap/payments/pay-0001-abcd', { auth: token('live@venue.test') })).status, 404);

    // 4. Paid only on Captured, once.
    intentStatus = 'Created';
    assert.strictEqual((await go('GET', '/api/tap/payments/pay-0001-abcd')).body.state, 'waiting');
    intentStatus = 'Captured';
    assert.strictEqual((await go('GET', '/api/tap/payments/pay-0001-abcd')).body.state, 'paid');
    assert.strictEqual((await go('GET', '/api/tap/payments/pay-0001-abcd')).body.state, 'paid');
    assert.strictEqual([...cardLog.values()].filter((r) => r.outcome === 'approved').length, 1);
    assert.strictEqual([...cardLog.values()][0].amount, 2700);

    // Cancel: a waiting payment only.
    await go('POST', '/api/tap/payments', { body: { ...pay, id: 'pay-0003-abcd' } });
    assert.strictEqual((await go('POST', '/api/tap/payments/pay-0003-abcd/cancel')).body.state, 'cancelled');
    assert.strictEqual((await go('POST', '/api/tap/payments/pay-0001-abcd/cancel')).body.state, 'paid', 'a paid payment stays paid');

    // Tips and the venue switch (owner: tips are a venue setting, on by default).
    assert.strictEqual(config.body.tips, true);
    assert.deepStrictEqual(config.body.tip_percents, [10, 12.5, 15]);
    assert.deepStrictEqual(config.body.service_percents, [0, 10, 12.5]);
    tapSettings.set('notips@venue.test', { office: 'notips@venue.test', enabled: 1, tips_enabled: 0, tip_percents: '10', service_percents: '0', allow_cash: 1, receipt_email: 1 });
    const noTip = await go('POST', '/api/tap/payments', { auth: token('notips@venue.test'), body: { ...pay, id: 'pay-0009-abcd' } });
    assert.strictEqual(noTip.status, 400, 'a tip is refused where tips are off');
    tapSettings.set('off@venue.test', { office: 'off@venue.test', enabled: 0, tips_enabled: 1, tip_percents: '10', service_percents: '0', allow_cash: 1, receipt_email: 1 });
    assert.strictEqual((await go('POST', '/api/tap/secret', { auth: token('off@venue.test'), body: { platform: 'ios' } })).status, 403);

    // The webhook finishes a payment whose phone went away, once.
    await go('POST', '/api/tap/payments', { body: { ...pay, id: 'pay-0004-abcd' } });
    const intent4 = payments.get('pay-0004-abcd').intent_id;
    await routes.onDojoEvent({ paymentIntentId: intent4, status: 'Captured' });
    await routes.onDojoEvent({ paymentIntentId: intent4, status: 'Captured' });
    assert.strictEqual(payments.get('pay-0004-abcd').state, 'paid');
    assert.strictEqual([...cardLog.values()].filter((r) => r.outcome === 'approved').length, 2, 'one log row per payment');
    await routes.onDojoEvent({ paymentIntentId: 'pi_unknown', status: 'Captured' });

    // Registering a new venue from the app.
    const reg = await go('POST', '/api/tap/register', {
      auth: null, body: { id_token: 'verified:new@venue.test', venue_name: 'The New Inn', postcode: 'sa8 4eg', business_type: 'Pub or bar', name: 'iPhone (Vesopa Tap)' },
    });
    assert.strictEqual(reg.status, 201);
    assert.ok(reg.body.terminalToken, 'the phone is a till straight away');
    assert.strictEqual(reg.body.user.officeName, 'The New Inn');
    assert.strictEqual(offices.get('new@venue.test').plan, 'tap');
    assert.ok(users.get('new@venue.test').password.startsWith('$2'), 'a hashed, unusable password');
    assert.strictEqual(seats[0].kind, 'till', 'counts as a till');
    assert.strictEqual(tapSettings.get('new@venue.test').tip_percents, '10,12.5,15');
    const regAgain = await go('POST', '/api/tap/register', { auth: null, body: { id_token: 'verified:new@venue.test', venue_name: 'Again' } });
    assert.strictEqual(regAgain.status, 409, 'one venue per account');
    assert.strictEqual((await go('POST', '/api/tap/register', { auth: null, body: { id_token: 'unverified:x@venue.test', venue_name: 'X Bar' } })).status, 403);
    assert.strictEqual((await go('POST', '/api/tap/register', { auth: null, body: { id_token: 'nonsense', venue_name: 'X Bar' } })).status, 401);
    // The new venue's phone can use its token at once.
    assert.strictEqual((await go('GET', '/api/tap/config', { auth: reg.body.terminalToken })).status, 200);

    // The card machine instead of the phone: the venue's card-machine key and default machine.
    settings.set('machine@venue.test', { api_key_enc: seal('sk_sandbox_' + 'machine-test'), environment: 'sandbox', terminal_id: 'tm_123' });
    const m = await go('POST', '/api/tap/payments', { auth: token('machine@venue.test'), body: { ...pay, id: 'pay-0010-abcd', via: 'machine' } });
    assert.strictEqual(m.status, 201);
    assert.strictEqual(m.body.via, 'machine');
    const started = calls.find((c) => c.url.endsWith('/terminal-sessions'));
    assert.strictEqual(started.url, 'https://api.dojo.tech/terminal-sessions');
    assert.strictEqual(JSON.parse(started.init.body).terminalId, 'tm_123');
    intentStatus = 'Captured';
    assert.strictEqual((await go('GET', '/api/tap/payments/pay-0010-abcd', { auth: token('machine@venue.test') })).body.state, 'paid');
    assert.match((await go('POST', '/api/tap/payments', { body: { ...pay, id: 'pay-0011-abcd', via: 'machine' } })).body.error, /No card machine/);

    // Refunds: a manager's approval, never more than was paid, part then the rest.
    assert.strictEqual((await go('POST', '/api/tap/payments/pay-0001-abcd/refund', { body: { amount_minor: 500 } })).status, 400, 'needs approval');
    const part = await go('POST', '/api/tap/payments/pay-0001-abcd/refund', { body: { amount_minor: 500, approved_by: 'Sam', reason: 'Cold food' } });
    assert.strictEqual(part.status, 200);
    assert.strictEqual(part.body.refunded_minor, 500);
    assert.strictEqual(part.body.state, 'paid');
    assert.strictEqual((await go('POST', '/api/tap/payments/pay-0001-abcd/refund', { body: { amount_minor: 99999, approved_by: 'Sam' } })).status, 400);
    const rest = await go('POST', '/api/tap/payments/pay-0001-abcd/refund', { body: { approved_by: 'Sam' } });
    assert.strictEqual(rest.body.state, 'refunded');
    assert.strictEqual(rest.body.refunded_minor, 2700);
    const refundCall = calls.filter((c) => c.url.endsWith('/refunds')).at(-1);
    assert.ok(refundCall.url.startsWith('https://staging-api.dojo.dev/integration-test/'), 'a phone payment is refunded where it was taken');
    assert.ok(refundCall.init.headers.idempotencyKey);
    assert.strictEqual((await go('POST', '/api/tap/payments/pay-0003-abcd/refund', { body: { approved_by: 'Sam' } })).status, 409, 'only paid payments');

    // Settings cleaning.
    assert.deepStrictEqual(tap.cleanPercents('15, 10,abc,99, 12.5,10'), [10, 12.5, 15]);
    assert.strictEqual(tap.cleanSettings({ tip_percents: '', enabled: false }).tip_percents, '10,12.5,15');
    assert.strictEqual(tap.cleanSettings({ enabled: false }).enabled, 0);

    // Pure helpers.
    assert.strictEqual(tap.paymentState({ status: 'Reversed' }), 'failed');
    assert.strictEqual(tap.paymentState({ status: 'Authorized' }), 'waiting');
    assert.strictEqual(tap.cleanMinor(1_000_001), null);
    assert.strictEqual(tap.secretPath('ios'), '/tap/apple-terminal/secret');

    console.log('tap.test.js: all passed');
  } finally {
    server.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
