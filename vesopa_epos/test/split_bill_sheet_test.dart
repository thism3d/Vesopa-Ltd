import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/data/pricing_engine.dart';
import 'package:vesopa_epos/data/tender_engine.dart';
import 'package:vesopa_epos/ui/split_bill_sheet.dart';

PricedLine line(
  String id, {
  String name = 'Item',
  int price = 100,
  double qty = 1,
  String? by,
  DateTime? at,
  String? parent,
}) =>
    PricedLine(
      id: id,
      pluid: 1,
      name: name,
      quantity: qty,
      unitPriceMinor: price,
      taxPercentage: 0,
      addedBy: by,
      addedAt: at,
      parentLineId: parent,
    );

TenderState stateOf(List<PricedLine> lines, {int discountMinor = 0}) =>
    TenderState(
      totals: const PricingEngine()
          .price(lines, manualDiscountMinor: discountMinor, dealMinor: 0),
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

/// A round of drinks rung up as one line — the fault the venue reported.
final _round = [
  line('p', name: 'Prosecco', price: 700, qty: 3),
  line('n', name: 'Peanuts', price: 250),
];

Future<void> _open(
  WidgetTester tester,
  TenderState state, {
  void Function(SplitChoice?)? into,
  Future<void> Function(Set<String>, String, int, Map<String, double>)?
      onPrintShare,
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

  group('a round rung up as one line', () {
    // "There's also a bug on split bill. If there is 3 x Prosecco you can't
    // split them off, someone must pay for the 3 glasses if you get what i
    // mean." Before this, the pool had one row for the round and the whole of
    // it went onto whichever card took it.
    testWidgets('offers to take the round apart', (tester) async {
      await _open(tester, stateOf(_round));
      expect(find.text('3 × Prosecco'), findsOneWidget);
      expect(find.byTooltip('Split these 3 up'), findsOneWidget);
      // And offers nothing of the sort on a single item.
      expect(find.byTooltip('Split these 1 up'), findsNothing);
    });

    testWidgets('taking it apart makes three glasses', (tester) async {
      await _open(tester, stateOf(_round));
      await tester.tap(find.byTooltip('Split these 3 up'));
      await tester.pumpAndSettle();

      expect(find.text('3 × Prosecco'), findsNothing);
      expect(find.text('Prosecco'), findsNWidgets(3));
      // Numbered, so the clerk can tell which glass is going where.
      expect(find.text('1 of 3'), findsOneWidget);
      expect(find.text('3 of 3'), findsOneWidget);
    });

    testWidgets('one glass can be split off on its own', (tester) async {
      SplitChoice? choice;
      await _open(tester, stateOf(_round), into: (c) => choice = c);
      await tester.tap(find.byTooltip('Split these 3 up'));
      await tester.pumpAndSettle();

      // The first glass, and nothing else.
      await tester.tap(find.text('Prosecco').first);
      await tester.pumpAndSettle();
      await tester.tap(find.textContaining('Split off 1 item'));
      await tester.pumpAndSettle();

      // £7.00 on the card, and the other two glasses and the nuts left over.
      expect(find.text('£7.00'), findsWidgets);

      await tester.tap(find.widgetWithText(FilledButton, 'Done'));
      await tester.pumpAndSettle();

      expect(choice!.mode, SplitMode.byItem);
      expect(choice!.groups!.first, ['p#1']);
      expect(choice!.groups!.last.length, 3); // two glasses and the peanuts
    });

    testWidgets('and the shares still add up to the bill', (tester) async {
      final state = stateOf(_round);
      SplitChoice? choice;
      await _open(tester, state, into: (c) => choice = c);
      await tester.tap(find.byTooltip('Split these 3 up'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Prosecco').first);
      await tester.pumpAndSettle();
      await tester.tap(find.textContaining('Split off 1 item'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, 'Done'));
      await tester.pumpAndSettle();

      final split = state.splitByItems(choice!.groups!);
      expect(
        split.shares.fold<int>(0, (s, x) => s + x.amountMinor),
        state.outstandingMinor,
      );
    });

    testWidgets('a round can be put back together', (tester) async {
      await _open(tester, stateOf(_round));
      await tester.tap(find.byTooltip('Split these 3 up'));
      await tester.pumpAndSettle();
      expect(find.byTooltip('Put these back together'), findsNWidgets(3));

      await tester.tap(find.byTooltip('Put these back together').first);
      await tester.pumpAndSettle();
      expect(find.text('3 × Prosecco'), findsOneWidget);
      expect(find.text('1 of 3'), findsNothing);
    });

    testWidgets('but not once a glass is on somebody’s card', (tester) async {
      await _open(tester, stateOf(_round));
      await tester.tap(find.byTooltip('Split these 3 up'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Prosecco').first);
      await tester.pumpAndSettle();
      await tester.tap(find.textContaining('Split off 1 item'));
      await tester.pumpAndSettle();

      expect(find.byTooltip('Put these back together'), findsNothing);
    });

    // A share paying for one glass must not be handed a bill that says three.
    testWidgets('a share’s bill says how many it is paying for',
        (tester) async {
      Set<String>? printed;
      Map<String, double>? quantities;
      await _open(
        tester,
        stateOf(_round),
        onPrintShare: (ids, title, minor, q) async {
          printed = ids;
          quantities = q;
        },
      );
      await tester.tap(find.byTooltip('Split these 3 up'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Prosecco').first);
      await tester.pumpAndSettle();
      await tester.tap(find.textContaining('Split off 1 item'));
      await tester.pumpAndSettle();

      await tester.tap(find.widgetWithText(OutlinedButton, 'Bill').first);
      await tester.pumpAndSettle();

      // The real line id, because that is what the order holds…
      expect(printed, {'p'});
      // …and one, not three.
      expect(quantities, {'p': 1.0});
    });

    // A round of three with three extra shots is three drinks that each had a
    // shot. Refusing to divide anything carrying a modifier — which is what
    // the venue's previous system does — would only move this same complaint
    // onto every dish with an option on it.
    testWidgets('a modifier is divided with the drink it belongs to',
        (tester) async {
      final withShots = [
        line('p', name: 'Prosecco', price: 700, qty: 3),
        line('s', name: 'Extra shot', price: 150, qty: 3, parent: 'p'),
      ];
      final state = stateOf(withShots);
      SplitChoice? choice;
      await _open(tester, state, into: (c) => choice = c);

      await tester.tap(find.byTooltip('Split these 3 up'));
      await tester.pumpAndSettle();
      // Each glass now carries one shot rather than all three.
      expect(find.text('Extra shot'), findsNWidgets(3));

      await tester.tap(find.text('Prosecco').first);
      await tester.pumpAndSettle();
      await tester.tap(find.textContaining('Split off 1 item'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, 'Done'));
      await tester.pumpAndSettle();

      // The shot goes with the glass, never onto somebody else's card.
      expect(choice!.groups!.first.toSet(), {'p#1', 's#1'});
      final split = state.splitByItems(choice!.groups!);
      expect(split.shares.first.amountMinor, 850);
      expect(
        split.shares.fold<int>(0, (s, x) => s + x.amountMinor),
        state.outstandingMinor,
      );
    });

    testWidgets('undoing the split puts the round back', (tester) async {
      await _open(tester, stateOf(_round));
      await tester.tap(find.byTooltip('Split these 3 up'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Prosecco').first);
      await tester.pumpAndSettle();
      await tester.tap(find.textContaining('Split off 1 item'));
      await tester.pumpAndSettle();

      await tester.tap(find.widgetWithText(TextButton, 'Undo split'));
      await tester.pumpAndSettle();
      expect(find.text('3 × Prosecco'), findsOneWidget);
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
        onPrintShare: (ids, title, minor, quantities) async {
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
