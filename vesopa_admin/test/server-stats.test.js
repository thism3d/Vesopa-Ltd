const test = require('node:test');
const assert = require('node:assert');

const stats = require('../src/server_stats');

test('CPU is the busy share between two readings', () => {
  assert.strictEqual(stats.cpuPercent({ idle: 100, total: 200 }, { idle: 150, total: 300 }), 50);
  assert.strictEqual(stats.cpuPercent(null, { idle: 1, total: 2 }), 0);
  assert.strictEqual(stats.cpuPercent({ idle: 1, total: 2 }, { idle: 1, total: 2 }), 0);
});

test('network bytes add up every interface except loopback', () => {
  const text = [
    'Inter-|   Receive',
    ' face |bytes packets',
    '    lo: 999 1 0 0 0 0 0 0 999 1 0 0 0 0 0 0',
    '  ens4: 100 1 0 0 0 0 0 0 200 1 0 0 0 0 0 0',
    '  ens5: 10 1 0 0 0 0 0 0 20 1 0 0 0 0 0 0',
  ].join('\n');
  assert.deepStrictEqual(stats.parseNetDev(text), { rx: 110, tx: 220 });
});

test('an alert shows at or over its level, and not for a missing reading', () => {
  const levels = { cpu: 85, memory: 90, disk: 90 };
  const out = stats.alertsFor({ cpu: 85, memory: 10, disk: null }, levels);
  assert.strictEqual(out.length, 1);
  assert.match(out[0], /CPU is at 85%/);
  assert.deepStrictEqual(stats.alertsFor(null, levels), []);
});
