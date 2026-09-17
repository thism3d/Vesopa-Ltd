/**
 * loyalty.vesopa.com — where every venue's loyalty app lives.
 *
 *   https://loyalty.vesopa.com/<venue>/     the app (e.g. /thevesopakitchen/)
 *   https://loyalty.vesopa.com/loyalty/v1/  its API
 *
 * THE MOVE (owner's decision, 2026-09-17). The app used to be a path on the
 * menu domain, menu.vesopaepos.com/app/<venue>/. It is the same Node process
 * and the same build; only the address a member sees has changed. So this is a
 * gate at the front of the back office, not a second app:
 *
 *   on LOYALTY_HOST   /<venue>/…  is served as the app (rewritten internally to
 *                     the /app/<venue>/… routes in loyalty_app.js, with
 *                     req.loyaltyHost set so the page is written with the new
 *                     base); the API, privacy calls, uploads and the Continue
 *                     with Vesopa callback pass straight through; the back
 *                     office itself is NOT reachable on this name
 *   everywhere else   /app/<venue>/… is answered with a permanent redirect to
 *                     the new address, so every old link, QR code and saved
 *                     home-screen icon still lands somewhere
 *
 * Unset LOYALTY_HOST and nothing here does anything: the app is served at the
 * old address exactly as before.
 */

const LOYALTY_HOST = String(process.env.LOYALTY_HOST || '').trim().toLowerCase();
const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,62}[a-z0-9])?$/;

// Paths on the loyalty host that are not a venue.
const PASS = ['/loyalty/v1/', '/privacy/v1/', '/uploads/', '/assets/', '/app/vesopa/'];

/** Words no venue may take as its address, because the paths above use them. */
const RESERVED = new Set([
  'app', 'api', 'loyalty', 'privacy', 'uploads', 'assets', 'health', 'admin',
  'static', 'www', 'vesopa', 'auth', 'login', 'help', 'support',
]);

function hostOf(req) {
  return String(req.headers.host || '').split(':')[0].toLowerCase();
}

/** The app's path for a venue, as the page being served should write it. */
function appPath(req, slug) {
  const onLoyalty = req.loyaltyHost || (LOYALTY_HOST && hostOf(req) === LOYALTY_HOST);
  return onLoyalty ? `/${slug}/` : `/app/${slug}/`;
}

/** The app's public address, for links that leave the page: emails, the back office, notifications. */
function appUrl(slug) {
  if (LOYALTY_HOST) return `https://${LOYALTY_HOST}/${slug}/`;
  return `https://${(process.env.MENU_HOST || 'menu.vesopaepos.com').trim()}/app/${slug}/`;
}

/** The host Vesopa Auth sends a web sign-in back to. */
function callbackHost() {
  return LOYALTY_HOST || (process.env.MENU_HOST || 'menu.vesopaepos.com').trim();
}

const NOT_FOUND = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
  + '<title>Not found</title><p style="font-family:system-ui,sans-serif;padding:32px">There is no app at this address.</p>';

function loyaltyHostGate() {
  return (req, res, next) => {
    if (!LOYALTY_HOST) return next();
    const [path, qs] = req.url.split('?');
    const query = qs ? `?${qs}` : '';
    const old = path.match(/^\/app\/([^/]+)(\/.*)?$/);

    if (hostOf(req) !== LOYALTY_HOST) {
      // The old address. /app/vesopa/* is the sign-in callback, still in flight
      // for anybody who started signing in before the move.
      if (old && old[1] !== 'vesopa' && SLUG.test(old[1])) {
        return res.redirect(301, `https://${LOYALTY_HOST}/${old[1]}${old[2] || '/'}${query}`);
      }
      return next();
    }

    if (path === '/health' || PASS.some((p) => path.startsWith(p))) return next();
    // The public page and its editor (src/loyalty_site.js).
    if (path === '/' || path === '/privacy' || path === '/sitemap.xml' || path === '/admin' || path.startsWith('/admin/')) return next();
    if (path === '/robots.txt') {
      return res.type('text/plain').send(`User-agent: *\nDisallow: /admin\nAllow: /\nSitemap: https://${LOYALTY_HOST}/sitemap.xml\n`);
    }
    if (old && SLUG.test(old[1])) return res.redirect(301, `/${old[1]}${old[2] || '/'}${query}`);

    const venue = path.match(/^\/([^/]+)(\/.*)?$/);
    if (venue && SLUG.test(venue[1]) && !RESERVED.has(venue[1])) {
      if (!venue[2]) return res.redirect(301, `/${venue[1]}/${query}`);
      req.loyaltyHost = true;
      req.url = `/app${req.url}`;
      return next();
    }
    return res.status(404).type('html').send(NOT_FOUND);
  };
}

module.exports = { loyaltyHostGate, appPath, appUrl, callbackHost, RESERVED, LOYALTY_HOST };
