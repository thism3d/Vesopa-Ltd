/**
 * Every page of pontardawerfc.com. Server-rendered, so each one is complete
 * without JavaScript and readable by search engines and link previews; the
 * scripts add the opening, the reveals, the menu and the helper on top.
 */
'use strict';

const { club, news, images, longDate, yearsOld } = require('./content');
const { page, pageHero, esc, icon, SITE, MEMBERS, ASSET_VERSION } = require('./layout');

const MENU_API = (process.env.MENU_API || 'https://menu.vesopa.com').replace(/\/+$/, '');
const MENU_SLUG = process.env.MENU_SLUG || 'pontardawe-rfc';

function photo(name, { cls = '', sizes = '(max-width: 700px) 100vw, 640px', lazy = true } = {}) {
  const m = images[name];
  if (!m) return '';
  return `<picture class="${cls}"><source srcset="/img/${name}.webp" type="image/webp"><img src="/img/${name}.jpg" alt="${esc(m.alt)}" width="${m.w}" height="${m.h}" sizes="${sizes}"${lazy ? ' loading="lazy" decoding="async"' : ''}></picture>`;
}

function crumbs(items) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map(([name, path], i) => ({ '@type': 'ListItem', position: i + 1, name, item: `${SITE}${path}` })),
  };
}

function newsCard(post, { big = false } = {}) {
  const img = post.image ? photo(post.image, { cls: 'card-img' }) : `<div class="card-img card-img-art" aria-hidden="true"><img src="/img/crest-128.webp" alt="" width="96" height="96" loading="lazy"></div>`;
  return `<article class="card news-card reveal${big ? ' news-big' : ''}">
  <a href="/news/${esc(post.slug)}" class="card-link">
    ${img}
    <div class="card-body">
      <p class="meta">${icon('calendar', { size: 16 })} <time datetime="${esc(post.date)}">${esc(longDate(post.date))}</time>${post.closed ? ' · <span class="tag">Closed</span>' : ''}</p>
      <h3>${esc(post.title)}</h3>
      <p>${esc(post.summary)}</p>
      <span class="more">Read more ${icon('arrow', { size: 18 })}</span>
    </div>
  </a>
</article>`;
}

// ---------------------------------------------------------------------------

