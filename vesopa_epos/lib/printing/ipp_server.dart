import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:image/image.dart' as img;

/// A printer phones can print to (Internet Printing Protocol).
///
/// iPhones and Android both speak this with no app and no driver. One server per
/// till, one printer per drive that allows it, at /ipp/print/<drive>. What
/// arrives goes straight to the printer through the till, so this keeps working
/// when the venue's internet does not.

const ippPort = 8631;

const _opPrintJob = 0x0002, _opValidateJob = 0x0004, _opCreateJob = 0x0005, _opSendDocument = 0x0006;
const _opCancelJob = 0x0008, _opGetJobAttributes = 0x0009, _opGetJobs = 0x000A, _opGetPrinterAttributes = 0x000B;

const _operationTag = 0x01, _jobTag = 0x02, _endTag = 0x03, _printerTag = 0x04;
const _integer = 0x21, _boolean = 0x22, _enum = 0x23;
const _text = 0x41, _nameTag = 0x42, _keyword = 0x44, _uri = 0x45, _uriScheme = 0x46;
const _charset = 0x47, _language = 0x48, _mime = 0x49, _resolution = 0x32;

const _ok = 0x0000, _notPossible = 0x0404, _notSupported = 0x0501, _badRequest = 0x0400, _noFormat = 0x040A;
const _idle = 3, _processing = 4;
const _jobPending = 3, _jobProcessing = 5, _jobCanceled = 7, _jobAborted = 8, _jobCompleted = 9;

/// What a request said, as far as this printer cares.
class IppRequest {
  IppRequest(this.operation, this.requestId, this.attributes, this.document);
  final int operation;
  final int requestId;
  final Map<String, Object> attributes;
  final Uint8List document;
}

/// Null if it is not a well-formed request.
IppRequest? parseIpp(Uint8List b) {
  if (b.length < 9) return null;
  final data = ByteData.sublistView(b);
  final attrs = <String, Object>{};
  var at = 8;
  var last = '';
  try {
    while (true) {
      final tag = b[at++];
      if (tag == _endTag) break;
      if (tag < 0x10) continue; // a new group
      final nameLen = data.getUint16(at);
      at += 2;
      final name = latin1.decode(b.sublist(at, at + nameLen));
      at += nameLen;
      final len = data.getUint16(at);
      at += 2;
      final value = b.sublist(at, at + len);
      at += len;
      if (name.isNotEmpty) last = name;
      if (name.isEmpty) continue; // the further values of a set
      attrs[last] = switch (tag) {
        _integer || _enum when len == 4 => ByteData.sublistView(value).getInt32(0),
        _boolean when len == 1 => value[0] == 1,
        _ => utf8.decode(value, allowMalformed: true),
      };
    }
  } on RangeError {
    return null;
  }
  return IppRequest(data.getUint16(2), data.getUint32(4), attrs, b.sublist(at));
}

class _Writer {
  final out = BytesBuilder();

  void group(int tag) => out.addByte(tag);

  void _value(int tag, String name, List<int> value) {
    final n = latin1.encode(name);
    out
      ..addByte(tag)
      ..add([n.length >> 8, n.length & 0xFF])
      ..add(n)
      ..add([value.length >> 8, value.length & 0xFF])
      ..add(value);
  }

  void string(int tag, String name, String value) => _value(tag, name, utf8.encode(value));

  void strings(int tag, String name, List<String> values) {
    for (var i = 0; i < values.length; i++) {
      string(tag, i == 0 ? name : '', values[i]);
    }
  }

  void integer(String name, int v, [int tag = _integer]) => _value(tag, name, [v >> 24 & 0xFF, v >> 16 & 0xFF, v >> 8 & 0xFF, v & 0xFF]);

  void enums(String name, List<int> values) {
    for (var i = 0; i < values.length; i++) {
      integer(i == 0 ? name : '', values[i], _enum);
    }
  }

  void boolean(String name, bool v) => _value(_boolean, name, [v ? 1 : 0]);

