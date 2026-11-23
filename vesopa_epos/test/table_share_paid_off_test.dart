/// A share of a table's bill paid: its items leave the table with their
/// payment, as a sale of their own.
///
/// Pontardawe RFC, 2026-11-23, filmed: Table 3, £30.00 of drinks. The Guinness
/// split off and paid by card, then Not now. The whole table stayed on the
/// till, Save Table was the only way out, and Table 3 came back with the
/// Guinness on it and £30.00 on the plan: "We need to get rid of that Guinness."
library;

import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/data/commerce.dart';
import 'package:vesopa_epos/data/local/database.dart';
import 'package:vesopa_epos/data/order_repository.dart';
import 'package:vesopa_epos/data/pricing_engine.dart';
import 'package:vesopa_epos/data/table_repository.dart';
import 'package:vesopa_epos/data/tender_engine.dart';

Product _drink(int plu, String name, int price) => Product(
      pluId: plu,
      name: name,
      priceMinor: price,
      taxPercentage: 20,
      stockQuantity: 0,
      printToReceipt: true,
      renewsMembership: false,
      isModifier: false,
    );

/// Table 3 as rung: £30.00.
final _round = [
  _drink(1, 'Carling', 410),
  _drink(2, 'Coors', 410),
  _drink(3, 'Madri', 450),
  _drink(4, 'Worthington', 390),
  _drink(5, 'Guinness', 520),
  _drink(6, 'Caffreys Black', 400),
  _drink(7, 'Dark Fruits', 420),
];

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

  Future<(String, String)> table3() async {
    final id = await orders.openOrder();
    for (final p in _round) {
      await orders.addLine(id, p);
    }
    await tables.park(id, 3);
    await orders.recalculate(id);
    final guinness = (await orders.linesOnce(id)).firstWhere((l) => l.name == 'Guinness').id;
    return (id, guinness);
  }

  test('the paid Guinness leaves Table 3, which keeps £24.80', () async {
    final (bill, guinness) = await table3();
    expect((await orders.orderOnce(bill))!.totalMinor, 3000);

    await orders.settle(bill, 'card', 520, reference: 'pi_1', lineIds: [guinness]);
    final moved = await tables.settleShareOff(bill, [guinness], sessionId: 's1', staffName: 'Nicky');

    expect(moved, isNotNull);
    // The table: six drinks, £24.80, nothing paid against it.
    final table = (await orders.orderOnce(bill))!;
    expect(table.totalMinor, 2480);
    expect(table.status, 'parked');
    expect(table.tableNumber, 3);
    expect((await orders.linesOnce(bill)).map((l) => l.name), isNot(contains('Guinness')));
    expect(await orders.amountPaid(bill), 0);
    expect((await tables.orderOn(3))!.id, bill, reason: 'the table is still booked with the rest');

    // The Guinness: a closed sale of its own, paid by its card payment.
    final sale = (await orders.orderOnce(moved!))!;
    expect(sale.status, 'closed');
    expect(sale.totalMinor, 520);
    expect(sale.staffName, 'Nicky');
    expect((await orders.linesOnce(moved)).single.name, 'Guinness');
    final paid = await orders.paymentsFor(moved);
    expect(paid.single.reference, 'pi_1');
    // And it is queued for the back office, so the Z has it.
    final queued = await db.select(db.outboxEntries).get();
    expect(queued.any((e) => e.payload.contains(moved)), isTrue);
  });

  test('a bill-wide offer: nothing moves, the bill is as it was', () async {
    final (bill, guinness) = await table3();
    await orders.applyDiscount(bill, 300);
    await orders.recalculate(bill);
    // The share paid its tenth of the offer: £5.20 - 52p.
    await orders.settle(bill, 'card', 468, lineIds: [guinness]);

    expect(await tables.settleShareOff(bill, [guinness]), isNull);
    expect((await orders.linesOnce(bill)), hasLength(7));
    expect(await orders.amountPaid(bill), 468);
    expect((await db.select(db.orders).get()), hasLength(1), reason: 'rolled back');
  });

  test('a unit of a divided round cannot be moved', () async {
    final (bill, guinness) = await table3();
    await orders.settle(bill, 'card', 520, lineIds: ['$guinness#1']);
    expect(await tables.settleShareOff(bill, ['$guinness#1']), isNull);
    expect((await orders.linesOnce(bill)), hasLength(7));
  });

  test('the whole bill is not moved: it closes by itself', () async {
    final (bill, _) = await table3();
    final all = [for (final l in await orders.linesOnce(bill)) l.id];
    expect(await tables.settleShareOff(bill, all), isNull);
  });

  test('a payment that was not for those items stays where it is', () async {
    final (bill, guinness) = await table3();
    await orders.settle(bill, 'cash', 520);
    expect(await tables.settleShareOff(bill, [guinness]), isNull);
    expect(await orders.amountPaid(bill), 520);
  });

  test('the payment screen drops the paid share and asks for the rest', () {
    PricedLine l(String id, int price) =>
        PricedLine(id: id, pluid: 1, name: id, quantity: 1, unitPriceMinor: price, taxPercentage: 0);
    final totals = const PricingEngine().price([l('g', 520), l('c', 410), l('d', 420)],
        manualDiscountMinor: 0, dealMinor: 0);
    final paid = TenderState(totals: totals)
        .splitByItems([
          ['g'],
          ['c'],
          ['d'],
        ])
        .addTender(const TenderEntry(kind: TenderKind.card, amountMinor: 520, saved: true));
    expect(paid.activeShare, 1);

    final after = paid.withoutMovedShare(['g'], tendersFrom: 0);
    expect(after.tenders, isEmpty);
    expect(after.shares.map((s) => s.lineIds), [
      ['c'],
      ['d'],
    ]);
    expect(after.activeShare, 0);
    expect(after.shares.map((s) => s.index), [0, 1]);

    // Two shares, one paid off: what is left is simply the rest of the bill.
    final two = TenderState(totals: totals)
        .splitByItems([
          ['g'],
          ['c', 'd'],
        ])
        .addTender(const TenderEntry(kind: TenderKind.card, amountMinor: 520, saved: true))
        .withoutMovedShare(['g'], tendersFrom: 0);
    expect(two.isSplit, isFalse);
    expect(two.tenders, isEmpty);
  });
}
