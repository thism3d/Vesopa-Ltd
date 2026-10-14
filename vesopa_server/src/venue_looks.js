/**
 * A venue's own look in the browser (2026-10-11).
 *
 * Pontardawe RFC: member.pontardawerfc.com "should align with the app sign in
 * and other options". The club's own phone app is drawn in the club's colours
 * and typeface, in the device's light or dark mode, with the colour moving
 * behind the sign-in page (vesopa_loyalty/lib/data/venue_style.dart). Its
 * build gets those from PontardaweRFC/venue.json as dart-defines. The web app
 * is one build for every venue and has no defines, so the page tells it:
 * the server writes the look into the page (loyalty_app.js) and the app reads
 * it at start (lib/platform/page_venue_web.dart).
 *
 * Keep these the same as the venue's venue.json "colours". `art` is the
 * folder of the venue's own icons under public/ (see artFor). `font` is a
 * built-in family from public/assets/fonts, used when the venue has not
 * chosen fonts of its own in the back office; `website`, `phone` and `email` fill the
 * app's links the same way.
 *
 * `web: 'node'` serves the venue's members' site as server-rendered pages
 * (src/member_web.js) instead of the Flutter web build: the owner, 2026-10-11,
 * "for the web app can we use node application not the flutter one and zero
 * loading". Without it the venue keeps the Flutter build exactly as before.
 *
 * A venue not listed here looks exactly as it always did.
 */
'use strict';

const LOOKS = {
  'pontardawe-rfc': {
    club: '#8F0000', deep: '#3F0000', glow: '#C41414', font: 'montserrat',
    // The name on its cards (Wallet), unless the back office sets one.
    name: 'Pontardawe RFC',
    // The club's own website, which shares these colours and this typeface.
    // Filled in only where the back office has no link of its own.
    website: 'https://pontardawerfc.com', phone: '01792 864811', email: 'info@pontardawerfc.com',
    // The club's own phone app (owner 2026-10-12): the web app shows the
    // official store badges for these at the bottom of every page.
    ios_app: 'https://testflight.apple.com/join/cWqDESsD',
    android_app: 'https://play.google.com/store/apps/details?id=com.vesopaepos.pontardawerfc',
    web: 'node',
    // The club's crest on nothing, as its phone app's icon is: the members'
    // site's favicon, home-screen and install icons, and the logo at the top
    // of its pages, ahead of whatever the back office holds (owner,
    // 2026-10-12: "only the crest, without the background, everywhere").
    // Drawn by vesopa_loyalty/tool/make_venue_art.py into public/.
    art: '/assets/venues/pontardawe-rfc/',
  },
};

const HEX = /^#[0-9a-fA-F]{6}$/;

/** The venue's look, or null. */
function lookFor(slug) {
  const look = LOOKS[String(slug || '').toLowerCase()];
  if (!look || ![look.club, look.deep, look.glow].every((c) => HEX.test(c))) return null;
  return look;
}

/** The meta tag the app reads its look from, or ''. Values are fixed hex, nothing to escape. */
function pageMeta(slug) {
  const look = lookFor(slug);
  return look ? `<meta name="vesopa-look" content="${look.club},${look.deep},${look.glow}">` : '';
}

/** Whether the venue's members' site is the server-rendered one (src/member_web.js). */
function nodeWeb(slug) {
  const look = lookFor(slug);
  return !!(look && look.web === 'node');
}

/**
 * The venue's own icons, as paths on this server, or null.
 *
 * `apple` is on white: an iPhone fills a transparent home-screen icon with
 * black. Everything else is the crest on nothing.
 */
function artFor(slug) {
  const look = lookFor(slug);
  if (!look || !/^\/assets\/[a-z0-9/_-]+\/$/.test(look.art || '')) return null;
  const at = (file) => `${look.art}${file}`;
  return {
    crest: at('crest.png'),
    favicon: at('favicon-32.png'),
    apple: at('apple-touch-icon.png'),
    icon192: at('icon-192.png'),
    icon512: at('icon-512.png'),
    maskable512: at('maskable-512.png'),
  };
}

module.exports = { lookFor, pageMeta, nodeWeb, artFor, LOOKS };
