const express = require('express');
const { requireAuth, requireTerminal } = require('./auth');

/**
 * The gym door.
 *
 * A member swipes a card and walks in. On the way out they swipe the same card
 * again. Nobody stands behind the till, so nothing here may ever wait to be
 * told what to do -- see schema_till_gym.sql for the whole of why that one fact
 * shapes the design.
 *
 * A SWIPE IS AN EVENT, NOT AN INSTRUCTION
 *
 * The till does not send "sign this member in" or "sign them out". It sends
 * "this card was read at this time", with an id of its own making, and the
 * server decides which of the two that was by looking at whether the member had
 * a visit open at that moment.
 *
 * That is not a stylistic choice. A gym door has to keep working when the
 * broadband does not, so a till with no network queues the swipe on its own
 * disk and sends it later -- possibly much later, possibly after the member has
 * already swiped out. An instruction replayed out of order signs somebody in
 * who left an hour ago. An event replayed out of order lands in the right place
 * in the day, because the time it carries is the time it happened.
 *
 * The queue is at-least-once, so the same swipe can arrive twice. `swipe_id`
 * and `left_swipe_id` carry unique indexes and are checked before anything
 * else, which makes a replay answer exactly what it answered the first time
 * rather than opening a second visit.
 *
 * TENANCY
 *
 *   /till/gym/*   a commissioned till, terminal token. The office comes off the
 *                 signed token and never off a query string: these routes name
 *                 members and record where they were.
 *   /api/gym/*    the back office, session token, scoped to the signed-in
 *                 office.
 *
 * NOTHING HERE EXISTS UNTIL A VENUE TURNS IT ON. `enabled` defaults to 0, and
 * every route below refuses with 404 while it is off -- not 403, because a pub
 * asking a gym question has not been forbidden, it has asked about a feature
 * that is not part of its system.
 */
