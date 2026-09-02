const assert = require('assert');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const G = require('../src/wallet_google');

/**
 * Google Wallet passes, tested without an issuer account.
 *
 * Everything Google would check on the way in is checked here instead: the
 * shape of the class and object for each of the four passes, the claims and
 * the signature on the save link, and the REST client's create-or-update
 * behaviour against a stubbed fetch. What is deliberately NOT covered is
 * whether Google accepts the credentials — that needs a real service account
 * and is what POST /api/wallet/diagnose exists to answer.
 *
 * The signing key is generated here rather than read from anywhere, so this
 * suite runs on a laptop with no secrets on it.
 */

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const ENV = {
  GOOGLE_WALLET_ISSUER_ID: '3388000000023197382',
  GOOGLE_WALLET_SA_EMAIL: 'vesopa-wallet@vesopa-passes.iam.gserviceaccount.com',
  GOOGLE_WALLET_SA_KEY: privateKey,
  GOOGLE_WALLET_ORIGINS: 'https://backoffice.vesopaepos.com',
};

const BRAND = {
  issuer_name: 'The Copper Kettle',
  program_name: 'Copper Rewards',
  logo_url: 'https://cdn.vesopaepos.com/copper/logo-660.png',
  hero_url: 'https://cdn.vesopaepos.com/copper/hero-1032.png',
  hex_background: '#0f5132',
  homepage_url: 'https://copperkettle.example',
  support_phone: '01912345678',
  terms: 'Points expire after 12 months.',
};

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (e) {
    console.error(`\n  FAIL  ${name}\n        ${e.message}\n`);
    process.exitCode = 1;
  }
}
// Async checks are collected rather than awaited at the call site, so the file
// stays flat and readable. `finish()` at the bottom waits for all of them —
// without it the summary can print before a failure has been recorded.
const pending = [];
function testAsync(name, fn) {
  pending.push(
    (async () => {
      try {
        await fn();
        passed += 1;
      } catch (e) {
        console.error(`\n  FAIL  ${name}\n        ${e.message}\n`);
        process.exitCode = 1;
      }
    })()
  );
}

// ---- Configuration --------------------------------------------------------

test('a complete environment is accepted', () => {
  const c = G.readConfig(ENV);
  assert.strictEqual(c.configured, true, c.problems.join('; '));
  assert.strictEqual(c.issuerId, '3388000000023197382');
  assert.deepStrictEqual(c.origins, ['https://backoffice.vesopaepos.com']);
  assert.strictEqual(c.reviewStatus, 'UNDER_REVIEW');
});

test('an empty environment names every missing piece rather than throwing', () => {
  const c = G.readConfig({});
  assert.strictEqual(c.configured, false);
  const joined = c.problems.join(' | ');
  for (const expected of ['ISSUER_ID', 'service-account email', 'signing key', 'ORIGINS']) {
    assert.ok(joined.includes(expected), `expected "${expected}" in: ${joined}`);
  }
});

test('a merchant ID pasted in place of the issuer ID is rejected', () => {
  // BCR2DN... is the Google Pay merchant ID, which is a different thing and
  // lives on the same console page — an easy and otherwise silent mix-up.
  const c = G.readConfig({ ...ENV, GOOGLE_WALLET_ISSUER_ID: 'BCR2DN6D3LQ5NWRK' });
  assert.strictEqual(c.configured, false);
  assert.ok(c.problems.some((p) => p.includes('not an issuer number')));
});

test('a user account in place of a service account is rejected', () => {
  const c = G.readConfig({ ...ENV, GOOGLE_WALLET_SA_EMAIL: 'admin@vesopa.com' });
  assert.strictEqual(c.configured, false);
  assert.ok(c.problems.some((p) => p.includes('service-account address')));
});

test('a key with escaped newlines is repaired', () => {
  const escaped = privateKey.replace(/\n/g, '\\n');
  const c = G.readConfig({ ...ENV, GOOGLE_WALLET_SA_KEY: escaped });
  assert.strictEqual(c.configured, true, c.problems.join('; '));
  // The proof it was really repaired: node will only load a well-formed PEM.
  assert.doesNotThrow(() => crypto.createPrivateKey(c.key));
});

