/**
 * The four new reports, photographed in the back office.
 *
 * Not a test — it asserts nothing beyond "the page drew something". It seeds a
 * day's trading, signs in, runs each report through the real Run a report
 * screen and photographs it, so the layout can be looked at without anybody
 * installing anything.
 *
 *     DB_NAME=vesopa_tenancy_test DB_USER=root DB_PASSWORD=... \
 *       node test/reports-new.shots.js [outputDir]
 */

const bcrypt = require('bcryptjs');
const fs = require('fs');
const mysql = require('mysql2/promise');
const path = require('path');
const { spawn } = require('child_process');

const OFFICE = 'reports-shots@vesopa.invalid';
const LOGIN = 'manager+reports-shots@vesopa.invalid';
const PASSWORD = 'test-password-1234';
const PORT = 4674;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = process.argv[2] || path.join(__dirname, '..', 'shots');

const DAY = '2026-09-03';

const MENU = [
  { plu: 6001, name: 'Lamb Curry', dept: 'Mains', price: 1200 },
  { plu: 6002, name: 'Chicken Biryani', dept: 'Mains', price: 1150 },
  { plu: 6003, name: 'Garlic Naan', dept: 'Sides', price: 350 },
  { plu: 6004, name: 'Onion Bhaji', dept: 'Starters', price: 450 },
  { plu: 6005, name: 'Mango Lassi', dept: 'Soft Drinks', price: 400 },
  { plu: 6006, name: 'Espresso Martini', dept: 'Cocktails', price: 1050 },
];

const STAFF = [
  { pin: '4321', name: 'Alex Morgan' },
  { pin: '1122', name: 'Sam Reilly' },
  { pin: '3344', name: 'Jo Patel' },
];

const MEMBERS = [
  { name: 'Rachel Owen', no: 41, tier: 'Gold' },
  { name: 'Daniel Price', no: 42, tier: 'Silver' },
  { name: 'Megan Hughes', no: 43, tier: 'Gold' },
];

async function nextId(pool, table) {
  const [[row]] = await pool.query(`SELECT COALESCE(MAX(id), 0) + 1 AS id FROM ${table}`);
  return row.id;
}

async function wipe(pool) {
  for (const [t, c] of [
    ['epos_orders', 'email'],
    ['epos_void_log', 'email'],
    ['bo_products', 'email'],
    ['bo_clarks', 'email'],
    ['epos_customers', 'email_key'],
    ['epos_loyalty_txns', 'office'],
  ]) {
    await pool.query(`DELETE FROM ${t} WHERE ${c} = ?`, [OFFICE]).catch(() => {});
  }
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

  for (const p of MENU) {
    await pool.query(
      `INSERT INTO bo_products (id, email, pluid, product_name, department_name, group_name, price, tax_percentage)
       VALUES (?, ?, ?, ?, ?, 'Food & Drink', ?, 20)`,
      [await nextId(pool, 'bo_products'), OFFICE, p.plu, p.name, p.dept, p.price / 100]
    );
  }
  for (const s of STAFF) {
    await pool.query(
      `INSERT INTO bo_clarks (id, email, pluid, clark_name, pin_code, active)
       VALUES (?, ?, 1, ?, ?, 1)`,
      [await nextId(pool, 'bo_clarks'), OFFICE, s.name, s.pin]
    );
  }

  const memberIds = [];
  for (const [i, m] of MEMBERS.entries()) {
    const id = `rshot-cust-${String(i).padStart(21, '0')}`;
    memberIds.push(id);
    await pool.query(
      `INSERT INTO epos_customers (id, email_key, name, member_no, tier_name, points_balance)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, OFFICE, m.name, m.no, m.tier, 100 + i * 50]
    );
  }

  // Twenty-four bills across the evening, so the tables have something to show.
  let seq = 0;
  for (let hour = 17; hour <= 22; hour++) {
    for (let n = 0; n < 4; n++) {
      seq++;
      const id = `rshot-order-${String(seq).padStart(20, '0')}`;
      const staff = STAFF[seq % STAFF.length];
      // Every third bill has a member on it.
      // `seq % memberIds.length` would be the same member every time — seq is
      // always a multiple of three here, so it is always zero.
      const member =
        seq % 3 === 0 ? memberIds[(seq / 3) % memberIds.length] : null;
      const at = `${DAY} ${String(hour).padStart(2, '0')}:${String((n * 13) % 60).padStart(2, '0')}:00`;

      const items = [MENU[seq % MENU.length], MENU[(seq + 2) % MENU.length]];
      const quantities = [1 + (seq % 3), 1 + ((seq + 1) % 2)];
      const gross = items.reduce((sum, p, i) => sum + p.price * quantities[i], 0);
      const lineDiscount = seq % 4 === 0 ? 300 : 0;
      const billDiscount = seq % 5 === 0 ? 200 : 0;
      const total = gross - lineDiscount - billDiscount;
      const tax = Math.round(total / 6);

      await pool.query(
        `INSERT INTO epos_orders
           (id, email, table_number, covers, clerk_pin, customer_id,
            subtotal_minor, discount_minor, tax_minor, total_minor, closed_at, terminal)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Bar')`,
        [id, OFFICE, 1 + (seq % 12), 2, staff.pin, member,
         gross, billDiscount, tax, total, at]
      );

      for (const [i, p] of items.entries()) {
        await pool.query(
          `INSERT INTO epos_order_lines
             (id, order_id, plu_id, name, quantity, unit_price_minor, tax_percentage,
              discount_minor, promotion_name, is_modifier, line_no)
           VALUES (?, ?, ?, ?, ?, ?, 20, ?, ?, 0, ?)`,
          [`${id}-l${i}`, id, p.plu, p.name, quantities[i], p.price,
           i === 0 ? lineDiscount : 0,
           i === 0 && lineDiscount ? 'Curry Night' : null, i + 1]
        );
      }
      await pool.query(
        `INSERT INTO epos_payments (id, order_id, method, amount_minor)
         VALUES (?, ?, ?, ?)`,
        [`${id}-p`, id, seq % 3 === 0 ? 'cash' : 'card', total]
      );

      if (member) {
        await pool.query(
          `INSERT INTO epos_loyalty_txns
             (id, office, customer_id, order_id, kind, points, balance_after, spend_minor, value_minor, created_at)
           VALUES (?, ?, ?, ?, 'earn', ?, 0, ?, 0, ?)`,
          [`${id}-loy`, OFFICE, member, id, Math.round(total / 100), total, at]
        );
      }
    }
  }

  const reasons = [
    ['Wrong item rung up', '1x Lamb Curry', 'lines', 1200],
    ['Customer changed their mind', '2x Garlic Naan', 'lines', 700],
    ['Customer left', '1x Espresso Martini', 'sale', 1050],
    ['Kitchen could not make it', '1x Onion Bhaji', 'lines', 450],
    ['Rung up twice', '1x Chicken Biryani', 'lines', 1150],
  ];
  for (const [i, [reason, items, scope, amount]] of reasons.entries()) {
    await pool.query(
      `INSERT INTO epos_void_log
         (id, email, order_id, clerk_pin, reason, items, scope, amount_minor, voided_at, terminal)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, 'Bar')`,
      [`rshot-void-${String(i).padStart(21, '0')}`, OFFICE,
       STAFF[i % STAFF.length].pin, reason, items, scope, amount,
       `${DAY} ${18 + i}:${20 + i}:00`]
    );
  }
}

