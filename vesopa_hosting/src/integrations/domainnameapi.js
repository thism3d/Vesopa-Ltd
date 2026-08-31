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

const countries = require('../countries');

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

/**
 * Split "shop.example.co.uk" into { sld: 'example', tld: 'co.uk' }.
 *
 * THIS SET HAS TO KNOW EVERY DOTTED EXTENSION WE SELL, or the split is wrong in
 * the one direction that costs money: `example.com.au` with `com.au` missing
 * parses as sld `example.com` under tld `au`, and the customer is quoted and
 * sold the wrong name entirely.
 *
 * The hardcoded list below is the floor — the extensions this function must get
 * right even if the database is unreachable. `learn()` adds the rest from the
 * `tlds` table on catalogue load, which is what keeps the two in step now that
 * the catalogue carries some ninety dotted extensions rather than sixteen.
 */
const MULTI_PART_TLDS = new Set([
  'co.uk', 'org.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk', 'sch.uk', 'ac.uk', 'gov.uk',
  'com.au', 'net.au', 'org.au', 'co.nz', 'co.za', 'com.br', 'co.in', 'co.jp',
]);

/**
 * Teach the splitter the dotted extensions in the catalogue.
 *
 * Additive and idempotent: called on every catalogue load, and never removes a
 * hardcoded entry, so a row deactivated in the admin still parses correctly on
 * the way to being told we do not sell it.
 */
function learnTlds(tlds) {
  for (const t of tlds || []) {
    const name = typeof t === 'string' ? t : t?.tld;
    if (name && name.includes('.')) MULTI_PART_TLDS.add(name);
  }
}

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
 * The four contact roles on a registration, spelled the way the gateway spells
 * them back to us.
 *
 * These were 'Registrant', 'Administrative', 'Technical', 'Billing' — the SOAP
 * era's names, which the documentation still prints. Every response from this
 * gateway uses `Registrant`, `Admin`, `Tech`, `Billing`, and a no-op write of
 * an unchanged contact set under those names is accepted (204), so these are
 * the gateway's own vocabulary.
 *
 * WHAT THIS DID *NOT* TURN OUT TO BE. The mismatch was initially suspected of
 * causing the gateway to discard the contacts array and substitute the reseller
 * account's default contact. It does not: measured 2026-09-01, vesopa.site
 * carries `Muzahid Islam / muzahid@onzep.uk` and arpi.site carries
 * `Nas Haque / inashaque@gmail.com` — each domain's own customer, and neither
 * one the reseller ("Vesopa Software Limited"). The old names were evidently
 * being accepted or mapped.
 *
 * (All four contacts sharing a single handle is NOT a sign of substitution
 * either — it is simply how this registrar stores one contact reused for four
 * roles, and it is true of correctly-registered domains too. Worth writing down
 * because it looks alarming and is not.)
 *
 * So this is a correctness change, not a bug fix: send the gateway the words it
 * uses. `assertContacts()` below still reads the contacts back after every
 * registration, because a registrant of record is worth verifying rather than
 * assuming whatever the reason.
 */
const CONTACT_TYPES = ['Registrant', 'Admin', 'Tech', 'Billing'];

/**
 * Our customer row into the gateway's DomainContactDetailCreateDto.
 *
 * Field names and lengths are taken from the gateway's own published schema at
 * /swagger/v1/swagger.json, not from the docs. Two that used to be wrong:
 *
 *   `discloseFlag`, not `isHidden`. There is no `isHidden` in the DTO and the
 *   schema is `additionalProperties: false`, so the old field was an unknown
 *   property on every contact we ever sent.
 *
 *   Every string is length-capped here rather than at the far end, because
 *   over-length values come back as the same opaque "Validation failed."
 *   string that everything else does.
 */
function toContact(c, contactType) {
  const country = (c.country || 'GB').toUpperCase();
  const raw = String(c.phone || '').replace(/[^\d+]/g, '');

  /*
   * The calling code comes from the customer's COUNTRY, which is a required
   * field on the same form, and only falls back to a "+" prefix on the number
   * itself. See the note on DIAL in src/countries.js for why the reverse — the
   * old `phone.slice(1, 3)` with a '44' default — was wrong in two directions
   * at once.
   */
  let cc = countries.dialCode(country);
  let local = raw;
  if (raw.startsWith('+')) {
    // Longest-match the prefix against the real code list so +880 is not read
    // as +88, which is not a country at all.
    const digits = raw.slice(1);
    const match = [cc, ...Object.values(countries.DIAL)]
      .filter(Boolean)
      .filter((d) => digits.startsWith(d))
      .sort((a, b) => b.length - a.length)[0];
    if (match) { cc = match; local = digits.slice(match.length); }
    else local = digits;
  }
  // A national trunk prefix ("0" in the UK, BD, most of Europe) is not part of
  // the international number and the registry rejects the number with it.
  local = local.replace(/\D/g, '').replace(/^0+/, '');

  const cap = (v, n) => String(v || '').trim().slice(0, n);

  return {
    contactType,
    firstName: cap(c.first_name, 80),
    lastName: cap(c.last_name, 80),
    // Registries require a company on the registrant contact. Falling back to
    // the person's own name is what every registrar's own form does for an
    // individual registrant.
    companyName: cap(c.company || `${c.first_name || ''} ${c.last_name || ''}`.trim(), 256),
    eMail: cap(c.email, 256),
    address: cap([c.address1, c.address2].filter(Boolean).join(', '), 256),
    city: cap(c.city, 80),
    state: cap(c.state || c.city, 80),
    country: country.slice(0, 2),
    postalCode: cap(c.postcode, 15),
    phoneCountryCode: cap(cc || '44', 3),
    phone: cap(local, 16),
    faxCountryCode: '',
    fax: '',
    discloseFlag: false,
  };
}

