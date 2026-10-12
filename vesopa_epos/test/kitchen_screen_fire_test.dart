import 'dart:convert';

import 'package:drift/drift.dart' hide isNull;
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vesopa_epos/data/kitchen_printing.dart';
import 'package:vesopa_epos/data/kitchen_screens.dart';
import 'package:vesopa_epos/data/local/database.dart';
import 'package:vesopa_epos/data/printer_settings.dart';
import 'package:vesopa_epos/printing/print_targets.dart';

/// A venue set up like Pontardawe RFC: food routed to KP1, KP1 set to the
/// kitchen screen, no printers bound on the till.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late AppDatabase db;
  late List<Map<String, dynamic>> posted;
  late KitchenScreenSender sender;

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    db = AppDatabase.forTesting(NativeDatabase.memory());
    posted = [];
    sender = KitchenScreenSender(
      apiBase: 'https://example.test',
      office: 'venue@example.com',
      client: MockClient((http.Request req) async {
        posted.add(jsonDecode(req.body) as Map<String, dynamic>);
        return http.Response('{"status":"accepted"}', 201);
      }),
    );

    await db.into(db.products).insert(
      ProductsCompanion.insert(
        pluId: const Value(136),
        name: 'Kids Breakfast',
        priceMinor: 450,
        printerRoutes: const Value('kp1'),
      ),
    );
    await db.into(db.products).insert(
      ProductsCompanion.insert(pluId: const Value(1), name: 'Pint', priceMinor: 450),
    );
    await db.into(db.orders).insert(
      OrdersCompanion.insert(id: 'order-1', tableNumber: const Value(4)),
    );
    await db.into(db.orderLines).insert(
      OrderLinesCompanion.insert(
        id: 'line-1',
        orderId: 'order-1',
        pluId: 136,
        name: 'Kids Breakfast',
        unitPriceMinor: 450,
      ),
    );
    await db.into(db.orderLines).insert(
      OrderLinesCompanion.insert(
        id: 'line-2',
        orderId: 'order-1',
        pluId: 1,
        name: 'Pint',
        unitPriceMinor: 450,
      ),
    );
  });

  tearDown(() => db.close());

  test('food routed to a screen station reaches the kitchen screens', () async {
    final result = await KitchenPrinting(db).fire(
      orderId: 'order-1',
      reason: KitchenFire.table,
      printers: const PrinterSettings(),
      delivery: const {'kp1': KitchenDelivery.screen},
      screens: sender,
      office: 'venue@example.com',
    );

    expect(result.screens?.delivered, isTrue, reason: result.summary);
    expect(posted, hasLength(1));
    final lines = posted.single['lines'] as List;
    expect(lines, hasLength(1));
    expect((lines.single as Map)['name'], 'Kids Breakfast');
    expect((lines.single as Map)['stations'], 'kp1');
  });
}
