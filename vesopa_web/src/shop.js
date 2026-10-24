'use strict';

/**
 * The hardware shop's orders and the customer account on vesopaepos.com
 * (2026-10-24). Tables: schema_shop.sql, created here on start.
 *
 * ORDERS: the basket is priced from src/hardware-catalogue.js on the server,
 * a Dojo payment intent is made for the total (VAT included) and the customer
 * pays on Dojo's checkout. Paid means Captured, read from Dojo (the return
 * page, the webhook forward from the back office, or the sweep), never from
 * the browser. Paid orders email the customer and Vesopa.
 *
 * ACCOUNT: no passwords. /account emails a one-time link (30 minutes); the
 * link sets a signed cookie for that email address. Paying for a trial or an
 * order on Dojo also signs the customer in, because the link they came back on
 * is already private to them. The account page lists their subscriptions,
 * invoices and hardware orders, and opens the back office, where they sign in
 * with "Continue with Vesopa" using the same email.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pool } = require('./db');
const dojo = require('./dojo-billing');
const hw = require('./hardware-catalogue');
const { sendMail, DEFAULT_TO } = require('./mailer');
const { CONTACT } = require('./config');
const subs = require('./subscriptions');
const { resolvePeriod } = require('./plans-store');

const COOKIE = 'vacc';
const SESSION_DAYS = 30;
const DAY = 864e5;
const gbp = (m) => '£' + (Number(m || 0) / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const siteUrl = () => (process.env.SITE_URL || 'https://vesopaepos.com').replace(/\/+$/, '');
const backofficeUrl = () => (process.env.BACKOFFICE_URL || 'https://backoffice.vesopaepos.com').replace(/\/+$/, '');
const looksLikeEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
async function one(q, args) { const [rows] = await pool.query(q, args); return rows[0] || null; }

// ---- tables -------------------------------------------------------------------------

let ready = null;
function ensureTables() {
  if (!ready) {
    const sql = fs.readFileSync(path.join(__dirname, '..', 'schema_shop.sql'), 'utf8')
      .replace(/^--.*$/gm, '').split(';').map((s) => s.trim()).filter(Boolean);
    ready = (async () => { for (const s of sql) await pool.query(s); })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

// ---- account sessions ------------------------------------------------------------------

function secret() {
  const s = process.env.ACCOUNT_SECRET || process.env.SESSION_SECRET;
  if (!s) throw new Error('SESSION_SECRET is not set');
  return 'account:' + s;
}
const sign = (payload) => crypto.createHmac('sha256', secret()).update(payload).digest('base64url');

/** Sign the customer in for SESSION_DAYS. */
function signIn(res, email) {
  const exp = Date.now() + SESSION_DAYS * DAY;
  const payload = Buffer.from(JSON.stringify({ e: String(email).toLowerCase(), x: exp })).toString('base64url');
  res.cookie(COOKIE, `${payload}.${sign(payload)}`, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: SESSION_DAYS * DAY, path: '/' });
}
function signOut(res) { res.clearCookie(COOKIE, { path: '/' }); }

/** The signed-in email, or null. */
function accountEmail(req) {
  const raw = req.cookies && req.cookies[COOKIE];
  if (!raw || !raw.includes('.')) return null;
  const [payload, mac] = raw.split('.');
  try {
    const want = Buffer.from(sign(payload));
    const got = Buffer.from(mac);
    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
    const { e, x } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return x > Date.now() && looksLikeEmail(e) ? e : null;
  } catch { return null; }
}

