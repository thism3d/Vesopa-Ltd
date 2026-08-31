/**
 * Lay out "VesopaTest1" — a screen set built for a kiosk terminal.
 *
 * A one-off, run on the server from inside the nodeapp directory (Node resolves
 * `require` from the script's own location, so it cannot live in /tmp). It
 * talks to the back office's own HTTP API on localhost rather than writing SQL,
 * for two reasons that both matter:
 *
 *   * every write goes through `normaliseButton`, so this cannot store a layout
 *     the editor would refuse or the till could not draw;
 *   * saving through the API **broadcasts** to the venue's tills, so they pick
 *     the new screen up in seconds instead of on their next restart.
 *
 * It authenticates by minting a session token with the server's own JWT secret
 * for the office's real back-office user. That is the same token the browser
 * would carry; nothing here bypasses the tenancy checks.
 *
 * Safe to re-run: it deletes any screen it previously made by name first.
 *
 * ---------------------------------------------------------------------------
 * Why the grid is 6 x 5, everywhere
 * ---------------------------------------------------------------------------
 * The terminals this is for are 18.5" to 32" kiosks. The binding case is the
 * smallest and lowest-resolution of those: an 18.5" 16:9 panel is 1366x768,
 * which is 409.5mm wide, so one pixel is 0.30mm.
 *
 * The till spends that width on a 208px nav rail and a 420px bill, leaving
 * 738px for the grid, less 12px padding each side and an 8px gap between keys.
 * At six columns that is (738 - 24 - 40) / 6 = 112px, or 33.6mm. Height:
 * 768 less the two 58px bars is 652px, less padding 628px, and at five rows
 * (628 - 32) / 5 = 119px, or 35.7mm.
 *
 * So the smallest key in the set is 33.6 x 35.7 mm. ISO 9241-411 asks 9mm for a
 * touch target and 12-15mm for a public kiosk; the practical POS figure is 20mm
 * with 5mm between. This clears all of them with room to spare, and clears them
 * on the *worst* screen in the range — a 32" panel draws the same layout at
 * roughly 75mm a key.
 *
 * Six columns is also what fixes portrait. A portrait kiosk is 1080x1920, where
 * the bill leaves 660px of width: six columns is 99px (24.6mm on a 21.5"
 * portrait panel), which fits two words. The screen this replaces was twelve
 * columns wide, which is 48px — 12mm, right on the ISO floor, and far too
 * narrow for a label. That is the whole of why it read "Sti cky To…".
 */

const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');

// -----------------------------------------------------------------------------
// Who and where
// -----------------------------------------------------------------------------

// The office's own back-office user. Read from the database rather than
// hard-coded, so this cannot quietly write into the wrong tenancy.
const OFFICE_EMAIL = process.env.VESOPA_TARGET_OFFICE || 'manager@vesopa.co.uk';

/**
 * Everything that needs the server: the .env beside this script, the secret,
 * and the port.
 *
 * Read inside a function rather than at module load so the layouts below can be
 * required and checked by test/vesopatest1-layout.test.js, which has no .env,
 * no database and no business having either.
 */
function environment() {
  require('dotenv').config({ path: path.join(__dirname, '.env') });
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('No JWT_SECRET in .env — cannot mint a session.');
  return {
    secret,
    base: `http://127.0.0.1:${Number(process.env.PORT) || 4000}/api`,
  };
}

// -----------------------------------------------------------------------------
// The palette
// -----------------------------------------------------------------------------
//
// Colour is the grouping, not the row. A key's meaning is carried by its
// colour, so a band can run across a row boundary and still read as one thing —
// which is what lets a page hold 21 products and 4 function keys without any
// gaps in it. The two brand colours anchor it: Inkblot for anything that is
// navigation rather than an order, Leafy Canopy for the one key that asks a
// question.
//
// `ink` is deliberately left null on every one of these. The till picks the
// higher-contrast of its dark brand ink and white (Pos.inkOn), which is a
// better answer than any it could be given here — and it stays right if a
// colour is ever changed.
const C = {
  beer: '#a9611f',
  soft: '#2e6da4',
  wine: '#7b2d4a',
  spirit: '#4a5568',
  cocktail: '#6b3fa0',
  starter: '#3e8e6e',
  main: '#276749',
  side: '#6b8e23',
  dessert: '#b5495b',
  coffee: '#6f4e37',
  tea: '#5c8374',
  nav: '#354248',
  ask: '#a5c715',
  fn: '#56606b',
};

