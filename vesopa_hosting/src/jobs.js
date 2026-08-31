/**
 * The work nobody is watching.
 *
 * Three duties, all of them the same shape: something outside this process
 * changes state and never tells us, so we go and look.
 *
 *   payments   a customer paid and closed the tab. The gateway knows; ask it.
 *   orders     a payment settled but the account was not built — the process
 *              restarted mid-flight, or provisioning threw. Finish it.
 *   domains    a nameserver change happened at somebody else's registrar. Check
 *              the public DNS, serve what now points here, and drop the
 *              external names that never will.
 *
 * ## Why a timer and not cron
 *
 * The app already runs under pm2 as a single process, and every one of these
 * jobs needs the same database pool, the same adapters and the same
 * provisioning code as the web routes. A cron entry would be a second copy of
 * the whole boot sequence maintained by hand in a crontab nobody reads. If this
 * ever runs on more than one node, JOB_INTERVAL_MINUTES=0 turns the timers off
 * on all but one of them.
 *
 * ## Rules
 *
 * Every job swallows its own errors and every one is capped by a batch size. A
 * sweep that throws must not take the web server down with it, and a queue that
 * has built up over a weekend must not open four hundred sockets at once.
 */

const db = require('./db');
const payments = require('./payments');
const provisioning = require('./provisioning');
const registrar = require('./integrations/domainnameapi');
const linking = require('./domain-linking');
const notify = require('./notifications');
const nameservers = require('./nameservers');
const {
  JOB_INTERVAL_MINUTES, PAYMENT_SESSION_MINUTES, DOMAIN_NS_GRACE_DAYS, NAMESERVERS,
} = require('./config');

/** How many rows one pass of a job will touch. */
const BATCH = Number(process.env.JOB_BATCH || 25);

/**
 * Do not ask the gateway about the same attempt more often than this.
 *
 * The jobs tick every few minutes and a payment session lives for over an hour;
 * without a floor, one abandoned checkout would be worth twenty API calls to
 * learn the same thing twenty times.
 */
const PAYMENT_RECHECK_MINUTES = Number(process.env.PAYMENT_RECHECK_MINUTES || 5);

/** And the same for a domain whose nameservers have not changed yet. */
const DOMAIN_RECHECK_MINUTES = Number(process.env.DOMAIN_RECHECK_MINUTES || 15);

/**
 * How long we keep probing a domain that has never pointed at us.
 *
 * External domains are dropped at the grace deadline and stop being asked
 * about there. This cap is for the other case: a domain registered through us
 * and pointed at a different host entirely, which is a perfectly legitimate
 * thing for a customer to do and not something to re-check for the rest of its
 * life. The panel's own "check now" button always works.
 */
const DOMAIN_PROBE_DAYS = Number(process.env.DOMAIN_PROBE_DAYS || 45);

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

/**
 * Settle, or close, every payment attempt still sitting open.
 *
 * The browser return and the IPN are the fast paths and this is the safety net
 * under both. It is the only path that exists at all for a customer who paid
 * and never came back.
 */
