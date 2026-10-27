import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vesopa_go/data/api.dart';
import 'package:vesopa_go/data/models.dart';
import 'package:vesopa_go/data/outbox.dart';
import 'package:vesopa_go/data/payloads.dart';
import 'package:vesopa_go/data/venue_data.dart';

/// The back office's own shapes (/till/products, /till/modifiers, /till/screens, /till/floor).
final _products = [
  {'pluid': 101, 'product_name': 'Sirloin', 'department_name': 'Mains', 'group_name': 'Grill', 'price': '24.50', 'tax_percentage': 20, 'printer_routes': 'kp1,KP2,bar', 'allergens': 'milk, mustard'},
  {'pluid': 102, 'product_name': 'Lager', 'department_name': 'Drinks', 'price': 5.5, 'tax_percentage': 20},
  {'pluid': 201, 'product_name': 'Chips', 'price': 0, 'is_modifier': 1},
  {'pluid': 202, 'product_name': 'Sweet potato fries', 'price': '1.50', 'is_modifier': 1},
  {'pluid': 103, 'product_name': 'Sticky toffee', 'department_name': 'Desserts', 'price': '6.95', 'available': false},
];
final _modifiers = {
  'groups': [
    {'id': 7, 'name': 'Side', 'min_select': 1, 'max_select': 1, 'screen_id': 'scr-sides'},
    {'id': 8, 'name': 'Empty', 'min_select': 0, 'screen_id': 'nowhere'},
  ],
  'products': {'101': [7, 8]},
};
final _screens = [
  {'id': 'scr-sides', 'buttons': [
    {'pluId': 201, 'label': 'Chips'},
    {'pluId': 202, 'label': null},
    {'kind': 'function', 'functionKey': 'void'},
  ]},
];
final _floor = [
  {'id': 3, 'name': 'Garden', 'tables': [
    {'id': 31, 'table_number': 12, 'label': '', 'seats': 6},
    {'id': 32, 'table_number': 14, 'label': 'Pergola', 'seats': 2},
  ]},
];

class _FakeApi extends TapApi {
  _FakeApi(this.answers);
  final List<Object> answers; // a status code to throw, or 'ok'
  final sent = <String>[];
  @override
  Future<Map<String, dynamic>> post(String path, Map<String, Object?> body) async {
    final a = answers.isEmpty ? 'ok' : answers.removeAt(0);
    if (a is int) throw TapApiError(a, 'answered $a');
    sent.add('$path ${body['id']}');
    return {};
  }
}

