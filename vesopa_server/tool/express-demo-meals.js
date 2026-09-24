/**
 * Give the TEST venue a set of meals to try on Vesopa Express, and switch the
 * kiosk on there -- built through the back office's own routes, exactly as a
 * manager would build them.
 *
 *     node tool/express-demo-meals.js            set it up (safe to run again)
 *     node tool/express-demo-meals.js --remove   take away everything it made
 *
 * WHAT IT MAKES
 *
 * A meal is a product of its own whose modifier questions are its steps (see
 * mealsFor in src/menu_core.js). So, for The Vesopa Kitchen's burgers:
 *
 *   products     Cheeseburger Meal, Cheeseburger Large Meal, Chicken Burger
 *                Meal, Veggie Burger Meal -- at a meal price, routed to the
 *                kitchen like the burgers -- and the answers, priced as the
 *                upgrade: Meal Chips £0, Meal Sweet Potato Fries +80p, ...
 *   questions    "Choose your side" and "Choose your drink", one answer each,
 *                laid out as the till's own modifier screens
 *   links        each meal product asks both; each burger on the Dine-in menu
 *                offers its meal (the cheeseburger in Regular and Large)
 *
 * and turns Vesopa Express ON for the venue (now.md, task 7), with pay by card
 * and pay at the counter both offered, and the till, the kitchen and the board
 * all told. It is left on, deliberately: the owner is to try it.
 *
 * SAFETY
 *
 *   * The test venue only (manager@vesopa.co.uk). Every other venue on this
 *     server is a paying customer.
 *   * What it creates is written to tmp/express-demo.json as it goes, by id,
 *     and --remove deletes exactly those rows -- never anything it merely
 *     matched by name. Running it again finds its own rows by that file and
 *     makes nothing twice.
 *   * No secret is printed; the session it uses is minted in this process from
 *     the server's own config.
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');

const OFFICE = 'manager@vesopa.co.uk';
const BASE = process.env.VERIFY_BASE || 'https://backoffice.vesopaepos.com';
const STATE = path.join(__dirname, '..', 'tmp', 'express-demo.json');

/** The questions, and what answers them. `from` is the menu product it mirrors. */
const SIDES = [
  { name: 'Meal Chips', label: 'Chips', price: 0, from: 157 },
  { name: 'Meal Sweet Potato Fries', label: 'Sweet Potato Fries', price: 0.8, from: 158 },
  { name: 'Meal Onion Rings', label: 'Onion Rings', price: 0.5, from: 159 },
  { name: 'Meal Side Salad', label: 'Side Salad', price: 0, from: 160 },
];
const DRINKS = [
  { name: 'Meal Coca-Cola', label: 'Coca-Cola', price: 0, from: 100 },
  { name: 'Meal Diet Coke', label: 'Diet Coke', price: 0, from: 101 },
  { name: 'Meal Orange Juice', label: 'Orange Juice', price: 0, from: 103 },
  { name: 'Meal Still Water', label: 'Still Water', price: 0, from: 106 },
  { name: 'Meal Ginger Beer', label: 'Ginger Beer', price: 0.4, from: 107 },
];

/** The meals, and the burger on the menu that offers each. */
const MEALS = [
  { name: 'Cheeseburger Meal', price: 16.5, dish: 122, label: 'Regular' },
  { name: 'Cheeseburger Large Meal', price: 17.5, dish: 122, label: 'Large' },
  { name: 'Chicken Burger Meal', price: 16.0, dish: 150, label: null },
  { name: 'Veggie Burger Meal', price: 15.5, dish: 151, label: null },
];