function home() {
  const years = yearsOld();
  const body = `
<section class="hero" aria-label="Welcome">
  <div class="hero-bg" aria-hidden="true">
    <span class="hoop"></span><span class="hoop"></span><span class="hoop"></span><span class="hoop"></span>
    <span class="glow"></span>
  </div>
  <div class="hero-photo" aria-hidden="true">${photo('squad-pitch', { lazy: false, sizes: '100vw' })}</div>
  <div class="wrap hero-in">
    <div class="hero-copy">
      <p class="kicker reveal">${icon('ball', { size: 18 })} Est. ${club.founded} · Swansea Valley</p>
      <h1 class="reveal"><span>Pride of</span> <span class="hl">Pontardawe</span> <span>since ${club.founded}</span></h1>
      <p class="lead reveal">${esc(club.short)}</p>
      <div class="cta-row reveal">
        <a class="btn btn-glow" href="/menu">${icon('plate', { size: 20 })} Menu &amp; order</a>
        <a class="btn btn-ghost" href="${MEMBERS}/">${icon('card', { size: 20 })} Members' card</a>
      </div>
    </div>
    <div class="hero-badge reveal" aria-hidden="true">
      <div class="badge-ring"></div><div class="badge-ring r2"></div>
      <picture><source srcset="/img/crest-256.webp" type="image/webp"><img src="/img/crest-512.png" alt="" width="320" height="320"></picture>
    </div>
  </div>
  <a class="scroll-cue" href="#quick" aria-label="Scroll down"><span></span></a>
</section>

<section class="stats" aria-label="The club in numbers">
  <div class="wrap stats-row">
    <div class="stat reveal"><b data-count="${club.founded}">${club.founded}</b><span>Founded</span></div>
    <div class="stat reveal"><b data-count="${years}">${years}</b><span>Years of rugby</span></div>
    <div class="stat reveal"><b data-count="4">4</b><span>Wales internationals</span></div>
    <div class="stat reveal"><b>WRU</b><span>Member club</span></div>
  </div>
</section>

<section class="section" id="quick">
  <div class="wrap">
    <div class="tiles">
      <a class="tile reveal" href="/menu"><span class="tile-ic">${icon('plate')}</span><h2>Menu &amp; order</h2><p>Order to your table, or for collection and pay at the bar.</p><span class="more">Order now ${icon('arrow', { size: 18 })}</span></a>
      <a class="tile reveal" href="${MEMBERS}/"><span class="tile-ic">${icon('card')}</span><h2>Members' card</h2><p>Your card and members' discount at member.pontardawerfc.com.</p><span class="more">Open the app ${icon('arrow', { size: 18 })}</span></a>
      <a class="tile reveal" href="/teams"><span class="tile-ic">${icon('whistle')}</span><h2>Fixtures &amp; results</h2><p>The First XV, the juniors and the league table.</p><span class="more">See the teams ${icon('arrow', { size: 18 })}</span></a>
      <a class="tile reveal" href="/clubhouse"><span class="tile-ic">${icon('beer')}</span><h2>The clubhouse</h2><p>Bar, café, live sport and functions on Ynysderw Road.</p><span class="more">Visit ${icon('arrow', { size: 18 })}</span></a>
    </div>
  </div>
</section>

<section class="section split">
  <div class="wrap split-in">
    <div class="split-media reveal">${photo('squad-sponsor')}<div class="split-tag">${icon('trophy', { size: 18 })} 2nd in WRU Division 4 West Central, 2022-23</div></div>
    <div class="split-copy">
      <p class="kicker reveal">Our story</p>
      <h2 class="reveal">A community club for ${years} years</h2>
      <p class="reveal">${esc(club.history[0])}</p>
      <p class="reveal">${esc(club.history[1])}</p>
      <a class="btn btn-line reveal" href="/club">${icon('history', { size: 20 })} Read the club's history</a>
    </div>
  </div>
</section>

<section class="section order-band">
  <div class="wrap order-band-in">
    <div class="reveal">
      <p class="kicker">Food from the clubhouse</p>
      <h2>Order to your table, or ahead for collection</h2>
      <p>The menu comes straight from the bar's own till, so prices, allergens and what's sold out are always right. In the club? Order to your table. At home? Order for collection and pay at the bar when you pick it up.</p>
      <div class="cta-row"><a class="btn btn-white" href="/menu">${icon('bag', { size: 20 })} See the menu</a></div>
    </div>
    <ul class="steps">
      <li class="reveal"><span>1</span><div><b>Choose</b><p>Pick from the live menu, with allergens on every dish.</p></div></li>
      <li class="reveal"><span>2</span><div><b>Send</b><p>To your table, or for collection with your name and number.</p></div></li>
      <li class="reveal"><span>3</span><div><b>Enjoy</b><p>The order lands on the bar's till and in the kitchen straight away.</p></div></li>
    </ul>
  </div>
</section>

<section class="section">
  <div class="wrap">
    <div class="sec-head"><div><p class="kicker reveal">Club news</p><h2 class="reveal">Latest from Ynysderw Road</h2></div><a class="btn btn-line reveal" href="/news">All news ${icon('arrow', { size: 18 })}</a></div>
    <div class="grid-3">${news.slice(0, 3).map((p) => newsCard(p)).join('')}</div>
  </div>
</section>

<section class="section members-band">
  <div class="wrap members-in">
    <div class="phone reveal" aria-hidden="true">
      <div class="phone-screen">
        <img src="/img/crest-128.webp" alt="" width="64" height="64">
        <b>Pontardawe RFC</b><span>Members' card</span>
        <div class="fake-qr">${icon('qr', { size: 96 })}</div>
        <small>Show this at the bar</small>
      </div>
    </div>
    <div>
      <p class="kicker reveal">Membership</p>
      <h2 class="reveal">Your members' card, on your phone</h2>
      <ul class="ticks">${club.membership.benefits.map((b) => `<li class="reveal">${icon('check', { size: 20 })}${esc(b)}</li>`).join('')}</ul>
      <div class="cta-row reveal"><a class="btn btn-glow" href="${MEMBERS}/">${icon('card', { size: 20 })} Open member.pontardawerfc.com</a><a class="btn btn-line" href="/membership">How to join</a></div>
    </div>
  </div>
</section>

<section class="section visit">
  <div class="wrap visit-in">
    <div class="reveal">
      <p class="kicker">Find us</p>
      <h2>Come down to the club</h2>
      <p class="addr">${icon('pin', { size: 22 })}<span>${esc(club.address.name)}<br>${esc(club.address.street)}, ${esc(club.address.town)}, ${esc(club.address.postcode)}</span></p>
      <p class="addr">${icon('phone', { size: 22 })}<a href="tel:${club.phone_e164}">${esc(club.phone)}</a></p>
      <p class="muted">${esc(club.clubhouse.hours_note)}</p>
      <div class="cta-row"><a class="btn btn-line" href="https://www.google.com/maps/dir/?api=1&destination=${club.address.lat},${club.address.lng}" rel="noopener" target="_blank">${icon('pin', { size: 20 })} Directions</a><a class="btn btn-line" href="${club.web.facebook}" rel="noopener" target="_blank">${icon('facebook', { size: 20 })} Facebook</a></div>
    </div>
    <div class="map reveal">${mapCard()}</div>
  </div>
</section>`;
  return page({
    title: club.name,
    description: `${club.name}, est. ${club.founded}: rugby union in Pontardawe, Swansea Valley. Club news, fixtures, the clubhouse bar and café, order food to your table or for collection, and the members' card.`,
    path: '/',
    og: 'home',
  }, body);
}

