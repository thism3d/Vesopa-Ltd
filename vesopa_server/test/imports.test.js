/**
 * Importing a catalogue from a spreadsheet.
 *
 * Run with `npm test`. No MySQL: the queries are answered from a script, as in
 * fonts.test.js and screens.test.js.
 *
 * The thing worth guarding here is not the happy path — a clean file with clean
 * columns will always work. It is everything a real venue's spreadsheet does:
 *
 *   * a price typed as "£4.60", or with a thousands separator;
 *   * "Sub Department" where the template says "Sub department";
 *   * a blank cell, which must mean "leave it alone" and not "clear it";
 *   * two rows for the same product, which must not produce two products;
 *   * "drink" and "Drink", which are one department to everybody except a
 *     database — and two departments is a sales report split in half;
 *   * an error on row 41, which must be reported as row 41.
 *
 * And the promise the whole feature rests on: a file with any error in it
 * writes nothing at all. Half an imported catalogue is the state nobody can
 * reason about.
 */

const assert = require('assert');

const express = require('express');
const jwt = require('jsonwebtoken');
const ExcelJS = require('exceljs');

const {
  importRoutes,
  buildTemplate,
  parseWorkbook,
  parseMoney,
  parsePercentage,
  parseYesNo,
  parseColour,
  parseRoutes,
  headerKey,
  SHEET_DEPARTMENTS,
  SHEET_GROUPS,
  SHEET_PRODUCTS,
  SHEETS,
} = require('../src/imports');

const SECRET = 'test-secret-not-a-real-one';

let passed = 0;
const checks = [];
function check(name, fn) {
  checks.push({ name, fn });
}

/**
 * A pool that answers from a script and records every write.
 *
 * `written` is what most of these assert on: the point of an import is the
 * INSERTs and UPDATEs it does, and a preview's whole promise is that it does
 * none of them.
 */
function fakePool(script = []) {
  const written = [];
  const answer = (sql, params) => {
    const flat = sql.replace(/\s+/g, ' ').trim();
    if (/^(INSERT|UPDATE|DELETE)/i.test(flat)) written.push({ sql: flat, params });
    for (const [pattern, rows] of script) {
      if (flat.includes(pattern)) return [rows, []];
    }
    return [[], []];
  };
  const pool = {
    written,
    query: async (sql, params) => answer(sql, params),
    execute: async (sql, params) => answer(sql, params),
    getConnection: async () => ({
      execute: async (sql, params) => answer(sql, params),
      beginTransaction: async () => {},
      commit: async () => {},
      rollback: async () => {
        // A rollback throws away everything the transaction wrote, so the
        // recording has to as well — otherwise a test cannot tell a rolled-back
        // import from an applied one.
        written.length = 0;
      },
      release: () => {},
    }),
  };
  return pool;
}

function appWith(pool, broadcast = () => {}) {
  const app = express();
  app.use(express.json());
  app.use('/api', importRoutes({ pool, broadcast, secret: SECRET }));
  app.use((err, _req, res, _next) => {
    res.status(500).json({ error: String(err) });
  });
  return app;
}

const listen = (app) =>
  new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });

const token = () =>
  jwt.sign({ email: 'manager@vesopa.co.uk', role: 'manager' }, SECRET);

/** Post a workbook the way the browser does. */
async function send(server, path, buffer, { name = 'catalogue.xlsx' } = {}) {
  const form = new FormData();
  form.append('file', new Blob([buffer]), name);
  const res = await fetch(
    `http://127.0.0.1:${server.address().port}${path}`,
    { method: 'POST', headers: { Authorization: `Bearer ${token()}` }, body: form }
  );
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, body: json };
}

/**
 * Build a workbook from plain arrays, so a test reads as the spreadsheet it is
 * standing in for. `undefined` sheets are simply absent, which is itself a case
 * worth covering — a venue changing only its prices uploads a Products sheet
 * and nothing else.
 */
