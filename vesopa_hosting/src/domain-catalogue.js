/**
 * Browsing eight hundred extensions.
 *
 * The catalogue went from 23 rows to 715 with the DomainNameAPI rate card, and
 * at that size a price table is not a page — it is a wall. Everything here
 * exists to turn it back into something a person can shop: a shelf to stand in
 * front of, a price ceiling to stay under, and a next page that arrives without
 * a reload.
 *
 * FILTERING HAPPENS IN JAVASCRIPT, NOT IN SQL, AND THAT IS DELIBERATE.
 *
 * `pricing.load()` already holds the whole catalogue in memory, converted into
 * the visitor's currency and cached per currency. Going back to the database to
 * filter it would mean either re-converting every row per request or filtering
 * on base-currency pence and then showing converted ones — and the moment those
 * two disagree, "under £5" starts listing a £5.40 domain to an American. The
 * band is applied to the SAME numbers the customer is about to read.
 *
 * 715 rows is nothing to filter in memory. It is a lot to send down a wire at
 * once, which is what the paging is for.
 */

const pricing = require('./pricing');
const currency = require('./currency');

/**
 * The shelves. Order is the order they appear in the filter bar, so it runs
 * roughly by how many people want each one rather than alphabetically.
 *
 * `slug` is in the URL and is therefore permanent: /domains/category/tech is a
 * page that can be linked to and indexed, and renaming a slug throws that away.
 * `label` is display text and can change freely.
 */
const CATEGORIES = [
  { slug: 'uk', label: 'UK', icon: 'flag',
    blurb: 'The extensions a British customer expects to see, and the ones that rank locally.' },
  { slug: 'business', label: 'Business', icon: 'briefcase',
    blurb: 'Company names, trading entities and professional services.' },
  { slug: 'tech', label: 'Tech & web', icon: 'code',
    blurb: 'For software, startups, and anything that ships.' },
  { slug: 'shop', label: 'Shops & retail', icon: 'cart',
    blurb: 'Say you are selling something before the page has even loaded.' },
  { slug: 'creative', label: 'Creative', icon: 'brush',
    blurb: 'Studios, portfolios, photographers and designers.' },
  { slug: 'media', label: 'Media', icon: 'play',
    blurb: 'News, blogs, video, broadcast and everything published.' },
  { slug: 'food', label: 'Food & drink', icon: 'cup',
    blurb: 'Restaurants, cafés, bars, breweries and producers.' },
  { slug: 'health', label: 'Health', icon: 'heart',
    blurb: 'Clinics, practitioners, fitness and wellbeing.' },
  { slug: 'finance', label: 'Money', icon: 'coins',
    blurb: 'Financial services, insurance, trading and payments.' },
  { slug: 'property', label: 'Property & trades', icon: 'home',
    blurb: 'Estate agents, builders, and every trade that turns up in a van.' },
  { slug: 'travel', label: 'Travel', icon: 'plane',
    blurb: 'Tourism, transport, hospitality and getting there.' },
  { slug: 'sport', label: 'Sport & games', icon: 'trophy',
    blurb: 'Clubs, teams, gaming and the outdoors.' },
  { slug: 'education', label: 'Education', icon: 'book',
    blurb: 'Schools, universities, courses and training.' },
  { slug: 'community', label: 'Community', icon: 'users',
    blurb: 'Charities, congregations, campaigns, families and causes.' },
  { slug: 'legal', label: 'Legal & careers', icon: 'scales',
    blurb: 'Law firms, recruiters and regulated professions.' },
  { slug: 'geo', label: 'Cities & regions', icon: 'pin',
    blurb: 'Say exactly where you are — and be found by people looking there.' },
  { slug: 'country', label: 'Country domains', icon: 'globe',
    blurb: 'National extensions from around the world.' },
  { slug: 'adult', label: 'Adult', icon: 'lock',
    blurb: 'Age-restricted extensions.' },
  { slug: 'other', label: 'Everything else', icon: 'dots',
    blurb: 'The rest of the catalogue.' },
];