  void resolution(String name, int dpi) => _value(_resolution, name, [
    ...[0, 0, dpi >> 8, dpi & 0xFF],
    ...[0, 0, dpi >> 8, dpi & 0xFF],
    3,
  ]);

  void range(String name, int low, int high) => _value(0x33, name, [
    low >> 24 & 0xFF, low >> 16 & 0xFF, low >> 8 & 0xFF, low & 0xFF,
    high >> 24 & 0xFF, high >> 16 & 0xFF, high >> 8 & 0xFF, high & 0xFF,
  ]);
}

/// A document as a phone sent it, and what became of it.
class IppJob {
  IppJob(this.id, this.name, this.format);
  final int id;
  final String name;
  String format;
  int state = _jobPending;
}

/// One printer on this till. [print] does the printing; it throws if it could not.
class IppPrinter {
  IppPrinter({required this.id, required this.name, required this.uuid, required this.print});

  final int id;
  final String name;
  final String uuid;
  final Future<void> Function(String jobName, String format, Uint8List document) print;

  final Map<int, IppJob> _jobs = {};
  int _next = 1;
  int _printing = 0;

  /// The whole response to [body]. Never throws.
  Future<Uint8List> respond(Uint8List body, String uri) async {
    final req = parseIpp(body);
    if (req == null) return _head(_badRequest, 0, (_) {});
    switch (req.operation) {
      case _opGetPrinterAttributes:
        return _head(_ok, req.requestId, (w) => _printerAttributes(w, uri));
      case _opValidateJob:
        final format = '${req.attributes['document-format'] ?? 'application/octet-stream'}';
        return _head(_formats.contains(format) ? _ok : _noFormat, req.requestId, (_) {});
      case _opPrintJob:
        final job = _newJob(req);
        unawaited(_run(job, req.document));
        return _head(_ok, req.requestId, (w) => _jobAttributes(w, job, uri));
      case _opCreateJob:
        final job = _newJob(req);
        return _head(_ok, req.requestId, (w) => _jobAttributes(w, job, uri));
      case _opSendDocument:
        final job = _jobs[req.attributes['job-id']];
        if (job == null) return _head(_notPossible, req.requestId, (_) {});
        final format = req.attributes['document-format'];
        if (format is String) job.format = format;
        unawaited(_run(job, req.document));
        return _head(_ok, req.requestId, (w) => _jobAttributes(w, job, uri));
      case _opGetJobAttributes:
        final job = _jobs[req.attributes['job-id']];
        if (job == null) return _head(_notPossible, req.requestId, (_) {});
        return _head(_ok, req.requestId, (w) => _jobAttributes(w, job, uri));
      case _opGetJobs:
        return _head(_ok, req.requestId, (w) {
          for (final job in _jobs.values.where((j) => j.state < _jobCanceled)) {
            _jobAttributes(w, job, uri);
          }
        });
      case _opCancelJob:
        final job = _jobs[req.attributes['job-id']];
        if (job == null || job.state >= _jobProcessing) return _head(_notPossible, req.requestId, (_) {});
        job.state = _jobCanceled;
        return _head(_ok, req.requestId, (_) {});
      default:
        return _head(_notSupported, req.requestId, (_) {});
    }
  }

  IppJob _newJob(IppRequest req) {
    final job = IppJob(
      _next++,
      '${req.attributes['job-name'] ?? 'Document'}',
      '${req.attributes['document-format'] ?? 'application/pdf'}',
    );
    _jobs[job.id] = job;
    // Only the last few are ever asked about.
    if (_jobs.length > 50) _jobs.remove(_jobs.keys.first);
    return job;
  }

  Future<void> _run(IppJob job, Uint8List document) async {
    job.state = _jobProcessing;
    _printing++;
    try {
      await print(job.name, job.format, document);
      job.state = _jobCompleted;
    } catch (_) {
      job.state = _jobAborted;
    } finally {
      _printing--;
    }
  }

