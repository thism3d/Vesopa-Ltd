import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/data/local/database.dart';
import 'package:vesopa_epos/ui/price_override_dialog.dart';
import 'package:vesopa_epos/ui/product_lookup_sheet.dart';

Product product(int plu, String name, int price, {String? department}) => Product(
      pluId: plu,
      name: name,
      priceMinor: price,
      departmentName: department,
      taxPercentage: 0,
      stockQuantity: 0,
      printToReceipt: true,
    );

final _catalogue = [
  product(1, 'Coca-Cola', 250, department: 'Soft Drinks'),
  product(2, 'Diet Coke', 250, department: 'Soft Drinks'),
  product(3, 'Coffee', 300, department: 'Hot Drinks'),
  product(4, 'House Red', 550, department: 'Wine'),
];

OrderLine line({double quantity = 1, int unitPriceMinor = 400}) => OrderLine(
      id: 'l1',
      orderId: 'o1',
      pluId: 1,
      name: 'House Red',
      quantity: quantity,
      unitPriceMinor: unitPriceMinor,
      taxPercentage: 0,
      lineDiscountMinor: 0,
    );

Future<Product?> openLookup(WidgetTester tester, LookupMode mode) async {
  Product? picked;
  await tester.pumpWidget(
    ProviderScope(
      child: MaterialApp(
        home: Scaffold(
          body: Consumer(
            builder: (context, ref, _) => TextButton(
              onPressed: () async {
                picked = await showProductLookup(
                  context,
                  ref,
                  mode: mode,
                  products: _catalogue,
                );
              },
              child: const Text('open'),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('open'));
  await tester.pumpAndSettle();
  return picked;
}

void main() {
  group('finding a product', () {
    testWidgets('nothing is listed until something is typed', (tester) async {
      await openLookup(tester, LookupMode.ring);
      expect(find.text('Coca-Cola'), findsNothing);
      expect(find.textContaining('Type a name'), findsOneWidget);
    });

    testWidgets('a name that starts with the query comes first',
        (tester) async {
      // "co" matches three: Coca-Cola and Coffee start with it, Diet Coke
      // merely contains it. The two that start with it have to come first,
      // or the catalogue's own order decides and the thing being looked for
      // is halfway down a list of things that are not.
      await openLookup(tester, LookupMode.ring);
      await tester.enterText(find.byType(TextField), 'co');
      await tester.pumpAndSettle();

      final names = tester
          .widgetList<ListTile>(find.byType(ListTile))
          .map((t) => (t.title! as Text).data)
          .toList();
      expect(names, ['Coca-Cola', 'Coffee', 'Diet Coke']);
    });

    testWidgets('a PLU finds its product', (tester) async {
      await openLookup(tester, LookupMode.ring);
      await tester.enterText(find.byType(TextField), '4');
      await tester.pumpAndSettle();
      expect(find.text('House Red'), findsOneWidget);
    });

    testWidgets('a query that matches nothing says so', (tester) async {
      await openLookup(tester, LookupMode.ring);
      await tester.enterText(find.byType(TextField), 'zzzz');
      await tester.pumpAndSettle();
      expect(find.textContaining('Nothing matches'), findsOneWidget);
    });
  });

  group('what a tap does', () {
    testWidgets('a price check rings nothing up', (tester) async {
      // The failure this mode exists to avoid: the sheet is opened
      // mid-conversation with a customer, and an item landing on the bill
      // because somebody tapped a row is worse than no feature at all.
      await openLookup(tester, LookupMode.priceCheck);
      await tester.enterText(find.byType(TextField), 'coffee');
      await tester.pumpAndSettle();

      final tile = tester.widget<ListTile>(find.byType(ListTile));
      expect(tile.onTap, isNull, reason: 'a price check row must be inert');
    });

    testWidgets('a search rings the item that was tapped', (tester) async {
      Product? picked;
      await tester.pumpWidget(
        ProviderScope(
          child: MaterialApp(
            home: Scaffold(
              body: Consumer(
                builder: (context, ref, _) => TextButton(
                  onPressed: () async => picked = await showProductLookup(
                    context,
                    ref,
                    mode: LookupMode.ring,
                    products: _catalogue,
                  ),
                  child: const Text('open'),
                ),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField), 'house');
      await tester.pumpAndSettle();
      await tester.tap(find.text('House Red'));
      await tester.pumpAndSettle();

      expect(picked?.pluId, 4);
    });

    testWidgets('the price is the loudest thing on a price check',
        (tester) async {
      await openLookup(tester, LookupMode.priceCheck);
      await tester.enterText(find.byType(TextField), 'house');
      await tester.pumpAndSettle();

      final price = tester.widget<Text>(find.text('£5.50'));
      expect(price.style!.fontSize, greaterThan(18));
    });
  });

  group('overriding a price', () {
    Future<int?> open(WidgetTester tester, OrderLine l) async {
      int? result;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Builder(
              builder: (context) => TextButton(
                onPressed: () async => result = await showPriceOverride(
                  context,
                  l,
                ),
                child: const Text('open'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      return result;
    }

    testWidgets('it says what the line was charging', (tester) async {
      await open(tester, line());
      expect(find.text('Now £4.00 each'), findsOneWidget);
    });

    testWidgets('it says what the line will come to, not what was typed',
        (tester) async {
      // Override to £7.00 on a line of three is £21.00. A clerk who has only
      // seen "7.00" on the keypad has been given the wrong figure to read out.
      await open(tester, line(quantity: 3));
      await tester.enterText(find.byType(TextField), '7.00');
      await tester.pumpAndSettle();
      expect(find.text('£21.00'), findsOneWidget);
      expect(find.textContaining('3 × £7.00'), findsOneWidget);
    });

    testWidgets('setting it free is allowed, and said out loud',
        (tester) async {
      await open(tester, line());
      await tester.enterText(find.byType(TextField), '0');
      await tester.pumpAndSettle();
      expect(find.text('This line will be free.'), findsOneWidget);
    });

    testWidgets('nothing typed cannot be confirmed', (tester) async {
      await open(tester, line());
      final button = tester.widget<FilledButton>(
        find.widgetWithText(FilledButton, 'Set price'),
      );
      expect(button.onPressed, isNull);
    });

    testWidgets('a price comes back in pence', (tester) async {
      // Pounds in the box because that is what a shelf label says; pence
      // everywhere below it, as everywhere else in the till.
      int? result;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Builder(
              builder: (context) => TextButton(
                onPressed: () async =>
                    result = await showPriceOverride(context, line()),
                child: const Text('open'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField), '3.25');
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, 'Set price'));
      await tester.pumpAndSettle();
      expect(result, 325);
    });

    testWidgets('a negative price cannot be confirmed', (tester) async {
      await open(tester, line());
      await tester.enterText(find.byType(TextField), '-2');
      await tester.pumpAndSettle();
      final button = tester.widget<FilledButton>(
        find.widgetWithText(FilledButton, 'Set price'),
      );
      expect(button.onPressed, isNull);
    });
  });
}
