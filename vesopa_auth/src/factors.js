/**
 * What somebody can prove, and what they are being asked to prove.
 *
 * THE GAP THIS CLOSES. Until now a person could enrol an authenticator app or a
 * passkey and it changed nothing: sign-in finished on the first factor and the
 * session was recorded as `aal1` regardless. The security page said two-step
 * verification was on, and it was not. That is the worst kind of security
 * feature — one that is believed.
 *
 * THE THREE QUESTIONS, and they are genuinely different:
 *
 *   what has this person got?      enrolled()
 *   what does this moment demand?  requiredFor()
 *   does the session meet it?      meets()
 *
 * Keeping them apart is what makes step-up possible. "Sign in" and "you may
 * read the payouts page" ask the same question of a different bar, and a system
 * that can only answer it at sign-in has to log people out to raise it — which
 * is how people learn to hate a security feature.
 */

const db = require('./db');

/** Assurance levels, weakest first. Comparison is by position in this list. */
const LEVELS = ['aal1', 'aal2', 'aal3'];

function rank(acr) {
  const index = LEVELS.indexOf(String(acr || 'aal1'));
  return index === -1 ? 0 : index;
}

/** Does what the session already proved satisfy what is being asked? */
function meets(sessionAcr, required) {
  if (!required) return true;
  return rank(sessionAcr) >= rank(required);
}

/**
 * The second factors this person actually holds.
 *
 * `firstFactorPhone` matters and is not decoration. If somebody signed in with
 * a code to their phone, texting that same phone again is not a second factor —
 * it is the same proof twice, and offering it would mean an account with "two
 * steps" that a stolen phone opens in one. So the caller passes what was used,
 * and SMS is withheld when it would be circular.
 */
async function enrolled(userId, { firstFactorPhone = null } = {}) {
  const [totp, passkeys, codes, phone] = await Promise.all([
    db.one(
      'SELECT id, label FROM user_totp WHERE user_id = ? AND confirmed_at IS NOT NULL AND revoked_at IS NULL',
      [userId],
    ),
    db.query(
      'SELECT id, name FROM user_passkeys WHERE user_id = ? AND revoked_at IS NULL',
      [userId],
    ),
    db.one(
      'SELECT COUNT(*) AS remaining FROM user_recovery_codes WHERE user_id = ? AND used_at IS NULL',
      [userId],
    ),
    db.one(
      `SELECT id, identifier, identifier_norm FROM user_identities
        WHERE user_id = ? AND type = 'phone' AND revoked_at IS NULL AND verified_at IS NOT NULL
        ORDER BY is_recovery, created_at LIMIT 1`,
      [userId],
    ),
  ]);

  const smsUsable =
    Boolean(phone) && (!firstFactorPhone || phone.identifier_norm !== firstFactorPhone);

  return {
    totp: totp || null,
    passkeys,
    sms: smsUsable ? phone : null,
    smsWithheld: Boolean(phone) && !smsUsable,
    recoveryCodesLeft: codes ? Number(codes.remaining) : 0,
    /** Is there any second factor at all? */
    any: Boolean(totp) || passkeys.length > 0,
  };
}

/**
 * The bar for this moment.
 *
 * Three things can raise it, and the strongest wins:
 *
 *   the person   — they enrolled a factor, so they expect to be asked
 *   the client   — `applications.min_acr`, set by whoever runs that product
 *   the request  — `acr_values`, sent by the application for one action
 *
 * A SCOPE CAN RAISE IT TOO, which is the subtle one: an application may be
 * ordinary until it asks for the scope that moves money, and demanding a second
 * factor for that alone is far better than demanding it for everything and
 * being turned off.
 */
async function requiredFor({ userId = null, application = null, scopes = [], requested = '' } = {}) {
  let required = 'aal1';

  if (userId) {
    const has = await enrolled(userId);
    if (has.any) required = 'aal2';
  }

  if (application && application.min_acr && rank(application.min_acr) > rank(required)) {
    required = application.min_acr;
  }

  if (scopes && scopes.length) {
    const rows = await db.query(
      `SELECT min_acr FROM scopes WHERE name IN (${scopes.map(() => '?').join(',')}) AND min_acr <> ''`,
      scopes,
    );
    for (const row of rows) {
      if (rank(row.min_acr) > rank(required)) required = row.min_acr;
    }
  }

  /*
   * `acr_values` from the application. Only ever raises the bar — an
   * application asking for LESS than the person has chosen would be an
   * application turning off somebody else's two-step verification, which is not
   * its decision to make.
   */
  const asked = String(requested || '')
    .split(/\s+/)
    .filter(Boolean);
  for (const value of asked) {
    if (rank(value) > rank(required)) required = value;
  }

  return required;
}

/**
 * May this device skip the second factor?
 *
 * Only when it was explicitly remembered, only while the trust has not expired,
 * and never for the FIRST factor. What being remembered buys is not having to
 * fetch your phone on the machine you use every day; it is not a way in.
 */
function deviceMaySkip(device) {
  if (!device || device.reuseDetected || device.revoked_at) return false;
  if (!device.trusted_until) return false;
  return new Date(device.trusted_until) > new Date();
}

/** The assurance a set of methods adds up to. */
function acrFor(amr) {
  const used = new Set(amr || []);
  // A passkey with user verification is possession and verification in one
  // gesture, so it stands on its own.
  if (used.has('webauthn')) return 'aal2';
  const first = ['pwd', 'otp', 'sms', 'google', 'apple', 'microsoft', 'github'].some((m) => used.has(m));
  const second = ['totp', 'sms2', 'recovery_code'].some((m) => used.has(m));
  return first && second ? 'aal2' : 'aal1';
}

module.exports = { LEVELS, rank, meets, enrolled, requiredFor, deviceMaySkip, acrFor };
