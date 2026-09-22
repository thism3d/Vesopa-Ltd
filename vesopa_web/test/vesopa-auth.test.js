/**
 * Continue with Vesopa for /admin.
 *
 *     node --test test/vesopa-auth.test.js
 *
 * No network and no database: the issuer is a fake that signs real RS256
 * tokens with a key made here, and the pool is a recorder. What is under test
 * is every refusal — a sign-in path is judged by what it turns away.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');

const ISSUER = 'https://auth.test';
const CLIENT_ID = 'admin-client';

// ---- a fake issuer -----------------------------------------------------------

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'k1';
const JWK = { ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' };

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function sign(claims, { kid = KID, alg = 'RS256', key = privateKey } = {}) {
  const head = b64({ alg, kid, typ: 'JWT' });
  const body = b64(claims);
  const sig = alg === 'none' ? '' : crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), key).toString('base64url');
  return `${head}.${body}.${sig}`;
}
const nowS = () => Math.floor(Date.now() / 1000);
const goodClaims = (nonce, extra = {}) => ({
  iss: ISSUER, aud: CLIENT_ID, sub: 'sub-info', email: 'info@vesopasoftware.com',
  email_verified: true, nonce, iat: nowS(), exp: nowS() + 300, ...extra,
});

/** A fetch that plays auth.test. `mint(nonce)` decides the id_token. */
function fakeFetch(mint, calls = []) {
  return async (url, init = {}) => {
    calls.push(String(url));
    if (String(url).endsWith('/jwks.json')) {
      return { ok: true, status: 200, json: async () => ({ keys: [JWK] }) };
    }
    if (String(url).endsWith('/oauth/token')) {
      const form = new URLSearchParams(init.body);
      assert.equal(form.get('grant_type'), 'authorization_code');
      assert.ok(form.get('code_verifier'), 'PKCE verifier must be sent');
      return { ok: true, status: 200, json: async () => ({ id_token: mint(fakeFetch.lastNonce) }) };
    }
    throw new Error(`unexpected fetch ${url}`);
  };
}

const { createClient } = require('../src/vesopa-oidc');

function makeClient(mint) {
  const client = createClient({
    issuer: ISSUER, clientId: CLIENT_ID, clientSecret: 's3cret',
    redirectUri: 'https://vesopaepos.com/admin/auth/vesopa/callback',
    fetchImpl: fakeFetch(mint),
  });
  return client;
}

/** begin() then complete() with whatever token `mint` produces. */
async function signIn(mint) {
  const client = makeClient(mint);
  const { url, state } = client.begin();
  const u = new URL(url);
  fakeFetch.lastNonce = u.searchParams.get('nonce');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  return client.complete({ state, code: 'abc' });
}

// ---- the token ---------------------------------------------------------------

test('a correctly signed token for this client is accepted', async () => {
  const { claims } = await signIn((n) => sign(goodClaims(n)));
  assert.equal(claims.email, 'info@vesopasoftware.com');
});

const refusals = {
  'a nonce from some other sign-in': (n) => sign(goodClaims(n, { nonce: 'other' })),
  'a token for a different application': (n) => sign(goodClaims(n, { aud: 'someone-else' })),
  'a token from a different issuer': (n) => sign(goodClaims(n, { iss: 'https://evil.test' })),
  'an expired token': (n) => sign(goodClaims(n, { exp: nowS() - 3600 })),
  'a token not valid yet': (n) => sign(goodClaims(n, { nbf: nowS() + 3600 })),
  'a token signed by a key that is not published': (n) =>
    sign(goodClaims(n), { key: crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey }),
  'alg none': (n) => sign(goodClaims(n), { alg: 'none' }),
  'an unknown kid': (n) => sign(goodClaims(n), { kid: 'nobody' }),
  'a token whose payload was edited after signing': (n) => {
    const [h, , s] = sign(goodClaims(n)).split('.');
    return `${h}.${b64(goodClaims(n, { email: 'attacker@evil.test' }))}.${s}`;
  },
};
for (const [name, mint] of Object.entries(refusals)) {
  test(`refused: ${name}`, async () => {
    await assert.rejects(signIn(mint));
  });
}

test('a callback cannot be replayed with the same state', async () => {
  const client = makeClient((n) => sign(goodClaims(n)));
  const { url, state } = client.begin();
  fakeFetch.lastNonce = new URL(url).searchParams.get('nonce');
  await client.complete({ state, code: 'abc' });
  await assert.rejects(client.complete({ state, code: 'abc' }), /expired or was already used/);
});

test('an invented state is refused before any network call', async () => {
  const calls = [];
  const client = createClient({ issuer: ISSUER, clientId: CLIENT_ID, clientSecret: 's', redirectUri: 'x', fetchImpl: fakeFetch(() => '', calls) });
  await assert.rejects(client.complete({ state: 'made-up', code: 'abc' }));
  assert.equal(calls.length, 0);
});

