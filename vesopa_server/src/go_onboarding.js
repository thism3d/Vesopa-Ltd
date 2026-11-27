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
const mailer = require('./mailer');
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

/** Steps the owner may leave for later (owner, 2026-11-18): the venue stays capped. */
const SKIPPABLE = ['identity', 'stripe'];

/** Go devices a venue's 14-day trial opens (every Go mode: EPOS, Kitchen, Display, Card terminal). */
const TRIAL_GO_SEATS = 5;

/**
 * Stripe's outstanding requirements, as the few things an owner recognises.
 * Order matters: a person's ID document is "Photo ID", not "Owners".
 */
const CHECK_GROUPS = [
  ['id', 'Photo ID', /document|verification|id_number|identity_document|selfie/],
  ['people', 'Owners and directors', /person|representative|owner|director|executive|relationship|individual|dob|date_of_birth/],
  ['bank', 'Bank account for payouts', /external_account|bank|payout|sort_code|iban/],
  ['business', 'Business details', /business|company|registered|address|industry|mcc|url|website|product|tax|vat|structure|phone|name/],
  ['terms', 'Payments terms', /terms|tos|acceptance/],
];

function stripeChecklist(account, readiness) {
  const entries = (account && account.requirements && account.requirements.entries) || [];
  const textOf = (e) => [
    e.description, JSON.stringify(e.reference || {}),
    (e.requested_reasons || []).map((r) => r.code).join(' '),
  ].join(' ').toLowerCase();
  const due = {};
  let other = 0;
  let stripeReviewing = 0;
  for (const e of entries) {
    if (e.awaiting_action_from === 'stripe') { stripeReviewing += 1; continue; }
    const t = textOf(e);
    const g = CHECK_GROUPS.find(([, , re]) => re.test(t));
    if (g) due[g[0]] = (due[g[0]] || 0) + 1; else other += 1;
  }
  const rows = CHECK_GROUPS.map(([id, label]) => ({ id, label, done: !due[id], due: due[id] || 0 }));
  rows.push({ id: 'cards', label: 'Card payments switched on', done: readiness.card_payments === 'active', due: 0 });
  rows.push({ id: 'payouts', label: 'Payouts to your bank switched on', done: readiness.payouts === 'active', due: 0 });
  return { rows, other_due: other, stripe_reviewing: stripeReviewing };
}

/**
 * Stripe will not run Identity for Vesopa's account at all (its words end
 * "For more information on Stripe Identity supported use-cases and
 * locations, please see https://docs.stripe.com/identity/use-cases"). That is
 * the account's state, not the owner's ID, so the sign-up does not stop
 * there: the owner's ID is checked by Stripe in step 3, the business and bank
 * checks, which ask the owner for their photo ID as Stripe needs it. Identity
 * is asked again on every try, so it takes over the moment Stripe opens it.
 */