async function workbookOf(sheets) {
  const workbook = new ExcelJS.Workbook();
  for (const [name, rows] of Object.entries(sheets)) {
    if (!rows) continue;
    const sheet = workbook.addWorksheet(name);
    for (const row of rows) sheet.addRow(row);
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/** The template's own headings, so a test cannot drift from the real ones. */
const headersOf = (name) => SHEETS[name].map((column) => column.header);

// ---------------------------------------------------------------------------
// The parsers
// ---------------------------------------------------------------------------

check('a price is read the way a venue types it', () => {
  assert.strictEqual(parseMoney('4.60'), 4.6);
  assert.strictEqual(parseMoney('£4.60'), 4.6);
  assert.strictEqual(parseMoney(' 1,250.00 '), 1250);
  assert.strictEqual(parseMoney('0'), 0);
});

check('and a price that is not one is refused rather than zeroed', () => {
  assert.strictEqual(parseMoney('free'), undefined);
  assert.strictEqual(parseMoney('-2'), undefined);
  // Blank is null — "no price given" — which the caller reports separately
  // from "that is not a number".
  assert.strictEqual(parseMoney(''), null);
});

check('a decimal comma is refused, not guessed at', () => {
  // "4,60" as four pounds sixty is a European convention. Guessing wrong here
  // turns a £4.60 pint into £460 on somebody's bill.
  assert.strictEqual(parseMoney('4,60'), undefined);
});

check('VAT is a percentage, and 200% is not one', () => {
  assert.strictEqual(parsePercentage('20'), 20);
  assert.strictEqual(parsePercentage('20%'), 20);
  assert.strictEqual(parsePercentage('0'), 0);
  assert.strictEqual(parsePercentage('200'), undefined);
  assert.strictEqual(parsePercentage(''), null);
});

check('Yes and No are read however they were typed', () => {
  for (const yes of ['Yes', 'y', 'TRUE', '1', 'on']) {
    assert.strictEqual(parseYesNo(yes), 1, yes);
  }
  for (const no of ['No', 'n', 'false', '0', 'OFF']) {
    assert.strictEqual(parseYesNo(no), 0, no);
  }
  assert.strictEqual(parseYesNo('sometimes'), undefined);
});

check('a colour is hex, with or without the hash', () => {
  assert.strictEqual(parseColour('#2f6feb'), '#2F6FEB');
  assert.strictEqual(parseColour('2f6feb'), '#2F6FEB');
  assert.strictEqual(parseColour('red'), undefined);
  assert.strictEqual(parseColour(''), null);
});

check('kitchen routes drop what does not exist rather than failing', () => {
  assert.strictEqual(parseRoutes('kitchen, kp3'), 'kp1,kp3');
  // Stored in station order, so "kp3,kp1" and "kp1,kp3" are one routing.
  assert.strictEqual(parseRoutes('kp3,kp1'), 'kp1,kp3');
  assert.strictEqual(parseRoutes('kp9'), null);
  assert.strictEqual(parseRoutes(''), null);
});

check('a heading matches however it was capitalised or spaced', () => {
  assert.strictEqual(headerKey(' Sub Department '), headerKey('sub department'));
  assert.strictEqual(headerKey('Sub-Department'), headerKey('subdepartment'));
  assert.strictEqual(headerKey('VAT %'), headerKey('vat'));
});

// ---------------------------------------------------------------------------
// The template
// ---------------------------------------------------------------------------

check('the template it hands out is one it can read back', async () => {
  // The point of generating rather than checking in a binary: the headings the
  // venue fills in are the headings the parser looks for, by construction.
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await buildTemplate());

  const parsed = parseWorkbook(workbook);
  for (const sheet of parsed.sheets) {
    assert.deepStrictEqual(sheet.errors, [], `${sheet.sheet} had errors`);
    assert.strictEqual(sheet.present, true, `${sheet.sheet} is missing`);
  }
  assert.strictEqual(parsed.departments.length, 2);
  assert.strictEqual(parsed.groups.length, 3);
  assert.strictEqual(parsed.products.length, 3);
  assert.strictEqual(parsed.products[0].product_name, 'Lager Pint');
  assert.strictEqual(parsed.products[0].price, 4.6);
  assert.strictEqual(parsed.products[2].printer_routes, 'kp1');
});

check('and it carries a sheet explaining itself', async () => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await buildTemplate());
  const names = workbook.worksheets.map((s) => s.name);
  assert.ok(names.includes(SHEET_DEPARTMENTS));
  assert.ok(names.includes(SHEET_GROUPS));
  assert.ok(names.includes(SHEET_PRODUCTS));
  assert.strictEqual(names.length, 4, 'expected the three sheets and the help');
});

// ---------------------------------------------------------------------------
// Reading a venue's file
// ---------------------------------------------------------------------------

async function parseOf(sheets) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await workbookOf(sheets));
  return parseWorkbook(workbook);
}

