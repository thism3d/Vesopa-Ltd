// The till's side of Dylan's stock notes (2026-09-27): cases and units, the
// Wastage key, the product box that lists on tap, and the Stock page against
// a stand-in for the back office's /till/stock routes.

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:vesopa_epos/data/local/database.dart';
import 'package:vesopa_epos/data/stock_api.dart';
import 'package:vesopa_epos/ui/product_lookup_sheet.dart';
import 'package:vesopa_epos/ui/stock_page.dart';
import 'package:vesopa_epos/ui/wastage_sheet.dart';

Map<String, dynamic> sp(int id, String name, String dept, String? group, {int? pack, double? stock, bool nonStock = false}) {
  const packs = {1: ['Each', 1], 2: ['Pack of 24', 24], 3: ['Pack of 12', 12]};
  final k = pack == null ? null : packs[pack];
  return {
    'id': id,
    'pluid': 100 + id,
    'product_name': name,
    'department_name': dept,
    'group_name': group,
    'pack_size_id': pack,
    'pack_name': k?[0],
    'pack_units': k?[1],
    'stock_quantity': stock,
    'level': stock == null ? 'untracked' : 'ok',
    'stock_item': pack != null && !nonStock,
    'non_stock': nonStock ? 1 : 0,
    'unit_cost_minor': 50,
    'price': 4,
  };
}

/// The back office, as far as the Stock page can tell.
class FakeBackOffice {
  final products = <Map<String, dynamic>>[
    sp(1, 'Carling Pint', 'Bar', 'Draught', pack: 2, stock: 40),
    sp(2, 'Peroni Bottle', 'Bar', 'Bottles', pack: 2, stock: 30),
    sp(3, 'Budweiser Bottle', 'Bar', 'Bottles', pack: 3, stock: 10),
    sp(4, 'House Red Bottle', 'Wine', 'Red', pack: 1, stock: 6),
    sp(5, 'Chips', 'Food', 'Sides'),
  ];
  final patched = <Map<String, dynamic>>[];
  final docs = <Map<String, dynamic>>[];
  final headers = <Map<String, String>>[];

  late final client = MockClient((req) async {
    headers.add(req.headers);
    final path = req.url.path;
    Map<String, dynamic> body() => req.body.isEmpty ? {} : jsonDecode(req.body) as Map<String, dynamic>;
    if (path == '/till/stock/products' && req.method == 'GET') return http.Response(jsonEncode(products), 200);
    if (path == '/till/stock/pack-sizes') {
      return http.Response(jsonEncode([
        {'id': 1, 'name': 'Each', 'units': 1},
        {'id': 2, 'name': 'Pack of 24', 'units': 24},
        {'id': 3, 'name': 'Pack of 12', 'units': 12},
      ]), 200);
    }
    final m = RegExp(r'^/till/stock/products/(\d+)$').firstMatch(path);
    if (m != null && req.method == 'PATCH') {
      final b = body();
      patched.add({'id': int.parse(m[1]!), ...b});
      final row = products.firstWhere((p) => p['id'] == int.parse(m[1]!));
      if (b.containsKey('pack_size_id')) {
        final id = b['pack_size_id'] as int?;
        row['pack_size_id'] = id;
        row['pack_name'] = id == 3 ? 'Pack of 12' : id == 2 ? 'Pack of 24' : id == 1 ? 'Each' : null;
        row['pack_units'] = id == 3 ? 12 : id == 2 ? 24 : id == 1 ? 1 : null;
      }
      return http.Response(jsonEncode({'ok': true}), 200);
    }
    if (path == '/till/stock/docs' && req.method == 'POST') {
      docs.add(body());
      return http.Response(jsonEncode({'id': 'd1', 'completed': body()['complete'] == true}), 200);
    }
    return http.Response('{"error":"no"}', 404);
  });

  StockApi api() => StockApi(base: 'http://bo.test', token: 'terminal-token', staff: 'Nicky', client: client);
}

