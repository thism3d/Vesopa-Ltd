/**
 * Importing customers from a spreadsheet, and open price products (2026-10-05),
 * against a real MySQL/MariaDB.
 *
 *   * a CSV or .xlsx of names, schemes and points becomes customers;
 *   * a scheme nobody has set up blocks the whole file, row by row;
 *   * a customer already here is found by card, email or phone and updated;
 *   * the points balance is set, and the difference written to the ledger;
 *   * schema_open_price.sql runs twice, and saveProductExtras writes it.
 *
 * SKIPPED when no database is reachable. Root with no password on 127.0.0.1,
 * like the other database tests.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const express = require('express');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');

const { customerImportRoutes, parseDate } = require('../src/customer_import');
const { saveProductExtras } = require('../src/product_info');

const DB = 'vesopa_customer_import_selftest';
const HOST = '127.0.0.1';
const SECRET = 'test-secret';
const OFFICE = 'club@vesopa.test';

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${e.stack || e.message}`);
    process.exitCode = 1;
  }
}

async function runScript(conn, sql) {
  const chunks = sql.split(/^DELIMITER\s+(\S+)\s*$/m);
  let end = ';';
  for (let i = 0; i < chunks.length; i++) {
    if (i % 2 === 1) { end = chunks[i]; continue; }
    const body = chunks[i].trim();
    if (!body) continue;
    if (end === ';') await conn.query(body);
    else for (const piece of body.split(end)) if (piece.trim()) await conn.query(piece);
  }
}

async function main() {
  console.log('\nCustomer import and open price\n');

  await check('dates read the way people type them', async () => {
    assert.strictEqual(parseDate('31/05/2027'), '2027-05-31');
    assert.strictEqual(parseDate('2027-05-31T00:00:00.000Z'), '2027-05-31');
    assert.strictEqual(parseDate('1-6-27'), '2027-06-01');
    assert.strictEqual(parseDate(''), null);
    assert.strictEqual(parseDate('31/02/2027'), undefined);
  });

  let admin;
  try {
    admin = await mysql.createConnection({ host: HOST, user: 'root', password: '' });
  } catch (e) {
    console.log('  -- no database reachable, skipping (' + e.code + ')');
    console.log(`\n${passed} checks passed`);
    return;
  }
  await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await admin.query(`CREATE DATABASE \`${DB}\` CHARACTER SET utf8mb4`);
  await admin.end();

  const pool = mysql.createPool({ host: HOST, user: 'root', password: '', database: DB, multipleStatements: true });
  let server;
  try {
    await pool.query(`
      CREATE TABLE offices (id INT PRIMARY KEY, contact_email VARCHAR(255));
      CREATE TABLE bo_products (
        id INT AUTO_INCREMENT PRIMARY KEY, email VARCHAR(255) NOT NULL,
        pluid INT NOT NULL, product_name VARCHAR(255) NOT NULL);
      CREATE TABLE epos_tender_settings (office VARCHAR(190) PRIMARY KEY);
      CREATE TABLE epos_loyalty_txns (
        id CHAR(36) PRIMARY KEY, office VARCHAR(190), customer_id CHAR(36),
        kind VARCHAR(16), points INT, balance_after INT, note VARCHAR(255));
      CREATE TABLE epos_card_sequences (
        office VARCHAR(190), kind VARCHAR(16), next_number INT,
        PRIMARY KEY (office, kind));
    `);
    for (const f of ['schema_customers.sql', 'schema_loyalty_schemes.sql']) {
      await runScript(pool, fs.readFileSync(path.join(__dirname, '..', 'schema', f), 'utf8'));
    }
    await pool.query('ALTER TABLE epos_customers ADD COLUMN member_no INT NULL');
    await pool.execute(
      "INSERT INTO epos_loyalty_schemes (office, name) VALUES (?, 'Members'), (?, 'Vice Presidents')",
      [OFFICE, OFFICE]
    );
    await pool.execute(
      `INSERT INTO epos_customers (id, email_key, name, email, points_balance)
       VALUES ('c-existing', ?, 'Gareth E', 'gareth@example.com', 40)`,
      [OFFICE]
    );

    const app = express();
    app.use('/api', customerImportRoutes({ pool, broadcast: () => {}, secret: SECRET }));
    app.use((err, _req, res, _next) => { console.error(err); res.status(500).json({ error: err.message }); });
    server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}/api`;
    const token = jwt.sign({ email: OFFICE, role: 'office' }, SECRET);

    const send = async (route, csv, name = 'members.csv') => {
      const form = new FormData();
      form.append('file', new Blob([csv], { type: 'text/csv' }), name);
      const res = await fetch(`${base}${route}`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form,
      });
      return { status: res.status, body: await res.json() };
    };

    const good = '﻿Name,Email,Phone,Loyalty scheme,Points,Membership expiry\n' +
      'Gareth Evans,GARETH@example.com,,Members,120,31/05/2027\n' +
      'Sian Morgan,,07700 900456,vice presidents,15,\n';

    await check('a scheme that does not exist blocks the file and names the row', async () => {
      const r = await send('/import/customers', 'Name,Loyalty scheme\nAled,Gold\n');
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.blocked, true);
      assert.strictEqual(r.body.applied, false);
      assert.match(r.body.errors[0].message, /no loyalty scheme called "Gold".*Members/);
      const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM epos_customers');
      assert.strictEqual(Number(n), 1);
    });

    await check('the preview counts, and writes nothing', async () => {
      const r = await send('/import/customers/preview', good);
      assert.deepStrictEqual(
        { ...r.body.summary, points: undefined },
        { created: 1, updated: 1, repeated: 0, points: undefined }
      );
      assert.strictEqual(r.body.applied, false);
      const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM epos_customers');
      assert.strictEqual(Number(n), 1);
    });

    await check('the import matches by email, sets scheme, points and expiry', async () => {
      const r = await send('/import/customers', good);
      assert.strictEqual(r.body.applied, true, JSON.stringify(r.body));
      const [rows] = await pool.query(
        `SELECT c.id, c.name, c.points_balance, c.scheme_id, s.name AS scheme,
                DATE_FORMAT(c.membership_expiry, '%Y-%m-%d') AS expiry, c.member_no
           FROM epos_customers c LEFT JOIN epos_loyalty_schemes s ON s.id = c.scheme_id
          ORDER BY c.name`
      );
      assert.strictEqual(rows.length, 2);
      const gareth = rows.find((x) => x.id === 'c-existing');
      assert.strictEqual(gareth.name, 'Gareth Evans');
      assert.strictEqual(gareth.points_balance, 120);
      assert.strictEqual(gareth.scheme, 'Members');
      assert.strictEqual(gareth.expiry, '2027-05-31');
      const sian = rows.find((x) => x.name === 'Sian Morgan');
      assert.strictEqual(sian.scheme, 'Vice Presidents');
      assert.strictEqual(sian.points_balance, 15, 'no welcome points on an import');
      assert.ok(sian.member_no, 'every member gets a number');
      const [txns] = await pool.query('SELECT customer_id, points, balance_after FROM epos_loyalty_txns ORDER BY points');
      assert.deepStrictEqual(txns.map((t) => [t.points, t.balance_after]), [[15, 15], [80, 120]]);
    });

    await check('importing the same file again changes nobody', async () => {
      const r = await send('/import/customers', good);
      assert.deepStrictEqual([r.body.summary.created, r.body.summary.updated], [0, 2]);
      const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM epos_customers');
      assert.strictEqual(Number(n), 2);
      const [[{ t }]] = await pool.query('SELECT COUNT(*) AS t FROM epos_loyalty_txns');
      assert.strictEqual(Number(t), 2, 'no ledger rows when the balance did not move');
    });

    await check('the template downloads as a workbook', async () => {
      const res = await fetch(`${base}/import/customers/template`, { headers: { Authorization: `Bearer ${token}` } });
      assert.strictEqual(res.status, 200);
      assert.match(res.headers.get('content-type'), /spreadsheetml/);
    });

    await check('open price: the migration runs twice and the fields save', async () => {
      await pool.execute('INSERT INTO bo_products (email, pluid, product_name) VALUES (?, 9, ?)', [OFFICE, 'Open Food']);
      const [[{ id }]] = await pool.query('SELECT id FROM bo_products WHERE pluid = 9');
      assert.strictEqual(await saveProductExtras(pool, id, OFFICE, { open_price: '1' }), false,
        'without the migration it steps aside');
      const sql = fs.readFileSync(path.join(__dirname, '..', 'schema', 'schema_open_price.sql'), 'utf8');
      await runScript(pool, sql);
      await runScript(pool, sql);
      assert.strictEqual(await saveProductExtras(pool, id, OFFICE, { open_price: '1', open_price_note: 0 }), true);
      const [[p]] = await pool.query('SELECT open_price, open_price_note FROM bo_products WHERE id = ?', [id]);
      assert.deepStrictEqual([p.open_price, p.open_price_note], [1, 0]);
      const [[t]] = await pool.query("SHOW COLUMNS FROM epos_tender_settings LIKE 'allow_empty_pay'");
      assert.ok(t);
    });
  } finally {
    if (server) server.close();
    await pool.query(`DROP DATABASE IF EXISTS \`${DB}\``).catch(() => {});
    await pool.end();
  }
  console.log(`\n${passed} checks passed`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
