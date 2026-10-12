/**
 * The page around every page: head (titles, share cards, structured data),
 * the header and its menu, the footer and the club helper's chat panel.
 */
'use strict';

const { club } = require('./content');
const { icon } = require('./icons');

const SITE = (process.env.SITE_URL || club.web.site).replace(/\/+$/, '');
const MEMBERS = (process.env.MEMBERS_URL || club.web.members).replace(/\/+$/, '');
const ASSET_VERSION = process.env.ASSET_VERSION || String(Date.now()).slice(-8);

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const NAV = [
  ['/', 'Home'],
  ['/club', 'The Club'],
  ['/teams', 'Teams'],
  ['/fixtures', 'Fixtures'],
  ['/news', 'News'],
  ['/clubhouse', 'Clubhouse'],
  ['/menu', 'Menu & Order'],
  ['/membership', 'Membership'],
  ['/contact', 'Contact'],
];

/** The club as structured data: a sports club that is also a place with a bar. */
function clubLd() {
  const a = club.address;
  return {
    '@context': 'https://schema.org',
    '@type': ['SportsClub', 'LocalBusiness'],
    '@id': `${SITE}/#club`,
    name: club.name,
    alternateName: [club.full_name, club.welsh_name],
    url: `${SITE}/`,
    logo: `${SITE}/img/crest-512.png`,
    image: `${SITE}/img/og-home.jpg`,
    description: club.short,
    sport: 'Rugby union',
    foundingDate: String(club.founded),
    telephone: club.phone_e164,
    ...(club.email ? { email: club.email } : {}),
    address: {
      '@type': 'PostalAddress',
      streetAddress: a.street,
      addressLocality: a.town,
      addressRegion: a.county,
      postalCode: a.postcode,
      addressCountry: a.country,
    },
    geo: { '@type': 'GeoCoordinates', latitude: a.lat, longitude: a.lng },
    hasMap: `https://www.openstreetmap.org/?mlat=${a.lat}&mlon=${a.lng}#map=17/${a.lat}/${a.lng}`,
    sameAs: [club.web.facebook, club.web.x, club.web.wikipedia],
    memberOf: { '@type': 'SportsOrganization', name: 'Welsh Rugby Union', url: 'https://www.wru.wales/' },
    hasMenu: `${SITE}/menu`,
    servesCuisine: 'Pub food',
    legalName: club.company.name,
    identifier: { '@type': 'PropertyValue', propertyID: 'Companies House', value: club.company.number },
  };
}

function head({ title, description, path, og = 'home', ld = [], noindex = false }) {
  const full = path === '/' ? `${club.name} | ${club.tagline}` : `${title} | ${club.name}`;
  const url = `${SITE}${path}`;
  const image = `${SITE}/img/og-${og}.jpg`;
  const graph = [clubLd(), {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    '@id': `${SITE}/#site`,
    url: `${SITE}/`,
    name: club.name,
    inLanguage: 'en-GB',
    publisher: { '@id': `${SITE}/#club` },
  }, ...ld];
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(full)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(url)}">
${noindex ? '<meta name="robots" content="noindex">' : '<meta name="robots" content="index, follow, max-image-preview:large">'}
<meta name="theme-color" content="#8F0000">
<meta name="color-scheme" content="light dark">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${esc(club.name)}">
<meta property="og:locale" content="en_GB">
<meta property="og:title" content="${esc(full)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:image" content="${esc(image)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${esc(`${club.name} crest on club red: ${title}`)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(full)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${esc(image)}">
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" type="image/png" sizes="32x32" href="/img/favicon-32.png">
<link rel="apple-touch-icon" href="/img/apple-touch-icon.png">
<link rel="manifest" href="/site.webmanifest">
<link rel="preload" href="/fonts/oswald-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/montserrat-latin-400-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/css/site.css?v=${ASSET_VERSION}">
<link rel="alternate" type="application/rss+xml" title="${esc(club.name)} news" href="/news/feed.xml">
<script>
/* Zero loading (2026-10-11): no opening screen, nothing hidden while scripts
   load. Content already on screen is shown as it is; only what is further down
   rises in as it is scrolled to (site.js). Links to other pages are fetched
   ahead when the visitor points at or presses them, so they open at once. */
