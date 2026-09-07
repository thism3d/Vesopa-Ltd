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

/// Table 1 from the venue's screenshot: two rounds, two people, one bill.
final _table1 = [
  line('a', name: 'Fish & Chips', price: 2900, by: 'Nicky',
      at: DateTime(2026, 9, 7, 19, 8)),
  line('b', name: 'Chips', price: 400, by: 'Nicky'),
  line('c', name: 'Chicken Wings', price: 750, by: 'Muzahid Islam',
      at: DateTime(2026, 9, 7, 15, 21)),
];

/// The shape from the Newbridge video: one table, several covers, no rounds.
final _breakfast = [
  line('w', name: 'Veggie Breakfast Wrap', price: 795),
  line('e', name: 'Avocado Eggs', price: 795),
  line('r', name: 'Breakfast Roll', price: 650),
  line('b', name: 'Breakfast Wrap', price: 795),
];

Future<void> _open(
  WidgetTester tester,
  TenderState state, {
  void Function(SplitChoice?)? into,
  Future<void> Function(Set<String>, String, int)? onPrintShare,
}) async {
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: Builder(
          builder: (context) => TextButton(
            onPressed: () async {
              final choice = await showSplitDialog(
                context,
                state: state,
                onPrintShare: onPrintShare,
              );
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

/// Pick items out of the pool and split them off into a share of their own.
Future<void> _splitOff(WidgetTester tester, List<String> names) async {
  for (final name in names) {
    await tester.tap(find.text(name).first);
    await tester.pump();
  }
  await tester.tap(find.textContaining('Split off'));
  await tester.pumpAndSettle();
}

void main() {
  group('the pool drains as shares are made', () {
    testWidgets('everything starts unsplit', (tester) async {
      await _open(tester, stateOf(_breakfast));
      expect(find.text('Not split yet'), findsOneWidget);
      expect(find.text('£30.35'), findsWidgets, reason: 'left to split');
      expect(find.text('Pick items to split off'), findsOneWidget);
    });

    testWidgets('splitting some off takes them out of the pool',
        (tester) async {
      // The Newbridge move: pick an item, press once, and it leaves.
      await _open(tester, stateOf(_breakfast));
      await _splitOff(tester, ['Veggie Breakfast Wrap']);

      expect(find.text('Share 1'), findsOneWidget);
      // £30.35 less the £7.95 that left.
      expect(find.text('£22.40'), findsOneWidget, reason: 'left to split');
    });

    testWidgets('the pool empties when it is all allocated', (tester) async {
      await _open(tester, stateOf(_breakfast));
      await _splitOff(tester, ['Veggie Breakfast Wrap']);
      await _splitOff(tester, ['Avocado Eggs', 'Breakfast Roll']);
      await _splitOff(tester, ['Breakfast Wrap']);

      expect(find.text('All split'), findsOneWidget);
      expect(find.text('Every item is on a share.'), findsOneWidget);
      expect(find.text('Share 3'), findsOneWidget);
    });

    testWidgets('a share can be put back on its own', (tester) async {
      await _open(tester, stateOf(_breakfast));
      await _splitOff(tester, ['Veggie Breakfast Wrap']);
      expect(find.text('Share 1'), findsOneWidget);

      await tester.tap(find.widgetWithIcon(IconButton, Icons.undo));
      await tester.pumpAndSettle();

      expect(find.text('Share 1'), findsNothing);
      expect(find.text('Not split yet'), findsOneWidget);
    });

    testWidgets('Undo split puts everything back at once', (tester) async {
      await _open(tester, stateOf(_breakfast));
      await _splitOff(tester, ['Veggie Breakfast Wrap']);
      await _splitOff(tester, ['Avocado Eggs']);

      await tester.tap(find.widgetWithText(TextButton, 'Undo split'));
      await tester.pumpAndSettle();

      expect(find.text('Share 1'), findsNothing);
      expect(find.text('Not split yet'), findsOneWidget);
    });
  });

  group('what a share is worth', () {
    testWidgets('a card shows its own total', (tester) async {
      await _open(tester, stateOf(_breakfast));
      await _splitOff(tester, ['Avocado Eggs', 'Breakfast Roll']);
      // £7.95 + £6.50, on the card.
      expect(find.text('£14.45'), findsOneWidget);
    });

    testWidgets('a bill-wide offer is shared pro-rata, not dumped on share 1',
        (tester) async {
      // £30.35 of items with £3.03 off. The £7.95 wrap is 26.2% of the bill,
      // so it carries 26.2% of the discount rather than none of it or all
      // of it.
      await _open(tester, stateOf(_breakfast, discountMinor: 303));
      await _splitOff(tester, ['Veggie Breakfast Wrap']);

      // £7.16 and not £7.95: the card is quoted net of its portion of the
      // offer, which is the number the customer will be asked for.
      //
      // Checked inside the card rather than on the screen, because £7.95 is
      // still on the screen — two other items cost that, and they are sitting
      // in the pool. An earlier version of this test asserted £7.95 appeared
      // nowhere and failed for that reason, which was the test being wrong
      // rather than the screen.
      final card = find.ancestor(
        of: find.text('Share 1'),
        matching: find.byType(Card),
      );
      expect(
        find.descendant(of: card, matching: find.text('£7.16')),
        findsOneWidget,
      );
      // The card shows both, deliberately: the item costs £7.95 and the share
      // comes to £7.16 once the offer is apportioned. Hiding the item price to
      // make the two agree would be a bill that cannot be checked against the
      // menu.
      expect(
        find.descendant(of: card, matching: find.text('£7.95')),
        findsOneWidget,
        reason: 'the item lost its own price',
      );
    });

    testWidgets('what is left in the pool is a share too', (tester) async {
      // Two people pay and the rest settle together — an ordinary way to split
      // a bill. Dropping the leftover would be a split that does not add up to
      // what is owed.
      SplitChoice? result;
      await _open(tester, stateOf(_breakfast), into: (c) => result = c);
      await _splitOff(tester, ['Veggie Breakfast Wrap']);
      await tester.tap(find.widgetWithText(FilledButton, 'Done'));
      await tester.pumpAndSettle();

      expect(result?.mode, SplitMode.byItem);
      expect(result?.groups, hasLength(2));
      final groups = result!.groups!;
      expect(groups[0], ['w']);
      expect(groups[1], containsAll(<String>['e', 'r', 'b']));
    });
  });

  group('by round', () {
    testWidgets('a table two people served fills the shares in one press',
        (tester) async {
      await _open(tester, stateOf(_table1));
      expect(find.widgetWithText(OutlinedButton, 'By round'), findsOneWidget);

      await tester.tap(find.widgetWithText(OutlinedButton, 'By round'));
      await tester.pumpAndSettle();

      expect(find.text('Share 1'), findsOneWidget);
      expect(find.text('Share 2'), findsOneWidget);
      expect(find.text('All split'), findsOneWidget);
      expect(find.text('£33.00'), findsOneWidget);
      expect(find.text('£7.50'), findsWidgets);
    });

    testWidgets('a counter sale is not offered it', (tester) async {
      await _open(tester, stateOf(_breakfast));
      expect(find.widgetWithText(OutlinedButton, 'By round'), findsNothing);
    });
  });

  group('what the sheet hands back', () {
    testWidgets('nothing split is not a split', (tester) async {
      // Which is also how "select both to pay" is expressed: leave the table
      // whole and it is one bill.
      SplitChoice? result;
      await _open(tester, stateOf(_table1), into: (c) => result = c);
      await tester.tap(find.widgetWithText(FilledButton, 'Done'));
      await tester.pumpAndSettle();
      expect(result?.mode, SplitMode.none);
    });

    testWidgets('Pay now names the share to charge', (tester) async {
      // "This one, now" — the board comes back asking for that share rather
      // than for share one.
      SplitChoice? result;
      await _open(tester, stateOf(_breakfast), into: (c) => result = c);
      await _splitOff(tester, ['Veggie Breakfast Wrap']);
      await _splitOff(tester, ['Avocado Eggs']);

      await tester.tap(find.widgetWithText(FilledButton, 'Pay now').at(1));
      await tester.pumpAndSettle();

      expect(result?.mode, SplitMode.byItem);
      expect(result?.payShare, 1);
    });

    testWidgets('Equally still hands back equal ways', (tester) async {
      SplitChoice? result;
      await _open(tester, stateOf(_breakfast), into: (c) => result = c);
      await tester.tap(find.text('Equally'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, 'Done'));
      await tester.pumpAndSettle();

      expect(result?.mode, SplitMode.equally);
      expect(result?.ways, 2);
    });
  });

  group('printing a share', () {
    testWidgets('a card prints its own bill, with its own total',
        (tester) async {
      // Three people want three slips before anybody pays. This is the whole
      // point of splitting a bill in a restaurant, and the first version of
      // this screen could not do it at all.
      Set<String>? printed;
      int? total;
      await _open(
        tester,
        stateOf(_breakfast),
        onPrintShare: (ids, title, minor) async {
          printed = ids;
          total = minor;
        },
      );
      await _splitOff(tester, ['Avocado Eggs', 'Breakfast Roll']);
      await _splitOff(tester, ['Veggie Breakfast Wrap']);

      await tester.tap(find.widgetWithText(OutlinedButton, 'Bill').first);
      await tester.pumpAndSettle();

      expect(printed, {'e', 'r'});
      expect(total, 1445);
    });

    testWidgets('no printer path means a dead key, not a crash',
        (tester) async {
      await _open(tester, stateOf(_breakfast));
      await _splitOff(tester, ['Avocado Eggs']);
      final button = tester.widget<OutlinedButton>(
        find.widgetWithText(OutlinedButton, 'Bill'),
      );
      expect(button.onPressed, isNull);
    });
  });

  group('a share can never hold an answer without its question', () {
    final withModifier = [
      line('gin', name: 'Gin', price: 400),
      line('m', name: 'Dash Coke', price: 0, parent: 'gin'),
      line('beer', name: 'IPA', price: 300),
    ];

    testWidgets('a modifier is drawn under its item, not offered on its own',
        (tester) async {
      await _open(tester, stateOf(withModifier));
      expect(find.text('Gin'), findsOneWidget);
      expect(find.text('Dash Coke'), findsOneWidget);
      // Two things to pick, not three.
      expect(find.byIcon(Icons.circle_outlined), findsNWidgets(2));
    });

    testWidgets('splitting the drink off takes its modifier with it',
        (tester) async {
      SplitChoice? result;
      await _open(tester, stateOf(withModifier), into: (c) => result = c);
      await _splitOff(tester, ['Gin']);
      await tester.tap(find.widgetWithText(FilledButton, 'Done'));
      await tester.pumpAndSettle();

      expect(result?.groups![0], containsAll(<String>['gin', 'm']));
      expect(result?.groups![1], ['beer']);
    });
  });
}
