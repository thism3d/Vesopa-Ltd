/**
 * Dojo webhooks — the acquirer telling the back office what happened to a card.
 *
 * The till already polls a terminal session to its conclusion, so this is not
 * how a sale completes at the counter. It is how the back office learns about
 * everything that happens *after* the till has stopped looking: a refund raised
 * in the Dojo portal, a reversal, a pre-auth captured the next morning, or a
 * sale whose result the till never saw because the tablet lost Wi-Fi between
 * "card presented" and "approved".
 *
 * Three properties this endpoint has to have, in order of how badly it breaks
 * if it doesn't:
 *
 *   1. **It must reject forgeries.** The URL is public and it moves money in
 *      the reporting. Every request is HMAC-verified against the raw bytes.
 *   2. **It must be idempotent.** Dojo delivers at least once and retries up to
 *      12 times with backoff. A duplicate is routine, not exceptional.
 *   3. **It must answer fast.** Anything that isn't 2xx is a retry, so the
 *      handler verifies, writes, and returns — it does not do slow work inline.
 *
 * Sandbox and live are separate subscriptions with separate signing secrets,
 * which is why the environment is in the path rather than sniffed from the
 * payload: the handler has to know which secret to check *before* it can trust
 * anything in the body.
 */

const crypto = require('crypto');
const express = require('express');

/**
 * The signing secret for an environment, from the process environment.
 *
 * Never a default. A blank secret must fail closed — a webhook endpoint that
 * accepts anything when it is misconfigured is worse than one that is simply
 * switched off, because it looks like it is working.
 */
function secretFor(environment) {
  const key = environment === 'live'
    ? 'DOJO_WEBHOOK_SECRET_LIVE'
    : 'DOJO_WEBHOOK_SECRET_SANDBOX';
  return process.env[key] || '';
}

/**
 * Verify Dojo's `dojo-signature` header against the raw request body.
 *
 * THE RAW BYTES. `JSON.stringify(req.body)` is a re-serialisation that agrees
 * with what was sent only by luck of key order and number formatting, and the
 * HMAC is over bytes. server.js keeps the buffer on `req.rawBody` for this.
 *
 * Dojo formats the digest the way .NET's `BitConverter.ToString` does —
 * uppercase hex, bytes joined with hyphens:
 *
 *     sha256=4B-49-F8-FE-25-A7-E6-7D-...
 *
 * which is not what any HMAC library emits. Rather than reproduce that
 * formatting and hope, both sides are normalised down to bare lowercase hex
 * and compared there. That also means a plain `sha256=<hex>` — which is what
 * the docs' prose describes, and what Dojo may switch to — still verifies.
 *
 * Returns false on every failure path rather than throwing: an unverified
 * webhook is an answer, and a 500 here would make Dojo retry a delivery we are
 * right to be refusing.
 */
function verifySignature(rawBody, signatureHeader, secret) {
  if (!secret || !rawBody || !rawBody.length) return false;

  const sent = String(signatureHeader || '').trim();
  if (!sent) return false;

  const normalise = (s) => s.replace(/^sha256=/i, '').replace(/-/g, '').toLowerCase();

  const sentHex = normalise(sent);
  // A malformed header must not reach timingSafeEqual with a wrong length.
  if (!/^[0-9a-f]{64}$/.test(sentHex)) return false;

  const expectedHex = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  return crypto.timingSafeEqual(Buffer.from(sentHex), Buffer.from(expectedHex));
}

/**
 * Pull the ids worth indexing out of an event body.
 *
 * Dojo capitalises the envelope (`Id`, `Event`, `Data`) but not the contents of
 * `Data`. Both spellings are accepted throughout, because a payload shape that
 * changes under us should degrade to "recorded but unmatched" rather than to a
 * crash inside a handler that is supposed to answer in milliseconds.
 */
function extract(body) {
  const data = body.Data || body.data || {};
  const pick = (...names) => {
    for (const n of names) {
      if (data[n] !== undefined && data[n] !== null) {
        // Dojo's own sample payloads quote the id twice: "'pi_m18N...'".
        return String(data[n]).replace(/^'|'$/g, '');
      }
    }
    return null;
  };
  return {
    id: body.Id || body.id || null,
    event: body.Event || body.event || null,
    accountId: body.AccountId || body.accountId || null,
    createdAt: body.CreatedAt || body.createdAt || null,
    paymentIntentId: pick('paymentIntentId', 'PaymentIntentId'),
    terminalSessionId: pick('terminalSessionId', 'TerminalSessionId'),
    terminalId: pick('terminalId', 'TerminalId'),
    status: pick('paymentStatus', 'status', 'PaymentStatus', 'Status'),
    notificationType: pick('notificationType', 'NotificationType'),
  };
}

/** MySQL DATETIME from an ISO timestamp, or null if it is unparseable. */
function toMysqlDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? null
    : d.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * The one status that means the whole payment went back.
 *
 * Deliberately just this. A *partial* refund does not get its own status —
 * Dojo leave the intent `Captured` and move `refundedAmount` instead — and the
 * webhook payload carries only `paymentStatus`, never a figure. So there is no
 * honest way to size a partial refund from an event, and guessing at the full
 * amount would overstate every one of them in the takings.
 *
 * A partial refund therefore arrives here as an ordinary `Captured` status
 * update: the event is recorded and `dojo_status` is set, but no amount is
 * written, because none was sent. Sizing it would mean calling back to Dojo for
 * the intent, which needs an API key the back office does not hold today — so
 * the partial figure lives on the acquirer's side until that exists.
 */
