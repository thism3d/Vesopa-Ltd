/**
 * Signing a new venue up for Vesopa Go (src/go_onboarding.js), against a fake
 * database and a fake Stripe: the steps in order, Stripe made the venue's
 * provider, the owner's identity and the licence followed through the
 * webhook, the £250 / £1,000 caps until every check has passed, and the
 * website's sign-in.
 */
const assert = require('assert');
const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.NODE_ENV = 'test';
process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_fake';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_fake';
process.env.STRIPE_LIVE_SECRET_KEY = 'sk_live_fake';
process.env.STRIPE_LIVE_PUBLISHABLE_KEY = 'pk_live_fake';

const stripe = require('../src/stripe_client');
const { stripeRoutes } = require('../src/stripe');
const { goOnboardingRoutes, LIMITS } = require('../src/go_onboarding');

const SECRET = 'test-secret-not-a-real-one';
const OFFICE = 'owner@newvenue.test';

/** Just enough MySQL for the two settings tables and offices. */
function fakePool() {
  const tables = { epos_stripe_settings: new Map(), go_onboarding: new Map(), bo_licence_limits: new Map() };
  const offices = new Map([[OFFICE, { name: 'The New Venue', contact_email: OFFICE }]]);
  const clerks = [];
  const answer = async (sql, params = []) => {
    const one = sql.replace(/\s+/g, ' ').trim();
    if (/^INSERT INTO bo_licence_limits/.test(one)) {
      tables.bo_licence_limits.set(params[0], { office: params[0], kind: 'go', seats: params[1], source: 'trial', status: params[2], ends_at: params[3] });
      return [{ affectedRows: 1 }, []];
    }
    if (/^UPDATE bo_licence_limits SET seats = \?, source = 'trial'/.test(one)) {
      Object.assign(tables.bo_licence_limits.get(params[3]), { seats: params[0], source: 'trial', status: params[1], ends_at: params[2] });
      return [{ affectedRows: 1 }, []];
    }
    if (/^UPDATE bo_licence_limits SET seats = 0/.test(one)) {
      Object.assign(tables.bo_licence_limits.get(params[1]), { seats: 0, status: params[0] });
      return [{ affectedRows: 1 }, []];
    }
    if (/^SELECT office FROM go_onboarding WHERE card_later = 1 AND licence_status = 'card_needed'/.test(one)) {
      return [[...tables.go_onboarding.values()].filter((r) => Number(r.card_later) === 1 && r.licence_status === 'card_needed').map((r) => ({ office: r.office })), []];
    }
    let m = one.match(/^SELECT \* FROM (\w+) WHERE office = \?/);
    if (m) return [[tables[m[1]].get(params[0])].filter(Boolean), []];
    m = one.match(/^SELECT \* FROM (\w+) WHERE account_id = \?/);
    if (m) return [[...tables[m[1]].values()].filter((r) => r.account_id === params[0]), []];
    m = one.match(/^INSERT INTO (\w+) \(office, ([^)]+)\)/);
    if (m && tables[m[1]]) {
      const cols = m[2].split(', ');
      const row = tables[m[1]].get(params[0]) || { office: params[0] };
      cols.forEach((c, i) => { row[c] = params[i + 1]; });
      tables[m[1]].set(params[0], row);
      return [{ affectedRows: 1 }, []];
    }
    if (/FROM offices WHERE contact_email/.test(one)) return [[offices.get(params[0])].filter(Boolean), []];
    if (/FROM epos_permission_groups WHERE email = \? AND name = 'Manager'/.test(one)) return [[{ id: 3 }], []];
    if (/^SELECT clark_name FROM bo_clarks/.test(one)) return [clerks.filter((c) => c.office === params[0] && c.pin === params[1]), []];
    if (/^INSERT INTO bo_clarks/.test(one)) { clerks.push({ office: params[0], name: params[1], pin: params[2], group: params[3] }); return [{ insertId: clerks.length }, []]; }
    return [[], []];
  };
  return { tables, offices, clerks, query: answer, execute: answer };
}

