/// Sending a fired bill to the kitchen *screens*, as opposed to its printers.
///
/// The other half of [KitchenPrinting]. Which stations come here rather than
/// out on paper is a back-office setting — see [KitchenDelivery] — and nothing
/// about the routing itself changes: the same six stations, set on the same
/// products, in the same place.
///
/// One ticket per fire, not one per station. A printer needs a ticket each
/// because paper cannot be filtered; a screen can, so everything that fired
/// travels once and each screen draws the lines for the stations it watches.
/// That is what makes one order one card on a small kitchen's single screen,
/// and the same order appear on both the grill and the fryer screens — carrying
/// only their own lines — in a large one.
library;

import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

import 'local/database.dart';
import 'modifier_layout.dart';


/// One item on a kitchen ticket.
class KitchenTicketLine {
  const KitchenTicketLine({
    this.isModifier = false,
    required this.id,
    required this.quantity,
    required this.name,
    required this.stations,
    this.note,
  });

  final String id;
  final double quantity;
  final String name;

  /// The modifier, shown in red on the board: "no tomato", "extra sausage".
  /// The one thing on the card that is not the recipe, and the reason a ticket
  /// gets read at all.
  final String? note;

  /// The screen-bound stations this line goes to. Only those: a line that also
  /// goes to a printer carries the printer's station in its routing, but there
  /// is no screen watching it and listing it here would leave the ticket open
  /// forever, waiting to be bumped by nobody.
  final Set<String> stations;

  /// Whether this line is an answer about the line above it — "Rare", "Dash
  /// Coke" — rather than a dish of its own. Drawn under its item on the board,
  /// the way a note already is.
  final bool isModifier;

  Map<String, dynamic> toJson() => {
    'id': id,
    'quantity': quantity,
    'name': name,
    if (note != null && note!.isNotEmpty) 'note': note,
    if (isModifier) 'is_modifier': true,
    'stations': stations.join(','),
  };

  factory KitchenTicketLine.fromJson(Map<String, dynamic> j) =>
      KitchenTicketLine(
        id: j['id'] as String,
        quantity: (j['quantity'] as num).toDouble(),
        name: j['name'] as String,
        note: j['note'] as String?,
        isModifier: j['is_modifier'] == true || j['is_modifier'] == 1,
        stations: {
          for (final s in '${j['stations'] ?? ''}'.split(','))
            if (s.trim().isNotEmpty) s.trim(),
        },
      );
}

/// A bill as the kitchen sees it.
class KitchenTicket {
  const KitchenTicket({
    required this.id,
    required this.office,
    required this.orderId,
    required this.kind,
    required this.placedAt,
    required this.lines,
    this.ticketNo,
    this.tableNumber,
    this.roomName,
    this.staffName,
    this.covers,
    this.note,
  });

  /// Minted here, and the server's idempotency key — exactly as an order id is.
  /// A till retrying after a dropped connection re-sends the same id and the
  /// kitchen does not get the order twice, which matters more here than it does
  /// for a sale: a duplicated sale is a figure to correct, a duplicated ticket
  /// is food that gets cooked.
  final String id;

  final String office;
  final String orderId;

  /// What a chef reads out and a clerk can find. See [shortRef].
  final String? ticketNo;

  /// sale | table | reprint.
  final String kind;

  /// When the till fired it, not when it reached the server. The two differ by
  /// the length of an outage, and the board's elapsed clock counts from this
  /// one — a ticket held up by the network is *late*, and hiding that is the
  /// one thing a kitchen board must not do.
  final DateTime placedAt;

  final int? tableNumber;
  final String? roomName;
  final String? staffName;
  final int? covers;
  final String? note;

  final List<KitchenTicketLine> lines;

  Map<String, dynamic> toJson() => {
    'id': id,
    'office': office,
    'order_id': orderId,
    if (ticketNo != null) 'ticket_no': ticketNo,
    'kind': kind,
    'placed_at': placedAt.toUtc().toIso8601String(),
    if (tableNumber != null) 'table_number': tableNumber,
    if (roomName != null) 'room_name': roomName,
    if (staffName != null) 'staff_name': staffName,
    if (covers != null) 'covers': covers,
    if (note != null && note!.isNotEmpty) 'note': note,
    'lines': lines.map((l) => l.toJson()).toList(),
  };

  factory KitchenTicket.fromJson(Map<String, dynamic> j) => KitchenTicket(
    id: j['id'] as String,
    office: j['office'] as String,
    orderId: j['order_id'] as String,
    ticketNo: j['ticket_no'] as String?,
    kind: j['kind'] as String? ?? 'sale',
    placedAt: DateTime.parse(j['placed_at'] as String).toLocal(),
    tableNumber: (j['table_number'] as num?)?.toInt(),
    roomName: j['room_name'] as String?,
    staffName: j['staff_name'] as String?,
    covers: (j['covers'] as num?)?.toInt(),
    note: j['note'] as String?,
    lines: ((j['lines'] as List?) ?? const [])
        .cast<Map<String, dynamic>>()
        .map(KitchenTicketLine.fromJson)
        .toList(),
  );