const FULLY_REFUNDED = 'Refunded';

/**
 * Apply one event to the payment it belongs to.
 *
 * Best-effort by design. A webhook can legitimately arrive for a payment this
 * database has never seen — the till uploads its sale on its own schedule, and
 * an intent created on a different environment will never match at all — so an
 * unmatched event is recorded and shrugged off, not retried.
 */
async function reconcile(pool, e) {
  if (!e.paymentIntentId || !e.status) return 'unmatched';

  const [rows] = await pool.execute(
    `SELECT id, order_id, amount_minor FROM epos_payments WHERE reference = ? LIMIT 1`,
    [e.paymentIntentId]
  );
  if (!rows.length) return 'unmatched';

  const payment = rows[0];
  await pool.execute(
    `UPDATE epos_payments
        SET dojo_status = ?,
            dojo_refunded_minor = CASE WHEN ? THEN amount_minor ELSE dojo_refunded_minor END,
            dojo_updated_at = NOW()
      WHERE id = ?`,
    [e.status, e.status === FULLY_REFUNDED ? 1 : 0, payment.id]
  );
  return 'matched';
}

/**
 * The webhook routes.
 *
 * Mounted at the app root rather than under `/api`, and deliberately outside
 * every auth middleware: the caller is Dojo, which has no session and proves
 * itself with a signature instead.
 */
function dojoWebhookRoutes({ pool, broadcast }) {
  const router = express.Router();

  router.post('/api/webhooks/dojo/:environment', async (req, res) => {
    const environment = req.params.environment === 'live' ? 'live' : 'sandbox';
    const secret = secretFor(environment);

    if (!secret) {
      // Fail closed and say so in the log. Returning 401 (not 500) stops Dojo
      // retrying twelve times against an endpoint that cannot ever succeed
      // until somebody sets the environment variable.
      console.error(
        `[dojo] ${environment} webhook received but no signing secret is ` +
        `configured — set DOJO_WEBHOOK_SECRET_${environment.toUpperCase()}`
      );
      return res.status(401).json({ error: 'Webhook not configured' });
    }

    const signature = req.get('dojo-signature') || req.get('Dojo-Signature');
    if (!verifySignature(req.rawBody, signature, secret)) {
      console.warn(`[dojo] rejected an unverified ${environment} webhook`);
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const body = req.body || {};
    const e = extract(body);
    if (!e.id || !e.event) {
      // Signed, so it really is from Dojo, but not a shape we understand.
      // 200 regardless: retrying will not make it parseable.
      console.warn('[dojo] verified webhook with no event id or type — ignored');
      return res.status(200).json({ status: 'ignored' });
    }

    try {
      // INSERT IGNORE against the PRIMARY KEY is the whole de-duplication
      // strategy: the second delivery of an event changes no rows, and
      // affectedRows tells us which delivery this was.
      const [ins] = await pool.execute(
        `INSERT IGNORE INTO dojo_webhook_events
           (id, event, environment, account_id, created_at,
            payment_intent_id, terminal_session_id, terminal_id,
            payment_status, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          e.id,
          e.event,
          environment,
          e.accountId,
          toMysqlDate(e.createdAt),
          e.paymentIntentId,
          e.terminalSessionId,
          e.terminalId,
          e.status,
          JSON.stringify(body),
        ]
      );

      if (ins.affectedRows === 0) {
        // Already handled. Acknowledge so Dojo stops retrying, and do nothing
        // else — acting twice on one event is the failure this guards against.
        return res.status(200).json({ status: 'duplicate' });
      }

      const outcome = await reconcile(pool, e);
      if (outcome === 'matched') {
        await pool.execute(
          `UPDATE dojo_webhook_events SET reconciliation = 'matched' WHERE id = ?`,
          [e.id]
        );
      }

      // Nudge any till or back-office dashboard watching this payment. Not
      // office-scoped: it carries ids and a status, nothing about what was
      // sold, and the re-fetch it triggers is scoped by the caller's tenancy.
      broadcast({
        type: 'dojo.event',
        event: e.event,
        environment,
        paymentIntentId: e.paymentIntentId,
        terminalSessionId: e.terminalSessionId,
        status: e.status,
        notificationType: e.notificationType,
        reconciliation: outcome,
      });

      return res.status(200).json({ status: 'accepted', reconciliation: outcome });
    } catch (err) {
      // A 5xx makes Dojo retry, which is right when the failure is ours and
      // transient (the database was briefly away).
      console.error('[dojo] webhook handling failed:', err.message);
      return res.status(500).json({ error: 'Webhook handling failed' });
    }
  });

  return router;
}

/**
 * Whether each environment's webhook is configured, for the boot banner and
 * the health endpoint. Says nothing about the secret itself.
 */
function webhookStatus() {
  return {
    sandbox: Boolean(secretFor('sandbox')),
    live: Boolean(secretFor('live')),
  };
}

module.exports = {
  dojoWebhookRoutes,
  webhookStatus,
  // Exported for the tests: these are the two pieces with real logic in them.
  verifySignature,
  extract,
};