// ---- Identifiers ----------------------------------------------------------

test('an office email becomes a legal Google id suffix', () => {
  const suffix = G.idSuffix('manager@copper-kettle.co.uk', 'loyalty');
  assert.ok(/^[a-z0-9._-]+$/.test(suffix), suffix);
  assert.ok(!suffix.includes('@'));
});

test('two long office emails do not collapse onto one id', () => {
  const long = 'a'.repeat(70);
  const a = G.idSuffix(`${long}@one.example.com`, 'loyalty');
  const b = G.idSuffix(`${long}@two.example.com`, 'loyalty');
  assert.notStrictEqual(a, b);
  assert.ok(a.length <= 90 && b.length <= 90);
});

test('the same input always produces the same id', () => {
  assert.strictEqual(
    G.idSuffix('shop@example.com', 'loyalty', 'cust-1'),
    G.idSuffix('shop@example.com', 'loyalty', 'cust-1')
  );
});

// ---- The four passes ------------------------------------------------------

const config = G.readConfig(ENV);
const office = 'manager@copper-kettle.co.uk';

function build(kind, subject) {
  return G.buildPass({ kind, config, office, brand: BRAND, subject });
}

test('the loyalty card carries the balance, the tier and a scannable number', () => {
  const { klass, object, classId, objectId } = build('loyalty', {
    id: 'cust-1',
    name: 'Aisha Rahman',
    phone: '07700900123',
    card_number: '999800001',
    points: 1240,
    tier: 'Gold',
    member_since: '2024-03-11',
  });

  assert.ok(classId.startsWith('3388000000023197382.'));
  assert.ok(objectId.startsWith('3388000000023197382.'));
  assert.strictEqual(klass.programName, 'Copper Rewards');
  assert.strictEqual(klass.issuerName, 'The Copper Kettle');
  assert.strictEqual(klass.reviewStatus, 'UNDER_REVIEW');
  assert.strictEqual(klass.programLogo.sourceUri.uri, BRAND.logo_url);

  assert.strictEqual(object.classId, classId);
  assert.strictEqual(object.state, 'ACTIVE');
  assert.strictEqual(object.loyaltyPoints.balance.int, 1240);
  assert.strictEqual(object.secondaryLoyaltyPoints.balance.string, 'Gold');
  assert.strictEqual(object.barcode.value, '999800001');
  assert.strictEqual(object.barcode.type, 'QR_CODE');
  assert.strictEqual(object.accountName, 'Aisha Rahman');
});

test('a loyalty card with no tier omits the field rather than sending an empty one', () => {
  const { object } = build('loyalty', { id: 'c2', name: 'No Tier', points: 0 });
  assert.strictEqual(object.secondaryLoyaltyPoints, undefined);
  assert.strictEqual(G.prune(object).secondaryLoyaltyPoints, undefined);
  assert.ok(!('secondaryLoyaltyPoints' in G.prune(object)));
});

test('the staff card has the four fields a generic object cannot exist without', () => {
  const { object } = build('staff', {
    id: '42',
    name: 'Tom Beckett',
    role: 'Supervisor',
    card_number: '999900042',
  });
  for (const field of ['cardTitle', 'header', 'logo', 'hexBackgroundColor']) {
    assert.ok(object[field], `generic object is missing ${field}`);
  }
  assert.strictEqual(object.header.defaultValue.value, 'Tom Beckett');
  assert.strictEqual(object.subheader.defaultValue.value, 'Supervisor');
  assert.strictEqual(object.barcode.value, '999900042');
});

test('a staff PIN never reaches the card', () => {
  const { klass, object } = build('staff', {
    id: '42',
    name: 'Tom Beckett',
    card_number: '999900042',
  });
  const serialised = JSON.stringify({ klass, object });
  // The subject builder in wallet.js does not pass the PIN through; this is the
  // backstop that says so out loud, because the temptation to add it as a
  // "handy" text module is real.
  assert.ok(!/pin/i.test(serialised), 'the word PIN appears somewhere on the pass');
});

