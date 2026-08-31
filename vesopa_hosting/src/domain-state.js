/**
 * What a domain's state IS, in the words a customer would use.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A MODULE AND NOT THREE COPIES OF AN `if`
 * ---------------------------------------------------------------------------
 * The overview, the domain list and the domain page each drew their own badge
 * and their own one-line summary from the same row, in three separate EJS
 * templates, using three different sets of conditions. They disagreed. The
 * overview's fallback branch was a bare `else` that printed "Registering…"
 * whenever `expires_at` was empty — which is true of every domain adopted from
 * the node, every subdomain, and every external domain somebody points at us.
 * So a customer with six live, working, already-registered websites saw all six
 * described as being registered, forever, with an ACTIVE badge next to each one
 * flatly contradicting the sentence beside it.
 *
 * That is the worst class of bug in a control panel: not a broken feature, but
 * a page confidently telling you something untrue about your own property. You
 * cannot fix it in one template, because the next template still lies.
 *
 * So the decision lives here, once, and returns everything a view needs to
 * render it. A view's only job is to place it.
 *
 * ---------------------------------------------------------------------------
 * THE STATES
 * ---------------------------------------------------------------------------
 * Named for what they mean to the person who owns the domain, not for the
 * column they came from:
 *
 *   live        Working. Serving from our node, nothing to do.
 *   waiting     WE are waiting on THEM. Always carries the specific job and a
 *               deadline, because "waiting" with no instruction is just anxiety.
 *   registering Genuinely in flight at the registry. Minutes to hours, and the
 *               customer does nothing. This is the state the old fallback stole.
 *   expiring    Live, but the clock is visible. Renewing is the action.
 *   expired     Past its date. Recoverable for a while; say so.
 *   parked      Ours, paid for, pointed nowhere. Not an error — a choice.
 *   closed      Cancelled or transferred away. History.
 *
 * `needsYou` is the one flag every list sorts and filters on. It is the honest
 * answer to "is there anything I have to do here", and it is false for five of
 * the seven states — which is the point.
 */

const { DOMAIN_NS_GRACE_DAYS, POINT_HOSTNAME } = require('./config');

/** Whole days from now until `value`, or null. Negative means it has passed. */
function daysUntil(value) {
  if (!value) return null;
  const at = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(at.getTime())) return null;
  return Math.ceil((at.getTime() - Date.now()) / 864e5);
}

/** "3 days", "1 day", "today" — a countdown a human reads without doing sums. */
function countdown(days) {
  if (days === null) return '';
  if (days <= 0) return 'today';
  if (days === 1) return '1 day';
  return `${days} days`;
}

/**
 * A domain we registered or transferred is one the REGISTRY holds for the
 * customer; an external one is a name they hold somewhere else and merely point
 * at us. The difference decides half the sentences on the page — whether there
 * is a renewal date to show, whether "Registering" is even a possible state,
 * and whether we may drop it from the list — so it is asked once, by name.
 */
function isOurs(d) {
  return d.source === 'registered' || d.source === 'transfer';
}

function isSub(d) {
  return d.source === 'subdomain';
}

/**
 * Describe one `domains` row.
 *
 * @param {object} d              the row
 * @param {object} [opts]
 * @param {number} [opts.graceDays]  overrides DOMAIN_NS_GRACE_DAYS in tests
 * @returns {{
 *   key: string, label: string, tone: 'green'|'amber'|'red'|'blue'|'grey',
 *   line: string, hint: string, needsYou: boolean, icon: string,
 *   expiresInDays: number|null, isSub: boolean, isOurs: boolean
 * }}
 */
