/**
 * Bringing a catalogue in from a spreadsheet.
 *
 * A venue moving to Vesopa arrives with its products already written down —
 * usually in Excel, occasionally as an export from whatever till it is
 * replacing. Typing four hundred of them into a web form one at a time is the
 * thing that stops a venue going live, so this reads the spreadsheet instead.
 *
 * THE SHAPE OF IT
 *
 * One workbook, three sheets, applied in dependency order: `Departments`, then
 * `Sub Departments`, then `Products`. That order is not cosmetic — a product
 * naming a department that does not exist yet is the ordinary case in a file
 * somebody typed by hand, and doing the sheets in this order means the
 * department is there by the time the product needs it.
 *
 * Download the template first (`GET /api/import/template`). It is not merely a
 * convenience: it carries the exact column headings this parser looks for, so a
 * venue that fills it in cannot produce a file rejected for a heading it could
 * not have guessed.
 *
 * PREVIEW, THEN COMMIT
 *
 * Two endpoints over one parse. An import is the only operation in the back
 * office that can rewrite a whole catalogue, so "how many are new, how many
 * change, and what is wrong with row 41" has to be answerable *before*
 * anything is written. The preview is therefore the same code path as the
 * commit with the writes left out, rather than a second implementation that
 * can drift out of agreement with it.
 *
 * NOTHING IS EVER DELETED
 *
 * A row missing from the spreadsheet is not a product the venue wants gone. It
 * is far more likely a filter left on, or a sheet trimmed to the lines somebody
 * was changing. So an import creates and updates and does nothing else.
 * Deleting stays a deliberate act in the products screen, one row at a time,
 * which is the only place its consequence is visible.
 */

const express = require('express');
const multer = require('multer');
const ExcelJS = require('exceljs');

const { requireAuth } = require('./auth');

/** Four megabytes is a catalogue of tens of thousands of lines. */
const MAX_BYTES = 4 * 1024 * 1024;

/**
 * In memory, never on disk.
 *
 * The same reasoning as the font upload: a rejected file already written
 * somewhere is rubbish for somebody to find later. This one is rejected often —
 * that is what the preview is for.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1 },
});

const SHEET_DEPARTMENTS = 'Departments';
const SHEET_GROUPS = 'Sub Departments';
const SHEET_PRODUCTS = 'Products';
const SHEET_HELP = 'How to use this';

/** The kitchen stations a product may be routed to. Mirrors backoffice.js. */
const KP_STATIONS = ['kp1', 'kp2', 'kp3', 'kp4', 'kp5', 'kp6'];

/**
 * The columns of each sheet, in the order they appear.
 *
 * `key` is what the parser calls the value; `header` is what the venue reads.
 * Headings are matched case- and punctuation-insensitively (see `headerKey`),
 * so a file that has been through a few hands — a trailing space, "Sub
 * Department" with a capital D — still lines up.
 *
 * `width` is only for the generated template, and lives here rather than in
 * the writer so that adding a column is one edit in one place.
 */
const SHEETS = {
  [SHEET_DEPARTMENTS]: [
    { key: 'department_name', header: 'Department', width: 28, required: true },
    { key: 'accounting_code', header: 'Accounting code', width: 18 },
    { key: 'button_color', header: 'Button colour', width: 16 },
    { key: 'emoji', header: 'Emoji', width: 10 },
  ],
  [SHEET_GROUPS]: [
    { key: 'group_name', header: 'Sub department', width: 28, required: true },
    { key: 'accounting_code', header: 'Accounting code', width: 18 },
  ],
  [SHEET_PRODUCTS]: [
    { key: 'pluid', header: 'PLU', width: 10 },
    { key: 'product_name', header: 'Product', width: 34, required: true },
    { key: 'department_name', header: 'Department', width: 24 },
    { key: 'group_name', header: 'Sub department', width: 24 },
    { key: 'price', header: 'Price', width: 12, required: true },
    { key: 'tax_percentage', header: 'VAT %', width: 10 },
    { key: 'accounting_code', header: 'Accounting code', width: 18 },
    { key: 'stock_quantity', header: 'Stock', width: 10 },
    { key: 'button_color', header: 'Button colour', width: 16 },
    { key: 'printer_routes', header: 'Kitchen printers', width: 20 },
    { key: 'print_to_receipt', header: 'On receipt', width: 12 },
  ],
};

