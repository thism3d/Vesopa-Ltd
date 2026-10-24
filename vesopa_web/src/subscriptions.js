'use strict';

/**
 * Vesopa EPOS subscriptions, billed through Dojo (2026-10-24).
 *
 * LIFECYCLE
 *   pending_card  signed up on /trial, sent to Dojo to save the card
 *   trial         card authorised (setup intent); 14 days free
 *   active        paid for the current term
 *   past_due      a charge failed or a renewal went unpaid; retried 3 times
 *                 over 7 days (day 2, 4 and 7), an email each time
 *   suspended     still unpaid after the last retry; admin.vesopa.com pauses
 *                 the venue's tills with a grace period (licences.act)
 *   cancelled     cancelled by the customer or an admin (runs to period end
 *                 when cancel_at_period_end)
 *   ended         never finished adding a card, or ran out after cancelling
 *
 * MONEY: pence, ex VAT on the subscription, VAT added per invoice. The first
 * term is the plan's introductory price plus the setup fee (waived on 12- and
 * 24-month plans); later terms are the listed price. Add-ons are £15/month each.
 *
 * DOJO: the first charge uses the setup intent Dojo authorised at sign-up, so
 * it is taken with nobody present. Renewals are a Dojo pay link emailed a week
 * before, because Dojo's setup intents are single use; when Dojo enables
 * recurring card-on-file for the Vesopa account this is the one place to
 * change (chargeInvoice).
 */
const crypto = require('crypto');
const { pool } = require('./db');
const dojo = require('./dojo-billing');
const { planFor, resolvePeriod } = require('./plans-store');
const { sendMail } = require('./mailer');
const mail = require('./emails/subscription');

const TRIAL_DAYS = 14;
const VERIFY_MINOR = 100; // £1 card check at sign-up, refunded at once
const SETUP_FEE_MINOR = 14900;
const RETRY_DAYS = [2, 2, 3]; // after the first failure: day 2, day 4, day 7
const ADDONS = {
  display: { name: 'Extra customer display', monthly_minor: 1500 },
  kitchen: { name: 'Vesopa Kitchen screen', monthly_minor: 1500 },
  till: { name: 'Extra till', monthly_minor: 1500 },
};

