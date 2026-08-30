/**
 * Domains on an account: adding one, proving it points here, and serving it.
 *
 * ## Who may add a domain
 *
 * Anyone with an account. Registering a name through us is a purchase and goes
 * through checkout; naming one you already own is not, and gating it behind a
 * sale would mean a customer moving a live site cannot even see the panel they
 * are being asked to trust.
 *
 * ## What that gets them, and when
 *
 * Nothing, until the nameservers agree. A domain somebody typed into a form is
 * a claim, not a fact — the person typing it may not own it, and a platform
 * that serves a site, issues a certificate and accepts mail for any name it is
 * given is a platform being used to impersonate other people's domains. The
 * delegation is the proof: if the public DNS says the name is delegated to our
 * nameservers, then whoever controls the domain has pointed it at us
 * deliberately, and that is the only evidence worth acting on.
 *
 * ## And if they never do
 *
 * An EXTERNAL domain that has not verified within the grace period is dropped
 * from the account. It was never ours, we are not serving it, and leaving it in
 * a list forever means the panel shows domains this company does not host.
 *
 * A domain REGISTERED OR TRANSFERRED through us is never dropped by any of
 * this. It was paid for and it belongs to the customer whether it points at us
 * or at somebody else — that is what owning a domain means.
 */

const db = require('./db');
const hestia = require('./integrations/hestia');
const registrar = require('./integrations/domainnameapi');
const nameservers = require('./nameservers');
const { sendMail, shell, detailTable, escapeHtml } = require('./mailer');
const { SITE_URL, NAMESERVERS, DOMAIN_NS_GRACE_DAYS } = require('./config');

