/**
 * Every secret operation in one file, so there is one place to audit.
 *
 * The rules this file exists to keep:
 *
 *   * Nothing that authenticates somebody is stored in a form that can be used.
 *     Long random tokens are stored as SHA-256; short ones (a six-digit code)
 *     are stored as HMAC under a server-side pepper, because SHA-256 of a
 *     million possibilities is a rainbow table you can build on a laptop.
 *   * Anything the server must be able to READ BACK — a TOTP seed, a signing
 *     key — is encrypted, never hashed, with a key that lives in the
 *     environment and not in the database. A dumped database is then a pile of
 *     ciphertext rather than a set of working credentials.
 *   * Comparisons of secret material are timing-safe. The leak is small and
 *     real, and the fix is one function call.
 */

const crypto = require('crypto');
const argon2 = require('@node-rs/argon2');

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

// Crockford base32: no I, L, O or U, so an id read down a phone line does not
// become a different id.
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * A 26-character, time-ordered public id (a ULID).
 *
 * Time-ordered matters more than it looks: these are primary lookup keys, and
 * random ids scatter InnoDB inserts across the index. Sortable ones also mean
 * "the most recent sessions" is an ORDER BY on a column that is already there.
 *
 * This is a public id, not a secret. It identifies; it never authorises.
 */
function newId() {
  const now = Date.now();
  let out = '';

  // 10 characters of millisecond timestamp.
  let time = now;
  for (let i = 9; i >= 0; i -= 1) {
    out = CROCKFORD[time % 32] + out;
    time = Math.floor(time / 32);
  }

  // 16 characters of randomness.
  const bytes = crypto.randomBytes(16);
  for (let i = 0; i < 16; i += 1) out += CROCKFORD[bytes[i] % 32];

  return out;
}

/**
 * A bearer token: 256 bits, URL-safe.
 *
 * Used for session cookies, device cookies, refresh tokens, invitation links.
 * 32 bytes because the whole security of these is that they cannot be guessed;
 * there is no rate limit that saves a short one.
 */
function newToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/**
 * A numeric code a human will retype, and the reason it is generated this way.
 *
 * `randomInt` is rejection-sampled, so every code is equally likely.
 * `randomBytes % 1000000` is not: it favours the low end, which over a large
 * number of codes is a measurable bias in a space that is already only a
 * million wide.
 */
function newNumericCode(digits = 6) {
  const max = 10 ** digits;
  return String(crypto.randomInt(0, max)).padStart(digits, '0');
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/** For high-entropy values: session tokens, refresh tokens, invite tokens. */
function hashToken(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

/**
 * For low-entropy values: the six-digit codes we email.
 *
 * A plain hash of a six-digit code is reversible by trying all million, which
 * takes well under a second. The pepper — a server secret that is not in the
 * database — is what makes the stolen table useless on its own.
 */
function hashCode(value, pepper) {
  if (!pepper) throw new Error('hashCode requires a pepper');
  return crypto.createHmac('sha256', pepper).update(String(value), 'utf8').digest('hex');
}

/** Constant-time comparison of two hex digests. */
function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

/**
 * Argon2id at OWASP's baseline: 19 MiB, two passes, one lane.
 *
 * WHY NOT MORE. The usual advice is 64 MiB, and on a dedicated box that would
 * be right. This server also runs the hosting control panel, the mail stack and
 * MariaDB, and 64 MiB per concurrent login is how an identity provider takes
 * the mail server down at nine on a Monday. 19 MiB is the documented minimum
 * that is still considered strong, and it is a number to raise the day this
 * moves to its own machine.
 *
 * WHY NOT BCRYPT. bcryptjs is pure JavaScript, blocks the event loop for
 * hundreds of milliseconds, and does not resist GPUs. Argon2id resists both
 * GPUs and ASICs by needing memory, and the native binding runs off-thread.
 */
const ARGON2 = {
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
  algorithm: argon2.Algorithm.Argon2id,
};

async function hashPassword(plain, pepper) {
  return argon2.hash(peppered(plain, pepper), ARGON2);
}

async function verifyPassword(hash, plain, pepper) {
  if (!hash) return false;
  try {
    return await argon2.verify(hash, peppered(plain, pepper));
  } catch {
    // A malformed stored hash must read as "wrong password", never as a crash
    // that reveals which accounts have unusual rows.
    return false;
  }
}

/**
 * The pepper goes through HMAC first rather than being concatenated.
 *
 * Concatenation runs into Argon2's own input handling and, more importantly,
 * into the 72-byte truncation people remember from bcrypt; hashing to a fixed
 * 32 bytes first means the password length stops mattering at all.
 */
function peppered(plain, pepper) {
  if (!pepper) return String(plain);
  return crypto.createHmac('sha256', pepper).update(String(plain), 'utf8').digest('base64');
}

// ---------------------------------------------------------------------------
// Encryption at rest
// ---------------------------------------------------------------------------

/**
 * AES-256-GCM, for the things that must be read back: TOTP seeds and the
 * private halves of the signing keys.
 *
 * The output carries its own version byte, so the key can be rotated later
 * without having to guess how an old row was written. GCM rather than CBC
 * because it authenticates as well as encrypts: a row edited in the database
 * fails to decrypt rather than silently becoming a different secret.
 */
function encrypt(plaintext, keyHex) {
  const key = keyBuffer(keyHex);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), body]);
}

