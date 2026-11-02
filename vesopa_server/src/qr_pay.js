/**
 * QR Pay: the customer pays their own bill on their own phone (owner,
 * 2026-11-02). Vesopa Go shows a QR code; the customer scans it, lands on a
 * page at the venue's menu address (menu.vesopa.com, or the venue's own --
 * menu.pontardawerfc.com), sees what they are paying and pays on Dojo's
 * hosted checkout with a card, Apple Pay or Google Pay. Go hears the answer
 * over the venue's websocket the moment the server does.
 *
 *   POST /api/tap/qr                  a QR payment for one tender (Go)
 *   GET  /api/tap/qr/:id              how it is going, asked of Dojo (Go)
 *   POST /api/tap/qr/:id/cancel       called off by the clerk (Go)
 *   POST /api/tap/qr/:id/email        the link sent to the customer (Go)
 *   GET  /pay/:code                   the customer's page (public)
 *   GET  /pay/:code/go                on to Dojo's checkout (public)
 *   GET  /api/qr-pay/settings         the back office's QR Pay card
 *   PUT  /api/qr-pay/settings
 *
 * The money goes through the venue's ONLINE Dojo key -- the one its menu,
 * tickets and memberships use (memberships.paymentKeyFor) -- never the card
 * machine's. A sandbox key is test money, and the payment says so.
 *
 * NOTHING IS PAID UNTIL DOJO SAYS CAPTURED. The customer's return to the page
 * proves only that a browser arrived; the answer is always read from the
 * intent: when Go asks, when the page asks, from Dojo's webhook, and by a
 * sweep for the payment nobody asks about.
 */
'use strict';

const crypto = require('crypto');
const express = require('express');

const { requireAuth, requireTerminal } = require('./auth');
const { attachAccess, requirePermission } = require('./permissions');
const dojo = require('./dojo_client');

const DEFAULTS = { enabled: 1, email_link: 1, on_bill: 0, expires_minutes: 30 };
const ID = /^[A-Za-z0-9_-]{8,64}$/;
const CODE = /^[a-f0-9]{24}$/;

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pounds = (minor) => '£' + (Number(minor || 0) / 100).toFixed(2);

class QrError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function send(res, e, next) {
  if (e instanceof QrError) return res.status(e.status).json({ error: e.message });
  if (e && e.name === 'DojoError') return res.status(502).json({ error: 'Dojo said: ' + e.message });
  return next(e);
}

/** A payment as Go reads it. */
function view(row, base) {
  return {
    id: row.id,
    bill_ref: row.bill_ref || null,
    status: row.status,
    amount_minor: Number(row.amount_minor),
    customer_name: row.customer_name || null,
    url: base + '/pay/' + row.code,
    environment: row.environment,
    paid_at: row.paid_at || null,
    intent_id: row.intent_id,
  };
}

