/**
 * The hosting panel signs a customer in with a Vesopa account.
 *
 *     node scripts/smoke-panel-sso.js
 *
 * Runs on the auth server, which is also the machine cloud.vesopa.com runs on —
 * but they share nothing else, so the panel is still driven over HTTPS exactly
 * as a browser would, one hop at a time.
 *
 * The account is `developer@vesopa.com`, which is a developer's own. Customer 3
 * is the owner and customer 6 is a real client; neither is touched.
 */

const crypto = require('crypto');

const db = require('../src/db');
const { authorizeAnsweringConsent, clearConsent } = require('./lib/consent');
const { newId, newToken, hashToken } = require('../src/crypto');

const PANEL = 'https://cloud.vesopa.com';
const ADDRESS = 'developer@vesopa.com';

let passed = 0;
let failed = 0;

function check(label, condition, detail = '') {
  console.log(`  ${condition ? '✓' : '✗'} ${label}${condition ? '' : ` — ${detail}`}`);
  if (condition) passed += 1;
  else failed += 1;
}

async function main() {
  console.log('▶ a Vesopa account for the test customer');

  let user = await db.one(
    `SELECT u.* FROM users u
       JOIN user_identities i ON i.user_id = u.id
      WHERE i.type = 'email' AND i.identifier_norm = ? AND i.revoked_at IS NULL`,
    [ADDRESS],
  );
  if (!user) {
    const inserted = await db.execute(
      "INSERT INTO users (public_id, display_name, webauthn_handle) VALUES (?, 'Vesopa Developer', ?)",
      [newId(), crypto.randomBytes(32)],
    );
    await db.execute(
      `INSERT INTO user_identities (user_id, type, identifier, identifier_norm, verified_at, verified_via)
       VALUES (?, 'email', ?, ?, NOW(), 'seed')`,
      [inserted.insertId, ADDRESS, ADDRESS],
    );
    user = await db.one('SELECT * FROM users WHERE id = ?', [inserted.insertId]);
    console.log('    created');
  }
  check('the account exists', Boolean(user));

  const application = await db.one("SELECT * FROM applications WHERE slug = 'vesopa-cloud'");
  check('the panel is registered', Boolean(application));
  check(
    'and does not allow self-enrolment',
    application && Number(application.allow_self_enroll) === 0,
    'a hosting panel must not enrol whoever turns up — a customer row is a billing relationship',
  );

  const registered = await db.query(
    "SELECT uri FROM application_redirect_uris WHERE application_id = ? AND kind = 'login'",
    [application.id],
  );
  check(
    'the callback is registered',
    registered.some((r) => r.uri === `${PANEL}/auth/vesopa/callback`),
    registered.map((r) => r.uri).join(', '),
  );

  await db.execute(
    `INSERT INTO application_members (application_id, user_id, status)
     VALUES (?, ?, 'active') ON DUPLICATE KEY UPDATE status = 'active'`,
    [application.id, user.id],
  );

  const token = newToken(32);
  await db.execute(
    `INSERT INTO sso_sessions (public_id, user_id, token_hash, amr, acr, ip, idle_expires_at, expires_at)
     VALUES (?, ?, ?, '["otp"]', 'aal1', '127.0.0.1',
             DATE_ADD(NOW(), INTERVAL 1 HOUR), DATE_ADD(NOW(), INTERVAL 1 HOUR))`,
    [newId(), user.id, hashToken(token)],
  );
  const cookie = `__Host-vesopa_sid=${token}`;

  // ---------------------------------------------------------------------
  console.log('▶ the round trip');

  const options = await (await fetch(`${PANEL}/auth/vesopa/enabled`)).json();
  check('the panel says the option is on', options.enabled === true);

  const start = await fetch(`${PANEL}/auth/vesopa/start`, { redirect: 'manual' });
  check('it starts the flow', start.status === 303, `status ${start.status}`);

  const authorizeUrl = start.headers.get('location') || '';
  const sent = new URL(authorizeUrl);
  check('sending us to auth.vesopa.com', sent.origin === 'https://auth.vesopa.com');
  check('with PKCE', sent.searchParams.get('code_challenge_method') === 'S256');
  check('and a nonce', Boolean(sent.searchParams.get('nonce')));

  /*
   * Consent is asked now, first-party included, so /authorize may answer with a
   * form rather than a redirect. The shared helper answers it exactly as a
   * browser would — see scripts/lib/consent.js for the two details that make it
   * work, both of which were got wrong separately in three other tests.
   */
  await clearConsent(db, user.id, application.id);
  const { response: authorized } = await authorizeAnsweringConsent(authorizeUrl, cookie);
  const back = authorized.headers.get('location') || '';
  check(
    'and back with a code',
    back.startsWith(`${PANEL}/auth/vesopa/callback`) && back.includes('code='),
    `${authorized.status} ${back.slice(0, 120)}`,
  );

  const callback = await fetch(back, { redirect: 'manual' });
  check(
    'the callback signs them in',
    callback.status === 302 || callback.status === 303,
    `status ${callback.status}`,
  );

  /*
   * `vh_session` — the panel's own cookie, by its own name.
   *
   * The first version of this check looked for the word "customer" and failed
   * on a working sign-in, because the cookie is called `vh_session`. Guessing
   * at another product's cookie name is exactly the sort of assumption a test
   * should not be built on; it is read from `src/auth.js`.
   */
  const cookies = callback.headers.getSetCookie ? callback.headers.getSetCookie() : [];
  const sessionCookie = cookies.find((line) => line.startsWith('vh_session='));
  check(
    'and issues the panel’s OWN session cookie',
    Boolean(sessionCookie),
    cookies.join(' ').slice(0, 140) || 'no cookie was set',
  );
  if (sessionCookie) {
    check('which is HttpOnly', /HttpOnly/i.test(sessionCookie));
    check('and Secure', /Secure/i.test(sessionCookie));
  }
  check(
    'landing in the panel',
    (callback.headers.get('location') || '').includes('/panel'),
    callback.headers.get('location') || '',
  );

  console.log('▶ refusals');
  const replay = await fetch(back, { redirect: 'manual' });
  check('the callback cannot be replayed', replay.status >= 400, `status ${replay.status}`);

  const madeUp = await fetch(`${PANEL}/auth/vesopa/callback?state=nope&code=x`, { redirect: 'manual' });
  check('an invented state is refused', madeUp.status >= 400, `status ${madeUp.status}`);

  console.log(`\n${passed} passed, ${failed} failed`);
  console.log('\nThe link lives in the hosting database; check it with:');
  console.log("  SELECT id, email, vesopa_sub FROM customers WHERE vesopa_sub IS NOT NULL;");

  await db.close();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error('panel SSO smoke test failed:', error);
  try {
    await db.close();
  } catch {
    /* already closed */
  }
  process.exit(1);
});
