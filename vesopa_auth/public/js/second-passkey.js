/*
 * "Use your passkey" on the second-step and confirm-it-is-you page
 * (2026-10-15). An account whose only second factor is a passkey was told
 * "there is nothing left on this account to check against", because the page
 * offered codes only. The button runs the same passkey ceremony as sign-in and
 * posts it to /second/passkey, which checks it is this person's passkey and
 * finishes the step.
 */
(function () {
  'use strict';

  var button = document.getElementById('second-passkey');
  if (!button || !window.PublicKeyCredential) {
    if (button) button.hidden = true;
    return;
  }

  button.addEventListener('click', function () {
    button.disabled = true;
    var challenge = null;
    fetch('/webauthn/authenticate/options', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      credentials: 'same-origin',
    })
      .then(function (response) {
        if (!response.ok) throw new Error('options');
        return response.json();
      })
      .then(function (options) {
        challenge = options.challenge;
        return navigator.credentials.get({ publicKey: decodeOptions(options), mediation: 'optional' });
      })
      .then(function (credential) {
        if (!credential) return null;
        var body = encodeCredential(credential);
        body.challenge = challenge;
        body.mode = button.getAttribute('data-mode');
        body.return_to = button.getAttribute('data-return') || '';
        return fetch('/second/passkey', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          credentials: 'same-origin',
        });
      })
      .then(function (response) {
        if (!response) return null;
        return response.json().then(function (json) { return { ok: response.ok, json: json }; });
      })
      .then(function (result) {
        if (!result) { button.disabled = false; return; }
        if (result.ok && result.json.redirect) {
          window.location.assign(result.json.redirect);
          return;
        }
        showError((result.json && result.json.message) || 'That passkey could not be used. Try again.');
        button.disabled = false;
      })
      .catch(function (error) {
        button.disabled = false;
        if (error && (error.name === 'AbortError' || error.name === 'NotAllowedError')) return;
        showError('That passkey could not be used. Try again.');
      });
  });

  function showError(message) {
    var region = document.getElementById('form-error');
    if (region) region.textContent = message;
  }

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
        userHandle: credential.response.userHandle ? toBase64Url(credential.response.userHandle) : null,
      },
      clientExtensionResults: credential.getClientExtensionResults(),
    };
  }
})();
