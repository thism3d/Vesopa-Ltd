/**
 * What the till is sent when it asks for the floor plan.
 *
 * WHY THIS IS A TEST AND NOT A GLANCE
 *
 * This route is the only one the tills read their plan from, and it is a hand
 * written column list rather than a `SELECT *`. So a column added to the
 * designer is not a column the till receives — it is added in one file and has
 * to be remembered in this one, and nothing anywhere complains when it is not.
 *
 * That is exactly how the room shape went missing: a venue drew an L, saw it in
 * the back office and on a customer's phone, and the till went on showing a
 * plain rectangle. The till already knew how to draw walls. The walls were
 * never sent to it, and no test noticed because there was no test.
 *
 * The route is driven for real against a stub pool, so what is asserted is the
 * SQL actually issued and the JSON actually returned.
 */
const assert = require('assert');

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${e.message}`);
    process.exitCode = 1;
  }
}

const fs = require('fs');
const path = require('path');
const source = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'server.js'),
  'utf8'
);

/**
 * The body of the /till/floor handler, which is what this file is about.
 *
 * Sliced by counting braces rather than by looking for the next "});" — the
 * handler contains several of those, so the naive search stops inside the first
 * try block and every column after it reads as missing.
 */
const route = (() => {
  const at = source.indexOf("app.get(['/till/floor'");
  assert.ok(at > 0, 'the /till/floor route has moved or been renamed');
  let depth = 0;
  for (let i = at; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(at, i + 1);
    }
  }
  throw new Error('the /till/floor route never closes');
})();

console.log('\nThe floor plan a till is sent\n');

// ---------------------------------------------------------------------------
// Everything the designer can draw has to reach the till
// ---------------------------------------------------------------------------

check('the room carries its shape and its colours', () => {
  // Without `outline` a venue's L is drawn as a rectangle on the one screen
  // staff actually work from, and a table in the notch is a table on the far
  // side of a wall.
  for (const column of ['outline', 'floor_colour', 'wall_colour']) {
    assert.ok(
      route.includes('r.' + column),
      `the till is not sent ${column}`
    );
  }
});

check('the table carries its own colour', () => {
  assert.ok(/t\.colour\b/.test(route), 'the till is not sent a table colour');
});

check('the table still carries everything it is positioned by', () => {
  // The regression this guards is a column being dropped while another is
  // added, which would move every table on every till at once.
  for (const column of [
    'id', 'room_id', 'table_number', 'label',
    'pos_x', 'pos_y', 'width', 'height', 'shape', 'seats',
  ]) {
    assert.ok(
      route.includes('t.' + column),
      `the till is no longer sent ${column}`
    );
  }
});

// ---------------------------------------------------------------------------
// And only this venue's
// ---------------------------------------------------------------------------

check('both reads are scoped to the office that asked', () => {
  // A till showing another venue's rooms is the bug this scoping was added
  // for. Two joins, two where clauses; losing either brings back every
  // venue's plan.
  const joins = route.match(/JOIN offices o ON o\.id = \w+\.office_id/g) || [];
  assert.strictEqual(joins.length, 2, 'a read is no longer joined to offices');
  const wheres = route.match(/WHERE o\.contact_email = \?/g) || [];
  assert.strictEqual(wheres.length, 2, 'a read is no longer scoped by office');
});

check('an office is required before anything is read', () => {
  assert.ok(
    /if \(!office\)[\s\S]{0,120}status\(400\)/.test(route),
    'the route no longer refuses a request with no office'
  );
});

// ---------------------------------------------------------------------------
// And the endpoint beside it, which had no office on it at all
// ---------------------------------------------------------------------------

const voidReasons = (() => {
  const at = source.indexOf("app.get('/till/void-reasons'");
  assert.ok(at > 0, 'the /till/void-reasons route has moved or been renamed');
  let depth = 0;
  for (let i = at; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(at, i + 1);
    }
  }
  throw new Error('the route never closes');
})();

check("a till is only offered its own venue's void reasons", () => {
  // REPORTED AS THE SAME REASON LISTED OVER AND OVER ON THE VOID DIALOG.
  //
  // It was not duplicated data — the table holds nine rows per venue. This read
  // had no office on it whatsoever, and the handler took `_req`, so the request
  // was never even looked at. Measured on live: 61 reasons returned where a
  // venue has nine, with every default appearing once per office on the
  // platform.
  //
  // A reason is free text a manager types, so this was also one venue reading
  // another's wording off its own till.
  assert.ok(
    voidReasons.includes('req.query.office'),
    'the route does not ask which venue is calling'
  );
  assert.ok(
    voidReasons.includes('o.contact_email = ?'),
    'the reasons are not scoped to a venue'
  );
});

check("a till that names no venue gets the defaults, not everybody's", () => {
  // Not an empty list: an older till that has not been updated would then have
  // a void dialog with nothing in it, and a clerk who cannot void is a clerk
  // who cannot serve. Not everybody's either, which is the bug.
  assert.ok(
    voidReasons.includes('office_id IS NULL'),
    'a till with no office is not given the platform defaults'
  );
});

console.log(`\n${passed} checks passed\n`);