function decrypt(payload, keyHex) {
  const buffer = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (buffer.length < 30 || buffer[0] !== 1) throw new Error('unrecognised ciphertext');
  const key = keyBuffer(keyHex);
  const iv = buffer.subarray(1, 13);
  const tag = buffer.subarray(13, 29);
  const body = buffer.subarray(29);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

function keyBuffer(keyHex) {
  const key = Buffer.from(String(keyHex || ''), 'hex');
  if (key.length !== 32) {
    throw new Error('encryption key must be 64 hex characters (32 bytes)');
  }
  return key;
}

// ---------------------------------------------------------------------------
// Pairwise subject identifiers
// ---------------------------------------------------------------------------

/**
 * The `sub` a third-party application sees.
 *
 * Derived from the person and the application, so it is stable for that app for
 * ever and means nothing to any other app — two unrelated developers cannot
 * compare their user lists and discover they share customers.
 *
 * Keyed to the application's own salt, never to its redirect URI: developers
 * add and change URIs, and a `sub` that moved when they did would orphan every
 * row they had stored against it.
 */
function pairwiseSubject(userPublicId, sectorSalt, pepper) {
  return crypto
    .createHmac('sha256', `${sectorSalt}:${pepper}`)
    .update(String(userPublicId), 'utf8')
    .digest('base64url')
    .slice(0, 43);
}

// ---------------------------------------------------------------------------
// TOTP — RFC 6238
// ---------------------------------------------------------------------------

/**
 * Written out rather than pulled in as a dependency, because it is thirty lines
 * of HMAC and the test vectors in the RFC prove it. See test/totp.test.js —
 * an authenticator implementation with no test vectors is a guess.
 */
function newTotpSecret(bytes = 20) {
  return base32Encode(crypto.randomBytes(bytes));
}

function totpCode(secretBase32, step, digits = 6) {
  const key = base32Decode(secretBase32);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));

  const digest = crypto.createHmac('sha1', key).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);

  return String(binary % 10 ** digits).padStart(digits, '0');
}

/**
 * Check a code against a small window either side of now.
 *
 * Returns the step it matched, or null. The step is returned rather than a
 * boolean so the caller can store it: without recording which step was spent,
 * the same six digits work again for the rest of the window, and a code read
 * over somebody's shoulder is reusable for half a minute.
 */
function verifyTotp(secretBase32, code, { period = 30, digits = 6, window = 1, after = null } = {}) {
  const clean = String(code || '').replace(/\D/g, '');
  if (clean.length !== digits) return null;

  const now = Math.floor(Date.now() / 1000 / period);
  for (let drift = -window; drift <= window; drift += 1) {
    const step = now + drift;
    if (after != null && step <= after) continue; // already spent
    if (safeEqual(totpCode(secretBase32, step, digits), clean)) return step;
  }
  return null;
}

/** The string behind the QR code an authenticator app scans. */
function totpUri(secretBase32, account, issuer = 'Vesopa') {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(input) {
  const clean = String(input).toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index === -1) throw new Error('invalid base32');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

module.exports = {
  newId,
  newToken,
  newNumericCode,
  hashToken,
  hashCode,
  safeEqual,
  hashPassword,
  verifyPassword,
  encrypt,
  decrypt,
  pairwiseSubject,
  newTotpSecret,
  totpCode,
  verifyTotp,
  totpUri,
  base32Encode,
  base32Decode,
};