test('the loyalty card shows the membership number as well as the barcode', () => {
  // Two different numbers doing two different jobs: 999800001 is what the
  // scanner reads, 1 is what the member reads out over the phone.
  const { object } = build('loyalty', {
    id: 'cust-1',
    name: 'Aisha Rahman',
    card_number: '999800001',
    member_no: '1',
    points: 10,
  });
  assert.strictEqual(object.barcode.value, '999800001');
  const memberNo = object.textModulesData.find((m) => m.header === 'Member no');
  assert.ok(memberNo, JSON.stringify(object.textModulesData));
  assert.strictEqual(memberNo.body, '1');
});

test('a customer who predates card issuing gets no empty membership field', () => {
  // member_no is NULL for the back catalogue, and inventing one would hand a
  // customer a number nobody ever gave them.
  const { object } = build('loyalty', {
    id: 'cust-old',
    name: 'Long Standing',
    card_number: '999800002',
    member_no: '',
    points: 900,
  });
  assert.ok(!object.textModulesData.some((m) => m.header === 'Member no'));
  assert.strictEqual(object.barcode.value, '999800002');
});

test('the barcode carries the bare card number, with no track-2 sentinels', () => {
  // The `;` and `?` a stripe reader emits are the reader's framing, not the
  // card's data. A QR has its own framing and a sentinel in it would break the
  // scan, so the stored value must stay bare.
  const { object } = build('customer', {
    id: 'cust-2',
    name: 'Bare Number',
    card_number: '999800003',
  });
  assert.strictEqual(object.barcode.value, '999800003');
  assert.ok(!/[;?]/.test(object.barcode.value));
});

test('the customer card shows the standing discount', () => {
  const { object } = build('customer', {
    id: 'cust-9',
    name: 'Trade Account',
    card_number: '999800099',
    member_no: '99',
    discount: '10% off',
  });
  const bodies = object.textModulesData.map((m) => m.body);
  assert.ok(bodies.includes('10% off'), JSON.stringify(bodies));
  assert.ok(bodies.includes('99'), JSON.stringify(bodies));
});

test('the promotional card ends when the promotion ends', () => {
  const { klass, object } = build('promo', {
    id: '7',
    title: '2 for 1 Tuesdays',
    details: 'Two mains for the price of one, all day Tuesday.',
    card_number: 'PROMO7',
    ends_on: '2026-12-31',
  });
  assert.strictEqual(klass.title, '2 for 1 Tuesdays');
  assert.strictEqual(klass.redemptionChannel, 'INSTORE');
  assert.strictEqual(klass.provider, 'The Copper Kettle');
  assert.ok(object.validTimeInterval.end.date.startsWith('2026-12-31'));
});

test('an open-ended promotion sends no expiry rather than a broken one', () => {
  const { object } = build('promo', { id: '8', title: 'Always on' });
  assert.strictEqual(object.validTimeInterval, undefined);
});

test('missing artwork is left out, not sent as an empty image', () => {
  const bare = G.buildPass({
    kind: 'loyalty',
    config,
    office,
    brand: { issuer_name: 'Bare' },
    subject: { id: 'c3', name: 'Someone' },
  });
  assert.strictEqual(bare.klass.programLogo, undefined);
  assert.strictEqual(bare.klass.heroImage, undefined);
  // ...and there is still a terms block, because a loyalty class without one
  // shows an empty Details panel.
  assert.ok(bare.klass.textModulesData.some((m) => m.header === 'Terms'));
});

test('an unknown pass kind is refused', () => {
  assert.throws(
    () => build('giftcard', { id: '1' }),
    (e) => e instanceof G.WalletError && e.status === 400
  );
});

// ---- The save link --------------------------------------------------------

