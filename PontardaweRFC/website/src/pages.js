/**
 * Every page of pontardawerfc.com. Server-rendered, so each one is complete
 * without JavaScript and readable by search engines and link previews; the
 * scripts add the opening, the reveals, the menu and the helper on top.
 */
'use strict';

const { club, news, updates, images, xPosts, longDate, yearsOld } = require('./content');
const wru = require('./wru');
const venue = require('./venue_api');
const { page, pageHero, esc, icon, SITE, MEMBERS, ASSET_VERSION, appBadges } = require('./layout');
const GAME = require('../public/js/game-rules.js');

const MENU_API = (process.env.MENU_API || 'https://menu.vesopa.com').replace(/\/+$/, '');
const MENU_SLUG = process.env.MENU_SLUG || 'pontardawe-rfc';

function photo(name, { cls = '', sizes = '(max-width: 700px) 100vw, 640px', lazy = true } = {}) {
  const m = images[name];
  if (!m) return '';
  // The club's update posters come in two sizes: a phone or a card in a grid
  // takes the 480px one, a big screen the 960px one. Everything but the
  // opening picture loads lazily, as it is scrolled to.
  const set = name.startsWith('ig/') ? ` srcset="/img/${name}-480.webp 480w, /img/${name}.webp ${m.w}w"` : ` srcset="/img/${name}.webp"`;
  return `<picture class="${cls}"><source${set} type="image/webp" sizes="${sizes}"><img src="/img/${name}.jpg" alt="${esc(m.alt)}" width="${m.w}" height="${m.h}" sizes="${sizes}"${lazy ? ' loading="lazy" decoding="async"' : ' fetchpriority="high"'}></picture>`;
}

/** What kind of update a post is: its label and icon. */
const KINDS = {
  match: ['Match', 'whistle'], event: ['Event', 'party'], juniors: ['Juniors', 'child'], food: ['Pop-up food', 'food'],
  lotto: ['Weekly Lotto', 'lotto'], touch: ['Touch rugby', 'ball'], club: ['Club news', 'star'],
};
const kindOf = (k) => KINDS[k] || KINDS.club;

/** Today in the UK, as YYYY-MM-DD. */
const todayUK = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());

/** The club's events still to come (from its own posts), soonest first. */
function comingUp() {
  const now = todayUK();
  return updates.filter((u) => u.event && u.event.start.slice(0, 10) >= now)
    .sort((a, b) => a.event.start.localeCompare(b.event.start));
}

/** "Sat 17 Oct" and "2:30pm" from 2026-10-17T14:30. */
function whenParts(iso) {
  const [day, time] = String(iso).split('T');
  const d = new Date(`${day}T12:00:00Z`);
  const part = (o) => d.toLocaleDateString('en-GB', { ...o, timeZone: 'Europe/London' });
  let t = '';
  if (time) {
    const [h, m] = time.split(':').map(Number);
    t = `${((h + 11) % 12) + 1}${m ? `:${String(m).padStart(2, '0')}` : ''}${h < 12 ? 'am' : 'pm'}`;
  }
  return { day, wd: part({ weekday: 'short' }), dd: part({ day: 'numeric' }), mon: part({ month: 'short' }), long: part({ weekday: 'long', day: 'numeric', month: 'long' }), time: t };
}

/** Days from today (UK) to an ISO date. */
function daysTo(iso) {
  const a = new Date(`${todayUK()}T12:00:00Z`);
  const b = new Date(`${String(iso).slice(0, 10)}T12:00:00Z`);
  return Math.round((b - a) / 864e5);
}

/** The club's own poster for a match on this day, if it posted one. */
const posterFor = (day) => updates.find((u) => u.kind === 'match' && u.event && u.event.start.slice(0, 10) === day && u.image);

/**
 * The next First XV match: the WRU's list first (it has the real kick-off and
 * the opponent's crest), else the club's own post about it.
 */
function nextFixture() {
  const f = wru.fixtures().upcoming[0];
  if (f) return f;
  const u = comingUp().find((x) => x.kind === 'match');
  if (!u) return null;
  const [day, time] = u.event.start.split('T');
  return { id: `club-${u.slug}`, day, kickoff: time || null, home: Boolean(u.event.home), opponent: u.event.opponent || 'TBC', opponentLogo: null, competition: u.event.competition || null, status: 'UPCOMING', fromClub: true };
}

/** One upcoming event as a card with its poster and a date badge. */
function eventTile(u, { big = false } = {}) {
  const w = whenParts(u.event.start);
  const n = daysTo(u.event.start);
  const soon = n <= 0 ? 'Today' : n === 1 ? 'Tomorrow' : n <= 7 ? `In ${n} days` : '';
  const [label, ic] = kindOf(u.kind);
  return `<article class="ev-tile reveal${big ? ' ev-big' : ''}" data-tilt>
  <a href="/news/${esc(u.slug)}" class="ev-link">
    <div class="ev-poster">${photo(u.image, { sizes: big ? '(max-width: 760px) 100vw, 560px' : '(max-width: 760px) 100vw, 380px' })}<span class="ev-date"><b>${esc(w.dd)}</b><span>${esc(w.mon)}</span></span>${soon ? `<span class="ev-soon">${esc(soon)}</span>` : ''}</div>
    <div class="ev-body">
      <p class="ev-kind">${icon(ic, { size: 16 })} ${esc(label)}</p>
      <h3>${esc(u.title)}</h3>
      <p class="ev-meta">${icon('clock', { size: 16 })} ${esc(w.long)}${w.time ? `, ${esc(w.time)}` : ''}</p>
      ${u.event.price ? `<p class="ev-meta">${icon('ticket', { size: 16 })} ${esc(u.event.price)}</p>` : ''}
      <span class="more">Details ${icon('arrow', { size: 18 })}</span>
    </div>
  </a>
</article>`;
}

function crumbs(items) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map(([name, path], i) => ({ '@type': 'ListItem', position: i + 1, name, item: `${SITE}${path}` })),
  };
}

