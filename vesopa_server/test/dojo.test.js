/**
 * Dojo webhooks: what gets in, what gets rejected, and what happens twice.
 *
 * Run with `npm test`. No MySQL: the queries are answered from a script, which
 * is enough for what actually goes wrong here. Three things are worth proving
 * and none of them need a database:
 *
 *   1. A forged or unsigned request cannot reach the ledger. The URL is public
 *      and the events move money in the reporting.
 *   2. The same event delivered twice is acted on once. Dojo retries up to
 *      twelve times, so this is the normal case.
 *   3. The signature check works against the *raw bytes*, in the hyphenated
 *      uppercase format Dojo actually sends — which is not what any HMAC
 *      library emits, and is the single most likely thing to be wrong.
 */

const assert = require('assert');
const crypto = require('crypto');
const express = require('express');

const { dojoWebhookRoutes, verifySignature, extract } = require('../src/dojo');

const SECRET = 'test-webhook-secret-not-a-real-one';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function fakePool(script = [], { onExecute } = {}) {
  const asked = [];
  const answer = (sql, params) => {
    asked.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    if (onExecute) {
      const forced = onExecute(sql, params);
      if (forced) return [forced, []];
    }
    for (const [pattern, rows] of script) {
      if (sql.includes(pattern)) return [rows, []];
    }
    return [[], []];
  };
  return {
    asked,
    query: async (sql, params) => answer(sql, params),
    execute: async (sql, params) => answer(sql, params),
  };
}

function appWith(pool, broadcast = () => {}) {
  const app = express();
  // Mirrors src/server.js: the raw buffer is stashed as the body is parsed.
  app.use(express.json({
    limit: '1mb',
    verify: (req, _res, buf) => { req.rawBody = buf; },
  }));
  app.use(dojoWebhookRoutes({ pool, broadcast }));
  return app;
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

/** Sign exactly the way Dojo does: uppercase hex, bytes joined with hyphens. */
function dojoSign(rawBody, secret = SECRET) {
  const hex = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const pairs = hex.toUpperCase().match(/../g);
  return `sha256=${pairs.join('-')}`;
}

async function post(server, path, bodyObj, { signature, rawOverride } = {}) {
  const raw = rawOverride !== undefined ? rawOverride : JSON.stringify(bodyObj);
  const headers = { 'Content-Type': 'application/json' };
  if (signature !== null) {
    headers['dojo-signature'] = signature === undefined ? dojoSign(raw) : signature;
  }
  const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method: 'POST',
    headers,
    body: raw,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, body: json };
}

