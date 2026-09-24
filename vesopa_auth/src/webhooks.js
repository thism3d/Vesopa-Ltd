/**
 * Webhooks — telling an application something happened, without it asking.
 *
 * WHAT THIS IS FOR. An application that has signed somebody in holds a copy of
 * who they are. When the person changes their name, adds an address, or deletes
 * their account, that copy goes stale — and for deletion it becomes a legal
 * problem, because the person asked us to erase them and a dozen applications
 * are still holding their email. Polling would mean every application asking
 * about every user for ever. So we tell them.
 *
 * THE FOUR THINGS THAT MAKE A WEBHOOK SYSTEM TRUSTWORTHY, all here:
 *
 *   1. It is SIGNED. Anybody can POST to a developer's endpoint; a signature
 *      over the timestamp and the body is what makes it ours, and the timestamp
 *      is what stops yesterday's genuine delivery being replayed today.
 *   2. It RETRIES, with backoff, and the queue is a column in the database
 *      rather than memory — so a restart loses nothing.
 *   3. It gives up. An endpoint whose domain expired is disabled rather than
 *      retried for ever, because every attempt is a connection this server
 *      opens to somebody else's machine on a schedule.
 *   4. It is VISIBLE. Every attempt, its response, and a button to send it
 *      again — because the first question a developer has is always "did you
 *      actually send it", and the honest answer has to be on a page.
 *
 * DELIVERY IS AT-LEAST-ONCE, NEVER EXACTLY-ONCE. A response that is lost on the
 * way back is indistinguishable from one that never arrived, so the same event
 * can be delivered twice. Every payload carries a stable event id and the
 * documentation tells developers to key on it. Promising exactly-once would be
 * a lie that costs somebody a duplicated charge.
 */

const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');

const config = require('./config');
const db = require('./db');
const { newId, newToken, encrypt, decrypt } = require('./crypto');

/**
 * The events an application may subscribe to.
 *
 * Deliberately a short, closed list. Every one of these is something an
 * application holding a copy of a person needs to act on; anything else is
 * telling a third party about somebody's behaviour, which is not what an
 * identity provider is for.
 */
const EVENT_TYPES = {
  'user.created': 'Somebody used your application for the first time.',
  'user.updated': 'A name, picture or date of birth changed.',
  'user.deleted': 'The account was deleted. Erase your copy of their data.',
  'user.suspended': 'An administrator suspended the account.',
  'identity.linked': 'An email address, phone number or provider was added.',
  'identity.unlinked': 'One was removed — it may now belong to somebody else.',
  'consent.revoked': 'The person disconnected your application. Stop using their tokens.',
  'session.revoked': 'They signed out everywhere, or a session was ended for them.',
};

/*
 * Backoff, in seconds, one per attempt.
 *
 * Fast at first because most failures are a deploy that took twenty seconds,
 * then slowing sharply: after roughly a day of trying, an endpoint is not
 * coming back on its own and somebody has to look at it.
 */
const BACKOFF = [10, 60, 300, 900, 3600, 10800, 21600, 43200];
const MAX_ATTEMPTS = BACKOFF.length;

/** Disable an endpoint after this many failed deliveries in a row. */
const FAILURES_BEFORE_DISABLE = 20;

const TIMEOUT_MS = 10000;

// ---------------------------------------------------------------------------
// Where an endpoint is allowed to point
// ---------------------------------------------------------------------------

/**
 * Refuse a URL that would make this server attack its own network.
 *
 * A webhook URL is chosen by a developer and fetched by us, which is
 * server-side request forgery with a form around it. Left open, "https://
 * 169.254.169.254/latest/meta-data/" is a webhook endpoint that hands a
 * stranger the machine's cloud credentials, and "http://127.0.0.1:20003/admin"
 * is one that reaches this application's own internals from inside the
 * firewall.
 *
 * So: HTTPS only, and the hostname is resolved and every address it resolves to
 * must be public.
 *
 * WHAT THIS DOES NOT STOP, said plainly rather than pretended away: DNS
 * rebinding. The name is resolved here and resolved again by fetch, and a
 * hostile server can answer differently the second time. Closing that needs the
 * connection pinned to the address we checked, which Node's fetch does not
 * expose. The remaining exposure is one request to an internal address with a
 * body the attacker controls and a response they never see — worth knowing
 * about, not worth blocking the feature for.
 */
