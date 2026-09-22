import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show FontLoader, rootBundle;
import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/data/local/database.dart';
import 'package:vesopa_epos/data/screens.dart';
import 'package:vesopa_epos/ui/theme.dart';
import 'package:vesopa_epos/ui/widgets/programmed_grid.dart';

/// What a programmed sale screen actually looks like.
///
/// A picture, not an assertion. The behavioural cover is in
/// `programmed_grid_test.dart`; this exists because a layout editor is a visual
/// feature and "the labels are right and nothing overflowed" is not the same
/// claim as "it looks like a till". Regenerate with:
///
///     flutter test --update-goldens test/programmed_grid_golden_test.dart
///
/// The venue below is deliberately a realistic one rather than a tidy one: a
/// spanning key, a page link, a function key, an unstyled key sitting next to
/// coloured ones, and a product that has been deleted from the catalogue since
/// the layout was made — which is the state this widget exists to survive.
void main() {
  // Real type, not the test harness's placeholder.
  //
  // Without this every label renders as a black rectangle and the golden is a
  // picture of the layout with none of the words in it — which, for a feature
  // whose whole subject is what the keys say, is most of the value gone. The
  // font is already bundled for the receipt PDF (see pubspec) so there is
  // nothing to add but the loading.
  setUpAll(() async {
    final loader = FontLoader('OpenSans')
      ..addFont(rootBundle.load('assets/fonts/OpenSans-Regular.ttf'))
      ..addFont(rootBundle.load('assets/fonts/OpenSans-Bold.ttf'));
    await loader.load();
  });

  Product product(int plu, String name, int price) => Product(
    pluId: plu,
    name: name,
    priceMinor: price,
    taxPercentage: 20,
    stockQuantity: 0,
    printToReceipt: true,
  );

  testWidgets('a venue’s programmed screen', (tester) async {
    tester.view.physicalSize = const Size(1280, 720);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    const home = TillScreen(
      id: 1,
      name: 'Drinks',
      rows: 4,
      cols: 5,
      buttons: [
        // A row of draughts, in the venue's own colours.
        ScreenButton(
          row: 0,
          col: 0,
          kind: ScreenButtonKind.product,
          pluId: 1,
          fill: Color(0xFFF4F6FA),
        ),
        ScreenButton(
          row: 0,
          col: 1,
          kind: ScreenButtonKind.product,
          pluId: 2,
          fill: Color(0xFF00A6A6),
        ),
        ScreenButton(
          row: 0,
          col: 2,
          kind: ScreenButtonKind.product,
          pluId: 3,
          fill: Color(0xFFD03227),
        ),
        // Unstyled — the till picks, which is what keeps a half-finished
        // screen looking like Vesopa rather than looking broken.
        ScreenButton(
          row: 1,
          col: 0,
          kind: ScreenButtonKind.product,
          pluId: 4,
        ),
        ScreenButton(
          row: 1,
          col: 1,
          kind: ScreenButtonKind.product,
          pluId: 5,
          fill: Color(0xFF111111),
        ),
        // The one that has been deleted from the catalogue since.
        ScreenButton(
          row: 1,
          col: 2,
          kind: ScreenButtonKind.product,
          pluId: 999,
        ),
        // A wide key, to show a span carrying its own proportions.
        ScreenButton(
          row: 2,
          col: 0,
          colSpan: 2,
          kind: ScreenButtonKind.product,
          pluId: 6,
          fill: Color(0xFF21A73E),
        ),
        ScreenButton(
          row: 2,
          col: 2,
          kind: ScreenButtonKind.function,
          functionKey: 'covers',
          fill: Color(0xFF1E2430),
        ),
        ScreenButton(
          row: 3,
          col: 0,
          kind: ScreenButtonKind.function,
          functionKey: 'note',
          fill: Color(0xFF1E2430),
        ),
        ScreenButton(
          row: 3,
          col: 1,
          kind: ScreenButtonKind.function,
          functionKey: 'print_bill',
          fill: Color(0xFF1E2430),
        ),
        // The category column: page links, stacked. Tall, because that is what
        // the venue in the reference did with theirs.
        ScreenButton(
          row: 0,
          col: 4,
          rowSpan: 2,
          kind: ScreenButtonKind.page,
          targetScreenId: 2,
          fill: Color(0xFF2B1E3A),
        ),
        ScreenButton(
          row: 2,
          col: 4,
          rowSpan: 2,
          kind: ScreenButtonKind.page,
          targetScreenId: 3,
          label: 'FOOD',
          fill: Color(0xFFA5C715),
        ),
      ],
    );

    await tester.pumpWidget(
      MaterialApp(
        theme: buildPosTheme(Brightness.light).copyWith(
          textTheme: buildPosTheme(
            Brightness.light,
          ).textTheme.apply(fontFamily: 'OpenSans'),
        ),
        home: Scaffold(
          backgroundColor: PayPalette.light.canvas,
          body: ProgrammedGrid(
            screen: home,
            screens: const ScreenSet([
              home,
              TillScreen(id: 2, name: 'Spirits'),
              TillScreen(id: 3, name: 'Food'),
            ]),
            products: {
              for (final p in [
                product(1, 'Carling', 450),
                product(2, 'Coors', 470),
                product(3, 'Madri', 520),
                product(4, 'Guinness', 560),
                product(5, 'Thatchers Gold', 490),
                product(6, 'House Red 175ml', 650),
              ])
                p.pluId: p,
            },
            onProduct: (_) {},
            onPage: (_) {},
            onFunction: (_) {},
            onModifier: (_) {},
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    await expectLater(
      find.byType(ProgrammedGrid),
      matchesGoldenFile('goldens/programmed_grid.png'),
    );
  });
}
