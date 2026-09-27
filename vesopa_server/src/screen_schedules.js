/**
 * Scheduled screen changes (2026-09-24).
 *
 * "Can we add a scheduler to screen programming? ICR Touch do this, where you
 * can schedule the changes to take effect on the date you choose."
 *
 * ICR's TouchOffice Web lets a change be made live or "set on a schedule to
 * take place at some point in the future, such as the start of the month".
 * This is that, for Vesopa's screen editor: lay a screen out, press
 * "Schedule…" instead of Save, pick a date and time, and the layout as it is
 * on screen is kept aside -- a whole copy, not a diff -- until then.
 *
 * WHY A COPY AND NOT A DIFF. A diff against today's layout would be applied to
 * whatever the layout has become by Monday, which is not what anybody saw
 * when they pressed Schedule. A copy applies exactly what was on the screen.
 * The editor warns when a screen with a pending change is saved in the
 * meantime, because that save is what the scheduled copy will replace.
 *
 * WHEN IT APPLIES. A minute's timer on the server, and also the moment a till
 * or the editor reads that venue's screens -- so a till that asks at 06:00:05
 * gets Monday's layout even if the timer has not come round. Applying goes
 * through saveScreenButtons(), the editor's own save, and pushes 'screens' to
 * the venue's tills like any save.
 *
 * TIMES are stored in UTC (effective_at) and compared with UTC_TIMESTAMP(), so
 * the database's time zone never matters. The browser sends an ISO string
 * made from the manager's local date and time.
 *
 * Better than ICR in two ways worth saying: every pending change is listed in
 * one place with who scheduled it and when it will land, and any of them can
 * be applied now or cancelled with one press.
 */

const crypto = require('crypto');
const express = require('express');

const { requireAuth } = require('./auth');
const { saveScreenButtons } = require('./screens');

/** How far ahead a change may be scheduled: a year is plenty. */
const MAX_AHEAD_MS = 366 * 24 * 60 * 60 * 1000;

