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
  table('Table saved'),
  reprint('Reprint');

  const KitchenFire(this.headline);
  final String headline;
}

/// What one firing of a bill did.
///
/// Carries the per-station detail rather than a sentence, because the till
/// offers to send the failures again and a retry has to know which stations
/// those were. It also has to know *which lines*: the retry re-sends the exact
/// lines that run tried, not whatever is on the bill by the time somebody
/// presses the button.
class KitchenFireResult {
  const KitchenFireResult({
    required this.orderId,
    this.stations = const [],
    this.lineIds = const [],
  });

  final String orderId;
  final List<StationPrintResult> stations;

  /// The lines this run was carrying, so a retry sends the same ticket.
  final List<String> lineIds;

  List<StationPrintResult> get failures =>
      stations.where((s) => !s.printed).toList();

  List<StationPrintResult> get printed =>
      stations.where((s) => s.printed).toList();

  bool get hasFailures => failures.isNotEmpty;

  /// Nothing was routed anywhere — the ordinary case on a counter till with no
  /// kitchen. Not worth telling anybody about.
  bool get isSilent => stations.isEmpty;

  /// The stations to send again.
  Set<String> get failedStations => {for (final s in failures) s.station};

  /// One line describing what happened, for the status chip.
  String get summary {
    if (isSilent) return 'Nothing to send to the kitchen.';
    if (!hasFailures) {
      final names = printed.map((s) => s.label).join(', ');
      return 'Sent to $names.';
    }
    final failed = failures.map((s) => '${s.label} (${s.error})').join('; ');
    if (printed.isEmpty) return 'Could not print: $failed';
    return 'Sent to ${printed.map((s) => s.label).join(', ')}. '
        'Could not print: $failed';
  }
}

/// Sends the kitchen its copy of what has just been rung up.
///
/// Sits between the order repository and [PrintService] because the routing
/// question — *which* items, to *which* printers — is a catalogue question,
/// and the print service should not have to know what a product is.
///
/// Nothing in here is allowed to stop a sale. Every entry point returns a
/// description of what happened rather than throwing: the money has already
/// been taken by the time the kitchen hears about it, and a dead printer in
/// the kitchen must never be able to hold up the queue at the counter.
class KitchenPrinting {
  const KitchenPrinting(this._db);

  final AppDatabase _db;

  /// Fire the lines of [orderId] that have not been sent yet.
  ///
  /// Lines are marked as sent once the run is over, whether or not every
  /// station took them. That is deliberate, and it is the opposite of what this
  /// used to do: leaving them unsent meant the *next* save re-fired them, so a
  /// venue with one dead printer got a duplicate ticket at every working
  /// station every time anybody touched the bill. The failed stations are
  /// reported instead, with a retry that sends exactly those — which puts the
  /// decision in the hands of the person who can see the printer.
  ///
  /// The mark is per line rather than per order because a bill grows all
  /// service: the second save must fire the second course and nothing else.
  Future<KitchenFireResult> fire({
    required String orderId,
    required KitchenFire reason,
    required PrinterSettings printers,
    Map<String, String> stationNames = const {},
    String? staffName,
  }) async {
    final order = await (_db.select(
      _db.orders,
    )..where((o) => o.id.equals(orderId))).getSingleOrNull();
    if (order == null) return KitchenFireResult(orderId: orderId);

    final unsent =
        await (_db.select(_db.orderLines)..where(
              (l) => l.orderId.equals(orderId) & l.kitchenPrintedAt.isNull(),
            ))
            .get();
    if (unsent.isEmpty) return KitchenFireResult(orderId: orderId);

    final result = await _run(
      order: order,
      lines: unsent,
      reason: reason,
      printers: printers,
      stationNames: stationNames,
      staffName: staffName,
    );

    await _markSent(unsent.map((l) => l.id));
    return result;
  }

  /// Send a previous run's ticket again, to the stations it failed at.
  ///
  /// Takes the line ids from the run that failed rather than re-reading the
  /// bill, so a retry pressed a minute later prints what the kitchen was
  /// supposed to get — not that plus whatever has been added since.
  Future<KitchenFireResult> retry({
    required KitchenFireResult previous,
    required PrinterSettings printers,
    Map<String, String> stationNames = const {},
    String? staffName,
  }) async {
    final order = await (_db.select(
      _db.orders,
    )..where((o) => o.id.equals(previous.orderId))).getSingleOrNull();
    if (order == null) return KitchenFireResult(orderId: previous.orderId);

    final lines = await (_db.select(
      _db.orderLines,
    )..where((l) => l.id.isIn(previous.lineIds))).get();
    if (lines.isEmpty) return KitchenFireResult(orderId: previous.orderId);

    return _run(
      order: order,
      lines: lines,
      reason: KitchenFire.reprint,
      printers: printers,
      stationNames: stationNames,
      staffName: staffName,
      onlyStations: previous.failedStations,
    );
  }

  Future<KitchenFireResult> _run({
    required Order order,
    required List<OrderLine> lines,
    required KitchenFire reason,
    required PrinterSettings printers,
    Map<String, String> stationNames = const {},
    String? staffName,
    Set<String>? onlyStations,
  }) async {
    // Only the products actually on this ticket, so a large catalogue is not
    // read into memory to print three items.
    final plus = lines.map((l) => l.pluId).toSet();
    final catalogue = await (_db.select(
      _db.products,
    )..where((p) => p.pluId.isIn(plus))).get();

    final routesByPlu = {
      for (final product in catalogue)
        product.pluId: KitchenRouting.parse(product.printerRoutes),
    };

    // Nothing on this bill goes anywhere. Returned before building anything:
    // this is the ordinary case on a counter till with no kitchen, it happens
    // on every sale, and loading the ESC/POS capability profile to discover
    // there is nothing to print is work worth not doing.
    if (routesByPlu.values.every((r) => r.isEmpty)) {
      return KitchenFireResult(
        orderId: order.id,
        lineIds: lines.map((l) => l.id).toList(),
      );
    }

    final service = PrintService(
      await ReceiptBuilder.create(paperWidthMm: printers.receiptWidthMm),
      PrinterSetup(printers: printers, stationNames: stationNames),
    );

    List<StationPrintResult> stations;
    try {
      stations = await service.printKitchenTickets(
        order: order,
        lines: lines,
        routesByPlu: routesByPlu,
        headline: reason.headline,
        staffName: staffName,
        onlyStations: onlyStations,
      );
    } catch (e) {
      // printKitchenTickets reports per station rather than throwing, so this
      // is something further up — building the ticket, say. Reported as a
      // single unnamed failure rather than lost.
      stations = [
        StationPrintResult(station: '', label: 'Kitchen', error: '$e'),
      ];
    }

    return KitchenFireResult(
      orderId: order.id,
      stations: stations,
      lineIds: lines.map((l) => l.id).toList(),
    );
  }

  /// Let a bill be fired again from scratch — the reprint path.
  Future<void> clearSent(String orderId) async {
    await (_db.update(
      _db.orderLines,
    )..where((l) => l.orderId.equals(orderId))).write(
      const OrderLinesCompanion(kitchenPrintedAt: Value(null)),
    );
  }

  Future<void> _markSent(Iterable<String> lineIds) async {
    final ids = lineIds.toList();
    if (ids.isEmpty) return;
    await (_db.update(_db.orderLines)..where((l) => l.id.isIn(ids))).write(
      OrderLinesCompanion(kitchenPrintedAt: Value(DateTime.now())),
    );
  }
}
