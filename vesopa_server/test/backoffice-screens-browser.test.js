/**
 * The screen editor, in an actual browser.
 *
 * The other editor test lifts the deciding functions out of public/screens.js
 * and runs them on their own, which is the right shape for "does a kind change
 * clear the other references". It cannot see the class of bug this file exists
 * for, and that class is the one that got reported:
 *
 *   * drag-select did nothing at all with a touchscreen, because a touch
 *     pointer is implicitly captured by the element it went down on and the
 *     `pointerover` events the old editor waited for never arrived;
 *   * changing the row count threw away every unsaved button on the screen;
 *   * a press on a cell swallowed by a 2x2 selected the hole underneath it.
 *
 * None of those are visible without a compositor, a pointer and a real grid, so
 * this drives Chrome — or Edge, whichever is installed — over the DevTools
 * protocol, against a stub API that answers with a layout and a catalogue. No
 * database, no live server, no session: the point is the editor's own code
 * running in the browser the manager uses.
 *
 * SKIPPED, rather than failed, when there is no Chromium on the machine. This
 * runs beside tests that need nothing at all, and a suite that cannot be run on
 * a bare box is a suite people stop running.
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

// ---------------------------------------------------------------------------
// The stub back office
// ---------------------------------------------------------------------------

/**
 * Enough catalogue to be honest about it.
 *
 * Six hundred products, because the editor's old inspector rebuilt every one of
 * them into a select on every pixel of a drag, and with a demo-sized list of
 * twelve that is invisible.
 */
function catalogue() {
  const departments = ['Beers', 'Wines', 'Spirits', 'Coffee', 'Mains', 'Desserts'];
  const rows = [];
  for (let i = 0; i < 600; i++) {
    rows.push({
      id: i + 1,
      pluid: 100 + i,
      product_name: `Product ${i + 1}`,
      department_name: departments[i % departments.length],
      price: 2.5,
      tax_percentage: 20,
    });
  }
  return rows;
}

/** A screen with a 2x2 in the corner, so covered cells are exercised. */
function layout() {
  return {
    id: 1,
    name: 'OnzepTest',
    surface: 'sale',
    rows: 4,
    cols: 5,
    sortOrder: 0,
    buttons: [
      { id: 1, row: 0, col: 0, rowSpan: 2, colSpan: 2, kind: 'product', pluId: 100, label: null, fill: '#4b57e8', ink: null, targetScreenId: null, functionKey: null },
      { id: 2, row: 0, col: 3, rowSpan: 1, colSpan: 1, kind: 'product', pluId: 101, label: null, fill: null, ink: null, targetScreenId: null, functionKey: null },
      { id: 3, row: 3, col: 4, rowSpan: 1, colSpan: 1, kind: 'function', functionKey: 'qty', pluId: null, targetScreenId: null, label: null, fill: null, ink: null },
    ],
  };
}

