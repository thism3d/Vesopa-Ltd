/* Ponty Kicks: the rules, with no screen (pontardawerfc.com/play).
   Where each round is kicked from, the wind, the flight of a kick and the
   computer's kick. Used by game.js in the browser and by the tests in Node.

   The physics (the owner, 2026-10-15: "add proper physics"):
     * gravity, and quadratic air drag on the ball's speed THROUGH THE AIR:
       the wind is moving air, so a crosswind carries the ball more the
       longer and slower it flies, and a long kick dies at the end;
     * the uprights and the crossbar are solid: the ball bounces off them,
       and one that goes in off the post, or off the bar and over, counts;
     * the ball lands, bounces and hops (a rugby ball never bounces true)
       and rolls out, and turns end over end at a rate that follows the kick.
   Fixed steps of 1/240s, so a kick flies the same every time. Online, the
   kicker's phone decides the verdict and sends it with the kick, so two
   phones never disagree over a ball that clipped a post.

   The laws (World Rugby Law 8, the owner 2026-10-15: "how rugby is played"):
     * a CONVERSION (2 points) is kicked from anywhere on a line through
       where the try was scored, parallel to the touchlines: the try sets
       the angle and the kicker picks how far back to go;
     * the defenders wait on their goal line and may charge, and jump to
       block, from the moment the kicker starts his approach, so a
       conversion taken too close can be charged down;
     * a PENALTY GOAL (3 points) is kicked from the mark; the defenders
       stand still and may not charge;
     * a goal is over the bar and between the posts (a kick higher than
       the posts counts if it would have gone between them); 90 seconds for
       a conversion, 60 for a penalty, or the kick is disallowed. */
