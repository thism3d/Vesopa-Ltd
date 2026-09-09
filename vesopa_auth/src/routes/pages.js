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
const authmethods = require('../authmethods');

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

  /*
   * WHICH APPLICATION IS THIS SIGN-IN FOR?
   *
   * `/oauth/authorize` sends people here with the whole request in `return_to`,
   * so the application — and therefore which buttons it offers and which step
   * leads — is already known. Somebody arriving at /login directly is signing
   * in to Vesopa itself and gets the administrator's defaults.
   */
  const returnTo = safeReturnTo(req.query.return_to);
  const context = await authmethods.contextFor(returnTo, live.auth_policy_default);

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
    /*
     * The buttons come from the APPLICATION now, not from whatever credentials
     * this server happens to hold. `authmethods` still filters to what can
     * actually be completed, so a row for a provider with no credentials draws
     * nothing — the owner's "keep the scope open" without the failure mode of a
     * button that leads nowhere.
     */
    providers: context.shape.providers,
    methods: context.shape,
    application: context.application,
    policy: context.policy,
    returnTo,
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
module.exports = router;
module.exports.safeReturnTo = safeReturnTo;
