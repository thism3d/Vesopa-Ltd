#!/usr/bin/env node
/**
 * Import the DomainNameAPI rate card into the `tlds` table.
 *
 *     node scripts/import-tlds.js            # add and refresh costs, keep sell prices
 *     node scripts/import-tlds.js --reprice  # ALSO rewrite sell prices from the tiers
 *     node scripts/import-tlds.js --dry      # print what it would do, write nothing
 *
 * THE ONE RULE THAT MATTERS: an extension already in the table keeps its sell
 * prices. Only `cost_pence` and `category` are refreshed.
 *
 * The 23 extensions seeded by hand — .com, .co.uk, .io and the rest — were
 * priced deliberately, and .com in particular is sold close to cost on purpose
 * because it is the number every comparison starts from. A rate-card import
 * that silently reflowed those through a markup formula would undo a pricing
 * decision nobody asked it to touch, and would do it again on every re-run.
 * `--reprice` is the way to say you meant it.
 *
 * COSTS ARE QUOTED TO US IN DOLLARS AND WE SELL IN POUNDS.
 *
 * The USD rate comes from the `currencies` table — the same number the shop
 * converts prices with — so a cost recorded here and a price shown to an
 * American cannot be based on two different rates. Re-run this after changing
 * that rate if you want the recorded margins to stay true.
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const db = require('../src/db');
const currency = require('../src/currency');

const RATE_CARD = path.join(__dirname, '..', 'data', 'dna-rate-card.csv');

/**
 * Turkish lira per pound.
 *
 * There is no TRY row in `currencies` because we do not sell in lira — this is
 * needed only to read a cost off the rate card, where the .tr extensions are
 * quoted in it. Every one of those is imported INACTIVE anyway (see below), so
 * an out-of-date figure here cannot mis-price anything a customer can buy. It
 * is a cost estimate for the admin, nothing more.
 */
const TRY_PER_GBP = Number(process.env.TRY_PER_GBP) || 44;

/**
 * Rows in the rate card that are not extensions.
 *
 * `testxxx1` is the registrar's own test entry, and the other two are typos
 * that made it into their price list — `commotorcycles` is `com`+`motorcycles`
 * run together, and `atakdomain-ga` is an internal marker. Importing them would
 * put three unsellable rows in the customer-facing catalogue for ever.
 */
const NOT_A_TLD = new Set(['testxxx1', 'atakdomain-ga', 'commotorcycles']);

/*
 * The markup ladder lives in src/tld-markup.js.
 *
 * The admin's "suggest prices" button applies the same function to whatever is
 * on screen, and a second copy here would drift the moment either was tuned.
 */
const { sellFrom } = require('../src/tld-markup');

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------
/**
 * ONE category per extension, never a tag list.
 *
 * The catalogue browser pages through a category with an infinite scroll, and a
 * .shop that was both `shop` and `business` would appear twice in the same
 * scroll — once on page 2 and again on page 7 — which reads as a bug rather
 * than as a rich taxonomy. Where an extension genuinely belongs to two shelves,
 * the more specific one wins: .pizza is `food`, not `business`.
 */
const CATEGORIES = [
  ['uk', 'UK', 'Domains for a British business — the extensions your customers expect to see.'],
  ['tech', 'Tech & web', 'For software, startups and anything that ships.'],
  ['business', 'Business', 'Company names, professional services and trading entities.'],
  ['shop', 'Shops & retail', 'Selling something? These say so before the page loads.'],
  ['creative', 'Creative', 'Studios, portfolios, photographers and designers.'],
  ['media', 'Media & publishing', 'News, blogs, video and broadcast.'],
  ['food', 'Food & drink', 'Restaurants, cafés, bars and producers.'],
  ['health', 'Health & wellbeing', 'Clinics, practitioners, fitness and beauty.'],
  ['finance', 'Money & finance', 'Financial services, insurance and trading.'],
  ['property', 'Property & trades', 'Estate agents, builders and the trades.'],
  ['travel', 'Travel & places', 'Tourism, transport and hospitality.'],
  ['sport', 'Sport & games', 'Clubs, teams, gaming and the outdoors.'],
  ['education', 'Education', 'Schools, courses, research and training.'],
  ['community', 'Community & causes', 'Charities, congregations, campaigns and families.'],
  ['legal', 'Legal & careers', 'Law firms, recruiters and professionals.'],
  ['geo', 'Cities & regions', 'Say exactly where you are.'],
  ['country', 'Country domains', 'National extensions from around the world.'],
  ['adult', 'Adult', 'Age-restricted extensions.'],
  ['other', 'Everything else', 'The rest of the catalogue.'],
];

