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
    venueFont: null,
    fonts: [
      {
        slug: 'inter',
        family: 'Inter',
        builtIn: true,
        faces: [{ weight: 400, url: '/assets/fonts/inter/inter-400.ttf', bytes: 1 }],
      },
      {
        slug: 'bebas-neue',
        family: 'Bebas Neue',
        builtIn: true,
        faces: [
          { weight: 400, url: '/assets/fonts/bebas-neue/bebas-neue-400.ttf', bytes: 1 },
        ],
      },
      {
        slug: 'brand-sans',
        family: 'Brand Sans',
        builtIn: false,
        faces: [{ weight: 400, url: '/uploads/fonts/brand-sans-400-abc.ttf', bytes: 1 }],
      },
    ],
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
        if (url.pathname === '/api/till-settings' && req.method === 'GET') {
          return send(200, {
            home_screen_id: 1,
            top_bar_screen_id: null,
            bottom_bar_screen_id: 7,
            font_family: state.venueFont,
          });
        }
        if (url.pathname === '/api/till-settings' && req.method === 'PUT') {
          if (json.font_family !== undefined) {
            state.venueFont = json.font_family || null;
          }
          return send(200, { ok: true });
        }
        // Two built-ins and one the venue uploaded, which is enough shape for
        // the picker: a group heading for each, and a slug that is not a
        // built-in so "your fonts come first" can be checked.
        if (url.pathname === '/api/fonts' && req.method === 'GET') {
          return send(200, { fonts: state.fonts });
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

  /**
   * Two presses at the same point, the second carrying clickCount 2.
   *
   * The whole gesture, not a shortcut to the `dblclick` event: the editor
   * relies on the *first* press having already selected the key, so a
   * synthesised dblclick with no presses behind it would pass a check that a
   * manager's mouse would fail.
   */
  async doubleClick(x, y) {
    await this.click(x, y);
    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 2,
    });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 2,
    });
  }

  /** The middle of the resize handle, wherever it currently is. */
  handle() {
    return this.eval(
      `const el = document.querySelector('#sp-grid .sp-handle');
       if (!el) return null;
       const r = el.getBoundingClientRect();
       return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };`
    );
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

  const { server, wss, state } = await startStub();
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
        // `state` and `port` for the checks that have to look at what the
        // server was actually sent, or drive the page to a second URL.
        await fn(cdp, state, port);
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

      // And the panel with a key selected, which is where everything that
      // styles a key lives — the swatches, the wheel, the font, the size — and
      // where a card that has grown too tall for the column shows up. The
      // three shots above all have nothing selected, so the inspector is empty
      // in every one of them.
      await cdp.eval(
        `document.querySelector('.sp-surface[data-surface="sale"]').click();
         spSelection = new Set(['0:0']);
         spFocusCell = { row: 0, col: 0 };
         spPaintSelection();
         spRenderInspector();
         document.getElementById('sp-inspector').scrollIntoView({ block: 'center' });
         return true;`
      );
      await sleep(250);
      const inspector = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const file = path.join(process.env.SHOT, 'editor-inspector.png');
      fs.writeFileSync(file, Buffer.from(inspector.data, 'base64'));
      console.log(`  -- wrote ${file}`);
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
    // The press counter, which is what turns a second press on the same key
    // into "open the search". Two checks in a row that both press 3:4 are two
    // checks, not a double-click — a person would have had a page reload in
    // between, and this is that reload.
    spLastPress = null;
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

// ---------------------------------------------------------------------------
// Double-click to search
// ---------------------------------------------------------------------------

check('double-clicking a key opens the search on that key', async (cdp) => {
  await reset(cdp);
  const at = await cdp.cell(3, 4);
  await cdp.doubleClick(at.x, at.y);

  const open = await cdp.eval(
    `return {
       box: !!document.querySelector('.sp-palette'),
       focused: document.activeElement === document.querySelector('.sp-palette-q'),
       sel: [...spSelection].join(','),
     };`
  );
  assert.ok(open.box, 'the search never opened');
  assert.ok(open.focused, 'the search opened without the caret in it');
  // The press that precedes the double-click is what selects, so by the time
  // the palette opens it is already pointed at the key that was hit. That is
  // the whole gesture: if this drifts, a manager double-clicks one key and
  // programmes another.
  assert.strictEqual(open.sel, '3:4', 'the search opened on the wrong key');

  await cdp.eval(
    `document.querySelector('.sp-palette-q')
       .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
     return true;`
  );
});

check('searching and pressing Enter puts that product on the key', async (cdp) => {
  await reset(cdp);
  const at = await cdp.cell(3, 4);
  await cdp.doubleClick(at.x, at.y);

  // "Product 42" is in the stub catalogue at PLU 141.
  const result = await cdp.eval(
    `const q = document.querySelector('.sp-palette-q');
     q.value = 'Product 42';
     q.dispatchEvent(new Event('input'));
     q.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
     const b = spAt(3, 4);
     return { kind: b && b.kind, plu: b && b.pluId, closed: !document.querySelector('.sp-palette') };`
  );
  assert.strictEqual(result.kind, 'product');
  assert.strictEqual(result.plu, 141, 'the wrong product was placed');
  assert.ok(result.closed, 'the search stayed open after placing');
});

check('the search offers screens and functions, not only products', async (cdp) => {
  await reset(cdp);
  const groups = await cdp.eval(
    `return [...new Set(spPaletteEntries().map((e) => e.group))].sort().join(',');`
  );
  assert.strictEqual(groups, 'Function,Navigation,Product');
});

// ---------------------------------------------------------------------------
// The corner handle
// ---------------------------------------------------------------------------

check('the handle appears on one selected key and on no others', async (cdp) => {
  await reset(cdp);
  const at = await cdp.cell(3, 4);
  await cdp.click(at.x, at.y);
  assert.strictEqual(
    await cdp.eval(`return document.querySelectorAll('#sp-grid .sp-handle').length;`),
    1
  );

  // Two keys selected is a bulk edit, and "resize all of them into each other"
  // is not a gesture anybody wants — so there is nothing to grab.
  const from = await cdp.cell(0, 3);
  const to = await cdp.cell(3, 4);
  await cdp.mouseDrag(from, to);
  assert.strictEqual(
    await cdp.eval(`return document.querySelectorAll('#sp-grid .sp-handle').length;`),
    0,
    'a multi-selection offered a handle'
  );
});

// ---------------------------------------------------------------------------
// Resizing a key that is not a key yet
// ---------------------------------------------------------------------------
//
// "The resizing of buttons is great — can we have this on the empty buttons
// too? We usually resize the buttons and then add products and functionality
// later." A handle that appears only once a key already has a product on it
// makes that order of work impossible, and that order is how a screen actually
// gets laid out.

check('an empty cell offers a handle too', async (cdp) => {
  await reset(cdp);
  const at = await cdp.cell(2, 2);
  await cdp.click(at.x, at.y);
  const state = await cdp.eval(
    `return {
       handles: document.querySelectorAll('#sp-grid .sp-handle').length,
       button: !!spAt(2, 2),
     };`
  );
  assert.strictEqual(state.button, false, '2:2 was not empty to begin with');
  assert.strictEqual(state.handles, 1, 'an empty cell offered no handle');
});

check('dragging an empty cell sets a space aside', async (cdp) => {
  await reset(cdp);
  const at = await cdp.cell(2, 2);
  await cdp.click(at.x, at.y);

  const handle = await cdp.handle();
  assert.ok(handle, 'no handle on the empty cell');
  await cdp.mouseDrag(handle, await cdp.cell(3, 3));

  const held = await cdp.eval(
    `const b = spAt(2, 2);
     const cell = document.querySelector('#sp-grid .sp-cell[data-row="2"][data-col="2"]');
     return {
       kind: b && b.kind,
       r: b && b.rowSpan,
       c: b && b.colSpan,
       // Drawn as a reservation, not as a programmed key: a manager must be
       // able to see at a glance which spaces are still to be filled in.
       reserved: !!cell && cell.classList.contains('reserved'),
       filled: !!cell && cell.classList.contains('filled'),
       dirty: spDirty(),
     };`
  );
  assert.deepStrictEqual(
    { kind: held.kind, r: held.r, c: held.c },
    { kind: 'blank', r: 2, c: 2 },
    'the empty cell did not take the size it was dragged to'
  );
  assert.ok(held.reserved, 'the space was not drawn as a reservation');
  assert.ok(!held.filled, 'the space was drawn as a programmed key');
  assert.ok(held.dirty, 'setting a space aside was not counted as a change');
});

check('a space set aside keeps its size when it is given a product', async (cdp) => {
  await reset(cdp);
  await cdp.click(...Object.values(await cdp.cell(2, 2)));
  await cdp.mouseDrag(await cdp.handle(), await cdp.cell(3, 3));

  // The whole point of the feature: size first, product second.
  const filled = await cdp.eval(
    `spApplyToSelection((b) => { spSetKind(b, 'product'); b.pluId = 100; });
     spRenderGrid();
     const b = spAt(2, 2);
     return { kind: b.kind, plu: b.pluId, r: b.rowSpan, c: b.colSpan };`
  );
  assert.deepStrictEqual(filled, { kind: 'product', plu: 100, r: 2, c: 2 });
});

check('a space dragged back to one cell stops existing', async (cdp) => {
  await reset(cdp);
  await cdp.click(...Object.values(await cdp.cell(2, 2)));
  await cdp.mouseDrag(await cdp.handle(), await cdp.cell(3, 3));
  await cdp.mouseDrag(await cdp.handle(), await cdp.cell(2, 2));

  // A 1x1 blank is what an empty cell already is. Storing one would be a row
  // that draws nothing and blocks the cell it sits on.
  assert.strictEqual(
    await cdp.eval(`return !!spAt(2, 2);`),
    false,
    'a 1x1 reservation was left behind'
  );
});

check('one drag of an empty cell is one press of undo', async (cdp) => {
  await reset(cdp);
  await cdp.click(...Object.values(await cdp.cell(2, 2)));
  await cdp.mouseDrag(await cdp.handle(), await cdp.cell(3, 3));

  const back = await cdp.eval(
    `const held = !!spAt(2, 2);
     spUndo();
     return { held, afterOneUndo: !!spAt(2, 2), dirty: spDirty() };`
  );
  assert.ok(back.held, 'nothing was set aside to undo');
  assert.strictEqual(
    back.afterOneUndo,
    false,
    'one drag cost more than one press of undo'
  );
  assert.ok(!back.dirty, 'the undo did not put the layout back as it was');
});

check('clearing a key takes its space with it', async (cdp) => {
  await reset(cdp);
  // The 2x2 in the corner. Backspace has always meant "this cell is empty
  // again", and it still does — a reservation is made by a deliberate drag of
  // the handle, not by pressing Backspace on a key that happened to be big.
  const at = await cdp.cell(0, 0);
  await cdp.click(at.x, at.y);
  const gone = await cdp.eval(
    `spApplyToSelection(spClearButton, { create: false });
     return { left: !!spAt(0, 0), at01: !!spAt(0, 1) };`
  );
  assert.strictEqual(gone.left, false, 'a reservation was left where the key was');
});

check('dragging the handle grows the key, snapped to the grid', async (cdp) => {
  await reset(cdp);
  // 2:2 and everything around it is empty — the 2x2 in the corner covers
  // 0:0–1:1, and the only other keys are at 0:3 and 3:4 — so there is room to
  // grow into without meeting anything.
  const at = await cdp.cell(2, 2);
  await cdp.click(at.x, at.y);
  await cdp.eval(
    `spApplyToSelection((b) => { spSetKind(b, 'function'); b.functionKey = 'note'; });
     spRenderGrid();
     return true;`
  );

  const handle = await cdp.handle();
  assert.ok(handle, 'no handle to drag');
  const target = await cdp.cell(3, 3);
  await cdp.mouseDrag(handle, target);

  const grown = await cdp.eval(
    `const b = spAt(2, 2);
     return { r: b.rowSpan, c: b.colSpan };`
  );
  assert.deepStrictEqual(
    grown,
    { r: 2, c: 2 },
    'the handle did not grow the key to the cell it was dropped on'
  );
});

check('the handle stops rather than swallowing the key next to it', async (cdp) => {
  await reset(cdp);
  // 0:3 has a key. 0:2 is empty and sits directly to its left, so a key put at
  // 0:2 and dragged right has one cell of room and then a neighbour.
  await cdp.eval(
    `spSelection = new Set(['0:2']);
     spApplyToSelection((b) => { spSetKind(b, 'function'); b.functionKey = 'note'; });
     spRenderGrid();
     return true;`
  );
  const handle = await cdp.handle();
  const target = await cdp.cell(0, 4);
  await cdp.mouseDrag(handle, target);

  const after = await cdp.eval(
    `return {
       span: spAt(0, 2).colSpan,
       neighbour: !!spAt(0, 3),
     };`
  );
  assert.strictEqual(after.span, 1, 'the key grew over its neighbour');
  // The important half. spTidy() drops a button whose own cell is covered, so
  // a resize that did not refuse would have deleted this one — silently, on an
  // overshoot of one cell, with nothing on screen to say what had gone.
  assert.ok(after.neighbour, 'the neighbouring key was swallowed');
});

check('one drag of the handle is one press of undo', async (cdp) => {
  await reset(cdp);
  await cdp.eval(
    `spSelection = new Set(['2:2']);
     spApplyToSelection((b) => { spSetKind(b, 'function'); b.functionKey = 'note'; });
     spRenderGrid();
     spUndoStack = [];
     return true;`
  );
  const handle = await cdp.handle();
  const target = await cdp.cell(3, 3);
  await cdp.mouseDrag(handle, target);

  const steps = await cdp.eval(`return spUndoStack.length;`);
  assert.strictEqual(steps, 1, `a drag left ${steps} undo steps behind`);

  const back = await cdp.eval(
    `spUndo();
     const b = spAt(2, 2);
     return b.rowSpan + 'x' + b.colSpan;`
  );
  assert.strictEqual(back, '1x1', 'undo did not put the key back');
});

// A key had one size and two places to set it: the corner handle and a pair of
// number boxes in the inspector. They disagreed the moment either was touched,
// and the typed one had to re-implement every rule the drag already enforced --
// clamping to the grid, refusing to swallow a neighbour, holding a reservation
// on an empty cell. The boxes are gone; the handle is the answer.
check('there is one way to size a key, and it is the handle', async (cdp) => {
  await reset(cdp);
  const boxes = await cdp.eval(
    `return {
       width: !!document.getElementById('sp-colspan'),
       height: !!document.getElementById('sp-rowspan'),
       handle: !!document.querySelector('#sp-grid'),
     };`
  );
  assert.strictEqual(boxes.width, false, 'the Width box came back');
  assert.strictEqual(boxes.height, false, 'the Height box came back');
  assert.ok(boxes.handle, 'the grid itself is still there');
});

// ---------------------------------------------------------------------------
// Colour and lettering
// ---------------------------------------------------------------------------

check('the wheel puts an arbitrary colour on the key', async (cdp) => {
  await reset(cdp);
  const at = await cdp.cell(3, 4);
  await cdp.click(at.x, at.y);
  const fill = await cdp.eval(
    `const wheel = document.getElementById('sp-fill-wheel');
     wheel.value = '#7f3ac1';
     wheel.dispatchEvent(new Event('change'));
     return spAt(3, 4).fill;`
  );
  assert.strictEqual(fill, '#7f3ac1');
});

check('a hex typed without its hash is still a colour', async (cdp) => {
  await reset(cdp);
  const at = await cdp.cell(3, 4);
  await cdp.click(at.x, at.y);
  const fill = await cdp.eval(
    `const box = document.getElementById('sp-fill-hex');
     box.value = 'A5C715';
     box.dispatchEvent(new Event('change'));
     return spAt(3, 4).fill;`
  );
  assert.strictEqual(fill, '#a5c715', 'a brand book hex was refused');
});

check('one sweep of the wheel is one undo step', async (cdp) => {
  await reset(cdp);
  const at = await cdp.cell(3, 4);
  await cdp.click(at.x, at.y);
  const steps = await cdp.eval(
    `spUndoStack = [];
     const wheel = document.getElementById('sp-fill-wheel');
     // What a colour input does while a pointer moves inside the picker. None
     // of it may reach the undo stack, or taking one colour back costs two
     // hundred presses of Ctrl+Z.
     for (const c of ['#111111', '#222222', '#333333', '#444444']) {
       wheel.value = c;
       wheel.dispatchEvent(new Event('input'));
     }
     wheel.dispatchEvent(new Event('change'));
     return spUndoStack.length;`
  );
  assert.strictEqual(steps, 1, `a colour sweep left ${steps} undo steps`);
});

check('the venue’s own fonts are offered above the built-in ones', async (cdp) => {
  await reset(cdp);
  const picker = await cdp.eval(
    `return [...document.getElementById('sp-till-font').children]
       .map((el) => el.tagName === 'OPTGROUP' ? el.label : 'none').join('|');`
  );
  assert.strictEqual(picker, 'none|Your fonts|Built in');
});

check('a key can be lettered in a font and a size of its own', async (cdp) => {
  await reset(cdp);
  const at = await cdp.cell(3, 4);
  await cdp.click(at.x, at.y);
  const set = await cdp.eval(
    `const font = document.getElementById('sp-font');
     font.value = 'bebas-neue';
     font.dispatchEvent(new Event('change'));
     const size = document.getElementById('sp-font-size');
     size.value = '26';
     size.dispatchEvent(new Event('change'));
     const b = spAt(3, 4);
     return { family: b.fontFamily, size: b.fontSize };`
  );
  assert.deepStrictEqual(set, { family: 'bebas-neue', size: 26 });
});

check('lettering a key is a change the editor knows it has', async (cdp) => {
  await reset(cdp);
  const at = await cdp.cell(3, 4);
  await cdp.click(at.x, at.y);
  const state = await cdp.eval(
    `spUndoStack = [];
     const font = document.getElementById('sp-font');
     font.value = 'inter';
     font.dispatchEvent(new Event('change'));
     const afterFont = { dirty: spDirty(), steps: spUndoStack.length };
     const size = document.getElementById('sp-font-size');
     size.value = '20';
     size.dispatchEvent(new Event('change'));
     return { afterFont, steps: spUndoStack.length };`
  );
  // spShape() is what spDirty() compares and what spEdit() uses to decide
  // whether anything happened. A field missing from it means changing that
  // field is not a change: no undo step, no warning before leaving, and the
  // edit dropped without a word by the next screen switch.
  assert.ok(state.afterFont.dirty, 'a font change did not mark the layout unsaved');
  assert.strictEqual(state.afterFont.steps, 1, 'a font change left no undo step');
  assert.strictEqual(state.steps, 2, 'a size change left no undo step');

  const back = await cdp.eval(
    `spUndo(); spUndo();
     const b = spAt(3, 4);
     return { family: b.fontFamily ?? null, size: b.fontSize ?? null };`
  );
  assert.deepStrictEqual(back, { family: null, size: null }, 'undo did not take it back');
});

check('an empty size means the till decides, not nought', async (cdp) => {
  await reset(cdp);
  const at = await cdp.cell(3, 4);
  await cdp.click(at.x, at.y);
  const cleared = await cdp.eval(
    `const size = document.getElementById('sp-font-size');
     size.value = '26';
     size.dispatchEvent(new Event('change'));
     size.value = '';
     size.dispatchEvent(new Event('change'));
     return spAt(3, 4).fontSize;`
  );
  assert.strictEqual(cleared, null, 'clearing the box set a size of nought');
});

check('the font and the size travel to the server on save', async (cdp, state) => {
  await reset(cdp);
  const at = await cdp.cell(3, 4);
  await cdp.click(at.x, at.y);
  await cdp.eval(
    `const font = document.getElementById('sp-font');
     font.value = 'brand-sans';
     font.dispatchEvent(new Event('change'));
     const size = document.getElementById('sp-font-size');
     size.value = '18';
     size.dispatchEvent(new Event('change'));
     return spSaveLayout({ quiet: true });`
  );
  const sent = (state.saved || []).find((b) => b.row === 3 && b.col === 4);
  assert.ok(sent, 'the key was not in what was saved');
  assert.strictEqual(sent.fontFamily, 'brand-sans');
  assert.strictEqual(sent.fontSize, 18);
});

check('choosing the venue font saves it on its own, not with the layout', async (cdp, state) => {
  await reset(cdp);
  await cdp.eval(
    `const el = document.getElementById('sp-till-font');
     el.value = 'inter';
     el.dispatchEvent(new Event('change'));
     return new Promise((go) => setTimeout(() => go(true), 250));`
  );
  assert.strictEqual(
    state.venueFont,
    'inter',
    'the venue font never reached the settings row'
  );
});

// ---------------------------------------------------------------------------
// The window of its own
// ---------------------------------------------------------------------------

check('the pop-out fits the grid without the page scrolling', async (cdp, state, port) => {
  await cdp.send('Page.navigate', {
    url: `http://127.0.0.1:${port}/screen-programming?popup=1`,
  });
  // Loaded, laid out, and the layout fetched.
  for (let i = 0; i < 60; i++) {
    await sleep(200);
    const ready = await cdp.eval(
      `return !!(document.body.classList.contains('sp-popup') &&
                 document.querySelector('#sp-grid .sp-cell'));`
    );
    if (ready) break;
  }

  const fit = await cdp.eval(
    `const doc = document.documentElement;
     const grid = document.getElementById('sp-grid');
     const box = grid.getBoundingClientRect();
     return {
       popup: document.body.classList.contains('sp-popup'),
       overflowY: doc.scrollHeight - doc.clientHeight,
       overflowX: doc.scrollWidth - doc.clientWidth,
       bottom: Math.round(box.bottom),
       viewport: doc.clientHeight,
       ratio: box.width / box.height,
     };`
  );

  assert.ok(fit.popup, 'the popup chrome never applied');
  // The whole reason this window exists. A grid whose bottom row is under the
  // fold is one a manager scrolls to reach — in the window that was opened to
  // stop them scrolling.
  assert.ok(
    fit.overflowY <= 1,
    `the page still scrolls by ${fit.overflowY}px in the pop-out`
  );
  assert.ok(
    fit.overflowX <= 1,
    `the page scrolls sideways by ${fit.overflowX}px in the pop-out`
  );
  assert.ok(
    fit.bottom <= fit.viewport + 1,
    `the bottom of the grid is ${Math.round(fit.bottom - fit.viewport)}px past the window`
  );
  // And it is still the shape of a till, which is the point of arranging keys
  // on it at all. Generous tolerance: the grid rounds to whole pixels.
  assert.ok(
    Math.abs(fit.ratio - 16 / 9) < 0.06,
    `the grid came out at ${fit.ratio.toFixed(3)}, not 16:9`
  );

  // And a bar, which is the surface that fits differently: a bar's rows are a
  // fixed height, so the leftover has to go to the ghosts of the sale screen
  // rather than into the keys. At 120px fixed those ghosts were what pushed an
  // eleven-key bar off the bottom of a short window.
  await cdp.eval(
    `document.querySelector('.sp-surface[data-surface="bottombar"]').click();
     return true;`
  );
  await sleep(300);
  const bar = await cdp.eval(
    `const doc = document.documentElement;
     const stage = document.getElementById('sp-stage');
     return {
       framed: stage.classList.contains('framed'),
       overflowY: doc.scrollHeight - doc.clientHeight,
       bottom: Math.round(stage.getBoundingClientRect().bottom),
       viewport: doc.clientHeight,
     };`
  );
  assert.ok(bar.framed, 'the bar surface did not draw its frame');
  assert.ok(
    bar.overflowY <= 1,
    `a bar in the pop-out still scrolls by ${bar.overflowY}px`
  );
  assert.ok(
    bar.bottom <= bar.viewport + 1,
    `the bar's stage runs ${Math.round(bar.bottom - bar.viewport)}px past the window`
  );

  // Back to the ordinary page for anything that runs after this.
  await cdp.send('Page.navigate', {
    url: `http://127.0.0.1:${port}/screen-programming`,
  });
  for (let i = 0; i < 60; i++) {
    await sleep(200);
    const ready = await cdp.eval(
      `return !!document.querySelector('#sp-grid .sp-cell');`
    );
    if (ready) break;
  }
});

// ---------------------------------------------------------------------------
// The picture on a key, and how it is framed
// ---------------------------------------------------------------------------
//
// "Is there any way to zoom in and out on images to make them fit tidy? … As we
// can set the buttons dynamically we are placing however we want … different
// size buttons might be, so think of a creative way to add that image to the
// buttons to look better."
//
// The answer is four numbers that say how to *look* at the file rather than a
// second upload: fit, zoom, and a shift in each direction. Everything below is
// about those four agreeing between the editor's preview and the till.

check('a key with a picture is a picture, not a picture and a word', async (cdp) => {
  await reset(cdp);
  const shown = await cdp.eval(
    `spSelection = new Set(['2:2']);
     spApplyToSelection((b) => {
       spSetKind(b, 'product');
       b.pluId = 100;
       b.imageUrl = '/uploads/burger.png';
     });
     spRenderGrid();
     const cell = document.querySelector('#sp-grid .sp-cell[data-row="2"][data-col="2"]');
     return {
       // The picture fills the key rather than sitting above the words.
       fills: !!cell.querySelector('.sp-face-fill img'),
       words: [...cell.querySelectorAll('span')]
         .map((s) => s.textContent)
         .join('')
         .trim(),
     };`
  );
  assert.ok(shown.fills, 'the picture was not drawn as the key');
  assert.strictEqual(
    shown.words,
    '',
    `the name was lettered over the picture anyway: "${shown.words}"`
  );
});

check('and the tick puts the name back on that one key', async (cdp) => {
  const shown = await cdp.eval(
    `spApplyToSelection((b) => { b.showLabel = true; }, { create: false });
     spRenderGrid();
     const cell = document.querySelector('#sp-grid .sp-cell[data-row="2"][data-col="2"]');
     const over = cell.querySelector('.sp-over-art');
     return {
       words: over && over.textContent.trim(),
       // Over the picture, with something behind it: white lettering on a
       // photograph that happens to be pale is a key nobody can read.
       scrimmed: !!over,
       stillFills: !!cell.querySelector('.sp-face-fill img'),
     };`
  );
  assert.strictEqual(shown.words, 'Product 1');
  assert.ok(shown.scrimmed, 'the name was lettered straight onto the picture');
  assert.ok(shown.stillFills, 'the picture stopped filling the key');
});

check('the framing stage is drawn at the key’s own shape', async (cdp) => {
  await reset(cdp);
  // A 1x1 against a 1x3 strip. Not a 1x1 against a 2x2: the grid's cells are
  // all one shape, so a 2x2 is the same shape as a 1x1 and comparing them
  // would pass whatever the stage did.
  //
  // If the stage were a fixed square, "does this picture work *here*" could not
  // be answered from it — and that question, on a venue that arranges keys in
  // whatever sizes suit it, is the whole reason it exists.
  const shapes = await cdp.eval(
    `spSelection = new Set(['2:0']);
     spApplyToSelection((b) => {
       spSetKind(b, 'product');
       b.pluId = 100;
       b.colSpan = 3;
     });
     const ratios = {};
     for (const [name, key] of [['wide', '2:0'], ['small', '0:3']]) {
       spSelection = new Set([key]);
       spApplyToSelection((b) => { b.imageUrl = '/uploads/burger.png'; });
       spRenderGrid();
       spRenderInspector();
       const stage = document.getElementById('sp-frame-stage');
       ratios[name] = {
         shown: !document.getElementById('sp-frame').hidden,
         raw: stage.style.aspectRatio,
         width: Math.round(stage.getBoundingClientRect().width),
         height: Math.round(stage.getBoundingClientRect().height),
       };
     }
     return ratios;`
  );
  assert.ok(shapes.wide.shown, 'the stage was not offered on a key with a picture');
  assert.ok(shapes.small.shown, 'the stage was not offered on the small key');
  // Chrome normalises `aspect-ratio: 1.42` to the string "1.42 / 1", so this
  // is parseFloat rather than Number — which answers NaN for it.
  const ratio = (r) => parseFloat(r.raw);
  assert.ok(
    ratio(shapes.wide) > ratio(shapes.small) * 2,
    `the 1x3 strip and the 1x1 got the same stage shape (${JSON.stringify(shapes)})`
  );
});

check('the stage is not offered on a key with no picture', async (cdp) => {
  await reset(cdp);
  const hidden = await cdp.eval(
    `spSelection = new Set(['3:4']);
     spRenderInspector();
     return document.getElementById('sp-frame').hidden;`
  );
  assert.strictEqual(hidden, true);
});

check('dragging the stage moves the picture by what the pointer moved', async (cdp) => {
  await reset(cdp);
  await cdp.eval(
    `spSelection = new Set(['0:0']);
     spApplyToSelection((b) => { b.imageUrl = '/uploads/burger.png'; }, { create: false });
     spRenderGrid();
     spRenderInspector();
     return true;`
  );

  const stage = await cdp.eval(
    `const el = document.getElementById('sp-frame-stage');
     el.scrollIntoView({ block: 'center' });
     const r = el.getBoundingClientRect();
     return {
       x: Math.round(r.left + r.width / 2),
       y: Math.round(r.top + r.height / 2),
       w: Math.round(r.width),
       h: Math.round(r.height),
     };`
  );
  assert.ok(stage.w > 20, 'the stage has no size to drag across');

  // A quarter of the stage to the right. The offsets are a percentage of the
  // key, so that is +25 — the picture travels exactly as far as the pointer.
  await cdp.mouseDrag(
    { x: stage.x, y: stage.y },
    { x: stage.x + Math.round(stage.w / 4), y: stage.y }
  );

  const moved = await cdp.eval(`const b = spAt(0, 0); return { x: b.imageX, y: b.imageY };`);
  assert.ok(
    Math.abs(moved.x - 25) <= 6,
    `the picture moved by ${moved.x}% for a pointer that moved 25%`
  );
  assert.ok(Math.abs(moved.y) <= 3, `it drifted ${moved.y}% vertically`);
});

check('one drag of the stage is one press of undo', async (cdp) => {
  const back = await cdp.eval(
    `// The settle timer is what turns a hundred pointer events into one step.
     spFrameSettleNow();
     const moved = spAt(0, 0).imageX;
     spUndo();
     return { moved, afterOneUndo: spAt(0, 0).imageX };`
  );
  assert.ok(back.moved !== 0, 'nothing was moved to undo');
  assert.ok(
    back.afterOneUndo == null,
    `one drag cost more than one press of undo (left ${back.afterOneUndo})`
  );
});

check('zoom and fit reach the grid, and Reset takes them off', async (cdp) => {
  await reset(cdp);
  const framed = await cdp.eval(
    `spSelection = new Set(['0:0']);
     spApplyToSelection((b) => { b.imageUrl = '/uploads/burger.png'; }, { create: false });
     spRenderGrid();
     spRenderInspector();

     const zoom = document.getElementById('sp-frame-zoom');
     zoom.value = '220';
     zoom.dispatchEvent(new Event('input', { bubbles: true }));
     document.getElementById('sp-frame-whole').click();
     spFrameSettleNow();

     const img = document
       .querySelector('#sp-grid .sp-cell[data-row="0"][data-col="0"] .sp-face-fill img');
     return {
       scale: spAt(0, 0).imageScale,
       fit: spAt(0, 0).imageFit,
       // The preview has to move with it, or the manager is setting numbers
       // blind and the editor is lying about what a clerk will see.
       drawnFit: img.style.objectFit,
       drawnTransform: img.style.transform,
     };`
  );
  assert.strictEqual(framed.scale, 220);
  assert.strictEqual(framed.fit, 'contain');
  assert.strictEqual(framed.drawnFit, 'contain');
  assert.ok(
    framed.drawnTransform.includes('scale(2.2)'),
    `the preview drew "${framed.drawnTransform}"`
  );

  const reset2 = await cdp.eval(
    `document.getElementById('sp-frame-reset').click();
     spFrameSettleNow();
     const b = spAt(0, 0);
     return { scale: b.imageScale, fit: b.imageFit, x: b.imageX, y: b.imageY };`
  );
  assert.deepStrictEqual(reset2, { scale: null, fit: null, x: null, y: null });
});

check('the framing travels to the server on save', async (cdp, state) => {
  await reset(cdp);
  await cdp.eval(
    `spSelection = new Set(['0:3']);
     spApplyToSelection((b) => {
       b.imageUrl = '/uploads/burger.png';
       b.imageFit = 'contain';
       b.imageScale = 175;
       b.imageX = -20;
       b.imageY = 12;
       b.showLabel = true;
     }, { create: false });
     return spSaveLayout({ quiet: true });`
  );
  const sent = (state.saved || []).find((b) => b.row === 0 && b.col === 3);
  assert.ok(sent, 'the key was not in what was saved');
  assert.strictEqual(sent.imageFit, 'contain');
  assert.strictEqual(sent.imageScale, 175);
  assert.strictEqual(sent.imageX, -20);
  assert.strictEqual(sent.imageY, 12);
  assert.strictEqual(sent.showLabel, true);
});

check('framing a key is a change the editor knows it has', async (cdp) => {
  await reset(cdp);
  // The trap this is for: spShape() is what decides whether there is unsaved
  // work, and a field left out of it means changing that field is not a
  // change — no undo step, no warning, and the edit thrown away without a word
  // by the next screen switch.
  const noticed = await cdp.eval(
    `spSelection = new Set(['0:0']);
     spApplyToSelection((b) => { b.imageUrl = '/uploads/burger.png'; }, { create: false });
     spSavedShape = spShape(spCurrent);
     const before = spDirty();
     spApplyToSelection((b) => { b.imageScale = 180; }, { create: false });
     const afterZoom = spDirty();
     spSavedShape = spShape(spCurrent);
     spApplyToSelection((b) => { b.showLabel = true; }, { create: false });
     return { before, afterZoom, afterTick: spDirty() };`
  );
  assert.strictEqual(noticed.before, false);
  assert.ok(noticed.afterZoom, 'zooming a picture was not counted as a change');
  assert.ok(noticed.afterTick, 'showing the name was not counted as a change');
});

// ---------------------------------------------------------------------------
// The key no layout can delete
// ---------------------------------------------------------------------------

check('a top bar is laid out beside the till’s own fixed key', async (cdp) => {
  await reset(cdp);
  const onSale = await cdp.eval(
    `return {
       nav: !document.getElementById('sp-fixed-nav').hidden,
       stage: document.getElementById('sp-stage').classList.contains('with-nav'),
     };`
  );
  assert.strictEqual(onSale.nav, false, 'a sale screen was given the fixed key');

  await cdp.eval(
    `document.querySelector('.sp-surface[data-surface="topbar"]').click();
     return true;`
  );
  await sleep(300);
  const onTop = await cdp.eval(
    `const nav = document.getElementById('sp-fixed-nav');
     const grid = document.getElementById('sp-grid');
     return {
       shown: !nav.hidden,
       // Beside the grid, not over it: it takes width from the bar rather than
       // one of its columns, so a bar laid out before it existed still has
       // every key it had.
       leftOfGrid:
         nav.getBoundingClientRect().right <= grid.getBoundingClientRect().left + 1,
     };`
  );
  assert.ok(onTop.shown, 'the top bar was not shown the fixed key');
  assert.ok(onTop.leftOfGrid, 'the fixed key was not drawn to the left of the bar');

  // And a bottom bar is not: the page selector lives on the one strip that is
  // on every screen, which is the top one.
  await cdp.eval(
    `document.querySelector('.sp-surface[data-surface="bottombar"]').click();
     return true;`
  );
  await sleep(300);
  assert.strictEqual(
    await cdp.eval(`return document.getElementById('sp-fixed-nav').hidden;`),
    true,
    'a bottom bar was given the page selector'
  );

  await cdp.eval(
    `document.querySelector('.sp-surface[data-surface="sale"]').click();
     return true;`
  );
  await sleep(300);
});

check('nothing on the page threw while all that happened', async (cdp) => {
  assert.strictEqual(cdp.thrown.length, 0, cdp.thrown.join(' ; '));
});

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
