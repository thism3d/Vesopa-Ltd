/**
 * Reports: the numbers a venue hands to its accountant.
 *
 * The dashboard already draws charts (see analytics.js) and that is a different
 * job. A chart answers "how are we doing"; a report answers "what exactly did
 * we take between these two dates, broken down so it reconciles". The second
 * one gets printed, emailed, filed, and argued about, so it has properties a
 * chart does not need:
 *
 *   * **It reconciles.** Department sales, sub department sales and payments
 *     all sum to the same figure. If they ever do not, the report is wrong and
 *     somebody's books are wrong with it — so the totals are computed once,
 *     from the same rows, rather than three times from three queries that can
 *     drift.
 *
 *   * **It says what it covers.** Every export carries the site, the exact
 *     start and end of the window, and when it was generated. A PDF of takings
 *     with no dates on it is not evidence of anything.
 *
 *   * **It is exportable.** PDF to file it, CSV to load somewhere else, XLSX to
 *     work on. All three are built from the same in-memory report, so they
 *     cannot disagree.
 *
 * A report is a plain object — `{ name, site, from, to, generatedAt, sections }`
 * — and a section is `{ title, columns, rows, total }`. Everything downstream
 * (the browser, the three exporters, the scheduled email) reads that shape and
 * nothing else, so adding a report means writing one builder rather than
 * touching four renderers.
 */

const fs = require('fs');
const path = require('path');

const express = require('express');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');

const { requireAuth } = require('./auth');
const { reportBuilders } = require('./report_builders');

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

/**
 * The periods a report can cover.
 *
 * `label` is what the back office and the scheduler both show, so the words on
 * the "run it now" dropdown and the words on the schedule are the same words.
 *
 * Every window is aligned to whole days in the venue's own local time, and ends
 * at 23:59:59 rather than at midnight the following morning. That is not
 * pedantry: `closed_at < tomorrow-midnight` and `closed_at <= today-23:59:59`
 * differ by exactly the sales rung up in that one second, and a report that
 * silently disagrees with the Z report by one sale is worse than one that is
 * obviously broken.
 *
 * The week starts on Monday, because this is a UK product and a Sunday-start
 * week puts a Saturday night's trade in the wrong week for every venue that
 * matters.
 */
const RANGES = {
  today: { label: 'Today' },
  yesterday: { label: 'Yesterday' },
  last_7_days: { label: 'Last 7 Days' },
  last_30_days: { label: 'Last 30 Days' },
  this_week: { label: 'This Week' },
  last_week: { label: 'Last Week' },
  this_month: { label: 'This Month' },
  last_month: { label: 'Last Month' },
  this_year: { label: 'This Year' },
  last_year: { label: 'Last Year' },
  custom: { label: 'Custom Range' },
};

/** Midnight at the start of `date`, as a new Date. */
function startOfDay(date) {
  const out = new Date(date);
  out.setHours(0, 0, 0, 0);
  return out;
}

/** 23:59:59.999 on `date`. See the note in [RANGES] about the last second. */
function endOfDay(date) {
  const out = new Date(date);
  out.setHours(23, 59, 59, 999);
  return out;
}

const addDays = (date, days) => {
  const out = new Date(date);
  out.setDate(out.getDate() + days);
  return out;
};

/** Monday of the week `date` falls in. */
function startOfWeek(date) {
  const out = startOfDay(date);
  // getDay() is 0 for Sunday, so Sunday is six days after its Monday rather
  // than one day before the next one.
  const back = (out.getDay() + 6) % 7;
  return addDays(out, -back);
}

/**
 * Turn a period into the two timestamps a query is bounded by.
 *
 * `now` is injectable so the tests are not a hostage to the clock, and so the
 * scheduler can ask "what would Yesterday have meant at the moment this was
 * due" rather than at the moment the job got round to running.
 */
function resolveRange(period, { from, to, now = new Date() } = {}) {
  const today = startOfDay(now);

  switch (period) {
    case 'today':
      return { from: today, to: endOfDay(now) };
    case 'yesterday': {
      const day = addDays(today, -1);
      return { from: day, to: endOfDay(day) };
    }
    case 'last_7_days':
      // Seven whole days ending today, not 168 hours ending now — otherwise
      // the first and last day are part-days and always look like a slump.
      return { from: addDays(today, -6), to: endOfDay(now) };
    case 'last_30_days':
      return { from: addDays(today, -29), to: endOfDay(now) };
    case 'this_week':
      return { from: startOfWeek(now), to: endOfDay(now) };
    case 'last_week': {
      const start = addDays(startOfWeek(now), -7);
      return { from: start, to: endOfDay(addDays(start, 6)) };
    }
    case 'this_month':
      return {
        from: new Date(now.getFullYear(), now.getMonth(), 1),
        to: endOfDay(now),
      };
    case 'last_month': {
      const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      // Day 0 of the following month is the last day of this one, which is the
      // only leap-year-proof way to say it.
      const end = new Date(now.getFullYear(), now.getMonth(), 0);
      return { from: start, to: endOfDay(end) };
    }
    case 'this_year':
      return { from: new Date(now.getFullYear(), 0, 1), to: endOfDay(now) };
    case 'last_year':
      return {
        from: new Date(now.getFullYear() - 1, 0, 1),
        to: endOfDay(new Date(now.getFullYear() - 1, 11, 31)),
      };
    case 'custom': {
      if (!from || !to) return null;
      const start = new Date(from);
      const end = new Date(to);
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
        return null;
      }
      // A range typed backwards is a slip, not a request for no rows.
      return start <= end
        ? { from: startOfDay(start), to: endOfDay(end) }
        : { from: startOfDay(end), to: endOfDay(start) };
    }
    default:
      return null;
  }
}

