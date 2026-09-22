/// One venue, one set of open bills, however many terminals.
///
/// Table 6 saved at the bar is recalled at the station by the door. That is the
/// whole feature, and this file is the part of it that runs on a till.
///
/// ---------------------------------------------------------------------------
/// How it works, and why it is a mirror rather than a second list
/// ---------------------------------------------------------------------------
/// Every other terminal's open bills are written into *this* terminal's own
/// `orders` table, marked with `heldBy` — the name of the machine that is
/// actually holding them. Nothing downstream had to be taught about a second
/// source of bills: the table plan, the table picker and the open-bills strip
/// all read the same stream they always read, and the room they draw is now the
/// whole room.
///
/// The alternative — a parallel list of remote bills, merged in three places —
/// would have meant three chances for a table to appear on the plan and not in
/// the picker, which is exactly the class of fault a clerk cannot work around.
///
/// `heldBy` is also what keeps it honest:
///
///   * **The push only sends bills where it is null.** A mirrored bill is never
///     sent back as though this terminal had written it, so two tills cannot
///     bounce one bill between them for ever.
///   * **A bill somebody else is holding cannot be rung up or settled here**
///     until it has been claimed, at which point the server moves it and this
///     goes null. Without that, two clerks could take payment for one table.
///
/// ---------------------------------------------------------------------------
/// What happens when the network goes
/// ---------------------------------------------------------------------------
/// Nothing that matters. This service is not on the path that takes money: a
/// cut-off terminal rings up, prints and settles exactly as it did before, on
/// the bills it is holding itself. What it loses is sight of the others', and
/// [BillSyncStatus.stale] is how the tables page says so rather than showing an
/// empty room and letting a clerk conclude the party has left.
library;

import 'dart:async';
import 'dart:convert';

import 'package:drift/drift.dart';

import 'local/database.dart';
import 'terminal_service.dart';

/// Whether the plan on screen can be trusted.
class BillSyncStatus {
  const BillSyncStatus({this.sharing = false, this.stale = false});

  /// True once this terminal has successfully read the venue's feed at least
  /// once. False on a till that is not commissioned for it, and on one that has
  /// never got through — in both cases the plan is this terminal's own bills
  /// and nothing else, which is exactly what it was before this existed.
  final bool sharing;

  /// True when the last poll failed. The bills on screen are the last ones
  /// heard about and may since have been settled elsewhere.
  final bool stale;

  static const idle = BillSyncStatus();
}

/// Pushes this terminal's open bills to the venue and mirrors everyone else's.
class BillSync {
  BillSync(this._db, this._terminals);

  final AppDatabase _db;
  final TerminalService _terminals;

  /// The last change number this terminal has seen. Deliberately not persisted:
  /// a till that has been off is better served by one full read at startup than
  /// by trusting a cursor from before whatever happened while it was away.
  int _cursor = 0;

  Timer? _poll;
  StreamSubscription<void>? _watch;
  bool _disposed = false;
  bool _busy = false;

  /// What was last sent for each bill, so an unchanged bill is not re-posted.
  ///
  /// A stream over a joined query fires on every line insert, and a busy
  /// counter is a great many inserts. Without this the terminal would post
  /// every open bill in the venue on every keystroke.
  final _sent = <String, String>{};

  final _status = StreamController<BillSyncStatus>.broadcast();
  Stream<BillSyncStatus> get status => _status.stream;
  var _current = BillSyncStatus.idle;
  BillSyncStatus get currentStatus => _current;

  void _emit(BillSyncStatus next) {
    _current = next;
    if (!_status.isClosed) _status.add(next);
  }

  /// How often to ask the venue what has changed.
  ///
  /// The socket is the real mechanism — [pull] is called the moment the server
  /// pushes `open-bills.updated` — and this is the backstop for a terminal
  /// whose socket has quietly died. Ten seconds: long enough to be nearly free,
  /// short enough that a table saved at the bar is on the door terminal before
  /// anybody has walked there.
  static const _interval = Duration(seconds: 10);

  void start() {
    if (!_terminals.canShare) return;

    // Anything already open when the app starts. A terminal that was killed
    // mid-service comes back holding bills the venue has not heard about since.
    unawaited(pushAll());
    unawaited(pull());

    _poll = Timer.periodic(_interval, (_) {
      unawaited(pull());
      unawaited(pushAll());
    });

    // The local side. Watching the orders table alone would miss a line being
    // added to a bill that is already there, which is most of what changes
    // about a bill, so this watches the join.
    _watch = _liveQuery().watch().listen((_) => unawaited(pushAll()));
  }

  Future<void> dispose() async {
    _disposed = true;
    _poll?.cancel();
    await _watch?.cancel();
    await _status.close();
  }

  /// This terminal's own live bills: open or parked, and not a mirror.
  JoinedSelectStatement<HasResultSet, dynamic> _liveQuery() =>
      _db.select(_db.orders).join([
        innerJoin(
          _db.orderLines,
          _db.orderLines.orderId.equalsExp(_db.orders.id),
        ),
      ])..where(
        _db.orders.status.isIn(['open', 'parked']) &
            _db.orders.heldBy.isNull(),
      );