  static const _formats = ['application/pdf', 'image/urf', 'image/jpeg', 'image/png', 'application/octet-stream'];

  Uint8List _head(int status, int id, void Function(_Writer) body) {
    final w = _Writer();
    w.out.add([2, 0, status >> 8, status & 0xFF, id >> 24 & 0xFF, id >> 16 & 0xFF, id >> 8 & 0xFF, id & 0xFF]);
    w.group(_operationTag);
    w.string(_charset, 'attributes-charset', 'utf-8');
    w.string(_language, 'attributes-natural-language', 'en');
    body(w);
    w.group(_endTag);
    return w.out.takeBytes();
  }

  void _jobAttributes(_Writer w, IppJob job, String uri) {
    w.group(_jobTag);
    w.integer('job-id', job.id);
    w.string(_uri, 'job-uri', '$uri/${job.id}');
    w.integer('job-state', job.state, _enum);
    w.string(_keyword, 'job-state-reasons', job.state == _jobAborted ? 'job-completed-with-errors' : 'none');
    w.string(_nameTag, 'job-name', job.name);
  }

  void _printerAttributes(_Writer w, String uri) {
    const media = ['iso_a4_210x297mm', 'na_letter_8.5x11in', 'iso_a5_148x210mm'];
    w.group(_printerTag);
    w.string(_uri, 'printer-uri-supported', uri);
    w.string(_keyword, 'uri-security-supported', 'none');
    w.string(_keyword, 'uri-authentication-supported', 'none');
    w.string(_nameTag, 'printer-name', name);
    w.string(_text, 'printer-info', name);
    w.string(_text, 'printer-make-and-model', 'Vesopa Print');
    w.string(_uri, 'printer-uuid', 'urn:uuid:$uuid');
    w.integer('printer-state', _printing > 0 ? _processing : _idle, _enum);
    w.string(_keyword, 'printer-state-reasons', 'none');
    w.boolean('printer-is-accepting-jobs', true);
    w.integer('queued-job-count', _printing);
    w.integer('printer-up-time', DateTime.now().millisecondsSinceEpoch ~/ 1000);
    w.strings(_keyword, 'ipp-versions-supported', ['1.1', '2.0']);
    w.enums('operations-supported', [
      _opPrintJob, _opValidateJob, _opCreateJob, _opSendDocument,
      _opCancelJob, _opGetJobAttributes, _opGetJobs, _opGetPrinterAttributes,
    ]);
    w.string(_charset, 'charset-configured', 'utf-8');
    w.string(_charset, 'charset-supported', 'utf-8');
    w.string(_language, 'natural-language-configured', 'en');
    w.string(_language, 'generated-natural-language-supported', 'en');
    w.string(_mime, 'document-format-default', 'application/pdf');
    w.strings(_mime, 'document-format-supported', _formats);
    w.strings(_keyword, 'urf-supported', ['CP1', 'MT1', 'RS300', 'SRGB24', 'W8', 'DM1', 'IS1']);
    w.string(_keyword, 'compression-supported', 'none');
    w.string(_keyword, 'pdl-override-supported', 'attempted');
    w.string(_uriScheme, 'reference-uri-schemes-supported', 'http');
    w.integer('copies-default', 1);
    w.range('copies-supported', 1, 1);
    w.string(_keyword, 'media-default', media.first);
    w.strings(_keyword, 'media-supported', media);
    w.strings(_keyword, 'media-ready', media);
    w.string(_keyword, 'sides-default', 'one-sided');
    w.string(_keyword, 'sides-supported', 'one-sided');
    w.string(_keyword, 'print-color-mode-default', 'auto');
    w.strings(_keyword, 'print-color-mode-supported', ['auto', 'monochrome', 'color']);
    w.string(_keyword, 'output-bin-default', 'face-up');
    w.string(_keyword, 'output-bin-supported', 'face-up');
    w.integer('print-quality-default', 4, _enum);
    w.enums('print-quality-supported', [4]);
    w.resolution('printer-resolution-default', 300);
    w.resolution('printer-resolution-supported', 300);
    w.enums('finishings-supported', [3]);
    w.integer('finishings-default', 3, _enum);
  }
}

