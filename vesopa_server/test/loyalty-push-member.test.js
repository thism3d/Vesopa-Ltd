/**
 * Notifications about a member's own card, and the club's look on its Wallet
 * card.
 *
 *   1. The APNs key from .env is read with its \n line breaks turned back
 *      into real ones; a key that is not, never signs anything.
 *   2. A server that only sends for venue apps (APNS_TOPICS) needs no
 *      APNS_TOPIC.
 *   3. FCM's 400 for a bad message does not switch a member's phone off.
 *   4. Points and membership changes have words, and nothing is said for a
 *      movement of nothing.
 *   5. notifyMember tells only that member's devices, never throws, and leaves
 *      an iPhone alone when its Wallet card has already said it.
 *   6. A venue with a look gets its crest and band on the pass, and the
 *      membership date is on the front.
 */
const assert = require('assert');
const crypto = require('crypto');
const path = require('path');

for (const k of ['APNS_KEY_PATH', 'APNS_TOPIC', 'APNS_TOPICS', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY',
  'FCM_PROJECT_ID', 'FCM_CLIENT_EMAIL', 'FCM_PRIVATE_KEY']) delete process.env[k];

const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
process.env.APNS_PRIVATE_KEY = pem.trim().split('\n').join('\\n');
process.env.APNS_KEY_ID = 'ABC123DEFG';
process.env.APNS_TEAM_ID = 'G238FR2ZC9';

const push = require('../src/loyalty_push');
const A = require('../src/wallet_apple');

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}

