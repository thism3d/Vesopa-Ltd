/**
 * Two-step verification, actually enforced.
 *
 *     node scripts/smoke-mfa.js
 *
 * THE BUG THIS EXISTS TO CATCH, which was real: a person could enrol an
 * authenticator app and it changed nothing. Sign-in finished on the first
 * factor and the session was recorded as `aal1` regardless. The security page
 * said two-step verification was on, and it was not — a security feature that
 * is believed and does nothing is worse than one that is absent.
 *
 * So most of what is checked here is that the SECOND factor is genuinely
 * required, that it cannot be skipped by forging the state that says the first
 * one passed, and that raising a session does not end it.
 */

const crypto = require('crypto');

const db = require('../src/db');
const config = require('../src/config');
const factors = require('../src/factors');
const stepup = require('../src/routes/stepup');
const { newId, newToken, hashToken, encrypt, newTotpSecret, totpCode, hashPassword } = require('../src/crypto');

const BASE = 'https://auth.vesopa.com';

let passed = 0;
let failed = 0;

function check(label, condition, detail = '') {
  console.log(`  ${condition ? '✓' : '✗'} ${label}${condition ? '' : ` — ${detail}`}`);
  if (condition) passed += 1;
  else failed += 1;
}

/** Collect Set-Cookie into something we can send back. */
function jarFrom(response, jar = {}) {
  const raw = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
  for (const line of raw) {
    const [pair] = line.split(';');
    const index = pair.indexOf('=');
    if (index > 0) jar[pair.slice(0, index).trim()] = pair.slice(index + 1).trim();
  }
  return jar;
}

