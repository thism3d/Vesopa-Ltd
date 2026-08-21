/**
 * Vesopa Kitchen — the server half.
 *
 * Three audiences, three routers, deliberately kept apart because they are
 * authorised differently and confusing them is how a wall screen ends up able
 * to read a venue's takings:
 *
 *   kitchenRoutes      the back office, on a session token. Creates the logins
 *                      and the screens, and can watch the board.
 *   kitchenAppRoutes   the screens themselves, on a kitchen token. Read the
 *                      board, bump, recall, rush. Nothing else exists to them.
 *   tillKitchenRoutes  the tills, unauthenticated like /till/orders. Push
 *                      tickets in.
 *
 * See vesopa_epos_kitchen/docs/architecture.md for why a ticket is one row per
 * fire rather than one per station, and why its delivery mode lives on the
 * till-settings row.
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const { requireAuth, requireTerminal } = require('./auth');

/**
 * The stations a screen may watch.
 *
 * Six, matching the till's printer slots and the back office's product editor.
 * A seventh here would let a manager point a screen at a station no product can
 * be routed to, and the emptiness would be discovered during service.
 *
 * The receipt printer is deliberately absent: a product routed there prints at
 * the counter, which is the whole point of it, and a counter is not a kitchen.
 */
const KP_STATIONS = ['kp1', 'kp2', 'kp3', 'kp4', 'kp5', 'kp6'];

/** Where a station's tickets come out. See schema_kitchen.sql. */
const DELIVERY_MODES = ['printer', 'screen', 'both'];

/**
 * How long a kitchen screen stays signed in.
 *
 * Ninety days, and deliberately long. The alternative is a screen bolted to a
 * wall above a fryer that signs itself out at seven o'clock on a Friday because
 * a token aged out — a kitchen blinded during the busiest service of the week,
 * by a security measure protecting a list of what has been ordered for dinner.
 */
const KITCHEN_TOKEN_TTL = '90d';

/**
 * Express middleware for the routes only a signed-in kitchen screen may call.
 *
 * The mirror of `requireTerminal`: it refuses a back-office session token, and
 * `requireAuth` refuses this one. So a token lifted off a screen in a kitchen
 * opens the board for that venue and nothing else at all.
 */
function requireKitchen(secret) {
  return (req, res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) {
      return res.status(401).json({ error: 'This screen is not signed in' });
    }

    try {
      const claims = jwt.verify(token, secret);
      if (claims.scope !== 'kitchen' || !claims.office) {
        return res.status(401).json({ error: 'Not a kitchen token' });
      }
      req.kitchen = claims;
      req.office = claims.office;
      next();
    } catch {
      res.status(401).json({ error: 'This screen needs to be signed in again' });
    }
  };
}

/** The station keys in a stored comma-separated list, unknown names dropped. */
function parseStations(raw) {
  if (!raw) return [];
  const seen = new Set(
    String(raw)
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => KP_STATIONS.includes(s))
  );
  // Station order, not the order they happened to be typed in, so two screens
  // configured the same way read the same way.
  return KP_STATIONS.filter((s) => seen.has(s));
}

/** The storable form. Null for "every station", which is what empty means. */
function formatStations(list) {
  const stations = parseStations(Array.isArray(list) ? list.join(',') : list);
  return stations.length ? stations.join(',') : null;
}

/**
 * Assemble tickets, their lines and their per-station progress.
 *
 * Three queries and a stitch rather than one join, because a join would repeat
 * every ticket header once per line per station and the board is re-fetched
 * every thirty seconds by every screen in the building.
 */