test('the save link is a correctly signed savetowallet JWT', () => {
  const { url, token } = G.saveUrl({ config, kind: 'loyalty', ids: ['3388000000023197382.abc'] });
  assert.ok(url.startsWith(G.SAVE_PREFIX), url.slice(0, 60));

  // Verified with the public half of the key, so this proves RS256 signing and
  // not merely that a JWT-shaped string came back.
  const claims = jwt.verify(token, publicKey, { algorithms: ['RS256'] });
  assert.strictEqual(claims.aud, 'google');
  assert.strictEqual(claims.typ, 'savetowallet');
  assert.strictEqual(claims.iss, ENV.GOOGLE_WALLET_SA_EMAIL);
  assert.deepStrictEqual(claims.origins, ['https://backoffice.vesopaepos.com']);
  assert.ok(claims.iat > 0);
  assert.deepStrictEqual(claims.payload.loyaltyObjects, [{ id: '3388000000023197382.abc' }]);
});

test('each kind lands in the payload key Google expects', () => {
  const cases = [
    ['loyalty', 'loyaltyObjects'],
    ['customer', 'genericObjects'],
    ['staff', 'genericObjects'],
    ['promo', 'offerObjects'],
  ];
  for (const [kind, key] of cases) {
    const { token } = G.saveUrl({ config, kind, ids: ['3388000000023197382.x'] });
    const claims = jwt.decode(token);
    assert.ok(claims.payload[key], `${kind} should use ${key}, got ${Object.keys(claims.payload)}`);
  }
});

test('a link by object id stays well inside the length browsers truncate at', () => {
  const { token, tooLong, length } = G.saveUrl({
    config,
    kind: 'loyalty',
    ids: ['3388000000023197382.manager-copper-kettle.co.uk-loyalty-cust-1'],
  });
  assert.strictEqual(tooLong, false, `token was ${token.length} characters`);
  assert.ok(length < G.SAFE_JWT_LENGTH, `url was ${length} characters`);
});

test('the inline link works, and says when it has grown too long', () => {
  const built = build('loyalty', {
    id: 'cust-1',
    name: 'Aisha Rahman',
    phone: '07700900123',
    card_number: '999800001',
    points: 1240,
    tier: 'Gold',
    member_since: '2024-03-11',
  });
  const link = G.saveUrl({ config, kind: 'loyalty', klass: built.klass, object: built.object });
  const claims = jwt.verify(link.token, publicKey, { algorithms: ['RS256'] });
  assert.strictEqual(claims.payload.loyaltyObjects.length, 1);
  assert.strictEqual(claims.payload.loyaltyClasses.length, 1);
  // The whole reason the REST path is the default: a full class and object do
  // not fit in a URL a browser will carry intact.
  assert.strictEqual(link.tooLong, true, `inline token was only ${link.token.length} characters`);
});

test('an unconfigured environment cannot produce a save link', () => {
  assert.throws(
    () => G.saveUrl({ config: G.readConfig({}), kind: 'loyalty', ids: ['x'] }),
    (e) => e instanceof G.WalletError && e.status === 503
  );
});

// ---- The REST client, against a stubbed Google ----------------------------

/**
 * A fake walletobjects. Records every call, answers the token endpoint, and
 * 404s any class or object it has not been told about — which is what makes
 * the create-or-update paths observable.
 */
function stubGoogle({ existing = new Set(), failToken = false } = {}) {
  const calls = [];
  async function fakeFetch(url, options = {}) {
    calls.push({ url, method: options.method || 'GET', body: options.body });

    if (url === 'https://oauth2.googleapis.com/token') {
      if (failToken) {
        return {
          ok: false,
          status: 400,
          statusText: 'Bad Request',
          text: async () => '{"error":"invalid_grant","error_description":"Invalid JWT Signature."}',
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ access_token: 'stub-token', expires_in: 3600 }),
      };
    }

    const id = decodeURIComponent(url.split('/').pop().split('?')[0]);
    const known = existing.has(id);
    if ((options.method === 'PUT' || options.method === 'PATCH' || options.method === 'GET') && !known) {
      return {
        ok: false,
        status: 404,
        statusText: 'Not Found',
        text: async () => '{"error":{"code":404,"message":"Resource not found."}}',
      };
    }
    if (options.method === 'POST') existing.add(JSON.parse(options.body).id);
    return { ok: true, status: 200, text: async () => options.body || '{}' };
  }
  return { fakeFetch, calls };
}

