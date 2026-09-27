// The till's Products page and product editor against the back office's
// ledger (2026-09-27): no false "Out of stock" on a child, a recipe or a
// non-stock product; the case size and unit cost on the row; the editor's
// sections, GP calculator, child products and a save that reaches the server
// rather than this till's copy.

import 'dart:convert';

import 'package:drift/native.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:vesopa_epos/data/local/database.dart';
import 'package:vesopa_epos/data/stock_api.dart';
import 'package:vesopa_epos/main.dart';
import 'package:vesopa_epos/ui/product_editor.dart';
import 'package:vesopa_epos/ui/products_page.dart';

Product local(int plu, String name, {double stock = 0, String dept = 'Bar', String? group}) => Product(
      pluId: plu,
      name: name,
      priceMinor: 450,
      departmentName: dept,
      groupName: group,
      taxPercentage: 20,
      stockQuantity: stock,
      printToReceipt: true,
      renewsMembership: false,
      isModifier: false,
    );

Map<String, dynamic> remote(int id, String name, {int? pack, double? stock, String level = 'ok', bool linked = false, bool recipe = false, bool nonStock = false, int? parent, double? ratio, double? cost}) => {
      'id': id,
      'pluid': 100 + id,
      'product_name': name,
      'department_name': 'Bar',
      'group_name': 'Draught',
      'pack_size_id': pack,
      'pack_name': pack == 2 ? 'Pack of 24' : null,
      'pack_units': pack == 2 ? 24 : null,
      'stock_quantity': stock,
      'stock_display': stock == null ? 'Not tracked' : '$stock',
      'level': level,
      'stock_item': pack != null && !nonStock && !linked && !recipe,
      'non_stock': nonStock ? 1 : 0,
      'is_linked': linked,
      'is_recipe': recipe,
      'stock_parent_pluid': parent,
      'stock_ratio': ratio,
      'unit_cost_minor': ((cost ?? 0) * 100).round(),
      'cost_price': cost,
      'price': 4.5,
      'tax_percentage': 20,
    };

class FakeServer {
  final stock = <Map<String, dynamic>>[
    remote(1, 'Carling Pint', pack: 2, stock: 40, cost: 1.2),
    remote(2, 'Carling Half', stock: null, level: 'untracked', linked: true, parent: 101, ratio: 0.5),
    remote(3, 'Mojito', stock: null, level: 'untracked', recipe: true),
    remote(4, 'Crisps', stock: 0, level: 'out', nonStock: true),
    remote(5, 'Peroni', pack: 2, stock: 0, level: 'out'),
  ];
  final calls = <String>[];
  final bodies = <String, List<Map<String, dynamic>>>{};

  late final client = MockClient((req) async {
    final key = '${req.method} ${req.url.path}';
    calls.add(key);
    final body = req.body.isEmpty ? <String, dynamic>{} : jsonDecode(req.body) as Map<String, dynamic>;
    bodies.putIfAbsent(key, () => []).add(body);
    switch (key) {
      case 'GET /till/stock/products':
        return http.Response(jsonEncode(stock), 200);
      case 'GET /till/stock/pack-sizes':
        return http.Response(jsonEncode([{'id': 2, 'name': 'Pack of 24', 'units': 24}]), 200);
      case 'GET /till/stock/suppliers':
        return http.Response(jsonEncode([{'id': 9, 'name': 'Molson Coors', 'active': 1}]), 200);
      case 'POST /till/products/new':
        return http.Response(jsonEncode({'id': 60, 'pluid': 160}), 201);
    }
    if (req.method == 'PATCH' || req.method == 'POST' || req.method == 'PUT') return http.Response('{"ok":true}', 200);
    return http.Response('{"error":"no"}', 404);
  });

  StockApi api() => StockApi(base: 'http://bo.test', token: 't', staff: 'Nicky', client: client);
}

void setView(WidgetTester tester) {
  tester.view.physicalSize = const Size(1700, 1100);
  tester.view.devicePixelRatio = 1;
}

Future<void> finish(WidgetTester tester) async {
  await tester.pumpWidget(const SizedBox());
  await tester.pump(const Duration(seconds: 3));
  tester.view.resetPhysicalSize();
  tester.view.resetDevicePixelRatio();
}

