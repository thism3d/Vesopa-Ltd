import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vesopa_go/counter/data/journal.dart';
import 'package:vesopa_go/main.dart';

/// Table service in the demo, on The Vesopa Kitchen's menu: sign on, seat
/// Table 1 for two, wings with a sauce and a steak with its cooking (the
/// counter's choice sheet, at the table), send to the kitchen, take the bill by
/// tap. The table's sale is then in the same day's Sales and Reports as the
/// counter's: one app, one journal.
void main() {
  testWidgets('demo: PIN, table, order, send, pay, and it is in the day', (tester) async {
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    FlutterSecureStorage.setMockInitialValues({});
    SharedPreferences.setMockInitialValues({});
    Journal.persist = false;

    Future<void> tap(Finder f) async {
      await tester.tap(f);
      await tester.pumpAndSettle();
    }

    await tester.pumpWidget(const ProviderScope(child: GoApp()));
    await tester.pumpAndSettle();
    await tap(find.byKey(const ValueKey('demo')));
    for (final d in ['1', '1', '1', '1']) {
      await tester.tap(find.byKey(ValueKey('pin-$d')));
      await tester.pump();
    }
    await tester.pumpAndSettle();
    expect(find.byTooltip('Sam'), findsOneWidget, reason: 'signed on as Sam');

    await tap(find.byTooltip('Open navigation menu'));
    await tap(find.text('Tables').last);
    await tap(find.text('Table 1'));
    await tap(find.text('2'));

    // Starters first: the wings ask for their sauce on the counter's sheet.
    await tap(find.text('Chicken Wings'));
    await tap(find.text('Buffalo'));
    await tap(find.byKey(const ValueKey('add')));
    await tester.ensureVisible(find.text('Mains'));
    await tester.pumpAndSettle();
    await tap(find.text('Mains'));
    await tap(find.text('Steak & Chips'));
    await tap(find.text('Medium'));
    await tap(find.byKey(const ValueKey('add')));

    // The table's bill is on the sale screen, as on the till.
    expect(find.text('Table 1'), findsWidgets);
    await tap(find.byKey(const ValueKey('pay')));
    await tap(find.byKey(const ValueKey('pay-card')));
    if (find.text('No tip').evaluate().isNotEmpty) await tap(find.text('No tip'));
    await tester.pump(const Duration(seconds: 3));
    await tester.pumpAndSettle();
    expect(find.text('Payment approved!'), findsOneWidget);
    await tap(find.byKey(const ValueKey('new-sale')));

    // Back to the shell: the table's sale is in today's Sales and Reports.
    while (find.byTooltip('Open navigation menu').evaluate().isEmpty) {
      await tester.pageBack();
      await tester.pumpAndSettle();
    }
    await tap(find.byTooltip('Open navigation menu'));
    await tap(find.text('Sales').last);
    expect(find.textContaining('Receipt 1'), findsOneWidget);
    await tap(find.byTooltip('Open navigation menu'));
    await tap(find.text('Reports').last);
    expect(find.text('£29.50'), findsWidgets);
  });
}
