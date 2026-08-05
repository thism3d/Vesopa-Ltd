require('dotenv').config();

const path = require('path');
const express = require('express');
const compression = require('compression');
const cookieParser = require('cookie-parser');

const config = require('./config');
const db = require('./db');
const { verifyMail } = require('./mailer');
const auth = require('./auth');
const { icon } = require('./icons');
const currencyContext = require('./currency-context');
const geo = require('./geo');
const registrar = require('./integrations/domainnameapi');
const hestia = require('./integrations/hestia');

const PORT = Number(process.env.PORT) || 5075;
const app = express();

// Behind nginx on the live server, so req.ip is the visitor and not the proxy.
// The login rate limiter counts by IP and is worthless without this.
app.set('trust proxy', 1);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));

app.use(compression());
app.use(express.urlencoded({ extended: false, limit: '512kb' }));
app.use(express.json({ limit: '512kb' }));
app.use(cookieParser());

// ---------------------------------------------------------------------------
// Security headers
// ---------------------------------------------------------------------------
// A real CSP is possible here in a way it was not on the EPOS site: this app
// loads nothing from a third-party origin. No CDN, no font host, no analytics.
// 'unsafe-inline' remains for styles only, because the templates set a handful
// of inline `style` attributes for one-off spacing.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'",
      "form-action 'self'",
      "frame-ancestors 'self'",
      "base-uri 'self'",
      "object-src 'none'",
    ].join('; '),
  );
  if (req.secure) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

// ---------------------------------------------------------------------------
// Static
// ---------------------------------------------------------------------------
app.use(
  express.static(path.join(__dirname, '..', 'public'), {
    maxAge: process.env.NODE_ENV === 'production' ? '7d' : 0,
    etag: true,
  }),
);

// ---------------------------------------------------------------------------
// Locals every view can rely on
// ---------------------------------------------------------------------------
app.use(async (req, res, next) => {
  res.locals.siteUrl = config.SITE_URL;
  res.locals.mainSiteUrl = config.MAIN_SITE_URL;
  res.locals.contact = config.CONTACT;
  res.locals.brand = config.BRAND;
  res.locals.currentPath = req.path;
  // Path AND query. The currency switcher sends people back to exactly where
  // they were, and on /domains?q=something the query string is the whole page.
  res.locals.currentUrl = req.originalUrl || req.path;
  // Views prefill from the query string (?subject=…), so expose it once here
  // rather than passing it through from every route.
  res.locals.query = req.query || {};
  res.locals.icon = icon;
  // money(), moneyParts(), currency, vatPercent and showVat are set by the
  // currency middleware immediately below — they cannot be constants any more,
  // because what they mean depends on who is asking.
  res.locals.nameservers = config.NAMESERVERS;
  res.locals.customer = null;
  res.locals.admin = null;
  res.locals.flash = null;
  res.locals.csrf = auth.csrfToken(req, res);
  res.locals.cartCount = 0;

  // A one-shot message survives a redirect in a cookie rather than a session
  // store, so "your password was changed" reaches the page it belongs on.
  const flash = req.cookies?.vh_flash;
  if (flash) {
    try {
      res.locals.flash = JSON.parse(Buffer.from(flash, 'base64url').toString('utf8'));
    } catch {
      /* a malformed flash is not worth an error page */
    }
    res.clearCookie('vh_flash', { path: '/' });
  }

  next();
});

/**
 * Which currency is this request in?
 *
 * Before any route, because a route that renders a price has to already know.
 * The `trust proxy` line at the top of this file is what makes the geo half of
 * it work at all — without it every visitor behind nginx looks like 127.0.0.1
 * and the whole site would serve one currency to everybody.
 */
app.use(currencyContext.attach);
app.get('/currency/:code', currencyContext.switchTo);

