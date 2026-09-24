/**
 * A local back office to click through Stock Control and the reports.
 *
 *   EXPRESS_TEST_USER=vesopa_test EXPRESS_TEST_PASS=vesopa_test \
 *     node tool/local-stock-harness.js
 *
 * Builds `vesopa_stock_harness` from the structure-only copy of live
 * (vesopa_live_shape), applies every schema file, seeds one venue with a
 * catalogue, a week of sales, staff, and a supplier, then starts the server
 * on a free port and prints the sign-in. Ctrl+C drops the database.
 *
 * Sign in: harness@stock.local / harness
 */

const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

const DB = 'vesopa_stock_harness';
const TEMPLATE = process.env.FIVE_TEST_TEMPLATE || 'vesopa_live_shape';
const USER = process.env.EXPRESS_TEST_USER || 'root';
const PASS = process.env.EXPRESS_TEST_PASS || '';
const HOST = process.env.EXPRESS_TEST_HOST || '127.0.0.1';
const OFFICE = { id: 941, email: 'harness@stock.local', name: 'The Harness Arms' };

function statementsOf(sql) {
  const out = [];
  let delimiter = ';';
  let buffer = '';
  for (const line of sql.split('\n')) {
    const d = /^DELIMITER\s+(\S+)/.exec(line.trim());
    if (d) { delimiter = d[1]; continue; }
    if (line.trim().startsWith('--') && !buffer.trim()) continue;
    buffer += line + '\n';
    if (buffer.trimEnd().endsWith(delimiter)) {
      const s = buffer.trimEnd().slice(0, -delimiter.length).trim();
      if (s) out.push(s);
      buffer = '';
    }
  }
  if (buffer.trim()) out.push(buffer.trim());
  return out;
}

const freePort = () =>
  new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

