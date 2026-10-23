/**
 * pontardawerfc.com
 *
 *   node src/server.js        PORT from .env (pinned per app on the Cloud box)
 *
 * Pages are rendered here from content/ (src/pages.js); the menu and orders
 * come from the club's Vesopa EPOS back office in the visitor's browser
 * (public/js/order.js, MENU_API); the helper answers at POST /api/ask.
 * Behind nginx on the Cloud box: www and http are sent to https://pontardawerfc.com
 * by the panel, and this redirects www itself in case they are not.
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const express = require('express');
const { club, news } = require('./content');
const pages = require('./pages');
const { SITE, MEMBERS } = require('./layout');
const { helperRoute } = require('./helper');
const wru = require('./wru');
const venue = require('./venue_api');
const game = require('./game_rooms');
const posts = require('./posts');
const { adminRoutes } = require('./admin');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback');

const PUBLIC = path.join(__dirname, '..', 'public');
const STARTED = new Date().toISOString();

app.use((req, res, next) => {
  const host = String(req.headers.host || '').toLowerCase();
  if (host.startsWith('www.')) return res.redirect(301, `${SITE}${req.originalUrl}`);
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
    'X-Frame-Options': 'SAMEORIGIN',
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https:",
      "font-src 'self'",
      `connect-src 'self' wss://pontardawerfc.com ws://127.0.0.1:* ws://localhost:* ${pages.MENU_API}`,
      "frame-src https://www.google.com https://maps.google.com",
      "frame-ancestors 'self'",
      "base-uri 'self'",
      "form-action 'self' https://pay.dojo.tech",
    ].join('; '),
  });
  next();
});

wru.start();
venue.start();

app.get('/health', (req, res) => res.json({ ok: true, site: 'pontardawerfc.com', started: STARTED }));

app.use(express.static(PUBLIC, {
  index: false,
  maxAge: '7d',
  setHeaders(res, file) {
    if (/\.(woff2|webp|jpg|png|ico)$/.test(file)) res.set('Cache-Control', 'public, max-age=2592000, immutable');
  },
}));
// Photos uploaded in the admin (src/uploads.js): each name is new, so they never change.
app.use('/img/u', express.static(posts.UPLOADS, { index: false, maxAge: '365d', immutable: true }));
// Where the club writes its news (src/admin.js).
app.use('/admin', adminRoutes());
// Photos no post uses any more go after a day (src/posts.js sweepPhotos), checked every six hours.
const sweep = () => {
  try {
    const gone = posts.sweepPhotos();
    if (gone.length) console.log(`news admin: ${gone.length} unused photo(s) removed`);
  } catch (e) { console.error('photo sweep:', e.message); }
};
setTimeout(sweep, 60 * 1000).unref();
setInterval(sweep, 6 * 3600 * 1000).unref();

// A minute, so a post published in the admin is on every page almost at once.
const html = (render) => (req, res) => {
  res.set('Cache-Control', 'public, max-age=60');
  res.type('html').send(render(req));
};

app.get('/', html(() => pages.home()));
app.get('/club', html(() => pages.clubPage()));
app.get('/teams', html(() => pages.teamsPage()));
app.get('/fixtures', html(() => pages.fixturesPage()));
app.get('/whats-on', html(() => pages.whatsOnPage()));
app.get('/play', html(() => pages.playPage()));
app.get(['/game', '/games', '/play/'], (req, res) => res.redirect(301, '/play'));
app.get(['/whatson', '/events', '/whats-on/'], (req, res) => res.redirect(301, '/whats-on'));
app.get('/tickets', html(() => pages.ticketsPage()));

// pontardawerfc.com/app: one link for posters, QR codes and posts. An iPhone
// or iPad goes to the App Store (TestFlight for now), an Android phone to
// Google Play, and anything else to the page with both.
app.get(['/app', '/app/'], (req, res) => {
  const ua = String(req.headers['user-agent'] || '');
  res.set('Cache-Control', 'no-store').set('Vary', 'User-Agent');
  if (/iPhone|iPad|iPod/.test(ua)) return res.redirect(302, club.web.ios_app);
  if (/Android/.test(ua)) return res.redirect(302, club.web.android_app);
  return res.redirect(302, '/membership#app');
});

// Buying tickets: a plain form, so it works with no script. The back office
// takes the order and gives a card payment page (Dojo) that comes back to
// /tickets/order?order=<id>, where the tickets are shown and emailed.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
app.post('/tickets/buy', express.urlencoded({ extended: false, limit: '8kb' }), async (req, res) => {
  const b = req.body || {};
  const form = { name: String(b.name || '').trim().slice(0, 80), email: String(b.email || '').trim().slice(0, 120), phone: String(b.phone || '').trim().slice(0, 30) };
  Object.keys(b).filter((k) => /^qty_\d+$/.test(k)).forEach((k) => { form[k] = b[k]; });
  const items = Object.keys(form).filter((k) => k.startsWith('qty_'))
    .map((k) => ({ ticket_type_id: Number(k.slice(4)), qty: Math.max(0, Math.min(20, parseInt(form[k], 10) || 0)) }))
    .filter((i) => i.qty > 0);
  const again = (error, status = 400) => {
    res.status(status).set('Cache-Control', 'no-store').type('html')
      .send(pages.ticketsPage({ error, eventId: b.event_id, form }));
  };
  if (!items.length) return again('Choose how many tickets you would like.');
  if (!form.name) return again('Please add your name, for the tickets.');
  if (!EMAIL.test(form.email)) return again('Please check your email address: your tickets are sent there.');
  try {
    const r = await venue.checkout({
      event_id: Number(b.event_id), items, ...form, return_url: `${SITE}/tickets/order`,
    });
    if (!r.ok) return again(r.data && r.data.error ? r.data.error : 'Those tickets could not be booked just now. Please try again.', r.status >= 500 ? 502 : 400);
    if (r.data.pay_url && /^https:\/\//.test(r.data.pay_url)) return res.redirect(303, r.data.pay_url);
    return res.redirect(303, `/tickets/order?order=${encodeURIComponent(r.data.order_id)}`);
  } catch (e) {
    console.error('tickets:', String(e.message || e).slice(0, 200));
    return again('Tickets could not be booked just now. Please try again, or pay on the gate.', 502);
  }
});
app.get('/tickets/order', async (req, res) => {
  const id = String(req.query.order || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  let r = null;
  if (id) r = await venue.order(id).catch(() => null);
  res.set('Cache-Control', 'no-store').type('html').send(pages.ticketOrderPage(r));
});
app.get('/news', (req, res, next) => {
  if (req.query.page === undefined) return html(() => pages.newsPage(1))(req, res);
  const n = Number(req.query.page);
  if (n === 1) return res.redirect(301, '/news');
  if (!Number.isInteger(n) || n < 1 || n > pages.newsPages()) return next();
  return html(() => pages.newsPage(n))(req, res);
});
app.get('/clubhouse', html(() => pages.clubhousePage()));
// The menu lives on its own address now; old links and printed QR codes
// that say pontardawerfc.com/menu still land on it.
const MENU_URL = process.env.MENU_URL || 'https://menu.pontardawerfc.com/';
app.get(['/menu', '/menu/'], (req, res) => res.redirect(301, MENU_URL));
app.get('/membership', html(() => pages.membershipPage()));
app.get('/contact', html(() => pages.contactPage()));
app.get('/privacy', html(() => pages.privacyPage()));
app.get('/cookies', html(() => pages.cookiesPage()));
app.get('/ordering-terms', html(() => pages.termsPage()));
app.get('/accessibility', html(() => pages.accessibilityPage()));
app.get('/licences', html(() => pages.licencesPage()));
app.get('/archive', html(() => pages.archivePage()));
app.get(['/archives', '/archive/', '/old-site'], (req, res) => res.redirect(301, '/archive'));
app.get(['/licenses', '/credits', '/licences/'], (req, res) => res.redirect(301, '/licences'));
app.get('/news/:slug', (req, res, next) => {
  const post = news.find((p) => p.slug === req.params.slug);
  if (!post) {
    // A post renamed in the admin keeps its old address working.
    const moved = posts.movedFrom(req.params.slug);
    return moved ? res.redirect(301, `/news/${moved.slug}`) : next();
  }
  res.set('Cache-Control', 'public, max-age=60');
  res.type('html').send(pages.articlePage(post));
});

// The old WordPress site's addresses (pontardawe.rfc.wales), in case anybody
// points that name here or copies a link across.
const OLD = {
  '/contact-us': '/contact',
  '/home': '/',
  '/sample-page': '/',
  '/2024/09/11/tribute-to-brian-bones-williams': '/news/tribute-to-brian-bones-williams',
  '/2024/09/18/job-vacancy-club-facilities-manager': '/news/job-vacancy-club-facilities-manager',
  '/order': '/menu', // and on to menu.pontardawerfc.com
  '/members': '/membership',
  '/history': '/club',
};
app.get(Object.keys(OLD).flatMap((k) => [k, `${k}/`]), (req, res) => res.redirect(301, OLD[req.path.replace(/\/$/, '')]));
app.get(['/feed', '/feed/'], (req, res) => res.redirect(301, '/news/feed.xml'));

// --- For machines ------------------------------------------------------------

const PATHS = ['/', '/whats-on', '/play', '/licences', '/club', '/archive', '/teams', '/fixtures', '/tickets', '/news', '/clubhouse', '/membership', '/contact',
  '/privacy', '/cookies', '/ordering-terms', '/accessibility'];

/*
 * Sitemaps (2026-10-15). A sitemap may only list addresses on its own host,
 * so each of the club's three sites has its own and this one indexes them:
 *   pontardawerfc.com/sitemap.xml          this site's pages and news
 *   menu.pontardawerfc.com/sitemap.xml     the menu (vesopa_server dinein_pages.js)
 *   member.pontardawerfc.com/sitemap.xml   the members' app (loyalty_host.js)
 *   pontardawerfc.com/sitemap-index.xml    all three
 * How often each page changes and how much it matters, so a crawler spends
 * its visits on fixtures and news rather than on the cookie policy.
 */
