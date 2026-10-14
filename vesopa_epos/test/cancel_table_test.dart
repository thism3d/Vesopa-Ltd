import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/ui/void_dialog.dart';

/// "When you got an open table, don't allow cancel to delete the table"
/// (Pontardawe RFC, 2026-10-14).
void main() {
  test('a table with items on it is not cancelled in one go', () {
    expect(cancelRefused(tableNumber: 6, lineCount: 3), isTrue);
  });

  test('an empty bill on a table still clears', () {
    expect(cancelRefused(tableNumber: 6, lineCount: 0), isFalse);
  });

  test('a counter sale with no table still cancels', () {
    expect(cancelRefused(tableNumber: null, lineCount: 3), isFalse);
  });

  test('the clerk is told to use Void', () {
    expect(cancelTableMessage, contains('Void'));
  });
}
