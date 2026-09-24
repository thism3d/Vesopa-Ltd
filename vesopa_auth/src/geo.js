/**
 * Which country an address is in, for the devices and sign-in history pages.
 *
 * WHY THIS EXISTS. "Where you are signed in now" used to say
 * `103.146.42.205 · started 10:30:34`, and an IP address is not an answer to
 * the question that page is asking. The question is *"is one of these not me?"*
 * — and "Bangladesh" or "United Kingdom" answers it in a way four numbers never
 * will. It is the most useful thing on a security page, because it is the thing
 * somebody notices without knowing what they were looking for.
 *
 * IT IS A PORT, NOT A NEW IDEA. `vesopa_hosting/src/geo.js` already does this
 * lookup, for currency; the owner asked for the same thing here. The caching
 * ladder, the circuit breaker and the hashed keys are lifted from it, because
 * they are the parts that stop a free tier being exhausted in a week and stop
 * somebody else's outage becoming ours. Two differences:
 *
 *   * this answers a NAME as well as a code, because a security page is read by
 *     the person whose account it is and `BD` means nothing to most of them;
 *   * it is called on WRITES — a session created, a device seen — and never on
 *     the read path, so a slow lookup delays nothing anybody is waiting for.
 *
 * THE LOOKUP HAPPENS HERE, ON THE SERVER, never in the page. The
 * Content-Security-Policy on this origin is `connect-src 'self'` and this is
 * the origin that holds every session; a geo request fired from the browser
 * would have to open that, would appear in every visitor's network tab, and
 * would hand a company we have no agreement with a log of everybody who opens
 * their own account page.
 */

const crypto = require('crypto');

const db = require('./db');
const config = require('./config');

const ENDPOINT = process.env.GEO_ENDPOINT || 'https://ipwho.is';
const ENABLED = String(process.env.GEO_ENABLED ?? 'true').toLowerCase() !== 'false';
const TIMEOUT_MS = Number(process.env.GEO_TIMEOUT_MS || 1500);

/**
 * Addresses are keyed hashed, with a per-install salt.
 *
 * We need to recognise an address we have looked up before. We do not need to
 * be able to read back the list of every address that has ever reached this
 * server, and a table that cannot be read back is a table that cannot leak.
 */
const SALT =
  process.env.GEO_SALT ||
  (config.secrets && config.secrets.subjectPepper) ||
  'vesopa-auth-geo';

function hashIp(ip) {
  return crypto.createHash('sha256').update(SALT + ':' + ip).digest('hex');
}

/**
 * A private or loopback address tells the lookup service nothing — it would
 * answer about the SERVER rather than the visitor, so every developer on a
 * laptop would be told they are wherever this box is. Better to know nothing.
 */
function isPrivate(ip) {
  const a = String(ip || '').replace(/^::ffff:/, '');
  if (!a) return true;
  if (a === '::1' || a === '127.0.0.1' || a.startsWith('127.')) return true;
  if (a.startsWith('10.') || a.startsWith('192.168.')) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(a)) return true;
  if (a.startsWith('169.254.')) return true;
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
  if (memo.size >= MEMO_MAX) memo.delete(memo.keys().next().value);
  memo.set(key, { country, at: Date.now() });
}

/**
 * If the lookup service is down, stop calling it.
 *
 * Without this, an outage there becomes a 1.5-second delay on every sign-in
 * here — our availability quietly becomes a function of theirs, on the one
 * service where that is least acceptable. Three failures and it stops asking
 * for five minutes. Nobody sees an error; some rows simply have no country,
 * which every reader of this module already has to handle.
 */
const breaker = { failures: 0, openUntil: 0 };
const BREAKER_TRIP = 3;
const BREAKER_COOLDOWN_MS = 5 * 60 * 1000;

const breakerOpen = () => Date.now() < breaker.openUntil;

function noteFailure(why) {
  breaker.failures += 1;
  if (breaker.failures >= BREAKER_TRIP && !breakerOpen()) {
    breaker.openUntil = Date.now() + BREAKER_COOLDOWN_MS;
    console.warn('[geo] ' + ENDPOINT + ' failing (' + why + ') — pausing lookups for five minutes');
  }
}

async function fetchCountry(ip) {
  const url = ENDPOINT + '/' + encodeURIComponent(ip) + '?fields=success,country_code,message';
  const response = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { accept: 'application/json', 'user-agent': 'vesopa-auth/1.0' },
  });
  if (!response.ok) throw new Error('HTTP ' + response.status);

  const body = await response.json();
  // ipwho.is answers 200 with `success: false` for an address it cannot place,
  // so the status code alone is not the check.
  if (!body || body.success === false) {
    throw new Error((body && body.message) || 'lookup unsuccessful');
  }
  return String(body.country_code || '').toUpperCase().slice(0, 2);
}

