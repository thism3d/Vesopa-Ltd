import 'package:drift/drift.dart';
import 'package:uuid/uuid.dart';

import '../printing/print_service.dart';
import '../printing/printer_transport.dart';
import '../printing/receipt_builder.dart';
import 'kitchen_screens.dart';
import 'local/database.dart';
import 'printer_settings.dart';

/// Why a kitchen ticket is being fired.
///
/// It reaches the top of the ticket, because the kitchen works the two
/// differently: a saved table is food to start now against a bill that stays
/// open, a sale is food already paid for. A ticket that does not say which is
/// a ticket somebody has to walk out and ask about.
enum KitchenFire {
  sale('Sale', 'sale'),
  table('Table saved', 'table'),
  reprint('Reprint', 'reprint');

  const KitchenFire(this.headline, this.ticketKind);

  /// What prints at the top of the paper ticket.
  final String headline;

  /// What the server stores, and what the board reads to decide how a card is
  /// labelled. Kept separate from [headline] so the printed wording can be
  /// changed without invalidating every row already in the database.
  final String ticketKind;
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
    this.screens,
    this.roomName,
  });

  final String orderId;
  final List<StationPrintResult> stations;

  /// What happened to the half of this fire that went to kitchen screens, or
  /// null when nothing on the bill was routed to one — which is every venue
  /// that has not set a station to `screen`, and so almost every venue.
  ///
  /// Kept apart from [stations] rather than folded in as a seventh entry
  /// because the two fail differently and are recovered differently. A dead
  /// printer needs somebody to walk over and press retry; an unreachable back
  /// office is already being retried in the background and needs nobody.
  final KitchenScreenResult? screens;

  /// The lines this run was carrying, so a retry sends the same ticket.
  final List<String> lineIds;

  /// The room the table was in, carried for the same reason as [lineIds].
  ///
  /// A retry re-prints the ticket that failed, and the floor plan is read on
  /// the way *into* a fire — so without this the reprint would come out with
  /// the table number and no room, which is the one ticket where somebody is
  /// already confused about where the food is going.
  final String? roomName;

  List<StationPrintResult> get failures =>
      stations.where((s) => !s.printed).toList();

  List<StationPrintResult> get printed =>
      stations.where((s) => s.printed).toList();

  bool get hasFailures => failures.isNotEmpty;

  /// Nothing was routed anywhere — the ordinary case on a counter till with no
  /// kitchen. Not worth telling anybody about.
  bool get isSilent => stations.isEmpty && screens == null;

  /// The stations to send again.
  Set<String> get failedStations => {for (final s in failures) s.station};

  /// One line describing what happened, for the status chip.
  String get summary {
    if (isSilent) return 'Nothing to send to the kitchen.';

    final parts = <String>[];
    if (stations.isNotEmpty) {
      if (!hasFailures) {
        parts.add('Sent to ${printed.map((s) => s.label).join(', ')}.');
      } else {
        final failed = failures.map((s) => '${s.label} (${s.error})').join('; ');
        if (printed.isNotEmpty) {
          parts.add('Sent to ${printed.map((s) => s.label).join(', ')}.');
        }
        parts.add('Could not print: $failed');
      }
    }
    // Only worth a sentence when it did *not* simply work. On a venue running
    // screens the successful case is every single fire, and a chip that says
    // "sent to the kitchen screens" several hundred times a day is a chip the
    // clerk stops reading — including on the day it says something else.
    final screen = screens;
    if (screen != null && !screen.delivered) parts.add(screen.summary);

    return parts.isEmpty ? 'Sent to the kitchen.' : parts.join(' ');
  }
}

/// Sends the kitchen its copy of what has just been rung up.
///
/// Sits between the order repository and [PrintService] because the routing
/// question — *which* items, to *which* printers — is a catalogue question,
/// and the print service should not have to know what a product is.
///
/// It answers the same question for kitchen *screens*, which is why it is one
/// class and not two. A station's delivery mode decides whether its share of
/// the bill goes on paper, onto a screen, or both — and the split has to be
/// made after the routing is resolved and before either half is sent, or a
/// venue running one of each gets two tickets for the same food.
///
/// Nothing in here is allowed to stop a sale. Every entry point returns a
/// description of what happened rather than throwing: the money has already
/// been taken by the time the kitchen hears about it, and a dead printer in
/// the kitchen must never be able to hold up the queue at the counter.
class KitchenPrinting {
  const KitchenPrinting(this._db);