function fakeStripe(state) {
  const calls = [];
  const account = () => ({
    id: 'acct_new1',
    configuration: { merchant: { capabilities: {
      card_payments: { status: state.card },
      stripe_balance: { payouts: { status: state.payouts } },
    } } },
    requirements: { entries: Array.from({ length: state.due }, (_, i) => ({ id: `r${i}` })) },
  });
  return {
    calls,
    stripeClient: {
      configuredFor: () => true,
      environment: () => 'sandbox',
      readiness: stripe.readiness,
      createAccount: async (a) => {
        calls.push(['createAccount', a]);
        if (state.refuseDetails && a.identity) throw new stripe.StripeError(400, 'parameter_unknown', 'nope');
        return account();
      },
      retrieveAccount: async () => account(),
      onboardingSession: async (acct) => { calls.push(['onboardingSession', acct]); return { client_secret: 'accs_onb' }; },
      createTerminalPayment: async (acct, p) => { calls.push(['pay', acct, p.amountMinor]); return { id: 'pi_1', client_secret: 'pi_1_secret', status: 'requires_payment_method' }; },
    },
    onboarding: {
      createIdentitySession: async (a, opts) => {
        calls.push(['identity', a.office, opts && opts.key]);
        if (state.refuseIdentity) {
          throw new stripe.StripeError(400, 'invalid_request_error',
            'For more information on Stripe Identity supported use-cases and locations, please see https://docs.stripe.com/identity/use-cases.');
        }
        return { id: 'vs_1', status: 'requires_input', client_secret: 'vs_1_secret', url: 'https://verify.stripe.com/x' }; },
      retrieveIdentitySession: async () => ({ id: 'vs_1', status: state.identity || 'requires_input', client_secret: 'vs_1_secret' }),
      identityEphemeralKey: async () => ({ secret: 'ek_test_1' }),
      createCustomer: async () => ({ id: 'cus_1' }),
      licencePrice: async () => 'price_go',
      createLicence: async (a) => {
        calls.push(['licence', a]);
        return { id: 'sub_1', status: 'trialing', trial_end: 1900000000, pending_setup_intent: { id: 'seti_1', client_secret: 'seti_1_secret', status: 'requires_payment_method' } };
      },
      retrieveLicence: async () => ({ id: 'sub_1', status: state.licence || 'trialing', trial_end: 1900000000, pending_setup_intent: null, default_payment_method: state.cardSaved ? 'pm_1' : null }),
      takenToday: async () => state.takenToday || 0,
    },
  };
}

function appWith(pool, fake, extra = {}) {
  let goRouter = null;
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
  const stripeR = stripeRoutes({ pool, secret: SECRET, client: fake.stripeClient });
  const go = goOnboardingRoutes({
    pool,
    secret: SECRET,
    sweepEveryHours: 0,
    stripeSettings: stripeR.settings,
    client: fake.onboarding,
    stripeClient: fake.stripeClient,
    ...extra,
  });
  goRouter = go;
  stripeR.capCheck = go.capCheck;
  stripeR.onStripeEvent = go.onStripeEvent;
  app.use('/api', stripeR);
  app.use('/api', go);
  app.use((err, _req, res, _next) => res.status(500).json({ error: String(err && err.stack) }));
  app.go = goRouter;
  return app;
}