/** MySQL DATETIME, in local time, which is what `closed_at` is stored in. */
function sqlDateTime(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/** dd/MM/yyyy HH:mm:ss — the format the reference reports print. */
function displayDateTime(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/**
 * Everything is held in pence and formatted once, at the edge.
 *
 * Pounds as floats accumulate error over a few hundred lines, and the place it
 * shows up is the one place it must not: a summary total that is a penny away
 * from the sum of the rows above it.
 */
const money = (minor) =>
  `£${(Math.round(minor) / 100).toFixed(2)}`;

/**
 * The same figure, grouped in thousands, for a headline.
 *
 * Only the headline tiles use it. Inside a table the columns are what a
 * manager reconciles against the till's own Z report line by line, and
 * those two documents have to be the same shape; a tile is read on its own
 * and "£12844.50" is a number nobody takes in at a glance.
 */
const grouped = (text) =>
  String(text).replace(/\d+(?=\.|$)/, (digits) =>
    digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  );

/**
 * The VAT inside a VAT-inclusive amount.
 *
 * UK retail prices include VAT, so the tax is not `amount * rate` — it is the
 * part of the amount that is tax, which is `amount - amount / (1 + rate)`.
 * Getting this the other way round overstates the tax by 20% of itself, and
 * the error is invisible until an accountant checks it.
 */
function taxWithin(minor, percentage) {
  const rate = Number(percentage) || 0;
  if (rate <= 0) return 0;
  return Math.round(minor - minor / (1 + rate / 100));
}

// ---------------------------------------------------------------------------
// Section helpers
// ---------------------------------------------------------------------------

/** A column: `key` reads the row, `label` heads it, `type` formats it. */
const col = (key, label, type = 'text') => ({ key, label, type });

/**
 * The five money columns every sales breakdown carries, in the reference's own
 * order, so a manager comparing the two documents reads down the same columns.
 */
function salesColumns(firstLabel) {
  return [
    col('name', firstLabel),
    col('sales_minor', 'Sales Total', 'money'),
    col('count', '# of Sales', 'number'),
    col('tax_minor', 'Tax £', 'money'),
    col('discount_minor', 'Discount Total', 'money'),
    col('gross_minor', 'Gross Total', 'money'),
    col('net_minor', 'Net Total', 'money'),
  ];
}

/**
 * Sum a set of rows into the Summary Total that closes each table.
 *
 * Summed from the rows that are printed, never re-queried. A total computed
 * separately is a total that can disagree with the column above it, and the
 * whole value of this report is that it reconciles.
 */
function totalOf(rows, columns) {
  const total = { name: 'Summary Total' };
  for (const column of columns) {
    if (column.type !== 'money' && column.type !== 'number') continue;
    total[column.key] = rows.reduce(
      (sum, row) => sum + (Number(row[column.key]) || 0),
      0
    );
  }
  return total;
}

const section = (title, columns, rows) => ({
  title,
  columns,
  rows,
  total: totalOf(rows, columns),
});

// ---------------------------------------------------------------------------
// The Financial Summary
// ---------------------------------------------------------------------------

/**
 * The filter value meaning "sales with no terminal recorded".
 *
 * Every sale taken before the till learned to send its name has NULL here, and
 * there is no way to work out after the fact which machine rang it up. They are
 * still takings and must stay reachable, so they get a name of their own rather
 * than being unreachable or, worse, silently folded into whichever terminal
 * happens to sort first.
 */
const UNKNOWN_TERMINAL = '__unknown__';

/**
 * The terminals that actually appear in a venue's sales, for the filter's list.
 *
 * Read from the ledger rather than from bo_devices on purpose: this list has to
 * offer exactly the values that will match something. A till that was
 * decommissioned last year still has sales in the window and must be
 * selectable; a brand new one that has taken nothing yet would only be an empty
 * report.
 */
async function terminalsInUse({ pool, office }) {
  const [rows] = await pool
    .query(
      `SELECT o.terminal AS terminal, COUNT(*) AS sales
         FROM epos_orders o
        WHERE o.email = ?
        GROUP BY o.terminal
        ORDER BY o.terminal IS NULL, o.terminal`,
      [office]
    )
    .catch(() => [[]]);

  const named = [];
  let unknown = 0;
  for (const row of rows) {
    const name = (row.terminal || '').trim();
    if (name) named.push({ value: name, label: name, sales: Number(row.sales) });
    else unknown += Number(row.sales);
  }

  // Only offered when there is actually something behind it, so a venue that
  // has only ever run tills on this release never sees a puzzling extra entry.
  if (unknown > 0) {
    named.push({
      value: UNKNOWN_TERMINAL,
      label: 'Unknown terminal',
      sales: unknown,
    });
  }
  return named;
}

/**
 * Sales broken down by department and sub department, with everything around
 * them that has to reconcile against it.
 *
 * Built from `epos_order_lines` joined to the catalogue for its department
 * names, because the line is where the money is and the order is only where it
 * is grouped. Two consequences worth stating:
 *
 *   * A line whose product has since been deleted still appears, under
 *     "Unassigned". Dropping it would make the report stop agreeing with the
 *     payments, which is the one thing it must never do.
 *
 *   * The department comes from the catalogue *now*, not from what it was when
 *     the sale happened — the line does not record it. Moving a product between
 *     departments therefore restates history. That is the behaviour the till's
 *     own Z report has always had, and matching it is worth more than being
 *     differently right.
 */
async function financialSummary({ pool, office, from, to, siteName, terminal }) {
  const params = [office, sqlDateTime(from), sqlDateTime(to)];
  let window = 'o.email = ? AND o.closed_at BETWEEN ? AND ?';

  // One terminal, or all of them.
  //
  // `terminal` is the till's own name, the same string that prints on the
  // receipt -- so a manager holding a receipt and reading this report is
  // matching one name, not reconciling two.
  //
  // The magic value `__unknown__` selects sales with no terminal recorded at
  // all. Those are real takings from before the till learned to send its name,
  // and a filter that could not reach them would quietly hide money. It is a
  // sentinel rather than an empty string because an empty string is what an
  // unfiltered request sends, and the two mean opposite things.
  if (terminal === UNKNOWN_TERMINAL) {
    window += " AND (o.terminal IS NULL OR o.terminal = '')";
  } else if (terminal) {
    window += ' AND o.terminal = ?';
    params.push(terminal);
  }

  // One pass over the lines. Department and sub department are two groupings
  // of the same rows, so they are fetched together and grouped in JS — which
  // is what guarantees the two tables add up to each other.
  const [lines] = await pool.query(
    `SELECT COALESCE(NULLIF(TRIM(p.department_name), ''), 'Unassigned') AS department,
            COALESCE(NULLIF(TRIM(p.group_name), ''), 'Unassigned')      AS sub_department,
            l.quantity          AS quantity,
            l.unit_price_minor  AS unit_price_minor,
            l.tax_percentage    AS tax_percentage,
            COALESCE(l.discount_minor, 0) AS discount_minor
       FROM epos_order_lines l
       JOIN epos_orders o ON o.id = l.order_id
       LEFT JOIN bo_products p ON p.pluid = l.plu_id AND p.email = o.email
      WHERE ${window}`,
    params
  );

  const byDepartment = new Map();
  const bySubDepartment = new Map();

  const bucket = (map, key) => {
    if (!map.has(key)) {
      map.set(key, {
        name: key,
        sales_minor: 0,
        count: 0,
        tax_minor: 0,
        discount_minor: 0,
        gross_minor: 0,
        net_minor: 0,
      });
    }
    return map.get(key);
  };

  for (const line of lines) {
    const quantity = Number(line.quantity) || 0;
    const sales = Math.round(quantity * Number(line.unit_price_minor || 0));
    const discount = Number(line.discount_minor) || 0;
    const gross = sales - discount;
    const tax = taxWithin(gross, line.tax_percentage);

    for (const entry of [
      bucket(byDepartment, line.department),
      bucket(bySubDepartment, line.sub_department),
    ]) {
      entry.sales_minor += sales;
      entry.count += quantity;
      entry.discount_minor += discount;
      entry.gross_minor += gross;
      entry.tax_minor += tax;
      entry.net_minor += gross - tax;
    }
  }

  const byName = (a, b) => a.name.localeCompare(b.name);
  const departments = [...byDepartment.values()].sort(byName);
  const subDepartments = [...bySubDepartment.values()].sort(byName);

  // ---- The order-level money -------------------------------------------
  const [generalRowsRaw] = await pool.query(
    `SELECT COUNT(*)                                          AS bills,
            COALESCE(SUM(o.covers), 0)                        AS covers,
            COALESCE(SUM(o.total_minor), 0)                   AS total_minor,
            COALESCE(SUM(o.gratuity_minor), 0)                AS gratuity_minor,
            COALESCE(SUM(o.gratuity_minor > 0), 0)            AS gratuity_count,
            COALESCE(SUM(o.service_minor), 0)                 AS service_minor,
            COALESCE(SUM(o.service_minor > 0), 0)             AS service_count,
            COALESCE(SUM(o.voucher_minor), 0)                 AS voucher_minor,
            COALESCE(SUM(o.voucher_minor > 0), 0)             AS voucher_count,
            COALESCE(SUM(o.points_value_minor), 0)            AS points_minor,
            COALESCE(SUM(o.points_value_minor > 0), 0)        AS points_count,
            COALESCE(SUM(o.promo_minor), 0)                   AS promo_minor,
            COALESCE(SUM(o.promo_minor > 0), 0)               AS promo_count
       FROM epos_orders o
      WHERE ${window}`,
    params
  );
  // An aggregate always returns its one row in production; guarded anyway,
  // because "no rows" here would otherwise be a TypeError deep inside the
  // report rather than a period with nothing in it.
  const general = generalRowsRaw[0] || {};

  // Gift cards issued or reloaded in the window — money taken that is not a
  // sale of anything, which is exactly why the reference gives it its own line
  // rather than folding it into takings.
  //
  // Guarded twice over: an installation that has never had the commerce
  // migration applied has no such table at all, and a gift card is not worth
  // failing a whole financial summary over.
  const [topupRows] = await pool
    .query(
      `SELECT COUNT(*) AS count, COALESCE(SUM(ABS(t.amount_minor)), 0) AS total_minor
         FROM epos_gift_card_txns t
        WHERE t.office = ?
          AND t.kind IN ('issue', 'reload')
          AND t.created_at BETWEEN ? AND ?`,
      params
    )
    .catch(() => [[]]);
  const topups = topupRows[0] || { count: 0, total_minor: 0 };

  const generalRows = [
    { name: 'Gratuities', count: Number(general.gratuity_count), total_minor: Number(general.gratuity_minor) },
    // Not recorded by the till: it takes no cashback and does no cash
    // rounding. Printed as zero rather than omitted so the report keeps the
    // shape a manager is used to reading, and so the day either is added the
    // line is already where they expect it.
    { name: 'Cashback', count: 0, total_minor: 0 },
    { name: 'Service Charges', count: Number(general.service_count), total_minor: Number(general.service_minor) },
    { name: 'Gift Card Topup', count: Number(topups.count), total_minor: Number(topups.total_minor) },
    { name: 'Cash Rounding', count: 0, total_minor: 0 },
  ];

  // ---- Discounts that are not a line's own ------------------------------
  const [promotions] = await pool.query(
    `SELECT COALESCE(NULLIF(TRIM(l.promotion_name), ''), 'Promotion') AS name,
            COUNT(*)                                AS count,
            COALESCE(SUM(l.discount_minor), 0)      AS total_minor
       FROM epos_order_lines l
       JOIN epos_orders o ON o.id = l.order_id
      WHERE ${window} AND COALESCE(l.discount_minor, 0) > 0
      GROUP BY name
      ORDER BY name`,
    params
  );

  const discountRows = [
    ...promotions.map((row) => ({
      name: row.name,
      count: Number(row.count),
      total_minor: Number(row.total_minor),
    })),
  ];
  // Bill-level reductions, which do not belong to any one line.
  for (const [name, count, minor] of [
    ['Vouchers', general.voucher_count, general.voucher_minor],
    ['Points redeemed', general.points_count, general.points_minor],
  ]) {
    if (Number(minor) > 0) {
      discountRows.push({
        name,
        count: Number(count),
        total_minor: Number(minor),
      });
    }
  }

  // ---- Payments ---------------------------------------------------------
  const [payments] = await pool.query(
    `SELECT pay.method                              AS method,
            COUNT(*)                                AS count,
            COALESCE(SUM(pay.amount_minor), 0)      AS total_minor
       FROM epos_payments pay
       JOIN epos_orders o ON o.id = pay.order_id
      WHERE ${window}
      GROUP BY pay.method
      ORDER BY pay.method`,
    params
  );

  const paymentRows = payments.map((row) => ({
    // "card" is what the till stores; "Card" is what a report prints.
    name: String(row.method || 'Unknown').replace(/(^|\s)\w/g, (c) => c.toUpperCase()),
    count: Number(row.count),
    total_minor: Number(row.total_minor),
  }));

  const covers = Number(general.covers) || 0;
  const takings = Number(general.total_minor) || 0;

  // ---- The six figures that go at the top --------------------------------
  //
  // Every one of them is summed from rows that are printed further down, never
  // re-queried, for the same reason the Summary Total is: a headline that
  // disagrees with the table under it is worse than no headline at all.
  //
  // They are carried on the report rather than computed by each renderer, so
  // the tiles in the browser, the tiles on the PDF and the cover sheet of the
  // spreadsheet cannot drift apart.
  const bills = Number(general.bills) || 0;
  const taxTotal = departments.reduce((sum, d) => sum + d.tax_minor, 0);
  const discountTotal =
    discountRows.reduce((sum, d) => sum + d.total_minor, 0);

  const highlights = [
    {
      key: 'takings',
      label: 'Takings',
      value: grouped(money(takings)),
      minor: takings,
      hint: 'Everything banked in the window',
    },
    {
      key: 'bills',
      label: 'Bills',
      value: grouped(String(bills)),
      hint: 'Closed transactions',
    },
    {
      key: 'covers',
      label: 'Covers',
      value: grouped(String(covers)),
      hint: covers ? 'Guests served' : 'Not counted on this till',
    },
    {
      key: 'average',
      label: 'Average spend',
      // Per head where covers are counted, per bill where they are not. A
      // counter till records no covers, and an average of "£0.00" there reads
      // as a quiet trading day rather than as a figure that does not apply.
      value: grouped(
        money(
          covers > 0
            ? Math.round(takings / covers)
            : bills > 0
              ? Math.round(takings / bills)
              : 0
        )
      ),
      hint: covers > 0 ? 'Per head' : 'Per bill',
    },
    {
      key: 'discounts',
      label: 'Discounts',
      value: grouped(money(discountTotal)),
      minor: discountTotal,
      hint: 'Given away in the window',
    },
    {
      key: 'tax',
      label: 'Tax',
      value: grouped(money(taxTotal)),
      minor: taxTotal,
      hint: 'Included in the takings',
    },
  ];

  return {
    key: 'financial_summary',
    name: 'Financial Summary',
    site: siteName || office,
    from,
    to,
    generatedAt: new Date(),
    highlights,
    sections: [
      section('Department Sales', salesColumns('Department'), departments),
      section('Sub Department Sales', salesColumns('Sub Department'), subDepartments),
      section(
        'General',
        [col('name', 'Name'), col('count', 'Count', 'number'), col('total_minor', 'Total £', 'money')],
        generalRows
      ),
      section(
        'Other Discounts',
        [col('name', 'Discount'), col('count', 'Discount Sales', 'number'), col('total_minor', 'Discount Amount', 'money')],
        discountRows
      ),
      // No expenses feature exists yet. The section is kept because the
      // reference has it and its absence reads as a missing number rather than
      // as a feature this till does not have.
      section(
        'Expenses',
        [col('name', 'Name'), col('count', 'Count', 'number'), col('total_minor', 'Total £', 'money')],
        []
      ),
      {
        title: 'Spend Per Head',
        columns: [col('covers', '# of Covers', 'number'), col('average_minor', 'Average Spend', 'money')],
        rows: [
          {
            covers,
            // Guarded, because a counter till records no covers at all and
            // dividing by it is how a report prints "Infinity" at an
            // accountant.
            average_minor: covers > 0 ? Math.round(takings / covers) : 0,
          },
        ],
        // A single-row section has nothing to total; a Summary Total under one
        // row is noise.
        total: null,
      },
      section(
        'Payment Methods',
        [col('name', 'Payment Type'), col('count', '# of Payments', 'number'), col('total_minor', 'Total £', 'money')],
        paymentRows
      ),
    ],
  };
}

/**
 * Every report a venue can run.
 *
 * One entry, one builder, one name. The scheduler stores the key, so renaming a
 * report's label never breaks a schedule somebody set up months ago.
 */
const REPORTS = {
  financial_summary: {
    label: 'Financial Summary',
    description:
      'Sales by department and sub department, with discounts, payments and ' +
      'spend per head — everything that has to reconcile against the takings.',
    build: financialSummary,
  },
  // The four the venue asked for, in src/report_builders.js. They are handed
  // this file's `col`, `section`, `money` and `grouped` rather than importing
  // them back, so there is one definition of what a column is and what a
  // Summary Total means — a second copy is a copy that drifts, and two reports
  // whose totals are computed differently is exactly the fault this whole
  // module's opening note exists to prevent.
  ...reportBuilders({
    col,
    section,
    money,
    grouped,
    sqlDateTime,
    UNKNOWN_TERMINAL,
  }),
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/** A cell as it should read on paper. */
function formatCell(row, column) {
  const value = row[column.key];
  if (column.type === 'money') return money(Number(value) || 0);
  if (column.type === 'number') {
    const number = Number(value) || 0;
    // Quantities can be fractional — half a kilo of something — but almost
    // never are, and "215.00" in a column of counts reads as an error.
    return Number.isInteger(number) ? String(number) : number.toFixed(2);
  }
  return value === null || value === undefined ? '' : String(value);
}

/** The header block every export repeats, as label/value pairs. */
function reportHeader(report) {
  return [
    ['Report Name', report.name],
    ['Site Name', report.site],
    ['Report Generated Date', displayDateTime(report.generatedAt)],
    ['Report Start Date', displayDateTime(report.from)],
    ['Report End Date', displayDateTime(report.to)],
    // Always printed, including when it says All. A report filtered to one till
    // and one covering the whole venue look identical on paper otherwise, and
    // that is exactly the confusion that gets a manager shouting at the wrong
    // member of staff.
    ['Terminal', report.terminalLabel || 'All terminals'],
  ];
}

/**
 * CSV.
 *
 * One file with every section in it, separated by a blank line and its title,
 * because a venue loading this into a spreadsheet wants the whole report and
 * not seven downloads. Quoting is unconditional: a department called
 * "Wines, Spirits" is exactly the row that breaks a naive writer.
 */
function toCsv(report) {
  const quote = (value) => `"${String(value).replace(/"/g, '""')}"`;
  const out = [];

  for (const [label, value] of reportHeader(report)) {
    out.push(`${quote(label)},${quote(value)}`);
  }

  for (const part of report.sections) {
    out.push('');
    out.push(quote(part.title));
    out.push(part.columns.map((c) => quote(c.label)).join(','));
    for (const row of part.rows) {
      out.push(part.columns.map((c) => quote(formatCell(row, c))).join(','));
    }
    if (part.total) {
      out.push(part.columns.map((c) => quote(formatCell(part.total, c))).join(','));
    }
  }

  // A BOM, so Excel opens it as UTF-8 and the pound signs are pound signs
  // rather than "Â£". Without it every money column in this file is wrong in
  // the one application it is most likely to be opened in.
  return Buffer.from(`﻿${out.join('\r\n')}\r\n`, 'utf8');
}

/** XLSX: one sheet per section, plus the header block on its own. */
async function toXlsx(report) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Vesopa EPOS';
  workbook.created = report.generatedAt;

  const cover = workbook.addWorksheet('Report');
  cover.getColumn(1).width = 26;
  cover.getColumn(2).width = 44;

  // The brand, once, at the top. A spreadsheet is the export most likely to be
  // forwarded on its own, and the one format where the sender is otherwise
  // nowhere on the page.
  const banner = cover.addRow(['VESOPA EPOS', report.name]);
  banner.font = { bold: true, size: 12, color: { argb: 'FF10130A' } };
  banner.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFA5C715' } };
  });
  cover.addRow([]);

  for (const [label, value] of reportHeader(report)) {
    const row = cover.addRow([label, value]);
    row.getCell(1).font = { bold: true };
  }

  // The same six figures the PDF puts on tiles and the browser puts on cards,
  // from the same array, so a manager reading one export and an accountant
  // reading another are quoting the same numbers at each other.
  if (report.highlights && report.highlights.length) {
    cover.addRow([]);
    cover.addRow(['Headline figures']).font = { bold: true };
    for (const item of report.highlights) {
      const row = cover.addRow([item.label, item.value]);
      row.getCell(1).font = { bold: true };
    }
  }

  for (const part of report.sections) {
    // Excel refuses a sheet name over 31 characters or containing []:*?/\ —
    // and refuses the whole workbook, not just the sheet, so this is trimmed
    // rather than left to chance.
    const name = part.title.replace(/[[\]:*?/\\]/g, ' ').slice(0, 31);
    const sheet = workbook.addWorksheet(name);
    sheet.columns = part.columns.map((column) => ({
      header: column.label,
      key: column.key,
      width: column.type === 'text' ? 28 : 16,
    }));
    sheet.getRow(1).font = { bold: true };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];

    const write = (row, bold) => {
      const added = sheet.addRow(
        Object.fromEntries(
          part.columns.map((column) => [
            column.key,
            // Money goes in as pounds, as a number, so the cell can be summed
            // and reformatted in Excel. A string like "£4.60" is a label, not
            // a figure, and a venue's first act is always to sum the column.
            column.type === 'money'
              ? Math.round(Number(row[column.key]) || 0) / 100
              : column.type === 'number'
                ? Number(row[column.key]) || 0
                : row[column.key] ?? '',
          ])
        )
      );
      if (bold) added.font = { bold: true };
      for (const column of part.columns) {
        if (column.type === 'money') {
          added.getCell(column.key).numFmt = '£#,##0.00';
        }
      }
      return added;
    };

    for (const row of part.rows) write(row, false);
    if (part.total) write(part.total, true);
  }

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