/** A map without a third-party embed: an OpenStreetMap link over a drawn card. */
function mapCard() {
  const a = club.address;
  return `<a class="map-card" href="https://www.openstreetmap.org/?mlat=${a.lat}&mlon=${a.lng}#map=17/${a.lat}/${a.lng}" rel="noopener" target="_blank" aria-label="Open the map of ${esc(a.street)}, ${esc(a.town)}">
  <svg viewBox="0 0 400 260" aria-hidden="true" class="map-art">
    <rect width="400" height="260" class="m-land"/>
    <path d="M-10 190 C 80 160, 140 210, 220 170 S 360 120, 420 150" class="m-river"/>
    <path d="M0 80 L400 120 M60 0 L120 260 M250 0 L210 260 M0 230 L400 200" class="m-road"/>
    <rect x="150" y="70" width="110" height="60" rx="6" class="m-pitch"/>
    <path d="M205 70 v60 M150 100 h110" class="m-line"/>
    <circle cx="205" cy="100" r="9" class="m-line"/>
    <g class="m-pin"><path d="M205 30c-12 0-21 9-21 21 0 16 21 34 21 34s21-18 21-34c0-12-9-21-21-21z"/><circle cx="205" cy="51" r="7"/></g>
  </svg>
  <span class="map-label">${icon('pin', { size: 18 })} ${esc(a.street)}, ${esc(a.town)} ${esc(a.postcode)} <em>Open map ${icon('external', { size: 14 })}</em></span>
</a>`;
}

function clubPage() {
  const body = `${pageHero({ kicker: `Est. ${club.founded}`, title: 'The Club', lead: esc(`${yearsOld()} years of rugby in the Swansea Valley.`) })}
<section class="section">
  <div class="wrap prose-grid">
    <div class="prose">
      <h2 class="reveal">Our history</h2>
      ${club.history.map((p) => `<p class="reveal">${esc(p)}</p>`).join('')}
      <p class="reveal muted small">Sources: the club, <a href="${club.web.wikipedia}" rel="noopener">Wikipedia</a> and Companies House. Have a photo, a programme or a story from the club's past? Bring it to the clubhouse or call ${esc(club.phone)}: we'd love to add it here.</p>
    </div>
    <aside class="side-card reveal">${photo('lineout')}<div><h3>${esc(club.full_name)}</h3><dl class="facts">
      <dt>Founded</dt><dd>${club.founded}</dd><dt>Ground</dt><dd>${esc(club.ground)}</dd>
      <dt>Clubhouse</dt><dd>${esc(club.address.street)}, ${esc(club.address.town)}</dd><dt>Union</dt><dd>Welsh Rugby Union</dd>
      <dt>League</dt><dd>${esc(club.league)}</dd><dt>Coaches</dt><dd>${club.coaches.map(esc).join(', ')}</dd>
      <dt>Company</dt><dd>${esc(club.company.number)}</dd></dl></div></aside>
  </div>
</section>
<section class="section timeline-sec">
  <div class="wrap">
    <p class="kicker reveal">Through the years</p>
    <h2 class="reveal">Timeline</h2>
    <ol class="timeline">${club.timeline.map((t) => `<li class="reveal"><b>${esc(t.year)}</b><p>${esc(t.text)}</p></li>`).join('')}</ol>
  </div>
</section>
<section class="section">
  <div class="wrap">
    <p class="kicker reveal">Wearing the red of Wales</p>
    <h2 class="reveal">Pontardawe internationals</h2>
    <div class="grid-4">${club.notable_players.map((p) => `<div class="card player reveal"><span class="cap">${icon('star', { size: 22 })}</span><h3>${esc(p.name)}</h3><p>${esc(p.honours)}</p></div>`).join('')}</div>
  </div>
</section>`;
  return page({
    title: 'The Club',
    description: `The history of ${club.full_name}, founded in ${club.founded}: ${yearsOld()} years of community rugby in Pontardawe, the club's Wales internationals and its timeline.`,
    path: '/club',
    og: 'club',
    ld: [crumbs([['Home', '/'], ['The Club', '/club']])],
  }, body);
}

