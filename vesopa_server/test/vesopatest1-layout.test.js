/**
 * The VesopaTest1 screen set, checked before it is ever written.
 *
 * A layout is arranged in an office and met at a counter weeks later, so the
 * things worth checking are the ones nobody would notice until then: a key off
 * the edge of its grid, two keys on one cell, a gap in the middle of a page, a
 * page key pointing at a page that does not exist, or a function key this
 * surface refuses.
 *
 * It also checks the physical size the keys come out at on the *smallest*
 * terminal in the range, because "does a finger hit this" is the only question
 * a kiosk layout really has to answer, and it is answerable in arithmetic.
 */

const assert = require('assert');
const { SCREENS } = require('../tools/build-vesopatest1');
const { FUNCTION_KEYS, BUTTON_KINDS } = require('../src/screens');

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.log(`FAIL  ${name}\n      ${e.message}`);
    process.exitCode = 1;
  }
}

console.log('VesopaTest1: the layout\n');

const sale = SCREENS.filter((s) => s.surface === 'sale');
const bars = SCREENS.filter((s) => s.surface !== 'sale');

// ---- Shape ---------------------------------------------------------------

check('every sale page is the same 6 x 5 grid', () => {
  for (const s of sale) {
    assert.strictEqual(s.cols, 6, `${s.name} is ${s.cols} wide`);
    assert.strictEqual(s.rows, 5, `${s.name} is ${s.rows} tall`);
  }
});

check('no key runs off the edge of its grid', () => {
  for (const s of SCREENS) {
    for (const b of s.buttons) {
      assert.ok(b.row >= 0 && b.row + b.rowSpan <= s.rows, `${s.name} row ${b.row}`);
      assert.ok(b.col >= 0 && b.col + b.colSpan <= s.cols, `${s.name} col ${b.col}`);
    }
  }
});

check('no two keys share a cell', () => {
  for (const s of SCREENS) {
    const taken = new Map();
    for (const b of s.buttons) {
      for (let r = b.row; r < b.row + b.rowSpan; r++) {
        for (let c = b.col; c < b.col + b.colSpan; c++) {
          const cell = `${r}:${c}`;
          assert.ok(
            !taken.has(cell),
            `${s.name} ${cell}: ${b.label ?? b.pluId} lands on ${taken.get(cell)}`
          );
          taken.set(cell, b.label ?? b.pluId);
        }
      }
    }
  }
});

// The fault the screen this replaces actually had: 24 keys scattered over a
// 10 x 12 grid, which is 120 cells with 96 holes in it.
check('every sale page is completely full — no holes', () => {
  for (const s of sale) {
    const covered = s.buttons.reduce((n, b) => n + b.rowSpan * b.colSpan, 0);
    assert.strictEqual(
      covered,
      s.rows * s.cols,
      `${s.name} fills ${covered} of ${s.rows * s.cols} cells`
    );
  }
});

check('the bars fill their single row too', () => {
  for (const s of bars) {
    const covered = s.buttons.reduce((n, b) => n + b.rowSpan * b.colSpan, 0);
    assert.strictEqual(covered, s.rows * s.cols, `${s.name}`);
  }
});

// ---- What the keys point at ----------------------------------------------

check('every kind used is one the server stores', () => {
  for (const s of SCREENS) {
    for (const b of s.buttons) {
      assert.ok(BUTTON_KINDS.includes(b.kind), `${s.name}: ${b.kind}`);
    }
  }
});

check('every page key points at a page in this set', () => {
  const names = new Set(SCREENS.map((s) => s.name));
  for (const s of SCREENS) {
    for (const b of s.buttons) {
      if (b.kind !== 'page') continue;
      assert.ok(names.has(b._page), `${s.name}: nothing called ${b._page}`);
      assert.notStrictEqual(b._page, s.name, `${s.name} points at itself`);
    }
  }
});

