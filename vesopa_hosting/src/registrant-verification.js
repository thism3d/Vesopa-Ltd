/**
 * ICANN's registrant email verification, and why the panel kept asking for one
 * that had already been done.
 *
 * ## What the obligation actually is
 *
 * Under the 2013 RAA a registrar must verify the registrant's EMAIL ADDRESS,
 * and it is the address that gets verified — not the domain. Once
 * somebody@example.com has confirmed once, every gTLD registered to that same
 * address afterwards is covered by that confirmation and no second email is
 * sent. The registrar is required to suspend a domain only where the address
 * behind it has never been confirmed at all.
 *
 * The old code recorded the obligation per DOMAIN and had no way to clear it.
 * `verification_deadline` was written at registration, `registrant_verified_at`
 * was never written by anything, and the panel therefore counted down to a
 * suspension that was not going to happen. That is the arpi.site report: an
 * address the registrar had already verified, a red banner saying otherwise,
 * and no button anywhere that could change it.
 *
 * ## What this module does about it
 *
 * Verification is tracked against the ADDRESS, in `registrant_verifications`,
 * and a domain is clear when its registrant address is. So the moment one
 * domain's address is confirmed — by the registry, by the customer, or by an
 * admin — every other domain on that address stops asking. That is the "check
 * if it is verified by others" the fault report asked for.
 *
 * ## What the registrar can and cannot tell us
 *
 * DomainNameAPI's REST gateway has NO verification endpoint. Probed on
 * 2026-09-08 against the live account:
 *
 *   GET domains/verification            404
 *   GET domains/contact-verification    404
 *   GET domains/verification-status     404
 *   GET domains/contacts/verification   404
 *
 * `domains/info` carries no verification field either — for arpi.site it
 * returns `status: Active`, `statusCode: clientTransferProhibited`, and nothing
 * about the registrant's address.
 *
 * So the registry status is the only machine-readable evidence there is, and it
 * is one-directional but real: a registrar that has NOT had the address
 * confirmed must put the domain on hold, and a domain on hold says so in
 * `statusCode`. That gives two facts worth acting on:
 *
 *   a hold is present            definitely not verified, and the domain is
 *                                already suspended — which is much more urgent
 *                                than a countdown and is said differently.
 *
 *   deadline passed, no hold     verified. The registrar would have suspended
 *                                it otherwise; that is the whole mechanism.
 *
 * Inside the fifteen days with no hold, the registry cannot tell us either way,
 * because a domain stays live while the clock runs. That case is what the
 * customer's own "I have already confirmed this" is for — they are the only
 * party who saw the email, and they are the authority on whether they clicked
 * the link in it. It is recorded with who said so and when.
 */

const db = require('./db');
const registrar = require('./integrations/domainnameapi');
const { sendMail, shell, detailTable, escapeHtml } = require('./mailer');
const { SITE_URL, CONTACT } = require('./config');

/**
 * Registry status codes that mean the name is suspended.
 *
 * `serverHold` and `clientHold` are the two the registry and the registrar
 * apply respectively, and an unverified registrant is the commonest reason for
 * the second one. `pendingVerification` and `inactive` are what some registries
 * report during the window instead.
 */
const HOLD_CODES = ['serverhold', 'clienthold', 'pendingverification', 'pending_verification', 'inactive'];

/** How long between one resend and the next. */
const RESEND_COOLDOWN_MS = 15 * 60_000;

function normaliseEmail(email) {
  return String(email || '').trim().toLowerCase();
}

/* -------------------------------------------------------------------------
   The address ledger
   ------------------------------------------------------------------------- */

/**
 * Which of these addresses have been verified, as a Map of address -> row.
 *
 * One query for a whole page of domains rather than one per domain: the
 * dashboard renders every domain on the account and the notification builder
 * walks the same list.
 */
