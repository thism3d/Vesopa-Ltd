/**
 * Reads the catalogue, converts it into the currency the request is in, and
 * decorates it for display.
 *
 * TWO LAYERS, AND KEEPING THEM APART IS THE POINT.
 *
 *   the base layer   — the rows as an admin typed them, in GBP, cached once
 *   the priced layer — those rows converted into one currency, cached per
 *                      currency, derived from the base layer and never from
 *                      the database again
 *
 * Everything downstream of `load({ cur })` — every route, every template — sees
 * amounts that are ALREADY in the visitor's currency. No view converts anything,
 * no route multiplies by a rate, and `money()` only formats. That is what makes
 * a hundred existing call sites correct in three currencies without touching
 * any of them: the numbers arriving at them changed, the code did not.
 *
 * Each row also keeps its base amounts under `base_*`. Anything that is a
 * POLICY rather than a price is decided on those — the free-domain cap most of
 * all, because a cap denominated in the visitor's currency would let a £24 .io
 * become free to an American the day the pound moved.
 */

const db = require('./db');
const currency = require('./currency');
const { TERMS, perMonth, savingPercent } = require('./config');

/** Email is sold on two terms only — monthly or annual. */
const EMAIL_TERMS = [
  { months: 1, column: 'monthly_pence', label: 'Monthly', short: 'mo' },
  { months: 12, column: 'annual_pence', label: '1 year', short: 'yr' },
];

/**
 * The money columns on each kind of row, named WITHOUT the `_pence` suffix —
 * that suffix is what `price_overrides.field` stores, and what the admin form
 * posts back.
 */
const PRICE_FIELDS = {
  plan: ['monthly', 'annual', 'biennial', 'triennial'],
  email_plan: ['monthly', 'annual'],
  tld: ['register', 'renew', 'transfer', 'cost'],
};

/**
 * How many months each price field covers.
 *
 * This is what lets the rounding rule land on the figure a customer actually
 * reads. A yearly plan is sold as a total but shopped as a per-month rate, so
 * the rounding is applied to the rate and multiplied back up — see the note on
 * currency.convert(). A domain has no monthly rate at all and is rounded whole.
 */
const FIELD_MONTHS = {
  plan: { monthly: 1, annual: 12, biennial: 24, triennial: 36 },
  email_plan: { monthly: 1, annual: 12 },
  tld: { register: 1, renew: 1, transfer: 1, cost: 1 },
};

// ---------------------------------------------------------------------------
// Base layer: the catalogue as typed, in the base currency
// ---------------------------------------------------------------------------
let baseCache = null;
let baseAt = 0;
const TTL_MS = 60_000;

async function loadBase({ fresh = false } = {}) {
  if (!fresh && baseCache && Date.now() - baseAt < TTL_MS) return baseCache;

  const [planRows, emailRows, tldRows, overrideRows] = await Promise.all([
    db.query('SELECT * FROM plans ORDER BY sort_order, id'),
    db.query('SELECT * FROM email_plans ORDER BY family, sort_order, id'),
    db.query('SELECT * FROM tlds ORDER BY sort_order, tld'),
    db.query('SELECT * FROM price_overrides').catch((err) => {
      // Same reasoning as the currencies table: a missing one means schema.sql
      // has not been re-run, and the right answer is converted prices with no
      // overrides rather than a dead site.
      console.error('[pricing] could not read price_overrides:', err.message);
      return [];
    }),
  ]);

  // overrides[entity][id][CURRENCY][field] = amount in that currency's minor unit
  const overrides = {};
  for (const row of overrideRows) {
    const e = (overrides[row.entity] ||= {});
    const byId = (e[row.entity_id] ||= {});
    const byCur = (byId[String(row.currency).toUpperCase()] ||= {});
    byCur[row.field] = Number(row.amount_minor);
  }

  baseCache = { planRows, emailRows, tldRows, overrides };
  baseAt = Date.now();
  return baseCache;
}

