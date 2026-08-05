require('dotenv').config();

const path = require('path');
const express = require('express');
const compression = require('compression');
const cookieParser = require('cookie-parser');

const config = require('./config');
const { pagesRouter } = require('./routes/pages');
const { formsRouter } = require('./routes/forms');
const { checkoutApiRouter } = require('./routes/checkout-api');
const { blogPagesRouter } = require('./routes/blog-pages');
const { adminRouter } = require('./admin');
const { verifyMail } = require('./mailer');
const plansStore = require('./plans-store');
const { plans: pricingPlans, list: planList } = plansStore;

const PORT = Number(process.env.PORT) || 5065;

const app = express();

// Behind nginx on the live server, so req.ip is the visitor rather than the
// proxy — the form rate limiter depends on that being true.
app.set('trust proxy', 1);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));

app.use(compression());
// 1 MB rather than 256 KB: a blog post body is a form field, and the editor
// caps it at 200 KB of HTML, which a 256 KB limit clips once images are pasted
// in as data URIs. File uploads do not come through here — multer streams
// multipart bodies to disk itself.
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

/**
 * A small set of headers the PHP site sent none of.
 * No CSP: the pages load jQuery, Owl Carousel, Font Awesome, PayPal
 * and Stripe from five different origins, and a policy written blind would
 * break the site rather than protect it. Worth doing deliberately, separately.
 */
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // HSTS, but only on a request that actually arrived over TLS: sending it over
  // plain http is ignored by browsers by design, and sending it from a local
  // dev server would pin localhost to https in your browser for a year.
  if (req.secure) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

/**
 * The origin to build absolute URLs from — og:image, og:url, canonical.
 *
 * Configured SITE_URL wins, because it is the canonical domain and the site
 * answers on two (vesopaepos.co.uk should point every share and every canonical
 * tag at the .com, not at whichever host the visitor happened to type).
 *
 * But it only wins if it names a host the outside world can reach. The live
 * server was deployed with SITE_URL still set to http://localhost:5065, which
 * every page then printed into its og:image and og:url. That is why link
 * previews stopped working: WhatsApp, Twitter and Facebook fetch og:image from
 * their own servers, and localhost there is *their* machine, so the fetch fails
 * and the preview falls back to a bare link. The tags were correct; the host in
 * them was unreachable.
 *
 * Falling back to the request's own origin means a missed environment variable
 * costs the canonical-domain preference and nothing else. Behind nginx that
 * needs X-Forwarded-Proto, which `trust proxy` above already honours — without
 * it every URL would come out http:// and Twitter rejects mixed-content images.
 */
const CONFIGURED_ORIGIN = (() => {
  try {
    const { hostname, origin } = new URL(config.SITE_URL);
    const local = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
    if (local) {
      console.warn(
        `[config] SITE_URL is ${config.SITE_URL}. Absolute URLs (link previews, ` +
          'canonical tags, sitemap) will use the incoming request host instead. ' +
          'Set SITE_URL=https://vesopaepos.com in .env on the live server.'
      );
      return null;
    }
    return origin;
  } catch {
    console.warn(`[config] SITE_URL is not a valid URL: ${config.SITE_URL}`);
    return null;
  }
})();

function originFor(req) {
  return CONFIGURED_ORIGIN || `${req.protocol}://${req.get('host')}`;
}

// Values every template can reach without each route passing them along.
app.use((req, res, next) => {
  res.locals.SITE_URL = originFor(req);
  res.locals.BACKOFFICE_URL = config.BACKOFFICE_URL;
  res.locals.CONTACT = config.CONTACT;
  res.locals.BRAND = config.BRAND;
  // Both shapes: PLANS is the ordered list the pricing cards iterate,
  // PRICING_PLANS is the keyed-by-term map the checkout page still indexes into.
  res.locals.PLANS = planList();
  res.locals.PRICING_PLANS = pricingPlans();
  res.locals.money = config.money;
  res.locals.APP_VERSION = config.APP_VERSION;

  /*
   * Each page is its own canonical and its own og:url by default.
   *
   * The header partial fell back to the site root for both, so /pricing,
   * /download and every blog post advertised themselves as copies of the home
   * page — which is an instruction to Google to drop them from the index, and
   * the reason a shared link to any inner page previewed as the home page.
   *
   * req.path, not originalUrl: the query string is where tracking parameters
   * live, and a canonical that varies per campaign is not a canonical. Pages
   * where a parameter genuinely selects different content (/checkout?period=)
   * pass their own ogUrl.
   *
   * Trailing slashes normalised so /pricing and /pricing/ agree on one address.
   */
  res.locals.ogUrl = req.path.length > 1 ? req.path.replace(/\/+$/, '') : '/';

  // The header shows "BackOffice" for everyone. The PHP swapped it for
  // "MyAccount" based on a cookie set by a login endpoint that no longer
  // exists — the back office is its own app on its own subdomain now.
  res.locals.accountUrl = config.BACKOFFICE_URL;
  res.locals.accountLabel = 'BackOffice';
  next();
});

