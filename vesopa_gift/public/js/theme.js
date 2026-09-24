/* Vesopa Gift — Day, Night, or whatever the device is set to.
 *
 * The back office's own switch (vesopa_server/public/app.js), key for key:
 * a data-theme attribute on <html> that every colour in the stylesheet is
 * expressed against, read out of localStorage before the page paints so a
 * Night page never flashes white. One round button shows the CHOICE (Auto is a
 * choice too); it opens a small menu of the three. */
(function () {
  'use strict';
  var KEY = 'vesopa.theme';
  var root = document.documentElement;

  function read() {
    try {
      var stored = localStorage.getItem(KEY);
      return stored === 'light' || stored === 'dark' ? stored : 'system';
    } catch (e) { return 'system'; }
  }

  function apply(choice) {
    if (choice === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', choice);
    var meta = document.querySelector('meta[name="color-scheme"]');
    if (meta) meta.setAttribute('content', choice === 'system' ? 'light dark' : choice);
    var items = document.querySelectorAll('[data-theme-set]');
    for (var i = 0; i < items.length; i++) {
      var on = items[i].getAttribute('data-theme-set') === choice;
      items[i].setAttribute('aria-checked', on ? 'true' : 'false');
    }
  }

  function set(choice) {
    try {
      if (choice === 'system') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, choice);
    } catch (e) { /* not remembered, still applied */ }
    apply(choice);
  }

  function closeMenus() {
    var corners = document.querySelectorAll('.theme-corner');
    for (var i = 0; i < corners.length; i++) {
      var menu = corners[i].querySelector('.theme-menu');
      var btn = corners[i].querySelector('.theme-btn');
      if (menu) menu.hidden = true;
      if (btn) btn.setAttribute('aria-expanded', 'false');
    }
  }

  apply(read());
  window.vgTheme = { set: set, get: read };

  document.addEventListener('DOMContentLoaded', function () {
    apply(read());
    document.addEventListener('click', function (e) {
      var t = e.target;
      var pick = t.closest && t.closest('[data-theme-set]');
      if (pick) { set(pick.getAttribute('data-theme-set')); closeMenus(); return; }
      var toggle = t.closest && t.closest('.theme-btn');
      if (toggle) {
        var menu = toggle.parentNode.querySelector('.theme-menu');
        var open = menu && menu.hidden;
        closeMenus();
        if (menu && open) { menu.hidden = false; toggle.setAttribute('aria-expanded', 'true'); }
        return;
      }
      if (!(t.closest && t.closest('.theme-corner'))) closeMenus();
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeMenus(); });
  });
})();
