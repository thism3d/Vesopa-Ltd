/**
 * Every page of loughorrfc.site, set as a match-day programme (owner,
 * 2026-11-19: "Heritage programme", "a total brand new website").
 * Server-rendered, so each page is whole without JavaScript and readable by
 * search engines and link previews; public/js/site.js adds the reveals, the
 * river, the menu on a phone and the helper.
 */
'use strict';

const { club, news, updates, images, longDate, yearsOld } = require('./content');
const wru = require('./wru');
const venue = require('./venue_api');
const { page, masthead, appSoon, esc, icon, SITE, MEMBERS, MENU_URL } = require('./layout');
const { zoned } = require('./posts');
const legal = require('./legal');

const MENU_API = (process.env.MENU_API || 'https://menu.vesopa.com').replace(/\/+$/, '');
const MENU_SLUG = process.env.MENU_SLUG || club.slug || 'loughor-rfc';

// --- Small helpers ------------------------------------------------------------

const todayUK = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());

function photo(name, { cls = '', sizes = '(max-width: 700px) 100vw, 640px', lazy = true } = {}) {
  const m = images[name];
  if (!m) return '';
  const set = name.startsWith('ig/') || m.small ? ` srcset="/img/${name}-480.webp 480w, /img/${name}.webp ${m.w}w"` : ` srcset="/img/${name}.webp"`;
  return `<picture class="${cls}"><source${set} type="image/webp" sizes="${sizes}"><img src="/img/${name}.jpg" alt="${esc(m.alt)}" width="${m.w}" height="${m.h}" sizes="${sizes}"${lazy ? ' loading="lazy" decoding="async"' : ' fetchpriority="high"'}></picture>`;
}

const crumbs = (items) => ({
  '@context': 'https://schema.org',
  '@type': 'BreadcrumbList',
  itemListElement: items.map(([name, path], i) => ({ '@type': 'ListItem', position: i + 1, name, item: `${SITE}${path}` })),
});

/** "Sat 17 Oct" from 2026-10-17. */
function shortDate(day) {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Europe/London' });
}

/** The parts of a date a ticket stub prints. */
function stubDate(day) {
  const d = new Date(`${day}T12:00:00Z`);
  const part = (o) => d.toLocaleDateString('en-GB', { ...o, timeZone: 'Europe/London' });
  return { wd: part({ weekday: 'long' }), dd: part({ day: 'numeric' }), mon: part({ month: 'long' }), yr: part({ year: 'numeric' }) };
}

/** "2:30pm" from "14:30". */
function time12(hm) {
  if (!hm) return '';
  const [h, m] = hm.split(':').map(Number);
  return `${((h + 11) % 12) + 1}${m ? `:${String(m).padStart(2, '0')}` : ''}${h < 12 ? 'am' : 'pm'}`;
}

function daysTo(iso) {
  const a = new Date(`${todayUK()}T12:00:00Z`);
  const b = new Date(`${String(iso).slice(0, 10)}T12:00:00Z`);
  return Math.round((b - a) / 864e5);
}

/** The club's events still to come (from its own posts), soonest first. */
function comingUp() {
  const now = todayUK();
  return updates.filter((u) => u.event && u.event.start.slice(0, 10) >= now)
    .sort((a, b) => a.event.start.localeCompare(b.event.start));
}

/** The next First XV match: the WRU's list first, else the club's own post about it. */
function nextFixture() {
  const f = wru.fixtures().upcoming[0];
  if (f) return f;
  const u = comingUp().find((x) => x.kind === 'match');
  if (!u) return null;
  const [day, time] = u.event.start.split('T');
  return { id: `club-${u.slug}`, day, kickoff: time || null, home: Boolean(u.event.home), opponent: u.event.opponent || 'TBC', competition: u.event.competition || null, status: 'UPCOMING', fromClub: true };
}

const opp = (name) => esc(String(name || '').replace(/ RFC$/, ''));
const groundShort = () => esc(String(club.ground || 'Villa Field').split(',')[0]);

/** A rule with the club's year in it, the programme's section divider. */
const rule = (text = `Est. ${club.founded}`) => `<div class="rule" aria-hidden="true"><span>${esc(text)}</span></div>`;

// --- The ticket stub: the next match, wherever it is shown -------------------