// -----------------------------------------------------------------------------
// The catalogue, by PLU
// -----------------------------------------------------------------------------
//
// Named here so the layouts below read as a menu rather than as a list of
// numbers, and so a PLU that has moved fails loudly at the check below rather
// than silently laying out the wrong drink.
const P = {
  // Beers
  ipa: 124, carling: 123, guinness: 125, cider: 126, peroni: 127,
  // Soft
  coke: 100, dietCoke: 101, lemonade: 102, orange: 103, apple: 104,
  sparkling: 105, still: 106, ginger: 107,
  // Coffee
  espresso: 108, dblEspresso: 109, americano: 110, latte: 111,
  cappuccino: 112, flatWhite: 113, mocha: 114, hotChoc: 115,
  // Tea
  breakfast: 116, earlGrey: 117, greenTea: 118, peppermint: 119,
  chamomile: 120, chai: 121,
  // Wine
  redGlass: 128, whiteGlass: 129, rose: 130, prosecco: 131,
  redBottle: 132, whiteBottle: 133,
  // Spirits
  ginTonic: 134, vodkaCoke: 135, whisky: 136, rumCoke: 137, tequila: 138,
  // Cocktails
  mojito: 139, espMartini: 140, negroni: 141, aperol: 142, oldFashioned: 143,
  // Starters
  soup: 144, garlicBread: 145, halloumi: 146, wings: 147, bruschetta: 148,
  // Mains
  cheeseburger: 122, chickenBurger: 150, veggieBurger: 151, fishChips: 152,
  steak: 153, margherita: 154, pepperoni: 155, caesar: 156,
  // Sides
  chips: 157, sweetPotato: 158, onionRings: 159, sideSalad: 160,
  // Desserts
  stickyToffee: 161, cheesecake: 162, brownie: 163, iceCream: 164,
};

/**
 * Products whose catalogue picture the key will borrow.
 *
 * A key with no face of its own still shows the product's — which is what
 * stopped the previous screen being a wall of words, and also what turned the
 * Carling key into a bare logo with no name on it. These keys are told to draw
 * the name as well, so a photograph is a photograph *and* still says what it is
 * and what it costs.
 */
const WITH_PICTURES = new Set([
  P.carling, P.guinness, P.cheeseburger,
  P.espresso, P.dblEspresso, P.americano, P.latte,
  P.cappuccino, P.flatWhite, P.mocha, P.hotChoc,
]);

/**
 * Shorter wording for the keys whose catalogue name will not sit well on a
 * 112px key.
 *
 * Only where it is needed. A null label means the key follows the product, so
 * renaming a product in the back office renames its key — worth keeping
 * wherever the name already fits.
 */
const SHORT = {
  [P.carling]: 'Carling ½',
  [P.guinness]: 'Guinness',
  [P.cider]: 'Cider',
  [P.ipa]: 'IPA',
  [P.peroni]: 'Peroni',
  [P.redGlass]: 'House Red',
  [P.whiteGlass]: 'House White',
  [P.rose]: 'Rosé',
  [P.prosecco]: 'Prosecco',
  [P.redBottle]: 'Red Bottle',
  [P.whiteBottle]: 'White Bottle',
  [P.sparkling]: 'Sparkling',
  [P.dblEspresso]: 'Dbl Espresso',
  [P.breakfast]: 'Breakfast Tea',
  [P.espMartini]: 'Espresso Martini',
  [P.soup]: 'Soup',
  [P.margherita]: 'Margherita',
  [P.pepperoni]: 'Pepperoni',
  [P.stickyToffee]: 'Sticky Toffee',
  [P.brownie]: 'Brownie',
  [P.sweetPotato]: 'Sweet Potato Fries',
  [P.chickenBurger]: 'Chicken Burger',
  [P.veggieBurger]: 'Veggie Burger',
};

// -----------------------------------------------------------------------------
// Layout helpers
// -----------------------------------------------------------------------------

/** A product key. */
const p = (plu, fill) => ({
  kind: 'product',
  pluId: plu,
  fill,
  label: SHORT[plu] ?? null,
  // A picture-bearing product draws its picture; tell it to keep its name too.
  showLabel: WITH_PICTURES.has(plu),
});

/** A key that goes to another page. */
const page = (name, label) => ({ kind: 'page', _page: name, label, fill: C.nav });

/** A till function. */
const fn = (key, label, fill = C.fn) => ({
  kind: 'function',
  functionKey: key,
  label,
  fill,
});

/** A key that asks one of the venue's modifier questions. */
const ask = (groupName, label) => ({
  kind: 'modifier',
  _group: groupName,
  label,
  fill: C.ask,
});

