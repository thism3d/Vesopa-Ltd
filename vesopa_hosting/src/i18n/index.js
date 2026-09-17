/**
 * Languages: English, and Bangla.
 *
 * ---------------------------------------------------------------------------
 * THE ENGLISH TEXT IS THE KEY
 * ---------------------------------------------------------------------------
 * Every string is written in the template exactly as it reads in English and
 * wrapped: `<%= t('Web hosting') %>`. The Bangla lives in src/i18n/bn/*.json,
 * keyed by that same English. It is the gettext arrangement, and it is chosen
 * over `t('nav.hosting')` keys for one reason: this codebase is read and
 * edited in English, and a template full of dotted keys is a template nobody
 * can review without a second file open. Whitespace in a key is collapsed
 * before lookup, so a paragraph may stay wrapped across lines in the template.
 *
 * A string with no Bangla falls back to its English — the page still works —
 * and `npm run i18n:check` fails until it has one. That check, not this file,
 * is what "complete" means.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE LANGUAGE COMES FROM
 * ---------------------------------------------------------------------------
 *   /bn/...        The public pages have a Bangla address of their own. A
 *                  search engine never sends cookies, so a language that lived
 *                  only in a cookie would be a language Google never sees.
 *                  Visiting one also remembers Bangla (below), so the basket
 *                  and the panel a visitor goes on to are Bangla too.
 *   vh_lang        The remembered choice, set by the switcher or by a /bn
 *                  visit. The panel, sign-in, basket and checkout have one
 *                  address each and are never indexed; they follow it.
 *   otherwise      English. Accept-Language is deliberately NOT used: most
 *                  people in Bangladesh browse with an English browser and
 *                  read English hosting pages, and a site that guessed would
 *                  switch them into a language they did not ask for.
 */

const fs = require('node:fs');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');

/*
 * ADDING A LANGUAGE IS THIS TABLE AND A FOLDER OF JSON.
 *
 * Everything that used to ask "is this Bangla?" now asks this table what the
 * language needs, so a third one is a row here, `src/i18n/<code>/*.json`, and
 * nothing else — no `if (locale === 'xx')` in a template, a stylesheet or a
 * script. The fields past `prefix` are the ones that exist for that:
 *
 *   digits     the numerals the language is written with, '0123456789' order,
 *              or null to keep ASCII. Bangla is written with its own.
 *   css        a stylesheet loaded ONLY on this language's pages — the font
 *              and the line-height a script needs. English pays nothing.
 *   preload    fonts that stylesheet will ask for, preloaded so the first
 *              paint is not a screenful of boxes.
 *   month      'long' or 'short' in a date. Bangla has no accepted
 *              abbreviation — "সেপ" is not how anybody writes it — so it
 *              spells the month out.
 *   dir        'ltr' or 'rtl'. Nothing here is right-to-left yet; it is named
 *              so that the first language that is has one obvious place to
 *              say so rather than a new conditional in head.ejs.
 */
const LOCALES = {
  en: {
    code: 'en', html: 'en-GB', hreflang: 'en-GB', og: 'en_GB', intl: 'en-GB',
    name: 'English', native: 'English', short: 'EN', prefix: '',
    digits: null, css: null, preload: [], month: 'short', dir: 'ltr',
  },
  bn: {
    code: 'bn', html: 'bn', hreflang: 'bn', og: 'bn_BD', intl: 'bn-BD',
    name: 'Bangla', native: 'বাংলা', short: 'বাং', prefix: '/bn',
    digits: '০১২৩৪৫৬৭৮৯',
    css: '/assets/css/bn.css',
    preload: [{ href: '/assets/fonts/noto-sans-bengali-wght.woff2', as: 'font', type: 'font/woff2' }],
    month: 'long', dir: 'ltr',
  },
};
const DEFAULT_LOCALE = 'en';
const COOKIE = 'vh_lang';
const COOKIE_MAX_AGE = 365 * 24 * 60 * 60 * 1000;

/*
 * The pages that have a /bn address, and are listed in the sitemap with one.
 * Everything else — the panel, the basket, sign-in, payment returns — is one
 * address in whichever language the visitor chose.
 */
const PUBLIC_EXACT = new Set([
  '/', '/hosting', '/email', '/ssl', '/transfer', '/support', '/about', '/contact', '/build',
  '/offers',
  '/terms', '/privacy', '/aup', '/refunds',
]);
const PUBLIC_PREFIX = ['/domains'];

