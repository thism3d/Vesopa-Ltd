/**
 * Four more reports, in the shape reports.js already defines.
 *
 * A builder answers `{ key, name, site, from, to, generatedAt, sections }` and
 * nothing downstream knows anything else about it — the browser, the three
 * exporters and the scheduled email all read that one shape. So these live in
 * their own file and reports.js does no more than list them: adding a report is
 * a builder, not a change to four renderers.
 *
 * THE RULE EVERY ONE OF THEM FOLLOWS
 *
 * Scoped by office, in the WHERE clause, always. A report is the one screen a
 * venue prints and hands to an accountant, and the fault that brought all this
 * about was six report routes that read `epos_orders` with no owner at all —
 * see the tenancy tests. Every query below binds the office as its first
 * parameter, and there is a test that fails if one stops.
 *
 * WHY THE JOINS CARRY IT TOO
 *
 * `bo_products.pluid` is unique within an office and not across the platform.
 * Joining on it alone borrows another venue's product names into a report whose
 * figures are correctly scoped, which is worse to spot than the obvious leak
 * because the numbers look right.
 */

// ---------------------------------------------------------------------------
// Shared shape
// ---------------------------------------------------------------------------

/**
 * The window every builder starts from.
 *
 * Lifted from `financialSummary` deliberately rather than reimplemented: the
 * terminal filter's `__unknown__` sentinel and the inclusive end of the day are
 * both decisions that have to be the same on every report, or two reports over
 * the same dates disagree by a sale.
 */
function tradingWindow({ office, from, to, terminal, sqlDateTime, unknownTerminal }) {
  const params = [office, sqlDateTime(from), sqlDateTime(to)];
  let where = 'o.email = ? AND o.closed_at BETWEEN ? AND ?';

  if (terminal === unknownTerminal) {
    where += " AND (o.terminal IS NULL OR o.terminal = '')";
  } else if (terminal) {
    where += ' AND o.terminal = ?';
    params.push(terminal);
  }
  return { where, params };
}

/**
 * Build the four. Handed the helpers reports.js owns rather than importing them
 * back, so there is one definition of a column, a section and a money format.
 */