testAsync('a missing class is created, an existing one is updated in place', async () => {
  const built = build('loyalty', { id: 'c1', name: 'A' });

  const first = stubGoogle();
  const a = G.makeClient(config, first.fakeFetch);
  await a.upsertClass('loyalty', built.klass);
  const firstMethods = first.calls.filter((c) => c.url.includes('loyaltyClass')).map((c) => c.method);
  assert.deepStrictEqual(firstMethods, ['PUT', 'POST'], 'a new class should fall through to POST');

  const second = stubGoogle({ existing: new Set([built.classId]) });
  const b = G.makeClient(config, second.fakeFetch);
  await b.upsertClass('loyalty', built.klass);
  const secondMethods = second.calls.filter((c) => c.url.includes('loyaltyClass')).map((c) => c.method);
  assert.deepStrictEqual(secondMethods, ['PUT'], 'an existing class should not be re-created');
});

testAsync('an existing object is PATCHed, so a points balance is never rolled back', async () => {
  const built = build('loyalty', { id: 'c1', name: 'A', points: 50 });
  const stub = stubGoogle({ existing: new Set([built.objectId]) });
  const client = G.makeClient(config, stub.fakeFetch);
  await client.upsertObject('loyalty', built.object);
  const methods = stub.calls.filter((c) => c.url.includes('loyaltyObject')).map((c) => c.method);
  assert.deepStrictEqual(methods, ['PATCH']);
});

testAsync('the access token is fetched once and then reused', async () => {
  const stub = stubGoogle();
  const client = G.makeClient(config, stub.fakeFetch);
  const built = build('loyalty', { id: 'c1', name: 'A' });
  await client.upsertClass('loyalty', built.klass);
  await client.upsertObject('loyalty', built.object);
  const tokenCalls = stub.calls.filter((c) => c.url.includes('oauth2.googleapis.com'));
  assert.strictEqual(tokenCalls.length, 1, `token was fetched ${tokenCalls.length} times`);
});

