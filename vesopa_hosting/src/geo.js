/**
 * Where is this visitor, and therefore which currency should they see first?
 *
 * THE LOOKUP HAPPENS HERE, ON THE SERVER. Nothing in the browser ever contacts
 * ipwho.is or any other geo service. That is a hard requirement and not a
 * preference: a third-party request fired from the page would put an external
 * host in the CSP, appear in every visitor's network tab, be blocked outright by
 * a good chunk of ad-blockers (leaving those visitors on the wrong currency),
 * and hand a company we have no agreement with a log of every person who opens
 * the site. Done from Node it is one request, from one address, invisible to the
 * page and impossible for a blocker to break.
 *
 * The answer is cached three deep, and the ordering matters:
 *
 *   1. the visitor's own cookie      — no lookup at all, and their manual
 *                                      choice lives here too
 *   2. an in-process map             — no database round trip
 *   3. the geo_cache table           — survives a pm2 restart
 *
 * Only a genuinely new address reaches the network. On a free tier metered by
 * the month that is the difference between working and being cut off in week
 * two.
 */

const crypto = require('crypto');
const db = require('./db');
const currency = require('./currency');

const ENDPOINT = process.env.GEO_ENDPOINT || 'https://ipwho.is';
const ENABLED = String(process.env.GEO_ENABLED ?? 'true').toLowerCase() !== 'false';
const TIMEOUT_MS = Number(process.env.GEO_TIMEOUT_MS || 1500);

/**
 * Addresses are stored hashed, with a per-install salt.
 *
 * We need to recognise an address we have already looked up. We do not need to
 * be able to read back the list of everyone who has ever visited, and a table
 * that cannot be read back is a table that cannot leak. The salt falls back to
 * the session secret so this still works on an install that has not set it.
 */
const SALT = process.env.GEO_SALT || process.env.SESSION_SECRET || 'vesopa-geo';

function hashIp(ip) {
  return crypto.createHash('sha256').update(`${SALT}:${ip}`).digest('hex');
}

// ---------------------------------------------------------------------------
// What we will not look up
// ---------------------------------------------------------------------------
/**
 * A private or loopback address tells ipwho.is nothing — it would answer about
 * the SERVER, not the visitor, which on a UK box means every developer on a
 * laptop silently gets GBP and never sees the other currencies work. Better to
 * return nothing and fall through to the default.
 */
function isPrivate(ip) {
  const a = String(ip || '').replace(/^::ffff:/, '');
  if (!a) return true;
  if (a === '::1' || a === '127.0.0.1' || a.startsWith('127.')) return true;
  if (a.startsWith('10.') || a.startsWith('192.168.')) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(a)) return true;
  if (a.startsWith('169.254.')) return true;
  // Unique-local and link-local IPv6.
  if (/^f[cd]/i.test(a) || /^fe80:/i.test(a)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// In-process cache and circuit breaker
// ---------------------------------------------------------------------------
const memo = new Map();
const MEMO_MAX = 5000;
const MEMO_TTL_MS = 24 * 60 * 60 * 1000;

function memoGet(key) {
  const hit = memo.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > MEMO_TTL_MS) {
    memo.delete(key);
    return null;
  }
  return hit.country;
}

function memoSet(key, country) {
  // A plain FIFO trim. An LRU would be marginally better and is not worth the
  // bookkeeping for a map whose entries expire in a day anyway.
  if (memo.size >= MEMO_MAX) {
    const oldest = memo.keys().next().value;
    memo.delete(oldest);
  }
  memo.set(key, { country, at: Date.now() });
}

/**
 * If ipwho.is is down, stop calling it.
 *
 * Without this, an outage there turns into a 1.5-second delay on the first page
 * view of every single visitor to this site — our availability quietly becomes
 * a function of theirs. Three consecutive failures and we stop asking for five
 * minutes, serving the default currency instead. Nobody sees an error; some
 * people briefly see the wrong currency, which they can change in one click.
 */
