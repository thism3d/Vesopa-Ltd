/**
 * Realistic demo data for one office, so a fresh sign-in is not an empty till.
 *
 * Scoped to a single tenant throughout — this must never leak into another
 * office's catalogue. Idempotent: re-running replaces this tenant's rows rather
 * than duplicating them.
 *
 *   node seed_demo.js manager@vesopa.co.uk
 */
require('dotenv').config();
const mysql = require('mysql2/promise');

const TENANT = process.argv[2];
if (!TENANT) {
  console.error('usage: node seed_demo.js <office-contact-email>');
  process.exit(1);
}

// [department, group, printer, colour, [[name, price], …]]
const CATALOGUE = [
  ['Drinks', 'Soft Drinks', 'bar', '#4BA3F5', [
    ['Coca-Cola', 2.50], ['Diet Coke', 2.50], ['Lemonade', 2.30],
    ['Orange Juice', 2.80], ['Apple Juice', 2.80], ['Sparkling Water', 1.90],
    ['Still Water', 1.70], ['Ginger Beer', 2.90],
  ]],
  ['Coffee', 'Hot Drinks', 'bar', '#8D5524', [
    ['Espresso', 2.20], ['Double Espresso', 2.80], ['Americano', 2.70],
    ['Latte', 3.20], ['Cappuccino', 3.20], ['Flat White', 3.30],
    ['Mocha', 3.60], ['Hot Chocolate', 3.40],
  ]],
  ['Tea', 'Hot Drinks', 'bar', '#1E9184', [
    ['English Breakfast', 2.40], ['Earl Grey', 2.40], ['Green Tea', 2.60],
    ['Peppermint', 2.60], ['Chamomile', 2.60], ['Chai Latte', 3.40],
  ]],
  ['Beers', 'Alcohol', 'bar', '#F5B301', [
    ['Lager Pint', 5.20], ['Lager Half', 2.80], ['IPA Pint', 5.80],
    ['Guinness Pint', 5.60], ['Cider Pint', 5.40], ['Peroni Bottle', 5.00],
  ]],
  ['Wines', 'Alcohol', 'bar', '#A435B0', [
    ['House Red 175ml', 5.50], ['House White 175ml', 5.50],
    ['Rosé 175ml', 5.50], ['Prosecco Glass', 6.50],
    ['House Red Bottle', 21.00], ['House White Bottle', 21.00],
  ]],
  ['Spirits', 'Alcohol', 'bar', '#2E3A8C', [
    ['Gin & Tonic', 7.50], ['Vodka & Coke', 7.50], ['Whisky', 6.80],
    ['Rum & Coke', 7.20], ['Tequila Shot', 4.50],
  ]],
  ['Cocktails', 'Alcohol', 'bar', '#F4633A', [
    ['Mojito', 9.50], ['Espresso Martini', 10.50], ['Negroni', 10.00],
    ['Aperol Spritz', 9.00], ['Old Fashioned', 10.50],
  ]],
  ['Starters', 'Food', 'kitchen', '#7CBB3F', [
    ['Soup of the Day', 6.50], ['Garlic Bread', 4.50],
    ['Halloumi Fries', 7.00], ['Chicken Wings', 7.50], ['Bruschetta', 6.00],
  ]],
  ['Mains', 'Food', 'kitchen', '#E8412C', [
    ['Cheeseburger', 13.50], ['Chicken Burger', 13.00],
    ['Veggie Burger', 12.50], ['Fish & Chips', 14.50],
    ['Steak & Chips', 22.00], ['Margherita Pizza', 11.50],
    ['Pepperoni Pizza', 13.00], ['Caesar Salad', 10.50],
  ]],
  ['Sides', 'Food', 'kitchen', '#3FBBD6', [
    ['Chips', 4.00], ['Sweet Potato Fries', 4.80],
    ['Onion Rings', 4.50], ['Side Salad', 3.80],
  ]],
  ['Desserts', 'Food', 'kitchen', '#A4308F', [
    ['Sticky Toffee Pudding', 7.00], ['Cheesecake', 6.80],
    ['Chocolate Brownie', 6.50], ['Ice Cream', 5.00],
  ]],
];

const CLERKS = [
  ['Sarah Jones', '1234'],
  ['Tom Baker', '2345'],
  ['Priya Patel', '3456'],
  ['James Wright', '4567'],
];

// [name, qty, dealPriceMinor, qualifying departments]
const DEALS = [
  ['2 Cocktails for £16', 2, 1600, ['Cocktails']],
  ['Any 2 Coffees for £5', 2, 500, ['Coffee']],
  ['3 Sides for £10', 3, 1000, ['Sides']],
];

// [room, [[number, x, y, w, h, shape, seats], …]]
const ROOMS = [
  ['Main Floor', [
    [1, 1, 1, 2, 2, 'rect', 4], [2, 4, 1, 2, 2, 'rect', 4],
    [3, 7, 1, 2, 2, 'rect', 4], [4, 10, 1, 3, 2, 'rect', 6],
    [5, 1, 4, 2, 2, 'circle', 2], [6, 4, 4, 2, 2, 'circle', 2],
    [7, 7, 4, 3, 3, 'circle', 8], [8, 11, 4, 2, 2, 'rect', 4],
    [9, 1, 7, 3, 2, 'rect', 6], [10, 5, 7, 3, 2, 'rect', 6],
  ]],
  ['Terrace', [
    [21, 1, 1, 2, 2, 'circle', 4], [22, 4, 1, 2, 2, 'circle', 4],
    [23, 7, 1, 2, 2, 'circle', 4], [24, 1, 4, 3, 2, 'rect', 6],
    [25, 5, 4, 3, 2, 'rect', 6],
  ]],
];

