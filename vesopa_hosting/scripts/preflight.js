/**
 * Go-live preflight: ask every external thing this site depends on whether it
 * actually works, and say so in one screen.
 *
 *     npm run preflight
 *
 * READ-ONLY BY DESIGN. It lists, reads and authenticates; it registers nothing,
 * provisions nothing and charges nobody, so it is safe to run against
 * production at any time — including as the first thing after a deploy.
 *
 * The point is the failures it catches BEFORE a customer does. Every check here
 * exists because the thing it tests fails in a way that looks like success from
 * the outside: a gateway quietly in test mode still shows a green order, a
 * missing Hestia package fails only after the money has moved, a registrar with
 * no balance fails only on the registration itself. None of those show up on
 * the site until somebody has paid.
 *
 * Exit code is 1 if anything is a FAIL, 0 otherwise. WARNs do not fail the run
 * — they are things that are working but are not what you want on launch day.
 */

require('dotenv').config();

const db = require('../src/db');
const hestia = require('../src/integrations/hestia');
const registrar = require('../src/integrations/domainnameapi');
const btcpay = require('../src/integrations/btcpay');
const sslcommerz = require('../src/integrations/sslcommerz');
const stripe = require('../src/integrations/stripe');
const payments = require('../src/payments');
const currency = require('../src/currency');
const dns = require('dns').promises;
const { SITE_URL, NAMESERVERS } = require('../src/config');

let failed = 0;
let warned = 0;

const PASS = (m, d) => console.log(`  \x1b[32mPASS\x1b[0m  ${m}${d ? ` — ${d}` : ''}`);
const WARN = (m, d) => { warned += 1; console.log(`  \x1b[33mWARN\x1b[0m  ${m}${d ? ` — ${d}` : ''}`); };
const FAIL = (m, d) => { failed += 1; console.log(`  \x1b[31mFAIL\x1b[0m  ${m}${d ? ` — ${d}` : ''}`); };
const head = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

/** Run one check, turning a thrown error into a FAIL rather than a stack trace. */
async function check(label, fn) {
  try {
    await fn();
  } catch (err) {
    FAIL(label, err.message);
  }
}

