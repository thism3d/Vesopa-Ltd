/**
 * Every public domain page.
 *
 * Lifted out of pages.js when the catalogue went from 23 extensions to 715 and
 * "domains" stopped being one page with a table on it.
 *
 * FOUR URLS, AND THE SPLIT BETWEEN THEM IS ABOUT SEARCH, NOT ABOUT CODE.
 *
 *   /domains                    the search box. One name, many extensions.
 *   /domains/pricing            the whole catalogue, filtered in place.
 *   /domains/category/:slug     one shelf, as its own indexable page.
 *   /domains/tld/:tld           one extension, as its own indexable page.
 *
 * The filters on /domains/pricing are query parameters and are deliberately NOT
 * canonical — ?band=under-5&sort=price is a view of a page, not a page, and
 * letting a crawler index four hundred permutations of the same table is how a
 * site earns a thin-content problem. The CATEGORY pages are the indexable cut,
 * one per shelf, each with its own heading and description, and each linked
 * from the browser. That is the whole reason the category is a path segment and
 * the band is a query string.
 */

const express = require('express');
const pricing = require('../pricing');
const catalogue = require('../domain-catalogue');
const registrar = require('../integrations/domainnameapi');
const currency = require('../currency');

const router = express.Router();

/** Read the filter state out of a query string, whatever nonsense is in it. */
function filtersFrom(query) {
  return {
    category: String(query.category || ''),
    band: String(query.band || ''),
    q: String(query.q || '').slice(0, 40),
    sort: String(query.sort || 'popular'),
    page: Number(query.page) || 1,
    promoOnly: query.promo === '1',
    featuredOnly: query.popular === '1',
  };
}

// ---------------------------------------------------------------------------
// The search box
// ---------------------------------------------------------------------------
router.get('/domains', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    const [featured, { tlds }] = await Promise.all([
      pricing.featuredTlds(8, req.currency),
      pricing.load({ cur: req.currency }),
    ]);

    // Server-render the first result set when the page is linked to with ?q=,
    // so a shared search works with JS disabled and the crawler sees content.
    let serverResults = null;
    if (q) {
      const { sld, tld } = registrar.splitDomain(q);
      const invalid = registrar.validateLabel(sld);
      if (!invalid) {
        const wanted = tld ? [tld] : [];
        const others = featured.map((t) => t.tld).filter((t) => t !== tld).slice(0, 6);
        const checks = await registrar.checkMany(sld, [...wanted, ...others]);
        serverResults = checks.map((r) => {
          const price = tlds.find((t) => t.tld === r.tld);
          return {
            ...r,
            sld,
            price_display: price ? currency.format(price.register_pence, req.currency) : '',
            sellable: Boolean(price && price.active),
          };
        });
      }
    }

    const fmt = (minor) => currency.format(minor, req.currency);
    const priceOf = (t) => tlds.find((row) => row.tld === t && row.active)?.register_pence;
    const quotes = [['.co.uk', priceOf('co.uk')], ['.com', priceOf('com')]]
      .filter(([, p]) => p > 0)
      .map(([name, p]) => `${name} from ${fmt(p)}`)
      .join(', ');

    res.render('public/domains', {
      title: 'Domain names',
      description:
        `Search and register a domain with Vesopa.${quotes ? ` ${quotes},` : ''} `
        + 'free WHOIS privacy and DNS included.',
      q,
      featuredTlds: featured,
      tlds: tlds.filter((t) => t.active),
      totalTlds: tlds.filter((t) => t.active && t.register_pence > 0).length,
      serverResults,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// The catalogue browser
// ---------------------------------------------------------------------------

/**
 * /domains/pricing and /domains/category/:slug render the SAME view.
 *
 * They differ only in what the heading says and which filter arrives locked. A
 * second template would be two templates to keep in step for the sake of an
 * <h1>, and the first divergence would be a filter that works on one and not
 * the other.
 */
async function renderBrowser(req, res, { category = null } = {}) {
  const filters = filtersFrom(req.query);
  if (category) filters.category = category.slug;

  const [view, counts, featured] = await Promise.all([
    catalogue.browse({ ...filters, cur: req.currency }),
    catalogue.categoryCounts(req.currency),
    pricing.featuredTlds(8, req.currency),
  ]);

  const cheapest = view.total
    ? (await catalogue.browse({ cur: req.currency, category: filters.category, sort: 'price', perPage: 1 })).rows[0]
    : null;

  res.render('public/domain-pricing', {
    title: category ? `${category.label} domain names` : 'Domain pricing',
    description: category
      ? `${category.blurb} ${view.total} extensions`
        + `${cheapest ? `, from ${cheapest.register_display} a year` : ''}. `
        + 'Register, renew and transfer prices side by side.'
      : `Every one of our ${view.total} domain extensions with its register, renew and `
        + 'transfer price side by side. No hidden renewal jumps, and filters for '
        + 'the cheap ones.',
    // The browser's own canonical rule: a filtered view points at the page it
    // is a view OF, so the crawler consolidates rather than splitting.
    canonical: category ? `/domains/category/${category.slug}` : '/domains/pricing',
    robots: view.page > 1 ? 'noindex, follow' : 'index, follow',
    category,
    ...view,
    categoryCounts: counts,
    featuredTlds: featured,
    cheapest,
  });
}

router.get('/domains/pricing', async (req, res, next) => {
  try {
    await renderBrowser(req, res);
  } catch (err) {
    next(err);
  }
});

router.get('/domains/category/:slug', async (req, res, next) => {
  try {
    const category = catalogue.CATEGORY_BY_SLUG[String(req.params.slug || '').toLowerCase()];
    // An unknown shelf is a 404, not a silent fall back to everything: a page
    // that quietly shows the whole catalogue under a heading nobody asked for
    // is how a typo becomes an indexed duplicate.
    if (!category) return next();
    await renderBrowser(req, res, { category });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// One extension, its own page
// ---------------------------------------------------------------------------
router.get('/domains/tld/:tld', async (req, res, next) => {
  try {
    const wanted = String(req.params.tld || '').toLowerCase().replace(/^\./, '');
    const row = await catalogue.findTld(wanted, req.currency);
    // Inactive as well as unknown. An extension we have stopped selling should
    // stop being a landing page rather than become one with no Add button.
    if (!row || !row.active || !row.register_pence) return next();

    const [related, category] = [
      await catalogue.relatedTo(row, req.currency),
      catalogue.CATEGORY_BY_SLUG[row.category] || null,
    ];

    res.render('public/domain-tld', {
      title: `.${row.tld} domain names`,
      description:
        `Register a .${row.tld} domain with Vesopa for ${row.register_display} a year`
        + `${row.promo ? `, renewing at ${row.renew_display}` : ''}. `
        + 'Free WHOIS privacy, full DNS control and no add-ons at the checkout.',
      canonical: `/domains/tld/${row.tld}`,
      tld: row,
      category,
      related,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/domains/transfer', (req, res) => {
  res.render('public/domain-transfer', {
    title: 'Transfer a domain',
    description: 'Move a domain to Vesopa. We add a year to whatever time is left, and DNS carries over unchanged.',
  });
});

module.exports = router;
