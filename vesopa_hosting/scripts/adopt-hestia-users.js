/**
 * Bring accounts that already exist on the node into this site.
 *
 * WHY THIS EXISTS
 *
 * The panel is driven by rows in `customers` and `services`, not by what is on
 * the node. Accounts made directly in HestiaCP — the ones that were there
 * before this site existed, or that somebody added by hand — have no rows, so
 * they are invisible here: no sign-in, no sites, no mailboxes, no databases.
 * The node happily serves them and this site cannot see them.
 *
 * This walks the node, and for every account with no customer row it writes
 * one, gives it a service so the panel has something to show, and imports its
 * web domains. It is idempotent: an account already adopted is left alone, so
 * it is safe to run again after adding another by hand.
 *
 *     ADOPT_PASSWORD='...' node scripts/adopt-hestia-users.js
 *     ADOPT_PASSWORD='...' node scripts/adopt-hestia-users.js --dry-run
 *     ADOPT_PASSWORD='...' node scripts/adopt-hestia-users.js --set-node-password
 *
 * ADOPT_PASSWORD is the password the adopted customer signs in HERE with. It is
 * required — there is no default, because a default would be a known password
 * on real accounts. `--set-node-password` additionally sets the same password on
 * the HestiaCP account itself, which is a separate credential and is NOT touched
 * unless you ask.
 *
 * `--skip USER,USER` leaves accounts alone. Hestia's own admin account is
 * skipped by default: it owns the panel rather than a customer's websites, and
 * handing it a customer login here would put the whole node behind one.
 */

require('dotenv').config();

const db = require('../src/db');
const auth = require('../src/auth');
const hestia = require('../src/integrations/hestia');

const DRY = process.argv.includes('--dry-run');
const SET_NODE_PASSWORD = process.argv.includes('--set-node-password');
const PASSWORD = process.env.ADOPT_PASSWORD || '';

const skipArg = process.argv.indexOf('--skip');
const SKIP = new Set(
  (skipArg > -1 ? String(process.argv[skipArg + 1] || '') : '')
    .split(',').map((s) => s.trim()).filter(Boolean),
);

const say = (m) => console.log(`  ${m}`);

/**
 * The plan an adopted account is put on.
 *
 * INACTIVE, deliberately. A service row has to name a plan, and every plan on
 * the catalogue is for sale — adding a real one called "default" would put
 * unlimited hosting on the pricing page at whatever price it carried. An
 * inactive plan is invisible to the shop, to `create-hestia-packages.sh` and to
 * preflight's "what do we sell" count, and still perfectly valid to point a
 * service at.
 */
async function staffPlan(hestiaPackage) {
  const slug = `adopted-${hestiaPackage}`;
  const found = await db.one('SELECT * FROM plans WHERE slug = ? LIMIT 1', [slug]);
  if (found) return found;
  if (DRY) return { id: 0, slug };

  await db.query(
    `INSERT INTO plans
       (slug, name, tagline, monthly_pence, annual_pence, biennial_pence, triennial_pence,
        websites, storage_gb, bandwidth_gb, \`databases\`, mailboxes,
        free_domain, free_ssl, daily_backups, priority_support,
        hestia_package, sort_order, active)
     VALUES (?, ?, ?, 0, 0, 0, 0, 999, 999, 0, 999, 999, 0, 1, 1, 1, ?, 900, 0)`,
    [slug, `Adopted (${hestiaPackage})`,
      'An account that already existed on the node. Not for sale.', hestiaPackage],
  );
  return db.one('SELECT * FROM plans WHERE slug = ? LIMIT 1', [slug]);
}

/**
 * Is `name` a subdomain of something else this account holds?
 *
 * Compared against the account's own list rather than by counting labels,
 * because label counting cannot tell `test.vesopa.com` (a subdomain) from
 * `vesopa.co.uk` (not one), and gets every multi-part TLD wrong.
 */
function parentOf(name, all) {
  return all.find((other) => other !== name && name.endsWith(`.${other}`)) || null;
}

