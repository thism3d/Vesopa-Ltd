import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:image/image.dart' as img;
import 'package:vesopa_epos/printing/ipp_server.dart';
import 'package:vesopa_epos/printing/mdns_responder.dart';

/// What a phone sends: operation, then attributes, then the document.
Uint8List request(int op, {Map<String, String> attrs = const {}, int? jobId, List<int> doc = const []}) {
  final b = BytesBuilder()
    ..add([2, 0, op >> 8, op & 0xFF, 0, 0, 0, 7])
    ..addByte(0x01);
  void attr(int tag, String name, List<int> value) {
    b
      ..addByte(tag)
      ..add([0, name.length])
      ..add(latin1.encode(name))
      ..add([0, value.length])
      ..add(value);
  }

  attr(0x47, 'attributes-charset', utf8.encode('utf-8'));
  attrs.forEach((k, v) => attr(0x49, k, utf8.encode(v)));
  if (jobId != null) attr(0x21, 'job-id', [0, 0, 0, jobId]);
  b
    ..addByte(0x03)
    ..add(doc);
  return b.takeBytes();
}

int status(Uint8List r) => r[2] << 8 | r[3];

/// A plain mDNS question.
Uint8List question(String name, int type) {
  final b = BytesBuilder()..add([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
  for (final label in name.split('.')) {
    b
      ..addByte(label.length)
      ..add(utf8.encode(label));
  }
  b
    ..addByte(0)
    ..add([0, type, 0, 1]);
  return b.takeBytes();
}

void main() {
  IppPrinter printer(List<(String, Uint8List)> got, {bool fail = false}) => IppPrinter(
    id: 3,
    name: 'Vesopa Office',
    uuid: 'abc',
    print: (name, format, doc) async {
      if (fail) throw StateError('Out of paper');
      got.add((format, doc));
    },
  );

  group('printer', () {
    test('a phone asking what it is gets the things it looks for', () async {
      final r = await printer([]).respond(request(0x000B), 'ipp://t:8631/ipp/print/3');
      expect(status(r), 0);
      final text = latin1.decode(r);
      for (final must in [
        'printer-uri-supported', 'document-format-supported', 'application/pdf', 'image/urf',
        'urf-supported', 'media-supported', 'printer-is-accepting-jobs', 'operations-supported', 'printer-state',
      ]) {
        expect(text, contains(must));
      }
      expect(r.last, 0x03);
    });

    test('a document prints', () async {
      final got = <(String, Uint8List)>[];
      final r = await printer(got).respond(
        request(0x0002, attrs: {'document-format': 'application/pdf'}, doc: utf8.encode('%PDF')),
        'ipp://t',
      );
      expect(status(r), 0);
      await Future<void>.delayed(Duration.zero);
      expect(got.single.$1, 'application/pdf');
      expect(utf8.decode(got.single.$2), '%PDF');
    });

    test('create then send, the way an iPhone does it', () async {
      final got = <(String, Uint8List)>[];
      final p = printer(got);
      await p.respond(request(0x0005), 'ipp://t');
      final r = await p.respond(
        request(0x0006, jobId: 1, attrs: {'document-format': 'image/jpeg'}, doc: [1, 2]),
        'ipp://t',
      );
      expect(status(r), 0);
      await Future<void>.delayed(Duration.zero);
      expect(got.single.$1, 'image/jpeg');
    });

    test('a failed print shows as aborted when the phone asks', () async {
      final p = printer([], fail: true);
      await p.respond(request(0x0002, doc: [1]), 'ipp://t');
      await Future<void>.delayed(Duration.zero);
      final r = await p.respond(request(0x0009, jobId: 1), 'ipp://t');
      // job-state, enum 8.
      final at = latin1.decode(r).indexOf('job-state') + 'job-state'.length;
      expect(r[at + 5], 8);
    });

    test('rubbish does not throw', () async {
      expect(status(await printer([]).respond(Uint8List.fromList([1, 2]), 'x')), 0x0400);
      expect(status(await printer([]).respond(request(0x7777), 'x')), 0x0501);
    });
  });

  group('network', () {
    const p = AnnouncedPrinter(
      name: 'Vesopa Office',
      port: ippPort,
      path: 'ipp/print/3',
      txt: {'rp': 'ipp/print/3', 'URF': 'W8', 'pdl': 'application/pdf'},
    );

    test('the questions phones ask are recognised', () {
      for (final q in [serviceType, universalType, browseType]) {
        expect(asksForPrinters(parseQuestions(question(q, 12)), [p], 'till.local'), isTrue, reason: q);
      }
      expect(asksForPrinters(parseQuestions(question('_http._tcp.local', 12)), [p], 'till.local'), isFalse);
    });

    test('an answer is not taken for a question', () {
      expect(parseQuestions(buildAnswer([p], 'till.local', ['192.168.1.5'])), isEmpty);
    });

    test('a broken packet is ignored', () {
      expect(parseQuestions(Uint8List.fromList([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 200])), isEmpty);
    });

    test('the answer names the printer, its port, path and address', () {
      final a = buildAnswer([p], 'till.local', ['192.168.1.5']);
      expect(a[2], 0x84);
      expect(a[7], 6, reason: 'five for the printer and one address');
      final text = latin1.decode(a);
      expect(text, contains('Vesopa Office'));
      expect(text, contains('rp=ipp/print/3'));
      expect(text, contains('_universal'));
      expect(a.sublist(a.length - 4), [192, 168, 1, 5]);
    });

    test('what iPhones insist on is in the record', () {
      final txt = airPrintTxt(name: 'Office', path: 'ipp/print/3', id: 'x');
      for (final key in ['rp', 'pdl', 'URF', 'ty', 'txtvers', 'qtotal']) {
        expect(txt[key], isNotNull, reason: key);
      }
      expect(txt['pdl'], contains('image/urf'));
    });
  });

  group('Apple raster', () {
    Uint8List urf(List<int> page, {int width = 2, int height = 2}) {
      final head = ByteData(32)
        ..setUint8(0, 24)
        ..setUint32(12, width)
        ..setUint32(16, height)
        ..setUint32(20, 300);
      return Uint8List.fromList([
        ...latin1.encode('UNIRAST'), 0,
        0, 0, 0, 1,
        ...head.buffer.asUint8List(),
        ...page,
      ]);
    }

    test('a repeated line of one colour', () {
      // Line repeated twice; two pixels of red.
      final pngs = urfToPngs(urf([1, 1, 255, 0, 0]));
      final image = img.decodePng(pngs.single)!;
      expect(image.width, 2);
      expect(image.getPixel(1, 1).r, 255);
      expect(image.getPixel(1, 1).g, 0);
    });

    test('128 leaves the rest of the line white', () {
      final pngs = urfToPngs(urf([1, 0, 0, 0, 0, 128]));
      final image = img.decodePng(pngs.single)!;
      expect(image.getPixel(0, 0).r, 0);
      expect(image.getPixel(1, 0).r, 255);
    });

    test('literal pixels', () {
      // 255 = 257 - 255 = two literal pixels.
      final pngs = urfToPngs(urf([1, 255, 10, 10, 10, 20, 20, 20]));
      final image = img.decodePng(pngs.single)!;
      expect(image.getPixel(0, 0).r, 10);
      expect(image.getPixel(1, 0).r, 20);
    });

    test('anything else is refused', () {
      expect(() => urfToPngs(Uint8List.fromList(utf8.encode('%PDF-1.7 and more'))), throwsFormatException);
    });
  });

  test('a real phone-style request over the network reaches the printer', () async {
    final got = <(String, Uint8List)>[];
    final server = IppServer();
    await server.update({3: printer(got)});
    final client = HttpClient();
    try {
      final req = await client.post('127.0.0.1', ippPort, '/ipp/print/3');
      req.headers.contentType = ContentType('application', 'ipp');
      req.add(request(0x0002, attrs: {'document-format': 'application/pdf'}, doc: utf8.encode('%PDF')));
      final res = await req.close();
      final bytes = BytesBuilder();
      await res.forEach(bytes.add);
      expect(res.statusCode, 200);
      expect(status(bytes.takeBytes()), 0);
      await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(got, hasLength(1));

      final missing = await (await client.post('127.0.0.1', ippPort, '/ipp/print/99')).close();
      expect(missing.statusCode, 404);
    } finally {
      client.close(force: true);
      await server.stop();
    }
  });
}