// ---------------------------------------------------------------------------
// Brand
// ---------------------------------------------------------------------------

/**
 * The palette every exported document is drawn in.
 *
 * Not approximations: the lime is the tail of the "V" in the mark (#A5C715) and
 * the graphite is its body (#6B6B6A), both read off the brand artwork. The back
 * office holds the same colours as CSS custom properties in public/style.css —
 * changing one here without changing the other is how a PDF stops looking like
 * the screen it was run from.
 *
 * Lime is a light colour: white type on it lands near 1.9:1. So anything
 * sitting ON the lime uses `ink`, and lime-coloured *text* on white uses
 * `limeDeep`.
 */
const BRAND = {
  lime: '#a5c715',
  limeSoft: '#f1f7dc',
  limeDeep: '#6e8a0e',
  onLimeMuted: '#4a5a10',
  night: '#111111',
  ink: '#17141c',
  graphite: '#6b6b6a',
  muted: '#7c7a85',
  line: '#e6e3ea',
  wash: '#f7f8f3',
  zebra: '#fafaf7',
  onNight: '#ffffff',
  dim: '#b8bcb0',
};

/**
 * The wordmark, read from disk once and kept.
 *
 * `null` when the file is not there, and every caller checks: a report is the
 * document a venue's accountant is waiting for, and it has to keep exporting
 * from a checkout, container or test run where public/assets was never copied.
 * The fallback is the word set in lime, which is still recognisably ours.
 */
