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
      `connect-src 'self' ${pages.MENU_API}`,
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

const html = (render) => (req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.type('html').send(render(req));
};

app.get('/', html(() => pages.home()));
app.get('/club', html(() => pages.clubPage()));
app.get('/teams', html(() => pages.teamsPage()));
app.get('/fixtures', html(() => pages.fixturesPage()));
app.get('/whats-on', html(() => pages.whatsOnPage()));
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
app.get('/news', html(() => pages.newsPage()));
app.get('/clubhouse', html(() => pages.clubhousePage()));
app.get('/menu', html(() => pages.menuPage()));
app.get('/membership', html(() => pages.membershipPage()));
app.get('/contact', html(() => pages.contactPage()));
app.get('/privacy', html(() => pages.privacyPage()));
app.get('/cookies', html(() => pages.cookiesPage()));
app.get('/ordering-terms', html(() => pages.termsPage()));
app.get('/accessibility', html(() => pages.accessibilityPage()));
app.get('/news/:slug', (req, res, next) => {
  const post = news.find((p) => p.slug === req.params.slug);
  if (!post) return next();
  res.set('Cache-Control', 'public, max-age=300');
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
  '/order': '/menu',
  '/members': '/membership',
  '/history': '/club',
};
app.get(Object.keys(OLD).flatMap((k) => [k, `${k}/`]), (req, res) => res.redirect(301, OLD[req.path.replace(/\/$/, '')]));
app.get(['/feed', '/feed/'], (req, res) => res.redirect(301, '/news/feed.xml'));

// --- For machines ------------------------------------------------------------

const PATHS = ['/', '/whats-on', '/club', '/teams', '/fixtures', '/tickets', '/news', '/clubhouse', '/menu', '/membership', '/contact',
  '/privacy', '/cookies', '/ordering-terms', '/accessibility'];

app.get('/sitemap.xml', (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const urls = [
    ...PATHS.map((p) => ({ loc: `${SITE}${p}`, lastmod: today, pri: p === '/' ? '1.0' : ['/menu', '/membership'].includes(p) ? '0.9' : '0.7' })),
    ...news.map((n) => ({ loc: `${SITE}/news/${n.slug}`, lastmod: n.date, pri: '0.6' })),
    { loc: `${MEMBERS}/`, lastmod: today, pri: '0.8' },
  ];
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${u.loc}</loc><lastmod>${u.lastmod}</lastmod><priority>${u.pri}</priority></url>`).join('\n')}
</urlset>
`);
});

app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(`# pontardawerfc.com
User-agent: *
Allow: /
Disallow: /api/

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
- [Menu & Order](${SITE}/menu): live menu; order to your table or for collection, pay at the bar
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
      { name: 'Menu & order', url: '/menu' },
      { name: "Members' card", url: `${MEMBERS}/` },
    ],
  }));
});

app.get('/news/feed.xml', (req, res) => {
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  res.type('application/rss+xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>${esc(club.name)} news</title><link>${SITE}/news</link><description>${esc(club.tagline)}</description><language>en-gb</language>
${news.map((n) => `<item><title>${esc(n.title)}</title><link>${SITE}/news/${n.slug}</link><guid>${SITE}/news/${n.slug}</guid><pubDate>${new Date(`${n.date}T12:00:00Z`).toUTCString()}</pubDate><description>${esc(n.summary)}</description></item>`).join('\n')}
</channel></rss>
`);
});

app.get('/.well-known/security.txt', (req, res) => {
  res.type('text/plain').send(`Contact: mailto:info@vesopa.com\nExpires: ${new Date(Date.now() + 365 * 864e5).toISOString()}\nPreferred-Languages: en\n`);
});

app.post('/api/ask', express.json({ limit: '24kb' }), helperRoute());

app.use((req, res) => {
  res.status(404).type('html').send(pages.notFound());
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).type('text/plain').send('Something went wrong. Please call the club on 01792 864811.');
});

if (require.main === module) {
  const port = Number(process.env.PORT) || 5090;
  app.listen(port, '127.0.0.1', () => console.log(`pontardawerfc.com on 127.0.0.1:${port}`));
}

module.exports = app;