Future<FakeBackOffice> openStockPage(WidgetTester tester) async {
  tester.view.physicalSize = const Size(1600, 1100);
  tester.view.devicePixelRatio = 1;
  final bo = FakeBackOffice();
  await tester.pumpWidget(ProviderScope(
    overrides: [stockApiProvider.overrideWithValue(bo.api())],
    child: const MaterialApp(home: Scaffold(body: StockPage())),
  ));
  await tester.pumpAndSettle();
  return bo;
}

/// Take the tree down before the view is reset, and let any closing timers
/// run, so nothing outlives the test.
Future<void> finish(WidgetTester tester) async {
  await tester.pumpWidget(const SizedBox());
  await tester.pump(const Duration(seconds: 3));
  tester.view.resetPhysicalSize();
  tester.view.resetDevicePixelRatio();
}

void main() {
  group('cases and units', () {
    test('split and join as a person would say it', () {
      expect(splitQty(30, 24), (cases: 1.0, units: 6.0));
      expect(splitQty(24, 24), (cases: 1.0, units: 0.0));
      expect(splitQty(-30, 24), (cases: -1.0, units: -6.0));
      expect(splitQty(7, 1), (cases: 0.0, units: 7.0));
      expect(joinQty('', '', 24), isNull);
      expect(joinQty('2', '', 24), 48);
      expect(joinQty('1', '0.5', 24), 24.5);
      expect(joinQty('3', '2', null), 5, reason: 'no case: a case box is one unit');
      expect(qtyWords(30, 24), '1 case + 6 units');
      expect(qtyWords(48, 24), '2 cases');
      expect(qtyWords(3, null), '3 units');
    });

    test('an adjustment down is negative, in units', () {
      final line = StockLine(StockProduct(sp(2, 'Peroni', 'Bar', 'Bottles', pack: 2, stock: 30)))
        ..cases = '1'
        ..takeOff = true;
      expect(line.quantity, -24);
    });

    test('a count is laid out by department, then sub-department, then name', () {
      final lines = [
        StockLine(StockProduct(sp(4, 'House Red', 'Wine', 'Red', pack: 1))),
        StockLine(StockProduct(sp(2, 'Peroni', 'Bar', 'Bottles', pack: 2))),
        StockLine(StockProduct(sp(1, 'Carling', 'Bar', 'Draught', pack: 2))),
        StockLine(StockProduct(sp(3, 'Budweiser', 'Bar', 'Bottles', pack: 3))),
      ];
      sortForCount(lines);
      expect(lines.map((l) => l.product.name), ['Budweiser', 'Peroni', 'Carling', 'House Red']);
    });
  });

  group('the Wastage key', () {
    Future<double?> ask(WidgetTester tester, {String? packName, double? packUnits}) async {
      tester.view.physicalSize = const Size(1400, 1000);
      tester.view.devicePixelRatio = 1;
      double? got;
      await tester.pumpWidget(MaterialApp(
        home: Builder(
          builder: (context) => TextButton(
            onPressed: () async => got = await showDialog<double>(
              context: context,
              builder: (_) => WastageQuantityDialog(name: 'Peroni', packName: packName, packUnits: packUnits),
            ),
            child: const Text('open'),
          ),
        ),
      ));
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      return got;
    }

    testWidgets('a product bought by the case takes cases and units', (tester) async {
      await ask(tester, packName: 'Pack of 24', packUnits: 24);
      expect(find.byKey(const Key('wastage-cases')), findsOneWidget);
      await tester.enterText(find.descendant(of: find.byKey(const Key('wastage-cases')), matching: find.byType(EditableText)), '1');
      await tester.enterText(find.descendant(of: find.byKey(const Key('wastage-units')), matching: find.byType(EditableText)), '6');
      await tester.pumpAndSettle();
      expect(find.textContaining('= 30 units'), findsOneWidget);
      await finish(tester);
    });

    testWidgets('a product with no case asks for units only', (tester) async {
      await ask(tester);
      expect(find.byKey(const Key('wastage-cases')), findsNothing);
      expect(find.byKey(const Key('wastage-units')), findsOneWidget);
      await finish(tester);
    });

    testWidgets('its product box lists products before anything is typed', (tester) async {
      final products = [
        Product(pluId: 1, name: 'Chips', priceMinor: 300, taxPercentage: 0, stockQuantity: 0, printToReceipt: true, renewsMembership: false, isModifier: false),
        Product(pluId: 2, name: 'Peroni', priceMinor: 450, taxPercentage: 0, stockQuantity: 0, printToReceipt: true, renewsMembership: false, isModifier: false, packName: 'Pack of 24', packUnits: 24),
      ];
      await tester.pumpWidget(ProviderScope(
        child: MaterialApp(home: Scaffold(body: ProductLookupSheet(mode: LookupMode.ring, products: products, listAll: true))),
      ));
      await tester.pumpAndSettle();
      final names = tester.widgetList<ListTile>(find.byType(ListTile)).map((t) => (t.title as Text).data).toList();
      expect(names, ['Peroni', 'Chips'], reason: 'products bought by the case come first');
      await finish(tester);
    });
  });

  group('the Stock page', () {
    testWidgets('tapping the product box lists products, stock items first', (tester) async {
      await openStockPage(tester);
      await tester.tap(find.byKey(const Key('product-finder')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('product-finder-list')), findsOneWidget);
      expect(find.byKey(const Key('finder-105')), findsOneWidget);
      final order = tester.widgetList<ListTile>(find.descendant(of: find.byKey(const Key('product-finder-list')), matching: find.byType(ListTile)))
          .map((t) => (t.title as Text).data)
          .toList();
      expect(order.last, 'Chips');
      await finish(tester);
    });

    testWidgets('a count is grouped by sub-department, with case size and cases or units per line', (tester) async {
      final bo = await openStockPage(tester);
      await tester.tap(find.byKey(const Key('stock-add-all')));
      await tester.pumpAndSettle();
      final shelves = tester.widgetList<Container>(find.byWidgetPredicate((w) => w is Container && w.key is ValueKey<String> && (w.key! as ValueKey<String>).value.startsWith('shelf-')))
          .map((c) => (c.key! as ValueKey<String>).value)
          .toList();
      expect(shelves, ['shelf-Bar › Bottles', 'shelf-Bar › Draught', 'shelf-Wine › Red']);
      expect(find.byKey(const Key('case-102')), findsOneWidget);
      expect(find.byKey(const Key('cases-104')), findsNothing, reason: 'a case of one has no cases box');

      await tester.enterText(find.byKey(const Key('cases-102')), '1');
      await tester.enterText(find.byKey(const Key('units-102')), '6');
      await tester.pumpAndSettle();
      expect(find.text('= 30 units'), findsOneWidget);
      expect((tester.widget<Text>(find.byKey(const Key('diff-102')))).data, '0');
      expect(bo.docs, isEmpty);
      await finish(tester);
    });

    testWidgets('changing a line’s case size saves it on the product', (tester) async {
      final bo = await openStockPage(tester);
      await tester.tap(find.byKey(const Key('stock-add-all')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('case-102')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Pack of 12 (12)').last);
      await tester.pumpAndSettle();
      expect(bo.patched.single, {'id': 2, 'pack_size_id': 3});
      await finish(tester);
    });

    testWidgets('Complete sends units, never cases, signed by the member of staff', (tester) async {
      final bo = await openStockPage(tester);
      await tester.tap(find.byKey(const Key('product-finder')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('finder-102')));
      await tester.pumpAndSettle();
      FocusManager.instance.primaryFocus?.unfocus();
      await tester.pumpAndSettle();
      await tester.enterText(find.byKey(const Key('cases-102')), '2');
      await tester.enterText(find.byKey(const Key('units-102')), '3');
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('stock-complete')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('stock-confirm')));
      await tester.pumpAndSettle();
      expect(bo.docs.single['kind'], 'stocktake');
      expect(bo.docs.single['complete'], true);
      expect(bo.docs.single['lines'], [
        {'pluid': 102, 'quantity': 51.0, 'reason': null},
      ]);
      expect(bo.headers.last['X-Vesopa-Staff'] ?? bo.headers.last['x-vesopa-staff'], 'Nicky');
      expect(bo.headers.last['Authorization'] ?? bo.headers.last['authorization'], 'Bearer terminal-token');
      await finish(tester);
    });
  });
}