test('not enabled without all three credentials', () => {
  assert.equal(createClient({ clientId: 'a', clientSecret: '', redirectUri: 'x' }).enabled, false);
  assert.equal(createClient({ clientId: 'a', clientSecret: 'b', redirectUri: 'x' }).enabled, true);
});

// ---- matching an admin ---------------------------------------------------------

/** A pool that answers from an in-memory admin_table and records writes. */
function fakePool(rows) {
  const writes = [];
  return {
    writes,
    async query(sql, params) {
      if (/^UPDATE admin_table SET vesopa_sub/.test(sql)) {
        const [sub, id] = params;
        const row = rows.find((r) => r.id === id && r.vesopa_sub == null);
        if (row) { row.vesopa_sub = sub; writes.push({ id, sub }); }
        return [{ affectedRows: row ? 1 : 0 }];
      }
      if (/WHERE vesopa_sub = \?/.test(sql)) return [rows.filter((r) => r.vesopa_sub === params[0])];
      if (/WHERE LOWER\(email\) = \?/.test(sql)) {
        return [rows.filter((r) => r.email && r.email.toLowerCase() === params[0])];
      }
      throw new Error(`unexpected query ${sql}`);
    },
  };
}
const admins = () => [
  { id: 6, username: 'vesopa2024', fullname: 'Vesopa EPOS Admin', email: null, status: 'Admin', enabled: 'Y', vesopa_sub: null },
  { id: 7, username: 'vesopaepos', fullname: 'Vesopa EPOS Admin', email: 'info@vesopasoftware.com', status: 'Admin', enabled: 'Y', vesopa_sub: null },
  { id: 10, username: 'mehedi901952', fullname: 'Mehedi', email: 'mehedi901952@gmail.com', status: 'Contributor', enabled: 'Y', vesopa_sub: null },
];

const { linkAndFind } = require('../src/admin/vesopa-auth');

test('first sign-in matches by verified email and links the subject', async () => {
  const pool = fakePool(admins());
  const admin = await linkAndFind(pool, { sub: 'sub-info', email: 'INFO@vesopasoftware.com' });
  assert.equal(admin.id, 7);
  assert.equal(admin.status, 'Admin');
  assert.deepEqual(pool.writes, [{ id: 7, sub: 'sub-info' }]);
  assert.equal('password' in admin, false, 'never hand back the hash');
});

test('once linked, the subject is enough even if the email changed', async () => {
  const rows = admins(); rows[1].vesopa_sub = 'sub-info';
  const admin = await linkAndFind(fakePool(rows), { sub: 'sub-info', email: 'new@elsewhere.test' });
  assert.equal(admin.id, 7);
});

test('a row linked to a different Vesopa account is not taken over', async () => {
  const rows = admins(); rows[1].vesopa_sub = 'somebody-else';
  await assert.rejects(linkAndFind(fakePool(rows), { sub: 'sub-info', email: 'info@vesopasoftware.com' }), /already linked/);
});

test('the legacy login with no email can never be matched', async () => {
  assert.equal(await linkAndFind(fakePool(admins()), { sub: 'x', email: '' }), null);
});

test('an unknown address gets nobody', async () => {
  assert.equal(await linkAndFind(fakePool(admins()), { sub: 'x', email: 'stranger@evil.test' }), null);
});

test('a disabled admin is refused even with a valid Vesopa sign-in', async () => {
  const rows = admins(); rows[2].enabled = 'N';
  const r = await linkAndFind(fakePool(rows), { sub: 'sub-m', email: 'mehedi901952@gmail.com' });
  assert.match(r.blocked, /disabled/);
});

test('a contributor keeps the contributor role', async () => {
  const r = await linkAndFind(fakePool(admins()), { sub: 'sub-m', email: 'mehedi901952@gmail.com' });
  assert.equal(r.status, 'Contributor');
});

// ---- the routes, end to end ------------------------------------------------------

/**
 * The module reads its flags at load, so each mode loads a fresh copy with its
 * own environment, and global fetch is the fake issuer.
 */
function loadRoutes(env) {
  for (const k of Object.keys(require.cache)) if (/vesopa-(auth|oidc)\.js$/.test(k)) delete require.cache[k];
  Object.assign(process.env, {
    VESOPA_AUTH_ADMIN_ENABLED: '', VESOPA_AUTH_ADMIN_CLIENT_ID: '',
    VESOPA_AUTH_ADMIN_CLIENT_SECRET: '', VESOPA_AUTH_ISSUER: ISSUER, ...env,
  });
  return require('../src/admin/vesopa-auth');
}

async function serve(mod, pool, mint) {
  const express = require('express');
  const app = express();
  const issued = [];
  const rendered = [];
  global.fetch = fakeFetch(mint);
  app.use('/admin', mod.vesopaAdminRoutes({
    pool,
    issue: (res, admin) => { issued.push(admin); res.cookie('vesopa_admin', 'x'); },
    render: (res, status, error) => { rendered.push({ status, error }); res.status(status).send(error); },
  }));
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (path) => new Promise((resolve, reject) => {
    http.get(base + path, (res) => {
      let body = ''; res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location, cookie: res.headers['set-cookie'], body }));
    }).on('error', reject);
  });
  return { get, issued, rendered, close: () => server.close() };
}