document.documentElement.classList.add('js');
/* Which phone, so each visitor is shown the one app store their phone uses. */
(function(){var u=navigator.userAgent||'',d=document.documentElement;
if(/iPhone|iPad|iPod/.test(u)||(/Macintosh/.test(u)&&navigator.maxTouchPoints>1))d.classList.add('os-ios');
else if(/Android/.test(u))d.classList.add('os-android');})();
</script>
<script type="speculationrules">{"prerender":[{"where":{"and":[{"href_matches":"/*"},{"not":{"href_matches":["/api/*","/tickets/buy*","/tickets/order*"]}}]},"eagerness":"moderate"}]}</script>
<script type="application/ld+json">${JSON.stringify(graph).replace(/</g, '\\u003c')}</script>
</head>`;
}

const IOS_APP = club.web.ios_app;
const ANDROID_APP = club.web.android_app;

/**
 * The official store badges (Apple's and Google's own artwork, unaltered
 * apart from Google's transparent margin). An iPhone is shown only the App
 * Store, an Android phone only Google Play (the head script decides, before
 * anything is drawn), a computer both and a QR code for /app.
 */
function appBadges({ qr = false, cls = '' } = {}) {
  return `<div class="store-badges${cls ? ` ${cls}` : ''}">
  <a class="store-badge badge-ios" href="${esc(IOS_APP)}" rel="noopener" data-store="ios"><img src="/img/badges/app-store.svg" alt="Download on the App Store" width="120" height="40"></a>
  <a class="store-badge badge-android" href="${esc(ANDROID_APP)}" rel="noopener" data-store="android"><img src="/img/badges/google-play.png" alt="Get it on Google Play" width="135" height="40"></a>
  ${qr ? `<figure class="store-qr"><img src="/img/badges/app-qr.svg" alt="QR code: scan with your phone camera to get the app" width="96" height="96" loading="lazy"><figcaption>Scan with your phone</figcaption></figure>` : ''}
</div>`;
}

function header(path) {
  const link = ([href, label]) => {
    const on = href === '/' ? path === '/' : path === href || path.startsWith(`${href}/`);
    return `<a href="${href}"${on ? ' aria-current="page"' : ''}>${label}</a>`;
  };
  return `
<a class="skip" href="#main">Skip to content</a>
<header class="site-head" data-head><span class="progress-bar" data-progress-bar aria-hidden="true"></span>
  <div class="wrap head-row">
    <a class="brand" href="/" aria-label="${esc(club.name)} home">
      <picture><source srcset="/img/crest-128.webp" type="image/webp"><img src="/img/icon-192.png" alt="" width="44" height="44"></picture>
      <span class="brand-text"><b>Pontardawe RFC</b><small>Est. ${club.founded}</small></span>
    </a>
    <nav class="nav" id="nav" aria-label="Main">${NAV.map(link).join('')}</nav>
    <a class="btn btn-sm btn-glow head-cta" href="${MEMBERS}/">${icon('card', { size: 18 })}<span>Members</span></a>
    <button class="burger" type="button" aria-controls="nav" aria-expanded="false" aria-label="Open the menu" data-burger>${icon('menu')}</button>
  </div>
</header>`;
}

function footer() {
  const a = club.address;
  return `
