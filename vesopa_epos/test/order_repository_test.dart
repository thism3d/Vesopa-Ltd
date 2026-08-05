import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/data/local/database.dart';
import 'package:vesopa_epos/data/order_repository.dart';

void main() {
  late AppDatabase db;
  late OrderRepository repo;

  setUp(() {
    db = AppDatabase.forTesting(NativeDatabase.memory());
    repo = OrderRepository(db);
  });

  tearDown(() => db.close());

  // £2.50 at 20% VAT, tax-inclusive.
  const coffee = Product(
    pluId: 1,
    name: 'Coffee',
    priceMinor: 250,
    taxPercentage: 20,
    stockQuantity: 0,
  );

  const cola = Product(
    pluId: 2,
    name: 'Cola',
    priceMinor: 150,
    taxPercentage: 20,
    stockQuantity: 0,
  );

  test('subtotal is the gross price and VAT is the part inside it', () async {
    final id = await repo.openOrder();
    await repo.addLine(id, coffee);

    final order = await repo.watchOrder(id).first;

    // The customer pays £2.50; the VAT within it is 250 - (250/1.2) = 42p.
    expect(order.subtotalMinor, 250);
    expect(order.totalMinor, 250);
    expect(order.taxMinor, 42);
  });

  test('tapping the same product twice bumps quantity, not line count', () async {
    final id = await repo.openOrder();
    await repo.addLine(id, coffee);
    await repo.addLine(id, coffee);

    final lines = await repo.watchLines(id).first;
    expect(lines, hasLength(1));
    expect(lines.single.quantity, 2);

    final order = await repo.watchOrder(id).first;
    expect(order.totalMinor, 500);
  });

  test('discount reduces the total and the VAT with it', () async {
    final id = await repo.openOrder();
    await repo.addLine(id, coffee); // £2.50
    await repo.applyDiscount(id, 50); // £0.50 off

    final order = await repo.watchOrder(id).first;
    expect(order.subtotalMinor, 250);
    expect(order.discountMinor, 50);
    expect(order.totalMinor, 200);
    // VAT must follow what was actually taken: 200 - (200/1.2) = 33p.
    // Charging the pre-discount 42p would overstate the VAT return.
    expect(order.taxMinor, 33);
  });

  test('a discount cannot push the bill below zero', () async {
    final id = await repo.openOrder();
    await repo.addLine(id, cola); // £1.50
    await repo.applyDiscount(id, 9999);

    final order = await repo.watchOrder(id).first;
    expect(order.totalMinor, 0);
    expect(order.discountMinor, 150);
  });

  test('settling closes the sale and queues exactly one outbox entry', () async {
    final id = await repo.openOrder();
    await repo.addLine(id, coffee);
    await repo.settle(id, 'cash', 250);

    final order = await repo.watchOrder(id).first;
    expect(order.status, 'closed');
    expect(order.closedAt, isNotNull);
    // Durable locally, not yet pushed.
    expect(order.syncedAt, isNull);

    final outbox = await db.select(db.outboxEntries).get();
    expect(outbox, hasLength(1));
    expect(outbox.single.entityId, id);
  });

  test('a void clears the sale and is never queued as one', () async {
    final id = await repo.openOrder();
    await repo.addLine(id, coffee);
    await repo.voidOrder(id, reason: 'Test');

    final order = await repo.watchOrder(id).first;
    expect(order.status, 'void');
    expect(order.totalMinor, 0);
    expect(await repo.watchLines(id).first, isEmpty);

    // A voided order was never a sale, so no *order* may reach the server. The
    // void itself is queued separately as an audit record — the back office is
    // meant to see who reversed what, and why.
    final queued = await db.select(db.outboxEntries).get();
    expect(queued.where((e) => e.entity == 'order'), isEmpty);
    expect(
      queued.map((e) => e.entity),
      contains('void'),
      reason: 'the reversal should still be auditable',
    );
  });

  test('a part payment leaves the sale open and unqueued', () async {
    final id = await repo.openOrder();
    await repo.addLine(id, coffee); // £2.50
    await repo.settle(id, 'cash', 100); // only £1.00 of it

    final order = await repo.watchOrder(id).first;
    // Still owed £1.50 — booking this as a completed sale would understate
    // the takings by the unpaid remainder.
    expect(order.status, 'open');
    expect(order.closedAt, isNull);
    expect(await db.select(db.outboxEntries).get(), isEmpty);
    expect(await repo.amountPaid(id), 100);
  });

  test('split tender closes the sale once fully paid, queued once', () async {
    final id = await repo.openOrder();
    await repo.addLine(id, coffee); // £2.50
    await repo.settle(id, 'cash', 100);
    await repo.settle(id, 'card', 150);

    final order = await repo.watchOrder(id).first;
    expect(order.status, 'closed');
    expect(await repo.amountPaid(id), 250);

    final payments = await db.select(db.payments).get();
    expect(payments, hasLength(2));

    // One sale, one push — not one per tender.
    expect(await db.select(db.outboxEntries).get(), hasLength(1));
  });

  test('overpaying with cash still closes the sale', () async {
    final id = await repo.openOrder();
    await repo.addLine(id, cola); // £1.50
    await repo.settle(id, 'cash', 1000); // £10 note

    final order = await repo.watchOrder(id).first;
    expect(order.status, 'closed');
  });
}