function isPublicPath(p) {
  const clean = String(p || '/').split(/[?#]/)[0] || '/';
  if (PUBLIC_EXACT.has(clean)) return true;
  return PUBLIC_PREFIX.some((pre) => clean === pre || clean.startsWith(`${pre}/`));
}

// ---------------------------------------------------------------------------
// Catalogues
// ---------------------------------------------------------------------------
const norm = (s) => String(s).replace(/\s+/g, ' ').trim();

function loadCatalogue(locale) {
  const dir = path.join(__dirname, locale);
  const map = new Map();
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return map;
  }
  for (const file of files) {
    const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    for (const [key, value] of Object.entries(data)) {
      const k = norm(key);
      if (map.has(k) && map.get(k) !== value) {
        console.warn(`[i18n] ${locale}: "${k.slice(0, 60)}" is translated twice, differently (${file})`);
      }
      map.set(k, value);
    }
  }
  return map;
}

/** Every language but the one the source is written in. */
const CATALOGUES = Object.fromEntries(
  Object.keys(LOCALES)
    .filter((code) => code !== DEFAULT_LOCALE)
    .map((code) => [code, loadCatalogue(code)]),
);

/** The strings the browser needs, served as /i18n/<locale>.js. */
function clientMessages(locale) {
  if (!CATALOGUES[locale]) return {};
  try {
    const data = JSON.parse(fs.readFileSync(path.join(__dirname, locale, 'client.json'), 'utf8'));
    const out = {};
    for (const [k, v] of Object.entries(data)) out[norm(k)] = v;
    return out;
  } catch {
    return {};
  }
}

/**
 * Everything the browser half needs, as one object.
 *
 * The numerals travel WITH the strings rather than being a table inside
 * i18n.js, for the same reason as everything else in this file: a language
 * added to LOCALES should not need a second edit in a script.
 */
function clientPayload(locale) {
  const info = LOCALES[locale] || LOCALES[DEFAULT_LOCALE];
  return {
    locale: info.code,
    intl: info.intl,
    digits: info.digits || null,
    messages: clientMessages(info.code),
  };
}

// ---------------------------------------------------------------------------
// Numbers and words
// ---------------------------------------------------------------------------
/** ASCII digits to the locale's own. Bangla is written with Bangla numerals. */
function digits(value, locale) {
  const s = String(value);
  const set = LOCALES[locale] && LOCALES[locale].digits;
  if (!set) return s;
  return s.replace(/[0-9]/g, (d) => set[Number(d)]);
}

const escapeHtml = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const missingSeen = new Set();

function lookup(locale, key) {
  if (locale === DEFAULT_LOCALE) return key;
  const found = CATALOGUES[locale] && CATALOGUES[locale].get(norm(key));
  if (found !== undefined) return found;
  if (process.env.NODE_ENV !== 'production' && !missingSeen.has(key)) {
    missingSeen.add(key);
    console.warn(`[i18n] no ${locale} for: ${norm(key).slice(0, 120)}`);
  }
  return key;
}

function fill(text, vars, locale, html) {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name) => {
    if (!Object.prototype.hasOwnProperty.call(vars, name)) return whole;
    const v = vars[name];
    const s = typeof v === 'number' ? digits(v, locale) : String(v == null ? '' : v);
    return html ? escapeHtml(s) : s;
  });
}

/** Plain text. Print with <%= %>. */
function translate(locale, key, vars) {
  return fill(lookup(locale, key), vars, locale, false);
}

/** A string that carries its own markup. Print with <%- %>; the values are escaped. */
function translateHtml(locale, key, vars) {
  return fill(lookup(locale, key), vars, locale, true);
}

/**
 * One and many. Bangla does not change the noun for a count, so the Bangla
 * catalogue holds one entry, under the singular English.
 */
function translatePlural(locale, one, other, n, vars) {
  const all = { n, ...(vars || {}) };
  if (locale !== DEFAULT_LOCALE && CATALOGUES[locale] && CATALOGUES[locale].has(norm(one))) {
    return fill(CATALOGUES[locale].get(norm(one)), all, locale, false);
  }
  return fill(lookup(locale, Number(n) === 1 ? one : other), all, locale, false);
}

