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

const { requireTerminal } = require('./auth');
const { unseal } = require('./express_kiosk');
const { partnerIds } = require('./dojo_client');

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
async function dojo(key, method, path, { body, version = API_VERSION, fetchImpl } = {}) {
  const ids = partnerIds(key);
  const headers = {
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

function tapRoutes({ pool, secret, fetchImpl }) {
  const router = express.Router();
  const terminal = requireTerminal(secret);
  const opts = { fetchImpl };

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
      });
    } catch (e) { send(res, e, next); }
  });

  /** A Tap to Pay terminal secret for the SDK's activate, link and pay calls. */
  router.post('/api/tap/secret', terminal, async (req, res, next) => {
    try {
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

      const { key, environment } = await keyFor(req.office);
      const billRef = String(b.bill_ref || '').slice(0, 64) || null;
      const intent = await dojo(key, 'POST', '/payment-intents', {
        ...opts,
        body: {
          // The tip rides in the amount; the split is kept in our own row.
          Amount: { Value: amount + tip, CurrencyCode: 'GBP' },
          Reference: String(b.reference || billRef || 'vesopa-tap').slice(0, 40),
          Description: b.description ? String(b.description).slice(0, 80) : 'Vesopa Tap',
          CaptureMode: 'Auto',
        },
      });
      if (!intent || !intent.id) throw new TapError(502, 'Dojo did not create the payment.');
      const row = {
        id, office: req.office, terminal: who(req), intent_id: intent.id, amount_minor: amount, tip_minor: tip,
        bill_ref: billRef, clerk: String(b.clerk || '').slice(0, 120) || null, state: 'waiting', environment,
      };
      await pool.query(
        `INSERT INTO epos_tap_payments
           (id, office, terminal, intent_id, amount_minor, tip_minor, bill_ref, clerk, state, environment)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [row.id, row.office, row.terminal, row.intent_id, row.amount_minor, row.tip_minor, row.bill_ref, row.clerk, row.state, row.environment]
      );
      res.status(201).json(view(row));
    } catch (e) { send(res, e, next); }
  });

  /** How a payment is going, from Dojo's intent, never from the phone's word. */
  router.get('/api/tap/payments/:id', terminal, async (req, res, next) => {
    try {
      const [[row]] = await pool.query('SELECT * FROM epos_tap_payments WHERE id = ? AND office = ?', [req.params.id, req.office]);
      if (!row) throw new TapError(404, 'No such payment.');
      if (row.state !== 'waiting') return res.json(view(row));
      const { key } = await keyFor(req.office);
      const intent = await dojo(key, 'GET', '/payment-intents/' + encodeURIComponent(row.intent_id), opts);
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

  return router;
}

module.exports = { tapRoutes, tapBase, secretPath, paymentState, cleanMinor, TAP_SANDBOX_KEY };