const SITEMAP_RANK = {
  '/': ['daily', '1.0'], '/fixtures': ['daily', '0.9'], '/whats-on': ['daily', '0.9'], '/tickets': ['daily', '0.8'],
  '/news': ['daily', '0.8'], '/membership': ['monthly', '0.9'], '/clubhouse': ['monthly', '0.7'], '/teams': ['weekly', '0.7'],
  '/club': ['monthly', '0.7'], '/contact': ['monthly', '0.7'], '/play': ['monthly', '0.6'], '/archive': ['yearly', '0.5'],
  '/licences': ['yearly', '0.2'], '/privacy': ['yearly', '0.2'], '/cookies': ['yearly', '0.2'], '/ordering-terms': ['yearly', '0.2'],
  '/accessibility': ['yearly', '0.2'],
};
const SITEMAPS = [`${SITE}/sitemap.xml`, 'https://menu.pontardawerfc.com/sitemap.xml', `${MEMBERS}/sitemap.xml`];

app.get('/sitemap.xml', (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  const urls = [
    ...PATHS.map((p) => {
      const [freq, pri] = SITEMAP_RANK[p] || ['monthly', '0.5'];
      return { loc: `${SITE}${p}`, lastmod: today, freq, pri };
    }),
    // This month's news is still news; older posts are the record.
    ...news.map((n) => ({ loc: `${SITE}/news/${n.slug}`, lastmod: String(n.updated || n.date).slice(0, 10), freq: n.date >= monthAgo ? 'weekly' : 'yearly', pri: n.date >= monthAgo ? '0.7' : '0.4' })),
  ];
  res.set('Cache-Control', 'public, max-age=3600');
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${u.loc}</loc><lastmod>${u.lastmod}</lastmod><changefreq>${u.freq}</changefreq><priority>${u.pri}</priority></url>`).join('\n')}
</urlset>
`);
});