async function verifiedAddresses(emails) {
  const wanted = [...new Set((emails || []).map(normaliseEmail).filter(Boolean))];
  if (!wanted.length) return new Map();

  const rows = await db.query(
    `SELECT email, verified_at, source, first_domain
       FROM registrant_verifications
      WHERE email IN (${wanted.map(() => '?').join(',')})
        AND verified_at IS NOT NULL`,
    wanted,
  );
  return new Map(rows.map((r) => [normaliseEmail(r.email), r]));
}

/**
 * Write down that an address is verified, and clear every domain on it.
 *
 * Idempotent, and the FIRST answer wins: a later "the customer told us" must
 * not overwrite an earlier "the registry proved it", because the registry is
 * the better evidence and the audit trail is the point of recording the source
 * at all.
 */
async function noteVerified(email, { source = 'customer', domain = '', adminId = null } = {}) {
  const address = normaliseEmail(email);
  if (!address) return { ok: false, error: 'No registrant address to record.' };

  await db.query(
    `INSERT INTO registrant_verifications (email, verified_at, source, noted_by, first_domain)
     VALUES (?, NOW(), ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       verified_at = COALESCE(verified_at, NOW()),
       source      = IF(verified_at IS NULL, VALUES(source), source),
       noted_by    = IF(verified_at IS NULL, VALUES(noted_by), noted_by)`,
    [address, source, adminId, String(domain || '').slice(0, 190)],
  );

  /*
   * Every domain on that address, not just the one that triggered it. This is
   * the whole point: one confirmation covers the registrant, so a customer who
   * verifies while adding their second domain should not be nagged about their
   * first.
   */
  const cleared = await db.query(
    `UPDATE domains
        SET registrant_verified_at = COALESCE(registrant_verified_at, NOW())
      WHERE registrant_email = ? AND registrant_verified_at IS NULL`,
    [address],
  );

  return { ok: true, email: address, cleared: cleared?.affectedRows || 0 };
}

/* -------------------------------------------------------------------------
   Asking the registry
   ------------------------------------------------------------------------- */

/**
 * What the registry currently says about this domain.
 *
 * Never throws — a registrar that is down is "we could not ask", which is not
 * the same as "not verified" and must not be shown as one.
 *
 * @returns {Promise<{ok: boolean, held: boolean, status: string, codes: string[], error: string}>}
 */
async function registryStatus(domainName) {
  try {
    const info = await registrar.getDomain(domainName);
    if (!info?.ok) return { ok: false, held: false, status: '', codes: [], error: 'No answer from the registrar.' };
    if (info.mock) return { ok: false, held: false, status: '', codes: [], error: 'Registrar is in mock mode.' };

    const codes = String(info.status_code || info.statusCode || '')
      .split(/[\s,]+/)
      .concat(String(info.status || '').split(/[\s,]+/))
      .map((c) => c.trim().toLowerCase())
      .filter(Boolean);

    return {
      ok: true,
      held: codes.some((c) => HOLD_CODES.includes(c)),
      status: String(info.status || ''),
      codes,
      error: '',
    };
  } catch (err) {
    return { ok: false, held: false, status: '', codes: [], error: err.message };
  }
}

/**
 * Re-read a domain's verification state and act on what comes back.
 *
 * Returns the state the panel should render, and writes down anything it
 * learned. The three outcomes are the three in the header comment.
 */
