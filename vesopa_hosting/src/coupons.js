/**
 * Discount codes.
 *
 * All the rules live here rather than in the basket route, because a coupon is
 * checked in three places — when it is typed, when the basket is re-priced on
 * every page load, and again inside the checkout transaction — and three copies
 * of "is this still valid" is three chances to disagree.
 *
 * The last of those checks is the one that matters: everything before it is a
 * courtesy to the customer, and only the one inside the transaction decides
 * whether money comes off.
 */

const db = require('./db');
const currency = require('./currency');

/**
 * A coupon is written ONCE, in the base currency, and converted like everything
 * else in the catalogue.
 *
 * The alternative — a code per currency, or a currency column on the code — was
 * rejected because it makes every campaign three campaigns. "£10 off" becomes
 * LAUNCH10, LAUNCH10US and LAUNCH10CA, three `used` counters that have to be
 * reasoned about together to answer "how many are left", and a customer who
 * switches currency mid-basket watching their code stop working.
 *
 * A percentage needs no conversion at all and is the same offer everywhere. A
 * fixed amount and a minimum spend are converted with the same rate and
 * rounding as a price, so "£10 off over £50" reads as "$13 off over $65" and
 * means the same thing to us.
 */

/** Codes are stored and compared uppercase; customers type them however. */
function normalise(code) {
  return String(code || '').trim().toUpperCase().slice(0, 40);
}

/**
 * Which basket lines a code is allowed to discount.
 *
 * A percentage off "everything" must not come off a domain: we buy those in at
 * close to what we sell them for, so 20% off a £6.99 .co.uk is most of the
 * margin and all of it on the cheap TLDs. `applies_to` defaults to `all`, and
 * `all` here still means "all the things we make a margin on".
 */
function eligibleLines(lines, appliesTo) {
  if (appliesTo === 'hosting') return lines.filter((l) => l.kind === 'hosting');
  if (appliesTo === 'email') return lines.filter((l) => l.kind === 'email');
  if (appliesTo === 'domain') return lines.filter((l) => l.kind === 'domain' || l.kind === 'domain_transfer');
  return lines;
}

/**
 * Look a code up and decide whether this basket may use it.
 *
 * Returns `{ ok, coupon, discount_pence, reason }`. Never throws for an invalid
 * code — an unknown coupon is an ordinary thing a customer does, not an error.
 *
 * @param {object[]} lines    priced basket lines
 * @param {number}   gross    basket total before this coupon, in the basket's
 *                            currency minor units
 * @param {object}   customer signed-in customer, or null
 * @param {object}   cur      the currency the basket is priced in
 */
async function evaluate(code, lines, gross, customer, cur = null) {
  const money = (minor) => currency.format(minor, cur);
  // Base-currency figures on the coupon row, brought into the basket's money.
  const inBasket = (baseMinor) => currency.convert(Number(baseMinor) || 0, cur);

  const wanted = normalise(code);
  if (!wanted) return { ok: false, reason: '' };

  const coupon = await db.one('SELECT * FROM coupons WHERE code = ? LIMIT 1', [wanted]);
  if (!coupon || !coupon.active) {
    return { ok: false, reason: 'That code is not one of ours.' };
  }

  const now = new Date();
  if (coupon.starts_at && new Date(coupon.starts_at) > now) {
    return { ok: false, reason: 'That code is not live yet.' };
  }
  if (coupon.expires_at && new Date(coupon.expires_at) < now) {
    return { ok: false, reason: 'That code has expired.' };
  }
  if (coupon.max_uses > 0 && coupon.used >= coupon.max_uses) {
    return { ok: false, reason: 'That code has been fully redeemed.' };
  }
  const minSpend = inBasket(coupon.min_spend_pence);
  if (minSpend > 0 && gross < minSpend) {
    return { ok: false, reason: `That code needs a basket of ${money(minSpend)} or more.` };
  }

  if (coupon.first_order_only && customer) {
    const prior = await db.one(
      "SELECT id FROM orders WHERE customer_id = ? AND status <> 'cancelled' LIMIT 1",
      [customer.id],
    );
    if (prior) return { ok: false, reason: 'That code is for a first order.' };
  }

  const eligible = eligibleLines(lines, coupon.applies_to);
  // A free line is worth nothing to discount, and discounting it would let a
  // percentage code produce a negative number.
  const base = eligible.reduce((sum, l) => sum + (l.freeWithPlan ? 0 : l.total_pence), 0);
  if (base <= 0) {
    return { ok: false, reason: 'Nothing in your basket qualifies for that code.' };
  }

  /*
   * A percentage is applied to the basket as priced, so it needs no conversion
   * and is the same offer in every currency. A fixed amount is a base-currency
   * figure and is converted — £10 off is $13 off, not $10 off, which would be a
   * quietly different (and smaller) offer to every American customer.
   */
  const raw = coupon.kind === 'percent'
    ? Math.round((base * Number(coupon.value)) / 100)
    : inBasket(coupon.value);

  // Never more than the qualifying lines are worth. A £20 fixed code on a £12
  // basket takes £12 off, not £20 and a refund.
  const discount = Math.max(0, Math.min(raw, base));
  if (discount <= 0) return { ok: false, reason: 'That code takes nothing off this basket.' };

  return { ok: true, coupon, discount_pence: discount };
}

/**
 * Count a redemption. Called inside the checkout transaction, with the same
 * connection, so a code with one use left cannot be taken twice by two people
 * checking out at the same moment.
 *
 * The WHERE clause repeats the limit rather than trusting the earlier read:
 * that is what makes it atomic. Returns false if it lost the race.
 */
async function redeem(conn, couponId) {
  const [res] = await conn.query(
    'UPDATE coupons SET used = used + 1 WHERE id = ? AND (max_uses = 0 OR used < max_uses)',
    [couponId],
  );
  return res.affectedRows === 1;
}

/** A short human label for the basket line: "SUMMER20 — 20% off". */
function label(coupon, cur = null) {
  const off = coupon.kind === 'percent'
    ? `${coupon.value}% off`
    : `${currency.format(currency.convert(Number(coupon.value) || 0, cur), cur)} off`;
  const scope = coupon.applies_to === 'all' ? '' : ` ${coupon.applies_to}`;
  return `${coupon.code} — ${off}${scope}`;
}

module.exports = { normalise, evaluate, redeem, label };
