/*
 * reCAPTCHA v3, attached to whichever form on this page asked for it.
 *
 * WHY THIS IS A FILE AND NOT AN INLINE SCRIPT, which is what it was. The
 * no-reload router re-runs `script[src]` after it swaps a page in, and does not
 * re-run inline scripts — it cannot, because an inline script would need this
 * document's nonce and the one it was fetched with is not it. So the whole of
 * this, living inline in the partial, ran exactly once: on a page somebody
 * loaded directly. Anybody who arrived at the sign-in form by pressing "Sign
 * in" on the landing page got no token at all, and the server dutifully treated
 * them as unverified and emailed a code. The captcha was on, and for most
 * people it was not running.
 *
 * IT SETS A HIDDEN FIELD RATHER THAN BLOCKING SUBMISSION. If Google's script is
 * blocked — an ad blocker, a corporate proxy, a country — the field stays empty
 * and the form still posts. src/captcha.js treats an empty token as "ask for a
 * code", never as "refuse". A sign-in page that stops working because a
 * third-party script did not load is not a sign-in page.
 */
(function () {
  'use strict';

  var field = document.getElementById('captcha-token');
  if (!field) return;

  var key = field.getAttribute('data-site-key');
  var action = field.getAttribute('data-action') || 'signin';
  if (!key) return;

  /*
   * Google's script is loaded once per document, by us, rather than by a tag in
   * the HTML. A tag would be recreated by the router on every navigation, so
   * the page would fetch and evaluate the whole of reCAPTCHA again each time
   * somebody moved between two forms.
   */
  if (!window.__vesopaCaptchaScript) {
    window.__vesopaCaptchaScript = true;
    var script = document.createElement('script');
    script.src = 'https://www.google.com/recaptcha/api.js?render=' + encodeURIComponent(key);
    script.async = true;
    script.defer = true;
    document.head.appendChild(script);
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
      if (!window.grecaptcha || !window.grecaptcha.execute) return;

      event.preventDefault();
      var submitter = event.submitter || null;

      /*
       * Submitted again through `requestSubmit`, not `submit`.
       *
       * `form.submit()` does not fire a submit event, which means the router
       * never sees it and the browser does a full navigation — the very thing
       * the owner asked to be rid of. `requestSubmit` fires the event properly,
       * carries the button that was pressed, and the `data-captcha-done` flag
       * above is what stops it looping back into this handler.
       */
      var resubmit = function () {
        form.setAttribute('data-captcha-done', '');
        if (form.requestSubmit) form.requestSubmit(submitter || undefined);
        else form.submit();
      };

      try {
        window.grecaptcha.ready(function () {
          window.grecaptcha.execute(key, { action: action }).then(function (token) {
            var target = form.querySelector('#captcha-token') || field;
            if (target) target.value = token;
            resubmit();
          }, resubmit);
        });
      } catch (e) {
        // Google said no. Post anyway with an empty token; the server asks for
        // a code rather than refusing.
        resubmit();
      }
    });
  }

  /*
   * THE FORM IS FOUND THROUGH THE FIELD, and the field is put back inside the
   * form if it has got out.
   *
   * This is the fault that made the whole feature inert on the live site for
   * as long as it was switched on. The partial was included AFTER `</form>` on
   * both pages, so:
   *
   *   the hidden field was never submitted, because a control outside a form
   *   is not part of it — the server saw no token on every single sign-in; and
   *   the old scan (`forms[i].querySelector('#captcha-token')`) matched
   *   nothing, so nothing was ever bound and no token was minted anyway.
   *
   * Neither failure showed. A missing token was a silent degrade, so the page
   * worked and the score was simply never consulted. The templates are fixed;
   * this is the belt to that pair of braces, because "the include moved" is a
   * one-line change somebody will make again.
   */
  var form =
    field.form ||
    document.querySelector('form[data-captcha]') ||
    document.querySelector('form[method="post"]');
  if (!form) return;
  if (field.form !== form) form.appendChild(field);

  attach(form);
})();
