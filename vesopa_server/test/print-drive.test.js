/**
 * Printer drives (src/print_drive.js): what may go in, and how a job moves.
 */
'use strict';

const assert = require('assert');
const { sniffType, safeName, mayMove, printersOf } = require('../src/print_drive');

// A file is what its bytes say, whatever it is called.
assert.strictEqual(sniffType(Buffer.from('%PDF-1.7 rest')), 'application/pdf');
assert.strictEqual(sniffType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0])), 'image/png');
assert.strictEqual(sniffType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
assert.strictEqual(sniffType(Buffer.from('UNIRAST\0....')), 'image/urf');
assert.strictEqual(sniffType(Buffer.from('<html>not a pdf')), null);
assert.strictEqual(sniffType(Buffer.alloc(0)), null);

// A name can't climb out of its folder or break a header.
assert.strictEqual(safeName('../../etc/passwd'), 'passwd');
assert.strictEqual(safeName('C:\\Users\\me\\menu.pdf'), 'menu.pdf');
assert.strictEqual(safeName('a"b\r\nc.pdf'), 'a_b__c.pdf');
assert.strictEqual(safeName(''), 'document');

// A job goes forward only.
assert.ok(mayMove('waiting', 'printing'));
assert.ok(mayMove('printing', 'printed'));
assert.ok(mayMove('printing', 'failed'));
assert.ok(!mayMove('printed', 'printing'), 'a printed job is never taken again by a till');
assert.ok(!mayMove('printing', 'waiting'), 'a job that may have printed is never quietly resent');
assert.ok(!mayMove('cancelled', 'printing'));
assert.ok(!mayMove('printed', 'failed'), 'a late answer cannot undo a result');

// A person can send one again.
assert.ok(mayMove('failed', 'waiting'));
assert.ok(mayMove('printed', 'waiting'));

// A saved document can go to paper once a printer is attached.
assert.ok(mayMove('saved', 'waiting'));
assert.ok(!mayMove('saved', 'printed'));

// The printers a till reported.
assert.deepStrictEqual(printersOf('[{"id":"a","name":"Bar"},{"id":"b"},{"name":"no id"}]'), [
  { id: 'a', name: 'Bar' },
  { id: 'b', name: 'b' },
]);
assert.deepStrictEqual(printersOf('nope'), []);
assert.deepStrictEqual(printersOf(null), []);

console.log('print-drive: checks passed');
