/**
 * Back office: the Memberships page, in a browser.
 *
 * Against a stub API, like the dashboard test: what is checked is that the
 * page draws what the server says and sends what the server expects -- the
 * server's own rules are tested against a real database in
 * memberships.test.js.
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const { launch, sleep } = require('./lib/chrome');

const PUBLIC = path.join(__dirname, '..', 'public');

const PLAN = {
  id: 7, name: 'Gold', colour: '#a5c715', active: true, fee_minor: 3500, term_months: 1,
  joining_fee_minor: 1000, family_size: 3, freeze_days_per_year: 30, includes_gym: true,
  includes_classes: true, class_credits_per_month: null, sell_online: true, members: 1,
};
const ANN = {
  id: 'c-ann', name: 'Ann Lee', email: 'ann@example.com', member_no: 12, member_number: '00012',
  scheme_id: 7, membership_status: 'active', state: 'active', plan: PLAN, family_head_id: null,
  membership_expiry: '2026-12-01', joined_on: '2026-10-01', days_left: 58, renewal_reminders: 1,
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
          "id: 1, name: 'Gym Manager', role: 'office', officeId: 9," +
          "officeName: 'Iron Gym', email: 'iron@example.com', officeEmail: 'iron@example.com'}));" +
          "location.replace('/memberships');" +
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
        if (p === '/api/modules') return send(200, [{ key: 'memberships', label: 'Memberships', allowed: true, enabled: true, on: true }]);
        if (p === '/api/memberships/summary') {
          return send(200, { members: 1, active: 1, frozen: 0, expired: 0, pending: 0, cancelled: 0,
            expiring_soon: 0, joined_this_month: 1, paid_online_this_month_minor: 4500 });
        }
        if (p === '/api/memberships/plans') return send(200, [PLAN]);
        if (p === '/api/memberships/members' && req.method === 'GET') return send(200, [ANN]);
        if (p === '/api/memberships/members' && req.method === 'POST') return send(201, { ...ANN, id: 'c-new', name: 'New Person', family: [], history: [], bookings: [], freeze_days_used: 0 });
        if (p.startsWith('/api/memberships/members/')) {
          return send(200, { ...ANN, family: [{ id: 'c-ann', name: 'Ann Lee', state: 'active', payer: true }],
            history: [{ kind: 'join', created_at: '2026-10-01T10:00:00Z', expiry_after: '2026-11-01', amount_minor: 4500, via: 'till' }],
            bookings: [], freeze_days_used: 0 });
        }
        if (p === '/api/customers') return send(200, [{ id: 'c-bob', name: 'Bob', membership_status: '' }]);
        if (p === '/api/loyalty/schemes') return send(200, [{ id: 7, name: 'Gold', reward_type: 'none', active: 1 }]);
        if (p === '/api/classes') return send(200, { classes: [], timetable: [] });
        if (p === '/api/classes/sessions') return send(200, []);
        if (p === '/api/memberships/payments') return send(200, []);
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
  console.log('Back office: Memberships, in a browser\n');
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
    const ready = await cdp.until(`return document.querySelectorAll('#ms-members [data-ms-open]').length > 0;`, { tries: 100, every: 200 });
    assert.ok(ready, `the members list never drew${cdp.thrown.length ? ` — ${cdp.thrown.join(' ; ')}` : ''}`);

    await check('the page lists members with their plan and state', async () => {
      const text = await cdp.eval(`return document.getElementById('ms-members').textContent;`);
      assert.ok(/Ann Lee/.test(text) && /Gold/.test(text) && /Active/.test(text), text);
      const stats = await cdp.eval(`return document.getElementById('ms-stats').textContent;`);
      assert.ok(/£45\.00/.test(stats), stats);
      assert.strictEqual(await cdp.eval(`return document.querySelector('.nav[data-view="memberships"]').hidden;`), false);
    });

    await check('opening a member shows their dates, history and actions', async () => {
      await cdp.clickOn('[data-ms-open="c-ann"]');
      await cdp.until(`return !!document.querySelector('.ms-member');`, { tries: 30, every: 100 });
      const text = await cdp.eval(`return document.querySelector('.ms-member').textContent;`);
      assert.ok(/00012/.test(text) && /Renew/.test(text) && /Freeze/.test(text) && /Add family member/.test(text), text);
    });

    await check('renewing posts the plan price', async () => {
      await cdp.eval('window.confirm = () => true; return true;');
      await cdp.clickOn('[data-ms-act="renew"]');
      await sleep(300);
      const post = state.posts.find((x) => x.path === '/api/memberships/members/c-ann/renew');
      assert.ok(post, JSON.stringify(state.posts));
      assert.strictEqual(post.body.amount_minor, 3500);
      await cdp.clickOn('#ms-close');
    });

    await check('adding a new member sends the plan, the person and the joining fee', async () => {
      await cdp.clickOn('#ms-join');
      await cdp.until(`return !!document.querySelector('#modal-form [name="name"]');`, { tries: 30, every: 100 });
      await cdp.eval(`document.querySelector('#modal-form [name="name"]').value = 'New Person';
        document.querySelector('#modal-form [name="email"]').value = 'new@example.com';
        document.querySelector('#modal-form').requestSubmit(); return true;`);
      await sleep(400);
      const post = state.posts.find((x) => x.path === '/api/memberships/members' && x.method === 'POST');
      assert.ok(post, JSON.stringify(state.posts));
      assert.strictEqual(post.body.scheme_id, '7');
      assert.strictEqual(post.body.customer.name, 'New Person');
      assert.strictEqual(post.body.amount_minor, 4500);
      assert.strictEqual(post.body.status, 'active');
    });

    await check('a plan saves as a membership scheme', async () => {
      await cdp.eval(`document.getElementById('modal-root').innerHTML = ''; return true;`);
      await cdp.clickOn('[data-mstab="plans"]');
      await cdp.until(`return !!document.querySelector('[data-ms-plan-edit]');`, { tries: 30, every: 100 });
      await cdp.clickOn('#ms-plan-add');
      await cdp.until(`return !!document.querySelector('#modal-form [name="fee"]');`, { tries: 30, every: 100 });
      await cdp.eval(`const f = document.querySelector('#modal-form');
        f.querySelector('[name="name"]').value = 'Couples';
        f.querySelector('[name="fee"]').value = '55';
        f.querySelector('[name="family_size"]').value = '2';
        f.requestSubmit(); return true;`);
      await sleep(400);
      const post = state.posts.find((x) => x.path === '/api/loyalty/schemes' && x.method === 'POST');
      assert.ok(post, JSON.stringify(state.posts));
      assert.strictEqual(post.body.is_membership, 1);
      assert.strictEqual(post.body.membership_fee_minor, 5500);
      assert.strictEqual(String(post.body.family_size), '2');
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