function startStub() {
  const state = {
    screens: [
      layout(),
      { id: 2, name: 'Drinks', surface: 'sale', rows: 3, cols: 3, sortOrder: 1, buttons: [], topBarId: null, bottomBarId: null },
      {
        id: 7,
        name: 'Counter bar',
        surface: 'bottombar',
        rows: 1,
        cols: 4,
        sortOrder: 0,
        buttons: [
          { id: 9, row: 0, col: 0, rowSpan: 1, colSpan: 1, kind: 'function', functionKey: 'void', pluId: null, targetScreenId: null, label: null, fill: '#d03227', ink: null, emoji: null, imageUrl: null },
          { id: 10, row: 0, col: 1, rowSpan: 1, colSpan: 3, kind: 'function', functionKey: 'pay', pluId: null, targetScreenId: null, label: 'Pay', fill: '#a5c715', ink: null, emoji: null, imageUrl: null },
        ],
      },
      {
        id: 8,
        name: 'Tables strip',
        surface: 'topbar',
        rows: 1,
        cols: 4,
        sortOrder: 0,
        buttons: [
          { id: 11, row: 0, col: 0, rowSpan: 1, colSpan: 4, kind: 'function', functionKey: 'open_bills', pluId: null, targetScreenId: null, label: null, fill: null, ink: null, emoji: null, imageUrl: null },
        ],
      },
    ],
    defaults: null,
    products: catalogue(),
    saved: null,
    resized: null,
  };

  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const send = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    // The session the app boots from. Injected here rather than through the
    // sign-in form: this is a test of the editor, not of the login page, and a
    // password does not belong in a test file.
    if (url.pathname === '/e2e-boot') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(
        '<!doctype html><meta charset="utf-8"><script>' +
          "localStorage.setItem('vesopa_token', 'stub-token');" +
          "localStorage.setItem('vesopa_user', JSON.stringify({" +
          "id: 1, name: 'Store Manager', role: 'office', officeId: 9," +
          "officeName: 'The Vesopa Kitchen', email: 'manager@vesopa.co.uk'," +
          "officeEmail: 'manager@vesopa.co.uk'}));" +
          "location.replace('/screen-programming');" +
          '</script>'
      );
    }

    if (url.pathname.startsWith('/api/')) {
      let body = '';
      req.on('data', (c) => (body += c));
      return req.on('end', () => {
        const json = body ? JSON.parse(body) : {};

        if (url.pathname === '/api/screens' && req.method === 'GET') {
          return send(200, state.screens);
        }
        if (url.pathname === '/api/products') return send(200, state.products);
        if (url.pathname === '/api/till-settings') {
          return send(200, {
            home_screen_id: 1,
            top_bar_screen_id: null,
            bottom_bar_screen_id: 7,
          });
        }
        if (url.pathname === '/api/screens/defaults') {
          state.defaults = json;
          return send(200, { ok: true, ...json });
        }
        if (/^\/api\/screens\/\d+\/buttons$/.test(url.pathname)) {
          state.saved = json.buttons;
          const screen = state.screens[0];
          screen.buttons = json.buttons.map((b, i) => ({ ...b, id: i + 1 }));
          return send(200, screen);
        }
        if (/^\/api\/screens\/\d+$/.test(url.pathname) && req.method === 'PUT') {
          state.resized = { rows: json.rows, cols: json.cols };
          if (json.rows) state.screens[0].rows = json.rows;
          if (json.cols) state.screens[0].cols = json.cols;
          return send(200, state.screens[0]);
        }
        return send(200, { ok: true });
      });
    }

    const file = url.pathname === '/' || !path.extname(url.pathname)
      ? path.join(PUBLIC, 'index.html')
      : path.join(PUBLIC, url.pathname);
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file)) {
      res.writeHead(404);
      return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });

  // The back office opens a socket on start and reconnects every three seconds
  // if it cannot. Answered so the console stays readable.
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
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  return candidates.find((p) => {
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

/** The thinnest DevTools client that will do: one socket, id -> promise. */
class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.next = 1;
    this.waiting = new Map();
    /** Anything the page threw, from the browser rather than from a shim in
        the page — an exception during load happens before a shim could be
        installed, and that is exactly when the interesting ones happen. */
    this.thrown = [];

    socket.on('message', (raw) => {
      const msg = JSON.parse(raw);

      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        this.thrown.push(
          d.exception?.description || d.text || 'exception with no detail'
        );
        return;
      }
      // A confirm() left open would wedge the run. None of the checks below
      // provoke one, so this is a net rather than a behaviour.
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

  /** Evaluate an expression in the page and bring the value back. */
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

  /** The middle of a cell, in viewport coordinates. */
  cell(row, col) {
    return this.eval(
      `const el = document.querySelector('#sp-grid .sp-cell[data-row="${row}"][data-col="${col}"]');
       if (!el) return null;
       const r = el.getBoundingClientRect();
       return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };`
    );
  }

  async mouseDrag(from, to) {
    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1,
    });
    // Two moves, because one is indistinguishable from a press that never moved
    // and the editor treats that as a click rather than a drag.
    const mid = { x: Math.round((from.x + to.x) / 2), y: Math.round((from.y + to.y) / 2) };
    for (const point of [mid, to]) {
      await this.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: point.x, y: point.y, button: 'left', buttons: 1,
      });
    }
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1,
    });
  }

  async touchDrag(from, to) {
    const mid = { x: Math.round((from.x + to.x) / 2), y: Math.round((from.y + to.y) / 2) };
    await this.send('Input.dispatchTouchEvent', {
      type: 'touchStart', touchPoints: [{ x: from.x, y: from.y, id: 1 }],
    });
    for (const point of [mid, to]) {
      await this.send('Input.dispatchTouchEvent', {
        type: 'touchMove', touchPoints: [{ x: point.x, y: point.y, id: 1 }],
      });
    }
    await this.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }

  async click(x, y) {
    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1,
    });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1,
    });
  }
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