async function main() {
  const puppeteer = require('puppeteer');
  const pool = await mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'vesopa_tenancy_test',
    connectionLimit: 4,
  });
  await seed(pool);
  fs.mkdirSync(OUT, { recursive: true });

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      JWT_SECRET: 'reports-shots-secret',
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
    await page.setViewport({ width: 1500, height: 1100, deviceScaleFactor: 2 });

    await page.goto(BASE, { waitUntil: 'networkidle2' });
    await page.type('#email', LOGIN);
    await page.type('#password', PASSWORD);
    await Promise.all([
      page.click('#login-form button[type="submit"]'),
      page.waitForSelector('#app:not([hidden])'),
    ]);

    await page.click('.nav[data-view="run_report"]');
    await page.waitForSelector('#view-run_report:not([hidden])');
    await page.waitForNetworkIdle({ idleTime: 400 }).catch(() => {});

    const offered = await page.$$eval('#rr-report option', (os) =>
      os.map((o) => `${o.value} — ${o.textContent.trim()}`)
    );
    console.log('Reports offered:');
    for (const o of offered) console.log(`  ${o}`);

    await page.screenshot({ path: path.join(OUT, '10-report-picker.png') });
    console.log(path.join(OUT, '10-report-picker.png'));

    // Custom dates, so the seeded day is the one reported on.
    await page.select('#rr-period', 'custom');
    await page.evaluate((day) => {
      const set = (id, v) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.value = v;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      set('rr-from', day);
      set('rr-to', day);
    }, DAY);

    const shots = {
      product_sales: '11-product-sales',
      discounts: '12-discount-report',
      loyalty_spending: '13-loyalty-spending',
      voids_cancels: '14-voids-and-cancels',
    };

    for (const [key, name] of Object.entries(shots)) {
      await page.select('#rr-report', key);
      await page.click('#rr-run');
      await page.waitForFunction(
        () => {
          const el = document.querySelector('#rr-result');
          return el && !el.textContent.includes('Choose a period');
        },
        { timeout: 20000 }
      );
      await page.waitForNetworkIdle({ idleTime: 400 }).catch(() => {});
      const file = path.join(OUT, `${name}.png`);
      await page.screenshot({ path: file, fullPage: true });
      console.log(file);
    }
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
