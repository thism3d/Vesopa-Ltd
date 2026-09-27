/**
 * Registrations, as people type them and as cameras read them.
 *
 * A member types "ab12 cde"; a camera reports "AB12CDE", or on a wet night
 * "AB12C0E". Everything is compared in the NORMAL form -- upper case, letters
 * and digits only -- and, where a lane allows it, in the FUZZY form, which
 * folds together the characters ANPR engines confuse most.
 */

function normalise(input) {
  return String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** "AB12CDE" -> "AB12 CDE" for a current UK plate; anything else as typed. */
function display(input) {
  const typed = String(input || '').toUpperCase().replace(/\s+/g, ' ').trim();
  const n = normalise(input);
  if (/^[A-Z]{2}[0-9]{2}[A-Z]{3}$/.test(n)) return `${n.slice(0, 4)} ${n.slice(4)}`;
  return typed.replace(/[^A-Z0-9 ]/g, '').slice(0, 20) || n;
}

/**
 * Whether this can be a registration at all. Deliberately loose: UK plates
 * run from one letter and one digit (dateless) to seven characters, and
 * members park foreign and trade cars too. Two to ten, at least one digit or
 * a plausible all-letter cherished plate of three or more.
 */
function valid(input) {
  const n = normalise(input);
  if (n.length < 2 || n.length > 10) return false;
  return /[0-9]/.test(n) || n.length >= 3;
}

// The pairs an ANPR engine mixes up, folded to one character each.
const FOLD = { O: '0', Q: '0', D: '0', I: '1', Z: '2', S: '5', B: '8', G: '6' };

function fuzzy(input) {
  return normalise(input).replace(/[OQDIZSBG]/g, (c) => FOLD[c]);
}

module.exports = { normalise, display, valid, fuzzy };
