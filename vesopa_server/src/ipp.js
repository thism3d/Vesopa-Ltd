/**
 * The Internet Printing Protocol, as much as a phone needs to print to a drive
 * over the internet (src/print_drive.js).
 *
 * Phones cannot discover a printer across the internet, but once told its
 * address an iPhone prints to it from anywhere. That address is this server, so
 * a document goes phone, drive, till, paper. The same conversation the till has
 * on the venue's own network (vesopa_epos/lib/printing/ipp_server.dart).
 */
'use strict';

const OP = {
  printJob: 0x0002, validateJob: 0x0004, createJob: 0x0005, sendDocument: 0x0006,
  cancelJob: 0x0008, getJobAttributes: 0x0009, getJobs: 0x000a, getPrinterAttributes: 0x000b,
};
const STATUS = { ok: 0x0000, badRequest: 0x0400, notPossible: 0x0404, formatNotSupported: 0x040a, notSupported: 0x0501 };
const FORMATS = ['application/pdf', 'image/urf', 'image/jpeg', 'image/png'];
const MEDIA = ['iso_a4_210x297mm', 'na_letter_8.5x11in', 'iso_a5_148x210mm'];

/** What a request says, or null if it is not one. */
function parse(body) {
  if (!Buffer.isBuffer(body) || body.length < 9) return null;
  const attributes = {};
  let at = 8;
  try {
    for (;;) {
      if (at >= body.length) return null;
      const tag = body[at++];
      if (tag === 0x03) break;
      if (tag < 0x10) continue; // a new group
      const nameLength = body.readUInt16BE(at);
      at += 2;
      const name = body.toString('latin1', at, at + nameLength);
      at += nameLength;
      const length = body.readUInt16BE(at);
      at += 2;
      if (at + length > body.length) return null;
      if (name) {
        attributes[name] = (tag === 0x21 || tag === 0x23) && length === 4
          ? body.readInt32BE(at)
          : body.toString('utf8', at, at + length);
      }
      at += length;
    }
  } catch {
    return null;
  }
  return { operation: body.readUInt16BE(2), requestId: body.readUInt32BE(4), attributes, document: body.subarray(at) };
}

function writer(status, requestId) {
  const parts = [];
  const head = Buffer.alloc(8);
  head[0] = 2;
  head.writeUInt16BE(status, 2);
  head.writeUInt32BE(requestId >>> 0, 4);
  parts.push(head);
  const put = (tag, name, value) => {
    const n = Buffer.from(name, 'latin1');
    const v = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
    const lengths = Buffer.alloc(2);
    lengths.writeUInt16BE(n.length);
    const valueLength = Buffer.alloc(2);
    valueLength.writeUInt16BE(v.length);
    parts.push(Buffer.from([tag]), lengths, n, valueLength, v);
  };
  const int = (n) => {
    const b = Buffer.alloc(4);
    b.writeInt32BE(n);
    return b;
  };
  const w = {
    group: (tag) => parts.push(Buffer.from([tag])),
    string: (tag, name, value) => put(tag, name, value),
    strings: (tag, name, values) => values.forEach((v, i) => put(tag, i ? '' : name, v)),
    integer: (name, n) => put(0x21, name, int(n)),
    enums: (name, values) => values.forEach((v, i) => put(0x23, i ? '' : name, int(v))),
    boolean: (name, on) => put(0x22, name, Buffer.from([on ? 1 : 0])),
    range: (name, low, high) => put(0x33, name, Buffer.concat([int(low), int(high)])),
    resolution: (name, dpi) => put(0x32, name, Buffer.concat([int(dpi), int(dpi), Buffer.from([3])])),
    done: () => {
      parts.push(Buffer.from([0x03]));
      return Buffer.concat(parts);
    },
  };
  w.group(0x01);
  w.string(0x47, 'attributes-charset', 'utf-8');
  w.string(0x48, 'attributes-natural-language', 'en');
  return w;
}

function printerAttributes(w, { name, uri, uuid, secure }) {
  w.group(0x04);
  w.string(0x45, 'printer-uri-supported', uri);
  w.string(0x44, 'uri-security-supported', secure ? 'tls' : 'none');
  w.string(0x44, 'uri-authentication-supported', 'none');
  w.string(0x42, 'printer-name', name);
  w.string(0x41, 'printer-info', name);
  w.string(0x41, 'printer-make-and-model', 'Vesopa Print');
  w.string(0x45, 'printer-uuid', `urn:uuid:${uuid}`);
  w.enums('printer-state', [3]);
  w.string(0x44, 'printer-state-reasons', 'none');
  w.boolean('printer-is-accepting-jobs', true);
  w.integer('queued-job-count', 0);
  w.integer('printer-up-time', Math.floor(Date.now() / 1000) % 2147483647);
  w.strings(0x44, 'ipp-versions-supported', ['1.1', '2.0']);
  w.enums('operations-supported', Object.values(OP));
  w.string(0x47, 'charset-configured', 'utf-8');
  w.string(0x47, 'charset-supported', 'utf-8');
  w.string(0x48, 'natural-language-configured', 'en');
  w.string(0x48, 'generated-natural-language-supported', 'en');
  w.string(0x49, 'document-format-default', 'application/pdf');
  w.strings(0x49, 'document-format-supported', FORMATS);
  w.strings(0x44, 'urf-supported', ['CP1', 'MT1', 'RS300', 'SRGB24', 'W8', 'DM1', 'IS1']);
  w.string(0x44, 'compression-supported', 'none');
  w.string(0x44, 'pdl-override-supported', 'attempted');
  w.integer('copies-default', 1);
  w.range('copies-supported', 1, 1);
  w.string(0x44, 'media-default', MEDIA[0]);
  w.strings(0x44, 'media-supported', MEDIA);
  w.strings(0x44, 'media-ready', MEDIA);
  w.string(0x44, 'sides-default', 'one-sided');
  w.string(0x44, 'sides-supported', 'one-sided');
  w.string(0x44, 'print-color-mode-default', 'auto');
  w.strings(0x44, 'print-color-mode-supported', ['auto', 'monochrome', 'color']);
  w.string(0x44, 'output-bin-default', 'face-up');
  w.string(0x44, 'output-bin-supported', 'face-up');
  w.enums('print-quality-default', [4]);
  w.enums('print-quality-supported', [4]);
  w.resolution('printer-resolution-default', 300);
  w.resolution('printer-resolution-supported', 300);
  w.enums('finishings-supported', [3]);
  w.enums('finishings-default', [3]);
}

