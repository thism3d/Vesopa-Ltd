/**
 * Headless Chrome (or Edge) over the DevTools protocol, for the back-office
 * browser tests: the same launcher and thin client the screen editor's test
 * grew, lifted out so a second page's test does not copy two hundred lines.
 *
 *   const { launch } = require('./lib/chrome');
 *   const b = await launch(`http://127.0.0.1:${port}/e2e-boot`);
 *   if (!b) return skip();            // no Chromium on this machine
 *   await b.cdp.eval('return document.title;');
 *   await b.close();
 */

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const WebSocket = require('ws');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChromium() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/opt/pw-browsers/chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  return candidates.find((p) => {
    try {
      return fs.existsSync(p) && fs.statSync(p).isFile();
    } catch {
      return false;
    }
  });
}

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
        this.thrown.push(d.exception?.description || d.text || 'exception with no detail');
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

  /** Evaluate a function body in the page (it may `return` and `await`). */
  async eval(body) {
    const res = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${body} })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'page threw');
    }
    return res.result.value;
  }

  /** Wait until a page expression is truthy; its last value otherwise. */
  async until(body, { tries = 60, every = 150 } = {}) {
    let v;
    for (let i = 0; i < tries; i++) {
      v = await this.eval(body).catch(() => null);
      if (v) return v;
      await sleep(every);
    }
    return v;
  }

  async click(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  }

  /** Click the middle of the first element matching a selector. */
  async clickOn(selector) {
    const at = await this.eval(
      `const el = document.querySelector(${JSON.stringify(selector)});
       if (!el) return null;
       el.scrollIntoView({ block: 'center' });
       const r = el.getBoundingClientRect();
       return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };`
    );
    if (!at) throw new Error(`nothing matches ${selector}`);
    await this.click(at.x, at.y);
  }

  async type(text) {
    await this.send('Input.insertText', { text });
  }

  async key(key, code = key, keyCode = 0) {
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode });
  }
}

/**
 * Start a headless browser on `url` and attach to its page. Resolves to null
 * when there is no Chromium on the machine, so a caller can skip.
 */
async function launch(url, { width = 1500, height = 1000 } = {}) {
  const chromium = findChromium();
  if (!chromium) return null;
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
      '--no-sandbox',
      `--window-size=${width},${height}`,
      url,
    ],
    { stdio: 'ignore' }
  );
  const close = async () => {
    try { browser.kill(); } catch { /* gone already */ }
    await sleep(300);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* Windows may hold it a moment */ }
  };
  try {
    const portFile = path.join(profile, 'DevToolsActivePort');
    let devPort = null;
    for (let i = 0; i < 100 && !devPort; i++) {
      await sleep(200);
      if (fs.existsSync(portFile)) devPort = Number(fs.readFileSync(portFile, 'utf8').split('\n')[0]);
    }
    if (!devPort) throw new Error('the browser never reported a debugging port');
    let target = null;
    for (let i = 0; i < 50 && !target; i++) {
      await sleep(200);
      const targets = await getJson(`http://127.0.0.1:${devPort}/json/list`);
      target = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    }
    if (!target) throw new Error('no page target to attach to');
    const socket = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    const cdp = new Cdp(socket);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    return {
      cdp,
      close: async () => {
        try { socket.close(); } catch { /* closed */ }
        await close();
      },
    };
  } catch (e) {
    await close();
    throw e;
  }
}

module.exports = { launch, findChromium, sleep, Cdp };
