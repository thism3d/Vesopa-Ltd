/**
 * The keys that sign tokens, and the JWKS that lets everybody else check them.
 *
 * ROTATION NEEDS THREE STATES AT ONCE, which is why this is a table and not a
 * pair of files on disk:
 *
 *   active   the key signing right now
 *   next     published in the JWKS BEFORE it ever signs anything, so a client
 *            that cached the key set an hour ago already knows about it when
 *            the first token of the new era arrives
 *   retired  no longer signing, still published, because tokens it signed are
 *            still valid until they expire
 *
 * Skipping the `next` state is the classic rotation outage: the new key starts
 * signing, every client that cached the JWKS rejects every token as having an
 * unknown `kid`, and the fix looks like "our tokens are broken" rather than
 * "we rotated a key".
 *
 * RS256 AND NOT EdDSA, deliberately, and against the advice in plan/kimi-b.
 * Ed25519 is the better algorithm — smaller, faster, no padding to get wrong.
 * It is the worse default here because `jsonwebtoken`, still the most-installed
 * JWT library in Node, cannot verify it at all. The brief for this system is
 * "simple integration, big features", and an algorithm that makes the most
 * likely client library fail on its first line is not simple. The `algorithm`
 * column means moving to EdDSA later is a key rotation, not a migration.
 *
 * The private half is encrypted with the application's ENCRYPTION_KEY, which
 * lives in the environment. A dumped database cannot mint a token.
 */

const crypto = require('crypto');
const { importPKCS8, SignJWT, jwtVerify, createLocalJWKSet } = require('jose');

const config = require('./config');
const db = require('./db');
const { newId, encrypt, decrypt } = require('./crypto');

const ALGORITHM = 'RS256';
const MODULUS_BITS = 2048;

/*
 * A tiny cache, because every token minted would otherwise be a SELECT plus an
 * RSA key import. Cleared on rotation. Thirty seconds is short enough that a
 * key retired by hand takes effect almost at once, and long enough to matter.
 */
/*
 * Two independent timestamps, not one.
 *
 * With a shared `at`, refreshing the signer also made a stale key set look
 * fresh — so a key added by a rotation could stay invisible in the JWKS for as
 * long as anything kept signing, which is for ever on a busy server.
 */
let cache = { signerAt: 0, signer: null, jwksAt: 0, jwks: null };
const CACHE_MS = 30000;

function clearCache() {
  cache = { signerAt: 0, signer: null, jwksAt: 0, jwks: null };
}

