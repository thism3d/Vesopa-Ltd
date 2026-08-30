/**
 * Site-wide constants and money helpers.
 *
 * Prices are NOT here — they live in the `plans` and `tlds` tables so an admin
 * can change one without a deploy. That is the opposite of the EPOS site, where
 * the subscription prices are pinned in code because PayPal plan objects are
 * created from them; here nothing external is created from a price, so nothing
 * can drift out of step with it.
 */

const SITE_URL = process.env.SITE_URL || 'http://localhost:5075';
const MAIN_SITE_URL = process.env.MAIN_SITE_URL || 'https://vesopaepos.com';

/**
 * HestiaCP's own web interface, e.g. https://panel.vesopa.com:2083 — where the
 * things this panel deliberately does not reimplement actually live.
 *
 * This site covers what a customer needs weekly: databases, mailboxes, DNS,
 * backups, SSL. It does NOT cover the file manager, the web terminal, cron, or
 * editing the account profile, and it should not — those are a control panel's
 * job, they change with every Hestia release, and a half-copy of them here
 * would be a worse version that silently drifts out of date.
 *
 * So the customer is sent to the real one instead. They can sign in: the
 * account and password provisioning generated for them are in their welcome
 * email (see provisioning.js), and they are the same credentials this link
 * lands on. Blank this and every link to it disappears from the panel rather
 * than rendering a dead button — which is the right behaviour on a node whose
 * panel is not published on a name customers can reach.
 */
const CONTROL_PANEL_URL = (process.env.HESTIA_PANEL_URL || '').replace(/\/+$/, '');

/**
 * The currency the CATALOGUE IS PRICED IN — not the currency a given visitor
 * sees. Every `*_pence` column in the database is this one; USD and CAD are
 * derived from it at request time by src/currency.js, and which one a visitor
 * gets is decided by src/currency-context.js.
 *
 * There is no site-wide "current currency" any more, and there deliberately is
 * no module-level export that looks like one. A module-level current currency
 * is a variable one request can set and the next request can read, which in a
 * shared Node process means two people checking out at the same moment can be
 * charged in each other's money. It lives on `req`, or it does not exist.
 *
 * VAT moved out for the same reason: it is 20% inside a GBP price and 0% inside
 * a USD one, so it is a property of the currency row, not a constant.
 */
const BASE_CURRENCY = process.env.BASE_CURRENCY || process.env.CURRENCY || 'GBP';

const CONTACT = {
  company: 'VESOPA EPOS LTD',
  address_line1: '1 High Street, Pontardawe',
  address_line2: 'Swansea, SA8 4HU',
  phone: '+44 7501 928043',
  phone_e164: '+447501928043',
  email: 'hosting@vesopaepos.com',
  support_email: 'hosting@vesopaepos.com',
};

/** The 2026 mark: black wordmark, one lime slash. */
const BRAND = {
  lime: '#A5C715',
  lime_ink: '#6E8A0E',
  lime_deep: '#2F3B05',
  on_lime: '#10130A',
  ink: '#111111',
  theme_color: '#A5C715',
};

const NAMESERVERS = [
  process.env.NS1 || 'ns1.vesopa.com',
  process.env.NS2 || 'ns2.vesopa.com',
];

/**
 * The name a customer points a record at when they keep DNS elsewhere.
 *
 * THE NODE'S IP ADDRESS IS NEVER SHOWN. Not on a customer page, not on an admin
 * page, not in an email. A raw address in the panel is a permanent commitment:
 * every customer who copies it into a zone somewhere we cannot see pins us to
 * that number, and moving a site to another box — or the box to another
 * address — silently breaks every one of them, with no list of who to warn.
 *
 * A hostname is the same instruction with the indirection kept. `A record ->
 * point.vesopa.com` becomes our problem to keep true rather than theirs, and
 * changing where it points moves everybody at once.
 */
const POINT_HOSTNAME = process.env.POINT_HOSTNAME || 'point.vesopa.com';