function reportBuilders({ col, section, money, grouped, sqlDateTime, UNKNOWN_TERMINAL }) {
  const win = (args) =>
    tradingWindow({ ...args, sqlDateTime, unknownTerminal: UNKNOWN_TERMINAL });

  const head = (key, name, office, siteName, from, to) => ({
    key,
    name,
    site: siteName || office,
    from,
    to,
    generatedAt: new Date(),
  });

  // -------------------------------------------------------------------------
  // Product Sales
  // -------------------------------------------------------------------------

  /**
   * Every product sold in the window, most valuable first.
   *
   * Grouped by the name as it was *rung up*, not by the product id. A venue
   * that renames a burger halfway through the month has sold two names, and
   * folding them together would restate what the receipts say — while a product
   * deleted since the sale has no row to join to at all and would vanish
   * entirely. The line carries its own name for exactly this reason.
   *
   * The department comes from the catalogue as it stands now, which is what the
   * Financial Summary does; matching it is worth more than being differently
   * right.
   */
  async function productSales({ pool, office, from, to, siteName, terminal }) {
    const { where, params } = win({ office, from, to, terminal });

    const [rows] = await pool.query(
      `SELECT l.name AS name,
              COALESCE(NULLIF(TRIM(p.department_name), ''), 'Unassigned') AS department,
              SUM(l.quantity)                                    AS count,
              SUM(l.unit_price_minor * l.quantity)               AS gross_minor,
              SUM(COALESCE(l.discount_minor, 0))                 AS discount_minor,
              SUM(
                (l.unit_price_minor * l.quantity - COALESCE(l.discount_minor, 0))
                * l.tax_percentage / (100 + l.tax_percentage)
              )                                                  AS tax_minor
         FROM epos_order_lines l
         JOIN epos_orders o ON o.id = l.order_id
         LEFT JOIN bo_products p
                ON p.pluid = l.plu_id AND p.email = o.email
        WHERE ${where}
          AND COALESCE(l.is_modifier, 0) = 0
        GROUP BY l.name, department
        ORDER BY gross_minor DESC`,
      params
    );

    const products = rows.map((r) => {
      const gross = Math.round(Number(r.gross_minor) || 0);
      const discount = Math.round(Number(r.discount_minor) || 0);
      const tax = Math.round(Number(r.tax_minor) || 0);
      const sales = gross - discount;
      return {
        name: r.name,
        department: r.department,
        count: Number(r.count) || 0,
        sales_minor: sales,
        gross_minor: gross,
        discount_minor: discount,
        tax_minor: tax,
        net_minor: sales - tax,
      };
    });

    // The same breakdown rolled up, because "which department is carrying the
    // month" is the question a product list of two hundred rows cannot answer.
    const byDepartment = new Map();
    for (const p of products) {
      const row = byDepartment.get(p.department) ?? {
        name: p.department,
        count: 0,
        sales_minor: 0,
        gross_minor: 0,
        discount_minor: 0,
        tax_minor: 0,
        net_minor: 0,
      };
      for (const key of ['count', 'sales_minor', 'gross_minor', 'discount_minor', 'tax_minor', 'net_minor']) {
        row[key] += p[key];
      }
      byDepartment.set(p.department, row);
    }

    const columns = [
      col('name', 'Product'),
      col('department', 'Department'),
      col('count', 'Qty', 'number'),
      col('sales_minor', 'Sales Total', 'money'),
      col('discount_minor', 'Discount', 'money'),
      col('tax_minor', 'Tax £', 'money'),
      col('net_minor', 'Net Total', 'money'),
    ];

    return {
      ...head('product_sales', 'Product Sales', office, siteName, from, to),
      highlights: [
        {
          label: 'Products sold',
          value: grouped(String(products.length)),
          hint: 'Distinct lines in the window',
        },
        {
          label: 'Items',
          value: grouped(String(products.reduce((n, p) => n + p.count, 0))),
          hint: 'Total quantity rung up',
        },
        {
          label: 'Sales',
          value: grouped(money(products.reduce((n, p) => n + p.sales_minor, 0))),
          minor: products.reduce((n, p) => n + p.sales_minor, 0),
          hint: 'After discounts',
        },
      ],
      sections: [
        section('Product Sales', columns, products),
        section(
          'By Department',
          columns.filter((c) => c.key !== 'department'),
          [...byDepartment.values()].sort((a, b) => b.sales_minor - a.sales_minor)
        ),
      ],
    };
  }

  // -------------------------------------------------------------------------
  // Discounts
  // -------------------------------------------------------------------------

  /**
   * Every reduction given away, and by whom.
   *
   * Two kinds, kept apart because they are two different conversations. A
   * *promotion* is a rule the venue set up and it firing is the system working.
   * A *manual* discount is somebody deciding at the counter, and that is the
   * number a manager is actually looking for.
   *
   * The staff table is the point of the report. "We gave away four hundred
   * pounds last month" is interesting; "and two hundred of it was one person"
   * is actionable.
   */
  async function discountReport({ pool, office, from, to, siteName, terminal }) {
    const { where, params } = win({ office, from, to, terminal });

    const [byName] = await pool.query(
      `SELECT COALESCE(NULLIF(TRIM(l.promotion_name), ''), 'Manual discount') AS name,
              COUNT(*)                            AS count,
              SUM(COALESCE(l.discount_minor, 0))  AS total_minor
         FROM epos_order_lines l
         JOIN epos_orders o ON o.id = l.order_id
        WHERE ${where} AND COALESCE(l.discount_minor, 0) > 0
        GROUP BY name
        ORDER BY total_minor DESC`,
      params
    );

    // Bill-level discounts, which do not live on a line at all.
    const [billLevel] = await pool.query(
      `SELECT COUNT(*) AS count, SUM(COALESCE(o.discount_minor, 0)) AS total_minor
         FROM epos_orders o
        WHERE ${where} AND COALESCE(o.discount_minor, 0) > 0`,
      params
    );

    const [byStaff] = await pool.query(
      `SELECT COALESCE(c.clark_name, CONCAT('PIN ', o.clerk_pin), 'Unassigned') AS name,
              COUNT(DISTINCT o.id)                     AS count,
              SUM(COALESCE(o.discount_minor, 0))       AS total_minor
         FROM epos_orders o
         LEFT JOIN bo_clarks c
                ON c.pin_code = o.clerk_pin AND c.email = o.email
        WHERE ${where} AND COALESCE(o.discount_minor, 0) > 0
        GROUP BY name
        ORDER BY total_minor DESC`,
      params
    );

    const asRows = (rows) =>
      rows.map((r) => ({
        name: r.name,
        count: Number(r.count) || 0,
        total_minor: Math.round(Number(r.total_minor) || 0),
      }));

    const lineRows = asRows(byName);
    const billRows = asRows(billLevel).filter((r) => r.count > 0);
    const givenAway =
      lineRows.reduce((n, r) => n + r.total_minor, 0) +
      billRows.reduce((n, r) => n + r.total_minor, 0);

    const columns = [
      col('name', 'Discount'),
      col('count', 'Times', 'number'),
      col('total_minor', 'Amount', 'money'),
    ];

    return {
      ...head('discounts', 'Discount Report', office, siteName, from, to),
      highlights: [
        {
          label: 'Given away',
          value: grouped(money(givenAway)),
          minor: givenAway,
          hint: 'Every reduction in the window',
        },
        {
          label: 'Discounted lines',
          value: grouped(String(lineRows.reduce((n, r) => n + r.count, 0))),
          hint: 'Lines carrying a reduction',
        },
      ],
      sections: [
        section('By Discount', columns, lineRows),
        section(
          'Whole-bill Discounts',
          [col('name', 'Kind'), ...columns.slice(1)],
          billRows.map((r) => ({ ...r, name: 'Applied to the bill' }))
        ),
        section(
          'By Staff Member',
          [col('name', 'Staff'), col('count', 'Bills', 'number'), col('total_minor', 'Amount', 'money')],
          asRows(byStaff)
        ),
      ],
    };
  }

  // -------------------------------------------------------------------------
  // Customer loyalty spending
  // -------------------------------------------------------------------------

  /**
   * What members spend, and what the scheme costs to run.
   *
   * Only bills with a customer on them. A venue's takings are mostly anonymous
   * and folding those into a loyalty report would bury the members in them —
   * the question here is "what are the people in the scheme worth", not "what
   * did we take".
   *
   * Points earned and redeemed come from the loyalty ledger rather than being
   * inferred from spend: a manual adjustment, a goodwill award or an expiry all
   * move a balance without a sale, and a report that recomputed from the sales
   * would disagree with the customer's own card.
   */
  async function loyaltySpending({ pool, office, from, to, siteName, terminal }) {
    const { where, params } = win({ office, from, to, terminal });

    const [rows] = await pool.query(
      `SELECT COALESCE(NULLIF(TRIM(cu.name), ''), 'Member') AS name,
              cu.member_no                       AS member_no,
              COALESCE(cu.tier_name, '')         AS tier,
              COUNT(DISTINCT o.id)               AS count,
              SUM(o.total_minor)                 AS total_minor,
              SUM(COALESCE(o.discount_minor, 0)) AS discount_minor,
              SUM(COALESCE(o.covers, 0))         AS covers
         FROM epos_orders o
         JOIN epos_customers cu
              ON cu.id = o.customer_id AND cu.email_key = o.email
        WHERE ${where}
        GROUP BY cu.id, name, cu.member_no, tier
        ORDER BY total_minor DESC`,
      params
    );

    // The ledger, over the same window. `office` is its own column here and not
    // a join through the order — points move without a sale.
    const [[points]] = await pool.query(
      `SELECT COALESCE(SUM(CASE WHEN points > 0 THEN points ELSE 0 END), 0) AS earned,
              COALESCE(SUM(CASE WHEN points < 0 THEN -points ELSE 0 END), 0) AS redeemed,
              COALESCE(SUM(CASE WHEN points < 0 THEN COALESCE(value_minor, 0) ELSE 0 END), 0) AS redeemed_minor
         FROM epos_loyalty_txns
        WHERE office = ? AND created_at BETWEEN ? AND ?`,
      [office, sqlDateTime(from), sqlDateTime(to)]
    );

    const members = rows.map((r) => {
      const total = Math.round(Number(r.total_minor) || 0);
      const count = Number(r.count) || 0;
      return {
        name: r.member_no ? `${r.name} (#${r.member_no})` : r.name,
        tier: r.tier || '—',
        count,
        total_minor: total,
        discount_minor: Math.round(Number(r.discount_minor) || 0),
        // Per visit, because "spends more" and "comes more often" are two
        // different customers and a venue treats them differently.
        average_minor: count > 0 ? Math.round(total / count) : 0,
      };
    });

    const spend = members.reduce((n, m) => n + m.total_minor, 0);
    const visits = members.reduce((n, m) => n + m.count, 0);

    const byTier = new Map();
    for (const m of members) {
      const row = byTier.get(m.tier) ?? {
        name: m.tier,
        members: 0,
        count: 0,
        total_minor: 0,
      };
      row.members += 1;
      row.count += m.count;
      row.total_minor += m.total_minor;
      byTier.set(m.tier, row);
    }

    return {
      ...head('loyalty_spending', 'Customer Loyalty Spending', office, siteName, from, to),
      highlights: [
        {
          label: 'Member spend',
          value: grouped(money(spend)),
          minor: spend,
          hint: 'Bills with a member on them',
        },
        {
          label: 'Members',
          value: grouped(String(members.length)),
          hint: 'Who visited in the window',
        },
        {
          label: 'Average visit',
          value: grouped(money(visits > 0 ? Math.round(spend / visits) : 0)),
          minor: visits > 0 ? Math.round(spend / visits) : 0,
          hint: `Across ${visits} visit${visits === 1 ? '' : 's'}`,
        },
        {
          label: 'Points redeemed',
          value: grouped(money(Math.round(Number(points.redeemed_minor) || 0))),
          minor: Math.round(Number(points.redeemed_minor) || 0),
          hint: `${Number(points.redeemed) || 0} points, against ${Number(points.earned) || 0} earned`,
        },
      ],
      sections: [
        section(
          'Members',
          [
            col('name', 'Member'),
            col('tier', 'Tier'),
            col('count', 'Visits', 'number'),
            col('total_minor', 'Spend', 'money'),
            col('average_minor', 'Average Visit', 'money'),
            col('discount_minor', 'Discount', 'money'),
          ],
          members
        ),
        section(
          'By Tier',
          [
            col('name', 'Tier'),
            col('members', 'Members', 'number'),
            col('count', 'Visits', 'number'),
            col('total_minor', 'Spend', 'money'),
          ],
          [...byTier.values()].sort((a, b) => b.total_minor - a.total_minor)
        ),
        section(
          'Points',
          [col('name', 'Movement'), col('count', 'Points', 'number'), col('total_minor', 'Value', 'money')],
          [
            {
              name: 'Earned',
              count: Number(points.earned) || 0,
              total_minor: 0,
            },
            {
              name: 'Redeemed',
              count: Number(points.redeemed) || 0,
              total_minor: Math.round(Number(points.redeemed_minor) || 0),
            },
          ]
        ),
      ],
    };
  }

  // -------------------------------------------------------------------------
  // Voids and cancels
  // -------------------------------------------------------------------------

  /**
   * What was taken back off a bill, by whom, and why.
   *
   * Read from `epos_void_log` and not from the sales, because a voided line
   * leaves no trace in the sales — that is what voiding it means. The log is
   * the only record there is, which is also why it carries the item summary:
   * two voids of £4.50 could be a mis-keyed coffee or a bottle of wine walking
   * out of the door, and an amount alone cannot tell a manager which.
   *
   * Not windowed by `o.closed_at` like the others: a void happens to a bill
   * that may never be closed at all — a cancelled check is precisely that — so
   * the window is the void's own timestamp. A report that could only show voids
   * on bills that were later paid for would miss the ones worth looking at.
   */
  async function voidsAndCancels({ pool, office, from, to, siteName, terminal }) {
    const params = [office, sqlDateTime(from), sqlDateTime(to)];
    let where = 'v.email = ? AND v.voided_at BETWEEN ? AND ?';
    if (terminal === UNKNOWN_TERMINAL) {
      where += " AND (v.terminal IS NULL OR v.terminal = '')";
    } else if (terminal) {
      where += ' AND v.terminal = ?';
      params.push(terminal);
    }

    const [byReason] = await pool.query(
      `SELECT COALESCE(NULLIF(TRIM(v.reason), ''), 'No reason given') AS name,
              COUNT(*) AS count,
              SUM(COALESCE(v.amount_minor, 0)) AS total_minor
         FROM epos_void_log v
        WHERE ${where}
        GROUP BY name
        ORDER BY total_minor DESC`,
      params
    );

    const [byStaff] = await pool.query(
      `SELECT COALESCE(c.clark_name, CONCAT('PIN ', v.clerk_pin), 'Unassigned') AS name,
              COUNT(*) AS count,
              SUM(COALESCE(v.amount_minor, 0)) AS total_minor
         FROM epos_void_log v
         LEFT JOIN bo_clarks c
                ON c.pin_code = v.clerk_pin AND c.email = v.email
        WHERE ${where}
        GROUP BY name
        ORDER BY total_minor DESC`,
      params
    );

    const [byScope] = await pool.query(
      `SELECT CASE WHEN COALESCE(v.scope, 'sale') = 'sale' THEN 'Cancelled check'
                   ELSE 'Voided lines' END AS name,
              COUNT(*) AS count,
              SUM(COALESCE(v.amount_minor, 0)) AS total_minor
         FROM epos_void_log v
        WHERE ${where}
        GROUP BY name
        ORDER BY total_minor DESC`,
      params
    );

    // Every one of them, itemised. The summaries above say how much; this says
    // what, and it is the table a manager reads when a figure looks wrong.
    const [entries] = await pool.query(
      `SELECT v.voided_at AS at,
              COALESCE(c.clark_name, CONCAT('PIN ', v.clerk_pin), 'Unassigned') AS staff,
              COALESCE(NULLIF(TRIM(v.reason), ''), 'No reason given') AS reason,
              COALESCE(NULLIF(TRIM(v.items), ''), '—') AS items,
              CASE WHEN COALESCE(v.scope, 'sale') = 'sale' THEN 'Check' ELSE 'Lines' END AS scope,
              COALESCE(v.amount_minor, 0) AS total_minor
         FROM epos_void_log v
         LEFT JOIN bo_clarks c
                ON c.pin_code = v.clerk_pin AND c.email = v.email
        WHERE ${where}
        ORDER BY v.voided_at DESC
        LIMIT 500`,
      params
    );

    const asRows = (rows) =>
      rows.map((r) => ({
        name: r.name,
        count: Number(r.count) || 0,
        total_minor: Math.round(Number(r.total_minor) || 0),
      }));

    const reasons = asRows(byReason);
    const taken = reasons.reduce((n, r) => n + r.total_minor, 0);
    const times = reasons.reduce((n, r) => n + r.count, 0);

    const summaryColumns = [
      col('name', 'Reason'),
      col('count', 'Times', 'number'),
      col('total_minor', 'Amount', 'money'),
    ];

    return {
      ...head('voids_cancels', 'Voids & Cancels', office, siteName, from, to),
      highlights: [
        {
          label: 'Taken off',
          value: grouped(money(taken)),
          minor: taken,
          hint: 'Voided and cancelled in the window',
        },
        {
          label: 'Times',
          value: grouped(String(times)),
          hint: 'Separate voids recorded',
        },
      ],
      sections: [
        section('By Reason', summaryColumns, reasons),
        section(
          'By Staff Member',
          [col('name', 'Staff'), col('count', 'Times', 'number'), col('total_minor', 'Amount', 'money')],
          asRows(byStaff)
        ),
        section(
          'Lines or Whole Checks',
          [col('name', 'Kind'), col('count', 'Times', 'number'), col('total_minor', 'Amount', 'money')],
          asRows(byScope)
        ),
        section(
          'Every Void',
          [
            col('at', 'When'),
            col('staff', 'Staff'),
            col('scope', 'Kind'),
            col('items', 'Items'),
            col('reason', 'Reason'),
            col('total_minor', 'Amount', 'money'),
          ],
          entries.map((e) => ({
            ...e,
            at: e.at instanceof Date ? e.at.toLocaleString('en-GB') : String(e.at ?? ''),
            total_minor: Math.round(Number(e.total_minor) || 0),
          }))
        ),
      ],
    };
  }

  return {
    product_sales: {
      label: 'Product Sales',
      description:
        'Every product sold in the window with quantity, discount and net, ' +
        'and the same figures rolled up by department.',
      build: productSales,
    },
    discounts: {
      label: 'Discount Report',
      description:
        'Every reduction given away — promotions, manual discounts and ' +
        'whole-bill reductions — and which member of staff gave it.',
      build: discountReport,
    },
    loyalty_spending: {
      label: 'Customer Loyalty Spending',
      description:
        'What members spend and how often they visit, by member and by tier, ' +
        'with the points earned and redeemed against it.',
      build: loyaltySpending,
    },
    voids_cancels: {
      label: 'Voids & Cancels',
      description:
        'What was taken back off a bill, by whom and why — with every ' +
        'individual void itemised.',
      build: voidsAndCancels,
    },
  };
}

module.exports = { reportBuilders, tradingWindow };