/** Rows the template ships with, so the format is shown rather than described. */
const EXAMPLES = {
  [SHEET_DEPARTMENTS]: [
    ['Drink', '4000', '#2F6FEB', ''],
    ['Food', '4100', '#E4572E', ''],
  ],
  [SHEET_GROUPS]: [
    ['Beers & Ciders', '4001'],
    ['Soft Drinks', '4002'],
    ['Mains', '4101'],
  ],
  [SHEET_PRODUCTS]: [
    ['', 'Lager Pint', 'Drink', 'Beers & Ciders', 4.6, 20, '', 0, '', '', 'Yes'],
    ['', 'Cola', 'Drink', 'Soft Drinks', 2.2, 20, '', 0, '', '', 'Yes'],
    ['', 'Cheeseburger', 'Food', 'Mains', 9.5, 20, '', 0, '', 'kp1', 'Yes'],
  ],
};

/** How a heading is matched: case, spacing and punctuation are all forgiven. */
const headerKey = (text) =>
  String(text === null || text === undefined ? '' : text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');

/**
 * A cell's value as text.
 *
 * ExcelJS hands back a bare value for a typed cell and an object for anything
 * with structure — a formula, a hyperlink, rich text. Unwrapping those is what
 * makes a pasted-in column of prices carrying a stray formula behave like the
 * numbers beside it, rather than arriving as "[object Object]".
 */
function cellText(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    if (Array.isArray(value.richText)) {
      return value.richText.map((part) => part.text).join('');
    }
    if ('result' in value) return cellText(value.result);
    if ('text' in value) return cellText(value.text);
    if ('hyperlink' in value) return cellText(value.hyperlink);
    return '';
  }
  return String(value);
}

/** Trimmed text, which is what almost every column wants. */
const clean = (value) => cellText(value).trim();

/**
 * Money, to the penny.
 *
 * Accepts what people actually type: a leading currency symbol, a thousands
 * separator, stray spaces. A decimal comma is deliberately NOT accepted —
 * guessing at "4,60" is how a £4.60 pint becomes £460.
 *
 * Returns undefined when it is not a number, so the caller can name the row
 * rather than importing a zero.
 */
function parseMoney(text) {
  const cleaned = String(text === null || text === undefined ? '' : text)
    .replace(/[£$€\s]/g, '')
    .replace(/,(?=\d{3}(\D|$))/g, '');
  if (cleaned === '') return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value) || value < 0) return undefined;
  // Two decimal places, because the column is money and a price of 4.599 is a
  // rounding argument waiting to happen at the till.
  return Math.round(value * 100) / 100;
}

/** A whole number. Blank is null; nonsense is undefined. */
function parseInteger(text) {
  const cleaned = String(text === null || text === undefined ? '' : text).trim();
  if (cleaned === '') return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value)) return undefined;
  return Math.trunc(value);
}

/** A percentage between 0 and 100. Blank is null; nonsense is undefined. */
function parsePercentage(text) {
  const cleaned = String(text === null || text === undefined ? '' : text)
    .replace(/%/g, '')
    .trim();
  if (cleaned === '') return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value) || value < 0 || value > 100) return undefined;
  return Math.round(value * 100) / 100;
}

/**
 * Yes / No, as a spreadsheet writes it.
 *
 * Excel turns a typed "yes" into a boolean in some locales and leaves it as
 * text in others, and somebody who types "Y" means the same thing. Anything
 * unrecognised is undefined rather than quietly defaulted: "On receipt" being
 * wrong is a product missing from a customer's bill.
 */
function parseYesNo(text) {
  const cleaned = String(text === null || text === undefined ? '' : text)
    .trim()
    .toLowerCase();
  if (cleaned === '') return null;
  if (['yes', 'y', 'true', '1', 'on'].includes(cleaned)) return 1;
  if (['no', 'n', 'false', '0', 'off'].includes(cleaned)) return 0;
  return undefined;
}

