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
 * HestiaCP's own web interface, e.g. https://panel.vesopa.com:2083.
 *
 * NOTHING IN THE CUSTOMER PANEL LINKS HERE ANY MORE, and that is the point.
 *
 * It used to: the file manager, the web terminal and the account profile were
 * all deep links onto :2083, which meant a second sign-in with a password out
 * of a welcome email and a control panel that looks nothing like this one. Both
 * of the tools that mattered are served by this app now — /panel/files
 * (src/routes/panel-files.js) and /panel/terminal (src/terminal.js) — each
 * signed in with the session the customer already has.
 *
 * The value is kept because it is still the right address for staff, and
 * because blanking it should not be load-bearing. If something new ever needs
 * to hand a customer to Hestia, read this rather than hard-coding a host — and
 * think hard first, because "log in again over there" is the experience this
 * whole panel exists to avoid.
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
 * THE HOSTNAME IS THE INSTRUCTION; the address is the footnote.
 *
 * A raw address in the panel is a commitment: every customer who copies it into
 * a zone we cannot see pins us to that number, and moving the node silently
 * breaks all of them with no list of who to warn. `A record -> point.vesopa.com`
 * is the same instruction with the indirection kept, and changing where it
 * points moves everybody at once.
 *
 * The address IS now shown next to it, because a fair number of DNS control
 * panels refuse a hostname in an A record and want four numbers — a customer
 * staring at a form that rejects `point.vesopa.com` cannot proceed without
 * asking us. It is always RESOLVED from this hostname at request time
 * (nameservers.ourAddresses), never written down here, so there is still one
 * source of truth and it cannot go stale.
 */
const POINT_HOSTNAME = process.env.POINT_HOSTNAME || 'point.vesopa.com';

/**
 * The one hostname every mailbox connects to, for IMAP, SMTP and webmail.
 *
 * NOT `mail.<customer's domain>`, which is what a control panel does by default
 * and what this used to tell people to type into Outlook. That name has no
 * certificate — issuing one per customer domain means a certificate per domain,
 * and it fails outright for any customer whose DNS lives elsewhere — so the
 * instruction was for a server that could not actually be reached. A mail
 * client meeting a certificate for the wrong name either refuses to connect or
 * teaches its owner to click through a security warning, and the second is
 * worse than the first.
 *
 * One hostname, one certificate, correct for everybody: the customer's own
 * domain is their ADDRESS, and this is the SERVER they collect it from. Those
 * are different things and only the first has to be theirs.
 *
 * MX for every domain we run DNS for points here too, so mail arrives at the
 * same place it is read from.
 */
const MAIL_HOSTNAME = process.env.MAIL_HOSTNAME || 'mail.vesopa.com';

/** Where webmail lives. The same host — one name is one thing to remember. */
const WEBMAIL_URL = process.env.WEBMAIL_URL || `https://${MAIL_HOSTNAME}`;

/**
 * The mail ports we tell customers to use, and only the secure ones.
 *
 * No 143 and no 587-without-TLS anywhere in the panel. Every one of these is
 * implicit TLS from the first byte, so there is no version of these
 * instructions that sends a password in the clear because a client did not
 * negotiate STARTTLS.
 */
const MAIL_PORTS = { imap: 993, smtp: 465, pop3: 995 };

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
  MAIL_HOSTNAME,
  WEBMAIL_URL,
  MAIL_PORTS,
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
