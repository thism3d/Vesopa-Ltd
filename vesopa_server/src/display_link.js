/**
 * Customer displays: signing in with an email, and reaching a till on another
 * computer (2026-10-17).
 *
 * SIGNING IN
 *
 * The owner could not sign a customer display in with the venue's manager
 * login: the display only offered Continue with Vesopa, which wants an
 * auth.vesopa.com account, while the till signs in with the back office's own
 * email and password. "Verify using email and password like epos login" --
 * so POST /api/display/login checks exactly what /api/login checks and issues
 * the same display token the Vesopa door issues (terminal_vesopa.js), counted
 * against the venue's display licences the same way.
 *
 * ANOTHER COMPUTER
 *
 * "Display might be used on another computer." Until now a display paired
 * through a folder on the till's own PC. Across machines, the till and the
 * display both already hold the venue's credential and both can reach this
 * server, so they meet on its WebSocket (/ws) rather than through a port the
 * venue would have to open:
 *
 *   display -> {type:'display.hello', role:'display', token, device, name, code, version}
 *   till    -> {type:'display.hello', role:'till', token, device, name}
 *   server  -> till:    {type:'display.requests', list:[{device,name,code,version}]}
 *                       {type:'display.paired_list', list:[{device,name,online}]}
 *                       {type:'display.status', device, data}
 *   till    -> server:  {type:'display.accept', device} | {type:'display.unpair', device}
 *                       {type:'display.basket', data} | {type:'display.control', data}
 *   server  -> display: {type:'display.paired', terminal, terminalName, venue}
 *                       {type:'display.unpaired'}
 *                       {type:'display.basket', data} | {type:'display.control', data}
 *   display -> server:  {type:'display.status', data}
 *
 * Every message is scoped by the office in the sender's token, and a basket
 * goes only to the displays paired with the till that sent it. The last
 * basket and settings a till sent are kept in memory, so a display that
 * reconnects is showing the bill again at once rather than after the next
 * item is rung up.
 */
'use strict';

const express = require('express');
const jwt = require('jsonwebtoken');
const { verifyPassword, AccessDeniedError } = require('./auth');
const licences = require('./licences');

const DISPLAY_TOKEN_TTL = '90d';
const MAX_MESSAGE = 256 * 1024;

const clamp = (v, n) => (v == null ? null : String(v).trim().slice(0, n) || null);

function displayLinkRoutes({ pool, secret }) {
  const router = express.Router();

  router.post('/api/display/login', express.json(), async (req, res, next) => {
    try {
      const body = req.body || {};
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      if (!email || !password) {
        return res.status(400).json({ error: 'Your email and password are both required.' });
      }

      let user;
      try {
        user = await verifyPassword(pool, email, password);
      } catch (e) {
        if (e instanceof AccessDeniedError) return res.status(403).json({ error: e.message });
        throw e;
      }
      if (!user) return res.status(401).json({ error: 'That email or password is not right.' });
      if (!user.officeEmail) {
        return res.status(403).json({
          error: 'This login is not attached to a venue, so it cannot set up a display.',
        });
      }

      let seatId = null;
      try {
        seatId = await licences.signInDevice(pool, {
          office: user.officeEmail,
          kind: 'display',
          deviceId: clamp(body.device_id, 64),
          deviceName: clamp(body.device_name, 120),
          fingerprint: clamp(body.device_fingerprint, 64),
          licenceKey: clamp(body.licence_key, 64),
          by: email,
        });
      } catch (e) {
        if (e.name === 'SeatLimitError') {
          return res.status(409).json({
            error: e.message,
            licences: e.limit,
            seats: (e.seats || []).map((x) => ({ name: x.device_name })),
          });
        }
        if (e.licenceKey) return res.status(403).json({ error: e.message, licence_key: true });
        throw e;
      }

      const token = jwt.sign(
        {
          scope: 'display',
          office: user.officeEmail,
          user: email,
          name: user.name || email,
          via: 'password',
        },
        secret,
        seatId ? { expiresIn: DISPLAY_TOKEN_TTL, jwtid: seatId } : { expiresIn: DISPLAY_TOKEN_TTL },
      );
      return res.json({
        token,
        office: user.officeEmail,
        venue: user.officeName || null,
        seat: Boolean(seatId),
      });
    } catch (e) {
      return next(e);
    }
  });

  return router;
}

