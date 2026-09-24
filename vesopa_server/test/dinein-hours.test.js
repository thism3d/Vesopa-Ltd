/**
 * Opening hours.
 *
 * WHY THIS IS ITS OWN TEST, AND NOT PART OF dinein.test.js
 *
 * `openState` is a pure function of a venue row and the clock. Everything that
 * can go wrong with it is arithmetic about midnight — a pub that shuts at 1am
 * is open at half past midnight and shut at half past one, and the day it is
 * open *on* is the day before. Asserting on that through an HTTP route would
 * mean standing up a venue and moving a database clock for each of a dozen
 * cases, which is a lot of machinery to test a comparison.
 *
 * The clock is frozen by replacing Date, because a test that only passes
 * between 11am and 11pm is not a test.
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

const { openState, parseHours, cleanTime } = require('../src/dinein');

console.log('\nDine-in opening hours\n');

/** Run `fn` as though it were this moment, in London. */
function at(iso, fn) {
  const Real = Date;
  const fixed = new Real(iso);
  // Only the no-argument constructor and Date.now need to lie; everything else
  // is left alone so that date maths inside the code under test still works.
  class Frozen extends Real {
    constructor(...args) {
      if (args.length === 0) return new Real(fixed.getTime());
      return new Real(...args);
    }
    static now() { return fixed.getTime(); }
  }
  global.Date = Frozen;
  try { return fn(); } finally { global.Date = Real; }
}

const week = (over) => {
  const days = [];
  for (let d = 0; d < 7; d += 1) {
    days.push(Object.assign({ closed: false, open: '11:00', close: '23:00' }, (over || {})[d] || {}));
  }
  return days;
};

const venue = (hours, extra) => Object.assign(
  { schedule_enabled: 1, opening_hours: JSON.stringify(hours) },
  extra || {}
);

// ---------------------------------------------------------------------------
// Reading what was stored
// ---------------------------------------------------------------------------

check('seven days come back however few were stored', () => {
  const out = parseHours('[{"closed":true,"open":"10:00","close":"14:00"}]');
  assert.strictEqual(out.length, 7);
  assert.strictEqual(out[0].closed, true);
  assert.strictEqual(out[3].closed, false);
});

check('unreadable hours mean open, never closed', () => {
  // A venue whose JSON has been corrupted keeps taking orders and looks wrong,
  // rather than stopping and looking fine. The first is noticed in minutes.
  for (const bad of ['', 'null', '{oh dear', undefined, null, 42]) {
    const out = parseHours(bad);
    assert.strictEqual(out.length, 7, String(bad));
    assert.ok(out.every((d) => d.closed === false), String(bad));
  }
});

check('a nonsense time falls back rather than becoming NaN', () => {
  assert.strictEqual(cleanTime('25:00', '09:00'), '09:00');
  assert.strictEqual(cleanTime('12:99', '09:00'), '09:00');
  assert.strictEqual(cleanTime('bar open', '09:00'), '09:00');
  assert.strictEqual(cleanTime('9:30', '09:00'), '09:30');
  assert.strictEqual(cleanTime('09:30', '09:00'), '09:30');
});

// ---------------------------------------------------------------------------
// The ordinary day
// ---------------------------------------------------------------------------

// WHY THE DATES ARE IN JANUARY
//
// London is UTC+1 for half the year, and the first draft of this file was
// written in September: `2026-09-09T23:30:00Z` reads as half past eleven at
// night and is actually half past midnight the following morning. Two checks
// failed and the code was right both times.
//
// So the arithmetic runs on 2026-01-14, a Wednesday, when London is UTC and an
// instant means what it looks like. British Summer Time gets one check of its
// own at the bottom, which is where it belongs — it is a fact about the venue's
// clock, not about every sum involving midnight.
check('open in the middle of the day', () => {
  at('2026-01-14T14:00:00Z', () => {
    const s = openState(venue(week()));
    assert.strictEqual(s.open, true);
    assert.strictEqual(s.enforced, true);
    assert.strictEqual(s.today.day, 'Wednesday');
  });
});

check('shut before opening, and told when to come back', () => {
  at('2026-01-14T08:00:00Z', () => {
    const s = openState(venue(week()));
    assert.strictEqual(s.open, false);
    assert.strictEqual(s.next.today, true);
    assert.strictEqual(s.next.at, '11:00');
  });
});

check('shut after closing, and pointed at tomorrow', () => {
  at('2026-01-14T23:30:00Z', () => {
    const s = openState(venue(week()));
    assert.strictEqual(s.open, false);
    assert.strictEqual(s.next.today, false);
    assert.strictEqual(s.next.day, 'Thursday');
  });
});

check('the closing minute is shut, not open', () => {
  at('2026-01-14T23:00:00Z', () => {
    assert.strictEqual(openState(venue(week())).open, false);
  });
});

check('the opening minute is open', () => {
  at('2026-01-14T11:00:00Z', () => {
    assert.strictEqual(openState(venue(week())).open, true);
  });
});

// ---------------------------------------------------------------------------
// Midnight
// ---------------------------------------------------------------------------

