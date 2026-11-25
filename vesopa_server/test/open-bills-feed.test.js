/**
 * The open-bills feed says when each bill last changed on the till holding it
 * (Pontardawe RFC, 2026-11-24: the two tills' tables "weren't matching ... a
 * while later they were back in sync"). A till that already has a newer copy
 * over the local link uses it to keep that copy.
 *
 *   node test/open-bills-feed.test.js
 */
const assert = require('assert');
const express = require('express');
const jwt = require('jsonwebtoken');
const { terminalRoutes } = require('../src/terminals');

const SECRET = 'test-secret';

function fakePool() {
  const run = async (sql) => {
    if (/ALTER TABLE epos_open_bills ADD COLUMN client_changed_at/.test(sql)) {
      const e = new Error('dup'); e.code = 'ER_DUP_FIELDNAME'; throw e;
    }
    if (/FROM epos_open_bills\s+WHERE office = \? AND rev > \?/.test(sql)) {
      assert.match(sql, /client_changed_at/, 'the feed reads when each bill changed');
      return [[
        { id: 'b1', terminal: 'Bar Till', table_number: 3, room_id: null, covers: 2, staff_id: null,
          clerk_name: 'Nicky', status: 'parked', payload: '{"lines":[]}', total_minor: 3000,
          line_count: 7, rev: 12, claimed_at: null, updated_at: null, client_changed_at: 1764000000123 },
        { id: 'b2', terminal: 'Lounge', table_number: 5, room_id: null, covers: 1, staff_id: null,
          clerk_name: null, status: 'open', payload: '{}', total_minor: 500,
          line_count: 1, rev: 13, claimed_at: null, updated_at: null, client_changed_at: null },
      ]];
    }
    if (/FROM epos_open_bill_revs/.test(sql)) return [[{ rev: 13 }]];
    return [[]];
  };
  return { query: run, execute: run, getConnection: async () => ({ query: run, execute: run, release() {} }) };
}

(async () => {
  const app = express();
  app.use(express.json());
  app.use(terminalRoutes({ pool: fakePool(), broadcast: () => {}, secret: SECRET }));
  const server = app.listen(0);
  const port = server.address().port;
  const token = jwt.sign({ scope: 'terminal', office: 'venue@example.com' }, SECRET);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/till/open-bills?since=0`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.rev, 13);
    assert.strictEqual(body.bills[0].changed_at, 1764000000123);
    assert.strictEqual(body.bills[1].changed_at, null);
    assert.ok(!('client_changed_at' in body.bills[0]), 'served as changed_at only');
    assert.deepStrictEqual(body.bills[0].payload, { lines: [] });
    console.log('  ok  the feed carries each bill\'s changed_at');
    console.log('1 passed');
  } finally {
    server.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
