/**
 * The back office on a tablet, measured rather than eyeballed.
 *
 * This exists because of a bug report with screenshots attached: on an iPad the
 * heading read "epartments" instead of "Departments", a product called
 * Carlsberg read "Carli", and the Edit / Duplicate / Delete buttons on every
 * product row were painted off the right-hand edge of the screen where nothing
 * could reach them. The Table Designer was cut in half with no way to scroll to
 * the other side of the room.
 *
 * One cause under nearly all of it. `<main>` is a flex item, a flex item
 * defaults to `min-width: auto`, and that means it refuses to be narrower than
 * its content. A table wider than the column therefore made `<main>` wider than
 * its share, which made `#app` wider than the viewport, which gave the *page* a
 * horizontal scrollbar. The rail is `position: sticky`, which only sticks
 * vertically — so scrolling right to reach a button slid the content underneath
 * the rail and cut the heading off.
 *
 * The rule that would have caught it is the one this file asserts, at the two
 * sizes an iPad actually reports:
 *
 *     the page never scrolls sideways. Anything too wide scrolls in its own box.
 *
 * A static CSS reader cannot see that — backoffice-layout.test.js is the static
 * one, and it passed throughout — so this drives a real Chromium at real tablet
 * viewports and reads real geometry. It SKIPS itself where there is no
 * Chromium, like backoffice-screens-browser.test.js and for the same reason.
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const WebSocket = require('ws');

const PUBLIC = path.join(__dirname, '..', 'public');

let passed = 0;
const checks = [];
function check(name, fn) {
  checks.push({ name, fn });
}

/**
 * The two an iPad actually reports to a page.
 *
 * Neither is a phone and neither is a desktop, which is the whole trap: the
 * off-canvas drawer stops at 960px and the desktop rail starts at 961px, so
 * both of these get the full sidebar and rather less room than the laptop the
 * back office was laid out on.
 */
const VIEWPORTS = [
  { name: 'iPad portrait', width: 1024, height: 1366 },
  { name: 'iPad landscape', width: 1366, height: 1024 },
];

/** Every view a manager can open from the rail. */
const VIEWS = [
  'dashboard', 'report', 'products', 'stock', 'screens', 'modifiers',
  'tax', 'kitchen', 'tables', 'users', 'staff', 'customers', 'vouchers',
  'promotions', 'deposits', 'loyalty', 'tender', 'rules', 'idle',
];

// ---------------------------------------------------------------------------
// The stub back office
// ---------------------------------------------------------------------------

/**
 * Enough data to make the tables as wide as they get.
 *
 * Deliberately unflattering: long product names, a three-part gift-card code, a
 * description that wants to wrap. An empty catalogue would fit any screen and
 * prove nothing — the fault only appears once a table is wider than its card.
 */
function catalogue() {
  const departments = ['Beers', 'Wines', 'Spirits', 'Coffee', 'Mains', 'Desserts'];
  return Array.from({ length: 60 }, (_, i) => ({
    id: i + 1,
    pluid: 100 + i,
    product_name: `Carlsberg Export Draught Pint ${i + 1}`,
    department_name: departments[i % departments.length],
    group_name: 'Alcohol',
    price: 3.5,
    tax_percentage: 20,
    stock_quantity: 12,
    printer_routes: 'kp1',
    print_to_receipt: 1,
  }));
}