app.get('/sitemap-index.xml', (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  res.set('Cache-Control', 'public, max-age=3600');
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${SITEMAPS.map((loc) => `  <sitemap><loc>${loc}</loc><lastmod>${today}</lastmod></sitemap>`).join('\n')}
</sitemapindex>
`);
});

app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(`# pontardawerfc.com
User-agent: *
Allow: /
Disallow: /api/
Disallow: /admin

# AI assistants and search: welcome to read the public pages.
User-agent: GPTBot
Allow: /
User-agent: ClaudeBot
Allow: /
User-agent: Google-Extended
Allow: /
User-agent: PerplexityBot
Allow: /

Sitemap: ${SITE}/sitemap.xml
Sitemap: ${SITE}/sitemap-index.xml
`);
});

/* llms.txt: a plain summary for AI assistants that read the site. */
app.get('/llms.txt', (req, res) => {
  const a = club.address;
  res.type('text/plain').send(`# ${club.name}

> ${club.short}

- Founded: ${club.founded}
- Clubhouse: ${a.name}, ${a.street}, ${a.town}, ${a.county}, ${a.postcode}
- Phone: ${club.phone}${club.email ? `\n- Email: ${club.email}` : ''}
- Home ground: ${club.ground}
- League: ${club.league}
- Members' app: ${MEMBERS}/ (or the Pontardawe RFC app for iPhone and Android: ${SITE}/app)
- Facebook: ${club.web.facebook}
- X (Twitter): ${club.web.x}
- Company: ${club.company.name}, ${club.company.number}

## Pages
- [The Club](${SITE}/club): history since ${club.founded}, timeline, Wales internationals
- [Teams & Fixtures](${SITE}/teams): First XV, juniors, WRU fixtures and table
- [Fixtures & Results](${SITE}/fixtures): the next match, results and the league table, live from the WRU
- [Tickets](${SITE}/tickets): match tickets for home games
- [News](${SITE}/news)
- [The Clubhouse](${SITE}/clubhouse): bar, café, live sport, function hire, sponsorship
- [Menu & Order](https://menu.pontardawerfc.com/): live menu; order to your table or for collection, pay at the bar
- [Membership](${SITE}/membership): members' discount, the members' card at ${MEMBERS}/
- [Contact](${SITE}/contact)
- [Privacy](${SITE}/privacy)

## Questions and answers
${club.faq.map((f) => `- ${f.q} ${f.a}`).join('\n')}
`);
});

app.get('/site.webmanifest', (req, res) => {
  res.type('application/manifest+json').send(JSON.stringify({
    name: club.name,
    short_name: 'Pontardawe RFC',
    description: club.tagline,
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#2a0000',
    theme_color: '#8F0000',
    icons: [
      { src: '/img/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/img/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/img/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    shortcuts: [
      { name: 'Menu & order', url: 'https://menu.pontardawerfc.com/' },
      { name: "Members' card", url: `${MEMBERS}/` },
    ],
  }));
});

app.get('/news/feed.xml', (req, res) => {
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  res.type('application/rss+xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>${esc(club.name)} news</title><link>${SITE}/news</link><description>${esc(club.tagline)}</description><language>en-gb</language>
${news.map((n) => `<item><title>${esc(n.title)}</title><link>${SITE}/news/${n.slug}</link><guid>${SITE}/news/${n.slug}</guid><pubDate>${new Date(posts.zoned(n.publishAt) || `${n.date}T12:00:00Z`).toUTCString()}</pubDate><description>${esc(n.summary)}</description></item>`).join('\n')}
</channel></rss>
`);
});