async function check(domainRow) {
  const email = normaliseEmail(domainRow.registrant_email);

  // Already settled, here or on another domain with the same registrant.
  if (domainRow.registrant_verified_at) {
    return { outstanding: false, state: 'verified', source: 'record', email };
  }
  const known = await verifiedAddresses([email]);
  if (known.has(email)) {
    await db.query(
      `UPDATE domains SET registrant_verified_at = COALESCE(registrant_verified_at, ?)
        WHERE id = ? AND registrant_verified_at IS NULL`,
      [known.get(email).verified_at, domainRow.id],
    );
    return {
      outstanding: false,
      state: 'verified',
      source: known.get(email).source,
      email,
      // Which domain the confirmation originally came from, so the panel can
      // say "you confirmed this address on <domain>" rather than nothing.
      via_domain: known.get(email).first_domain || '',
    };
  }

  const registry = await registryStatus(domainRow.domain);
  await db.query('UPDATE domains SET verification_checked_at = NOW() WHERE id = ?', [domainRow.id]);

  if (!registry.ok) {
    return {
      outstanding: true, state: 'unknown', email, registry, error: registry.error,
    };
  }

  if (registry.held) {
    /*
     * Suspended. This is the failure the countdown was warning about, and it
     * has already happened — so it stops being a countdown and becomes a
     * "your domain is off and here is how to turn it back on".
     */
    return { outstanding: true, state: 'suspended', email, registry };
  }

  const deadline = domainRow.verification_deadline ? new Date(domainRow.verification_deadline) : null;
  if (deadline && deadline.getTime() < Date.now()) {
    /*
     * Past the deadline, live, and not on hold. The registrar suspends an
     * unverified registrant — that is the obligation — so a domain still
     * answering after the deadline is a domain whose address was confirmed.
     */
    const noted = await noteVerified(email, { source: 'registry', domain: domainRow.domain });
    return {
      outstanding: false, state: 'verified', source: 'registry', email, cleared: noted.cleared,
    };
  }

  // Inside the window and nothing is wrong. Not proof either way.
  return { outstanding: true, state: 'waiting', email, registry };
}

/* -------------------------------------------------------------------------
   Sending it again
   ------------------------------------------------------------------------- */

/**
 * Ask for the verification to be sent again.
 *
 * TWO THINGS HAPPEN, and the button says both, because only one of them is
 * within our gift:
 *
 *   1. The registrant contact is re-submitted to the registrar. This is the
 *      only lever the gateway offers — there is no resend endpoint (see the
 *      probe results at the top of this file) — and re-filing the contact is
 *      what puts the address back through the registrar's own verification
 *      cycle.
 *
 *   2. We email the registrant ourselves, saying what to look for. This is the
 *      part that reliably works, and it is worth as much as the first: the
 *      commonest reason the registrar's email is "never received" is that it
 *      came from a sender the customer did not recognise and went to spam. A
 *      note from us, naming the domain and the deadline, is what gets them to
 *      go and look.
 *
 * Rate-limited to one every fifteen minutes per domain. A resend button that
 * can be leaned on is a way to send somebody thirty emails.
 */