async function main() {
  console.log('Back office: the screen editor, in a browser\n');

  const chromium = findChromium();
  if (!chromium) {
    console.log('  -- skipped: no Chrome or Edge on this machine');
    console.log('\n0 checks run');
    return;
  }

  const { server, wss } = await startStub();
  const port = server.address().port;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vesopa-e2e-'));

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
      '--window-size=1600,1000',
      `http://127.0.0.1:${port}/e2e-boot`,
    ],
    { stdio: 'ignore' }
  );

  let cdp = null;
  try {
    // Chromium writes the port it settled on into the profile.
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
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');

    // Wait for the editor to have drawn. The boot page redirects, so this is
    // also what proves app.js got as far as opening the view.
    let ready = false;
    for (let i = 0; i < 100 && !ready; i++) {
      await sleep(200);
      ready = await cdp
        .eval(
          `return typeof spCurrent !== 'undefined' && !!spCurrent &&
                  document.querySelectorAll('#sp-grid .sp-cell').length > 0;`
        )
        .catch(() => false);
    }
    if (!ready) {
      // Say what the page actually was, or this is a one-line failure with
      // nothing to go on.
      const where = await cdp
        .eval(
          `return {
             url: location.href,
             view: typeof currentView === 'undefined' ? '(no app.js)' : currentView,
             screens: typeof spScreens === 'undefined' ? '(no screens.js)' : spScreens.length,
             body: document.body ? document.body.innerHTML.length : 0,
           };`
        )
        .catch((e) => ({ url: 'evaluate failed: ' + e.message }));
      assert.fail(
        `the screen editor never drew — ${JSON.stringify(where)}` +
          (cdp.thrown.length ? `\n      page threw: ${cdp.thrown.join(' ; ')}` : '')
      );
    }

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

    // `SHOT=<dir> node test/backoffice-screens-browser.test.js` leaves a picture
    // of each surface behind. Worth the dozen lines: this suite is the only
    // thing on the machine that renders this page at all, and half of what goes
    // wrong with an editor is a layout no assertion is watching — a card that
    // pushes the grid off the bottom of the window, say, which is exactly what
    // happened when the defaults card was added.
    if (process.env.SHOT) {
      fs.mkdirSync(process.env.SHOT, { recursive: true });
      for (const surface of ['sale', 'topbar', 'bottombar']) {
        await cdp.eval(
          `document.querySelector('.sp-surface[data-surface="${surface}"]').click();
           window.scrollTo(0, 0);
           return true;`
        );
        await sleep(200);
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
        const file = path.join(process.env.SHOT, `editor-${surface}.png`);
        fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
        console.log(`  -- wrote ${file}`);
      }
    }
  } finally {
    if (cdp) cdp.socket.close();
    browser.kill();
    wss.close();
    server.close();
    // The profile is a few megabytes and there is one per run.
    try {
      fs.rmSync(profile, { recursive: true, force: true });
    } catch {
      // Windows sometimes still has a handle on it a moment after the kill.
    }
  }

  console.log(`\n${passed} checks passed`);
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

/**
 * Put the editor back to the layout it loaded with.
 *
 * Through loadScreens rather than by hand, so each check starts from the state
 * a manager would actually be looking at — and so a check that left unsaved
 * work behind cannot leak into the next one.
 */