/**
 * Turn rows of keys into positioned buttons.
 *
 * Each row is a list of entries; an entry may carry `w` to span columns, and
 * `null` leaves the cell empty. Positions are worked out here rather than typed
 * out, because a layout written as coordinates is a layout nobody can read and
 * nobody will edit.
 */
function lay(rows) {
  const out = [];
  rows.forEach((cells, row) => {
    let col = 0;
    for (const cell of cells) {
      const width = cell?.w ?? 1;
      if (cell) {
        const { w, _page, _group, ...rest } = cell;
        out.push({ row, col, rowSpan: 1, colSpan: width, ...rest, _page, _group });
      }
      col += width;
    }
  });
  return out;
}

// -----------------------------------------------------------------------------
// The screens
// -----------------------------------------------------------------------------
//
// Four sale pages, all 6 x 5, and the navigation lives in the right-hand column
// on every one of them in the same order. That mirroring is the single biggest
// speed win available here: staff learn one place for each key rather than one
// per page. The page you are standing on is the one slot that changes — its own
// key becomes Home, in the same position — because a key that goes where you
// already are is a key that does nothing.

const NAV = (self) => [
  self === 'food' ? page('VesopaTest1', 'HOME') : page('VesopaTest1 Food', 'FOOD'),
  self === 'bar' ? page('VesopaTest1', 'HOME') : page('VesopaTest1 Bar', 'BAR'),
  self === 'soft'
    ? page('VesopaTest1', 'HOME')
    : page('VesopaTest1 Soft & Hot', 'SOFT & HOT'),
  ask('Mixers', 'MIXERS'),
  fn('covers', 'COVERS'),
];

/** Put the navigation column onto the right of a 5-wide product area. */
function withNav(productRows, self) {
  const nav = NAV(self);
  return productRows.map((cells, i) => [...cells, nav[i]]);
}

