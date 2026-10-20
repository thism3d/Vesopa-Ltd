import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/printing/receipt_builder.dart';

/// Rows print as plain text that never runs past the roll: the Pontardawe RFC
/// Z report (2026-10-20) printed "Meirion D / avies" and "Transactions0".
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  test('no printed line is wider than the roll, and values stay beside their labels', () async {
    final b = await ReceiptBuilder.create(paperWidthMm: 80);
    final lines = b.debugRowLines([
      ['Employee', 'Meirion Davies'],
      ['Transactions', '0'],
      ['Average spend', '£12.34'],
      ['TOTAL', '[12] £1,234.56'],
      ['A very long department name that goes on', '[3] £45.00'],
    ]);
    for (final l in lines) {
      expect(l.length, lessThanOrEqualTo(42), reason: l);
    }
    expect(lines.any((l) => l.startsWith('Employee') && l.endsWith('Meirion Davies')), isTrue);
    expect(lines.any((l) => l.startsWith('Transactions') && l.endsWith('0') && l.length > 30), isTrue);
    expect(lines.any((l) => l.startsWith('TOTAL') && l.endsWith('1,234.56')), isTrue);
  });

  test('a 58mm roll gets 32 characters a line', () async {
    final b = await ReceiptBuilder.create(paperWidthMm: 58);
    for (final l in b.debugRowLines([['Employee', 'Meirion Davies'], ['Average spend', '£12.34']])) {
      expect(l.length, lessThanOrEqualTo(32), reason: l);
    }
  });
}
