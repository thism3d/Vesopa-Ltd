/**
 * A buyer's account on the shop: Continue with Vesopa, and My vouchers.
 *
 * Nobody has to sign in to buy. Somebody who does gets one page of everything
 * bought with, or sent to, their verified email -- across every venue -- with
 * the live balance of each voucher, their tickets, a resend, and Add to
 * Wallet. Signing in also pre-fills the checkout and ties the order to the
 * account, so a buyer who later changes email address keeps their history.
 *
 * Its own Auth client (vesopa-gift-shop: open, consent shown), its own session
 * table and cookie. A customer's session is never a staff session, whatever
 * the two cookies say.
 */

const express = require('express');
const crypto = require('crypto');

const db = require('./db');
const epos = require('./epos');
const venues = require('./venues');
const fulfil = require('./fulfil');
const orders = require('./orders');
const util = require('./util');
const config = require('./config');
const { createClient } = require('./oidc');
const { limiter } = require('./security');
const last = require('./last');

const COOKIE = config.production ? '__Host-vg_acct' : 'vg_acct';
const STATE_COOKIE = 'vg_acct_state';
const DAYS = 30;
const hash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

const oidc = createClient({
  issuer: config.AUTH_ISSUER,
  clientId: config.SHOP_CLIENT_ID,
  clientSecret: config.SHOP_CLIENT_SECRET,
  redirectUri: `${config.BASE_URL}/account/callback`,
  scope: 'openid profile email',
});

// ---- Sessions -----------------------------------------------------------------

async function create(res, person, ip) {
  const tokenValue = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(16).toString('hex');
  await db.run(
    `INSERT INTO gift_customer_sessions (id, sub, email, name, csrf, ip, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? DAY))`,
    [hash(tokenValue), person.sub, person.email, person.name, csrf, String(ip || '').slice(0, 45), DAYS]
  );
  res.cookie(COOKIE, tokenValue, { httpOnly: true, secure: config.production, sameSite: 'lax', path: '/', maxAge: DAYS * 86400 * 1000 });
}

async function read(req) {
  const raw = req.cookies && req.cookies[COOKIE];
  if (!raw) return null;
  const row = await db.one(
    'SELECT * FROM gift_customer_sessions WHERE id = ? AND revoked_at IS NULL AND expires_at > UTC_TIMESTAMP()',
    [hash(raw)]
  );
  if (!row) return null;
  return { sub: row.sub, email: row.email, name: row.name || row.email, first: String(row.name || '').split(' ')[0] || 'you', csrf: row.csrf };
}

async function destroy(req, res) {
  const raw = req.cookies && req.cookies[COOKIE];
  if (raw) await db.run('UPDATE gift_customer_sessions SET revoked_at = UTC_TIMESTAMP() WHERE id = ?', [hash(raw)]);
  res.clearCookie(COOKIE, { path: '/' });
}

function csrfOk(req, account) {
  const given = String((req.body && req.body._csrf) || req.get('x-csrf-token') || '');
  if (!account || given.length !== account.csrf.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(account.csrf));
}

/** Every request, before the shop: who is signed in, for the templates and the checkout. */
async function attach(req, res, next) {
  try {
    req.account = await read(req);
    res.locals.account = req.account;
    res.locals.accountEnabled = oidc.enabled;
    next();
  } catch (e) { next(e); }
}

// ---- What is theirs -------------------------------------------------------------

/** A path on this site, or the account page. Never another host. */
function safeReturn(to) {
  const s = String(to || '');
  return /^\/[a-z0-9][a-z0-9\-/]*$/i.test(s) && !s.startsWith('//') ? s : '/account';
}

async function mine(account) {
  const rows = await db.all(
    `SELECT l.*, o.office_id, o.buyer_name, o.buyer_email, o.paid_at, o.status AS order_status, o.public_id, o.kind AS order_kind,
            o.total_minor, o.id AS order_id
       FROM gift_order_lines l JOIN gift_orders o ON o.id = l.order_id
      WHERE o.status IN ('paid', 'refunded')
        AND (o.account_sub = ? OR o.buyer_email = ? OR l.recipient_email = ?)
      ORDER BY o.paid_at DESC, l.line_no`,
    [account.sub, account.email, account.email]
  );
  const byVenue = new Map();
  for (const l of rows) {
    if (!byVenue.has(l.office_id)) {
      const venue = await venues.get(l.office_id);
      if (!venue) continue;
      byVenue.set(l.office_id, { venue, brand: venues.brandOf(venue), vouchers: [], tickets: [] });
    }
    const v = byVenue.get(l.office_id);
    l.ref = orders.ref({ id: l.order_id });
    l.mine = l.recipient_email === account.email && l.buyer_email !== account.email ? 'given' : 'bought';
    if (l.kind === 'ticket') {
      l.event = await db.one('SELECT * FROM gift_events WHERE id = ?', [l.event_id]);
      l.tickets = await db.all('SELECT * FROM gift_tickets WHERE line_id = ? ORDER BY seq', [l.id]);
      v.tickets.push(l);
    } else {
      l.design = l.design_id ? await venues.design(l.office_id, l.design_id) : null;
      v.vouchers.push(l);
    }
  }
  // Balances, read live from the EPOS, a few at a time; a voucher whose venue
  // is unreachable shows without one rather than holding the page.
  const cards = [...byVenue.values()].flatMap((v) => v.vouchers.filter((l) => l.card_id));
  await Promise.all(cards.map(async (l) => {
    try {
      const r = await epos.card(l.office_id, l.card_id);
      l.balance = r.card.balance_minor;
      l.cardStatus = r.card.status;
    } catch { l.balance = null; }
  }));
  return [...byVenue.values()];
}