/// Apple's raster format, which an iPhone may send instead of a PDF. One PNG a
/// page. Throws [FormatException] on anything else.
List<Uint8List> urfToPngs(Uint8List b) {
  if (b.length < 12 || latin1.decode(b.sublist(0, 7)) != 'UNIRAST') {
    throw const FormatException('Not a UNIRAST document');
  }
  final data = ByteData.sublistView(b);
  final pages = data.getUint32(8);
  final out = <Uint8List>[];
  var at = 12;
  for (var page = 0; page < pages || (pages == 0 && at < b.length); page++) {
    if (at + 32 > b.length) break;
    final bits = b[at];
    final width = data.getUint32(at + 12);
    final height = data.getUint32(at + 16);
    at += 32;
    final bytes = bits ~/ 8;
    if (bytes != 1 && bytes != 3 || width == 0 || width > 20000 || height > 30000) {
      throw const FormatException('Unsupported raster page');
    }
    final image = img.Image(width: width, height: height);
    void put(int x, int y, List<int> px) {
      if (bytes == 1) {
        image.setPixelRgb(x, y, px[0], px[0], px[0]);
      } else {
        image.setPixelRgb(x, y, px[0], px[1], px[2]);
      }
    }

    var y = 0;
    while (y < height) {
      final repeat = b[at++] + 1;
      final line = List<List<int>>.filled(width, const [255, 255, 255]);
      var x = 0;
      while (x < width) {
        final code = b[at++];
        if (code == 128) {
          break; // the rest of the line is white
        } else if (code < 128) {
          final px = b.sublist(at, at + bytes);
          at += bytes;
          for (var i = 0; i <= code && x < width; i++) {
            line[x++] = px;
          }
        } else {
          for (var i = 0; i < 257 - code && x < width; i++) {
            line[x++] = b.sublist(at, at + bytes);
            at += bytes;
          }
        }
      }
      for (var r = 0; r < repeat && y < height; r++, y++) {
        for (var px = 0; px < width; px++) {
          put(px, y, line[px]);
        }
      }
    }
    out.add(img.encodePng(image));
  }
  return out;
}

/// The till's one IPP server. Printers come and go as the back office says.
class IppServer {
  HttpServer? _server;
  Map<int, IppPrinter> printers = const {};

  Future<void> update(Map<int, IppPrinter> next) async {
    printers = next;
    if (next.isEmpty) return stop();
    try {
      _server ??= await _open();
    } catch (_) {
      // The port is taken: the drive's link still works.
    }
  }

  Future<HttpServer> _open() async {
    final s = await HttpServer.bind(InternetAddress.anyIPv4, ippPort, shared: true);
    s.listen(_handle, onError: (_) {});
    return s;
  }

  Future<void> _handle(HttpRequest r) async {
    try {
      final match = RegExp(r'^/ipp/print/(\d+)$').firstMatch(r.uri.path);
      final printer = match == null ? null : printers[int.parse(match.group(1)!)];
      if (printer == null || r.method != 'POST') {
        r.response.statusCode = HttpStatus.notFound;
        return;
      }
      final body = BytesBuilder(copy: false);
      await for (final chunk in r) {
        body.add(chunk);
        if (body.length > 50 * 1024 * 1024) {
          r.response.statusCode = HttpStatus.requestEntityTooLarge;
          return;
        }
      }
      final host = r.headers.host ?? 'localhost';
      final answer = await printer.respond(body.takeBytes(), 'ipp://$host:$ippPort${r.uri.path}');
      r.response.headers.contentType = ContentType('application', 'ipp');
      r.response.add(answer);
    } catch (_) {
      r.response.statusCode = HttpStatus.internalServerError;
    } finally {
      await r.response.close();
    }
  }

  Future<void> stop() async {
    await _server?.close(force: true);
    _server = null;
  }
}