  static const _uuid = Uuid();

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
    Map<String, KitchenDelivery> delivery = const {},
    KitchenScreenSender? screens,
    String? office,
    String? roomName,
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
      delivery: delivery,
      screens: screens,
      office: office,
      roomName: roomName,
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
    // Printers only, and on purpose. A screen delivery that did not land is
    // already queued and being retried in the background by
    // [KitchenScreenSender], so sending it again from here would be a second
    // attempt racing the first — harmless, because the ticket id de-duplicates
    // it, but it would also tell the clerk they had fixed something they had
    // not.
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
      roomName: previous.roomName,
      onlyStations: previous.failedStations,
    );

  }

  Future<KitchenFireResult> _run({
    required Order order,
    required List<OrderLine> lines,
    required KitchenFire reason,
    required PrinterSettings printers,
    Map<String, String> stationNames = const {},
    Map<String, KitchenDelivery> delivery = const {},
    KitchenScreenSender? screens,
    String? office,
    String? roomName,
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

    // Which of the stations this bill actually touches go where. Computed from
    // the routing rather than from the whole six, so a venue that put a screen
    // on the fryer does not build a screen ticket for a round of drinks.
    final routed = {for (final set in routesByPlu.values) ...set};
    final toPrinter = {
      for (final station in routed)
        if ((delivery[station] ?? KitchenDelivery.printer).toPrinter) station,
    };
    final toScreen = {
      for (final station in routed)
        if ((delivery[station] ?? KitchenDelivery.printer).toScreen) station,
    };

    // Both halves are started before either is awaited. They are independent —
    // a POST to the back office and an ESC/POS write to a printer on the
    // counter — and running them one after the other adds the slower one's
    // latency to the clerk's wait for no reason at all.
    final screenSend = toScreen.isEmpty || screens == null || office == null
        ? null
        : screens.send(
            buildKitchenTicket(
              id: _uuid.v4(),
              office: office,
              order: order,
              lines: lines,
              routesByPlu: routesByPlu,
              screenStations: toScreen,
              kind: reason.ticketKind,
              roomName: roomName,
              staffName: staffName,
            ),
          );

    final stations = toPrinter.isEmpty
        ? const <StationPrintResult>[]
        : await _print(
            order: order,
            lines: lines,
            reason: reason,
            printers: printers,
            stationNames: stationNames,
            routesByPlu: routesByPlu,
            staffName: staffName,
            roomName: roomName,
            // The intersection, so a retry aimed at one failed station cannot
            // drag in a station that was never on paper to begin with.
            onlyStations: onlyStations == null
                ? toPrinter
                : toPrinter.intersection(onlyStations),
          );

    return KitchenFireResult(
      orderId: order.id,
      stations: stations,
      lineIds: lines.map((l) => l.id).toList(),
      screens: await screenSend,
      roomName: roomName,
    );
  }

  /// The paper half. Split out only so [_run] reads as the decision it is.
  Future<List<StationPrintResult>> _print({
    required Order order,
    required List<OrderLine> lines,
    required KitchenFire reason,
    required PrinterSettings printers,
    required Map<String, String> stationNames,
    required Map<int, Set<String>> routesByPlu,
    required Set<String> onlyStations,
    String? staffName,
    String? roomName,
  }) async {
    if (onlyStations.isEmpty) return const [];

    final service = PrintService(
      await ReceiptBuilder.create(paperWidthMm: printers.receiptWidthMm),
      PrinterSetup(printers: printers, stationNames: stationNames),
    );

    try {
      return await service.printKitchenTickets(
        order: order,
        lines: lines,
        routesByPlu: routesByPlu,
        headline: reason.headline,
        staffName: staffName,
        // The screens have carried this since kitchen screens landed; paper had
        // been left behind, so a venue with one screen and one printer got the
        // room on one ticket and not the other.
        roomName: roomName,
        onlyStations: onlyStations,
      );
    } catch (e) {
      // printKitchenTickets reports per station rather than throwing, so this
      // is something further up — building the ticket, say. Reported as a
      // single unnamed failure rather than lost.
      return [StationPrintResult(station: '', label: 'Kitchen', error: '$e')];
    }
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
