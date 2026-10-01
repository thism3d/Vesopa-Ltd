/**
 * The step-by-step product form's server side (2026-10-01), against a real
 * MySQL/MariaDB:
 *
 *   * schema_product_wizard.sql adds its columns and runs twice cleanly;
 *   * saveProductExtras writes only what it is sent, cleaned;
 *   * the Information text is cut down to safe tags;
 *   * placeProductOnScreen puts a key in the first free cell, leaves one
 *     already there alone, and says when a page is full.
 *
 * SKIPPED when no database is reachable. Uses PRODUCT_TEST_* or root with no
 * password on 127.0.0.1, like the other database tests.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const mysql = require('mysql2/promise');

const { saveProductExtras, cleanDescription } = require('../src/product_info');
const { placeProductOnScreen } = require('../src/screens');

const DB = process.env.PRODUCT_TEST_DB || 'vesopa_product_wizard_selftest';
const USER = process.env.PRODUCT_TEST_USER || 'root';
const PASS = process.env.PRODUCT_TEST_PASS || '';
const HOST = process.env.PRODUCT_TEST_HOST || '127.0.0.1';
const OFFICE = 'wizard@vesopa.test';

let passed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${e.message}`);
    process.exitCode = 1;
  }
}

/** Run a .sql file the way a deploy does, honouring DELIMITER blocks. */
async function runScript(conn, sql) {
  const chunks = sql.split(/^DELIMITER\s+(\S+)\s*$/m);
  let statementEnd = ';';
  for (let i = 0; i < chunks.length; i++) {
    if (i % 2 === 1) {
      statementEnd = chunks[i];
      continue;
    }
    const body = chunks[i].trim();
    if (!body) continue;
    if (statementEnd === ';') {
      await conn.query(body);
    } else {
      for (const piece of body.split(statementEnd)) {
        if (piece.trim()) await conn.query(piece);
      }
    }
  }
}

