/* pontardawerfc.com: the kick-off opening, the hero's moving pitch, the
   crest and posters that follow the pointer, the match clock and the season
   timeline (2026-10-15). No libraries. Nothing here is needed to read or use
   the site: with reduced motion, or with no script, the page is the same page
   standing still. */
(function () {
  'use strict';
  var d = document;
  var root = d.documentElement;
  var reduced = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var finePointer = window.matchMedia && matchMedia('(hover: hover) and (pointer: fine)').matches;

  /* --- The kick-off opening ------------------------------------------------ */
  var kick = d.querySelector('[data-kick]');
  if (kick && root.classList.contains('kick-on')) {
    var stage = kick.querySelector('.kick-stage');
    var done = function () { root.classList.remove('kick-on', 'kick-skip'); };
    var skip = function () { root.classList.add('kick-skip'); setTimeout(done, 260); };
    kick.addEventListener('animationend', function (e) { if (e.target === kick) done(); });
    kick.addEventListener('pointerdown', skip);
    d.addEventListener('keydown', skip, { once: true });
    // The posts lean toward the pointer, so the opening answers a hand.
    kick.addEventListener('pointermove', function (e) {
      var x = e.clientX / innerWidth - 0.5;
      var y = e.clientY / innerHeight - 0.5;
      stage.style.setProperty('--ky', (x * 18).toFixed(2) + 'deg');
      stage.style.setProperty('--kx', (-y * 14).toFixed(2) + 'deg');
    });
    setTimeout(done, 1700);
  }
  if (reduced) return;

  /* --- The hero's pitch ------------------------------------------------------
     Touchlines running away to the posts, chalk dust drifting up, and sparks
     in the club's red and gold that scatter from a finger or the pointer. */
  var hero = d.querySelector('[data-hero]');
  var canvas = d.querySelector('[data-hero-canvas]');
  if (hero && canvas && canvas.getContext) {
    var ctx = canvas.getContext('2d');
    var dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    var W = 0, H = 0, running = false, visible = true, t0 = performance.now();
    var pointer = { x: -1e4, y: -1e4, on: false };
    var small = innerWidth < 700;
    var sparks = [];
    var N = small ? 42 : 90;

    var size = function () {
      var r = hero.getBoundingClientRect();
      W = r.width; H = r.height;
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    var spark = function (x, y, burst) {
      var gold = Math.random() < 0.35;
      return {
        x: x == null ? Math.random() * W : x,
        y: y == null ? H + Math.random() * H * 0.3 : y,
        vx: burst ? (Math.random() - 0.5) * 6 : (Math.random() - 0.5) * 0.3,
        vy: burst ? (Math.random() - 0.7) * 6 : -(0.25 + Math.random() * 0.7),
        r: burst ? 1.4 + Math.random() * 2.4 : 0.9 + Math.random() * 2.1,
        life: burst ? 1 : 0, burst: burst,
        c: gold ? '242,193,78' : (Math.random() < 0.5 ? '255,255,255' : '232,49,47'),
      };
    };
    size();
    for (var i = 0; i < N; i++) { var s = spark(); s.y = Math.random() * H; sparks.push(s); }

    var pitch = function (t) {
      // Perspective lines toward a vanishing point behind the crest.
      var vx = W * (W > 760 ? 0.72 : 0.5) + (pointer.on ? (pointer.x - W / 2) * 0.03 : 0);
      var vy = H * 0.34;
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(255,255,255,0.13)';
      for (var k = -6; k <= 6; k++) {
        ctx.beginPath();
        ctx.moveTo(vx + k * 4, vy);
        ctx.lineTo(vx + k * W * 0.22, H + 40);
        ctx.stroke();
      }
      // Cross lines rolling toward the viewer: the 22, the 10, halfway.
      var speed = (t / 5200) % 1;
      for (var j = 0; j < 7; j++) {
        var p = (j / 7 + speed) % 1;
        var e = p * p;
        var y = vy + (H + 40 - vy) * e;
        ctx.strokeStyle = 'rgba(255,255,255,' + (0.04 + e * 0.2).toFixed(3) + ')';
        ctx.lineWidth = 0.6 + e * 2;
        ctx.beginPath();
        ctx.moveTo(vx - W * 1.4 * e, y);
        ctx.lineTo(vx + W * 1.4 * e, y);
        ctx.stroke();
      }
      // Faint posts at the vanishing point.
      ctx.strokeStyle = 'rgba(255,255,255,0.22)';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(vx - 16, vy - 46); ctx.lineTo(vx - 16, vy + 6);
      ctx.moveTo(vx + 16, vy - 46); ctx.lineTo(vx + 16, vy + 6);
      ctx.moveTo(vx - 16, vy - 18); ctx.lineTo(vx + 16, vy - 18);
      ctx.stroke();
    };

    var frame = function (now) {
      if (!running) return;
      var t = now - t0;
      ctx.clearRect(0, 0, W, H);
      pitch(t);
      if (pointer.on) {
        var g = ctx.createRadialGradient(pointer.x, pointer.y, 0, pointer.x, pointer.y, 220);
        g.addColorStop(0, 'rgba(232,49,47,0.20)');
        g.addColorStop(1, 'rgba(232,49,47,0)');
        ctx.fillStyle = g;
        ctx.fillRect(pointer.x - 220, pointer.y - 220, 440, 440);
      }
      for (var i = sparks.length - 1; i >= 0; i--) {
        var s = sparks[i];
        if (pointer.on) {
          var dx = s.x - pointer.x, dy = s.y - pointer.y, dd = dx * dx + dy * dy;
          if (dd < 14400 && dd > 1) { var f = 30 / dd; s.vx += dx * f; s.vy += dy * f; }
        }
        s.x += s.vx; s.y += s.vy;
        if (s.burst) { s.vx *= 0.94; s.vy = s.vy * 0.94 + 0.05; s.life -= 0.018; }
        else { s.vx *= 0.98; s.vy = Math.max(s.vy * 0.99, -1.2) - 0.002; }
        var a = s.burst ? Math.max(0, s.life) : Math.min(1, (H - s.y) / 140) * 0.9;
        ctx.fillStyle = 'rgba(' + s.c + ',' + a.toFixed(3) + ')';
        ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, 6.283); ctx.fill();
        if ((s.burst && s.life <= 0) || s.y < -20 || s.x < -40 || s.x > W + 40) {
          if (s.burst) sparks.splice(i, 1); else sparks[i] = spark();
        }
      }
      requestAnimationFrame(frame);
    };
    var play = function () {
      var want = visible && !d.hidden;
      if (want && !running) { running = true; requestAnimationFrame(frame); }
      else if (!want) running = false;
    };

    hero.addEventListener('pointermove', function (e) {
      var r = hero.getBoundingClientRect();
      pointer.x = e.clientX - r.left; pointer.y = e.clientY - r.top; pointer.on = true;
    }, { passive: true });
    hero.addEventListener('pointerleave', function () { pointer.on = false; });
    // A tap or click on the pitch kicks up a burst of sparks.
    hero.addEventListener('pointerdown', function (e) {
      if (e.target.closest('a, button')) return;
      var r = hero.getBoundingClientRect();
      for (var b = 0; b < (small ? 18 : 30); b++) sparks.push(spark(e.clientX - r.left, e.clientY - r.top, true));
    }, { passive: true });
    window.addEventListener('resize', function () { small = innerWidth < 700; size(); }, { passive: true });
    d.addEventListener('visibilitychange', play);
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (en) { visible = en[0].isIntersecting; play(); }).observe(hero);
    }
    // Wait for the opening, so the two do not compete for the first second.
    setTimeout(function () { canvas.classList.add('on'); play(); }, root.classList.contains('kick-on') ? 1150 : 60);
  }

  /* --- The crest and the posters lean toward the pointer --------------------- */
  var lean = function (el, max) {
    el.addEventListener('pointermove', function (e) {
      var r = el.getBoundingClientRect();
      var x = (e.clientX - r.left) / r.width - 0.5;
      var y = (e.clientY - r.top) / r.height - 0.5;
      el.style.setProperty('--ry', (x * max).toFixed(2) + 'deg');
      el.style.setProperty('--rx', (-y * max).toFixed(2) + 'deg');
    });
    el.addEventListener('pointerleave', function () { el.style.removeProperty('--rx'); el.style.removeProperty('--ry'); });
  };
  if (finePointer) {
    d.querySelectorAll('[data-tilt]').forEach(function (el) { lean(el, 8); });
    var crest = d.querySelector('[data-tilt-crest]');
    if (crest && hero) {
      hero.addEventListener('pointermove', function (e) {
        var x = e.clientX / innerWidth - 0.5;
        var y = e.clientY / innerHeight - 0.5;
        crest.style.setProperty('--ry', (x * 22).toFixed(2) + 'deg');
        crest.style.setProperty('--rx', (-y * 16).toFixed(2) + 'deg');
      }, { passive: true });
    }
  }

  /* --- The season timeline draws itself as it is scrolled ------------------- */
  var season = d.querySelector('[data-season]');
  if (season) {
    var draw = function () {
      var r = season.getBoundingClientRect();
      var p = (innerHeight * 0.75 - r.top) / r.height;
      season.style.setProperty('--sp', Math.max(0, Math.min(1, p)).toFixed(4));
    };
    window.addEventListener('scroll', draw, { passive: true });
    draw();
  }
})();