function newsCard(post, { big = false } = {}) {
  const img = post.image ? photo(post.image, { cls: 'card-img', sizes: '(max-width: 640px) 100vw, (max-width: 980px) 50vw, 380px' }) : `<div class="card-img card-img-art" aria-hidden="true"><img src="/img/crest-128.webp" alt="" width="96" height="96" loading="lazy"></div>`;
  return `<article class="card news-card reveal${big ? ' news-big' : ''}">
  <a href="/news/${esc(post.slug)}" class="card-link">
    ${img}
    <div class="card-body">
      <p class="meta">${icon('calendar', { size: 16 })} <time datetime="${esc(post.date)}">${esc(longDate(post.date))}</time>${post.closed ? ' · <span class="tag">Closed</span>' : ''}${post.kind ? ` · <span class="tag tag-${esc(post.kind)}">${esc(kindOf(post.kind)[0])}</span>` : ''}</p>
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
<section class="hero" aria-label="Welcome" data-hero>
  <canvas class="hero-canvas" data-hero-canvas aria-hidden="true"></canvas>
  <div class="hero-bg" aria-hidden="true">
    <span class="hoop"></span><span class="hoop"></span><span class="hoop"></span><span class="hoop"></span>
    <span class="glow"></span>
  </div>
  <div class="hero-photo" aria-hidden="true">${photo('squad-2024', { lazy: false, sizes: '100vw' })}</div>
  <div class="wrap hero-in">
    <div class="hero-copy">
      <p class="kicker reveal">${icon('ball', { size: 18 })} Est. ${club.founded} · Swansea Valley</p>
      <h1 class="hero-title"><span class="ht-line"><span>Pride of</span></span> <span class="ht-line hl"><span>Pontardawe</span></span> <span class="ht-line"><span>since ${club.founded}</span></span></h1>
      <p class="lead reveal">${esc(club.short)}</p>
      <div class="cta-row reveal">
        <a class="btn btn-glow" href="/whats-on">${icon('calendar', { size: 20 })} What's on</a>
        <a class="btn btn-ghost" href="/menu">${icon('plate', { size: 20 })} Menu &amp; order</a>
      </div>
      ${heroMatch()}
    </div>
    <div class="hero-badge" data-tilt-crest aria-hidden="true">
      <div class="badge-ring"></div><div class="badge-ring r2"></div>
      <svg class="orbit" viewBox="0 0 200 200"><ellipse cx="100" cy="100" rx="96" ry="96" class="orbit-path"/><g class="orbit-ball"><ellipse cx="0" cy="0" rx="9" ry="5.5"/><path d="M-4 0h8M-2-2v4M0-2v4M2-2v4"/></g></svg>
      <picture><source srcset="/img/crest-256.webp" type="image/webp"><img src="/img/crest-512.png" alt="" width="320" height="320" fetchpriority="high"></picture>
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

<div class="ticker" aria-hidden="true"><div class="ticker-track">${Array.from({ length: 2 }, () => ['Clwb Rygbi Pontardawe', `Est. ${club.founded}`, 'Swansea Valley', 'WRU member club', 'Ynysderw Road', 'First XV', 'Juniors', 'Clubhouse &amp; bar'].map((t) => `<span>${t}</span><i>${icon('ball', { size: 18 })}</i>`).join('')).join('')}</div></div>

${nextMatch()}

${homeWhatsOn()}

${playBand()}

<section class="section" id="quick">
  <div class="wrap">
    <div class="tiles">
      <a class="tile reveal" href="/menu"><span class="tile-ic">${icon('plate')}</span><h2>Menu &amp; order</h2><p>Order to your table, or for collection and pay at the bar.</p><span class="more">Order now ${icon('arrow', { size: 18 })}</span></a>
      <a class="tile reveal" href="${MEMBERS}/"><span class="tile-ic">${icon('card')}</span><h2>Members' card</h2><p>Your card and members' discount at member.pontardawerfc.com.</p><span class="more">Open the app ${icon('arrow', { size: 18 })}</span></a>
      <a class="tile reveal" href="/fixtures"><span class="tile-ic">${icon('whistle')}</span><h2>Fixtures &amp; results</h2><p>The next match, every score and the league table, live from the WRU.</p><span class="more">See fixtures ${icon('arrow', { size: 18 })}</span></a>
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

<section class="section gallery-sec">
  <div class="wrap">
    <div class="sec-head"><div><p class="kicker reveal">On the pitch</p><h2 class="reveal">Rugby in the Swansea Valley</h2></div><a class="btn btn-line reveal" href="${esc(club.web.instagram)}" rel="noopener">${icon('instagram', { size: 18 })} More on Instagram</a></div>
    <div class="gallery">
      <figure class="g-wide reveal">${photo('squad-2024', { sizes: '(max-width: 1200px) 100vw, 1180px' })}<figcaption>The squad, coaches and committee, 2024</figcaption></figure>
      <figure class="reveal">${photo('squad-pitch')}<figcaption>Two squads line up at the Recreation Ground</figcaption></figure>
      <figure class="reveal">${photo('lineout')}<figcaption>Contesting a lineout</figcaption></figure>
      <figure class="reveal">${photo('squad-sponsor')}<figcaption>The squad and their sponsors</figcaption></figure>
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
    <div class="grid-3">${news.slice(0, 6).map((p) => newsCard(p)).join('')}</div>
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
      <p class="kicker reveal">The club app · Membership</p>
      <h2 class="reveal">The Pontardawe RFC app</h2>
      <p class="reveal">Your members' card, club news and offers, for iPhone, iPad and Android.</p>
      <ul class="ticks">${club.membership.benefits.map((b) => `<li class="reveal">${icon('check', { size: 20 })}${esc(b)}</li>`).join('')}</ul>
      <div class="reveal">${appBadges({ cls: 'badges-lg' })}</div>
      <div class="cta-row reveal"><a class="btn btn-line" href="${MEMBERS}/">${icon('card', { size: 20 })} Or use it in your browser</a><a class="btn btn-line" href="/membership">How to join</a></div>
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
      ${wru.fixtures().upcoming.length ? `<ol class="fx-list">${wru.fixtures().upcoming.slice(0, 3).map((f) => fixtureRow(f)).join('')}</ol>` : ''}
      <div class="cta-row"><a class="btn btn-glow" href="/fixtures">${icon('calendar', { size: 20 })} Fixtures, results &amp; table</a><a class="btn btn-line" href="/tickets">${icon('ticket', { size: 20 })} Tickets</a></div>
    </div>
    <div class="reveal">${photo('squad-2024')}</div>
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
  <div class="wrap"><p class="muted center reveal">More match news and photos on our <a href="${club.web.facebook}" rel="noopener">Facebook page</a> and <a href="${club.web.x}" rel="noopener">X</a>.</p></div>
</section>
${xArchive()}`;
  return page({
    title: 'News',
    description: `News from ${club.name}: club announcements, tributes and the latest from the clubhouse on Ynysderw Road.`,
    path: '/news',
    og: 'news',
    ld: [crumbs([['Home', '/'], ['News', '/news']])],
  }, body);
}

