/**
 * Basket, order form and checkout.
 *
 * The basket lives in a cookie until the moment an order is placed. An
 * abandoned basket therefore costs us no rows and no cleanup job, and a
 * customer who has not signed in can still fill one.
 *
 * The cookie holds only *references* — a plan slug, a domain name, a term. Every
 * price is looked up again server-side at checkout. Anything else means a
 * customer with a text editor can set their own price.
 */

const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const pricing = require('../pricing');
const registrar = require('../integrations/domainnameapi');
const auth = require('../auth');
const { sendMail, shell, detailTable, escapeHtml, DEFAULT_TO } = require('../mailer');
const { flash, field, isEmail } = require('../http-utils');
const coupons = require('../coupons');
const currency = require('../currency');
const payments = require('../payments');
const {
  resolveTerm,
  termEarnsFreeDomain, tldQualifiesFree, TERMS, perMonth, FREE_DOMAIN_MAX_PENCE,
} = require('../config');

const router = express.Router();
const PAYMENTS_MODE = (process.env.PAYMENTS_MODE || 'manual').toLowerCase();

/**
 * "4 mailboxes", "3 × 1,000 contacts", "1 mailbox".
 *
 * Naive `label + 's'` produced "4 mailboxs" and "3 1,000 contactss" on a real
 * order line. A unit whose label already contains a number reads as a multiplier
 * rather than a noun, so it takes "×" and is never pluralised.
 */
function describeUnits(count, label) {
  const name = String(label || 'unit');
  if (/\d/.test(name)) return `${count} × ${name}`;
  if (count === 1) return `1 ${name}`;
  // mailbox -> mailboxes, box -> boxes, address -> addresses
  const plural = /(?:s|x|z|ch|sh)$/i.test(name) ? `${name}es` : `${name}s`;
  return `${count} ${plural}`;
}

// ---------------------------------------------------------------------------
// Cart cookie
// ---------------------------------------------------------------------------
const MAX_ITEMS = 20;

