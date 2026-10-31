/**
 * Paymentsense Connect from the server, for Vesopa Go (src/connect_client.js):
 * the till's headers, the machine list, a sale followed to its result, and a
 * signature accepted. A fake Connect host; no network.
 */
const assert = require('assert');
const c = require('../src/connect_client');

const conn = { key: 'k-123', baseUrl: 'https://club.connect.paymentsense.cloud/' };
const seen = [];

function fake(routes) {
  return async (url, init) => {
    seen.push({ url, init });
    const path = url.replace('https://club.connect.paymentsense.cloud', '');
    const hit = routes[`${init.method} ${path}`];
    if (!hit) return new Response('{"message":"Not Found"}', { status: 404 });
    return new Response(JSON.stringify(hit.body || {}), { status: hit.status || 200, headers: hit.headers || {} });
  };
}

(async () => {
  // The headers the live account takes: Basic with the key as the password,
  // v2, and the partner ids.
  const h = c.headers('k-123');
  assert.strictEqual(h.Authorization, 'Basic ' + Buffer.from('epos:k-123').toString('base64'));
  assert.strictEqual(h.Accept, 'application/connect.v2+json');
  assert.ok(h['Software-House-Id']);
  assert.ok(h['Installer-Id']);

  const fetchImpl = fake({
    'GET /pac/terminals': { body: { terminals: [{ tid: '22161234', status: 'AVAILABLE', currency: 'GBP' }] } },
    'POST /pac/terminals/22161234/transactions': { status: 201, body: { requestId: 'req-1' } },
    'GET /pac/terminals/22161234/transactions/req-1': { body: { transactionResult: 'SUCCESSFUL', notifications: ['PIN_ENTRY'] } },
  });

  const list = await c.listTerminals(conn, { fetchImpl });
  assert.deepStrictEqual(list, [{ tid: '22161234', status: 'AVAILABLE', currency: 'GBP' }]);
  assert.ok(seen[0].url.startsWith('https://club.connect.paymentsense.cloud/pac/'), 'no double slash after the host');

  const id = await c.start(conn, '22161234', { amountMinor: 450 }, { fetchImpl });
  assert.strictEqual(id, 'req-1');
  assert.deepStrictEqual(JSON.parse(seen[1].init.body), { transactionType: 'SALE', amount: 450, currency: 'GBP' });

  const tx = await c.get(conn, '22161234', 'req-1', { fetchImpl });
  assert.strictEqual(c.state(tx), 'paid');

  // The verdicts.
  assert.strictEqual(c.state({ transactionResult: 'DECLINED' }), 'failed');
  assert.strictEqual(c.state({ transactionResult: 'CANCELLED' }), 'cancelled');
  assert.strictEqual(c.state({ transactionResult: 'TIMED_OUT' }), 'waiting', 'money may have moved: never a decline');
  assert.strictEqual(c.state({ notifications: ['PRESENT_CARD', 'SIGNATURE_VERIFICATION'] }), 'signature');
  assert.strictEqual(c.state({ notifications: ['PRESENT_CARD'] }), 'waiting');

  // A payment's reference round-trips.
  assert.deepStrictEqual(c.parseRef(c.ref('22161234', 'req-1')), { tid: '22161234', requestId: 'req-1' });
  assert.strictEqual(c.parseRef('pi_abc'), null);

  // A refusal carries Connect's words, never the key.
  await assert.rejects(c.start(conn, '999', { amountMinor: 1 }, { fetchImpl }), (e) => e.status === 404 && !String(e.message).includes('k-123'));

  console.log('connect-client.test.js: all passed');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
