/**
 * The pages a person actually looks at.
 *
 * THE ONE IDEA BEHIND THE LOGIN PAGE
 *
 * There is no separate registration page. The owner asked for it plainly: the
 * link under the button flips the button between "Log in" and "Register", and
 * that is the entire difference between the two. It is a better design than it
 * sounds, because the awkward moment in every sign-in form is a returning
 * customer who cannot remember whether they ever made an account — and here
 * they do not have to know. Both roads lead to the same place: prove you can
 * receive at this address or number, and you are in.
 *
 * The toggle is email first with phone second, which is the opposite way round
 * from the dine-in menu. That is deliberate and not an inconsistency: somebody
 * at a table with food coming has a phone in their hand, and somebody signing
 * in to a back office has a keyboard.
 */

const express = require('express');
const config = require('../config');
const db = require('../db');
const sessions = require('../sessions');
const identity = require('../identity');
const invitations = require('../invitations');
const settings = require('../settings');

const router = express.Router();

/*
 * The social buttons shown are the ones that actually work — `enabled()`
 * returns only providers whose credentials are present on this server. A button
 * for a provider we cannot complete is worse than no button: somebody picks the
 * option that looks most secure and is told it went wrong, which teaches them
 * the whole service is unreliable.
 */
const socialProviders = require('../providers').enabled;

/**
 * Where to send somebody after they sign in.
 *
 * Only a path on this site, and never a URL. `return_to=https://evil.example`
 * on a login link is the oldest phishing trick there is: the person checks the
 * domain, sees auth.vesopa.com, signs in, and is handed straight to somebody
 * else's page — which then asks for the password again and is believed.
 *
 * The protocol flow does not use this. An OAuth client's redirect is matched
 * against its registered URIs instead, exactly, which is a stricter rule again.
 */
function safeReturnTo(value) {
  const raw = String(value || '');
  if (!raw.startsWith('/')) return '';
  // `//evil.example` and `/\evil.example` are both read as protocol-relative
  // URLs by browsers, and both leave this site.
  if (raw.startsWith('//') || raw.startsWith('/\\')) return '';
  return raw.slice(0, 500);
}

router.get('/', (req, res) => {
  res.render('landing', {
    title: 'Vesopa OAuth',
    description: 'One Vesopa account for the till, the menu, the back office and everything next.',
    nonce: res.locals.nonce,
    config,
    styles: ['landing'],
  });
});

router.get('/login', async (req, res, next) => {
  try {
  /*
   * `mode` decides which way round the button and the link read. It is a hint
   * only — the server does not care which one was showing, because the form
   * posts to the same place and the outcome depends on whether the identifier
   * is already known, not on which word was on the button. A person who clicks
   * "Register" with an address they already have gets signed in, not an error.
   */
  const mode = req.query.mode === 'register' ? 'register' : 'login';
  const channel = req.query.channel === 'phone' ? 'phone' : 'email';
  const live = await settings.all();

  return res.render('login', {
    // The tab must agree with the heading; in the compact layout both say
    // "Continue", because signing in and registering are one action here.
    title: live.login_layout === 'compact'
      ? `Continue to ${live.service_name || 'Vesopa'}`
      : (mode === 'register' ? 'Create your Vesopa account' : 'Sign in to Vesopa'),
    description: 'One Vesopa account for every Vesopa product.',
    nonce: res.locals.nonce,
    config,
    mode,
    channel,
    providers: socialProviders(),
    returnTo: safeReturnTo(req.query.return_to),
    identifier: '',
    error: '',
    noindex: true,
    settings: live,
    layout: live.login_layout,
  });
  } catch (error) {
    return next(error);
  }
});

/**
 * Developer documentation.
 *
 * Linked from the landing page and from the discovery document's
 * `service_documentation` field, so it has to resolve — an OAuth reviewer
 * follows both. It is deliberately one page of curl rather than a framework
 * tutorial: a quickstart written against one SDK teaches nothing to somebody
 * using a different one, and hides the request they will have to debug later.
 */
router.get('/docs', (req, res) => {
  res.render('docs', {
    title: 'Developer documentation',
    description: 'Integrate with Vesopa OAuth — OpenID Connect, with curl examples for every step.',
    nonce: res.locals.nonce,
    config,
    styles: ['landing', 'docs'],
  });
});

/**
 * The account area.
 *
 * Everything under /account requires a live session, and an expired one sends
 * the person to sign in again with `return_to` set so they land back where they
 * were meant to be — rather than at a generic home page having forgotten why
 * they clicked.
 */
/*
 * /account is a signpost, not a page.
 *
 * Everything it used to show now has a section of its own with the same
 * navigation, and keeping a second copy of each list here would mean two places
 * to change whenever one of them does.
 */
router.get('/account', async (req, res) => {
  const session = await sessions.load(req);
  if (!session) {
    return res.redirect(303, `/login?return_to=${encodeURIComponent('/account/profile')}`);
  }
  return res.redirect(303, '/account/profile');
});

/**
 * Accepting an invitation.
 *
 * THE LINK DOES NOT SIGN ANYBODY IN. It shows what is on offer and sends them
 * to the ordinary sign-in page; the grants are applied afterwards, and only if
 * the address they proved matches the address that was invited.
 *
 * That is the whole security of the feature. A link that signed somebody in
 * would be a password sent by email, sitting in a mailbox for a week and
 * forwardable to anybody. This way an intercepted invitation is worth nothing
 * on its own: whoever holds it must also be able to receive at the address it
 * was sent to, and at that point they never needed the link.
 */
router.get('/invite/:token', async (req, res, next) => {
  try {
    const invitation = await invitations.findByToken(req.params.token);

    if (!invitation) {
      return res.status(410).render('invite', {
        title: 'That invitation has expired',
        nonce: res.locals.nonce,
        config,
        invitation: null,
        inviteToken: req.params.token,
        state: 'expired',
        noindex: true,
      });
    }

    const session = await sessions.load(req);

    if (!session) {
      /*
       * Not signed in. Show what is on offer — an invitation with no
       * explanation is one nobody accepts — and send them to the sign-in page,
       * which is also the registration page, with the address filled in.
       */
      return res.render('invite', {
        title: 'You have been invited to Vesopa',
        nonce: res.locals.nonce,
        config,
        invitation,
        inviteToken: req.params.token,
        state: 'sign-in',
        noindex: true,
      });
    }

    const result = await invitations.accept(req.params.token, session.user_id, {
      ip: req.clientIp,
    });

    if (!result.ok && result.error === 'wrong_account') {
      /*
       * Signed in as somebody else. This is the check that stops a forwarded
       * invitation making the wrong person an administrator, so it refuses
       * rather than helpfully applying what it can.
       */
      return res.status(403).render('invite', {
        title: 'That invitation is for a different address',
        nonce: res.locals.nonce,
        config,
        invitation,
        inviteToken: req.params.token,
        state: 'wrong-account',
        noindex: true,
      });
    }

    if (!result.ok) {
      return res.status(410).render('invite', {
        title: 'That invitation has expired',
        nonce: res.locals.nonce,
        config,
        invitation: null,
        inviteToken: req.params.token,
        state: 'expired',
        noindex: true,
      });
    }

    return res.render('invite', {
      title: 'Invitation accepted',
      nonce: res.locals.nonce,
      config,
      invitation: result.invitation,
      inviteToken: req.params.token,
      state: 'accepted',
      noindex: true,
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
module.exports.safeReturnTo = safeReturnTo;