/** "4 minutes ago", or a date. See `when` in server.js for why. */
function when(locale, value, opts = {}) {
  if (!value) return opts.empty || '—';
  const at = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(at.getTime())) return String(value);
  const secs = Math.round((Date.now() - at.getTime()) / 1000);
  if (!opts.dateOnly && secs >= 0 && secs < 60) return translate(locale, 'just now');
  if (!opts.dateOnly && secs < 3600) {
    const m = Math.round(secs / 60);
    return translatePlural(locale, '{n} minute ago', '{n} minutes ago', m);
  }
  if (!opts.dateOnly && secs < 86400) {
    const h = Math.round(secs / 3600);
    return translatePlural(locale, '{n} hour ago', '{n} hours ago', h);
  }
  return date(locale, at);
}

function date(locale, value, options) {
  const at = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(at.getTime())) return String(value);
  const info = LOCALES[locale] || LOCALES[DEFAULT_LOCALE];
  return at.toLocaleDateString(info.intl, options || {
    // Whether the month is abbreviated is the language's business: see LOCALES.
    day: 'numeric', month: info.month || 'short', year: 'numeric', timeZone: 'Europe/London',
  });
}

/** Everything a template or a route needs, bound to one language. */
function forLocale(locale) {
  const code = LOCALES[locale] ? locale : DEFAULT_LOCALE;
  return {
    locale: code,
    info: LOCALES[code],
    t: (key, vars) => translate(code, key, vars),
    th: (key, vars) => translateHtml(code, key, vars),
    tn: (one, other, n, vars) => translatePlural(code, one, other, n, vars),
    num: (value) => digits(value, code),
    when: (value, opts) => when(code, value, opts),
    date: (value, options) => date(code, value, options),
  };
}

/*
 * The language of the request being served, for code with no `req` to hand:
 * currency.format() called from a route, a warning built in notifications.js.
 * An email sent from a background job has no request at all and says which
 * language it wants with withLocale(customer.locale, ...).
 */
const context = new AsyncLocalStorage();

function currentLocale() {
  const store = context.getStore();
  return store && LOCALES[store.locale] ? store.locale : DEFAULT_LOCALE;
}

function current() {
  return forLocale(currentLocale());
}

function withLocale(locale, fn) {
  return context.run({ locale: LOCALES[locale] ? locale : DEFAULT_LOCALE }, fn);
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------
/** The same page in another language: '/hosting' <-> '/bn/hosting'. */
function localizePath(url, locale) {
  const raw = String(url || '/');
  const bare = stripPrefix(raw);
  const target = LOCALES[locale] || LOCALES[DEFAULT_LOCALE];
  if (!target.prefix || !isPublicPath(bare)) return bare;
  return `${target.prefix}${bare.startsWith('/') ? bare : `/${bare}`}`;
}

function stripPrefix(url) {
  const raw = String(url || '/');
  for (const info of Object.values(LOCALES)) {
    if (!info.prefix) continue;
    if (raw === info.prefix) return '/';
    if (raw.startsWith(`${info.prefix}/`) || raw.startsWith(`${info.prefix}?`) || raw.startsWith(`${info.prefix}#`)) {
      const rest = raw.slice(info.prefix.length);
      return rest.startsWith('/') ? rest : `/${rest}`;
    }
  }
  return raw;
}

/*
 * Links on a Bangla page stay Bangla.
 *
 * Every public link in every template is written as its English address. On a
 * Bangla page they are rewritten here, once, as the HTML leaves — rather than
 * every href in sixty templates calling a helper that one of them would forget.
 * Only the public pages are rewritten; a link into the panel keeps its one
 * address and the remembered language carries it.
 */
function localizeHtml(html, locale) {
  const info = LOCALES[locale];
  if (!info || !info.prefix) return html;
  return html.replace(/(\s(?:href|action))="(\/(?!\/)[^"]*)"/g, (whole, attr, url) => {
    if (url === info.prefix || url.startsWith(`${info.prefix}/`) || url.startsWith(`${info.prefix}?`)) return whole;
    if (url.startsWith('/assets/') || url.startsWith('/i18n/')) return whole;
    if (!isPublicPath(url)) return whole;
    return `${attr}="${localizePath(url, locale)}"`;
  });
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
function writeCookie(res, code) {
  res.cookie(COOKIE, code, {
    httpOnly: false, // the assistant reads it to start in the same language
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: COOKIE_MAX_AGE,
    path: '/',
  });
}

/**
 * Decide the language and take the prefix off, so every route below is written
 * once, for '/hosting', and answers '/bn/hosting' too.
 */