/** A JS Date as the 'YYYY-MM-DD HH:MM:SS' UTC string MariaDB stores. */
function utcSql(d) {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/** A stored UTC DATETIME (Date or string) back as an ISO string with Z. */
function isoFromSql(v) {
  if (!v) return null;
  if (v instanceof Date) {
    // mysql2 builds Dates in the process's zone from a zone-less DATETIME;
    // read the wall-clock parts back as UTC.
    const pad = (n) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}T${pad(v.getHours())}:${pad(v.getMinutes())}:${pad(v.getSeconds())}Z`;
  }
  return `${String(v).replace(' ', 'T').slice(0, 19)}Z`;
}

/**
 * When a request asks a change to happen. Refuses the past (a minute's grace
 * for a slow click), nonsense, and anything more than a year out.
 */
function parseWhen(raw, now = new Date()) {
  const d = new Date(String(raw || ''));
  if (Number.isNaN(d.getTime())) return { error: 'Choose a date and time for the change.' };
  if (d.getTime() < now.getTime() - 60 * 1000) return { error: 'That time has already passed. Choose a time in the future, or just save.' };
  if (d.getTime() > now.getTime() + MAX_AHEAD_MS) return { error: 'A change can be scheduled up to a year ahead.' };
  return { when: d };
}

function rowToJson(r) {
  return {
    id: r.id,
    screen_id: Number(r.screen_id),
    screen_name: r.screen_name ?? null,
    surface: r.surface ?? null,
    note: r.note || '',
    effective_at: isoFromSql(r.effective_at),
    status: r.status,
    rows: r.grid_rows === null || r.grid_rows === undefined ? null : Number(r.grid_rows),
    cols: r.grid_cols === null || r.grid_cols === undefined ? null : Number(r.grid_cols),
    button_count: (() => {
      try {
        return JSON.parse(r.buttons || '[]').length;
      } catch {
        return 0;
      }
    })(),
    created_by: r.created_by || '',
    created_at: isoFromSql(r.created_at),
    applied_at: isoFromSql(r.applied_at),
    error: r.error || null,
  };
}

/**
 * Apply one scheduled change. Resizes the screen first when the copy was taken
 * at another size (the buttons are normalised against the stored grid, so the
 * order matters -- the editor's own Save does the same two steps).
 */
async function applyOne(pool, row) {
  const [[screen]] = await pool.query('SELECT * FROM epos_screens WHERE id = ? AND office = ?', [row.screen_id, row.office]);
  if (!screen) {
    await pool.execute(
      "UPDATE epos_screen_schedules SET status = 'failed', error = ?, applied_at = UTC_TIMESTAMP() WHERE id = ? AND status = 'pending'",
      ['The screen was deleted before the change was due.', row.id]
    );
    return false;
  }
  let buttons;
  try {
    buttons = JSON.parse(row.buttons || '[]');
  } catch {
    buttons = null;
  }
  if (!Array.isArray(buttons)) {
    await pool.execute(
      "UPDATE epos_screen_schedules SET status = 'failed', error = ?, applied_at = UTC_TIMESTAMP() WHERE id = ? AND status = 'pending'",
      ['The saved layout could not be read.', row.id]
    );
    return false;
  }
  // Claim it first, so two servers (or the timer and a till read at once)
  // never both apply the same change.
  const [claim] = await pool.execute(
    "UPDATE epos_screen_schedules SET status = 'applying' WHERE id = ? AND status = 'pending'",
    [row.id]
  );
  if (claim && claim.affectedRows === 0) return false;

  try {
    const rows = Number(row.grid_rows);
    const cols = Number(row.grid_cols);
    if (rows > 0 && cols > 0 && (rows !== Number(screen.grid_rows) || cols !== Number(screen.grid_cols))) {
      await pool.execute('UPDATE epos_screens SET grid_rows = ?, grid_cols = ? WHERE id = ? AND office = ?', [rows, cols, screen.id, row.office]);
      screen.grid_rows = rows;
      screen.grid_cols = cols;
    }
    await saveScreenButtons(pool, row.office, screen, buttons);
    await pool.execute("UPDATE epos_screen_schedules SET status = 'applied', applied_at = UTC_TIMESTAMP(), error = NULL WHERE id = ?", [row.id]);
    return true;
  } catch (e) {
    await pool.execute(
      "UPDATE epos_screen_schedules SET status = 'failed', error = ?, applied_at = UTC_TIMESTAMP() WHERE id = ?",
      [String(e.message || e).slice(0, 250), row.id]
    );
    return false;
  }
}

/**
 * Apply every change that is due -- for one venue, or (office null) for all.
 * Returns the offices whose screens moved, so the caller can tell their tills.
 * Never throws: a schedule that cannot be applied is marked failed, and a
 * database without the table yet (not migrated) is simply nothing to do.
 */
async function applyDueSchedules(pool, office = null) {
  let due;
  try {
    [due] = await pool.query(
      `SELECT * FROM epos_screen_schedules
        WHERE status = 'pending' AND effective_at <= UTC_TIMESTAMP()${office ? ' AND office = ?' : ''}
        ORDER BY effective_at, created_at
        LIMIT 200`,
      office ? [office] : []
    );
  } catch (e) {
    if (e && (e.code === 'ER_NO_SUCH_TABLE' || e.errno === 1146)) return [];
    throw e;
  }
  const moved = new Set();
  for (const row of due || []) {
    // eslint-disable-next-line no-await-in-loop -- in order: two changes to one screen land oldest first
    if (await applyOne(pool, row)) moved.add(row.office);
  }
  return [...moved];
}

function screenScheduleRoutes({ pool, broadcast, secret, tickMs = 60 * 1000, now = () => new Date() }) {
  const router = express.Router();
  const auth = requireAuth(secret);

  async function tenantEmail(req) {
    if (req.user.officeId) {
      const [[office]] = await pool.query('SELECT contact_email FROM offices WHERE id = ?', [req.user.officeId]);
      if (office) return office.contact_email;
    }
    return req.user.email;
  }

  const tell = (offices) => {
    for (const office of offices) broadcast({ type: 'screens', office }, { office });
  };

  /** Apply what is due for this venue, then carry on to the real handler. */
  async function catchUp(office) {
    try {
      tell(await applyDueSchedules(pool, office));
    } catch (e) {
      console.error('screen schedules: catch-up failed', e.message);
    }
  }

  // Every schedule this venue has: pending first (soonest first), then the
  // last few that applied, failed or were cancelled, so "did Monday's change
  // go in?" has an answer on the same page.
  router.get('/screens/schedules', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      await catchUp(office);
      const [rows] = await pool.query(
        `SELECT s.*, sc.name AS screen_name, sc.surface
           FROM epos_screen_schedules s
           LEFT JOIN epos_screens sc ON sc.id = s.screen_id AND sc.office = s.office
          WHERE s.office = ?
          ORDER BY (s.status = 'pending') DESC,
                   CASE WHEN s.status = 'pending' THEN s.effective_at END ASC,
                   s.created_at DESC
          LIMIT 60`,
        [office]
      );
      res.json(rows.map(rowToJson));
    } catch (e) {
      next(e);
    }
  });

  // Keep the layout as it is in the editor, to go live at `effective_at`.
  router.post('/screens/:id/schedule', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const [[screen]] = await pool.query('SELECT * FROM epos_screens WHERE id = ? AND office = ?', [req.params.id, office]);
      if (!screen) return res.status(404).json({ error: 'No such screen' });
      const { when, error } = parseWhen(req.body?.effective_at, now());
      if (error) return res.status(400).json({ error });
      const buttons = Array.isArray(req.body?.buttons) ? req.body.buttons : null;
      if (!buttons) return res.status(400).json({ error: 'Nothing to schedule: the layout was not sent.' });
      const rows = Number(req.body?.rows) || Number(screen.grid_rows);
      const cols = Number(req.body?.cols) || Number(screen.grid_cols);
      const id = crypto.randomUUID();
      await pool.execute(
        `INSERT INTO epos_screen_schedules
           (id, office, screen_id, note, effective_at, grid_rows, grid_cols, buttons, status, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, UTC_TIMESTAMP())`,
        [
          id,
          office,
          screen.id,
          String(req.body?.note || '').trim().slice(0, 160) || null,
          utcSql(when),
          rows,
          cols,
          JSON.stringify(buttons),
          String(req.user.name || req.user.email || '').slice(0, 120) || null,
        ]
      );
      const [[row]] = await pool.query(
        `SELECT s.*, sc.name AS screen_name, sc.surface FROM epos_screen_schedules s
           LEFT JOIN epos_screens sc ON sc.id = s.screen_id AND sc.office = s.office
          WHERE s.id = ? AND s.office = ?`,
        [id, office]
      );
      res.status(201).json(rowToJson(row || { id, screen_id: screen.id, effective_at: utcSql(when), status: 'pending', buttons: JSON.stringify(buttons) }));
    } catch (e) {
      next(e);
    }
  });

  // Put a pending change live now, rather than waiting for its time.
  router.post('/screens/schedules/:id/apply', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const [[row]] = await pool.query("SELECT * FROM epos_screen_schedules WHERE id = ? AND office = ? AND status = 'pending'", [req.params.id, office]);
      if (!row) return res.status(404).json({ error: 'No pending change by that id.' });
      const ok = await applyOne(pool, row);
      if (!ok) {
        const [[after]] = await pool.query('SELECT error FROM epos_screen_schedules WHERE id = ?', [row.id]);
        return res.status(409).json({ error: (after && after.error) || 'The change could not be applied.' });
      }
      tell([office]);
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // Cancel a pending change. Kept in the list as cancelled.
  router.delete('/screens/schedules/:id', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const [r] = await pool.execute(
        "UPDATE epos_screen_schedules SET status = 'cancelled' WHERE id = ? AND office = ? AND status = 'pending'",
        [req.params.id, office]
      );
      if (!r || !r.affectedRows) return res.status(404).json({ error: 'No pending change by that id.' });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // The till's read of its screens catches up first, so a till that asks just
  // after the hour never gets the old layout while the timer comes round.
  router.get('/till/screens', async (req, res, next) => {
    const office = String(req.query.office || '').trim();
    if (office) await catchUp(office);
    next();
  });
  router.get('/screens', auth, async (req, res, next) => {
    try {
      await catchUp(await tenantEmail(req));
    } catch {
      // The real handler answers; a catch-up that failed is logged there.
    }
    next();
  });

  if (tickMs > 0) {
    const timer = setInterval(() => {
      applyDueSchedules(pool)
        .then(tell)
        .catch((e) => console.error('screen schedules: tick failed', e.message));
    }, tickMs);
    if (timer.unref) timer.unref();
  }

  return router;
}

module.exports = { screenScheduleRoutes, applyDueSchedules, parseWhen, utcSql, isoFromSql };
