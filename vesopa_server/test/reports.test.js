/**
 * Reports, and the schedules that send them.
 *
 * Run with `npm test`. No MySQL: the queries are answered from a script, as in
 * fonts.test.js and imports.test.js.
 *
 * Three things are worth guarding, and only one of them is arithmetic.
 *
 *  1. **The window.** "Yesterday" has to mean yesterday, whole, in local time,
 *     and "Last 7 Days" has to mean seven whole days rather than 168 hours —
 *     otherwise the first and last day are part-days and every report looks
 *     like a slump at both ends. The clock is injected so these are not a
 *     hostage to the day they happen to run on.
 *
 *  2. **That it reconciles.** Department sales, sub department sales and
 *     payments are three views of the same money. A report where they disagree
 *     is a report an accountant will find a use for and a venue will regret.
 *
 *  3. **That a schedule fires once.** Twice is a duplicate in somebody's inbox;
 *     never is the failure the whole feature exists to prevent. The two are
 *     guarded together, because they are the same off-by-one.
 */

const assert = require('assert');

const express = require('express');
const jwt = require('jsonwebtoken');
const ExcelJS = require('exceljs');

const {
  RANGES,
  resolveRange,
  taxWithin,
  money,
  financialSummary,
  reportRoutes,
  toCsv,
  toXlsx,
  toPdf,
  fileNameFor,
} = require('../src/reports');

const {
  minuteToClock,
  clockToMinute,
  nextRunAfter,
  parseRecipients,
  validateSchedule,
  tick,
  runSchedule,
} = require('../src/report_schedules');

const SECRET = 'test-secret-not-a-real-one';

let passed = 0;
const checks = [];
const check = (name, fn) => checks.push({ name, fn });

/** A pool that answers from a script and records every write. */
function fakePool(script = []) {
  const written = [];
  const asked = [];
  const answer = (sql, params) => {
    const flat = sql.replace(/\s+/g, ' ').trim();
    asked.push({ sql: flat, params });
    if (/^(INSERT|UPDATE|DELETE)/i.test(flat)) written.push({ sql: flat, params });
    for (const [pattern, rows] of script) {
      if (flat.includes(pattern)) return [rows, []];
    }
    return [[], []];
  };
  return {
    written,
    asked,
    query: async (sql, params) => answer(sql, params),
    execute: async (sql, params) => answer(sql, params),
  };
}

/**
 * A day's trading, in the shape the queries return it.
 *
 * The figures are the reference report's own, so the reconciliation checks
 * below are checking against a document somebody actually printed rather than
 * against numbers invented to make them pass.
 */
const LINES = [
  { department: 'Drink', sub_department: 'Beers & Ciders', quantity: 66, unit_price_minor: 460, tax_percentage: 20, discount_minor: 0 },
  { department: 'Drink', sub_department: 'Soft Drinks', quantity: 33, unit_price_minor: 220, tax_percentage: 20, discount_minor: 0 },
  { department: 'Drink', sub_department: 'Wine', quantity: 2, unit_price_minor: 750, tax_percentage: 20, discount_minor: 0 },
  { department: 'Food', sub_department: 'Mains', quantity: 22, unit_price_minor: 950, tax_percentage: 20, discount_minor: 500 },
  { department: 'Food', sub_department: 'Sides', quantity: 10, unit_price_minor: 300, tax_percentage: 0, discount_minor: 0 },
  // A product deleted from the catalogue since it was sold. It must still
  // appear, or the report stops agreeing with the payments.
  { department: 'Unassigned', sub_department: 'Unassigned', quantity: 1, unit_price_minor: 200, tax_percentage: 20, discount_minor: 0 },
];

const GENERAL = {
  bills: 94,
  covers: 84,
  total_minor: 65149,
  gratuity_minor: 1250,
  gratuity_count: 8,
  service_minor: 0,
  service_count: 0,
  voucher_minor: 500,
  voucher_count: 2,
  points_minor: 751,
  points_count: 2,
  promo_minor: 0,
  promo_count: 0,
};

const PAYMENTS = [
  { method: 'card', count: 58, total_minor: 46592 },
  { method: 'cash', count: 31, total_minor: 17806 },
  { method: 'redeem points', count: 2, total_minor: 751 },
];

