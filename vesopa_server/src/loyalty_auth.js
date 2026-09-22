/**
 * How a member signs in to a venue's loyalty app, and what they can prove.
 *
 * WHAT THIS IS FOR
 *
 * The app had one way in: an email address and a code sent to it. Good default,
 * bad only-option. This makes the way in a venue's choice — a password, a
 * texted code, a passkey, the venue's Vesopa account — without making any of it
 * compulsory for the venues that are happy as they are.
 *
 * TWO QUESTIONS, KEPT APART, the same way Vesopa Auth keeps them apart:
 *
 *   what is possible here?   methodsFor()  — one row per way in
 *   what goes first?         policyFor()   — which one leads, nothing more
 *
 * A policy that could also switch a method off would give two places to look
 * when somebody cannot sign in, and they would disagree.
 *
 * SILENCE MEANS THE DEFAULT, NOT "NOTHING". A venue with no rows at all gets
 * email-and-a-code, which is what it already had. Nothing is backfilled, and a
 * venue cannot lock its own members out by never opening the page.
 *
 * NOTHING HERE IS A VESOPA ACCOUNT. A member of a venue's scheme is a row in
 * `epos_customers` — the venue's customer, not ours. Passkeys, passwords and
 * phone numbers are all stored against that row, deliberately apart from
 * `user_passkeys` and friends in auth: joining the two would quietly turn every
 * customer of every venue into an account holder.
 */
const crypto = require('crypto');

const bcrypt = require('bcryptjs');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');

/** Every way in this server knows about, in the order they are offered. */
const METHODS = ['code_email', 'password', 'passkey', 'code_sms', 'vesopa'];

/**
 * What a venue gets when it has never touched the page.
 *
 * Email and a code, because that is what the app has always done and a silent
 * change of somebody's sign-in is not a default anybody should ship.
 */
const DEFAULT_METHODS = { code_email: true };

const POLICIES = ['code_first', 'password_first', 'vesopa_first'];

/** Where a method needs something the server may not have. */
function available(method, env = process.env) {
  if (method === 'code_sms') return !!env.POSTCODER_API_KEY;
  if (method === 'vesopa') return !!(env.VESOPA_AUTH_ISSUER && env.VESOPA_LOYALTY_CLIENT_ID);
  return true;
}

/**
 * The ways in this venue offers, as `{ method: true }`.
 *
 * A method the venue switched on but the server cannot do — texting with no SMS
 * key, Vesopa with no OAuth client — is dropped here rather than offered and
 * failed. A button that cannot work is worse than one that is not there.
 */
async function methodsFor(db, office, env = process.env) {
  let rows = [];
  try {
    [rows] = await db.query(
      'SELECT method, enabled FROM epos_loyalty_app_methods WHERE office = ?', [office]
    );
  } catch (e) {
    // A server whose schema has not caught up still signs members in.
    if (e.code !== 'ER_NO_SUCH_TABLE') throw e;
  }
  const chosen = rows.length
    ? Object.fromEntries(rows.filter((r) => r.enabled).map((r) => [r.method, true]))
    : { ...DEFAULT_METHODS };

  const out = {};
  for (const m of METHODS) {
    if (chosen[m] && available(m, env)) out[m] = true;
  }
  /*
   * NEVER LEAVE A VENUE WITH NO DOOR.
   *
   * Switching every method off, or switching on only ones this server cannot
   * do, would lock out every member of that venue — including the person who
   * did it, who would then have no way to undo it from the app. Email and a
   * code is always the fallback: it needs nothing but the mail that is already
   * configured, and it is the method every member already has.
   */
  if (!Object.keys(out).length) out.code_email = true;
  return out;
}

/** Which way in leads. Falls back to one that is actually offered. */
function policyFor(settings, methods) {
  let policy = String((settings && settings.auth_policy) || 'code_first');
  if (!POLICIES.includes(policy)) policy = 'code_first';
  if (policy === 'password_first' && !methods.password) policy = 'code_first';
  if (policy === 'vesopa_first' && !methods.vesopa) policy = 'code_first';
  return policy;
}

/** What the app is told, so it can draw the right sign-in page. */
async function configFor(db, office, settings, env = process.env) {
  const methods = await methodsFor(db, office, env);
  return {
    methods: METHODS.filter((m) => methods[m]),
    policy: policyFor(settings, methods),
    // Whether a member may edit their own name, email and phone.
    self_service: !settings || settings.self_service == null ? true : !!Number(settings.self_service),
  };
}

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

