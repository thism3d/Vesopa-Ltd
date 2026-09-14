/**
 * The EPOS client on the live box's real port.
 *
 * The back office listens on 5060, one of the ports fetch() refuses outright
 * ("bad port" -- SIP's). The end-to-end test runs the back office on a random
 * port, so it passed while every call on the live box failed. This one answers
 * on 5060 itself, as the live box does.
 *
 *   node test/epos-port.test.js
 */
const assert = require('assert');
const http = require('http');

const PORT = 5060;
process.env.EPOS_API = `http://127.0.0.1:${PORT}`;
process.env.GIFT_SERVICE_KEY = 'port-test-key-'.padEnd(64, 'x');

async function main() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      if (req.url === '/api/integrations/gift/venues') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ venues: [{ id: 9, name: 'Test' }] }));
      }
      if (req.url.endsWith('/cards')) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'already issued' }));
      }
      res.writeHead(404); res.end();
    });
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(PORT, '127.0.0.1', resolve); });
  } catch (e) {
    if (e.code === 'EADDRINUSE') {
      console.log(`skipped: something on this machine already listens on ${PORT}`);
      return;
    }
    throw e;
  }

  let passed = 0;
  try {
    const epos = require('../src/epos');

    const venues = await epos.venues();
    assert.deepStrictEqual(venues, [{ id: 9, name: 'Test' }]);
    assert.strictEqual(seen[0].auth, `Bearer ${process.env.GIFT_SERVICE_KEY}`);
    console.log('  ok  a GET on port 5060 comes back, carrying the key'); passed++;

    await assert.rejects(epos.issueCard(9, { amount_minor: 100 }), (e) => e.status === 409 && e.message === 'already issued');
    assert.strictEqual(JSON.parse(seen[1].body).amount_minor, 100);
    console.log('  ok  a POST sends its body, and an error answer keeps its status and words'); passed++;

    // And why the client cannot simply be fetch():
    await assert.rejects(fetch(`http://127.0.0.1:${PORT}/`), (e) => /bad port/i.test(String(e.cause && e.cause.message)) || /fetch failed/.test(e.message));
    console.log('  ok  fetch() itself still refuses this port'); passed++;
  } finally {
    server.close();
  }
  console.log(`\n${passed} passed, 0 failed`);
}

main().catch((e) => { console.error('not ok', e); process.exitCode = 1; });
