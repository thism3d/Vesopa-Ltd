/**
 * The Wallet screen's designer, and the card actions that travel to the rows.
 *
 * No browser here — the markup, the stylesheet and app.js are read as text and
 * checked against each other, the same way backoffice-reports-ui.test.js does.
 * That is enough for the failures this exists to catch, and all of them are
 * failures that produce a blank panel with nothing in a console anybody is
 * looking at:
 *
 *   1. An id the designer reaches for that the markup no longer declares.
 *      `$('wal-design-editor').innerHTML = …` on a missing element throws, the
 *      render aborts half way, and the tab is empty.
 *
 *   2. A tab with no panel, or a panel with no tab. Either one is a section of
 *      this screen that cannot be reached at all, and the screen is five tabs
 *      deep now — the old single column could not have this fault.
 *
 *   3. A row action wired to a handler that is not listening, or listening on a
 *      dataset key that nothing writes. The buttons are icon-only, so a dead
 *      one looks exactly like a live one.
 *
 *   4. An icon button with no accessible name. These replaced words on six
 *      lists precisely because words did not fit, which puts the whole meaning
 *      of the control in its label and its tooltip.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const read = (name) =>
  fs.readFileSync(path.join(__dirname, '..', 'public', name), 'utf8');

const html = read('index.html');
const css = read('style.css');
const app = read('app.js');

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

console.log('Back office: the Wallet designer and the row card actions\n');

// ---------------------------------------------------------------------------
// 1. Ids
// ---------------------------------------------------------------------------

const declared = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

// Ids the designer creates for itself, inside innerHTML it wrote a moment
// earlier. They are reached with $() like any other and are not in index.html,
// which is correct — so they are named here rather than making the rule below
// useless by loosening it.
const OWN = new Set([
  'wal-art-file', 'wal-art-clear', 'wal-design-save', 'wal-design-reset',
  'wal-design-note', 'print-card', 'print-card-go',
]);

const reached = [...app.matchAll(/\$\('(wal[-l][^']*)'\)/g)]
  .map((m) => m[1])
  .filter((id) => !OWN.has(id));

check('every wallet id the code reaches for is in the markup', () => {
  const missing = [...new Set(reached)].filter((id) => !declared.has(id));
  assert.deepStrictEqual(missing, [], `not in index.html: ${missing.join(', ')}`);
});

// ---------------------------------------------------------------------------
// 2. Tabs and panels
// ---------------------------------------------------------------------------

const tabs = [...html.matchAll(/data-waltab="([^"]+)"/g)].map((m) => m[1]);
const panels = [...html.matchAll(/data-walpanel="([^"]+)"/g)].map((m) => m[1]);

check('there are five tabs', () => {
  assert.deepStrictEqual(
    tabs,
    ['design', 'programme', 'back', 'apple', 'issued'],
    `tabs are ${tabs.join(', ')}`
  );
});

check('every tab has a panel and every panel has a tab', () => {
  assert.deepStrictEqual([...tabs].sort(), [...panels].sort());
});

check('exactly one tab and one panel start open', () => {
  const on = [...html.matchAll(/class="wal-tab on"/g)].length;
  assert.strictEqual(on, 1, `${on} tabs marked on`);
  // Four of the five panels carry `hidden`; the open one does not.
  const hidden = [...html.matchAll(/data-walpanel="[^"]+" hidden/g)].length;
  assert.strictEqual(hidden, panels.length - 1, `${hidden} panels hidden`);
});

check('the tab switcher is listening', () => {
  assert.ok(
    /closest\('\[data-waltab\]'\)/.test(app),
    'nothing listens for a click on a tab'
  );
});

// ---------------------------------------------------------------------------
// 3. Row actions: written and listened for
// ---------------------------------------------------------------------------

for (const [attr, dataset] of [
  ['data-row-pass', 'rowPass'],
  ['data-row-print', 'rowPrint'],
  ['data-row-slip', 'rowSlip'],
]) {
  check(`${attr} is both written and handled`, () => {
    assert.ok(app.includes(`${attr}="`), `nothing writes ${attr}`);
    assert.ok(
      app.includes(`closest('[${attr}]')`),
      `nothing listens for ${attr}`
    );
    assert.ok(
      app.includes(`dataset.${dataset}`),
      `the handler does not read dataset.${dataset}`
    );
  });
}

check('the six lists that can hand out a card call for the buttons', () => {
  // customers, staff, gift cards, promotions get the pair; vouchers and
  // deposits get print only. Named by the pass kind they pass in, because that
  // is the thing that would be wrong if a list were wired to the wrong one.
  for (const kind of ['loyalty', 'staff', 'giftcard', 'promo']) {
    assert.ok(
      new RegExp(`rowCardActions\\(\\{[^}]*kind: '${kind}'`).test(app),
      `no list issues a ${kind} card`
    );
  }
  for (const what of ['voucher', 'deposit']) {
    assert.ok(
      new RegExp(`printOnlyAction\\(\\{[\\s\\S]{0,120}what: '${what}'`).test(app),
      `${what}s cannot be printed`
    );
  }
});

check('every icon button carries an accessible name', () => {
  // The control is an icon and nothing else, so aria-label and title are not
  // decoration here — they are the only place its meaning is written down.
  const buttons = [...app.matchAll(/<button class="icon-btn"[\s\S]{0,400}?>/g)]
    .map((m) => m[0]);
  assert.ok(buttons.length >= 4, `only found ${buttons.length} icon buttons`);
  for (const b of buttons) {
    assert.ok(/aria-label=/.test(b), `an icon button has no aria-label:\n${b}`);
    assert.ok(/title=/.test(b), `an icon button has no title:\n${b}`);
  }
});

// ---------------------------------------------------------------------------
// 4. Styles
// ---------------------------------------------------------------------------

check('every class the designer and the row actions write has a rule', () => {
  const classes = new Set();
  for (const m of app.matchAll(/class="((?:wal-|icon-btn|print-|pc-|ps-)[^"$]*)"/g)) {
    for (const c of m[1].split(/\s+/)) if (c && !c.includes('$')) classes.add(c);
  }
  const missing = [...classes].filter((c) => !css.includes(`.${c}`));
  assert.deepStrictEqual(missing, [], `no CSS rule for: ${missing.join(', ')}`);
});

check('the printed card is card-sized', () => {
  // 85.6 x 54mm is the rectangle a bank card is, and the whole point of the
  // print is that it can be held against a blank and cut to it.
  assert.ok(/\.print-card\s*\{[^}]*width:\s*85\.6mm/.test(css), 'not 85.6mm wide');
  assert.ok(/\.print-card\s*\{[^}]*height:\s*54mm/.test(css), 'not 54mm tall');
});

// ---------------------------------------------------------------------------
// 5. The bug that started this
// ---------------------------------------------------------------------------

check('no QR is drawn with an <img> pointing at the signed endpoint', () => {
  // /api/qr.svg is behind the session, the session is a bearer token in a
  // header, and an <img> cannot send a header — so every one of those requests
  // came back 401 and rendered as a broken image. Fetched, always.
  assert.ok(
    !/<img[^>]*\/api\/qr\.svg/.test(app),
    'an <img> is pointed at /api/qr.svg; it will 401 and render as broken'
  );
  assert.ok(/async function qrSvg\(/.test(app), 'there is no qrSvg() helper');
});

check('the till options are on the Cards screen', () => {
  for (const field of ['till_wallet_button', 'till_print_button', 'wallet_on_display']) {
    assert.ok(
      html.includes(`data-card="${field}"`),
      `${field} has no control on the Cards screen`
    );
  }
});

console.log(`\n${passed} checks passed\n`);
