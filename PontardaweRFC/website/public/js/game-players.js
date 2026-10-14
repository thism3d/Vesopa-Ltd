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

// Sizes in metres: an adult forward-back build.
var PELVIS = 0.98, WAIST = 0.24, CHEST = 0.32, NECK = 0.1, THIGH = 0.45, SHIN = 0.45, FOOT = 0.2,
  UPPER = 0.3, FORE = 0.27, HAND = 0.08, HEAD = 0.115, HIPW = 0.11, SHW = 0.21;

function add(a, b, k) { return [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k]; }
function rot(v, axis, ang) { // rotate v about a unit axis (Rodrigues)
  var c = Math.cos(ang), s = Math.sin(ang);
  var d = v[0] * axis[0] + v[1] * axis[1] + v[2] * axis[2];
  var cx = axis[1] * v[2] - axis[2] * v[1], cy = axis[2] * v[0] - axis[0] * v[2], cz = axis[0] * v[1] - axis[1] * v[0];
  return [v[0] * c + cx * s + axis[0] * d * (1 - c), v[1] * c + cy * s + axis[1] * d * (1 - c), v[2] * c + cz * s + axis[2] * d * (1 - c)];
}

/**
 * A pose: where the player stands and faces (dir), and the angles that
 * bend him. A limb at 0 hangs straight down; positive swings it forward.
 * Knees and elbows bend by their own angle; twist turns the shoulders
 * against the hips; ankles point the feet.
 *
 * The skeleton: pelvis, waist, chest and neck up the spine; a head; each
 * arm shoulder, elbow, wrist, hand; each leg hip, knee, ankle, toe.
 */
function skeleton(p) {
  var up = [0, 1, 0];
  var f = [Math.sin(p.dir), 0, Math.cos(p.dir)];           // hips facing
  var l = [Math.cos(p.dir), 0, -Math.sin(p.dir)];          // to his right
  var tw = p.twist || 0;
  var fs = rot(f, up, tw), ls = rot(l, up, tw);            // shoulders facing
  var base = [p.x, (p.lift || 0), p.z];
  var pelvis = add(base, up, PELVIS - (p.crouch || 0));
  var lean = p.lean || 0;
  var spineDir = [Math.sin(lean) * f[0], Math.cos(lean), Math.sin(lean) * f[2]];
  var waist = add(pelvis, spineDir, WAIST);
  var chestDir = [Math.sin(lean * 1.2) * fs[0], Math.cos(lean * 1.2), Math.sin(lean * 1.2) * fs[2]];
  var chest = add(waist, chestDir, CHEST);
  var neck = add(chest, up, NECK);
  var head = add(add(neck, up, 0.13), fs, Math.sin(lean) * 0.05 + 0.02);
  var limb = function (from, fw, a, bend, len1, len2) {
    var mid = add(add(from, fw, Math.sin(a) * len1), up, -Math.cos(a) * len1);
    var b2 = a - bend;
    var end = add(add(mid, fw, Math.sin(b2) * len2), up, -Math.cos(b2) * len2);
    return [from, mid, end, b2];
  };
  var hipL = add(pelvis, l, -HIPW), hipR = add(pelvis, l, HIPW);
  var shL = add(chest, ls, -SHW), shR = add(chest, ls, SHW);
  var leg = function (hip, a, bend, ankle) {
    var bones = limb(hip, f, a, bend, THIGH, SHIN);
    // The foot: from the ankle, forward, pointed by the ankle angle.
    var fa = bones[3] + Math.PI / 2 - (ankle || 0);
    var toe = add(add(bones[2], f, Math.sin(fa) * FOOT), up, -Math.cos(fa) * FOOT * 0.35);
    return [bones[0], bones[1], bones[2], toe];
  };
  var arm = function (sh, side, a, bend, spread) {
    var out = add(sh, ls, side * (spread || 0) * 0.22);
    var bones = limb(out, fs, a, -bend, UPPER, FORE);
    bones[1] = add(bones[1], ls, side * (spread || 0) * 0.16);
    bones[2] = add(bones[2], ls, side * (spread || 0) * 0.3);
    var hand = add(bones[2], [bones[2][0] - bones[1][0], bones[2][1] - bones[1][1], bones[2][2] - bones[1][2]], HAND / FORE);
    return [sh, bones[1], bones[2], hand];
  };
  return {
    f: f, l: l, fs: fs, ls: ls, pelvis: pelvis, waist: waist, chest: chest, neck: neck, head: head,
    hipL: hipL, hipR: hipR, shL: shL, shR: shR,
    legL: leg(hipL, p.legL || 0, p.kneeL || 0, p.ankleL), legR: leg(hipR, p.legR || 0, p.kneeR || 0, p.ankleR),
    armL: arm(shL, -1, p.armL || 0, p.elbowL || 0, p.spreadL), armR: arm(shR, 1, p.armR || 0, p.elbowR || 0, p.spreadR),
  };
}

