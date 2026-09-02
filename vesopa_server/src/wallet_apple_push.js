const http2 = require('http2');

const A = require('./wallet_apple');
const G = require('./wallet_google');

/**
 * Telling a phone that a pass has changed.
 *
 * WHAT AN APNs PUSH TO A PASS ACTUALLY IS
 *
 * An empty JSON object, posted to Apple, addressed to one device. It carries no
 * message, no badge and no sound, and the customer is shown nothing. All it
 * does is wake Wallet, which then calls the update service in
 * wallet_apple_webservice.js and asks what changed — and *that* is what fetches
 * the new card. So a push that arrives with nothing in it is not a degenerate
 * notification; it is the whole of the design. Wallet does not trust a payload
 * to tell it what a pass now says, and neither should we.
 *
 * WHY THERE IS NO .p8 HERE
 *
 * The usual APNs setup is a token — a `.p8` signing key, a Key ID and a Team
 * ID, good for every app a team ships. Passes do not work that way. A Pass Type
 * ID certificate *is* its own APNs client certificate: the same credential that
 * signs a `.pkpass` authenticates the connection that updates it, and Apple
 * issues nothing else. Vesopa has five pass types and therefore five
 * certificates, which is why the connection below is per pass type rather than
 * one shared session.
 *
 * That is also why this file authenticates with TLS rather than with a JWT.
 * There is no bearer token to mint and none to expire.
 *
 * WHY NOTHING HERE IS ALLOWED TO THROW
 *
 * The caller is a till taking money. A customer's points changing is the reason
 * to push, and the push failing is not a reason for the sale to fail — APNs
 * being briefly unreachable must never turn into an error on a card machine at
 * a counter. So every path returns a result and records it; none of them
 * propagate. The cost of that choice is silence, which is the failure mode this
 * whole feature already has, so the reason is written to the device row instead.
 * See `last_error` in schema_wallet_apple_push.sql.
 */

/**
 * Apple's provider host.
 *
 * Production, not sandbox, and that is not a per-environment choice the way it
 * is for app notifications. A pass has no development build: the same signed
 * `.pkpass` installs on a developer's phone and a customer's, its push token
 * comes from production APNs either way, and sending to the sandbox host with a
 * production token is answered `BadDeviceToken` — the same error as a genuinely
 * dead device, which is exactly the wrong thing to be confused about.
 *
 * The override exists for a test that wants somewhere harmless to point at, not
 * for a staging deployment.
 */
const APNS_HOST = 'api.push.apple.com';

/**
 * How long to wait on one push before giving up.
 *
 * Short on purpose. This is called from inside a request a till is waiting on,
 * and a slow push is worse than a missed one: the card is refreshed by the next
 * scan anyway, whereas a till that hangs for thirty seconds is a queue.
 */
const PUSH_TIMEOUT_MS = 5000;

/**
 * Reasons that mean the device is gone, rather than that today went badly.
 *
 * `Unregistered` (410) is Apple saying the pass was deleted from the wallet.
 * `BadDeviceToken` and `DeviceTokenNotForTopic` mean the row is addressed to
 * something that will never receive again — a token from a restored backup, or
 * one recorded against the wrong pass type.
 *
 * Every other failure is treated as weather. A device that failed once is tried
 * again next time, because the usual cause is transient and forgetting it would
 * mean a card that never updates again after a single bad afternoon.
 */
const GONE = new Set(['Unregistered', 'BadDeviceToken', 'DeviceTokenNotForTopic']);

/**
 * One HTTP/2 session per pass type, kept open.
 *
 * APNs is explicit that providers should hold a connection open rather than
 * dial per notification, and the cost here is not just the TLS handshake: each
 * new session means shelling out to openssl twice to read the certificate and
 * key back out of the `.p12`. Five sessions is the whole of it, because there
 * are five certificates and a TLS client certificate is chosen per connection.
 *
 * Keyed by kind rather than by pass type identifier so the map lines up with
 * everything else in this codebase, which speaks in kinds.
 */
const sessions = new Map();

function sessionFor(kind, config, host) {
  const open = sessions.get(kind);
  if (open && !open.closed && !open.destroyed) return open;

  const { cert, key } = A.pemForKind(kind, config);
  const session = http2.connect(`https://${host}`, { cert, key });

  // Both are required, and not for tidiness. An unhandled 'error' on an http2
  // session is an uncaught exception that takes the server down, and a session
  // left in the map after it closes is one every later push tries to write to
  // and every later push fails on.
  session.on('error', () => {
    if (sessions.get(kind) === session) sessions.delete(kind);
  });
  session.on('close', () => {
    if (sessions.get(kind) === session) sessions.delete(kind);
  });

  sessions.set(kind, session);
  return session;
}

