/**
 * The Vesopa Kitchen on live Stripe for Vesopa Go, and the owners' ID check
 * opened again now that Stripe has verified Vesopa for Identity (owner,
 * 2026-11-26: "User authentication never worked as the identity in the Stripe
 * was not verified, now it's verified, and use live key for the Vesopa
 * Kitchen venue of the Vesopa Go").
 *
 *     node tool/go-stripe-live.js            show what it would change
 *     node tool/go-stripe-live.js --apply    change it
 *     node tool/go-stripe-live.js --sandbox  the Kitchen back to its sandbox row
 *
 * Run as the app's user in the app's folder, with its .env (the "Back office -
 * patch" workflow, run go-stripe-live). --apply, in order:
 *
 *   1. The Kitchen's sandbox Stripe row is kept in tmp/kitchen-stripe-sandbox.json
 *      (0600, once) so --sandbox can put it back exactly.
 *   2. A live Terminal location for the Kitchen, found by its metadata or made
 *      from the sandbox location's address.
 *   3. The live webhook to /api/stripe/webhook: made if there is none, and its
 *      signing secret written to .env as STRIPE_LIVE_WEBHOOK_SECRET (the .env is
 *      backed up beside itself first). One already there is left alone.
 *   4. The Kitchen's row: environment live, account "platform" (Vesopa's own
 *      account takes the money), the live location, card payments and payouts
 *      active. Only the Kitchen's row.
 *   5. Owners whose ID check was moved to the business checks while Stripe
 *      would not run Identity (identity_status "via_connect", no session) get
 *      the step back, to verify with Vesopa Passport's flow.
 *
 * Prints what it found and did; never a key, a secret or anyone's details.
 * Ends with "restart: yes" when .env changed, so the caller restarts the app.
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const KITCHEN = 'manager@vesopa.co.uk';
const HOOK = `${process.env.PUBLIC_BASE_URL || 'https://backoffice.vesopaepos.com'}/api/stripe/webhook`;
const EVENTS = [
  'payment_intent.succeeded', 'payment_intent.payment_failed', 'payment_intent.canceled',
  'payment_intent.processing', 'payment_intent.requires_action', 'payment_intent.amount_capturable_updated',
  'charge.refunded', 'terminal.reader.action_succeeded', 'terminal.reader.action_failed',
  'terminal.reader.action_updated', 'account.updated',
  'identity.verification_session.verified', 'identity.verification_session.requires_input',
  'identity.verification_session.processing', 'identity.verification_session.canceled',
];
const SANDBOX_FILE = path.join(__dirname, '..', 'tmp', 'kitchen-stripe-sandbox.json');
const ENV_FILE = path.join(__dirname, '..', '.env');

const mode = process.argv.includes('--apply') ? 'apply' : process.argv.includes('--sandbox') ? 'sandbox' : 'check';
const liveKey = String(process.env.STRIPE_LIVE_SECRET_KEY || '').trim();
const testKey = String(process.env.STRIPE_SECRET_KEY || '').trim();

function form(obj, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((x, i) => out.append(`${key}[${i}]`, String(x)));
    else if (typeof v === 'object') form(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

async function stripe(key, method, url, body, account) {
  const headers = { Authorization: `Bearer ${key}` };
  if (account && account !== 'platform') headers['Stripe-Account'] = account;
  if (body) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  const r = await fetch(`https://api.stripe.com${url}`, { method, headers, body: body ? form(body).toString() : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Stripe ${method} ${url.split('?')[0]}: ${(j.error && j.error.message) || r.status}`);
  return j;
}

function setEnv(name, value) {
  const now = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  fs.writeFileSync(`${ENV_FILE}.bak-${stamp}`, now, { mode: 0o600 });
  const lines = now.split(/\r?\n/).filter((l) => l && !l.startsWith(`${name}=`));
  lines.push(`${name}=${value}`);
  fs.writeFileSync(ENV_FILE, `${lines.join('\n')}\n`);
}

async function liveLocation(row) {
  const list = await stripe(liveKey, 'GET', '/v1/terminal/locations?limit=100');
  const mine = (list.data || []).find((l) => (l.metadata || {}).vesopa_office === KITCHEN);
  if (mine) return { id: mine.id, made: false };
  let sandbox = null;
  if (row.location_id && testKey) {
    sandbox = await stripe(testKey, 'GET', `/v1/terminal/locations/${encodeURIComponent(row.location_id)}`, null, row.account_id)
      .catch(() => null);
  }
  const a = (sandbox && sandbox.address) || {};
  if (!a.line1 || !a.city || !a.postal_code) throw new Error('the Kitchen has no sandbox location address to copy: nothing changed');
  const made = await stripe(liveKey, 'POST', '/v1/terminal/locations', {
    display_name: (sandbox && sandbox.display_name) || 'The Vesopa Kitchen',
    address: { line1: a.line1, line2: a.line2 || undefined, city: a.city, postal_code: a.postal_code, country: a.country || 'GB' },
    metadata: { vesopa_office: KITCHEN },
  });
  return { id: made.id, made: true };
}

async function liveWebhook() {
  const list = await stripe(liveKey, 'GET', '/v1/webhook_endpoints?limit=100');
  const there = (list.data || []).find((w) => w.url === HOOK);
  if (there) {
    return { made: false, secretSet: Boolean(String(process.env.STRIPE_LIVE_WEBHOOK_SECRET || '').trim()) };
  }
  const made = await stripe(liveKey, 'POST', '/v1/webhook_endpoints', {
    url: HOOK, enabled_events: EVENTS, description: 'Vesopa back office (live)',
  });
  setEnv('STRIPE_LIVE_WEBHOOK_SECRET', made.secret);
  return { made: true, secretSet: true };
}

async function main() {
  const db = mysql.createPool({
    connectionLimit: 1,
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER,
    password: process.env.DB_PASS || process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'vesopa_eposdb',
  });
  let restart = false;
  try {
    const [[row]] = await db.query(
      'SELECT office, account_id, location_id, environment, card_payments, payouts FROM epos_stripe_settings WHERE office = ?', [KITCHEN]);
    if (!row) throw new Error('The Vesopa Kitchen has no Stripe row on this server: nothing changed');
    console.log(`Kitchen Stripe: ${row.environment || 'sandbox'}, account ${row.account_id === 'platform' ? 'Vesopa (platform)' : row.account_id ? 'connected' : 'none'}, location ${row.location_id ? 'set' : 'none'}, cards ${row.card_payments || '?'}, payouts ${row.payouts || '?'}`);
    console.log(`Live keys on the server: ${/^(sk|rk)_live_/.test(liveKey) ? 'yes' : 'NO'}`);

    if (mode === 'sandbox') {
      if (!fs.existsSync(SANDBOX_FILE)) throw new Error('no saved sandbox row: nothing changed');
      const s = JSON.parse(fs.readFileSync(SANDBOX_FILE, 'utf8'));
      await db.execute('UPDATE epos_stripe_settings SET account_id = ?, location_id = ?, environment = ?, card_payments = ?, payouts = ? WHERE office = ?',
        [s.account_id, s.location_id, s.environment, s.card_payments, s.payouts, KITCHEN]);
      console.log('Kitchen: back on its sandbox row');
      return;
    }

    const live = row.environment === 'live' && row.account_id === 'platform' && row.location_id;
    if (live) console.log('Kitchen: already on live Stripe');
    else if (mode === 'check') console.log('Kitchen: would go live (run with --apply)');
    else {
      if (!/^(sk|rk)_live_/.test(liveKey)) throw new Error('STRIPE_LIVE_SECRET_KEY is not a live key on this server: nothing changed');
      if (!fs.existsSync(SANDBOX_FILE)) {
        fs.mkdirSync(path.dirname(SANDBOX_FILE), { recursive: true });
        fs.writeFileSync(SANDBOX_FILE, JSON.stringify(row), { mode: 0o600 });
        console.log('Kitchen sandbox row kept in tmp/kitchen-stripe-sandbox.json');
      }
      const loc = await liveLocation(row);
      console.log(`Live Terminal location: ${loc.made ? 'made' : 'found'}`);
      const hook = await liveWebhook();
      console.log(`Live webhook: ${hook.made ? 'made, secret in .env' : hook.secretSet ? 'there, secret in .env' : 'there, but .env has no secret for it (events are not verified; payments still settle by polling)'}`);
      restart = restart || hook.made;
      const [r] = await db.execute(
        "UPDATE epos_stripe_settings SET environment = 'live', account_id = 'platform', location_id = ?, card_payments = 'active', payouts = 'active' WHERE office = ?",
        [loc.id, KITCHEN]);
      console.log(`Kitchen: live (${r.affectedRows} row)`);
    }

    // 5. The ID check opened again for owners who were sent to step 3.
    let waiting = 0;
    try {
      const [[c]] = await db.query("SELECT COUNT(*) AS n FROM go_onboarding WHERE identity_status = 'via_connect' AND identity_session IS NULL");
      waiting = Number(c.n) || 0;
    } catch (e) {
      if (e.code !== 'ER_NO_SUCH_TABLE') throw e;
    }
    if (mode === 'apply' && waiting) {
      const [r] = await db.execute("UPDATE go_onboarding SET identity_status = NULL, identity_error = NULL WHERE identity_status = 'via_connect' AND identity_session IS NULL");
      console.log(`ID check opened again for ${r.affectedRows} venue(s)`);
    } else {
      console.log(`Venues whose ID check went to step 3: ${waiting}${waiting && mode === 'check' ? ' (opened again with --apply)' : ''}`);
    }
  } finally {
    await db.end();
  }
  console.log(`restart: ${restart ? 'yes' : 'no'}`);
}

main().catch((e) => {
  console.error(`! ${e.message}`);
  process.exit(1);
});
