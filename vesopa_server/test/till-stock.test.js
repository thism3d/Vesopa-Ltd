/**
 * The till's copy of the stock routes (2026-09-27): /till/stock/...
 *
 * Same handlers as the back office's /api/stock/..., signed with a terminal
 * token. Checked here: a till without a token is refused; a till with one
 * reaches the handler scoped to ITS venue (never one named in the request);
 * the member of staff's name reaches the ledger; and a back-office session
 * token is not a terminal token.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');

const { stockRoutes } = require('../src/stock');

const SECRET = 'test-secret-not-a-real-one';

function fakePool() {
  const asked = [];
  const answer = (sql, params) => {
    const q = sql.replace(/\s+/g, ' ').trim();
    asked.push({ q, params });
    if (q.startsWith('SELECT contact_email FROM offices')) {
      return [[{ contact_email: params[0] === 7 ? 'venue@example.com' : 'other@example.com' }]];
    }
    return [[]];
  };
  return {
    asked,
    query: async (sql, params = []) => [answer(sql, params)[0], []],
    execute: async (sql, params = []) => [answer(sql, params)[0], []],
    getConnection: async () => ({
      beginTransaction: async () => {},
      commit: async () => {},
      rollback: async () => {},
      release: () => {},
      query: async (sql, params = []) => [answer(sql, params)[0], []],
      execute: async (sql, params = []) => [answer(sql, params)[0], []],
    }),
  };
}

async function serve(pool) {
  const app = express();
  app.use(express.json());
  app.use(stockRoutes({ pool, broadcast: () => {}, secret: SECRET, toPdf: async () => Buffer.from(''), till: true }));
  app.use((err, _req, res, _next) => res.status(500).json({ error: String(err) }));
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const call = async (method, path, { token, body, staff } = {}) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(staff ? { 'X-Vesopa-Staff': staff } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { server, call };
}

const terminal = jwt.sign({ scope: 'terminal', office: 'venue@example.com', officeId: 7 }, SECRET);
const session = jwt.sign({ sub: 1, email: 'boss@example.com', role: 'office', officeId: 7 }, SECRET);

test('no token, no stock', async () => {
  const { server, call } = await serve(fakePool());
  try {
    assert.equal((await call('GET', '/till/stock/products')).status, 401);
    assert.equal((await call('POST', '/till/stock/docs', { body: { kind: 'wastage', lines: [] } })).status, 401);
  } finally {
    server.close();
  }
});

test('a back-office session is not a terminal token', async () => {
  const { server, call } = await serve(fakePool());
  try {
    assert.equal((await call('GET', '/till/stock/products', { token: session })).status, 401);
  } finally {
    server.close();
  }
});

test('a till reads its own venue, whatever it asks for', async () => {
  const pool = fakePool();
  const { server, call } = await serve(pool);
  try {
    const r = await call('GET', '/till/stock/products?office=other@example.com', { token: terminal });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const read = pool.asked.find((a) => /FROM bo_products/.test(a.q));
    assert.ok(read, 'the catalogue was not read');
    assert.equal(read.params[0], 'venue@example.com');
    assert.ok(!pool.asked.some((a) => a.params.includes('other@example.com') && /bo_products/.test(a.q)));
  } finally {
    server.close();
  }
});

test('the back office paths are not mounted on the till router', async () => {
  const { server, call } = await serve(fakePool());
  try {
    assert.equal((await call('GET', '/stock/products', { token: terminal })).status, 404);
  } finally {
    server.close();
  }
});

test('the member of staff at the till is who the ledger records', async () => {
  const pool = fakePool();
  const { server, call } = await serve(pool);
  try {
    await call('POST', '/till/stock/docs', {
      token: terminal,
      staff: 'Nicky',
      body: { kind: 'wastage', notes: 'dropped', lines: [{ pluid: 101, quantity: 2, reason: 'Dropped' }] },
    });
    const insert = pool.asked.find((a) => /INSERT INTO bo_stock_docs/.test(a.q));
    assert.ok(insert, 'no document was written');
    assert.ok(insert.params.includes('Nicky'), `staff not recorded: ${JSON.stringify(insert.params)}`);
    assert.ok(insert.params.includes('venue@example.com'));
  } finally {
    server.close();
  }
});