/*
 * WHY bcrypt AND NOT SOMETHING NEWER: it is what the back office already hashes
 * staff passwords with, it is already a dependency, and one hashing scheme in a
 * codebase is one thing to get right. The cost is the library default, which is
 * ten rounds.
 */
const PASSWORD_MIN = 8;

/** Is this good enough to be somebody's password? Length only, deliberately. */
function passwordProblem(password) {
  const s = String(password || '');
  if (s.length < PASSWORD_MIN) return `Please use at least ${PASSWORD_MIN} characters.`;
  if (s.length > 200) return 'That password is too long.';
  /*
   * No character-class rules, on purpose. They push people towards
   * Passw0rd! — short, predictable, and worse than a long ordinary phrase.
   * Length is the requirement that actually helps.
   */
  return null;
}

const hashPassword = (password) => bcrypt.hash(String(password), 10);

/**
 * Check a password against a membership.
 *
 * Always spends the time, even where there is no password and no such member,
 * so that how long this takes cannot be used to ask whether an address is on a
 * venue's books.
 */
const NO_PASSWORD = '$2b$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv';
async function passwordMatches(customer, password) {
  const hash = (customer && customer.password_hash) || NO_PASSWORD;
  const ok = await bcrypt.compare(String(password || ''), hash);
  return !!(customer && customer.password_hash) && ok;
}

// ---------------------------------------------------------------------------
// Passkeys
// ---------------------------------------------------------------------------

/*
 * THE RELYING PARTY IS THE HOST THE APP IS SERVED FROM, not the venue's slug.
 *
 * Every venue's app is a path on one domain (…/app/<slug>/), so one relying
 * party covers them all, and a member with two venues' cards has a passkey
 * for each under the same RP — which is how a browser expects to store them.
 *
 * A PASSKEY IS BOUND TO EXACTLY ONE DOMAIN, and this is the one thing about
 * moving the app to loyalty.vesopa.com that cannot be fudged. A browser will
 * not accept an RP id that is not its own origin's domain or a parent of it,
 * and menu.vesopaepos.com is not a parent of loyalty.vesopa.com — they share
 * no registrable suffix. So the two hosts CANNOT both offer passkeys for the
 * same credentials: whichever host is not the RP id simply has none.
 *
 * Hence LOYALTY_RP_ID, set once at the cutover. Doing it before anybody has
 * registered a passkey costs nothing; doing it afterwards silently orphans
 * every passkey already made, and the member sees a sign-in that used to
 * work and now finds no key.
 */