const STATUS_EVENT = {
  Id: 'evt_1l2rI8DzeShFLaAV',
  Event: 'payment_intent.status_updated',
  AccountId: 'acc_FqNKywmkHE28wgLV_4RNTA',
  CreatedAt: '2026-08-24T00:22:25.502Z',
  Data: {
    paymentIntentId: "'pi_m18N2838ovhyC9Mw'",
    paymentStatus: 'Captured',
    captureMode: 'Auto',
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ---- The signature, on its own --------------------------------------------

test('accepts the hyphenated uppercase digest Dojo actually sends', () => {
  const raw = Buffer.from(JSON.stringify(STATUS_EVENT));
  assert.strictEqual(verifySignature(raw, dojoSign(raw), SECRET), true);
});

test('accepts a plain lowercase hex digest too', () => {
  const raw = Buffer.from(JSON.stringify(STATUS_EVENT));
  const hex = crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
  assert.strictEqual(verifySignature(raw, `sha256=${hex}`, SECRET), true);
});

test('rejects a digest computed over different bytes', () => {
  const raw = Buffer.from(JSON.stringify(STATUS_EVENT));
  const other = Buffer.from(JSON.stringify({ ...STATUS_EVENT, Id: 'evt_other' }));
  assert.strictEqual(verifySignature(raw, dojoSign(other), SECRET), false);
});

test('rejects a digest made with the wrong secret', () => {
  const raw = Buffer.from(JSON.stringify(STATUS_EVENT));
  assert.strictEqual(verifySignature(raw, dojoSign(raw, 'not-the-secret'), SECRET), false);
});

test('rejects a missing, empty or malformed signature', () => {
  const raw = Buffer.from(JSON.stringify(STATUS_EVENT));
  for (const bad of ['', null, undefined, 'sha256=', 'sha256=zz', 'garbage']) {
    assert.strictEqual(verifySignature(raw, bad, SECRET), false, `accepted ${bad}`);
  }
});

test('fails closed when no secret is configured', () => {
  const raw = Buffer.from(JSON.stringify(STATUS_EVENT));
  assert.strictEqual(verifySignature(raw, dojoSign(raw, ''), ''), false);
});

test('a truncated digest cannot crash timingSafeEqual', () => {
  const raw = Buffer.from(JSON.stringify(STATUS_EVENT));
  const short = dojoSign(raw).slice(0, 20);
  assert.strictEqual(verifySignature(raw, short, SECRET), false);
});

// ---- Payload shape --------------------------------------------------------

test('extract strips the quotes Dojo wraps around ids in its samples', () => {
  const e = extract(STATUS_EVENT);
  assert.strictEqual(e.paymentIntentId, 'pi_m18N2838ovhyC9Mw');
  assert.strictEqual(e.status, 'Captured');
  assert.strictEqual(e.event, 'payment_intent.status_updated');
});

test('extract reads a terminal-session event', () => {
  const e = extract({
    Id: 'evt_x',
    Event: 'terminal_session.notification',
    Data: {
      terminalSessionId: 'ts_m18N2838ovhyC9Mw',
      terminalId: 'tm_8h2N93kdLapQ',
      status: 'Initiated',
      notificationType: 'PresentCard',
    },
  });
  assert.strictEqual(e.terminalSessionId, 'ts_m18N2838ovhyC9Mw');
  assert.strictEqual(e.terminalId, 'tm_8h2N93kdLapQ');
  assert.strictEqual(e.notificationType, 'PresentCard');
});

test('extract tolerates lowercase envelope keys', () => {
  const e = extract({ id: 'evt_y', event: 'payment_intent.created', data: {} });
  assert.strictEqual(e.id, 'evt_y');
  assert.strictEqual(e.event, 'payment_intent.created');
});

// ---- The route ------------------------------------------------------------

test('a correctly signed event is accepted and recorded once', async () => {
  process.env.DOJO_WEBHOOK_SECRET_SANDBOX = SECRET;
  const pool = fakePool([], {
    onExecute: (sql) => (sql.includes('INSERT IGNORE') ? { affectedRows: 1 } : null),
  });
  const sent = [];
  const server = await listen(appWith(pool, (m) => sent.push(m)));
  try {
    const res = await post(server, '/api/webhooks/dojo/sandbox', STATUS_EVENT);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.status, 'accepted');

    const insert = pool.asked.find((a) => a.sql.includes('INSERT IGNORE'));
    assert.ok(insert, 'no insert was attempted');
    assert.strictEqual(insert.params[0], 'evt_1l2rI8DzeShFLaAV');
    assert.strictEqual(insert.params[2], 'sandbox');
    assert.strictEqual(insert.params[5], 'pi_m18N2838ovhyC9Mw');

    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].type, 'dojo.event');
  } finally {
    server.close();
  }
});

test('a replayed event is acknowledged but not acted on twice', async () => {
  process.env.DOJO_WEBHOOK_SECRET_SANDBOX = SECRET;
  // affectedRows 0 is what MySQL reports for the second INSERT IGNORE.
  const pool = fakePool([], {
    onExecute: (sql) => (sql.includes('INSERT IGNORE') ? { affectedRows: 0 } : null),
  });
  const sent = [];
  const server = await listen(appWith(pool, (m) => sent.push(m)));
  try {
    const res = await post(server, '/api/webhooks/dojo/sandbox', STATUS_EVENT);
    assert.strictEqual(res.status, 200, 'a duplicate must still be acknowledged');
    assert.strictEqual(res.body.status, 'duplicate');

    // The point of the whole exercise: no reconciliation, no broadcast.
    assert.ok(
      !pool.asked.some((a) => a.sql.includes('SELECT id, order_id')),
      'a duplicate must not re-run reconciliation'
    );
    assert.strictEqual(sent.length, 0, 'a duplicate must not re-broadcast');
  } finally {
    server.close();
  }
});

