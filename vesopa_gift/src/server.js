require('dotenv').config();

/**
 * Vesopa Gift — vouchers and tickets sold on a venue's own page.
 *
 * One process, behind nginx on the EPOS box, on 127.0.0.1:5070:
 *
 *   /<venue>              the venue's shop (only for a venue switched on)
 *   /v/<token>            a voucher, as the person given it opens it
 *   /t/<order>            tickets, as the buyer opens them
 *   /admin                the staff console, Continue with Vesopa
 *
 * It keeps its own database for everything about selling, and asks the EPOS
 * (src/epos.js) for the rest: a venue's branding, a card for every voucher sold,
 * a payment into the venue's own Dojo account.
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const compression = require('compression');
const cookieParser = require('cookie-parser');

const config = require('./config');
const { headers } = require('./security');
const { shopRouter } = require('./shop');
const { adminRouter } = require('./admin');
const account = require('./account');
const scheduler = require('./scheduler');
const mail = require('./mail');
const venues = require('./venues');
const site = require('./site');

const PUBLIC = path.join(__dirname, '..', 'public');
const app = express();
app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.disable('x-powered-by');

app.use(compression());
app.use(headers);
app.use(express.urlencoded({ extended: false, limit: '200kb' }));
app.use(express.json({ limit: '50kb' }));
app.use(cookieParser());

/**
 * Every local asset URL carries a hash of the file it names, computed at boot.
 * A deploy restarts the process, so a changed stylesheet gets a new URL and no
 * browser keeps last week's -- the back office learned that one the hard way.
 */
const hashes = new Map();
function asset(url) {
  if (!hashes.has(url)) {
    let h = '';
    try {
      h = crypto.createHash('sha256').update(fs.readFileSync(path.join(PUBLIC, url))).digest('hex').slice(0, 10);
    } catch { h = ''; }
    hashes.set(url, h);
  }
  const h = hashes.get(url);
  return h ? `${url}?v=${h}` : url;
}
app.locals.asset = asset;

// jsQR for the door, served from its package rather than copied into the repo.
app.get('/vendor/jsQR.js', (req, res) => {
  res.set('Cache-Control', req.query.v ? 'public, max-age=31536000, immutable' : 'public, max-age=86400');
  res.type('application/javascript').sendFile(require.resolve('jsqr/dist/jsQR.js'));
});
hashes.set('/vendor/jsQR.js', crypto.createHash('sha256').update(fs.readFileSync(require.resolve('jsqr/dist/jsQR.js'))).digest('hex').slice(0, 10));

app.use(express.static(PUBLIC, {
  index: false,
  extensions: false,
  maxAge: '1d',
  setHeaders(res, _file) {
    if (res.req && res.req.query && res.req.query.v) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  },
}));

app.get('/health', (_req, res) => res.json({ ok: true }));
// The public page's own robots.txt allows the front page on gift.vesopa.com;
// a venue's own domain, where there is no front page, still says no.
app.get('/robots.txt', (req, res, next) => {
  if (String(req.hostname || '').toLowerCase() === site.HOST) return next();
  res.type('text/plain').send('User-agent: *\nDisallow: /\n');
});

/**
 * A venue's own domain (vouchers.thebridge.co.uk) is its shop at the root.
 * The request is rewritten onto /<slug>/... before routing, so every route
 * below serves it unchanged.
 */
app.use(async (req, res, next) => {
  const host = String(req.hostname || '').toLowerCase();
  const own = config.BASE_URL.replace(/^https?:\/\//, '').split('/')[0].toLowerCase();
  if (!host || host === own || host === 'localhost' || host === '127.0.0.1') return next();
  try {
    const venue = await venues.byDomain(host);
    if (venue && !req.url.startsWith('/admin') && !req.url.startsWith(`/${venue.slug}`)
        && !/^\/(v|t|u|css|js|img|vendor|account)\//.test(req.url) && req.url !== '/account') {
      req.url = `/${venue.slug}${req.url === '/' ? '' : req.url}`;
    }
  } catch { /* fall through */ }
  next();
});

app.use('/admin', adminRouter);
app.use(account.attach);
app.use(account.accountRouter);

// gift.vesopa.com itself: what Vesopa Gift is, the demo shop, the prices.
// On any other host (a venue's own domain with no venue behind it) the root
// is nothing, and says so with a way to the front page.
app.use(site.siteRoutes({ asset }));
app.get('/', (_req, res) => {
  res.status(404).render('shop/message', {
    title: 'Vesopa Gift', heading: 'There is nothing here', body: 'Check the address you were given.', home: config.BASE_URL,
  });
});

app.use(shopRouter);

app.use((req, res) => {
  res.status(404).render('shop/message', {
    title: 'Not found', heading: 'There is nothing at this address',
    body: 'It may have been typed a letter out, or the link may be older than the page. Check the address you were given.',
    home: config.BASE_URL,
  });
});

app.use((err, req, res, _next) => {
  console.error('[error]', req.method, req.originalUrl, err && err.stack ? err.stack : err);
  if (res.headersSent) return;
  if (req.path.endsWith('.json') || req.path.endsWith('/scan')) {
    return res.status(500).json({ ok: false, title: 'Something went wrong', detail: 'Try again.' });
  }
  res.status(500).render('shop/message', {
    title: 'Something went wrong',
    heading: 'Something went wrong',
    body: 'Sorry, that did not work. Nothing has been taken from your card unless you were told it was paid. Please try again in a moment.',
  });
});

if (require.main === module) {
  for (const name of ['SESSION_SECRET', 'GIFT_SERVICE_KEY', 'DB_USER']) {
    if (!process.env[name]) console.warn(`[config] ${name} is not set`);
  }
  app.listen(config.PORT, '127.0.0.1', () => {
    console.log(`Vesopa Gift listening on http://127.0.0.1:${config.PORT} for ${config.BASE_URL}`);
    mail.verify();
    if (process.env.GIFT_SCHEDULER !== 'off') scheduler.start();
  });
}

module.exports = { app, asset };
