/// Orders customers have sent from their own phones.
///
/// WHAT THIS IS AND IS NOT
///
/// A dine-in order is a *request*, not a sale. It exists in its own tables on
/// the server (`dinein_orders`, see `vesopa_server/schema/schema_menu_dinein.sql`)
/// and it stays there until a clerk accepts it. Only then does it become a bill
/// on this till, print in the kitchen and count towards the day.
///
/// That separation is the whole safety of the feature. Writing customer taps
/// straight into the sales tables would put unaccepted, mistaken and duplicate
/// orders into the takings, and no amount of status column makes that safe.
///
/// HOW IT ARRIVES
///
/// Two ways, deliberately:
///
///   * **The socket.** The server broadcasts `dinein.order` to the venue's
///     terminals the moment one is placed, so the notification appears while
///     the customer is still looking at their phone.
///   * **A slow poll.** Every thirty seconds regardless. A till that was
///     offline when the push went out heard nothing, and a customer sitting at
///     a table waiting for food that never arrives is the failure this feature
///     would be remembered for. The socket makes it fast; the poll makes it
///     certain.
library;

import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

import '../main.dart';
import 'sync_service.dart';

/// One line of a customer's order.
@immutable
class DineInLine {
  const DineInLine({
    required this.pluId,
    required this.name,
    required this.qty,
    required this.unitPriceMinor,
    this.id = 0,
    this.note,
    this.parentLineId,
    this.isModifier = false,
    this.unavailableAction = 'remove',
    this.allergens = const [],
    this.allergensDeclared = false,
  });

  /// The order line's own id, which is what an add-on names as its parent.
  final int id;

  final int pluId;
  final String name;
  final int qty;
  final int unitPriceMinor;

  /// "No onions", "well done". Goes on the kitchen ticket.
  ///
  /// Per DISH, not per order. The customer menu asks for it on the product
  /// sheet, which is the only place a note can be attached to the one thing it
  /// is about — an order-level note cannot be split across two kitchen
  /// sections.
  final String? note;

  /// The line this one is an answer to, when it is an add-on chosen on the
  /// phone. The same shape the till's own modifiers use, so the check, the
  /// receipt and the kitchen ticket all indent it without being told to.
  final int? parentLineId;
  final bool isModifier;

  /// What the customer asked for if this dish turns out to be off: `remove`
  /// (the default, and what happens anyway), `call` or `refund`. Shown on the
  /// card so a clerk does not have to ring anybody to find out.
  final String unavailableAction;

  /// Allergen codes, as the catalogue reads now. Turned into words by the
  /// server's own list so the till, the menu, the kitchen board and the
  /// customer display cannot spell them four ways.
  final List<String> allergens;

  /// Whether anybody has answered the question. An unanswered dish and a dish
  /// containing none of the fourteen both arrive as an empty list.
  final bool allergensDeclared;

  int get totalMinor => unitPriceMinor * qty;

  static DineInLine fromJson(Map<String, Object?> raw) => DineInLine(
    id: _int(raw['id']),
    pluId: _int(raw['plu_id']),
    name: _str(raw['name']),
    qty: _int(raw['qty'], 1),
    unitPriceMinor: _int(raw['unit_price_minor']),
    note: _nullableStr(raw['note']),
    parentLineId: raw['parent_line_id'] is num
        ? (raw['parent_line_id']! as num).toInt()
        : null,
    isModifier: raw['is_modifier'] == 1 || raw['is_modifier'] == true,
    unavailableAction: _nullableStr(raw['unavailable_action']) ?? 'remove',
    allergens: [for (final a in (raw['allergens'] as List?) ?? const []) '$a'],
    allergensDeclared:
        raw['allergens_declared'] == true || raw['allergens_declared'] == 1,
  );
}

/// One order, as the till sees it.
@immutable
class DineInOrder {
  const DineInOrder({
    required this.id,
    required this.publicId,
    required this.tableLabel,
    required this.status,
    required this.totalMinor,
    required this.placedAt,
    required this.lines,
    this.customerName,
    this.customerPhone,
    this.note,
    this.tableNumber,
  });

  final int id;
  final String publicId;

  /// What the table was called when the order was placed. A string rather than
  /// a number because a venue may call its tables "Booth 3" or "The snug".
  final String tableLabel;

  /// placed | accepted | ready | served | rejected | cancelled.
  final String status;

  final int totalMinor;
  final DateTime placedAt;
  final List<DineInLine> lines;

  final String? customerName;
  final String? customerPhone;
  final String? note;

