/*
 * Vesopa cookie notice — one script for every Vesopa website.
 *
 * Source of truth: shared/cookie-notice/. Each site serves its own copy
 * (shared/cookie-notice/sync.sh puts them in place), so no site depends on
 * another one being up. Include it once, from the site's own origin:
 *
 *   <script src="/vesopa-cookies.js" defer></script>
 *
 * It loads vesopa-cookies.css from the same folder, so it works under the
 * strict Content-Security-Policy on auth.vesopa.com (no inline script or
 * style anywhere).
 *
 * What it does
 *   - First visit: the choice is recorded straight away (auto-accepted) and a
 *     small notice slides up from the bottom, then hides itself after a few
 *     seconds. Hovering or focusing it pauses the countdown.
 *   - Every later visit: nothing is shown.
 *   - The choice is remembered twice: a first-party cookie on the parent
 *     domain (so every *.vesopa.com site — cloud, auth, mail, pay — shares
 *     one answer, and www/non-www share it too), and localStorage.
 *
 * What it does not do
 *   vesopaepos.com, vesopasoftware.com and vesopa.com are different domains.
 *   Browsers do not let one domain read another's cookies, and third-party
 *   storage is partitioned, so each of those remembers on its own. Each still
 *   only ever shows the notice once.
 *
 * The law, briefly (UK GDPR / PECR)
 *   Strictly necessary cookies need no consent, and the cookie that stores
 *   this choice is one of them. Analytics and marketing need an opt-in, so
 *   auto-accepting means "essential cookies accepted"; the optional switches
 *   stay off until somebody turns them on in Settings. No Vesopa site loads
 *   anything optional today. Anything added later hangs off the event:
 *
 *     document.addEventListener('vesopa:consent', function (e) {
 *       if (e.detail.analytics) { ...load the tag... }
 *     });
 *
 *   `window.vesopaConsent` holds the current answer for code that runs late.
 *
 * Opening the settings again
 *   Any element with data-cc="open", data-vesopa-cookies, or href="#cookie-settings"
 *   opens the settings, as does window.VesopaCookies.open().
 *
 * Per-site options, as attributes on the <script> tag:
 *   data-policy="/cookies"   link to the site's cookie policy (default /cookies)
 *   data-hide-after="8"      seconds before the notice hides (default 8)
 *   data-position="left"     left | center | right on wide screens (default left)
 */
