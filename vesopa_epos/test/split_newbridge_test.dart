// Splitting as Newbridge does, and more (owner, 2026-11-07): one item moved
// between shares, equal split as cards, Print All, names, split by amount, and
// the next share offered after a payment.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/data/commerce.dart';
import 'package:vesopa_epos/data/pricing_engine.dart';
import 'package:vesopa_epos/data/split_options.dart';
import 'package:vesopa_epos/data/tender_engine.dart';
import 'package:vesopa_epos/ui/split_bill_sheet.dart';

PricedLine _line(String id, String name, int price) =>
    PricedLine(id: id, pluid: 1, name: name, quantity: 1, unitPriceMinor: price, taxPercentage: 0);

/// Table 3 from the Newbridge video: £16.70.
final _table3 = [
  _line('am', 'Amstel', 470),
  _line('bm', 'Birra Moretti', 530),
  _line('ar', 'Amaretto 25ml', 335),
  _line('ac', 'Archers 25ml', 335),
];

TenderState _state() => TenderState(totals: const PricingEngine().price(_table3, manualDiscountMinor: 0, dealMinor: 0));

Future<SplitBillSheetState> _open(WidgetTester tester, {SplitOptions options = const SplitOptions(), List<String>? printed}) async {
  tester.view.physicalSize = const Size(1600, 1100);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(MaterialApp(
    home: Scaffold(
      body: SplitBillSheet(
        state: _state(),
        options: options,
        onPrintShare: (ids, title, total, q) async => printed?.add('$title ${(total / 100).toStringAsFixed(2)}'),
      ),
    ),
  ));
  await tester.pumpAndSettle();
  return tester.state<SplitBillSheetState>(find.byType(SplitBillSheet));
}

void main() {
  group('the money', () {
    test('split by amount: set sums, the rest a last share, always the bill', () {
      final s = _state().splitByAmounts([500, 400]);
      expect([for (final x in s.shares) x.amountMinor], [500, 400, 770]);
      expect(s.splitMode, SplitMode.byAmount);
    });

    test('an amount past what is owed is cut to it, and nothing is never a share', () {
      final s = _state().splitByAmounts([0, 2000]);
      expect(s.isSplit, isFalse, reason: 'one share of everything is the bill, not a split');
      final t = _state().splitByAmounts([1000, 2000]);
      expect([for (final x in t.shares) x.amountMinor], [1000, 670]);
    });

    test('names stay with their shares through payments', () {
      final s = _state().splitEqually(2).namedShares(['Carys', '']);
      expect(s.shares[0].label, 'Carys');
      expect(s.shares[1].label, 'Share 2');
      final paid = s.addTender(const TenderEntry(kind: TenderKind.cash, amountMinor: 835));
      expect(paid.shares[0].name, 'Carys');
      expect(paid.nextUnpaidShare?.index, 1);
    });

    test('equal halves of the video bill: £8.35 and £8.35', () {
      final s = _state().splitEqually(2);
      expect([for (final x in s.shares) x.amountMinor], [835, 835]);
    });
  });

  group('the screen', () {
    testWidgets('minus sends one item back; plus puts picked items on a share', (tester) async {
      final sheet = await _open(tester);
      await tester.tap(find.text('Amstel'));
      await tester.tap(find.text('Archers 25ml'));
      await tester.pump();
      await tester.tap(find.textContaining('Split off'));
      await tester.pumpAndSettle();
      expect(sheet.groups.first.toSet(), {'am', 'ac'});

      // Minus on Archers: back in the pool.
      await tester.tap(find.byIcon(Icons.remove_circle_outline).last);
      await tester.pumpAndSettle();
      expect(sheet.groups.first.toSet(), {'am'});

      // Pick Amaretto in the pool, plus on the share.
      await tester.tap(find.text('Amaretto 25ml'));
      await tester.pump();
      await tester.tap(find.byIcon(Icons.add_circle));
      await tester.pumpAndSettle();
      expect(sheet.groups.first.toSet(), {'am', 'ar'});
    });

    testWidgets('equal split shows a card per person with [1/2] of each item', (tester) async {
      await _open(tester, options: const SplitOptions(defaultMethod: 'equally'));
      expect(find.text('[1/2] '), findsNWidgets(8), reason: 'four items on each of two cards');
      expect(find.text('Pay now'), findsNWidgets(2));
      expect(find.text('£8.35'), findsNWidgets(2));
    });

    testWidgets('Print All prints every share by name', (tester) async {
      final printed = <String>[];
      await _open(tester, options: const SplitOptions(defaultMethod: 'equally'), printed: printed);
      await tester.tap(find.textContaining('Print all'));
      await tester.pumpAndSettle();
      expect(printed, ['Share 1 · 1 of 2 8.35', 'Share 2 · 2 of 2 8.35']);
    });

    testWidgets('by amount: a set sum and the rest', (tester) async {
      final sheet = await _open(tester, options: const SplitOptions(defaultMethod: 'amount'));
      await tester.tap(find.text('Add an amount'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField), '10');
      await tester.tap(find.text('Add'));
      await tester.pumpAndSettle();
      expect([for (final s in sheet.preview) s.amountMinor], [1000, 670]);
      expect(find.text('The rest of the bill'), findsOneWidget);
    });
  });
}
