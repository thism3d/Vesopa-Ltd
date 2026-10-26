import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vesopa_epos_lite/data/journal.dart';
import 'package:vesopa_epos_lite/main.dart';

/// A bar service in the demo: sign on, a half of Fosters (portion sheet), a
/// Budweiser (allergen alert), a 10% discount, £20 cash with change, then a
/// card sale, a refund, the reports and End of day.
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

      await tester.pumpWidget(const ProviderScope(child: LiteApp()));
      await tester.pumpAndSettle();
      await tapKey(tester, 'demo');
      for (final d in ['1', '1', '1', '1']) {
        await tester.tap(find.byKey(ValueKey('pin-$d')));
        await tester.pump();
      }
      await tester.pumpAndSettle();
      expect(find.text('Sam'), findsOneWidget);

      // Draught opens first: Fosters asks for its portion; take a half.
      await tapKey(tester, 'item-d5');
      expect(find.text('Add  £4.20'), findsOneWidget, reason: 'a pint is chosen to start with');
      await tester.tap(find.text('Half'));
      await tester.pumpAndSettle();
      await tapKey(tester, 'add');

      // Bottles: a Budweiser rings straight up, with its allergen alert.
      await tapKey(tester, 'cat-bottles');
      await tapKey(tester, 'item-b2');
      expect(find.textContaining('Budweiser contains gluten'), findsOneWidget);
      await tapKey(tester, 'item-b6');
      expect(find.text('Alcohol-free Lager is sold out'), findsOneWidget);

      // Spirits need a measure (preselected) but the mixer is optional.
      await tapKey(tester, 'cat-spirits');
      await tapKey(tester, 'item-s3');
      await tester.tap(find.text('Tonic'));
      await tester.pumpAndSettle();
      await tapKey(tester, 'add');

      // 1.90 + 3.60 + 4.70 = 10.20; then 10% off on the sale.
      if (name == 'phone') {
        expect(find.text('Pay £10.20'), findsOneWidget);
        await tapKey(tester, 'view-sale');
      }
      await tester.tap(find.text('Discount'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('10%'));
      await tester.pumpAndSettle();
      expect(find.text('Pay £9.18'), findsWidgets);
      await tapKey(tester, 'panel-pay');

      // £20 note: change £10.82.
      expect(find.text('To pay'), findsOneWidget);
      await tapKey(tester, 'cash-2000');
      expect(find.text('£10.82'), findsOneWidget);
      await tapKey(tester, 'new-sale');

      // A card sale: Gin, single, no mixer, by tap (the demo's pretend card).
      await tapKey(tester, 'cat-spirits');
      await tapKey(tester, 'item-s3');
      await tapKey(tester, 'add');
      if (name == 'phone') {
        await tapKey(tester, 'pay');
      } else {
        await tapKey(tester, 'panel-pay');
      }
      await tester.tap(find.byKey(const ValueKey('pay-card')));
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
      await tester.tap(find.text('Refund £3.80'));
      await tester.pumpAndSettle();
      expect(find.text('£3.80 refunded to the card'), findsOneWidget);
      expect(find.text('Refunded in full'), findsOneWidget);
      await tester.pageBack();
      await tester.pump(const Duration(seconds: 5)); // the refund notice goes
      await tester.pumpAndSettle();

      // Reports: net £12.98 (9.18 + 3.80), cash 9.18 in the drawer.
      await tester.tap(find.byTooltip('Open navigation menu'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Reports').last);
      await tester.pumpAndSettle();
      expect(find.text('£12.98'), findsWidgets);
      expect(find.text('Spirits'), findsOneWidget);
      await tester.scrollUntilVisible(find.byKey(const ValueKey('end-of-day')), 300, scrollable: find.byType(Scrollable).last);
      await tapKey(tester, 'end-of-day');
      expect(find.textContaining('Count £9.18 in the drawer'), findsOneWidget);
      await tester.tap(find.text('End the day'));
      await tester.pumpAndSettle();
      expect(find.textContaining('Z 1'), findsOneWidget);
    });
  }
}
