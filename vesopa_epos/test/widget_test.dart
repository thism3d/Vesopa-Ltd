import 'package:drift/drift.dart' show Value;
import 'package:drift/native.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/data/local/database.dart';
import 'package:vesopa_epos/main.dart';
import 'package:vesopa_epos/ui/sale_page.dart';

void main() {
  testWidgets('ringing up a product shows it in the basket with a total',
      (tester) async {
    final db = AppDatabase.forTesting(NativeDatabase.memory());

    // The tree has to come down *before* the database does.
    //
    // `addTearDown(db.close)` on its own hung this test for ten minutes: tear-
    // downs run last-registered-first, so the database closed while the sale
    // screen's StreamBuilders were still subscribed. Cancelling a drift stream
    // on a closed database schedules a zero-duration timer (StreamQueryStore.
    // markAsClosed) that the test's fake clock never runs, and flutter_test
    // waits out its full timeout on the pending timer.
    //
    // Pumping an empty widget unmounts the subscribers first, so the streams are
    // already cancelled by the time the database goes.
    addTearDown(() async {
      await tester.pumpWidget(const SizedBox.shrink());
      await db.close();
    });

    await db.into(db.products).insert(
          ProductsCompanion.insert(
            pluId: const Value(1),
            name: 'Cola',
            departmentName: const Value('Drinks'),
            priceMinor: 150,
            taxPercentage: const Value(20),
          ),
        );

    const orderId = 'test-order';
    await db.into(db.orders).insert(
          const OrdersCompanion(id: Value(orderId)),
        );

    await tester.pumpWidget(
      ProviderScope(
        overrides: [databaseProvider.overrideWithValue(db)],
        child: MaterialApp(
          home: Scaffold(
            body: SalePage(
              orderId: orderId,
              onNewOrder: () {},
              onSwitchOrder: (_) {},
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    // The category rail is driven by the catalogue's departments, not a
    // hardcoded menu.
    expect(find.text('Drinks'), findsOneWidget);
    expect(find.text('Cola'), findsOneWidget);

    await tester.tap(find.text('Cola'));
    await tester.pumpAndSettle();

    // Cola now appears twice: once on the grid, once on the bill.
    expect(find.text('Cola'), findsNWidgets(2));
    // The default 800x600 test surface is a *tablet* by the app's breakpoints,
    // so the bill renders as the LiveReceipt beside the grid rather than the
    // phone's pull-up basket. That lays the quantity out as its own column
    // ("1"), not as the basket's "1x - " prefix — which is why this assertion
    // had gone stale.
    expect(find.text('1'), findsWidgets);
    expect(find.text('£1.50'), findsWidgets);
  });
}
