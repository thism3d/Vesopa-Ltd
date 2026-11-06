/* go.vesopa.com, the 2026-11 polish (css/premium.css): the progress line, the
   header's section marker, the hero lifting away as you scroll, the light in
   the feature tiles, their small live pictures, and the scroll story's step
   count and dots. Runs after js/go.js; nothing here is needed to read the page. */
(function () {
  'use strict';
  var root = document.documentElement;
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  requestAnimationFrame(function () { requestAnimationFrame(function () { root.classList.add('ready'); }); });

  // ---- the progress line and the hero lifting away -----------------------
  var bar = document.querySelector('.progress');
  var heroCopy = document.querySelector('.hero-copy');
  var ticking = false;
  function paint() {
    ticking = false;
    var max = document.documentElement.scrollHeight - window.innerHeight;
    var y = window.scrollY;
    if (bar) bar.style.transform = 'scaleX(' + (max > 0 ? Math.min(1, y / max) : 0).toFixed(4) + ')';
    if (heroCopy && !reduced) {
      var k = Math.min(1, y / (window.innerHeight * .8));
      heroCopy.style.transform = 'translate3d(0,' + (k * -40).toFixed(1) + 'px,0)';
      heroCopy.style.opacity = (1 - k * .9).toFixed(3);
    }
  }
  window.addEventListener('scroll', function () { if (!ticking) { ticking = true; requestAnimationFrame(paint); } }, { passive: true });
  paint();

  // ---- the header marks the section you're in ----------------------------
  var links = Array.prototype.slice.call(document.querySelectorAll('nav.links a[href^="#"]'));
  if ('IntersectionObserver' in window && links.length) {
    var byId = {};
    links.forEach(function (a) { byId[a.getAttribute('href').slice(1)] = a; });
    var spy = new IntersectionObserver(function (es) {
      es.forEach(function (e) {
        if (!e.isIntersecting) return;
        links.forEach(function (a) { a.classList.remove('active'); });
        var a = byId[e.target.id];
        if (a) a.classList.add('active');
      });
    }, { rootMargin: '-45% 0px -50% 0px' });
    Object.keys(byId).forEach(function (id) { var s = document.getElementById(id); if (s) spy.observe(s); });
  }

  // ---- the light that follows you across a tile ---------------------------
  document.querySelectorAll('.tile').forEach(function (t) {
    t.addEventListener('pointermove', function (e) {
      var r = t.getBoundingClientRect();
      t.style.setProperty('--mx', (e.clientX - r.left) + 'px');
      t.style.setProperty('--my', (e.clientY - r.top) + 'px');
    });
  });
  // On a phone there's no pointer: the tile in the middle of the screen lights.
  if ('IntersectionObserver' in window && window.matchMedia('(hover: none)').matches) {
    var lit = new IntersectionObserver(function (es) {
      es.forEach(function (e) { e.target.classList.toggle('lit', e.isIntersecting); });
    }, { rootMargin: '-40% 0px -40% 0px' });
    document.querySelectorAll('.tile').forEach(function (t) { t.style.setProperty('--my', '30%'); lit.observe(t); });
  }

  // ---- the small live pictures, only while they're on screen ---------------
  function whileSeen(el, every, fn) {
    if (!el || reduced) return;
    var timer = null;
    new IntersectionObserver(function (es) {
      if (es[0].isIntersecting) { if (!timer) { fn(); timer = setInterval(fn, every); } }
      else if (timer) { clearInterval(timer); timer = null; }
    }).observe(el);
  }
  var keys = document.querySelector('.mini.keys');
  if (keys) {
    for (var i = 0; i < 15; i++) keys.appendChild(document.createElement('i'));
    var kk = keys.children, step = 0, order = [6, 2, 12, 8, 0, 14, 4, 10];
    whileSeen(keys, 900, function () {
      for (var j = 0; j < kk.length; j++) kk[j].classList.remove('on');
      kk[order[step % order.length]].classList.add('on');
      kk[order[(step + 3) % order.length]].classList.add('on');
      step++;
    });
  }
  var floor = document.querySelector('.mini.floor');
  if (floor) {
    for (var f = 0; f < 9; f++) floor.appendChild(document.createElement('i'));
    var tables = floor.children, n = 0;
    whileSeen(floor, 1100, function () {
      var t = tables[(n * 4) % 9];
      if (t.classList.contains('paying')) t.classList.remove('paying', 'seated');
      else if (t.classList.contains('seated')) { t.classList.remove('seated'); t.classList.add('paying'); }
      else t.classList.add('seated');
      n++;
    });
  }
  var signal = document.querySelector('.signal');
  if (signal) {
    var label = signal.querySelector('.label'), wire = signal.querySelector('.wire'), on = true;
    whileSeen(signal, 2600, function () {
      on = !on;
      signal.classList.toggle('off', !on);
      wire.classList.toggle('cut', !on);
      label.textContent = on ? 'Online · sent' : 'Offline · kept safe';
    });
  }

  // ---- the scroll story: "Step 2 of 5" and the dots follow the step --------
  var steps = Array.prototype.slice.call(document.querySelectorAll('.steps-list .step'));
  var count = document.querySelector('.steps-phone .count b');
  var dots = document.querySelector('.steps-phone .dots');
  if (steps.length && dots) {
    steps.forEach(function () { dots.appendChild(document.createElement('i')); });
    var sync = function () {
      var i = steps.findIndex(function (s) { return s.classList.contains('on'); });
      if (i < 0) i = 0;
      if (count) count.textContent = String(i + 1);
      Array.prototype.forEach.call(dots.children, function (d, k) { d.classList.toggle('on', k === i); });
    };
    var mo = new MutationObserver(sync);
    steps.forEach(function (s) { mo.observe(s, { attributes: true, attributeFilter: ['class'] }); });
    sync();
  }
})();