const CATEGORY_BY_SLUG = Object.fromEntries(CATEGORIES.map((c) => [c.slug, c]));

/**
 * Price ceilings, in BASE-CURRENCY pence.
 *
 * The band a customer picks is "under £5", and it has to keep meaning that when
 * the page is in dollars. So the threshold is defined once in sterling and
 * converted per request, exactly like the free-domain cap — a band denominated
 * in the visitor's currency would quietly change which domains qualify every
 * time the rate moved.
 *
 * The labels are generated from the converted figure rather than typed, so a
 * dollar visitor is offered "under $6" and not "under £5".
 */
const BANDS = [
  { slug: 'under-2', maxBasePence: 200 },
  { slug: 'under-5', maxBasePence: 500 },
  { slug: 'under-10', maxBasePence: 1000 },
  { slug: 'under-25', maxBasePence: 2500 },
];

const SORTS = [
  { slug: 'popular', label: 'Most popular' },
  { slug: 'price', label: 'Cheapest first' },
  { slug: 'price-desc', label: 'Dearest first' },
  { slug: 'az', label: 'A to Z' },
];

const PER_PAGE = 60;

/**
 * A band, resolved into the currency being shown.
 *
 * Rounded to a whole unit for the LABEL only — "under $6.35" is not a filter
 * anybody wants to click — while the threshold itself stays exact so the label
 * never promises a ceiling the filter does not enforce.
 */
function bandsFor(cur) {
  return BANDS.map((b) => {
    const max = currency.convert(b.maxBasePence, cur);
    const whole = Math.ceil(max / currency.MINOR);
    return {
      ...b,
      max_minor: max,
      label: `Under ${cur.symbol}${whole}`,
    };
  });
}

/**
 * Is this extension's first year notably cheaper than its renewal?
 *
 * 1.6× is the line. Below it the gap is ordinary registry pricing; above it the
 * customer is being sold a first year that does not resemble the second, and
 * they should be told that on the card rather than at renewal. .online is
 * £1.59 then £26.99 — that is not a detail to bury.
 */
function isPromo(row) {
  return row.renew_pence > row.register_pence * 1.6;
}

/** Decorate one row with everything a card or a table cell needs. */
function decorate(row, cur) {
  const promo = isPromo(row);
  return {
    ...row,
    category: row.category || 'other',
    categoryLabel: CATEGORY_BY_SLUG[row.category]?.label || 'Everything else',
    promo,
    // The registrar's cost never leaves the server for a public page; margin is
    // an admin concern. Only what a customer pays is decorated here.
    register_display: currency.format(row.register_pence, cur),
    renew_display: currency.format(row.renew_pence, cur),
    transfer_display: currency.format(row.transfer_pence, cur),
    // Percent saved on the first year, for the promo ribbon. Rounded down so a
    // "94% off" badge is never generous with the truth.
    promo_percent: promo
      ? Math.floor(((row.renew_pence - row.register_pence) / row.renew_pence) * 100)
      : 0,
    href: `/domains/tld/${encodeURIComponent(row.tld)}`,
  };
}

/**
 * The filtered, sorted, paged catalogue.
 *
 * Returns the page AND the total, because an infinite scroll needs to know
 * whether to keep going and a heading needs to be able to say "312 extensions".
 */