/* The match clock and the season filter run whatever the motion setting:
   they are information, not decoration. */
(function () {
  'use strict';
  var d = document;

  d.querySelectorAll('[data-countdown][data-boxes]').forEach(function (el) {
    var at = new Date(el.getAttribute('data-countdown'));
    if (isNaN(at)) return;
    var names = ['Days', 'Hours', 'Mins', 'Secs'];
    el.innerHTML = names.map(function (n) { return '<span class="box"><b>00</b><small>' + n + '</small></span>'; }).join('');
    el.setAttribute('role', 'timer');
    el.setAttribute('aria-label', 'Time to kick-off');
    var cells = el.querySelectorAll('b');
    var last = [];
    var tick = function () {
      var ms = at - new Date();
      if (ms <= 0) {
        el.innerHTML = '<span class="kicked">' + (ms > -2 * 3600e3 ? 'Kick-off!' : 'Full time') + '</span>';
        clearInterval(timer);
        return;
      }
      var v = [Math.floor(ms / 864e5), Math.floor(ms % 864e5 / 36e5), Math.floor(ms % 36e5 / 6e4), Math.floor(ms % 6e4 / 1e3)];
      v.forEach(function (n, i) {
        var s = n < 10 ? '0' + n : String(n);
        if (s !== last[i]) {
          cells[i].textContent = s;
          cells[i].classList.remove('tick'); void cells[i].offsetWidth; cells[i].classList.add('tick');
          last[i] = s;
        }
      });
    };
    var timer = setInterval(tick, 1000);
    tick();
  });

  var chips = d.querySelector('.filter-chips');
  var items = d.querySelectorAll('.season-item');
  if (chips && items.length) {
    chips.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-filter]');
      if (!b) return;
      var k = b.getAttribute('data-filter');
      chips.querySelectorAll('button').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
      items.forEach(function (li) {
        li.hidden = !(k === 'all' || li.getAttribute('data-kind') === k);
        if (!li.hidden) li.classList.add('in');
      });
      window.dispatchEvent(new Event('scroll'));
    });
  }
})();
