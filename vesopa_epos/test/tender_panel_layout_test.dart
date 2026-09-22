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

/// Renders the payment board's columns at the sizes real tills run at.
///
/// A layout this dense goes wrong silently: everything on the board is sized as
/// a fraction of the room it is given, so a bad divisor produces a screen that
/// still renders and is simply unusable. These pin the proportions that carry
/// the design's meaning rather than the pixels.
///
/// The one rule under test throughout is the hierarchy. Cash and Card are the
/// biggest keys, the note pictures come next, and the eight function keys are
/// deliberately half the height of the notes above them — which is the whole
/// point of the v1.3.3.0 arrangement, and the thing a careless edit to a
/// SizedBox would quietly undo.
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

  // No imageUrl, so the keys fall back to their labels — which is also what a
  // till with no artwork synced shows, and what makes them findable by text.
  const notes = [
    CashDenomination(valueMinor: 2000, label: '£20', sortOrder: 0),
    CashDenomination(valueMinor: 1000, label: '£10', sortOrder: 1),
    CashDenomination(valueMinor: 500, label: '£5', sortOrder: 2),
  ];

  /// The middle and right columns at the sizes the payment page hands them on a
  /// 1920×1080 till: 844 and 520 wide, 944 tall once the header and the board's
  /// padding have taken their share.
  Widget harness(Widget child, {required Size column}) => MaterialApp(
        theme: buildPosTheme(Brightness.dark),
        home: Scaffold(
          backgroundColor: PayPalette.dark.canvas,
          body: Center(
            child: SizedBox(
              width: column.width,
              height: column.height,
              child: child,
            ),
          ),
        ),
      );

  Widget tenderColumn() => TenderColumn(
        state: TenderState(totals: totals),
        settings: const TenderSettings(),
        denominations: notes,
        amountMinor: totals.totalMinor,
        onTender: (_, _) {},
        noteKeys: CashNotesPanel(
          denominations: notes,
          tally: CashTally.empty,
          onTakeNote: (_) {},
          onUndo: () {},
        ),
        onGratuity: () {},
        onSplit: () {},
        onCustomer: () {},
        onDiscount: () {},
        onPrintBill: () {},
      );

  /// The innermost [Material] wrapping a label — every key on the board is one,
  /// so this measures the key itself rather than a panel around it.
  Size keySize(WidgetTester tester, String label) =>
      tester.getSize(find.widgetWithText(Material, label).first);

  Future<void> pumpColumn(
    WidgetTester tester, {
    Size surface = const Size(1920, 1080),
    Size column = const Size(844, 944),
  }) async {
    await tester.binding.setSurfaceSize(surface);
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(harness(tenderColumn(), column: column));
    await tester.pump();
  }

  testWidgets('the £20/£10/£5 note keys are all present', (tester) async {
    await pumpColumn(tester);
    for (final label in ['£20', '£10', '£5']) {
      expect(find.text(label), findsOneWidget);
    }
  });

  testWidgets('function keys are half the height of the notes above them',
      (tester) async {
    await pumpColumn(tester);

    final note = keySize(tester, '£20');
    final function = keySize(tester, 'Gift card');

    expect(
      function.height,
      lessThan(note.height),
      reason: 'The venue asked for the function keys at half height precisely '
          'so the note pictures could have the room. If these ever match, the '
          'notes have been squeezed back out.',
    );
  });

  testWidgets('Cash and Card are the largest keys on the board',
      (tester) async {
    await pumpColumn(tester);

    final cash = keySize(tester, 'Cash');
    final card = keySize(tester, 'Card');
    final manual = keySize(tester, 'Manual card');
    final function = keySize(tester, 'Voucher');

    expect(cash.height, equals(card.height));
    expect(cash.height, greaterThan(manual.height));
    expect(
      function.height,
      lessThan(cash.height * 0.65),
      reason: 'A clerk reaching for Cash should not have to read the screen; a '
          'clerk reaching for Voucher should.',
    );
  });

  testWidgets('a note is drawn at banknote proportions', (tester) async {
    await pumpColumn(tester);

    final note = keySize(tester, '£20');
    expect(
      note.width / note.height,
      closeTo(1.9, 0.15),
      reason: 'A distorted note is not a picture of a note.',
    );
    expect(
      note.height,
      greaterThan(90),
      reason: "Recognisable at arm's length across a counter.",
    );
  });

  testWidgets('the board survives a short 1366x768 till', (tester) async {
    // The same column, 610px tall rather than 944. Everything scales; nothing
    // may overflow, which the test binding reports as an exception.
    await pumpColumn(
      tester,
      surface: const Size(1366, 768),
      column: const Size(588, 610),
    );

    expect(tester.takeException(), isNull);
    expect(find.text('Cash'), findsOneWidget);
    expect(find.text('Gift card'), findsOneWidget);
    expect(find.text('£20'), findsOneWidget);
  });

  testWidgets('keypad digits stay hand-sized and roughly square',
      (tester) async {
    await tester.binding.setSurfaceSize(const Size(1920, 1080));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    await tester.pumpWidget(
      harness(
        PayKeypad(
          state: TenderState(totals: totals),
          settings: const TenderSettings(),
          entry: '',
          amountMinor: totals.totalMinor,
          onKey: (_) {},
          onTender: (_, _) {},
        ),
        column: const Size(520, 944),
      ),
    );
    await tester.pump();

    final key = keySize(tester, '7');
    expect(key.width, greaterThan(60), reason: 'Comfortably tappable.');
    expect(key.width, lessThan(260), reason: 'Still a calculator, not a bar.');
    expect(
      key.width / key.height,
      closeTo(1.0, 0.5),
      reason: 'A number pad is sized by the hand using it. The old 2.1:1 keys '
          'read as wide bars.',
    );
  });
}
