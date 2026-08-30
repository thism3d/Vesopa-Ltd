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
const {
  SITE_URL, NAMESERVERS, DOMAIN_NS_GRACE_DAYS, POINT_HOSTNAME,
} = require('./config');

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
  /*
   * A subdomain is served on sight. The delegation check asks "has whoever
   * controls this name pointed it at us", and for `shop.example.com` that
   * question was already answered by example.com being on this account — you
   * cannot create a name under a domain you do not control. Re-asking it of the
   * subdomain itself is worse than redundant: a subdomain usually has no NS
   * records of its own at all, so the check would fail forever on a name that
   * is perfectly serveable.
   */
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
 * The domain goes on the account IMMEDIATELY, whatever its nameservers say.
 * Verification is a separate step that runs straight afterwards and again from
 * the sweep — being told "added, now point it at us" is a working state a
 * customer can act on, whereas refusing the row until DNS agrees means the
 * panel cannot show them the nameservers they are supposed to be copying.
 *
 * `wantDns` and `wantMail` decide what gets built when it does verify.
 * DNS defaults ON because a domain delegated to our nameservers and given no
 * zone here resolves to nothing at all — that is not a preference, it is the
 * thing that makes the delegation work. Mail defaults OFF: creating a mail
 * domain starts accepting mail for the name and sets an expectation about MX
 * records, and a customer whose mail is at Google or Microsoft must not have
 * that done to them by a checkbox they never saw.
 *
 * @returns {Promise<{ok: true, id, domain, deadline} | {ok: false, error}>}
 */
