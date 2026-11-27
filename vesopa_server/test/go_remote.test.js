'use strict';

// Vesopa Go as the remote for the venue's TVs (src/go_remote.js): a screen
// says it is here, a phone lists it and presses its keys, and only that
// venue's sockets hear them.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');

const { goRemoteRoutes } = require('../src/go_remote');

const SECRET = 'test-secret';
const tokenFor = (office) => jwt.sign({ scope: 'terminal', office, officeId: 1 }, SECRET);

async function withServer(run) {
  let clock = 1_000_000;
  const sent = [];
  const app = express();
  app.use(goRemoteRoutes({ secret: SECRET, now: () => clock, broadcast: (msg, opts) => sent.push({ msg, opts }) }));
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
    await run(call, sent, (ms) => { clock += ms; });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('a phone lists the venue\'s TVs and presses a key on one', async () => {
  await withServer(async (call, sent) => {
    await call('kitchen@x', 'POST', '/api/go/screen/hello', { device_id: 'tv1', name: 'Kitchen TV', mode: 'kitchen', tv: true });
    await call('kitchen@x', 'POST', '/api/go/screen/hello', { device_id: 'tv2', name: 'Bar TV', mode: 'display', tv: true });
    const list = await call('kitchen@x', 'GET', '/api/go/screens?device_id=phone');
    assert.deepEqual(list.body.screens.map((s) => [s.name, s.mode, s.tv]), [['Bar TV', 'display', true], ['Kitchen TV', 'kitchen', true]]);

    const pressed = await call('kitchen@x', 'POST', '/api/go/screens/tv2/key', { key: 'next' });
    assert.equal(pressed.status, 200);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].opts, { office: 'kitchen@x' });
    assert.equal(sent[0].msg.type, 'go.remote');
    assert.equal(sent[0].msg.device_id, 'tv2');
    assert.equal(sent[0].msg.key, 'next');
  });
});

test('only known keys, only awake screens, only the same venue', async () => {
  await withServer(async (call, sent, pass) => {
    await call('kitchen@x', 'POST', '/api/go/screen/hello', { device_id: 'tv1', name: 'Kitchen TV', mode: 'kitchen' });
    assert.equal((await call('kitchen@x', 'POST', '/api/go/screens/tv1/key', { key: 'rm -rf' })).status, 400);
    assert.equal((await call('club@y', 'POST', '/api/go/screens/tv1/key', { key: 'ok' })).status, 404);
    assert.deepEqual((await call('club@y', 'GET', '/api/go/screens')).body.screens, []);
    pass(31 * 1000);
    assert.equal((await call('kitchen@x', 'POST', '/api/go/screens/tv1/key', { key: 'ok' })).status, 404);
    assert.deepEqual((await call('kitchen@x', 'GET', '/api/go/screens')).body.screens, []);
    assert.equal(sent.length, 0);
  });
});

test('a TV made a kitchen screen from the phone: mode, then the kitchen keys', async () => {
  await withServer(async (call, sent) => {
    await call('kitchen@x', 'POST', '/api/go/screen/hello', { device_id: 'tv2', name: 'Bar TV', mode: 'display', tv: true });
    for (const key of ['mode', 'bump', 'recall', 'tickets', 'finished', 'orders', 'board']) {
      assert.equal((await call('kitchen@x', 'POST', '/api/go/screens/tv2/key', { key })).status, 200, key);
    }
    assert.deepEqual(sent.map((s) => s.msg.key), ['mode', 'bump', 'recall', 'tickets', 'finished', 'orders', 'board']);
  });
});