/** Close every open session. For tests and for a clean shutdown. */
function closeSessions() {
  for (const session of sessions.values()) {
    try {
      session.close();
    } catch {
      // Already gone, which is the state we were aiming for.
    }
  }
  sessions.clear();
}

/**
 * Push one empty notification to one device.
 *
 * Resolves to `{ ok, status, reason }` and never rejects — see the note at the
 * top of this file about why.
 */
function sendOne({ kind, pushToken, config, host = APNS_HOST }) {
  return new Promise((resolve) => {
    const type = G.PASS_TYPES[kind];
    if (!type) {
      return resolve({ ok: false, status: 0, reason: `Unknown pass kind "${kind}"` });
    }

    let session;
    try {
      session = sessionFor(kind, config, host);
    } catch (e) {
      // Could not read the certificate at all. Worth naming plainly: this is a
      // deployment problem, not a device problem, and it will affect every push
      // for this pass type rather than one card.
      return resolve({ ok: false, status: 0, reason: String(e.message || e) });
    }

    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let req;
    try {
      req = session.request({
        ':method': 'POST',
        ':path': `/3/device/${encodeURIComponent(pushToken)}`,
        // What tells APNs which pass this is about. For an app this would be
        // the bundle identifier; for a pass it is the pass type identifier, and
        // a mismatch between this and the certificate on the connection is
        // answered `TopicDisallowed`.
        'apns-topic': type.appleType,
        // Deliberately no `apns-push-type`. Apple defines that header's values
        // for app notifications — alert, background, voip and the rest — and
        // none of them describe a pass update. Apple's own pass documentation
        // sends the topic and an empty body and nothing else.
        'content-type': 'application/json',
      });
    } catch (e) {
      return done({ ok: false, status: 0, reason: String(e.message || e) });
    }

    req.setTimeout(PUSH_TIMEOUT_MS, () => {
      req.close(http2.constants.NGHTTP2_CANCEL);
      done({ ok: false, status: 0, reason: 'timed out' });
    });

    let status = 0;
    req.on('response', (headers) => {
      status = Number(headers[':status']) || 0;
    });

    // The body is only ever read to find out why. A success is a 200 with
    // nothing in it.
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });

    req.on('error', (e) => done({ ok: false, status, reason: String(e.message || e) }));

    req.on('end', () => {
      if (status === 200) return done({ ok: true, status, reason: '' });
      let reason = '';
      try {
        reason = String(JSON.parse(body).reason || '');
      } catch {
        reason = body.trim().slice(0, 200);
      }
      // A 410 with no parseable body still means the same thing, so the status
      // supplies the reason when Apple's body does not.
      if (!reason && status === 410) reason = 'Unregistered';
      done({ ok: false, status, reason: reason || `HTTP ${status}` });
    });

    // The empty object. This is the entire payload of a pass update.
    req.end('{}');
  });
}

/**
 * Tell every device holding this pass that it has changed.
 *
 * Two steps, in this order and not the other: the change is recorded first,
 * then the phones are woken. A device that is pushed before the new timestamp
 * is written asks "what changed since <tag>", is told "nothing", and goes back
 * to sleep holding the old card — and nothing will wake it again, because the
 * only thing that would have was the push that just happened.
 *
 * Returns a small summary rather than throwing. Callers are sales.
 */
