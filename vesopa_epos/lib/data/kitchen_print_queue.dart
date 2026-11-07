/// Kitchen tickets from Vesopa Go, printed on this till's kitchen printers.
///
/// A phone has no kitchen printer, so at a venue whose stations are set to
/// Printer (or Both) a Go order reached the kitchen board and never reached
/// paper (testers at Pontardawe, 2026-11-07). The server keeps those tickets in
/// a queue (`/till/kitchen/print-queue`, vesopa_server/src/kitchen_prints.js)
/// and a till with a printer at the station claims its share, prints it, and
/// says how it went: the way kiosk tickets reach paper (express_orders.dart).
/// The claim is one UPDATE on the server, so two tills with a printer each
/// never print the same ticket twice.
///
/// It hears on the socket and polls behind it: the socket makes it fast, the
/// poll makes it certain on a till that was offline when the push went out.
/// Nothing here throws.
library;

import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:http/http.dart' as http;

import '../main.dart';
import '../printing/printer_transport.dart';
import '../printing/receipt_builder.dart';
import '../ui/printers_page.dart' show printerSettingsProvider;
import 'express_orders.dart' show expressPrintStations;
import 'local/database.dart';
import 'printer_settings.dart';
import 'terminal_identity.dart';
import 'till_settings.dart';

/// A line of a Go ticket, as the claim sends it.
@immutable
class GoTicketLine {
  const GoTicketLine({required this.name, required this.quantity, this.note, this.isModifier = false, this.stations = const []});

  factory GoTicketLine.fromJson(Map<String, Object?> j) => GoTicketLine(
    name: j['name'] is String ? j['name']! as String : '',
    quantity: j['quantity'] is num ? (j['quantity']! as num).toDouble() : 1,
    note: j['note'] is String ? j['note'] as String : null,
    isModifier: j['is_modifier'] == true,
    stations: [for (final s in (j['stations'] as List?) ?? const []) '$s'],
  );

  final String name;
  final double quantity;
  final String? note;
  final bool isModifier;
  final List<String> stations;
}

/// A kitchen ticket from Go this till has won the right to print.
@immutable
class GoTicketClaim {
  const GoTicketClaim({
    required this.claimId,
    required this.ticketId,
    required this.stations,
    required this.lines,
    this.kind = 'sale',
    this.tableNumber,
    this.roomName,
    this.staffName,
    this.note,
    this.placedAt,
  });

  /// Null when nothing was won: another till got there first.
  static GoTicketClaim? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final claim = raw['claim_id'];
    final ticket = raw['ticket'];
    if (claim is! String || ticket is! Map) return null;
    final t = ticket.cast<String, Object?>();
    String? text(String key) {
      final v = t[key];
      return v is String && v.trim().isNotEmpty ? v.trim() : null;
    }

    return GoTicketClaim(
      claimId: claim,
      ticketId: text('id') ?? '',
      stations: [for (final s in (raw['stations'] as List?) ?? const []) '$s'],
      lines: [
        for (final l in (t['lines'] as List?) ?? const [])
          if (l is Map) GoTicketLine.fromJson(l.cast<String, Object?>()),
      ],
      kind: text('kind') ?? 'sale',
      tableNumber: t['table_number'] is num ? (t['table_number']! as num).toInt() : null,
      roomName: text('room_name'),
      staffName: text('staff_name'),
      note: text('note'),
      placedAt: DateTime.tryParse(text('placed_at') ?? '')?.toLocal(),
    );
  }

  final String claimId;
  final String ticketId;
  final List<String> stations;
  final List<GoTicketLine> lines;
  final String kind;
  final int? tableNumber;
  final String? roomName;
  final String? staffName;
  final String? note;
  final DateTime? placedAt;

  /// What prints under the station name, so the kitchen can tell a saved table
  /// from a paid sale, and knows the phone it came from.
  String get headline => kind == 'table' ? 'Table saved - Vesopa Go' : 'Sale - Vesopa Go';

  /// The ticket for one station, in the shape the till's own tickets are
  /// printed from. A choice follows the dish printed last before it.
  ({Order order, List<OrderLine> lines}) ticketFor(String station) {
    final id = 'go-$ticketId';
    final out = <OrderLine>[];
    String? parent;
    var index = 0;
    for (final line in lines) {
      index++;
      if (!line.stations.contains(station)) continue;
      final lineId = '$id-$index';
      out.add(
        OrderLine(
          id: lineId,
          orderId: id,
          pluId: 0,
          name: line.name,
          quantity: line.quantity,
          unitPriceMinor: 0,
          taxPercentage: 0,
          lineDiscountMinor: 0,
          notes: line.note,
          parentLineId: line.isModifier ? parent : null,
        ),
      );
      if (!line.isModifier) parent = lineId;
    }
    return (
      order: Order(
        id: id,
        status: 'completed',
        subtotalMinor: 0,
        manualDiscountMinor: 0,
        discountMinor: 0,
        taxMinor: 0,
        totalMinor: 0,
        customerDiscountType: 'none',
        customerDiscountValue: 0,
        training: false,
        createdAt: placedAt ?? DateTime.now(),
        tableNumber: tableNumber,
        notes: note,
      ),
      lines: out,
    );
  }
}

/// Talking to the server about Go's tickets. Nothing here throws.
class KitchenPrintService {
  KitchenPrintService({required this.apiBase, required this.terminalToken, http.Client? client})
    : _client = client ?? http.Client();

  final String apiBase;
  final String? terminalToken;
  final http.Client _client;
  static const _quick = Duration(seconds: 10);

  bool get canAsk => terminalToken != null;

