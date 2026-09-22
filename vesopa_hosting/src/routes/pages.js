/**
 * Public marketing pages.
 *
 * Everything here is readable signed-out and safe to cache. Anything that needs
 * a customer lives under /panel.
 */

const express = require('express');
const db = require('../db');
const pricing = require('../pricing');
// Not `catalogue` — the home route already binds that name to the priced
// product catalogue, and a module shadowed by a local in one route and not in
// the next is a bug waiting for whoever edits this file next.
const domainCatalogue = require('../domain-catalogue');
const { sendMail, shell, detailTable, escapeHtml, DEFAULT_TO } = require('../mailer');
const { checkCsrf } = require('../auth');
const { flash, rateLimited } = require('../http-utils');
const currency = require('../currency');
const cart = require('./cart');
const i18n = require('../i18n');
const { SITE_URL, CONTACT } = require('../config');

const router = express.Router();

/**
 * The meta descriptions on these pages quote a price, and a quoted price has to
 * be the real one — in the currency the reader is being shown.
 *
 * They used to be string literals with "£2.99" typed into them. That was wrong
 * twice over: it went stale the first time anyone edited the catalogue, and in
 * three currencies it would have promised an American a sterling price they
 * were never going to see on the page they landed on.
 */
function cheapest(rows, months = [36, 12, 1]) {
  const figures = rows
    .map((p) => months.map((m) => p.perMonthPence[m]).find((v) => v > 0))
    .filter((v) => v > 0);
  return figures.length ? Math.min(...figures) : 0;
}

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------
router.get('/', async (req, res, next) => {
  try {
    const [catalogue, featured, terms, settings] = await Promise.all([
      pricing.load({ cur: req.currency }),
      pricing.featuredTlds(6, req.currency),
      pricing.termsWithSavings(req.currency),
      db.settings(),
    ]);
    res.render('public/index', {
      title: null, // the default title is the marketing one
      description: req.t('Fast UK web hosting, domain names, business email and free SSL from Vesopa. One clear control panel, no cPanel to learn, and a free domain on every yearly plan.'),
      plans: catalogue.plans,
      businessEmail: catalogue.businessEmail,
      marketingEmail: catalogue.marketingEmail,
      // The cheapest per-month figure anywhere in the catalogue, for the
      // "from £x/mo" lines. Computed here so three templates cannot each
      // arrive at a slightly different number.
      fromPrice: currency.format(cheapest(catalogue.plans), req.currency),
      featuredTlds: featured,
      terms,
      // The guarantee is quoted in the hero, so it comes from the setting that
      // owns it rather than being typed into the markup a second time.
      moneyBackDays: Number(settings.money_back_days || 30),
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Hosting
// ---------------------------------------------------------------------------
router.get('/hosting', async (req, res, next) => {
  try {
    const [{ plans }, terms] = await Promise.all([
      pricing.load({ cur: req.currency }),
      pricing.termsWithSavings(req.currency),
    ]);
    res.render('public/hosting', {
      title: req.t('Web hosting'),
      description: req.t(
        'UK shared hosting on NVMe storage, with free SSL, daily backups and email included. Plans from {price} a month.',
        { price: currency.format(cheapest(plans), req.currency) },
      ),
      plans,
      terms,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Email — its own product line, its own page.
// ---------------------------------------------------------------------------
router.get('/email', async (req, res, next) => {
  try {
    const { businessEmail, marketingEmail } = await pricing.load({ cur: req.currency });
    const fmt = (minor) => currency.format(minor, req.currency);
    res.render('public/email', {
      title: req.t('Business and marketing email'),
      description: req.t(
        'Email at your own domain from {mailbox} a mailbox, and marketing campaigns from {campaign} a month. UK hosted, properly authenticated, no per-seat surprises.',
        { mailbox: fmt(cheapest(businessEmail, [12, 1])), campaign: fmt(cheapest(marketingEmail, [12, 1])) },
      ),
      businessEmail,
      marketingEmail,
      emailTerms: pricing.EMAIL_TERMS,
    });
  } catch (err) {
    next(err);
  }
});

/*
 * The domain pages moved to routes/domains.js.
 *
 * There are five of them now — search, the catalogue browser, a page per
 * category and a page per extension — and they share a filter parser and a
 * render helper. Left here they would have been half of this file.
 */

// ---------------------------------------------------------------------------
// SSL, migration, support, about
// ---------------------------------------------------------------------------
router.get('/ssl', (req, res) => {
  res.render('public/ssl', {
    title: req.t('SSL certificates'),
    description: req.t('Free SSL on every Vesopa site, issued and renewed automatically. Nothing to install and nothing to pay.'),
  });
});

/*
 * The offers page: what is on now, and the codes that claim it.
 *
 * ONLY CODES MARKED `public_offer` ARE LISTED, and that column defaults to 0.
 * The database already held PROMO100 -- 100% off everything, no use limit, no
 * expiry -- so a page built the obvious way, listing every active coupon,
 * would have published a code that gives the shop away. Advertising a code is
 * a decision somebody makes in the admin, one code at a time.
 *
 * A code restricted to a country is shown only to visitors in it, for the same
 * reason it is refused at the basket: offering something and then rejecting it
 * at checkout is worse than never having shown it.
 */
router.get('/offers', async (req, res, next) => {
  try {
    const country = String(req.country || '').toUpperCase();
    const rows = await db.query(
      `SELECT code, description, headline, headline_bn, description_bn,
              kind, value, applies_to, min_spend_pence,
              first_order_only, countries, starts_at, expires_at, max_uses, used,
              requires_tld, grants_plan_slug, grants_months
         FROM coupons
        WHERE active = 1
          AND public_offer = 1
          AND (starts_at IS NULL OR starts_at <= NOW())
          AND (expires_at IS NULL OR expires_at >= NOW())
          AND (max_uses = 0 OR used < max_uses)
        ORDER BY value DESC, id ASC`,
    );

    const mine = (row) => {
      const only = String(row.countries || '').split(',').map((c) => c.trim().toUpperCase()).filter(Boolean);
      return !only.length || only.includes(country);
    };

    /*
     * The advertised copy in the language being read.
     *
     * The furniture around it comes from the i18n catalogue, but these two are
     * free text an admin typed, so they need their own Bangla column. Falling
     * back to the English rather than to nothing: a headline in the wrong
     * language still sells the offer, and an empty one sells nothing.
     */
    const bn = res.locals.locale === 'bn';
    const say = (bangla, english) => (bn && String(bangla || '').trim() ? bangla : english);

    const offers = rows.filter(mine).map((row) => ({
      code: row.code,
      headline: say(row.headline_bn, row.headline || row.description),
      detail: say(row.description_bn, row.description),
      // A percentage reads the same in every currency; a fixed amount is a
      // base-currency figure and has to be converted like any other price.
      kind: row.kind,
      amount: row.kind === 'percent'
        ? `${Number(row.value)}%`
        : currency.format(currency.convert(Number(row.value), req.currency), req.currency),
      /*
       * A bundle's figure is what you PAY, so the card must not print "off"
       * after it — that would read as the whole bundle price coming off.
       */
      amountIsPrice: row.kind === 'bundle',
      grantsMonths: Number(row.grants_months) || 0,
      grantsPlan: String(row.grants_plan_slug || ''),
      requiresTld: String(row.requires_tld || ''),
      /*
       * The one-click path. A bundle is two specific things in a basket, and
       * asking a customer to assemble it from the wording is how an offer goes
       * unclaimed; this builds it for them. See /offers/:code/start.
       */
      startUrl: `/offers/${encodeURIComponent(row.code)}/start`,
      appliesTo: row.applies_to,
      firstOrderOnly: Boolean(row.first_order_only),
      minSpend: Number(row.min_spend_pence) > 0
        ? currency.format(currency.convert(Number(row.min_spend_pence), req.currency), req.currency)
        : '',
      endsAt: row.expires_at || null,
      forCountry: String(row.countries || '').trim(),
      left: Number(row.max_uses) > 0 ? Number(row.max_uses) - Number(row.used) : 0,
      /*
       * Which drawing goes with it. The artwork carries no figure -- the
       * discount is live HTML beside it -- so a change of percentage or an
       * expiry never leaves a picture saying something the price contradicts.
       */
      art: String(row.countries || '').toUpperCase().includes('BD')
        ? '/assets/img/offers/bangladesh.svg'
        : '/assets/img/offers/generic.svg',
    }));

    res.render('public/offers', {
      title: req.t('Offers and promo codes'),
      description: req.t('Current Vesopa offers: what is included, what it costs and the code that claims it.'),
      offers,
      country,
      inBangladesh: country === 'BD',
    });
  } catch (err) {
    next(err);
  }
});

router.get('/transfer', (req, res) => {
  res.render('public/migration', {
    title: req.t('Move your site to us'),
    description: req.t('Free website migration. We copy your site, database and email, you check it, then we switch it over.'),
  });
});

router.get('/support', (req, res) => {
  res.render('public/support', {
    title: req.t('Support'),
    description: req.t('Guides, status and a way to reach a person who can read a server log.'),
  });
});

router.get('/about', (req, res) => {
  res.render('public/about', {
    title: req.t('About'),
    description: req.t('Vesopa Cloud is run by Vesopa EPOS Ltd, a Welsh software company that has hosted its own systems since 2018.'),
  });
});

// ---------------------------------------------------------------------------
// Contact
// ---------------------------------------------------------------------------
router.get('/contact', (req, res) => {
  res.render('public/contact', {
    title: req.t('Contact us'),
    description: req.t('Talk to Vesopa Cloud about a plan, a migration or anything that is not working.'),
    values: {},
    errors: {},
  });
});

router.post('/contact', async (req, res, next) => {
  const values = {
    name: String(req.body.name || '').trim().slice(0, 120),
    email: String(req.body.email || '').trim().toLowerCase().slice(0, 190),
    phone: String(req.body.phone || '').trim().slice(0, 40),
    subject: String(req.body.subject || '').trim().slice(0, 190),
    message: String(req.body.message || '').trim().slice(0, 5000),
  };

  const errors = {};
  if (!values.name) errors.name = 'Please tell us your name.';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(values.email)) errors.email = 'That email address does not look right.';
  if (values.message.length < 10) errors.message = 'Please add a little more detail.';
  // A hidden field a person never sees and a bot always fills.
  if (req.body.website) errors.message = 'Something went wrong. Please try again.';
  if (!checkCsrf(req)) errors.message = 'Your session expired. Please try again.';
  if (rateLimited(req.ip, 'contact')) errors.message = 'Too many messages just now. Please try again shortly.';

  if (Object.keys(errors).length) {
    return res.status(400).render('public/contact', {
      title: req.t('Contact us'),
      values,
      errors,
    });
  }

  try {
    // Save first, mail second: the row is the record, and an SMTP timeout must
    // not lose an enquiry the customer was told we received.
    await db.query(
      `INSERT INTO enquiries (name, email, phone, subject, message, ip)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [values.name, values.email, values.phone, values.subject, values.message, req.ip || ''],
    );

    sendMail({
      to: DEFAULT_TO,
      replyTo: values.email,
      subject: `Hosting enquiry — ${values.subject || values.name}`,
      html: shell({
        title: req.t('New hosting enquiry'),
        bodyHtml:
          detailTable([
            ['Name', escapeHtml(values.name)],
            ['Email', `<a href="mailto:${escapeHtml(values.email)}">${escapeHtml(values.email)}</a>`],
            ['Phone', escapeHtml(values.phone) || '—'],
            ['Subject', escapeHtml(values.subject) || '—'],
          ]) +
          `<p style="margin:18px 0 0;font-size:14px;line-height:1.65;color:#111;white-space:pre-wrap">${escapeHtml(values.message)}</p>`,
      }),
    });

    sendMail({
      to: values.email,
      subject: 'We have your message — Vesopa Cloud',
      html: shell({
        title: `Thanks, ${escapeHtml(values.name.split(' ')[0])}`,
        intro: 'We have your message and someone will reply shortly — usually within one working day.',
        bodyHtml: `<p style="margin:0;font-size:14px;line-height:1.65;color:#4a4c41;white-space:pre-wrap">${escapeHtml(values.message)}</p>`,
        footNote: `If it is urgent, call <b>${CONTACT.phone}</b>.`,
      }),
    });

    flash(res, req.t('Thanks — we have your message and will reply shortly.'));
    res.redirect('/contact');
  } catch (err) {
    next(err);
  }
});

/**
 * Claim an offer in one click.
 *
 * A bundle is a price for a SET — "a .site and a month of hosting, 381 taka" —
 * and the basket only reaches that price when both halves are in it. Leaving a
 * customer to work that out from the card's wording is how an advertised offer
 * goes unclaimed: they add the domain, the code says it needs a plan too, and
 * they give up. So this puts the hosting half in, remembers the code, and
 * drops them on the domain search to choose the name, which is the only part
 * only they can do.
 *
 * It grants nothing by itself. The coupon is still evaluated on every basket
 * price and again inside the checkout transaction, so a code that is expired,
 * country-locked or fully redeemed refuses here exactly as it would if it had
 * been typed by hand.
 */
router.get('/offers/:code/start', async (req, res, next) => {
  try {
    const code = String(req.params.code || '').trim().toUpperCase().slice(0, 40);
    const row = await db.one(
      `SELECT * FROM coupons
        WHERE code = ? AND active = 1 AND public_offer = 1
          AND (starts_at IS NULL OR starts_at <= NOW())
          AND (expires_at IS NULL OR expires_at >= NOW())
          AND (max_uses = 0 OR used < max_uses)
        LIMIT 1`,
      [code],
    );
    // An offer that has ended is not an error page: it is the offers page,
    // which will say what IS on.
    if (!row) return res.redirect('/offers');

    const only = String(row.countries || '').split(',').map((c) => c.trim().toUpperCase()).filter(Boolean);
    if (only.length && !only.includes(String(req.country || '').toUpperCase())) {
      return res.redirect('/offers');
    }


    /*
     * Put the granted plan in the basket at the granted term, so the only
     * thing left is the name. Nothing is added for a code that grants no
     * trial — an ordinary percentage code needs no particular basket.
     */
    const months = Number(row.grants_months) || 0;
    const slug = String(row.grants_plan_slug || '').trim();
    const plan = months > 0 && slug
      ? await db.one('SELECT slug FROM plans WHERE slug = ? AND active = 1 LIMIT 1', [slug])
      : null;
    cart.startOffer(req, res, {
      code,
      planSlug: plan ? plan.slug : '',
      months: plan ? months : 0,
    });

    const tld = String(row.requires_tld || '').trim().toLowerCase();
    return res.redirect(tld ? `/domains?tld=${encodeURIComponent(tld)}` : '/domains');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// robots / sitemap
// ---------------------------------------------------------------------------
router.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(
    ['User-agent: *',
      'Disallow: /panel/',
      'Disallow: /admin/',
      'Disallow: /cart/',
      // The two switchers. Both are redirects that set a cookie and send the
      // crawler back where it came from, so following them indexes nothing and
      // multiplies every page by the number of currencies and languages. The
      // links are rel="nofollow" too; this is the half that also covers a
      // crawler that found the URL somewhere else.
      'Disallow: /lang/',
      'Disallow: /currency/',
      '', `Sitemap: ${SITE_URL}/sitemap.xml`].join('\n'),
  );
});

/**
 * The sitemap now carries the domain catalogue.
 *
 * A page per extension is roughly seven hundred URLs, which is a large sitemap
 * for a site this size and exactly the right one: each of those pages answers a
 * real query ("how much is a .agency domain") with its own price, its own
 * renewal figure and its own FAQ. They are the SEO reason the per-extension
 * route exists at all, and a page a crawler is never told about is a page that
 * may as well not.
 *
 * Only sellable extensions go in. Listing a URL that returns 404 — which is
 * what /domains/tld/ai does, because we cannot register one — teaches the
 * crawler to trust the file less.
 *
 * Priority is set rather than left off: without it every URL is equal and the
 * homepage competes with .abogado.
 *
 * EVERY PAGE IS LISTED ONCE PER LANGUAGE, and each entry names the others.
 *
 * Google's rule is that hreflang has to be reciprocal: /hosting must point at
 * /bn/hosting and /bn/hosting must point back, or the pair is ignored and the
 * two are judged as two sites with the same content. The <head> does that for
 * anybody who fetches the page (views/partials/head.ejs), and this does it for
 * the crawler that has only read the sitemap — which is how a page that has
 * never been crawled gets its Bangla twin discovered at the same time.
 *
 * x-default is the English URL: it is what somebody whose language we do not
 * publish should land on.
 */
router.get('/sitemap.xml', async (req, res, next) => {
  try {
    const core = ['/', '/hosting', '/email', '/domains', '/domains/pricing', '/domains/transfer',
      '/ssl', '/transfer', '/build', '/support', '/about', '/contact', '/terms', '/privacy', '/aup', '/refunds'];
    const { tlds } = await pricing.load();
    const counts = await domainCatalogue.categoryCounts();

    const langs = Object.values(i18n.LOCALES);

    /*
     * One <url> per language per page. The alternates block is identical in
     * each of them, which is what "reciprocal" means here and why it is built
     * once per path rather than once per entry.
     */
    const entry = (path, priority, freq = 'weekly') => {
      const alts = i18n.alternates(SITE_URL, path)
        .map((a) => `    <xhtml:link rel="alternate" hreflang="${a.hreflang}" href="${escapeHtml(a.href)}"/>`)
        .join('\n');
      return langs.map((info) => (
        `  <url>\n    <loc>${escapeHtml(SITE_URL + i18n.localizePath(path, info.code))}</loc>\n`
        + `${alts}${alts ? '\n' : ''}`
        + `    <changefreq>${freq}</changefreq><priority>${priority}</priority>\n  </url>`
      )).join('\n');
    };

    const urls = [
      ...core.map((p) => entry(p, p === '/' ? '1.0' : '0.8')),
      ...counts.map((c) => entry(`/domains/category/${c.slug}`, '0.7')),
      ...tlds
        .filter((t) => t.active && t.register_pence > 0)
        .map((t) => entry(`/domains/tld/${encodeURIComponent(t.tld)}`, t.featured ? '0.7' : '0.5', 'monthly')),
    ].join('\n');

    res
      .type('application/xml')
      .send('<?xml version="1.0" encoding="UTF-8"?>\n'
        + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"'
        + ' xmlns:xhtml="http://www.w3.org/1999/xhtml">\n'
        + `${urls}\n</urlset>`);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
