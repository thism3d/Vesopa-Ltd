import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/data/pricing_engine.dart';
import 'package:vesopa_epos/data/tender_engine.dart';
import 'package:vesopa_epos/ui/split_bill_sheet.dart';

PricedLine line(
  String id, {
  String name = 'Item',
  int price = 100,
  String? by,
  DateTime? at,
  String? parent,
}) =>
    PricedLine(
      id: id,
      pluid: 1,
      name: name,
      quantity: 1,
      unitPriceMinor: price,
      taxPercentage: 0,
      addedBy: by,
      addedAt: at,
      parentLineId: parent,
    );

TenderState stateOf(List<PricedLine> lines, {int discountMinor = 0}) =>
    TenderState(
      totals: const PricingEngine()
          .price(lines, manualDiscountMinor: discountMinor),
    );

/// Table 1 from the venue's screenshot, cut down to the shape that matters:
/// two rounds, two people, one bill.
final _table1 = [
  line('a', name: 'Fish & Chips', price: 2900, by: 'Nicky',
      at: DateTime(2026, 9, 7, 19, 8)),
  line('b', name: 'Chips', price: 400, by: 'Nicky'),
  line('c', name: 'Chicken Wings', price: 750, by: 'Muzahid Islam',
      at: DateTime(2026, 9, 7, 15, 21)),
];

/// Opens the sheet over a scratch app, leaving it on screen to be inspected.
///
/// The answer is written into [into] when the sheet eventually pops, so a test
/// can drive the sheet and read what it handed back afterwards.
Future<void> _open(
  WidgetTester tester,
  TenderState state, {
  void Function(SplitChoice?)? into,
}) async {
  await tester.pumpWidget(
    MaterialApp(
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
    ),
  );
  await tester.tap(find.text('open'));
  await tester.pumpAndSettle();
}

/// Opens the sheet, presses Split, and returns what it handed back.
Future<SplitChoice?> _confirm(WidgetTester tester, TenderState state) async {
  SplitChoice? result;
  await _open(tester, state, into: (c) => result = c);
  await tester.tap(find.widgetWithText(FilledButton, 'Split'));
  await tester.pumpAndSettle();
  return result;
}

void main() {
  group('which method the sheet opens on', () {
    testWidgets('a table two people served opens on By round', (tester) async {
      await _open(tester, stateOf(_table1));
      expect(find.text('By round'), findsOneWidget);

      // Both rounds are drawn as cards, each with its own subtotal.
      expect(find.text('Nicky  ·  19:08'), findsOneWidget);
      expect(find.text('Muzahid Islam  ·  15:21'), findsOneWidget);
      // Twice each, and that is the point: once on the round's card and once
      // in the share totals along the foot, which is the number the customer
      // will be asked for.
      expect(find.text('£33.00'), findsNWidgets(2));
      expect(find.text('£7.50'), findsNWidgets(2));
    });

    testWidgets('a counter sale opens on By item, not Equally', (tester) async {
      // The venue asked for itemised as the default. Before this, "Equally"
      // was the tab the dialog opened on and "By item" was behind it.
      await _open(tester, stateOf([line('a'), line('b')]));
      expect(find.text('By round'), findsNothing);
      expect(find.text('Chips'), findsNothing);
      // The item tab is showing: its rows carry the ways selector labelled
      // "Shares", where Equally would say "Ways".
      expect(find.text('Shares'), findsOneWidget);
      expect(find.text('Ways'), findsNothing);
    });
  });

  group('what each share comes to', () {
    testWidgets('each round lands on its own share, priced', (tester) async {
      await _open(tester, stateOf(_table1));
      expect(find.text('Share 1'), findsOneWidget);
      expect(find.text('Share 2'), findsOneWidget);
      // £33.00 and £7.50 — the rounds, undiscounted.
      expect(find.text('£33.00'), findsWidgets);
      expect(find.text('£7.50'), findsWidgets);
    });

    testWidgets('a bill-wide offer is shown pro-rata, not all on share 1',
        (tester) async {
      // £40.50 of items, £4.05 off. Nicky's £33.00 is 81.5% of the bill, so
      // £29.70; the wings are £6.75. Under the old rule share 1 would have
      // shown £28.95 and share 2 the full £7.50.
      await _open(tester, stateOf(_table1, discountMinor: 405));
      expect(find.text('£29.70'), findsOneWidget);
      expect(find.text('£6.75'), findsOneWidget);
    });
  });

  group('what the sheet hands back', () {
    testWidgets('two rounds come back as two groups', (tester) async {
      final choice = await _confirm(tester, stateOf(_table1));
      expect(choice?.mode, SplitMode.byItem);
      expect(choice?.groups, hasLength(2));
      expect(choice!.groups![0], containsAll(<String>['a', 'b']));
      expect(choice.groups![1], contains('c'));
    });

    testWidgets('putting both rounds on one share is not a split',
        (tester) async {
      // "Give options to select both to pay." Everything on share 1 means one
      // payment for the whole table, and the till must not then ask the clerk
      // to press through an empty second share.
      SplitChoice? result;
      await _open(tester, stateOf(_table1), into: (c) => result = c);

      // Move the second round onto share 1: its card's "1" chip.
      final secondCardChips = find.descendant(
        of: find.ancestor(
          of: find.text('Muzahid Islam  ·  15:21'),
          matching: find.byType(Card),
        ),
        matching: find.widgetWithText(ChoiceChip, '1'),
      );
      await tester.tap(secondCardChips);
      await tester.pumpAndSettle();

      expect(
        find.textContaining('Everything is on one share'),
        findsOneWidget,
      );

      await tester.tap(find.widgetWithText(FilledButton, 'Split'));
      await tester.pumpAndSettle();
      expect(result?.mode, SplitMode.none);
    });

    testWidgets('Equally still hands back equal ways', (tester) async {
      SplitChoice? result;
      await _open(tester, stateOf([line('a', price: 1000)]),
          into: (c) => result = c);
      await tester.tap(find.text('Equally'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, 'Split'));
      await tester.pumpAndSettle();

      expect(result?.mode, SplitMode.equally);
      expect(result?.ways, 2);
    });
  });

  group('a modifier is never offered as its own share', () {
    final withModifier = [
      line('gin', name: 'Gin', price: 400),
      line('m', name: 'Dash Coke', price: 0, parent: 'gin'),
      line('beer', name: 'IPA', price: 300),
    ];

    testWidgets('it is drawn under its item, with no chips of its own',
        (tester) async {
      await _open(tester, stateOf(withModifier));
      expect(find.text('Gin'), findsOneWidget);
      expect(find.text('Dash Coke'), findsOneWidget);
      // Two items, so two "share 1" chips. Three lines are on the bill: the
      // modifier is drawn under the gin and given no chips of its own, because
      // it is not a thing that can be moved to somebody else's share.
      expect(find.widgetWithText(ChoiceChip, '1'), findsNWidgets(2));
    });

    testWidgets('moving the drink takes the modifier with it', (tester) async {
      final choice = await _confirm(tester, stateOf(withModifier));
      // Untouched, everything is on share 1, which is not a split.
      expect(choice?.mode, SplitMode.none);
    });
  });
}
