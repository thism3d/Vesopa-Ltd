/**
 * The server-rendered members' site (src/member_web.js), 2026-10-11.
 *
 *   * a venue whose look says web: 'node' gets the pages; every other venue,
 *     and this one with the switch off, gets the Flutter build as before;
 *   * the Flutter build stays reachable at /app/ for a venue with the pages;
 *   * the sign-in page offers every way in the venue has switched on, in the
 *     app's order and words;
 *   * the card and every other member page need a session, and a revoked one
 *     signs the browser out;
 *   * a form without its token, with the wrong one, or posted from another
 *     site changes nothing;
 *   * Continue with Vesopa leaves with PKCE and a state, and refuses a code
 *     that comes back to a browser that did not start it.
 *
 * The loyalty router runs for real, in an express app of its own, over a
 * pool that answers the few questions these pages lead it to ask.
 *
 *   node test/member-web.test.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const test = require('node:test');
const assert = require('node:assert/strict');

const SECRET = 'member-web-test-secret';
const WEB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'member-web-'));
fs.writeFileSync(path.join(WEB_DIR, 'index.html'),
  '<!doctype html><html><head><base href="/__SLUG__/"><meta charset="UTF-8"><title>__APP_NAME__</title></head><body>FLUTTER-BUILD</body></html>');
process.env.LOYALTY_WEB_DIR = WEB_DIR;
process.env.LOYALTY_HOST = 'loyalty.vesopa.com';
process.env.LOYALTY_VENUE_HOSTS = 'member.pontardawerfc.com=pontardawe-rfc';
process.env.VESOPA_AUTH_ISSUER = 'https://auth.example.test';
process.env.VESOPA_LOYALTY_CLIENT_ID = 'loyalty-web';
process.env.POSTCODER_API_KEY = 'test';
for (const k of ['SMTP_HOST', 'SMTP_USER', 'MENU_SMTP_USER']) delete process.env[k];

const express = require('express');
const jwt = require('jsonwebtoken');
const { loyaltyHostGate } = require('../src/loyalty_host');
const { loyaltyAppRoutes } = require('../src/loyalty_app');
const { LOOKS, nodeWeb } = require('../src/venue_looks');

const OFFICE = 'club@pontardawe.test';
const VENUES = {
  'pontardawe-rfc': { office: OFFICE, slug: 'pontardawe-rfc', enabled: 1, app_name: 'Pontardawe RFC', welcome_text: 'Your membership card.' },
  thevesopakitchen: { office: 'kitchen@vesopa.test', slug: 'thevesopakitchen', enabled: 1, app_name: 'The Vesopa Kitchen' },
};
const CUSTOMER = {
  id: 'c-1', email_key: OFFICE, name: 'Gareth Jones', email: 'gareth@example.test', card_number: '999800042',
  member_no: 42, member_number: '00042', points_balance: 120, visits: 7, created_at: new Date('2025-08-01T10:00:00Z'),
};

/** What the venue offers, changed per test. */
let methods = [];
let revoked = null;

/** A pool that answers what these pages ask; anything else is an empty answer. */
const pool = {
  async query(sql, params = []) {
    if (/FROM epos_loyalty_app WHERE slug = \?/.test(sql)) return [[VENUES[params[0]]].filter(Boolean)];
    if (/FROM epos_loyalty_app_methods/.test(sql)) return [methods];
    if (/SELECT id, name FROM offices/.test(sql)) return [[{ id: 1, name: 'Pontardawe RFC' }]];
    if (/revoked_at FROM epos_loyalty_app_sessions/.test(sql)) return [[{ revoked_at: revoked }]];
    if (/FROM epos_customers\s+WHERE id = \? AND email_key = \?/.test(sql)) return [[{ ...CUSTOMER }]];
    if (/SUM\(email = \?\)/.test(sql)) return [[{ by_email: 0, by_ip: 0 }]];
    if (/FROM epos_push_inbox/.test(sql) && /COUNT/.test(sql)) return [[{ n: 0 }]];
    return [[], []];
  },
  async execute() {
    return [{ affectedRows: 1 }];
  },
};

const app = express();
app.set('trust proxy', 1);
app.use(loyaltyHostGate());
app.use(express.json());
app.use(loyaltyAppRoutes({ pool, broadcast() {}, secret: SECRET }));
let server;

test.before(() => new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); }));
test.after(() => {
  server.close();
  fs.rmSync(WEB_DIR, { recursive: true, force: true });
});

