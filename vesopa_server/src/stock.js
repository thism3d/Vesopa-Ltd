/**
 * Stock control: suppliers, pack sizes, the ledger, and the documents that
 * write to it.
 *
 * WHAT CHANGED
 *
 * Stock used to be one number on the product. The back office could add to it
 * or overwrite it, a sale took from it, and nothing remembered why it moved.
 * The venue that came off Newbridge asked for what Newbridge had -- movements,
 * valuation, wastage, variance, orders and deliveries -- and every one of those
 * is a question about *history*, which one number cannot answer.
 *
 * So the number is now a balance, and this module owns the ledger it is the
 * balance of:
 *
 *   * `epos_stock_movements` is the truth. A sale writes it (sales.js); every
 *     other change comes through a DOCUMENT here. `bo_products.stock_quantity`
 *     is kept in step with it and is what the till and the Stock Levels page
 *     read, so nothing that already worked has to learn about the ledger.
 *
 *   * A document -- wastage, adjustment, stocktake, spot check, delivery -- is
 *     drafted with lines and then COMPLETED, once. Completion is one
 *     transaction: read the current count of every line into `expected`, write
 *     the movement, move the count. A document is applied whole or not at all,
 *     and a second Complete on the same document is refused rather than
 *     applied twice. That refusal is the single most important line in the
 *     file: a stocktake applied twice puts every count out by its own variance.
 *
 *   * A stocktake SETS; everything else ADDS. The line on a stocktake is what
 *     was counted, and the movement is whatever makes the balance say that. The
 *     line on a wastage is what was thrown away, and the movement is minus
 *     that. Two different questions, one table, and `kind` says which was
 *     asked.
 *
 *   * A purchase order is in PACKS, because that is how a supplier sells, and a
 *     delivery against it turns packs into units through the pack size copied
 *     onto the line when the order was made. A pack renamed next year does not
 *     restate what was ordered this year.
 *
 * SCOPING. Every read and write binds the office in the WHERE, like every
 * other module, and the join to bo_products carries it too: `pluid` is unique
 * within a venue and not across the platform.
 */

const crypto = require('crypto');

const express = require('express');

const { requireAuth } = require('./auth');
const { accessGuard } = require('./permissions');
const { sendMail } = require('./mailer');
const { stockTargets } = require('./stock_effects');

const DOC_KINDS = ['wastage', 'adjustment', 'stocktake', 'spot_check', 'delivery'];
const ORDER_STATUSES = ['new', 'sent', 'part_delivered', 'delivered', 'cancelled'];

/** The kinds of document whose lines are a COUNT rather than a movement. */
const COUNTING = new Set(['stocktake', 'spot_check']);

/**
 * The pack sizes every venue starts with.
 *
 * Seeded on first read rather than in SQL, because the schema does not know
 * which offices exist and a venue made next week would miss a seed run today.
 * The names are the ones a bar actually uses; a venue that sells by the case
 * of 48 adds it in ten seconds.
 */
const DEFAULT_PACKS = [
  ['Each', 1],
  ['Pack of 6', 6],
  ['Pack of 12', 12],
  ['Pack of 24', 24],
  ['9g Keg', 72],
  ['11g Keg', 88],
  ['70cl Bottle', 28],
];

const uuid = () => crypto.randomUUID();

/** A DOUBLE column as a number, or null when unset. */
function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** A quantity that must be a number. Throws a 400-shaped error otherwise. */
function quantity(value, what = 'quantity') {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    const e = new Error(`Give a number for the ${what}.`);
    e.status = 400;
    throw e;
  }
  return n;
}

const bad = (message) => {
  const e = new Error(message);
  e.status = 400;
  return e;
};

/**
 * What one unit costs the venue, in pence.
 *
 * From the pack when the product has one and a pack cost -- that is what the
 * supplier's invoice says -- and from `cost_price` otherwise, which is what the
 * product form has always taken. Where both exist the pack wins, and
 * `cost_price` is written to match on save (see `syncCostPrice`) so every
 * older reader of that column sees the same figure.
 */
function unitCostMinor(product) {
  const packCost = num(product.pack_cost);
  const units = num(product.pack_units);
  if (packCost !== null && units && units > 0) {
    return Math.round((packCost / units) * 100);
  }
  const cost = num(product.cost_price);
  return cost === null ? 0 : Math.round(cost * 100);
}

/**
 * `-16.00 (-0.18 11g Keg)`: units, with the same figure in packs beside it.
 *
 * The reference shows both on every stock report, and it is right to: a
 * cellar manager thinks in kegs and a barman in pints, and the report is read
 * by both.
 */
function withPacks(units, packName, packUnits) {
  const u = Number(units) || 0;
  const shown = Number.isInteger(u) ? String(u) : u.toFixed(2);
  if (!packName || !packUnits || packUnits <= 1) return shown;
  return `${shown} (${(u / packUnits).toFixed(2)} ${packName})`;
}

/** The GP% the calculator aims for when a product has not been given one. */
const DEFAULT_TARGET_GP = 70;

/**
 * Gross profit, and the price that would hit the target.
 *
 * The till price includes VAT, so GP is worked on the price without it:
 *   net   = price / (1 + VAT)
 *   GP%   = (net - cost) / net
 * and the recommended price is the one whose net gives the target:
 *   price = cost / (1 - target) x (1 + VAT)
 * rounded UP to the next 5p -- a recommendation that lands at £3.02 is
 * useless on a menu, and rounding down would quietly miss the target.
 *
 * Nothing without a cost: GP on a product whose cost nobody has entered is a
 * number that is always 100% and always wrong.
 */