check('a sheet left out of the workbook is allowed', async () => {
  // A venue changing only its prices uploads Products and nothing else.
  const parsed = await parseOf({
    [SHEET_PRODUCTS]: [headersOf(SHEET_PRODUCTS), ['', 'Cola', 'Drink', '', 2.2]],
  });
  assert.deepStrictEqual(parsed.sheets.flatMap((s) => s.errors), []);
  assert.strictEqual(parsed.products.length, 1);
  assert.strictEqual(parsed.departments.length, 0);
});

check('an error names the row the venue is looking at', async () => {
  const rows = [headersOf(SHEET_PRODUCTS)];
  // Header is row 1, so 39 good rows fill 2 to 40 and the bad one is row 41.
  for (let i = 0; i < 39; i++) rows.push(['', `Product ${i}`, 'Drink', '', 1]);
  rows.push(['', 'Broken', 'Drink', '', 'free']);

  const parsed = await parseOf({ [SHEET_PRODUCTS]: rows });
  const sheet = parsed.sheets.find((s) => s.sheet === SHEET_PRODUCTS);
  assert.strictEqual(sheet.errors.length, 1);
  assert.strictEqual(sheet.errors[0].row, 41);
  assert.match(sheet.errors[0].message, /not a price/);
});

check('blank rows in the middle are skipped, not complained about', async () => {
  const parsed = await parseOf({
    [SHEET_PRODUCTS]: [
      headersOf(SHEET_PRODUCTS),
      ['', 'Cola', 'Drink', '', 2.2],
      [],
      ['', '', '', '', ''],
      ['', 'Lemonade', 'Drink', '', 2.2],
    ],
  });
  const sheet = parsed.sheets.find((s) => s.sheet === SHEET_PRODUCTS);
  assert.deepStrictEqual(sheet.errors, []);
  assert.strictEqual(parsed.products.length, 2);
});

check('a column the venue added is reported, not silently dropped', async () => {
  const parsed = await parseOf({
    [SHEET_PRODUCTS]: [
      [...headersOf(SHEET_PRODUCTS), 'Supplier'],
      ['', 'Cola', 'Drink', '', 2.2, 20, '', 0, '', '', 'Yes', 'Britvic'],
    ],
  });
  const sheet = parsed.sheets.find((s) => s.sheet === SHEET_PRODUCTS);
  assert.deepStrictEqual(sheet.unknownColumns, ['Supplier']);
  // ...and the row still imports. An extra column is not a reason to refuse a
  // catalogue.
  assert.strictEqual(parsed.products.length, 1);
});

check('a missing required column is said once, not once per row', async () => {
  const parsed = await parseOf({
    [SHEET_PRODUCTS]: [
      ['PLU', 'Department', 'Price'],
      ['', 'Drink', 2.2],
      ['', 'Drink', 3.3],
    ],
  });
  const sheet = parsed.sheets.find((s) => s.sheet === SHEET_PRODUCTS);
  assert.strictEqual(sheet.errors.length, 1);
  assert.match(sheet.errors[0].message, /no Product column/);
});

check('a blank VAT and On receipt take the sensible default', async () => {
  const parsed = await parseOf({
    [SHEET_PRODUCTS]: [headersOf(SHEET_PRODUCTS), ['', 'Cola', 'Drink', '', 2.2]],
  });
  assert.strictEqual(parsed.products[0].tax_percentage, 20);
  assert.strictEqual(parsed.products[0].print_to_receipt, 1);
  assert.strictEqual(parsed.products[0].stock_quantity, 0);
});

