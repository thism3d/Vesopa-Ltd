/**
 * The frame of every page of loughorrfc.site: the head (titles, share cards,
 * structured data), the masthead and its menu, the footer and the club
 * helper.
 *
 * The look is the club's own (owner, 2026-11-19: "a total brand new
 * website", "Heritage programme"): a match-day programme on cream paper,
 * deep navy and gold rules, serif headlines (Fraunces) over plain text
 * (Source Sans 3), and the crest of Leucarum, as the club supplied it.
 */
'use strict';

const { club } = require('./content');
const { icon } = require('./icons');

const SITE = (process.env.SITE_URL || club.web.site).replace(/\/+$/, '');
const MEMBERS = (process.env.MEMBERS_URL || club.web.members).replace(/\/+$/, '');
// The menu and ordering: the club's own page in its back office.
const MENU_URL = process.env.MENU_URL || `https://menu.vesopa.com/${club.slug || 'loughor-rfc'}`;
const ASSET_VERSION = process.env.ASSET_VERSION || String(Date.now()).slice(-8);

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const NAV = [
  ['/club', 'The Club'],
  ['/fixtures', 'Fixtures'],
  ['/teams', 'Teams'],
  ['/news', 'News'],
  ['/whats-on', "What's On"],
  ['/clubhouse', 'Clubhouse'],
  ['/membership', 'Membership'],
  ['/contact', 'Visit'],
];

/** The club as structured data: a sports club that is also a place with a bar. */
function clubLd() {
  const a = club.address;
  return {
    '@context': 'https://schema.org',
    '@type': ['SportsClub', 'LocalBusiness'],
    '@id': `${SITE}/#club`,
    name: club.name,
    alternateName: [club.full_name, club.welsh_name, club.nickname].filter(Boolean),
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
    sameAs: [club.web.facebook, club.web.x, club.web.wikipedia].filter(Boolean),
    memberOf: { '@type': 'SportsOrganization', name: 'Welsh Rugby Union', url: 'https://www.wru.wales/' },
    hasMenu: MENU_URL,
    legalName: club.company.name,
    identifier: { '@type': 'PropertyValue', propertyID: 'Companies House', value: club.company.number },
  };
}

