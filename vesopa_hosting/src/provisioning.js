/**
 * Turning a paid order into working services.
 *
 * ## The order of events
 *
 * Checkout writes an ORDER and its LINES, and nothing else. No service, no
 * domain, no mailbox subscription — an unpaid order puts nothing in anybody's
 * account. `materialiseOrder()` creates those rows the moment the money is
 * confirmed, `provisionOrder()` then makes them real on the node and at the
 * registrar, and `activateOrder()` is the one door both halves are reached
 * through. Every path that can confirm a payment — the browser return, the
 * gateway's IPN, the reconciler, an admin marking an order paid by hand — calls
 * that same function.
 *
 * ## Three rules
 *
 * **Nothing before the money.** The account is what has been paid for. A
 * pending order that is never paid leaves no service to explain, no domain row
 * holding a name nobody bought, and nothing to clean up.
 *
 * **Idempotent.** A webhook that fires twice, an admin who double-clicks and
 * the reconciler arriving late must not create two Hestia accounts or register
 * a domain twice. Materialisation is guarded by `orders.activated_at` under a
 * row lock; every provisioning step checks its own row's status first.
 *
 * **Partial success is recorded, not thrown away.** If the hosting account is
 * created and the domain registration then fails, the account stays and the
 * domain is left pending with the reason attached. Rolling back a live account
 * because a second, unrelated step failed would be worse for the customer than
 * the inconsistency.
 */

const db = require('./db');
const hestia = require('./integrations/hestia');
const registrar = require('./integrations/domainnameapi');
const auth = require('./auth');
const linking = require('./domain-linking');
const nameservers = require('./nameservers');
const { sendMail, shell, detailTable, escapeHtml } = require('./mailer');
const { SITE_URL, NAMESERVERS } = require('./config');

/** The order states that mean the money is in. */
const PAID_STATES = ['paid', 'provisioning', 'active'];

// ---------------------------------------------------------------------------
// Live progress
//
// The customer watches this happen. Every step is announced before it starts
// and settled after, so the onboarding screen shows real state rather than a
// spinner and a guess.
//
// Every one of these swallows its own errors. A failure to write a progress row
// is a cosmetic problem; letting it abort a half-finished provision — leaving a
// Hestia account created and a database row saying it was not — is a real one.
// ---------------------------------------------------------------------------

/** Declare the steps up front so the screen can show the whole list greyed. */
async function planSteps(orderId, steps) {
  try {
    for (const [i, s] of steps.entries()) {
      await db.query(
        `INSERT INTO setup_steps (order_id, step_key, label, status, sort_order)
         VALUES (?, ?, ?, 'pending', ?)
         ON DUPLICATE KEY UPDATE label = VALUES(label), sort_order = VALUES(sort_order)`,
        [orderId, s.key, s.label, i * 10],
      );
    }
  } catch (err) {
    console.error('[setup] could not plan steps:', err.message);
  }
}

async function stepStart(orderId, key) {
  try {
    await db.query(
      `UPDATE setup_steps SET status = 'running', started_at = NOW(), detail = ''
        WHERE order_id = ? AND step_key = ?`,
      [orderId, key],
    );
  } catch (err) {
    console.error('[setup] step start:', err.message);
  }
}

async function stepEnd(orderId, key, status, detail = '') {
  try {
    await db.query(
      `UPDATE setup_steps SET status = ?, detail = ?, finished_at = NOW()
        WHERE order_id = ? AND step_key = ?`,
      [status, String(detail).slice(0, 400), orderId, key],
    );
  } catch (err) {
    console.error('[setup] step end:', err.message);
  }
}

/**
 * A visible minimum for a step that finishes instantly.
 *
 * This is presentation, not theatre for its own sake: a checklist where three
 * rows flick to done in the same frame reads as "nothing happened", and the
 * customer cannot tell what was actually set up for them. Small, and only ever
 * applied to steps that were already fast.
 */
const MIN_STEP_MS = 450;
async function atLeast(ms, started) {
  const left = ms - (Date.now() - started);
  if (left > 0) await new Promise((r) => setTimeout(r, left));
}

/**
 * Allocate a Hestia username for a customer that does not have one yet.
 * Suffixes on collision rather than failing, because two people called
 * `info@` is the normal case, not the exception.
 */
