/*
 * The loading screen while Flutter starts: a progress bar that follows the
 * real steps (flutter_bootstrap.js calls MetricSplash.step), creeping on
 * between them so it never looks stuck, then fades once the first frame is
 * drawn. The biggest downloads (the drawing engine and the app's code) are
 * started here, in parallel, rather than one after the other.
 */
(function () {
  'use strict';

  var head = document.head;
  function preload(href, as, cors) {
    var l = document.createElement('link');
    l.rel = 'preload';
    l.href = href;
    l.as = as;
    if (cors) l.crossOrigin = 'anonymous';
    head.appendChild(l);
  }
  // Chromium browsers get the smaller engine build (Flutter's own rule:
  // Chromium and ImageDecoder), everything else the full one.
  var brands = (navigator.userAgentData && navigator.userAgentData.brands) || [];
  var chromium = typeof ImageDecoder !== 'undefined' && brands.some(function (b) { return /Chromium/.test(b.brand); });
  var kit = chromium ? 'canvaskit/chromium/' : 'canvaskit/';
  preload(kit + 'canvaskit.js', 'script');
  preload(kit + 'canvaskit.wasm', 'fetch', true);
  preload('main.dart.js', 'script');

  // Where each step leaves the bar.
  var STEPS = { start: 0.06, bootstrap: 0.18, code: 0.72, engine: 0.9, frame: 1 };
  var NEXT = { start: 'bootstrap', bootstrap: 'code', code: 'engine', engine: 'frame' };
  var at = 'start';
  var shown = 0;
  var bar = null;
  var began = Date.now();

  function draw() {
    if (!bar) bar = document.getElementById('splash-bar');
    if (!bar) return;
    var floor = STEPS[at];
    var ceiling = NEXT[at] ? STEPS[NEXT[at]] : 1;
    // Creep towards the next step without ever reaching it.
    var target = floor + (ceiling - floor) * 0.85;
    shown = Math.max(shown, floor);
    shown += (target - shown) * 0.035;
    bar.style.transform = 'scaleX(' + shown.toFixed(3) + ')';
    var slow = document.getElementById('splash-slow');
    if (slow && Date.now() - began > 7000 && at !== 'frame') slow.classList.add('on');
  }
  var timer = setInterval(draw, 50);

  window.MetricSplash = {
    step: function (name) {
      if (STEPS[name] > STEPS[at]) at = name;
      draw();
    },
  };

  // Fade the splash away once Flutter has drawn its first frame.
  window.addEventListener('flutter-first-frame', function () {
    at = 'frame';
    shown = 1;
    draw();
    clearInterval(timer);
    var s = document.getElementById('splash');
    if (!s) return;
    setTimeout(function () {
      s.classList.add('gone');
      setTimeout(function () { s.remove(); }, 400);
    }, 150);
  });
})();
