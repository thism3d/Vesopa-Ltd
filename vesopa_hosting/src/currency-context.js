/**
 * Decides which currency this request is in, and hands the views the helpers
 * that know about it.
 *
 * THE ORDER OF PRECEDENCE IS THE WHOLE DESIGN:
 *
 *   1. what the visitor chose      — a person who has picked a currency has
 *                                    picked it, and no amount of cleverness
 *                                    about their IP outranks that
 *   2. where they appear to be     — first visit only, resolved on the server
 *   3. the default                 — everyone else, and everyone whose lookup
 *                                    did not answer in time
 *
 * Rule 1 above rule 2 is the one that gets built the wrong way round. A British
 * expat in Toronto, a UK company billing through a US parent, anyone behind a
 * corporate VPN: geo is a guess and their click is a fact. Once the cookie is
 * set the lookup never runs again for them.
 */

const currency = require('./currency');
const geo = require('./geo');

const COOKIE = 'vh_cur';
/*
 * The country is remembered beside the currency, because the geo lookup that
 * found it is the only one this visitor will ever pay for -- the currency
 * cookie stops it running again. Anything else that wants to know where
 * somebody is (the Bangla offer, the language prompt) would otherwise either
 * repeat the lookup on every page or go without.
 *
 * Not httpOnly: the language prompt is decided in the browser, and this is a
 * two-letter country code, not a secret.
 */
const COUNTRY_COOKIE = 'vh_cc';
const COOKIE_MAX_AGE = 365 * 24 * 60 * 60 * 1000;

function writeCookie(res, code) {
  res.cookie(COOKIE, code, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: COOKIE_MAX_AGE,
    path: '/',
  });
}

/*
 * THE COUNTRY COOKIE IS SIGNED, BECAUSE IT DECIDES WHO GETS MONEY OFF.
 *
 * It is not httpOnly — the language prompt is decided in the browser and has
 * to read it — so the browser can write it too. That was fine while it only
 * chose which language to offer. It stopped being fine the moment a country
 * also chose who may claim a discount: `document.cookie = 'vh_cc=BD'` in the
 * console was, measured on live on 2026-09-17, enough to make the Bangladesh
 * offer appear for a visitor in any country, and enough to pass the same check
 * at the basket. The code is about to be read out in an advert, so the whole
 * world will know it.
 *
 * Signing keeps every property that made a cookie the right answer — one geo
 * lookup per visitor, readable by the browser, survives a restart — and takes
 * away the one that made it wrong. A forged value fails to verify and is
 * ignored, exactly as if it had never been sent.
 *
 * It is still a MARKETING boundary, not a security one: a VPN moves somebody
 * to Dhaka in a click and no cookie can know better. It is now a boundary that
 * takes a VPN rather than a line of JavaScript.
 */
const crypto = require('node:crypto');

const COUNTRY_SECRET = process.env.GEO_SALT || process.env.SESSION_SECRET || 'vesopa-geo';

function sign(cc) {
  return crypto.createHmac('sha256', COUNTRY_SECRET).update(`cc:${cc}`).digest('base64url').slice(0, 16);
}

/** 'BD.Ab3…' -> 'BD', and anything that does not verify -> ''. */
function readCountryCookie(req) {
  const raw = String(req.cookies?.[COUNTRY_COOKIE] || '');
  const dot = raw.indexOf('.');
  if (dot < 1) return '';
  const cc = raw.slice(0, dot).toUpperCase().slice(0, 2);
  const mac = raw.slice(dot + 1);
  const expected = sign(cc);
  // timingSafeEqual throws on a length mismatch, which a forged value will
  // usually have; compare lengths first so it never becomes the exception path.
  if (mac.length !== expected.length) return '';
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return '';
  return cc;
}

function writeCountryCookie(res, cc) {
  const code = String(cc || '').toUpperCase().slice(0, 2);
  res.cookie(COUNTRY_COOKIE, `${code}.${sign(code)}`, {
    httpOnly: false,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: COOKIE_MAX_AGE,
    path: '/',
  });
}

/**
 * Is this a request worth spending a geo lookup on?
 *
 * A JSON endpoint, an asset and a form POST all inherit whatever the page that
 * led to them resolved; only a top-level page view of somebody with no cookie
 * yet should ever hit the network.
 */
function wantsGeo(req) {
  if (req.method !== 'GET') return false;
  if (req.path.startsWith('/api/')) return false;
  if (req.path.startsWith('/admin')) return false;
  if (req.path.startsWith('/assets/')) return false;
  if (req.path.startsWith('/panel/')) return false;
  return true;
}

