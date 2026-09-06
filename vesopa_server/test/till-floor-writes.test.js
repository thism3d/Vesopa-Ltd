/**
 * A till laying out its own floor — and only its own.
 *
 * WHY THESE PARTICULAR THINGS ARE ASSERTED
 *
 * These three routes let a device on a counter rewrite a venue's floor plan.
 * That is a real widening of what a terminal token can do, and the whole of
 * what makes it safe is two rules that are invisible when you read the happy
 * path:
 *
 *   1. the office comes from the verified token and is never read from the
 *      request, so a till cannot name somebody else's venue;
 *   2. every row is matched on office_id as well as on id, so even a guessed
 *      table id belonging to another venue updates nothing.
 *
 * Both are one clause each. Either could be dropped in a refactor by somebody
 * tidying up a WHERE, and nothing about the feature would appear to break —
 * one venue would simply become able to rearrange another's dining room. So
 * they are asserted against the source of the routes themselves, which is the
 * only place the guarantee actually lives.
 *
 * The validators are pure and are driven directly.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

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

const source = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'server.js'),
  'utf8'
);

/** One route handler, sliced by counting braces. */
function routeFor(opening) {
  const at = source.indexOf(opening);
  assert.ok(at > 0, `${opening} has moved or been renamed`);
  let depth = 0;
  for (let i = at; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(at, i + 1);
    }
  }
  throw new Error(`${opening} never closes`);
}

const saveTables = routeFor("app.put('/till/floor/tables'");
const addTable = routeFor("app.post('/till/floor/tables'");
const saveRoom = routeFor("app.put('/till/floor/rooms/:id'");
const all = { saveTables, addTable, saveRoom };

console.log('\nA till laying out its own floor\n');

// ---------------------------------------------------------------------------
// Who is allowed to write
// ---------------------------------------------------------------------------

check('every write demands a commissioned terminal', () => {
  // Without this they are open to anybody who can reach the host — and the
  // read beside them, /till/floor, already takes an office as a query
  // parameter with no credential at all.
  for (const [name, route] of Object.entries(all)) {
    assert.ok(
      route.includes('requireTerminal(JWT_SECRET)'),
      `${name} is not behind a terminal token`
    );
  }
});

