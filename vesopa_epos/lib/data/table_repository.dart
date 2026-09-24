import 'package:drift/drift.dart';
import 'package:uuid/uuid.dart';

import 'local/database.dart';
import 'order_repository.dart';

/// Saving orders to tables, moving them, and splitting bills.
class TableRepository {
  TableRepository(this._db, this._orders, {bool Function()? trainingMode})
      : _training = trainingMode ?? _notTraining;

  static bool _notTraining() => false;

  /// Whether a training account is signed on. Practice tables are seen only in
  /// training and live ones only outside it, so a trainee can never pick up a
  /// real table's bill and a real clerk never settles a practice one. See
  /// `data/training_mode.dart`.
  final bool Function() _training;

  final AppDatabase _db;
  final OrderRepository _orders;
  static const _uuid = Uuid();

  /// Park the sale against a table so the clerk can start a new one. The order
  /// stays open — it is not takings until it is settled.
  Future<void> park(String orderId, int tableNumber, {int? roomId}) async {
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
          roomId: Value(roomId),
        ),
      );
    });
  }

  /// An order counts as sitting on a table — "booked" — when it is still live
  /// (open or explicitly parked), is assigned to a table, and has at least one
  /// item on it. That last part is the rule the operator asked for: adding the
  /// first product books the table; an empty bill assigned to a table does not.
  Expression<bool> _occupies($OrdersTable o) =>
      o.tableNumber.isNotNull() &
      o.status.isIn(['open', 'parked']) &
      o.training.equals(_training());

  /// The live bill sitting on a table, if any. Only orders with items count, so
  /// a brand-new empty order that happens to carry a table number is not
  /// mistaken for a booked table.
  /// [roomId] narrows it to one room's table. A null matches a bill parked
  /// before rooms were recorded, so an existing bill is still found after an
  /// update rather than appearing to vanish mid-service.
  Future<Order?> orderOn(int tableNumber, {int? roomId}) async {
    final rows =
        await (_db.select(_db.orders)
              ..where((o) =>
                  o.tableNumber.equals(tableNumber) &
                  _occupies(o) &
                  (roomId == null
                      ? const Constant(true)
                      : o.roomId.equals(roomId) | o.roomId.isNull()))
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
  ///
  /// Throws [TableOccupied] when the destination already has a party on it,
  /// carrying the bill that is in the way. The caller decides what to do about
  /// it — the venue asked to be offered a merge, and the answer to that
  /// question is a clerk's rather than a repository's. Merging two parties'
  /// bills without asking would be the one thing worse than refusing.
  Future<void> transfer(String orderId, int toTable) async {
    final existing = await orderOn(toTable);
    if (existing != null && existing.id != orderId) {
      throw TableOccupied(toTable, existing);
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
  ///
  /// The DESTINATION survives. Its id, its audit trail, its table and its
  /// bill-level discount are the ones that carry on; the source's lines move
  /// across keeping their own ids, their modifiers and their line discounts,
  /// and the source order is closed.
  ///
  /// WHAT HAPPENS TO THE THINGS THAT CANNOT BOTH SURVIVE
  ///
  ///   * **Covers are added together.** Two tables pushed into one is one
  ///     party of the two counts, and a covers figure that quietly stayed at
  ///     four when eight people sat down is a wrong average spend in every
  ///     report that reads it.
  ///   * **The customer moves only onto a bill that has none.** A destination
  ///     with a member on it keeps that member — their discount has already
  ///     been quoted against that bill — and a destination with nobody on it
  ///     takes the source's, because otherwise merging silently drops
  ///     somebody's membership discount.
  ///   * **The source's bill-level discount is dropped**, and cannot be
  ///     otherwise: two percentage discounts on one bill is not a discount
  ///     anybody agreed to. Line discounts are untouched, because those belong
  ///     to the lines and travel with them.
  ///
  /// Both halves are written in one transaction. A half-applied merge would
  /// leave items on neither bill, which is the one outcome a till must never
  /// produce.
  Future<void> merge(String fromOrderId, String intoOrderId) async {
    await _db.transaction(() async {
      final from = await (_db.select(_db.orders)
            ..where((o) => o.id.equals(fromOrderId)))
          .getSingleOrNull();
      final into = await (_db.select(_db.orders)
            ..where((o) => o.id.equals(intoOrderId)))
          .getSingleOrNull();

      await (_db.update(_db.orderLines)
            ..where((l) => l.orderId.equals(fromOrderId)))
          .write(OrderLinesCompanion(orderId: Value(intoOrderId)));

      if (from != null && into != null) {
        await (_db.update(_db.orders)..where((o) => o.id.equals(intoOrderId)))
            .write(
          OrdersCompanion(
            covers: Value((into.covers ?? 0) + (from.covers ?? 0)),
            // Only onto a bill with nobody on it. See the note above.
            customerId: into.customerId == null
                ? Value(from.customerId)
                : const Value.absent(),
            customerName: into.customerId == null
                ? Value(from.customerName)
                : const Value.absent(),
            customerDiscountType: into.customerId == null
                ? Value(from.customerDiscountType)
                : const Value.absent(),
            customerDiscountValue: into.customerId == null
                ? Value(from.customerDiscountValue)
                : const Value.absent(),
            customerPhone: into.customerId == null
                ? Value(from.customerPhone)
                : const Value.absent(),
            customerEmail: into.customerId == null
                ? Value(from.customerEmail)
                : const Value.absent(),
            customerCardNumber: into.customerId == null
                ? Value(from.customerCardNumber)
                : const Value.absent(),
          ),
        );
      }

      // Both bills say what happened, in their own notes, so neither audit
      // trail ends without an explanation. A table that simply vanished at
      // half past nine is the sort of thing a manager cannot reconstruct.
      if (from != null) {
        await (_db.update(_db.orders)..where((o) => o.id.equals(fromOrderId)))
            .write(
          OrdersCompanion(
            status: const Value('void'),
            notes: Value(
              _note(from.notes, 'Merged into table ${into?.tableNumber ?? "?"}'),
            ),
          ),
        );
      }
      if (into != null) {
        await (_db.update(_db.orders)..where((o) => o.id.equals(intoOrderId)))
            .write(
          OrdersCompanion(
            notes: Value(
              _note(into.notes, 'Merged from table ${from?.tableNumber ?? "?"}'),
            ),
          ),
        );
      }

      await _orders.recalculate(intoOrderId);
      await _orders.recalculate(fromOrderId);
    });
  }

  /// Add a line to a bill's notes without losing what was already there.
  static String _note(String? existing, String line) =>
      existing == null || existing.trim().isEmpty
          ? line
          : '${existing.trim()}\n$line';

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
              // Half of a practice bill is still practice.
              training: Value(source.training),
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

/// The table a bill is being moved onto already has a party on it.
///
/// Carries the bill that is in the way, because the useful next question is
/// "merge these two?" and answering it needs to know what is being merged.
class TableOccupied implements Exception {
  const TableOccupied(this.tableNumber, this.existing);

  final int tableNumber;
  final Order existing;

  @override
  String toString() => 'Table $tableNumber already has an open bill.';
}
