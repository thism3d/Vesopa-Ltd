/**
 * Printing to a drive over the internet (src/ipp.js).
 */
'use strict';

const assert = require('assert');
const ipp = require('../src/ipp');

function request(op, { attrs = {}, jobId, doc = Buffer.alloc(0) } = {}) {
  const parts = [Buffer.from([2, 0, op >> 8, op & 0xff, 0, 0, 0, 7, 0x01])];
  const put = (tag, name, value) => {
    parts.push(Buffer.from([tag, 0, name.length]), Buffer.from(name, 'latin1'), Buffer.from([0, value.length]), value);
  };
  put(0x47, 'attributes-charset', Buffer.from('utf-8'));
  for (const [k, v] of Object.entries(attrs)) put(0x49, k, Buffer.from(v));
  if (jobId) put(0x21, 'job-id', Buffer.from([0, 0, 0, jobId]));
  parts.push(Buffer.from([0x03]), doc);
  return Buffer.concat(parts);
}

const printer = { name: 'Vesopa Office', uri: 'ipps://x/ipp/print/abc', uuid: 'u', secure: true };
const status = (r) => r.readUInt16BE(2);

(async () => {
  const parsed = ipp.parse(request(ipp.OP.printJob, { attrs: { 'document-format': 'application/pdf' }, doc: Buffer.from('%PDF') }));
  assert.strictEqual(parsed.operation, ipp.OP.printJob);
  assert.strictEqual(parsed.attributes['document-format'], 'application/pdf');
  assert.strictEqual(parsed.document.toString(), '%PDF');
  assert.strictEqual(ipp.parse(Buffer.from([1, 2])), null);
  assert.strictEqual(ipp.parse(Buffer.alloc(40, 0xff)), null, 'rubbish is not a request');

  // What a phone looks for before it will use a printer.
  const about = await ipp.respond(request(ipp.OP.getPrinterAttributes), printer, {}, async () => {});
  assert.strictEqual(status(about), 0);
  const text = about.toString('latin1');
  for (const must of ['printer-uri-supported', 'document-format-supported', 'image/urf', 'urf-supported', 'media-supported', 'operations-supported', 'tls']) {
    assert.ok(text.includes(must), must);
  }

  // Print-Job saves to the drive.
  const saved = [];
  const save = async (bytes, name) => { saved.push({ bytes, name }); };
  let r = await ipp.respond(request(ipp.OP.printJob, { attrs: { 'job-name': 'Menu' }, doc: Buffer.from('%PDF-1') }), printer, {}, save);
  assert.strictEqual(status(r), 0);
  assert.strictEqual(saved[0].name, 'Menu');
  assert.strictEqual(saved[0].bytes.toString(), '%PDF-1');

  // Create then send, the way an iPhone does it.
  const jobs = {};
  await ipp.respond(request(ipp.OP.createJob, { attrs: { 'job-name': 'Letter' } }), printer, jobs, save);
  r = await ipp.respond(request(ipp.OP.sendDocument, { jobId: 1, doc: Buffer.from('%PDF-2') }), printer, jobs, save);
  assert.strictEqual(status(r), 0);
  assert.strictEqual(saved[1].name, 'Letter');
  assert.strictEqual(jobs[1].state, 9);

  // A document the drive refuses comes back as refused, and shows as such.
  const refuse = async () => { throw Object.assign(new Error('no'), { status: 415 }); };
  r = await ipp.respond(request(ipp.OP.printJob, { doc: Buffer.from('<html>') }), printer, {}, refuse);
  assert.strictEqual(status(r), 0x040a);

  // A real fault is not quietly called a refusal.
  await assert.rejects(ipp.respond(request(ipp.OP.printJob), printer, {}, async () => { throw new Error('disk'); }), /disk/);

  assert.strictEqual(status(await ipp.respond(request(ipp.OP.sendDocument, { jobId: 9 }), printer, {}, save)), 0x0404);
  assert.strictEqual(status(await ipp.respond(request(0x7777), printer, {}, save)), 0x0501);
  assert.strictEqual(status(await ipp.respond(Buffer.from([1]), printer, {}, save)), 0x0400);

  assert.strictEqual(ipp.uuidFor('a'), ipp.uuidFor('a'));
  assert.notStrictEqual(ipp.uuidFor('a'), ipp.uuidFor('b'));
  assert.match(ipp.uuidFor('a'), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);

  const profile = ipp.airPrintProfile({ name: 'Vesopa <Office>', host: 'x.example', path: 'ipp/print/abc', seed: 's' });
  assert.ok(profile.includes('com.apple.airprint'));
  assert.ok(profile.includes('<key>ForceTLS</key><true/>'));
  assert.ok(profile.includes('<string>ipp/print/abc</string>'));
  assert.ok(profile.includes('Vesopa &lt;Office&gt;'), 'names are escaped');

  console.log('ipp: checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
