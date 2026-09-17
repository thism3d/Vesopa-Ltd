/**
 * Headers every page gets, and the limits a public shop needs.
 *
 * THE CONTENT SECURITY POLICY IS STRICT, and the templates are written for it:
 * no inline script, no style="" attribute anywhere. A venue's colour reaches the
 * page as CSS custom properties in one <style> block carrying this request's
 * nonce -- the pattern auth.vesopa.com settled on after its CSP silently threw
 * away every style attribute on a page.
 *
 * Two outside origins are named, and why:
 *
 *   img-src / font-src   the back office, which serves a venue's own logo,
 *                        photograph and fonts -- under its own name and as
 *                        menu.vesopaepos.com (BRAND_ORIGINS)
 *   form-action          pay.dojo.tech, because the buy form's POST answers
 *                        with a redirect to Dojo's checkout page and Chrome
 *                        applies form-action to that redirect too
 */

const crypto = require('crypto');

// The back office whose logos, photographs and fonts a shop shows. Staging and a
// local run point it at their own back office.
const BACKOFFICE = (process.env.BACKOFFICE_ORIGIN || 'https://backoffice.vesopaepos.com').replace(/\/+$/, '');
// The same server answers as the menu host too, and the EPOS hands out branding
// on either name: the test venue's logo and the fallback favicon both came back
// on menu.vesopaepos.com, and the first live page blocked them.
const BRAND = [...new Set([
  BACKOFFICE,
  ...String(process.env.BRAND_ORIGINS || 'https://menu.vesopa.com https://menu.vesopaepos.com').split(/\s+/).filter(Boolean),
])].join(' ');

function headers(req, res, next) {
  const nonce = crypto.randomBytes(16).toString('base64');
  res.locals.nonce = nonce;
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    `style-src 'self' 'nonce-${nonce}'`,
    `img-src 'self' data: ${BRAND}`,
    `font-src 'self' ${BRAND}`,
    "connect-src 'self'",
    "media-src 'self' blob:",
    `form-action 'self' https://pay.dojo.tech`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
  ].join('; '));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(self)');
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  next();
}

/**
 * A fixed-window limiter per key. In memory: a restart forgiving everybody is
 * fine, and a table written on every balance check is not.
 */
function limiter({ perMinute, key = (req) => req.ip }) {
  const windows = new Map();
  return (req, res, next) => {
    const k = key(req);
    const now = Date.now();
    const w = windows.get(k);
    if (!w || now - w.start >= 60000) {
      windows.set(k, { start: now, count: 1 });
      if (windows.size > 10000) {
        for (const [kk, v] of windows) if (now - v.start >= 60000) windows.delete(kk);
      }
      return next();
    }
    w.count += 1;
    if (w.count > perMinute) {
      res.setHeader('Retry-After', '60');
      return res.status(429).render('shop/message', {
        title: 'Slow down a little',
        heading: 'Slow down a little',
        body: 'That was a lot of tries in a minute. Wait a moment and try again.',
      });
    }
    next();
  };
}

module.exports = { headers, limiter, BACKOFFICE };
