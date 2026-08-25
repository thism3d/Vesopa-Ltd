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
 *
 *                     And "screen" here now includes the till's two bars. The
 *                     strip of open bills along the top and the action bar
 *                     along the bottom are rows of the same buttons the sale
 *                     grid is made of, told apart by `surface` — so they are
 *                     created, laid out, copied, pushed and scoped by the code
 *                     that was already here rather than by a second system
 *                     beside it. See §9 of the design doc.
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
 * What a screen lays out. `epos_screens.surface` has held this since the first
 * migration; 'sale' was the only value until the bars arrived.
 */
const SURFACES = ['sale', 'topbar', 'bottombar'];

const isBar = (surface) => surface === 'topbar' || surface === 'bottombar';

/**
 * The till actions a button on a *sale screen* may be bound to.
 *
 * A whitelist, because this string is dispatched on by the till: an unknown key
 * is ignored there, but storing arbitrary text would mean a venue could fill a
 * screen with buttons that do nothing and have no way to find out why.
 *
 * It excludes anything the till cannot actually do. `price_check` and
 * `discount` were both in an earlier draft: the first is a feature that does
 * not exist, and the second lives on the payment screen and is applied against
 * a tender rather than a bill. Offering either would have let a manager place a
 * key that looked programmed and did nothing, which is worse than not offering
 * it — they are added here the day the till gains them.
 *
 * Pay, Void and Save Table used to be excluded on the grounds that they "live
 * on the till's action bar and are not layout". That was true right up until
 * the action bar became layout, and they are offered on the bar surfaces below.
 * They stay off the sale grid: a Pay key in the middle of a page of lagers,
 * one row above Cancel, is a mis-press that costs a venue a bill.
 */
const FUNCTION_KEYS = [
  'qty',
  'note',
  'covers',
  'customer',
  'open_drawer',
  'print_bill',
];

/**
 * And what a button on a *bar* may be bound to.
 *
 * A longer list, because a bar is chrome: it is where the things that act on
 * the whole bill live, and where the way out of the sale screen lives. Every
 * key in here does something on the till today — the same rule as above, and
 * the reason `discount` is still absent.
 *
 * Three groups, and the third is the interesting one:
 *
 *   actions      what the built-in bars already do, one key each, so a venue
 *                that just wants its own order and colours can rebuild the
 *                stock bar exactly and then change one thing.
 *   navigation   `go_*`, which is the nav rail as keys. A venue that hides the
 *                rail to buy back 208px of bill (see NavPanelMode) has to be
 *                able to put Tables and Receipts back somewhere.
 *   widgets      keys that are not keys. `open_bills` draws the live strip of
 *                every bill in play — the thing the top bar *is* today — and
 *                `clock`, `order_total`, `staff_name`, `venue_name`,
 *                `sync_status` and `spacer` are the furniture around it.
 *
 * Without that widget group the whole feature would be a trap: a venue that
 * programmed a top bar would silently lose the ability to serve two tables at
 * once, and would find out at the counter. So the live bills are a key you can
 * place, resize and colour, rather than something the bar loses when a venue
 * touches it.
 *
 * One list for both bars rather than two. The top bar is the natural home for
 * the total and the clock and the bottom bar for Pay, but a venue that wants
 * Pay across the top of a handheld is not wrong, and a whitelist that enforced
 * our taste would only be discovered as a missing option.
 */
const BAR_KEYS = [
  // Actions — the built-in bottom bar, key for key.
  'pay',
  'void',
  'cancel',
  'save_table',
  'new_bill',
  'last_bill',
  'qty',
  'note',
  'covers',
  'customer',
  'open_drawer',
  'print_bill',

  // Navigation — the nav rail, as keys.
  'go_sale',
  'go_tables',
  'go_receipts',
  'go_reports',
  'go_products',
  'go_functions',
  'go_settings',
  'sign_off',

  // Widgets — the parts of the bar that draw rather than wait.
  'open_bills',
  'order_total',
  'clock',
  'venue_name',
  'staff_name',
  'sync_status',
  'screen_name',
  'spacer',
];

/** The keys a given surface will accept. */
function functionKeysFor(surface) {
  return isBar(surface) ? BAR_KEYS : FUNCTION_KEYS;
}