function articlePage(post) {
  const img = post.image ? `<figure class="article-img reveal">${photo(post.image, { lazy: false, sizes: '(max-width: 820px) 100vw, 780px' })}</figure>` : '';
  const ev = post.event;
  const w = ev ? whenParts(ev.start) : null;
  const upcoming = ev && daysTo(ev.start) >= 0;
  const eventBox = ev ? `<aside class="event-box reveal${upcoming ? ' is-next' : ''}">
      <span class="ev-date"><b>${esc(w.dd)}</b><span>${esc(w.mon)}</span></span>
      <div><p class="ev-kind">${upcoming ? 'Coming up' : 'Took place'}</p><h2>${esc(w.long)}${w.time ? `, ${esc(w.time)}` : ''}</h2>
      <p>${icon('pin', { size: 16 })} ${esc(ev.place || club.address.name)}${ev.note ? ` · ${esc(ev.note)}` : ''}</p>
      ${ev.price ? `<p>${icon('ticket', { size: 16 })} ${esc(ev.price)}</p>` : ''}</div>
    </aside>` : '';
  const gallery = (post.gallery || []).slice(1);
  const more = gallery.length ? `<div class="article-gallery">${gallery.map((g) => `<figure class="reveal">${photo(g, { sizes: '(max-width: 640px) 100vw, 380px' })}</figure>`).join('')}</div>` : '';
  const cta = post.cta ? `<p class="cta-row"><a class="btn btn-glow" href="${esc(post.cta.href)}" rel="noopener">${icon('facebook', { size: 20 })} ${esc(post.cta.label)}</a></p>` : '';
  const source = post.source === 'instagram' ? `<p class="muted small">From the club's <a href="${esc(club.web.instagram)}" rel="noopener">Instagram</a> and <a href="${esc(club.web.facebook)}" rel="noopener">Facebook</a>.</p>` : '';
  const body = `${pageHero({ kicker: longDate(post.date), title: post.title, lead: '' })}
<section class="section">
  <article class="wrap article">
    ${post.closed ? `<p class="notice">${icon('info', { size: 20 })} This vacancy closed on 7 October 2024. It is kept here as part of the club's news.</p>` : ''}
    ${eventBox}
    ${img}
    ${post.paragraphs.map((p) => (/^\d+\.\s|^\d+\.[A-Z]/.test(p) ? `<h2>${esc(p)}</h2>` : `<p>${esc(p)}</p>`)).join('\n    ')}
    ${cta}
    ${more}
    ${source}
    <p class="back"><a href="${ev ? '/whats-on' : '/news'}">${icon('arrow', { size: 18 })} ${ev ? "What's on" : 'All news'}</a></p>
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

/** JSON for a <script type="application/json">: nothing in it can close the tag. */
const inlineJson = (v) => JSON.stringify(v).replace(/</g, '\\u003c');

function menuPage() {
  // The menu is drawn from the server's copy at once; the script fetches only
  // for a table's own link (?table=), or when the server has no copy yet.
  const menu = venue.menu();
  const body = `${pageHero({ kicker: 'Live from the bar', title: 'Menu & Order', lead: 'Order to your table in the clubhouse, or ahead for collection and pay at the bar.' })}
${menu ? `<script type="application/json" id="menu-data">${inlineJson(menu)}</script>` : ''}
<section class="section order-app" id="order" data-order data-api="${esc(MENU_API)}" data-slug="${esc(MENU_SLUG)}" data-phone="${esc(club.phone)}" data-tel="${esc(club.phone_e164)}">
  <div class="wrap">
    <div class="order-status" data-order-status aria-live="polite">
      ${menu ? '' : '<div class="skeleton"><span></span><span></span><span></span></div>'}
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

/**
 * The Android apps as files, for a phone without Google Play or anybody who
 * would rather not wait for it: the phone app and the Wear OS watch app. The
 * files sit on the box under public/downloads (tool/deploy_pontardawe_site.py
 * --apks), never in git. iPhone stays on TestFlight, so nothing here for it.
 */
function directDownloads() {
  const { android_apk: phone, wear_apk: watch } = club.web;
  if (!phone && !watch) return '';
  return `<div class="apk-downloads reveal">
        <p><b>Android without Google Play?</b> Download the app directly:</p>
        <p class="apk-links">${phone ? `<a class="btn btn-sm btn-line" href="${esc(phone)}" download>${icon('card', { size: 18 })} Phone app (APK)</a>` : ''}${watch ? `<a class="btn btn-sm btn-line" href="${esc(watch)}" download>${icon('card', { size: 18 })} Wear OS watch app (APK)</a>` : ''}</p>
        <p class="apk-note">Open the file on your phone and allow installs from your browser when Android asks. On a watch, install it with your phone's Wear OS app or ADB.</p>
      </div>`;
}

function membershipPage() {
  const body = `${pageHero({ kicker: 'Members\' club', title: 'Membership', lead: esc(club.membership.text) })}
<section class="section members-band light">
  <div class="wrap members-in">
    <div class="phone reveal" aria-hidden="true"><div class="phone-screen"><img src="/img/crest-128.webp" alt="" width="64" height="64"><b>Pontardawe RFC</b><span>Members' card</span><div class="fake-qr">${icon('qr', { size: 96 })}</div><small>Show this at the bar</small></div></div>
    <div>
      <h2 class="reveal">What you get</h2>
      <ul class="ticks">${club.membership.benefits.map((b) => `<li class="reveal">${icon('check', { size: 20 })}${esc(b)}</li>`).join('')}</ul>
      <h3 class="reveal" id="app">Get the club app</h3>
      <div class="reveal">${appBadges({ qr: true, cls: 'badges-lg' })}</div>
      ${directDownloads()}
      <div class="cta-row reveal"><a class="btn btn-line" href="${MEMBERS}/">${icon('card', { size: 20 })} Or use it in your browser</a></div>
    </div>
  </div>
</section>
<section class="section">
  <div class="wrap grid-3">
    <div class="card step-card reveal"><span class="num">1</span><h2>Join at the club</h2><p>${esc(club.membership.join.split('; then')[0])}.</p></div>
    <div class="card step-card reveal"><span class="num">2</span><h2>Get the app</h2><p>Download the Pontardawe RFC app (<a href="/app">iPhone or Android</a>) or go to <a href="${MEMBERS}/">member.pontardawerfc.com</a>, and sign in with your email address and the one-time code we send you.</p></div>
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
    <a class="card contact-card reveal" href="${club.web.x}" rel="noopener" target="_blank"><span class="tile-ic">${icon('x')}</span><h2>X (Twitter)</h2><p class="big">@PontardaweRFC</p><p class="muted">Club news since 2012</p></a>
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
    description: `How ${c.name} uses personal information on pontardawerfc.com, the Pontardawe RFC app, food orders, tickets and the club helper.`,
    sections: [
      ['who', 'Who we are', `<p>This website, the members' app at member.pontardawerfc.com and the Pontardawe RFC app for iPhone, iPad and Android are run by ${contact} ("the club", "we"). The club is the controller of your personal information. Our software provider, Vesopa EPOS (Vesopa Software Ltd, Wales), runs the website, the ordering system, the till and the members' app for us as our processor.</p>`],
      ['browse', 'Visiting the website', `<p>We do not use analytics, advertising or tracking of any kind, and we set no cookies. Like every web server, ours keeps short technical logs (IP address, the page asked for, the time and your browser's description) to keep the site secure and working. These are kept only as long as needed for that, normally a few weeks.</p><p>Your browser keeps your basket and your helper conversation on your own device (local storage) so they survive a reload. That never leaves your device unless you place an order or ask a question, and you can clear it at any time in your browser.</p>`],
      ['orders', 'Ordering food', `<p>When you order, we receive the dishes you chose, your table (for orders in the clubhouse), and the name, phone number and note you give us. We use them to make your order, to call your name when it's ready, and to ring you if there is a problem with it. The order goes onto the club's till and kitchen screen, and is kept with our sales records for as long as the law requires us to keep accounts (six years). Our lawful basis is to take the steps you asked for (contract).</p><p>You pay at the bar, so we never see or store your card details online.</p>`],
      ['tickets', 'Buying tickets', `<p>When you buy tickets online we receive your name, email address and, if you give it, your mobile number, with the tickets you chose. We use them to send your tickets and their QR codes, to check them at the gate, and to contact you if the event changes. Card payments are taken by our payment provider, Dojo (Paymentsense Ltd); we never see or store your card number. Ticket sales are kept with our sales records for six years. Our lawful basis is to take the steps you asked for (contract).</p>`],
      ['members', 'The members\' app', `<p>To give you a members' card we hold your name, email address, membership number, your membership status, and the visits and purchases made with your card, so that the members' discount is applied and you can see what you've spent and saved. Optional: your phone number, a profile photo, and your location while the app is open (to show you are at the club). If you allow notifications, we send club news and offers; you can turn them off at any time. Our lawful bases are your membership (contract), and your consent for notifications and anything optional.</p><p><b>Signing in.</b> You can sign in with an emailed or texted code, a password, a passkey, or Sign in with Apple or Google. With Apple or Google we receive only your name and email address (or Apple's private relay address if you choose to hide it), never your Apple or Google password. A passkey stays on your device; we hold only its public key. We keep a list of the devices signed in to your account (for example "iPhone"), so you can see them and sign them out.</p><p><b>Photos and notifications.</b> The app asks for your camera or photo library only when you choose a profile photo, and uploads only the photo you pick. If you allow notifications, we keep your device's notification token to send them, and delete it when you turn notifications off or sign out.</p><p>The app has no advertising and no tracking, and we do not share your information with other companies for their own use.</p><p>You can see and correct your details in the app, and delete your account from <b>Account</b> in the app.</p>`],
      ['helper', 'The club helper (AI)', `<p>The "Ask the club" helper answers questions from the club's own published information. What you type is sent to an AI service (DeepSeek, with Google Gemini as a back-up) to write the answer. Before it leaves our server we remove email addresses, phone numbers and card numbers from it. We do not send your name, account or location, and we keep no copy of the conversation on our server beyond a count of how many questions were asked. Please don't type personal details into the helper. The AI services may process what you type outside the UK, under their own terms; if you would rather not, call or message the club instead. Our lawful basis is our legitimate interest in answering visitors' questions quickly.</p>`],
      ['share', 'Who we share it with', `<p>Only our processors (Vesopa EPOS; Dojo for card payments; Apple, Google or our SMS provider only when you sign in or receive a code through them; and the AI services described above for helper questions), and anyone the law requires us to share with. We never sell personal information or use it for advertising.</p>`],
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

/** The fonts and software the site uses, and their licences (the owner, 2026-10-15). */
function licencesPage() {
  const font = (name, by, licence, file, use) => `<tr><th scope="row">${esc(name)}</th><td>${esc(by)}</td><td>${esc(use)}</td><td><a href="/fonts/${file}">${esc(licence)}</a></td></tr>`;
  return legal({
    path: '/licences',
    title: 'Licences',
    lead: 'The fonts and open-source software this site is built with, and the licences they come under.',
    description: `The fonts and open-source software used on pontardawerfc.com, the ${club.name} website, and their licences.`,
    sections: [
      ['fonts', 'Fonts', `<p>Every font is served from this site, so nothing is loaded from anybody else's servers.</p>
<div class="table-wrap"><table class="league licences"><thead><tr><th scope="col">Font</th><th scope="col">By</th><th scope="col">Used for</th><th scope="col">Licence</th></tr></thead><tbody>
${font('Oswald', 'Vernon Adams, Kalapi Gajjar, Cyreal', 'SIL Open Font License 1.1', 'LICENSE-Oswald.txt', 'Headings and numbers')}
${font('Montserrat', 'Julieta Ulanovsky and the Montserrat Project Authors', 'SIL Open Font License 1.1', 'LICENSE-Montserrat.txt', 'Text')}
${font('Permanent Marker', 'Font Diner', 'Apache License 2.0', 'LICENSE-PermanentMarker.txt', 'The lettering in Ponty Kicks')}
</tbody></table></div>`],
      ['software', 'Software', `<p>The site runs on <a href="https://nodejs.org/" rel="noopener">Node.js</a> with <a href="https://expressjs.com/" rel="noopener">Express</a>, <a href="https://github.com/motdotla/dotenv" rel="noopener">dotenv</a> and, for playing <a href="/play">Ponty Kicks</a> with a friend online, <a href="https://github.com/websockets/ws" rel="noopener">ws</a>, all under the MIT License. The animations, the game and its physics are written for the club and use no outside libraries.</p>`],
      ['club', 'The club\'s own', `<p>The club crest, the club's photographs and posters, and the text of this site belong to ${esc(club.company.name)}. Please ask before using them: call ${esc(club.phone)}${club.email ? ` or email <a href="mailto:${esc(club.email)}">${esc(club.email)}</a>` : ''}.</p>
<p>The App Store and Google Play badges are trademarks of Apple Inc. and Google LLC, used as their makers ask.</p>`],
    ],
  });
}

// --- Fixtures, from the WRU (src/wru.js) ------------------------------------

/** "Sat 17 Oct" from 2026-10-17. */
function shortDate(day) {
  const d = new Date(`${day}T12:00:00Z`);
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Europe/London' });
}

function crest(f) {
  return f.opponentLogo
    ? `<img class="opp-logo" src="${esc(encodeURI(f.opponentLogo))}" alt="" width="40" height="40" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.visibility='hidden'">`
    : `<span class="opp-logo opp-none" aria-hidden="true">${icon('shield', { size: 22 })}</span>`;
}

function fixtureRow(f, { tickets = true } = {}) {
  const ha = f.home ? 'Home' : 'Away';
  const score = f.result
    ? `<span class="score score-${f.result.toLowerCase()}" title="${{ W: 'Won', L: 'Lost', D: 'Drawn' }[f.result]}"><b>${f.result}</b> ${f.us}–${f.them}</span>`
    : f.status === 'POSTPONED' ? '<span class="tag">Postponed</span>'
      : `<span class="ko">${f.kickoff ? `${icon('clock', { size: 16 })} ${esc(f.kickoff)}` : 'Time TBC'}</span>`;
  const buy = tickets && !f.result && f.home && f.status !== 'POSTPONED'
    ? `<a class="btn btn-sm btn-line" href="/tickets#m-${f.id}">${icon('ticket', { size: 16 })} Tickets</a>` : '';
  return `<li class="fx reveal" id="m-${f.id}">
  <time class="fx-date" datetime="${esc(f.day)}">${esc(shortDate(f.day))}</time>
  ${crest(f)}
  <div class="fx-main"><b>${f.home ? 'Pontardawe' : esc(f.opponent)} <span class="vs">v</span> ${f.home ? esc(f.opponent) : 'Pontardawe'}</b><small><span class="ha ha-${ha.toLowerCase()}">${ha}</span>${f.competition ? ` · ${esc(f.competition.replace(/^WRU /, ''))}` : ''}${f.team && f.team !== '1st Team' ? ` · ${esc(f.team)}` : ''}</small></div>
  <div class="fx-end">${score}${buy}</div>
</li>`;
}

/** The next match in the hero: a small glass card with the countdown. */
function heroMatch() {
  const f = nextFixture();
  if (!f) return '';
  const when = `${f.day}T${f.kickoff || '14:30'}:00`;
  const opp = esc(f.opponent.replace(/ RFC$/, ''));
  return `<a class="hero-match reveal" href="#next-match">
  <span class="hm-label">${icon('whistle', { size: 16 })} Next match</span>
  <b>${f.home ? `Pontardawe v ${opp}` : `${opp} v Pontardawe`}</b>
  <span class="hm-when">${esc(shortDate(f.day))}${f.kickoff ? ` · ${esc(f.kickoff)}` : ''} · ${f.home ? 'The Rec' : 'Away'}</span>
  <span class="hm-count" data-countdown="${esc(when)}"></span>
</a>`;
}

/** The next match, big: on the home page and at the top of the fixtures page. */
function nextMatch({ heading = 'Next match' } = {}) {
  const f = nextFixture();
  if (!f) return '';
  const when = `${f.day}T${f.kickoff || '14:30'}:00`;
  const opp = esc(f.opponent.replace(/ RFC$/, ''));
  const poster = posterFor(f.day);
  const tickets = f.home && !f.fromClub ? `<a class="btn btn-white" href="/tickets#m-${f.id}">${icon('ticket', { size: 20 })} Tickets</a>` : '';
  return `<section class="next-match${poster ? ' has-poster' : ''}" id="next-match" aria-label="${esc(heading)}">
  <div class="nm-stripes" aria-hidden="true"></div>
  <div class="wrap next-grid">
    ${poster ? `<a class="nm-poster reveal" href="/news/${esc(poster.slug)}" data-tilt>${photo(poster.image, { sizes: '(max-width: 760px) 100vw, 460px' })}<span class="nm-poster-tag">${icon('instagram', { size: 16 })} From the club</span></a>` : ''}
    <div class="next-in reveal">
      <p class="kicker">${icon('whistle', { size: 18 })} ${esc(heading)}${f.competition ? ` · ${esc(f.competition.replace(/^WRU /, ''))}` : ''}</p>
      <div class="nm-teams">
        <div class="nm-side"><img src="/img/crest-128.webp" alt="" width="72" height="72" loading="lazy"><b>${f.home ? 'Pontardawe' : opp}</b></div>
        <div class="nm-mid"><span class="nm-v">v</span><time datetime="${esc(when)}"><span class="nm-long">${esc(longDate(f.day))}</span><span class="nm-short">${esc(shortDate(f.day))}</span>${f.kickoff ? ` <span class="nm-ko">${esc(f.kickoff)}</span>` : ''}</time></div>
        <div class="nm-side">${f.home ? crest(f).replace('width="40" height="40"', 'width="72" height="72"') : '<img src="/img/crest-128.webp" alt="" width="72" height="72" loading="lazy">'}<b>${f.home ? opp : 'Pontardawe'}</b></div>
      </div>
      <div class="nm-clock" data-countdown="${esc(when)}" data-boxes><span class="nm-count"></span></div>
      <p class="nm-where">${icon('pin', { size: 18 })} ${f.home ? `${esc(String(club.ground).split(',')[0])}, Ynysderw Road` : `Away at ${esc(f.opponent)}`}</p>
      <div class="cta-row center">${tickets}<a class="btn btn-ghost" href="/fixtures">${icon('calendar', { size: 20 })} All fixtures</a></div>
    </div>
  </div>
</section>`;
}

/** The home page's look at what is coming up at the club. */
function homeWhatsOn() {
  const list = comingUp().filter((u) => u.kind !== 'match').slice(0, 3);
  if (!list.length) return '';
  return `<section class="section whats-on-home">
  <div class="wrap">
    <div class="sec-head"><div><p class="kicker reveal">${icon('calendar', { size: 16 })} At the club</p><h2 class="reveal">What's on</h2></div><a class="btn btn-line reveal" href="/whats-on">Everything coming up ${icon('arrow', { size: 18 })}</a></div>
    <div class="ev-grid">${list.map((u) => eventTile(u)).join('')}</div>
  </div>
</section>`;
}

function leagueTable(t) {
  if (!t || !t.rows.length) return '';
  return `<div class="table-wrap reveal"><table class="league">
  <caption>${esc(t.name)} ${esc(t.season)}</caption>
  <thead><tr><th scope="col">#</th><th scope="col">Team</th><th scope="col">P</th><th scope="col">W</th><th scope="col">D</th><th scope="col">L</th><th scope="col" title="Points difference">PD</th><th scope="col">Pts</th></tr></thead>
  <tbody>${t.rows.map((r) => `<tr${r.us ? ' class="us"' : ''}><td>${r.pos}</td><th scope="row">${esc(r.team.replace(/ RFC$/, ''))}</th><td>${r.p}</td><td>${r.w}</td><td>${r.d}</td><td>${r.l}</td><td>${r.pd > 0 ? '+' : ''}${r.pd}</td><td><b>${r.pts}</b></td></tr>`).join('')}</tbody>
</table></div>`;
}

function fixturesPage() {
  const fx = wru.fixtures();
  const none = `<p class="muted">The fixture list is loading from the WRU. In the meantime, see <a href="${club.web.wru_league}" rel="noopener">the WRU's fixtures page</a>.</p>`;
  const body = `${pageHero({ kicker: 'First XV', title: 'Fixtures & Results', lead: 'Live from the WRU: every match, every score and the league table.' })}
${nextMatch()}
<section class="section">
  <div class="wrap fixtures-grid">
    <div>
      <h2 class="reveal">${icon('calendar', { size: 26 })} Fixtures</h2>
      ${fx.upcoming.length ? `<ol class="fx-list">${fx.upcoming.map((f) => fixtureRow(f)).join('')}</ol>` : none}
      ${fx.postponed.length ? `<h3 class="reveal">Postponed</h3><ol class="fx-list">${fx.postponed.map((f) => fixtureRow(f, { tickets: false })).join('')}</ol>` : ''}
      <h2 class="reveal">${icon('trophy', { size: 26 })} Results</h2>
      ${fx.results.length ? `<ol class="fx-list">${fx.results.map((f) => fixtureRow(f)).join('')}</ol>` : '<p class="muted">No results yet this season.</p>'}
    </div>
    <aside>
      <h2 class="reveal">${icon('star', { size: 26 })} League table</h2>
      ${leagueTable(fx.table) || none}
      <div class="card reveal side-card"><h3>${icon('ticket', { size: 22 })} Match tickets</h3><p>Home games are at the Recreation Ground on Ynysderw Road. Buy online and collect at the gate, or pay on the day.</p><a class="btn btn-glow" href="/tickets">Tickets</a></div>
      <p class="small muted reveal">From the <a href="${club.web.wru_league}" rel="noopener">WRU</a>${fx.updated ? `, checked ${esc(new Date(fx.updated).toLocaleString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))}` : ''}.</p>
    </aside>
  </div>
</section>`;
  const events = fx.upcoming.map((f) => ({
    '@context': 'https://schema.org',
    '@type': 'SportsEvent',
    name: f.home ? `Pontardawe RFC v ${f.opponent}` : `${f.opponent} v Pontardawe RFC`,
    startDate: `${f.day}T${f.kickoff || '14:30'}:00`,
    sport: 'Rugby union',
    eventStatus: 'https://schema.org/EventScheduled',
    location: f.home ? { '@type': 'Place', name: 'Recreation Ground, Pontardawe', address: `${club.address.street}, ${club.address.town} ${club.address.postcode}` } : { '@type': 'Place', name: f.opponent },
    homeTeam: { '@type': 'SportsTeam', name: f.home ? club.name : f.opponent },
    awayTeam: { '@type': 'SportsTeam', name: f.home ? f.opponent : club.name },
    ...(f.home ? { offers: { '@type': 'Offer', url: `${SITE}/tickets#m-${f.id}`, availability: 'https://schema.org/InStock' } } : {}),
  }));
  return page({
    title: 'Fixtures & Results',
    description: `${club.name} First XV fixtures, results and the league table, live from the WRU. Next match, kick-off times and match tickets.`,
    path: '/fixtures',
    og: 'teams',
    ld: [crumbs([['Home', '/'], ['Fixtures', '/fixtures']]), ...events],
  }, body);
}

const money = (minor) => `£${(Math.round(Number(minor) || 0) / 100).toFixed(2)}`;

/** "Saturday 18 October, 2:30pm" from "2026-10-18T14:30". */
function eventWhen(iso) {
  const [day, time] = String(iso || '').split('T');
  const d = new Date(`${day}T12:00:00Z`);
  const date = d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/London' });
  if (!time) return date;
  const [h, m] = time.split(':').map(Number);
  return `${date}, ${((h + 11) % 12) + 1}${m ? `:${String(m).padStart(2, '0')}` : ''}${h < 12 ? 'am' : 'pm'}`;
}

/** One event on sale, with its own buying form (works with no script at all). */
function eventCard(e, { error = '', form = {} } = {}) {
  const types = (e.ticket_types || []).filter((t) => t.remaining === null || t.remaining === undefined || t.remaining > 0);
  const soldOut = !types.length;
  const anchors = `id="e-${esc(e.id)}"${e.wru_fixture_id ? ` data-fixture="${esc(e.wru_fixture_id)}"` : ''}`;
  const rows = types.map((t) => {
    const max = Math.max(0, Math.min(Number(t.max_per_order) || 10, t.remaining == null ? 10 : t.remaining));
    const chosen = Number(form[`qty_${t.id}`]) || 0;
    const opts = Array.from({ length: max + 1 }, (_, n) => `<option value="${n}"${n === chosen ? ' selected' : ''}>${n}</option>`).join('');
    return `<li><label for="q-${esc(e.id)}-${esc(t.id)}"><span>${esc(t.name)}</span><b>${t.price_minor ? money(t.price_minor) : 'Free'}</b></label><select id="q-${esc(e.id)}-${esc(t.id)}" name="qty_${esc(t.id)}">${opts}</select></li>`;
  }).join('');
  return `<article class="card event-card reveal" ${anchors}>
  ${e.image_url && /^https:\/\//.test(e.image_url) ? `<img class="event-img" src="${esc(e.image_url)}" alt="" loading="lazy">` : ''}
  <p class="kicker">${icon(e.kind === 'match' ? 'whistle' : 'calendar', { size: 16 })} ${esc(e.kind === 'match' ? 'Home match' : 'Club event')}</p>
  <h3>${esc(e.title)}</h3>
  <p class="event-meta"><time datetime="${esc(e.starts_at)}">${esc(eventWhen(e.starts_at))}</time>${e.location ? ` · ${esc(e.location)}` : ''}</p>
  ${e.description ? `<p>${esc(e.description)}</p>` : ''}
  ${soldOut || !e.on_sale ? `<p class="notice">${soldOut ? 'Sold out online.' : 'Not on sale online yet.'} Pay on the gate on the day.</p>` : `
  <form class="buy-form" method="post" action="/tickets/buy#e-${esc(e.id)}">
    <input type="hidden" name="event_id" value="${esc(e.id)}">
    <ul class="ticket-list">${rows}</ul>
    <div class="buy-who">
      <label>Name<input name="name" autocomplete="name" required maxlength="80" value="${esc(form.name || '')}"></label>
      <label>Email<input name="email" type="email" autocomplete="email" required maxlength="120" value="${esc(form.email || '')}"></label>
      <label>Mobile <small>(optional)</small><input name="phone" type="tel" autocomplete="tel" maxlength="30" value="${esc(form.phone || '')}"></label>
    </div>
    ${error ? `<p class="notice notice-error" role="alert">${esc(error)}</p>` : ''}
    <button class="btn btn-glow btn-block" type="submit">${icon('ticket', { size: 20 })} Buy tickets</button>
    <p class="muted small">Pay by card on the next page. Your tickets come by email with a QR code to show at the gate. <a href="/ordering-terms">Terms</a> · <a href="/privacy">Privacy</a></p>
  </form>`}
</article>`;
}

/** Tickets sold as menu items (a "Tickets" section), for before the club uses events. */
function menuTickets() {
  const menu = venue.menu();
  const sec = ((menu && menu.sections) || []).find((x) => /ticket/i.test(x.name || ''));
  if (!sec || !sec.items || !sec.items.length) return '';
  return `<ul class="ticket-list">${sec.items.map((it) => `<li><span>${esc(it.name)}</span><b>${money(it.price_minor)}</b></li>`).join('')}</ul><a class="btn btn-glow btn-block" href="/menu#sec-${esc(sec.id)}">Buy tickets</a>`;
}

function ticketsPage({ error = '', eventId = null, form = {} } = {}) {
  const home = wru.fixtures().upcoming.filter((f) => f.home);
  const events = venue.events();
  const listed = events.length
    ? `<div class="event-list">${events.map((e) => eventCard(e, String(e.id) === String(eventId) ? { error, form } : {})).join('')}</div>`
    : '';
  const fromMenu = events.length ? '' : menuTickets();
  const body = `${pageHero({ kicker: 'Match days and club events', title: 'Tickets', lead: 'Buy online and show the QR code at the gate, or pay on the day.' })}
<section class="section tickets">
  <div class="wrap tickets-grid">
    <div>
      ${listed ? `<h2 class="reveal">${icon('ticket', { size: 26 })} On sale now</h2>${listed}` : ''}
      <h2 class="reveal">${icon('calendar', { size: 26 })} Home matches</h2>
      ${home.length ? `<ol class="fx-list">${home.map((f) => fixtureRow(f, { tickets: false })).join('')}</ol>` : `<p class="muted">The next home matches will show here from the WRU's fixture list. <a href="/fixtures">All fixtures</a>.</p>`}
    </div>
    <aside>
      ${listed ? '' : `<div class="card side-card reveal">
        <h3>${icon('ticket', { size: 22 })} Buy tickets</h3>
        <p>${fromMenu ? 'Buy online, then collect at the gate and pay if you have not already. Or pay on the gate on the day.' : 'Pay on the gate on match day, by card or cash. Online tickets show here as soon as the club puts them on sale.'}</p>
        ${fromMenu}
      </div>`}
      <div class="card side-card reveal"><h3>${icon('card', { size: 22 })} Members</h3><p>Show your members' card at the gate and the bar.</p><a class="btn btn-line" href="${MEMBERS}/">Members' card</a></div>
      <div class="card side-card reveal"><h3>${icon('phone', { size: 22 })} Groups and questions</h3><p>Call the club on <a href="tel:${club.phone_e164}">${esc(club.phone)}</a> or email <a href="mailto:${esc(club.email)}">${esc(club.email)}</a>.</p></div>
    </aside>
  </div>
</section>`;
  const offers = events.filter((e) => e.on_sale).map((e) => ({
    '@context': 'https://schema.org',
    '@type': e.kind === 'match' ? 'SportsEvent' : 'Event',
    name: e.title,
    startDate: e.starts_at,
    eventStatus: 'https://schema.org/EventScheduled',
    location: { '@type': 'Place', name: e.location || club.ground, address: `${club.address.street}, ${club.address.town} ${club.address.postcode}` },
    organizer: { '@id': `${SITE}/#club` },
    offers: (e.ticket_types || []).map((t) => ({ '@type': 'Offer', name: t.name, price: (Number(t.price_minor) / 100).toFixed(2), priceCurrency: 'GBP', url: `${SITE}/tickets#e-${e.id}`, availability: t.remaining === 0 ? 'https://schema.org/SoldOut' : 'https://schema.org/InStock' })),
  }));
  return page({
    title: 'Tickets',
    description: `Match and event tickets for ${club.name} at the Recreation Ground, Ynysderw Road, Pontardawe: buy online with a QR code for the gate, or pay on the day.`,
    path: '/tickets',
    og: 'teams',
    noindex: Boolean(error),
    ld: [crumbs([['Home', '/'], ['Tickets', '/tickets']]), ...offers],
  }, body);
}

