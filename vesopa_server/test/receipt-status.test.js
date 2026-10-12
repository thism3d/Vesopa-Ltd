/**
 * Refunds joined back to their sale (EPOS 1.17): the bill's status, the lines
 * already given back, and the receipt as a PDF file.
 *
 * No MySQL: the pool answers each query from fixtures.
 */

const assert = require('assert');
const { statusFor, brief, lineNos } = require('../src/receipt_status');
const { receiptPdf } = require('../src/receipt_pdf');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';

function fakePool({ payments = [], events = [], cards = [], noLineNos = false }) {
  const seen = [];
  return {
    seen,
    async query(sql, params) {
      seen.push(sql);
      if (sql.includes('FROM epos_payments')) return [payments];
      if (sql.includes('FROM epos_till_events')) {
        if (noLineNos && sql.includes('line_nos')) {
          const e = new Error('Unknown column'); e.code = 'ER_BAD_FIELD_ERROR'; throw e;
        }
        return [events];
      }
      if (sql.includes('FROM epos_card_transactions')) return [cards];
      throw new Error(`unexpected ${sql}`);
    },
  };
}

const orders = [
  { id: A, total_minor: 1000, closed_at: '2026-10-10T12:00:00Z' },
  { id: B, total_minor: 2500, closed_at: '2026-10-11T12:00:00Z' },
  { id: C, total_minor: 800, closed_at: '2026-10-11T13:00:00Z' },
];

test('a bill refunded in full reads refunded, with its lines', async () => {
  const pool = fakePool({
    payments: [{ order_id: A, method: 'cash' }],
    events: [{ id: 'e1', order_id: A, amount_minor: 1000, at: '2026-10-12', line_nos: '0,1' }],
  });
  const s = (await statusFor(pool, 'v@x', orders)).get(A);
  assert.strictEqual(s.status, 'refunded');
  assert.strictEqual(s.refunded_minor, 1000);
  assert.deepStrictEqual(s.refunded_line_nos, [0, 1]);
  assert.deepStrictEqual(s.methods, ['cash']);
});

test('a refund recorded before 1.17 is found by its note', async () => {
  const pool = fakePool({
    events: [{ id: 'e2', order_id: null, amount_minor: 500, at: '2026-10-12', note: `Receipt ${B} · Chips` }],
  });
  const s = (await statusFor(pool, 'v@x', orders)).get(B);
  assert.strictEqual(s.status, 'part_refunded');
  assert.strictEqual(s.refunded_minor, 500);
  assert.strictEqual(s.refund_count, 1);
});

test('a card refund off the Card machine page counts, by intent', async () => {
  const pool = fakePool({
    payments: [{ order_id: C, method: 'card', reference: 'pi_abc' }],
    cards: [{ order_id: null, intent_id: 'pi_abc', amount_minor: 800, at: '2026-10-12' }],
  });
  const s = (await statusFor(pool, 'v@x', orders)).get(C);
  assert.strictEqual(s.has_card, true);
  assert.strictEqual(s.status, 'refunded');
  assert.strictEqual(s.card_refunds.pi_abc, 800);
});

test('the till event and its card row are not counted twice', async () => {
  const pool = fakePool({
    payments: [{ order_id: B, method: 'card', reference: 'pi_b' }],
    events: [{ id: 'e3', order_id: B, amount_minor: 2500, at: '2026-10-12' }],
    cards: [{ order_id: B, intent_id: 'pi_b', amount_minor: 2500, at: '2026-10-12' }],
  });
  const s = (await statusFor(pool, 'v@x', orders)).get(B);
  assert.strictEqual(s.refunded_minor, 2500);
  assert.strictEqual(s.status, 'refunded');
});

test('an untouched bill is paid; brief drops the history', async () => {
  const pool = fakePool({ payments: [{ order_id: A, method: 'cash' }] });
  const s = (await statusFor(pool, 'v@x', orders)).get(A);
  assert.strictEqual(s.status, 'paid');
  const b = brief(s);
  assert.strictEqual(b.status, 'paid');
  assert.ok(!('refunds' in b));
});

test('a server before the schema still answers', async () => {
  const pool = fakePool({
    noLineNos: true,
    events: [{ id: 'e4', order_id: A, amount_minor: 200, at: '2026-10-12' }],
  });
  const s = (await statusFor(pool, 'v@x', orders)).get(A);
  assert.strictEqual(s.refunded_minor, 200);
});

test('line numbers are cleaned', () => {
  assert.deepStrictEqual(lineNos('0,2, 5,x,-1'), [0, 2, 5]);
  assert.deepStrictEqual(lineNos([1, 'a', 3]), [1, 3]);
  assert.deepStrictEqual(lineNos(null), []);
});

test('the receipt PDF is a real PDF, roll width, with its refund', async () => {
  const pdf = await receiptPdf({
    order: { id: A, closed_at: '2026-10-10T12:00:00Z', subtotal_minor: 1000, tax_minor: 167, total_minor: 1000, table_number: 4 },
    lines: [{ name: 'Pint of Felinfoel', quantity: 2, unit_price_minor: 500 }],
    payments: [{ method: 'card', amount_minor: 1000, reference: 'pi_x' }],
    status: { status: 'refunded', refunded_minor: 1000, refunds: [{ amount_minor: 1000, at: '2026-10-12T10:00:00Z', staff_name: 'Sam', reason: 'Spilt' }] },
  }, 'Pontardawe RFC');
  assert.strictEqual(pdf.slice(0, 5).toString(), '%PDF-');
  assert.ok(pdf.length > 800);
  const text = pdf.toString('latin1');
  assert.ok(/MediaBox \[0 0 226\.77/.test(text), 'page is 80mm wide');
  assert.strictEqual((text.match(/\/Type \/Page\b/g) || []).length, 1, 'one page');
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`ok - ${name}`); } catch (e) { failed++; console.log(`not ok - ${name}\n${e.stack}`); }
  }
  if (failed) process.exit(1);
})();
