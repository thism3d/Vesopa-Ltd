// A split made after money was taken (Pontardawe RFC, 2026-11-07, Carys):
// "Share 1: Kids Breakfast £4.50, Tea £2.00, Total £1.82". A share is its own
// items at their own prices; money already paid is never spread as a discount.
import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/data/commerce.dart';
import 'package:vesopa_epos/data/pricing_engine.dart';
import 'package:vesopa_epos/data/tender_engine.dart';

const _lines = [
  PricedLine(id: 'kids', pluid: 1, name: 'Kids Breakfast', quantity: 1, unitPriceMinor: 450, taxPercentage: 0),
  PricedLine(id: 'tea', pluid: 2, name: 'Tea', quantity: 1, unitPriceMinor: 200, taxPercentage: 0),
  PricedLine(id: 'full1', pluid: 3, name: 'Full Breakfast', quantity: 1, unitPriceMinor: 1095, taxPercentage: 0),
  PricedLine(id: 'full2', pluid: 3, name: 'Full Breakfast', quantity: 1, unitPriceMinor: 1095, taxPercentage: 0),
];

TenderState _bill({int discountMinor = 0}) => TenderState(
      totals: const PricingEngine().price(_lines, manualDiscountMinor: discountMinor, dealMinor: 0),
    );

const _paid = TenderEntry(kind: TenderKind.card, amountMinor: 2190, saved: true);

void main() {
  test('a share after an earlier payment is its own items, to the penny', () {
    final s = _bill().addTender(_paid).splitByItems([
      ['kids', 'tea'],
      ['full1', 'full2'],
    ]);
    expect(s.shares[0].amountMinor, 650);
    expect(s.shares[1].amountMinor, 2190);
  });

  test('the shares add up to the bill, not to what is left', () {
    final s = _bill().addTender(_paid).splitByItems([
      ['kids', 'tea'],
      ['full1'],
      ['full2'],
    ]);
    expect(s.shares.fold<int>(0, (a, b) => a + b.amountMinor), s.totals.totalMinor);
  });

  test('the till asks only for what the bill still owes', () {
    // The two breakfasts were the earlier payment. The share holding them is
    // not asked again for more than the bill owes, which is the £6.50 left.
    final s = _bill().addTender(_paid).splitByItems([
      ['full1', 'full2'],
      ['kids', 'tea'],
    ]);
    expect(s.outstandingMinor, 650);
    expect(s.dueNowMinor, 650);
    final paid = s.selectShare(1).addTender(const TenderEntry(kind: TenderKind.cash, amountMinor: 650));
    expect(paid.settled, isTrue);
    expect(paid.paidMinor, s.totals.totalMinor);
  });

  test('a bill-wide offer is still shared by value after a payment', () {
    // £2.00 off £28.40: the offer is the only thing apportioned.
    final s = _bill(discountMinor: 200).addTender(_paid).splitByItems([
      ['kids', 'tea'],
      ['full1', 'full2'],
    ]);
    expect(s.shares.fold<int>(0, (a, b) => a + b.amountMinor), 2640);
    // 650 of 2840 is 22.9% of -200 = -45.77, truncated to -45; the stray penny
    // goes on the larger share.
    expect(s.shares[0].amountMinor, 650 - 45);
    expect(s.shares[1].amountMinor, 2190 - 155);
  });

  test('with nothing paid, nothing changes', () {
    final before = _bill().splitByItems([
      ['kids', 'tea'],
      ['full1', 'full2'],
    ]);
    expect([for (final s in before.shares) s.amountMinor], [650, 2190]);
  });
}