/**
 * How long a domain somebody already owns has to point at us.
 *
 * Anyone can open an account and add a domain they own — that is how a customer
 * moving a live site checks the panel out before they switch. What they cannot
 * do is leave it there: a name that never points at our nameservers is not
 * hosted here, and a list of domains a company does not actually serve is a
 * list nobody can trust. Three days is long enough for a registrar's control
 * panel and DNS propagation together, and short enough that the list stays true.
 *
 * ONLY EXTERNAL DOMAINS ARE EVER DROPPED. A domain registered or transferred
 * through us was paid for and belongs to the customer whether it points here or
 * not; removing one of those would be taking away something they own.
 */
const DOMAIN_NS_GRACE_DAYS = Number(process.env.DOMAIN_NS_GRACE_DAYS || 3);

/**
 * How long a gateway session is worth asking about.
 *
 * A payment attempt is opened, the customer is sent to the gateway, and then
 * anything can happen — including nothing. The reconciler asks the gateway what
 * became of each pending attempt until it is settled or this long has passed,
 * at which point the session is dead at the gateway too and the attempt is
 * closed as expired. See src/jobs.js.
 */
const PAYMENT_SESSION_MINUTES = Number(process.env.PAYMENT_SESSION_MINUTES || 90);

/** How often the background jobs run, in minutes. 0 turns them off entirely. */
const JOB_INTERVAL_MINUTES = Number(process.env.JOB_INTERVAL_MINUTES || 5);

/**
 * The four terms every plan is sold on. `months` drives the renewal date;
 * `column` names the price column on the plan row.
 *
 * The order matters: the pricing toggle renders them left to right, and
 * DEFAULT_TERM_MONTHS decides which one a page opens on. It opens on 1 year
 * rather than monthly because that is both the better deal and the one whose
 * headline rate the marketing quotes — landing on the premium monthly price
 * would make the whole catalogue look twice as expensive as it is.
 */
const TERMS = [
  { months: 1, column: 'monthly_pence', label: 'Monthly', short: 'mo' },
  { months: 12, column: 'annual_pence', label: '1 year', short: 'yr' },
  { months: 24, column: 'biennial_pence', label: '2 years', short: '2yr' },
  { months: 36, column: 'triennial_pence', label: '3 years', short: '3yr' },
];

const DEFAULT_TERM_MONTHS = 12;

/**
 * The shortest term that earns the free domain.
 *
 * Monthly is deliberately excluded: a domain costs us real money at the
 * registry the moment it is registered and cannot be handed back, so giving one
 * away with a £5.99 commitment that can be cancelled in four weeks loses money
 * on every taker. A year or more earns it.
 */
const FREE_DOMAIN_MIN_MONTHS = 12;

/**
 * The free domain is any extension whose FIRST-YEAR price is at or under this.
 *
 * A price cap rather than a hand-maintained list of extensions: a list has to
 * be edited every time a TLD is added to the catalogue, and the day someone
 * forgets is the day a £39.99 .io is given away with a £35.88 plan. The cap
 * cannot be got wrong by omission.
 *
 * £20 covers .co.uk, .uk, .com, .net, .org, .shop, .online and most of the
 * catalogue; it excludes .io, .design, .london and the other genuinely dear
 * ones. Renewal is always at the normal price and is shown before claiming.
 *
 * IT IS A BASE-CURRENCY FIGURE and it is checked against the base-currency
 * price, never against the converted one. A cap that lived in the visitor's
 * currency would move every time the rate did: set it to $25 to mirror £20 and
 * the day the pound slips, extensions that were never meant to be free quietly
 * become free — to some visitors and not others, for reasons nobody can see
 * from the admin. One cap, one currency, same answer for everybody.
 */
const FREE_DOMAIN_MAX_PENCE = Number(process.env.FREE_DOMAIN_MAX_PENCE || 2000);

