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
   * The office's contact email, which is the tenant key the catalogue and
   * trading tables inherited from the PHP schema. Resolved per request rather
   * than taken from the token, because the token carries the *user's* email and
   * two managers in one shop must reach the same rows.
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
   * The office whose trading a report request may read.
   *
   * Every report below filters on this. They did not, once — `/sales-explorer`,
   * `/till-report` and `/bill-report` selected from `epos_orders` with nothing
   * but `closed_at IS NOT NULL`, so a venue that had never rung up a sale
   * opened its Till Report and read somebody else's takings, bill by bill. Two
   * of the three were even written `async (_req, ...)`: the request was not
   * consulted, which is what let it go unnoticed.
   *
   * The platform admin is pinned to whichever office they name, or to their own
   * address — which owns no trading rows — rather than being handed every
   * office's bills in one undifferentiated list.
   */
  async function reportScope(req) {
    return req.user.role === 'admin' && req.query.office_email
      ? req.query.office_email
      : await tenantEmail(req);
  }

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
        // Scoped like every other write here, and it was the one that was not.
        // `WHERE id = ?` on its own accepted any id from any signed-in office,
        // so one venue could hand this another venue's rows and rewrite the
        // order their kitchen tickets print in. It answered 200 while doing it.
        const { sql, params } = await scope(req);
        const conn = await pool.getConnection();
        try {
          await conn.beginTransaction();
          let moved = 0;
          for (let i = 0; i < order.length; i++) {
            const [r] = await conn.execute(
              `UPDATE ${table} SET sort_order = ? WHERE id = ?${sql}`,
              [i + 1, order[i], ...params]
            );
            moved += r.affectedRows;
          }
          // An id that belongs to somebody else now matches nothing rather than
          // moving their row, and a caller that sent one is told so instead of
          // being quietly given a 200 for work that did not happen.
          if (moved !== order.length) {
            await conn.rollback();
            return res
              .status(404)
              .json({ error: 'Some of those rows are not yours to reorder.' });
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
  // All three carry `office_id` and none of them was told so, which meant the
  // factory scoped nothing: `WHERE 1 = 1` on the list, `WHERE id = ?` on the
  // update and the delete. A venue created that morning opened Tax and read
  // three rates it had never entered, and could have deleted another venue's
  // Cash key. Tenanted now, like everything else here.
  crud('tax', 'bo_tax_rates', ['name', 'percentage', 'is_default'], 'programming.updated', { tenantColumn: 'office_id' });
  crud('finalise-keys', 'bo_finalise_keys', ['name', 'kind', 'opens_drawer'], 'programming.updated', { tenantColumn: 'office_id' });
  crud('error-reasons', 'bo_error_reasons', ['reason', 'applies_to'], 'programming.updated', { tenantColumn: 'office_id' });
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
  crud('mix-match', 'bo_mix_match', ['name', 'trigger_qty', 'deal_price_minor', 'active'], 'programming.updated', { tenantColumn: 'office_id' });
  // Tenanted on `email`, not `office_id`: these two tables carry the office's
  // contact email as their owner, inherited from the PHP schema, and it is NOT
  // NULL on both. Running them untenanted meant every office read every other
  // office's categories, and adding one failed on the missing email — the
  // "can't be null" a manager hit when they gave a category a button image.
  crud('departments', 'bo_product_departments', ['department_name', 'group_name', 'accounting_code', 'emoji', 'image_url', 'button_color'], 'catalogue.updated', { tenantColumn: 'email', tenantBy: 'email' });
  crud('groups', 'bo_product_groups', ['group_name', 'accounting_code'], 'catalogue.updated', { tenantColumn: 'email', tenantBy: 'email' });
  // Printing categories: the order a kitchen ticket comes out in. Dragged
  // rather than numbered, which is what `sortable` gives for free — a venue
  // reorders Breakfast, Mains, Desserts by moving the rows.
  crud('print-categories', 'bo_print_categories', ['name'], 'catalogue.updated', { tenantColumn: 'email', tenantBy: 'email' });

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

  /**
   * A room's outline, validated into something both designers can trust.
   *
   * The back office draws L-shapes, T-shapes and the odd bay window by dropping
   * points; the till renders the same polygon. Neither may be handed a shape it
   * cannot draw, so anything that is not a run of at least three finite points
   * becomes null — which both ends already understand as "a plain rectangle",
   * the behaviour every existing room has.
   *
   * Stored as compact JSON rather than as the object it arrived as: this string
   * goes into a TEXT column and comes back out to two different clients, and a
   * shape that round-trips differently on each is a shape that drifts.
   */
  function outlineOf(raw) {
    if (raw == null || raw === '') return null;
    let points = raw;
    if (typeof raw === 'string') {
      try {
        points = JSON.parse(raw);
      } catch {
        return null;
      }
    }
    if (!Array.isArray(points) || points.length < 3) return null;

    const clean = [];
    for (const point of points) {
      if (!Array.isArray(point) || point.length < 2) return null;
      const x = Number(point[0]);
      const y = Number(point[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      // Clamped to the grid the designer works in. A point at -4 or at 900 is a
      // dragging accident, and a room extending off the plan cannot be dragged
      // back because its handle is off the plan too.
      clean.push([
        Math.max(0, Math.min(200, Math.round(x))),
        Math.max(0, Math.min(200, Math.round(y))),
      ]);
    }
    // A shape with more than a couple of hundred corners is not a room.
    return clean.length > 200 ? null : JSON.stringify(clean);
  }

  /**
   * A table's public address: 32 hex characters, minted once.
   *
   * Random rather than a counter or a hash of the table number, because this is
   * printed on a card that sits in a public room. A predictable one would let
   * anybody in the building order onto any table by editing a URL — including
   * a table they are not sitting at, and including one nobody has sat at all
   * evening.
   */
  function newPublicId() {
    return require('crypto').randomUUID().replace(/-/g, '');
  }

  /**
   * Whether a table name is already taken in this venue.
   *
   * The venue asked for it plainly: one table name cannot be another table name
   * in the same kitchen. Enforced here rather than by a unique index, because
   * the index would have to cover a nullable `office_id` — and MySQL does not
   * treat NULLs as equal, which is exactly how the duplicate table *numbers*
   * got in before schema_fix_table_uq.sql. Doing it in code also lets the
   * manager be told which room the other one is in, which an index cannot.
   *
   * Compared trimmed and case-insensitively: "Booth 3" and "booth 3 " are the
   * same table to everybody except a database.
   */
  async function nameClash(officeId, name, exceptId) {
    const clean = (name == null ? '' : String(name)).trim();
    if (!clean || officeId == null) return null;

    const [[row]] = await pool.query(
      'SELECT t.id, r.name AS room' +
        '  FROM floor_tables t' +
        '  LEFT JOIN floor_rooms r ON r.id = t.room_id' +
        ' WHERE t.office_id = ?' +
        '   AND LOWER(TRIM(t.name)) = LOWER(?)' +
        (exceptId == null ? '' : ' AND t.id <> ?') +
        ' LIMIT 1',
      exceptId == null ? [officeId, clean] : [officeId, clean, exceptId]
    );
    if (!row) return null;
    return row.room
      ? 'There is already a table called "' + clean + '" in ' + row.room + '.'
      : 'There is already a table called "' + clean + '" here.';
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
        `SELECT id, name, sort_order, outline, cols, \`rows\`
         FROM floor_rooms${where}
         ORDER BY sort_order, id`,
        params
      );
      const [tables] = await pool.query(
        `SELECT id, room_id, table_number, label, name, public_id, qr_enabled,
                pos_x, pos_y, width, height, shape, seats
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
        `INSERT INTO floor_rooms (office_id, name, sort_order, outline, cols, \`rows\`)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          officeId,
          req.body.name,
          req.body.sort_order ?? 0,
          outlineOf(req.body.outline),
          Number(req.body.cols) || 12,
          Number(req.body.rows) || 8,
        ]
      );
      broadcast({ type: 'floor.updated' });
      res.status(201).json({ id: r.insertId });
    } catch (e) {
      next(e);
    }
  });

  /**
   * Rename a room, or redraw its outline.
   *
   * Separate from the table drag: a room's shape changes when somebody puts a
   * wall in, which is a deliberate act, and folding it into the handler that
   * fires on every drag would mean a dropped table could reshape the room.
   */
  router.put('/floor/rooms/:id', auth, async (req, res, next) => {
    try {
      const officeId = await floorOfficeId(req);
      const sets = [];
      const params = [];
      if (req.body.name !== undefined) {
        sets.push('name = ?');
        params.push(String(req.body.name).trim());
      }
      if (req.body.outline !== undefined) {
        sets.push('outline = ?');
        params.push(outlineOf(req.body.outline));
      }
      if (req.body.cols !== undefined) {
        sets.push('cols = ?');
        params.push(Math.max(4, Math.min(60, Number(req.body.cols) || 12)));
      }
      if (req.body.rows !== undefined) {
        sets.push('`rows` = ?');
        params.push(Math.max(4, Math.min(60, Number(req.body.rows) || 8)));
      }
      if (req.body.sort_order !== undefined) {
        sets.push('sort_order = ?');
        params.push(Number(req.body.sort_order) || 0);
      }
      if (!sets.length) return res.json({ ok: true, changed: 0 });

      const [r] = await pool.execute(
        'UPDATE floor_rooms SET ' + sets.join(', ') + ' WHERE id = ?' +
          (officeId == null ? '' : ' AND office_id = ?'),
        officeId == null
          ? [...params, req.params.id]
          : [...params, req.params.id, officeId]
      );
      if (!r.affectedRows) {
        return res.status(404).json({ error: 'Room not found.' });
      }
      broadcast({ type: 'floor.updated' });
      res.json({ ok: true, changed: r.affectedRows });
    } catch (e) {
      next(e);
    }
  });

  /**
   * Rename one table, renumber it, or turn its QR code off.
   *
   * The name is checked against the whole venue before it is written — see
   * [nameClash] — so a manager renaming Table 4 to "Window" is told which room
   * the other Window is in rather than being allowed to create the ambiguity.
   */
  router.put('/floor/tables/:id', auth, async (req, res, next) => {
    try {
      const officeId = await floorOfficeId(req);
      const [[table]] = await pool.query(
        'SELECT id, office_id FROM floor_tables WHERE id = ?',
        [req.params.id]
      );
      if (!table) return res.status(404).json({ error: 'Table not found.' });
      if (officeId != null && table.office_id !== officeId) {
        return res.status(403).json({ error: 'That table is not yours.' });
      }

      if (req.body.name !== undefined) {
        const clash = await nameClash(table.office_id, req.body.name, table.id);
        if (clash) return res.status(409).json({ error: clash });
      }

      const sets = [];
      const params = [];
      const changes = [
        ['name', req.body.name === undefined
          ? undefined
          : (String(req.body.name).trim() || null)],
        ['label', req.body.label],
        ['table_number', req.body.table_number],
        ['seats', req.body.seats],
        ['qr_enabled', req.body.qr_enabled === undefined
          ? undefined
          : (req.body.qr_enabled ? 1 : 0)],
      ];
      for (const [field, value] of changes) {
        if (value === undefined) continue;
        sets.push(field + ' = ?');
        params.push(value);
      }
      if (!sets.length) return res.json({ ok: true, changed: 0 });

      const [r] = await pool.execute(
        'UPDATE floor_tables SET ' + sets.join(', ') + ' WHERE id = ?',
        [...params, table.id]
      );
      broadcast({ type: 'floor.updated' });
      res.json({ ok: true, changed: r.affectedRows });
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({
          error: 'Another table already has that number in this room.',
        });
      }
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

      // A name has to be unique across the whole venue, not merely within the
      // room. The customer-facing menu says "Table 12" and a runner carries
      // food to it; two tables answering to that name in one building is a
      // plate going to the wrong people, and the rooms they are in does not
      // help anybody holding it.
      const clash = await nameClash(officeId, t.name, null);
      if (clash) return res.status(409).json({ error: clash });

      const [r] = await pool.execute(
        `INSERT INTO floor_tables
           (office_id, room_id, table_number, label, name, public_id,
            qr_enabled, pos_x, pos_y, width, height, shape, seats)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          officeId,
          t.room_id,
          t.table_number,
          t.label ?? null,
          (t.name ?? '').trim() || null,
          // Minted here and never again. See schema_dinein.sql: this is the
          // address printed on the card that sits on the table, so it must not
          // change when the table is renamed, renumbered or moved rooms.
          newPublicId(),
          t.qr_enabled === false ? 0 : 1,
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
               shape = ?, seats = ?, label = ?, room_id = ?,
               name = COALESCE(?, name),
               qr_enabled = COALESCE(?, qr_enabled)
           WHERE id = ?${officeId == null ? '' : ' AND office_id = ?'}`,
          [
            t.pos_x, t.pos_y, t.width, t.height,
            t.shape, t.seats, t.label ?? null, t.room_id,
            // COALESCE rather than a plain assignment: this route is the
            // designer's drag handler, and a drag that omitted the name must
            // not blank it. Only a payload that actually carries one changes it.
            t.name === undefined ? null : (String(t.name).trim() || null),
            t.qr_enabled === undefined ? null : (t.qr_enabled ? 1 : 0),
            t.id,
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

  /**
   * Sales explorer: every line sold, filterable, a page at a time.
   *
   * It used to answer with a flat 500 rows and the browser drew all of them.
   * On a phone that is 500 cards of five fields in one go — a slow query, a
   * slow paint, and a scrollbar that says the list is nearly over when it is
   * not. The browser now asks for a page at a time and fetches the next one
   * before the scroll reaches the bottom, so `limit` and `offset` are what
   * decide the size of the work rather than a constant in the SQL.
   *
   * ORDER BY carries `l.id` as a tiebreak, and that is what makes paging
   * correct rather than merely possible. Every line on one bill shares its
   * `closed_at` to the second, so ordering by that alone leaves the order
   * within a bill undefined — MySQL is free to return those rows differently
   * for page 2 than it did for page 1, and the reader gets one line twice and
   * never sees another. A unique column at the end of the sort is what stops
   * that.
   */
  router.get('/sales-explorer', auth, async (req, res, next) => {
    const { from, to, department } = req.query;
    try {
      const office = await reportScope(req);
      const where = ['o.email = ?', 'o.closed_at IS NOT NULL'];
      const params = [office];
      if (from) { where.push('DATE(o.closed_at) >= ?'); params.push(from); }
      if (to) { where.push('DATE(o.closed_at) <= ?'); params.push(to); }
      if (department) { where.push('pr.department_name = ?'); params.push(department); }

      // Coerced to integers here and interpolated, not bound: LIMIT and OFFSET
      // placeholders are a well-known way to get "You have an error in your SQL
      // syntax" out of a prepared statement, and a number that has been through
      // Number() and Math.max cannot carry an injection.
      const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 200);
      const offset = Math.max(Number(req.query.offset) || 0, 0);

      const [rows] = await pool.query(
        `SELECT o.id, o.closed_at, o.table_number,
                l.name, l.quantity, l.unit_price_minor,
                COALESCE(pr.department_name, 'Other') AS department,
                (l.unit_price_minor * l.quantity) AS line_total_minor
         FROM epos_order_lines l
         JOIN epos_orders o ON o.id = l.order_id
         LEFT JOIN bo_products pr
                ON pr.pluid = l.plu_id AND pr.email = o.email
         WHERE ${where.join(' AND ')}
         ORDER BY o.closed_at DESC, l.id DESC
         LIMIT ${limit} OFFSET ${offset}`,
        params
      );

      // Still a bare array, because that is what this route has always
      // answered with and the browser tells "there is more" from a full page.
      res.json(rows);
    } catch (e) {
      next(e);
    }
  });

  /** Till report: a Z/X style summary per trading day. */
  router.get('/till-report', auth, async (req, res, next) => {
    try {
      const office = await reportScope(req);
      const [rows] = await pool.query(
        `SELECT DATE(o.closed_at)              AS day,
                COUNT(*)                       AS orders,
                SUM(o.total_minor)             AS gross_minor,
                SUM(o.tax_minor)               AS tax_minor,
                SUM(o.discount_minor)          AS discount_minor
         FROM epos_orders o
         WHERE o.email = ? AND o.closed_at IS NOT NULL
         GROUP BY day
         ORDER BY day DESC
         LIMIT 60`,
        [office]
      );
      res.json(rows);
    } catch (e) {
      next(e);
    }
  });

  /**
   * Bill report: one row per bill, with its tender.
   *
   * Paged, like /sales-explorer and for the same reason: a venue a year old has
   * more bills than anyone will scroll, and `LIMIT 200` did not so much page
   * that as hide it — the two hundred and first bill could not be reached at
   * all, from anywhere in the back office.
   *
   * Interpolated rather than bound, because MySQL will not take a placeholder
   * in LIMIT out of a prepared statement; both have been through Number() and
   * Math.max/min by then and cannot carry an injection.
   */
  router.get('/bill-report', auth, async (req, res, next) => {
    try {
      const office = await reportScope(req);
      const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 200);
      const offset = Math.max(Number(req.query.offset) || 0, 0);

      const [rows] = await pool.query(
        `SELECT o.id, o.closed_at, o.table_number, o.covers,
                o.subtotal_minor, o.discount_minor, o.tax_minor, o.total_minor,
                GROUP_CONCAT(DISTINCT p.method) AS methods
         FROM epos_orders o
         LEFT JOIN epos_payments p ON p.order_id = o.id
         WHERE o.email = ? AND o.closed_at IS NOT NULL
         GROUP BY o.id
         -- closed_at alone is not unique: a busy counter settles several bills
         -- in the same second, and LIMIT/OFFSET over an order that is only
         -- partly defined shows one of them twice and another never. The id
         -- breaks the tie.
         ORDER BY o.closed_at DESC, o.id DESC
         LIMIT ${limit} OFFSET ${offset}`,
        [office]
      );
      res.json(rows);
    } catch (e) {
      next(e);
    }
  });

  return router;
}

module.exports = { programmingRoutes };