async function addExternal({
  customer, domain: input, serviceId = null, wantDns = true, wantMail = false,
}) {
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
              dns_enabled = ?, mail_enabled = ?,
              ns_grace_until = ?, ns_verified_at = NULL, ns_checked_at = NULL,
              ns_observed = '', pointed_at = NULL
        WHERE id = ?`,
      [serviceId, wantDns ? 1 : 0, wantMail ? 1 : 0, deadline, existing.id],
    );
  } else {
    await db.query(
      `INSERT INTO domains
         (customer_id, service_id, domain, tld, status, source, auto_renew,
          dns_enabled, mail_enabled, ns_grace_until)
       VALUES (?, ?, ?, ?, 'awaiting_ns', 'external', 0, ?, ?, ?)`,
      // auto_renew is off and stays off: we do not hold this registration and
      // cannot renew it, so a flag promising we will would be a lie.
      [customer.id, serviceId, domain, tld, wantDns ? 1 : 0, wantMail ? 1 : 0, deadline],
    );
  }

  const row = await db.one('SELECT * FROM domains WHERE domain = ? LIMIT 1', [domain]);

  await db.logActivity({
    actorType: 'customer', actorId: customer.id, action: 'domain.added_external',
    target: domain, detail: `Verify by ${deadline}`,
  });

  return { ok: true, id: row.id, domain, deadline, row };
}

/**
 * Add a subdomain of a domain already on this account.
 *
 * No nameserver check, and no grace clock. `shop.example.com` cannot exist
 * unless somebody controls `example.com`, and that control was already
 * established when the parent was added — so the delegation question has been
 * answered and asking it again of a name that has no NS records of its own
 * would fail forever on a perfectly serveable site.
 *
 * THE PARENT HAS TO BE ON THIS ACCOUNT. That is the whole authorisation check,
 * and without it this route would let anyone create a vhost for
 * `login.somebodyelse.com` on our node — unreachable without their DNS, but
 * enough to squat the name so the real owner cannot add it, since Hestia allows
 * a given domain on exactly one account. The parent does NOT have to be
 * verified: a customer whose nameservers are still propagating, or who is
 * keeping DNS at their old provider for now, can still build the subdomain and
 * point an A record at us by hand.
 *
 * WHAT GETS CREATED. The website always — that is the point of the exercise and
 * there is nothing to decide. DNS and mail are asked for explicitly:
 *
 *   dns   a zone for the subdomain is only meaningful if the parent delegates
 *         to it, which is rare. Where the parent's zone is already here, the
 *         subdomain resolves from that zone and a second zone for it does
 *         nothing but shadow records the customer can already edit.
 *   mail  creating one silently starts accepting mail for the name and puts MX
 *         expectations on it. Nobody should get that by accident.
 */
async function addSubdomain({
  customer, subdomain: input, serviceId = null, wantDns = false, wantMail = false,
}) {
  const name = nameservers.normalise(input);

  if (!name || !/^[a-z0-9.-]+$/.test(name) || name.includes('..')) {
    return { ok: false, error: 'That is not a valid subdomain name.' };
  }
  const labels = name.split('.');
  if (labels.length < 3 || labels.some((l) => !l.length)) {
    return { ok: false, error: 'A subdomain looks like shop.example.com — it needs a name in front of your domain.' };
  }
  if (labels.some((l) => l.length > 63 || l.startsWith('-') || l.endsWith('-'))) {
    return { ok: false, error: 'Each part of the name must be 1–63 characters and cannot start or end with a hyphen.' };
  }

  /*
   * Find the parent by walking up the labels rather than assuming it is
   * everything after the first dot. `shop.example.co.uk` has a three-label
   * parent, and `a.b.example.com` is a legitimate second-level subdomain of a
   * domain on the account.
   */
  let parent = null;
  for (let i = 1; i < labels.length - 1 && !parent; i++) {
    const candidate = labels.slice(i).join('.');
    parent = await db.one(
      `SELECT * FROM domains
        WHERE domain = ? AND customer_id = ? AND status <> 'removed'
        LIMIT 1`,
      [candidate, customer.id],
    );
  }
  if (!parent) {
    return {
      ok: false,
      error: 'Add the main domain to your account first — a subdomain has to sit under a domain you already have here.',
    };
  }

  const existing = await db.one('SELECT * FROM domains WHERE domain = ? LIMIT 1', [name]);
  if (existing && existing.customer_id !== customer.id) {
    return { ok: false, error: 'That name is already in use here.' };
  }
  if (existing && existing.status !== 'removed') {
    return { ok: false, error: 'That subdomain is already on your account.', id: existing.id };
  }

  // Inherit the parent's service unless the caller named one, so a subdomain
  // lands on the same hosting account as the site it belongs to.
  const service = serviceId || parent.service_id || null;

  if (existing) {
    await db.query(
      `UPDATE domains
          SET status = 'active', source = 'subdomain', service_id = ?,
              dns_enabled = ?, mail_enabled = ?,
              ns_grace_until = NULL, ns_verified_at = NULL, ns_checked_at = NULL,
              ns_observed = '', pointed_at = NULL
        WHERE id = ?`,
      [service, wantDns ? 1 : 0, wantMail ? 1 : 0, existing.id],
    );
  } else {
    await db.query(
      `INSERT INTO domains
         (customer_id, service_id, domain, tld, status, source, auto_renew,
          dns_enabled, mail_enabled)
       VALUES (?, ?, ?, ?, 'active', 'subdomain', 0, ?, ?)`,
      // No tld and no auto_renew: a subdomain is not a registration, there is
      // no registry behind it and nothing to renew.
      [customer.id, service, name, '', wantDns ? 1 : 0, wantMail ? 1 : 0],
    );
  }

  const row = await db.one('SELECT * FROM domains WHERE domain = ? LIMIT 1', [name]);
  const built = await pointAtNode(row, customer);

  /*
   * Make it resolve.
   *
   * A vhost is not a website until something answers the name, and Hestia does
   * NOT add a record to the parent zone when you add a subdomain — the first
   * version of this shipped `shop.heat6.com` with a working vhost, no DNS
   * anywhere, and a certificate request that failed because Let's Encrypt could
   * not reach a name that did not exist.
   *
   * Where the parent's zone is here, one A record fixes that and it is the
   * right place for it: the subdomain lives IN the parent zone, which is
   * exactly why it does not need a zone of its own. The address is copied from
   * the parent's own A record rather than read from config, so the subdomain
   * lands wherever the parent already points, on any node.
   *
   * Where the parent's zone is elsewhere, there is nothing we can write and the
   * customer adds the record at their provider — `dnsRecord` says which.
   */
  let dnsRecord = { ok: false, pointAt: POINT_HOSTNAME, reason: 'the main domain is not pointed at us' };
  if (!wantDns) {
    try {
      /*
       * BOTH conditions, and the delegation is the one that decides it.
       *
       * A zone can exist on this node for a domain whose nameservers are still
       * at the old provider — that is the normal state for the first few hours
       * after a customer adds a domain. Writing a record into a zone nobody is
       * asking is not wrong, but it resolves nothing, and telling the customer
       * their subdomain is live on the strength of it would be a lie. So the
       * record is only treated as the answer when the parent is verified;
       * otherwise the customer is told to point it themselves.
       */
      const parentVerified = Boolean(parent.ns_verified_at);
      const parentZone = parentVerified
        && await hestia.dnsDomainExists({ username: customer.hestia_user, domain: parent.domain });
      if (parentZone) {
        const records = await hestia.listDnsRecords({ username: customer.hestia_user, domain: parent.domain });
        const apex = records.find((r) => r.type === 'A' && (r.name === '@' || r.name === ''));
        const label = name.slice(0, -(parent.domain.length + 1));
        const already = records.some((r) => r.name === label && ['A', 'CNAME'].includes(r.type));

        if (already) {
          dnsRecord = { ok: true, existed: true, name: label };
        } else if (apex) {
          await hestia.addDnsRecord({
            username: customer.hestia_user,
            domain: parent.domain,
            name: label,
            type: 'A',
            value: apex.value,
          });
          dnsRecord = { ok: true, name: label, value: apex.value };
        } else {
          dnsRecord = { ok: false, pointAt: POINT_HOSTNAME, reason: 'the main domain has no A record to copy' };
        }
      }
    } catch (err) {
      // Never fatal. The site exists; it just is not reachable yet, and that is
      // a thing the customer can be told and can fix at their own provider.
      dnsRecord = { ok: false, pointAt: POINT_HOSTNAME, reason: err.message };
    }

    /*
     * Last word goes to the public DNS.
     *
     * Whether we managed to write a record is OUR bookkeeping; whether the name
     * resolves to this node is the thing the customer actually cares about, and
     * the two come apart in both directions. A subdomain can already be pointed
     * here — the customer set it up at their provider before adding it, or it
     * was live on this node all along — in which case telling them to go and
     * point something is nonsense: there is nothing for them to do, and asking
     * makes the panel look like it cannot see its own state.
     *
     * So if it resolves to us, it is pointed, whatever we did or did not write.
     */
    if (!dnsRecord.ok) {
      const live = await nameservers.pointsAtUs(name, POINT_HOSTNAME);
      if (live.pointed) {
        dnsRecord = { ok: true, alreadyPointed: true, addresses: live.addresses };
      }
    }
  }

  await db.logActivity({
    actorType: 'customer', actorId: customer.id, action: 'domain.added_subdomain',
    target: name,
    detail: `Under ${parent.domain}. web${wantDns ? ' + dns' : ''}${wantMail ? ' + mail' : ''}`
      + (dnsRecord.ok ? `; A record ${dnsRecord.name} added to the parent zone` : `; no A record (${dnsRecord.reason})`),
    ok: built.pointed,
  });

  return {
    ok: true, id: row.id, domain: name, parent: parent.domain, row, built, dnsRecord,
  };
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

  /*
   * A full domain gets all three; a subdomain gets what it asked for, and the
   * website either way.
   *
   * `dns_enabled` and `mail_enabled` default to 1 in the schema, so a domain
   * row written before those columns existed still behaves exactly as it did.
   * Only the subdomain flow writes zeroes.
   */
  const wantsDns = domainRow.dns_enabled === undefined || Number(domainRow.dns_enabled) === 1;
  const wantsMail = domainRow.mail_enabled === undefined || Number(domainRow.mail_enabled) === 1;

  // The zone first: our nameservers answer for this name now, and without a
  // zone on the node they answer with nothing at all.
  if (wantsDns) {
    steps.push({ step: 'dns', ...(await ignoringExists(() => hestia.addDnsDomain({ username, domain }))) });
  }

  /*
   * `addWebDomain` is v-add-domain, which creates the zone and the mail domain
   * as well — harmless when both were wanted, and exactly wrong when they were
   * not. A name that opted out of either gets the narrow v-add-web-domain.
   */
  const webOnly = !wantsDns || !wantsMail;
  steps.push({
    step: 'web',
    ...(await ignoringExists(() => (webOnly
      ? hestia.addWebsite({ username, domain })
      : hestia.addWebDomain({ username, domain })))),
  });

  if (wantsMail) {
    steps.push({ step: 'mail', ...(await ignoringExists(() => hestia.addMailDomain({ username, domain }))) });
  }

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

/**
 * Undo pointAtNode: take the domain off the hosting node entirely.
 *
 * THE MISSING HALF. `pointAtNode` creates a DNS zone, a website and a mail
 * domain, and until this existed nothing ever removed them. Both removal paths
 * — the customer's "remove from account" button and the sweep that drops a
 * domain which never verified — only set `status = 'removed'` in our database.
 * The node kept the zone, the vhost and the mail domain forever.
 *
 * That is not merely untidy. The zone keeps answering, so the domain still
 * resolves to us after the customer believes they have taken it away; the mail
 * domain keeps accepting mail for a name we no longer list; the vhost keeps
 * consuming the account's web-domain allowance, so a customer who removes a
 * site and adds another can be told they are at their plan limit when the panel
 * shows fewer domains than they are paying for. And the name stays claimed on
 * the node, so re-adding it later — which `addExternal` explicitly allows —
 * hits "already exists".
 *
 * `v-delete-domain` is one call that removes web, DNS and mail together, which
 * is the exact mirror of `v-add-domain`. Not-exist is success here: this runs on
 * domains that were never pointed at us in the first place, and on ones already
 * cleaned up by a previous attempt.
 *
 * MAIL IS DESTROYED WITH IT, mailboxes and their contents included. That is
 * what removing a domain from a hosting account means, and it is why the caller
 * has to have established that the customer meant this domain.
 */
async function unpointFromNode(domainRow, customer) {
  const username = customer?.hestia_user;
  if (!username || !domainRow?.domain) {
    return { ok: true, skipped: 'no hosting account' };
  }
  if (!hestia.isLive()) return { ok: true, skipped: 'node not live' };

  try {
    await hestia.deleteWebDomain({ username, domain: domainRow.domain });
    return { ok: true, removed: true };
  } catch (err) {
    // 3 is E_NOTEXIST — there was nothing on the node to remove, which is the
    // state we were trying to reach.
    if (err.code === 3) return { ok: true, absent: true };
    return { ok: false, error: err.message };
  }
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

  const customer = await db.one('SELECT * FROM customers WHERE id = ? LIMIT 1', [domainRow.customer_id]);

  /*
   * Usually a no-op — a domain that never verified was never pointed at the
   * node, so there is nothing to remove. It matters for the one that verified,
   * was built, and then had its nameservers moved away again: without this the
   * zone and mail domain outlive the account they belonged to.
   */
  const unpointed = await unpointFromNode(domainRow, customer);

  await db.logActivity({
    actorType: 'system', action: 'domain.removed_unverified', target: domainRow.domain,
    detail: `Nameservers were never changed. Last seen: ${domainRow.ns_observed || 'nothing'}`
      + (unpointed.ok ? '' : ` Node cleanup failed: ${unpointed.error}`),
    ok: false,
  });

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
  addSubdomain,
  verify,
  pointAtNode,
  unpointFromNode,
  dropUnverified,
};