function stub(f, { big = false } = {}) {
  if (!f) {
    return `<div class="stub stub-empty${big ? ' stub-big' : ''}" data-reveal>
  <div class="stub-main"><p class="stub-label">Next at ${groundShort()}</p><p class="stub-teams">Fixtures for the new season are on their way</p><p class="stub-meta">They appear here from the WRU as soon as they are published.</p></div>
  <div class="stub-tear" aria-hidden="true"></div>
  <a class="stub-side" href="/fixtures"><span>All</span><b>Fixtures</b></a>
</div>`;
  }
  const d = stubDate(f.day);
  const home = f.home;
  const n = daysTo(f.day);
  const soon = n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : n > 1 && n <= 10 ? `In ${n} days` : '';
  const buy = home && !f.fromClub;
  return `<div class="stub${big ? ' stub-big' : ''}" data-reveal>
  <div class="stub-main">
    <p class="stub-label">${home ? `At ${groundShort()}` : 'Away'}${f.competition ? ` · ${esc(f.competition.replace(/^WRU /, ''))}` : ''}${soon ? ` · <b>${soon}</b>` : ''}</p>
    <p class="stub-teams">${home ? `Loughor <i>v</i> ${opp(f.opponent)}` : `${opp(f.opponent)} <i>v</i> Loughor`}</p>
    <p class="stub-meta"><time datetime="${esc(f.day)}${f.kickoff ? `T${esc(f.kickoff)}` : ''}">${esc(d.wd)} ${esc(d.dd)} ${esc(d.mon)}</time>${f.kickoff ? ` · Kick-off ${esc(time12(f.kickoff))}` : ''}</p>
  </div>
  <div class="stub-tear" aria-hidden="true"></div>
  <a class="stub-side" href="${buy ? `/tickets#m-${esc(f.id)}` : '/fixtures'}"><span>${buy ? 'Admit one' : 'See all'}</span><b>${buy ? 'Tickets' : 'Fixtures'}</b></a>
</div>`;
}

// --- Home -----------------------------------------------------------------------

function newsLine(p) {
  const cover = p.cover || p.image;
  const thumb = cover && images[cover] ? photo(cover, { cls: 'line-img', sizes: '96px' }) : '';
  return `<li data-reveal><a href="/news/${esc(p.slug)}"${thumb ? ' class="has-img"' : ''}>${thumb}<time datetime="${esc(p.date)}">${esc(longDate(p.date))}</time><b>${esc(p.title)}</b><span>${esc(p.summary)}</span></a></li>`;
}

function home() {
  const years = yearsOld();
  const f = nextFixture();
  const latest = news.slice(0, 4);
  const lead = latest[0];
  const results = wru.fixtures().results.slice(0, 3);
  const body = `
<section class="cover" aria-label="${esc(club.name)}">
  <div class="wrap cover-in">
    <div class="cover-words">
      <p class="cover-kicker" data-reveal><span>Leucarum</span><span>Est. ${club.founded}</span></p>
      <h1 data-reveal><span class="cw-1">Loughor</span> <span class="cw-2">Rugby Football Club</span></h1>
      <p class="cover-lead" data-reveal>${esc(club.short)}</p>
      <p class="cover-actions" data-reveal>
        <a class="btn btn-navy" href="/fixtures">${icon('calendar', { size: 18 })} Fixtures &amp; results</a>
        <a class="btn btn-ghost" href="/clubhouse">Visit the clubhouse</a>
      </p>
    </div>
    <figure class="cover-crest" data-reveal>
      <span class="halo" aria-hidden="true"></span>
      <img src="/img/crest-512.png" alt="The Loughor R.F.C. crest: Leucarum" width="440" height="440" fetchpriority="high">
    </figure>
  </div>
  <div class="wrap cover-stub">${stub(f, { big: true })}</div>
  <svg class="river" viewBox="0 0 1440 120" preserveAspectRatio="none" aria-hidden="true" data-river>
    <path class="r1" d="M0 70 C 160 40 320 100 480 70 S 800 40 960 70 S 1280 100 1440 70 S 1760 40 1920 70 S 2240 100 2400 70 S 2720 40 2880 70 V120 H0Z"/>
    <path class="r2" d="M0 85 C 200 60 400 110 600 85 S 1000 60 1200 85 S 1600 110 1800 85 S 2200 60 2400 85 S 2800 110 2880 85 V120 H0Z"/>
  </svg>
</section>

<section class="contents" aria-label="In this programme">
  <div class="wrap">
    <h2 class="contents-title" data-reveal>In this programme</h2>
    <ol class="contents-list">
      <li data-reveal><a href="/fixtures"><span class="pg">p. 2</span><b>Fixtures &amp; results</b><i>The First XV in ${esc(club.league.replace(/^WRU /, ''))}</i></a></li>
      <li data-reveal><a href="/news"><span class="pg">p. 4</span><b>Club news</b><i>From Villa Field and the committee</i></a></li>
      <li data-reveal><a href="/club"><span class="pg">p. 6</span><b>${years} years of the Blues</b><i>History, honours and famous names</i></a></li>
      <li data-reveal><a href="/teams"><span class="pg">p. 8</span><b>Teams</b><i>Seniors, juniors and youth</i></a></li>
      <li data-reveal><a href="/clubhouse"><span class="pg">p. 10</span><b>The clubhouse</b><i>Bar, food, live sport and functions</i></a></li>
      <li data-reveal><a href="/membership"><span class="pg">p. 12</span><b>Membership</b><i>Your card, tapped at the bar</i></a></li>
    </ol>
  </div>
</section>

<section class="sheet news-sheet">
  <div class="wrap">
    ${rule('From the club')}
    <div class="news-cols">
      ${lead ? `<article class="news-lead" data-reveal>
        ${(lead.cover || lead.image) && images[lead.cover || lead.image] ? `<a class="news-lead-img" href="/news/${esc(lead.slug)}">${photo(lead.cover || lead.image, { sizes: '(max-width: 860px) 100vw, 640px' })}</a>` : ''}
        <p class="news-date"><time datetime="${esc(lead.date)}">${esc(longDate(lead.date))}</time></p>
        <h2><a href="/news/${esc(lead.slug)}">${esc(lead.title)}</a></h2>
        <p class="dropcap">${esc(lead.summary)}</p>
        <a class="more" href="/news/${esc(lead.slug)}">Read the story ${icon('arrow', { size: 16 })}</a>
      </article>` : ''}
      <div class="news-side">
        <ol class="news-lines">${latest.slice(1).map(newsLine).join('')}</ol>
        ${results.length ? `<div class="results-mini" data-reveal><h3>Latest results</h3><ul>${results.map((r) => `<li><span>${esc(shortDate(r.day))}</span><b>${r.home ? `Loughor ${r.us}–${r.them} ${opp(r.opponent)}` : `${opp(r.opponent)} ${r.them}–${r.us} Loughor`}</b><i class="res res-${r.result.toLowerCase()}">${r.result}</i></li>`).join('')}</ul></div>` : ''}
        <a class="btn btn-line" href="/news" data-reveal>All the news</a>
      </div>
    </div>
  </div>
</section>

<section class="honours-band">
  <div class="wrap">
    <p class="band-kicker" data-reveal>Silverware</p>
    <div class="honours">
      <div class="honour" data-stamp><b>${club.founded}</b><span>Founded in Loughor</span></div>
      ${(club.honours || []).map((h) => `<div class="honour" data-stamp><b>${esc(h.year)}</b><span>${esc(h.title)}</span></div>`).join('')}
      <div class="honour" data-stamp><b>${years}</b><span>Seasons of rugby</span></div>
    </div>
    <a class="btn btn-gold" href="/club" data-reveal>Our history</a>
  </div>
</section>

<section class="sheet two-up">
  <div class="wrap two-up-in">
    <article class="panel" data-reveal>
      <p class="panel-kicker">${icon('beer', { size: 18 })} The clubhouse</p>
      <h2>Bar, food and the big games</h2>
      <p>${esc(club.clubhouse.text)}</p>
      <div class="hours" data-hours data-api="${esc(MENU_API)}" data-slug="${esc(MENU_SLUG)}"></div>
      <p class="panel-actions"><a class="btn btn-navy" href="${esc(MENU_URL)}">${icon('plate', { size: 18 })} Food &amp; drink</a><a class="btn btn-line" href="/clubhouse">Hire the clubhouse</a></p>
    </article>
    <article class="panel panel-card" data-reveal>
      <p class="panel-kicker">${icon('nfc', { size: 18 })} Members</p>
      <h2>Tap your card at the bar</h2>
      <div class="member-card" aria-hidden="true" data-tilt-card>
        <img src="/img/crest-128.webp" alt="" width="64" height="64">
        <span class="mc-name">Loughor RFC</span><span class="mc-sub">Members' card</span>
        <span class="mc-nfc">${icon('nfc', { size: 28 })}</span>
      </div>
      <p>Members' prices at the bar, with your card on your phone or watch: hold it near the reader, or show the QR code.</p>
      ${appSoon()}
    </article>
  </div>
</section>

<section class="sheet visit-strip">
  <div class="wrap visit-in">
    <div data-reveal>
      ${rule('Find us')}
      <h2>${esc(club.ground)}</h2>
      <p class="visit-addr">${esc(club.address.street)}, ${esc(club.address.town)}, ${esc(club.address.postcode)}</p>
      <p class="visit-actions">${directions()}<a class="btn btn-line" href="tel:${club.phone_e164}">${icon('phone', { size: 18 })} ${esc(club.phone)}</a></p>
    </div>
    ${mapArt()}
  </div>
</section>`;
  return page({
    title: club.name,
    description: `${club.name}, the Blues, est. ${club.founded}: rugby union at ${club.ground}. Fixtures and results, club news, history and honours, the clubhouse bar and food, and membership.`,
    path: '/',
    og: 'home',
    ld: [{
      '@context': 'https://schema.org',
      '@type': 'WebPage',
      '@id': `${SITE}/#home`,
      url: `${SITE}/`,
      name: club.name,
      about: { '@id': `${SITE}/#club` },
    }],
  }, body);
}

