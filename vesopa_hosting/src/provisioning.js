/**
 * Turning a paid order into working services.
 *
 * Called from exactly one place today — an admin marking an order paid — and
 * designed so the payment gateway's webhook can call the same function
 * unchanged when it arrives. That is the whole reason it is a module and not a
 * block inside the admin route.
 *
 * ## Two rules
 *
 * **Idempotent.** A webhook that fires twice, or an admin who double-clicks,
 * must not create two Hestia accounts or register a domain twice. Every step
 * checks its own row's status first and returns early if the work is done.
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
const { sendMail, shell, detailTable, escapeHtml } = require('./mailer');
const { SITE_URL, NAMESERVERS } = require('./config');

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
// Hosting
// ---------------------------------------------------------------------------
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

  const result = await hestia.provision({
    username,
    password,
    email: customer.email,
    package: plan.hestia_package,
    name: `${customer.first_name} ${customer.last_name}`.trim() || customer.email,
    domain: service.primary_domain || '',
  });

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

  return { ok: true, username, password, server, steps: result.steps || [], warning: result.warning };
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
      await stepStart(orderId, `ssl-${service.id}`);
      await atLeast(MIN_STEP_MS, Date.now());
      await stepEnd(orderId, `ssl-${service.id}`,
        r.warning ? 'skipped' : 'ok',
        r.warning || (service.primary_domain ? 'HTTPS is on' : 'Ready when your domain points at us'));
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
  provisionOrder,
  provisionService,
  provisionDomain,
  allocateUsername,
  pickServer,
  dueDate,
};
