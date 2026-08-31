/**
 * Reports that run themselves.
 *
 * A manager who has to remember to open the back office every Monday morning
 * and press Run is a manager who has the figures on the Mondays they remember.
 * This is the other half of reports.js: the same builders, fired on a clock and
 * delivered by email.
 *
 * HOW IT FIRES
 *
 * Every schedule carries a `next_run_at`, computed when it is saved and again
 * after every run. A tick once a minute asks for active schedules whose
 * `next_run_at` has passed, which is one indexed query rather than a walk over
 * every schedule working out whether today is the day.
 *
 * That design has one property worth stating plainly: **a missed window is run
 * late, not skipped.** If the server was down at 08:30 the schedule is still
 * due at 09:15 and goes out then. A report that silently did not happen is the
 * failure this feature exists to prevent, so arriving late beats not arriving.
 * The window it covers is resolved from the time it was *due*, not the time it
 * ran, so a late "Yesterday" report still covers yesterday.
 *
 * WHAT IS RECORDED
 *
 * Every attempt writes a row to `bo_report_runs` — sent, failed, or no_mail —
 * with the addresses and the window. "The Monday report didn't arrive" is a
 * question a venue asks, and it is unanswerable without that.
 */

const express = require('express');

const { requireAuth } = require('./auth');
const { sendMail, mailEnabled } = require('./mailer');
const {
  REPORTS,
  FORMATS,
  RANGES,
  runReport,
  displayDateTime,
  fileNameFor,
} = require('./reports');

/** How often a schedule can repeat. */
const FREQUENCIES = {
  daily: { label: 'Daily' },
  weekly: { label: 'Weekly' },
  monthly: { label: 'Monthly' },
  quarterly: { label: 'Quarterly' },
  yearly: { label: 'Yearly' },
};

/**
 * The periods a schedule may cover.
 *
 * A subset of reports.js's [RANGES]: `custom` is deliberately absent, because a
 * fixed pair of dates on a repeating schedule sends the same report for ever.
 * That is never what anybody means and it is a mistake nobody notices, since
 * the mail keeps arriving.
 */
const SCHEDULE_PERIODS = Object.fromEntries(
  Object.entries(RANGES).filter(([key]) => key !== 'custom')
);

