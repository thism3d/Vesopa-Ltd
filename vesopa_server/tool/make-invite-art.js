#!/usr/bin/env node
/**
 * Pictures for the Metric Group UK invitation email (2026-10-05).
 *
 *   node tool/make-invite-art.js <out-dir>
 *   python tool/invite/make_gif.py <out-dir>      # frames -> metric-hero.gif
 *
 * Renders, in headless Chromium (CHROME_PATH, as the browser tests):
 *
 *   frames/NN.png   one loop of tool/invite/metric-hero.html, the barrier
 *                   scene in the Metric Membership app's own style
 *   memberships.png the back office's Memberships page as Metric Group UK
 *                   sees it, from the real public/ files with a stub API (as
 *                   test/backoffice-memberships-browser.test.js), so the
 *                   picture is the page, not a drawing of it
 *
 * The finished pictures are kept in tool/invite/ so sending the email needs
 * nothing but the files; this is how to make them again.
 */
const fs = require('fs');
const http = require('http');
const path = require('path');
const { launch, sleep } = require('../test/lib/chrome');

const OUT = path.resolve(process.argv[2] || 'invite-art');
const PUBLIC = path.join(__dirname, '..', 'public');
const FRAMES = 48;

async function shoot(cdp, file, clip) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
}

async function hero() {
  const url = 'file://' + path.join(__dirname, 'invite', 'metric-hero.html');
  const b = await launch(url, { width: 1200, height: 560 });
  if (!b) throw new Error('no Chromium; set CHROME_PATH');
  try {
    await b.cdp.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 560, deviceScaleFactor: 1, mobile: false });
    await b.cdp.until('return window.ready && document.fonts.status === "loaded";', { tries: 80, every: 100 });
    await sleep(400);
    fs.mkdirSync(path.join(OUT, 'frames'), { recursive: true });
    for (let i = 0; i < FRAMES; i++) {
      await b.cdp.eval(`frame(${i / FRAMES}); return true;`);
      await shoot(b.cdp, path.join(OUT, 'frames', `${String(i).padStart(2, '0')}.png`), { x: 0, y: 0, width: 1200, height: 560 });
    }
  } finally {
    await b.close();
  }
}

const PLANS = [
  { id: 41, name: 'Standard', colour: '#0f8a6c', active: true, fee_minor: 0, term_months: 60, joining_fee_minor: 0,
    family_size: 1, freeze_days_per_year: 0, includes_gym: false, includes_classes: false, max_vehicles: 1, sell_online: false, members: 3 },
  { id: 42, name: 'Fleet', colour: '#0f8a6c', active: true, fee_minor: 0, term_months: 60, joining_fee_minor: 0,
    family_size: 1, freeze_days_per_year: 0, includes_gym: false, includes_classes: false, max_vehicles: 5, sell_online: false, members: 1 },
];
const person = (id, name, plan, no, state, expiry) => ({
  id, name, email: `${name.split(' ')[0].toLowerCase()}@example.co.uk`, member_no: no, member_number: String(no).padStart(5, '0'),
  scheme_id: plan.id, membership_status: state === 'pending' ? 'pending' : 'active', state, plan,
  family_head_id: null, membership_expiry: expiry, joined_on: '2026-10-05', days_left: 1820, renewal_reminders: 0,
});
const MEMBERS = [
  person('c-1', 'Alex Carter', PLANS[0], 1001, 'active', '2031-10-05'),
  person('c-2', 'Priya Shah', PLANS[0], 1002, 'active', '2031-10-05'),
  person('c-3', 'Tom Evans', PLANS[1], 1003, 'active', '2031-10-05'),
  person('c-4', 'Sophie Hughes', PLANS[0], 1004, 'pending', '2031-10-05'),
];

function stub() {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const send = (body) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/boot') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(
        '<!doctype html><meta charset="utf-8"><script>' +
          "localStorage.setItem('vesopa_token', 'stub-token');" +
          "localStorage.setItem('vesopa_user', JSON.stringify({id: 1, name: 'Matt Hammond', role: 'office', officeId: 9," +
          "officeName: 'Metric Group UK', email: 'm.hammond@metricgroup.co.uk', officeEmail: 'm.hammond@metricgroup.co.uk'}));" +
          "location.replace('/memberships');</script>");
    }
    if (url.pathname.startsWith('/api/')) {
      const p = url.pathname;
      if (p === '/api/modules') {
        return send([
          { key: 'memberships', label: 'Memberships', allowed: true, enabled: true, on: true },
          { key: 'vehicle_access', label: 'Vehicle access', allowed: true, enabled: true, on: true },
        ]);
      }
      if (p === '/api/memberships/summary') {
        return send({ members: 4, active: 3, frozen: 0, expired: 0, pending: 1, cancelled: 0, expiring_soon: 0, joined_this_month: 4, paid_online_this_month_minor: 0 });
      }
      if (p === '/api/memberships/plans') return send(PLANS);
      if (p === '/api/memberships/members') return send(MEMBERS);
      if (p === '/api/loyalty/schemes') return send(PLANS.map((x) => ({ id: x.id, name: x.name, reward_type: 'none', active: 1 })));
      if (p === '/api/classes') return send({ classes: [], timetable: [] });
      if (p === '/api/classes/sessions' || p === '/api/memberships/payments' || p === '/api/customers') return send([]);
      if (p === '/api/live') return send({ recent: [] });
      return send({});
    }
    const file = url.pathname === '/' || !path.extname(url.pathname) ? path.join(PUBLIC, 'index.html') : path.join(PUBLIC, url.pathname);
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file)) {
      res.writeHead(404);
      return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    return res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function backOffice() {
  const server = await stub();
  const b = await launch(`http://127.0.0.1:${server.address().port}/boot`, { width: 1440, height: 900 });
  try {
    await b.cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await b.cdp.until(`return document.querySelectorAll('#ms-members [data-ms-open]').length > 0;`, { tries: 100, every: 200 });
    await b.cdp.eval('document.fonts && await document.fonts.ready; return true;');
    await sleep(800);
    await shoot(b.cdp, path.join(OUT, 'memberships.png'), { x: 0, y: 0, width: 1440, height: 900 });
  } finally {
    await b.close();
    server.close();
  }
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  await hero();
  await backOffice();
  console.log(`pictures in ${OUT}`);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
