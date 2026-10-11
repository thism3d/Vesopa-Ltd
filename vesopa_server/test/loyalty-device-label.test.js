const test = require('node:test');
const assert = require('node:assert');
const { deviceLabel } = require('../src/loyalty_account');

test('the app says which device it is on', () => {
  assert.strictEqual(deviceLabel('ios', 'Pontardawe RFC (iPad; iOS 26.0)'), 'iPad');
  assert.strictEqual(deviceLabel('ios', 'Pontardawe RFC (iPhone; iOS 26.0)'), 'iPhone');
  assert.strictEqual(deviceLabel('android', 'Pontardawe RFC (Android 15; SM-S921B)'), 'Android phone or tablet');
  assert.strictEqual(deviceLabel('ios', 'Dart/3.9 (dart:io)'), null);
});

test('a browser is named by what it is and what it runs on', () => {
  assert.strictEqual(deviceLabel('web',
    'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'),
  'Safari on an iPad');
  assert.strictEqual(deviceLabel('web',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 Edg/140.0'),
  'Edge on Windows');
  assert.strictEqual(deviceLabel('web', ''), null);
});
