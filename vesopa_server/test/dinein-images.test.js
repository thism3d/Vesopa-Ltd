/**
 * Where a dish's picture comes from, against a real database.
 *
 * A venue could set a picture on a product in Products and still see a blank
 * dish on menu.vesopaepos.com and on a Vesopa Express kiosk: there are two
 * pictures for one dish -- `bo_products.image_url` and `dinein_items.image_url`
 * -- and the menu read only the second. The owner asked for the two to be
 * joined up, with a toggle, which is `dinein_venue.image_source`.
 *
 * WHY NOT IN dinein.test.js. That harness applies only the file that creates
 * the dine-in tables, and the code has moved on: reading a menu there throws
 * "Unknown column" for `is_popular`, `diet_tag`, `allergens` and `floor_colour`,
 * and twenty of its checks fail on a clean tree for reasons that have nothing
 * to do with them. Repairing it is its own job. This stands up only the two
 * tables the rule actually reads, so it says something true today.
 *
 * Needs a local MySQL or MariaDB, like its neighbours. With none reachable it
 * says so and exits 0 rather than failing a suite on a machine without one.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const mysql = require('mysql2/promise');

const core = require('../src/menu_core');

const DB = process.env.DINEIN_TEST_DB
  ? process.env.DINEIN_TEST_DB + '_images'
  : 'vesopa_dinein_images_selftest';
const USER = process.env.DINEIN_TEST_USER || 'root';
const PASS = process.env.DINEIN_TEST_PASS || '';
const HOST = process.env.DINEIN_TEST_HOST || '127.0.0.1';

const OFFICE = { id: 931, email: 'images@dinein.test' };

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failed++;
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
  console.log('\nDine-in pictures\n');

  let admin;
  try {
    admin = await mysql.createConnection({
      host: HOST, user: USER, password: PASS, multipleStatements: true,
    });
  } catch (e) {
    console.log('  -- no database reachable, skipping (' + e.code + ')');
    return;
  }

  await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await admin.query(`CREATE DATABASE \`${DB}\` CHARACTER SET utf8mb4`);
  await admin.end();

  const conn = await mysql.createConnection({
    host: HOST, user: USER, password: PASS, database: DB, multipleStatements: true,
  });

  // Only what the rule reads. `dinein_venue` is made minimally here rather
  // than by running the file that creates the whole dine-in schema -- the
  // column under test is added by the migration below, which is the thing
  // worth exercising.
  await conn.query(`
    CREATE TABLE bo_products (
      id INT AUTO_INCREMENT PRIMARY KEY,
      email VARCHAR(255) NOT NULL,
      pluid INT NOT NULL,
      product_name VARCHAR(255) NOT NULL,
      image_url VARCHAR(500) NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    CREATE TABLE dinein_venue (
      office_id INT PRIMARY KEY
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  const migration = fs.readFileSync(
    path.join(__dirname, '..', 'schema', 'schema_menu_dinein_images.sql'), 'utf8'
  );

  await check('the migration adds the setting, and runs twice without complaint', async () => {
    // Every file in schema/ is applied on every deploy, so "safe to re-run" is
    // not a nicety -- an ALTER that throws the second time takes the deploy
    // down with it.
    await runScript(conn, migration);
    await runScript(conn, migration);
    const [[col]] = await conn.query(
      "SELECT COLUMN_DEFAULT AS d FROM information_schema.COLUMNS" +
        " WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dinein_venue'" +
        "   AND COLUMN_NAME = 'image_source'"
    );
    assert.ok(col, 'image_source exists');
    assert.strictEqual(String(col.d).replace(/'/g, ''), 'menu', 'and defaults to menu');
  });

  await conn.execute('INSERT INTO dinein_venue (office_id) VALUES (?)', [OFFICE.id]);
  await conn.execute(
    'INSERT INTO bo_products (email, pluid, product_name, image_url) VALUES' +
      ' (?, ?, ?, ?), (?, ?, ?, ?), (?, ?, ?, ?)',
    [
      OFFICE.email, 100, 'Fish and chips', '/uploads/product-fish.jpg',
      OFFICE.email, 101, 'Sticky toffee pudding', null,
      OFFICE.email, 102, 'Soup', '/uploads/product-soup.jpg',
    ]
  );

  // The menu items, as menuSections has them in hand: the item's own picture
  // is `image_url`, which is NULL for the dish that only has a product one.
  const items = [
    { plu_id: 100, image_url: '/uploads/menu-fish.jpg' }, // both
    { plu_id: 101, image_url: '/uploads/menu-pud.jpg' },  // menu only
    { plu_id: 102, image_url: null },                     // product only
    { plu_id: 103, image_url: null },                     // neither
  ];
  const pluOf = (n) => items.find((i) => i.plu_id === n);

  async function pictures() {
    return core.itemPictures(conn, OFFICE.id, OFFICE.email, items);
  }

  async function setSource(value) {
    await conn.execute(
      'UPDATE dinein_venue SET image_source = ? WHERE office_id = ?', [value, OFFICE.id]
    );
  }

  await check("by default the menu's own picture leads", async () => {
    const picture = await pictures();
    assert.strictEqual(picture(pluOf(100)), '/uploads/menu-fish.jpg');
  });

  await check('and a dish with only a product picture is no longer blank', async () => {
    // The complaint, exactly: the picture was set in Products and the dish
    // showed nothing at all.
    const picture = await pictures();
    assert.strictEqual(picture(pluOf(102)), '/uploads/product-soup.jpg');
  });

  await check('on Products, the product picture leads', async () => {
    await setSource('product');
    const picture = await pictures();
    assert.strictEqual(picture(pluOf(100)), '/uploads/product-fish.jpg');
  });

  await check('and on Products it still falls back to the menu s own', async () => {
    const picture = await pictures();
    assert.strictEqual(picture(pluOf(101)), '/uploads/menu-pud.jpg');
  });

  await check('a dish with neither picture is null, not an empty string', async () => {
    const picture = await pictures();
    assert.strictEqual(picture(pluOf(103)), null);
    await setSource('menu');
    assert.strictEqual((await pictures())(pluOf(103)), null);
  });

  await check('an unknown source is treated as the safe pair', async () => {
    // The route validates, but a row written by hand must not blank a menu.
    await setSource('something-else');
    const picture = await pictures();
    assert.strictEqual(picture(pluOf(100)), '/uploads/menu-fish.jpg');
    assert.strictEqual(picture(pluOf(102)), '/uploads/product-soup.jpg');
    await setSource('menu');
  });

  await check('a server whose schema predates the setting still serves a menu', async () => {
    // The column simply is not there on a back office that has not applied
    // this migration yet. A menu that will not load is a worse answer than a
    // menu that leads with the picture it always led with.
    await conn.query('ALTER TABLE dinein_venue DROP COLUMN image_source');
    const picture = await pictures();
    assert.strictEqual(picture(pluOf(100)), '/uploads/menu-fish.jpg');
    assert.strictEqual(picture(pluOf(102)), '/uploads/product-soup.jpg');
    await runScript(conn, migration);
  });

  await check('a catalogue with no product pictures at all still serves a menu', async () => {
    // bo_products.image_url is missing on an older back office too.
    await conn.query('ALTER TABLE bo_products DROP COLUMN image_url');
    const picture = await pictures();
    assert.strictEqual(picture(pluOf(100)), '/uploads/menu-fish.jpg');
    assert.strictEqual(picture(pluOf(102)), null, 'nothing to fall back to, and it says so');
  });

  await conn.end();

  const admin2 = await mysql.createConnection({ host: HOST, user: USER, password: PASS });
  await admin2.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await admin2.end();

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
