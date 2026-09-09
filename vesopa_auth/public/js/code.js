/*
 * The six-box code field.
 *
 * WHAT IT LOOKS LIKE: six separate boxes that fill one at a time, the next one
 * lit and waiting, the way Apple's sign-in does it.
 *
 * WHAT IT ACTUALLY IS: one ordinary text input, stretched across all six boxes
 * with its text and caret made invisible. The boxes are spans underneath, and
 * this file copies each character into one.
 *
 * WHY, AND IT IS NOT A SHORTCUT. Six real inputs is the obvious build and it
 * breaks four things that matter more than the animation:
 *
 *   AUTOFILL. `autocomplete="one-time-code"` is what makes iOS and Android
 *   offer the code straight from the notification — the fastest way anybody
 *   ever enters one. It fills a single field. Across six it does nothing, and
 *   the feature people actually use is gone to make the field look nicer.
 *
 *   PASTE. Somebody copying a code from their email pastes six characters. A
 *   single input takes them. Six inputs take one and drop five, and the
 *   fix-ups people write for that are where the bugs live.
 *
 *   SCREEN READERS announce six unlabelled boxes and no field.
 *
 *   PASSWORD MANAGERS fight the focus juggling.
 *
 * So the input stays one field and the DECORATION is six boxes. Everything
 * below is presentation; with this script blocked the input is still a normal,
 * working, labelled text field, which is the whole test of whether the trick
 * is safe.
 */
(function () {
  'use strict';

  function setup(wrap) {
    var input = wrap.querySelector('.code-real');
    var boxes = wrap.querySelectorAll('.code-box');
    if (!input || !boxes.length) return;

    var size = boxes.length;

    function paint() {
      // Digits only, and never more than there are boxes. Typing over a full
      // field should do nothing rather than silently scroll hidden text.
      var value = input.value.replace(/\D/g, '').slice(0, size);
      if (value !== input.value) input.value = value;

      for (var i = 0; i < size; i += 1) {
        var box = boxes[i];
        box.textContent = value[i] || '';
        box.classList.toggle('is-filled', Boolean(value[i]));
        /*
         * The lit box is where the next character goes. When the field is
         * full there is no next one, so nothing is lit — a box that stays lit
         * on a complete code reads as "still waiting" when it is not.
         */
        box.classList.toggle(
          'is-active',
          document.activeElement === input && i === value.length && value.length < size
        );
      }

      wrap.classList.toggle('is-complete', value.length === size);

      /*
       * Submit itself when the last digit lands.
       *
       * The point of the whole component: nobody should have to reach for a
       * button after typing the sixth digit of a code they were just shown.
       * `requestSubmit` rather than `submit` so validation and any submit
       * handler still run — `form.submit()` skips both, which would step over
       * the captcha handler that mints a token on the way out.
       */
      if (value.length === size && !wrap.dataset.sent) {
        wrap.dataset.sent = '1';
        var form = input.form;
        if (form) {
          if (form.requestSubmit) form.requestSubmit();
          else form.submit();
        }
      }
      // Anything less than complete re-arms it, so a correction can resubmit.
      if (value.length < size) delete wrap.dataset.sent;
    }

    input.addEventListener('input', paint);
    input.addEventListener('focus', paint);
    input.addEventListener('blur', paint);
    input.addEventListener('keyup', paint);
    // A click anywhere on the boxes belongs to the input underneath.
    wrap.addEventListener('click', function () { input.focus(); });

    paint();

    /*
     * Focus, on arrival.
     *
     * `autofocus` alone is unreliable here: this page is often reached by a
     * redirect after posting a form, and Chrome drops autofocus on a navigation
     * it considers script-initiated. Asking again on the next frame costs
     * nothing and is the difference between typing straight away and having to
     * tap the field first.
     *
     * Not on a touch device with a soft keyboard? It still focuses — the
     * keyboard opening is the correct behaviour on a screen whose only purpose
     * is to accept six digits.
     */
    requestAnimationFrame(function () {
      try { input.focus({ preventScroll: false }); } catch (e) { input.focus(); }
    });
  }

  function init() {
    var wraps = document.querySelectorAll('[data-code-field]');
    for (var i = 0; i < wraps.length; i += 1) setup(wraps[i]);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  /*
   * Nothing to do for the no-reload router.
   *
   * The first version listened for a `vesopa:navigated` event. No such event
   * exists — nav.js re-creates every `script[src]` in the incoming body
   * instead (a script inserted with innerHTML never runs), so this whole file
   * executes again on the new DOM and `init` above does the work. A listener
   * for an event nobody fires is worse than no listener: it reads as a working
   * hook and quietly is not one.
   */
})();