async function checkUrl(raw) {
  let url;
  try {
    url = new URL(String(raw || '').trim());
  } catch {
    return { ok: false, error: 'That does not look like a URL.' };
  }

  if (url.protocol !== 'https:') {
    return {
      ok: false,
      error: 'Webhook URLs must be https. We send you signed data about your users, and http sends it in clear.',
    };
  }
  if (url.username || url.password) {
    return { ok: false, error: 'Do not put credentials in the URL — use the signing secret instead.' };
  }
  if (url.hash) {
    return { ok: false, error: 'A URL fragment is never sent to a server, so it cannot be part of an endpoint.' };
  }

  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    return { ok: false, error: 'That address is only reachable from inside a network, so we could never deliver to it.' };
  }

  let addresses;
  try {
    addresses = net.isIP(host)
      ? [{ address: host }]
      : await dns.lookup(host, { all: true });
  } catch {
    return { ok: false, error: 'That hostname does not resolve. Check the spelling, or try again once DNS has propagated.' };
  }

  for (const entry of addresses) {
    if (isPrivateAddress(entry.address)) {
      return {
        ok: false,
        error: 'That hostname resolves to a private address. Webhook endpoints have to be reachable from the public internet.',
      };
    }
  }

  return { ok: true, url: url.toString() };
}

function isPrivateAddress(address) {
  if (net.isIPv4(address)) {
    const parts = address.split('.').map(Number);
    if (parts[0] === 10) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 0) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 169 && parts[1] === 254) return true; // cloud metadata
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true; // carrier NAT
    if (parts[0] >= 224) return true; // multicast and reserved
    return false;
  }
  const lower = String(address).toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('fe80') || lower.startsWith('fc') || lower.startsWith('fd')) return true;
  // An IPv4 address wearing an IPv6 hat is still that address.
  if (lower.startsWith('::ffff:')) return isPrivateAddress(lower.slice(7));
  return false;
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

async function listEndpoints(applicationId) {
  const rows = await db.query(
    `SELECT * FROM webhook_endpoints
      WHERE application_id = ? AND deleted_at IS NULL
      ORDER BY created_at`,
    [applicationId],
  );
  for (const row of rows) {
    row.events = (
      await db.query('SELECT event_type FROM webhook_endpoint_events WHERE endpoint_id = ?', [row.id])
    ).map((e) => e.event_type);
  }
  return rows;
}

async function getEndpoint(applicationId, publicId) {
  const row = await db.one(
    'SELECT * FROM webhook_endpoints WHERE application_id = ? AND public_id = ? AND deleted_at IS NULL',
    [applicationId, publicId],
  );
  if (!row) return null;
  row.events = (
    await db.query('SELECT event_type FROM webhook_endpoint_events WHERE endpoint_id = ?', [row.id])
  ).map((e) => e.event_type);
  return row;
}

/**
 * Create an endpoint. Returns the signing secret ONCE.
 *
 * The developer needs it to verify what we send, and it is never shown again —
 * so the page that receives this has to make them copy it, the same way a
 * client secret does.
 */
