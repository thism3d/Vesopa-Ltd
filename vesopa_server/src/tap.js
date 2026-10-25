/**
 * Vesopa Tap -- card payments on the clerk's own phone, server half.
 *
 * A Vesopa Tap phone is a terminal: it is signed in with Continue with Vesopa
 * through /api/terminal/vesopa/commission like any till, holds a terminal
 * token, takes a till seat (the owner, 25 Oct 2026: "counts as a till") and
 * reads the venue's menu, staff and open bills through the till's own
 * endpoints. What a till does not have is a card reader inside it. The phone
 * does: Dojo's Tap to Pay on iPhone SDK (and Android, when Dojo publish it)
 * turns the phone's NFC into a contactless reader.
 *
 * THE KEY STAYS HERE
 *
 * A till fetches its venue's Dojo key (/api/till/dojo-settings) because it
 * talks to the card machine itself. A phone must not: it leaves the building
 * in a pocket. So everything that needs the key happens on this server:
 *
 *   POST /api/tap/secret          a short-lived Tap to Pay terminal secret
 *                                 (Dojo: six hours) the SDK activates with
 *   POST /api/tap/payments        a payment intent for one tender, created
 *                                 ONCE per client payment id
 *   GET  /api/tap/payments/:id    how that payment is going, asked of Dojo
 *   POST /api/tap/payments/:id/cancel
 *
 * NOTHING IS PAID UNTIL DOJO SAYS CAPTURED
 *
 * The SDK's own result is what the clerk sees first, but the phone settles a
 * bill only on this server's answer, which is read from the intent itself.
 * Dojo ignore Idempotency-Key (see dojo_client.js), so a phone that loses its
 * connection mid-request and sends the same payment again gets the intent it
 * already has, never a second charge: the row is keyed on the phone's own id.
 *
 * Every attempt, paid or not, goes into epos_card_transactions as the tills'
 * do (Dojo accreditation asked for declines to be logged too).
 *
 * Off until a venue turns it on: mounted only when the `tap` module is
 * allowed (see modules.js). Schema: schema/schema_tap.sql.
 */

const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');

const { requireAuth, requireTerminal, issueTerminalToken } = require('./auth');
const { attachAccess, requirePermission } = require('./permissions');
const { unseal } = require('./express_kiosk');
const dojoClient = require('./dojo_client');
const { partnerIds } = dojoClient;

/**
 * A venue's Vesopa Tap settings (owner, 25 Oct 2026: tips are a venue
 * setting, on by default). Read by the phones through /api/tap/config and
 * set in the back office under Vesopa Tap.
 */
const DEFAULTS = {
  enabled: 1,
  tips_enabled: 1,
  tip_percents: '10,12.5,15',
  service_percents: '0,10,12.5',
  allow_cash: 1,
  receipt_email: 1,
};

/** "10, 12.5,15" as [10, 12.5, 15]: up to four, each 0-30%, one decimal. */
function cleanPercents(raw, { allowZero = false } = {}) {
  const list = String(raw ?? '').split(',').map((s) => Math.round(Number(s.trim()) * 10) / 10)
    .filter((n) => Number.isFinite(n) && n >= (allowZero ? 0 : 0.5) && n <= 30);
  return [...new Set(list)].sort((a, b) => a - b).slice(0, 4);
}

function cleanSettings(body, old = DEFAULTS) {
  const flag = (k) => (body[k] === undefined ? Number(old[k]) : (body[k] === true || Number(body[k]) === 1 ? 1 : 0));
  const tips = body.tip_percents === undefined ? cleanPercents(old.tip_percents) : cleanPercents(body.tip_percents);
  const service = body.service_percents === undefined
    ? cleanPercents(old.service_percents, { allowZero: true })
    : cleanPercents(body.service_percents, { allowZero: true });
  return {
    enabled: flag('enabled'),
    tips_enabled: flag('tips_enabled'),
    tip_percents: (tips.length ? tips : cleanPercents(DEFAULTS.tip_percents)).join(','),
    service_percents: (service.length ? service : [0]).join(','),
    allow_cash: flag('allow_cash'),
    receipt_email: flag('receipt_email'),
  };
}