// --- Visit: directions and a drawn map ------------------------------------------

function directions() {
  const a = club.address;
  const apple = `https://maps.apple.com/?daddr=${a.lat},${a.lng}&q=${encodeURIComponent(club.name)}&dirflg=d`;
  const google = `https://www.google.com/maps/dir/?api=1&destination=${a.lat},${a.lng}`;
  return `<a class="btn btn-navy dir-apple" href="${esc(apple)}" rel="noopener" target="_blank">${icon('pin', { size: 18 })} Apple Maps</a><a class="btn btn-navy dir-google" href="${esc(google)}" rel="noopener" target="_blank">${icon('pin', { size: 18 })} Google Maps</a>`;
}

/** The ground, drawn like the plan in a programme: the river, the road, the pitch. */
function mapArt() {
  const a = club.address;
  return `<a class="plan" href="https://www.openstreetmap.org/?mlat=${a.lat}&mlon=${a.lng}#map=17/${a.lat}/${a.lng}" rel="noopener" target="_blank" aria-label="Open the map of ${esc(club.ground)}" data-reveal>
  <svg viewBox="0 0 420 300" aria-hidden="true">
    <rect class="pl-paper" width="420" height="300"/>
    <path class="pl-river" d="M-10 250 C 70 220 120 270 200 240 S 330 200 430 225"/>
    <text class="pl-label" x="300" y="262">River Loughor</text>
    <path class="pl-road" d="M40 -10 L 120 310"/>
    <text class="pl-label" x="62" y="40" transform="rotate(76 62 40)">Belgrave Road</text>
    <rect class="pl-pitch" x="170" y="70" width="170" height="110" rx="4"/>
    <path class="pl-line" d="M255 70 V180 M170 125 H340"/>
    <circle class="pl-line" cx="255" cy="125" r="14"/>
    <path class="pl-posts" d="M178 112 V138 M178 125 H186 M332 112 V138 M332 125 H324"/>
    <rect class="pl-house" x="128" y="140" width="34" height="26" rx="2"/>
    <text class="pl-label" x="112" y="186">Clubhouse</text>
    <g class="pl-pin"><path d="M255 34c-9 0-16 7-16 16 0 12 16 26 16 26s16-14 16-26c0-9-7-16-16-16z"/><circle cx="255" cy="50" r="5"/></g>
  </svg>
  <span class="plan-cap">${esc(club.ground)} · open the map ${icon('external', { size: 14 })}</span>
</a>`;
}

// --- The club: history, timeline, honours, famous names ------------------------

function clubPage() {
  const body = `${masthead({ kicker: `Est. ${club.founded}`, title: 'The Club', lead: esc(`${yearsOld()} years of the Blues of Loughor.`) })}
<section class="sheet">
  <div class="wrap history">
    <div class="history-text">
      ${club.history.map((p, i) => `<p${i === 0 ? ' class="dropcap"' : ''} data-reveal>${esc(p)}</p>`).join('')}
      <p class="small muted" data-reveal>Sources: the club, <a href="${club.web.wikipedia}" rel="noopener">Wikipedia</a> and Companies House. Have a photograph, a programme or a story from the club's past? Bring it to the clubhouse or call ${esc(club.phone)}.</p>
    </div>
    <aside class="factfile" data-reveal>
      <img src="/img/crest-256.webp" alt="" width="160" height="160" loading="lazy">
      <h2>Fact file</h2>
      <dl>
        <dt>Founded</dt><dd>${club.founded}</dd>
        <dt>Known as</dt><dd>${esc(club.nickname || 'The Blues')}</dd>
        <dt>Ground</dt><dd>${esc(club.ground)}</dd>
        <dt>League</dt><dd>${esc(club.league)}</dd>
        <dt>Union</dt><dd>Welsh Rugby Union</dd>
        <dt>Company</dt><dd>${esc(club.company.name)} (${esc(club.company.number)})</dd>
      </dl>
    </aside>
  </div>
</section>
<section class="sheet timeline-sheet">
  <div class="wrap">
    ${rule('Through the years')}
    <ol class="years" data-years>${club.timeline.map((t) => `<li data-reveal><b>${esc(t.year)}</b><p>${esc(t.text)}</p></li>`).join('')}</ol>
  </div>
</section>
<section class="honours-band">
  <div class="wrap">
    <p class="band-kicker" data-reveal>Honours</p>
    <div class="honours">${(club.honours || []).map((h) => `<div class="honour" data-stamp><b>${esc(h.year)}</b><span>${esc(h.title)}</span></div>`).join('')}</div>
    <p class="band-kicker" data-reveal>Famous Blues</p>
    <ul class="names">${club.notable_players.map((p) => `<li data-reveal><b>${esc(p.name)}</b><span>${esc(p.honours)}</span></li>`).join('')}</ul>
  </div>
</section>`;
  return page({
    title: 'The Club',
    description: `The history of ${club.full_name}, founded in ${club.founded}: ${yearsOld()} years of rugby in Loughor, its honours, famous players and timeline.`,
    path: '/club',
    og: 'club',
    ld: [crumbs([['Home', '/'], ['The Club', '/club']])],
  }, body);
}

