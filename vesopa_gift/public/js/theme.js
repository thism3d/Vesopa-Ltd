/* Vesopa Gift — light, dark, or the device's own setting.
 *
 * Loaded in the head, before the page paints, so a dark page never flashes
 * white. The choice lives in this browser (localStorage): "system" means no
 * attribute, and the stylesheets follow prefers-color-scheme; "light" and
 * "dark" set data-theme on <html>, which the stylesheets obey over the device.
 *
 * Any element with data-theme-pick="light|dark|system" becomes a switch. */
(function () {
  'use strict';
  var KEY = 'vg_theme';
  var root = document.documentElement;

  function read() {
    try { return localStorage.getItem(KEY) || 'system'; } catch (e) { return 'system'; }
  }
  function apply(mode) {
    if (mode === 'light' || mode === 'dark') root.setAttribute('data-theme', mode);
    else root.removeAttribute('data-theme');
    var meta = document.querySelector('meta[name="color-scheme"]');
    if (meta) meta.setAttribute('content', mode === 'system' ? 'light dark' : mode);
    paint(mode);
  }
  function paint(mode) {
    var picks = document.querySelectorAll('[data-theme-pick]');
    for (var i = 0; i < picks.length; i++) {
      var on = picks[i].getAttribute('data-theme-pick') === mode;
      picks[i].classList.toggle('on', on);
      picks[i].setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }
  function set(mode) {
    try { localStorage.setItem(KEY, mode); } catch (e) { /* private mode: it lasts the page */ }
    apply(mode);
  }

  apply(read());
  window.vgTheme = { set: set, get: read };

  document.addEventListener('DOMContentLoaded', function () {
    paint(read());
    document.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('[data-theme-pick]');
      if (b) set(b.getAttribute('data-theme-pick'));
    });
  });
})();