async function resend(domainRow, customer) {
  const email = normaliseEmail(domainRow.registrant_email) || normaliseEmail(customer?.email);
  if (!email) return { ok: false, error: 'This domain has no registrant address on file.' };

  const last = domainRow.verification_sent_at ? new Date(domainRow.verification_sent_at) : null;
  if (last && Date.now() - last.getTime() < RESEND_COOLDOWN_MS) {
    const wait = Math.ceil((RESEND_COOLDOWN_MS - (Date.now() - last.getTime())) / 60_000);
    return {
      ok: false,
      error: `We sent one a moment ago. Give it ${wait} more minute${wait === 1 ? '' : 's'} and check your spam folder.`,
    };
  }

  /*
   * Re-file the contact. A no-op write of the details already on record: it
   * cannot change the registrant, and on a gateway with no resend endpoint it
   * is the only thing that touches the verification cycle at all. Failure here
   * is NOT failure of the whole action — our own email is the half that
   * reliably reaches the customer, and it is sent either way.
   */
  let registrarNote = '';
  try {
    // `updateContacts` takes the customer row itself and shapes it into the
    // gateway's four contact types — see its own signature; handing it an
    // already-shaped contact would drop every field it looks for.
    await registrar.updateContacts({ domain: domainRow.domain, contact: customer });
    registrarNote = 'refiled at the registrar';
  } catch (err) {
    registrarNote = `registrar refile failed (${err.message})`;
  }

  const deadline = domainRow.verification_deadline
    ? new Date(domainRow.verification_deadline).toDateString()
    : '';

  await sendMail({
    to: email,
    subject: `Confirm your email address for ${domainRow.domain}`,
    html: shell({
      title: 'Confirm your email address',
      intro: `The registry that runs <b>${escapeHtml(domainRow.domain)}</b> requires the owner of a `
        + 'domain to confirm their email address once. Until it is done, the registry can suspend the domain.',
      bodyHtml: `
        ${detailTable([
    ['Domain', escapeHtml(domainRow.domain)],
    ['Address to confirm', escapeHtml(email)],
    ...(deadline ? [['Confirm by', escapeHtml(deadline)]] : []),
  ])}
        <p style="margin:18px 0 8px;font-size:15px;line-height:1.6;">
          <b>The confirmation email does not come from us.</b> It comes from the registrar, so it will
          not have Vesopa in the sender name — which is why it is so often missed. Search your inbox
          and your spam folder for <b>${escapeHtml(domainRow.domain)}</b> and click the link inside it.
        </p>
        <p style="margin:0 0 8px;font-size:15px;line-height:1.6;">
          Already clicked it? Open the domain in your panel and press <b>I have already confirmed this</b>,
          and we will stop asking — for this domain and every other one you hold on this address.
        </p>`,
      ctaText: 'Open the domain',
      ctaUrl: `${SITE_URL}/panel/domains/${domainRow.id}#verification`,
      footNote: `Stuck? Reply to this address or write to ${CONTACT.support_email}.`,
    }),
  }).catch(() => { /* a bounced reminder must not fail the action */ });

  await db.query('UPDATE domains SET verification_sent_at = NOW() WHERE id = ?', [domainRow.id]);

  await db.logActivity({
    actorType: 'customer',
    actorId: customer?.id || null,
    action: 'domain.verification_resent',
    target: domainRow.domain,
    detail: `to ${email}; ${registrarNote}`,
  });

  return { ok: true, email, registrarNote };
}

/**
 * The customer says they have already confirmed it.
 *
 * Taken at their word, and recorded as their word — `source: 'customer'`, with
 * the domain it came from. They are the only party who saw the registrar's
 * email, the registry gives us no way to ask, and the alternative is a red
 * banner nobody can ever clear. It applies to the ADDRESS, so it settles every
 * domain they hold on it.
 */
async function confirmByCustomer(domainRow, customer) {
  const email = normaliseEmail(domainRow.registrant_email) || normaliseEmail(customer?.email);
  if (!email) return { ok: false, error: 'This domain has no registrant address on file.' };

  /*
   * Ask the registry first. If it says the domain is on hold then it has NOT
   * been verified, whatever the customer believes — and telling them so is far
   * more use than accepting the claim and leaving a suspended domain looking
   * healthy in the panel.
   */
  const registry = await registryStatus(domainRow.domain);
  if (registry.ok && registry.held) {
    return {
      ok: false,
      held: true,
      error: `The registry still has ${domainRow.domain} on hold (${registry.codes.join(', ')}), `
        + 'which means the confirmation has not reached it. Open the registrar\'s email and click the '
        + 'link, or send it again from here.',
    };
  }

  const noted = await noteVerified(email, { source: 'customer', domain: domainRow.domain });

  await db.logActivity({
    actorType: 'customer',
    actorId: customer?.id || null,
    action: 'domain.verification_confirmed',
    target: domainRow.domain,
    detail: `${email} marked confirmed by the customer; cleared ${noted.cleared} domain(s)`,
  });

  return { ok: true, email, cleared: noted.cleared };
}

module.exports = {
  HOLD_CODES,
  RESEND_COOLDOWN_MS,
  verifiedAddresses,
  noteVerified,
  registryStatus,
  check,
  resend,
  confirmByCustomer,
  normaliseEmail,
};
