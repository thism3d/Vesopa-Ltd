/**
 * The sales and finance reports the venue asked for, by name, from the
 * Newbridge catalogue. Twenty of them, in the shape reports.js defines.
 *
 * MOST OF THEM ARE ONE QUERY
 *
 * Nearly every report here is a different grouping of the same rows: a sale
 * line, with the product it was, the department it sells under, the sale it
 * was on and who rang it. So there is one query for that (`saleLines`) and each
 * report groups it in JS. That is what makes them reconcile: Department Sales,
 * Sub Department Sales, Sales by Table Location and the Tax Report are four
 * views of one set of rows, and their totals agree because they cannot not.
 *
 * WHAT "COST" MEANS
 *
 * Cost of sales is the product's unit cost AS IT STANDS NOW times the quantity
 * sold -- the catalogue's `cost_price`, which stock control keeps in step with
 * the pack cost. That is the "notional" gross profit, the one every EPOS prints,
 * and it is honest about what it is. The GP Summary puts the actual figure
 * beside it, from the stock ledger, and names the difference.
 *
 * THE RULE EVERY ONE FOLLOWS
 *
 * Office bound in the WHERE, first parameter, and every join carries it.
 */

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function salesBuilders({ col, section, money, grouped, sqlDateTime, UNKNOWN_TERMINAL, taxWithin, totalOf }) {
  /** The window clause every query starts from, on the order alias `o`. */
  function windowOf({ office, from, to, terminal, alias = 'o', column = 'closed_at', owner = 'email' }) {
    const params = [office, sqlDateTime(from), sqlDateTime(to)];
    let where = `${alias}.${owner} = ? AND ${alias}.${column} BETWEEN ? AND ?`;
    if (terminal === UNKNOWN_TERMINAL) {
      where += ` AND (${alias}.terminal IS NULL OR ${alias}.terminal = '')`;
    } else if (terminal) {
      where += ` AND ${alias}.terminal = ?`;
      params.push(terminal);
    }
    return { where, params };
  }

  const head = (key, name, office, siteName, from, to) => ({
    key,
    name,
    site: siteName || office,
    from,
    to,
    generatedAt: new Date(),
  });

  const title = (s) => String(s || 'Unknown').replace(/(^|\s)\w/g, (c) => c.toUpperCase());

  const pct = (part, whole) => (whole > 0 ? (part / whole) * 100 : null);

  /**
   * Every sale line in the window, with everything the reports group by.
   *
   * Modifier lines are kept out, as the Financial Summary keeps them out: a
   * modifier is a note on the line above it, and its price is already in that
   * line's total.
   */
  async function saleLines({ pool, office, from, to, terminal, clerk, department }) {
    const { where, params } = windowOf({ office, from, to, terminal });
    let extra = '';
    if (clerk) {
      extra += ' AND o.clerk_name = ?';
      params.push(clerk);
    }
    if (department) {
      extra += " AND COALESCE(NULLIF(TRIM(p.department_name), ''), 'Unassigned') = ?";
      params.push(department);
    }
    const [rows] = await pool.query(
      `SELECT l.plu_id, l.name, l.quantity, l.unit_price_minor, l.tax_percentage,
              COALESCE(l.discount_minor, 0) AS discount_minor,
              COALESCE(NULLIF(TRIM(p.department_name), ''), 'Unassigned') AS department,
              COALESCE(NULLIF(TRIM(p.group_name), ''), 'Unassigned')      AS sub_department,
              COALESCE(p.cost_price, 0) AS cost_price,
              o.id AS order_id, o.closed_at, o.clerk_name, o.terminal, o.room_id,
              o.table_number, o.covers
         FROM epos_order_lines l
         JOIN epos_orders o ON o.id = l.order_id
         LEFT JOIN bo_products p ON p.pluid = l.plu_id AND p.email = o.email
        WHERE ${where}${extra}
          AND COALESCE(l.is_modifier, 0) = 0`,
      params
    );
    return rows.map((r) => {
      const qty = Number(r.quantity) || 0;
      const sales = Math.round(qty * Number(r.unit_price_minor || 0));
      const discount = Number(r.discount_minor) || 0;
      const gross = sales - discount;
      const tax = taxWithin(gross, r.tax_percentage);
      const cost = Math.round(qty * Number(r.cost_price) * 100);
      return {
        ...r,
        qty,
        sales_minor: sales,
        discount_minor: discount,
        gross_minor: gross,
        tax_minor: tax,
        net_minor: gross - tax,
        cost_minor: cost,
        closed_at: r.closed_at ? new Date(r.closed_at) : null,
      };
    });
  }

  /** Sum lines into named buckets. `keyOf` names the bucket a line lands in. */
  function bucketBy(lines, keyOf, extra = () => ({})) {
    const map = new Map();
    for (const line of lines) {
      const key = keyOf(line);
      if (key === null || key === undefined) continue;
      if (!map.has(key)) {
        map.set(key, {
          name: key,
          count: 0,
          sales_minor: 0,
          discount_minor: 0,
          gross_minor: 0,
          tax_minor: 0,
          net_minor: 0,
          cost_minor: 0,
          ...extra(line),
        });
      }
      const b = map.get(key);
      b.count += line.qty;
      b.sales_minor += line.sales_minor;
      b.discount_minor += line.discount_minor;
      b.gross_minor += line.gross_minor;
      b.tax_minor += line.tax_minor;
      b.net_minor += line.net_minor;
      b.cost_minor += line.cost_minor;
    }
    return [...map.values()];
  }

  /** The five columns the Financial Summary's tables carry, plus GP. */
  const salesCols = (first) => [
    col('name', first),
    col('sales_minor', 'Sales Total', 'money'),
    col('count', '# of Sales', 'number'),
    col('tax_minor', 'Tax £', 'money'),
    col('discount_minor', 'Discount Total', 'money'),
    col('gross_minor', 'Gross Total', 'money'),
    col('net_minor', 'Net Total', 'money'),
  ];

  const gpCols = (first) => [
    col('name', first),
    col('gross_minor', 'Sales', 'money'),
    col('cost_minor', 'COS', 'money'),
    col('gp_minor', 'GP £', 'money'),
    col('gp_pct', 'GP %', 'percent'),
  ];

  /** Add GP £ and GP % to a bucket, from its gross and cost. */
  const withGp = (row) => ({
    ...row,
    gp_minor: row.gross_minor - row.cost_minor,
    gp_pct: pct(row.gross_minor - row.cost_minor, row.gross_minor),
  });

  /** A section whose total also carries GP %, which totalOf cannot sum. */
  function gpSection(name, columns, rows) {
    const s = section(name, columns, rows);
    s.total.gp_pct = pct(s.total.gp_minor, s.total.gross_minor);
    return s;
  }

  const byValue = (a, b) => b.gross_minor - a.gross_minor;
  const byName = (a, b) => String(a.name).localeCompare(String(b.name));

  // -------------------------------------------------------------------------
  // Department Sales / Sub Department Sales
  // -------------------------------------------------------------------------

  async function departmentSales(args) {
    const lines = await saleLines(args);
    const rows = bucketBy(lines, (l) => l.department).sort(byName);
    return {
      ...head('department_sales', 'Department Sales', args.office, args.siteName, args.from, args.to),
      sections: [section('Department Sales', salesCols('Department'), rows)],
    };
  }

  async function subDepartmentSales(args) {
    const lines = await saleLines(args);
    const rows = bucketBy(lines, (l) => `${l.department} — ${l.sub_department}`).sort(byName);
    return {
      ...head('sub_department_sales', 'Sub Department Sales', args.office, args.siteName, args.from, args.to),
      sections: [section('Sub Department Sales', salesCols('Sub Department'), rows)],
    };
  }

  // -------------------------------------------------------------------------
  // Payment Types
  // -------------------------------------------------------------------------

  async function paymentTypes(args) {
    const { where, params } = windowOf(args);
    const [rows] = await args.pool.query(
      `SELECT pay.method, COUNT(*) AS count,
              COALESCE(SUM(pay.amount_minor), 0)   AS total_minor,
              COALESCE(SUM(pay.gratuity_minor), 0) AS gratuity_minor,
              COALESCE(SUM(pay.cashback_minor), 0) AS cashback_minor
         FROM epos_payments pay
         JOIN epos_orders o ON o.id = pay.order_id
        WHERE ${where}
        GROUP BY pay.method
        ORDER BY pay.method`,
      params
    );
    return {
      ...head('payment_types', 'Payment Type Transactions', args.office, args.siteName, args.from, args.to),
      sections: [
        section(
          'Payment Type Sales',
          [
            col('name', 'Payment Type'),
            col('count', 'Transactions', 'number'),
            col('total_minor', 'Amount', 'money'),
            col('gratuity_minor', 'Of which gratuity', 'money'),
            col('cashback_minor', 'Cashback given', 'money'),
          ],
          rows.map((r) => ({
            name: title(r.method),
            count: Number(r.count),
            total_minor: Number(r.total_minor),
            gratuity_minor: Number(r.gratuity_minor),
            cashback_minor: Number(r.cashback_minor),
          }))
        ),
      ],
    };
  }

  // -------------------------------------------------------------------------
  // Tax Report
  // -------------------------------------------------------------------------

  async function taxReport(args) {
    const lines = await saleLines(args);
    const rows = bucketBy(lines, (l) => `${Number(l.tax_percentage) || 0}% Rate`)
      .map((r) => ({ ...r, rate: parseFloat(r.name) }))
      .sort((a, b) => b.rate - a.rate);
    return {
      ...head('tax_report', 'Tax Report', args.office, args.siteName, args.from, args.to),
      sections: [
        section(
          'Tax Rate Sales',
          [
            col('name', 'Tax Rate'),
            col('gross_minor', 'Sales (inc. tax)', 'money'),
            col('net_minor', 'Net', 'money'),
            col('tax_minor', 'Tax Amount', 'money'),
          ],
          rows
        ),
      ],
    };
  }

  // -------------------------------------------------------------------------
  // Product Sales by Time
  // -------------------------------------------------------------------------

  async function productSalesByTime(args) {
    const lines = await saleLines(args);
    const hourOf = (l) => (l.closed_at ? l.closed_at.getHours() : null);
    const hours = bucketBy(lines, (l) => {
      const h = hourOf(l);
      return h === null ? 'Unknown' : `${String(h).padStart(2, '0')}:00 – ${String(h).padStart(2, '0')}:59`;
    }).sort(byName);
    const products = bucketBy(lines, (l) => l.name)
      .map(withGp)
      .sort(byValue);
    const total = products.reduce((s, r) => s + r.gross_minor, 0);
    return {
      ...head('product_sales_by_time', 'Product Sales by Time', args.office, args.siteName, args.from, args.to),
      sections: [
        section('Sales by Hour', salesCols('Hour'), hours),
        gpSection(
          'Products',
          [...gpCols('Product').slice(0, 1), col('count', '# of Sales', 'number'), ...gpCols('Product').slice(1), col('share_pct', '% of Sales', 'percent')],
          products.map((r) => ({ ...r, share_pct: pct(r.gross_minor, total) }))
        ),
      ],
    };
  }

  // -------------------------------------------------------------------------
  // Product Sales by Clerk
  // -------------------------------------------------------------------------

  async function productSalesByClerk(args) {
    const lines = await saleLines(args);
    const clerks = new Map();
    for (const l of lines) {
      const who = l.clerk_name || 'No clerk recorded';
      if (!clerks.has(who)) clerks.set(who, []);
      clerks.get(who).push(l);
    }
    const sections = [...clerks.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([who, list]) =>
        gpSection(
          who,
          [col('name', 'Product'), col('count', '# of Sales', 'number'), ...gpCols('Product').slice(1)],
          bucketBy(list, (l) => l.name).map(withGp).sort(byValue)
        )
      );
    return {
      ...head('product_sales_by_clerk', 'Product Sales by Clerk', args.office, args.siteName, args.from, args.to),
      sections: sections.length ? sections : [section('Products', [col('name', 'Product'), col('count', '# of Sales', 'number')], [])],
    };
  }

  // -------------------------------------------------------------------------
  // Weekly grids: Daily Department Sales, Financial Summary 7 Days
  // -------------------------------------------------------------------------

  /** Seven day columns from the week start, labelled "Mon 14/09". */
  function dayColumns(from) {
    const cols = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(from);
      d.setDate(d.getDate() + i);
      const dd = String(d.getDate()).padStart(2, '0');
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      cols.push({ key: `d${i}`, label: `${DAY_NAMES[(d.getDay() + 6) % 7]} ${dd}/${mm}`, type: 'money', day: d });
    }
    return cols;
  }

  const dayIndex = (at, from) => {
    if (!at) return null;
    const i = Math.floor((new Date(at).setHours(0, 0, 0, 0) - new Date(from).setHours(0, 0, 0, 0)) / 86400000);
    return i >= 0 && i < 7 ? i : null;
  };

  /** Rows of `name` × seven days, from any list of { name, at, minor }. */
  function grid(items, from) {
    const map = new Map();
    for (const it of items) {
      const i = dayIndex(it.at, from);
      if (i === null) continue;
      if (!map.has(it.name)) {
        map.set(it.name, { name: it.name, d0: 0, d1: 0, d2: 0, d3: 0, d4: 0, d5: 0, d6: 0, week_minor: 0 });
      }
      const row = map.get(it.name);
      row[`d${i}`] += it.minor;
      row.week_minor += it.minor;
    }
    return [...map.values()].sort(byName);
  }

  async function dailyDepartmentSales(args) {
    const lines = await saleLines(args);
    const days = dayColumns(args.from);
    const columns = [col('name', 'Department'), ...days.map((d) => col(d.key, d.label, 'money')), col('week_minor', 'Week', 'money')];
    const rows = grid(lines.map((l) => ({ name: l.department, at: l.closed_at, minor: l.net_minor })), args.from);
    return {
      ...head('daily_department_sales', 'Daily Department Sales', args.office, args.siteName, args.from, args.to),
      sections: [section('NET Weekly Sales', columns, rows)],
    };
  }

  async function financialSummary7Days(args) {
    const { pool, office, from } = args;
    const lines = await saleLines(args);
    const days = dayColumns(from);
    const columns = (first) => [col('name', first), ...days.map((d) => col(d.key, d.label, 'money')), col('week_minor', 'Week', 'money')];

    const { where, params } = windowOf(args);
    const [payments] = await pool.query(
      `SELECT pay.method AS name, o.closed_at AS at, pay.amount_minor AS minor
         FROM epos_payments pay JOIN epos_orders o ON o.id = pay.order_id
        WHERE ${where}`,
      params
    );
    const [general] = await pool.query(
      `SELECT o.closed_at AS at, o.gratuity_minor, o.service_minor, o.voucher_minor,
              o.points_value_minor, o.promo_minor, o.discount_minor
         FROM epos_orders o WHERE ${where}`,
      params
    );
    const ev = windowOf({ ...args, alias: 'e', column: 'at', owner: 'office' });
    const [events] = await pool
      .query(
        `SELECT e.kind, e.note, e.at, e.amount_minor FROM epos_till_events e WHERE ${ev.where}`,
        ev.params
      )
      .catch(() => [[]]);
    const [cashback] = await pool.query(
      `SELECT o.closed_at AS at, pay.cashback_minor AS minor
         FROM epos_payments pay JOIN epos_orders o ON o.id = pay.order_id
        WHERE ${where} AND pay.cashback_minor > 0`,
      params
    );

    const generalItems = [];
    for (const g of general) {
      const at = g.at;
      if (g.gratuity_minor) generalItems.push({ name: 'Gratuities', at, minor: Number(g.gratuity_minor) });
      if (g.service_minor && g.service_minor !== g.gratuity_minor) generalItems.push({ name: 'Service Charges', at, minor: Number(g.service_minor) });
      if (g.voucher_minor) generalItems.push({ name: 'Vouchers', at, minor: Number(g.voucher_minor) });
      if (g.points_value_minor) generalItems.push({ name: 'Points Redeemed', at, minor: Number(g.points_value_minor) });
      if (g.promo_minor) generalItems.push({ name: 'Promotions', at, minor: Number(g.promo_minor) });
      if (g.discount_minor) generalItems.push({ name: 'Discounts', at, minor: Number(g.discount_minor) });
    }
    for (const c of cashback) generalItems.push({ name: 'Cash Back', at: c.at, minor: Number(c.minor) });
    for (const e of events) {
      if (e.kind === 'cashback') generalItems.push({ name: 'Cash Back', at: e.at, minor: Number(e.amount_minor) });
      if (e.kind === 'refund') generalItems.push({ name: 'Refunds', at: e.at, minor: -Number(e.amount_minor) });
    }
    const expenses = events
      .filter((e) => e.kind === 'expense')
      .map((e) => ({ name: e.note || 'Expense', at: e.at, minor: -Number(e.amount_minor) }));

    return {
      ...head('financial_summary_7_days', 'Financial Summary 7 Days', office, args.siteName, from, args.to),
      sections: [
        section('Department Sales', columns('Department'), grid(lines.map((l) => ({ name: l.department, at: l.closed_at, minor: l.gross_minor })), from)),
        section('General', columns('Name'), grid(generalItems, from)),
        section('Expenses', columns('Paid to'), grid(expenses, from)),
        section('Payment Methods', columns('Method'), grid(payments.map((p) => ({ name: title(p.name), at: p.at, minor: Number(p.minor) })), from)),
      ],
    };
  }

  // -------------------------------------------------------------------------
  // Covers, Table Location
  // -------------------------------------------------------------------------

  async function roomsOf(pool, office) {
    const [[o]] = await pool.query('SELECT id FROM offices WHERE contact_email = ? LIMIT 1', [office]);
    if (!o) return new Map();
    const [rooms] = await pool.query('SELECT id, name FROM floor_rooms WHERE office_id = ?', [o.id]);
    return new Map(rooms.map((r) => [r.id, r.name]));
  }

  /** Breakfast / Lunch / Afternoon / Evening / Late, by the hour a bill closed. */
  const dayPart = (at) => {
    if (!at) return 'Unknown';
    const h = at.getHours();
    if (h < 11) return 'Breakfast (to 11:00)';
    if (h < 15) return 'Lunch (11:00 – 15:00)';
    if (h < 18) return 'Afternoon (15:00 – 18:00)';
    if (h < 22) return 'Evening (18:00 – 22:00)';
    return 'Late (from 22:00)';
  };

  async function coversReport(args) {
    const { where, params } = windowOf(args);
    const [orders] = await args.pool.query(
      `SELECT o.id, o.closed_at, o.covers, o.total_minor, o.room_id FROM epos_orders o WHERE ${where}`,
      params
    );
    const rooms = await roomsOf(args.pool, args.office);
    const summarise = (keyOf) => {
      const map = new Map();
      for (const o of orders) {
        const key = keyOf(o);
        if (!map.has(key)) map.set(key, { name: key, covers: 0, bills: 0, gross_minor: 0 });
        const b = map.get(key);
        b.covers += Number(o.covers) || 0;
        b.bills += 1;
        b.gross_minor += Number(o.total_minor) || 0;
      }
      return [...map.values()]
        .map((r) => ({ ...r, average_minor: r.covers > 0 ? Math.round(r.gross_minor / r.covers) : 0 }))
        .sort(byName);
    };
    const columns = (first) => [
      col('name', first),
      col('covers', 'Covers', 'number'),
      col('bills', '# of Sales', 'number'),
      col('gross_minor', 'Gross Sales', 'money'),
      col('average_minor', 'Average Spend', 'money'),
    ];
    const fix = (s) => {
      s.total.average_minor = s.total.covers > 0 ? Math.round(s.total.gross_minor / s.total.covers) : 0;
      return s;
    };
    return {
      ...head('covers_report', 'Covers Report', args.office, args.siteName, args.from, args.to),
      sections: [
        fix(section('Covers by Day Part', columns('Day Part'), summarise((o) => dayPart(o.closed_at ? new Date(o.closed_at) : null)))),
        fix(section('Covers by Table Location', columns('Location'), summarise((o) => (o.room_id && rooms.get(o.room_id)) || 'None'))),
      ],
    };
  }

  async function salesByTableLocation(args) {
    const lines = await saleLines(args);
    const rooms = await roomsOf(args.pool, args.office);
    const rows = bucketBy(lines, (l) => `${(l.room_id && rooms.get(l.room_id)) || 'None'} — ${l.sub_department}`).sort(byName);
    return {
      ...head('sales_by_table_location', 'Sales by Table Location', args.office, args.siteName, args.from, args.to),
      sections: [section('Sales by Location and Sub Department', salesCols('Location — Sub Department'), rows)],
    };
  }

  // -------------------------------------------------------------------------
  // Profit Summary, GP Summary, Weekly Sales Analysis
  // -------------------------------------------------------------------------

  /**
   * What the staff on the clock cost in the window: every shift's overlap
   * with it, in hours, times the person's hourly rate. Shifts still open are
   * counted to now. Staff with no rate set are counted at zero and named, so
   * a labour line of £0.00 is not mistaken for a venue with no wages.
   */
  async function labourCost({ pool, office, from, to }) {
    const [shifts] = await pool
      .query(
        `SELECT t.staff_name, t.clocked_in_at, t.clocked_out_at, c.hourly_rate
           FROM epos_time_clock t
           LEFT JOIN bo_clarks c ON c.id = t.staff_id AND c.email = ?
          WHERE t.office = ?
            AND t.clocked_in_at <= ?
            AND (t.clocked_out_at IS NULL OR t.clocked_out_at >= ?)`,
        [office, office, sqlDateTime(to), sqlDateTime(from)]
      )
      .catch(() => [[]]);
    const byArea = new Map();
    const unrated = new Set();
    let hours = 0;
    for (const s of shifts) {
      const start = Math.max(new Date(s.clocked_in_at).getTime(), from.getTime());
      const end = Math.min(s.clocked_out_at ? new Date(s.clocked_out_at).getTime() : Date.now(), to.getTime());
      if (end <= start) continue;
      const h = (end - start) / 3600000;
      hours += h;
      const rate = Number(s.hourly_rate);
      if (!Number.isFinite(rate) || rate <= 0) unrated.add(s.staff_name || 'Unnamed');
      const name = s.staff_name || 'Unnamed';
      if (!byArea.has(name)) byArea.set(name, { name, hours: 0, total_minor: 0 });
      const row = byArea.get(name);
      row.hours += h;
      row.total_minor += Number.isFinite(rate) ? Math.round(h * rate * 100) : 0;
    }
    return {
      rows: [...byArea.values()].map((r) => ({ ...r, hours: Number(r.hours.toFixed(2)) })).sort(byName),
      hours,
      total: [...byArea.values()].reduce((s, r) => s + r.total_minor, 0),
      unrated: [...unrated],
    };
  }

  async function profitSummary(args) {
    const lines = await saleLines(args);
    const departments = bucketBy(lines, (l) => l.department).map(withGp).sort(byName);
    const labour = await labourCost(args);
    const grossProfit = departments.reduce((s, d) => s + d.gp_minor, 0);
    const sales = departments.reduce((s, d) => s + d.gross_minor, 0);
    const summary = [
      { name: 'Gross Profit Total', total_minor: grossProfit },
      { name: 'Total Labour Cost', total_minor: labour.total },
      { name: 'Net Profit', total_minor: grossProfit - labour.total },
    ];
    const labourSection = section(
      labour.unrated.length
        ? `Labour Costs (no hourly rate set for: ${labour.unrated.join(', ')})`
        : 'Labour Costs',
      [col('name', 'Staff'), col('hours', 'Hours', 'number'), col('total_minor', 'Total', 'money')],
      labour.rows
    );
    const summarySection = section('Summary', [col('name', ''), col('total_minor', 'Total', 'money')], summary);
    summarySection.total = null;
    return {
      ...head('profit_summary', 'Profit Summary', args.office, args.siteName, args.from, args.to),
      highlights: [
        { key: 'sales', label: 'Sales', value: grouped(money(sales)), minor: sales, hint: 'Gross, in the window' },
        { key: 'gp', label: 'Gross profit', value: grouped(money(grossProfit)), minor: grossProfit, hint: `${(pct(grossProfit, sales) || 0).toFixed(2)}% of sales` },
        { key: 'labour', label: 'Labour', value: grouped(money(labour.total)), minor: labour.total, hint: `${labour.hours.toFixed(1)} hours on the clock` },
        { key: 'net', label: 'Net profit', value: grouped(money(grossProfit - labour.total)), minor: grossProfit - labour.total, hint: 'Gross profit less labour' },
      ],
      sections: [gpSection('Department Sales', gpCols('Department'), departments), labourSection, summarySection],
    };
  }

  /**
   * Notional GP against actual GP.
   *
   * Notional is what the catalogue says a sale should have cost. Actual is
   * what the stock ledger says left the building in the window -- sales, plus
   * wastage, plus anything adjusted or counted out -- at the cost each
   * movement was written with. A venue that does not track stock has no
   * ledger and the actual line says so rather than pretending to be 100%.
   */
  async function gpSummary(args) {
    const lines = await saleLines(args);
    const sales = lines.reduce((s, l) => s + l.gross_minor, 0);
    const notionalCost = lines.reduce((s, l) => s + l.cost_minor, 0);
    const [[ledger]] = await args.pool
      .query(
        `SELECT COUNT(*) AS n,
                COALESCE(SUM(CASE WHEN quantity < 0 THEN -quantity * unit_cost_minor ELSE 0 END), 0) AS out_minor,
                COALESCE(SUM(CASE WHEN kind = 'sale' THEN -quantity * unit_cost_minor ELSE 0 END), 0) AS sale_minor,
                COALESCE(SUM(CASE WHEN kind = 'wastage' THEN -quantity * unit_cost_minor ELSE 0 END), 0) AS wastage_minor,
                COALESCE(SUM(CASE WHEN kind IN ('adjustment','stocktake','spot_check') AND quantity < 0 THEN -quantity * unit_cost_minor ELSE 0 END), 0) AS shrink_minor
           FROM epos_stock_movements
          WHERE office = ? AND moved_at BETWEEN ? AND ?`,
        [args.office, sqlDateTime(args.from), sqlDateTime(args.to)]
      )
      .catch(() => [[{ n: 0, out_minor: 0, sale_minor: 0, wastage_minor: 0, shrink_minor: 0 }]]);
    const tracked = Number(ledger.n) > 0;
    const actualCost = Math.round(Number(ledger.out_minor));
    const rows = [
      { name: 'Total Notional GP', cost_minor: notionalCost, gp_minor: sales - notionalCost, gp_pct: pct(sales - notionalCost, sales) },
      tracked
        ? { name: 'Total Actual GP', cost_minor: actualCost, gp_minor: sales - actualCost, gp_pct: pct(sales - actualCost, sales) }
        : { name: 'Total Actual GP (no stock tracked in this period)', cost_minor: null, gp_minor: null, gp_pct: null },
    ];
    const where = [
      { name: 'Sold (at cost)', total_minor: Math.round(Number(ledger.sale_minor)) },
      { name: 'Wasted', total_minor: Math.round(Number(ledger.wastage_minor)) },
      { name: 'Counted or adjusted out', total_minor: Math.round(Number(ledger.shrink_minor)) },
    ];
    const gp = section('Gross Profit', [col('name', 'Type'), col('cost_minor', 'Cost', 'money'), col('gp_minor', 'GP £', 'money'), col('gp_pct', 'GP %', 'percent')], rows);
    gp.total = null;
    return {
      ...head('gp_summary', 'GP Summary', args.office, args.siteName, args.from, args.to),
      highlights: [
        { key: 'sales', label: 'Sales', value: grouped(money(sales)), minor: sales, hint: 'Gross, in the window' },
        { key: 'notional', label: 'Notional GP', value: `${(rows[0].gp_pct || 0).toFixed(2)}%`, hint: money(rows[0].gp_minor) },
        { key: 'actual', label: 'Actual GP', value: tracked ? `${(rows[1].gp_pct || 0).toFixed(2)}%` : '—', hint: tracked ? money(rows[1].gp_minor) : 'No stock movements in the period' },
      ],
      sections: [gp, section('Where the actual cost went', [col('name', ''), col('total_minor', 'Cost', 'money')], where)],
    };
  }

  async function weeklySalesAnalysis(args) {
    const lines = await saleLines(args);
    const departments = bucketBy(lines, (l) => l.department).map(withGp).sort(byName);
    const total = departments.reduce((s, d) => s + d.gross_minor, 0);
    const rows = departments.map((d) => ({ ...d, mix_pct: pct(d.gross_minor, total) }));
    const s = gpSection(
      'Sales Mix and Gross Profit',
      [col('name', 'Department'), col('gross_minor', 'Sales', 'money'), col('mix_pct', 'Sales Mix %', 'percent'), col('cost_minor', 'COS', 'money'), col('gp_minor', 'GP £', 'money'), col('gp_pct', 'GP %', 'percent')],
      rows
    );
    s.total.mix_pct = total > 0 ? 100 : null;
    return {
      ...head('weekly_sales_analysis', 'Sales Analysis', args.office, args.siteName, args.from, args.to),
      sections: [s],
    };
  }

  // -------------------------------------------------------------------------
  // Clerk Gratuities
  // -------------------------------------------------------------------------

  async function clerkGratuities(args) {
    const { where, params } = windowOf(args);
    const [rows] = await args.pool.query(
      `SELECT COALESCE(NULLIF(o.clerk_name, ''), 'No clerk recorded') AS name,
              SUM(o.gratuity_minor > 0) AS count,
              COALESCE(SUM(o.gratuity_minor), 0) AS total_minor,
              COALESCE(SUM(o.total_minor), 0) AS sales_minor
         FROM epos_orders o
        WHERE ${where}
        GROUP BY name
        ORDER BY name`,
      params
    );
    return {
      ...head('clerk_gratuities', 'Clerk Gratuities', args.office, args.siteName, args.from, args.to),
      sections: [
        section(
          'Gratuities by Clerk',
          [col('name', 'Clerk'), col('count', 'Gratuities', 'number'), col('total_minor', 'Gratuity Total', 'money'), col('sales_minor', 'Sales', 'money')],
          rows.map((r) => ({ ...r, count: Number(r.count), total_minor: Number(r.total_minor), sales_minor: Number(r.sales_minor) }))
        ),
      ],
    };
  }

  // -------------------------------------------------------------------------
  // Transactions
  // -------------------------------------------------------------------------

  const stamp = (at) => (at ? new Date(at).toLocaleString('en-GB') : '');
  const shortId = (id) => String(id || '').slice(0, 8).toUpperCase();

  async function transactionsByPaymentType(args) {
    const { where, params } = windowOf(args);
    const [rows] = await args.pool.query(
      `SELECT pay.method, pay.amount_minor, pay.gratuity_minor, pay.cashback_minor, pay.reference,
              o.id AS order_id, o.closed_at, o.terminal, o.clerk_name, o.table_number
         FROM epos_payments pay
         JOIN epos_orders o ON o.id = pay.order_id
        WHERE ${where}
        ORDER BY pay.method, o.closed_at`,
      params
    );
    const byMethod = new Map();
    for (const r of rows) {
      const m = title(r.method);
      if (!byMethod.has(m)) byMethod.set(m, []);
      byMethod.get(m).push({
        name: stamp(r.closed_at),
        order: shortId(r.order_id),
        terminal: r.terminal || '',
        clerk: r.clerk_name || '',
        reference: r.reference || '',
        amount_minor: Number(r.amount_minor),
      });
    }
    const columns = [col('name', 'Time'), col('order', 'Order'), col('terminal', 'Terminal'), col('clerk', 'Clerk'), col('reference', 'Reference'), col('amount_minor', 'Amount', 'money')];
    const sections = [...byMethod.entries()].map(([m, list]) => section(m, columns, list));
    return {
      ...head('transactions_by_payment_type', 'Transactions by Payment Type', args.office, args.siteName, args.from, args.to),
      sections: sections.length ? sections : [section('Transactions', columns, [])],
    };
  }

  async function transactionDetail(args) {
    const { where, params } = windowOf(args);
    const [orders] = await args.pool.query(
      `SELECT o.id, o.closed_at, o.terminal, o.clerk_name, o.table_number, o.covers,
              o.total_minor, o.discount_minor, o.gratuity_minor,
              (SELECT GROUP_CONCAT(DISTINCT pay.method ORDER BY pay.method SEPARATOR ', ')
                 FROM epos_payments pay WHERE pay.order_id = o.id) AS methods,
              (SELECT COUNT(*) FROM epos_order_lines l WHERE l.order_id = o.id AND COALESCE(l.is_modifier, 0) = 0) AS items
         FROM epos_orders o
        WHERE ${where}
        ORDER BY o.closed_at`,
      params
    );
    return {
      ...head('transaction_detail', 'Transaction Detail', args.office, args.siteName, args.from, args.to),
      sections: [
        section(
          'Transactions',
          [col('name', 'Time'), col('order', 'Order'), col('clerk', 'Clerk'), col('terminal', 'Terminal'), col('table', 'Table'), col('methods', 'Method'), col('items', 'Items', 'number'), col('discount_minor', 'Discount', 'money'), col('gratuity_minor', 'Gratuity', 'money'), col('total_minor', 'Total', 'money')],
          orders.map((o) => ({
            name: stamp(o.closed_at),
            order: shortId(o.id),
            clerk: o.clerk_name || '',
            terminal: o.terminal || '',
            table: o.table_number ? String(o.table_number) : '',
            methods: title(o.methods || 'None'),
            items: Number(o.items),
            discount_minor: Number(o.discount_minor) || 0,
            gratuity_minor: Number(o.gratuity_minor) || 0,
            total_minor: Number(o.total_minor) || 0,
          }))
        ),
      ],
    };
  }

  // -------------------------------------------------------------------------
  // Sales Comparison
  // -------------------------------------------------------------------------

  async function salesComparison(args) {
    const span = args.to.getTime() - args.from.getTime() + 1;
    const prevTo = new Date(args.from.getTime() - 1);
    const prevFrom = new Date(prevTo.getTime() - span + 1);
    const [now, before] = await Promise.all([
      saleLines(args),
      saleLines({ ...args, from: prevFrom, to: prevTo }),
    ]);
    const a = new Map(bucketBy(now, (l) => l.department).map((r) => [r.name, r]));
    const b = new Map(bucketBy(before, (l) => l.department).map((r) => [r.name, r]));
    const names = [...new Set([...a.keys(), ...b.keys()])].sort();
    const rows = names.map((name) => {
      const thisMinor = a.get(name)?.gross_minor || 0;
      const lastMinor = b.get(name)?.gross_minor || 0;
      return {
        name,
        this_count: a.get(name)?.count || 0,
        this_minor: thisMinor,
        last_count: b.get(name)?.count || 0,
        last_minor: lastMinor,
        change_minor: thisMinor - lastMinor,
        change_pct: lastMinor > 0 ? ((thisMinor - lastMinor) / lastMinor) * 100 : null,
      };
    });
    const s = section(
      `This period against the ${prevFrom.toLocaleDateString('en-GB')} – ${prevTo.toLocaleDateString('en-GB')} before it`,
      [col('name', 'Department'), col('this_count', 'Sales', 'number'), col('this_minor', 'This Period', 'money'), col('last_count', 'Sales', 'number'), col('last_minor', 'Previous Period', 'money'), col('change_minor', 'Change', 'money'), col('change_pct', 'Change %', 'percent')],
      rows
    );
    s.total.change_pct = s.total.last_minor > 0 ? (s.total.change_minor / s.total.last_minor) * 100 : null;
    return {
      ...head('sales_comparison', 'Sales Comparison', args.office, args.siteName, args.from, args.to),
      sections: [s],
    };
  }

  // -------------------------------------------------------------------------
  // Refunds, Expenses, Cashback -- from the till's events
  // -------------------------------------------------------------------------

  async function tillEvents(args, kind) {
    const { where, params } = windowOf({ ...args, alias: 'e', column: 'at', owner: 'office' });
    const [rows] = await args.pool
      .query(
        `SELECT e.at, e.amount_minor, e.note, e.reason, e.staff_name, e.terminal, e.order_id
           FROM epos_till_events e
          WHERE ${where} AND e.kind = ?
          ORDER BY e.at`,
        [...params, kind]
      )
      .catch(() => [[]]);
    return rows;
  }

  const eventCols = (noteLabel) => [
    col('name', 'Date'),
    col('amount_minor', 'Amount', 'money'),
    col('note', noteLabel),
    col('reason', 'Reason'),
    col('clerk', 'Clerk'),
    col('terminal', 'Terminal'),
  ];
  const eventRow = (e) => ({
    name: stamp(e.at),
    amount_minor: Number(e.amount_minor),
    note: e.note || '',
    reason: e.reason || '',
    clerk: e.staff_name || '',
    terminal: e.terminal || '',
  });

  async function refunds(args) {
    const rows = (await tillEvents(args, 'refund')).map(eventRow);
    return {
      ...head('refunds', 'Refunds', args.office, args.siteName, args.from, args.to),
      sections: [section('Refunds', eventCols('What was refunded'), rows)],
    };
  }

  async function expenses(args) {
    const rows = (await tillEvents(args, 'expense')).map(eventRow);
    return {
      ...head('expenses', 'Expenses', args.office, args.siteName, args.from, args.to),
      sections: [section('Paid Out of the Drawer', eventCols('Paid to'), rows)],
    };
  }

  async function cashback(args) {
    const { where, params } = windowOf(args);
    const [onCard] = await args.pool.query(
      `SELECT o.closed_at AS at, pay.cashback_minor AS amount_minor, o.clerk_name AS staff_name,
              o.terminal, o.id AS order_id
         FROM epos_payments pay JOIN epos_orders o ON o.id = pay.order_id
        WHERE ${where} AND pay.cashback_minor > 0
        ORDER BY o.closed_at`,
      params
    );
    const events = await tillEvents(args, 'cashback');
    const rows = [...onCard, ...events]
      .sort((a, b) => new Date(a.at) - new Date(b.at))
      .map((e) => ({ ...eventRow(e), note: shortId(e.order_id) }));
    return {
      ...head('cashback', 'Cashback', args.office, args.siteName, args.from, args.to),
      sections: [section('Cashback Given', eventCols('Order'), rows)],
    };
  }

  // -------------------------------------------------------------------------
  // The registry
  // -------------------------------------------------------------------------

  const entry = (label, description, build, filters = []) => ({ label, group: 'sales', description, build, filters });

  return {
    department_sales: entry('Department Sales', 'Sales by department alone — the first table of the Financial Summary, on its own page.', departmentSales),
    sub_department_sales: entry('Sub Department Sales', 'Sales by sub department, under the department each belongs to.', subDepartmentSales),
    payment_types: entry('Payment Type Transactions', 'How much was taken by each method, with the gratuity and cashback inside it.', paymentTypes),
    tax_report: entry('Tax Report', 'Sales at each tax rate, and the tax inside them.', taxReport),
    product_sales_by_time: entry('Product Sales by Time', 'Sales by hour of the day, then every product with its GP and share of sales.', productSalesByTime),
    product_sales_by_clerk: entry('Product Sales by Clerk', 'What each member of staff sold, product by product, with GP.', productSalesByClerk, ['clerk']),
    daily_department_sales: entry('Daily Department Sales', 'Net sales by department for each of the seven days from the date chosen.', dailyDepartmentSales, ['week_start']),
    financial_summary_7_days: entry('Financial Summary 7 Days', 'Department sales, general income, expenses and payment methods, a column per day for the week.', financialSummary7Days, ['week_start']),
    covers_report: entry('Covers Report', 'Covers, sales and spend per head by part of the day and by room.', coversReport),
    sales_by_table_location: entry('Sales by Table Location', 'Sales by room and sub department.', salesByTableLocation),
    profit_summary: entry('Profit Summary', 'Sales, cost of sales and gross profit by department; labour from the time clock; net profit.', profitSummary),
    gp_summary: entry('GP Summary', 'Notional gross profit from the catalogue against actual gross profit from the stock ledger.', gpSummary),
    weekly_sales_analysis: entry('Sales Analysis', 'Each department’s share of sales and its gross profit percentage.', weeklySalesAnalysis),
    clerk_gratuities: entry('Clerk Gratuities', 'Gratuities taken, by the member of staff who took them.', clerkGratuities),
    transactions_by_payment_type: entry('Transactions by Payment Type', 'Every payment in the window, one row each, grouped by method.', transactionsByPaymentType),
    transaction_detail: entry('Transaction Detail', 'Every sale in the window, one row each: time, clerk, terminal, table, method and total.', transactionDetail),
    sales_comparison: entry('Sales Comparison', 'Department sales in the window against the period of the same length before it.', salesComparison),
    refunds: entry('Refunds', 'Money handed back at the till, when, by whom and why.', refunds),
    expenses: entry('Expenses', 'Money paid out of the drawer — to whom and for what.', expenses),
    cashback: entry('Cashback', 'Cashback given against card payments and at the drawer.', cashback),
  };
}

module.exports = { salesBuilders };
