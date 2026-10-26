import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_tap/data/models.dart';
import 'package:vesopa_tap/data/payloads.dart';

/// A clerk's discount on the whole sale (Vesopa EPOS Lite's Discount key):
/// off the total, never more than the bill, and sent to the back office as
/// the sale's discount beside the member's.
void main() {
  const pint = Product(id: 'p', name: 'Lager', priceMinor: 550, category: 'drinks', plu: 1);
  final bill = Bill(id: 'b', name: 'Sale', lines: const [BillLine(id: 'l', product: pint, quantity: 4)], discountPercent: 10, discountReason: '10% by Sam');

  test('a percentage comes off the total', () {
    expect(bill.discountMinor, 220);
    expect(bill.totalMinor, 1980);
  });

  test('an amount off is capped at the bill', () {
    expect(bill.copyWith(discountPercent: 0, discountFixedMinor: 99999).totalMinor, 0);
  });

  test('the sale carries it', () {
    final sale = salePayload(bill, office: 'o', terminal: 't');
    expect(sale['discount_minor'], 220);
    expect(sale['discount_reason'], '10% by Sam');
    expect(sale['total_minor'], 1980);
  });
}