async function lineOfMine(account, id) {
  const l = await db.one(
    `SELECT l.*, o.buyer_email, o.account_sub, o.status AS order_status
       FROM gift_order_lines l JOIN gift_orders o ON o.id = l.order_id WHERE l.id = ?`,
    [Number(id)]
  );
  if (!l || l.order_status !== 'paid') return null;
  const theirs = l.account_sub === account.sub || l.buyer_email === account.email || l.recipient_email === account.email;
  return theirs ? l : null;
}

// ---- Routes ------------------------------------------------------------------------

const router = express.Router();

function page(res, view, data) {
  const brand = { name: 'Vesopa Gift', logo: null, icon: null, hero: null, primary: '#1f2a24', fonts: {}, links: {}, address: null };
  const { theme } = require('./shop');
  res.set('Cache-Control', 'no-store');
  res.render(`shop/${view}`, { brand: null, theme: theme(brand), money: util.money, when: util.when, dateLong: util.dateLong, designUrl: venues.designUrl, scripts: [], bodyClass: 'sunken-page', ...data });
}

router.get('/account', async (req, res, next) => {
  try {
    if (!req.account) {
      return page(res, 'account-signin', { title: 'Your vouchers — Vesopa Gift', ready: oidc.enabled, returnTo: safeReturn(req.query.to), last: last.read(req, 'acct') });
    }
    const groups = await mine(req.account);
    const sent = String(req.query.sent || '');
    const flash = sent === 'no' ? { ok: false, text: 'That copy could not be sent just now. Try again in a minute.' }
      : sent ? { ok: true, text: `A copy is on its way to ${req.account.email}.` } : null;
    page(res, 'account', { title: 'Your vouchers — Vesopa Gift', groups, csrf: req.account.csrf, flash });
  } catch (e) { next(e); }
});

const stateCookie = { httpOnly: true, secure: config.production, sameSite: 'lax', path: '/account', maxAge: 10 * 60 * 1000 };

router.get('/account/start', (req, res) => {
  if (!oidc.enabled) return res.redirect(303, '/account');
  const remembered = last.read(req, 'acct');
  const { url, state } = oidc.begin({
    returnTo: safeReturn(req.query.to),
    select: req.query.switch === '1',
    hint: remembered && req.query.switch !== '1' ? remembered.email : '',
  });
  res.cookie(STATE_COOKIE, state, stateCookie);
  res.redirect(303, url);
});

router.get('/account/callback', async (req, res) => {
  const held = req.cookies && req.cookies[STATE_COOKIE];
  res.clearCookie(STATE_COOKIE, { path: '/account' });
  try {
    if (!held || !crypto.timingSafeEqual(
      crypto.createHash('sha256').update(String(held)).digest(),
      crypto.createHash('sha256').update(String(req.query.state || '')).digest()
    )) throw new Error('the sign-in was started in another browser');
    const person = await oidc.complete(req.query);
    if (!person.email) {
      return page(res, 'message', { title: 'Confirm your email', heading: 'Your email address is not confirmed', body: 'Sign in to your Vesopa account with an emailed code once, then come back: your vouchers are found by that address.' });
    }
    if (req.account) await destroy(req, res);
    await create(res, person, req.ip);
    last.write(res, 'acct', person);
    await fulfil.audit(null, 'account.signin', null, person.email);
    res.redirect(303, safeReturn(person.returnTo));
  } catch (e) {
    console.warn(`[account] sign-in failed: ${e.message}`);
    page(res, 'account-signin', { title: 'Your vouchers — Vesopa Gift', ready: oidc.enabled, returnTo: '/account', error: 'That sign-in did not work. Try again.' });
  }
});

router.post('/account/signout', async (req, res, next) => {
  try {
    if (req.account && csrfOk(req, req.account)) await destroy(req, res);
    res.redirect(303, '/account/signed-out');
  } catch (e) { next(e); }
});

router.get('/account/signed-out', (req, res) => {
  page(res, 'message', { title: 'Signed out — Vesopa Gift', heading: 'You are signed out', body: 'Your vouchers are still yours: sign in again any time to see them.' });
});

const resendLimit = limiter({ perMinute: 3, key: (req) => `resend:${req.account ? req.account.sub : req.ip}` });

router.post('/account/lines/:id/resend', resendLimit, async (req, res, next) => {
  try {
    if (!req.account || !csrfOk(req, req.account)) return res.redirect(303, '/account');
    const l = await lineOfMine(req.account, req.params.id);
    // Not a cancelled one, and not one still waiting for the day the buyer chose.
    if (!l || l.voided_at || !l.delivered_at) return res.redirect(303, '/account');
    const order = await db.one('SELECT * FROM gift_orders WHERE id = ?', [l.order_id]);
    // To the account's own address, whoever it was first sent to: this is the
    // person asking, and it is their voucher.
    await fulfil.copyLineTo(order, l, req.account.email);
    await fulfil.audit(order.office_id, 'account.resend', { line: l.id }, req.account.email);
    res.redirect(303, `/account?sent=${l.id}`);
  } catch (e) {
    console.warn(`[account] resend failed: ${e.message}`);
    res.redirect(303, '/account?sent=no');
  }
});

module.exports = { accountRouter: router, attach, read, create, csrfOk, COOKIE, enabled: () => oidc.enabled };
