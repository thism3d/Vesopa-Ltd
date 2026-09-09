/**
 * Turning what somebody typed into the one string we compare against.
 *
 * WHY THIS IS A MODULE AND NOT THREE LINES INLINE
 *
 * Every identifier in this system is stored twice: once as the person wrote it,
 * for showing back to them, and once normalised, for deciding whether two
 * things are the same thing. If those two forms are computed differently in the
 * sign-in path and the registration path — one lower-cases, the other does not
 * — then a person registers `Sam@example.com` and cannot sign in as
 * `sam@example.com`, and the account looks lost. So there is exactly one
 * function per identifier type, and every caller uses it.
 *
 * The normalised form is stored in a `utf8mb4_bin` column, so this file is the
 * *only* place case is decided. That is deliberate: a case-insensitive
 * collation would also fold provider subject ids, which are case-sensitive
 * opaque strings, and two different people would collide.
 */

const { parsePhoneNumberFromString } = require('libphonenumber-js');

/**
 * Email.
 *
 * Lower-case the whole thing, and — for Gmail only — remove the dots and the
 * `+tag` from the local part.
 *
 * WHY GMAIL ONLY. Google states that `s.a.m@gmail.com`, `sam@gmail.com` and
 * `sam+shopping@gmail.com` are one mailbox, so treating them as three accounts
 * lets one person mint unlimited accounts against a single inbox — which
 * matters here because an account is a thing that can hold a role.
 *
 * Applying the same rule everywhere else would be a much worse bug in the
 * opposite direction: at most providers a dot is significant, so stripping dots
 * globally welds `j.smith@company.com` and `jsmith@company.com` — two different
 * colleagues — into one account. When in doubt, two accounts is recoverable and
 * one shared account is not.
 *
 * Plus-addressing at other providers is left alone: it is how people file their
 * mail, and it is theirs to use.
 */
function normaliseEmail(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;

  const at = raw.lastIndexOf('@');
  if (at <= 0 || at === raw.length - 1) return null;

  let local = raw.slice(0, at).toLowerCase();
  let domain = raw.slice(at + 1).toLowerCase();

  // A trailing dot on the domain is legal in DNS and meaningless here.
  domain = domain.replace(/\.$/, '');
  if (!domain.includes('.') || domain.includes('..')) return null;
  if (/[\s<>,;"'\\]/.test(local) || /[\s<>,;"'\\]/.test(domain)) return null;

  // Google's own two names for the same service.
  if (domain === 'googlemail.com') domain = 'gmail.com';

  if (domain === 'gmail.com') {
    local = local.split('+')[0].replace(/\./g, '');
    if (!local) return null;
  }

  const normalised = `${local}@${domain}`;
  return normalised.length > 254 ? null : normalised;
}

/**
 * Is this one of Apple's private relay addresses?
 *
 * Apple hands each app a different forwarding alias so the person can keep
 * their real address to themselves. It is a real, deliverable address and it is
 * NOT evidence of anything about the person's other addresses — so it must
 * never be matched against one, and it must never be an account's only way
 * back in, because the person can switch the relay off and it stops existing.
 */
function isPrivateRelay(email) {
  return /@privaterelay\.appleid\.com$/i.test(String(email || '').trim());
}

/**
 * Phone, to E.164 — `+447700900123`.
 *
 * `defaultCountry` is what an entry with no dial code is assumed to be. It is
 * passed in rather than hard-coded to GB, because the caller knows which
 * country the person picked in the flag menu and this module should not.
 *
 * Note what this does NOT do: decide whether we can text it. Postcoder sends to
 * UK mobiles only, and that limit belongs at the sending edge, not here — the
 * database should be able to hold a French number long before we can SMS one.
 */
function normalisePhone(input, defaultCountry = 'GB') {
  const raw = String(input || '').trim();
  if (!raw) return null;

  const parsed = parsePhoneNumberFromString(raw, defaultCountry);
  if (!parsed || !parsed.isValid()) return null;
  return parsed.number; // E.164
}

/**
 * A provider's subject id: byte for byte, exactly as given.
 *
 * There is nothing to normalise. It is an opaque string chosen by Google or
 * GitHub, it can be case-sensitive, and "tidying" it — trimming, lower-casing,
 * parsing the numeric ones as numbers — is how you eventually fail to recognise
 * a returning user, or recognise the wrong one.
 */
function normaliseSubject(input) {
  const raw = String(input == null ? '' : input);
  return raw.length > 0 && raw.length <= 255 ? raw : null;
}

/**
 * Normalise by identity type, so callers do not have to switch on it.
 * Returns null when the value is not usable as that kind of identifier.
 */
function normaliseIdentifier(type, value, options = {}) {
  if (type === 'email') return normaliseEmail(value);
  if (type === 'phone') return normalisePhone(value, options.country || 'GB');
  return normaliseSubject(value);
}

/**
 * Which kind of thing did the person type into the one box on the login page?
 *
 * The form has an email/phone toggle, so this is a safety net rather than the
 * primary answer — it catches somebody typing a number while the box says
 * email, which is otherwise a confusing "that address doesn't look right".
 */
function guessIdentifierType(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  if (raw.includes('@')) return 'email';
  if (/^[+()\d][\d\s()-]{5,}$/.test(raw)) return 'phone';
  return null;
}

module.exports = {
  normaliseEmail,
  normalisePhone,
  normaliseSubject,
  normaliseIdentifier,
  isPrivateRelay,
  guessIdentifierType,
};
