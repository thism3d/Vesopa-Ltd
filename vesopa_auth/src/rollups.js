/**
 * Daily figures, computed once and read for ever.
 *
 * THE RULE THIS FILE EXISTS TO KEEP: a dashboard that runs a `GROUP BY` over
 * every raw event is the thing that falls over first on a busy Saturday — and
 * then the dashboard IS the outage. `login_events` is kept for thirteen months
 * because `/account/history` has to be able to answer "was that me?", which is
 * a lot of rows to scan to draw a bar chart nobody is watching.
 *
 * So the chart reads `login_event_daily`: one row per day per method per
 * outcome. The scan happens here, at most once an hour, over a window of days
 * rather than over everything.
 *
 * TODAY IS ALWAYS RECOMPUTED, and yesterday with it. Today is incomplete by
 * definition, and yesterday can still gain rows for a few minutes after
 * midnight — a rollup that writes a day once and never revisits it quietly
 * loses whatever arrived late. Recomputing a bounded window is cheap; being
 * wrong about last night's figures is not.
 *
 * NOTHING HERE MAY BREAK A PAGE. Every function swallows its own errors: a
 * dashboard that cannot draw a chart should show the rest of itself, not a 500.
 */

const db = require('./db');

/** How far back a recompute reaches. */
const WINDOW_DAYS = 3;

/** How often reading the dashboard is allowed to trigger one. */
const MIN_GAP_MS = 60 * 60 * 1000;

/**
 * Recompute the last few days.
 *
 * `INSERT … ON DUPLICATE KEY UPDATE` rather than delete-then-insert: a rollup
 * that deletes first has a window, however short, in which the dashboard reads
 * zero and somebody screenshots it.
 */
async function run({ days = WINDOW_DAYS } = {}) {
  const window = Math.max(1, Math.min(400, Number(days) || WINDOW_DAYS));

  await db.execute(
    `INSERT INTO login_event_daily (day, method, outcome, total)
     SELECT DATE(created_at), method, outcome, COUNT(*)
       FROM login_events
      WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
      GROUP BY DATE(created_at), method, outcome
     ON DUPLICATE KEY UPDATE total = VALUES(total)`,
    [window],
  );

  await db.execute(
    `INSERT INTO signup_daily (day, total)
     SELECT DATE(created_at), COUNT(*)
       FROM users
      WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
      GROUP BY DATE(created_at)
     ON DUPLICATE KEY UPDATE total = VALUES(total)`,
    [window],
  );

  await db.execute(
    `INSERT INTO rollup_state (name, ran_at) VALUES ('login_daily', NOW())
     ON DUPLICATE KEY UPDATE ran_at = NOW()`,
  );
}

/**
 * Run it if it has not run recently.
 *
 * Called from the dashboard, so the figures are never more than an hour stale
 * without anybody having to install a cron job on a server the owner asked not
 * to be changed. When there is a scheduler, this becomes the fallback rather
 * than the mechanism.
 */
async function refreshIfStale() {
  try {
    const state = await db.one("SELECT ran_at FROM rollup_state WHERE name = 'login_daily'");
    if (state && Date.now() - new Date(state.ran_at).getTime() < MIN_GAP_MS) return false;
    await run();
    return true;
  } catch (error) {
    console.error('[rollups] not refreshed:', error.message);
    return false;
  }
}

/**
 * Backfill everything, for the first run on a database that already has events.
 *
 * Deliberately not called from a page: it is the one query here that scans the
 * whole table, and it belongs in a deploy step rather than in a request.
 */
async function backfill() {
  const oldest = await db.one('SELECT MIN(created_at) AS oldest FROM login_events');
  if (!oldest || !oldest.oldest) return 0;
  const days = Math.ceil((Date.now() - new Date(oldest.oldest).getTime()) / 86400000) + 1;
  await run({ days: Math.min(days, 400) });
  return days;
}

/**
 * The method mix over a window, from the rollups.
 *
 * Ordered by how often each was used, because "which way do people actually
 * sign in" is the question this answers — and a chart sorted by name buries it.
 */
async function methodMix(days = 30) {
  return db.query(
    `SELECT method, outcome, SUM(total) AS total
       FROM login_event_daily
      WHERE day >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
      GROUP BY method, outcome
      ORDER BY total DESC
      LIMIT 20`,
    [Math.max(1, Math.min(400, Number(days) || 30))],
  );
}

/**
 * A day-by-day series for a sparkline, with the empty days filled in.
 *
 * A chart that skips days with no events draws a straight line through a
 * weekend and reports it as steady traffic. The gap is the information.
 */
async function series(days = 14) {
  const window = Math.max(2, Math.min(120, Number(days) || 14));
  const [events, signups] = await Promise.all([
    db.query(
      `SELECT day, SUM(total) AS total, SUM(IF(outcome = 'success', total, 0)) AS good
         FROM login_event_daily
        WHERE day >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
        GROUP BY day ORDER BY day`,
      [window - 1],
    ),
    db.query(
      `SELECT day, total FROM signup_daily
        WHERE day >= DATE_SUB(CURDATE(), INTERVAL ? DAY) ORDER BY day`,
      [window - 1],
    ),
  ]);

  const key = (date) => date.toISOString().slice(0, 10);
  const byDay = new Map(events.map((row) => [key(new Date(row.day)), row]));
  const signupsByDay = new Map(signups.map((row) => [key(new Date(row.day)), Number(row.total)]));

  const out = [];
  for (let i = window - 1; i >= 0; i -= 1) {
    const date = new Date(Date.now() - i * 86400000);
    const day = key(date);
    const row = byDay.get(day);
    out.push({
      day,
      total: row ? Number(row.total) : 0,
      good: row ? Number(row.good) : 0,
      signups: signupsByDay.get(day) || 0,
    });
  }
  return out;
}

module.exports = { run, refreshIfStale, backfill, methodMix, series, WINDOW_DAYS };