/** After paying: the tickets, or what went wrong. */
function ticketOrderPage(r) {
  const o = (r && r.data) || {};
  let inner;
  if (!r || !r.ok) {
    inner = `<p class="notice notice-error">We couldn't find that order. If you paid, your tickets are on their way by email; or call ${esc(club.phone)}.</p>`;
  } else if (o.status === 'paid') {
    inner = `<div class="done"><div class="tick">${icon('check', { size: 40 })}</div><h2>You're in, ${esc(String(o.name || '').split(' ')[0])}!</h2>
<p>${esc(o.event && o.event.title)}${o.event && o.event.starts_at ? ` · ${esc(eventWhen(o.event.starts_at))}` : ''}</p>
<p class="muted">We've emailed your tickets too. Show a code at the gate, on your phone or printed.</p></div>
<ol class="ticket-qrs">${(o.tickets || []).map((t) => `<li class="card"><img src="${esc(venue.ticketQr(t.code))}" alt="Ticket QR code ${esc(t.code)}" width="200" height="200"><b>${esc(t.type)}</b><span>${esc(t.holder || o.name || '')}</span><code>${esc(t.code)}</code></li>`).join('')}</ol>`;
  } else if (o.status === 'pending') {
    inner = `<p class="notice">Waiting for the card payment to finish. <a href="">Check again</a>. If you closed the payment page, <a href="/tickets">start again</a>.</p>`;
  } else {
    inner = `<p class="notice notice-error">The payment didn't go through, so no tickets were issued and nothing was taken. <a href="/tickets">Try again</a>.</p>`;
  }
  const body = `${pageHero({ kicker: 'Tickets', title: o.status === 'paid' ? 'Your tickets' : 'Your order' })}
<section class="section"><div class="wrap ticket-order">${inner}</div></section>`;
  return page({ title: 'Your tickets', description: 'Your tickets.', path: '/tickets/order', og: 'teams', noindex: true }, body);
}

