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

/*
 * A VENUE'S OWN ADDRESS (2026-10-10). Pontardawe RFC: "member.pontardawerfc.com
 * would be the new URL for pontardawe rfc membership program, not the
 * loyalty.vesopa.com". The same app and the same process, at the root of a
 * host that belongs to one venue:
 *
 *   LOYALTY_VENUE_HOSTS=member.pontardawerfc.com=pontardawe-rfc[,host=slug...]
 *
 * On that host `/` is the venue's app (there is nobody else's to choose), the
 * API, uploads, wallet links and the Continue with Vesopa callback pass
 * through as they do on loyalty.vesopa.com, and the back office is not
 * reachable. loyalty.vesopa.com/<slug>/ and the older /app/<slug>/ send a
 * member there with a permanent redirect, so cards, QR codes and saved icons
 * keep working. Unset, nothing changes.
 */
function parseVenueHosts(raw) {
  const hosts = new Map();
  for (const pair of String(raw || '').split(',')) {
    const [host, slug] = pair.split('=').map((x) => String(x || '').trim().toLowerCase());
    if (host && slug && SLUG.test(slug) && /^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) hosts.set(host, slug);
  }
  return hosts;
}
const VENUE_HOSTS = parseVenueHosts(process.env.LOYALTY_VENUE_HOSTS);
const HOST_OF_SLUG = new Map([...VENUE_HOSTS].map(([host, slug]) => [slug, host]));

// Paths on the loyalty host that are not a venue.
// /wallet/c/ and /wallet/s/ are a member's own card as an Apple or Google Wallet
// pass: the app hands out a short-lived link on this name (loyalty_app.js,
// /loyalty/v1/me/wallet) rather than sending anybody to the back office's.
// And what a venue's screens read (2026-10-13). A kitchen screen set up with
// the club's member address (member.pontardawerfc.com) was sent the members'
// home page for /api/kitchen/board and showed "FormatException: Unexpected
// character". Only the screens' own routes, each with its own sign-in check:
// the back office itself stays unreachable on a venue's host.
const PASS = ['/activity/v1/', '/loyalty/v1/', '/privacy/v1/', '/uploads/', '/assets/', '/app/vesopa/', '/wallet/c/', '/wallet/s/',
  '/api/kitchen/', '/api/display/', '/api/terminal/', '/api/till/', '/api/till-settings/public', '/api/allergens',
  '/api/licence/', '/till/', '/ws'];

/** Words no venue may take as its address, because the paths above use them. */
const RESERVED = new Set([
  'app', 'api', 'loyalty', 'privacy', 'uploads', 'assets', 'health', 'admin',
  'static', 'www', 'vesopa', 'auth', 'login', 'help', 'support', 'wallet',
]);

function hostOf(req) {
  return String(req.headers.host || '').split(':')[0].toLowerCase();
}

/** The app's path for a venue, as the page being served should write it. */
function appPath(req, slug) {
  if (req.loyaltyVenueHost && req.loyaltyVenueHost === String(slug).toLowerCase()) return '/';
  const onLoyalty = req.loyaltyHost || (LOYALTY_HOST && hostOf(req) === LOYALTY_HOST);
  return onLoyalty ? `/${slug}/` : `/app/${slug}/`;
}

/** The app's public address, for links that leave the page: emails, the back office, notifications. */
function appUrl(slug) {
  const own = HOST_OF_SLUG.get(String(slug || '').toLowerCase());
  if (own) return `https://${own}/`;
  if (LOYALTY_HOST) return `https://${LOYALTY_HOST}/${slug}/`;
  return `https://${(process.env.MENU_HOST || 'menu.vesopaepos.com').trim()}/app/${slug}/`;
}

/** The host Vesopa Auth sends a web sign-in back to. */
function callbackHost() {
  return LOYALTY_HOST || (process.env.MENU_HOST || 'menu.vesopaepos.com').trim();
}

const { notFoundPage } = require('./not_found');
// A wrong address on loyalty.vesopa.com used to be one unstyled sentence
// with nothing to press. Now it looks like the site and offers the way back.
const NOT_FOUND = notFoundPage({
  product: 'Loyalty',
  home: '/',
  homeLabel: 'Back to loyalty.vesopa.com',
  title: 'There is no app at this address',
  message: 'A venue’s loyalty app lives at loyalty.vesopa.com/<venue>. Check the name on the card or the link you were sent — a letter out and the app is not found.',
  links: [['Try the demo app', '/thevesopakitchen/'], ['Get an app for your venue', '/#pricing']],
});

