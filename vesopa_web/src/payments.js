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

  return null;
}

module.exports = { recordSubscription, recordOrder, findPaymentByReference };
