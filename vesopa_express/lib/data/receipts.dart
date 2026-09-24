/// The ticket: which printer this kiosk has, and printing an order on it.
library;

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../printing/ticket_builder.dart';
import '../printing/ticket_printer.dart';
import 'models.dart';

/// This kiosk's printer, or null when none has been chosen.
class TicketPrinterController extends AsyncNotifier<TicketPrinter?> {
  static const _store = TicketPrinterStore();

  @override
  Future<TicketPrinter?> build() => _store.load();

  Future<void> choose(TicketPrinter printer) async {
    await _store.save(printer);
    state = AsyncData(printer);
  }

  Future<void> forget() async {
    await _store.clear();
    state = const AsyncData(null);
  }
}

final ticketPrinterProvider =
    AsyncNotifierProvider<TicketPrinterController, TicketPrinter?>(TicketPrinterController.new);

/// Print [order]'s ticket on [printer]. Throws, saying why, when it cannot.
Future<void> printOrderTicket({
  required TicketPrinter printer,
  required OrderView order,
  required KioskConfig config,
}) async {
  final builder = await TicketBuilder.create(paperWidthMm: printer.paperWidthMm, codePage: printer.codePage);
  await printer.send(builder.ticket(
    order: order,
    face: config.receipt,
    venueName: config.venueName,
    kioskName: config.kioskName,
  ));
}

/// The slip Settings prints to prove a printer works.
Future<void> printTestTicket({required TicketPrinter printer, required KioskConfig? config}) async {
  final builder = await TicketBuilder.create(paperWidthMm: printer.paperWidthMm, codePage: printer.codePage);
  await printer.send(builder.testSlip(
    face: config?.receipt ?? const ReceiptFace(),
    venueName: config?.venueName ?? 'Vesopa Express',
    kioskName: config?.kioskName ?? 'Kiosk',
    printer: printer.summary,
  ));
}
