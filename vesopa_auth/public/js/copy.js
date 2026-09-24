/*
 * "Copy" beside anything a developer has to paste somewhere else.
 *
 * A client id, a redirect URI, a client secret, a curl command. Every one of
 * them gets retyped wrongly at least once if it cannot be copied, and the
 * failure does not happen here — it happens an hour later on somebody else's
 * machine, as `invalid_request` with no indication of which character is wrong.
 *
 * PROGRESSIVE, IN BOTH DIRECTIONS. The buttons are hidden by CSS until the
 * `data-js` flag on <html> says scripting is running, so a browser that
 * blocked this shows selectable text and no button that does nothing — and
 * the flag is on <html> because the router replaces the body. And
 * `navigator.clipboard` is not
 * available on an insecure origin or in every browser, so there is a fallback
 * that selects the text and lets the person press the shortcut themselves —
 * which is still better than reading it off the screen.
 *
 * Bound with one listener on the document rather than one per button, because
 * the router replaces the body on every navigation and per-element listeners
 * would be lost with it.
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
  if (window.__vesopaCopyReady) return;
  window.__vesopaCopyReady = true;

  if (!document.querySelector) return;

  function flash(button, word) {
    var original = button.getAttribute('data-label') || button.textContent;
    button.setAttribute('data-label', original);
    button.textContent = word;
    setTimeout(function () {
      button.textContent = button.getAttribute('data-label') || 'Copy';
    }, 1600);
  }

  function selectText(node) {
    try {
      var range = document.createRange();
      range.selectNodeContents(node);
      var selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return true;
    } catch (e) {
      return false;
    }
  }

  document.addEventListener('click', function (event) {
    var button = event.target.closest ? event.target.closest('.copy-btn') : null;
    if (!button) return;
    event.preventDefault();

    var holder = button.closest('.copy') || button.parentNode;
    var source = holder ? holder.querySelector('code, pre') : null;
    if (!source) return;
    var text = source.textContent || '';

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () { flash(button, 'Copied'); },
        function () { flash(button, selectText(source) ? 'Press Ctrl+C' : 'Could not copy'); }
      );
      return;
    }
    flash(button, selectText(source) ? 'Press Ctrl+C' : 'Could not copy');
  });
})();