/** A venue's own app host: the whole host is that one venue's app. */
function venueHostGate(req, res, next, slug) {
  const [path, qs] = req.url.split('?');
  const query = qs ? `?${qs}` : '';
  // Marked even when passing through, so the sign-in callback sends the
  // member back to `/` on this host rather than to the shared address.
  req.loyaltyVenueHost = slug;
  if (path === '/health' || PASS.some((p) => path.startsWith(p))) return next();
  if (path === '/robots.txt') {
    return res.type('text/plain').send(`User-agent: *\nAllow: /\nSitemap: https://${hostOf(req)}/sitemap.xml\n`);
  }
  if (path === '/sitemap.xml') {
    return res.type('application/xml').send('<?xml version="1.0" encoding="UTF-8"?>\n'
      + `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://${hostOf(req)}/</loc></url></urlset>`);
  }
  // The address it used to have, typed onto the new host by habit.
  const old = path.match(/^\/(?:app\/)?([^/]+)(\/.*)?$/);
  if (old && old[1] === slug) return res.redirect(301, `${old[2] || '/'}${query}`);
  req.loyaltyHost = true;
  req.url = `/app/${slug}${req.url}`;
  return next();
}

/*
 * WHICH APPS MAY USE THIS SITE'S PASSKEYS. A passkey belongs to a domain; iOS
 * lets an app use one only when the app's entitlements name the domain AND the
 * domain names the app, here. Android reads assetlinks.json the same way.
 *
 *   LOYALTY_IOS_APPS      TEAMID.bundle.id, comma separated
 *   LOYALTY_ANDROID_APPS  package=SHA256:FINGERPRINT, comma separated (the
 *                         Play app signing key's fingerprint)
 */
function iosApps() {
  return String(process.env.LOYALTY_IOS_APPS
    || 'G238FR2ZC9.com.vesopaepos.pontardawerfc,G238FR2ZC9.com.vesopaepos.thevesopakitchen,G238FR2ZC9.com.vesopaepos.loughorrfc')
    .split(',').map((s) => s.trim()).filter(Boolean);
}

/*
 * THE CLUB'S APP OPENS ITS MEMBERS' SITE (owner, 2026-11-19: deep links, "the
 * members' site and /app"). Each venue host names its own club's app only:
 * the bundle from APNS_TOPICS (slug=bundle, which is also the Android
 * package), so a link to member.loughorrfc.site never opens Pontardawe's app.
 * Android's fingerprints: LOYALTY_ANDROID_APPS, plus the ones already known
 * for a club whose app is not to be rebuilt (Pontardawe RFC, owner,
 * 2026-11-19: "Pontardawe RFC app do not update for now").
 *   APPLE_TEAM_ID  default G238FR2ZC9
 */
const KNOWN_PRINTS = {
  'com.vesopaepos.pontardawerfc': [
    'A3:03:9D:73:74:E8:1B:10:4D:85:9F:7B:A4:4A:AD:7D:74:31:C3:BB:C6:E4:CE:51:43:FF:47:B3:59:10:C3:82',
    '5C:EC:AE:76:20:51:1B:62:94:4C:90:B4:97:C5:C5:58:04:8B:93:3B:77:9F:1A:44:DF:DF:50:E4:35:74:6B:70',
    '62:1C:0C:07:ED:FA:54:CC:22:DD:B8:44:55:A6:E6:74:99:F5:6C:31:A0:4B:E4:FE:AA:9D:F6:4A:9C:65:46:39',
    '6B:3B:C0:9A:7D:D4:1F:62:D1:9F:C0:F9:2B:7E:52:8B:A0:92:05:42:6F:21:21:49:0F:0A:60:B8:F9:54:43:74',
  ],
};

/** The venue's own app (its bundle id, which is its Android package too). */
function venueBundle(slug) {
  for (const pair of String(process.env.APNS_TOPICS || '').split(',')) {
    const [venue, bundle] = pair.split('=').map((x) => (x || '').trim());
    if (venue && bundle && venue === slug) return bundle;
  }
  return null;
}

function androidApps() {
  const prints = new Map(Object.entries(KNOWN_PRINTS).map(([pkg, list]) => [pkg, new Set(list)]));
  for (const pair of String(process.env.LOYALTY_ANDROID_APPS || '').split(',')) {
    const [pkg, print] = pair.split('=').map((x) => (x || '').trim());
    if (!pkg || !/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/i.test(print || '')) continue;
    if (!prints.has(pkg)) prints.set(pkg, new Set());
    prints.get(pkg).add(print.toUpperCase());
  }
  return [...prints].map(([pkg, set]) => ({
    relation: ['delegate_permission/common.get_login_creds', 'delegate_permission/common.handle_all_urls'],
    target: { namespace: 'android_app', package_name: pkg, sha256_cert_fingerprints: [...set] },
  }));
}

function wellKnown(req, res) {
  const path = req.url.split('?')[0];
  if (path === '/.well-known/apple-app-site-association') {
    const body = { webcredentials: { apps: iosApps() } };
    const bundle = venueBundle(VENUE_HOSTS.get(hostOf(req)));
    if (bundle) {
      body.applinks = {
        details: [{
          appIDs: [`${process.env.APPLE_TEAM_ID || 'G238FR2ZC9'}.${bundle}`],
          components: [{ '/': '/*', comment: "The members' site opens the club's app" }],
        }],
      };
    }
    res.type('application/json').set('Cache-Control', 'public, max-age=3600').send(JSON.stringify(body));
    return true;
  }
  if (path === '/.well-known/assetlinks.json') {
    res.type('application/json').set('Cache-Control', 'public, max-age=3600').send(JSON.stringify(androidApps()));
    return true;
  }
  return false;
}

