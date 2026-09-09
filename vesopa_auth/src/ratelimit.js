/**
 * Rate limiting, counted in the database rather than in memory.
 *
 * WHY NOT IN MEMORY. In-process counters are faster and are also per-process:
 * two workers mean twice the attempts before anybody is locked out, and every
 * deploy forgives every attacker instantly. On a login endpoint that is the
 * difference between a limit and the appearance of one. The application runs in
 * fork mode with a single instance partly for this reason, but the counter
 * belongs here anyway so that it survives a restart.
 *
 * THE LIMITS PROTECT DIFFERENT THINGS, which is why there are several:
 *
 *   per destination  — stops this service being used to send a stranger forty
 *                      text messages, and stops one account being hammered
 *   per IP           — stops one machine walking through a list of addresses
 *   per account      — stops a distributed attempt on one person
 *   per challenge    — stops guessing a six-digit code
 *
 * A single global limit would have to be loose enough for the busiest of these
 * and would therefore stop none of them.
 */

const db = require('./db');

/**
 * Count one attempt against a bucket, and say whether it is allowed.
 *
 * Fixed windows rather than a sliding log: a sliding window needs a row per
 * attempt, and on the busiest bucket that is a table that grows faster than the
 * sweeper clears it. The cost of a fixed window is that somebody can spend the
 * tail of one window and the head of the next; against a five-per-hour limit
 * that is ten sends in a few minutes, which is tolerable, and the per-challenge
 * attempt cap is what actually protects the code.
 *
 * The UPSERT is one statement so two simultaneous requests cannot both read
 * "four" and both write "five".
 */
async function hit(bucket, subject, { limit, windowSeconds }) {
  const key = String(subject).slice(0, 190).toLowerCase();
  const windowStart = new Date(
    Math.floor(Date.now() / (windowSeconds * 1000)) * windowSeconds * 1000,
  );

  await db.execute(
    `INSERT INTO rate_limits (bucket, subject, window_start, hits)
     VALUES (?, ?, ?, 1)
     ON DUPLICATE KEY UPDATE hits = hits + 1`,
    [bucket, key, windowStart],
  );

  const row = await db.one(
    'SELECT hits FROM rate_limits WHERE bucket = ? AND subject = ? AND window_start = ?',
    [bucket, key, windowStart],
  );

  const hits = row ? row.hits : 1;
  const retryAfter = Math.ceil(
    (windowStart.getTime() + windowSeconds * 1000 - Date.now()) / 1000,
  );

  return { allowed: hits <= limit, hits, limit, retryAfter: Math.max(retryAfter, 1) };
}

/**
 * Look without counting.
 *
 * Used where a request must be rejected before it does any work — a check that
 * itself incremented the counter would let an attacker keep the door shut on
 * somebody else for ever by hammering it.
 */
async function peek(bucket, subject, { limit, windowSeconds }) {
  const key = String(subject).slice(0, 190).toLowerCase();
  const windowStart = new Date(
    Math.floor(Date.now() / (windowSeconds * 1000)) * windowSeconds * 1000,
  );
  const row = await db.one(
    'SELECT hits FROM rate_limits WHERE bucket = ? AND subject = ? AND window_start = ?',
    [bucket, key, windowStart],
  );
  const hits = row ? row.hits : 0;
  return { allowed: hits < limit, hits, limit };
}

/** Forget a bucket. Called after a success, so a good sign-in clears the count. */
async function clear(bucket, subject) {
  await db.execute('DELETE FROM rate_limits WHERE bucket = ? AND subject = ?', [
    bucket,
    String(subject).slice(0, 190).toLowerCase(),
  ]);
}

/** Drop windows nothing will read again. Called by the sweeper. */
async function sweep(olderThanHours = 48) {
  const result = await db.execute(
    'DELETE FROM rate_limits WHERE window_start < DATE_SUB(NOW(), INTERVAL ? HOUR)',
    [olderThanHours],
  );
  return result.affectedRows;
}

module.exports = { hit, peek, clear, sweep };
