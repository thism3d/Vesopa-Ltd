import 'dart:typed_data';

import '../data/local/database.dart';
import '../data/session_repository.dart';
import 'printer_transport.dart';
import 'receipt_builder.dart';

/// Where each document goes. Configured in Settings; a venue typically has one
/// receipt printer at the till and one or more kitchen/bar printers.
class PrinterSetup {
  const PrinterSetup({
    this.receipt,
    this.stations = const {},
    this.shopName,
    this.footer,
    this.logo,
  });

  final PrinterConfig? receipt;

  /// Station name ("kitchen", "bar") -> printer.
  final Map<String, PrinterConfig> stations;

  final String? shopName;
  final String? footer;
  final Uint8List? logo;
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

  static Future<PrintService> create(PrinterSetup setup) async {
    return PrintService(await ReceiptBuilder.create(), setup);
  }

  Future<void> printReceipt({
    required Order order,
    required List<OrderLine> lines,
    required List<Payment> payments,
  }) async {
    final printer = setup.receipt;
    if (printer == null) throw StateError('No receipt printer configured.');

    await PrinterTransport.of(printer).send(
      _builder.receipt(
        order: order,
        lines: lines,
        payments: payments,
        shopName: setup.shopName,
        footer: setup.footer,
        logo: setup.logo,
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
  /// Stations are printed in a stable order (KP 1 before KP 2) so a kitchen
  /// reading two printers sees the same sequence every service.
  Future<void> printKitchenTickets({
    required Order order,
    required List<OrderLine> lines,
    required Map<int, Set<String>> routesByPlu,
    String? headline,
    String? staffName,
  }) async {
    final byStation = <String, List<OrderLine>>{};
    for (final line in lines) {
      for (final station in routesByPlu[line.pluId] ?? const <String>{}) {
        if (station.isEmpty) continue;
        byStation.putIfAbsent(station, () => []).add(line);
      }
    }
    if (byStation.isEmpty) return;

    final stations = byStation.keys.toList()..sort();

    final failures = <String>[];
    for (final station in stations) {
      final printer = setup.stations[station];
      if (printer == null) {
        failures.add('${_stationLabel(station)}: no printer set up');
        continue;
      }
      try {
        await PrinterTransport.of(printer).send(
          _builder.kitchenTicket(
            order: order,
            lines: byStation[station]!,
            station: _stationLabel(station),
            headline: headline,
            staffName: staffName,
          ),
        );
      } catch (e) {
        // Carry on to the other stations: one dead printer at the bar must not
        // stop the food reaching the kitchen.
        failures.add('${_stationLabel(station)}: $e');
      }
    }

    if (failures.isNotEmpty) {
      throw PrintException(failures.join('; '));
    }
  }

  /// "kp1" as the kitchen reads it. Falls back to the raw key so an
  /// unrecognised station still names itself on the ticket.
  static String _stationLabel(String station) =>
      PrinterRole.fromStation(station)?.label ?? station.toUpperCase();

  Future<void> printTillReport(TillReport report) async {
    final printer = setup.receipt;
    if (printer == null) throw StateError('No receipt printer configured.');
    await PrinterTransport.of(printer)
        .send(_builder.tillReport(report, shopName: setup.shopName));
  }

  Future<void> openCashDrawer() async {
    final printer = setup.receipt;
    if (printer == null) throw StateError('No receipt printer configured.');
    await PrinterTransport.of(printer).send(_builder.openDrawer());
  }
}

class PrintException implements Exception {
  PrintException(this.message);
  final String message;

  @override
  String toString() => message;
}