// --- Teams --------------------------------------------------------------------

function teamsPage() {
  const fx = wru.fixtures();
  const body = `${masthead({ kicker: 'On the pitch', title: 'Teams', lead: 'From the First XV to the youngest juniors, all in royal blue.' })}
<section class="sheet">
  <div class="wrap teamsheet">
    ${club.teams.map((t, i) => `<article class="team" data-reveal><span class="team-no">${String(i + 1).padStart(2, '0')}</span><div><h2>${esc(t.name)}</h2><p>${esc(t.text)}</p></div></article>`).join('')}
  </div>
</section>
<section class="sheet">
  <div class="wrap two-up-in">
    <div data-reveal>
      ${rule('Next match')}
      ${stub(nextFixture())}
      ${fx.upcoming.length > 1 ? `<ol class="fixtures">${fx.upcoming.slice(1, 4).map((f) => fixtureRow(f)).join('')}</ol>` : ''}
      <p><a class="btn btn-line" href="/fixtures">All fixtures &amp; results</a></p>
    </div>
    <div class="panel" data-reveal>
      <p class="panel-kicker">${icon('ball', { size: 18 })} Come and play</p>
      <h2>Every age, every ability</h2>
      <p>New players, returning players, coaches and volunteers are always welcome. Call the club on <a href="tel:${club.phone_e164}">${esc(club.phone)}</a> or message us on <a href="${club.web.facebook}" rel="noopener">Facebook</a> to find out when your team trains.</p>
    </div>
  </div>
</section>`;
  return page({
    title: 'Teams',
    description: `${club.name}'s teams: the First XV and Second XV in the WRU National Leagues, and junior and youth rugby from under 6. How to play, coach or volunteer.`,
    path: '/teams',
    og: 'teams',
    ld: [crumbs([['Home', '/'], ['Teams', '/teams']])],
  }, body);
}

// --- Fixtures, from the WRU ---------------------------------------------------

function fixtureRow(f, { tickets = true } = {}) {
  const home = f.home;
  const right = f.result
    ? `<span class="res res-${f.result.toLowerCase()}" title="${{ W: 'Won', L: 'Lost', D: 'Drawn' }[f.result]}">${f.result}</span><b class="score">${f.us}–${f.them}</b>`
    : f.status === 'POSTPONED' ? '<span class="tag">Postponed</span>'
      : `<span class="ko">${f.kickoff ? esc(time12(f.kickoff)) : 'Time TBC'}</span>`;
  const buy = tickets && !f.result && home && f.status !== 'POSTPONED' ? `<a class="fx-buy" href="/tickets#m-${esc(f.id)}">${icon('ticket', { size: 16 })}<span>Tickets</span></a>` : '';
  return `<li class="fx" id="m-${esc(f.id)}" data-reveal>
  <time datetime="${esc(f.day)}">${esc(shortDate(f.day))}</time>
  <div class="fx-teams"><b>${home ? 'Loughor' : opp(f.opponent)} <i>v</i> ${home ? opp(f.opponent) : 'Loughor'}</b><small><span class="ha">${home ? 'Home' : 'Away'}</span>${f.competition ? ` · ${esc(f.competition.replace(/^WRU /, ''))}` : ''}${f.team && f.team !== '1st Team' ? ` · ${esc(f.team)}` : ''}</small></div>
  <div class="fx-end">${right}${buy}</div>
</li>`;
}

function leagueTable(t) {
  if (!t || !t.rows.length) return '';
  return `<div class="table-wrap" data-reveal><table class="table">
  <caption>${esc(t.name)} ${esc(t.season)}</caption>
  <thead><tr><th scope="col">#</th><th scope="col">Team</th><th scope="col">P</th><th scope="col">W</th><th scope="col">D</th><th scope="col">L</th><th scope="col" title="Points difference">PD</th><th scope="col">Pts</th></tr></thead>
  <tbody>${t.rows.map((r) => `<tr${r.us ? ' class="us"' : ''}><td>${r.pos}</td><th scope="row">${esc(r.team.replace(/ RFC$/, ''))}</th><td>${r.p}</td><td>${r.w}</td><td>${r.d}</td><td>${r.l}</td><td>${r.pd > 0 ? '+' : ''}${r.pd}</td><td><b>${r.pts}</b></td></tr>`).join('')}</tbody>
</table></div>`;
}

function fixturesPage() {
  const fx = wru.fixtures();
  const none = `<p class="muted">The fixture list comes from the WRU and appears here as soon as it is published. Meanwhile, see <a href="${club.web.wru_league}" rel="noopener">the WRU's fixtures</a>.</p>`;
  const body = `${masthead({ kicker: 'First XV', title: 'Fixtures & Results', lead: 'Every match, every score and the league table, live from the WRU.' })}
<section class="sheet">
  <div class="wrap">${stub(nextFixture(), { big: true })}</div>
</section>
<section class="sheet">
  <div class="wrap fx-grid">
    <div>
      ${rule('Fixtures')}
      ${fx.upcoming.length ? `<ol class="fixtures">${fx.upcoming.map((f) => fixtureRow(f)).join('')}</ol>` : none}
      ${fx.postponed.length ? `<h3 data-reveal>Postponed</h3><ol class="fixtures">${fx.postponed.map((f) => fixtureRow(f, { tickets: false })).join('')}</ol>` : ''}
      ${rule('Results')}
      ${fx.results.length ? `<ol class="fixtures">${fx.results.map((f) => fixtureRow(f)).join('')}</ol>` : '<p class="muted">No results yet this season.</p>'}
    </div>
    <aside>
      ${rule('The table')}
      ${leagueTable(fx.table) || none}
      <div class="panel" data-reveal><p class="panel-kicker">${icon('ticket', { size: 18 })} Match tickets</p><p>Home games are at ${esc(club.ground)}. Buy online and show the QR code at the gate, or pay on the day.</p><a class="btn btn-navy" href="/tickets">Tickets</a></div>
      <p class="small muted" data-reveal>From the <a href="${club.web.wru_league}" rel="noopener">WRU</a>${fx.updated ? `, checked ${esc(new Date(fx.updated).toLocaleString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))}` : ''}.</p>
    </aside>
  </div>
</section>`;
  const events = fx.upcoming.map((f) => ({
    '@context': 'https://schema.org',
    '@type': 'SportsEvent',
    name: f.home ? `Loughor RFC v ${f.opponent}` : `${f.opponent} v Loughor RFC`,
    startDate: `${f.day}T${f.kickoff || '14:30'}:00`,
    sport: 'Rugby union',
    eventStatus: 'https://schema.org/EventScheduled',
    location: f.home ? { '@type': 'Place', name: club.ground, address: `${club.address.street}, ${club.address.town} ${club.address.postcode}` } : { '@type': 'Place', name: f.opponent },
    homeTeam: { '@type': 'SportsTeam', name: f.home ? club.name : f.opponent },
    awayTeam: { '@type': 'SportsTeam', name: f.home ? f.opponent : club.name },
    ...(f.home ? { offers: { '@type': 'Offer', url: `${SITE}/tickets#m-${f.id}`, availability: 'https://schema.org/InStock' } } : {}),
  }));
  return page({
    title: 'Fixtures & Results',
    description: `${club.name} First XV fixtures, results and the league table, live from the WRU. Kick-off times and match tickets.`,
    path: '/fixtures',
    og: 'teams',
    ld: [crumbs([['Home', '/'], ['Fixtures', '/fixtures']]), ...events],
  }, body);
}

