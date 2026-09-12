// A Vesopa Express order paying at the counter has no table, and that is not
// the same thing as a table somebody deleted.
//
// The till used to treat the two as one: any order without a table number was
// refused with "That table has been deleted since the order was placed", so a
// venue with "pay at the counter" switched on had an Accept button that did
// nothing for every kiosk order it was ever shown. The owner filmed a 45.10
// order from Kiosk 1 that could not be taken.
//
// `kiosk_number` is what tells them apart. The server has always sent it; the
// till simply never read it, which is exactly the kind of gap a unit test on
// the parser catches and a test on the widget does not.
import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/data/dinein_orders.dart';

Map<String, Object?> _order({Object? tableNumber, Object? kioskNumber}) => {
  'id': 41,
  'public_id': 'abc123',
  'table_label': kioskNumber == null ? 'Table 6' : 'Kiosk 1',
  'status': 'placed',
  'total_minor': 4510,
  'placed_at': '2026-09-12T00:05:00Z',
  'table_number': tableNumber,
  'kiosk_number': kioskNumber,
  'note': kioskNumber == null
      ? null
      : 'Vesopa Express: pay at the counter - Eat in',
  'lines': const [
    {
      'id': 1,
      'plu_id': 11,
      'name': 'Chicken Wings',
      'qty': 1,
      'unit_price_minor': 750,
    },
  ],
};

void main() {
  group('a kiosk order paying at the counter', () {
    test('is recognised by its collection number, not by its table', () {
      final kiosk = DineInOrder.fromJson(_order(kioskNumber: 12))!;

      expect(kiosk.kioskNumber, 12);
      expect(kiosk.isKioskCounter, isTrue);
      // A kiosk has no table. That is the normal shape of this order, not a
      // fault, and the till must not read it as a deleted table.
      expect(kiosk.tableNumber, isNull);
    });

    test('is still recognised when the till knows of no table at all', () {
      final kiosk = DineInOrder.fromJson(
        _order(tableNumber: null, kioskNumber: 3),
      )!;
      expect(kiosk.isKioskCounter, isTrue);
    });
  });

  group('a QR order from a table', () {
    test('carries a table number and is not a counter order', () {
      final table = DineInOrder.fromJson(_order(tableNumber: 6))!;

      expect(table.tableNumber, 6);
      expect(table.kioskNumber, isNull);
      expect(table.isKioskCounter, isFalse);
    });

    test('whose table has since been deleted is NOT treated as a kiosk one', () {
      // No table number and no collection number: the one case that still has
      // to be refused, because there is neither a bill to put it on nor a
      // customer standing at the counter to take it from.
      final orphaned = DineInOrder.fromJson(_order(tableNumber: null))!;

      expect(orphaned.tableNumber, isNull);
      expect(orphaned.isKioskCounter, isFalse);
    });
  });

  test('a server that predates Vesopa Express simply sends no kiosk number', () {
    final older = Map<String, Object?>.from(_order(tableNumber: 6))
      ..remove('kiosk_number');

    final order = DineInOrder.fromJson(older)!;
    expect(order.kioskNumber, isNull);
    expect(order.isKioskCounter, isFalse);
  });
}