  /// The till's own table number, when the server could give one. What the bill
  /// is placed against; null means the table has gone since the order, and the
  /// clerk is asked where to put it.
  final int? tableNumber;

  /// Waiting for somebody to press Accept.
  bool get isWaiting => status == 'placed';

  /// The dishes, without the add-ons hanging off them. What "3 items" means to
  /// somebody reading the card: three plates, not three rows.
  Iterable<DineInLine> get dishes => lines.where((l) => !l.isModifier);

  int get itemCount => dishes.fold(0, (sum, line) => sum + line.qty);

  /// The add-ons chosen for [line].
  List<DineInLine> addOnsFor(DineInLine line) => [
    for (final l in lines)
      if (l.parentLineId != null && l.parentLineId == line.id) l,
  ];

  /// Every allergen anywhere on this order, once, in a stable order.
  List<String> get allAllergens {
    final seen = <String>{for (final l in lines) ...l.allergens};
    return seen.toList()..sort();
  }

  static DineInOrder? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final map = raw.cast<String, Object?>();
    final id = _int(map['id']);
    if (id == 0) return null;

    return DineInOrder(
      id: id,
      publicId: _str(map['public_id']),
      tableLabel: _str(map['table_label']),
      status: _str(map['status'], 'placed'),
      totalMinor: _int(map['total_minor']),
      // An unparseable time is treated as now rather than as 1970: this drives
      // "how long has this been waiting", and an order that claims to have been
      // waiting since 1970 would sit at the top of the list for ever.
      placedAt: DateTime.tryParse(_str(map['placed_at'])) ?? DateTime.now(),
      lines: [
        for (final line in (map['lines'] as List?) ?? const [])
          if (line is Map) DineInLine.fromJson(line.cast<String, Object?>()),
      ],
      customerName: _nullableStr(map['customer_name']),
      customerPhone: _nullableStr(map['customer_phone']),
      note: _nullableStr(map['note']),
      tableNumber: map['table_number'] is num
          ? (map['table_number']! as num).toInt()
          : null,
    );
  }
}

String _str(Object? value, [String fallback = '']) =>
    value is String ? value : fallback;

String? _nullableStr(Object? value) {
  final text = value is String ? value.trim() : '';
  return text.isEmpty ? null : text;
}

int _int(Object? value, [int fallback = 0]) =>
    value is num ? value.toInt() : fallback;

/// Talking to the server about dine-in orders.
///
/// Nothing here throws. A till whose network has gone must carry on selling,
/// and the notification simply says nothing rather than putting an error in
/// front of a clerk mid-service.
class DineInService {
  DineInService({
    required this.apiBase,
    required this.terminalToken,
    http.Client? client,
  }) : _client = client ?? http.Client();

  final String apiBase;

  /// Null on a terminal that has never been commissioned. Every call answers
  /// "nothing" rather than failing.
  final String? terminalToken;

  final http.Client _client;

  static const _quick = Duration(seconds: 8);

  bool get canAsk => terminalToken != null;

  Map<String, String> get _headers => {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer $terminalToken',
  };

  /// What is waiting, and what is in the kitchen.
  ///
  /// Returns null when the till could not ask at all — offline, or not
  /// commissioned. Null and "nothing waiting" are deliberately different: the
  /// first means the badge should say nothing, and the second means it should
  /// say nothing *and be right*.
  Future<List<DineInOrder>?> waiting() async {
    if (!canAsk) return null;
    try {
      final res = await _client
          .get(
            Uri.parse('$apiBase/till/dinein/orders?status=placed,accepted,ready'),
            headers: _headers,
          )
          .timeout(_quick);
      if (res.statusCode != 200) return null;

      final decoded = jsonDecode(res.body);
      if (decoded is! List) return null;
      return [
        for (final row in decoded) ?DineInOrder.fromJson(row),
      ];
    } catch (_) {
      return null;
    }
  }

  /// Move an order along. [saleId] attaches the bill this became.
  ///
  /// False means it did not move, which is a real answer and not only an error:
  /// the server refuses a transition from the wrong state, so a clerk pressing
  /// Accept on an order the till beside them has already taken gets a plain no
  /// rather than a second kitchen ticket.
  Future<bool> move(int id, String action, {String? saleId, String? note}) async {
    if (!canAsk) return false;
    try {
      final res = await _client
          .post(
            Uri.parse('$apiBase/till/dinein/orders/$id/$action'),
            headers: _headers,
            body: jsonEncode({
              'order_id': ?saleId,
              'note': ?note,
            }),
          )
          .timeout(_quick);
      return res.statusCode == 200;
    } catch (_) {
      return false;
    }
  }
}

