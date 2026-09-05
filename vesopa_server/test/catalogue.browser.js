/**
 * Price levels and printer categories, in a browser against the real server.
 *
 * Both features are mostly back-end, and both are reached through one form and
 * one list that a manager has to be able to open. This drives those: create a
 * category, put a product in it, give the product a second price, save, reload,
 * and read it back from the server rather than from the table the page just
 * drew.
 *
 *     DB_NAME=vesopa_tenancy_test DB_USER=root DB_PASSWORD=... \
 *       node test/catalogue.browser.js [shotsDir]
 */

const assert = require('assert');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const mysql = require('mysql2/promise');
const path = require('path');
const { spawn } = require('child_process');

const OFFICE = 'catalogue-browser@vesopa.invalid';
const LOGIN = 'manager+catalogue-browser@vesopa.invalid';
const PASSWORD = 'test-password-1234';
const PORT = 4675;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = process.argv[2] || null;

let passed = 0;
const checks = [];
const check = (name, fn) => checks.push({ name, fn });

async function nextId(pool, table) {
  const [[row]] = await pool.query(`SELECT COALESCE(MAX(id), 0) + 1 AS id FROM ${table}`);
  return row.id;
}

async function wipe(pool) {
  for (const [t, c] of [
    ['bo_products', 'email'],
    ['bo_print_categories', 'email'],
    ['bo_product_departments', 'email'],
  ]) {
    await pool.query(`DELETE FROM ${t} WHERE ${c} = ?`, [OFFICE]).catch(() => {});
  }
  await pool.query('DELETE FROM epos_till_settings WHERE office = ?', [OFFICE]).catch(() => {});
  await pool.query('DELETE FROM backoffice_users WHERE email = ?', [LOGIN]);
  await pool.query('DELETE FROM offices WHERE contact_email = ?', [OFFICE]);
}

async function seed(pool) {
  await wipe(pool);
  await pool.query(
    `INSERT INTO offices (name, contact_email, status) VALUES (?, ?, 'active')`,
    ['The Bridge Llangennech', OFFICE]
  );
  const [[office]] = await pool.query(
    'SELECT id FROM offices WHERE contact_email = ?', [OFFICE]
  );
  await pool.query(
    `INSERT INTO backoffice_users (id, email, password, name, approved, office_id, role)
     VALUES (?, ?, ?, 'Nicki', 'Y', ?, 'office')`,
    [await nextId(pool, 'backoffice_users'), LOGIN, await bcrypt.hash(PASSWORD, 10), office.id]
  );
  await pool.query(
    `INSERT INTO bo_products (id, email, pluid, product_name, department_name, price, tax_percentage)
     VALUES (?, ?, 7001, 'House Lager', 'Draughts', 5.50, 20)`,
    [await nextId(pool, 'bo_products'), OFFICE]
  );
  // A venue that has named its second level, so the form's label can be checked.
  await pool.query(
    `INSERT INTO epos_till_settings (office, price_level_names)
     VALUES (?, ?)`,
    [OFFICE, JSON.stringify({ 2: 'Happy Hour' })]
  );
}

