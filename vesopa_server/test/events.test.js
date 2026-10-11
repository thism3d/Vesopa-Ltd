/**
 * Events & tickets: the rules as pure functions, then the routes against a
 * real MySQL/MariaDB like memberships.test.js. The database half skips
 * cleanly when no database is reachable; the pure half always runs.
 *
 * THE RULES THAT MATTER
 *
 *   1. Nothing answers for a venue without the module on.
 *   2. A checkout is refused for a basket it cannot have: no tickets, too
 *      many, sold out, not on sale. Capacity counts paid tickets and recent
 *      pending orders.
 *   3. Dojo only ever sends the buyer back to the venue's own website.
 *   4. Tickets are issued once, when the intent says paid, however many times
 *      the return page is opened.
 *   5. A ticket gets in once. The second scan says when the first was; a
 *      ticket of an unpaid order, or another venue's, is not a ticket.
 *   6. The WRU import makes home matches only, and a second import updates
 *      rather than duplicates.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');

const SECRET = 'events-test-secret';
process.env.JWT_SECRET = SECRET;
process.env.EXPRESS_DOJO_API_KEY = 'sk_sandbox_' + 'test-only-not-a-key';
delete process.env.SMTP_HOST;

const { moduleRoutes, setAllowed } = require('../src/modules');
const ev = require('../src/events');

const DB = process.env.EVENTS_TEST_DB || 'vesopa_events_selftest';
const USER = process.env.EXPRESS_TEST_USER || process.env.DINEIN_TEST_USER || 'root';
const PASS = process.env.EXPRESS_TEST_PASS || process.env.DINEIN_TEST_PASS || '';
const HOST = process.env.EXPRESS_TEST_HOST || '127.0.0.1';

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${e.stack || e.message}`);
    process.exitCode = 1;
  }
}

// ---- Fakes: Dojo and the WRU ------------------------------------------------

const intents = {};
let nextIntent = 1;
const reply = (status, json) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: String(status),
  json: async () => json,
  text: async () => JSON.stringify(json),
});
const fixture = (id, date, home, away) => ({
  fixtureId: id,
  date,
  competitionName: 'WRU Men’s National League',
  homeTeam: { orgId: home[0], organisationName: home[1], childValue: '1st Team' },
  awayTeam: { orgId: away[0], organisationName: away[1], childValue: '1st Team' },
});
const PONT = [165, 'Pontardawe RFC'];
let wruPages = {
  1: { fixtures: [
    fixture(568140, '2027-10-17T14:30:00', PONT, [303, 'Penlan RFC']),
    fixture(568147, '2027-10-31T14:30:00', [119, 'Baglan RFC'], PONT),
  ], hasMore: true, pageNumber: 1 },
  2: { fixtures: [
    fixture(568149, '2027-11-21T14:30:00', PONT, [127, 'Cefn Cribbwr RFC']),
  ], hasMore: false, pageNumber: 2 },
};
const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  if (u.hostname === 'api.wru.wales') {
    assert.strictEqual(u.searchParams.get('organisationId'), '165');
    return reply(200, wruPages[Number(u.searchParams.get('page') || 1)] || { fixtures: [], hasMore: false });
  }
  if (u.hostname !== 'api.dojo.tech') return realFetch(url, opts);
  const method = opts.method || 'GET';
  const body = opts.body ? JSON.parse(opts.body) : null;
  let m;
  if (u.pathname === '/payment-intents' && method === 'POST') {
    const id = 'pi_sandbox_e' + nextIntent++;
    intents[id] = { status: 'Created', amount: body.amount.value, redirect: body.config && body.config.redirectUrl };
    return reply(200, { id, status: 'Created' });
  }
  if ((m = /^\/payment-intents\/([^/]+)$/.exec(u.pathname)) && method === 'GET') {
    return reply(200, { id: m[1], status: (intents[m[1]] || {}).status || 'Created' });
  }
  return reply(404, { title: 'Not faked: ' + method + ' ' + u.pathname });
};

// ---- Pure rules -------------------------------------------------------------

async function pure() {
  console.log('Events & tickets: rules');

  await check('codes are ten base32 characters and read back from a QR or a typed code', () => {
    const c = ev.newCode();
    assert.match(c, /^[A-HJ-NP-Z2-9]{10}$/);
    assert.strictEqual(ev.parseCode(`VT:${c}`), c);
    assert.strictEqual(ev.parseCode(` vt:${c.toLowerCase()} `), c);
    assert.strictEqual(ev.parseCode(c.slice(0, 5) + '-' + c.slice(5)), c);
    assert.strictEqual(ev.parseCode('VT:SHORT'), null);
    assert.strictEqual(ev.parseCode('ABCDEFGHI0'), null, '0 is never in a code');
    assert.strictEqual(ev.parseCode(''), null);
  });

  await check('return_url must be on one of the venue’s websites', () => {
    const origins = ['https://pontardawerfc.com', 'https://www.pontardawerfc.com'];
    assert.strictEqual(ev.returnUrlFor('https://pontardawerfc.com/tickets/order', origins, 'abc'),
      'https://pontardawerfc.com/tickets/order?order=abc');
    assert.strictEqual(ev.returnUrlFor('https://www.pontardawerfc.com/t?x=1#top', origins, 'abc'),
      'https://www.pontardawerfc.com/t?x=1&order=abc');
    for (const bad of [
      'https://pontardawerfc.com.evil.example/tickets',
      'https://user@pontardawerfc.com/tickets',
      'http://pontardawerfc.com/tickets',
      'https://evil.example/?https://pontardawerfc.com/',
      'javascript:alert(1)',
      '/tickets/order',
      '',
    ]) assert.strictEqual(ev.returnUrlFor(bad, origins, 'abc'), null, bad);
    assert.strictEqual(ev.returnUrlFor('https://pontardawerfc.com/', [], 'abc'), null, 'no websites, nowhere to go');
  });

  await check('a basket is priced, and refused when it cannot be had', () => {
    const types = [
      { id: 1, name: 'Adult', price_minor: 800, capacity: 10, max_per_order: 6 },
      { id: 2, name: 'Junior', price_minor: 0, capacity: null, max_per_order: 10 },
    ];
    const ok = ev.priceItems([{ ticket_type_id: 1, qty: 2 }, { ticket_type_id: 2, qty: 3 }], types, {});
    assert.strictEqual(ok.total, 1600);
    assert.deepStrictEqual(ok.lines.map((l) => [l.ticket_type_id, l.qty]), [[1, 2], [2, 3]]);
    const status = (fn) => { try { fn(); return 0; } catch (e) { return e.status; } };
    assert.strictEqual(status(() => ev.priceItems([], types, {})), 400);
    assert.strictEqual(status(() => ev.priceItems([{ ticket_type_id: 1, qty: 0 }], types, {})), 400);
    assert.strictEqual(status(() => ev.priceItems([{ ticket_type_id: 9, qty: 1 }], types, {})), 400);
    assert.strictEqual(status(() => ev.priceItems([{ ticket_type_id: 1, qty: 1.5 }], types, {})), 400);
    assert.strictEqual(status(() => ev.priceItems([{ ticket_type_id: 1, qty: 7 }], types, {})), 400, 'over max per order');
    assert.strictEqual(status(() => ev.priceItems([{ ticket_type_id: 1, qty: 3 }], types, { 1: 8 })), 409, 'only 2 left');
    assert.strictEqual(status(() => ev.priceItems([{ ticket_type_id: 1, qty: 1 }], types, { 1: 10 })), 409, 'sold out');
    assert.strictEqual(ev.priceItems([{ ticket_type_id: 2, qty: 10 }], types, { 2: 5000 }).total, 0, 'no limit');
  });

  await check('WRU fixtures become home matches only, titled after the club', () => {
    const shaped = ev.shapeFixtures([...wruPages[1].fixtures, ...wruPages[2].fixtures], 165, 'Pontardawe');
    assert.deepStrictEqual(shaped.map((f) => f.title), ['Pontardawe v Penlan', 'Pontardawe v Cefn Cribbwr']);
    assert.strictEqual(shaped[0].wru_fixture_id, 568140);
    assert.strictEqual(shaped[0].starts_at, '2027-10-17 14:30:00', 'UK local, as published');
    assert.match(shaped[0].description, /National League/);
    assert.deepStrictEqual(ev.shapeFixtures([{ fixtureId: 1, date: 'soon', homeTeam: { orgId: 165 }, awayTeam: {} }], 165, 'X'), []);
    const named = ev.shapeFixtures([fixture(1, '2027-01-01T19:00:00', PONT, [1, 'Penlan RFC'])], 165, null);
    assert.strictEqual(named[0].title, 'Pontardawe v Penlan', 'without a home name, the club’s own');
  });

  await check('times are read as wall-clock and shown in words', () => {
    assert.strictEqual(ev.cleanDateTime('2026-10-17T14:30'), '2026-10-17 14:30:00');
    assert.strictEqual(ev.cleanDateTime('2026-10-17 25:00'), null);
    assert.strictEqual(ev.whenText('2026-10-17T14:30'), 'Saturday 17 October 2026, 2:30pm');
    assert.strictEqual(ev.whenText('2026-10-17T19:00'), 'Saturday 17 October 2026, 7pm');
    assert.match(ev.ukNow(new Date('2026-07-01T12:00:00Z')), /^2026-07-01 13:00:00$/, 'BST');
    assert.match(ev.ukNow(new Date('2026-12-01T12:00:00Z')), /^2026-12-01 12:00:00$/, 'GMT');
  });

  await check('the ticket PDF is a PDF with a page per ticket', async () => {
    const pdf = await ev.ticketsPdf({ venue: 'Pontardawe RFC', event: { title: 'Pontardawe v Penlan', starts_at: '2026-10-17T14:30', location: 'The Ynys' },
      tickets: [{ code: 'ABCDEFGHJK', type: 'Adult', holder: 'Ann' }, { code: 'ABCDEFGHJL', type: 'Junior', holder: 'Ann' }] });
    assert.strictEqual(pdf.slice(0, 5).toString(), '%PDF-');
    assert.strictEqual((pdf.toString('latin1').match(/\/Type \/Page\b/g) || []).length, 2);
  });
}

// ---- Against a database -----------------------------------------------------

async function applySchema(conn, file) {
  const migration = fs.readFileSync(path.join(__dirname, '..', 'schema', file), 'utf8');
  let delimiter = ';';
  let buffer = '';
  for (const line of migration.split(/\r?\n/)) {
    const d = /^DELIMITER\s+(\S+)/.exec(line.trim());
    if (d) { delimiter = d[1]; continue; }
    if (line.trim().startsWith('--') && !buffer.trim()) continue;
    buffer += line + '\n';
    if (buffer.trimEnd().endsWith(delimiter)) {
      const sql = buffer.trimEnd().slice(0, -delimiter.length).trim();
      if (sql) await conn.query(sql);
      buffer = '';
    }
  }
}

function call(server, method, url, token, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: server.address().port, method, path: url,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, body: json, text: data, type: res.headers['content-type'] });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const CLUB = { id: 35, name: 'Pontardawe RFC Ltd', email: 'club@events.test' };
const PUB = { id: 36, name: 'The Arms', email: 'arms@events.test' };
const sessionFor = (o) => jwt.sign({ email: o.email, officeId: o.id, role: 'office' }, SECRET);
const tillFor = (o) => jwt.sign({ scope: 'terminal', office: o.email, officeId: o.id }, SECRET);
const RETURN = 'https://pontardawerfc.com/tickets/order';

async function database() {
  let admin;
  try {
    admin = await mysql.createConnection({ host: HOST, user: USER, password: PASS, multipleStatements: true });
  } catch (e) {
    console.log(`-- no database reachable, skipping the database checks (${e.code || e.message})`);
    return;
  }
  console.log('Events & tickets: against a database');
  await admin.query(`DROP DATABASE IF EXISTS ${DB}; CREATE DATABASE ${DB} CHARACTER SET utf8mb4;`);
  await admin.query(`USE ${DB}`);
  await admin.query(`CREATE TABLE backoffice_users (
    id INT AUTO_INCREMENT PRIMARY KEY, email VARCHAR(190), password VARCHAR(255),
    name VARCHAR(190), company VARCHAR(190), approved CHAR(1)) ENGINE=InnoDB`);
  // Every schema file, in order, twice, as the deploy does; the ones this
  // feature reads must apply cleanly both times.
  const mustApply = /^schema_(tenancy|venue_modules|menu_dinein|events)\.sql$/;
  const files = fs.readdirSync(path.join(__dirname, '..', 'schema')).filter((f) => f.endsWith('.sql')).sort();
  for (let pass = 0; pass < 2; pass++) {
    for (const f of files) {
      try {
        await applySchema(admin, f);
      } catch (e) {
        if (mustApply.test(f)) throw new Error(`${f}: ${e.message}`);
      }
    }
  }

  const pool = mysql.createPool({ host: HOST, user: USER, password: PASS, database: DB, connectionLimit: 5 });
  await pool.query('INSERT INTO offices (id, name, contact_email) VALUES (?,?,?), (?,?,?)',
    [CLUB.id, CLUB.name, CLUB.email, PUB.id, PUB.name, PUB.email]);
  await pool.query("INSERT INTO dinein_venue (office_id, slug, display_name) VALUES (?, 'pontardawe-rfc', 'Pontardawe RFC'), (?, 'the-arms', NULL)",
    [CLUB.id, PUB.id]);

  const app = express();
  const broadcast = () => {};
  app.use(moduleRoutes({ pool, broadcast, secret: SECRET }));
  app.use(ev.eventRoutes({ pool, broadcast, secret: SECRET }));
  app.use((err, _req, res, _next) => { console.error(err); res.status(500).json({ error: err.message }); });
  const server = app.listen(0);
  const bo = sessionFor(CLUB);
  const till = tillFor(CLUB);
  const pubBo = sessionFor(PUB);

  const day = (n) => ev.ukNow(new Date(Date.now() + n * 86400000)).slice(0, 10);

  try {
    await check('nothing answers before the module is allowed', async () => {
      assert.strictEqual((await call(server, 'GET', '/api/events', bo)).status, 404);
      assert.strictEqual((await call(server, 'GET', '/till/events', till)).status, 404);
      assert.strictEqual((await call(server, 'GET', '/api/public/events/pontardawe-rfc')).status, 404);
    });

    await setAllowed(pool, CLUB.id, { events: { allowed: true } }, 'test');
    await setAllowed(pool, PUB.id, { events: { allowed: true } }, 'test');

    let match;
    await check('an event is made with its ticket types', async () => {
      const r = await call(server, 'POST', '/api/events', bo, {
        title: 'Pontardawe v Penlan', kind: 'match', starts_at: `${day(3)}T14:30`, location: 'The Ynys',
        published: true, on_sale: true,
        ticket_types: [{ name: 'Adult', price_minor: 800, capacity: 3, max_per_order: 4 }, { name: 'Junior', price_minor: 0, sort: 1 }],
      });
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      match = r.body;
      assert.strictEqual(match.starts_at, `${day(3)}T14:30`);
      assert.deepStrictEqual(match.ticket_types.map((t) => [t.name, t.remaining]), [['Adult', 3], ['Junior', null]]);
      const bad = await call(server, 'POST', '/api/events', bo, { title: '', starts_at: 'soon' });
      assert.strictEqual(bad.status, 400);
    });
    const adult = () => match.ticket_types.find((t) => t.name === 'Adult').id;
    const junior = () => match.ticket_types.find((t) => t.name === 'Junior').id;

    await check('another venue cannot see or change it', async () => {
      assert.strictEqual((await call(server, 'GET', `/api/events/${match.id}`, pubBo)).status, 404);
      assert.strictEqual((await call(server, 'PUT', `/api/events/${match.id}`, pubBo, { title: 'Mine' })).status, 404);
      const pub = await call(server, 'GET', '/api/public/events/the-arms');
      assert.deepStrictEqual(pub.body.events, []);
    });

    await check('the website lists published events from today, in the contract’s shape', async () => {
      await call(server, 'POST', '/api/events', bo, { title: 'Draft', starts_at: `${day(2)}T19:00`, published: false });
      await call(server, 'POST', '/api/events', bo, { title: 'Last week', starts_at: `${day(-7)}T19:00`, published: true });
      const r = await call(server, 'GET', '/api/public/events/pontardawe-rfc');
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(r.body.venue, { name: 'Pontardawe RFC' });
      assert.deepStrictEqual(r.body.events.map((e) => e.title), ['Pontardawe v Penlan']);
      const e = r.body.events[0];
      assert.deepStrictEqual(Object.keys(e).sort(), ['description', 'ends_at', 'id', 'image_url', 'kind', 'location',
        'on_sale', 'starts_at', 'ticket_types', 'title', 'wru_fixture_id'].sort());
      assert.strictEqual(e.on_sale, true);
      assert.strictEqual(e.wru_fixture_id, null);
      assert.deepStrictEqual(Object.keys(e.ticket_types[0]).sort(), ['id', 'max_per_order', 'name', 'price_minor', 'remaining']);
      assert.strictEqual((await call(server, 'GET', '/api/public/events/nobody-here')).status, 404);
    });

    const buy = (body) => call(server, 'POST', '/api/public/events/pontardawe-rfc/checkout', null,
      { event_id: match.id, name: 'Ann Lee', email: 'ann@example.com', phone: '07700 900000', return_url: RETURN, ...body });

    await check('checkout refuses what it cannot sell', async () => {
      assert.strictEqual((await buy({ items: [] })).status, 400);
      assert.strictEqual((await buy({ items: [{ ticket_type_id: adult(), qty: 5 }] })).status, 400, 'over max per order');
      assert.strictEqual((await buy({ items: [{ ticket_type_id: 99999, qty: 1 }] })).status, 400);
      assert.strictEqual((await buy({ items: [{ ticket_type_id: adult(), qty: 1 }], email: 'nope' })).status, 400);
      assert.strictEqual((await buy({ items: [{ ticket_type_id: adult(), qty: 1 }], return_url: 'https://evil.example/' })).status, 400);
      assert.strictEqual((await buy({ items: [{ ticket_type_id: adult(), qty: 1 }], return_url: undefined })).status, 400);
      const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM epos_event_orders');
      assert.strictEqual(Number(n), 0, 'nothing refused holds tickets');
    });

    let paidOrder;
    await check('a paid checkout goes to Dojo and comes back to the website', async () => {
      const r = await buy({ items: [{ ticket_type_id: adult(), qty: 2 }, { ticket_type_id: junior(), qty: 1 }] });
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      assert.match(r.body.order_id, /^[0-9a-f]{32}$/);
      assert.match(r.body.pay_url, /^https:\/\/pay\.dojo\.tech\/checkout\/pi_sandbox_e/);
      const intent = intents[r.body.pay_url.split('/').pop()];
      assert.strictEqual(intent.amount, 1600);
      assert.strictEqual(intent.redirect, `${RETURN}?order=${r.body.order_id}`);
      paidOrder = r.body.order_id;
    });

    await check('a pending order holds its tickets', async () => {
      const r = await buy({ items: [{ ticket_type_id: adult(), qty: 2 }] });
      assert.strictEqual(r.status, 409, 'only one Adult left while the first buyer pays');
      assert.match(r.body.error, /Only 1 Adult ticket is left/);
      const list = await call(server, 'GET', '/api/public/events/pontardawe-rfc');
      assert.strictEqual(list.body.events[0].ticket_types.find((t) => t.name === 'Adult').remaining, 1);
    });

    const orderUrl = (id) => `/api/public/events/pontardawe-rfc/orders/${id}`;
    await check('the order is pending until Dojo says paid, then has its tickets, once', async () => {
      const before = await call(server, 'GET', orderUrl(paidOrder));
      assert.strictEqual(before.body.status, 'pending');
      assert.deepStrictEqual(before.body.tickets, []);
      const [[o]] = await pool.query('SELECT dojo_intent_id FROM epos_event_orders WHERE public_id = ?', [paidOrder]);
      intents[o.dojo_intent_id].status = 'Captured';
      const [a, b] = await Promise.all([call(server, 'GET', orderUrl(paidOrder)), call(server, 'GET', orderUrl(paidOrder))]);
      for (const r of [a, b]) {
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.status, 'paid');
        assert.strictEqual(r.body.total_minor, 1600);
        assert.strictEqual(r.body.name, 'Ann Lee');
        assert.deepStrictEqual(r.body.event, { title: 'Pontardawe v Penlan', starts_at: `${day(3)}T14:30`, location: 'The Ynys' });
        assert.strictEqual(r.body.tickets.length, 3);
      }
      const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM epos_event_tickets');
      assert.strictEqual(Number(n), 3, 'two tabs, one set of tickets');
      const t = a.body.tickets[0];
      assert.match(t.code, /^[A-HJ-NP-Z2-9]{10}$/);
      assert.ok(t.qr_url.endsWith(`/api/public/events/ticket/${t.code}.svg`));
      assert.deepStrictEqual(a.body.tickets.map((x) => x.type).sort(), ['Adult', 'Adult', 'Junior']);
    });

    await check('another venue’s slug cannot read the order', async () => {
      assert.strictEqual((await call(server, 'GET', `/api/public/events/the-arms/orders/${paidOrder}`)).status, 404);
    });

    await check('the QR is an SVG of VT:<code>', async () => {
      const r = await call(server, 'GET', orderUrl(paidOrder));
      const code = r.body.tickets[0].code;
      const svg = await call(server, 'GET', `/api/public/events/ticket/${code}.svg`);
      assert.strictEqual(svg.status, 200);
      assert.match(svg.type, /image\/svg\+xml/);
      assert.match(svg.text, /^<svg /);
      assert.strictEqual((await call(server, 'GET', '/api/public/events/ticket/nonsense.svg')).status, 404);
    });

    await check('sold out while somebody is paying for the last one', async () => {
      const r = await buy({ items: [{ ticket_type_id: adult(), qty: 1 }] });
      assert.strictEqual(r.status, 201);
      const again = await buy({ items: [{ ticket_type_id: adult(), qty: 1 }] });
      assert.strictEqual(again.status, 409);
      assert.match(again.body.error, /sold out/);
    });

    await check('a free order is paid at once and has its tickets', async () => {
      const r = await buy({ items: [{ ticket_type_id: junior(), qty: 2 }], return_url: undefined });
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      assert.deepStrictEqual(Object.keys(r.body).sort(), ['order_id', 'paid']);
      assert.strictEqual(r.body.paid, true);
      const o = await call(server, 'GET', orderUrl(r.body.order_id));
      assert.strictEqual(o.body.status, 'paid');
      assert.strictEqual(o.body.tickets.length, 2);
    });

    await check('checkout is refused when the event is not on sale', async () => {
      await call(server, 'PUT', `/api/events/${match.id}`, bo, { on_sale: false });
      assert.strictEqual((await buy({ items: [{ ticket_type_id: junior(), qty: 1 }] })).status, 409);
      await call(server, 'PUT', `/api/events/${match.id}`, bo, { on_sale: true });
    });

    let ticket;
    await check('a ticket checks in once at the till; the second scan says when', async () => {
      const r = await call(server, 'GET', orderUrl(paidOrder));
      ticket = r.body.tickets[0];
      const first = await call(server, 'POST', '/till/events/checkin', till, { code: `VT:${ticket.code}`, staff: 'Dai' });
      assert.strictEqual(first.status, 200);
      assert.strictEqual(first.body.ok, true);
      assert.deepStrictEqual(first.body.ticket, { code: ticket.code, event_title: 'Pontardawe v Penlan',
        starts_at: `${day(3)}T14:30`, type: ticket.type, holder: 'Ann Lee' });
      const second = await call(server, 'POST', '/till/events/checkin', till, { code: ticket.code });
      assert.strictEqual(second.status, 200);
      assert.strictEqual(second.body.ok, false);
      assert.strictEqual(second.body.already, true);
      assert.match(second.body.checked_in_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
      assert.strictEqual(second.body.message, `Already scanned at ${second.body.checked_in_at.slice(11, 16)}`);
      assert.strictEqual(second.body.ticket.code, ticket.code);
    });

    await check('two gates scanning one ticket at once let it in once', async () => {
      const t = (await call(server, 'GET', orderUrl(paidOrder))).body.tickets[1];
      const both = await Promise.all([1, 2, 3].map(() => call(server, 'POST', '/till/events/checkin', till, { code: t.code })));
      assert.strictEqual(both.filter((r) => r.body.ok).length, 1);
    });

    await check('not a ticket: nonsense, an unpaid order, another venue', async () => {
      const none = await call(server, 'POST', '/till/events/checkin', till, { code: 'VT:AAAAAAAAAA' });
      assert.strictEqual(none.status, 404);
      assert.deepStrictEqual(none.body, { ok: false, message: 'Not a valid ticket' });
      assert.strictEqual((await call(server, 'POST', '/till/events/checkin', till, { code: 'rubbish' })).status, 404);
      const [[o]] = await pool.query('SELECT id FROM epos_event_orders WHERE public_id = ?', [paidOrder]);
      const [[t]] = await pool.query('SELECT code FROM epos_event_tickets WHERE order_id = ? AND checked_in_at IS NULL LIMIT 1', [o.id]);
      await pool.query("UPDATE epos_event_orders SET status = 'refunded' WHERE id = ?", [o.id]);
      assert.strictEqual((await call(server, 'POST', '/till/events/checkin', till, { code: t.code })).status, 404, 'refunded');
      await pool.query("UPDATE epos_event_orders SET status = 'paid' WHERE id = ?", [o.id]);
      assert.strictEqual((await call(server, 'POST', '/till/events/checkin', tillFor(PUB), { code: t.code })).status, 404, 'other venue');
    });

    await check('the till lists this week’s events with what was sold and scanned', async () => {
      const r = await call(server, 'GET', '/till/events', till);
      assert.strictEqual(r.status, 200);
      const e = r.body.events.find((x) => x.id === match.id);
      assert.deepStrictEqual(Object.keys(e).sort(), ['checked_in', 'id', 'sold', 'starts_at', 'ticket_types', 'title']);
      assert.strictEqual(e.sold, 5, 'paid orders only; the last Adult is still on the card page');
      assert.strictEqual(e.checked_in, 2);
      assert.deepStrictEqual(Object.keys(e.ticket_types[0]).sort(), ['id', 'name', 'price_minor']);
      assert.ok(!r.body.events.some((x) => x.title === 'Last week'), 'a week ago is out of range');
    });

    await check('the back office issues a complimentary ticket and lists the sales', async () => {
      const r = await call(server, 'POST', `/api/events/${match.id}/issue`, bo,
        { name: 'Guest of the club', items: [{ ticket_type_id: junior(), qty: 1 }], amount_minor: 0, send_email: false });
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      assert.strictEqual(r.body.tickets.length, 1);
      const list = await call(server, 'GET', `/api/events/${match.id}/orders`, bo);
      assert.strictEqual(list.status, 200);
      assert.strictEqual(list.body.totals.tickets, 6);
      assert.strictEqual(list.body.totals.checked_in, 2);
      assert.strictEqual(list.body.totals.revenue_minor, 1600);
      assert.ok(list.body.orders.some((o) => o.status === 'pending'), 'the unfinished checkout is listed too');
      const comp = list.body.orders.find((o) => o.source === 'backoffice');
      assert.strictEqual(comp.status, 'paid');
      assert.strictEqual(comp.issued_by, CLUB.email);
      const gate = await call(server, 'POST', '/api/events/checkin', bo, { code: comp.tickets[0].code });
      assert.strictEqual(gate.body.ok, true);
      const undo = await call(server, 'POST', `/api/events/tickets/${comp.tickets[0].code}/undo`, bo);
      assert.strictEqual(undo.status, 200);
    });

    await check('an event with sales cannot be deleted; a sold ticket type cannot either', async () => {
      assert.strictEqual((await call(server, 'DELETE', `/api/events/${match.id}`, bo)).status, 409);
      assert.strictEqual((await call(server, 'DELETE', `/api/events/ticket-types/${adult()}`, bo)).status, 409);
      const added = await call(server, 'POST', `/api/events/${match.id}/ticket-types`, bo, { name: 'Member', price_minor: 500 });
      assert.strictEqual(added.status, 201);
      const member = added.body.ticket_types.find((t) => t.name === 'Member');
      const edited = await call(server, 'PUT', `/api/events/ticket-types/${member.id}`, bo, { price_minor: 600 });
      assert.strictEqual(edited.body.ticket_types.find((t) => t.id === member.id).price_minor, 600);
      assert.strictEqual((await call(server, 'DELETE', `/api/events/ticket-types/${member.id}`, bo)).status, 200);
    });

    await check('the WRU import makes home matches once and updates them after', async () => {
      const r = await call(server, 'POST', '/api/events/import-wru', bo);
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.deepStrictEqual(r.body, { fixtures: 2, created: 2, updated: 0 });
      const [rows] = await pool.query("SELECT title, wru_fixture_id, published, on_sale FROM epos_events WHERE wru_fixture_id IS NOT NULL ORDER BY starts_at");
      assert.deepStrictEqual(rows.map((x) => x.title), ['Pontardawe v Penlan', 'Pontardawe v Cefn Cribbwr']);
      assert.ok(rows.every((x) => x.published === 1 && x.on_sale === 0));
      const [[copied]] = await pool.query(
        'SELECT COUNT(*) AS n FROM epos_event_ticket_types t JOIN epos_events e ON e.id = t.event_id WHERE e.wru_fixture_id = 568140');
      assert.ok(Number(copied.n) >= 2, 'the last match’s ticket types come with it');

      wruPages[1].fixtures[0].date = '2027-10-17T15:00:00';
      const again = await call(server, 'POST', '/api/events/import-wru', bo);
      assert.deepStrictEqual(again.body, { fixtures: 2, created: 0, updated: 1 });
      const [[moved]] = await pool.query("SELECT DATE_FORMAT(starts_at, '%H:%i') AS t FROM epos_events WHERE wru_fixture_id = 568140");
      assert.strictEqual(moved.t, '15:00');
      const pub = await call(server, 'GET', '/api/public/events/pontardawe-rfc');
      assert.ok(pub.body.events.some((e) => e.wru_fixture_id === 568140));
      // The pub has no WRU club set.
      assert.strictEqual((await call(server, 'POST', '/api/events/import-wru', pubBo)).status, 409);
    });

    await check('settings: the club’s defaults, and its own websites when saved', async () => {
      const s = await call(server, 'GET', '/api/events/settings', bo);
      assert.strictEqual(s.body.wru_org_id, 165);
      assert.deepStrictEqual(s.body.site_origins, ['https://pontardawerfc.com', 'https://www.pontardawerfc.com']);
      assert.strictEqual((await call(server, 'PUT', '/api/events/settings', pubBo, { site_origins: 'http://insecure.example' })).status, 400);
      const saved = await call(server, 'PUT', '/api/events/settings', pubBo, { site_origins: 'https://thearms.example/, https://www.thearms.example' });
      assert.deepStrictEqual(saved.body.site_origins, ['https://thearms.example', 'https://www.thearms.example']);
    });
  } finally {
    server.close();
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin.end();
  }
}

(async () => {
  await pure();
  await database();
  console.log(`events: ${passed} checks passed`);
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
