/**
 * Firebase's email links, answered on auth.vesopa.com.
 *
 * Apps built on Firebase Authentication (the Pontardawe RFC app, and whatever
 * follows it) send their own emails: verify your address, reset your password,
 * your address was changed, a second step was added. Each carries a link to an
 * "action handler". Firebase's default one lives on vesopa.firebaseapp.com and
 * looks like nobody's — exactly the kind of page people are told not to type a
 * password into. Setting "Customize action URL" in the Firebase console to
 *
 *     https://auth.vesopa.com/__/auth/action
 *
 * brings them here instead. The query string Firebase adds is always
 * mode, oobCode, apiKey, continueUrl and lang.
 *
 * NOTHING IS USED UP ON A GET. Mail scanners at banks and big companies open
 * every link in a message before the person does. If the GET applied the code,
 * the scanner would verify the address — or worse, spend the reset code — and
 * the real person would find a dead link. So the GET only checks the code and
 * shows what it will do; a button the person presses does it.
 *
 * Everything goes through Google's Identity Toolkit REST API, which is what
 * the Firebase JS SDK calls underneath. No SDK, no script on the page, and the
 * content security policy stays exactly as strict as the rest of the site.
 */

const express = require('express');
const config = require('../config');
const csrf = require('../csrf');

const router = express.Router();

const PATHS = ['/__/auth/action', '/actions'];
const TOOLKIT = 'https://identitytoolkit.googleapis.com/v1';

/*
 * Where "Continue" may go afterwards. The continueUrl comes from the link, and
 * a link is something anybody can write, so it is only offered when it points
 * at one of ours. Otherwise this page becomes a respectable-looking hop to
 * somebody else's site.
 */
const CONTINUE_DOMAINS = [
  'vesopa.com',
  'vesopaepos.com',
  'vesopasoftware.com',
  'pontardawerfc.com',
  'vesopa.firebaseapp.com',
  'vesopa.web.app',
];

const MODES = {
  verifyEmail: 'VERIFY_EMAIL',
  resetPassword: 'PASSWORD_RESET',
  recoverEmail: 'RECOVER_EMAIL',
  verifyAndChangeEmail: 'VERIFY_AND_CHANGE_EMAIL',
  revertSecondFactorAddition: 'REVERT_SECOND_FACTOR_ADDITION',
};

/** Google's error codes, said the way a person would want to hear them. */
const ERRORS = {
  EXPIRED_OOB_CODE: 'This link has expired. Ask the app to send you a new one.',
  INVALID_OOB_CODE:
    'This link has already been used, or it was cut short when it was copied. Ask the app to send you a new one.',
  USER_DISABLED: 'This account has been switched off. Contact the club or business that runs the app.',
  USER_NOT_FOUND: 'This account no longer exists.',
  EMAIL_EXISTS: 'That address now belongs to another account, so it cannot be put back on this one.',
  WEAK_PASSWORD: 'That password is too easy to guess. Choose a longer one.',
};

function friendly(code) {
  const key = String(code || '').split(' ')[0].split(':')[0];
  return ERRORS[key] || 'Something went wrong with this link. Ask the app to send you a new one.';
}

function validApiKey(key) {
  if (!/^AIza[0-9A-Za-z_-]{35}$/.test(key)) return false;
  return config.firebase.apiKeys.length === 0 || config.firebase.apiKeys.includes(key);
}

function safeContinue(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:') return null;
    const host = url.hostname.toLowerCase();
    const ours = CONTINUE_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));
    return ours ? { href: url.href, host } : null;
  } catch {
    return null;
  }
}

async function toolkit(method, apiKey, body) {
  const response = await fetch(`${TOOLKIT}/${method}?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error('toolkit');
    error.code = (data.error && data.error.message) || `HTTP_${response.status}`;
    throw error;
  }
  return data;
}

function readLink(source) {
  return {
    mode: String(source.mode || ''),
    oobCode: String(source.oobCode || '').slice(0, 512),
    apiKey: String(source.apiKey || ''),
    continueUrl: String(source.continueUrl || '').slice(0, 2048),
    lang: String(source.lang || '').slice(0, 16),
  };
}

function show(res, link, state) {
  return res.render('firebase-action', {
    title: state.title || 'Your account',
    noindex: true,
    link,
    next: safeContinue(link.continueUrl),
    email: '',
    newEmail: '',
    error: '',
    done: false,
    ...state,
  });
}

function broken(res, link, message) {
  res.status(400);
  return show(res, link, { stage: 'error', title: 'Link not valid', error: message });
}

router.get(PATHS, async (req, res, next) => {
  const link = readLink(req.query);
  const expected = MODES[link.mode];
  if (!expected || !link.oobCode || !validApiKey(link.apiKey)) {
    return broken(res, link, 'This link is incomplete. Open it straight from the email, or ask the app to send a new one.');
  }

  try {
    // With no new password, resetPassword only checks the code and says what
    // it is for. It works for every kind of code, and spends none of them.
    const info = await toolkit('accounts:resetPassword', link.apiKey, { oobCode: link.oobCode });
    if (info.requestType && info.requestType !== expected) {
      return broken(res, link, 'This link does not match what it says it is for. Ask the app to send a new one.');
    }
    return show(res, link, {
      stage: link.mode,
      email: info.email || '',
      newEmail: info.newEmail || '',
    });
  } catch (error) {
    if (!error.code) return next(error);
    return broken(res, link, friendly(error.code));
  }
});

router.post(PATHS, csrf.verify, async (req, res, next) => {
  const link = readLink(req.body);
  if (!MODES[link.mode] || !link.oobCode || !validApiKey(link.apiKey)) {
    return broken(res, link, 'This link is incomplete. Open it straight from the email again.');
  }

  try {
    if (link.mode === 'resetPassword') {
      const password = String(req.body.password || '');
      const confirm = String(req.body.confirm || '');
      const again = (message) =>
        show(res, link, { stage: 'resetPassword', email: String(req.body.email || ''), error: message });
      if (password.length < 8) return again('Use at least 8 characters.');
      if (password.length > 128) return again('That password is too long.');
      if (password !== confirm) return again('The two passwords are not the same.');

      const result = await toolkit('accounts:resetPassword', link.apiKey, {
        oobCode: link.oobCode,
        newPassword: password,
      });
      return show(res, link, { stage: 'resetPassword', done: true, email: result.email || '' });
    }

    const result = await toolkit('accounts:update', link.apiKey, { oobCode: link.oobCode });
    return show(res, link, { stage: link.mode, done: true, email: result.email || '' });
  } catch (error) {
    if (!error.code) return next(error);
    return broken(res, link, friendly(error.code));
  }
});

module.exports = router;