/**
 * Is this customer row complete enough to be a registrant of record?
 *
 * Checked BEFORE the registration call rather than after, because a domain
 * registered against a half-empty contact cannot be un-registered — the money
 * is spent and the wrong details are filed. Returns a list of human-readable
 * field names, empty when the row is good.
 */
function contactGaps(c) {
  const gaps = [];
  if (!String(c?.first_name || '').trim()) gaps.push('first name');
  if (!String(c?.last_name || '').trim()) gaps.push('last name');
  if (!String(c?.email || '').trim()) gaps.push('email address');
  if (!String(c?.address1 || '').trim()) gaps.push('street address');
  if (!String(c?.city || '').trim()) gaps.push('city');
  if (!String(c?.postcode || '').trim()) gaps.push('postcode');
  if (!countries.isValid(c?.country)) gaps.push('country');
  const digits = String(c?.phone || '').replace(/\D/g, '');
  if (digits.length < 6) gaps.push('phone number');
  return gaps;
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

  /*
   * The contact is checked here, at the last point before money moves, and not
   * only at checkout. Provisioning can be retried by an admin days later
   * against a customer row that has since been edited, and a registration made
   * against an incomplete row is not recoverable.
   */
  const gaps = contactGaps(contact);
  if (gaps.length) {
    throw new RegistrarError(
      `Cannot register ${name}: the registrant contact is missing ${gaps.join(', ')}.`,
      { code: 'incomplete_contact' },
    );
  }

  if (!isConnected()) {
    return {
      ok: true,
      mock: true,
      domain: name,
      registrar_ref: `MOCK-${Date.now().toString(36).toUpperCase()}`,
      expires_at: new Date(Date.now() + years * 365 * 864e5).toISOString().slice(0, 10),
      nameservers,
      contacts_verified: true,
    };
  }

  /*
   * Exactly the fields in DomainCreateWithContactInput and no others.
   *
   * `isLocked` and `privacyEnabled` used to be sent here and are not on that
   * schema (checked against the gateway's own /swagger/v1/swagger.json, which
   * declares `additionalProperties: false`). In practice both landed anyway —
   * vesopa.site, registered through this code, came back with privacy and lock
   * both on — so the gateway either tolerates them or defaults them enabled.
   *
   * They are sent as their own documented calls below regardless: relying on an
   * undocumented tolerance for whether a customer's home address is published
   * in WHOIS is not a thing to leave to chance.
   */
  const data = await call('POST', 'domains/register-with-contacts', {
    domainName: name,
    period: years,
    nameServers: (nameservers || []).filter(Boolean),
    contacts: CONTACT_TYPES.map((t) => toContact(contact, t)),
    // Typed as a string dictionary by the gateway; an empty ARRAY fails its
    // deserializer, so it must be an object.
    tldAttributes: {},
  }, { write: true });

  const result = {
    ok: true,
    test: !isLive(),
    domain: name,
    registrar_ref: String(data?.id || data?.domainId || data?.ID || ''),
    expires_at: (data?.expirationDate || data?.dates?.expiration || '').slice(0, 10) || null,
    nameservers,
  };

  // Lock and privacy are post-registration operations. Neither is worth losing
  // a successful registration over, so both are best-effort.
  try { await call('POST', 'domains/lock', { domainName: name }, { write: true }); }
  catch (err) { result.lock_warning = err.message; }
  if (privacy) {
    try {
      await call('POST', 'domains/privacy', { domainName: name, privacyStatus: true }, { write: true });
    } catch (err) { result.privacy_warning = err.message; }
  }

  /*
   * Read the contacts back and repair them if the gateway substituted its own.
   * See the note on CONTACT_TYPES: this substitution is silent, so the only way
   * to know it happened is to look.
   */
  Object.assign(result, await assertContacts(name, contact));
  return result;
}