function shade(hex, k) { // k > 0 lighter, < 0 darker
  var n = parseInt(hex.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  var m = k > 0 ? 255 : 0, t = Math.abs(k);
  return 'rgb(' + Math.round(r + (m - r) * t) + ',' + Math.round(g + (m - g) * t) + ',' + Math.round(b + (m - b) * t) + ')';
}

/** Draw one player. P projects a world point to [screenX, screenY, pixelsPerMetre]. */
function draw(ctx, P, p, kitName) {
  var kit = typeof kitName === 'object' && kitName ? Object.assign({ skin: '#e2b48c', hair: '#3a2416' }, kitName) : (KITS[kitName] || KITS.home);
  if (p.skin) kit = Object.assign({}, kit, { skin: p.skin, hair: p.hair || kit.hair });
  var s = skeleton(p);
  var pr = function (q) { return P(q[0], q[1], q[2]); };
  // A limb as a tapered, shaded capsule between two joints.
  var capsule = function (a, b, r1, r2, col) {
    var A = pr(a), B = pr(b);
    var ra = Math.max(0.8, A[2] * r1), rb = Math.max(0.8, B[2] * r2);
    var dx = B[0] - A[0], dy = B[1] - A[1], len = Math.sqrt(dx * dx + dy * dy) || 1;
    var nx = -dy / len, ny = dx / len;
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.moveTo(A[0] + nx * ra, A[1] + ny * ra); ctx.lineTo(B[0] + nx * rb, B[1] + ny * rb);
    ctx.arc(B[0], B[1], rb, Math.atan2(ny, nx), Math.atan2(-ny, -nx));
    ctx.lineTo(A[0] - nx * ra, A[1] - ny * ra);
    ctx.arc(A[0], A[1], ra, Math.atan2(-ny, -nx), Math.atan2(ny, nx));
    ctx.fill();
    // The light from the floodlights, up and to the left: a highlight along one side.
    var side = nx < 0 ? 1 : -1;
    ctx.strokeStyle = 'rgba(255,255,255,.18)'; ctx.lineWidth = Math.max(0.6, (ra + rb) * 0.22); ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(A[0] + side * nx * ra * 0.45, A[1] + side * ny * ra * 0.45); ctx.lineTo(B[0] + side * nx * rb * 0.45, B[1] + side * ny * rb * 0.45); ctx.stroke();
  };
  var ball = function (q, r, col) { var Q = pr(q); ctx.fillStyle = col; ctx.beginPath(); ctx.arc(Q[0], Q[1], Math.max(0.8, Q[2] * r), 0, 6.3); ctx.fill(); };
  var leg = function (lg) {
    var hip = lg[0], knee = lg[1], ankle = lg[2], toe = lg[3];
    var sockTop = add(knee, [ankle[0] - knee[0], ankle[1] - knee[1], ankle[2] - knee[2]], 0.3);
    var shortsEnd = add(hip, [knee[0] - hip[0], knee[1] - hip[1], knee[2] - hip[2]], 0.62);
    capsule(hip, knee, 0.085, 0.06, kit.skin);              // thigh
    capsule(hip, shortsEnd, 0.1, 0.085, kit.shorts);        // shorts
    capsule(knee, sockTop, 0.058, 0.052, kit.skin);         // knee and shin
    capsule(sockTop, ankle, 0.054, 0.04, kit.socks);        // sock
    capsule(ankle, toe, 0.045, 0.035, '#0b0b0b');           // boot
  };
  var arm = function (ar) {
    var sh = ar[0], el = ar[1], wr = ar[2], hand = ar[3];
    var sleeve = add(sh, [el[0] - sh[0], el[1] - sh[1], el[2] - sh[2]], 0.55);
    capsule(sh, el, 0.055, 0.045, kit.skin);
    capsule(sh, sleeve, 0.068, 0.058, kit.shirt);           // short sleeve
    capsule(el, wr, 0.043, 0.035, kit.skin);
    ball(hand, 0.045, kit.skin);
  };
  // What is nearer the camera is drawn last.
  var camSide = P.camX !== undefined ? (P.camX - s.pelvis[0]) * s.l[0] + (P.camZ - s.pelvis[2]) * s.l[2] : 0;
  var facing = P.camX !== undefined ? (P.camX - s.pelvis[0]) * s.fs[0] + (P.camZ - s.pelvis[2]) * s.fs[2] : 0; // > 0: his front to us
  var farLeg = camSide > 0 ? s.legL : s.legR, nearLeg = camSide > 0 ? s.legR : s.legL;
  var farArm = camSide > 0 ? s.armL : s.armR, nearArm = camSide > 0 ? s.armR : s.armL;

  // Shadow on the grass
  var sh = P(s.pelvis[0], 0, s.pelvis[2]);
  ctx.fillStyle = 'rgba(0,0,0,.28)';
  ctx.beginPath(); ctx.ellipse(sh[0], sh[1], Math.max(3, sh[2] * 0.45), Math.max(1, sh[2] * 0.12), 0, 0, 6.3); ctx.fill();

  arm(farArm);
  leg(farLeg);
  // The torso: shorts at the hips, then the shirt from waist to chest,
  // its hoops wrapping round, and the number on his back.
  capsule(s.hipL, s.hipR, 0.11, 0.11, kit.shorts);
  capsule(s.pelvis, s.waist, 0.15, 0.16, kit.shirt);
  capsule(s.waist, s.chest, 0.16, 0.19, kit.shirt);
  capsule(s.shL, s.shR, 0.075, 0.075, kit.shirt);
  var Wt = pr(s.waist), Ch = pr(s.chest), Pv = pr(s.pelvis);
  var torsoW = Math.max(2, Ch[2] * 0.36);
  ctx.save();
  ctx.beginPath(); // clip to the torso so the hoops wrap
  ctx.moveTo(Pv[0] - torsoW * 0.42, Pv[1]); ctx.lineTo(Ch[0] - torsoW * 0.55, Ch[1]); ctx.lineTo(Ch[0] + torsoW * 0.55, Ch[1]); ctx.lineTo(Pv[0] + torsoW * 0.42, Pv[1]); ctx.closePath();
  ctx.clip();
  ctx.strokeStyle = kit.hoop; ctx.lineWidth = Math.max(1, Ch[2] * 0.042);
  for (var h = 0; h < 4; h++) {
    var t = 0.12 + h * 0.24;
    var hx = Pv[0] + (Ch[0] - Pv[0]) * t, hy = Pv[1] + (Ch[1] - Pv[1]) * t;
    ctx.beginPath(); ctx.ellipse(hx, hy, torsoW * 0.62, Math.max(1, torsoW * 0.12), Math.atan2(Ch[0] - Pv[0], Pv[1] - Ch[1]) * 0.3, 0, Math.PI); ctx.stroke();
  }
  ctx.restore();
  if (p.number && facing < 0) {
    ctx.fillStyle = '#fff'; ctx.strokeStyle = 'rgba(0,0,0,.45)'; ctx.lineWidth = Math.max(0.5, Ch[2] * 0.01);
    ctx.font = '700 ' + Math.max(6, Math.round(Ch[2] * 0.2)) + 'px Oswald, Impact, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.strokeText(String(p.number), (Wt[0] + Ch[0]) / 2, (Wt[1] + Ch[1]) / 2); ctx.fillText(String(p.number), (Wt[0] + Ch[0]) / 2, (Wt[1] + Ch[1]) / 2);
  }
  leg(nearLeg);
  // Collar, neck and head
  capsule(s.chest, s.neck, 0.06, 0.052, kit.skin);
  var collar = pr(s.chest);
  ctx.strokeStyle = shade(kit.shirt, -0.35); ctx.lineWidth = Math.max(1, collar[2] * 0.03);
  ctx.beginPath(); ctx.ellipse(collar[0], collar[1], Math.max(1, collar[2] * 0.07), Math.max(1, collar[2] * 0.03), 0, 0, 6.3); ctx.stroke();
  var hd = pr(s.head);
  var r = Math.max(2, hd[2] * HEAD);
  var g = ctx.createRadialGradient(hd[0] - r * 0.35, hd[1] - r * 0.35, r * 0.1, hd[0], hd[1], r);
  g.addColorStop(0, shade(kit.skin, 0.25)); g.addColorStop(1, shade(kit.skin, -0.18));
  ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(hd[0], hd[1], r * 0.9, r, 0, 0, 6.3); ctx.fill();
  // Hair: over the top, and all of the back of the head when he faces away.
  ctx.fillStyle = kit.hair;
  ctx.beginPath();
  if (facing < 0) ctx.ellipse(hd[0], hd[1] - r * 0.08, r * 0.92, r * 0.95, 0, Math.PI * 0.95, Math.PI * 2.05);
  else ctx.ellipse(hd[0], hd[1] - r * 0.28, r * 0.92, r * 0.75, 0, Math.PI * 1.02, Math.PI * 1.98);
  ctx.fill();
  if (facing >= 0 && r > 4) { // a face: eyes, when he is near enough to see them
    ctx.fillStyle = '#1b1210';
    var ex = s.ls[0] * 0.35 * r;
    ctx.beginPath(); ctx.arc(hd[0] - r * 0.32 + ex, hd[1] - r * 0.05, r * 0.08, 0, 6.3); ctx.arc(hd[0] + r * 0.32 + ex, hd[1] - r * 0.05, r * 0.08, 0, 6.3); ctx.fill();
  }
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
    return idle(start[0], start[1], dirToBall(start[0], start[1]) + 0.25, -t, { lean: 0.05, number: 10 });
  }
  if (t < RUN) {
    var u = t / RUN, e = ease(u);
    // A slight curve: the run comes round towards the line of the kick.
    var bow = Math.sin(u * Math.PI) * 0.6;
    var x = lerp(start[0], plant[0], e) - bow * Math.cos(ang);
    var z = lerp(start[1], plant[1], e) + bow * Math.sin(ang) * 0.4;
    var p = run(x, z, dirToBall(x, z), u * Math.PI * 2 * 3.2, 0.4 + 0.6 * u);
    p.number = 10;
    p.twist = Math.sin(u * Math.PI * 2 * 3.2) * 0.18;
    return p;
  }
  var dir = Math.atan2(aim * 0.4, 1);
  if (t < RUN + SWING) {
    var v = (t - RUN) / SWING;
    return {
      x: plant[0], z: plant[1], dir: dir, lean: -0.18 * v, number: 10, twist: lerp(-0.35, 0.4, ease(v)), ankleR: lerp(0, 0.9, v),
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
      x: plant[0] + 0.25 * w * Math.sin(dir), z: plant[1] + 0.5 * w, dir: dir, lean: lerp(-0.18, 0.05, w), lift: Math.sin(w * Math.PI) * 0.12, number: 10, twist: lerp(0.4, 0, w), ankleR: lerp(0.9, 0.2, w),
      legL: lerp(0.18, 0.05, w), kneeL: 0.2, legR: lerp(1.35, 0.1, ease(w)), kneeR: lerp(0.05, 0.3, w),
      armL: lerp(1.3, 0.2, w), elbowL: 0.3, spreadL: lerp(0.9, 0.2, w), armR: lerp(-0.9, -0.1, w), elbowR: 0.4, spreadR: 0.3,
    };
  }
  var px = plant[0] + 0.25 * Math.sin(dir), pz = plant[1] + 0.5;
  if (mood === 'over') {
    // Arms up, and a little jump.
    return idle(px, pz, dir, after, { number: 10, lift: Math.abs(Math.sin(after * 7)) * 0.18, armL: 2.9, armR: 2.9, elbowL: 0.2, elbowR: 0.2, spreadL: 0.5, spreadR: 0.5 });
  }
  // Hands on head.
  return idle(px, pz, dir, after, { number: 10, armL: 2.6, armR: 2.6, elbowL: 2.4, elbowR: 2.4, spreadL: 0.9, spreadR: 0.9, lean: -0.05 });
}

