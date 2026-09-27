/// Orders paid for at a Vesopa Express kiosk, as the till hears about them.
///
/// WHAT THE TILL DOES WITH THEM
///
/// Two things, and the server already does its half of both:
///
///   * **It is told.** A paid kiosk order is announced (`express.order` on the
///     socket, and `GET /till/express/orders` behind it) and the till raises a
///     card with Ready and Collected on it. That is how a counter-service venue
///     with no kitchen screen moves a number up the collection board.
///   * **It prints for the kitchen.** A kiosk has no kitchen printer of its
///     own, so a station set to Printer (or Both) would never see a kiosk
///     ticket. The server keeps those tickets in a queue; a till with a printer
///     at one of the stations claims its share, prints it, and says how it went
///     (`/till/express/print-queue`). The claim is one UPDATE on the server, so
///     two tills with a printer each never print the same ticket twice.
///
/// Pay-at-the-counter kiosk orders are not here. They arrive as dine-in orders
/// (see dinein_orders.dart), because the till takes the money for them.
///
/// Like the dine-in feed, it hears on the socket and polls behind it: the
/// socket makes it fast, the poll makes it certain on a till that was offline
/// when the push went out. Nothing here throws.
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
import 'local/database.dart';
import 'printer_settings.dart';
import 'sync_service.dart';
import 'terminal_identity.dart';
import 'till_settings.dart';

/// One line of a kiosk order.
@immutable
class ExpressLine {
  const ExpressLine({
    required this.name,
    required this.qty,
    this.unitMinor = 0,
    this.isModifier = false,
    this.note,
    this.stations = const [],
  });

  final String name;
  final int qty;
  final int unitMinor;

  /// An answer to the dish before it ("No onions", "Large"). The server sends
  /// them straight after their dish, which is the only link it keeps.
  final bool isModifier;
  final String? note;

  /// On a print job only: the stations of the claim this line goes to.
  final List<String> stations;

  static ExpressLine fromJson(Map<String, Object?> raw) => ExpressLine(
    name: _str(raw['name']),
    qty: _int(raw['qty'], 1),
    unitMinor: _int(raw['unit_minor']),
    isModifier: raw['is_modifier'] == true || raw['is_modifier'] == 1,
    note: _nullableStr(raw['note']),
    stations: [for (final s in (raw['stations'] as List?) ?? const []) '$s'],
  );
}

/// One kiosk order a till should know about: paid and being made, or ready
/// and waiting to be collected.
@immutable
class ExpressOrder {
  const ExpressOrder({
    required this.id,
    required this.number,
    required this.status,
    required this.orderType,
    required this.totalMinor,
    required this.kiosk,
    required this.paidAt,
    required this.lines,
    this.customerName,
  });

  final int id;

  /// The collection number, as on the customer's screen and the board.
  final int number;

  /// paid | ready.
  final String status;

  /// eat_in | take_away.
  final String orderType;
  final int totalMinor;
  final String kiosk;
  final DateTime paidAt;
  final List<ExpressLine> lines;
  final String? customerName;

  bool get isPaid => status == 'paid';
  bool get isReady => status == 'ready';
  bool get eatIn => orderType == 'eat_in';

  String get orderTypeLabel => eatIn ? 'Eat in' : 'Take away';

  Iterable<ExpressLine> get dishes => lines.where((l) => !l.isModifier);

  int get itemCount => dishes.fold(0, (sum, line) => sum + line.qty);

  static ExpressOrder? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final map = raw.cast<String, Object?>();
    final id = _int(map['id']);
    if (id == 0) return null;
    return ExpressOrder(
      id: id,
      number: _int(map['number']),
      status: _str(map['status'], 'paid'),
      orderType: _str(map['order_type'], 'take_away'),
      totalMinor: _int(map['total_minor']),
      kiosk: _nullableStr(map['kiosk']) ?? 'Vesopa Express',
      // Now rather than 1970, for the same reason as a dine-in order: this
      // drives "how long has it been waiting".
      paidAt:
          DateTime.tryParse(_str(map['paid_at']))?.toLocal() ?? DateTime.now(),
      lines: [
        for (final line in (map['lines'] as List?) ?? const [])
          if (line is Map) ExpressLine.fromJson(line.cast<String, Object?>()),
      ],
      customerName: _nullableStr(map['customer_name']),
    );
  }
}