/*
 * FIREBASE'S PAGES ON THE VENUE'S OWN ADDRESS (owner, 2026-10-25: "never falls
 * back to vesopa.firebaseapp.com"). When a phone cannot prove the app with
 * Firebase's silent push, Firebase opens its check page at the auth domain,
 * /__/auth/handler. The apps and the members' site name the venue's host as
 * that domain (FIREBASE_AUTH_DOMAIN; member_web_views.js), and this passes
 * those paths through to Firebase unchanged, as Firebase's own guide does with
 * a proxy. The host must be in Firebase's authorised domains (it is).
 *   FIREBASE_AUTH_ORIGIN  default https://vesopa.firebaseapp.com
 */
const https = require('https');
const FIREBASE_AUTH_ORIGIN = new URL(process.env.FIREBASE_AUTH_ORIGIN || 'https://vesopa.firebaseapp.com');

function firebasePages(req, res) {
  if (!/^\/__\/(auth|firebase)\//.test(req.url)) return false;
  if (!VENUE_HOSTS.has(hostOf(req)) && hostOf(req) !== LOYALTY_HOST) return false;
  const headers = { ...req.headers, host: FIREBASE_AUTH_ORIGIN.host };
  delete headers.cookie; delete headers['x-forwarded-for']; delete headers.connection;
  const upstream = https.request({
    host: FIREBASE_AUTH_ORIGIN.hostname, port: 443, method: req.method, path: req.url, headers, timeout: 15000,
  }, (up) => {
    const h = { ...up.headers };
    delete h['set-cookie'];
    res.writeHead(up.statusCode || 502, h);
    up.pipe(res);
  });
  upstream.on('timeout', () => upstream.destroy(new Error('timeout')));
  upstream.on('error', () => { if (!res.headersSent) res.status(502).type('text/plain').send('Sign-in check unavailable. Please try again.'); else res.end(); });
  req.pipe(upstream);
  return true;
}

function loyaltyHostGate() {
  return (req, res, next) => {
    if (wellKnown(req, res)) return;
    if (firebasePages(req, res)) return;
    const own = VENUE_HOSTS.get(hostOf(req));
    if (own) return venueHostGate(req, res, next, own);
    if (!LOYALTY_HOST) return next();
    const [path, qs] = req.url.split('?');
    const query = qs ? `?${qs}` : '';
    const old = path.match(/^\/app\/([^/]+)(\/.*)?$/);

    if (hostOf(req) !== LOYALTY_HOST) {
      // The old address. /app/vesopa/* is the sign-in callback, still in flight
      // for anybody who started signing in before the move.
      if (old && old[1] !== 'vesopa' && SLUG.test(old[1])) {
        const home = HOST_OF_SLUG.get(old[1]);
        return res.redirect(301, home
          ? `https://${home}${old[2] || '/'}${query}`
          : `https://${LOYALTY_HOST}/${old[1]}${old[2] || '/'}${query}`);
      }
      return next();
    }

    if (path === '/health' || PASS.some((p) => path.startsWith(p))) return next();
    // The public page and its editor (src/loyalty_site.js).
    if (path === '/' || path === '/privacy' || path === '/privacy-choices' || path === '/support' || path === '/sitemap.xml' || path === '/admin' || path.startsWith('/admin/')) return next();
    if (path === '/robots.txt') {
      return res.type('text/plain').send(`User-agent: *\nDisallow: /admin\nAllow: /\nSitemap: https://${LOYALTY_HOST}/sitemap.xml\n`);
    }
    if (old && SLUG.test(old[1])) return res.redirect(301, `/${old[1]}${old[2] || '/'}${query}`);

    const venue = path.match(/^\/([^/]+)(\/.*)?$/);
    // A venue that has moved to its own address is sent there, deep link and all.
    if (venue && HOST_OF_SLUG.has(venue[1])) {
      return res.redirect(301, `https://${HOST_OF_SLUG.get(venue[1])}${venue[2] || '/'}${query}`);
    }
    if (venue && SLUG.test(venue[1]) && !RESERVED.has(venue[1])) {
      if (!venue[2]) return res.redirect(301, `/${venue[1]}/${query}`);
      req.loyaltyHost = true;
      req.url = `/app${req.url}`;
      return next();
    }
    return res.status(404).type('html').send(NOT_FOUND);
  };
}

/** The host a request arrived on, when it is a venue's own app host; else null. */
function venueHostOf(req) {
  return VENUE_HOSTS.has(hostOf(req)) ? hostOf(req) : null;
}

module.exports = {
  loyaltyHostGate, appPath, appUrl, callbackHost, venueHostOf, parseVenueHosts,
  RESERVED, LOYALTY_HOST, NOT_FOUND,
};