// --- The club's posts on X ---------------------------------------------------

/** Plain text with its links made into links; everything escaped first. */
function linkify(text) {
  return esc(text).replace(/https?:\/\/[^\s<]+/g, (u) => {
    const clean = u.replace(/[.,!)]+$/, '');
    return `<a href="${clean}" rel="noopener nofollow">${clean.replace(/^https?:\/\//, '')}</a>${u.slice(clean.length)}`;
  });
}

function xArchive() {
  if (!xPosts.length) return '';
  return `<section class="section x-archive">
  <div class="wrap">
    <div class="sec-head"><div><p class="kicker reveal">${icon('x', { size: 16 })} @${esc(club.social.x.handle.replace(/^@/, ''))}</p><h2 class="reveal">From the club's X</h2></div><a class="btn btn-line reveal" href="${esc(club.web.x)}" rel="noopener" target="_blank">${icon('x', { size: 18 })} Follow on X</a></div>
    <ol class="x-list">${xPosts.map((p) => {
      const day = String(p.date).slice(0, 10);
      const result = /\d+\s*-\s*\d+/.test(p.text) && /rfc/i.test(p.text);
      return `<li class="x-post reveal${result ? ' x-result' : ''}"><img src="/img/crest-128.webp" alt="" width="40" height="40" loading="lazy"><div><p class="x-meta"><b>${esc(club.name)}</b> <span>@PontardaweRFC · <time datetime="${esc(day)}">${esc(longDate(day))}</time></span>${result ? ' <span class="tag">Result</span>' : ''}</p><p>${linkify(p.text)}</p></div></li>`;
    }).join('')}</ol>
  </div>
</section>`;
}

