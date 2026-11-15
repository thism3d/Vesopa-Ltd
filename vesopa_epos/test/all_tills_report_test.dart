import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/data/session_repository.dart';

/// One X or Z for the whole venue (owner, 2026-11-15): each till's report
/// crosses the local link as JSON and the master adds them up.
void main() {
  TillReport till(String name, {required int cash, required int card, int cashback = 0, int paidIn = 0, int float = 10000}) => TillReport(
        isZ: false,
        zNumber: null,
        openedAt: DateTime(2026, 11, 14, name == 'Bar' ? 9 : 11),
        closedAt: null,
        orderCount: 10,
        grossMinor: cash + card,
        discountMinor: 0,
        taxMinor: ((cash + card) / 6).round(),
        byMethod: {'cash': ReportTally(count: 6, amountMinor: cash), 'card': ReportTally(count: 4, amountMinor: card)},
        byDepartment: {'Bar': ReportTally(count: 10, amountMinor: cash + card)},
        openingFloatMinor: float,
        cashbackMinor: cashback,
        paidIn: paidIn == 0 ? const ReportTally() : ReportTally(count: 1, amountMinor: paidIn),
        terminalName: name,
      );

  test('a report survives the trip over the link unchanged', () {
    final sent = till('Bar', cash: 25135, card: 47905, cashback: 4500, paidIn: 2000);
    final got = TillReport.fromJson(jsonDecode(jsonEncode(sent.toJson())) as Map);
    expect(got.cashbackMinor, 4500);
    expect(got.paidIn.amountMinor, 2000);
    expect(got.byMethod['card']!.count, 4);
    expect(got.expectedCashMinor, sent.expectedCashMinor);
    expect(got.openedAt, sent.openedAt);
    expect(got.terminalName, 'Bar');
  });

  test('two tills add up: takings, tenders, and the cash every drawer should hold', () {
    final bar = till('Bar', cash: 25135, card: 47905, cashback: 4500);
    final lounge = till('Lounge', cash: 10000, card: 5000, paidIn: 2000, float: 5000);
    final all = TillReport.combined([bar, lounge], name: 'All tills (2 of 2)');
    expect(all.grossMinor, bar.grossMinor + lounge.grossMinor);
    expect(all.byMethod['cash']!.amountMinor, 35135);
    expect(all.byMethod['card']!.count, 8);
    expect(all.cashbackMinor, 4500);
    expect(all.expectedCashMinor, bar.expectedCashMinor + lounge.expectedCashMinor);
    expect(all.openedAt, DateTime(2026, 11, 14, 9), reason: 'from the earliest opening');
    expect(all.isZ, isFalse);
    expect(all.terminalName, 'All tills (2 of 2)');
  });
}
