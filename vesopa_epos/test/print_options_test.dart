import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/data/session_repository.dart';
import 'package:vesopa_epos/printing/printer_transport.dart';
import 'package:vesopa_epos/printing/receipt_builder.dart';

/// Print modes and the network send (2026-10-08, Pontardawe's Xprinter: "the
/// paper is not cutting and no Z report, it's just blank").
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  bool endsWith(List<int> bytes, List<int> tail) =>
      bytes.length >= tail.length &&
      _listEq(bytes.sublist(bytes.length - tail.length), tail);

  setUp(() => VenuePrintDefaults.current = const VenuePrintDefaults());

  group('Standard follows the venue', () {
    test('a new printer is on Standard: full cut after five lines', () {
      final r = PrintOptions.standard.resolve();
      expect(r.cut, CutStyle.full);
      expect(r.finish(), [0x1B, 0x64, 5, 0x1D, 0x56, 0]);
    });

    test('the back office choice reaches every Standard printer', () {
      VenuePrintDefaults.current = VenuePrintDefaults.fromJson({
        'print_cut': 'partial',
        'print_feed_lines': 3,
        'kitchen_beep': 1,
      });
      final r = PrintOptions.standard.resolve();
      expect(r.finish(), [0x1B, 0x64, 3, 0x1D, 0x56, 1]);
      expect(r.kitchenBeep, isTrue);
    });

    test('a Custom printer keeps its own settings whatever the venue says', () {
      VenuePrintDefaults.current = const VenuePrintDefaults(cut: CutStyle.partial);
      const mine = PrintOptions(
        custom: true,
        cut: CutStyle.full,
        feedLines: 8,
        cutCommand: CutCommand.feedAndCut,
      );
      expect(mine.resolve().finish(), [0x1B, 0x64, 8, 0x1D, 0x56, 65, 0]);
    });

    test('No cut feeds and does not cut', () {
      const none = PrintOptions(custom: true, cut: CutStyle.none, feedLines: 4);
      expect(none.resolve().finish(), [0x1B, 0x64, 4]);
    });

    test('options survive the trip through saved settings', () {
      const p = PrinterConfig(
        id: 'a',
        name: 'Bar',
        kind: PrinterKind.network,
        host: '10.0.0.9',
        options: PrintOptions(custom: true, cut: CutStyle.partial, gentle: true, openDrawerPin: 1),
      );
      final back = PrinterConfig.fromJson(p.toJson());
      expect(back.options.custom, isTrue);
      expect(back.options.cut, CutStyle.partial);
      expect(back.options.gentle, isTrue);
      expect(back.options.openDrawerPin, 1);
    });

    test('a printer saved before print modes existed is Standard', () {
      final old = PrinterConfig.fromJson({'id': 'x', 'name': 'Old', 'kind': 'usb'});
      expect(old.options.custom, isFalse);
    });
  });

  group('documents end with the printer\'s own cut', () {
    test('the Z report ends with the cut, every time', () async {
      final b = await ReceiptBuilder.forPrinter(
        const PrinterConfig(
          id: 'z',
          name: 'Counter',
          kind: PrinterKind.network,
          host: 'x',
          options: PrintOptions(custom: true, cut: CutStyle.partial, feedLines: 6),
        ),
      );
      final bytes = b.tillReport(_report(), shopName: 'Pontardawe RFC');
      expect(endsWith(bytes, [0x1B, 0x64, 6, 0x1D, 0x56, 1]), isTrue);
    });

    test('the test slip says it arrived in full', () async {
      const p = PrinterConfig(id: 't', name: 'T', kind: PrinterKind.network, host: 'x');
      final b = await ReceiptBuilder.forPrinter(p);
      final text = String.fromCharCodes(b.testSlip(p));
      expect(text, contains('END OF TEST'));
      expect(text, contains('Standard'));
    });
  });

  group('the network send delivers everything before letting go', () {
    test('a slow printer that talks back still gets the whole job', () async {
      final server = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
      final received = <int>[];
      final done = Completer<void>();
      server.listen((client) {
        // Like a real printer: say something on connect, then read slowly.
        client.add([0x12]);
        late StreamSubscription<List<int>> sub;
        sub = client.listen((chunk) async {
          sub.pause();
          received.addAll(chunk);
          await Future<void>.delayed(const Duration(milliseconds: 20));
          sub.resume();
        }, onDone: () {
          client.destroy();
          done.complete();
        });
      });

      final job = List<int>.generate(20000, (i) => i % 251);
      await PrinterTransport.of(
        PrinterConfig(
          id: 'n',
          name: 'Net',
          kind: PrinterKind.network,
          host: '127.0.0.1',
          port: server.port,
        ),
      ).send(job);
      await done.future.timeout(const Duration(seconds: 10));
      await server.close();
      expect(received.length, job.length);
      expect(received.last, job.last);
    });

    test('sending gently arrives whole as well', () async {
      final server = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
      final received = <int>[];
      final done = Completer<void>();
      server.listen((client) {
        client.listen(received.addAll, onDone: () {
          client.destroy();
          done.complete();
        });
      });
      final job = List<int>.generate(1500, (i) => i % 200);
      await PrinterTransport.of(
        PrinterConfig(
          id: 'g',
          name: 'Gentle',
          kind: PrinterKind.network,
          host: '127.0.0.1',
          port: server.port,
          options: const PrintOptions(custom: true, gentle: true),
        ),
      ).send(job);
      await done.future.timeout(const Duration(seconds: 10));
      await server.close();
      expect(received, job);
    });
  });
}

bool _listEq(List<int> a, List<int> b) {
  if (a.length != b.length) return false;
  for (var i = 0; i < a.length; i++) {
    if (a[i] != b[i]) return false;
  }
  return true;
}

TillReport _report() => TillReport(
  isZ: true,
  zNumber: 5,
  openedAt: DateTime(2026, 10, 8, 9),
  closedAt: DateTime(2026, 10, 8, 23),
  orderCount: 3,
  grossMinor: 3900,
  discountMinor: 0,
  taxMinor: 650,
  byMethod: const {'CASH': ReportTally(count: 3, amountMinor: 3900)},
  byDepartment: const {'Bar': ReportTally(count: 3, amountMinor: 3900)},
  openingFloatMinor: 10000,
);