// --- News --------------------------------------------------------------------------

const NEWS_PER_PAGE = 12;
const newsPages = () => Math.max(1, Math.ceil(news.length / NEWS_PER_PAGE));

function storyCard(p) {
  const cover = p.cover || p.image;
  const pic = cover && images[cover] ? photo(cover, { cls: 'story-img', sizes: '(max-width: 700px) 100vw, 360px' }) : '';
  return `<article class="story${pic ? ' has-img' : ''}" data-reveal>
  <a href="/news/${esc(p.slug)}">
    ${pic}
    <p class="news-date"><time datetime="${esc(p.date)}">${esc(longDate(p.date))}</time></p>
    <h2>${esc(p.title)}</h2>
    <p>${esc(p.summary)}</p>
  </a>
</article>`;
}

function newsPage(n = 1) {
  const last = newsPages();
  const list = news.slice((n - 1) * NEWS_PER_PAGE, n * NEWS_PER_PAGE);
  const at = (k) => (k === 1 ? '/news' : `/news?page=${k}`);
  const nav = last > 1 ? `<nav class="pager" aria-label="More news">
    ${n > 1 ? `<a class="btn btn-line" href="${at(n - 1)}" rel="prev">Newer</a>` : '<span></span>'}
    <span class="muted">Page ${n} of ${last}</span>
    ${n < last ? `<a class="btn btn-line" href="${at(n + 1)}" rel="next">Older</a>` : '<span></span>'}
  </nav>` : '';
  const body = `${masthead({ kicker: 'From the club', title: n > 1 ? `News: page ${n}` : 'News', lead: 'Announcements, match days and the latest from Villa Field.' })}
<section class="sheet">
  <div class="wrap stories">${list.map(storyCard).join('')}</div>
  <div class="wrap">${nav}<p class="muted center" data-reveal>More on the club's <a href="${club.web.facebook}" rel="noopener">Facebook page</a> and <a href="${club.web.x}" rel="noopener">X</a>.</p></div>
</section>`;
  return page({
    title: n > 1 ? `News, page ${n}` : 'News',
    description: `News from ${club.name}: club announcements, match days, events and the latest from the clubhouse at Villa Field.${n > 1 ? ` Page ${n}.` : ''}`,
    path: at(n),
    og: 'news',
    extraHead: `${n > 1 ? `<link rel="prev" href="${SITE}${at(n - 1)}">\n` : ''}${n < last ? `<link rel="next" href="${SITE}${at(n + 1)}">\n` : ''}`,
    ld: [crumbs([['Home', '/'], ['News', '/news']]), {
      '@context': 'https://schema.org',
      '@type': 'ItemList',
      itemListElement: list.map((p, i) => ({ '@type': 'ListItem', position: (n - 1) * NEWS_PER_PAGE + i + 1, url: `${SITE}/news/${p.slug}`, name: p.title })),
    }],
  }, body);
}

