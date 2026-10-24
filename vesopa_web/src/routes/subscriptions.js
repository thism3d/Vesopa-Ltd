'use strict';

/**
 * Subscriptions on vesopaepos.com (2026-10-24).
 *
 *   GET  /trial?period=3          plans, add-ons and the 14-day trial form
 *   POST /trial                   £1 card check on Dojo's checkout
 *   GET  /trial/done?s=<public>   back from Dojo: refund the £1, start the trial
 *   GET  /subscribe/return?i=<n>  back from a Dojo pay link (first charge or renewal)
 *   POST /webhooks/dojo-subscriptions   Dojo's notification: only names a payment,
 *                                 which is then re-read from Dojo with our key
 *   /api/subs/...                 admin.vesopa.com's service API (Bearer SUBS_SERVICE_KEY)
 *
 * The existing free download trial (/download, 30 days, email only) and the
 * PayPal/card checkout (/checkout) are untouched.
 */
const crypto = require('crypto');
const express = require('express');
const subs = require('../subscriptions');
const { list: planList, resolvePeriod } = require('../plans-store');
const dojo = require('../dojo-billing');
const { sendMail } = require('../mailer');
const shop = require('../shop');

const router = express.Router();

const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const h = (hits.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  h.push(now);
  hits.set(ip, h);
  return h.length > 8;
}

function trialView(res, req, extra = {}) {
  const period = resolvePeriod(req.query.period || req.body?.period);
  let q = null;
  try { q = subs.quote(period, req.body?.addons || {}); } catch { /* no plans */ }
  res.render('trial', {
    title: 'Start your 14-day free trial | Vesopa EPOS',
    extraFiles: [],
    plans: planList(),
    period,
    q,
    addons: subs.ADDONS,
    form: req.body || {},
    gbp: subs.gbp,
    trialDays: subs.TRIAL_DAYS,
    setupFee: subs.SETUP_FEE_MINOR,
    sandbox: dojo.mode() !== 'live',
    ready: dojo.configured(),
    error: req.query && req.query.error ? 'We could not open the payment page just then. Please try again.' : null,
    ...extra,
  });
}

router.get('/trial', (req, res) => trialView(res, req));

router.post('/trial', async (req, res) => {
  if (req.body.website) return res.redirect(303, '/trial'); // honeypot
  if (limited(req.ip)) return trialView(res.status(429), req, { error: 'Too many tries. Please wait a few minutes.' });
  try {
    const { url } = await subs.startTrial({
      period: req.body.period, addons: req.body.addons || {},
      venue: req.body.venue, name: req.body.name, email: req.body.email, phone: req.body.phone,
    });
    sendMail({ subject: `New subscription trial: ${String(req.body.venue || '').slice(0, 80)}`, replyTo: req.body.email,
      html: `<p>${String(req.body.venue || '').replace(/[<>&]/g, '')} started a ${String(req.body.period)}-month plan trial (card check on Dojo).</p>` });
    res.redirect(303, url);
  } catch (e) {
    trialView(res.status(400), req, { error: e.message, trialUsed: e.code === 'TRIAL_USED' });
  }
});

router.get('/trial/done', async (req, res, next) => {
  try {
    const { sub, state } = await subs.cardCheckState(String(req.query.s || ''));
    // The link is private to the customer and the card is proven: sign them in to /account.
    if (state === 'paid' && sub) shop.signIn(res, sub.email);
    res.render('trial-done', { title: 'Your Vesopa EPOS trial', extraFiles: [], sub, state, gbp: subs.gbp, longDate: subs.longDate });
  } catch (e) {
    // A Dojo 4xx/5xx: say so plainly and let the customer try again; the
    // 5-minute sweep still starts the trial if the £1 did go through.
    console.error('[trial] return page:', e.message);
    res.status(502).render('trial-done', { title: 'Your Vesopa EPOS trial', extraFiles: [], sub: { public_id: String(req.query.s || '') }, state: 'error', gbp: subs.gbp, longDate: subs.longDate });
  }
});

router.post('/trial/retry', async (req, res) => {
  try {
    const url = await subs.retryCardCheck(String(req.body.s || ''));
    return url ? res.redirect(303, url) : res.redirect(303, `/trial/done?s=${encodeURIComponent(String(req.body.s || ''))}`);
  } catch (e) {
    console.error('[trial] retry:', e.message);
    res.redirect(303, '/trial?error=retry');
  }
});

router.post('/trial/cancel', async (req, res) => {
  try { await subs.cancelSignup(String(req.body.s || '')); } catch (e) { console.error('[trial] cancel:', e.message); }
  res.render('trial-done', { title: 'Your Vesopa EPOS trial', extraFiles: [], sub: null, state: 'cancelled', gbp: subs.gbp, longDate: subs.longDate });
});

router.get('/subscribe/return', async (req, res) => {
  try {
    const { inv, state } = await subs.invoiceState(String(req.query.i || ''));
    res.render('trial-done', { title: 'Your Vesopa EPOS payment', extraFiles: [], sub: null, inv, invState: state, state: inv ? '' : 'missing', gbp: subs.gbp, longDate: subs.longDate });
  } catch (e) {
    console.error('[subscribe] return page:', e.message);
    res.status(502).render('trial-done', { title: 'Your Vesopa EPOS payment', extraFiles: [], sub: null, state: 'error', gbp: subs.gbp, longDate: subs.longDate });
  }
});

router.post('/subscribe/retry', async (req, res) => {
  try {
    const url = await subs.retryInvoice(String(req.body.i || ''));
    res.redirect(303, url || `/subscribe/return?i=${encodeURIComponent(String(req.body.i || ''))}`);
  } catch (e) {
    console.error('[subscribe] retry:', e.message);
    res.redirect(303, `/subscribe/return?i=${encodeURIComponent(String(req.body.i || ''))}`);
  }
});

router.post('/webhooks/dojo-subscriptions', async (req, res) => {
  // Never trust the body: take the payment id and ask Dojo ourselves.
  const b = req.body || {};
  const id = (b.data && (b.data.paymentIntentId || b.data.id)) || b.paymentIntentId || b.id;
  res.json({ ok: true });
  if (typeof id === 'string' && /^pi_[A-Za-z0-9_]+$/.test(id)) {
    subs.refreshPayment(id).catch((e) => console.error('[subs webhook]', e.message));
    shop.refreshPayment(id).catch((e) => console.error('[shop webhook]', e.message));
  }
});

// ---- service API for admin.vesopa.com ---------------------------------------------

function service(req, res, next) {
  const want = String(process.env.SUBS_SERVICE_KEY || '');
  const got = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const ok = want.length >= 32 && got.length === want.length
    && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
  if (!ok) return res.status(401).json({ error: 'not allowed' });
  req.actor = String(req.get('x-vesopa-admin') || 'admin.vesopa.com').slice(0, 150);
  next();
}

router.get('/api/subs', service, async (req, res) => {
  try { res.json(await subs.list({ status: req.query.status ? String(req.query.status) : undefined })); } catch (e) { res.status(500).json({ error: e.message }); }
});
router.get('/api/subs/plans', service, (_req, res) => res.json({ plans: planList(), addons: subs.ADDONS }));
router.get('/api/subs/:id', service, async (req, res) => {
  try {
    const d = await subs.detail(Number(req.params.id));
    return d ? res.json(d) : res.status(404).json({ error: 'not found' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/api/subs/:id/:action', service, async (req, res) => {
  try { res.json({ ok: true, message: await subs.act(Number(req.params.id), req.params.action, req.body || {}, req.actor) }); }
  catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});

module.exports = { subscriptionsRouter: router };
