/* Ponty Kicks: the players (pontardawerfc.com/play, 2026-10-15).
   Each player is a skeleton in the game's 3D world (hips, knees, ankles,
   shoulders, elbows, a head), posed from a few angles and drawn through the
   same camera as the pitch, so they stand on it, get smaller with distance
   and turn as they run. The kicker runs in round the corner, plants, swings
   and strikes; the opposition charge from the try line as he starts; the
   touch judges behind the posts put their flags up if it is over. */
(function (root) {
'use strict';

var KITS = {
  home: { shirt: '#c41414', hoop: '#ffffff', shorts: '#16080a', socks: '#c41414', skin: '#e2b48c', hair: '#3a2416' },
  away: { shirt: '#14316b', hoop: '#5fb3ff', shorts: '#0e1f45', socks: '#5fb3ff', skin: '#c99272', hair: '#1d130c' },
  official: { shirt: '#111111', hoop: '#f2c14e', shorts: '#111111', socks: '#111111', skin: '#d9a87e', hair: '#5b5b5b' },
};

// Sizes in metres.
var PELVIS = 0.98, TORSO = 0.56, THIGH = 0.46, SHIN = 0.46, UPPER = 0.31, FORE = 0.29, HEAD = 0.115;

function add(a, b, k) { return [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k]; }

/**
 * A pose: where the player stands and faces, and the angles that bend him.
 * Angles in radians; a limb at 0 hangs straight down, positive swings it
 * forward. Knees and elbows bend by their own angle.
 */
function skeleton(p) {
  var f = [Math.sin(p.dir), 0, Math.cos(p.dir)];      // forward
  var l = [Math.cos(p.dir), 0, -Math.sin(p.dir)];     // to his right
  var up = [0, 1, 0];
  var base = [p.x, (p.lift || 0), p.z];
  var pelvis = add(base, up, PELVIS - (p.crouch || 0));
  var lean = p.lean || 0;
  var neck = add(add(pelvis, up, Math.cos(lean) * TORSO), f, Math.sin(lean) * TORSO);
  var head = add(add(neck, up, 0.19), f, Math.sin(lean) * 0.08);
  var limb = function (from, a, bend, len1, len2) {
    var mid = add(add(from, f, Math.sin(a) * len1), up, -Math.cos(a) * len1);
    var b = a - bend;
    var end = add(add(mid, f, Math.sin(b) * len2), up, -Math.cos(b) * len2);
    return [from, mid, end];
  };
  var hipL = add(pelvis, l, -0.11), hipR = add(pelvis, l, 0.11);
  var shL = add(neck, l, -0.21), shR = add(neck, l, 0.21);
  var armOut = function (sh, side, a, bend, spread) {
    var s = add(sh, l, side * (spread || 0) * 0.25);
    var bones = limb(s, a, -bend, UPPER, FORE);
    bones[1] = add(bones[1], l, side * (spread || 0) * 0.18);
    bones[2] = add(bones[2], l, side * (spread || 0) * 0.32);
    return bones;
  };
  return {
    f: f, l: l, pelvis: pelvis, neck: neck, head: head, hipL: hipL, hipR: hipR, shL: shL, shR: shR,
    legL: limb(hipL, p.legL || 0, p.kneeL || 0, THIGH, SHIN),
    legR: limb(hipR, p.legR || 0, p.kneeR || 0, THIGH, SHIN),
    armL: armOut(shL, -1, p.armL || 0, p.elbowL || 0, p.spreadL),
    armR: armOut(shR, 1, p.armR || 0, p.elbowR || 0, p.spreadR),
  };
}

/** Draw one player. P projects a world point: [screenX, screenY, pixelsPerMetre]. */
function draw(ctx, P, p, kitName) {
  // A kit is a name (home, away, official) or a team's colours.
  var kit = typeof kitName === 'object' && kitName ? Object.assign({ skin: '#e2b48c', hair: '#3a2416' }, kitName) : (KITS[kitName] || KITS.home);
  if (p.skin) kit = Object.assign({}, kit, { skin: p.skin, hair: p.hair || kit.hair });
  var s = skeleton(p);
  var pr = function (q) { return P(q[0], q[1], q[2]); };
  var bone = function (a, b, w, col) {
    var A = pr(a), B = pr(b);
    ctx.strokeStyle = col; ctx.lineWidth = Math.max(1.2, A[2] * w); ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(A[0], A[1]); ctx.lineTo(B[0], B[1]); ctx.stroke();
  };
  var leg = function (lg) {
    var knee = lg[1], foot = lg[2];
    var sock = add(knee, [foot[0] - knee[0], foot[1] - knee[1], foot[2] - knee[2]], 0.35);
    bone(lg[0], knee, 0.17, kit.shorts);       // thigh, in shorts to the knee
    bone(knee, sock, 0.12, kit.skin);
    bone(sock, foot, 0.12, kit.socks);
    var toe = add(foot, s.f, 0.16);
    bone(foot, toe, 0.1, '#0b0b0b');           // boot
  };
  var arm = function (ar) {
    bone(ar[0], ar[1], 0.12, kit.shirt);
    bone(ar[1], ar[2], 0.095, kit.skin);
  };
  // Far side first: which of his sides is away from the camera.
  var camSide = P.camX !== undefined ? (P.camX - s.pelvis[0]) * s.l[0] + (P.camZ - s.pelvis[2]) * s.l[2] : 0;
  var farLeg = camSide > 0 ? s.legL : s.legR, nearLeg = camSide > 0 ? s.legR : s.legL;
  var farArm = camSide > 0 ? s.armL : s.armR, nearArm = camSide > 0 ? s.armR : s.armL;

  // Shadow
  var sh = P(s.pelvis[0], 0, s.pelvis[2]);
  ctx.fillStyle = 'rgba(0,0,0,.25)';
  ctx.beginPath(); ctx.ellipse(sh[0], sh[1], Math.max(3, sh[2] * 0.42), Math.max(1, sh[2] * 0.11), 0, 0, 6.3); ctx.fill();

  arm(farArm);
  leg(farLeg);
  // Shorts
  bone(s.hipL, s.hipR, 0.24, kit.shorts);
  // The shirt, with hoops: a quad from the shoulders to the hips.
  var a = pr(s.shL), b = pr(s.shR), c = pr(s.hipR), d = pr(s.hipL);
  ctx.fillStyle = kit.shirt;
  ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.lineTo(c[0], c[1]); ctx.lineTo(d[0], d[1]); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = kit.shirt; ctx.lineWidth = Math.max(1, a[2] * 0.09); ctx.lineJoin = 'round'; ctx.stroke();
  ctx.strokeStyle = kit.hoop;
  for (var h = 1; h <= 3; h++) {
    var t = h / 4.2;
    var L = [a[0] + (d[0] - a[0]) * t, a[1] + (d[1] - a[1]) * t], R = [b[0] + (c[0] - b[0]) * t, b[1] + (c[1] - b[1]) * t];
    ctx.lineWidth = Math.max(1, a[2] * 0.055);
    ctx.beginPath(); ctx.moveTo(L[0], L[1]); ctx.lineTo(R[0], R[1]); ctx.stroke();
  }
  leg(nearLeg);
  // Head and hair
  var hd = pr(s.head);
  var r = Math.max(2, hd[2] * HEAD);
  bone(s.neck, s.head, 0.08, kit.skin);
  ctx.fillStyle = kit.skin; ctx.beginPath(); ctx.arc(hd[0], hd[1], r, 0, 6.3); ctx.fill();
  ctx.fillStyle = kit.hair; ctx.beginPath(); ctx.arc(hd[0], hd[1] - r * 0.25, r * 0.95, Math.PI * 1.05, Math.PI * 1.95); ctx.fill();
  arm(nearArm);
  return s;
}

/* --- Poses --------------------------------------------------------------- */
function lerp(a, b, t) { return a + (b - a) * t; }
function ease(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }

/** Standing, breathing. */
function idle(x, z, dir, t, extra) {
  var b = Math.sin(t * 2.2) * 0.02;
  var p = { x: x, z: z, dir: dir, legL: 0.06, legR: -0.06, kneeL: 0.08, kneeR: 0.08, armL: 0.08 + b, armR: -0.04 - b, elbowL: 0.25, elbowR: 0.25, spreadL: 0.2, spreadR: 0.2, crouch: b * 0.4 };
  for (var k in extra) p[k] = extra[k];
  return p;
}

/** Running: a step cycle at the given phase (radians), speed 0..1. */
function run(x, z, dir, phase, speed) {
  var s = Math.sin(phase), c2 = Math.cos(phase);
  var amp = 0.35 + 0.45 * speed;
  return {
    x: x, z: z, dir: dir, lift: Math.abs(Math.sin(phase)) * 0.05 * speed, lean: 0.12 + 0.12 * speed,
    legL: s * amp, legR: -s * amp,
    kneeL: 0.25 + Math.max(0, -c2) * 1.1 * speed, kneeR: 0.25 + Math.max(0, c2) * 1.1 * speed,
    armL: -s * amp * 0.9, armR: s * amp * 0.9, elbowL: 1.3, elbowR: 1.3, spreadL: 0.1, spreadR: 0.1,
  };
}

/**
 * The kicker, from the moment the kick is made (t = 0) to the follow-through.
 * Returns the pose; contactAt is when the boot meets the ball (seconds).
 */
var RUN = 1.05, SWING = 0.3, CONTACT = RUN + SWING * 0.62;
function kicker(ball, aim, t, mood) {
  // Round the corner: from behind and to the left, curving in.
  var ang = 0.55 - aim * 0.25;                       // approach from the left of the line
  var start = [ball[0] - Math.sin(ang) * 4.2, ball[2] - Math.cos(ang) * 4.2];
  var plant = [ball[0] - 0.24, ball[2] - 0.22];
  var dirToBall = function (px, pz) { return Math.atan2(ball[0] - px, ball[2] - pz); };
  if (t <= 0) {
    return idle(start[0], start[1], dirToBall(start[0], start[1]) + 0.25, -t, { lean: 0.05 });
  }
  if (t < RUN) {
    var u = t / RUN, e = ease(u);
    // A slight curve: the run comes round towards the line of the kick.
    var bow = Math.sin(u * Math.PI) * 0.6;
    var x = lerp(start[0], plant[0], e) - bow * Math.cos(ang);
    var z = lerp(start[1], plant[1], e) + bow * Math.sin(ang) * 0.4;
    var p = run(x, z, dirToBall(x, z), u * Math.PI * 2 * 3.2, 0.4 + 0.6 * u);
    return p;
  }
  var dir = Math.atan2(aim * 0.4, 1);
  if (t < RUN + SWING) {
    var v = (t - RUN) / SWING;
    return {
      x: plant[0], z: plant[1], dir: dir, lean: -0.18 * v,
      legL: 0.18, kneeL: 0.25,                              // the planted foot
      legR: lerp(-1.25, 1.35, ease(v)), kneeR: lerp(1.5, 0.05, Math.min(1, v * 1.25)),
      armL: lerp(0.2, 1.3, v), elbowL: 0.3, spreadL: 0.9,   // arms out for balance
      armR: lerp(0.4, -0.9, v), elbowR: 0.5, spreadR: 0.6,
    };
  }
  var w = Math.min(1, (t - RUN - SWING) / 0.6);
  var after = t - RUN - SWING - 0.6;
  if (w < 1 || !mood) {
    return {
      x: plant[0] + 0.25 * w * Math.sin(dir), z: plant[1] + 0.5 * w, dir: dir, lean: lerp(-0.18, 0.05, w), lift: Math.sin(w * Math.PI) * 0.12,
      legL: lerp(0.18, 0.05, w), kneeL: 0.2, legR: lerp(1.35, 0.1, ease(w)), kneeR: lerp(0.05, 0.3, w),
      armL: lerp(1.3, 0.2, w), elbowL: 0.3, spreadL: lerp(0.9, 0.2, w), armR: lerp(-0.9, -0.1, w), elbowR: 0.4, spreadR: 0.3,
    };
  }
  var px = plant[0] + 0.25 * Math.sin(dir), pz = plant[1] + 0.5;
  if (mood === 'over') {
    // Arms up, and a little jump.
    return idle(px, pz, dir, after, { lift: Math.abs(Math.sin(after * 7)) * 0.18, armL: 2.9, armR: 2.9, elbowL: 0.2, elbowR: 0.2, spreadL: 0.5, spreadR: 0.5 });
  }
  // Hands on head.
  return idle(px, pz, dir, after, { armL: 2.6, armR: 2.6, elbowL: 2.4, elbowR: 2.4, spreadL: 0.9, spreadR: 0.9, lean: -0.05 });
}

var LOOKS = [['#e2b48c', '#3a2416'], ['#c99272', '#1d130c'], ['#f0c8a4', '#a8722e'], ['#8d5a3b', '#120c08'], ['#e8bc96', '#5b3a1c'], ['#d9a87e', '#2b2b2b'], ['#f2ccb0', '#c9a04a']];

/** The opposition: on the try line, charging when the kicker sets off. */
function chargers(s, t, n) {
  var out = [];
  for (var i = 0; i < n; i++) {
    var x0 = (i - (n - 1) / 2) * 2.4 + Math.sin(i * 7.3) * 0.5;
    var z0 = s.dist + 1.2 + (i % 2) * 0.6;
    var dir = Math.atan2(s.x - x0, -(z0 + 4)); // towards the kicker
    var look = { skin: LOOKS[i % LOOKS.length][0], hair: LOOKS[i % LOOKS.length][1] };
    if (t <= 0) { out.push(Object.assign(idle(x0, z0, dir, -t + i, { armL: 0.25, armR: -0.2 }), look)); continue; }
    var speed = Math.min(1, t * 1.6) * (0.85 + (i % 3) * 0.08);
    var dist = Math.min(t, 1.6) * 6.5 * speed - Math.max(0, t - 1.6) * 0; // up to about 10m
    var z = z0 - Math.min(dist, 9.5);
    var x = x0 + (s.x - x0) * Math.min(dist, 9.5) / 40;
    if (t > 1.6) out.push(Object.assign(idle(x, z, dir, t, { armL: 1.2 + Math.sin(t * 3 + i) * 0.2, armR: 1.1, spreadL: 0.6, spreadR: 0.6 }), look));
    else out.push(Object.assign(run(x, z, dir, t * 11 + i, speed), look));
  }
  return out;
}

/** The touch judges behind the posts, flags up if it is over. */
function judges(s, t, verdict) {
  var out = [];
  [-1, 1].forEach(function (side) {
    var x = side * 4.2, z = s.dist + 3;
    var dir = Math.PI; // facing the kicker
    var up = verdict === 'over' && t > 0;
    var p = idle(x, z, dir, t + side, up
      ? { armL: 3.0, armR: 3.0, elbowL: 0, elbowR: 0, spreadL: 0.15, spreadR: 0.15 }
      : verdict ? { armL: 0.9, armR: 0.9, spreadL: 1.6, spreadR: 1.6, elbowL: 0, elbowR: 0 } : { armL: 0.3, armR: 0.3 });
    p.flagUp = up; p.flagDown = !!verdict && !up;
    out.push(p);
  });
  return out;
}

/** A flag in the near hand of a touch judge. */
function flag(ctx, P, p) {
  var s = skeleton(p);
  var hand = s.armR[2];
  var tip = p.flagUp ? add(hand, [0, 1, 0], 0.7) : add(hand, s.l, 0.7);
  var H = P(hand[0], hand[1], hand[2]), T = P(tip[0], tip[1], tip[2]);
  ctx.strokeStyle = '#ddd'; ctx.lineWidth = Math.max(1, H[2] * 0.03);
  ctx.beginPath(); ctx.moveTo(H[0], H[1]); ctx.lineTo(T[0], T[1]); ctx.stroke();
  ctx.fillStyle = '#f2c14e';
  var w = Math.max(5, T[2] * 0.4), h = Math.max(4, T[2] * 0.28);
  ctx.fillRect(T[0], T[1], p.flagUp ? w : w * 0.8, h);
}

var api = { draw: draw, kicker: kicker, chargers: chargers, judges: judges, flag: flag, idle: idle, run: run, KITS: KITS, RUN: RUN, SWING: SWING, CONTACT: CONTACT, skeleton: skeleton };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.PontyPlayers = api;
})(typeof window !== 'undefined' ? window : globalThis);
