/**
 * The payment endpoints the checkout page calls — PayPal and Stripe.
 *
 * Mounted at `/api`, and every route names its own provider, so the two cannot
 * collide and neither has to know the other's paths. The PayPal URLs are
 * unchanged from when this router was mounted at `/api/paypal`: they are in
 * the checkout page's JavaScript already, and a payment endpoint that moves is
 * a checkout that breaks for anyone holding a stale page.
 *
 * Responses keep the `{ status: 1 | 0, msg, ... }` shape the front end already
 * spoke, so the page's error handling did not have to be redesigned.
 */

const express = require('express');
const { call, createPlan, getSubscription, CURRENCY } = require('../paypal');
const stripe = require('../stripe');
const { plans: pricingPlans, resolvePeriod } = require('../plans-store');
const { recordSubscription, recordOrder, recordStripe } = require('../payments');
const { SITE_URL } = require('../config');

const router = express.Router();

/** Never echo a PayPal or database error to the browser; log it, say less. */
function fail(res, e, context) {
  console.error(`[checkout] ${context}:`, e.message);
  return res.json({ status: 0, msg: 'We could not complete that with PayPal. Please try again.' });
}

/**
 * Mint the billing plan for a recurring subscription (1 or 12 months).
 * The price comes from the period, server side — the browser sends only which
 * plan it wants, never what it costs.
 */
router.post('/paypal/plan', async (req, res) => {
  try {
    const plan = await createPlan(req.body && req.body.period);
    return res.json({ status: 1, plan_id: plan.id });
  } catch (e) {
    return fail(res, e, 'createPlan');
  }
});

/**
 * Confirm a subscription the customer just approved.
 * We ask PayPal what the subscription actually is rather than believing the
 * browser: `data.subscriptionID` arrives from client-side JavaScript and a
 * forged one would otherwise book a free account.
 */
router.post('/paypal/subscription/capture', async (req, res) => {
  const { subscription_id: subscriptionId, order_id: orderId, email } = req.body || {};
  const period = resolvePeriod(req.body && req.body.period);

  if (!subscriptionId) {
    return res.json({ status: 0, msg: 'Missing subscription id.' });
  }

  try {
    const subscription = await getSubscription(subscriptionId);
    if (subscription.status !== 'ACTIVE') {
      return res.json({ status: 0, msg: `Subscription is ${subscription.status || 'not active'}.` });
    }

    subscription._order_id = orderId || null;
    const reference = await recordSubscription({ period, subscription, accountEmail: email });
    return res.json({ status: 1, msg: 'Subscription created!', ref_id: reference });
  } catch (e) {
    return fail(res, e, 'subscription capture');
  }
});

/**
 * Create the one-off order for the 24-month plan.
 * Built here rather than in the browser so the amount is ours, not the page's.
 */
router.post('/paypal/order', async (req, res) => {
  const period = resolvePeriod(req.body && req.body.period);
  if (period !== '24') {
    return res.json({ status: 0, msg: 'That plan is billed as a subscription.' });
  }
  const plan = pricingPlans()[period];
  const value = plan.discounted_price.toFixed(2);

  try {
    const order = await call('/v2/checkout/orders', {
      body: {
        intent: 'CAPTURE',
        purchase_units: [
          {
            custom_id: 'VESOPAEPOS2YEAR',
            description: plan.name,
            amount: {
              currency_code: CURRENCY,
              value,
              breakdown: { item_total: { currency_code: CURRENCY, value } },
            },
            items: [
              {
                name: 'Vesopa EPOS Subscription',
                description: '2-year subscription, non-renewing',
                unit_amount: { currency_code: CURRENCY, value },
                quantity: '1',
                category: 'DIGITAL_GOODS',
              },
            ],
          },
        ],
      },
    });
    return res.json({ status: 1, order_id: order.id });
  } catch (e) {
    return fail(res, e, 'createOrder');
  }
});

/**
 * Capture and record the one-off order.
 * Capturing here rather than in the browser means the money is taken by the
 * same request that writes the row — the PHP captured client-side and then
 * asked the server to verify, which left a window where a customer could be
 * charged for a sale we never saw.
 */
router.post('/paypal/order/capture', async (req, res) => {
  const { order_id: orderId, email } = req.body || {};
  const period = resolvePeriod(req.body && req.body.period);

  if (!orderId) return res.json({ status: 0, msg: 'Missing order id.' });

  try {
    let order;
    try {
      order = await call(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`);
    } catch (e) {
      // ORDER_ALREADY_CAPTURED means the customer double-submitted; the money
      // is taken and reading the order back is the right recovery, not an error.
      if (!/ORDER_ALREADY_CAPTURED/.test(e.message)) throw e;
      order = await call(`/v2/checkout/orders/${encodeURIComponent(orderId)}`, { method: 'GET' });
    }

    if (order.status !== 'COMPLETED') {
      return res.json({ status: 0, msg: `Payment is ${order.status || 'incomplete'}.` });
    }

    const reference = await recordOrder({ period, order, accountEmail: email });
    return res.json({ status: 1, msg: 'Transaction completed!', ref_id: reference });
  } catch (e) {
    return fail(res, e, 'order capture');
  }
});

// ---------------------------------------------------------------------------
// Stripe — card, Apple Pay and Google Pay
// ---------------------------------------------------------------------------
/**
 * Open a Checkout Session and hand back the URL to send the browser to.
 *
 * The three tiles on the page (card, Apple Pay, Google Pay) all post here. They
 * are one gateway: Stripe decides which of them the customer can actually use
 * from what the device supports, so there is nothing here that varies by which
 * tile was clicked.
 */
router.post('/stripe/session', async (req, res) => {
  if (!stripe.isConfigured()) {
    return res.json({ status: 0, msg: 'Card payment is not available right now.' });
  }
  const base = String(SITE_URL || '').replace(/\/+$/, '');
  try {
    const session = await stripe.createSession({
      period: req.body && req.body.period,
      email: req.body && req.body.email,
      successUrl: `${base}/api/stripe/return`,
      cancelUrl: `${base}/checkout?period=${resolvePeriod(req.body && req.body.period)}`,
    });
    return res.json({ status: 1, url: session.url, session_id: session.id });
  } catch (e) {
    console.error('[checkout] stripe session:', e.message);
    return res.json({ status: 0, msg: 'We could not start that payment. Please try again.' });
  }
});

/**
 * Where Stripe sends the browser back.
 *
 * A GET that redirects, not JSON — the customer arrives here from Stripe's own
 * page, so this is a navigation and has to end on something they can read.
 *
 * NOTHING FROM THIS REQUEST IS TRUSTED. `session_id` says only which session to
 * ask Stripe about; whether it was paid comes from Stripe's own answer.
 */
router.get('/stripe/return', async (req, res) => {
  const sessionId = String(req.query.session_id || '');
  if (!sessionId) return res.redirect('/checkout');

  try {
    const session = await stripe.getSession(sessionId);
    if (!stripe.isPaid(session)) {
      console.warn('[checkout] stripe session not paid:', sessionId, session.payment_status);
      return res.redirect(`/checkout?period=${resolvePeriod(session.metadata && session.metadata.period)}`);
    }
    const period = resolvePeriod(session.metadata && session.metadata.period);
    const reference = await recordStripe({
      period,
      session,
      accountEmail: (session.customer_details && session.customer_details.email) || null,
    });
    return res.redirect(`/payment-status?ref=${encodeURIComponent(reference)}`);
  } catch (e) {
    console.error('[checkout] stripe return:', e.message);
    return res.redirect('/checkout');
  }
});

module.exports = { checkoutApiRouter: router };