/// What the server says about kiosk orders for this venue right now.
@immutable
class ExpressFeed {
  const ExpressFeed({
    this.enabled = false,
    this.notifyTill = false,
    this.orders = const [],
  });

  /// Vesopa Express switched on for the venue at all.
  final bool enabled;

  /// The back office's "tell the tills" tick. Off means no card is raised,
  /// whatever this terminal is set to.
  final bool notifyTill;
  final List<ExpressOrder> orders;

  static const none = ExpressFeed();

  /// The orders a till should raise a card for.
  List<ExpressOrder> get announced => enabled && notifyTill ? orders : const [];

  static ExpressFeed? fromJson(Object? raw) {
    if (raw is! Map) return null;
    return ExpressFeed(
      enabled: raw['enabled'] == true,
      notifyTill: raw['notify_till'] == true,
      orders: [
        for (final o in (raw['orders'] as List?) ?? const [])
          ?ExpressOrder.fromJson(o),
      ],
    );
  }
}

/// A kitchen ticket this till has won the right to print.
@immutable
class ExpressPrintClaim {
  const ExpressPrintClaim({
    required this.claimId,
    required this.orderId,
    required this.number,
    required this.orderTypeLabel,
    required this.stations,
    required this.lines,
    this.customerName,
    this.kiosk,
    this.placedAt,
  });

  final String claimId;
  final int orderId;
  final int number;
  final String orderTypeLabel;
  final List<String> stations;
  final List<ExpressLine> lines;
  final String? customerName;
  final String? kiosk;
  final DateTime? placedAt;

  /// Null when nothing was won: another till got there first.
  static ExpressPrintClaim? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final claim = _nullableStr(raw['claim_id']);
    final ticket = raw['ticket'];
    if (claim == null || ticket is! Map) return null;
    final t = ticket.cast<String, Object?>();
    return ExpressPrintClaim(
      claimId: claim,
      orderId: _int(t['order_id']),
      number: _int(t['number']),
      orderTypeLabel: _nullableStr(t['order_type_label']) ?? 'Take away',
      stations: [for (final s in (raw['stations'] as List?) ?? const []) '$s'],
      lines: [
        for (final line in (t['lines'] as List?) ?? const [])
          if (line is Map) ExpressLine.fromJson(line.cast<String, Object?>()),
      ],
      customerName: _nullableStr(t['customer_name']),
      kiosk: _nullableStr(t['kiosk']),
      placedAt: DateTime.tryParse(_str(t['placed_at']))?.toLocal(),
    );
  }

  /// The ticket for one station, in the shape the till's own kitchen tickets
  /// are printed from, so a kiosk ticket looks like every other ticket the
  /// kitchen reads: large dishes, indented add-ons, no prices.
  ///
  /// The server keeps no parent link on a line; an add-on follows its dish. So
  /// each add-on hangs off the dish printed last before it.
  ({Order order, List<OrderLine> lines}) ticketFor(String station) {
    final placed = placedAt ?? DateTime.now();
    final id = 'express-$orderId';
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
          quantity: line.qty.toDouble(),
          unitPriceMinor: line.unitMinor,
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
        createdAt: placed,
        notes: customerName == null ? null : 'Name: $customerName',
      ),
      lines: out,
    );
  }

  /// What prints under the station name: the number, and how it is eaten.
  String get headline => 'Kiosk no. $number - $orderTypeLabel';
}

String _str(Object? value, [String fallback = '']) =>
    value is String ? value : fallback;

String? _nullableStr(Object? value) {
  final text = value is String ? value.trim() : '';
  return text.isEmpty ? null : text;
}

int _int(Object? value, [int fallback = 0]) =>
    value is num ? value.toInt() : fallback;