async function browse({
  cur = null, category = '', band = '', q = '', sort = 'popular',
  page = 1, perPage = PER_PAGE, promoOnly = false, featuredOnly = false,
} = {}) {
  const money = cur || (await currency.base());
  const { tlds } = await pricing.load({ cur: money });

  const bands = bandsFor(money);
  const activeBand = bands.find((b) => b.slug === band) || null;
  const term = String(q || '').trim().toLowerCase().replace(/^\./, '');

  let rows = tlds.filter((t) => t.active && t.register_pence > 0);
  if (category && CATEGORY_BY_SLUG[category]) rows = rows.filter((t) => (t.category || 'other') === category);
  if (activeBand) rows = rows.filter((t) => t.register_pence <= activeBand.max_minor);
  if (term) rows = rows.filter((t) => t.tld.includes(term));
  if (featuredOnly) rows = rows.filter((t) => t.featured);
  if (promoOnly) rows = rows.filter(isPromo);

  const chosen = SORTS.find((s) => s.slug === sort) || SORTS[0];
  const collate = (a, b) => a.tld.localeCompare(b.tld);
  rows = [...rows].sort((a, b) => {
    if (chosen.slug === 'price') return a.register_pence - b.register_pence || collate(a, b);
    if (chosen.slug === 'price-desc') return b.register_pence - a.register_pence || collate(a, b);
    if (chosen.slug === 'az') return collate(a, b);
    // `popular` is the featured flag first, then the admin's own sort order,
    // which is how the 23 hand-curated extensions stay at the top of a list
    // they are now outnumbered thirty to one in.
    return b.featured - a.featured || a.sort_order - b.sort_order || collate(a, b);
  });

  const total = rows.length;
  const current = Math.max(1, Number(page) || 1);
  const start = (current - 1) * perPage;
  const slice = rows.slice(start, start + perPage);

  return {
    rows: slice.map((r) => decorate(r, money)),
    total,
    page: current,
    perPage,
    pages: Math.max(1, Math.ceil(total / perPage)),
    hasMore: start + slice.length < total,
    // Everything a filter bar needs to render itself, resolved for this
    // currency so no view has to convert anything.
    categories: CATEGORIES,
    bands,
    sorts: SORTS,
    filters: {
      category: CATEGORY_BY_SLUG[category] ? category : '',
      band: activeBand ? activeBand.slug : '',
      q: term,
      sort: chosen.slug,
      promoOnly: Boolean(promoOnly),
      featuredOnly: Boolean(featuredOnly),
    },
  };
}

/** One extension, decorated, or null. Used by the per-extension page. */
async function findTld(tld, cur = null) {
  const money = cur || (await currency.base());
  const { tlds } = await pricing.load({ cur: money });
  const wanted = String(tld || '').toLowerCase().replace(/^\./, '');
  const row = tlds.find((t) => t.tld === wanted);
  return row ? decorate(row, money) : null;
}

/**
 * Extensions to offer alongside one being looked at: same shelf, cheapest
 * first, never itself. Cheapest rather than "most similar" because the visitor
 * is on a page for an extension they may have found too expensive, and price is
 * the objection actually worth answering.
 */
async function relatedTo(row, cur = null, limit = 8) {
  const money = cur || (await currency.base());
  const { tlds } = await pricing.load({ cur: money });
  return tlds
    .filter((t) => t.active && t.register_pence > 0 && t.tld !== row.tld
      && (t.category || 'other') === (row.category || 'other'))
    .sort((a, b) => a.register_pence - b.register_pence)
    .slice(0, limit)
    .map((t) => decorate(t, money));
}

/** How many sellable extensions sit on each shelf, for the category index. */
async function categoryCounts(cur = null) {
  const money = cur || (await currency.base());
  const { tlds } = await pricing.load({ cur: money });
  const counts = {};
  const cheapest = {};
  for (const t of tlds) {
    if (!t.active || !t.register_pence) continue;
    const key = t.category || 'other';
    counts[key] = (counts[key] || 0) + 1;
    if (!cheapest[key] || t.register_pence < cheapest[key]) cheapest[key] = t.register_pence;
  }
  return CATEGORIES
    .map((c) => ({
      ...c,
      count: counts[c.slug] || 0,
      from_pence: cheapest[c.slug] || 0,
      from_display: cheapest[c.slug] ? currency.format(cheapest[c.slug], money) : '',
      href: `/domains/category/${c.slug}`,
    }))
    .filter((c) => c.count > 0);
}

module.exports = {
  CATEGORIES,
  CATEGORY_BY_SLUG,
  BANDS,
  SORTS,
  PER_PAGE,
  bandsFor,
  browse,
  findTld,
  relatedTo,
  categoryCounts,
  isPromo,
  decorate,
};