check('a sale page only carries functions a sale page accepts', () => {
  for (const s of sale) {
    for (const b of s.buttons) {
      if (b.kind !== 'function') continue;
      assert.ok(
        FUNCTION_KEYS.includes(b.functionKey),
        `${s.name}: ${b.functionKey} is not offered on a sale screen`
      );
    }
  }
});

check('the modifier key asks a question by name', () => {
  const asks = SCREENS.flatMap((s) => s.buttons).filter((b) => b.kind === 'modifier');
  assert.ok(asks.length >= 4, 'the question is not reachable from every page');
  for (const b of asks) assert.strictEqual(b._group, 'Mixers');
});

// ---- Navigation ----------------------------------------------------------
//
// Mirroring is the single biggest speed win available in a POS layout: staff
// learn one place for each key rather than one per page. The page you are on is
// the only slot that moves, and it moves to Home in its own position.

check('the navigation column is in the same place on every page', () => {
  for (const s of sale) {
    const nav = s.buttons.filter((b) => b.col === 5).sort((a, b) => a.row - b.row);
    assert.strictEqual(nav.length, 5, `${s.name} has ${nav.length} nav keys`);
    assert.deepStrictEqual(
      nav.map((b) => b.row),
      [0, 1, 2, 3, 4],
      `${s.name} nav column has a gap`
    );
    assert.strictEqual(nav[3].kind, 'modifier', `${s.name} slot 4 is not MIXERS`);
    assert.strictEqual(nav[4].functionKey, 'covers', `${s.name} slot 5 is not COVERS`);
  }
});

check('every page is one press from every other page', () => {
  const byName = new Map(sale.map((s) => [s.name, s]));
  for (const from of sale) {
    const reaches = new Set(
      from.buttons.filter((b) => b.kind === 'page').map((b) => b._page)
    );
    for (const to of sale) {
      if (to.name === from.name) continue;
      assert.ok(reaches.has(to.name), `${from.name} cannot reach ${to.name}`);
    }
  }
  assert.strictEqual(byName.size, 4);
});

// ---- The catalogue -------------------------------------------------------

check('no page rings the same product up twice', () => {
  for (const s of sale) {
    const seen = new Set();
    for (const b of s.buttons) {
      if (b.kind !== 'product') continue;
      assert.ok(!seen.has(b.pluId), `${s.name} has PLU ${b.pluId} twice`);
      seen.add(b.pluId);
    }
  }
});

check('the menu pages between them carry the whole catalogue', () => {
  // The home page is a speed rail and repeats; the three menu pages are the
  // ones that have to be complete, or a product exists that no clerk can sell.
  //
  // 64, and the five the venue has that are not here are all deliberate: Coke,
  // Fanta, Lemonade and Tonic at 80p are the Mixers *answers* and belong on the
  // modifier screen rather than on a menu, and PLU 149 is a second Cheeseburger
  // row duplicating 122. Stated as a number rather than read from the database
  // because this check has to run without one -- if the catalogue grows, this
  // failing is the reminder that the new product needs a key.
  const menus = sale.filter((s) => s.name !== 'VesopaTest1');
  const laidOut = new Set(
    menus.flatMap((s) => s.buttons.filter((b) => b.kind === 'product').map((b) => b.pluId))
  );
  assert.strictEqual(laidOut.size, 64, `${laidOut.size} products are reachable`);

  // And no product is on two menu pages, or a clerk has two places to look.
  const total = menus.reduce(
    (n, s) => n + s.buttons.filter((b) => b.kind === 'product').length,
    0
  );
  assert.strictEqual(total, laidOut.size, 'a product is on two menu pages');
});

check('everything on the speed rail is also on a menu page', () => {
  const menus = sale.filter((s) => s.name !== 'VesopaTest1');
  const onMenus = new Set(
    menus.flatMap((s) => s.buttons.filter((b) => b.kind === 'product').map((b) => b.pluId))
  );
  const home = sale.find((s) => s.name === 'VesopaTest1');
  for (const b of home.buttons) {
    if (b.kind !== 'product') continue;
    assert.ok(onMenus.has(b.pluId), `PLU ${b.pluId} is only on the speed rail`);
  }
});