/** "08:30" from 510, and back. See the column comment in schema_reports.sql. */
const minuteToClock = (minutes) => {
  const safe = Math.max(0, Math.min(24 * 60 - 1, Math.trunc(Number(minutes) || 0)));
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`;
};

function clockToMinute(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text || '').trim());
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/**
 * When this schedule should next fire, strictly after `after`.
 *
 * Strictly after, which is the whole of not sending the same report twice: a
 * run that finishes at 08:30:02 must not compute a next time of 08:30 today and
 * immediately be due again.
 *
 * Monthly and quarterly step by calendar month from the schedule's own start,
 * so a schedule created on the 31st lands on the 28th in February rather than
 * on the 3rd of March. `setMonth` overflows, so the day is clamped by hand.
 */
function nextRunAfter({ frequency, runAtMinute, after = new Date(), anchor }) {
  const hours = Math.floor(runAtMinute / 60);
  const minutes = runAtMinute % 60;

  const at = (date) => {
    const out = new Date(date);
    out.setHours(hours, minutes, 0, 0);
    return out;
  };

  const step = {
    daily: 1,
    weekly: 7,
  }[frequency];

  if (step) {
    let candidate = at(after);
    // A weekly schedule keeps the weekday it was created on, which is what
    // "every Monday" means to the person who set it up on a Monday.
    if (frequency === 'weekly' && anchor) {
      const wanted = new Date(anchor).getDay();
      while (candidate.getDay() !== wanted) {
        candidate.setDate(candidate.getDate() + 1);
        candidate = at(candidate);
      }
    }
    while (candidate <= after) {
      candidate.setDate(candidate.getDate() + step);
      candidate = at(candidate);
    }
    return candidate;
  }

  const months = { monthly: 1, quarterly: 3, yearly: 12 }[frequency];
  if (!months) return null;

  const base = anchor ? new Date(anchor) : new Date(after);
  const day = base.getDate();

  let year = after.getFullYear();
  let month = after.getMonth();
  for (let i = 0; i < 64; i++) {
    // Day 0 of the next month is the last day of this one — the leap-year-proof
    // way to clamp the 31st into a 30-day month.
    const lastDay = new Date(year, month + 1, 0).getDate();
    const candidate = at(new Date(year, month, Math.min(day, lastDay)));
    if (candidate > after) {
      // Only accept a month that is on the schedule's own cadence: a quarterly
      // report is every third month from where it started, not every third
      // month of the calendar.
      const sinceAnchor =
        (year - base.getFullYear()) * 12 + (month - base.getMonth());
      if (sinceAnchor >= 0 && sinceAnchor % months === 0) return candidate;
    }
    month += 1;
    if (month > 11) {
      month = 0;
      year += 1;
    }
  }
  return null;
}

/** MySQL DATETIME in local time. Mirrors reports.js. */
function sqlDateTime(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/**
 * Split a typed list of addresses.
 *
 * Commas, semicolons, newlines and spaces all separate, because all four are
 * what people paste. Validation is deliberately loose — one regex — since the
 * only thing that can really tell a good address from a bad one is trying it,
 * and the run log records what happened.
 */
function parseRecipients(text) {
  const parts = String(text || '')
    .split(/[,;\n\r\s]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const good = [];
  const bad = [];
  for (const part of parts) {
    if (/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(part)) good.push(part);
    else bad.push(part);
  }
  return { good, bad, all: parts };
}

/**
 * Validate what the five-step form posted.
 *
 * Returns `{ error }` or `{ value }`. One function for create and update, so
 * the two cannot disagree about what a valid schedule is.
 */
function validateSchedule(body) {
  const name = String(body.name || '').trim();
  if (!name) return { error: 'Give the report a name.' };
  if (name.length > 120) return { error: 'That name is too long.' };

  if (!REPORTS[body.report_key]) {
    return { error: 'Choose a report to run.' };
  }
  if (!FORMATS[body.format]) {
    return { error: 'Choose a format: PDF, CSV or XLS.' };
  }
  if (!FREQUENCIES[body.frequency]) {
    return { error: 'Choose how often it should run.' };
  }
  if (!SCHEDULE_PERIODS[body.period]) {
    return { error: 'Choose which period the report should cover.' };
  }

  const runAtMinute =
    typeof body.run_at_minute === 'number'
      ? Math.trunc(body.run_at_minute)
      : clockToMinute(body.time);
  if (runAtMinute === null || runAtMinute < 0 || runAtMinute > 24 * 60 - 1) {
    return { error: 'Give it a time of day, like 08:30.' };
  }

  const { good, bad } = parseRecipients(body.recipients);
  if (!good.length) {
    return { error: 'Give at least one email address to send it to.' };
  }
  if (bad.length) {
    return { error: `"${bad[0]}" is not an email address.` };
  }

  return {
    value: {
      name,
      description: String(body.description || '').trim().slice(0, 500) || null,
      report_key: body.report_key,
      format: body.format,
      frequency: body.frequency,
      run_at_minute: runAtMinute,
      period: body.period,
      recipients: good.join(', '),
      active: body.active === false || body.active === 0 ? 0 : 1,
    },
  };
}

/**
 * Run one schedule and deliver it.
 *
 * `dueAt` is the moment the schedule was *supposed* to fire, and the window is
 * resolved from it rather than from the clock. A "Yesterday" report that the
 * server got to at 00:05 the following night must still cover yesterday, not
 * the day before.
 *
 * Never throws. A schedule that fails must not take the tick down with it — the
 * other venues' reports are still due — so the failure is recorded against the
 * run and the loop carries on.
 */
async function runSchedule({
  pool,
  schedule,
  dueAt = new Date(),
  send = sendMail,
  canSend = mailEnabled,
}) {
  const format = FORMATS[schedule.format] || FORMATS.pdf;
  const { good: recipients } = parseRecipients(schedule.recipients);

  let status = 'sent';
  let detail = null;
  let covered = null;

  try {
    const [[office]] = await pool.query(
      'SELECT name FROM offices WHERE contact_email = ? LIMIT 1',
      [schedule.office]
    );

    const report = await runReport({
      pool,
      office: schedule.office,
      siteName: (office && office.name) || schedule.office,
      report: schedule.report_key,
      period: schedule.period,
      now: dueAt,
    });
    covered = { from: report.from, to: report.to };

    const body = await format.render(report);

    // Asked through the same seam the sending goes through, so a test that
    // supplies a transport is not then told there isn't one.
    if (!canSend()) {
      status = 'no_mail';
      detail =
        'The report was built but SMTP is not configured on this server, so ' +
        'nothing could be sent.';
    } else {
      const sent = await send({
        to: recipients.join(', '),
        subject: `${schedule.name} — ${report.name}, ${displayDateTime(report.from)}`,
        html:
          `<p>${escapeHtml(schedule.name)}</p>` +
          `<p>${escapeHtml(report.name)} for ${escapeHtml(report.site)},<br>` +
          `${displayDateTime(report.from)} to ${displayDateTime(report.to)}.</p>` +
          '<p>The report is attached.</p>' +
          '<p style="color:#888;font-size:12px">Sent automatically by Vesopa EPOS. ' +
          'To stop it, remove the schedule in the back office under ' +
          'Reports &rsaquo; Scheduled reports.</p>',
        text:
          `${schedule.name}\n\n${report.name} for ${report.site}\n` +
          `${displayDateTime(report.from)} to ${displayDateTime(report.to)}\n\n` +
          'The report is attached.',
        attachments: [
          {
            filename: fileNameFor(report, schedule.format),
            content: body,
            contentType: format.contentType,
          },
        ],
      });
      if (!sent) {
        status = 'failed';
        detail = 'The mail server refused the message.';
      } else {
        detail = `Sent to ${recipients.length} recipient${recipients.length === 1 ? '' : 's'}.`;
      }
    }
  } catch (e) {
    status = 'failed';
    detail = String(e && e.message ? e.message : e).slice(0, 500);
  }

  await pool.execute(
    `INSERT INTO bo_report_runs
       (schedule_id, office, status, detail, recipients, covered_from, covered_to)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      schedule.id,
      schedule.office,
      status,
      detail,
      recipients.join(', '),
      covered ? sqlDateTime(covered.from) : null,
      covered ? sqlDateTime(covered.to) : null,
    ]
  );

  return { status, detail };
}

