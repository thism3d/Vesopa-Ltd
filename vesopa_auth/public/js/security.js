/*
 * The security page: turning on an authenticator app, and adding passkeys.
 *
 * Both are fetch-driven rather than form posts, because both need to show the
 * person something in the middle — a QR code, or the browser's own passkey
 * prompt — without losing the page they are on.
 */
(function () {
  'use strict';

  function token() {
    var field = document.querySelector('input[name="_csrf"]');
    return field ? field.value : '';
  }

  function say(selector, message) {
    var region = document.querySelector(selector);
    if (region) region.textContent = message || '';
  }

  function post(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': token() },
      body: JSON.stringify(body || {}),
    }).then(function (response) {
      return response.json().then(function (data) {
        return { ok: response.ok, status: response.status, data: data };
      });
    });
  }

  // ---------------------------------------------------------------------
  // Authenticator app
  // ---------------------------------------------------------------------

  var startButton = document.querySelector('[data-totp-start]');
  if (startButton) {
    startButton.addEventListener('click', function () {
      startButton.disabled = true;
      say('[data-totp-error]', '');
      post('/account/totp/start').then(function (result) {
        startButton.disabled = false;
        if (!result.ok) {
          say('[data-totp-error]', 'Could not start. Please reload and try again.');
          return;
        }
        document.querySelector('[data-totp-qr]').src = result.data.qr;
        document.querySelector('[data-totp-key]').textContent = result.data.manualKey;
        document.querySelector('[data-totp-panel]').hidden = false;
        startButton.hidden = true;
        var field = document.getElementById('totp-code');
        if (field) field.focus();
      });
    });
  }

  var confirmForm = document.querySelector('[data-totp-confirm]');
  if (confirmForm) {
    confirmForm.addEventListener('submit', function (event) {
      event.preventDefault();
      say('[data-totp-error]', '');
      var code = confirmForm.querySelector('[name="code"]').value;
      post('/account/totp/confirm', { code: code }).then(function (result) {
        if (!result.ok) {
          say(
            '[data-totp-error]',
            result.data.error === 'wrong_code'
              ? 'That code is not right. Codes change every 30 seconds — try the current one.'
              : 'Could not turn it on. Please start again.'
          );
          return;
        }
        // The recovery codes exist in readable form for this one moment.
        showRecoveryCodes(result.data.recoveryCodes);
        say('[data-totp-error]', '');
        var panel = document.querySelector('[data-totp-panel]');
        if (panel) panel.hidden = true;
      });
    });
  }

  var disableForm = document.querySelector('[data-totp-disable]');
  if (disableForm) {
    disableForm.addEventListener('submit', function (event) {
      event.preventDefault();
      var code = disableForm.querySelector('[name="code"]').value;
      post('/account/totp/disable', { code: code }).then(function (result) {
        if (!result.ok) {
          say('[data-totp-error]', 'That code is not right.');
          return;
        }
        window.location.assign('/account/security?saved=1');
      });
    });
  }

  // ---------------------------------------------------------------------
  // Recovery codes
  // ---------------------------------------------------------------------

  function showRecoveryCodes(codes) {
    if (!codes || !codes.length) return;
    var output = document.querySelector('[data-recovery-output]');
    var list = document.querySelector('[data-recovery-list]');
    if (!output || !list) return;
    list.textContent = codes.join('\n');
    output.hidden = false;
    output.scrollIntoView({ block: 'center' });
  }

  var recoveryForm = document.querySelector('[data-recovery-new]');
  if (recoveryForm) {
    recoveryForm.addEventListener('submit', function (event) {
      event.preventDefault();
      post('/account/recovery-codes').then(function (result) {
        if (result.ok) showRecoveryCodes(result.data.recoveryCodes);
      });
    });
  }

  // ---------------------------------------------------------------------
  // Passkeys
  // ---------------------------------------------------------------------

  var addPasskey = document.querySelector('[data-add-passkey]');
  if (addPasskey) {
    if (window.PublicKeyCredential && navigator.credentials) {
      addPasskey.hidden = false;
    } else {
      var note = document.querySelector('[data-passkey-unsupported]');
      if (note) note.hidden = false;
    }

    addPasskey.addEventListener('click', function () {
      say('[data-passkey-error]', '');
      addPasskey.disabled = true;

      post('/webauthn/register/options')
        .then(function (result) {
          if (!result.ok) throw new Error('options');
          var options = result.data;
          var challenge = options.challenge;

          return navigator.credentials
            .create({ publicKey: decodeCreateOptions(options) })
            .then(function (credential) {
              return post('/webauthn/register/verify', {
                expectedChallenge: challenge,
                name: describeThisDevice(),
                credential: encodeCreated(credential),
              });
            });
        })
        .then(function (result) {
          addPasskey.disabled = false;
          if (result && result.ok) {
            window.location.assign('/account/security?saved=1');
          } else {
            say('[data-passkey-error]', 'That passkey could not be added. Please try again.');
          }
        })
        .catch(function (error) {
          addPasskey.disabled = false;
          // Cancelling the browser's prompt is a choice, not a fault.
          if (error && (error.name === 'NotAllowedError' || error.name === 'AbortError')) return;
          if (error && error.name === 'InvalidStateError') {
            say('[data-passkey-error]', 'This device already has a passkey for Vesopa.');
            return;
          }
          say('[data-passkey-error]', 'That passkey could not be added. Please try again.');
        });
    });
  }

  // Removing a passkey answers with JSON, so the form is intercepted.
  Array.prototype.forEach.call(document.querySelectorAll('form[data-json]'), function (form) {
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      fetch(form.action, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': token() },
        body: '{}',
      }).then(function (response) {
        if (response.ok) {
          window.location.reload();
        } else {
          response.json().then(function (data) {
            say(
              '[data-passkey-error]',
              data.error === 'last_auth_method'
                ? 'That is your only way of signing in. Add another first.'
                : 'Could not remove that.'
            );
          });
        }
      });
    });
  });

  /** A rough name so the list of passkeys is tellable apart. */
  function describeThisDevice() {
    var ua = navigator.userAgent;
    var os =
      (/Windows/.test(ua) && 'Windows') ||
      (/iPhone|iPad/.test(ua) && 'iPhone or iPad') ||
      (/Macintosh/.test(ua) && 'Mac') ||
      (/Android/.test(ua) && 'Android') ||
      'This device';
    return os + ' passkey';
  }

  // WebAuthn speaks ArrayBuffers and JSON does not.
  function fromBase64Url(value) {
    var padded = String(value).replace(/-/g, '+').replace(/_/g, '/');
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

  function decodeCreateOptions(options) {
    var decoded = Object.assign({}, options);
    decoded.challenge = fromBase64Url(options.challenge);
    decoded.user = Object.assign({}, options.user, { id: fromBase64Url(options.user.id) });
    if (options.excludeCredentials) {
      decoded.excludeCredentials = options.excludeCredentials.map(function (item) {
        return Object.assign({}, item, { id: fromBase64Url(item.id) });
      });
    }
    return decoded;
  }

  function encodeCreated(credential) {
    return {
      id: credential.id,
      rawId: toBase64Url(credential.rawId),
      type: credential.type,
      response: {
        clientDataJSON: toBase64Url(credential.response.clientDataJSON),
        attestationObject: toBase64Url(credential.response.attestationObject),
        transports: credential.response.getTransports ? credential.response.getTransports() : [],
      },
      clientExtensionResults: credential.getClientExtensionResults(),
    };
  }
})();