/** #RRGGBB. Blank is null; anything else unparseable is undefined. */
function parseColour(text) {
  const cleaned = String(text === null || text === undefined ? '' : text).trim();
  if (cleaned === '') return null;
  const hex = cleaned.startsWith('#') ? cleaned.slice(1) : cleaned;
  return /^[0-9a-fA-F]{6}$/.test(hex) ? `#${hex.toUpperCase()}` : undefined;
}

/**
 * Stations, as backoffice.js stores them.
 *
 * An unknown station is dropped rather than refused: a typo must not become a
 * route to a printer that does not exist, and refusing the whole row over one
 * would stop an import for something a manager can fix in the kitchen screen
 * in five seconds.
 */
function parseRoutes(text) {
  const seen = new Set();
  for (const raw of String(text === null || text === undefined ? '' : text).split(',')) {
    const key = raw.trim().toLowerCase();
    if (!key) continue;
    const station = key === 'kitchen' ? 'kp1' : key === 'bar' ? 'kp2' : key;
    if (KP_STATIONS.includes(station)) seen.add(station);
  }
  const routes = KP_STATIONS.filter((station) => seen.has(station));
  return routes.length ? routes.join(',') : null;
}

/** The single station an older till should use. Mirrors backoffice.js. */
function legacyRoute(routes) {
  if (!routes) return null;
  const first = routes.split(',')[0];
  return first === 'kp1' ? 'kitchen' : first === 'kp2' ? 'bar' : first;
}

/**
 * Map a sheet's headings onto column keys.
 *
 * Returns a map of key -> column number, plus the headings it did not
 * recognise. Unrecognised headings are reported rather than ignored: a venue
 * that adds a "Supplier" column should be told it was not imported, instead of
 * discovering months later that it never was.
 */
function readHeader(worksheet, columns) {
  const wanted = new Map(columns.map((c) => [headerKey(c.header), c.key]));
  const found = new Map();
  const unknown = [];

  const header = worksheet.getRow(1);
  header.eachCell({ includeEmpty: false }, (cell, columnNumber) => {
    const text = clean(cell.value);
    if (!text) return;
    const key = wanted.get(headerKey(text));
    if (key) {
      // First one wins. A duplicated heading is a copy-paste, and reading the
      // second would silently prefer the emptier of the two.
      if (!found.has(key)) found.set(key, columnNumber);
    } else {
      unknown.push(text);
    }
  });

  return { found, unknown };
}

/**
 * Every filled row of a sheet, as `{ row, values }`.
 *
 * `row` is the spreadsheet's own 1-based row number, carried all the way
 * through to the errors shown in the back office. "Row 41" has to mean row 41
 * in the file the venue is looking at, not the 39th data row.
 *
 * Entirely blank rows are skipped rather than reported. A spreadsheet is full
 * of them — a gap between sections, a row somebody cleared — and complaining
 * about each one buries the errors that matter.
 */
function readRows(worksheet, columns) {
  const { found, unknown } = readHeader(worksheet, columns);
  const rows = [];

  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;

    const values = {};
    let anything = false;
    for (const [key, columnNumber] of found) {
      const text = clean(row.getCell(columnNumber).value);
      values[key] = text;
      if (text !== '') anything = true;
    }
    if (anything) rows.push({ row: rowNumber, values });
  });

  return { rows, found, unknown };
}

/** A collector for per-sheet problems, so every error carries its row. */
function makeReport(sheet) {
  const errors = [];
  return {
    sheet,
    errors,
    fail(row, message) {
      // Capped, because a file with the wrong headings produces one error per
      // row and a thousand of them is not more informative than twenty.
      if (errors.length < 50) errors.push({ row, message });
    },
  };
}

module.exports = {
  MAX_BYTES,
  KP_STATIONS,
  SHEETS,
  SHEET_DEPARTMENTS,
  SHEET_GROUPS,
  SHEET_PRODUCTS,
  SHEET_HELP,
  EXAMPLES,
  headerKey,
  cellText,
  clean,
  parseMoney,
  parseInteger,
  parsePercentage,
  parseYesNo,
  parseColour,
  parseRoutes,
  legacyRoute,
  readHeader,
  readRows,
  makeReport,
  buildTemplate,
  importRoutes,
};

