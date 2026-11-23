// Items already paid for stay off the split screen (Pontardawe RFC, Nicky,
// 2026-11-23, Table 16): "They paid for hooker and pint of lemonade but the
// items still appeared on the split afterward." The screen said "£13.85 paid
// · £44.15 left to pay" and still listed every item, with £58.00 left to split.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/data/commerce.dart';
import 'package:vesopa_epos/data/pricing_engine.dart';
import 'package:vesopa_epos/data/split_portions.dart';
import 'package:vesopa_epos/data/tender_engine.dart';
import 'package:vesopa_epos/ui/split_bill_sheet.dart';

PricedLine _l(String id, String name, int price, {double qty = 1}) => PricedLine(
      id: id,
      pluid: 1,
      name: name,
      quantity: qty,
      unitPriceMinor: price,
      taxPercentage: 0,
    );

/// Table 16 as it was rung: £58.00.
final _table16 = [
  _l('h1', 'Hooker', 1095),
  _l('h2', 'Hooker', 1095),
  _l('h3', 'Hooker', 1095),
  _l('h4', 'Hooker', 1095),
  _l('pc1', 'Pint Coke', 290),
  _l('pl', 'Pint Lemonade', 290),
  _l('can', 'Coca-Cola Can', 150),
  _l('pc2', 'Pint Coke', 290),
  _l('t1', 'Tea', 200),
  _l('t2', 'Tea', 200),
];

TenderState _bill() => TenderState(
      totals: const PricingEngine().price(_table16, manualDiscountMinor: 0, dealMinor: 0),
    );

/// The Hooker and the Pint of Lemonade, paid by card as a share, recorded on
/// the bill, and read back when the bill was opened again.
const _paidShare = TenderEntry(
  kind: TenderKind.card,
  amountMinor: 1385,
  saved: true,
  lineIds: ['h1', 'pl'],
);

Future<void> _open(WidgetTester tester, TenderState state, {void Function(SplitChoice?)? into}) async {
  // A till's screen, so the whole pool is laid out rather than scrolled away.
  tester.view.physicalSize = const Size(1920, 1200);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(MaterialApp(
    home: Scaffold(
      body: Builder(
        builder: (context) => TextButton(
          onPressed: () async {
            final choice = await showSplitDialog(context, state: state);
            into?.call(choice);
          },
          child: const Text('open'),
        ),
      ),
    ),
  ));
  await tester.tap(find.text('open'));
  await tester.pumpAndSettle();
}