function describe(d, opts = {}) {
  const graceDays = opts.graceDays ?? DOMAIN_NS_GRACE_DAYS;
  const expiresIn = daysUntil(d.expires_at);
  const graceLeft = daysUntil(d.ns_grace_until);

  const base = {
    expiresInDays: expiresIn,
    isSub: isSub(d),
    isOurs: isOurs(d),
    needsYou: false,
  };

  // ---- Gone --------------------------------------------------------------
  if (d.status === 'cancelled' || d.status === 'removed') {
    return {
      ...base,
      key: 'closed',
      label: 'Closed',
      tone: 'grey',
      icon: 'x',
      line: 'No longer on this account',
      hint: '',
    };
  }
  if (d.status === 'transferred_away') {
    return {
      ...base,
      key: 'closed',
      label: 'Transferred out',
      tone: 'grey',
      icon: 'external',
      line: 'Moved to another registrar',
      hint: '',
    };
  }

  // ---- Expired -----------------------------------------------------------
  if (d.status === 'expired') {
    return {
      ...base,
      key: 'expired',
      label: 'Expired',
      tone: 'red',
      icon: 'alert-circle',
      needsYou: true,
      line: 'The registration has lapsed — the website and email are off',
      hint: 'Most extensions can still be renewed for a short grace period. Renew now, or open a ticket if the button is gone.',
    };
  }

  // ---- In flight at the registry ------------------------------------------
  //
  // The ONLY route to "Registering". It requires a pending status AND a domain
  // we are actually buying. Nothing that arrives from the node, nothing
  // external, and no subdomain can reach it — which is the whole repair.
  if (d.status === 'pending' && isOurs(d)) {
    return {
      ...base,
      key: 'registering',
      label: 'Registering',
      tone: 'blue',
      icon: 'clock',
      line: d.source === 'transfer'
        ? 'Transfer in progress — the losing registrar has to release it'
        : 'We are registering this with the registry now',
      hint: d.source === 'transfer'
        ? 'Transfers take up to five days and the old registrar may email you to confirm. Nothing for you to do here.'
        : 'Usually a few minutes. We email you the moment it is yours, and it is set up here automatically.',
    };
  }

  // A pending row that is NOT one of ours is a subdomain or an external domain
  // mid-setup on the node. Say that, rather than borrowing a registry word.
  if (d.status === 'pending') {
    return {
      ...base,
      key: 'registering',
      label: 'Setting up',
      tone: 'blue',
      icon: 'clock',
      line: 'Being set up on the server',
      hint: 'This takes a few seconds. Refresh the page if it is still here in a minute.',
    };
  }

  // ---- Waiting on the customer -------------------------------------------
  if (d.status === 'awaiting_ns') {
    const left = countdown(graceLeft);
    return {
      ...base,
      key: 'waiting',
      label: 'Waiting for you',
      tone: 'amber',
      icon: 'alert-circle',
      needsYou: true,
      line: graceLeft === null
        ? 'Not pointing at us yet'
        : graceLeft <= 0
          ? 'Not pointing at us — last day'
          : `Not pointing at us — ${left} left`,
      hint: isOurs(d)
        ? 'Set the nameservers on this domain to ours and it goes live automatically.'
        : `Point this domain at us — either switch its nameservers to ours, or add an A record aimed at ${POINT_HOSTNAME}. `
          + `If neither happens within ${graceDays} days we take it off this list; the domain itself is never touched.`,
    };
  }

  // ---- Active ------------------------------------------------------------
  //
  // Everything below here is a working domain. The remaining question is only
  // whether something is about to need attention.
  const secured = d.ssl_status === 'active';

  if (expiresIn !== null && expiresIn <= 30) {
    return {
      ...base,
      key: 'expiring',
      label: expiresIn <= 0 ? 'Expires today' : `${expiresIn} ${expiresIn === 1 ? 'day' : 'days'} left`,
      tone: expiresIn <= 7 ? 'red' : 'amber',
      icon: 'clock',
      needsYou: !d.auto_renew,
      line: d.auto_renew
        ? `Renews automatically on ${d.expires_at}`
        : `Expires ${d.expires_at} — auto-renew is off`,
      hint: d.auto_renew
        ? 'We take payment a few days before the date so a card problem cannot cost you the name.'
        : 'Turn auto-renew on, or renew by hand. A lapsed domain can be bought by anybody.',
    };
  }

  // Ours, but pointed nowhere. A legitimate thing to do with a name you are
  // holding — so it gets its own calm state rather than a warning.
  if (!d.pointed_at && !d.ns_verified_at && isOurs(d)) {
    return {
      ...base,
      key: 'parked',
      label: 'Parked',
      tone: 'grey',
      icon: 'pin',
      line: 'Registered to you, not pointed at a website yet',
      // Names the control, because "attach it to hosting" described something
      // the panel had no way to do until the Hosting card existed on the
      // domain's own page. A hint that cannot be acted on is a complaint.
      hint: 'Nothing is wrong. Open the domain and pick a plan under "Hosting" '
        + 'whenever you want a website on it — we set up the DNS, the site and the certificate.',
    };
  }

  const bits = [];
  if (isSub(d)) {
    bits.push('Subdomain');
    if (d.mail_enabled) bits.push('email on');
  } else if (isOurs(d)) {
    bits.push(d.expires_at ? `Renews ${d.expires_at}` : 'Registered with us');
    if (d.expires_at) bits.push(d.auto_renew ? 'auto-renew on' : 'auto-renew off');
  } else {
    bits.push('Registered elsewhere');
    bits.push(d.verify_method === 'a' ? 'pointed here by A record' : 'hosted here');
  }
  if (secured) bits.push('secured');

  return {
    ...base,
    key: 'live',
    label: 'Live',
    tone: 'green',
    icon: 'check-circle',
    line: bits.join(' · '),
    hint: secured
      ? ''
      : 'A free certificate is issued automatically once DNS has settled. If the padlock is still missing after an hour, retry it from this page.',
  };
}

/**
 * Split a list into the three piles a customer actually thinks in.
 *
 * Sorting by expiry date — which the list used to do — puts the one domain
 * that needs a nameserver change somewhere in the middle of nine that do not,
 * and there is nothing on the page to say which one to look at.
 */
function group(domains, opts) {
  const out = { needsYou: [], inFlight: [], fine: [] };
  domains.forEach((d) => {
    const state = describe(d, opts);
    const row = { ...d, state };
    if (state.needsYou) out.needsYou.push(row);
    else if (state.key === 'registering') out.inFlight.push(row);
    else out.fine.push(row);
  });
  return out;
}

module.exports = { describe, group, daysUntil, countdown, isOurs, isSub };
