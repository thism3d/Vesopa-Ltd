/**
 * Screen programming — the server half.
 *
 * A venue lays out its own sale screen in the back office and every till in
 * that venue draws it. See vesopa_epos/docs/screen-programming.md for the
 * design, and in particular for why there is no row in here called "Default".
 *
 * Two routers, authorised differently, and kept apart for the same reason the
 * kitchen's are:
 *
 *   screensRoutes     the back office, on a session token. Creates screens,
 *                     lays out buttons, decides which one is home.
 *   tillScreenRoutes  the tills, unauthenticated and scoped by an `office`
 *                     query — exactly as /till-settings/public already is. A
 *                     sale-screen layout is no more sensitive than the product
 *                     catalogue the till fetches beside it.
 *
 * Mount order matters, as it does for the kitchen: if these two ever share a
 * path, requireAuth ends up in front of the till's read and every till in every
 * venue loses its screen. They do not share one — the till's live under
 * /till/ — and the test suite checks it.
 */

const express = require('express');

const { requireAuth } = require('./auth');

/** What a button can be. Anything else is refused rather than stored. */
const BUTTON_KINDS = ['product', 'page', 'function', 'blank'];

/**
 * The till actions a button may be bound to.
 *
 * A whitelist, because this string is dispatched on by the till: an unknown key
 * is ignored there, but storing arbitrary text would mean a venue could fill a
 * screen with buttons that do nothing and have no way to find out why.
 *
 * Deliberately excludes Pay, Void and Save Table. Those live on the till's own
 * action bar and are not layout — see the design doc, §4.
 *
 * It also excludes anything the till cannot actually do. `price_check` and
 * `discount` were both in an earlier draft of this list: the first is a feature
 * that does not exist, and the second lives on the payment screen and is
 * applied against a tender rather than a bill. Offering either would have let a
 * manager place a key that looked programmed and did nothing, which is worse
 * than not offering it — they are added here the day the till gains them.
 */
const FUNCTION_KEYS = [
  'qty',
  'note',
  'covers',
  'customer',
  'open_drawer',
  'print_bill',
];

/** The largest grid worth offering. Past this the keys stop being tappable. */
const MAX_ROWS = 10;
const MAX_COLS = 12;