function teamsPage() {
  const body = `${pageHero({ kicker: 'On the pitch', title: 'Teams & Fixtures', lead: 'From the First XV to the youngest juniors.' })}
<section class="section">
  <div class="wrap grid-3">${club.teams.map((t, i) => `<div class="card team reveal"><span class="tile-ic">${icon(['whistle', 'users', 'darts'][i] || 'ball')}</span><h2>${esc(t.name)}</h2><p>${esc(t.text)}</p></div>`).join('')}</div>
</section>
<section class="section fixtures">
  <div class="wrap fixtures-in">
    <div class="reveal">
      <p class="kicker">Fixtures, results and tables</p>
      <h2>Follow the First XV</h2>
      <p>${esc(club.league_note)}</p>
      <div class="cta-row"><a class="btn btn-glow" href="${club.web.wru_league}" rel="noopener" target="_blank">${icon('calendar', { size: 20 })} WRU fixtures &amp; table ${icon('external', { size: 16 })}</a><a class="btn btn-line" href="${club.web.facebook}" rel="noopener" target="_blank">${icon('facebook', { size: 20 })} Match news on Facebook</a></div>
    </div>
    <div class="reveal">${photo('squad-pitch')}</div>
  </div>
</section>
<section class="section">
  <div class="wrap callout reveal">
    <span class="tile-ic">${icon('ball')}</span>
    <div><h2>Want to play?</h2><p>New players, returning players, coaches and volunteers are always welcome, at any age. Call the club on <a href="tel:${club.phone_e164}">${esc(club.phone)}</a> or message us on <a href="${club.web.facebook}" rel="noopener">Facebook</a> to find out when the teams train.</p></div>
  </div>
</section>`;
  return page({
    title: 'Teams & Fixtures',
    description: `${club.name}'s teams: the First XV in the WRU National Leagues, junior and youth rugby, and how to play, coach or volunteer. Fixtures, results and the league table.`,
    path: '/teams',
    og: 'teams',
    ld: [crumbs([['Home', '/'], ['Teams', '/teams']])],
  }, body);
}

function newsPage() {
  const body = `${pageHero({ kicker: 'Club news', title: 'News', lead: 'What\'s happening at the club.' })}
<section class="section">
  <div class="wrap grid-3">${news.map((p, i) => newsCard(p, { big: i === 0 })).join('')}</div>
  <div class="wrap"><p class="muted center reveal">More match news and photos on our <a href="${club.web.facebook}" rel="noopener">Facebook page</a>.</p></div>
</section>`;
  return page({
    title: 'News',
    description: `News from ${club.name}: club announcements, tributes and the latest from the clubhouse on Ynysderw Road.`,
    path: '/news',
    og: 'news',
    ld: [crumbs([['Home', '/'], ['News', '/news']])],
  }, body);
}

function articlePage(post) {
  const img = post.image ? `<figure class="article-img reveal">${photo(post.image, { lazy: false })}</figure>` : '';
  const body = `${pageHero({ kicker: longDate(post.date), title: post.title, lead: '' })}
<section class="section">
  <article class="wrap article">
    ${post.closed ? `<p class="notice">${icon('info', { size: 20 })} This vacancy closed on 7 October 2024. It is kept here as part of the club's news.</p>` : ''}
    ${img}
    ${post.paragraphs.map((p) => (/^\d+\.\s|^\d+\.[A-Z]/.test(p) ? `<h2>${esc(p)}</h2>` : `<p>${esc(p)}</p>`)).join('\n    ')}
    <p class="back"><a href="/news">${icon('arrow', { size: 18 })} All news</a></p>
  </article>
</section>`;
  return page({
    title: post.title,
    description: post.summary,
    path: `/news/${post.slug}`,
    og: 'news',
    ld: [crumbs([['Home', '/'], ['News', '/news'], [post.title, `/news/${post.slug}`]]), {
      '@context': 'https://schema.org',
      '@type': 'NewsArticle',
      headline: post.title,
      datePublished: post.date,
      description: post.summary,
      image: post.image ? `${SITE}/img/${post.image}.jpg` : `${SITE}/img/og-news.jpg`,
      author: { '@type': 'Organization', name: club.name, url: `${SITE}/` },
      publisher: { '@id': `${SITE}/#club` },
      mainEntityOfPage: `${SITE}/news/${post.slug}`,
    }],
  }, body);
}

