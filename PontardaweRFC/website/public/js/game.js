/* Ponty Kicks: the conversion challenge (pontardawerfc.com/play, 2026-10-15).
   Swipe or drag up from the ball to kick between the posts at The Rec. Play
   the computer, a friend on the same device, or a friend online (a room
   code, over a WebSocket, falling back to polling). No libraries.

   Everything that decides a kick is deterministic: the spots and the wind
   come from a seed, a kick is only its aim and power, and the flight is the
   same sum on every phone. That is what lets an online game send just the
   kick and have both players see the same ball go over (or wide). */
(function () {
  'use strict';
  var d = document;
  var box = d.querySelector('[data-game]');
  if (!box) return;
  var cv = box.querySelector('canvas');
  var ctx = cv.getContext('2d');
  var ui = {
    menu: box.querySelector('[data-g-menu]'),
    over: box.querySelector('[data-g-over]'),
    hud: box.querySelector('[data-g-hud]'),
    banner: box.querySelector('[data-g-banner]'),
    toast: box.querySelector('[data-g-toast]'),
  };
  var reduced = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  var R = window.PontyRules;
  var spot = R.spot, fly = R.fly, computerKick = R.computerKick, rng = R.rng, clamp = R.clamp;
  var HALF = R.HALF, BAR = R.BAR, POST_H = R.POST_H, ROUNDS = R.ROUNDS, MAX_ROUNDS = R.MAX_ROUNDS;
  var SAY = R.SAY;
  var TEAMS = R.TEAMS;
  /** Each side's kit: a team's colours, or a change kit when both clash. */
  function kitOf(p) {
    if (!game || !game.teams) return R.team(p === 1 ? 'pontardawe' : 'penlan');
    var a = R.team(game.teams[0]), b = R.team(game.teams[1]);
    if (p === 1) return a;
    return a.shirt === b.shirt ? R.changeKit(b) : b;
  }
  function badge(p) {
    var t = kitOf(p);
    if (t.crest) return '<img class="g-badge" src="' + t.crest + '" alt="" width="28" height="28">';
    return '<span class="g-badge g-shield" style="--a:' + t.shirt + ';--b:' + t.hoop + '">' + esc(t.short) + '</span>';
  }
  var PL = window.PontyPlayers;
  var CONTACT = PL ? PL.CONTACT : 0;

  /* --- Sound (tiny, made on the fly; off with the speaker button) --------- */
  var audio = null;
  var muted = false;
  try { muted = localStorage.getItem('pk-mute') === '1'; } catch (e) { /* private */ }
  function tone(kind) {
    if (muted) return;
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      var now = audio.currentTime;
      if (kind === 'kick') {
        var o = audio.createOscillator(), g = audio.createGain();
        o.frequency.setValueAtTime(140, now); o.frequency.exponentialRampToValueAtTime(45, now + 0.18);
        g.gain.setValueAtTime(0.7, now); g.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
        o.connect(g).connect(audio.destination); o.start(now); o.stop(now + 0.25);
        return;
      }
      var len = kind === 'cheer' ? 1.6 : 0.9;
      var buf = audio.createBuffer(1, audio.sampleRate * len, audio.sampleRate);
      var ch = buf.getChannelData(0);
      for (var i = 0; i < ch.length; i++) ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / ch.length, kind === 'cheer' ? 0.8 : 2);
      var src = audio.createBufferSource(); src.buffer = buf;
      var f = audio.createBiquadFilter(); f.type = 'bandpass';
      f.frequency.value = kind === 'cheer' ? 1400 : 420; f.Q.value = 0.7;
      var gn = audio.createGain(); gn.gain.value = kind === 'cheer' ? 0.5 : 0.35;
      src.connect(f).connect(gn).connect(audio.destination); src.start(now);
      if (kind === 'post') {
        var o2 = audio.createOscillator(), g2 = audio.createGain();
        o2.type = 'triangle'; o2.frequency.value = 880;
        g2.gain.setValueAtTime(0.4, now); g2.gain.exponentialRampToValueAtTime(0.001, now + 0.8);
        o2.connect(g2).connect(audio.destination); o2.start(now); o2.stop(now + 0.85);
      }
    } catch (e) { /* no audio */ }
  }

  /* --- The game's state ---------------------------------------------------- */
  var game = null;  // { mode, level, seed, names, kicks:[{player,round,aim,power,verdict}], me }
  var phase = 'menu'; // menu | aim | wait | flight | result | over
  var current = null; // the spot being kicked from
  var flight = null;  // { f, t0, player }
  var drag = null;
  var keyAim = 0, keyPower = 0, keyCharging = false;
  var confetti = [];
  var net = null;
  var lastResult = '';

  function scoreOf(p) {
    return game.kicks.reduce(function (sum, k) {
      return sum + (k.player === p && k.verdict === 'over' ? spot(game.seed, k.round).points : 0);
    }, 0);
  }
  /** What the rounds still to come are worth. */
  function pointsLeft(fromRound) {
    var t = 0;
    for (var i = fromRound; i < ROUNDS; i++) t += spot(game.seed, i).points;
    return t;
  }
  function turn() { // whose kick, and in which round
    var n = game.kicks.length;
    return { player: (n % 2) + 1, round: Math.floor(n / 2) };
  }
  function finished() {
    var n = game.kicks.length;
    if (n % 2) return false;
    var rounds = n / 2;
    if (rounds < ROUNDS) {
      // Decided early: one side cannot catch up.
      var a = scoreOf(1), b = scoreOf(2), left = pointsLeft(rounds);
      return a > b + left || b > a + left;
    }
    return scoreOf(1) !== scoreOf(2) || rounds >= MAX_ROUNDS;
  }
  function humanTurn(p) {
    if (game.mode === 'ai') return p === 1;
    if (game.mode === 'local') return true;
    return p === game.me;
  }

  function start(cfg) {
    game = { mode: cfg.mode, level: cfg.level || 'normal', seed: cfg.seed >>> 0, names: cfg.names, teams: cfg.teams || ['pontardawe', 'penlan'], kicks: [], me: cfg.me || 1 };
    game.ai = rng(game.seed ^ 0x9e3779b9);
    ui.menu.hidden = true;
    ui.over.hidden = true;
    box.classList.add('playing');
    next();
  }

  function next() {
    if (finished()) return gameOver();
    var t = turn();
    current = R.placed(spot(game.seed, t.round));
    flight = null; drag = null; keyAim = 0; keyPower = 0;
    // The shot clock: 90 seconds for a conversion, 60 for a penalty (Law 8).
    clockEnd = performance.now() + current.clock * 1000 + (reduced ? 0 : 1500);
    placeUi();
    // Every new kick opens wide, from high behind the posts, and the camera
    // comes down behind the kicker (the owner: the camera should move).
    camIntro = { t0: performance.now(), dur: reduced ? 0 : 1500 };
    hud();
    if (humanTurn(t.player)) {
      phase = 'aim';
      say(current.kind === 'penalty' ? 'Penalty goal' : 'Conversion', current.kind === 'penalty' ? 'Kick from the mark · 3 points' : 'Pick your distance, then swipe up · 2 points');
    } else if (game.mode === 'ai') {
      phase = 'wait';
      say('Computer', 'Lining it up…');
      setTimeout(function () {
        var k = computerKick(current, game.level, game.ai);
        current = R.placed(current, k.dist);
        placeUi();
        kickNow(k.aim, k.power, 2);
      }, 1300);
    } else {
      phase = 'wait';
      say(game.names[t.player - 1] || 'Your friend', 'Lining it up…');
    }
  }

  function kickNow(aim, power, player, sent, late) {
    var t = turn();
    if (player !== t.player) return;
    if (sent && sent.dist != null) current = R.placed(spot(game.seed, t.round), sent.dist);
    var f = late ? { verdict: 'time', how: null, path: [[current.x, 0.32, 0, 0]], events: [], decided: 0 } : fly(current, aim, power);
    if (sent && sent.verdict === 'time') late = true;
    if (game.mode === 'online' && !sent) {
      if (!net) return;
      // The server is the one record of turns: the kick plays here when it
      // comes back, the same moment it reaches the friend's phone. This
      // phone's verdict goes with it, so both screens agree on a ball that
      // clipped a post.
      phase = 'wait';
      say('', 'Kicking…');
      net.send({ type: 'kick', round: t.round, aim: aim, power: power, dist: current.dist, verdict: f.verdict, how: f.how || '' });
      return;
    }
    if (sent && sent.verdict) { f.verdict = sent.verdict; f.how = sent.how || null; }
    game.kicks.push({ player: player, round: t.round, aim: aim, power: power, dist: current.dist, verdict: f.verdict, how: f.how });
    placeUi(true);
    if (late || f.verdict === 'time') { phase = 'flight'; flight = null; landed(); return; }
    // The kicker runs in first: the ball leaves the tee when his boot meets it.
    var startedAt = performance.now();
    flight = { f: f, ks: startedAt, t0: startedAt + CONTACT * 1000, player: player, aim: aim, heard: 0 };
    // The drawing loop finishes the flight; if the screen is not drawing
    // (a phone locked mid-kick, a tab in the background) a timer does, so an
    // online game never waits on a screen nobody is looking at.
    var mine = flight;
    var frames = Math.min(f.path.length - 1, f.decided + 75);
    setTimeout(function () {
      if (phase === 'flight' && flight === mine && !mine.done) { mine.done = true; landed(); }
    }, CONTACT * 1000 + frames / 60 / (reduced ? 3 : 1.1) * 1000 + 400);
    phase = 'flight';
    hideBanner();
    setTimeout(function () { tone('kick'); }, CONTACT * 1000);
  }

  function landed() {
    var k = game.kicks[game.kicks.length - 1];
    var lines = SAY[k.how || k.verdict] || SAY[k.verdict];
    if (flight) flight.mood = k.verdict === 'over' ? 'over' : 'miss';
    lastResult = lines[Math.floor(Math.random() * lines.length)];
    phase = 'result';
    if (k.verdict === 'over') { tone('cheer'); burst(); } else tone(k.verdict === 'post' ? 'post' : 'groan');
    hud();
    say(lastResult, k.verdict === 'over' ? '+' + spot(game.seed, k.round).points + ' points' : k.verdict === 'charged' ? 'Too close: the defence got to it' : '', k.verdict === 'over' ? 'good' : 'bad');
    setTimeout(next, 1700);
  }

  function gameOver() {
    phase = 'over';
    hideBanner();
    var a = scoreOf(1), b = scoreOf(2);
    var you = game.mode === 'online' ? game.me : 1;
    var title;
    if (a === b) title = "It's a draw!";
    else if (game.mode === 'local') title = (a > b ? game.names[0] : game.names[1]) + ' wins!';
    else title = ((a > b) === (you === 1)) ? 'You win!' : (game.mode === 'ai' ? 'The computer wins' : game.names[you === 1 ? 1 : 0] + ' wins');
    ui.over.querySelector('[data-g-title]').textContent = title;
    ui.over.querySelector('[data-g-final]').textContent = game.names[0] + ' ' + a + ' – ' + b + ' ' + game.names[1];
    if (game.mode === 'ai' && a > b) {
      try {
        var best = Number(localStorage.getItem('pk-best') || 0);
        if (a > best) localStorage.setItem('pk-best', String(a));
      } catch (e) { /* private */ }
    }
    ui.over.hidden = false;
    if (a !== b) burst();
    hud();
  }

  /* --- HUD ---------------------------------------------------------------- */
  function hud() {
    if (!game) return;
    var t = turn();
    var dots = function (p) {
      var html = '';
      var rounds = Math.max(ROUNDS, Math.ceil(game.kicks.length / 2) + (game.kicks.length % 2 ? 0 : 0));
      for (var i = 0; i < rounds; i++) {
        var k = game.kicks.filter(function (x) { return x.player === p && x.round === i; })[0];
        html += '<i class="' + (k ? (k.verdict === 'over' ? 'hit' : 'miss') : (i === t.round && t.player === p && phase !== 'over' ? 'now' : '')) + '"></i>';
      }
      return html;
    };
    ui.hud.innerHTML =
      '<div class="g-side' + (t.player === 1 && phase !== 'over' ? ' on' : '') + '">' + badge(1) + '<b>' + esc(game.names[0]) + '</b><span class="g-dots">' + dots(1) + '</span><strong>' + scoreOf(1) + '</strong></div>' +
      '<div class="g-mid"><span class="g-round">' + (t.round < ROUNDS ? 'Kick ' + (t.round + 1) + ' of ' + ROUNDS : 'Sudden death') + (current ? ' · ' + (current.kind === 'penalty' ? 'Penalty' : 'Conversion') : '') + '</span>' +
      (current ? '<span class="g-wind" style="--w:' + current.wind + '"><i></i>' + Math.abs(current.wind).toFixed(1) + ' m/s ' + (current.wind < 0 ? '←' : current.wind > 0 ? '→' : '') + '</span><span class="g-spot">' + current.dist + 'm out · ' + (current.kind === 'conversion' ? 'try ' : '') + (Math.abs(current.x) < 1 ? 'under the posts' : Math.abs(current.x).toFixed(0) + 'm ' + (current.x < 0 ? 'left' : 'right')) + '</span><span class="g-clock" data-g-clock></span>' : '') + '</div>' +
      '<div class="g-side right' + (t.player === 2 && phase !== 'over' ? ' on' : '') + '"><strong>' + scoreOf(2) + '</strong><span class="g-dots">' + dots(2) + '</span><b>' + esc(game.names[1]) + '</b>' + badge(2) + '</div>';
  }
  var clockEnd = 0;
  var placeBox = box.querySelector('[data-g-place]');
  /** Closer / Further back: only for a conversion, only on your own kick. */
  function placeUi(off) {
    if (!placeBox) return;
    var show = !off && game && current && current.kind === 'conversion' && phase !== 'over' && humanTurn(turn().player) && !flight;
    placeBox.hidden = !show;
    var lab = placeBox.querySelector('[data-g-dist]');
    if (lab && current) lab.textContent = current.dist + 'm';
  }
  function moveBall(by) {
    if (phase !== 'aim' || !current || current.kind !== 'conversion') return;
    current = R.placed(current, current.dist + by);
    placeUi();
    hud();
  }
  // The shot clock, ticking on screen; when it runs out the kick is disallowed.
  setInterval(function () {
    var el = box.querySelector('[data-g-clock]');
    if (!game || !current) return;
    var left = Math.max(0, Math.ceil((clockEnd - performance.now()) / 1000));
    if (el) {
      el.textContent = phase === 'aim' || phase === 'wait' ? '⏱ ' + left + 's' : '';
      el.classList.toggle('low', left <= 10);
    }
    if (phase === 'aim' && left <= 0 && humanTurn(turn().player)) {
      drag = null;
      if (game.mode === 'online') { phase = 'wait'; net.send({ type: 'kick', round: turn().round, aim: 0, power: 0, dist: current.dist, verdict: 'time', how: '' }); }
      else kickNow(0, 0, turn().player, null, true);
    }
  }, 250);

  function say(title, sub, tone_) {
    ui.banner.innerHTML = (title ? '<b>' + esc(title) + '</b>' : '') + (sub ? '<span>' + esc(sub) + '</span>' : '');
    ui.banner.className = 'g-banner show' + (tone_ ? ' ' + tone_ : '');
    // "Your kick" steps out of the way of the posts after a moment.
    clearTimeout(say.t);
    if (phase === 'aim') say.t = setTimeout(hideBanner, 1600);
  }
  function hideBanner() { ui.banner.className = 'g-banner'; }
  function toast(msg) {
    ui.toast.textContent = msg;
    ui.toast.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(function () { ui.toast.hidden = true; }, 3500);
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  /* --- Drawing ------------------------------------------------------------ */
  var W = 0, H = 0, DPR = 1;
  function resize() {
    var r = cv.getBoundingClientRect();
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = r.width; H = r.height;
    cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }
  window.addEventListener('resize', resize);
  resize();

  /* The camera: a position and a point it looks at, eased every frame.
     Behind the kicker while he lines up; a wide establishing shot that comes
     down to him at each new kick; and in flight it follows the ball up and
     towards the posts, like the television does. */
  var camIntro = null;
  var camS = null, camLast = 0;
  function camTarget(now, ball) {
    var s = current || { x: 0, dist: 30 };
    // Behind the ball, on the line from the posts through it, as television
    // frames a goal kick; a little to the left, to see the kicker come in.
    var ux = s.x, uz = -s.dist, un = Math.sqrt(ux * ux + uz * uz) || 1;
    ux /= un; uz /= un;
    var back = 10.5;
    var base = { x: s.x + ux * back - uz * 1.4, y: 2.4, z: uz * back + ux * 1.4, lx: s.x * 0.25, ly: 2.4, lz: s.dist * 0.85 };
    if (flight && ball && now > flight.t0 && ball[2] > 1) {
      var k = Math.min(1, (now - flight.t0) / 700);
      return {
        x: base.x + (ball[0] * 0.6 - base.x) * 0.5 * k,
        y: base.y + Math.max(0, ball[1] * 0.45) * k,
        z: base.z + (Math.min(ball[2], s.dist + 4) - 13 - base.z) * 0.55 * k,
        lx: base.lx + (ball[0] - base.lx) * 0.7 * k,
        ly: base.ly + (Math.max(2, ball[1]) - base.ly) * 0.8 * k,
        lz: Math.max(s.dist, ball[2] + 6),
      };
    }
    return base;
  }
  function cam(now, ball) {
    var t = camTarget(now, ball);
    var s = current || { x: 0, dist: 30 };
    if (camIntro && now - camIntro.t0 < camIntro.dur) {
      // From high behind the posts, looking at the ball, down to behind him.
      var u = (now - camIntro.t0) / camIntro.dur, e = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
      var from = { x: s.x * 0.2 + 6, y: 15, z: s.dist + 16, lx: s.x, ly: 0.5, lz: 0 };
      t = { x: from.x + (t.x - from.x) * e, y: from.y + (t.y - from.y) * e, z: from.z + (t.z - from.z) * e,
        lx: from.lx + (t.lx - from.lx) * e, ly: from.ly + (t.ly - from.ly) * e, lz: from.lz + (t.lz - from.lz) * e };
      camS = t;
    } else {
      var dt = Math.min(0.1, (now - (camLast || now)) / 1000);
      if (!camS) camS = t;
      var a = 1 - Math.exp(-dt * 5);
      for (var key in t) camS[key] += (t[key] - camS[key]) * a;
    }
    camLast = now;
    var fx = camS.lx - camS.x, fy = camS.ly - camS.y, fz = camS.lz - camS.z;
    var n = Math.sqrt(fx * fx + fz * fz) || 1;
    var c = { x: camS.x, y: camS.y, z: camS.z, yaw: Math.atan2(fx, fz), pitch: Math.atan2(fy, n), f: Math.min(W * 0.9, H * 1.3) };
    c.cy = Math.cos(c.yaw); c.sy = Math.sin(c.yaw); c.cp = Math.cos(c.pitch); c.sp = Math.sin(c.pitch);
    c.hz = H * 0.5 + c.f * Math.tan(c.pitch);
    return c;
  }
  function P(c, x, y, z) {
    var dx = x - c.x, dy = y - c.y, dz = z - c.z;
    var rx = dx * c.cy - dz * c.sy, rz = dx * c.sy + dz * c.cy;
    var ry = dy * c.cp - rz * c.sp, rz2 = Math.max(0.6, dy * c.sp + rz * c.cp);
    return [W / 2 + c.f * rx / rz2, H * 0.5 - c.f * ry / rz2, c.f / rz2];
  }

  var stars = [];
  for (var si = 0; si < 70; si++) stars.push([Math.random(), Math.random() * 0.35, Math.random()]);

  function ballNow(now) {
    var s = current || { x: 0, dist: 30, wind: 0 };
    if (!flight) return { pos: [s.x, 0.32, 0], idx: -1 };
    var el = (now - flight.t0) / 1000 * (reduced ? 3 : 1.1);
    var last = Math.min(flight.f.path.length - 1, flight.f.decided + 75);
    var idx = el < 0 ? -1 : Math.min(last, Math.floor(el * 60));
    return { pos: idx < 0 ? [s.x, 0.32, 0] : flight.f.path[idx], idx: idx, last: last };
  }

  function draw(now) {
    var bn = ballNow(now);
    var c = cam(now, bn.pos);
    var s = current || { x: 0, dist: 30, wind: 0 };
    var Pw = function (x, y, z) { return P(c, x, y, z); };
    Pw.camX = c.x; Pw.camZ = c.z;
    var kicking = flight ? flight.player : (game ? turn().player : 1);
    var kickT = flight ? (now - flight.ks) / 1000 : -1 - now / 1000;
    // Night sky over the valley
    var sky = ctx.createLinearGradient(0, 0, 0, c.hz);
    sky.addColorStop(0, '#05010a'); sky.addColorStop(0.6, '#1d0710'); sky.addColorStop(1, '#3d0c12');
    ctx.fillStyle = sky; ctx.fillRect(0, 0, W, c.hz + 2);
    ctx.fillStyle = 'rgba(255,255,255,.7)';
    for (var i = 0; i < stars.length; i++) {
      var st = stars[i];
      ctx.globalAlpha = 0.3 + 0.5 * Math.abs(Math.sin(now / 900 + st[2] * 9));
      ctx.fillRect(st[0] * W, st[1] * H, 1.5, 1.5);
    }
    ctx.globalAlpha = 1;
    // Hills of the Swansea Valley
    ctx.fillStyle = '#12060a';
    ctx.beginPath(); ctx.moveTo(0, c.hz);
    var pan = c.yaw * 1.4;
    for (var hx = 0; hx <= W; hx += W / 24) ctx.lineTo(hx, c.hz - H * (0.07 + 0.05 * Math.sin(hx / W * 7 + 1.3 - pan) + 0.03 * Math.sin(hx / W * 17 - pan * 2)));
    ctx.lineTo(W, c.hz); ctx.fill();
    // Floodlights
    [[-34, s.dist + 18], [34, s.dist + 18], [-38, s.dist - 30], [38, s.dist - 30]].forEach(function (fl) {
      var base = P(c, fl[0], 0, fl[1]), top = P(c, fl[0], 22, fl[1]);
      ctx.strokeStyle = 'rgba(160,150,150,.5)'; ctx.lineWidth = Math.max(1, base[2] * 0.25);
      ctx.beginPath(); ctx.moveTo(base[0], base[1]); ctx.lineTo(top[0], top[1]); ctx.stroke();
      var g = ctx.createRadialGradient(top[0], top[1], 0, top[0], top[1], Math.max(30, top[2] * 6));
      g.addColorStop(0, 'rgba(255,248,225,.95)'); g.addColorStop(0.15, 'rgba(255,240,200,.45)'); g.addColorStop(1, 'rgba(255,240,200,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(top[0], top[1], Math.max(30, top[2] * 6), 0, 6.3); ctx.fill();
    });
    // Grass to the bottom of the screen, whatever its shape.
    ctx.fillStyle = '#1f5a26'; ctx.fillRect(0, c.hz, W, H - c.hz);
    // The pitch: stripes from behind the ball to the dead-ball line
    var zs = [];
    for (var z = Math.max(-12, Math.ceil((c.z + 1) / 4) * 4); z <= s.dist + 22; z += 4) zs.push(z);
    for (var k = 0; k < zs.length - 1; k++) {
      var a1 = P(c, -60, 0, zs[k]), a2 = P(c, 60, 0, zs[k]), b1 = P(c, -60, 0, zs[k + 1]), b2 = P(c, 60, 0, zs[k + 1]);
      ctx.fillStyle = k % 2 ? '#1f5a26' : '#246a2c';
      ctx.beginPath(); ctx.moveTo(a1[0], a1[1]); ctx.lineTo(a2[0], a2[1]); ctx.lineTo(b2[0], b2[1]); ctx.lineTo(b1[0], b1[1]); ctx.fill();
    }
    var hzMask = P(c, 0, 0, s.dist + 22);
    ctx.fillStyle = '#1a4a20'; ctx.fillRect(0, Math.min(hzMask[1], c.hz), W, Math.max(0, c.hz - Math.min(hzMask[1], c.hz)) + 1);
    // Lines: try line, 5m, 22, 10, halfway
    var line = function (zl, w, alpha) {
      var l1 = P(c, -35, 0, zl), l2 = P(c, 35, 0, zl);
      ctx.strokeStyle = 'rgba(255,255,255,' + alpha + ')'; ctx.lineWidth = Math.max(1, l1[2] * w);
      ctx.beginPath(); ctx.moveTo(l1[0], l1[1]); ctx.lineTo(l2[0], l2[1]); ctx.stroke();
    };
    line(s.dist, 0.12, 0.9); line(s.dist - 22, 0.1, 0.75); line(s.dist + 10, 0.1, 0.7);
    if (s.dist > 35) line(s.dist - 40, 0.1, 0.7);
    [-35, 35].forEach(function (tx) {
      var t1 = P(c, tx, 0, Math.max(-8, c.z + 1)), t2 = P(c, tx, 0, s.dist + 10);
      ctx.strokeStyle = 'rgba(255,255,255,.8)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(t1[0], t1[1]); ctx.lineTo(t2[0], t2[1]); ctx.stroke();
    });
    // The clubhouse behind the posts, and the crowd
    var ch1 = P(c, -28, 0, s.dist + 20), ch2 = P(c, -8, 7, s.dist + 20);
    ctx.fillStyle = '#2b1013'; ctx.fillRect(ch1[0], ch2[1], ch2[0] - ch1[0], ch1[1] - ch2[1]);
    ctx.fillStyle = '#c41414'; ctx.fillRect(ch1[0], ch2[1], ch2[0] - ch1[0], (ch1[1] - ch2[1]) * 0.22);
    ctx.fillStyle = '#fff'; ctx.font = '600 ' + Math.max(9, ch1[2] * 1.05) + 'px Oswald, Impact, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('PONTARDAWE RFC', (ch1[0] + ch2[0]) / 2, ch2[1] + (ch1[1] - ch2[1]) * 0.11);
    ctx.fillStyle = 'rgba(255,214,140,.75)';
    for (var wi = 0; wi < 6; wi++) {
      var wx = ch1[0] + (ch2[0] - ch1[0]) * (0.08 + wi * 0.15);
      ctx.fillRect(wx, ch2[1] + (ch1[1] - ch2[1]) * 0.42, (ch2[0] - ch1[0]) * 0.09, (ch1[1] - ch2[1]) * 0.25);
    }
    var cr1 = P(c, -2, 0, s.dist + 16), cr2 = P(c, 34, 0, s.dist + 16);
    for (var ci = 0; ci < 60; ci++) {
      var u = ci / 60;
      var px = cr1[0] + (cr2[0] - cr1[0]) * u;
      var bob = phase === 'result' && lastResult && game && game.kicks.length && game.kicks[game.kicks.length - 1].verdict === 'over' ? Math.abs(Math.sin(now / 120 + ci)) * 5 : Math.sin(now / 700 + ci) * 0.8;
      ctx.fillStyle = ci % 3 === 0 ? '#c41414' : ci % 3 === 1 ? '#e9e2e2' : '#3a1d1f';
      ctx.beginPath(); ctx.arc(px, cr1[1] - cr1[2] * 1.1 - bob, Math.max(2, cr1[2] * 0.4), 0, 6.3); ctx.fill();
    }
    // A conversion: where the try was scored, and the line it is kicked on.
    if (s.kind === 'conversion') {
      var tp = P(c, s.x, 0, s.dist + 0.6);
      ctx.fillStyle = '#f2c14e';
      ctx.beginPath(); ctx.moveTo(tp[0], tp[1] - tp[2] * 1.1); ctx.lineTo(tp[0] + tp[2] * 0.5, tp[1] - tp[2] * 0.85); ctx.lineTo(tp[0], tp[1] - tp[2] * 0.6); ctx.fill();
      ctx.strokeStyle = '#f2c14e'; ctx.lineWidth = Math.max(1, tp[2] * 0.04);
      ctx.beginPath(); ctx.moveTo(tp[0], tp[1]); ctx.lineTo(tp[0], tp[1] - tp[2] * 1.1); ctx.stroke();
      if (phase === 'aim') {
        ctx.setLineDash([6, 8]); ctx.strokeStyle = 'rgba(242,193,78,.55)'; ctx.lineWidth = 2;
        var l0 = P(c, s.x, 0, Math.max(c.z + 1.5, -6)), l1 = P(c, s.x, 0, s.dist);
        ctx.beginPath(); ctx.moveTo(l0[0], l0[1]); ctx.lineTo(l1[0], l1[1]); ctx.stroke(); ctx.setLineDash([]);
      }
    }
    // The touch judges, behind the posts
    var verdictNow = phase === 'result' && game && game.kicks.length ? game.kicks[game.kicks.length - 1].verdict : null;
    if (PL) PL.judges(s, kickT, verdictNow).forEach(function (j) { PL.draw(ctx, Pw, j, 'official'); PL.flag(ctx, Pw, j); });
    // The posts
    var drawPost = function (px) {
      var b = P(c, px, 0, s.dist), t = P(c, px, POST_H, s.dist), pad = P(c, px, 1.8, s.dist);
      ctx.strokeStyle = '#f7f4f0'; ctx.lineWidth = Math.max(2, b[2] * 0.14); ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(b[0], b[1]); ctx.lineTo(t[0], t[1]); ctx.stroke();
      ctx.strokeStyle = '#c41414'; ctx.lineWidth = Math.max(4, b[2] * 0.45);
      ctx.beginPath(); ctx.moveTo(b[0], b[1]); ctx.lineTo(pad[0], pad[1]); ctx.stroke();
      // A flag on top that shows the wind
      var flag = Math.sin(now / 160) * 0.15;
      ctx.fillStyle = '#c41414';
      ctx.beginPath(); ctx.moveTo(t[0], t[1]); ctx.lineTo(t[0] + (s.wind * 3 + flag * 6) * Math.max(1, t[2] * 0.1), t[1] + 4); ctx.lineTo(t[0], t[1] + 9); ctx.fill();
    };
    drawPost(-HALF); drawPost(HALF);
    var cb1 = P(c, -HALF, BAR, s.dist), cb2 = P(c, HALF, BAR, s.dist);
    ctx.strokeStyle = '#f7f4f0'; ctx.lineWidth = Math.max(2, cb1[2] * 0.13);
    ctx.beginPath(); ctx.moveTo(cb1[0], cb1[1]); ctx.lineTo(cb2[0], cb2[1]); ctx.stroke();

    // The opposition on the try line, charging as the kicker sets off
    var otherKit = kitOf(kicking === 1 ? 2 : 1);
    if (PL) {
      var line = PL.chargers(s, kickT, 7, { still: s.kind === 'penalty', front: R.chargeLine(s) }).sort(function (a, b) { return b.z - a.z; });
      line.forEach(function (pp) { PL.draw(ctx, Pw, pp, otherKit); });
    }

    // The ball: on its tee, being aimed, or in the air
    var ball = bn.pos, spin = 0;
    if (flight && bn.idx >= 0) {
      var last = bn.last, idx = bn.idx;
      spin = ball[3] || 0;
      // The clang when it hits a post or the bar, at the moment it does.
      var evs = flight.f.events;
      while (flight.heard < evs.length && evs[flight.heard].t <= idx / 60) {
        if (evs[flight.heard].kind === 'post' || evs[flight.heard].kind === 'bar') tone('post');
        flight.heard++;
      }
      // its shadow on the grass
      var sh = P(c, ball[0], 0, ball[2]);
      ctx.fillStyle = 'rgba(0,0,0,.28)';
      ctx.beginPath(); ctx.ellipse(sh[0], sh[1], Math.max(2, sh[2] * 0.25), Math.max(1, sh[2] * 0.08), 0, 0, 6.3); ctx.fill();
      // a short trail
      ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.lineWidth = 2; ctx.beginPath();
      for (var tr = Math.max(0, idx - 18); tr <= idx; tr++) { var q = P(c, flight.f.path[tr][0], flight.f.path[tr][1], flight.f.path[tr][2]); if (tr === Math.max(0, idx - 18)) ctx.moveTo(q[0], q[1]); else ctx.lineTo(q[0], q[1]); }
      ctx.stroke();
      if (idx >= last && phase === 'flight') { flight.done = true; landed(); }
    }
    if (!flight || bn.idx < 0) {
      var tee = P(c, s.x, 0, 0);
      ctx.fillStyle = '#f2c14e';
      ctx.beginPath(); ctx.moveTo(tee[0] - tee[2] * 0.12, tee[1]); ctx.lineTo(tee[0] + tee[2] * 0.12, tee[1]); ctx.lineTo(tee[0] + tee[2] * 0.06, tee[1] - tee[2] * 0.12); ctx.lineTo(tee[0] - tee[2] * 0.06, tee[1] - tee[2] * 0.12); ctx.fill();
    }
    var bp = P(c, ball[0], ball[1], ball[2]);
    var r = Math.max(3, bp[2] * 0.2);
    ctx.save(); ctx.translate(bp[0], bp[1]); ctx.rotate(spin);
    ctx.fillStyle = '#fbf7f2'; ctx.strokeStyle = '#8f0000'; ctx.lineWidth = Math.max(1, r * 0.12);
    ctx.beginPath(); ctx.ellipse(0, 0, r * 0.62, r, 0, 0, 6.3); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#c41414'; ctx.fillRect(-r * 0.62, -r * 0.12, r * 1.24, r * 0.24);
    ctx.strokeStyle = '#8f0000'; ctx.beginPath(); ctx.moveTo(0, -r * 0.55); ctx.lineTo(0, r * 0.55); ctx.stroke();
    ctx.restore();

    // His team-mates, behind the ball as the law says (seen in the wide shot)
    if (PL && game) {
      [[-7, -7], [-11, -9], [8, -8], [12, -10]].forEach(function (tm, i) {
        PL.draw(ctx, Pw, PL.idle(s.x + tm[0], tm[1], Math.atan2(-tm[0], 9), now / 1000 + i, { armL: 0.15, armR: -0.1 }), kitOf(kicking));
      });
    }
    // The kicker: lining up, running in, striking, following through
    if (PL && game) {
      var aimNow = flight ? flight.aim : (drag ? drag.aim : keyAim);
      var kp = PL.kicker([s.x, 0, 0], aimNow, kickT, flight && flight.mood);
      PL.draw(ctx, Pw, kp, kitOf(kicking));
    }

    // The aim, while a finger or the mouse is dragging
    if (phase === 'aim') {
      var aim = drag ? drag.aim : keyAim, pow = drag ? drag.power : keyPower;
      if (drag || keyCharging || keyAim) {
        var guide = fly(s, aim, pow);
        ctx.setLineDash([4, 6]); ctx.strokeStyle = 'rgba(242,193,78,.9)'; ctx.lineWidth = 2; ctx.beginPath();
        var steps = Math.min(guide.path.length, 18);
        for (var gi = 0; gi < steps; gi++) { var gp = P(c, guide.path[gi][0], guide.path[gi][1], guide.path[gi][2]); if (!gi) ctx.moveTo(gp[0], gp[1]); else ctx.lineTo(gp[0], gp[1]); }
        ctx.stroke(); ctx.setLineDash([]);
        // power meter
        var mx = W - 34, my = H * 0.25, mh = H * 0.45;
        ctx.fillStyle = 'rgba(0,0,0,.45)'; roundRect(mx - 8, my - 8, 28, mh + 16, 12); ctx.fill();
        var grad = ctx.createLinearGradient(0, my + mh, 0, my);
        grad.addColorStop(0, '#f2c14e'); grad.addColorStop(1, '#e8312f');
        ctx.fillStyle = grad; roundRect(mx, my + mh * (1 - pow), 12, mh * pow, 6); ctx.fill();
      } else {
        // a pulsing hint over the ball
        var pulse = (now % 1400) / 1400;
        ctx.strokeStyle = 'rgba(255,255,255,' + (1 - pulse) * 0.8 + ')'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(bp[0], bp[1], r * (1.6 + pulse * 2), 0, 6.3); ctx.stroke();
        ctx.fillStyle = '#f2c14e'; ctx.font = '800 ' + Math.round(Math.max(12, H * 0.022)) + 'px Montserrat, sans-serif'; ctx.textAlign = 'center';
        ctx.shadowColor = 'rgba(0,0,0,.7)'; ctx.shadowBlur = 8;
        ctx.fillText('SWIPE UP TO KICK', bp[0], bp[1] + r * 2.4 + 18);
        ctx.shadowBlur = 0;
      }
    }

    // Confetti after a conversion
    for (var cf = confetti.length - 1; cf >= 0; cf--) {
      var p = confetti[cf];
      p.x += p.vx; p.y += p.vy; p.vy += 0.12; p.vx *= 0.99; p.r += p.vr; p.life -= 0.012;
      if (p.life <= 0) { confetti.splice(cf, 1); continue; }
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.globalAlpha = Math.min(1, p.life * 2);
      ctx.fillStyle = p.c; ctx.fillRect(-4, -6, 8, 12); ctx.restore();
    }
    ctx.globalAlpha = 1;
  }
  function roundRect(x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function burst() {
    if (reduced) return;
    var cols = ['#f2c14e', '#ffffff', '#e8312f', '#c41414'];
    for (var i = 0; i < 90; i++) confetti.push({ x: W / 2, y: H * 0.3, vx: (Math.random() - 0.5) * 14, vy: -Math.random() * 9 - 2, r: Math.random() * 6, vr: (Math.random() - 0.5) * 0.4, c: cols[i % 4], life: 1 + Math.random() * 0.6 });
  }

  // The canvas draws text in whatever font is ready; ask for the club's
  // fonts first, so the sign and the hint are never in a fallback face.
  if (d.fonts && d.fonts.load) {
    ['600 20px Oswald', '400 20px "Ponty Brush"', '700 14px Montserrat'].forEach(function (f) { d.fonts.load(f).catch(function () {}); });
  }

  function loop(now) {
    draw(now);
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  /* --- Input: swipe, drag, or the keyboard -------------------------------- */
  cv.addEventListener('pointerdown', function (e) {
    if (phase !== 'aim') return;
    if (camIntro && performance.now() - camIntro.t0 < camIntro.dur * 0.7) return;
    cv.setPointerCapture(e.pointerId);
    drag = { x0: e.clientX, y0: e.clientY, aim: 0, power: 0, t0: performance.now() };
    e.preventDefault();
  });
  cv.addEventListener('pointermove', function (e) {
    if (!drag) return;
    var dx = e.clientX - drag.x0, dy = drag.y0 - e.clientY;
    drag.aim = clamp(dx / (W * 0.42), -1, 1);
    drag.power = clamp(dy / (H * 0.6), 0, 1);
  });
  var release = function () {
    if (!drag) return;
    var k = drag;
    drag = null;
    if (k.power < 0.06) { toast('Swipe up from the ball: further for more power, sideways to aim.'); return; }
    kickNow(k.aim, k.power, turn().player);
  };
  cv.addEventListener('pointerup', release);
  cv.addEventListener('pointercancel', function () { drag = null; });
  d.addEventListener('keydown', function (e) {
    if (phase !== 'aim' || !box.classList.contains('playing')) return;
    if (e.key === 'ArrowDown') { moveBall(1); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { moveBall(-1); e.preventDefault(); }
    else if (e.key === 'ArrowLeft') { keyAim = clamp(keyAim - 0.04, -1, 1); e.preventDefault(); }
    else if (e.key === 'ArrowRight') { keyAim = clamp(keyAim + 0.04, -1, 1); e.preventDefault(); }
    else if (e.key === ' ' && !keyCharging) {
      keyCharging = true; keyPower = 0; e.preventDefault();
      var t0 = performance.now();
      var fill = function (now) {
        if (!keyCharging) return;
        keyPower = Math.min(1, (now - t0) / 1600);
        requestAnimationFrame(fill);
      };
      requestAnimationFrame(fill);
    }
  });
  d.addEventListener('keyup', function (e) {
    if (e.key !== ' ' || !keyCharging) return;
    keyCharging = false;
    if (phase === 'aim') kickNow(keyAim, keyPower, turn().player);
  });

  /* --- Online: a room, over a WebSocket (polling if that will not open) ---- */
  function api(path, body) {
    return fetch('/api/play' + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Something went wrong.'); return j; }); });
  }

  function Net(room) {
    var self = this;
    this.room = room; // { code, token, ... }
    this.rev = 0;
    this.open = function () {
      var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
      try {
        self.ws = new WebSocket(proto + location.host + '/api/play/ws?code=' + encodeURIComponent(room.code) + '&t=' + encodeURIComponent(room.token));
      } catch (e) { self.poll(); return; }
      var opened = false;
      self.ws.onopen = function () { opened = true; self.tries = 0; };
      self.ws.onmessage = function (ev) {
        var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.type === 'state') onState(m.state);
        else if (m.type === 'error') { toast(m.error); if (phase === 'wait' && humanTurn(turn().player)) { phase = 'aim'; say('Your kick', 'Swipe up from the ball'); } }
      };
      self.ws.onclose = function () {
        self.ws = null;
        if (self.closed) return;
        self.tries = (self.tries || 0) + 1;
        if (!opened && self.tries >= 2) { self.poll(); return; }
        setTimeout(self.open, Math.min(4000, 400 * self.tries));
      };
    };
    this.poll = function () {
      if (self.polling) return;
      self.polling = true;
      var tick = function () {
        if (self.closed) return;
        api('/rooms/' + room.code + '?t=' + encodeURIComponent(room.token)).then(onState).catch(function () {}).then(function () { setTimeout(tick, 900); });
      };
      tick();
    };
    this.send = function (msg) {
      if (self.ws && self.ws.readyState === 1) { self.ws.send(JSON.stringify(msg)); return; }
      var path = msg.type === 'kick' ? '/kick' : '/rematch';
      api('/rooms/' + room.code + path, Object.assign({ token: room.token }, msg)).then(onState).catch(function (e) { toast(e.message); });
    };
    this.close = function () { self.closed = true; if (self.ws) self.ws.close(); };
    this.open();
  }

  function onState(st) {
    if (!st || !net || st.rev <= net.rev) return;
    net.rev = st.rev;
    net.latest = st;
    if (st.players.length < 2) {
      var lobby = ui.menu.querySelector('[data-g-lobby]');
      if (lobby) lobby.innerHTML = lobbyHtml(st);
      return;
    }
    // The first time both are here, or a rematch: a new game in the room.
    if (!game || game.mode !== 'online' || game.games !== st.games) {
      start({ mode: 'online', seed: st.seed, names: st.players, teams: st.teams, me: st.you });
      game.games = st.games;
      return;
    }
    if (phase === 'aim' || phase === 'wait') playPending();
  }
  /** Play the next kick the server has that this phone has not shown yet. */
  function playPending() {
    var st = net && net.latest;
    if (!st || !game || game.mode !== 'online' || st.games !== game.games) return false;
    if (st.kicks.length <= game.kicks.length) return false;
    var k = st.kicks[game.kicks.length];
    kickNow(k.aim, k.power, k.player, k);
    return true;
  }
  // Between kicks, an online game first plays anything that has arrived.
  var baseNext = next;
  next = function () {
    if (game && game.mode === 'online' && playPending()) return;
    baseNext();
  };

  function lobbyHtml(st) {
    var link = location.origin + '/play?room=' + st.code;
    return '<p class="g-code-label">Your game code</p><p class="g-code">' + esc(st.code) + '</p>' +
      '<p>Send this to a friend. They open <b>pontardawerfc.com/play</b> and type the code, or tap your link:</p>' +
      '<p class="g-share"><button type="button" class="btn btn-sm btn-glow" data-g-share data-link="' + esc(link) + '">Share the link</button><button type="button" class="btn btn-sm btn-line" data-g-copy data-link="' + esc(link) + '">Copy</button></p>' +
      '<p class="g-waiting"><span></span>Waiting for your friend…</p>';
  }

  /* --- The menu ----------------------------------------------------------- */
  var name = '';
  try { name = localStorage.getItem('pk-name') || ''; } catch (e) { /* private */ }
  var nameInput = ui.menu.querySelector('[data-g-name]');
  if (nameInput) nameInput.value = name;
  var getName = function () {
    var n = (nameInput && nameInput.value.trim()) || 'You';
    try { localStorage.setItem('pk-name', n); } catch (e) { /* private */ }
    return n.slice(0, 16);
  };
  var best = 0;
  try { best = Number(localStorage.getItem('pk-best') || 0); } catch (e) { /* private */ }
  var bestEl = ui.menu.querySelector('[data-g-best]');
  if (bestEl && best) bestEl.textContent = 'Your best win against the computer: ' + best + ' points';

  // Your team and the other side, remembered on this device.
  var picked = { me: 'pontardawe', opp: 'penlan' };
  try { picked = Object.assign(picked, JSON.parse(localStorage.getItem('pk-teams') || '{}')); } catch (e) { /* private */ }
  if (!TEAMS[picked.me]) picked.me = 'pontardawe';
  if (!TEAMS[picked.opp]) picked.opp = 'penlan';
  var showPicked = function () {
    box.querySelectorAll('[data-g-team]').forEach(function (bt) {
      bt.setAttribute('aria-pressed', String(picked[bt.getAttribute('data-g-team')] === bt.getAttribute('data-key')));
    });
  };
  showPicked();

  box.addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    if (b.hasAttribute('data-g-back')) { moveBall(1); return; }
    if (b.hasAttribute('data-g-fwd')) { moveBall(-1); return; }
    if (b.hasAttribute('data-g-team')) {
      picked[b.getAttribute('data-g-team')] = b.getAttribute('data-key');
      try { localStorage.setItem('pk-teams', JSON.stringify(picked)); } catch (err) { /* private */ }
      showPicked();
      return;
    }
    if (b.hasAttribute('data-g-ai')) {
      if (net) { net.close(); net = null; }
      var level = b.getAttribute('data-g-ai');
      start({ mode: 'ai', level: level, seed: (Math.random() * 4294967296) >>> 0, names: [getName(), R.team(picked.opp).name], teams: [picked.me, picked.opp] });
    } else if (b.hasAttribute('data-g-local')) {
      if (net) { net.close(); net = null; }
      start({ mode: 'local', seed: (Math.random() * 4294967296) >>> 0, names: [R.team(picked.me).name, R.team(picked.opp).name], teams: [picked.me, picked.opp] });
    } else if (b.hasAttribute('data-g-host')) {
      b.disabled = true;
      api('/rooms', { name: getName(), team: picked.me }).then(function (room) {
        net = new Net(room);
        onState(room);
      }).catch(function (err) { toast(err.message); }).then(function () { b.disabled = false; });
    } else if (b.hasAttribute('data-g-join')) {
      var codeIn = ui.menu.querySelector('[data-g-code]');
      joinRoom((codeIn && codeIn.value) || '');
    } else if (b.hasAttribute('data-g-share')) {
      var link = b.getAttribute('data-link');
      if (navigator.share) navigator.share({ title: 'Ponty Kicks', text: 'Beat me at Ponty Kicks!', url: link }).catch(function () {});
      else copy(link);
    } else if (b.hasAttribute('data-g-copy')) {
      copy(b.getAttribute('data-link'));
    } else if (b.hasAttribute('data-g-again')) {
      if (game.mode === 'online') net.send({ type: 'rematch' });
      else start({ mode: game.mode, level: game.level, seed: (Math.random() * 4294967296) >>> 0, names: game.names, teams: game.teams });
    } else if (b.hasAttribute('data-g-menu-open')) {
      if (net) { net.close(); net = null; }
      phase = 'menu'; game = null; current = null; flight = null;
      box.classList.remove('playing');
      ui.over.hidden = true; ui.menu.hidden = false; hideBanner(); ui.hud.innerHTML = '';
      var lobby = ui.menu.querySelector('[data-g-lobby]'); if (lobby) lobby.innerHTML = '';
    } else if (b.hasAttribute('data-g-mute')) {
      muted = !muted;
      try { localStorage.setItem('pk-mute', muted ? '1' : '0'); } catch (err) { /* private */ }
      b.setAttribute('aria-pressed', String(muted));
    } else if (b.hasAttribute('data-g-full')) {
      var el = box;
      if (d.fullscreenElement) d.exitFullscreen();
      else if (el.requestFullscreen) el.requestFullscreen().then(function () {
        try { screen.orientation.lock('landscape').catch(function () {}); } catch (err) { /* not on this device */ }
      }).catch(function () {});
      else box.classList.toggle('g-fake-full');
      setTimeout(resize, 300);
    }
  });
  d.addEventListener('fullscreenchange', function () { setTimeout(resize, 100); });
  var muteBtn = box.querySelector('[data-g-mute]');
  if (muteBtn) muteBtn.setAttribute('aria-pressed', String(muted));

  function copy(text) {
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(function () { toast('Link copied'); }).catch(function () { toast(text); });
  }
  function joinRoom(c) {
    c = String(c).toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (c.length < 4) { toast('Type the five-letter code your friend sent.'); return; }
    api('/rooms/' + c + '/join', { name: getName(), team: picked.me }).then(function (room) {
      net = new Net(room);
      onState(room);
    }).catch(function (err) { toast(err.message); });
  }
  // Read-only, for checking a game from the browser's console.
  window.PontyKicksState = function () { return { phase: phase, game: game, rev: net && net.rev, latest: net && net.latest, socket: net && net.ws ? net.ws.readyState : null, polling: !!(net && net.polling) }; };

  var q = new URLSearchParams(location.search).get('room');
  if (q) {
    var codeIn = ui.menu.querySelector('[data-g-code]');
    if (codeIn) codeIn.value = q.toUpperCase();
    toast('Type your name, then tap Join to play ' + q.toUpperCase());
  }

})();
