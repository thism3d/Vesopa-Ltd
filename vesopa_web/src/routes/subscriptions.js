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
    error: null,
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
    trialView(res.status(400), req, { error: e.message });
  }
});

router.get('/trial/done', async (req, res, next) => {
  try {
    const sub = await subs.confirmCard(String(req.query.s || ''));
    res.render('trial-done', { title: 'Your Vesopa EPOS trial', extraFiles: [], sub, gbp: subs.gbp, longDate: subs.longDate });
  } catch (e) { next(e); }
});

router.get('/subscribe/return', async (req, res, next) => {
  try {
    const inv = await subs.refreshByNumber(String(req.query.i || ''));
    res.render('trial-done', { title: 'Your Vesopa EPOS payment', extraFiles: [], sub: null, inv, gbp: subs.gbp, longDate: subs.longDate });
  } catch (e) { next(e); }
});

router.post('/webhooks/dojo-subscriptions', async (req, res) => {
  // Never trust the body: take the payment id and ask Dojo ourselves.
  const b = req.body || {};
  const id = (b.data && (b.data.paymentIntentId || b.data.id)) || b.paymentIntentId || b.id;
  res.json({ ok: true });
  if (typeof id === 'string' && /^pi_[A-Za-z0-9_]+$/.test(id)) {
    subs.refreshPayment(id).catch((e) => console.error('[subs webhook]', e.message));
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