/// The dine-in service for this terminal.
final dineInServiceProvider = Provider<DineInService>(
  (ref) => DineInService(
    apiBase: ref.watch(apiBaseProvider),
    terminalToken: ref.watch(sessionProvider).terminalToken,
  ),
);

/// What is waiting for the till right now.
///
/// Refreshed on two signals, and it needs both:
///
///   * `dinein.order` and `dinein.changed` off the socket, which is what makes
///     the notification appear while the customer is still holding their phone.
///   * A thirty-second timer, which is what makes it *arrive at all* on a till
///     that was offline when the push went out. A customer sitting at a table
///     waiting for food nobody knew about is the failure this feature would be
///     remembered for.
///
/// Never an error state. A till whose network has gone must carry on selling,
/// so a failed read leaves the previous answer on screen rather than putting a
/// red panel in front of a clerk mid-service — see [DineInService.waiting],
/// which answers null rather than throwing.
class DineInOrdersController extends AsyncNotifier<List<DineInOrder>> {
  Timer? _poll;
  StreamSubscription<SyncEvent>? _events;

  @override
  Future<List<DineInOrder>> build() async {
    _events?.cancel();
    _events = ref.watch(syncServiceProvider).events.listen((event) {
      if (event.type == 'dinein.order' || event.type == 'dinein.changed') {
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

    return await ref.read(dineInServiceProvider).waiting() ?? const [];
  }

  /// Ask again, keeping what is on screen if the answer does not come.
  Future<void> refresh() async {
    final fresh = await ref.read(dineInServiceProvider).waiting();
    if (fresh == null) return;
    state = AsyncData(fresh);
  }

  /// Move an order along and update the list without waiting for a round trip.
  ///
  /// Refreshed straight afterwards anyway: the optimistic step is what makes
  /// the button feel like it worked, and the refresh is what makes the screen
  /// right when the terminal beside this one got there first.
  Future<bool> move(int id, String action, {String? saleId, String? note}) async {
    final ok = await ref
        .read(dineInServiceProvider)
        .move(id, action, saleId: saleId, note: note);
    await refresh();
    return ok;
  }
}

final dineInOrdersProvider =
    AsyncNotifierProvider<DineInOrdersController, List<DineInOrder>>(
      DineInOrdersController.new,
    );

/// How many orders are waiting for somebody to press Accept.
///
/// Its own provider so the badge on the bar rebuilds when the *count* changes
/// rather than on every refresh of the list — a bar that repaints every thirty
/// seconds on a till nobody has touched is a bar that flickers.
final dineInWaitingCountProvider = Provider<int>((ref) {
  final orders = ref.watch(dineInOrdersProvider).value ?? const <DineInOrder>[];
  return orders.where((o) => o.isWaiting).length;
});

/// Allergen codes to the words a person reads.
///
/// From the server rather than a list in this app, so the till, the QR menu,
/// the kitchen board and the customer display cannot drift into four spellings
/// of the same allergen. Unauthenticated: it is the statutory fourteen, and a
/// kitchen screen and a menu page both need it before anybody has signed in.
///
/// Cached on the machine, because the two surfaces that need it are the two
/// that must survive a dropped line: a customer display showing what is in the
/// food, and a QR order card a clerk is reading at the counter. The list is
/// fixed by statute and does not drift, so a copy from last week is a copy
/// from today.
const _allergenCacheKey = 'till.allergen_labels';

final allergenLabelsProvider = FutureProvider<Map<String, String>>((ref) async {
  Map<String, String> parse(Object? decoded) {
    if (decoded is! List) return const {};
    return {
      for (final row in decoded)
        if (row is Map && row['code'] != null)
          '${row['code']}': '${row['label']}',
    };
  }

  SharedPreferences? prefs;
  try {
    prefs = await SharedPreferences.getInstance();
  } catch (_) {
    // A terminal whose preferences will not open still sells.
  }

  try {
    final res = await http
        .get(Uri.parse('${ref.read(apiBaseProvider)}/api/allergens'))
        .timeout(const Duration(seconds: 8));
    if (res.statusCode == 200) {
      final labels = parse(jsonDecode(res.body));
      if (labels.isNotEmpty) {
        await prefs?.setString(_allergenCacheKey, res.body);
        return labels;
      }
    }
  } catch (_) {
    // Offline. Fall through to whatever was last read.
  }

  final cached = prefs?.getString(_allergenCacheKey);
  if (cached == null) return const {};
  try {
    return parse(jsonDecode(cached));
  } catch (_) {
    return const {};
  }
});
