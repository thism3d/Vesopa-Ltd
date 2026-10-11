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
 * Keep these the same as the venue's venue.json "colours". `font` is a
 * built-in family from public/assets/fonts, used when the venue has not
 * chosen fonts of its own in the back office; `website` and `phone` fill the
 * app's links the same way.
 *
 * A venue not listed here looks exactly as it always did.
 */
'use strict';

const LOOKS = {
  'pontardawe-rfc': {
    club: '#8F0000', deep: '#3F0000', glow: '#C41414', font: 'montserrat',
    // The club's own website, which shares these colours and this typeface.
    // Filled in only where the back office has no link of its own.
    website: 'https://pontardawerfc.com', phone: '01792 864811',
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

module.exports = { lookFor, pageMeta, LOOKS };