check('a key that borrows a picture still says its name', () => {
  // A product with a catalogue photograph draws the photograph, and without
  // this the Carling key is a logo with no name and no price on it -- which is
  // exactly what the screen this replaces looked like.
  const withPictures = SCREENS.flatMap((s) => s.buttons).filter((b) => b.showLabel);
  assert.ok(withPictures.length > 0, 'no key was told to keep its name');
  for (const b of withPictures) {
    assert.strictEqual(b.kind, 'product');
  }
});

// ---- Will a finger hit it ------------------------------------------------
//
// The terminals are 18.5" to 32" kiosks, and the binding case is the smallest
// and lowest-resolution: an 18.5" 16:9 panel is 1366 x 768 and 409.5mm wide, so
// a pixel is 0.2998mm. ISO 9241-411 asks 9mm for a touch target and 12-15mm for
// a public kiosk; the practical POS figure is 20mm with 5mm between.

/** How big one cell comes out, in millimetres, on a given panel. */
function keySize({ px, py, widthMm, heightMm, cols, rows, railPinned = true }) {
  const RAIL = railPinned ? 208 : 0;
  const BILL = 420;
  const BAR = 58;
  const PAD = 12;
  const GAP = 8;

  const gridPx = px - RAIL - BILL - PAD * 2;
  const gridPy = py - BAR * 2 - PAD * 2;

  const cellW = (gridPx - GAP * (cols - 1)) / cols;
  const cellH = (gridPy - GAP * (rows - 1)) / rows;

  return {
    w: cellW * (widthMm / px),
    h: cellH * (heightMm / py),
  };
}

check('a key clears 20mm on an 18.5" 1366x768 kiosk, rail and all', () => {
  const key = keySize({
    px: 1366, py: 768, widthMm: 409.5, heightMm: 230.3, cols: 6, rows: 5,
  });
  assert.ok(key.w >= 20, `only ${key.w.toFixed(1)}mm wide`);
  assert.ok(key.h >= 20, `only ${key.h.toFixed(1)}mm tall`);
  console.log(`      18.5" landscape: ${key.w.toFixed(1)} x ${key.h.toFixed(1)} mm`);
});

check('and on a 32" 1920x1080 kiosk', () => {
  const key = keySize({
    px: 1920, py: 1080, widthMm: 708.4, heightMm: 398.5, cols: 6, rows: 5,
  });
  assert.ok(key.w >= 20 && key.h >= 20);
  console.log(`      32" landscape:   ${key.w.toFixed(1)} x ${key.h.toFixed(1)} mm`);
});

check('and on a 21.5" portrait kiosk, which is where six columns earns its keep', () => {
  // Portrait is 1080 wide, which is below the till's desktop breakpoint, so the
  // nav rail is tucked away and the grid gets the width the rail would have had.
  const key = keySize({
    px: 1080, py: 1920, widthMm: 267.7, heightMm: 476.0,
    cols: 6, rows: 5, railPinned: false,
  });
  assert.ok(key.w >= 20, `only ${key.w.toFixed(1)}mm wide`);
  console.log(`      21.5" portrait:  ${key.w.toFixed(1)} x ${key.h.toFixed(1)} mm`);

  // And the shape this replaces, for the contrast: twelve columns on the same
  // panel is why the old screen read "Sti cky To...".
  const old = keySize({
    px: 1080, py: 1920, widthMm: 267.7, heightMm: 476.0,
    cols: 12, rows: 10, railPinned: false,
  });
  assert.ok(old.w < 15, 'the old shape was not actually the problem');
  console.log(`      (the 12x10 it replaces: ${old.w.toFixed(1)}mm wide)`);
});

console.log(`\n${passed} checks passed`);
