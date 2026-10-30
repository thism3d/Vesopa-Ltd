import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vesopa_go/counter/data/journal.dart';
import 'package:vesopa_go/main.dart';

/// A service in the demo (The Vesopa Kitchen's menu): sign on, wings with a
/// sauce (choice sheet), a Carling Half (allergen alert), an IPA with an
/// optional mixer, a 10% discount, £20 cash with change, then a card sale, a
/// refund, the reports and End of day.
void main() {
  Future<void> tapKey(WidgetTester tester, String key) async {
    await tester.tap(find.byKey(ValueKey(key)));
    await tester.pumpAndSettle();
  }

  for (final (name, size) in [('phone', const Size(1080, 2340)), ('tablet', const Size(2560, 1600))]) {
    testWidgets('demo service on a $name', (tester) async {
      tester.view.physicalSize = size;
      tester.view.devicePixelRatio = name == 'phone' ? 3 : 2;
      addTearDown(tester.view.reset);
      FlutterSecureStorage.setMockInitialValues({});
      SharedPreferences.setMockInitialValues({});
      Journal.persist = false;

      await tester.pumpWidget(const ProviderScope(child: GoApp()));
      await tester.pumpAndSettle();
      await tapKey(tester, 'demo');
      for (final d in ['1', '1', '1', '1']) {
        await tester.tap(find.byKey(ValueKey('pin-$d')));
        await tester.pump();
      }
      await tester.pumpAndSettle();
      expect(find.byTooltip('Sam'), findsOneWidget);

      // Starters open first. Garlic Bread is off today; the wings ask for a sauce.
      await tapKey(tester, 'item-p145');
      expect(find.text('Garlic Bread is sold out'), findsOneWidget);
      await tapKey(tester, 'item-p147');
      expect(find.text('Choose sauce'), findsOneWidget, reason: 'a real choice is never made for you');
      await tester.tap(find.text('Buffalo'));
      await tester.pumpAndSettle();
      await tapKey(tester, 'add');

      // Beers & cider: a Carling Half rings straight up, with its allergen alert;
      // the IPA's mixer is optional.
      await tapKey(tester, 'cat-beers-cider');
      await tapKey(tester, 'item-p123');
      expect(find.textContaining('Carling Half contains celery'), findsOneWidget);
      await tapKey(tester, 'item-p124');
      expect(find.text('Add  £3.00'), findsOneWidget);
      await tester.tap(find.text('Tonic'));
      await tester.pumpAndSettle();
      await tapKey(tester, 'add');

      // 7.50 + 6.05 + 3.80 = 17.35; then 10% off on the sale.
      if (name == 'phone') {
        expect(find.text('Pay £17.35'), findsOneWidget);
        await tapKey(tester, 'view-sale');
      }
      await tester.tap(find.text('Discount'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('10%'));
      await tester.pumpAndSettle();
      // The till's discount dialog shows the bill after it, then Apply.
      await tester.tap(find.text('Apply'));
      await tester.pumpAndSettle();
      expect(find.text('Pay £15.61'), findsWidgets);
      await tapKey(tester, 'panel-pay');

      // £20 note: change £4.39.
      // The till's payment page: the note pictures take cash at a tap.
      expect(find.text('TO PAY'), findsOneWidget);
      await tester.ensureVisible(find.byKey(const ValueKey('cash-2000')));
      await tester.pumpAndSettle();
      await tapKey(tester, 'cash-2000');
      expect(find.text('£4.39'), findsOneWidget);
      await tapKey(tester, 'new-sale');

      // A card sale: an IPA, no mixer, by tap (the demo's pretend card).
      await tapKey(tester, 'cat-beers-cider');
      await tapKey(tester, 'item-p124');
      await tapKey(tester, 'add');
      if (name == 'phone') {
        await tapKey(tester, 'pay');
      } else {
        await tapKey(tester, 'panel-pay');
      }
      await tester.tap(find.byKey(const ValueKey('pay-card')));
      await tester.pumpAndSettle();
      // The customer's tip screen comes first: no tip.
      await tester.tap(find.text('No tip'));
      await tester.pump(const Duration(seconds: 3));
      await tester.pumpAndSettle();
      expect(find.text('Payment approved!'), findsOneWidget);
      await tapKey(tester, 'new-sale');

      // Sales: refund the card sale (Sam is a manager: no PIN asked).
      await tester.tap(find.byTooltip('Open navigation menu'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Sales').last);
      await tester.pumpAndSettle();
      await tester.tap(find.textContaining('Receipt 2'));
      await tester.pumpAndSettle();
      await tapKey(tester, 'refund');
      await tester.tap(find.text('Refund £3.00'));
      await tester.pumpAndSettle();
      expect(find.text('£3.00 refunded to the card'), findsOneWidget);
      expect(find.text('Refunded in full'), findsOneWidget);
      await tester.pageBack();
      await tester.pump(const Duration(seconds: 5)); // the refund notice goes
      await tester.pumpAndSettle();

      // Reports: net £18.61 (15.61 + 3.00), cash 15.61 in the drawer.
      await tester.tap(find.byTooltip('Open navigation menu'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Reports').last);
      await tester.pumpAndSettle();
      expect(find.text('£18.61'), findsWidgets);
      // Below the hourly chart on a phone: scroll to it.
      await tester.scrollUntilVisible(find.text('Beers & cider'), 300, scrollable: find.byType(Scrollable).last);
      expect(find.text('Beers & cider'), findsOneWidget);
      await tester.scrollUntilVisible(find.byKey(const ValueKey('end-of-day')), 300, scrollable: find.byType(Scrollable).last);
      await tapKey(tester, 'end-of-day');
      expect(find.textContaining('Count £15.61 in the drawer'), findsOneWidget);
      await tester.tap(find.text('End the day'));
      await tester.pumpAndSettle();
      expect(find.textContaining('Z 1'), findsOneWidget);
    });
  }
}
