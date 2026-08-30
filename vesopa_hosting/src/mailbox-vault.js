/**
 * One-click webmail, and the uncomfortable thing it requires.
 *
 * ---------------------------------------------------------------------------
 * THE PROBLEM
 * ---------------------------------------------------------------------------
 * A customer clicks their own mailbox in the panel and expects to be reading it
 * a second later. They are already signed in — proving who they are twice in
 * ten seconds is the exact friction this panel exists to remove.
 *
 * But a mailbox password is not the panel password. It is a separate credential
 * the customer chose, Roundcube authenticates against Dovecot with it, and
 * neither Hestia nor Dovecot will hand it back or accept a token in its place.
 * There is no SSO to turn on. So there are only three honest options:
 *
 *   1. Ask for the password every time.        Correct, and what they complained about.
 *   2. Reset it to something we know.          Breaks the phone and Outlook silently.
 *   3. Keep a copy we can replay.              What this file does.
 *
 * ---------------------------------------------------------------------------
 * WHY OPTION 3 IS DEFENSIBLE HERE, AND WHERE IT ISN'T
 * ---------------------------------------------------------------------------
 * The ciphertext lives in the database; the key lives in the environment. A
 * stolen database dump — the overwhelmingly common breach — yields nothing.
 * Recovering a password requires the application server as well, and an
 * attacker who has that already holds HESTIA_API_KEY, which can change any
 * mailbox password on the node outright. So this adds no capability an attacker
 * with the server does not already have, and none at all to one without it.
 *
 * That reasoning has limits and they are worth stating:
 *
 *   - It is OPT-IN, per mailbox, defaulting to OFF. Somebody who does not want
 *     us holding this can have every other feature without it.
 *   - We store it only when the customer types it into OUR form. A mailbox made
 *     on the node, or one whose password was changed elsewhere, simply has no
 *     entry and the panel asks for the password like it always did.
 *   - There is one AAD per row binding the ciphertext to the address it belongs
 *     to, so a row moved to another mailbox fails to decrypt rather than
 *     quietly unlocking the wrong inbox.
 *   - Without MAILBOX_KEY set, this module stores NOTHING. The feature is off,
 *     the panel says so, and nothing half-works.
 *
 * ---------------------------------------------------------------------------
 * MAILBOX_KEY
 * ---------------------------------------------------------------------------
 * 32 bytes, base64 or hex. Generate with:
 *
 *     node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 *
 * Rotating it does not break anything except one-click sign-in: every stored
 * entry stops decrypting, the panel falls back to asking for the password, and
 * the rows are replaced the next time somebody sets one.
 */

const crypto = require('node:crypto');

const db = require('./db');

const ALGO = 'aes-256-gcm';

let cachedKey;

/** The key, or null when the feature is switched off. Parsed once. */
function key() {
  if (cachedKey !== undefined) return cachedKey;
  const raw = process.env.MAILBOX_KEY || '';
  if (!raw) { cachedKey = null; return cachedKey; }
  let buf;
  try {
    buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  } catch {
    buf = null;
  }
  if (!buf || buf.length !== 32) {
    console.error('[vault] MAILBOX_KEY must be 32 bytes as base64 or hex — one-click webmail is off.');
    cachedKey = null;
    return cachedKey;
  }
  cachedKey = buf;
  return cachedKey;
}

function enabled() {
  return key() !== null;
}

/**
 * Encrypt, binding the result to the address it belongs to.
 *
 * The address goes in as additional authenticated data rather than being
 * encrypted: it is not a secret, and as AAD it means a ciphertext copied onto a
 * different mailbox's row fails the auth tag instead of decrypting into
 * somebody else's inbox.
 */
function seal(address, secret) {
  const k = key();
  if (!k) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, k, iv);
  cipher.setAAD(Buffer.from(String(address).toLowerCase(), 'utf8'));
  const body = Buffer.concat([cipher.update(String(secret), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

function open(address, packed) {
  const k = key();
  if (!k || !packed) return null;
  try {
    const buf = Buffer.from(packed, 'base64');
    if (buf.length < 29) return null;
    const decipher = crypto.createDecipheriv(ALGO, k, buf.subarray(0, 12));
    decipher.setAAD(Buffer.from(String(address).toLowerCase(), 'utf8'));
    decipher.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    // A wrong key, a tampered row or a rotated secret all land here. Falling
    // back to asking for the password is the right answer to every one.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/**
 * Remember a mailbox password so the panel can sign in on the customer's behalf.
 *
 * `customerId` is stored alongside so a read can be scoped to the account that
 * owns it — the address alone is not an authorisation, and a query that trusted
 * it would hand any signed-in customer any mailbox on the node.
 */
async function remember({ customerId, address, password }) {
  if (!enabled()) return false;
  const sealed = seal(address, password);
  if (!sealed) return false;
  await db.query(
    `INSERT INTO mailbox_secrets (customer_id, address, sealed)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE sealed = VALUES(sealed), customer_id = VALUES(customer_id),
                             updated_at = CURRENT_TIMESTAMP`,
    [customerId, String(address).toLowerCase(), sealed],
  );
  return true;
}

/** @returns {Promise<string|null>} the password, or null for every failure. */
async function recall({ customerId, address }) {
  if (!enabled()) return null;
  const row = await db.one(
    'SELECT sealed FROM mailbox_secrets WHERE customer_id = ? AND address = ? LIMIT 1',
    [customerId, String(address).toLowerCase()],
  );
  return row ? open(address, row.sealed) : null;
}

async function forget({ customerId, address }) {
  await db.query(
    'DELETE FROM mailbox_secrets WHERE customer_id = ? AND address = ?',
    [customerId, String(address).toLowerCase()],
  );
}

/** Which of these addresses we can sign in as, for rendering a list. */
async function knownFor(customerId, addresses) {
  if (!enabled() || !addresses.length) return new Set();
  const rows = await db.query(
    `SELECT address FROM mailbox_secrets
      WHERE customer_id = ? AND address IN (${addresses.map(() => '?').join(',')})`,
    [customerId, ...addresses.map((a) => String(a).toLowerCase())],
  );
  return new Set(rows.map((r) => r.address));
}

module.exports = { enabled, remember, recall, forget, knownFor };
