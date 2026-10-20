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

console.log(`barclaycard: ${n} checks passed`);
