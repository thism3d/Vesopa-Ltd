/**
 * Apple Wallet: the update service, and the parts of pushing that can be
 * checked without Apple.
 *
 * A push cannot be tested here — it needs the five `.p12` bundles, which are
 * deliberately not in this repository, and a connection to Apple. What can be
 * tested is everything on our side of that: the protocol iOS speaks to us, and
 * the decisions the push code makes about what it is told.
 *
 * That split is the same one wallet-apple.test.js makes, and for the same
 * reason. Every assertion below is a mistake that would otherwise present as a
 * card that silently stops updating in a stranger's pocket, days later, with no
 * error anywhere — there is no app on that phone to report one.
 */

const assert = require('assert');
const express = require('express');

const P = require('../src/wallet_apple_push');
const A = require('../src/wallet_apple');
const { appleWebServiceRoutes } = require('../src/wallet_apple_webservice');

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${e.message}`);
    process.exitCode = 1;
  }
}

console.log('\nApple Wallet push updates\n');

// ---------------------------------------------------------------------------
// A database that remembers just enough
// ---------------------------------------------------------------------------

const ISSUED = new Date('2026-08-01T10:00:00Z');
const CHANGED = new Date('2026-09-01T12:00:00Z');

function makePool() {
  const state = {
    pass: {
      id: 'p1',
      office: 'venue@example.com',
      kind: 'loyalty',
      subject_id: 'cust-1',
      apple_serial: 'S1',
      apple_auth_token: 'token-abcdefghijklmnop',
      apple_issued_at: ISSUED,
      apple_updated_at: CHANGED,
    },
    devices: [],
    executed: [],
  };

  const pool = {
    async query(sql, params = []) {
      if (sql.includes('apple_auth_token') && sql.includes('WHERE apple_serial')) {
        return [state.pass.apple_serial === params[0] ? [state.pass] : []];
      }
      if (sql.includes('SELECT device_id FROM epos_wallet_devices')) {
        const found = state.devices.find(
          (d) => d.device_id === params[0] && d.serial_number === params[1]
        );
        return [found ? [found] : []];
      }
      if (sql.includes('JOIN epos_wallet_passes')) {
        const rows = state.devices
          .filter((d) => d.device_id === params[0] && d.pass_type_id === params[1])
          .map(() => ({
            serial: state.pass.apple_serial,
            tag: Math.floor(
              new Date(state.pass.apple_updated_at || state.pass.apple_issued_at).getTime() / 1000
            ),
          }));
        return [rows];
      }
      return [[]];
    },
    async execute(sql, params = []) {
      state.executed.push({ sql, params });
      if (sql.includes('INSERT INTO epos_wallet_devices')) {
        const [device_id, serial_number, pass_type_id, push_token, office] = params;
        const existing = state.devices.find(
          (d) => d.device_id === device_id && d.serial_number === serial_number
        );
        if (existing) Object.assign(existing, { push_token, pass_type_id, office });
        else state.devices.push({ device_id, serial_number, pass_type_id, push_token, office });
      }
      if (sql.includes('DELETE FROM epos_wallet_devices')) {
        state.devices = state.devices.filter(
          (d) => !(d.device_id === params[0] && d.serial_number === params[1])
        );
      }
      return [{ affectedRows: 1 }];
    },
    state,
  };
  return pool;
}

/** The router, on a real port, so the assertions are about HTTP and not calls. */
async function withService(pool, fn) {
  const app = express();
  app.use(express.json());
  app.use(
    appleWebServiceRoutes({
      pool,
      config: { teamId: 'G238FR2ZC9' },
      build: async () => ({ bytes: Buffer.from('PK-not-a-real-pass') }),
    })
  );

  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base);
  } finally {
    server.close();
  }
}

const LOYALTY = 'pass.com.vesopa.loyalty';
const AUTH = { Authorization: 'ApplePass token-abcdefghijklmnop' };

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

(async () => {
  await check('a registration with no Authorization header is refused', async () => {
    const pool = makePool();
    await withService(pool, async (base) => {
      const res = await fetch(`${base}/v1/devices/D1/registrations/${LOYALTY}/S1`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pushToken: 'tok' }),
      });
      assert.strictEqual(res.status, 401);
      assert.strictEqual(pool.state.devices.length, 0, 'a device was registered anyway');
    });
  });

  await check('a wrong token is refused', async () => {
    const pool = makePool();
    await withService(pool, async (base) => {
      const res = await fetch(`${base}/v1/devices/D1/registrations/${LOYALTY}/S1`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'ApplePass wrong' },
        body: JSON.stringify({ pushToken: 'tok' }),
      });
      assert.strictEqual(res.status, 401);
    });
  });

  // The check that stops a valid loyalty token authorising a request that
  // claims to be about a gift card. Without it the registration lands under the
  // wrong topic and pushes as TopicDisallowed months later, with nothing to
  // connect the error to the cause.
  await check('a valid token for the wrong pass type is refused', async () => {
    const pool = makePool();
    await withService(pool, async (base) => {
      const res = await fetch(
        `${base}/v1/devices/D1/registrations/pass.com.vesopa.giftcard/S1`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: JSON.stringify({ pushToken: 'tok' }),
        }
      );
      assert.strictEqual(res.status, 401);
      assert.strictEqual(pool.state.devices.length, 0);
    });
  });

  // ---------------------------------------------------------------------------
  // Registering
  // ---------------------------------------------------------------------------

  await check('registering is 201 the first time and 200 on a repeat', async () => {
    const pool = makePool();
    await withService(pool, async (base) => {
      const send = () =>
        fetch(`${base}/v1/devices/D1/registrations/${LOYALTY}/S1`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: JSON.stringify({ pushToken: 'push-token-1' }),
        });

      const first = await send();
      assert.strictEqual(first.status, 201, 'a new device should be 201');

      const again = await send();
      assert.strictEqual(again.status, 200, 'a known device should be 200, not an error');
      assert.strictEqual(pool.state.devices.length, 1, 'the device was recorded twice');
    });
  });

  // iOS re-registers with a new token after a restore or an OS upgrade. Keeping
  // the old one is a card that silently stops updating.
  await check('re-registering overwrites the push token', async () => {
    const pool = makePool();
    await withService(pool, async (base) => {
      for (const token of ['first-token', 'second-token']) {
        await fetch(`${base}/v1/devices/D1/registrations/${LOYALTY}/S1`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: JSON.stringify({ pushToken: token }),
        });
      }
      assert.strictEqual(pool.state.devices[0].push_token, 'second-token');
    });
  });

  await check('unregistering forgets the device', async () => {
    const pool = makePool();
    await withService(pool, async (base) => {
      await fetch(`${base}/v1/devices/D1/registrations/${LOYALTY}/S1`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...AUTH },
        body: JSON.stringify({ pushToken: 'tok' }),
      });
      const res = await fetch(`${base}/v1/devices/D1/registrations/${LOYALTY}/S1`, {
        method: 'DELETE',
        headers: AUTH,
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(pool.state.devices.length, 0, 'the row survived an unregister');
    });
  });

  // ---------------------------------------------------------------------------
  // What changed
  // ---------------------------------------------------------------------------

  const tag = Math.floor(CHANGED.getTime() / 1000);

  await check('a device that is up to date is told 204, with no body', async () => {
    const pool = makePool();
    await withService(pool, async (base) => {
      await fetch(`${base}/v1/devices/D1/registrations/${LOYALTY}/S1`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...AUTH },
        body: JSON.stringify({ pushToken: 'tok' }),
      });
      const res = await fetch(
        `${base}/v1/devices/D1/registrations/${LOYALTY}?passesUpdatedSince=${tag}`
      );
      assert.strictEqual(res.status, 204);
      assert.strictEqual(await res.text(), '', '204 must carry nothing');
    });
  });

  await check('a stale device is given the serial and a newer tag', async () => {
    const pool = makePool();
    await withService(pool, async (base) => {
      await fetch(`${base}/v1/devices/D1/registrations/${LOYALTY}/S1`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...AUTH },
        body: JSON.stringify({ pushToken: 'tok' }),
      });
      const res = await fetch(
        `${base}/v1/devices/D1/registrations/${LOYALTY}?passesUpdatedSince=${tag - 60}`
      );
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.deepStrictEqual(body.serialNumbers, ['S1']);
      assert.strictEqual(body.lastUpdated, String(tag));
    });
  });

  // The tag handed back has to exclude what it was handed back with, or the
  // device downloads the same unchanged pass on every check-in forever.
  await check('the tag returned excludes the pass it was returned with', async () => {
    const pool = makePool();
    await withService(pool, async (base) => {
      await fetch(`${base}/v1/devices/D1/registrations/${LOYALTY}/S1`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...AUTH },
        body: JSON.stringify({ pushToken: 'tok' }),
      });
      const first = await (
        await fetch(`${base}/v1/devices/D1/registrations/${LOYALTY}?passesUpdatedSince=0`)
      ).json();
      const second = await fetch(
        `${base}/v1/devices/D1/registrations/${LOYALTY}?passesUpdatedSince=${first.lastUpdated}`
      );
      assert.strictEqual(second.status, 204, 'the same tag returned the pass twice');
    });
  });

  await check('a device is never told about a pass it has not registered', async () => {
    const pool = makePool();
    await withService(pool, async (base) => {
      const res = await fetch(
        `${base}/v1/devices/UNKNOWN/registrations/${LOYALTY}?passesUpdatedSince=0`
      );
      assert.strictEqual(res.status, 204);
    });
  });

  // ---------------------------------------------------------------------------
  // Fetching the pass
  // ---------------------------------------------------------------------------

  await check('fetching a pass returns the pkpass type and a Last-Modified', async () => {
    const pool = makePool();
    await withService(pool, async (base) => {
      const res = await fetch(`${base}/v1/passes/${LOYALTY}/S1`, { headers: AUTH });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(
        res.headers.get('content-type'),
        'application/vnd.apple.pkpass',
        'without this MIME type the phone does nothing with the bytes'
      );
      assert.ok(res.headers.get('last-modified'), 'no Last-Modified, so no 304 is possible');
    });
  });

  // Without this the device re-downloads a third of a megabyte over mobile data
  // on every check-in, because `build` touches the row it would otherwise be
  // dated from.
  await check('a pass that has not changed answers 304', async () => {
    const pool = makePool();
    await withService(pool, async (base) => {
      const res = await fetch(`${base}/v1/passes/${LOYALTY}/S1`, {
        headers: { ...AUTH, 'If-Modified-Since': CHANGED.toUTCString() },
      });
      assert.strictEqual(res.status, 304);
    });
  });

  await check('a pass that has changed since the client asked is sent again', async () => {
    const pool = makePool();
    await withService(pool, async (base) => {
      const older = new Date(CHANGED.getTime() - 3600 * 1000);
      const res = await fetch(`${base}/v1/passes/${LOYALTY}/S1`, {
        headers: { ...AUTH, 'If-Modified-Since': older.toUTCString() },
      });
      assert.strictEqual(res.status, 200);
    });
  });

  await check('fetching a pass without a token is refused', async () => {
    const pool = makePool();
    await withService(pool, async (base) => {
      const res = await fetch(`${base}/v1/passes/${LOYALTY}/S1`);
      assert.strictEqual(res.status, 401);
    });
  });

  // ---------------------------------------------------------------------------
  // The log
  // ---------------------------------------------------------------------------

  // The only channel iOS has for telling us anything at all. It must answer 200
  // whatever arrives — a device that cannot file a complaint retries it.
  await check('the device log always answers 200', async () => {
    const pool = makePool();
    await withService(pool, async (base) => {
      const quiet = console.error;
      console.error = () => {};
      try {
        for (const body of ['{"logs":["something went wrong"]}', '{}', '{"logs":"nonsense"}']) {
          const res = await fetch(`${base}/v1/log`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
          });
          assert.strictEqual(res.status, 200, `refused ${body}`);
        }
      } finally {
        console.error = quiet;
      }
    });
  });

  // ---------------------------------------------------------------------------
  // The push side
  // ---------------------------------------------------------------------------

  await check('push is off unless there is an address for a pass to call back', () => {
    const base = {
      APPLE_WALLET_DIR: '',
      APPLE_WWDR_CERT: '',
      APPLE_WALLET_WEB_SERVICE_URL: '',
    };
    assert.strictEqual(
      P.readPushConfig(base).pushEnabled,
      false,
      'nothing is configured, so there is nobody to push to'
    );
    assert.strictEqual(
      P.readPushConfig({ ...base, APPLE_WALLET_WEB_SERVICE_URL: 'https://x.example' })
        .pushEnabled,
      false,
      'a URL without certificates cannot push'
    );
  });

  await check('the default APNs host is production, not sandbox', () => {
    assert.strictEqual(P.APNS_HOST, 'api.push.apple.com');
    assert.strictEqual(
      P.readPushConfig({ APPLE_WALLET_APNS_HOST: '' }).host,
      'api.push.apple.com',
      'a pass has no sandbox build; a sandbox host earns a BadDeviceToken'
    );
  });

  // 410/Unregistered means the pass was deleted. Anything else is weather, and
  // forgetting a device over one bad afternoon is a card that never updates
  // again.
  await check('only the terminal APNs reasons forget a device', () => {
    for (const reason of ['Unregistered', 'BadDeviceToken', 'DeviceTokenNotForTopic']) {
      assert.ok(P.GONE.has(reason), `${reason} should forget the device`);
    }
    for (const reason of ['TooManyRequests', 'InternalServerError', 'ServiceUnavailable',
                          'ExpiredProviderToken', 'timed out']) {
      assert.ok(!P.GONE.has(reason), `${reason} must not forget the device`);
    }
  });

  await check('a push never outlasts the sale it was triggered by', () => {
    assert.ok(
      P.PUSH_TIMEOUT_MS <= 5000,
      'this runs inside a request a till is waiting on'
    );
  });

  // openssl prints the bag attributes above the PEM. Node's TLS rejects the
  // whole string when they are left on, and complains about the key rather than
  // about the preamble.
  await check('a private key is taken out of openssl’s chatter cleanly', () => {
    const noisy = [
      'Bag Attributes',
      '    friendlyName: Pass Type ID: pass.com.vesopa.loyalty',
      '    localKeyID: A1 B2 C3',
      'Key Attributes: <No Attributes>',
      '-----BEGIN PRIVATE KEY-----',
      'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ',
      '-----END PRIVATE KEY-----',
      '',
    ].join('\n');

    const block = A.pemBlock(noisy, 'PRIVATE KEY');
    assert.ok(block.startsWith('-----BEGIN PRIVATE KEY-----'), 'the preamble survived');
    assert.ok(block.endsWith('-----END PRIVATE KEY-----'), 'the block is not closed');
    assert.ok(!block.includes('friendlyName'), 'a bag attribute is still in the key');
  });

  await check('an encrypted key block is recognised too', () => {
    const encrypted =
      '-----BEGIN ENCRYPTED PRIVATE KEY-----\nAAAA\n-----END ENCRYPTED PRIVATE KEY-----';
    assert.ok(A.pemBlock(encrypted, 'PRIVATE KEY'), 'an encrypted key was not matched');
  });

  await check('nothing is returned when there is no PEM at all', () => {
    assert.strictEqual(A.pemBlock('openssl: something went wrong', 'PRIVATE KEY'), '');
  });

  // The push must not be awaited by a sale: a card a few seconds behind is
  // nothing, a queue at the counter is real.
  await check('the till does not wait for Apple', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'src', 'commerce.js'),
      'utf8'
    );
    const calls = src.split('\n').filter((l) => l.includes('notifyPassChanged'));
    assert.ok(calls.length >= 2, 'points and gift-card balances should both push');
    for (const line of calls) {
      assert.ok(!line.includes('await'), `a sale awaits a push: ${line.trim()}`);
    }
  });

  console.log(`\n${passed} checks passed\n`);
})();