function rp(env = process.env) {
  const host = String(env.LOYALTY_RP_ID || env.MENU_HOST || 'menu.vesopaepos.com').trim();
  /*
   * ORIGINS ARE NOT THE RP ID and both hosts may appear here. The RP id says
   * which domain the credential belongs to; the origin list says which pages
   * are allowed to present it. During a move, serving the app on both while
   * only one is the RP id is exactly right — the old host keeps working for
   * everything except passkeys.
   */
  const extra = String(env.LOYALTY_WEBAUTHN_ORIGINS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  return {
    id: host,
    name: 'Vesopa Loyalty',
    origins: [`https://${host}`, ...extra],
  };
}
const CHALLENGE_MINUTES = 5;

async function storeChallenge(db, { challenge, office, purpose, customerId = null }) {
  await db.execute(
    `INSERT INTO epos_loyalty_webauthn_challenges (challenge, office, purpose, customer_id, expires_at)
     VALUES (?, ?, ?, ?, NOW() + INTERVAL ${CHALLENGE_MINUTES} MINUTE)`,
    [challenge, office, purpose, customerId]
  );
}

/** Claim a challenge, single use, in one statement so two tabs cannot share it. */
async function claimChallenge(db, challenge, purpose) {
  const [res] = await db.execute(
    `UPDATE epos_loyalty_webauthn_challenges SET consumed_at = NOW()
      WHERE challenge = ? AND purpose = ? AND consumed_at IS NULL AND expires_at > NOW()`,
    [String(challenge || ''), purpose]
  );
  if (!res.affectedRows) return null;
  const [[row]] = await db.query(
    'SELECT * FROM epos_loyalty_webauthn_challenges WHERE challenge = ?', [String(challenge)]
  );
  return row || null;
}

/** Old challenges are rubbish, not history. */
async function sweepChallenges(db) {
  try {
    await db.execute(
      'DELETE FROM epos_loyalty_webauthn_challenges WHERE expires_at < NOW() - INTERVAL 1 DAY'
    );
  } catch (e) {
    if (e.code !== 'ER_NO_SUCH_TABLE') throw e;
  }
}

/** The options a browser needs to make a passkey for this member. */
async function registrationOptions(db, { office, customer, env = process.env }) {
  const [existing] = await db.query(
    `SELECT credential_id, transports FROM epos_loyalty_passkeys
      WHERE office = ? AND customer_id = ? AND revoked_at IS NULL`,
    [office, customer.id]
  );
  const party = rp(env);
  const options = await generateRegistrationOptions({
    rpName: party.name,
    rpID: party.id,
    // The membership id, not the email: an email can change and the handle the
    // browser stores against the passkey cannot.
    userID: Buffer.from(String(customer.id)),
    userName: customer.email || `member-${customer.member_no || customer.id}`,
    userDisplayName: customer.name || 'Member',
    attestationType: 'none',
    excludeCredentials: existing.map((c) => ({
      id: c.credential_id,
      transports: c.transports ? String(c.transports).split(',') : undefined,
    })),
    authenticatorSelection: {
      residentKey: 'preferred',
      // Discoverable where the device offers it, so a member can be signed in
      // without typing an address first. "preferred" rather than "required":
      // a required resident key is refused outright by some older keys, and
      // being refused is worse than typing an email.
      userVerification: 'preferred',
    },
  });
  await storeChallenge(db, { challenge: options.challenge, office, purpose: 'register', customerId: customer.id });
  return options;
}

/** Check what the browser made, and keep it. */
async function saveRegistration(db, { office, customer, body, name, env = process.env }) {
  const row = await claimChallenge(db, body && body.challenge, 'register');
  if (!row || row.customer_id !== customer.id) {
    return { error: 'That took too long. Please try again.' };
  }
  const party = rp(env);
  let result;
  try {
    result = await verifyRegistrationResponse({
      response: body.credential || body,
      expectedChallenge: row.challenge,
      expectedOrigin: party.origins,
      expectedRPID: party.id,
      requireUserVerification: false,
    });
  } catch (e) {
    return { error: 'That passkey could not be checked. Please try again.' };
  }
  if (!result.verified || !result.registrationInfo) {
    return { error: 'That passkey could not be checked. Please try again.' };
  }
  const info = result.registrationInfo.credential;
  await db.execute(
    `INSERT INTO epos_loyalty_passkeys
       (id, office, customer_id, credential_id, public_key, counter, transports, name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      crypto.randomUUID(), office, customer.id,
      info.id,
      Buffer.from(info.publicKey).toString('base64'),
      Number(info.counter) || 0,
      (info.transports || []).join(',') || null,
      String(name || '').trim().slice(0, 80) || null,
    ]
  );
  return { ok: true };
}

/**
 * The options a browser needs to sign in with a passkey.
 *
 * With no email, no credentials are named and the browser offers whatever
 * discoverable passkey it holds for this site — which is the whole point of a
 * passkey: no address typed, no code, one touch.
 */
async function authenticationOptions(db, { office, customer = null, env = process.env }) {
  let allow = [];
  if (customer) {
    const [rows] = await db.query(
      `SELECT credential_id, transports FROM epos_loyalty_passkeys
        WHERE office = ? AND customer_id = ? AND revoked_at IS NULL`,
      [office, customer.id]
    );
    allow = rows.map((c) => ({
      id: c.credential_id,
      transports: c.transports ? String(c.transports).split(',') : undefined,
    }));
  }
  const party = rp(env);
  const options = await generateAuthenticationOptions({
    rpID: party.id,
    allowCredentials: allow.length ? allow : undefined,
    userVerification: 'preferred',
  });
  await storeChallenge(db, {
    challenge: options.challenge, office, purpose: 'signin',
    customerId: customer ? customer.id : null,
  });
  return options;
}

/** Check a passkey sign-in. Answers the membership it proved, or an error. */
async function verifyAuthentication(db, { office, body, env = process.env }) {
  const row = await claimChallenge(db, body && body.challenge, 'signin');
  if (!row) return { error: 'That took too long. Please try again.' };

  const credentialId = String((body.credential && body.credential.id) || (body.id || ''));
  const [[key]] = await db.query(
    `SELECT * FROM epos_loyalty_passkeys
      WHERE office = ? AND credential_id = ? AND revoked_at IS NULL`,
    [office, credentialId]
  );
  if (!key) return { error: 'That passkey is not registered here.' };

  const party = rp(env);
  let result;
  try {
    result = await verifyAuthenticationResponse({
      response: body.credential || body,
      expectedChallenge: row.challenge,
      expectedOrigin: party.origins,
      expectedRPID: party.id,
      credential: {
        id: key.credential_id,
        publicKey: Buffer.from(key.public_key, 'base64'),
        counter: Number(key.counter) || 0,
        transports: key.transports ? String(key.transports).split(',') : undefined,
      },
      requireUserVerification: false,
    });
  } catch (e) {
    return { error: 'That passkey could not be checked. Please try again.' };
  }
  if (!result.verified) return { error: 'That passkey could not be checked. Please try again.' };

  /*
   * The counter only ever goes up. A device that replays an old one has been
   * cloned, and the right answer is to stop trusting that credential rather
   * than to let it in and hope. Devices that do not count at all report zero
   * for ever, which is allowed and is not a clone.
   */
  const seen = Number(result.authenticationInfo.newCounter) || 0;
  const had = Number(key.counter) || 0;
  if (seen && had && seen <= had) {
    await db.execute('UPDATE epos_loyalty_passkeys SET revoked_at = NOW() WHERE id = ?', [key.id]);
    return { error: 'That passkey has been withdrawn. Please sign in another way.' };
  }
  await db.execute(
    'UPDATE epos_loyalty_passkeys SET counter = ?, last_used_at = NOW() WHERE id = ?',
    [seen, key.id]
  );
  return { customerId: key.customer_id };
}

// ---------------------------------------------------------------------------
// Continue with Vesopa, before anybody has said which venue
// ---------------------------------------------------------------------------

/**
 * The venues a Vesopa account has been given, one membership each.
 *
 * The Store app is one app for every venue and asks for no venue code: a
 * venue gives somebody access by putting them on its books -- inviting their
 * email address, or linking their Vesopa account -- and signing in with Vesopa
 * is how they arrive. So this answers "which venues has this person been let
 * into", and NEVER makes a membership. Joining from the app with nothing but an
 * account would be self-registration, which no Vesopa product does.
 *
 * MATCHED ON THE SUBJECT FIRST, THE EMAIL SECOND, as the per-venue route does.
 * An email match is not taken where that membership is already linked to a
 * DIFFERENT Vesopa account: a changed address must not hand over a card
 * somebody else has claimed.
 *
 * THE OFFICE IS BOUND, NEVER JOINED. epos_customers.email_key and
 * epos_loyalty_app.office carry different collations on live, and comparing
 * the two columns is a 500 there and nowhere else.
 *
 * Only venues whose app is switched on. `email` must already be verified by
 * the caller.
 */
async function venuesForVesopa(db, { sub, email }) {
  const byOffice = new Map();
  if (sub) {
    const [rows] = await db.query(
      `SELECT id, email_key, vesopa_sub FROM epos_customers WHERE vesopa_sub = ?
        ORDER BY created_at`,
      [String(sub)]
    );
    for (const r of rows) if (!byOffice.has(r.email_key)) byOffice.set(r.email_key, r.id);
  }
  if (email) {
    const [rows] = await db.query(
      `SELECT id, email_key, vesopa_sub FROM epos_customers WHERE email = ?
        ORDER BY created_at`,
      [String(email)]
    );
    for (const r of rows) {
      if (byOffice.has(r.email_key)) continue;
      if (r.vesopa_sub && String(r.vesopa_sub) !== String(sub || '')) continue;
      byOffice.set(r.email_key, r.id);
    }
  }
  if (!byOffice.size) return [];
  const [apps] = await db.query(
    `SELECT slug, office, app_name, icon_url, logo_url FROM epos_loyalty_app
      WHERE enabled = 1 AND office IN (?) ORDER BY app_name`,
    [[...byOffice.keys()]]
  );
  return apps.map((a) => ({
    slug: a.slug,
    name: a.app_name || a.slug,
    icon: a.icon_url || a.logo_url || null,
    office: a.office,
    customerId: byOffice.get(a.office),
  }));
}

module.exports = {
  venuesForVesopa,
  METHODS,
  POLICIES,
  DEFAULT_METHODS,
  available,
  methodsFor,
  policyFor,
  configFor,
  PASSWORD_MIN,
  passwordProblem,
  hashPassword,
  passwordMatches,
  rp,
  registrationOptions,
  saveRegistration,
  authenticationOptions,
  verifyAuthentication,
  sweepChallenges,
};