const LIVE_ENV = { VESOPA_AUTH_ADMIN_ENABLED: 'on', VESOPA_AUTH_ADMIN_CLIENT_ID: CLIENT_ID, VESOPA_AUTH_ADMIN_CLIENT_SECRET: 's3cret' };

test('dormant by default: the auth paths are 404 and nothing is live', async () => {
  const mod = loadRoutes({});
  assert.equal(mod.LIVE, false);
  const s = await serve(mod, fakePool(admins()), () => '');
  try {
    assert.equal((await s.get('/admin/auth/vesopa/start')).status, 404);
    assert.equal((await s.get('/admin/auth/vesopa/callback?state=x&code=y')).status, 404);
  } finally { s.close(); }
});

test('the flag without credentials is still dormant', async () => {
  const mod = loadRoutes({ VESOPA_AUTH_ADMIN_ENABLED: 'on' });
  assert.equal(mod.LIVE, false);
});

test('there is no "Vesopa only" switch any more: Vesopa is the only way in', () => {
  const mod = loadRoutes(LIVE_ENV);
  assert.equal('ONLY' in mod, false);
});

test('live: start redirects to the issuer with PKCE and the admin redirect URI', async () => {
  const mod = loadRoutes(LIVE_ENV);
  const s = await serve(mod, fakePool(admins()), () => '');
  try {
    const r = await s.get('/admin/auth/vesopa/start');
    assert.equal(r.status, 302);
    const u = new URL(r.location);
    assert.equal(u.origin + u.pathname, `${ISSUER}/oauth/authorize`);
    assert.equal(u.searchParams.get('client_id'), CLIENT_ID);
    assert.equal(u.searchParams.get('redirect_uri'), 'https://vesopaepos.com/admin/auth/vesopa/callback');
    assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  } finally { s.close(); }
});

async function roundTrip(mod, pool, mintClaims) {
  const s = await serve(mod, pool, (n) => sign(mintClaims(n)));
  try {
    const start = await s.get('/admin/auth/vesopa/start');
    const u = new URL(start.location);
    fakeFetch.lastNonce = u.searchParams.get('nonce');
    const cb = await s.get(`/admin/auth/vesopa/callback?state=${encodeURIComponent(u.searchParams.get('state'))}&code=abc`);
    return { cb, issued: s.issued, rendered: s.rendered };
  } finally { s.close(); }
}

test('live: info@ signs in, is linked, gets the admin cookie and lands on the dashboard', async () => {
  const pool = fakePool(admins());
  const { cb, issued } = await roundTrip(loadRoutes(LIVE_ENV), pool, (n) => goodClaims(n));
  assert.equal(cb.status, 303);
  assert.equal(cb.location, '/admin/dashboard');
  assert.equal(issued[0].id, 7);
  assert.deepEqual(pool.writes, [{ id: 7, sub: 'sub-info' }]);
});

test('live: a contributor lands on the File Manager', async () => {
  const { cb } = await roundTrip(loadRoutes(LIVE_ENV), fakePool(admins()),
    (n) => goodClaims(n, { sub: 'sub-m', email: 'mehedi901952@gmail.com' }));
  assert.equal(cb.location, '/admin/files');
});

test('live: an unverified email is refused and nothing is linked', async () => {
  const pool = fakePool(admins());
  const { cb, issued } = await roundTrip(loadRoutes(LIVE_ENV), pool, (n) => goodClaims(n, { email_verified: false }));
  assert.equal(cb.status, 403);
  assert.equal(issued.length, 0);
  assert.equal(pool.writes.length, 0);
});

test('live: a stranger is refused with wording that does not reveal who the admins are', async () => {
  const { cb, issued } = await roundTrip(loadRoutes(LIVE_ENV), fakePool(admins()),
    (n) => goodClaims(n, { sub: 'z', email: 'stranger@evil.test' }));
  assert.equal(cb.status, 403);
  assert.match(cb.body, /does not have access/);
  assert.equal(issued.length, 0);
});

test('live: a forged token never reaches the database', async () => {
  const pool = fakePool(admins());
  const { cb, issued } = await roundTrip(loadRoutes(LIVE_ENV), pool, (n) => goodClaims(n, { aud: 'someone-else' }));
  assert.equal(cb.status, 400);
  assert.equal(issued.length, 0);
  assert.equal(pool.writes.length, 0);
});

test('live: a disabled admin (Mehedi, 2026-09-22) is refused however valid the Vesopa sign-in', async () => {
  const rows = admins(); rows[2].enabled = 'N';
  const pool = fakePool(rows);
  const { cb, issued } = await roundTrip(loadRoutes(LIVE_ENV), pool,
    (n) => goodClaims(n, { sub: 'sub-m', email: 'mehedi901952@gmail.com' }));
  assert.equal(cb.status, 403);
  assert.match(cb.body, /disabled/);
  assert.equal(issued.length, 0, 'no admin cookie');
});