/** Everything coming up at the club, and the season so far. */
function whatsOnPage() {
  const coming = comingUp();
  const f = nextFixture();
  // The next match has the band at the top; the grid is everything else.
  const [first, ...rest] = coming.filter((u) => u.kind !== 'match' || !f || u.event.start.slice(0, 10) !== f.day);
  const kinds = [...new Set(updates.map((u) => u.kind))];
  const body = `${pageHero({ kicker: 'At the club', title: "What's On", lead: "Match days, family nights, pop-ups and the weekly lotto, from the club's own posts." })}
${nextMatch({ heading: 'Next match' })}
<section class="section">
  <div class="wrap">
    <div class="sec-head"><div><p class="kicker reveal">${icon('calendar', { size: 16 })} Coming up</p><h2 class="reveal">Don't miss</h2></div><a class="btn btn-line reveal" href="${esc(club.web.instagram)}" rel="noopener">${icon('instagram', { size: 18 })} Follow @pontardawerfc</a></div>
    ${first ? `<div class="ev-feature">${eventTile(first, { big: true })}<div class="ev-grid ev-grid-side">${rest.slice(0, 4).map((u) => eventTile(u)).join('')}</div></div>${rest.length > 4 ? `<div class="ev-grid">${rest.slice(4).map((u) => eventTile(u)).join('')}</div>` : ''}`
    : `<p class="muted reveal">Nothing announced just yet. Follow the club on <a href="${esc(club.web.instagram)}" rel="noopener">Instagram</a> or <a href="${esc(club.web.facebook)}" rel="noopener">Facebook</a>.</p>`}
    ${playBand()}
    <div class="callout reveal lotto-call"><span class="tile-ic">${icon('lotto')}</span><div><h2>Weekly Lotto</h2><p>Every week, for the club. Ask behind the bar to play, and see the latest numbers in <a href="/news/weekly-lotto">the lotto results</a>.</p></div></div>
  </div>
</section>
<section class="section season-sec">
  <div class="wrap">
    <p class="kicker reveal">${icon('history', { size: 16 })} 2026 so far</p>
    <h2 class="reveal">The season at Pontardawe</h2>
    <div class="filter-chips reveal" role="group" aria-label="Show">${['all', ...kinds].map((k, i) => `<button type="button" data-filter="${esc(k)}" aria-pressed="${i ? 'false' : 'true'}">${esc(k === 'all' ? 'Everything' : kindOf(k)[0])}</button>`).join('')}</div>
    <ol class="season" data-season>${updates.slice().sort((a, b) => b.date.localeCompare(a.date)).map((u) => `<li class="season-item reveal" data-kind="${esc(u.kind)}">
      <span class="season-dot" aria-hidden="true">${icon(kindOf(u.kind)[1], { size: 18 })}</span>
      <a class="season-card" href="/news/${esc(u.slug)}">
        ${u.image ? photo(u.image, { cls: 'season-img', sizes: '(max-width: 640px) 40vw, 220px' }) : ''}
        <div><p class="meta"><time datetime="${esc(u.date)}">${esc(longDate(u.date))}</time> · <span class="tag tag-${esc(u.kind)}">${esc(kindOf(u.kind)[0])}</span></p><h3>${esc(u.title)}</h3><p>${esc(u.summary)}</p></div>
      </a>
    </li>`).join('')}</ol>
  </div>
</section>`;
  const ld = coming.map((u) => ({
    '@context': 'https://schema.org',
    '@type': u.kind === 'match' ? 'SportsEvent' : 'Event',
    name: u.title,
    startDate: u.event.start,
    ...(u.event.end ? { endDate: u.event.end } : {}),
    eventStatus: 'https://schema.org/EventScheduled',
    eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    location: { '@type': 'Place', name: u.event.place || club.address.name, address: `${club.address.street}, ${club.address.town} ${club.address.postcode}` },
    image: u.image ? `${SITE}/img/${u.image}.jpg` : `${SITE}/img/og-home.jpg`,
    description: u.summary,
    organizer: { '@id': `${SITE}/#club` },
    url: `${SITE}/news/${u.slug}`,
  }));
  const named = coming.filter((u) => u.kind !== 'match').map((u) => u.title.split(',')[0]).slice(0, 3).join(', ');
  return page({
    title: "What's On",
    description: `What's on at ${club.name}: ${f ? `the next match (${f.home ? `v ${f.opponent}` : `away at ${f.opponent}`}, ${longDate(f.day)}), ` : ''}${named || 'club events'} and the weekly lotto.`,
    path: '/whats-on',
    og: 'home',
    ld: [crumbs([['Home', '/'], ["What's On", '/whats-on']]), ...ld],
  }, body);
}

