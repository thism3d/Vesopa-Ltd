/**
 * Stripe Checkout Sessions for the checkout page.
 *
 * The card, Apple Pay and Google Pay tiles all lead here. They are ONE gateway,
 * not three: a Checkout Session shows whichever of them the customer's browser
 * can actually offer, decided by Stripe from what is enabled in the Dashboard
 * and what the device supports. Listing them separately on our own page is a
 * description of what the customer will find, not three different integrations.
 *
 * Hosted rather than embedded, matching how the PayPal flow already leaves the
 * site: an embedded Payment Element would need an Apple Pay domain-association
 * file served from our own origin, and the hosted page needs none because it is
 * served from a domain Stripe already owns.
 *
 * The price is looked up from the period, server side — the browser sends only
 * which plan it wants, never what it costs. Same rule as paypal.js.
 */

const { plans: pricingPlans, resolvePeriod } = require('./plans-store');

const API_BASE = 'https://api.stripe.com/v1';
const API_VERSION = '2024-06-20';
const CURRENCY = 'GBP';

const SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY || '';

/** Is Stripe usable at all? The checkout page dims the tiles when it is not. */
function isConfigured() {
  return Boolean(SECRET_KEY);
}

/** The public half, safe to hand to the checkout page. */
function publishableKey() {
  return PUBLISHABLE_KEY;
}

// ---------------------------------------------------------------------------
// Stripe's API is form-encoded with bracket notation for nested fields —
// `line_items[0][price_data][unit_amount]` rather than JSON.
// ---------------------------------------------------------------------------
function flatten(obj, prefix, out) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === '') continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (item && typeof item === 'object') flatten(item, `${key}[${i}]`, out);
        else out.push([`${key}[${i}]`, String(item)]);
      });
    } else if (typeof v === 'object') {
      flatten(v, key, out);
    } else {
      out.push([key, String(v)]);
    }
  }
  return out;
}

async function call(path, { method = 'POST', body } = {}) {
  if (!isConfigured()) throw new Error('Stripe is not configured (STRIPE_SECRET_KEY)');

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Stripe-Version': API_VERSION,
    },
    ...(body ? { body: flatten(body, '', []).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&') } : {}),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Stripe returned an unreadable response (${res.status})`);
  }
  if (!res.ok) throw new Error(json?.error?.message || `Stripe ${method} ${path} failed: ${res.status}`);
  return json;
}

/**
 * Stripe's recurring interval, from the plan row's own wording.
 *
 * The rows say "Month"/"Year" with a count; Stripe wants lowercase and the
 * same count. Read from the plan rather than derived from period_months so a
 * 24-month term stays "2 years" rather than becoming "24 months" — the
 * customer's card statement should say what they were sold.
 */
function recurringFrom(plan) {
  return {
    interval: String(plan.interval || 'month').toLowerCase(),
    interval_count: Number(plan.interval_count) || 1,
  };
}

/**
 * Open a Checkout Session for one of our periods.
 *
 * A 24-month plan is a single non-renewing payment; the shorter terms renew.
 * That split is the same one paypal.js makes, and for the same reason — it is
 * what the plan actually is, not a quirk of either provider.
 *
 * @returns {Promise<{id, url}>}
 */
async function createSession({ period: rawPeriod, email, successUrl, cancelUrl }) {
  const period = resolvePeriod(rawPeriod);
  const plan = pricingPlans()[period];
  const oneOff = period === '24';

  // Minor units, as an integer. The plan holds major units, so this is the one
  // place the conversion happens for Stripe.
  const unitAmount = Math.round(Number(plan.discounted_price) * 100);

  const session = await call('/checkout/sessions', {
    body: {
      mode: oneOff ? 'payment' : 'subscription',
      customer_email: email || undefined,
      /*
       * ADAPTIVE PRICING OFF.
       *
       * Left on, Stripe re-presents the total in the viewer's local currency
       * and adds its own conversion fee — a customer sent from a page reading
       * "Pay GBP 780 by card" landed on one reading "BDT 134,710.20 (includes
       * 3.75% conversion fee)". The figure was arithmetically right and the
       * experience was not: the checkout quotes GBP, the plan renews in GBP,
       * and the amount on the payment page has to be the amount they agreed to.
       */
      adaptive_pricing: { enabled: 'false' },
      // {CHECKOUT_SESSION_ID} is a literal placeholder Stripe substitutes.
      success_url: `${successUrl}${successUrl.includes('?') ? '&' : '?'}session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: cancelUrl,
      // Carried through the whole session so the capture side knows which plan
      // was bought without trusting anything the browser sends back.
      client_reference_id: `VESOPA-${period}`,
      metadata: { period, plan_name: plan.name },
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: CURRENCY.toLowerCase(),
            unit_amount: unitAmount,
            product_data: { name: `${plan.name} — Vesopa EPOS` },
            ...(oneOff ? {} : { recurring: recurringFrom(plan) }),
          },
        },
      ],
    },
  });

  return { id: session.id, url: session.url };
}

/**
 * Read a session back from Stripe, to confirm it is genuinely paid.
 * Nothing the browser hands back is trusted; the session id only says which
 * session to ask about.
 */
function getSession(sessionId) {
  return call(
    `/checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=payment_intent.payment_method&expand[]=subscription`,
    { method: 'GET' },
  );
}

function isPaid(session) {
  return Boolean(session) && session.payment_status === 'paid';
}

module.exports = { call, createSession, getSession, isPaid, isConfigured, publishableKey, CURRENCY };
