/**
 * What we sell an extension for, given what it costs us.
 *
 * ONE LADDER, TWO CALLERS. `scripts/import-tlds.js` uses it to price 700
 * extensions off the registrar's rate card, and the admin's "suggest prices"
 * button uses it on whatever is currently filtered. If these were two copies,
 * the button would stop agreeing with the import the first time either was
 * tuned — and the disagreement would show up as a price nobody could account
 * for.
 *
 * Nothing here reads the database or the request. It is arithmetic on pence in
 * the base currency, and the conversion to what a visitor sees happens later,
 * in pricing.js, like every other price in the catalogue.
 */

/**
 * Proportional markup, banded by cost.
 *
 * A flat percentage is wrong at both ends of a rate card that runs from £0.78
 * to £2,008. Thirty per cent of a £1.57 .xyz is 47p, which does not pay for the
 * support ticket it will eventually generate; thirty per cent of a £2,008 .rich
 * is £600 of margin on a name whose buyer is not price shopping.
 */
const TIERS = [
  { upTo: 500, multiplier: 1.85 },
  { upTo: 1500, multiplier: 1.45 },
  { upTo: 4000, multiplier: 1.30 },
  { upTo: 15000, multiplier: 1.22 },
  { upTo: Infinity, multiplier: 1.15 },
];

/**
 * The cash minimum on top of cost.
 *
 * What makes the cheap end viable, and the reason .xyz lands at £3.09 rather
 * than £2.09. A percentage alone cannot express "we need at least this many
 * pence out of any sale".
 */
const FLOOR_PENCE = 150;

/**
 * Charm-round a sell price.
 *
 * Two rules, for the same reason currency.js keeps two: .x9 below £20 so a
 * cheap ladder does not collapse into a single price point, and .99 above it
 * where a whole pound is small change and a round headline reads better.
 */
function charm(pence) {
  if (pence <= 0) return 0;
  const out = pence < 2000
    ? Math.round(pence / 10) * 10 - 1
    : Math.round(pence / 100) * 100 - 1;
  // Charm rounding on a small enough amount lands on or below zero. The exact
  // figure is the honest answer there.
  return out < 1 ? Math.round(pence) : out;
}

/** The suggested sell price for a landed cost, in base-currency pence. */
function sellFrom(costPence) {
  const cost = Number(costPence) || 0;
  if (cost <= 0) return 0;
  const tier = TIERS.find((t) => cost <= t.upTo);
  return charm(Math.max(cost * tier.multiplier, cost + FLOOR_PENCE));
}

/** Human-readable, for the admin: "+45% (min +£1.50)". */
function describeTier(costPence) {
  const cost = Number(costPence) || 0;
  const tier = TIERS.find((t) => cost <= t.upTo);
  return tier ? `+${Math.round((tier.multiplier - 1) * 100)}%` : '';
}

module.exports = { TIERS, FLOOR_PENCE, charm, sellFrom, describeTier };
