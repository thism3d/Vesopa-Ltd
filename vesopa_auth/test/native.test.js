const test = require('node:test');
const assert = require('node:assert');

const { audiences, passkeyOrigins, makeTicket, readTicket } = require('../src/routes/native');

const app = { id: 7 };
const who = { userId: 21, amr: ['apple'], acr: 'aal1' };

test('a consent ticket reads back for the same app and code challenge', () => {
  const ticket = makeTicket(who, app, 'challenge-1');
  assert.deepStrictEqual(readTicket(ticket, app, 'challenge-1'), who);
});

test('a consent ticket is refused for another code challenge or app', () => {
  const ticket = makeTicket(who, app, 'challenge-1');
  assert.strictEqual(readTicket(ticket, app, 'challenge-2'), null);
  assert.strictEqual(readTicket(ticket, { id: 8 }, 'challenge-1'), null);
});

test('a changed consent ticket is refused', () => {
  const [body, mac] = makeTicket(who, app, 'c').split('.');
  const forged = Buffer.from(JSON.stringify({ u: 1, m: ['apple'], l: 'aal2', a: 7, c: 'c', exp: Date.now() + 60000 }))
    .toString('base64url');
  assert.strictEqual(readTicket(`${forged}.${mac}`, app, 'c'), null);
  assert.strictEqual(readTicket(body, app, 'c'), null);
  assert.strictEqual(readTicket('', app, 'c'), null);
});

test('apple takes the venue apps by default; google takes the web client', () => {
  delete process.env.NATIVE_APPLE_AUDIENCES;
  assert.ok(audiences('apple').includes('com.vesopaepos.pontardawerfc'));
  process.env.GOOGLE_CLIENT_ID = 'web.apps.googleusercontent.com';
  process.env.NATIVE_GOOGLE_AUDIENCES = 'ios.apps.googleusercontent.com, web.apps.googleusercontent.com';
  assert.deepStrictEqual(audiences('google'), ['ios.apps.googleusercontent.com', 'web.apps.googleusercontent.com']);
  assert.deepStrictEqual(audiences('passkey'), []);
});

test("an iPhone's passkey origin (https://<rp id>) is accepted", () => {
  assert.ok(passkeyOrigins().includes('https://vesopa.com'));
});