async function loadTickets(pool, ids) {
  if (ids.length === 0) return [];

  const holes = ids.map(() => '?').join(', ');

  const [tickets] = await pool.query(
    `SELECT id, order_id, ticket_no, kind, table_number, room_name, staff_name,
            covers, note, rushed, placed_at, created_at
       FROM epos_kitchen_tickets
      WHERE id IN (${holes})`,
    ids
  );

  const [lines] = await pool.query(
    `SELECT id, ticket_id, seq, quantity, name, note, stations
       FROM epos_kitchen_ticket_lines
      WHERE ticket_id IN (${holes})
      ORDER BY ticket_id, seq`,
    ids
  );

  const [states] = await pool.query(
    `SELECT ticket_id, station, status, done_at, done_by
       FROM epos_kitchen_ticket_stations
      WHERE ticket_id IN (${holes})`,
    ids
  );

  const linesByTicket = new Map();
  for (const line of lines) {
    if (!linesByTicket.has(line.ticket_id)) linesByTicket.set(line.ticket_id, []);
    linesByTicket.get(line.ticket_id).push({
      id: line.id,
      seq: line.seq,
      quantity: Number(line.quantity),
      name: line.name,
      note: line.note,
      stations: parseStations(line.stations),
    });
  }

  const statesByTicket = new Map();
  for (const state of states) {
    if (!statesByTicket.has(state.ticket_id)) {
      statesByTicket.set(state.ticket_id, []);
    }
    statesByTicket.get(state.ticket_id).push({
      station: state.station,
      status: state.status,
      doneAt: state.done_at,
      doneBy: state.done_by,
    });
  }

  return tickets.map((t) => ({
    id: t.id,
    orderId: t.order_id,
    ticketNo: t.ticket_no,
    kind: t.kind,
    tableNumber: t.table_number,
    roomName: t.room_name,
    staffName: t.staff_name,
    covers: t.covers,
    note: t.note,
    rushed: t.rushed === 1,
    placedAt: t.placed_at,
    lines: linesByTicket.get(t.id) || [],
    stations: statesByTicket.get(t.id) || [],
  }));
}

/**
 * The board for one office: everything still open, plus what has been completed
 * recently enough to still be recalled.
 *
 * `recallMinutes` is the screen's own recall window. Capped at a day: a screen
 * asking for a year of completed orders would drag the whole service history
 * across the wire every thirty seconds.
 */
async function loadBoard(pool, office, recallMinutes) {
  const minutes = Math.min(1440, Math.max(1, Number(recallMinutes) || 60));

  // One pass, grouped by ticket:
  //
  //   SUM(status <> 'done') > 0   still has work outstanding somewhere
  //   MAX(done_at) >= cutoff      finished, recently enough to still recall
  //
  // The second clause is `MAX` rather than "every station done": a ticket whose
  // grill is finished and whose fryer is not is caught by the first clause
  // anyway, and a screen watching only the grill needs to see it in its own
  // Completed tab. Deciding *whose* work is outstanding is the client's job —
  // it knows which stations it watches. See Ticket.completedAtFor.
  //
  // Driven off epos_kitchen_tickets with the office filter on the outside, so
  // it reads one venue's rows rather than grouping every venue's stations and
  // then discarding all but one.
  const [rows] = await pool.query(
    `SELECT t.id
       FROM epos_kitchen_tickets t
       JOIN epos_kitchen_ticket_stations s ON s.ticket_id = t.id
      WHERE t.office = ?
      GROUP BY t.id
     HAVING SUM(s.status <> 'done') > 0
         OR MAX(s.done_at) >= DATE_SUB(NOW(), INTERVAL ? MINUTE)
      ORDER BY t.rushed DESC, t.placed_at ASC`,
    [office, minutes]
  );

  // Housekeeping, at most once an hour per process and never awaited.
  purgeOldTickets(pool);

  const tickets = await loadTickets(pool, rows.map((r) => r.id));

  // The ORDER BY above is lost to the IN () lookup, so it is restated here.
  const rank = new Map(rows.map((r, i) => [r.id, i]));
  tickets.sort((a, b) => rank.get(a.id) - rank.get(b.id));
  return tickets;
}

/**
 * Throw away tickets nobody can reach any more.
 *
 * Without this the table grows for the life of the installation: the board only
 * ever reads the last hour, so everything older is dead weight that still has
 * to be skipped by the index.
 *
 * A week, not a day, and not a night. A week is long enough that a support call
 * about "the kitchen never got Saturday's order" can still be answered from the
 * data, and short enough that a busy venue's table stays small. Nothing else
 * reads these rows — takings live in epos_orders, and are untouched by this.
 *
 * Fired lazily from the board fetch rather than on a timer, at most once an
 * hour per process. A cron entry would be one more thing to install on a
 * server; a delete that runs when somebody is already looking at the kitchen is
 * one fewer.
 */
