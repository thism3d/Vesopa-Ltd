/**
 * Every back-office report on Vesopa Go (src/tap.js, /api/tap/reports/*):
 * the back office's own report engine, behind a terminal token and a member
 * of staff whose PIN is checked on the server. The report engine is faked
 * here; reports.test.js covers its numbers.
 */
process.env.EXPRESS_SECRET_KEY = process.env.EXPRESS_SECRET_KEY || 'tap-test-sealing-key';

const assert = require('assert');
const http = require('http');
const express = require('express');

// The report engine, faked before tap.js loads it.
const reports = require('../src/reports');
let asked = null;
reports.runReport = async (a) => {
  asked = a;
  if (a.report === 'nope') throw new Error('No such report: nope');
  return {
    title: 'Financial Summary', from: new Date('2026-11-26T00:00:00Z'), to: new Date('2026-11-26T23:59:59Z'), generatedAt: new Date(),
    terminal: null, terminalLabel: 'All terminals', filters: {},
    sections: [{ title: 'Sales', columns: [{ key: 'name', label: 'Name' }, { key: 'net_minor', label: 'Net', type: 'money' }], rows: [{ name: 'Bar', net_minor: 1250 }], total: null }],
  };
};
reports.terminalsInUse = async () => [{ value: 'named:Terminal 1', label: 'Terminal 1' }];
reports.reportHeader = () => ({ site: 'The Vesopa Kitchen' });

const { issueTerminalToken } = require('../src/auth');
const tap = require('../src/tap');

const SECRET = 'go-reports-secret';
const OFFICE = 'kitchen@venue.test';
const clerks = {
  1: { name: 'Mo (manager)', pin: '1111', grp: 5, is_manager: 1, can_x_report: 0 },
  2: { name: 'Sam (bar)', pin: '2222', grp: 6, is_manager: 0, can_x_report: 0 },
  3: { name: 'Ali (supervisor)', pin: '3333', grp: 7, is_manager: 0, can_x_report: 1 },
};
let options = {};
const pool = {
  async query(sql, args = []) {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.includes('FROM bo_clarks c')) {
      const c = args[1] === OFFICE ? clerks[args[0]] : null;
      return [c ? [c] : []];
    }
    if (s.startsWith('SELECT options FROM epos_go_options')) return [[{ options: JSON.stringify(options) }]];
    if (s.startsWith('CREATE TABLE')) return [{}];
    if (s.startsWith('SELECT name FROM offices')) return [[{ name: 'The Vesopa Kitchen' }]];
    return [[]];
  },
};

async function main() {
  const app = express();
  app.use(tap.tapRoutes({ pool, secret: SECRET, fetchImpl: async () => ({ ok: false, json: async () => ({}) }) }));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = issueTerminalToken({ officeEmail: OFFICE, officeId: 1, email: 'manager@example.com' }, SECRET);
  const go = async (method, path, body, auth = token) => {
    const r = await fetch(base + path, {
      method,
      headers: { ...(auth ? { Authorization: 'Bearer ' + auth } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const run = (clerk_id, pin, extra = {}) => go('POST', '/api/tap/reports/run', { report: 'financial_summary', period: 'today', clerk_id, pin, ...extra });

  try {
    assert.strictEqual((await go('GET', '/api/tap/reports/catalogue', null, null)).status, 401, 'a terminal only');
    const cat = await go('GET', '/api/tap/reports/catalogue');
    assert.strictEqual(cat.status, 200);
    assert.ok(cat.body.reports.length > 5 && cat.body.ranges.some((r) => r.key === 'last_month'), 'the back office\'s reports and periods');
    assert.deepStrictEqual(cat.body.terminals, [{ value: 'named:Terminal 1', label: 'Terminal 1' }]);

    assert.strictEqual((await run(1, '9999')).status, 403, 'a wrong PIN');
    assert.strictEqual((await run(2, '2222')).status, 403, 'a clerk, when the venue keeps reports to managers');
    const ok = await run(1, '1111', { terminal: 'named:Terminal 1', period: 'last_month' });
    assert.strictEqual(ok.status, 200, 'a manager');
    assert.strictEqual(asked.office, OFFICE, 'the venue the terminal token proves, whatever the phone says');
    assert.strictEqual(asked.period, 'last_month');
    assert.strictEqual(asked.terminal, 'named:Terminal 1');
    assert.deepStrictEqual(ok.body.sections[0].rows[0].values.length, 2);
    assert.strictEqual((await run(3, '3333')).status, 200, 'a group that may read the X report');
    options = { reports_clerks: true };
    assert.strictEqual((await run(2, '2222')).status, 200, 'any clerk, when the venue lets clerks open Reports');
    assert.strictEqual((await run(1, '1111', { report: 'nope' })).status, 400);
    console.log('go-reports.test.js: all checks passed');
  } finally {
    server.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