/** One request, answered with status, headers and body. */
function call(method, host, url, { cookie, form, headers = {}, ua } = {}) {
  return new Promise((resolve, reject) => {
    const body = form ? new URLSearchParams(form).toString() : null;
    const req = http.request({
      host: '127.0.0.1', port: server.address().port, method, path: url,
      headers: {
        host,
        'user-agent': ua || 'Mozilla/5.0 (Linux; Android 14) Chrome/130',
        ...(cookie ? { cookie } : {}),
        ...(body ? { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body) } : {}),
        ...headers,
      },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const MEMBER = 'member.pontardawerfc.com';
const sessionToken = () => jwt.sign({ scope: 'loyalty', office: OFFICE, cid: CUSTOMER.id }, SECRET, { expiresIn: '1h', jwtid: `s-${Math.random()}` });
const cookiesOf = (res) => [].concat(res.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
const formToken = (html) => (/name="_csrf" value="([^"]+)"/.exec(html) || [])[1];

test('the switch is on the look: Pontardawe RFC has it, other venues do not', () => {
  assert.equal(nodeWeb('pontardawe-rfc'), true);
  assert.equal(nodeWeb('thevesopakitchen'), false);
  assert.equal(nodeWeb(''), false);
});

test('a venue with the pages gets them at its own host, with no Flutter in sight', async () => {
  methods = [];
  const res = await call('GET', MEMBER, '/');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/html/);
  assert.doesNotMatch(res.body, /FLUTTER-BUILD|main\.dart\.js|flutter/i);
  assert.match(res.body, /<h1>Pontardawe RFC<\/h1>/);
  assert.match(res.body, /Email me a code/);
  // The club's colour and typeface, in the page itself.
  assert.match(res.body, /--club:#8F0000/);
  assert.match(res.body, /prefers-color-scheme:dark/);
  assert.match(res.body, /rel="preload" href="\/assets\/fonts\/montserrat\/montserrat-latin-400-normal\.woff2"/);
  assert.match(res.body, /font-display:swap/);
  assert.match(res.body, /rel="manifest" href="\/manifest\.webmanifest"/);
  // Small: everything in one response.
  assert.ok(Buffer.byteLength(res.body) < 40 * 1024, `the sign-in page is ${Buffer.byteLength(res.body)} bytes`);
  assert.match(res.headers['content-security-policy'], /frame-ancestors 'none'/);
});

test('every other venue, and this one with the switch off, gets the Flutter build exactly as before', async () => {
  const other = await call('GET', 'loyalty.vesopa.com', '/thevesopakitchen/');
  assert.equal(other.status, 200);
  assert.match(other.body, /FLUTTER-BUILD/);

  const look = LOOKS['pontardawe-rfc'];
  const was = look.web;
  delete look.web;
  try {
    const res = await call('GET', MEMBER, '/');
    assert.match(res.body, /FLUTTER-BUILD/);
    assert.match(res.body, /<base href="\/">/);
  } finally {
    look.web = was;
  }
});

test('the Flutter build is kept at /app/ as a fallback', async () => {
  const res = await call('GET', MEMBER, '/app/');
  assert.equal(res.status, 200);
  assert.match(res.body, /FLUTTER-BUILD/);
  assert.match(res.body, /<base href="\/app\/">/);
  assert.deepEqual([(await call('GET', MEMBER, '/app')).status, (await call('GET', MEMBER, '/app')).headers.location], [301, '/app/']);
  // Its files are the build's, and the manifest still answers for the pages.
  assert.equal((await call('GET', MEMBER, '/app/main.dart.js')).status, 404, 'no build file in the test folder');
  const manifest = await call('GET', MEMBER, '/manifest.webmanifest');
  assert.equal(manifest.status, 200);
  assert.equal(JSON.parse(manifest.body).start_url, '/');
});

test('the sign-in page offers every way in the venue has switched on', async () => {
  methods = ['code_email', 'password', 'passkey', 'code_sms', 'vesopa'].map((method) => ({ method, enabled: 1 }));
  let res = await call('GET', MEMBER, '/');
  const page = res.body;
  assert.match(page, /action="\/signin\/code"/);
  assert.match(page, /Email me a code/);
  assert.match(page, /href="\/vesopa\?idp=google"[^>]*>.*Continue with Google/);
  assert.match(page, /href="\/vesopa\?idp=apple"[^>]*>.*Continue with Apple/);
  // The venue's own passkey: a button the browser's script switches on.
  assert.match(page, /data-passkey hidden>.*Use a passkey/);
  assert.match(page, /href="\/\?with=password">Use a password/);
  assert.match(page, /href="\/\?with=code_sms">Text me a code/);
  // With texting offered by the venue, there is no separate phone button.
  assert.doesNotMatch(page, /Continue with your phone/);
  // Google first on Android, Apple first on an iPhone, as the app orders them.
  assert.ok(page.indexOf('Continue with Google') < page.indexOf('Continue with Apple'));
  res = await call('GET', MEMBER, '/', { ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1' });
  assert.ok(res.body.indexOf('Continue with Apple') < res.body.indexOf('Continue with Google'));

  // Each form way in.
  assert.match((await call('GET', MEMBER, '/?with=password')).body, /name="password"[^>]*autocomplete="current-password"/);
  assert.match((await call('GET', MEMBER, '/?with=code_sms')).body, /action="\/signin\/sms"/);

  // Through Vesopa only: its passkey and the phone are Vesopa's pages.
  methods = [{ method: 'code_email', enabled: 1 }, { method: 'vesopa', enabled: 1 }];
  res = await call('GET', MEMBER, '/');
  assert.match(res.body, /href="\/vesopa\?idp=passkey"/);
  assert.match(res.body, /href="\/vesopa\?idp=phone"[^>]*>.*Continue with your phone/);

  // A venue that has touched nothing: an emailed code and nothing else.
  methods = [];
  res = await call('GET', MEMBER, '/');
  assert.doesNotMatch(res.body, /class="or"/);
});

test('the card and the other pages need a session', async () => {
  for (const url of ['/activity', '/news', '/account', '/venue', '/classes']) {
    const res = await call('GET', MEMBER, url);
    assert.equal(res.status, 303, url);
    assert.equal(res.headers.location, '/', url);
  }
  const res = await call('GET', MEMBER, '/');
  assert.doesNotMatch(res.body, /Show this at the till/);
});

test('signed in, the card is in the first response', async () => {
  revoked = null;
  const cookie = `__Host-member_pontardawe-rfc=${sessionToken()}`;
  const res = await call('GET', MEMBER, '/', { cookie });
  assert.equal(res.status, 200);
  assert.match(res.body, /Show this at the till/);
  assert.match(res.body, /Member 00042/);
  assert.match(res.body, /<svg[^>]+aria-label="QR code"/);
  assert.match(res.body, /9998 0004 2/);
  assert.match(res.body, /<b>120<\/b><span>points<\/span>/);
  assert.match(res.body, /aria-current="page"><span>.*<\/span>Card/);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.ok(Buffer.byteLength(res.body) < 40 * 1024, `the card page is ${Buffer.byteLength(res.body)} bytes`);

  for (const url of ['/activity', '/news', '/account', '/venue']) {
    const page = await call('GET', MEMBER, url, { cookie });
    assert.equal(page.status, 200, url);
    // The club's phone app at the bottom of every page: Android sees Google Play.
    assert.match(page.body, /alt="Get it on Google Play"/, url);
    assert.doesNotMatch(page.body, /Download on the App Store/, url);
  }
});

test('the store badges: each phone sees its own store, a computer both, the app itself none', async () => {
  const badges = async (ua) => (await call('GET', MEMBER, '/', { ua })).body;
  const iphone = await badges('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)');
  assert.match(iphone, /href="https:\/\/testflight\.apple\.com\/join\/cWqDESsD"/);
  assert.doesNotMatch(iphone, /Google Play/);
  const pc = await badges('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
  assert.match(pc, /Download on the App Store/);
  assert.match(pc, /href="https:\/\/play\.google\.com\/store\/apps\/details\?id=com\.vesopaepos\.pontardawerfc"/);
  assert.doesNotMatch(await badges('VesopaLoyalty (iPad; iOS 18.0)'), /class="get-app"/);
});

test('a session revoked elsewhere signs this browser out', async () => {
  revoked = new Date();
  try {
    const res = await call('GET', MEMBER, '/account', { cookie: `__Host-member_pontardawe-rfc=${sessionToken()}` });
    assert.equal(res.status, 303);
    assert.equal(res.headers.location, '/?signed_out=1');
    assert.match(res.headers['set-cookie'].join('\n'), /__Host-member_pontardawe-rfc=; Path=\/; Max-Age=0; HttpOnly; Secure; SameSite=Lax/);
  } finally {
    revoked = null;
  }
});

test('a form without its token, with the wrong one, or from another site changes nothing', async () => {
  methods = [];
  // No token at all.
  let res = await call('POST', MEMBER, '/signin/code', { form: { email: 'a@b.test' } });
  assert.equal(res.status, 403);
  assert.match(res.body, /Please try again/);

  const page = await call('GET', MEMBER, '/');
  const cookie = cookiesOf(page);
  const token = formToken(page.body);
  assert.ok(token && /__Host-member_csrf=/.test(cookie));
  assert.match(page.headers['set-cookie'].join('\n'), /__Host-member_csrf=[^;]+; Path=\/; Max-Age=\d+; HttpOnly; Secure; SameSite=Lax/);

  // The wrong token, or the right one sent from somewhere else.
  res = await call('POST', MEMBER, '/signin/code', { cookie, form: { _csrf: `${token.slice(0, -2)}xx`, email: 'a@b.test' } });
  assert.equal(res.status, 403);
  res = await call('POST', MEMBER, '/signin/code', { cookie, form: { _csrf: token, email: 'a@b.test' }, headers: { origin: 'https://evil.example' } });
  assert.equal(res.status, 403);
  // A token from another browser's cookie.
  res = await call('POST', MEMBER, '/signin/code', { cookie: '__Host-member_csrf=someoneelsescookievalue1234', form: { _csrf: token, email: 'a@b.test' } });
  assert.equal(res.status, 403);

  // The right one: the code is asked for, and the page asks for it.
  res = await call('POST', MEMBER, '/signin/code', { cookie, form: { _csrf: token, email: 'gareth@example.test' }, headers: { origin: `https://${MEMBER}` } });
  assert.equal(res.status, 200);
  assert.match(res.body, /We have emailed a six-digit code to gareth@example\.test\./);
  assert.match(res.body, /action="\/signin\/verify"/);
  assert.match(res.body, /autocomplete="one-time-code"/);

  // Asked of the page, an address that is not one is said so, in the app's words.
  res = await call('POST', MEMBER, '/signin/code', { cookie, form: { _csrf: token, email: 'nope' } });
  assert.equal(res.status, 400);
  assert.match(res.body, /Please enter your email address\./);
});

test('Continue with Vesopa leaves with PKCE and refuses a code it did not start', async () => {
  methods = [{ method: 'code_email', enabled: 1 }, { method: 'vesopa', enabled: 1 }];
  const res = await call('GET', MEMBER, '/vesopa?idp=google');
  assert.equal(res.status, 303);
  const to = new URL(res.headers.location);
  assert.equal(to.origin + to.pathname, 'https://auth.example.test/oauth/authorize');
  assert.equal(to.searchParams.get('client_id'), 'loyalty-web');
  assert.equal(to.searchParams.get('idp'), 'google');
  assert.equal(to.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(to.searchParams.get('redirect_uri'), `http://${MEMBER}/app/vesopa/callback`);
  const state = to.searchParams.get('state');
  assert.match(state, /^pontardawe-rfc\./);
  const sso = res.headers['set-cookie'].find((c) => c.startsWith('__Host-member_sso='));
  assert.match(sso, /Max-Age=600; HttpOnly; Secure; SameSite=Lax/);

  // The callback returns to the root of the venue's host...
  const back = await call('GET', MEMBER, `/app/vesopa/callback?code=abc&state=${encodeURIComponent(state)}`);
  assert.equal(back.status, 302);
  assert.match(back.headers.location, /^\/\?vesopa_code=abc&vesopa_state=/);

  // ...where a browser that did not start it is refused.
  const stranger = await call('GET', MEMBER, `/?vesopa_code=abc&vesopa_state=${encodeURIComponent(state)}`);
  assert.equal(stranger.status, 400);
  assert.match(stranger.body, /could not be matched to this device/);

  const cancelled = await call('GET', MEMBER, '/?vesopa_error=access_denied');
  assert.match(cancelled.body, /That sign-in was cancelled\./);
});

test('signing out asks the API to revoke the session and forgets the cookie', async () => {
  const page = await call('GET', MEMBER, '/');
  const cookie = `${cookiesOf(page)}; __Host-member_pontardawe-rfc=${sessionToken()}`;
  const res = await call('POST', MEMBER, '/signout', { cookie, form: { _csrf: formToken(page.body) } });
  assert.equal(res.status, 303);
  assert.equal(res.headers.location, '/');
  assert.match(res.headers['set-cookie'].join('\n'), /__Host-member_pontardawe-rfc=; Path=\/; Max-Age=0/);
});
