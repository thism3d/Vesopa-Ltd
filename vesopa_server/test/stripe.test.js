/**
 * Stripe beside Dojo and Teya (2026-11-04), against a fake database and a
 * fake Stripe: off until chosen, a v2 account per venue, nothing taken until
 * Stripe says the venue may take cards, and signed webhooks only.
 */
const assert = require('assert');
const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_fake';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_fake';

const stripe = require('../src/stripe_client');
const { stripeRoutes } = require('../src/stripe');

const SECRET = 'test-secret-not-a-real-one';
const OFFICE = 'venue@example.com';

function fakePool() {
  const rows = new Map();
  const asked = [];
  const answer = async (sql, params = []) => {
    asked.push(sql.replace(/\s+/g, ' ').trim());
    if (/^SELECT \* FROM epos_stripe_settings WHERE office/.test(sql)) return [[rows.get(params[0])].filter(Boolean), []];
    if (/^SELECT \* FROM epos_stripe_settings WHERE account_id/.test(sql)) return [[...rows.values()].filter((r) => r.account_id === params[0]), []];
    if (/INSERT INTO epos_stripe_settings/.test(sql)) {
      const cols = sql.match(/\(office, ([^)]+)\)/)[1].split(', ');
      const row = rows.get(params[0]) || { office: params[0] };
      cols.forEach((c, i) => { row[c] = params[i + 1]; });
      rows.set(params[0], row);
      return [{ affectedRows: 1 }, []];
    }
    if (/FROM offices/.test(sql)) return [[{ name: 'The Test Arms', contact_email: OFFICE }], []];
    if (/user_permissions|bo_roles|permissions/i.test(sql)) return [[], []];
    return [[], []];
  };
  return { rows, asked, query: answer, execute: answer };
}

function fakeClient(state = {}) {
  const calls = [];
  const account = (status) => ({
    id: 'acct_test1',
    configuration: { merchant: { capabilities: { card_payments: { status }, stripe_balance: { payouts: { status } } } } },
    requirements: { entries: status === 'active' ? [] : [{ id: 'x' }] },
  });
  return {
    calls,
    configured: () => true,
    environment: () => 'sandbox',
    readiness: stripe.readiness,
    createAccount: async (a) => { calls.push(['createAccount', a]); return account('pending'); },
    retrieveAccount: async () => account(state.status || 'pending'),
    accountSession: async () => ({ client_secret: 'as_secret' }),
    loginLink: async () => ({ url: 'https://connect.stripe.com/express/x' }),
    createLocation: async () => ({ id: 'tml_1' }),
    connectionToken: async (acct, loc) => { calls.push(['token', acct, loc]); return { secret: 'pst_test' }; },
    createTerminalPayment: async (acct, p) => { calls.push(['pay', acct, p]); return { id: 'pi_1', client_secret: 'pi_1_secret', status: 'requires_payment_method' }; },
    retrievePayment: async () => ({ id: 'pi_1', status: 'succeeded', amount: 500, amount_received: 500 }),
    cancelPayment: async () => ({ id: 'pi_1', status: 'canceled' }),
    refund: async () => ({ id: 're_1', status: 'succeeded', amount: 500 }),
  };
}

function appWith(pool, client) {
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
  // The permission guard reads the database; this fake lets an office login through.
  app.use('/api', stripeRoutes({ pool, secret: SECRET, client }));
  app.use((err, _req, res, _next) => res.status(500).json({ error: String(err && err.stack) }));
  return app;
}

const listen = (app) => new Promise((r) => { const s = app.listen(0, () => r(s)); });
async function call(server, method, path, { body, token, headers = {}, raw } = {}) {
  const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    ...(raw ? { body: raw } : body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, body: json };
}

const session = jwt.sign({ sub: 1, email: OFFICE, role: 'office' }, SECRET);
const terminal = jwt.sign({ scope: 'terminal', office: OFFICE, officeId: 7 }, SECRET);

let passed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); } catch (e) { console.log(`FAIL  ${name}\n      ${e.stack}`); process.exitCode = 1; }
}