/**
 * The two-letter country for an address, from whichever cache has it.
 *
 * NEVER THROWS. Every failure returns '' and every caller treats that as
 * ordinary rather than as an error — not knowing where somebody is is the
 * normal case for a VPN, a corporate proxy or a new address range, and a geo
 * service having a bad afternoon must not be able to stop anybody signing in.
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
  } catch (error) {
    // The table may not exist yet on a server part-way through a deploy. That
    // is worth a line in the log and nothing more.
    console.warn('[geo] cache read failed:', error.message);
  }

  if (breakerOpen()) return '';

  let country = '';
  try {
    country = await fetchCountry(ip);
    breaker.failures = 0;
    breaker.openUntil = 0;
  } catch (error) {
    noteFailure(error.name === 'TimeoutError' ? 'timeout' : error.message);
    // A failed lookup is remembered as "unknown" for the day too. Retrying a
    // dead address on every request is how a monthly quota disappears in an
    // afternoon.
    memoSet(key, '');
    return '';
  }

  memoSet(key, country);

  db.query(
    'INSERT INTO geo_cache (ip_hash, country) VALUES (?, ?) '
      + 'ON DUPLICATE KEY UPDATE country = VALUES(country), created_at = NOW()',
    [key, country],
  ).catch((error) => console.warn('[geo] cache write failed:', error.message));

  return country;
}

/**
 * The country for an address IF WE ALREADY KNOW IT, and never a lookup.
 *
 * `login_events` is written on every attempt, including every blocked and
 * failed one. Doing a real lookup there would mean an attacker with a botnet
 * chooses how much of a metered quota we spend, and would put a network call in
 * front of the write that records that they are attacking us. So the history
 * page gets a country when the address is already known — which, for anybody
 * who actually signed in, it is: `sessions.create` looked it up a moment
 * earlier and the answer is in the same in-process map.
 */
function peek(ip) {
  if (!ENABLED || isPrivate(ip)) return '';
  return memoGet(hashIp(ip)) || '';
}

/*
 * The countries this actually sees, written out.
 *
 * NOT a 250-row table. This is a security page, and all a name has to do there
 * is let somebody recognise their own country, or fail to recognise a
 * stranger's. A country not in this list shows its code — which is what the
 * page showed before this file existed, so nothing is lost by the omission.
 */
const NAMES = {
  GB: 'United Kingdom', IE: 'Ireland', US: 'United States', CA: 'Canada',
  BD: 'Bangladesh', IN: 'India', PK: 'Pakistan', LK: 'Sri Lanka', NP: 'Nepal',
  FR: 'France', DE: 'Germany', ES: 'Spain', PT: 'Portugal', IT: 'Italy',
  NL: 'Netherlands', BE: 'Belgium', LU: 'Luxembourg', CH: 'Switzerland',
  AT: 'Austria', PL: 'Poland', CZ: 'Czechia', SK: 'Slovakia', HU: 'Hungary',
  RO: 'Romania', BG: 'Bulgaria', GR: 'Greece', HR: 'Croatia', SI: 'Slovenia',
  SE: 'Sweden', NO: 'Norway', DK: 'Denmark', FI: 'Finland', IS: 'Iceland',
  EE: 'Estonia', LV: 'Latvia', LT: 'Lithuania', UA: 'Ukraine', TR: 'Turkiye',
  RU: 'Russia', AE: 'United Arab Emirates', SA: 'Saudi Arabia', QA: 'Qatar',
  KW: 'Kuwait', BH: 'Bahrain', OM: 'Oman', IL: 'Israel', EG: 'Egypt',
  MA: 'Morocco', NG: 'Nigeria', KE: 'Kenya', GH: 'Ghana', ZA: 'South Africa',
  AU: 'Australia', NZ: 'New Zealand', SG: 'Singapore', MY: 'Malaysia',
  ID: 'Indonesia', TH: 'Thailand', VN: 'Vietnam', PH: 'Philippines',
  CN: 'China', HK: 'Hong Kong', TW: 'Taiwan', JP: 'Japan', KR: 'South Korea',
  BR: 'Brazil', AR: 'Argentina', MX: 'Mexico', CL: 'Chile', CO: 'Colombia',
};

/** "United Kingdom", or the bare code, or '' — whatever we honestly have. */
function nameFor(code) {
  const key = String(code || '').toUpperCase().slice(0, 2);
  if (!key) return '';
  return NAMES[key] || key;
}

/**
 * The flag, as the two regional-indicator letters.
 *
 * Emoji rather than an image: the policy here is `img-src 'self' data:`, and a
 * flag sprite would be 250 pictures to serve and to keep politically current.
 * A platform with no flag font draws the two letters instead, which still
 * reads.
 */
function flagFor(code) {
  const key = String(code || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(key)) return '';
  return String.fromCodePoint(...[...key].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

/** For the administrator's health panel: is this on, and is it working? */
function status() {
  return {
    enabled: ENABLED,
    endpoint: ENDPOINT,
    cached: memo.size,
    paused: breakerOpen(),
    failures: breaker.failures,
  };
}

module.exports = { countryFor, peek, nameFor, flagFor, isPrivate, status };