testAsync('the token request is a properly formed jwt-bearer assertion', async () => {
  const stub = stubGoogle();
  const client = G.makeClient(config, stub.fakeFetch);
  await client.accessToken();
  const body = new URLSearchParams(stub.calls[0].body);
  assert.strictEqual(body.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  const assertion = jwt.verify(body.get('assertion'), publicKey, { algorithms: ['RS256'] });
  assert.strictEqual(assertion.scope, 'https://www.googleapis.com/auth/wallet_object.issuer');
  assert.strictEqual(assertion.aud, 'https://oauth2.googleapis.com/token');
  assert.strictEqual(assertion.iss, ENV.GOOGLE_WALLET_SA_EMAIL);
});

testAsync("Google's own words survive to the caller", async () => {
  const stub = stubGoogle({ failToken: true });
  const client = G.makeClient(config, stub.fakeFetch);
  await assert.rejects(
    () => client.accessToken(),
    (e) => {
      // Flattening this to "authentication failed" would throw away the one
      // string that says which of the four possible causes it actually is.
      assert.ok(e.message.includes('Invalid JWT Signature'), e.message);
      return true;
    }
  );
});

testAsync('what is sent to Google carries no undefined keys', async () => {
  const stub = stubGoogle();
  const client = G.makeClient(config, stub.fakeFetch);
  const built = build('loyalty', { id: 'c1', name: 'A' });
  await client.upsertClass('loyalty', built.klass);
  const posted = stub.calls.find((c) => c.method === 'POST' && c.url.includes('loyaltyClass'));
  const sent = JSON.parse(posted.body);
  const walk = (o, path = '') => {
    for (const [k, v] of Object.entries(o)) {
      assert.notStrictEqual(v, undefined, `${path}${k} was sent as undefined`);
      if (v && typeof v === 'object') walk(v, `${path}${k}.`);
    }
  };
  walk(sent);
});

// ---- Wiring ---------------------------------------------------------------

test('the routes module loads and exports what the server mounts', () => {
  const wallet = require('../src/wallet');
  for (const name of ['walletCore', 'walletRoutes', 'walletPublicRoutes']) {
    assert.strictEqual(typeof wallet[name], 'function', `${name} is missing`);
  }
});

// ---- The routes, mounted for real -----------------------------------------

/**
 * A pool stand-in.
 *
 * The wallet routes only ever read; `rows` is keyed by a fragment of the SQL so
 * a test can say what a given lookup finds without a database being involved.
 */
function stubPool(rows = {}) {
  const match = (sql) => {
    const key = Object.keys(rows).find((k) => sql.includes(k));
    return key ? rows[key] : [];
  };
  return {
    query: async (sql) => [match(sql)],
    execute: async (sql) => [match(sql)],
  };
}

testAsync('the QR link refuses a token this server did not sign', async () => {
  const express = require('express');
  const { walletPublicRoutes, walletCore } = require('../src/wallet');
  const secret = 'test-secret';

  const app = express();
  app.use(
    walletPublicRoutes({
      pool: stubPool(),
      secret,
      core: walletCore({ pool: stubPool(), secret }),
    })
  );

  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const forged = jwt.sign({ scope: 'wallet', office: 'a@b.c', kind: 'loyalty', sub: '1' }, 'wrong-secret');
    const bad = await fetch(`${base}/wallet/s/${forged}`, { redirect: 'manual' });
    assert.strictEqual(bad.status, 400, 'a forged token should not mint a pass');
    assert.ok((await bad.text()).includes('expired'));

    // A till token is signed with the same secret but is not a wallet link;
    // without the scope check it would mint passes for any office it named.
    const wrongScope = jwt.sign({ scope: 'terminal', office: 'a@b.c', kind: 'loyalty', sub: '1' }, secret);
    const scoped = await fetch(`${base}/wallet/s/${wrongScope}`, { redirect: 'manual' });
    assert.strictEqual(scoped.status, 400, 'a non-wallet token should be refused');
  } finally {
    server.close();
  }
});

testAsync('the back office is told what is missing instead of being given a 500', async () => {
  const express = require('express');
  const { walletRoutes, walletCore } = require('../src/wallet');
  const secret = 'test-secret';
  const pool = stubPool();

  // No wallet variables in the environment at all — the state every deployment
  // is in before the service-account key arrives.
  const saved = {};
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('GOOGLE_WALLET_')) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  }

  const app = express();
  app.use(express.json());
  app.use(
    '/api',
    walletRoutes({ pool, broadcast: () => {}, secret, core: walletCore({ pool, secret }) })
  );

  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = jwt.sign({ email: 'manager@copper-kettle.co.uk' }, secret);

  try {
    const res = await fetch(`${base}/api/wallet/status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.strictEqual(res.status, 200, 'status must answer even with nothing configured');
    const body = await res.json();
    assert.strictEqual(body.configured, false);
    assert.ok(body.problems.length >= 4, JSON.stringify(body.problems));

    // Minting, on the other hand, must fail loudly and say why.
    const mintRes = await fetch(`${base}/api/wallet/passes/loyalty/cust-1`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.strictEqual(mintRes.status, 503);
    assert.ok((await mintRes.json()).error.includes('ISSUER_ID'));

    const anon = await fetch(`${base}/api/wallet/status`);
    assert.strictEqual(anon.status, 401, 'wallet settings must be behind a session');
  } finally {
    server.close();
    Object.assign(process.env, saved);
  }
});

Promise.all(pending).then(() => {
  console.log(`wallet: ${passed} checks passed${process.exitCode ? ' (with failures above)' : ''}`);
});
