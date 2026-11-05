/**
 * A paid QR payment's way out (src/qr_pay.js): the receipt can be read as well
 * as saved, and a link preview shows the venue's own logo.
 */
'use strict';

const assert = require('assert');
const { receiptActions, logoArgs, receiptFor } = require('../src/qr_pay');
const { receiptPdf } = require('../src/receipt_pdf');

(async () => {
  const html = receiptActions('abc123');
  assert.match(html, /href="\/pay\/abc123\/receipt\.pdf" target="_blank"/);
  assert.match(html, /receipt\.pdf\?save=1/);
  assert.match(html, /window\.print\(\)/);

  const args = logoArgs('/tmp/crest.png');
  assert.ok(args.includes('/tmp/crest.png'));
  assert.ok(args.includes('-composite'));

  const paid = { code: 'abcdef123456', amount_minor: 1250, paid_at: new Date(), bill_name: 'Table 7' };
  const none = receiptFor({ ...paid, items: null });
  assert.strictEqual(none.lines[0].name, 'Table 7');
  assert.strictEqual(none.lines[0].unit_price_minor, 1250);
  assert.strictEqual(none.label, 'RECEIPT');

  const some = receiptFor({
    ...paid,
    items: JSON.stringify({ lines: [{ name: 'IPA', qty: 2, total_minor: 1000, notes: ['No ice'] }] }),
  });
  assert.strictEqual(some.lines[0].unit_price_minor, 500);
  assert.strictEqual(some.lines[0].note, 'No ice');

  // A broken bill still gives a receipt rather than an error.
  assert.strictEqual(receiptFor({ ...paid, items: '{nope' }).lines.length, 1);

  const pdf = await receiptPdf(some, 'The Vesopa Kitchen');
  assert.strictEqual(pdf.subarray(0, 5).toString(), '%PDF-');

  console.log('qr-pay-receipt: 5 groups passed');
})().catch((e) => { console.error(e); process.exit(1); });
