/**
 * How a desktop application signs somebody in — end to end, on the live domain.
 *
 *     node scripts/smoke-device-flow.js
 *
 * THE FLOW THE OWNER DESCRIBED, which is the one everybody knows from VS Code:
 * the app opens a browser, the person signs in and consents, the browser lands
 * on a page on auth.vesopa.com saying it worked, the operating system offers to
 * open the app, and the app exchanges the code for tokens. Revoke the link and
 * the app finds itself signed out and asks again.
 *
 * This drives all of it with HTTP, standing in for the app: it starts a real
 * authorisation with PKCE, follows it to the handoff page, reads the code back
 * out of the page's own hand-off link, and spends it at /oauth/token. Then it
 * revokes the grant and proves the refresh token is dead — which is the half
 * that makes "if a user removes the link then apps ask again" true rather than
 * hoped for.
 */

const crypto = require('crypto');
const { execFileSync } = require('child_process');
const path = require('path');

const db = require('../src/db');

const BASE = process.env.SMOKE_BASE || 'https://auth.vesopa.com';
const ADMIN = process.env.SMOKE_ADMIN || 'info@vesopasoftware.com';

let passed = 0;
let failed = 0;
const section = (name) => console.log(`▶ ${name}`);
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

const jar = new Map();
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
function remember(r) {
  for (const line of r.headers.getSetCookie ? r.headers.getSetCookie() : []) {
    const [pair] = line.split(';');
    const at = pair.indexOf('=');
    if (at > 0) jar.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
  }
}
async function get(url) {
  const r = await fetch(url.startsWith('http') ? url : `${BASE}${url}`, {
    headers: { cookie: cookieHeader() },
    redirect: 'manual',
  });
  remember(r);
  return { status: r.status, location: r.headers.get('location'), body: await r.text() };
}
async function post(url, fields) {
  const r = await fetch(`${BASE}${url}`, {
    method: 'POST',
    headers: { cookie: cookieHeader(), 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      _csrf: jar.get('__Host-vesopa_csrf') || jar.get('vesopa_csrf') || '',
      ...fields,
    }).toString(),
    redirect: 'manual',
  });
  remember(r);
  return { status: r.status, location: r.headers.get('location'), body: r.status === 303 ? '' : await r.text() };
}

