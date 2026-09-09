/*
 * "Show the password" — the eye at the right-hand end of every password box.
 *
 * WHY IT IS WORTH HAVING ON A SIGN-IN PAGE AT ALL. A password field on a phone
 * is eleven dots and a soft keyboard that autocorrects, and the commonest
 * reason somebody is told their password is wrong is that they can see they
 * typed it and cannot see WHAT they typed. Every platform's own sign-in has
 * this; ours did not, and the owner asked for it by name.
 *
 * THE BUTTON IS BUILT HERE RATHER THAN IN THE TEMPLATE, and that is the point:
 * there are password fields on the sign-in step, the security page and the
 * confirmation page, and a control added to one template is a control missing
 * from the other two. Anything that is `input[type="password"]` gets it, once.
 *
 * PROGRESSIVE. With this script blocked the field is exactly what it was —
 * there is no markup to leave behind and nothing to look broken.
 *
 * IT NEVER REMEMBERS. Revealing lasts until the field loses focus or the form
 * is submitted; nothing is stored, and a page restored from the back/forward
 * cache comes back hidden. A password left legible on a counter till, or on a
 * phone handed to somebody, is the failure this feature could introduce, and
 * the only defence is that it does not persist.
 */
(function () {
  'use strict';

  if (window.__vesopaRevealReady) return;
  window.__vesopaRevealReady = true;

  var SHOW = 'Show password';
  var HIDE = 'Hide password';

  // Drawn rather than fetched: two small paths cost nothing, cannot 404, and
  // are the same in both colour schemes because they inherit currentColor.
  var EYE =
    '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
    '<path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12Z" ' +
    'stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<circle cx="12" cy="12" r="3.1" stroke="currentColor" stroke-width="1.7"/></svg>';
  var EYE_OFF =
    '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
    '<path d="M9.9 5.9A9.6 9.6 0 0 1 12 5.8c6 0 9.5 6.2 9.5 6.2a17 17 0 0 1-3.3 4M6.2 7.6A17 17 0 0 0 2.5 12S6 18.2 12 18.2c1.4 0 2.6-.3 3.7-.8" ' +
    'stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<path d="M4 4l16 16" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';

  function decorate(input) {
    if (input.getAttribute('data-reveal-ready') !== null) return;
    input.setAttribute('data-reveal-ready', '');

    /*
     * The button is placed inside whatever wrapper the field already has —
     * `.float-field` on the sign-in step, `.field` elsewhere — because both are
     * `position: relative` and neither needs a new element around the input.
     * Where there is no wrapper we leave the field alone rather than
     * restructuring somebody's markup from JavaScript.
     */
    var wrap = input.closest('.float-field, .field');
    if (!wrap) return;

    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'reveal';
    button.innerHTML = EYE;
    button.setAttribute('aria-label', SHOW);
    button.setAttribute('title', SHOW);
    // Not in the tab order: somebody tabbing through a sign-in form wants the
    // next field, not a control that shows their password to the room.
    button.tabIndex = -1;

    var showing = false;
    var set = function (on) {
      showing = on;
      input.type = on ? 'text' : 'password';
      button.innerHTML = on ? EYE_OFF : EYE;
      button.setAttribute('aria-label', on ? HIDE : SHOW);
      button.setAttribute('title', on ? HIDE : SHOW);
      button.classList.toggle('is-showing', on);
    };

    button.addEventListener('click', function (event) {
      event.preventDefault();
      var at = input.selectionStart;
      var to = input.selectionEnd;
      set(!showing);
      input.focus();
      // Changing `type` moves the caret to the end on most browsers, which on a
      // half-typed password is worse than not being able to see it.
      try {
        input.setSelectionRange(at, to);
      } catch (e) {
        /* A field that does not support selection is not worth an error. */
      }
    });

    var hide = function () {
      if (showing) set(false);
    };
    input.addEventListener('blur', function () {
      // A moment, so pressing the button does not count as leaving the field.
      setTimeout(function () {
        if (document.activeElement !== input && document.activeElement !== button) hide();
      }, 0);
    });
    if (input.form) input.form.addEventListener('submit', hide);

    wrap.appendChild(button);
    wrap.classList.add('has-reveal');
  }

  function sweep() {
    var fields = document.querySelectorAll('input[type="password"]');
    for (var i = 0; i < fields.length; i += 1) decorate(fields[i]);
  }

  sweep();

  /*
   * Run again after the router swaps a page in. This script is re-created with
   * the rest of a page's `script[src]`, but the guard at the top stops it
   * binding twice — so the swept fields on the NEW page would never be
   * decorated without this.
   */
  window.addEventListener('vesopa:navigated', sweep);
  window.addEventListener('pageshow', sweep);
})();
