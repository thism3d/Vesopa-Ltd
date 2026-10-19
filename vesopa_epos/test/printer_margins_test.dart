import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/printing/printer_transport.dart';
import 'package:vesopa_epos/printing/receipt_builder.dart';

/// An 80mm roll on a printer with wider margins (2026-10-19): Pontardawe's
/// Lounge till printed every line of its Z report wrapped at 48 characters
/// when that printer fits 42.
void main() {
  // CapabilityProfile.load() reads its JSON from the asset bundle.
  TestWidgetsFlutterBinding.ensureInitialized();

  PrinterConfig printer(int width) => PrinterConfig(
    id: 'p1',
    name: 'Lounge',
    kind: PrinterKind.network,
    host: '10.0.0.9',
    paperWidthMm: width,
  );

  test('each roll setting has its own line width', () {
    expect(printer(80).columns, 48);
    expect(printer(72).columns, 42);
    expect(printer(58).columns, 32);
  });

  test('the wide-margins setting survives being saved and read back', () {
    final back = PrinterConfig.fromJson(printer(72).toJson());
    expect(back.paperWidthMm, 72);
    expect(back.columns, 42);
    // Anything unknown is the standard roll, as before.
    expect(PrinterConfig.fromJson({...printer(80).toJson(), 'paper_width_mm': 64}).paperWidthMm, 80);
  });

  test('the receipt builder lays out at the printer\'s width', () async {
    expect((await ReceiptBuilder.forPrinter(printer(72))).columns, 42);
    expect((await ReceiptBuilder.forPrinter(printer(80))).columns, 48);
    expect((await ReceiptBuilder.create(paperWidthMm: 72)).columns, 42);
  });
}