async function reconcilePayments() {
  const pending = await db.query(
    `SELECT * FROM payments
      WHERE status = 'pending'
        AND gateway_ref IS NOT NULL
        AND (last_checked_at IS NULL OR last_checked_at < DATE_SUB(NOW(), INTERVAL ? MINUTE))
      ORDER BY last_checked_at IS NOT NULL, last_checked_at ASC, id ASC
      LIMIT ?`,
    [PAYMENT_RECHECK_MINUTES, BATCH],
  );

  let settled = 0;
  let expired = 0;

  for (const payment of pending) {
    // Written before the call, not after: a gateway that times out on every
    // attempt would otherwise be retried on every tick forever.
    await db.query(
      'UPDATE payments SET last_checked_at = NOW(), checks = checks + 1 WHERE id = ?',
      [payment.id],
    );

    /*
     * When this attempt stops being worth asking about.
     *
     * `expires_at` is written when the attempt is opened — but rows that
     * predate that column have none, and a NULL treated as "never expires"
     * means those get polled for the rest of the server's life. There were
     * eight such rows on the live database the day this shipped, one of them a
     * PayPal order PayPal itself had already forgotten. So the age of the
     * attempt is the fallback, which reaches the same answer.
     */
    const deadline = payment.expires_at
      ? new Date(payment.expires_at)
      : new Date(new Date(payment.created_at).getTime() + PAYMENT_SESSION_MINUTES * 60_000);
    const dead = deadline < new Date();

    try {
      const result = await payments.reconcilePayment(payment);
      if (result.outcome === 'paid') {
        settled += 1;
        console.log(`[jobs] recovered payment ${payment.gateway_ref} (${payment.gateway}) from the gateway`);
        continue;
      }
      if (result.outcome === 'failed') continue;

      /*
       * Still open, or a gateway with nothing to ask. Either way, once the
       * session is dead the attempt is closed — the order stays pending and
       * the customer can start a fresh one, which is what "your payment did
       * not go through, nothing has been charged" has to mean to be true.
       */
      if (dead && await payments.expirePayment(payment)) expired += 1;
    } catch (err) {
      console.error(`[jobs] could not reconcile ${payment.gateway_ref}:`, err.message);
      if (dead && await payments.expirePayment(payment)) expired += 1;
    }
  }

  return { checked: pending.length, settled, expired };
}

/**
 * Orders that are paid but whose account was never built.
 *
 * The window this covers is small and real: `settle()` marks the payment and
 * the order inside one request, and if the process is restarted between that
 * and materialisation the customer has paid for an account that does not
 * exist. `activateOrder()` is idempotent, so re-running it on an order that is
 * merely mid-provision costs nothing.
 */
async function finishPaidOrders() {
  const orders = await db.query(
    `SELECT id, reference FROM orders
      WHERE status IN ('paid','provisioning','active')
        AND activated_at IS NULL
      ORDER BY id ASC LIMIT ?`,
    [BATCH],
  );

  let built = 0;
  for (const order of orders) {
    try {
      const result = await provisioning.activateOrder(order.id, { actorType: 'system' });
      if (result.ok) {
        built += 1;
        console.log(`[jobs] built the account for order ${order.reference} after the fact`);
      }
    } catch (err) {
      console.error(`[jobs] could not activate order ${order.reference}:`, err.message);
    }
  }
  return { built, found: orders.length };
}

// ---------------------------------------------------------------------------
// Domains
// ---------------------------------------------------------------------------

/**
 * Check delegations, serve what now points here, drop what never will.
 *
 * The query deliberately joins `customers`: a verified domain belonging to
 * somebody with no hosting account has nothing to be pointed AT, and including
 * it would mean re-checking it every quarter of an hour for no possible
 * outcome. It comes back into scope the moment they buy hosting, because that
 * is when `hestia_user` is filled in.
 */
/** When the nameserver complaint below was last written. See its note. */
let lastNsComplaint = 0;

/**
 * Adopt registrations the registry completed but our provisioning never
 * recorded. See the note in sweepDomains() for why this is safe to automate.
 *
 * Deliberately small: a handful per run, oldest first. A registrar that is
 * rate-limiting (429 on concurrent calls) must not be hammered by a sweep, and
 * there should never be many of these — if there are, something else is wrong
 * and the log will say so.
 */