async function reset(cdp) {
  await cdp.eval(`
    spCurrent = null;
    spSavedShape = '';
    spSelection = new Set();
    spClipboard = null;
    spPreview = false;
    // Back to the sale screens as well. The tab is deliberately sticky in the
    // app — a manager who opens the bottom bars and reloads should still be
    // looking at them — so a check that leaves it on the bars would hand the
    // next one a bar to drag across.
    spSurface = 'sale';
    return loadScreens().then(() => true);`);
  // Scrolled to where a person would have it before touching the grid. Nothing
  // here scrolls on its own any more (see spDragStart), so this is the only
  // place the page moves.
  await cdp.eval(
    `document.getElementById('sp-grid').scrollIntoView({ block: 'center' });
     return true;`
  );
}

check('the grid draws one key per cell, and none for the ones a 2x2 swallows', async (cdp) => {
  await reset(cdp);
  // 4 x 5 is twenty cells; the 2x2 in the corner takes four of them and leaves
  // one key, so seventeen are drawn.
  const drawn = await cdp.eval(
    `return document.querySelectorAll('#sp-grid .sp-cell').length;`
  );
  assert.strictEqual(drawn, 17, 'the covered cells were drawn as empty keys');
});

check('a mouse drag selects the box it was dragged across', async (cdp) => {
  await reset(cdp);
  const from = await cdp.cell(2, 0);
  const to = await cdp.cell(3, 2);
  await cdp.mouseDrag(from, to);

  const selected = await cdp.eval(`return [...spSelection].sort().join(',');`);
  assert.strictEqual(selected, '2:0,2:1,2:2,3:0,3:1,3:2');
});

// The one that was reported. A touch pointer is captured by the element it goes
// down on, so the editor's old pointerover-on-each-cell selection never saw a
// second cell — on a Windows 11 laptop, which is very often a touchscreen, drag
// select simply did nothing.
check('a touch drag selects the same box a mouse would', async (cdp) => {
  await reset(cdp);
  await cdp.send('Emulation.setTouchEmulationEnabled', {
    enabled: true,
    maxTouchPoints: 5,
  });
  try {
    const from = await cdp.cell(2, 0);
    const to = await cdp.cell(3, 2);
    await cdp.touchDrag(from, to);

    const selected = await cdp.eval(`return [...spSelection].sort().join(',');`);
    assert.strictEqual(
      selected,
      '2:0,2:1,2:2,3:0,3:1,3:2',
      'drag-select is dead under a finger'
    );
  } finally {
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  }
});

// A cell under a 2x2 is not a cell you can programme. Pressing one used to add
// the hole to the selection, and the inspector then created a button in it —
// invisible on the grid, saved to the server, drawn by nothing.
check('a press inside a 2x2 selects the button, not the hole under it', async (cdp) => {
  await reset(cdp);
  const origin = await cdp.cell(0, 0);
  // The bottom-right quarter of the 2x2, which is cell 1:1.
  const box = await cdp.eval(
    `const el = document.querySelector('#sp-grid .sp-cell[data-row="0"][data-col="0"]');
     const r = el.getBoundingClientRect();
     return { x: Math.round(r.right - r.width / 4), y: Math.round(r.bottom - r.height / 4) };`
  );
  assert.ok(box.x > origin.x, 'the 2x2 did not span two columns');

  await cdp.click(box.x, box.y);
  const selected = await cdp.eval(`return [...spSelection].join(',');`);
  assert.strictEqual(selected, '0:0');
});

// Select it, then drag it. A plain drag is always a box — see the check below
// for why: on a finished layout there is no empty cell to start a box from, so
// "drag a filled key moves it" made bulk selection unreachable exactly where a
// venue needs it.
check('a selected key is dragged to a new cell, and undo puts it back', async (cdp) => {
  await reset(cdp);
  const from = await cdp.cell(0, 3);
  const to = await cdp.cell(2, 4);
  await cdp.click(from.x, from.y);
  await cdp.mouseDrag(from, to);

  const moved = await cdp.eval(
    `const b = spCurrent.buttons.find((x) => x.pluId === 101);
     return b ? b.row + ':' + b.col : 'gone';`
  );
  assert.strictEqual(moved, '2:4', 'the key did not move');

  await cdp.eval(`spUndo(); return true;`);
  const back = await cdp.eval(
    `const b = spCurrent.buttons.find((x) => x.pluId === 101);
     return b ? b.row + ':' + b.col : 'gone';`
  );
  assert.strictEqual(back, '0:3', 'undo did not put it back');
});

