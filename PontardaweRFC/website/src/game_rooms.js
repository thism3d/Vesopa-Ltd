/**
 * Ponty Kicks online: two people, one room code, taking turns (2026-10-15).
 *
 * The game is turn-based and the kicks are deterministic: both phones know
 * the room's seed, so both work out the same spots and the same wind, and a
 * kick is its aim and its power, plus the verdict the kicker's own phone
 * worked out (so two browsers never disagree over a ball that clipped a
 * post). The server keeps the room and relays kicks in order.
 *
 * A WebSocket is the fast way (the owner, 2026-10-15): every change is
 * pushed to both phones the moment it happens, at /api/play/ws. The same
 * actions also work as plain HTTP, which the game falls back to (polling)
 * if a network will not hold a socket open. Rooms live in memory for two
 * hours after their last move; a restart ends them, which for a kicking
 * game between friends is fine.
 */
'use strict';

const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { TEAM_KEYS } = require('../public/js/game-rules.js');

const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I
const IDLE_MS = 2 * 60 * 60 * 1000;
const MAX_ROOMS = 400;
const MAX_KICKS = 40; // five rounds each, then sudden death to round 20
const rooms = new Map();
const made = new Map(); // ip -> [times], so one visitor cannot fill the server
const subs = new Map(); // code -> Set of { ws, token }