async function allocateUsername(customer) {
  if (customer.hestia_user) return customer.hestia_user;

  for (let attempt = 0; attempt < 30; attempt++) {
    const candidate = hestia.suggestUsername(customer.email, attempt ? String(attempt) : '');
    const taken = await db.one('SELECT id FROM customers WHERE hestia_user = ? LIMIT 1', [candidate]);
    if (taken) continue;
    // Also ask the node, in case a username exists there that we have no row
    // for — a hand-made account, or one left behind by a deleted customer.
    if (await hestia.userExists(candidate)) continue;

    await db.query('UPDATE customers SET hestia_user = ? WHERE id = ?', [candidate, customer.id]);
    return candidate;
  }
  throw new Error('Could not allocate a username for this customer.');
}

/** The node a new account goes on. Least-loaded active server that has room. */
async function pickServer() {
  const rows = await db.query(
    `SELECT s.*, (SELECT COUNT(*) FROM services v WHERE v.server_id = s.id AND v.status <> 'terminated') AS used
       FROM servers s
      WHERE s.active = 1
      ORDER BY used ASC, s.id ASC`,
  );
  const withRoom = rows.find((s) => s.used < s.max_accounts);
  return withRoom || rows[0] || null;
}

/** Add `months` to today, as a DATE string. */
function dueDate(months) {
  const d = new Date();
  d.setMonth(d.getMonth() + Number(months || 12));
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Writing a paid order into the account
// ---------------------------------------------------------------------------

/**
 * Create the service, domain and mailbox rows an order was bought for.
 *
 * THIS IS THE MOMENT SOMETHING JOINS THE ACCOUNT, and it is reached only from a
 * confirmed payment. Before it runs, an order is a quote: lines, a total and a
 * customer. After it runs, the customer owns a hosting account and the domains
 * on it, and the panel will show them.
 *
 * Guarded by `orders.activated_at` under `SELECT … FOR UPDATE`. The browser
 * return and the IPN routinely arrive within milliseconds of each other and
 * both call this; the row lock makes the second one wait, and it then sees the
 * timestamp the first one wrote and does nothing. Checking a status and acting
 * on it in two statements would leave a window, and that window is where a
 * customer gets two hosting accounts for one payment.
 *
 * @returns {Promise<{ok: boolean, already?: boolean, reason?: string, created?: object}>}
 */
async function materialiseOrder(orderId) {
  return db.transaction(async (conn) => {
    const [[order]] = await conn.query('SELECT * FROM orders WHERE id = ? FOR UPDATE', [orderId]);
    if (!order) return { ok: false, reason: 'unknown_order' };
    if (!PAID_STATES.includes(order.status)) return { ok: false, reason: 'not_paid' };
    if (order.activated_at) return { ok: true, already: true };

    const [[customer]] = await conn.query('SELECT * FROM customers WHERE id = ? LIMIT 1', [order.customer_id]);
    if (!customer) return { ok: false, reason: 'unknown_customer' };

    const [items] = await conn.query('SELECT * FROM order_items WHERE order_id = ? ORDER BY id', [orderId]);
    const created = { services: 0, domains: 0, emails: 0, skipped: [] };

    for (const line of items) {
      /*
       * A line that cannot say what it is for is recorded and skipped, never
       * guessed at. The only way to reach this is an order placed before the
       * lines carried `email_plan_id` and paid afterwards, which is a handful
       * of rows at most — and a wrong guess would provision somebody the wrong
       * plan, which is far worse than an admin having to read a log line.
       */
      if ((line.kind === 'hosting' && !line.plan_id) || (line.kind === 'email' && !line.email_plan_id)) {
        created.skipped.push(`${line.description} (no plan on the line)`);
        continue;
      }

      if (line.kind === 'hosting' && line.plan_id) {
        await conn.query(
          `INSERT INTO services
             (customer_id, plan_id, order_id, primary_domain, status, term_months, price_pence,
              currency, free_domain_eligible, free_domain_claimed, setup_step)
           VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
          [
            order.customer_id, line.plan_id, order.id, line.domain || '',
            line.term_months, line.total_pence, order.currency,
            line.free_domain_eligible ? 1 : 0,
            line.free_domain_spent ? 1 : 0,
            /*
             * Where the wizard opens. Exactly the rule checkout used to apply,
             * moved here with the row it belongs to: there is nothing to ask if
             * the customer already named a domain and has no free one owing.
             */
            (line.free_domain_eligible && !line.free_domain_spent) || !line.domain
              ? 'domain'
              : 'provisioning',
          ],
        );
        created.services += 1;
      }

      if (line.kind === 'email' && line.email_plan_id) {
        await conn.query(
          `INSERT INTO email_services
             (customer_id, email_plan_id, order_id, domain, units, status, term_months,
              price_pence, currency)
           VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
          [
            order.customer_id, line.email_plan_id, order.id, line.domain || '',
            line.qty || 1, line.term_months, line.total_pence, order.currency,
          ],
        );
        created.emails += 1;
      }

      if (line.kind === 'domain' || line.kind === 'domain_transfer') {
        /*
         * `domains.domain` is unique across the whole table, and by the time an
         * order is paid somebody else may hold the row — a name registered
         * through us in the meantime, or one another customer added to their
         * own account. Taking it over would move a live domain between
         * accounts, so the line is skipped, recorded, and left for a human. The
         * registration itself has not happened yet, so nothing is lost but the
         * automation.
         */
        const [[existing]] = await conn.query(
          'SELECT * FROM domains WHERE domain = ? LIMIT 1',
          [line.domain],
        );
        const claimable = !existing
          || (existing.customer_id === order.customer_id
              && ['removed', 'cancelled', 'expired'].includes(existing.status));

        if (!claimable) {
          created.skipped.push(`${line.domain} (already held by another account)`);
          continue;
        }

        const source = line.kind === 'domain_transfer' ? 'transfer' : 'registered';
        if (existing) {
          await conn.query(
            `UPDATE domains
                SET order_id = ?, status = 'pending', source = ?, years = ?,
                    ns1 = ?, ns2 = ?, ns_verified_at = NULL, ns_grace_until = NULL
              WHERE id = ?`,
            [order.id, source, line.years || 1, NAMESERVERS[0], NAMESERVERS[1], existing.id],
          );
        } else {
          await conn.query(
            `INSERT INTO domains (customer_id, order_id, domain, tld, status, source, years, ns1, ns2)
             VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
            [
              order.customer_id, order.id, line.domain,
              registrar.splitDomain(line.domain).tld, source, line.years || 1,
              NAMESERVERS[0], NAMESERVERS[1],
            ],
          );
        }
        created.domains += 1;
      }
    }

    await conn.query('UPDATE orders SET activated_at = NOW() WHERE id = ?', [order.id]);
    return { ok: true, already: false, created };
  });
}

/**
 * A payment has been confirmed: build the account, then set it running.
 *
 * The single entry point for every route that can learn an order is paid. It
 * exists so that "what happens when money arrives" is written once — the
 * browser return, the IPN, the reconciler and the admin's own button used to
 * each carry their own copy of the waiting-for-a-domain rule, and three of the
 * four would have been wrong the first time it changed.
 *
 * Provisioning is NOT awaited by default. It talks to a registrar and a hosting
 * node and can take a minute; the customer is mid-redirect and the setup screen
 * polls `setup_steps` for the progress. The admin's button passes
 * `awaitProvisioning` because it has a result to report.
 */
async function activateOrder(orderId, {
  actorType = 'system', actorId = null, ip = '', awaitProvisioning = false,
} = {}) {
  const materialised = await materialiseOrder(orderId);
  if (!materialised.ok) return { ...materialised, waiting: false };

  /*
   * Anything the order paid for that could not be built. Logged rather than
   * thrown: the rest of the order is real and must go live, and this is a
   * message for a human to act on with the customer.
   */
  if (materialised.created?.skipped?.length) {
    await db.logActivity({
      actorType: 'system',
      action: 'order.line_not_built',
      target: `order#${orderId}`,
      detail: `Needs a human: ${materialised.created.skipped.join(', ')}`,
      ok: false,
    });
  }

  /*
   * A hosting service still sitting at the `domain` step is waiting to be told
   * which domain it is for, including the free one it is owed. Provisioning now
   * would answer that with "none" before the customer ever saw the question,
   * and the free domain would be quietly lost.
   */
  const waiting = await db.one(
    `SELECT id FROM services WHERE order_id = ? AND setup_step = 'domain' AND status = 'pending' LIMIT 1`,
    [orderId],
  );
  if (waiting) return { ...materialised, waiting: true };

  const running = provisionOrder(orderId, { actorType, actorId, ip });
  if (!awaitProvisioning) {
    running.catch((err) => console.error('[activate] provisioning failed:', err.message));
    return { ...materialised, waiting: false, started: true };
  }
  return { ...materialised, waiting: false, provisioned: await running };
}

// ---------------------------------------------------------------------------
// Hosting
// ---------------------------------------------------------------------------

/**
 * May we build a website for this name on the node?
 *
 * A domain sold through us: yes — we set the nameservers to ours at the
 * registry ourselves, and the delegation follows within the hour. A domain the
 * customer merely typed in: only once the public DNS says it is delegated here.
 * The distinction is what stops one customer having a site, a mailbox and a
 * certificate stood up for a domain that belongs to somebody else.
 */
async function serveableDomain(name) {
  if (!name) return { allowed: false, row: null };
  const row = await db.one('SELECT * FROM domains WHERE domain = ? LIMIT 1', [name]);
  if (row) return { allowed: linking.mayPoint(row), row };
  // No row at all — an older service, or one typed straight onto the record.
  // Fall back to asking the DNS, which is the same evidence by another route.
  const check = await nameservers.check(name);
  return { allowed: check.matched, row: null, check };
}

async function provisionService(service, customer) {
  if (service.status !== 'pending') {
    return { skipped: true, reason: `Service is already ${service.status}.` };
  }

  const plan = await db.one('SELECT * FROM plans WHERE id = ? LIMIT 1', [service.plan_id]);
  if (!plan) throw new Error(`Plan ${service.plan_id} no longer exists.`);

  const username = await allocateUsername(customer);
  const server = await pickServer();

  // The customer never types this. It exists so Hestia has a credential for
  // the account, and so support can hand it over if someone ever genuinely
  // needs SFTP or SSH.
  const password = auth.generatePassword(20);

  /*
   * The account is created either way; only the WEBSITE waits on the domain.
   * A customer whose domain is still propagating still gets storage, databases
   * and an FTP login they can start uploading to — and the sweep adds the site
   * the moment the delegation lands. Refusing to create the account at all
   * would leave them with nothing to do for three hours.
   */
  const serveable = await serveableDomain(service.primary_domain);

  const result = await hestia.provision({
    username,
    password,
    email: customer.email,
    package: plan.hestia_package,
    name: `${customer.first_name} ${customer.last_name}`.trim() || customer.email,
    domain: serveable.allowed ? service.primary_domain : '',
  });
  result.domainWaiting = Boolean(service.primary_domain) && !serveable.allowed;

  await db.query(
    `UPDATE services
        SET status = 'active', server_id = ?, provisioned_at = NOW(), next_due_at = ?
      WHERE id = ?`,
    [server ? server.id : null, dueDate(service.term_months), service.id],
  );

  await db.logActivity({
    actorType: 'system',
    action: 'service.provisioned',
    target: service.primary_domain || `service#${service.id}`,
    detail: JSON.stringify(result.steps || []),
    ok: true,
  });

  return {
    ok: true,
    username,
    password,
    server,
    steps: result.steps || [],
    warning: result.warning,
    domainWaiting: result.domainWaiting,
  };
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

/**
 * A bought email plan.
 *
 * The two families provision completely differently, which is why they are
 * branched here rather than pretended to be one thing:
 *
 *   business   Real infrastructure. Hestia owns mail domains at the user level,
 *              so the customer needs an account on the node even if they host
 *              no website with us. If they already have one from a hosting
 *              order, it is reused — a second account would split their mail
 *              from their site for no reason.
 *
 *   marketing  Bulk sending is not something the hosting node does, and it must
 *              not be: a shared web server that starts sending campaigns gets
 *              its IP blocklisted and takes every customer's transactional mail
 *              down with it. So this records the subscription, flags it for a
 *              human, and does not touch the node. Honest, and documented as a
 *              manual step in the README rather than quietly half-built.
 */
async function provisionEmailService(row, customer) {
  if (row.status !== 'pending') {
    return { skipped: true, reason: `Email service is already ${row.status}.` };
  }

  const plan = await db.one('SELECT * FROM email_plans WHERE id = ? LIMIT 1', [row.email_plan_id]);
  if (!plan) throw new Error(`Email plan ${row.email_plan_id} no longer exists.`);

  if (plan.family === 'marketing') {
    await db.query(
      `UPDATE email_services
          SET status = 'pending', next_due_at = ?, notes = ?
        WHERE id = ?`,
      [dueDate(row.term_months), 'Awaiting manual setup on the sending platform.', row.id],
    );
    await db.logActivity({
      actorType: 'system',
      action: 'email.manual_setup_required',
      target: plan.slug,
      detail: `${row.units} × ${plan.unit_label} for ${customer.email}`,
      ok: true,
    });
    // Deliberately not an error: the order is valid and paid. It is reported as
    // a manual step so the admin screen says so instead of showing a failure.
    return { ok: true, manual: true, plan };
  }

  let username = customer.hestia_user;
  let password = null;

  if (!username) {
    username = await allocateUsername(customer);
    password = auth.generatePassword(20);
    await hestia.provision({
      username,
      password,
      email: customer.email,
      // Mailbox-only accounts get the smallest package; it exists to own the
      // mail domain, not to serve a site.
      package: 'starter',
      name: `${customer.first_name} ${customer.last_name}`.trim() || customer.email,
      domain: '',
    });
    await db.query('UPDATE customers SET hestia_user = ? WHERE id = ?', [username, customer.id]);
  }

  if (row.domain) {
    await hestia.addMailDomain({ username, domain: row.domain });
  }

  await db.query(
    `UPDATE email_services SET status = 'active', next_due_at = ? WHERE id = ?`,
    [dueDate(row.term_months), row.id],
  );

  await db.logActivity({
    actorType: 'system',
    action: 'email.provisioned',
    target: row.domain || plan.slug,
    detail: `${row.units} × ${plan.unit_label}`,
    ok: true,
  });

  return { ok: true, username, password, plan };
}

// ---------------------------------------------------------------------------
// Domains
// ---------------------------------------------------------------------------
async function provisionDomain(domainRow, customer) {
  if (domainRow.status !== 'pending') {
    return { skipped: true, reason: `Domain is already ${domainRow.status}.` };
  }

  /*
   * The registrant of record. For .uk this is a legal requirement rather than
   * a form field, which is why checkout insists on a real address when a domain
   * is involved.
   *
   * The customer row is passed AS IT IS. There used to be a remapping here into
   * PascalCase (`FirstName`, `EMail`, `AddressLine1`) left over from the SOAP
   * gateway, and when the adapter was rewritten for REST — which reads
   * snake_case — every field silently arrived empty. The registry rejected it
   * with "The EMail field is not a valid e-mail address", which is a long way
   * from "your key names do not match". One shape, defined once, in
   * `toContact()` in the adapter.
   */
  const result = await registrar.register({
    domain: domainRow.domain,
    years: domainRow.years || 1,
    contact: customer,
    nameservers: NAMESERVERS,
    privacy: Boolean(domainRow.privacy),
  });

  await db.query(
    `UPDATE domains
        SET status = 'active', registered_at = CURDATE(), expires_at = ?,
            registrar_ref = ?, ns1 = ?, ns2 = ?
      WHERE id = ?`,
    [result.expires_at || null, result.registrar_ref || '', NAMESERVERS[0], NAMESERVERS[1], domainRow.id],
  );

  /*
   * The registry has our nameservers, but the world does not know it yet —
   * delegation takes minutes to hours to publish. So the name is NOT marked
   * verified here on the strength of what we asked for; the sweep confirms it
   * against public DNS like every other domain, and builds the site when it
   * does. One rule, one place, no special case for names we happen to trust.
   */

  await db.logActivity({
    actorType: 'system',
    action: 'domain.registered',
    target: domainRow.domain,
    detail: result.mock ? 'MOCK — nothing was actually registered' : `ref ${result.registrar_ref}`,
    ok: true,
  });

  return { ok: true, ...result };
}

// ---------------------------------------------------------------------------
// The whole order
// ---------------------------------------------------------------------------

/**
 * Provision everything attached to an order.
 *
 * Never throws for a single failed step. The return value lists what worked and
 * what did not, so the admin sees "hosting live, domain failed: registrar
 * timeout" and can retry just the failed half.
 */
async function provisionOrder(orderId, { actorType = 'admin', actorId = null, ip = '' } = {}) {
  const order = await db.one('SELECT * FROM orders WHERE id = ? LIMIT 1', [orderId]);
  if (!order) throw new Error('Order not found.');

  const customer = await db.one('SELECT * FROM customers WHERE id = ? LIMIT 1', [order.customer_id]);
  if (!customer) throw new Error('Customer not found.');

  const services = await db.query('SELECT * FROM services WHERE order_id = ?', [orderId]);
  const domains = await db.query('SELECT * FROM domains WHERE order_id = ?', [orderId]);
  const emails = await db.query('SELECT * FROM email_services WHERE order_id = ?', [orderId]);

  const outcome = { services: [], domains: [], emails: [], credentials: null };

  /*
   * Announce the whole checklist before doing any of it, so the customer sees
   * what is going to happen rather than rows appearing one at a time out of
   * nowhere. Labels are written for someone who has just paid, not for an
   * engineer reading a log.
   */
  await planSteps(orderId, [
    ...services.map((s) => ({ key: `service-${s.id}`, label: 'Creating your hosting account' })),
    ...domains.map((d) => ({ key: `domain-${d.id}`, label: `Registering ${d.domain}` })),
    ...emails.map((e) => ({ key: `email-${e.id}`, label: 'Setting up your mailboxes' })),
    ...services.map((s) => ({ key: `ssl-${s.id}`, label: 'Issuing your SSL certificate' })),
    { key: 'finish', label: 'Finishing up' },
  ]);

  for (const service of services) {
    const key = `service-${service.id}`;
    const t0 = Date.now();
    await stepStart(orderId, key);
    try {
      const r = await provisionService(service, customer);
      outcome.services.push({ id: service.id, domain: service.primary_domain, ...r });
      if (r.ok) outcome.credentials = { username: r.username, password: r.password };
      await atLeast(MIN_STEP_MS, t0);
      await stepEnd(orderId, key, r.skipped ? 'skipped' : 'ok',
        r.skipped ? r.reason : `Account ready${r.server ? ` on ${r.server.name}` : ''}`);
      // SSL is reported separately because it is the step most likely to be
      // the slow or failing one, and hiding it inside "hosting account" would
      // make a working account look broken when only the certificate waited.
      //
      // A certificate cannot be issued for a name that does not resolve to us —
      // that is Let's Encrypt's rule, not ours — so a domain still waiting on
      // its nameservers is reported as waiting rather than as a failure.
      await stepStart(orderId, `ssl-${service.id}`);
      await atLeast(MIN_STEP_MS, Date.now());
      await stepEnd(orderId, `ssl-${service.id}`,
        r.warning || r.domainWaiting ? 'skipped' : 'ok',
        r.domainWaiting
          ? 'Waiting for your nameservers — we set this up automatically when they point at us'
          : r.warning || (service.primary_domain ? 'HTTPS is on' : 'Ready when your domain points at us'));
    } catch (err) {
      outcome.services.push({ id: service.id, domain: service.primary_domain, ok: false, error: err.message });
      await stepEnd(orderId, key, 'failed', err.message);
      await stepEnd(orderId, `ssl-${service.id}`, 'skipped', 'Waiting for the account');
      await db.logActivity({
        actorType, actorId, action: 'service.provision_failed',
        target: service.primary_domain || `service#${service.id}`, detail: err.message, ok: false, ip,
      });
    }
  }

  for (const domainRow of domains) {
    const key = `domain-${domainRow.id}`;
    const t0 = Date.now();
    await stepStart(orderId, key);
    try {
      const r = await provisionDomain(domainRow, customer);
      outcome.domains.push({ id: domainRow.id, domain: domainRow.domain, ...r });
      await atLeast(MIN_STEP_MS, t0);
      await stepEnd(orderId, key, r.skipped ? 'skipped' : 'ok',
        r.skipped ? r.reason : `${domainRow.domain} is yours`);
    } catch (err) {
      outcome.domains.push({ id: domainRow.id, domain: domainRow.domain, ok: false, error: err.message });
      await stepEnd(orderId, key, 'failed', err.message);
      await db.logActivity({
        actorType, actorId, action: 'domain.register_failed',
        target: domainRow.domain, detail: err.message, ok: false, ip,
      });
    }
  }

  for (const row of emails) {
    const key = `email-${row.id}`;
    const t0 = Date.now();
    await stepStart(orderId, key);
    try {
      const r = await provisionEmailService(row, customer);
      outcome.emails.push({ id: row.id, domain: row.domain, ...r });
      if (r.ok && r.password && !outcome.credentials) {
        outcome.credentials = { username: r.username, password: r.password };
      }
      await atLeast(MIN_STEP_MS, t0);
      await stepEnd(orderId, key,
        r.skipped ? 'skipped' : 'ok',
        r.manual ? 'We will finish this by hand and email you' : `${row.units} mailbox(es) ready`);
    } catch (err) {
      outcome.emails.push({ id: row.id, domain: row.domain, ok: false, error: err.message });
      await stepEnd(orderId, key, 'failed', err.message);
      await db.logActivity({
        actorType, actorId, action: 'email.provision_failed',
        target: row.domain || `email#${row.id}`, detail: err.message, ok: false, ip,
      });
    }
  }

  const everythingWorked =
    outcome.services.every((s) => s.ok || s.skipped)
    && outcome.domains.every((d) => d.ok || d.skipped)
    && outcome.emails.every((e) => e.ok || e.skipped);

  await stepStart(orderId, 'finish');
  await db.query('UPDATE orders SET status = ? WHERE id = ?', [
    everythingWorked ? 'active' : 'provisioning',
    orderId,
  ]);
  // The wizard is over either way. A partly-failed order still belongs in the
  // panel with what did work, not stuck behind a progress bar forever.
  await db.query(`UPDATE services SET setup_step = 'done' WHERE order_id = ?`, [orderId]);
  await stepEnd(orderId, 'finish', everythingWorked ? 'ok' : 'failed',
    everythingWorked ? 'Everything is ready' : 'Some steps need us to look at them');

  if (everythingWorked) await sendWelcome(order, customer, outcome);

  return { ...outcome, ok: everythingWorked };
}

/**
 * The welcome email — the single most important message this system sends.
 *
 * It carries the nameservers, because a customer whose domain is registered
 * elsewhere cannot do anything until they have them, and "log in to find them"
 * is one step too many at exactly the moment enthusiasm is highest.
 */
async function sendWelcome(order, customer, outcome) {
  const rows = [];

  const service = outcome.services.find((s) => s.ok);
  if (service) {
    rows.push(['Your website', escapeHtml(service.domain || 'Set up in your panel')]);
    if (service.username) rows.push(['Account username', `<span style="font-family:monospace">${escapeHtml(service.username)}</span>`]);
  }

  const registered = outcome.domains.filter((d) => d.ok).map((d) => d.domain);
  if (registered.length) rows.push(['Domains registered', registered.map(escapeHtml).join('<br>')]);

  rows.push([
    'Nameservers',
    `<span style="font-family:monospace">${NAMESERVERS.map(escapeHtml).join('<br>')}</span>`,
  ]);

  const sslPending = outcome.services.some((s) => (s.steps || []).some((st) => st.step === 'ssl' && !st.ok));

  await sendMail({
    to: customer.email,
    subject: 'Your hosting is live — Vesopa Hosting',
    html: shell({
      title: `You are live, ${escapeHtml(customer.first_name || 'there')}`,
      intro: 'Your hosting account is set up and ready. Everything below is also in your control panel.',
      bodyHtml: detailTable(rows),
      ctaText: 'Open your control panel',
      ctaUrl: `${SITE_URL}/panel`,
      footNote: sslPending
        ? 'Your SSL certificate could not be issued yet — that is normal when a domain is not pointing at us. Once you have set the nameservers above, click "Retry SSL" on the site in your panel and the padlock appears within a minute.'
        : 'Moving an existing site to us? Reply to this email with your current hosting login and we will do it for you, free.',
    }),
  });
}

module.exports = {
  PAID_STATES,
  materialiseOrder,
  activateOrder,
  provisionOrder,
  provisionService,
  provisionDomain,
  serveableDomain,
  allocateUsername,
  pickServer,
  dueDate,
};
