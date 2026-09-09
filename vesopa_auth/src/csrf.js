/**
 * Cross-site request forgery protection, on every form post including this one.
 *
 * "INCLUDING THIS ONE" IS THE POINT. Login CSRF gets skipped more often than
 * any other control, on the reasoning that there is no session yet so there is
 * nothing to protect. There is: an attacker who can make your browser log in to
 * *their* account silently owns what you do next. Everything you then save —
 * a linked Google account, a phone number, a card — is saved into an account
 * they can open. The consent screen has the mirror-image problem: a forged POST
 * to /consent grants an application access without the person ever seeing the
 * screen.
 *
 * SameSite=Lax already stops the simple version of both. It is not enough on
 * its own: it is a browser default that can be relaxed, it does not cover a
 * top-level POST from a form in some cases, and it is the same origin's problem
 * if any subdomain is ever compromised. A synchroniser token is the control;
 * SameSite is the second layer.
 *
 * THE DOUBLE-SUBMIT SHAPE, and why it fits here. The classic pattern keeps the
 * token in the session, but the login form is served before there is a session.
 * So the token lives in its own cookie and is echoed in a hidden field, and the
 * two must match. That is secure as long as an attacker cannot write cookies on
 * this origin — which `__Host-` guarantees by refusing any cookie carrying a
 * Domain attribute, closing the sibling-subdomain hole that makes plain
 * double-submit weak.
 */

const config = require('./config');
const { newToken, safeEqual } = require('./crypto');

const COOKIE = config.isProduction ? '__Host-vesopa_csrf' : 'vesopa_csrf';

/**
 * Make sure a token exists, and expose it to the templates.
 *
 * Not HttpOnly — deliberately. The page has to be able to read it for a fetch()
 * request, and the token is not a credential: knowing it is useless without
 * also being on this origin, which is the thing the attacker does not have.
 */
function issue(req, res, next) {
  let token = req.cookies ? req.cookies[COOKIE] : null;
  if (!token || token.length < 20) {
    token = newToken(24);
    res.cookie(COOKIE, token, {
      httpOnly: false,
      secure: config.isProduction,
      sameSite: 'lax',
      path: '/',
    });
  }
  req.csrfToken = token;
  res.locals.csrfToken = token;
  next();
}

/**
 * Refuse a POST whose token does not match its cookie.
 *
 * A missing cookie is a failure, not a pass. The tempting mistake is to skip
 * the check when there is no cookie to compare against — which hands every
 * attacker a way to pass the check by arranging for no cookie to be sent.
 */
function verify(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    return next();
  }

  const cookie = req.cookies ? req.cookies[COOKIE] : null;
  const submitted =
    (req.body && (req.body._csrf || req.body.csrf_token)) ||
    req.get('x-csrf-token') ||
    '';

  if (!cookie || !submitted || !safeEqual(cookie, submitted)) {
    /*
     * The commonest innocent cause of this is a login page left open for a day
     * in a tab, so the message says what to do rather than accusing anybody of
     * anything. It is still a hard refusal.
     */
    res.status(403);
    if (req.accepts('html')) {
      return res.render('error', {
        title: 'Please try again',
        heading: 'That form had gone stale',
        message:
          'For your security we could not accept it. Go back to sign in and try once more.',
        config,
        nonce: res.locals.nonce,
        noindex: true,
      });
    }
    return res.json({ error: 'invalid_csrf_token' });
  }

  return next();
}

module.exports = { issue, verify, COOKIE };