void main() {
  group('the engine knows what has been paid for', () {
    test('from a payment recorded earlier', () {
      final s = _bill().addTender(_paidShare);
      expect(s.paidLineIds, {'h1', 'pl'});
      expect(s.outstandingMinor, 4415);
    });

    test('from a share paid on this screen', () {
      final split = _bill().splitByItems([
        ['h1', 'pl'],
        ['h2', 'h3', 'h4', 'pc1', 'can', 'pc2', 't1', 't2'],
      ]);
      final paid = split.addTender(const TenderEntry(kind: TenderKind.card, amountMinor: 1385));
      expect(paid.shares[0].settled, isTrue);
      expect(paid.paidLineIds, {'h1', 'pl'});
    });

    test('an item no longer on the bill is not counted', () {
      final s = _bill().addTender(const TenderEntry(
        kind: TenderKind.card,
        amountMinor: 1385,
        saved: true,
        lineIds: ['h1', 'gone'],
      ));
      expect(s.paidLineIds, {'h1'});
    });

    test('nothing paid for by item: nothing is', () {
      final s = _bill().addTender(const TenderEntry(kind: TenderKind.cash, amountMinor: 1000));
      expect(s.paidLineIds, isEmpty);
    });

    test('splitting the rest asks for exactly what is still owed', () {
      final s = _bill().addTender(_paidShare).splitByItems([
        ['h2', 'pc1'],
        ['h3', 'h4', 'can', 'pc2', 't1', 't2'],
      ]);
      expect(s.shares[0].amountMinor, 1385);
      expect(s.shares[1].amountMinor, 3030);
      expect(s.shares.fold<int>(0, (a, b) => a + b.amountMinor), s.outstandingMinor);
    });

    test('a bill-wide offer: the rest still adds up to what is owed', () {
      // £5.80 off £58.00. The paid share took its tenth: £13.85 - £1.38.
      final totals = const PricingEngine().price(_table16, manualDiscountMinor: 580, dealMinor: 0);
      final first = TenderState(totals: totals).splitByItems([
        ['h1', 'pl'],
        ['h2', 'h3', 'h4', 'pc1', 'can', 'pc2', 't1', 't2'],
      ]);
      final paidAmount = first.shares[0].amountMinor;
      final s = TenderState(totals: totals)
          .addTender(TenderEntry(kind: TenderKind.card, amountMinor: paidAmount, saved: true, lineIds: const ['h1', 'pl']))
          .splitByItems([
        ['h2', 'h3'],
        ['h4', 'pc1', 'can', 'pc2', 't1', 't2'],
      ]);
      expect(s.shares.fold<int>(0, (a, b) => a + b.amountMinor), s.outstandingMinor);
      // Each share still carries its own tenth of the offer, give or take a penny.
      expect((s.shares[0].amountMinor - (2190 - 219)).abs(), lessThanOrEqualTo(2));
    });

    test('line ids survive being written to the bill and read back', () {
      expect(decodeLineIds(encodeLineIds(['h1', 'p#2'])), ['h1', 'p#2']);
      expect(encodeLineIds(const []), isNull);
      expect(decodeLineIds(null), isEmpty);
    });
  });

  group('the split screen', () {
    testWidgets('Table 16: the paid Hooker and Lemonade are not offered again', (tester) async {
      await _open(tester, _bill().addTender(_paidShare));

      expect(find.text('£13.85 paid · £44.15 left to pay'), findsOneWidget);
      // Three Hookers left of four, and no Pint of Lemonade.
      expect(find.text('Hooker'), findsNWidgets(3));
      expect(find.text('Pint Lemonade'), findsNothing);
      expect(find.text('Pint Coke'), findsNWidgets(2));
      // Left to split is what is left: £44.15, not £58.00.
      expect(find.text('£58.00'), findsNothing);
      expect(find.text('£44.15'), findsWidgets);
      expect(find.text('2 items already paid for are not shown.'), findsOneWidget);
    });

    testWidgets('the split it makes holds only what is still to pay', (tester) async {
      SplitChoice? choice;
      await _open(tester, _bill().addTender(_paidShare), into: (c) => choice = c);

      await tester.tap(find.text('Tea').first);
      await tester.pump();
      await tester.tap(find.textContaining('Split off'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Done'));
      await tester.pumpAndSettle();

      expect(choice, isNotNull);
      final ids = {for (final g in choice!.groups!) ...g};
      expect(ids.contains('h1'), isFalse);
      expect(ids.contains('pl'), isFalse);
      expect(ids, {'h2', 'h3', 'h4', 'pc1', 'can', 'pc2', 't1', 't2'});
    });

    testWidgets('one of a divided round paid: the other units stay', (tester) async {
      final lines = [_l('p', 'Prosecco', 700, qty: 3), _l('n', 'Peanuts', 250)];
      final state = TenderState(
        totals: const PricingEngine().price(lines, manualDiscountMinor: 0, dealMinor: 0),
      ).addTender(TenderEntry(kind: TenderKind.cash, amountMinor: 700, saved: true, lineIds: [portionId('p', 2)]));
      await _open(tester, state);

      expect(find.text('Prosecco'), findsNWidgets(2));
      expect(find.text('1 of 3'), findsOneWidget);
      expect(find.text('3 of 3'), findsOneWidget);
      expect(find.text('2 of 3'), findsNothing);
      expect(find.text('£16.50'), findsWidgets, reason: 'left to split: two proseccos and peanuts');
    });

    testWidgets('with nothing paid for by item, every item is there', (tester) async {
      await _open(tester, _bill());
      expect(find.text('Hooker'), findsNWidgets(4));
      expect(find.text('Pint Lemonade'), findsOneWidget);
      expect(find.textContaining('already paid for'), findsNothing);
    });
  });
}
