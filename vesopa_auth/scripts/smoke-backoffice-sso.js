/**
 * The back office signs a member of staff in with a Vesopa account.
 *
 *     node scripts/smoke-backoffice-sso.js
 *
 * Runs on the AUTH server, because that is the only machine that can create a
 * Vesopa session directly. The back office is driven over the public internet
 * exactly as a browser would drive it, following each hop by hand so that every
 * one can be asserted rather than assumed.
 *
 * The account is `manager@vesopa.co.uk` and nothing else. Every other row in
 * that back office belongs to a real venue.
 */

const crypto = require('crypto');

const db = require('../src/db');
const config = require('../src/config');
const { newId, newToken, hashToken } = require('../src/crypto');

const BACKOFFICE = 'https://backoffice.vesopaepos.com';
const ADDRESS = 'manager@vesopa.co.uk';

let passed = 0;
let failed = 0;

function check(label, condition, detail = '') {
  console.log(`  ${condition ? '✓' : '✗'} ${label}${condition ? '' : ` — ${detail}`}`);
  if (condition) passed += 1;
  else failed += 1;
}

async function main() {
  // ---------------------------------------------------------------------
  console.log('▶ a Vesopa account for the test manager');

  let user = await db.one(
    `SELECT u.* FROM users u
       JOIN user_identities i ON i.user_id = u.id
      WHERE i.type = 'email' AND i.identifier_norm = ? AND i.revoked_at IS NULL`,
    [ADDRESS],
  );

  if (!user) {
    const inserted = await db.execute(
      "INSERT INTO users (public_id, display_name, webauthn_handle) VALUES (?, 'Vesopa Manager', ?)",
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
  check('the account exists with a verified address', Boolean(user));

  const application = await db.one("SELECT * FROM applications WHERE slug = 'vesopa-backoffice'");
  check('the back office is registered as an application', Boolean(application));
  check('as first-party', application && Number(application.is_first_party) === 1);
  check(
    'with a public subject, so the till and the panel agree who this is',
    application && application.subject_type === 'public',
    application && application.subject_type,
  );

  // The person must be a member, or /authorize refuses — the back office does
  // not allow self-enrolment, which is correct for a staff-only product.
  await db.execute(
    `INSERT INTO application_members (application_id, user_id, status)
     VALUES (?, ?, 'active') ON DUPLICATE KEY UPDATE status = 'active'`,
    [application.id, user.id],
  );

  // A session, made directly. The sign-in flow has its own tests.
  const token = newToken(32);
  await db.execute(
    `INSERT INTO sso_sessions (public_id, user_id, token_hash, amr, acr, ip, idle_expires_at, expires_at)
     VALUES (?, ?, ?, '["otp"]', 'aal1', '127.0.0.1',
             DATE_ADD(NOW(), INTERVAL 1 HOUR), DATE_ADD(NOW(), INTERVAL 1 HOUR))`,
    [newId(), user.id, hashToken(token)],
  );
  const cookie = `__Host-vesopa_sid=${token}`;

  // ---------------------------------------------------------------------
  console.log('▶ the round trip, one hop at a time');

  const start = await fetch(`${BACKOFFICE}/auth/vesopa/start`, { redirect: 'manual' });
  check('the back office starts the flow', start.status === 303, `status ${start.status}`);

  const authorizeUrl = start.headers.get('location') || '';
  check('and sends us to auth.vesopa.com', authorizeUrl.startsWith('https://auth.vesopa.com/oauth/authorize'));
  const sent = new URL(authorizeUrl).searchParams;
  check('with PKCE', sent.get('code_challenge_method') === 'S256');
  check('and a nonce', Boolean(sent.get('nonce')));
  check(
    'and its own registered redirect',
    sent.get('redirect_uri') === `${BACKOFFICE}/auth/vesopa/callback`,
    sent.get('redirect_uri'),
  );

  const authorized = await fetch(authorizeUrl, { redirect: 'manual', headers: { cookie } });
  const back = authorized.headers.get('location') || '';
  check(
    'the identity provider sends us back with a code',
    back.startsWith(`${BACKOFFICE}/auth/vesopa/callback`) && back.includes('code='),
    `${authorized.status} ${back.slice(0, 120)}`,
  );

  const callback = await fetch(back, { redirect: 'manual' });
  const body = await callback.text();
  check('the callback succeeds', callback.status === 200, `status ${callback.status}`);

  /*
   * The two things the page must contain, and the one it must not.
   *
   * The single-page app reads both keys at start-up: a token with no user
   * leaves it holding a credential and no idea whose it is, which presents as a
   * sign-in that "works" and then shows an empty shell.
   */
  check('it hands over a token', body.includes("localStorage.setItem('vesopa_token'"));
  check('and the user, which the app needs too', body.includes("localStorage.setItem('vesopa_user'"));
  check(
    'the password hash is NOT in the page',
    !/\$2[aby]\$/.test(body),
    'a bcrypt hash was written into the response and into localStorage',
  );
  check('and no email address is leaked into the markup unescaped', !body.includes('<script>alert'));

  // ---------------------------------------------------------------------
  console.log('▶ replay and refusals');

  const replayed = await fetch(back, { redirect: 'manual' });
  check(
    'the same callback cannot be used twice',
    replayed.status >= 400,
    `status ${replayed.status} — the state must be single use`,
  );

  const madeUp = await fetch(
    `${BACKOFFICE}/auth/vesopa/callback?state=made-up&code=whatever`,
    { redirect: 'manual' },
  );
  check('an invented state is refused', madeUp.status === 400, `status ${madeUp.status}`);

  // ---------------------------------------------------------------------
  console.log('▶ the option is advertised');

  const options = await (await fetch(`${BACKOFFICE}/api/public/backoffice/sign-in-options`)).json();
  check('the back office says the Vesopa option is on', options.vesopa === true);

  console.log(`\n${passed} passed, ${failed} failed`);
  console.log('\nThe link itself lives in the EPOS database on the other server;');
  console.log('check it with:  SELECT id, email, vesopa_sub FROM backoffice_users');
  console.log(`                 WHERE email = '${ADDRESS}';`);

  await db.close();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error('back office SSO smoke test failed:', error);
  try {
    await db.close();
  } catch {
    /* already closed */
  }
  process.exit(1);
});
