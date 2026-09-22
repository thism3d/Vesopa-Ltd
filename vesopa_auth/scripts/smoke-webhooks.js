/**
 * Webhooks, end to end: queued, signed, delivered, retried, replayed.
 *
 *     node scripts/smoke-webhooks.js
 *
 * HOW THE RECEIVER WORKS, because it is the one thing here that is not
 * production-shaped. The test starts a small HTTP listener on the loopback
 * address and inserts an endpoint row pointing at it — deliberately going round
 * `checkUrl`, which would refuse a private address and is right to.
 *
 * That is a considered split, not a hole. `checkUrl` is the security control
 * and it is tested directly, as a pure function, including every address range
 * it must refuse. What the listener proves is the part that cannot be tested
 * any other way: that a real HTTP request goes out, carrying a signature a
 * developer's code can actually verify, and that failure, backoff and replay
 * behave. Depending on somebody else's public endpoint for that would make this
 * test fail on a day their site is down.
 */

const http = require('http');
const crypto = require('crypto');

const db = require('../src/db');
const config = require('../src/config');
const webhooks = require('../src/webhooks');
const { newId, encrypt } = require('../src/crypto');

let passed = 0;
let failed = 0;

function check(label, condition, detail = '') {
  console.log(`  ${condition ? '✓' : '✗'} ${label}${condition ? '' : ` — ${detail}`}`);
  if (condition) passed += 1;
  else failed += 1;
}

