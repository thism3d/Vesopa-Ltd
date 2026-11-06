import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:vesopa_epos/printing/print_drive_connector.dart';
import 'package:vesopa_epos/printing/printer_transport.dart';

const _printer = PrinterConfig(id: 'p1', name: 'Office', kind: PrinterKind.windowsQueue);

/// A little server: one waiting job, remembers what it was told.
MockClient _server(List<Map<String, dynamic>> told, {int fileStatus = 200, List<String>? asked}) =>
    MockClient((req) async {
      asked?.add(req.url.path);
      if (req.url.path == '/api/device/print-drives') return http.Response('{"drives":[]}', 200);
      if (req.url.path == '/api/device/print-jobs') {
        return http.Response(jsonEncode({'jobs': [{'id': 'j1', 'mime': 'application/pdf', 'printer_id': 'p1'}]}), 200);
      }
      if (req.url.path.endsWith('/file')) return http.Response.bytes(utf8.encode('%PDF'), fileStatus);
      told.add(jsonDecode(req.body) as Map<String, dynamic>);
      return http.Response('{}', 200);
    });

PrintDriveConnector _connector(http.Client client, {List<PrinterConfig> printers = const [_printer], Future<void> Function(PrinterConfig, Uint8List)? print}) =>
    PrintDriveConnector(
      apiBase: 'https://x',
      token: 't',
      deviceId: 'd',
      printers: () async => printers,
      client: client,
      printPage: print ?? (_, _) async {},
    );

void main() {
  test('a job prints and the back office is told', () async {
    final told = <Map<String, dynamic>>[];
    Uint8List? printed;
    await _connector(_server(told), print: (_, pdf) async => printed = pdf).round();
    expect(printed, isNotNull);
    expect(told.single['printed'], isTrue);
  });

  test('a failure finding phone printers does not stop documents printing', () async {
    final told = <Map<String, dynamic>>[];
    final client = MockClient((req) async {
      if (req.url.path == '/api/device/print-drives') throw http.ClientException('no');
      return _server(told).send(http.Request(req.method, req.url)..bodyBytes = req.bodyBytes).then(http.Response.fromStream);
    });
    var printed = false;
    await _connector(client, print: (_, _) async => printed = true).round();
    expect(printed, isTrue);
  });

  test('a failed print is reported with the reason', () async {
    final told = <Map<String, dynamic>>[];
    await _connector(_server(told), print: (_, _) async => throw StateError('Out of paper')).round();
    expect(told.single['printed'], isFalse);
    expect(told.single['error'], contains('Out of paper'));
  });

  test('a printer the till no longer has is a failure, not a silent loss', () async {
    final told = <Map<String, dynamic>>[];
    await _connector(_server(told), printers: const []).round();
    expect(told.single['printed'], isFalse);
  });

  test('a job somebody else took is left alone and nothing prints', () async {
    final told = <Map<String, dynamic>>[];
    var printed = false;
    await _connector(_server(told, fileStatus: 409), print: (_, _) async => printed = true).round();
    expect(printed, isFalse);
    expect(told, isEmpty);
  });

  test('offline does nothing and does not throw', () async {
    final client = MockClient((_) async => throw http.ClientException('offline'));
    await _connector(client).round();
  });

  test('a page becomes a one-bit picture at the paper width', () {
    // 2 x 1: a black pixel and a clear one.
    final rgba = Uint8List.fromList([0, 0, 0, 255, 0, 0, 0, 0]);
    final out = pageToEscPos(rgba, 2, 1, 8);
    expect(out.sublist(0, 4), [0x1D, 0x76, 0x30, 0x00]);
    expect(out[4], 1, reason: 'one byte across for eight dots');
    expect(out.length, 8 + out[6] * 1);
    // Left half printed, right half (clear) not.
    expect(out[8] & 0x80, isNot(0));
    expect(out[8] & 0x01, 0);
  });

  test('a narrow roll has fewer dots', () {
    expect(dotsFor(58), 384);
    expect(dotsFor(80), 576);
  });
}
