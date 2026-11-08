/**
 * Stripe for a venue, beside Dojo and Teya (2026-11-04): "We have dojo and
 * Teya, now add Stripe as well. Do not remove any others."
 *
 *   * Off for every venue until a manager turns it on: no row, nothing changes.
 *   * Each venue is its own connected account (v2, Express dashboard, Vesopa
 *     sets pricing, Stripe holds losses; connect-recommend-plan.md) and every
 *     payment is a direct charge on it.
 *   * Stripe is chosen per way of paying -- Tap to Pay, online (QR, menus,
 *     tickets), memberships -- so a venue can keep Dojo or Teya for the rest.
 *   * Nothing takes a Stripe payment until the venue's card payments and
 *     payouts are active.
 *
 * The tills and Go never hold a Stripe key: they ask this server for a
 * Terminal connection token and for the venue's payments.
 */
'use strict';

const express = require('express');

const stripe = require('./stripe_client');
const { goOptionsFor } = require('./go_options');
const { requireAuth, requireTerminal } = require('./auth');
const { attachAccess, requirePermission } = require('./permissions');

const USES = ['tap', 'online', 'memberships'];

function stripeRoutes({ pool, broadcast = () => {}, secret, client = stripe }) {
  // Helpers a stand-in client (tests) leaves out come from the real one.
  client = { ...stripe, ...client };
  const router = express.Router();
  const auth = requireAuth(secret);
  const attach = attachAccess({ pool });
  const guard = (key) => [auth, attach, requirePermission(key)];

  let ready = null;
  function ensure() {
    ready ||= pool.query(`CREATE TABLE IF NOT EXISTS epos_stripe_settings (
        office VARCHAR(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL PRIMARY KEY,
        account_id VARCHAR(64) NULL,
        enabled TINYINT(1) NOT NULL DEFAULT 0,
        use_tap TINYINT(1) NOT NULL DEFAULT 0,
        use_online TINYINT(1) NOT NULL DEFAULT 0,
        use_memberships TINYINT(1) NOT NULL DEFAULT 0,
        location_id VARCHAR(64) NULL,
        card_payments VARCHAR(24) NULL,
        payouts VARCHAR(24) NULL,
        requirements_due INT NOT NULL DEFAULT 0,
        environment VARCHAR(12) NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`).catch((e) => { ready = null; throw e; });
    return ready;
  }

  async function tenantEmail(req) {
    if (req.user.officeId) {
      const [[office]] = await pool.query('SELECT contact_email FROM offices WHERE id = ?', [req.user.officeId]);
      if (office) return office.contact_email;
    }
    return req.user.email;
  }

  async function settingsFor(office) {
    await ensure();
    const [[row]] = await pool.query('SELECT * FROM epos_stripe_settings WHERE office = ?', [office]);
    return row || null;
  }

  async function save(office, fields) {
    await ensure();
    const cols = Object.keys(fields);
    await pool.execute(
      `INSERT INTO epos_stripe_settings (office, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})
       ON DUPLICATE KEY UPDATE ${cols.map((c) => `${c} = VALUES(${c})`).join(', ')}`,
      [office, ...cols.map((c) => fields[c])]);
  }

  /** What the back office and the tills are told: never a key. */
  function view(row) {
    const r = row || {};
    const live = r.card_payments === 'active' && r.payouts === 'active';
    const on = client.configuredFor(r.environment);
    return {
      configured: on,
      environment: on ? client.environmentOf(r.environment) : null,
      publishable_key: on ? client.publishableFor(r.environment) : null,
      // Vesopa Software Ltd's own account takes this venue's payments.
      platform: r.account_id === client.PLATFORM,
      google_pay_environment: process.env.GOOGLE_PAY_ENV === 'PRODUCTION' ? 'PRODUCTION' : 'TEST',
      google_pay_merchant_id: process.env.GOOGLE_PAY_MERCHANT_ID || null,
      enabled: Boolean(Number(r.enabled)),
      account: r.account_id || null,
      ready: live,
      card_payments: r.card_payments || null,
      payouts: r.payouts || null,
      requirements_due: Number(r.requirements_due) || 0,
      uses: Object.fromEntries(USES.map((u) => [u, Boolean(Number(r[`use_${u}`]))])),
      location: r.location_id || null,
    };
  }

  /** Re-read the venue's capabilities from Stripe and keep them. */
  async function refresh(office, row) {
    if (!row || !row.account_id) return row;
    const s = row.account_id === client.PLATFORM
      ? await client.platformReadiness(client.optsFor(row))
      : client.readiness(await client.retrieveAccount(row.account_id, client.optsFor(row)));
    const fields = { card_payments: s.card_payments, payouts: s.payouts, requirements_due: s.requirements_due };
    await save(office, fields);
    return { ...row, ...fields };
  }

  const fail = (res, e, next) => (e instanceof stripe.StripeError
    ? res.status(e.status >= 500 ? 502 : e.status).json({ error: e.message, code: e.code })
    : next(e));

  // ---- Back office ------------------------------------------------------------

  router.get('/stripe-settings', guard('commerce.tender'), async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      let row = await settingsFor(office);
      if (req.query.refresh && row && row.account_id) row = await refresh(office, row).catch(() => row);
      res.json(view(row));
    } catch (e) { fail(res, e, next); }
  });

  /** On or off, and which ways of paying use Stripe. Dojo and Teya are untouched. */
  router.put('/stripe-settings', guard('commerce.edit'), async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const b = req.body || {};
      const fields = {};
      if ('enabled' in b) fields.enabled = b.enabled ? 1 : 0;
      for (const u of USES) if (b.uses && u in b.uses) fields[`use_${u}`] = b.uses[u] ? 1 : 0;
      if (!Object.keys(fields).length) return res.status(400).json({ error: 'Nothing to change.' });
      await save(office, fields);
      broadcast({ type: 'till-settings' }, { office });
      res.json(view(await settingsFor(office)));
    } catch (e) { fail(res, e, next); }
  });

  /** The venue's connected account, made once. */
  router.post('/stripe/account', guard('commerce.edit'), async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const had = await settingsFor(office);
      if (had && had.account_id) return res.json(view(had));
      const [[venue]] = await pool.query('SELECT name FROM offices WHERE contact_email = ?', [office]);
      const acct = await client.createAccount({ email: office, name: venue && venue.name });
      const s = client.readiness(acct);
      await save(office, {
        account_id: acct.id, environment: client.environment(),
        card_payments: s.card_payments, payouts: s.payouts, requirements_due: s.requirements_due,
      });
      res.status(201).json(view(await settingsFor(office)));
    } catch (e) { fail(res, e, next); }
  });

  /** A client secret for the embedded components on the Payments page. */
  router.post('/stripe/account-session', guard('commerce.edit'), async (req, res, next) => {
    try {
      const row = await settingsFor(await tenantEmail(req));
      if (!row || !row.account_id) return res.status(409).json({ error: 'Set up the venue\'s Stripe account first.' });
      if (row.account_id === client.PLATFORM) {
        return res.status(409).json({ error: 'This venue takes payments into Vesopa Software Ltd\'s own Stripe account. See them at dashboard.stripe.com.', platform: true });
      }
      const s = await client.accountSession(row.account_id, client.optsFor(row));
      res.json({ client_secret: s.client_secret, publishable_key: client.publishableFor(row.environment) });
    } catch (e) { fail(res, e, next); }
  });

  router.post('/stripe/login-link', guard('commerce.edit'), async (req, res, next) => {
    try {
      const row = await settingsFor(await tenantEmail(req));
      if (!row || !row.account_id) return res.status(409).json({ error: 'Set up the venue\'s Stripe account first.' });
      if (row.account_id === client.PLATFORM) return res.json({ url: 'https://dashboard.stripe.com/' });
      const l = await client.loginLink(row.account_id, client.optsFor(row));
      res.json({ url: l.url });
    } catch (e) { fail(res, e, next); }
  });

  /** Where the venue's Tap to Pay readers are, as Stripe Terminal needs one. */
  router.post('/stripe/location', guard('commerce.edit'), async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const row = await settingsFor(office);
      if (!row || !row.account_id) return res.status(409).json({ error: 'Set up the venue\'s Stripe account first.' });
      const b = req.body || {};
      if (!b.line1 || !b.city || !b.postcode) return res.status(400).json({ error: 'The venue\'s address, town and postcode are needed.' });
      const [[venue]] = await pool.query('SELECT name FROM offices WHERE contact_email = ?', [office]);
      const loc = await client.createLocation(row.account_id, { name: b.name || (venue && venue.name) || 'Venue', line1: b.line1, city: b.city, postcode: b.postcode }, client.optsFor(row));
      await save(office, { location_id: loc.id });
      res.json(view(await settingsFor(office)));
    } catch (e) { fail(res, e, next); }
  });

  // ---- Tills and Vesopa Go ------------------------------------------------------

  const terminal = requireTerminal(secret);

  /** Live only when the venue chose Stripe for Tap to Pay and Stripe says it may take cards. */
  async function tapReady(req, res) {
    const row = await settingsFor(req.office);
    const v = view(row);
    if (!v.configured || !v.enabled || !v.uses.tap) {
      res.status(409).json({ error: 'This venue does not take Tap to Pay through Stripe.' });
      return null;
    }
    if (!v.ready) {
      res.status(409).json({ error: 'The venue\'s Stripe account is not ready to take cards yet. Finish it in the back office (Payments).' });
      return null;
    }
    return row;
  }

  router.get('/till/stripe/config', terminal, async (req, res, next) => {
    try { res.json(view(await settingsFor(req.office))); } catch (e) { fail(res, e, next); }
  });

  router.post('/till/stripe/connection-token', terminal, async (req, res, next) => {
    try {
      const row = await tapReady(req, res);
      if (!row) return;
      const t = await client.connectionToken(row.account_id, row.location_id, client.optsFor(row));
      res.json({ secret: t.secret, location: row.location_id, account: row.account_id });
    } catch (e) { fail(res, e, next); }
  });

  router.post('/till/stripe/payments', terminal, async (req, res, next) => {
    try {
      const row = await tapReady(req, res);
      if (!row) return;
      const amount = Math.round(Number(req.body && req.body.amount_minor));
      if (!Number.isInteger(amount) || amount < 30) return res.status(400).json({ error: 'At least 30p.' });
      const pi = await client.createTerminalPayment(row.account_id, {
        amountMinor: amount,
        reference: req.body.reference ? String(req.body.reference).slice(0, 80) : undefined,
        description: req.body.description ? String(req.body.description).slice(0, 200) : undefined,
        attempt: req.body.attempt ? String(req.body.attempt).replace(/[^\w-]/g, '').slice(0, 40) || undefined : undefined,
      }, client.optsFor(row));
      res.status(201).json({ id: pi.id, client_secret: pi.client_secret, status: pi.status, account: row.account_id });
    } catch (e) { fail(res, e, next); }
  });

  /**
   * Google Pay on Go's pay page: the token Google made for this venue, charged
   * on its account. A bank's extra check cannot be shown on Go, so such a
   * payment is called off and the clerk takes it another way.
   */
  router.post('/till/stripe/google-pay', terminal, async (req, res, next) => {
    try {
      if ((await goOptionsFor(pool, req.office)).google_pay_gateway !== 'stripe') {
        return res.status(409).json({ error: 'Google Pay through Stripe is off for this venue.' });
      }
      const row = await settingsFor(req.office);
      if (!row || !row.account_id || !Number(row.enabled)) return res.status(409).json({ error: 'Connect Stripe in the back office first.' });
      const amount = Math.round(Number(req.body && req.body.amount_minor));
      const token = String((req.body && req.body.token) || '');
      if (!Number.isInteger(amount) || amount < 30) return res.status(400).json({ error: 'At least 30p.' });
      if (!/^tok_\w{4,}$/.test(token)) return res.status(400).json({ error: 'Google Pay gave no card.' });
      const pi = await client.createWalletPayment(row.account_id, {
        amountMinor: amount,
        token,
        reference: req.body.reference ? String(req.body.reference).slice(0, 80) : undefined,
        description: 'Vesopa Go, Google Pay',
      }, client.optsFor(row));
      if (pi.status === 'succeeded') return res.status(201).json({ id: pi.id, status: pi.status });
      await client.cancelPayment(row.account_id, pi.id, client.optsFor(row)).catch(() => {});
      res.status(402).json({ error: 'The bank wants a check Go cannot show. Nothing was taken. Use another way to pay.' });
    } catch (e) { fail(res, e, next); }
  });

  router.get('/till/stripe/payments/:id', terminal, async (req, res, next) => {
    try {
      const row = await settingsFor(req.office);
      if (!row || !row.account_id) return res.status(404).json({ error: 'No Stripe account.' });
      const pi = await client.retrievePayment(row.account_id, req.params.id, client.optsFor(row));
      // The bank's answer, so Go shows a decline even when the phone's own
      // Stripe software never reports it (2026-11-08, Kitchen iPhone 12).
      const e = pi.last_payment_error || null;
      res.json({
        id: pi.id, status: pi.status, amount_minor: pi.amount, amount_received: pi.amount_received,
        charge: typeof pi.latest_charge === 'string' ? pi.latest_charge : (pi.latest_charge && pi.latest_charge.id) || null,
        error: e ? { code: e.code || null, decline_code: e.decline_code || null, message: e.message || null, charge: e.charge || null } : null,
      });
    } catch (e) { fail(res, e, next); }
  });

  router.post('/till/stripe/payments/:id/cancel', terminal, async (req, res, next) => {
    try {
      const row = await settingsFor(req.office);
      if (!row || !row.account_id) return res.status(404).json({ error: 'No Stripe account.' });
      const pi = await client.cancelPayment(row.account_id, req.params.id, client.optsFor(row));
      res.json({ id: pi.id, status: pi.status });
    } catch (e) { fail(res, e, next); }
  });

  // ---- Card readers (an iPad, or any device the venue sends to a reader) -------

  const readerView = (r) => ({
    id: r.id,
    label: r.label || r.serial_number || r.id,
    device_type: r.device_type,
    status: r.status,
    simulated: String(r.device_type || '').startsWith('simulated'),
  });

  router.get('/till/stripe/readers', terminal, async (req, res, next) => {
    try {
      const row = await tapReady(req, res);
      if (!row) return;
      const list = await client.listReaders(row.account_id, row.location_id, client.optsFor(row));
      res.json({ environment: client.environmentOf(row.environment), readers: (list.data || []).map(readerView) });
    } catch (e) { fail(res, e, next); }
  });

  /**
   * Add a reader at the venue's location: the code its screen shows, or, in a
   * sandbox only, Stripe's simulated reader. Go asks a manager first.
   */
  router.post('/till/stripe/readers', terminal, async (req, res, next) => {
    try {
      const row = await tapReady(req, res);
      if (!row) return;
      const b = req.body || {};
      const simulated = b.simulated === true;
      if (simulated && client.environmentOf(row.environment) === 'live') {
        return res.status(400).json({ error: 'A simulated reader is for the sandbox only.' });
      }
      const code = simulated ? 'simulated-wpe' : String(b.registration_code || '').trim();
      if (!code) return res.status(400).json({ error: 'Type the code the reader shows.' });
      const r = await client.registerReader(row.account_id, {
        code,
        label: String(b.label || (simulated ? 'Test reader' : '')).slice(0, 60),
        location: row.location_id,
      }, client.optsFor(row));
      res.status(201).json(readerView(r));
    } catch (e) { fail(res, e, next); }
  });

  router.post('/till/stripe/reader-payments', terminal, async (req, res, next) => {
    try {
      const row = await tapReady(req, res);
      if (!row) return;
      const b = req.body || {};
      const reader = String(b.reader || '');
      if (!reader.startsWith('tmr_')) return res.status(400).json({ error: 'Which reader?' });
      const amount = Math.round(Number(b.amount_minor));
      if (!Number.isInteger(amount) || amount < 30) return res.status(400).json({ error: 'At least 30p.' });
      const pi = await client.createTerminalPayment(row.account_id, {
        amountMinor: amount,
        reference: b.reference ? String(b.reference).slice(0, 80) : undefined,
        description: b.description ? String(b.description).slice(0, 200) : 'Vesopa Go, card reader',
      }, client.optsFor(row));
      try {
        await client.processOnReader(row.account_id, reader, pi.id, client.optsFor(row));
      } catch (e) {
        await client.cancelPayment(row.account_id, pi.id, client.optsFor(row)).catch(() => {});
        throw e;
      }
      res.status(201).json({ id: pi.id, reader });
    } catch (e) { fail(res, e, next); }
  });

  router.get('/till/stripe/reader-payments/:id', terminal, async (req, res, next) => {
    try {
      const row = await settingsFor(req.office);
      if (!row || !row.account_id) return res.status(404).json({ error: 'No Stripe account.' });
      const pi = await client.retrievePayment(row.account_id, req.params.id, client.optsFor(row));
      const reader = req.query.reader ? await client.retrieveReader(row.account_id, String(req.query.reader), client.optsFor(row)).catch(() => null) : null;
      res.json({ id: pi.id, ...client.readerState(pi, reader) });
    } catch (e) { fail(res, e, next); }
  });

  /** Stop it on the reader, then the payment. Once the card is in, Stripe finishes it. */
  router.post('/till/stripe/reader-payments/:id/cancel', terminal, async (req, res, next) => {
    try {
      const row = await settingsFor(req.office);
      if (!row || !row.account_id) return res.status(404).json({ error: 'No Stripe account.' });
      const reader = String((req.body && req.body.reader) || '');
      if (reader) await client.cancelReaderAction(row.account_id, reader, client.optsFor(row)).catch(() => {});
      try {
        const pi = await client.cancelPayment(row.account_id, req.params.id, client.optsFor(row));
        res.json({ id: pi.id, state: pi.status === 'canceled' ? 'cancelled' : 'pending' });
      } catch (e) {
        res.json({ id: req.params.id, state: 'pending', cancel_refused: true });
      }
    } catch (e) { fail(res, e, next); }
  });

  /** Sandbox only: the simulated reader is handed Stripe's test card. */
  router.post('/till/stripe/readers/:id/present', terminal, async (req, res, next) => {
    try {
      const row = await settingsFor(req.office);
      if (!row || !row.account_id) return res.status(404).json({ error: 'No Stripe account.' });
      if (client.environmentOf(row.environment) === 'live') return res.status(400).json({ error: 'Sandbox only.' });
      const card = String((req.body && req.body.card) || 'approved');
      if (!client.TEST_CARDS[card]) return res.status(400).json({ error: 'Which test card?' });
      await client.presentTestCard(row.account_id, req.params.id, { ...client.optsFor(row), card });
      res.json({ ok: true, card });
    } catch (e) { fail(res, e, next); }
  });

  router.post('/till/stripe/refunds', terminal, async (req, res, next) => {
    try {
      const row = await settingsFor(req.office);
      if (!row || !row.account_id) return res.status(404).json({ error: 'No Stripe account.' });
      const b = req.body || {};
      if (!b.payment_intent) return res.status(400).json({ error: 'Which payment?' });
      const r = await client.refund(row.account_id, {
        paymentIntent: String(b.payment_intent),
        amountMinor: b.amount_minor ? Math.round(Number(b.amount_minor)) : undefined,
        reference: b.reference ? String(b.reference).slice(0, 80) : undefined,
      }, client.optsFor(row));
      res.status(201).json({ id: r.id, status: r.status, amount_minor: r.amount });
    } catch (e) { fail(res, e, next); }
  });

  // ---- Webhook -------------------------------------------------------------------

  /**
   * Stripe's events, signature-checked against STRIPE_WEBHOOK_SECRET over
   * the raw body (server.js keeps req.rawBody). An account event re-reads
   * that venue's capabilities, so Stripe switches on the moment it is allowed.
   */
  router.post('/stripe/webhook', async (req, res) => {
    // The sandbox endpoint and the live one (2026-11-08) sign with their own secrets.
    const sig = req.get('Stripe-Signature');
    const ok = [process.env.STRIPE_WEBHOOK_SECRET, process.env.STRIPE_LIVE_WEBHOOK_SECRET]
      .some((sec) => sec && stripe.verifyWebhook(req.rawBody, sig, sec));
    if (!ok) return res.status(400).json({ error: 'Bad signature' });
    const event = req.body || {};
    try {
      const accountId = event.account
        || (event.related_object && event.related_object.id)
        || (event.data && event.data.object && event.data.object.object === 'account' && event.data.object.id);
      if (accountId && /account|capability|requirements/.test(String(event.type || ''))) {
        await ensure();
        const [[row]] = await pool.query('SELECT * FROM epos_stripe_settings WHERE account_id = ?', [accountId]);
        if (row) {
          await refresh(row.office, row);
          broadcast({ type: 'till-settings' }, { office: row.office });
        }
      }
      // A payment or a reader moved on (2026-11-07): told to the venue's tills
      // and Go at once, so a decline, a retry or a refund shows without waiting
      // for the next poll. The payment's own status still decides a sale.
      const what = String(event.type || '');
      // An event on Vesopa's own account (no event.account) belongs to the
      // venue that takes payments there in that mode, when there is one.
      let owner = event.account || null;
      if (!owner && /^(payment_intent\.|charge\.refunded|terminal\.reader\.action_)/.test(what)) {
        await ensure();
        const [rows] = await pool.query('SELECT office FROM epos_stripe_settings WHERE account_id = ? AND environment = ?',
          [client.PLATFORM, event.livemode ? 'live' : 'sandbox']);
        if (rows.length === 1) owner = { office: rows[0].office };
      }
      if (owner && /^(payment_intent\.|charge\.refunded|terminal\.reader\.action_)/.test(what)) {
        await ensure();
        const [[row]] = typeof owner === 'object' ? [[owner]]
          : await pool.query('SELECT office FROM epos_stripe_settings WHERE account_id = ?', [owner]);
        const obj = (event.data && event.data.object) || {};
        if (row) {
          broadcast({
            type: 'stripe-payment',
            event: what,
            id: obj.object === 'terminal.reader'
              ? (obj.action && obj.action.process_payment_intent && obj.action.process_payment_intent.payment_intent) || null
              : obj.payment_intent || obj.id || null,
            reader: obj.object === 'terminal.reader' ? obj.id : null,
            status: obj.status || null,
            message: (obj.last_payment_error && obj.last_payment_error.message)
              || (obj.action && obj.action.failure_message) || null,
          }, { office: row.office });
        }
      }
    } catch (e) {
      console.error('stripe webhook', e && e.message);
    }
    res.json({ received: true });
  });

  return router;
}

module.exports = { stripeRoutes };
