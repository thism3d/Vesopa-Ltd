/**
 * DomainNameAPI — the registrar behind domain search, registration and transfer.
 *
 * Written against the official PHP client (github.com/domainreseller/php-dna),
 * not against the marketing documentation. The two disagree, and the client is
 * what actually talks to the gateway.
 *
 * THREE THINGS TO KNOW BEFORE CHANGING THIS FILE
 *
 * 1. There are two completely different APIs behind the same brand. A reseller
 *    ID in UUID form (`a80bd0d4-…`) means the modern REST gateway at
 *    domainresellerapi.com; a legacy numeric/username ID means the old SOAP
 *    service. We have UUID credentials, so this is the REST client. Note the
 *    host: domain*reseller*api.com, not domainnameapi.com — the latter is the
 *    marketing site and does not serve the API.
 *
 * 2. Auth is two headers, not a bearer token and not a session. `X-API-KEY`
 *    carries the key and `__reseller` carries the reseller UUID. Both are
 *    required on every call; omitting `__reseller` returns a 302 to a login
 *    page, which is why a redirect is treated as a credentials error below
 *    rather than followed.
 *
 * 3. MODE is a three-way switch and it decides whether money moves.
 *      mock  no network at all — deterministic fake, for demos and dev
 *      test  the real gateway against OTE. Real calls, sandbox registry.
 *      live  production. A registration is real and cannot be handed back.
 *    Anything that is not exactly 'live' can never reach the production host:
 *    that is enforced in resolveEndpoint() rather than left to the .env being
 *    right.
 *
 * And the rule that has not changed: **we never quote the registrar's price to
 * a customer.** Availability comes from the API; the price always comes from
 * our own `tlds` table. A registrar that moves its rate card mid-session must
 * not change what someone is charged halfway through a checkout.
 */

const MODE = (process.env.DNA_MODE || 'mock').toLowerCase();
const RESELLER_ID = process.env.DNA_RESELLER_ID || '';

const URL_PROD = 'https://api.domainresellerapi.com/api/v1';
const URL_OTE = 'https://ote.domainresellerapi.com/api/v1';

/**
 * Which host and which key, decided from the mode alone.
 *
 * The test key is a different secret from the live one, so picking the host
 * without also picking the key would send production credentials to the
 * sandbox (or worse, the reverse). They are chosen together, here, once.
 */
function resolveEndpoint({ write, forceProd = false }) {
  const override = (process.env.DNA_API_URL || '').replace(/\/$/, '');

  // Read-only calls whose answer is meaningless from the sandbox — the account
  // balance being the one that matters. Never used for anything that writes.
  if (forceProd) return { url: override || URL_PROD, key: process.env.DNA_API_KEY || '' };

  /*
   * READS RUN AGAINST PRODUCTION EVEN IN TEST MODE, and that is deliberate.
   *
   * Measured against the OTE sandbox on 2026-08-05: `.co.uk` and `.uk` return
   * NOTHING AT ALL — not "taken", simply absent from the response — while the
   * same query against production answers for both. OTE carries a reduced TLD
   * set. Pointing the search box at it would tell a British customer that the
   * one extension they came for does not exist, which is worse than useless.
   *
   * An availability lookup is read-only. It registers nothing, costs nothing
   * and cannot be undone because there is nothing to undo. Writes — register,
   * transfer, nameserver changes — still honour MODE, so test mode remains
   * incapable of spending money.
   *
   * Set DNA_SEARCH_ENDPOINT=mode to force reads onto the sandbox too.
   */
  const searchOnProd = (process.env.DNA_SEARCH_ENDPOINT || 'live').toLowerCase() === 'live';
  const useProd = MODE === 'live' || (!write && searchOnProd);

  if (useProd) return { url: override || URL_PROD, key: process.env.DNA_API_KEY || '' };
  // Some accounts issue one key for both environments, so fall back to the
  // live key. The URL is still OTE, so nothing reaches production either way.
  return {
    url: override || URL_OTE,
    key: process.env.DNA_API_KEY_TEST || process.env.DNA_API_KEY || '',
  };
}

