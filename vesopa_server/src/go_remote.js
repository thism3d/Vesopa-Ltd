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
      name: clamp(body.name, 80) || 'Screen',
      mode: MODES.has(mode) ? mode : 'display',
      live: body.live !== false,
      tv: body.tv === true,
      seen: now(),
    });
    res.json({ ok: true });
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
      .map(([id, s]) => ({ device_id: id, name: s.name, mode: s.mode, live: s.live, tv: s.tv }))
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
    res.json({ ok: true, seq });
  });

  return router;
}

module.exports = { goRemoteRoutes, KEYS };
