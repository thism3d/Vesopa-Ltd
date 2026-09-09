/**
 * A till commissions itself with a Vesopa account.
 *
 *     node scripts/smoke-till-sso.js
 *
 * Runs on the AUTH server, because that is the only machine that can create a
 * Vesopa session directly. Everything else happens over the public internet —
 * and unlike the other three migrations there is no server driving the flow at
 * the far end. The TILL drives it, so this test IS the till: it does the code
 * exchange itself, with PKCE, with no client secret, exactly as the Dart client
 * in `vesopa_epos/lib/data/vesopa_sso.dart` does.
 *
 * That is the point of testing it this way. A public client is the one shape
 * where getting it wrong is silent — a secret leaks into an app that ships to
 * venues, or PKCE is accepted but not enforced, and everything still works.
 *
 * The account is `manager@vesopa.co.uk` and nothing else. Every other row in
 * that back office belongs to a real venue.
 */

const crypto = require('crypto');

const db = require('../src/db');
const { newId, newToken, hashToken } = require('../src/crypto');

const AUTH = 'https://auth.vesopa.com';
const BACKOFFICE = 'https://backoffice.vesopaepos.com';
const ADDRESS = 'manager@vesopa.co.uk';

let passed = 0;
let failed = 0;

function check(label, condition, detail = '') {
  console.log(`  ${condition ? '✓' : '✗'} ${label}${condition ? '' : ` — ${detail}`}`);
  if (condition) passed += 1;
  else failed += 1;
}

const b64url = (buffer) => buffer.toString('base64url');

/** A PKCE pair, made the way the till makes one. */
function pkce() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function claimsOf(jwt) {
  return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
}