function qrPayRoutes({ pool, broadcast, secret, fetchImpl }) {
  const router = express.Router();
  const terminal = requireTerminal(secret);
  const auth = requireAuth(secret);
  const guard = (key) => [auth, attachAccess({ pool }), requirePermission(key)];
  const opts = { fetchImpl };

  let ready = null;
  /** The two tables, made the first time they are needed. */
  function ensureTables() {
    if (!ready) {
      ready = (async () => {
        await pool.query(`CREATE TABLE IF NOT EXISTS epos_qr_payments (
          id VARCHAR(64) NOT NULL PRIMARY KEY,
          office VARCHAR(255) NOT NULL,
          code CHAR(24) NOT NULL,
          bill_ref VARCHAR(64) NULL,
          bill_name VARCHAR(120) NULL,
          customer_name VARCHAR(120) NULL,
          amount_minor INT NOT NULL,
          intent_id VARCHAR(80) NULL,
          environment VARCHAR(10) NOT NULL DEFAULT 'live',
          status VARCHAR(12) NOT NULL DEFAULT 'waiting',
          terminal VARCHAR(128) NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          paid_at DATETIME NULL,
          UNIQUE KEY uq_qr_code (code),
          KEY ix_qr_office (office, created_at),
          KEY ix_qr_intent (intent_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
        await pool.query(`CREATE TABLE IF NOT EXISTS epos_qr_pay_settings (
          office VARCHAR(255) NOT NULL PRIMARY KEY,
          enabled TINYINT(1) NOT NULL DEFAULT 1,
          email_link TINYINT(1) NOT NULL DEFAULT 1,
          on_bill TINYINT(1) NOT NULL DEFAULT 0,
          expires_minutes INT NOT NULL DEFAULT 30,
          updated_by VARCHAR(255) NULL,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
      })().catch((e) => {
        ready = null;
        throw e;
      });
    }
    return ready;
  }

  async function settingsFor(office) {
    await ensureTables();
    const [[row]] = await pool.query('SELECT * FROM epos_qr_pay_settings WHERE office = ?', [office]);
    const s = { ...DEFAULTS, ...(row || {}) };
    return {
      enabled: !!Number(s.enabled),
      email_link: !!Number(s.email_link),
      on_bill: !!Number(s.on_bill),
      expires_minutes: Math.min(240, Math.max(5, Number(s.expires_minutes) || 30)),
    };
  }

  /** The venue's online Dojo key, or null when it has none. */
  async function keyFor(office) {
    try {
      return await require('./memberships').paymentKeyFor(pool, office);
    } catch (e) {
      console.error('[qr-pay] no payment key:', e.message);
      return null;
    }
  }

  /**
   * Where the venue's customers pay: its own menu domain once that has
   * answered, else the menu host. Never the back office's address.
   */
  async function baseFor(office) {
    try {
      const [[v]] = await pool.query(
        `SELECT v.custom_domain, v.domain_verified FROM dinein_venue v
           JOIN offices o ON o.id = v.office_id WHERE o.contact_email = ?`, [office]);
      if (v && v.custom_domain && Number(v.domain_verified)) return 'https://' + String(v.custom_domain).trim().toLowerCase();
    } catch (e) {
      if (e.code !== 'ER_NO_SUCH_TABLE' && e.code !== 'ER_BAD_FIELD_ERROR') throw e;
    }
    return String(process.env.PUBLIC_BASE_URL || 'https://menu.vesopa.com').replace(/\/+$/, '');
  }

  async function venueName(office) {
    const [[o]] = await pool.query('SELECT name FROM offices WHERE contact_email = ?', [office]);
    return (o && o.name) || 'the venue';
  }

  async function rowById(office, id) {
    await ensureTables();
    const [[row]] = await pool.query('SELECT * FROM epos_qr_payments WHERE id = ? AND office = ?', [id, office]);
    return row || null;
  }

  function tell(row) {
    if (typeof broadcast === 'function') {
      broadcast({ type: 'qrpay.updated', id: row.id, status: row.status, amount_minor: Number(row.amount_minor) }, { office: row.office });
    }
  }

  /**
   * Read the intent and move the payment on. The conditional UPDATE is the
   * claim, so the webhook, the page and Go cannot each mark it twice.
   */
  async function settle(row) {
    if (!row || row.status !== 'waiting' || !row.intent_id) return row;
    const key = await keyFor(row.office);
    if (!key) return row;
    let intent;
    try {
      intent = await dojo.getIntent(key, row.intent_id, opts);
    } catch (e) {
      // Only "Dojo has no such payment" is an answer; anything else is asked again.
      if (!(e && e.status === 404)) throw e;
      intent = { status: 'failed' };
    }
    const state = String((intent && intent.status) || '').toLowerCase();
    let next = null;
    if (dojo.intentPaid(intent)) next = 'paid';
    else if (['canceled', 'cancelled', 'reversed', 'failed'].includes(state)) next = 'failed';
    if (!next) return row;
    const [r] = await pool.execute(
      `UPDATE epos_qr_payments SET status = ?, paid_at = IF(? = 'paid', NOW(), paid_at) WHERE id = ? AND status = 'waiting'`,
      [next, next, row.id]);
    const fresh = await rowById(row.office, row.id);
    if (r.affectedRows) tell(fresh);
    return fresh;
  }

  /** Every waiting payment older than its time is called off; the rest are asked. */
  async function sweep() {
    try {
      await ensureTables();
      const [rows] = await pool.query(
        `SELECT * FROM epos_qr_payments WHERE status = 'waiting' AND created_at > NOW() - INTERVAL 1 DAY ORDER BY created_at LIMIT 50`);
      for (const row of rows) {
        const s = await settle(row).catch(() => row);
        if (s.status !== 'waiting') continue;
        const { expires_minutes: minutes } = await settingsFor(row.office);
        const [[age]] = await pool.query('SELECT TIMESTAMPDIFF(MINUTE, created_at, NOW()) AS m FROM epos_qr_payments WHERE id = ?', [row.id]);
        if (Number(age.m) < minutes) continue;
        const key = await keyFor(row.office);
        if (key && row.intent_id) await dojo.cancelIntent(key, row.intent_id, opts).catch(() => false);
        const [r] = await pool.execute("UPDATE epos_qr_payments SET status = 'expired' WHERE id = ? AND status = 'waiting'", [row.id]);
        if (r.affectedRows) tell(await rowById(row.office, row.id));
      }
    } catch (e) {
      console.warn('[qr-pay] sweep:', e.message);
    }
  }
  if (!fetchImpl) setInterval(sweep, 20000).unref();

  // ---- Vesopa Go --------------------------------------------------------------

  /**
   * A QR payment for one tender: a Dojo checkout intent on the venue's online
   * key, the same key its menu takes cards with. The same id again (a phone
   * that lost its answer) is the same payment.
   */
  async function createPayment(office, b, by) {
    const id = String(b.id || '');
    if (!ID.test(id)) throw new QrError(400, 'A payment id is required.');
    const amount = Number(b.amount_minor);
    if (!Number.isInteger(amount) || amount < 30 || amount > 1_000_000) throw new QrError(400, 'QR Pay takes from £0.30 to £10,000.');
    const settings = await settingsFor(office);
    if (!settings.enabled && !b.test) throw new QrError(403, 'QR Pay is switched off for this venue in the back office.');
    const had = await rowById(office, id);
    if (had) return had;
    const key = await keyFor(office);
    if (!key) throw new QrError(409, 'This venue has no online card payments set up. Choose a Dojo key in the back office under Card Payments, Online checkout.');
    const base = await baseFor(office);
    const code = crypto.randomBytes(12).toString('hex');
    const venue = await venueName(office);
    const billName = String(b.bill_name || '').trim().slice(0, 120) || null;
    const customer = String(b.customer_name || '').trim().slice(0, 120) || null;
    const intent = await dojo.createCheckoutIntent(key, {
      amountMinor: amount,
      reference: `qr-${code.slice(0, 12)}`,
      description: `${venue.slice(0, 50)}${billName ? ' · ' + billName.slice(0, 24) : ''}`,
      redirectUrl: `${base}/pay/${code}`,
    }, opts);
    const environment = dojo.isSandboxKey(key) ? 'sandbox' : 'live';
    await pool.execute(
      `INSERT INTO epos_qr_payments (id, office, code, bill_ref, bill_name, customer_name, amount_minor, intent_id, environment, terminal)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, office, code, String(b.bill_ref || '').slice(0, 64) || null, billName, customer, amount, intent.id, environment, String(by || 'go').slice(0, 128)]);
    return rowById(office, id);
  }

  router.post('/api/tap/qr', terminal, express.json(), async (req, res, next) => {
    try {
      const row = await createPayment(req.office, { ...(req.body || {}), test: false },
        req.terminal && (req.terminal.jti || req.terminal.commissionedBy));
      res.json(view(row, await baseFor(req.office)));
    } catch (e) { send(res, e, next); }
  });

  router.get('/api/tap/qr/:id', terminal, async (req, res, next) => {
    try {
      const row = await rowById(req.office, String(req.params.id));
      if (!row) throw new QrError(404, 'That QR payment is not known.');
      res.json(view(await settle(row), await baseFor(req.office)));
    } catch (e) { send(res, e, next); }
  });

  router.post('/api/tap/qr/:id/cancel', terminal, async (req, res, next) => {
    try {
      let row = await rowById(req.office, String(req.params.id));
      if (!row) throw new QrError(404, 'That QR payment is not known.');
      row = await settle(row);
      if (row.status === 'waiting') {
        const key = await keyFor(req.office);
        if (key && row.intent_id) await dojo.cancelIntent(key, row.intent_id, opts).catch(() => false);
        // Read once more: a customer who paid as the clerk pressed Cancel has paid.
        row = await settle(row);
        if (row.status === 'waiting') {
          await pool.execute("UPDATE epos_qr_payments SET status = 'cancelled' WHERE id = ? AND status = 'waiting'", [row.id]);
          row = await rowById(req.office, row.id);
          tell(row);
        }
      }
      res.json(view(row, await baseFor(req.office)));
    } catch (e) { send(res, e, next); }
  });

  const emailSends = new Map(); // office -> [times]
  router.post('/api/tap/qr/:id/email', terminal, express.json(), async (req, res, next) => {
    try {
      const to = String((req.body && req.body.email) || '').trim().slice(0, 254);
      if (!/^[^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,}$/i.test(to)) throw new QrError(400, 'That email address does not look right.');
      const settings = await settingsFor(req.office);
      if (!settings.email_link) throw new QrError(403, 'Emailing pay links is switched off for this venue.');
      const row = await rowById(req.office, String(req.params.id));
      if (!row) throw new QrError(404, 'That QR payment is not known.');
      if (row.status !== 'waiting') throw new QrError(409, 'This payment is no longer waiting to be paid.');
      const recent = (emailSends.get(req.office) || []).filter((t) => Date.now() - t < 3600e3);
      if (recent.length >= 120) throw new QrError(429, 'Too many pay links from this venue in an hour.');
      const venue = await venueName(req.office);
      const url = `${await baseFor(req.office)}/pay/${row.code}`;
      const hello = row.customer_name ? `Hello ${row.customer_name.split(' ')[0]},` : 'Hello,';
      await require('./mailer').sendMail({
        to,
        subject: `Pay your bill at ${venue}: ${pounds(row.amount_minor)}`,
        text: `${hello}\n\nYour bill at ${venue} is ${pounds(row.amount_minor)}. Pay it here by card, Apple Pay or Google Pay:\n${url}\n\nThank you.`,
        html: `<p>${esc(hello)}</p><p>Your bill at <b>${esc(venue)}</b> is <b>${pounds(row.amount_minor)}</b>.</p>`
          + `<p><a href="${esc(url)}" style="display:inline-block;padding:12px 22px;background:#111;color:#fff;border-radius:10px;text-decoration:none;font-weight:700">Pay ${pounds(row.amount_minor)}</a></p>`
          + '<p>Card, Apple Pay or Google Pay. Thank you.</p>',
      });
      emailSends.set(req.office, [...recent, Date.now()]);
      res.json({ sent: true });
    } catch (e) { send(res, e, next); }
  });

  // ---- The customer's page ------------------------------------------------------

  async function rowByCode(code) {
    if (!CODE.test(code)) return null;
    await ensureTables();
    const [[row]] = await pool.query('SELECT * FROM epos_qr_payments WHERE code = ?', [code]);
    return row || null;
  }

  const BADGES = `<div class="badges">
    <span class="b visa">VISA</span><span class="b mc"><i></i><i></i></span><span class="b amex">AMEX</span>
    <span class="b apple">&#63743; Pay</span><span class="b gpay"><b>G</b> Pay</span></div>`;

  function page({ venue, title, body, refresh }) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">${refresh ? '<meta http-equiv="refresh" content="4">' : ''}
<title>${esc(title)} · ${esc(venue)}</title><meta name="robots" content="noindex">
<style>
:root{color-scheme:light dark;--bg:#f4f4f1;--card:#fff;--ink:#111;--muted:#666;--line:#e3e3de;--go:#111;--goInk:#fff}
@media(prefers-color-scheme:dark){:root{--bg:#0b0c0d;--card:#16181a;--ink:#f3f3f1;--muted:#9a9a96;--line:#2a2c2e;--go:#a5c715;--goInk:#10130a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
main{max-width:440px;margin:0 auto;padding:28px 16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:20px;padding:24px;text-align:center}
.venue{font-size:14px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:0 0 6px}
h1{font-size:22px;margin:0 0 4px}.amount{font-size:46px;font-weight:800;margin:14px 0 4px;font-variant-numeric:tabular-nums}
.muted{color:var(--muted);font-size:14px}.pay{display:block;margin:22px 0 14px;padding:16px;border-radius:14px;background:var(--go);color:var(--goInk);font-weight:800;font-size:18px;text-decoration:none}
.badges{display:flex;gap:6px;justify-content:center;flex-wrap:wrap;margin-top:6px}
.b{display:inline-flex;align-items:center;gap:3px;height:26px;padding:0 9px;border-radius:6px;border:1px solid var(--line);font-size:12px;font-weight:800;background:#fff;color:#111}
.visa{color:#1a1f71;font-style:italic}.amex{background:#2e77bc;color:#fff;border-color:#2e77bc}.apple{background:#000;color:#fff;border-color:#000}
.gpay b{color:#4285f4}.mc i{display:inline-block;width:13px;height:13px;border-radius:50%;background:#eb001b}.mc i+i{background:#f79e1b;margin-left:-6px;opacity:.9}
.tick{width:64px;height:64px;border-radius:50%;background:#2e9d4f;color:#fff;font-size:36px;line-height:64px;margin:4px auto 10px}
.cross{background:#c0392b}.test{display:inline-block;margin-top:10px;padding:3px 10px;border-radius:99px;background:#fff3cd;color:#7a5b00;font-size:12px;font-weight:700}
</style></head><body><main><div class="card"><p class="venue">${esc(venue)}</p>${body}</div>
<p class="muted" style="text-align:center;margin-top:16px">Payments by Dojo · Vesopa</p></main></body></html>`;
  }

  router.get('/pay/:code', async (req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store');
      let row = await rowByCode(String(req.params.code));
      if (!row) return res.status(404).type('html').send(page({ venue: 'Vesopa', title: 'Not found', body: '<h1>This pay link is not known</h1><p class="muted">Ask a member of staff for a new one.</p>' }));
      row = await settle(row).catch(() => row);
      const venue = await venueName(row.office);
      const test = row.environment === 'sandbox' ? '<div class="test">TEST PAYMENT · no real money</div>' : '';
      const who = row.customer_name ? `${esc(row.customer_name.split(' ')[0])}, your bill` : 'Your bill';
      if (row.status === 'paid') {
        return res.type('html').send(page({ venue, title: 'Paid', body: `<div class="tick">&#10003;</div><h1>Paid, thank you</h1><div class="amount">${pounds(row.amount_minor)}</div><p class="muted">You can close this page. Show it to staff if they ask.</p>${test}` }));
      }
      if (row.status !== 'waiting') {
        return res.type('html').send(page({ venue, title: 'Not paid', body: '<div class="tick cross">&#10005;</div><h1>This payment is closed</h1><p class="muted">Nothing was taken. Ask a member of staff for a new link.</p>' }));
      }
      const back = 'paymentIntentId' in req.query || 'status' in req.query;
      res.type('html').send(page({
        venue,
        title: 'Pay your bill',
        refresh: back,
        body: `<h1>${who}${row.bill_name ? ` · ${esc(row.bill_name)}` : ''}</h1>
          <div class="amount">${pounds(row.amount_minor)}</div>
          ${back ? '<p class="muted">Checking your payment&hellip;</p>' : ''}
          <a class="pay" href="/pay/${row.code}/go">Pay ${pounds(row.amount_minor)}</a>${BADGES}${test}`,
      }));
    } catch (e) { next(e); }
  });

  router.get('/pay/:code/go', async (req, res, next) => {
    try {
      const row = await rowByCode(String(req.params.code));
      if (!row || row.status !== 'waiting' || !row.intent_id) return res.redirect(303, `/pay/${encodeURIComponent(req.params.code)}`);
      // A fresh client secret, so the page works again after a declined card.
      const key = await keyFor(row.office);
      if (key) await dojo.refreshClientSecret(key, row.intent_id, opts);
      res.redirect(303, dojo.checkoutUrl(row.intent_id));
    } catch (e) { next(e); }
  });

  // ---- The back office ----------------------------------------------------------

  async function officeOf(req) {
    if (req.user && req.user.officeId) {
      const [[o]] = await pool.query('SELECT contact_email FROM offices WHERE id = ?', [req.user.officeId]);
      if (o) return o.contact_email;
    }
    return req.user && (req.user.officeEmail || req.user.email);
  }

  router.get('/api/qr-pay/settings', guard('commerce.tender'), async (req, res, next) => {
    try {
      const office = await officeOf(req);
      const key = await keyFor(office);
      res.json({
        ...(await settingsFor(office)),
        environment: key ? (dojo.isSandboxKey(key) ? 'sandbox' : 'live') : null,
        pay_address: await baseFor(office),
      });
    } catch (e) { send(res, e, next); }
  });

  router.put('/api/qr-pay/settings', guard('commerce.edit'), express.json(), async (req, res, next) => {
    try {
      const office = await officeOf(req);
      const old = await settingsFor(office);
      const b = req.body || {};
      const flag = (k) => (b[k] === undefined ? (old[k] ? 1 : 0) : (b[k] === true || Number(b[k]) === 1 ? 1 : 0));
      const minutes = b.expires_minutes === undefined ? old.expires_minutes : Math.min(240, Math.max(5, Math.round(Number(b.expires_minutes) || 30)));
      await pool.query(
        `INSERT INTO epos_qr_pay_settings (office, enabled, email_link, on_bill, expires_minutes, updated_by)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), email_link = VALUES(email_link), on_bill = VALUES(on_bill),
           expires_minutes = VALUES(expires_minutes), updated_by = VALUES(updated_by)`,
        [office, flag('enabled'), flag('email_link'), flag('on_bill'), minutes, String((req.user && req.user.email) || '').slice(0, 255)]);
      if (typeof broadcast === 'function') broadcast({ type: 'till-settings' }, { office });
      res.json(await settingsFor(office));
    } catch (e) { send(res, e, next); }
  });

  // A test from the back office (QR Pay card, Test QR Pay): a real payment
  // on the venue's own online key -- test money on a sandbox key, real money
  // on a live one -- with its code drawn on the page and its state read back
  // as Go reads it.
  router.post('/api/qr-pay/test', guard('commerce.edit'), express.json(), async (req, res, next) => {
    try {
      const office = await officeOf(req);
      const amount = Math.round(Number((req.body && req.body.amount_minor) || 100));
      const row = await createPayment(office, {
        id: 'test-' + crypto.randomBytes(8).toString('hex'),
        amount_minor: amount,
        bill_name: 'Back office test',
        test: true,
      }, 'back office ' + String((req.user && req.user.email) || '').slice(0, 100));
      const v = view(row, await baseFor(office));
      res.json({ ...v, qr_svg: require('./qr').svg(v.url, { size: 220 }) });
    } catch (e) { send(res, e, next); }
  });

  router.get('/api/qr-pay/test/:id', guard('commerce.tender'), async (req, res, next) => {
    try {
      const office = await officeOf(req);
      const row = await rowById(office, String(req.params.id));
      if (!row) throw new QrError(404, 'That test is not known.');
      res.json(view(await settle(row), await baseFor(office)));
    } catch (e) { send(res, e, next); }
  });

  router.post('/api/qr-pay/test/:id/cancel', guard('commerce.edit'), async (req, res, next) => {
    try {
      const office = await officeOf(req);
      let row = await rowById(office, String(req.params.id));
      if (!row) throw new QrError(404, 'That test is not known.');
      row = await settle(row);
      if (row.status === 'waiting') {
        const key = await keyFor(office);
        if (key && row.intent_id) await dojo.cancelIntent(key, row.intent_id, opts).catch(() => false);
        await pool.execute("UPDATE epos_qr_payments SET status = 'cancelled' WHERE id = ? AND status = 'waiting'", [row.id]);
        row = await rowById(office, row.id);
      }
      res.json(view(row, await baseFor(office)));
    } catch (e) { send(res, e, next); }
  });

  /** Dojo's webhook: a QR payment settles the moment Dojo says so. */
  router.onDojoEvent = async (e) => {
    if (!e || !e.paymentIntentId) return;
    await ensureTables();
    const [[row]] = await pool.query("SELECT * FROM epos_qr_payments WHERE intent_id = ? AND status = 'waiting'", [e.paymentIntentId]);
    if (row) await settle(row);
  };

  /** QR Pay as Go reads it with its config. */
  router.phoneSettings = async (office) => {
    try {
      const s = await settingsFor(office);
      const key = s.enabled ? await keyFor(office) : null;
      return { ...s, available: !!(s.enabled && key), environment: key ? (dojo.isSandboxKey(key) ? 'sandbox' : 'live') : null };
    } catch (e) {
      console.warn('[qr-pay] settings:', e.message);
      return { ...DEFAULTS, enabled: false, available: false };
    }
  };

  return router;
}

module.exports = { qrPayRoutes, view };
