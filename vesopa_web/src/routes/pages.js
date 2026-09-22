/**
 * The public marketing pages.
 *
 * URLs match what the PHP site served through its .htaccess extension-stripping
 * rewrite (/pricing, /help, …), so existing links and search results keep
 * working. The old `.php` URLs redirect rather than 404, for anything still
 * pointing at them.
 */

const express = require('express');
const { pool } = require('../db');
const { filesFor } = require('../admin/files');
const { bytes, formatDate, isoDateTime } = require('../admin/util');
const { plans: pricingPlans, list: planList, resolvePeriod } = require('../plans-store');
const { clientId: paypalClientId, IS_LIVE: paypalIsLive } = require('../paypal');
const { isConfigured: stripeConfigured } = require('../stripe');
const { findPaymentByReference } = require('../payments');

const router = express.Router();

/** Simple content pages: one route, one template, one <title>. */
const STATIC_PAGES = [
  ['/pricing', 'pricing', 'Vesopa EPOS Pricing: Purchase with Paypal, Card, or Bitcoin'],
  ['/about', 'about', 'Vesopa EPOS | About Us'],
  ['/help', 'help', 'Vesopa EPOS | Need Support? Contact Us'],
  ['/training', 'training', 'Vesopa EPOS | Book Training'],
  ['/career', 'career', 'Vesopa EPOS | Career With Vesopa Limited'],
  ['/privacy', 'privacy', 'Vesopa EPOS | Privacy Policy'],
  ['/terms', 'terms', 'Vesopa EPOS | Terms and Conditions'],
  ['/refund', 'refund', 'Vesopa EPOS | Refund Policy'],
  ['/cookies', 'cookies', 'Vesopa EPOS | Cookie Policy'],
];

for (const [path, view, title] of STATIC_PAGES) {
  router.get(path, (_req, res) => res.render(view, { title, extraFiles: [], bytes }));
}

/**
 * The home page, which carries the three most recent posts.
 *
 * Out of STATIC_PAGES for the same reason /download is: Express takes the first
 * matching route, so a duplicate there would shadow this one and the section
 * would render empty forever.
 *
 * The query mirrors the visibility rule in src/routes/blog-pages.js — a
 * scheduled post must not leak onto the home page before its date.
 */
router.get('/', async (_req, res) => {
  let latestPosts = [];
  try {
    const [rows] = await pool.query(
      `SELECT slug, title, kind, excerpt, cover_url, published_at
       FROM blog_posts
       WHERE status = 'published' AND COALESCE(published_at, created_at) <= NOW()
       ORDER BY published_at DESC, id DESC
       LIMIT 3`
    );
    latestPosts = rows;
  } catch (e) {
    // The home page is the last thing that should 500 over a blog query. The
    // section is skipped when the list is empty, so this costs three cards.
    console.error('[home] could not list posts:', e.message);
  }

  res.render('index', {
    title: 'VESOPA | Epos Wales | 1 High Street, Pontarddulais, Swansea, UK',
    extraFiles: [],
    latestPosts,
    bytes,
    formatDate,
    isoDateTime,
  });
});

/**
 * /download also lists whatever the admin attached to it in the file manager.
 *
 * Kept out of STATIC_PAGES rather than registered after it: Express takes the
 * first matching route, so a duplicate there would shadow this one and the
 * attachments would never render.
 */
router.get('/download', async (_req, res) => {
  let extraFiles = [];
  try {
    extraFiles = await filesFor('download');
  } catch (e) {
    // The page's own buttons are hardcoded, so a database problem costs the
    // extras and nothing else. Far better than 500-ing the download page.
    console.error('[download] could not list attached files:', e.message);
  }
  res.render('download', {
    title: 'Download Vesopa EPOS for Windows | Vesopa Kitchen',
    extraFiles,
    bytes,
  });
});

/**
 * Checkout for one of the three subscription periods.
 * An unrecognised ?period falls back to the popular 12-month plan rather than
 * erroring, which is what the PHP did.
 */
router.get('/checkout', (req, res) => {
  const period = resolvePeriod(req.query.period);
  const all = pricingPlans();

  /*
   * Upsell to the next longest term.
   *
   * This used to be the literal map { 1: '12', 12: '24' }, which stopped
   * meaning anything the moment plans became editable — adding a 3-month term
   * left it upselling a 1-month customer straight past it to the annual plan.
   * Derived from whatever terms actually exist instead.
   */
  const longer = planList()
    .filter((p) => p.period_months > Number(period))
    .sort((a, b) => a.period_months - b.period_months)[0];

  res.render('checkout', {
    title: 'Vesopa EPOS Checkout',
    // The period genuinely selects the page's content, so it belongs in the
    // canonical — unlike the query strings the default in server.js drops.
    ogUrl: `/checkout?period=${period}`,
    period,
    plan: all[period],
    upsell: longer ? { period: longer.period, plan: longer } : null,
    paypalClientId: paypalClientId(),
    // Whether the card / Apple Pay / Google Pay tiles are live or shown
    // greyed out. Computed from whether Stripe has a key, never typed — the
    // same rule the gateway list in vesopa_hosting follows.
    stripeEnabled: stripeConfigured(),
    /*
     * Sandbox PayPal takes no real money but still records a real, paid
     * subscription. Running that on a public site without saying so on the
     * page is how a customer believes they have bought something they have
     * not — and how anyone with a PayPal sandbox account gets a plan for
     * nothing, quietly. Said out loud instead.
     */
    paypalSandbox: Boolean(paypalClientId()) && !paypalIsLive,
  });
});