// ---------------------------------------------------------------------------
// The template
// ---------------------------------------------------------------------------

/**
 * The workbook a venue fills in.
 *
 * Built rather than checked in as a binary, because the headings it carries
 * have to be the ones the parser looks for. A checked-in .xlsx is a copy of the
 * truth that goes stale the first time a column is added, and the failure is
 * silent: the venue fills in a column nothing reads.
 */
async function buildTemplate() {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Vesopa EPOS';
  workbook.created = new Date();

  const help = workbook.addWorksheet(SHEET_HELP);
  help.getColumn(1).width = 100;
  const lines = [
    ['Importing your catalogue', true],
    ['', false],
    ['Fill in the three sheets in this workbook and upload it in the back', false],
    ['office under Till Programming > Import.', false],
    ['', false],
    ['The order matters. Departments are created first, then sub departments,', false],
    ['then products — so a product can name a department you have only just', false],
    ['added on the first sheet.', false],
    ['', false],
    ['Nothing is ever deleted by an import. A row you leave out is left alone,', false],
    ['not removed. Rows that already exist are updated; new ones are created.', false],
    ['', false],
    ['A product is matched on its PLU if you give one. Leave PLU blank and we', false],
    ['allocate the next free number — which is what you want unless you are', false],
    ['deliberately keeping numbers from an old till.', false],
    ['', false],
    ['Price is in pounds, so 4.60 means four pounds sixty.', false],
    ['VAT % is a number like 20. Leave it blank for 20.', false],
    ['On receipt is Yes or No. Leave it blank for Yes.', false],
    ['Kitchen printers is a comma-separated list of kp1 to kp6, or blank for', false],
    ['a product that does not go to the kitchen.', false],
    ['Button colour is a hex colour like #2F6FEB, or blank for the till default.', false],
    ['', false],
    ['The example rows on each sheet are there to show the format. Delete them', false],
    ['before you upload, or leave them and they will be imported as products.', false],
    ['', false],
    ['You can always upload and press Check first: nothing is written until you', false],
    ['press Import, and Check tells you exactly what would change.', false],
  ];
  lines.forEach(([text, bold], index) => {
    const cell = help.getCell(index + 1, 1);
    cell.value = text;
    if (bold) cell.font = { bold: true, size: 14 };
  });

  for (const [name, columns] of Object.entries(SHEETS)) {
    const sheet = workbook.addWorksheet(name);
    sheet.columns = columns.map((column) => ({
      header: column.header,
      key: column.key,
      width: column.width,
    }));

    const header = sheet.getRow(1);
    header.font = { bold: true };
    header.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFEFEFEF' },
    };
    // Frozen so the headings stay visible on a sheet four hundred rows long,
    // which is the length that makes this feature worth having.
    sheet.views = [{ state: 'frozen', ySplit: 1 }];

    for (const example of EXAMPLES[name] || []) sheet.addRow(example);
  }

  return workbook.xlsx.writeBuffer();
}

// ---------------------------------------------------------------------------
// Reading a venue's file
// ---------------------------------------------------------------------------

/**
 * Parse the whole workbook into the three sheets' worth of rows, validated.
 *
 * Returns `{ departments, groups, products, sheets }`, where each of the first
 * three is an array of ready-to-write records and `sheets` carries the per-
 * sheet errors and warnings for the preview to show.
 *
 * Validation happens here and nowhere else. The commit re-parses the same file
 * and gets the same answer, which is what makes "Check" honest.
 */