/** The settings as a phone reads them. */
function phoneSettings(s) {
  return {
    enabled: !!Number(s.enabled),
    tips: !!Number(s.tips_enabled),
    tip_percents: cleanPercents(s.tip_percents),
    service_percents: cleanPercents(s.service_percents, { allowZero: true }),
    allow_cash: !!Number(s.allow_cash),
    receipt_email: !!Number(s.receipt_email),
  };
}

/** The API version Dojo's Tap to Pay pages use for the secret. */
const TAP_VERSION = process.env.DOJO_TAP_API_VERSION || '2023-12-12';
/** The version every other Vesopa call to Dojo uses. */
const API_VERSION = process.env.DOJO_API_VERSION || '2024-02-05';

/**
 * Dojo's public Tap to Pay sandbox key, printed on
 * https://docs.dojo.tech/tap-to-pay-on-iphone for anybody to test with (as
 * dojo_settings.js keeps the card-machine one). A venue still on sandbox, or
 * with no key saved, is on this. Never a live key.
 */
const TAP_SANDBOX_KEY = process.env.DOJO_TAP_SANDBOX_KEY
  || 'sk_sandbox_EtKXUrMCHU9Y7NCURtDRI9KEn0yqWDgy4JFUOeg0QNGRihcml31fxJURpfbdlx1D';

/** Where Tap to Pay lives for a key: Dojo's staging host for sandbox keys. */
function tapBase(key) {
  if (String(key || '').startsWith('sk_sandbox_')) {
    return (process.env.DOJO_TAP_SANDBOX_BASE_URL || 'https://staging-api.dojo.dev/integration-test').replace(/\/+$/, '');
  }
  // Production: confirm with partnertech@dojo.tech before the first live venue.
  return (process.env.DOJO_TAP_BASE_URL || 'https://api.dojo.tech').replace(/\/+$/, '');
}

/**
 * The secret endpoint per phone. Android's is not published yet (Dojo's page
 * was a 404 on 25 Oct 2026); until it is set, an Android phone is told so
 * plainly rather than handed an iPhone secret it cannot use.
 */
function secretPath(platform) {
  if (platform === 'ios') return '/tap/apple-terminal/secret';
  if (platform === 'android') return process.env.DOJO_TAP_ANDROID_SECRET_PATH || null;
  return null;
}