/*
 * Observed round-trip is 0.6–3s depending on batch size and which host answers.
 * 15s was too tight: a five-name search timed out, the old fallback then fired
 * five more single-name searches, and one page took 17.5 seconds to render
 * mostly errors. Raised, and the fallback removed.
 */
const TIMEOUT_MS = 25_000;

/*
 * Names per bulk call, and how chunks are paced.
 *
 * THE GATEWAY REJECTS CONCURRENT REQUESTS WITH 429. Measured: two bulk-search
 * calls issued at the same moment from this reseller, one returns 200 and the
 * other 429 immediately. So chunks run one after another, never in parallel —
 * an earlier version fanned them out with Promise.all and roughly half of every
 * search came back "could not check" for no visible reason.
 *
 * Batch size is a straight trade against that: 8 names take ~4.3s and 4 take
 * ~1.9s, so latency is near-linear in batch size and there is no gain in going
 * small. 12 keeps a typical search to a single round trip.
 */
const BULK_CHUNK = 12;
const RATE_LIMIT_PAUSE_MS = 700;

class RegistrarError extends Error {
  constructor(message, { code, retryable = false } = {}) {
    super(message);
    this.name = 'RegistrarError';
    this.code = code || 'registrar_error';
    this.retryable = retryable;
  }
}

/** Does this mode talk to the network at all? */
const isConnected = () => MODE === 'live' || MODE === 'test';
/** Does this mode spend money? */
const isLive = () => MODE === 'live';

/** Split "shop.example.co.uk" into { sld: 'example', tld: 'co.uk' }. */
const MULTI_PART_TLDS = new Set([
  'co.uk', 'org.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk', 'sch.uk', 'ac.uk', 'gov.uk',
  'com.au', 'net.au', 'org.au', 'co.nz', 'co.za', 'com.br', 'co.in', 'co.jp',
]);

function splitDomain(input) {
  const clean = String(input || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '')
    .replace(/[^a-z0-9.-]/g, '');

  const parts = clean.split('.').filter(Boolean);
  if (parts.length < 2) return { sld: parts[0] || '', tld: '', domain: clean };

  const lastTwo = parts.slice(-2).join('.');
  if (parts.length >= 3 && MULTI_PART_TLDS.has(lastTwo)) {
    return { sld: parts.slice(0, -2).join('.'), tld: lastTwo, domain: clean };
  }
  return { sld: parts.slice(0, -1).join('.'), tld: parts.at(-1), domain: clean };
}

/** The label rules every registry enforces, checked before we spend a call. */
function validateLabel(sld) {
  if (!sld) return 'Enter a domain name.';
  // 3, not 2. The gateway rejects a two-character label with
  // "must contain at least 3 and no more than 63 characters" — checking it here
  // saves a round trip and gives the customer the real reason immediately.
  if (sld.length < 3) return 'A domain name needs at least three characters.';
  if (sld.length > 63) return 'That name is too long.';
  if (!/^[a-z0-9-]+$/.test(sld)) return 'Use letters, numbers and hyphens only.';
  if (sld.startsWith('-') || sld.endsWith('-')) return 'A domain cannot start or end with a hyphen.';
  if (sld.includes('--') && !sld.startsWith('xn--')) return 'A domain cannot contain two hyphens together.';
  return null;
}

/**
 * The single point where this process talks to the registrar.
 *
 * `fetch` with an AbortController rather than a client library: a hung
 * registrar must not hold a web request open, because the search box is on the
 * homepage and every visitor hits it.
 */