const breaker = { failures: 0, openUntil: 0 };
const BREAKER_TRIP = 3;
const BREAKER_COOLDOWN_MS = 5 * 60 * 1000;

function breakerOpen() {
  return Date.now() < breaker.openUntil;
}

function noteFailure(why) {
  breaker.failures += 1;
  if (breaker.failures >= BREAKER_TRIP && !breakerOpen()) {
    breaker.openUntil = Date.now() + BREAKER_COOLDOWN_MS;
    console.warn(`[geo] ${ENDPOINT} failing (${why}) — pausing lookups for 5 minutes`);
  }
}

function noteSuccess() {
  breaker.failures = 0;
  breaker.openUntil = 0;
}

// ---------------------------------------------------------------------------
// The lookup
// ---------------------------------------------------------------------------
/**
 * Ask ipwho.is for one address. Returns an ISO country code, or '' for
 * "we do not know", which every caller must treat as ordinary rather than as an
 * error — not knowing where somebody is is the normal case for a VPN, a
 * corporate proxy or a brand-new address range.
 *
 * `fields` keeps the response to the two values we use. There is no reason to
 * pull down a city, a timezone and a currency guess we are not going to read.
 */
async function fetchCountry(ip) {
  const url = `${ENDPOINT}/${encodeURIComponent(ip)}?fields=success,country_code,message`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { accept: 'application/json', 'user-agent': 'vesopa-hosting/1.0' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const body = await res.json();
  // ipwho.is answers 200 with `success: false` for a private or unroutable
  // address, so the status code alone is not the check.
  if (!body || body.success === false) {
    throw new Error(body?.message || 'lookup unsuccessful');
  }
  return String(body.country_code || '').toUpperCase().slice(0, 2);
}

/**
 * The country for an address, from whichever cache has it.
 *
 * Never throws. Every failure path returns '' and the caller falls back to the
 * default currency; a geo service having a bad afternoon must not be able to
 * produce an error page on a hosting company's home page.
 */
async function countryFor(ip) {
  if (!ENABLED || isPrivate(ip)) return '';

  const key = hashIp(ip);

  const inMemory = memoGet(key);
  if (inMemory !== null) return inMemory;

  try {
    const row = await db.one(
      'SELECT country FROM geo_cache WHERE ip_hash = ? AND created_at > (NOW() - INTERVAL 30 DAY) LIMIT 1',
      [key],
    );
    if (row) {
      memoSet(key, row.country || '');
      return row.country || '';
    }
  } catch (err) {
    console.warn('[geo] cache read failed:', err.message);
  }

  if (breakerOpen()) return '';

  let country = '';
  try {
    country = await fetchCountry(ip);
    noteSuccess();
  } catch (err) {
    noteFailure(err.name === 'TimeoutError' ? 'timeout' : err.message);
    // A failed lookup is memoised as "unknown" for the day as well. Retrying
    // the same dead address on every page view of a crawler's session is how a
    // 10,000-a-month quota disappears in an afternoon.
    memoSet(key, '');
    return '';
  }

  memoSet(key, country);

  // Best effort. A cache row failing to write is not worth failing a request
  // for; the in-process memo has it either way until the next restart.
  db.query(
    `INSERT INTO geo_cache (ip_hash, country) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE country = VALUES(country), created_at = NOW()`,
    [key, country],
  ).catch((err) => console.warn('[geo] cache write failed:', err.message));

  return country;
}

/** The currency someone at this address should be shown first. */
async function currencyFor(ip) {
  const country = await countryFor(ip);
  const cur = await currency.forCountry(country);
  return { country, currency: cur };
}

/** For the admin status panel: is this thing on, and is it currently working? */
function status() {
  return {
    enabled: ENABLED,
    endpoint: ENDPOINT,
    cached: memo.size,
    paused: breakerOpen(),
    failures: breaker.failures,
  };
}

module.exports = { countryFor, currencyFor, isPrivate, status };
