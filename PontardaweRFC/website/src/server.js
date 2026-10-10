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
      "form-action 'self'",
    ].join('; '),
  });
  next();
});

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
  '/fixtures': '/teams',
};
app.get(Object.keys(OLD).flatMap((k) => [k, `${k}/`]), (req, res) => res.redirect(301, OLD[req.path.replace(/\/$/, '')]));
app.get(['/feed', '/feed/'], (req, res) => res.redirect(301, '/news/feed.xml'));

// --- For machines ------------------------------------------------------------

const PATHS = ['/', '/club', '/teams', '/news', '/clubhouse', '/menu', '/membership', '/contact',
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
- Members' app: ${MEMBERS}/
- Facebook: ${club.web.facebook}
- Company: ${club.company.name}, ${club.company.number}

## Pages
- [The Club](${SITE}/club): history since ${club.founded}, timeline, Wales internationals
- [Teams & Fixtures](${SITE}/teams): First XV, juniors, WRU fixtures and table
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