/** Exact matches, checked before any rule. Longest-standing wins on conflict. */
const BY_TLD = {
  uk: ['uk', 'co.uk', 'org.uk', 'me.uk', 'wales', 'cymru', 'scot', 'london', 'uk.com', 'irish', 'ie'],
  tech: [
    'io', 'dev', 'app', 'tech', 'software', 'computer', 'digital', 'cloud', 'hosting', 'host',
    'network', 'systems', 'codes', 'email', 'site', 'online', 'website', 'click', 'link', 'wiki',
    'download', 'science', 'data', 'ai', 'com.ai', 'sh', 'ac', 'page', 'web', 'it.com', 'cyou',
    'domains', 'security', 'protection', 'tel', 'mobi', 'name', 'one', 'onl', 'xyz', 'top', 'space',
  ],
  business: [
    'com', 'net', 'biz', 'co', 'company', 'ltd', 'llc', 'inc', 'gmbh', 'srl', 'sarl', 'ltda',
    'enterprises', 'holdings', 'industries', 'international', 'global', 'agency', 'associates',
    'partners', 'ventures', 'consulting', 'management', 'solutions', 'services', 'works', 'group',
    'com.co', 'net.co', 'co.com', 'us.com', 'eu.com', 'de.com', 'br.com', 'cn.com', 'gr.com',
    'sa.com', 'ru.com', 'center', 'direct', 'plus', 'pro', 'aca.pro', 'vip', 'best', 'luxe',
    'luxury', 'ooo', 'trading', 'trade', 'market', 'markets', 'exchange', 'industries', 'com.de',
  ],
  shop: [
    'shop', 'store', 'shopping', 'sale', 'deals', 'discount', 'bargains', 'cheap', 'boutique',
    'gifts', 'gift', 'clothing', 'shoes', 'toys', 'coupons', 'qpon', 'kaufen', 'tienda', 'supply',
    'supplies', 'auction', 'bid', 'blackfriday', 'promo', 'diamonds', 'jewelry', 'watch', 'parts',
    'equipment', 'tools', 'furniture', 'flowers', 'wine', 'vodka', 'beer', 'delivery', 'menu',
  ],
  creative: [
    'design', 'studio', 'art', 'gallery', 'photography', 'photos', 'photo', 'pics', 'pictures',
    'graphics', 'ink', 'productions', 'tattoo', 'moda', 'style', 'fashion', 'makeup', 'archi',
    'audio', 'guitars', 'ninja', 'cool', 'guru', 'expert', 'how', 'soy', 'wang', 'moe', 'kim',
  ],
  media: [
    'news', 'press', 'blog', 'tv', 'live', 'stream', 'video', 'tube', 'show', 'movie', 'theater',
    'theatre', 'review', 'reviews', 'report', 'fm', 'media', 'band', 'music', 'observer', 'film',
    'radio', 'buzz', 'lol', 'wtf', 'fail', 'rip', 'exposed', 'gripe', 'sucks', 'feedback',
  ],
  food: [
    'pizza', 'restaurant', 'cafe', 'coffee', 'kitchen', 'recipes', 'food', 'bar', 'pub', 'catering',
    'farm', 'fish', 'organic', 'cooking', 'bio', 'garden',
  ],
  health: [
    'health', 'healthcare', 'clinic', 'dental', 'dentist', 'doctor', 'hospital', 'surgery', 'care',
    'fitness', 'yoga', 'rehab', 'vet', 'diet', 'spa', 'hiv', 'salon', 'beauty', 'skin', 'hair',
    'pet', 'dog', 'horse',
  ],
  finance: [
    'finance', 'financial', 'bank', 'capital', 'credit', 'creditcard', 'cash', 'money', 'fund',
    'investments', 'insure', 'tax', 'loan', 'loans', 'mortgage', 'forex', 'accountant',
    'accountants', 'broker', 'bet', 'casino', 'poker', 'bingo', 'lotto', 'versicherung', 'gold',
    'reit', 'ltd', 'llc',
  ],
  property: [
    'estate', 'properties', 'property', 'house', 'homes', 'apartments', 'condos', 'rentals', 'rent',
    'land', 'immo', 'immobilien', 'haus', 'maison', 'villas', 'casa', 'lease', 'forsale', 'build',
    'builders', 'construction', 'contractors', 'plumbing', 'repair', 'glass', 'lighting',
    'cleaning', 'engineering', 'engineer', 'solar', 'energy', 'storage', 'moving', 'realty',
  ],
  travel: [
    'travel', 'flights', 'cruises', 'tours', 'holiday', 'vacations', 'voyage', 'viajes', 'reise',
    'reisen', 'camp', 'limo', 'taxi', 'cab', 'guide', 'place', 'city', 'town', 'earth', 'world',
    'country', 'aero', 'auto', 'autos', 'car', 'cars', 'bike', 'boats', 'yachts', 'motorcycles',
    'tires', 'vin',
  ],
  sport: [
    'football', 'futbol', 'soccer', 'golf', 'hockey', 'tennis', 'ski', 'surf', 'run', 'team', 'fan',
    'fans', 'racing', 'rodeo', 'cricket', 'dance', 'fishing', 'games', 'game', 'juegos', 'win',
    'fit', 'party', 'club', 'hiphop', 'quest', 'fun', 'life', 'lifestyle', 'living',
  ],
  education: [
    'academy', 'college', 'university', 'school', 'education', 'degree', 'courses', 'study',
    'training', 'institute', 'schule', 'mba', 'shiksha', 'coach', 'tips', 'guide', 'directory',
  ],
  community: [
    'church', 'charity', 'foundation', 'ngo', 'ong', 'gives', 'giving', 'community', 'family',
    'social', 'chat', 'forum', 'love', 'dating', 'singles', 'wedding', 'baby', 'mom', 'memorial',
    'gay', 'lgbt', 'democrat', 'republican', 'vote', 'voting', 'voto', 'bible', 'faith', 'green',
    'coop', 'support', 'help', 'contact', 'vision', 'today', 'now', 'red', 'blue', 'black', 'pink',
    'rocks', 'uno', 'zone', 'cards', 'christmas', 'gratis', 'jetzt',
  ],
  legal: [
    'law', 'legal', 'lawyer', 'attorney', 'abogado', 'claims', 'jobs', 'careers', 'work', 'actor',
    'ceo', 'florist', 'navy', 'airforce', 'army', 'compare', 'money',
  ],
  geo: [
    'berlin', 'paris', 'nyc', 'vegas', 'miami', 'boston', 'tokyo', 'nagoya', 'yokohama', 'okinawa',
    'kyoto', 'amsterdam', 'brussels', 'wien', 'sydney', 'melbourne', 'quebec', 'istanbul', 'ist',
    'capetown', 'joburg', 'durban', 'hamburg', 'bayern', 'cologne', 'koeln', 'saarland', 'nrw',
    'tirol', 'frl', 'vlaanderen', 'swiss', 'africa', 'asia', 'eu', 'taipei', 'lat', 'kiwi', 'desi',
    'nagoya', 'la',
  ],
  adult: ['porn', 'adult', 'sex', 'sexy', 'xxx', 'cam', 'webcam', 'men'],
};