/** Make a key and store it, in whichever state the caller asks for. */
async function createKey(status = 'next') {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: MODULUS_BITS,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const kid = newId();
  const jwk = crypto.createPublicKey(publicKey).export({ format: 'jwk' });

  await db.execute(
    `INSERT INTO signing_keys (kid, algorithm, public_jwk, private_cipher, status, activated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      kid,
      ALGORITHM,
      JSON.stringify({ ...jwk, kid, alg: ALGORITHM, use: 'sig' }),
      encrypt(privateKey, config.secrets.encryptionKey),
      status,
      status === 'active' ? new Date() : null,
    ],
  );

  clearCache();
  return kid;
}

/**
 * The key currently signing, creating one on first boot if there is none.
 *
 * Creating it here rather than in a setup script is on purpose: an identity
 * provider that will not start until somebody remembers to run a command is one
 * that will not start after a restore at two in the morning.
 */
async function activeKey() {
  if (cache.signer && Date.now() - cache.signerAt < CACHE_MS) return cache.signer;

  let row = await db.one(
    "SELECT * FROM signing_keys WHERE status = 'active' ORDER BY activated_at DESC LIMIT 1",
  );

  if (!row) {
    // Promote a `next` key if one is waiting, otherwise make the very first.
    const waiting = await db.one(
      "SELECT * FROM signing_keys WHERE status = 'next' ORDER BY created_at LIMIT 1",
    );
    if (waiting) {
      await db.execute(
        "UPDATE signing_keys SET status = 'active', activated_at = NOW() WHERE id = ?",
        [waiting.id],
      );
      row = { ...waiting, status: 'active' };
    } else {
      const kid = await createKey('active');
      row = await db.one('SELECT * FROM signing_keys WHERE kid = ?', [kid]);
    }
  }

  const pem = decrypt(row.private_cipher, config.secrets.encryptionKey);
  const key = await importPKCS8(pem, ALGORITHM);
  const signer = { kid: row.kid, key, algorithm: row.algorithm || ALGORITHM };

  cache = { ...cache, signerAt: Date.now(), signer };
  return signer;
}

/**
 * Everything a client should try when verifying: active, next and retired.
 *
 * Retired keys stay here until every token they signed has expired. Dropping
 * one the moment it stops signing invalidates tokens that are still perfectly
 * valid, and the symptom is intermittent 401s that clear up on their own — the
 * hardest kind of bug to be told about.
 */
async function jwks() {
  if (cache.jwks && Date.now() - cache.jwksAt < CACHE_MS) return cache.jwks;

  /*
   * Make sure a key exists before answering.
   *
   * Keys are created lazily by the first signature, which meant that on a fresh
   * install /jwks.json answered `{"keys":[]}` until somebody signed in. That is
   * worse than it sounds: fetching the key set at start-up and caching it is
   * exactly what a well-behaved client library does, so the first client to
   * boot would cache an empty set and reject every token until its cache
   * expired — while this server looked perfectly healthy.
   */
  await activeKey();

  const rows = await db.query(
    `SELECT public_jwk FROM signing_keys
      WHERE status IN ('active', 'next')
         OR (status = 'retired' AND retired_at > DATE_SUB(NOW(), INTERVAL 7 DAY))
      ORDER BY FIELD(status, 'active', 'next', 'retired'), created_at DESC`,
  );

  const keys = rows.map((row) =>
    typeof row.public_jwk === 'string' ? JSON.parse(row.public_jwk) : row.public_jwk,
  );

  const set = { keys };
  cache = { ...cache, jwksAt: Date.now(), jwks: set };
  return set;
}

/**
 * Rotate.
 *
 * The order is the whole point: publish the newcomer, wait, THEN switch. Called
 * with `--activate` by the scheduled job only after the new key has been in the
 * JWKS long enough for every client's cache to have expired.
 */
async function rotate({ activate = false } = {}) {
  if (!activate) {
    const kid = await createKey('next');
    return { staged: kid };
  }

  const next = await db.one(
    "SELECT * FROM signing_keys WHERE status = 'next' ORDER BY created_at LIMIT 1",
  );
  if (!next) return { error: 'no key staged — run rotate without --activate first' };

  await db.transaction(async (tx) => {
    await tx.execute(
      "UPDATE signing_keys SET status = 'retired', retired_at = NOW() WHERE status = 'active'",
    );
    await tx.execute(
      "UPDATE signing_keys SET status = 'active', activated_at = NOW() WHERE id = ?",
      [next.id],
    );
  });

  clearCache();
  return { activated: next.kid };
}

/** Sign a set of claims. */
async function sign(claims, { expiresIn, audience, type = 'JWT' }) {
  const signer = await activeKey();
  return new SignJWT(claims)
    .setProtectedHeader({ alg: signer.algorithm, kid: signer.kid, typ: type })
    .setIssuedAt()
    .setIssuer(config.issuer)
    .setAudience(audience)
    .setExpirationTime(`${expiresIn}s`)
    .setJti(newId())
    .sign(signer.key);
}

/**
 * Verify one of our own tokens — used by /introspect and by the tests.
 *
 * Third parties should verify locally against the JWKS instead; that is the
 * entire reason for publishing it, and asking us on every request would make
 * this box a single point of failure for every request they serve.
 */
async function verify(token, { audience } = {}) {
  const set = createLocalJWKSet(await jwks());
  return jwtVerify(token, set, {
    issuer: config.issuer,
    ...(audience ? { audience } : {}),
  });
}

module.exports = { createKey, activeKey, jwks, rotate, sign, verify, ALGORITHM };