const SCREENS = [
  {
    name: 'VesopaTest1',
    surface: 'sale',
    rows: 5,
    cols: 6,
    // The speed screen. One row per thing a counter reaches for, in the order
    // a bar actually reaches for them, and the bottom row is the kitchen's
    // four fastest movers so a food order does not need a page change either.
    buttons: lay(
      withNav(
        [
          [p(P.ipa, C.beer), p(P.carling, C.beer), p(P.guinness, C.beer), p(P.cider, C.beer), p(P.peroni, C.beer)],
          [p(P.coke, C.soft), p(P.dietCoke, C.soft), p(P.lemonade, C.soft), p(P.orange, C.soft), p(P.still, C.soft)],
          [p(P.redGlass, C.wine), p(P.whiteGlass, C.wine), p(P.rose, C.wine), p(P.prosecco, C.wine), p(P.ginTonic, C.spirit)],
          [p(P.mojito, C.cocktail), p(P.espMartini, C.cocktail), p(P.negroni, C.cocktail), p(P.aperol, C.cocktail), p(P.oldFashioned, C.cocktail)],
          [p(P.cheeseburger, C.main), p(P.fishChips, C.main), p(P.chips, C.side), p(P.sweetPotato, C.side), p(P.stickyToffee, C.dessert)],
        ],
        'home'
      )
    ),
  },
  {
    name: 'VesopaTest1 Food',
    surface: 'sale',
    rows: 5,
    cols: 6,
    // Starters, mains, sides, desserts — twenty-one items in twenty-five cells.
    // The four spare go to the till functions a kitchen order actually needs,
    // rather than being left as holes: a gap in a grid reads as something
    // missing, and four of them read as a screen somebody abandoned.
    buttons: lay(
      withNav(
        [
          [p(P.garlicBread, C.starter), p(P.bruschetta, C.starter), p(P.halloumi, C.starter), p(P.wings, C.starter), p(P.soup, C.starter)],
          [p(P.cheeseburger, C.main), p(P.chickenBurger, C.main), p(P.veggieBurger, C.main), p(P.caesar, C.main), p(P.margherita, C.main)],
          [p(P.pepperoni, C.main), p(P.fishChips, C.main), p(P.steak, C.main), p(P.chips, C.side), p(P.sweetPotato, C.side)],
          [p(P.onionRings, C.side), p(P.sideSalad, C.side), p(P.stickyToffee, C.dessert), p(P.cheesecake, C.dessert), p(P.brownie, C.dessert)],
          [p(P.iceCream, C.dessert), fn('qty', 'QTY'), fn('note', 'NOTE'), fn('customer', 'CUSTOMER'), fn('print_bill', 'PRINT BILL')],
        ],
        'food'
      )
    ),
  },
  {
    name: 'VesopaTest1 Bar',
    surface: 'sale',
    rows: 5,
    cols: 6,
    buttons: lay(
      withNav(
        [
          [p(P.ipa, C.beer), p(P.carling, C.beer), p(P.guinness, C.beer), p(P.cider, C.beer), p(P.peroni, C.beer)],
          [p(P.redGlass, C.wine), p(P.whiteGlass, C.wine), p(P.rose, C.wine), p(P.prosecco, C.wine), p(P.redBottle, C.wine)],
          [p(P.whiteBottle, C.wine), p(P.ginTonic, C.spirit), p(P.vodkaCoke, C.spirit), p(P.rumCoke, C.spirit), p(P.whisky, C.spirit)],
          [p(P.tequila, C.spirit), p(P.mojito, C.cocktail), p(P.espMartini, C.cocktail), p(P.negroni, C.cocktail), p(P.aperol, C.cocktail)],
          [p(P.oldFashioned, C.cocktail), fn('qty', 'QTY'), fn('note', 'NOTE'), fn('customer', 'CUSTOMER'), fn('open_drawer', 'NO SALE')],
        ],
        'bar'
      )
    ),
  },
  {
    name: 'VesopaTest1 Soft & Hot',
    surface: 'sale',
    rows: 5,
    cols: 6,
    buttons: lay(
      withNav(
        [
          [p(P.coke, C.soft), p(P.dietCoke, C.soft), p(P.lemonade, C.soft), p(P.orange, C.soft), p(P.apple, C.soft)],
          [p(P.ginger, C.soft), p(P.sparkling, C.soft), p(P.still, C.soft), p(P.espresso, C.coffee), p(P.dblEspresso, C.coffee)],
          [p(P.americano, C.coffee), p(P.latte, C.coffee), p(P.cappuccino, C.coffee), p(P.flatWhite, C.coffee), p(P.mocha, C.coffee)],
          [p(P.hotChoc, C.coffee), p(P.breakfast, C.tea), p(P.earlGrey, C.tea), p(P.greenTea, C.tea), p(P.peppermint, C.tea)],
          [p(P.chamomile, C.tea), p(P.chai, C.tea), fn('note', 'NOTE'), fn('customer', 'CUSTOMER'), fn('print_bill', 'PRINT BILL')],
        ],
        'soft'
      )
    ),
  },

  // ---------------------------------------------------------------------------
  // The bars
  // ---------------------------------------------------------------------------
  //
  // The till pins its own page selector at the left of whatever top bar a venue
  // lays out, and takes the width for it from the bar rather than from one of
  // its columns — so sixteen columns here is sixteen keys, drawn a little
  // narrower. See ProgrammedBar.
  {
    name: 'VesopaTest1 Top',
    surface: 'topbar',
    rows: 1,
    cols: 16,
    buttons: lay([
      [
        { ...fn('venue_name', null, C.nav), w: 2 },
        // The strip of every bill in play. Given seven columns because it is
        // the thing a table-service venue looks at most, and because it scrolls
        // sideways rather than shrinking when there are more tables than fit.
        { ...fn('open_bills', null, null), w: 7 },
        { ...fn('screen_name', null, null), w: 2 },
        { ...fn('staff_name', null, null), w: 2 },
        fn('sign_on', 'Sign On', C.ask),
        fn('clock_in_out', 'Clock', C.fn),
        fn('sign_off', 'Sign Off', C.fn),
      ],
    ]),
  },
  {
    name: 'VesopaTest1 Bottom',
    surface: 'bottombar',
    rows: 1,
    cols: 12,
    buttons: lay([
      [
        fn('void', 'Void', '#c1272d'),
        fn('cancel', 'Cancel', '#c1272d'),
        fn('save_table', 'Save Table', null),
        fn('covers', 'Covers', null),
        fn('customer', 'Customer', null),
        fn('note', 'Notes', null),
        fn('open_drawer', 'No Sale', null),
        fn('print_bill', 'Print', null),
        fn('last_bill', 'Last Bill', null),
        // Pay is three columns wide and lime, because it is the key the whole
        // bar exists for and the one a clerk must never have to look for.
        { ...fn('pay', 'PAY', C.ask), w: 3 },
      ],
    ]),
  },
];

// -----------------------------------------------------------------------------
// Doing it
// -----------------------------------------------------------------------------