/** The deadline written onto a new external domain, as a DATETIME string. */
function graceDeadline(days = DOMAIN_NS_GRACE_DAYS) {
  const d = new Date(Date.now() + Number(days) * 864e5);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * May this domain be served from our node?
 *
 * A domain we registered or transferred is ours to serve on sight: the
 * nameservers were set to ours at the registry by us, and the customer bought
 * it here. An external one has to have proved itself first.
 */
function mayPoint(domainRow) {
  if (!domainRow) return false;
  if (domainRow.source === 'external') return Boolean(domainRow.ns_verified_at);
  return true;
}

/** Hestia says "already exists" with exit code 4. That is a success here. */
async function ignoringExists(fn) {
  try {
    await fn();
    return { ok: true };
  } catch (err) {
    if (err.code === 4) return { ok: true, existed: true };
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Adding
// ---------------------------------------------------------------------------

/**
 * Add a domain the customer already owns elsewhere.
 *
 * Refuses a name that is already on another account outright, and says so
 * without saying whose it is. A domain the same customer previously let lapse
 * out of the account is theirs to add again.
 *
 * @returns {Promise<{ok: true, id, domain, deadline} | {ok: false, error}>}
 */
async function addExternal({ customer, domain: input, serviceId = null }) {
  const { domain, sld, tld } = registrar.splitDomain(input);
  const invalid = registrar.validateLabel(sld);
  if (invalid) return { ok: false, error: invalid };
  if (!tld) return { ok: false, error: 'Add an extension, like .com.' };

  const existing = await db.one('SELECT * FROM domains WHERE domain = ? LIMIT 1', [domain]);

  if (existing && existing.customer_id !== customer.id) {
    return { ok: false, error: 'That domain is already on an account here. If it is yours, open a ticket and we will move it across.' };
  }
  if (existing && !['removed', 'cancelled'].includes(existing.status)) {
    return { ok: false, error: 'That domain is already on your account.', id: existing.id };
  }

  const deadline = graceDeadline();

  if (existing) {
    await db.query(
      `UPDATE domains
          SET status = 'awaiting_ns', source = 'external', service_id = ?,
              ns_grace_until = ?, ns_verified_at = NULL, ns_checked_at = NULL,
              ns_observed = '', pointed_at = NULL
        WHERE id = ?`,
      [serviceId, deadline, existing.id],
    );
  } else {
    await db.query(
      `INSERT INTO domains
         (customer_id, service_id, domain, tld, status, source, auto_renew, ns_grace_until)
       VALUES (?, ?, ?, ?, 'awaiting_ns', 'external', 0, ?)`,
      // auto_renew is off and stays off: we do not hold this registration and
      // cannot renew it, so a flag promising we will would be a lie.
      [customer.id, serviceId, domain, tld, deadline],
    );
  }

  const row = await db.one('SELECT * FROM domains WHERE domain = ? LIMIT 1', [domain]);

  await db.logActivity({
    actorType: 'customer', actorId: customer.id, action: 'domain.added_external',
    target: domain, detail: `Verify by ${deadline}`,
  });

  return { ok: true, id: row.id, domain, deadline, row };
}

// ---------------------------------------------------------------------------
// Verifying
// ---------------------------------------------------------------------------

/**
 * Ask the public DNS where this domain points, record the answer, and act on it.
 *
 * Called from the sweep, from the customer's own "check now" button, and after
 * a registration. Writing the observed nameservers down even on a failure is
 * what lets the panel say "we can see ns1.somebodyelse.com" instead of a bare
 * "not verified", which is the difference between a customer fixing it in two
 * minutes and opening a ticket.
 *
 * @returns {Promise<{matched: boolean, nameservers: string[], error: string, pointed?: object}>}
 */
async function verify(domainRow, { customer = null } = {}) {
  const result = await nameservers.check(domainRow.domain);

  /*
   * `ns_observed` is only overwritten when the lookup actually answered.
   *
   * A resolver timeout, or a domain that has stopped resolving entirely, is not
   * evidence that it points nowhere — and blanking the field on those turns the
   * one useful thing we can tell a customer ("we can see ns1.theirhost.com")
   * into "nothing", in both the panel and the removal email. The last answer we
   * genuinely got is better information than no answer at all.
   */
  await db.query(
    `UPDATE domains
        SET ns_checked_at = NOW(),
            ns_observed = CASE WHEN ? = 1 THEN ? ELSE ns_observed END,
            ns_verified_at = CASE WHEN ? = 1 THEN COALESCE(ns_verified_at, NOW()) ELSE NULL END
      WHERE id = ?`,
    [
      result.nameservers.length ? 1 : 0,
      result.nameservers.join(' ').slice(0, 400),
      result.matched ? 1 : 0,
      domainRow.id,
    ],
  );

  if (!result.matched) return result;

  /*
   * A verified domain leaves the waiting room. `pending` is left alone: that
   * one is mid-registration and provisionDomain owns its status.
   */
  if (domainRow.status === 'awaiting_ns') {
    await db.query("UPDATE domains SET status = 'active' WHERE id = ? AND status = 'awaiting_ns'", [domainRow.id]);
  }

  const owner = customer
    || await db.one('SELECT * FROM customers WHERE id = ? LIMIT 1', [domainRow.customer_id]);

  const pointed = await pointAtNode({ ...domainRow, ns_verified_at: new Date() }, owner);

  await db.logActivity({
    actorType: 'system', action: 'domain.ns_verified', target: domainRow.domain,
    detail: pointed.pointed ? 'Serving from the node' : pointed.reason || '',
  });

  return { ...result, pointed };
}

/**
 * Create everything on the node that serving this domain needs.
 *
 * Every step tolerates "already exists", because this runs again on every
 * successful verification and a domain that is already set up must not report a
 * failure for being set up. SSL is best-effort and last: a certificate that
 * cannot be issued yet is a retry button in the panel, not a broken site.
 */
async function pointAtNode(domainRow, customer) {
  if (!mayPoint(domainRow)) {
    return { pointed: false, reason: 'Not verified as pointing at us yet.' };
  }
  if (!customer?.hestia_user) {
    /*
     * No hosting account to serve it from. Not an error and not a half-finished
     * job: a domain can be registered here and hosted anywhere, and building
     * them a Hestia account they have not bought would be creating hosting
     * without a payment — the exact thing the order flow now refuses to do.
     */
    return { pointed: false, reason: 'No hosting on this account yet.' };
  }

  const username = customer.hestia_user;
  const domain = domainRow.domain;
  const steps = [];

  // The zone first: our nameservers answer for this name now, and without a
  // zone on the node they answer with nothing at all.
  steps.push({ step: 'dns', ...(await ignoringExists(() => hestia.addDnsDomain({ username, domain }))) });
  steps.push({ step: 'web', ...(await ignoringExists(() => hestia.addWebDomain({ username, domain }))) });
  steps.push({ step: 'mail', ...(await ignoringExists(() => hestia.addMailDomain({ username, domain }))) });

  const web = steps.find((s) => s.step === 'web');
  let ssl = { ok: false, error: 'Website not created.' };
  if (web.ok) {
    ssl = await ignoringExists(() => hestia.enableSSL({ username, domain }));
  }
  steps.push({ step: 'ssl', ...ssl });

  if (web.ok) {
    await db.query('UPDATE domains SET pointed_at = COALESCE(pointed_at, NOW()) WHERE id = ?', [domainRow.id]);
  }

  return { pointed: web.ok, ssl: ssl.ok, steps };
}

// ---------------------------------------------------------------------------
// DNS records
// ---------------------------------------------------------------------------

/**
 * Check one record before it is sent to the node.
 *
 * Hestia validates too, and refuses with an exit code — "That value is not
 * valid" is all a customer would see, for any mistake, in any field. These
 * checks exist to say which field and why, in words somebody who has been told
 * to "add a TXT record" by their email provider can act on.
 *
 * Deliberately not exhaustive: it rejects what is definitely wrong rather than
 * trying to be the registry's own parser. A record that passes here and is
 * still refused by the node is reported with the node's own message.
 */
function validateRecord({ name, type, value, priority, ttl }) {
  const out = {
    // `@` is the zone apex and is what Hestia expects for the domain itself.
    name: String(name || '@').trim().toLowerCase().slice(0, 120) || '@',
    type: String(type || '').trim().toUpperCase(),
    value: String(value || '').trim().slice(0, 500),
    priority: '',
    ttl: Math.max(60, Math.min(604800, Number(ttl) || 3600)),
  };

  if (!hestia.DNS_TYPES.includes(out.type)) return { error: 'Pick a record type from the list.' };
  if (!out.value) return { error: 'Give the record a value.' };
  // `@` and `*` are both legal names, not punctuation to be scrubbed: `@` is
  // the zone apex — the domain itself, and the default for most records — and
  // `*` is a wildcard. An earlier version of this pattern left `@` out and
  // rejected every record anybody would add first.
  if (!/^[a-z0-9._*@-]+$/.test(out.name)) {
    return { error: 'A record name can only contain letters, numbers, dots, hyphens, @ and *.' };
  }

  if (out.type === 'A' && !/^\d{1,3}(\.\d{1,3}){3}$/.test(out.value)) {
    return { error: 'An A record points at an IPv4 address, like 203.0.113.10.' };
  }
  if (out.type === 'AAAA' && !/^[0-9a-f:]+$/i.test(out.value)) {
    return { error: 'An AAAA record points at an IPv6 address.' };
  }
  if (['CNAME', 'NS'].includes(out.type) && !/^[a-z0-9.-]+$/i.test(out.value)) {
    return { error: `A ${out.type} record points at a hostname, like example.com.` };
  }

  if (['MX', 'SRV'].includes(out.type)) {
    const p = Number(priority);
    if (!Number.isFinite(p) || p < 0 || p > 65535) {
      return { error: `A ${out.type} record needs a priority between 0 and 65535 — 10 is the usual answer.` };
    }
    out.priority = String(Math.round(p));
  }

  /*
   * A TXT value is quoted for Hestia. SPF and DKIM records contain spaces, and
   * an unquoted value with a space in it becomes several arguments by the time
   * the node's shell sees it — which is how a working SPF record arrives
   * truncated at the first space.
   */
  if (out.type === 'TXT' && !/^".*"$/.test(out.value)) {
    out.value = `"${out.value.replace(/"/g, '')}"`;
  }

  return { ok: true, record: out };
}

/**
 * May this customer edit this domain's DNS with us?
 *
 * Only if we are the ones answering for it. A domain delegated to somebody
 * else's nameservers has its zone over there, and an editor that cheerfully
 * accepted records into a zone nobody queries would be a form that does
 * nothing — worse than no form at all, because the customer would believe the
 * change had been made.
 */
function mayEditDns(domainRow, customer) {
  if (!domainRow || !mayPoint(domainRow)) {
    return { ok: false, reason: 'This domain is not pointing at our nameservers yet, so its DNS is not ours to edit.' };
  }
  if (!customer?.hestia_user) {
    return { ok: false, reason: 'DNS hosting comes with a hosting or email plan. There is not one on this account yet.' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Dropping
// ---------------------------------------------------------------------------

/**
 * Remove an external domain that never pointed at us.
 *
 * `removed` rather than a DELETE. The customer is told what happened and why,
 * the activity log keeps the answer to "where did my domain go", and adding the
 * same name again later is allowed — `addExternal` claims a removed row back.
 */
async function dropUnverified(domainRow) {
  const [res] = await db.pool.query(
    `UPDATE domains SET status = 'removed', service_id = NULL
      WHERE id = ? AND status = 'awaiting_ns' AND source = 'external'`,
    [domainRow.id],
  );
  if (!res.affectedRows) return { ok: false, already: true };

  await db.logActivity({
    actorType: 'system', action: 'domain.removed_unverified', target: domainRow.domain,
    detail: `Nameservers were never changed. Last seen: ${domainRow.ns_observed || 'nothing'}`,
    ok: false,
  });

  const customer = await db.one('SELECT * FROM customers WHERE id = ? LIMIT 1', [domainRow.customer_id]);
  if (customer) {
    await sendMail({
      to: customer.email,
      subject: `${domainRow.domain} has been removed from your account`,
      html: shell({
        title: `${escapeHtml(domainRow.domain)} was not pointed at us`,
        intro:
          `You added <b>${escapeHtml(domainRow.domain)}</b> to your Vesopa Cloud account, but its `
          + `nameservers were never changed to ours, so we were never able to host it. `
          + `It has been removed from your account — nothing has been charged, and your domain itself is untouched.`,
        bodyHtml: detailTable([
          ['Our nameservers', `<span style="font-family:monospace">${NAMESERVERS.map(escapeHtml).join('<br>')}</span>`],
          ['Last seen pointing at', escapeHtml(domainRow.ns_observed || 'nothing we could read')],
        ]),
        ctaText: 'Add it again',
        ctaUrl: `${SITE_URL}/panel/domains/add`,
        footNote:
          'Change the nameservers at whoever your domain is registered with, then add it here again — '
          + 'it will verify within minutes and we will set the site up for you.',
      }),
    }).catch((err) => console.error('[domains] removal email failed:', err.message));
  }

  return { ok: true };
}

module.exports = {
  graceDeadline,
  mayPoint,
  mayEditDns,
  validateRecord,
  addExternal,
  verify,
  pointAtNode,
  dropUnverified,
};