/** `#RRGGBB`, or null. Never anything else — the till parses this. */
function cleanHex(raw) {
  const hex = String(raw ?? '').trim();
  if (!hex) return null;
  const withHash = hex.startsWith('#') ? hex : `#${hex}`;
  return /^#[0-9a-fA-F]{6}$/.test(withHash) ? withHash.toLowerCase() : null;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * Normalise one button from a request into a row, or return null to drop it.
 *
 * Everything is bounded here rather than trusted, because this is the payload a
 * browser posts and the till renders. A span that runs off the grid, a colour
 * with a typo in it, a `kind` nobody has heard of: each of them is something a
 * person can produce, and each has to come out as a screen that draws.
 */
function normaliseButton(raw, { rows, cols }) {
  if (!raw || typeof raw !== 'object') return null;

  const kind = BUTTON_KINDS.includes(raw.kind) ? raw.kind : 'blank';

  // Dropped rather than clamped, and checked *before* any clamping runs —
  // which is the whole point. Clamping a button at row 9 of a 5-row screen into
  // row 4 does not lose it, it silently moves it on top of whatever is already
  // there, and the layout then looks saved and is wrong. Losing it is the
  // honest outcome, and the editor cannot produce one anyway.
  const gridRow = Number(raw.row);
  const gridCol = Number(raw.col);
  if (!Number.isFinite(gridRow) || !Number.isFinite(gridCol)) return null;
  if (gridRow < 0 || gridRow >= rows) return null;
  if (gridCol < 0 || gridCol >= cols) return null;

  // A span may not run past the edge. Clamped rather than refused: the editor
  // already prevents it, and a screen that mostly works beats a save that
  // fails.
  const row = Math.round(gridRow);
  const col = Math.round(gridCol);

  const rowSpan = clampInt(raw.rowSpan, 1, rows - row, 1);
  const colSpan = clampInt(raw.colSpan, 1, cols - col, 1);

  const label = String(raw.label ?? '').trim().slice(0, 40) || null;

  return {
    grid_row: row,
    grid_col: col,
    row_span: rowSpan,
    col_span: colSpan,
    kind,
    // Each kind carries exactly one reference, and the others are nulled. A
    // button that has been changed from a product to a page must not keep a
    // stale plu_id: the till would have two things to dispatch on and would
    // pick whichever the renderer happened to check first.
    plu_id: kind === 'product' ? clampInt(raw.pluId, 0, 2147483647, null) : null,
    target_screen_id:
      kind === 'page' ? clampInt(raw.targetScreenId, 1, 2147483647, null) : null,
    function_key:
      kind === 'function' && FUNCTION_KEYS.includes(raw.functionKey)
        ? raw.functionKey
        : null,
    label,
    fill: cleanHex(raw.fill),
    ink: cleanHex(raw.ink),
  };
}

/** The wire shape, for both routers, so the till and the editor agree. */
function buttonToJson(row) {
  return {
    id: row.id,
    row: row.grid_row,
    col: row.grid_col,
    rowSpan: row.row_span,
    colSpan: row.col_span,
    kind: row.kind,
    pluId: row.plu_id,
    targetScreenId: row.target_screen_id,
    functionKey: row.function_key,
    label: row.label,
    fill: row.fill,
    ink: row.ink,
  };
}

function screenToJson(row, buttons = []) {
  return {
    id: row.id,
    name: row.name,
    surface: row.surface,
    rows: row.grid_rows,
    cols: row.grid_cols,
    sortOrder: row.sort_order,
    buttons: buttons.map(buttonToJson),
  };
}

/** Every screen a venue has, with its buttons, in one query pair. */
async function loadScreens(pool, office, { surface = 'sale' } = {}) {
  const [screens] = await pool.query(
    `SELECT id, name, surface, grid_rows, grid_cols, sort_order
       FROM epos_screens
      WHERE office = ? AND surface = ?
      ORDER BY sort_order, name`,
    [office, surface]
  );
  if (!screens.length) return [];

  // One query for every button in the venue rather than one per screen: a site
  // with twenty pages is twenty round trips otherwise, on a call the till makes
  // at every sign-on.
  const [buttons] = await pool.query(
    `SELECT * FROM epos_screen_buttons
      WHERE screen_id IN (${screens.map(() => '?').join(',')})
      ORDER BY grid_row, grid_col`,
    screens.map((s) => s.id)
  );

  const byScreen = new Map(screens.map((s) => [s.id, []]));
  for (const button of buttons) byScreen.get(button.screen_id)?.push(button);

  return screens.map((s) => screenToJson(s, byScreen.get(s.id) || []));
}

// ---------------------------------------------------------------------------
// The back office
// ---------------------------------------------------------------------------

function screensRoutes({ pool, broadcast, secret }) {
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

  /** Tell this venue's tills their screens moved. */
  function pushed(office) {
    broadcast({ type: 'screens', office }, { office });
  }

  /** Refuses a screen belonging to somebody else, by returning null. */
  async function screenFor(office, id) {
    const [[row]] = await pool.query(
      'SELECT * FROM epos_screens WHERE id = ? AND office = ?',
      [id, office]
    );
    return row || null;
  }

  /**
   * Which screen this venue's tills open on. Null means the built-in Default.
   *
   * Declared BEFORE `/screens/:id`, and that is load-bearing rather than
   * tidiness: Express matches in definition order, so with `:id` first this
   * would arrive as a screen whose id is the string "home", find nothing, and
   * answer 404 for ever. The same shape of trap as the kitchen's
   * /kitchen/monitor, and checked by the tests for the same reason — the next
   * literal path added under /screens has to go above the parameter too.
   */
  router.put('/screens/home', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const id = req.body?.screenId ?? null;

      if (id !== null && !(await screenFor(office, id))) {
        return res.status(404).json({ error: 'No such screen' });
      }

      await pool.execute(
        `INSERT INTO epos_till_settings (office, home_screen_id)
         VALUES (?, ?)
         ON DUPLICATE KEY UPDATE home_screen_id = VALUES(home_screen_id)`,
        [office, id]
      );

      // The tills read this off the till-settings row, so it is that broadcast
      // they are already listening for — not the screens one.
      broadcast({ type: 'till-settings', office }, { office });
      res.json({ ok: true, homeScreenId: id });
    } catch (e) {
      next(e);
    }
  });

  router.get('/screens', auth, async (req, res, next) => {
    try {
      res.json(await loadScreens(pool, await tenantEmail(req)));
    } catch (e) {
      next(e);
    }
  });

  router.get('/screens/:id', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const screen = await screenFor(office, req.params.id);
      if (!screen) return res.status(404).json({ error: 'No such screen' });

      const [buttons] = await pool.query(
        `SELECT * FROM epos_screen_buttons WHERE screen_id = ?
          ORDER BY grid_row, grid_col`,
        [screen.id]
      );
      res.json(screenToJson(screen, buttons));
    } catch (e) {
      next(e);
    }
  });

  /**
   * Create a screen, optionally copying an existing one.
   *
   * Copying is how a venue actually gets started — the reference's "Copy Page",
   * and the reason the built-in Default is offered as a source. Laying out
   * thirty buttons from nothing is a job nobody does twice.
   */
  router.post('/screens', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const name = String(req.body?.name || '').trim().slice(0, 60);
      if (!name) return res.status(400).json({ error: 'A name is required.' });

      const rows = clampInt(req.body?.rows, 1, MAX_ROWS, 5);
      const cols = clampInt(req.body?.cols, 1, MAX_COLS, 6);

      const source = req.body?.copyFromId
        ? await screenFor(office, req.body.copyFromId)
        : null;
      if (req.body?.copyFromId && !source) {
        return res.status(404).json({ error: 'No such screen to copy.' });
      }

      const [[{ next: sortOrder }]] = await pool.query(
        `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next
           FROM epos_screens WHERE office = ?`,
        [office]
      );

      let created;
      try {
        [created] = await pool.execute(
          `INSERT INTO epos_screens (office, name, grid_rows, grid_cols, sort_order)
           VALUES (?, ?, ?, ?, ?)`,
          [
            office,
            name,
            source ? source.grid_rows : rows,
            source ? source.grid_cols : cols,
            sortOrder,
          ]
        );
      } catch (e) {
        if (e.code === 'ER_DUP_ENTRY') {
          return res
            .status(409)
            .json({ error: `This venue already has a screen called "${name}".` });
        }
        throw e;
      }

      if (source) {
        // The buttons come across as they are, except their page links. A copied
        // page that still points at the page the original pointed at is right —
        // it is the same menu — so those are preserved rather than cleared.
        await pool.execute(
          `INSERT INTO epos_screen_buttons
             (screen_id, office, grid_row, grid_col, row_span, col_span,
              kind, plu_id, target_screen_id, function_key, label, fill, ink)
           SELECT ?, office, grid_row, grid_col, row_span, col_span,
                  kind, plu_id, target_screen_id, function_key, label, fill, ink
             FROM epos_screen_buttons WHERE screen_id = ?`,
          [created.insertId, source.id]
        );
      }

      pushed(office);
      const screen = await screenFor(office, created.insertId);
      const [buttons] = await pool.query(
        'SELECT * FROM epos_screen_buttons WHERE screen_id = ?',
        [created.insertId]
      );
      res.status(201).json(screenToJson(screen, buttons));
    } catch (e) {
      next(e);
    }
  });

  /** Rename, resize or reorder. Buttons are saved separately. */
  router.put('/screens/:id', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const screen = await screenFor(office, req.params.id);
      if (!screen) return res.status(404).json({ error: 'No such screen' });

      const name = Object.prototype.hasOwnProperty.call(req.body || {}, 'name')
        ? String(req.body.name || '').trim().slice(0, 60)
        : screen.name;
      if (!name) return res.status(400).json({ error: 'A name is required.' });

      const rows = clampInt(req.body?.rows, 1, MAX_ROWS, screen.grid_rows);
      const cols = clampInt(req.body?.cols, 1, MAX_COLS, screen.grid_cols);

      await pool.execute(
        `UPDATE epos_screens
            SET name = ?, grid_rows = ?, grid_cols = ?, sort_order = ?
          WHERE id = ? AND office = ?`,
        [
          name,
          rows,
          cols,
          clampInt(req.body?.sortOrder, 0, 100000, screen.sort_order),
          screen.id,
          office,
        ]
      );

      // Shrinking the grid orphans anything now outside it. Deleted rather than
      // left: a button at row 7 of a 5-row screen is invisible in the editor and
      // would reappear if the grid were ever grown again, which is a layout
      // changing on its own.
      await pool.execute(
        `DELETE FROM epos_screen_buttons
          WHERE screen_id = ? AND (grid_row >= ? OR grid_col >= ?)`,
        [screen.id, rows, cols]
      );

      pushed(office);
      res.json(screenToJson(await screenFor(office, screen.id)));
    } catch (e) {
      next(e);
    }
  });

  router.delete('/screens/:id', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const screen = await screenFor(office, req.params.id);
      if (!screen) return res.status(404).json({ error: 'No such screen' });

      // Buttons go with it, by the foreign key. Two things that point at it do
      // not, and both are cleaned here rather than left dangling:
      //
      //   * page buttons on OTHER screens become blanks, so a venue is not left
      //     with a key that goes nowhere;
      //   * the venue's home screen, if it was this one, falls back to NULL,
      //     which the till reads as the built-in Default.
      await pool.execute(
        `UPDATE epos_screen_buttons
            SET kind = 'blank', target_screen_id = NULL
          WHERE office = ? AND target_screen_id = ?`,
        [office, screen.id]
      );
      await pool.execute(
        `UPDATE epos_till_settings SET home_screen_id = NULL
          WHERE office = ? AND home_screen_id = ?`,
        [office, screen.id]
      );
      await pool.execute('DELETE FROM epos_screens WHERE id = ? AND office = ?', [
        screen.id,
        office,
      ]);

      pushed(office);
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  /**
   * Replace a screen's buttons wholesale.
   *
   * The editor sends the whole grid, not a diff. A layout is small — a few
   * dozen rows at most — and "here is the screen as it now is" cannot half
   * apply, whereas a sequence of inserts, updates and deletes can and leaves a
   * venue looking at a screen that never existed.
   */
  router.put('/screens/:id/buttons', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const screen = await screenFor(office, req.params.id);
      if (!screen) return res.status(404).json({ error: 'No such screen' });

      const grid = { rows: screen.grid_rows, cols: screen.grid_cols };
      const seen = new Set();
      const rows = [];

      for (const raw of Array.isArray(req.body?.buttons) ? req.body.buttons : []) {
        const button = normaliseButton(raw, grid);
        if (!button) continue;
        // A blank carries nothing and holds no cell: storing them would double
        // the size of every screen for no gain, and an empty cell is already
        // what "no row here" means.
        if (button.kind === 'blank') continue;

        // Last one wins on a duplicated cell rather than the insert failing on
        // the unique key. The editor cannot produce this; a hand-rolled request
        // can, and refusing the whole save over it helps nobody.
        const cell = `${button.grid_row}:${button.grid_col}`;
        if (seen.has(cell)) {
          rows[rows.findIndex((r) => `${r.grid_row}:${r.grid_col}` === cell)] =
            button;
          continue;
        }
        seen.add(cell);
        rows.push(button);
      }

      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        await connection.execute(
          'DELETE FROM epos_screen_buttons WHERE screen_id = ?',
          [screen.id]
        );
        for (const b of rows) {
          await connection.execute(
            `INSERT INTO epos_screen_buttons
               (screen_id, office, grid_row, grid_col, row_span, col_span,
                kind, plu_id, target_screen_id, function_key, label, fill, ink)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              screen.id,
              office,
              b.grid_row,
              b.grid_col,
              b.row_span,
              b.col_span,
              b.kind,
              b.plu_id,
              b.target_screen_id,
              b.function_key,
              b.label,
              b.fill,
              b.ink,
            ]
          );
        }
        await connection.commit();
      } catch (e) {
        await connection.rollback();
        throw e;
      } finally {
        connection.release();
      }

      pushed(office);
      const [saved] = await pool.query(
        `SELECT * FROM epos_screen_buttons WHERE screen_id = ?
          ORDER BY grid_row, grid_col`,
        [screen.id]
      );
      res.json(screenToJson(screen, saved));
    } catch (e) {
      next(e);
    }
  });

  return router;
}

// ---------------------------------------------------------------------------
// The tills
// ---------------------------------------------------------------------------

function tillScreenRoutes({ pool }) {
  const router = express.Router();

  /**
   * Every screen this venue has, in one call.
   *
   * All of them, not just the home one, because a page button jumps to another
   * screen and a till that had to fetch it at the moment of the tap would show
   * a clerk a blank grid while it did. A venue's whole layout is a few
   * kilobytes.
   *
   * Unauthenticated and scoped by `office`, exactly as /till-settings/public
   * is: this is the same class of data as the product catalogue the till
   * already fetches, and a till has no session to present.
   */
  router.get('/till/screens', async (req, res, next) => {
    try {
      const office = String(req.query.office || '').trim();
      if (!office) return res.status(400).json({ error: 'office is required' });
      res.json({ screens: await loadScreens(pool, office) });
    } catch (e) {
      next(e);
    }
  });

  return router;
}

module.exports = {
  screensRoutes,
  tillScreenRoutes,
  normaliseButton,
  cleanHex,
  BUTTON_KINDS,
  FUNCTION_KEYS,
  MAX_ROWS,
  MAX_COLS,
};
