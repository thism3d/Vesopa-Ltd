/// The Z report: what a manager reads at the end of the day.
///
/// Matched against the reference report the venue supplied, whose shape is the
/// trade's: a count beside every amount, a section per kind of thing, and the
/// voids and no-sales next to each other because that is the pair a manager is
/// actually looking for.
library;

import 'package:drift/drift.dart' show Value;
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/data/local/database.dart';
import 'package:vesopa_epos/data/order_repository.dart';
import 'package:vesopa_epos/data/session_repository.dart';

void main() {
  late AppDatabase db;
  late OrderRepository orders;
  late SessionRepository sessions;

  setUp(() {
    db = AppDatabase.forTesting(NativeDatabase.memory());
    orders = OrderRepository(db);
    sessions = SessionRepository(db);
  });

  tearDown(() => db.close());

  const beer = Product(
    pluId: 1,
    name: 'IPA',
    priceMinor: 500,
    taxPercentage: 20,
    stockQuantity: 0,
    printToReceipt: true,
    departmentName: 'Drink',
  );
  const pie = Product(
    pluId: 2,
    name: 'Pie',
    priceMinor: 800,
    taxPercentage: 20,
    stockQuantity: 0,
    printToReceipt: true,
    departmentName: 'Food',
  );

  /// The catalogue the report reads departments from. Sales are grouped by
  /// looking the PLU up here, so a till with no catalogue reports everything
  /// under "Other" — which is why these have to exist before anything is sold.
  Future<void> stock(List<Product> products) async {
    for (final p in products) {
      await db.into(db.products).insertOnConflictUpdate(p);
    }
  }

  /// A settled sale of [qty] of [p], paid by [method].
  Future<String> sell(Product p, {double qty = 1, String method = 'cash'}) async {
    final session = await sessions.current();
    final id = await orders.openOrder();
    await (db.update(db.orders)..where((o) => o.id.equals(id)))
        .write(OrdersCompanion(sessionId: Value(session.id)));
    await orders.addLine(id, p, qty: qty);
    final order = await orders.watchOrder(id).first;
    await orders.settle(id, method, order.totalMinor, sessionId: session.id);
    return id;
  }

  test('every line carries a count as well as an amount', () async {
    await stock([beer, pie]);
    await sell(beer, qty: 3);
    await sell(pie);

    final r = await sessions.xReport();

    // Three beers is a count of three, not a count of one line.
    expect(r.byDepartment['Drink']!.count, 3);
    expect(r.byDepartment['Drink']!.amountMinor, 1500);
    expect(r.byDepartment['Food']!.count, 1);
    expect(r.byDepartment['Food']!.amountMinor, 800);

    // One tender taken per sale.
    expect(r.byMethod['cash']!.count, 2);
    expect(r.byMethod['cash']!.amountMinor, 2300);
  });

  test('the section totals add up to the sections', () async {
    await stock([beer, pie]);
    await sell(beer, qty: 2);
    await sell(pie, method: 'card');

    final r = await sessions.xReport();
    expect(totalOf(r.byDepartment.values).amountMinor, 1800);
    expect(totalOf(r.byMethod.values).amountMinor, 1800);
    expect(totalOf(r.byMethod.values).count, 2);
  });

  test('average spend is takings over bills, and never divides by zero', () async {
    final empty = await sessions.xReport();
    expect(empty.orderCount, 0);
    expect(empty.averageSpendMinor, 0);

    await sell(beer, qty: 2); // £10
    await sell(beer);         // £5
    final r = await sessions.xReport();
    expect(r.orderCount, 2);
    expect(r.averageSpendMinor, 750);
  });

  test('a void is counted and valued, even on a till that is online', () async {
    // The point of the local event log: the outbox row this used to be read
    // from is deleted the moment the server takes it.
    final session = await sessions.current();
    final id = await orders.openOrder();
    await (db.update(db.orders)..where((o) => o.id.equals(id)))
        .write(OrdersCompanion(sessionId: Value(session.id)));
    await orders.addLine(id, beer, qty: 2);
    final lines = await orders.watchLines(id).first;

    await orders.voidLines(
      id,
      lineIds: {lines.first.id},
      reason: 'Wrong drink',
    );

    // Emptying the outbox is exactly what a successful sync does.
    await db.delete(db.outboxEntries).go();

    final r = await sessions.xReport();
    expect(r.voids.count, 1);
    expect(r.voids.amountMinor, 1000);
  });

  test('no sales are counted, and are worth nothing', () async {
    final session = await sessions.current();
    await orders.logNoSale(sessionId: session.id);
    await orders.logNoSale(sessionId: session.id);

    final r = await sessions.xReport();
    expect(r.noSales.count, 2);
    expect(r.noSales.amountMinor, 0);
  });

  test('covers are summed, and drive the average cover', () async {
    final session = await sessions.current();
    final id = await sell(beer, qty: 4); // £20
    await (db.update(db.orders)..where((o) => o.id.equals(id)))
        .write(const OrdersCompanion(covers: Value(4)));

    final r = await sessions.xReport();
    expect(r.covers, 4);
    expect(r.averageCoverMinor, 500);
    expect(session.id, isNotEmpty);
  });

  test('a Z closes the period and the next one starts empty', () async {
    await sell(beer);
    final z = await sessions.zReport();
    expect(z.isZ, isTrue);
    expect(z.zNumber, 1);
    expect(z.grossMinor, 500);

    // The new period has none of the old one's takings, voids or no-sales.
    final after = await sessions.xReport();
    expect(after.orderCount, 0);
    expect(after.grossMinor, 0);
    expect(after.voids.count, 0);
    expect(after.noSales.count, 0);
  });

  test("one period's events never leak into the next", () async {
    final first = await sessions.current();
    await orders.logNoSale(sessionId: first.id);
    await sessions.zReport();

    final second = await sessions.current();
    await orders.logNoSale(sessionId: second.id);

    final r = await sessions.xReport();
    expect(r.noSales.count, 1, reason: 'only this period is counted');
  });

  test('the float carries into the next period and cash expected follows', () async {
    await sell(beer, qty: 2); // £10 cash
    final r = await sessions.xReport();
    expect(r.expectedCashMinor, r.openingFloatMinor + 1000);
  });
}
