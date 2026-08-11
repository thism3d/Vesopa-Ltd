import 'package:drift/drift.dart';

import '../printing/print_service.dart';
import '../printing/printer_transport.dart';
import '../printing/receipt_builder.dart';
import 'local/database.dart';
import 'printer_settings.dart';

/// Why a kitchen ticket is being fired.
///
/// It reaches the top of the ticket, because the kitchen works the two
/// differently: a saved table is food to start now against a bill that stays
/// open, a sale is food already paid for. A ticket that does not say which is
/// a ticket somebody has to walk out and ask about.
enum KitchenFire {
  sale('Sale'),
  table('Table saved');

  const KitchenFire(this.headline);
  final String headline;
}

/// Sends the kitchen its copy of what has just been rung up.
///
/// Sits between the order repository and [PrintService] because the routing
/// question — *which* items, to *which* printers — is a catalogue question,
/// and the print service should not have to know what a product is.
///
/// Nothing in here is allowed to stop a sale. Every entry point returns a
/// description of what failed rather than throwing: the money has already been
/// taken by the time the kitchen hears about it, and a dead printer in the
/// kitchen must never be able to hold up the queue at the counter.
class KitchenPrinting {
  const KitchenPrinting(this._db);

  final AppDatabase _db;

  /// Fire the lines of [orderId] that have not been sent yet.
  ///
  /// Returns null when everything went out — including the ordinary case of
  /// there being nothing to send — or a sentence naming what failed.
  ///
  /// Lines are marked as sent only after the printers have taken them, so a
  /// failed run can be retried by saving the table again. The mark is per
  /// line rather than per order because a bill grows all service: the second
  /// save must fire the second course and nothing else.
  Future<String?> fire({
    required String orderId,
    required KitchenFire reason,
    required PrinterSettings printers,
    String? staffName,
  }) async {
    final order = await (_db.select(_db.orders)
          ..where((o) => o.id.equals(orderId)))
        .getSingleOrNull();
    if (order == null) return null;

    final unsent = await (_db.select(_db.orderLines)
          ..where((l) =>
              l.orderId.equals(orderId) & l.kitchenPrintedAt.isNull()))
        .get();
    if (unsent.isEmpty) return null;

    // Only the products actually on this ticket, so a large catalogue is not
    // read into memory to print three items.
    final plus = unsent.map((l) => l.pluId).toSet();
    final catalogue = await (_db.select(_db.products)
          ..where((p) => p.pluId.isIn(plus)))
        .get();

    final routesByPlu = {
      for (final product in catalogue)
        product.pluId: KitchenRouting.parse(product.printerRoutes),
    };

    // Nothing on this bill is routed anywhere. Not a failure, and the lines
    // are still marked: leaving them unsent would mean re-examining them on
    // every subsequent save for the life of the bill.
    final routed =
        unsent.where((l) => (routesByPlu[l.pluId] ?? const {}).isNotEmpty);
    if (routed.isEmpty) {
      await _markSent(unsent.map((l) => l.id));
      return null;
    }

    final service = PrintService(
      await ReceiptBuilder.create(),
      PrinterSetup(stations: printers.stations),
    );

    try {
      await service.printKitchenTickets(
        order: order,
        lines: unsent,
        routesByPlu: routesByPlu,
        headline: reason.headline,
        staffName: staffName,
      );
    } on PrintException catch (e) {
      // Partial success is the normal shape of this failure: KP 1 printed and
      // KP 2 is unplugged. The lines are deliberately left unsent so that
      // saving the table again retries — the cost is a duplicate ticket on the
      // printer that worked, which a kitchen can throw away. The other way
      // round, food never reaches the pass and nobody finds out until a
      // customer asks.
      return e.message;
    } catch (e) {
      return '$e';
    }

    await _markSent(unsent.map((l) => l.id));
    return null;
  }

  /// Let a bill be fired again from scratch — the reprint path.
  Future<void> clearSent(String orderId) async {
    await (_db.update(_db.orderLines)..where((l) => l.orderId.equals(orderId)))
        .write(const OrderLinesCompanion(kitchenPrintedAt: Value(null)));
  }

  Future<void> _markSent(Iterable<String> lineIds) async {
    final ids = lineIds.toList();
    if (ids.isEmpty) return;
    await (_db.update(_db.orderLines)..where((l) => l.id.isIn(ids)))
        .write(OrderLinesCompanion(kitchenPrintedAt: Value(DateTime.now())));
  }
}