const PURGE_EVERY_MS = 60 * 60 * 1000;
const PURGE_AFTER_DAYS = 7;
let lastPurge = 0;

function purgeOldTickets(pool) {
  const now = Date.now();
  if (now - lastPurge < PURGE_EVERY_MS) return;
  lastPurge = now;

  // Deliberately not awaited: this is housekeeping and a screen waiting on it
  // would be a screen waiting on a delete. The lines and station rows go with
  // it through ON DELETE CASCADE.
  pool
    .execute(
      `DELETE FROM epos_kitchen_tickets
        WHERE placed_at < DATE_SUB(NOW(), INTERVAL ? DAY)
        LIMIT 5000`,
      [PURGE_AFTER_DAYS]
    )
    .catch((e) => console.error('kitchen ticket purge failed', e));
}

/** What this venue calls each station, from the row the till already reads. */
async function stationNames(pool, office) {
  const [[row]] = await pool.query(
    `SELECT printer_name_kp1, printer_name_kp2, printer_name_kp3,
            printer_name_kp4, printer_name_kp5, printer_name_kp6
       FROM epos_till_settings WHERE office = ?`,
    [office]
  );
  if (!row) return {};
  const names = {};
  for (const station of KP_STATIONS) {
    const name = (row[`printer_name_${station}`] || '').trim();
    if (name) names[station] = name;
  }
  return names;
}

// ---------------------------------------------------------------------------
// The back office
// ---------------------------------------------------------------------------