function articlePage(post, { preview = false } = {}) {
  const img = post.image ? `<figure class="article-img" data-reveal>${photo(post.image, { lazy: false, sizes: '(max-width: 820px) 100vw, 760px' })}</figure>` : '';
  const ev = post.event;
  const upcoming = ev && daysTo(ev.start) >= 0;
  const [eday, etime] = ev ? String(ev.start).split('T') : [];
  const eventBox = ev ? `<aside class="event-note" data-reveal>
      <p class="panel-kicker">${upcoming ? 'Coming up' : 'Took place'}</p>
      <p><b>${esc(longDate(eday))}${etime ? `, ${esc(time12(etime))}` : ''}</b></p>
      <p>${icon('pin', { size: 16 })} ${esc(ev.place || club.address.name)}${ev.note ? ` · ${esc(ev.note)}` : ''}</p>
      ${ev.price ? `<p>${icon('ticket', { size: 16 })} ${esc(ev.price)}</p>` : ''}
    </aside>` : '';
  const gallery = (post.gallery || []).slice(1);
  const more = gallery.length ? `<div class="article-gallery">${gallery.map((g) => `<figure data-reveal>${photo(g, { sizes: '(max-width: 640px) 100vw, 360px' })}</figure>`).join('')}</div>` : '';
  const cta = post.cta ? `<p><a class="btn btn-navy" href="${esc(post.cta.href)}" rel="noopener">${esc(post.cta.label)}</a></p>` : '';
  const source = post.source === 'instagram' || post.source === 'facebook' ? `<p class="muted small">From the club's <a href="${esc(club.web.facebook)}" rel="noopener">Facebook</a>.</p>` : '';
  const body = `${masthead({ kicker: longDate(post.date), title: post.title })}
<section class="sheet">
  <article class="wrap prose article">
    ${eventBox}
    ${img}
    ${post.html != null ? `<div class="article-text">${post.html}</div>` : post.paragraphs.map((p, i) => `<p${i === 0 ? ' class="dropcap"' : ''}>${esc(p)}</p>`).join('\n    ')}
    ${cta}
    ${more}
    ${(post.tags || []).length ? `<p class="post-tags">${post.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join(' ')}</p>` : ''}
    ${source}
    <p class="back"><a href="${ev ? '/whats-on' : '/news'}">← ${ev ? "What's on" : 'All the news'}</a></p>
  </article>
</section>`;
  const cover = post.cover || post.image;
  const cm = cover && images[cover];
  const share = cm && cm.og ? { src: `/img/${cover}-og.jpg`, alt: cm.alt } : cm && cm.drawn && post.cover ? { src: `/img/${cover}.jpg`, alt: post.title } : null;
  return page({
    title: post.seoTitle || post.title,
    description: post.summary,
    path: `/news/${post.slug}`,
    og: 'news',
    image: share,
    type: 'article',
    noindex: preview,
    extraHead: `<meta property="article:published_time" content="${esc(zoned(post.publishAt) || post.date)}">\n${(post.tags || []).map((t) => `<meta property="article:tag" content="${esc(t)}">\n`).join('')}${post.updated ? `<meta property="article:modified_time" content="${esc(zoned(post.updated))}">\n` : ''}`,
    ld: [crumbs([['Home', '/'], ['News', '/news'], [post.title, `/news/${post.slug}`]]), {
      '@context': 'https://schema.org',
      '@type': 'NewsArticle',
      headline: post.title.slice(0, 110),
      datePublished: zoned(post.publishAt) || post.date,
      ...(post.updated ? { dateModified: zoned(post.updated) } : {}),
      description: post.summary,
      ...((post.tags || []).length ? { keywords: post.tags.join(', ') } : {}),
      image: post.cover ? `${SITE}/img/${post.cover}.jpg` : post.image ? `${SITE}/img/${post.image}.jpg` : `${SITE}/img/og-news.jpg`,
      author: { '@type': 'Organization', name: club.name, url: `${SITE}/` },
      publisher: { '@id': `${SITE}/#club` },
      mainEntityOfPage: `${SITE}/news/${post.slug}`,
    }],
  }, body);
}

// --- What's on ---------------------------------------------------------------------

function whatsOnPage() {
  const coming = comingUp();
  const body = `${masthead({ kicker: 'At the club', title: "What's On", lead: 'Match days, club nights and events at Villa Field.' })}
<section class="sheet">
  <div class="wrap">
    ${rule('Next match')}
    ${stub(nextFixture(), { big: true })}
    ${rule('Coming up')}
    ${coming.length ? `<ol class="diary">${coming.map((u) => {
      const [day, t] = u.event.start.split('T');
      const d = stubDate(day);
      return `<li data-reveal><a href="/news/${esc(u.slug)}"><span class="diary-date"><b>${esc(d.dd)}</b><i>${esc(d.mon.slice(0, 3))}</i></span><span class="diary-body"><b>${esc(u.title)}</b><span>${esc(d.wd)}${t ? `, ${esc(time12(t))}` : ''}${u.event.place ? ` · ${esc(u.event.place)}` : ''}</span></span></a></li>`;
    }).join('')}</ol>` : `<p class="muted" data-reveal>Nothing announced just yet. Follow the club on <a href="${esc(club.web.facebook)}" rel="noopener">Facebook</a> or <a href="${esc(club.web.x)}" rel="noopener">X</a>.</p>`}
    ${updates.length ? `${rule('This season')}<ol class="news-lines season">${updates.slice().sort((a, b) => b.date.localeCompare(a.date)).map(newsLine).join('')}</ol>` : ''}
  </div>
</section>`;
  return page({
    title: "What's On",
    description: `What's on at ${club.name}: the next match, club nights and events at ${club.ground}, Loughor.`,
    path: '/whats-on',
    og: 'news',
    ld: [crumbs([['Home', '/'], ["What's On", '/whats-on']]), ...coming.map((u) => ({
      '@context': 'https://schema.org',
      '@type': u.kind === 'match' ? 'SportsEvent' : 'Event',
      name: u.title,
      startDate: u.event.start,
      eventStatus: 'https://schema.org/EventScheduled',
      location: { '@type': 'Place', name: u.event.place || club.address.name, address: `${club.address.street}, ${club.address.town} ${club.address.postcode}` },
      url: `${SITE}/news/${u.slug}`,
    }))],
  }, body);
}

// --- Tickets -------------------------------------------------------------------------

const money = (minor) => `£${(Math.round(Number(minor) || 0) / 100).toFixed(2)}`;

function eventWhen(iso) {
  const [day, time] = String(iso || '').split('T');
  const date = new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/London' });
  return time ? `${date}, ${time12(time.slice(0, 5))}` : date;
}

/** One event on sale, with its own buying form (works with no script at all). */
function eventCard(e, { error = '', form = {} } = {}) {
  const types = (e.ticket_types || []).filter((t) => t.remaining === null || t.remaining === undefined || t.remaining > 0);
  const soldOut = !types.length;
  const rows = types.map((t) => {
    const max = Math.max(0, Math.min(Number(t.max_per_order) || 10, t.remaining == null ? 10 : t.remaining));
    const chosen = Number(form[`qty_${t.id}`]) || 0;
    const opts = Array.from({ length: max + 1 }, (_, n) => `<option value="${n}"${n === chosen ? ' selected' : ''}>${n}</option>`).join('');
    return `<li><label for="q-${esc(e.id)}-${esc(t.id)}"><span>${esc(t.name)}</span><b>${t.price_minor ? money(t.price_minor) : 'Free'}</b></label><select id="q-${esc(e.id)}-${esc(t.id)}" name="qty_${esc(t.id)}">${opts}</select></li>`;
  }).join('');
  return `<article class="panel event" id="e-${esc(e.id)}"${e.wru_fixture_id ? ` data-fixture="${esc(e.wru_fixture_id)}"` : ''} data-reveal>
  <p class="panel-kicker">${icon(e.kind === 'match' ? 'whistle' : 'calendar', { size: 16 })} ${esc(e.kind === 'match' ? 'Home match' : 'Club event')}</p>
  <h3>${esc(e.title)}</h3>
  <p class="muted"><time datetime="${esc(e.starts_at)}">${esc(eventWhen(e.starts_at))}</time>${e.location ? ` · ${esc(e.location)}` : ''}</p>
  ${e.description ? `<p>${esc(e.description)}</p>` : ''}
  ${soldOut || !e.on_sale ? `<p class="notice">${soldOut ? 'Sold out online.' : 'Not on sale online yet.'} Pay on the gate on the day.</p>` : `
  <form class="buy" method="post" action="/tickets/buy#e-${esc(e.id)}">
    <input type="hidden" name="event_id" value="${esc(e.id)}">
    <ul class="ticket-types">${rows}</ul>
    <div class="buy-who">
      <label>Name<input name="name" autocomplete="name" required maxlength="80" value="${esc(form.name || '')}"></label>
      <label>Email<input name="email" type="email" autocomplete="email" required maxlength="120" value="${esc(form.email || '')}"></label>
      <label>Mobile <small>(optional)</small><input name="phone" type="tel" autocomplete="tel" maxlength="30" value="${esc(form.phone || '')}"></label>
    </div>
    ${error ? `<p class="notice notice-error" role="alert">${esc(error)}</p>` : ''}
    <button class="btn btn-navy btn-block" type="submit">${icon('ticket', { size: 18 })} Buy tickets</button>
    <p class="muted small">Pay by card on the next page. Your tickets come by email with a QR code for the gate. <a href="/ordering-terms">Terms</a> · <a href="/privacy">Privacy</a></p>
  </form>`}
</article>`;
}

