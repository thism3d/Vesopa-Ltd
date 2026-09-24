/**
 * Drive the whole OpenID Connect flow against the live site and check it.
 *
 *     node scripts/smoke-oidc.js
 *
 * Runs ON THE SERVER, over https://auth.vesopa.com, so nginx, the certificate
 * and the real database are all in the path.
 *
 * It checks the happy path AND the refusals, because on an authorisation server
 * the refusals are the product. A flow that works proves the plumbing; a flow
 * that correctly rejects a tampered `code_verifier` proves the security.
 *
 * The session is created directly in the database rather than by driving the
 * login form — that path already has its own test in smoke-login.sh, and
 * repeating it here would just make this slower and more fragile.
 */

const crypto = require('crypto');
const { createLocalJWKSet, jwtVerify, decodeJwt } = require('jose');

const db = require('../src/db');
const config = require('../src/config');
const { newId, newToken, hashToken } = require('../src/crypto');

const BASE = 'https://auth.vesopa.com';
const REDIRECT = 'http://127.0.0.1:9931/cb';

let passed = 0;
let failed = 0;

function check(label, actual, expected) {
  const ok = String(actual) === String(expected);
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok ? '' : ` — expected '${expected}', got '${actual}'`}`);
  if (ok) passed += 1;
  else failed += 1;
}

function ok(label, condition, detail = '') {
  console.log(`  ${condition ? '✓' : '✗'} ${label}${condition ? '' : ` — ${detail}`}`);
  if (condition) passed += 1;
  else failed += 1;
}

/** A fetch that never follows redirects: the Location header IS the result. */
async function get(path, { cookie = '', headers = {} } = {}) {
  return fetch(`${BASE}${path}`, {
    redirect: 'manual',
    headers: { ...(cookie ? { cookie } : {}), ...headers },
  });
}

async function post(path, body, { headers = {} } = {}) {
  return fetch(`${BASE}${path}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(body).toString(),
  });
}