function head({ title, description, path, og = 'home', ld = [], noindex = false, image: shareImage = null, type = 'website', extraHead = '' }) {
  const full = path === '/' ? `${club.name} | ${club.tagline}` : `${title} | ${club.name}`;
  const url = `${SITE}${path}`;
  // A news post with its own photo shares that (its 1200x630 cut, src/uploads.js).
  const image = shareImage ? `${SITE}${shareImage.src}` : `${SITE}/img/og-${og}.jpg`;
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
<meta name="theme-color" content="#0B1A44">
<meta name="color-scheme" content="light">
<meta property="og:type" content="${esc(type)}">
<meta property="og:site_name" content="${esc(club.name)}">
<meta property="og:locale" content="en_GB">
<meta property="og:title" content="${esc(full)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:image" content="${esc(image)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${esc(shareImage ? shareImage.alt || title : `${club.name} crest: ${title}`)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(full)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${esc(image)}">
<link rel="icon" type="image/png" sizes="32x32" href="/img/favicon-32.png?v=3">
<link rel="icon" type="image/png" sizes="192x192" href="/img/icon-192.png?v=3">
<link rel="icon" href="/favicon.ico?v=3" sizes="any">
<link rel="apple-touch-icon" href="/img/apple-touch-icon.png?v=3">
<link rel="manifest" href="/site.webmanifest">
<link rel="preload" href="/fonts/fraunces-latin-opsz-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/source-sans-3-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/css/site.css?v=${ASSET_VERSION}">
<link rel="alternate" type="application/rss+xml" title="${esc(club.name)} news" href="/news/feed.xml">
${extraHead}
<script>
/* The opening ("Croeso", site.css .curtain): once a visit, never for reduced
   motion or a crawler. site.js lifts it after 3.4s whatever happens. */
(function(){var d=document.documentElement;d.classList.add('js');try{var u=navigator.userAgent||'';
if(!navigator.webdriver&&!/bot|crawl|spider|slurp|lighthouse|preview|headless/i.test(u)&&!(window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches)&&!sessionStorage.getItem('lrfc-croeso')){
sessionStorage.setItem('lrfc-croeso','1');d.classList.add('curtain-on');}}catch(e){}})();
</script>
<script type="application/ld+json">${JSON.stringify(graph).replace(/</g, '\\u003c')}</script>
</head>`;
}

/** The members' app: on its way to the stores; try it now in the public
 *  tests (owner, 2026-11-19: TestFlight and Google Play links), and the card
 *  is on the web today. */
function appSoon({ cls = '' } = {}) {
  const w = club.web;
  const tries = [
    w.ios_test && `<a class="app-try" href="${esc(w.ios_test)}" rel="noopener">iPhone and iPad: TestFlight</a>`,
    w.android_test && `<a class="app-try" href="${esc(w.android_test)}" rel="noopener">Android and Wear OS: Google Play</a>`,
  ].filter(Boolean);
  return `<div class="app-soon${cls ? ` ${cls}` : ''}">
  <p class="app-soon-tag">${tries.length ? 'Try it now' : 'Coming soon'}</p>
  <p>The Loughor RFC app for iPhone, Apple Watch, Android and Wear OS is on its way to the App Store and Google Play.</p>
  ${tries.length ? `<p class="app-tries">${tries.join(' ')}</p>
  <p class="app-try-note">On iPhone, TestFlight (Apple's app for trying apps) installs first, then the app. On Android, join the test, then install from Google Play.</p>` : ''}
  <p>Or use your card on the web: <a href="${MEMBERS}/">member.loughorrfc.site</a>.</p>
</div>`;
}

/** The apps' public tests in a strip at the very top of the homepage
 *  (owner, 2026-11-20: "show the Google and Apple Store testing link to the
 *  top of the homepage"). Nothing until a test link is set. */
function appStrip() {
  const w = club.web;
  const links = [
    w.ios_test && `<a class="strip-btn" href="${esc(w.ios_test)}" rel="noopener">${icon('apple', { size: 16 })}<span>iPhone &amp; iPad <small>TestFlight</small></span></a>`,
    w.android_test && `<a class="strip-btn" href="${esc(w.android_test)}" rel="noopener">${icon('android', { size: 16 })}<span>Android &amp; Wear OS <small>Google Play</small></span></a>`,
  ].filter(Boolean);
  if (!links.length) return '';
  return `<aside class="app-strip" aria-label="Try the Loughor RFC app">
  <div class="wrap app-strip-in">
    <p><strong>New: the Loughor RFC app.</strong> Your members' card on your phone and watch. Try it now:</p>
    <p class="strip-links">${links.join('')}</p>
  </div>
</aside>`;
}

function header(path) {
  const link = ([href, label]) => {
    const on = path === href || path.startsWith(`${href}/`);
    return `<a href="${href}"${on ? ' aria-current="page"' : ''}>${label}</a>`;
  };
  return `
<a class="skip" href="#main">Skip to content</a>
<header class="masthead-bar" data-head>
  <div class="strip">
    <div class="wrap strip-in">
      <span>Leucarum</span><span class="dot" aria-hidden="true">·</span><span>Est. ${club.founded}</span><span class="dot" aria-hidden="true">·</span><span class="strip-hide">Villa Field, ${esc(club.address.town)}</span>
      <a class="strip-members" href="${MEMBERS}/">Members' card ${icon('arrow', { size: 14 })}</a>
    </div>
  </div>
  <div class="wrap bar">
    <a class="mark" href="/" aria-label="${esc(club.name)}, home">
      <img src="/img/crest-128.webp" alt="" width="52" height="52">
      <span class="mark-words"><b>Loughor</b><i>Rugby Football Club</i></span>
    </a>
    <nav class="nav" id="nav" aria-label="Main">${NAV.map(link).join('')}<a class="nav-menu" href="${esc(MENU_URL)}">Food &amp; drink</a></nav>
    <button class="menu-btn" type="button" aria-controls="nav" aria-expanded="false" data-menu-btn><span class="menu-lines" aria-hidden="true"><i></i><i></i></span><span class="menu-word">Menu</span></button>
  </div>
</header>`;
}

function footer() {
  const a = club.address;
  return `
<footer class="colophon">
  <svg class="col-river" viewBox="0 0 1440 60" preserveAspectRatio="none" aria-hidden="true"><path d="M0 30 C 180 6 360 54 540 30 S 900 6 1080 30 S 1300 54 1440 30 V60 H0Z"/></svg>
  <div class="wrap col-grid">
    <div class="col-club">
      <img class="col-crest" src="/img/crest-256.webp" alt="" width="120" height="120" loading="lazy">
      <p class="col-name">${esc(club.full_name)}</p>
      <p class="col-welsh">${esc(club.welsh_name)}</p>
      <p class="col-social"><a href="${club.web.facebook}" rel="noopener" target="_blank">${icon('facebook', { size: 18 })} Facebook</a><a href="${club.web.x}" rel="noopener" target="_blank">${icon('x', { size: 16 })} @LoughorRFC</a></p>
    </div>
    <div>
      <h2>Find us</h2>
      <p>${esc(a.street)}<br>${esc(a.town)}, ${esc(a.county)}<br>${esc(a.postcode)}</p>
      <p><a href="tel:${club.phone_e164}">${esc(club.phone)}</a>${club.email ? `<br><a href="mailto:${esc(club.email)}">${esc(club.email)}</a>` : ''}</p>
    </div>
    <div>
      <h2>The club</h2>
      <ul>
        <li><a href="/club">History &amp; honours</a></li><li><a href="/teams">Teams</a></li><li><a href="/fixtures">Fixtures &amp; results</a></li>
        <li><a href="/tickets">Match tickets</a></li><li><a href="/news">News</a></li><li><a href="/whats-on">What's on</a></li>
        <li><a href="/clubhouse">Clubhouse &amp; hire</a></li><li><a href="${esc(MENU_URL)}">Food &amp; drink</a></li><li><a href="/membership">Membership</a></li>
      </ul>
    </div>
    <div>
      <h2>Small print</h2>
      <ul>
        <li><a href="/privacy">Privacy</a></li><li><a href="/cookies">Cookies</a></li><li><a href="/ordering-terms">Ordering terms</a></li>
        <li><a href="/accessibility">Accessibility</a></li><li><a href="/licences">Licences</a></li>
        <li><a href="/app/help">App help</a></li><li><a href="/app/privacy">App privacy</a></li><li><a href="/sitemap.xml">Sitemap</a></li>
      </ul>
    </div>
  </div>
  <div class="wrap col-base">
    <p>© ${new Date().getFullYear()} ${esc(club.company.name)} · Company ${esc(club.company.number)} · ${esc(club.company.registered_office)}</p>
    <p>Ordering, tickets and members' card by <a href="https://vesopaepos.com" rel="noopener">Vesopa EPOS</a></p>
  </div>
</footer>
<aside class="ask" data-helper>
  <button class="ask-tab" type="button" data-helper-open aria-expanded="false" aria-controls="helper-panel">${icon('sparkle', { size: 18 })}<span>Ask the club</span></button>
  <section class="ask-panel" id="helper-panel" role="dialog" aria-modal="false" aria-labelledby="helper-title" hidden>
    <header class="ask-head">
      <h2 id="helper-title">Ask the club</h2>
      <button type="button" class="ask-x" data-helper-close aria-label="Close">${icon('close', { size: 18 })}</button>
    </header>
    <div class="ask-log" data-helper-log aria-live="polite">
      <div class="msg bot"><p>Croeso! Ask about matches, the clubhouse, food, membership or how to find Villa Field.</p></div>
    </div>
    <div class="ask-chips" data-helper-chips>
      <button type="button">When is the next match?</button><button type="button">How do I join?</button><button type="button">Where is Villa Field?</button>
    </div>
    <form class="ask-form" data-helper-form>
      <label class="sr" for="helper-q">Your question</label>
      <input id="helper-q" name="q" autocomplete="off" maxlength="500" placeholder="Type a question" required>
      <button type="submit" aria-label="Send">${icon('send', { size: 18 })}</button>
    </form>
    <p class="ask-note">Answers come from the club's own information and can be wrong; for anything important call ${esc(club.phone)}. <a href="/privacy#helper">How this works</a></p>
  </section>
</aside>
<script src="/js/site.js?v=${ASSET_VERSION}" defer></script>`;
}

const CROW = '<path d="M2 12c4-1 7-4 9-8 1 3 3 5 6 6 2-2 5-3 8-3-2 2-3 4-3 6l7 2-8 1c-3 2-6 2-9 1L6 19c0-2 1-4 2-5-2 0-4-1-6-2z"/>';

/** The opening: a programme cover that greets and lifts (site.css .curtain). */
function curtain() {
  return `<div class="curtain" data-curtain aria-hidden="true">
  <div class="curtain-in">
    <img class="curtain-crest" src="/img/crest-256.webp" alt="" width="240" height="240">
    <p class="curtain-hello">Croeso!</p>
    <p class="curtain-name">Welcome to Loughor RFC</p>
  </div>
  <svg class="crow crow-1" viewBox="0 0 34 22">${CROW}</svg><svg class="crow crow-2" viewBox="0 0 34 22">${CROW}</svg><svg class="crow crow-3" viewBox="0 0 34 22">${CROW}</svg>
  <svg class="curtain-river" viewBox="0 0 1440 110" preserveAspectRatio="none"><path d="M0 50 C 240 10 480 90 720 50 S 1200 10 1440 50 V110 H0Z"/><path d="M0 70 C 300 40 600 100 900 70 S 1300 40 1440 70 V110 H0Z"/></svg>
  <button class="curtain-skip" type="button" data-curtain-skip tabindex="-1">Skip</button>
</div>`;
}

/** A whole page. */
function page(opts, body) {
  return `${head(opts)}
<body class="p-${esc(opts.og || 'page')}">
${curtain()}
${header(opts.path)}
<main id="main">
${body}
</main>
${footer()}
${opts.scripts || ''}
</body>
</html>`;
}

/**
 * The title block of an inner page, set like a programme's section opener:
 * a small-caps kicker between gold rules, the title in the serif, a lead.
 */
function masthead({ kicker, title, lead = '', no = '' }) {
  return `<section class="opener">
  <div class="wrap opener-in">
    <p class="opener-kicker" data-reveal><span>${esc(kicker)}</span></p>
    <h1 data-reveal>${esc(title)}</h1>
    ${lead ? `<p class="opener-lead" data-reveal>${lead}</p>` : ''}
    ${no ? `<p class="opener-no" aria-hidden="true">${esc(no)}</p>` : ''}
  </div>
</section>`;
}

module.exports = { page, masthead, appSoon, appStrip, esc, icon, SITE, MEMBERS, MENU_URL, NAV, clubLd, ASSET_VERSION };
