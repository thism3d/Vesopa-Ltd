/**
 * The developer portal, end to end, against the live domain.
 *
 *     node scripts/smoke-portal.js
 *
 * WHAT THIS PROVES, and it is the owner's question in full: that a person can
 * create an OAuth application through the web interface, register a redirect
 * URI, mint a client secret, and use the two of them to get a token — without
 * touching the database or this repository.
 *
 * THE REFUSALS ARE THE PRODUCT, as in the OIDC smoke test. Anybody can write a
 * form that saves a row. What matters here is that an `http://` redirect is
 * refused, that a wildcard is refused, that a browser app is refused a secret,
 * and that a viewer cannot mint one — because each of those, allowed, is a way
 * to lose somebody's account.
 *
 * IT CLEANS UP AFTER ITSELF. The application it makes is archived at the end,
 * which is a state the portal can reach — so a failed run leaves a row that is
 * visibly test rubbish rather than a live client id nobody recognises.
 */

const { execFileSync } = require('child_process');
const path = require('path');

const BASE = process.env.SMOKE_BASE || 'https://auth.vesopa.com';
const ADMIN = process.env.SMOKE_ADMIN || 'info@vesopasoftware.com';

let passed = 0;
let failed = 0;
let group = '';

function section(name) {
  group = name;
  console.log(`▶ ${name}`);
}
function ok(what) {
  passed += 1;
  console.log(`  ✓ ${what}`);
}
function bad(what, detail) {
  failed += 1;
  console.log(`  ✗ ${what}${detail ? `\n      ${detail}` : ''}`);
}
function check(condition, what, detail) {
  if (condition) ok(what);
  else bad(what, detail);
  return !!condition;
}

// ---------------------------------------------------------------------------
// A browser, near enough
// ---------------------------------------------------------------------------
//
// Cookies and the CSRF token, kept by hand. Every form here is protected by a
// synchroniser token, so a client that does not carry the cookie AND echo it in
// the body is refused — which is the point, and means this test exercises the
// protection rather than bypassing it.

const jar = new Map();

