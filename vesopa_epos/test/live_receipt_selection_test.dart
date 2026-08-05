import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/data/pricing_engine.dart';
import 'package:vesopa_epos/ui/theme.dart';
import 'package:vesopa_epos/ui/widgets/live_receipt.dart';

/// How a clerk picks lines out of the bill.
///
/// The rules agreed with the operator: tapping a row selects it, tapping it
/// again puts it back, and the item box is reached from a pencil that only
/// exists on a selected row. No long press anywhere — a hidden gesture has to
/// be taught to every new member of staff.
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
  ]);

  Widget harness({
    required Set<String> selected,
    void Function(PricedLine)? onTap,
    void Function(PricedLine)? onEdit,
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
              onEditLine: onEdit,
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

  testWidgets('the pencil only appears on a selected row', (tester) async {
    await tester.pumpWidget(harness(selected: const {}, onEdit: (_) {}));
    expect(find.byIcon(Icons.edit), findsNothing);

    await tester.pumpWidget(harness(selected: const {'l1'}, onEdit: (_) {}));
    await tester.pump();
    expect(find.byIcon(Icons.edit), findsOneWidget);
  });

  testWidgets('one pencil per selected row, not one per line', (tester) async {
    await tester.pumpWidget(
      harness(selected: const {'l1', 'l2'}, onEdit: (_) {}),
    );
    expect(find.byIcon(Icons.edit), findsNWidgets(2));
  });

  testWidgets('tapping the pencil opens the box for that line', (tester) async {
    final edited = <String>[];
    final tapped = <String>[];
    await tester.pumpWidget(harness(
      selected: const {'l2'},
      onTap: (l) => tapped.add(l.id),
      onEdit: (l) => edited.add(l.id),
    ));

    await tester.tap(find.byIcon(Icons.edit));
    await tester.pump();

    expect(edited, ['l2']);
    // The pencil must not also toggle the row underneath it — the clerk would
    // open the box and lose the selection in the same gesture.
    expect(tapped, isEmpty);
  });

  testWidgets('no pencil when the screen offers no editing', (tester) async {
    // The payment screen passes no onEditLine once money has been taken.
    await tester.pumpWidget(harness(selected: const {'l1'}));
    expect(find.byIcon(Icons.edit), findsNothing);
  });

  testWidgets('holding a row never opens the box', (tester) async {
    // Long press used to be a hidden gesture on these rows. It is gone: with no
    // long-press recognizer registered, holding and releasing is just a slow
    // tap, so it selects like any other tap and cannot reach the item box.
    // That is the point — there is no gesture a clerk has to be told about.
    final tapped = <String>[];
    final edited = <String>[];
    await tester.pumpWidget(harness(
      selected: const {},
      onTap: (l) => tapped.add(l.id),
      onEdit: (l) => edited.add(l.id),
    ));

    await tester.longPress(find.text('Flat white'));
    await tester.pump();

    expect(edited, isEmpty, reason: 'holding must not open the box');
    expect(tapped, ['l1'], reason: 'a slow tap is still a tap');
  });
}