async function main() {
  console.log(`Desktop sign-in — ${BASE}\n`);

  const app = await db.one(
    `SELECT id, client_id, app_scheme, app_display_name, client_type
       FROM applications WHERE slug = 'vesopa-epos'`,
  );
  if (!app) {
    console.error('no vesopa-epos application; run scripts/seed.js');
    process.exit(1);
  }

  // -------------------------------------------------------------------------
  section('the application is set up for it');

  check(app.client_type === 'native', 'the till is a native client', app.client_type);
  check(Boolean(app.app_scheme), `it has a desktop scheme (${app.app_scheme})`);

  const redirectUri = `${BASE}/device/callback?client_id=${app.client_id}`;
  const registered = await db.one(
    `SELECT id FROM application_redirect_uris
      WHERE application_id = ? AND kind = 'login' AND uri = ?`,
    [app.id, redirectUri],
  );
  check(Boolean(registered), 'and the handoff address is registered, exactly');

  const loopback = await db.query(
    `SELECT uri FROM application_redirect_uris
      WHERE application_id = ? AND kind = 'login' AND uri LIKE 'http://127.0.0.1%'`,
    [app.id],
  );
  check(
    loopback.length > 0,
    'loopback is still registered too — an older build keeps working',
  );

  // -------------------------------------------------------------------------
  section('the browser half');

  // Stand in for the person being signed in already. The app cannot do this;
  // the browser it opened can, because the session cookie is the browser's.
  const token = execFileSync(
    process.execPath,
    [path.join(__dirname, 'console-session.js'), ADMIN],
    { encoding: 'utf8' },
  ).trim().split('\n').pop().trim();
  jar.set('__Host-vesopa_sid', token);
  await get('/login');

  // Exactly what the app would generate.
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const state = crypto.randomBytes(16).toString('base64url');

  const authorize =
    `/oauth/authorize?response_type=code&client_id=${app.client_id}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=${encodeURIComponent('openid profile email offline_access roles')}` +
    `&state=${state}&code_challenge=${challenge}&code_challenge_method=S256`;

  let step = await get(authorize);

  // Consent, if the application asks for it — it does now, by default.
  if (step.status === 200 && /consent/i.test(step.body)) {
    check(true, 'the consent screen is shown, even to a first-party app');
    const scopeMatch = step.body.match(/name="scope"\s+value="([^"]*)"/);
    step = await post('/oauth/consent', {
      client_id: app.client_id,
      redirect_uri: redirectUri,
      state,
      scope: scopeMatch ? scopeMatch[1] : 'openid profile email offline_access roles',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      response_type: 'code',
      decision: 'allow',
    });
  }

  const landed = String(step.location || '');
  check(
    landed.startsWith(`${BASE}/device/callback`),
    'the browser is sent to the handoff page on this domain',
    landed.slice(0, 160),
  );

  const page = await get(landed);
  check(page.status === 200, 'and it renders');
  check(/You&#39;re signed in|You're signed in/.test(page.body), 'saying it worked');
  check(
    page.body.includes(`Open ${app.app_display_name}`),
    'with a button naming the app, for anybody who dismisses the OS dialog',
  );

  /*
   * The hand-off link is the whole point: it is what the operating system is
   * asked to open, and what the app receives.
   */
  /*
   * Read out of the attribute AND unescaped.
   *
   * EJS escapes the value into the href, so `&` is `&amp;` in the source — as
   * it must be, that is correct HTML. A browser decodes it and gets
   * `?code=…&state=…`; a regex that does not gets `?code=…&amp;state=…`, and
   * `URLSearchParams` then reports a parameter called `amp;state`. The page was
   * right and the test was wrong, which is worth a comment because the failure
   * looks exactly like a dropped parameter.
   */
  const raw = (page.body.match(/href="([a-z][a-z0-9+.-]*:\/\/auth\/callback\?[^"]*)"/) || [])[1];
  const handoff = raw && raw.replace(/&amp;/g, '&').replace(/&#39;/g, "'");
  check(Boolean(handoff), 'and a hand-off link to the desktop app');
  check(
    handoff && handoff.startsWith(`${app.app_scheme}://`),
    `which uses the application's own scheme (${app.app_scheme})`,
    handoff,
  );

  const handed = new URLSearchParams((handoff || '').split('?')[1] || '');
  check(handed.get('state') === state, 'carrying the state the app sent');
  const code = handed.get('code');
  check(Boolean(code), 'and the authorisation code');

  // -------------------------------------------------------------------------
  section('the app half');

  const tokenResponse = await fetch(`${BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: code || '',
      redirect_uri: redirectUri,
      client_id: app.client_id,
      code_verifier: verifier,
    }).toString(),
  });
  const tokens = await tokenResponse.json().catch(() => ({}));
  check(
    tokenResponse.status === 200 && tokens.access_token,
    'the app exchanges the code for tokens — with PKCE and NO client secret',
    `${tokenResponse.status} ${JSON.stringify(tokens).slice(0, 140)}`,
  );
  check(Boolean(tokens.refresh_token), 'and gets a refresh token, so it stays signed in');

  /*
   * The reason a public client is safe to hand a code to through a scheme any
   * app could claim: without the verifier the code is worthless.
   */
  const stolen = await fetch(`${BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: code || '',
      redirect_uri: redirectUri,
      client_id: app.client_id,
      code_verifier: crypto.randomBytes(32).toString('base64url'),
    }).toString(),
  });
  check(
    stolen.status !== 200,
    'a code with the WRONG verifier is refused — which is what makes the scheme safe',
    `status ${stolen.status}`,
  );

  // -------------------------------------------------------------------------
  section('taking the link away');

  const consent = await db.one(
    `SELECT id FROM oauth_consents
      WHERE application_id = ? AND revoked_at IS NULL ORDER BY id DESC LIMIT 1`,
    [app.id],
  );

  const revoked = await post(`/account/apps/${consent ? consent.id : 0}/revoke`, {});
  check(
    revoked.status === 303 || revoked.status === 302,
    'the person can revoke it from their account',
    `${revoked.status}`,
  );

  const afterRevoke = await fetch(`${BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token || '',
      client_id: app.client_id,
    }).toString(),
  });
  check(
    afterRevoke.status !== 200,
    'and the app can no longer refresh — so it asks again, which is the behaviour wanted',
    `status ${afterRevoke.status}`,
  );

  /*
   * AND THE ASKING AGAIN HAS TO WORK. This is the half that was broken:
   * revoking also set `application_members.status = 'removed'`, and the till
   * does not allow self-enrolment — so disconnecting it locked the person out
   * permanently and an administrator had to put them back. Found by this test
   * failing on its second run, which is the only way that kind of bug ever
   * shows up.
   */
  const member = await db.one(
    `SELECT m.status FROM application_members m
      JOIN users u ON u.id = m.user_id
      JOIN user_identities i ON i.id = u.primary_email_id
     WHERE m.application_id = ? AND i.identifier = ?`,
    [app.id, ADMIN],
  );
  check(
    member && member.status === 'active',
    'the person is still a user of the application — a disconnect is not a sacking',
    member && member.status,
  );

  const again = await get(authorize);
  check(
    again.status === 200 || String(again.location || '').includes('/device/callback'),
    'and a fresh sign-in can start straight away',
    `${again.status} ${String(again.location || '').slice(0, 120)}`,
  );
  check(
    !String(again.location || '').includes('access_denied'),
    'not refused with access_denied',
    String(again.location || '').slice(0, 160),
  );

  // -------------------------------------------------------------------------
  section('the failures');

  const cancelled = await get(`/device/callback?client_id=${app.client_id}&error=access_denied`);
  check(cancelled.status === 200, 'pressing Deny lands on a page, not an error');
  check(
    /cancelled/i.test(cancelled.body) && /Nothing has changed/i.test(cancelled.body),
    'that says nothing has changed on the account',
  );

  const noScheme = await get('/device/callback?client_id=deadbeefdeadbeefdeadbeefdeadbeef&code=x');
  check(
    /scheme is not set|has not said which app/i.test(noScheme.body),
    'an application with no scheme is told exactly which field is missing',
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  await db.close();
  process.exit(failed ? 1 : 0);
}

main().catch(async (error) => {
  console.error('\nsmoke-device-flow crashed:', error);
  process.exit(1);
});
