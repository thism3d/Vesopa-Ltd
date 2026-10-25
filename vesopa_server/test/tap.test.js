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
const payments = new Map();
const cardLog = new Map();
const pool = {
  async query(sql, args = []) {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.startsWith('SELECT api_key_enc, environment FROM epos_dojo_settings')) {
      const row = settings.get(args[0]);
      return [row ? [row] : []];
    }
    if (s.startsWith('SELECT * FROM epos_tap_payments')) {
      const row = payments.get(args[0]);
      return [row && row.office === args[1] ? [{ ...row }] : []];
    }
    if (s.startsWith('INSERT INTO epos_tap_payments')) {
      const [id, office, terminal, intent_id, amount_minor, tip_minor, bill_ref, clerk, state, environment] = args;
      payments.set(id, { id, office, terminal, intent_id, amount_minor, tip_minor, bill_ref, clerk, state, environment });
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
  app.use(tap.tapRoutes({ pool, secret: SECRET, fetchImpl: fakeFetch }));
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