check('a pub that shuts at 1am is open at half past midnight', () => {
  // Tuesday 18:00 to Wednesday 01:00. At 00:30 on Wednesday the thing that is
  // open is Tuesday's shift, and Wednesday's own has not started.
  const hours = week({ 1: { open: '18:00', close: '01:00' }, 2: { open: '18:00', close: '01:00' } });
  at('2026-01-14T00:30:00Z', () => {
    assert.strictEqual(openState(venue(hours)).open, true);
  });
});

check('and shut at half past one', () => {
  const hours = week({ 1: { open: '18:00', close: '01:00' }, 2: { open: '18:00', close: '01:00' } });
  at('2026-01-14T01:30:00Z', () => {
    assert.strictEqual(openState(venue(hours)).open, false);
  });
});

check('a late shift does not leak out of a day that is marked closed', () => {
  // Tuesday closed, Wednesday 18:00-01:00. Half past midnight on Wednesday is
  // shut, because Tuesday was not open to spill out of.
  const hours = week({ 1: { closed: true }, 2: { open: '18:00', close: '01:00' } });
  at('2026-01-14T00:30:00Z', () => {
    assert.strictEqual(openState(venue(hours)).open, false);
  });
});

check('an ordinary day does not spill into the next one', () => {
  // Every day 11:00-23:00. Half past midnight is shut, and the bug it guards
  // against is treating "close is later than open" as an overnight shift.
  at('2026-01-14T00:30:00Z', () => {
    assert.strictEqual(openState(venue(week())).open, false);
  });
});

// ---------------------------------------------------------------------------
// Days off, and the switch
// ---------------------------------------------------------------------------

check('a day marked closed is closed all day', () => {
  const hours = week({ 2: { closed: true } });
  at('2026-01-14T14:00:00Z', () => {
    const s = openState(venue(hours));
    assert.strictEqual(s.open, false);
    assert.strictEqual(s.today.closed, true);
    assert.strictEqual(s.next.day, 'Thursday');
  });
});

check('a venue closed every day is not promised a reopening', () => {
  const hours = week({ 0: { closed: true }, 1: { closed: true }, 2: { closed: true },
    3: { closed: true }, 4: { closed: true }, 5: { closed: true }, 6: { closed: true } });
  at('2026-01-14T14:00:00Z', () => {
    const s = openState(venue(hours));
    assert.strictEqual(s.open, false);
    assert.strictEqual(s.next, null);
  });
});

check('with the schedule switched off the venue is always open', () => {
  const hours = week({ 2: { closed: true } });
  at('2026-01-14T04:00:00Z', () => {
    const s = openState(venue(hours, { schedule_enabled: 0 }));
    assert.strictEqual(s.open, true);
    assert.strictEqual(s.enforced, false);
  });
});

check('a venue that has never set hours is open, not shut', () => {
  // This is the one that matters on the day the column is added: every
  // existing venue has NULL here, and reading NULL as "closed" would take
  // every one of them off the air at once.
  at('2026-01-14T14:00:00Z', () => {
    const s = openState({ schedule_enabled: 1, opening_hours: null });
    assert.strictEqual(s.open, true);
  });
  at('2026-01-14T03:00:00Z', () => {
    // 03:00 is outside the 09:00-23:00 default, so this one is genuinely shut
    // — but it is shut on a default, not on a NULL read as a closure.
    const s = openState({ schedule_enabled: 1, opening_hours: null });
    assert.strictEqual(s.open, false);
    assert.strictEqual(s.next.at, '09:00');
  });
});

check('the venue row is never mutated by being asked', () => {
  const row = { schedule_enabled: 1, opening_hours: JSON.stringify(week()) };
  const before = JSON.stringify(row);
  at('2026-01-14T14:00:00Z', () => openState(row));
  assert.strictEqual(JSON.stringify(row), before);
});

// ---------------------------------------------------------------------------
// British Summer Time
// ---------------------------------------------------------------------------

check('the venue clock is the venue\'s, not UTC', () => {
  // 2026-07-15 is a Wednesday in BST, so London is an hour ahead of UTC.
  // London is an hour ahead of UTC and the venue shuts at 23:00 local. 22:30
  // UTC is 23:30 here - shut - and read as UTC it would be half past ten and
  // open. That is the whole difference.
  at('2026-07-15T21:30:00Z', () => {
    assert.strictEqual(openState(venue(week())).open, true, '22:30 local is open');
  });
  at('2026-07-15T22:30:00Z', () => {
    assert.strictEqual(openState(venue(week())).open, false, '23:30 local is shut');
  });
  at('2026-07-15T23:30:00Z', () => {
    // 00:30 the next morning: the day has rolled over even though the UTC
    // date has not.
    assert.strictEqual(openState(venue(week())).today.day, 'Thursday');
  });
});

check('an explicit timezone is honoured over the default', () => {
  // One instant, two venues, opposite answers. 22:30 UTC in January is 22:30
  // in London - open until 23:00 - and 23:30 in Berlin, which has shut.
  at('2026-01-14T22:30:00Z', () => {
    const london = openState(venue(week()));
    const berlin = openState(venue(week(), { timezone: 'Europe/Berlin' }));
    assert.strictEqual(london.open, true);
    assert.strictEqual(berlin.open, false);
    assert.strictEqual(berlin.today.day, 'Wednesday');
  });
});

console.log(`\n${passed} checks passed\n`);
