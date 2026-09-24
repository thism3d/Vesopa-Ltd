/*
 * The profile picture, made to actually upload.
 *
 * WHAT WAS WRONG. The template said, in a comment, that the form "submits
 * itself when a file is chosen, and shows a plain button when it cannot" — and
 * the plain button was inside `<noscript>`. So with scripting ON (everybody)
 * there was no button, and with scripting on there was also no script: this
 * file did not exist. Choosing a picture selected a file into a hidden input
 * and then nothing happened, for ever. That is the owner's "image upload and
 * update not working", and it was never an upload problem — the bytes never
 * left the browser.
 *
 * WHAT IT DOES NOW. The button is always in the markup, hidden by this script
 * once it has taken over, so the page works identically whether or not this
 * loads. Choosing a file submits. And before it submits, the picture on screen
 * is replaced with the one that was chosen, because a 2MB upload on a phone is
 * two or three seconds of a page that looks like it ignored you.
 */
(function () {
  'use strict';

  var form = document.getElementById('avatar-form');
  if (!form) return;

  var input = form.querySelector('input[type="file"]');
  if (!input) return;

  var fallback = form.querySelector('[data-avatar-submit]');
  var image = form.querySelector('.avatar');
  var cta = form.querySelector('.avatar-cta');
  var error = document.querySelector('[data-avatar-error]');

  // The manual button is only unnecessary once this listener exists.
  if (fallback) fallback.hidden = true;

  var MAX_BYTES = 2 * 1024 * 1024;
  var TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

  function say(message) {
    if (!error) return;
    error.textContent = message || '';
    error.hidden = !message;
  }

  input.addEventListener('change', function () {
    var file = input.files && input.files[0];
    if (!file) return;

    /*
     * CHECKED HERE AND CHECKED AGAIN ON THE SERVER. This copy exists to save
     * somebody on a phone from watching a 5MB photograph upload for twenty
     * seconds before being told the limit is two — it is a courtesy, and the
     * server's copy is the one that decides.
     */
    if (TYPES.indexOf(file.type) === -1) {
      say('That file is not a JPEG, PNG, WebP or GIF.');
      input.value = '';
      return;
    }
    if (file.size > MAX_BYTES) {
      say('That picture is ' + Math.round(file.size / 104857.6) / 10 + ' MB. The limit is 2 MB.');
      input.value = '';
      return;
    }
    say('');

    /*
     * Show it immediately.
     *
     * A `data:` URL rather than `URL.createObjectURL`, which is the obvious
     * choice and would be silently refused: the policy on this origin is
     * `img-src 'self' data:` and a blob: URL is neither. Opening img-src for a
     * preview that lives for two seconds is not a trade worth making on the
     * sign-in domain, and `data:` is already allowed for the TOTP QR code.
     */
    if (image && image.tagName === 'IMG' && window.FileReader) {
      try {
        var reader = new FileReader();
        reader.onload = function () { image.src = reader.result; };
        reader.readAsDataURL(file);
      } catch (e) {
        /* A preview is a nicety; the upload is the point. */
      }
    }
    if (cta) cta.textContent = 'Uploading…';

    // Through requestSubmit, so the router and the loading bar both see it.
    if (form.requestSubmit) form.requestSubmit();
    else form.submit();
  });
})();