const summaryPool = () =>
  fakePool([
    ['AS sub_department', LINES],
    ['AS bills', [GENERAL]],
    ['epos_gift_card_txns', [{ count: 1, total_minor: 2500 }]],
    ['l.promotion_name', [{ name: 'Happy Hour', count: 4, total_minor: 500 }]],
    ['FROM epos_payments', PAYMENTS],
  ]);

const build = () =>
  financialSummary({
    pool: summaryPool(),
    office: 'manager@vesopa.co.uk',
    siteName: 'Pontardawe RFC',
    from: new Date('2026-08-27T00:00:00'),
    to: new Date('2026-08-27T23:59:59'),
  });

const sectionNamed = (report, title) =>
  report.sections.find((s) => s.title === title);

// ---------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------

// A Monday, mid-afternoon, so every "…to now" range has a part-day in it and
// every week boundary is unambiguous.
const NOW = new Date('2026-08-31T14:13:28');

const span = (period) => {
  const r = resolveRange(period, { now: NOW });
  const d = (x) =>
    `${String(x.getDate()).padStart(2, '0')}/${String(x.getMonth() + 1).padStart(2, '0')}/${x.getFullYear()}`;
  return `${d(r.from)}-${d(r.to)}`;
};

check('today is today, from this morning rather than from this time yesterday', () => {
  assert.strictEqual(span('today'), '31/08/2026-31/08/2026');
  const r = resolveRange('today', { now: NOW });
  assert.strictEqual(r.from.getHours(), 0);
  assert.strictEqual(r.to.getHours(), 23);
});

check('yesterday is a whole day, and not part of today', () => {
  assert.strictEqual(span('yesterday'), '30/08/2026-30/08/2026');
});

check('last 7 days is seven whole days ending today', () => {
  // Not 168 hours ending now: a rolling window makes the first and last bar of
  // every chart a part-day, which always reads as a slump.
  assert.strictEqual(span('last_7_days'), '25/08/2026-31/08/2026');
});

check('and last 30 days is thirty of them', () => {
  assert.strictEqual(span('last_30_days'), '02/08/2026-31/08/2026');
});

check('the week starts on Monday', () => {
  assert.strictEqual(span('this_week'), '31/08/2026-31/08/2026');
  assert.strictEqual(span('last_week'), '24/08/2026-30/08/2026');
});

check('and a Sunday belongs to the week that began the Monday before it', () => {
  const sunday = new Date('2026-08-30T20:00:00');
  const r = resolveRange('this_week', { now: sunday });
  assert.strictEqual(r.from.getDate(), 24);
  assert.strictEqual(r.from.getMonth(), 7);
});

check('months and years are calendar ones', () => {
  assert.strictEqual(span('this_month'), '01/08/2026-31/08/2026');
  assert.strictEqual(span('last_month'), '01/07/2026-31/07/2026');
  assert.strictEqual(span('this_year'), '01/01/2026-31/08/2026');
  assert.strictEqual(span('last_year'), '01/01/2025-31/12/2025');
});

check('last month from the 31st does not skip February', () => {
  // March 31st: `setMonth(month - 1)` on a Date would land on March 3rd, which
  // is the classic version of this bug and would report the wrong month.
  const r = resolveRange('last_month', { now: new Date('2026-03-31T10:00:00') });
  assert.strictEqual(r.from.getMonth(), 1, 'February');
  assert.strictEqual(r.to.getDate(), 28);
});

check('a custom range typed backwards is read as a range, not as nothing', () => {
  const r = resolveRange('custom', { from: '2026-08-27', to: '2026-08-20' });
  assert.strictEqual(r.from.getDate(), 20);
  assert.strictEqual(r.to.getDate(), 27);
});

check('a custom range with nothing in it is refused', () => {
  assert.strictEqual(resolveRange('custom', {}), null);
  assert.strictEqual(resolveRange('custom', { from: 'nonsense', to: 'x' }), null);
  assert.strictEqual(resolveRange('made_up_period', {}), null);
});

check('every range on offer resolves', () => {
  for (const key of Object.keys(RANGES)) {
    if (key === 'custom') continue;
    assert.ok(resolveRange(key, { now: NOW }), `${key} did not resolve`);
  }
});

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

