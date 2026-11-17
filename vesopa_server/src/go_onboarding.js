/**
 * Signing a new venue up for Vesopa Go, from the app or go.vesopa.com
 * (owner, 2026-11-17): "a customer registration flow with verification
 * customer and business and amount mainly using stripe connect ... proper
 * identity verification".
 *
 * The steps, the same in Go and on the website:
 *
 *   1. account   a Vesopa account (Continue with Vesopa), which makes the venue
 *                (tap.js /api/tap/register in Go; /api/go/onboarding/web/* here)
 *   2. business  the kind of business (sole trader, company, partnership or
 *                LLP, club / charity / non-profit), its legal name, expected
 *                monthly card takings and average sale
 *   3. identity  the owner's photo ID and a live selfie, Stripe Identity, on
 *                Vesopa's own Stripe account
 *   4. stripe    the venue's connected account (v2, Express dashboard, Stripe
 *                holds losses; connect-recommend-plan.md): Stripe checks the
 *                business, its directors and owners, and the bank account it
 *                pays out to (Connect onboarding, native in Go, embedded on
 *                the website)
 *   5. licence   a card for Vesopa's licence: 14 days free, then £29 a month,
 *                as a Billing subscription on Vesopa's account
 *
 * Until every check has passed the venue runs in test mode, and once Stripe
 * lets it take cards, live card payments are capped at £250 a payment and
 * £1,000 a day (owner, 2026-11-17). Venues that did not sign up here (no row
 * in go_onboarding) are never capped.
 *
 * Stripe is the new venue's card provider by default: Tap to Pay and online
 * payments are switched to Stripe when its account is made. Dojo and Teya can
 * still be chosen in the back office.
 */
'use strict';

const express = require('express');
const jwt = require('jsonwebtoken');

const stripe = require('./stripe_client');
const { TILL_COLUMNS, STANDARD_GROUPS } = require('./permissions');

const LIMITS = { per_payment_minor: 25000, per_day_minor: 100000 };
const LICENCE = {
  lookup_key: 'vesopa_go_licence_gbp_2900_month',
  amount_minor: 2900,
  currency: 'gbp',
  interval: 'month',
  trial_days: 14,
  product_name: 'Vesopa Go licence',
};

/** Business kinds the sign-up offers, and how Stripe's v2 accounts name them. */
const BUSINESS_TYPES = {
  sole_trader: { label: 'Sole trader', entity_type: 'individual' },
  company: { label: 'Limited company', entity_type: 'company', structure: 'private_company' },
  partnership: { label: 'Partnership', entity_type: 'company', structure: 'general_partnership' },
  llp: { label: 'Limited liability partnership (LLP)', entity_type: 'company', structure: 'limited_liability_partnership' },
  non_profit: { label: 'Club, charity or non-profit', entity_type: 'non_profit' },
};

const IDENTITY_DONE = 'verified';
const LICENCE_OK = new Set(['trialing', 'active']);

class OnboardingError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const today = () => {
  const d = new Date();
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000);
};

// ---- Stripe calls only this module makes ----------------------------------------

/** Owner's ID and live selfie, on Vesopa's own account. */
function createIdentitySession({ office, email, returnUrl }, opts = {}) {
  return stripe.call('POST', '/v1/identity/verification_sessions', {
    ...opts,
    body: {
      type: 'document',
      options: {
        document: {
          allowed_types: ['driving_license', 'passport', 'id_card'],
          require_live_capture: true,
          require_matching_selfie: true,
          require_id_number: false,
        },
      },
      provided_details: email ? { email } : undefined,
      metadata: { office, purpose: 'vesopa_go_owner' },
      return_url: returnUrl || undefined,
    },
  });
}

function retrieveIdentitySession(id, opts = {}) {
  return stripe.call('GET', `/v1/identity/verification_sessions/${encodeURIComponent(id)}`, opts);
}

/** What Stripe's mobile Identity sheet needs besides the session id. */
function identityEphemeralKey(sessionId, opts = {}) {
  return stripe.call('POST', '/v1/ephemeral_keys', { ...opts, body: { verification_session: sessionId } });
}

