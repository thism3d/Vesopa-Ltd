// Stock on the kitchen screen (2026-09-27): what can still be made, Sold out
// on the QR menu's own switch, wastage by cases or units, and recipe measures.

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vesopa_epos_kitchen/data/kitchen_api.dart';
import 'package:vesopa_epos_kitchen/data/kitchen_stock.dart';
import 'package:vesopa_epos_kitchen/data/providers.dart';
import 'package:vesopa_epos_kitchen/ui/stock_board.dart';
import 'package:vesopa_epos_kitchen/ui/theme.dart';

final _availability = [
  {
    'pluid': 103,
    'product_name': 'Burger',
    'level': 'untracked',
    'stock_quantity': null,
    'can_make': 5,
    'on_menu': true,
    'sold_out': false,
    'printer_routes': 'kp1',
    'recipe': [
      {'product_name': 'Bun', 'quantity': 1, 'stock_unit': null},
      {'product_name': 'Patty', 'quantity': 2, 'stock_unit': null},
    ],
  },
  {'pluid': 104, 'product_name': 'Bun', 'level': 'low', 'stock_quantity': 5, 'can_make': 5, 'on_menu': false, 'sold_out': false, 'pack_name': 'Pack of 12', 'pack_units': 12, 'recipe': []},
  {'pluid': 109, 'product_name': 'Ribs', 'level': 'ok', 'stock_quantity': 0, 'can_make': 0, 'on_menu': true, 'sold_out': true, 'printer_routes': 'kp1', 'recipe': []},
  {'pluid': 110, 'product_name': 'Salad', 'level': 'ok', 'stock_quantity': 20, 'can_make': 20, 'on_menu': true, 'sold_out': false, 'printer_routes': 'kp1', 'recipe': []},
];

void main() {
  test('reading what the server says', () {
    final burger = KitchenStockItem(_availability[0]);
    expect(burger.canMake, 5);
    expect(burger.recipe.map((m) => m.label), ['1 × Bun', '2 × Patty']);
    expect(burger.routes, {'kp1'});
    final bun = KitchenStockItem(_availability[1]);
    expect(bun.hasCase, isTrue);
    expect(bun.needsAttention, isTrue, reason: 'low');
    expect(KitchenStockItem(_availability[3]).needsAttention, isFalse);
    expect(joinQty('1', '3', 12), 15);
    expect(joinQty('', '', 12), isNull);
    expect(const KitchenStockState().byName('x'), isNull);
    expect(KitchenStockState(items: [burger]).byName('  burger '), same(burger));
  });

  testWidgets('the Stock tab: what needs attention, Sold out and Waste', (tester) async {
    SharedPreferences.setMockInitialValues({});
    tester.view.physicalSize = const Size(1600, 1000);
    tester.view.devicePixelRatio = 1;
    final posts = <String, Map<String, dynamic>>{};
    final client = MockClient((req) async {
      if (req.url.path == '/api/kitchen/stock/availability') return http.Response(jsonEncode(_availability), 200);
      posts[req.url.path] = jsonDecode(req.body) as Map<String, dynamic>;
      expect(req.headers['Authorization'], 'Bearer kitchen-token');
      return http.Response('{"ok":true}', 200);
    });
    await tester.pumpWidget(ProviderScope(
      overrides: [
        kitchenApiProvider.overrideWithValue(KitchenApi(apiBase: 'http://k.test')..token = 'kitchen-token'),
        apiBaseProvider.overrideWithValue('http://k.test'),
        kitchenHttpClientProvider.overrideWithValue(client),
      ],
      child: MaterialApp(theme: Kds.theme(), home: const Scaffold(body: StockBoard())),
    ));
    await tester.pumpAndSettle();

    // Needs attention: sold out first, then none left, then low. Salad is fine.
    expect(find.byKey(const Key('stock-row-109')), findsOneWidget);
    expect(find.byKey(const Key('stock-row-104')), findsOneWidget);
    expect(find.byKey(const Key('stock-row-110')), findsNothing);
    expect(tester.widget<Text>(find.byKey(const Key('stock-left-109'))).data, 'Sold out');

    // Back on.
    await tester.tap(find.byKey(const Key('sold-out-109')));
    await tester.pumpAndSettle();
    expect(posts['/api/kitchen/stock/sold-out'], {'pluid': 109, 'sold_out': false});

    // Waste one case and three buns.
    await tester.tap(find.byKey(const Key('waste-104')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('waste-cases')), '1');
    await tester.enterText(find.byKey(const Key('waste-units')), '3');
    await tester.pumpAndSettle();
    expect(find.text('= 15 units'), findsOneWidget);
    await tester.tap(find.text('Burnt'));
    await tester.tap(find.byKey(const Key('waste-ok')));
    await tester.pumpAndSettle();
    final doc = posts['/api/kitchen/stock/docs']!;
    expect(doc['kind'], 'wastage');
    expect(doc['lines'], [
      {'pluid': 104, 'quantity': 15.0, 'reason': 'Burnt'},
    ]);

    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 5));
    tester.view.resetPhysicalSize();
    tester.view.resetDevicePixelRatio();
  });
}