async function createEndpoint({ applicationId, url, description, events, createdBy }) {
  const checked = await checkUrl(url);
  if (!checked.ok) return { ok: false, error: checked.error };

  const wanted = (events || []).filter((type) => type in EVENT_TYPES);
  if (!wanted.length) {
    return { ok: false, error: 'Choose at least one event. An endpoint subscribed to nothing never fires.' };
  }

  // `whsec_` so that a secret pasted into a chat or a log is recognisable for
  // what it is — the same reason every provider prefixes theirs.
  const secret = `whsec_${newToken(24)}`;
  const publicId = newId();

  const result = await db.transaction(async (tx) => {
    const inserted = await tx.execute(
      `INSERT INTO webhook_endpoints
         (public_id, application_id, url, description, secret_cipher, secret_hint, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        publicId,
        applicationId,
        checked.url,
        String(description || '').slice(0, 160),
        encrypt(secret, config.secrets.encryptionKey),
        secret.slice(-6),
        createdBy,
      ],
    );
    for (const type of wanted) {
      await tx.execute(
        'INSERT IGNORE INTO webhook_endpoint_events (endpoint_id, event_type) VALUES (?, ?)',
        [inserted.insertId, type],
      );
    }
    return inserted.insertId;
  });

  return { ok: true, id: result, publicId, secret };
}

async function updateEndpoint(endpointId, { url, description, events, isEnabled }) {
  if (url !== undefined) {
    const checked = await checkUrl(url);
    if (!checked.ok) return { ok: false, error: checked.error };
    await db.execute('UPDATE webhook_endpoints SET url = ? WHERE id = ?', [checked.url, endpointId]);
  }
  if (description !== undefined) {
    await db.execute('UPDATE webhook_endpoints SET description = ? WHERE id = ?', [
      String(description).slice(0, 160),
      endpointId,
    ]);
  }
  if (isEnabled !== undefined) {
    // Turning it back on clears the automatic disable and the failure run, or
    // it would switch itself off again on the next attempt.
    await db.execute(
      `UPDATE webhook_endpoints
          SET is_enabled = ?, disabled_at = NULL, disabled_reason = '',
              consecutive_failures = IF(? = 1, 0, consecutive_failures)
        WHERE id = ?`,
      [isEnabled ? 1 : 0, isEnabled ? 1 : 0, endpointId],
    );
  }
  if (Array.isArray(events)) {
    const wanted = events.filter((type) => type in EVENT_TYPES);
    if (!wanted.length) {
      return { ok: false, error: 'Choose at least one event.' };
    }
    await db.transaction(async (tx) => {
      await tx.execute('DELETE FROM webhook_endpoint_events WHERE endpoint_id = ?', [endpointId]);
      for (const type of wanted) {
        await tx.execute(
          'INSERT IGNORE INTO webhook_endpoint_events (endpoint_id, event_type) VALUES (?, ?)',
          [endpointId, type],
        );
      }
    });
  }
  return { ok: true };
}

async function removeEndpoint(endpointId) {
  // Soft, so the delivery history it explains does not vanish with it.
  await db.execute('UPDATE webhook_endpoints SET deleted_at = NOW() WHERE id = ?', [endpointId]);
}

/** Mint a new signing secret, returned once. */
async function rotateSecret(endpointId) {
  const secret = `whsec_${newToken(24)}`;
  await db.execute(
    'UPDATE webhook_endpoints SET secret_cipher = ?, secret_hint = ? WHERE id = ?',
    [encrypt(secret, config.secrets.encryptionKey), secret.slice(-6), endpointId],
  );
  return secret;
}

// ---------------------------------------------------------------------------
// Emitting
// ---------------------------------------------------------------------------

/**
 * Record that something happened, and queue it to whoever asked.
 *
 * NEVER THROWS. This is called from the middle of a sign-in, a profile save, an
 * account deletion. A webhook that cannot be queued must not be able to fail
 * the thing it is describing — the person's account was still deleted.
 */
async function emit(applicationId, eventType, { subject = '', payload = {} } = {}) {
  if (!(eventType in EVENT_TYPES)) {
    console.warn(`[webhooks] unknown event type ${eventType}`);
    return null;
  }

  try {
    const endpoints = await db.query(
      `SELECT e.id
         FROM webhook_endpoints e
         JOIN webhook_endpoint_events s ON s.endpoint_id = e.id
        WHERE e.application_id = ? AND s.event_type = ?
          AND e.deleted_at IS NULL AND e.is_enabled = 1`,
      [applicationId, eventType],
    );

    // Nobody is listening. Recording the event anyway would fill a table with
    // rows no one will ever read.
    if (!endpoints.length) return null;

    const publicId = newId();
    const body = {
      id: publicId,
      type: eventType,
      created: Math.floor(Date.now() / 1000),
      data: payload,
    };

    const event = await db.execute(
      `INSERT INTO webhook_events (public_id, application_id, event_type, subject, payload)
       VALUES (?, ?, ?, ?, ?)`,
      [publicId, applicationId, eventType, String(subject).slice(0, 64), JSON.stringify(body)],
    );

    for (const endpoint of endpoints) {
      await db.execute(
        `INSERT INTO webhook_deliveries (public_id, endpoint_id, event_id, next_attempt_at, max_attempts)
         VALUES (?, ?, ?, NOW(), ?)`,
        [newId(), endpoint.id, event.insertId, MAX_ATTEMPTS],
      );
    }

    // Nudge the worker rather than waiting for its next tick, so an event
    // arrives in a second rather than up to fifteen.
    setImmediate(() => {
      drain().catch(() => {});
    });

    return publicId;
  } catch (error) {
    console.error('[webhooks] could not queue event:', error.message);
    return null;
  }
}

/**
 * Emit to every application that holds this person, for events about a person
 * rather than about one application's relationship with them.
 *
 * The payload is built PER APPLICATION, because the `sub` a third-party
 * application knows somebody by is derived from (person, application) — telling
 * them about a subject they have never seen would be useless, and telling them
 * somebody else's subject would be a leak.
 */
async function emitForUser(userId, eventType, buildPayload) {
  try {
    const memberships = await db.query(
      `SELECT DISTINCT a.id, a.client_id, a.subject_type, a.sector_salt
         FROM application_members m
         JOIN applications a ON a.id = m.application_id
         JOIN webhook_endpoints e ON e.application_id = a.id
              AND e.deleted_at IS NULL AND e.is_enabled = 1
         JOIN webhook_endpoint_events s ON s.endpoint_id = e.id AND s.event_type = ?
        WHERE m.user_id = ? AND m.status IN ('active', 'suspended')`,
      [eventType, userId],
    );
    if (!memberships.length) return;

    const user = await db.one('SELECT * FROM users WHERE id = ?', [userId]);
    if (!user) return;

    const tokens = require('./oauth/tokens');
    for (const application of memberships) {
      const subject = tokens.subjectFor(application, user.public_id);
      // eslint-disable-next-line no-await-in-loop
      await emit(application.id, eventType, {
        subject,
        payload: await buildPayload(user, subject, application),
      });
    }
  } catch (error) {
    console.error('[webhooks] could not fan out to applications:', error.message);
  }
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

/**
 * The signature header, in the shape every developer already knows.
 *
 *     Vesopa-Signature: t=1757370000,v1=<hex>
 *
 * Signed over `t.body`, not the body alone, so a genuine delivery captured
 * today cannot be replayed at the endpoint tomorrow — the developer checks the
 * timestamp is recent and the signature covers it, and one without the other is
 * no protection at all.
 */
function sign(secret, timestamp, body) {
  const digest = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${body}`, 'utf8')
    .digest('hex');
  return `t=${timestamp},v1=${digest}`;
}

// ---------------------------------------------------------------------------
// Delivering
// ---------------------------------------------------------------------------

/**
 * Send everything that is due.
 *
 * Rows are claimed with a conditional UPDATE before they are sent, so two
 * drains — the timer and the nudge from `emit` — cannot send the same delivery
 * twice.
 */
async function drain(limit = 20) {
  // Reclaim anything a previous run died holding. Two minutes is far longer
  // than the ten-second timeout, so this can only catch a genuinely dead lock.
  await db.execute(
    `UPDATE webhook_deliveries SET locked_at = NULL
      WHERE locked_at IS NOT NULL AND locked_at < DATE_SUB(NOW(), INTERVAL 2 MINUTE)`,
  );

  const due = await db.query(
    `SELECT d.id
       FROM webhook_deliveries d
       JOIN webhook_endpoints e ON e.id = d.endpoint_id
      WHERE d.status = 'pending'
        AND d.next_attempt_at <= NOW()
        AND d.locked_at IS NULL
        AND e.is_enabled = 1 AND e.deleted_at IS NULL
      ORDER BY d.next_attempt_at
      LIMIT ${Math.max(1, Math.min(100, Number(limit) || 20))}`,
  );

  let sent = 0;
  for (const row of due) {
    // eslint-disable-next-line no-await-in-loop
    const claimed = await db.execute(
      "UPDATE webhook_deliveries SET locked_at = NOW() WHERE id = ? AND locked_at IS NULL AND status = 'pending'",
      [row.id],
    );
    if (claimed.affectedRows !== 1) continue;
    // eslint-disable-next-line no-await-in-loop
    await attempt(row.id);
    sent += 1;
  }
  return sent;
}

async function attempt(deliveryId) {
  const delivery = await db.one(
    `SELECT d.*, e.url, e.secret_cipher, e.application_id, ev.payload, ev.event_type, ev.public_id AS event_public_id
       FROM webhook_deliveries d
       JOIN webhook_endpoints e ON e.id = d.endpoint_id
       JOIN webhook_events ev ON ev.id = d.event_id
      WHERE d.id = ?`,
    [deliveryId],
  );
  if (!delivery) return;

  const body =
    typeof delivery.payload === 'string' ? delivery.payload : JSON.stringify(delivery.payload);
  const timestamp = Math.floor(Date.now() / 1000);

  let secret;
  try {
    secret = decrypt(delivery.secret_cipher, config.secrets.encryptionKey);
  } catch (error) {
    await finish(delivery, { ok: false, error: 'signing secret could not be read', fatal: true });
    return;
  }

  const started = Date.now();
  try {
    const response = await fetch(delivery.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'Vesopa-Webhooks/1.0',
        'vesopa-signature': sign(secret, timestamp, body),
        'vesopa-event': delivery.event_type,
        'vesopa-event-id': delivery.event_public_id,
        'vesopa-delivery': delivery.public_id,
        'vesopa-attempt': String(delivery.attempt + 1),
      },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    const text = (await response.text().catch(() => '')).slice(0, 500);
    const duration = Date.now() - started;

    /*
     * 2xx is success. Everything else is a failure to be retried — including a
     * redirect, which is NOT followed: a webhook endpoint that moves should be
     * changed in the portal, and following one blindly would send signed data
     * about somebody's account to whatever address a compromised server named.
     */
    const ok = response.status >= 200 && response.status < 300;
    await finish(delivery, {
      ok,
      code: response.status,
      body: text,
      duration,
      error: ok ? '' : `endpoint answered ${response.status}`,
    });
  } catch (error) {
    await finish(delivery, {
      ok: false,
      error: String(error.message || error).slice(0, 200),
      duration: Date.now() - started,
    });
  }
}

async function finish(delivery, { ok, code = null, body = '', error = '', duration = null, fatal = false }) {
  const attemptNumber = delivery.attempt + 1;

  if (ok) {
    await db.transaction(async (tx) => {
      await tx.execute(
        `UPDATE webhook_deliveries
            SET status = 'delivered', attempt = ?, response_code = ?, response_body = ?,
                error = '', duration_ms = ?, delivered_at = NOW(), locked_at = NULL,
                next_attempt_at = NULL
          WHERE id = ?`,
        [attemptNumber, code, body, duration, delivery.id],
      );
      await tx.execute(
        `UPDATE webhook_endpoints
            SET last_success_at = NOW(), consecutive_failures = 0
          WHERE id = ?`,
        [delivery.endpoint_id],
      );
    });
    return;
  }

  const exhausted = fatal || attemptNumber >= delivery.max_attempts;
  const nextIn = BACKOFF[Math.min(attemptNumber, BACKOFF.length - 1)];

  await db.transaction(async (tx) => {
    await tx.execute(
      `UPDATE webhook_deliveries
          SET status = ?, attempt = ?, response_code = ?, response_body = ?, error = ?,
              duration_ms = ?, locked_at = NULL,
              next_attempt_at = ${exhausted ? 'NULL' : 'DATE_ADD(NOW(), INTERVAL ? SECOND)'}
        WHERE id = ?`,
      exhausted
        ? [ 'abandoned', attemptNumber, code, body, error, duration, delivery.id]
        : ['pending', attemptNumber, code, body, error, duration, nextIn, delivery.id],
    );

    const failures = await tx.execute(
      `UPDATE webhook_endpoints
          SET last_failure_at = NOW(), consecutive_failures = consecutive_failures + 1
        WHERE id = ?`,
      [delivery.endpoint_id],
    );
    void failures;

    /*
     * Give up on an endpoint that has failed for a long time. The developer is
     * shown why, and one click turns it back on — but until somebody looks, we
     * stop knocking on a door nobody is behind.
     */
    await tx.execute(
      `UPDATE webhook_endpoints
          SET is_enabled = 0, disabled_at = NOW(),
              disabled_reason = 'too many failures in a row'
        WHERE id = ? AND consecutive_failures >= ? AND is_enabled = 1`,
      [delivery.endpoint_id, FAILURES_BEFORE_DISABLE],
    );
  });
}

/** Queue an existing event to be sent again, exactly as it was. */
async function replay(deliveryId) {
  const original = await db.one('SELECT * FROM webhook_deliveries WHERE id = ?', [deliveryId]);
  if (!original) return null;

  const result = await db.execute(
    `INSERT INTO webhook_deliveries
       (public_id, endpoint_id, event_id, next_attempt_at, max_attempts, replay_of)
     VALUES (?, ?, ?, NOW(), ?, ?)`,
    [newId(), original.endpoint_id, original.event_id, MAX_ATTEMPTS, original.id],
  );

  setImmediate(() => {
    drain().catch(() => {});
  });
  return result.insertId;
}

/** Send a signed example, so a developer can prove their endpoint works. */
async function sendTest(endpointId, applicationId) {
  const publicId = newId();
  const event = await db.execute(
    `INSERT INTO webhook_events (public_id, application_id, event_type, subject, payload)
     VALUES (?, ?, 'user.updated', 'test', ?)`,
    [
      publicId,
      applicationId,
      JSON.stringify({
        id: publicId,
        type: 'user.updated',
        created: Math.floor(Date.now() / 1000),
        // Marked as a test in the body as well as being obviously one, so a
        // developer's handler can ignore it rather than acting on a person who
        // does not exist.
        test: true,
        data: { sub: 'test-subject', name: 'Test Person' },
      }),
    ],
  );

  const result = await db.execute(
    `INSERT INTO webhook_deliveries (public_id, endpoint_id, event_id, next_attempt_at, max_attempts)
     VALUES (?, ?, ?, NOW(), 1)`,
    [newId(), endpointId, event.insertId, 1],
  );

  await attemptNow(result.insertId);
  return db.one('SELECT * FROM webhook_deliveries WHERE id = ?', [result.insertId]);
}

async function attemptNow(deliveryId) {
  await db.execute("UPDATE webhook_deliveries SET locked_at = NOW() WHERE id = ?", [deliveryId]);
  await attempt(deliveryId);
}

async function deliveries(endpointId, limit = 30) {
  return db.query(
    `SELECT d.*, ev.event_type, ev.public_id AS event_public_id
       FROM webhook_deliveries d
       JOIN webhook_events ev ON ev.id = d.event_id
      WHERE d.endpoint_id = ?
      ORDER BY d.id DESC
      LIMIT ${Math.max(1, Math.min(200, Number(limit) || 30))}`,
    [endpointId],
  );
}

// ---------------------------------------------------------------------------
// The worker
// ---------------------------------------------------------------------------

let timer = null;

/**
 * A timer in this process, not a cron job.
 *
 * The owner asked that nothing be added to the shared server outside this
 * application's own domain, and a crontab entry is exactly that. pm2 runs this
 * app in fork mode with a single instance, so there is one timer and no two
 * workers racing — and the claim-before-send in `drain` would hold even if
 * there were.
 */
function startWorker() {
  if (timer) return;
  timer = setInterval(() => {
    drain().catch((error) => console.error('[webhooks] drain failed:', error.message));
  }, 15000);
  timer.unref();
}

function stopWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  EVENT_TYPES,
  MAX_ATTEMPTS,
  checkUrl,
  isPrivateAddress,
  listEndpoints,
  getEndpoint,
  createEndpoint,
  updateEndpoint,
  removeEndpoint,
  rotateSecret,
  emit,
  emitForUser,
  sign,
  drain,
  replay,
  sendTest,
  deliveries,
  startWorker,
  stopWorker,
};