check('VAT is the tax inside the price, not a percentage on top of it', () => {
  // A £12.00 price at 20% contains £2.00 of VAT, not £2.40. Getting this the
  // other way round overstates the tax by 20% of itself, and it is invisible
  // until an accountant checks it.
  assert.strictEqual(taxWithin(1200, 20), 200);
  assert.strictEqual(taxWithin(1000, 0), 0);
  assert.strictEqual(taxWithin(0, 20), 0);
});

check('money is formatted from pence, once, at the edge', () => {
  assert.strictEqual(money(65149), '£651.49');
  assert.strictEqual(money(0), '£0.00');
  assert.strictEqual(money(5), '£0.05');
});

// ---------------------------------------------------------------------------
// The Financial Summary
// ---------------------------------------------------------------------------

check('it names the site and the window it covers', async () => {
  const report = await build();
  assert.strictEqual(report.name, 'Financial Summary');
  assert.strictEqual(report.site, 'Pontardawe RFC');
  assert.strictEqual(report.from.getDate(), 27);
  assert.ok(report.generatedAt instanceof Date);
});

check('it has every section the reference report has', async () => {
  const report = await build();
  assert.deepStrictEqual(
    report.sections.map((s) => s.title),
    [
      'Department Sales',
      'Sub Department Sales',
      'General',
      'Other Discounts',
      'Expenses',
      'Spend Per Head',
      'Payment Methods',
    ]
  );
});

check('departments and sub departments are two views of one set of rows', async () => {
  const report = await build();
  const departments = sectionNamed(report, 'Department Sales');
  const subs = sectionNamed(report, 'Sub Department Sales');

  // The reconciliation the whole report rests on. These are grouped in JS from
  // one query for exactly this reason: two queries can drift.
  for (const key of ['sales_minor', 'count', 'tax_minor', 'discount_minor', 'gross_minor', 'net_minor']) {
    assert.strictEqual(
      departments.total[key],
      subs.total[key],
      `${key} disagrees between departments and sub departments`
    );
  }
});

check('the summary total is the sum of the rows printed above it', async () => {
  const report = await build();
  const part = sectionNamed(report, 'Department Sales');
  const summed = part.rows.reduce((sum, r) => sum + r.sales_minor, 0);
  assert.strictEqual(part.total.sales_minor, summed);
});

check('gross is sales less discount, and net is gross less tax', async () => {
  const report = await build();
  for (const part of ['Department Sales', 'Sub Department Sales']) {
    for (const row of sectionNamed(report, part).rows) {
      assert.strictEqual(
        row.gross_minor,
        row.sales_minor - row.discount_minor,
        `${row.name}: gross`
      );
      assert.strictEqual(
        row.net_minor,
        row.gross_minor - row.tax_minor,
        `${row.name}: net`
      );
    }
  }
});

check('a zero-rated line carries no tax', async () => {
  const report = await build();
  const sides = sectionNamed(report, 'Sub Department Sales').rows.find(
    (r) => r.name === 'Sides'
  );
  assert.strictEqual(sides.tax_minor, 0);
  assert.strictEqual(sides.net_minor, sides.gross_minor);
});

check('tax is taken after the discount, not before it', async () => {
  const report = await build();
  const mains = sectionNamed(report, 'Sub Department Sales').rows.find(
    (r) => r.name === 'Mains'
  );
  // 22 x £9.50 = £209.00, less £5.00 discount = £204.00 gross, and the VAT is
  // the 20% inside £204 rather than inside £209. Charging tax on money the
  // customer was never asked for is the error being guarded here.
  assert.strictEqual(mains.sales_minor, 20900);
  assert.strictEqual(mains.gross_minor, 20400);
  assert.strictEqual(mains.tax_minor, taxWithin(20400, 20));
});

check('a product deleted since it was sold still appears', async () => {
  const report = await build();
  const row = sectionNamed(report, 'Department Sales').rows.find(
    (r) => r.name === 'Unassigned'
  );
  assert.ok(row, 'the orphaned line vanished from the report');
  assert.strictEqual(row.sales_minor, 200);
});

check('payments carry their own total and are titled properly', async () => {
  const report = await build();
  const part = sectionNamed(report, 'Payment Methods');
  assert.deepStrictEqual(
    part.rows.map((r) => r.name),
    ['Card', 'Cash', 'Redeem Points']
  );
  assert.strictEqual(part.total.total_minor, 46592 + 17806 + 751);
  assert.strictEqual(part.total.count, 91);
});

