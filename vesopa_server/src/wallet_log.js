/**
 * The wallet's log: what happened to every pass, written down.
 *
 * WHY IT SWALLOWS ITS OWN FAILURES
 *
 * Every call here sits directly in the path of a customer adding a card to
 * their phone at a counter. If the log throws — the table is missing, the
 * database is briefly away, a string is too long — the right outcome is a
 * missing log line, not a customer who cannot have their card. So every write
 * is fire-and-forget and every error is caught and reduced to one line of
 * process output.
 *
 * That is a deliberate inversion of the usual rule. A log that can take down
 * the thing it observes is worse than no log, and this one observes the part of
 * the system where the customer is standing in front of somebody.
 *
 * WHY NOT AWAIT
 *
 * `record()` returns nothing and is not awaited by its callers. Signing a pass
 * already shells out to openssl and takes a few hundred milliseconds; adding a
 * round trip to the database before the bytes go out makes a slow thing slower
 * for no benefit to the person waiting. The row lands a moment later, which is
 * soon enough for something nobody reads in real time.
 */

const RETAIN_DAYS = 90;

/** Cut a value to a column's width without throwing on null. */
function clip(value, length) {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text.length > length ? text.slice(0, length) : text;
}

/**
 * Write one line of the wallet's history.
 *
 * @param pool     the database
 * @param event    built | downloaded | registered | unregistered | refreshed |
 *                 pushed | push_failed | device_log | error
 * @param office   the tenant. A row without one is dropped rather than written,
 *                 because an unscoped row is either visible to every venue or
 *                 to none, and there is no third option.
 */
function record(pool, { office, event, kind, subjectId, serial, deviceId, detail, bytes, ms, ok = true, req }) {
  if (!pool || !office || !event) return;

  const userAgent = req ? clip(req.get && req.get('user-agent'), 190) : null;
  const ip = req ? clip(req.ip, 45) : null;

  pool
    .execute(
      `INSERT INTO epos_wallet_events
         (office, event, kind, subject_id, serial_number, device_id,
          detail, bytes, ms, ok, user_agent, ip)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        clip(office, 190),
        clip(event, 32),
        clip(kind, 16),
        clip(subjectId, 64),
        clip(serial, 64),
        clip(deviceId, 64),
        clip(detail, 500),
        Number.isFinite(bytes) ? Math.max(0, Math.round(bytes)) : null,
        Number.isFinite(ms) ? Math.max(0, Math.round(ms)) : null,
        ok ? 1 : 0,
        userAgent,
        ip,
      ],
    )
    .catch((error) => {
      // One line, and no rethrow. See the note at the top of the file.
      console.warn('[wallet] could not write the event log:', error.message);
    });
}

/**
 * Forget what is old enough not to matter.
 *
 * Ninety days. Long enough to answer "this stopped working some time last
 * month", short enough that a busy venue's log does not become the largest
 * table in the database — a card that is scanned every day writes a row every
 * day, and nobody has ever asked what a pass did in the spring.
 *
 * Called on a timer from the service rather than by cron: the shared server's
 * crontab is not ours to edit.
 */
async function prune(pool, days = RETAIN_DAYS) {
  try {
    const [result] = await pool.execute(
      'DELETE FROM epos_wallet_events WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY) LIMIT 5000',
      [days],
    );
    return result.affectedRows || 0;
  } catch (error) {
    console.warn('[wallet] could not prune the event log:', error.message);
    return 0;
  }
}

/**
 * Start the pruning timer.
 *
 * `unref()` so it never holds the process open — a server that will not shut
 * down because a cleanup timer is pending is a deployment that hangs, and this
 * job has nothing worth waiting for.
 */
function startPruning(pool, everyHours = 24) {
  const timer = setInterval(() => {
    prune(pool).then((removed) => {
      if (removed) console.log(`[wallet] pruned ${removed} event log row(s)`);
    });
  }, everyHours * 60 * 60 * 1000);
  timer.unref();
  return timer;
}

module.exports = { record, prune, startPruning, RETAIN_DAYS };