/**
 * One row's money columns, converted.
 *
 * An explicit override wins outright and is NOT rounded — an admin who typed
 * $2.99 meant $2.99, and putting a `charm99` rule anywhere near a hand-entered
 * number is how it becomes $2.99 today and $3.99 after somebody changes an
 * unrelated setting.
 */
function convertRow(row, entity, cur, overrides) {
  const out = { ...row };
  const mine = overrides?.[entity]?.[row.id]?.[cur.code] || {};

  for (const field of PRICE_FIELDS[entity]) {
    const column = `${field}_pence`;
    if (!(column in row)) continue;

    const baseAmount = Number(row[column]) || 0;
    out[`base_${column}`] = baseAmount;
    out[column] = Object.prototype.hasOwnProperty.call(mine, field)
      ? Number(mine[field])
      : currency.convert(baseAmount, cur, { per: FIELD_MONTHS[entity][field] });
    // So the admin can show "converted £5.99 → $7.99, overridden to $6.99"
    // without doing the arithmetic a second time in a template.
    out[`overridden_${field}`] = Object.prototype.hasOwnProperty.call(mine, field);
  }

  out.currency = cur.code;
  return out;
}

// ---------------------------------------------------------------------------
// Decoration
// ---------------------------------------------------------------------------
function decoratePlan(row, cur) {
  const price = {};
  const perMonthPence = {};
  const perMonthParts = {};
  const saving = {};

  TERMS.forEach((t) => {
    const total = Number(row[t.column]) || 0;
    price[t.months] = total;
    perMonthPence[t.months] = perMonth(total, t.months);
    perMonthParts[t.months] = currency.parts(perMonthPence[t.months], cur);
    saving[t.months] = savingPercent(row.monthly_pence, total, t.months);
  });

  return {
    ...row,
    price,
    perMonthPence,
    perMonthParts,
    saving,
    featureList: String(row.features || '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean),
    // The headline used everywhere a plan is mentioned in passing.
    fromDisplay: currency.format(Math.min(...Object.values(perMonthPence)), cur),
  };
}

/**
 * The same treatment for an email plan, on its own two-term ladder.
 *
 * `perUnit` is what the pricing card shows: email is quoted per mailbox (or per
 * 1,000 contacts) per month whichever term is chosen, because that is the unit
 * a buyer compares against Google Workspace and Mailchimp. The annual figure is
 * the total actually charged, and both appear on the card.
 */
function decorateEmailPlan(row, cur) {
  const price = {};
  const perMonthPence = {};
  const perMonthParts = {};
  const saving = {};

  EMAIL_TERMS.forEach((t) => {
    const total = Number(row[t.column]) || 0;
    price[t.months] = total;
    perMonthPence[t.months] = perMonth(total, t.months);
    perMonthParts[t.months] = currency.parts(perMonthPence[t.months], cur);
    saving[t.months] = savingPercent(row.monthly_pence, total, t.months);
  });

  return {
    ...row,
    price,
    perMonthPence,
    perMonthParts,
    saving,
    featureList: String(row.features || '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean),
    fromDisplay: currency.format(Math.min(...Object.values(perMonthPence)), cur),
  };
}

// ---------------------------------------------------------------------------
// Priced layer: one cache per currency, built from the base layer
// ---------------------------------------------------------------------------
const priced = new Map();

function invalidate() {
  baseCache = null;
  priced.clear();
}

/**
 * The catalogue in one currency.
 *
 * `cur` is a currency row — normally `req.currency`, already resolved by the
 * middleware. Omitting it means the base currency, which is what the admin,
 * the seed scripts and anything reasoning about policy rather than display
 * want.
 */
async function load({ fresh = false, includeInactive = false, cur = null } = {}) {
  const base = await loadBase({ fresh });
  const money = cur || (await currency.base());

  const stamp = `${baseAt}:${money.code}:${money.rate}:${money.rounding}`;
  let built = priced.get(money.code);
  if (fresh || !built || built.stamp !== stamp) {
    const plans = base.planRows.map((r) =>
      decoratePlan(convertRow(r, 'plan', money, base.overrides), money));
    const emailPlans = base.emailRows.map((r) =>
      decorateEmailPlan(convertRow(r, 'email_plan', money, base.overrides), money));
    const tlds = base.tldRows.map((r) => convertRow(r, 'tld', money, base.overrides));

    built = {
      stamp,
      cur: money,
      plans,
      emailPlans,
      // Split by family up front — every page that shows email shows the two
      // groups separately, and doing it here keeps the filter out of the views.
      businessEmail: emailPlans.filter((p) => p.family === 'business'),
      marketingEmail: emailPlans.filter((p) => p.family === 'marketing'),
      tlds,
      // Indexed for the O(1) lookups the domain search does per result.
      tldBy: Object.fromEntries(tlds.map((t) => [t.tld, t])),
    };
    priced.set(money.code, built);
  }

  return includeInactive ? built : visible(built);
}

/** The public view of the catalogue: active rows only. */
function visible(c) {
  const emailPlans = c.emailPlans.filter((p) => p.active);
  return {
    ...c,
    plans: c.plans.filter((p) => p.active),
    emailPlans,
    businessEmail: emailPlans.filter((p) => p.family === 'business'),
    marketingEmail: emailPlans.filter((p) => p.family === 'marketing'),
  };
}

/** The extensions shown as chips under the search box. */
async function featuredTlds(limit = 6, cur = null) {
  const { tlds } = await load({ cur });
  return tlds.filter((t) => t.active && t.featured).slice(0, limit);
}

/** What a name costs to register, by extension. Null if we do not sell it. */
async function priceForTld(tld, cur = null) {
  const { tldBy } = await load({ cur });
  const row = tldBy[String(tld || '').toLowerCase()];
  return row && row.active ? row : null;
}

async function planBySlug(slug, cur = null) {
  const { plans } = await load({ includeInactive: true, cur });
  return plans.find((p) => p.slug === slug) || null;
}

async function emailPlanBySlug(slug, cur = null) {
  const { emailPlans } = await load({ includeInactive: true, cur });
  return emailPlans.find((p) => p.slug === slug) || null;
}

/**
 * Terms decorated with the best saving available on any plan, so the toggle can
 * show "−17%" against the annual tab without the view doing the maths.
 */
async function termsWithSavings(cur = null) {
  const { plans } = await load({ cur });
  return TERMS.map((t) => ({
    ...t,
    maxSaving: plans.length ? Math.max(...plans.map((p) => p.saving[t.months] || 0)) : 0,
  }));
}

/**
 * Every currency's take on one row, for the admin price editor: what the
 * conversion produces, and what (if anything) has been typed over it.
 */
async function currencyMatrix(entity, row) {
  const { all } = await currency.load({ includeInactive: true });
  const base = await loadBase();
  const mine = base.overrides?.[entity]?.[row.id] || {};

  return all
    .filter((c) => !c.is_base)
    .map((c) => ({
      cur: c,
      fields: PRICE_FIELDS[entity].map((field) => {
        const baseAmount = Number(row[`base_${field}_pence`] ?? row[`${field}_pence`]) || 0;
        const override = mine[c.code]?.[field];
        const converted = currency.convert(baseAmount, c, { per: FIELD_MONTHS[entity][field] });
        return {
          field,
          base_minor: baseAmount,
          converted_minor: converted,
          override_minor: override === undefined ? null : Number(override),
          effective_minor: override === undefined ? converted : Number(override),
        };
      }),
    }));
}

module.exports = {
  load,
  loadBase,
  invalidate,
  featuredTlds,
  priceForTld,
  planBySlug,
  emailPlanBySlug,
  termsWithSavings,
  currencyMatrix,
  decoratePlan,
  decorateEmailPlan,
  convertRow,
  EMAIL_TERMS,
  FIELD_MONTHS,
  PRICE_FIELDS,
};