async function adoptRegisteredDomains() {
  if (!registrar.isConnected()) return 0;

  const stuck = await db.query(
    `SELECT d.id, d.domain, d.customer_id, c.email
       FROM domains d
       JOIN customers c ON c.id = d.customer_id
      WHERE d.source = 'registered'
        AND d.status = 'pending'
        AND d.created_at > DATE_SUB(NOW(), INTERVAL 30 DAY)
      ORDER BY d.id
      LIMIT 5`,
  );
  if (!stuck.length) return 0;

  let adopted = 0;
  for (const row of stuck) {
    let info;
    try {
      info = await registrar.getDomain(row.domain);
    } catch {
      // Not at the registry: the registration really did fail and the row is
      // correctly pending. Nothing to do, and nothing to log every five minutes.
      continue;
    }
    if (!info?.ok) continue;

    const { tld } = registrar.splitDomain(row.domain);
    const needsVerify = provisioning.needsRegistrantVerification(tld);
    const startedAt = info.started_at ? new Date(info.started_at) : new Date();
    const deadline = needsVerify
      ? new Date(startedAt.getTime() + provisioning.RAA_VERIFY_DAYS * 864e5)
        .toISOString().slice(0, 19).replace('T', ' ')
      : null;

    await db.query(
      `UPDATE domains
          SET status = 'active',
              registrar_ref = ?,
              registered_at = COALESCE(registered_at, CURDATE()),
              expires_at = COALESCE(?, expires_at),
              ns1 = ?, ns2 = ?,
              registrant_email = IF(registrant_email = '', ?, registrant_email),
              verification_deadline = COALESCE(verification_deadline, ?)
        WHERE id = ? AND status = 'pending'`,
      [
        String(info.registrar_ref || ''),
        info.expires_at || null,
        NAMESERVERS[0] || '', NAMESERVERS[1] || '',
        row.email || '', deadline, row.id,
      ],
    );

    await db.logActivity({
      actorType: 'system', action: 'domain.reconciled', target: row.domain,
      detail: 'The registry held this name while our record said pending — adopted by the sweep.',
      ok: true,
    }).catch(() => {});

    await notify.raise({
      customerId: row.customer_id,
      level: 'success',
      area: 'domain',
      title: `${row.domain} is registered`,
      body: 'The registration completed. You can attach it to a hosting plan now, and we will '
        + 'build the site and its certificate automatically.',
      fixUrl: `/panel/domains/${row.id}#hosting`,
      fixLabel: 'Connect it to hosting',
      dedupeKey: `domain:${row.id}:registered`,
    }).catch(() => {});

    adopted += 1;
    console.log(`[jobs] adopted ${row.domain} — the registry had it, our record said pending`);
    await new Promise((r) => setTimeout(r, 800));
  }

  /*
   * An order sits at `provisioning` until everything on it is done. Adopting
   * the domain above is usually the last thing it was waiting for, so close
   * any order whose parts are now all complete — otherwise the customer's
   * panel goes on saying "setting up" about work that finished.
   */
  if (adopted) {
    await db.pool.query(
      `UPDATE orders o SET o.status = 'active'
        WHERE o.status = 'provisioning'
          AND NOT EXISTS (SELECT 1 FROM domains d
                           WHERE d.order_id = o.id AND d.status IN ('pending','awaiting_ns'))
          AND NOT EXISTS (SELECT 1 FROM services s
                           WHERE s.order_id = o.id AND s.status = 'pending')`,
    ).catch(() => {});
  }
  return adopted;
}