// Changing the row count used to PUT immediately and reload, which threw away
// every unsaved button on the screen — twenty minutes of work for one keystroke
// in a number box.
// The failure this pair guards is the one a finished screen meets first. A
// venue's real layout has no empty cells left in it, so if a drag beginning on
// a programmed key were a move, a box could never be drawn at all and every
// bulk edit in the panel — colour these six, clear this row — would be
// unreachable on precisely the screens that have been worked on most.
check('a drag across programmed keys draws a box rather than moving them', async (cdp) => {
  await reset(cdp);
  await cdp.eval(`
    // Fill the grid, so there is nowhere empty to start a drag from.
    spSelection = new Set();
    for (let r = 0; r < spCurrent.rows; r++) {
      for (let c = 0; c < spCurrent.cols; c++) spSelection.add(r + ':' + c);
    }
    spApplyToSelection((b) => { spSetKind(b, 'product'); b.pluId = 100; });
    spSelection = new Set();
    spPaintSelection();
    return spCurrent.buttons.length;`);

  // Clear of the 2x2 in the corner, whose cells are not keys of their own.
  const from = await cdp.cell(2, 1);
  const to = await cdp.cell(3, 2);
  await cdp.mouseDrag(from, to);

  const selected = await cdp.eval(`return [...spSelection].sort().join(',');`);
  assert.strictEqual(selected, '2:1,2:2,3:1,3:2', 'the drag moved a key instead of selecting');
});

check('growing the grid keeps the unsaved layout', async (cdp) => {
  await reset(cdp);
  const before = await cdp.eval(`
    spSelection = new Set(['3:0']);
    spApplyToSelection((b) => { spSetKind(b, 'product'); b.pluId = 200; });
    return spCurrent.buttons.length;`);
  assert.strictEqual(before, 4, 'the new button was not added');

  await cdp.eval(`
    const rows = document.getElementById('sp-rows');
    rows.value = '6';
    rows.dispatchEvent(new Event('change'));
    return true;`);

  const after = await cdp.eval(
    `return { rows: spCurrent.rows, buttons: spCurrent.buttons.length, dirty: spDirty() };`
  );
  assert.strictEqual(after.rows, 6, 'the grid did not grow');
  assert.strictEqual(after.buttons, 4, 'the unsaved buttons went with the resize');
  assert.strictEqual(after.dirty, true, 'a resize is not being counted as a change');
});

// The label field used to be rewritten by the redraw its own keystroke caused:
// the trimmed value went back in, the caret jumped to the end, and a trailing
// space could not be typed at all.
check('typing in the label field is not fought by the editor', async (cdp) => {
  await reset(cdp);
  await cdp.eval(`
    spSelection = new Set(['0:0']);
    spRenderInspector();
    const el = document.getElementById('sp-label');
    el.focus();
    return true;`);

  await cdp.send('Input.insertText', { text: 'Half ' });
  const typed = await cdp.eval(`
    const el = document.getElementById('sp-label');
    spRenderInspector();
    return { value: el.value, caret: el.selectionStart, focused: document.activeElement === el };`);

  assert.strictEqual(typed.value, 'Half ', 'the field was rewritten mid-typing');
  assert.strictEqual(typed.caret, 5, 'the caret was thrown to the end');
  assert.strictEqual(typed.focused, true, 'the redraw stole the focus');
});

