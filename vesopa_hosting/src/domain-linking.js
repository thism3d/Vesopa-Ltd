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
 * The domain on this account that `name` is a subdomain of, or null.
 *
 * THIS IS THE ONLY RELIABLE TEST for "is this a subdomain", and counting labels
 * is not it. `shop.heat6.com` and `vesopa.co.uk` both have three labels; one is
 * a subdomain and one is a registrable domain, and no amount of dot-counting
 * separates them without a public suffix list. What DOES separate them is
 * whether the customer already holds something this name sits under — which is
 * also the authorisation check, since you cannot create a name under a domain
 * you do not control.
 *
 * Walks up the labels rather than assuming the parent is everything after the
 * first dot: `shop.example.co.uk` has a three-label parent, and
 * `a.b.example.com` is a legitimate second-level subdomain.
 */
async function findParent(customer, name) {
  const labels = nameservers.normalise(name).split('.');
  for (let i = 1; i < labels.length - 1; i++) {
    const candidate = labels.slice(i).join('.');
    // eslint-disable-next-line no-await-in-loop -- at most a handful of labels
    const row = await db.one(
      // No filter on `source`: a name may legitimately sit under a subdomain
      // the account already holds (a.b.example.com under b.example.com), and
      // the closest ancestor wins because the loop walks outward from the left.
      `SELECT * FROM domains
        WHERE domain = ? AND customer_id = ? AND status <> 'removed'
        LIMIT 1`,
      [candidate, customer.id],
    );
    if (row) return row;
  }
  return null;
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

  const parent = await findParent(customer, name);
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
 * TWO WAYS TO POINT AT US, and which one applies is not a preference — it is a
 * property of the name.
 *
 *   ns   The domain is delegated to our nameservers. We answer for the whole
 *        zone, so DNS is ours to edit and MX is ours to set. This is the full
 *        arrangement and the one a domain registered here always has.
 *
 *   a    An A record aims the name at this node while DNS stays wherever it
 *        already was. The website and the certificate work identically; the
 *        zone is not ours, so the DNS editor is off and mail needs records the
 *        customer adds at their own provider.
 *
 * A SUBDOMAIN IS ONLY EVER 'a', AND THAT IS THE BUG THIS FIXES. Delegation is a
 * property of a zone. Asking whether `shop.example.com` is delegated to us is
 * asking a question a subdomain has no way to answer — it normally has no NS
 * records at all — so `resolveNs` fails, and the old code read that failure as
 * "not pointing at us". A subdomain that was resolving to this node perfectly
 * was shown "Waiting for your nameservers", with a nameserver form underneath
 * it that could never have helped. Subdomains are checked by address, full
 * stop, and never by delegation.
 *
 * For a full domain the delegation is tried FIRST, because it is the better
 * arrangement and the answer decides whether we may offer DNS and mail. Only if
 * that fails do we ask whether an A record has been pointed here anyway.
 *
 * Both observations are written down even on a failure. "We can see
 * ns1.theirhost.com" and "we can see 3.72.113.21" are each the difference
 * between a customer fixing it in two minutes and opening a ticket.
 *
 * @returns {Promise<{matched: boolean, method: string, nameservers: string[],
 *                    addresses: string[], error: string, pointed?: object}>}
 */
async function verify(domainRow, { customer = null } = {}) {
  const isSubdomain = domainRow.source === 'subdomain';

  let ns = { matched: false, nameservers: [], extras: [], error: '' };

  if (!isSubdomain) {
    ns = await nameservers.check(domainRow.domain);
  }

  /*
   * THE ADDRESS IS CHECKED EVERY TIME, including when the delegation already
   * matched, and that is not belt-and-braces — the NS check alone produces
   * false positives.
   *
   * `resolveNs` returns the NS records held by whichever server actually
   * answers for the name, which is NOT the same as the delegation recorded at
   * the registry. A zone on somebody else's box can list our nameservers quite
   * happily. That is not hypothetical: heat6.com was delegated to
   * ns1.onzep.uk, whose copy of the zone named ns1/ns2.vesopa.com — so the
   * delegation check passed while every visitor was being served by the old
   * server. Verified, and pointing somewhere else.
   *
   * So delegation decides whether DNS is ours to run; the ADDRESS decides
   * whether we are actually serving the site, and a certificate can only be
   * issued on the strength of the second one.
   *
   * Never throws: "we could not tell" comes back as not-pointing.
   */
  const ip = await nameservers.pointsAtUs(domainRow.domain, POINT_HOSTNAME);

  const method = ns.matched ? 'ns' : (ip.pointed ? 'a' : '');
  const matched = Boolean(method);
  const resolvesHere = ip.pointed;

  /*
   * `ns_observed` and `ip_observed` are only overwritten when that lookup
   * actually answered.
   *
   * A resolver timeout, or a domain that has stopped resolving entirely, is not
   * evidence that it points nowhere — and blanking the field on those turns the
   * one useful thing we can tell a customer into "nothing", in both the panel
   * and the removal email. The last answer we genuinely got beats no answer.
   */
  await db.query(
    `UPDATE domains
        SET ns_checked_at = NOW(),
            ns_observed = CASE WHEN ? = 1 THEN ? ELSE ns_observed END,
            ip_observed = CASE WHEN ? = 1 THEN ? ELSE ip_observed END,
            verify_method = ?,
            ns_verified_at = CASE WHEN ? = 1 THEN COALESCE(ns_verified_at, NOW()) ELSE NULL END
      WHERE id = ?`,
    [
      ns.nameservers.length ? 1 : 0,
      ns.nameservers.join(' ').slice(0, 400),
      ip.addresses.length ? 1 : 0,
      ip.addresses.join(' ').slice(0, 200),
      method,
      matched ? 1 : 0,
      domainRow.id,
    ],
  );

  const result = {
    matched,
    method,
    resolvesHere,
    nameservers: ns.nameservers,
    addresses: ip.addresses,
    error: ns.error || '',
  };

  if (!matched) return result;

  /*
   * A verified domain leaves the waiting room. `pending` is left alone: that
   * one is mid-registration and provisionDomain owns its status.
   */
  if (domainRow.status === 'awaiting_ns') {
    await db.query("UPDATE domains SET status = 'active' WHERE id = ? AND status = 'awaiting_ns'", [domainRow.id]);
  }

  const owner = customer
    || await db.one('SELECT * FROM customers WHERE id = ? LIMIT 1', [domainRow.customer_id]);

  const pointed = await pointAtNode(
    { ...domainRow, ns_verified_at: new Date(), verify_method: method },
    owner,
    // Do not spend a slow Let's Encrypt call, or a slice of its rate limit, on
    // a name that demonstrably does not resolve here yet. The challenge would
    // fail by definition.
    { resolvesHere },
  );

  await db.logActivity({
    actorType: 'system', action: 'domain.verified', target: domainRow.domain,
    detail: `by ${method === 'ns' ? 'nameservers' : 'A record'}; `
      + (pointed.pointed ? 'serving from the node' : pointed.reason || 'not served'),
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
async function pointAtNode(domainRow, customer, { resolvesHere = null } = {}) {
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
  let ssl = { ok: false, error: 'The website was not created, so there was nothing to certify.' };

  /*
   * A certificate is only worth asking for if the name actually resolves here.
   *
   * Let's Encrypt validates by fetching the name over the public internet, so
   * for anything that does not point at this node the request cannot succeed —
   * it just takes ninety seconds to fail, and spends one of the handful of
   * attempts the rate limit allows per domain per hour. The caller usually
   * knows the answer already (verify has just looked it up); when it does not,
   * this looks it up rather than guessing.
   */
  const reachable = resolvesHere === null
    ? (await nameservers.pointsAtUs(domain, POINT_HOSTNAME)).pointed
    : resolvesHere;

  if (web.ok && !reachable) {
    ssl = {
      ok: false,
      error: 'The name does not resolve to this server yet, so a certificate cannot be issued. '
        + 'It is requested automatically once it does.',
    };
  } else if (web.ok) {
    /*
     * NO `www.` FOR A SUBDOMAIN. `www.shop.example.com` is a name nobody
     * publishes, and a certificate request fails as a whole if any name in it
     * fails validation — so asking for it would take the subdomain's own
     * certificate down with it, every time.
     *
     * `mail: false` always. See hestia.enableSSL: that flag does not add the
     * mail name, it REPLACES the target with it. Mail is served under one
     * hostname for every customer and needs no certificate per domain.
     */
    ssl = await ignoringExists(() => hestia.enableSSL({
      username,
      domain,
      aliases: isSubdomain(domainRow) ? '' : `www.${domain}`,
      mail: false,
    }));
  }
  steps.push({ step: 'ssl', ...ssl });
  await recordSsl(domainRow.id, ssl);

  if (web.ok) {
    await db.query('UPDATE domains SET pointed_at = COALESCE(pointed_at, NOW()) WHERE id = ?', [domainRow.id]);
  }

  return { pointed: web.ok, ssl: ssl.ok, sslError: ssl.ok ? '' : explainSslError(ssl.error), steps };
}

/**
 * Turn a Let's Encrypt failure into a sentence a customer can act on.
 *
 * Hestia surfaces these as an exit code and one line of ACME prose. Left raw
 * they read as our software breaking, when nearly all of them are one of three
 * ordinary situations with an obvious next step.
 */
function explainSslError(raw) {
  const text = String(raw || '').toLowerCase();
  if (!text) return '';
  if (text.includes('rate limit') || text.includes('too many certificates')) {
    return 'Let\'s Encrypt is rate-limiting this domain after too many attempts. '
      + 'It clears by itself — try again in an hour.';
  }
  if (text.includes('dns problem') || text.includes('nxdomain') || text.includes("doesn't exist")) {
    return 'The name does not resolve to this server yet. DNS changes can take a few hours; '
      + 'once it points here, press the button again.';
  }
  if (text.includes('challenge') || text.includes('unauthorized') || text.includes('timeout')) {
    return 'Let\'s Encrypt could not reach this site to prove you own it. '
      + 'That is nearly always DNS still propagating — try again shortly.';
  }
  return raw;
}

/**
 * Write down what happened to the certificate.
 *
 * This is the half that was missing. pointAtNode has always ASKED for a
 * certificate; it threw the answer away, so nothing knew whether one existed,
 * nothing ever retried a failure, and the panel could not show a padlock or
 * explain its absence. A customer's only signal was the browser's.
 */
async function recordSsl(domainId, ssl) {
  const status = ssl.ok ? 'active' : 'failed';
  await db.query(
    `UPDATE domains
        SET ssl_status = ?,
            ssl_checked_at = NOW(),
            ssl_issued_at = CASE WHEN ? = 'active' THEN COALESCE(ssl_issued_at, NOW()) ELSE ssl_issued_at END,
            ssl_error = ?
      WHERE id = ?`,
    [status, status, ssl.ok ? '' : explainSslError(ssl.error).slice(0, 300), domainId],
  );
}

/**
 * Ask for a certificate now, for one domain.
 *
 * Separate from pointAtNode because retrying is its own act with its own
 * button. The overwhelmingly common case is "DNS had not propagated when we
 * first tried", and making that self-service removes an entire category of
 * ticket — the same reasoning as the service page's SSL retry, except that
 * this one reaches domains that are not attached to a service at all, which
 * the old button could not.
 */
async function issueSsl(domainRow, customer) {
  if (!customer?.hestia_user) {
    return { ok: false, error: 'There is no hosting account to install a certificate on.' };
  }
  if (!mayPoint(domainRow)) {
    return { ok: false, error: 'This domain is not pointing at us yet, so a certificate cannot be issued for it.' };
  }

  /*
   * Asked again here rather than trusted from the row. The button is pressed by
   * somebody who has just changed their DNS, so the stored answer is precisely
   * the one most likely to be out of date — in both directions.
   */
  const live = await nameservers.pointsAtUs(domainRow.domain, POINT_HOSTNAME);
  if (!live.pointed) {
    const seen = live.addresses.length ? ` It currently answers with ${live.addresses.join(', ')}.` : '';
    await recordSsl(domainRow.id, {
      ok: false,
      error: `${domainRow.domain} does not resolve to this server yet.${seen}`,
    });
    return {
      ok: false,
      error: `${domainRow.domain} does not resolve to this server yet, and Let's Encrypt has to `
        + `reach it to prove you own it.${seen} Point it here first, then try again.`,
    };
  }

  const result = await ignoringExists(() => hestia.enableSSL({
    username: customer.hestia_user,
    domain: domainRow.domain,
    aliases: isSubdomain(domainRow) ? '' : `www.${domainRow.domain}`,
    mail: false,
  }));

  await recordSsl(domainRow.id, result);
  return { ...result, message: result.ok ? '' : explainSslError(result.error) };
}

/**
 * What certificate does this domain have RIGHT NOW?
 *
 * Read from the node, then written down. The stored value is what the domain
 * list renders — one query rather than one Hestia call per row — and this
 * refreshes it whenever somebody is actually looking at that domain's page.
 *
 * A node we cannot reach returns the last thing we knew rather than "none":
 * claiming a live site has no certificate because our own API call timed out
 * would send customers to reissue certificates they already have, straight
 * into a Let's Encrypt rate limit.
 */
async function refreshSsl(domainRow, customer) {
  const stored = {
    status: domainRow.ssl_status || 'none',
    error: domainRow.ssl_error || '',
    issued_at: domainRow.ssl_issued_at || null,
  };
  if (!customer?.hestia_user || !hestia.isLive()) return stored;

  try {
    const live = await hestia.webDomainSsl({
      username: customer.hestia_user,
      domain: domainRow.domain,
    });
    // A certificate that is present wins outright. Absent means "failed" only
    // if we have a recorded reason; otherwise it has simply never been asked
    // for, and "none" is the honest word for that.
    const status = live.ssl ? 'active' : (domainRow.ssl_error ? 'failed' : 'none');
    await db.query(
      `UPDATE domains
          SET ssl_status = ?, ssl_checked_at = NOW(),
              ssl_issued_at = CASE WHEN ? = 'active' THEN COALESCE(ssl_issued_at, NOW()) ELSE ssl_issued_at END
        WHERE id = ?`,
      [status, status, domainRow.id],
    );
    return { status, error: status === 'failed' ? stored.error : '', issued_at: stored.issued_at, live: true };
  } catch {
    return stored;
  }
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

/** A name under a domain already on the account. Not a registration. */
function isSubdomain(domainRow) {
  return domainRow?.source === 'subdomain';
}

/**
 * May this customer edit this domain's DNS with us?
 *
 * Only if we are the ones answering for it. A domain delegated to somebody
 * else's nameservers has its zone over there, and an editor that cheerfully
 * accepted records into a zone nobody queries would be a form that does
 * nothing — worse than no form at all, because the customer would believe the
 * change had been made.
 *
 * A SUBDOMAIN NEVER GETS ONE, and not merely because it rarely needs it. A
 * subdomain lives inside its parent's zone; that is the whole reason it does
 * not need a zone of its own. Giving it a second zone here would shadow the
 * records the customer can already edit on the parent — two places to change
 * one name, disagreeing with each other, with no indication of which is
 * winning. The parent's DNS page is the one true place.
 */
function mayEditDns(domainRow, customer) {
  if (!domainRow) return { ok: false, reason: 'Unknown domain.' };

  if (isSubdomain(domainRow)) {
    const parent = parentNameOf(domainRow.domain);
    return {
      ok: false,
      subdomain: true,
      reason: `DNS for a subdomain lives in ${parent ? `${parent}'s` : "its parent domain's"} zone. `
        + 'Edit it there and this name follows.',
    };
  }
  if (!mayPoint(domainRow)) {
    return { ok: false, reason: 'This domain is not pointing at us yet, so its DNS is not ours to edit.' };
  }
  /*
   * Verified by an A record, not by delegation. The site is served here and the
   * certificate is real, but the zone is still at their provider — so this
   * form would write into a zone nobody queries.
   */
  if (domainRow.verify_method === 'a') {
    return {
      ok: false,
      elsewhere: true,
      reason: 'This domain points here with an A record while its DNS stays at your own provider, '
        + 'so its records are changed there. Switch its nameservers to ours and the editor turns on.',
    };
  }
  if (!customer?.hestia_user) {
    return { ok: false, reason: 'DNS hosting comes with a hosting or email plan. There is not one on this account yet.' };
  }
  return { ok: true };
}

/**
 * May this domain have mailboxes, and does the customer have to do anything?
 *
 * SUBDOMAINS ARE REFUSED OUTRIGHT. A mail domain silently starts accepting mail
 * for a name and puts MX expectations on it; nobody should get that on a name
 * they added to host a shop on. Mail belongs on the main domain, and
 * `you@shop.example.com` is not an address anybody wants.
 *
 * `needsRecords` is the difference between the two ways of pointing at us. With
 * our nameservers we write the MX ourselves and mail simply works. With an A
 * record, the zone is theirs and mail cannot arrive until they add the records
 * — so the panel offers the mailbox AND shows exactly what to paste, rather
 * than refusing something that is perfectly possible.
 */
function mayHaveMail(domainRow) {
  if (!domainRow) return { ok: false, reason: 'Unknown domain.' };

  if (isSubdomain(domainRow)) {
    const parent = parentNameOf(domainRow.domain);
    return {
      ok: false,
      subdomain: true,
      reason: `Email is set up on ${parent || 'your main domain'}, not on a subdomain. `
        + 'Addresses look better that way, and a subdomain accepting mail is almost never what anyone wants.',
    };
  }
  if (!mayPoint(domainRow)) {
    return { ok: false, reason: 'This domain is not pointing at us yet, so we cannot accept mail for it.' };
  }
  return { ok: true, needsRecords: domainRow.verify_method === 'a' };
}

/**
 * The registrable name a subdomain sits under, worked out from the label count
 * rather than looked up — this is for a sentence in the panel, not a decision.
 * The authoritative parent is the row found by addSubdomain().
 */
function parentNameOf(name) {
  const labels = String(name || '').split('.');
  return labels.length > 2 ? labels.slice(1).join('.') : '';
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
  isSubdomain,
  findParent,
  issueSsl,
  refreshSsl,
  recordSsl,
  explainSslError,
  mayHaveMail,
  parentNameOf,
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