/** tld -> category, built once from the lists above. First list to claim wins. */
const CATEGORY_OF = (() => {
  const map = new Map();
  for (const [category, list] of Object.entries(BY_TLD)) {
    for (const tld of list) if (!map.has(tld)) map.set(tld, category);
  }
  return map;
})();

/**
 * Which shelf does this extension go on?
 *
 * The explicit map first, then the structural rules. A two-letter extension is
 * a country code by definition, and anything ending in one — com.au, co.za —
 * is that country's second level, however commercial the first label looks.
 */
function categorise(tld) {
  const named = CATEGORY_OF.get(tld);
  if (named) return named;

  const last = tld.split('.').pop();
  if (last.length === 2) return tld.endsWith('.uk') ? 'uk' : 'country';
  // .com.tr, .org.br and friends: a dotted extension whose tail is not a
  // two-letter code is rare enough to look at by hand, but treating it as a
  // country second level is right far more often than not.
  if (tld.includes('.')) return 'country';
  return 'other';
}

// ---------------------------------------------------------------------------
// The rate card
// ---------------------------------------------------------------------------
/** A price cell. "-" means the registrar does not offer that operation. */
function cell(value) {
  const text = String(value || '').trim();
  if (!text || text === '-') return null;
  const n = Number(text);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseCsv(text) {
  const [header, ...lines] = text.trim().split(/\r?\n/);
  const cols = header.split(',').map((c) => c.trim().toLowerCase());
  return lines
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(',');
      return Object.fromEntries(cols.map((c, i) => [c, parts[i]]));
    });
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const dry = args.has('--dry');
  const reprice = args.has('--reprice');

  const { all } = await currency.load({ fresh: true, includeInactive: true });
  const usd = all.find((c) => c.code === 'USD');
  if (!usd || !Number(usd.rate)) {
    console.error('No USD rate in the currencies table — run seed.sql first.');
    process.exit(1);
  }
  const usdPerGbp = Number(usd.rate);

  /** A rate-card figure, in its own currency, to pence sterling. */
  const toPence = (amount, code) => {
    if (amount === null) return 0;
    const perGbp = code === 'TRY' ? TRY_PER_GBP : usdPerGbp;
    return Math.round((amount / perGbp) * 100);
  };

  const rows = parseCsv(fs.readFileSync(RATE_CARD, 'utf8'));
  const existing = new Map(
    (await db.query('SELECT id, tld, register_pence, renew_pence, transfer_pence, featured, active FROM tlds'))
      .map((r) => [r.tld, r]),
  );

  const seen = new Set();
  const plan = [];
  const skipped = [];

  for (const row of rows) {
    const tld = String(row.tld || '').trim().toLowerCase().replace(/^\./, '');
    if (!tld) continue;

    if (NOT_A_TLD.has(tld)) {
      skipped.push([tld, 'not an extension']);
      continue;
    }
    /*
     * IDN extensions are skipped, not imported inactive.
     *
     * `机构` and `البحرين` need the whole name punycoded before it reaches the
     * registrar, and `validateLabel` in the registrar adapter accepts ASCII
     * only. A row in the catalogue for an extension the search box cannot
     * accept a name for is a dead end wearing a price tag.
     */
    if (!/^[a-z0-9.-]+$/.test(tld)) {
      skipped.push([tld, 'internationalised — needs punycode support']);
      continue;
    }
    // The rate card lists 机构 twice; a duplicate would otherwise be an upsert
    // fighting itself and the second row silently winning.
    if (seen.has(tld)) continue;
    seen.add(tld);

    const code = String(row.currency || 'USD').trim().toUpperCase();
    const costPence = toPence(cell(row.register), code);
    const renewCost = toPence(cell(row.renew), code) || costPence;
    const transferCost = toPence(cell(row.transfer), code) || costPence;

    /*
     * Sellable means we can REGISTER it. A row with a transfer price and no
     * register price — .ai and .gr are both like this — is imported so the cost
     * is on record and the admin can see it, but switched off: offering an Add
     * button for a name we cannot register is worse than not listing it.
     *
     * The .tr family comes in off too: every one of them needs a Turkish
     * presence or a trustee we do not currently buy, and the lira costs here
     * are an estimate at a rate nobody is maintaining.
     */
    const isTurkish = code === 'TRY' || tld === 'tr' || tld.endsWith('.tr');
    const active = costPence > 0 && !isTurkish ? 1 : 0;

    const prior = existing.get(tld);
    const keepPrices = prior && !reprice;

    plan.push({
      tld,
      id: prior ? prior.id : null,
      category: categorise(tld),
      cost_pence: costPence,
      register_pence: keepPrices ? prior.register_pence : sellFrom(costPence),
      renew_pence: keepPrices ? prior.renew_pence : sellFrom(renewCost),
      transfer_pence: keepPrices ? prior.transfer_pence : sellFrom(transferCost),
      // An extension already switched off by hand stays off. An admin who
      // deactivated .xxx did not do it by accident, and an import is not the
      // place to overrule them.
      active: prior ? (prior.active && active) : active,
      featured: prior ? prior.featured : 0,
      isNew: !prior,
      unsellable: !active,
    });
  }

  // ---- report -------------------------------------------------------------
  const created = plan.filter((p) => p.isNew).length;
  const updated = plan.length - created;
  const off = plan.filter((p) => p.unsellable).length;

  console.log(`\nRate card: ${rows.length} rows -> ${plan.length} extensions`);
  console.log(`  ${created} new, ${updated} already present${reprice ? ' (REPRICED)' : ' (sell prices untouched)'}`);
  console.log(`  ${off} imported inactive — no register price, or .tr`);
  if (skipped.length) {
    console.log(`  ${skipped.length} skipped: ${skipped.map(([t, why]) => `${t} (${why})`).join(', ')}`);
  }
  console.log(`  USD ${usdPerGbp}/GBP, TRY ${TRY_PER_GBP}/GBP\n`);

  const byCategory = {};
  for (const p of plan) byCategory[p.category] = (byCategory[p.category] || 0) + 1;
  console.log('  ' + Object.entries(byCategory)
    .sort((a, b) => b[1] - a[1])
    .map(([c, n]) => `${c} ${n}`)
    .join('   ') + '\n');

  /*
   * The whole reason cost is stored beside price: an extension we are selling
   * for less than we buy it.
   *
   * This is not hypothetical. The 23 hand-seeded rows were priced against
   * estimated costs, and the real rate card moves several of them — .co.uk was
   * estimated at £5.50 and actually costs £8.72, so a £6.99 sale loses £1.73
   * every time somebody takes it. The import will not quietly fix that, because
   * repricing a headline extension is a business decision. It says so instead,
   * loudly, every single run until someone deals with it.
   */
  const losses = plan
    .filter((p) => p.active && p.register_pence > 0 && p.register_pence < p.cost_pence)
    .sort((a, b) => (a.register_pence - a.cost_pence) - (b.register_pence - b.cost_pence));

  if (losses.length) {
    console.log(`  !! ${losses.length} extension(s) priced BELOW cost:`);
    for (const l of losses) {
      console.log(
        `     .${l.tld.padEnd(10)} sell £${(l.register_pence / 100).toFixed(2)}`
        + `  cost £${(l.cost_pence / 100).toFixed(2)}`
        + `  loses £${((l.cost_pence - l.register_pence) / 100).toFixed(2)} a sale`
        + `   (suggested £${(sellFrom(l.cost_pence) / 100).toFixed(2)})`,
      );
    }
    console.log('     Fix in Admin -> Domain pricing, or re-run with --reprice.\n');
  }

  const sample = ['xyz', 'com', 'io', 'shop', 'rich', 'co.uk'].map((t) => plan.find((p) => p.tld === t)).filter(Boolean);
  for (const s of sample) {
    console.log(
      `  .${s.tld.padEnd(8)} cost £${(s.cost_pence / 100).toFixed(2).padStart(8)}`
      + `  sell £${(s.register_pence / 100).toFixed(2).padStart(8)}`
      + `  renew £${(s.renew_pence / 100).toFixed(2).padStart(8)}`
      + `  ${s.category}${s.isNew ? '' : '  (kept)'}`,
    );
  }

  if (dry) {
    console.log('\n--dry: nothing written.\n');
    return;
  }

  // ---- write --------------------------------------------------------------
  /*
   * One statement per extension inside a single transaction. Eight hundred
   * round trips is a second or two on a local socket, and the alternative — a
   * generated multi-row INSERT — is a single 200KB statement that is unreadable
   * in a slow query log and impossible to bisect when one row is rejected.
   */
  let sort = 1000;
  await db.transaction(async (conn) => {
    for (const p of plan) {
      if (p.id) {
        await conn.query(
          `UPDATE tlds SET cost_pence=?, register_pence=?, renew_pence=?, transfer_pence=?,
                  category=?, active=? WHERE id=?`,
          [p.cost_pence, p.register_pence, p.renew_pence, p.transfer_pence, p.category, p.active, p.id],
        );
      } else {
        await conn.query(
          `INSERT INTO tlds
             (tld, register_pence, renew_pence, transfer_pence, cost_pence, category,
              featured, active, sort_order)
           VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
          [p.tld, p.register_pence, p.renew_pence, p.transfer_pence, p.cost_pence, p.category,
            p.active, (sort += 1)],
        );
      }
    }
  });

  console.log(`\nWritten. ${plan.length} extensions in the catalogue.\n`);
}

main()
  .catch((err) => {
    console.error('\nImport failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => db.pool.end());
