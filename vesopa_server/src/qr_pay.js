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

  // The schemes' and wallets' own marks (Simple Icons, CC0), each on a white
  // card as a checkout shows them; Mastercard as its two circles.
  const BADGES = `<div class="badges"><span class="b" title="Visa"><svg class="m" xmlns="http://www.w3.org/2000/svg" viewBox="0 7.92 24 8.16"><path fill="#1A1F71" d="M9.112 8.262L5.97 15.758H3.92L2.374 9.775c-.094-.368-.175-.503-.461-.658C1.447 8.864.677 8.627 0 8.479l.046-.217h3.3a.904.904 0 01.894.764l.817 4.338 2.018-5.102zm8.033 5.049c.008-1.979-2.736-2.088-2.717-2.972.006-.269.262-.555.822-.628a3.66 3.66 0 011.913.336l.34-1.59a5.207 5.207 0 00-1.814-.333c-1.917 0-3.266 1.02-3.278 2.479-.012 1.079.963 1.68 1.698 2.04.756.367 1.01.603 1.006.931-.005.504-.602.725-1.16.734-.975.015-1.54-.263-1.992-.473l-.351 1.642c.453.208 1.289.39 2.156.398 2.037 0 3.37-1.006 3.377-2.564m5.061 2.447H24l-1.565-7.496h-1.656a.883.883 0 00-.826.55l-2.909 6.946h2.036l.405-1.12h2.488zm-2.163-2.656l1.02-2.815.588 2.815zm-8.16-4.84l-1.603 7.496H8.34l1.605-7.496z"/></svg></span><span class="b mc" title="Mastercard"><i></i><i></i></span><span class="b" title="American Express"><svg class="m" xmlns="http://www.w3.org/2000/svg" viewBox="0 -0.2 24 24.4"><path fill="#2E77BC" d="M16.015 14.378c0-.32-.135-.496-.344-.622-.21-.12-.464-.135-.81-.135h-1.543v2.82h.675v-1.027h.72c.24 0 .39.024.478.125.12.13.104.38.104.55v.35h.66v-.555c-.002-.25-.017-.376-.108-.516-.06-.08-.18-.18-.33-.234l.02-.008c.18-.072.48-.297.48-.747zm-.87.407l-.028-.002c-.09.053-.195.058-.33.058h-.81v-.63h.824c.12 0 .24 0 .33.05.098.048.156.147.15.255 0 .12-.045.215-.134.27zM20.297 15.837H19v.6h1.304c.676 0 1.05-.278 1.05-.884 0-.28-.066-.448-.187-.582-.153-.133-.392-.193-.73-.207l-.376-.015c-.104 0-.18 0-.255-.03-.09-.03-.15-.105-.15-.21 0-.09.017-.166.09-.21.083-.046.177-.066.272-.06h1.23v-.602h-1.35c-.704 0-.958.437-.958.84 0 .9.776.855 1.407.87.104 0 .18.015.225.06.046.03.082.106.082.18 0 .077-.035.15-.08.18-.06.053-.15.07-.277.07zM0 0v10.096L.81 8.22h1.75l.225.464V8.22h2.043l.45 1.02.437-1.013h6.502c.295 0 .56.057.756.236v-.23h1.787v.23c.307-.17.686-.23 1.12-.23h2.606l.24.466v-.466h1.918l.254.465v-.466h1.858v3.948H20.87l-.36-.6v.585h-2.353l-.256-.63h-.583l-.27.614h-1.213c-.48 0-.84-.104-1.08-.24v.24h-2.89v-.884c0-.12-.03-.12-.105-.135h-.105v1.036H6.067v-.48l-.21.48H4.69l-.202-.48v.465H2.235l-.256-.624H1.4l-.256.624H0V24h23.786v-7.108c-.27.135-.613.18-.973.18H21.09v-.255c-.21.165-.57.255-.914.255H14.71v-.9c0-.12-.018-.12-.12-.12h-.075v1.022h-1.8v-1.066c-.298.136-.643.15-.928.136h-.214v.915h-2.18l-.54-.617-.57.6H4.742v-3.93h3.61l.518.602.554-.6h2.412c.28 0 .74.03.942.225v-.24h2.177c.202 0 .644.045.903.225v-.24h3.265v.24c.163-.164.508-.24.803-.24h1.89v.24c.194-.15.464-.24.84-.24h1.176V0H0zM21.156 14.955c.004.005.006.012.01.016.01.01.024.01.032.02l-.042-.035zM23.828 13.082h.065v.555h-.065zM23.865 15.03v-.005c-.03-.025-.046-.048-.075-.07-.15-.153-.39-.215-.764-.225l-.36-.012c-.12 0-.194-.007-.27-.03-.09-.03-.15-.105-.15-.21 0-.09.03-.16.09-.204.076-.045.15-.05.27-.05h1.223v-.588h-1.283c-.69 0-.96.437-.96.84 0 .9.78.855 1.41.87.104 0 .18.015.224.06.046.03.076.106.076.18 0 .07-.034.138-.09.18-.045.056-.136.07-.27.07h-1.288v.605h1.287c.42 0 .734-.118.9-.36h.03c.09-.134.135-.3.135-.523 0-.24-.045-.39-.135-.526zM18.597 14.208v-.583h-2.235V16.458h2.235v-.585h-1.57v-.57h1.533v-.584h-1.532v-.51M13.51 8.787h.685V11.6h-.684zM13.126 9.543l-.007.006c0-.314-.13-.5-.34-.624-.217-.125-.47-.135-.81-.135H10.43v2.82h.674v-1.034h.72c.24 0 .39.03.487.12.122.136.107.378.107.548v.354h.677v-.553c0-.25-.016-.375-.11-.516-.09-.107-.202-.19-.33-.237.172-.07.472-.3.472-.75zm-.855.396h-.015c-.09.054-.195.056-.33.056H11.1v-.623h.825c.12 0 .24.004.33.05.09.04.15.128.15.25s-.047.22-.134.266zM15.92 9.373h.632v-.6h-.644c-.464 0-.804.105-1.02.33-.286.3-.362.69-.362 1.11 0 .512.123.833.36 1.074.232.238.645.31.97.31h.78l.255-.627h1.39l.262.627h1.36v-2.11l1.272 2.11h.95l.002.002V8.786h-.684v1.963l-1.18-1.96h-1.02V11.4L18.11 8.744h-1.004l-.943 2.22h-.3c-.177 0-.362-.03-.468-.134-.125-.15-.186-.36-.186-.662 0-.285.08-.51.194-.63.133-.135.272-.165.516-.165zm1.668-.108l.464 1.118v.002h-.93l.466-1.12zM2.38 10.97l.254.628H4V9.393l.972 2.205h.584l.973-2.202.015 2.202h.69v-2.81H6.118l-.807 1.904-.876-1.905H3.343v2.663L2.205 8.787h-.997L.01 11.597h.72l.26-.626h1.39zm-.688-1.705l.46 1.118-.003.002h-.915l.457-1.12zM11.856 13.62H9.714l-.85.923-.825-.922H5.346v2.82H8l.855-.932.824.93h1.302v-.94h.838c.6 0 1.17-.164 1.17-.945l-.006-.003c0-.78-.598-.93-1.128-.93zM7.67 15.853l-.014-.002H6.02v-.557h1.47v-.574H6.02v-.51H7.7l.733.82-.764.824zm2.642.33l-1.03-1.147 1.03-1.108v2.253zm1.553-1.258h-.885v-.717h.885c.24 0 .42.098.42.344 0 .243-.15.372-.42.372zM9.967 9.373v-.586H7.73V11.6h2.237v-.58H8.4v-.564h1.527V9.88H8.4v-.507"/></svg></span><span class="b" title="Apple Pay"><svg class="m" xmlns="http://www.w3.org/2000/svg" viewBox="0 4.12 24 15.76"><path fill="#000000" d="M2.15 4.318a42.16 42.16 0 0 0-.454.003c-.15.005-.303.013-.452.04a1.44 1.44 0 0 0-1.06.772c-.07.138-.114.278-.14.43-.028.148-.037.3-.04.45A10.2 10.2 0 0 0 0 6.222v11.557c0 .07.002.138.003.207.004.15.013.303.04.452.027.15.072.291.142.429a1.436 1.436 0 0 0 .63.63c.138.07.278.115.43.142.148.027.3.036.45.04l.208.003h20.194l.207-.003c.15-.004.303-.013.452-.04.15-.027.291-.071.428-.141a1.432 1.432 0 0 0 .631-.631c.07-.138.115-.278.141-.43.027-.148.036-.3.04-.45.002-.07.003-.138.003-.208l.001-.246V6.221c0-.07-.002-.138-.004-.207a2.995 2.995 0 0 0-.04-.452 1.446 1.446 0 0 0-1.2-1.201 3.022 3.022 0 0 0-.452-.04 10.448 10.448 0 0 0-.453-.003zm0 .512h19.942c.066 0 .131.002.197.003.115.004.25.01.375.032.109.02.2.05.287.094a.927.927 0 0 1 .407.407.997.997 0 0 1 .094.288c.022.123.028.258.031.374.002.065.003.13.003.197v11.552c0 .065 0 .13-.003.196-.003.115-.009.25-.032.375a.927.927 0 0 1-.5.693 1.002 1.002 0 0 1-.286.094 2.598 2.598 0 0 1-.373.032l-.2.003H1.906c-.066 0-.133-.002-.196-.003a2.61 2.61 0 0 1-.375-.032c-.109-.02-.2-.05-.288-.094a.918.918 0 0 1-.406-.407 1.006 1.006 0 0 1-.094-.288 2.531 2.531 0 0 1-.032-.373 9.588 9.588 0 0 1-.002-.197V6.224c0-.065 0-.131.002-.197.004-.114.01-.248.032-.375.02-.108.05-.199.094-.287a.925.925 0 0 1 .407-.406 1.03 1.03 0 0 1 .287-.094c.125-.022.26-.029.375-.032.065-.002.131-.002.196-.003zm4.71 3.7c-.3.016-.668.199-.88.456-.191.22-.36.58-.316.918.338.03.675-.169.888-.418.205-.258.345-.603.308-.955zm2.207.42v5.493h.852v-1.877h1.18c1.078 0 1.835-.739 1.835-1.812 0-1.07-.742-1.805-1.808-1.805zm.852.719h.982c.739 0 1.161.396 1.161 1.089 0 .692-.422 1.092-1.164 1.092h-.979zm-3.154.3c-.45.01-.83.28-1.05.28-.235 0-.593-.264-.981-.257a1.446 1.446 0 0 0-1.23.747c-.527.908-.139 2.255.374 2.995.249.366.549.769.944.754.373-.014.52-.242.973-.242.454 0 .586.242.98.235.41-.007.667-.366.915-.733.286-.417.403-.82.41-.841-.007-.008-.79-.308-.797-1.209-.008-.754.615-1.113.644-1.135-.352-.52-.9-.578-1.09-.593a1.123 1.123 0 0 0-.092-.002zm8.204.397c-.99 0-1.606.533-1.652 1.256h.777c.072-.358.369-.586.845-.586.502 0 .803.266.803.711v.309l-1.097.064c-.951.054-1.488.484-1.488 1.184 0 .72.548 1.207 1.332 1.207.526 0 1.032-.281 1.264-.727h.019v.659h.788v-2.76c0-.803-.62-1.317-1.591-1.317zm1.94.072l1.446 4.009c0 .003-.073.24-.073.247-.125.41-.33.571-.711.571-.069 0-.206 0-.267-.015v.666c.06.011.267.019.335.019.83 0 1.226-.312 1.568-1.283l1.5-4.214h-.868l-1.012 3.259h-.015l-1.013-3.26zm-1.167 2.189v.316c0 .521-.45.917-1.024.917-.442 0-.731-.228-.731-.579 0-.342.278-.56.769-.593z"/></svg></span><span class="b wide" title="Google Pay"><svg class="m" xmlns="http://www.w3.org/2000/svg" viewBox="0 7.03 24 9.94"><path fill="#3C4043" d="M3.963 7.235A3.963 3.963 0 00.422 9.419a3.963 3.963 0 000 3.559 3.963 3.963 0 003.541 2.184c1.07 0 1.97-.352 2.627-.957.748-.69 1.18-1.71 1.18-2.916a4.722 4.722 0 00-.07-.806H3.964v1.526h2.14a1.835 1.835 0 01-.79 1.205c-.356.241-.814.379-1.35.379-1.034 0-1.911-.697-2.225-1.636a2.375 2.375 0 010-1.517c.314-.94 1.191-1.636 2.225-1.636a2.152 2.152 0 011.52.594l1.132-1.13a3.808 3.808 0 00-2.652-1.033zm6.501.55v6.9h.886V11.89h1.465c.603 0 1.11-.196 1.522-.588a1.911 1.911 0 00.635-1.464 1.92 1.92 0 00-.635-1.456 2.125 2.125 0 00-1.522-.598zm2.427.85a1.156 1.156 0 01.823.365 1.176 1.176 0 010 1.686 1.171 1.171 0 01-.877.357H11.35V8.635h1.487a1.156 1.156 0 01.054 0zm4.124 1.175c-.842 0-1.477.308-1.907.925l.781.491c.288-.417.68-.626 1.175-.626a1.255 1.255 0 01.856.323 1.009 1.009 0 01.366.785v.202c-.34-.193-.774-.289-1.3-.289-.617 0-1.11.145-1.479.434-.37.288-.554.677-.554 1.165a1.476 1.476 0 00.525 1.156c.35.308.785.463 1.305.463.61 0 1.098-.27 1.465-.81h.038v.655h.848v-2.909c0-.61-.19-1.09-.568-1.44-.38-.35-.896-.525-1.551-.525zm2.263.154l1.946 4.422-1.098 2.38h.915L24 9.963h-.965l-1.368 3.391h-.02l-1.406-3.39zm-2.146 2.368c.494 0 .88.11 1.156.33 0 .372-.147.696-.44.973a1.413 1.413 0 01-.997.414 1.081 1.081 0 01-.69-.232.708.708 0 01-.293-.578c0-.257.12-.47.363-.647.24-.173.54-.26.9-.26Z"/></svg></span></div>`;

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
.b{display:inline-flex;align-items:center;justify-content:center;width:52px;height:34px;padding:6px 7px;border-radius:7px;border:1px solid #ddd;background:#fff}.b.wide{width:60px}.b .m{width:100%;height:100%}
.mc i{display:inline-block;width:19px;height:19px;border-radius:50%;background:#eb001b}.mc i+i{background:#f79e1b;margin-left:-8px;opacity:.9}
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
