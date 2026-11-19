/**
 * The club's app opens its members' site (owner, 2026-11-19: deep links,
 * "the members' site and /app"): each venue host names its own club's app in
 * apple-app-site-association (applinks) and every club app in assetlinks.json,
 * with Pontardawe RFC's known fingerprints built in and the others from
 * LOYALTY_ANDROID_APPS.
 *
 *   node test/loyalty-app-links.test.js
 */
process.env.LOYALTY_HOST = 'loyalty.vesopa.com';
process.env.LOYALTY_VENUE_HOSTS = 'member.pontardawerfc.com=pontardawe-rfc,member.loughorrfc.site=loughor-rfc';
process.env.APNS_TOPICS = 'pontardawe-rfc=com.vesopaepos.pontardawerfc,loughor-rfc=com.vesopaepos.loughorrfc';
const LOUGHOR = '11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00';
process.env.LOYALTY_ANDROID_APPS = `com.vesopaepos.loughorrfc=${LOUGHOR.toLowerCase()},com.vesopaepos.loughorrfc=not-a-print`;

const test = require('node:test');
const assert = require('node:assert/strict');
const { loyaltyHostGate } = require('../src/loyalty_host');

const gate = loyaltyHostGate();

function get(host, url) {
  let sent = null;
  const res = { set() { return this; }, type() { return this; }, status() { return this; }, send(b) { sent = b; return this; } };
  gate({ url, headers: { host } }, res, () => {});
  return sent && JSON.parse(sent);
}

test("each members' site opens its own club's app, and only that one", () => {
  const loughor = get('member.loughorrfc.site', '/.well-known/apple-app-site-association');
  assert.deepEqual(loughor.applinks.details[0].appIDs, ['G238FR2ZC9.com.vesopaepos.loughorrfc']);
  assert.equal(loughor.applinks.details[0].components[0]['/'], '/*');
  assert.ok(loughor.webcredentials.apps.length, 'passkeys still named');
  const ponty = get('member.pontardawerfc.com', '/.well-known/apple-app-site-association');
  assert.deepEqual(ponty.applinks.details[0].appIDs, ['G238FR2ZC9.com.vesopaepos.pontardawerfc']);
});

test('the shared loyalty address opens no club app', () => {
  const shared = get('loyalty.vesopa.com', '/.well-known/apple-app-site-association');
  assert.equal(shared.applinks, undefined);
});

test("Android: Pontardawe's four fingerprints built in, Loughor's from the server's settings, bad ones dropped", () => {
  const links = get('member.loughorrfc.site', '/.well-known/assetlinks.json');
  const by = Object.fromEntries(links.map((l) => [l.target.package_name, l]));
  assert.equal(by['com.vesopaepos.pontardawerfc'].target.sha256_cert_fingerprints.length, 4);
  assert.deepEqual(by['com.vesopaepos.loughorrfc'].target.sha256_cert_fingerprints, [LOUGHOR]);
  assert.ok(by['com.vesopaepos.loughorrfc'].relation.includes('delegate_permission/common.handle_all_urls'));
});