  Map<String, String> get _headers => {'Content-Type': 'application/json', 'Authorization': 'Bearer $terminalToken'};

  /// What is waiting for a printer.
  Future<List<({String ticketId, List<String> stations})>> queue() async {
    if (!canAsk) return const [];
    try {
      final res = await _client.get(Uri.parse('$apiBase/till/kitchen/print-queue'), headers: _headers).timeout(_quick);
      if (res.statusCode != 200) return const [];
      final body = jsonDecode(res.body);
      if (body is! Map || body['jobs'] is! List) return const [];
      return [
        for (final job in body['jobs'] as List)
          if (job is Map && job['ticket_id'] is String)
            (ticketId: job['ticket_id'] as String, stations: [for (final s in (job['stations'] as List?) ?? const []) '$s']),
      ];
    } catch (_) {
      return const [];
    }
  }

  /// Ask to print [stations] of a ticket. Null when nothing was won.
  Future<GoTicketClaim?> claim(String ticketId, Iterable<String> stations, {required String terminal}) async {
    if (!canAsk) return null;
    try {
      final res = await _client
          .post(
            Uri.parse('$apiBase/till/kitchen/print-queue/$ticketId/claim'),
            headers: _headers,
            body: jsonEncode({'stations': stations.toList(), 'terminal': terminal}),
          )
          .timeout(_quick);
      if (res.statusCode != 200) return null;
      return GoTicketClaim.fromJson(jsonDecode(res.body));
    } catch (_) {
      return null;
    }
  }

  /// Say how the printing went. A failure goes back on offer at the server.
  Future<void> report(GoTicketClaim claim, Map<String, String?> errorsByStation) async {
    if (!canAsk) return;
    try {
      await _client
          .post(
            Uri.parse('$apiBase/till/kitchen/print-queue/${claim.ticketId}/result'),
            headers: _headers,
            body: jsonEncode({
              'claim_id': claim.claimId,
              'results': [
                for (final e in errorsByStation.entries) {'station': e.key, 'ok': e.value == null, 'error': ?e.value},
              ],
            }),
          )
          .timeout(_quick);
    } catch (_) {
      // The claim runs out on the server and the ticket comes back on offer.
    }
  }
}

final kitchenPrintServiceProvider = Provider<KitchenPrintService>(
  (ref) => KitchenPrintService(apiBase: ref.watch(apiBaseProvider), terminalToken: ref.watch(sessionProvider).terminalToken),
);

/// Prints Go's tickets on this till's printers: on `kitchen.print` from the
/// socket and on a one-minute poll, one run at a time. A till with no kitchen
/// printer claims nothing, so it leaves every ticket to the one that can.
class GoKitchenPrinter {
  GoKitchenPrinter(this.ref);

  final Ref ref;
  bool _running = false;
  bool _again = false;

  /// Test seam: how a ticket reaches a printer.
  @visibleForTesting
  Future<void> Function(PrinterConfig printer, List<int> bytes)? sendOverride;

  Future<void> run() async {
    if (_running) {
      _again = true;
      return;
    }
    _running = true;
    try {
      do {
        _again = false;
        await _once();
      } while (_again);
    } catch (e) {
      debugPrint('Go tickets: $e');
    } finally {
      _running = false;
    }
  }

  Future<void> _once() async {
    final service = ref.read(kitchenPrintServiceProvider);
    if (!service.canAsk) return;
    final printers = await ref.read(printerSettingsProvider.future);
    final settings = ref.read(tillSettingsProvider);
    final mine = expressPrintStations(printers, settings);
    if (mine.isEmpty) return;
    for (final job in await service.queue()) {
      final wanted = job.stations.where(mine.contains).toList();
      if (wanted.isEmpty) continue;
      final claim = await service.claim(job.ticketId, wanted, terminal: ref.read(terminalNameProvider));
      if (claim == null) continue;
      await service.report(claim, await printClaim(claim, printers, settings));
    }
  }

  /// Print each won station. Station key to the printer's error, or null.
  Future<Map<String, String?>> printClaim(GoTicketClaim claim, PrinterSettings printers, TillSettings settings) async {
    final out = <String, String?>{};
    for (final station in claim.stations) {
      final printer = printers.printerForRoute(station);
      if (printer == null) {
        out[station] = 'no printer set up';
        continue;
      }
      try {
        final ticket = claim.ticketFor(station);
        final builder = await ReceiptBuilder.forPrinter(printer);
        final bytes = builder.kitchenTicket(
          order: ticket.order,
          lines: ticket.lines,
          station: settings.labelForStation(station),
          headline: claim.headline,
          staffName: claim.staffName,
          roomName: claim.roomName,
        );
        final send = sendOverride;
        if (send != null) {
          await send(printer, bytes);
        } else {
          await PrinterTransport.of(printer).send(bytes);
        }
        out[station] = null;
      } catch (e) {
        out[station] = '$e';
      }
    }
    return out;
  }
}

/// Keeps Go's ticket printer listening for as long as the shell is up.
final goKitchenPrinterProvider = Provider<GoKitchenPrinter>((ref) {
  final printer = GoKitchenPrinter(ref);
  final events = ref.watch(syncServiceProvider).events.listen((event) {
    if (event.type == 'kitchen.print') unawaited(printer.run());
  });
  final poll = Timer.periodic(const Duration(minutes: 1), (_) => unawaited(printer.run()));
  // Once at start, for anything queued while this till was off.
  unawaited(Future<void>.delayed(Duration.zero, printer.run));
  ref.onDispose(() {
    poll.cancel();
    unawaited(events.cancel());
  });
  return printer;
});
