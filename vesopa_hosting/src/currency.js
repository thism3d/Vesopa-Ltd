/**
 * Multi-currency.
 *
 * ONE base price, three shop windows.
 *
 * The catalogue is priced once, in GBP, in the `*_pence` columns. Everything a
 * customer sees in dollars is that base run through a stored rate and a rounding
 * rule, unless an admin has typed an explicit override for that one field in
 * that one currency. Nothing on this site is priced twice by hand, because a
 * catalogue priced twice by hand is a catalogue where half the plans are wrong
 * within a month of the first price change.
 *
 * THE RATE IS STORED, NOT FETCHED. There is no FX feed here and that is a
 * decision, not an omission. A price that moves on its own cannot be quoted in
 * an email, screenshotted, cached, honoured after a support conversation, or
 * reconciled at the end of the month. An admin edits the rate when they decide
 * to and every price moves at that moment — visibly, on purpose, all at once.
 *
 * WHAT IS STORED ON AN ORDER. An order records its currency, the rate that
 * applied when it was placed, and its worth in the base currency at that rate.
 * Re-deriving any of those later from today's rate would rewrite history every
 * time somebody nudged a number.
 */

const db = require('./db');

/**
 * The minor unit is 100 for all three currencies we sell in, and the code
 * assumes it. If a zero-decimal currency (JPY) or a three-decimal one (KWD) is
 * ever added, this is the assumption to come back to — `amount / 100` is spread
 * across the formatter and the rounding rules.
 */
const MINOR = 100;

/**
 * Fallback catalogue, used only when the `currencies` table is empty — a fresh
 * database that has had schema.sql but not seed.sql, or a live install mid-way
 * through its first deploy. Without it the whole site 500s on the first request
 * for want of a price format, which is a bad way to find out the seed did not
 * run.
 */
const FALLBACK = [
  {
    code: 'GBP', name: 'British pound', symbol: '£', locale: 'en-GB',
    rate: 1, rounding: 'exact', vat_percent: 20, vat_label: 'VAT',
    countries: 'GB,IM,JE,GG', is_base: 1, is_default: 1, active: 1, sort_order: 1,
  },
];

let cache = null;
let cachedAt = 0;
const TTL_MS = 60_000;

function invalidate() {
  cache = null;
}

/** Normalise a row out of the database into the shape the rest of this uses. */
function shape(row) {
  return {
    code: String(row.code).toUpperCase(),
    name: row.name,
    symbol: row.symbol || '',
    locale: row.locale || 'en-GB',
    rate: Number(row.rate) || 1,
    rounding: row.rounding || 'exact',
    vat_percent: Number(row.vat_percent) || 0,
    vat_label: row.vat_label || '',
    countries: String(row.countries || '')
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
    is_base: !!row.is_base,
    is_default: !!row.is_default,
    active: !!row.active,
    sort_order: Number(row.sort_order) || 0,
  };
}

/**
 * The currency catalogue.
 *
 * `includeInactive` is for the admin, which has to be able to see and re-enable
 * a currency it has just switched off. Everything customer-facing takes the
 * default and gets active rows only.
 */
async function load({ fresh = false, includeInactive = false } = {}) {
  if (fresh || !cache || Date.now() - cachedAt > TTL_MS) {
    let rows = [];
    try {
      rows = await db.query('SELECT * FROM currencies ORDER BY sort_order, code');
    } catch (err) {
      // A missing table means schema.sql has not been re-run. Say so once and
      // carry on in sterling rather than taking the site down over it.
      console.error('[currency] could not read currencies:', err.message);
    }
    const all = (rows.length ? rows : FALLBACK).map(shape);

    const base = all.find((c) => c.is_base) || all[0];
    // A default that is switched off would strand every new visitor, so the
    // base is the backstop and the base is never allowed to be inactive.
    const fallbackDefault = all.find((c) => c.is_default && c.active) || base;

    cache = { all, base, default: fallbackDefault };
    cachedAt = Date.now();
  }

  if (includeInactive) return cache;
  const list = cache.all.filter((c) => c.active || c.code === cache.base.code);
  return { ...cache, all: list };
}