/// Talking to the server about kiosk orders. Nothing here throws.
class ExpressService {
  ExpressService({
    required this.apiBase,
    required this.terminalToken,
    http.Client? client,
  }) : _client = client ?? http.Client();

  final String apiBase;
  final String? terminalToken;
  final http.Client _client;

  static const _quick = Duration(seconds: 8);

  bool get canAsk => terminalToken != null;

  Map<String, String> get _headers => {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer $terminalToken',
  };

  /// Null when the till could not ask; [ExpressFeed.none] from a server that
  /// has no kiosk at all (a 404 from one that predates Vesopa Express).
  Future<ExpressFeed?> orders() async {
    if (!canAsk) return null;
    try {
      final res = await _client
          .get(Uri.parse('$apiBase/till/express/orders'), headers: _headers)
          .timeout(_quick);
      if (res.statusCode == 404) return ExpressFeed.none;
      if (res.statusCode != 200) return null;
      return ExpressFeed.fromJson(jsonDecode(res.body));
    } catch (_) {
      return null;
    }
  }

  /// `ready` or `collected`. False when it did not move, which includes the
  /// till next door having got there first.
  Future<bool> move(int id, String action) async {
    if (!canAsk) return false;
    try {
      final res = await _client
          .post(
            Uri.parse('$apiBase/till/express/orders/$id/$action'),
            headers: _headers,
          )
          .timeout(_quick);
      return res.statusCode == 200;
    } catch (_) {
      return false;
    }
  }

  /// Kitchen tickets waiting for a printer: order id to the stations it needs.
  Future<List<({int orderId, List<String> stations})>> printQueue() async {
    if (!canAsk) return const [];
    try {
      final res = await _client
          .get(
            Uri.parse('$apiBase/till/express/print-queue'),
            headers: _headers,
          )
          .timeout(_quick);
      if (res.statusCode != 200) return const [];
      final body = jsonDecode(res.body);
      if (body is! Map || body['jobs'] is! List) return const [];
      return [
        for (final job in body['jobs'] as List)
          if (job is Map && job['order_id'] is num)
            (
              orderId: (job['order_id'] as num).toInt(),
              stations: [
                for (final s in (job['stations'] as List?) ?? const []) '$s',
              ],
            ),
      ];
    } catch (_) {
      return const [];
    }
  }

  /// Ask to print [stations] of an order. Null when nothing was won.
  Future<ExpressPrintClaim?> claim(
    int orderId,
    Iterable<String> stations, {
    required String terminal,
  }) async {
    if (!canAsk) return null;
    try {
      final res = await _client
          .post(
            Uri.parse('$apiBase/till/express/print-queue/$orderId/claim'),
            headers: _headers,
            body: jsonEncode({
              'stations': stations.toList(),
              'terminal': terminal,
            }),
          )
          .timeout(_quick);
      if (res.statusCode != 200) return null;
      return ExpressPrintClaim.fromJson(jsonDecode(res.body));
    } catch (_) {
      return null;
    }
  }

  /// Say how the printing went. A failure goes back on offer at the server.
  Future<void> report(
    ExpressPrintClaim claim,
    Map<String, String?> errorsByStation,
  ) async {
    if (!canAsk) return;
    try {
      await _client
          .post(
            Uri.parse(
              '$apiBase/till/express/print-queue/${claim.orderId}/result',
            ),
            headers: _headers,
            body: jsonEncode({
              'claim_id': claim.claimId,
              'results': [
                for (final e in errorsByStation.entries)
                  {'station': e.key, 'ok': e.value == null, 'error': ?e.value},
              ],
            }),
          )
          .timeout(_quick);
    } catch (_) {
      // Unreported, the claim goes quiet and the server offers it again. The
      // worst case is a second ticket, which a kitchen survives.
    }
  }
}

final expressServiceProvider = Provider<ExpressService>(
  (ref) => ExpressService(
    apiBase: ref.watch(apiBaseProvider),
    terminalToken: ref.watch(sessionProvider).terminalToken,
  ),
);