async function main() {
  const admin = await mysql.createConnection({ host: HOST, user: USER, password: PASS, multipleStatements: true });
  await admin.query(`DROP DATABASE IF EXISTS ${DB}; CREATE DATABASE ${DB} CHARACTER SET utf8mb4;`);
  const [tables] = await admin.query(
    "SELECT table_name AS t FROM information_schema.tables WHERE table_schema = ? AND table_type = 'BASE TABLE'",
    [TEMPLATE]
  );
  await admin.query(`USE ${DB}`);
  await admin.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const { t } of tables) {
    const [[row]] = await admin.query(`SHOW CREATE TABLE \`${TEMPLATE}\`.\`${t}\``);
    await admin.query(row['Create Table']);
  }
  await admin.query('SET FOREIGN_KEY_CHECKS = 1');
  const dir = path.join(__dirname, '..', 'schema');
  const files = ['schema.sql', ...fs.readdirSync(dir).filter((f) => /^schema_.*\.sql$/.test(f)).sort()];
  for (const file of files) {
    for (const sql of statementsOf(fs.readFileSync(path.join(dir, file), 'utf8'))) {
      try {
        await admin.query(sql);
      } catch (e) {
        console.error(`${file}: ${e.message}`);
      }
    }
  }

  await admin.query('INSERT INTO offices (id, name, contact_email) VALUES (?, ?, ?)', [OFFICE.id, OFFICE.name, OFFICE.email]);
  await admin.query(
    "INSERT INTO backoffice_users (email, password, name, approved, office_id, role) VALUES (?, ?, 'Harness', 'Y', ?, 'office')",
    [OFFICE.email, await bcrypt.hash('harness', 10), OFFICE.id]
  );
  await admin.query('INSERT INTO floor_rooms (office_id, name) VALUES (?, ?), (?, ?)', [OFFICE.id, 'Lounge', OFFICE.id, 'Bar']);
  const products = [
    [1, 'Carling', 'Drink', 'Beers & Ciders', 4.1, 20, 120, 1.64],
    [2, 'Madri', 'Drink', 'Beers & Ciders', 4.5, 20, 30, 1.69],
    [3, 'Thatchers', 'Drink', 'Beers & Ciders', 4.2, 20, 0, 1.47],
    [4, 'Coke Can', 'Drink', 'Soft Drinks', 1.8, 20, 24, 0.4],
    [5, 'Dr Pepper', 'Drink', 'Soft Drinks', 2.0, 20, 6, 0.45],
    [6, 'Gordon’s Gin 25ml', 'Drink', 'Spirits', 3.9, 20, 56, 0.55],
    [7, 'Crisps', 'Food', 'Snacks', 1.2, 0, 40, 0.35],
    [8, 'Burger', 'Food', 'Lunch', 9.5, 20, null, 3.1],
    [9, 'Chips', 'Food', 'Sides', 3.0, 20, null, 0.6],
    [10, 'Membership', 'Membership', 'Membership', 25, 0, null, 0],
  ];
  for (const [plu, name, dept, group, price, tax, stock, cost] of products) {
    await admin.query(
      `INSERT INTO bo_products (email, pluid, product_name, department_name, group_name, price, tax_percentage, stock_quantity, cost_price)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [OFFICE.email, plu, name, dept, group, price, tax, stock, cost]
    );
  }
  await admin.query(
    `INSERT INTO bo_clarks (email, pluid, clark_name, pin_code, hourly_rate) VALUES (?, 1, 'Sarah', '1111', 12.5), (?, 2, 'Tom', '2222', 11.0)`,
    [OFFICE.email, OFFICE.email]
  );
  await admin.query(`INSERT INTO bo_suppliers (office, name, email, phone) VALUES (?, 'Bookers', 'orders@bookers.example', '01792 000000'), (?, 'Coca-Cola Europacific', 'orders@ccep.example', NULL)`, [OFFICE.email, OFFICE.email]);

  // A fortnight of sales, two a day, with stock movements for the tracked ones.
  const clerks = ['Sarah', 'Tom'];
  const terms = ['Bar 1', 'Bar 2'];
  let n = 0;
  for (let day = 14; day >= 1; day--) {
    for (let k = 0; k < 3; k++) {
      const when = new Date();
      when.setDate(when.getDate() - day);
      when.setHours(12 + k * 4, 15 + k * 7, 0, 0);
      const id = `h${String(++n).padStart(7, '0')}-0000-4000-8000-000000000000`.slice(0, 36);
      const picks = [products[(n + k) % 7], products[(n * 3 + k) % products.length]];
      let total = 0;
      const lines = [];
      for (const p of picks) {
        const qty = 1 + ((n + k) % 3);
        total += Math.round(qty * p[4] * 100);
        lines.push([p, qty]);
      }
      const clerk = clerks[n % 2];
      await admin.query(
        `INSERT INTO epos_orders (id, email, clerk_name, terminal, room_id, covers, subtotal_minor, total_minor, closed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, OFFICE.email, clerk, terms[k % 2], k === 0 ? 1 : null, k === 0 ? 2 : 0, total, total, when]
      );
      for (const [p, qty] of lines) {
        await admin.query(
          `INSERT INTO epos_order_lines (id, order_id, plu_id, name, quantity, unit_price_minor, tax_percentage) VALUES (UUID(), ?, ?, ?, ?, ?, ?)`,
          [id, p[0], p[1], qty, Math.round(p[4] * 100), p[5]]
        );
        if (p[6] !== null) {
          await admin.query(
            `INSERT INTO epos_stock_movements (id, office, pluid, product_name, kind, quantity, unit_cost_minor, order_id, staff_name, terminal, moved_at)
             VALUES (UUID(), ?, ?, ?, 'sale', ?, ?, ?, ?, ?, ?)`,
            [OFFICE.email, p[0], p[1], -qty, Math.round(p[7] * 100), id, clerk, terms[k % 2], when]
          );
        }
      }
      await admin.query(
        `INSERT INTO epos_payments (id, order_id, method, amount_minor, cashback_minor) VALUES (UUID(), ?, ?, ?, ?)`,
        [id, n % 3 === 0 ? 'cash' : 'card', total, n % 5 === 0 ? 1000 : 0]
      );
    }
  }
  await admin.query(
    `INSERT INTO epos_till_events (id, office, kind, amount_minor, note, reason, staff_name, terminal, at)
     VALUES (UUID(), ?, 'refund', 410, 'Carling, flat', 'Customer complaint', 'Sarah', 'Bar 1', NOW() - INTERVAL 2 DAY),
            (UUID(), ?, 'expense', 3000, 'Window cleaner', 'Sundries', 'Tom', 'Bar 2', NOW() - INTERVAL 3 DAY)`,
    [OFFICE.email, OFFICE.email]
  );
  await admin.end();

  const port = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'development',
      JWT_SECRET: 'stock-harness-secret',
      DB_HOST: HOST,
      DB_PORT: '3306',
      DB_USER: USER,
      DB_PASSWORD: PASS,
      DB_NAME: DB,
      SMTP_HOST: '',
      VESOPA_AUTH_ENABLED: '',
      VESOPA_AUTH_BACKOFFICE_ENABLED: '',
      VESOPA_AUTH_TILL_ENABLED: '',
      EXPRESS_SECRET_KEY: 'stock-harness-sealing-key',
      EXPRESS_DOJO_API_KEY: '',
      DOJO_API_KEY: '',
      BACKOFFICE_URL: `http://127.0.0.1:${port}`,
    },
    stdio: 'inherit',
  });
  console.log(`\n>>> http://127.0.0.1:${port}  sign in ${OFFICE.email} / harness\n`);
  const stop = async () => {
    child.kill();
    const a = await mysql.createConnection({ host: HOST, user: USER, password: PASS });
    await a.query(`DROP DATABASE IF EXISTS ${DB}`);
    await a.end();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
