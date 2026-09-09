/*
 * The line across the top that says something is happening.
 *
 * The same one the EPOS back office uses, and deliberately so: a person who
 * moves between the back office and their Vesopa account should not have to
 * learn a second vocabulary for "wait".
 *
 * IT CREEPS RATHER THAN REPORTING A PERCENTAGE, because there is no percentage
 * to report — nothing has said how much there is. What it is actually for is
 * the first two hundred milliseconds: the gap between a press and anything
 * changing, which on a slow connection is the whole of "it did not respond".
 *
 * WHY THIS MATTERS MORE ON A SIGN-IN PAGE THAN ANYWHERE ELSE. Pressing Log in
 * sends an email, and sending an email is slow — a second, sometimes three. In
 * that silence people press the button again, and the second press is a second
 * challenge, a second rate-limit count, and a code in their inbox that is not
 * the one on their screen. The bar, and the button going quiet underneath it,
 * are what stop that.
 *
 * Loaded before nav.js and used by it. Everything here is optional: with the
 * script blocked, every link is still a link and every form still posts.
 */
(function () {
  'use strict';

  /*
   * ONCE PER DOCUMENT, NOT ONCE PER NAVIGATION.
   *
   * The no-reload router replaces the body and re-creates every
   * `script[src]` in it, because a script inserted with innerHTML never
   * runs. That is correct for a page's own setup and wrong for anything
   * that binds to `document`: without this flag a listener here is added
   * again on every navigation, and after five links a single click is
   * handled five times — five fetches, five copies, five bars.
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
        /*
         * Not announced. A progress bar that a screen reader reads out on every
         * link is noise, and the router already moves focus to the new heading,
         * which is the announcement that carries the meaning.
         */
        el.setAttribute('aria-hidden', 'true');
        /*
         * On <html>, not on <body>.
         *
         * The no-reload router replaces `document.body.innerHTML` wholesale, so
         * a bar appended to the body is destroyed mid-navigation — exactly when
         * it is meant to be visible. It is recreated on the next start, so
         * nothing is broken for long, but the fade-out never happens and the
         * page it was describing arrives with no acknowledgement at all.
         * <html> survives the swap.
         */
        document.documentElement.appendChild(el);
      }
    }
    return el;
  }

  /** Idempotent: a second start while one is running is ignored, not restarted. */
  function start() {
    if (running) return;
    running = true;
    var bar = node();
    clearInterval(timer);
    at = 8;
    bar.classList.add('on');
    bar.style.width = '8%';
    // Slower the further it gets, so it never reaches the end on its own and
    // never has to go backwards.
    timer = setInterval(function () {
      at += Math.max(0.4, (92 - at) / 14);
      if (at > 92) at = 92;
      bar.style.width = at + '%';
    }, 220);
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

  // -------------------------------------------------------------------------
  // The navigations the router does not handle
  // -------------------------------------------------------------------------
  //
  // nav.js drives the bar for the links it intercepts. Everything else is a
  // real browser navigation — and those are the SLOW ones: a form that sends an
  // email, a hand-off to Google, an OAuth authorize round trip. They are
  // precisely where the silence is longest and the feedback matters most.

  /**
   * Any form submission.
   *
   * Capture phase, so the bar starts before a page's own handler has a chance
   * to be slow, and `defaultPrevented` is re-checked afterwards: a handler that
   * cancels the submit (the passkey button, say) has not navigated anywhere and
   * must not leave a bar running for ever.
   */
  document.addEventListener(
    'submit',
    function (event) {
      var form = event.target;
      if (!form || form.hasAttribute('data-no-loadbar')) return;
      start();
      setTimeout(function () {
        if (event.defaultPrevented) done();
      }, 0);

      /*
       * The button goes quiet with it.
       *
       * NOT `disabled` — a disabled submit button is not sent with the form, so
       * a form whose handler reads which button was pressed silently loses it.
       * `aria-disabled` plus pointer-events tells assistive technology and stops
       * the second press, and the value still travels.
       */
      var button = form.querySelector('button[type="submit"], button:not([type])');
      if (button && !button.hasAttribute('data-keep-label')) {
        button.setAttribute('aria-disabled', 'true');
        button.classList.add('is-working');
      }
    },
    true
  );

  /**
   * A link the router will not take: another origin, or one of the protocol
   * paths it deliberately leaves alone — `/auth/google` hands off to Google,
   * and that hand-off is the longest wait on the whole site.
   */
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
    /*
     * A link to the page we are already on is not a navigation — neither the
     * fragment version nor the exact same URL, which the router also ignores.
     * Starting a bar that nothing will ever finish is worse than no bar.
     */
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
   * A page restored from the back/forward cache is shown exactly as it was left
   * — which, if the person pressed Log in and then pressed Back, is a page with
   * a bar frozen at 60% and a button that will not respond. `pageshow` fires on
   * that restore, and clearing the state there is what makes Back work.
   */
  window.addEventListener('pageshow', function () {
    running = true;
    done();
    var working = document.querySelectorAll('.is-working');
    for (var i = 0; i < working.length; i += 1) {
      working[i].classList.remove('is-working');
      working[i].removeAttribute('aria-disabled');
    }
  });
})();