async function main() {
  // ---------------------------------------------------------------------
  console.log('▶ the till is registered as a public client');

  const application = await db.one("SELECT * FROM applications WHERE slug = 'vesopa-epos'");
  check('the EPOS application exists', Boolean(application));
  check(
    'as a NATIVE client, so it is public',
    application && application.client_type === 'native',
    application && application.client_type,
  );
  check('and first-party', application && Number(application.is_first_party) === 1);
  check(
    'with a public subject, so the till and the back office agree who this is',
    application && application.subject_type === 'public',
    application && application.subject_type,
  );
  check(
    'and no self-enrolment — a till is staff equipment',
    application && Number(application.allow_self_enroll) === 0,
  );

  const secrets = await db.query(
    'SELECT id FROM application_secrets WHERE application_id = ? AND revoked_at IS NULL',
    [application.id],
  );
  check(
    'it has NO live client secret',
    secrets.length === 0,
    `${secrets.length} secret(s) — a secret compiled into an app that ships to venues is not a secret`,
  );

  const registered = await db.query(
    "SELECT uri FROM application_redirect_uris WHERE application_id = ? AND kind = 'login'",
    [application.id],
  );
  check(
    'a loopback redirect is registered',
    registered.some((r) => r.uri.startsWith('http://127.0.0.1')),
    registered.map((r) => r.uri).join(', '),
  );

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

  await db.execute(
    `INSERT INTO application_members (application_id, user_id, status)
     VALUES (?, ?, 'active') ON DUPLICATE KEY UPDATE status = 'active'`,
    [application.id, user.id],
  );

  const sessionToken = newToken(32);
  await db.execute(
    `INSERT INTO sso_sessions (public_id, user_id, token_hash, amr, acr, ip, idle_expires_at, expires_at)
     VALUES (?, ?, ?, '["otp"]', 'aal1', '127.0.0.1',
             DATE_ADD(NOW(), INTERVAL 1 HOUR), DATE_ADD(NOW(), INTERVAL 1 HOUR))`,
    [newId(), user.id, hashToken(sessionToken)],
  );
  const cookie = `__Host-vesopa_sid=${sessionToken}`;

  // ---------------------------------------------------------------------
  console.log('▶ the back office offers the option');

  const offered = await (await fetch(`${BACKOFFICE}/api/terminal/vesopa/enabled`)).json();
  check('it is on', offered.enabled === true, JSON.stringify(offered));
  check('and names the issuer', offered.issuer === AUTH, offered.issuer);
  check(
    'and the till’s own client id',
    offered.clientId === application.client_id,
    `${offered.clientId} vs ${application.client_id}`,
  );

  // ---------------------------------------------------------------------
  console.log('▶ the till runs the flow itself');

  /*
   * A port the operating system would have chosen. Registration ignores the
   * port for loopback (RFC 8252 §7.3), which is the only reason a native app
   * can bind a free one at run time instead of fighting over a fixed one.
   */
  const port = 40000 + Math.floor(Math.random() * 20000);
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const { verifier, challenge } = pkce();
  const state = b64url(crypto.randomBytes(16));
  const nonce = b64url(crypto.randomBytes(16));

  const authorizeUrl =
    `${AUTH}/oauth/authorize?response_type=code` +
    `&client_id=${encodeURIComponent(application.client_id)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=${encodeURIComponent('openid profile email')}` +
    `&state=${state}&nonce=${nonce}` +
    `&code_challenge=${challenge}&code_challenge_method=S256`;

  /*
   * CONSENT IS ASKED NOW, first-party included — `applications.show_consent`
   * defaults to on, which is what the owner asked for. So /authorize may answer
   * 200 with a form rather than a redirect, and the till's browser half has to
   * answer it exactly as a person would.
   *
   * The consent row is cleared first so this is the same on every run: consent
   * is remembered once given, and a test that only passes the first time is a
   * test that fails on the second and teaches everybody to ignore it.
   */
  await db.execute(
    `UPDATE oauth_consents SET revoked_at = NOW()
      WHERE user_id = ? AND application_id = ? AND revoked_at IS NULL`,
    [user.id, application.id],
  );

  let authorized = await fetch(authorizeUrl, { redirect: 'manual', headers: { cookie } });

  if (authorized.status === 200) {
    const html = await authorized.text();
    const field = (name) => {
      const marker = `name="${name}"`;
      const at = html.indexOf(marker);
      if (at < 0) return '';
      const found = html
        .slice(at + marker.length, at + marker.length + 400)
        .match(/value="([^"]*)"/);
      return found ? found[1] : '';
    };
    const issued = (authorized.headers.getSetCookie ? authorized.headers.getSetCookie() : [])
      .map((line) => line.split(';')[0])
      .join('; ');

    authorized = await fetch(`${AUTH}/oauth/consent`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        cookie: issued ? `${cookie}; ${issued}` : cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        _csrf: field('_csrf'),
        client_id: field('client_id'),
        redirect_uri: field('redirect_uri'),
        scope: field('scope'),
        state: field('state'),
        nonce: field('nonce'),
        code_challenge: field('code_challenge'),
        decision: 'allow',
      }).toString(),
    });
  }

  const back = authorized.headers.get('location') || '';
  check(
    'a loopback redirect on an unregistered port is accepted',
    back.startsWith(redirectUri) && back.includes('code='),
    `${authorized.status} ${back.slice(0, 140)}`,
  );

  const returned = new URL(back);
  check('the state comes back unchanged', returned.searchParams.get('state') === state);
  const code = returned.searchParams.get('code');

  // --------------------------------------------------------------- refusals
  console.log('▶ what the token endpoint refuses');

  const form = (fields) => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });

  const noVerifier = await fetch(
    `${AUTH}/oauth/token`,
    form({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: application.client_id,
    }),
  );
  check(
    'the code is useless without the verifier',
    noVerifier.status >= 400,
    `status ${noVerifier.status} — PKCE is the ONLY thing protecting a public client`,
  );

  const wrongVerifier = await fetch(
    `${AUTH}/oauth/token`,
    form({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: application.client_id,
      code_verifier: pkce().verifier,
    }),
  );
  check(
    'and useless with somebody else’s verifier',
    wrongVerifier.status >= 400,
    `status ${wrongVerifier.status}`,
  );

  const withSecret = await fetch(
    `${AUTH}/oauth/token`,
    form({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: application.client_id,
      client_secret: 'anything-at-all',
      code_verifier: verifier,
    }),
  );
  check(
    'a public client sending a secret is refused rather than humoured',
    withSecret.status === 401,
    `status ${withSecret.status} — a developer who thinks they are protected must be told they are not`,
  );

  // ------------------------------------------------------------- the exchange
  console.log('▶ the exchange');

  const exchanged = await fetch(
    `${AUTH}/oauth/token`,
    form({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: application.client_id,
      code_verifier: verifier,
    }),
  );
  const tokens = await exchanged.json();
  check('the right verifier works', exchanged.status === 200, JSON.stringify(tokens).slice(0, 160));
  check('an identity token comes back', Boolean(tokens.id_token));

  const claims = tokens.id_token ? claimsOf(tokens.id_token) : {};
  check('minted for the till', claims.aud === application.client_id, String(claims.aud));
  check('carrying our nonce', claims.nonce === nonce);
  check('and a jti, so it can be spent once', Boolean(claims.jti));
  check(
    'the subject is the person’s own public id',
    claims.sub === user.public_id,
    `${claims.sub} vs ${user.public_id}`,
  );
  check('with a verified email', claims.email_verified === true && claims.email === ADDRESS);

  // ------------------------------------------------------------ commissioning
  console.log('▶ the back office turns it into a terminal');

  const commission = (idToken) =>
    fetch(`${BACKOFFICE}/api/terminal/vesopa/commission`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id_token: idToken }),
    });

  const rubbish = await commission('not.a.token');
  check('rubbish is refused', rubbish.status === 401, `status ${rubbish.status}`);

  /*
   * A token for a DIFFERENT application, which is the attack this guards.
   *
   * Somebody who has a browser session in the back office holds a perfectly
   * valid, correctly signed Vesopa token. If the audience were not checked,
   * that token would commission a till — and a terminal token lasts ten years.
   */
  const backoffice = await db.one("SELECT * FROM applications WHERE slug = 'vesopa-backoffice'");
  const otherPkce = pkce();
  const otherState = b64url(crypto.randomBytes(16));
  const otherRedirect = `${BACKOFFICE}/auth/vesopa/callback`;
  const otherAuthorize =
    `${AUTH}/oauth/authorize?response_type=code` +
    `&client_id=${encodeURIComponent(backoffice.client_id)}` +
    `&redirect_uri=${encodeURIComponent(otherRedirect)}` +
    `&scope=${encodeURIComponent('openid profile email')}` +
    `&state=${otherState}&nonce=${otherState}` +
    `&code_challenge=${otherPkce.challenge}&code_challenge_method=S256`;

  const otherAuthorized = await fetch(otherAuthorize, { redirect: 'manual', headers: { cookie } });
  const otherCode = new URL(otherAuthorized.headers.get('location') || `${BACKOFFICE}/x`)
    .searchParams.get('code');

  if (otherCode) {
    const secretRow = await db.one(
      'SELECT * FROM application_secrets WHERE application_id = ? AND revoked_at IS NULL LIMIT 1',
      [backoffice.id],
    );
    check('the back office has a secret, being confidential', Boolean(secretRow));

    const otherTokens = await (
      await fetch(
        `${AUTH}/oauth/token`,
        form({
          grant_type: 'authorization_code',
          code: otherCode,
          redirect_uri: otherRedirect,
          client_id: backoffice.client_id,
          client_secret: process.env.BACKOFFICE_CLIENT_SECRET || '',
          code_verifier: otherPkce.verifier,
        }),
      )
    ).json();

    if (otherTokens.id_token) {
      const foreign = await commission(otherTokens.id_token);
      check(
        'a valid token for ANOTHER application cannot commission a till',
        foreign.status === 401,
        `status ${foreign.status} — a back-office browser session must not become a ten-year terminal token`,
      );
    } else {
      console.log('    (skipped the cross-audience check: BACKOFFICE_CLIENT_SECRET was not set)');
    }
  }

  const commissioned = await commission(tokens.id_token);
  const body = await commissioned.json();
  check('the real token is accepted', commissioned.status === 200, JSON.stringify(body).slice(0, 200));
  check('a session token comes back', Boolean(body.token));
  check(
    'AND the terminal’s own credential, which is the whole point',
    Boolean(body.terminalToken),
    'without it the till cannot check a PIN offline',
  );
  check('with the user', Boolean(body.user && body.user.email));
  check(
    'scoped to a venue',
    Boolean(body.user && body.user.officeEmail),
    'a till with no office has no catalogue to sell from',
  );
  check(
    'and NO password hash anywhere in the response',
    !/\$2[aby]\$/.test(JSON.stringify(body)),
    'a bcrypt hash reached the till',
  );

  if (body.terminalToken) {
    const terminal = claimsOf(body.terminalToken);
    check('the terminal token is scoped to `terminal`', terminal.scope === 'terminal', terminal.scope);
    check('names the office', Boolean(terminal.office), JSON.stringify(terminal));
    check(
      'and records who commissioned it',
      terminal.commissionedBy === body.user.email,
      terminal.commissionedBy,
    );
  }

  console.log('▶ the same identity token cannot do it twice');
  const again = await commission(tokens.id_token);
  check(
    'a replayed identity token is refused',
    again.status === 401,
    `status ${again.status} — one authorisation, one terminal`,
  );

  // ---------------------------------------------------------------------
  console.log('▶ the link was recorded');
  console.log('  (check on the back office with:');
  console.log('   SELECT id, email, vesopa_sub, vesopa_linked_at FROM backoffice_users');
  console.log('    WHERE vesopa_sub IS NOT NULL;)');

  console.log(`\n${passed} passed, ${failed} failed`);
  await db.close();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error('till SSO smoke test failed:', error);
  try {
    await db.close();
  } catch {
    /* already closed */
  }
  process.exit(1);
});
