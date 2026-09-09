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
   * admit it — but the exception is written as narrowly as it can be: two
   * named hosts, `frame-src` for the invisible challenge iframe v3 still uses,
   * and nothing else. `connect-src` is deliberately NOT opened: the v3 script
   * talks to Google inside its own frame, and widening connect-src on the
   * origin that holds every session to save checking would be the wrong trade.
   *
   * With no site key configured the arrays are empty and the policy is exactly
   * what it was — which is the state a development machine is in, and the
   * state this server is in until somebody sets the keys.
   */
  const captchaOn = Boolean(config.captcha && config.captcha.siteKey);
  const captchaScript = captchaOn
    ? ' https://www.google.com/recaptcha/ https://www.gstatic.com/recaptcha/'
    : '';
  const captchaFrame = captchaOn ? ["frame-src https://www.google.com/recaptcha/"] : [];

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
      "connect-src 'self'",
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

  res.locals.config = config;
  res.locals.path = req.path;
  res.locals.year = new Date().getFullYear();

  next();
}

module.exports = { securityHeaders, requestContext };