<footer class="site-foot">
  <div class="foot-hoops" aria-hidden="true"></div>
  <div class="wrap foot-grid">
    <div class="foot-club">
      <a class="brand brand-foot" href="/"><picture><source srcset="/img/crest-128.webp" type="image/webp"><img src="/img/icon-192.png" alt="" width="56" height="56" loading="lazy"></picture><span class="brand-text"><b>Pontardawe RFC</b><small>${esc(club.welsh_name)}</small></span></a>
      <p>${esc(club.tagline)}.</p>
      <p class="foot-social"><a href="${club.web.facebook}" rel="noopener" target="_blank">${icon('facebook', { size: 20 })}<span>Facebook</span></a><a href="${club.web.x}" rel="noopener" target="_blank">${icon('x', { size: 20 })}<span>X @PontardaweRFC</span></a></p>
    </div>
    <div>
      <h2>Visit</h2>
      <p>${esc(a.name)}<br>${esc(a.street)}, ${esc(a.town)}<br>${esc(a.county)} ${esc(a.postcode)}</p>
      <p><a href="tel:${club.phone_e164}">${icon('phone', { size: 18 })} ${esc(club.phone)}</a></p>
      ${club.email ? `<p><a href="mailto:${esc(club.email)}">${icon('mail', { size: 18 })} ${esc(club.email)}</a></p>` : ''}
    </div>
    <div>
      <h2>Club</h2>
      <ul class="foot-links">
        <li><a href="/club">History</a></li><li><a href="/teams">Teams</a></li><li><a href="/fixtures">Fixtures &amp; results</a></li><li><a href="/tickets">Match tickets</a></li>
        <li><a href="/news">News</a></li><li><a href="/clubhouse">Clubhouse & functions</a></li>
        <li><a href="/menu">Menu & order</a></li><li><a href="${MEMBERS}/">Members' app</a></li>
      </ul>
    </div>
    <div>
      <h2>Small print</h2>
      <ul class="foot-links">
        <li><a href="/privacy">Privacy policy</a></li><li><a href="/cookies">Cookies</a></li>
        <li><a href="/ordering-terms">Ordering terms</a></li><li><a href="/accessibility">Accessibility</a></li>
        <li><a href="/sitemap.xml">Sitemap</a></li>
      </ul>
    </div>
  </div>
  <div class="wrap foot-app">
    <div><h2>Get the club app</h2><p>Your members' card, club news and offers on your phone.</p></div>
    ${appBadges({ qr: true })}
  </div>
  <div class="wrap foot-base">
    <p>© ${new Date().getFullYear()} ${esc(club.company.name)}. Registered in England and Wales, company ${esc(club.company.number)}. Registered office: ${esc(club.company.registered_office)}.</p>
    <p>Menu, ordering and members' app by <a href="https://vesopaepos.com" rel="noopener">Vesopa EPOS</a>.</p>
  </div>
</footer>
<div class="helper" data-helper>
  <button class="helper-fab" type="button" data-helper-open aria-expanded="false" aria-controls="helper-panel">${icon('sparkle', { size: 22 })}<span>Ask the club</span></button>
  <section class="helper-panel" id="helper-panel" role="dialog" aria-modal="false" aria-labelledby="helper-title" hidden>
    <header class="helper-head">
      <picture><source srcset="/img/crest-128.webp" type="image/webp"><img src="/img/icon-192.png" alt="" width="36" height="36"></picture>
      <div><h2 id="helper-title">Club helper</h2><p>Answers from the club's own information</p></div>
      <button type="button" class="helper-x" data-helper-close aria-label="Close the helper">${icon('close', { size: 20 })}</button>
    </header>
    <div class="helper-log" data-helper-log aria-live="polite">
      <div class="msg bot"><p>Hello! Ask me about the club, the clubhouse, food and ordering, membership or how to find us.</p></div>
    </div>
    <div class="helper-chips" data-helper-chips>
      <button type="button">How do I order food?</button><button type="button">How do I join?</button><button type="button">Where are you?</button>
    </div>
    <form class="helper-form" data-helper-form>
      <label class="sr" for="helper-q">Your question</label>
      <input id="helper-q" name="q" autocomplete="off" maxlength="500" placeholder="Ask a question…" required>
      <button type="submit" aria-label="Send">${icon('send', { size: 20 })}</button>
    </form>
    <p class="helper-note">Please don't type personal details. Answers can be wrong; for anything important call ${esc(club.phone)}. <a href="/privacy#helper">How this works</a></p>
  </section>
</div>
<script src="/js/site.js?v=${ASSET_VERSION}" defer></script>`;
}

/** A whole page. */
function page(opts, body) {
  return `${head(opts)}
<body class="page-${esc(opts.og || 'page')}">
${header(opts.path)}
<main id="main">
${body}
</main>
${footer()}
${opts.scripts || ''}
</body>
</html>`;
}

/** The banner at the top of an inner page. */
function pageHero({ kicker, title, lead, art = '' }) {
  return `<section class="page-hero">
  <div class="hero-bg" aria-hidden="true"><span class="hoop"></span><span class="hoop"></span><span class="hoop"></span></div>
  <div class="wrap page-hero-in">
    <div>
      <p class="kicker reveal">${esc(kicker)}</p>
      <h1 class="reveal">${esc(title)}</h1>
      ${lead ? `<p class="lead reveal">${lead}</p>` : ''}
    </div>
    ${art}
  </div>
</section>`;
}

module.exports = {
  appBadges, IOS_APP, ANDROID_APP, page, pageHero, esc, icon, SITE, MEMBERS, NAV, clubLd, ASSET_VERSION };
