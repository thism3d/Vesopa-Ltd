import 'dart:typed_data';

import '../data/local/database.dart';
import '../data/printer_settings.dart';
import '../data/session_repository.dart';
// Re-exports print_targets.dart, which is where PrintTarget lives.
import 'printer_transport.dart';
import 'receipt_builder.dart';

/// Everything a print run needs: which printers this terminal has, and what the
/// venue wants printed around a sale.
///
/// The printer half is the whole [PrinterSettings] rather than a pre-resolved
/// pair, because resolving a target to a device involves the fallback chain —
/// an unset cash drawer uses the receipt printer — and doing that in one place
/// is what keeps the till and the setup screen agreeing about where a document
/// will come out.
class PrinterSetup {
  const PrinterSetup({
    this.printers = const PrinterSettings(),
    this.stationNames = const {},
    this.shopName,
    this.footer,
    this.logo,
  });

  final PrinterSettings printers;

  /// What the venue calls each station, keyed by station key. Set in the back
  /// office so every till and every ticket agrees; empty means "use the
  /// built-in labels".
  final Map<String, String> stationNames;

  final String? shopName;
  final String? footer;
  final Uint8List? logo;

  PrinterConfig? deviceFor(PrintTarget target) => printers.deviceFor(target);

  /// The name to print at the top of a station's ticket.
  ///
  /// The venue's name wins. A kitchen that calls KP 3 the fryer should read
  /// FRYER on the paper — "KP 3" is a slot number that means nothing to the
  /// person picking the ticket up.
  String labelForStation(String station) {
    final named = stationNames[station]?.trim();
    if (named != null && named.isNotEmpty) return named;
    return PrintTarget.fromStation(station)?.label ?? station.toUpperCase();
  }
}

/// What happened at one station on one kitchen run.
///
/// Structured rather than a sentence because the till offers to *retry* a
/// failure, and a retry needs to know which stations to send to again. Joining
/// the failures into a string threw that away, so the only retry available was
/// "print the whole bill everywhere".
class StationPrintResult {
  const StationPrintResult({
    required this.station,
    required this.label,
    this.error,
  });

  /// The routing key ("kp3").
  final String station;

  /// What the kitchen calls it.
  final String label;

  /// Null when the ticket printed.
  final String? error;

  bool get printed => error == null;
}

/// Prints receipts, kitchen tickets and reports.
///
/// Printing never blocks a sale: if a printer is unreachable the error is
/// surfaced to the clerk, but the money has already been taken and recorded.
/// A dead printer must not stop the till trading.
class PrintService {
  PrintService(this._builder, this.setup);

  final ReceiptBuilder _builder;
  PrinterSetup setup;

  /// A builder laid out for one specific printer.
  ///
  /// [_builder] is built once for the receipt printer and is what most
  /// documents go through. That is wrong for any document sent somewhere else:
  /// a Z report on a 58mm printer laid out at 48 columns prints the money off
  /// the edge of the paper, and — since the code page became a per-printer
  /// setting — a printer that needs the pound-sign workaround would not get it
  /// unless it happened to be the receipt printer too.
  ///
  /// Built per document rather than cached per printer: it parses no files (the
  /// capability profile is loaded once by the package) and a venue prints a Z
  /// twice a day.
  Future<ReceiptBuilder> _for(PrinterConfig printer) =>
      ReceiptBuilder.forPrinter(printer);

  static Future<PrintService> create(PrinterSetup setup) async {
    final receipt = setup.printers.receiptPrinter;
    return PrintService(
      receipt == null
          ? await ReceiptBuilder.create(
              paperWidthMm: setup.printers.receiptWidthMm,
            )
          : await ReceiptBuilder.forPrinter(receipt),
      setup,
    );
  }

  /// The customer's copy, or the venue's own — same document, different paper,
  /// possibly a different printer.
  Future<void> printReceipt({
    required Order order,
    required List<OrderLine> lines,
    required List<Payment> payments,
    PrintTarget target = PrintTarget.customerReceipt,
  }) async {
    final printer = setup.deviceFor(target);
    if (printer == null) {
      throw StateError('No printer set up for ${target.label.toLowerCase()}.');
    }

    final builder = await _for(printer);
    await PrinterTransport.of(printer).send(
      builder.receipt(
        order: order,
        lines: lines,
        payments: payments,
        shopName: setup.shopName,
        footer: setup.footer,
        logo: setup.logo,
        // The venue's copy is marked as such, so a stack of them on the desk
        // cannot be mistaken for receipts that were never handed over.
        heading: target == PrintTarget.merchantCopy ? 'MERCHANT COPY' : null,
      ),
    );
  }