function mailShell(title, inner) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:#f4f6f4;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f4;padding:28px 12px;"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e2e7e2;">
<tr><td style="background:#000;padding:22px 28px;"><span style="font-family:Arial,Helvetica,sans-serif;font-size:19px;font-weight:bold;color:#fff;letter-spacing:.04em;">VESOPA<span style="color:#a5c715;"> EPOS</span></span></td></tr>
<tr><td style="padding:28px 28px 20px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:24px;color:#354248;">${inner}</td></tr>
<tr><td style="padding:20px 28px;background:#fafbfa;border-top:1px solid #e2e7e2;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:21px;color:#6b7780;">Questions? Call <a href="tel:${esc(CONTACT.emergency_phone_e164)}" style="color:#5f7d0a;">${esc(CONTACT.emergency_phone)}</a> or reply to this email. Payments are processed securely by Dojo; Vesopa never sees your card number.<br><br>${esc(CONTACT.company)}${CONTACT.company_number ? ` · company number ${esc(CONTACT.company_number)}` : ''} · ${esc(CONTACT.address_line1)}, ${esc(CONTACT.address_line2)}</td></tr>
</table></td></tr></table></body></html>`;
}
const button = (href, text) => `<p style="margin:22px 0;"><a href="${esc(href)}" style="display:inline-block;background:#a5c715;color:#101401;text-decoration:none;font-weight:bold;padding:13px 26px;border-radius:8px;">${esc(text)}</a></p>`;

/** Email a one-time sign-in link. Always looks the same to the caller, known address or not. */
async function sendSignInLink(email, next) {
  await ensureTables();
  email = String(email || '').trim().toLowerCase().slice(0, 190);
  if (!looksLikeEmail(email)) throw new Error('Please give a valid email address.');
  const token = crypto.randomBytes(32).toString('base64url');
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query('INSERT INTO web_account_tokens (token_hash, email, expires_at) VALUES (?, ?, UTC_TIMESTAMP() + INTERVAL 30 MINUTE)', [hash, email]);
  const back = typeof next === 'string' && /^\/[a-z0-9/_-]*$/i.test(next) ? `&next=${encodeURIComponent(next)}` : '';
  const url = `${siteUrl()}/account/verify?t=${token}${back}`;
  await sendMail({
    to: email,
    subject: 'Your Vesopa account sign-in link',
    html: mailShell('Sign in to your Vesopa account', `<h1 style="margin:0 0 16px;font-size:21px;color:#000;">Sign in to your Vesopa account</h1>
      <p style="margin:0 0 12px;">Press the button to see your subscription, invoices and hardware orders, and to open your back office.</p>${button(url, 'Sign in to my account')}
      <p style="margin:0;color:#6b7780;font-size:13px;">The link works once and for 30 minutes. If you did not ask for it, ignore this email.</p>`),
  });
}

/** A sign-in link's token to its email (once), or null. */
async function redeem(token) {
  await ensureTables();
  if (typeof token !== 'string' || token.length < 30) return null;
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const row = await one('SELECT * FROM web_account_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > UTC_TIMESTAMP()', [hash]);
  if (!row) return null;
  const [u] = await pool.query('UPDATE web_account_tokens SET used_at = UTC_TIMESTAMP() WHERE id = ? AND used_at IS NULL', [row.id]);
  return u.affectedRows ? row.email : null;
}

/** Everything the account page shows for one email address. */
async function overview(email) {
  await ensureTables();
  const [subs] = await pool.query('SELECT * FROM web_subscriptions WHERE email = ? ORDER BY id DESC', [email]);
  const ids = subs.map((s) => s.id);
  const [invoices] = ids.length
    ? await pool.query('SELECT * FROM web_sub_invoices WHERE subscription_id IN (?) ORDER BY id DESC', [ids])
    : [[]];
  const [orders] = await pool.query("SELECT * FROM web_hw_orders WHERE email = ? AND status <> 'cancelled' ORDER BY id DESC", [email]);
  return { subs, invoices, orders: orders.map(withLines) };
}

// ---- hardware orders -------------------------------------------------------------------

const withLines = (o) => (o ? { ...o, lines: JSON.parse(o.lines_json || '[]') } : o);

async function nextNumber() {
  const ym = new Date().toISOString().slice(0, 7).replace('-', '');
  const row = await one("SELECT COUNT(*) AS n FROM web_hw_orders WHERE number LIKE ?", [`VH-${ym}-%`]);
  return `VH-${ym}-${String(Number(row.n) + 1).padStart(5, '0')}`;
}

function clean(v, n) { return String(v == null ? '' : v).trim().slice(0, n); }

/** Validate the checkout form, save the order and open Dojo's checkout. Returns { url }. */
async function createOrder(body) {
  await ensureTables();
  const cart = hw.parseCart(body.cart || '');
  if (!cart.length) throw new Error('Your basket is empty.');
  const priced = hw.priceCart(cart, body.delivery);
  if (priced.needsDelivery && !priced.delivery) throw new Error('Please choose a delivery option.');
  const f = {
    name: clean(body.name, 120), business: clean(body.business, 160), email: clean(body.email, 190).toLowerCase(), phone: clean(body.phone, 40),
    address1: clean(body.address1, 160), address2: clean(body.address2, 160), town: clean(body.town, 80), postcode: clean(body.postcode, 16).toUpperCase(), notes: clean(body.notes, 500),
  };
  if (!f.name) throw new Error('Please give your name.');
  if (!looksLikeEmail(f.email)) throw new Error('Please give a valid email address.');
  if (!f.phone) throw new Error('Please give a phone number for the delivery.');
  if (!f.address1 || !f.town) throw new Error('Please give the delivery address.');
  if (!/^[A-Z]{1,2}[0-9][A-Z0-9]? ?[0-9][A-Z]{2}$/.test(f.postcode)) throw new Error('Please give a UK postcode.');
  // A software trial added to the order starts when the order is paid, with no £1 check.
  // One trial per email: an address that has had one still orders the hardware,
  // just without a second trial (never blocks the purchase).
  let trialPeriod = body.trial === '1' ? String(resolvePeriod(body.trial_period)) : null;
  if (trialPeriod && await subs.trialUsed(f.email)) trialPeriod = null;
  // Invoice details: the company, VAT number and billing address the paid
  // invoice is made out to. Blank means the delivery name and address.
  // Ticked "invoice to the name and delivery address above" (the default): none of it.
  const own = body.bill_same !== '1';
  const inv = own
    ? { company: clean(body.invoice_company, 160), vat: clean(body.invoice_vat, 40).toUpperCase(), email: clean(body.invoice_email, 190).toLowerCase() }
    : { company: '', vat: '', email: '' };
  if (inv.email && !looksLikeEmail(inv.email)) throw new Error('Please check the invoice email address.');
  const billDifferent = own && clean(body.bill_address1, 160);
  const bill = billDifferent
    ? { a1: clean(body.bill_address1, 160), a2: clean(body.bill_address2, 160), town: clean(body.bill_town, 80), pc: clean(body.bill_postcode, 16).toUpperCase() }
    : null;
  if (bill && (!bill.town || !bill.pc)) throw new Error('Please complete the billing address, or tick "same as delivery".');
  const publicId = crypto.randomBytes(12).toString('hex');
  const number = await nextNumber();
  const [r] = await pool.query(
    `INSERT INTO web_hw_orders (public_id, number, contact_name, business, email, phone, address1, address2, town, postcode, notes, trial_period,
       lines_json, delivery_key, delivery_name, goods_minor, delivery_minor, vat_minor, total_minor, dojo_mode)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [publicId, number, f.name, f.business || null, f.email, f.phone, f.address1, f.address2 || null, f.town, f.postcode, f.notes || null, trialPeriod,
      JSON.stringify(priced.lines), priced.delivery ? priced.delivery.key : null, priced.delivery ? priced.delivery.name : null,
      priced.goods, priced.deliveryMinor, priced.vat, priced.total, dojo.mode()]);
  const pi = await dojo.createPaymentIntent({
    amountMinor: priced.total,
    reference: `${number} ${f.business || f.name}`.slice(0, 80),
    description: `Vesopa hardware order ${number}`,
    redirectUrl: `${siteUrl()}/hardware/order/${publicId}`,
  });
  await pool.query('UPDATE web_hw_orders SET payment_intent_id = ? WHERE id = ?', [pi.id, r.insertId]);
  await pool.query('UPDATE web_hw_orders SET invoice_company = ?, invoice_vat = ?, invoice_email = ?, bill_address1 = ?, bill_address2 = ?, bill_town = ?, bill_postcode = ? WHERE id = ?',
    [inv.company || f.business || null, inv.vat || null, inv.email || null, bill ? bill.a1 : null, bill ? bill.a2 || null : null, bill ? bill.town : null, bill ? bill.pc : null, r.insertId]);
  return { publicId, url: dojo.checkoutUrl(pi.id) };
}