let logoBuffer;
function brandLogo() {
  if (logoBuffer === undefined) {
    try {
      logoBuffer = fs.readFileSync(
        path.join(__dirname, '..', 'public', 'assets', 'vesopa_logo_on_dark.png')
      );
    } catch {
      logoBuffer = null;
    }
  }
  return logoBuffer;
}

/**
 * PDF.
 *
 * The one export that gets printed, filed and handed across a desk, so it is
 * the one that has to look like it came from us. It is drawn rather than
 * flowed: a dark brand band, the headline figures as tiles, then the same
 * sections every other format carries, in a table with a lime header and a
 * solid total bar.
 *
 * Laid out by hand rather than through a table library, because the layout is
 * simple and the failure mode of a library here is a column that silently
 * overflows the page on the one venue with a long department name. Every row
 * asks whether it fits before it draws, and a table that runs on repeats its
 * own title and column headings at the top of the next page — a page of
 * figures with nothing saying what the columns are is a page nobody can read.
 *
 * Helvetica is WinAnsi-encoded, which draws "£" correctly — unlike the till's
 * thermal printers, where the same character needed a whole setting.
 */
function toPdf(report) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 40,
      // Held open so the footer can say "2 / 6". The count is not knowable
      // until the last row has been drawn, and a report whose pages are not
      // numbered is a report somebody hands over with a page missing.
      bufferPages: true,
      info: {
        Title: `${report.name} — ${report.site}`,
        Author: 'Vesopa EPOS',
        Creator: 'Vesopa EPOS',
      },
    });

    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const width = right - left;
    // The lowest a row may start. The bottom margin belongs to the footer, and
    // a total bar printed over the page number is the sort of thing that only
    // ever shows up on the venue with nine departments.
    const floor = doc.page.height - doc.page.margins.bottom - 26;

    const logo = brandLogo();
    const PAD = 8;

    // The cursor is ours, not pdfkit's. Every block below places itself
    // absolutely, so `doc.y` — which moves whenever anything is written — is
    // not something the layout can be allowed to depend on.
    let y = 0;

    /**
     * One line of text, clipped rather than wrapped.
     *
     * The clipping is measured here rather than left to pdfkit's own
     * `ellipsis`, which wraps anyway: a venue called Pontardawe Rugby
     * Football Club came out on two lines and through the bottom of its own
     * cell. Measure, cut, and the box is always the box.
     */
    function fit(text, maxWidth) {
      let value = String(text);
      if (!maxWidth || doc.widthOfString(value) <= maxWidth) return value;
      while (value.length > 1 && doc.widthOfString(`${value}…`) > maxWidth) {
        value = value.slice(0, -1);
      }
      return `${value.trimEnd()}…`;
    }

    const put = (text, x, top, options = {}) =>
      doc.text(fit(text, options.width), x, top, {
        lineBreak: false,
        ...options,
      });

    // ---- Page furniture --------------------------------------------------

    /** The band the report opens with: the mark, the name, the site. */
    function coverBand() {
      const height = 116;
      doc.rect(0, 0, doc.page.width, height).fill(BRAND.night);
      doc.rect(0, height, doc.page.width, 4).fill(BRAND.lime);

      if (logo) {
        doc.image(logo, left, 24, { width: 126 });
      } else {
        doc.font('Helvetica-Bold').fontSize(19).fillColor(BRAND.lime);
        put('VESOPA', left, 26);
      }

      doc.font('Helvetica-Bold').fontSize(20).fillColor(BRAND.onNight);
      put(report.name, left, 58, { width: width * 0.6 });

      doc.font('Helvetica').fontSize(7.5).fillColor(BRAND.dim);
      put('EPOS REPORTING', left, 88, { width: width * 0.6, characterSpacing: 1.6 });

      doc.font('Helvetica-Bold').fontSize(12).fillColor(BRAND.lime);
      put(report.site, left + width * 0.6, 60, { width: width * 0.4, align: 'right' });

      doc.font('Helvetica').fontSize(8).fillColor(BRAND.dim);
      put(`Generated ${displayDateTime(report.generatedAt)}`, left + width * 0.6, 78, {
        width: width * 0.4,
        align: 'right',
      });

      y = height + 4 + 22;
    }

    /**
     * The slimmer band every page after the first opens with.
     *
     * Enough of the identity to know what has been printed if page four gets
     * separated from page one, which is what always happens to a stapled
     * report.
     */
    function runningBand() {
      const height = 44;
      doc.rect(0, 0, doc.page.width, height).fill(BRAND.night);
      doc.rect(0, height, doc.page.width, 3).fill(BRAND.lime);
      if (logo) doc.image(logo, left, 15, { width: 92 });
      doc.font('Helvetica').fontSize(8).fillColor(BRAND.dim);
      put(`${report.name}  ·  ${report.site}`, left + 110, 20, {
        width: width - 110,
        align: 'right',
      });
      y = height + 3 + 20;
    }

    doc.on('pageAdded', runningBand);

    /** What the report covers, in four cells on one line. */
    function metaStrip() {
      const height = 52;
      doc.roundedRect(left, y, width, height, 9).fill(BRAND.wash);
      doc
        .roundedRect(left, y, width, height, 9)
        .lineWidth(0.7)
        .strokeColor(BRAND.line)
        .stroke();

      const cells = [
        { label: 'Site', lines: [report.site], part: 0.26 },
        {
          label: 'Period covered',
          lines: [displayDateTime(report.from), `to  ${displayDateTime(report.to)}`],
          part: 0.3,
        },
        // Always printed, including when it says All terminals. A report
        // filtered to one till and one covering the whole venue look identical
        // on paper otherwise, and that is exactly the confusion that gets a
        // manager shouting at the wrong member of staff.
        { label: 'Terminal', lines: [report.terminalLabel || 'All terminals'], part: 0.22 },
        { label: 'Generated', lines: [displayDateTime(report.generatedAt)], part: 0.22 },
      ];

      let x = left;
      cells.forEach((cell, i) => {
        const cellWidth = width * cell.part;
        if (i) {
          doc
            .moveTo(x, y + 12)
            .lineTo(x, y + height - 12)
            .lineWidth(0.7)
            .strokeColor(BRAND.line)
            .stroke();
        }
        doc.font('Helvetica-Bold').fontSize(6.6).fillColor(BRAND.muted);
        put(cell.label.toUpperCase(), x + 12, y + 11, {
          width: cellWidth - 22,
          characterSpacing: 0.7,
        });
        // Shrunk to fit rather than clipped. The venue's own name is the one
        // value here that is as long as somebody decided it was, and
        // "Pontardawe Rugby Foot…" on the document it hands its accountant is
        // not good enough.
        doc.font('Helvetica-Bold').fillColor(BRAND.ink);
        cell.lines.forEach((text, n) => {
          for (const size of [9, 8, 7.2]) {
            doc.fontSize(size);
            if (doc.widthOfString(String(text)) <= cellWidth - 22) break;
          }
          put(text, x + 12, y + 23 + n * 11, { width: cellWidth - 22 });
        });
        x += cellWidth;
      });

      y += height + 18;
    }

    /**
     * The headline figures, three across.
     *
     * The first is the lime tile because it is the number the report was opened
     * for. The rest are quiet — six loud tiles is no emphasis at all.
     */
    function tiles(items) {
      const shown = (items || []).slice(0, 6);
      if (!shown.length) return;

      const columns = 3;
      const gap = 10;
      const cardWidth = (width - gap * (columns - 1)) / columns;
      const cardHeight = 56;

      shown.forEach((item, i) => {
        const x = left + (i % columns) * (cardWidth + gap);
        const top = y + Math.floor(i / columns) * (cardHeight + gap);
        const hero = i === 0;

        doc
          .roundedRect(x, top, cardWidth, cardHeight, 9)
          .fill(hero ? BRAND.lime : BRAND.wash);
        if (!hero) {
          doc
            .roundedRect(x, top, cardWidth, cardHeight, 9)
            .lineWidth(0.7)
            .strokeColor(BRAND.line)
            .stroke();
        }

        doc
          .font('Helvetica-Bold')
          .fontSize(6.6)
          .fillColor(hero ? BRAND.onLimeMuted : BRAND.muted);
        put(String(item.label).toUpperCase(), x + 12, top + 11, {
          width: cardWidth - 24,
          characterSpacing: 0.7,
        });

        doc.font('Helvetica-Bold').fontSize(16).fillColor(BRAND.ink);
        put(item.value, x + 12, top + 23, { width: cardWidth - 24 });

        if (item.hint) {
          doc
            .font('Helvetica')
            .fontSize(6.6)
            .fillColor(hero ? BRAND.onLimeMuted : BRAND.muted);
          put(item.hint, x + 12, top + 44, { width: cardWidth - 24 });
        }
      });

      y += Math.ceil(shown.length / columns) * (cardHeight + gap) - gap + 20;
    }

    // ---- Tables ----------------------------------------------------------

    /** First column takes the slack; the figures share what is left, evenly. */
    const geometry = (part) => {
      const others = part.columns.length - 1;
      const figure = others > 0 ? Math.min(86, (width * 0.66) / others) : 0;
      return part.columns.map((_, i) => (i === 0 ? width - figure * others : figure));
    };

    /** One row of cells: the label left, every figure right. */
    function cells(values, widths, { bold = false, size = 8.4, color = BRAND.ink, height }) {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).fillColor(color);
      let x = left;
      values.forEach((value, i) => {
        put(value, x + PAD, y + (height - size * 1.15) / 2, {
          width: Math.max(10, widths[i] - PAD * 2),
          align: i === 0 ? 'left' : 'right',
        });
        x += widths[i];
      });
    }

    /**
     * The column headings.
     *
     * The one row that wraps instead of clipping. "Discount Total" cut to
     * "Discoun…" leaves a column of money with nothing saying which money it
     * is, so a heading gets a second line and the row is tall enough to hold
     * one — measured per column, so a table of short headings does not carry
     * the space for a wrap that never happens.
     */
    function headRow(part, widths) {
      const height = 25;
      doc.rect(left, y, width, height).fill(BRAND.limeSoft);
      doc.font('Helvetica-Bold').fontSize(7).fillColor(BRAND.limeDeep);
      let x = left;
      part.columns.forEach((column, i) => {
        const cellWidth = Math.max(10, widths[i] - PAD * 2);
        const label = column.label.toUpperCase();
        const wrapped =
          doc.heightOfString(label, { width: cellWidth, characterSpacing: 0.5 }) > 11;
        doc.text(label, x + PAD, y + (wrapped ? 5 : 9.5), {
          width: cellWidth,
          align: i === 0 ? 'left' : 'right',
          characterSpacing: 0.5,
        });
        x += widths[i];
      });
      y += height;
    }

    function sectionHeading(part, continued) {
      doc.rect(left, y + 3, 3.5, 13).fill(BRAND.lime);
      doc.font('Helvetica-Bold').fontSize(12.5).fillColor(BRAND.ink);
      put(continued ? `${part.title} (continued)` : part.title, left + 12, y, {
        width: width - 110,
      });
      doc.font('Helvetica').fontSize(8).fillColor(BRAND.muted);
      put(part.rows.length === 1 ? '1 row' : `${part.rows.length} rows`, left, y + 3, {
        width,
        align: 'right',
      });
      y += 25;
    }

    /** Break before `need` points of table, carrying the headings over. */
    function ensure(need, part, widths) {
      if (y + need <= floor) return;
      doc.addPage();
      sectionHeading(part, true);
      headRow(part, widths);
    }

    // ---- Draw it ---------------------------------------------------------

    coverBand();
    metaStrip();
    tiles(report.highlights);

    for (const part of report.sections) {
      const widths = geometry(part);
      const rowHeight = 17;

      // A heading with nothing under it at the foot of a page is a heading on
      // the wrong page. Keep it with its column headings and two rows.
      if (y + 25 + 25 + rowHeight * 2 > floor) doc.addPage();

      sectionHeading(part, false);
      headRow(part, widths);

      if (!part.rows.length) {
        ensure(rowHeight, part, widths);
        doc.rect(left, y, width, rowHeight).fill(BRAND.zebra);
        doc.font('Helvetica-Oblique').fontSize(8).fillColor(BRAND.muted);
        put('Nothing in this period.', left + PAD, y + 5, { width: width - PAD * 2 });
        y += rowHeight;
      }

      part.rows.forEach((row, i) => {
        ensure(rowHeight, part, widths);
        if (i % 2) doc.rect(left, y, width, rowHeight).fill(BRAND.zebra);
        cells(
          part.columns.map((column) => formatCell(row, column)),
          widths,
          { height: rowHeight }
        );
        y += rowHeight;
      });

      if (part.total) {
        const height = 23;
        ensure(height, part, widths);
        doc.rect(left, y, width, height).fill(BRAND.ink);
        cells(
          part.columns.map((column) => formatCell(part.total, column)),
          widths,
          { bold: true, size: 8.6, color: BRAND.onNight, height }
        );
        y += height;
      }

      y += 20;
    }

    // ---- Footer ----------------------------------------------------------
    //
    // Written last, over pages already drawn, because "of 6" is not known until
    // the final row has been placed.
    const pages = doc.bufferedPageRange();
    for (let i = 0; i < pages.count; i += 1) {
      doc.switchToPage(pages.start + i);
      const top = doc.page.height - doc.page.margins.bottom + 8;

      // The footer is deliberately *in* the bottom margin, and text placed
      // there is precisely what pdfkit reads as "this line does not fit" —
      // so it helpfully starts a new page, which then needs a footer of its
      // own. That is how a three page report came out as nine. Dropping the
      // margin for the width of the footer is the documented way to say
      // "this line is furniture, not content".
      const margin = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc
        .moveTo(left, top - 8)
        .lineTo(right, top - 8)
        .lineWidth(0.7)
        .strokeColor(BRAND.line)
        .stroke();
      doc.font('Helvetica').fontSize(7).fillColor(BRAND.muted);
      put(
        `${report.name} · ${report.site} · ${displayDateTime(report.from)} to ${displayDateTime(report.to)}`,
        left,
        top,
        { width: width * 0.72 }
      );
      doc.font('Helvetica-Bold').fontSize(7).fillColor(BRAND.graphite);
      put(`Vesopa EPOS    ${i + 1} / ${pages.count}`, left, top, {
        width,
        align: 'right',
      });
      doc.page.margins.bottom = margin;
    }

    doc.flushPages();
    doc.end();
  });
}

