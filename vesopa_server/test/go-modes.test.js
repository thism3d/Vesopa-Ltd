// What a Vesopa Go device runs as, set by the back office (src/go_modes.js).
const assert = require('assert');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');

const SECRET = 'test-secret';
const OFFICE = 'venue@venue.test';
const modes = new Map(); // `${office}|${device}` -> row
const seats = new Map([['seat-1', { device_id: 'ipad-1', device_name: 'Bar iPad', kind: 'go' }]]);
const displaySeats = [];

const pool = {
  async query(sql, args = []) {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.startsWith('CREATE TABLE IF NOT EXISTS bo_go_device_modes')) return [{}];
    if (s.startsWith('SELECT device_id, device_name, kind FROM bo_till_seats WHERE id = ?')) {
      const row = seats.get(args[0]);
      return [row ? [row] : []];
    }
    // requireTerminal's seat check.
    if (s.includes('FROM bo_till_seats') && s.includes('released_at')) {
      if (s.startsWith('SELECT device_id, device_name, signed_in_at')) {
        return [[{ device_id: 'ipad-1', device_name: 'Bar iPad', signed_in_at: new Date(), last_seen_at: new Date() }]];
      }
      return [[{ id: args[0], released_at: null }]];
    }
    if (s.startsWith('SELECT mode FROM bo_go_device_modes')) {
      const row = modes.get(`${args[0]}|${args[1]}`);
      return [row ? [row] : []];
    }
    if (s.startsWith('INSERT INTO bo_go_device_modes (office, device_id, mode, running, running_at)')) {
      const key = `${args[0]}|${args[1]}`;
      modes.set(key, { mode: 'ask', ...(modes.get(key) || {}), device_id: args[1], running: args[2] });
      return [{ affectedRows: 1 }];
    }
    if (s.startsWith('INSERT INTO bo_go_device_modes (office, device_id, mode, updated_by)')) {
      const key = `${args[0]}|${args[1]}`;
      modes.set(key, { ...(modes.get(key) || {}), device_id: args[1], mode: args[2], updated_by: args[3] });
      return [{ affectedRows: 1 }];
    }
    if (s.startsWith('SELECT device_id, mode, running')) {
      return [[...modes.entries()].filter(([k]) => k.startsWith(args[0] + '|')).map(([, v]) => v)];
    }
    if (s.startsWith('SELECT name FROM offices')) return [[{ name: 'The Venue' }]];
    if (s.startsWith('SELECT contact_email FROM offices WHERE id = ?')) return [[{ contact_email: OFFICE }]];
    throw new Error('unexpected SQL in test: ' + s.slice(0, 90));
  },
};

// The licences module, faked: a display seat is counted.
require.cache[require.resolve('../src/licences')] = {
  exports: { signInDevice: async (_p, d) => { displaySeats.push(d); return `dseat-${displaySeats.length}`; } },
};
// Permissions, faked: a manager may, staff may not.
require.cache[require.resolve('../src/permissions')] = {
  exports: {
    attachAccess: () => (req, _res, next) => next(),
    requirePermission: () => (req, res, next) => (req.user.role === 'manager' ? next() : res.status(403).json({ error: 'no' })),
  },
};
const { goModeRoutes } = require('../src/go_modes');

async function main() {
  const app = express();
  const auth = (req, res, next) => {
    try {
      req.user = jwt.verify(String(req.headers.authorization || '').slice(7), SECRET);
      next();
    } catch {
      res.status(401).end();
    }
  };
  app.use(goModeRoutes({ pool, secret: SECRET, auth }));
  const server = http.createServer(app).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const terminal = jwt.sign({ scope: 'terminal', office: OFFICE, commissionedBy: 'jo@venue.test' }, SECRET, { jwtid: 'seat-1' });
  const manager = jwt.sign({ id: 1, email: 'boss@venue.test', role: 'manager', officeId: 7 }, SECRET);
  const staff = jwt.sign({ id: 2, email: 'sam@venue.test', role: 'staff', officeId: 7 }, SECRET);
  const go = async (method, path, { auth: a = terminal, body } = {}) => {
    const r = await fetch(base + path, {
      method, headers: { Authorization: `Bearer ${a}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  try {
    // A device nobody has set asks.
    let m = await go('GET', '/api/go/mode');
    assert.strictEqual(m.status, 200);
    assert.deepStrictEqual([m.body.mode, m.body.fixed, m.body.device_id], ['ask', false, 'ipad-1']);

    // On ask, the device may make itself a kitchen screen or a display.
    const k = await go('POST', '/api/go/mode-token', { body: { mode: 'kitchen' } });
    assert.strictEqual(k.status, 200);
    const kc = jwt.verify(k.body.token, SECRET);
    assert.deepStrictEqual([kc.scope, kc.office, kc.via], ['kitchen', OFFICE, 'go']);
    const d = await go('POST', '/api/go/mode-token', { body: { mode: 'display' } });
    assert.strictEqual(jwt.verify(d.body.token, SECRET).scope, 'display');
    assert.strictEqual(displaySeats[0].kind, 'display', 'a display licence is counted');
    assert.strictEqual(displaySeats[0].deviceId, 'go-ipad-1');
    assert.strictEqual((await go('POST', '/api/go/mode-token', { body: { mode: 'till' } })).status, 400);

    // The back office lists it, and only a manager sets it.
    const list = await go('GET', '/api/go/device-modes', { auth: manager });
    assert.strictEqual(list.body.devices[0].device_id, 'ipad-1');
    assert.strictEqual(list.body.devices[0].mode, 'ask');
    assert.strictEqual((await go('PUT', '/api/go/device-modes/ipad-1', { auth: staff, body: { mode: 'kitchen' } })).status, 403);
    assert.strictEqual((await go('PUT', '/api/go/device-modes/ipad-1', { auth: manager, body: { mode: 'nope' } })).status, 400);
    assert.strictEqual((await go('PUT', '/api/go/device-modes/ipad-1', { auth: manager, body: { mode: 'epos' } })).status, 200);

    // Fixed as a till: it opens as one, and cannot make itself a screen.
    m = await go('GET', '/api/go/mode');
    assert.deepStrictEqual([m.body.mode, m.body.fixed], ['epos', true]);
    const refused = await go('POST', '/api/go/mode-token', { body: { mode: 'display' } });
    assert.strictEqual(refused.status, 403);
    assert.match(refused.body.error, /EPOS/);

    // Fixed as a kitchen: the kitchen token, and the device says what it shows.
    await go('PUT', '/api/go/device-modes/ipad-1', { auth: manager, body: { mode: 'kitchen' } });
    assert.strictEqual((await go('POST', '/api/go/mode-token', { body: { mode: 'kitchen' } })).status, 200);
    assert.strictEqual((await go('POST', '/api/go/mode/report', { body: { running: 'kitchen' } })).status, 200);
    const after = await go('GET', '/api/go/device-modes', { auth: manager });
    assert.deepStrictEqual([after.body.devices[0].mode, after.body.devices[0].running], ['kitchen', 'kitchen']);
    console.log('go-modes.test.js: all passed');
  } finally {
    server.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
