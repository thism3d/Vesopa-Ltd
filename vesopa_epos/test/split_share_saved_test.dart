// Split bills, one person at a time (2026-10-26): a paid share is written to
// the bill and marked saved, so it is never recorded twice and cannot be
// undone from the payment screen.
import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/data/commerce.dart';
import 'package:vesopa_epos/data/pricing_engine.dart';
import 'package:vesopa_epos/data/tender_engine.dart';

TenderState _bill(int totalMinor) => TenderState(
      totals: BasketTotals(
        lines: const [],
        grossMinor: totalMinor,
        promoMinor: 0,
        dealMinor: 0,
        lineDiscountMinor: 0,
        manualDiscountMinor: 0,
        voucherMinor: 0,
        pointsMinor: 0,
        gratuityMinor: 0,
        totalMinor: totalMinor,
        taxMinor: 0,
      ),
    );

void main() {
  test('a saved payment is not taken off by undo', () {
    final state = _bill(3000)
        .splitEqually(2)
        .addTender(const TenderEntry(kind: TenderKind.cash, amountMinor: 1500))
        .markSavedFrom(0);
    expect(state.tenders.single.saved, isTrue);
    expect(state.removeLastTender().tenders, hasLength(1));
  });

  test('marking a share saved leaves earlier payments as they were', () {
    final state = _bill(3000)
        .splitEqually(2)
        .addTender(const TenderEntry(kind: TenderKind.card, amountMinor: 1500))
        .addTender(const TenderEntry(kind: TenderKind.cash, amountMinor: 1500))
        .markSavedFrom(1);
    expect(state.tenders[0].saved, isFalse);
    expect(state.tenders[1].saved, isTrue);
    expect(state.settled, isTrue);
  });

  test('a share cut to what it owed keeps everything but the amount', () {
    const given = TenderEntry(kind: TenderKind.cash, amountMinor: 2000, cashBreakdown: '2000x1');
    final cut = given.withAmount(1250);
    expect(cut.amountMinor, 1250);
    expect(cut.cashBreakdown, '2000x1');
    expect(cut.kind, TenderKind.cash);
  });
}
