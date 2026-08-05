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

  /// Send each line to the station its product is routed to. One ticket per
  /// station, so the kitchen is not handed drinks orders and the bar is not
  /// handed food.
  Future<void> printKitchenTickets({
    required Order order,
    required List<OrderLine> lines,
    required Map<int, String?> routeByPlu,
  }) async {
    final byStation = <String, List<OrderLine>>{};
    for (final line in lines) {
      final station = routeByPlu[line.pluId];
      if (station == null || station.isEmpty) continue;
      byStation.putIfAbsent(station, () => []).add(line);
    }

    final failures = <String>[];
    for (final entry in byStation.entries) {
      final printer = setup.stations[entry.key];
      if (printer == null) {
        failures.add('${entry.key}: no printer configured');
        continue;
      }
      try {
        await PrinterTransport.of(printer).send(
          _builder.kitchenTicket(
            order: order,
            lines: entry.value,
            station: entry.key,
          ),
        );
      } catch (e) {
        // Carry on to the other stations: one dead bar printer must not stop
        // the food reaching the kitchen.
        failures.add('${entry.key}: $e');
      }
    }

    if (failures.isNotEmpty) {
      throw PrintException(failures.join('; '));
    }
  }

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
