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
 *                                      settings, refresh
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
const KEYS = new Set(['up', 'down', 'left', 'right', 'ok', 'back', 'next', 'previous', 'settings', 'refresh']);
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
    screensOf(req.office).set(id, {
      name: clamp(body.name, 80) || 'Screen',
      mode: MODES.has(mode) ? mode : 'display',
      live: body.live !== false,
      tv: body.tv === true,
      seen: now(),
    });
    res.json({ ok: true });
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
    const key = clamp((req.body || {}).key, 16);
    if (!KEYS.has(key)) return res.status(400).json({ error: 'That is not a remote key.' });
    const screen = screensOf(req.office).get(id);
    if (!screen || now() - screen.seen > ALIVE_MS) {
      return res.status(404).json({ error: 'That screen is not on just now. Is it switched on and connected?' });
    }
    seq += 1;
    broadcast({ type: 'go.remote', device_id: id, key, seq }, { office: req.office });
    res.json({ ok: true, seq });
  });

  return router;
}

module.exports = { goRemoteRoutes, KEYS };