function writeCart(req, res, cart) {
  const trimmed = cart.slice(0, MAX_ITEMS);
  /*
   * The REQUEST's own copy moves too, not just the cookie.
   *
   * A cookie is only read at the start of the next request. Without this line,
   * an in-place update would re-price `req.cart` as it was when the request
   * arrived and hand back fragments showing the basket the customer had a
   * moment ago — the change would appear to have been ignored, and would then
   * silently apply on the next reload.
   */
  req.cart = trimmed;
  res.cookie('vh_cart', Buffer.from(JSON.stringify(trimmed)).toString('base64url'), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

function clearCart(res) {
  res.clearCookie('vh_cart', { path: '/' });
  res.clearCookie('vh_coupon', { path: '/' });
}

/**
 * The applied coupon rides in its own short-lived cookie.
 *
 * Only the CODE is stored, never the discount — same rule as the basket itself.
 * A cookie carrying "£50 off" is a cookie a customer can edit; a cookie
 * carrying "SUMMER20" is re-validated and re-priced on every single request.
 *
 * A day, not a week: a code that has expired since it was typed should stop
 * following someone around, and the basket outliving the offer is a support
 * conversation nobody enjoys.
 */
function writeCoupon(req, res, code) {
  // Same reasoning as writeCart: the current request has to see it too.
  if (req.cookies) req.cookies.vh_coupon = code ? coupons.normalise(code) : '';
  if (!code) return res.clearCookie('vh_coupon', { path: '/' });
  res.cookie('vh_coupon', coupons.normalise(code), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 24 * 60 * 60 * 1000,
    path: '/',
  });
}

/**
 * Everything priceCart needs beyond the basket itself.
 *
 * The CURRENCY is part of this and not a global. Two people can be checking out
 * in two currencies in the same Node process at the same moment; the only place
 * that is safe to remember which is which is the request.
 */
function ctxOf(req) {
  return {
    couponCode: req.cookies?.vh_coupon || '',
    customer: req.customer || null,
    cur: req.currency,
  };
}

/**
 * Turn the cookie's references into priced lines.
 *
 * Anything that no longer exists or has been deactivated is dropped rather than
 * erroring — a plan retired between adding to the basket and checking out
 * should not produce a stack trace on a customer's screen.
 */
async function priceCart(cart, { couponCode = '', customer = null, cur = null } = {}) {
  const active = cur || (await currency.base());
  const { plans, emailPlans, tldBy } = await pricing.load({ includeInactive: true, cur: active });
  const money = (minor) => currency.format(minor, active);
  const lines = [];

  for (const item of cart) {
    if (item.kind === 'email') {
      const plan = emailPlans.find((p) => p.slug === item.slug && p.active);
      if (!plan) continue;
      // Email runs on its own two-term ladder, so resolveTerm (which knows the
      // hosting terms, including 24 and 36 months) would happily return a term
      // this plan has no price column for. Monthly or annual, nothing else.
      const months = Number(item.term) === 1 ? 1 : 12;
      const units = Math.max(
        plan.min_units,
        Math.min(plan.max_units, Number(item.units) || plan.min_units),
      );
      const unit = plan.price[months];
      lines.push({
        kind: 'email',
        slug: plan.slug,
        description: `${plan.name} — ${describeUnits(units, plan.unit_label)}, ${months === 1 ? 'monthly' : '1 year'}`,
        emailPlan: plan,
        term_months: months,
        domain: item.domain || '',
        units,
        unit_pence: unit,
        qty: units,
        total_pence: unit * units,
      });
    }

    if (item.kind === 'hosting') {
      const plan = plans.find((p) => p.slug === item.slug && p.active);
      if (!plan) continue;
      const term = resolveTerm(item.term);
      const total = plan.price[term.months];

      /*
       * `was` is what this same term would cost at the monthly rate — a real
       * comparison against a price we genuinely charge, not an invented list
       * price. On the monthly term there is nothing to compare it to, so there
       * is no "was" and no saving, which is the honest answer.
       */
      const atMonthly = plan.monthly_pence * term.months;
      const saving = term.months > 1 ? Math.max(0, atMonthly - total) : 0;

      /*
       * The next term up, for the "save more" nudge. Only offered when it
       * genuinely beats the current choice on the per-month rate — otherwise
       * the banner is asking someone to pay more for longer.
       */
      let upsell = null;
      const longer = TERMS.filter((t) => t.months > term.months);
      for (const t of longer) {
        const price = plan.price[t.months];
        if (!price) continue;
        if (perMonth(price, t.months) < perMonth(total, term.months)) {
          upsell = {
            months: t.months,
            label: t.label,
            perMonth: perMonth(price, t.months),
            total: price,
            // What they save over the longer term against paying monthly.
            saving: Math.max(0, plan.monthly_pence * t.months - price),
          };
          break;
        }
      }

      lines.push({
        kind: 'hosting',
        slug: plan.slug,
        description: `${plan.name} hosting — ${term.label}`,
        plan,
        term,
        term_months: term.months,
        domain: item.domain || '',
        unit_pence: total,
        qty: 1,
        total_pence: total,
        was_pence: saving > 0 ? atMonthly : 0,
        saving_pence: saving,
        perMonth_pence: perMonth(total, term.months),
        // Renewal is at the same price for the same term. Printed on the line
        // because "what happens in a year" is the question the basket should
        // answer before it is asked.
        renews_pence: total,
        upsell,
      });
    }

    if (item.kind === 'domain' || item.kind === 'domain_transfer') {
      const { tld } = registrar.splitDomain(item.domain);
      const price = tldBy[tld];
      if (!price || !price.active) continue;
      const years = Math.max(1, Math.min(10, Number(item.years) || 1));
      const isTransfer = item.kind === 'domain_transfer';
      // A transfer is priced as the transfer rate for the first year plus the
      // renewal rate for any extra years — the registry charges us the same way.
      const unit = isTransfer ? price.transfer_pence : price.register_pence;
      const extra = years > 1 ? price.renew_pence * (years - 1) : 0;
      lines.push({
        kind: item.kind,
        description: `${item.domain} — ${isTransfer ? 'transfer' : 'registration'}, ${years} year${years > 1 ? 's' : ''}`,
        domain: item.domain,
        tld,
        years,
        authCode: item.authCode || '',
        unit_pence: unit,
        qty: 1,
        total_pence: unit + extra,
      });
    }
  }

  /*
   * ONE free domain with any hosting plan bought for a year or more.
   *
   * Three conditions, all deliberate:
   *   - the plan grants it        (free_domain, per-plan so it can be withdrawn)
   *   - the term is 12m or more   (never the monthly plan — a domain is a real
   *                                cost at the registry and cannot be returned,
   *                                so it must not ride on a term that can be
   *                                cancelled after four weeks)
   *   - the extension is under the price cap, registered for a single year
   *
   * There are now TWO ways to take this entitlement: a domain already in the
   * basket is zeroed here, and a customer who bought hosting alone claims one
   * in the setup wizard after paying. `hasFreeDomainInCart` is what tells
   * checkout which happened, so the service is written with the entitlement
   * already spent and NOBODY GETS TWO.
   *
   * The dearest qualifying domain is the one made free — that is the answer a
   * customer expects, and arguing about which one it was is not worth the
   * goodwill.
   */
  const hostingLine = lines.find(
    (l) => l.kind === 'hosting' && l.plan.free_domain && termEarnsFreeDomain(l.term_months),
  );
  let discount = 0;
  if (hostingLine) {
    const eligible = lines
      .filter((l) => l.kind === 'domain' && l.years === 1 && tldQualifiesFree(tldBy[l.tld]))
      .sort((a, b) => b.unit_pence - a.unit_pence)[0];
    if (eligible) {
      discount = eligible.unit_pence;
      eligible.freeWithPlan = true;
      hostingLine.freeDomainSpent = true;
    }
  }

  /*
   * What is included at no charge, listed so the basket sells the plan back to
   * the customer while they are deciding. Everything here is a real feature of
   * the plan in the basket, read off the plan row — never a generic list.
   */
  const included = [];
  if (hostingLine) {
    const p = hostingLine.plan;
    if (p.free_ssl) included.push('Free SSL certificate, renewed automatically');
    if (p.free_domain && termEarnsFreeDomain(hostingLine.term_months)) {
      included.push(
        hostingLine.freeDomainSpent
          ? 'Your free domain for the first year — already applied to this basket'
          // The cap is decided in the base currency and shown in theirs.
          : `A free domain for the first year, up to ${money(currency.convert(FREE_DOMAIN_MAX_PENCE, active))} — choose it after payment`,
      );
    }
    if (p.mailboxes) included.push(`${p.mailboxes} mailbox${p.mailboxes > 1 ? 'es' : ''} at your own domain`);
    included.push(p.daily_backups ? 'Daily backups you can restore yourself' : 'Weekly off-site backups');
    if (p.slug !== 'starter') included.push('Free migration of your existing site');
    included.push('30-day money-back guarantee');
  }

  const gross0 = lines.reduce((sum, l) => sum + l.total_pence, 0) - discount;

  /*
   * The coupon, applied on top of the free-domain discount.
   *
   * Evaluated here so every page that prices the basket sees the same number,
   * and re-evaluated on every load — a code that expires while a basket sits
   * open must stop applying, not stay applied because it once did.
   */
  let coupon = null;
  let couponDiscount = 0;
  let couponError = '';
  if (couponCode) {
    const verdict = await coupons.evaluate(couponCode, lines, gross0, customer, active);
    if (verdict.ok) {
      coupon = verdict.coupon;
      couponDiscount = verdict.discount_pence;
    } else {
      couponError = verdict.reason;
    }
  }

  /*
   * VAT IS INSIDE THE TOTAL, not added to it. The customer pays `gross`, which
   * is the number they have been looking at all along; `vat` is the portion of
   * it we account for. See the note on vatIncludedIn() in currency.js — this is
   * NOT gross × 20%.
   *
   * The rate comes off the CURRENCY ROW. A sterling basket has 20% UK VAT
   * inside it; a dollar basket has none, `vat` is 0, `net` equals `gross` and
   * the templates draw no VAT line at all. Showing a UK VAT figure to a
   * customer in Texas would be inventing a tax.
   */
  const gross = Math.max(0, gross0 - couponDiscount);
  const vat = currency.vatIncludedIn(gross, active);
  const net = gross - vat;

  // The struck-through "was" on the summary: everything at its undiscounted
  // price. Only shown when it is genuinely higher than what they will pay.
  const wasTotal = lines.reduce((sum, l) => sum + (l.was_pence || l.total_pence), 0);
  const savedTotal = Math.max(0, wasTotal - gross);

  return {
    lines,
    included,
    discount,
    coupon,
    couponCode: coupon ? coupon.code : '',
    couponDiscount_pence: couponDiscount,
    couponError,
    // Every amount above and below is in THIS currency's minor units. Carried
    // out so the checkout write, the emails and the order row all agree about
    // what the numbers mean rather than each re-deriving it.
    cur: active,
    currencyCode: active.code,
    fxRate: active.rate,
    vatPercent: active.vat_percent,
    vatLabel: active.vat_label || 'VAT',
    showVat: active.vat_percent > 0,
    // What this basket is worth in the base currency, for reporting. Recorded
    // on the order at the rate that applied the day it was placed.
    base_total_pence: currency.toBase(gross, active),
    // `subtotal_pence` stays the gross of the lines, which is what the basket
    // displays next to "Subtotal".
    subtotal_pence: gross0,
    net_pence: net,
    vat_pence: vat,
    total_pence: gross,
    was_total_pence: savedTotal > 0 ? wasTotal : 0,
    saved_total_pence: savedTotal,
  };
}

// ---------------------------------------------------------------------------
// Adding to the basket
// ---------------------------------------------------------------------------

/**
 * /order/:slug — the plan buttons on the marketing pages land here.
 *
 * TWO STEPS: basket, then checkout. Choosing a product adds it and shows the
 * basket; the basket's one button goes to the payment form.
 *
 * The basket is where the term can still be changed, a domain added, a code
 * applied and the total checked. Skipping it dropped people straight onto an
 * address form, which is the wrong moment to discover you picked the wrong
 * term. The domain question stays after payment, in the setup wizard, where
 * the free domain is claimed.
 *
 * `?to=checkout` skips the basket, for anywhere that genuinely should.
 */
router.get('/order/:slug', async (req, res, next) => {
  try {
    const plan = await pricing.planBySlug(req.params.slug);
    if (!plan || !plan.active) return next();

    const term = resolveTerm(req.query.term);
    const cart = req.cart.filter((i) => i.kind !== 'hosting');
    cart.unshift({ kind: 'hosting', slug: plan.slug, term: term.months });
    writeCart(req, res, cart);

    res.redirect(req.query.to === 'checkout' ? '/checkout' : '/cart');
  } catch (err) {
    next(err);
  }
});

/*
 * `/order/configure` used to live here — the "which domain is this for?" screen
 * between the plan button and the basket. It is gone, not disabled: the
 * question is now asked by the setup wizard after payment, and leaving a second
 * copy of the domain-registration and free-domain logic in the codebase is how
 * the two quietly drift apart.
 */

/**
 * /order/email/:slug — the buttons on the email pricing grid.
 *
 * Unlike hosting, several email plans can sit in one basket at once (a business
 * mailbox plan and a marketing plan are a normal pair), so this replaces only
 * the same slug rather than clearing the whole family.
 */
router.get('/order/email/:slug', async (req, res, next) => {
  try {
    const plan = await pricing.emailPlanBySlug(req.params.slug);
    if (!plan || !plan.active) return next();

    const months = Number(req.query.term) === 1 ? 1 : 12;
    const units = Math.max(
      plan.min_units,
      Math.min(plan.max_units, Number(req.query.units) || plan.min_units),
    );

    const cart = req.cart.filter((i) => !(i.kind === 'email' && i.slug === plan.slug));
    cart.push({ kind: 'email', slug: plan.slug, term: months, units });
    writeCart(req, res, cart);

    // Same as a hosting plan: added, then the basket. Several email plans can
    // sit in one basket, so landing there is also where a second one gets
    // added without a detour.
    flash(res, `${plan.name} added.`);
    res.redirect(req.query.to === 'checkout' ? '/checkout' : '/cart');
  } catch (err) {
    next(err);
  }
});

/** Change how many mailboxes / contact blocks are in the basket. */
router.post('/cart/email-units', async (req, res, next) => {
  try {
    if (!auth.checkCsrf(req)) return res.redirect('/cart');
    const slug = field(req.body.slug, 60);
    const plan = await pricing.emailPlanBySlug(slug);
    if (!plan) return finishCart(req, res);

    /*
     * The − and + buttons and the number box all post `units`, so a click on
     * one while the other holds a stale value sends two. The LAST one wins,
     * which is the button that was actually pressed — a browser submits the
     * fields in document order and appends the activated button's value at its
     * own position, so the pair arrives as an array only when they disagree.
     */
    const posted = [].concat(req.body.units);
    const wanted = Number(posted[posted.length - 1]);

    const units = Math.max(
      plan.min_units,
      Math.min(plan.max_units, Number.isFinite(wanted) && wanted > 0 ? wanted : plan.min_units),
    );
    const cart = req.cart.map((i) =>
      i.kind === 'email' && i.slug === slug ? { ...i, units } : i,
    );
    writeCart(req, res, cart);
    await finishCart(req, res);
  } catch (err) {
    next(err);
  }
});

/** Add a domain straight from the search results. */
router.get('/cart/add-domain', async (req, res, next) => {
  try {
    const { domain, sld, tld } = registrar.splitDomain(String(req.query.domain || ''));
    if (registrar.validateLabel(sld) || !tld) {
      flash(res, 'That domain does not look right.', 'error');
      return res.redirect('/domains');
    }
    const price = await pricing.priceForTld(tld);
    if (!price) {
      flash(res, `We do not sell .${tld} yet.`, 'error');
      return res.redirect('/domains');
    }

    const cart = req.cart.filter((i) => i.domain !== domain);
    cart.push({ kind: 'domain', domain, years: 1 });
    writeCart(req, res, cart);
    flash(res, `${domain} added to your basket.`);
    res.redirect('/cart');
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Discount codes
// ---------------------------------------------------------------------------
router.post('/cart/coupon', async (req, res, next) => {
  try {
    if (!auth.checkCsrf(req)) return res.redirect('/cart');
    const code = coupons.normalise(req.body.code);

    if (!code) {
      writeCoupon(req, res, '');
      return finishCart(req, res);
    }

    // Priced WITHOUT the code first, so the evaluation sees the basket the
    // coupon is being judged against rather than one it has already discounted.
    const priced = await priceCart(req.cart, { customer: req.customer, cur: req.currency });
    const verdict = await coupons.evaluate(
      code, priced.lines, priced.subtotal_pence, req.customer, req.currency,
    );

    if (!verdict.ok) {
      /*
       * A code that does not work leaves any WORKING code alone.
       *
       * Clearing it here meant that mistyping a second code silently threw away
       * the discount someone already had — they typed a typo and lost money,
       * with only a red message that did not mention it.
       */
      return finishCart(req, res, {
        message: verdict.reason || 'That code did not work.',
        kind: 'error',
      });
    }

    writeCoupon(req, res, code);
    await finishCart(req, res, {
      message: `${code} applied — ${currency.format(verdict.discount_pence, req.currency)} off.`,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/cart/coupon/remove', async (req, res, next) => {
  try {
    if (!auth.checkCsrf(req)) return res.redirect('/cart');
    writeCoupon(req, res, '');
    await finishCart(req, res, { message: 'Discount code removed.' });
  } catch (err) {
    next(err);
  }
});

router.post('/cart/remove', async (req, res, next) => {
  try {
    if (!auth.checkCsrf(req)) return res.redirect('/cart');
    const index = Number(req.body.index);
    const cart = req.cart.filter((_, i) => i !== index);
    writeCart(req, res, cart);
    await finishCart(req, res, { message: 'Removed from your basket.' });
  } catch (err) {
    next(err);
  }
});

router.post('/cart/term', async (req, res, next) => {
  try {
    if (!auth.checkCsrf(req)) return res.redirect('/cart');
    // resolveTerm falls back to the default rather than trusting the body, so
    // a hand-edited `term=999` cannot invent a price column that does not exist.
    const term = resolveTerm(req.body.term);
    const cart = req.cart.map((i) => (i.kind === 'hosting' ? { ...i, term: term.months } : i));
    writeCart(req, res, cart);
    await finishCart(req, res);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Basket
// ---------------------------------------------------------------------------

/**
 * Everything the basket page and its fragments need.
 *
 * ONE function, called by the full page render AND by every in-place update, so
 * the two cannot drift. The obvious alternative — letting the browser patch the
 * numbers itself after a change — would have meant a second copy of the
 * discount rules, the free-domain rules, the VAT arithmetic and the term ladder
 * living in JavaScript, and the day the two disagreed the customer would be the
 * one who found out. The server prices the basket; the browser only ever shows
 * what it is given.
 */
async function cartView(req) {
  const priced = await priceCart(req.cart, ctxOf(req));
  const [terms, catalogue, featured, settings] = await Promise.all([
    pricing.termsWithSavings(req.currency),
    pricing.load({ cur: req.currency }),
    pricing.featuredTlds(8, req.currency),
    db.settings(),
  ]);

  /*
   * The one cross-sell the basket offers, and only when it is relevant: a
   * basket with hosting and no marketing email gets shown marketing email.
   * A basket that already has it is not nagged, and a domain-only basket is
   * not sold a campaign tool it has nothing to send from.
   */
  const hasHosting = priced.lines.some((l) => l.kind === 'hosting');
  const hasMarketing = priced.lines.some(
    (l) => l.kind === 'email' && l.emailPlan.family === 'marketing',
  );

  return {
    ...priced,
    terms,
    crossSell: hasHosting && !hasMarketing ? catalogue.marketingEmail[0] || null : null,
    featuredTlds: featured,
    // Whether the basket still needs a domain at all — drives the domain
    // search card.
    needsDomain: hasHosting && !priced.lines.some((l) => l.kind === 'domain' || l.kind === 'domain_transfer'),
    freeMax: currency.format(currency.convert(FREE_DOMAIN_MAX_PENCE, req.currency), req.currency),
    moneyBackDays: Number(settings.money_back_days || 30),
  };
}

/** Render one partial to a string, with res.locals (money, icon, csrf) intact. */
function renderPartial(res, view, data) {
  return new Promise((resolve, reject) => {
    res.render(view, data, (err, html) => (err ? reject(err) : resolve(html)));
  });
}

/**
 * Finish a basket change.
 *
 * Two ways out of the same route, and the route itself does not care which:
 *
 *   fetch      re-rendered fragments as JSON, swapped in place, no reload
 *   no script  a flash cookie and a redirect, exactly as before
 *
 * The second is not a fallback nobody will ever hit — it is what a submit
 * button does when this file's JavaScript has not loaded yet, which on a slow
 * connection is the first few seconds of every visit. Both paths run the same
 * validation and the same pricing; only the reply differs.
 */
async function finishCart(req, res, { message = '', kind = 'ok' } = {}) {
  if (!wantsFragment(req)) {
    if (message) flash(res, message, kind);
    return res.redirect('/cart');
  }

  const view = await cartView(req);
  const [main, summary] = view.lines.length
    ? await Promise.all([
        renderPartial(res, 'partials/cart-main', view),
        renderPartial(res, 'partials/cart-summary', view),
      ])
    : [null, null];

  res.json({
    // A basket that has just been emptied has no fragments to swap — there is
    // a whole different page for that state, so the client reloads instead of
    // trying to render an empty one.
    empty: !view.lines.length,
    main,
    summary,
    count: view.lines.length,
    message,
    kind,
  });
}

/** Did this come from cart.js rather than from a plain form post? */
function wantsFragment(req) {
  return req.get('X-Cart-Fragment') === '1';
}

router.get('/cart', async (req, res, next) => {
  try {
    res.render('public/cart', {
      title: 'Your basket',
      robots: 'noindex',
      ...(await cartView(req)),
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------

/**
 * The payment step's own state, derived from the priced basket.
 *
 * Kept in one function because the checkout renders three times — once on GET
 * and twice more on a validation failure — and three copies of "is this basket
 * free" is three chances for the free path to be offered on one render and not
 * the next.
 */
function paymentChoices(priced) {
  const list = payments.gateways();
  return {
    gateways: list,
    // A basket a coupon has taken to nothing skips the gateway entirely. There
    // is no payment to choose, and offering one would be a form that cannot be
    // completed.
    isFree: priced.total_pence === 0,
    canPayOnline: payments.anyGatewayAvailable(),
    selectedGateway: payments.defaultGateway(),
  };
}

router.get('/checkout', async (req, res, next) => {
  try {
    const priced = await priceCart(req.cart, ctxOf(req));
    if (!priced.lines.length) return res.redirect('/cart');

    /*
     * A country to pre-select for a visitor who has no account yet. A suggestion
     * on a visible field, never a value written to an order without the customer
     * seeing it — see the same note on the settings route. It must not be able
     * to fail the checkout, which is why it is caught here rather than awaited
     * bare.
     */
    let geoCountry = '';
    if (!req.customer || !req.customer.country) {
      try {
        geoCountry = (await require('../geo').countryFor(req.ip)) || '';
      } catch {
        geoCountry = '';
      }
    }

    res.render('public/checkout', {
      title: 'Checkout',
      robots: 'noindex',
      ...priced,
      geoCountry,
      paymentsMode: PAYMENTS_MODE,
      ...paymentChoices(priced),
      values: req.customer
        ? {
            email: req.customer.email,
            first_name: req.customer.first_name,
            last_name: req.customer.last_name,
            company: req.customer.company,
            phone: req.customer.phone,
            address1: req.customer.address1,
            address2: req.customer.address2,
            city: req.customer.city,
            postcode: req.customer.postcode,
            country: req.customer.country,
          }
        : {},
      errors: {},
    });
  } catch (err) {
    next(err);
  }
});

router.post('/checkout', async (req, res, next) => {
  try {
    const priced = await priceCart(req.cart, ctxOf(req));
    if (!priced.lines.length) return res.redirect('/cart');

    const values = {
      email: field(req.body.email, 190).toLowerCase(),
      password: String(req.body.password || ''),
      first_name: field(req.body.first_name, 80),
      last_name: field(req.body.last_name, 80),
      company: field(req.body.company, 160),
      phone: field(req.body.phone, 40),
      address1: field(req.body.address1, 160),
      address2: field(req.body.address2, 160),
      city: field(req.body.city, 80),
      postcode: field(req.body.postcode, 24),
      country: field(req.body.country, 2).toUpperCase() || 'GB',
    };

    /*
     * The gateway is validated against the server's own list, never taken as
     * typed. A hand-edited `gateway=stripe` on a form where Stripe is disabled
     * must not create an order nobody can pay for; it falls back to whatever is
     * actually available.
     */
    const wanted = payments.gatewayById(req.body.gateway);
    const chosenGateway = priced.total_pence === 0
      ? 'free'
      : (wanted && wanted.available ? wanted.id : payments.defaultGateway());

    const errors = {};
    if (!auth.checkCsrf(req)) errors.form = 'Your session expired. Please try again.';
    // Email and password are only asked for when nobody is signed in — the form
    // does not render those fields otherwise, so validating them would fail on
    // an input that does not exist and show an error nowhere on the page.
    if (!req.customer && !isEmail(values.email)) errors.email = 'That email address does not look right.';
    if (!values.first_name) errors.first_name = 'Required.';
    if (!values.last_name) errors.last_name = 'Required.';
    // A registry needs a real registrant address for a domain, so these are
    // only mandatory when the basket actually contains one.
    const hasDomain = priced.lines.some((l) => l.kind === 'domain' || l.kind === 'domain_transfer');
    if (hasDomain) {
      if (!values.address1) errors.address1 = 'Required to register a domain.';
      if (!values.city) errors.city = 'Required.';
      if (!values.postcode) errors.postcode = 'Required.';
      if (!values.phone) errors.phone = 'Required by the registry.';
    }

    let customer = req.customer;
    if (!customer) {
      const existing = await db.one('SELECT * FROM customers WHERE email = ? LIMIT 1', [values.email]);
      if (existing) {
        errors.email = 'You already have an account — please sign in first.';
      } else {
        const problem = auth.passwordProblem(values.password);
        if (problem) errors.password = problem;
      }
    }

    if (Object.keys(errors).length) {
      return res.status(400).render('public/checkout', {
        title: 'Checkout',
        robots: 'noindex',
        ...priced,
        // Whatever they picked is in `values`; no need to guess again.
        geoCountry: '',
        paymentsMode: PAYMENTS_MODE,
        ...paymentChoices(priced),
        values,
        errors,
      });
    }

    // -----------------------------------------------------------------------
    // Everything from here writes. One transaction: an order whose lines are
    // missing, or a service with no order, is worse than a failed checkout.
    // -----------------------------------------------------------------------
    const reference = `VH${Date.now().toString(36).toUpperCase()}${crypto.randomInt(100, 999)}`;

    const result = await db.transaction(async (conn) => {
      if (!customer) {
        const hash = await auth.hashPassword(values.password);
        const [ins] = await conn.query(
          `INSERT INTO customers
             (email, password_hash, first_name, last_name, company, phone,
              address1, address2, city, postcode, country)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            values.email, hash, values.first_name, values.last_name, values.company, values.phone,
            values.address1, values.address2, values.city, values.postcode, values.country,
          ],
        );
        const [rows] = await conn.query('SELECT * FROM customers WHERE id = ?', [ins.insertId]);
        customer = rows[0];
      } else {
        // Keep the billing address current from what they just typed.
        await conn.query(
          `UPDATE customers SET first_name=?, last_name=?, company=?, phone=?,
                  address1=?, address2=?, city=?, postcode=?, country=?
             WHERE id = ?`,
          [
            values.first_name, values.last_name, values.company, values.phone,
            values.address1, values.address2, values.city, values.postcode, values.country,
            customer.id,
          ],
        );
      }

      /*
       * THE RATE IS FROZEN ONTO THE ORDER, along with what it was worth in the
       * base currency at that moment.
       *
       * Neither can be re-derived later. An admin who edits the USD rate next
       * month must not retrospectively change what a customer paid in March, or
       * what March was worth — and an order that only stored "$79, USD" would
       * do exactly that the first time anyone totalled a quarter.
       */
      const [orderIns] = await conn.query(
        `INSERT INTO orders
           (reference, customer_id, status, subtotal_pence, vat_pence, total_pence,
            discount_pence, coupon_code, currency, fx_rate, base_total_pence, payment_method)
         VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          reference, customer.id,
          // net + vat = total. `subtotal_pence` is the NET here, not the gross
          // the basket page shows next to "Subtotal" — an invoice has to add up.
          priced.net_pence, priced.vat_pence, priced.total_pence,
          priced.discount + priced.couponDiscount_pence,
          priced.couponCode || '',
          priced.currencyCode, priced.fxRate, priced.base_total_pence,
          // What they CHOSE, not what mode the app is in. The gateway rewrites
          // this to its own id when the payment settles; recording the intent
          // now is what makes an abandoned checkout legible in the admin.
          chosenGateway || PAYMENTS_MODE,
        ],
      );
      const orderId = orderIns.insertId;

      /*
       * Count the redemption inside the transaction, with this connection.
       *
       * If the code has run out between the basket being priced and this
       * moment, the whole checkout rolls back rather than granting a discount
       * that was not available. That is the only correct answer: the
       * alternative is charging one price and recording another.
       */
      if (priced.coupon) {
        const won = await coupons.redeem(conn, priced.coupon.id);
        if (!won) {
          const err = new Error('COUPON_GONE');
          err.code = 'COUPON_GONE';
          throw err;
        }
      }

      /*
       * THE LINES ARE THE ONLY THING WRITTEN. No service, no domain, no mailbox
       * subscription — an unpaid order puts nothing in anybody's account.
       *
       * It used to create all three here, pending, and the panel then showed a
       * hosting account and a domain to somebody who had not paid for either.
       * The domain row was worse than cosmetic: `domains.domain` is unique, so
       * an abandoned checkout took the name and the next customer to genuinely
       * buy it collided with a row nobody had paid for.
       *
       * So the lines carry everything needed to build the account instead — the
       * plan, the email plan, the term, the units, and the free-domain
       * entitlement exactly as it stood at the moment of sale — and
       * provisioning.materialiseOrder() reads them back when the money arrives.
       * An order that is never paid simply never becomes anything.
       */
      for (const line of priced.lines) {
        const eligible = line.kind === 'hosting'
          && line.plan.free_domain
          && termEarnsFreeDomain(line.term_months) ? 1 : 0;

        await conn.query(
          `INSERT INTO order_items
             (order_id, kind, description, plan_id, email_plan_id, domain, term_months, years,
              unit_pence, qty, total_pence, free_domain_eligible, free_domain_spent, free_with_plan)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            orderId,
            line.kind,
            line.freeWithPlan ? `${line.description} (free with plan)` : line.description,
            line.plan ? line.plan.id : null,
            line.emailPlan ? line.emailPlan.id : null,
            line.domain || '',
            line.term_months || 12,
            line.years || 1,
            line.unit_pence,
            line.qty || 1,
            line.freeWithPlan ? 0 : line.total_pence,
            eligible,
            // The basket already contained the domain the plan paid for, so the
            // setup wizard must not offer a second free one.
            line.freeDomainSpent ? 1 : 0,
            line.freeWithPlan ? 1 : 0,
          ],
        );
      }

      return { orderId, customer };
    });

    customer = result.customer;
    clearCart(res);
    auth.issueCustomerSession(res, customer);

    // Everything below prints money in the currency the order was TAKEN in,
    // not in whatever the reader's own cookie happens to say. A receipt that
    // renders differently depending on who opens it is not a receipt.
    const money = (minor) => currency.format(minor, priced.cur);
    const baseCur = await currency.base();

    await db.logActivity({
      actorType: 'customer',
      actorId: customer.id,
      action: 'order.placed',
      target: reference,
      detail: `${priced.lines.length} line(s), ${money(priced.total_pence)} ${priced.currencyCode}`,
      ip: req.ip,
    });

    // Confirmation to the customer, notification to us.
    const rows = priced.lines.map((l) => [
      l.description,
      l.freeWithPlan ? '<span style="color:#6e8a0e">Free</span>' : money(l.total_pence),
    ]);
    if (priced.couponDiscount_pence > 0) {
      rows.push([`Discount (${escapeHtml(priced.couponCode)})`, `−${money(priced.couponDiscount_pence)}`]);
    }
    // VAT is inside the total, so it is reported, not added. The wording
    // matters on a receipt: "included" is what makes the arithmetic below
    // (which does not add it) correct rather than looking like a mistake.
    //
    // No VAT row at all on a currency that carries none. A zero line labelled
    // "VAT (0%)" invites the question of why it is there, and the answer — UK
    // VAT does not apply to this sale — is better said by its absence.
    if (priced.showVat) {
      rows.push([
        `${escapeHtml(priced.vatLabel)} (${priced.vatPercent}%) — included, we account for this`,
        money(priced.vat_pence),
      ]);
    }
    rows.push([
      '<b>Total to pay</b>',
      `<b>${money(priced.total_pence)} ${escapeHtml(priced.currencyCode)}</b>`,
    ]);

    sendMail({
      to: customer.email,
      subject: `Order ${reference} received — Vesopa Cloud`,
      html: shell({
        title: 'Thanks for your order',
        intro:
          PAYMENTS_MODE === 'manual'
            ? 'We have your order. It is marked as awaiting payment — we will be in touch with payment details, and your services go live the moment it clears.'
            : 'We have your order and your services are being set up now.',
        bodyHtml: detailTable(rows),
        ctaText: 'View your order',
        ctaUrl: `${res.locals.siteUrl}/panel/orders/${result.orderId}`,
        footNote: 'Reply to this email if anything looks wrong — it reaches a person.',
      }),
    });

    sendMail({
      to: DEFAULT_TO,
      subject: `New order ${reference} — ${money(priced.total_pence)} ${priced.currencyCode}`,
      html: shell({
        title: 'New hosting order',
        bodyHtml: detailTable([
          ['Reference', escapeHtml(reference)],
          ['Customer', `${escapeHtml(customer.first_name)} ${escapeHtml(customer.last_name)}`],
          ['Email', escapeHtml(customer.email)],
          ['Total', `${money(priced.total_pence)} ${escapeHtml(priced.currencyCode)}`],
          // Our own copy carries the sterling equivalent, so a week of orders
          // in three currencies can be added up without opening each one.
          ...(priced.cur.is_base
            ? []
            : [[`In ${baseCur.code}`, `${currency.format(priced.base_total_pence, baseCur)} at ${priced.fxRate}`]]),
          ['Lines', priced.lines.map((l) => escapeHtml(l.description)).join('<br>')],
        ]),
        ctaText: 'Open in admin',
        ctaUrl: `${res.locals.siteUrl}/admin/orders/${result.orderId}`,
      }),
    });

    /*
     * WHERE THEY GO NEXT, in three cases.
     *
     * The setup wizard is the destination in all of them — it decides for
     * itself whether to show the payment gate, the free-domain step or the
     * provisioning progress. The question here is only whether the customer
     * detours through a gateway on the way.
     */

    // 1. Nothing to pay. A 100%-off coupon, or a basket that came to zero.
    //    Settled here rather than at a gateway that would reject it, and the
    //    customer lands on the free-domain step already paid up.
    if (priced.total_pence === 0) {
      const order = await db.one('SELECT * FROM orders WHERE id = ? LIMIT 1', [result.orderId]);
      await payments.settleFree(order);
      flash(res, 'No payment needed — your order is confirmed.');
      return res.redirect(`/panel/setup/${result.orderId}`);
    }

    // 2. A gateway they can actually use: hand straight off to it. Anything
    //    that goes wrong opening the session lands them on the wizard with the
    //    reason and a Pay now button, rather than on an error page holding an
    //    order they cannot see.
    const gateway = payments.gatewayById(chosenGateway);
    if (gateway && gateway.available) {
      const order = await db.one('SELECT * FROM orders WHERE id = ? LIMIT 1', [result.orderId]);
      const started = await payments.begin(order, customer, gateway.id, payments.callbackUrls(gateway.id));
      if (started.ok) return res.redirect(303, started.redirectUrl);
      flash(res, `${started.error} Your order is saved — you can try again below.`, 'error');
      return res.redirect(`/panel/setup/${result.orderId}`);
    }

    // 3. No gateway at all. The manual path this app shipped with: an invoice
    //    by email and an admin marking it paid.
    res.redirect(`/panel/setup/${result.orderId}`);
  } catch (err) {
    /*
     * The coupon ran out between pricing the basket and committing the order.
     * The whole transaction rolled back, so nothing was charged and nothing was
     * created — drop the code and send them back to a basket that now shows the
     * real price, rather than a stack trace.
     */
    if (err.code === 'COUPON_GONE') {
      writeCoupon(req, res, '');
      flash(res, 'That discount code was fully redeemed while you were checking out. Your basket has been re-priced.', 'error');
      return res.redirect('/cart');
    }
    next(err);
  }
});

/**
 * The old "order received" page.
 *
 * Checkout now goes straight to the setup wizard, which shows the same order
 * summary and then actually does something with it. This route is kept only
 * because it is in emails already sent and in browser histories, and a dead
 * link in a receipt is a support ticket. It forwards.
 */
router.get('/order/complete/:id', (req, res) => {
  if (!req.customer) return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  res.redirect(301, `/panel/setup/${req.params.id}`);
});

module.exports = router;