async function main() {
  // -----------------------------------------------------------------------
  // A first-party test application with a redirect we can actually inspect.
  // -----------------------------------------------------------------------
  const application = await ensureTestApplication();
  const { userId, cookie } = await ensureTestSession();

  console.log('▶ discovery');
  const discovery = await (await get('/.well-known/openid-configuration')).json();
  check('issuer', discovery.issuer, BASE);
  check('only the code flow is offered', discovery.response_types_supported.join(), 'code');
  ok('S256 is the only PKCE method',
    discovery.code_challenge_methods_supported.join() === 'S256',
    JSON.stringify(discovery.code_challenge_methods_supported));
  ok('the implicit and password grants are absent',
    !discovery.grant_types_supported.includes('implicit') &&
    !discovery.grant_types_supported.includes('password'),
    JSON.stringify(discovery.grant_types_supported));

  console.log('▶ jwks');
  const jwks = await (await get('/jwks.json')).json();
  ok('at least one signing key is published', jwks.keys.length >= 1);
  ok('no private material is published',
    jwks.keys.every((key) => !key.d && !key.p && !key.q),
    'a private component was found in the JWKS');

  // -----------------------------------------------------------------------
  console.log('▶ /authorize refusals');

  const verifier = newToken(32);
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const baseQuery = {
    client_id: application.client_id,
    redirect_uri: REDIRECT,
    response_type: 'code',
    scope: 'openid profile email offline_access roles',
    state: 'state-123',
    nonce: 'nonce-123',
    code_challenge: challenge,
    code_challenge_method: 'S256',
  };

  const unknownClient = await get(
    `/oauth/authorize?${new URLSearchParams({ ...baseQuery, client_id: 'nope' })}`,
    { cookie },
  );
  check('unknown client is a page, not a redirect', unknownClient.status, 400);

  const badRedirect = await get(
    `/oauth/authorize?${new URLSearchParams({ ...baseQuery, redirect_uri: 'https://evil.example/cb' })}`,
    { cookie },
  );
  check('unregistered redirect_uri is refused', badRedirect.status, 400);
  ok('and is NOT redirected to',
    !(badRedirect.headers.get('location') || '').includes('evil.example'),
    'the server offered to redirect to an unregistered address');

  const noPkce = await get(
    `/oauth/authorize?${new URLSearchParams({
      ...baseQuery, code_challenge: '', code_challenge_method: '',
    })}`,
    { cookie },
  );
  const noPkceLocation = new URL(noPkce.headers.get('location'));
  check('missing PKCE is rejected', noPkceLocation.searchParams.get('error'), 'invalid_request');

  const noSession = await get(`/oauth/authorize?${new URLSearchParams(baseQuery)}`);
  ok('a signed-out visitor is sent to sign in',
    (noSession.headers.get('location') || '').startsWith('/login?return_to='),
    noSession.headers.get('location'));

  // -----------------------------------------------------------------------
  console.log('▶ /authorize happy path');

  /*
   * CONSENT IS ASKED NOW, even of a first-party application.
   *
   * `applications.show_consent` defaults to on, which is what the owner asked
   * for — so /authorize answers 200 with the consent screen the first time
   * rather than redirecting. This test predates that and read `location` from
   * a page that no longer has one, which is why it failed with
   * `TypeError: Invalid URL, input: 'null'` rather than with anything about
   * consent.
   *
   * Answering it is the honest fix: the flow being tested is the one a person
   * actually walks through, and skipping the screen would mean the test no
   * longer covers what ships.
   */
  /*
   * Consent is asked ONCE and then remembered, so asserting that the screen
   * appears is only true on a database that has not seen this pair before —
   * the check passed on the first run and failed on the second. Clearing the
   * grant first makes it deterministic, and clearing it is also what somebody
   * revoking the application from their account page does.
   */
  await db.execute(
    `UPDATE oauth_consents SET revoked_at = NOW()
      WHERE user_id = ? AND application_id = ? AND revoked_at IS NULL`,
    [userId, application.id],
  );

  const answered = await authorizeAnswering(baseQuery, cookie);
  ok('the consent screen is shown, even to a first-party application', answered.consented);
  const authorize = answered.response;

  /*
   * A missing Location here used to crash with `TypeError: Invalid URL,
   * input: 'null'`, which says nothing about what actually happened. It is
   * always one of two things — a consent screen that was not answered, or a
   * refusal — and both are in the body.
   */
  if (!authorize.headers.get('location')) {
    const why = (await authorize.text())
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 300);
    console.log(`
  /authorize did not redirect (HTTP ${authorize.status}).`);
    console.log(`  The page said: ${why}
`);
    process.exit(1);
  }

  const location = new URL(authorize.headers.get('location'));
  check('redirected to the registered address', `${location.origin}${location.pathname}`, REDIRECT);
  check('state is echoed back', location.searchParams.get('state'), 'state-123');
  const code = location.searchParams.get('code');
  ok('an authorization code was issued', Boolean(code));

  // -----------------------------------------------------------------------
  console.log('▶ /token refusals');

  const wrongVerifier = await post('/oauth/token', {
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT,
    code_verifier: newToken(32),
    client_id: application.client_id,
  });
  check('a wrong code_verifier is refused', wrongVerifier.status, 400);
  check('and says why', (await wrongVerifier.json()).error, 'invalid_grant');

  const wrongRedirect = await post('/oauth/token', {
    grant_type: 'authorization_code',
    code,
    redirect_uri: 'http://127.0.0.1:9931/somewhere-else',
    code_verifier: verifier,
    client_id: application.client_id,
  });
  check('a changed redirect_uri is refused', wrongRedirect.status, 400);

  // -----------------------------------------------------------------------
  console.log('▶ /token happy path');

  const exchange = await post('/oauth/token', {
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT,
    code_verifier: verifier,
    client_id: application.client_id,
  });
  check('token exchange succeeds', exchange.status, 200);
  const tokenSet = await exchange.json();
  ok('an access token came back', Boolean(tokenSet.access_token));
  ok('an id token came back', Boolean(tokenSet.id_token));
  ok('a refresh token came back (offline_access was asked for)', Boolean(tokenSet.refresh_token));
  check('token type', tokenSet.token_type, 'Bearer');

  console.log('▶ the tokens themselves');
  const keySet = createLocalJWKSet(jwks);
  const { payload: idClaims, protectedHeader } = await jwtVerify(tokenSet.id_token, keySet, {
    issuer: BASE,
    audience: application.client_id,
  });
  ok('the id token verifies against the published JWKS', true);
  check('nonce is echoed', idClaims.nonce, 'nonce-123');
  check('signed with RS256', protectedHeader.alg, 'RS256');
  ok('a kid names which key', Boolean(protectedHeader.kid));
  ok('auth_time is present', Boolean(idClaims.auth_time));
  ok('amr says how they proved it', Array.isArray(idClaims.amr), JSON.stringify(idClaims.amr));
  ok('email claim present for the email scope', Boolean(idClaims.email), JSON.stringify(idClaims));

  const accessClaims = decodeJwt(tokenSet.access_token);
  check('access token audience is the client', accessClaims.aud, application.client_id);
  ok('roles claim present for the roles scope',
    Array.isArray(accessClaims.roles),
    JSON.stringify(accessClaims.roles));

  /*
   * Code replay gets its own code AND ITS OWN SESSION.
   *
   * Replaying a code revokes everything descended from it, scoped to the
   * session that code belonged to — which is the point of the check. Run in the
   * shared session it would kill the tokens the refresh tests below depend on,
   * and those tests would then fail for a real reason at the wrong moment. That
   * is not hypothetical: it is exactly what happened on the first run, and it
   * read as broken refresh rotation rather than a test revoking its own
   * credentials. A separate session makes the order stop mattering.
   */
  console.log('▶ code replay');
  const isolated = await ensureTestSession();
  const replayable = await freshAuthorizationCode(application, isolated.cookie);
  await post('/oauth/token', {
    grant_type: 'authorization_code',
    code: replayable.code,
    redirect_uri: REDIRECT,
    code_verifier: replayable.verifier,
    client_id: application.client_id,
  });
  const replay = await post('/oauth/token', {
    grant_type: 'authorization_code',
    code: replayable.code,
    redirect_uri: REDIRECT,
    code_verifier: replayable.verifier,
    client_id: application.client_id,
  });
  check('a used code is refused', replay.status, 400);

  // -----------------------------------------------------------------------
  console.log('▶ /userinfo');
  const userinfo = await get('/oauth/userinfo', {
    headers: { authorization: `Bearer ${tokenSet.access_token}` },
  });
  check('userinfo answers', userinfo.status, 200);
  const profile = await userinfo.json();
  check('and describes the same subject', profile.sub, idClaims.sub);

  const badToken = await get('/oauth/userinfo', {
    headers: { authorization: 'Bearer not-a-token' },
  });
  check('a rubbish token is refused', badToken.status, 401);

  // -----------------------------------------------------------------------
  console.log('▶ refresh rotation and reuse detection');

  const refreshed = await post('/oauth/token', {
    grant_type: 'refresh_token',
    refresh_token: tokenSet.refresh_token,
    client_id: application.client_id,
  });
  check('refresh succeeds', refreshed.status, 200);
  const rotated = await refreshed.json();
  ok('a NEW refresh token came back', rotated.refresh_token !== tokenSet.refresh_token);

  /*
   * Present the spent token again from a different address, so it cannot be
   * mistaken for the honest client's retry. This must revoke the whole family.
   */
  await db.execute(
    "UPDATE oauth_refresh_tokens SET ip = '203.0.113.9' WHERE token_hash = ?",
    [hashToken(tokenSet.refresh_token)],
  );
  const reuse = await post('/oauth/token', {
    grant_type: 'refresh_token',
    refresh_token: tokenSet.refresh_token,
    client_id: application.client_id,
  });
  check('a reused refresh token is refused', reuse.status, 400);

  const survivor = await post('/oauth/token', {
    grant_type: 'refresh_token',
    refresh_token: rotated.refresh_token,
    client_id: application.client_id,
  });
  check('and the whole family is dead, including the good token', survivor.status, 400);

  // -----------------------------------------------------------------------
  console.log('▶ revocation');
  const freshCode = await freshAuthorizationCode(application, cookie);
  const freshTokens = await (await post('/oauth/token', {
    grant_type: 'authorization_code',
    code: freshCode.code,
    redirect_uri: REDIRECT,
    code_verifier: freshCode.verifier,
    client_id: application.client_id,
  })).json();

  await post('/oauth/revoke', {
    token: freshTokens.refresh_token,
    client_id: application.client_id,
  });
  const afterRevoke = await post('/oauth/token', {
    grant_type: 'refresh_token',
    refresh_token: freshTokens.refresh_token,
    client_id: application.client_id,
  });
  check('a revoked token cannot be refreshed', afterRevoke.status, 400);

  console.log(`\n${passed} passed, ${failed} failed`);
  await db.close();
  process.exit(failed === 0 ? 0 : 1);
}

