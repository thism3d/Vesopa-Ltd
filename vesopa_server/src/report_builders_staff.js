/**
 * The staff and customer reports: attendance and wages from the time clock,
 * what each clerk sold by sub department, what each customer spent, and the
 * gift card ledger.
 *
 * Wages need one number nobody had before this release: an hourly rate on the
 * member of staff (`bo_clarks.hourly_rate`, schema_till_events.sql). Where it
 * is unset the hours still count and the money is zero, and the report says
 * who has no rate rather than printing a wage bill that is quietly short.
 *
 * Office bound first; joins carry it. As everywhere.
 */

function staffBuilders({ col, section, money, grouped, sqlDateTime, UNKNOWN_TERMINAL, taxWithin }) {
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
  const day = (at) => new Date(at).toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: '2-digit' });
  const hoursOf = (start, end) => Math.max(0, (end - start) / 3600000);

  /** Every shift overlapping the window, clipped to it, with the rate. */
  async function shifts({ pool, office, from, to }) {
    const [rows] = await pool
      .query(
        `SELECT t.id, t.staff_id, t.staff_name, t.clocked_in_at, t.clocked_out_at,
                t.in_terminal, c.hourly_rate
           FROM epos_time_clock t
           LEFT JOIN bo_clarks c ON c.id = t.staff_id AND c.email = ?
          WHERE t.office = ?
            AND t.clocked_in_at <= ?
            AND (t.clocked_out_at IS NULL OR t.clocked_out_at >= ?)
          ORDER BY t.clocked_in_at`,
        [office, office, sqlDateTime(to), sqlDateTime(from)]
      )
      .catch(() => [[]]);
    return rows.map((s) => {
      const start = Math.max(new Date(s.clocked_in_at).getTime(), from.getTime());
      const end = Math.min(s.clocked_out_at ? new Date(s.clocked_out_at).getTime() : Date.now(), to.getTime());
      const hours = hoursOf(start, end);
      const rate = Number(s.hourly_rate);
      return {
        ...s,
        name: s.staff_name || 'Unnamed',
        start,
        end,
        hours,
        rated: Number.isFinite(rate) && rate > 0,
        cost_minor: Number.isFinite(rate) ? Math.round(hours * rate * 100) : 0,
        open: !s.clocked_out_at,
      };
    });
  }

  const unratedNote = (list) => {
    const names = [...new Set(list.filter((s) => !s.rated).map((s) => s.name))];
    return names.length ? ` (no hourly rate set for: ${names.join(', ')})` : '';
  };

  // -------------------------------------------------------------------------
  // Clerk Attendance
  // -------------------------------------------------------------------------

  async function clerkAttendance(args) {
    const list = await shifts(args);
    const byStaff = new Map();
    for (const s of list) {
      if (!byStaff.has(s.name)) byStaff.set(s.name, { name: s.name, shifts: 0, hours: 0, cost_minor: 0 });
      const r = byStaff.get(s.name);
      r.shifts += 1;
      r.hours += s.hours;
      r.cost_minor += s.cost_minor;
    }
    const summary = [...byStaff.values()].map((r) => ({ ...r, hours: Number(r.hours.toFixed(2)) })).sort(byName);
    return {
      ...head('clerk_attendance', 'Clerk Attendance', args.office, args.siteName, args.from, args.to),
      sections: [
        section(
          `Hours by Member of Staff${unratedNote(list)}`,
          [col('name', 'Staff'), col('shifts', 'Shifts', 'number'), col('hours', 'Hours', 'number'), col('cost_minor', 'Wage Cost', 'money')],
          summary
        ),
        section(
          'Every Shift',
          [col('name', 'Staff'), col('in', 'Clocked In'), col('out', 'Clocked Out'), col('terminal', 'Terminal'), col('hours', 'Hours', 'number'), col('cost_minor', 'Wage Cost', 'money')],
          list.map((s) => ({
            name: s.name,
            in: stamp(s.clocked_in_at),
            out: s.open ? 'Still on the clock' : stamp(s.clocked_out_at),
            terminal: s.in_terminal || '',
            hours: Number(s.hours.toFixed(2)),
            cost_minor: s.cost_minor,
          }))
        ),
      ],
    };
  }

  // -------------------------------------------------------------------------
  // Wage Percentage -- labour against sales, by day
  // -------------------------------------------------------------------------

  async function wagePercentage(args) {
    const { pool, office, from, to, terminal } = args;
    const list = await shifts(args);
    const params = [office, sqlDateTime(from), sqlDateTime(to)];
    let where = 'o.email = ? AND o.closed_at BETWEEN ? AND ?';
    if (terminal === UNKNOWN_TERMINAL) where += " AND (o.terminal IS NULL OR o.terminal = '')";
    else if (terminal) {
      where += ' AND o.terminal = ?';
      params.push(terminal);
    }
    const [sales] = await pool.query(
      `SELECT DATE(o.closed_at) AS d, COALESCE(SUM(o.total_minor), 0) AS total_minor
         FROM epos_orders o WHERE ${where} GROUP BY DATE(o.closed_at)`,
      params
    );
    const days = new Map();
    const dayKey = (t) => {
      const d = new Date(t);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };
    const rowFor = (k) => {
      if (!days.has(k)) days.set(k, { key: k, name: day(`${k}T00:00:00`), sales_minor: 0, hours: 0, cost_minor: 0 });
      return days.get(k);
    };
    for (const s of sales) {
      const k = typeof s.d === 'string' ? s.d.slice(0, 10) : dayKey(s.d);
      rowFor(k).sales_minor += Number(s.total_minor);
    }
    // A shift that crosses midnight is split at it, so each day carries the
    // hours actually worked in it.
    for (const s of list) {
      let cursor = s.start;
      while (cursor < s.end) {
        const next = new Date(cursor);
        next.setHours(24, 0, 0, 0);
        const stop = Math.min(next.getTime(), s.end);
        const h = hoursOf(cursor, stop);
        const r = rowFor(dayKey(cursor));
        r.hours += h;
        r.cost_minor += s.rated ? Math.round(h * Number(s.hourly_rate) * 100) : 0;
        cursor = stop;
      }
    }
    const rows = [...days.values()]
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((r) => ({ ...r, hours: Number(r.hours.toFixed(2)), wage_pct: pct(r.cost_minor, r.sales_minor) }));
    const s = section(
      `Wages against Sales${unratedNote(list)}`,
      [col('name', 'Day'), col('sales_minor', 'Sales', 'money'), col('hours', 'Hours', 'number'), col('cost_minor', 'Wage Cost', 'money'), col('wage_pct', 'Wage %', 'percent')],
      rows
    );
    s.total.wage_pct = pct(s.total.cost_minor, s.total.sales_minor);
    return {
      ...head('wage_percentage', 'Wage Percentage', args.office, args.siteName, args.from, args.to),
      highlights: [
        { key: 'sales', label: 'Sales', value: grouped(money(s.total.sales_minor)), minor: s.total.sales_minor, hint: 'In the window' },
        { key: 'wages', label: 'Wages', value: grouped(money(s.total.cost_minor)), minor: s.total.cost_minor, hint: `${s.total.hours.toFixed(1)} hours` },
        { key: 'pct', label: 'Wage %', value: s.total.wage_pct === null ? '—' : `${s.total.wage_pct.toFixed(2)}%`, hint: 'Wages as a share of sales' },
      ],
      sections: [s],
    };
  }

  // -------------------------------------------------------------------------
  // Clerk Sub Department Sales
  // -------------------------------------------------------------------------

  async function clerkSubDepartmentSales(args) {
    const { pool, office, from, to, terminal, clerk } = args;
    const params = [office, sqlDateTime(from), sqlDateTime(to)];
    let where = 'o.email = ? AND o.closed_at BETWEEN ? AND ?';
    if (terminal === UNKNOWN_TERMINAL) where += " AND (o.terminal IS NULL OR o.terminal = '')";
    else if (terminal) {
      where += ' AND o.terminal = ?';
      params.push(terminal);
    }
    if (clerk) {
      where += ' AND o.clerk_name = ?';
      params.push(clerk);
    }
    const [rows] = await pool.query(
      `SELECT COALESCE(NULLIF(o.clerk_name, ''), 'No clerk recorded') AS clerk,
              COALESCE(NULLIF(TRIM(p.department_name), ''), 'Unassigned') AS department,
              COALESCE(NULLIF(TRIM(p.group_name), ''), 'Unassigned')      AS sub_department,
              SUM(l.quantity) AS count,
              SUM(l.unit_price_minor * l.quantity - COALESCE(l.discount_minor, 0)) AS gross_minor
         FROM epos_order_lines l
         JOIN epos_orders o ON o.id = l.order_id
         LEFT JOIN bo_products p ON p.pluid = l.plu_id AND p.email = o.email
        WHERE ${where} AND COALESCE(l.is_modifier, 0) = 0
        GROUP BY clerk, department, sub_department
        ORDER BY clerk, department, sub_department`,
      params
    );
    const byClerk = new Map();
    for (const r of rows) {
      if (!byClerk.has(r.clerk)) byClerk.set(r.clerk, []);
      byClerk.get(r.clerk).push({ name: `${r.department} — ${r.sub_department}`, count: Number(r.count), gross_minor: Math.round(Number(r.gross_minor)) });
    }
    const columns = [col('name', 'Sub Department'), col('count', '# of Sales', 'number'), col('gross_minor', 'Sales', 'money')];
    const sections = [...byClerk.entries()].map(([who, list]) => section(who, columns, list));
    return {
      ...head('clerk_sub_department_sales', 'Clerk Sub Department Sales', office, args.siteName, from, to),
      sections: sections.length ? sections : [section('Sales', columns, [])],
    };
  }

  // -------------------------------------------------------------------------
  // Customer Transactions
  // -------------------------------------------------------------------------

  async function customerTransactions(args) {
    const { pool, office, from, to, terminal } = args;
    const params = [office, sqlDateTime(from), sqlDateTime(to)];
    let where = 'o.email = ? AND o.closed_at BETWEEN ? AND ? AND o.customer_id IS NOT NULL';
    if (terminal === UNKNOWN_TERMINAL) where += " AND (o.terminal IS NULL OR o.terminal = '')";
    else if (terminal) {
      where += ' AND o.terminal = ?';
      params.push(terminal);
    }
    const [rows] = await pool.query(
      `SELECT o.id, o.closed_at, o.customer_id, o.customer_name, o.total_minor, o.discount_minor,
              o.points_earned, o.points_redeemed, o.points_value_minor, o.terminal, o.clerk_name
         FROM epos_orders o
        WHERE ${where}
        ORDER BY o.customer_name, o.closed_at`,
      params
    );
    const byCustomer = new Map();
    for (const r of rows) {
      const name = r.customer_name || `Customer ${String(r.customer_id).slice(0, 8)}`;
      if (!byCustomer.has(name)) byCustomer.set(name, { name, visits: 0, spend_minor: 0, discount_minor: 0, earned: 0, redeemed: 0 });
      const c = byCustomer.get(name);
      c.visits += 1;
      c.spend_minor += Number(r.total_minor) || 0;
      c.discount_minor += Number(r.discount_minor) || 0;
      c.earned += Number(r.points_earned) || 0;
      c.redeemed += Number(r.points_redeemed) || 0;
    }
    return {
      ...head('customer_transactions', 'Customer Transactions', office, args.siteName, from, to),
      sections: [
        section(
          'By Customer',
          [col('name', 'Customer'), col('visits', 'Visits', 'number'), col('spend_minor', 'Spend', 'money'), col('discount_minor', 'Discounts', 'money'), col('earned', 'Points Earned', 'number'), col('redeemed', 'Points Redeemed', 'number')],
          [...byCustomer.values()].sort((a, b) => b.spend_minor - a.spend_minor)
        ),
        section(
          'Every Transaction',
          [col('name', 'When'), col('customer', 'Customer'), col('order', 'Order'), col('clerk', 'Clerk'), col('terminal', 'Terminal'), col('total_minor', 'Total', 'money'), col('points_value_minor', 'Points Used', 'money')],
          rows.map((r) => ({
            name: stamp(r.closed_at),
            customer: r.customer_name || '',
            order: String(r.id).slice(0, 8).toUpperCase(),
            clerk: r.clerk_name || '',
            terminal: r.terminal || '',
            total_minor: Number(r.total_minor) || 0,
            points_value_minor: Number(r.points_value_minor) || 0,
          }))
        ),
      ],
    };
  }

  // -------------------------------------------------------------------------
  // Gift cards
  // -------------------------------------------------------------------------

  async function giftCardReport(args) {
    const { pool, office, from, to } = args;
    const [[issued]] = await pool
      .query(
        `SELECT COUNT(*) AS n, COALESCE(SUM(initial_minor), 0) AS total_minor
           FROM epos_gift_cards WHERE office = ? AND created_at BETWEEN ? AND ?`,
        [office, sqlDateTime(from), sqlDateTime(to)]
      )
      .catch(() => [[{ n: 0, total_minor: 0 }]]);
    const [byKind] = await pool
      .query(
        `SELECT kind, COUNT(*) AS n, COALESCE(SUM(amount_minor), 0) AS total_minor
           FROM epos_gift_card_txns WHERE office = ? AND created_at BETWEEN ? AND ?
          GROUP BY kind ORDER BY kind`,
        [office, sqlDateTime(from), sqlDateTime(to)]
      )
      .catch(() => [[]]);
    const [[outstanding]] = await pool
      .query(
        `SELECT COUNT(*) AS n, COALESCE(SUM(balance_minor), 0) AS total_minor
           FROM epos_gift_cards WHERE office = ? AND status = 'active' AND balance_minor > 0`,
        [office]
      )
      .catch(() => [[{ n: 0, total_minor: 0 }]]);
    const label = { issue: 'Issued', reload: 'Reloaded', redeem: 'Redeemed', refund: 'Refunded', void: 'Voided', adjust: 'Adjusted', hold: 'Held', release: 'Released' };
    const movements = byKind.map((k) => ({ name: label[k.kind] || k.kind, count: Number(k.n), total_minor: Number(k.total_minor) }));
    const summary = section(
      'Summary',
      [col('name', ''), col('count', 'Cards', 'number'), col('total_minor', 'Value', 'money')],
      [
        { name: 'Cards issued in the period', count: Number(issued.n), total_minor: Number(issued.total_minor) },
        { name: 'Outstanding balance on active cards (now)', count: Number(outstanding.n), total_minor: Number(outstanding.total_minor) },
      ]
    );
    summary.total = null;
    return {
      ...head('gift_card_report', 'Gift Card Report', office, args.siteName, from, to),
      highlights: [
        { key: 'issued', label: 'Issued', value: grouped(money(Number(issued.total_minor))), minor: Number(issued.total_minor), hint: `${issued.n} cards in the period` },
        { key: 'liability', label: 'Outstanding', value: grouped(money(Number(outstanding.total_minor))), minor: Number(outstanding.total_minor), hint: `${outstanding.n} active cards with a balance` },
      ],
      sections: [summary, section('Movements in the Period', [col('name', 'Movement'), col('count', 'Count', 'number'), col('total_minor', 'Value', 'money')], movements)],
    };
  }

  async function giftCardTransactions(args) {
    const { pool, office, from, to } = args;
    const [rows] = await pool
      .query(
        `SELECT t.created_at, t.kind, t.amount_minor, t.balance_after, t.clerk_name, t.note, t.order_id,
                c.code, c.recipient_name
           FROM epos_gift_card_txns t
           JOIN epos_gift_cards c ON c.id = t.gift_card_id AND c.office = t.office
          WHERE t.office = ? AND t.created_at BETWEEN ? AND ?
          ORDER BY t.created_at`,
        [office, sqlDateTime(from), sqlDateTime(to)]
      )
      .catch(() => [[]]);
    const s = section(
      'Gift Card Transactions',
      [col('name', 'When'), col('code', 'Card'), col('recipient', 'Recipient'), col('kind', 'Movement'), col('amount_minor', 'Amount', 'money'), col('balance_after', 'Balance After', 'money'), col('clerk', 'Clerk'), col('note', 'Note')],
      rows.map((r) => ({
        name: stamp(r.created_at),
        code: r.code,
        recipient: r.recipient_name || '',
        kind: String(r.kind).replace(/^\w/, (c) => c.toUpperCase()),
        amount_minor: Number(r.amount_minor),
        balance_after: Number(r.balance_after),
        clerk: r.clerk_name || '',
        note: r.note || (r.order_id ? `Order ${String(r.order_id).slice(0, 8).toUpperCase()}` : ''),
      }))
    );
    s.total.balance_after = null;
    return {
      ...head('gift_card_transactions', 'Gift Card Transactions', office, args.siteName, from, to),
      sections: [s],
    };
  }

  const entry = (group, label, description, build, filters = []) => ({ label, group, description, build, filters });

  return {
    clerk_attendance: entry('staff', 'Clerk Attendance', 'Every shift on the time clock in the period, and hours and wage cost by member of staff.', clerkAttendance),
    wage_percentage: entry('staff', 'Wage Percentage', 'Wage cost against sales, day by day, from the time clock and each person’s hourly rate.', wagePercentage),
    clerk_sub_department_sales: entry('staff', 'Clerk Sub Department Sales', 'What each member of staff sold, by sub department.', clerkSubDepartmentSales, ['clerk']),
    customer_transactions: entry('customers', 'Customer Transactions', 'Sales with a customer attached: visits and spend by customer, and every transaction.', customerTransactions),
    gift_card_report: entry('customers', 'Gift Card Report', 'Cards issued in the period, movements by kind, and the balance outstanding on active cards.', giftCardReport),
    gift_card_transactions: entry('customers', 'Gift Card Transactions', 'Every gift card movement in the period, one row each.', giftCardTransactions),
  };
}

module.exports = { staffBuilders };
