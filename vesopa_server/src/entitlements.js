/**
 * What a venue has paid for, asked of the place that sells it.
 *
 * WHY THE BACK OFFICE DOES NOT DECIDE THIS
 *
 * auth.vesopa.com holds the subscriptions -- quantity, status, renewal -- because
 * that is where a customer buys and manages them. The back office grew its own
 * copy of the quantity, with no status and no lifecycle, and nothing joined the
 * two. One number in two places is one number that will drift, and the copy that
 * is wrong is the one refusing a kitchen screen during service.
 *
 * So the number is fetched, not authored. `bo_licence_limits` becomes a CACHE of
 * what auth said (`source = 'auth'`) beside deliberate OVERRIDES a person typed
 * (`source = 'override'`), which are never overwritten and are labelled so that
 * nobody later mistakes a favour for what the customer actually pays for.
 *
 * IT FAILS OPEN, AND THAT IS THE WHOLE DESIGN
 *
 * Every failure here -- auth unreachable, credentials wrong, a venue not linked,
 * the migration not run -- leaves the last known answer in place and lets the
 * device through. A billing service being down must never be the reason a bar
 * cannot open its till. The enforcement code already fails open when the
 * database cannot be asked; this is the same rule applied one layer out.
 *
 * WHAT IS NOT YET TRUE
 *
 * auth currently holds exactly ONE organisation -- Vesopa's own -- so no
 * customer venue is linked to anything and every venue takes the unlinked path,
 * which is today's behaviour exactly. The mechanism is here; the commercial data
 * (an organisation per customer, with its own subscriptions) is a business setup
 * job, done per venue from the admin screen.
 */
const AUTH_BASE = (process.env.VESOPA_AUTH_ISSUER || 'https://auth.vesopa.com').replace(/\/+$/, '');
const CLIENT_ID = process.env.VESOPA_AUTH_BACKOFFICE_CLIENT_ID || '';
const CLIENT_SECRET = process.env.VESOPA_AUTH_BACKOFFICE_CLIENT_SECRET || '';

/** Whether this server is able to ask at all. */
const configured = () => Boolean(CLIENT_ID && CLIENT_SECRET);

/**
 * A product in auth's catalogue is a device kind here, where it is one.
 *
 * `menu`, `hosting`, `domain` and `loyalty` are sold but are not devices that
 * hold a seat, so they have no kind and are simply not cached. They still
 * appear on the admin's licence screen, which reads auth directly.
 */
const KIND_OF_PRODUCT = {
  epos: 'till',
  kitchen: 'kitchen',
  display: 'display',
  express: 'express',
};

/** How long an expired subscription keeps working before it counts against a venue. */
const GRACE_DAYS = 14;

/**
 * Ask auth what an organisation is entitled to.
 *
 * Resolves to null on any failure rather than throwing: every caller's correct
 * behaviour on "I could not find out" is "carry on with what I had".
 */
async function fetchFor(organisationId) {
  if (!configured() || !organisationId) return null;
  try {
    const res = await fetch(`${AUTH_BASE}/api/app/entitlements`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // The same client credentials the back office signs people in with.
        Authorization:
          'Basic ' +
          Buffer.from(
            `${encodeURIComponent(CLIENT_ID)}:${encodeURIComponent(CLIENT_SECRET)}`,
          ).toString('base64'),
      },
      body: JSON.stringify({ organisation_id: organisationId }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      console.warn(`[entitlements] auth answered ${res.status} for organisation ${organisationId}`);
      return null;
    }
    return await res.json();
  } catch (error) {
    console.warn('[entitlements] could not ask auth:', error.message);
    return null;
  }
}

/**
 * What a status means for a seat count.
 *
 * An expired subscription is a conversation, not a cliff. For the grace period
 * it is honoured in full and the back office says so loudly; after that it
 * stops granting seats. Nothing is ever signed OUT by this -- the limit simply
 * stops being generous, and the existing refusal rules take over at the next
 * sign-in.
 */
function seatsFrom(entry) {
  if (!entry) return null;
  const quantity = Number(entry.quantity) || 0;
  if (entry.status === 'active') return quantity;

  const ends = entry.ends_at ? new Date(entry.ends_at) : null;
  if (ends && Number.isFinite(ends.valueOf())) {
    const over = (Date.now() - ends.valueOf()) / 86400000;
    if (over < GRACE_DAYS) return quantity;
  }
  return 0;
}

/**
 * Refresh one venue's cached limits from auth.
 *
 * Returns what it wrote, or null when it could not ask -- in which case the
 * rows already in the table are left exactly as they are.
 */
async function refreshOffice(pool, office) {
  let row;
  try {
    [[row]] = await pool.query(
      'SELECT contact_email, auth_organisation_id FROM offices WHERE contact_email = ?',
      [office],
    );
  } catch (error) {
    if (error.code === 'ER_BAD_FIELD_ERROR') return null; // migration not run
    throw error;
  }
  if (!row || !row.auth_organisation_id) return null; // not linked: today's behaviour

  const answer = await fetchFor(row.auth_organisation_id);
  if (!answer || !answer.products) return null;

  const written = {};
  for (const [slug, entry] of Object.entries(answer.products)) {
    const kind = KIND_OF_PRODUCT[slug];
    if (!kind) continue;
    const seats = seatsFrom(entry);
    if (seats == null) continue;

    /*
     * An override is never touched. Somebody typed it on purpose, usually to
     * keep a venue trading while something commercial is sorted out, and having
     * a refresh quietly undo it would be the worst possible moment to find out
     * this job existed.
     */
    await pool.execute(
      `INSERT INTO bo_licence_limits
         (office, kind, seats, source, status, ends_at, checked_at, updated_by)
       VALUES (?, ?, ?, 'auth', ?, ?, NOW(), 'auth.vesopa.com')
       ON DUPLICATE KEY UPDATE
         seats      = IF(source = 'override', seats, VALUES(seats)),
         status     = IF(source = 'override', status, VALUES(status)),
         ends_at    = IF(source = 'override', ends_at, VALUES(ends_at)),
         checked_at = NOW()`,
      [row.contact_email, kind, seats, entry.status || null, entry.ends_at || null],
    );
    written[kind] = { seats, status: entry.status };
  }
  return written;
}

/** Refresh every linked venue. For a schedule, and for the admin's button. */
async function refreshAll(pool) {
  if (!configured()) return { linked: 0, refreshed: 0 };
  let offices = [];
  try {
    [offices] = await pool.query(
      'SELECT contact_email FROM offices WHERE auth_organisation_id IS NOT NULL AND demo_of IS NULL',
    );
  } catch (error) {
    if (error.code === 'ER_BAD_FIELD_ERROR') return { linked: 0, refreshed: 0 };
    throw error;
  }
  let refreshed = 0;
  for (const office of offices) {
    // One venue failing must not stop the rest.
    try {
      if (await refreshOffice(pool, office.contact_email)) refreshed += 1;
    } catch (error) {
      console.warn(`[entitlements] ${office.contact_email}:`, error.message);
    }
  }
  return { linked: offices.length, refreshed };
}

module.exports = {
  configured,
  KIND_OF_PRODUCT,
  GRACE_DAYS,
  seatsFrom,
  fetchFor,
  refreshOffice,
  refreshAll,
};