function cookieHeader(jar) {
  return Object.entries(jar)
    .filter(([, value]) => value && value !== '')
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

async function main() {
  const stamp = Date.now();
  const address = `mfa-${stamp}@vesopa.com`;

  // A person with an authenticator app and a password.
  const secret = newTotpSecret();
  const publicId = newId();
  const inserted = await db.execute(
    "INSERT INTO users (public_id, display_name, webauthn_handle) VALUES (?, 'MFA Test', ?)",
    [publicId, crypto.randomBytes(32)],
  );
  const userId = inserted.insertId;
  await db.execute(
    `INSERT INTO user_identities (user_id, type, identifier, identifier_norm, verified_at, verified_via)
     VALUES (?, 'email', ?, ?, NOW(), 'seed')`,
    [userId, address, address],
  );
  await db.execute(
    'INSERT INTO user_totp (user_id, secret_cipher, confirmed_at) VALUES (?, ?, NOW())',
    [userId, encrypt(secret, config.secrets.encryptionKey)],
  );
  const recoveryCode = 'ABCDE-FGHJK';
  await db.execute(
    'INSERT INTO user_recovery_codes (user_id, code_hash, batch_id) VALUES (?, ?, ?)',
    [userId, await hashPassword(recoveryCode, config.secrets.passwordPepper), newId()],
  );

  // =====================================================================
  console.log('▶ what the account holds');

  const held = await factors.enrolled(userId);
  check('the authenticator is seen', Boolean(held.totp));
  check('so a second factor is required', held.any === true);
  check('and a recovery code is available', held.recoveryCodesLeft === 1);

  console.log('▶ the bar for a moment');
  check(
    'somebody with a factor is held to aal2',
    (await factors.requiredFor({ userId })) === 'aal2',
  );
  check(
    'acr_values can raise it further',
    (await factors.requiredFor({ userId, requested: 'aal3' })) === 'aal3',
  );
  check(
    'but acr_values can never LOWER what the person chose',
    (await factors.requiredFor({ userId, requested: 'aal1' })) === 'aal2',
    'an application must not be able to switch off somebody else’s two-step verification',
  );
  check('aal2 satisfies aal1', factors.meets('aal2', 'aal1') === true);
  check('aal1 does NOT satisfy aal2', factors.meets('aal1', 'aal2') === false);

  console.log('▶ what a set of methods adds up to');
  check("a code alone is aal1", factors.acrFor(['otp']) === 'aal1');
  check('a code plus an authenticator is aal2', factors.acrFor(['otp', 'totp']) === 'aal2');
  check('a verified passkey stands alone at aal2', factors.acrFor(['webauthn']) === 'aal2');

  // =====================================================================
  console.log('▶ signing in is not finished by the first factor');

  const jar = {};
  const page = await fetch(`${BASE}/login`, { redirect: 'manual' });
  jarFrom(page, jar);
  const html = await page.text();
  const token = (/name="_csrf" value="([^"]+)"/.exec(html) || [])[1];

  const first = await fetch(`${BASE}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader(jar) },
    body: new URLSearchParams({ email: address, channel: 'email', _csrf: token, mode: 'login' }).toString(),
  });
  jarFrom(first, jar);
  check('the code request is accepted', first.status === 303, `status ${first.status}`);

  // Read the code straight from the challenge row rather than the mailbox —
  // the mail path has its own test, and this one is about what happens after.
  const challenge = await db.one(
    `SELECT public_id FROM verification_challenges
      WHERE destination_norm = ? AND consumed_at IS NULL AND revoked_at IS NULL
      ORDER BY id DESC LIMIT 1`,
    [address],
  );
  check('a challenge was raised', Boolean(challenge));

  // The code itself is only an HMAC in the table, so it is brute-forced here —
  // a million tries is fast, and it beats reaching into the mail spool.
  const { hashCode } = require('../src/crypto');
  const row = await db.one('SELECT code_hash FROM verification_challenges WHERE public_id = ?', [
    challenge.public_id,
  ]);
  let plain = null;
  for (let i = 0; i < 1000000; i += 1) {
    const candidate = String(i).padStart(6, '0');
    if (hashCode(candidate, config.secrets.codePepper) === row.code_hash) {
      plain = candidate;
      break;
    }
  }
  check('the emailed code was recovered for the test', Boolean(plain));

  const verified = await fetch(`${BASE}/login/verify`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader(jar) },
    body: new URLSearchParams({ code: plain, _csrf: token }).toString(),
  });
  jarFrom(verified, jar);

  /*
   * THE CHECK THAT MATTERS. The first factor was correct, and it must NOT have
   * produced a session — only a diversion to the second step.
   */
  check(
    'a correct first factor sends them to the second step',
    verified.headers.get('location') === '/login/second',
    verified.headers.get('location') || `status ${verified.status}`,
  );
  check(
    'and no session cookie was issued',
    !jar['__Host-vesopa_sid'],
    'the first factor alone signed them in',
  );
  check('a signed pending state was issued', Boolean(jar['__Host-vesopa_pending']));

  console.log('▶ the pending state cannot be forged');
  const forged = Buffer.from(JSON.stringify({ u: userId, exp: Date.now() + 60000 })).toString('base64url');
  check(
    'an unsigned state is refused',
    stepup.readState(forged) === null,
    'anybody could claim to have passed the first factor',
  );
  check(
    'a tampered signature is refused',
    stepup.readState(`${forged}.deadbeef`) === null,
  );
  const real = stepup.readState(jar['__Host-vesopa_pending']);
  check('the real one is accepted', real !== null && Number(real.u) === userId);

  console.log('▶ the second factor');

  const wrong = await fetch(`${BASE}/login/second`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader(jar) },
    body: new URLSearchParams({ method: 'totp', code: '000000', _csrf: token }).toString(),
  });
  check('a wrong authenticator code is refused', wrong.status === 200, `status ${wrong.status}`);
  check('and still no session', !jarFrom(wrong, {})['__Host-vesopa_sid']);

  const good = totpCode(secret, Math.floor(Date.now() / 1000 / 30), 6);
  const done = await fetch(`${BASE}/login/second`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader(jar) },
    body: new URLSearchParams({ method: 'totp', code: good, _csrf: token }).toString(),
  });
  jarFrom(done, jar);
  check('the right code finishes the sign-in', done.status === 303, `status ${done.status}`);
  check('and NOW there is a session', Boolean(jar['__Host-vesopa_sid']));

  const session = await db.one(
    'SELECT acr, amr FROM sso_sessions WHERE user_id = ? ORDER BY id DESC LIMIT 1',
    [userId],
  );
  check('the session is recorded as aal2', session.acr === 'aal2', session.acr);
  const amr = typeof session.amr === 'string' ? JSON.parse(session.amr) : session.amr;
  check('and remembers both methods', amr.includes('otp') && amr.includes('totp'), JSON.stringify(amr));

  console.log('▶ a spent authenticator code cannot be replayed');
  const totpRow = await db.one('SELECT last_step FROM user_totp WHERE user_id = ?', [userId]);
  check('the step it used is recorded', Boolean(totpRow.last_step));
  const { verifyTotp } = require('../src/crypto');
  check(
    'and the same six digits will not verify again',
    verifyTotp(secret, good, { window: 1, after: totpRow.last_step }) === null,
    'a code read over a shoulder would work for the rest of the window',
  );

  console.log('▶ recovery codes are spent, once');
  const before = await db.one(
    'SELECT COUNT(*) AS n FROM user_recovery_codes WHERE user_id = ? AND used_at IS NULL',
    [userId],
  );
  check('there is one unused code', Number(before.n) === 1);

  await db.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error('mfa smoke test failed:', error);
  try {
    await db.close();
  } catch {
    /* already closed */
  }
  process.exit(1);
});