const VOUCHERS = [
  ['WELCOME10', 'Welcome 10% off', 'percent', 10],
  ['STAFF25', 'Staff discount', 'percent', 25],
  ['FIVER', '£5 off', 'amount', 500],
];

(async () => {
  const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });

  const [[office]] = await pool.query(
    'SELECT id FROM offices WHERE contact_email = ?',
    [TENANT]
  );
  if (!office) {
    console.error(`No office with contact_email ${TENANT}. Create it first.`);
    process.exit(1);
  }

  // This tenant's rows only.
  await pool.execute('DELETE FROM bo_products WHERE email = ?', [TENANT]);
  await pool.execute('DELETE FROM bo_clarks WHERE email = ?', [TENANT]);
  await pool.execute('DELETE FROM bo_vouchers WHERE office_id = ?', [office.id]);
  await pool.execute('DELETE FROM floor_rooms WHERE office_id = ?', [office.id]);
  await pool.execute('DELETE FROM bo_mix_match WHERE office_id = ?', [office.id]);

  // ---- Catalogue ----------------------------------------------------------
  let plu = 100;
  const pluByDept = {};

  for (const [dept, group, printer, colour, items] of CATALOGUE) {
    pluByDept[dept] = [];
    let position = 1;

    for (const [name, price] of items) {
      await pool.execute(
        `INSERT INTO bo_products
           (email, pluid, product_name, department_name, group_name, price,
            tax_percentage, stock_quantity, button_position, button_color,
            printer_route)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [TENANT, plu, name, dept, group, price, 20, 100, position, colour, printer]
      );
      pluByDept[dept].push(plu);
      plu++;
      position++;
    }

    await pool.execute(
      `INSERT IGNORE INTO bo_product_departments
         (email, pluid, department_name, group_name) VALUES (?,?,?,?)`,
      [TENANT, 0, dept, group]
    );
    await pool.execute(
      `INSERT IGNORE INTO bo_product_groups (email, pluid, group_name)
       VALUES (?,?,?)`,
      [TENANT, 0, group]
    );
  }

  // ---- Staff --------------------------------------------------------------
  let clerkId = 1;
  for (const [name, pin] of CLERKS) {
    await pool.execute(
      'INSERT INTO bo_clarks (email, pluid, clark_name, pin_code) VALUES (?,?,?,?)',
      [TENANT, clerkId++, name, pin]
    );
  }

  // ---- Mix & match --------------------------------------------------------
  for (const [name, qty, priceMinor, depts] of DEALS) {
    const [deal] = await pool.execute(
      `INSERT INTO bo_mix_match
         (office_id, name, trigger_qty, deal_price_minor, active)
       VALUES (?,?,?,?,1)`,
      [office.id, name, qty, priceMinor]
    );
    for (const dept of depts) {
      for (const id of pluByDept[dept] || []) {
        await pool.execute(
          'INSERT IGNORE INTO bo_mix_match_products (mix_match_id, plu_id) VALUES (?,?)',
          [deal.insertId, id]
        );
      }
    }
  }

  // ---- Vouchers -----------------------------------------------------------
  for (const [code, name, type, value] of VOUCHERS) {
    await pool.execute(
      `INSERT INTO bo_vouchers
         (office_id, code, name, discount_type, value, active)
       VALUES (?,?,?,?,?,1)`,
      [office.id, code, name, type, value]
    );
  }

  // ---- Floor plan ---------------------------------------------------------
  for (const [roomName, tables] of ROOMS) {
    const [room] = await pool.execute(
      'INSERT INTO floor_rooms (office_id, name) VALUES (?,?)',
      [office.id, roomName]
    );
    for (const [number, x, y, w, h, shape, seats] of tables) {
      await pool.execute(
        `INSERT INTO floor_tables
           (room_id, office_id, table_number, pos_x, pos_y, width, height,
            shape, seats)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [room.insertId, office.id, number, x, y, w, h, shape, seats]
      );
    }
  }

  const [[counts]] = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM bo_products  WHERE email = ?)      AS products,
       (SELECT COUNT(*) FROM bo_clarks    WHERE email = ?)      AS clerks,
       (SELECT COUNT(*) FROM bo_mix_match WHERE office_id = ?)  AS deals,
       (SELECT COUNT(*) FROM bo_vouchers  WHERE office_id = ?)  AS vouchers,
       (SELECT COUNT(*) FROM floor_tables WHERE office_id = ?)  AS tables`,
    [TENANT, TENANT, office.id, office.id, office.id]
  );

  console.log(`Seeded ${TENANT}:`);
  console.log(`  ${counts.products} products across ${CATALOGUE.length} departments`);
  console.log(`  ${counts.clerks} clerks · ${counts.deals} deals · ${counts.vouchers} vouchers`);
  console.log(`  ${counts.tables} tables across ${ROOMS.length} rooms`);

  await pool.end();
})();