async function attach(req, res, next) {
  try {
    const { all, base, default: def } = await currency.load();

    /*
     * The admin is always in the base currency.
     *
     * Every price in there is a base price being edited, and an admin whose own
     * browser had drifted onto USD would otherwise be typing dollars into the
     * pound column. Order pages still show each order in the currency it was
     * actually taken in — that comes off the order row, not off the request.
     */
    let chosen = null;
    let source = 'default';
    /*
     * The country this request's own lookup found, if it did one.
     *
     * Kept because the cookie it is written to cannot be read back until the
     * NEXT request, and the request that matters most is the first one. See
     * where req.country is set below.
     */
    let found = '';

    if (req.path.startsWith('/admin')) {
      chosen = base;
      source = 'admin';
    } else {
      const cookie = String(req.cookies?.[COOKIE] || '').toUpperCase();
      const fromCookie = all.find((c) => c.code === cookie && c.active);
      if (fromCookie) {
        chosen = fromCookie;
        source = 'chosen';
      } else if (wantsGeo(req)) {
        const guess = await geo.currencyFor(req.ip);
        chosen = guess.currency;
        source = guess.country ? 'geo' : 'default';
        found = String(guess.country || '');
        if (guess.country) writeCountryCookie(res, guess.country);
        // Remembered either way. Writing the cookie even when the lookup failed
        // is what stops a visitor whose address we cannot place from paying the
        // timeout again on every page they open.
        writeCookie(res, chosen.code);
      }
    }

    if (!chosen) chosen = def;

    req.currency = chosen;
    req.currencySource = source;
    /*
     * Where they appear to be, for anything that is not about money: the offer
     * shown to Bangladeshi visitors, and the prompt asking whether they would
     * rather read the site in Bangla. Empty when we do not know, which must
     * always read as "no special treatment" rather than as a default country.
     */
    /*
     * THE COOKIE ALONE IS NOT ENOUGH, AND THE FIRST VISIT IS THE ONE THAT PAYS.
     *
     * This used to read the cookie and nothing else. The lookup a few lines up
     * had already found the country and written it to that cookie — but a
     * cookie set on THIS response cannot be read back from THIS request, so
     * req.country was empty on everybody's first page view and only right from
     * their second onwards.
     *
     * Measured on live, 2026-09-17, straight at the app behind nginx with a
     * Bangladeshi address: /bn/offers carried BANGLADESH40 zero times on the
     * first request and twice on the second. An advert's click is always a
     * first request, so every visitor a campaign sent would have been shown
     * "no offers running" on the very page the advert promised the offer on.
     */
    let country = readCountryCookie(req) || found.toUpperCase().slice(0, 2);

    /*
     * A visitor who chose a currency long ago has a currency cookie, so the
     * branch above never runs a lookup for them — and before this they simply
     * had no country at all, plus everyone carrying an old UNSIGNED cookie now
     * verifies as unknown. Both would quietly lose the offer. One lookup, only
     * when the country is genuinely unknown and the request is a page view,
     * and it is remembered signed from then on.
     */
    if (!country && wantsGeo(req)) {
      country = String(await geo.countryFor(req.ip) || '').toUpperCase().slice(0, 2);
      if (country) writeCountryCookie(res, country);
    }

    req.country = country;
    res.locals.country = req.country;

    // -----------------------------------------------------------------------
    // View helpers
    // -----------------------------------------------------------------------
    /*
     * `money()` keeps the signature every template already calls it with, so a
     * hundred existing call sites did not have to change — the VALUES reaching
     * the views are already converted by the pricing layer, and this only
     * formats them.
     *
     * The optional second argument is for the handful of places that must print
     * an amount in a currency other than the request's: an admin looking at a
     * dollar order, a renewal notice for a service sold in Canada.
     */
    /*
     * THE LOCALE IS PASSED, NOT LOOKED UP.
     *
     * currency.format() defaults its locale to i18n.currentLocale(), which
     * reads an AsyncLocalStorage set around the route handler. A template is
     * rendered AFTER that handler has returned, so by the time money() runs
     * inside an EJS view the store is gone and every figure came out in
     * English digits. The effect was visible and odd: on the Bangla home page
     * the big plan price read ৳৪৪৬.০০ (from pricing's cached parts, computed
     * inside the context) while the line directly beneath it read ৳5,352.00.
     *
     * Passing req.locale removes the dependency on where the call happens.
     */
    const locale = req.locale;
    const fmt = (minor, code) => {
      if (!code || code === chosen.code) return currency.format(minor, chosen, locale);
      const other = all.find((c) => c.code === String(code).toUpperCase());
      return currency.format(minor, other || chosen, locale);
    };

    res.locals.money = fmt;
    res.locals.moneyParts = (minor, code) => {
      if (!code || code === chosen.code) return currency.parts(minor, chosen, locale);
      const other = all.find((c) => c.code === String(code).toUpperCase());
      return currency.parts(minor, other || chosen, locale);
    };
    res.locals.currency = chosen;
    res.locals.currencies = all.filter((c) => c.active);
    res.locals.currencySource = source;
    res.locals.vatPercent = chosen.vat_percent;
    res.locals.vatLabel = chosen.vat_label || 'VAT';
    // Templates ask this before drawing a VAT row at all. A USD price has no
    // UK VAT inside it, so there is nothing to report and no row to draw.
    res.locals.showVat = chosen.vat_percent > 0;

    next();
  } catch (err) {
    next(err);
  }
}

/**
 * The switcher target. `/currency/USD?to=/hosting`.
 *
 * A GET rather than a POST because it changes a display preference and nothing
 * else — no order, no account, no money. It is also what lets the switcher be
 * three plain links that work with JavaScript switched off.
 *
 * `to` is validated to be a path on this site. Reflecting it back into a
 * redirect without that check is an open redirect, and an open redirect on a
 * URL that looks as harmless as this one is exactly the sort that ships.
 */
function safeReturnTo(raw) {
  const to = String(raw || '/');
  // Must start with a single slash. `//evil.com` and `https://evil.com` are
  // both absolute despite one of them looking relative.
  if (!to.startsWith('/') || to.startsWith('//') || to.includes('\\')) return '/';
  return to.slice(0, 512);
}

async function switchTo(req, res, next) {
  try {
    const wanted = String(req.params.code || '').toUpperCase();
    const { all } = await currency.load();
    const found = all.find((c) => c.code === wanted && c.active);
    if (found) writeCookie(res, found.code);
    res.redirect(safeReturnTo(req.query.to));
  } catch (err) {
    next(err);
  }
}

module.exports = { attach, switchTo, safeReturnTo, COOKIE };
