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

const express = require('express');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');

const { requireAuth } = require('./auth');

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
async function financialSummary({ pool, office, from, to, siteName }) {
  const params = [office, sqlDateTime(from), sqlDateTime(to)];
  const window = 'o.email = ? AND o.closed_at BETWEEN ? AND ?';

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

  return {
    key: 'financial_summary',
    name: 'Financial Summary',
    site: siteName || office,
    from,
    to,
    generatedAt: new Date(),
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
  for (const [label, value] of reportHeader(report)) {
    const row = cover.addRow([label, value]);
    row.getCell(1).font = { bold: true };
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

/**
 * PDF.
 *
 * Laid out by hand rather than through a table library, because the layout is
 * simple and the failure mode of a library here is a column that silently
 * overflows the page on the one venue with a long department name.
 *
 * Helvetica is WinAnsi-encoded, which draws "£" correctly — unlike the till's
 * thermal printers, where the same character needed a whole setting.
 */
function toPdf(report) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = doc.page.margins.left;
    const width = doc.page.width - left - doc.page.margins.right;
    const bottom = doc.page.height - doc.page.margins.bottom;

    doc.fontSize(18).font('Helvetica-Bold').text(report.name);
    doc.moveDown(0.4);

    doc.fontSize(9).font('Helvetica');
    for (const [label, value] of reportHeader(report)) {
      doc.font('Helvetica-Bold').text(`${label}: `, { continued: true });
      doc.font('Helvetica').text(String(value));
    }

    for (const part of report.sections) {
      // Column widths: the first column takes the slack, the rest are even.
      const others = part.columns.length - 1;
      const figure = others > 0 ? Math.min(80, (width * 0.62) / others) : 0;
      const first = width - figure * others;
      const widths = part.columns.map((_, i) => (i === 0 ? first : figure));

      const rowHeight = 16;

      const heading = () => {
        doc.moveDown(0.9);
        if (doc.y + rowHeight * 3 > bottom) doc.addPage();
        doc.fontSize(12).font('Helvetica-Bold').text(part.title);
        doc.moveDown(0.3);
        line(part.columns.map((c) => c.label), true);
      };

      function line(cells, bold) {
        if (doc.y + rowHeight > bottom) {
          doc.addPage();
          doc.fontSize(12).font('Helvetica-Bold').text(`${part.title} (continued)`);
          doc.moveDown(0.3);
          line(part.columns.map((c) => c.label), true);
        }
        const y = doc.y;
        doc.fontSize(8.5).font(bold ? 'Helvetica-Bold' : 'Helvetica');
        let x = left;
        cells.forEach((cell, i) => {
          doc.text(String(cell), x, y, {
            width: widths[i] - 4,
            align: i === 0 ? 'left' : 'right',
            lineBreak: false,
            ellipsis: true,
          });
          x += widths[i];
        });
        doc.y = y + rowHeight;
        if (bold) {
          doc
            .moveTo(left, doc.y - 4)
            .lineTo(left + width, doc.y - 4)
            .lineWidth(0.5)
            .strokeColor('#999999')
            .stroke();
        }
      }

      heading();
      if (!part.rows.length) {
        doc.fontSize(8.5).font('Helvetica-Oblique').text('Nothing in this period.');
        doc.y += 4;
      }
      for (const row of part.rows) {
        line(part.columns.map((c) => formatCell(row, c)), false);
      }
      if (part.total) {
        line(part.columns.map((c) => formatCell(part.total, c)), true);
      }
    }

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
  return `${slug}-${stamp}.${FORMATS[format].extension}`;
}

/** Build a report from a stored or posted specification. */
async function runReport({ pool, office, siteName, report, period, from, to, now }) {
  const definition = REPORTS[report];
  if (!definition) throw new Error(`No such report: ${report}`);

  const range = resolveRange(period, { from, to, now });
  if (!range) throw new Error('That date range is not one we can run.');

  return definition.build({
    pool,
    office,
    siteName,
    from: range.from,
    to: range.to,
  });
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

  /** What can be run, and over what. Drives both dropdowns in one call. */
  router.get('/reports/catalogue', auth, (_req, res) => {
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
    });
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
      });

      const body = await format.render(report);
      res.setHeader('Content-Type', format.contentType);
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${fileNameFor(report, req.body.format)}"`
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
  RANGES,
  REPORTS,
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
