import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/data/local/database.dart';
import 'package:vesopa_epos/data/screens.dart';
import 'package:vesopa_epos/ui/theme.dart';
import 'package:vesopa_epos/ui/widgets/programmed_grid.dart';

/// The face of a programmed key: the picture, and how it is framed.
///
/// Two things are being guarded here, and they are the same thing twice.
///
/// **A key with a picture is a picture.** "If there is an image on the button
/// the button doesn't show the product name, just the image" — a photograph of
/// a burger is a better burger key than the word BURGER over a sliver of one.
/// The name comes back per key, on a tick, for the venue that wants both.
///
/// **The framing is four numbers, not a second upload.** A venue lays its
/// screen out in whatever sizes suit it — a 2x2 for the house burger, a 1x3
/// strip for the wine list — and one photograph has to look right in all of
/// them. Before this, a picture was drawn one way only, so a tall bottle shot
/// on a wide key was a label of glass with the bottle cropped out of frame.
///
/// The arithmetic is written twice — here and in the back office's preview,
/// which is what a manager actually aims with — so the order of the two
/// transforms is what these check. Scale first, then shift, and the shift is a
/// fraction of the *key's* size. Get that backwards and the editor shows a
/// manager something a clerk will never see.
void main() {
  Product product({
    int pluId = 1,
    String name = 'Carling',
    int price = 450,
    String? imageUrl,
  }) => Product(
    pluId: pluId,
    name: name,
    priceMinor: price,
    taxPercentage: 20,
    stockQuantity: 0,
    printToReceipt: true,
    imageUrl: imageUrl,
  );

  Widget host({
    required List<ScreenButton> buttons,
    List<Product> catalogue = const [],
    int rows = 2,
    int cols = 2,
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
          width: 800,
          height: 600,
          child: ProgrammedGrid(
            screen: screen,
            screens: ScreenSet([screen]),
            products: {for (final p in catalogue) p.pluId: p},
            onProduct: (_) {},
            onPage: (_) {},
            onFunction: (_) {},
          ),
        ),
      ),
    );
  }

  const picture = 'https://example.invalid/burger.png';

  group('a key with a picture', () {
    testWidgets('does not letter its name over it', (tester) async {
      await tester.pumpWidget(
        host(
          buttons: [
            const ScreenButton(
              row: 0,
              col: 0,
              kind: ScreenButtonKind.product,
              pluId: 1,
              imageUrl: picture,
            ),
          ],
          catalogue: [product()],
        ),
      );

      expect(find.text('Carling'), findsNothing);
      // The price goes with the name. "Just the image" means just the image;
      // half of it would be a key that looks unfinished rather than one that
      // looks like a photograph.
      expect(find.text('£4.50'), findsNothing);
      expect(find.byType(Image), findsOneWidget);
    });

    testWidgets('unless that one key has been told to', (tester) async {
      await tester.pumpWidget(
        host(
          buttons: [
            const ScreenButton(
              row: 0,
              col: 0,
              kind: ScreenButtonKind.product,
              pluId: 1,
              imageUrl: picture,
              showLabel: true,
            ),
          ],
          catalogue: [product()],
        ),
      );

      expect(find.text('Carling'), findsOneWidget);
      expect(find.text('£4.50'), findsOneWidget);
      expect(find.byType(Image), findsOneWidget);
    });

    // The fallback that stops this un-decorating every screen a venue had
    // already programmed: a key with no picture of its own still wears the
    // product's, and is a picture key for every purpose including this one.
    testWidgets('borrowed from the product counts as a picture', (
      tester,
    ) async {
      await tester.pumpWidget(
        host(
          buttons: [
            const ScreenButton(
              row: 0,
              col: 0,
              kind: ScreenButtonKind.product,
              pluId: 1,
            ),
          ],
          catalogue: [product(imageUrl: picture)],
        ),
      );

      expect(find.byType(Image), findsOneWidget);
      expect(find.text('Carling'), findsNothing);
    });

    testWidgets('and a key with no picture still says its name', (
      tester,
    ) async {
      await tester.pumpWidget(
        host(
          buttons: [
            const ScreenButton(
              row: 0,
              col: 0,
              kind: ScreenButtonKind.product,
              pluId: 1,
            ),
          ],
          catalogue: [product()],
        ),
      );

      expect(find.text('Carling'), findsOneWidget);
      expect(find.byType(Image), findsNothing);
    });
  });

  group('how the picture is framed', () {
    /// The transforms the key actually built, innermost first.
    ///
    /// Read off the tree rather than off the button, because the point is the
    /// composition: two transforms in the wrong order put the picture
    /// somewhere else entirely at any zoom but 100%.
    ({double scale, Offset shift}) framing(WidgetTester tester) {
      final scale = tester.widget<Transform>(
        find.ancestor(
          of: find.byType(Image),
          matching: find.byType(Transform),
        ).first,
      );
      final translate = tester.widget<Transform>(
        find.ancestor(
          of: find.byType(Image),
          matching: find.byType(Transform),
        ).at(1),
      );
      return (
        scale: scale.transform.getMaxScaleOnAxis(),
        shift: Offset(
          translate.transform.getTranslation().x,
          translate.transform.getTranslation().y,
        ),
      );
    }

    testWidgets('an untouched picture fills the key, unzoomed and centred', (
      tester,
    ) async {
      await tester.pumpWidget(
        host(
          buttons: [
            const ScreenButton(
              row: 0,
              col: 0,
              kind: ScreenButtonKind.product,
              pluId: 1,
              imageUrl: picture,
            ),
          ],
          catalogue: [product()],
        ),
      );

      final image = tester.widget<Image>(find.byType(Image));
      expect(image.fit, BoxFit.cover);
      final f = framing(tester);
      expect(f.scale, closeTo(1.0, 0.001));
      expect(f.shift, Offset.zero);
    });

    testWidgets('“whole picture” is contain, not a crop', (tester) async {
      await tester.pumpWidget(
        host(
          buttons: [
            const ScreenButton(
              row: 0,
              col: 0,
              kind: ScreenButtonKind.product,
              pluId: 1,
              imageUrl: picture,
              imageFit: ScreenImageFit.contain,
            ),
          ],
          catalogue: [product()],
        ),
      );

      expect(tester.widget<Image>(find.byType(Image)).fit, BoxFit.contain);
    });

    testWidgets('the shift is a fraction of the key, not of the picture', (
      tester,
    ) async {
      // A 2x2 key on a 2x2 grid: it is the whole 800x600 box, less the grid's
      // own 12px padding and with no gaps to cross. -25% of that width is what
      // the picture must move, whatever the zoom says.
      await tester.pumpWidget(
        host(
          buttons: [
            const ScreenButton(
              row: 0,
              col: 0,
              rowSpan: 2,
              colSpan: 2,
              kind: ScreenButtonKind.product,
              pluId: 1,
              imageUrl: picture,
              imageScale: 250,
              imageX: -25,
              imageY: 10,
            ),
          ],
          catalogue: [product()],
        ),
      );

      final key = tester.getSize(
        find.ancestor(
          of: find.byType(Image),
          matching: find.byType(ClipRect),
        ).first,
      );
      final f = framing(tester);

      // Scaled by the zoom …
      expect(f.scale, closeTo(2.5, 0.001));
      // … and shifted by a quarter of the *key*, not of the picture blown up
      // two and a half times. That is the difference the order of the two
      // transforms makes, and the reason it is written down in both places.
      expect(f.shift.dx, closeTo(key.width * -0.25, 0.5));
      expect(f.shift.dy, closeTo(key.height * 0.10, 0.5));
    });
  });

  group('a space the venue set aside', () {
    testWidgets('draws nothing at all, and holds its ground', (tester) async {
      await tester.pumpWidget(
        host(
          buttons: [
            // A 2x2 reservation over the whole grid, and one real key that
            // cannot be there — the reservation covers it, which is what the
            // editor and the server both refuse to save.
            const ScreenButton(
              row: 0,
              col: 0,
              rowSpan: 2,
              colSpan: 2,
              kind: ScreenButtonKind.blank,
            ),
          ],
          catalogue: [product()],
        ),
      );

      // No key, no name, no crash. A key a clerk can see and cannot press is
      // worse than a gap.
      expect(find.byType(InkWell), findsNothing);
      expect(find.text('Carling'), findsNothing);
    });

    testWidgets('leaves the keys around it alone', (tester) async {
      await tester.pumpWidget(
        host(
          buttons: [
            const ScreenButton(
              row: 0,
              col: 0,
              colSpan: 2,
              kind: ScreenButtonKind.blank,
            ),
            const ScreenButton(
              row: 1,
              col: 0,
              kind: ScreenButtonKind.product,
              pluId: 1,
            ),
          ],
          catalogue: [product()],
        ),
      );

      expect(find.text('Carling'), findsOneWidget);
    });
  });
}