function menuTickets() {
  const menu = venue.menu();
  const sec = ((menu && menu.sections) || []).find((x) => /ticket/i.test(x.name || ''));
  if (!sec || !sec.items || !sec.items.length) return '';
  return `<ul class="ticket-types">${sec.items.map((it) => `<li><span>${esc(it.name)}</span><b>${money(it.price_minor)}</b></li>`).join('')}</ul><a class="btn btn-navy btn-block" href="${esc(MENU_URL)}">Buy tickets</a>`;
}

function ticketsPage({ error = '', eventId = null, form = {} } = {}) {
  const home = wru.fixtures().upcoming.filter((f) => f.home);
  const events = venue.events();
  const listed = events.length ? `<div class="events">${events.map((e) => eventCard(e, String(e.id) === String(eventId) ? { error, form } : {})).join('')}</div>` : '';
  const fromMenu = events.length ? '' : menuTickets();
  const body = `${masthead({ kicker: 'Admit one', title: 'Tickets', lead: 'Buy online and show the QR code at the gate, or pay on the day.' })}
<section class="sheet">
  <div class="wrap fx-grid">
    <div>
      ${listed ? `${rule('On sale now')}${listed}` : ''}
      ${rule('Home matches')}
      ${home.length ? `<ol class="fixtures">${home.map((f) => fixtureRow(f, { tickets: false })).join('')}</ol>` : `<p class="muted">The next home matches appear here from the WRU's fixture list. <a href="/fixtures">All fixtures</a>.</p>`}
    </div>
    <aside>
      ${listed ? '' : `<div class="panel" data-reveal><p class="panel-kicker">${icon('ticket', { size: 18 })} Buy tickets</p>
        <p>${fromMenu ? 'Buy online, then show your order at the gate. Or pay on the day.' : 'Pay on the gate on match day, by card or cash. Online tickets appear here as soon as the club puts them on sale.'}</p>
        ${fromMenu}</div>`}
      <div class="panel" data-reveal><p class="panel-kicker">${icon('nfc', { size: 18 })} Members</p><p>Show your members' card at the gate and the bar.</p><a class="btn btn-line" href="${MEMBERS}/">Members' card</a></div>
      <div class="panel" data-reveal><p class="panel-kicker">${icon('phone', { size: 18 })} Groups and questions</p><p>Call <a href="tel:${club.phone_e164}">${esc(club.phone)}</a> or email <a href="mailto:${esc(club.email)}">${esc(club.email)}</a>.</p></div>
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
    description: `Match and event tickets for ${club.name} at ${club.ground}, Loughor: buy online with a QR code for the gate, or pay on the day.`,
    path: '/tickets',
    og: 'teams',
    noindex: Boolean(error),
    ld: [crumbs([['Home', '/'], ['Tickets', '/tickets']]), ...offers],
  }, body);
}

function ticketOrderPage(r) {
  const o = (r && r.data) || {};
  let inner;
  if (!r || !r.ok) {
    inner = `<p class="notice notice-error">We couldn't find that order. If you paid, your tickets are on their way by email; or call ${esc(club.phone)}.</p>`;
  } else if (o.status === 'paid') {
    inner = `<div class="done"><h2>You're in, ${esc(String(o.name || '').split(' ')[0])}!</h2>
<p>${esc(o.event && o.event.title)}${o.event && o.event.starts_at ? ` · ${esc(eventWhen(o.event.starts_at))}` : ''}</p>
<p class="muted">We've emailed your tickets too. Show a code at the gate, on your phone or printed.</p></div>
<ol class="ticket-qrs">${(o.tickets || []).map((t) => `<li class="stub-qr"><img src="${esc(venue.ticketQr(t.code))}" alt="Ticket QR code ${esc(t.code)}" width="200" height="200"><b>${esc(t.type)}</b><span>${esc(t.holder || o.name || '')}</span><code>${esc(t.code)}</code></li>`).join('')}</ol>`;
  } else if (o.status === 'pending') {
    inner = `<p class="notice">Waiting for the card payment to finish. <a href="">Check again</a>. If you closed the payment page, <a href="/tickets">start again</a>.</p>`;
  } else {
    inner = `<p class="notice notice-error">The payment didn't go through, so no tickets were issued and nothing was taken. <a href="/tickets">Try again</a>.</p>`;
  }
  const body = `${masthead({ kicker: 'Tickets', title: o.status === 'paid' ? 'Your tickets' : 'Your order' })}
<section class="sheet"><div class="wrap ticket-order">${inner}</div></section>`;
  return page({ title: 'Your tickets', description: 'Your tickets.', path: '/tickets/order', og: 'teams', noindex: true }, body);
}

// --- Clubhouse, membership, contact -----------------------------------------------