/** Receipt page a customer lands on after PayPal approves. */
router.get('/payment-status', async (req, res, next) => {
  const ref = String(req.query.ref || '');
  if (!ref) return res.redirect('/');

  try {
    const payment = await findPaymentByReference(ref);
    res.render('payment-status', {
      title: 'Vesopa EPOS | Payment Status',
      payment,
      statusMessage: payment
        ? ''
        : 'That reference does not match a completed payment. If you were charged, contact support and we will sort it out straight away.',
    });
  } catch (e) {
    next(e);
  }
});

// ---- robots.txt and sitemap.xml ------------------------------------------
//
// Generated rather than kept as static files: both were hardcoded to the old
// domain, so every URL in the sitemap pointed somewhere the site no longer
// lives, and the sitemap listed neither /training nor /career. Driving them off
// SITE_URL means a domain change can never strand them again.

// res.locals.SITE_URL rather than the imported config value: server.js falls
// back to the request's own origin when SITE_URL is unset or points at
// localhost, and a sitemap full of localhost URLs is worse than no sitemap.
router.get('/robots.txt', (_req, res) => {
  res.type('text/plain').send(
    ['User-agent: *', 'Disallow: /admin', '', `Sitemap: ${res.locals.SITE_URL}/sitemap.xml`, ''].join('\n')
  );
});

router.get('/sitemap.xml', async (_req, res, next) => {
  const SITE_URL = res.locals.SITE_URL;
  const pages = [
    ['/', '1.0'],
    ['/pricing', '0.9'],
    ['/help', '0.9'],
    ['/blog', '0.8'],
    ['/about', '0.7'],
    ['/download', '0.7'],
    ['/training', '0.6'],
    ['/career', '0.6'],
    ['/privacy', '0.4'],
    ['/terms', '0.4'],
    ['/refund', '0.4'],
    ['/cookies', '0.3'],
  ];

  // Checkout URLs come from the live plans, so a term added or retired in the
  // admin panel cannot leave the sitemap advertising a page that 404s or
  // omitting one that exists.
  for (const plan of planList()) {
    pages.push([`/checkout?period=${plan.period}`, '0.5']);
  }

  const today = new Date().toISOString().slice(0, 10);

  try {
    const [posts] = await pool.query(
      `SELECT slug, GREATEST(COALESCE(published_at, updated_at), updated_at) AS lastmod
       FROM blog_posts WHERE status = 'published'
       ORDER BY published_at DESC LIMIT 500`
    );
    for (const post of posts) {
      pages.push([`/blog/${post.slug}`, '0.6', new Date(post.lastmod).toISOString().slice(0, 10)]);
    }
  } catch (e) {
    // A sitemap missing the blog beats a 500 on /sitemap.xml.
    console.error('[sitemap] could not list posts:', e.message);
  }

  const urls = pages
    .map(
      ([loc, priority, lastmod]) =>
        `  <url>\n    <loc>${SITE_URL}${loc.replace(/&/g, '&amp;')}</loc>\n` +
        `    <lastmod>${lastmod || today}</lastmod>\n    <changefreq>monthly</changefreq>\n` +
        `    <priority>${priority}</priority>\n  </url>`
    )
    .join('\n');

  res.type('application/xml').send(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`
  );
});

/**
 * The PHP site's URLs, for anything still linking to them: bookmarks, old
 * emails, search results indexed before the rewrite existed.
 */
const LEGACY_REDIRECTS = {
  '/index.php': '/',
  '/index': '/',
  '/pricing.php': '/pricing',
  '/about.php': '/about',
  '/help.php': '/help',
  '/download.php': '/download',
  '/training.php': '/training',
  '/career.php': '/career',
  '/privacy.php': '/privacy',
  '/terms.php': '/terms',
  '/refund.php': '/refund',
  '/checkout.php': '/checkout',
  '/paypal/payment-status.php': '/payment-status',
};

for (const [from, to] of Object.entries(LEGACY_REDIRECTS)) {
  router.get(from, (req, res) => {
    const qs = req.originalUrl.includes('?') ? `?${req.originalUrl.split('?')[1]}` : '';
    res.redirect(301, to + qs);
  });
}

module.exports = { pagesRouter: router };
