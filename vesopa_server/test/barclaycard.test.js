// Barclaycard Smartpay Fuse request signing (HTTP Signature, HmacSHA256).
const assert = require('assert');
const crypto = require('crypto');
const bc = require('../src/barclaycard_client');

const secret = Buffer.from('test-secret-for-signing').toString('base64');
const creds = { env: 'sandbox', merchantId: 'm_1', keyId: 'k_1', secret };
let n = 0;

const body = JSON.stringify({ a: 1 });
const h = bc.signedHeaders(creds, 'POST', '/pts/v2/payments', body);
assert.strictEqual(h.host, 'api.smartpayfuse-test.barclaycard'); n++;
assert.strictEqual(h['v-c-merchant-id'], 'm_1'); n++;
assert.strictEqual(h.digest, 'SHA-256=' + crypto.createHash('sha256').update(body).digest('base64')); n++;
const m = /keyid="k_1", algorithm="HmacSHA256", headers="host date \(request-target\) digest v-c-merchant-id", signature="([^"]+)"/.exec(h.signature);
assert.ok(m, h.signature); n++;
const expected = crypto.createHmac('sha256', Buffer.from(secret, 'base64')).update(
  `host: ${h.host}\ndate: ${h.date}\n(request-target): post /pts/v2/payments\ndigest: ${h.digest}\nv-c-merchant-id: m_1`
).digest('base64');
assert.strictEqual(m[1], expected); n++;

const g = bc.signedHeaders({ ...creds, env: 'live' }, 'GET', '/tss/v2/transactions/1', null);
assert.strictEqual(g.host, 'api.smartpayfuse.barclaycard'); n++;
assert.ok(!g.digest); n++;
assert.ok(g.signature.includes('headers="host date (request-target) v-c-merchant-id"')); n++;

assert.ok(bc.approved({ status: 'AUTHORIZED' })); n++;
assert.ok(!bc.approved({ status: 'DECLINED' })); n++;

// M05 outcomes.
const o51 = bc.outcomeOf({ status: 'DECLINED', processorInformation: { responseCode: '51' } });
assert.ok(!o51.approved && /not enough funds/.test(o51.message)); n++;
const o65 = bc.outcomeOf({ status: 'DECLINED', processorInformation: { responseCode: '65' }, errorInformation: { reason: 'CUSTOMER_AUTHENTICATION_REQUIRED' } });
assert.ok(/check it is you/.test(o65.message)); n++;
const soft = bc.outcomeOf({ status: 'AUTHORIZED_PENDING_REVIEW', processorInformation: { cardVerification: { resultCode: 'N' } } });
assert.ok(soft.soft && /security code/.test(soft.message)); n++;
const cvnN = bc.outcomeOf({ status: 'AUTHORIZED', processorInformation: { responseCode: '0', cardVerification: { resultCode: 'N' } } });
assert.ok(!cvnN.approved && cvnN.soft); n++;
const avsN = bc.outcomeOf({ status: 'AUTHORIZED', processorInformation: { responseCode: '0', avs: { code: 'N' } } });
assert.ok(avsN.approved); n++;
assert.strictEqual(bc.outcomeOf({ status: 'INVALID_REQUEST', reason: 'INVALID_DATA' }).retry, 'fix'); n++;
// The card form's answer points at a transaction; the record decides.
assert.strictEqual(bc.transactionIdIn('7925373592286909204806'), '7925373592286909204806'); n++;
const jwtLike = 'h.' + Buffer.from(JSON.stringify({ outcome: { id: '7925373592286909204806', status: 'AUTHORIZED' } })).toString('base64url') + '.s';
assert.strictEqual(bc.transactionIdIn(jwtLike), '7925373592286909204806'); n++;
const rec = bc.detailsOutcome({
  applicationInformation: { applications: [{ name: 'ics_auth', rCode: '1' }, { name: 'ics_bill', rCode: '1' }] },
  orderInformation: { amountDetails: { totalAmount: '6.50' } }, clientReferenceInformation: { code: 'menu-58' },
  paymentInformation: { card: { suffix: '1111', type: '001' } }, processorInformation: { approvalCode: '831000' },
});
assert.ok(rec.approved && rec.amountMinor === 650 && rec.reference === 'menu-58' && rec.cardLast4 === '1111'); n++;
const unpaid = bc.detailsOutcome({ applicationInformation: { applications: [{ name: 'ics_auth', rCode: '0' }] }, processorInformation: { responseCode: '05' } });
assert.ok(!unpaid.approved); n++;

console.log(`barclaycard: ${n} checks passed`);