// A layout that has been made bigger has to have its new size stored before
// its buttons are: the server normalises what it is sent against the grid it
// already holds, so a key in a newly added row arrives out of bounds and is
// dropped. Watched at the fetch, because the two calls and their order are the
// whole behaviour.
check('the whole layout is what saves, and the new size goes first', async (cdp) => {
  await reset(cdp);
  const sent = await cdp.eval(`
    spSelection = new Set(['3:0']);
    spApplyToSelection((b) => { spSetKind(b, 'product'); b.pluId = 300; });
    spCurrent.rows = 5;

    const calls = [];
    const realFetch = window.fetch;
    const reply = (data) => ({ ok: true, status: 200, json: async () => data });
    window.fetch = async (url, options) => {
      const path = String(url);
      const opts = options || {};
      calls.push({ path, method: opts.method || 'GET', body: opts.body || null });
      if (/buttons$/.test(path)) return reply({ id: 1, name: 'OnzepTest', rows: 5, cols: 5, buttons: [] });
      if (/\\/api\\/screens$/.test(path)) return reply([]);
      if (/products/.test(path)) return reply([]);
      if (/till-settings/.test(path)) return reply({ home_screen_id: 1 });
      return reply({ ok: true });
    };

    return (async () => {
      try {
        await spSaveLayout({ quiet: true });
      } finally {
        window.fetch = realFetch;
      }
      return calls
        .filter((c) => c.method === 'PUT')
        .map((c) => {
          let count = '';
          try {
            const body = JSON.parse(c.body || '{}');
            count = body.buttons ? String(body.buttons.length) : '';
          } catch (e) {
            count = '?';
          }
          return c.method + ' ' + c.path + '|' + count;
        });
    })();`);

  const size = sent.findIndex((c) => c.startsWith('PUT /api/screens/1|'));
  const buttons = sent.findIndex((c) => c.startsWith('PUT /api/screens/1/buttons'));
  assert.ok(size >= 0, `the new grid size was never sent: ${sent.join(' ; ')}`);
  assert.ok(buttons >= 0, `the layout was never sent: ${sent.join(' ; ')}`);
  assert.ok(size < buttons, 'the buttons were sent before the grid could hold them');
  assert.strictEqual(
    sent[buttons].split('|')[1],
    '4',
    'the save did not carry every button'
  );
});

check('the product picker searches instead of listing six hundred', async (cdp) => {
  await reset(cdp);
  const counts = await cdp.eval(`
    spSelection = new Set(['0:0']);
    spRenderInspector();
    const q = document.getElementById('sp-product-q');
    const before = document.getElementById('sp-product').options.length;
    q.value = 'Product 42';
    q.dispatchEvent(new Event('input'));
    const after = document.getElementById('sp-product').options.length;
    return { before, after };`);

  assert.strictEqual(counts.before, 601, 'the catalogue was not offered in full');
  assert.ok(counts.after > 1 && counts.after < 20, `search returned ${counts.after - 1} products`);
});

check('the check list names the keys that point at nothing', async (cdp) => {
  await reset(cdp);
  const state = await cdp.eval(`
    spSelection = new Set(['3:1']);
    spApplyToSelection((b) => { spSetKind(b, 'product'); b.pluId = 999999; });
    return {
      hidden: document.getElementById('sp-issues-card').hidden,
      issues: document.querySelectorAll('#sp-issues .sp-issue').length,
      missing: document.querySelectorAll('#sp-grid .sp-cell.missing').length,
    };`);

  assert.strictEqual(state.hidden, false, 'a broken key was not called out');
  assert.strictEqual(state.issues, 1);
  assert.strictEqual(state.missing, 1);
});

// ---------------------------------------------------------------------------
// The bars
// ---------------------------------------------------------------------------

check('the tabs keep sale screens and bars apart', async (cdp) => {
  await reset(cdp);
  const sale = await cdp.eval(
    `return [...document.getElementById('sp-screen').options].map((o) => o.text).join('|');`
  );
  assert.ok(sale.includes('OnzepTest'), 'the sale screens are not listed');
  assert.ok(!sale.includes('Counter bar'), 'a bar is listed among the screens');

  await cdp.eval(
    `document.querySelector('.sp-surface[data-surface="bottombar"]').click(); return true;`
  );
  const bars = await cdp.eval(
    `return [...document.getElementById('sp-screen').options].map((o) => o.text).join('|');`
  );
  // The bar this venue's tills are wearing, said in the picker rather than
  // only in the card above it.
  assert.strictEqual(bars, 'Counter bar — on your tills');

  const isBar = await cdp.eval(
    `return document.getElementById('sp-grid').classList.contains('bar');`
  );
  assert.ok(isBar, 'a bar is being drawn as a sale grid');
});

