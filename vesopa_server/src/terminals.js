/**
 * Terminals that know about each other: shared open bills, one clerk in one
 * place, and the time clock.
 *
 * Three groups of routes, and the tenancy rule differs between them because
 * the callers do:
 *
 *   /till/*     called by a commissioned till, authenticated with its terminal
 *               token. The office is read off the signed token and never off a
 *               query string -- these routes hand back what customers have
 *               ordered and who is on shift, so "guess an email" must not be a
 *               way in. This is the same rule /till/staff already follows.
 *
 *   /timesheets back office, session token, scoped to the signed-in office.
 *
 * Everything a till writes here is a *convenience*. A terminal that cannot
 * reach the server rings up, prints and settles exactly as it did before; it
 * loses sight of the other terminal's tables and says so. Nothing in this file
 * is allowed onto the path that takes money.
 */

const express = require('express');
const { requireAuth, requireTerminal } = require('./auth');

/** Longest basket we will carry. A bill this size is a runaway, not a round. */
const MAX_PAYLOAD_BYTES = 512 * 1024;

/** How long a tombstone is worth keeping. See schema_terminals.sql. */
const TOMBSTONE_DAYS = 1;

/**
 * The tills' half. Mounted at the root beside /till/orders, and authorised by
 * the terminal token rather than by a query string -- see the note above.
 */