test('an unsigned request is rejected with 401 and never reaches the database', async () => {
  process.env.DOJO_WEBHOOK_SECRET_SANDBOX = SECRET;
  const pool = fakePool();
  const server = await listen(appWith(pool));
  try {
    const res = await post(server, '/api/webhooks/dojo/sandbox', STATUS_EVENT,
      { signature: null });
    assert.strictEqual(res.status, 401);
    assert.strictEqual(pool.asked.length, 0);
  } finally {
    server.close();
  }
});

test('a forged signature is rejected', async () => {
  process.env.DOJO_WEBHOOK_SECRET_SANDBOX = SECRET;
  const pool = fakePool();
  const server = await listen(appWith(pool));
  try {
    const res = await post(server, '/api/webhooks/dojo/sandbox', STATUS_EVENT,
      { signature: dojoSign(JSON.stringify(STATUS_EVENT), 'attacker-secret') });
    assert.strictEqual(res.status, 401);
    assert.strictEqual(pool.asked.length, 0);
  } finally {
    server.close();
  }
});

test('a body altered after signing is rejected', async () => {
  process.env.DOJO_WEBHOOK_SECRET_SANDBOX = SECRET;
  const pool = fakePool();
  const server = await listen(appWith(pool));
  try {
    // Signed over the honest body, delivered with the amount tampered with.
    const honest = JSON.stringify(STATUS_EVENT);
    const tampered = JSON.stringify({
      ...STATUS_EVENT,
      Data: { ...STATUS_EVENT.Data, paymentStatus: 'Refunded' },
    });
    const res = await post(server, '/api/webhooks/dojo/sandbox', null, {
      signature: dojoSign(honest),
      rawOverride: tampered,
    });
    assert.strictEqual(res.status, 401);
    assert.strictEqual(pool.asked.length, 0);
  } finally {
    server.close();
  }
});

test('an unconfigured environment fails closed rather than accepting anything', async () => {
  delete process.env.DOJO_WEBHOOK_SECRET_LIVE;
  const pool = fakePool();
  const server = await listen(appWith(pool));
  try {
    const res = await post(server, '/api/webhooks/dojo/live', STATUS_EVENT);
    assert.strictEqual(res.status, 401);
    assert.strictEqual(pool.asked.length, 0);
  } finally {
    server.close();
  }
});

test('sandbox and live are verified against their own secrets', async () => {
  process.env.DOJO_WEBHOOK_SECRET_SANDBOX = SECRET;
  process.env.DOJO_WEBHOOK_SECRET_LIVE = 'a-different-live-secret';
  const pool = fakePool([], {
    onExecute: (sql) => (sql.includes('INSERT IGNORE') ? { affectedRows: 1 } : null),
  });
  const server = await listen(appWith(pool));
  try {
    // The sandbox secret must not open the live endpoint.
    const crossed = await post(server, '/api/webhooks/dojo/live', STATUS_EVENT,
      { signature: dojoSign(JSON.stringify(STATUS_EVENT), SECRET) });
    assert.strictEqual(crossed.status, 401);

    const proper = await post(server, '/api/webhooks/dojo/live', STATUS_EVENT,
      { signature: dojoSign(JSON.stringify(STATUS_EVENT), 'a-different-live-secret') });
    assert.strictEqual(proper.status, 200);
  } finally {
    delete process.env.DOJO_WEBHOOK_SECRET_LIVE;
    server.close();
  }
});

test('a matched payment is reconciled and marked', async () => {
  process.env.DOJO_WEBHOOK_SECRET_SANDBOX = SECRET;
  const pool = fakePool(
    [['SELECT id, order_id', [{ id: 'pay-1', order_id: 'ord-1', amount_minor: 500 }]]],
    { onExecute: (sql) => (sql.includes('INSERT IGNORE') ? { affectedRows: 1 } : null) }
  );
  const sent = [];
  const server = await listen(appWith(pool, (m) => sent.push(m)));
  try {
    const res = await post(server, '/api/webhooks/dojo/sandbox', STATUS_EVENT);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.reconciliation, 'matched');

    const update = pool.asked.find((a) => a.sql.includes('UPDATE epos_payments'));
    assert.ok(update, 'the payment row was never updated');
    assert.strictEqual(update.params[0], 'Captured');
    assert.strictEqual(sent[0].reconciliation, 'matched');
  } finally {
    server.close();
  }
});