function parseWorkbook(workbook) {
  const sheets = [];

  function sheetFor(name) {
    // Case-insensitive, because a venue that retypes a sheet name will not
    // match the capitals, and refusing the file over that is absurd.
    const wanted = name.toLowerCase();
    return workbook.worksheets.find(
      (sheet) => String(sheet.name).trim().toLowerCase() === wanted
    );
  }

  function collect(name, parseRow) {
    const worksheet = sheetFor(name);
    const report = makeReport(name);
    if (!worksheet) {
      // Absent is allowed, on purpose: a venue changing only its prices should
      // be able to upload a workbook with just the Products sheet in it.
      sheets.push({ ...report, present: false, unknownColumns: [], records: [] });
      return [];
    }

    const { rows, found, unknown } = readRows(worksheet, SHEETS[name]);

    // A required column that is not there at all is a file-level problem, and
    // is said once rather than once per row.
    const missing = SHEETS[name]
      .filter((column) => column.required && !found.has(column.key))
      .map((column) => column.header);
    if (missing.length) {
      report.fail(1, `This sheet has no ${missing.join(' or ')} column.`);
      sheets.push({ ...report, present: true, unknownColumns: unknown, records: [] });
      return [];
    }

    const records = [];
    for (const { row, values } of rows) {
      const record = parseRow(values, row, report);
      if (record) records.push({ ...record, row });
    }
    sheets.push({ ...report, present: true, unknownColumns: unknown, records });
    return records;
  }

  const departments = collect(SHEET_DEPARTMENTS, (values, row, report) => {
    const name = values.department_name || '';
    if (!name) {
      report.fail(row, 'A department needs a name.');
      return null;
    }
    const colour = parseColour(values.button_color);
    if (colour === undefined) {
      report.fail(row, `"${values.button_color}" is not a colour like #2F6FEB.`);
      return null;
    }
    return {
      department_name: name,
      accounting_code: values.accounting_code || null,
      button_color: colour,
      emoji: values.emoji || null,
    };
  });

  const groups = collect(SHEET_GROUPS, (values, row, report) => {
    const name = values.group_name || '';
    if (!name) {
      report.fail(row, 'A sub department needs a name.');
      return null;
    }
    return {
      group_name: name,
      accounting_code: values.accounting_code || null,
    };
  });

  const products = collect(SHEET_PRODUCTS, (values, row, report) => {
    const name = values.product_name || '';
    if (!name) {
      report.fail(row, 'A product needs a name.');
      return null;
    }

    const pluid = parseInteger(values.pluid);
    if (pluid === undefined || (pluid !== null && pluid <= 0)) {
      report.fail(row, `"${values.pluid}" is not a PLU number.`);
      return null;
    }

    const price = parseMoney(values.price);
    if (price === undefined) {
      report.fail(row, `"${values.price}" is not a price.`);
      return null;
    }
    if (price === null) {
      report.fail(row, 'This product has no price.');
      return null;
    }

    const tax = parsePercentage(values.tax_percentage);
    if (tax === undefined) {
      report.fail(row, `"${values.tax_percentage}" is not a VAT percentage.`);
      return null;
    }

    const stock = parseInteger(values.stock_quantity);
    if (stock === undefined) {
      report.fail(row, `"${values.stock_quantity}" is not a stock figure.`);
      return null;
    }

    const colour = parseColour(values.button_color);
    if (colour === undefined) {
      report.fail(row, `"${values.button_color}" is not a colour like #2F6FEB.`);
      return null;
    }

    const onReceipt = parseYesNo(values.print_to_receipt);
    if (onReceipt === undefined) {
      report.fail(row, `"${values.print_to_receipt}" is not Yes or No.`);
      return null;
    }

    return {
      pluid,
      product_name: name,
      department_name: values.department_name || null,
      group_name: values.group_name || null,
      price,
      tax_percentage: tax === null ? 20 : tax,
      accounting_code: values.accounting_code || null,
      stock_quantity: stock === null ? 0 : stock,
      button_color: colour,
      printer_routes: parseRoutes(values.printer_routes),
      print_to_receipt: onReceipt === null ? 1 : onReceipt,
    };
  });

  return { departments, groups, products, sheets };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

function importRoutes({ pool, broadcast, secret }) {
  const router = express.Router();
  const auth = requireAuth(secret);

  /** The office's key, not the individual's. Mirrors backoffice.js. */
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

  router.get('/import/template', auth, async (_req, res, next) => {
    try {
      const buffer = await buildTemplate();
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      res.setHeader(
        'Content-Disposition',
        'attachment; filename="vesopa-catalogue-template.xlsx"'
      );
      res.send(Buffer.from(buffer));
    } catch (e) {
      next(e);
    }
  });

  /**
   * What the file would do, without doing it.
   *
   * `apply` false is the preview and true is the import; everything up to the
   * writes is shared, which is the only way the preview can be trusted.
   */
  async function run(req, res, apply) {
    if (!req.file) {
      return res.status(400).json({ error: 'No file was uploaded.' });
    }

    const workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.load(req.file.buffer);
    } catch (e) {
      return res.status(400).json({
        error:
          'That file could not be read as an Excel workbook. Save it as .xlsx ' +
          'and try again.',
      });
    }

    const parsed = parseWorkbook(workbook);
    const email = await tenantEmail(req);

    // What is already there, so create and update can be told apart before a
    // single row is written.
    const [departmentRows] = await pool.query(
      'SELECT id, department_name FROM bo_product_departments WHERE email = ?',
      [email]
    );
    const [groupRows] = await pool.query(
      'SELECT id, group_name FROM bo_product_groups WHERE email = ?',
      [email]
    );
    const [productRows] = await pool.query(
      `SELECT id, pluid, product_name, department_name
         FROM bo_products WHERE email = ?`,
      [email]
    );

    // Matched case-insensitively throughout. "drink" and "Drink" are one
    // department to everybody except a database, and an import that creates
    // the second is an import that splits a venue's sales report in two.
    const key = (text) => String(text || '').trim().toLowerCase();
    const departmentsByName = new Map(
      departmentRows.map((r) => [key(r.department_name), r])
    );
    const groupsByName = new Map(groupRows.map((r) => [key(r.group_name), r]));
    const productsByPlu = new Map(productRows.map((r) => [Number(r.pluid), r]));
    const productsByName = new Map(
      productRows.map((r) => [`${key(r.product_name)} ${key(r.department_name)}`, r])
    );

    let nextPlu =
      productRows.reduce((max, r) => Math.max(max, Number(r.pluid) || 0), 0) + 1;

    const summary = {
      departments: { created: 0, updated: 0 },
      groups: { created: 0, updated: 0 },
      products: { created: 0, updated: 0 },
    };

    const blocking = parsed.sheets.some((sheet) => sheet.errors.length > 0);
    // A file with errors is never partially applied. Half a catalogue is worse
    // than none: it is the state nobody can reason about, and the venue cannot
    // tell which half went in.
    const willApply = apply && !blocking;

    const conn = willApply ? await pool.getConnection() : null;
    try {
      if (conn) await conn.beginTransaction();
      const run1 = (sql, params) =>
        conn ? conn.execute(sql, params) : Promise.resolve([{}]);

      // ---- Departments, first, so a product can name one -------------------
      for (const record of parsed.departments) {
        const existing = departmentsByName.get(key(record.department_name));
        if (existing) {
          summary.departments.updated += 1;
          // COALESCE on the incoming value, not the stored one: a blank cell
          // means "leave this alone", not "clear it". A venue correcting one
          // department's colour must not blank the other twelve's codes.
          await run1(
            `UPDATE bo_product_departments
                SET accounting_code = COALESCE(?, accounting_code),
                    button_color    = COALESCE(?, button_color),
                    emoji           = COALESCE(?, emoji)
              WHERE id = ? AND email = ?`,
            [
              record.accounting_code,
              record.button_color,
              record.emoji,
              existing.id,
              email,
            ]
          );
        } else {
          summary.departments.created += 1;
          await run1(
            `INSERT INTO bo_product_departments
               (email, department_name, accounting_code, button_color, emoji)
             VALUES (?, ?, ?, ?, ?)`,
            [
              email,
              record.department_name,
              record.accounting_code,
              record.button_color,
              record.emoji,
            ]
          );
          // Recorded even in preview, so two rows naming the same new
          // department count as one creation rather than two.
          departmentsByName.set(key(record.department_name), { id: 0 });
        }
      }

      // ---- Sub departments -------------------------------------------------
      for (const record of parsed.groups) {
        const existing = groupsByName.get(key(record.group_name));
        if (existing) {
          summary.groups.updated += 1;
          await run1(
            `UPDATE bo_product_groups
                SET accounting_code = COALESCE(?, accounting_code)
              WHERE id = ? AND email = ?`,
            [record.accounting_code, existing.id, email]
          );
        } else {
          summary.groups.created += 1;
          await run1(
            `INSERT INTO bo_product_groups (email, group_name, accounting_code)
             VALUES (?, ?, ?)`,
            [email, record.group_name, record.accounting_code]
          );
          groupsByName.set(key(record.group_name), { id: 0 });
        }
      }

      // ---- Products --------------------------------------------------------
      for (const record of parsed.products) {
        // A PLU wins if one is given: it is the catalogue's key, and a venue
        // that supplies it is telling us which row it means. Otherwise the
        // product is matched on its name within its department, which is what
        // a manager re-uploading a corrected price sheet expects.
        const existing =
          record.pluid !== null
            ? productsByPlu.get(record.pluid)
            : productsByName.get(
                `${key(record.product_name)} ${key(record.department_name)}`
              );

        if (existing) {
          summary.products.updated += 1;
          await run1(
            `UPDATE bo_products
                SET product_name    = ?,
                    department_name = COALESCE(?, department_name),
                    group_name      = COALESCE(?, group_name),
                    accounting_code = COALESCE(?, accounting_code),
                    price           = ?,
                    tax_percentage  = ?,
                    stock_quantity  = ?,
                    button_color    = COALESCE(?, button_color),
                    printer_route   = COALESCE(?, printer_route),
                    printer_routes  = COALESCE(?, printer_routes),
                    print_to_receipt = ?
              WHERE id = ? AND email = ?`,
            [
              record.product_name,
              record.department_name,
              record.group_name,
              record.accounting_code,
              record.price,
              record.tax_percentage,
              record.stock_quantity,
              record.button_color,
              legacyRoute(record.printer_routes),
              record.printer_routes,
              record.print_to_receipt,
              existing.id,
              email,
            ]
          );
        } else {
          summary.products.created += 1;
          const pluid = record.pluid !== null ? record.pluid : nextPlu++;
          await run1(
            `INSERT INTO bo_products
               (email, pluid, product_name, department_name, group_name,
                accounting_code, price, tax_percentage, stock_quantity,
                button_color, printer_route, printer_routes, print_to_receipt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              email,
              pluid,
              record.product_name,
              record.department_name,
              record.group_name,
              record.accounting_code,
              record.price,
              record.tax_percentage,
              record.stock_quantity,
              record.button_color,
              legacyRoute(record.printer_routes),
              record.printer_routes,
              record.print_to_receipt,
            ]
          );
          // Held so a second row with the same PLU in the same file updates
          // this one rather than inserting a duplicate the till cannot reach.
          const placeholder = { id: 0, pluid };
          productsByPlu.set(pluid, placeholder);
          productsByName.set(
            `${key(record.product_name)} ${key(record.department_name)}`,
            placeholder
          );
        }
      }

      if (conn) await conn.commit();
    } catch (e) {
      if (conn) await conn.rollback();
      throw e;
    } finally {
      if (conn) conn.release();
    }

    if (willApply) {
      // Tills hold a local copy of the catalogue; tell them to refresh it.
      broadcast({ type: 'catalogue.updated' });
    }

    res.json({
      applied: willApply,
      blocked: blocking,
      summary,
      sheets: parsed.sheets.map((sheet) => ({
        sheet: sheet.sheet,
        present: sheet.present,
        rows: sheet.records.length,
        errors: sheet.errors,
        unknownColumns: sheet.unknownColumns,
      })),
    });
  }

  router.post(
    '/import/catalogue/preview',
    auth,
    upload.single('file'),
    async (req, res, next) => {
      try {
        await run(req, res, false);
      } catch (e) {
        next(e);
      }
    }
  );

  router.post(
    '/import/catalogue',
    auth,
    upload.single('file'),
    async (req, res, next) => {
      try {
        await run(req, res, true);
      } catch (e) {
        next(e);
      }
    }
  );

  return router;
}

module.exports.parseWorkbook = parseWorkbook;