  /// A short, sayable reference for an order, from its UUID.
  ///
  /// The till has no running order number and inventing one would need a
  /// counter that survives a reinstall, agrees across four terminals, and does
  /// not restart at 1 every morning in the middle of a service. The last six
  /// hex characters of the id do the actual job — "is this the ticket you
  /// mean?" across a pass, and something a clerk can search for — without any
  /// of that machinery.
  static String shortRef(String orderId) {
    final clean = orderId.replaceAll('-', '');
    if (clean.length <= 6) return clean.toUpperCase();
    return clean.substring(clean.length - 6).toUpperCase();
  }
}

/// What one send did.
class KitchenScreenResult {
  const KitchenScreenResult({
    required this.stations,
    this.delivered = false,
    this.queued = false,
    this.error,
  });

  /// The screen-bound stations this ticket was for.
  final Set<String> stations;

  /// It reached the server, and so the screens.
  final bool delivered;

  /// It did not, and is being kept to try again. Not a failure the clerk needs
  /// to act on — see [KitchenScreenSender.flush].
  final bool queued;

  final String? error;

  /// One line for the till's status chip.
  String get summary {
    if (delivered) return 'Sent to the kitchen screens.';
    if (queued) {
      return 'Kitchen screens are unreachable — the ticket will be sent when '
          'the link comes back.';
    }
    return 'Could not reach the kitchen screens: ${error ?? 'unknown error'}';
  }
}

/// Posts tickets to the back office, and keeps the ones that did not land.
///
/// **The queue is not the outbox, and deliberately.** A sale that fails to reach
/// the server waits in the till's Drift outbox indefinitely, because unrecorded
/// money is a problem that stays a problem. A kitchen ticket is the opposite: a
/// ticket delivered forty minutes late is worse than one never delivered,
/// because somebody will cook it, and the customer it was for left before it
/// arrived.
///
/// So this queue is small, lives in preferences, and throws away anything older
/// than [ttl]. It survives a restart and a flaky minute of network. It does not
/// survive a service, and it is not supposed to.
class KitchenScreenSender {
  KitchenScreenSender({
    required this.apiBase,
    required this.office,
    http.Client? client,
  }) : _client = client ?? http.Client();

  final String apiBase;
  final String office;
  final http.Client _client;

  static const _queueKey = 'vesopa_kitchen_queue';

  /// How long a ticket is worth retrying for. Ten minutes is roughly how long a
  /// kitchen will still recognise an order as one it has not started.
  static const ttl = Duration(minutes: 10);

  /// Bounded so a terminal that has been off the network for an hour cannot
  /// fill its preferences with food nobody is going to cook.
  static const _maxQueued = 60;

  /// Send [ticket], queueing it if the server cannot be reached.
  ///
  /// Never throws. By the time this runs the sale is recorded or the table is
  /// saved, and a kitchen screen that is switched off must not be able to undo
  /// either.
  Future<KitchenScreenResult> send(KitchenTicket ticket) async {
    final stations = {for (final l in ticket.lines) ...l.stations};
    if (ticket.lines.isEmpty || stations.isEmpty) {
      return KitchenScreenResult(stations: const {});
    }

    try {
      final ok = await _post(ticket);
      if (ok) {
        // A ticket got through, so the link is up: anything waiting can go now
        // rather than at the next fire, which on a quiet table service could be
        // an hour away.
        // Errors are swallowed rather than left to reach the zone: this is
        // best-effort catch-up and an unhandled one takes the isolate down on
        // some platforms.
        unawaited(flush().catchError((Object _) {}));
        return KitchenScreenResult(stations: stations, delivered: true);
      }
      return KitchenScreenResult(
        stations: stations,
        error: 'the back office rejected it',
      );
    } catch (e) {
      await _queue(ticket);
      return KitchenScreenResult(
        stations: stations,
        queued: true,
        error: '$e',
      );
    }
  }

  /// Try everything that is waiting, dropping whatever has gone stale.
  ///
  /// Called after a successful send and from the sync service when the link
  /// comes back. Silent: this runs in the background and there is nobody to
  /// tell.
  Future<void> flush() async {
    final prefs = await SharedPreferences.getInstance();
    final queued = _read(prefs);
    if (queued.isEmpty) return;

    final now = DateTime.now();
    final remaining = <_QueuedTicket>[];

    for (var i = 0; i < queued.length; i++) {
      final entry = queued[i];
      // Too old to be worth cooking. Dropped rather than sent.
      if (now.difference(entry.ticket.placedAt) > ttl) continue;
      try {
        // A rejection is final — the server understood us and said no — so the
        // ticket is dropped rather than retried forever.
        if (!await _post(entry.ticket)) continue;
      } catch (_) {
        // Still unreachable. Keep this one and everything after it, and stop:
        // the rest will fail the same way, and hammering an unreachable server
        // from every till in the venue is how a back office that is merely slow
        // becomes a back office that is down.
        remaining.addAll(queued.skip(i));
        break;
      }
    }

    await _write(prefs, remaining);
  }

