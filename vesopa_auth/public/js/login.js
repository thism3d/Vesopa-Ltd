/*
 * The sign-in page's behaviour.
 *
 * EVERYTHING HERE IS AN UPGRADE, NOT A REQUIREMENT. With JavaScript off, the
 * toggle is a radio group that the server renders either way round, and the
 * register link is an ordinary link to ?mode=register. That is not
 * box-ticking: the page people use to get into their account is the last page
 * that should depend on a script loading.
 */
(function () {
  'use strict';

  var form = document.querySelector('.auth-form');
  if (!form) return;

  // ---------------------------------------------------------------------
  // Email ⇄ phone
  // ---------------------------------------------------------------------

  var panes = {
    email: document.querySelector('[data-pane="email"]'),
    phone: document.querySelector('[data-pane="phone"]'),
  };

  function showChannel(channel) {
    Object.keys(panes).forEach(function (key) {
      if (panes[key]) panes[key].hidden = key !== channel;
    });
    var field = panes[channel] && panes[channel].querySelector('input');
    // Only pull focus once the person has actually chosen; stealing it on load
    // would open the keyboard on a phone before anybody asked.
    if (field && document.activeElement !== document.body) field.focus();
  }

  Array.prototype.forEach.call(document.querySelectorAll('[data-channel]'), function (radio) {
    radio.addEventListener('change', function () {
      if (radio.checked) showChannel(radio.value);
    });
  });

  // ---------------------------------------------------------------------
  // Log in ⇄ Register
  //
  // The owner's rule: the link under the button changes the button's name and
  // its own, and nothing else. Same form, same action, same page.
  //
  // The server does not trust the resulting `mode` field for anything
  // meaningful — what happens next depends on whether the address is already
  // known, not on which word was showing. Somebody who clicks "Register" with
  // an address they already have is signed in, not scolded.
  // ---------------------------------------------------------------------

  var modeField = document.querySelector('[data-mode-field]');
  var flipLink = document.querySelector('[data-flip]');

  function applyMode(mode) {
    Array.prototype.forEach.call(
      document.querySelectorAll('[data-title],[data-sub],[data-submit],[data-flip],[data-flip-lead]'),
      function (el) {
        var text = el.getAttribute('data-' + mode);
        if (text) el.textContent = text;
      }
    );
    if (modeField) modeField.value = mode;
    if (flipLink) {
      flipLink.setAttribute('href', '/login?mode=' + (mode === 'register' ? 'login' : 'register'));
    }
    document.title =
      (mode === 'register' ? 'Create your Vesopa account' : 'Sign in to Vesopa') + ' · Vesopa';

    // Replace rather than push: the flip is not a place, and putting it in
    // history means Back appears to do nothing.
    try {
      var url = new URL(window.location.href);
      if (mode === 'register') url.searchParams.set('mode', 'register');
      else url.searchParams.delete('mode');
      window.history.replaceState({}, '', url);
    } catch (e) {}
  }

  if (flipLink) {
    flipLink.addEventListener('click', function (event) {
      event.preventDefault();
      applyMode(modeField && modeField.value === 'register' ? 'login' : 'register');
    });
  }

  // ---------------------------------------------------------------------
  // Passkeys
  //
  // Two ways in, because one of them is invisible until it works.
  //
  // Conditional UI ("autofill") offers the passkey inside the browser's own
  // dropdown when the email field is focused. It is the only passkey
  // experience that fits a page whose first field is an email box — but it
  // shows nothing at all if the browser has no passkey for this site, so it
  // cannot be the only route. The explicit button is the fallback, and it is
  // revealed only when the browser can actually do this.
  // ---------------------------------------------------------------------

  var passkeyButton = document.querySelector('[data-passkey]');

  function webauthnAvailable() {
    // Both the browser being able to do this, and the server saying the
    // endpoints exist. Offering a button that 404s is worse than offering no
    // button: the person tries the thing that looks safest and it fails.
    if (!document.body.hasAttribute('data-passkeys-enabled')) return false;
    return !!(window.PublicKeyCredential && navigator.credentials);
  }

  if (passkeyButton && webauthnAvailable()) {
    passkeyButton.hidden = false;
    passkeyButton.addEventListener('click', function () {
      startPasskey(false);
    });
  }

  if (webauthnAvailable() && window.PublicKeyCredential.isConditionalMediationAvailable) {
    window.PublicKeyCredential.isConditionalMediationAvailable()
      .then(function (available) {
        if (available) startPasskey(true);
      })
      .catch(function () {
        /* An older browser: the button above is the route. */
      });
  }

  var passkeyAbort = null;

  function startPasskey(conditional) {
    // A conditional ceremony sits waiting on the field for as long as the page
    // is open. If the person submits the form instead, it has to be cancelled,
    // or the next ceremony throws "a request is already pending".
    if (passkeyAbort) passkeyAbort.abort();
    passkeyAbort = new AbortController();

    fetch('/webauthn/authenticate/options', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
      .then(function (response) {
        if (!response.ok) throw new Error('options');
        return response.json();
      })
      .then(function (options) {
        return navigator.credentials.get({
          publicKey: decodeOptions(options),
          signal: passkeyAbort.signal,
          mediation: conditional ? 'conditional' : 'optional',
        });
      })
      .then(function (credential) {
        if (!credential) return null;
        return fetch('/webauthn/authenticate/verify', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(encodeCredential(credential)),
        });
      })
      .then(function (response) {
        if (response && response.ok) return response.json();
        return null;
      })
      .then(function (result) {
        if (result && result.redirect) window.location.assign(result.redirect);
      })
      .catch(function (error) {
        /*
         * A CONDITIONAL CEREMONY NEVER SHOWS AN ERROR. It runs on its own the
         * moment the page loads, nobody asked for it, and most of the time it
         * ends without a result because the browser has no passkey for this
         * site — which is not a failure, it is Tuesday. Surfacing it puts a red
         * box in front of somebody who has done nothing but open the page.
         *
         * Only the explicit button, which the person clicked, gets to complain.
         */
        if (conditional) return;

        // A cancelled ceremony is the normal case even then — they chose to
        // type a password instead — and must never read as something breaking.
        if (error && (error.name === 'AbortError' || error.name === 'NotAllowedError')) return;
        showError('That passkey could not be used. Try your email address instead.');
      });
  }

  form.addEventListener('submit', function () {
    if (passkeyAbort) passkeyAbort.abort();
  });

  function showError(message) {
    var region = document.getElementById('form-error');
    if (region) region.textContent = message;
  }

  // WebAuthn speaks ArrayBuffers; JSON does not. base64url both ways.
  function fromBase64Url(value) {
    var padded = value.replace(/-/g, '+').replace(/_/g, '/');
    while (padded.length % 4) padded += '=';
    var binary = atob(padded);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  function toBase64Url(buffer) {
    var bytes = new Uint8Array(buffer);
    var binary = '';
    for (var i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function decodeOptions(options) {
    var decoded = Object.assign({}, options);
    decoded.challenge = fromBase64Url(options.challenge);
    if (options.allowCredentials) {
      decoded.allowCredentials = options.allowCredentials.map(function (item) {
        return Object.assign({}, item, { id: fromBase64Url(item.id) });
      });
    }
    return decoded;
  }

  function encodeCredential(credential) {
    return {
      id: credential.id,
      rawId: toBase64Url(credential.rawId),
      type: credential.type,
      response: {
        clientDataJSON: toBase64Url(credential.response.clientDataJSON),
        authenticatorData: toBase64Url(credential.response.authenticatorData),
        signature: toBase64Url(credential.response.signature),
        userHandle: credential.response.userHandle
          ? toBase64Url(credential.response.userHandle)
          : null,
      },
      clientExtensionResults: credential.getClientExtensionResults(),
    };
  }
})();