/** The base currency the catalogue is priced in. Sterling, here. */
async function base() {
  return (await load()).base;
}

/**
 * Look a code up. Falls back to the default currency rather than throwing, so
 * a stale cookie or a hand-typed URL cannot 500 a page.
 */
async function resolve(code) {
  const { all, default: def } = await load();
  const wanted = String(code || '').toUpperCase();
  return all.find((c) => c.code === wanted && c.active) || def;
}

/** Which currency should someone in this country see? */
async function forCountry(country) {
  const { all, default: def } = await load();
  const cc = String(country || '').toUpperCase();
  if (!cc) return def;
  return all.find((c) => c.active && c.countries.includes(cc)) || def;
}

// ---------------------------------------------------------------------------
// Rounding
// ---------------------------------------------------------------------------
/**
 * Turn a converted amount into a price a person would actually write.
 *
 * £5.99 at 1.27 is $7.6073. Nobody charges $7.61.
 *
 * TWO CHARM RULES, AND THE DIFFERENCE BETWEEN THEM MATTERS.
 *
 *   charm9   nearest 10 minor units, less one — 7.61 → 7.59
 *   charm99  nearest whole unit, less one     — 7.61 → 7.99
 *
 * `charm9` is the default for a reason. `charm99` has a granularity of a whole
 * unit, and on a cheap plan that is enormous: this catalogue's per-month ladder
 * runs 5.99 / 2.99 / 2.59 / 2.29 in sterling, and at 1.27 the last two rungs
 * BOTH round to $2.99 under charm99. The three-year term would have cost the
 * same per month as the two-year one and saved the customer nothing — a
 * "longer term, better price" ladder silently flattened by a rounding rule.
 * `charm9` keeps it as 7.59 / 3.79 / 3.29 / 2.89: still charm-priced, still
 * descending, still recognisable as the sterling ladder.
 *
 * Use `charm99` where prices are high enough that a unit is small change, or
 * where a round headline matters more than the rungs. The currencies screen
 * previews a real plan so the choice can be seen rather than guessed, and
 * flags a ladder that has collapsed.
 *
 * Zero is always zero. A free line that came out of here as -0.01 because a
 * charm rule subtracted a penny from nothing would be an alarming basket.
 */
function applyRounding(raw, rule) {
  const n = Number(raw) || 0;
  if (n <= 0) return 0;

  let out;
  switch (rule) {
    case 'charm9': out = Math.round(n / 10) * 10 - 1; break;
    case 'charm99': out = Math.round(n / MINOR) * MINOR - 1; break;
    case 'charm95': out = Math.round(n / MINOR) * MINOR - 5; break;
    case 'nearest50': out = Math.round(n / 50) * 50; break;
    case 'nearest100': out = Math.round(n / MINOR) * MINOR; break;
    default: out = Math.round(n);
  }

  // Charm rounding on a small enough amount lands on or below zero. A 4p amount
  // must not become -1p or free; the exact figure is the honest answer there.
  return out < 1 ? Math.round(n) : out;
}

/** The rules an admin may choose, and what each does to the same number. */
const ROUNDING_RULES = [
  ['charm9', 'Nearest .x9 — 7.61 becomes 7.59 (keeps a price ladder intact)'],
  ['charm99', 'Nearest .99 — 7.61 becomes 7.99 (round headlines, coarse steps)'],
  ['charm95', 'Nearest .95 — 7.61 becomes 7.95'],
  ['nearest50', 'Nearest half unit — 7.61 becomes 7.50'],
  ['nearest100', 'Whole units — 7.61 becomes 8.00'],
  ['exact', 'Exact — whatever the rate produces, to the penny'],
];
const ROUNDING_CODES = ROUNDING_RULES.map((r) => r[0]);