const code = () => Array.from(crypto.randomBytes(5), (b) => LETTERS[b % LETTERS.length]).join('');
const token = () => crypto.randomBytes(16).toString('hex');
const seed = () => crypto.randomBytes(4).readUInt32BE(0);
const cleanTeam = (k, fallback) => (TEAM_KEYS.includes(k) ? k : fallback);
const cleanName = (s, fallback) => String(s || '').replace(/[^\p{L}\p{N} '._-]/gu, '').trim().slice(0, 16) || fallback;

function sweep(now = Date.now()) {
  for (const [k, r] of rooms) if (now - r.touched > IDLE_MS) { rooms.delete(k); subs.delete(k); }
  for (const [ip, times] of made) {
    const keep = times.filter((t) => now - t < 3600e3);
    if (keep.length) made.set(ip, keep); else made.delete(ip);
  }
}
setInterval(sweep, 10 * 60 * 1000).unref();

class GameError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function create({ name, team, ip = '' } = {}) {
  sweep();
  const times = made.get(ip) || [];
  if (times.length >= 30) throw new GameError(429, 'Too many games started from here. Try again in a little while.');
  if (rooms.size >= MAX_ROOMS) throw new GameError(503, 'Lots of games on at the moment. Try again in a few minutes.');
  let c = code();
  while (rooms.has(c)) c = code();
  const host = { name: cleanName(name, 'Player 1'), team: cleanTeam(team, 'pontardawe'), token: token() };
  const room = { code: c, seed: seed(), players: [host], kicks: [], rev: 1, touched: Date.now(), games: 1 };
  rooms.set(c, room);
  made.set(ip, [...times, Date.now()]);
  return { ...view(room, host.token), token: host.token };
}

function find(c) {
  const room = rooms.get(String(c || '').toUpperCase().trim());
  if (!room) throw new GameError(404, 'No game with that code. Check it, or start a new one.');
  return room;
}

function join(c, { name, team } = {}) {
  const room = find(c);
  if (room.players.length >= 2) throw new GameError(409, 'That game already has two players.');
  const guest = { name: cleanName(name, 'Player 2'), team: cleanTeam(team, 'penlan'), token: token() };
  room.players.push(guest);
  room.rev += 1;
  room.touched = Date.now();
  push(room);
  return { ...view(room, guest.token), token: guest.token };
}

function who(room, t) {
  const i = room.players.findIndex((p) => p.token === t);
  if (i < 0) throw new GameError(403, 'You are not in this game.');
  return i + 1;
}

/** What a player sees: never anybody's token. */
function view(room, t) {
  return {
    code: room.code,
    seed: room.seed,
    games: room.games,
    you: t ? who(room, t) : 0,
    players: room.players.map((p) => p.name),
    teams: room.players.map((p) => p.team),
    kicks: room.kicks,
    rev: room.rev,
  };
}

function state(c, t) {
  const room = find(c);
  room.touched = Date.now();
  return view(room, t);
}

/** One kick: player 1 kicks first in every round, then player 2. */
const VERDICTS = ['over', 'left', 'right', 'under', 'short', 'post'];
const HOWS = ['', 'in-off-post', 'off-bar-over'];
function kick(c, t, { round, aim, power, verdict, how } = {}) {
  const room = find(c);
  const me = who(room, t);
  if (room.players.length < 2) throw new GameError(409, 'Waiting for your friend to join.');
  const n = room.kicks.length;
  if (n >= MAX_KICKS) throw new GameError(409, 'That game is over.');
  const turn = (n % 2) + 1;
  if (me !== turn) throw new GameError(409, 'It is not your kick.');
  if (Number(round) !== Math.floor(n / 2)) throw new GameError(409, 'That kick is out of turn.');
  const a = Number(aim);
  const p = Number(power);
  if (!Number.isFinite(a) || !Number.isFinite(p) || Math.abs(a) > 1 || p < 0 || p > 1) {
    throw new GameError(400, 'That kick does not add up.');
  }
  if (!VERDICTS.includes(verdict) || !HOWS.includes(how || '')) throw new GameError(400, 'That kick does not add up.');
  // The kicker's phone decides whether it went over (see public/js/game-rules.js).
  room.kicks.push({ player: me, round: Number(round), aim: Math.round(a * 1e4) / 1e4, power: Math.round(p * 1e4) / 1e4, verdict, how: how || '' });
  room.rev += 1;
  room.touched = Date.now();
  push(room);
  return view(room, t);
}

/** Play again: a new seed (new spots and wind), the same two players. */
function rematch(c, t) {
  const room = find(c);
  who(room, t);
  room.seed = seed();
  room.kicks = [];
  room.games += 1;
  room.rev += 1;
  room.touched = Date.now();
  push(room);
  return view(room, t);
}

/** Send each player in the room their own view of it, now. */
function push(room) {
  const set = subs.get(room.code);
  if (!set) return;
  for (const s of set) {
    if (s.ws.readyState !== 1) continue;
    try { s.ws.send(JSON.stringify({ type: 'state', state: view(room, s.token) })); } catch { /* gone */ }
  }
}

/**
 * The socket: /api/play/ws?code=ABCDE&t=<token>. Messages in are
 * {type:'kick', round, aim, power} and {type:'rematch'}; out, {type:'state'}
 * after every change and {type:'error', error} for a refused move.
 */
function attach(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 2048 });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/api/play/ws') return;
    let room;
    let me;
    const t = url.searchParams.get('t') || '';
    try {
      room = find(url.searchParams.get('code'));
      me = who(room, t);
    } catch {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const entry = { ws, token: t, player: me };
      if (!subs.has(room.code)) subs.set(room.code, new Set());
      subs.get(room.code).add(entry);
      ws.isAlive = true;
      ws.on('pong', () => { ws.isAlive = true; });
      ws.on('message', (data) => {
        let msg;
        try { msg = JSON.parse(String(data)); } catch { return; }
        try {
          if (msg.type === 'kick') kick(room.code, t, msg);
          else if (msg.type === 'rematch') rematch(room.code, t);
          else if (msg.type === 'hello') ws.send(JSON.stringify({ type: 'state', state: state(room.code, t) }));
        } catch (e) {
          ws.send(JSON.stringify({ type: 'error', error: e.status ? e.message : 'Something went wrong.' }));
        }
      });
      ws.on('close', () => {
        const set = subs.get(room.code);
        if (set) { set.delete(entry); if (!set.size) subs.delete(room.code); }
      });
      ws.send(JSON.stringify({ type: 'state', state: view(room, t) }));
    });
  });
  // The proxy drops a connection idle for 300s: a ping every 25s keeps it.
  const beat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* closing */ }
    }
  }, 25000);
  beat.unref();
  server.on('close', () => clearInterval(beat));
  return wss;
}

/** The routes, under /api/play. */
function gameRoutes(express) {
  const r = express.Router();
  const json = express.json({ limit: '4kb' });
  const send = (fn) => (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      res.json(fn(req));
    } catch (e) {
      res.status(e.status || 500).json({ error: e.status ? e.message : 'Something went wrong.' });
    }
  };
  r.post('/rooms', json, send((req) => create({ name: (req.body || {}).name, team: (req.body || {}).team, ip: req.ip })));
  r.post('/rooms/:code/join', json, send((req) => join(req.params.code, req.body || {})));
  r.get('/rooms/:code', send((req) => state(req.params.code, String(req.query.t || ''))));
  r.post('/rooms/:code/kick', json, send((req) => kick(req.params.code, (req.body || {}).token, req.body || {})));
  r.post('/rooms/:code/rematch', json, send((req) => rematch(req.params.code, (req.body || {}).token)));
  return r;
}

module.exports = { gameRoutes, attach, create, join, state, kick, rematch, sweep, GameError, rooms };
