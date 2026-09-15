import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/data/earning.dart';

void main() {
  test('a member attached on the payment page earns', () {
    expect(earningCustomer(attachedHere: 'a', onOrder: null), 'a');
  });
  test('a member attached on the sale page or by card earns too', () {
    // The bug 1.8.1.0 fixes: this used to be null, and nothing was earned.
    expect(earningCustomer(attachedHere: null, onOrder: 'b'), 'b');
    expect(earningCustomer(attachedHere: '', onOrder: 'b'), 'b');
  });
  test('the payment page wins when both are set', () {
    expect(earningCustomer(attachedHere: 'a', onOrder: 'b'), 'a');
  });
  test('no member, no points', () {
    expect(earningCustomer(attachedHere: null, onOrder: ''), isNull);
  });
}