/** The licence price, found by its lookup key or made once. */
async function licencePrice(opts = {}) {
  const found = await stripe.call('GET', `/v1/prices?active=true&limit=1&lookup_keys[0]=${LICENCE.lookup_key}`, opts);
  if (found && found.data && found.data[0]) return found.data[0].id;
  const product = await stripe.call('POST', '/v1/products', {
    ...opts,
    idempotencyKey: `vesopa-go-licence-product-${LICENCE.lookup_key}`,
    body: { name: LICENCE.product_name, metadata: { vesopa: 'go_licence' } },
  });
  const price = await stripe.call('POST', '/v1/prices', {
    ...opts,
    idempotencyKey: `vesopa-go-licence-price-${LICENCE.lookup_key}`,
    body: {
      product: product.id,
      currency: LICENCE.currency,
      unit_amount: LICENCE.amount_minor,
      recurring: { interval: LICENCE.interval },
      lookup_key: LICENCE.lookup_key,
      transfer_lookup_key: true,
    },
  });
  return price.id;
}

function createCustomer({ office, name }, opts = {}) {
  return stripe.call('POST', '/v1/customers', {
    ...opts,
    idempotencyKey: `vesopa-go-customer-${office}`,
    body: { email: office, name: name || undefined, metadata: { office, purpose: 'vesopa_go_licence' } },
  });
}

/** 14 days free, card collected now through the subscription's SetupIntent. */
function createLicence({ customer, price, office }, opts = {}) {
  return stripe.call('POST', '/v1/subscriptions', {
    ...opts,
    idempotencyKey: `vesopa-go-licence-${office}-${customer}`,
    body: {
      customer,
      items: [{ price }],
      trial_period_days: LICENCE.trial_days,
      payment_behavior: 'default_incomplete',
      payment_settings: { save_default_payment_method: 'on_subscription', payment_method_types: ['card'] },
      trial_settings: { end_behavior: { missing_payment_method: 'cancel' } },
      metadata: { office, purpose: 'vesopa_go_licence' },
      expand: ['pending_setup_intent'],
    },
  });
}

function retrieveLicence(id, opts = {}) {
  return stripe.call('GET', `/v1/subscriptions/${encodeURIComponent(id)}?expand[0]=pending_setup_intent`, opts);
}

/** Card money taken today on the venue's account, for the daily cap. */
async function takenToday(account, opts = {}) {
  let total = 0;
  let after = null;
  for (let page = 0; page < 20; page += 1) {
    const q = `limit=100&created[gte]=${today()}${after ? `&starting_after=${after}` : ''}`;
    const list = await stripe.call('GET', `/v1/payment_intents?${q}`, { ...opts, account });
    for (const pi of list.data || []) {
      if (pi.status === 'succeeded') total += Number(pi.amount_received || pi.amount || 0);
      else if (pi.status === 'processing' || pi.status === 'requires_capture') total += Number(pi.amount || 0);
    }
    if (!list.has_more || !list.data || !list.data.length) break;
    after = list.data[list.data.length - 1].id;
  }
  return total;
}

const defaultClient = {
  createIdentitySession,
  retrieveIdentitySession,
  identityEphemeralKey,
  licencePrice,
  createCustomer,
  createLicence,
  retrieveLicence,
  takenToday,
};

// ---- The routes -------------------------------------------------------------------

/**
 * @param {object} o
 * @param o.pool             the back office's database
 * @param o.secret           the JWT secret (terminal and onboarding tokens)
 * @param o.stripeSettings   the Stripe module's helpers: settingsFor, save, refresh
 * @param o.createVenue      tap.js's venue maker, for website sign-ups
 * @param o.verifyIdToken    Vesopa Auth ID tokens (terminal_vesopa.verifyTillToken)
 * @param o.goClient         () => { issuer, clientId } of Go's Vesopa Auth client
 */