function gymRoutes({ pool, broadcast, secret }) {
  const router = express.Router();

  const GYM_DEFAULTS = {
    // Off. See schema_till_gym.sql: this is the answer for every venue that is
    // not a gym, which is nearly all of them.
    enabled: 0,
    auto_close_hours: 4,
    debounce_seconds: 45,
    grace_days: 0,
    expiry_slip: 1,
    refuse_expired: 0,
    expiring_soon_days: 14,
    greeting_seconds: 6,
    show_photo: 1,
  };

  /**
   * Bounds for the numbers a manager can type.
   *
   * Every one of these is a number that, set badly, breaks the door silently at
   * a counter with nobody at it. A debounce of 0 makes a double-reading stripe
   * reader sign somebody in and out again; an auto-close of 0 closes every
   * visit the instant it opens. So they are clamped here as well as in the
   * form, because the form is not the only way a row gets written.
   */
  const BOUNDS = {
    auto_close_hours: [1, 24],
    debounce_seconds: [0, 600],
    grace_days: [0, 90],
    expiring_soon_days: [0, 120],
    greeting_seconds: [2, 30],
  };

  const auth = requireAuth(secret);
  const terminal = requireTerminal(secret);

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

  async function readSettings(office) {
    const [[row]] = await pool.query(
      'SELECT * FROM epos_gym_settings WHERE office = ?',
      [office]
    );
    return row || { office, ...GYM_DEFAULTS };
  }

  /**
   * The gym prefix, read from the card settings the rest of the till already
   * uses.
   *
   * It lives there rather than here on purpose. A prefix is what tells a till
   * which programme a card belongs to *before* it looks anything up, and the
   * till caches all five together in one blob; a fifth prefix kept somewhere
   * else would be a fifth thing to be out of date, on the one screen where
   * being out of date means an unknown card opens an enrol form at an unmanned
   * counter.
   */
  async function gymPrefix(office) {
    const [[row]] = await pool.query(
      'SELECT gym_prefix FROM epos_card_settings WHERE office = ?',
      [office]
    );
    return String((row && row.gym_prefix) || '');
  }

  /** What the reader typed, reduced to the digits on the card. */
  function cleanNumber(value) {
    return String(value ?? '')
      .trim()
      .replace(/^[;%B]+/, '')
      .replace(/[?].*$/, '')
      .split(/[=^]/)[0]
      .replace(/\D/g, '')
      .slice(0, 64);
  }

  /**
   * A time from the till, or now.
   *
   * The till stamps a swipe when it happens, which is the whole point of the
   * event design -- a swipe queued on an offline terminal carries the moment
   * somebody actually walked in, not the moment the broadband came back.
   *
   * Refused if it is in the future or more than a week old. A terminal whose
   * clock is wrong would otherwise write next March into the attendance report,
   * where it sits above every real visit for ever; a week is long enough to
   * cover any outage anybody will sit through and short enough that a clock set
   * to 1970 does not quietly become the venue's earliest member.
   */
  function stampedAt(value) {
    const now = Date.now();
    const at = value ? Date.parse(String(value)) : NaN;
    if (!Number.isFinite(at)) return new Date(now);
    if (at > now + 60_000) return new Date(now);
    if (at < now - 7 * 24 * 3600_000) return new Date(now);
    return new Date(at);
  }

  /** MySQL DATETIME, in the server's own zone, like every other write here. */
  function sqlTime(date) {
    const pad = (n) => String(n).padStart(2, '0');
    return (
      `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
      `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    );
  }

  /**
   * Close visits nobody swiped out of.
   *
   * Somebody who leaves without swiping would otherwise sit on the board as "in
   * the gym" for ever, and would contribute a fourteen-hour visit to the
   * attendance report. Marked `closed_by = 'auto'` rather than left looking like
   * a real departure, so a report can tell a measured visit from a guess.
   *
   * Run on every read of the board rather than on a timer. A sweep on a timer
   * is a second thing to deploy, to monitor and to forget; a sweep on read is
   * exactly as current as the screen that is asking, and the board is the only
   * place staleness would show.
   */
  async function sweep(office, settings) {
    const hours = Math.min(
      Math.max(Number(settings.auto_close_hours) || 4, 1),
      24
    );
    await pool.execute(
      `UPDATE epos_gym_visits
          SET left_at = entered_at + INTERVAL ? HOUR,
              closed_by = 'auto'
        WHERE office = ?
          AND left_at IS NULL
          AND entered_at < NOW() - INTERVAL ? HOUR`,
      [hours, office, hours]
    );
  }

  /**
   * Whether a membership has run out, allowing for the venue's grace days.
   *
   * A NULL expiry is never expired. That is the same rule the counter follows:
   * a venue that runs a gym on cards with no dates on them has members, not
   * expired members, and a door that turned them all away on the first morning
   * would be a door nobody opens again.
   */
  function expiryState(expiry, settings) {
    if (!expiry) return { expired: false, days: null };
    const day = 24 * 3600_000;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const on = new Date(expiry);
    on.setHours(0, 0, 0, 0);
    const days = Math.round((on.getTime() - today.getTime()) / day);
    const grace = Math.min(Math.max(Number(settings.grace_days) || 0, 0), 90);
    // Inclusive, like the membership renewal at the counter: the card works ON
    // the expiry date and expires the day after.
    return { expired: days + grace < 0, days };
  }

  /**
   * The gym has to be switched on for any of this to mean anything.
   *
   * 404 rather than 403. A pub that has never heard of the gym has not been
   * refused permission to use it -- there is no such thing here to refuse, and
   * a 403 would have somebody hunting through user roles for a permission that
   * does not exist.
   */
  function gymOff(res) {
    return res
      .status(404)
      .json({ error: 'The gym is not switched on for this venue.' });
  }

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------

  router.get('/api/gym/settings', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const settings = await readSettings(office);
      // The prefix comes back with the settings, and is saved through them,
      // even though it is stored on the card row. One page, one Save: a manager
      // switching the gym on and setting its prefix is doing one thing.
      res.json({ ...settings, gym_prefix: await gymPrefix(office) });
    } catch (e) {
      next(e);
    }
  });

  router.put('/api/gym/settings', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);

      const fields = Object.keys(GYM_DEFAULTS).filter((f) =>
        Object.prototype.hasOwnProperty.call(req.body, f)
      );

      if (fields.length) {
        const values = fields.map((field) => {
          if (BOUNDS[field]) {
            const [lo, hi] = BOUNDS[field];
            const n = Number(req.body[field]);
            return Math.min(
              Math.max(Number.isFinite(n) ? n : GYM_DEFAULTS[field], lo),
              hi
            );
          }
          return req.body[field] ? 1 : 0;
        });

        const cols = ['office', ...fields];
        await pool.execute(
          `INSERT INTO epos_gym_settings (${cols.map((c) => `\`${c}\``).join(',')})
           VALUES (${cols.map(() => '?').join(',')})
           ON DUPLICATE KEY UPDATE
             ${fields.map((f) => `\`${f}\`=VALUES(\`${f}\`)`).join(',')}`,
          [office, ...values]
        );
      }

      // The prefix, on the card settings row where the other four live.
      if (Object.prototype.hasOwnProperty.call(req.body, 'gym_prefix')) {
        const prefix = String(req.body.gym_prefix ?? '')
          .replace(/\D/g, '')
          .slice(0, 8);
        await pool.execute(
          `INSERT INTO epos_card_settings (office, gym_prefix)
           VALUES (?,?)
           ON DUPLICATE KEY UPDATE gym_prefix = VALUES(gym_prefix)`,
          [office, prefix]
        );
        // Both, because the till caches them separately and a manager who set a
        // prefix expects the door to start working without restarting a till.
        broadcast({ type: 'cards' });
      }

      broadcast({ type: 'gym' });
      const settings = await readSettings(office);
      res.json({ ...settings, gym_prefix: await gymPrefix(office) });
    } catch (e) {
      next(e);
    }
  });

  /**
   * The same settings, for a till.
   *
   * Sent whether the gym is on or off, and that is deliberate: `enabled: 0` is
   * the answer the till needs in order to take the Gym page away again. A 404
   * here would be indistinguishable from a server that is down, and the till
   * would go on showing a section the venue had just switched off.
   */
  router.get('/till/gym/settings', terminal, async (req, res, next) => {
    try {
      const settings = await readSettings(req.office);
      res.json({ ...settings, gym_prefix: await gymPrefix(req.office) });
    } catch (e) {
      next(e);
    }
  });

  // ---------------------------------------------------------------------------
  // The door
  // ---------------------------------------------------------------------------

  /**
   * What one visit looks like to everything that reads them.
   *
   * `in_now` rather than leaving every caller to work out what a null `left_at`
   * means. The board colours a row from it, the till colours a row from it, and
   * two implementations of "is this person in the gym" would eventually
   * disagree on the screen where it matters.
   */
  const VISIT_COLUMNS = `
    v.id, v.customer_id, v.member_no, v.member_name, v.card_number,
    v.entered_at, v.left_at, v.closed_by, v.entered_terminal, v.left_terminal,
    v.expired,
    DATE_FORMAT(v.membership_expiry, '%Y-%m-%d') AS membership_expiry,
    (v.left_at IS NULL) AS in_now,
    TIMESTAMPDIFF(MINUTE, v.entered_at, COALESCE(v.left_at, NOW())) AS minutes`;

  /**
   * A card was read at the door.
   *
   * Answers what the till should say and whether it should print, and records
   * the visit. The till does no deciding of its own beyond drawing the answer.
   */
  router.post('/till/gym/swipe', terminal, async (req, res, next) => {
    try {
      const office = req.office;
      const settings = await readSettings(office);
      if (!Number(settings.enabled)) return gymOff(res);

      const number = cleanNumber(req.body.card_number);
      if (!number) return res.status(400).json({ error: 'card_number is required' });

      const swipeId = String(req.body.swipe_id || '').slice(0, 64) || null;
      const at = stampedAt(req.body.at);
      const terminalName = String(req.body.terminal || '').slice(0, 120) || null;

      // ---- A replay answers what it answered the first time ----------------
      //
      // Checked before anything else, and against both ends of a visit. The
      // till's outbox is at-least-once by design, so this is not an edge case
      // to be defended against -- it is the ordinary consequence of a swipe
      // whose reply was lost on the way back.
      if (swipeId) {
        const [[already]] = await pool.query(
          `SELECT ${VISIT_COLUMNS},
                  (v.swipe_id = ?) AS opened_by_this
             FROM epos_gym_visits v
            WHERE v.office = ? AND (v.swipe_id = ? OR v.left_swipe_id = ?)
            LIMIT 1`,
          [swipeId, office, swipeId, swipeId]
        );
        if (already) {
          return res.json({
            outcome: Number(already.opened_by_this) ? 'in' : 'out',
            replay: true,
            visit: already,
            member_name: already.member_name,
            print_slip: false,
          });
        }
      }

      // ---- Who is holding it -----------------------------------------------
      const [[member]] = await pool.query(
        `SELECT id, name, member_no, photo_url,
                DATE_FORMAT(membership_expiry, '%Y-%m-%d') AS membership_expiry
           FROM epos_customers
          WHERE email_key = ? AND card_number = ?
          LIMIT 1`,
        [office, number]
      );

      if (!member) {
        // Recorded nowhere and answered plainly. A gym card that belongs to
        // nobody is a card somebody is standing at a door holding, and "we do
        // not know that card" is the only true thing to say -- but it is not a
        // visit, so it does not go in the attendance report.
        return res.json({
          outcome: 'unknown',
          card_number: number,
          print_slip: false,
        });
      }

      const { expired, days } = expiryState(member.membership_expiry, settings);

      // ---- Is this the way out? --------------------------------------------
      const [[open]] = await pool.query(
        `SELECT id, entered_at,
                TIMESTAMPDIFF(SECOND, entered_at, ?) AS age_seconds
           FROM epos_gym_visits
          WHERE office = ? AND customer_id = ? AND left_at IS NULL
          ORDER BY entered_at DESC
          LIMIT 1`,
        [sqlTime(at), office, member.id]
      );

      if (open) {
        const debounce = Math.min(
          Math.max(Number(settings.debounce_seconds) || 0, 0),
          600
        );
        // Two reads of one card, seconds apart: the reader double-read, or the
        // member swiped again because the first one did not look like it
        // worked. Signing them out would leave the gym holding nobody and the
        // report holding a three-second visit -- and nobody is there to notice.
        if (Number(open.age_seconds) < debounce) {
          return res.json({
            outcome: 'ignored',
            member_name: member.name,
            reason: 'debounce',
            print_slip: false,
          });
        }

        await pool.execute(
          `UPDATE epos_gym_visits
              SET left_at = ?, left_swipe_id = ?, left_terminal = ?,
                  closed_by = 'card'
            WHERE id = ? AND left_at IS NULL`,
          [sqlTime(at), swipeId, terminalName, open.id]
        );

        const [[visit]] = await pool.query(
          `SELECT ${VISIT_COLUMNS} FROM epos_gym_visits v WHERE v.id = ?`,
          [open.id]
        );
        broadcast({ type: 'gym' });
        return res.json({
          outcome: 'out',
          member_name: member.name,
          photo_url: settings.show_photo ? member.photo_url : null,
          visit,
          minutes: visit ? Number(visit.minutes) : null,
          print_slip: false,
        });
      }

      // ---- On the way in ----------------------------------------------------
      //
      // An expired card prints a slip either way. Whether it also opens the
      // door is the venue's own switch, and the default is to let them in and
      // flag it: this till is not a turnstile, so a record saying the visit did
      // not happen would simply be false.
      const printSlip = expired && Boolean(Number(settings.expiry_slip));

      if (expired && Number(settings.refuse_expired)) {
        return res.json({
          outcome: 'expired',
          refused: true,
          member_name: member.name,
          member_no: member.member_no,
          photo_url: settings.show_photo ? member.photo_url : null,
          membership_expiry: member.membership_expiry,
          expired_days: days == null ? null : Math.abs(days),
          print_slip: printSlip,
        });
      }

      const [result] = await pool.execute(
        `INSERT INTO epos_gym_visits
           (office, swipe_id, customer_id, member_no, member_name, card_number,
            entered_at, entered_terminal, membership_expiry, expired)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [
          office,
          swipeId,
          member.id,
          member.member_no,
          member.name,
          number,
          sqlTime(at),
          terminalName,
          member.membership_expiry || null,
          expired ? 1 : 0,
        ]
      );

      const [[visit]] = await pool.query(
        `SELECT ${VISIT_COLUMNS} FROM epos_gym_visits v WHERE v.id = ?`,
        [result.insertId]
      );
      broadcast({ type: 'gym' });

      const soon = Math.min(
        Math.max(Number(settings.expiring_soon_days) || 0, 0),
        120
      );
      res.json({
        outcome: expired ? 'expired' : 'in',
        refused: false,
        member_name: member.name,
        member_no: member.member_no,
        photo_url: settings.show_photo ? member.photo_url : null,
        membership_expiry: member.membership_expiry,
        expired_days: expired && days != null ? Math.abs(days) : null,
        // Days left, but only inside the window the venue set. A number that
        // appears eleven months out is a number members stop reading.
        expiring_in_days:
          !expired && days != null && soon > 0 && days <= soon ? days : null,
        visit,
        print_slip: printSlip,
      });
    } catch (e) {
      next(e);
    }
  });

  /**
   * Who is in the gym, and who has been and gone.
   *
   * One list, not two. The board colours each row from `in_now`, which is the
   * venue's own description of what they want to look at: green for the people
   * who are here, red for the ones who have left.
   *
   * Today by default, because that is the question a board on a wall answers.
   */
  async function board(office, settings, { date } = {}) {
    await sweep(office, settings);

    const day = /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? date : null;

    // Open visits are always included, whatever day they started on. A member
    // who swiped in at 11pm and is still here at half past midnight is in the
    // gym, and a board that dropped them at the stroke of twelve would be a
    // board that loses people.
    const [rows] = await pool.query(
      `SELECT ${VISIT_COLUMNS}, c.photo_url
         FROM epos_gym_visits v
         LEFT JOIN epos_customers c ON c.id = v.customer_id
        WHERE v.office = ?
          AND (v.left_at IS NULL OR DATE(v.entered_at) = ${day ? '?' : 'CURDATE()'})
        ORDER BY v.left_at IS NULL DESC, v.entered_at DESC
        LIMIT 500`,
      day ? [office, day] : [office]
    );
    return rows;
  }

  router.get('/till/gym/board', terminal, async (req, res, next) => {
    try {
      const settings = await readSettings(req.office);
      if (!Number(settings.enabled)) return gymOff(res);
      res.json(await board(req.office, settings, { date: req.query.date }));
    } catch (e) {
      next(e);
    }
  });

  router.get('/api/gym/board', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const settings = await readSettings(office);
      if (!Number(settings.enabled)) return gymOff(res);
      res.json(await board(office, settings, { date: req.query.date }));
    } catch (e) {
      next(e);
    }
  });

  /**
   * The members whose cards open the door, for a till to keep.
   *
   * A gym door has to work with the broadband down, and a door that could not
   * say a member's name offline would greet a paying member with "recorded"
   * and nothing else. So the till caches this list and answers from it while it
   * is on its own -- name, number and the expiry date, which is everything the
   * greeting and the expired slip need.
   *
   * Only members who hold a card, because only they can be at the door. The
   * photograph is deliberately NOT here: it is a URL the till already knows how
   * to fetch, and a roster carrying a few hundred images is a sync that fails
   * on a slow line at the moment it is needed most.
   */
  router.get('/till/gym/members', terminal, async (req, res, next) => {
    try {
      const settings = await readSettings(req.office);
      if (!Number(settings.enabled)) return gymOff(res);

      const prefix = await gymPrefix(req.office);
      // An empty prefix matches nothing, exactly as it does when a card is
      // classified. Without this guard `LIKE '%'` would hand the till every
      // customer in the venue as a gym member.
      if (!prefix) return res.json([]);

      const [rows] = await pool.query(
        `SELECT id, name, member_no, card_number, photo_url,
                DATE_FORMAT(membership_expiry, '%Y-%m-%d') AS membership_expiry
           FROM epos_customers
          WHERE email_key = ? AND card_number LIKE CONCAT(?, '%')
          ORDER BY name
          LIMIT 5000`,
        [req.office, prefix]
      );
      res.json(rows);
    } catch (e) {
      next(e);
    }
  });

  // ---------------------------------------------------------------------------
  // Reports
  // ---------------------------------------------------------------------------

  /**
   * How often members have been using the gym.
   *
   * The venue's own words, and the report is shaped by taking them literally:
   * one row per member, how many times, when they last came, and how that
   * compares with the length of the period. `per_week` is what makes the list
   * sortable into something useful -- "42 visits" means one thing over a month
   * and another over a year.
   *
   * Visits closed by the sweep are counted but their length is not averaged in.
   * Somebody who forgot to swipe out still turned up; the four hours the sweep
   * wrote is a boundary, not a measurement, and averaging it in would quietly
   * inflate every session length on the page.
   */
  router.get('/api/gym/attendance', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const settings = await readSettings(office);
      if (!Number(settings.enabled)) return gymOff(res);

      const day = (value, fallback) =>
        /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? String(value) : fallback;

      const back = new Date();
      back.setDate(back.getDate() - 29);
      const from = day(req.query.from, back.toISOString().slice(0, 10));
      const to = day(req.query.to, new Date().toISOString().slice(0, 10));

      const [rows] = await pool.query(
        `SELECT v.customer_id,
                COALESCE(c.name, MAX(v.member_name)) AS member_name,
                MAX(v.member_no) AS member_no,
                MAX(v.card_number) AS card_number,
                COUNT(*) AS visits,
                SUM(v.expired) AS expired_visits,
                MIN(v.entered_at) AS first_visit,
                MAX(v.entered_at) AS last_visit,
                COUNT(DISTINCT DATE(v.entered_at)) AS days_attended,
                ROUND(AVG(CASE WHEN v.closed_by = 'card'
                          THEN TIMESTAMPDIFF(MINUTE, v.entered_at, v.left_at)
                          END)) AS avg_minutes,
                SUM(v.closed_by = 'auto') AS unclosed,
                DATE_FORMAT(c.membership_expiry, '%Y-%m-%d') AS membership_expiry
           FROM epos_gym_visits v
           LEFT JOIN epos_customers c ON c.id = v.customer_id
          WHERE v.office = ?
            AND DATE(v.entered_at) BETWEEN ? AND ?
          GROUP BY v.customer_id, c.name, c.membership_expiry
          ORDER BY visits DESC, last_visit DESC
          LIMIT 1000`,
        [office, from, to]
      );

      // The busiest hours and days of the period, which is the other half of
      // "how frequently" -- a gym asks it about the room as well as about the
      // member, because that is what staffing is decided on.
      const [byHour] = await pool.query(
        `SELECT HOUR(entered_at) AS hour, COUNT(*) AS visits
           FROM epos_gym_visits
          WHERE office = ? AND DATE(entered_at) BETWEEN ? AND ?
          GROUP BY HOUR(entered_at) ORDER BY hour`,
        [office, from, to]
      );
      const [byDay] = await pool.query(
        `SELECT DATE_FORMAT(entered_at, '%Y-%m-%d') AS day, COUNT(*) AS visits
           FROM epos_gym_visits
          WHERE office = ? AND DATE(entered_at) BETWEEN ? AND ?
          GROUP BY day ORDER BY day`,
        [office, from, to]
      );

      const days =
        Math.round(
          (Date.parse(`${to}T00:00:00`) - Date.parse(`${from}T00:00:00`)) /
            86_400_000
        ) + 1;
      const weeks = Math.max(days / 7, 1 / 7);

      res.json({
        from,
        to,
        days,
        members: rows.map((r) => ({
          ...r,
          visits: Number(r.visits),
          per_week: Math.round((Number(r.visits) / weeks) * 10) / 10,
        })),
        by_hour: byHour,
        by_day: byDay,
      });
    } catch (e) {
      next(e);
    }
  });

  /**
   * Who has expired, and when.
   *
   * The back-office half of the slip that prints at the door. The slip tells
   * whoever empties the printer; this tells whoever is chasing renewals, and
   * the same page carries the ones that are about to go so the chase can start
   * before somebody is turned away.
   *
   * `last_visit` is on every row because it is the question that follows
   * immediately: a member who expired in January and has not been since is a
   * different conversation from one who was here yesterday.
   */
  router.get('/api/gym/expiries', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const settings = await readSettings(office);
      if (!Number(settings.enabled)) return gymOff(res);

      const prefix = await gymPrefix(office);
      if (!prefix) return res.json({ expired: [], soon: [], soon_days: 0 });

      const soon = Math.min(
        Math.max(Number(settings.expiring_soon_days) || 0, 0),
        120
      );
      const grace = Math.min(Math.max(Number(settings.grace_days) || 0, 0), 90);

      const [rows] = await pool.query(
        `SELECT c.id, c.name, c.member_no, c.card_number, c.phone, c.email,
                DATE_FORMAT(c.membership_expiry, '%Y-%m-%d') AS membership_expiry,
                DATEDIFF(c.membership_expiry, CURDATE()) AS days,
                /*
                 * The office as a bound parameter, NOT as c.email_key.
                 *
                 * epos_gym_visits.office is declared utf8mb4_general_ci -- as
                 * every office column in this schema is, so that an email
                 * address compares against its neighbours. epos_customers
                 * predates that convention and carries the server default,
                 * which on MariaDB 11.4 is utf8mb4_uca1400_ai_ci. Comparing
                 * the two columns is Illegal mix of collations and a 500 --
                 * on the live database only, which is why a green test suite
                 * said nothing about it.
                 *
                 * A literal takes the collation of the column it is compared
                 * with, so binding the office sidesteps it and reads more
                 * plainly besides: this query is already scoped to one office.
                 *
                 * No backticks in this comment, deliberately. The whole SQL
                 * string is a template literal, so one backtick here ends it
                 * and the syntax error is reported thirty lines further down.
                 */
                (SELECT MAX(v.entered_at) FROM epos_gym_visits v
                  WHERE v.office = ? AND v.customer_id = c.id) AS last_visit,
                (SELECT COUNT(*) FROM epos_gym_visits v2
                  WHERE v2.office = ? AND v2.customer_id = c.id
                    AND v2.entered_at > NOW() - INTERVAL 90 DAY) AS visits_90d
           FROM epos_customers c
          WHERE c.email_key = ?
            AND c.card_number LIKE CONCAT(?, '%')
            AND c.membership_expiry IS NOT NULL
            AND DATEDIFF(c.membership_expiry, CURDATE()) <= ?
          ORDER BY c.membership_expiry DESC
          LIMIT 2000`,
        [office, office, office, prefix, soon]
      );

      res.json({
        soon_days: soon,
        grace_days: grace,
        expired: rows.filter((r) => Number(r.days) + grace < 0),
        soon: rows.filter((r) => Number(r.days) + grace >= 0),
      });
    } catch (e) {
      next(e);
    }
  });

  /**
   * Close a visit by hand.
   *
   * For the one case the sweep cannot help with: a member who left hours ago
   * and whose row a manager is looking at now. Stamped `office` so the
   * attendance report never treats the length as measured.
   */
  router.post('/api/gym/visits/:id/close', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const settings = await readSettings(office);
      if (!Number(settings.enabled)) return gymOff(res);

      // Scoped by office in the WHERE, not checked first and updated after. The
      // check-then-write version is the one that edits another venue's row when
      // two requests interleave.
      const [result] = await pool.execute(
        `UPDATE epos_gym_visits
            SET left_at = NOW(), closed_by = 'office'
          WHERE id = ? AND office = ? AND left_at IS NULL`,
        [Number(req.params.id) || 0, office]
      );
      if (!result.affectedRows) {
        return res.status(404).json({ error: 'No open visit with that id.' });
      }
      broadcast({ type: 'gym' });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  return router;
}

module.exports = { gymRoutes };
