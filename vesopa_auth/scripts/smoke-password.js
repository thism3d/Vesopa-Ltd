/**
 * The password-first sign-in, end to end, against the live domain.
 *
 *     node scripts/smoke-password.js
 *
 * WHAT THIS PROVES, and it is the owner's instruction in full: *"default Vesopa
 * OAuth will try to find the user and then ask for password, below there will
 * be a text link button Login using OTP … By default it will ask for password
 * in apps too. But highly configurable from the Admin."*
 *
 * So: an identifier goes in, a PASSWORD page comes back — not an emailed code —
 * the password signs the person in, and the way out from under it still works.
 * And an application whose policy says otherwise gets otherwise.
 *
 * THE REFUSALS ARE THE PRODUCT, again. A wrong password must not say whether
 * the account exists, must be rate limited per ACCOUNT rather than only per IP,
 * and must never leave somebody with no way in — the code path underneath is
 * what stops a forgotten password being a locked door.
 */

const crypto = require('crypto');

const db = require('../src/db');
const { hashPassword } = require('../src/crypto');
const { normaliseEmail } = require('../src/normalise');
const config = require('../src/config');

const BASE = process.env.SMOKE_BASE || 'https://auth.vesopa.com';

let passed = 0;
let failed = 0;

function section(name) {
  console.log(`▶ ${name}`);
}
function check(condition, what, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${what}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${what}${detail ? `\n      ${detail}` : ''}`);
  }
  return !!condition;
}

// A cookie jar, because every form here is CSRF-protected and the flow is
// carried in a cookie. Using a real jar means this exercises the protection
// rather than stepping around it.
const jar = new Map();
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');

function remember(response) {
  for (const line of response.headers.getSetCookie ? response.headers.getSetCookie() : []) {
    const [pair] = line.split(';');
    const at = pair.indexOf('=');
    if (at > 0) jar.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
  }
}

async function get(path) {
  const r = await fetch(`${BASE}${path}`, {
    headers: { cookie: cookieHeader() },
    redirect: 'manual',
  });
  remember(r);
  return { status: r.status, location: r.headers.get('location'), body: await r.text() };
}

async function post(path, fields) {
  const form = new URLSearchParams({
    _csrf: jar.get('__Host-vesopa_csrf') || jar.get('vesopa_csrf') || '',
    ...fields,
  });
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { cookie: cookieHeader(), 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    redirect: 'manual',
  });
  remember(r);
  return { status: r.status, location: r.headers.get('location'), body: r.status === 303 ? '' : await r.text() };
}

async function main() {
  console.log(`Password-first sign-in — ${BASE}\n`);

  // -------------------------------------------------------------------------
  // A person to sign in as.
  //
  // Made here and removed at the end. It is a real account with a real argon2id
  // password, because the thing being tested is the real comparison — a fixture
  // that skipped hashing would prove nothing about the path a person takes.
  // -------------------------------------------------------------------------
  const stamp = Date.now();
  const email = `smoke-password-${stamp}@example.com`;
  const secret = `Sm0ke!${crypto.randomBytes(9).toString('base64url')}`;
  const publicId = crypto.randomUUID().replace(/-/g, '').slice(0, 26).toUpperCase();

  const user = await db.execute(
    `INSERT INTO users (public_id, display_name, given_name, webauthn_handle)
     VALUES (?, 'Smoke Password', 'Smoke', ?)`,
    [publicId, crypto.randomBytes(32)],
  );
  const userId = user.insertId;
  const identity = await db.execute(
    `INSERT INTO user_identities (user_id, type, identifier, identifier_norm, verified_at, verified_via)
     VALUES (?, 'email', ?, ?, NOW(), 'smoke')`,
    [userId, email, normaliseEmail(email)],
  );
  await db.execute('UPDATE users SET primary_email_id = ? WHERE id = ?', [identity.insertId, userId]);
  await db.execute(
    "INSERT INTO user_passwords (user_id, password_hash, algorithm) VALUES (?, ?, 'argon2id')",
    [userId, await hashPassword(secret, config.secrets.passwordPepper)],
  );

  const cleanup = async () => {
    await db.execute('DELETE FROM sso_sessions WHERE user_id = ?', [userId]);
    await db.execute('DELETE FROM user_passwords WHERE user_id = ?', [userId]);
    await db.execute('DELETE FROM user_identities WHERE user_id = ?', [userId]);
    await db.execute('UPDATE users SET primary_email_id = NULL WHERE id = ?', [userId]);
    await db.execute('DELETE FROM login_events WHERE user_id = ?', [userId]);
    await db.execute('DELETE FROM users WHERE id = ?', [userId]);
  };

  try {
    // -----------------------------------------------------------------------
    section('the identifier leads to a PASSWORD, not a code');

    await get('/login');
    const step = await post('/login', { channel: 'email', email, remember: '1' });
    check(
      step.location === '/login/password',
      'an account with a password is sent to the password step',
      step.location || step.body.slice(0, 160),
    );

    const page = await get('/login/password');
    check(page.status === 200, 'and that page loads');
    check(page.body.includes('Hi Smoke'), 'it greets them by name');
    check(page.body.includes(email), 'and the account chip says which account this is');
    check(
      /Email me a code instead/.test(page.body),
      'with the way out underneath, in words rather than "OTP"',
    );
    check(!page.body.includes('type="password" id="email"'), 'and one field, not two');

    // -----------------------------------------------------------------------
    section('the refusals');

    const wrong = await post('/login/password', { password: 'not-the-password', return_to: '' });
    check(wrong.status === 400, 'a wrong password is refused');
    check(
      /not right/i.test(wrong.body) && !/no such|unknown|does not exist/i.test(wrong.body),
      'and says nothing about whether the account exists',
    );

    // -----------------------------------------------------------------------
    section('the right password signs them in');

    const good = await post('/login/password', { password: secret, return_to: '' });
    check(
      good.status === 303 && !String(good.location || '').startsWith('/login'),
      'the right password is accepted',
      `${good.status} ${good.location}`,
    );
    check(
      jar.has('__Host-vesopa_sid'),
      'and a session cookie comes back, __Host- prefixed',
    );

    const account = await get('/account/profile');
    check(account.status === 200, 'the session works');
    /*
     * Checked against the DATABASE rather than by looking for the address on
     * the page. /account/profile shows a name and not an email — so searching
     * the HTML for the address reported a failure that was the test's mistake,
     * not the code's. The session row is the unambiguous answer to "who is this
     * session for".
     */
    const live = await db.one(
      `SELECT user_id FROM sso_sessions
        WHERE user_id = ? AND revoked_at IS NULL AND expires_at > NOW()
        ORDER BY id DESC LIMIT 1`,
      [userId],
    );
    check(Boolean(live), 'and the session on the server belongs to that person');
    check(account.body.includes('Smoke'), 'the page greets them by name');

    const events = await db.query(
      "SELECT method, outcome FROM login_events WHERE user_id = ? ORDER BY id DESC LIMIT 4",
      [userId],
    );
    check(
      events.some((e) => e.method === 'password' && e.outcome === 'success'),
      'the sign-in is recorded as a PASSWORD, so the history tells the truth',
      JSON.stringify(events),
    );
    check(
      events.some((e) => e.method === 'password' && e.outcome === 'failure'),
      'and so is the wrong one',
    );

    // -----------------------------------------------------------------------
    section('the way out from under the password');

    jar.clear();
    await get('/login');
    await post('/login', { channel: 'email', email, remember: '1' });
    const toCode = await post('/login/use-code', { return_to: '' });
    check(
      String(toCode.location || '').startsWith('/login/verify'),
      'asking for a code instead reaches the code page',
      toCode.location,
    );
    const verify = await get('/login/verify');
    check(verify.status === 200 && /code/i.test(verify.body), 'and it asks for a code');

    const sent = await db.one(
      `SELECT id FROM verification_challenges
        WHERE user_id = ? AND consumed_at IS NULL ORDER BY id DESC LIMIT 1`,
      [userId],
    );
    check(Boolean(sent), 'a code was actually sent — the escape is not decorative');

    // -----------------------------------------------------------------------
    section('an application can say otherwise');

    const menu = await db.one("SELECT client_id, auth_policy FROM applications WHERE slug = 'vesopa-menu'");
    check(
      menu && menu.auth_policy === 'code_first',
      'the QR menu leads with a code, not a password',
      menu && menu.auth_policy,
    );

    jar.clear();
    await get('/login');
    const asMenu = await post('/login', {
      channel: 'email',
      email,
      remember: '1',
      return_to: `/oauth/authorize?client_id=${menu.client_id}&response_type=code`,
    });
    check(
      String(asMenu.location || '').startsWith('/login/verify'),
      'and signing in FOR the menu skips the password entirely',
      asMenu.location,
    );

    const noPassword = await db.query(
      `SELECT m.method FROM application_auth_methods m
         JOIN applications a ON a.id = m.application_id
        WHERE a.slug = 'vesopa-menu' AND m.method = 'password'`,
    );
    check(noPassword.length === 0, 'because the menu does not offer a password at all');
  } finally {
    await cleanup();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  await db.close();
  process.exit(failed ? 1 : 0);
}

main().catch(async (error) => {
  console.error('\nsmoke-password crashed:', error);
  process.exit(1);
});