/** The club's game: Ponty Kicks, the conversion challenge (public/js/game.js). */
function playPage() {
  const body = `${pageHero({ kicker: 'New · Free to play', title: 'Ponty Kicks', lead: 'The conversion challenge at The Rec. Beat the computer, a mate on the same screen, or a friend online.' })}
<section class="section game-sec">
  <div class="wrap">
    <div class="game" data-game>
      <canvas aria-label="Ponty Kicks: a rugby goal-kicking game. Swipe up from the ball to kick." role="img"></canvas>
      <div class="g-hud" data-g-hud aria-live="polite"></div>
      <div class="g-banner" data-g-banner aria-live="polite"></div>
      <p class="g-toast" data-g-toast hidden role="status"></p>
      <div class="g-tools"><button type="button" data-g-mute aria-label="Sound on or off" aria-pressed="false">🔊</button><button type="button" data-g-full aria-label="Full screen">⛶</button><button type="button" data-g-menu-open aria-label="Back to the menu">☰</button></div>
      <p class="g-rotate" aria-hidden="true"><span>⟳</span> Turn your phone sideways for the best view</p>

      <div class="g-menu" data-g-menu>
        <div class="g-menu-in">
          <p class="g-logo"><img src="/img/ponty-kicks.svg" alt="" width="64" height="64"><span><b>Ponty Kicks</b><small>Pontardawe RFC · The conversion challenge</small></span></p>
          <label class="g-name">Your name <input data-g-name maxlength="16" autocomplete="nickname" placeholder="Your name"></label>
          ${['me', 'opp'].map((side) => `<div class="g-teams" role="group" aria-label="${side === 'me' ? 'Your team' : 'The other side'}"><span class="g-teams-label">${side === 'me' ? 'Your team' : 'Against'}</span>${GAME.TEAM_KEYS.map((k) => {
    const t = GAME.TEAMS[k];
    return `<button type="button" class="g-team" data-g-team="${side}" data-key="${esc(k)}" aria-pressed="false" style="--a:${esc(t.shirt)};--b:${esc(t.hoop)}">${t.crest ? `<img src="${esc(t.crest)}" alt="" width="22" height="22">` : `<span class="g-shield">${esc(t.short)}</span>`}<span>${esc(t.name)}</span></button>`;
  }).join('')}</div>`).join('')}
          <div class="g-modes">
            <div class="g-mode"><h3>${icon('star', { size: 18 })} vs the computer</h3><p>Five kicks each from further out and wider, with the wind getting up. Then sudden death.</p>
              <div class="g-row"><button type="button" class="btn btn-sm btn-line" data-g-ai="easy">Easy</button><button type="button" class="btn btn-sm btn-glow" data-g-ai="normal">Normal</button><button type="button" class="btn btn-sm btn-line" data-g-ai="hard">Hard</button></div></div>
            <div class="g-mode"><h3>${icon('users', { size: 18 })} Two players</h3><p>Same screen, pass it over between kicks.</p>
              <div class="g-row"><button type="button" class="btn btn-sm btn-glow" data-g-local>Play</button></div></div>
            <div class="g-mode" id="online"><h3>${icon('send', { size: 18 })} Play a friend online</h3><p>Start a game and send the code, or type a friend's.</p>
              <div class="g-row"><button type="button" class="btn btn-sm btn-glow" data-g-host>Start a game</button></div>
              <div class="g-row g-join"><input data-g-code maxlength="5" placeholder="CODE" autocapitalize="characters" autocomplete="off" aria-label="Your friend's game code"><button type="button" class="btn btn-sm btn-line" data-g-join>Join</button></div>
              <div data-g-lobby></div></div>
          </div>
          <p class="g-best small" data-g-best></p>
        </div>
      </div>

      <div class="g-over" data-g-over hidden>
        <div class="g-over-in"><p class="kicker">Full time</p><h2 data-g-title></h2><p class="g-final" data-g-final></p>
          <div class="g-row"><button type="button" class="btn btn-glow" data-g-again>Play again</button><button type="button" class="btn btn-ghost" data-g-menu-open>Menu</button></div></div>
      </div>
    </div>
  </div>
</section>
<section class="section">
  <div class="wrap grid-3">
    <div class="card reveal"><span class="tile-ic">${icon('ball')}</span><h2>How to kick</h2><p>Put your finger (or the mouse) on the ball and swipe up. Further means more power; to the side means aiming left or right. On a keyboard: arrow keys to aim, hold the space bar for power.</p></div>
    <div class="card reveal"><span class="tile-ic">${icon('leaf')}</span><h2>Mind the wind</h2><p>The flags on the posts and the arrow at the top show the wind. Aim into it: a strong wind can carry a good kick wide.</p></div>
    <div class="card reveal"><span class="tile-ic">${icon('trophy')}</span><h2>Scoring</h2><p>Two points a conversion, five kicks each, the same spot and wind for both. Level after five? Sudden death until somebody misses.</p></div>
  </div>
  <p class="wrap muted small center reveal">Ponty Kicks is written for the club. Its lettering is Permanent Marker by Font Diner (Apache License 2.0): <a href="/licences">fonts and licences</a>.</p>
</section>`;
  return page({
    title: 'Ponty Kicks: the conversion game',
    description: `Ponty Kicks, ${club.name}'s free rugby goal-kicking game: kick conversions at The Rec against the computer, a friend on the same screen, or a friend online.`,
    path: '/play',
    og: 'play',
    icon: '/img/ponty-kicks',
    ld: [crumbs([['Home', '/'], ['Ponty Kicks', '/play']]), {
      '@context': 'https://schema.org', '@type': 'VideoGame', name: 'Ponty Kicks', url: `${SITE}/play`, image: `${SITE}/img/og-play.jpg`,
      description: 'A rugby conversion-kicking game in the browser: one player against the computer, two on one screen, or two online.',
      genre: 'Sports', gamePlatform: 'Web browser', playMode: ['SinglePlayer', 'MultiPlayer', 'CoOp'],
      publisher: { '@id': `${SITE}/#club` }, offers: { '@type': 'Offer', price: '0', priceCurrency: 'GBP' },
    }],
    scripts: `<link rel="stylesheet" href="/css/game.css?v=${ASSET_VERSION}"><script src="/js/game-rules.js?v=${ASSET_VERSION}" defer></script><script src="/js/game-players.js?v=${ASSET_VERSION}" defer></script><script src="/js/game.js?v=${ASSET_VERSION}" defer></script>`,
  }, body);
}

