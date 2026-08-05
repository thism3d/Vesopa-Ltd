/**
 * Site-wide constants.
 *
 * The pricing table is the same one the PHP site kept in
 * server_files/cookiesvariables.php. It stays in code rather than the database
 * because PayPal plans are created from it at checkout time — a price that can
 * be edited without a deploy is a price that can drift out of step with the
 * plan PayPal has already billed against.
 */

const SITE_URL = process.env.SITE_URL || 'https://vesopaepos.com';

// The back office is a separate app (vesopa_server) on its own subdomain, so
// "Back Office" in the nav is an outbound link rather than a route here.
const BACKOFFICE_URL = process.env.BACKOFFICE_URL || 'https://backoffice.vesopaepos.com';

/** Keyed by subscription length in months. */
const PRICING_PLANS = {
  1: {
    name: 'Starter Plan',
    price_per_month: 80.0,
    total_price: 80.0,
    discounted_price: 75.0,
    save_percentage: 6,
    vat: 15.0,
    total_with_vat: 90.0,
    interval: 'Month',
    interval_count: 1,
    paypal_image: 'https://vesopa.com/assets/paypal/paypal_starter_plan.png',
  },
  12: {
    name: 'Business Plan',
    price_per_month: 70.0,
    total_price: 840.0,
    discounted_price: 780.0,
    save_percentage: 7,
    vat: 117.0,
    total_with_vat: 897.0,
    interval: 'Year',
    interval_count: 1,
    paypal_image: 'https://vesopa.com/assets/paypal/paypal_business_plan.png',
  },
  24: {
    name: 'Enterprise Plan',
    price_per_month: 60.0,
    total_price: 1440.0,
    discounted_price: 1300.0,
    save_percentage: 10,
    vat: 195.0,
    total_with_vat: 1495.0,
    interval: 'Year',
    interval_count: 2,
    paypal_image: 'https://vesopa.com/assets/paypal/paypal_enterprise_plan.png',
  },
};

/** Only these three periods exist; anything else falls back to the popular one. */
const VALID_PERIODS = ['1', '12', '24'];
const DEFAULT_PERIOD = '12';

function resolvePeriod(raw) {
  return VALID_PERIODS.includes(String(raw)) ? String(raw) : DEFAULT_PERIOD;
}

/**
 * PHP's number_format($n, 2) — thousands separators and exactly two decimals.
 * Prices are rendered through this so "1,440.00" keeps its comma.
 */
function money(value) {
  return Number(value).toLocaleString('en-GB', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// checkout.php built a <stripe-buy-button> per plan into a $stringStripe
// variable that was never echoed — the markup never reached a browser. Not
// carried over: there is nothing to port, and it would have meant keeping live
// Stripe publishable keys and buy-button ids in source for a payment method the
// page does not offer. The originals are in the PHP if Stripe is ever wanted.

const CONTACT = {
  company: 'VESOPA EPOS LTD',
  address_line1: '1 High Street, Pontardawe',
  address_line2: 'Swansea, SA8 4HU',
  phone: '+44 7501 928043',
  phone_e164: '+447501928043',
  emergency_phone: '+44 1792 316282',
  emergency_phone_e164: '+441792316282',
  email: 'info@vesopa.com',
  support_email: 'support@vesopa.com',
  whatsapp: 'https://wa.me/447501928043?text=Hello%2C%20I%20am%20interested%20in%20Vesopa%20EPOS!',
  facebook: 'https://www.facebook.com/people/Vesopa/100027790131992/',
  linkedin: 'https://uk.linkedin.com/company/made-to-measure-nutrition',
};

/** Brand palette, from the 2025 brand book. Used by the email templates. */
const BRAND = {
  green: '#a5c715',
  ink: '#000000',
  theme_color: '#a5c715',
};

const APP_VERSION = '1.3.1.0';

module.exports = {
  SITE_URL,
  BACKOFFICE_URL,
  PRICING_PLANS,
  VALID_PERIODS,
  DEFAULT_PERIOD,
  resolvePeriod,
  money,
  CONTACT,
  BRAND,
  APP_VERSION,
};
