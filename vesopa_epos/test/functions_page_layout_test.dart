import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/main.dart';
import 'package:vesopa_epos/ui/functions_page.dart';
import 'package:vesopa_epos/ui/theme.dart';

/// The Functions page at real till sizes.
///
/// It used to be a three-column grid, so on a desktop till every key grew to
/// roughly 600px — eight slabs of flat colour that were no quicker to hit for
/// being enormous. These pin the key size and the grouping.
void main() {
  // The Shift group (Sign On / Sign Off) asks whether this terminal has any
  // staff cached, which reaches the till's database. Stubbed here rather than
  // opened: this is a layout test, and an unstubbed drift stream leaves a pending
  // timer behind when the provider scope is torn down, which fails the test for
  // reasons that have nothing to do with the layout.
  //
  // False, so the fixed set of keys is what gets measured. The Shift group's own
  // behaviour is not this file's subject.
  Widget harness() => ProviderScope(
        overrides: [canSignOnProvider.overrideWithValue(false)],
        child: MaterialApp(
          theme: buildPosTheme(Brightness.light),
          home: Scaffold(
            body: FunctionsPage(
              orderId: 'o1',
              onGoToReports: () {},
              onGoToReceipts: () {},
              onGoToTables: () {},
            ),
          ),
        ),
      );

  testWidgets('keys keep their size on a 1920px till', (tester) async {
    await tester.binding.setSurfaceSize(const Size(1920, 1080));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(harness());
    await tester.pump();

    final tile = tester.getSize(
      find.ancestor(
        of: find.text('Save to Table'),
        matching: find.byType(SizedBox),
      ).first,
    );
    expect(tile.width, lessThan(320),
        reason: 'A till key is a fixed size, not a share of the window.');
    expect(tile.width, greaterThan(150));
  });

  testWidgets('every function is grouped under a heading', (tester) async {
    await tester.binding.setSurfaceSize(const Size(1920, 1080));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(harness());
    await tester.pump();

    for (final heading in ['THIS SALE', 'RECEIPTS', 'CASH & CARD', 'END OF DAY']) {
      expect(find.text(heading), findsOneWidget);
    }
    // Nothing lost in the regrouping.
    for (final key in [
      'Save to Table',
      'Tables',
      'Reprint Last',
      'Receipt History',
      'No Sale',
      'Card Machine',
      'X Report',
      'Z Report',
    ]) {
      expect(find.text(key), findsOneWidget, reason: '$key should be present');
    }
  });

  testWidgets('desktop layout golden', (tester) async {
    await tester.binding.setSurfaceSize(const Size(1500, 950));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(harness());
    await tester.pump();
    await expectLater(
      find.byType(MaterialApp),
      matchesGoldenFile('goldens/functions_page_desktop.png'),
    );
  }, tags: 'golden');
}
