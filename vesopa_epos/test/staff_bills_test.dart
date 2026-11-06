/// Pontardawe RFC, 2026-11-06. Each order belongs to the person who rang it,
/// and a bill's money stays true to that bill.
library;

import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/data/local/database.dart';
import 'package:vesopa_epos/data/order_repository.dart';
import 'package:vesopa_epos/data/staff_bills.dart';
import 'package:vesopa_epos/data/table_repository.dart';

void main() {
  late AppDatabase db;
  late OrderRepository orders;
  late TableRepository tables;
  const steffi = 1;
  const carys = 2;

  setUp(() {
    db = AppDatabase.forTesting(NativeDatabase.memory());
    orders = OrderRepository(db);
    tables = TableRepository(db, orders);
  });

  tearDown(() => db.close());

  const coffee = Product(
    pluId: 1,
    name: 'Cappuccino',
    priceMinor: 200,
    taxPercentage: 20,
    stockQuantity: 0,
    printToReceipt: true,
    renewsMembership: false,
    isModifier: false,
  );
  const free = Product(
    pluId: 2,
    name: 'Tap Water',
    priceMinor: 0,
    taxPercentage: 0,
    stockQuantity: 0,
    printToReceipt: true,
    renewsMembership: false,
    isModifier: false,
  );

  Future<({String? target, bool leave})> hand(Map<String, String> held, String? onScreen, int? previous, int? next) =>
      handOverBill(orders: orders, tables: tables, held: held, onScreen: onScreen, previous: previous, next: next);

  group('signing on', () {
    test("Carys signing on over Steffi does not get Steffi's table", () async {
      final bill = await orders.openOrder();
      await orders.addLine(bill, coffee);
      await tables.park(bill, 35, roomId: 1);
      await tables.recall(bill);

      final held = <String, String>{};
      final move = await hand(held, bill, steffi, carys);

      expect(move.leave, isTrue);
      expect(move.target, isNull);
      expect(held['$steffi'], bill);
      // Still on the table plan for anyone who opens it on purpose.
      expect((await tables.orderOn(35, roomId: 1))?.id, bill);
      expect((await orders.orderOnce(bill))?.status, 'parked');
    });

    test('Steffi gets her own bill back with her PIN', () async {
      final bill = await orders.openOrder();
      await orders.addLine(bill, coffee);
      await tables.park(bill, 35);
      await tables.recall(bill);

      final held = <String, String>{};
      await hand(held, bill, steffi, carys);
      final blank = await orders.openOrder();
      final back = await hand(held, blank, carys, steffi);

      expect(back.target, bill);
      expect(held.containsKey('$steffi'), isFalse);
    });

    test('a bill she left at the counter comes back the same way', () async {
      final bill = await orders.openOrder();
      await orders.addLine(bill, coffee);

      final held = <String, String>{};
      expect((await hand(held, bill, steffi, null)).leave, isTrue);
      final blank = await orders.openOrder();
      expect((await hand(held, blank, null, steffi)).target, bill);
    });

    test('a bill paid in the meantime does not come back', () async {
      final bill = await orders.openOrder();
      await orders.addLine(bill, coffee);
      await tables.park(bill, 35);
      await tables.recall(bill);

      final held = <String, String>{};
      await hand(held, bill, steffi, carys);
      await orders.settle(bill, 'cash', 200);
      final blank = await orders.openOrder();

      expect((await hand(held, blank, carys, steffi)).target, isNull);
    });

    test('an empty bill stays on screen for whoever is next', () async {
      final bill = await orders.openOrder();
      final move = await hand({}, bill, steffi, carys);
      expect(move.leave, isFalse);
    });
  });

  group('money on a part-paid bill', () {
    Future<Set<String>> lineIds(String bill) async => {for (final l in await orders.linesOnce(bill)) l.id};

    test('items cannot be voided below what has been paid', () async {
      final bill = await orders.openOrder();
      await orders.addLine(bill, coffee, qty: 2, consolidate: false);
      await orders.addLine(bill, free);
      await orders.settle(bill, 'card', 300);

      expect(await orders.paidBeyond(bill, await lineIds(bill)), 300);
    });

    test('items above what has been paid can still go', () async {
      final bill = await orders.openOrder();
      await orders.addLine(bill, coffee, qty: 3);
      final line = (await orders.linesOnce(bill)).single;
      await orders.setLineQuantity(bill, line.id, 3);
      await orders.settle(bill, 'card', 200);

      await orders.addLine(bill, coffee, qty: 1, consolidate: false);
      final last = (await orders.linesOnce(bill)).last;
      expect(await orders.paidBeyond(bill, {last.id}), 0);
    });

    test('a quantity cannot be keyed below what has been paid', () async {
      final bill = await orders.openOrder();
      await orders.addLine(bill, coffee, qty: 3);
      await orders.settle(bill, 'card', 400);

      final line = (await orders.linesOnce(bill)).single;
      await orders.setLineQuantity(bill, line.id, 1);
      expect((await orders.linesOnce(bill)).single.quantity, 3);
    });

    test('a bill with nothing paid has no such limit', () async {
      final bill = await orders.openOrder();
      await orders.addLine(bill, coffee);
      expect(await orders.paidBeyond(bill, await lineIds(bill)), 0);
    });

    test('merging a table moves its payments with its items', () async {
      final from = await orders.openOrder();
      await orders.addLine(from, coffee, qty: 3);
      await orders.settle(from, 'card', 200);
      final into = await orders.openOrder();
      await orders.addLine(into, coffee);

      await tables.merge(from, into);

      expect(await orders.amountPaid(into), 200);
      expect(await orders.amountPaid(from), 0);
    });
  });

  group('closing at zero', () {
    test('voiding the last item frees the table', () async {
      final bill = await orders.openOrder();
      await orders.addLine(bill, coffee);
      await tables.park(bill, 35);

      await orders.voidLines(bill, lineIds: {(await orders.linesOnce(bill)).single.id}, reason: 'mistake');
      expect(await orders.clearIfEmpty(bill), isTrue);

      expect((await orders.orderOnce(bill))?.status, 'void');
      expect(await tables.orderOn(35), isNull);
    });

    test('a bill with items on it is not cleared', () async {
      final bill = await orders.openOrder();
      await orders.addLine(bill, coffee);
      expect(await orders.clearIfEmpty(bill), isFalse);
    });

    test('an empty bill with money on it is not cleared', () async {
      final bill = await orders.openOrder();
      await orders.addLine(bill, coffee, qty: 2);
      await orders.settle(bill, 'card', 100);
      await (db.delete(db.orderLines)).go();
      expect(await orders.clearIfEmpty(bill), isFalse);
    });

    test('items worth nothing close at £0.00', () async {
      final bill = await orders.openOrder();
      await orders.addLine(bill, free);
      await tables.park(bill, 35);

      expect(await orders.closeIfPaid(bill), isTrue);
      expect((await orders.orderOnce(bill))?.status, 'closed');
      expect(await tables.orderOn(35), isNull);
    });

    test('a bill still owing does not close', () async {
      final bill = await orders.openOrder();
      await orders.addLine(bill, coffee);
      expect(await orders.closeIfPaid(bill), isFalse);
      expect((await orders.orderOnce(bill))?.status, 'open');
    });
  });
}
