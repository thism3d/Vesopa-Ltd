/**
 * Recording completed PayPal payments.
 *
 * The PHP site verified payments with PayPal correctly and then dropped them:
 * every INSERT in paypal_subscription_init.php and paypal_checkout_validate.php
 * was commented out, and both files gated their success response on a row id
 * those INSERTs would have produced. The upshot was that a customer who paid
 * saw the button spin and nothing else, and support had no record of the sale.
 * This module is the missing half.
 */

const crypto = require('crypto');
const { pool } = require('./db');
const { plans: pricingPlans } = require('./plans-store');

/**
 * The handle we put in the receipt URL.
 *
 * The PHP used base64(paypal_order_id), which is reversible — anyone could
 * decode a friend's link, or encode a guessed order id and read back a
 * stranger's name, email and amount. A random reference is not guessable and
 * carries no information.
 */
function newReference() {
  return crypto.randomBytes(16).toString('hex');
}

/** PayPal timestamps are ISO 8601; MySQL DATETIME is not. */
function toMysqlDateTime(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 19).replace('T', ' ');
}

function payerFrom(source) {
  if (!source) return {};
  const name = source.name || {};
  return {
    payer_id: source.payer_id || null,
    payer_name: [name.given_name, name.surname].filter(Boolean).join(' ').trim() || null,
    payer_email: source.email_address || null,
  };
}

/**
 * Persist a verified ACTIVE subscription.
 * Returns the reference for the receipt URL. Re-recording the same PayPal
 * subscription returns the reference already issued rather than a second row,
 * so a customer refreshing the approval does not book twice.
 */
async function recordSubscription({ period, subscription, accountEmail }) {
  const plan = pricingPlans()[period];
  const subscrId = subscription.id;

  const [existing] = await pool.query(
    'SELECT reference FROM paypal_subscriptions WHERE paypal_subscr_id = ?',
    [subscrId]
  );
  if (existing.length) return existing[0].reference;

  const billing = subscription.billing_info || {};
  const lastPayment = billing.last_payment || {};
  const payer = payerFrom(subscription.subscriber);
  const reference = newReference();

  await pool.query(
    `INSERT INTO paypal_subscriptions
       (reference, period_months, plan_name, paypal_order_id, paypal_plan_id,
        paypal_subscr_id, valid_from, valid_to, paid_amount, currency_code,
        payer_id, payer_name, payer_email, account_email, status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      reference,
      Number(period),
      plan.name,
      subscription._order_id || null,
      subscription.plan_id || null,
      subscrId,
      toMysqlDateTime(subscription.start_time),
      toMysqlDateTime(billing.next_billing_time),
      lastPayment.amount ? Number(lastPayment.amount.value) : plan.discounted_price,
      (lastPayment.amount && lastPayment.amount.currency_code) || 'GBP',
      payer.payer_id || null,
      payer.payer_name || null,
      payer.payer_email || null,
      accountEmail || null,
      subscription.status || null,
    ]
  );

  return reference;
}

/** Persist a verified COMPLETED one-off order (the 24-month plan). */
async function recordOrder({ period, order, accountEmail }) {
  const plan = pricingPlans()[period];
  const orderId = order.id;

  const [existing] = await pool.query(
    'SELECT reference FROM paypal_transactions WHERE paypal_order_id = ?',
    [orderId]
  );
  if (existing.length) return existing[0].reference;

  const unit = (order.purchase_units && order.purchase_units[0]) || {};
  const capture = (unit.payments && unit.payments.captures && unit.payments.captures[0]) || {};
  const amount = unit.amount || {};
  const payer = order.payer || {};
  const payerName = payer.name || {};
  const paymentSource = order.payment_source ? Object.keys(order.payment_source)[0] : null;
  const reference = newReference();

  await pool.query(
    `INSERT INTO paypal_transactions
       (reference, period_months, plan_name, paypal_order_id, transaction_id,
        paid_amount, currency_code, payment_source, payer_id, payer_name,
        payer_email, payer_country, account_email, status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      reference,
      Number(period),
      plan.name,
      orderId,
      capture.id || null,
      amount.value ? Number(amount.value) : plan.discounted_price,
      amount.currency_code || 'GBP',
      paymentSource,
      payer.payer_id || null,
      [payerName.given_name, payerName.surname].filter(Boolean).join(' ').trim() || null,
      payer.email_address || null,
      (payer.address && payer.address.country_code) || null,
      accountEmail || null,
      capture.status || order.status || null,
    ]
  );

  return reference;
}