(async () => {
  console.log(`\nVesopa Hosting preflight — ${SITE_URL}\n${'='.repeat(60)}`);

  // -------------------------------------------------------------------------
  head('Database');
  await check('database', async () => {
    const [{ n }] = await db.query('SELECT COUNT(*) AS n FROM plans WHERE active = 1');
    PASS('connected', `${n} active plan(s)`);
    if (!n) FAIL('there are no active plans — the site has nothing to sell');

    /*
     * The collation trap. MariaDB 11.4 defaults a bare utf8mb4 column to
     * uca1400_ai_ci, and a JOIN between that and utf8mb4_general_ci fails at
     * runtime with "Illegal mix of collations" — on whichever page happens to
     * join those two tables, long after the deploy looked fine.
     */
    const wrong = await db.query(
      `SELECT table_name, column_name, collation_name
         FROM information_schema.columns
        WHERE table_schema = DATABASE() AND collation_name IS NOT NULL
          AND collation_name <> 'utf8mb4_general_ci'`,
    );
    if (wrong.length) {
      FAIL(`${wrong.length} column(s) are not utf8mb4_general_ci`,
        wrong.slice(0, 3).map((c) => `${c.table_name}.${c.column_name}=${c.collation_name}`).join(', '));
    } else {
      PASS('every column is utf8mb4_general_ci');
    }
  });

  // -------------------------------------------------------------------------
  head('Currencies');
  await check('currencies', async () => {
    const { all, base } = await currency.load({ includeInactive: true, fresh: true });
    const active = all.filter((c) => c.active);
    PASS('catalogue loaded', `base ${base.code}, selling ${active.map((c) => c.code).join(', ')}`);

    // SSLCommerz settles in taka and the rate lives in an inactive row, so a
    // missing one only shows up when somebody tries to pay.
    if (sslcommerz.status().mode !== 'mock') {
      const settle = all.find((c) => c.code === payments.SETTLE_CURRENCY);
      if (!settle || !Number(settle.rate)) {
        FAIL(`no ${payments.SETTLE_CURRENCY} rate — SSLCommerz payments will fail at the charge step`);
      } else {
        PASS(`${payments.SETTLE_CURRENCY} rate present for SSLCommerz`, `1 ${base.code} = ${settle.rate}`);
      }
    }
  });

  // -------------------------------------------------------------------------
  head('Hosting node (HestiaCP)');
  await check('hestia', async () => {
    const st = hestia.status();
    if (!st.live) {
      WARN(`node is in ${st.mode.toUpperCase()} mode`, 'no hosting account will actually be created');
      return;
    }
    if (!st.configured) {
      /*
       * Nearly always a mangled value rather than a missing one. dotenv treats
       * an unquoted `#` as the start of a comment, so a password beginning with
       * one parses as the empty string and this reads as "not configured" — the
       * message points at the likely cause rather than at the symptom.
       */
      FAIL('the node has a host but no usable credential',
        'if HESTIA_ADMIN_PASSWORD starts with #, quote it — dotenv reads it as a comment otherwise');
      return;
    }
    PASS('mode', `live, ${st.host}:${st.port}, auth by ${st.auth}`);
    if (st.auth === 'admin password') {
      WARN('authenticating with the panel root password',
        'an access key (v-add-access-key) can be limited to the commands this app needs');
    }
    if (!st.verify_tls) WARN('TLS verification is off for the node');

    // Authentication, TLS and the API allow-list, in one call.
    const users = await hestia.listPackages();
    PASS('the API answers and authenticates', `${users.length} package(s) on the node`);

    // The not-exist branch provisioning rides on.
    const ghost = await hestia.userExists('preflightnobody');
    if (ghost === false) PASS('a missing account reads as missing, not as an error');
    else FAIL('userExists() did not answer false for an account that is not there');

    // The check that catches a paid order failing to provision.
    const wanted = (await db.query('SELECT DISTINCT hestia_package FROM plans WHERE active = 1'))
      .map((r) => r.hestia_package);
    const missing = await hestia.missingPackages(wanted);
    if (missing.length) {
      FAIL(`the node has no package called ${missing.join(', ')}`,
        'an order for that plan will be PAID FOR and then fail — run scripts/create-hestia-packages.sh');
    } else {
      PASS('every active plan names a package the node has', wanted.join(', '));
    }
  });

  // -------------------------------------------------------------------------
  head('Registrar (DomainNameAPI)');
  await check('registrar', async () => {
    const st = registrar.status();
    if (st.mode !== 'live') {
      WARN(`registrar is in ${st.mode.toUpperCase()} mode`, 'no domain will actually be registered');
    } else {
      PASS('mode', 'live');
    }
    if (typeof registrar.balance === 'function') {
      const bal = await registrar.balance().catch((e) => ({ ok: false, error: e.message }));
      if (bal && bal.ok !== false) {
        const amount = Number(bal.balance ?? bal.amount ?? 0);
        const cur = bal.currency || 'USD';
        // A .co.uk is about $9. Anything under that and the next registration
        // fails at the registry, after the customer has paid for it.
        if (amount < 25) FAIL(`reseller balance is ${amount} ${cur}`, 'too low to register a domain — fund the account');
        else PASS('reseller balance', `${amount} ${cur}`);
      } else {
        WARN('could not read the reseller balance', bal && bal.error);
      }
    }
  });

  // -------------------------------------------------------------------------
  head('Payment gateways');
  await check('gateways', async () => {
    const list = payments.gateways();
    const live = list.filter((g) => g.available && !g.mock);
    if (!live.length) FAIL('no gateway can take real money');
    else PASS('gateways that can take real money', live.map((g) => g.name).join(', '));

    /*
     * Offered AND unable to charge is the dangerous combination: the customer
     * completes an order and pays nothing. In production the gateway list
     * refuses to offer those at all, so this can only fire on a box whose
     * NODE_ENV is not production — which, on the live server, is itself the bug.
     */
    list.filter((g) => g.available && g.mock).forEach((g) => {
      FAIL(`${g.name} is offered but cannot take real money`,
        'an order paid this way is provisioned without being charged');
    });
    list.filter((g) => !g.available).forEach((g) => {
      WARN(`${g.name} is not offered at checkout`, g.reason);
    });
    if (stripe.status().mode === 'live' && !stripe.status().configured) {
      FAIL('Stripe says live but has no secret key');
    }
  });

  // -------------------------------------------------------------------------
  head('Crypto (BTCPay)');
  await check('btcpay', async () => {
    const st = btcpay.status();
    if (st.mode !== 'live') {
      WARN(`BTCPay is in ${st.mode.toUpperCase()} mode`);
      return;
    }
    if (!st.configured) { FAIL('BTCPay says live but has no API key or store id'); return; }

    const reachable = await btcpay.storeReachable();
    if (!reachable) { FAIL('the BTCPay store will not answer our key', `${st.base} / ${st.store}`); return; }
    PASS('the store answers and our key is accepted', st.base);

    if (!st.webhook) {
      WARN('BTCPAY_WEBHOOK_SECRET is not set',
        'payments still settle, but on the reconciler poll rather than on confirmation');
    } else {
      PASS('a webhook secret is set');
    }
  });

  // -------------------------------------------------------------------------
  head('Nameservers');
  await check('nameservers', async () => {
    /*
     * The whole domain and hosting business rests on these two names, and they
     * are the easiest thing on the list to forget: they are handed to every
     * customer, written onto every domain registered through us, and set as
     * the delegation at the registry. If they do not resolve, a domain pointed
     * at us goes nowhere — and it fails silently, because the customer has done
     * their part correctly and every screen on our side says the domain is set
     * up. src/jobs.js suspends the domain sweep entirely while this is true.
     */
    for (const ns of NAMESERVERS) {
      try {
        const ips = await dns.resolve4(ns);
        PASS(ns, ips.join(', '));
      } catch {
        FAIL(`${ns} does not resolve`,
          'nobody can point a domain at us — it needs an A record in its own zone');
      }
    }
  });

  // -------------------------------------------------------------------------
  head('Site configuration');
  await check('site', async () => {
    if (/localhost|127\.0\.0\.1/.test(SITE_URL)) {
      FAIL('SITE_URL points at localhost',
        'gateways fetch and redirect to it from their own servers, so no callback can ever arrive');
    } else if (!SITE_URL.startsWith('https://')) {
      FAIL('SITE_URL is not https');
    } else {
      PASS('SITE_URL', SITE_URL);
    }

    if (process.env.ADMIN_PASSWORD) {
      WARN('ADMIN_PASSWORD is still in .env', 'blank it once the owner account has been seeded');
    }
    if (process.env.NODE_ENV !== 'production') {
      WARN(`NODE_ENV is "${process.env.NODE_ENV || 'unset'}"`, 'expected production on the live server');
    }
  });

  console.log(`\n${'='.repeat(60)}`);
  console.log(failed ? `\x1b[31m${failed} failure(s)\x1b[0m, ${warned} warning(s)\n`
    : `\x1b[32mAll checks passed\x1b[0m, ${warned} warning(s)\n`);

  await db.pool.end().catch(() => {});
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error('\npreflight itself failed:', err.message);
  process.exit(1);
});
