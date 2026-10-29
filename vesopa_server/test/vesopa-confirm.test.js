/**
 * Signing a till or kitchen screen out with a Vesopa account (2026-10-27):
 * POST /api/vesopa/confirm says yes for somebody from the device's own venue
 * and no for anybody else, with a real signed token, once.
 *
 *   node test/vesopa-confirm.test.js
 *
 * In-process: the Vesopa key set and the database are stand-ins.
 */
process.env.VESOPA_AUTH_TILL_ENABLED = 'on';
process.env.VESOPA_AUTH_TILL_CLIENT_ID = 'vesopa-epos-test';
process.env.VESOPA_AUTH_KITCHEN_CLIENT_ID = 'vesopa-kitchen-test';

const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');

const SECRET = 'confirm-test-secret';
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };

const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  if (String(url).endsWith('/jwks.json')) {
    return { ok: true, status: 200, json: async () => ({ keys: [jwk] }) };
  }
  return realFetch(url, opts);
};

const { terminalVesopaRoutes, ISSUER } = require('../src/terminal_vesopa');

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`  FAIL  ${name}\n        ${e.stack}`);
    process.exitCode = 1;
  }
}

const users = [
  { id: 1, email: 'nicki@club.test', name: 'Nicki', approved: 'Y', role: 'office', office_id: 10, vesopa_sub: null, office_status: 'active', office_name: 'Club', office_email: 'club@venue.test' },
  { id: 2, email: 'stranger@other.test', name: 'Stranger', approved: 'Y', role: 'office', office_id: 20, vesopa_sub: null, office_status: 'active', office_name: 'Other', office_email: 'other@venue.test' },
];
const pool = {
  async execute(sql, params) {
    if (/WHERE u.vesopa_sub = \?/.test(sql)) return [users.filter((u) => u.vesopa_sub === params[0])];
    if (/WHERE LOWER\(u.email\) = \?/.test(sql)) return [users.filter((u) => u.email.toLowerCase() === params[0])];
    if (/UPDATE backoffice_users SET vesopa_sub/.test(sql)) {
      const u = users.find((x) => x.id === params[1]);
      if (u && !u.vesopa_sub) u.vesopa_sub = params[0];
      return [{ affectedRows: 1 }];
    }
    throw new Error(`unexpected execute ${sql}`);
  },
  async query(sql, params) {
    if (/SELECT office_id FROM backoffice_users/.test(sql)) return [[{ office_id: users.find((u) => u.id === params[0])?.office_id }]];
    if (/FROM bo_user_sites/.test(sql)) return [[]];
    if (/FROM offices WHERE id = \?/.test(sql)) return [[]];
    throw new Error(`unexpected query ${sql}`);
  },
};

function idToken(email, { aud = 'vesopa-epos-test', sub = `sub-${email}` } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    { iss: ISSUER, aud, sub, email, email_verified: true, iat: now, exp: now + 300, jti: crypto.randomUUID() },
    privateKey,
    { algorithm: 'RS256', keyid: 'k1' }
  );
}

(async () => {
  const app = express();
  app.use(terminalVesopaRoutes({ pool, secret: SECRET, issueToken: () => 't', issueTerminalToken: () => 't' }));
  const server = await new Promise((r) => { const s = http.createServer(app).listen(0, '127.0.0.1', () => r(s)); });
  const call = async (token, body) => {
    const res = await realFetch(`http://127.0.0.1:${server.address().port}/api/vesopa/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const till = jwt.sign({ scope: 'terminal', office: 'club@venue.test' }, SECRET);
  const kitchen = jwt.sign({ scope: 'kitchen', office: 'club@venue.test' }, SECRET);

  await check('somebody from the venue may sign the till out', async () => {
    const r = await call(till, { id_token: idToken('nicki@club.test') });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.strictEqual(r.json.email, 'nicki@club.test');
  });

  await check('a kitchen screen confirms with its own Vesopa client', async () => {
    const r = await call(kitchen, { id_token: idToken('nicki@club.test', { aud: 'vesopa-kitchen-test' }) });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  });

  await check('somebody from another venue may not', async () => {
    const r = await call(till, { id_token: idToken('stranger@other.test') });
    assert.strictEqual(r.status, 403);
  });

  await check('the same sign-in cannot be used twice, and a device must be signed in', async () => {
    const t = idToken('nicki@club.test');
    assert.strictEqual((await call(till, { id_token: t })).status, 200);
    assert.strictEqual((await call(till, { id_token: t })).status, 401);
    assert.strictEqual((await call(null, { id_token: idToken('nicki@club.test') })).status, 401);
    assert.strictEqual((await call(till, { id_token: 'not.a.token' })).status, 401);
  });

  server.close();
  console.log(`${passed} passed`);
})();