/** The three formats, and everything each one needs to be served or emailed. */
const FORMATS = {
  pdf: {
    label: 'PDF',
    extension: 'pdf',
    contentType: 'application/pdf',
    render: toPdf,
  },
  csv: {
    label: 'CSV',
    extension: 'csv',
    contentType: 'text/csv; charset=utf-8',
    render: toCsv,
  },
  xls: {
    label: 'XLS',
    extension: 'xlsx',
    contentType:
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    render: toXlsx,
  },
};

/** A filename that sorts and says what it is. */
function fileNameFor(report, format) {
  const stamp = report.generatedAt.toISOString().slice(0, 10);
  const slug = report.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  // A terminal-filtered export says so in its own name. Two files called
  // financial-summary-2026-08-31.pdf sitting in one downloads folder, one of
  // them the whole venue and one of them Bar 2, is a genuine hazard.
  const who = report.terminal
    ? `-${String(report.terminalLabel).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
    : '';
  return `${slug}${who}-${stamp}.${FORMATS[format].extension}`;
}

/** Build a report from a stored or posted specification. */
async function runReport({
  pool,
  office,
  siteName,
  report,
  period,
  from,
  to,
  now,
  terminal,
}) {
  const definition = REPORTS[report];
  if (!definition) throw new Error(`No such report: ${report}`);

  const range = resolveRange(period, { from, to, now });
  if (!range) throw new Error('That date range is not one we can run.');

  const filter = (terminal || '').trim() || null;

  const built = await definition.build({
    pool,
    office,
    siteName,
    from: range.from,
    to: range.to,
    terminal: filter,
  });

  // Carried on the report itself so every export renders the same header
  // without each format having to be told separately.
  built.terminal = filter;
  built.terminalLabel = !filter
    ? 'All terminals'
    : filter === UNKNOWN_TERMINAL
      ? 'Unknown terminal'
      : filter;
  return built;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

function reportRoutes({ pool, secret }) {
  const router = express.Router();
  const auth = requireAuth(secret);

  /** The office's key, and the name a report prints as its site. */
  async function site(req) {
    if (req.user.officeId) {
      const [[office]] = await pool.query(
        'SELECT contact_email, name FROM offices WHERE id = ?',
        [req.user.officeId]
      );
      if (office) {
        return { office: office.contact_email, siteName: office.name || office.contact_email };
      }
    }
    return { office: req.user.email, siteName: req.user.email };
  }

  /** What can be run, and over what. Drives every dropdown in one call. */
  router.get('/reports/catalogue', auth, async (req, res, next) => {
    try {
      const { office } = await site(req);
      res.json({
        reports: Object.entries(REPORTS).map(([key, value]) => ({
          key,
          label: value.label,
          description: value.description,
        })),
        ranges: Object.entries(RANGES).map(([key, value]) => ({
          key,
          label: value.label,
        })),
        formats: Object.entries(FORMATS).map(([key, value]) => ({
          key,
          label: value.label,
        })),
        // Only the terminals this venue has actually taken money on, so the
        // list can never offer a choice that returns an empty report.
        terminals: await terminalsInUse({ pool, office }),
      });
    } catch (e) {
      next(e);
    }
  });

  router.post('/reports/run', auth, async (req, res, next) => {
    try {
      const { office, siteName } = await site(req);
      const report = await runReport({
        pool,
        office,
        siteName,
        report: req.body.report,
        period: req.body.period,
        from: req.body.from,
        to: req.body.to,
        terminal: req.body.terminal,
      });

      // Money crosses the wire in pence, with the formatted string beside it.
      // The browser needs the string to draw and the number to sort, and
      // sending only one of them means one of those jobs is done badly.
      res.json({
        ...report,
        from: report.from.toISOString(),
        to: report.to.toISOString(),
        generatedAt: report.generatedAt.toISOString(),
        header: reportHeader(report),
        sections: report.sections.map((part) => ({
          title: part.title,
          columns: part.columns,
          rows: part.rows.map((row) => ({
            values: part.columns.map((c) => formatCell(row, c)),
            raw: row,
          })),
          total: part.total
            ? { values: part.columns.map((c) => formatCell(part.total, c)) }
            : null,
        })),
      });
    } catch (e) {
      if (/No such report|date range/.test(e.message)) {
        return res.status(400).json({ error: e.message });
      }
      next(e);
    }
  });

  router.post('/reports/export', auth, async (req, res, next) => {
    try {
      const format = FORMATS[req.body.format];
      if (!format) {
        return res.status(400).json({ error: 'That is not a format we produce.' });
      }

      const { office, siteName } = await site(req);
      const report = await runReport({
        pool,
        office,
        siteName,
        report: req.body.report,
        period: req.body.period,
        from: req.body.from,
        to: req.body.to,
        terminal: req.body.terminal,
      });

      const body = await format.render(report);

      // `inline` is what the back office's preview asks for: the same bytes,
      // but a Content-Disposition the browser will render rather than save. A
      // preview that downloads a file is not a preview, and saving a PDF to
      // find out whether the right week is in it is exactly the loop this
      // removes.
      const disposition = req.body.disposition === 'inline' ? 'inline' : 'attachment';
      res.setHeader('Content-Type', format.contentType);
      res.setHeader(
        'Content-Disposition',
        `${disposition}; filename="${fileNameFor(report, req.body.format)}"`
      );
      res.send(body);
    } catch (e) {
      if (/No such report|date range/.test(e.message)) {
        return res.status(400).json({ error: e.message });
      }
      next(e);
    }
  });

  return router;
}

module.exports = {
  BRAND,
  brandLogo,
  RANGES,
  REPORTS,
  UNKNOWN_TERMINAL,
  terminalsInUse,
  FORMATS,
  resolveRange,
  sqlDateTime,
  displayDateTime,
  money,
  taxWithin,
  totalOf,
  financialSummary,
  runReport,
  reportHeader,
  formatCell,
  fileNameFor,
  toCsv,
  toXlsx,
  toPdf,
  reportRoutes,
};