async function main() {
  let puppeteer;
  try {
    puppeteer = require('puppeteer');
  } catch {
    console.log('catalogue.browser: no puppeteer installed — skipped');
    return;
  }

  const pool = await mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'vesopa_tenancy_test',
    connectionLimit: 4,
  });
  await seed(pool);
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      JWT_SECRET: 'catalogue-browser-secret',
      DB_HOST: process.env.DB_HOST || '127.0.0.1',
      DB_NAME: process.env.DB_NAME || 'vesopa_tenancy_test',
      DB_USER: process.env.DB_USER || 'root',
      DB_PASSWORD: process.env.DB_PASSWORD || '',
    },
    stdio: 'ignore',
  });

  let browser;
  try {
    for (let i = 0; i < 100; i++) {
      const res = await fetch(BASE).catch(() => null);
      if (res && res.status < 500) break;
      await new Promise((r) => setTimeout(r, 200));
    }

    browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1500, height: 1050, deviceScaleFactor: 2 });

    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    page.on('console', (m) => {
      if (m.type() === 'error') pageErrors.push(m.text());
    });

    const signIn = async () => {
      await page.goto(BASE, { waitUntil: 'networkidle2' });
      await page.type('#email', LOGIN);
      await page.type('#password', PASSWORD);
      await Promise.all([
        page.click('#login-form button[type="submit"]'),
        page.waitForSelector('#app:not([hidden])', { timeout: 15000 }),
      ]);
    };

    const openView = async (view) => {
      await page.evaluate((v) => {
        const btn = document.querySelector(`.nav[data-view="${v}"]`);
        if (!btn) throw new Error(`no nav button for ${v}`);
        let el = btn.previousElementSibling;
        while (el && !el.classList.contains('nav-group')) el = el.previousElementSibling;
        if (el?.classList.contains('collapsed')) el.click();
      }, view);
      await page.waitForSelector(`.nav[data-view="${view}"]:not(.hidden-by-group)`);
      await page.click(`.nav[data-view="${view}"]`);
      await page.waitForSelector(`#view-${view}:not([hidden])`);
      await page.waitForNetworkIdle({ idleTime: 300 }).catch(() => {});
    };

    const shot = async (name) => {
      if (!SHOTS) return;
      const file = path.join(SHOTS, `${name}.png`);
      await page.screenshot({ path: file, fullPage: true });
      console.log(file);
    };

    // ---- Printer categories ------------------------------------------------

    check('the printer categories page opens and takes a category', async () => {
      await signIn();
      await openView('printer_categories');

      for (const name of ['Breakfast', 'Mains', 'Desserts']) {
        await page.click('[data-add="print-categories"]');
        await page.waitForSelector('#modal-form input[name="name"]');
        await page.type('#modal-form input[name="name"]', name);
        await page.click('#modal-form button[type="submit"]');
        await page.waitForFunction(
          (n) => document.querySelector('#print-categories')?.textContent.includes(n),
          { timeout: 10000 },
          name
        );
      }

      const rows = await page.$$eval('#print-categories tr', (trs) =>
        trs.map((tr) => tr.querySelector('td:nth-child(2)')?.textContent.trim())
      );
      // In the order they were added, which is the order they will print.
      assert.deepStrictEqual(rows, ['Breakfast', 'Mains', 'Desserts']);
      await shot('20-printer-categories');
    });

    check('and the server has them, in that order', async () => {
      const [rows] = await pool.query(
        'SELECT name, sort_order FROM bo_print_categories WHERE email = ? ORDER BY sort_order, id',
        [OFFICE]
      );
      assert.deepStrictEqual(rows.map((r) => r.name), ['Breakfast', 'Mains', 'Desserts']);
    });

    // ---- The product form --------------------------------------------------

    check('a product can be given a second price and a category', async () => {
      await openView('products');
      await page.waitForSelector('[data-edit-product]', { timeout: 10000 });
      await page.click('[data-edit-product]');
      await page.waitForSelector('#modal-form input[name="price_2"]', { timeout: 10000 });

      // The venue named level 2, so the form must say so rather than "Price 2".
      const labels = await page.$$eval('#modal-form label', (ls) =>
        ls.map((l) => l.textContent.trim())
      );
      assert.ok(
        labels.some((l) => l.includes('Happy Hour')),
        `the venue's own name for level 2 is not on the form:\n      ${labels.join('\n      ')}`
      );

      await page.$eval('#modal-form input[name="price_2"]', (el) => (el.value = ''));
      await page.type('#modal-form input[name="price_2"]', '3.50');

      const mainsValue = await page.evaluate(() => {
        const opt = [...document.querySelectorAll(
          '#modal-form select[name="print_category_id"] option'
        )].find((o) => o.textContent.trim() === 'Mains');
        return opt?.value;
      });
      assert.ok(mainsValue, 'the category picker did not offer Mains');
      await page.select('#modal-form select[name="print_category_id"]', mainsValue);

      await shot('21-product-price-levels');
      await page.click('#modal-form button[type="submit"]');
      await page.waitForFunction(() => !document.querySelector('#modal-form'), {
        timeout: 10000,
      });
    });

    check('and both survive a round trip through the database', async () => {
      // Read from the server, not from the page that just drew itself.
      const [[row]] = await pool.query(
        `SELECT p.price, p.price_2, pc.name AS category
           FROM bo_products p
           LEFT JOIN bo_print_categories pc ON pc.id = p.print_category_id
          WHERE p.email = ? AND p.pluid = 7001`,
        [OFFICE]
      );
      assert.strictEqual(Number(row.price), 5.5, 'Price 1 was changed');
      assert.strictEqual(Number(row.price_2), 3.5, 'Price 2 did not save');
      assert.strictEqual(row.category, 'Mains');
    });

    check('a blank level stays blank, and is not stored as free', async () => {
      // The rule the whole feature rests on. A 0 here would mean the till gave
      // the product away on levels 3 to 6.
      const [[row]] = await pool.query(
        'SELECT price_3, price_4, price_5, price_6 FROM bo_products WHERE email = ? AND pluid = 7001',
        [OFFICE]
      );
      for (const [level, value] of Object.entries(row)) {
        assert.strictEqual(value, null, `${level} was stored as ${value}, not left unset`);
      }
    });

    check('the till is sent the second price and the heading', async () => {
      // What the terminal actually pulls. The join has to reach the category's
      // *name*, because that is what prints.
      const res = await fetch(`${BASE}/till/products?office=${encodeURIComponent(OFFICE)}`);
      assert.strictEqual(res.status, 200, `the till catalogue answered ${res.status}`);
      const rows = await res.json();
      const lager = rows.find((r) => r.pluid === 7001);
      assert.ok(lager, 'the product is not in the till catalogue');
      assert.strictEqual(Number(lager.price_2), 3.5);
      assert.strictEqual(lager.print_category, 'Mains');

      // The same order the back office stored, read back rather than guessed
      // at. That equality is the point: the till sorts its ticket by this
      // number, so a till that disagreed with the list a manager dragged would
      // print the courses in an order nobody chose.
      const [[mains]] = await pool.query(
        'SELECT sort_order FROM bo_print_categories WHERE email = ? AND name = ?',
        [OFFICE, 'Mains']
      );
      assert.strictEqual(
        Number(lager.print_category_order),
        Number(mains.sort_order)
      );
    });

    check('nothing threw in the browser along the way', () => {
      const real = pageErrors.filter((e) => !/favicon|net::ERR_/i.test(e));
      assert.deepStrictEqual(real, [], `browser errors:\n      ${real.join('\n      ')}`);
    });

    console.log('Price levels and printer categories, in a browser\n');
    for (const { name, fn } of checks) {
      try {
        await fn();
        passed++;
        console.log(`  ok  ${name}`);
      } catch (e) {
        console.log(`FAIL  ${name}\n      ${e.message}`);
        process.exitCode = 1;
      }
    }
    console.log(`\ncatalogue browser: ${passed}/${checks.length} checks passed`);
  } finally {
    if (browser) await browser.close();
    child.kill();
    await wipe(pool).catch(() => {});
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