app.get('/.well-known/security.txt', (req, res) => {
  res.type('text/plain').send(`Contact: mailto:info@vesopa.com\nExpires: ${new Date(Date.now() + 365 * 864e5).toISOString()}\nPreferred-Languages: en\n`);
});

app.post('/api/ask', express.json({ limit: '24kb' }), helperRoute());

/*
 * Dojo's webhook for Pontardawe's online checkout (sandbox, "PontardaweRFC
 * Demo"), registered at https://pontardawerfc.com/dojo_test_webhook
 * (2026-10-16). Passed through unchanged -- the exact bytes and the
 * dojo-signature header -- to the back office, which verifies the signature
 * and settles the menu order. Nothing is trusted or kept here.
 */
const BACKOFFICE = (process.env.BACKOFFICE_URL || 'https://backoffice.vesopaepos.com').replace(/\/+$/, '');
app.post('/dojo_test_webhook', express.raw({ type: '*/*', limit: '256kb' }), async (req, res) => {
  try {
    const r = await fetch(`${BACKOFFICE}/api/webhooks/dojo/sandbox`, {
      method: 'POST',
      headers: {
        'content-type': req.get('content-type') || 'application/json',
        'dojo-signature': req.get('dojo-signature') || '',
      },
      body: Buffer.isBuffer(req.body) ? req.body : Buffer.from(''),
      signal: AbortSignal.timeout(15000),
    });
    res.status(r.status).type('application/json').send(await r.text());
  } catch {
    // A 5xx makes Dojo retry later, which is right when the back office is away.
    res.status(502).json({ error: 'Could not reach the back office.' });
  }
});
// Ponty Kicks online (src/game_rooms.js): HTTP here, the socket on the server below.
app.use('/api/play', game.gameRoutes(express));

app.use((req, res) => {
  res.status(404).type('html').send(pages.notFound());
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).type('text/plain').send('Something went wrong. Please call the club on 01792 864811.');
});

// Every server this app listens on (the box, and the tests) also takes the
// game's WebSocket at /api/play/ws.
const listen = app.listen.bind(app);
app.listen = (...args) => {
  const server = listen(...args);
  game.attach(server);
  return server;
};

if (require.main === module) {
  const port = Number(process.env.PORT) || 5090;
  app.listen(port, '127.0.0.1', () => console.log(`pontardawerfc.com on 127.0.0.1:${port}`));
}

module.exports = app;
