/*
 * reCAPTCHA v3, attached to whichever form on this page asked for it.
 *
 * WHY THIS IS A FILE AND NOT AN INLINE SCRIPT, which is what it was. The
 * no-reload router re-runs `script[src]` after it swaps a page in, and does not
 * re-run inline scripts — it cannot, because an inline script would need this
 * document's nonce and the one it was fetched with is not it. So the whole of
 * this, living inline in the partial, ran exactly once: on a page somebody
 * loaded directly.
 *
 * IT MUST NEVER BE ABLE TO STOP SOMEBODY SIGNING IN. Two independent things
 * below guarantee that, and both exist because one of them was missing and the
 * Continue button spun for ever on a real phone:
 *
 *   the instance is REVIVED after the router has swapped the body, and
 *   `execute` is raced against a timeout, so a hang is not a dead end.
 *
 * The field is set and the form is submitted either way. src/captcha.js treats
 * a missing token as no evidence, never as a refusal — so a sign-in page that
 * loses Google entirely still signs people in.
 */
(function () {
  'use strict';

  var field = document.getElementById('captcha-token');
  if (!field) return;

  var key = field.getAttribute('data-site-key');
  var action = field.getAttribute('data-action') || 'signin';
  if (!key) return;

  /*
   * HOW LONG WE ARE PREPARED TO WAIT FOR A SCORE.
   *
   * A token is worth having and is not worth a person staring at a spinner.
   * Two and a half seconds is longer than the mint takes on a bad connection
   * and shorter than anybody's patience, and the request that follows is one
   * the server is happy to receive without a token.
   */
  var PATIENCE_MS = 2000;

  function loadScript() {
    return new Promise(function (resolve) {
      var script = document.createElement('script');
      script.src = 'https://www.google.com/recaptcha/api.js?render=' + encodeURIComponent(key);
      script.async = true;
      script.defer = true;
      script.onload = resolve;
      // Resolve either way. A blocked script must not leave a promise nobody
      // settles — that is the whole failure this file is guarding against.
      script.onerror = resolve;
      document.head.appendChild(script);
    });
  }

  function badge() {
    return document.querySelector('.grecaptcha-badge');
  }

  /**
   * Google's script, loaded ONCE per document.
   *
   * WHY IT USED TO LOAD TWICE. This decided "the router has destroyed
   * reCAPTCHA" from `grecaptcha` existing with no badge on the page. That is
   * also exactly the state of a FRESH load: api.js fires `onload` and defines
   * `grecaptcha.execute` a moment before it gets round to drawing the badge.
   * So a submit in that window (autofill and Enter, a password manager) threw
   * a perfectly healthy reCAPTCHA away and fetched the whole thing again. And
   * after every no-reload navigation the router really did destroy it, so it
   * was reloaded on the password step and on every re-rendered form as well.
   *
   * Now the router leaves Google's nodes alone (nav.js, replaceBody), so the
   * first load is the only one. The load is one shared promise, so a warm-up
   * and a submit racing each other wait for the same script instead of each
   * starting one.
   *
   * The recovery is kept for the case it was written for, a badge we HAVE
   * seen that has since gone, and only that case: it can no longer fire on a
   * load that simply has not finished.
   */
  function ready() {
    if (badge()) window.__vesopaCaptchaSeen = true;

    var lost = window.__vesopaCaptchaSeen && !badge();
    if (lost) {
      try {
        delete window.grecaptcha;
        delete window.___grecaptcha_cfg;
      } catch (e) {
        window.grecaptcha = undefined;
        window.___grecaptcha_cfg = undefined;
      }
      var stale = document.querySelectorAll('script[src*="recaptcha/"]');
      for (var i = 0; i < stale.length; i += 1) stale[i].parentNode.removeChild(stale[i]);
      window.__vesopaCaptchaSeen = false;
      window.__vesopaCaptchaLoad = null;
    }

    if (!window.__vesopaCaptchaLoad) window.__vesopaCaptchaLoad = loadScript();
    return window.__vesopaCaptchaLoad;
  }

  /**
   * A token, or nothing, within `PATIENCE_MS`. It never rejects and it never
   * hangs — those are the two ways this could hold up a sign-in, so neither is
   * left possible.
   */
  function mint() {
    return new Promise(function (resolve) {
      var settled = false;
      var finish = function (token) {
        if (settled) return;
        settled = true;
        resolve(token || '');
      };

      setTimeout(finish, PATIENCE_MS);

      ready().then(function () {
        if (!window.grecaptcha || !window.grecaptcha.execute) return finish('');
        try {
          window.grecaptcha.ready(function () {
            window.grecaptcha.execute(key, { action: action }).then(function (token) {
              if (badge()) window.__vesopaCaptchaSeen = true;
              finish(token);
            }, function () {
              finish('');
            });
          });
        } catch (e) {
          finish('');
        }
      }, function () {
        finish('');
      });
    });
  }

  /**
   * Mint the token when the form is submitted, not when the page loads.
   *
   * A v3 token is good for two minutes. A page left open on a table for ten
   * would carry a stale one, and `timeout-or-duplicate` is far and away the
   * commonest reason a real person is asked for a code they did not need.
   */
  function attach(form) {
    if (form.getAttribute('data-captcha-bound') !== null) return;
    form.setAttribute('data-captcha-bound', '');

    form.addEventListener('submit', function (event) {
      if (form.getAttribute('data-captcha-done') !== null) return;

      event.preventDefault();
      var submitter = event.submitter || null;

      /*
       * Submitted again through `requestSubmit`, not `submit`.
       *
       * `form.submit()` does not fire a submit event, which means the router
       * never sees it and the browser does a full navigation — the very thing
       * the owner asked to be rid of. `requestSubmit` fires the event properly,
       * carries the button that was pressed, and `data-captcha-done` is what
       * stops it looping back into this handler.
       */
      mint().then(function (token) {
        var target = form.querySelector('#captcha-token') || field;
        if (target) target.value = token;
        form.setAttribute('data-captcha-done', '');
        if (form.requestSubmit) form.requestSubmit(submitter || undefined);
        else form.submit();
      });
    });
  }

  /*
   * THE FORM IS FOUND THROUGH THE FIELD, and the field is put back inside the
   * form if it has got out.
   *
   * This is the fault that made the whole feature inert on the live site for
   * as long as it was switched on. The partial was included AFTER `</form>` on
   * both pages, so the hidden field was never submitted — a control outside a
   * form is not part of it — and the old scan for "the form containing
   * #captcha-token" matched nothing, so nothing was bound and no token was
   * minted to put in it either. Neither failure showed, because a missing
   * token is a silent degrade. The templates are fixed; this is the belt to
   * that pair of braces, because "the include moved" is a one-line change
   * somebody will make again.
   */
  var form =
    field.form ||
    document.querySelector('form[data-captcha]') ||
    document.querySelector('form[method="post"]');
  if (!form) return;
  if (field.form !== form) form.appendChild(field);

  attach(form);

  /*
   * Warm it up, so the first submit is not also the first load. Failure is
   * ignored entirely: `mint()` on submit does the same work again and settles
   * either way.
   */
  ready().catch(function () {});
})();
