// node --test shared/activity-log/test
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createActivityLog, redact, scrubText } = require('../activity_log');

test('secret keys are redacted at any depth and in any case style', () => {
  const out = redact({
    email: 'a@b.com',
    password: 'hunter2',
    newPassword: 'x',
    pin: '1234',
    staff_pin_hash: 'abc',
    cardNumber: '4111111111111111',
    cvv: '123',
    Authorization: 'Bearer x',
    otp: '999999',
    nested: { refresh_token: 'r', client_secret: 's', sort_code: '112233' },
    product_code: 'X1',
    plu: 'COKE',
    barcode: '5000112637922',
    pinned: true,
    shipping: 'Royal Mail',
  });
  assert.strictEqual(out.email, 'a@b.com');
  for (const k of ['password', 'newPassword', 'pin', 'staff_pin_hash', 'cardNumber', 'cvv', 'Authorization', 'otp']) {
    assert.strictEqual(out[k], '[redacted]', k);
  }
  assert.deepStrictEqual(out.nested, { refresh_token: '[redacted]', client_secret: '[redacted]', sort_code: '[redacted]' });
  assert.strictEqual(out.product_code, '[redacted]');
  assert.strictEqual(out.plu, 'COKE');
  assert.strictEqual(out.barcode, '5000112637922');
  assert.strictEqual(out.pinned, true);
  assert.strictEqual(out.shipping, 'Royal Mail');
});

test('card numbers and JWTs are masked inside free text', () => {
  assert.strictEqual(scrubText('paid with 4111 1111 1111 1111 ok'), 'paid with [card ••••1111] ok');
  // A 13-digit barcode that fails Luhn is left alone.
  assert.strictEqual(scrubText('scan 5000112637923'), 'scan 5000112637923');
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop';
  assert.strictEqual(scrubText(`token ${jwt}`), 'token [redacted-token]');
});

test('large values are bounded', () => {
  const out = redact({ list: Array.from({ length: 50 }, (_, i) => i), text: 'x'.repeat(1000) });
  assert.strictEqual(out.list.length, 21);
  assert.ok(out.text.length <= 301);
});

test('record writes one JSON line per event to a daily file, and prune removes old files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-'));
  const log = createActivityLog({ service: 'test', dir, fileRetainDays: 30 });
  log.record({ office: 'Venue@Example.com', action: 'tap', target: 'Cash', detail: { pin: '1111', qty: 2 } });
  log.record({ action: 'change', target: '/api/products/3', method: 'PUT', status: 200 });
  await new Promise((r) => setTimeout(r, 100));
  const files = fs.readdirSync(dir);
  assert.strictEqual(files.length, 1);
  const lines = fs.readFileSync(path.join(dir, files[0]), 'utf8').trim().split('\n').map(JSON.parse);
  assert.strictEqual(lines.length, 2);
  assert.strictEqual(lines[0].office, 'venue@example.com');
  assert.strictEqual(lines[0].target, 'Cash');
  assert.deepStrictEqual(JSON.parse(lines[0].detail), { pin: '[redacted]', qty: 2 });

  fs.writeFileSync(path.join(dir, 'activity-2000-01-01.jsonl'), '{}\n');
  const { files: removed } = await log.prune();
  assert.strictEqual(removed, 1);
  assert.ok(!fs.existsSync(path.join(dir, 'activity-2000-01-01.jsonl')));
});

test('db sink inserts the same row and a failing db never throws', async () => {
  const calls = [];
  const pool = { execute: async (sql, args) => { calls.push({ sql, args }); if (calls.length === 2) throw new Error('down'); return [{}]; } };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-'));
  const log = createActivityLog({ service: 'test', dir, pool });
  log.record({ office: 'a@b.com', action: 'tap', target: 'Pay' });
  log.record({ office: 'a@b.com', action: 'tap', target: 'Pay again' });
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(calls.length, 2);
  assert.match(calls[0].sql, /INSERT INTO epos_activity_log/);
  assert.strictEqual(calls[0].args[2], 'a@b.com');
});

test('middleware logs changes and 5xx, not ordinary reads', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-'));
  const log = createActivityLog({ service: 'test', dir });
  const mw = log.middleware({ identify: (req) => ({ office: req.office, actor: 'sam' }) });
  const fake = (method, status, body) => {
    const handlers = {};
    const req = { method, originalUrl: '/api/x?y=1', headers: {}, socket: {}, body, office: 'v@x.com' };
    const res = { statusCode: status, on: (e, f) => { handlers[e] = f; } };
    mw(req, res, () => {});
    handlers.finish();
  };
  fake('GET', 200);
  fake('POST', 200, { password: 'p', name: 'Coke' });
  fake('GET', 500);
  await new Promise((r) => setTimeout(r, 100));
  const file = fs.readdirSync(dir)[0];
  const lines = fs.readFileSync(path.join(dir, file), 'utf8').trim().split('\n').map(JSON.parse);
  assert.strictEqual(lines.length, 2);
  assert.strictEqual(lines[0].action, 'change');
  assert.strictEqual(lines[0].target, '/api/x');
  assert.strictEqual(lines[0].actor, 'sam');
  assert.deepStrictEqual(JSON.parse(lines[0].detail), { password: '[redacted]', name: 'Coke' });
  assert.strictEqual(lines[1].action, 'error');
});

test('every service and app carries an up-to-date copy', () => {
  const root = path.join(__dirname, '..', '..', '..');
  execFileSync(path.join(root, 'tool', 'sync-activity-log.sh'), ['--check'], { stdio: 'pipe' });
});
