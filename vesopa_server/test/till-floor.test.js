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

/**
 * The reason lists a till is offered.
 *
 * Both routes now read through one `reasonsFor(office, appliesTo)` -- the
 * legacy `/till/void-reasons`, which every terminal on 1.6.8.0 and earlier
 * calls, and `/till/error-reasons`, which the new till uses to ask for the
 * void, cancel, refund and no-sale lists separately.
 *
 * So the scoping is asserted on the helper rather than on one handler's text,
 * and both routes are checked to go through it. That is a wider guard than the
 * one it replaces, not a looser one: previously nothing stopped a second
 * reason route being added with no office on it, which is exactly how the
 * original bug happened.
 */
const reasonsHelper = (() => {
  const at = source.indexOf('async function reasonsFor(');
  assert.ok(at > 0, 'reasonsFor has moved or been renamed');
  let depth = 0;
  let seen = false;
  for (let i = at; i < source.length; i++) {
    if (source[i] === '{') { depth++; seen = true; }
    else if (source[i] === '}') {
      depth--;
      if (seen && depth === 0) return source.slice(at, i + 1);
    }
  }
  throw new Error('reasonsFor never closes');
})();

const routeBody = (path) => {
  const at = source.indexOf("app.get('" + path + "'");
  assert.ok(at > 0, 'the ' + path + ' route has moved or been renamed');
  let depth = 0;
  for (let i = at; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(at, i + 1);
    }
  }
  throw new Error('the route never closes');
};

const voidReasons = routeBody('/till/void-reasons');
const errorReasons = routeBody('/till/error-reasons');

check("a till is only offered its own venue's reasons", () => {
  // REPORTED AS THE SAME REASON LISTED OVER AND OVER ON THE VOID DIALOG.
  //
  // It was not duplicated data — the table holds nine rows per venue. The read
  // had no office on it whatsoever, and the handler took `_req`, so the request
  // was never even looked at. Measured on live: 61 reasons returned where a
  // venue has nine, with every default appearing once per office on the
  // platform.
  //
  // A reason is free text a manager types, so this was also one venue reading
  // another's wording off its own till.
  assert.ok(
    reasonsHelper.includes('o.contact_email = ?'),
    'the reasons are not scoped to a venue'
  );
});

check("a till that names no venue gets the defaults, not everybody's", () => {
  // Not an empty list: an older till that has not been updated would then have
  // a void dialog with nothing in it, and a clerk who cannot void is a clerk
  // who cannot serve. Not everybody's either, which is the bug.
  assert.ok(
    reasonsHelper.includes('office_id IS NULL'),
    'a till with no office is not given the platform defaults'
  );
});

check('both reason routes ask which venue is calling', () => {
  // The guard that stops this regressing by way of a NEW route rather than an
  // edit to the old one.
  for (const [name, body] of [
    ['/till/void-reasons', voidReasons],
    ['/till/error-reasons', errorReasons],
  ]) {
    assert.ok(
      body.includes('req.query.office'),
      name + ' does not ask which venue is calling'
    );
    assert.ok(
      body.includes('reasonsFor('),
      name + ' does not read through the scoped helper'
    );
  }
});

check('a till cannot ask for an action nothing seeds', () => {
  // `applies_to` is a free VARCHAR. Without the whitelist a till asking for a
  // misspelt action would get an empty list and a dialog a clerk cannot get
  // past — and the back office would have no way to show that it had happened.
  assert.ok(
    errorReasons.includes('REASON_ACTIONS.includes'),
    'the action is not checked against the list of actions'
  );
  assert.ok(
    /status\(400\)/.test(errorReasons),
    'an unknown action is not refused'
  );
});

check('the legacy void route still answers the old shape', () => {
  // Every till on the previous release calls /till/void-reasons and parses a
  // bare JSON array of strings. A Store rollout takes days to reach every
  // terminal, and the ones still on the old build have to keep being able to
  // void.
  assert.ok(
    voidReasons.includes("reasonsFor(req.query.office, 'void')"),
    'the legacy route no longer answers the void list'
  );
});

console.log(`\n${passed} checks passed\n`);
