const fs = require('fs');
const path = require('path');
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
    // The online menu (src/dinein.js menuLook): club red on a dark page over
    // the club's own lineout photograph, not The Vesopa Kitchen's lime.
    // The club's legal details and policies, for the foot of its menu (Dojo's
    // go-live checklist). The back office's own fields win when filled in.
    legal: {
      name: 'Pontardawe Rugby Football Club Limited',
      number: '10056776',
      office: 'Ynysderw Road, Pontardawe, Neath Port Talbot, SA8 4EG',
      terms: 'https://pontardawerfc.com/ordering-terms',
      privacy: 'https://pontardawerfc.com/privacy',
      refunds: 'https://pontardawerfc.com/ordering-terms#refunds',
      contact: 'https://pontardawerfc.com/contact',
    },
    menu: {
      page: '#1A0606', card: '#2A0B0B', ink: '#FFF4F2', inkSoft: '#E3C2BE',
      photo: '/assets/venues/pontardawe-rfc/menu-photo.jpg',
      logo: '/assets/venues/pontardawe-rfc/crest.png',
    },
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
  'loughor-rfc': {
    // Loughor RFC, the Blues (owner, 2026-11-18/19): royal blue and gold from
    // the club's own crest (LoughorRFC/brand), set like Pontardawe's.
    club: '#1238A8', deep: '#071A52', glow: '#2F62E0', font: 'montserrat',
    // The Wallet card's labels: the crest's gold.
    label: '#F5C518',
    legal: {
      name: 'Loughor RFC (1882) Limited',
      number: '13489973',
      office: 'Villa Field, Belgrave Road, Loughor, Swansea, SA4 6RF',
      terms: 'https://loughorrfc.site/ordering-terms',
      privacy: 'https://loughorrfc.site/privacy',
      refunds: 'https://loughorrfc.site/ordering-terms#refunds',
      contact: 'https://loughorrfc.site/contact',
    },
    menu: {
      page: '#060B1F', card: '#0D1533', ink: '#EEF2FF', inkSoft: '#C3CCEA',
      photo: '/assets/venues/loughor-rfc/wallet-hero.png',
      logo: '/assets/venues/loughor-rfc/crest.png',
    },
    name: 'Loughor RFC',
    website: 'https://loughorrfc.site', phone: '01792 894109', email: 'info@loughorrfc.site',
    // The apps' public tests (owner, 2026-11-19): TestFlight's public link and
    // Google Play's open testing, until they are in the stores.
    ios_app: 'https://testflight.apple.com/join/tegkU2kN',
    android_app: 'https://play.google.com/apps/testing/com.vesopaepos.loughorrfc',
    web: 'node',
    art: '/assets/venues/loughor-rfc/',
    // The club's Google Wallet passes (owner, 2026-11-19). Class ids read as
    // the club's own; links to loughorrfc.com (loughorrfc.site is only for
    // testing) and vesopaepos.com; the ground for Google Maps (club.json);
    // Smart Tap for "hold near reader"; Google's save/delete callbacks to
    // the back office (wallet.js). Read by wallet_google.js buildPass.
    google: {
      classIds: { loyalty: 'com.loughorrfc.loyalty', customer: 'com.loughorrfc.customers' },
      links: [
        { uri: 'https://loughorrfc.com', description: 'Loughor RFC', id: 'club' },
        { uri: 'https://vesopaepos.com', description: 'Vesopa EPOS', id: 'vesopa' },
      ],
      homepage: { uri: 'https://loughorrfc.com', description: 'Loughor RFC' },
      locations: [{ latitude: 51.6627, longitude: -4.0655 }],
      wordmark: 'https://backoffice.vesopaepos.com/assets/venues/loughor-rfc/wallet-wordmark.png',
      images: [{
        uri: 'https://backoffice.vesopaepos.com/assets/venues/loughor-rfc/wallet-banner.png',
        description: "Loughor RFC, Villa Field, est. 1882: members' card",
      }],
      texts: [
        ['The club', 'Loughor RFC, the Blues. Rugby at Villa Field, Belgrave Road, Loughor, since 1882.'],
        ['Using your card', 'Show the QR code at the bar, or hold your phone near the reader where the bar has one.'],
        ['Points', 'Your points balance shows on the front of the card and updates after each visit.'],
        ['Contact', '01792 894109 · info@loughorrfc.site'],
      ],
      messages: [
        { id: 'welcome', header: 'Welcome to Loughor RFC', body: 'Thanks for joining. Show this card at the bar; your points balance updates here after each visit.' },
      ],
      // As Pontardawe RFC's card: points on the face, the tier beside them.
      loyalty: { accountNameLabel: 'Member', accountIdLabel: 'Card number', rewardsTierLabel: 'Tier', rewardsTier: 'Member' },
      discoverable: { signup: 'https://member.loughorrfc.site/', signin: 'https://member.loughorrfc.site/', state: 'TRUSTED_TESTERS' },
      callbackUrl: 'https://backoffice.vesopaepos.com/wallet/google/callback',
      smartTap: true,
    },
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
 * All are the crest on nothing, `apple` too: iPad Safari shows it in the tab,
 * where a white square looked wrong (owner, 2026-10-25); a home-screen
 * bookmark of the site then shows it on black. Each carries its file's date,
 * so Safari, which keeps tab icons long after a reload, fetches a new one.
 */
function artFor(slug) {
  const look = lookFor(slug);
  if (!look || !/^\/assets\/[a-z0-9/_-]+\/$/.test(look.art || '')) return null;
  const at = (file) => {
    let v = '';
    try { v = `?v=${Math.floor(fs.statSync(path.join(__dirname, '..', 'public', look.art, file)).mtimeMs / 1000).toString(36)}`; } catch { /* not on disk */ }
    return `${look.art}${file}${v}`;
  };
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