check('spend per head never divides by zero covers', async () => {
  const pool = fakePool([
    ['AS sub_department', LINES],
    ['AS bills', [{ ...GENERAL, covers: 0 }]],
    ['FROM epos_payments', PAYMENTS],
  ]);
  const report = await financialSummary({
    pool,
    office: 'x@y.z',
    from: new Date('2026-08-27T00:00:00'),
    to: new Date('2026-08-27T23:59:59'),
  });
  const spend = sectionNamed(report, 'Spend Per Head').rows[0];
  assert.strictEqual(spend.covers, 0);
  assert.strictEqual(spend.average_minor, 0);
});

check('bill-level discounts appear beside the line-level ones', async () => {
  const report = await build();
  const names = sectionNamed(report, 'Other Discounts').rows.map((r) => r.name);
  assert.ok(names.includes('Happy Hour'));
  assert.ok(names.includes('Vouchers'));
  assert.ok(names.includes('Points redeemed'));
});

check('a period with no trading is an empty report, not a crash', async () => {
  const pool = fakePool([
    ['AS bills', [{ bills: 0, covers: 0, total_minor: 0, gratuity_minor: 0, gratuity_count: 0, service_minor: 0, service_count: 0, voucher_minor: 0, voucher_count: 0, points_minor: 0, points_count: 0, promo_minor: 0, promo_count: 0 }]],
  ]);
  const report = await financialSummary({
    pool,
    office: 'x@y.z',
    from: new Date('2026-08-27T00:00:00'),
    to: new Date('2026-08-27T23:59:59'),
  });
  assert.strictEqual(sectionNamed(report, 'Department Sales').rows.length, 0);
  assert.strictEqual(sectionNamed(report, 'Department Sales').total.sales_minor, 0);
});

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

check('the CSV opens in Excel with its pound signs intact', async () => {
  const report = await build();
  const csv = toCsv(report);
  // A UTF-8 BOM. Without it Excel reads the file as the system codepage and
  // every money column comes out as "Â£" — wrong in the one application this
  // file is most likely to be opened in.
  assert.deepStrictEqual([...csv.subarray(0, 3)], [0xef, 0xbb, 0xbf]);

  const text = csv.toString('utf8');
  assert.ok(text.includes('Financial Summary'));
  assert.ok(text.includes('Pontardawe RFC'));
  assert.ok(text.includes('"Department Sales"'));
  assert.ok(text.includes('£'));
});

check('and a department with a comma in its name does not break a row', async () => {
  const pool = fakePool([
    ['AS sub_department', [{ department: 'Wines, Spirits', sub_department: 'Wine', quantity: 1, unit_price_minor: 750, tax_percentage: 20, discount_minor: 0 }]],
    ['AS bills', [GENERAL]],
  ]);
  const report = await financialSummary({
    pool,
    office: 'x@y.z',
    from: new Date('2026-08-27T00:00:00'),
    to: new Date('2026-08-27T23:59:59'),
  });
  const line = toCsv(report)
    .toString('utf8')
    .split('\r\n')
    .find((l) => l.includes('Wines'));
  assert.ok(line.startsWith('"Wines, Spirits"'), line);
});

check('the XLSX carries money as numbers, not as labels', async () => {
  const report = await build();
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await toXlsx(report));

  const sheet = workbook.getWorksheet('Department Sales');
  assert.ok(sheet, 'no Department Sales sheet');
  // By position, not by key: column keys are a write-time convenience and are
  // not stored in the file, so a loaded sheet only knows column 2.
  assert.strictEqual(sheet.getRow(1).getCell(2).value, 'Sales Total');
  const value = sheet.getRow(2).getCell(2).value;
  // A venue's first act with this file is to sum the column, which is only
  // possible if the cell is a number.
  assert.strictEqual(typeof value, 'number');
  assert.ok(value > 0);
});

check('and every section gets a sheet Excel will accept the name of', async () => {
  const report = await build();
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await toXlsx(report));
  const names = workbook.worksheets.map((s) => s.name);
  assert.ok(names.includes('Report'));
  for (const name of names) {
    assert.ok(name.length <= 31, `"${name}" is too long for a sheet name`);
    assert.ok(!/[[\]:*?/\\]/.test(name), `"${name}" has a character Excel refuses`);
  }
});