/**
 * Base-currency minor units to this currency's minor units.
 *
 * The base currency is returned untouched — not multiplied by 1.0 and rounded,
 * because a `charm99` rule left on the base row would otherwise quietly rewrite
 * every price an admin typed.
 *
 * `per` IS THE IMPORTANT PART, AND IT IS NOT AN OPTIMISATION.
 *
 * A twelve-month plan is sold as a total but SHOPPED as a per-month figure —
 * that is the number on the pricing card, and the number a buyer holds up
 * against a competitor. Rounding the total is what a naive conversion does, and
 * it produces this:
 *
 *     £35.88/yr × 1.27 = 45.57 → charm99 → $45.99/yr → $3.83 a month
 *
 * $45.99 is a fine-looking total and $3.83 is not a price anybody advertises.
 * Passing `per: 12` rounds the MONTHLY figure instead and multiplies back:
 *
 *     45.57 ÷ 12 = 3.80 → charm99 → $3.99 → $47.88/yr
 *
 * Both numbers now read like prices, the total is still exactly twelve times
 * the rate quoted, and the customer can do the arithmetic themselves and get
 * the same answer. That last part is what stops it being a trick.
 */
function convert(baseMinor, cur, { per = 1 } = {}) {
  const n = Number(baseMinor) || 0;
  if (!cur || cur.is_base) return n;
  if (n === 0) return 0;

  const raw = n * cur.rate;
  const months = Math.max(1, Number(per) || 1);
  if (months === 1) return applyRounding(raw, cur.rounding);
  return applyRounding(raw / months, cur.rounding) * months;
}

/** This currency's minor units back to the base. Used for reporting totals. */
function toBase(minor, cur) {
  const n = Number(minor) || 0;
  if (!cur || cur.is_base || !cur.rate) return n;
  return Math.round(n / cur.rate);
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------
/**
 * "£5.99", "$7.99", "CA$10.99".
 *
 * The symbol comes from our own column rather than from Intl's currency
 * formatting, because Intl renders CAD as "CA$" to an American and a bare "$"
 * to a Canadian. A price list may not be ambiguous about which dollar it means,
 * and the visitor's locale is not ours to guess from. Intl still does the
 * digit grouping, which is the part that genuinely varies.
 */
function format(minor, cur) {
  const c = cur || FALLBACK[0];
  const n = Number(minor || 0) / MINOR;
  const text = n.toLocaleString(c.locale || 'en-GB', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${c.symbol}${text}`;
}

/** Symbol and the two halves of the number, for the big pricing-table figures. */
function parts(minor, cur) {
  const c = cur || FALLBACK[0];
  const n = Number(minor || 0) / MINOR;
  const [whole, frac] = n.toFixed(2).split('.');
  return {
    symbol: c.symbol,
    whole: Number(whole).toLocaleString(c.locale || 'en-GB'),
    frac,
  };
}

// ---------------------------------------------------------------------------
// VAT
// ---------------------------------------------------------------------------
/**
 * VAT is INCLUDED in the price, never added — and it is per currency.
 *
 * A GBP price carries 20% UK VAT inside it. A USD or CAD price carries none,
 * because UK VAT is not chargeable on these services to a consumer outside the
 * UK; the row's `vat_percent` is 0 and no VAT line appears at all. That is the
 * correct treatment and it is also the only honest one — showing a UK VAT
 * figure to an American customer would be inventing a tax.
 *
 * The arithmetic on the inclusive side is the classic place to go wrong:
 *
 *     net = 59.88 ÷ 1.2 = 49.90
 *     VAT = 59.88 − 49.90 = 9.98        (NOT 59.88 × 0.20 = 11.98)
 *
 * The second figure overstates the VAT by a fifth on every single order.
 */
function vatIncludedIn(grossMinor, cur) {
  const pct = Number(cur?.vat_percent) || 0;
  if (!pct) return 0;
  const gross = Number(grossMinor || 0);
  const net = Math.round((gross * 100) / (100 + pct));
  return gross - net;
}

function netOf(grossMinor, cur) {
  return Number(grossMinor || 0) - vatIncludedIn(grossMinor, cur);
}

module.exports = {
  MINOR,
  ROUNDING_RULES,
  ROUNDING_CODES,
  load,
  invalidate,
  base,
  resolve,
  forCountry,
  applyRounding,
  convert,
  toBase,
  format,
  parts,
  vatIncludedIn,
  netOf,
};
