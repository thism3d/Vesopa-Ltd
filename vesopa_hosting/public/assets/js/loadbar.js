/*
 * The line across the top that says something is happening.
 *
 * The same one auth.vesopa.com and the EPOS back office draw, and deliberately
 * so: a person who moves between their Vesopa account and their hosting panel
 * should not have to learn a second vocabulary for "wait".
 *
 * IT CREEPS RATHER THAN REPORTING A PERCENTAGE, because there is no percentage
 * to report — nothing has said how much there is. What it is actually for is
 * the first two hundred milliseconds: the gap between a press and anything
 * changing, which on hotel wifi is the whole of "it did not respond".
 *
 * The buttons themselves are NOT handled here. app.js (`data-guard`) and
 * panel.js already put a pressed button into `.is-working`, and two scripts
 * fighting over one button is how a spinner ends up drawn twice.
 *
 * Loaded before nav.js and used by it. Everything here is optional: with the
 * script blocked, every link is still a link and every form still posts.
 */
(function () {
  'use strict';

  /*
   * ONCE PER DOCUMENT, NOT ONCE PER NAVIGATION.
   *
   * The no-reload router re-creates the page's `script[src]` elements when it
   * swaps the body. Without this flag a listener here would be added again on
   * every navigation, and after five links one click would start five bars.
   */
  if (window.__vesopaLoadbarReady) return;
  window.__vesopaLoadbarReady = true;

  var el = null;
  var timer = null;
  var at = 0;
  var running = false;

  function node() {
    if (!el || !el.isConnected) {
      el = document.getElementById('loadbar');
      if (!el) {
        el = document.createElement('div');
        el.id = 'loadbar';
        // Not announced: a bar a screen reader read out on every link would be
        // noise, and the router already moves focus to the new heading.
        el.setAttribute('aria-hidden', 'true');
        // On <html>, not <body>: the router replaces the body wholesale, and a
        // bar living there would be destroyed mid-navigation.
        document.documentElement.appendChild(el);
      }
    }
    return el;
  }

  function creep(bar) {
    clearInterval(timer);
    // Slower the further it gets, so it never reaches the end on its own and
    // never has to go backwards.
    timer = setInterval(function () {
      at += Math.max(0.4, (92 - at) / 14);
      if (at > 92) at = 92;
      bar.style.width = at + '%';
    }, 220);
  }

  /** Idempotent: a second start while one is running is ignored, not restarted. */
  function start() {
    if (running) return;
    running = true;
    var bar = node();
    at = 8;
    bar.classList.add('on');
    bar.style.width = '8%';
    creep(bar);
  }

  function done() {
    if (!running) return;
    running = false;
    var bar = node();
    clearInterval(timer);
    bar.style.width = '100%';
    setTimeout(function () {
      bar.classList.remove('on');
      // Reset only once it has faded, or the next start jumps in from the right.
      setTimeout(function () { bar.style.width = '0'; }, 260);
    }, 160);
  }

  window.VesopaLoadbar = { start: start, done: done };

  /*
   * ADOPT THE BAR THE HEAD STARTED, and finish it when the page has arrived.
   *
   * The head puts the element on screen before first paint (partials/head.ejs).
   * By the time this file runs the markup is there and the stylesheets, fonts
   * and pictures usually are not — so there is still a real wait to describe.
   * Picked up from where the head left it rather than start()ed, because
   * start() resets to 8% and would visibly snap the bar backwards.
   */
  if (document.readyState !== 'complete') {
    var early = document.getElementById('loadbar');
    if (early && early.classList.contains('on')) {
      running = true;
      el = early;
      at = parseFloat(early.style.width) || 10;
      creep(early);
    }
    window.addEventListener('load', function () { done(); }, { once: true });
  }

  // -------------------------------------------------------------------------
  // The navigations the router does not handle
  // -------------------------------------------------------------------------
  //
  // nav.js drives the bar for what it intercepts. Everything else is a real
  // browser navigation — and those are the SLOW ones: the hand-off to
  // auth.vesopa.com, a checkout leaving for the payment gateway. They are
  // precisely where the silence is longest and the feedback matters most.

  document.addEventListener(
    'submit',
    function (event) {
      var form = event.target;
      if (!form || form.hasAttribute('data-no-loadbar')) return;
      start();
      // A handler that cancels the submit has not navigated anywhere and must
      // not leave a bar running for ever.
      setTimeout(function () {
        if (event.defaultPrevented) done();
      }, 0);
    },
    true
  );

  document.addEventListener('click', function (event) {
    if (event.defaultPrevented) return;
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

    var link = event.target.closest ? event.target.closest('a') : null;
    if (!link || !link.href) return;
    if (link.target && link.target !== '_self') return;
    if (link.hasAttribute('download')) return;
    if (link.hasAttribute('data-no-loadbar')) return;

    var url;
    try {
      url = new URL(link.href, window.location.href);
    } catch (e) {
      return;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
    // A link to the page we are already on is not a navigation, and starting
    // a bar that nothing will ever finish is worse than no bar.
    if (
      url.origin === window.location.origin &&
      url.pathname === window.location.pathname &&
      url.search === window.location.search
    ) {
      return;
    }
    start();
  });

  /*
   * Coming back.
   *
   * A page restored from the back/forward cache is shown exactly as it was
   * left — a bar frozen at 60% if the person pressed something and then Back.
   * `pageshow` fires on that restore, and clearing the state there is what
   * makes Back work.
   */
  window.addEventListener('pageshow', function () {
    running = true;
    done();
  });
})();