const DAY = 864e5;
const sql = (d) => (d ? new Date(d).toISOString().slice(0, 19).replace('T', ' ') : null);
const fromSql = (v) => (v ? new Date(typeof v === 'string' ? v.replace(' ', 'T') + 'Z' : v) : null);
const addMonths = (d, n) => { const x = new Date(d); const day = x.getUTCDate(); x.setUTCDate(1); x.setUTCMonth(x.getUTCMonth() + n); const last = new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0)).getUTCDate(); x.setUTCDate(Math.min(day, last)); return x; };
const gbp = (m) => '£' + (Number(m || 0) / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const longDate = (d) => (d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' }) : '');

// ---- pricing -----------------------------------------------------------------

function cleanAddons(raw) {
  const out = [];
  for (const [k, def] of Object.entries(ADDONS)) {
    const qty = Math.max(0, Math.min(20, parseInt(raw && raw[k], 10) || 0));
    if (qty) out.push({ key: k, name: def.name, qty, monthly_minor: def.monthly_minor });
  }
  return out;
}

/** What a plan + add-ons costs: the first invoice and every renewal. */
function quote(period, addonsRaw) {
  const key = resolvePeriod(period);
  const found = planFor(key);
  if (!found) throw new Error('No plans are on sale right now.');
  // The config.js fallback rows carry neither slug nor period: fill them from the key.
  const plan = { slug: `plan-${key}`, period: key, ...found };
  const addons = cleanAddons(addonsRaw);
  const months = Number(plan.period_months || plan.period || key);
  const addonsMinor = addons.reduce((t, a) => t + a.qty * a.monthly_minor * months, 0);
  const firstTerm = Math.round(plan.discounted_price * 100);
  const renewal = Math.round(plan.total_price * 100) || firstTerm;
  const setup = months >= 12 ? 0 : SETUP_FEE_MINOR;
  const first = lines({ plan_name: plan.name, period_months: months }, firstTerm, addons, setup);
  const next = lines({ plan_name: plan.name, period_months: months }, renewal, addons, 0);
  return { plan: { ...plan, period_months: months }, addons, addonsMinor, firstTerm, renewal, setup, first, next };
}

function lines(sub, planMinor, addons, setupMinor) {
  const ls = [{ label: `${String(sub.plan_name).replace(/\s*plan$/i, '')} plan, ${sub.period_months} month${sub.period_months === 1 ? '' : 's'}`, minor: planMinor }];
  for (const a of addons) ls.push({ label: `${a.qty} × ${a.name} (${sub.period_months} mo)`, minor: a.qty * a.monthly_minor * sub.period_months });
  if (setupMinor) ls.push({ label: 'Setup and installation (once)', minor: setupMinor });
  const net = ls.reduce((t, l) => t + l.minor, 0);
  const vat = Math.round(net * 0.2);
  return { lines: ls, net, vat, total: net + vat };
}

// ---- storage helpers ------------------------------------------------------------

async function one(q, args) { const [rows] = await pool.query(q, args); return rows[0] || null; }
async function event(subId, kind, detail, actor = 'system') {
  await pool.query('INSERT INTO web_sub_events (subscription_id, kind, detail, actor) VALUES (?,?,?,?)',
    [subId, kind, detail ? String(detail).slice(0, 500) : null, String(actor || 'system').slice(0, 190)]);
}
const subById = (id) => one('SELECT * FROM web_subscriptions WHERE id = ?', [id]);
const subByPublic = (pid) => one('SELECT * FROM web_subscriptions WHERE public_id = ?', [pid]);

async function newInvoice(sub, kind, start, end, bill, dueAt) {
  const [r] = await pool.query(
    `INSERT INTO web_sub_invoices (subscription_id, number, kind, period_start, period_end, net_minor, vat_minor, total_minor, lines_json, status, due_at, next_attempt_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
    [sub.id, 'tmp-' + crypto.randomBytes(6).toString('hex'), kind, sql(start), sql(end), bill.net, bill.vat, bill.total, JSON.stringify(bill.lines), sql(dueAt), sql(dueAt)]);
  const number = `VS-${new Date().toISOString().slice(0, 7).replace('-', '')}-${String(r.insertId).padStart(5, '0')}`;
  await pool.query('UPDATE web_sub_invoices SET number = ? WHERE id = ?', [number, r.insertId]);
  return one('SELECT * FROM web_sub_invoices WHERE id = ?', [r.insertId]);
}

function siteUrl() { return (process.env.SITE_URL || 'https://vesopaepos.com').replace(/\/+$/, ''); }

async function notify(sub, kind, extra = {}) {
  try {
    const { subject, html } = mail.render(kind, { venue: sub.venue_name, name: sub.contact_name, plan: sub.plan_name, ...extra });
    await sendMail({ to: sub.email, subject, html });
    await event(sub.id, `mail.${kind}`, subject);
  } catch (e) {
    await event(sub.id, `mail.${kind}.failed`, e.message);
  }
}

// ---- sign-up -------------------------------------------------------------------

async function startTrial({ period, addons, venue, name, email, phone }) {
  venue = String(venue || '').trim().slice(0, 160);
  email = String(email || '').trim().toLowerCase().slice(0, 190);
  if (!venue) throw new Error('Please give the name of your venue.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new Error('Please give a valid email address.');
  const q = quote(period, addons);
  const publicId = crypto.randomBytes(12).toString('hex');
  const [r] = await pool.query(
    `INSERT INTO web_subscriptions (public_id, venue_name, contact_name, email, phone, plan_slug, plan_name, period_months,
       first_term_minor, renewal_minor, addons_json, addons_minor, setup_fee_minor, status, dojo_mode)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, 'pending_card', ?)`,
    [publicId, venue, String(name || '').trim().slice(0, 120) || null, email, String(phone || '').trim().slice(0, 40) || null,
      q.plan.slug, q.plan.name, q.plan.period_months, q.firstTerm, q.renewal, JSON.stringify(q.addons), q.addonsMinor, q.setup, dojo.mode()]);
  const sub = await subById(r.insertId);
  // The owner (2026-10-24): "£1 charge and return to start the trial". A £1
  // Dojo payment proves the card (or Apple Pay / Google Pay) is real; it is
  // refunded the moment it lands and the trial starts.
  const pi = await dojo.createPaymentIntent({
    amountMinor: VERIFY_MINOR,
    reference: `Card check ${venue}`.slice(0, 80),
    description: `Vesopa EPOS trial: £1 card check, refunded straight away`,
    redirectUrl: `${siteUrl()}/trial/done?s=${publicId}`,
  });
  await pool.query('UPDATE web_subscriptions SET verify_intent_id = ? WHERE id = ?', [pi.id, sub.id]);
  await event(sub.id, 'signup', `${q.plan.name}; first charge ${gbp(q.first.total)} after the trial; Dojo ${dojo.mode()}`, 'customer');
  return { publicId, url: dojo.checkoutUrl(pi.id) };
}

/** After Dojo's checkout: was the £1 paid? Refund it and start the trial, once. */
async function confirmCard(publicId) {
  const sub = await subByPublic(publicId);
  if (!sub) return null;
  if (sub.status !== 'pending_card' || !sub.verify_intent_id) return sub;
  const pi = await dojo.getPaymentIntent(sub.verify_intent_id);
  if (!dojo.isPaid(pi)) return sub;
  const trialEnd = new Date(Date.now() + TRIAL_DAYS * DAY);
  const label = dojo.cardLabel(pi);
  const [u] = await pool.query("UPDATE web_subscriptions SET status = 'trial', trial_ends_at = ?, card_label = ? WHERE id = ? AND status = 'pending_card'",
    [sql(trialEnd), label, sub.id]);
  if (!u.affectedRows) return subById(sub.id); // the other tab got there first
  try {
    await dojo.refund(sub.verify_intent_id, VERIFY_MINOR, 'Vesopa EPOS trial card check');
    await event(sub.id, 'verify.refunded', '£1 card check refunded');
  } catch (e) {
    // The trial still starts; the admin page shows this so the £1 goes back by hand.
    await event(sub.id, 'verify.refund_failed', e.message);
  }
  const addons = JSON.parse(sub.addons_json || '[]');
  const bill = lines(sub, sub.first_term_minor, addons, sub.setup_fee_minor);
  const inv = await newInvoice(sub, 'first', trialEnd, addMonths(trialEnd, sub.period_months), bill, trialEnd);
  await event(sub.id, 'trial.started', `card ${label || 'saved'}; first charge ${gbp(bill.total)} on ${longDate(trialEnd)}`, 'customer');
  const fresh = await subById(sub.id);
  await notify(fresh, 'trial_started', { amount: gbp(bill.total), date: longDate(trialEnd), invoice: inv.number });
  return fresh;
}

// ---- charging -------------------------------------------------------------------

async function markPaid(inv, pi) {
  const sub = await subById(inv.subscription_id);
  const [u] = await pool.query("UPDATE web_sub_invoices SET status = 'paid', paid_at = UTC_TIMESTAMP(), next_attempt_at = NULL, last_error = NULL, payment_intent_id = COALESCE(?, payment_intent_id) WHERE id = ? AND status <> 'paid'",
    [pi ? pi.id : null, inv.id]);
  if (!u.affectedRows) return;
  const wasDown = ['past_due', 'suspended'].includes(sub.status);
  await pool.query("UPDATE web_subscriptions SET status = 'active', period_start = ?, period_end = ?, suspended_at = NULL, card_label = COALESCE(?, card_label) WHERE id = ?",
    [inv.period_start, inv.period_end, pi ? dojo.cardLabel(pi) : null, sub.id]);
  await event(sub.id, 'invoice.paid', `${inv.number} ${gbp(inv.total_minor)}`);
  const fresh = await subById(sub.id);
  await notify(fresh, wasDown ? 'restored' : 'paid', { amount: gbp(inv.total_minor), invoice: inv.number, date: longDate(fromSql(inv.period_end)) });
}

async function payLink(inv, sub) {
  const pi = await dojo.createPaymentIntent({
    amountMinor: inv.total_minor,
    reference: `${inv.number} ${sub.venue_name}`.slice(0, 80),
    description: `Vesopa EPOS ${sub.plan_name}`,
    redirectUrl: `${siteUrl()}/subscribe/return?i=${encodeURIComponent(inv.number)}`,
  });
  const url = dojo.checkoutUrl(pi.id);
  await pool.query('UPDATE web_sub_invoices SET payment_intent_id = ?, pay_url = ? WHERE id = ?', [pi.id, url, inv.id]);
  return url;
}

async function failed(inv, sub, reason) {
  const attempts = inv.attempts + 1;
  const retryIndex = attempts - 1; // 0 = first failure
  const final = retryIndex >= RETRY_DAYS.length;
  const next = final ? null : new Date(Date.now() + RETRY_DAYS[retryIndex] * DAY);
  await pool.query("UPDATE web_sub_invoices SET status = 'failed', attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?",
    [attempts, sql(next), String(reason || 'not paid').slice(0, 255), inv.id]);
  let url = inv.pay_url;
  try { if (!url) url = await payLink(inv, sub); } catch (e) { await event(sub.id, 'paylink.failed', e.message); }
  if (final) {
    await pool.query("UPDATE web_subscriptions SET status = 'suspended', suspended_at = UTC_TIMESTAMP() WHERE id = ?", [sub.id]);
    await event(sub.id, 'suspended', `${inv.number} unpaid after ${attempts} tries`);
    await notify(await subById(sub.id), 'suspended', { amount: gbp(inv.total_minor), invoice: inv.number, url });
  } else {
    await pool.query("UPDATE web_subscriptions SET status = 'past_due' WHERE id = ? AND status IN ('trial','active','past_due')", [sub.id]);
    await event(sub.id, 'invoice.failed', `${inv.number} try ${attempts}: ${reason || 'not paid'}`);
    await notify(await subById(sub.id), 'payment_failed', { amount: gbp(inv.total_minor), invoice: inv.number, url, reason, next: longDate(next), final: false });
  }
}

/** Try to collect one invoice now. */
async function chargeInvoice(inv) {
  const sub = await subById(inv.subscription_id);
  if (!sub || ['cancelled', 'ended'].includes(sub.status)) {
    await pool.query("UPDATE web_sub_invoices SET status = 'void', next_attempt_at = NULL WHERE id = ?", [inv.id]);
    return;
  }
  try {
    // A pay link already out: has it been paid?
    if (inv.payment_intent_id) {
      const pi = await dojo.getPaymentIntent(inv.payment_intent_id);
      if (dojo.isPaid(pi)) return markPaid(inv, pi);
      if (inv.attempts === 0 && new Date() < fromSql(inv.due_at)) return; // not due yet
      return failed(inv, sub, 'not paid yet');
    }
    // The first charge after the trial: the card Dojo saved at sign-up.
    if (inv.kind === 'first' && sub.setup_intent_id && inv.attempts === 0) {
      const pi = await dojo.createPaymentIntent({
        amountMinor: inv.total_minor, reference: `${inv.number} ${sub.venue_name}`.slice(0, 80),
        description: `Vesopa EPOS ${sub.plan_name}`, setupIntentId: sub.setup_intent_id,
      });
      await pool.query('UPDATE web_sub_invoices SET payment_intent_id = ? WHERE id = ?', [pi.id, inv.id]);
      let charged = pi;
      try { charged = await dojo.chargePaymentIntent(pi.id); } catch (e) { return failed({ ...inv, payment_intent_id: pi.id }, sub, e.message.replace(/^Dojo: /, '')); }
      const now = await dojo.getPaymentIntent(pi.id).catch(() => charged);
      if (dojo.isPaid(now) || dojo.isPaid(charged)) return markPaid(inv, now);
      return failed({ ...inv, payment_intent_id: pi.id }, sub, 'card declined');
    }
    // No pay link out yet: send one, and look again tomorrow before calling it unpaid.
    const url = await payLink(inv, sub);
    await notify(sub, inv.kind === 'first' ? 'trial_ending' : 'renewal_due', { amount: gbp(inv.total_minor), invoice: inv.number, url, date: longDate(fromSql(inv.due_at)) });
    await pool.query('UPDATE web_sub_invoices SET next_attempt_at = ? WHERE id = ?', [sql(new Date(Date.now() + DAY)), inv.id]);
  } catch (e) {
    await event(sub.id, 'charge.error', e.message);
    await pool.query('UPDATE web_sub_invoices SET last_error = ?, next_attempt_at = ? WHERE id = ?', [e.message.slice(0, 255), sql(new Date(Date.now() + 3600e3)), inv.id]);
  }
}

/** A Dojo notification or a customer back from checkout: re-read the payment. */
async function refreshPayment(paymentIntentId) {
  const inv = await one('SELECT * FROM web_sub_invoices WHERE payment_intent_id = ?', [paymentIntentId]);
  if (!inv || inv.status === 'paid') return inv;
  const pi = await dojo.getPaymentIntent(paymentIntentId);
  if (dojo.isPaid(pi)) await markPaid(inv, pi);
  return one('SELECT * FROM web_sub_invoices WHERE id = ?', [inv.id]);
}

async function refreshByNumber(number) {
  const inv = await one('SELECT * FROM web_sub_invoices WHERE number = ?', [number]);
  if (inv && inv.payment_intent_id) return refreshPayment(inv.payment_intent_id);
  return inv;
}

// ---- the sweep (every 15 minutes) ---------------------------------------------------

async function sweep() {
  if (!dojo.configured()) return;
  // 1. trial ending in 3 days: one reminder
  const [ending] = await pool.query(`SELECT s.* FROM web_subscriptions s WHERE s.status = 'trial' AND s.trial_ends_at <= UTC_TIMESTAMP() + INTERVAL 3 DAY
     AND NOT EXISTS (SELECT 1 FROM web_sub_events e WHERE e.subscription_id = s.id AND e.kind = 'mail.trial_ending')`);
  for (const s of ending) {
    const inv = await one("SELECT * FROM web_sub_invoices WHERE subscription_id = ? AND kind = 'first' ORDER BY id DESC LIMIT 1", [s.id]);
    let url = null;
    if (inv && inv.status === 'open' && !inv.payment_intent_id) {
      try { url = await payLink(inv, s); } catch (e) { await event(s.id, 'paylink.failed', e.message); }
    }
    await notify(s, 'trial_ending', { amount: inv ? gbp(inv.total_minor) : '', date: longDate(fromSql(s.trial_ends_at)), invoice: inv && inv.number, url });
  }
  // 2. renewals: a week before the end of an active term, an invoice and a pay link
  const [renew] = await pool.query(`SELECT s.* FROM web_subscriptions s WHERE s.status = 'active' AND s.cancel_at_period_end = 0
     AND s.period_end <= UTC_TIMESTAMP() + INTERVAL 7 DAY
     AND NOT EXISTS (SELECT 1 FROM web_sub_invoices i WHERE i.subscription_id = s.id AND i.period_start >= s.period_end AND i.status IN ('open','failed','paid'))`);
  for (const s of renew) {
    const start = fromSql(s.period_end);
    const bill = lines(s, s.renewal_minor, JSON.parse(s.addons_json || '[]'), 0);
    const inv = await newInvoice(s, 'renewal', start, addMonths(start, s.period_months), bill, start);
    try {
      const url = await payLink(inv, s);
      await notify(s, 'renewal_due', { amount: gbp(bill.total), date: longDate(start), invoice: inv.number, url });
    } catch (e) { await event(s.id, 'paylink.failed', e.message); }
  }
  // 3. collect what is due
  const [due] = await pool.query("SELECT * FROM web_sub_invoices WHERE status IN ('open','failed') AND next_attempt_at IS NOT NULL AND next_attempt_at <= UTC_TIMESTAMP() ORDER BY next_attempt_at LIMIT 50");
  for (const inv of due) await chargeInvoice(inv);
  // 4. cancelled at period end, and sign-ups that never added a card
  await pool.query("UPDATE web_subscriptions SET status = 'cancelled' WHERE cancel_at_period_end = 1 AND status IN ('active','trial') AND COALESCE(period_end, trial_ends_at) <= UTC_TIMESTAMP()");
  await pool.query("UPDATE web_subscriptions SET status = 'ended' WHERE status = 'pending_card' AND created_at < UTC_TIMESTAMP() - INTERVAL 7 DAY");
}

let timer = null;
function start() {
  if (timer) return;
  const run = () => sweep().catch((e) => console.error('[subscriptions] sweep:', e.message));
  setTimeout(run, 20000);
  timer = setInterval(run, 15 * 60 * 1000);
  timer.unref();
}

// ---- admin (admin.vesopa.com through the service API) ---------------------------------

async function list({ status } = {}) {
  const where = status ? 'WHERE s.status = ?' : '';
  const [rows] = await pool.query(`SELECT s.*,
      (SELECT COUNT(*) FROM web_sub_invoices i WHERE i.subscription_id = s.id AND i.status = 'failed') AS failed_invoices,
      (SELECT MIN(COALESCE(i.next_attempt_at, i.due_at)) FROM web_sub_invoices i WHERE i.subscription_id = s.id AND i.status IN ('open','failed')) AS next_charge_at,
      (SELECT i.total_minor FROM web_sub_invoices i WHERE i.subscription_id = s.id AND i.status IN ('open','failed') ORDER BY i.id DESC LIMIT 1) AS next_charge_minor
    FROM web_subscriptions s ${where} ORDER BY s.updated_at DESC LIMIT 500`, status ? [status] : []);
  const [[kpi]] = await pool.query(`SELECT
      SUM(status = 'active') AS active, SUM(status = 'trial') AS trial, SUM(status = 'past_due') AS past_due,
      SUM(status = 'suspended') AS suspended, SUM(status IN ('cancelled','ended')) AS gone,
      COALESCE(SUM(CASE WHEN status IN ('active','past_due') THEN ROUND((renewal_minor + addons_minor) / period_months) END), 0) AS mrr_minor
    FROM web_subscriptions`);
  return { rows, kpi, dojo: { configured: dojo.configured(), mode: dojo.mode() } };
}

async function detail(id) {
  const sub = await subById(id);
  if (!sub) return null;
  const [invoices] = await pool.query('SELECT * FROM web_sub_invoices WHERE subscription_id = ? ORDER BY id DESC', [id]);
  const [events] = await pool.query('SELECT * FROM web_sub_events WHERE subscription_id = ? ORDER BY id DESC LIMIT 100', [id]);
  return { sub, invoices, events };
}

async function act(id, action, body, actor) {
  const sub = await subById(id);
  if (!sub) throw Object.assign(new Error('No such subscription.'), { status: 404 });
  const openInv = await one("SELECT * FROM web_sub_invoices WHERE subscription_id = ? AND status IN ('open','failed') ORDER BY id DESC LIMIT 1", [id]);
  switch (action) {
    case 'retry': {
      if (!openInv) throw new Error('Nothing is owed on this subscription.');
      await pool.query('UPDATE web_sub_invoices SET next_attempt_at = UTC_TIMESTAMP() WHERE id = ?', [openInv.id]);
      await event(id, 'admin.retry', openInv.number, actor);
      await chargeInvoice(await one('SELECT * FROM web_sub_invoices WHERE id = ?', [openInv.id]));
      return 'Payment tried again.';
    }
    case 'card_link': {
      if (!openInv) throw new Error('Nothing is owed, so there is no payment link to send.');
      const url = await payLink(openInv, sub);
      await notify(sub, 'card_link', { amount: gbp(openInv.total_minor), invoice: openInv.number, url });
      await event(id, 'admin.card_link', url, actor);
      return 'Payment link emailed to the customer.';
    }
    case 'extend_trial': {
      const days = Math.max(1, Math.min(60, parseInt(body.days, 10) || 7));
      if (sub.status !== 'trial') throw new Error('Only a trial can be extended.');
      await pool.query('UPDATE web_subscriptions SET trial_ends_at = trial_ends_at + INTERVAL ? DAY WHERE id = ?', [days, id]);
      await pool.query("UPDATE web_sub_invoices SET due_at = due_at + INTERVAL ? DAY, next_attempt_at = next_attempt_at + INTERVAL ? DAY, period_start = period_start + INTERVAL ? DAY, period_end = period_end + INTERVAL ? DAY WHERE subscription_id = ? AND kind = 'first' AND status = 'open'", [days, days, days, days, id]);
      await event(id, 'admin.extend_trial', `${days} days`, actor);
      return `Trial extended by ${days} days.`;
    }
    case 'change_plan': {
      const q = quote(body.period, body.addons || JSON.parse(sub.addons_json || '[]').reduce((o, a) => ({ ...o, [a.key]: a.qty }), {}));
      await pool.query('UPDATE web_subscriptions SET plan_slug = ?, plan_name = ?, period_months = ?, renewal_minor = ?, addons_json = ?, addons_minor = ? WHERE id = ?',
        [q.plan.slug, q.plan.name, q.plan.period_months, q.renewal, JSON.stringify(q.addons), q.addonsMinor, id]);
      await event(id, 'admin.change_plan', `${q.plan.name}, from the next renewal`, actor);
      return `Plan changed to ${q.plan.name}. It applies from the next renewal.`;
    }
    case 'refund': {
      const paid = await one("SELECT * FROM web_sub_invoices WHERE subscription_id = ? AND status = 'paid' AND payment_intent_id IS NOT NULL ORDER BY paid_at DESC LIMIT 1", [id]);
      if (!paid) throw new Error('No paid invoice to refund.');
      const amount = body.amount ? Math.round(Number(String(body.amount).replace(/[£,\s]/g, '')) * 100) : paid.total_minor - paid.refunded_minor;
      if (!(amount > 0) || amount > paid.total_minor - paid.refunded_minor) throw new Error('That refund is more than was paid.');
      await dojo.refund(paid.payment_intent_id, amount, `Vesopa EPOS ${paid.number}`);
      await pool.query("UPDATE web_sub_invoices SET refunded_minor = refunded_minor + ?, status = IF(refunded_minor + ? >= total_minor, 'refunded', status) WHERE id = ?", [amount, amount, paid.id]);
      await event(id, 'admin.refund', `${gbp(amount)} on ${paid.number}`, actor);
      await notify(sub, 'refunded', { amount: gbp(amount), invoice: paid.number });
      return `Refunded ${gbp(amount)}.`;
    }
    case 'cancel': {
      const now = body.when === 'now';
      if (now) {
        await pool.query("UPDATE web_subscriptions SET status = 'cancelled', cancelled_at = UTC_TIMESTAMP() WHERE id = ?", [id]);
        await pool.query("UPDATE web_sub_invoices SET status = 'void', next_attempt_at = NULL WHERE subscription_id = ? AND status IN ('open','failed')", [id]);
      } else {
        await pool.query('UPDATE web_subscriptions SET cancel_at_period_end = 1, cancelled_at = UTC_TIMESTAMP() WHERE id = ?', [id]);
        await pool.query("UPDATE web_sub_invoices SET status = 'void', next_attempt_at = NULL WHERE subscription_id = ? AND status = 'open' AND kind = 'renewal'", [id]);
      }
      await event(id, 'admin.cancel', now ? 'now' : 'at period end', actor);
      await notify(sub, 'cancelled', { date: now ? '' : longDate(fromSql(sub.period_end || sub.trial_ends_at)) });
      return now ? 'Cancelled now.' : 'Cancelled at the end of the paid period.';
    }
    case 'reactivate': {
      await pool.query("UPDATE web_subscriptions SET cancel_at_period_end = 0, status = IF(status = 'cancelled' AND period_end > UTC_TIMESTAMP(), 'active', status) WHERE id = ?", [id]);
      await event(id, 'admin.reactivate', null, actor);
      return 'Subscription will carry on renewing.';
    }
    case 'link_venue': {
      const venueId = parseInt(body.venue_id, 10) || null;
      await pool.query('UPDATE web_subscriptions SET venue_id = ? WHERE id = ?', [venueId, id]);
      await event(id, 'admin.link_venue', venueId ? `venue ${venueId}` : 'unlinked', actor);
      return venueId ? `Linked to back office venue ${venueId}.` : 'Venue unlinked.';
    }
    case 'note': {
      await pool.query('UPDATE web_subscriptions SET notes = ? WHERE id = ?', [String(body.notes || '').slice(0, 4000), id]);
      await event(id, 'admin.note', null, actor);
      return 'Notes saved.';
    }
    default: throw new Error('Unknown action.');
  }
}

module.exports = {
  ADDONS, TRIAL_DAYS, SETUP_FEE_MINOR, quote, startTrial, confirmCard, refreshPayment, refreshByNumber,
  sweep, start, list, detail, act, gbp, longDate, _lines: lines, _addMonths: addMonths,
};
