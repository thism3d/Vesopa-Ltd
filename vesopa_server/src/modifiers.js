/**
 * Modifiers: the question a product asks before it goes on the bill.
 *
 * Two route sets, split the same way and for the same reason as screens.js:
 *
 *   modifierRoutes      the back office, behind requireAuth and scoped to one
 *                       office by the signed-in user.
 *   tillModifierRoutes  the tills, unauthenticated and scoped by an `office`
 *                       query — exactly as /till/screens already is. What a
 *                       venue asks about a gin is no more sensitive than the
 *                       catalogue the till fetches beside it.
 *
 * Mount order matters, as it does for screens and the kitchen: if these two
 * ever share a path, requireAuth ends up in front of the till's read and every
 * till in every venue loses its modifiers. They do not — the till's live under
 * /till/ — and the test suite checks it.
 *
 * ---------------------------------------------------------------------------
 * Where the buttons are
 * ---------------------------------------------------------------------------
 * They are not in here. A modifier group owns an `epos_screens` row with
 * `surface = 'modifier'`, so its grid of answers is laid out by the screen
 * editor that already exists and reaches the till through /till/screens with
 * everything else. See schema_screens_modifiers.sql for the full reasoning.
 *
 * That is why the till feed below returns no buttons: by the time a terminal
 * reads it, it already has every screen in the venue, this group's included.
 */

const express = require('express');

const { requireAuth } = require('./auth');

/** Groups and their layouts are capped so one venue cannot fill the table. */
const MAX_GROUPS = 200;

/** A whole number in range, or the fallback. Never NaN, never negative. */
function clampInt(raw, { min, max, fallback }) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * The two numbers that are the whole behaviour of a prompt.
 *
 * `max_select` of 0 means "no ceiling" and is left alone. Otherwise a max below
 * the min is incoherent — it asks for three answers from a box that accepts one
 * — so it is raised to meet it rather than refused: the manager typing it has
 * said what the minimum is, and that is the number they meant.
 */
function selectionLimits(body, current = {}) {
  const min = clampInt(body?.min_select ?? current.min_select, {
    min: 0, max: 99, fallback: 0,
  });
  let max = clampInt(body?.max_select ?? current.max_select, {
    min: 0, max: 99, fallback: 1,
  });
  if (max !== 0 && max < min) max = min;
  return { min, max };
}