/** The largest grid worth offering. Past this the keys stop being tappable. */
const MAX_ROWS = 10;
const MAX_COLS = 12;

/**
 * A bar is a different shape of thing, so it gets different ceilings.
 *
 * Two rows, because the built-in action bar already spills onto a second when
 * the keys will not fit across one, and a venue rebuilding it has to be able to
 * express what it is replacing. Not three: past two rows the bar starts eating
 * the grid, which is the screen a clerk actually works in — the same judgement
 * PosActionBar makes in `_maxRows`, held in both places on purpose.
 *
 * Sixteen columns rather than twelve, because a bar's cells are narrow by
 * nature and the stock bottom bar is already ten keys plus a wide Pay. Twelve
 * would have made "rebuild what you have, then change one thing" impossible on
 * the very first attempt.
 */
const MAX_BAR_ROWS = 2;
const MAX_BAR_COLS = 16;

/** The ceilings for one surface, as one thing, so nothing has to remember. */
function limitsFor(surface) {
  return isBar(surface)
    ? { rows: MAX_BAR_ROWS, cols: MAX_BAR_COLS, defRows: 1, defCols: 10 }
    : { rows: MAX_ROWS, cols: MAX_COLS, defRows: 5, defCols: 6 };
}

/** `#RRGGBB`, or null. Never anything else — the till parses this. */
function cleanHex(raw) {
  const hex = String(raw ?? '').trim();
  if (!hex) return null;
  const withHash = hex.startsWith('#') ? hex : `#${hex}`;
  return /^#[0-9a-fA-F]{6}$/.test(withHash) ? withHash.toLowerCase() : null;
}

/**
 * A picture path, or null.
 *
 * On-site only: `/uploads/...` or `/assets/...`, never an off-site URL. Same
 * rule as the idle image and for the same reason — a till on a venue's own
 * network with no route to the open internet must not be able to end up drawing
 * a broken frame across its sale screen, and the failure would appear weeks
 * after the layout was arranged, in front of customers.
 */
function cleanImage(raw) {
  const url = String(raw ?? '').trim().slice(0, 500);
  if (!url) return null;
  return /^\/(uploads|assets)\//.test(url) ? url : null;
}

/**
 * The emoji on a key.
 *
 * Not validated against a list of what is or is not an emoji. A venue that
 * types "1/2" or "£" into this box has made a perfectly good key face, and a
 * regex that let one through and not the other would be a bug report nobody
 * could act on. Bounded and stored.
 */
function cleanEmoji(raw) {
  return String(raw ?? '').trim().replace(/\s+/g, ' ').slice(0, 16) || null;
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
function normaliseButton(raw, { rows, cols, surface = 'sale' }) {
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
    // Checked against the list for THIS surface, so a Pay key cannot be posted
    // onto a page of lagers by hand-rolling the request, and a widget cannot be
    // posted onto the sale grid where nothing would draw it.
    function_key:
      kind === 'function' && functionKeysFor(surface).includes(raw.functionKey)
        ? raw.functionKey
        : null,
    label,
    fill: cleanHex(raw.fill),
    ink: cleanHex(raw.ink),
    // The key's own face. Independent of the product's: a key with neither
    // still falls back to the product's picture, which is what stops this
    // feature un-decorating every screen a venue has already programmed.
    emoji: cleanEmoji(raw.emoji),
    image_url: cleanImage(raw.imageUrl),
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
    emoji: row.emoji ?? null,
    imageUrl: row.image_url ?? null,
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
    // Which bars this page wants, when it does not want the venue's. Null is
    // the answer for nearly every screen and means "use the default".
    topBarId: row.top_bar_id ?? null,
    bottomBarId: row.bottom_bar_id ?? null,
    buttons: buttons.map(buttonToJson),
  };
}

/**
 * Every screen a venue has, with its buttons, in one query pair.
 *
 * Every *surface*, not just the sale pages. The till needs its bars in the same
 * breath as its screens — a terminal that fetched the layout and then had to go
 * back for the bar it wears would draw the stock bar for as long as that took,
 * on every launch, and a venue would see its own bar snap into place a moment
 * late for ever. `surface` comes back on each row and the caller sorts them out.
 *
 * `surface` may still be passed to ask for one kind, which the back office does
 * not need and a future caller might.
 */
