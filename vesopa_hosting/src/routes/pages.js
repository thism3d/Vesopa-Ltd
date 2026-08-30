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
      description:
        'Fast UK web hosting, domain names, business email and free SSL from Vesopa. One clear control panel, no cPanel to learn, and a free domain on every yearly plan.',
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
      title: 'Web hosting',
      description:
        'UK shared hosting on NVMe storage, with free SSL, daily backups and email included. '
        + `Plans from ${currency.format(cheapest(plans), req.currency)} a month.`,
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
      title: 'Business and marketing email',
      description:
        `Email at your own domain from ${fmt(cheapest(businessEmail, [12, 1]))} a mailbox, `
        + `and marketing campaigns from ${fmt(cheapest(marketingEmail, [12, 1]))} a month. `
        + 'UK hosted, properly authenticated, no per-seat surprises.',
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
    title: 'SSL certificates',
    description: 'Free SSL on every Vesopa site, issued and renewed automatically. Nothing to install and nothing to pay.',
  });
});

router.get('/transfer', (req, res) => {
  res.render('public/migration', {
    title: 'Move your site to us',
    description: 'Free website migration. We copy your site, database and email, you check it, then we switch it over.',
  });
});

router.get('/support', (req, res) => {
  res.render('public/support', {
    title: 'Support',
    description: 'Guides, status and a way to reach a person who can read a server log.',
  });
});

router.get('/about', (req, res) => {
  res.render('public/about', {
    title: 'About',
    description: 'Vesopa Cloud is run by Vesopa EPOS Ltd, a Welsh software company that has hosted its own systems since 2018.',
  });
});

// ---------------------------------------------------------------------------
// Contact
// ---------------------------------------------------------------------------
router.get('/contact', (req, res) => {
  res.render('public/contact', {
    title: 'Contact us',
    description: 'Talk to Vesopa Cloud about a plan, a migration or anything that is not working.',
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
      title: 'Contact us',
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
        title: 'New hosting enquiry',
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

    flash(res, 'Thanks — we have your message and will reply shortly.');
    res.redirect('/contact');
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// robots / sitemap
// ---------------------------------------------------------------------------
router.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(
    ['User-agent: *', 'Disallow: /panel/', 'Disallow: /admin/', 'Disallow: /cart/', '', `Sitemap: ${SITE_URL}/sitemap.xml`].join('\n'),
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
 */
router.get('/sitemap.xml', async (req, res, next) => {
  try {
    const core = ['/', '/hosting', '/email', '/domains', '/domains/pricing', '/domains/transfer',
      '/ssl', '/transfer', '/support', '/about', '/contact', '/terms', '/privacy', '/aup', '/refunds'];
    const { tlds } = await pricing.load();
    const counts = await domainCatalogue.categoryCounts();

    const entry = (path, priority, freq = 'weekly') =>
      `  <url><loc>${SITE_URL}${path}</loc><changefreq>${freq}</changefreq>`
      + `<priority>${priority}</priority></url>`;

    const urls = [
      ...core.map((p) => entry(p, p === '/' ? '1.0' : '0.8')),
      ...counts.map((c) => entry(`/domains/category/${c.slug}`, '0.7')),
      ...tlds
        .filter((t) => t.active && t.register_pence > 0)
        .map((t) => entry(`/domains/tld/${encodeURIComponent(t.tld)}`, t.featured ? '0.7' : '0.5', 'monthly')),
    ].join('\n');

    res
      .type('application/xml')
      .send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
