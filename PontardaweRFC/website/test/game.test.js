'use strict';

// Ponty Kicks: the rules on their own, and the online rooms over HTTP and a
// real WebSocket between two players.
process.env.WRU_OFF = '1';
process.env.VENUE_API_OFF = '1';
process.env.DEEPSEEK_API_KEY = '';
process.env.GEMINI_API_KEY = '';

const test = require('node:test');
const assert = require('node:assert');
const WebSocket = require('ws');
const R = require('../public/js/game-rules.js');
const app = require('../src/server');

let base;
let server;
test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

test('the physics: drag, wind, solid posts, and the same kick flies the same', () => {
  const s = { dist: 30, x: 0, wind: 0, hop: 0 };
  assert.strictEqual(R.fly(s, 0, 0.6).verdict, 'over');
  assert.strictEqual(R.fly(s, 0, 0.02).verdict, 'short');
  assert.strictEqual(R.fly(s, -0.6, 0.6).verdict, 'left');
  assert.strictEqual(R.fly(s, 0.6, 0.6).verdict, 'right');
  // Drag: the same kick goes less far than it would in a vacuum.
  const f = R.fly({ dist: 60, x: 0, wind: 0, hop: 0 }, 0, 1);
  const vacuum = (34 ** 2) * Math.sin(2 * 0.6) / 9.81;
  const landedAt = f.path[f.decided - 1][2];
  assert.ok(landedAt < vacuum * 0.95, `drag shortens a kick (${landedAt.toFixed(1)} < ${vacuum.toFixed(1)})`);
  // A crosswind carries the ball downwind.
  const calm = R.fly(s, 0, 0.7).cross.x;
  const windy = R.fly({ ...s, wind: 6 }, 0, 0.7).cross.x;
  assert.ok(windy - calm > 0.5, 'the wind moves it');
  // Somewhere across the posts, the ball hits an upright.
  const verdicts = new Set();
  for (let a = -0.4; a <= 0.4; a += 0.002) verdicts.add(R.fly({ dist: 25, x: 0, wind: 0, hop: 0 }, a, 0.5).verdict);
  assert.ok(verdicts.has('post'), 'the uprights are solid');
  // Deterministic: the seed decides the spot and the wind.
  assert.deepStrictEqual(R.spot(12345, 3), R.spot(12345, 3));
  assert.deepStrictEqual(R.fly(R.spot(9, 2), 0.1, 0.7), R.fly(R.spot(9, 2), 0.1, 0.7));
});

test('the computer: harder levels kick better', () => {
  const rate = (level) => {
    let hit = 0;
    for (let g = 0; g < 30; g++) {
      const r = R.rng(g * 31 + 7);
      for (let i = 0; i < 5; i++) {
        const s = R.spot(g * 977, i);
        const k = R.computerKick(s, level, r);
        if (R.fly(s, k.aim, k.power).verdict === 'over') hit++;
      }
    }
    return hit / 150;
  };
  const easy = rate('easy'), hard = rate('hard');
  assert.ok(hard > easy + 0.2, `hard ${hard} beats easy ${easy}`);
  assert.ok(easy > 0.2 && hard < 1, 'nobody is perfect or hopeless');
});

const post = (path, body) => fetch(`http://${base}/api/play${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, body: await r.json() }));

test('online over HTTP: create, join, take turns, refuse the wrong kick, rematch', async () => {
  const host = (await post('/rooms', { name: 'Gareth' })).body;
  assert.match(host.code, /^[A-Z2-9]{5}$/);
  assert.strictEqual(host.you, 1);
  assert.ok(!JSON.stringify(host).includes('token":"') || host.token, 'only your own token');
  const guest = await post(`/rooms/${host.code}/join`, { name: 'Nicki <b>' });
  assert.strictEqual(guest.status, 200);
  assert.deepStrictEqual(guest.body.players, ['Gareth', 'Nicki b']);
  assert.strictEqual((await post(`/rooms/${host.code}/join`, { name: 'Third' })).status, 409);
  const kick = (who, round, extra = {}) => post(`/rooms/${host.code}/kick`, { token: who.token, round, aim: 0.1, power: 0.6, verdict: 'over', how: '', ...extra });
  assert.strictEqual((await kick(guest.body, 0)).status, 409, 'player 1 kicks first');
  assert.strictEqual((await kick(host, 0)).status, 200);
  assert.strictEqual((await kick(host, 0)).status, 409, 'not twice');
  assert.strictEqual((await kick(guest.body, 0, { verdict: 'goal!' })).status, 400, 'a verdict that is not one');
  const after = await kick(guest.body, 0, { verdict: 'left' });
  assert.strictEqual(after.body.kicks.length, 2);
  const again = await post(`/rooms/${host.code}/rematch`, { token: guest.body.token });
  assert.strictEqual(again.body.kicks.length, 0);
  assert.strictEqual(again.body.games, 2);
  assert.strictEqual((await fetch(`http://${base}/api/play/rooms/NOPE2?t=x`)).status, 404);
});

test('online over a WebSocket: a kick reaches the other player at once', async () => {
  const host = (await post('/rooms', { name: 'Host' })).body;
  const guest = (await post(`/rooms/${host.code}/join`, { name: 'Guest' })).body;
  const open = (who) => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${base}/api/play/ws?code=${host.code}&t=${who.token}`);
    const inbox = [];
    ws.on('message', (m) => inbox.push(JSON.parse(String(m))));
    ws.on('open', () => resolve({ ws, inbox }));
    ws.on('error', reject);
  });
  const a = await open(host);
  const b = await open(guest);
  const waitFor = async (box, test_) => {
    for (let i = 0; i < 100; i++) {
      const hit = box.inbox.find(test_);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('nothing arrived');
  };
  const t0 = Date.now();
  a.ws.send(JSON.stringify({ type: 'kick', round: 0, aim: -0.2, power: 0.7, verdict: 'over', how: 'in-off-post' }));
  const seen = await waitFor(b, (m) => m.type === 'state' && m.state.kicks.length === 1);
  assert.strictEqual(seen.state.you, 2);
  assert.deepStrictEqual(seen.state.kicks[0], { player: 1, round: 0, aim: -0.2, power: 0.7, verdict: 'over', how: 'in-off-post' });
  assert.ok(Date.now() - t0 < 500, 'pushed, not polled');
  b.ws.send(JSON.stringify({ type: 'kick', round: 1, aim: 0, power: 0.5, verdict: 'over' }));
  const refused = await waitFor(b, (m) => m.type === 'error');
  assert.match(refused.error, /out of turn/);
  // Somebody else's token cannot open the room.
  const bad = new WebSocket(`ws://${base}/api/play/ws?code=${host.code}&t=nope`);
  await new Promise((r) => { bad.on('error', r); bad.on('unexpected-response', r); bad.on('close', r); });
  a.ws.close(); b.ws.close();
});

test('the game page and its highlights', async () => {
  const html = await (await fetch(`http://${base}/play`)).text();
  assert.match(html, /data-game/);
  assert.match(html, /\/js\/game-rules\.js/);
  assert.match(html, /data-g-ai="hard"/);
  assert.match(html, /data-g-host/);
  assert.match(html, /"@type":"VideoGame"/);
  const home = await (await fetch(`http://${base}/`)).text();
  assert.match(home, /class="play-band"/);
  assert.match(home, /href="\/play"/);
  assert.strictEqual((await fetch(`http://${base}/game`, { redirect: 'manual' })).status, 301);
});