function modifierRoutes({ pool, broadcast, secret }) {
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

  /**
   * Tell this venue's tills their modifiers moved.
   *
   * Sent as a screens push as well as a modifiers one, because changing a
   * group's layout changes a screen — and a till that reloaded its modifiers
   * but not its screens would have a prompt with nothing on it.
   */
  function pushed(office) {
    broadcast({ type: 'modifiers', office }, { office });
    broadcast({ type: 'screens', office }, { office });
  }

  // -------------------------------------------------------------------------
  // The groups
  // -------------------------------------------------------------------------

  router.get('/modifier-groups', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      // The button count comes back with the row so the list can say "4
      // answers" rather than making a manager open every group to find the
      // empty one. A group with no layout reads 0, which is the thing worth
      // spotting: the till skips it.
      const [rows] = await pool.query(
        `SELECT g.id, g.name, g.min_select, g.max_select, g.screen_id,
                g.sort_order,
                s.name AS screen_name,
                (SELECT COUNT(*) FROM epos_screen_buttons b
                  WHERE b.screen_id = g.screen_id AND b.kind <> 'blank')
                  AS option_count,
                (SELECT COUNT(*) FROM epos_product_modifiers pm
                  WHERE pm.group_id = g.id) AS product_count
           FROM epos_modifier_groups g
           LEFT JOIN epos_screens s ON s.id = g.screen_id
          WHERE g.office = ?
          ORDER BY g.sort_order, g.name`,
        [office]
      );
      res.json(rows);
    } catch (e) {
      next(e);
    }
  });

  /**
   * Create a group, and the screen that holds its answers.
   *
   * The layout is made here rather than on first edit so that "Edit answers"
   * always has something to open. A group whose screen had to be created by a
   * separate action is a group that spends its first minutes in a state where
   * the only button on offer does nothing.
   */
  router.post('/modifier-groups', auth, async (req, res, next) => {
    const conn = await pool.getConnection();
    try {
      const office = await tenantEmail(req);
      const name = String(req.body?.name || '').trim().slice(0, 60);
      if (!name) return res.status(400).json({ error: 'A name is required.' });

      const [[{ count }]] = await conn.query(
        'SELECT COUNT(*) AS count FROM epos_modifier_groups WHERE office = ?',
        [office]
      );
      if (count >= MAX_GROUPS) {
        return res.status(409).json({
          error: `A venue may have ${MAX_GROUPS} modifier groups.`,
        });
      }

      const { min, max } = selectionLimits(req.body);

      // Both rows or neither. A group pointing at a screen that failed to
      // insert is a prompt that opens on nothing.
      await conn.beginTransaction();
      try {
        const [screen] = await conn.execute(
          `INSERT INTO epos_screens (office, name, surface, grid_rows, grid_cols)
           VALUES (?, ?, 'modifier', 2, 4)`,
          [office, name]
        );
        const [group] = await conn.execute(
          `INSERT INTO epos_modifier_groups
             (office, name, min_select, max_select, screen_id, sort_order)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [office, name, min, max, screen.insertId, count]
        );
        await conn.commit();
        pushed(office);
        res.status(201).json({ id: group.insertId, screen_id: screen.insertId });
      } catch (e) {
        await conn.rollback();
        // The screen name collides on (office, surface, name), and so does the
        // group name on (office, name) — either way the venue already has a
        // group called this, which is the thing worth saying.
        if (e.code === 'ER_DUP_ENTRY') {
          return res.status(409).json({
            error: `There is already a modifier group called "${name}".`,
          });
        }
        throw e;
      }
    } catch (e) {
      next(e);
    } finally {
      conn.release();
    }
  });

  router.put('/modifier-groups/:id', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const [[current]] = await pool.query(
        'SELECT * FROM epos_modifier_groups WHERE id = ? AND office = ?',
        [req.params.id, office]
      );
      if (!current) return res.status(404).json({ error: 'No such group' });

      const name = String(req.body?.name ?? current.name).trim().slice(0, 60);
      if (!name) return res.status(400).json({ error: 'A name is required.' });
      const { min, max } = selectionLimits(req.body, current);

      await pool.execute(
        `UPDATE epos_modifier_groups
            SET name = ?, min_select = ?, max_select = ?
          WHERE id = ? AND office = ?`,
        [name, min, max, current.id, office]
      );

      // The layout is named after the group, so renaming one renames the
      // other. Failure here is not worth losing the rename over: a screen whose
      // name lags the group's is untidy, not broken, and it is only ever seen
      // inside the group that owns it.
      if (current.screen_id && name !== current.name) {
        try {
          await pool.execute(
            'UPDATE epos_screens SET name = ? WHERE id = ? AND office = ?',
            [name, current.screen_id, office]
          );
        } catch { /* a name clash on the screen table; harmless here */ }
      }

      pushed(office);
      res.json({ ok: true });
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({
          error: 'There is already a modifier group with that name.',
        });
      }
      next(e);
    }
  });

  /**
   * Delete a group, its layout, and every product's link to it.
   *
   * The links go by cascade (see the schema). The screen is deleted here
   * because the foreign key deliberately runs the other way — ON DELETE SET
   * NULL, so that removing a *layout* never removes the question — which means
   * nothing removes the layout unless this does.
   */
  router.delete('/modifier-groups/:id', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const [[group]] = await pool.query(
        'SELECT screen_id FROM epos_modifier_groups WHERE id = ? AND office = ?',
        [req.params.id, office]
      );
      if (!group) return res.status(404).json({ error: 'No such group' });

      await pool.execute(
        'DELETE FROM epos_modifier_groups WHERE id = ? AND office = ?',
        [req.params.id, office]
      );
      if (group.screen_id) {
        await pool.execute(
          "DELETE FROM epos_screens WHERE id = ? AND office = ? AND surface = 'modifier'",
          [group.screen_id, office]
        );
      }

      // Keys that asked this question. The same rule a deleted screen follows:
      // a key that spanned keeps its ground, because the space the manager
      // arranged is still arranged and is waiting to be told what it does now;
      // a single cell is cleared outright. Without this a venue is left with a
      // key that reports itself broken and no way to see why.
      await pool.execute(
        `UPDATE epos_screen_buttons
            SET kind = 'blank', modifier_group_id = NULL,
                label = NULL, fill = NULL, ink = NULL,
                emoji = NULL, image_url = NULL,
                font_family = NULL, font_size = NULL
          WHERE office = ? AND modifier_group_id = ?
            AND (row_span > 1 OR col_span > 1)`,
        [office, req.params.id]
      );
      await pool.execute(
        `DELETE FROM epos_screen_buttons
          WHERE office = ? AND modifier_group_id = ?`,
        [office, req.params.id]
      );

      pushed(office);
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // -------------------------------------------------------------------------
  // What a product asks
  // -------------------------------------------------------------------------

  router.get('/products/:plu/modifiers', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const [rows] = await pool.query(
        `SELECT g.id, g.name, g.min_select, g.max_select, pm.sort_order
           FROM epos_product_modifiers pm
           JOIN epos_modifier_groups g ON g.id = pm.group_id
          WHERE pm.office = ? AND pm.plu_id = ?
          ORDER BY pm.sort_order`,
        [office, req.params.plu]
      );
      res.json(rows);
    } catch (e) {
      next(e);
    }
  });

  /**
   * Replace the ordered list of questions a product asks.
   *
   * The whole list, not a patch. The order is the meaning here — singles before
   * mixers — so the client sends what it wants to end up with and this writes
   * exactly that. Trying to express a reorder as a series of adds and removes
   * is how a list ends up in a state neither side intended.
   */
  router.put('/products/:plu/modifiers', auth, async (req, res, next) => {
    const conn = await pool.getConnection();
    try {
      const office = await tenantEmail(req);
      const plu = Number.parseInt(req.params.plu, 10);
      if (!Number.isFinite(plu)) {
        return res.status(400).json({ error: 'A PLU is required.' });
      }

      const wanted = Array.isArray(req.body?.group_ids) ? req.body.group_ids : [];
      const ids = [...new Set(wanted.map((n) => Number.parseInt(n, 10)))]
        .filter((n) => Number.isFinite(n));

      // Only this office's groups, checked rather than trusted: the ids arrive
      // from a browser, and a guessed one would otherwise attach another
      // venue's question to this venue's product.
      let mine = [];
      if (ids.length) {
        const [rows] = await conn.query(
          `SELECT id FROM epos_modifier_groups
            WHERE office = ? AND id IN (${ids.map(() => '?').join(',')})`,
          [office, ...ids]
        );
        mine = rows.map((r) => r.id);
      }
      const ordered = ids.filter((id) => mine.includes(id));

      await conn.beginTransaction();
      try {
        await conn.execute(
          'DELETE FROM epos_product_modifiers WHERE office = ? AND plu_id = ?',
          [office, plu]
        );
        for (const [i, id] of ordered.entries()) {
          await conn.execute(
            `INSERT INTO epos_product_modifiers (office, plu_id, group_id, sort_order)
             VALUES (?, ?, ?, ?)`,
            [office, plu, id, i]
          );
        }
        await conn.commit();
      } catch (e) {
        await conn.rollback();
        throw e;
      }

      pushed(office);
      res.json({ ok: true, count: ordered.length });
    } catch (e) {
      next(e);
    } finally {
      conn.release();
    }
  });

  return router;
}

// ---------------------------------------------------------------------------

function tillModifierRoutes({ pool }) {
  const router = express.Router();

  /**
   * Everything a till needs to ask the right questions.
   *
   * No buttons: the terminal has already fetched every screen in the venue from
   * /till/screens, and a group's answers are one of them. This is the wiring
   * only — which questions exist, how they behave, and which product asks
   * which.
   */
  router.get('/till/modifiers', async (req, res, next) => {
    try {
      const office = String(req.query.office || '').trim();
      if (!office) return res.status(400).json({ error: 'office is required' });

      const [groups] = await pool.query(
        `SELECT id, name, min_select, max_select, screen_id
           FROM epos_modifier_groups
          WHERE office = ?
          ORDER BY sort_order, name`,
        [office]
      );
      const [links] = await pool.query(
        `SELECT plu_id, group_id FROM epos_product_modifiers
          WHERE office = ?
          ORDER BY plu_id, sort_order`,
        [office]
      );

      // Keyed by PLU, in order, because that is how the till uses it: a product
      // is tapped and the question is "what does this one ask, and in what
      // order". A flat list would make the till do that grouping on every tap.
      const products = {};
      for (const link of links) {
        (products[link.plu_id] ||= []).push(link.group_id);
      }

      res.json({ groups, products });
    } catch (e) {
      next(e);
    }
  });

  return router;
}

module.exports = {
  modifierRoutes,
  tillModifierRoutes,
  selectionLimits,
  clampInt,
  MAX_GROUPS,
};