/**
 * Start an authorisation and answer the consent screen if one appears.
 *
 * `applications.show_consent` defaults to on now — the owner asked for consent
 * on every authorisation, first-party included — so /authorize answers 200 with
 * a form the first time rather than redirecting. Every caller here needs the
 * same two steps, and having them in one place is what stopped the second
 * caller being forgotten (it was, and it failed with `Invalid URL: null` three
 * hundred lines from the cause).
 */
async function authorizeAnswering(query, cookie) {
  let response = await get(`/oauth/authorize?${new URLSearchParams(query)}`, { cookie });
  if (response.status !== 200) return { response, consented: false };

  const html = await response.text();
  /*
   * NO ESCAPED BACKSLASHES ANYWHERE IN THIS PATTERN.
   *
   * Three attempts at this were wrong in three different ways: inside a
   * template literal `\s` is not an escape JavaScript knows and collapses to
   * a bare `s`; inside a single-quoted string it does the same; and writing
   * the class out longhand invited whatever generated the file to turn the
   * escapes into real control characters. Each time the pattern matched
   * nothing, the CSRF field came back empty, and the POST was refused 403 —
   * a failure that looks like a cookie problem and is a quoting one.
   *
   * So: find the attribute by text, then use a regex LITERAL, which no amount
   * of string quoting can damage.
   */
  const field = (name) => {
    const marker = 'name="' + name + '"';
    const at = html.indexOf(marker);
    if (at < 0) return '';
    const after = html.slice(at + marker.length, at + marker.length + 400);
    const found = after.match(/value="([^"]*)"/);
    return found ? found[1] : '';
  };

  // The CSRF cookie arrives with the consent PAGE and the hidden field has to
  // match it; sending one without the other is refused, which is the protection
  // working.
  const issued = (response.headers.getSetCookie ? response.headers.getSetCookie() : [])
    .map((line) => line.split(';')[0])
    .join('; ');

  response = await post(
    '/oauth/consent',
    {
      _csrf: field('_csrf'),
      client_id: field('client_id'),
      redirect_uri: field('redirect_uri'),
      scope: field('scope'),
      state: field('state'),
      nonce: field('nonce'),
      code_challenge: field('code_challenge'),
      decision: 'allow',
    },
    { headers: { cookie: issued ? `${cookie}; ${issued}` : cookie } },
  );
  return { response, consented: true };
}