function jobAttributes(w, job, uri) {
  w.group(0x02);
  w.integer('job-id', job.id);
  w.string(0x45, 'job-uri', `${uri}/${job.id}`);
  w.enums('job-state', [job.state]);
  w.string(0x44, 'job-state-reasons', job.state === 8 ? 'job-completed-with-errors' : 'none');
  w.string(0x42, 'job-name', job.name);
}

/**
 * Answer one request for one printer. `save(bytes, name)` puts a document in the
 * drive and throws { status: 415 } if it is not one we print. A document is
 * "completed" for the phone once it is safely in the drive: what the printer
 * does with it shows in the drive's history.
 */
async function respond(body, printer, jobs, save) {
  const req = parse(body);
  if (!req) return writer(STATUS.badRequest, 0).done();
  const id = req.requestId;
  const { uri } = printer;
  const nextId = () => {
    const n = (jobs.next || 1);
    jobs.next = n + 1;
    return n;
  };
  const accept = async (job, document) => {
    try {
      await save(document, job.name);
      job.state = 9;
      return true;
    } catch (e) {
      if (e.status === 415) {
        job.state = 8;
        return false;
      }
      throw e;
    }
  };
  switch (req.operation) {
    case OP.getPrinterAttributes: {
      const w = writer(STATUS.ok, id);
      printerAttributes(w, printer);
      return w.done();
    }
    case OP.validateJob: {
      const format = req.attributes['document-format'];
      return writer(!format || format === 'application/octet-stream' || FORMATS.includes(format)
        ? STATUS.ok : STATUS.formatNotSupported, id).done();
    }
    case OP.printJob: {
      const job = { id: nextId(), name: String(req.attributes['job-name'] || 'Document'), state: 5 };
      jobs[job.id] = job;
      const fine = await accept(job, req.document);
      const w = writer(fine ? STATUS.ok : STATUS.formatNotSupported, id);
      jobAttributes(w, job, uri);
      return w.done();
    }
    case OP.createJob: {
      const job = { id: nextId(), name: String(req.attributes['job-name'] || 'Document'), state: 3 };
      jobs[job.id] = job;
      const w = writer(STATUS.ok, id);
      jobAttributes(w, job, uri);
      return w.done();
    }
    case OP.sendDocument: {
      const job = jobs[req.attributes['job-id']];
      if (!job) return writer(STATUS.notPossible, id).done();
      const fine = await accept(job, req.document);
      const w = writer(fine ? STATUS.ok : STATUS.formatNotSupported, id);
      jobAttributes(w, job, uri);
      return w.done();
    }
    case OP.getJobAttributes: {
      const job = jobs[req.attributes['job-id']];
      if (!job) return writer(STATUS.notPossible, id).done();
      const w = writer(STATUS.ok, id);
      jobAttributes(w, job, uri);
      return w.done();
    }
    case OP.getJobs:
      return writer(STATUS.ok, id).done();
    case OP.cancelJob: {
      const job = jobs[req.attributes['job-id']];
      if (!job || job.state >= 5) return writer(STATUS.notPossible, id).done();
      job.state = 7;
      return writer(STATUS.ok, id).done();
    }
    default:
      return writer(STATUS.notSupported, id).done();
  }
}

/** A UUID that is always the same for one code, so a phone keeps one printer. */
function uuidFor(seed) {
  const h = require('crypto').createHash('sha256').update(String(seed)).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** The profile that puts a drive in an iPhone's Print menu, wherever it is. */
function airPrintProfile({ name, host, path, seed }) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>PayloadContent</key><array><dict>
<key>AirPrint</key><array><dict>
<key>ForceTLS</key><true/>
<key>IPAddress</key><string>${esc(host)}</string>
<key>Port</key><integer>443</integer>
<key>ResourcePath</key><string>${esc(path)}</string>
</dict></array>
<key>PayloadDisplayName</key><string>${esc(name)}</string>
<key>PayloadIdentifier</key><string>com.vesopa.print.${uuidFor(`${seed}a`)}</string>
<key>PayloadType</key><string>com.apple.airprint</string>
<key>PayloadUUID</key><string>${uuidFor(`${seed}a`).toUpperCase()}</string>
<key>PayloadVersion</key><integer>1</integer>
</dict></array>
<key>PayloadDisplayName</key><string>${esc(name)}</string>
<key>PayloadDescription</key><string>Adds ${esc(name)} to the Print menu on this device.</string>
<key>PayloadIdentifier</key><string>com.vesopa.print.${uuidFor(seed)}</string>
<key>PayloadOrganization</key><string>Vesopa Software Ltd</string>
<key>PayloadRemovalDisallowed</key><false/>
<key>PayloadType</key><string>Configuration</string>
<key>PayloadUUID</key><string>${uuidFor(seed).toUpperCase()}</string>
<key>PayloadVersion</key><integer>1</integer>
</dict></plist>
`;
}

module.exports = { parse, respond, uuidFor, airPrintProfile, OP, FORMATS };