app.get('/health', (_req, res) => res.json({ ok: true }));

/**
 * Installers, before the general static mount so these headers win.
 *
 * Content-Disposition: attachment states outright that the response is a file
 * to save. Without it the browser decides from the content type, and the
 * default for .exe — application/x-msdos-program — is a legacy type that some
 * scanners and proxies treat with more suspicion than a plain binary stream.
 *
 * To be straight about the limits of this: it does not stop Chrome or
 * SmartScreen warning about the installer. That warning is about the *file*,
 * not the response — VesopaEPOS Installer.exe carries no Authenticode
 * signature, and an unsigned executable from a domain with no download history
 * is exactly what those warnings exist to flag. No header fixes that; a
 * code-signing certificate does. The Microsoft Store build is signed and is
 * why /download offers it first.
 */
app.use(
  '/app',
  express.static(path.join(__dirname, '..', 'public', 'app'), {
    maxAge: '1d',
    index: false,
    setHeaders(res, filePath) {
      const name = path.basename(filePath);
      // Both forms: the quoted one for older clients, filename* (RFC 5987) so
      // spaces and any non-ASCII survive intact. "Vesopa EPOS.apk" would
      // otherwise arrive as "Vesopa" on a strict client.
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${name.replace(/["\\]/g, '')}"; ` +
          `filename*=UTF-8''${encodeURIComponent(name)}`
      );
      res.setHeader('Content-Type', 'application/octet-stream');
    },
  })
);

// Long cache for fingerprint-free assets is wrong (a logo swap would take a
// year to reach anyone), so: a day, revalidated.
app.use(
  express.static(path.join(__dirname, '..', 'public'), {
    maxAge: '1d',
    etag: true,
    // /pricing must never be shadowed by a stray pricing.html.
    extensions: false,
    index: false,
  })
);

app.use('/api/paypal', checkoutApiRouter);
app.use('/admin', adminRouter);
app.use('/', formsRouter);
app.use('/', blogPagesRouter);
app.use('/', pagesRouter);

// ---- 404 ------------------------------------------------------------------

app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.status(404).render('error', {
    title: 'Vesopa EPOS | Page Not Found',
    heading: 'Page Not Found',
    brief:
      "We couldn't find the page you were looking for. It may have moved, or the link may be out of date. Try the <a href=\"/\">home page</a>, or <a href=\"/help\">contact support</a> and we'll point you the right way.",
  });
});

// ---- Errors ---------------------------------------------------------------

app.use((err, req, res, _next) => {
  console.error('[error]', req.method, req.originalUrl, err);
  if (res.headersSent) return;

  if (req.path.startsWith('/api/')) {
    return res.status(500).json({ error: 'Something went wrong' });
  }
  // Deliberately vague. The PHP printed the raw MySQL error, and the support
  // phone number, straight into the page on any database failure.
  res.status(500).render('error', {
    title: 'Vesopa EPOS | Something Went Wrong',
    heading: 'Something Went Wrong',
    brief:
      'Sorry — we hit a problem handling that. Please try again in a moment, or <a href="/help">contact support</a> if it keeps happening.',
  });
});

app.listen(PORT, () => {
  console.log(`vesopaepos.com listening on http://localhost:${PORT}`);
  // Not awaited: the site serves fine without mail, and the result is a log
  // line rather than something a request path depends on.
  verifyMail();
  // Loads the pricing table from web_plans and keeps it fresh. Until the first
  // load returns, the hardcoded table in config.js is what renders — so a slow
  // database at boot delays correct prices rather than serving none.
  plansStore.start();
});