(async () => {
  console.log('\nAdopting HestiaCP accounts into the panel\n');

  if (!hestia.isLive()) {
    console.error('  Hestia is not in live mode — there is nothing to read.\n');
    process.exit(1);
  }
  if (!PASSWORD && !DRY) {
    console.error('  Set ADOPT_PASSWORD to the password these accounts should sign in with.\n');
    process.exit(1);
  }
  const problem = PASSWORD && auth.passwordProblem(PASSWORD);
  if (problem) {
    console.error(`  That password will not do: ${problem}\n`);
    process.exit(1);
  }

  const users = await hestia.listUsers();
  const names = Object.keys(users).filter((u) => !SKIP.has(u));

  for (const username of names) {
    const info = users[username] || {};
    console.log(`\n${username}  (${info.CONTACT || 'no contact address'})`);

    const already = await db.one('SELECT * FROM customers WHERE hestia_user = ? LIMIT 1', [username]);
    if (already) { say('already adopted — left alone'); continue; }

    const email = String(info.CONTACT || '').trim().toLowerCase();
    if (!email || !email.includes('@')) {
      say('SKIPPED: the account has no contact email, and the email is the login here');
      continue;
    }

    /*
     * The email is the identity on this site and it is unique. If it is already
     * taken, the safe move is to attach this node account to that customer
     * rather than to invent a second login for the same person — but only when
     * that customer has no node account of their own, or we would be moving
     * their hosting.
     */
    const byEmail = await db.one('SELECT * FROM customers WHERE email = ? LIMIT 1', [email]);
    if (byEmail && byEmail.hestia_user) {
      say(`SKIPPED: ${email} already signs in here and owns ${byEmail.hestia_user}`);
      continue;
    }

    const [first, ...rest] = String(info.NAME || '').trim().split(/\s+/);
    const plan = await staffPlan(info.PACKAGE || 'default');
    const webDomains = (await hestia.listWebDomains(username)).map((d) => d.domain);
    // listMailDomains returns records, not names — read it once per account
    // rather than per domain, and compare on the name.
    const mailDomains = (await hestia.listMailDomains(username)).map((d) => d.domain);

    say(`plan ${plan.slug}, ${webDomains.length} web domain(s): ${webDomains.join(', ') || 'none'}`);
    if (DRY) { say('dry run — nothing written'); continue; }

    const hash = await auth.hashPassword(PASSWORD);
    let customerId;

    if (byEmail) {
      await db.query('UPDATE customers SET hestia_user = ? WHERE id = ?', [username, byEmail.id]);
      customerId = byEmail.id;
      say(`linked to the existing customer ${email}`);
    } else {
      const res = await db.query(
        `INSERT INTO customers
           (email, password_hash, first_name, last_name, email_verified, status, hestia_user)
         VALUES (?, ?, ?, ?, 1, 'active', ?)`,
        // Verified on sight: the address came off the node's own account
        // record, not from somebody typing it into a form.
        [email, hash, first || '', rest.join(' '), username],
      );
      customerId = res.insertId;
      say(`created customer #${customerId} — signs in as ${email}`);
    }

    const service = await db.query(
      `INSERT INTO services
         (customer_id, plan_id, status, term_months, price_pence, currency,
          primary_domain, provisioned_at)
       VALUES (?, ?, 'active', 12, 0, 'GBP', ?, NOW())`,
      [customerId, plan.id, webDomains[0] || ''],
    );
    say(`service #${service.insertId} (${webDomains[0] || 'no primary domain'})`);

    for (const domain of webDomains) {
      const exists = await db.one('SELECT id FROM domains WHERE domain = ? LIMIT 1', [domain]);
      if (exists) { say(`${domain} — already recorded`); continue; }

      const parent = parentOf(domain, webDomains);
      const tld = parent ? '' : domain.split('.').slice(1).join('.');

      await db.query(
        `INSERT INTO domains
           (customer_id, service_id, domain, tld, status, source, auto_renew,
            dns_enabled, mail_enabled, ns_verified_at, pointed_at)
         VALUES (?, ?, ?, ?, 'active', ?, 0, ?, ?, NOW(), NOW())`,
        // Verified and pointed on sight: the node is already serving it, which
        // is stronger evidence than the DNS check these columns usually record.
        [
          customerId, service.insertId, domain, tld,
          parent ? 'subdomain' : 'external',
          await hestia.dnsDomainExists({ username, domain }) ? 1 : 0,
          mailDomains.includes(domain) ? 1 : 0,
        ],
      );
      say(`${domain} — imported as ${parent ? `subdomain of ${parent}` : 'a domain'}`);
    }

    if (SET_NODE_PASSWORD) {
      await hestia.changeUserPassword({ username, password: PASSWORD })
        .then(() => say('node password set to match'))
        .catch((e) => say(`node password NOT set: ${e.message}`));
    }
  }

  console.log('\nDone.\n');
  await db.pool.end();
  process.exit(0);
})().catch((err) => {
  console.error('\nFailed:', err.message, '\n');
  process.exit(1);
});