  /// Send each line to every station its product is routed to.
  ///
  /// A product may sit on more than one printer — a steak goes to the grill
  /// and to the pass — so this is a fan-out, not a lookup: one ticket per
  /// station, each carrying only that station's items. A station gets a ticket
  /// or it does not; it never gets somebody else's items to filter out by eye.
  ///
  /// Stations are printed in target order (KP 1 before KP 2, the counter last)
  /// so a kitchen reading two printers sees the same sequence every service.
  ///
  /// Returns one result per station rather than throwing. A dead printer at the
  /// bar must not stop the food reaching the kitchen, and the caller needs to
  /// know exactly which stations to offer a retry for.
  Future<List<StationPrintResult>> printKitchenTickets({
    required Order order,
    required List<OrderLine> lines,
    required Map<String, Set<String>> routesByLine,
    String? headline,
    String? staffName,
    String? roomName,
    Set<String>? onlyStations,
  }) async {
    final byStation = <String, List<OrderLine>>{};
    for (final line in lines) {
      for (final station in routesByLine[line.id] ?? const <String>{}) {
        if (station.isEmpty) continue;
        if (onlyStations != null && !onlyStations.contains(station)) continue;
        byStation.putIfAbsent(station, () => []).add(line);
      }
    }
    if (byStation.isEmpty) return const [];

    final stations = byStation.keys.toList()
      ..sort((a, b) => _order(a).compareTo(_order(b)));

    final results = <StationPrintResult>[];
    for (final station in stations) {
      final label = setup.labelForStation(station);
      final printer = setup.printers.printerForRoute(station);
      if (printer == null) {
        results.add(
          StationPrintResult(
            station: station,
            label: label,
            error: 'no printer set up',
          ),
        );
        continue;
      }
      try {
        final builder = await _for(printer);
        await PrinterTransport.of(printer).send(
          builder.kitchenTicket(
            order: order,
            lines: byStation[station]!,
            station: label,
            headline: headline,
            staffName: staffName,
            roomName: roomName,
          ),
        );
        results.add(StationPrintResult(station: station, label: label));
      } catch (e) {
        results.add(
          StationPrintResult(station: station, label: label, error: '$e'),
        );
      }
    }

    return results;
  }

  /// Sort key for a station, so tickets always come off in the same order.
  static int _order(String station) =>
      PrintTarget.fromStation(station)?.index ?? 999;

  Future<void> printTillReport(TillReport report) async {
    final printer = setup.deviceFor(PrintTarget.tillReport);
    if (printer == null) throw StateError('No printer set up for reports.');
    // The report's own printer, not the receipt printer's builder. A venue
    // that sends its Z to the office printer on a 58mm roll was getting an
    // 80mm layout, and one whose report printer needs the pound-sign
    // workaround was not getting it.
    final builder = await _for(printer);
    await PrinterTransport.of(
      printer,
    ).send(builder.tillReport(report, shopName: setup.shopName));
  }

  /// The slip that goes with a card that has just been issued.
  ///
  /// Printed on the receipt printer rather than the report one. This is a slip
  /// handed to somebody — the member, or whoever is going to encode the plastic
  /// — and the receipt printer is the one at the counter where they are
  /// standing. A venue that sends its reports to an office printer at the back
  /// would otherwise have to go and fetch it.
  Future<void> printCardSlip({
    required String kindLabel,
    required String cardNumber,
    required String track,
    String? holder,
    String? issuedBy,
  }) async {
    final printer = setup.deviceFor(PrintTarget.customerReceipt);
    if (printer == null) {
      throw StateError('No receipt printer is set up on this till.');
    }

    final builder = await _for(printer);
    await PrinterTransport.of(printer).send(
      builder.cardSlip(
        kindLabel: kindLabel,
        cardNumber: cardNumber,
        track: track,
        holder: holder,
        shopName: setup.shopName,
        issuedBy: issuedBy,
      ),
    );
  }

  Future<void> openCashDrawer() async {
    final printer = setup.deviceFor(PrintTarget.cashDrawer);
    if (printer == null) {
      throw StateError('No printer set up for the cash drawer.');
    }
    await PrinterTransport.of(printer).send(_builder.openDrawer());
  }
}

class PrintException implements Exception {
  PrintException(this.message);
  final String message;

  @override
  String toString() => message;
}