class TapError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** One call to Dojo with the venue's key and Vesopa's partner ids. */
async function dojo(key, method, path, { body, version = API_VERSION, fetchImpl, extraHeaders = {} } = {}) {
  const ids = partnerIds(key);
  const headers = {
    ...extraHeaders,
    Authorization: 'Basic ' + key,
    version,
    Version: version,
    Accept: 'application/json',
    'software-house-id': ids.softwareHouseId,
    'reseller-id': ids.resellerId,
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let response;
  try {
    response = await (fetchImpl || fetch)(tapBase(key) + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    throw new TapError(502, 'Dojo could not be reached: ' + e.message);
  }
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  if (!response.ok) {
    const said = (json && (json.title || json.detail || json.message || json.error)) || text.slice(0, 200) || response.statusText;
    // 502 whatever Dojo answered: to the phone it is the payment service, not this request, that failed.
    throw new TapError(502, 'Dojo said: ' + String(said).split(key).join('<key>'));
  }
  return json;
}

/**
 * What a Dojo intent means for the bill.
 *
 *   paid      Captured (CaptureMode Auto) -- the money is in
 *   failed    Canceled or Reversed -- no money moved; try again with a new payment
 *   refunded  Refunded -- after the fact
 *   waiting   anything else (Created, Authorized on its way to Captured)
 */
function paymentState(intent) {
  const s = String((intent && intent.status) || '').toLowerCase();
  if (s === 'captured') return 'paid';
  if (s === 'canceled' || s === 'cancelled' || s === 'reversed') return 'failed';
  if (s === 'refunded') return 'refunded';
  return 'waiting';
}

/** Whole pence, positive, at most £10,000 a tender. */
function cleanMinor(v, { allowZero = false } = {}) {
  const n = Number(v);
  if (!Number.isInteger(n)) return null;
  if (n < (allowZero ? 0 : 1) || n > 1_000_000) return null;
  return n;
}

const PAYMENT_ID = /^[A-Za-z0-9_-]{8,64}$/;

function tapRoutes({ pool, secret, fetchImpl, verifyIdToken, signInDevice }) {
  const router = express.Router();
  const terminal = requireTerminal(secret);
  const opts = { fetchImpl };
  const auth = requireAuth(secret);
  const guard = (key) => [auth, attachAccess({ pool }), requirePermission(key)];

  /** The venue's Tap settings, or the defaults (a venue that never saved, or no table yet). */
  async function settingsFor(office) {
    try {
      const [[row]] = await pool.query('SELECT * FROM epos_tap_settings WHERE office = ?', [office]);
      return row ? { ...DEFAULTS, ...row } : { ...DEFAULTS };
    } catch (e) {
      if (e.code === 'ER_NO_SUCH_TABLE') return { ...DEFAULTS };
      throw e;
    }
  }

  /**
   * The card machine instead of the phone (no NFC, a card that wants chip
   * and PIN, Android before Dojo's SDK): the venue's own card-machine key and
   * default machine, exactly as its tills use them -- or Dojo's public
   * card-machine sandbox when it has none, as dojo_settings.js does.
   */
  async function machineFor(office) {
    const [[row]] = await pool.query(
      'SELECT api_key_enc, environment, terminal_id FROM epos_dojo_settings WHERE office = ?', [office]);
    const own = row && row.api_key_enc ? unseal(row.api_key_enc) : null;
    const { PUBLIC_SANDBOX_KEY } = require('./dojo_settings');
    return {
      key: own || PUBLIC_SANDBOX_KEY,
      environment: own && row.environment === 'live' ? 'live' : 'sandbox',
      terminalId: row && row.terminal_id ? row.terminal_id : null,
    };
  }

  /** The settings, or a 403 when the venue has switched Vesopa Tap off. */
  async function requireOn(office) {
    const s = await settingsFor(office);
    if (!Number(s.enabled)) throw new TapError(403, 'Vesopa Tap is switched off for this venue in the back office.');
    return s;
  }

  /** The signed-in back-office user's venue. */
  async function officeOf(req) {
    if (req.user && req.user.officeId) {
      const [[o]] = await pool.query('SELECT contact_email FROM offices WHERE id = ?', [req.user.officeId]);
      if (o) return o.contact_email;
    }
    return req.user && (req.user.officeEmail || req.user.email);
  }

  /** The venue's Dojo key and whether it is live. */
  async function keyFor(office) {
    const [[row]] = await pool.query(
      'SELECT api_key_enc, environment FROM epos_dojo_settings WHERE office = ?', [office]);
    const own = row && row.api_key_enc ? unseal(row.api_key_enc) : null;
    if (own && row.environment === 'live') return { key: own, environment: 'live' };
    // A venue on sandbox tests against Dojo's Tap to Pay sandbox, whatever card-machine key it saved.
    return { key: TAP_SANDBOX_KEY, environment: 'sandbox' };
  }

  async function logAttempt(row, outcome, dojoStatus, message) {
    const id = crypto.createHash('sha1').update(`tap:${row.id}:${outcome}:${dojoStatus || ''}`).digest('hex');
    await pool.query(
      `INSERT IGNORE INTO epos_card_transactions
         (id, office, terminal, at, kind, outcome, amount_minor, intent_id, dojo_status, message, order_id, software_house_id)
       VALUES (?, ?, ?, UTC_TIMESTAMP(), 'sale', ?, ?, ?, ?, ?, ?, ?)`,
      [id, row.office, row.terminal, outcome, row.amount_minor + row.tip_minor, row.intent_id,
        dojoStatus || null, message ? String(message).slice(0, 500) : null, row.bill_ref, partnerIds('').softwareHouseId]
    ).catch((e) => console.warn('[tap] card log:', e.message));
  }

  const who = (req) => String(req.seatId || req.terminal.jti || req.terminal.commissionedBy || 'tap').slice(0, 128);
  const send = (res, e, next) => (e instanceof TapError ? res.status(e.status).json({ error: e.message }) : next(e));
  const view = (row) => ({
    id: row.id,
    intent_id: row.intent_id,
    amount_minor: row.amount_minor,
    tip_minor: row.tip_minor,
    state: row.state,
    environment: row.environment,
    via: row.via || 'tap',
    refunded_minor: Number(row.refunded_minor) || 0,
  });

  /** What this phone needs to know before it offers Tap to Pay. */
  router.get('/api/tap/config', terminal, async (req, res, next) => {
    try {
      const { environment } = await keyFor(req.office);
      res.json({
        environment,
        ios: true,
        android: Boolean(secretPath('android')),
        cards: ['visa', 'mastercard', 'maestro', 'amex'],
        ...phoneSettings(await settingsFor(req.office)),
      });
    } catch (e) { send(res, e, next); }
  });

  /** A Tap to Pay terminal secret for the SDK's activate, link and pay calls. */
  router.post('/api/tap/secret', terminal, async (req, res, next) => {
    try {
      await requireOn(req.office);
      const platform = String((req.body && req.body.platform) || '');
      const path = secretPath(platform);
      if (!path) {
        throw new TapError(501, platform === 'android'
          ? 'Tap to Pay on Android is waiting for Dojo\'s Android SDK. Use the card machine for now.'
          : 'Say which phone this is: ios or android.');
      }
      const { key, environment } = await keyFor(req.office);
      const answer = await dojo(key, 'POST', path, { version: TAP_VERSION, ...opts });
      const value = answer && (answer.secret || answer.terminalSecret || answer.value);
      if (!value) throw new TapError(502, 'Dojo did not send a Tap to Pay secret.');
      res.json({ secret: value, environment, expires_in: 6 * 3600 });
    } catch (e) { send(res, e, next); }
  });

  /**
   * One tender on a bill. `id` is the phone's own id for this payment, so the
   * same request sent twice is the same payment.
   */
  router.post('/api/tap/payments', terminal, async (req, res, next) => {
    try {
      const b = req.body || {};
      const id = String(b.id || '');
      if (!PAYMENT_ID.test(id)) throw new TapError(400, 'A payment needs its own id.');
      const amount = cleanMinor(b.amount_minor);
      const tip = cleanMinor(b.tip_minor || 0, { allowZero: true });
      if (amount === null || tip === null) throw new TapError(400, 'That amount cannot be taken.');

      const [[had]] = await pool.query('SELECT * FROM epos_tap_payments WHERE id = ? AND office = ?', [id, req.office]);
      if (had) return res.json(view(had));
      const settings = await requireOn(req.office);
      if (tip && !Number(settings.tips_enabled)) throw new TapError(400, 'Tips are switched off for this venue.');

      const billRef = String(b.bill_ref || '').slice(0, 64) || null;
      const reference = String(b.reference || billRef || 'vesopa-tap').slice(0, 40);
      const description = b.description ? String(b.description).slice(0, 80) : 'Vesopa Tap';
      const via = b.via === 'machine' ? 'machine' : 'tap';
      let intent;
      let sessionId = null;
      let environment;
      if (via === 'machine') {
        // The venue's card machine, the way the tills drive it (dojo_client.js).
        const m = await machineFor(req.office);
        const terminalId = String(b.terminal_id || m.terminalId || '');
        if (!terminalId) throw new TapError(400, 'No card machine is set for this venue. Choose one under Card payments.');
        environment = m.environment;
        try {
          intent = await dojoClient.createIntent(m.key, { amountMinor: amount + tip, reference, description }, opts);
          const session = await dojoClient.startSession(m.key, { terminalId, intentId: intent.id }, opts);
          sessionId = session && session.id ? String(session.id) : null;
        } catch (e) {
          throw new TapError(502, 'The card machine did not start: ' + e.message);
        }
      } else {
        const k = await keyFor(req.office);
        environment = k.environment;
        intent = await dojo(k.key, 'POST', '/payment-intents', {
          ...opts,
          body: {
            // The tip rides in the amount; the split is kept in our own row.
            Amount: { Value: amount + tip, CurrencyCode: 'GBP' },
            Reference: reference,
            Description: description,
            CaptureMode: 'Auto',
          },
        });
      }
      if (!intent || !intent.id) throw new TapError(502, 'Dojo did not create the payment.');
      const row = {
        id, office: req.office, terminal: who(req), intent_id: intent.id, amount_minor: amount, tip_minor: tip,
        bill_ref: billRef, clerk: String(b.clerk || '').slice(0, 120) || null, state: 'waiting', environment, via, session_id: sessionId,
      };
      await pool.query(
        `INSERT INTO epos_tap_payments
           (id, office, terminal, intent_id, amount_minor, tip_minor, bill_ref, clerk, state, environment, via, session_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [row.id, row.office, row.terminal, row.intent_id, row.amount_minor, row.tip_minor, row.bill_ref, row.clerk, row.state,
          row.environment, row.via, row.session_id]
      );
      res.status(201).json(view(row));
    } catch (e) { send(res, e, next); }
  });

  /** Dojo's intent for a payment, from the host and key that made it. */
  async function intentOf(row) {
    if (row.via === 'machine') {
      const m = await machineFor(row.office);
      return dojoClient.getIntent(m.key, row.intent_id, opts);
    }
    const { key } = await keyFor(row.office);
    return dojo(key, 'GET', '/payment-intents/' + encodeURIComponent(row.intent_id), opts);
  }

  /** How a payment is going, from Dojo's intent, never from the phone's word. */
  router.get('/api/tap/payments/:id', terminal, async (req, res, next) => {
    try {
      const [[row]] = await pool.query('SELECT * FROM epos_tap_payments WHERE id = ? AND office = ?', [req.params.id, req.office]);
      if (!row) throw new TapError(404, 'No such payment.');
      if (row.state !== 'waiting') return res.json(view(row));
      let intent;
      try {
        intent = await intentOf(row);
      } catch (e) {
        if (e instanceof TapError) throw e;
        throw new TapError(502, 'Dojo could not be asked: ' + e.message);
      }
      const state = paymentState(intent);
      if (state !== 'waiting') {
        // Guarded by the old state, so a racing poll and webhook change it once.
        const [r] = await pool.query(
          "UPDATE epos_tap_payments SET state = ?, dojo_status = ? WHERE id = ? AND office = ? AND state = 'waiting'",
          [state, intent.status || null, row.id, row.office]);
        if (r.affectedRows) await logAttempt(row, state === 'paid' ? 'approved' : 'declined', intent.status);
        row.state = state;
      }
      res.json(view(row));
    } catch (e) { send(res, e, next); }
  });

  /** The clerk gave up: the intent is cancelled if Dojo still allows it. */
  router.post('/api/tap/payments/:id/cancel', terminal, async (req, res, next) => {
    try {
      const [[row]] = await pool.query('SELECT * FROM epos_tap_payments WHERE id = ? AND office = ?', [req.params.id, req.office]);
      if (!row) throw new TapError(404, 'No such payment.');
      if (row.state !== 'waiting') return res.json(view(row));
      const { key } = await keyFor(req.office);
      await dojo(key, 'POST', '/payment-intents/' + encodeURIComponent(row.intent_id) + '/cancel', opts).catch(() => null);
      const [r] = await pool.query(
        "UPDATE epos_tap_payments SET state = 'cancelled' WHERE id = ? AND office = ? AND state = 'waiting'", [row.id, row.office]);
      if (r.affectedRows) await logAttempt(row, 'cancelled', 'Canceled');
      row.state = r.affectedRows ? 'cancelled' : row.state;
      res.json(view(row));
    } catch (e) { send(res, e, next); }
  });

  /**
   * A refund of a paid payment, all or part. The phone asks only after a
   * manager's PIN (the app's void rule); who approved it is kept in the card
   * log. Refunds go back to the card that paid, never as cash.
   */
  router.post('/api/tap/payments/:id/refund', terminal, async (req, res, next) => {
    try {
      const b = req.body || {};
      const [[row]] = await pool.query('SELECT * FROM epos_tap_payments WHERE id = ? AND office = ?', [req.params.id, req.office]);
      if (!row) throw new TapError(404, 'No such payment.');
      if (row.state !== 'paid') throw new TapError(409, 'Only a paid payment can be refunded.');
      const total = row.amount_minor + row.tip_minor;
      const left = total - (Number(row.refunded_minor) || 0);
      const amount = cleanMinor(b.amount_minor ?? left);
      if (amount === null || amount > left) throw new TapError(400, `At most ${(left / 100).toFixed(2)} can be refunded.`);
      const approvedBy = String(b.approved_by || '').slice(0, 120);
      if (!approvedBy) throw new TapError(400, 'A refund needs a manager\'s approval.');
      const reason = String(b.reason || 'Refund').slice(0, 200);
      const idem = `tap-refund-${row.id}-${(Number(row.refunded_minor) || 0) + amount}`;
      if (row.via === 'machine') {
        const m = await machineFor(row.office);
        await dojoClient.refundIntent(m.key, row.intent_id, { amountMinor: amount, reason, idempotencyKey: idem }, opts);
      } else {
        const { key } = await keyFor(row.office);
        await dojo(key, 'POST', '/payment-intents/' + encodeURIComponent(row.intent_id) + '/refunds', {
          ...opts, body: { amount, refundReason: reason }, extraHeaders: { idempotencyKey: idem },
        });
      }
      const refunded = (Number(row.refunded_minor) || 0) + amount;
      await pool.query(
        'UPDATE epos_tap_payments SET refunded_minor = ?, state = ? WHERE id = ? AND office = ?',
        [refunded, refunded >= total ? 'refunded' : 'paid', row.id, row.office]);
      const rid = crypto.createHash('sha1').update(idem).digest('hex');
      await pool.query(
        `INSERT IGNORE INTO epos_card_transactions
           (id, office, terminal, at, kind, outcome, amount_minor, intent_id, dojo_status, message, order_id, software_house_id)
         VALUES (?, ?, ?, UTC_TIMESTAMP(), 'refund', 'approved', ?, ?, 'Refunded', ?, ?, ?)`,
        [rid, row.office, who(req), amount, row.intent_id, `${reason} (approved by ${approvedBy})`.slice(0, 500), row.bill_ref,
          partnerIds('').softwareHouseId]
      ).catch((e) => console.warn('[tap] refund log:', e.message));
      res.json({ ...view(row), refunded_minor: refunded, state: refunded >= total ? 'refunded' : 'paid' });
    } catch (e) {
      if (e && e.name === 'DojoError') return res.status(502).json({ error: 'Dojo refused the refund: ' + e.message });
      send(res, e, next);
    }
  });

  /**
   * An emailed receipt for a sale this venue recorded (POST /till/orders):
   * the same PDF the back office downloads, sent from the venue's mailer.
   */
  const receiptSends = new Map(); // terminal -> [times]
  router.post('/api/tap/receipts', terminal, express.json(), async (req, res, next) => {
    try {
      const b = req.body || {};
      const to = String(b.email || '').trim().slice(0, 254);
      if (!/^[^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,}$/i.test(to)) throw new TapError(400, 'That email address does not look right.');
      const me = who(req);
      const recent = (receiptSends.get(me) || []).filter((t) => Date.now() - t < 3600e3);
      if (recent.length >= 60) throw new TapError(429, 'Too many receipts from this phone in an hour.');
      const settings = await requireOn(req.office);
      if (!Number(settings.receipt_email)) throw new TapError(403, 'Emailed receipts are switched off for this venue.');

      const [[order]] = await pool.query('SELECT * FROM epos_orders WHERE id = ? AND email = ?', [String(b.order_id || ''), req.office]);
      if (!order) throw new TapError(404, 'That sale is not in the back office yet. Try again in a moment.');
      const [lines] = await pool.query(
        `SELECT name, quantity, unit_price_minor, tax_percentage, note, is_modifier
           FROM epos_order_lines WHERE order_id = ? ORDER BY line_no`, [order.id]);
      const [pays] = await pool.query(
        'SELECT method, amount_minor, taken_at, reference, entry_mode FROM epos_payments WHERE order_id = ?', [order.id]);
      const [[office]] = await pool.query('SELECT name FROM offices WHERE contact_email = ?', [req.office]);
      const venue = (office && office.name) || 'Your venue';
      const { receiptPdf } = require('./receipt_pdf');
      const { sendMail } = require('./mailer');
      const pdf = await receiptPdf({ order, lines, payments: pays, status: null }, venue);
      const total = (Number(order.total_minor) / 100).toFixed(2);
      await sendMail({
        to,
        subject: `Your receipt from ${venue}`,
        text: `Thank you for visiting ${venue}. Your receipt for £${total} is attached.`,
        html: `<p>Thank you for visiting <b>${venue.replace(/[<>&]/g, '')}</b>.</p><p>Your receipt for <b>£${total}</b> is attached.</p>`,
        attachments: [{ filename: `receipt-${String(order.id).slice(0, 8)}.pdf`, content: pdf, contentType: 'application/pdf' }],
      });
      receiptSends.set(me, [...recent, Date.now()]);
      res.json({ sent: true });
    } catch (e) { send(res, e, next); }
  });

  // ---- The back office ----------------------------------------------------------

  router.get('/api/tap/settings', guard('commerce.tender'), async (req, res, next) => {
    try {
      const office = await officeOf(req);
      const s = await settingsFor(office);
      const { environment } = await keyFor(office);
      res.json({ ...cleanSettings({}, s), environment });
    } catch (e) { send(res, e, next); }
  });

  router.put('/api/tap/settings', guard('commerce.edit'), express.json(), async (req, res, next) => {
    try {
      const office = await officeOf(req);
      const s = cleanSettings(req.body || {}, await settingsFor(office));
      await pool.query(
        `INSERT INTO epos_tap_settings
           (office, enabled, tips_enabled, tip_percents, service_percents, allow_cash, receipt_email, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), tips_enabled = VALUES(tips_enabled),
           tip_percents = VALUES(tip_percents), service_percents = VALUES(service_percents),
           allow_cash = VALUES(allow_cash), receipt_email = VALUES(receipt_email), updated_by = VALUES(updated_by)`,
        [office, s.enabled, s.tips_enabled, s.tip_percents, s.service_percents, s.allow_cash, s.receipt_email,
          String(req.user.email || '').slice(0, 255)]
      );
      res.json(s);
    } catch (e) { send(res, e, next); }
  });

  /** The phones signed in to this venue (till seats named by Vesopa Tap). */
  router.get('/api/tap/phones', guard('commerce.tender'), async (req, res, next) => {
    try {
      const office = await officeOf(req);
      const [rows] = await pool.query(
        `SELECT id, device_name, signed_in_by, signed_in_at, last_seen_at, released_at
           FROM bo_till_seats
          WHERE office = ? AND device_name LIKE '%Vesopa Tap%'
          ORDER BY released_at IS NULL DESC, last_seen_at DESC`, [office]);
      res.json({ phones: rows });
    } catch (e) { send(res, e, next); }
  });

  /** Card payments taken on phones on one day (default today), newest first. */
  router.get('/api/tap/payments', guard('commerce.tender'), async (req, res, next) => {
    try {
      const office = await officeOf(req);
      const day = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || '')) ? req.query.date : new Date().toISOString().slice(0, 10);
      const [rows] = await pool.query(
        `SELECT id, intent_id, amount_minor, tip_minor, bill_ref, clerk, state, dojo_status, environment, created_at
           FROM epos_tap_payments
          WHERE office = ? AND created_at >= ? AND created_at < DATE_ADD(?, INTERVAL 1 DAY)
          ORDER BY created_at DESC LIMIT 500`, [office, day, day]);
      const paid = rows.filter((r) => r.state === 'paid');
      res.json({
        date: day,
        payments: rows,
        totals: {
          count: paid.length,
          amount_minor: paid.reduce((s, r) => s + r.amount_minor, 0),
          tip_minor: paid.reduce((s, r) => s + r.tip_minor, 0),
        },
      });
    } catch (e) { send(res, e, next); }
  });

  // ---- A new venue, from the app ---------------------------------------------------

  /**
   * "Register a new venue" in Vesopa Tap: a Vesopa ID token (verified email)
   * becomes an office on Vesopa Tap alone, its first back-office user, and
   * this phone as its first till. One venue per email; the account has no
   * usable password (it signs in with Vesopa). Dojo starts on sandbox until
   * the venue connects its own account in the back office.
   */
  const registered = new Map(); // ip -> [times], a brake on scripted sign-ups
  router.post('/api/tap/register', express.json(), async (req, res, next) => {
    const conn = await pool.getConnection();
    try {
      const ip = String(req.ip || '');
      const recent = (registered.get(ip) || []).filter((t) => Date.now() - t < 3600e3);
      if (recent.length >= 5) throw new TapError(429, 'Too many new venues from here. Try again in an hour.');

      const b = req.body || {};
      if (!verifyIdToken) throw new TapError(503, 'Registering from the app is not available on this server.');
      let claims;
      try {
        claims = await verifyIdToken(b.id_token);
      } catch {
        throw new TapError(401, 'That Vesopa sign-in could not be accepted. Try again.');
      }
      const email = String(claims.email || '').trim().toLowerCase();
      if (!email || claims.email_verified === false) throw new TapError(403, 'Your Vesopa account needs a confirmed email address.');
      const name = String(b.venue_name || '').trim().replace(/\s+/g, ' ').slice(0, 120);
      if (name.length < 2) throw new TapError(400, 'Give the venue a name.');
      const postcode = String(b.postcode || '').trim().toUpperCase().slice(0, 10);
      const type = String(b.business_type || '').trim().slice(0, 60);

      const [[user]] = await conn.query('SELECT id FROM backoffice_users WHERE email = ?', [email]);
      const [[office]] = await conn.query('SELECT id FROM offices WHERE contact_email = ?', [email]);
      if (user || office) {
        throw new TapError(409, 'That Vesopa account already has a venue. Use Continue with Vesopa instead.');
      }

      await conn.beginTransaction();
      const [o] = await conn.execute(
        "INSERT INTO offices (name, contact_email, plan, status) VALUES (?, ?, 'tap', 'active')", [name, email]);
      const unusable = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
      await conn.execute(
        `INSERT INTO backoffice_users (email, password, name, company, approved, role, office_id)
         VALUES (?, ?, ?, ?, 'Y', 'office', ?)`,
        [email, unusable, String(claims.name || name).slice(0, 120), name, o.insertId]);
      await conn.execute(
        `INSERT INTO epos_tap_settings (office, enabled, tips_enabled, tip_percents, service_percents, allow_cash, receipt_email, updated_by)
         VALUES (?, 1, 1, ?, ?, 1, 1, ?)`,
        [email, DEFAULTS.tip_percents, DEFAULTS.service_percents, `register:${type || 'tap'}${postcode ? ' ' + postcode : ''}`.slice(0, 255)]);
      await conn.commit();
      registered.set(ip, [...recent, Date.now()]);

      const owner = { officeEmail: email, officeId: o.insertId, email, officeName: name };
      const seatId = signInDevice
        ? await signInDevice(pool, {
          office: email, kind: 'till', deviceId: String(b.device_id || '').slice(0, 64) || null,
          deviceName: String(b.name || 'Phone (Vesopa Tap)').slice(0, 120), by: email,
        })
        : null;
      res.status(201).json({ terminalToken: issueTerminalToken(owner, secret, undefined, seatId), user: owner });
    } catch (e) {
      await conn.rollback().catch(() => {});
      send(res, e, next);
    } finally {
      conn.release();
    }
  });

  // ---- Dojo's webhook ---------------------------------------------------------------

  /**
   * A captured intent from Dojo's webhook: a phone that went away mid-payment
   * still gets its payment marked paid. Guarded by `state = 'waiting'`, so the
   * phone's poll and the webhook change it once between them.
   */
  router.onDojoEvent = async (e) => {
    if (!e || !e.paymentIntentId) return;
    const status = String(e.status || '').toLowerCase();
    const state = status === 'captured' || status === 'succeeded' ? 'paid'
      : status === 'canceled' || status === 'cancelled' || status === 'reversed' ? 'failed' : null;
    if (!state) return;
    try {
      const [[row]] = await pool.query("SELECT * FROM epos_tap_payments WHERE intent_id = ? AND state = 'waiting'", [e.paymentIntentId]);
      if (!row) return;
      const [r] = await pool.query(
        "UPDATE epos_tap_payments SET state = ?, dojo_status = ? WHERE id = ? AND state = 'waiting'",
        [state, e.status || null, row.id]);
      if (r.affectedRows) await logAttempt(row, state === 'paid' ? 'approved' : 'declined', e.status, 'webhook');
    } catch (err) {
      if (err.code !== 'ER_NO_SUCH_TABLE') console.warn('[tap] webhook:', err.message);
    }
  };

  return router;
}

module.exports = {
  tapRoutes, tapBase, secretPath, paymentState, cleanMinor, cleanPercents, cleanSettings, phoneSettings, DEFAULTS, TAP_SANDBOX_KEY,
};