/** Attach the signed-in customer, if the cookie is valid and still current. */
app.use(async (req, res, next) => {
  const session = auth.readCustomerSession(req);
  if (!session) return next();
  try {
    const customer = await db.one(
      'SELECT * FROM customers WHERE id = ? AND status <> ? LIMIT 1',
      [session.sub, 'closed'],
    );
    // The password fingerprint in the cookie must still match the stored hash;
    // a password change is what invalidates every other device.
    if (customer && auth.passwordVersion(customer.password_hash) === session.pwv) {
      req.customer = customer;
      res.locals.customer = customer;
    }
  } catch (err) {
    console.error('[session] customer lookup failed:', err.message);
  }
  next();
});

/** Cart lives in a cookie until checkout — no rows for an abandoned basket. */
app.use((req, res, next) => {
  try {
    req.cart = req.cookies?.vh_cart ? JSON.parse(Buffer.from(req.cookies.vh_cart, 'base64url').toString('utf8')) : [];
    if (!Array.isArray(req.cart)) req.cart = [];
  } catch {
    req.cart = [];
  }
  res.locals.cartCount = req.cart.length;
  next();
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.use('/', require('./routes/pages'));
app.use('/', require('./routes/legal'));
app.use('/', require('./routes/auth-routes'));
app.use('/api/domains', require('./routes/domains-api'));
app.use('/', require('./routes/cart'));
app.use('/panel', require('./routes/panel'));
app.use('/admin', require('./routes/admin'));

// ---------------------------------------------------------------------------
// 404 and error
// ---------------------------------------------------------------------------
app.use((req, res) => {
  res.status(404);
  if (req.path.startsWith('/api/')) return res.json({ error: 'Not found.' });
  res.render('public/error', {
    title: 'Page not found',
    robots: 'noindex',
    code: 404,
    heading: 'That page does not exist',
    message: 'The link may be out of date, or the address mistyped.',
  });
});

app.use((err, req, res, _next) => {
  console.error('[error]', err.stack || err.message);
  res.status(err.status || 500);
  if (req.path.startsWith('/api/')) {
    return res.json({ error: 'Something went wrong. Please try again.' });
  }
  res.render('public/error', {
    title: 'Something went wrong',
    robots: 'noindex',
    code: 500,
    heading: 'Something went wrong at our end',
    message: 'The problem has been logged. Please try again, or contact support if it keeps happening.',
  });
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
(async () => {
  // Fail loudly and immediately rather than at the first customer's request.
  try {
    await db.ping();
    console.log(`[db] connected to ${process.env.DB_NAME || 'vesopa_hostingdb'}`);
  } catch (err) {
    console.error('[db] could not connect:', err.message);
    console.error('     Check DB_USER / DB_PASSWORD in .env, and that schema.sql has been applied.');
    process.exit(1);
  }

  verifyMail();

  // Currency catalogue up front, so a seed that has not been run is a startup
  // message rather than a mystery on the pricing page.
  try {
    const { all, base, default: def } = await require('./currency').load({ fresh: true });
    console.log(
      `[currency] base ${base.code}, default ${def.code}, selling in `
      + all.filter((c) => c.active).map((c) => `${c.code}@${c.rate}`).join(' '),
    );
    if (all.length === 1) {
      console.warn('           Only one currency configured — run seed.sql to add USD and CAD.');
    }
  } catch (err) {
    console.error('[currency] catalogue unavailable:', err.message);
  }

  const g = geo.status();
  console.log(
    `[geo]      ${g.enabled ? `${g.endpoint}, server-side only` : 'disabled — everyone gets the default currency'}`,
  );

  const reg = registrar.status();
  const node = hestia.status();
  console.log(`[registrar] DomainNameAPI in ${reg.mode.toUpperCase()} mode${reg.configured ? '' : ' (no credentials set)'}`);
  console.log(`[hestia]    node in ${node.mode.toUpperCase()} mode — ${node.host}`);
  if (!reg.live) console.log('            No domain will actually be registered while DNA_MODE=mock.');
  if (!node.live) console.log('            No account will actually be created while HESTIA_MODE=mock.');

  app.listen(PORT, () => {
    console.log(`\n  Vesopa Hosting running on http://localhost:${PORT}`);
    console.log(`  Admin panel:               http://localhost:${PORT}/admin\n`);
  });
})();