check('the PDF is a PDF', async () => {
  const report = await build();
  const pdf = await toPdf(report);
  assert.strictEqual(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.ok(pdf.length > 2000, 'suspiciously small for a seven-section report');
});

check('a file name says what it is and when', async () => {
  const report = await build();
  assert.match(fileNameFor(report, 'pdf'), /^financial-summary-\d{4}-\d{2}-\d{2}\.pdf$/);
  assert.match(fileNameFor(report, 'xls'), /\.xlsx$/);
  assert.match(fileNameFor(report, 'csv'), /\.csv$/);
});

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------

check('a time of day survives the round trip', () => {
  assert.strictEqual(minuteToClock(510), '08:30');
  assert.strictEqual(minuteToClock(0), '00:00');
  assert.strictEqual(minuteToClock(23 * 60 + 59), '23:59');
  assert.strictEqual(clockToMinute('08:30'), 510);
  assert.strictEqual(clockToMinute('8:30'), 510);
  assert.strictEqual(clockToMinute('24:00'), null);
  assert.strictEqual(clockToMinute('half eight'), null);
});

check('the next run is strictly after now, so nothing fires twice', () => {
  // A run finishing at 08:30:02 must not compute 08:30 today and be due again
  // immediately. This is the whole of "the report arrived four times".
  const justRan = new Date('2026-08-31T08:30:02');
  const next = nextRunAfter({ frequency: 'daily', runAtMinute: 510, after: justRan });
  assert.ok(next > justRan);
  assert.strictEqual(next.getDate(), 1, 'should be tomorrow');
});

check('a daily schedule set for later today runs today', () => {
  const next = nextRunAfter({
    frequency: 'daily',
    runAtMinute: 18 * 60,
    after: new Date('2026-08-31T09:00:00'),
  });
  assert.strictEqual(next.getDate(), 31);
  assert.strictEqual(next.getHours(), 18);
});

check('a weekly schedule keeps the weekday it was created on', () => {
  const anchor = new Date('2026-08-28T10:00:00'); // a Friday
  const next = nextRunAfter({
    frequency: 'weekly',
    runAtMinute: 510,
    after: new Date('2026-08-31T09:00:00'),
    anchor,
  });
  assert.strictEqual(next.getDay(), 5, 'should still be a Friday');
  assert.strictEqual(next.getDate(), 4);
});

check('a monthly schedule made on the 31st lands on the 28th in February', () => {
  const anchor = new Date('2026-01-31T10:00:00');
  const next = nextRunAfter({
    frequency: 'monthly',
    runAtMinute: 510,
    after: new Date('2026-02-01T09:00:00'),
    anchor,
  });
  assert.strictEqual(next.getMonth(), 1);
  assert.strictEqual(next.getDate(), 28);
});

check('quarterly is every third month from its own start, not the calendar', () => {
  const anchor = new Date('2026-08-31T10:00:00');
  const next = nextRunAfter({
    frequency: 'quarterly',
    runAtMinute: 510,
    after: new Date('2026-08-31T09:00:00'),
    anchor,
  });
  assert.strictEqual(next.getMonth(), 10, 'November');
});

check('addresses are split on anything people actually paste', () => {
  const { good, bad } = parseRecipients('a@b.com, c@d.co.uk;\n e@f.org');
  assert.deepStrictEqual(good, ['a@b.com', 'c@d.co.uk', 'e@f.org']);
  assert.deepStrictEqual(bad, []);
});

check('and one bad address is named rather than silently dropped', () => {
  const { error } = validateSchedule({
    name: 'Test',
    report_key: 'financial_summary',
    format: 'pdf',
    frequency: 'daily',
    time: '08:30',
    period: 'today',
    recipients: 'a@b.com, notanaddress',
  });
  assert.match(error, /notanaddress/);
});

check('a schedule needs every one of the five steps answered', () => {
  const base = {
    name: 'Test',
    report_key: 'financial_summary',
    format: 'pdf',
    frequency: 'daily',
    time: '08:30',
    period: 'today',
    recipients: 'a@b.com',
  };
  assert.ok(validateSchedule(base).value, 'the complete form was refused');

  assert.match(validateSchedule({ ...base, name: '' }).error, /name/i);
  assert.match(validateSchedule({ ...base, report_key: 'nope' }).error, /report/i);
  assert.match(validateSchedule({ ...base, format: 'doc' }).error, /format/i);
  assert.match(validateSchedule({ ...base, frequency: 'hourly' }).error, /often/i);
  assert.match(validateSchedule({ ...base, period: 'custom' }).error, /period/i);
  assert.match(validateSchedule({ ...base, time: '99:99' }).error, /time of day/i);
  assert.match(validateSchedule({ ...base, recipients: '' }).error, /email/i);
});

check('a repeating schedule cannot be pinned to a fixed pair of dates', () => {
  // "custom" on a schedule sends the same week's figures for ever, and nobody
  // notices because the mail keeps arriving.
  assert.ok(validateSchedule({
    name: 'Test',
    report_key: 'financial_summary',
    format: 'pdf',
    frequency: 'weekly',
    time: '08:30',
    period: 'custom',
    recipients: 'a@b.com',
  }).error);
});

// ---------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------

const dueSchedule = (over = {}) => ({
  id: 1,
  office: 'manager@vesopa.co.uk',
  name: 'Morning figures',
  report_key: 'financial_summary',
  format: 'pdf',
  frequency: 'daily',
  run_at_minute: 510,
  period: 'yesterday',
  recipients: 'owner@venue.co.uk',
  active: 1,
  created_at: new Date('2026-08-01T08:30:00'),
  next_run_at: new Date('2026-08-31T08:30:00'),
  ...over,
});

function tickPool(schedules) {
  return fakePool([
    ['FROM bo_report_schedules', schedules],
    ['AS sub_department', LINES],
    ['AS bills', [GENERAL]],
    ['FROM epos_payments', PAYMENTS],
    ['FROM offices', [{ name: 'Pontardawe RFC' }]],
  ]);
}

(async () => {
  for (const { name, fn } of checks) {
    try {
      await fn();
      passed++;
      console.log(`  ok  ${name}`);
    } catch (e) {
      console.log(`FAIL  ${name}`);
      console.log(`      ${e.message}`);
      process.exitCode = 1;
    }
  }

  const later = [];
  const check2 = (name, fn) => later.push({ name, fn });

  check2('a due schedule is sent and its next run moved on', async () => {
    const pool = tickPool([dueSchedule()]);
    const sent = [];
    const fired = await tick({
      pool,
      now: new Date('2026-08-31T08:30:30'),
      send: async (mail) => {
        sent.push(mail);
        return true;
      },
      canSend: () => true,
    });

    assert.strictEqual(fired, 1);
    assert.strictEqual(sent.length, 1, 'nothing was sent');
    assert.strictEqual(sent[0].to, 'owner@venue.co.uk');
    assert.strictEqual(sent[0].attachments.length, 1);
    assert.match(sent[0].attachments[0].filename, /\.pdf$/);
    assert.strictEqual(sent[0].attachments[0].content.subarray(0, 5).toString(), '%PDF-');

    const update = pool.written.find((w) => w.sql.startsWith('UPDATE bo_report_schedules'));
    assert.ok(update, 'next_run_at was never advanced');
    // Tomorrow at 08:30, not today — see "strictly after".
    assert.match(update.params[1], /^2026-09-01 08:30:00$/);
  });

  check2('the window comes from when it was due, not when it ran', async () => {
    // The server was down and got to an 08:30 "Yesterday" report at 00:05 the
    // following night. It must still cover the 30th.
    const pool = tickPool([dueSchedule()]);
    const sent = [];
    await tick({
      pool,
      now: new Date('2026-09-01T00:05:00'),
      send: async (mail) => {
        sent.push(mail);
        return true;
      },
      canSend: () => true,
    });
    assert.match(sent[0].subject, /30\/08\/2026/);
  });

  check2('every attempt is recorded, so "it never arrived" is answerable', async () => {
    const pool = tickPool([dueSchedule()]);
    await tick({
      pool,
      now: new Date('2026-08-31T08:30:30'),
      send: async () => true,
      canSend: () => true,
    });
    const run = pool.written.find((w) => w.sql.includes('INTO bo_report_runs'));
    assert.ok(run, 'nothing was written to the run log');
    assert.strictEqual(run.params[2], 'sent');
    assert.strictEqual(run.params[4], 'owner@venue.co.uk');
  });

  check2('a failing schedule is recorded and does not fire again immediately', async () => {
    const pool = tickPool([dueSchedule()]);
    const outcome = await tick({
      pool,
      now: new Date('2026-08-31T08:30:30'),
      send: async () => {
        throw new Error('the mail server hung up');
      },
      canSend: () => true,
    });
    assert.strictEqual(outcome, 1);

    const run = pool.written.find((w) => w.sql.includes('INTO bo_report_runs'));
    assert.strictEqual(run.params[2], 'failed');
    assert.match(run.params[3], /hung up/);

    // Advanced anyway. A schedule that throws must not be retried every minute
    // for ever — one failure is a failure, sixty an hour is an outage.
    const update = pool.written.find((w) => w.sql.startsWith('UPDATE bo_report_schedules'));
    assert.match(update.params[1], /^2026-09-01/);
  });

  check2('nothing due means nothing sent', async () => {
    const pool = fakePool([['FROM bo_report_schedules', []]]);
    const sent = [];
    const fired = await tick({
      pool,
      now: new Date('2026-08-31T08:30:30'),
      send: async () => sent.push(1),
    });
    assert.strictEqual(fired, 0);
    assert.strictEqual(sent.length, 0);
    assert.strictEqual(pool.written.length, 0);
  });

  // ---- Routes -----------------------------------------------------------

  const app = () => {
    const server = express();
    server.use(express.json());
    server.use('/api', reportRoutes({ pool: summaryPool(), secret: SECRET }));
    server.use((err, _req, res, _next) => res.status(500).json({ error: String(err) }));
    return server;
  };
  const listen = (a) =>
    new Promise((resolve) => {
      const s = a.listen(0, () => resolve(s));
    });
  const token = jwt.sign({ email: 'manager@vesopa.co.uk', role: 'manager' }, SECRET);

  const post = async (server, path, body) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    return { status: res.status, res };
  };

  check2('running a report over the wire gives the browser both figures and text', async () => {
    const server = await listen(app());
    try {
      const { status, res } = await post(server, '/api/reports/run', {
        report: 'financial_summary',
        period: 'today',
      });
      assert.strictEqual(status, 200);
      const body = await res.json();
      const part = body.sections.find((s) => s.title === 'Department Sales');
      // The string to draw, and the number to sort by. Sending one of them
      // means one of those jobs is done badly.
      assert.ok(part.rows[0].values.some((v) => v.startsWith('£')));
      assert.strictEqual(typeof part.rows[0].raw.sales_minor, 'number');
      assert.ok(part.total.values.includes('Summary Total'));
    } finally {
      server.close();
    }
  });

  check2('a report nobody offers is refused, not 500d', async () => {
    const server = await listen(app());
    try {
      const { status } = await post(server, '/api/reports/run', {
        report: 'takings_by_astrological_sign',
        period: 'today',
      });
      assert.strictEqual(status, 400);
    } finally {
      server.close();
    }
  });

  check2('each export comes back as the file it claims to be', async () => {
    const server = await listen(app());
    try {
      for (const [format, magic] of [['pdf', '%PDF-'], ['csv', '﻿"Rep'], ['xls', 'PK']]) {
        const { status, res } = await post(server, '/api/reports/export', {
          report: 'financial_summary',
          period: 'today',
          format,
        });
        assert.strictEqual(status, 200, format);
        const body = Buffer.from(await res.arrayBuffer());
        assert.strictEqual(
          body.toString('utf8').slice(0, magic.length),
          magic,
          `${format} did not start as expected`
        );
        assert.match(res.headers.get('content-disposition'), /attachment; filename=/);
      }
    } finally {
      server.close();
    }
  });

  check2('and none of it is reachable without signing in', async () => {
    const server = await listen(app());
    try {
      const res = await fetch(
        `http://127.0.0.1:${server.address().port}/api/reports/catalogue`
      );
      assert.strictEqual(res.status, 401);
    } finally {
      server.close();
    }
  });

  for (const { name, fn } of later) {
    try {
      await fn();
      passed++;
      console.log(`  ok  ${name}`);
    } catch (e) {
      console.log(`FAIL  ${name}`);
      console.log(`      ${e.message}`);
      process.exitCode = 1;
    }
  }

  console.log(`\nreports: ${passed} checks passed\n`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