async function main() {
  const { secret, base } = environment();
  const mysql = require('mysql2/promise');

  const pool = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'vesopa_eposdb',
    charset: 'utf8mb4',
  });

  const [[user]] = await pool.query(
    `SELECT u.id, u.email, u.name, u.role, u.office_id
       FROM backoffice_users u
       JOIN offices o ON o.id = u.office_id
      WHERE o.contact_email = ? AND u.approved = 'Y'
      ORDER BY u.id LIMIT 1`,
    [OFFICE_EMAIL]
  );
  if (!user) throw new Error(`No approved back-office user for ${OFFICE_EMAIL}`);

  // Check every PLU this layout names is actually in the catalogue, before
  // anything is written. A screen half-laid-out against missing products is
  // worse than one that was never made.
  const plus = [...new Set(Object.values(P))];
  const [rows] = await pool.query(
    `SELECT pluid FROM bo_products WHERE email = ? AND pluid IN (${plus.map(() => '?').join(',')})`,
    [OFFICE_EMAIL, ...plus]
  );
  const known = new Set(rows.map((r) => Number(r.pluid)));
  const missing = plus.filter((n) => !known.has(n));
  if (missing.length) throw new Error(`PLUs not in the catalogue: ${missing.join(', ')}`);

  const [groups] = await pool.query(
    'SELECT id, name FROM epos_modifier_groups WHERE office = ?',
    [OFFICE_EMAIL]
  );
  const groupByName = new Map(groups.map((g) => [g.name, g.id]));

  await pool.end();

  const token = jwt.sign(
    {
      sub: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      officeId: user.office_id,
    },
    secret,
    { expiresIn: '10m' }
  );

  // `node:http`, not `fetch`, and that is not a preference.
  //
  // This server runs on port 5060, and 5060 is SIP — which puts it on the
  // WHATWG fetch specification's "bad port" list. Undici implements that list,
  // so `fetch('http://127.0.0.1:5060/…')` refuses to connect at all and reports
  // it as a bare `TypeError: fetch failed`, with the real reason ("bad port")
  // buried in `error.cause`. curl to the same URL answers 200. Nothing is wrong
  // with the server; fetch is simply not allowed to talk to it.
  const http = require('node:http');
  const target = new URL(base);

  const api = (method, url, body) =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? null : JSON.stringify(body);
      const req = http.request(
        {
          host: target.hostname,
          port: target.port,
          path: target.pathname + url,
          method,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
          },
        },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (c) => (text += c));
          res.on('end', () => {
            if (res.statusCode < 200 || res.statusCode >= 300) {
              return reject(
                new Error(`${method} ${url} -> ${res.statusCode} ${text}`)
              );
            }
            try {
              resolve(text ? JSON.parse(text) : null);
            } catch (e) {
              reject(new Error(`${method} ${url} -> unreadable answer: ${text}`));
            }
          });
        }
      );
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });

  // Re-runnable: clear out anything a previous run made, so this never
  // half-updates a layout or trips the unique name key.
  const existing = await api('GET', '/screens');
  for (const screen of existing) {
    if (screen.name.startsWith('VesopaTest1')) {
      await api('DELETE', `/screens/${screen.id}`);
      console.log(`  removed the previous "${screen.name}"`);
    }
  }

  // Two passes: every screen has to exist before a page key can point at one.
  const idByName = new Map();
  for (const s of SCREENS) {
    const made = await api('POST', '/screens', {
      name: s.name,
      surface: s.surface,
      rows: s.rows,
      cols: s.cols,
    });
    idByName.set(s.name, made.id);
    console.log(`  created ${s.name} (#${made.id}) ${s.rows}x${s.cols} ${s.surface}`);
  }

  for (const s of SCREENS) {
    const buttons = s.buttons.map((b) => {
      const { _page, _group, ...rest } = b;
      if (_page) {
        const target = idByName.get(_page);
        if (!target) throw new Error(`No screen called ${_page}`);
        rest.targetScreenId = target;
      }
      if (_group) {
        const id = groupByName.get(_group);
        if (!id) throw new Error(`No modifier group called ${_group}`);
        rest.modifierGroupId = id;
      }
      return rest;
    });
    const saved = await api('PUT', `/screens/${idByName.get(s.name)}/buttons`, {
      buttons,
    });
    console.log(`  laid out ${s.name}: ${saved.buttons.length} keys`);
  }

  await api('PUT', '/screens/defaults', {
    homeScreenId: idByName.get('VesopaTest1'),
    topBarScreenId: idByName.get('VesopaTest1 Top'),
    bottomBarScreenId: idByName.get('VesopaTest1 Bottom'),
  });
  console.log('  set as this venue’s home screen, top bar and bottom bar');
  console.log('\nDone. Every till in the venue has been pushed the change.');
}

// Only when run directly, so the layouts above can be required and checked
// without a database, a network or a live server anywhere near them.
if (require.main === module) {
  main().catch((e) => {
    console.error('FAILED:', e.message);
    process.exit(1);
  });
} else {
  module.exports = { SCREENS, P, C };
}