async function main() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not set in the environment.');
  const db = mysql.createPool({
    connectionLimit: 2,
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER,
    password: process.env.DB_PASS || process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'vesopa_eposdb',
  });
  const [[office]] = await db.query('SELECT id FROM offices WHERE contact_email = ?', [OFFICE]);
  if (!office) throw new Error('The test venue is not on this server.');
  const token = jwt.sign({ email: OFFICE, officeId: office.id, role: 'office' }, secret, { expiresIn: '15m' });

  const call = async (p, { method = 'GET', body } = {}) => {
    const res = await fetch(BASE + p, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 200) }; }
    if (!res.ok) throw new Error(`${method} ${p} answered ${res.status}: ${JSON.stringify(json)}`);
    return json;
  };

  const state = fs.existsSync(STATE)
    ? JSON.parse(fs.readFileSync(STATE, 'utf8'))
    : { products: {}, groups: {}, meals: [] };
  const save = () => {
    fs.mkdirSync(path.dirname(STATE), { recursive: true });
    fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
  };

  // ---- --remove ------------------------------------------------------------
  if (process.argv.includes('--remove')) {
    for (const id of state.meals) {
      await call('/api/express/meals/' + id, { method: 'DELETE' }).catch(() => {});
    }
    for (const g of Object.values(state.groups)) {
      await call('/api/modifier-groups/' + g.id, { method: 'DELETE' }).catch(() => {});
    }
    for (const p of Object.values(state.products)) {
      await call('/api/products/' + p.id, { method: 'DELETE' }).catch(() => {});
    }
    for (const id of state.pictures || []) {
      await call('/api/dinein/items/' + id, { method: 'PUT', body: { image_url: '' } }).catch(() => {});
    }
    fs.rmSync(STATE, { force: true });
    console.log(`removed ${state.meals.length} meals, ${Object.keys(state.groups).length} questions, ` +
      `${Object.keys(state.products).length} products (Vesopa Express left as it is)`);
    await db.end();
    return;
  }

  // ---- Products --------------------------------------------------------------
  const [base] = await db.query(
    'SELECT pluid, product_name, department_name, group_name, tax_percentage, printer_routes, allergens' +
      '  FROM bo_products WHERE email = ? AND pluid IN (' +
      [...SIDES, ...DRINKS].map(() => '?').join(',') + ',' + MEALS.map(() => '?').join(',') + ')',
    [OFFICE, ...[...SIDES, ...DRINKS].map((a) => a.from), ...MEALS.map((m) => m.dish)]
  );
  const byPlu = new Map(base.map((b) => [b.pluid, b]));

  async function ensureProduct(key, fields) {
    const known = state.products[key];
    if (known) {
      const [[row]] = await db.query('SELECT id FROM bo_products WHERE id = ? AND email = ?', [known.id, OFFICE]);
      if (row) return known;
    }
    const made = await call('/api/products', { method: 'POST', body: fields });
    state.products[key] = { id: made.id, pluid: made.pluid };
    save();
    console.log(`  + product ${fields.product_name} (PLU ${made.pluid}) at £${Number(fields.price).toFixed(2)}`);
    return state.products[key];
  }

  // Allergens as the products route takes them: a list, or nothing said.
  const list = (raw) => {
    if (!raw) return undefined;
    try {
      const v = JSON.parse(raw);
      return Array.isArray(v) ? v : undefined;
    } catch {
      return String(raw).split(',').map((s) => s.trim()).filter(Boolean);
    }
  };

  const answer = (a, route) => {
    const from = byPlu.get(a.from) || {};
    return {
      product_name: a.name,
      price: a.price,
      tax_percentage: from.tax_percentage ?? 20,
      department_name: from.department_name || null,
      group_name: from.group_name || null,
      printer_routes: route,
      is_modifier: 1,
      // What is in it is what is in the thing it mirrors.
      allergens: list(from.allergens),
    };
  };
  const sides = [];
  for (const a of SIDES) sides.push({ ...a, ...(await ensureProduct(a.name, answer(a, 'kp1'))) });
  const drinks = [];
  for (const a of DRINKS) drinks.push({ ...a, ...(await ensureProduct(a.name, answer(a, 'kp2'))) });

  const meals = [];
  for (const m of MEALS) {
    const dish = byPlu.get(m.dish) || {};
    meals.push({
      ...m,
      ...(await ensureProduct(m.name, {
        product_name: m.name,
        price: m.price,
        tax_percentage: dish.tax_percentage ?? 20,
        department_name: dish.department_name || 'Mains',
        group_name: dish.group_name || null,
        printer_routes: dish.printer_routes || 'kp1',
        allergens: list(dish.allergens),
      })),
    });
  }

  // ---- Questions -------------------------------------------------------------
  async function ensureGroup(name, answers) {
    let g = state.groups[name];
    if (g) {
      const [[row]] = await db.query('SELECT id, screen_id FROM epos_modifier_groups WHERE id = ? AND office = ?', [g.id, OFFICE]);
      if (!row) g = null;
    }
    if (!g) {
      const made = await call('/api/modifier-groups', {
        method: 'POST', body: { name, min_select: 1, max_select: 1 },
      });
      g = { id: made.id, screen_id: made.screen_id };
      state.groups[name] = g;
      save();
      console.log(`  + question "${name}"`);
    }
    // The answers, laid out as the till draws them: a row of four.
    await call('/api/screens/' + g.screen_id + '/buttons', {
      method: 'PUT',
      body: {
        buttons: answers.map((a, i) => ({
          kind: 'product', pluId: a.pluid, label: a.label, row: Math.floor(i / 4), col: i % 4,
        })),
      },
    });
    return g;
  }
  const side = await ensureGroup('Choose your side', sides);
  const drink = await ensureGroup('Choose your drink', drinks);

  for (const m of meals) {
    await call('/api/products/' + m.pluid + '/modifiers', {
      method: 'PUT', body: { group_ids: [side.id, drink.id] },
    });
  }

  // ---- The meals on the menu -------------------------------------------------
  const [items] = await db.query(
    'SELECT id, plu_id FROM dinein_items WHERE office_id = ? AND plu_id IN (' + MEALS.map(() => '?').join(',') + ')',
    [office.id, ...MEALS.map((m) => m.dish)]
  );
  for (const m of meals) {
    const item = items.find((i) => i.plu_id === m.dish);
    if (!item) {
      console.log(`  ! no ${byPlu.get(m.dish)?.product_name || m.dish} on the Dine-in menu for ${m.name}`);
      continue;
    }
    const [[linked]] = await db.query(
      'SELECT id FROM dinein_item_meals WHERE item_id = ? AND plu_id = ?',
      [item.id, m.pluid]
    );
    if (linked) continue;
    const made = await call('/api/express/meals', {
      method: 'POST', body: { item_id: item.id, plu_id: m.pluid, label: m.label },
    });
    state.meals.push(made.id);
    save();
    console.log(`  + ${m.name}${m.label ? ' (' + m.label + ')' : ''} offered on the dish`);
  }

  // ---- Pictures for the dishes that had none ---------------------------------
  //
  // The venue's drinks, garlic bread and sweet potato fries had no photograph,
  // so the meal's drink step was a row of grey tiles. These were generated for
  // the test venue (Gemini, no brands on anything) and uploaded to
  // /uploads/express-demo/. Only an item with NO picture gets one, and the ids
  // are kept so --remove puts each back to none.
  const PICTURES = {
    158: 'sweet-potato-fries', 145: 'garlic-bread', 100: 'cola', 101: 'diet-cola',
    103: 'orange-juice', 104: 'apple-juice', 105: 'sparkling-water', 106: 'still-water',
    107: 'ginger-beer',
  };
  state.pictures ||= [];
  const [bare] = await db.query(
    'SELECT id, plu_id FROM dinein_items WHERE office_id = ? AND (image_url IS NULL OR image_url = "")' +
      ' AND plu_id IN (' + Object.keys(PICTURES).map(() => '?').join(',') + ')',
    [office.id, ...Object.keys(PICTURES).map(Number)]
  );
  for (const item of bare) {
    await call('/api/dinein/items/' + item.id, {
      method: 'PUT', body: { image_url: BASE + '/uploads/express-demo/' + PICTURES[item.plu_id] + '.jpg' },
    });
    if (!state.pictures.includes(item.id)) state.pictures.push(item.id);
    save();
  }
  if (bare.length) console.log(`  + pictures on ${bare.length} dishes that had none`);

  // ---- Vesopa Express, on (now.md task 7) -------------------------------------
  const settings = await call('/api/express/settings', {
    method: 'PUT',
    body: {
      enabled: true, eat_in: true, take_away: true,
      pay_card: true, pay_counter: true, demo_mode: false,
      notify_till: true, notify_kitchen: true, board_enabled: true,
      receipt_mode: 'ask',
      welcome_title: 'Order here, skip the queue',
      welcome_subtitle: 'Made fresh in our kitchen. Pay by card right here.',
      welcome_image_url: BASE + '/uploads/express-demo/attract-burger-meal.jpg',
    },
  });
  console.log(`\nVesopa Express is ${Number(settings.enabled) ? 'ON' : 'off'} for the test venue; ` +
    `passcode ${settings.passcode_set ? 'set' : 'not set yet (the first kiosk set up chooses one)'}; ` +
    `receipts: ${settings.receipt_mode}.`);
  console.log(`state kept in tmp/express-demo.json (${Object.keys(state.products).length} products, ` +
    `${Object.keys(state.groups).length} questions, ${state.meals.length} meals)`);
  await db.end();
}

main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
