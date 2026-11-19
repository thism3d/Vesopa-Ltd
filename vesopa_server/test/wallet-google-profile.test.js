/**
 * A venue's own Google Wallet profile (owner, 2026-11-19, Loughor RFC): the
 * club's class ids, image/text modules, messages, links, homepage, place,
 * Smart Tap ("hold near reader"), discovery and Google's save/delete
 * callbacks, which are checked against Google's signatures.
 *
 *   node --test test/wallet-google-profile.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const G = require('../src/wallet_google');
const { lookFor } = require('../src/venue_looks');

const { privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const config = G.readConfig({
  GOOGLE_WALLET_ISSUER_ID: '3388000000023197382',
  GOOGLE_WALLET_SA_EMAIL: 'wallet@example.iam.gserviceaccount.com',
  GOOGLE_WALLET_SA_KEY: privateKey,
  GOOGLE_WALLET_ORIGINS: 'https://backoffice.vesopaepos.com',
});
const loughor = lookFor('loughor-rfc');
const brand = { issuer_name: 'Loughor RFC', program_name: 'Loughor RFC Members', homepage_url: 'https://loughorrfc.site', support_phone: '01792 894109', google: loughor.google };

test("Loughor's classes have the club's own ids, one card per member", () => {
  const l = G.buildPass({ kind: 'loyalty', config, office: 'info@loughorrfc.site', brand, subject: { id: 'm1', card_number: '999800001', name: 'A Member', points: 20 } });
  assert.equal(l.classId, '3388000000023197382.com.loughorrfc.loyalty');
  assert.ok(l.objectId.startsWith('3388000000023197382.com.loughorrfc.loyalty.'));
  const c = G.buildPass({ kind: 'customer', config, office: 'info@loughorrfc.site', brand, subject: { id: 'm1' } });
  assert.equal(c.classId, '3388000000023197382.com.loughorrfc.customers');
  for (const k of [l.klass, c.klass]) assert.equal(k.multipleDevicesAndHoldersAllowedStatus, 'MULTIPLE_HOLDERS');
});

test('the loyalty class is filled in: modules, links, homepage, place, Smart Tap, callbacks, discovery', () => {
  const { klass, object } = G.buildPass({ kind: 'loyalty', config, office: 'x', brand, subject: { id: 'm1', card_number: '999800001' } });
  assert.ok(klass.imageModulesData[0].mainImage.sourceUri.uri.endsWith('wallet-banner.png'));
  assert.ok(klass.wideProgramLogo.sourceUri.uri.endsWith('wallet-wordmark.png'));
  assert.ok(klass.textModulesData.length >= 3);
  assert.equal(klass.messages[0].messageType, 'TEXT');
  assert.deepEqual(klass.linksModuleData.uris.map((u) => u.uri), ['https://loughorrfc.com', 'https://vesopaepos.com', 'tel:01792 894109']);
  assert.equal(klass.homepageUri.uri, 'https://loughorrfc.com');
  assert.deepEqual(klass.locations, [{ latitude: 51.6627, longitude: -4.0655 }]);
  assert.equal(klass.enableSmartTap, true);
  assert.deepEqual(klass.redemptionIssuers, ['3388000000023197382']);
  assert.equal(klass.callbackOptions.url, 'https://backoffice.vesopaepos.com/wallet/google/callback');
  assert.equal(klass.discoverableProgram.state, 'TRUSTED_TESTERS');
  assert.equal(klass.accountIdLabel, 'Card number');
  // The reader gets what the QR code carries.
  assert.equal(object.smartTapRedemptionValue, '999800001');
});

test('a venue without a profile is built exactly as before', () => {
  const { klass, object, classId } = G.buildPass({ kind: 'loyalty', config, office: 'x@y.z', brand: { issuer_name: 'Cafe' }, subject: { id: 'm1' } });
  assert.ok(!classId.includes('com.'));
  for (const f of ['enableSmartTap', 'redemptionIssuers', 'callbackOptions', 'discoverableProgram', 'imageModulesData']) assert.equal(klass[f], undefined, f);
  assert.equal(object.smartTapRedemptionValue, undefined);
});

test('Google refusing Smart Tap (no collector key yet) does not stop the class', async () => {
  const { klass } = G.buildPass({ kind: 'loyalty', config, office: 'x', brand, subject: { id: 'template' } });
  const sent = [];
  const fetchImpl = async (url, opts = {}) => {
    if (url.includes('oauth2')) return { ok: true, status: 200, text: async () => '{"access_token":"t","expires_in":3600}' };
    const body = opts.body ? JSON.parse(opts.body) : {};
    sent.push(body);
    if (body.enableSmartTap) return { ok: false, status: 400, statusText: 'Bad Request', text: async () => '{"error":{"code":400,"message":"Smart Tap is not set up"}}' };
    return { ok: true, status: 200, text: async () => opts.body };
  };
  const saved = await G.makeClient(config, fetchImpl).upsertClass('loyalty', klass);
  assert.ok(saved.droppedFields.includes('enableSmartTap'));
  assert.equal(sent.at(-1).enableSmartTap, undefined);
  assert.equal(sent.at(-1).id, klass.id);
});

// ---- Google's callbacks ----------------------------------------------------

function ecKeys() {
  const { publicKey, privateKey: pk } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { pub: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), pk };
}
const sign = (pk, data) => crypto.sign('sha256', data, { key: pk, dsaEncoding: 'der' }).toString('base64');

function callback({ issuerId = '3388000000023197382', now = Date.now(), rootPk, interExp = now + 3600e3, msgExp = now + 60e3 }) {
  const inter = ecKeys();
  const signedKey = JSON.stringify({ keyValue: inter.pub, keyExpiration: String(interExp) });
  const signedMessage = JSON.stringify({ classId: 'c', objectId: 'o', expTimeMillis: msgExp, eventType: 'save', nonce: 'n1' });
  return JSON.stringify({
    protocolVersion: 'ECv2SigningOnly',
    intermediateSigningKey: { signedKey, signatures: [sign(rootPk, G.lengthPrefixed('GooglePayPasses', 'ECv2SigningOnly', signedKey))] },
    signedMessage,
    signature: sign(inter.pk, G.lengthPrefixed('GooglePayPasses', issuerId, 'ECv2SigningOnly', signedMessage)),
  });
}

test("a callback signed by Google for this issuer is read; anything else is refused", () => {
  const root = ecKeys();
  const rootKeys = [{ keyValue: root.pub, protocolVersion: 'ECv2SigningOnly' }];
  const issuerId = '3388000000023197382';
  const msg = G.verifyCallback(callback({ rootPk: root.pk }), { issuerId, rootKeys });
  assert.equal(msg.eventType, 'save');
  assert.equal(msg.objectId, 'o');

  const other = ecKeys();
  assert.throws(() => G.verifyCallback(callback({ rootPk: other.pk }), { issuerId, rootKeys }), /not signed by Google/);
  assert.throws(() => G.verifyCallback(callback({ rootPk: root.pk, issuerId: '1' }), { issuerId, rootKeys }), /for this issuer/);
  assert.throws(() => G.verifyCallback(callback({ rootPk: root.pk, interExp: Date.now() - 1 }), { issuerId, rootKeys }), /expired/);
  assert.throws(() => G.verifyCallback(callback({ rootPk: root.pk, msgExp: Date.now() - 1 }), { issuerId, rootKeys }), /expired/);
  assert.throws(() => G.verifyCallback('nonsense', { issuerId, rootKeys }), /not JSON/);
});

// ---- Apple Wallet: hold near reader ---------------------------------------

test('Apple membership and loyalty cards carry NFC only once the reader key is set', () => {
  const A = require('../src/wallet_apple');
  const pass = (env, kind) => A.buildPassJson({ kind, config: { ...A.readConfig(env), teamId: 'T' }, brand: {}, subject: { id: 'm1', card_number: '999800001' }, serial: 's', authToken: 'a' });
  assert.equal(pass({}, 'loyalty').nfc, undefined, 'off without an NFC certificate and key');
  const on = { APPLE_WALLET_NFC_KEY: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE' };
  assert.deepEqual(pass(on, 'loyalty').nfc, { message: '999800001', encryptionPublicKey: on.APPLE_WALLET_NFC_KEY, requiresAuthentication: false });
  assert.equal(pass(on, 'customer').nfc.message, '999800001');
  assert.equal(pass(on, 'giftcard').nfc, undefined);
});

test('only the extra Google refuses is dropped; the others stay on the class', async () => {
  const { klass } = G.buildPass({ kind: 'loyalty', config, office: 'x', brand, subject: { id: 'template' } });
  const sent = [];
  const fetchImpl = async (url, opts = {}) => {
    if (url.includes('oauth2')) return { ok: true, status: 200, text: async () => '{"access_token":"t","expires_in":3600}' };
    const body = opts.body ? JSON.parse(opts.body) : {};
    sent.push(body);
    if (body.discoverableProgram) return { ok: false, status: 400, statusText: 'Bad Request', text: async () => '{"error":{"code":400,"message":"Request contains an invalid argument."}}' };
    return { ok: true, status: 200, text: async () => opts.body };
  };
  const saved = await G.makeClient(config, fetchImpl).upsertClass('loyalty', klass);
  assert.deepEqual(saved.droppedFields, ['discoverableProgram']);
  const last = sent.filter((b) => !b.discoverableProgram).at(-1);
  assert.equal(last.enableSmartTap, true);
  assert.ok(last.callbackOptions.url);
});