/**
 * Confirm the registrant we asked for is the registrant on record, and put it
 * right if it is not.
 *
 * Returns `{ contacts_verified, contacts_repaired?, contacts_warning? }` and
 * never throws — a registration that succeeded must not be reported as failed
 * because the verification round trip did. What it must not do is claim the
 * contacts are right without having checked.
 */
async function assertContacts(domain, contact) {
  const { domain: name } = splitDomain(domain);
  const wanted = String(contact?.email || '').trim().toLowerCase();
  if (!wanted) return { contacts_verified: false, contacts_warning: 'No contact email to verify against.' };

  try {
    const info = await call('GET', 'domains/info', { DomainName: name });
    const onRecord = Array.isArray(info?.contacts) ? info.contacts : [];
    const registrant = onRecord.find((c) => /registrant/i.test(c?.contactType || ''));
    if (registrant && String(registrant.eMail || '').trim().toLowerCase() === wanted) {
      return { contacts_verified: true };
    }

    await call('PUT', 'domains/contacts/update', {
      domainName: name,
      contacts: CONTACT_TYPES.map((t) => toContact(contact, t)),
    }, { write: true });

    const after = await call('GET', 'domains/info', { DomainName: name });
    const fixed = (Array.isArray(after?.contacts) ? after.contacts : [])
      .find((c) => /registrant/i.test(c?.contactType || ''));
    const good = fixed && String(fixed.eMail || '').trim().toLowerCase() === wanted;
    return good
      ? { contacts_verified: true, contacts_repaired: true }
      : {
        contacts_verified: false,
        contacts_repaired: true,
        contacts_warning:
            `The registrar is still showing ${fixed?.eMail || 'a different contact'} as registrant of `
            + `${name}. This needs fixing with the registrar by hand.`,
      };
  } catch (err) {
    return { contacts_verified: false, contacts_warning: err.message };
  }
}

/**
 * The contacts currently on record at the registrar. READ ONLY.
 *
 * Separate from `assertContacts` because that one repairs what it finds, which
 * is right after a registration and wrong on a dry run — the repair script's
 * whole first pass is somebody reading a list before anything is written.
 */
async function getDomainContacts(domain) {
  const { domain: name } = splitDomain(domain);
  if (!isConnected()) {
    return { ok: true, mock: true, domain: name, registrant_email: '', contacts: [] };
  }
  const data = await call('GET', 'domains/info', { DomainName: name });
  const contacts = Array.isArray(data?.contacts) ? data.contacts : [];
  const registrant = contacts.find((c) => /registrant/i.test(c?.contactType || ''));
  return {
    ok: true,
    domain: name,
    registrant_email: String(registrant?.eMail || ''),
    registrant_name: `${registrant?.firstName || ''} ${registrant?.lastName || ''}`.trim(),
    // All four sharing one handle is the signature of the gateway having
    // substituted its own default contact — see the note on CONTACT_TYPES.
    single_handle: contacts.length > 1
      && new Set(contacts.map((c) => c?.handle).filter(Boolean)).size === 1,
    contacts,
  };
}

/** Replace the contacts on an existing registration. Used by the repair tool. */
async function updateContacts({ domain, contact }) {
  const { domain: name } = splitDomain(domain);
  const gaps = contactGaps(contact);
  if (gaps.length) {
    throw new RegistrarError(`Contact is missing ${gaps.join(', ')}.`, { code: 'incomplete_contact' });
  }
  if (!isConnected()) return { ok: true, mock: true, domain: name };
  await call('PUT', 'domains/contacts/update', {
    domainName: name,
    contacts: CONTACT_TYPES.map((t) => toContact(contact, t)),
  }, { write: true });
  return { ok: true, domain: name, ...(await assertContacts(name, contact)) };
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
    contacts: contact ? CONTACT_TYPES.map((t) => toContact(contact, t)) : [],
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
    // When the registry says the registration began. The RAA verification clock
    // runs from this, not from when we happen to notice the domain exists.
    started_at: data?.startDate || null,
    /*
     * `objectId` is what this gateway calls the registration's own handle —
     * there is no top-level `id` on an info response, only on the one register
     * returns. Reported here so the reconciler can write a real reference onto
     * a row whose registration succeeded at the registry and failed on our side.
     */
    registrar_ref: String(data?.id || data?.domainId || data?.objectId || ''),
    // The registry's own view of both, which is what makes it possible to tell
    // "we asked for privacy" from "privacy is actually on".
    privacy: data?.privacyProtectionStatus === true,
    locked: data?.lockStatus === true,
    nameservers: data?.nameServers || data?.nameservers || [],
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
  learnTlds,
  validateLabel,
  checkAvailability,
  checkBulk,
  checkMany,
  register,
  updateContacts,
  assertContacts,
  getDomainContacts,
  contactGaps,
  toContact,
  CONTACT_TYPES,
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