function kitchenRoutes({ pool, broadcast, secret }) {
  const router = express.Router();
  const auth = requireAuth(secret);

  /** The tenant key: the office's contact email, as every other route uses. */
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

  // ---- Logins -------------------------------------------------------------

  router.get('/kitchen/users', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const [rows] = await pool.query(
        `SELECT id, username, display_name, active, last_seen_at, created_at
           FROM epos_kitchen_users
          WHERE office = ?
          ORDER BY username`,
        [office]
      );
      res.json(rows);
    } catch (e) {
      next(e);
    }
  });

  /**
   * Whether a username is usable.
   *
   * Lower case, no spaces, and short. This is typed on glass with a finger, by
   * somebody wearing gloves, so every character it does not need is a character
   * that will be got wrong at six o'clock on a Saturday.
   */
  function validUsername(raw) {
    const name = String(raw || '').trim().toLowerCase();
    if (name.length < 2) return null;
    if (name.length > 60) return null;
    // `@` and `+` are allowed because venues do use an email address as the
    // login for the screen in the office — it is the one string everybody
    // there already knows. Still no spaces and no upper case: this is typed
    // one character at a time on glass, and a capital costs a shift tap.
    if (!/^[a-z0-9._+@-]+$/.test(name)) return null;
    return name;
  }

  router.post('/kitchen/users', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const username = validUsername(req.body?.username);
      const password = String(req.body?.password || '');

      if (!username) {
        return res.status(400).json({
          error:
            'A username of two or more characters, using letters, numbers, ' +
            'dots, dashes, underscores, + or @. It gets typed on a screen ' +
            'with a finger, so keep it short.',
        });
      }
      // Four, not eight. This is a shared login for a screen in a locked
      // kitchen that can read what has been ordered for dinner, and a
      // twelve-character password on an on-screen keyboard is a password
      // written on the wall beside the screen.
      if (password.length < 4) {
        return res.status(400).json({
          error: 'The password needs to be at least 4 characters.',
        });
      }

      const [[existing]] = await pool.query(
        'SELECT id FROM epos_kitchen_users WHERE office = ? AND username = ?',
        [office, username]
      );
      if (existing) {
        return res.status(409).json({
          error: `This venue already has a kitchen login called "${username}".`,
        });
      }

      const hash = await bcrypt.hash(password, 12);
      const [result] = await pool.execute(
        `INSERT INTO epos_kitchen_users
           (office, username, password, display_name, active)
         VALUES (?, ?, ?, ?, ?)`,
        [
          office,
          username,
          hash,
          String(req.body?.display_name || '').trim().slice(0, 120) || null,
          req.body?.active === false ? 0 : 1,
        ]
      );

      res.status(201).json({ id: result.insertId, username });
    } catch (e) {
      next(e);
    }
  });

  router.put('/kitchen/users/:id', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const [[user]] = await pool.query(
        'SELECT id FROM epos_kitchen_users WHERE id = ? AND office = ?',
        [req.params.id, office]
      );
      if (!user) return res.status(404).json({ error: 'No such kitchen login' });

      const sets = [];
      const params = [];

      if (Object.prototype.hasOwnProperty.call(req.body, 'display_name')) {
        sets.push('display_name = ?');
        params.push(
          String(req.body.display_name || '').trim().slice(0, 120) || null
        );
      }
      if (Object.prototype.hasOwnProperty.call(req.body, 'active')) {
        sets.push('active = ?');
        params.push(req.body.active ? 1 : 0);
      }
      // Only when one was actually typed. An empty box means "leave it alone",
      // not "set the password to nothing" — otherwise renaming a login would
      // silently unlock it.
      if (req.body?.password) {
        if (String(req.body.password).length < 4) {
          return res.status(400).json({
            error: 'The password needs to be at least 4 characters.',
          });
        }
        sets.push('password = ?');
        params.push(await bcrypt.hash(String(req.body.password), 12));
      }

      if (sets.length === 0) return res.json({ ok: true });

      params.push(req.params.id);
      await pool.execute(
        `UPDATE epos_kitchen_users SET ${sets.join(', ')} WHERE id = ?`,
        params
      );
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  router.delete('/kitchen/users/:id', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      await pool.execute(
        'DELETE FROM epos_kitchen_users WHERE id = ? AND office = ?',
        [req.params.id, office]
      );
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // ---- Screens ------------------------------------------------------------

  /**
   * Clamp a screen's thresholds so a board cannot be configured into
   * uselessness.
   *
   * Amber has to arrive before red, and both have to arrive after the food has
   * had a chance to be cooked — a board that is entirely red is a board with no
   * information on it.
   */
  function thresholds(body, current) {
    const warn = Math.min(
      3600,
      Math.max(60, Number(body?.warn_seconds ?? current?.warn_seconds ?? 480))
    );
    const late = Math.min(
      7200,
      Math.max(
        warn + 60,
        Number(body?.late_seconds ?? current?.late_seconds ?? 900)
      )
    );
    return { warn, late };
  }

  router.get('/kitchen/screens', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const [rows] = await pool.query(
        `SELECT id, name, stations, columns_count, warn_seconds, late_seconds,
                recall_minutes, sound, sort_order
           FROM epos_kitchen_screens
          WHERE office = ?
          ORDER BY sort_order, name`,
        [office]
      );
      res.json(rows.map((r) => ({ ...r, stations: parseStations(r.stations) })));
    } catch (e) {
      next(e);
    }
  });

  async function writeScreen(req, res, id) {
    // Whether this is a create, decided *before* `id` is reassigned by the
    // insert below. Reading it off `id` afterwards made every create answer
    // 200: by the time the status was chosen, the new row's id was sitting in
    // the variable that was supposed to mean "there was already a row".
    const creating = !id;
    const office = await tenantEmail(req);
    const name = String(req.body?.name || '').trim().slice(0, 80);
    if (!name) return res.status(400).json({ error: 'The screen needs a name.' });

    let current = null;
    if (id) {
      const [[row]] = await pool.query(
        'SELECT * FROM epos_kitchen_screens WHERE id = ? AND office = ?',
        [id, office]
      );
      if (!row) return res.status(404).json({ error: 'No such screen' });
      current = row;
    }

    const { warn, late } = thresholds(req.body, current);
    const values = [
      name,
      formatStations(req.body?.stations),
      Math.min(6, Math.max(0, Number(req.body?.columns_count) || 0)),
      warn,
      late,
      Math.min(1440, Math.max(5, Number(req.body?.recall_minutes) || 60)),
      req.body?.sound === false ? 0 : 1,
      Number(req.body?.sort_order) || 0,
    ];

    if (id) {
      await pool.execute(
        `UPDATE epos_kitchen_screens
            SET name = ?, stations = ?, columns_count = ?, warn_seconds = ?,
                late_seconds = ?, recall_minutes = ?, sound = ?, sort_order = ?
          WHERE id = ? AND office = ?`,
        [...values, id, office]
      );
    } else {
      const [[clash]] = await pool.query(
        'SELECT id FROM epos_kitchen_screens WHERE office = ? AND name = ?',
        [office, name]
      );
      if (clash) {
        return res
          .status(409)
          .json({ error: `This venue already has a screen called "${name}".` });
      }
      const [result] = await pool.execute(
        `INSERT INTO epos_kitchen_screens
           (office, name, stations, columns_count, warn_seconds, late_seconds,
            recall_minutes, sound, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [office, ...values]
      );
      id = result.insertId;
    }

    // Every screen in the venue re-reads its profile. A manager who widens the
    // grill board should see it widen on the wall, not at the next restart.
    broadcast({ type: 'kitchen.screens', office }, { office });
    res.status(creating ? 201 : 200).json({ id });
  }

  router.post('/kitchen/screens', auth, (req, res, next) =>
    writeScreen(req, res, null).catch(next)
  );

  router.put('/kitchen/screens/:id', auth, (req, res, next) =>
    writeScreen(req, res, Number(req.params.id)).catch(next)
  );

  router.delete('/kitchen/screens/:id', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      await pool.execute(
        'DELETE FROM epos_kitchen_screens WHERE id = ? AND office = ?',
        [req.params.id, office]
      );
      broadcast({ type: 'kitchen.screens', office }, { office });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // ---- The board, for a manager watching from the office ------------------
  //
  // `/kitchen/monitor`, not `/kitchen/board`, and the difference is load-bearing:
  // both routers are mounted under /api, this one first, so a shared path would
  // put `requireAuth` in front of every screen's board fetch — and requireAuth
  // refuses a kitchen token, ends the request, and never falls through to the
  // router that would have served it. Every screen in every venue would have
  // gone blank.

  /**
   * How many products point at each station.
   *
   * The Kitchen screens page is otherwise six toggles with nothing to tell a
   * manager which of them matter. A venue rang up saying orders were not
   * reaching the screens, and the answer was that every one of their products
   * routed to DRINKS while DRINKS was still set to Printer — visible in ten
   * seconds with this next to the toggle, and not visible at all without it.
   *
   * Counted over `printer_routes`, the comma-separated column the product
   * editor writes, so a dish on the grill *and* the pass counts for both.
   */
  router.get('/kitchen/routing', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const [rows] = await pool.query(
        `SELECT printer_routes FROM bo_products
          WHERE email = ? AND printer_routes IS NOT NULL
            AND printer_routes <> ''`,
        [office]
      );

      const counts = Object.fromEntries(KP_STATIONS.map((s) => [s, 0]));
      for (const row of rows) {
        for (const station of parseStations(row.printer_routes)) {
          counts[station] += 1;
        }
      }

      const [[total]] = await pool.query(
        'SELECT COUNT(*) n FROM bo_products WHERE email = ?',
        [office]
      );
      res.json({ counts, products: total.n, routed: rows.length });
    } catch (e) {
      next(e);
    }
  });

  router.get('/kitchen/monitor', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      res.json({
        serverTime: new Date().toISOString(),
        stationNames: await stationNames(pool, office),
        tickets: await loadBoard(pool, office, req.query.minutes || 60),
      });
    } catch (e) {
      next(e);
    }
  });

  return router;
}

// ---------------------------------------------------------------------------
// The screens themselves
// ---------------------------------------------------------------------------

function kitchenAppRoutes({ pool, broadcast, secret }) {
  const router = express.Router();
  const kitchen = requireKitchen(secret);

  /**
   * Everything a screen needs to draw itself, in one response.
   *
   * Bundled rather than left as four fetches because a kitchen screen makes
   * this call on every launch and every reconnect, and a wall-mounted machine
   * on a venue's wifi is exactly where four sequential round trips turn into a
   * visible pause.
   */
  async function profile(office) {
    const [[venue]] = await pool.query(
      'SELECT name, status FROM offices WHERE contact_email = ?',
      [office]
    );
    const [screens] = await pool.query(
      `SELECT id, name, stations, columns_count, warn_seconds, late_seconds,
              recall_minutes, sound, sort_order
         FROM epos_kitchen_screens
        WHERE office = ?
        ORDER BY sort_order, name`,
      [office]
    );
    return {
      office,
      officeName: venue?.name || null,
      stationNames: await stationNames(pool, office),
      screens: screens.map((s) => ({ ...s, stations: parseStations(s.stations) })),
    };
  }

  router.post('/kitchen/login', async (req, res, next) => {
    try {
      const username = String(req.body?.username || '').trim().toLowerCase();
      const password = String(req.body?.password || '');
      const office = String(req.body?.office || '').trim();

      if (!username || !password || !office) {
        return res.status(400).json({
          error: 'The venue, a username and a password are all required.',
        });
      }

      const [[user]] = await pool.query(
        `SELECT id, username, password, display_name, active
           FROM epos_kitchen_users
          WHERE office = ? AND username = ?`,
        [office, username]
      );

      // Deliberately vague, and deliberately the same message for a missing
      // user and a wrong password: saying which half was wrong tells whoever is
      // standing at the screen which logins exist.
      const wrong = { error: 'That username or password is not right.' };
      if (!user) return res.status(401).json(wrong);
      if (!(await bcrypt.compare(password, user.password || ''))) {
        return res.status(401).json(wrong);
      }
      if (!user.active) {
        return res
          .status(403)
          .json({ error: 'This kitchen login has been turned off.' });
      }

      const [[venue]] = await pool.query(
        'SELECT status FROM offices WHERE contact_email = ?',
        [office]
      );
      // A paused office's screens go dark with its tills. A kitchen still
      // cooking for a business that has been suspended is the suspension not
      // meaning anything.
      if (venue && venue.status !== 'active') {
        return res.status(402).json({
          error: `This office is ${venue.status}. Contact Vesopa support.`,
        });
      }

      await pool.execute(
        'UPDATE epos_kitchen_users SET last_seen_at = NOW() WHERE id = ?',
        [user.id]
      );

      res.json({
        token: jwt.sign(
          {
            scope: 'kitchen',
            office,
            user: user.username,
            name: user.display_name || user.username,
          },
          secret,
          { expiresIn: KITCHEN_TOKEN_TTL }
        ),
        user: {
          username: user.username,
          name: user.display_name || user.username,
        },
        ...(await profile(office)),
      });
    } catch (e) {
      next(e);
    }
  });

  /** Re-read the venue's screens and station names without signing in again. */
  router.get('/kitchen/profile', kitchen, async (req, res, next) => {
    try {
      res.json({
        user: { username: req.kitchen.user, name: req.kitchen.name },
        ...(await profile(req.office)),
      });
    } catch (e) {
      next(e);
    }
  });

  router.get('/kitchen/board', kitchen, async (req, res, next) => {
    try {
      res.json({
        serverTime: new Date().toISOString(),
        stationNames: await stationNames(pool, req.office),
        tickets: await loadBoard(pool, req.office, req.query.minutes || 60),
      });
    } catch (e) {
      next(e);
    }
  });

  /**
   * Mark stations done.
   *
   * The screen sends the stations *it* watches, so bumping on the grill closes
   * the grill and leaves the fryer alone. Omitting them closes the lot, which
   * is what a single-screen kitchen means by the tick.
   *
   * A state assignment rather than a counter, so a request retried over a flaky
   * link cannot half-finish an order: pressing the tick twice is pressing it
   * once.
   */
  router.post('/kitchen/tickets/:id/bump', kitchen, async (req, res, next) => {
    try {
      const wanted = parseStations(req.body?.stations);
      const [[ticket]] = await pool.query(
        'SELECT id FROM epos_kitchen_tickets WHERE id = ? AND office = ?',
        [req.params.id, req.office]
      );
      if (!ticket) return res.status(404).json({ error: 'No such ticket' });

      const by = String(req.kitchen.name || req.kitchen.user || '').slice(0, 120);

      if (wanted.length) {
        const holes = wanted.map(() => '?').join(', ');
        await pool.execute(
          `UPDATE epos_kitchen_ticket_stations
              SET status = 'done', done_at = NOW(), done_by = ?
            WHERE ticket_id = ? AND station IN (${holes}) AND status <> 'done'`,
          [by, req.params.id, ...wanted]
        );
      } else {
        await pool.execute(
          `UPDATE epos_kitchen_ticket_stations
              SET status = 'done', done_at = NOW(), done_by = ?
            WHERE ticket_id = ? AND status <> 'done'`,
          [by, req.params.id]
        );
      }

      broadcast(
        { type: 'kitchen.ticket', id: req.params.id, office: req.office },
        { office: req.office }
      );
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  /** Put it back on the board. Every station, whichever screen asked. */
  router.post('/kitchen/tickets/:id/recall', kitchen, async (req, res, next) => {
    try {
      const [[ticket]] = await pool.query(
        'SELECT id FROM epos_kitchen_tickets WHERE id = ? AND office = ?',
        [req.params.id, req.office]
      );
      if (!ticket) return res.status(404).json({ error: 'No such ticket' });

      await pool.execute(
        `UPDATE epos_kitchen_ticket_stations
            SET status = 'open', done_at = NULL, done_by = NULL
          WHERE ticket_id = ?`,
        [req.params.id]
      );

      broadcast(
        { type: 'kitchen.ticket', id: req.params.id, office: req.office },
        { office: req.office }
      );
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  /** Front of the board, regardless of age. The kitchen's own priority call. */
  router.post('/kitchen/tickets/:id/rush', kitchen, async (req, res, next) => {
    try {
      const [result] = await pool.execute(
        'UPDATE epos_kitchen_tickets SET rushed = ? WHERE id = ? AND office = ?',
        [req.body?.rushed === false ? 0 : 1, req.params.id, req.office]
      );
      if (!result.affectedRows) {
        return res.status(404).json({ error: 'No such ticket' });
      }
      broadcast(
        { type: 'kitchen.ticket', id: req.params.id, office: req.office },
        { office: req.office }
      );
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  return router;
}

// ---------------------------------------------------------------------------
// The tills
// ---------------------------------------------------------------------------

function tillKitchenRoutes({ pool, broadcast, secret }) {
  const router = express.Router();

  /**
   * Accept a fired ticket from a terminal.
   *
   * Unauthenticated, exactly like /till/orders, and idempotent by the ticket id
   * the till minted. A till that retries after a dropped connection re-sends
   * the same id and the kitchen does not get the order twice — which matters
   * more here than it does for a sale, because a duplicated sale is a figure to
   * correct and a duplicated ticket is food that gets cooked.
   */
  router.post('/till/kitchen/tickets', async (req, res, next) => {
    const ticket = req.body;
    if (!ticket || !ticket.id || !ticket.office) {
      return res
        .status(400)
        .json({ error: 'A ticket id and an office are required' });
    }

    const lines = Array.isArray(ticket.lines) ? ticket.lines : [];
    if (lines.length === 0) {
      // Nothing was routed to a screen. Accepted rather than refused: the till
      // is telling us about a fire that had no screen-bound lines, and that is
      // not an error on either side.
      return res.status(202).json({ status: 'empty' });
    }

    // Which stations this ticket is waiting on: the union of its lines'.
    const stations = new Set();
    for (const line of lines) {
      for (const station of parseStations(line.stations)) stations.add(station);
    }
    if (stations.size === 0) {
      return res.status(202).json({ status: 'unrouted' });
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [result] = await conn.execute(
        `INSERT IGNORE INTO epos_kitchen_tickets
           (id, office, order_id, ticket_no, kind, table_number, room_name,
            staff_name, covers, note, placed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          ticket.id,
          ticket.office,
          ticket.order_id || ticket.id,
          ticket.ticket_no ?? null,
          ['sale', 'table', 'reprint'].includes(ticket.kind)
            ? ticket.kind
            : 'sale',
          ticket.table_number ?? null,
          ticket.room_name ?? null,
          ticket.staff_name ?? null,
          ticket.covers ?? null,
          ticket.note ?? null,
          ticket.placed_at ? new Date(ticket.placed_at) : new Date(),
        ]
      );

      // Already had it. Roll back rather than adding a second set of lines to
      // the ticket that is already on the board.
      if (result.affectedRows === 0) {
        await conn.rollback();
        return res.status(200).json({ status: 'duplicate', id: ticket.id });
      }

      let seq = 0;
      for (const line of lines) {
        await conn.execute(
          `INSERT INTO epos_kitchen_ticket_lines
             (id, ticket_id, seq, quantity, name, note, stations)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            line.id || crypto.randomUUID(),
            ticket.id,
            seq++,
            Number(line.quantity) || 1,
            String(line.name || '').slice(0, 255),
            line.note ? String(line.note).slice(0, 500) : null,
            formatStations(line.stations),
          ]
        );
      }

      for (const station of stations) {
        await conn.execute(
          `INSERT INTO epos_kitchen_ticket_stations (ticket_id, station, status)
           VALUES (?, ?, 'open')`,
          [ticket.id, station]
        );
      }

      await conn.commit();

      // Only once the ticket is durable. A screen told about an order that then
      // failed to commit is a screen showing food nobody ordered.
      broadcast(
        { type: 'kitchen.ticket', id: ticket.id, office: ticket.office },
        { office: ticket.office }
      );

      res.status(201).json({ status: 'accepted', id: ticket.id });
    } catch (err) {
      await conn.rollback();
      next(err);
    } finally {
      conn.release();
    }
  });

  /**
   * Where each station delivers, read and written by a commissioned till.
   *
   * The brief asks for this to be settable from the till's own settings as well
   * as from the back office, and it is the right ask: the person plugging a
   * screen into the kitchen wall is standing at the till, not at a laptop.
   *
   * Guarded by the terminal token rather than a session, because a till has no
   * usable session — the one from commissioning expired months ago — and
   * because the scope is exactly right: a commissioned terminal may say where
   * its own venue's kitchen stations deliver, and may do nothing else here. It
   * writes six columns and reads none of the office's data back.
   */
  router.get(
    '/till/kitchen/modes',
    requireTerminal(secret),
    async (req, res, next) => {
      try {
        res.json(await readModes(pool, req.office));
      } catch (e) {
        next(e);
      }
    }
  );

  router.put(
    '/till/kitchen/modes',
    requireTerminal(secret),
    async (req, res, next) => {
      try {
        const given = KP_STATIONS.filter((s) =>
          Object.prototype.hasOwnProperty.call(req.body || {}, s)
        );
        if (given.length === 0) {
          return res.status(400).json({ error: 'Nothing to change.' });
        }

        const cols = given.map((s) => `kitchen_mode_${s}`);
        // An unrecognised mode becomes 'printer' rather than being refused. A
        // till on a later release naming a mode this server has never heard of
        // must leave the kitchen printing, not leave it silent.
        const values = given.map((s) =>
          DELIVERY_MODES.includes(req.body[s]) ? req.body[s] : 'printer'
        );

        await pool.execute(
          `INSERT INTO epos_till_settings
             (office, ${cols.map((c) => `\`${c}\``).join(', ')})
           VALUES (${['?', ...cols.map(() => '?')].join(', ')})
           ON DUPLICATE KEY UPDATE
             ${cols.map((c) => `\`${c}\` = VALUES(\`${c}\`)`).join(', ')}`,
          [req.office, ...values]
        );

        // The same signal a back-office save sends, so every till re-reads its
        // settings — including the one that just wrote them, which is what
        // keeps four terminals in a venue agreeing.
        broadcast({ type: 'till-settings' });
        res.json(await readModes(pool, req.office));
      } catch (e) {
        next(e);
      }
    }
  );

  return router;
}

/** The six delivery modes for an office, defaulting anything unset. */
async function readModes(pool, office) {
  const [[row]] = await pool.query(
    `SELECT kitchen_mode_kp1, kitchen_mode_kp2, kitchen_mode_kp3,
            kitchen_mode_kp4, kitchen_mode_kp5, kitchen_mode_kp6
       FROM epos_till_settings WHERE office = ?`,
    [office]
  );
  return Object.fromEntries(
    KP_STATIONS.map((s) => [
      s,
      DELIVERY_MODES.includes(row?.[`kitchen_mode_${s}`])
        ? row[`kitchen_mode_${s}`]
        : 'printer',
    ])
  );
}

module.exports = {
  kitchenRoutes,
  kitchenAppRoutes,
  tillKitchenRoutes,
  requireKitchen,
  KP_STATIONS,
  DELIVERY_MODES,
};