function gpFigures(price, taxPercentage, costMinor, targetGp) {
  const cost = Number(costMinor) || 0;
  const vat = 1 + (Number(taxPercentage) || 0) / 100;
  const target = num(targetGp) ?? DEFAULT_TARGET_GP;
  if (!cost) return { has_cost: false, target_gp: target };
  const priceMinor = Math.round((Number(price) || 0) * 100);
  const net = priceMinor / vat;
  const current = net > 0 ? ((net - cost) / net) * 100 : null;
  const t = Math.min(Math.max(target, 0), 99) / 100;
  const raw = (cost / (1 - t)) * vat;
  const recommended = Math.ceil(raw / 5) * 5;
  return {
    has_cost: true,
    target_gp: target,
    current_gp: current === null ? null : Number(current.toFixed(1)),
    recommended_price_minor: recommended,
    profit_minor: Math.round(net - cost),
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

function stockRoutes({ pool, broadcast, secret, toPdf }) {
  const router = express.Router();
  const auth = requireAuth(secret);
  const mayEdit = accessGuard({ pool, secret })('stock.edit');

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

  /** The office's display name, for a PDF's header. */
  async function siteName(req, office) {
    if (req.user.officeId) {
      const [[row]] = await pool.query('SELECT name FROM offices WHERE id = ?', [
        req.user.officeId,
      ]);
      if (row && row.name) return row.name;
    }
    return office;
  }

  const who = (req) => req.user.name || req.user.email || null;

  const changed = (what) => broadcast && broadcast({ type: `stock.${what}` });

  /**
   * The product query every list here starts from: the stock columns, the
   * supplier and the pack joined in by office. Filterable by department.
   */
  const PRODUCT_SELECT = `
    SELECT p.id, p.pluid, p.product_name, p.department_name, p.group_name,
           p.price, p.tax_percentage, p.cost_price, p.stock_quantity,
           p.low_stock_at, p.min_stock, p.max_stock, p.stock_unit,
           p.supplier_id, p.supplier_code, p.pack_size_id, p.pack_cost,
           p.barcode, p.active,
           p.non_stock, p.stock_parent_pluid, p.stock_ratio, p.target_gp,
           s.name  AS supplier_name,
           k.name  AS pack_name,
           k.units AS pack_units,
           par.product_name AS parent_name,
           (SELECT COUNT(*) FROM bo_recipe_lines r
             WHERE r.office = p.email AND r.recipe_pluid = p.pluid) AS recipe_lines
      FROM bo_products p
      LEFT JOIN bo_suppliers  s ON s.id = p.supplier_id  AND s.office = p.email
      LEFT JOIN bo_pack_sizes k ON k.id = p.pack_size_id AND k.office = p.email
      LEFT JOIN bo_products par ON par.pluid = p.stock_parent_pluid AND par.email = p.email
     WHERE p.email = ?`;

  /** A product row with the derived figures every page shows. */
  function decorate(p) {
    const cost = unitCostMinor(p);
    const stock = num(p.stock_quantity);
    const tracked = stock !== null;
    const low = num(p.low_stock_at) ?? num(p.min_stock);
    const level = !tracked
      ? 'untracked'
      : stock <= 0
        ? 'out'
        : low !== null && stock <= low
          ? 'low'
          : 'ok';
    const linked = Boolean(p.stock_parent_pluid);
    const recipe = Number(p.recipe_lines) > 0;
    return {
      ...p,
      non_stock: Number(p.non_stock) ? 1 : 0,
      is_linked: linked,
      is_recipe: recipe,
      /*
       * WHAT A STOCKTAKE OFFERS (2026-09-22): "only products that have a case
       * size should appear", and never one marked non-stock. A linked product
       * or a recipe has no shelf of its own -- its stock is its parent's or
       * its ingredients' -- so it is not counted either.
       */
      stock_item: !Number(p.non_stock) && Boolean(p.pack_size_id) && !linked && !recipe,
      unit_cost_minor: cost,
      gp: gpFigures(p.price, p.tax_percentage, cost, p.target_gp),
      stock_value_minor: tracked ? Math.round(stock * cost) : 0,
      packs_on_hand:
        tracked && p.pack_units > 1 ? Number((stock / p.pack_units).toFixed(2)) : null,
      stock_display: tracked ? withPacks(stock, p.pack_name, p.pack_units) : 'Not tracked',
      level,
    };
  }

  async function product(conn, office, pluid) {
    const [[row]] = await conn.query(`${PRODUCT_SELECT} AND p.pluid = ? LIMIT 1`, [
      office,
      pluid,
    ]);
    return row || null;
  }

  // -------------------------------------------------------------------------
  // Suppliers
  // -------------------------------------------------------------------------

  router.get('/stock/suppliers', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const [rows] = await pool.query(
        `SELECT s.*,
                (SELECT COUNT(*) FROM bo_products p
                  WHERE p.email = s.office AND p.supplier_id = s.id) AS product_count,
                (SELECT COUNT(*) FROM bo_purchase_orders o
                  WHERE o.office = s.office AND o.supplier_id = s.id) AS order_count
           FROM bo_suppliers s
          WHERE s.office = ?
          ORDER BY s.active DESC, s.name`,
        [office]
      );
      res.json(rows);
    } catch (e) {
      next(e);
    }
  });

  function supplierFields(body) {
    const name = String(body.name || '').trim();
    if (!name) throw bad('A supplier needs a name.');
    return [
      name,
      String(body.contact_name || '').trim() || null,
      String(body.phone || '').trim() || null,
      String(body.email || '').trim() || null,
      String(body.account_ref || '').trim() || null,
      String(body.notes || '').trim() || null,
      body.active === false || body.active === 0 ? 0 : 1,
    ];
  }

  router.post('/stock/suppliers', mayEdit, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const fields = supplierFields(req.body || {});
      const [result] = await pool.execute(
        `INSERT INTO bo_suppliers
           (office, name, contact_name, phone, email, account_ref, notes, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [office, ...fields]
      );
      changed('suppliers');
      res.status(201).json({ id: result.insertId });
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'There is already a supplier with that name.' });
      next(e);
    }
  });

  router.put('/stock/suppliers/:id', mayEdit, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const fields = supplierFields(req.body || {});
      const [result] = await pool.execute(
        `UPDATE bo_suppliers
            SET name = ?, contact_name = ?, phone = ?, email = ?, account_ref = ?,
                notes = ?, active = ?
          WHERE id = ? AND office = ?`,
        [...fields, req.params.id, office]
      );
      if (!result.affectedRows) return res.status(404).json({ error: 'No such supplier.' });
      changed('suppliers');
      res.json({ ok: true });
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'There is already a supplier with that name.' });
      next(e);
    }
  });

  /**
   * A supplier with orders is kept, because the orders name it. Deactivate
   * instead; the list sorts inactive ones to the bottom.
   */
  router.delete('/stock/suppliers/:id', mayEdit, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const [[used]] = await pool.query(
        'SELECT COUNT(*) AS n FROM bo_purchase_orders WHERE office = ? AND supplier_id = ?',
        [office, req.params.id]
      );
      if (used.n > 0) {
        return res.status(409).json({
          error: 'This supplier has orders against it. Mark it inactive instead.',
        });
      }
      await pool.execute(
        'UPDATE bo_products SET supplier_id = NULL WHERE email = ? AND supplier_id = ?',
        [office, req.params.id]
      );
      const [result] = await pool.execute(
        'DELETE FROM bo_suppliers WHERE id = ? AND office = ?',
        [req.params.id, office]
      );
      if (!result.affectedRows) return res.status(404).json({ error: 'No such supplier.' });
      changed('suppliers');
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // -------------------------------------------------------------------------
  // Pack sizes
  // -------------------------------------------------------------------------

  async function packSizes(office) {
    const [rows] = await pool.query(
      'SELECT id, name, units FROM bo_pack_sizes WHERE office = ? ORDER BY units, name',
      [office]
    );
    if (rows.length) return rows;
    for (const [name, units] of DEFAULT_PACKS) {
      await pool.execute(
        'INSERT IGNORE INTO bo_pack_sizes (office, name, units) VALUES (?, ?, ?)',
        [office, name, units]
      );
    }
    const [seeded] = await pool.query(
      'SELECT id, name, units FROM bo_pack_sizes WHERE office = ? ORDER BY units, name',
      [office]
    );
    return seeded;
  }

  router.get('/stock/pack-sizes', auth, async (req, res, next) => {
    try {
      res.json(await packSizes(await tenantEmail(req)));
    } catch (e) {
      next(e);
    }
  });

  function packFields(body) {
    const name = String(body.name || '').trim();
    if (!name) throw bad('A pack size needs a name.');
    const units = Number(body.units);
    if (!Number.isFinite(units) || units <= 0) throw bad('Units per pack must be more than zero.');
    return [name, units];
  }

  router.post('/stock/pack-sizes', mayEdit, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const [result] = await pool.execute(
        'INSERT INTO bo_pack_sizes (office, name, units) VALUES (?, ?, ?)',
        [office, ...packFields(req.body || {})]
      );
      changed('pack_sizes');
      res.status(201).json({ id: result.insertId });
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'There is already a pack size with that name.' });
      next(e);
    }
  });

  router.put('/stock/pack-sizes/:id', mayEdit, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const [result] = await pool.execute(
        'UPDATE bo_pack_sizes SET name = ?, units = ? WHERE id = ? AND office = ?',
        [...packFields(req.body || {}), req.params.id, office]
      );
      if (!result.affectedRows) return res.status(404).json({ error: 'No such pack size.' });
      changed('pack_sizes');
      res.json({ ok: true });
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'There is already a pack size with that name.' });
      next(e);
    }
  });

  router.delete('/stock/pack-sizes/:id', mayEdit, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const [[used]] = await pool.query(
        'SELECT COUNT(*) AS n FROM bo_products WHERE email = ? AND pack_size_id = ?',
        [office, req.params.id]
      );
      if (used.n > 0) {
        return res.status(409).json({
          error: `${used.n} product${used.n === 1 ? ' is' : 's are'} bought in this pack. Change them first.`,
        });
      }
      const [result] = await pool.execute(
        'DELETE FROM bo_pack_sizes WHERE id = ? AND office = ?',
        [req.params.id, office]
      );
      if (!result.affectedRows) return res.status(404).json({ error: 'No such pack size.' });
      changed('pack_sizes');
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // -------------------------------------------------------------------------
  // Products: the stock view of the catalogue
  // -------------------------------------------------------------------------

  router.get('/stock/products', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const params = [office];
      let where = '';
      if (req.query.department) {
        where += ' AND p.department_name = ?';
        params.push(String(req.query.department));
      }
      if (req.query.supplier) {
        where += ' AND p.supplier_id = ?';
        params.push(Number(req.query.supplier));
      }
      const [rows] = await pool.query(
        `${PRODUCT_SELECT}${where} AND COALESCE(p.is_modifier, 0) = 0
          ORDER BY p.department_name, p.group_name, p.product_name`,
        params
      );
      res.json(rows.map(decorate));
    } catch (e) {
      next(e);
    }
  });

  /**
   * The stock fields of one product, and nothing else.
   *
   * The product form's PUT sends the whole row back; this one takes only what
   * the stock page can see, so a cost typed here cannot quietly rewrite a
   * price. `cost_price` is kept in step with the pack cost so the reports,
   * the product form and the till all agree what a unit costs.
   */
  /**
   * Save a product's stock settings. One place, used by the whole-form PUT,
   * the one-field PATCH (a case-size dropdown in the product list) and the
   * bulk PATCH (mass-apply a case size), so all three validate identically.
   *
   * `b` is the COMPLETE set of stock fields; the PATCH routes build it by
   * laying the change over what the product already has.
   */
  async function saveStockSettings(office, id, b) {
    const [[me]] = await pool.query(
      'SELECT id, pluid FROM bo_products WHERE id = ? AND email = ?',
      [id, office]
    );
    if (!me) throw Object.assign(new Error('No such product.'), { status: 404 });

    const packId = num(b.pack_size_id);
    let packUnits = null;
    if (packId !== null) {
      const [[pack]] = await pool.query(
        'SELECT units FROM bo_pack_sizes WHERE id = ? AND office = ?',
        [packId, office]
      );
      if (!pack) throw bad('No such case size.');
      packUnits = Number(pack.units);
    }
    const supplierId = num(b.supplier_id);
    if (supplierId !== null) {
      const [[s]] = await pool.query(
        'SELECT id FROM bo_suppliers WHERE id = ? AND office = ?',
        [supplierId, office]
      );
      if (!s) throw bad('No such supplier.');
    }

    /*
     * A LINK: this product sells from another, `ratio` of it at a time.
     * One level only -- a parent may not itself sell from something -- so the
     * question "whose shelf does this come off" always has a one-step answer,
     * and a loop cannot be built by linking two products to each other.
     */
    const parentPlu = num(b.stock_parent_pluid);
    let ratio = num(b.stock_ratio);
    let parentCost = null;
    if (parentPlu !== null) {
      if (parentPlu === Number(me.pluid)) throw bad('A product cannot sell from itself.');
      const [[parent]] = await pool.query(
        `${PRODUCT_SELECT} AND p.pluid = ? LIMIT 1`,
        [office, parentPlu]
      );
      if (!parent) throw bad('No product with that PLU to link to.');
      if (parent.stock_parent_pluid) throw bad(`${parent.product_name} itself sells from another product. Link to that one instead.`);
      const [[child]] = await pool.query(
        'SELECT COUNT(*) AS n FROM bo_products WHERE email = ? AND stock_parent_pluid = ?',
        [office, me.pluid]
      );
      if (Number(child.n)) throw bad('Other products already sell from this one, so it cannot sell from another.');
      if (ratio === null || !(ratio > 0)) throw bad('Say how much of it one of these uses — for example 0.5 for a half pint.');
      parentCost = unitCostMinor(parent);
    } else {
      ratio = null;
    }

    const packCost = num(b.pack_cost);
    let costPrice = num(b.cost_price);
    if (packCost !== null && packUnits) costPrice = Number((packCost / packUnits).toFixed(4));
    // A linked product costs what it takes off its parent. Written onto
    // cost_price so the GP calculator, the reports and the till all agree.
    else if (parentPlu !== null && parentCost) costPrice = Number(((parentCost * ratio) / 100).toFixed(4));

    const target = num(b.target_gp);
    if (target !== null && (target < 0 || target >= 100)) throw bad('A target GP is a percentage below 100.');

    await pool.execute(
      `UPDATE bo_products
          SET supplier_id = ?, supplier_code = ?, pack_size_id = ?, pack_cost = ?,
              cost_price = ?, min_stock = ?, max_stock = ?, low_stock_at = ?,
              stock_unit = ?, non_stock = ?, stock_parent_pluid = ?, stock_ratio = ?,
              target_gp = ?
        WHERE id = ? AND email = ?`,
      [
        supplierId,
        String(b.supplier_code || '').trim() || null,
        packId,
        packCost,
        costPrice,
        num(b.min_stock),
        num(b.max_stock),
        // Low stock and min stock are the same question asked twice; the
        // older column follows the newer one so the dashboard's badge agrees
        // with the order suggestion.
        num(b.low_stock_at) ?? num(b.min_stock),
        String(b.stock_unit || '').trim().slice(0, 24) || null,
        Number(b.non_stock) ? 1 : 0,
        parentPlu,
        ratio,
        target,
        id,
        office,
      ]
    );
  }

  /** The stock fields a product has now, in the shape saveStockSettings takes. */
  const STOCK_FIELDS = [
    'supplier_id', 'supplier_code', 'pack_size_id', 'pack_cost', 'cost_price',
    'min_stock', 'max_stock', 'low_stock_at', 'stock_unit', 'non_stock',
    'stock_parent_pluid', 'stock_ratio', 'target_gp',
  ];
  async function currentStockFields(office, id) {
    const [[row]] = await pool.query(
      `SELECT ${STOCK_FIELDS.join(', ')} FROM bo_products WHERE id = ? AND email = ?`,
      [id, office]
    );
    return row || null;
  }

  const answer = (res, next) => (e) => {
    if (e.status) return res.status(e.status).json({ error: e.message });
    return next(e);
  };

  router.put('/stock/products/:id/settings', mayEdit, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      await saveStockSettings(office, req.params.id, req.body || {});
      changed('products');
      res.json({ ok: true });
    } catch (e) {
      answer(res, next)(e);
    }
  });

  /**
   * Change SOME of a product's stock settings, leaving the rest as they are.
   * The product list's case-size dropdown sends one field; the product editor
   * sends the stock section. Only the named fields move.
   */
  router.patch('/stock/products/:id', mayEdit, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const now = await currentStockFields(office, req.params.id);
      if (!now) return res.status(404).json({ error: 'No such product.' });
      const b = req.body || {};
      const merged = { ...now };
      for (const f of STOCK_FIELDS) if (b[f] !== undefined) merged[f] = b[f];
      // The unit cost follows from what is set: a case cost and case size
      // derive it, a link derives it from the parent, otherwise the product's
      // own cost_price stands (see saveStockSettings).
      await saveStockSettings(office, req.params.id, merged);
      changed('products');
      res.json({ ok: true });
    } catch (e) {
      answer(res, next)(e);
    }
  });

  /**
   * The same change on many products: "mass-apply case sizes". Only the
   * fields sent move, and only case size, supplier and non-stock may be sent
   * in bulk -- a link or a cost is one product's fact, not ten products'.
   * All or nothing is not needed here: each product is its own save, and the
   * answer says how many moved and which (if any) refused and why.
   */
  router.patch('/stock/products', mayEdit, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter(Number.isInteger).slice(0, 2000);
      const fields = req.body?.fields || {};
      const allowed = ['pack_size_id', 'supplier_id', 'non_stock'];
      const change = {};
      for (const f of allowed) if (fields[f] !== undefined) change[f] = fields[f] === '' ? null : fields[f];
      if (!ids.length) return res.status(400).json({ error: 'Pick some products first.' });
      if (!Object.keys(change).length) return res.status(400).json({ error: 'Nothing was chosen to change.' });
      let updated = 0;
      const refused = [];
      for (const id of ids) {
        // eslint-disable-next-line no-await-in-loop -- one small row each
        const now = await currentStockFields(office, id);
        if (!now) continue;
        try {
          // eslint-disable-next-line no-await-in-loop
          await saveStockSettings(office, id, { ...now, ...change });
          updated += 1;
        } catch (e) {
          if (!e.status) throw e;
          refused.push({ id, error: e.message });
        }
      }
      changed('products');
      res.json({ ok: true, updated, refused });
    } catch (e) {
      answer(res, next)(e);
    }
  });

  // -------------------------------------------------------------------------
  // Recipes: a product made of other products (2026-09-22)
  // -------------------------------------------------------------------------
  //
  // A cocktail is its ingredients. Selling or wasting one moves each of them
  // (stock_effects.js); this is where the list is kept. The recipe's cost --
  // each ingredient's unit cost times its measure -- is written onto the
  // product's cost_price, so its GP is right wherever GP is shown.

  async function recipeWithLines(office, pluid) {
    const [[head]] = await pool.query(`${PRODUCT_SELECT} AND p.pluid = ? LIMIT 1`, [office, pluid]);
    if (!head) return null;
    const [lines] = await pool.query(
      `SELECT r.ingredient_pluid, r.quantity, r.sort_order
         FROM bo_recipe_lines r
        WHERE r.office = ? AND r.recipe_pluid = ?
        ORDER BY r.sort_order, r.created_at`,
      [office, pluid]
    );
    const out = [];
    let costMinor = 0;
    for (const l of lines) {
      // eslint-disable-next-line no-await-in-loop -- a recipe has a handful of lines
      const [[ing]] = await pool.query(`${PRODUCT_SELECT} AND p.pluid = ? LIMIT 1`, [office, l.ingredient_pluid]);
      const unit = ing ? unitCostMinor(ing) : 0;
      const lineCost = Math.round(unit * Number(l.quantity));
      costMinor += lineCost;
      out.push({
        pluid: Number(l.ingredient_pluid),
        product_name: ing ? ing.product_name : `PLU ${l.ingredient_pluid} (deleted)`,
        stock_unit: ing ? ing.stock_unit : null,
        pack_name: ing ? ing.pack_name : null,
        pack_units: ing ? ing.pack_units : null,
        quantity: Number(l.quantity),
        unit_cost_minor: unit,
        line_cost_minor: lineCost,
        missing: !ing,
      });
    }
    const decorated = decorate(head);
    return {
      product: decorated,
      lines: out,
      cost_minor: costMinor,
      gp: gpFigures(head.price, head.tax_percentage, costMinor, head.target_gp),
    };
  }

  router.get('/stock/recipes', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const [rows] = await pool.query(
        `SELECT DISTINCT recipe_pluid FROM bo_recipe_lines WHERE office = ?`,
        [office]
      );
      const out = [];
      for (const r of rows) {
        // eslint-disable-next-line no-await-in-loop -- a venue has tens of recipes
        const one = await recipeWithLines(office, r.recipe_pluid);
        if (one) out.push({ ...one.product, line_count: one.lines.length, recipe_cost_minor: one.cost_minor, recipe_gp: one.gp });
      }
      out.sort((a, b) => String(a.product_name).localeCompare(String(b.product_name)));
      res.json(out);
    } catch (e) {
      next(e);
    }
  });

  router.get('/stock/recipes/:pluid', auth, async (req, res, next) => {
    try {
      const one = await recipeWithLines(await tenantEmail(req), Number(req.params.pluid));
      if (!one) return res.status(404).json({ error: 'No such product.' });
      res.json(one);
    } catch (e) {
      next(e);
    }
  });

  router.put('/stock/recipes/:pluid', mayEdit, async (req, res, next) => {
    const conn = await pool.getConnection();
    try {
      const office = await tenantEmail(req);
      const recipePlu = Number(req.params.pluid);
      const [[head]] = await conn.query(
        'SELECT id, pluid, pack_cost FROM bo_products WHERE email = ? AND pluid = ? LIMIT 1',
        [office, recipePlu]
      );
      if (!head) return res.status(404).json({ error: 'No such product.' });

      const raw = Array.isArray(req.body?.lines) ? req.body.lines : [];
      const seen = new Set();
      const lines = [];
      for (const l of raw) {
        const pluid = Number(l.pluid);
        if (!Number.isInteger(pluid)) throw bad('Every ingredient needs a product.');
        if (pluid === recipePlu) throw bad('A recipe cannot list itself as an ingredient.');
        if (seen.has(pluid)) throw bad('An ingredient is listed twice — put its whole measure on one line.');
        const qty = quantity(l.quantity, 'measure');
        if (!(qty > 0)) throw bad('Every measure must be more than nothing.');
        // eslint-disable-next-line no-await-in-loop
        const [[ing]] = await conn.query('SELECT pluid FROM bo_products WHERE email = ? AND pluid = ?', [office, pluid]);
        if (!ing) throw bad(`No product with PLU ${pluid}.`);
        seen.add(pluid);
        lines.push({ pluid, qty });
      }

      await conn.beginTransaction();
      await conn.execute('DELETE FROM bo_recipe_lines WHERE office = ? AND recipe_pluid = ?', [office, recipePlu]);
      for (const [i, l] of lines.entries()) {
        // eslint-disable-next-line no-await-in-loop
        await conn.execute(
          `INSERT INTO bo_recipe_lines (id, office, recipe_pluid, ingredient_pluid, quantity, sort_order)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [uuid(), office, recipePlu, l.pluid, l.qty, i]
        );
      }
      // A product made of others does not also sell from a parent: the recipe
      // is the fuller statement of what it is, and two answers to "whose shelf
      // does this come off" would be one too many.
      if (lines.length) {
        await conn.execute(
          'UPDATE bo_products SET stock_parent_pluid = NULL, stock_ratio = NULL WHERE email = ? AND pluid = ?',
          [office, recipePlu]
        );
      }
      await conn.commit();

      const one = await recipeWithLines(office, recipePlu);
      // The recipe's cost becomes the product's, unless a case cost already
      // sets it (a bought-in cocktail with a recipe only for stock).
      if (one && lines.length && num(head.pack_cost) === null) {
        await pool.execute(
          'UPDATE bo_products SET cost_price = ? WHERE email = ? AND pluid = ?',
          [Number((one.cost_minor / 100).toFixed(4)), office, recipePlu]
        );
      }
      changed('products');
      res.json(await recipeWithLines(office, recipePlu));
    } catch (e) {
      await conn.rollback().catch(() => {});
      answer(res, next)(e);
    } finally {
      conn.release();
    }
  });

  router.delete('/stock/recipes/:pluid', mayEdit, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      await pool.execute('DELETE FROM bo_recipe_lines WHERE office = ? AND recipe_pluid = ?', [
        office,
        Number(req.params.pluid),
      ]);
      changed('products');
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // -------------------------------------------------------------------------
  // The ledger, read
  // -------------------------------------------------------------------------

  router.get('/stock/movements', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const params = [office];
      let where = 'office = ?';
      if (req.query.pluid) {
        where += ' AND pluid = ?';
        params.push(Number(req.query.pluid));
      }
      if (req.query.kind) {
        where += ' AND kind = ?';
        params.push(String(req.query.kind));
      }
      if (req.query.from) {
        where += ' AND moved_at >= ?';
        params.push(new Date(String(req.query.from)));
      }
      if (req.query.to) {
        where += ' AND moved_at <= ?';
        params.push(new Date(String(req.query.to)));
      }
      const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 2000);
      const [rows] = await pool.query(
        `SELECT id, pluid, product_name, kind, quantity, unit_cost_minor, reason,
                doc_id, order_id, staff_name, terminal, moved_at
           FROM epos_stock_movements
          WHERE ${where}
          ORDER BY moved_at DESC, created_at DESC
          LIMIT ${limit}`,
        params
      );
      res.json(rows);
    } catch (e) {
      next(e);
    }
  });

  // -------------------------------------------------------------------------
  // Documents
  // -------------------------------------------------------------------------

  const docKind = (value) => {
    const kind = String(value || '').trim();
    if (!DOC_KINDS.includes(kind)) throw bad('That is not a kind of stock document.');
    return kind;
  };

  /** The lines a document is drafted with, checked and normalised. */
  function docLines(body, kind) {
    const lines = Array.isArray(body.lines) ? body.lines : [];
    return lines.map((l) => {
      const pluid = Number(l.pluid);
      if (!Number.isInteger(pluid)) throw bad('Every line needs a product.');
      const qty = quantity(l.quantity);
      if (!COUNTING.has(kind) && kind !== 'adjustment' && qty < 0) {
        throw bad('A quantity here cannot be negative; it is what went, or what arrived.');
      }
      return {
        pluid,
        quantity: qty,
        reason: String(l.reason || '').trim().slice(0, 255) || null,
      };
    });
  }

  async function docWithLines(office, id) {
    const [[doc]] = await pool.query(
      'SELECT * FROM bo_stock_docs WHERE id = ? AND office = ?',
      [id, office]
    );
    if (!doc) return null;
    const [lines] = await pool.query(
      `SELECT l.*, p.department_name, p.group_name, p.stock_quantity AS current_stock,
              k.name AS pack_name, k.units AS pack_units
         FROM bo_stock_doc_lines l
         LEFT JOIN bo_products p ON p.pluid = l.pluid AND p.email = ?
         LEFT JOIN bo_pack_sizes k ON k.id = p.pack_size_id AND k.office = p.email
        WHERE l.doc_id = ?
        ORDER BY p.department_name, p.group_name, l.product_name`,
      [office, id]
    );
    return { ...doc, lines };
  }

  router.get('/stock/docs', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const params = [office];
      let where = 'd.office = ?';
      if (req.query.kind) {
        where += ' AND d.kind = ?';
        params.push(docKind(req.query.kind));
      }
      const [rows] = await pool.query(
        `SELECT d.id, d.kind, d.status, d.notes, d.staff_name, d.terminal, d.order_id,
                d.created_at, d.completed_at,
                COUNT(l.id) AS line_count,
                COALESCE(SUM(CASE WHEN d.kind IN ('stocktake', 'spot_check')
                                  THEN (l.quantity - COALESCE(l.expected, 0)) * l.unit_cost_minor
                                  ELSE l.quantity * l.unit_cost_minor END), 0) AS value_minor
           FROM bo_stock_docs d
           LEFT JOIN bo_stock_doc_lines l ON l.doc_id = d.id
          WHERE ${where}
          GROUP BY d.id
          ORDER BY d.created_at DESC
          LIMIT 500`,
        params
      );
      res.json(rows);
    } catch (e) {
      next(e);
    }
  });

  router.get('/stock/docs/:id', auth, async (req, res, next) => {
    try {
      const doc = await docWithLines(await tenantEmail(req), req.params.id);
      if (!doc) return res.status(404).json({ error: 'No such document.' });
      res.json(doc);
    } catch (e) {
      next(e);
    }
  });

  /** Write a draft's lines: the product's name and cost are copied on. */
  async function writeLines(conn, office, docId, lines) {
    await conn.execute('DELETE FROM bo_stock_doc_lines WHERE doc_id = ?', [docId]);
    for (const line of lines) {
      const p = await product(conn, office, line.pluid);
      if (!p) throw bad(`No product with PLU ${line.pluid}.`);
      await conn.execute(
        `INSERT INTO bo_stock_doc_lines
           (id, doc_id, pluid, product_name, quantity, unit_cost_minor, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [uuid(), docId, line.pluid, p.product_name, line.quantity, unitCostMinor(p), line.reason]
      );
    }
  }

  router.post('/stock/docs', mayEdit, async (req, res, next) => {
    const conn = await pool.getConnection();
    try {
      const office = await tenantEmail(req);
      const b = req.body || {};
      const kind = docKind(b.kind);
      const lines = docLines(b, kind);
      const id = uuid();
      await conn.beginTransaction();
      await conn.execute(
        `INSERT INTO bo_stock_docs (id, office, kind, status, notes, staff_name)
         VALUES (?, ?, ?, 'draft', ?, ?)`,
        [id, office, kind, String(b.notes || '').trim().slice(0, 500) || null, who(req)]
      );
      await writeLines(conn, office, id, lines);
      await conn.commit();
      let result = { id };
      if (b.complete) {
        result = await complete(office, id, who(req));
      }
      changed('docs');
      res.status(201).json(result);
    } catch (e) {
      await conn.rollback().catch(() => {});
      if (e.status) return res.status(e.status).json({ error: e.message });
      next(e);
    } finally {
      conn.release();
    }
  });

  router.put('/stock/docs/:id', mayEdit, async (req, res, next) => {
    const conn = await pool.getConnection();
    try {
      const office = await tenantEmail(req);
      const [[doc]] = await pool.query(
        'SELECT id, kind, status FROM bo_stock_docs WHERE id = ? AND office = ?',
        [req.params.id, office]
      );
      if (!doc) return res.status(404).json({ error: 'No such document.' });
      if (doc.status !== 'draft') {
        return res.status(409).json({ error: 'A completed document cannot be changed.' });
      }
      const b = req.body || {};
      const lines = docLines(b, doc.kind);
      await conn.beginTransaction();
      await conn.execute(
        'UPDATE bo_stock_docs SET notes = ? WHERE id = ?',
        [String(b.notes || '').trim().slice(0, 500) || null, doc.id]
      );
      await writeLines(conn, office, doc.id, lines);
      await conn.commit();
      changed('docs');
      res.json({ ok: true });
    } catch (e) {
      await conn.rollback().catch(() => {});
      if (e.status) return res.status(e.status).json({ error: e.message });
      next(e);
    } finally {
      conn.release();
    }
  });

  router.delete('/stock/docs/:id', mayEdit, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const [[doc]] = await pool.query(
        'SELECT status FROM bo_stock_docs WHERE id = ? AND office = ?',
        [req.params.id, office]
      );
      if (!doc) return res.status(404).json({ error: 'No such document.' });
      if (doc.status !== 'draft') {
        // The movements it wrote are the venue's history now. Reversing one
        // is a new adjustment, not a deletion.
        return res.status(409).json({ error: 'A completed document is kept. Record an adjustment to reverse it.' });
      }
      await pool.execute('DELETE FROM bo_stock_docs WHERE id = ? AND office = ?', [
        req.params.id,
        office,
      ]);
      changed('docs');
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  /**
   * Apply a document to the ledger.
   *
   * One transaction, and the document row is locked FOR UPDATE first: two
   * managers pressing Complete together must produce one set of movements.
   * The status check happens under that lock, and that is what makes a second
   * Complete a refusal rather than a second application.
   *
   * For each line: the count as it stands goes into `expected`; a counting
   * document's movement is `counted - expected`, any other's is the line's
   * signed quantity (negative for wastage, as typed for an adjustment,
   * positive for a delivery). A product nobody has tracked yet -- NULL --
   * starts at zero, so the first stocktake to name it is what puts it under
   * management.
   */
  async function complete(office, id, staffName, { terminal = null, movedAt = null } = {}) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [[doc]] = await conn.query(
        'SELECT * FROM bo_stock_docs WHERE id = ? AND office = ? FOR UPDATE',
        [id, office]
      );
      if (!doc) throw Object.assign(new Error('No such document.'), { status: 404 });
      if (doc.status !== 'draft') {
        throw Object.assign(new Error('This document has already been completed.'), {
          status: 409,
        });
      }
      const [lines] = await conn.query(
        'SELECT * FROM bo_stock_doc_lines WHERE doc_id = ? ORDER BY product_name',
        [id]
      );
      if (!lines.length) throw bad('There is nothing on this document.');

      const at = movedAt || new Date();
      const counting = COUNTING.has(doc.kind);
      const sign = doc.kind === 'wastage' ? -1 : 1;

      for (const line of lines) {
        /*
         * WASTING A COCKTAIL WASTES ITS INGREDIENTS (2026-09-22). A wastage or
         * adjustment of a recipe or a linked product moves the stock it is made
         * of -- the same rule a sale follows (stock_effects.js). A count is of
         * the thing on the shelf itself, and a delivery is of what arrived, so
         * neither is resolved.
         */
        if (!counting && doc.kind !== 'delivery') {
          const targets = await stockTargets(conn, office, line.pluid, Number(line.quantity));
          const direct = targets.length === 1 && targets[0].pluid === Number(line.pluid) && !targets[0].via;
          if (!direct) {
            const [[own]] = await conn.query(
              'SELECT stock_quantity FROM bo_products WHERE email = ? AND pluid = ?',
              [office, line.pluid]
            );
            if (!own) throw bad(`${line.product_name || `PLU ${line.pluid}`} is no longer in the catalogue.`);
            await conn.execute('UPDATE bo_stock_doc_lines SET expected = ? WHERE id = ?', [num(own.stock_quantity), line.id]);
            for (const target of targets) {
              const [[tp]] = await conn.query(
                'SELECT stock_quantity, product_name, cost_price FROM bo_products WHERE email = ? AND pluid = ? FOR UPDATE',
                [office, target.pluid]
              );
              // An ingredient nobody counts stays uncounted, as it does on a
              // sale: wasting one cocktail must not start tracking the mixers.
              if (!tp || tp.stock_quantity === null) continue;
              const was = Number(tp.stock_quantity);
              const move = sign * target.qty;
              await conn.execute(
                `INSERT INTO epos_stock_movements
                   (id, office, pluid, product_name, kind, quantity, unit_cost_minor,
                    reason, doc_id, order_id, staff_name, terminal, moved_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                  uuid(), office, target.pluid, tp.product_name, doc.kind, move,
                  Math.round((Number(tp.cost_price) || 0) * 100),
                  [line.reason || doc.notes, `via ${target.via || line.product_name}`].filter(Boolean).join(' · ').slice(0, 255),
                  doc.id, doc.order_id, staffName, terminal, at,
                ]
              );
              await conn.execute(
                'UPDATE bo_products SET stock_quantity = ? WHERE email = ? AND pluid = ?',
                [was + move, office, target.pluid]
              );
            }
            continue;
          }
        }

        const [[p]] = await conn.query(
          'SELECT stock_quantity, product_name FROM bo_products WHERE email = ? AND pluid = ? FOR UPDATE',
          [office, line.pluid]
        );
        if (!p) throw bad(`${line.product_name || `PLU ${line.pluid}`} is no longer in the catalogue.`);
        const expected = num(p.stock_quantity) ?? 0;
        const movement = counting ? Number(line.quantity) - expected : sign * Number(line.quantity);

        await conn.execute(
          'UPDATE bo_stock_doc_lines SET expected = ? WHERE id = ?',
          [expected, line.id]
        );
        // A counting document that found exactly what was expected still
        // stamps the expectation, but writes no zero movement: a ledger full
        // of "nothing changed" rows is a ledger nobody reads.
        if (movement !== 0) {
          await conn.execute(
            `INSERT INTO epos_stock_movements
               (id, office, pluid, product_name, kind, quantity, unit_cost_minor,
                reason, doc_id, order_id, staff_name, terminal, moved_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              uuid(),
              office,
              line.pluid,
              p.product_name || line.product_name,
              doc.kind,
              movement,
              line.unit_cost_minor,
              line.reason || doc.notes || null,
              doc.id,
              doc.order_id,
              staffName,
              terminal,
              at,
            ]
          );
        }
        await conn.execute(
          'UPDATE bo_products SET stock_quantity = ? WHERE email = ? AND pluid = ?',
          [counting ? Number(line.quantity) : expected + movement, office, line.pluid]
        );
      }

      await conn.execute(
        `UPDATE bo_stock_docs
            SET status = 'completed', completed_at = ?, staff_name = COALESCE(staff_name, ?),
                terminal = COALESCE(terminal, ?)
          WHERE id = ?`,
        [at, staffName, terminal, id]
      );
      await conn.commit();
      return { id, completed: true, lines: lines.length };
    } catch (e) {
      await conn.rollback().catch(() => {});
      throw e;
    } finally {
      conn.release();
    }
  }

  router.post('/stock/docs/:id/complete', mayEdit, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const result = await complete(office, req.params.id, who(req));
      changed('docs');
      changed('products');
      res.json(result);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message });
      next(e);
    }
  });

  /**
   * The count sheet: every tracked product, in the order it is walked, with a
   * blank column. Printed and carried round the cellar; typed in afterwards.
   * Rendered through the report PDF so it carries the venue's name and the
   * date like everything else that leaves the back office on paper.
   */
  router.get('/stock/count-sheet.pdf', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const params = [office];
      let where = '';
      if (req.query.department) {
        where += ' AND p.department_name = ?';
        params.push(String(req.query.department));
      }
      if (req.query.tracked !== 'all') where += ' AND p.stock_quantity IS NOT NULL';
      const [all] = await pool.query(
        `${PRODUCT_SELECT}${where} AND COALESCE(p.is_modifier, 0) = 0
          ORDER BY p.department_name, p.group_name, p.product_name`,
        params
      );
      // The sheet is what a stock take counts: STOCK ITEMS only -- a case
      // size, and not non-stock, linked or a recipe (2026-09-22). `?items=all`
      // prints everything, for a venue that has not set case sizes up yet.
      const rows = req.query.items === 'all' ? all : all.filter((p) => decorate(p).stock_item);
      const bySub = new Map();
      for (const p of rows) {
        const key = `${p.department_name || 'Unassigned'} — ${p.group_name || 'Unassigned'}`;
        if (!bySub.has(key)) bySub.set(key, []);
        bySub.get(key).push({
          pluid: p.pluid,
          name: p.product_name,
          pack: p.pack_name && p.pack_units > 1 ? `${p.pack_name} (${p.pack_units})` : '',
          counted: '',
        });
      }
      const columns = [
        { key: 'pluid', label: 'PLU', type: 'text' },
        { key: 'name', label: 'Product', type: 'text' },
        { key: 'pack', label: 'Pack', type: 'text' },
        { key: 'counted', label: 'Counted', type: 'text' },
      ];
      const now = new Date();
      const pdf = await toPdf({
        name: 'Stock Count Sheet',
        site: await siteName(req, office),
        from: now,
        to: now,
        generatedAt: now,
        terminalLabel: req.query.department ? String(req.query.department) : 'Every department',
        sections: [...bySub.entries()].map(([title, list]) => ({
          title,
          columns,
          rows: list,
          total: null,
        })),
      });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'inline; filename="stock-count-sheet.pdf"');
      res.send(pdf);
    } catch (e) {
      next(e);
    }
  });

  // -------------------------------------------------------------------------
  // Purchase orders
  // -------------------------------------------------------------------------

  async function orderWithLines(office, id) {
    const [[order]] = await pool.query(
      'SELECT * FROM bo_purchase_orders WHERE id = ? AND office = ?',
      [id, office]
    );
    if (!order) return null;
    const [lines] = await pool.query(
      `SELECT l.*, p.stock_quantity AS current_stock, p.min_stock, p.max_stock
         FROM bo_purchase_order_lines l
         LEFT JOIN bo_products p ON p.pluid = l.pluid AND p.email = ?
        WHERE l.order_id = ?
        ORDER BY l.product_name`,
      [office, id]
    );
    return { ...order, lines };
  }

  router.get('/stock/orders', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const params = [office];
      let where = 'o.office = ?';
      if (req.query.status) {
        where += ' AND o.status = ?';
        params.push(String(req.query.status));
      }
      const [rows] = await pool.query(
        `SELECT o.*, COUNT(l.id) AS line_count,
                COALESCE(SUM(l.packs_ordered), 0)   AS packs_ordered,
                COALESCE(SUM(l.packs_delivered), 0) AS packs_delivered
           FROM bo_purchase_orders o
           LEFT JOIN bo_purchase_order_lines l ON l.order_id = o.id
          WHERE ${where}
          GROUP BY o.id
          ORDER BY o.created_at DESC
          LIMIT 500`,
        params
      );
      res.json(rows);
    } catch (e) {
      next(e);
    }
  });

  /**
   * What to order from a supplier: every product of theirs at or below its
   * minimum, and the packs it takes to bring it back to its maximum (or to
   * the minimum, when no maximum is set). Rounded up: a supplier does not
   * sell a third of a case.
   */
  router.get('/stock/orders/suggest', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const params = [office];
      let where = ' AND p.stock_quantity IS NOT NULL AND p.min_stock IS NOT NULL';
      if (req.query.supplier) {
        where += ' AND p.supplier_id = ?';
        params.push(Number(req.query.supplier));
      }
      const [rows] = await pool.query(
        `${PRODUCT_SELECT}${where} AND COALESCE(p.is_modifier, 0) = 0
            AND p.stock_quantity <= p.min_stock
          ORDER BY p.department_name, p.product_name`,
        params
      );
      res.json(
        rows.map((p) => {
          const target = num(p.max_stock) ?? num(p.min_stock);
          const short = Math.max(0, target - Number(p.stock_quantity));
          const units = Number(p.pack_units) || 1;
          return {
            ...decorate(p),
            short_units: short,
            packs: Math.ceil(short / units),
          };
        })
      );
    } catch (e) {
      next(e);
    }
  });

  router.get('/stock/orders/:id', auth, async (req, res, next) => {
    try {
      const order = await orderWithLines(await tenantEmail(req), req.params.id);
      if (!order) return res.status(404).json({ error: 'No such order.' });
      res.json(order);
    } catch (e) {
      next(e);
    }
  });

  /** The order's lines, from the products as they stand now. */
  async function writeOrderLines(conn, office, orderId, lines) {
    await conn.execute('DELETE FROM bo_purchase_order_lines WHERE order_id = ?', [orderId]);
    let total = 0;
    for (const raw of lines) {
      const pluid = Number(raw.pluid);
      if (!Number.isInteger(pluid)) throw bad('Every line needs a product.');
      const packs = quantity(raw.packs, 'packs');
      if (packs <= 0) throw bad('Order at least one pack of each product.');
      const p = await product(conn, office, pluid);
      if (!p) throw bad(`No product with PLU ${pluid}.`);
      // The pack price may be typed on the order -- a supplier's price list
      // changes -- and falls back to what the product knows.
      const packCostMinor =
        num(raw.pack_cost) !== null
          ? Math.round(num(raw.pack_cost) * 100)
          : num(p.pack_cost) !== null
            ? Math.round(num(p.pack_cost) * 100)
            : unitCostMinor(p) * (Number(p.pack_units) || 1);
      total += Math.round(packCostMinor * packs);
      await conn.execute(
        `INSERT INTO bo_purchase_order_lines
           (id, order_id, pluid, product_name, supplier_code, pack_size_id, pack_name,
            pack_units, pack_cost_minor, packs_ordered, packs_delivered)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        [
          uuid(),
          orderId,
          pluid,
          p.product_name,
          p.supplier_code,
          p.pack_size_id,
          p.pack_name || 'Each',
          Number(p.pack_units) || 1,
          packCostMinor,
          packs,
        ]
      );
    }
    await conn.execute('UPDATE bo_purchase_orders SET total_minor = ? WHERE id = ?', [
      total,
      orderId,
    ]);
    return total;
  }

  async function orderHead(office, body) {
    const supplierId = num(body.supplier_id);
    let supplier = null;
    if (supplierId !== null) {
      const [[s]] = await pool.query(
        'SELECT id, name, email FROM bo_suppliers WHERE id = ? AND office = ?',
        [supplierId, office]
      );
      if (!s) throw bad('No such supplier.');
      supplier = s;
    }
    const method = body.send_method === 'phone' ? 'phone' : 'email';
    return {
      supplierId,
      supplierName: supplier ? supplier.name : String(body.supplier_name || '').trim() || null,
      method,
      email: String(body.supplier_email || (supplier && supplier.email) || '').trim() || null,
      notes: String(body.notes || '').trim().slice(0, 500) || null,
    };
  }

  router.post('/stock/orders', mayEdit, async (req, res, next) => {
    const conn = await pool.getConnection();
    try {
      const office = await tenantEmail(req);
      const b = req.body || {};
      const head = await orderHead(office, b);
      const id = uuid();
      await conn.beginTransaction();
      await conn.execute(
        `INSERT INTO bo_purchase_orders
           (id, office, supplier_id, supplier_name, status, notes, send_method,
            supplier_email, staff_name)
         VALUES (?, ?, ?, ?, 'new', ?, ?, ?, ?)`,
        [id, office, head.supplierId, head.supplierName, head.notes, head.method, head.email, who(req)]
      );
      await writeOrderLines(conn, office, id, Array.isArray(b.lines) ? b.lines : []);
      await conn.commit();
      changed('orders');
      res.status(201).json({ id });
    } catch (e) {
      await conn.rollback().catch(() => {});
      if (e.status) return res.status(e.status).json({ error: e.message });
      next(e);
    } finally {
      conn.release();
    }
  });

  router.put('/stock/orders/:id', mayEdit, async (req, res, next) => {
    const conn = await pool.getConnection();
    try {
      const office = await tenantEmail(req);
      const [[order]] = await pool.query(
        'SELECT id, status FROM bo_purchase_orders WHERE id = ? AND office = ?',
        [req.params.id, office]
      );
      if (!order) return res.status(404).json({ error: 'No such order.' });
      if (!['new', 'sent'].includes(order.status)) {
        return res.status(409).json({ error: 'An order with deliveries against it cannot be changed.' });
      }
      const b = req.body || {};
      const head = await orderHead(office, b);
      await conn.beginTransaction();
      await conn.execute(
        `UPDATE bo_purchase_orders
            SET supplier_id = ?, supplier_name = ?, notes = ?, send_method = ?, supplier_email = ?
          WHERE id = ?`,
        [head.supplierId, head.supplierName, head.notes, head.method, head.email, order.id]
      );
      await writeOrderLines(conn, office, order.id, Array.isArray(b.lines) ? b.lines : []);
      await conn.commit();
      changed('orders');
      res.json({ ok: true });
    } catch (e) {
      await conn.rollback().catch(() => {});
      if (e.status) return res.status(e.status).json({ error: e.message });
      next(e);
    } finally {
      conn.release();
    }
  });

  router.delete('/stock/orders/:id', mayEdit, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const [[order]] = await pool.query(
        'SELECT status FROM bo_purchase_orders WHERE id = ? AND office = ?',
        [req.params.id, office]
      );
      if (!order) return res.status(404).json({ error: 'No such order.' });
      if (['part_delivered', 'delivered'].includes(order.status)) {
        return res.status(409).json({ error: 'Stock has been delivered against this order; it is kept.' });
      }
      await pool.execute(
        `UPDATE bo_purchase_orders SET status = 'cancelled' WHERE id = ? AND office = ?`,
        [req.params.id, office]
      );
      changed('orders');
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  /** The order as a PDF, for printing or for the email to the supplier. */
  async function orderPdf(req, office, order) {
    const columns = [
      { key: 'product_name', label: 'Product', type: 'text' },
      { key: 'supplier_code', label: 'Supplier code', type: 'text' },
      { key: 'pack_name', label: 'Pack', type: 'text' },
      { key: 'packs_ordered', label: 'Packs', type: 'number' },
      { key: 'pack_cost_minor', label: 'Pack price', type: 'money' },
      { key: 'line_minor', label: 'Total', type: 'money' },
    ];
    const rows = order.lines.map((l) => ({
      ...l,
      supplier_code: l.supplier_code || '',
      line_minor: Math.round(l.pack_cost_minor * l.packs_ordered),
    }));
    const now = new Date();
    return toPdf({
      name: `Purchase Order ${order.id.slice(0, 8).toUpperCase()}`,
      site: await siteName(req, office),
      from: new Date(order.created_at),
      to: now,
      generatedAt: now,
      terminalLabel: order.supplier_name || 'Supplier',
      sections: [
        {
          title: order.notes ? `Order — ${order.notes}` : 'Order',
          columns,
          rows,
          total: {
            name: 'Order Total',
            product_name: 'Order Total',
            packs_ordered: rows.reduce((s, r) => s + Number(r.packs_ordered), 0),
            line_minor: rows.reduce((s, r) => s + r.line_minor, 0),
          },
        },
      ],
    });
  }

  router.get('/stock/orders/:id/pdf', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const order = await orderWithLines(office, req.params.id);
      if (!order) return res.status(404).json({ error: 'No such order.' });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="order-${order.id.slice(0, 8)}.pdf"`);
      res.send(await orderPdf(req, office, order));
    } catch (e) {
      next(e);
    }
  });

  /**
   * Send the order. By email when the method is email and there is an address
   * -- the PDF attached, a plain note in the body -- and marked sent either
   * way, because a phoned order is still an order that has gone.
   */
  router.post('/stock/orders/:id/send', mayEdit, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const order = await orderWithLines(office, req.params.id);
      if (!order) return res.status(404).json({ error: 'No such order.' });
      if (order.status === 'cancelled') return res.status(409).json({ error: 'This order was cancelled.' });
      if (!order.lines.length) return res.status(400).json({ error: 'There is nothing on this order.' });

      let mailed = false;
      if (order.send_method === 'email') {
        if (!order.supplier_email) {
          return res.status(400).json({ error: 'The supplier has no email address. Add one, or send by phone.' });
        }
        const site = await siteName(req, office);
        const pdf = await orderPdf(req, office, order);
        mailed = await sendMail({
          to: order.supplier_email,
          subject: `Purchase order from ${site}`,
          text:
            `Please find attached a purchase order from ${site}.\n\n` +
            order.lines
              .map((l) => `${l.packs_ordered} × ${l.pack_name} — ${l.product_name}${l.supplier_code ? ` (${l.supplier_code})` : ''}`)
              .join('\n') +
            (order.notes ? `\n\n${order.notes}` : '') +
            `\n\nSent from Vesopa EPOS.`,
          html: undefined,
          attachments: [{ filename: `order-${order.id.slice(0, 8)}.pdf`, content: pdf }],
        });
        if (!mailed) {
          return res.status(502).json({ error: 'The email could not be sent. Check the mail settings, or send by phone.' });
        }
      }
      if (order.status === 'new') {
        await pool.execute(
          `UPDATE bo_purchase_orders SET status = 'sent', sent_at = NOW() WHERE id = ?`,
          [order.id]
        );
      }
      changed('orders');
      res.json({ ok: true, mailed });
    } catch (e) {
      next(e);
    }
  });

  /**
   * Book a delivery against the order.
   *
   * `{ lines: [{ id, packs }] }` -- the packs that arrived on each line, this
   * time; a short delivery leaves the order part-delivered and the rest can
   * come later. Makes a completed `delivery` document (so it appears with the
   * other documents and in the Orders & Deliveries report), writes the ledger
   * in UNITS through the pack size on the line, and updates the product's pack
   * cost from the order: the last invoice is the best guess at the next.
   */
  router.post('/stock/orders/:id/deliver', mayEdit, async (req, res, next) => {
    const conn = await pool.getConnection();
    try {
      const office = await tenantEmail(req);
      const order = await orderWithLines(office, req.params.id);
      if (!order) return res.status(404).json({ error: 'No such order.' });
      if (['delivered', 'cancelled'].includes(order.status)) {
        return res.status(409).json({ error: `This order is ${order.status}.` });
      }
      const asked = new Map(
        (Array.isArray(req.body?.lines) ? req.body.lines : []).map((l) => [String(l.id), quantity(l.packs, 'packs')])
      );
      const arriving = order.lines
        .map((l) => ({ line: l, packs: asked.get(String(l.id)) ?? 0 }))
        .filter((x) => x.packs > 0);
      if (!arriving.length) return res.status(400).json({ error: 'Nothing was delivered.' });

      const docId = uuid();
      await conn.beginTransaction();
      await conn.execute(
        `INSERT INTO bo_stock_docs (id, office, kind, status, notes, staff_name, order_id)
         VALUES (?, ?, 'delivery', 'draft', ?, ?, ?)`,
        [docId, office, `Delivery against order ${order.id.slice(0, 8).toUpperCase()}${order.supplier_name ? ` from ${order.supplier_name}` : ''}`, who(req), order.id]
      );
      for (const { line, packs } of arriving) {
        const units = packs * (Number(line.pack_units) || 1);
        const unitCost = Math.round(line.pack_cost_minor / (Number(line.pack_units) || 1));
        await conn.execute(
          `INSERT INTO bo_stock_doc_lines
             (id, doc_id, pluid, product_name, quantity, unit_cost_minor, reason)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [uuid(), docId, line.pluid, line.product_name, units, unitCost, `${packs} × ${line.pack_name}`]
        );
        await conn.execute(
          'UPDATE bo_purchase_order_lines SET packs_delivered = packs_delivered + ? WHERE id = ?',
          [packs, line.id]
        );
        // The product learns the price it was actually bought at. Only when
        // the pack on the line is still the product's pack: a product moved
        // to a different case size since the order must not be given the old
        // case's price.
        await conn.execute(
          `UPDATE bo_products
              SET pack_cost = ?, cost_price = ?
            WHERE email = ? AND pluid = ? AND (pack_size_id <=> ?)`,
          [line.pack_cost_minor / 100, unitCost / 100, office, line.pluid, line.pack_size_id]
        );
      }
      const [[left]] = await conn.query(
        `SELECT SUM(GREATEST(packs_ordered - packs_delivered, 0)) AS outstanding
           FROM bo_purchase_order_lines WHERE order_id = ?`,
        [order.id]
      );
      const done = Number(left.outstanding) <= 0;
      await conn.execute(
        `UPDATE bo_purchase_orders
            SET status = ?, delivered_at = CASE WHEN ? THEN NOW() ELSE delivered_at END
          WHERE id = ?`,
        [done ? 'delivered' : 'part_delivered', done ? 1 : 0, order.id]
      );
      await conn.commit();

      // The document is completed on its own connection, under its own lock,
      // like every other document -- one path applies a document to the
      // ledger, and this is not a second one.
      const result = await complete(office, docId, who(req));
      changed('orders');
      changed('docs');
      changed('products');
      res.json({ ...result, order_status: done ? 'delivered' : 'part_delivered' });
    } catch (e) {
      await conn.rollback().catch(() => {});
      if (e.status) return res.status(e.status).json({ error: e.message });
      next(e);
    } finally {
      conn.release();
    }
  });

  /**
   * Handed to the till routes below: a wastage rung on the till is a completed
   * one-line wastage document, so the back office sees it beside the ones made
   * there and the report reads one table.
   */
  async function wastageFromTill(office, body) {
    const pluid = Number(body.plu_id ?? body.pluid);
    const qty = quantity(body.quantity);
    if (!Number.isInteger(pluid) || qty <= 0) throw bad('A product and a quantity are needed.');
    const p = await product(pool, office, pluid);
    if (!p) throw bad(`No product with PLU ${pluid}.`);
    const id = body.id && /^[0-9a-f-]{36}$/i.test(String(body.id)) ? String(body.id) : uuid();
    const [inserted] = await pool.execute(
      `INSERT IGNORE INTO bo_stock_docs (id, office, kind, status, notes, staff_name, terminal)
       VALUES (?, ?, 'wastage', 'draft', ?, ?, ?)`,
      [id, office, String(body.reason || '').trim().slice(0, 500) || null, body.staff_name ?? null, body.terminal ?? null]
    );
    // A retry from the outbox: the document is already there, completed or
    // about to be. Nothing more to do, and saying so is what stops the retry.
    if (!inserted.affectedRows) return { id, duplicate: true };
    await pool.execute(
      `INSERT INTO bo_stock_doc_lines
         (id, doc_id, pluid, product_name, quantity, unit_cost_minor, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [uuid(), id, pluid, p.product_name, qty, unitCostMinor(p), String(body.reason || '').trim().slice(0, 255) || null]
    );
    const result = await complete(office, id, body.staff_name ?? null, {
      terminal: body.terminal ?? null,
      movedAt: body.at ? new Date(body.at) : null,
    });
    changed('docs');
    changed('products');
    return result;
  }

  router.wastageFromTill = wastageFromTill;
  return router;
}

module.exports = {
  stockRoutes,
  unitCostMinor,
  withPacks,
  gpFigures,
  DEFAULT_TARGET_GP,
  DOC_KINDS,
  ORDER_STATUSES,
  DEFAULT_PACKS,
};