function startStub() {
  const state = { products: catalogue() };

  const rows = (n, make) => Array.from({ length: n }, (_, i) => make(i));

  const answers = {
    '/api/products': () => state.products,
    '/api/departments': () =>
      rows(6, (i) => ({
        id: i + 1,
        department_name: `Department number ${i + 1}`,
        group_name: 'Food',
        sort_order: i,
      })),
    '/api/groups': () => rows(4, (i) => ({ id: i + 1, group_name: `Sub ${i + 1}` })),
    '/api/tax': () => rows(3, (i) => ({ id: i + 1, name: `Rate ${i}`, percentage: 20 })),
    '/api/users': () =>
      rows(3, (i) => ({
        id: i + 1,
        name: 'Store Manager',
        email: 'manager@vesopa.co.uk',
        office_name: 'The Vesopa Kitchen',
        role: 'office',
      })),
    '/api/staff': () =>
      rows(4, (i) => ({ id: i + 1, name: `Clerk ${i + 1}`, pin: '1234', role: 'staff' })),
    '/api/customers': () =>
      rows(4, (i) => ({ id: i + 1, name: `Customer ${i + 1}`, email: 'a@b.co', phone: '07000 000000' })),
    '/api/gift-cards': () =>
      rows(5, (i) => ({
        id: i + 1,
        code: `86Y4-2G84-PH3${i}`,
        kind: 'smart',
        recipient_name: 'A. Khan',
        issued_minor: 5000,
        balance_minor: 3000,
        status: 'active',
      })),
    '/api/deposits': () =>
      rows(4, (i) => ({
        id: i + 1,
        reference: `DEP-26313${i}`,
        customer_name: 'Wedding party',
        purpose: 'Catering, 20 covers',
        amount_minor: 15000,
        redeemed_minor: 15000,
        status: 'redeemed',
      })),
    '/api/promotions': () =>
      rows(6, (i) => ({
        id: i + 1,
        name: 'Happy hour drinks',
        kind: 'percent',
        scope: 'department',
        scope_value: 'Drinks',
        value: 20,
        badge_text: '20% OFF',
        active: 1,
      })),
    '/api/automations': () =>
      rows(3, (i) => ({
        id: i + 1,
        name: 'Big spender bonus',
        trigger: 'sale_total',
        trigger_value: 10000,
        action: 'award_points',
        action_value: 500,
        priority: 5,
        active: 1,
      })),
    '/api/floor': () => [
      {
        id: 1,
        name: 'Main Floor',
        // Deliberately past the default 24-column room, and past what an iPad
        // can show: the reported fault was a table nobody could scroll to.
        tables: rows(12, (i) => ({
          id: i + 1,
          table_number: i + 1,
          seats: 4,
          pos_x: (i % 6) * 5,
          pos_y: Math.floor(i / 6) * 4,
          width: 3,
          height: 2,
          shape: i % 3 === 0 ? 'circle' : 'rect',
        })),
      },
      { id: 2, name: 'Terrace', tables: [] },
    ],
    '/api/till-settings': () => ({ home_screen_id: null }),
    '/api/screens': () => [],
    '/api/fonts': () => ({ fonts: [] }),
  };

  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.ttf': 'font/ttf',
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');

    if (url.pathname === '/e2e-boot') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(
        '<!doctype html><meta charset="utf-8"><script>' +
          "localStorage.setItem('vesopa_token', 'stub-token');" +
          "localStorage.setItem('vesopa_user', JSON.stringify({" +
          "id: 1, name: 'Store Manager', role: 'office', officeId: 9," +
          "officeName: 'The Vesopa Kitchen', email: 'manager@vesopa.co.uk'," +
          "officeEmail: 'manager@vesopa.co.uk'}));" +
          "location.replace('/');" +
          '</script>'
      );
    }

    if (url.pathname.startsWith('/api/')) {
      let body = '';
      req.on('data', (c) => (body += c));
      return req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        const make = answers[url.pathname];
        res.end(JSON.stringify(make ? make() : []));
      });
    }

    const file =
      url.pathname === '/' || !path.extname(url.pathname)
        ? path.join(PUBLIC, 'index.html')
        : path.join(PUBLIC, url.pathname);
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file)) {
      res.writeHead(404);
      return res.end('not found');
    }
    res.writeHead(200, {
      'Content-Type': types[path.extname(file)] || 'application/octet-stream',
    });
    res.end(fs.readFileSync(file));
  });

  const wss = new WebSocket.Server({ server, path: '/ws' });
  wss.on('connection', (socket) => socket.on('message', () => {}));

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, wss, state }));
  });
}

// ---------------------------------------------------------------------------
// The browser
// ---------------------------------------------------------------------------

