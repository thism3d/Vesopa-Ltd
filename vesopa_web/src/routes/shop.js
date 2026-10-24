'use strict';

/**
 * The hardware shop's checkout and the customer account (2026-10-24).
 *
 *   GET  /hardware/<slug>              one product: gallery, full specification, bought together
 *   GET  /hardware/checkout?c=SKU:n,…  basket, delivery choice and details form
 *   POST /hardware/checkout            save the order, pay on Dojo's checkout
 *   GET  /hardware/order/<public>      back from Dojo: paid / waiting / not paid
 *   POST /hardware/order/<public>/retry|cancel
 *   GET  /account                      sign in by email link, or the account page
 *   POST /account/login | /account/logout,  GET /account/verify?t=
 */
const express = require('express');
const hw = require('../hardware-catalogue');
const shop = require('../shop');
const subs = require('../subscriptions');
const dojo = require('../dojo-billing');
const { bytes } = require('../admin/util');
const { createClient } = require('../vesopa-oidc');
const { list: planList } = require('../plans-store');

/*
 * Continue with Vesopa on /account: the "Vesopa EPOS customer account"
 * application on auth.vesopa.com (vesopa_auth/schema/schema_028), owned by
 * info@vesopasoftware.com. Off until its client id and secret are in .env;
 * the emailed sign-in link works either way. Only a VERIFIED email claim signs
 * anyone in, and the page shows only what belongs to that address.
 */
const SITE = String(process.env.SITE_URL || 'https://vesopaepos.com').replace(/\/+$/, '');
const vesopa = createClient({
  label: 'account_auth',
  clientId: process.env.VESOPA_AUTH_ACCOUNT_CLIENT_ID || '',
  clientSecret: process.env.VESOPA_AUTH_ACCOUNT_CLIENT_SECRET || '',
  redirectUri: `${SITE}/account/auth/vesopa/callback`,
  scope: 'openid profile email',
});

const router = express.Router();

const hits = new Map();
function limited(key, max = 8) {
  const now = Date.now();
  const h = (hits.get(key) || []).filter((t) => now - t < 10 * 60 * 1000);
  h.push(now);
  hits.set(key, h);
  return h.length > max;
}

// ---- checkout ------------------------------------------------------------------------

function checkoutView(req, res, extra = {}) {
  const src = req.method === 'POST' ? req.body : req.query;
  const cart = hw.parseCart(src.cart || src.c || '');
  const delivery = src.delivery || src.d || 'standard';
  const priced = hw.priceCart(cart, delivery);
  res.status(extra.error ? 400 : 200).render('hardware-checkout', {
    title: 'Checkout | Vesopa EPOS Hardware',
    extraFiles: [], bytes, hardware: hw, cart, cartString: hw.cartString(cart), priced, delivery,
    suggest: hw.goesWith(cart.map((l) => l.sku)),
    form: req.method === 'POST' ? req.body : { email: res.locals.accountEmail || '' },
    plans: planList(), trialDays: subs.TRIAL_DAYS,
    gbp: shop.gbp, ready: dojo.configured(), error: null, ...extra,
  });
}

router.get('/hardware/checkout', checkoutView);

router.post('/hardware/checkout', async (req, res) => {
  if (req.body.website) return res.redirect(303, '/hardware'); // honeypot
  if (limited('hw:' + req.ip)) return checkoutView(req, res, { error: 'Too many tries. Please wait a few minutes.' });
  try {
    const { url } = await shop.createOrder(req.body);
    res.redirect(303, url);
  } catch (e) {
    console.error('[shop] order:', e.message);
    checkoutView(req, res, { error: e.status ? 'We could not open the payment page just then. Please try again.' : e.message });
  }
});

router.get('/hardware/order/:pid', async (req, res) => {
  let r;
  try { r = await shop.orderState(req.params.pid); } catch (e) {
    console.error('[shop] state:', e.message);
    r = { order: null, state: 'error' };
  }
  if (r.state === 'paid') shop.signIn(res, r.order.email);
  res.render('hardware-order', { title: 'Your order | Vesopa EPOS', extraFiles: [], bytes, order: r.order, state: r.state, pid: req.params.pid, gbp: shop.gbp });
});