(async () => {
  console.log('Stripe\n');

  await check('form encoding is Stripe\'s', async () => {
    assert.strictEqual(stripe.form({ a: 1, b: { c: 'x' }, d: ['p', 'q'] }).toString(), 'a=1&b%5Bc%5D=x&d%5B0%5D=p&d%5B1%5D=q');
  });

  await check('readiness needs card payments and payouts both active', async () => {
    const acct = (c, p) => ({ configuration: { merchant: { capabilities: { card_payments: { status: c }, stripe_balance: { payouts: { status: p } } } } } });
    assert.strictEqual(stripe.readiness(acct('active', 'active')).ready, true);
    assert.strictEqual(stripe.readiness(acct('active', 'pending')).ready, false);
    assert.strictEqual(stripe.readiness({}).ready, false);
  });

  await check('a webhook is accepted only with a fresh, matching signature', async () => {
    const body = '{"type":"v2.core.account.updated"}';
    const t = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac('sha256', 'whsec_fake').update(`${t}.${body}`).digest('hex');
    assert.strictEqual(stripe.verifyWebhook(body, `t=${t},v1=${sig}`, 'whsec_fake'), true);
    assert.strictEqual(stripe.verifyWebhook(body, `t=${t},v1=${'0'.repeat(64)}`, 'whsec_fake'), false);
    assert.strictEqual(stripe.verifyWebhook(body, `t=${t - 3600},v1=${sig}`, 'whsec_fake'), false);
  });

  await check('a venue that never chose Stripe takes nothing through it', async () => {
    const server = await listen(appWith(fakePool(), fakeClient()));
    const r = await call(server, 'POST', '/api/till/stripe/connection-token', { token: terminal });
    server.close();
    assert.strictEqual(r.status, 409);
  });

  await check('the venue\'s account is v2, made once, and not ready until Stripe says so', async () => {
    const pool = fakePool();
    const client = fakeClient();
    const server = await listen(appWith(pool, client));
    const made = await call(server, 'POST', '/api/stripe/account', { token: session });
    const again = await call(server, 'POST', '/api/stripe/account', { token: session });
    await call(server, 'PUT', '/api/stripe-settings', { token: session, body: { enabled: true, uses: { tap: true } } });
    const tap = await call(server, 'POST', '/api/till/stripe/connection-token', { token: terminal });
    server.close();
    assert.ok([200, 201].includes(made.status), JSON.stringify(made.body));
    assert.strictEqual(made.body.account, 'acct_test1');
    assert.strictEqual(client.calls.filter((c) => c[0] === 'createAccount').length, 1, 'made once');
    assert.strictEqual(again.body.account, 'acct_test1');
    assert.strictEqual(made.body.ready, false);
    assert.strictEqual(tap.status, 409, 'pending capabilities take no payments');
  });

  await check('once active, Tap to Pay gets a token and a direct card-present payment', async () => {
    const pool = fakePool();
    const client = fakeClient({ status: 'active' });
    const server = await listen(appWith(pool, client));
    await call(server, 'POST', '/api/stripe/account', { token: session });
    await call(server, 'PUT', '/api/stripe-settings', { token: session, body: { enabled: true, uses: { tap: true } } });
    const view = await call(server, 'GET', '/api/stripe-settings?refresh=1', { token: session });
    const tok = await call(server, 'POST', '/api/till/stripe/connection-token', { token: terminal });
    const pay = await call(server, 'POST', '/api/till/stripe/payments', { token: terminal, body: { amount_minor: 500, reference: 'bill-1' } });
    const small = await call(server, 'POST', '/api/till/stripe/payments', { token: terminal, body: { amount_minor: 5 } });
    server.close();
    assert.strictEqual(view.body.ready, true, JSON.stringify(view.body));
    assert.strictEqual(JSON.stringify(view.body).includes('sk_test'), false, 'never a secret key');
    assert.strictEqual(tok.body.secret, 'pst_test');
    assert.strictEqual(pay.status, 201);
    assert.deepStrictEqual(client.calls.find((c) => c[0] === 'pay').slice(1), ['acct_test1', { amountMinor: 500, reference: 'bill-1', description: undefined, attempt: undefined }]);
    assert.strictEqual(small.status, 400);
  });

  await check('a card Stripe\'s fraud check stopped says so, with the card\'s country', async () => {
    const pool = fakePool();
    const client = fakeClient({ status: 'active' });
    let asked;
    client.retrievePayment = async (acct, id, opts) => {
      asked = opts;
      return {
        id: 'pi_2', status: 'requires_payment_method', amount: 50, amount_received: 0,
        last_payment_error: null,
        latest_charge: {
          id: 'ch_2', status: 'failed', failure_code: 'card_declined', failure_message: 'Your card was declined.',
          outcome: { type: 'blocked', reason: 'highest_risk_level', advice_code: null, network_decline_code: null },
          payment_method_details: { card_present: { country: 'BD' } },
        },
      };
    };
    const server = await listen(appWith(pool, client));
    await call(server, 'POST', '/api/stripe/account', { token: session });
    await call(server, 'PUT', '/api/stripe-settings', { token: session, body: { enabled: true, uses: { tap: true } } });
    const r = await call(server, 'GET', '/api/till/stripe/payments/pi_2', { token: terminal });
    server.close();
    assert.strictEqual(asked.expandCharge, true);
    assert.strictEqual(r.body.charge, 'ch_2');
    assert.strictEqual(r.body.error.blocked, true, JSON.stringify(r.body));
    assert.strictEqual(r.body.error.reason, 'highest_risk_level');
    assert.strictEqual(r.body.error.card_country, 'BD');
    assert.strictEqual(r.body.error.code, 'card_declined');
  });

  await check('an unsigned webhook is refused', async () => {
    const server = await listen(appWith(fakePool(), fakeClient()));
    const r = await call(server, 'POST', '/api/stripe/webhook', { body: { type: 'x' } });
    server.close();
    assert.strictEqual(r.status, 400);
  });

  console.log(`\n${passed} checks passed`);
})();