function clubhousePage() {
  const body = `${pageHero({ kicker: 'Ynysderw Road', title: 'The Clubhouse', lead: esc(club.clubhouse.text) })}
<section class="section">
  <div class="wrap grid-3">${club.clubhouse.features.map((f) => `<div class="card feature reveal"><span class="tile-ic">${icon(f.icon)}</span><h2>${esc(f.title)}</h2><p>${esc(f.text)}</p></div>`).join('')}</div>
</section>
<section class="section split">
  <div class="wrap split-in">
    <div class="split-copy">
      <p class="kicker reveal">Opening times</p>
      <h2 class="reveal">When we're open</h2>
      <p class="reveal">${esc(club.clubhouse.hours_note)}</p>
      <div class="hours reveal" data-hours data-api="${esc(MENU_API)}" data-slug="${esc(MENU_SLUG)}"><p class="muted small">Kitchen hours appear here once the online menu is live.</p></div>
      <div class="cta-row reveal"><a class="btn btn-glow" href="tel:${club.phone_e164}">${icon('phone', { size: 20 })} Call ${esc(club.phone)}</a></div>
    </div>
    <div class="split-media reveal">${photo('squad-sponsor')}</div>
  </div>
</section>
<section class="section">
  <div class="wrap grid-2">
    <div class="card callout-card reveal"><span class="tile-ic">${icon('party')}</span><h2>Hire the clubhouse</h2><p>Birthdays, christenings, anniversaries, wakes and club events. Tell us the date, the numbers and whether you'd like food, and we'll put it together.</p><a class="btn btn-line" href="tel:${club.phone_e164}">${icon('phone', { size: 18 })} Ask about a date</a></div>
    <div class="card callout-card reveal"><span class="tile-ic">${icon('handshake')}</span><h2>Sponsor the club</h2><p>Kit, match-day, ball and pitch-side sponsorship puts your business in front of the whole community and keeps rugby going in Pontardawe.</p><a class="btn btn-line" href="/contact">${icon('mail', { size: 18 })} Talk to us</a></div>
  </div>
</section>`;
  return page({
    title: 'The Clubhouse',
    description: `${club.name}'s clubhouse on Ynysderw Road, Pontardawe: members' bar, café and food to order online, live sport, darts and bowls, and function hire.`,
    path: '/clubhouse',
    og: 'clubhouse',
    ld: [crumbs([['Home', '/'], ['Clubhouse', '/clubhouse']])],
  }, body);
}

function menuPage() {
  const body = `${pageHero({ kicker: 'Live from the bar', title: 'Menu & Order', lead: 'Order to your table in the clubhouse, or ahead for collection and pay at the bar.' })}
<section class="section order-app" id="order" data-order data-api="${esc(MENU_API)}" data-slug="${esc(MENU_SLUG)}" data-phone="${esc(club.phone)}" data-tel="${esc(club.phone_e164)}">
  <div class="wrap">
    <div class="order-status" data-order-status aria-live="polite">
      <div class="skeleton"><span></span><span></span><span></span></div>
      <noscript><p class="notice">${icon('info', { size: 20 })} The menu needs JavaScript. You can also order at the bar or call ${esc(club.phone)}.</p></noscript>
    </div>
    <div class="order-modes" data-modes hidden>
      <button type="button" class="mode" data-mode="table" aria-pressed="false">${icon('table', { size: 22 })}<span><b>I'm at the club</b><small>Order to my table</small></span></button>
      <button type="button" class="mode" data-mode="collect" aria-pressed="false">${icon('bag', { size: 22 })}<span><b>Collection</b><small>Order ahead, pay at the bar</small></span></button>
    </div>
    <div class="order-layout" data-layout hidden>
      <div class="menu-col">
        <nav class="menu-tabs" data-tabs aria-label="Menu sections"></nav>
        <div class="menu-search"><label class="sr" for="menu-q">Search the menu</label><input id="menu-q" type="search" placeholder="Search the menu" data-search></div>
        <div data-sections></div>
      </div>
      <aside class="basket" data-basket aria-label="Your order">
        <h2>${icon('bag', { size: 22 })} Your order</h2>
        <div data-basket-lines><p class="muted">Nothing yet. Tap <b>Add</b> on a dish.</p></div>
        <div class="totals" data-totals></div>
        <form class="checkout" data-checkout hidden novalidate>
          <div data-where></div>
          <label>Your name<input name="name" autocomplete="name" maxlength="120"></label>
          <label>Phone number<input name="phone" type="tel" autocomplete="tel" maxlength="40"></label>
          <label data-when-wrap hidden>Collect at<select name="collect_at" data-when></select></label>
          <label>Anything we should know?<textarea name="note" rows="2" maxlength="400" placeholder="No onions, extra sauce…"></textarea></label>
          <p class="small muted">${icon('info', { size: 16 })} Allergies? Check the dish details and tell the bar before you eat. By ordering you agree to our <a href="/ordering-terms">ordering terms</a>.</p>
          <p class="form-error" data-error role="alert" hidden></p>
          <button class="btn btn-glow btn-block" type="submit" data-place>Place order</button>
        </form>
      </aside>
    </div>
    <div class="basket-bar" data-basket-bar hidden><button type="button" class="btn btn-glow btn-block" data-basket-jump>${icon('bag', { size: 20 })} <span data-basket-count>0 items</span> · <span data-basket-total>£0.00</span></button></div>
  </div>
  <dialog class="sheet" data-sheet aria-labelledby="sheet-title"><form method="dialog" class="sheet-in" data-sheet-form></form></dialog>
</section>
<section class="section">
  <div class="wrap grid-3">
    <div class="card feature reveal"><span class="tile-ic">${icon('qr')}</span><h2>Scan at your table</h2><p>Every table in the clubhouse has its own code. Scan it with your phone camera and your order goes to that table.</p></div>
    <div class="card feature reveal"><span class="tile-ic">${icon('bag')}</span><h2>Collect and pay at the bar</h2><p>Order for collection with your name and number. Pay by card or cash when you pick it up.</p></div>
    <div class="card feature reveal"><span class="tile-ic">${icon('leaf')}</span><h2>Allergens on every dish</h2><p>Each dish shows the 14 major allergens from the bar's own records. If you have an allergy, please tell the bar too.</p></div>
  </div>
</section>`;
  return page({
    title: 'Menu & Order',
    description: `${club.name} clubhouse menu, live from the bar's till: order food to your table in the club, or for collection on Ynysderw Road and pay at the bar.`,
    path: '/menu',
    og: 'menu',
    ld: [crumbs([['Home', '/'], ['Menu & Order', '/menu']])],
    scripts: `<script src="/js/order.js?v=${ASSET_VERSION}" defer></script>`,
  }, body);
}

