/**
 * Can the reseller account actually pay for these domains, right now?
 *
 * WHY THIS EXISTS
 *
 * On 2026-09-22 rkratul595@gmail.com bought wintk999.com. Checkout said it
 * succeeded, the invoice said paid — and Domain Name API refused the
 * registration with "Insufficient balance" two seconds later, because the
 * reseller deposit was nearly empty. The customer was told they owned a name
 * nobody had bought. A registration is the one step here that spends real
 * money at a third party and cannot be retried until somebody tops up.
 *
 * So the balance is checked BEFORE the order is written: at checkout, and when
 * a plan's free domain is claimed. If it does not cover what the registry will
 * charge, the customer is told plainly and nothing is created or charged.
 *
 * FAILS CLOSED. If the balance cannot be read, domains are not sold. A
 * temporary "try again shortly" is recoverable; a paid order for a domain that
 * cannot be registered is the exact failure this prevents.
 *
 * Not in live mode (mock or sandbox) there is no real money to run out of, so
 * the check steps aside.
 */

const db = require('./db');
const currency = require('./currency');
const registrar = require('./integrations/domainnameapi');

// The registry's price can move between our tlds sync and the purchase, and a
// premium or surcharge can apply; a tenth of headroom keeps a borderline
// balance from passing the check and failing at the registry.
const MARGIN = 1.1;

// Used only if USD is not configured in the currency table. Deliberately on the
// high side of GBP→USD so that, if anything, it refuses a sale it could have
// made rather than accepting one it cannot fulfil.
const FALLBACK_BASE_TO_USD = 1.4;

const CUSTOMER_MESSAGE =
  'We can’t register domains at the moment, so nothing has been charged. Please try again a little later, ' +
  'or remove the domain from your basket to buy the rest now.';

/** Base-currency minor units → US dollars (major units). */
async function toUsd(baseMinor) {
  const usd = await currency.resolve('USD').catch(() => null);
  if (usd && usd.code === 'USD') {
    return (usd.is_base ? baseMinor : baseMinor * usd.rate) / 100;
  }
  return (baseMinor * FALLBACK_BASE_TO_USD) / 100;
}

/**
 * What the registry will charge us for these lines, in USD.
 * `lines` are basket lines: { kind: 'domain' | 'domain_transfer', domain, years }.
 */
async function costUsd(lines) {
  let baseMinor = 0;
  const unpriced = [];
  for (const line of lines) {
    if (line.kind !== 'domain' && line.kind !== 'domain_transfer') continue;
    const { tld } = registrar.splitDomain(line.domain);
    // eslint-disable-next-line no-await-in-loop -- a basket holds a handful
    const row = await db.one('SELECT cost_pence FROM tlds WHERE tld = ? LIMIT 1', [tld]);
    const cost = Number(row && row.cost_pence) || 0;
    if (!cost) {
      unpriced.push(line.domain);
      continue;
    }
    // A transfer carries one year; a registration pays for every year up front.
    const years = line.kind === 'domain_transfer' ? 1 : Math.max(1, Number(line.years) || 1);
    baseMinor += cost * years;
  }
  return { usd: (await toUsd(baseMinor)) * MARGIN, unpriced };
}

/**
 * Returns { ok: true } or { ok: false, message, reason, needUsd?, haveUsd? }.
 * `message` is for the customer; the rest is for the activity log.
 */
async function check(lines) {
  const domainLines = (lines || []).filter((l) => l.kind === 'domain' || l.kind === 'domain_transfer');
  if (!domainLines.length) return { ok: true };
  if (!registrar.isConnected() || !registrar.isLive()) return { ok: true, skipped: 'not live' };

  let balance;
  try {
    balance = await registrar.balance();
  } catch (err) {
    return { ok: false, reason: `balance unavailable: ${err.message}`, message: CUSTOMER_MESSAGE };
  }
  const haveUsd = Number(balance && balance.amount);
  if (!balance || !balance.ok || !Number.isFinite(haveUsd)) {
    return { ok: false, reason: 'balance unreadable', message: CUSTOMER_MESSAGE };
  }

  const { usd: needUsd, unpriced } = await costUsd(domainLines);
  // A TLD with no recorded cost cannot be judged; the registry's own price for
  // a .com is a floor worth holding it to rather than waving it through.
  const floorUsd = unpriced.length ? unpriced.length * 15 : 0;
  const required = needUsd + floorUsd;

  if (haveUsd < required) {
    return {
      ok: false,
      reason: 'insufficient reseller balance',
      needUsd: Math.round(required * 100) / 100,
      haveUsd,
      message: CUSTOMER_MESSAGE,
    };
  }
  return { ok: true, needUsd: Math.round(required * 100) / 100, haveUsd };
}

/** Log a refusal where the admin will see it. Never throws. */
async function logRefusal(result, { customerId = null, domains = [], ip = '' } = {}) {
  const detail = result.needUsd != null
    ? `Reseller balance $${result.haveUsd} is below the $${result.needUsd} needed for ${domains.join(', ')}. Top up Domain Name API.`
    : `${result.reason} — domain sale refused for ${domains.join(', ')}.`;
  console.warn(`[registrar-funds] ${detail}`);
  await db.logActivity({
    actorType: 'system', actorId: customerId, action: 'registrar.balance_low',
    target: domains.join(', ').slice(0, 190), detail, ok: false, ip,
  }).catch(() => {});
}

module.exports = { check, logRefusal, costUsd, CUSTOMER_MESSAGE, MARGIN };
