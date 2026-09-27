/**
 * The dashboard's cards, arranged in an actual browser (2026-09-24):
 * "be able to move widgets around on the dashboard, so customers can choose
 * what they see first."
 *
 * Customise, arrows, drag by the handle, half/full width, hide and put back,
 * Reset -- and each change is saved for the person (PUT /dashboard/layout),
 * and a saved layout is what the page opens with next time.
 *
 * Headless Chrome against a stub API; SKIPPED when there is no Chromium.
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');

const WebSocket = require('ws');
const { launch, sleep } = require('./lib/chrome');
const { cleanLayout } = require('../src/dashboard_layout');

const PUBLIC = path.join(__dirname, '..', 'public');

function startStub() {
  const state = { layout: null, puts: 0 };
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const send = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/e2e-boot') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(
        '<!doctype html><meta charset="utf-8"><script>' +
          "localStorage.setItem('vesopa_token', 'stub-token');" +
          "localStorage.removeItem('vesopa_dashboard_layout_v1');" +
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
        const json = body ? JSON.parse(body) : {};
        if (url.pathname === '/api/dashboard/layout' && req.method === 'GET') return send(200, { layout: state.layout });
        if (url.pathname === '/api/dashboard/layout' && req.method === 'PUT') {
          state.layout = cleanLayout(json.layout);
          state.puts += 1;
          return send(200, { ok: true, layout: state.layout });
        }
        if (url.pathname === '/api/live') return send(200, { recent: [] });
        return send(200, req.method === 'GET' ? {} : { ok: true });
      });
    }
    const file = url.pathname === '/' || !path.extname(url.pathname) ? path.join(PUBLIC, 'index.html') : path.join(PUBLIC, url.pathname);
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file)) {
      res.writeHead(404);
      return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    return res.end(fs.readFileSync(file));
  });
  const wss = new WebSocket.Server({ server, path: '/ws' });
  wss.on('connection', (s) => s.on('message', () => {}));
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, wss, state })));
}

const order = `return [...document.querySelectorAll('#dash-widgets .dash-widget')].filter((w) => !w.hidden).map((w) => w.dataset.widget);`;
const STANDARD = ['stats', 'takings', 'hourly', 'tenders', 'products', 'departments', 'weekday', 'liabilities', 'live'];

async function main() {
  console.log('Back office: dashboard cards, in a browser\n');

  // The server's check of a layout, which needs no browser.
  assert.deepStrictEqual(
    cleanLayout([{ key: 'takings', size: 'full' }, { key: 'takings' }, { key: 'bad key!' }, { key: 'live', hidden: 1, size: 'huge' }]),
    [{ key: 'takings', size: 'full', hidden: false }, { key: 'live', size: 'half', hidden: true }]
  );
  assert.strictEqual(cleanLayout('nope'), null);
  console.log('  ok  the server keeps only well-formed layouts');

  const { server, wss, state } = await startStub();
  const port = server.address().port;
  const b = await launch(`http://127.0.0.1:${port}/e2e-boot`);
  if (!b) {
    console.log('  -- skipped: no Chrome or Edge on this machine\n\n1 check run');
    wss.close();
    server.close();
    return;
  }
  const { cdp } = b;
  let passed = 1;
  const check = async (name, fn) => {
    try {
      await fn();
      passed++;
      console.log(`  ok  ${name}`);
    } catch (e) {
      console.log(`FAIL  ${name}\n      ${e.message}`);
      process.exitCode = 1;
    }
  };

  // A reload that is really finished: the old page's marker gone, the new
  // one's layout applied.
  const reload = async () => {
    await cdp.eval('window.__oldPage = true; return true;');
    await cdp.send('Page.reload');
    await cdp.until(`return !window.__oldPage && typeof dwLoaded !== 'undefined' && dwLoaded;`, { tries: 100, every: 200 });
  };

  try {
    const ready = await cdp.until(`return typeof dwLayout !== 'undefined' && Array.isArray(dwLayout) && dwLayout.length > 0;`, { tries: 100, every: 200 });
    assert.ok(ready, `the dashboard never laid out${cdp.thrown.length ? ` — ${cdp.thrown.join(' ; ')}` : ''}`);

    await check('it opens in the standard order, with no edit controls', async () => {
      assert.deepStrictEqual(await cdp.eval(order), STANDARD);
      assert.strictEqual(await cdp.eval(`return document.querySelectorAll('.dash-widget-bar').length;`), 0);
    });

    await check('Customise shows a bar on every card, and the arrows move one', async () => {
      await cdp.clickOn('#dash-customise');
      assert.strictEqual(await cdp.eval(`return document.querySelectorAll('.dash-widget-bar').length;`), 9);
      await cdp.clickOn('.dash-widget[data-widget="products"] [data-dw-move="-1"]');
      await cdp.clickOn('.dash-widget[data-widget="products"] [data-dw-move="-1"]');
      await cdp.clickOn('.dash-widget[data-widget="products"] [data-dw-move="-1"]');
      const now = await cdp.eval(order);
      assert.deepStrictEqual(now.slice(0, 3), ['stats', 'products', 'takings']);
      await sleep(200);
      assert.ok(state.puts >= 3, 'the moves were not saved');
      assert.deepStrictEqual(state.layout.slice(0, 2).map((x) => x.key), ['stats', 'products']);
    });

    await check('a card is dragged by its handle to where it is dropped', async () => {
      await cdp.eval('window.scrollTo(0, 0); return true;');
      const at = await cdp.eval(
        `const h = document.querySelector('.dash-widget[data-widget="products"] [data-dw-drag]').getBoundingClientRect();
         const t = document.querySelector('.dash-widget[data-widget="stats"]').getBoundingClientRect();
         return { hx: h.left + h.width / 2, hy: h.top + h.height / 2, tx: t.left + 40, ty: t.top + 6 };`
      );
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.hx, y: at.hy, button: 'left', buttons: 1, clickCount: 1 });
      for (const f of [0.3, 0.7, 1]) {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.hx + (at.tx - at.hx) * f, y: at.hy + (at.ty - at.hy) * f, button: 'left', buttons: 1 });
      }
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.tx, y: at.ty, button: 'left', buttons: 0, clickCount: 1 });
      await sleep(200);
      assert.deepStrictEqual((await cdp.eval(order)).slice(0, 2), ['products', 'stats']);
      assert.deepStrictEqual(state.layout.slice(0, 2).map((x) => x.key), ['products', 'stats']);
    });

    await check('half or full width, and hide then put back', async () => {
      await cdp.clickOn('.dash-widget[data-widget="hourly"] [data-dw-size]');
      assert.strictEqual(await cdp.eval(`return document.querySelector('.dash-widget[data-widget="hourly"]').dataset.size;`), 'full');
      await cdp.clickOn('.dash-widget[data-widget="liabilities"] [data-dw-hide]');
      assert.ok(!(await cdp.eval(order)).includes('liabilities'));
      assert.strictEqual(await cdp.eval(`return !document.getElementById('dash-hidden-tray').hidden && document.querySelector('[data-dw-show="liabilities"]').textContent.trim();`), '+ Held liabilities');
      await sleep(150);
      assert.strictEqual(state.layout.find((x) => x.key === 'liabilities').hidden, true);
      await cdp.clickOn('[data-dw-show="liabilities"]');
      assert.ok((await cdp.eval(order)).includes('liabilities'));
    });

    await check('Done hides the controls and keeps the layout; a reload opens with it', async () => {
      await cdp.clickOn('.dash-widget[data-widget="weekday"] [data-dw-hide]');
      await cdp.clickOn('#dash-done');
      assert.strictEqual(await cdp.eval(`return document.querySelectorAll('.dash-widget-bar').length;`), 0);
      const before = await cdp.eval(order);
      await reload();
      assert.deepStrictEqual(await cdp.eval(order), before);
      assert.ok(!before.includes('weekday'));
      assert.strictEqual(await cdp.eval(`return document.querySelector('.dash-widget[data-widget="hourly"]').dataset.size;`), 'full');
    });

    await check('Reset puts the standard layout back', async () => {
      await cdp.clickOn('#dash-customise');
      await cdp.clickOn('#dash-reset');
      assert.deepStrictEqual(await cdp.eval(order), STANDARD);
      assert.strictEqual(await cdp.eval(`return document.querySelector('.dash-widget[data-widget="hourly"]').dataset.size;`), 'half');
      await cdp.clickOn('#dash-done');
    });

    await check('a saved layout that names a card no longer there, or misses a new one, still opens', async () => {
      state.layout = [{ key: 'gone', size: 'full', hidden: false }, { key: 'live', size: 'full', hidden: false }];
      await reload();
      const now = await cdp.eval(order);
      assert.strictEqual(now[0], 'live');
      assert.strictEqual(now.length, 9);
    });

    if (process.env.SHOT) {
      fs.mkdirSync(process.env.SHOT, { recursive: true });
      await cdp.clickOn('#dash-customise');
      await sleep(300);
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(process.env.SHOT, 'dashboard.png'), Buffer.from(shot.data, 'base64'));
    }

    await check('nothing on the page threw', async () => {
      assert.strictEqual(cdp.thrown.length, 0, cdp.thrown.join(' ; '));
    });
  } finally {
    await b.close();
    wss.close();
    server.close();
  }
  console.log(`\n${passed} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