function findChromium() {
  return [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ]
    .filter(Boolean)
    .find((p) => {
      try {
        return fs.existsSync(p);
      } catch {
        return false;
      }
    });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
}

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.next = 1;
    this.waiting = new Map();
    this.thrown = [];

    socket.on('message', (raw) => {
      const msg = JSON.parse(raw);
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        this.thrown.push(d.exception?.description || d.text || 'exception');
        return;
      }
      if (msg.method === 'Page.javascriptDialogOpening') {
        this.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
        return;
      }
      const pending = this.waiting.get(msg.id);
      if (!pending) return;
      this.waiting.delete(msg.id);
      if (msg.error) pending.reject(new Error(msg.error.message));
      else pending.resolve(msg.result);
    });
  }

  send(method, params = {}) {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.waiting.delete(id)) reject(new Error(`${method} timed out`));
      }, 20000);
    });
  }

  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression: `(() => { ${expression} })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      throw new Error(
        res.exceptionDetails.exception?.description ||
          res.exceptionDetails.text ||
          'page threw'
      );
    }
    return res.result.value;
  }

  /**
   * Pretend to be a tablet, properly.
   *
   * `deviceScaleFactor` and `mobile: false` match an iPad, and the touch
   * emulation matters as much as the width does: the fixes for this report are
   * behind `@media (pointer: coarse)`, and a desktop Chromium reports a mouse
   * however narrow its window is.
   */
  async asTablet(width, height) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 2,
      mobile: false,
      screenWidth: width,
      screenHeight: height,
    });
    await this.send('Emulation.setTouchEmulationEnabled', {
      enabled: true,
      maxTouchPoints: 5,
    });
    await this.send('Emulation.setEmitTouchEventsForMouse', {
      enabled: true,
      configuration: 'mobile',
    });
  }

  open(view) {
    return this.eval(
      `show('${view}');
       return new Promise((go) => setTimeout(() => go(true), 450));`
    );
  }
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

/**
 * The one that matters.
 *
 * A page that scrolls sideways is the whole bug: the rail only sticks
 * vertically, so the content slides under it and the heading is cut in half.
 * One pixel of tolerance for sub-pixel rounding, and no more.
 */
check('no view makes the page scroll sideways', async (cdp) => {
  const bad = [];
  for (const vp of VIEWPORTS) {
    await cdp.asTablet(vp.width, vp.height);
    for (const view of VIEWS) {
      await cdp.open(view);
      const over = await cdp.eval(
        `const d = document.documentElement;
         return Math.round(d.scrollWidth - d.clientWidth);`
      );
      if (over > 1) bad.push(`${vp.name} / ${view}: ${over}px`);
    }
  }
  assert.deepStrictEqual(bad, [], `the page scrolls sideways:\n      ${bad.join('\n      ')}`);
});

/**
 * And the consequence a manager actually reported: buttons they could not
 * reach. A control painted outside the viewport with no way to scroll to it is
 * a feature that does not exist on that device.
 */
check('every row button is reachable inside the window', async (cdp) => {
  const bad = [];
  for (const vp of VIEWPORTS) {
    await cdp.asTablet(vp.width, vp.height);
    for (const view of VIEWS) {
      await cdp.open(view);
      const escaped = await cdp.eval(
        `const w = document.documentElement.clientWidth;
         const out = [];
         for (const el of document.querySelectorAll('#view-${view} td .btn')) {
           const r = el.getBoundingClientRect();
           if (r.width === 0) continue;
           // Inside its own scroll box counts as reachable — that is what the
           // box is for. Outside the window with nothing to scroll does not.
           // Reachable means there is a box a finger can actually scroll.
           //
           // scrollWidth > clientWidth is NOT that test, and getting it wrong
           // is how the first version of this check passed against the broken
           // build: an element whose overflow is visible still reports its
           // content's extent in scrollWidth, so every overflowing card looked
           // scrollable while none of them scrolled. The computed overflow is
           // the only thing that answers it.
           const box = el.closest('.card');
           const style = box && getComputedStyle(box);
           const scrollable =
             box &&
             /auto|scroll/.test(style.overflowX) &&
             box.scrollWidth > box.clientWidth + 1;
           if (r.right > w + 1 && !scrollable) out.push(el.textContent.trim());
         }
         return out;`
      );
      for (const label of escaped) bad.push(`${vp.name} / ${view}: ${label}`);
    }
  }
  assert.deepStrictEqual(bad, [], `unreachable buttons:\n      ${bad.join('\n      ')}`);
});

/**
 * Nothing is clipped, anywhere.
 *
 * This is the check that actually reproduces the report, and it is worth being
 * precise about what the fault was, because two different things were happening
 * and only one of them is page overflow:
 *
 *   * `.card > table { overflow: hidden }` CLIPPED. A product called Carlsberg
 *     was painted as "Carli" and a price as "3.0(" — content rendered, then cut
 *     off, with nothing to scroll and no indication anything was missing.
 *   * Where a row's buttons escaped that clip they went past the viewport, the
 *     page scrolled sideways, and the sticky rail slid over the heading.
 *
 * So the condition is: if a card's content is wider than the card, the card has
 * to be a real scroll container. Clipping and page-scrolling are both failures.
 */
check('no table is clipped or left unscrollable', async (cdp) => {
  const bad = [];
  for (const vp of VIEWPORTS) {
    await cdp.asTablet(vp.width, vp.height);
    for (const view of VIEWS) {
      await cdp.open(view);
      const found = await cdp.eval(
        `const out = [];
         for (const card of document.querySelectorAll('#view-${view} .card')) {
           const table = card.querySelector(':scope > table');
           if (!table || card.clientWidth === 0) continue;
           const wanted = table.scrollWidth;
           if (wanted <= card.clientWidth + 1) continue;   // it fits; nothing to prove
           const style = getComputedStyle(card);
           if (!/auto|scroll/.test(style.overflowX)) {
             out.push('needs ' + wanted + 'px in ' + card.clientWidth + 'px, overflow-x: ' + style.overflowX);
           }
         }
         return out;`
      );
      for (const why of found) bad.push(`${vp.name} / ${view}: ${why}`);
    }
  }
  assert.deepStrictEqual(
    bad,
    [],
    'content with nowhere to go:\n      ' + bad.join('\n      ')
  );
});

/**
 * The same question one breakpoint down, where the tables are not tables.
 *
 * Below 760px a table carrying `.table-cards` stops being a grid and each row
 * becomes a card: the heading row goes, every cell is a full-width label/value
 * line, and the row buttons get a line of their own. That layout has one thing
 * it must do, and it is the thing it was not doing — fill the card.
 *
 * `.card > table td { max-width: 42ch }` is a ceiling meant for a *column*, and
 * it out-specifies `.table-cards td`, so every cell stopped at about 357px and
 * left the rest of the card — up to 335px of it — blank. On Products, Stock,
 * Staff, Customers, Vouchers, Promotions, Gift cards, Deposits, Departments,
 * Tax, and every admin list besides. It reads as an application with a margin
 * down one side, which is exactly how it was reported.
 *
 * A phone width in a file about tablets because the fault is the same fault:
 * a rule written for one device size reaching into another. 700px is chosen so
 * a 42ch cell would leave a hole nobody could mistake for slack.
 */
check('no card row stops short of the card it is in', async (cdp) => {
  await cdp.asTablet(700, 1000);
  const bad = [];
  for (const view of VIEWS) {
    await cdp.open(view);
    const short = await cdp.eval(
      `const out = [];
       for (const table of document.querySelectorAll('#view-${view} table.table-cards')) {
         for (const row of table.tBodies[0] ? table.tBodies[0].rows : []) {
           const rs = getComputedStyle(row);
           const rr = row.getBoundingClientRect();
           const right =
             rr.right - parseFloat(rs.paddingRight) - parseFloat(rs.borderRightWidth);
           for (const cell of row.cells) {
             if (getComputedStyle(cell).display === 'none') continue;
             const cr = cell.getBoundingClientRect();
             if (cr.width === 0) continue;
             // The cell's own box, not its contents: a checkbox beside its
             // heading is meant to stop early, a cell is not.
             const gap = Math.round(right - cr.right);
             if (gap > 8) {
               out.push((cell.getAttribute('data-label') || cell.className || 'cell') +
                        ' stops ' + gap + 'px short');
             }
           }
         }
       }
       return [...new Set(out)];`
    );
    for (const why of short) bad.push(`${view}: ${why}`);
  }
  // Put the browser back, or every check written after this one runs on a phone.
  await cdp.asTablet(1024, 1366);
  assert.deepStrictEqual(
    bad,
    [],
    'cells that stop short of their card:\n      ' + bad.join('\n      ')
  );
});

/** And a card layout was actually reached, or the check above passed on an
    empty list of tables. */
check('the phone card layout is the one being measured', async (cdp) => {
  await cdp.asTablet(700, 1000);
  await cdp.open('products');
  const seen = await cdp.eval(
    `const t = document.querySelector('#view-products table.table-cards');
     if (!t) return null;
     const row = t.tBodies[0].rows[0];
     return {
       stacked: getComputedStyle(row).display === 'block',
       labelled: [...row.cells].some((c) => c.hasAttribute('data-label')),
       cells: row.cells.length,
     };`
  );
  await cdp.asTablet(1024, 1366);
  assert.ok(seen, 'the products table never took the card layout');
  assert.ok(seen.stacked, 'rows are still laid out as table rows at 700px');
  assert.ok(seen.labelled, 'no cell carries the heading it lost with the thead');
  assert.ok(seen.cells > 3, `only ${seen.cells} cells to measure`);
});

/** And the products table is genuinely wider than an iPad, or the check above
    would be passing because there was nothing to test. */
check('the products table really is wider than the screen', async (cdp) => {
  await cdp.asTablet(1024, 1366);
  await cdp.open('products');
  const box = await cdp.eval(
    `const card = document.querySelector('#view-products .card:has(> table)');
     if (!card) return null;
     const table = card.querySelector(':scope > table');
     return {
       table: table.scrollWidth,
       card: card.clientWidth,
       overflowX: getComputedStyle(card).overflowX,
       page: Math.round(document.documentElement.scrollWidth - document.documentElement.clientWidth),
     };`
  );
  assert.ok(box, 'no table card on the products view');
  assert.ok(
    box.table > box.card + 1,
    `the fixture is too narrow to prove anything: ${box.table}px in ${box.card}px`
  );
  assert.match(box.overflowX, /auto|scroll/, 'the card is not a scroll container');
  assert.ok(box.page <= 1, `the page scrolled ${box.page}px instead of the card`);
});

/** The heading is not underneath the rail. */
check('the page heading clears the sidebar', async (cdp) => {
  const bad = [];
  for (const vp of VIEWPORTS) {
    await cdp.asTablet(vp.width, vp.height);
    for (const view of ['products', 'tax', 'users']) {
      await cdp.open(view);
      const clash = await cdp.eval(
        `const rail = document.querySelector('.rail');
         const h = document.querySelector('#view-${view} .page-head h2');
         if (!rail || !h) return null;
         return Math.round(h.getBoundingClientRect().left - rail.getBoundingClientRect().right);`
      );
      if (clash !== null && clash < 0) bad.push(`${vp.name} / ${view}: ${clash}px`);
    }
  }
  assert.deepStrictEqual(bad, [], `headings under the rail:\n      ${bad.join('\n      ')}`);
});

/**
 * The Table Designer, which was the one named in the report: "cut in my iPad
 * and cannot go the right side thus cannot set anything to that side".
 */
check('the floor plan can be scrolled to its far side', async (cdp) => {
  await cdp.asTablet(1024, 1366);
  await cdp.open('tables');
  const canvas = await cdp.eval(
    `const c = document.getElementById('canvas');
     const far = [...document.querySelectorAll('#canvas .tbl')]
       .reduce((m, el) => Math.max(m, el.offsetLeft + el.offsetWidth), 0);
     return {
       clientWidth: c.clientWidth,
       scrollWidth: c.scrollWidth,
       far,
       roomW: getComputedStyle(c).getPropertyValue('--room-w').trim(),
     };`
  );
  // The room is wider than the window, which is the situation being fixed —
  // if it were not, this check would pass for the wrong reason.
  assert.ok(
    canvas.scrollWidth > canvas.clientWidth + 1,
    'the canvas does not scroll, so a wide plan is still unreachable'
  );
  // And everything in the room is inside what can be scrolled to.
  assert.ok(
    canvas.far <= canvas.scrollWidth + 1,
    `a table sits ${canvas.far - canvas.scrollWidth}px beyond anything scrollable`
  );
  assert.ok(canvas.roomW, 'the room has no size of its own');
});

/** Form controls are 16px, or iOS zooms the page in on focus and stays there. */
check('a form control never triggers the iOS focus zoom', async (cdp) => {
  await cdp.asTablet(1024, 1366);
  await cdp.open('products');
  const small = await cdp.eval(
    `const out = [];
     for (const el of document.querySelectorAll('input, select, textarea')) {
       if (el.type === 'hidden' || el.offsetParent === null) continue;
       const size = parseFloat(getComputedStyle(el).fontSize);
       if (size < 16) out.push((el.id || el.className || el.tagName) + ' @ ' + size + 'px');
     }
     return out.slice(0, 8);`
  );
  assert.deepStrictEqual(
    small,
    [],
    'Safari zooms the whole page when one of these takes focus, and does not ' +
      'zoom back out:\n      ' + small.join('\n      ')
  );
});

/** A finger is about 9mm across. These are what it has to hit. */
check('buttons are big enough for a thumb', async (cdp) => {
  await cdp.asTablet(1366, 1024);
  await cdp.open('products');
  const small = await cdp.eval(
    `const out = [];
     for (const el of document.querySelectorAll('#view-products .btn, .rail .nav')) {
       const r = el.getBoundingClientRect();
       if (r.height === 0) continue;
       if (r.height < 36) out.push(el.textContent.trim().slice(0, 20) + ' @ ' + Math.round(r.height) + 'px');
     }
     return [...new Set(out)].slice(0, 8);`
  );
  assert.deepStrictEqual(small, [], `too small to press:\n      ${small.join('\n      ')}`);
});

check('nothing on the page threw while all that happened', async (cdp) => {
  assert.strictEqual(cdp.thrown.length, 0, cdp.thrown.join(' ; '));
});

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

async function main() {
  console.log('Back office: on a tablet\n');

  const chromium = findChromium();
  if (!chromium) {
    console.log('  -- skipped: no Chrome or Edge on this machine');
    console.log('\n0 checks run');
    return;
  }

  const { server, wss } = await startStub();
  const port = server.address().port;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vesopa-tablet-'));

  const browser = spawn(
    chromium,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--disable-extensions',
      '--window-size=1400,1100',
      `http://127.0.0.1:${port}/e2e-boot`,
    ],
    { stdio: 'ignore' }
  );

  let cdp = null;
  try {
    const portFile = path.join(profile, 'DevToolsActivePort');
    let devPort = null;
    for (let i = 0; i < 100 && !devPort; i++) {
      await sleep(200);
      if (fs.existsSync(portFile)) {
        devPort = Number(fs.readFileSync(portFile, 'utf8').split('\n')[0]);
      }
    }
    assert.ok(devPort, 'the browser never reported a debugging port');

    let target = null;
    for (let i = 0; i < 50 && !target; i++) {
      await sleep(200);
      const targets = await getJson(`http://127.0.0.1:${devPort}/json/list`);
      target = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    }
    assert.ok(target, 'no page target to attach to');

    const socket = new WebSocket(target.webSocketDebuggerUrl, {
      perMessageDeflate: false,
      maxPayload: 64 * 1024 * 1024,
    });
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    cdp = new Cdp(socket);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    // Wait for the app to have booted and rendered a view.
    let ready = false;
    for (let i = 0; i < 80 && !ready; i++) {
      await sleep(250);
      ready = await cdp
        .eval(`return typeof show === 'function' && !!document.querySelector('.rail .nav');`)
        .catch(() => false);
    }
    assert.ok(ready, 'the back office never booted');

    for (const { name, fn } of checks) {
      try {
        await fn(cdp);
        passed++;
        console.log(`  ok  ${name}`);
      } catch (e) {
        console.log(`FAIL  ${name}\n      ${e.message}`);
        process.exitCode = 1;
      }
    }

    // `SHOT=<dir> node test/backoffice-tablet.test.js` leaves a picture of every
    // view at both tablet sizes. Half of what goes wrong on a tablet is a
    // layout no assertion is watching.
    if (process.env.SHOT) {
      fs.mkdirSync(process.env.SHOT, { recursive: true });
      for (const vp of VIEWPORTS) {
        await cdp.asTablet(vp.width, vp.height);
        for (const view of VIEWS) {
          await cdp.open(view);
          const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
          const file = path.join(
            process.env.SHOT,
            `${vp.width}x${vp.height}-${view}.png`
          );
          fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
        }
      }
      console.log(`  -- wrote screenshots to ${process.env.SHOT}`);
    }
  } finally {
    if (cdp) cdp.socket.close();
    browser.kill();
    wss.close();
    server.close();
    try {
      fs.rmSync(profile, { recursive: true, force: true });
    } catch {
      // Windows sometimes still holds the profile a moment after the kill.
    }
  }

  console.log(`\n${passed} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
