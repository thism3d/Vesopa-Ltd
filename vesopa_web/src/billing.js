'use strict';

/**
 * Who takes vesopaepos.com's money (2026-11-08): Stripe when its keys are in
 * the site's .env, Dojo otherwise, or Dojo when PAYMENTS_PROVIDER=dojo. Dojo
 * stays whole (dojo-billing.js): one line in .env switches back.
 *
 * A payment already started keeps its own provider: Dojo's ids are
 * pi_sandbox_... (its sandbox, the only Dojo key this site has had), Stripe's
 * pi_ followed by letters and digits only.
 */
const dojo = require('./dojo-billing');
const stripe = require('./stripe-billing');

function current() {
  const want = String(process.env.PAYMENTS_PROVIDER || '').toLowerCase();
  if (want === 'dojo') return dojo;
  return stripe.configured() ? stripe : dojo;
}

const isStripeId = (id) => /^pi_[A-Za-z0-9]{10,}$/.test(String(id || '')) && !/^pi_sandbox_/.test(String(id));
const forId = (id) => (isStripeId(id) && stripe.configured() ? stripe : dojo);

module.exports = {
  get provider() { return current() === stripe ? 'stripe' : 'dojo'; },
  configured: () => current().configured(),
  mode: () => current().mode(),
  checkoutUrl: (id) => forId(id).checkoutUrl(id),
  createPaymentIntent: (o) => current().createPaymentIntent(o),
  createSetupIntent: (o) => dojo.createSetupIntent(o),
  getSetupIntent: (id) => dojo.getSetupIntent(id),
  refreshClientSecret: (id) => forId(id).refreshClientSecret(id),
  getPaymentIntent: (id) => forId(id).getPaymentIntent(id),
  chargePaymentIntent: (id) => forId(id).chargePaymentIntent(id),
  refund: (id, amount, reason) => forId(id).refund(id, amount, reason),
  isPaid: (pi) => dojo.isPaid(pi) || stripe.isPaid(pi),
  isFailed: (pi) => dojo.isFailed(pi) || stripe.isFailed(pi),
  cardLabel: (pi) => (pi && pi.stripe_status ? stripe.cardLabel(pi) : dojo.cardLabel(pi)),
  DojoError: dojo.DojoError,
  isStripeId,
};