check('the venue comes from the token, never from the request', () => {
  // req.office is set by requireTerminal after verifying the signature.
  // Reading an office out of the body or the query would let a till name
  // somebody else's venue and rearrange it.
  for (const [name, route] of Object.entries(all)) {
    assert.ok(
      route.includes('terminalOfficeId(req.office)'),
      `${name} does not take the office from the token`
    );
    assert.ok(
      !/req\.(query|body)[.[]\s*['"]?office/.test(route),
      `${name} reads an office out of the request`
    );
  }
});

check('a terminal whose venue cannot be found writes nothing', () => {
  for (const [name, route] of Object.entries(all)) {
    assert.ok(
      /officeId == null[\s\S]{0,160}status\(400\)/.test(route),
      `${name} carries on with no venue`
    );
  }
});

// ---------------------------------------------------------------------------
// What each write can reach
// ---------------------------------------------------------------------------

check('a drag can only move this venue\'s tables', () => {
  assert.ok(
    /UPDATE floor_tables[\s\S]*WHERE id = \? AND office_id = \?/.test(saveTables),
    'the batch update is no longer scoped to the office'
  );
});

check('a table can only be added to this venue\'s rooms', () => {
  // Checked before the insert rather than trusted: room_id arrives in the body
  // and a room belonging to another venue would otherwise take the table.
  assert.ok(
    /FROM floor_rooms WHERE id = \? AND office_id = \?/.test(addTable),
    'the room is not checked against the office'
  );
  assert.ok(
    /That room is not yours/.test(addTable),
    'a room belonging to another venue is not refused'
  );
});

check('a room shape can only be saved onto this venue\'s rooms', () => {
  assert.ok(
    /UPDATE floor_rooms SET[\s\S]*WHERE id = \? AND office_id = \?/.test(saveRoom),
    'the room update is no longer scoped to the office'
  );
  assert.ok(
    /affectedRows[\s\S]{0,120}status\(404\)/.test(saveRoom),
    'a room that was not this venue\'s reports success'
  );
});

// ---------------------------------------------------------------------------
// The things that would go wrong quietly
// ---------------------------------------------------------------------------

check('a new table gets a code that is minted once', () => {
  // The public id is what is printed on the card sitting on the table. Left
  // out, the table can never take a phone order; regenerated later, every
  // printed card for it stops working.
  assert.ok(addTable.includes('newPublicId()'), 'a new table gets no code');
  assert.ok(
    /qr_enabled/.test(addTable),
    'a table added from the till cannot take phone orders'
  );
});

check('a batch of moves is one transaction', () => {
  // A manager rearranging a room sends a dozen tables at once. Half of them
  // landing is a plan that matches neither what was on screen nor what was
  // there before.
  assert.ok(saveTables.includes('beginTransaction'), 'no transaction');
  assert.ok(saveTables.includes('commit'), 'never commits');
  assert.ok(saveTables.includes('rollback'), 'never rolls back');
  assert.ok(saveTables.includes('conn.release'), 'leaks a connection');
});

check('every write tells the other tills', () => {
  // Two members of staff arranging the same room, and a back office open on a
  // laptop. A plan that only updates where it was edited is how a table gets
  // dragged back by the next save from another screen.
  for (const [name, route] of Object.entries(all)) {
    assert.ok(
      route.includes("broadcast({ type: 'floor.updated' })"),
      `${name} does not tell the other tills`
    );
  }
});

// ---------------------------------------------------------------------------
// The validators, driven directly
// ---------------------------------------------------------------------------

const helpers = (() => {
  // Lifted out and evaluated on their own: they are pure, and driving them is
  // worth more than asserting their source reads a particular way.
  const cut = (name) => {
    const at = source.indexOf(`function ${name}(`);
    assert.ok(at > 0, `${name} has gone`);
    let depth = 0;
    for (let i = at; i < source.length; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}') {
        depth--;
        if (depth === 0) return source.slice(at, i + 1);
      }
    }
    throw new Error(`${name} never closes`);
  };
  // eslint-disable-next-line no-new-func
  return new Function(
    `${cut('tillColour')}\n${cut('tillOutline')}\nreturn { tillColour, tillOutline };`
  )();
})();

check('a colour is six hex digits and a hash, or nothing', () => {
  assert.strictEqual(helpers.tillColour('#a5c715'), '#A5C715');
  for (const bad of [
    null, '', 'red', 'A5C715', '#A5C71', '#A5C7155', '#GGGGGG',
    'rgb(1,2,3)', '#000;background:url(x)',
  ]) {
    assert.strictEqual(helpers.tillColour(bad), null, `accepted ${bad}`);
  }
});

check('an outline is corners, clamped to the plan', () => {
  const square = [[0, 0], [4, 0], [4, 4], [0, 4]];
  assert.strictEqual(helpers.tillOutline(square), JSON.stringify(square));
  // Sent as text, which is how it comes back out of the database.
  assert.strictEqual(
    helpers.tillOutline(JSON.stringify(square)),
    JSON.stringify(square)
  );
  // A corner off the plan cannot be dragged back, because its handle is off
  // the plan too.
  assert.strictEqual(
    helpers.tillOutline([[-40, 0], [900, 0], [4, 4]]),
    JSON.stringify([[0, 0], [200, 0], [4, 4]])
  );
});

check('anything that is not a room is a plain rectangle', () => {
  for (const bad of [
    null, '', 'nonsense', '[[0,0],[4,0],',
    [[0, 0], [4, 4]],                 // two corners is a line
    [[0, 0], [4, 0], [4]],            // a corner that is not a pair
    [[0, 0], [4, 0], ['x', 'y']],     // a corner that is not numbers
    { not: 'a list' },
  ]) {
    assert.strictEqual(
      helpers.tillOutline(bad),
      null,
      `accepted ${JSON.stringify(bad)}`
    );
  }
});

console.log(`\n${passed} checks passed\n`);