check('a bar is offered Pay, and a sale screen is not', async (cdp) => {
  await reset(cdp);
  const offered = async () =>
    cdp.eval(
      `spSelection = new Set(['0:0']); spRenderInspector();
       return [...document.getElementById('sp-function').options].map((o) => o.value).join(',');`
    );

  const onSale = await offered();
  assert.ok(!onSale.includes('pay'), 'Pay is on offer in the middle of the products');

  await cdp.eval(
    `document.querySelector('.sp-surface[data-surface="bottombar"]').click(); return true;`
  );
  const onBar = await offered();
  assert.ok(onBar.includes('pay'), 'a bottom bar cannot take money');
  assert.ok(onBar.includes('open_bills'), 'a bar cannot show the open tables');
});

check('a bar with no Pay key is called out before it reaches a counter', async (cdp) => {
  await reset(cdp);
  const warned = await cdp.eval(
    `document.querySelector('.sp-surface[data-surface="topbar"]').click();
     return document.getElementById('sp-issues').textContent;`
  );
  // The top bar in the fixture has its open-bills key, so it is sound.
  assert.ok(
    !/open-tables/i.test(warned),
    'a sound top bar was reported as broken'
  );

  const nagged = await cdp.eval(
    `spEdit(() => { spCurrent.buttons = []; });
     return document.getElementById('sp-issues').textContent;`
  );
  assert.ok(/empty/i.test(nagged), 'an empty bar was reported as finished');
});

check('the card says what the tills are wearing', async (cdp) => {
  await reset(cdp);
  const drawn = await cdp.eval(
    `return [...document.querySelectorAll('#sp-till-preview [data-part]')]
       .map((el) => el.dataset.part + '=' + el.textContent).join('|');`
  );
  // Named where a name has been chosen, and the built-in described where one
  // has not — which is the question a manager was opening this page to answer.
  assert.strictEqual(
    drawn,
    'topbar=Open tables|sale=OnzepTest|bottombar=Counter bar'
  );
});

check('choosing a default sends it straight away', async (cdp) => {
  await reset(cdp);
  const sent = await cdp.eval(
    `const el = document.getElementById('sp-def-top');
     el.value = '8';
     el.dispatchEvent(new Event('change'));
     return new Promise((go) => setTimeout(() => go(spDefaults.top), 250));`
  );
  assert.strictEqual(sent, 8, 'the top bar was never set');
});

// The bug the taller page exposed: `grid.focus()` ran before the geometry was
// measured, so the focus scroll moved the grid between the pointer's
// coordinates being taken and the box being read — and the first press after
// landing on the page selected a key rows away from the one under the finger.
check('a press lands on the key under it even when the page must scroll', async (cdp) => {
  await reset(cdp);
  // Bottom of the page, so the top of the grid is above the viewport and the
  // browser has somewhere to scroll to if anything asks it to.
  const before = await cdp.eval(
    `window.scrollTo(0, document.documentElement.scrollHeight);
     document.getElementById('sp-grid').blur();
     return Math.round(window.scrollY);`
  );

  const at = await cdp.cell(3, 0);
  await cdp.click(at.x, at.y);

  const after = await cdp.eval(
    `return { y: Math.round(window.scrollY), sel: [...spSelection].join(',') };`
  );
  assert.strictEqual(
    after.y,
    before,
    'the press scrolled the page, which is what moved the grid under it'
  );
  assert.strictEqual(after.sel, '3:0', 'the press selected the wrong key');
});

check('nothing on the page threw while all that happened', async (cdp) => {
  assert.strictEqual(cdp.thrown.length, 0, cdp.thrown.join(' ; '));
});

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
