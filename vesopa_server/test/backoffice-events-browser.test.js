/**
 * Back office: the Events & tickets page, in a browser.
 *
 * Against a stub API, like the Memberships page test: what is checked is that
 * the page draws what the server says and sends what the server expects --
 * the server's own rules are tested against a real database in
 * events.test.js.
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const { launch, sleep } = require('./lib/chrome');

const PUBLIC = path.join(__dirname, '..', 'public');

const MATCH = {
  id: 4, title: 'Pontardawe v Penlan', description: null, kind: 'match', starts_at: '2027-10-17T14:30', ends_at: null,
  location: 'The Ynys', image_url: null, on_sale: true, published: true, wru_fixture_id: 568140,
  sold: 3, checked_in: 1, orders: 1, revenue_minor: 1600,
  ticket_types: [
    { id: 11, name: 'Adult', price_minor: 800, capacity: 300, max_per_order: 6, sort: 0, sold: 2, checked_in: 1, remaining: 298 },
    { id: 12, name: 'Junior', price_minor: 0, capacity: null, max_per_order: 6, sort: 1, sold: 1, checked_in: 0, remaining: null },
  ],
};
const ORDERS = {
  event: MATCH,
  orders: [{
    id: 9, public_id: 'a'.repeat(32), name: 'Ann Lee', email: 'ann@example.com', phone: null, total_minor: 1600,
    status: 'paid', source: 'online', issued_by: null, created_at: '2026-10-11T10:00', items: [],
    tickets: [
      { code: 'K7MP2QXR9D', type: 'Adult', holder: 'Ann Lee', checked_in_at: '2027-10-17T14:02', checked_in_by: 'Dai' },
      { code: 'K7MP2QXR9E', type: 'Adult', holder: 'Ann Lee', checked_in_at: null, checked_in_by: null },
    ],
  }],
  totals: { orders: 1, tickets: 3, checked_in: 1, revenue_minor: 1600, online_minor: 1600, by_type: [] },
};

function startStub() {
  const state = { posts: [] };
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
          "id: 1, name: 'Club Manager', role: 'office', officeId: 35," +
          "officeName: 'Pontardawe RFC', email: 'club@example.com', officeEmail: 'club@example.com'}));" +
          "location.replace('/events');" +
          '</script>'
      );
    }
    if (url.pathname.startsWith('/api/')) {
      let body = '';
      req.on('data', (c) => (body += c));
      return req.on('end', () => {
        const json = body ? JSON.parse(body) : {};
        const p = url.pathname;
        if (req.method !== 'GET') state.posts.push({ method: req.method, path: p, body: json });
        if (p === '/api/modules') return send(200, [{ key: 'events', label: 'Events & tickets', allowed: true, enabled: true, on: true }]);
        if (p === '/api/events' && req.method === 'GET') return send(200, url.searchParams.get('when') === 'past' ? [] : [MATCH]);
        if (p === '/api/events' && req.method === 'POST') return send(201, { ...MATCH, id: 5, title: json.title });
        if (/^\/api\/events\/\d+\/orders$/.test(p)) return send(200, ORDERS);
        if (p === '/api/events/import-wru') return send(200, { fixtures: 3, created: 2, updated: 1 });
        if (p === '/api/events/checkin') {
          if (json.code === 'K7MP2QXR9E') {
            return send(200, { ok: true, ticket: { code: json.code, event_title: MATCH.title, starts_at: MATCH.starts_at, type: 'Adult', holder: 'Ann Lee' } });
          }
          if (json.code === 'K7MP2QXR9D') {
            return send(200, { ok: false, already: true, checked_in_at: '2027-10-17T14:02', message: 'Already scanned at 14:02',
              ticket: { code: json.code, event_title: MATCH.title, starts_at: MATCH.starts_at, type: 'Adult', holder: 'Ann Lee' } });
          }
          return send(404, { ok: false, message: 'Not a valid ticket' });
        }
        if (p === '/api/live') return send(200, { recent: [] });
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

async function main() {
  console.log('Back office: Events & tickets, in a browser\n');
  const { server, wss, state } = await startStub();
  const port = server.address().port;
  const b = await launch(`http://127.0.0.1:${port}/e2e-boot`);
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

  try {
    const ready = await cdp.until(`return document.querySelectorAll('#ev-list [data-ev-open]').length > 0;`, { tries: 100, every: 200 });
    assert.ok(ready, `the events list never drew${cdp.thrown.length ? ` — ${cdp.thrown.join(' ; ')}` : ''}`);

    await check('the page lists events with what they sell and what was taken', async () => {
      const text = await cdp.eval(`return document.getElementById('ev-list').textContent;`);
      assert.ok(/Pontardawe v Penlan/.test(text) && /Adult £8\.00 \(298 left\)/.test(text) && /£16\.00/.test(text), text);
      assert.strictEqual(await cdp.eval(`return document.querySelector('.nav[data-view="events"]').hidden;`), false);
    });

    await check('opening an event shows its tickets and who has come in', async () => {
      await cdp.clickOn('[data-ev-open="4"]');
      await cdp.until(`return !!document.querySelector('[data-ev-modal]');`, { tries: 30, every: 100 });
      const text = await cdp.eval(`return document.querySelector('[data-ev-modal]').textContent;`);
      assert.ok(/K7MP2QXR9D/.test(text) && /In 14:02/.test(text) && /Through the gate/.test(text) && /568140/.test(text), text);
    });

    await check('checking a ticket in from the sales list posts its code', async () => {
      await cdp.clickOn('[data-ev-checkin="K7MP2QXR9E"]');
      await sleep(300);
      assert.ok(state.posts.some((x) => x.path === '/api/events/checkin' && x.body.code === 'K7MP2QXR9E'), JSON.stringify(state.posts));
      await cdp.clickOn('#ev-close');
    });

    await check('the gate box says in, already, or not a ticket', async () => {
      const gate = async (code) => {
        await cdp.eval(`document.getElementById('ev-gate-code').value = ${JSON.stringify(code)};
          document.getElementById('ev-gate-form').requestSubmit(); return true;`);
        await sleep(300);
        return cdp.eval(`const el = document.getElementById('ev-gate-result'); return el.className + ' | ' + el.textContent;`);
      };
      assert.match(await gate('K7MP2QXR9E'), /ok \| In: Adult/);
      assert.match(await gate('K7MP2QXR9D'), /bad \| Already scanned at 14:02/);
      assert.match(await gate('NOPE'), /bad \| Not a valid ticket/);
    });

    await check('a new event saves its first ticket in pence', async () => {
      await cdp.clickOn('#ev-add');
      await cdp.until(`return !!document.querySelector('#modal-form [name="title"]');`, { tries: 30, every: 100 });
      await cdp.eval(`const f = document.querySelector('#modal-form');
        f.querySelector('[name="title"]').value = 'Quiz night';
        f.querySelector('[name="starts_at"]').value = '2027-11-05T19:30';
        f.querySelector('[name="t_price"]').value = '5';
        f.requestSubmit(); return true;`);
      await sleep(400);
      const post = state.posts.find((x) => x.path === '/api/events' && x.method === 'POST');
      assert.ok(post, JSON.stringify(state.posts));
      assert.strictEqual(post.body.title, 'Quiz night');
      assert.strictEqual(post.body.starts_at, '2027-11-05T19:30');
      assert.deepStrictEqual(post.body.ticket_types, [{ name: 'Adult', price_minor: 500, capacity: null }]);
      await cdp.eval(`document.getElementById('modal-root').innerHTML = ''; return true;`);
    });

    await check('the WRU import says what it brought in', async () => {
      await cdp.clickOn('#ev-import');
      await sleep(400);
      assert.ok(state.posts.some((x) => x.path === '/api/events/import-wru'));
      const toast = await cdp.eval(`return document.body.textContent;`);
      assert.ok(/2 new matches, 1 updated/.test(toast), 'no toast');
    });

    await check('no script errors', async () => {
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
