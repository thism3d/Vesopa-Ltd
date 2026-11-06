/**
 * Back office: Virtual Printers, in a real browser against a stub API.
 *
 * The flows a manager follows: an empty page that says what to do, creating a
 * printer, going straight on to adding it to a phone, changing it, removing it,
 * and finding a document.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const { launch, sleep } = require('./lib/chrome');

const PUBLIC = path.join(__dirname, '..', 'public');
const SHOT = process.env.VP_SHOT;

const drive = (over) => ({
  id: 4, name: 'Office', terminal_id: 0, online_only: true, terminal: null, online: false, printer_id: '', printer_name: null,
  enabled: true, phones: false, waiting: 0, saved: 2, failed: 1, today: 3, total: 5, bytes: 3 * 1024 * 1024,
  last_job_at: new Date().toISOString(), created_at: new Date().toISOString(), link: `/print/${'a'.repeat(32)}`, ...over,
});
const JOBS = [
  { id: 'j1', drive_id: 4, drive_name: 'Office', online_only: true, filename: 'Rota.pdf', mime: 'application/pdf', size: 2048, status: 'saved', error: null, sent_by: 'Phone, over the internet', created_at: new Date().toISOString() },
  { id: 'j2', drive_id: 7, drive_name: 'Bar', online_only: false, filename: 'Menu.pdf', mime: 'application/pdf', size: 4096, status: 'failed', error: 'Out of paper', sent_by: 'Web link', created_at: new Date().toISOString() },
];

function startStub() {
  const state = { calls: [], drives: [], jobs: [] };
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
          "localStorage.setItem('vesopa_user', JSON.stringify({" +
          "id: 1, name: 'Manager', role: 'office', officeId: 9," +
          "officeName: 'Test venue', email: 'm@example.com', officeEmail: 'm@example.com'}));" +
          "location.replace('/virtual-printers');" +
          '</script>'
      );
    }
    if (url.pathname.startsWith('/api/')) {
      let body = '';
      req.on('data', (c) => (body += c));
      return req.on('end', () => {
        const json = body ? JSON.parse(body) : {};
        const p = url.pathname;
        if (req.method !== 'GET') state.calls.push({ method: req.method, path: p, body: json });
        if (p === '/api/print-drives/activity') return send(200, { jobs: state.jobs });
        if (p === '/api/print-drives' && req.method === 'GET') {
          return send(200, { drives: state.drives, connectors: [{ id: 3, name: 'Bar till', printers: [{ id: 'p1', name: 'Epson' }] }, { id: 5, name: 'Lounge', printers: [] }] });
        }
        if (p === '/api/print-drives' && req.method === 'POST') {
          state.drives.push(drive({ name: json.name }));
          return send(201, { id: 4, link: state.drives[0].link });
        }
        if (/^\/api\/print-drives\/\d+$/.test(p) && req.method === 'PUT') {
          Object.assign(state.drives[0], json);
          return send(200, { ok: true });
        }
        if (/^\/api\/print-drives\/\d+$/.test(p) && req.method === 'DELETE') {
          state.drives = [];
          return send(200, { ok: true });
        }
        if (p === '/api/print-drives/profile-link') return send(200, { url: 'https://x.example/print-profile/t' });
        if (p === '/api/qr.svg') {
          state.qr = url.searchParams.get('text');
          res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
          return res.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>');
        }
        if (p === '/api/modules') return send(200, []);
        return send(200, req.method === 'GET' ? {} : { ok: true });
      });
    }
    const file = !path.extname(url.pathname) ? path.join(PUBLIC, 'index.html') : path.join(PUBLIC, url.pathname);
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

async function main() {
  console.log('Back office: Virtual Printers, in a browser\n');
  const { server, wss, state } = await startStub();
  const b = await launch(`http://127.0.0.1:${server.address().port}/e2e-boot`);
  if (!b) {
    console.log('  -- skipped: no Chrome or Edge on this machine\n\n0 checks run');
    wss.close();
    server.close();
    return;
  }
  const { cdp } = b;
  let passed = 0;
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
  const text = (sel) => cdp.eval(`const e = document.querySelector(${JSON.stringify(sel)}); return e ? e.textContent : '';`);
  const shown = (sel) => cdp.until(`return !!document.querySelector(${JSON.stringify(sel)});`, { tries: 40, every: 100 });
  const refresh = () => cdp.eval(`return loadPrintDrives().then(() => true);`);

  try {
    assert.ok(await shown('.vp-empty'), `the page never drew${cdp.thrown.length ? ` — ${cdp.thrown.join(' ; ')}` : ''}`);

    await check('the rail has Virtual Printers, on a page of its own', async () => {
      assert.strictEqual(await text('.nav.active'), 'Virtual Printers');
    });

    await check('an empty page says what to do and offers the button', async () => {
      assert.match(await text('.vp-empty'), /No virtual printers yet/);
      assert.ok(await cdp.eval(`return !!document.querySelector('.vp-empty [data-vp-new]');`));
    });

    await check('creating one asks only a name and where documents go', async () => {
      await cdp.clickOn('.vp-empty [data-vp-new]');
      assert.ok(await shown('#vp-new-form'));
      assert.match(await text('.vp-where'), /Keep them online/);
      assert.strictEqual(await cdp.eval(`return document.querySelector('.vp-paper').hidden;`), true);
      await cdp.eval(`document.querySelector('[name="vp-where"][value="paper"]').click(); return true;`);
      assert.strictEqual(await cdp.eval(`return document.querySelector('.vp-paper').hidden;`), false);
      assert.strictEqual(await cdp.eval(`return document.querySelector('#vp-till').options.length;`), 1, 'a till with no printer is not offered');
      assert.strictEqual(await cdp.eval(`return document.querySelector('#vp-printer').value;`), 'p1');
      await cdp.eval(`document.querySelector('[name="vp-where"][value="online"]').click();
        document.querySelector('#vp-name').value = 'Office';
        document.querySelector('#vp-new-form').requestSubmit(); return true;`);
      assert.ok(await shown('.vp-setup'));
      assert.deepStrictEqual(state.calls.find((c) => c.path === '/api/print-drives').body, { name: 'Office', terminal_id: 0 });
    });

    await check('it goes straight on to adding it to a phone, with a code to scan', async () => {
      await sleep(300); // the New dialog is still fading out
      assert.match(await text('.vp-modal h3'), /Office is ready/);
      assert.match(await text('#vp-steps'), /Profile Downloaded/);
      await sleep(300);
      assert.match(state.qr, /\/print\/a{32}\/airprint\.mobileconfig$/);
      assert.ok(await cdp.eval(`return !!document.querySelector('#vp-qr svg');`));
    });

    await check('each kind of device has its own steps', async () => {
      await cdp.clickOn('[data-tab="android"]');
      await sleep(200);
      assert.match(await text('#vp-steps'), /Install app/);
      assert.match(state.qr, /\/print\/a{32}$/);
      await cdp.clickOn('[data-tab="go"]');
      await sleep(100);
      assert.match(await text('#vp-steps'), /Add this venue's printers/);
      assert.strictEqual(await cdp.eval(`return document.querySelector('#vp-qr').hidden;`), true);
      await cdp.clickOn('.vp-modal [data-vp-close]');
      await sleep(300);
    });

    state.jobs = JOBS;
    await refresh();

    await check('the dashboard adds up and each printer says how it is', async () => {
      const stats = (await text('#vp-stats')).replace(/\s+/g, '');
      assert.match(stats, /Printers1/);
      assert.match(stats, /Documentstoday3/);
      assert.match(stats, /Saved2/);
      assert.match(stats, /Failedthisweek1/);
      assert.match(stats, /Spaceused3\.0MB/);
      assert.match(await text('.vp-card'), /Online only, no paper/);
      assert.match(await text('.vp-card .pill'), /Ready/);
    });

    if (SHOT) {
      fs.writeFileSync(path.join(SHOT, 'vp-dashboard.png'), Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    }

    await check('documents can be searched and filtered', async () => {
      assert.strictEqual(await cdp.eval(`return document.querySelectorAll('#vp-jobs tbody tr').length;`), 2);
      await cdp.eval(`const f = document.querySelector('#vp-filter-status'); f.value = 'failed'; f.dispatchEvent(new Event('change', { bubbles: true })); return true;`);
      assert.match(await text('#vp-jobs tbody'), /Menu\.pdf/);
      assert.strictEqual(await cdp.eval(`return document.querySelectorAll('#vp-jobs tbody tr').length;`), 1);
      await cdp.eval(`const f = document.querySelector('#vp-filter-status'); f.value = ''; f.dispatchEvent(new Event('change', { bubbles: true }));
        const s = document.querySelector('#vp-find'); s.value = 'rota'; s.dispatchEvent(new Event('input', { bubbles: true })); return true;`);
      assert.match(await text('#vp-jobs tbody'), /Rota\.pdf/);
      assert.strictEqual(await cdp.eval(`return document.querySelectorAll('#vp-jobs tbody tr').length;`), 1);
      await cdp.eval(`const s = document.querySelector('#vp-find'); s.value = ''; s.dispatchEvent(new Event('input', { bubbles: true })); return true;`);
    });

    await check('a document with a paper printer can go to paper, one without cannot', async () => {
      assert.ok(await cdp.eval(`return !!document.querySelector('[data-vp-again="j2"]');`));
      assert.ok(!(await cdp.eval(`return !!document.querySelector('[data-vp-again="j1"]');`)));
    });

    await check('settings rename and pause it, and only send what changed', async () => {
      await cdp.clickOn('[data-vp-settings="4"]');
      assert.ok(await shown('#vp-settings-form'));
      assert.strictEqual(await cdp.eval(`return document.querySelector('#vp-phones').disabled;`), true);
      await cdp.eval(`document.querySelector('#vp-name').value = 'Back office';
        document.querySelector('#vp-enabled').checked = false;
        document.querySelector('#vp-settings-form').requestSubmit(); return true;`);
      await sleep(400);
      assert.deepStrictEqual(state.calls.filter((c) => c.method === 'PUT').pop().body, { name: 'Back office', enabled: false });
      await sleep(300);
      assert.match(await text('.vp-card .pill'), /Paused/);
    });

    await check('moving it to paper sends the till and printer', async () => {
      await cdp.clickOn('[data-vp-settings="4"]');
      assert.ok(await shown('#vp-settings-form'));
      await cdp.eval(`document.querySelector('[name="vp-where"][value="paper"]').click();
        document.querySelector('#vp-settings-form').requestSubmit(); return true;`);
      await sleep(400);
      const body = state.calls.filter((c) => c.method === 'PUT').pop().body;
      assert.strictEqual(body.terminal_id, 3);
      assert.strictEqual(body.printer_id, 'p1');
      await sleep(300);
    });

    await check('removing it asks first', async () => {
      await cdp.clickOn('[data-vp-settings="4"]');
      assert.ok(await shown('[data-vp-remove]'));
      await cdp.clickOn('[data-vp-remove]');
      assert.ok(await shown('.confirm-modal [data-yes]'));
      assert.ok(!state.calls.some((c) => c.method === 'DELETE'));
      await cdp.clickOn('.confirm-modal [data-yes]');
      await sleep(500);
      assert.ok(state.calls.some((c) => c.method === 'DELETE' && c.path === '/api/print-drives/4'));
      assert.ok(await shown('.vp-empty'));
    });

    await check('nothing went wrong in the page', async () => {
      assert.deepStrictEqual(cdp.thrown, []);
    });
  } finally {
    await b.close();
    wss.close();
    server.close();
  }
  console.log(`\n${passed} checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