function goOnboardingRoutes({
  pool, secret, stripeSettings, createVenue, verifyIdToken, goClient,
  client = {}, stripeClient = stripe, fetchImpl = fetch, broadcast = () => {},
}) {
  client = { ...defaultClient, ...client };
  const sc = { ...stripe, ...stripeClient };
  const router = express.Router();

  let ready = null;
  function ensure() {
    ready ||= pool.query(`CREATE TABLE IF NOT EXISTS go_onboarding (
        office VARCHAR(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL PRIMARY KEY,
        business_type VARCHAR(24) NULL,
        legal_name VARCHAR(190) NULL,
        expected_monthly_minor INT NULL,
        average_sale_minor INT NULL,
        identity_session VARCHAR(64) NULL,
        identity_status VARCHAR(24) NULL,
        identity_error VARCHAR(255) NULL,
        customer_id VARCHAR(64) NULL,
        subscription_id VARCHAR(64) NULL,
        licence_status VARCHAR(24) NULL,
        trial_end DATETIME NULL,
        environment VARCHAR(12) NULL,
        source VARCHAR(12) NULL,
        owner_pin_set TINYINT(1) NOT NULL DEFAULT 0,
        identity_env VARCHAR(12) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`)
      // A table made before the owner's PIN (2026-11-17) gets the column.
      .then(() => pool.query('ALTER TABLE go_onboarding ADD COLUMN owner_pin_set TINYINT(1) NOT NULL DEFAULT 0').catch(() => {}))
      .then(() => pool.query('ALTER TABLE go_onboarding ADD COLUMN identity_env VARCHAR(12) NULL').catch(() => {}))
      .catch((e) => { ready = null; throw e; });
    return ready;
  }

  async function rowFor(office) {
    await ensure();
    const [[row]] = await pool.query('SELECT * FROM go_onboarding WHERE office = ?', [office]);
    return row || null;
  }

  async function save(office, fields) {
    await ensure();
    const cols = Object.keys(fields);
    const marks = cols.map(() => '?').join(', ');
    const sets = cols.map((c) => `${c} = VALUES(${c})`).join(', ');
    await pool.query(
      `INSERT INTO go_onboarding (office, ${cols.join(', ')}) VALUES (?, ${marks}) ON DUPLICATE KEY UPDATE ${sets}`,
      [office, ...cols.map((c) => fields[c])]);
  }

  /** Which Stripe (sandbox or live) this venue's sign-up runs in. */
  const envOf = (row, stripeRow) => (stripeRow && stripeRow.environment) || (row && row.environment) || sc.environment();
  const optsOf = (env) => ({ key: sc.keyFor(env) });

  /**
   * The owner's identity is checked on Vesopa's live Stripe account, where
   * Identity's native SDKs and Synthetic Identity Protection are switched on
   * (owner, 2026-11-17: "use the live SDK as there synthetic identity is
   * enabled"), whichever mode the venue's payments are in. A real document
   * and selfie are needed. GO_IDENTITY_ENV=sandbox in .env sends checks to
   * the sandbox instead; without live keys on the server they stay there.
   */
  const identityEnv = () => {
    const wanted = String(process.env.GO_IDENTITY_ENV || 'live').toLowerCase();
    return wanted === 'live' && sc.configuredFor('live') ? 'live' : null;
  };
  const identityEnvOf = (row, fallback) => (row && row.identity_env) || identityEnv() || fallback;

  // ---- Who is asking ----

  /** A Go phone (terminal token) or the website (onboarding token). */
  function who(req, res, next) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Sign in with Vesopa first.' });
    let claims;
    try {
      claims = jwt.verify(token, secret);
    } catch {
      return res.status(401).json({ error: 'Your sign-in has expired. Sign in with Vesopa again.' });
    }
    if ((claims.scope !== 'terminal' && claims.scope !== 'go-onboarding') || !claims.office) {
      return res.status(401).json({ error: 'Sign in with Vesopa first.' });
    }
    req.office = claims.office;
    req.onboardingSource = claims.scope === 'terminal' ? 'app' : 'web';
    next();
  }

  const onboardingToken = (office, name) => jwt.sign({ scope: 'go-onboarding', office, name }, secret, { expiresIn: '6h' });

  const fail = (res, e, next) => {
    if (e instanceof OnboardingError) return res.status(e.status).json({ error: e.message, ...e.extra });
    if (e instanceof stripe.StripeError) {
      return res.status(e.status >= 500 ? 502 : e.status === 401 ? 502 : e.status).json({ error: e.message, code: e.code });
    }
    return next(e);
  };

  // ---- Status ----

  async function status(office, { refresh = false } = {}) {
    let row = await rowFor(office);
    let stripeRow = await stripeSettings.settingsFor(office);
    const env = envOf(row, stripeRow);
    if (refresh && stripeRow && stripeRow.account_id) {
      stripeRow = await stripeSettings.refresh(office, stripeRow).catch(() => stripeRow);
    }
    if (refresh && row && row.identity_session && row.identity_status !== IDENTITY_DONE) {
      const s = await client.retrieveIdentitySession(row.identity_session, optsOf(identityEnvOf(row, env))).catch(() => null);
      if (s) {
        await save(office, identityFields(s));
        row = await rowFor(office);
      }
    }
    if (refresh && row && row.subscription_id) {
      const sub = await client.retrieveLicence(row.subscription_id, optsOf(env)).catch(() => null);
      if (sub) {
        await save(office, licenceFields(sub));
        row = await rowFor(office);
      }
    }
    return view(row, stripeRow);
  }

  function view(row, stripeRow) {
    const r = row || {};
    const s = stripeRow || {};
    const card = s.card_payments || 'inactive';
    const payouts = s.payouts || 'inactive';
    const steps = {
      business: Boolean(r.business_type && r.legal_name && r.expected_monthly_minor && r.average_sale_minor),
      identity: r.identity_status || 'not_started',
      stripe: !s.account_id ? 'not_started'
        : card === 'active' && payouts === 'active' && !Number(s.requirements_due) ? 'complete'
          : card === 'active' ? 'more_needed' : 'in_review',
      bank: payouts === 'active' ? 'verified' : 'not_verified',
      licence: r.licence_status || 'not_started',
    };
    const verified = steps.business && steps.identity === IDENTITY_DONE && steps.stripe === 'complete'
      && steps.bank === 'verified' && LICENCE_OK.has(steps.licence);
    const mode = card !== 'active' ? 'test' : verified ? 'live' : 'capped';
    const next = !steps.business ? 'business'
      : steps.identity !== IDENTITY_DONE && steps.identity !== 'processing' ? 'identity'
        : steps.stripe === 'not_started' || steps.stripe === 'more_needed' || (steps.stripe === 'in_review' && Number(s.requirements_due)) ? 'stripe'
          : !LICENCE_OK.has(steps.licence) ? 'licence' : null;
    // Nothing left for the owner to do (Stripe may still be reviewing): then
    // the owner's manager PIN, and only after that Go's EPOS and the other
    // modes (owner, 2026-11-17).
    const complete = Boolean(row) && next === null;
    return {
      signed_up: Boolean(row),
      complete,
      owner_pin_set: Boolean(Number(r.owner_pin_set)),
      ready_to_use: complete && Boolean(Number(r.owner_pin_set)),
      steps,
      next,
      mode,
      verified,
      limits: mode === 'live' ? null : LIMITS,
      business: {
        type: r.business_type || null,
        legal_name: r.legal_name || null,
        expected_monthly_minor: r.expected_monthly_minor || null,
        average_sale_minor: r.average_sale_minor || null,
      },
      identity_error: r.identity_status === 'requires_input' ? r.identity_error || 'Stripe could not check that ID. Try again with a clear photo.' : null,
      requirements_due: Number(s.requirements_due) || 0,
      licence: {
        status: r.licence_status || null,
        trial_end: r.trial_end || null,
        amount_minor: LICENCE.amount_minor,
        trial_days: LICENCE.trial_days,
      },
      environment: envOf(r, s),
      business_types: Object.entries(BUSINESS_TYPES).map(([id, b]) => ({ id, label: b.label })),
    };
  }

  function identityFields(s) {
    const err = s.last_error || null;
    return {
      identity_session: s.id,
      identity_status: s.status === 'canceled' ? 'canceled' : s.status,
      identity_error: err ? String(err.reason || err.code || '').slice(0, 255) || null : null,
    };
  }

  /**
   * A trial subscription is "trialing" the moment it is made, card or not, so
   * the licence counts as set up only once a card is saved on it (owner,
   * 2026-11-17: "card not added but passed to the next screen").
   */
  function licenceFields(sub) {
    const si = sub.pending_setup_intent;
    const saved = Boolean(sub.default_payment_method)
      || (si && typeof si === 'object' && si.status === 'succeeded');
    let status = sub.status;
    if ((status === 'trialing' || status === 'active' || status === 'incomplete') && !saved) status = 'card_needed';
    else if (status === 'incomplete' && saved) status = 'trialing';
    return {
      subscription_id: sub.id,
      licence_status: status,
      trial_end: sub.trial_end ? new Date(sub.trial_end * 1000) : null,
    };
  }

  router.get('/go/onboarding', who, async (req, res, next) => {
    try { res.json(await status(req.office, { refresh: Boolean(req.query.refresh) })); } catch (e) { fail(res, e, next); }
  });

  // ---- 2. The business ----

  router.put('/go/onboarding/business', who, express.json(), async (req, res, next) => {
    try {
      const b = req.body || {};
      const type = String(b.business_type || '');
      if (!BUSINESS_TYPES[type]) throw new OnboardingError(400, 'Choose what kind of business this is.');
      const legal = String(b.legal_name || '').trim().replace(/\s+/g, ' ').slice(0, 190);
      if (legal.length < 2) throw new OnboardingError(400, type === 'sole_trader'
        ? 'Give your full legal name, as it is on your ID.' : 'Give the business\'s registered name.');
      const monthly = Math.round(Number(b.expected_monthly_minor));
      const average = Math.round(Number(b.average_sale_minor));
      if (!Number.isInteger(monthly) || monthly < 100 || monthly > 1e11) throw new OnboardingError(400, 'Give the card takings you expect in a month.');
      if (!Number.isInteger(average) || average < 50 || average > 1e9) throw new OnboardingError(400, 'Give your average sale.');
      if (average > monthly) throw new OnboardingError(400, 'The average sale cannot be more than a month\'s takings.');
      const stripeRow = await stripeSettings.settingsFor(req.office);
      if (stripeRow && stripeRow.account_id) {
        const had = await rowFor(req.office);
        if (had && had.business_type && had.business_type !== type) {
          throw new OnboardingError(409, 'Stripe is already checking this business as another kind. Contact Vesopa support to change it.');
        }
      }
      await save(req.office, {
        business_type: type, legal_name: legal, expected_monthly_minor: monthly, average_sale_minor: average,
        source: req.onboardingSource, environment: envOf(null, stripeRow),
      });
      res.json(await status(req.office));
    } catch (e) { fail(res, e, next); }
  });

  // ---- 3. The owner's identity ----

  router.post('/go/onboarding/identity', who, express.json(), async (req, res, next) => {
    try {
      const row = await rowFor(req.office);
      if (!row || !row.business_type) throw new OnboardingError(409, 'Tell us about the business first.');
      if (row.identity_status === IDENTITY_DONE) throw new OnboardingError(409, 'Your identity is already verified.');
      const env = identityEnv() || envOf(row, await stripeSettings.settingsFor(req.office));
      const opts = optsOf(env);
      // A session waiting for its first try is used again rather than starting
      // over, if it was made in the same Stripe mode.
      let s = null;
      if (row.identity_session && (row.identity_env || null) === env
        && (row.identity_status === 'requires_input' || !row.identity_status)) {
        s = await client.retrieveIdentitySession(row.identity_session, opts).catch(() => null);
        if (s && (s.status !== 'requires_input' || s.last_error)) s = null;
      }
      if (!s) {
        const returnUrl = /^https:\/\//.test(String((req.body || {}).return_url || '')) ? req.body.return_url : null;
        s = await client.createIdentitySession({ office: req.office, email: req.office, returnUrl }, opts);
      }
      await save(req.office, { ...identityFields(s), identity_env: env });
      const answer = {
        id: s.id,
        client_secret: s.client_secret,
        url: s.url || null,
        publishable_key: sc.publishableFor(env),
      };
      if ((req.body || {}).mobile) {
        const k = await client.identityEphemeralKey(s.id, opts);
        answer.ephemeral_key_secret = k.secret;
      }
      res.status(201).json(answer);
    } catch (e) { fail(res, e, next); }
  });

  // ---- 4. Stripe: the business, its people and its bank ----

  router.post('/go/onboarding/stripe', who, async (req, res, next) => {
    try {
      const row = await rowFor(req.office);
      if (!row || !row.business_type) throw new OnboardingError(409, 'Tell us about the business first.');
      let stripeRow = await stripeSettings.settingsFor(req.office);
      if (stripeRow && stripeRow.account_id === sc.PLATFORM) {
        throw new OnboardingError(409, 'This venue takes payments into Vesopa\'s own Stripe account; there is nothing to verify.');
      }
      if (!stripeRow || !stripeRow.account_id) {
        const [[venue]] = await pool.query('SELECT name FROM offices WHERE contact_email = ?', [req.office]);
        const kind = BUSINESS_TYPES[row.business_type];
        const acct = await createAccountWithDetails({
          email: req.office,
          name: (venue && venue.name) || row.legal_name,
          kind,
          legal: row.legal_name,
          monthly: row.expected_monthly_minor,
        }, optsOf(sc.environment()));
        const s = sc.readiness(acct);
        // Stripe is the new venue's card provider (owner, 2026-11-17).
        await stripeSettings.save(req.office, {
          account_id: acct.id, environment: sc.environment(), enabled: 1, use_tap: 1, use_online: 1,
          card_payments: s.card_payments, payouts: s.payouts, requirements_due: s.requirements_due,
        });
        await save(req.office, { environment: sc.environment() });
        stripeRow = await stripeSettings.settingsFor(req.office);
        broadcast({ type: 'till-settings' }, { office: req.office });
      }
      const session = await sc.onboardingSession(stripeRow.account_id, optsOf(stripeRow.environment));
      res.status(201).json({
        account: stripeRow.account_id,
        client_secret: session.client_secret,
        publishable_key: sc.publishableFor(stripeRow.environment),
      });
    } catch (e) { fail(res, e, next); }
  });

  /**
   * The v2 account with what the venue has told us, so Stripe asks for less.
   * If Stripe refuses one of those details, the account is made without them
   * and Stripe's own onboarding asks for them instead.
   */
  async function createAccountWithDetails({ email, name, kind, legal, monthly }, opts) {
    const identity = { country: 'gb', entity_type: kind.entity_type };
    if (kind.entity_type === 'individual') {
      const parts = String(legal).split(' ');
      if (parts.length > 1) identity.individual = { given_name: parts.slice(0, -1).join(' '), surname: parts[parts.length - 1] };
    } else {
      identity.business_details = { registered_name: legal };
      if (kind.structure) identity.business_details.structure = kind.structure;
      if (monthly) identity.business_details.annual_revenue = { amount: { value: monthly * 12, currency: 'gbp' } };
    }
    // No Stripe dashboard (owner, 2026-11-17: verify "without the Stripe
    // webpage opening"): Stripe still checks the business (it holds the
    // losses, so it collects the requirements), but an account without a
    // dashboard needs no Stripe sign-in, so its onboarding stays inside Go.
    // The venue sees its payments and payouts in the Vesopa back office.
    const dashboard = 'none';
    try {
      return await sc.createAccount({ email, name, identity, dashboard }, opts);
    } catch (e) {
      if (e instanceof stripe.StripeError && e.status === 400) return sc.createAccount({ email, name, dashboard }, opts);
      throw e;
    }
  }

  // ---- 5. The licence ----

  router.post('/go/onboarding/licence', who, async (req, res, next) => {
    try {
      const row = await rowFor(req.office);
      if (!row || !row.business_type) throw new OnboardingError(409, 'Tell us about the business first.');
      if (LICENCE_OK.has(row.licence_status)) throw new OnboardingError(409, 'Your licence is already set up.', { status: row.licence_status });
      const env = envOf(row, await stripeSettings.settingsFor(req.office));
      const opts = optsOf(env);
      let sub = row.subscription_id ? await client.retrieveLicence(row.subscription_id, opts).catch(() => null) : null;
      if (sub && !['incomplete', 'trialing', 'active'].includes(sub.status)) sub = null;
      if (!sub || !sub.pending_setup_intent) {
        const [[venue]] = await pool.query('SELECT name FROM offices WHERE contact_email = ?', [req.office]);
        const customer = row.customer_id || (await client.createCustomer({ office: req.office, name: row.legal_name || (venue && venue.name) }, opts)).id;
        const price = await client.licencePrice(opts);
        sub = await client.createLicence({ customer, price, office: req.office }, opts);
        await save(req.office, { customer_id: customer, ...licenceFields(sub), licence_status: 'card_needed' });
      }
      const si = sub.pending_setup_intent;
      if (!si || typeof si !== 'object' || !si.client_secret) {
        await save(req.office, licenceFields(sub));
        return res.json({ done: true, status: await status(req.office) });
      }
      res.status(201).json({
        setup_intent_client_secret: si.client_secret,
        publishable_key: sc.publishableFor(env),
        amount_minor: LICENCE.amount_minor,
        trial_days: LICENCE.trial_days,
        merchant_name: 'Vesopa Software Ltd',
      });
    } catch (e) { fail(res, e, next); }
  });

  // ---- 6. The owner's manager PIN, once everything else is done ----

  /**
   * The person who signed up becomes the venue's first member of staff, a
   * manager, with the PIN they choose: what Go's EPOS asks for. Asked for
   * once the sign-up is complete, and before Go opens EPOS or any other mode
   * (owner, 2026-11-17). Staff, Supervisor and Manager groups are made for
   * the venue if it has none.
   */
  router.post('/go/onboarding/owner-pin', who, express.json(), async (req, res, next) => {
    try {
      const v = await status(req.office);
      if (!v.signed_up || !v.complete) throw new OnboardingError(409, 'Finish your account checks first.');
      if (v.owner_pin_set) throw new OnboardingError(409, 'Your manager PIN is already set. Change it in the back office, Staff.');
      const b = req.body || {};
      const pin = String(b.pin || '');
      const name = String(b.name || '').trim().replace(/\s+/g, ' ').slice(0, 60);
      if (!/^\d{4,6}$/.test(pin)) throw new OnboardingError(400, 'A PIN is 4 to 6 digits.');
      if (/^(\d)\1+$/.test(pin) || '0123456789'.includes(pin) || '9876543210'.includes(pin)) {
        throw new OnboardingError(400, 'Choose a PIN that is harder to guess than repeated or consecutive digits.');
      }
      if (name.length < 2) throw new OnboardingError(400, 'Give your name, as staff will see it.');
      const [[clash]] = await pool.query('SELECT clark_name FROM bo_clarks WHERE email = ? AND pin_code = ?', [req.office, pin]);
      if (clash) throw new OnboardingError(409, 'That PIN is already used by somebody at this venue. Choose another.');

      for (const group of STANDARD_GROUPS) {
        await pool.execute(
          `INSERT IGNORE INTO epos_permission_groups (email, name, sort_order, ${TILL_COLUMNS.join(', ')})
           VALUES (?, ?, ?, ${TILL_COLUMNS.map(() => '?').join(', ')})`,
          [req.office, group.name, group.sort_order, ...TILL_COLUMNS.map((c) => (group.granted.includes(c) ? 1 : 0))]);
      }
      const [[manager]] = await pool.query(
        "SELECT id FROM epos_permission_groups WHERE email = ? AND name = 'Manager' ORDER BY id LIMIT 1", [req.office]);
      if (!manager) throw new OnboardingError(500, 'The Manager group could not be made. Try again.');
      await pool.execute(
        'INSERT INTO bo_clarks (email, pluid, clark_name, pin_code, active, permission_group_id) VALUES (?, 0, ?, ?, 1, ?)',
        [req.office, name, pin, manager.id]);
      await save(req.office, { owner_pin_set: 1 });
      broadcast({ type: 'staff.updated' }, { office: req.office });
      res.status(201).json(await status(req.office));
    } catch (e) { fail(res, e, next); }
  });

  // ---- The website's sign-in: Continue with Vesopa in the browser ----

  /**
   * go.vesopa.com hands over the code Vesopa Auth gave it (PKCE, Go's own
   * client): exchanged here, server to server, so the browser never needs the
   * token endpoint. An existing venue gets an onboarding token; a new email
   * gets a short sign-up token for /web/register.
   */
  router.post('/go/onboarding/web/exchange', express.json(), async (req, res, next) => {
    try {
      const b = req.body || {};
      const redirect = String(b.redirect_uri || '');
      if (!/^https:\/\/(go\.vesopa\.com|go\.vesopaepos\.com|staging\.go\.vesopa\.com)\/signup\/?$/.test(redirect)
        && !(process.env.NODE_ENV === 'test' && /^http:\/\/127\.0\.0\.1/.test(redirect))) {
        throw new OnboardingError(400, 'That sign-in did not come from go.vesopa.com.');
      }
      const c = goClient && goClient();
      if (!c || !c.clientId) throw new OnboardingError(503, 'Continue with Vesopa is not switched on for Vesopa Go yet.');
      const r = await fetchImpl(`${c.issuer}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: String(b.code || ''),
          redirect_uri: redirect,
          client_id: c.clientId,
          code_verifier: String(b.code_verifier || ''),
        }).toString(),
      });
      const tok = await r.json().catch(() => ({}));
      if (!r.ok || !tok.id_token) throw new OnboardingError(401, 'Vesopa refused that sign-in. Try again.');
      let claims;
      try {
        claims = await verifyIdToken(tok.id_token, 'go');
      } catch {
        throw new OnboardingError(401, 'That Vesopa sign-in could not be accepted. Try again.');
      }
      const email = String(claims.email || '').trim().toLowerCase();
      if (!email || claims.email_verified === false) throw new OnboardingError(403, 'Your Vesopa account needs a confirmed email address.');
      const [[office]] = await pool.query('SELECT name, contact_email FROM offices WHERE contact_email = ?', [email]);
      if (office) return res.json({ token: onboardingToken(email, office.name), venue: office.name, email });
      res.json({
        signup_token: jwt.sign({ scope: 'go-signup', email, name: String(claims.name || '').slice(0, 120) }, secret, { expiresIn: '30m' }),
        email,
      });
    } catch (e) { fail(res, e, next); }
  });

  const webSignups = new Map(); // ip -> [times]
  router.post('/go/onboarding/web/register', express.json(), async (req, res, next) => {
    try {
      const ip = String(req.ip || '');
      const recent = (webSignups.get(ip) || []).filter((t) => Date.now() - t < 3600e3);
      if (recent.length >= 5) throw new OnboardingError(429, 'Too many new venues from here. Try again in an hour.');
      const b = req.body || {};
      let claims;
      try {
        claims = jwt.verify(String(b.signup_token || ''), secret);
      } catch {
        throw new OnboardingError(401, 'Your sign-in has expired. Sign in with Vesopa again.');
      }
      if (claims.scope !== 'go-signup' || !claims.email) throw new OnboardingError(401, 'Sign in with Vesopa first.');
      const made = await createVenue({
        email: claims.email,
        personName: claims.name,
        venueName: b.venue_name,
        businessType: b.business_type,
        postcode: b.postcode,
      });
      webSignups.set(ip, [...recent, Date.now()]);
      await save(made.email, { source: 'web' });
      res.status(201).json({ token: onboardingToken(made.email, made.name), venue: made.name, email: made.email });
    } catch (e) {
      if (e && e.status && !(e instanceof OnboardingError) && !(e instanceof stripe.StripeError)) {
        return res.status(e.status).json({ error: e.message });
      }
      fail(res, e, next);
    }
  });

  // ---- Stripe's events (called by stripe.js's verified webhook) ----

  router.onStripeEvent = async (event) => {
    const type = String((event && event.type) || '');
    const obj = (event.data && event.data.object) || {};
    if (type.startsWith('identity.verification_session.')) {
      const office = obj.metadata && obj.metadata.office;
      if (!office || (obj.metadata && obj.metadata.purpose !== 'vesopa_go_owner')) return;
      const row = await rowFor(office);
      if (!row || (row.identity_session && row.identity_session !== obj.id)) return;
      await save(office, identityFields(obj));
      broadcast({ type: 'go-onboarding' }, { office });
      return;
    }
    if (/^customer\.subscription\./.test(type) && obj.metadata && obj.metadata.purpose === 'vesopa_go_licence') {
      const office = obj.metadata.office;
      if (!office) return;
      const row = await rowFor(office);
      if (!row || (row.subscription_id && row.subscription_id !== obj.id)) return;
      await save(office, licenceFields(obj));
      broadcast({ type: 'go-onboarding' }, { office });
      return;
    }
    if (type === 'setup_intent.succeeded') {
      // The subscription's own SetupIntent carries no metadata of ours: find
      // the venue by its subscription and read it again from Stripe.
      const [rows] = await pool.query('SELECT office, subscription_id, environment FROM go_onboarding WHERE customer_id = ?', [obj.customer || '']);
      for (const row of rows) {
        if (!row.subscription_id) continue;
        const sub = await client.retrieveLicence(row.subscription_id, optsOf(row.environment || sc.environment())).catch(() => null);
        if (sub) {
          await save(row.office, licenceFields(sub));
          broadcast({ type: 'go-onboarding' }, { office: row.office });
        }
      }
    }
  };

  // ---- The caps (stripe.js asks before every live card payment) ----

  /**
   * Null when the payment may go ahead; otherwise why not. Only venues that
   * signed up here are capped, and only until every check has passed.
   */
  router.capCheck = async (office, stripeRow, amountMinor) => {
    if (!stripeRow || stripeRow.account_id === sc.PLATFORM) return null;
    const row = await rowFor(office);
    if (!row) return null;
    const v = view(row, stripeRow);
    if (v.mode !== 'capped') return null;
    if (amountMinor > LIMITS.per_payment_minor) {
      return `Until your Vesopa sign-up checks are complete, a card payment can be at most £${(LIMITS.per_payment_minor / 100).toFixed(2)}. Finish them in Vesopa Go (Settings, Account).`;
    }
    const taken = await client.takenToday(stripeRow.account_id, optsOf(stripeRow.environment));
    if (taken + amountMinor > LIMITS.per_day_minor) {
      return `Until your Vesopa sign-up checks are complete, card payments are limited to £${(LIMITS.per_day_minor / 100).toFixed(2)} a day; £${(taken / 100).toFixed(2)} has been taken today.`;
    }
    return null;
  };

  return router;
}

module.exports = { goOnboardingRoutes, LIMITS, LICENCE, BUSINESS_TYPES, OnboardingError, defaultClient };
