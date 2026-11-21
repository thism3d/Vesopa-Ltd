import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/data/pricing_engine.dart';
import 'package:vesopa_epos/ui/theme.dart';
import 'package:vesopa_epos/ui/widgets/live_receipt.dart';

/// How a clerk picks lines out of the bill.
///
/// The rules agreed with the operator: tapping a row selects it, tapping it
/// again puts it back. A picked row is only highlighted: no tick, no
/// "1 × selected", no pencil and no item box (Nicky, 2026-11-18). ↓ ↑ and
/// select all sit beside the totals. No long press anywhere.
void main() {
  final totals = PricingEngine(promotions: const []).price(const [
    PricedLine(
      id: 'l1',
      pluid: 1,
      name: 'Flat white',
      quantity: 1,
      unitPriceMinor: 350,
      taxPercentage: 20,
    ),
    PricedLine(
      id: 'l2',
      pluid: 2,
      name: 'Croissant',
      quantity: 2,
      unitPriceMinor: 250,
      taxPercentage: 20,
    ),
  ], dealMinor: 0);

  Widget harness({
    required Set<String> selected,
    void Function(PricedLine)? onTap,
    void Function(Set<String>)? onSelect,
  }) =>
      MaterialApp(
        theme: buildPosTheme(Brightness.light),
        home: Scaffold(
          body: SizedBox(
            width: 340,
            height: 600,
            child: LiveReceipt(
              totals: totals,
              selectedLineIds: selected,
              onTapLine: onTap,
              onSelectLines: onSelect,
            ),
          ),
        ),
      );

  testWidgets('tapping an unselected line selects it', (tester) async {
    final tapped = <String>[];
    await tester.pumpWidget(harness(
      selected: const {},
      onTap: (l) => tapped.add(l.id),
    ));

    await tester.tap(find.text('Flat white'));
    await tester.pump();

    expect(tapped, ['l1']);
  });

  testWidgets('tapping a selected line again puts it back', (tester) async {
    // The page toggles, so the same callback firing is what "deselect" is: a
    // second tap must reach onTapLine rather than being swallowed by the row
    // opening the item box, which is what it used to do.
    final tapped = <String>[];
    await tester.pumpWidget(harness(
      selected: const {'l1'},
      onTap: (l) => tapped.add(l.id),
    ));

    await tester.tap(find.text('Flat white'));
    await tester.pump();

    expect(tapped, ['l1']);
  });

  testWidgets('a picked row is only highlighted', (tester) async {
    await tester.pumpWidget(harness(selected: const {'l1', 'l2'}));
    await tester.pump();
    expect(find.byIcon(Icons.edit), findsNothing);
    expect(find.byIcon(Icons.check_circle), findsNothing);
    expect(find.textContaining('selected'), findsNothing);
    // The quantity stays where it always is.
    expect(find.text('2'), findsOneWidget);
  });

  testWidgets('no arrows when the screen does not pick lines', (tester) async {
    await tester.pumpWidget(harness(selected: const {}));
    expect(find.byIcon(Icons.arrow_downward_rounded), findsNothing);
  });

  testWidgets('down picks the first item, then the next', (tester) async {
    final picks = <Set<String>>[];
    await tester.pumpWidget(harness(selected: const {}, onSelect: picks.add));
    await tester.tap(find.byIcon(Icons.arrow_downward_rounded));
    expect(picks.last, {'l1'});

    await tester.pumpWidget(harness(selected: const {'l1'}, onSelect: picks.add));
    await tester.tap(find.byIcon(Icons.arrow_downward_rounded));
    expect(picks.last, {'l2'});

    // At the bottom it stays on the last item.
    await tester.pumpWidget(harness(selected: const {'l2'}, onSelect: picks.add));
    await tester.tap(find.byIcon(Icons.arrow_downward_rounded));
    expect(picks.last, {'l2'});
  });

  testWidgets('up picks the last item, then the one before', (tester) async {
    final picks = <Set<String>>[];
    await tester.pumpWidget(harness(selected: const {}, onSelect: picks.add));
    await tester.tap(find.byIcon(Icons.arrow_upward_rounded));
    expect(picks.last, {'l2'});

    await tester.pumpWidget(harness(selected: const {'l2'}, onSelect: picks.add));
    await tester.tap(find.byIcon(Icons.arrow_upward_rounded));
    expect(picks.last, {'l1'});
  });

  testWidgets('select all picks every item, and again puts them back', (tester) async {
    final picks = <Set<String>>[];
    await tester.pumpWidget(harness(selected: const {'l1'}, onSelect: picks.add));
    await tester.tap(find.byIcon(Icons.checklist_rounded));
    expect(picks.last, {'l1', 'l2'});

    await tester.pumpWidget(harness(selected: const {'l1', 'l2'}, onSelect: picks.add));
    await tester.tap(find.byIcon(Icons.remove_done_rounded));
    expect(picks.last, isEmpty);
  });

  testWidgets('holding a row never opens the box', (tester) async {
    // Long press used to be a hidden gesture on these rows. It is gone: with no
    // long-press recognizer registered, holding and releasing is just a slow
    // tap, so it selects like any other tap and cannot reach the item box.
    // That is the point — there is no gesture a clerk has to be told about.
    final tapped = <String>[];
    await tester.pumpWidget(harness(
      selected: const {},
      onTap: (l) => tapped.add(l.id),
    ));

    await tester.longPress(find.text('Flat white'));
    await tester.pump();

    expect(tapped, ['l1'], reason: 'a slow tap is still a tap');
  });
}