async function freshAuthorizationCode(application, cookie) {
  const verifier = newToken(32);
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const { response } = await authorizeAnswering(
    {
      client_id: application.client_id,
      redirect_uri: REDIRECT,
      response_type: 'code',
      scope: 'openid offline_access',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    },
    cookie,
  );
  const url = new URL(response.headers.get('location'));
  return { code: url.searchParams.get('code'), verifier };
}

/**
 * A first-party application whose redirect we can read.
 *
 * First-party so the consent screen is skipped: consent has its own test, and
 * automating a click-through here would only prove that this script can post a
 * form.
 */
async function ensureTestApplication() {
  let application = await db.one("SELECT * FROM applications WHERE slug = 'smoke-test'");
  if (!application) {
    const organisation = await db.one("SELECT * FROM organisations WHERE slug = 'vesopa'");
    const result = await db.execute(
      `INSERT INTO applications
         (organisation_id, client_id, name, slug, description, client_type,
          is_first_party, allow_self_enroll, subject_type, sector_salt)
       VALUES (?, ?, 'Smoke Test', 'smoke-test', 'Automated end-to-end checks.',
               'spa', 1, 1, 'public', ?)`,
      [organisation.id, crypto.randomBytes(16).toString('hex'), crypto.randomBytes(16).toString('hex')],
    );
    application = await db.one('SELECT * FROM applications WHERE id = ?', [result.insertId]);

    for (const grant of ['authorization_code', 'refresh_token']) {
      await db.execute(
        'INSERT IGNORE INTO application_grants (application_id, grant_type) VALUES (?, ?)',
        [application.id, grant],
      );
    }
    for (const scope of ['openid', 'profile', 'email', 'offline_access', 'roles']) {
      await db.execute(
        `INSERT IGNORE INTO application_scopes (application_id, scope_id)
         SELECT ?, id FROM scopes WHERE name = ?`,
        [application.id, scope],
      );
    }
    await db.execute(
      `INSERT IGNORE INTO application_redirect_uris (application_id, uri, kind)
       VALUES (?, ?, 'login')`,
      [application.id, REDIRECT],
    );
    await db.execute(
      `INSERT INTO application_roles (application_id, role_key, name, is_default)
       VALUES (?, 'tester', 'Tester', 1)
       ON DUPLICATE KEY UPDATE name = 'Tester'`,
      [application.id],
    );
  }
  return application;
}