const escapeHtml = (text) =>
  String(text).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );

/**
 * Fire everything that is due.
 *
 * Exported so a test can drive it directly, and so the "Run now" button can
 * reuse exactly the path the clock takes rather than a second one that can
 * behave differently on the day it matters.
 */
async function tick({ pool, now = new Date(), send = sendMail, canSend = mailEnabled }) {
  const [due] = await pool.query(
    `SELECT * FROM bo_report_schedules
      WHERE active = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
      ORDER BY next_run_at
      LIMIT 20`,
    [sqlDateTime(now)]
  );

  for (const schedule of due) {
    // The window comes from when it was due, not from when we got to it.
    const dueAt = schedule.next_run_at ? new Date(schedule.next_run_at) : now;

    // Advanced *before* the run, not after. A report that throws must not be
    // retried every minute for ever — one failure is a failure, sixty an hour
    // is an outage of its own, and the run log has the reason either way.
    const next = nextRunAfter({
      frequency: schedule.frequency,
      runAtMinute: schedule.run_at_minute,
      after: now,
      anchor: schedule.created_at,
    });
    await pool.execute(
      `UPDATE bo_report_schedules
          SET last_run_at = ?, next_run_at = ?
        WHERE id = ?`,
      [sqlDateTime(now), next ? sqlDateTime(next) : null, schedule.id]
    );

    await runSchedule({ pool, schedule, dueAt, send, canSend });
  }

  return due.length;
}

/**
 * Start the clock.
 *
 * A minute is the resolution a schedule is set at, so checking more often buys
 * nothing. `unref` is deliberate: this timer must never be the reason the
 * process refuses to exit on a deploy.
 */