test('a full refund marks the whole amount refunded', async () => {
  process.env.DOJO_WEBHOOK_SECRET_SANDBOX = SECRET;
  const pool = fakePool(
    [['SELECT id, order_id', [{ id: 'pay-1', order_id: 'ord-1', amount_minor: 900 }]]],
    { onExecute: (sql) => (sql.includes('INSERT IGNORE') ? { affectedRows: 1 } : null) }
  );
  const server = await listen(appWith(pool));
  try {
    const refunded = {
      ...STATUS_EVENT,
      Id: 'evt_refunded',
      Data: { ...STATUS_EVENT.Data, paymentStatus: 'Refunded' },
    };
    await post(server, '/api/webhooks/dojo/sandbox', refunded);
    const update = pool.asked.find((a) => a.sql.includes('UPDATE epos_payments'));
    assert.strictEqual(update.params[0], 'Refunded');
    assert.strictEqual(update.params[1], 1, 'a full refund should set the amount');
  } finally {
    server.close();
  }
});

test('a partial refund does not book the full amount as refunded', async () => {
  process.env.DOJO_WEBHOOK_SECRET_SANDBOX = SECRET;
  const pool = fakePool(
    [['SELECT id, order_id', [{ id: 'pay-1', order_id: 'ord-1', amount_minor: 900 }]]],
    { onExecute: (sql) => (sql.includes('INSERT IGNORE') ? { affectedRows: 1 } : null) }
  );
  const server = await listen(appWith(pool));
  try {
    // Dojo signal a partial refund by leaving the intent Captured and moving
    // refundedAmount — the event itself carries no figure. Writing the whole
    // amount here would overstate every partial refund in the takings.
    await post(server, '/api/webhooks/dojo/sandbox', STATUS_EVENT);
    const update = pool.asked.find((a) => a.sql.includes('UPDATE epos_payments'));
    assert.strictEqual(update.params[0], 'Captured');
    assert.strictEqual(update.params[1], 0, 'must not write an amount it cannot know');
  } finally {
    server.close();
  }
});

test('an event for an unknown payment is recorded, not an error', async () => {
  process.env.DOJO_WEBHOOK_SECRET_SANDBOX = SECRET;
  // No rows come back from the lookup: the till has not uploaded this sale yet.
  const pool = fakePool([], {
    onExecute: (sql) => (sql.includes('INSERT IGNORE') ? { affectedRows: 1 } : null),
  });
  const server = await listen(appWith(pool));
  try {
    const res = await post(server, '/api/webhooks/dojo/sandbox', STATUS_EVENT);
    assert.strictEqual(res.status, 200, 'an unmatched event must not be retried');
    assert.strictEqual(res.body.reconciliation, 'unmatched');
  } finally {
    server.close();
  }
});

test('a signed but unrecognisable payload is acknowledged, not retried', async () => {
  process.env.DOJO_WEBHOOK_SECRET_SANDBOX = SECRET;
  const pool = fakePool();
  const server = await listen(appWith(pool));
  try {
    const res = await post(server, '/api/webhooks/dojo/sandbox', { hello: 'world' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.status, 'ignored');
    assert.strictEqual(pool.asked.length, 0);
  } finally {
    server.close();
  }
});

test('a database failure returns 5xx so Dojo retries', async () => {
  process.env.DOJO_WEBHOOK_SECRET_SANDBOX = SECRET;
  const pool = {
    asked: [],
    query: async () => { throw new Error('db is away'); },
    execute: async () => { throw new Error('db is away'); },
  };
  const server = await listen(appWith(pool));
  try {
    const res = await post(server, '/api/webhooks/dojo/sandbox', STATUS_EVENT);
    assert.strictEqual(res.status, 500);
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ok   ${name}`);
    } catch (err) {
      failed += 1;
      console.error(`  FAIL ${name}`);
      console.error(`       ${err.message}`);
    }
  }
  console.log(`\ndojo: ${tests.length - failed}/${tests.length} passed`);
  if (failed) process.exit(1);
})();
