'use strict';

// Vesopa Go as a card terminal (src/go_terminal.js): the wire between a till
// that asks and the phone that takes the card.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');

const { goTerminalRoutes } = require('../src/go_terminal');

const SECRET = 'test-secret';
const tokenFor = (office) => jwt.sign({ scope: 'terminal', office, officeId: 1 }, SECRET);

async function withServer(run) {
  let clock = 1_000_000;
  const app = express();
  app.use(goTerminalRoutes({ secret: SECRET, now: () => clock }));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (office, method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { Authorization: `Bearer ${tokenFor(office)}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  try {
    await run(call, (ms) => { clock += ms; });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('a till sends an amount, the terminal takes it, the till hears paid', async () => {
  await withServer(async (call) => {
    const hello = await call('kitchen@x', 'POST', '/api/go/terminal/hello', { device_id: 'phone', name: 'Bar phone' });
    assert.equal(hello.body.request, null);

    const list = await call('kitchen@x', 'GET', '/api/go/terminals?device_id=ipad');
    assert.deepEqual(list.body.terminals.map((t) => t.name), ['Bar phone']);
    assert.equal(list.body.terminals[0].busy, false);

    const sent = await call('kitchen@x', 'POST', '/api/go/terminal/pay', {
      device_id: 'phone', amount_minor: 1250, reference: 'bill-1', from: 'Counter iPad', clerk: 'Sam',
    });
    assert.equal(sent.status, 201);
    assert.equal(sent.body.status, 'waiting');

    // The terminal picks it up on its next hello.
    const next = await call('kitchen@x', 'POST', '/api/go/terminal/hello', { device_id: 'phone', name: 'Bar phone' });
    assert.equal(next.body.request.id, sent.body.id);
    assert.equal(next.body.request.amount_minor, 1250);
    assert.equal(next.body.request.from, 'Counter iPad');

    await call('kitchen@x', 'POST', `/api/go/terminal/requests/${sent.body.id}/update`, {
      device_id: 'phone', status: 'started', step: 'waitingForCard',
    });
    const mid = await call('kitchen@x', 'GET', `/api/go/terminal/requests/${sent.body.id}`);
    assert.equal(mid.body.status, 'started');
    assert.equal(mid.body.step, 'waitingForCard');

    await call('kitchen@x', 'POST', `/api/go/terminal/requests/${sent.body.id}/update`, {
      device_id: 'phone', status: 'paid', payment_id: 'pi_123', gateway: 'stripe',
    });
    const end = await call('kitchen@x', 'GET', `/api/go/terminal/requests/${sent.body.id}`);
    assert.equal(end.body.status, 'paid');
    assert.equal(end.body.payment_id, 'pi_123');

    // A verdict is never rewritten.
    const late = await call('kitchen@x', 'POST', `/api/go/terminal/requests/${sent.body.id}/update`, {
      device_id: 'phone', status: 'declined',
    });
    assert.equal(late.body.status, 'paid');
  });
});

test('one venue never sees or pays on another venue\'s terminal', async () => {
  await withServer(async (call) => {
    await call('kitchen@x', 'POST', '/api/go/terminal/hello', { device_id: 'phone', name: 'Bar phone' });
    const other = await call('club@y', 'GET', '/api/go/terminals');
    assert.deepEqual(other.body.terminals, []);
    const sent = await call('club@y', 'POST', '/api/go/terminal/pay', { device_id: 'phone', amount_minor: 500 });
    assert.equal(sent.status, 409);

    const mine = await call('kitchen@x', 'POST', '/api/go/terminal/pay', { device_id: 'phone', amount_minor: 500 });
    const peek = await call('club@y', 'GET', `/api/go/terminal/requests/${mine.body.id}`);
    assert.equal(peek.status, 404);
  });
});

test('a terminal that is asleep, busy or not ready refuses, and nothing is sent', async () => {
  await withServer(async (call, pass) => {
    const none = await call('kitchen@x', 'POST', '/api/go/terminal/pay', { device_id: 'phone', amount_minor: 500 });
    assert.equal(none.status, 409);
    assert.equal(none.body.asleep, true);

    await call('kitchen@x', 'POST', '/api/go/terminal/hello', { device_id: 'phone', name: 'Bar phone', ready: false, why: 'NFC is off' });
    const off = await call('kitchen@x', 'POST', '/api/go/terminal/pay', { device_id: 'phone', amount_minor: 500 });
    assert.equal(off.status, 409);
    assert.equal(off.body.error, 'NFC is off');

    await call('kitchen@x', 'POST', '/api/go/terminal/hello', { device_id: 'phone', name: 'Bar phone' });
    const first = await call('kitchen@x', 'POST', '/api/go/terminal/pay', { device_id: 'phone', amount_minor: 500 });
    assert.equal(first.status, 201);
    const second = await call('kitchen@x', 'POST', '/api/go/terminal/pay', { device_id: 'phone', amount_minor: 700 });
    assert.equal(second.status, 409);
    assert.equal(second.body.busy, true);

    const bad = await call('kitchen@x', 'POST', '/api/go/terminal/pay', { device_id: 'phone', amount_minor: -5 });
    assert.equal(bad.status, 400);

    // Thirty seconds without a hello: it has gone to sleep.
    pass(30_000);
    const list = await call('kitchen@x', 'GET', '/api/go/terminals');
    assert.deepEqual(list.body.terminals, []);
  });
});

test('never picked up: expired, nothing taken. Started then silent: uncertain', async () => {
  await withServer(async (call, pass) => {
    await call('kitchen@x', 'POST', '/api/go/terminal/hello', { device_id: 'phone', name: 'Bar phone' });
    const a = await call('kitchen@x', 'POST', '/api/go/terminal/pay', { device_id: 'phone', amount_minor: 500 });
    pass(46_000);
    const expired = await call('kitchen@x', 'GET', `/api/go/terminal/requests/${a.body.id}`);
    assert.equal(expired.body.status, 'expired');
    assert.equal(expired.body.uncertain, false);

    await call('kitchen@x', 'POST', '/api/go/terminal/hello', { device_id: 'phone', name: 'Bar phone' });
    const b = await call('kitchen@x', 'POST', '/api/go/terminal/pay', { device_id: 'phone', amount_minor: 500 });
    await call('kitchen@x', 'POST', `/api/go/terminal/requests/${b.body.id}/update`, { device_id: 'phone', status: 'started' });
    pass(6 * 60_000);
    const lost = await call('kitchen@x', 'GET', `/api/go/terminal/requests/${b.body.id}`);
    assert.equal(lost.body.status, 'failed');
    assert.equal(lost.body.uncertain, true);
  });
});

test('cancel: before pick-up it is cancelled; once started the terminal is asked', async () => {
  await withServer(async (call) => {
    await call('kitchen@x', 'POST', '/api/go/terminal/hello', { device_id: 'phone', name: 'Bar phone' });
    const a = await call('kitchen@x', 'POST', '/api/go/terminal/pay', { device_id: 'phone', amount_minor: 500 });
    const stopped = await call('kitchen@x', 'POST', `/api/go/terminal/requests/${a.body.id}/cancel`);
    assert.equal(stopped.body.status, 'cancelled');

    const b = await call('kitchen@x', 'POST', '/api/go/terminal/pay', { device_id: 'phone', amount_minor: 500 });
    await call('kitchen@x', 'POST', `/api/go/terminal/requests/${b.body.id}/update`, { device_id: 'phone', status: 'started' });
    const asked = await call('kitchen@x', 'POST', `/api/go/terminal/requests/${b.body.id}/cancel`);
    assert.equal(asked.body.status, 'started');
    assert.equal(asked.body.cancel, true);
    const hello = await call('kitchen@x', 'POST', '/api/go/terminal/hello', { device_id: 'phone', name: 'Bar phone' });
    assert.equal(hello.body.request.cancel, true);

    // Another device cannot answer for this terminal.
    const wrong = await call('kitchen@x', 'POST', `/api/go/terminal/requests/${b.body.id}/update`, { device_id: 'ipad', status: 'paid' });
    assert.equal(wrong.status, 403);
  });
});

test('no token, no terminal routes', async () => {
  const app = express();
  app.use(goTerminalRoutes({ secret: SECRET }));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/go/terminals`);
    assert.equal(res.status, 401);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
