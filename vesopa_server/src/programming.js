const express = require('express');
const { requireAuth } = require('./auth');

/**
 * Programming (tax, finalise keys, error reasons, mix & match, vouchers) and
 * the floor plan.
 *
 * Anything a till caches locally broadcasts on change, so a terminal on the
 * floor picks it up without being restarted.
 */
function programmingRoutes({ pool, broadcast, secret }) {
  const router = express.Router();
  const auth = requireAuth(secret);

  /**
   * Small CRUD factory — these tables are all shaped the same way.
   *
   * `sortable` tables carry a `sort_order` column the back office can drag to
   * reorder; the till reads them in that order. Non-sortable tables (none, now)
   * would simply fall back to id order.
   */
  function crud(path, table, columns, event, {
    sortable = true,
    tenantColumn = null,
    tenantBy = 'officeId',
  } = {}) {
    const orderBy = sortable ? 'sort_order, id' : 'id';
    const selectCols = sortable ? [...columns, 'sort_order'] : columns;

    /**
     * The office's contact email, which is the tenant key the catalogue tables
     * inherited from the PHP schema. Resolved per request rather than taken
     * from the token, because the token carries the *user's* email and two
     * managers in one shop must reach the same rows.
     */
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
     * The value this request's rows are owned by, or null when the table is
     * not tenanted — which leaves every query below exactly as it was.
     *
     * Admins have no office of their own and see everything; an office user is
     * confined to theirs.
     */
    const tenantValue = async (req) => {
      if (!tenantColumn || req.user.role === 'admin') return null;
      return tenantBy === 'email'
        ? await tenantEmail(req)
        : req.user.officeId ?? null;
    };

    const scope = async (req) => {
      const value = await tenantValue(req);
      return value == null
        ? { sql: '', params: [] }
        : { sql: ` AND ${tenantColumn} = ?`, params: [value] };
    };

    router.get(`/${path}`, auth, async (req, res, next) => {
      try {
        const { sql, params } = await scope(req);
        const [rows] = await pool.query(
          `SELECT id, ${selectCols.join(', ')} FROM ${table}
           WHERE 1 = 1${sql} ORDER BY ${orderBy}`,
          params
        );
        res.json(rows);
      } catch (e) {
        next(e);
      }
    });

    /**
     * Persist a drag-reorder as one batch, in a transaction: a half-applied
     * order would leave two rows fighting over the same slot on the till.
     * Body: { order: [id, id, …] } in the desired top-to-bottom order.
     */
    if (sortable) {
      router.put(`/${path}/reorder`, auth, async (req, res, next) => {
        const order = Array.isArray(req.body.order) ? req.body.order : [];
        const conn = await pool.getConnection();
        try {
          await conn.beginTransaction();
          for (let i = 0; i < order.length; i++) {
            await conn.execute(
              `UPDATE ${table} SET sort_order = ? WHERE id = ?`,
              [i + 1, order[i]]
            );
          }
          await conn.commit();
          if (event) broadcast({ type: event });
          res.json({ ok: true, ordered: order.length });
        } catch (e) {
          await conn.rollback();
          next(e);
        } finally {
          conn.release();
        }
      });
    }

    router.post(`/${path}`, auth, async (req, res, next) => {
      try {
        // New rows land at the bottom of the list, not the top: inserting with
        // sort_order 0 would jump a brand-new deal above everything already
        // ordered.
        const insertCols = [...columns];
        const values = columns.map((c) => req.body[c] ?? null);

        // Stamp the owning office. Without this a voucher was created with a
        // NULL office_id, and the till's lookup joins through that column — so
        // every voucher the back office issued was invisible to every terminal,
        // which is exactly how the voucher scheme came to look broken.
        //
        // On `bo_product_departments` the same omission was fatal rather than
        // merely invisible: its `email` column is NOT NULL with no default, so
        // adding a category — the screen where a manager assigns a button
        // image — failed outright with a null complaint about a column the
        // form never showed them.
        const owner = await tenantValue(req);
        if (owner != null) {
          insertCols.push(tenantColumn);
          values.push(owner);
        }

        if (sortable) {
          // Scoped to this office, so a new row lands at the bottom of *their*
          // list rather than after every other office's rows.
          const { sql, params } = await scope(req);
          const [[{ next_order }]] = await pool.query(
            `SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_order
             FROM ${table} WHERE 1 = 1${sql}`,
            params
          );
          insertCols.push('sort_order');
          values.push(next_order);
        }
        const [r] = await pool.execute(
          `INSERT INTO ${table} (${insertCols.join(', ')})
           VALUES (${insertCols.map(() => '?').join(', ')})`,
          values
        );
        if (event) broadcast({ type: event });
        res.status(201).json({ id: r.insertId });
      } catch (e) {
        next(e);
      }
    });

    router.put(`/${path}/:id`, auth, async (req, res, next) => {
      try {
        const values = columns.map((c) => req.body[c] ?? null);
        const { sql, params } = await scope(req);
        const [r] = await pool.execute(
          `UPDATE ${table} SET ${columns.map((c) => `${c} = ?`).join(', ')}
           WHERE id = ?${sql}`,
          [...values, req.params.id, ...params]
        );
        // Nothing matched means the row belongs to another office. Say so
        // rather than reporting a success that changed nothing.
        if (!r.affectedRows) return res.status(404).json({ error: 'Not found' });
        if (event) broadcast({ type: event });
        res.json({ ok: true });
      } catch (e) {
        next(e);
      }
    });

    router.delete(`/${path}/:id`, auth, async (req, res, next) => {
      try {
        const { sql, params } = await scope(req);
        const [r] = await pool.execute(
          `DELETE FROM ${table} WHERE id = ?${sql}`,
          [req.params.id, ...params]
        );
        if (!r.affectedRows) return res.status(404).json({ error: 'Not found' });
        if (event) broadcast({ type: event });
        res.json({ ok: true });
      } catch (e) {
        next(e);
      }
    });
  }

  // `sort_order` is added automatically by the factory (both column list and
  // ordering), so it is never listed here.
  crud('tax', 'bo_tax_rates', ['name', 'percentage', 'is_default'], 'programming.updated');
  crud('finalise-keys', 'bo_finalise_keys', ['name', 'kind', 'opens_drawer'], 'programming.updated');
  crud('error-reasons', 'bo_error_reasons', ['reason', 'applies_to'], 'programming.updated');
  // Every column the voucher editor shows has to be listed here, or it is
  // silently dropped on save: the factory builds its INSERT and UPDATE from
  // this list alone. It was the six original columns while the form offered
  // fifteen, so minimum spend, reusability, usage limits, start dates and the
  // till-button styling were all edited and then thrown away.
  //
  // Tenanted on `office_id`: the till validates a voucher by joining through
  // that column, so a row without it can never be redeemed anywhere.
  crud('vouchers', 'bo_vouchers', [
    'code', 'name', 'discount_type', 'value', 'expires_on', 'active',
    'starts_on', 'min_spend_minor', 'reusable', 'max_uses',
    'free_product_pluid', 'button_label', 'button_colour', 'button_size',
    'icon',
  ], 'programming.updated', { tenantColumn: 'office_id' });
  crud('mix-match', 'bo_mix_match', ['name', 'trigger_qty', 'deal_price_minor', 'active'], 'programming.updated');
  // Tenanted on `email`, not `office_id`: these two tables carry the office's
  // contact email as their owner, inherited from the PHP schema, and it is NOT
  // NULL on both. Running them untenanted meant every office read every other
  // office's categories, and adding one failed on the missing email — the
  // "can't be null" a manager hit when they gave a category a button image.
  crud('departments', 'bo_product_departments', ['department_name', 'group_name', 'accounting_code', 'emoji', 'image_url', 'button_color'], 'catalogue.updated', { tenantColumn: 'email', tenantBy: 'email' });
  crud('groups', 'bo_product_groups', ['group_name', 'accounting_code'], 'catalogue.updated', { tenantColumn: 'email', tenantBy: 'email' });

  // ---- Floor plan ---------------------------------------------------------

  /**
   * Which office a floor-plan request belongs to.
   *
   * The floor plan is tenanted by `office_id`, and this is where it used to go
   * wrong: rooms and tables were created with no office at all. The till reads
   * `/till/floor`, which joins `floor_tables.office_id -> offices.contact_email`,
   * so every table drawn in the designer had `office_id = NULL`, matched no
   * office, and never appeared on a terminal — the "table plan does not sync"
   * report. The designer showed them because *its* read was unscoped, which is
   * the same bug from the other side: one venue could see and delete another's
   * layout.
   *
   * Returns null only for an admin who has not named a target office, which is
   * the cross-office support view; writes refuse in that case rather than
   * creating another orphan row.
   */
  async function floorOfficeId(req) {
    if (req.user.officeId) return req.user.officeId;
    if (req.user.role !== 'admin') return null;

    if (req.query.office_id) return Number(req.query.office_id);
    if (req.body?.office_id) return Number(req.body.office_id);

    const email = req.query.office_email || req.body?.office_email;
    if (email) {
      const [[office]] = await pool.query(
        'SELECT id FROM offices WHERE contact_email = ?',
        [email]
      );
      if (office) return office.id;
    }
    return null;
  }

  /** The whole plan: rooms with their tables. Read by the designer and by the till. */
  router.get('/floor', auth, async (req, res, next) => {
    try {
      const officeId = await floorOfficeId(req);
      // An office user is pinned to their own plan; an admin who has not named
      // one still gets the cross-office view they had before.
      const where = officeId == null ? '' : ' WHERE office_id = ?';
      const params = officeId == null ? [] : [officeId];

      const [rooms] = await pool.query(
        `SELECT id, name, sort_order FROM floor_rooms${where}
         ORDER BY sort_order, id`,
        params
      );
      const [tables] = await pool.query(
        `SELECT id, room_id, table_number, label, pos_x, pos_y,
                width, height, shape, seats
         FROM floor_tables${where} ORDER BY table_number`,
        params
      );

      res.json(
        rooms.map((r) => ({
          ...r,
          tables: tables.filter((t) => t.room_id === r.id),
        }))
      );
    } catch (e) {
      next(e);
    }
  });

  router.post('/floor/rooms', auth, async (req, res, next) => {
    try {
      const officeId = await floorOfficeId(req);
      if (officeId == null) {
        return res.status(400).json({
          error: 'Choose an office before adding a room.',
        });
      }
      const [r] = await pool.execute(
        'INSERT INTO floor_rooms (office_id, name, sort_order) VALUES (?, ?, ?)',
        [officeId, req.body.name, req.body.sort_order ?? 0]
      );
      broadcast({ type: 'floor.updated' });
      res.status(201).json({ id: r.insertId });
    } catch (e) {
      next(e);
    }
  });

  router.delete('/floor/rooms/:id', auth, async (req, res, next) => {
    try {
      const officeId = await floorOfficeId(req);
      const [r] = await pool.execute(
        `DELETE FROM floor_rooms WHERE id = ?${
          officeId == null ? '' : ' AND office_id = ?'
        }`,
        officeId == null ? [req.params.id] : [req.params.id, officeId]
      );
      if (!r.affectedRows) {
        return res.status(404).json({ error: 'Room not found.' });
      }
      broadcast({ type: 'floor.updated' });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  router.post('/floor/tables', auth, async (req, res, next) => {
    const t = req.body;
    try {
      // The office comes from the *room* the table is being dropped into. A
      // table can never belong to a different office than its room, and taking
      // it from the room means the designer needs no extra field.
      const [[room]] = await pool.query(
        'SELECT office_id FROM floor_rooms WHERE id = ?',
        [t.room_id]
      );
      if (!room) return res.status(400).json({ error: 'Unknown room.' });

      const officeId = room.office_id ?? (await floorOfficeId(req));
      if (officeId == null) {
        return res.status(400).json({
          error: 'That room is not assigned to an office yet.',
        });
      }
      // An office user may only add to their own rooms.
      if (req.user.officeId && officeId !== req.user.officeId) {
        return res.status(403).json({ error: 'That room is not yours.' });
      }

      const [r] = await pool.execute(
        `INSERT INTO floor_tables
           (office_id, room_id, table_number, label, pos_x, pos_y, width,
            height, shape, seats)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          officeId,
          t.room_id,
          t.table_number,
          t.label ?? null,
          t.pos_x ?? 0,
          t.pos_y ?? 0,
          t.width ?? 2,
          t.height ?? 2,
          t.shape ?? 'rect',
          t.seats ?? 4,
        ]
      );
      broadcast({ type: 'floor.updated' });
      res.status(201).json({ id: r.insertId });
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') {
        return res
          .status(409)
          .json({ error: `Table ${t.table_number} already exists.` });
      }
      next(e);
    }
  });

  /**
   * Save positions after a drag. Sent as a batch and written in one
   * transaction: a half-applied layout would leave tables overlapping or
   * missing on the tills.
   */
  router.put('/floor/tables', auth, async (req, res, next) => {
    const tables = req.body.tables || [];
    const officeId = await floorOfficeId(req);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      for (const t of tables) {
        // Scoped to the office, so a drag in one venue's designer can never
        // move a table belonging to another.
        await conn.execute(
          `UPDATE floor_tables
           SET pos_x = ?, pos_y = ?, width = ?, height = ?,
               shape = ?, seats = ?, label = ?, room_id = ?
           WHERE id = ?${officeId == null ? '' : ' AND office_id = ?'}`,
          [
            t.pos_x, t.pos_y, t.width, t.height,
            t.shape, t.seats, t.label ?? null, t.room_id, t.id,
            ...(officeId == null ? [] : [officeId]),
          ]
        );
      }
      await conn.commit();

      // Push the new plan to every till immediately.
      broadcast({ type: 'floor.updated' });
      res.json({ ok: true, saved: tables.length });
    } catch (e) {
      await conn.rollback();
      next(e);
    } finally {
      conn.release();
    }
  });

  router.delete('/floor/tables/:id', auth, async (req, res, next) => {
    try {
      const officeId = await floorOfficeId(req);
      const [r] = await pool.execute(
        `DELETE FROM floor_tables WHERE id = ?${
          officeId == null ? '' : ' AND office_id = ?'
        }`,
        officeId == null ? [req.params.id] : [req.params.id, officeId]
      );
      if (!r.affectedRows) {
        return res.status(404).json({ error: 'Table not found.' });
      }
      broadcast({ type: 'floor.updated' });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // ---- Reports ------------------------------------------------------------

  /** Sales explorer: every line sold, filterable. */
  router.get('/sales-explorer', auth, async (req, res, next) => {
    const { from, to, department } = req.query;
    try {
      const where = ['o.closed_at IS NOT NULL'];
      const params = [];
      if (from) { where.push('DATE(o.closed_at) >= ?'); params.push(from); }
      if (to) { where.push('DATE(o.closed_at) <= ?'); params.push(to); }
      if (department) { where.push('pr.department_name = ?'); params.push(department); }

      const [rows] = await pool.query(
        `SELECT o.id, o.closed_at, o.table_number,
                l.name, l.quantity, l.unit_price_minor,
                COALESCE(pr.department_name, 'Other') AS department,
                (l.unit_price_minor * l.quantity) AS line_total_minor
         FROM epos_order_lines l
         JOIN epos_orders o ON o.id = l.order_id
         LEFT JOIN bo_products pr ON pr.pluid = l.plu_id
         WHERE ${where.join(' AND ')}
         ORDER BY o.closed_at DESC
         LIMIT 500`,
        params
      );
      res.json(rows);
    } catch (e) {
      next(e);
    }
  });

  /** Till report: a Z/X style summary per trading day. */
  router.get('/till-report', auth, async (_req, res, next) => {
    try {
      const [rows] = await pool.query(
        `SELECT DATE(o.closed_at)              AS day,
                COUNT(*)                       AS orders,
                SUM(o.total_minor)             AS gross_minor,
                SUM(o.tax_minor)               AS tax_minor,
                SUM(o.discount_minor)          AS discount_minor
         FROM epos_orders o
         WHERE o.closed_at IS NOT NULL
         GROUP BY day
         ORDER BY day DESC
         LIMIT 60`
      );
      res.json(rows);
    } catch (e) {
      next(e);
    }
  });

  /** Bill report: one row per bill, with its tender. */
  router.get('/bill-report', auth, async (_req, res, next) => {
    try {
      const [rows] = await pool.query(
        `SELECT o.id, o.closed_at, o.table_number, o.covers,
                o.subtotal_minor, o.discount_minor, o.tax_minor, o.total_minor,
                GROUP_CONCAT(DISTINCT p.method) AS methods
         FROM epos_orders o
         LEFT JOIN epos_payments p ON p.order_id = o.id
         WHERE o.closed_at IS NOT NULL
         GROUP BY o.id
         ORDER BY o.closed_at DESC
         LIMIT 200`
      );
      res.json(rows);
    } catch (e) {
      next(e);
    }
  });

  return router;
}

module.exports = { programmingRoutes };