function startScheduler({ pool, intervalMs = 60_000 }) {
  const timer = setInterval(() => {
    tick({ pool }).catch((e) => {
      console.error('[reports] scheduled run failed:', e.message);
    });
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

function reportScheduleRoutes({ pool, secret }) {
  const router = express.Router();
  const auth = requireAuth(secret);

  async function tenantEmail(req) {
    if (req.user.officeId) {
      const [[office]] = await pool.query(
        'SELECT contact_email FROM offices WHERE id = ?',
        [req.user.officeId]
      );
      if (office) return office.contact_email;
    }
    return req.user.email;
  }

  /** The shape the browser draws a row from. */
  const present = (row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    report_key: row.report_key,
    report_label: (REPORTS[row.report_key] || {}).label || row.report_key,
    format: row.format,
    frequency: row.frequency,
    frequency_label: (FREQUENCIES[row.frequency] || {}).label || row.frequency,
    period: row.period,
    period_label: (SCHEDULE_PERIODS[row.period] || {}).label || row.period,
    time: minuteToClock(row.run_at_minute),
    run_at_minute: row.run_at_minute,
    recipients: row.recipients,
    active: !!row.active,
    last_run_at: row.last_run_at,
    next_run_at: row.next_run_at,
  });

  /** The dropdowns the five-step form is built from. */
  router.get('/reports/schedule-options', auth, (_req, res) => {
    res.json({
      reports: Object.entries(REPORTS).map(([key, value]) => ({
        key,
        label: value.label,
      })),
      formats: Object.entries(FORMATS).map(([key, value]) => ({
        key,
        label: value.label,
      })),
      frequencies: Object.entries(FREQUENCIES).map(([key, value]) => ({
        key,
        label: value.label,
      })),
      periods: Object.entries(SCHEDULE_PERIODS).map(([key, value]) => ({
        key,
        label: value.label,
      })),
      mailEnabled: mailEnabled(),
    });
  });

  router.get('/reports/schedules', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const [rows] = await pool.query(
        `SELECT * FROM bo_report_schedules WHERE office = ? ORDER BY name`,
        [office]
      );
      res.json(rows.map(present));
    } catch (e) {
      next(e);
    }
  });

  router.post('/reports/schedules', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const { error, value } = validateSchedule(req.body);
      if (error) return res.status(400).json({ error });

      const next_run_at = nextRunAfter({
        frequency: value.frequency,
        runAtMinute: value.run_at_minute,
        after: new Date(),
      });

      const [result] = await pool.execute(
        `INSERT INTO bo_report_schedules
           (office, name, description, report_key, format, frequency,
            run_at_minute, period, recipients, active, next_run_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          office,
          value.name,
          value.description,
          value.report_key,
          value.format,
          value.frequency,
          value.run_at_minute,
          value.period,
          value.recipients,
          value.active,
          next_run_at ? sqlDateTime(next_run_at) : null,
        ]
      );
      res.status(201).json({ id: result.insertId });
    } catch (e) {
      next(e);
    }
  });

  router.put('/reports/schedules/:id', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const { error, value } = validateSchedule(req.body);
      if (error) return res.status(400).json({ error });

      // Recomputed on every save. Changing the time from 08:30 to 07:00 must
      // move the next run, not take effect the run after next.
      const next_run_at = nextRunAfter({
        frequency: value.frequency,
        runAtMinute: value.run_at_minute,
        after: new Date(),
      });

      const [result] = await pool.execute(
        `UPDATE bo_report_schedules
            SET name = ?, description = ?, report_key = ?, format = ?,
                frequency = ?, run_at_minute = ?, period = ?, recipients = ?,
                active = ?, next_run_at = ?
          WHERE id = ? AND office = ?`,
        [
          value.name,
          value.description,
          value.report_key,
          value.format,
          value.frequency,
          value.run_at_minute,
          value.period,
          value.recipients,
          value.active,
          next_run_at ? sqlDateTime(next_run_at) : null,
          req.params.id,
          office,
        ]
      );
      // Nothing matched means it belongs to another office. Said rather than
      // reported as a success that changed nothing.
      if (!result.affectedRows) return res.status(404).json({ error: 'Not found' });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  router.delete('/reports/schedules/:id', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const [result] = await pool.execute(
        'DELETE FROM bo_report_schedules WHERE id = ? AND office = ?',
        [req.params.id, office]
      );
      if (!result.affectedRows) return res.status(404).json({ error: 'Not found' });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  /** What happened, most recent first. The answer to "it didn't arrive". */
  router.get('/reports/schedules/:id/runs', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const [rows] = await pool.query(
        `SELECT r.* FROM bo_report_runs r
          WHERE r.schedule_id = ? AND r.office = ?
          ORDER BY r.ran_at DESC
          LIMIT 50`,
        [req.params.id, office]
      );
      res.json(rows);
    } catch (e) {
      next(e);
    }
  });

  /**
   * Send one now.
   *
   * The same path the clock takes, deliberately — a "Run now" that worked
   * through a second implementation would prove nothing about the schedule.
   * The next due time is left alone: this is a test send, not the run.
   */
  router.post('/reports/schedules/:id/run', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const [[schedule]] = await pool.query(
        'SELECT * FROM bo_report_schedules WHERE id = ? AND office = ?',
        [req.params.id, office]
      );
      if (!schedule) return res.status(404).json({ error: 'Not found' });

      const outcome = await runSchedule({ pool, schedule });
      res.json(outcome);
    } catch (e) {
      next(e);
    }
  });

  return router;
}

module.exports = {
  FREQUENCIES,
  SCHEDULE_PERIODS,
  minuteToClock,
  clockToMinute,
  nextRunAfter,
  parseRecipients,
  validateSchedule,
  runSchedule,
  tick,
  startScheduler,
  reportScheduleRoutes,
};