const listen = (app) => new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
async function call(server, method, path, { body, token, raw, headers = {} } = {}) {
  const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: raw !== undefined ? raw : body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

function signed(event) {
  const payload = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', 'whsec_fake').update(`${t}.${payload}`).digest('hex');
  return { raw: payload, headers: { 'Stripe-Signature': `t=${t},v1=${sig}` } };
}

(async () => {
  const pool = fakePool();
  const state = { card: 'inactive', payouts: 'inactive', due: 3 };
  const fake = fakeStripe(state);
  const server = await listen(appWith(pool, fake));
  const phone = jwt.sign({ scope: 'terminal', office: OFFICE }, SECRET);
  let passed = 0;
  const ok = (cond, what) => { assert.ok(cond, what); passed += 1; };

  try {
    // Nobody without a token.
    ok((await call(server, 'GET', '/api/go/onboarding')).status === 401, 'no token, no status');

    // A new venue starts at the business step, in test mode.
    let r = await call(server, 'GET', '/api/go/onboarding', { token: phone });
    ok(r.status === 200 && r.body.next === 'business' && r.body.mode === 'test', 'starts at business, test mode');
    ok(r.body.business_types.length === 5, 'five kinds of business');

    // Identity and Stripe wait for the business.
    ok((await call(server, 'POST', '/api/go/onboarding/identity', { token: phone, body: {} })).status === 409, 'identity waits for business');
    ok((await call(server, 'POST', '/api/go/onboarding/stripe', { token: phone })).status === 409, 'stripe waits for business');

    // The business, checked.
    ok((await call(server, 'PUT', '/api/go/onboarding/business', { token: phone, body: { business_type: 'shop' } })).status === 400, 'unknown kind refused');
    ok((await call(server, 'PUT', '/api/go/onboarding/business', { token: phone, body: {
      business_type: 'company', legal_name: 'New Venue Ltd', expected_monthly_minor: 1000, average_sale_minor: 5000,
    } })).status === 400, 'average above monthly refused');
    r = await call(server, 'PUT', '/api/go/onboarding/business', { token: phone, body: {
      business_type: 'company', legal_name: 'New Venue Ltd', expected_monthly_minor: 2000000, average_sale_minor: 1500,
    } });
    ok(r.status === 200 && r.body.steps.business === true && r.body.next === 'identity', 'business saved, identity next');

    // The owner's ID and selfie: a mobile sheet gets an ephemeral key.
    r = await call(server, 'POST', '/api/go/onboarding/identity', { token: phone, body: { mobile: true } });
    ok(r.status === 201 && r.body.id === 'vs_1' && r.body.ephemeral_key_secret === 'ek_test_1', 'identity session for the app');
    // On the live account, where native SDKs and Synthetic Identity Protection are on.
    ok(r.body.publishable_key === 'pk_live_fake' && fake.calls.find((c) => c[0] === 'identity')[2] === 'sk_live_fake', 'identity checked on live Stripe');
    ok(pool.tables.go_onboarding.get(OFFICE).identity_env === 'live', 'identity mode remembered');

    // Stripe: the account is made with what we know, and Stripe becomes the provider.
    r = await call(server, 'POST', '/api/go/onboarding/stripe', { token: phone });
    ok(r.status === 201 && r.body.client_secret === 'accs_onb' && r.body.account === 'acct_new1', 'onboarding session');
    const made = fake.calls.find((c) => c[0] === 'createAccount')[1];
    ok(made.dashboard === 'none', 'no Stripe dashboard: no Stripe sign-in in onboarding');
    ok(made.identity.entity_type === 'company' && made.identity.business_details.registered_name === 'New Venue Ltd'
      && made.identity.business_details.annual_revenue.amount.value === 24000000, 'account carries the business');
    const st = pool.tables.epos_stripe_settings.get(OFFICE);
    ok(st.enabled === 1 && st.use_tap === 1 && st.use_online === 1, 'Stripe is the venue\'s provider');
    r = await call(server, 'POST', '/api/go/onboarding/stripe', { token: phone });
    ok(r.status === 201 && fake.calls.filter((c) => c[0] === 'createAccount').length === 1, 'account made once');

    // The changing of business kind after Stripe has it is refused.
    ok((await call(server, 'PUT', '/api/go/onboarding/business', { token: phone, body: {
      business_type: 'sole_trader', legal_name: 'Ann Owner', expected_monthly_minor: 2000000, average_sale_minor: 1500,
    } })).status === 409, 'kind fixed once Stripe has it');

    // The licence: 14 days free, card through the SetupIntent.
    r = await call(server, 'POST', '/api/go/onboarding/licence', { token: phone });
    ok(r.status === 201 && r.body.setup_intent_client_secret === 'seti_1_secret' && r.body.trial_days === 14 && r.body.amount_minor === 2900, 'licence card');

    // The owner's PIN waits for every step.
    ok((await call(server, 'POST', '/api/go/onboarding/owner-pin', { token: phone, body: { name: 'Ann Owner', pin: '4826' } })).status === 409, 'PIN waits for the checks');
    r = await call(server, 'GET', '/api/go/onboarding', { token: phone });
    ok(r.body.signed_up === true && r.body.complete === false && r.body.ready_to_use === false, 'not ready to use yet');

    // Test mode: no live payments at all yet.
    let pay = await call(server, 'POST', '/api/till/stripe/payments', { token: phone, body: { amount_minor: 500 } });
    ok(pay.status === 409, 'test mode takes no card payment');

    // Stripe lets the venue take cards; checks are not all done: capped.
    state.card = 'active'; state.payouts = 'active'; state.due = 1;
    r = await call(server, 'GET', '/api/go/onboarding?refresh=1', { token: phone });
    ok(r.body.mode === 'capped' && r.body.limits.per_payment_minor === LIMITS.per_payment_minor, 'capped once cards are on');
    pay = await call(server, 'POST', '/api/till/stripe/payments', { token: phone, body: { amount_minor: 25001 } });
    ok(pay.status === 409 && pay.body.code === 'onboarding_limit', 'over £250 refused');
    state.takenToday = 90000;
    pay = await call(server, 'POST', '/api/till/stripe/payments', { token: phone, body: { amount_minor: 20000 } });
    ok(pay.status === 409 && /a day/.test(pay.body.error), 'over £1,000 a day refused');
    pay = await call(server, 'POST', '/api/till/stripe/payments', { token: phone, body: { amount_minor: 5000 } });
    ok(pay.status === 201, 'within the caps goes ahead');

    // The webhook: identity verified, licence trialing; Stripe complete: live, no caps.
    const ev = signed({ type: 'identity.verification_session.verified', data: { object: { id: 'vs_1', status: 'verified', metadata: { office: OFFICE, purpose: 'vesopa_go_owner' } } } });
    ok((await call(server, 'POST', '/api/stripe/webhook', ev)).status === 200, 'identity event accepted');
    ok(pool.tables.go_onboarding.get(OFFICE).identity_status === 'verified', 'identity verified');
    const forged = { raw: JSON.stringify({ type: 'identity.verification_session.verified', data: { object: { id: 'vs_x', metadata: { office: OFFICE, purpose: 'vesopa_go_owner' } } } }), headers: { 'Stripe-Signature': 't=1,v1=00' } };
    ok((await call(server, 'POST', '/api/stripe/webhook', forged)).status === 400, 'unsigned event refused');
    // A trial without a card is not a licence (2026-11-17: the card step passed with no card).
    const noCard = signed({ type: 'customer.subscription.created', data: { object: { id: 'sub_1', status: 'trialing', trial_end: 1900000000, default_payment_method: null, metadata: { office: OFFICE, purpose: 'vesopa_go_licence' } } } });
    await call(server, 'POST', '/api/stripe/webhook', noCard);
    ok(pool.tables.go_onboarding.get(OFFICE).licence_status === 'card_needed', 'trial without a card: card still needed');
    r = await call(server, 'GET', '/api/go/onboarding?refresh=1', { token: phone });
    ok(r.body.steps.licence === 'card_needed' && r.body.verified === false, 'licence step still to do');
    state.cardSaved = true;
    const subEv = signed({ type: 'customer.subscription.updated', data: { object: { id: 'sub_1', status: 'trialing', trial_end: 1900000000, default_payment_method: 'pm_1', metadata: { office: OFFICE, purpose: 'vesopa_go_licence' } } } });
    await call(server, 'POST', '/api/stripe/webhook', subEv);
    ok(pool.tables.go_onboarding.get(OFFICE).licence_status === 'trialing', 'card saved: licence trialing');
    state.due = 0;
    r = await call(server, 'GET', '/api/go/onboarding?refresh=1', { token: phone });
    ok(r.body.mode === 'live' && r.body.verified === true && r.body.limits === null && r.body.next === null, 'all checks: live');
    pay = await call(server, 'POST', '/api/till/stripe/payments', { token: phone, body: { amount_minor: 80000 } });
    ok(pay.status === 201, 'no cap once verified');

    // Complete: the owner's manager PIN, then Go is ready to use.
    ok(r.body.complete === true && r.body.ready_to_use === false, 'complete, PIN still to set');
    ok((await call(server, 'POST', '/api/go/onboarding/owner-pin', { token: phone, body: { name: 'Ann Owner', pin: '1111' } })).status === 400, 'guessable PIN refused');
    ok((await call(server, 'POST', '/api/go/onboarding/owner-pin', { token: phone, body: { name: 'Ann Owner', pin: '12' } })).status === 400, 'short PIN refused');
    r = await call(server, 'POST', '/api/go/onboarding/owner-pin', { token: phone, body: { name: 'Ann Owner', pin: '4826' } });
    ok(r.status === 201 && r.body.ready_to_use === true, 'PIN set: ready to use');
    ok(pool.clerks.length === 1 && pool.clerks[0].group === 3 && pool.clerks[0].pin === '4826', 'owner is the first manager');
    ok((await call(server, 'POST', '/api/go/onboarding/owner-pin', { token: phone, body: { name: 'Ann Owner', pin: '5937' } })).status === 409, 'set once');

    // A venue that never signed up here is never held back.
    r = await call(server, 'GET', '/api/go/onboarding', { token: jwt.sign({ scope: 'terminal', office: 'old@venue.test' }, SECRET) });
    ok(r.body.signed_up === false && r.body.ready_to_use === false, 'old venue: not a sign-up');

    // A venue that never signed up here is never capped.
    const old = 'old@venue.test';
    pool.tables.epos_stripe_settings.set(old, { office: old, account_id: 'acct_old', enabled: 1, use_tap: 1, card_payments: 'active', payouts: 'active', requirements_due: 0 });
    pay = await call(server, 'POST', '/api/till/stripe/payments', { token: jwt.sign({ scope: 'terminal', office: old }, SECRET), body: { amount_minor: 90000 } });
    ok(pay.status === 201, 'existing venues uncapped');

    // Stripe refusing the extra details still makes the account.
    const pool2 = fakePool();
    const state2 = { card: 'inactive', payouts: 'inactive', due: 2, refuseDetails: true };
    const fake2 = fakeStripe(state2);
    const s2 = await listen(appWith(pool2, fake2));
    await call(s2, 'PUT', '/api/go/onboarding/business', { token: phone, body: { business_type: 'sole_trader', legal_name: 'Ann Owner', expected_monthly_minor: 500000, average_sale_minor: 800 } });
    r = await call(s2, 'POST', '/api/go/onboarding/stripe', { token: phone });
    ok(r.status === 201 && fake2.calls.filter((c) => c[0] === 'createAccount').length === 2, 'falls back to a plain account');
    s2.close();

    // The trial opened Vesopa Go for the venue: five Go devices, every mode.
    ok(pool.tables.bo_licence_limits.get(OFFICE) && pool.tables.bo_licence_limits.get(OFFICE).seats === 5
      && pool.tables.bo_licence_limits.get(OFFICE).source === 'trial', 'trial opens Go: 5 seats');
    r = await call(server, 'GET', '/api/go/onboarding?refresh=1', { token: phone });
    ok(r.body.checklist && r.body.checklist.rows.find((x) => x.id === 'cards').done === true, "Stripe's checklist read");

    // Leaving identity for later: the sign-up goes on, the venue stays capped,
    // Go's banner knows, and the welcome email says what is left.
    const mails = [];
    const pool5 = fakePool();
    const state5 = { card: 'inactive', payouts: 'inactive', due: 2, cardSaved: true };
    const s5 = await listen(appWith(pool5, fakeStripe(state5), { sendWelcome: async (m) => { mails.push(m); } }));
    await call(s5, 'PUT', '/api/go/onboarding/business', { token: phone, body: { business_type: 'sole_trader', legal_name: 'Ann Owner', expected_monthly_minor: 500000, average_sale_minor: 800 } });
    ok((await call(s5, 'POST', '/api/go/onboarding/skip', { token: phone, body: { step: 'licence' } })).status === 400, 'the licence cannot be skipped');
    r = await call(s5, 'POST', '/api/go/onboarding/skip', { token: phone, body: { step: 'identity' } });
    ok(r.status === 200 && r.body.next === 'stripe' && r.body.skipped.includes('identity'), 'identity skipped: on to Stripe');
    r = await call(s5, 'POST', '/api/go/onboarding/skip', { token: phone, body: { step: 'stripe' } });
    ok(r.body.next === 'licence' && r.body.pending.includes('identity') && r.body.pending.includes('stripe'), 'both left for later, both pending');
    await call(s5, 'POST', '/api/go/onboarding/licence', { token: phone });
    r = await call(s5, 'GET', '/api/go/onboarding?refresh=1', { token: phone });
    ok(r.body.complete === true && r.body.verified === false && r.body.mode !== 'live', 'complete but still capped');
    ok(pool5.tables.bo_licence_limits.get(OFFICE).seats === 5, 'trial seats with steps left for later');
    ok(mails.length === 1 && /Welcome to Vesopa Go/.test(mails[0].subject) && /verify your identity/.test(mails[0].text), 'welcome email, with what is left');
    await call(s5, 'GET', '/api/go/onboarding?refresh=1', { token: phone });
    ok(mails.length === 1, 'welcome sent once');
    r = await call(s5, 'POST', '/api/go/onboarding/unskip', { token: phone, body: { step: 'identity' } });
    ok(r.body.next === 'identity' && !r.body.skipped.includes('identity'), 'back to a skipped step');
    s5.close();

    // Stripe refusing Identity for Vesopa's account does not stop the sign-up:
    // the owner's ID is checked in step 3, and Identity is tried again later.
    const pool4 = fakePool();
    const state4 = { card: 'inactive', payouts: 'inactive', due: 2, refuseIdentity: true };
    const s4 = await listen(appWith(pool4, fakeStripe(state4)));
    await call(s4, 'PUT', '/api/go/onboarding/business', { token: phone, body: { business_type: 'sole_trader', legal_name: 'Ann Owner', expected_monthly_minor: 500000, average_sale_minor: 800 } });
    r = await call(s4, 'POST', '/api/go/onboarding/identity', { token: phone, body: { mobile: true } });
    ok(r.status === 200 && r.body.via_connect === true && r.body.steps.identity === 'via_connect', 'refused Identity: checked in step 3');
    ok(r.body.next === 'stripe' && r.body.identity_error === null, 'the sign-up goes on to Stripe\'s checks');
    r = await call(s4, 'GET', '/api/go/onboarding?refresh=1', { token: phone });
    ok(r.body.steps.identity === 'via_connect', 'a refresh keeps it');
    state4.card = 'active'; state4.payouts = 'active'; state4.due = 0;
    await call(s4, 'POST', '/api/go/onboarding/stripe', { token: phone });
    r = await call(s4, 'GET', '/api/go/onboarding?refresh=1', { token: phone });
    ok(r.body.steps.stripe === 'complete' && r.body.next === 'licence', 'Stripe\'s checks done: on to the licence');
    state4.refuseIdentity = false;
    r = await call(s4, 'POST', '/api/go/onboarding/identity', { token: phone, body: { mobile: true } });
    ok(r.status === 201 && r.body.id === 'vs_1', 'once Stripe opens Identity it is used');
    s4.close();

    // The app's licence step (owner, 2026-11-26): the trial starts with no card,
    // the app is asked for no payment, and the card link goes by email.
    const mails6 = [];
    const pool6 = fakePool();
    const state6 = { card: 'inactive', payouts: 'inactive', due: 2 };
    const fake6 = fakeStripe(state6);
    const s6 = await listen(appWith(pool6, fake6, { sendWelcome: async (m) => { mails6.push(m); } }));
    ok((await call(s6, 'POST', '/api/go/onboarding/licence/trial', { token: phone })).status === 409, 'app trial waits for the business');
    await call(s6, 'PUT', '/api/go/onboarding/business', { token: phone, body: { business_type: 'sole_trader', legal_name: 'Ann Owner', expected_monthly_minor: 500000, average_sale_minor: 800 } });
    await call(s6, 'POST', '/api/go/onboarding/skip', { token: phone, body: { step: 'identity' } });
    await call(s6, 'POST', '/api/go/onboarding/skip', { token: phone, body: { step: 'stripe' } });
    r = await call(s6, 'POST', '/api/go/onboarding/licence/trial', { token: phone });
    ok(r.status === 200 && r.body.licence.ok === true && r.body.licence.card_later === true
      && r.body.steps.licence === 'card_needed' && r.body.next === null && r.body.complete === true, 'app trial: no card, step done');
    ok(fake6.calls.filter((c) => c[0] === 'licence').length === 1 && !('setup_intent_client_secret' in r.body), 'one subscription, no card asked');
    ok(pool6.tables.bo_licence_limits.get(OFFICE).seats === 5, 'app trial opens Go: 5 seats');
    ok(mails6.length === 1 && mails6[0].text.includes('https://go.vesopa.com/signup/#licence') && mails6[0].html.includes('add a card for the licence'), 'welcome carries the card link');
    r = await call(s6, 'POST', '/api/go/onboarding/licence/trial', { token: phone });
    ok(r.status === 200 && fake6.calls.filter((c) => c[0] === 'licence').length === 1, 'started once');
    // Three days before the end, Stripe says so: the reminder, once.
    const willEnd = signed({ type: 'customer.subscription.trial_will_end', data: { object: { id: 'sub_1', status: 'trialing', trial_end: 1900000000, default_payment_method: null, metadata: { office: OFFICE, purpose: 'vesopa_go_licence' } } } });
    await call(s6, 'POST', '/api/stripe/webhook', willEnd);
    await call(s6, 'POST', '/api/stripe/webhook', willEnd);
    const reminders = mails6.filter((m) => /free days end/.test(m.subject));
    ok(reminders.length === 1 && reminders[0].text.includes('https://go.vesopa.com/signup/#licence') && /£29 a month/.test(reminders[0].text), 'reminder once, with the card link');
    // The website still takes the card for the same subscription.
    r = await call(s6, 'POST', '/api/go/onboarding/licence', { token: phone });
    ok(r.status === 200 || r.status === 201, 'the website can still add the card');
    // Card added on the website: the licence is a normal trial.
    state6.cardSaved = true;
    await call(s6, 'POST', '/api/stripe/webhook', signed({ type: 'customer.subscription.updated', data: { object: { id: 'sub_1', status: 'trialing', trial_end: 1900000000, default_payment_method: 'pm_1', metadata: { office: OFFICE, purpose: 'vesopa_go_licence' } } } }));
    r = await call(s6, 'GET', '/api/go/onboarding', { token: phone });
    ok(r.body.steps.licence === 'trialing' && r.body.licence.card_later === false && r.body.licence.ok === true, 'card added: an ordinary trial');
    // No card by the end: Stripe cancels the subscription and the seats go back.
    await call(s6, 'POST', '/api/stripe/webhook', signed({ type: 'customer.subscription.deleted', data: { object: { id: 'sub_1', status: 'canceled', trial_end: 1900000000, default_payment_method: null, metadata: { office: OFFICE, purpose: 'vesopa_go_licence' } } } }));
    r = await call(s6, 'GET', '/api/go/onboarding', { token: phone });
    ok(r.body.licence.ok === false && pool6.tables.bo_licence_limits.get(OFFICE).seats === 0, 'trial ended without a card: seats back');
    // Without Stripe's events (the live webhook sends payment events only), the
    // sweep sends the reminder and, after the end, gives the seats back.
    let clock = Date.parse('2030-03-15T00:00:00Z');
    const mails8 = [];
    const pool8 = fakePool();
    const state8 = { card: 'inactive', payouts: 'inactive', due: 2 };
    const app8 = appWith(pool8, fakeStripe(state8), { sendWelcome: async (m) => { mails8.push(m); }, now: () => clock });
    const s8 = await listen(app8);
    await call(s8, 'PUT', '/api/go/onboarding/business', { token: phone, body: { business_type: 'sole_trader', legal_name: 'Ann Owner', expected_monthly_minor: 500000, average_sale_minor: 800 } });
    await call(s8, 'POST', '/api/go/onboarding/skip', { token: phone, body: { step: 'identity' } });
    await call(s8, 'POST', '/api/go/onboarding/skip', { token: phone, body: { step: 'stripe' } });
    await call(s8, 'POST', '/api/go/onboarding/licence/trial', { token: phone });
    const ends8 = new Date(pool8.tables.go_onboarding.get(OFFICE).trial_end).getTime();
    clock = ends8 - 10 * 86400000;
    await app8.go.sweepTrials();
    ok(mails8.filter((m) => /free days end/.test(m.subject)).length === 0, 'no reminder ten days out');
    clock = ends8 - 2 * 86400000;
    await app8.go.sweepTrials();
    await app8.go.sweepTrials();
    ok(mails8.filter((m) => /free days end/.test(m.subject)).length === 1, 'sweep: reminder once, two days out');
    clock = ends8 + 3600000;
    state8.licence = 'canceled';
    await app8.go.sweepTrials();
    ok(pool8.tables.go_onboarding.get(OFFICE).licence_status === 'canceled' && pool8.tables.bo_licence_limits.get(OFFICE).seats === 0, 'sweep: ended without a card, seats back');
    s8.close();

    // A website sign-up without a card is still not done (the card step stays).
    const pool7 = fakePool();
    const s7 = await listen(appWith(pool7, fakeStripe({ card: 'inactive', payouts: 'inactive', due: 0 })));
    await call(s7, 'PUT', '/api/go/onboarding/business', { token: phone, body: { business_type: 'sole_trader', legal_name: 'Ann Owner', expected_monthly_minor: 500000, average_sale_minor: 800 } });
    await call(s7, 'POST', '/api/go/onboarding/skip', { token: phone, body: { step: 'identity' } });
    await call(s7, 'POST', '/api/go/onboarding/skip', { token: phone, body: { step: 'stripe' } });
    await call(s7, 'POST', '/api/go/onboarding/licence', { token: phone });
    r = await call(s7, 'GET', '/api/go/onboarding', { token: phone });
    ok(r.body.next === 'licence' && r.body.licence.ok === false && r.body.licence.card_later === false, 'website: the card is still needed');
    s6.close(); s7.close();

    // The website: code exchanged on the server, a new email gets a sign-up token.
    const issued = [];
    const pool3 = fakePool();
    const s3 = await listen(appWith(pool3, fakeStripe({ card: 'inactive', payouts: 'inactive', due: 1 }), {
      goClient: () => ({ issuer: 'https://auth.example', clientId: 'go-client' }),
      fetchImpl: async (url, init) => { issued.push([url, String(init.body)]); return { ok: true, json: async () => ({ id_token: 'idt' }) }; },
      verifyIdToken: async (t, kind) => { assert.strictEqual(kind, 'go'); return { email: 'Fresh@Venue.test', email_verified: true, name: 'Fresh Owner' }; },
      createVenue: async (v) => { pool3.offices.set(v.email, { name: v.venueName, contact_email: v.email }); return { email: v.email, name: v.venueName }; },
    }));
    ok((await call(s3, 'POST', '/api/go/onboarding/web/exchange', { body: { code: 'c', code_verifier: 'v', redirect_uri: 'https://evil.example/signup/' } })).status === 400, 'only go.vesopa.com may exchange');
    r = await call(s3, 'POST', '/api/go/onboarding/web/exchange', { body: { code: 'c', code_verifier: 'v', redirect_uri: 'https://go.vesopa.com/signup/' } });
    ok(r.status === 200 && r.body.signup_token && r.body.email === 'fresh@venue.test', 'new email: sign-up token');
    ok(issued[0][0] === 'https://auth.example/oauth/token' && /client_id=go-client/.test(issued[0][1]) && /code_verifier=v/.test(issued[0][1]), 'exchanged with PKCE');
    r = await call(s3, 'POST', '/api/go/onboarding/web/register', { body: { signup_token: r.body.signup_token, venue_name: 'Fresh Bar', business_type: 'Pub or bar', postcode: 'SA8 4EG' } });
    ok(r.status === 201 && r.body.token, 'website venue made');
    const webTok = r.body.token;
    r = await call(s3, 'GET', '/api/go/onboarding', { token: webTok });
    ok(r.status === 200 && r.body.next === 'business', 'website token reads its status');
    ok((await call(s3, 'POST', '/api/go/onboarding/web/register', { body: { signup_token: phone, venue_name: 'X' } })).status === 401, 'a phone token is not a sign-up token');
    r = await call(s3, 'POST', '/api/go/onboarding/web/exchange', { body: { code: 'c', code_verifier: 'v', redirect_uri: 'https://go.vesopa.com/signup/' } });
    ok(r.status === 200 && r.body.token && !r.body.signup_token, 'returning email: onboarding token');
    s3.close();

    console.log(`go-onboarding.test.js: ${passed} checks passed`);
  } finally {
    server.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
