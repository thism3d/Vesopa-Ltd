/// Two rooms, each with a Table 1.
///
/// The floor plan has allowed this since the unique key moved to (room, number).
/// The order did not know about rooms, so both tables shared one bill: sitting a
/// party at the second one recalled the first one's food, and the ticket printed
/// the wrong room at the top.
library;

import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/data/local/database.dart';
import 'package:vesopa_epos/data/order_repository.dart';
import 'package:vesopa_epos/data/table_repository.dart';

void main() {
  late AppDatabase db;
  late OrderRepository orders;
  late TableRepository tables;

  setUp(() {
    db = AppDatabase.forTesting(NativeDatabase.memory());
    orders = OrderRepository(db);
    tables = TableRepository(db, orders);
  });

  tearDown(() => db.close());

  const beer = Product(
    pluId: 1,
    name: 'IPA',
    priceMinor: 580,
    taxPercentage: 20,
    stockQuantity: 0,
    printToReceipt: true,
  );

  test('table 1 upstairs is not table 1 on the terrace', () async {
    final main = await orders.openOrder();
    await orders.addLine(main, beer);
    await tables.park(main, 1, roomId: 10);

    // The terrace's Table 1 must read as free.
    expect(await tables.orderOn(1, roomId: 20), isNull);
    // And the main floor's must still be the bill just parked.
    expect((await tables.orderOn(1, roomId: 10))?.id, main);
  });

  test('each room keeps its own bill on the same number', () async {
    final upstairs = await orders.openOrder();
    await orders.addLine(upstairs, beer);
    await tables.park(upstairs, 1, roomId: 10);

    final terrace = await orders.openOrder();
    await orders.addLine(terrace, beer, qty: 3);
    await tables.park(terrace, 1, roomId: 20);

    expect((await tables.orderOn(1, roomId: 10))?.id, upstairs);
    expect((await tables.orderOn(1, roomId: 20))?.id, terrace);
  });

  test('the room is recorded on the order', () async {
    final id = await orders.openOrder();
    await orders.addLine(id, beer);
    await tables.park(id, 4, roomId: 7);

    final order = await orders.watchOrder(id).first;
    expect(order.roomId, 7);
    expect(order.tableNumber, 4);
  });

  test('a bill parked before rooms were recorded is still found', () async {
    // The upgrade case: an order already on a table, with no room on it. It has
    // to keep resolving, or a venue mid-service loses every open table.
    final id = await orders.openOrder();
    await orders.addLine(id, beer);
    await tables.park(id, 9);

    expect((await tables.orderOn(9, roomId: 10))?.id, id);
    expect((await tables.orderOn(9))?.id, id);
  });

  test('a venue with no floor plan behaves exactly as before', () async {
    final id = await orders.openOrder();
    await orders.addLine(id, beer);
    await tables.park(id, 3);

    expect((await tables.orderOn(3))?.id, id);
    expect(await tables.orderOn(4), isNull);
  });
}
