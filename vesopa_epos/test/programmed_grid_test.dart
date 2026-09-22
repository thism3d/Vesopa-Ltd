import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/data/commerce.dart';
import 'package:vesopa_epos/data/local/database.dart';
import 'package:vesopa_epos/data/pricing_engine.dart';
import 'package:vesopa_epos/data/screens.dart';
import 'package:vesopa_epos/ui/theme.dart';
import 'package:vesopa_epos/ui/widgets/programmed_grid.dart';

/// A venue's programmed sale screen, drawn.
///
/// These exist because of the gap between where a layout is made and where it
/// is used. It is arranged in an office, over a catalogue that keeps changing,
/// weeks before a clerk stands in front of it — and by the time they do, the
/// product may have been deleted, the screen a button jumps to may have been
/// removed, and the till may be an older build than the back office that wrote
/// the button.
///
/// **Every one of those has to come out as a key on a screen.** A blank key is
/// one a clerk presses twice before asking anybody; an exception is a till that
/// has stopped taking money in front of a queue.
void main() {
  Product product({
    int pluId = 1,
    String name = 'Carling',
    int price = 450,
    String? emoji,
    String? department,
  }) => Product(
    pluId: pluId,
    name: name,
    priceMinor: price,
    taxPercentage: 20,
    stockQuantity: 0,
    printToReceipt: true,
    emoji: emoji,
    departmentName: department,
  );

  ScreenButton button({
    int row = 0,
    int col = 0,
    int rowSpan = 1,
    int colSpan = 1,
    ScreenButtonKind kind = ScreenButtonKind.product,
    int? pluId = 1,
    int? targetScreenId,
    String? functionKey,
    String? label,
    Color? fill,
  }) => ScreenButton(
    row: row,
    col: col,
    rowSpan: rowSpan,
    colSpan: colSpan,
    kind: kind,
    pluId: pluId,
    targetScreenId: targetScreenId,
    functionKey: functionKey,
    label: label,
    fill: fill,
  );

  /// The grid under test, with whatever the caller wants behind it.
  Widget host({
    required List<ScreenButton> buttons,
    List<TillScreen> others = const [],
    List<Product> catalogue = const [],
    List<Promotion> promotions = const [],
    int rows = 3,
    int cols = 3,
    bool showPrices = true,
    void Function(Product)? onProduct,
    void Function(TillScreen)? onPage,
    void Function(String)? onFunction,
  }) {
    final screen = TillScreen(
      id: 1,
      name: 'Home',
      rows: rows,
      cols: cols,
      buttons: buttons,
    );

    return MaterialApp(
      theme: buildPosTheme(Brightness.light),
      home: Scaffold(
        body: SizedBox(
          width: 900,
          height: 600,
          child: ProgrammedGrid(
            screen: screen,
            screens: ScreenSet([screen, ...others]),
            products: {for (final p in catalogue) p.pluId: p},
            promotions: PricingEngine(promotions: promotions),
            showPrices: showPrices,
            onProduct: onProduct ?? (_) {},
            onPage: onPage ?? (_) {},
            onFunction: onFunction ?? (_) {},
            onModifier: (_) {},
          ),
        ),
      ),
    );
  }

  group('what a key says', () {
    testWidgets('a product key carries its name and price', (tester) async {
      await tester.pumpWidget(
        host(buttons: [button()], catalogue: [product()]),
      );

      expect(find.text('Carling'), findsOneWidget);
      expect(find.text('£4.50'), findsOneWidget);
    });

    testWidgets('the venue’s own wording wins over the product’s', (
      tester,
    ) async {
      await tester.pumpWidget(
        host(
          buttons: [button(label: '1/2 Carling')],
          catalogue: [product()],
        ),
      );

      expect(find.text('1/2 Carling'), findsOneWidget);
      expect(find.text('Carling'), findsNothing);
    });

    // Set once per venue in the back office. A venue that hides prices on its
    // keys must not have them reappear here.
    testWidgets('prices can be turned off', (tester) async {
      await tester.pumpWidget(
        host(
          buttons: [button()],
          catalogue: [product()],
          showPrices: false,
        ),
      );

      expect(find.text('Carling'), findsOneWidget);
      expect(find.text('£4.50'), findsNothing);
    });

    testWidgets('a page key names the screen it goes to', (tester) async {
      await tester.pumpWidget(
        host(
          buttons: [
            button(kind: ScreenButtonKind.page, pluId: null, targetScreenId: 2),
          ],
          others: const [TillScreen(id: 2, name: 'Spirits')],
        ),
      );

      expect(find.text('Spirits'), findsOneWidget);
      expect(find.text('›››'), findsOneWidget);
    });

    testWidgets('a function key names the function, not its key', (
      tester,
    ) async {
      await tester.pumpWidget(
        host(
          buttons: [
            button(
              kind: ScreenButtonKind.function,
              pluId: null,
              functionKey: 'covers',
            ),
          ],
        ),
      );

      expect(find.text('Covers'), findsOneWidget);
    });
  });

  group('what a key does', () {
    testWidgets('a product key rings that product up', (tester) async {
      final rung = <Product>[];
      await tester.pumpWidget(
        host(
          buttons: [button()],
          catalogue: [product()],
          onProduct: rung.add,
        ),
      );

      await tester.tap(find.text('Carling'));
      await tester.pump();

      expect(rung, hasLength(1));
      expect(rung.single.pluId, 1);
    });

    testWidgets('a page key asks for that screen', (tester) async {
      final opened = <TillScreen>[];
      await tester.pumpWidget(
        host(
          buttons: [
            button(kind: ScreenButtonKind.page, pluId: null, targetScreenId: 2),
          ],
          others: const [TillScreen(id: 2, name: 'Spirits')],
          onPage: opened.add,
        ),
      );

      await tester.tap(find.text('Spirits'));
      await tester.pump();

      expect(opened.single.id, 2);
    });

    testWidgets('a function key asks for that function', (tester) async {
      final ran = <String>[];
      await tester.pumpWidget(
        host(
          buttons: [
            button(
              kind: ScreenButtonKind.function,
              pluId: null,
              functionKey: 'print_bill',
            ),
          ],
          onFunction: ran.add,
        ),
      );

      await tester.tap(find.text('Print bill'));
      await tester.pump();

      expect(ran, ['print_bill']);
    });
  });

  // The whole reason this widget resolves label and action together.
  group('when what a key points at has gone', () {
    testWidgets('a deleted product draws, says why, and refuses the press', (
      tester,
    ) async {
      final rung = <Product>[];
      await tester.pumpWidget(
        // The catalogue does not have plu 1 any more.
        host(buttons: [button()], catalogue: const [], onProduct: rung.add),
      );

      expect(tester.takeException(), isNull);
      expect(find.text('Unavailable'), findsOneWidget);
      expect(find.text('Not in the catalogue'), findsOneWidget);

      await tester.tap(find.text('Unavailable'));
      await tester.pump();
      expect(rung, isEmpty, reason: 'it rang up a product that does not exist');
    });

    testWidgets('a deleted target screen does the same', (tester) async {
      final opened = <TillScreen>[];
      await tester.pumpWidget(
        host(
          buttons: [
            // Points at a screen that is not in the set.
            button(kind: ScreenButtonKind.page, pluId: null, targetScreenId: 99),
          ],
          onPage: opened.add,
        ),
      );

      expect(tester.takeException(), isNull);
      expect(find.text('Screen removed'), findsOneWidget);

      await tester.tap(find.text('Unavailable'));
      await tester.pump();
      expect(opened, isEmpty);
    });

    // The reason `kind` is a string on the wire. A till running behind the back
    // office meets a button it has never heard of; it must keep the layout's
    // shape and explain the gap, not drop the key and leave somebody hunting.
    testWidgets('a button from a newer release is inert, not missing', (
      tester,
    ) async {
      final ran = <String>[];
      await tester.pumpWidget(
        host(
          buttons: [button(kind: ScreenButtonKind.unknown, pluId: null)],
          onFunction: ran.add,
        ),
      );

      expect(tester.takeException(), isNull);
      expect(find.text('Not supported'), findsOneWidget);
      expect(find.text('Update the till'), findsOneWidget);

      await tester.tap(find.text('Not supported'));
      await tester.pump();
      expect(ran, isEmpty);
    });

    testWidgets('a function key with nothing bound to it is inert', (
      tester,
    ) async {
      final ran = <String>[];
      await tester.pumpWidget(
        host(
          buttons: [
            button(
              kind: ScreenButtonKind.function,
              pluId: null,
              functionKey: null,
            ),
          ],
          onFunction: ran.add,
        ),
      );

      await tester.tap(find.text('Unset'));
      await tester.pump();
      expect(ran, isEmpty);
    });
  });

  group('the grid itself', () {
    testWidgets('an empty cell draws nothing at all', (tester) async {
      await tester.pumpWidget(
        host(buttons: [button()], catalogue: [product()], rows: 3, cols: 3),
      );

      // One key on a 3x3, not nine — an unprogrammed cell is empty space, not
      // an empty key a clerk might press.
      expect(find.byType(InkWell), findsOneWidget);
    });

    testWidgets('a spanning key draws once, not once per cell', (tester) async {
      await tester.pumpWidget(
        host(
          buttons: [button(rowSpan: 2, colSpan: 2)],
          catalogue: [product()],
        ),
      );

      expect(find.text('Carling'), findsOneWidget);
      expect(find.byType(InkWell), findsOneWidget);
    });

    testWidgets('a spanning key is actually bigger', (tester) async {
      await tester.pumpWidget(
        host(buttons: [button()], catalogue: [product()], rows: 2, cols: 2),
      );
      final small = tester.getSize(find.byType(InkWell).first);

      await tester.pumpWidget(
        host(
          buttons: [button(rowSpan: 2, colSpan: 2)],
          catalogue: [product()],
          rows: 2,
          cols: 2,
        ),
      );
      final large = tester.getSize(find.byType(InkWell).first);

      expect(large.width, greaterThan(small.width));
      expect(large.height, greaterThan(small.height));
    });

    // The reason a button is a grid cell rather than a pixel rectangle: the
    // same layout has to work on a 1920 counter till and a 1280 handheld.
    for (final size in const [Size(1280, 800), Size(1920, 1080), Size(1024, 768)]) {
      testWidgets(
        'a full grid fits at ${size.width.toInt()}x${size.height.toInt()}',
        (tester) async {
          tester.view.physicalSize = size;
          tester.view.devicePixelRatio = 1.0;
          addTearDown(tester.view.reset);

          await tester.pumpWidget(
            MaterialApp(
              theme: buildPosTheme(Brightness.light),
              home: Scaffold(
                body: ProgrammedGrid(
                  screen: TillScreen(
                    id: 1,
                    name: 'Home',
                    rows: 5,
                    cols: 6,
                    buttons: [
                      for (var r = 0; r < 5; r++)
                        for (var c = 0; c < 6; c++)
                          button(row: r, col: c, pluId: 1),
                    ],
                  ),
                  screens: const ScreenSet([]),
                  products: {1: product(name: 'A Rather Long Product Name')},
                  onProduct: (_) {},
                  onPage: (_) {},
                  onFunction: (_) {},
                  onModifier: (_) {},
                ),
              ),
            ),
          );

          expect(tester.takeException(), isNull);
          expect(find.byType(InkWell), findsNWidgets(30));
        },
      );
    }
  });

  // The catalogue grid has always drawn a product's picture or emoji, and its
  // offer flash. A programmed screen drew neither — so a venue that
  // photographed its menu lost every picture the moment it laid out its own
  // screen, and a promotion showed on one screen and not the other. Which of
  // the two a clerk is standing in front of must not change what a product
  // costs or looks like.
  group('a key carries what the catalogue grid carries', () {
    testWidgets('a product’s emoji is drawn on its key', (tester) async {
      await tester.pumpWidget(
        host(
          buttons: [button()],
          catalogue: [product(emoji: '🍺')],
          rows: 2,
          cols: 2,
        ),
      );

      expect(find.text('🍺'), findsOneWidget);
      expect(find.text('Carling'), findsOneWidget, reason: 'the name went');
    });

    // A key on a 10x12 grid is smaller than a postage stamp on a handheld. The
    // picture gives way there rather than squeezing the name out — the name is
    // the part a clerk reads.
    testWidgets('a key too small for a picture keeps its name and price', (
      tester,
    ) async {
      await tester.pumpWidget(
        host(
          buttons: [button()],
          catalogue: [product(emoji: '🍺')],
          rows: 10,
          cols: 12,
        ),
      );

      expect(find.text('🍺'), findsNothing);
      expect(find.text('Carling'), findsOneWidget);
    });

    testWidgets('an offer running on the product flashes on the key', (
      tester,
    ) async {
      await tester.pumpWidget(
        host(
          buttons: [button()],
          catalogue: [product(department: 'Beers')],
          promotions: const [
            Promotion(
              id: 1,
              name: 'Happy hour',
              kind: 'percent',
              value: 500,
              scope: 'product',
              scopeValue: '1',
              badgeText: 'HALF PRICE',
              products: [1],
            ),
          ],
          rows: 2,
          cols: 2,
        ),
      );

      expect(find.text('HALF PRICE'), findsOneWidget);
    });

    testWidgets('a key with no offer has no flash', (tester) async {
      await tester.pumpWidget(
        host(buttons: [button()], catalogue: [product()], rows: 2, cols: 2),
      );

      expect(find.text('HALF PRICE'), findsNothing);
    });
  });
}