async function loadScreens(pool, office, { surface = null } = {}) {
  const [screens] = await pool.query(
    `SELECT id, name, surface, grid_rows, grid_cols, sort_order,
            top_bar_id, bottom_bar_id
       FROM epos_screens
      WHERE office = ?${surface ? ' AND surface = ?' : ''}
      ORDER BY surface, sort_order, name`,
    surface ? [office, surface] : [office]
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

  /**
   * The three screens a till wears: its sale page, its top bar, its bottom bar.
   *
   * One route rather than three, because they are one decision — "this is what
   * my tills look like" — and because a manager who sets a bottom bar and a home
   * screen in one gesture should not be able to get half of it.
   *
   * Every key is optional and only what is sent is written, so this can also be
   * used to change one of them. `null` is a real value here and means "back to
   * the built-in", which is why the check is hasOwnProperty rather than truth.
   *
   * Declared BEFORE `/screens/:id`, exactly as /screens/home is, and for the
   * same reason: with `:id` first this arrives as a screen whose id is the
   * string "defaults", finds nothing and answers 404 for ever.
   */
  router.put('/screens/defaults', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const body = req.body || {};

      const columns = {
        homeScreenId: 'home_screen_id',
        topBarScreenId: 'top_bar_screen_id',
        bottomBarScreenId: 'bottom_bar_screen_id',
      };

      const sent = Object.keys(columns).filter((k) =>
        Object.prototype.hasOwnProperty.call(body, k)
      );
      if (!sent.length) return res.status(400).json({ error: 'Nothing to set.' });

      const values = {};
      for (const key of sent) {
        const id = body[key] === null || body[key] === '' ? null : body[key];
        if (id !== null) {
          const screen = await screenFor(office, id);
          if (!screen) return res.status(404).json({ error: 'No such screen' });

          // A sale page cannot be worn as a bar, and a bar cannot be opened as
          // a sale page. Refused rather than accepted-and-ignored: a manager who
          // picks the wrong one from a list has to be told at the moment they
          // pick it, not by walking to a till.
          const wants =
            key === 'homeScreenId'
              ? 'sale'
              : key === 'topBarScreenId'
                ? 'topbar'
                : 'bottombar';
          if (screen.surface !== wants) {
            return res.status(400).json({
              error: `"${screen.name}" is a ${screen.surface} layout, not a ${wants} one.`,
            });
          }
        }
        values[columns[key]] = id;
      }

      const cols = Object.keys(values);
      await pool.execute(
        `INSERT INTO epos_till_settings (office, ${cols.join(', ')})
         VALUES (?${', ?'.repeat(cols.length)})
         ON DUPLICATE KEY UPDATE
           ${cols.map((c) => `${c} = VALUES(${c})`).join(', ')}`,
        [office, ...cols.map((c) => values[c])]
      );

      // The tills read all three off the till-settings row, so it is that
      // broadcast they are listening for — not the screens one.
      broadcast({ type: 'till-settings', office }, { office });
      res.json({ ok: true, ...body });
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

      const surface = SURFACES.includes(req.body?.surface)
        ? req.body.surface
        : 'sale';
      const max = limitsFor(surface);

      const rows = clampInt(req.body?.rows, 1, max.rows, max.defRows);
      const cols = clampInt(req.body?.cols, 1, max.cols, max.defCols);

      const source = req.body?.copyFromId
        ? await screenFor(office, req.body.copyFromId)
        : null;
      if (req.body?.copyFromId && !source) {
        return res.status(404).json({ error: 'No such screen to copy.' });
      }
      // Copying across surfaces would bring keys the destination cannot hold —
      // a Pay key onto a sale page, an `open_bills` widget onto a grid that has
      // nothing to draw it with. Refused with the reason rather than silently
      // dropping half the buttons, which is how a copy looks like it worked.
      if (source && source.surface !== surface) {
        return res.status(400).json({
          error: `"${source.name}" is a ${source.surface} layout and cannot be copied into a ${surface} one.`,
        });
      }

      // Per surface, so a new bottom bar does not sort itself to the end of the
      // sale screens and land the venue's pages in an order nobody chose.
      const [[{ next: sortOrder }]] = await pool.query(
        `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next
           FROM epos_screens WHERE office = ? AND surface = ?`,
        [office, surface]
      );

      let created;
      try {
        [created] = await pool.execute(
          `INSERT INTO epos_screens
             (office, name, surface, grid_rows, grid_cols, sort_order)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            office,
            name,
            surface,
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
              kind, plu_id, target_screen_id, function_key, label, fill, ink,
              emoji, image_url)
           SELECT ?, office, grid_row, grid_col, row_span, col_span,
                  kind, plu_id, target_screen_id, function_key, label, fill, ink,
                  emoji, image_url
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

      const max = limitsFor(screen.surface);
      const rows = clampInt(req.body?.rows, 1, max.rows, screen.grid_rows);
      const cols = clampInt(req.body?.cols, 1, max.cols, screen.grid_cols);

      // Which bars this page wants. Only touched when sent, and `null` is a
      // real value meaning "back to the venue's default" — so the check is
      // hasOwnProperty, not truth, exactly as /screens/defaults does it.
      //
      // The referenced screen is verified to be this office's and to be a bar
      // of the right end. A sale page set as a bottom bar would draw nothing a
      // clerk could press, and would look like the feature was broken rather
      // than like the wrong row was picked from a list.
      const bars = {};
      for (const [field, column, wants] of [
        ['topBarId', 'top_bar_id', 'topbar'],
        ['bottomBarId', 'bottom_bar_id', 'bottombar'],
      ]) {
        if (!Object.prototype.hasOwnProperty.call(req.body || {}, field)) continue;
        const id = req.body[field] === null || req.body[field] === ''
          ? null
          : req.body[field];
        if (id !== null) {
          const bar = await screenFor(office, id);
          if (!bar || bar.surface !== wants) {
            return res.status(400).json({ error: `No such ${wants}.` });
          }
        }
        bars[column] = id;
      }

      const barSet = Object.keys(bars)
        .map((c) => `, ${c} = ?`)
        .join('');

      await pool.execute(
        `UPDATE epos_screens
            SET name = ?, grid_rows = ?, grid_cols = ?, sort_order = ?${barSet}
          WHERE id = ? AND office = ?`,
        [
          name,
          rows,
          cols,
          clampInt(req.body?.sortOrder, 0, 100000, screen.sort_order),
          ...Object.values(bars),
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
      const [kept] = await pool.query(
        `SELECT * FROM epos_screen_buttons WHERE screen_id = ?
          ORDER BY grid_row, grid_col`,
        [screen.id]
      );
      res.json(screenToJson(await screenFor(office, screen.id), kept));
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
      // The same, for a bar. Both columns in one statement: a bar deleted while
      // it was the venue's top bar has to leave the tills wearing the built-in
      // one, not wearing a row that is no longer there.
      await pool.execute(
        `UPDATE epos_till_settings
            SET top_bar_screen_id = IF(top_bar_screen_id = ?, NULL, top_bar_screen_id),
                bottom_bar_screen_id = IF(bottom_bar_screen_id = ?, NULL, bottom_bar_screen_id)
          WHERE office = ?`,
        [screen.id, screen.id, office]
      );
      // And any single page that had asked for it.
      await pool.execute(
        `UPDATE epos_screens
            SET top_bar_id = IF(top_bar_id = ?, NULL, top_bar_id),
                bottom_bar_id = IF(bottom_bar_id = ?, NULL, bottom_bar_id)
          WHERE office = ?`,
        [screen.id, screen.id, office]
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

      const grid = {
        rows: screen.grid_rows,
        cols: screen.grid_cols,
        surface: screen.surface,
      };
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
                kind, plu_id, target_screen_id, function_key, label, fill, ink,
                emoji, image_url)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
              b.emoji,
              b.image_url,
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
  cleanImage,
  cleanEmoji,
  functionKeysFor,
  limitsFor,
  BUTTON_KINDS,
  SURFACES,
  FUNCTION_KEYS,
  BAR_KEYS,
  MAX_ROWS,
  MAX_COLS,
  MAX_BAR_ROWS,
  MAX_BAR_COLS,
};
