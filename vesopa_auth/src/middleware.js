/**
 * The headers and the per-request facts every route depends on.
 */

const crypto = require('crypto');
const config = require('./config');

/**
 * Security headers, set on everything.
 *
 * The threat a login page faces that an ordinary page does not is being framed
 * or scripted by somebody else's site: a consent screen inside an invisible
 * iframe is a click the person did not mean to make, and one injected script on
 * this origin reads the password out of the form. So the two controls that
 * matter most are `frame-ancestors 'none'` and a `script-src` that permits
 * nothing but this origin's own files.
 *
 * A NONCE, NOT 'unsafe-inline'. Every page here needs one very small inline
 * script — the one that applies the saved colour scheme before first paint, so
 * the page does not flash white at somebody signing in at night. Allowing
 * inline scripts wholesale to get that would undo the whole policy; a
 * per-response nonce allows exactly the script we wrote and nothing an attacker
 * manages to inject.
 */
function securityHeaders(req, res, next) {
  const nonce = crypto.randomBytes(16).toString('base64');
  res.locals.nonce = nonce;

  /*
   * reCAPTCHA needs three exceptions, and only when it is switched on.
   *
   * The token can only be minted by Google's own code, so `script-src` has to
   * admit it, `frame-src` has to admit the invisible challenge frame v3 still
   * uses, and `connect-src` has to admit the one request the script makes back
   * to Google while it is scoring.
   *
   * THE THIRD ONE WAS LEFT OUT ON PURPOSE, AND THAT WAS A MISTAKE. The note
   * here used to say the script talks to Google inside its own frame, so
   * connect-src did not need opening. Measured in a browser, it does not: every
   * sign-in logged
   *
   *   Connecting to 'https://www.google.com/recaptcha/api2/clr' violates the
   *   following Content Security Policy directive: "connect-src 'self'"
   *
   * A token was still minted, so nothing was visibly broken — which is the
   * worst version of this: a policy violation on the sign-in page, in every
   * visitor's console, that nobody has a reason to investigate. And a refused
   * request is a signal Google does not get, on the exact call whose purpose is
   * to decide whether this is a person.
   *
   * The exception is one path prefix on one host that `script-src` already
   * admits. `connect-src` was worth defending because this origin holds every
   * session; it is not made meaningfully weaker by allowing the same host the
   * script itself comes from, and it is made honest.
   *
   * With no site key configured every one of these is empty and the policy is
   * exactly what it was — the state of a development machine, and of this
   * server until somebody sets the keys.
   */
  const captchaOn = Boolean(config.captcha && config.captcha.siteKey);
  const captchaScript = captchaOn
    ? ' https://www.google.com/recaptcha/ https://www.gstatic.com/recaptcha/'
    : '';
  const captchaConnect = captchaOn ? ' https://www.google.com/recaptcha/' : '';
  const captchaFrame = captchaOn ? ['frame-src https://www.google.com/recaptcha/'] : [];

  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'none'",
      `script-src 'self' 'nonce-${nonce}'${captchaScript}`,
      // Styles are all in files; the nonce covers the theme variables block.
      `style-src 'self' 'nonce-${nonce}'`,
      // data: is needed for the TOTP enrolment QR code, which is generated in
      // the page rather than fetched — the secret must not travel as a URL.
      "img-src 'self' data:",
      "font-src 'self'",
      `connect-src 'self'${captchaConnect}`,
      // manifest-src falls back to default-src, which is 'none' — so without
      // this line the web app manifest is refused and the site can never be
      // installed. It fails silently in the console, not on the page.
      "manifest-src 'self'",
      // Where a form may post. 'self' only: an injected form that posts the
      // password to another origin is otherwise perfectly legal HTML.
      "form-action 'self'",
      ...captchaFrame,
      "base-uri 'none'",
      "frame-ancestors 'none'",
      "object-src 'none'",
      ...(config.isProduction ? ['upgrade-insecure-requests'] : []),
    ].join('; '),
  );

  // Belt and braces with frame-ancestors, for anything that predates CSP.
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // No referrer at all. A URL here can carry a login_hint, a return_to, or a
  // one-time code, and none of that should reach the site somebody clicks to.
  res.setHeader('Referrer-Policy', 'no-referrer');

  res.setHeader(
    'Permissions-Policy',
    // publickey-credentials-get is what WebAuthn needs, and it must be allowed
    // for this origin or passkeys silently fail to appear.
    'accelerometer=(), camera=(), geolocation=(), microphone=(), payment=(), ' +
      'publickey-credentials-get=(self), publickey-credentials-create=(self)',
  );

  if (config.isProduction) {
    res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  }

  // Nothing this service returns should ever sit in a shared cache.
  res.setHeader('Cache-Control', 'no-store');

  next();
}

/**
 * The facts about the caller that the audit log and the rate limiter need.
 *
 * `req.ip` is trustworthy only because `trust proxy` is set to 1 in server.js —
 * one hop, nginx, which we control. If that were `true`, a client could put any
 * address it liked in X-Forwarded-For and choose its own identity for the rate
 * limiter, which is the same as having no rate limiter.
 */
function requestContext(req, res, next) {
  req.clientIp = (req.ip || '').replace(/^::ffff:/, '').slice(0, 45);
  req.userAgent = String(req.get('user-agent') || '').slice(0, 400);

  /*
   * A REDIRECT THE ROUTER CAN SEE.
   *
   * The owner's complaint was that the browser's own loading bar appears —
   * *"no loading should be on browser only load the Vesopa loading bar"*. The
   * router in nav.js already handles links; what was left was forms, and a form
   * is where the waits actually are: sending a code, checking a password,
   * answering a consent screen.
   *
   * A form cannot be fetched naively, because almost every one of these routes
   * answers `303 See Other` and `fetch` follows a redirect silently. The
   * router would then be handed the CONTENT of the page it was sent to with no
   * way to know the address changed — so the URL bar would lie, and Back would
   * be wrong.
   *
   * So when the request says it came from the router, a redirect is answered
   * as `204` with the address in a header instead. The router reads it and
   * decides: same origin, fetch and swap and push the URL; another origin —
   * the hand-off at the end of an OAuth authorisation — a real navigation,
   * because that is genuinely leaving.
   *
   * Only the SHAPE of the answer changes, never the decision. Every check, every
   * rate limit and every audit line has already happened by the time a route
   * calls res.redirect.
   */
  if (req.get('x-vesopa-nav') === '1') {
    const sendRedirect = res.redirect.bind(res);
    res.redirect = function navRedirect(statusOrUrl, maybeUrl) {
      const url = typeof statusOrUrl === 'string' ? statusOrUrl : maybeUrl;
      if (typeof url !== 'string') return sendRedirect(statusOrUrl, maybeUrl);
      res.setHeader('X-Vesopa-Location', url);
      return res.status(204).end();
    };
  }

  res.locals.config = config;
  res.locals.path = req.path;
  res.locals.year = new Date().getFullYear();

  next();
}

module.exports = { securityHeaders, requestContext };