  // ---------------------------------------------------------------------------
  // Out
  // ---------------------------------------------------------------------------

  /// Send anything of ours that has changed, and retire anything that has gone.
  Future<void> pushAll() async {
    if (_disposed || !_terminals.canShare || _busy) return;
    _busy = true;
    try {
      final rows = await _liveQuery().get();
      final mine = <String, Order>{};
      for (final row in rows) {
        final order = row.readTable(_db.orders);
        mine.putIfAbsent(order.id, () => order);
      }

      for (final order in mine.values) {
        final payload = await _payloadFor(order);
        final signature = jsonEncode(payload);
        if (_sent[order.id] == signature) continue;
        final ok = await _terminals.pushBill(
          id: order.id,
          payload: payload,
          totalMinor: order.totalMinor,
          lineCount: (payload['lines'] as List).length,
          status: order.status == 'parked' ? 'parked' : 'open',
          tableNumber: order.tableNumber,
          roomId: order.roomId,
          covers: order.covers,
          staffId: order.staffId,
          clerkName: order.staffName,
        );
        // Only remembered on a success, so a push that failed is retried by the
        // next tick rather than being assumed delivered.
        if (ok) _sent[order.id] = signature;
      }

      // A bill we were holding and are not any more: settled, cancelled, or
      // merged into another. Told to the venue explicitly, because a change
      // feed that only ever reported live rows could not express a deletion —
      // and a settled table would sit on the other terminal's plan for ever.
      for (final id in _sent.keys.toList()) {
        if (mine.containsKey(id)) continue;
        if (await _terminals.retireBill(id)) _sent.remove(id);
      }
    } finally {
      _busy = false;
    }
  }

  /// A bill, as the terminal that picks it up will rebuild it.
  ///
  /// Deliberately the same shape as the sale posted to `/till/orders`, so there
  /// is one description of what a bill is rather than two that drift.
  Future<Map<String, dynamic>> _payloadFor(Order order) async {
    final lines = await (_db.select(_db.orderLines)
          ..where((l) => l.orderId.equals(order.id)))
        .get();
    return {
      'id': order.id,
      'status': order.status,
      'table_number': order.tableNumber,
      'room_id': order.roomId,
      'covers': order.covers,
      'clerk_pin': order.clerkPin,
      'staff_id': order.staffId,
      'staff_name': order.staffName,
      'customer_id': order.customerId,
      'customer_name': order.customerName,
      'notes': order.notes,
      'subtotal_minor': order.subtotalMinor,
      'manual_discount_minor': order.manualDiscountMinor,
      'discount_minor': order.discountMinor,
      'tax_minor': order.taxMinor,
      'total_minor': order.totalMinor,
      'lines': [
        for (final l in lines)
          {
            'id': l.id,
            'plu_id': l.pluId,
            'name': l.name,
            'quantity': l.quantity,
            'unit_price_minor': l.unitPriceMinor,
            'tax_percentage': l.taxPercentage,
            'notes': l.notes,
            'line_discount_minor': l.lineDiscountMinor,
            'added_by': l.addedBy,
            'added_at': l.addedAt?.toIso8601String(),
            'parent_line_id': l.parentLineId,
            // Whether the kitchen has already been given this line. Carried so
            // a bill recalled on another terminal does not re-fire a course
            // that is already being cooked -- which is the one mistake in this
            // feature a kitchen would never forgive.
            'kitchen_printed_at': l.kitchenPrintedAt?.toIso8601String(),
          },
      ],
    };
  }

  // ---------------------------------------------------------------------------
  // In
  // ---------------------------------------------------------------------------

  /// Ask the venue what has changed and mirror it locally.
  Future<void> pull() async {
    if (_disposed || !_terminals.canShare) return;
    final feed = await _terminals.pullBills(since: _cursor);
    if (feed == null) {
      _emit(BillSyncStatus(sharing: _current.sharing, stale: true));
      return;
    }

    for (final bill in feed.changed) {
      await _mirror(bill);
    }
    for (final id in feed.removed) {
      await _forget(id);
    }

    _cursor = feed.rev;
    _emit(const BillSyncStatus(sharing: true, stale: false));
  }

  /// Write one of the venue's bills into this terminal's own tables.
  Future<void> _mirror(RemoteBill bill) async {
    // Ours, coming back to us. Nothing to do -- and importantly nothing to
    // overwrite: the local copy is the one being edited, and the server's is
    // whatever we last managed to send it.
    if (bill.terminal == _terminals.terminalName) {
      // Unless it has been taken off us, in which case the local copy has to
      // learn that it is no longer ours to settle. Handled by the branch below
      // on the next poll, because `terminal` will have changed by then.
      await _clearHold(bill.id);
      return;
    }

    final payload = bill.payload;
    // A payload the server could not parse. The bill is still shown -- a table
    // that vanishes is worse than one that will not open -- but with nothing on
    // it, so pressing it says so rather than opening an empty check.
    if (payload == null) return;

    await _write(bill, heldBy: bill.terminal, over: false);
  }