/// The kiosk orders a till should know about, kept current.
///
/// Refreshed on `express.order` and `express.changed` off the socket and on a
/// thirty-second poll. A failed read keeps the last answer on screen.
class ExpressOrdersController extends AsyncNotifier<ExpressFeed> {
  Timer? _poll;
  StreamSubscription<SyncEvent>? _events;

  @override
  Future<ExpressFeed> build() async {
    _events?.cancel();
    _events = ref.watch(syncServiceProvider).events.listen((event) {
      if (event.type == 'express.order' || event.type == 'express.changed') {
        unawaited(refresh());
      }
    });

    _poll?.cancel();
    _poll = Timer.periodic(
      const Duration(seconds: 30),
      (_) => unawaited(refresh()),
    );

    ref.onDispose(() {
      _poll?.cancel();
      unawaited(_events?.cancel());
    });

    return await ref.read(expressServiceProvider).orders() ?? ExpressFeed.none;
  }

  Future<void> refresh() async {
    final fresh = await ref.read(expressServiceProvider).orders();
    if (fresh == null) return;
    state = AsyncData(fresh);
  }

  /// Ready, or Collected. Refreshed afterwards either way, so a card that
  /// another till moved first disappears rather than arguing.
  Future<bool> move(int id, String action) async {
    final ok = await ref.read(expressServiceProvider).move(id, action);
    await refresh();
    return ok;
  }
}

final expressOrdersProvider =
    AsyncNotifierProvider<ExpressOrdersController, ExpressFeed>(
      ExpressOrdersController.new,
    );

/// The stations this till prints kiosk tickets for: the ones it has a printer
/// at AND the venue sends to paper. The server only queues Printer and Both
/// stations, but a till must not claim a station it would then send nowhere.
Set<String> expressPrintStations(
  PrinterSettings printers,
  TillSettings settings,
) => {
  for (final station in printers.stations.keys)
    if (settings.deliveryFor(station).toPrinter) station,
};

/// Prints the kitchen's copy of kiosk orders, on this till's printers.
///
/// Runs on `express.print` from the socket and on a one-minute poll, one run at
/// a time. Nothing is claimed by a till with no kitchen printer, so a counter
/// till beside a kitchen till leaves every ticket to the one that can print it.
class ExpressKitchenPrinter {
  ExpressKitchenPrinter(this.ref);

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
      debugPrint('Kiosk tickets: $e');
    } finally {
      _running = false;
    }
  }

  Future<void> _once() async {
    final service = ref.read(expressServiceProvider);
    if (!service.canAsk) return;

    final printers = await ref.read(printerSettingsProvider.future);
    final settings = ref.read(tillSettingsProvider);
    final mine = expressPrintStations(printers, settings);
    if (mine.isEmpty) return;

    for (final job in await service.printQueue()) {
      final wanted = job.stations.where(mine.contains).toList();
      if (wanted.isEmpty) continue;
      final claim = await service.claim(
        job.orderId,
        wanted,
        terminal: ref.read(terminalNameProvider),
      );
      if (claim == null) continue;
      await service.report(claim, await printClaim(claim, printers, settings));
    }
  }

  /// Print each won station. Station key to the printer's error, or null.
  Future<Map<String, String?>> printClaim(
    ExpressPrintClaim claim,
    PrinterSettings printers,
    TillSettings settings,
  ) async {
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
          staffName: claim.kiosk,
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

/// Keeps the kiosk ticket printer listening for as long as the shell is up.
final expressKitchenPrinterProvider = Provider<ExpressKitchenPrinter>((ref) {
  final printer = ExpressKitchenPrinter(ref);
  final events = ref.watch(syncServiceProvider).events.listen((event) {
    if (event.type == 'express.print') unawaited(printer.run());
  });
  final poll = Timer.periodic(
    const Duration(minutes: 1),
    (_) => unawaited(printer.run()),
  );
  // Once at start, for anything queued while this till was off.
  unawaited(Future<void>.delayed(Duration.zero, printer.run));
  ref.onDispose(() {
    poll.cancel();
    unawaited(events.cancel());
  });
  return printer;
});