// ---------------------------------------------------------------------------
// What it writes
// ---------------------------------------------------------------------------

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

  // The route-level checks need a server, so they run here rather than through
  // the plain `check` list above.
  const routeChecks = [];
  const route = (name, fn) => routeChecks.push({ name, fn });

  route('a preview writes absolutely nothing', async () => {
    const pool = fakePool();
    const server = await listen(appWith(pool));
    try {
      const file = await workbookOf({
        [SHEET_DEPARTMENTS]: [headersOf(SHEET_DEPARTMENTS), ['Drink']],
        [SHEET_PRODUCTS]: [headersOf(SHEET_PRODUCTS), ['', 'Cola', 'Drink', '', 2.2]],
      });
      const res = await send(server, '/api/import/catalogue/preview', file);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.applied, false);
      assert.strictEqual(res.body.summary.departments.created, 1);
      assert.strictEqual(res.body.summary.products.created, 1);
      assert.deepStrictEqual(pool.written, [], 'the preview wrote to the database');
    } finally {
      server.close();
    }
  });

  route('and the import writes what the preview promised', async () => {
    const pool = fakePool();
    const server = await listen(appWith(pool));
    try {
      const file = await workbookOf({
        [SHEET_DEPARTMENTS]: [headersOf(SHEET_DEPARTMENTS), ['Drink']],
        [SHEET_PRODUCTS]: [headersOf(SHEET_PRODUCTS), ['', 'Cola', 'Drink', '', 2.2]],
      });
      const res = await send(server, '/api/import/catalogue', file);
      assert.strictEqual(res.body.applied, true);
      assert.strictEqual(res.body.summary.departments.created, 1);
      assert.strictEqual(res.body.summary.products.created, 1);

      const inserts = pool.written.filter((w) => w.sql.startsWith('INSERT'));
      assert.strictEqual(inserts.length, 2);
      assert.ok(inserts[0].sql.includes('bo_product_departments'));
      assert.ok(inserts[1].sql.includes('bo_products'));
      // Departments first, so the product can name one that has only just
      // been created.
      assert.ok(
        pool.written.findIndex((w) => w.sql.includes('bo_product_departments')) <
          pool.written.findIndex((w) => w.sql.includes('bo_products'))
      );
    } finally {
      server.close();
    }
  });

  route('a file with one bad row writes nothing at all', async () => {
    const pool = fakePool();
    const server = await listen(appWith(pool));
    try {
      const file = await workbookOf({
        [SHEET_PRODUCTS]: [
          headersOf(SHEET_PRODUCTS),
          ['', 'Cola', 'Drink', '', 2.2],
          ['', 'Broken', 'Drink', '', 'free'],
        ],
      });
      const res = await send(server, '/api/import/catalogue', file);
      assert.strictEqual(res.body.applied, false);
      assert.strictEqual(res.body.blocked, true);
      assert.deepStrictEqual(pool.written, [], 'a blocked import still wrote');
    } finally {
      server.close();
    }
  });

  route('an existing department is updated, not duplicated', async () => {
    const pool = fakePool([
      // Stored with a capital D; the sheet says "drink".
      ['FROM bo_product_departments', [{ id: 7, department_name: 'Drink' }]],
    ]);
    const server = await listen(appWith(pool));
    try {
      const file = await workbookOf({
        [SHEET_DEPARTMENTS]: [headersOf(SHEET_DEPARTMENTS), ['drink', '4000']],
      });
      const res = await send(server, '/api/import/catalogue', file);
      assert.strictEqual(res.body.summary.departments.created, 0);
      assert.strictEqual(res.body.summary.departments.updated, 1);
      const writes = pool.written.filter((w) => w.sql.includes('bo_product_departments'));
      assert.strictEqual(writes.length, 1);
      assert.ok(writes[0].sql.startsWith('UPDATE'));
    } finally {
      server.close();
    }
  });

  route('a blank cell leaves the stored value alone', async () => {
    const pool = fakePool([
      ['FROM bo_product_departments', [{ id: 7, department_name: 'Drink' }]],
    ]);
    const server = await listen(appWith(pool));
    try {
      // Only the colour is filled in. The accounting code column is blank, and
      // must not blank the code already stored.
      const file = await workbookOf({
        [SHEET_DEPARTMENTS]: [headersOf(SHEET_DEPARTMENTS), ['Drink', '', '#2F6FEB']],
      });
      await send(server, '/api/import/catalogue', file);
      const update = pool.written.find((w) => w.sql.includes('bo_product_departments'));
      assert.ok(update.sql.includes('COALESCE(?, accounting_code)'));
      assert.strictEqual(update.params[0], null, 'a blank cell must arrive as null');
      assert.strictEqual(update.params[1], '#2F6FEB');
    } finally {
      server.close();
    }
  });

  route('a product is matched on its PLU when one is given', async () => {
    const pool = fakePool([
      [
        'FROM bo_products',
        [{ id: 3, pluid: 42, product_name: 'Cola', department_name: 'Drink' }],
      ],
    ]);
    const server = await listen(appWith(pool));
    try {
      // A different name against the same PLU: the PLU is the key, so this is
      // a rename, not a new product.
      const file = await workbookOf({
        [SHEET_PRODUCTS]: [headersOf(SHEET_PRODUCTS), [42, 'Cola 330ml', 'Drink', '', 2.4]],
      });
      const res = await send(server, '/api/import/catalogue', file);
      assert.strictEqual(res.body.summary.products.created, 0);
      assert.strictEqual(res.body.summary.products.updated, 1);
    } finally {
      server.close();
    }
  });

  route('and on its name within its department when one is not', async () => {
    const pool = fakePool([
      [
        'FROM bo_products',
        [{ id: 3, pluid: 42, product_name: 'Cola', department_name: 'Drink' }],
      ],
    ]);
    const server = await listen(appWith(pool));
    try {
      const file = await workbookOf({
        [SHEET_PRODUCTS]: [headersOf(SHEET_PRODUCTS), ['', 'cola', 'drink', '', 2.4]],
      });
      const res = await send(server, '/api/import/catalogue', file);
      assert.strictEqual(res.body.summary.products.updated, 1, 'should have matched');
      assert.strictEqual(res.body.summary.products.created, 0);
    } finally {
      server.close();
    }
  });

  route('the same product twice in one file is one product', async () => {
    const pool = fakePool();
    const server = await listen(appWith(pool));
    try {
      const file = await workbookOf({
        [SHEET_PRODUCTS]: [
          headersOf(SHEET_PRODUCTS),
          ['', 'Cola', 'Drink', '', 2.2],
          ['', 'Cola', 'Drink', '', 2.4],
        ],
      });
      const res = await send(server, '/api/import/catalogue', file);
      assert.strictEqual(res.body.summary.products.created, 1);
      assert.strictEqual(res.body.summary.products.updated, 1);
    } finally {
      server.close();
    }
  });

  route('a new product with no PLU is given the next free one', async () => {
    const pool = fakePool([
      [
        'FROM bo_products',
        [{ id: 3, pluid: 42, product_name: 'Cola', department_name: 'Drink' }],
      ],
    ]);
    const server = await listen(appWith(pool));
    try {
      const file = await workbookOf({
        [SHEET_PRODUCTS]: [
          headersOf(SHEET_PRODUCTS),
          ['', 'Lemonade', 'Drink', '', 2.2],
          ['', 'Tonic', 'Drink', '', 2.2],
        ],
      });
      await send(server, '/api/import/catalogue', file);
      const inserts = pool.written.filter((w) => w.sql.includes('INTO bo_products'));
      assert.strictEqual(inserts.length, 2);
      // params[1] is the pluid.
      assert.strictEqual(inserts[0].params[1], 43);
      assert.strictEqual(inserts[1].params[1], 44);
    } finally {
      server.close();
    }
  });

  route('the tills are told only when something was actually written', async () => {
    const told = [];
    const pool = fakePool();
    const server = await listen(appWith(pool, (m) => told.push(m.type)));
    try {
      const file = await workbookOf({
        [SHEET_PRODUCTS]: [headersOf(SHEET_PRODUCTS), ['', 'Cola', 'Drink', '', 2.2]],
      });
      await send(server, '/api/import/catalogue/preview', file);
      assert.deepStrictEqual(told, [], 'a preview woke every till in the venue');

      await send(server, '/api/import/catalogue', file);
      assert.deepStrictEqual(told, ['catalogue.updated']);
    } finally {
      server.close();
    }
  });

  route('something that is not a spreadsheet is refused politely', async () => {
    const pool = fakePool();
    const server = await listen(appWith(pool));
    try {
      const res = await send(
        server,
        '/api/import/catalogue',
        Buffer.from('this is a CSV,not,an,xlsx'),
        { name: 'catalogue.csv' }
      );
      assert.strictEqual(res.status, 400);
      assert.match(res.body.error, /Excel workbook/);
      assert.deepStrictEqual(pool.written, []);
    } finally {
      server.close();
    }
  });

  route('the template downloads as a spreadsheet', async () => {
    const pool = fakePool();
    const server = await listen(appWith(pool));
    try {
      const res = await fetch(
        `http://127.0.0.1:${server.address().port}/api/import/template`,
        { headers: { Authorization: `Bearer ${token()}` } }
      );
      assert.strictEqual(res.status, 200);
      assert.match(res.headers.get('content-type'), /spreadsheetml/);
      assert.match(res.headers.get('content-disposition'), /\.xlsx/);
      const body = Buffer.from(await res.arrayBuffer());
      // An xlsx is a zip, and a zip starts "PK".
      assert.strictEqual(body.subarray(0, 2).toString(), 'PK');
    } finally {
      server.close();
    }
  });

  route('and none of it is reachable without signing in', async () => {
    const pool = fakePool();
    const server = await listen(appWith(pool));
    try {
      const res = await fetch(
        `http://127.0.0.1:${server.address().port}/api/import/template`
      );
      assert.strictEqual(res.status, 401);
    } finally {
      server.close();
    }
  });

  for (const { name, fn } of routeChecks) {
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

  console.log(`\nimports: ${passed} checks passed\n`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