const IDENTITY_VIA_CONNECT = 'via_connect';
const identityRefused = (e) => {
  const m = String((e && e.message) || '');
  return /identity\/use-cases/i.test(m)
    || /(not|n't) (been )?(enabled|activated|approved|eligible|available)[^.]*identity/i.test(m)
    || /identity[^.]*(not|n't) (been )?(enabled|activated|approved|eligible|available)/i.test(m);
};
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

/**
 * Vesopa Passport's verification flow on Vesopa's live Stripe account (owner,
 * 2026-11-26, once Stripe had verified Vesopa for Identity): the ID, the live
 * selfie and the checks are set in the Dashboard on the flow, so one place
 * decides them for the app's native sheet and passport.vesopa.com alike.
 * GO_IDENTITY_FLOW in .env changes it; "none" goes back to the settings below.
 */
const PASSPORT_FLOW = 'vf_1UfR3LHxEu3jD7p0LGkrD0AQ';
const PASSPORT_RETURN = 'https://passport.vesopa.com/flow';
const identityFlow = (env) => {
  const set = String(process.env.GO_IDENTITY_FLOW || '').trim();
  if (set.toLowerCase() === 'none') return null;
  if (/^vf_[A-Za-z0-9]+$/.test(set)) return set;
  // The flow lives on the live account; the sandbox has no such flow.
  return env === 'live' ? PASSPORT_FLOW : null;
};
const noSuchFlow = (e) => e instanceof stripe.StripeError
  && /verification_flow|verification flow/i.test(String(e.message || '')) && (e.status === 400 || e.status === 404);

/** Owner's ID and live selfie, on Vesopa's own account: by the flow when there is one. */
function createIdentitySession({ office, email, returnUrl, flow }, opts = {}) {
  if (flow) {
    return stripe.call('POST', '/v1/identity/verification_sessions', {
      ...opts,
      body: {
        verification_flow: flow,
        provided_details: email ? { email } : undefined,
        client_reference_id: office ? String(office).slice(0, 200) : undefined,
        metadata: { office, purpose: 'vesopa_go_owner' },
        return_url: returnUrl || PASSPORT_RETURN,
      },
    });
  }
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
      return_url: returnUrl || PASSPORT_RETURN,
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

/** The welcome email: plain and HTML, in Vesopa's colours. */
function welcomeEmail({ name, endText, later = [], capped }) {
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const lines = [
    `Welcome to Vesopa Go, ${name}.`,
    '',
    `Your account is set up${endText ? ` and your 14 days free run until ${endText}` : ''}. After that it is £29 a month; cancel any time in the back office.`,
    '',
    'What is open now:',
    '- Vesopa Go EPOS on your phones and tablets',
    '- Kitchen screen and customer display on any screen or TV (Settings, Connect a screen or TV)',
    '- Card terminal: take card payments sent from a till',
    '',
    ...(later.length ? [`Still to do: ${later.join(' and ')}. Open Vesopa Go, Account checks.`, ''] : []),
    ...(capped ? ['Until Stripe has finished its checks, card payments are limited to £250 a payment and £1,000 a day.', ''] : []),
    'Your menu, staff, reports and settings are in the back office: https://backoffice.vesopaepos.com',
    '',
    'Questions? Reply to this email or write to support@vesopa.com.',
    '',
    'Vesopa Software Ltd',
  ];
  const li = (t) => `<li style="margin:4px 0">${esc(t)}</li>`;
  const html = `<!doctype html><html><body style="margin:0;background:#0B0E0A;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#F2F5EE">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#0B0E0A;padding:32px 12px"><tr><td align="center">
<table role="presentation" width="560" cellspacing="0" cellpadding="0" style="max-width:560px;background:#171B15;border-radius:20px;padding:32px">
<tr><td>
<div style="display:inline-block;background:#B6E62E;color:#0B0E0A;font-weight:800;border-radius:12px;padding:8px 14px;font-size:15px">Vesopa Go</div>
<h1 style="font-size:26px;margin:22px 0 8px;color:#FFFFFF">You're all set, ${esc(name)} 🎉</h1>
<p style="font-size:16px;line-height:1.5;color:#C9D1C2;margin:0 0 18px">Your account is set up${endText ? ` and your <b style="color:#B6E62E">14 days free</b> run until <b>${esc(endText)}</b>` : ''}. After that it is £29 a month; cancel any time in the back office.</p>
<p style="font-size:15px;font-weight:700;margin:0 0 6px">What is open now</p>
<ul style="font-size:15px;line-height:1.5;color:#C9D1C2;padding-left:20px;margin:0 0 18px">
${li('Vesopa Go EPOS on your phones and tablets')}${li('Kitchen screen and customer display on any screen or TV (Settings, Connect a screen or TV)')}${li('Card terminal: take card payments sent from a till')}
</ul>
${later.length ? `<p style="font-size:15px;line-height:1.5;background:#2A2410;border-radius:12px;padding:12px 14px;color:#F5D36B;margin:0 0 14px">Still to do: ${esc(later.join(' and '))}. Open Vesopa Go, <b>Account checks</b>.</p>` : ''}
${capped ? '<p style="font-size:14px;line-height:1.5;color:#9AA592;margin:0 0 18px">Until Stripe has finished its checks, card payments are limited to £250 a payment and £1,000 a day.</p>' : ''}
<a href="https://backoffice.vesopaepos.com" style="display:inline-block;background:#B6E62E;color:#0B0E0A;text-decoration:none;font-weight:800;border-radius:14px;padding:14px 22px;font-size:16px">Open the back office</a>
<p style="font-size:13px;color:#7D8776;margin:26px 0 0">Questions? Reply to this email or write to support@vesopa.com.<br>Vesopa Software Ltd · company number 17362206</p>
</td></tr></table></td></tr></table></body></html>`;
  return { text: lines.join('\n'), html };
}

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
  sendWelcome = (m) => (mailer.mailEnabled() ? mailer.sendMail(m) : Promise.resolve(console.warn(`[go_onboarding] mail off: welcome for ${m.to} not sent`))),
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
      // Steps left for later, the trial's Go seats and the welcome email (2026-11-18).
      .then(() => pool.query('ALTER TABLE go_onboarding ADD COLUMN skipped VARCHAR(64) NULL').catch(() => {}))
      .then(() => pool.query('ALTER TABLE go_onboarding ADD COLUMN trial_seats TINYINT(1) NOT NULL DEFAULT 0').catch(() => {}))
      .then(() => pool.query('ALTER TABLE go_onboarding ADD COLUMN welcome_sent TINYINT(1) NOT NULL DEFAULT 0').catch(() => {}))
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
    if (refresh && row && row.identity_session && row.identity_status !== IDENTITY_DONE && row.identity_status !== IDENTITY_VIA_CONNECT) {
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
    // Stripe's requirements as a checklist the owner can read, beside step 3.
    let checklist = null;
    if (refresh && stripeRow && stripeRow.account_id && sc.retrieveAccount && stripeRow.account_id !== sc.PLATFORM) {
      const acct = await sc.retrieveAccount(stripeRow.account_id, optsOf(env)).catch(() => null);
      if (acct) checklist = stripeChecklist(acct, sc.readiness(acct));
    }
    if (row) {
      await trialSeats(office, row);
      row = await rowFor(office);
    }
    const v = view(row, stripeRow);
    v.checklist = checklist;
    if (row && v.complete && !Number(row.welcome_sent)) await welcome(office, row, v);
    return v;
  }

  /**
   * The trial opens Vesopa Go for the venue (owner, 2026-11-18: "As it's a
   * trial enabled feature can we not enable the EPOS, display, kitchen"). Go
   * is opt-in (licences.js), so without a row the venue has no Go seats.
   * Written once the licence is set up; a limit a person typed (`override`)
   * or a bigger one is never lowered. A licence that has ended takes the
   * trial's seats back.
   */
  async function trialSeats(office, row) {
    const on = LICENCE_OK.has(row.licence_status);
    const ended = ['canceled', 'unpaid', 'incomplete_expired'].includes(row.licence_status);
    if (on === Boolean(Number(row.trial_seats)) && !ended) return;
    try {
      const [[had]] = await pool.query('SELECT * FROM bo_licence_limits WHERE office = ? AND kind = ?', [office, 'go']);
      if (on) {
        const status = row.licence_status === 'active' ? 'active' : 'trialing';
        if (!had) {
          await pool.query(
            `INSERT INTO bo_licence_limits (office, kind, seats, source, status, ends_at, updated_by)
             VALUES (?, 'go', ?, 'trial', ?, ?, 'go sign-up')`,
            [office, TRIAL_GO_SEATS, status, row.trial_end || null]);
        } else if (had.source !== 'override' && Number(had.seats) < TRIAL_GO_SEATS) {
          await pool.query(
            `UPDATE bo_licence_limits SET seats = ?, source = 'trial', status = ?, ends_at = ?, updated_by = 'go sign-up'
              WHERE office = ? AND kind = 'go'`,
            [TRIAL_GO_SEATS, status, row.trial_end || null, office]);
        }
        await save(office, { trial_seats: 1 });
      } else if (ended && Number(row.trial_seats)) {
        if (had && had.source === 'trial') {
          await pool.query(
            `UPDATE bo_licence_limits SET seats = 0, status = ?, updated_by = 'go sign-up' WHERE office = ? AND kind = 'go'`,
            [row.licence_status, office]);
        }
        await save(office, { trial_seats: 0 });
      }
    } catch (e) {
      // A licence table this server has not got must never stop a sign-up.
      if (e.code !== 'ER_NO_SUCH_TABLE' && e.code !== 'ER_BAD_FIELD_ERROR') throw e;
      console.warn('[go_onboarding] trial seats not written:', e.message);
    }
  }

  /** "You're set up": once, when every step is done or left for later. */
  async function welcome(office, row, v) {
    await save(office, { welcome_sent: 1 });
    try {
      const [[venue]] = await pool.query('SELECT name FROM offices WHERE contact_email = ?', [office]);
      const name = (venue && venue.name) || row.legal_name || 'your venue';
      const ends = row.trial_end ? new Date(row.trial_end) : null;
      const endText = ends && !Number.isNaN(ends.getTime())
        ? ends.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : null;
      const later = (v.skipped || []).map((s) => ({ identity: 'verify your identity', stripe: "finish Stripe's business and bank checks" }[s])).filter(Boolean);
      const mail = welcomeEmail({ name, endText, later, capped: v.mode !== 'live' });
      await sendWelcome({ to: office, subject: `Welcome to Vesopa Go, ${name}`, ...mail });
    } catch (e) {
      console.warn('[go_onboarding] welcome email not sent:', e.message);
    }
  }

  function view(row, stripeRow) {
    const r = row || {};
    const s = stripeRow || {};
    const skipped = String(r.skipped || '').split(',').filter((x) => SKIPPABLE.includes(x));
    const card = s.card_payments || 'inactive';
    const payouts = s.payouts || 'inactive';
    const steps = {
      business: Boolean(r.business_type && r.legal_name && r.expected_monthly_minor && r.average_sale_minor),
      identity: r.identity_status || 'not_started',
      // 'via_connect': Stripe checks the owner's ID in step 3 instead.
      stripe: !s.account_id ? 'not_started'
        : card === 'active' && payouts === 'active' && !Number(s.requirements_due) ? 'complete'
          : card === 'active' ? 'more_needed' : 'in_review',
      bank: payouts === 'active' ? 'verified' : 'not_verified',
      licence: r.licence_status || 'not_started',
    };
    const identityOk = steps.identity === IDENTITY_DONE
      || (steps.identity === IDENTITY_VIA_CONNECT && steps.stripe === 'complete');
    const verified = steps.business && identityOk && steps.stripe === 'complete'
      && steps.bank === 'verified' && LICENCE_OK.has(steps.licence);
    const mode = card !== 'active' ? 'test' : verified ? 'live' : 'capped';
    const identityWaits = steps.identity !== IDENTITY_DONE && steps.identity !== 'processing' && steps.identity !== IDENTITY_VIA_CONNECT;
    const stripeWaits = steps.stripe === 'not_started' || steps.stripe === 'more_needed' || (steps.stripe === 'in_review' && Number(s.requirements_due));
    // A skipped step is passed over; it stays "not done" and the venue stays capped.
    const next = !steps.business ? 'business'
      : identityWaits && !skipped.includes('identity') ? 'identity'
        : stripeWaits && !skipped.includes('stripe') ? 'stripe'
          : !LICENCE_OK.has(steps.licence) ? 'licence' : null;
    // What still needs the owner after sign-up, for Go's banner.
    const pending = [
      ...(identityWaits ? ['identity'] : []),
      ...(stripeWaits ? ['stripe'] : []),
    ];
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
      skipped,
      pending,
      mode,
      verified,
      limits: mode === 'live' ? null : LIMITS,
      business: {
        type: r.business_type || null,
        legal_name: r.legal_name || null,
        expected_monthly_minor: r.expected_monthly_minor || null,
        average_sale_minor: r.average_sale_minor || null,
      },
      identity_error: r.identity_status === 'requires_input' ? r.identity_error || 'Your ID could not be checked. Try again with a clear photo.' : null,
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
      // Starting a step left for later takes it off the list (2026-11-18).
      if (String(row.skipped || '').split(',').includes('identity')) {
        await save(req.office, { skipped: String(row.skipped).split(',').filter((x) => x && x !== 'identity').join(',') || null });
      }
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
        const flow = identityFlow(env);
        try {
          try {
            s = await client.createIdentitySession({ office: req.office, email: req.office, returnUrl, flow }, opts);
          } catch (e) {
            // A flow switched off or removed in the Dashboard: the ID check
            // still runs, with the settings it had before the flow.
            if (!flow || !noSuchFlow(e)) throw e;
            console.warn(`[go_onboarding] verification flow ${flow} refused on the ${env} account; using the built-in check:`, e.message);
            s = await client.createIdentitySession({ office: req.office, email: req.office, returnUrl }, opts);
          }
        } catch (e) {
          if (!(e instanceof stripe.StripeError) || !identityRefused(e)) throw e;
          console.warn(`[go_onboarding] Stripe refused Identity on the ${env} account; ${req.office} is checked in step 3:`, e.message);
          await save(req.office, { identity_session: null, identity_status: IDENTITY_VIA_CONNECT, identity_error: null, identity_env: env });
          return res.status(200).json({ via_connect: true, ...(await status(req.office)) });
        }
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
      if (String(row.skipped || '').split(',').includes('stripe')) {
        await save(req.office, { skipped: String(row.skipped).split(',').filter((x) => x && x !== 'stripe').join(',') || null });
      }
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

  // ---- Leaving a step for later ----

  router.post('/go/onboarding/skip', who, express.json(), async (req, res, next) => {
    try {
      const step = String((req.body || {}).step || '');
      if (!SKIPPABLE.includes(step)) throw new OnboardingError(400, 'That step cannot be left for later.');
      const row = await rowFor(req.office);
      if (!row || !row.business_type) throw new OnboardingError(409, 'Tell us about the business first.');
      const list = new Set(String(row.skipped || '').split(',').filter(Boolean));
      list.add(step);
      await save(req.office, { skipped: [...list].join(',') });
      res.json(await status(req.office));
    } catch (e) { fail(res, e, next); }
  });

  router.post('/go/onboarding/unskip', who, express.json(), async (req, res, next) => {
    try {
      const step = String((req.body || {}).step || '');
      const row = await rowFor(req.office);
      if (!row) throw new OnboardingError(409, 'Tell us about the business first.');
      const list = String(row.skipped || '').split(',').filter((x) => x && x !== step);
      await save(req.office, { skipped: list.join(',') || null });
      res.json(await status(req.office));
    } catch (e) { fail(res, e, next); }
  });

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
      // go.vesopa.com/signup, and Vesopa Passport (owner, 2026-11-26), where
      // verification and account opening now live.
      if (!/^https:\/\/((go\.vesopa\.com|go\.vesopaepos\.com|staging\.go\.vesopa\.com)\/signup|passport\.vesopa\.com\/flow)\/?$/.test(redirect)
        && !(process.env.NODE_ENV === 'test' && /^http:\/\/127\.0\.0\.1/.test(redirect))) {
        throw new OnboardingError(400, 'That sign-in did not come from Vesopa Passport.');
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
      if (!row || row.identity_session !== obj.id) return;
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

module.exports = { welcomeEmail, stripeChecklist, goOnboardingRoutes, LIMITS, LICENCE, BUSINESS_TYPES, OnboardingError, defaultClient };
