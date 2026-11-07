/**
 * Vesopa Go's kitchen tickets reaching the tills' paper printers, against a fake
 * database (2026-11-07). Only Go's tickets are queued, only for stations that
 * go to paper; a claim goes to one till; a failure comes back on offer.
 */

const assert = require('assert');
const express = require('express');
const jwt = require('jsonwebtoken');

const { kitchenPrintRoutes, queueGoTicket, paperStations } = require('../src/kitchen_prints');

const SECRET = 'test-secret-not-a-real-one';
const OFFICE = 'venue@example.com';
const TICKET = '11111111-1111-4111-8111-111111111111';

function fakePool(script = []) {
  const asked = [];
  const answer = (sql, params) => {
    asked.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    for (const [pattern, rows] of script) {
      if (sql.includes(pattern)) return [typeof rows === 'function' ? rows(params) : rows, []];
    }
    if (/^\s*(INSERT|UPDATE|DELETE)/i.test(sql)) return [{ affectedRows: 1 }, []];
    return [[], []];
  };
  return { asked, query: async (s, p) => answer(s, p), execute: async (s, p) => answer(s, p) };
}

async function withApp(pool, fn) {
  const events = [];
  const app = express();
  app.use(express.json());
  app.use(kitchenPrintRoutes({ pool, broadcast: (e) => events.push(e), secret: SECRET }));
  const server = await new Promise((ok) => { const s = app.listen(0, () => ok(s)); });
  const token = jwt.sign({ scope: 'terminal', office: OFFICE }, SECRET);
  const call = async (method, path, body) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, body: await r.json() };
  };
  try { await fn(call, events); } finally { server.close(); }
}

(async () => {
  // ---- what is queued -----------------------------------------------------
  const ticket = { id: TICKET, office: OFFICE, source: 'go', lines: [{ stations: 'kp1' }, { stations: 'kp2,kp3' }] };
  assert.deepStrictEqual(paperStations(ticket, { kp1: 'printer', kp2: 'screen', kp3: 'both' }), ['kp1', 'kp3'],
    'a screen-only station gets no paper; Printer and Both do');
  assert.deepStrictEqual(paperStations(ticket, {}), ['kp1', 'kp2', 'kp3'], 'an unset station is a printer');

  {
    const pool = fakePool();
    const events = [];
    const queued = await queueGoTicket(pool, (e) => events.push(e), ticket, { kp1: 'printer', kp2: 'printer', kp3: 'screen' });
    assert.deepStrictEqual(queued, ['kp1', 'kp2']);
    assert.strictEqual(pool.asked.filter((q) => q.sql.startsWith('INSERT IGNORE INTO epos_kitchen_prints')).length, 2);
    assert.strictEqual(events[0].type, 'kitchen.print', 'the tills are told at once');
  }
  {
    const pool = fakePool();
    const events = [];
    const tills = await queueGoTicket(pool, (e) => events.push(e), { ...ticket, source: undefined }, {});
    assert.deepStrictEqual(tills, [], 'a till has printed its own ticket already');
    assert.strictEqual(pool.asked.length, 0);
    assert.strictEqual(events.length, 0);
  }

  // ---- the queue, as a till sees it ---------------------------------------
  await withApp(fakePool([['SELECT p.ticket_id, p.station', [
    { ticket_id: TICKET, station: 'kp1' }, { ticket_id: TICKET, station: 'kp2' },
  ]]]), async (call) => {
    const r = await call('GET', '/till/kitchen/print-queue');
    assert.deepStrictEqual(r.body.jobs, [{ ticket_id: TICKET, stations: ['kp1', 'kp2'] }]);
  });

  // ---- a claim won: only that station's lines ----------------------------
  {
    const pool = fakePool([
      ['SELECT station FROM epos_kitchen_prints', [{ station: 'kp1' }]],
      ['FROM epos_kitchen_tickets', [{ id: TICKET, kind: 'table', table_number: 12, staff_name: 'Sam' }]],
      ['FROM epos_kitchen_ticket_lines', [
        { quantity: 2, name: 'Burger', note: null, stations: 'kp1', is_modifier: 0 },
        { quantity: 2, name: 'No onion', note: null, stations: 'kp1', is_modifier: 1 },
        { quantity: 1, name: 'Mojito', note: null, stations: 'kp2', is_modifier: 0 },
      ]],
    ]);
    await withApp(pool, async (call) => {
      const r = await call('POST', `/till/kitchen/print-queue/${TICKET}/claim`, { stations: ['kp1'], terminal: 'Bar' });
      assert.deepStrictEqual(r.body.stations, ['kp1']);
      assert.deepStrictEqual(r.body.ticket.lines.map((l) => l.name), ['Burger', 'No onion']);
      assert.strictEqual(r.body.ticket.table_number, 12);
      const update = pool.asked.find((q) => q.sql.startsWith('UPDATE epos_kitchen_prints'));
      assert.ok(update.sql.includes('p.office = ?'), 'a claim stays in its own venue');
      assert.ok(update.params.includes(OFFICE));
    });
  }

  // ---- a claim lost, and one with no stations -----------------------------
  await withApp(fakePool(), async (call) => {
    const lost = await call('POST', `/till/kitchen/print-queue/${TICKET}/claim`, { stations: ['kp1'] });
    assert.deepStrictEqual(lost.body, { claim_id: null, stations: [] }, 'another till got there first');
    const none = await call('POST', `/till/kitchen/print-queue/${TICKET}/claim`, { stations: ['nonsense'] });
    assert.strictEqual(none.status, 400);
  });

  // ---- how it went --------------------------------------------------------
  {
    const pool = fakePool();
    await withApp(pool, async (call, events) => {
      const r = await call('POST', `/till/kitchen/print-queue/${TICKET}/result`, {
        claim_id: '22222222-2222-4222-8222-222222222222',
        results: [{ station: 'kp1', ok: true }, { station: 'kp2', ok: false, error: 'Out of paper' }],
      });
      assert.strictEqual(r.body.updated, 2);
      const updates = pool.asked.filter((q) => q.sql.startsWith('UPDATE epos_kitchen_prints'));
      assert.ok(updates[0].sql.includes("status = 'printed'"));
      assert.ok(updates[1].sql.includes("status = 'failed'"));
      assert.strictEqual(updates[1].params[0], 'Out of paper', 'the printer\'s own words');
      assert.strictEqual(events[0].type, 'kitchen.print', 'a failure is offered to the other tills');
    });
  }

  console.log('kitchen-prints: ok');
})().catch((e) => { console.error(e); process.exit(1); });
