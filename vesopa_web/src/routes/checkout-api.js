/**
 * The PayPal endpoints the checkout page calls.
 *
 * Responses keep the `{ status: 1 | 0, msg, ... }` shape the front end already
 * spoke, so the page's error handling did not have to be redesigned.
 */

const express = require('express');
const { call, createPlan, getSubscription, CURRENCY } = require('../paypal');
const { plans: pricingPlans, resolvePeriod } = require('../plans-store');
const { recordSubscription, recordOrder } = require('../payments');

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
router.post('/plan', async (req, res) => {
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
router.post('/subscription/capture', async (req, res) => {
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
router.post('/order', async (req, res) => {
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
router.post('/order/capture', async (req, res) => {
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

module.exports = { checkoutApiRouter: router };
