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
        // Remembered either way. Writing the cookie even when the lookup failed
        // is what stops a visitor whose address we cannot place from paying the
        // timeout again on every page they open.
        writeCookie(res, chosen.code);
      }
    }

    if (!chosen) chosen = def;

    req.currency = chosen;
    req.currencySource = source;

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
    const fmt = (minor, code) => {
      if (!code || code === chosen.code) return currency.format(minor, chosen);
      const other = all.find((c) => c.code === String(code).toUpperCase());
      return currency.format(minor, other || chosen);
    };

    res.locals.money = fmt;
    res.locals.moneyParts = (minor, code) => {
      if (!code || code === chosen.code) return currency.parts(minor, chosen);
      const other = all.find((c) => c.code === String(code).toUpperCase());
      return currency.parts(minor, other || chosen);
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