void main() {
  testWidgets('the Products page reads stock from the ledger: no false Out of stock', (tester) async {
    setView(tester);
    final db = AppDatabase.forTesting(NativeDatabase.memory());
    await db.batch((b) => b.insertAll(db.products, [
          local(101, 'Carling Pint', stock: 3),
          local(102, 'Carling Half'),
          local(103, 'Mojito'),
          local(104, 'Crisps'),
          local(105, 'Peroni', stock: 12),
        ]));
    final server = FakeServer();
    await tester.pumpWidget(ProviderScope(
      overrides: [
        databaseProvider.overrideWithValue(db),
        stockApiProvider.overrideWithValue(server.api()),
      ],
      child: const MaterialApp(home: Scaffold(body: ProductsPage())),
    ));
    await tester.pumpAndSettle();
    String label(int plu) => tester.widget<Text>(find.byKey(Key('stock-label-$plu'))).data!;
    expect(label(101), '40', reason: 'the ledger count, not this till’s copy of 3');
    expect(label(102), 'From Carling Pint');
    expect(label(103), 'Recipe');
    expect(label(104), 'Non-stock');
    expect(label(105), 'Out', reason: 'a real stock item at zero is still out');
    expect(find.byKey(const Key('case-101')), findsOneWidget, reason: 'case size changeable from the list');
    expect(find.text('Unit cost £1.20'), findsOneWidget);
    await finish(tester);
    await db.close();
  });

  Future<FakeServer> openEditor(WidgetTester tester, Product p) async {
    setView(tester);
    final server = FakeServer();
    await tester.pumpWidget(ProviderScope(
      overrides: [stockApiProvider.overrideWithValue(server.api())],
      child: MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (context) => TextButton(
              onPressed: () => showProductEditor(context, product: p, catalogue: [p, local(105, 'Peroni', group: 'Bottles')]),
              child: const Text('open'),
            ),
          ),
        ),
      ),
    ));
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    return server;
  }

  testWidgets('the editor is in sections: details, stock, printing, images', (tester) async {
    await openEditor(tester, local(101, 'Carling Pint', group: 'Draught'));
    for (final t in ['Product details', 'Stock', 'Printing', 'Images']) {
      expect(find.widgetWithText(Tab, t), findsOneWidget);
    }
    await finish(tester);
  });

  testWidgets('the Stock section: GP calculator, Use this price, its child products', (tester) async {
    final server = await openEditor(tester, local(101, 'Carling Pint', group: 'Draught'));
    await tester.tap(find.widgetWithText(Tab, 'Stock'));
    await tester.pumpAndSettle();
    // £1.20 a unit, £4.50 inc 20% VAT: net £3.75, GP 68%; 70% wants £4.80.
    expect(find.textContaining('GP now 68.0%'), findsOneWidget);
    expect(find.text('At 70% charge £4.80 incl. VAT'), findsOneWidget);
    await tester.tap(find.byKey(const Key('editor-use-price')));
    await tester.pumpAndSettle();
    expect(find.textContaining('Carling Half'), findsOneWidget, reason: 'its existing child is listed');

    // A new child with no measure is refused, and nothing is saved.
    await tester.tap(find.byKey(const Key('editor-child-new')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('child-name-1')), 'Carling Third');
    await tester.tap(find.byKey(const Key('editor-save')));
    await tester.pumpAndSettle();
    expect(server.calls.where((c) => c.startsWith('PATCH /till/products')), isEmpty);

    await tester.enterText(find.byKey(const Key('child-ratio-1')), '0.33');
    await tester.enterText(find.byKey(const Key('child-price-1')), '1.80');
    await tester.tap(find.byKey(const Key('editor-save')));
    await tester.pumpAndSettle();

    final details = server.bodies['PATCH /till/products/101']!.single;
    expect(details['price'], 4.8, reason: 'Use this price took');
    expect(details['product_name'], 'Carling Pint');
    expect(server.bodies['POST /till/products/new']!.single['product_name'], 'Carling Third');
    expect(server.bodies['PATCH /till/stock/products/60']!.single, {'stock_parent_pluid': 101, 'stock_ratio': 0.33});
    await finish(tester);
  });

  testWidgets('a product that sells from another says so instead of offering children', (tester) async {
    await openEditor(tester, local(102, 'Carling Half', group: 'Draught'));
    await tester.tap(find.widgetWithText(Tab, 'Stock'));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('editor-sells-from')), findsOneWidget);
    expect(find.byKey(const Key('editor-child-new')), findsNothing);
    await finish(tester);
  });
}
