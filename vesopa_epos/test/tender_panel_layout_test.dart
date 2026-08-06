import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/data/cash_tally.dart';
import 'package:vesopa_epos/data/commerce.dart';
import 'package:vesopa_epos/data/local/database.dart';
import 'package:vesopa_epos/data/pricing_engine.dart';
import 'package:vesopa_epos/data/tender_engine.dart';
import 'package:vesopa_epos/ui/theme.dart';
import 'package:vesopa_epos/ui/widgets/cash_notes_panel.dart';
import 'package:vesopa_epos/ui/widgets/tender_panel.dart';

/// Renders the payment screen's tender panel at the sizes real tills run at.
///
/// A layout this dense goes wrong silently — the keypad takes its width from
/// its parent, so "more room" stretched every key into a banner without any
/// error to catch it. These pin the shapes that matter instead.
void main() {
  final totals = PricingEngine(promotions: const []).price([
    const PricedLine(
      id: 'l1',
      pluid: 1,
      name: 'Flat white',
      quantity: 2,
      unitPriceMinor: 320,
      taxPercentage: 20,
    ),
  ]);

  Widget harness(Widget child, {required double width}) => MaterialApp(
        theme: buildPosTheme(Brightness.light),
        home: Scaffold(
          body: Row(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              // Stands in for the live receipt, at the width the payment page
              // gives it.
              const SizedBox(width: 320),
              Expanded(
                child: SingleChildScrollView(
                  padding: const EdgeInsets.all(14),
                  child: child,
                ),
              ),
            ],
          ),
        ),
      );

  Widget panel() => TenderPanel(
        state: TenderState(totals: totals),
        settings: const TenderSettings(),
        entry: '',
        onKey: (_) {},
        onTender: (_, _) {},
        onGratuity: () {},
        onSplit: () {},
        onCustomer: () {},
        onDiscount: () {},
        compact: true,
      );

  /// The keypad must stay hand-sized whatever the screen does. Three keys per
  /// row across a 1920px till is what made the payment screen unusable.
  Future<double> keyWidth(WidgetTester tester, double surface) async {
    await tester.binding.setSurfaceSize(Size(surface, 1080));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(harness(panel(), width: surface));
    await tester.pump();
    return tester.getSize(find.widgetWithText(Material, '7').first).width;
  }

  testWidgets('keypad keys stay hand-sized on a 1920px till', (tester) async {
    final width = await keyWidth(tester, 1920);
    expect(width, lessThan(130),
        reason: 'A 3-column keypad on a wide till must not stretch its keys.');
    expect(width, greaterThan(60), reason: 'Still comfortably tappable.');
  });

  testWidgets('keypad keys stay hand-sized on a 1366px till', (tester) async {
    final width = await keyWidth(tester, 1366);
    expect(width, lessThan(130));
    expect(width, greaterThan(60));
  });

  testWidgets('narrow dock keeps the single-column stack', (tester) async {
    await tester.binding.setSurfaceSize(const Size(760, 1024));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(harness(panel(), width: 760));
    await tester.pump();

    // 760 - 320 receipt - padding leaves well under the two-column threshold,
    // so Cash and Card sit below the keypad rather than beside it.
    final keypad = tester.getTopLeft(find.widgetWithText(Material, '7').first);
    final cash = tester.getTopLeft(find.widgetWithText(FilledButton, 'Cash'));
    expect(cash.dy, greaterThan(keypad.dy));
  });

  testWidgets('wide till puts Cash and Card beside the keypad', (tester) async {
    await tester.binding.setSurfaceSize(const Size(1920, 1080));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(harness(panel(), width: 1920));
    await tester.pump();

    final keypad = tester.getTopLeft(find.widgetWithText(Material, '7').first);
    final cash = tester.getTopLeft(find.widgetWithText(FilledButton, 'Cash'));
    expect(cash.dx, greaterThan(keypad.dx),
        reason: 'The tender column sits to the right of the entry column.');
  });

  testWidgets('the £20/£10/£5 note keys are all present', (tester) async {
    await tester.binding.setSurfaceSize(const Size(1920, 1080));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    // The note keys are no longer drawn by TenderPanel — they moved into
    // CashNotesPanel, which the payment screen builds and hands in as
    // `cashNotes` so the tender panel stays free of database and tally concerns.
    // This test had gone stale against that refactor: it was asserting on labels
    // TenderPanel cannot render, because `panel()` passes no cashNotes at all.
    // Handing it the real panel is what actually pins the keys being present.
    await tester.pumpWidget(
      harness(
        TenderPanel(
          state: TenderState(totals: totals),
          settings: const TenderSettings(),
          entry: '',
          onKey: (_) {},
          onTender: (_, _) {},
          compact: true,
          cashNotes: CashNotesPanel(
            denominations: const [
              CashDenomination(valueMinor: 2000, label: '£20', sortOrder: 0),
              CashDenomination(valueMinor: 1000, label: '£10', sortOrder: 1),
              CashDenomination(valueMinor: 500, label: '£5', sortOrder: 2),
            ],
            tally: CashTally.empty,
            dueMinor: totals.totalMinor,
            changeMinor: 0,
            onTakeNote: (_) {},
            onUndo: () {},
          ),
        ),
        width: 1920,
      ),
    );
    await tester.pump();

    for (final label in ['£20', '£10', '£5']) {
      expect(find.text(label), findsOneWidget);
    }
  });

  // A picture of the wide layout, so the arrangement can be eyeballed rather
  // than inferred from coordinates. Refresh with:
  //   flutter test test/tender_panel_layout_test.dart --update-goldens
  testWidgets('wide layout golden', (tester) async {
    await tester.binding.setSurfaceSize(const Size(1500, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(harness(panel(), width: 1500));
    await tester.pump();
    await expectLater(
      find.byType(MaterialApp),
      matchesGoldenFile('goldens/tender_panel_wide.png'),
    );
  });
}