function membershipPage() {
  const body = `${pageHero({ kicker: 'Members\' club', title: 'Membership', lead: esc(club.membership.text) })}
<section class="section members-band light">
  <div class="wrap members-in">
    <div class="phone reveal" aria-hidden="true"><div class="phone-screen"><img src="/img/crest-128.webp" alt="" width="64" height="64"><b>Pontardawe RFC</b><span>Members' card</span><div class="fake-qr">${icon('qr', { size: 96 })}</div><small>Show this at the bar</small></div></div>
    <div>
      <h2 class="reveal">What you get</h2>
      <ul class="ticks">${club.membership.benefits.map((b) => `<li class="reveal">${icon('check', { size: 20 })}${esc(b)}</li>`).join('')}</ul>
      <div class="cta-row reveal"><a class="btn btn-glow" href="${MEMBERS}/">${icon('card', { size: 20 })} Open the members' app</a></div>
    </div>
  </div>
</section>
<section class="section">
  <div class="wrap grid-3">
    <div class="card step-card reveal"><span class="num">1</span><h2>Join at the club</h2><p>${esc(club.membership.join.split('; then')[0])}.</p></div>
    <div class="card step-card reveal"><span class="num">2</span><h2>Sign in</h2><p>Go to <a href="${MEMBERS}/">member.pontardawerfc.com</a> and sign in with your email address and the one-time code we send you.</p></div>
    <div class="card step-card reveal"><span class="num">3</span><h2>Show your card</h2><p>Show the code at the bar. Your members' discount is applied at the till, every visit.</p></div>
  </div>
</section>
<section class="section">
  <div class="wrap callout reveal">
    <span class="tile-ic">${icon('android')}</span>
    <div><h2>On your home screen</h2><p>Open <a href="${MEMBERS}/">member.pontardawerfc.com</a> on your phone and choose <b>Add to Home Screen</b> (iPhone: the Share button; Android: the browser menu). It opens like an app, straight onto your card. Old links to loyalty.vesopa.com/pontardawe-rfc bring you here automatically.</p></div>
  </div>
</section>`;
  return page({
    title: 'Membership',
    description: `Join ${club.name} and carry your members' card on your phone at member.pontardawerfc.com: members' discount at the bar, club news and offers.`,
    path: '/membership',
    og: 'membership',
    ld: [crumbs([['Home', '/'], ['Membership', '/membership']])],
  }, body);
}

function contactPage() {
  const a = club.address;
  const body = `${pageHero({ kicker: 'Get in touch', title: 'Contact', lead: 'Call, message or come and see us.' })}
<section class="section">
  <div class="wrap grid-3">
    <a class="card contact-card reveal" href="tel:${club.phone_e164}"><span class="tile-ic">${icon('phone')}</span><h2>Phone</h2><p class="big">${esc(club.phone)}</p><p class="muted">The clubhouse</p></a>
    ${club.email ? `<a class="card contact-card reveal" href="mailto:${esc(club.email)}"><span class="tile-ic">${icon('mail')}</span><h2>Email</h2><p class="big small-break">${esc(club.email)}</p><p class="muted">The club committee</p></a>` : ''}
    <a class="card contact-card reveal" href="${club.web.facebook}" rel="noopener" target="_blank"><span class="tile-ic">${icon('facebook')}</span><h2>Facebook</h2><p class="big">PontardaweRFC</p><p class="muted">News, photos and messages</p></a>
  </div>
</section>
<section class="section visit">
  <div class="wrap visit-in">
    <div class="reveal">
      <h2>Find the clubhouse</h2>
      <p class="addr">${icon('pin', { size: 22 })}<span>${esc(a.name)}<br>${esc(a.street)}<br>${esc(a.town)}, ${esc(a.county)}<br>${esc(a.postcode)}</span></p>
      <p class="muted">Home matches are played at the ${esc(club.ground)}.</p>
      <div class="cta-row"><a class="btn btn-glow" href="https://www.google.com/maps/dir/?api=1&destination=${a.lat},${a.lng}" rel="noopener" target="_blank">${icon('pin', { size: 20 })} Get directions</a></div>
      <p class="small muted">${esc(club.company.name)} · company ${esc(club.company.number)} · registered office ${esc(club.company.registered_office)}</p>
    </div>
    <div class="map reveal">${mapCard()}</div>
  </div>
</section>`;
  return page({
    title: 'Contact',
    description: `Contact ${club.name}: clubhouse on Ynysderw Road, Pontardawe SA8 4EG, phone ${club.phone}, Facebook and directions.`,
    path: '/contact',
    og: 'contact',
    ld: [crumbs([['Home', '/'], ['Contact', '/contact']])],
  }, body);
}