async function sweepDomains() {
  /*
   * Nothing happens if our own nameservers are not answering.
   *
   * Every domain in the table would fail its check, and the grace period would
   * then remove them all — for a failure that is ours, not the customer's. A
   * customer who did exactly what they were told, on the day our DNS was down,
   * must not lose their domain from the account for it.
   *
   * Loud, because this is not a state to sit in: while it lasts, nothing new
   * can be verified, pointed or certified.
   */
  const self = await nameservers.ourNameserversResolve();
  if (!self.ok) {
    /*
     * Said once an hour, not once a pass. It is a real fault and it has to stay
     * visible, but at a five-minute tick the unthrottled version writes 288
     * identical lines a day — which is how the one line that matters gets
     * missed. The condition is not going to change in the next five minutes;
     * whoever fixes it has to publish DNS.
     */
    if (Date.now() - lastNsComplaint > 3600_000) {
      lastNsComplaint = Date.now();
      console.error(
        `[jobs] SKIPPING the domain sweep — our own nameservers do not resolve: ${self.missing.join(', ')}. `
        + 'Nobody can point a domain at us until they do, so nothing is verified and nothing is removed. '
        + '(Said once an hour while it lasts.)',
      );
    }
    return { skipped: true, reason: 'nameservers_unresolvable', missing: self.missing };
  }

  /*
   * ---------------------------------------------------------------------
   * FIRST: DOMAINS THE REGISTRY HAS AND WE DO NOT.
   * ---------------------------------------------------------------------
   * provisionDomain() registers and THEN records. When the gateway throws
   * after the registry has already acted — a transient
   * "Domain search is not available", an EPP timeout on a request that
   * nonetheless landed — the name is registered, the money is spent, and our
   * row is left `pending` with no registrar_ref.
   *
   * That state is invisible to the customer and unrecoverable BY the customer:
   * a pending domain cannot be attached to hosting, its order never leaves
   * `provisioning`, and every retry from the panel fails the same way. It took
   * an admin running a script to get arpi.site and voiceodnation.site out of
   * it, which is not a support model — it is a customer sitting on a paid
   * domain that the panel refuses to let them use.
   *
   * So the sweep does it. This is narrower than it looks and it is safe: the
   * row already exists, already belongs to that customer, and already came
   * from a paid order. `domains/info` only answers for names on OUR reseller
   * account, so a name we cannot see is left alone. Nothing is created here —
   * it records a registration that has already happened, on a row that is
   * already the customer's.
   */
  await adoptRegisteredDomains().catch((err) => {
    console.error('[jobs] domain reconciliation failed:', err.message);
  });

  const rows = await db.query(
    `SELECT d.*, c.hestia_user
       FROM domains d
       JOIN customers c ON c.id = d.customer_id
      WHERE d.status IN ('awaiting_ns','active')
        AND (d.ns_verified_at IS NULL OR (d.pointed_at IS NULL AND c.hestia_user IS NOT NULL))
        AND (d.ns_checked_at IS NULL OR d.ns_checked_at < DATE_SUB(NOW(), INTERVAL ? MINUTE))
        AND d.created_at > DATE_SUB(NOW(), INTERVAL ? DAY)
      ORDER BY d.ns_checked_at IS NOT NULL, d.ns_checked_at ASC, d.id ASC
      LIMIT ?`,
    [DOMAIN_RECHECK_MINUTES, DOMAIN_PROBE_DAYS, BATCH],
  );

  let verified = 0;
  for (const row of rows) {
    try {
      // Was it already live before this check? Read BEFORE verify(), because
      // verify() writes ns_verified_at and would make every domain look like it
      // had just arrived on the very next sweep.
      const wasLive = Boolean(row.ns_verified_at) && Boolean(row.pointed_at);

      const result = await linking.verify(row);
      if (result.matched) {
        verified += 1;
        console.log(`[jobs] ${row.domain} now points at us${result.pointed?.pointed ? ' — site created' : ''}`);

        /*
         * THE MOMENT THE SITE IS ACTUALLY LIVE, said out loud.
         *
         * This is the one event in the whole system the customer has been
         * waiting for — they changed their nameservers hours ago and have been
         * reloading ever since — and nothing announced it. The sweep knew, wrote
         * a row, and moved on.
         *
         * Only on the TRANSITION. `wasLive` is what stops this being raised
         * again every five minutes for the rest of the domain's life; the
         * dedupe key would collapse them into one row anyway, but re-raising a
         * resolved notification marks it unread again, so the bell would light
         * up forever on a domain that has been fine for a month.
         */
        if (!wasLive && result.pointed?.pointed) {
          await notify.raise({
            customerId: row.customer_id,
            level: 'success',
            area: 'domain',
            title: `${row.domain} is live`,
            body: 'Your nameservers have come through and the website is being served. '
              + `Open https://${row.domain} to see it.`
              + (result.pointed.ssl ? ' The security certificate is installed too.' : ''),
            fixUrl: `https://${row.domain}`,
            fixLabel: 'Visit my site',
            dedupeKey: `domain:${row.id}:live`,
          }).catch(() => {});

          // Whatever was being complained about is no longer true.
          await notify.resolve(row.customer_id, `domain:${row.id}:not_delegated`).catch(() => {});
          await notify.resolve(row.customer_id, `domain:${row.id}:not_built`).catch(() => {});
        }
      }
    } catch (err) {
      console.error(`[jobs] nameserver check failed for ${row.domain}:`, err.message);
    }
  }

  /*
   * The grace period, enforced. Only ever on `external` — a domain registered
   * or transferred through us was paid for and is the customer's property
   * whether it points here or not, and `dropUnverified` refuses those in its
   * own WHERE clause as well as here. Two locks on the same door, because the
   * cost of getting this wrong is deleting somebody's domain.
   */
  const stale = await db.query(
    `SELECT * FROM domains
      WHERE status = 'awaiting_ns' AND source = 'external'
        AND ns_verified_at IS NULL
        AND ns_grace_until IS NOT NULL AND ns_grace_until < NOW()
      ORDER BY id ASC LIMIT ?`,
    [BATCH],
  );

  let dropped = 0;
  for (const row of stale) {
    try {
      const result = await linking.dropUnverified(row);
      if (result.ok) {
        dropped += 1;
        console.log(`[jobs] removed ${row.domain} — nameservers never changed within ${DOMAIN_NS_GRACE_DAYS} days`);
      }
    } catch (err) {
      console.error(`[jobs] could not remove ${row.domain}:`, err.message);
    }
  }

  return { checked: rows.length, verified, dropped };
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

let running = false;

/**
 * One pass of everything.
 *
 * `running` is a plain flag rather than a lock because there is one process and
 * one timer. It matters anyway: a sweep that takes longer than the interval
 * would otherwise start again underneath itself and check the same rows twice.
 */
async function runOnce({ quiet = false } = {}) {
  if (running) return null;
  running = true;
  const started = Date.now();

  try {
    const results = {
      payments: await reconcilePayments().catch((err) => {
        console.error('[jobs] payment reconcile failed:', err.message);
        return null;
      }),
      orders: await finishPaidOrders().catch((err) => {
        console.error('[jobs] order activation failed:', err.message);
        return null;
      }),
      domains: await sweepDomains().catch((err) => {
        console.error('[jobs] domain sweep failed:', err.message);
        return null;
      }),
    };

    // Only speak when something happened. A line every five minutes saying
    // "nothing to do" is a log nobody reads, and this is a log that has to be
    // read on the day a payment goes missing.
    const noise =
      (results.payments?.settled || 0) + (results.payments?.expired || 0)
      + (results.orders?.built || 0)
      + (results.domains?.verified || 0) + (results.domains?.dropped || 0);
    if (noise && !quiet) {
      console.log(
        `[jobs] pass done in ${Date.now() - started}ms — `
        + `${results.payments?.settled || 0} payment(s) recovered, `
        + `${results.payments?.expired || 0} expired, `
        + `${results.orders?.built || 0} order(s) activated, `
        + `${results.domains?.verified || 0} domain(s) verified, `
        + `${results.domains?.dropped || 0} removed`,
      );
    }
    return results;
  } finally {
    running = false;
  }
}

function start() {
  if (!JOB_INTERVAL_MINUTES) {
    console.log('[jobs]      disabled (JOB_INTERVAL_MINUTES=0)');
    return null;
  }

  const everyMs = JOB_INTERVAL_MINUTES * 60_000;
  console.log(
    `[jobs]      every ${JOB_INTERVAL_MINUTES} min — payments re-checked for ${PAYMENT_SESSION_MINUTES} min, `
    + `domains given ${DOMAIN_NS_GRACE_DAYS} days to point at ${NAMESERVERS.join(' / ')}`,
  );

  /*
   * Say at boot whether the nameservers we publish actually exist. It is the
   * one piece of configuration in this app that fails silently and completely:
   * the site sells hosting, the panel tells customers to point their domain at
   * two hostnames, and if those hostnames do not resolve then nothing anybody
   * does will ever work. Better on the first line of the log than discovered
   * from a customer.
   */
  nameservers.ourNameserversResolve().then((self) => {
    if (self.ok) console.log(`[jobs]      ${NAMESERVERS.join(' and ')} resolve — domain checks are meaningful`);
    else {
      console.error(
        `[jobs]      WARNING: ${self.missing.join(' and ')} DO NOT RESOLVE. Nobody can point a domain at us. `
        + 'Domain verification and removal are both suspended until they do.',
      );
    }
  }).catch(() => {});

  // A first pass shortly after boot, not immediately: the database and the
  // adapters have just been checked and there is no reason to compete with the
  // first customers for the pool.
  setTimeout(() => { runOnce().catch(() => {}); }, 30_000).unref();

  const timer = setInterval(() => { runOnce().catch(() => {}); }, everyMs);
  // The timer must never be the reason the process stays alive during a deploy.
  timer.unref();
  return timer;
}

module.exports = { start, runOnce, reconcilePayments, finishPaidOrders, sweepDomains };