test('the mirror: a screen posts what it shows, the phone reads it and taps, types and sets', async () => {
  await withServer(async (call, sent) => {
    assert.equal((await call('kitchen@x', 'POST', '/api/go/screen/state', { device_id: 'tv9', state: { title: 'x' } })).status, 404);
    await call('kitchen@x', 'POST', '/api/go/screen/hello', { device_id: 'tv9', name: 'Pass TV', mode: 'kitchen', tv: true });
    const st = { title: 'Kitchen', items: [{ label: 'Open 3', kind: 'tab', focused: true }] };
    assert.equal((await call('kitchen@x', 'POST', '/api/go/screen/state', { device_id: 'tv9', state: st })).status, 200);
    await call('kitchen@x', 'POST', '/api/go/screen/hello', { device_id: 'tv9', name: 'Pass TV', mode: 'kitchen', tv: true });
    const got = await call('kitchen@x', 'GET', '/api/go/screens/tv9/state');
    assert.deepEqual(got.body.state, st, 'kept across hellos');
    assert.equal((await call('club@y', 'GET', '/api/go/screens/tv9/state')).status, 404, 'only the same venue');

    await call('kitchen@x', 'POST', '/api/go/screens/tv9/key', { key: 'tap', index: 0, id: 'k1' });
    await call('kitchen@x', 'POST', '/api/go/screens/tv9/key', { key: 'text', text: 'Pass', id: 'k2' });
    await call('kitchen@x', 'POST', '/api/go/screens/tv9/key', { key: 'theme:pink' });
    await call('kitchen@x', 'POST', '/api/go/screens/tv9/key', { key: 'volume_up' });
    assert.equal((await call('kitchen@x', 'POST', '/api/go/screens/tv9/key', { key: 'theme:<script>' })).status, 400);
    assert.deepEqual(sent.map((s) => [s.msg.key, s.msg.index, s.msg.text, s.msg.id]), [
      ['tap', 0, undefined, 'k1'], ['text', undefined, 'Pass', 'k2'], ['theme:pink', undefined, undefined, undefined], ['volume_up', undefined, undefined, undefined],
    ]);
  });
});

test('a screen whose live socket dropped asks for its keys; its local address goes to the phones', async () => {
  await withServer(async (call) => {
    const local = { ips: ['192.168.1.40', 'bad'], port: 47870, key: 'a'.repeat(32) };
    const hi = await call('kitchen@x', 'POST', '/api/go/screen/hello', { device_id: 'tv1', name: 'Bar TV', mode: 'display', tv: true, live: false, local });
    assert.equal(hi.status, 200);
    const list = await call('kitchen@x', 'GET', '/api/go/screens?device_id=phone');
    assert.deepEqual(list.body.screens[0].local, { ips: ['192.168.1.40'], port: 47870, key: 'a'.repeat(32) });
    assert.equal(list.body.screens[0].live, false);

    await call('kitchen@x', 'POST', '/api/go/screens/tv1/key', { key: 'next', id: 'k1' });
    await call('kitchen@x', 'POST', '/api/go/screens/tv1/key', { key: 'ok', id: 'k2' });
    const first = await call('kitchen@x', 'GET', '/api/go/screen/keys?device_id=tv1&after=0');
    assert.deepEqual(first.body.keys.map((k) => [k.key, k.id]), [['next', 'k1'], ['ok', 'k2']]);
    const later = await call('kitchen@x', 'GET', `/api/go/screen/keys?device_id=tv1&after=${first.body.keys[1].seq}`);
    assert.deepEqual(later.body.keys, []);
    // Another venue sees neither the screen nor its keys.
    const other = await call('pub@y', 'GET', '/api/go/screen/keys?device_id=tv1&after=0');
    assert.deepEqual(other.body.keys, []);
    // A bad local address is not passed on.
    await call('kitchen@x', 'POST', '/api/go/screen/hello', { device_id: 'tv2', name: 'TV 2', local: { ips: ['x'], port: 80, key: 'zz' } });
    const again = await call('kitchen@x', 'GET', '/api/go/screens?device_id=phone');
    assert.equal(again.body.screens.find((s) => s.device_id === 'tv2').local, null);
  });
});