// --- The small print -------------------------------------------------------

function legal({ path, title, lead, sections, description }) {
  const body = `${pageHero({ kicker: 'The small print', title, lead })}
<section class="section"><div class="wrap article legal">
${sections.map(([id, h, html]) => `<h2 id="${id}">${esc(h)}</h2>\n${html}`).join('\n')}
<p class="muted small">Last updated 10 October 2026.</p>
</div></section>`;
  return page({ title, description, path, og: 'home', ld: [crumbs([['Home', '/'], [title, path]])] }, body);
}

function privacyPage() {
  const c = club;
  const contact = `${esc(c.company.name)}, ${esc(c.company.registered_office)}${c.email ? `, <a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : ''}, ${esc(c.phone)}`;
  return legal({
    path: '/privacy',
    title: 'Privacy policy',
    lead: 'What we collect, why, and what you can ask us to do with it.',
    description: `How ${c.name} uses personal information on pontardawerfc.com, for food orders, the members' app and the club helper.`,
    sections: [
      ['who', 'Who we are', `<p>This website and the members' app at member.pontardawerfc.com are run by ${contact} ("the club", "we"). The club is the controller of your personal information. Our software provider, Vesopa EPOS (Vesopa Software Ltd, Wales), runs the website, the ordering system, the till and the members' app for us as our processor.</p>`],
      ['browse', 'Visiting the website', `<p>We do not use analytics, advertising or tracking of any kind, and we set no cookies. Like every web server, ours keeps short technical logs (IP address, the page asked for, the time and your browser's description) to keep the site secure and working. These are kept only as long as needed for that, normally a few weeks.</p><p>Your browser keeps your basket and your helper conversation on your own device (local storage) so they survive a reload. That never leaves your device unless you place an order or ask a question, and you can clear it at any time in your browser.</p>`],
      ['orders', 'Ordering food', `<p>When you order, we receive the dishes you chose, your table (for orders in the clubhouse), and the name, phone number and note you give us. We use them to make your order, to call your name when it's ready, and to ring you if there is a problem with it. The order goes onto the club's till and kitchen screen, and is kept with our sales records for as long as the law requires us to keep accounts (six years). Our lawful basis is to take the steps you asked for (contract).</p><p>You pay at the bar, so we never see or store your card details online.</p>`],
      ['members', 'The members\' app', `<p>To give you a members' card we hold your name, email address, membership number, your membership status, and the visits and purchases made with your card, so that the members' discount is applied and you can see what you've spent and saved. Optional: your phone number, a profile photo, and your location while the app is open (to show you are at the club). If you allow notifications, we send club news and offers; you can turn them off at any time. Our lawful bases are your membership (contract), and your consent for notifications and anything optional.</p><p>You can see and correct your details in the app, and delete your account from <b>Account</b> in the app.</p>`],
      ['helper', 'The club helper (AI)', `<p>The "Ask the club" helper answers questions from the club's own published information. What you type is sent to an AI service (DeepSeek, with Google Gemini as a back-up) to write the answer. Before it leaves our server we remove email addresses, phone numbers and card numbers from it. We do not send your name, account or location, and we keep no copy of the conversation on our server beyond a count of how many questions were asked. Please don't type personal details into the helper. The AI services may process what you type outside the UK, under their own terms; if you would rather not, call or message the club instead. Our lawful basis is our legitimate interest in answering visitors' questions quickly.</p>`],
      ['share', 'Who we share it with', `<p>Only our processors (Vesopa EPOS, and the AI services described above for helper questions), and anyone the law requires us to share with. We never sell personal information or use it for advertising.</p>`],
      ['rights', 'Your rights', `<p>You can ask for a copy of your information, ask us to correct or delete it, object to how we use it, or withdraw consent at any time. Ask at the bar, call ${esc(c.phone)}${c.email ? ` or email <a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : ''}. We will answer within one month. If you're unhappy with how we've handled your information, you can complain to the Information Commissioner's Office at <a href="https://ico.org.uk/make-a-complaint/" rel="noopener">ico.org.uk</a> or on 0303 123 1113.</p>`],
      ['children', 'Children', `<p>The members' app and online ordering are for adults. Junior rugby has its own consent forms, held by the club and not on this website.</p>`],
    ],
  });
}

