/*
 * The phone's own bars around Metric Membership, and keeping an open app
 * current. Loaded by the member app (app/web/index.html) and the staff
 * console (public/admin/index.html) as /theme.js, never cached.
 *
 * Android Chrome colours its top bar from <meta name="theme-color"> and, in
 * newer versions, its bottom navigation bar from the page's own background.
 * A Flutter page is a canvas over a white <body>, so without this the bottom
 * bar stays white and Flutter's engine rewrites or removes theme-color as
 * screens change. So this script:
 *
 *   1. paints theme-color and the html/body background at once, from the last
 *      colours it saw (kept in localStorage, so there is no white flash);
 *   2. asks /api/v1/theme (no-store) now, every minute and whenever the app
 *      comes back to the front, and applies what staff chose under Appearance
 *      without a reload;
 *   3. when "animated", moves the top bar slowly through the theme's gradient
 *      (paused while hidden, off under reduced motion);
 *   4. holds every theme-color tag to its colour, whoever else writes one;
 *   5. when a new web build is live, reloads the next time the app is brought
 *      back to the front, so nobody loses what they were typing.
 *
 * DESIGN.md ("System bars") says how to add a theme.
 */
(function () {
  'use strict';

  var KEY = 'metric.theme.v1';
  var PERIOD = 14000; // one trip through the gradient and back, in ms
  var STEP = 120; // how often the animated colour is written
  var POLL = 60000;

  var root = document.documentElement;
  // The member app is a canvas, so its page background can follow the bottom
  // bar (data-paint="page"); the console keeps its own background.
  var script = document.currentScript;
  var paintPage = !!(script && script.getAttribute('data-paint') === 'page');
  var theme = null;
  var build = null;
  var reloadPending = false;
  var current = null;
  var timer = null;
  var start = Date.now();
  var still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)');

  function store(value) {
    try { localStorage.setItem(KEY, JSON.stringify(value)); } catch (e) { /* private window */ }
  }

  function stored() {
    try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; }
  }

  function metas() {
    var list = document.querySelectorAll('meta[name="theme-color"]');
    if (list.length) return list;
    var m = document.createElement('meta');
    m.name = 'theme-color';
    document.head.appendChild(m);
    return [m];
  }

  function paintTop(colour) {
    if (colour === current) return;
    current = colour;
    var list = metas();
    for (var i = 0; i < list.length; i++) {
      if (list[i].getAttribute('content') !== colour) list[i].setAttribute('content', colour);
    }
  }

  function hex(c) {
    var n = parseInt(c.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function mix(a, b, t) {
    var x = hex(a), y = hex(b), out = '#';
    for (var i = 0; i < 3; i++) out += ('0' + Math.round(x[i] + (y[i] - x[i]) * t).toString(16)).slice(-2);
    return out.toUpperCase();
  }

  // Where along the gradient the top bar is at time `ms`: out and back again,
  // eased so it lingers on each stop rather than flickering between them.
  function at(stops, ms) {
    if (stops.length < 2) return stops[0];
    var phase = (ms % PERIOD) / PERIOD;
    var p = phase < 0.5 ? phase * 2 : (1 - phase) * 2;
    var pos = p * (stops.length - 1);
    var i = Math.min(Math.floor(pos), stops.length - 2);
    var t = pos - i;
    t = t * t * (3 - 2 * t);
    return mix(stops[i], stops[i + 1], t);
  }

  function animate() {
    clearInterval(timer);
    timer = null;
    if (!theme) return;
    var moving = theme.motion === 'animated' && !(still && still.matches) && !document.hidden;
    if (!moving) return paintTop(theme.top);
    timer = setInterval(function () { paintTop(at(theme.stops, Date.now() - start)); }, STEP);
  }

  function apply(next) {
    if (!next || !next.top) return;
    theme = next;
    current = null;
    if (paintPage) root.style.backgroundColor = next.bottom;
    root.style.setProperty('--bar-top', next.top);
    root.style.setProperty('--bar-bottom', next.bottom);
    root.dataset.barTheme = next.id;
    if (paintPage && document.body) document.body.style.backgroundColor = next.bottom;
    animate();
  }

  function check() {
    if (!window.fetch) return;
    fetch('/api/v1/theme', { cache: 'no-store', credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d) return;
        if (JSON.stringify(d.theme) !== JSON.stringify(theme)) {
          apply(d.theme);
          store(d.theme);
        }
        if (build === null) build = d.build;
        else if (d.build !== build) reloadPending = true;
      })
      .catch(function () { /* offline: keep what we have */ });
  }

  // Somebody else (Flutter's engine) wrote a theme-color: put ours back.
  function guard() {
    if (!window.MutationObserver) return;
    new MutationObserver(function () {
      if (!theme) return;
      var want = current;
      current = null;
      paintTop(want || theme.top);
    }).observe(document.head, { childList: true, subtree: true, attributes: true, attributeFilter: ['content'] });
  }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) return animate();
    if (reloadPending) return location.reload();
    animate();
    check();
  });
  window.addEventListener('focus', check);
  window.addEventListener('pageshow', check);
  window.addEventListener('flutter-first-frame', function () { apply(theme); });
  if (still && still.addEventListener) still.addEventListener('change', animate);
  if (!document.body) document.addEventListener('DOMContentLoaded', function () { apply(theme); });

  apply(stored() || {
    id: 'metric', top: '#002788', stops: ['#002788', '#00144D', '#1D3FA8'], bottom: '#002788', dark: true, motion: 'animated',
  });
  guard();
  check();
  setInterval(check, POLL);

  window.MetricTheme = { apply: apply, check: check };
})();
