import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/data/printer_settings.dart';
// printer_transport re-exports print_targets.dart, where PrintTarget lives.
import 'package:vesopa_epos/printing/printer_transport.dart';

/// The printer model separated devices from the jobs they do. Everything here
/// guards the seam that created: a venue upgrading must keep printing exactly
/// where it printed before, without opening the setup screen.
void main() {
  PrinterConfig printer(String id, {String? name}) => PrinterConfig(
    id: id,
    name: name ?? id,
    kind: PrinterKind.network,
    host: '10.0.0.1',
  );

  group('migration from the role-per-printer format', () {
    // Exactly what the previous release wrote to shared_preferences: a bare
    // list, each printer carrying the single role it filled.
    final legacy = [
      {
        'id': 'a',
        'name': 'Counter',
        'kind': 'network',
        'role': 'receipt',
        'host': '10.0.0.5',
        'port': 9100,
        'paper_width_mm': 80,
      },
      {
        'id': 'b',
        'name': 'Grill',
        'kind': 'serial',
        'role': 'kp1',
        'serial_port': 'COM3',
        'baud_rate': 19200,
        'paper_width_mm': 58,
      },
    ];

    test('every old printer survives as a device', () {
      final settings = PrinterSettings.fromLegacyList(legacy);

      expect(settings.printers.map((p) => p.id), ['a', 'b']);
      expect(settings.byId('b')!.serialPort, 'COM3');
      expect(settings.byId('b')!.baudRate, 19200);
      expect(settings.byId('b')!.paperWidthMm, 58);
    });

    test('each old role becomes that device\'s assignment', () {
      final settings = PrinterSettings.fromLegacyList(legacy);

      expect(settings.deviceFor(PrintTarget.customerReceipt)?.id, 'a');
      expect(settings.deviceFor(PrintTarget.kp1)?.id, 'b');
    });

    test('the drawer, bill and reports follow the receipt printer', () {
      // Nothing in the old format said where these went, because they were not
      // separable — they came out of the one receipt printer. The fallback
      // chain is what keeps that true for a till that upgrades.
      final settings = PrinterSettings.fromLegacyList(legacy);

      expect(settings.deviceFor(PrintTarget.cashDrawer)?.id, 'a');
      expect(settings.deviceFor(PrintTarget.bill)?.id, 'a');
      expect(settings.deviceFor(PrintTarget.tillReport)?.id, 'a');
      expect(settings.deviceFor(PrintTarget.merchantCopy)?.id, 'a');

      // But they are *inherited*, not chosen — which is what the setup screen
      // shows differently.
      expect(settings.isInherited(PrintTarget.cashDrawer), isTrue);
      expect(settings.isInherited(PrintTarget.customerReceipt), isFalse);
    });

    test('the pre-numbering station names still land somewhere', () {
      final settings = PrinterSettings.fromLegacyList([
        {'id': 'k', 'name': 'Kitchen', 'kind': 'network', 'role': 'kitchen'},
        {'id': 'r', 'name': 'Bar', 'kind': 'network', 'role': 'bar'},
      ]);

      expect(settings.deviceFor(PrintTarget.kp1)?.id, 'k');
      expect(settings.deviceFor(PrintTarget.kp2)?.id, 'r');
    });

    test('a kitchen station never falls back to the counter', () {
      // Food routed to KP 3 with no KP 3 set up has to be *reported*. Printing
      // it at the counter would put it somewhere nobody in the kitchen looks.
      final settings = PrinterSettings.fromLegacyList(legacy);

      expect(settings.deviceFor(PrintTarget.kp3), isNull);
    });
  });

  group('assignments', () {
    test('round-trip through JSON', () {
      final before = const PrinterSettings()
          .upsert(printer('a', name: 'Counter'))
          .upsert(printer('b', name: 'Office'))
          .assign(PrintTarget.customerReceipt, 'a')
          .assign(PrintTarget.merchantCopy, 'b')
          .copyWith(merchantCopyWhen: MerchantCopyWhen.cardSales);

      final after = PrinterSettings.fromJson(before.toJson());

      expect(after.deviceFor(PrintTarget.customerReceipt)?.name, 'Counter');
      expect(after.deviceFor(PrintTarget.merchantCopy)?.name, 'Office');
      expect(after.merchantCopyWhen, MerchantCopyWhen.cardSales);
    });

    test('the merchant copy can genuinely be a different printer', () {
      // The whole point of separating devices from jobs.
      final settings = const PrinterSettings()
          .upsert(printer('a'))
          .upsert(printer('b'))
          .assign(PrintTarget.customerReceipt, 'a')
          .assign(PrintTarget.merchantCopy, 'b');

      expect(settings.deviceFor(PrintTarget.customerReceipt)?.id, 'a');
      expect(settings.deviceFor(PrintTarget.merchantCopy)?.id, 'b');
      expect(settings.isInherited(PrintTarget.merchantCopy), isFalse);
    });

    test('removing a printer clears what pointed at it', () {
      // A stale id would show the setup screen a target assigned to a printer
      // that is not in the list, with no way to see why nothing printed.
      final settings = const PrinterSettings()
          .upsert(printer('a'))
          .upsert(printer('b'))
          .assign(PrintTarget.customerReceipt, 'a')
          .assign(PrintTarget.kp1, 'b')
          .remove('b');

      expect(settings.deviceFor(PrintTarget.kp1), isNull);
      expect(settings.assignments.containsKey(PrintTarget.kp1.key), isFalse);
      expect(settings.deviceFor(PrintTarget.customerReceipt)?.id, 'a');
    });

    test('clearing an assignment falls back rather than going dark', () {
      final settings = const PrinterSettings()
          .upsert(printer('a'))
          .upsert(printer('b'))
          .assign(PrintTarget.customerReceipt, 'a')
          .assign(PrintTarget.bill, 'b')
          .assign(PrintTarget.bill, null);

      expect(settings.deviceFor(PrintTarget.bill)?.id, 'a');
    });

    test('the receipt printer is a routing station too', () {
      final settings = const PrinterSettings()
          .upsert(printer('a'))
          .assign(PrintTarget.customerReceipt, 'a');

      expect(settings.printerForRoute('receipt')?.id, 'a');
      expect(settings.stations['receipt']?.id, 'a');
    });
  });

  group('kitchen routing strings', () {
    test('round-trip, in station order, receipt last', () {
      final formatted = KitchenRouting.format(['receipt', 'kp3', 'kp1']);
      expect(formatted, 'kp1,kp3,receipt');
      expect(KitchenRouting.parse(formatted), {'kp1', 'kp3', 'receipt'});
    });

    test('unknown stations are dropped, not fatal', () {
      // A back office offering KP 9 to a till that knows six should route to
      // the six it has, not refuse the product.
      expect(KitchenRouting.parse('kp1,kp9,nonsense'), {'kp1'});
    });

    test('nothing routed is null, not an empty string', () {
      expect(KitchenRouting.format(const []), isNull);
      expect(KitchenRouting.parse(null), isEmpty);
      expect(KitchenRouting.parse(''), isEmpty);
    });

    test('the old names still parse', () {
      expect(KitchenRouting.parse('kitchen,bar'), {'kp1', 'kp2'});
    });
  });

  group('connection kinds', () {
    test('only the Windows queue admits to using the spooler', () {
      expect(PrinterKind.network.isDirect, isTrue);
      expect(PrinterKind.usb.isDirect, isTrue);
      expect(PrinterKind.serial.isDirect, isTrue);
      expect(PrinterKind.windowsQueue.isDirect, isFalse);
    });

    test('a printer with nothing to send to is not complete', () {
      expect(
        const PrinterConfig(
          id: 'x',
          name: 'x',
          kind: PrinterKind.usb,
        ).isComplete,
        isFalse,
      );
      expect(
        const PrinterConfig(
          id: 'x',
          name: 'x',
          kind: PrinterKind.usb,
          usbDevicePath: r'\\?\usb#vid_04b8',
        ).isComplete,
        isTrue,
      );
    });

    test('an unrecognised stored kind falls back to network', () {
      // Network is the one connection every platform has, so a settings file
      // from a newer release must not leave a tablet with a dead printer.
      expect(PrinterKind.fromName('carrier-pigeon'), PrinterKind.network);
      expect(PrinterKind.fromName(null), PrinterKind.network);
    });
  });
}