/**
 * Persist a verified paid Stripe Checkout Session.
 *
 * One function for both shapes: `mode: subscription` fills
 * `stripe_subscription_id`, `mode: payment` leaves it null. Re-recording the
 * same session returns the reference already issued rather than a second row,
 * so the browser return and a retry cannot book twice — the same guarantee the
 * PayPal pair give, by the same means.
 */
async function recordStripe({ period, session, accountEmail }) {
  const plan = pricingPlans()[period];
  const sessionId = session.id;

  const [existing] = await pool.query(
    'SELECT reference FROM stripe_payments WHERE stripe_session_id = ?',
    [sessionId]
  );
  if (existing.length) return existing[0].reference;

  const intent = session.payment_intent && typeof session.payment_intent === 'object'
    ? session.payment_intent
    : null;
  const method = intent && intent.payment_method && typeof intent.payment_method === 'object'
    ? intent.payment_method
    : null;

  // "visa ···· 4242" reads better on an admin screen than "card", and is all
  // Stripe gives us that a human would recognise.
  let methodLabel = null;
  if (method && method.type === 'card' && method.card) {
    methodLabel = `${method.card.brand || 'card'} ···· ${method.card.last4 || ''}`.trim();
  } else if (method && method.type) {
    methodLabel = method.type;
  } else if (Array.isArray(session.payment_method_types)) {
    methodLabel = session.payment_method_types.join(' · ') || null;
  }

  const subscription = session.subscription && typeof session.subscription === 'object'
    ? session.subscription.id
    : session.subscription || null;

  const details = session.customer_details || {};
  const reference = newReference();

  await pool.query(
    `INSERT INTO stripe_payments
       (reference, period_months, plan_name, stripe_session_id, stripe_payment_intent,
        stripe_subscription_id, stripe_customer_id, paid_amount, currency_code,
        payment_method, payer_name, payer_email, account_email, status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      reference,
      Number(period),
      plan.name,
      sessionId,
      intent ? intent.id : (typeof session.payment_intent === 'string' ? session.payment_intent : null),
      subscription,
      typeof session.customer === 'string' ? session.customer : (session.customer && session.customer.id) || null,
      // amount_total is in minor units; the plan price is the fallback for the
      // vanishingly rare session that has none.
      session.amount_total != null ? Number(session.amount_total) / 100 : plan.discounted_price,
      (session.currency || 'gbp').toUpperCase(),
      methodLabel ? methodLabel.slice(0, 120) : null,
      details.name || null,
      details.email || null,
      accountEmail || details.email || null,
      session.payment_status || null,
    ]
  );

  return reference;
}

/**
 * Look up a payment for the receipt page, whichever kind it was.
 * Returns null for an unknown reference — the page then says so rather than
 * leaking whether the reference format was close.
 */
async function findPaymentByReference(reference) {
  const [subs] = await pool.query(
    `SELECT reference, plan_name, paid_amount, currency_code, status,
            payer_name, payer_email, account_email, paypal_subscr_id
     FROM paypal_subscriptions WHERE reference = ?`,
    [reference]
  );
  if (subs.length) return { ...subs[0], kind: 'subscription' };

  const [orders] = await pool.query(
    `SELECT reference, plan_name, paid_amount, currency_code, status,
            payer_name, payer_email, account_email, transaction_id
     FROM paypal_transactions WHERE reference = ?`,
    [reference]
  );
  if (orders.length) return { ...orders[0], kind: 'order' };

  const [stripes] = await pool.query(
    `SELECT reference, plan_name, paid_amount, currency_code, status,
            payer_name, payer_email, account_email, payment_method,
            stripe_subscription_id, stripe_payment_intent AS transaction_id
     FROM stripe_payments WHERE reference = ?`,
    [reference]
  );
  // A Stripe subscription and a Stripe one-off are told apart by whether there
  // is a subscription id, so the receipt page can keep saying "subscription"
  // or "order" without knowing which provider took the money.
  if (stripes.length) {
    return { ...stripes[0], kind: stripes[0].stripe_subscription_id ? 'subscription' : 'order' };
  }

  return null;
}

module.exports = { recordSubscription, recordOrder, recordStripe, findPaymentByReference };