(function () {
  'use strict';

  if (window.VesopaCookies) return; // included twice — keep the first

  var VERSION = 1;               // bump to ask everyone again
  var COOKIE = 'vesopa_consent';
  var KEY = 'vesopa_cookie_consent'; // the key vesopaepos.com has always used
  var MAX_AGE_S = 365 * 24 * 60 * 60;
  var NS = 'http://www.w3.org/2000/svg';

  var me = document.currentScript;
  var opt = function (name, fallback) {
    var v = me && me.getAttribute('data-' + name);
    return v == null || v === '' ? fallback : v;
  };
  var POLICY = opt('policy', '/cookies');
  var HIDE_AFTER = Math.max(3, parseFloat(opt('hide-after', '8')) || 8) * 1000;
  var POSITION = opt('position', 'left');
  var CSS = me && me.src ? me.src.replace(/vesopa-cookies\.js/, 'vesopa-cookies.css') : '/vesopa-cookies.css';

  // ---- storage --------------------------------------------------------------

  /** The cookie goes on the registrable domain: vesopa.com for cloud.vesopa.com. */
  function baseDomain() {
    var h = location.hostname;
    if (!h || h === 'localhost' || /^[\d.]+$/.test(h) || h.indexOf(':') >= 0) return '';
    var p = h.split('.');
    if (p.length <= 2) return h;
    var two = p.slice(-2).join('.');
    // vesopa.co.uk and friends: the public suffix is two labels.
    if (/^(co|org|ac|gov|net|ltd|plc|me)\.[a-z]{2}$/.test(two)) return p.slice(-3).join('.');
    return two;
  }

  function normal(c) {
    if (!c || c.version !== VERSION) return null;
    var at = +c.at || 0;
    if (Date.now() - at > MAX_AGE_S * 1000) return null; // older than a year: ask again
    return { version: VERSION, at: at, analytics: !!c.analytics, marketing: !!c.marketing };
  }

  function readCookie() {
    var m = document.cookie.match(/(?:^|;\s*)vesopa_consent=([^;]*)/);
    if (!m) return null;
    // v1.a0.m0.<seconds>
    var p = decodeURIComponent(m[1]).split('.');
    if (p.length !== 4 || p[0] !== 'v' + VERSION) return null;
    return normal({ version: VERSION, analytics: p[1] === 'a1', marketing: p[2] === 'm1', at: (+p[3] || 0) * 1000 });
  }

  function readLocal() {
    try { return normal(JSON.parse(localStorage.getItem(KEY) || 'null')); }
    catch (e) { return null; }
  }

  function write(c) {
    var v = ['v' + VERSION, c.analytics ? 'a1' : 'a0', c.marketing ? 'm1' : 'm0', Math.floor(c.at / 1000)].join('.');
    var d = baseDomain();
    document.cookie = COOKIE + '=' + v + '; Max-Age=' + MAX_AGE_S + '; Path=/' +
      (d ? '; Domain=' + d : '') + '; SameSite=Lax' + (location.protocol === 'https:' ? '; Secure' : '');
    try { localStorage.setItem(KEY, JSON.stringify(c)); } catch (e) { /* the cookie still holds it */ }
  }

  function read() {
    var a = readCookie(), b = readLocal();
    var best = a && b ? (a.at >= b.at ? a : b) : (a || b);
    // Copy whichever one survived into the other, so clearing one store or
    // moving between www and the bare domain never brings the notice back.
    if (best && (!a || !b || a.analytics !== b.analytics || a.marketing !== b.marketing)) write(best);
    return best;
  }

  // ---- applying -------------------------------------------------------------

  var startedSomething = false;
  function apply(c, interactive) {
    var before = window.vesopaConsent;
    window.vesopaConsent = c;
    document.dispatchEvent(new CustomEvent('vesopa:consent', { detail: c }));
    // Withdrawal has to stop what is already running, and a loaded script
    // cannot be un-run, so turning something off reloads the page.
    if (interactive && before && ((before.analytics && !c.analytics) || (before.marketing && !c.marketing)) && startedSomething) {
      location.reload();
    }
  }

  // ---- building the UI (DOM only: nothing inline for a CSP to block) --------

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  }
  function svg(paths, cls) {
    var s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('aria-hidden', 'true');
    s.setAttribute('focusable', 'false');
    if (cls) s.setAttribute('class', cls);
    paths.forEach(function (d) {
      var p = document.createElementNS(NS, d.c ? 'circle' : 'path');
      if (d.c) { p.setAttribute('cx', d.c[0]); p.setAttribute('cy', d.c[1]); p.setAttribute('r', d.c[2]); }
      else p.setAttribute('d', d);
      s.appendChild(p);
    });
    return s;
  }
  var ICON_COOKIE = [
    'M12 3a9 9 0 1 0 9 9 3.2 3.2 0 0 1-3.6-3.3A3.2 3.2 0 0 1 14.6 5 3 3 0 0 1 12 3z',
    { c: [8.5, 10, 1.1] }, { c: [9.5, 15.2, 1.1] }, { c: [14.6, 14, 1.1] }
  ];
  var ICON_CHECK = ['M5 12.5l4.2 4.2L19 7'];
  var ICON_CLOSE = ['M6 6l12 12M18 6L6 18'];

  var root, toast, bar, panel, boxA, boxM, timer = null, left = HIDE_AFTER, startedAt = 0, lastFocus = null;

  function cssReady(cb) {
    // A page may link the stylesheet itself (so its own asset versioning
    // stamps the URL); otherwise it is fetched from beside this script.
    var have = document.querySelector('link[data-vesopa-cookies-css],link[href*="vesopa-cookies.css"]');
    if (have) {
      if (have.sheet) return cb();
      have.addEventListener('load', cb);
      return setTimeout(function () { if (have.sheet) cb(); }, 1500);
    }
    var l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = CSS;
    l.setAttribute('data-vesopa-cookies-css', '');
    var done = false, go = function () { if (!done) { done = true; cb(); } };
    l.onload = go; l.onerror = function () { done = true; /* no stylesheet, no notice */ };
    document.head.appendChild(l);
    setTimeout(function () { if (l.sheet) go(); }, 1500);
  }

  function build() {
    if (root) return;
    root = el('div', 'vck vck-' + (POSITION === 'center' || POSITION === 'right' ? POSITION : 'left'));
    root.setAttribute('data-vesopa-cookie-root', '');

    // The toast.
    toast = el('div', 'vck-toast');
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    var badge = el('span', 'vck-badge');
    badge.appendChild(svg(ICON_COOKIE, 'vck-i-cookie'));
    var tick = el('span', 'vck-tick');
    tick.appendChild(svg(ICON_CHECK));
    badge.appendChild(tick);
    var copy = el('span', 'vck-copy');
    copy.appendChild(el('b', '', 'Cookies accepted'));
    copy.appendChild(el('span', 'vck-sub', 'Only essential cookies. No tracking.'));
    var settings = el('button', 'vck-link', 'Settings');
    settings.type = 'button';
    settings.addEventListener('click', function () { open(); });
    var close = el('button', 'vck-x');
    close.type = 'button';
    close.setAttribute('aria-label', 'Hide this notice');
    close.appendChild(svg(ICON_CLOSE));
    close.addEventListener('click', hideToast);
    bar = el('i', 'vck-bar');
    toast.appendChild(badge); toast.appendChild(copy); toast.appendChild(settings); toast.appendChild(close); toast.appendChild(bar);

    ['mouseenter', 'focusin'].forEach(function (t) { toast.addEventListener(t, pause); });
    // After the event, so focus has actually left by the time resume() looks.
    ['mouseleave', 'focusout'].forEach(function (t) { toast.addEventListener(t, function () { setTimeout(resume, 0); }); });

    // The settings panel.
    panel = el('div', 'vck-panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'false');
    panel.setAttribute('aria-labelledby', 'vck-title');
    panel.hidden = true;
    var head = el('div', 'vck-head');
    var h = el('h2', 'vck-title', 'Cookie settings');
    h.id = 'vck-title';
    var px = el('button', 'vck-x');
    px.type = 'button';
    px.setAttribute('aria-label', 'Close cookie settings');
    px.appendChild(svg(ICON_CLOSE));
    px.addEventListener('click', closePanel);
    head.appendChild(h); head.appendChild(px);
    panel.appendChild(head);
    panel.appendChild(el('p', 'vck-lead', 'One choice for every Vesopa site on this domain. Change it whenever you like.'));

    function row(title, desc, locked) {
      var r = el('label', 'vck-row');
      var t = el('span', 'vck-row-t');
      t.appendChild(el('b', '', title));
      t.appendChild(el('span', '', desc));
      r.appendChild(t);
      if (locked) { r.appendChild(el('span', 'vck-on', 'Always on')); return { row: r }; }
      var sw = el('span', 'vck-sw');
      var box = el('input');
      box.type = 'checkbox';
      sw.appendChild(box); sw.appendChild(el('i'));
      r.appendChild(sw);
      return { row: r, box: box };
    }
    panel.appendChild(row('Essential', 'Sign-in, security, your basket and this choice.', true).row);
    var ra = row('Analytics', 'Anonymous counts of which pages are used.');
    var rm = row('Marketing & support', 'Live chat and campaign measurement.');
    boxA = ra.box; boxM = rm.box;
    panel.appendChild(ra.row); panel.appendChild(rm.row);
    panel.appendChild(el('p', 'vck-note', 'We run no analytics or marketing cookies today. These switches decide it if we ever do.'));

    var acts = el('div', 'vck-acts');
    var policy = el('a', 'vck-policy', 'Cookie policy');
    policy.href = POLICY;
    var save = el('button', 'vck-btn', 'Save');
    save.type = 'button';
    save.addEventListener('click', function () {
      var c = { version: VERSION, at: Date.now(), analytics: boxA.checked, marketing: boxM.checked };
      write(c); apply(c, true); closePanel();
    });
    acts.appendChild(policy); acts.appendChild(save);
    panel.appendChild(acts);

    root.appendChild(panel);
    root.appendChild(toast);
    toast.hidden = true;
    document.body.appendChild(root);
  }

  // ---- toast timing ---------------------------------------------------------

  function showToast(tries) {
    // A page still behind its loading cover (vesopasoftware.com has one) gets
    // the notice once the cover lifts, not on top of it.
    tries = tries || 0;
    if (document.documentElement.classList.contains('loading') && tries < 30) {
      return setTimeout(function () { showToast(tries + 1); }, 500);
    }
    build();
    toast.hidden = false;
    left = HIDE_AFTER;
    bar.style.animationDuration = HIDE_AFTER + 'ms';
    // next frame, so the slide-in transition runs
    requestAnimationFrame(function () { requestAnimationFrame(function () { root.classList.add('vck-in'); }); });
    resume();
  }
  function pause() {
    if (!timer) return;
    clearTimeout(timer); timer = null;
    left -= Date.now() - startedAt;
    root.classList.add('vck-paused');
  }
  function resume() {
    if (timer || toast.hidden) return;
    if (toast.contains(document.activeElement) || toast.matches(':hover')) return;
    root.classList.remove('vck-paused');
    startedAt = Date.now();
    timer = setTimeout(hideToast, Math.max(400, left));
  }
  function hideToast() {
    clearTimeout(timer); timer = null;
    if (!root) return;
    root.classList.add('vck-out');
    setTimeout(function () {
      toast.hidden = true;
      root.classList.remove('vck-in', 'vck-out', 'vck-paused');
    }, 420);
  }

  // ---- panel ----------------------------------------------------------------

  function open() {
    cssReady(function () {
      build();
      var c = read() || { analytics: false, marketing: false };
      boxA.checked = !!c.analytics; boxM.checked = !!c.marketing;
      if (!toast.hidden) hideToast();
      lastFocus = document.activeElement;
      panel.hidden = false;
      requestAnimationFrame(function () { panel.classList.add('vck-open'); });
      var first = panel.querySelector('input');
      if (first) first.focus();
    });
  }
  function closePanel() {
    if (!panel || panel.hidden) return;
    panel.classList.remove('vck-open');
    setTimeout(function () { panel.hidden = true; }, 220);
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  document.addEventListener('click', function (e) {
    var t = e.target && e.target.closest && e.target.closest('[data-cc="open"],[data-vesopa-cookies],a[href="#cookie-settings"]');
    if (!t) return;
    e.preventDefault();
    open();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && panel && !panel.hidden) closePanel();
  });

  window.VesopaCookies = {
    open: open,
    get: read,
    /** Call when something optional has been started, so withdrawing reloads. */
    started: function () { startedSomething = true; }
  };

  // ---- boot -----------------------------------------------------------------

  function boot() {
    var c = read();
    if (c) return apply(c, false);
    // First visit: accept the essentials now and say so, briefly.
    c = { version: VERSION, at: Date.now(), analytics: false, marketing: false };
    write(c);
    apply(c, false);
    cssReady(function () { setTimeout(function () { showToast(0); }, 900); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
