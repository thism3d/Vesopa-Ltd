'use strict';

/**
 * vesopaepos.com's own payment page and Stripe's webhook (2026-11-08).
 *
 *   GET  /pay/<pi>?k=<signature>   Apple Pay / Google Pay buttons, then card or
 *                                  Link, on our page (Stripe Elements). Paid, it
 *                                  goes to the order's or trial's own return page.
 *   POST /webhooks/stripe          Stripe's word that a payment moved; the id is
 *                                  read back from Stripe before anything changes.
 *   GET  /.well-known/apple-developer-merchantid-domain-association
 *                                  Apple Pay's domain file, served from Stripe's.
 */
const express = require('express');
const stripe = require('../stripe-billing');
const shop = require('../shop');
const subs = require('../subscriptions');
const { bytes } = require('../admin/util');

const router = express.Router();
const SITE = () => String(process.env.SITE_URL || 'https://vesopaepos.com').replace(/\/+$/, '');

/** Only our own pages as the way back, never an address from elsewhere. */
function backTo(pi) {
  const url = String((pi.metadata && pi.metadata.return_url) || '');
  return url.startsWith(SITE() + '/') ? url : SITE() + '/account';
}

router.get('/pay/:id', async (req, res, next) => {
  const id = String(req.params.id || '');
  if (!/^pi_[A-Za-z0-9]{10,}$/.test(id) || !stripe.signatureOk(id, req.query.k)) return next();
  if (!stripe.configured()) return next();
  try {
    const pi = await stripe.getForPage(id);
    const back = backTo(pi);
    if (pi.status === 'succeeded' || pi.status === 'processing') return res.redirect(303, back);
    res.set('Cache-Control', 'no-store');
    res.render('pay', {
      title: 'Secure payment | Vesopa EPOS',
      extraFiles: [], bytes,
      pi: {
        id: pi.id,
        amount: pi.amount,
        description: pi.description || 'Vesopa EPOS',
        clientSecret: pi.status === 'canceled' ? null : pi.client_secret,
        email: pi.receipt_email || '',
        kind: (pi.metadata && pi.metadata.vesopa_kind) || '',
      },
      back,
      publishableKey: stripe.publishableKey(),
      live: stripe.mode() === 'live',
      gbp: (m) => '£' + (Number(m || 0) / 100).toFixed(2),
    });
  } catch (e) {
    console.error('[pay] page:', e.message);
    next(e);
  }
});

router.post('/webhooks/stripe', async (req, res) => {
  const ok = stripe.verifyWebhook(req.rawBody, req.get('stripe-signature'));
  if (!ok) return res.status(400).json({ error: 'bad signature' });
  res.json({ received: true });
  const obj = (req.body && req.body.data && req.body.data.object) || {};
  const id = obj.object === 'payment_intent' ? obj.id : obj.payment_intent;
  if (typeof id === 'string' && /^pi_[A-Za-z0-9]+$/.test(id)) {
    subs.refreshPayment(id).catch((e) => console.error('[subs stripe webhook]', e.message));
    shop.refreshPayment(id).catch((e) => console.error('[shop stripe webhook]', e.message));
  }
});

let appleFile = null;
router.get('/.well-known/apple-developer-merchantid-domain-association', async (req, res, next) => {
  try {
    if (!appleFile) {
      const r = await fetch('https://stripe.com/files/apple-pay/apple-developer-merchantid-domain-association', { signal: AbortSignal.timeout(15000) });
      if (!r.ok) return next();
      appleFile = await r.text();
    }
    res.type('text/plain').send(appleFile);
  } catch (e) { next(); }
});

module.exports = { payRouter: router };