function clubhousePage() {
  const body = `${masthead({ kicker: 'Villa Field', title: 'The Clubhouse', lead: esc(club.clubhouse.text) })}
<section class="sheet">
  <div class="wrap features">${club.clubhouse.features.map((f) => `<article class="feature" data-reveal><span class="feature-ic">${icon(f.icon, { size: 26 })}</span><h2>${esc(f.title)}</h2><p>${esc(f.text)}</p></article>`).join('')}</div>
</section>
<section class="sheet">
  <div class="wrap two-up-in">
    <div class="panel" data-reveal>
      <p class="panel-kicker">${icon('clock', { size: 18 })} Opening times</p>
      <h2>When we're open</h2>
      <p>${esc(club.clubhouse.hours_note)}</p>
      <div class="hours" data-hours data-api="${esc(MENU_API)}" data-slug="${esc(MENU_SLUG)}"></div>
      <p class="panel-actions"><a class="btn btn-navy" href="${esc(MENU_URL)}">${icon('plate', { size: 18 })} Food &amp; drink</a><a class="btn btn-line" href="tel:${club.phone_e164}">${icon('phone', { size: 18 })} ${esc(club.phone)}</a></p>
    </div>
    <div class="panel" data-reveal>
      <p class="panel-kicker">${icon('party', { size: 18 })} Hire the clubhouse</p>
      <h2>Your occasion at Villa Field</h2>
      <p>Birthdays, christenings, anniversaries, wakes and club events. Tell us the date, the numbers and whether you'd like food.</p>
      <p class="panel-actions"><a class="btn btn-line" href="tel:${club.phone_e164}">Ask about a date</a><a class="btn btn-line" href="/contact">Sponsor the club</a></p>
    </div>
  </div>
</section>`;
  return page({
    title: 'The Clubhouse',
    description: `${club.name}'s clubhouse at ${club.ground}: members' bar, food and drink to order online, live sport and function hire.`,
    path: '/clubhouse',
    og: 'clubhouse',
    ld: [crumbs([['Home', '/'], ['Clubhouse', '/clubhouse']])],
  }, body);
}

function membershipPage() {
  const body = `${masthead({ kicker: "Members' club", title: 'Membership', lead: esc(club.membership.text) })}
<section class="sheet">
  <div class="wrap two-up-in">
    <div data-reveal>
      <div class="member-card member-card-lg" aria-hidden="true" data-tilt-card>
        <img src="/img/crest-128.webp" alt="" width="72" height="72">
        <span class="mc-name">Loughor RFC</span><span class="mc-sub">Members' card · Est. ${club.founded}</span>
        <span class="mc-nfc">${icon('nfc', { size: 32 })}</span>
      </div>
      ${appSoon({ cls: 'app-soon-lg' })}
    </div>
    <div>
      ${rule('What you get')}
      <ul class="ticks">${club.membership.benefits.map((b) => `<li data-reveal>${icon('check', { size: 18 })}<span>${esc(b)}</span></li>`).join('')}</ul>
      <p data-reveal><a class="btn btn-navy" href="${MEMBERS}/">${icon('card', { size: 18 })} Open your card</a></p>
    </div>
  </div>
</section>
<section class="sheet">
  <div class="wrap">
    ${rule('How it works')}
    <ol class="steps">
      <li data-reveal><b>Join at the club</b><span>${esc(club.membership.join.split('; then')[0])}.</span></li>
      <li data-reveal><b>Sign in</b><span>Go to <a href="${MEMBERS}/">member.loughorrfc.site</a> and sign in with your email address and the one-time code we send you. The app for iPhone and Android follows soon.</span></li>
      <li data-reveal><b>Tap or show your card</b><span>Hold your phone or watch near the reader, or show the QR code at the bar. Your members' price is applied at the till.</span></li>
    </ol>
  </div>
</section>`;
  return page({
    title: 'Membership',
    description: `Join ${club.name} and carry your members' card on your phone at member.loughorrfc.site: members' prices at the bar, club news and offers.`,
    path: '/membership',
    og: 'membership',
    ld: [crumbs([['Home', '/'], ['Membership', '/membership']])],
  }, body);
}

function contactPage() {
  const a = club.address;
  const body = `${masthead({ kicker: 'Visit and contact', title: 'Find us', lead: `${esc(club.ground)}, ${esc(a.street)}, ${esc(a.town)}.` })}
<section class="sheet">
  <div class="wrap visit-in">
    <div data-reveal>
      <address class="address">${esc(a.name)}<br>${esc(a.street)}<br>${esc(a.town)}, ${esc(a.county)}<br>${esc(a.postcode)}</address>
      <p class="visit-actions">${directions()}</p>
      <ul class="contact-list">
        <li>${icon('phone', { size: 18 })}<a href="tel:${club.phone_e164}">${esc(club.phone)}</a></li>
        ${club.email ? `<li>${icon('mail', { size: 18 })}<a href="mailto:${esc(club.email)}">${esc(club.email)}</a></li>` : ''}
        <li>${icon('facebook', { size: 18 })}<a href="${club.web.facebook}" rel="noopener" target="_blank">Facebook</a></li>
        <li>${icon('x', { size: 16 })}<a href="${club.web.x}" rel="noopener" target="_blank">@LoughorRFC</a></li>
      </ul>
      <p class="small muted">${esc(club.company.name)} · company ${esc(club.company.number)} · registered office ${esc(club.company.registered_office)}</p>
    </div>
    ${mapArt()}
  </div>
</section>`;
  return page({
    title: 'Find us',
    description: `Find ${club.name}: ${club.ground}, ${a.street}, ${a.town} ${a.postcode}. Phone ${club.phone}, email, Facebook and directions.`,
    path: '/contact',
    og: 'contact',
    ld: [crumbs([['Home', '/'], ['Find us', '/contact']])],
  }, body);
}

function notFound() {
  const body = `${masthead({ kicker: 'Page not found', title: 'Knocked on', lead: 'That page is not here. Try the fixtures, the news or the home page.' })}
<section class="sheet"><div class="wrap center"><p><a class="btn btn-navy" href="/">Home</a> <a class="btn btn-line" href="/fixtures">Fixtures</a> <a class="btn btn-line" href="/news">News</a></p></div></section>`;
  return page({ title: 'Page not found', description: 'Page not found.', path: '/404', og: 'home', noindex: true }, body);
}

module.exports = {
  home, clubPage, teamsPage, newsPage, newsPages, articlePage, clubhousePage, membershipPage, contactPage,
  fixturesPage, ticketsPage, ticketOrderPage, whatsOnPage, notFound,
  ...legal,
  MENU_API, MENU_SLUG,
};