(async () => {
  await check('the key from .env has real line breaks again', () => {
    process.env.APNS_TOPIC = 'com.vesopaepos.thevesopakitchen';
    const creds = push.apnsCreds();
    assert.ok(creds, 'configured');
    assert.ok(creds.privateKey.includes('\n-----END') || creds.privateKey.split('\n').length > 2);
    // And it signs, which is the whole point.
    crypto.createPrivateKey(creds.privateKey);
  });

  await check('APNS_TOPICS alone is enough', () => {
    delete process.env.APNS_TOPIC;
    assert.strictEqual(push.apnsCreds(), null, 'neither topic: not configured');
    process.env.APNS_TOPICS = 'pontardawe-rfc=com.vesopaepos.pontardawerfc';
    assert.ok(push.apnsCreds(), 'venue apps only: configured');
    assert.deepStrictEqual(push.apnsTopics('pontardawe-rfc', ''), ['com.vesopaepos.pontardawerfc']);
    assert.deepStrictEqual(push.apnsTopics('elsewhere', ''), []);
  });

  await check('FCM: only a dead token is "gone"', async () => {
    const res = (status, body) => ({ status, text: async () => body });
    assert.strictEqual(await push.fcmTokenGone(res(404, '')), true);
    assert.strictEqual(await push.fcmTokenGone(res(400, '{"error":{"details":[{"errorCode":"UNREGISTERED"}]}}')), true);
    assert.strictEqual(await push.fcmTokenGone(res(400, '{"error":{"message":"The registration token is not a valid FCM registration token"}}')), true);
    assert.strictEqual(await push.fcmTokenGone(res(400, '{"error":{"message":"Invalid value at message.android.notification.image"}}')), false);
    assert.strictEqual(await push.fcmTokenGone(res(500, '')), false);
  });

  await check('the words for points and memberships', () => {
    assert.deepStrictEqual(push.pointsMessage({ kind: 'earn', points: 12, balance: 252 }),
      { title: '+12 points', body: 'Thanks for coming in. You now have 252 points.' });
    assert.strictEqual(push.pointsMessage({ kind: 'redeem', points: -100, balance: 1 }).body, 'Enjoy. You have 1 point left.');
    assert.strictEqual(push.pointsMessage({ kind: 'earn', points: 0, balance: 5 }), null);
    assert.strictEqual(push.pointsMessage({ kind: 'adjust', points: 5, balance: 5 }), null);
    const renew = push.membershipMessage({ kind: 'renew', plan: 'Social', after: '2027-10-12' });
    assert.strictEqual(renew.body, 'Thanks for renewing your Social membership. It runs to 12 October 2027.');
    assert.strictEqual(push.membershipMessage({ kind: 'leave' }), null);
  });

  await check('notifyMember: that member only, Wallet iPhones skipped, never throws', async () => {
    const asked = [];
    const updated = [];
    const pool = {
      async query(sql, params) {
        asked.push([sql, params]);
        if (/FROM epos_loyalty_app/.test(sql)) return [[{ slug: 'pontardawe-rfc' }]];
        if (/FROM epos_push_channels/.test(sql)) {
          assert.deepStrictEqual(params, ['office@club', 'cust-1']);
          return [[
            { id: 'c1', kind: 'apns', endpoint: 'ab'.repeat(32) },
            { id: 'c2', kind: 'webpush', endpoint: 'https://fcm.googleapis.com/x' },
          ]];
        }
        if (/epos_wallet_devices/.test(sql)) return [[{ yes: 1 }]];
        return [[]];
      },
      async execute(sql, params) { updated.push([sql, params]); return [{}]; },
    };
    // No VAPID keys here, so the browser channel fails without the network.
    const r = await push.notifyMember({ pool, office: 'office@club', customerId: 'cust-1', title: 't', body: 'b', walletCovers: true });
    assert.deepStrictEqual(r, { sent: 0, failed: 1 }, 'the iPhone was skipped, the browser tried');

    const broken = { query: async () => { throw new Error('gone away'); }, execute: async () => [{}] };
    assert.deepStrictEqual(await push.notifyMember({ pool: broken, office: 'o', customerId: 'c', title: 't', body: 'b' }), { sent: 0, failed: 0 });
  });

  await check("a look's crest, band and icon on the pass", () => {
    const assetsDir = path.join(__dirname, '..', 'assets', 'wallet');
    const fs = require('fs');
    const lookDir = path.join(assetsDir, 'looks', 'pontardawe-rfc');
    const plain = A.artworkFor('loyalty', { hex_background: '#8F0000' }, assetsDir, 0.5);
    const club = A.artworkFor('loyalty', { hex_background: '#8F0000', look_art: 'pontardawe-rfc' }, assetsDir, 0.5);
    assert.ok(club['logo@2x.png'].equals(fs.readFileSync(path.join(lookDir, 'logo@2x.png'))), 'the crest');
    assert.ok(club['strip@2x.png'].equals(fs.readFileSync(path.join(lookDir, 'strip@2x.png'))), 'the club band, not the progress band');
    assert.ok(club['icon.png'].equals(fs.readFileSync(path.join(lookDir, 'icon.png'))), 'the crest as the icon');
    assert.ok(!plain['logo@2x.png'].equals(club['logo@2x.png']), 'nobody else gets it');
    const odd = A.artworkFor('loyalty', { look_art: '../../etc' }, assetsDir, 0.5);
    assert.ok(odd['logo.png'].equals(plain['logo.png']), 'a slug that is not one reads nothing');
  });

  await check('the membership date on the front of the card', () => {
    const pass = A.buildPassJson({
      kind: 'loyalty',
      config: { teamId: 'G238FR2ZC9', featuredActions: false },
      brand: { issuer_name: 'Pontardawe RFC', hex_background: '#8F0000' },
      subject: { id: 'c', name: 'Alex Morgan', card_number: '999800001', points: 240, membership_until: '2027-08-31' },
      serial: 's', authToken: 't',
    });
    const body = pass.eventTicket || pass.storeCard || Object.values(pass).find((v) => v && v.auxiliaryFields);
    const until = body.auxiliaryFields.find((f) => f.key === 'until');
    assert.strictEqual(until.value, '31 Aug 2027');
    assert.strictEqual(pass.expirationDate, undefined, 'a membership date never voids the card');
    assert.strictEqual(pass.barcodes[0].message, '999800001', 'the same code as the app');
  });

  console.log(`loyalty-push-member: ${passed} checks passed`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
