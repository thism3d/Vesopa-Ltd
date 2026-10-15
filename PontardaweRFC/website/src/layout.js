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
  ['/whats-on', "What's On"],
  ['/play', 'Play'],
  ['/club', 'The Club'],
  ['/teams', 'Teams'],
  ['/fixtures', 'Fixtures'],
  ['/news', 'News'],
  ['/clubhouse', 'Clubhouse'],
  ['/menu', 'Menu'],
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
    sameAs: [club.web.facebook, club.web.instagram, club.web.x, club.web.wikipedia],
    memberOf: { '@type': 'SportsOrganization', name: 'Welsh Rugby Union', url: 'https://www.wru.wales/' },
    hasMenu: `${SITE}/menu`,
    servesCuisine: 'Pub food',
    legalName: club.company.name,
    identifier: { '@type': 'PropertyValue', propertyID: 'Companies House', value: club.company.number },
  };
}

function head({ title, description, path, og = 'home', ld = [], noindex = false, icon: tabIcon = null }) {
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
${tabIcon ? `<link rel="icon" type="image/svg+xml" href="${tabIcon}.svg">
<link rel="icon" type="image/png" sizes="32x32" href="${tabIcon}-32.png">
<link rel="apple-touch-icon" href="${tabIcon}-192.png">` : ''}<link rel="icon" type="image/png" sizes="32x32" href="/img/favicon-32.png?v=2">
<link rel="icon" type="image/png" sizes="16x16" href="/img/favicon-16.png?v=2">
<link rel="icon" type="image/png" sizes="192x192" href="/img/icon-192.png?v=2">
<link rel="icon" href="/favicon.ico?v=2" sizes="any">
<link rel="apple-touch-icon" href="/img/apple-touch-icon.png?v=2">
<link rel="manifest" href="/site.webmanifest">
<link rel="preload" href="/fonts/oswald-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/montserrat-latin-400-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/css/site.css?v=${ASSET_VERSION}">
<link rel="stylesheet" href="/css/motion.css?v=${ASSET_VERSION}">
<link rel="alternate" type="application/rss+xml" title="${esc(club.name)} news" href="/news/feed.xml">
<script>
/* Nothing is hidden while scripts load: content already on screen is shown
   as it is, and only what is further down rises in as it is scrolled to
   (site.js). Links to other pages are fetched ahead, so they open at once.
   The kick-off opening (2026-10-15, the owner) plays over a page that is
   already drawn, once per visit, never for reduced motion or a crawler, and
   lifts itself after 5.7s whatever happens (motion.js; this timer if not). */
document.documentElement.classList.add('js');
(function(){try{var d=document.documentElement,u=navigator.userAgent||'';
if(!navigator.webdriver&&!/bot|crawl|spider|slurp|lighthouse|preview|headless/i.test(u)&&!(window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches)&&!sessionStorage.getItem('prfc-kick')){
sessionStorage.setItem('prfc-kick','1');d.classList.add('kick-on');setTimeout(function(){d.classList.remove('kick-on')},6500);}}catch(e){}})();
/* Which phone, so each visitor is shown the one app store their phone uses. */
(function(){var u=navigator.userAgent||'',d=document.documentElement;
if(/iPhone|iPad|iPod/.test(u)||(/Macintosh/.test(u)&&navigator.maxTouchPoints>1))d.classList.add('os-ios');
else if(/Macintosh/.test(u))d.classList.add('os-mac');
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
 * apart from Google's transparent margin). Every device is shown both, so it
 * is plain the app is on iPhone and Android; the visitor's own store comes
 * first (the head script decides, before anything is drawn), and a computer
 * also gets a QR code for /app.
 */
function appBadges({ qr = false, cls = '' } = {}) {
  return `<div class="store-badges${cls ? ` ${cls}` : ''}">
  <p class="store-avail">On iPhone and Android</p>
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
    <a class="btn btn-sm btn-glow head-cta" href="${MEMBERS}/" aria-label="Members' card"><span class="head-cta-ic" aria-hidden="true"><svg viewBox="0 0 32 24" width="22" height="17"><rect class="hc-card" x="1.5" y="1.5" width="29" height="21" rx="4"/><rect class="hc-chip" x="5.5" y="7" width="6" height="5" rx="1.2"/><path class="hc-line" d="M5.5 16.5h12M21 16.5h5.5"/><circle class="hc-dot" cx="25" cy="7.5" r="2.4"/></svg></span><span class="head-cta-text">Members</span></a>
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
      <p class="foot-social"><a href="${club.web.facebook}" rel="noopener" target="_blank">${icon('facebook', { size: 20 })}<span>Facebook</span></a><a href="${club.web.instagram}" rel="noopener" target="_blank">${icon('instagram', { size: 20 })}<span>Instagram</span></a><a href="${club.web.x}" rel="noopener" target="_blank">${icon('x', { size: 20 })}<span>@PontardaweRFC</span></a></p>
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
        <li><a href="/whats-on">What's on</a></li><li><a href="/play">Ponty Kicks (game)</a></li><li><a href="/club">History</a></li><li><a href="/archive">From the archive</a></li><li><a href="/teams">Teams</a></li><li><a href="/fixtures">Fixtures &amp; results</a></li><li><a href="/tickets">Match tickets</a></li>
        <li><a href="/news">News</a></li><li><a href="/clubhouse">Clubhouse & functions</a></li>
        <li><a href="/menu">Menu & order</a></li><li><a href="${MEMBERS}/">Members' app</a></li>
      </ul>
    </div>
    <div>
      <h2>Small print</h2>
      <ul class="foot-links">
        <li><a href="/privacy">Privacy policy</a></li><li><a href="/cookies">Cookies</a></li>
        <li><a href="/ordering-terms">Ordering terms</a></li><li><a href="/accessibility">Accessibility</a></li>
        <li><a href="/licences">Licences</a></li><li><a href="/sitemap.xml">Sitemap</a></li>
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
<script src="/js/site.js?v=${ASSET_VERSION}" defer></script>
<script src="/js/motion.js?v=${ASSET_VERSION}" defer></script>`;
}

/**
 * The kick-off opening (motion.css): floodlights, the pitch, a conversion
 * between the posts, then the crest and the club's name. Drawn only when the
 * head script sets html.kick-on; the page itself is already underneath.
 */
const KICK_CONFETTI = '<i style="--i:0;--a:-180deg;--r:150px;--c:#f2c14e"></i><i style="--i:1;--a:-164deg;--r:197px;--c:#ffffff"></i><i style="--i:2;--a:-148deg;--r:244px;--c:#e8312f"></i><i style="--i:3;--a:-131deg;--r:151px;--c:#f2c14e"></i><i style="--i:4;--a:-115deg;--r:198px;--c:#c41414"></i><i style="--i:5;--a:-99deg;--r:245px;--c:#f2c14e"></i><i style="--i:6;--a:-82deg;--r:152px;--c:#ffffff"></i><i style="--i:7;--a:-66deg;--r:199px;--c:#e8312f"></i><i style="--i:8;--a:-50deg;--r:246px;--c:#f2c14e"></i><i style="--i:9;--a:-33deg;--r:153px;--c:#c41414"></i><i style="--i:10;--a:-17deg;--r:200px;--c:#f2c14e"></i><i style="--i:11;--a:0deg;--r:247px;--c:#ffffff"></i><i style="--i:12;--a:16deg;--r:154px;--c:#e8312f"></i><i style="--i:13;--a:32deg;--r:201px;--c:#f2c14e"></i><i style="--i:14;--a:49deg;--r:248px;--c:#c41414"></i><i style="--i:15;--a:65deg;--r:155px;--c:#f2c14e"></i><i style="--i:16;--a:81deg;--r:202px;--c:#ffffff"></i><i style="--i:17;--a:98deg;--r:249px;--c:#e8312f"></i><i style="--i:18;--a:114deg;--r:156px;--c:#f2c14e"></i><i style="--i:19;--a:130deg;--r:203px;--c:#c41414"></i><i style="--i:20;--a:147deg;--r:250px;--c:#f2c14e"></i><i style="--i:21;--a:163deg;--r:157px;--c:#ffffff"></i>';
const KICK_LETTERS = '<span style="--i:0">P</span><span style="--i:1">O</span><span style="--i:2">N</span><span style="--i:3">T</span><span style="--i:4">A</span><span style="--i:5">R</span><span style="--i:6">D</span><span style="--i:7">A</span><span style="--i:8">W</span><span style="--i:9">E</span><span style="--i:10">&nbsp;</span><span style="--i:11">R</span><span style="--i:12">F</span><span style="--i:13">C</span>';
function kickOff() {
  return `<div class="kick" data-kick aria-hidden="true">
  <span class="kick-light l1"></span><span class="kick-light l2"></span>
  <svg class="kick-pitch" viewBox="0 0 1000 600" preserveAspectRatio="xMidYMax slice">
    <defs><linearGradient id="kick-turf" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1d4d1f" stop-opacity="0"/><stop offset="1" stop-color="#1d4d1f" stop-opacity=".55"/></linearGradient></defs>
    <path class="turf" d="M380 120 L620 120 L1120 600 L-120 600 Z"/>
    <path d="M380 120 L-120 600"/><path d="M620 120 L1120 600"/>
    <path d="M330 168 L670 168"/><path d="M230 264 L770 264"/><path d="M60 428 L940 428"/>
  </svg>
  <div class="kick-stage">
    <svg class="kick-svg" viewBox="0 0 400 400">
      <defs><linearGradient id="kick-trail" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#f2c14e" stop-opacity="0"/><stop offset="1" stop-color="#fff" stop-opacity=".95"/></linearGradient></defs>
      <g class="kick-posts"><path class="pad" d="M150 300 V270 M250 300 V270"/><path d="M150 300 V40"/><path d="M250 300 V40"/><path d="M150 190 H250"/></g>
      <path class="kick-trail" d="M200 352 Q 180 220 200 96"/>
      <path class="kick-tee" d="M188 372 L212 372 L206 358 L194 358 Z"/>
      <g class="kick-ball"><ellipse cx="200" cy="340" rx="16" ry="25"/><path d="M200 322 V358 M194 330 H206 M194 340 H206 M194 350 H206"/></g>
    </svg>
  </div>
  <span class="kick-flash"></span>
  <span class="kick-confetti">${KICK_CONFETTI}</span>
  <p class="kick-cheer">Converted!</p>
  <div class="kick-crest-wrap"><span class="kick-ring"></span><span class="kick-ring r2"></span><div class="kick-crest"><img src="/img/crest-256.webp" alt="" width="256" height="256"></div></div>
  <p class="kick-word">${KICK_LETTERS}<small>Est. ${club.founded} · Clwb Rygbi Pontardawe</small></p>
  <p class="kick-load"><span class="kick-bar"></span><span data-kick-pct>Loading 0%</span></p>
  <button class="kick-skip" type="button" data-kick-skip tabindex="-1">Skip ›</button>
</div>`;
}

/** A whole page. */
function page(opts, body) {
  return `${head(opts)}
<body class="page-${esc(opts.og || 'page')}">
${kickOff()}
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
