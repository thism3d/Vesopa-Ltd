import 'package:drift/drift.dart';
import 'package:uuid/uuid.dart';

import 'local/database.dart';
import 'order_repository.dart';

/// Saving orders to tables, moving them, and splitting bills.
class TableRepository {
  TableRepository(this._db, this._orders);

  final AppDatabase _db;
  final OrderRepository _orders;
  static const _uuid = Uuid();

  /// Park the sale against a table so the clerk can start a new one. The order
  /// stays open — it is not takings until it is settled.
  Future<void> park(String orderId, int tableNumber) async {
    await _db.transaction(() async {
      await _db
          .into(_db.diningTables)
          .insertOnConflictUpdate(
            DiningTablesCompanion.insert(number: Value(tableNumber)),
          );
      await (_db.update(_db.orders)..where((o) => o.id.equals(orderId))).write(
        OrdersCompanion(
          status: const Value('parked'),
          tableNumber: Value(tableNumber),
        ),
      );
    });
  }

  /// An order counts as sitting on a table — "booked" — when it is still live
  /// (open or explicitly parked), is assigned to a table, and has at least one
  /// item on it. That last part is the rule the operator asked for: adding the
  /// first product books the table; an empty bill assigned to a table does not.
  static Expression<bool> _occupies($OrdersTable o) =>
      o.tableNumber.isNotNull() & o.status.isIn(['open', 'parked']);

  /// The live bill sitting on a table, if any. Only orders with items count, so
  /// a brand-new empty order that happens to carry a table number is not
  /// mistaken for a booked table.
  Future<Order?> orderOn(int tableNumber) async {
    final rows =
        await (_db.select(_db.orders)
              ..where((o) => o.tableNumber.equals(tableNumber) & _occupies(o))
              ..orderBy([(o) => OrderingTerm(expression: o.createdAt)])
              ..limit(1))
            .get();
    for (final order in rows) {
      if (await _hasLines(order.id)) return order;
    }
    return null;
  }

  Future<bool> _hasLines(String orderId) async {
    final line =
        await (_db.select(_db.orderLines)
              ..where((l) => l.orderId.equals(orderId))
              ..limit(1))
            .getSingleOrNull();
    return line != null;
  }

  /// Every table that currently has a bill on it. Streams, so the tables plan
  /// and the picker update live the instant an item is rung up, a bill is
  /// recalled, or another terminal changes a table — no manual refresh.
  ///
  /// Occupancy requires items: an order is only shown against its table once it
  /// has something on it, matching "add a product and the table is booked".
  Stream<List<Order>> watchParked() {
    // Watch the join so a line added to an order re-emits, not just changes to
    // the orders row itself.
    final query =
        _db.select(_db.orders).join([
            innerJoin(
              _db.orderLines,
              _db.orderLines.orderId.equalsExp(_db.orders.id),
            ),
          ])
          ..where(_occupies(_db.orders))
          ..orderBy([OrderingTerm(expression: _db.orders.tableNumber)]);

    return query.watch().map((rows) {
      // The inner join yields one row per line; collapse to distinct orders,
      // keeping the first (they are identical bar the joined line).
      final byId = <String, Order>{};
      for (final row in rows) {
        final order = row.readTable(_db.orders);
        byId.putIfAbsent(order.id, () => order);
      }
      return byId.values.toList();
    });
  }

  /// Bring a parked bill back to the till.
  Future<void> recall(String orderId) async {
    await (_db.update(_db.orders)..where((o) => o.id.equals(orderId))).write(
      const OrdersCompanion(status: Value('open')),
    );
  }

  /// Move a bill to a different table.
  Future<void> transfer(String orderId, int toTable) async {
    final existing = await orderOn(toTable);
    if (existing != null && existing.id != orderId) {
      // Refusing is safer than silently merging two parties' bills.
      throw StateError('Table $toTable already has an open bill.');
    }
    await _db.transaction(() async {
      await _db
          .into(_db.diningTables)
          .insertOnConflictUpdate(
            DiningTablesCompanion.insert(number: Value(toTable)),
          );
      await (_db.update(_db.orders)..where((o) => o.id.equals(orderId))).write(
        OrdersCompanion(tableNumber: Value(toTable)),
      );
    });
  }

  /// Merge two tables' bills into one.
  Future<void> merge(String fromOrderId, String intoOrderId) async {
    await _db.transaction(() async {
      await (_db.update(_db.orderLines)
            ..where((l) => l.orderId.equals(fromOrderId)))
          .write(OrderLinesCompanion(orderId: Value(intoOrderId)));

      await (_db.update(_db.orders)..where((o) => o.id.equals(fromOrderId)))
          .write(const OrdersCompanion(status: Value('void')));

      await _orders.recalculate(intoOrderId);
      await _orders.recalculate(fromOrderId);
    });
  }

  /// Split named lines onto a new bill, leaving the rest behind.
  ///
  /// The move and both recalculations happen in one transaction: a half-applied
  /// split would leave money on neither bill, which is the one outcome a till
  /// must never produce.
  Future<String> splitLines(String orderId, List<String> lineIds) async {
    if (lineIds.isEmpty) {
      throw ArgumentError('Nothing selected to split.');
    }

    return _db.transaction(() async {
      final source = await (_db.select(
        _db.orders,
      )..where((o) => o.id.equals(orderId))).getSingle();

      final all = await (_db.select(
        _db.orderLines,
      )..where((l) => l.orderId.equals(orderId))).get();
      if (lineIds.length >= all.length) {
        throw ArgumentError('Cannot split every line onto a new bill.');
      }

      final newId = _uuid.v4();
      await _db
          .into(_db.orders)
          .insert(
            OrdersCompanion.insert(
              id: newId,
              status: const Value('open'),
              tableNumber: Value(source.tableNumber),
              clerkPin: Value(source.clerkPin),
              splitFromOrderId: Value(orderId),
            ),
          );

      await (_db.update(_db.orderLines)..where((l) => l.id.isIn(lineIds)))
          .write(OrderLinesCompanion(orderId: Value(newId)));

      // A discount belonged to the original bill as a whole; carrying it onto
      // both halves would double it, so it stays with the source.
      await _orders.recalculate(orderId);
      await _orders.recalculate(newId);

      return newId;
    });
  }

  // There is deliberately no `splitEvenly` here any more.
  //
  // It used to write N new orders carrying only a `totalMinor` — no lines at
  // all — and then void the source order, which was the one holding every item
  // on the check. The result was exactly what was reported: the first share
  // looked payable, and the rest of the bill vanished, because the items had
  // been thrown away and the shares were empty shells. Nothing could reprice,
  // reprint, or void them, and a recalculate would have zeroed them.
  //
  // Splitting a bill evenly is not a change to what was ordered, it is a change
  // to how it is *paid* — so it belongs to the tender state, which already
  // models it correctly (see TenderState.splitEqually: shares that track their
  // own outstanding balance against one intact order). The tables screen now
  // opens the payment screen with that split applied.
}