function resolve(req, res, next) {
  let locale = null;
  let prefixed = false;
  for (const info of Object.values(LOCALES)) {
    if (!info.prefix) continue;
    const url = req.url;
    if (url === info.prefix || url.startsWith(`${info.prefix}/`) || url.startsWith(`${info.prefix}?`)) {
      // '/bn' on its own is sent to '/bn/', so the Bangla home page has one address.
      if ((url === info.prefix || url.startsWith(`${info.prefix}?`)) && req.method === 'GET') {
        return res.redirect(301, `${info.prefix}/${url.slice(info.prefix.length)}`);
      }
      locale = info.code;
      prefixed = true;
      req.url = url.slice(info.prefix.length) || '/';
      break;
    }
  }

  const remembered = String(req.cookies?.[COOKIE] || '');
  if (!locale) locale = LOCALES[remembered] ? remembered : DEFAULT_LOCALE;
  if (prefixed && remembered !== locale) writeCookie(res, locale);

  const bound = forLocale(locale);
  req.locale = locale;
  req.localePrefixed = prefixed;
  req.t = bound.t;
  req.th = bound.th;
  req.tn = bound.tn;
  req.i18n = bound;

  res.locals.locale = locale;
  res.locals.localeInfo = LOCALES[locale];
  res.locals.locales = Object.values(LOCALES);
  res.locals.t = bound.t;
  res.locals.th = bound.th;
  res.locals.tn = bound.tn;
  res.locals.num = bound.num;
  res.locals.fmtDate = bound.date;
  res.locals.langHref = (code) => `/lang/${code}?to=${encodeURIComponent(req.originalUrl || req.url)}`;
  res.setHeader('Content-Language', LOCALES[locale].html);

  if (LOCALES[locale].prefix) {
    const render = res.render.bind(res);
    res.render = function renderLocalized(view, options, callback) {
      let opts = options;
      let cb = callback;
      if (typeof opts === 'function') {
        cb = opts;
        opts = {};
      }
      render(view, opts, (err, html) => {
        if (err) return cb ? cb(err) : req.next(err);
        const out = localizeHtml(html, locale);
        return cb ? cb(null, out) : res.send(out);
      });
    };
  }
  context.run({ locale }, next);
}

/**
 * The remembered language wins on a public page's English address.
 *
 * Runs after the locals middleware, so that a request from the no-reload
 * router gets its 204-and-a-header redirect like every other. A crawler has no
 * cookie, so it is never redirected and always sees English at an English
 * address.
 */
function redirectRemembered(req, res, next) {
  if (req.method !== 'GET' || req.localePrefixed) return next();
  const info = LOCALES[req.locale];
  if (!info || !info.prefix) return next();
  if (!isPublicPath(req.path)) return next();
  return res.redirect(302, localizePath(req.originalUrl || req.url, req.locale));
}

/** Same page, other language: `/lang/bn?to=/hosting`. */
function switchTo(req, res) {
  const wanted = String(req.params.code || '').toLowerCase();
  const code = LOCALES[wanted] ? wanted : DEFAULT_LOCALE;
  writeCookie(res, code);
  let to = String(req.query.to || '/');
  if (!to.startsWith('/') || to.startsWith('//') || to.includes('\\')) to = '/';
  to = to.slice(0, 512);
  res.set('Cache-Control', 'no-store');
  return res.redirect(302, localizePath(to, code));
}

/** hreflang alternates for a public page, or none. */
function alternates(siteUrl, currentPath) {
  if (!isPublicPath(currentPath)) return [];
  const bare = stripPrefix(currentPath || '/');
  const list = Object.values(LOCALES).map((info) => ({
    hreflang: info.hreflang,
    href: `${siteUrl}${localizePath(bare, info.code)}`,
  }));
  list.push({ hreflang: 'x-default', href: `${siteUrl}${bare}` });
  return list;
}

module.exports = {
  LOCALES,
  DEFAULT_LOCALE,
  COOKIE,
  isPublicPath,
  forLocale,
  translate,
  translateHtml,
  translatePlural,
  digits,
  localizePath,
  localizeHtml,
  stripPrefix,
  alternates,
  clientMessages,
  clientPayload,
  resolve,
  redirectRemembered,
  switchTo,
  norm,
  CATALOGUES,
  currentLocale,
  current,
  withLocale,
};