/**
 * The relay, on the server's existing WebSocket. Adds its own listener to each
 * connection and leaves everything else on the socket alone.
 */
function attachDisplayRelay(wss, { pool, secret }) {
  /** office -> Map(device -> ws) for each role. */
  const tills = new Map();
  const displays = new Map();
  /** `${office}|${terminal}` -> { basket, control } last sent by that till. */
  const lastSent = new Map();

  const roleMap = (map, office) => {
    if (!map.has(office)) map.set(office, new Map());
    return map.get(office);
  };
  const send = (ws, msg) => {
    try {
      if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    } catch {
      // A socket that is going away; the heartbeat in server.js reaps it.
    }
  };

  async function pairsFor(office, terminal) {
    try {
      const [rows] = await pool.query(
        `SELECT display_device, display_name, terminal_device, terminal_name
           FROM epos_display_pairs WHERE office = ? AND terminal_device = ?`,
        [office, terminal]
      );
      return rows;
    } catch {
      return [];
    }
  }

  async function pairOf(office, display) {
    try {
      const [[row]] = await pool.query(
        `SELECT terminal_device, terminal_name FROM epos_display_pairs
          WHERE office = ? AND display_device = ?`,
        [office, display]
      );
      return row || null;
    } catch {
      return null;
    }
  }

  /** Tell every till in [office] who is waiting, and each its own displays. */
  async function refreshTills(office) {
    const waiting = [];
    for (const [device, ws] of roleMap(displays, office)) {
      if (!ws.pairedTo) {
        waiting.push({ device, name: ws.deviceName, code: ws.code, version: ws.version });
      }
    }
    for (const [terminal, ws] of roleMap(tills, office)) {
      send(ws, { type: 'display.requests', list: waiting });
      const pairs = await pairsFor(office, terminal);
      send(ws, {
        type: 'display.paired_list',
        list: pairs.map((p) => ({
          device: p.display_device,
          name: p.display_name || 'Customer display',
          online: roleMap(displays, office).has(p.display_device),
        })),
      });
    }
  }

  function verify(token, scope) {
    try {
      const claims = jwt.verify(String(token || ''), secret);
      if (claims.scope !== scope || !claims.office) return null;
      return claims;
    } catch {
      return null;
    }
  }

  async function onHello(ws, msg) {
    const role = msg.role === 'till' ? 'till' : msg.role === 'display' ? 'display' : null;
    const claims = role && verify(msg.token, role === 'till' ? 'terminal' : 'display');
    const device = clamp(msg.device, 64);
    if (!claims || !device) {
      send(ws, { type: 'display.refused', error: 'This screen needs to be signed in again.' });
      return;
    }
    ws.displayRole = role;
    ws.displayOffice = claims.office;
    ws.displayDevice = device;
    ws.deviceName = clamp(msg.name, 120) || (role === 'till' ? 'Till' : 'Customer display');
    ws.code = clamp(msg.code, 8);
    ws.version = clamp(msg.version, 24);

    const office = claims.office;
    if (role === 'till') {
      roleMap(tills, office).set(device, ws);
      send(ws, { type: 'display.welcome', role });
      // Tell this till's paired displays it is back, with the last screen.
      for (const p of await pairsFor(office, device)) {
        const d = roleMap(displays, office).get(p.display_device);
        if (d) {
          d.pairedTo = device;
          send(d, { type: 'display.paired', terminal: device, terminalName: ws.deviceName });
        }
      }
    } else {
      roleMap(displays, office).set(device, ws);
      const pair = await pairOf(office, device);
      if (pair) {
        ws.pairedTo = pair.terminal_device;
        send(ws, {
          type: 'display.paired',
          terminal: pair.terminal_device,
          terminalName: pair.terminal_name || 'the till',
        });
        const last = lastSent.get(`${office}|${pair.terminal_device}`);
        if (last && last.control) send(ws, { type: 'display.control', data: last.control });
        if (last && last.basket) send(ws, { type: 'display.basket', data: last.basket });
      } else {
        ws.pairedTo = null;
        send(ws, { type: 'display.welcome', role, paired: false });
      }
    }
    await refreshTills(office);
  }

  async function onTill(ws, msg) {
    const office = ws.displayOffice;
    const terminal = ws.displayDevice;
    if (msg.type === 'display.accept') {
      const device = clamp(msg.device, 64);
      const d = device && roleMap(displays, office).get(device);
      if (!d) {
        send(ws, { type: 'display.error', error: 'That display is no longer waiting. Check it is on and signed in.' });
        return;
      }
      await pool.execute(
        `INSERT INTO epos_display_pairs
           (office, display_device, display_name, terminal_device, terminal_name)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE display_name = VALUES(display_name),
           terminal_device = VALUES(terminal_device), terminal_name = VALUES(terminal_name),
           paired_at = CURRENT_TIMESTAMP`,
        [office, device, d.deviceName, terminal, ws.deviceName]
      );
      d.pairedTo = terminal;
      send(d, { type: 'display.paired', terminal, terminalName: ws.deviceName });
      const last = lastSent.get(`${office}|${terminal}`);
      if (last && last.control) send(d, { type: 'display.control', data: last.control });
      if (last && last.basket) send(d, { type: 'display.basket', data: last.basket });
      await refreshTills(office);
      return;
    }
    if (msg.type === 'display.unpair') {
      const device = clamp(msg.device, 64);
      if (!device) return;
      await pool.execute(
        'DELETE FROM epos_display_pairs WHERE office = ? AND display_device = ? AND terminal_device = ?',
        [office, device, terminal]
      );
      const d = roleMap(displays, office).get(device);
      if (d) {
        d.pairedTo = null;
        send(d, { type: 'display.unpaired' });
      }
      await refreshTills(office);
      return;
    }
    if (msg.type === 'display.basket' || msg.type === 'display.control') {
      if (!msg.data || typeof msg.data !== 'object') return;
      const key = `${office}|${terminal}`;
      const last = lastSent.get(key) || {};
      if (msg.type === 'display.basket') last.basket = msg.data;
      else last.control = msg.data;
      lastSent.set(key, last);
      for (const d of roleMap(displays, office).values()) {
        if (d.pairedTo === terminal) send(d, { type: msg.type, data: msg.data });
      }
    }
  }

  function onDisplay(ws, msg) {
    if (msg.type !== 'display.status' || !ws.pairedTo) return;
    const t = roleMap(tills, ws.displayOffice).get(ws.pairedTo);
    if (t) send(t, { type: 'display.status', device: ws.displayDevice, name: ws.deviceName, data: msg.data });
  }

  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      if (raw.length > MAX_MESSAGE) return;
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('display.')) return;
      const run = async () => {
        if (msg.type === 'display.hello') return onHello(ws, msg);
        if (!ws.displayRole) return undefined;
        return ws.displayRole === 'till' ? onTill(ws, msg) : onDisplay(ws, msg);
      };
      run().catch((e) => console.error('[display_link]', e.message));
    });

    ws.on('close', () => {
      const office = ws.displayOffice;
      if (!office) return;
      const map = ws.displayRole === 'till' ? tills : displays;
      const m = roleMap(map, office);
      if (m.get(ws.displayDevice) === ws) m.delete(ws.displayDevice);
      refreshTills(office).catch(() => {});
    });
  });
}

module.exports = { displayLinkRoutes, attachDisplayRelay };