router.post('/hardware/order/:pid/retry', async (req, res) => {
  try {
    const url = await shop.retryOrder(req.params.pid);
    res.redirect(303, url || `/hardware/order/${encodeURIComponent(req.params.pid)}`);
  } catch (e) {
    console.error('[shop] retry:', e.message);
    res.redirect(303, `/hardware/order/${encodeURIComponent(req.params.pid)}`);
  }
});

router.post('/hardware/order/:pid/cancel', async (req, res) => {
  await shop.cancelOrder(req.params.pid).catch(() => {});
  res.redirect(303, `/hardware/order/${encodeURIComponent(req.params.pid)}`);
});

// ---- product pages ---------------------------------------------------------------------

router.get('/hardware/:slug', (req, res, next) => {
  const p = hw.bySlug(req.params.slug) || hw.bySku(req.params.slug);
  if (!p) return next();
  if (p.slug !== req.params.slug) return res.redirect(301, `/hardware/${p.slug}`);
  res.render('hardware-product', {
    title: `${p.name} (${p.sku}) | Vesopa EPOS Hardware`,
    ogUrl: `/hardware/${p.slug}`,
    extraFiles: [], bytes, hardware: hw, p, goes: hw.goesWith([p.sku], 3), gbp: hw.gbp,
  });
});

// ---- account ----------------------------------------------------------------------------

router.get('/account', async (req, res, next) => {
  const email = shop.accountEmail(req);
  if (!email) {
    return res.render('account', { title: 'My account | Vesopa EPOS', extraFiles: [], bytes, email: null, sent: req.query.sent === '1', bad: req.query.bad === '1', failed: req.query.failed === '1', data: null, vesopaSignIn: vesopa.enabled });
  }
  try {
    const data = await shop.overview(email);
    res.render('account', {
      title: 'My account | Vesopa EPOS', extraFiles: [], bytes, email, sent: false, bad: false, data,
      gbp: shop.gbp, longDate: subs.longDate || ((d) => (d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '')),
      backoffice: shop.backofficeUrl(),
    });
  } catch (e) { next(e); }
});

router.post('/account/login', async (req, res) => {
  if (req.body.website) return res.redirect(303, '/account?sent=1');
  const email = String(req.body.email || '').trim().toLowerCase();
  if (limited('acct:' + req.ip, 6) || limited('acct:' + email, 4)) return res.redirect(303, '/account?sent=1');
  try { await shop.sendSignInLink(email, req.body.next); } catch (e) {
    if (/valid email/.test(e.message)) return res.redirect(303, '/account?bad=1');
    console.error('[account] link:', e.message);
  }
  res.redirect(303, '/account?sent=1');
});

router.get('/account/verify', async (req, res) => {
  const email = await shop.redeem(req.query.t).catch(() => null);
  if (!email) return res.redirect(303, '/account?bad=1');
  shop.signIn(res, email);
  const next = typeof req.query.next === 'string' && /^\/[a-z0-9/_-]*$/i.test(req.query.next) ? req.query.next : '/account';
  res.redirect(303, next);
});

router.get('/account/auth/vesopa/start', (req, res, next) => {
  if (!vesopa.enabled) return next();
  res.redirect(302, vesopa.begin({ returnTo: '/account' }).url);
});

router.get('/account/auth/vesopa/callback', async (req, res, next) => {
  if (!vesopa.enabled) return next();
  try {
    const { claims } = await vesopa.complete(req.query);
    const email = String(claims.email || '').trim().toLowerCase();
    if (!email || claims.email_verified === false) throw new Error('no verified email on that Vesopa account');
    shop.signIn(res, email);
    res.redirect(303, '/account');
  } catch (e) {
    console.error('[account] Continue with Vesopa:', e.message);
    res.redirect(303, '/account?failed=1');
  }
});

router.post('/account/logout', (req, res) => { shop.signOut(res); res.redirect(303, '/account'); });

module.exports = { shopRouter: router };