async function main() {
  console.log('\nProduct wizard: server\n');

  let admin;
  try {
    admin = await mysql.createConnection({ host: HOST, user: USER, password: PASS, multipleStatements: true });
  } catch (e) {
    console.log('  -- no database reachable, skipping (' + e.code + ')');
    return;
  }
  await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await admin.query(`CREATE DATABASE \`${DB}\` CHARACTER SET utf8mb4`);
  await admin.end();

  const pool = mysql.createPool({ host: HOST, user: USER, password: PASS, database: DB, multipleStatements: true });
  try {
    await pool.query(`
      CREATE TABLE bo_products (
        id INT AUTO_INCREMENT PRIMARY KEY,
        email VARCHAR(255) NOT NULL,
        pluid INT NOT NULL,
        product_name VARCHAR(255) NOT NULL,
        allergens TEXT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
      CREATE TABLE epos_screens (
        id INT AUTO_INCREMENT PRIMARY KEY,
        office VARCHAR(190) NOT NULL,
        name VARCHAR(60) NOT NULL,
        surface VARCHAR(16) NOT NULL DEFAULT 'sale',
        grid_rows TINYINT UNSIGNED NOT NULL,
        grid_cols TINYINT UNSIGNED NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
      CREATE TABLE epos_screen_buttons (
        id INT AUTO_INCREMENT PRIMARY KEY,
        screen_id INT NOT NULL,
        office VARCHAR(190) NOT NULL,
        grid_row TINYINT UNSIGNED NOT NULL,
        grid_col TINYINT UNSIGNED NOT NULL,
        row_span TINYINT UNSIGNED NOT NULL DEFAULT 1,
        col_span TINYINT UNSIGNED NOT NULL DEFAULT 1,
        kind VARCHAR(16) NOT NULL DEFAULT 'blank',
        plu_id INT NULL,
        UNIQUE KEY cell (screen_id, grid_row, grid_col)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    await pool.execute('INSERT INTO bo_products (email, pluid, product_name) VALUES (?, 1, ?)', [OFFICE, 'Peroni Pint']);
    const [[{ id }]] = await pool.query('SELECT id FROM bo_products WHERE pluid = 1');

    await check('without the migration, saving extras steps aside instead of failing', async () => {
      assert.strictEqual(await saveProductExtras(pool, id, OFFICE, { calories: 200 }), false);
    });

    const migration = fs.readFileSync(path.join(__dirname, '..', 'schema', 'schema_product_wizard.sql'), 'utf8');
    await check('the migration adds its columns, and runs twice without complaint', async () => {
      await runScript(pool, migration);
      await runScript(pool, migration);
      const [cols] = await pool.query(
        "SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bo_products'"
      );
      const names = cols.map((r) => r.c);
      for (const c of ['short_description', 'description', 'calories', 'may_contain', 'dietary', 'is_weighted', 'manual_weight']) {
        assert.ok(names.includes(c), `missing ${c}`);
      }
    });

    await check('extras are saved, cleaned', async () => {
      await saveProductExtras(pool, id, OFFICE, {
        short_description: '  Crisp Italian lager  ',
        description: '<p>Brewed in <b>Rome</b><script>x()</script></p>',
        calories: '210.4',
        may_contain: ['__answered__', 'peanuts', 'nonsense'],
        dietary: ['vegan', 'vegetarian'],
        is_weighted: '1',
        manual_weight: '0',
      });
      const [[row]] = await pool.query('SELECT * FROM bo_products WHERE id = ?', [id]);
      assert.strictEqual(row.short_description, 'Crisp Italian lager');
      assert.strictEqual(row.description, '<p>Brewed in <b>Rome</b></p>');
      assert.strictEqual(row.calories, 210);
      assert.strictEqual(row.may_contain, '["peanuts"]');
      assert.strictEqual(row.dietary, '["vegetarian","vegan"]');
      assert.strictEqual(row.is_weighted, 1);
      assert.strictEqual(row.manual_weight, 0);
    });

    await check('a field not sent is left alone; another office cannot be written', async () => {
      await saveProductExtras(pool, id, OFFICE, { calories: '' });
      await saveProductExtras(pool, id, 'someone@else.test', { short_description: 'hijacked' });
      const [[row]] = await pool.query('SELECT * FROM bo_products WHERE id = ?', [id]);
      assert.strictEqual(row.calories, null);
      assert.strictEqual(row.short_description, 'Crisp Italian lager');
      assert.strictEqual(row.dietary, '["vegetarian","vegan"]');
    });

    await check('links keep only http(s) and mailto addresses; event handlers go', async () => {
      assert.strictEqual(
        cleanDescription('<a href="javascript:alert(1)" onclick="x">a</a><a href="https://vesopa.com">b</a><img src=x onerror=y>'),
        '<a>a</a><a href="https://vesopa.com" target="_blank" rel="noopener">b</a>'
      );
      assert.strictEqual(cleanDescription('<p>   </p>'), null);
    });

    const [made] = await pool.execute(
      "INSERT INTO epos_screens (office, name, surface, grid_rows, grid_cols) VALUES (?, 'Draught', 'sale', 2, 2)",
      [OFFICE]
    );
    const [[screen]] = await pool.query('SELECT * FROM epos_screens WHERE id = ?', [made.insertId]);
    await pool.execute(
      "INSERT INTO epos_screen_buttons (screen_id, office, grid_row, grid_col, row_span, col_span, kind, plu_id) VALUES (?, ?, 0, 0, 1, 2, 'product', 9)",
      [screen.id, OFFICE]
    );

    await check('a product goes in the first free cell, past a key two wide', async () => {
      const r = await placeProductOnScreen(pool, OFFICE, screen, 1);
      assert.deepStrictEqual(r, { placed: { row: 1, col: 0 }, already: false });
    });

    await check('placing it again leaves the key where it is', async () => {
      const r = await placeProductOnScreen(pool, OFFICE, screen, 1);
      assert.deepStrictEqual(r, { placed: { row: 1, col: 0 }, already: true });
      const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM epos_screen_buttons WHERE plu_id = 1');
      assert.strictEqual(n, 1);
    });

    await check('a full page says so', async () => {
      await placeProductOnScreen(pool, OFFICE, screen, 2);
      const r = await placeProductOnScreen(pool, OFFICE, screen, 3);
      assert.strictEqual(r.placed, null);
    });
  } finally {
    await pool.query(`DROP DATABASE IF EXISTS \`${DB}\``).catch(() => {});
    await pool.end();
  }
  console.log(`\n${passed} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