function cookiesPage() {
  return legal({
    path: '/cookies',
    title: 'Cookies',
    lead: 'Short version: we don\'t use any.',
    description: `${club.name} uses no cookies, analytics or advertising trackers on pontardawerfc.com.`,
    sections: [
      ['none', 'No cookies', '<p>pontardawerfc.com sets no cookies and loads nothing from advertising or analytics companies. Our fonts, pictures and scripts all come from this site.</p>'],
      ['storage', 'What your browser keeps', '<p>To make the site work as you use it, your browser stores three things on your own device: whether you\'ve seen the opening animation this visit, your basket on the menu page, and your conversation with the club helper. These are strictly necessary for the features you choose to use, so the law does not ask us for consent; clearing your browser\'s site data removes them.</p>'],
      ['members', 'The members\' app', '<p>member.pontardawerfc.com keeps you signed in on your device with a token in its local storage. Signing out removes it.</p>'],
    ],
  });
}

function termsPage() {
  return legal({
    path: '/ordering-terms',
    title: 'Ordering terms',
    lead: 'How online orders from the clubhouse work.',
    description: `The terms for ordering food online from ${club.name}'s clubhouse, to your table or for collection.`,
    sections: [
      ['who', 'Who you\'re ordering from', `<p>${esc(club.company.name)} (company ${esc(club.company.number)}), ${esc(club.company.registered_office)}.</p>`],
      ['order', 'Your order', '<p>Prices and availability come straight from the bar\'s till when you order, and the price you see when you place the order is the price you pay. An order is accepted when the bar accepts it; until then it may be refused (for example if the kitchen is too busy or a dish has run out), and you will see that on the order screen.</p>'],
      ['table', 'Orders to your table', '<p>Orders to a table are added to that table\'s bill in the clubhouse. Please only order to the table you are sitting at.</p>'],
      ['collect', 'Orders for collection', '<p>Leave a name and a phone number we can reach you on. Collect your order from the bar and pay there by card or cash. If you can\'t make it, please call us so the food isn\'t wasted. Orders not collected within an hour of the time given may be cancelled.</p>'],
      ['allergens', 'Allergies', '<p>Each dish shows the allergens recorded by the bar. Our kitchen handles all 14 major allergens, so we cannot guarantee any dish is free of traces. If you have an allergy, tell the bar before you eat.</p>'],
      ['age', 'Age-restricted items', '<p>Alcohol is only served to people aged 18 and over, and you may be asked for ID when you collect or are served.</p>'],
      ['help', 'Problems', `<p>Call the club on ${esc(club.phone)} or speak to the bar. Nothing here affects your legal rights.</p>`],
    ],
  });
}

function accessibilityPage() {
  return legal({
    path: '/accessibility',
    title: 'Accessibility',
    lead: 'We want everyone to be able to use this site.',
    description: `Accessibility of pontardawerfc.com, the ${club.name} website.`,
    sections: [
      ['aim', 'What we aim for', '<p>The site is built to the WCAG 2.2 AA standard: it works with a keyboard and screen readers, text can be enlarged to 200%, colours meet contrast guidance, and it respects your device\'s dark mode and reduced-motion settings (the opening animation and movement switch off).</p>'],
      ['help', 'If something doesn\'t work', `<p>Tell us at the bar, call ${esc(club.phone)}${club.email ? ` or email <a href="mailto:${esc(club.email)}">${esc(club.email)}</a>` : ''}, and we\'ll fix it or help you another way, including taking your order by phone.</p>`],
    ],
  });
}

function notFound() {
  const body = `${pageHero({ kicker: '404', title: 'Knock-on!', lead: 'That page isn\'t here. It may have moved when we built the new site.' })}
<section class="section"><div class="wrap center"><div class="cta-row center"><a class="btn btn-glow" href="/">${icon('ball', { size: 20 })} Back to the home page</a><a class="btn btn-line" href="/menu">Menu &amp; order</a><a class="btn btn-line" href="${MEMBERS}/">Members' card</a></div></div></section>`;
  return page({ title: 'Page not found', description: 'This page could not be found.', path: '/404', og: 'home', noindex: true }, body);
}

module.exports = {
  home, clubPage, teamsPage, newsPage, articlePage, clubhousePage, menuPage, membershipPage,
  contactPage, privacyPage, cookiesPage, termsPage, accessibilityPage, notFound, MENU_API, MENU_SLUG,
};