/** The game, highlighted: on the home page and What's On. */
function playBand() {
  return `<section class="play-band" aria-label="Ponty Kicks">
  <div class="wrap play-in">
    <div class="play-art" aria-hidden="true"><img class="play-icon" src="/img/ponty-kicks.svg" alt="" width="96" height="96" loading="lazy">
      <svg viewBox="0 0 220 200"><path class="pb-post" d="M70 190 V20 M150 190 V20 M70 110 H150"/><path class="pb-trail" d="M30 196 Q 80 110 110 64"/><g class="pb-ball"><ellipse cx="0" cy="0" rx="9" ry="14"/><path d="M0-9v18M-4-4h8M-4 0h8M-4 4h8"/></g></svg>
    </div>
    <div class="play-copy reveal">
      <p class="kicker">${icon('sparkle', { size: 16 })} New · Free to play</p>
      <h2>Ponty Kicks: can you convert from 40 metres?</h2>
      <p>The club's own goal-kicking game. Beat the computer, take on a mate on the same screen, or challenge a friend online with a code.</p>
      <div class="cta-row"><a class="btn btn-white" href="/play">${icon('ball', { size: 20 })} Play now</a><a class="btn btn-ghost" href="/play#online">${icon('users', { size: 20 })} Challenge a friend</a></div>
    </div>
  </div>
</section>`;
}

function notFound() {
  const body = `${pageHero({ kicker: '404', title: 'Knock-on!', lead: 'That page isn\'t here. It may have moved when we built the new site.' })}
<section class="section"><div class="wrap center"><div class="cta-row center"><a class="btn btn-glow" href="/">${icon('ball', { size: 20 })} Back to the home page</a><a class="btn btn-line" href="/menu">Menu &amp; order</a><a class="btn btn-line" href="${MEMBERS}/">Members' card</a></div></div></section>`;
  return page({ title: 'Page not found', description: 'This page could not be found.', path: '/404', og: 'home', noindex: true }, body);
}

module.exports = {
  home, clubPage, teamsPage, newsPage, articlePage, clubhousePage, menuPage, membershipPage,
  contactPage, privacyPage, cookiesPage, termsPage, accessibilityPage, notFound, fixturesPage, ticketsPage, ticketOrderPage, whatsOnPage, playPage, licencesPage,
  MENU_API, MENU_SLUG,
};