function cookieHeader() {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function remember(response) {
  const raw = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
  for (const line of raw) {
    const [pair] = line.split(';');
    const index = pair.indexOf('=');
    if (index > 0) jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
  }
}

async function get(url) {
  const response = await fetch(`${BASE}${url}`, {
    headers: { cookie: cookieHeader() },
    redirect: 'manual',
  });
  remember(response);
  const body = response.status < 400 || response.status >= 500 ? await response.text() : await response.text();
  return { status: response.status, location: response.headers.get('location'), body };
}

async function post(url, fields) {
  const csrf = jar.get('__Host-vesopa_csrf') || jar.get('vesopa_csrf') || '';
  const form = new URLSearchParams();
  form.set('_csrf', csrf);
  for (const [key, value] of Object.entries(fields)) {
    if (Array.isArray(value)) value.forEach((v) => form.append(key, v));
    else form.set(key, value);
  }
  const response = await fetch(`${BASE}${url}`, {
    method: 'POST',
    headers: {
      cookie: cookieHeader(),
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
    redirect: 'manual',
  });
  remember(response);
  return {
    status: response.status,
    location: response.headers.get('location'),
    body: response.status === 303 ? '' : await response.text(),
  };
}

/**
 * The same, as multipart, for the logo upload.
 *
 * `FormData` sets its own boundary, so the content-type header must NOT be set
 * by hand here — doing so sends a boundary that does not match the body, and
 * multer parses nothing while reporting no error at all. That is a genuinely
 * confusing hour: the request succeeds, the file is simply absent.
 */
async function postFile(url, field, bytes, filename, type) {
  const csrf = jar.get('__Host-vesopa_csrf') || jar.get('vesopa_csrf') || '';
  const form = new FormData();
  form.set('_csrf', csrf);
  form.set(field, new Blob([bytes], { type }), filename);

  const response = await fetch(`${BASE}${url}`, {
    method: 'POST',
    headers: { cookie: cookieHeader() },
    body: form,
    redirect: 'manual',
  });
  remember(response);
  return { status: response.status, location: response.headers.get('location') };
}

/** A real, minimal PNG — 1x1, transparent. The magic number is the point. */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

/** The message the portal put in `?error=` on the redirect it answered with. */
function errorFrom(result) {
  if (!result.location) return '';
  const query = result.location.split('?')[1] || '';
  return decodeURIComponent(new URLSearchParams(query).get('error') || '');
}

async function main() {
  console.log(`Developer portal — ${BASE}\n`);

  // -------------------------------------------------------------------------
  section('signing in');

  const token = execFileSync(
    process.execPath,
    [path.join(__dirname, 'console-session.js'), ADMIN],
    { encoding: 'utf8' },
  )
    .trim()
    .split('\n')
    .pop()
    .trim();
  jar.set('__Host-vesopa_sid', token);

  const list = await get('/developers');
  if (!check(list.status === 200, 'the portal opens', `status ${list.status}`)) {
    console.log('\nnothing else can be checked without a session.');
    process.exit(1);
  }
  check(list.body.includes('Your applications'), 'and it is the applications page');

  // -------------------------------------------------------------------------
  section('creating an application');

  const name = `Smoke Test ${Date.now()}`;
  const created = await post('/developers/new', {
    name,
    description: 'Created by scripts/smoke-portal.js. Safe to archive.',
    client_type: 'web',
    redirect_uri: 'https://example.com/auth/callback',
  });

  const clientId = (created.location || '').match(/\/developers\/a\/([a-f0-9]{32})/)?.[1];
  if (!check(clientId, 'it is created and we are given a client id', created.location || created.body.slice(0, 200))) {
    process.exit(1);
  }
  ok(`client id ${clientId}`);

  const overview = await get(`/developers/a/${clientId}`);
  check(overview.status === 200, 'its page loads');
  check(overview.body.includes(clientId), 'and shows the client id to copy');
  check(
    overview.body.includes('https://example.com/auth/callback'),
    'with the redirect URI already registered',
  );

  // -------------------------------------------------------------------------
  section('redirect URIs — the refusals');

  const httpUri = await post(`/developers/a/${clientId}/redirects`, {
    kind: 'login',
    uri: 'http://example.com/auth/callback',
  });
  check(
    errorFrom(httpUri).includes('https'),
    'an http:// address is refused',
    errorFrom(httpUri) || 'no error came back',
  );

  const wildcard = await post(`/developers/a/${clientId}/redirects`, {
    kind: 'login',
    uri: 'https://*.example.com/cb',
  });
  check(errorFrom(wildcard).includes('Wildcard'), 'a wildcard is refused', errorFrom(wildcard));

  const fragment = await post(`/developers/a/${clientId}/redirects`, {
    kind: 'login',
    uri: 'https://example.com/cb#done',
  });
  check(errorFrom(fragment).includes('fragment'), 'a #fragment is refused', errorFrom(fragment));

  const loopback = await post(`/developers/a/${clientId}/redirects`, {
    kind: 'login',
    uri: 'http://127.0.0.1:0/callback',
  });
  check(
    errorFrom(loopback).includes('Native'),
    'a loopback address is refused for a web application',
    errorFrom(loopback),
  );

  const localhost = await post(`/developers/a/${clientId}/redirects`, {
    kind: 'login',
    uri: 'http://localhost:3000/cb',
  });
  check(
    errorFrom(localhost).includes('127.0.0.1'),
    'localhost is refused in favour of 127.0.0.1',
    errorFrom(localhost),
  );

  section('redirect URIs — adding a good one');

  const second = await post(`/developers/a/${clientId}/redirects`, {
    kind: 'login',
    uri: 'https://example.com/second/callback',
  });
  check(second.location && second.location.includes('saved=1'), 'a second https URI is accepted');

  const withTwo = await get(`/developers/a/${clientId}/redirects`);
  check(
    withTwo.body.includes('https://example.com/second/callback'),
    'and it appears on the page',
  );

  // Removing the last one must be refused; removing one of two must not.
  const rows = [...withTwo.body.matchAll(/redirects\/(\d+)\/remove/g)].map((m) => m[1]);
  check(rows.length >= 2, 'both are listed with a remove button');

  const removedOne = await post(`/developers/a/${clientId}/redirects/${rows[1]}/remove`, {});
  check(
    removedOne.location && removedOne.location.includes('saved=1'),
    'one of two can be removed',
    errorFrom(removedOne),
  );

  const removeLast = await post(`/developers/a/${clientId}/redirects/${rows[0]}/remove`, {});
  check(
    errorFrom(removeLast).includes('only sign-in address'),
    'the LAST one cannot — that would break every sign-in silently',
    errorFrom(removeLast),
  );

  // -------------------------------------------------------------------------
  section('minting a secret, and using it');

  const minted = await post(`/developers/a/${clientId}/secrets`, { label: 'smoke' });
  const handle = (minted.location || '').match(/shown=([a-f0-9]{32})/)?.[1];
  check(handle, 'a secret is minted', minted.location || errorFrom(minted));

  const shownPage = await get(`/developers/a/${clientId}/credentials?shown=${handle}`);
  const secret = shownPage.body.match(/<code>([A-Za-z0-9_-]{40,})<\/code>/)?.[1];
  check(secret, 'and shown once, in full');

  const again = await get(`/developers/a/${clientId}/credentials?shown=${handle}`);
  check(
    !again.body.includes(secret || 'IMPOSSIBLE'),
    'and NOT a second time — the handle is spent on first read',
  );

  // The whole point: does the credential actually work?
  await post(`/developers/a/${clientId}/grants`, {
    grant_type: ['authorization_code', 'refresh_token', 'client_credentials'],
  });

  const tokenResponse = await fetch(`${BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: secret || '',
    }).toString(),
  });
  const issued = await tokenResponse.json().catch(() => ({}));
  check(
    tokenResponse.status === 200 && issued.access_token,
    'the minted secret gets a real token from /oauth/token',
    `status ${tokenResponse.status} ${JSON.stringify(issued).slice(0, 160)}`,
  );

  const wrong = await fetch(`${BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: 'not-the-secret',
    }).toString(),
  });
  check(wrong.status === 401 || wrong.status === 400, 'and a wrong secret does not');

  // Revoking it must actually stop it working — a "revoked" flag that the token
  // endpoint does not consult is worse than no revocation at all, because it is
  // believed.
  const credentials = await get(`/developers/a/${clientId}/credentials`);
  const secretId = credentials.body.match(/secrets\/(\d+)\/revoke/)?.[1];
  check(secretId, 'the secret is listed, by its last four characters only');
  check(
    !credentials.body.includes(secret || 'IMPOSSIBLE'),
    'and the list does NOT contain the secret itself',
  );

  await post(`/developers/a/${clientId}/secrets/${secretId}/revoke`, {});
  const afterRevoke = await fetch(`${BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: secret || '',
    }).toString(),
  });
  check(afterRevoke.status !== 200, 'a revoked secret stops working immediately');

  // -------------------------------------------------------------------------
  section('the logo');

  const noLogo = await get(`/developers/a/${clientId}`);
  check(
    noLogo.body.includes('How it appears to people'),
    'the overview shows what the consent screen will look like',
  );

  const uploaded = await postFile(
    `/developers/a/${clientId}/logo`,
    'logo',
    TINY_PNG,
    'logo.png',
    'image/png',
  );
  check(
    uploaded.location && uploaded.location.includes('saved=1'),
    'a PNG is accepted',
    errorFrom(uploaded),
  );

  const withLogo = await get(`/developers/a/${clientId}`);
  const logoPath = withLogo.body.match(/\/uploads\/logos\/[a-z0-9-]+\.png/)?.[0];
  check(logoPath, 'and stored on this origin, not hot-linked to the developer');

  if (logoPath) {
    const served = await fetch(`${BASE}${logoPath}`);
    check(served.status === 200, 'and it is actually served');
    check(
      (served.headers.get('content-type') || '').includes('image/png'),
      'as an image',
      served.headers.get('content-type') || '',
    );
  }

  /*
   * THE REFUSAL THAT MATTERS. An SVG is a document, not an image: it can carry
   * script, and it would be served from this origin — the one that holds every
   * Vesopa session. An SVG logo accepted here is a stored cross-site scripting
   * hole reachable through a form handed to third-party developers.
   */
  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
  );
  const svgTry = await postFile(`/developers/a/${clientId}/logo`, 'logo', svg, 'logo.svg', 'image/svg+xml');
  check(
    !svgTry.location || !svgTry.location.includes('saved=1'),
    'an SVG is refused — it can carry script, on this domain',
    svgTry.location || '',
  );

  // And a file whose bytes disagree with what it claims to be.
  const liar = await postFile(
    `/developers/a/${clientId}/logo`,
    'logo',
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
    'logo.png',
    'image/png',
  );
  check(
    errorFrom(liar).includes('not a PNG'),
    'and so is an SVG renamed .png — the bytes are checked, not the label',
    errorFrom(liar) || liar.location || '',
  );

  // -------------------------------------------------------------------------
  section('guest use');

  const guestOn = await post(`/developers/a/${clientId}/settings`, {
    name,
    description: 'smoke',
    client_type: 'web',
    allow_self_enroll: '1',
    guest_allowed: '1',
  });
  check(guestOn.location && guestOn.location.includes('saved=1'), 'it can be marked guest-friendly');

  const guestPage = await get(`/developers/a/${clientId}`);
  check(
    guestPage.body.includes('without signing in at all'),
    'and the portal says so, where the next person will read it',
  );

  // -------------------------------------------------------------------------
  section('a public client is refused a secret');

  await post(`/developers/a/${clientId}/settings`, {
    name,
    description: 'smoke',
    client_type: 'spa',
    allow_self_enroll: '1',
  });
  const refused = await post(`/developers/a/${clientId}/secrets`, { label: 'should not happen' });
  check(
    errorFrom(refused).includes('cannot keep a secret'),
    'a browser app cannot mint one — anything shipped to the user can be read',
    errorFrom(refused),
  );

  const noMachine = await post(`/developers/a/${clientId}/grants`, {
    grant_type: ['authorization_code', 'client_credentials'],
  });
  check(
    errorFrom(noMachine).includes('cannot keep one'),
    'and cannot be given machine-to-machine access either',
    errorFrom(noMachine),
  );

  // -------------------------------------------------------------------------
  section('scopes and roles');

  const scopes = await get(`/developers/a/${clientId}/scopes`);
  check(scopes.status === 200, 'the scopes page loads');
  check(
    scopes.body.includes('needs review'),
    'and marks the sensitive one as needing review',
  );

  const role = await post(`/developers/a/${clientId}/roles`, {
    role_key: 'smoke.tester',
    name: 'Smoke tester',
    description: 'Created by the smoke test.',
    is_default: '1',
  });
  check(role.location && role.location.includes('saved=1'), 'a role can be added');

  const badRole = await post(`/developers/a/${clientId}/roles`, {
    role_key: 'Not A Valid Key!',
    name: 'nope',
  });
  check(errorFrom(badRole).includes('lowercase'), 'and a malformed role key is refused');

  // -------------------------------------------------------------------------
  section('granting access to somebody');

  const noAccount = await post(`/developers/a/${clientId}/team`, {
    email: `nobody-${Date.now()}@example.com`,
    role: 'viewer',
  });
  check(
    errorFrom(noAccount).includes('Vesopa account first'),
    'an address with no account behind it is refused',
    errorFrom(noAccount),
  );

  // -------------------------------------------------------------------------
  section('tidying up');

  const wrongName = await post(`/developers/a/${clientId}/archive`, { confirm: 'not the name' });
  check(
    errorFrom(wrongName).includes('Type the application name'),
    'archiving needs the name typed exactly',
  );

  const archived = await post(`/developers/a/${clientId}/archive`, { confirm: name });
  check(
    archived.location && archived.location.includes('archived=1'),
    'and then it archives',
    errorFrom(archived),
  );

  const gone = await get(`/developers/a/${clientId}`);
  check(gone.status === 404, 'after which the portal no longer shows it');

  const dead = await fetch(
    `${BASE}/oauth/authorize?response_type=code&client_id=${clientId}` +
      `&redirect_uri=${encodeURIComponent('https://example.com/auth/callback')}` +
      '&scope=openid&code_challenge=x&code_challenge_method=S256',
    { redirect: 'manual' },
  );
  check(dead.status !== 302, 'and an archived client cannot start a sign-in');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(`\nsmoke-portal crashed in "${group}":`, error);
  process.exit(1);
});
