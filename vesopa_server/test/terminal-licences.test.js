/**
 * Terminals licensed by access key (src/terminal_licences.js): the rules that
 * decide who may use a key and whose settings win.
 */
'use strict';

const assert = require('assert');
const jwt = require('jsonwebtoken');
const {
  bindDecision,
  mergeValues,
  cleanValues,
  rowsForPage,
  attemptLimiter,
  deviceToken,
} = require('../src/terminal_licences');

const secret = 'test-secret';
let checks = 0;
const check = (fn) => {
  fn();
  checks += 1;
};

// A key binds to the first machine.
check(() => {
  assert.strictEqual(bindDecision({}, { fingerprint: 'a', deviceId: 'x' }), 'bind');
});

// A reinstall changes the device id, not the machine.
check(() => {
  const row = { device_fingerprint: 'a', device_id: 'old' };
  assert.strictEqual(bindDecision(row, { fingerprint: 'a', deviceId: 'new' }), 'same');
});

// A copied install brings the device id along; the fingerprint gives it away.
check(() => {
  const row = { device_fingerprint: 'a', device_id: 'same-id' };
  assert.strictEqual(bindDecision(row, { fingerprint: 'b', deviceId: 'same-id' }), 'other');
});

// A phone has no fingerprint, so its device id decides.
check(() => {
  const row = { device_id: 'phone' };
  assert.strictEqual(bindDecision(row, { deviceId: 'phone' }), 'same');
  assert.strictEqual(bindDecision(row, { deviceId: 'another' }), 'other');
});

// Nothing to compare is refused, or a copied key would walk in.
check(() => {
  assert.strictEqual(bindDecision({ device_fingerprint: 'a' }, {}), 'other');
});

// The till's new value is written; an unchanged one is not.
check(() => {
  const existing = [
    { category: 'Printers', name: 'bill', value: '"A"', rev: 1 },
    { category: 'Printers', name: 'kp1', value: '"B"', rev: 1 },
  ];
  const { write, held } = mergeValues(
    existing,
    [
      { category: 'Printers', name: 'bill', value: '"A"' },
      { category: 'Printers', name: 'kp1', value: '"C"' },
    ],
    1
  );
  assert.deepStrictEqual(write.map((w) => w.name), ['kp1']);
  assert.deepStrictEqual(held, []);
});

// A manager's change the till has not seen survives the till's old value.
check(() => {
  const existing = [{ category: 'Printers', name: 'bill', value: '"Manager"', rev: 5 }];
  const { write, held } = mergeValues(
    existing,
    [{ category: 'Printers', name: 'bill', value: '"Old"' }],
    4
  );
  assert.deepStrictEqual(write, []);
  assert.deepStrictEqual(held, [{ category: 'Printers', name: 'bill' }]);
});

// A setting nobody has stored yet is simply written.
check(() => {
  const { write } = mergeValues([], [{ category: 'A', name: 'b', value: '1' }], 0);
  assert.strictEqual(write.length, 1);
});

// Rows with no category or name, and oversized values, are dropped.
check(() => {
  const out = cleanValues([
    { category: 'A', name: 'ok', value: { deep: [1, 2] } },
    { category: '', name: 'x', value: 1 },
    { category: 'A', name: '', value: 1 },
    { category: 'A', name: 'big', value: 'x'.repeat(9000) },
    null,
  ]);
  assert.deepStrictEqual(out.map((v) => v.name), ['ok']);
  assert.strictEqual(out[0].value, '{"deep":[1,2]}');
  assert.deepStrictEqual(cleanValues('nope'), []);
});

// Pending is what the terminal has not picked up.
check(() => {
  const rows = rowsForPage(
    [
      { category: 'A', name: 'seen', value: '1', rev: 2 },
      { category: 'A', name: 'new', value: '2', rev: 3 },
    ],
    2
  );
  assert.deepStrictEqual(rows.map((r) => r.pending), [false, true]);
  assert.strictEqual(rows[1].value, 2);
});

// Ten wrong tries, then it waits; a right one clears it.
check(() => {
  const limiter = attemptLimiter({ max: 3 });
  limiter.failed('ip');
  limiter.failed('ip');
  assert.strictEqual(limiter.blocked('ip'), false);
  limiter.failed('ip');
  assert.strictEqual(limiter.blocked('ip'), true);
  limiter.passed('ip');
  assert.strictEqual(limiter.blocked('ip'), false);
});

// Every token is scoped, so none of them can open the back office, and each
// long-life token carries its seat so the back office can still take it back.
check(() => {
  const terminal = { terminal_no: 3, name: 'Bar' };
  const base = { office: 'v@x', officeId: 9, terminal, seatId: 'seat-1', secret };
  const till = jwt.verify(deviceToken({ ...base, kind: 'till' }), secret);
  assert.strictEqual(till.scope, 'terminal');
  assert.strictEqual(till.jti, 'seat-1');
  assert.strictEqual(till.sub, undefined);
  assert.ok(till.exp - till.iat > 3000 * 86400);
  assert.strictEqual(jwt.verify(deviceToken({ ...base, kind: 'go' }), secret).scope, 'terminal');
  assert.strictEqual(jwt.verify(deviceToken({ ...base, kind: 'kitchen' }), secret).scope, 'kitchen');
  const display = jwt.verify(deviceToken({ ...base, kind: 'display' }), secret);
  assert.strictEqual(display.scope, 'display');
  assert.strictEqual(display.name, 'Bar');
});

console.log(`terminal-licences: ${checks} checks passed`);