  /// The write itself, shared by the feed and by a claim.
  ///
  /// [over] is what tells the two apart. The feed must never write over a bill
  /// this terminal is holding — we are the ones editing it and the server's
  /// copy is behind — whereas a claim has just been told by the server that the
  /// bill is ours, and the copy it handed back may be a round newer than the
  /// one on screen.
  Future<void> _write(
    RemoteBill bill, {
    required String? heldBy,
    required bool over,
  }) async {
    final payload = bill.payload;
    if (payload == null) return;

    await _db.transaction(() async {
      final existing = await (_db.select(_db.orders)
            ..where((o) => o.id.equals(bill.id)))
          .getSingleOrNull();
      if (!over && existing != null && existing.heldBy == null) return;

      final companion = OrdersCompanion(
        id: Value(bill.id),
        status: Value(bill.isParked ? 'parked' : 'open'),
        heldBy: Value(heldBy),
        tableNumber: Value(bill.tableNumber),
        roomId: Value(bill.roomId),
        covers: Value(bill.covers),
        staffId: Value(bill.staffId),
        staffName: Value(bill.clerkName),
        clerkPin: Value(payload['clerk_pin'] as String?),
        customerId: Value(payload['customer_id'] as String?),
        customerName: Value(payload['customer_name'] as String?),
        notes: Value(payload['notes'] as String?),
        subtotalMinor: Value(_int(payload['subtotal_minor'])),
        manualDiscountMinor: Value(_int(payload['manual_discount_minor'])),
        discountMinor: Value(_int(payload['discount_minor'])),
        taxMinor: Value(_int(payload['tax_minor'])),
        totalMinor: Value(bill.totalMinor),
      );
      await _db.into(_db.orders).insertOnConflictUpdate(companion);

      // Lines are replaced wholesale rather than merged. A merge would need to
      // work out what had been voided on the other terminal, and "the bill is
      // what the terminal holding it says it is" is both simpler and correct.
      await (_db.delete(_db.orderLines)
            ..where((l) => l.orderId.equals(bill.id)))
          .go();

      // Parents before children, so the foreign key on `parentLineId` is never
      // pointed at a row that has not been written yet.
      final lines = (payload['lines'] as List? ?? const [])
          .cast<Map<String, dynamic>>();
      for (final pass in [true, false]) {
        for (final l in lines) {
          if ((l['parent_line_id'] == null) != pass) continue;
          await _db.into(_db.orderLines).insert(
                OrderLinesCompanion.insert(
                  id: l['id'] as String,
                  orderId: bill.id,
                  pluId: _int(l['plu_id']),
                  name: (l['name'] as String?) ?? '',
                  quantity: Value((l['quantity'] as num?)?.toDouble() ?? 1),
                  unitPriceMinor: _int(l['unit_price_minor']),
                  taxPercentage:
                      Value((l['tax_percentage'] as num?)?.toDouble() ?? 0),
                  notes: Value(l['notes'] as String?),
                  lineDiscountMinor: Value(_int(l['line_discount_minor'])),
                  addedBy: Value(l['added_by'] as String?),
                  addedAt: Value(_time(l['added_at'])),
                  parentLineId: Value(l['parent_line_id'] as String?),
                  kitchenPrintedAt: Value(_time(l['kitchen_printed_at'])),
                ),
              );
        }
      }
    });
  }

  /// This bill has been settled, cancelled or merged away somewhere else.
  ///
  /// Only ever removes a mirror. A bill this terminal is holding is never
  /// deleted by the feed: the one that could produce that is a race between our
  /// own retire and our own push, and losing a live bill to it would be
  /// unrecoverable at a counter.
  Future<void> _forget(String id) async {
    await _db.transaction(() async {
      final existing =
          await (_db.select(_db.orders)..where((o) => o.id.equals(id)))
              .getSingleOrNull();
      if (existing == null || existing.heldBy == null) return;
      await (_db.delete(_db.orderLines)..where((l) => l.orderId.equals(id)))
          .go();
      await (_db.delete(_db.orders)..where((o) => o.id.equals(id))).go();
    });
  }

  /// Mark a mirrored bill as this terminal's, after the server has moved it.
  Future<void> _clearHold(String id) =>
      (_db.update(_db.orders)..where((o) => o.id.equals(id)))
          .write(const OrdersCompanion(heldBy: Value(null)));

  /// Take a bill another terminal is holding, so it can be worked on here.
  ///
  /// Throws [TerminalUnavailable] when the venue cannot be reached or the bill
  /// has gone. The caller is a clerk standing at a table, and "nothing
  /// happened" is not an answer they can act on.
  Future<void> claim(String id) async {
    final bill = await _terminals.claimBill(id);
    // Written from the server's answer rather than assumed, and with heldBy
    // null: the server has just moved the bill to this terminal, so this is now
    // ours to ring up on and ours to settle.
    await _write(bill, heldBy: null, over: true);
    // So the next push sends it on, rather than skipping it as unchanged
    // against a signature from before it was ours.
    _sent.remove(id);
  }

  static int _int(Object? v) => (v as num?)?.toInt() ?? 0;

  static DateTime? _time(Object? v) =>
      v is String ? DateTime.tryParse(v)?.toLocal() : null;
}