async function notifySerial({ pool, serial, config, host = APNS_HOST }) {
  const result = { serial: String(serial || ''), pushed: 0, failed: 0, forgotten: 0 };
  if (!result.serial) return result;

  const [[pass]] = await pool.query(
    `SELECT id, office, kind, apple_serial FROM epos_wallet_passes
      WHERE apple_serial = ?`,
    [result.serial]
  );
  if (!pass) return result;

  await pool.execute(
    'UPDATE epos_wallet_passes SET apple_updated_at = NOW() WHERE id = ?',
    [pass.id]
  );

  const [devices] = await pool.query(
    `SELECT device_id, push_token FROM epos_wallet_devices
      WHERE serial_number = ?`,
    [result.serial]
  );
  if (!devices.length) return result;

  const outcomes = await Promise.all(
    devices.map(async (device) => {
      const sent = await sendOne({
        kind: pass.kind,
        pushToken: device.push_token,
        config,
        host,
      });
      return { device, sent };
    })
  );

  for (const { device, sent } of outcomes) {
    if (sent.ok) {
      result.pushed++;
      await pool
        .execute(
          `UPDATE epos_wallet_devices SET last_push_at = NOW(), last_error = NULL
            WHERE device_id = ? AND serial_number = ?`,
          [device.device_id, result.serial]
        )
        .catch(() => {});
      continue;
    }

    if (GONE.has(sent.reason)) {
      // The pass is off that phone. Deleting rather than marking is the same
      // decision schema_wallet_apple.sql made for an explicit unregister: a
      // device that cannot receive must be forgotten, or every later push pays
      // for it.
      result.forgotten++;
      await pool
        .execute(
          'DELETE FROM epos_wallet_devices WHERE device_id = ? AND serial_number = ?',
          [device.device_id, result.serial]
        )
        .catch(() => {});
      continue;
    }

    result.failed++;
    await pool
      .execute(
        `UPDATE epos_wallet_devices SET last_push_at = NOW(), last_error = ?
          WHERE device_id = ? AND serial_number = ?`,
        [String(sent.reason).slice(0, 500), device.device_id, result.serial]
      )
      .catch(() => {});
  }

  return result;
}

/**
 * The same thing, addressed the way the rest of the codebase addresses a card.
 *
 * This is what a sale calls. It is a no-op — not an error — for a venue with no
 * Apple pass for this subject, which is the common case: most customers have
 * never installed one, and a till must not care.
 */
async function notifyPassChanged({ pool, office, kind, subjectId, config, host }) {
  const use = config || cachedPushConfig();
  if (!use.pushEnabled) return { pushed: 0, failed: 0, forgotten: 0, skipped: true };

  try {
    const [[row]] = await pool.query(
      `SELECT apple_serial FROM epos_wallet_passes
        WHERE office = ? AND kind = ? AND subject_id = ?`,
      [office, kind, String(subjectId)]
    );
    if (!row || !row.apple_serial) {
      return { pushed: 0, failed: 0, forgotten: 0, skipped: true };
    }
    return await notifySerial({ pool, serial: row.apple_serial, config: use, host });
  } catch (e) {
    // Reached only when the database itself is unhappy, by which point the
    // caller has its own problems. Logged rather than raised, because the
    // caller is a sale.
    console.error('[wallet] Apple push failed:', e.message);
    return { pushed: 0, failed: 1, forgotten: 0, skipped: false };
  }
}

/**
 * The signing configuration, plus whether pushing is switched on at all.
 *
 * `pushEnabled` is deliberately tied to APPLE_WALLET_WEB_SERVICE_URL rather
 * than to a switch of its own. Without that URL no pass carries a
 * `webServiceURL`, so no device has ever registered, so there is nobody to push
 * to — a separate flag would only make it possible to have one of the two set
 * and spend every sale discovering there are no rows.
 */
function readPushConfig(env = process.env) {
  const config = A.readConfig(env);
  return {
    ...config,
    host: String(env.APPLE_WALLET_APNS_HOST || '').trim() || APNS_HOST,
    pushEnabled: Boolean(config.configured && config.webServiceUrl),
  };
}

/**
 * The same thing, worked out once.
 *
 * [readPushConfig] is not cheap: A.readConfig() opens every `.p12` in the
 * wallet directory and shells out to openssl twice per file to find the one
 * whose key fits the certificates. That is the right thing to do at start-up
 * and quite wrong to do on every sale — which is what an uncached call here
 * would be, because the common case is a venue with no Apple passes at all,
 * where the only thing this function does is confirm there is nothing to do.
 *
 * Cached for the life of the process, which matches how the rest of the Apple
 * code treats its configuration: the certificates are read when the server
 * starts, and swapping them is a restart.
 */
let cached = null;
function cachedPushConfig(env = process.env) {
  if (!cached) cached = readPushConfig(env);
  return cached;
}

/** Forget the cached configuration. For tests. */
function resetPushConfig() {
  cached = null;
}

module.exports = {
  APNS_HOST,
  PUSH_TIMEOUT_MS,
  GONE,
  readPushConfig,
  cachedPushConfig,
  resetPushConfig,
  sendOne,
  notifySerial,
  notifyPassChanged,
  closeSessions,
};