/** A receiver that records what arrives and answers however we tell it to. */
function receiver() {
  const received = [];
  let reply = { status: 200, body: 'ok' };

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      received.push({ headers: req.headers, body, method: req.method });
      res.writeHead(reply.status, { 'content-type': 'text/plain' });
      res.end(reply.body);
    });
  });

  return {
    received,
    listen: () =>
      new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
      }),
    answer: (status, body = '') => {
      reply = { status, body };
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function main() {
  const application = await db.one("SELECT * FROM applications WHERE slug = 'smoke-test'");
  if (!application) {
    console.error('The smoke-test application is missing — run scripts/smoke-oidc.js first.');
    process.exit(1);
  }

  // ---------------------------------------------------------------------
  console.log('▶ where an endpoint may point');

  const refusals = [
    ['http://example.com/hook', 'http is refused'],
    ['https://127.0.0.1/hook', 'loopback is refused'],
    ['https://10.0.0.5/hook', 'a private range is refused'],
    ['https://169.254.169.254/latest/meta-data/', 'the cloud metadata address is refused'],
    ['https://192.168.1.10/hook', 'a home network address is refused'],
    ['https://localhost/hook', 'localhost is refused'],
    ['https://user:pass@example.com/hook', 'credentials in the URL are refused'],
    ['not a url at all', 'rubbish is refused'],
  ];
  for (const [url, label] of refusals) {
    // eslint-disable-next-line no-await-in-loop
    const result = await webhooks.checkUrl(url);
    check(label, result.ok === false, `it was accepted: ${url}`);
  }
  const good = await webhooks.checkUrl('https://auth.vesopa.com/hook');
  check('a real public https URL is accepted', good.ok === true, good.error);

  // The IPv4-in-IPv6 form is the one people forget.
  check(
    'an IPv4 address wearing an IPv6 hat is still private',
    webhooks.isPrivateAddress('::ffff:127.0.0.1') === true,
  );

  // ---------------------------------------------------------------------
  console.log('▶ signing');

  const signature = webhooks.sign('whsec_test', 1757370000, '{"a":1}');
  const expected = crypto
    .createHmac('sha256', 'whsec_test')
    .update('1757370000.{"a":1}')
    .digest('hex');
  check('the signature covers the timestamp AND the body', signature === `t=1757370000,v1=${expected}`);
  check(
    'a different timestamp gives a different signature',
    webhooks.sign('whsec_test', 1757370001, '{"a":1}') !== signature,
    'a captured delivery could be replayed tomorrow',
  );

  // ---------------------------------------------------------------------
  console.log('▶ delivery');

  const hook = receiver();
  const port = await hook.listen();
  const secret = `whsec_${newId()}`;
  const publicId = newId();

  const inserted = await db.execute(
    `INSERT INTO webhook_endpoints
       (public_id, application_id, url, description, secret_cipher, secret_hint)
     VALUES (?, ?, ?, 'smoke test', ?, ?)`,
    [
      publicId,
      application.id,
      `http://127.0.0.1:${port}/hook`,
      encrypt(secret, config.secrets.encryptionKey),
      secret.slice(-6),
    ],
  );
  const endpointId = inserted.insertId;
  await db.execute(
    "INSERT IGNORE INTO webhook_endpoint_events (endpoint_id, event_type) VALUES (?, 'user.updated')",
    [endpointId],
  );

  const eventId = await webhooks.emit(application.id, 'user.updated', {
    subject: 'smoke-subject',
    payload: { sub: 'smoke-subject', name: 'Smoke Test' },
  });
  check('the event was queued', Boolean(eventId));

  await webhooks.drain();
  // The nudge inside emit() may already have sent it; give both a moment.
  await new Promise((resolve) => setTimeout(resolve, 500));

  check('the endpoint received exactly one request', hook.received.length === 1, `got ${hook.received.length}`);

  if (hook.received.length) {
    const request = hook.received[0];
    check('it was a POST', request.method === 'POST');
    check('it says which event', request.headers['vesopa-event'] === 'user.updated');
    check('it carries an event id to key on', Boolean(request.headers['vesopa-event-id']));

    const header = request.headers['vesopa-signature'] || '';
    const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')));
    const mine = crypto
      .createHmac('sha256', secret)
      .update(`${parts.t}.${request.body}`)
      .digest('hex');
    check('the signature verifies with the endpoint secret', mine === parts.v1, header);
    check(
      'the timestamp is recent',
      Math.abs(Date.now() / 1000 - Number(parts.t)) < 120,
      `t=${parts.t}`,
    );

    const body = JSON.parse(request.body);
    check('the body carries the event id, type and data', Boolean(body.id && body.type && body.data));
    check('and the payload we emitted', body.data.name === 'Smoke Test');
  }

  const delivered = await db.one(
    "SELECT status, attempt FROM webhook_deliveries WHERE endpoint_id = ? ORDER BY id DESC LIMIT 1",
    [endpointId],
  );
  check('it is recorded as delivered', delivered.status === 'delivered', delivered.status);

  // ---------------------------------------------------------------------
  console.log('▶ failure and backoff');

  hook.answer(500, 'nope');
  await webhooks.emit(application.id, 'user.updated', { subject: 's', payload: { sub: 's' } });
  await webhooks.drain();
  await new Promise((resolve) => setTimeout(resolve, 400));

  const failedRow = await db.one(
    'SELECT * FROM webhook_deliveries WHERE endpoint_id = ? ORDER BY id DESC LIMIT 1',
    [endpointId],
  );
  check('a 500 is not treated as success', failedRow.status === 'pending', failedRow.status);
  check('the response code is recorded', failedRow.response_code === 500);
  check('what the endpoint said is kept', failedRow.response_body.includes('nope'));
  check('it is scheduled to try again', Boolean(failedRow.next_attempt_at));
  check('and not immediately', new Date(failedRow.next_attempt_at) > new Date(), failedRow.next_attempt_at);

  // ---------------------------------------------------------------------
  console.log('▶ replay');

  hook.answer(200, 'ok');
  const before = hook.received.length;
  await webhooks.replay(failedRow.id);
  await new Promise((resolve) => setTimeout(resolve, 600));

  check('a replay sends the event again', hook.received.length > before, 'nothing arrived');
  const replayed = await db.one(
    'SELECT * FROM webhook_deliveries WHERE replay_of = ? ORDER BY id DESC LIMIT 1',
    [failedRow.id],
  );
  check('and is recorded as a replay of the original', Boolean(replayed), 'no replay row');
  if (replayed && hook.received.length > before) {
    const again = JSON.parse(hook.received[hook.received.length - 1].body);
    /*
     * The replay must carry the ORIGINAL event id, not a fresh one.
     *
     * It is the whole point of keeping events and deliveries in separate
     * tables: a developer de-duplicates on the event id, so a replay that
     * invented a new one would be processed twice by a correctly written
     * handler — which is the opposite of what a replay is for.
     *
     * `payload` is a JSON column and mysql2 hands it back already parsed, so it
     * is read as an object rather than parsed again.
     */
    const event = await db.one('SELECT public_id, payload FROM webhook_events WHERE id = ?', [
      replayed.event_id,
    ]);
    const stored = typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload;
    check(
      'the replay carries the SAME event id, not a fresh one',
      again.id === stored.id && again.id === event.public_id,
      `sent ${again.id}, stored ${stored.id}`,
    );
  }

  // ---------------------------------------------------------------------
  console.log('▶ nobody is listening');

  const quiet = await webhooks.emit(application.id, 'session.revoked', {
    subject: 's',
    payload: {},
  });
  check(
    'an event with no subscriber is not recorded at all',
    quiet === null,
    'a table would fill with rows nobody will read',
  );

  const unknown = await webhooks.emit(application.id, 'not.a.real.event', {});
  check('an unknown event type is refused', unknown === null);

  // ---------------------------------------------------------------------
  await db.execute('DELETE FROM webhook_endpoints WHERE id = ?', [endpointId]);
  await hook.close();

  console.log(`\n${passed} passed, ${failed} failed`);
  await db.close();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error('webhook smoke test failed:', error);
  try {
    await db.close();
  } catch {
    /* already closed */
  }
  process.exit(1);
});
