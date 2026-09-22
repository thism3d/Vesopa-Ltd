/**
 * The pricing table, loaded from the database and held in memory.
 *
 * Why in memory rather than a query per render: five call sites need it, three
 * of them are synchronous (paypal.js mints a plan, payments.js writes a receipt,
 * checkout-api.js prices an order) and all three are on a path where an await
 * would mean threading async through code that has no other reason to be.
 * The row set changes when an admin clicks Save on /admin/plans, which is not a
 * frequency that justifies any of that.
 *
 * Refreshed on boot, every five minutes, and immediately after any write on
 * /admin/plans.
 *
 * If the database has no web_plans rows — the migration has not been run yet —
 * the hardcoded table in config.js is used instead, so the pricing page cannot
 * come up empty.
 */

const { pool } = require('./db');
const { PRICING_PLANS: FALLBACK, DEFAULT_PERIOD: FALLBACK_DEFAULT } = require('./config');

/**
 * Keyed by term length in months, using the field names the templates,
 * paypal.js and payments.js already expect.
 *
 * Money is in major units here — pounds, not pence — because that is what
 * those consumers were written against and what PayPal's API wants. The
 * conversion happens once, here, rather than at each of them.
 */
let byPeriod = { ...FALLBACK };
let ordered = Object.entries(FALLBACK).map(([period, plan]) => ({ ...plan, period }));
let defaultPeriod = FALLBACK_DEFAULT;
let loadedFromDb = false;

function shape(row) {
  return {
    slug: row.slug,
    name: row.name,
    period: String(row.period_months),
    period_months: row.period_months,

    price_per_month: row.price_per_month_minor / 100,
    total_price: row.total_minor / 100,
    discounted_price: row.discounted_minor / 100,
    vat: row.vat_minor / 100,
    total_with_vat: row.total_with_vat_minor / 100,
    save_percentage: row.save_percentage,
    currency: row.currency,

    interval: row.interval_label,
    interval_count: row.interval_count,
    paypal_image: row.paypal_image,

    blurb: row.blurb,
    features: String(row.features || '').split('\n').map((f) => f.trim()).filter(Boolean),
    is_popular: !!row.is_popular,
    is_default: !!row.is_default,
  };
}

async function refresh() {
  try {
    const [rows] = await pool.query(
      `SELECT slug, name, period_months, interval_label, interval_count,
              price_per_month_minor, total_minor, discounted_minor, vat_minor,
              total_with_vat_minor, save_percentage, currency, blurb, features,
              is_popular, is_default, paypal_image
       FROM web_plans
       WHERE is_active = 1 AND is_archived = 0
       ORDER BY sort_order, period_months`
    );

    if (!rows.length) {
      if (loadedFromDb) {
        // Every plan was just archived. Keeping the last good set would sell
        // something the admin deliberately withdrew, so the fallback wins.
        console.warn('[plans] no active plans in web_plans — falling back to config.js');
      }
      byPeriod = { ...FALLBACK };
      ordered = Object.entries(FALLBACK).map(([period, plan]) => ({ ...plan, period }));
      defaultPeriod = FALLBACK_DEFAULT;
      loadedFromDb = false;
      return ordered;
    }

    const shaped = rows.map(shape);
    const map = {};
    // Later rows win on a period collision, which is the same rule the sort
    // order implies: the last one listed is the one the admin sees last.
    for (const plan of shaped) map[plan.period] = plan;

    byPeriod = map;
    ordered = shaped;
    defaultPeriod = (shaped.find((p) => p.is_default) || shaped.find((p) => p.is_popular) || shaped[0]).period;
    loadedFromDb = true;

    return ordered;
  } catch (e) {
    // A database blip must not take the pricing page down. Whatever was loaded
    // last stays loaded.
    console.error('[plans] refresh failed, keeping the previous table:', e.message);
    return ordered;
  }
}

/** Every live plan, in the order the admin arranged them. */
function list() {
  return ordered;
}

/** Keyed by term in months — the shape the old config.PRICING_PLANS had. */
function plans() {
  return byPeriod;
}

/**
 * An unrecognised ?period falls back to the default plan rather than erroring.
 * Called on every checkout request, including ones where the query string was
 * typed by hand.
 */
function resolvePeriod(raw) {
  const key = String(raw ?? '');
  return Object.prototype.hasOwnProperty.call(byPeriod, key) ? key : defaultPeriod;
}

function planFor(raw) {
  return byPeriod[resolvePeriod(raw)];
}

/**
 * Boot-time load plus a slow poll.
 *
 * The poll is the safety net for the case the cache-bust misses: two Node
 * processes behind pm2, where a save in one leaves the other holding the old
 * prices. Five minutes is short enough that nobody is quoted a stale price for
 * long and long enough to be invisible in the query log.
 */
function start() {
  refresh();
  const timer = setInterval(refresh, 5 * 60 * 1000);
  timer.unref();
  return timer;
}

module.exports = { refresh, start, list, plans, resolvePeriod, planFor };
