/*
 * Vesopa Mail — the sign-in fields.
 *
 * Roundcube draws the login form itself (the loginform template object), so
 * this adjusts what it drew rather than replacing it: the names, the token and
 * the submit stay Roundcube's own.
 *
 *   Username -> Email   A mailbox here is always signed into with its full
 *                       address, and "Username" sent people looking for one
 *                       they never had. type=email gives phones the @ keyboard,
 *                       autocomplete=username lets password managers fill it.
 *   The eye             Shows or hides the password. It keeps the caret where
 *                       it was, and puts the field back to a password before
 *                       the form is sent, so nothing is saved or restored as
 *                       plain text.
 *   Floating labels     Material-style: the label sits in the field, and moves
 *                       up out of the way when the field is focused or filled.
 *                       The float itself is pure CSS (styles.css).
 *
 * Order does not matter. This is loaded before Elastic's ui.js, which copies
 * each label into its placeholder and wraps the field in an input group; it
 * works the same if ui.js has already run.
 */
(function () {
  'use strict';

  var form = document.getElementById('login-form');
  var user = document.getElementById('rcmloginuser');
  var pass = document.getElementById('rcmloginpwd');
  if (!form || !user || !pass) return;

  var bn = /^bn/i.test(document.documentElement.getAttribute('lang') || '');
  var words = document.getElementById('v-login-words');
  var roundcube = function (name, fallback) {
    var value = words && words.getAttribute('data-' + name);
    return value && value.trim() ? value.trim() : fallback;
  };

  // Roundcube's own Bengali strings read "গ্রাহক নাম (username)" and
  // "ই-মেইল/চিঠি"; these are what a person would write.
  var text = bn ? {
    email: 'ইমেইল',
    password: 'পাসওয়ার্ড',
    show: 'পাসওয়ার্ড দেখুন',
    hide: 'পাসওয়ার্ড লুকান',
    caps: 'ক্যাপস লক চালু আছে',
  } : {
    email: roundcube('email', 'Email'),
    password: roundcube('password', 'Password'),
    show: 'Show password',
    hide: 'Hide password',
    caps: 'Caps Lock is on',
  };

  if (bn) {
    Array.prototype.forEach.call(document.querySelectorAll('[data-bn]'), function (el) {
      el.textContent = el.getAttribute('data-bn');
    });
  }

  function labelFor(input, value) {
    var label = document.querySelector('label[for="' + input.id + '"]');
    if (label) label.textContent = value;
    input.setAttribute('placeholder', value);
    input.setAttribute('aria-label', value);
  }

  function float(input, value) {
    var cell = input.parentNode;
    cell.classList.add('v-field');
    var tag = document.createElement('span');
    tag.className = 'v-float';
    tag.setAttribute('aria-hidden', 'true');
    tag.textContent = value;
    cell.appendChild(tag);
    return cell;
  }

  // ---- Email ---------------------------------------------------------------
  labelFor(user, text.email);
  user.type = 'email';
  user.setAttribute('inputmode', 'email');
  user.setAttribute('autocomplete', 'username');
  user.setAttribute('autocapitalize', 'none');
  user.setAttribute('autocorrect', 'off');
  user.setAttribute('spellcheck', 'false');
  float(user, text.email);

  // ---- Password ------------------------------------------------------------
  labelFor(pass, text.password);
  pass.setAttribute('autocomplete', 'current-password');
  pass.setAttribute('spellcheck', 'false');

  var eye = document.createElement('button');
  eye.type = 'button';
  eye.className = 'v-eye';
  eye.setAttribute('aria-controls', pass.id);
  eye.setAttribute('aria-pressed', 'false');
  eye.setAttribute('aria-label', text.show);
  eye.title = text.show;
  eye.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">'
    + '<path class="v-eye-lid" d="M2.2 12C4.3 7.6 7.8 5.2 12 5.2s7.7 2.4 9.8 6.8c-2.1 4.4-5.6 6.8-9.8 6.8S4.3 16.4 2.2 12Z"/>'
    + '<circle class="v-eye-pupil" cx="12" cy="12" r="3.1"/>'
    + '<path class="v-eye-slash" d="M4 3.5 20 20.5"/>'
    + '</svg>';
  pass.parentNode.insertBefore(eye, pass.nextSibling);
  var passCell = float(pass, text.password);

  // Keep focus in the field when the eye is pressed with a mouse or a finger,
  // so the caret does not jump and a phone keyboard does not close.
  eye.addEventListener('mousedown', function (e) { e.preventDefault(); });

  eye.addEventListener('click', function () {
    var showing = pass.type === 'text';
    var start = pass.selectionStart;
    var end = pass.selectionEnd;
    pass.type = showing ? 'password' : 'text';
    eye.setAttribute('aria-pressed', showing ? 'false' : 'true');
    eye.setAttribute('aria-label', showing ? text.show : text.hide);
    eye.title = showing ? text.show : text.hide;
    passCell.classList.toggle('v-revealed', !showing);
    if (document.activeElement !== eye) {
      pass.focus();
      // Twice: Chrome moves the caret back to the start once the mouse click
      // has finished (measured), so the one that sticks is the frame after.
      var restore = function () {
        try { pass.setSelectionRange(start, end); } catch (err) { /* not every browser allows it */ }
      };
      restore();
      if (window.requestAnimationFrame) window.requestAnimationFrame(restore);
    }
  });

  function conceal() {
    if (pass.type === 'password') return;
    pass.type = 'password';
    eye.setAttribute('aria-pressed', 'false');
    eye.setAttribute('aria-label', text.show);
    eye.title = text.show;
    passCell.classList.remove('v-revealed');
  }
  form.addEventListener('submit', conceal, true);
  // Coming Back to this page restores it from the browser's cache exactly as
  // it was left, a shown password included.
  window.addEventListener('pagehide', conceal);
  window.addEventListener('pageshow', conceal);

  // ---- Caps Lock -----------------------------------------------------------
  var caps = document.createElement('p');
  caps.className = 'v-caps';
  caps.setAttribute('role', 'status');
  caps.textContent = text.caps;
  var table = passCell.closest ? passCell.closest('table') : null;
  if (table) table.parentNode.insertBefore(caps, table.nextSibling);

  function checkCaps(e) {
    if (!e.getModifierState) return;
    caps.classList.toggle('v-on', e.getModifierState('CapsLock'));
  }
  pass.addEventListener('keydown', checkCaps);
  pass.addEventListener('keyup', checkCaps);
  pass.addEventListener('blur', function () { caps.classList.remove('v-on'); });
}());