async function call(method, endpoint, data = {}, { write = false, forceProd = false } = {}) {
  const { url: base, key } = resolveEndpoint({ write, forceProd });
  if (!RESELLER_ID || !key) {
    throw new RegistrarError('Registrar credentials are not configured.', { code: 'no_credentials' });
  }

  const isQuery = method === 'GET' || method === 'DELETE';
  let url = `${base}/${String(endpoint).replace(/^\//, '')}`;
  if (isQuery && data && Object.keys(data).length) {
    url += `?${new URLSearchParams(data)}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-API-KEY': key,
        // Mandatory. Without it the gateway 302s to a login page.
        __reseller: RESELLER_ID,
      },
      body: isQuery ? undefined : JSON.stringify(data),
      // A 3xx here means auth failed, not "the resource moved". Following it
      // would fetch an HTML login page and fail as a JSON parse error three
      // lines later, hiding the real cause.
      redirect: 'manual',
      signal: controller.signal,
    });

    if (res.status === 301 || res.status === 302) {
      throw new RegistrarError('Invalid API credentials — check the reseller ID and API key.', {
        code: 'credentials',
      });
    }

    const text = await res.text();
    let data_;
    try {
      data_ = text ? JSON.parse(text) : {};
    } catch {
      throw new RegistrarError(`Registrar returned non-JSON (HTTP ${res.status}).`, {
        code: 'bad_response',
        retryable: res.status >= 500,
      });
    }

    if (!res.ok) {
      let message = data_.message || data_.error?.message || `Registrar error (HTTP ${res.status}).`;
      /*
       * Unpack the per-field validation list.
       *
       * On a rejected registration the top-level message is only ever
       * "Validation failed. Please check the provided information." — which
       * field, and why, lives in `error.validationErrors`. Without this an
       * admin sees a failed order and has no way at all to find out that a
       * phone country code had a "+" in it.
       */
      const details = data_.error?.validationErrors;
      if (Array.isArray(details) && details.length) {
        const unique = [...new Set(details.map((d) => d.message).filter(Boolean))];
        if (unique.length) message += ` ${unique.join(' ')}`;
      }
      throw new RegistrarError(message, {
        code: data_.code || data_.error?.code || `http_${res.status}`,
        retryable: res.status >= 500 || res.status === 429,
      });
    }
    return data_;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new RegistrarError('The registrar did not respond in time.', { code: 'timeout', retryable: true });
    }
    if (err instanceof RegistrarError) throw err;
    throw new RegistrarError(`Could not reach the registrar: ${err.message}`, {
      code: 'network',
      retryable: true,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Our billing contact shape into the gateway's ContactLiteDto.
 *
 * `isHidden` is a non-nullable bool in the gateway's schema — leaving it out
 * fails ModelState validation and rejects the whole registration, which is a
 * miserable thing to debug from a "Validation failed" string.
 */
function toContact(c, contactType) {
  const phone = String(c.phone || '').replace(/[^\d+]/g, '');
  /*
   * The gateway wants the country code and the number in separate fields, and
   * the country code must be BARE DIGITS — "44", never "+44".
   *
   * Sending "+44" fails the whole registration with a bare "Validation failed.
   * Please check the provided information.", four times over (registrant,
   * admin, technical, billing). The detail that names the field is only in the
   * `validationErrors` array, which is why `call()` now unpacks it.
   */
  const cc = (phone.startsWith('+') ? phone.slice(1, 3) : '44').replace(/\D/g, '') || '44';
  const local = phone.replace(/^\+\d{1,3}/, '').replace(/^0/, '');

  return {
    contactType,
    firstName: c.first_name || '',
    lastName: c.last_name || '',
    companyName: c.company || '',
    eMail: c.email || '',
    address: [c.address1, c.address2].filter(Boolean).join(', '),
    city: c.city || '',
    state: c.state || c.city || '',
    country: (c.country || 'GB').toUpperCase(),
    postalCode: c.postcode || '',
    phoneCountryCode: cc,
    phone: local,
    faxCountryCode: '',
    fax: '',
    isHidden: false,
  };
}

// ---------------------------------------------------------------------------
// Mock
// ---------------------------------------------------------------------------

/**
 * Deterministic pseudo-availability.
 *
 * A hash of the full domain decides, so `vesopa.com` gives the same answer on
 * every reload and a demo can be rehearsed. Weighted so most invented names are
 * free and short or common ones are taken, which is what makes the results page
 * look honest.
 */
function mockAvailable(domain) {
  const obviouslyTaken = ['google', 'facebook', 'amazon', 'apple', 'microsoft', 'bbc', 'vesopa', 'test', 'example'];
  const { sld } = splitDomain(domain);
  if (obviouslyTaken.includes(sld)) return false;

  let hash = 0;
  for (let i = 0; i < domain.length; i++) hash = (hash * 31 + domain.charCodeAt(i)) >>> 0;
  const takenChance = sld.length <= 4 ? 0.8 : sld.length <= 6 ? 0.45 : 0.2;
  return hash % 100 >= takenChance * 100;
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * Bulk availability — one call for many names.
 *
 * This is the endpoint the search page is built on. `domains/bulk-search` takes
 * a bare JSON ARRAY (not an object with a key), and answers with either
 * `{ infos: [...] }` or a bare array depending on gateway version, so both are
 * accepted.
 */
/**
 * One bulk-search call, retried once if the gateway rate-limits us.
 *
 * 429 is not an error worth showing a customer — it means we asked twice at
 * once, which is our problem, not theirs. One pause and one retry clears it.
 */
async function bulkSearch(chunk) {
  const body = chunk.map((domainName) => ({ domainName }));
  try {
    return await call('POST', 'domains/bulk-search', body);
  } catch (err) {
    if (err.code === 'http_429' || /429/.test(String(err.code))) {
      await new Promise((r) => setTimeout(r, RATE_LIMIT_PAUSE_MS));
      return call('POST', 'domains/bulk-search', body);
    }
    throw err;
  }
}

async function checkBulk(domains) {
  const wanted = domains.map((d) => splitDomain(d).domain).filter(Boolean);
  if (!wanted.length) return [];

  if (!isConnected()) {
    await new Promise((r) => setTimeout(r, 120 + Math.random() * 180));
    return wanted.map((domain) => ({
      domain,
      tld: splitDomain(domain).tld,
      available: mockAvailable(domain),
      mock: true,
    }));
  }

  const chunks = [];
  for (let i = 0; i < wanted.length; i += BULK_CHUNK) chunks.push(wanted.slice(i, i + BULK_CHUNK));

  // SEQUENTIALLY. See the note on BULK_CHUNK — parallel chunks earn a 429.
  const responses = [];
  for (const chunk of chunks) {
    try {
      responses.push(await bulkSearch(chunk));
    } catch (err) {
      // A failed chunk costs its own rows, which fall through to the
      // "could not check" mapping below, and the rest of the page still renders.
      responses.push(null);
    }
  }

  const byDomain = new Map();
  for (const data of responses) {
    if (!data) continue;
    const items = Array.isArray(data?.infos) ? data.infos : Array.isArray(data) ? data : [];
    for (const item of items) {
      const name = String(item?.domainName || '').toLowerCase();
      if (!name) continue;
      /*
       * Statuses seen from the live gateway: AVAILABLE, NOTAVAILABLE,
       * INVALIDDOMAINNAME. Case varies, and older gateway builds answer with a
       * numeric enum, so every known spelling of "yes" is accepted and
       * everything else is a no.
       *
       * INVALIDDOMAINNAME is kept distinct from "taken": the name is not for
       * sale by anyone, and telling someone their idea is unavailable when it
       * is actually malformed sends them off inventing a different name for no
       * reason.
       */
      const status = String(item?.status ?? '').toLowerCase();
      const invalid = status.includes('invalid');
      byDomain.set(name, {
        domain: name,
        // `tld` comes back null on rejected rows, so fall back to our own split.
        tld: String(item?.tld || splitDomain(name).tld || '').toLowerCase(),
        available: ['available', '1', 'true'].includes(status),
        invalid,
        premium: Boolean(item?.isPremium),
        reason: item?.reason || (invalid ? 'That is not a valid domain name.' : ''),
      });
    }
  }

  /*
   * One row per name asked for, in the order asked.
   *
   * A name the gateway simply omitted becomes "could not check" rather than
   * vanishing from the results page. This is not hypothetical: the OTE sandbox
   * omits .co.uk and .uk entirely, which is exactly how that limitation was
   * found.
   */
  return wanted.map(
    (domain) =>
      byDomain.get(domain) || {
        domain,
        tld: splitDomain(domain).tld,
        available: false,
        reason: 'Could not check right now.',
        errored: true,
      },
  );
}

/** Is this exact domain free? */
async function checkAvailability(input) {
  const { domain, sld, tld } = splitDomain(input);
  const invalid = validateLabel(sld);
  if (invalid) return { domain, available: false, reason: invalid, invalid: true };
  if (!tld) return { domain, available: false, reason: 'Add an extension, like .com.', invalid: true };

  const [first] = await checkBulk([domain]);
  return first || { domain, available: false, reason: 'Could not check right now.', errored: true };
}

/**
 * Check one name across many extensions — what the results page is built from.
 *
 * Bulk and chunked, rather than one request per extension. There is
 * deliberately NO retry-with-single-lookups fallback: the first version had
 * one, and when a five-name search hit the timeout it fired five more searches
 * behind it and turned a slow page into a seventeen-second one. A chunk that
 * fails reports its rows as unchecked and the page renders.
 */
async function checkMany(sld, tlds) {
  const names = tlds.map((tld) => `${sld}.${tld}`);
  const rows = await checkBulk(names);
  return rows.map((r, i) => ({ ...r, tld: r.tld || tlds[i] }));
}

/**
 * Register a domain. Called only after payment.
 *
 * The contact block is the registrant of record — for .uk that is a legal
 * requirement rather than a form field, which is why checkout collects a real
 * address before it will accept a domain in the basket.
 */
async function register({ domain, years = 1, contact, nameservers, privacy = true }) {
  const { domain: name } = splitDomain(domain);

  if (!isConnected()) {
    return {
      ok: true,
      mock: true,
      domain: name,
      registrar_ref: `MOCK-${Date.now().toString(36).toUpperCase()}`,
      expires_at: new Date(Date.now() + years * 365 * 864e5).toISOString().slice(0, 10),
      nameservers,
    };
  }

  const data = await call('POST', 'domains/register-with-contacts', {
    domainName: name,
    period: years,
    nameServers: (nameservers || []).filter(Boolean),
    isLocked: true,
    privacyEnabled: Boolean(privacy),
    contacts: ['Registrant', 'Administrative', 'Technical', 'Billing'].map((t) => toContact(contact, t)),
    // Typed as a string dictionary by the gateway; an empty ARRAY fails its
    // deserializer, so it must be an object.
    tldAttributes: {},
  }, { write: true });

  return {
    ok: true,
    test: !isLive(),
    domain: name,
    registrar_ref: String(data?.id || data?.domainId || data?.ID || ''),
    expires_at: (data?.expirationDate || data?.dates?.expiration || '').slice(0, 10) || null,
    nameservers,
  };
}

/** Start an inbound transfer. Needs the auth/EPP code from the losing registrar. */
async function transfer({ domain, authCode, contact, years = 1 }) {
  const { domain: name } = splitDomain(domain);
  if (!isConnected()) {
    return { ok: true, mock: true, domain: name, registrar_ref: `MOCK-TR-${Date.now().toString(36).toUpperCase()}` };
  }
  const data = await call('POST', 'domains/transfer', {
    domainName: name,
    authCode,
    period: years,
    contacts: contact ? ['Registrant', 'Administrative', 'Technical', 'Billing'].map((t) => toContact(contact, t)) : [],
  }, { write: true });
  return { ok: true, test: !isLive(), domain: name, registrar_ref: String(data?.id || data?.domainId || '') };
}

/** Can this domain be transferred with this code? Checked before we take money. */
async function checkTransfer({ domain, authCode }) {
  const { domain: name } = splitDomain(domain);
  if (!isConnected()) return { ok: true, mock: true, transferable: true, domain: name };
  try {
    const data = await call('POST', 'domains/transfers/check', { domainName: name, authCode }, { write: true });
    return {
      ok: true,
      domain: name,
      transferable: data?.authCodeIsValid !== false && data?.transferLock !== true,
      detail: data,
    };
  } catch (err) {
    return { ok: false, domain: name, transferable: false, reason: err.message };
  }
}

/** Point a domain at different nameservers. */
async function setNameservers({ domain, nameservers }) {
  const { domain: name } = splitDomain(domain);
  if (!isConnected()) return { ok: true, mock: true, domain: name, nameservers };
  const data = await call('PUT', 'domains/dns/name-server', {
    domainName: name,
    nameServers: (nameservers || []).filter(Boolean),
  }, { write: true });
  return { ok: true, domain: name, nameservers: data?.nameServers || nameservers };
}

/** The registrar's own view of a domain — used to reconcile expiry dates. */
async function getDomain(domain) {
  const { domain: name } = splitDomain(domain);
  if (!isConnected()) return { ok: true, mock: true, domain: name, status: 'active' };
  const data = await call('GET', 'domains/info', { DomainName: name });
  return {
    ok: true,
    domain: name,
    status: data?.status || 'unknown',
    expires_at: (data?.expirationDate || '').slice(0, 10) || null,
    nameservers: data?.nameServers || [],
  };
}

/**
 * The registrar's TLD list with its wholesale prices.
 *
 * Used by the admin to check our sell prices against what a domain actually
 * costs us. Not used anywhere a customer can see — see the note at the top of
 * this file about never quoting the registrar's price.
 */
async function tldPricing(count = 200) {
  if (!isConnected()) return { ok: true, mock: true, items: [] };
  const data = await call('GET', 'products/tlds', { MaxResultCount: count, SkipCount: 0 });
  const items = Array.isArray(data?.items) ? data.items : [];
  return {
    ok: true,
    items: items.map((t) => {
      const p = Array.isArray(t.prices) ? t.prices[0] || {} : t.prices || {};
      const first = (v) => {
        if (Array.isArray(v)) return Number(v[0]?.price ?? 0);
        if (v && typeof v === 'object') return Number(v.price ?? 0);
        return Number(v ?? 0);
      };
      return {
        tld: String(t.tld || t.name || '').replace(/^\./, '').toLowerCase(),
        register: first(p.register),
        renew: first(p.renew),
        transfer: first(p.transfer),
        currency: p.currency || t.currency || '',
      };
    }),
  };
}

/** Balance on the reseller account — the admin shows it beside the mode. */
/**
 * Balance on the reseller account, from the LIVE endpoint specifically.
 *
 * The sandbox is seeded with $1,000 of pretend credit, so reading the balance
 * for the current mode would cheerfully report a healthy account while the real
 * one sits at zero — and the first thing anyone would learn about that is a
 * customer who has paid for a domain we cannot buy.
 *
 * The registrar bills in USD. Our prices are in GBP, so this figure is NOT
 * comparable to anything in the `tlds` table without a conversion.
 */
async function balance() {
  if (!isConnected()) return { ok: true, mock: true, amount: null, currency: '' };
  const data = await call('GET', 'deposit/accounts/me', {}, { forceProd: true });
  const usd = Number(data?.usdBalance ?? data?.balance ?? data?.amount ?? 0);
  return {
    ok: true,
    live: isLive(),
    reseller_name: data?.resellerName || '',
    amount: usd,
    currency: 'USD',
    try_amount: Number(data?.tryBalance ?? 0),
  };
}

/** Shown in the admin so it is obvious which mode is running. */
function status() {
  return {
    mode: MODE,
    live: isLive(),
    connected: isConnected(),
    configured: Boolean(RESELLER_ID && resolveEndpoint({ write: true }).key),
    reseller_id: RESELLER_ID ? `…${String(RESELLER_ID).slice(-6)}` : '',
    // Two hosts now: searches may answer from production while registrations
    // land in the sandbox, so both are reported rather than one "the URL".
    search_url: resolveEndpoint({ write: false }).url,
    write_url: resolveEndpoint({ write: true }).url,
  };
}

module.exports = {
  RegistrarError,
  splitDomain,
  validateLabel,
  checkAvailability,
  checkBulk,
  checkMany,
  register,
  transfer,
  checkTransfer,
  setNameservers,
  getDomain,
  tldPricing,
  balance,
  status,
  isLive,
  isConnected,
};