void main() {
  group('the venue\'s menu and floor', () {
    final menu = menuFrom(products: _products, modifiers: _modifiers, screens: _screens);

    test('dishes by department, modifiers hidden, prices in pence from strings or numbers', () {
      expect(menu.products.map((p) => p.name), ['Sirloin', 'Lager', 'Sticky toffee']);
      expect(menu.categories.map((c) => c.name), ['Mains', 'Drinks', 'Desserts']);
      final steak = menu.products.first;
      expect(steak.priceMinor, 2450);
      expect(steak.plu, 101);
      expect(steak.taxPercent, 20);
      expect(steak.allergens, ['Milk', 'Mustard']);
      // The back office's JSON list reads as names, never brackets and quotes.
      expect(allergensOf('["celery","milk"]'), ['Celery', 'Milk']);
      expect(allergensOf(['gluten', 'Gluten']), ['Gluten']);
      expect(allergensOf(''), isEmpty);
      expect(steak.course, 2);
      expect(steak.stations, ['kp1', 'kp2'], reason: 'only kitchen stations, lower-cased');
      expect(menu.products[1].priceMinor, 550);
      expect(menu.products[2].outOfStock, isTrue);
      expect(menu.products[2].course, 3);
    });

    test('a modifier group\'s choices are the products on its screen', () {
      final side = menu.products.first.options.single;
      expect(side.name, 'Side');
      expect(side.required, isTrue);
      expect(side.choices.map((c) => '${c.name} ${c.priceMinor} ${c.plu}'), ['Chips 0 201', 'Sweet potato fries 150 202']);
    });

    test('tables by room, with the till\'s table numbers', () {
      final tables = tablesFrom(_floor);
      expect(tables.map((t) => '${t.name}/${t.area}/${t.number}/${t.roomId}'), ['Table 12/Garden/12/3', 'Pergola/Garden/14/3']);
    });
  });

  group('the till\'s own shapes', () {
    final menu = menuFrom(products: _products, modifiers: _modifiers, screens: _screens);
    final steak = menu.products.first;
    final lager = menu.products[1];
    final bill = Bill(
      id: 'bill-1',
      name: 'Table 12',
      tableNumber: 12,
      roomId: 3,
      covers: 2,
      clerk: 'Sam',
      staffId: 1,
      serviceChargePercent: 10,
      lines: [
        BillLine(id: 'a', product: steak, choices: [steak.options.single.choices[1]], seat: 1, sent: true),
        BillLine(id: 'b', product: lager, quantity: 2),
      ],
      tenders: [
        Tender(id: 'p1', amountMinor: 2000, tipMinor: 200, kind: 'tap', at: DateTime(2026), reference: 'pi_1'),
        Tender(id: 'p2', amountMinor: 2915, kind: 'cash', at: DateTime(2026)),
      ],
    );

    test('a sale whose lines add up to its subtotal, modifiers as their own lines', () {
      final sale = salePayload(bill, office: 'venue@x.test', terminal: 'iPhone (Vesopa Go) AB12');
      final lines = sale['lines'] as List;
      final sum = lines.fold<int>(0, (s, l) => s + ((l as Map)['unit_price_minor'] as int) * (l['quantity'] as int));
      expect(sum, bill.subtotalMinor);
      expect(sale['total_minor'], bill.totalMinor);
      expect(sale['service_minor'], bill.serviceMinor);
      expect(sale['gratuity_minor'], 200);
      expect(lines.where((l) => (l as Map)['is_modifier'] == true).single, containsPair('parent_line_id', 'a'));
      final pays = sale['payments'] as List;
      expect(pays[0], allOf(containsPair('method', 'card'), containsPair('entry_mode', 'contactless'), containsPair('reference', 'pi_1')));
      expect(pays[1], containsPair('method', 'cash'));
      expect(sale['email'], 'venue@x.test');
    });

    test('an open bill for the shared plan', () {
      final p = openBillPayload(bill, terminal: 'iPhone (Vesopa Go) AB12');
      expect(p['table_number'], 12);
      expect(p['terminal'], 'iPhone (Vesopa Go) AB12');
      expect(((p['payload'] as Map)['lines'] as List).first, containsPair('kitchen_printed_at', isNotNull));
    });

    test('a kitchen ticket carries only what a station makes', () {
      final t = kitchenTicket(bill, bill.lines, id: 't1', office: 'venue@x.test', roomName: 'Garden')!;
      final lines = t['lines'] as List;
      expect(lines.map((l) => (l as Map)['name']), ['Sirloin (seat 1)', 'Sweet potato fries'], reason: 'the lager goes to no station');
      expect((lines.first as Map)['stations'], 'kp1,kp2');
      expect(t['table_number'], 12);
      expect(kitchenTicket(bill, [bill.lines[1]], id: 't2', office: 'x'), isNull);
    });
  });

  group('the outbox', () {
    setUp(() => SharedPreferences.setMockInitialValues({}));

    test('keeps what could not go, and sends it next time in order', () async {
      final api = _FakeApi([0, 503]);
      final box = Outbox(api);
      await box.add('/till/orders', {'id': 'sale-1'}); // no connection
      await box.add('/till/kitchen/tickets', {'id': 't-1'}); // the server is down
      expect(await box.pending(), 2);
      await box.flush();
      expect(api.sent, ['/till/orders sale-1', '/till/kitchen/tickets t-1']);
      expect(await box.pending(), 0);
    });

    test('a 409 (already there) or a 4xx is not retried for ever', () async {
      final api = _FakeApi([409]);
      final box = Outbox(api);
      await box.add('/till/orders', {'id': 'sale-2'});
      expect(await box.pending(), 0);
    });
  });
}
