/**
 * PayPal subscription plans for the checkout page.
 *
 * The browser asks us to mint a plan, then hands back the subscription id it
 * got from PayPal for us to verify. The client secret stays here — a plan
 * created in the browser is a plan whose price the browser chose.
 */

const { plans: pricingPlans, resolvePeriod } = require('./plans-store');

const IS_LIVE = process.env.PAYPAL_ENV === 'live';
const API_BASE = IS_LIVE ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
const CURRENCY = 'GBP';

function credentials() {
  const id = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!id || !secret) throw new Error('PayPal is not configured (PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET)');
  return { id, secret };
}

/** The public half of the credentials, safe to hand to the checkout page. */
function clientId() {
  return process.env.PAYPAL_CLIENT_ID || '';
}

let cachedToken = null;

async function accessToken() {
  // PayPal tokens last ~9 hours; re-minting one per button click is a wasted
  // round trip on the critical path of a sale.
  if (cachedToken && cachedToken.expires > Date.now()) return cachedToken.value;

  const { id, secret } = credentials();
  const res = await fetch(`${API_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`PayPal auth failed: ${res.status} ${await res.text()}`);

  const data = await res.json();
  cachedToken = {
    value: data.access_token,
    // A minute of headroom, so a token does not expire mid-request.
    expires: Date.now() + (data.expires_in - 60) * 1000,
  };
  return cachedToken.value;
}

async function call(path, { method = 'POST', body } = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${await accessToken()}`,
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`PayPal ${method} ${path} failed: ${res.status} ${text}`);
  return text ? JSON.parse(text) : {};
}

/** Products are the thing plans hang off; one is enough for the whole catalogue. */
let productIdPromise = null;

function ensureProduct() {
  if (!productIdPromise) {
    productIdPromise = call('/v1/catalogs/products', {
      body: {
        name: 'Vesopa EPOS Subscription',
        description: 'Vesopa EPOS point-of-sale subscription',
        type: 'SERVICE',
        category: 'SOFTWARE',
      },
    })
      .then((p) => p.id)
      .catch((e) => {
        // Do not cache a failure, or the first bad network moment kills
        // checkout until the process restarts.
        productIdPromise = null;
        throw e;
      });
  }
  return productIdPromise;
}

/**
 * Create the billing plan for one of our three periods.
 * The price is looked up from PRICING_PLANS by period — never taken from the
 * request — so a tampered payload cannot buy a £1300 plan for £1.
 */
async function createPlan(rawPeriod) {
  const period = resolvePeriod(rawPeriod);
  const plan = pricingPlans()[period];
  const productId = await ensureProduct();

  return call('/v1/billing/plans', {
    body: {
      product_id: productId,
      name: plan.name,
      description: `${plan.name} — Vesopa EPOS`,
      status: 'ACTIVE',
      billing_cycles: [
        {
          frequency: {
            interval_unit: plan.interval.toUpperCase(),
            interval_count: plan.interval_count,
          },
          tenure_type: 'REGULAR',
          sequence: 1,
          // 0 = renew forever, until the customer cancels.
          total_cycles: 0,
          pricing_scheme: {
            fixed_price: {
              value: plan.discounted_price.toFixed(2),
              currency_code: CURRENCY,
            },
          },
        },
      ],
      payment_preferences: {
        auto_bill_outstanding: true,
        setup_fee_failure_action: 'CONTINUE',
        payment_failure_threshold: 3,
      },
    },
  });
}

/** Read a subscription back from PayPal, to confirm it is genuinely ACTIVE. */
function getSubscription(subscriptionId) {
  return call(`/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}`, { method: 'GET' });
}

module.exports = { call, createPlan, getSubscription, clientId, IS_LIVE, CURRENCY };
