'use strict';

/**
 * Vesopa Go on a phone or tablet as the remote for the venue's TVs
 * (owner, 2026-11-19: "Add options to the Vesopa Go mobile app properly to
 * control the TV kitchen and TV customer display").
 *
 *   The screen (a TV or any device running Kitchen or Customer display)
 *     POST /api/go/screen/hello        "I am here", every few seconds: its
 *                                      name, what it runs as, whether its
 *                                      live connection is up
 *
 *   The phone or tablet
 *     GET  /api/go/screens             the venue's screens awake now
 *     POST /api/go/screens/:id/key     press a key on one: up, down, left,
 *                                      right, ok, back, next, previous,
 *                                      settings, refresh, mode; on a
 *                                      kitchen screen also bump, recall,
 *                                      tickets, finished, orders, board
 *
 * A key is passed on at once over the venue's live connection (the /ws
 * socket every Go device keeps, office-scoped by `broadcast`) as
 * { type: 'go.remote', device_id, key, seq }; only the screen with that id
 * acts on it. It carries a key name and nothing else. "settings" opens the
 * screen's settings without its PIN: the phone asks for a manager's PIN on
 * its own keyboard before sending it.
 *
 * Every route takes a terminal token and works only inside that venue. Kept
 * in memory: who is awake is re-learnt within seconds of a restart.
 *
 * 2026-11-27 (owner: "fallback always go to the live server with Ping live
 * either in local and live"): every key is also queued for its screen, and
 * the screen asks for new ones every second or two
 *     GET  /api/go/screen/keys?device_id=&after=SEQ
 * so a screen whose live socket has dropped still gets them; it presses each
 * once (by the phone's id for it, or the seq). And a screen says where it can
 * be reached on the venue's own Wi-Fi (`local`: its addresses, port and a key
 * for that run), which the phones of the same venue get in the list and try
 * first ("Local"), with this server as the way when that does not answer.
 */

const express = require('express');
const { requireTerminal } = require('./auth');

const ALIVE_MS = 30 * 1000;
// 2026-11-26: 'mode' (the screen reads its mode again, after a manager made it
// a kitchen screen or a customer display from the phone, /api/go/mode/change),
// and the kitchen's own: the front ticket done, the last one back, which tab,
// which board.
const KEYS = new Set(['up', 'down', 'left', 'right', 'ok', 'back', 'next', 'previous', 'settings', 'refresh',
  'mode', 'bump', 'recall', 'tickets', 'finished', 'orders', 'board',
  // 2026-11-27, as Google TV's own remote: Home, the screen off and on, the
  // TV's volume and mute; and from the mirror of the TV's screen, press item
  // `index`, type `text` (into item `index`, or whatever has the focus), and
  // Done on the keyboard.
  'home', 'power', 'mute', 'volume_up', 'volume_down', 'tap', 'text', 'submit',
  // Voice commands on the kitchen: the newest or oldest ticket full screen,
  // and the one shown marked done.
  'expand_last', 'expand_first', 'done_shown']);
// Settings the phone changes on the screen: its colour, Day or Night, how many
// seconds a new kitchen order fills the screen.
// And how many minutes a customer display keeps the advert it shows.
const SETTING = /^(theme|appearance|popup|hold):[a-z0-9_-]{1,16}$/;
const okKey = (k) => KEYS.has(k) || SETTING.test(k);
const MODES = new Set(['kitchen', 'display', 'epos', 'terminal']);
const clamp = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const QUEUE = 50;
const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;

/** The screen's own address on the venue's network, as it says it. */
function localOf(v) {
  if (!v || typeof v !== 'object') return null;
  const ips = (Array.isArray(v.ips) ? v.ips : []).map((x) => clamp(x, 15)).filter((x) => IPV4.test(x)).slice(0, 4);
  const port = Number(v.port);
  const key = clamp(v.key, 64);
  if (!ips.length || !Number.isInteger(port) || port < 1024 || port > 65535 || !/^[a-f0-9]{16,64}$/.test(key)) return null;
  return { ips, port, key };
}