const orderByPublic = async (publicId) => withLines(await one('SELECT * FROM web_hw_orders WHERE public_id = ?', [String(publicId || '')]));

function orderTable(o) {
  const row = (a, b, strong) => `<tr><td style="padding:6px 0;border-bottom:1px solid #eef1ea;${strong ? 'font-weight:bold;color:#000;' : ''}">${esc(a)}</td><td align="right" style="padding:6px 0;border-bottom:1px solid #eef1ea;${strong ? 'font-weight:bold;color:#000;' : ''}">${esc(b)}</td></tr>`;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;">
    ${o.lines.map((l) => row(`${l.qty} × ${l.name}`, gbp(l.total_minor))).join('')}
    ${o.delivery_minor ? row(`Delivery: ${o.delivery_name}`, gbp(o.delivery_minor)) : row('Delivery', 'Included')}
    ${row('VAT (20%)', gbp(o.vat_minor))}${row('Total paid', gbp(o.total_minor), true)}</table>
    <p style="margin:14px 0 0;font-size:14px;"><strong style="color:#000;">Deliver to</strong><br>${esc(o.contact_name)}${o.business ? `, ${esc(o.business)}` : ''}<br>${esc(o.address1)}${o.address2 ? `, ${esc(o.address2)}` : ''}<br>${esc(o.town)} ${esc(o.postcode)}<br>${esc(o.phone)}</p>`;
}

async function markOrderPaid(o, pi) {
  const [u] = await pool.query("UPDATE web_hw_orders SET status = 'paid', paid_at = UTC_TIMESTAMP(), card_label = ? WHERE id = ? AND status = 'pending'", [dojo.cardLabel(pi), o.id]);
  if (!u.affectedRows) return;
  let fresh = await orderByPublic(o.public_id);
  let trial = null;
  if (fresh.trial_period) {
    try {
      trial = await subs.startTrialFromOrder({ period: fresh.trial_period, venue: fresh.business || fresh.contact_name, name: fresh.contact_name,
        email: fresh.email, phone: fresh.phone, cardLabel: fresh.card_label, orderNumber: fresh.number });
    } catch (e) { console.error('[shop] trial from order', fresh.number, e.message); }
  }
  const acct = `${siteUrl()}/account`;
  const invoiceUrl = `${siteUrl()}/hardware/order/${fresh.public_id}/invoice`;
  const trialLine = trial ? `<p style="margin:0 0 16px;">Your <strong>Vesopa EPOS free trial</strong> (${esc(trial.plan_name)}) has started too; it runs for 14 days. Open your back office at <a href="${esc(backofficeUrl())}" style="color:#5f7d0a;">backoffice.vesopaepos.com</a> with Continue with Vesopa using this email address.</p>` : '';
  sendMail({
    to: fresh.invoice_email && fresh.invoice_email !== fresh.email ? `${fresh.email}, ${fresh.invoice_email}` : fresh.email,
    subject: `Order ${fresh.number} confirmed: thank you`,
    html: mailShell(`Order ${fresh.number}`, `<h1 style="margin:0 0 16px;font-size:21px;color:#000;">Thank you, your order is confirmed</h1>
      <p style="margin:0 0 16px;">We have received ${esc(gbp(fresh.total_minor))} for order <strong>${esc(fresh.number)}</strong>. We will be in touch to arrange delivery and set-up${fresh.delivery_name ? ` (${esc(fresh.delivery_name)})` : ''}.</p>
      ${trialLine}${orderTable(fresh)}${button(invoiceUrl, 'View your paid invoice')}<p style="margin:0;"><a href="${esc(acct)}" style="color:#5f7d0a;">Your account</a>: orders, invoices and your back office.</p>`),
  }).catch(() => {});
  sendMail({
    to: DEFAULT_TO,
    replyTo: fresh.email,
    subject: `New hardware order ${fresh.number}: ${gbp(fresh.total_minor)} paid`,
    html: mailShell(`Order ${fresh.number}`, `<h1 style="margin:0 0 16px;font-size:21px;color:#000;">New hardware order ${esc(fresh.number)}</h1>
      <p style="margin:0 0 16px;">${esc(fresh.contact_name)} &lt;${esc(fresh.email)}&gt; paid ${esc(gbp(fresh.total_minor))} on Dojo (${esc(fresh.dojo_mode)}).${fresh.trial_period ? `<br>Software trial: ${trial ? esc(trial.plan_name) + ' started' : 'not started (already had one, or an error: see the log)'}` : ''}${fresh.notes ? `<br>Notes: ${esc(fresh.notes)}` : ''}</p>${orderTable(fresh)}`),
  }).catch(() => {});
}

/** Read the order's payment from Dojo; 'paid', 'waiting', 'unpaid' or 'missing'. */
async function orderState(publicId) {
  await ensureTables();
  let o = await orderByPublic(publicId);
  if (!o) return { order: null, state: 'missing' };
  if (o.status === 'paid') return { order: o, state: 'paid' };
  if (o.status === 'cancelled') return { order: o, state: 'cancelled' };
  const pi = await dojo.getPaymentIntent(o.payment_intent_id);
  if (dojo.isPaid(pi)) { await markOrderPaid(o, pi); o = await orderByPublic(publicId); return { order: o, state: 'paid' }; }
  const s = String(pi.status || '').toLowerCase();
  return { order: o, state: s === 'authorized' ? 'waiting' : 'unpaid' };
}

/** Back to the same checkout with a fresh session (Dojo's checklist after a failed try). */
async function retryOrder(publicId) {
  const o = await orderByPublic(publicId);
  if (!o || o.status !== 'pending') return null;
  try {
    await dojo.refreshClientSecret(o.payment_intent_id);
    return dojo.checkoutUrl(o.payment_intent_id);
  } catch {
    const pi = await dojo.createPaymentIntent({ amountMinor: o.total_minor, reference: `${o.number} ${o.business || o.contact_name}`.slice(0, 80), description: `Vesopa hardware order ${o.number}`, redirectUrl: `${siteUrl()}/hardware/order/${o.public_id}` });
    await pool.query('UPDATE web_hw_orders SET payment_intent_id = ? WHERE id = ?', [pi.id, o.id]);
    return dojo.checkoutUrl(pi.id);
  }
}

async function cancelOrder(publicId) {
  await pool.query("UPDATE web_hw_orders SET status = 'cancelled' WHERE public_id = ? AND status = 'pending'", [String(publicId || '')]);
}

/** A Dojo notification for a hardware order (forwarded by the back office). */
async function refreshPayment(paymentIntentId) {
  await ensureTables();
  const o = await one("SELECT public_id FROM web_hw_orders WHERE payment_intent_id = ? AND status = 'pending'", [paymentIntentId]);
  if (o) await orderState(o.public_id);
  return Boolean(o);
}

/** Every 5 minutes: pick up paid orders whose customer never came back; drop week-old unpaid ones. */
async function sweep() {
  await ensureTables();
  const [rows] = await pool.query("SELECT public_id FROM web_hw_orders WHERE status = 'pending' AND payment_intent_id IS NOT NULL AND created_at > UTC_TIMESTAMP() - INTERVAL 2 DAY LIMIT 50");
  for (const r of rows) await orderState(r.public_id).catch(() => {});
  await pool.query("UPDATE web_hw_orders SET status = 'cancelled' WHERE status = 'pending' AND created_at < UTC_TIMESTAMP() - INTERVAL 7 DAY");
}

let timer = null;
function start() {
  if (timer) return;
  ensureTables().catch((e) => console.error('[shop] tables:', e.message));
  const run = () => sweep().catch((e) => console.error('[shop] sweep:', e.message));
  timer = setInterval(run, 5 * 60 * 1000);
  timer.unref();
}

module.exports = {
  start, ensureTables, signIn, signOut, accountEmail, sendSignInLink, redeem, overview,
  createOrder, orderState, retryOrder, cancelOrder, refreshPayment, backofficeUrl, gbp,
};