/**
 * Is this extension one we will give away? `tld` is a row from `tlds`.
 *
 * BOTH the first-year price and the RENEWAL must be inside the cap, and the
 * renewal is the important half.
 *
 * `.shop` costs £2.99 to register and £29.99 to renew — the registry discounts
 * year one hard. Handing that over as the free domain would mean a customer
 * accepting a gift and being billed £29.99 twelve months later for a name they
 * did not choose on price and now cannot cheaply leave. That is precisely the
 * renewal cliff this site says on its own pricing page that it does not run,
 * and doing it inside a gift would be worse than doing it in a sale.
 *
 * Checking both leaves the extensions a business actually wants — .co.uk, .uk,
 * .com, .net, .org, .dev, .app, .biz, .eu — and excludes every cliff.
 */
function tldQualifiesFree(tld) {
  if (!tld || !tld.active) return false;
  // `base_*` is the sterling price the admin typed; it is present on every row
  // that has been through pricing.convertRow(). The fallback covers a raw row
  // read straight from the database, where the two are the same thing.
  const register = Number(tld.base_register_pence ?? tld.register_pence);
  const renew = Number(tld.base_renew_pence ?? tld.renew_pence);
  return register <= FREE_DOMAIN_MAX_PENCE && renew <= FREE_DOMAIN_MAX_PENCE;
}

function resolveTerm(raw) {
  const months = Number(raw);
  return TERMS.find((t) => t.months === months)
    || TERMS.find((t) => t.months === DEFAULT_TERM_MONTHS);
}

/** Does this term qualify for the free domain? */
function termEarnsFreeDomain(months) {
  return Number(months || 0) >= FREE_DOMAIN_MIN_MONTHS;
}

/*
 * money() AND moneyParts() USED TO LIVE HERE. They are in src/currency.js now,
 * and they take the currency to render in.
 *
 * They are not re-exported from this module even as a convenience, because a
 * one-argument `money(pence)` sitting in the same import as TERMS and CONTACT
 * is far too easy to reach for — and it would silently print a dollar amount
 * with a pound sign in front of it. Templates get `money()` bound to the
 * request's currency from res.locals; server code takes the currency it means.
 *
 * Money stays integer minor units everywhere. A float pound value rounds wrong
 * on the third multi-year order and nobody notices until a reconcile.
 */

/**
 * What a term costs per month, for the "from £2.99/mo" line. Rounded to the
 * nearest penny, and only ever used as display copy — never to bill from.
 */
function perMonth(totalPence, months) {
  return Math.round(Number(totalPence || 0) / Math.max(1, Number(months || 1)));
}

/*
 * VAT MOVED TO src/currency.js, because it is 20% inside a GBP price and 0%
 * inside a USD one — it belongs to the currency row, not to the process.
 *
 * The rule it implements has not changed: VAT is INCLUDED in every price, never
 * added at the end, and the arithmetic is `gross ÷ 1.2` rather than
 * `gross × 0.2`. See the long note above vatIncludedIn() over there.
 */

/** How much a term saves against paying monthly, as a percentage. 0 if none. */
function savingPercent(monthlyPence, termTotalPence, months) {
  const atMonthly = Number(monthlyPence) * Number(months);
  if (!atMonthly || termTotalPence >= atMonthly) return 0;
  return Math.round(((atMonthly - termTotalPence) / atMonthly) * 100);
}

module.exports = {
  SITE_URL,
  MAIN_SITE_URL,
  CONTROL_PANEL_URL,
  BASE_CURRENCY,
  CONTACT,
  BRAND,
  NAMESERVERS,
  POINT_HOSTNAME,
  DOMAIN_NS_GRACE_DAYS,
  PAYMENT_SESSION_MINUTES,
  JOB_INTERVAL_MINUTES,
  TERMS,
  DEFAULT_TERM_MONTHS,
  FREE_DOMAIN_MIN_MONTHS,
  FREE_DOMAIN_MAX_PENCE,
  tldQualifiesFree,
  resolveTerm,
  termEarnsFreeDomain,
  perMonth,
  savingPercent,
};