  /// How many tickets are waiting. Shown on the till's kitchen settings card so
  /// a manager can see the backlog rather than guess at it.
  Future<int> pending() async {
    final prefs = await SharedPreferences.getInstance();
    return _read(prefs).where((e) {
      return DateTime.now().difference(e.ticket.placedAt) <= ttl;
    }).length;
  }

  Future<bool> _post(KitchenTicket ticket) async {
    final res = await _client
        .post(
          Uri.parse('$apiBase/till/kitchen/tickets'),
          headers: const {'Content-Type': 'application/json'},
          body: jsonEncode(ticket.toJson()),
        )
        // Short, and shorter than the sale push. Nobody is waiting on this and
        // the ticket is queued on failure, so a slow server should give the
        // clerk their screen back rather than hold it.
        .timeout(const Duration(seconds: 5));

    // 2xx of any flavour. 200 is "already had it" — which is a success, and the
    // whole point of the ticket id being the idempotency key.
    return res.statusCode >= 200 && res.statusCode < 300;
  }

  Future<void> _queue(KitchenTicket ticket) async {
    final prefs = await SharedPreferences.getInstance();
    final queued = _read(prefs)
      ..removeWhere((e) => e.ticket.id == ticket.id)
      ..add(_QueuedTicket(ticket));

    // Oldest first out, because the oldest is the one closest to being useless.
    while (queued.length > _maxQueued) {
      queued.removeAt(0);
    }
    await _write(prefs, queued);
  }

  List<_QueuedTicket> _read(SharedPreferences prefs) {
    try {
      final raw = prefs.getString(_queueKey);
      if (raw == null || raw.isEmpty) return [];
      return (jsonDecode(raw) as List)
          .cast<Map<String, dynamic>>()
          .map((j) => _QueuedTicket(KitchenTicket.fromJson(j)))
          .toList();
    } catch (_) {
      // A corrupt queue must not stop the till firing the *next* ticket, and
      // there is nothing in it worth recovering by hand.
      return [];
    }
  }

  Future<void> _write(SharedPreferences prefs, List<_QueuedTicket> queue) async {
    if (queue.isEmpty) {
      await prefs.remove(_queueKey);
      return;
    }
    await prefs.setString(
      _queueKey,
      jsonEncode([for (final e in queue) e.ticket.toJson()]),
    );
  }
}

class _QueuedTicket {
  const _QueuedTicket(this.ticket);
  final KitchenTicket ticket;
}

/// Compose the ticket for one fire.
///
/// Split out of the sender so the shape of a ticket is decided in one place and
/// can be tested without a server: given an order, its lines, the routing and
/// which stations are on screens, this is the ticket that goes.
KitchenTicket buildKitchenTicket({
  required String id,
  required String office,
  required Order order,
  required List<OrderLine> lines,
  required Map<String, Set<String>> routesByLine,
  required Set<String> screenStations,
  required String kind,
  String? roomName,
  String? staffName,
}) {
  final ticketLines = <KitchenTicketLine>[];

  // In reading order, so `seq` on the server puts each answer straight after
  // the dish it belongs to. A kitchen reads a ticket top to bottom.
  for (final line in orderWithModifiers(
    lines,
    idOf: (l) => l.id,
    parentOf: (l) => l.parentLineId,
  )) {
    final routed = routesByLine[line.id] ?? const <String>{};
    final onScreens = routed.intersection(screenStations);
    // Nothing on a screen watches this item. It still prints, if it is routed
    // to a printer — that is the other half of the fire — but it does not
    // belong on this ticket.
    if (onScreens.isEmpty) continue;

    ticketLines.add(
      KitchenTicketLine(
        id: line.id,
        quantity: line.quantity,
        name: line.name,
        note: line.notes,
        isModifier: line.parentLineId != null,
        stations: onScreens,
      ),
    );
  }

  return KitchenTicket(
    id: id,
    office: office,
    orderId: order.id,
    ticketNo: KitchenTicket.shortRef(order.id),
    kind: kind,
    // The moment the clerk pressed the key, not the moment the POST is made.
    placedAt: DateTime.now(),
    tableNumber: order.tableNumber,
    roomName: roomName,
    staffName: staffName ?? order.staffName,
    covers: order.covers,
    note: order.notes,
    lines: ticketLines,
  );
}