var LOOKS = [['#e2b48c', '#3a2416'], ['#c99272', '#1d130c'], ['#f0c8a4', '#a8722e'], ['#8d5a3b', '#120c08'], ['#e8bc96', '#5b3a1c'], ['#d9a87e', '#2b2b2b'], ['#f2ccb0', '#c9a04a']];

/** The opposition: on the try line, charging when the kicker sets off. */
function chargers(s, t, n, opts) {
  opts = opts || {};
  var out = [];
  for (var i = 0; i < n; i++) {
    var x0 = (i - (n - 1) / 2) * 2.4 + Math.sin(i * 7.3) * 0.5;
    var z0 = s.dist + 1.2 + (i % 2) * 0.6;
    var dir = Math.atan2(s.x - x0, -(z0 + 4)); // towards the kicker
    var look = { skin: LOOKS[i % LOOKS.length][0], hair: LOOKS[i % LOOKS.length][1] };
    if (t <= 0) { out.push(Object.assign(idle(x0, z0, dir, -t + i, { armL: 0.25, armR: -0.2 }), look)); continue; }
    // A penalty: the defence stands still, hands by their sides (Law 8).
    if (opts.still) { out.push(Object.assign(idle(x0, z0, dir, t + i, { armL: 0.05, armR: -0.05, spreadL: 0.05, spreadR: 0.05 }), look)); continue; }
    var speed = Math.min(1, t * 1.6) * (0.85 + (i % 3) * 0.08);
    // They get to the same line the rules block from, as the boot meets the ball.
    var far = opts.front != null ? Math.max(0, z0 - opts.front) * (0.85 + (i % 3) * 0.08) : 9.5;
    var dist = Math.min(1, t / CONTACT) * far;
    var z = z0 - dist;
    var x = x0 + (s.x - x0) * Math.min(1, dist / 12) * 0.6;
    // At the kick they leap, arms up, to block.
    if (t > CONTACT) out.push(Object.assign(idle(x, z, dir, t, { lift: Math.max(0, Math.sin(Math.min(1, (t - CONTACT) / 0.5) * Math.PI)) * 0.45, armL: 2.9, armR: 2.9, elbowL: 0.1, elbowR: 0.1, spreadL: 0.3, spreadR: 0.3 }), look));
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
  var hand = s.armR[3];
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
