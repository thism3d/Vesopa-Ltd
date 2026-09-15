/**
 * The stock reports: seven views over the one ledger stock.js writes.
 *
 * Every figure here is a sum of `epos_stock_movements` rows, in the window,
 * for the venue. The current count is `bo_products.stock_quantity`, which is
 * the running balance of the same rows, so Stock Movements' "Current Stock"
 * column and the Stock Levels page cannot disagree. Units are shown with the
 * same figure in packs beside them -- `-16.00 (-0.18 11g Keg)` -- because a
 * cellar is counted in kegs and sold in pints, and the report is read by
 * people who think in each.
 *
 * Valuation is units × the unit cost AS IT STANDS NOW, at the moment asked
 * for. The reference (Newbridge) takes a valuation date; so does this, by
 * replaying the ledger backwards from the current count to that date, which
 * is the one thing a ledger can do that a bare number cannot.
 *
 * The same rule as every other builder: office bound first, joins carry it.
 */

const { withPacks } = require('./stock');

function stockBuilders({ col, section, money, grouped, sqlDateTime }) {
  const head = (key, name, office, siteName, from, to) => ({
    key,
    name,
    site: siteName || office,
    from,
    to,
    generatedAt: new Date(),
  });

  const byName = (a, b) => String(a.name).localeCompare(String(b.name));
  const pct = (part, whole) => (whole > 0 ? (part / whole) * 100 : null);
  const stamp = (at) => (at ? new Date(at).toLocaleString('en-GB') : '');

  /** Every product with its stock settings, pack and unit cost, by office. */
  async function products({ pool, office, department }) {
    const params = [office];
    let where = '';
    if (department) {
      where = " AND COALESCE(NULLIF(TRIM(p.department_name), ''), 'Unassigned') = ?";
      params.push(department);
    }
    const [rows] = await pool.query(
      `SELECT p.pluid, p.product_name, p.price, p.tax_percentage, p.cost_price,
              p.stock_quantity, p.pack_cost, p.min_stock, p.max_stock,
              COALESCE(NULLIF(TRIM(p.department_name), ''), 'Unassigned') AS department,
              COALESCE(NULLIF(TRIM(p.group_name), ''), 'Unassigned')      AS sub_department,
              k.name AS pack_name, k.units AS pack_units
         FROM bo_products p
         LEFT JOIN bo_pack_sizes k ON k.id = p.pack_size_id AND k.office = p.email
        WHERE p.email = ?${where} AND COALESCE(p.is_modifier, 0) = 0
        ORDER BY department, sub_department, p.product_name`,
      params
    );
    return rows.map((p) => ({
      ...p,
      unit_cost_minor:
        p.pack_cost !== null && p.pack_units > 0
          ? Math.round((Number(p.pack_cost) / Number(p.pack_units)) * 100)
          : Math.round((Number(p.cost_price) || 0) * 100),
      pack_units: Number(p.pack_units) || 1,
    }));
  }

  /** Group rows into sections by department — sub department. */
  function bySubDepartment(rows, columns, keyOf = (r) => `${r.department} — ${r.sub_department}`, fix = (s) => s) {
    const map = new Map();
    for (const r of rows) {
      const k = keyOf(r);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(r);
    }
    return [...map.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([title, list]) => fix(section(title, columns, list)));
  }

  // -------------------------------------------------------------------------
  // Stock Movements
  // -------------------------------------------------------------------------

  async function stockMovements(args) {
    const { pool, office, from, to } = args;
    const list = await products(args);
    const [moves] = await pool.query(
      `SELECT pluid, kind, SUM(quantity) AS qty
         FROM epos_stock_movements
        WHERE office = ? AND moved_at BETWEEN ? AND ?
        GROUP BY pluid, kind`,
      [office, sqlDateTime(from), sqlDateTime(to)]
    );
    const byPlu = new Map();
    for (const m of moves) {
      if (!byPlu.has(m.pluid)) byPlu.set(m.pluid, {});
      byPlu.get(m.pluid)[m.kind] = Number(m.qty);
    }
    const rows = list
      .filter((p) => p.stock_quantity !== null || byPlu.has(p.pluid))
      .map((p) => {
        const m = byPlu.get(p.pluid) || {};
        const show = (n) => withPacks(n || 0, p.pack_name, p.pack_units);
        return {
          ...p,
          name: p.product_name,
          sales: show(m.sale),
          wastage: show(m.wastage),
          deliveries: show(m.delivery),
          adjustments: show((m.adjustment || 0) + (m.refund || 0)),
          counts: show((m.stocktake || 0) + (m.spot_check || 0)),
          current: p.stock_quantity === null ? 'Not tracked' : show(p.stock_quantity),
        };
      });
    const columns = [
      col('name', 'Product'),
      col('sales', 'Sales Consumption'),
      col('wastage', 'Wastage'),
      col('deliveries', 'Deliveries'),
      col('adjustments', 'Adjustments'),
      col('counts', 'Stock Take Corrections'),
      col('current', 'Current Stock'),
    ];
    const sections = bySubDepartment(rows, columns, undefined, (s) => {
      s.total = null;
      return s;
    });
    return {
      ...head('stock_movements', 'Stock Movements', office, args.siteName, from, to),
      sections: sections.length ? sections : [section('Stock Movements', columns, [])],
    };
  }

  // -------------------------------------------------------------------------
  // Stock Valuation
  // -------------------------------------------------------------------------

  async function stockValuation(args) {
    const { pool, office, to, group_by } = args;
    const list = await products(args);
    // The count as it was at the end of the window: today's count, less
    // everything that has moved since. A valuation "as at last Sunday" is the
    // question an accountant asks at a period end.
    const [since] = await pool.query(
      `SELECT pluid, SUM(quantity) AS qty
         FROM epos_stock_movements
        WHERE office = ? AND moved_at > ?
        GROUP BY pluid`,
      [office, sqlDateTime(to)]
    );
    const movedSince = new Map(since.map((r) => [r.pluid, Number(r.qty)]));
    const rows = list
      .filter((p) => p.stock_quantity !== null)
      .map((p) => {
        const units = Number(p.stock_quantity) - (movedSince.get(p.pluid) || 0);
        const price = Math.round((Number(p.price) || 0) * 100);
        const tax = price - Math.round(price / (1 + (Number(p.tax_percentage) || 0) / 100));
        const gp = price - tax - p.unit_cost_minor;
        return {
          ...p,
          name: p.product_name,
          packs: p.pack_units > 1 ? `${(units / p.pack_units).toFixed(2)} (${p.pack_name})` : '',
          units,
          value_minor: Math.round(units * p.unit_cost_minor),
          unit_cost_minor: p.unit_cost_minor,
          tax_minor: tax,
          price_minor: price,
          gp_pct: pct(gp, price - tax),
        };
      });
    const columns = [
      col('name', 'Product Name'),
      col('packs', 'Pack Quantity'),
      col('units', 'Unit Quantity', 'number'),
      col('value_minor', 'Stock Value', 'money'),
      col('unit_cost_minor', 'Unit Cost Price', 'money'),
      col('tax_minor', 'Tax Amount', 'money'),
      col('price_minor', 'Selling Price', 'money'),
      col('gp_pct', 'Gross Profit %', 'percent'),
    ];
    const keyOf = group_by === 'department' ? (r) => r.department : undefined;
    const fix = (s) => {
      // The value is the only column whose total means anything; unit cost
      // and price added up across products is a number nobody wants.
      s.total = { name: 'Summary Total', value_minor: s.rows.reduce((a, r) => a + r.value_minor, 0), units: s.rows.reduce((a, r) => a + r.units, 0) };
      return s;
    };
    const sections = bySubDepartment(rows, columns, keyOf, fix);
    const total = rows.reduce((a, r) => a + r.value_minor, 0);
    return {
      ...head('stock_valuation', 'Stock Valuation', office, args.siteName, args.from, to),
      highlights: [
        { key: 'value', label: 'Total stock value', value: grouped(money(total)), minor: total, hint: `As at ${to.toLocaleString('en-GB')}` },
        { key: 'lines', label: 'Products tracked', value: String(rows.length), hint: rows.filter((r) => r.units < 0).length ? `${rows.filter((r) => r.units < 0).length} below zero — count them` : 'None below zero' },
      ],
      sections: sections.length ? sections : [section('Stock Valuation', columns, [])],
    };
  }

  // -------------------------------------------------------------------------
  // Wastage Report
  // -------------------------------------------------------------------------

  async function wastageReport(args) {
    const { pool, office, from, to } = args;
    const [rows] = await pool.query(
      `SELECT m.pluid, COALESCE(p.product_name, m.product_name) AS name,
              COALESCE(NULLIF(TRIM(p.department_name), ''), 'Unassigned') AS department,
              COALESCE(NULLIF(TRIM(p.group_name), ''), 'Unassigned')      AS sub_department,
              SUM(-m.quantity) AS qty,
              SUM(-m.quantity * m.unit_cost_minor) AS cost_minor,
              SUM(-m.quantity * COALESCE(p.price, 0) * 100) AS retail_minor,
              GROUP_CONCAT(DISTINCT m.reason ORDER BY m.reason SEPARATOR '; ') AS reasons
         FROM epos_stock_movements m
         LEFT JOIN bo_products p ON p.pluid = m.pluid AND p.email = ?
        WHERE m.office = ? AND m.kind = 'wastage' AND m.moved_at BETWEEN ? AND ?
        GROUP BY m.pluid, name, department, sub_department
        ORDER BY department, sub_department, name`,
      [office, office, sqlDateTime(from), sqlDateTime(to)]
    );
    const [detail] = await pool.query(
      `SELECT m.moved_at, COALESCE(p.product_name, m.product_name) AS product,
              -m.quantity AS qty, -m.quantity * m.unit_cost_minor AS cost_minor,
              m.reason, m.staff_name, m.terminal
         FROM epos_stock_movements m
         LEFT JOIN bo_products p ON p.pluid = m.pluid AND p.email = ?
        WHERE m.office = ? AND m.kind = 'wastage' AND m.moved_at BETWEEN ? AND ?
        ORDER BY m.moved_at`,
      [office, office, sqlDateTime(from), sqlDateTime(to)]
    );
    const summary = rows.map((r) => ({
      ...r,
      qty: Number(r.qty),
      cost_minor: Math.round(Number(r.cost_minor)),
      retail_minor: Math.round(Number(r.retail_minor)),
      reasons: r.reasons || '',
    }));
    const totalCost = summary.reduce((a, r) => a + r.cost_minor, 0);
    return {
      ...head('wastage_report', 'Wastage Report', office, args.siteName, from, to),
      highlights: [
        { key: 'cost', label: 'Wasted, at cost', value: grouped(money(totalCost)), minor: totalCost, hint: `${summary.reduce((a, r) => a + r.qty, 0)} units` },
        { key: 'retail', label: 'At retail', value: grouped(money(summary.reduce((a, r) => a + r.retail_minor, 0))), hint: 'What it would have sold for' },
      ],
      sections: [
        section(
          'Wastage by Product',
          [col('name', 'Product'), col('sub_department', 'Sub Department'), col('qty', 'Quantity', 'number'), col('retail_minor', 'Retail Value', 'money'), col('cost_minor', 'Cost Value', 'money'), col('reasons', 'Reasons')],
          summary
        ),
        section(
          'Every Wastage',
          [col('name', 'When'), col('product', 'Product'), col('qty', 'Quantity', 'number'), col('cost_minor', 'Cost', 'money'), col('reason', 'Reason'), col('who', 'Recorded by'), col('terminal', 'Terminal')],
          detail.map((d) => ({
            name: stamp(d.moved_at),
            product: d.product,
            qty: Number(d.qty),
            cost_minor: Math.round(Number(d.cost_minor)),
            reason: d.reason || '',
            who: d.staff_name || '',
            terminal: d.terminal || '',
          }))
        ),
      ],
    };
  }

  // -------------------------------------------------------------------------
  // Stock Variance -- every stocktake completed in the window
  // -------------------------------------------------------------------------

  async function stockVariance(args) {
    const { pool, office, from, to } = args;
    const [docs] = await pool.query(
      `SELECT id, kind, notes, staff_name, completed_at
         FROM bo_stock_docs
        WHERE office = ? AND status = 'completed' AND kind IN ('stocktake', 'spot_check')
          AND completed_at BETWEEN ? AND ?
        ORDER BY completed_at`,
      [office, sqlDateTime(from), sqlDateTime(to)]
    );
    const columns = [
      col('name', 'Product'),
      col('expected', 'Expected', 'number'),
      col('counted', 'Counted', 'number'),
      col('variance', 'Variance', 'number'),
      col('variance_minor', 'Variance £', 'money'),
    ];
    const sections = [];
    for (const d of docs) {
      const [lines] = await pool.query(
        `SELECT l.product_name, l.expected, l.quantity, l.unit_cost_minor
           FROM bo_stock_doc_lines l WHERE l.doc_id = ? ORDER BY l.product_name`,
        [d.id]
      );
      const rows = lines.map((l) => {
        const expected = Number(l.expected) || 0;
        const counted = Number(l.quantity) || 0;
        return {
          name: l.product_name,
          expected,
          counted,
          variance: counted - expected,
          variance_minor: Math.round((counted - expected) * l.unit_cost_minor),
        };
      });
      const s = section(
        `${d.kind === 'spot_check' ? 'Spot check' : 'Stock take'} — ${stamp(d.completed_at)}${d.staff_name ? ` by ${d.staff_name}` : ''}${d.notes ? ` — ${d.notes}` : ''}`,
        columns,
        rows
      );
      s.total.expected = null;
      s.total.counted = null;
      sections.push(s);
    }
    return {
      ...head('stock_variance', 'Stock Variance', office, args.siteName, from, to),
      sections: sections.length ? sections : [section('Stock Take Variance', columns, [])],
    };
  }

  // -------------------------------------------------------------------------
  // Orders & Deliveries
  // -------------------------------------------------------------------------

  async function ordersAndDeliveries(args) {
    const { pool, office, from, to } = args;
    const [orders] = await pool.query(
      `SELECT o.id, o.supplier_name, o.status, o.notes, o.staff_name, o.total_minor,
              o.created_at, o.sent_at, o.delivered_at,
              COUNT(l.id) AS line_count,
              COALESCE(SUM(l.packs_ordered), 0) AS packs_ordered,
              COALESCE(SUM(l.packs_delivered), 0) AS packs_delivered,
              COALESCE(SUM(l.packs_delivered * l.pack_cost_minor), 0) AS delivered_minor
         FROM bo_purchase_orders o
         LEFT JOIN bo_purchase_order_lines l ON l.order_id = o.id
        WHERE o.office = ? AND o.created_at BETWEEN ? AND ?
        GROUP BY o.id
        ORDER BY o.created_at`,
      [office, sqlDateTime(from), sqlDateTime(to)]
    );
    const [deliveries] = await pool.query(
      `SELECT d.completed_at, d.notes, d.staff_name, d.order_id,
              COUNT(l.id) AS line_count,
              COALESCE(SUM(l.quantity), 0) AS units,
              COALESCE(SUM(l.quantity * l.unit_cost_minor), 0) AS value_minor
         FROM bo_stock_docs d
         LEFT JOIN bo_stock_doc_lines l ON l.doc_id = d.id
        WHERE d.office = ? AND d.kind = 'delivery' AND d.status = 'completed'
          AND d.completed_at BETWEEN ? AND ?
        GROUP BY d.id
        ORDER BY d.completed_at`,
      [office, sqlDateTime(from), sqlDateTime(to)]
    );
    const label = { new: 'New', sent: 'Sent', part_delivered: 'Part delivered', delivered: 'Delivered', cancelled: 'Cancelled' };
    return {
      ...head('orders_and_deliveries', 'Orders & Deliveries', office, args.siteName, from, to),
      sections: [
        section(
          'Orders',
          [col('name', 'Raised'), col('order', 'Order'), col('supplier', 'Supplier'), col('status', 'Status'), col('lines', 'Lines', 'number'), col('packs_ordered', 'Packs Ordered', 'number'), col('packs_delivered', 'Packs Delivered', 'number'), col('total_minor', 'Order Value', 'money'), col('delivered_minor', 'Delivered Value', 'money')],
          orders.map((o) => ({
            name: stamp(o.created_at),
            order: String(o.id).slice(0, 8).toUpperCase(),
            supplier: o.supplier_name || '',
            status: label[o.status] || o.status,
            lines: Number(o.line_count),
            packs_ordered: Number(o.packs_ordered),
            packs_delivered: Number(o.packs_delivered),
            total_minor: Number(o.total_minor),
            delivered_minor: Math.round(Number(o.delivered_minor)),
          }))
        ),
        section(
          'Deliveries',
          [col('name', 'Booked in'), col('order', 'Against Order'), col('notes', 'Notes'), col('who', 'By'), col('lines', 'Lines', 'number'), col('units', 'Units', 'number'), col('value_minor', 'Value', 'money')],
          deliveries.map((d) => ({
            name: stamp(d.completed_at),
            order: d.order_id ? String(d.order_id).slice(0, 8).toUpperCase() : '',
            notes: d.notes || '',
            who: d.staff_name || '',
            lines: Number(d.line_count),
            units: Number(d.units),
            value_minor: Math.round(Number(d.value_minor)),
          }))
        ),
      ],
    };
  }

  // -------------------------------------------------------------------------
  // Product Audit, Product Sales Audit -- one product
  // -------------------------------------------------------------------------

  async function productOf(pool, office, plu) {
    const [[p]] = await pool.query(
      `SELECT p.pluid, p.product_name, p.stock_quantity, k.name AS pack_name, k.units AS pack_units
         FROM bo_products p
         LEFT JOIN bo_pack_sizes k ON k.id = p.pack_size_id AND k.office = p.email
        WHERE p.email = ? AND p.pluid = ? LIMIT 1`,
      [office, Number(plu)]
    );
    return p || null;
  }

  const kindLabel = { sale: 'Sale', refund: 'Refund', wastage: 'Wastage', delivery: 'Delivery', adjustment: 'Adjustment', stocktake: 'Stock take', spot_check: 'Spot check' };

  async function productAudit(args) {
    const { pool, office, from, to, product } = args;
    const p = product ? await productOf(pool, office, product) : null;
    const columns = [col('name', 'When'), col('kind', 'Movement'), col('quantity', 'Quantity', 'number'), col('balance', 'Balance', 'number'), col('cost_minor', 'Cost', 'money'), col('reason', 'Reason / Reference'), col('who', 'By'), col('terminal', 'Terminal')];
    const report = head('product_audit', 'Product Audit', office, args.siteName, from, to);
    if (!p) {
      return { ...report, sections: [section(product ? `No product with PLU ${product}` : 'Choose a product', columns, [])] };
    }
    report.productLabel = `${p.product_name} (PLU ${p.pluid})`;
    // The running balance is walked backwards from the current count, so the
    // last row's balance is what the shelf says now and the first row's is
    // what it said when the window opened.
    const [moves] = await pool.query(
      `SELECT kind, quantity, unit_cost_minor, reason, order_id, doc_id, staff_name, terminal, moved_at
         FROM epos_stock_movements
        WHERE office = ? AND pluid = ? AND moved_at BETWEEN ? AND ?
        ORDER BY moved_at, created_at`,
      [office, p.pluid, sqlDateTime(from), sqlDateTime(to)]
    );
    const [[after]] = await pool.query(
      `SELECT COALESCE(SUM(quantity), 0) AS qty FROM epos_stock_movements
        WHERE office = ? AND pluid = ? AND moved_at > ?`,
      [office, p.pluid, sqlDateTime(to)]
    );
    let balance = (Number(p.stock_quantity) || 0) - Number(after.qty);
    const rows = [];
    for (let i = moves.length - 1; i >= 0; i--) {
      const m = moves[i];
      rows.unshift({
        name: stamp(m.moved_at),
        kind: kindLabel[m.kind] || m.kind,
        quantity: Number(m.quantity),
        balance,
        cost_minor: Math.round(Math.abs(Number(m.quantity)) * m.unit_cost_minor),
        reason: m.reason || (m.order_id ? `Order ${String(m.order_id).slice(0, 8).toUpperCase()}` : ''),
        who: m.staff_name || '',
        terminal: m.terminal || '',
      });
      balance -= Number(m.quantity);
    }
    const s = section(`${p.product_name} — now ${withPacks(p.stock_quantity ?? 0, p.pack_name, p.pack_units)}`, columns, rows);
    s.total.balance = null;
    return { ...report, sections: [s] };
  }

  async function productSalesAudit(args) {
    const { pool, office, from, to, product, terminal } = args;
    const p = product ? await productOf(pool, office, product) : null;
    const columns = [col('name', 'Date & Time'), col('order', 'Order'), col('clerk', 'Clerk'), col('terminal', 'Terminal'), col('quantity', 'Quantity', 'number'), col('value_minor', 'Value', 'money')];
    const report = head('product_sales_audit', 'Product Sales Audit', office, args.siteName, from, to);
    if (!p) {
      return { ...report, sections: [section(product ? `No product with PLU ${product}` : 'Choose a product', columns, [])] };
    }
    report.productLabel = `${p.product_name} (PLU ${p.pluid})`;
    const params = [office, p.pluid, sqlDateTime(from), sqlDateTime(to)];
    let where = 'o.email = ? AND l.plu_id = ? AND o.closed_at BETWEEN ? AND ?';
    if (terminal === '__unknown__') where += " AND (o.terminal IS NULL OR o.terminal = '')";
    else if (terminal) {
      where += ' AND o.terminal = ?';
      params.push(terminal);
    }
    const [lines] = await pool.query(
      `SELECT o.id, o.closed_at, o.clerk_name, o.terminal, l.quantity,
              l.unit_price_minor * l.quantity - COALESCE(l.discount_minor, 0) AS value_minor
         FROM epos_order_lines l
         JOIN epos_orders o ON o.id = l.order_id
        WHERE ${where}
        ORDER BY o.closed_at`,
      params
    );
    return {
      ...report,
      sections: [
        section(
          p.product_name,
          columns,
          lines.map((l) => ({
            name: stamp(l.closed_at),
            order: String(l.id).slice(0, 8).toUpperCase(),
            clerk: l.clerk_name || '',
            terminal: l.terminal || '',
            quantity: Number(l.quantity),
            value_minor: Math.round(Number(l.value_minor)),
          }))
        ),
      ],
    };
  }

  const entry = (label, description, build, filters = []) => ({ label, group: 'stock', description, build, filters });

  return {
    stock_movements: entry('Stock Movements', 'What was sold, wasted, delivered, adjusted and counted for every tracked product, and where it stands now.', stockMovements, ['department']),
    stock_valuation: entry('Stock Valuation', 'Every tracked product’s count and value at cost as at the end of the period, with its selling price and GP.', stockValuation, ['department', 'group_by']),
    wastage_report: entry('Wastage Report', 'What was thrown away, at cost and at retail, and why.', wastageReport),
    stock_variance: entry('Stock Variance', 'Every stock take and spot check completed in the period: expected against counted, and the difference in money.', stockVariance),
    orders_and_deliveries: entry('Orders & Deliveries', 'Purchase orders raised in the period and the deliveries booked in against them.', ordersAndDeliveries),
    product_audit: entry('Product Audit', 'Every movement of one product in the period, with its running balance.', productAudit, ['product']),
    product_sales_audit: entry('Product Sales Audit', 'Every sale of one product in the period: when, by whom, on which till.', productSalesAudit, ['product']),
  };
}

module.exports = { stockBuilders };
