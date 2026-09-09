/**
 * Choosing which Vesopa account you are, and getting out of one of them.
 *
 * The reasoning for holding several at once is in src/accounts.js. This is the
 * three things a person does with them: pick one, add one, leave one.
 *
 * EVERY STATE-CHANGING ROUTE HERE IS A POST WITH A CSRF TOKEN, and that is not
 * ceremony. Switching account on a GET would mean any page on the internet
 * could change who somebody is with an `<img>` tag, and the next thing they did
 * — approve a refund, grant an application, change a recovery address — would
 * be done as somebody else without a single visible step in between. Signing
 * out on a GET has the same shape and is the classic version of it.
 */

const express = require('express');

const config = require('../config');
const csrf = require('../csrf');
const sessions = require('../sessions');
const accounts = require('../accounts');
const events = require('../events');
const { safeReturnTo } = require('./pages');

const router = express.Router();

/**
 * The chooser.
 *
 * `return_to` is carried through every action on it, so picking an account in
 * the middle of an authorisation comes back to that authorisation rather than
 * dumping somebody on their account page wondering what happened to the
 * application that sent them.
 */
router.get('/account/choose', async (req, res, next) => {
  try {
    const roster = await accounts.list(req, res);
    const returnTo = safeReturnTo(req.query.return_to);

    /*
     * Nobody at all. Not an error — it is the ordinary state of a fresh
     * browser, and the answer to it is the sign-in page rather than an empty
     * list explaining itself.
     */
    if (!roster.length) {
      return res.redirect(
        303,
        returnTo ? `/login?return_to=${encodeURIComponent(returnTo)}` : '/login',
      );
    }

    return res.render('choose', {
      title: 'Choose an account',
      nonce: res.locals.nonce,
      config,
      roster,
      returnTo,
      full: accounts.full(roster),
      max: accounts.MAX,
      noindex: true,
    });
  } catch (error) {
    return next(error);
  }
});

/**
 * Switch to one of the accounts already signed in here.
 *
 * The session is named by its PUBLIC id and found in the roster — so the only
 * sessions reachable are the ones whose tokens this browser already holds. The
 * token itself is never in the page: a public id in a form field is a name,
 * and the credential stays in the cookie where it has always been.
 */
router.post('/account/switch', csrf.verify, async (req, res, next) => {
  try {
    const roster = await accounts.list(req, res);
    const returnTo = safeReturnTo(req.body.return_to);
    const wanted = String(req.body.session || '');

    const found = roster.find((entry) => entry.session.public_id === wanted);
    if (!found) {
      // It has been signed out somewhere else since the page was drawn. Show
      // the chooser again rather than an error nobody can act on.
      return res.redirect(303, `/account/choose${returnTo ? `?return_to=${encodeURIComponent(returnTo)}` : ''}`);
    }

    if (!found.active) {
      /*
       * `remembered` is read from the session that is being switched TO, so a
       * session created without "remember me" keeps its browser-lifetime cookie
       * when it becomes the active one. Copying the outgoing session's setting
       * would quietly extend somebody's session because a colleague ticked a
       * box on theirs.
       */
      sessions.setCookie(res, found.token, Boolean(found.session.remembered));
      accounts.add(res, roster, found.token);

      await events.recordAudit({
        actorUserId: found.session.user_id,
        action: 'session.switched',
        targetType: 'session',
        targetId: found.session.public_id,
        ip: req.clientIp,
        userAgent: req.userAgent,
      });
    }

    return res.redirect(303, returnTo || '/account');
  } catch (error) {
    return next(error);
  }
});

/**
 * Sign out of one account, or of all of them.
 *
 * ONE ACCOUNT AT A TIME IS THE POINT. Signing out of Vesopa signs you out of
 * the till, the menu and the back office with it, so "sign out" being all-or-
 * nothing made looking at something as somebody else cost four sessions. Here
 * the other accounts stay exactly as they were, and the next one in the roster
 * becomes active — so leaving an account is not the same as leaving.
 */
router.post('/account/signout', csrf.verify, async (req, res, next) => {
  try {
    const roster = await accounts.list(req, res);
    const returnTo = safeReturnTo(req.body.return_to);
    const all = req.body.scope === 'all';

    const targets = all
      ? roster
      : roster.filter((entry) => entry.session.public_id === String(req.body.session || ''));

    for (const entry of targets) {
      // eslint-disable-next-line no-await-in-loop -- at most eight
      await sessions.revoke(entry.session.id, 'logout');
      // eslint-disable-next-line no-await-in-loop
      await events.recordAudit({
        actorUserId: entry.session.user_id,
        action: 'session.logout',
        targetType: 'session',
        targetId: entry.session.public_id,
        detail: all ? { scope: 'all accounts in this browser' } : null,
        ip: req.clientIp,
        userAgent: req.userAgent,
      });
    }

    const gone = new Set(targets.map((entry) => entry.token));
    const left = roster.filter((entry) => !gone.has(entry.token));

    if (!left.length) {
      sessions.clearCookie(res);
      accounts.clear(res);
      return res.redirect(
        303,
        returnTo ? `/login?return_to=${encodeURIComponent(returnTo)}` : '/login',
      );
    }

    /*
     * Somebody is still signed in. If the account that left was the active one,
     * the first of the others takes over — being dropped at a sign-in page
     * while still signed in to two accounts would be a strange thing to happen
     * and a confusing one to explain.
     */
    accounts.write(res, left.map((entry) => entry.token));
    if (!left.some((entry) => entry.active)) {
      sessions.setCookie(res, left[0].token, Boolean(left[0].session.remembered));
    }

    return res.redirect(303, returnTo || '/account/choose');
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