function goRemoteRoutes({ secret, broadcast, now = () => Date.now() }) {
  const router = express.Router();
  const terminal = requireTerminal(secret);
  const json = express.json();

  /** office -> device id -> { name, mode, live, tv, seen } */
  const awake = new Map();
  let seq = 0;

  const screensOf = (office) => {
    if (!awake.has(office)) awake.set(office, new Map());
    return awake.get(office);
  };

  router.post('/api/go/screen/hello', terminal, json, (req, res) => {
    const body = req.body || {};
    const id = clamp(body.device_id, 64);
    if (!id) return res.status(400).json({ error: 'Which device?' });
    const mode = clamp(body.mode, 16);
    const was = screensOf(req.office).get(id);
    screensOf(req.office).set(id, {
      state: was ? was.state : undefined,
      stateAt: was ? was.stateAt : undefined,
      keys: was ? was.keys : [],
      local: localOf(body.local),
      name: clamp(body.name, 80) || 'Screen',
      mode: MODES.has(mode) ? mode : 'display',
      live: body.live !== false,
      tv: body.tv === true,
      seen: now(),
    });
    res.json({ ok: true, seq });
  });

  /** The keys pressed on this screen after `after` (its last seq), oldest first. */
  router.get('/api/go/screen/keys', terminal, (req, res) => {
    const screen = screensOf(req.office).get(clamp(req.query.device_id, 64));
    res.set('Cache-Control', 'no-store');
    if (!screen) return res.json({ keys: [], seq });
    screen.seen = now();
    const after = Number(req.query.after) || 0;
    res.json({ keys: screen.keys.filter((k) => k.seq > after), seq });
  });

  /**
   * What the screen shows, for the phone's mirror of it: its page, its
   * buttons, tabs, settings and text boxes, and which has the focus. Sent by
   * the screen when it changes (and over the venue's local network first).
   */
  router.post('/api/go/screen/state', terminal, express.json({ limit: '64kb' }), (req, res) => {
    const body = req.body || {};
    const id = clamp(body.device_id, 64);
    const screen = id && screensOf(req.office).get(id);
    if (!screen) return res.status(404).json({ error: 'Say hello first.' });
    const st = body.state && typeof body.state === 'object' ? body.state : null;
    if (!st || JSON.stringify(st).length > 60000) return res.status(400).json({ error: 'Which state?' });
    screen.state = st;
    screen.stateAt = now();
    screen.seen = now();
    res.json({ ok: true });
  });

  router.get('/api/go/screens/:id/state', terminal, (req, res) => {
    const screen = screensOf(req.office).get(clamp(req.params.id, 64));
    if (!screen || now() - screen.seen > ALIVE_MS) return res.status(404).json({ error: 'That screen is not on just now.' });
    res.set('Cache-Control', 'no-store');
    res.json({ state: screen.state || null, at: screen.stateAt || null });
  });

  router.get('/api/go/screens', terminal, (req, res) => {
    const t = now();
    const mine = clamp(req.query.device_id, 64);
    const list = [...screensOf(req.office)]
      .filter(([id, s]) => id !== mine && t - s.seen <= ALIVE_MS)
      .map(([id, s]) => ({ device_id: id, name: s.name, mode: s.mode, live: s.live, tv: s.tv, local: s.local || null }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ screens: list });
  });

  router.post('/api/go/screens/:id/key', terminal, json, (req, res) => {
    const id = clamp(req.params.id, 64);
    const body = req.body || {};
    const key = clamp(body.key, 32);
    if (!okKey(key)) return res.status(400).json({ error: 'That is not a remote key.' });
    const screen = screensOf(req.office).get(id);
    if (!screen || now() - screen.seen > ALIVE_MS) {
      return res.status(404).json({ error: 'That screen is not on just now. Is it switched on and connected?' });
    }
    seq += 1;
    const msg = { type: 'go.remote', device_id: id, key, seq };
    if (Number.isInteger(body.index) && body.index >= 0 && body.index < 500) msg.index = body.index;
    if (typeof body.text === 'string') msg.text = body.text.slice(0, 500);
    // The phone's own id for the key, so a screen that also heard it over the
    // venue's local network acts on it once.
    const kid = clamp(body.id, 40);
    if (kid) msg.id = kid;
    broadcast(msg, { office: req.office });
    screen.keys.push(msg);
    if (screen.keys.length > QUEUE) screen.keys.splice(0, screen.keys.length - QUEUE);
    res.json({ ok: true, seq });
  });

  return router;
}

module.exports = { goRemoteRoutes, KEYS };