/** A signed-in person to run the flow as. */
async function ensureTestSession() {
  let user = await db.one(
    `SELECT u.* FROM users u
       JOIN user_identities i ON i.user_id = u.id
      WHERE i.identifier_norm = 'smoke@vesopa.com' AND i.revoked_at IS NULL`,
  );

  if (!user) {
    const result = await db.execute(
      `INSERT INTO users (public_id, display_name, webauthn_handle)
       VALUES (?, 'Smoke Test', ?)`,
      [newId(), crypto.randomBytes(32)],
    );
    await db.execute(
      `INSERT INTO user_identities (user_id, type, identifier, identifier_norm, verified_at, verified_via)
       VALUES (?, 'email', 'smoke@vesopa.com', 'smoke@vesopa.com', NOW(), 'seed')`,
      [result.insertId],
    );
    user = await db.one('SELECT * FROM users WHERE id = ?', [result.insertId]);
  }

  const token = newToken(32);
  await db.execute(
    `INSERT INTO sso_sessions
       (public_id, user_id, token_hash, amr, acr, ip, idle_expires_at, expires_at)
     VALUES (?, ?, ?, '["otp"]', 'aal1', '127.0.0.1',
             DATE_ADD(NOW(), INTERVAL 1 HOUR), DATE_ADD(NOW(), INTERVAL 1 HOUR))`,
    [newId(), user.id, hashToken(token)],
  );

  const name = config.isProduction ? '__Host-vesopa_sid' : 'vesopa_sid';
  return { userId: user.id, cookie: `${name}=${token}` };
}

main().catch(async (error) => {
  console.error('smoke test failed:', error);
  try {
    await db.close();
  } catch {
    /* already closed */
  }
  process.exit(1);
});