function terminalRoutes({ pool, broadcast, secret }) {
  const router = express.Router();
  const terminal = requireTerminal(secret);

  /**
   * The next change number for an office.
   *
   * `INSERT ... ON DUPLICATE KEY UPDATE rev = rev + 1` then reading it back is
   * the only form of this that is safe with two tills writing at once: the
   * increment happens inside the row lock the statement already takes, so two
   * concurrent bills can never be handed the same rev. Reading first and
   * writing second is the version that loses a bill.
   */
  async function nextRev(conn, office) {
    await conn.execute(
      `INSERT INTO epos_open_bill_revs (office, rev) VALUES (?, 1)
         ON DUPLICATE KEY UPDATE rev = rev + 1`,
      [office]
    );
    const [[row]] = await conn.execute(
      'SELECT rev FROM epos_open_bill_revs WHERE office = ?',
      [office]
    );
    return Number(row.rev);
  }

  // -------------------------------------------------------------------------
  // Open bills
  // -------------------------------------------------------------------------

  /**
   * The change feed.
   *
   * `?since=` is a rev the caller has already seen, not a timestamp -- see the
   * schema for why a timestamp cannot do this job. `since=0` (or no since at
   * all) is a full refresh, which is what a terminal asks for when it starts
   * and after any spell offline long enough that it does not trust its cursor.
   *
   * Returns changed bills and retired ones in the same answer, because a
   * caller that received only the first would leave a settled table on the
   * plan for ever.
   */
  router.get('/till/open-bills', terminal, async (req, res, next) => {
    const office = req.office;
    const since = Number(req.query.since) || 0;

    try {
      // Housekeeping on the read path rather than a cron: this endpoint is
      // polled by every terminal in every venue, so it runs often enough, and a
      // scheduled job is one more thing to notice has stopped.
      await pool.execute(
        `DELETE FROM epos_open_bill_tombstones
          WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)`,
        [TOMBSTONE_DAYS]
      );

      const [bills] = await pool.query(
        `SELECT id, terminal, table_number, room_id, covers, staff_id,
                clerk_name, status, payload, total_minor, line_count, rev,
                claimed_at, updated_at
           FROM epos_open_bills
          WHERE office = ? AND rev > ?
          ORDER BY rev`,
        [office, since]
      );

      const [gone] = await pool.query(
        `SELECT id, rev, reason FROM epos_open_bill_tombstones
          WHERE office = ? AND rev > ?
          ORDER BY rev`,
        [office, since]
      );

      const [[head]] = await pool.query(
        'SELECT rev FROM epos_open_bill_revs WHERE office = ?',
        [office]
      );

      res.json({
        // The cursor to send back next time. Taken from the counter rather than
        // from the rows, so a poll that happened to see nothing still moves
        // forward and a terminal does not re-read the same page for ever.
        rev: head ? Number(head.rev) : 0,
        bills: bills.map((b) => ({
          ...b,
          rev: Number(b.rev),
          // Parsed here rather than by every caller. A payload that will not
          // parse is not allowed to take the whole feed down with it -- the
          // bill is served with a null basket and the terminal shows it as a
          // table it cannot open, which is recoverable at a counter.
          payload: safeParse(b.payload),
        })),
        removed: gone.map((g) => ({ ...g, rev: Number(g.rev) })),
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * Put a bill on the venue's shared plan, or update the one that is there.
   *
   * Idempotent by the till's own order id, so a retry after a timeout replaces
   * rather than duplicates. Last write wins: two terminals editing one bill at
   * the same time is prevented at the till by the claim below, and a rule any
   * more clever than this one would need conflict resolution that no clerk
   * could ever be shown the result of.
   */
  router.post('/till/open-bills', terminal, async (req, res, next) => {
    const office = req.office;
    const bill = req.body || {};
    if (!bill.id) return res.status(400).json({ error: 'A bill id is required' });

    const payload = JSON.stringify(bill.payload ?? {});
    if (Buffer.byteLength(payload, 'utf8') > MAX_PAYLOAD_BYTES) {
      return res.status(413).json({ error: 'That bill is too large to share.' });
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const rev = await nextRev(conn, office);

      await conn.execute(
        `INSERT INTO epos_open_bills
           (id, office, terminal, table_number, room_id, covers, staff_id,
            clerk_name, status, payload, total_minor, line_count, rev,
            claimed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE
           terminal = VALUES(terminal),
           table_number = VALUES(table_number),
           room_id = VALUES(room_id),
           covers = VALUES(covers),
           staff_id = VALUES(staff_id),
           clerk_name = VALUES(clerk_name),
           status = VALUES(status),
           payload = VALUES(payload),
           total_minor = VALUES(total_minor),
           line_count = VALUES(line_count),
           rev = VALUES(rev),
           claimed_at = VALUES(claimed_at)`,
        [
          bill.id,
          office,
          bill.terminal ?? null,
          bill.table_number ?? null,
          bill.room_id ?? null,
          bill.covers ?? null,
          bill.staff_id ?? null,
          bill.clerk_name ?? null,
          bill.status === 'parked' ? 'parked' : 'open',
          payload,
          Number(bill.total_minor) || 0,
          Number(bill.line_count) || 0,
          rev,
        ]
      );

      // A bill that comes back to life -- recalled from a table after being
      // settled and refunded, say -- must not stay retired, or every terminal
      // would delete it again on its next poll.
      await conn.execute(
        'DELETE FROM epos_open_bill_tombstones WHERE id = ? AND office = ?',
        [bill.id, office]
      );

      await conn.commit();
      broadcast({ type: 'open-bills.updated', rev }, { office });
      res.json({ ok: true, rev });
    } catch (err) {
      await conn.rollback().catch(() => {});
      next(err);
    } finally {
      conn.release();
    }
  });

  /**
   * The bill is settled, cancelled or merged away: take it off the plan.
   *
   * Answers ok for a bill that was never here. A terminal deleting a bill it
   * rang up entirely offline is the ordinary case, not an error, and a 404
   * would make it retry for ever.
   */
  router.delete('/till/open-bills/:id', terminal, async (req, res, next) => {
    const office = req.office;
    const id = req.params.id;
    const reason = ['settled', 'cancelled', 'merged'].includes(req.query.reason)
      ? req.query.reason
      : 'settled';

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const rev = await nextRev(conn, office);

      await conn.execute(
        'DELETE FROM epos_open_bills WHERE id = ? AND office = ?',
        [id, office]
      );
      await conn.execute(
        `INSERT INTO epos_open_bill_tombstones (id, office, rev, reason)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE rev = VALUES(rev), reason = VALUES(reason),
                                 created_at = NOW()`,
        [id, office, rev, reason]
      );

      await conn.commit();
      broadcast({ type: 'open-bills.updated', rev }, { office });
      res.json({ ok: true, rev });
    } catch (err) {
      await conn.rollback().catch(() => {});
      next(err);
    } finally {
      conn.release();
    }
  });

  /**
   * Take over a bill another terminal was holding.
   *
   * Two terminals must not edit one basket, and the honest way to enforce that
   * without a lock nobody can clear is to make taking it over an explicit act:
   * the terminal that claims it becomes the one that owns it, and the one that
   * had it sees `terminal` change on its next poll and lets go.
   */
  router.post('/till/open-bills/:id/claim', terminal, async (req, res, next) => {
    const office = req.office;
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const rev = await nextRev(conn, office);

      const [result] = await conn.execute(
        `UPDATE epos_open_bills
            SET terminal = ?, claimed_at = NOW(), rev = ?
          WHERE id = ? AND office = ?`,
        [req.body?.terminal ?? null, rev, req.params.id, office]
      );
      if (result.affectedRows === 0) {
        await conn.rollback();
        return res.status(404).json({ error: 'That bill is no longer open.' });
      }

      const [[bill]] = await conn.execute(
        `SELECT id, terminal, table_number, room_id, covers, staff_id,
                clerk_name, status, payload, total_minor, line_count, rev
           FROM epos_open_bills WHERE id = ? AND office = ?`,
        [req.params.id, office]
      );

      await conn.commit();
      broadcast({ type: 'open-bills.updated', rev }, { office });
      res.json({ ...bill, rev: Number(bill.rev), payload: safeParse(bill.payload) });
    } catch (err) {
      await conn.rollback().catch(() => {});
      next(err);
    } finally {
      conn.release();
    }
  });

  // -------------------------------------------------------------------------
  // Clerk sessions -- one clerk, one terminal
  // -------------------------------------------------------------------------

  /**
   * Sign a clerk on here, wherever they were before.
   *
   * The answer is the interesting part. It names the terminal they have just
   * been moved off and hands back the bill they had in hand, so the till that
   * called this can offer to bring their items with them. That is the whole of
   * "if they are signed on to one terminal and move to another the items will
   * follow them" -- and the reason it is one round trip rather than two is that
   * a clerk standing at a counter must not be able to be half-moved.
   *
   * A terminal that cannot reach the server signs the clerk on anyway. The
   * alternative is a till that will not open when the broadband is down, which
   * is a far worse fault than a clerk being live in two places for the length
   * of an outage.
   */
  router.post('/till/clerk-session', terminal, async (req, res, next) => {
    const office = req.office;
    const staffId = Number(req.body?.staff_id);
    const at = String(req.body?.terminal || '').trim();
    if (!staffId) return res.status(400).json({ error: 'staff_id is required' });
    if (!at) return res.status(400).json({ error: 'terminal is required' });

    try {
      const [[previous]] = await pool.query(
        `SELECT terminal, basket_id, signed_on_at FROM epos_clerk_sessions
          WHERE office = ? AND staff_id = ?`,
        [office, staffId]
      );

      await pool.execute(
        `INSERT INTO epos_clerk_sessions
           (office, staff_id, staff_name, terminal, basket_id, signed_on_at)
         VALUES (?, ?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE
           staff_name = VALUES(staff_name),
           terminal = VALUES(terminal),
           signed_on_at = NOW()`,
        [
          office,
          staffId,
          req.body?.staff_name ?? null,
          at,
          previous?.basket_id ?? null,
        ]
      );

      // Only offer to carry a basket that still exists and still has something
      // on it. Offering an empty one is a question with no useful answer, and
      // offering a settled one would put a paid-for round back on a screen.
      let basket = null;
      if (previous?.basket_id) {
        const [[held]] = await pool.query(
          `SELECT id, table_number, room_id, covers, staff_id, clerk_name,
                  status, payload, total_minor, line_count, rev
             FROM epos_open_bills
            WHERE id = ? AND office = ? AND line_count > 0`,
          [previous.basket_id, office]
        );
        if (held) basket = { ...held, rev: Number(held.rev), payload: safeParse(held.payload) };
      }

      // Everybody hears about it, including the terminal they left: that is how
      // the old till learns to put its screen back to the idle picture rather
      // than sitting on a bill that has walked off.
      broadcast({ type: 'clerk-session.changed', staffId, terminal: at }, { office });

      res.json({
        ok: true,
        moved: !!(previous && previous.terminal && previous.terminal !== at),
        previousTerminal: previous?.terminal ?? null,
        basket,
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * Remember what this clerk has in hand, so it can follow them.
   *
   * Split from the sign-on above because it happens constantly -- every time
   * the basket changes -- and must be cheap. `basket_id` null is "they are
   * holding nothing", which is what a completed sale leaves behind.
   */
  router.put('/till/clerk-session/basket', terminal, async (req, res, next) => {
    const staffId = Number(req.body?.staff_id);
    if (!staffId) return res.status(400).json({ error: 'staff_id is required' });
    try {
      await pool.execute(
        `UPDATE epos_clerk_sessions SET basket_id = ?
          WHERE office = ? AND staff_id = ?`,
        [req.body?.basket_id ?? null, req.office, staffId]
      );
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  /** Sign off. Idempotent: signing off somebody who is not on is not an error. */
  router.delete('/till/clerk-session/:staffId', terminal, async (req, res, next) => {
    try {
      await pool.execute(
        'DELETE FROM epos_clerk_sessions WHERE office = ? AND staff_id = ?',
        [req.office, Number(req.params.staffId) || 0]
      );
      broadcast(
        { type: 'clerk-session.changed', staffId: Number(req.params.staffId) },
        { office: req.office }
      );
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  /** Who is signed on where. Drawn on the Sign On sheet so a clerk can see it. */
  router.get('/till/clerk-sessions', terminal, async (req, res, next) => {
    try {
      const [rows] = await pool.query(
        `SELECT staff_id, staff_name, terminal, basket_id, signed_on_at
           FROM epos_clerk_sessions WHERE office = ? ORDER BY signed_on_at DESC`,
        [req.office]
      );
      res.json(rows);
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // The time clock
  // -------------------------------------------------------------------------

  /**
   * Who is on the clock, and what they have worked today.
   *
   * Both in one answer because the till draws them together: a list of names
   * with the ones already in marked as in, so clocking in and clocking out are
   * the same key rather than two a member of staff has to choose between.
   */
  router.get('/till/clock', terminal, async (req, res, next) => {
    try {
      const [open] = await pool.query(
        `SELECT id, staff_id, staff_name, clocked_in_at, in_terminal
           FROM epos_time_clock
          WHERE office = ? AND clocked_out_at IS NULL
          ORDER BY clocked_in_at`,
        [req.office]
      );
      const [today] = await pool.query(
        `SELECT id, staff_id, staff_name, clocked_in_at, clocked_out_at,
                in_terminal, out_terminal
           FROM epos_time_clock
          WHERE office = ? AND clocked_in_at >= CURDATE()
          ORDER BY clocked_in_at DESC`,
        [req.office]
      );
      res.json({ open, today });
    } catch (err) {
      next(err);
    }
  });

  /**
   * Clock in, or clock out.
   *
   * One endpoint and not two, because the till has one key. The state the
   * server holds decides which it is, so double-tapping cannot open two
   * shifts and cannot close one twice -- the failure a pair of endpoints
   * invites the first time somebody presses the wrong one.
   */
  router.post('/till/clock', terminal, async (req, res, next) => {
    const office = req.office;
    const staffId = Number(req.body?.staff_id);
    const at = req.body?.terminal ?? null;
    if (!staffId) return res.status(400).json({ error: 'staff_id is required' });

    try {
      const [[shift]] = await pool.query(
        `SELECT id, clocked_in_at FROM epos_time_clock
          WHERE office = ? AND staff_id = ? AND clocked_out_at IS NULL
          ORDER BY clocked_in_at DESC LIMIT 1`,
        [office, staffId]
      );

      if (shift) {
        await pool.execute(
          `UPDATE epos_time_clock
              SET clocked_out_at = NOW(), out_terminal = ?
            WHERE id = ?`,
          [at, shift.id]
        );
        broadcast({ type: 'clock.changed', staffId }, { office });
        return res.json({
          state: 'out',
          shiftId: shift.id,
          clockedInAt: shift.clocked_in_at,
        });
      }

      const [result] = await pool.execute(
        `INSERT INTO epos_time_clock
           (office, staff_id, staff_name, clocked_in_at, in_terminal)
         VALUES (?, ?, ?, NOW(), ?)`,
        [office, staffId, req.body?.staff_name ?? null, at]
      );
      broadcast({ type: 'clock.changed', staffId }, { office });
      res.json({ state: 'in', shiftId: result.insertId });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

/**
 * The back office's half: the timesheet, and a read-only look at the floor.
 * Mounted under /api on a session token, scoped to the signed-in office.
 */
function timesheetRoutes({ pool, broadcast, secret }) {
  const router = express.Router();
  const auth = requireAuth(secret);

  /** The back office's tenant key, as in src/backoffice.js. */
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

  // -------------------------------------------------------------------------
  // Back office: the timesheet
  // -------------------------------------------------------------------------

  /**
   * Shifts over a window, newest first, with the hours already worked out.
   *
   * The minutes are computed in SQL rather than in the browser so that an
   * export and the screen can never disagree, and an open shift reports its
   * minutes to now -- a manager looking at lunchtime wants to see what the
   * person on the floor has done so far, not a blank.
   */
  router.get('/timesheets', auth, async (req, res, next) => {
    try {
      const email = await tenantEmail(req);
      const office =
        req.user.role === 'admin' && req.query.office_email
          ? req.query.office_email
          : email;
      const from = req.query.from || null;
      const to = req.query.to || null;

      const [rows] = await pool.query(
        `SELECT id, staff_id, staff_name, clocked_in_at, clocked_out_at,
                in_terminal, out_terminal, adjusted_by, note,
                TIMESTAMPDIFF(MINUTE, clocked_in_at,
                              COALESCE(clocked_out_at, NOW())) AS minutes
           FROM epos_time_clock
          WHERE office = ?
            AND (? IS NULL OR clocked_in_at >= ?)
            AND (? IS NULL OR clocked_in_at < DATE_ADD(?, INTERVAL 1 DAY))
          ORDER BY clocked_in_at DESC
          LIMIT 1000`,
        [office, from, from, to, to]
      );
      res.json(rows);
    } catch (err) {
      next(err);
    }
  });

  /**
   * Correct a shift.
   *
   * Somebody forgets to clock out and goes home; without this the row runs for
   * ever and the week's total is nonsense. Every edit stamps `adjusted_by`, so
   * a corrected row is visibly a corrected row.
   */
  router.put('/timesheets/:id', auth, async (req, res, next) => {
    try {
      const email = await tenantEmail(req);
      const office =
        req.user.role === 'admin' && req.query.office_email
          ? req.query.office_email
          : email;

      const [result] = await pool.execute(
        `UPDATE epos_time_clock
            SET clocked_in_at  = COALESCE(?, clocked_in_at),
                clocked_out_at = ?,
                note = ?,
                adjusted_by = ?
          WHERE id = ? AND office = ?`,
        [
          req.body?.clocked_in_at || null,
          req.body?.clocked_out_at || null,
          req.body?.note ?? null,
          req.user.email,
          Number(req.params.id) || 0,
          office,
        ]
      );
      if (result.affectedRows === 0) {
        return res.status(404).json({ error: 'No such shift.' });
      }
      broadcast({ type: 'clock.changed' }, { office });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.delete('/timesheets/:id', auth, async (req, res, next) => {
    try {
      const email = await tenantEmail(req);
      const office =
        req.user.role === 'admin' && req.query.office_email
          ? req.query.office_email
          : email;
      await pool.execute(
        'DELETE FROM epos_time_clock WHERE id = ? AND office = ?',
        [Number(req.params.id) || 0, office]
      );
      broadcast({ type: 'clock.changed' }, { office });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  /**
   * What the floor looks like from the back office: every bill in play.
   *
   * Read-only, and deliberately so. A manager watching a busy room wants to
   * know that table 12 has been sitting on £84 for forty minutes; editing it
   * from a desk while a clerk has it open on a terminal is a different feature
   * with a much worse failure.
   */
  router.get('/open-bills', auth, async (req, res, next) => {
    try {
      const email = await tenantEmail(req);
      const office =
        req.user.role === 'admin' && req.query.office_email
          ? req.query.office_email
          : email;
      const [rows] = await pool.query(
        `SELECT id, terminal, table_number, room_id, covers, staff_id,
                clerk_name, status, total_minor, line_count, updated_at
           FROM epos_open_bills WHERE office = ?
          ORDER BY updated_at DESC`,
        [office]
      );
      res.json(rows);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

/** JSON that may not be JSON. See the feed above for why this cannot throw. */
function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

module.exports = { terminalRoutes, timesheetRoutes };