(function (root) {
'use strict';

var G = 9.81;
var RHO = 1.225;          // air, kg/m3
var MASS = 0.44;          // a size 5 rugby ball, kg
var AREA = 0.028;         // its face to the air, end over end, m2
var CD = 0.22;            // drag coefficient, tumbling
var K = 0.5 * RHO * CD * AREA / MASS; // drag per metre: a = -K |v| v
var BALL = 0.14;          // ball radius for hitting the posts, m
var HALF = 2.8;           // half the gap between the uprights, m
var POST_R = 0.075;       // upright and crossbar radius, m
var BAR = 3.0;            // crossbar height, m
var POST_H = 13;          // drawn height of the uprights, m
var ROUNDS = 5;
var MAX_ROUNDS = 20;
var ELEV = 0.6;           // launch angle, radians (about 34 degrees)
var VMIN = 15, VMAX = 34; // kick speed range, m/s
var AIM_MAX = 0.3;        // aim either side of the line to the posts, radians
var DT = 1 / 240;
var FRAME = 4;            // path points at 60 a second

function rng(seed) {
  var a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

var TOUCH = 35;            // the touchlines, either side of the posts, m
var CHARGE = 7.4;          // how far a charger gets from the goal line by the kick, m
var REACH = 2.75;          // how high a jumping charger can block, m
var CLOCK = { conversion: 90, penalty: 60 };
var POINTS = { conversion: 2, penalty: 3 };
// Five kicks each: conversions and penalties, as a match would bring them.
var KINDS = ['conversion', 'conversion', 'penalty', 'conversion', 'penalty'];

/** The best distance back for a try this far across: where the posts look widest, outside the charge. */
function suggest(x) {
  return Math.round(clamp(Math.abs(x) * 0.85 + 9, 12, 38));
}

/**
 * Round n, the same for both players: what kind of kick, where (x across
 * the pitch, dist from the goal line) and the wind. A conversion's x is
 * where the try was scored; its dist is the kicker's to choose (here the
 * suggestion), between min and max.
 */
function spot(seed, n) {
  var r = rng((seed ^ Math.imul(n + 1, 2654435761)) >>> 0);
  var kind = n < ROUNDS ? KINDS[n] : (n % 2 ? 'penalty' : 'conversion');
  var hard = Math.min(1, n / 6);
  var wind = Math.round((r() * 2 - 1) * Math.min(8, 1.5 + n * 1.3) * 10) / 10;
  var hop = r() * 2 - 1;
  if (kind === 'conversion') {
    // Tries are scored all across the line: under the posts, or out wide.
    var u = r();
    var x = (u < 0.25 ? r() * 4 : u < 0.6 ? 4 + r() * 12 : 16 + r() * (TOUCH - 21 + 6 * hard)) * (r() < 0.5 ? -1 : 1);
    x = Math.round(clamp(x, -(TOUCH - 3), TOUCH - 3) * 10) / 10;
    return { kind: kind, x: x, dist: suggest(x), min: 5, max: 45, tryX: x, wind: wind, hop: hop, clock: CLOCK.conversion, points: POINTS.conversion };
  }
  var pd = Math.round(22 + r() * (10 + 12 * hard));
  var px = Math.round((r() * 2 - 1) * (6 + 16 * hard) * 10) / 10;
  return { kind: kind, x: px, dist: pd, min: pd, max: pd, wind: wind, hop: hop, clock: CLOCK.penalty, points: POINTS.penalty };
}

/** The spot with the kicker's chosen distance (a conversion only moves back or forward on its line). */
function placed(s, dist) {
  var o = {};
  for (var k in s) o[k] = s[k];
  if (dist != null && s.kind === 'conversion') o.dist = Math.round(clamp(Number(dist), s.min, s.max));
  return o;
}

/** Where the front of the charge is when the ball is kicked: z, from the kicker's ball. */
function chargeLine(s) {
  if (s.kind !== 'conversion') return null;
  return s.dist - Math.min(CHARGE, Math.max(0, s.dist - 0.9));
}

/**
 * The flight of a kick. aim -1..1 (left..right), power 0..1.
 * Returns { path: [[x,y,z,spin]...] at 60/s, verdict, how, cross, events }.
 *   verdict: over | left | right | under | short | post
 *   how: 'in-off-post', 'off-bar-over', or null
 */
function fly(s, aim, power) {
  var v0 = VMIN + (VMAX - VMIN) * clamp(power, 0, 1);
  // Aim is from the line to the middle of the posts: 0 is straight at them.
  var az = Math.atan2(-s.x, s.dist) + clamp(aim, -1, 1) * AIM_MAX;
  var vx = v0 * Math.cos(ELEV) * Math.sin(az);
  var vy = v0 * Math.sin(ELEV);
  var vz = v0 * Math.cos(ELEV) * Math.cos(az);
  var x = s.x, y = 0.25, z = 0;
  var spin = 0, spinRate = 8 + 10 * power; // end over end, rad/s
  var path = [[x, y, z, 0]];
  var events = [];
  var verdict = null, how = null, cross = null;
  var landed = false, touched = null, bounces = 0, decided = 0;
  var charge = chargeLine(s), charged = false;

  for (var i = 1; i < 240 * 7; i++) {
    // Air drag on the speed relative to the moving air.
    var rx = vx - s.wind, ry = vy, rz = vz;
    var sp = Math.sqrt(rx * rx + ry * ry + rz * rz);
    vx -= K * sp * rx * DT;
    vy -= (G + K * sp * ry) * DT;
    vz -= K * sp * rz * DT;
    var px = x, py = y, pz = z;
    x += vx * DT; y += vy * DT; z += vz * DT;
    spin += spinRate * DT;

    // The charge: a conversion kicked low, near the defenders, is blocked.
    if (charge !== null && !charged && !verdict && pz < charge && z >= charge && y < REACH && Math.abs(x - s.x) < 3.2) {
      charged = true;
      vz = -Math.abs(vz) * 0.22; vy = 2.5; vx *= 0.3;
      verdict = 'charged'; decided = path.length;
      events.push({ t: i * DT, kind: 'charged' });
    }

    // The posts: two uprights and the crossbar, all solid.
    if (Math.abs(z - s.dist) < BALL + POST_R + 0.05) {
      for (var u = -1; u <= 1; u += 2) {
        var ux = u * HALF;
        var dx = x - ux, dz = z - s.dist;
        var dd = Math.sqrt(dx * dx + dz * dz);
        if (dd < BALL + POST_R && y > 0 && y < POST_H) {
          // Bounce off the round upright: reflect in the ground plane.
          var nx = dx / (dd || 1), nz = dz / (dd || 1);
          var dot = vx * nx + vz * nz;
          if (dot < 0) {
            vx -= 1.55 * dot * nx; vz -= 1.55 * dot * nz; // restitution 0.55
            vy *= 0.85;
            x = ux + nx * (BALL + POST_R); z = s.dist + nz * (BALL + POST_R);
            touched = touched || 'post';
            events.push({ t: i * DT, kind: 'post' });
          }
        }
      }
      if (Math.abs(x) < HALF) {
        var by = y - BAR, bz = z - s.dist;
        var bd = Math.sqrt(by * by + bz * bz);
        if (bd < BALL + POST_R) {
          var ny = by / (bd || 1), nz2 = bz / (bd || 1);
          var dot2 = vy * ny + vz * nz2;
          if (dot2 < 0) {
            vy -= 1.5 * dot2 * ny; vz -= 1.5 * dot2 * nz2;
            y = BAR + ny * (BALL + POST_R); z = s.dist + nz2 * (BALL + POST_R);
            touched = touched || 'bar';
            events.push({ t: i * DT, kind: 'bar' });
          }
        }
      }
    }

    // Through the plane of the posts, going forward, before landing.
    if (!verdict && !landed && pz < s.dist && z >= s.dist) {
      var f = (s.dist - pz) / ((z - pz) || 1);
      var cx = px + (x - px) * f, cy = py + (y - py) * f;
      cross = { x: cx, y: cy };
      if (Math.abs(cx) < HALF - BALL * 0.3 && cy > BAR) {
        verdict = 'over';
        how = touched === 'post' ? 'in-off-post' : touched === 'bar' ? 'off-bar-over' : null;
      } else if (Math.abs(cx) >= HALF) verdict = cx < 0 ? 'left' : 'right';
      else verdict = 'under';
      if (verdict !== 'over' && touched) verdict = 'post';
      decided = path.length;
    }

    // The ground: bounce, hop, roll.
    if (y <= 0 && vy < 0) {
      y = 0;
      if (!landed) {
        landed = true;
        events.push({ t: i * DT, kind: 'land' });
        if (!verdict) { verdict = touched ? 'post' : 'short'; decided = path.length; }
      }
      bounces++;
      // A rugby ball hops: the bounce is never quite straight.
      var hop = s.hop * (bounces % 2 ? 1 : -0.7);
      vy = -vy * (0.42 / bounces);
      vx = vx * 0.6 + hop * Math.abs(vz) * 0.25;
      vz *= 0.55;
      spinRate *= -0.6;
    }
    if (i % FRAME === 0) path.push([x, Math.max(0, y), z, spin]);
    var speed = Math.abs(vx) + Math.abs(vy) + Math.abs(vz);
    if (landed && (speed < 0.8 || bounces > 6)) break;
    if (z > s.dist + 30) break;
  }
  // Where the story is told: the animation can stop a little after this.
  return { path: path, verdict: verdict || 'short', how: how, cross: cross, events: events, decided: decided || path.length };
}

var SAY = {
  over: ['Over!', 'Right between the sticks!', 'Converted!', 'Straight over!'],
  'in-off-post': ['In off the post!'],
  'off-bar-over': ['Off the bar and over!'],
  charged: ['Charged down!', 'Blocked!'],
  time: ['Time! Kick disallowed', 'Out of time'],
  left: ['Wide left', 'Pulled it left'],
  right: ['Wide right', 'Pushed it right'],
  under: ['Under the bar', 'Not enough on it'],
  short: ['Short!', 'Fell short'],
  post: ['Off the post!', 'Clanged the upright!'],
};

/* The computer finds the safest kick, then makes a human-sized mistake. */
var SKILL = { easy: [0.36, 0.13], normal: [0.2, 0.07], hard: [0.11, 0.04] };
function computerKick(s0, level, r) {
  // A conversion: back to where the posts look widest, outside the charge.
  var s = placed(s0, s0.kind === 'conversion' ? suggest(s0.x) : null);
  var best = null;
  var tryKick = function (a, p) {
    if (a < -1 || a > 1 || p < 0 || p > 1) return;
    var f = fly(s, a, p);
    if (f.verdict !== 'over' || f.how) return;
    var margin = Math.min(HALF - Math.abs(f.cross.x), (f.cross.y - BAR) / 2);
    if (!best || margin > best.m) best = { a: a, p: p, m: margin };
  };
  // Coarse, then fine around the best: a goal-kicker's eye, not a search.
  for (var p = 0.2; p <= 1.0001; p += 0.08) for (var a = -1; a <= 1.0001; a += 0.05) tryKick(a, p);
  if (best) {
    var c = best;
    for (var dp = -0.06; dp <= 0.0601; dp += 0.02) for (var da = -0.04; da <= 0.0401; da += 0.01) tryKick(c.a + da, c.p + dp);
  }
  if (!best) best = { a: 0, p: 1 };
  var sk = SKILL[level] || SKILL.normal;
  var gauss = function () { return (r() + r() + r() - 1.5) * 1.15; };
  return { aim: clamp(best.a + gauss() * sk[0] * 2, -1, 1), power: clamp(best.p + gauss() * sk[1], 0, 1), dist: s.dist };
}

/* The teams: Pontardawe and the clubs on this season's posters, each in
   kit colours taken from its own crest (the owner, 2026-10-15). */
var TEAMS = {
  pontardawe: { name: 'Pontardawe', short: 'PON', shirt: '#c41414', hoop: '#ffffff', shorts: '#16080a', socks: '#c41414', crest: '/img/crest-128.webp' },
  penlan: { name: 'Penlan', short: 'PEN', shirt: '#1f4fbf', hoop: '#ffffff', shorts: '#0f2a6b', socks: '#f5d000' },
  banwen: { name: 'Banwen', short: 'BAN', shirt: '#1e7a32', hoop: '#f5d000', shorts: '#0f3d19', socks: '#1e7a32' },
  'briton-ferry': { name: 'Briton Ferry', short: 'BF', shirt: '#163a7a', hoop: '#f4c430', shorts: '#0d2350', socks: '#f4c430' },
  cwmgwrach: { name: 'Cwmgwrach', short: 'CWM', shirt: '#1e7a32', hoop: '#f5d000', shorts: '#111111', socks: '#111111' },
  nantymoel: { name: 'Nantymoel', short: 'NAN', shirt: '#1d7a3a', hoop: '#d91e2a', shorts: '#0e1a12', socks: '#d91e2a' },
  pantyffynnon: { name: 'Pantyffynnon', short: 'PAN', shirt: '#111111', hoop: '#f5d000', shorts: '#111111', socks: '#1e7a32' },
};
var TEAM_KEYS = Object.keys(TEAMS);
/** A team by key, or Pontardawe. */
function team(k) { return TEAMS[k] || TEAMS.pontardawe; }
/** When both sides pick the same colours, the second wears a change kit. */
function changeKit(t) { return { name: t.name, short: t.short, shirt: '#f4f1ec', hoop: t.shirt, shorts: t.shirt, socks: t.shirt, crest: t.crest }; }

var api = { spot: spot, fly: fly, computerKick: computerKick, rng: rng, clamp: clamp, SAY: SAY,
  HALF: HALF, BAR: BAR, POST_H: POST_H, ROUNDS: ROUNDS, MAX_ROUNDS: MAX_ROUNDS, SKILL: SKILL, K: K,
  TEAMS: TEAMS, TEAM_KEYS: TEAM_KEYS, team: team, changeKit: changeKit,
  placed: placed, suggest: suggest, chargeLine: chargeLine, CLOCK: CLOCK, POINTS: POINTS, KINDS: KINDS, TOUCH: TOUCH, CHARGE: CHARGE, REACH: REACH };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.PontyRules = api;
})(typeof window !== 'undefined' ? window : globalThis);
