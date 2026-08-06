import 'dart:async';
import 'dart:convert';

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:drift/drift.dart';
import 'package:http/http.dart' as http;
import 'package:web_socket_channel/web_socket_channel.dart';

import 'local/database.dart';

/// A snapshot of the terminal's link to the back office, for the till's
/// online/offline badge.
class SyncStatus {
  const SyncStatus({required this.online, required this.pending});

  /// True when the last push to the server succeeded — the terminal is live.
  final bool online;

  /// How many sales are still queued in the outbox, waiting to reach the
  /// server. Non-zero while offline, or briefly during a flush.
  final int pending;

  bool get hasBacklog => pending > 0;
}

/// One push from the back office: what changed, and which push it was.
///
/// The sequence number is not decoration, it is the whole reason this is a class
/// rather than the bare `String` it used to be. Riverpod does not notify a
/// listener when a provider's new value equals its old one, and `AsyncData` puts
/// its value into that comparison — so a second `'till-settings'` in a row was
/// silently dropped, and with it the second idle-screen change a manager made.
/// The first one always worked, which is why it read as "sometimes it syncs".
///
/// Deliberately no `==`: two events are never the same event.
class SyncEvent {
  const SyncEvent(this.type, this.seq);

  /// The server's event name — `'till-settings'`, `'staff.updated'`, and so on.
  final String type;

  /// Monotonic per [SyncService], so consecutive events of one type differ.
  final int seq;

  @override
  String toString() => 'SyncEvent($type, #$seq)';
}

/// Drains the outbox to the server and receives live updates from it.
///
/// Sending uses plain HTTP, deliberately. A till must be able to record a sale
/// with no network at all, so the send path has to be something that can fail,
/// be retried later, and survive the process being killed mid-flight. A socket
/// is a live connection — when it drops, in-flight frames are simply lost, and
/// there is no connection to speak of on an offline terminal. The outbox plus
/// an idempotent POST gives us at-least-once delivery that the order id then
/// de-duplicates server side.
///
/// The socket is used for the thing it is actually good at: the server pushing
/// to us — kitchen tickets, table status changing on another terminal, price
/// updates from the back office.
class SyncService {
  SyncService(
    this._db, {
    required this.apiBase,
    required this.wsUrl,
    required this.office,
  });

  final AppDatabase _db;
  final String apiBase;
  final String wsUrl;

  /// Which venue this terminal belongs to. The server keys the catalogue and
  /// the sales by it, so without it a till would be handed every business's
  /// products.
  final String office;

  WebSocketChannel? _channel;
  StreamSubscription<void>? _connectivitySub;
  Timer? _retryTimer;

  /// Backoff state for socket reconnection.
  ///
  /// The socket used to be re-established only by the connectivity listener,
  /// which fires on a network *change*. A socket dropped while the network
  /// stayed up — a server restart, an nginx reload, or a proxy culling an idle
  /// connection, which most do after 60s — left `_channel` null with nothing
  /// scheduled to rebuild it. The terminal showed offline until the app was
  /// restarted, even though the network was fine.
  Timer? _reconnectTimer;
  int _reconnectAttempts = 0;

  /// True only once the handshake has actually completed.
  ///
  /// `WebSocketChannel.connect` is lazy: it returns a channel immediately and
  /// reports failure later on the stream, so a non-null `_channel` never meant
  /// the socket was up. Treating it as proof of life is what let an idle till
  /// report "online" against a server it had never reached.
  bool _socketLive = false;

  /// Cancelled on dispose, and awaited nowhere — this guards against a late
  /// `ready` completing after the service is gone.
  bool _disposed = false;

  /// Whether the terminal currently has a live link to the back office: the
  /// socket is up and the last flush succeeded. Drives the online/offline badge
  /// on the till. Broadcast so the UI can listen without owning the service.
  final _status = StreamController<SyncStatus>.broadcast();
  Stream<SyncStatus> get status => _status.stream;
  var _online = false;
  var _pending = 0;

  /// The last status seen, for a listener that subscribes after start().
  SyncStatus get currentStatus =>
      SyncStatus(online: _online, pending: _pending);

  void _emit() {
    if (_status.isClosed) return;
    _status.add(currentStatus);
  }

  void start() {
    // The network coming back is the moment to catch the terminal up: drain the
    // backlog to the server AND re-pull the catalogue and deals, since the back
    // office may have changed prices or promotions while we were offline and
    // those changes are only pushed over the socket to terminals that were
    // connected at the time. Then bring the socket back for live updates.
    _connectivitySub = Connectivity().onConnectivityChanged.listen((results) {
      if (!results.contains(ConnectivityResult.none)) {
        unawaited(resync());
      } else {
        _online = false;
        _emit();
      }
    });

    // The backstop. This used to call flush() alone, which drains the outbox
    // but never rebuilds the socket — so a dropped connection stayed dropped.
    // It now also reconnects (a no-op when the socket is already up) and, on a
    // till with nothing queued, actively checks the server is reachable.
    _retryTimer = Timer.periodic(const Duration(seconds: 30), (_) {
      _connectWebSocket();
      unawaited(flush());
      unawaited(_probeServer());
    });

    _connectWebSocket();
    unawaited(resync());
  }

  /// Ask the server whether it is there.
  ///
  /// A quiet till has an empty outbox, so `flush()` sends nothing and proves
  /// nothing. Without this the online badge could only ever be corrected by a
  /// sale, which is precisely backwards: the operator needs to know the link is
  /// down *before* they start taking money on it.
  Future<void> _probeServer() async {
    if (_disposed) return;
    try {
      final res = await http
          .get(Uri.parse('$apiBase/health'))
          .timeout(const Duration(seconds: 8));
      final ok = res.statusCode >= 200 && res.statusCode < 300;
      if (ok != _online) {
        _online = ok;
        _emit();
      }
      if (ok) _reconnectAttempts = 0;
    } catch (_) {
      if (_online) {
        _online = false;
        _emit();
      }
    }
  }

  /// Pulls the venue's staff list.
  ///
  /// Injected rather than built here because it needs the terminal token, which
  /// belongs to the session and not to this service. Null until the app wires it
  /// up, and a no-op on a terminal that has none.
  ///
  /// It hangs off [resync] deliberately. Staff used to be pulled by a one-shot
  /// provider that ran at startup and then only when the socket happened to push
  /// a `staff.updated` — so a till that started offline, or that was offline when
  /// a name changed, kept the old list indefinitely. Everything else the till
  /// caches is refreshed by this method, on a schedule that already handles
  /// startup, reconnects and the 30-second backstop. Staff belongs in it.
  Future<void> Function()? pullStaff;

  /// Full catch-up with the back office: push everything queued, then pull the
  /// latest catalogue, deals and staff. Runs on startup and on every reconnect,
  /// so a spell offline never leaves the till selling from a stale price list or
  /// signing people on against a stale staff list.
  Future<void> resync() async {
    _connectWebSocket();
    await flush();
    await pullCatalogue();
    await pullDepartments();
    await pullDeals();
    await pullDenominations();

    // Last, and never allowed to break the rest: a till whose staff list will
    // not come down must still get its prices.
    try {
      await pullStaff?.call();
    } catch (_) {
      // The cached list carries on working. See StaffRepository.
    }
  }

  /// True while a flush is in flight, so the periodic timer, a reconnect and a
  /// per-action push cannot run the outbox concurrently and double-post.
  bool _flushing = false;

  /// Push every queued mutation. Safe to call at any time, including with no
  /// network: failures leave the entry in place to be retried. Overlapping
  /// calls collapse into the one in-flight run.
  Future<void> flush() async {
    if (_flushing) return;
    _flushing = true;
    try {
      await _drain();
    } finally {
      _flushing = false;
    }
  }

  Future<void> _drain() async {
    final entries = await (_db.select(
      _db.outboxEntries,
    )..orderBy([(e) => OrderingTerm(expression: e.createdAt)])).get();

    // Surface the backlog before we start, so the badge shows the queue even if
    // the server is unreachable and every post below fails.
    _pending = entries.length;
    _emit();

    // A run with nothing to send that reaches this point is still evidence the
    // link works; but only a real 2xx proves it, so leave `_online` to the loop.
    var delivered = false;

    for (final entry in entries) {
      try {
        // Each kind of queued mutation has its own endpoint. Namespaced under
        // /till so the back office can own /orders and /products as browser
        // routes.
        final path = switch (entry.entity) {
          'void' => '/till/voids',
          _ => '/till/orders',
        };

        final res = await http
            .post(
              Uri.parse('$apiBase$path'),
              headers: {
                'Content-Type': 'application/json',
                // Lets the server discard a duplicate if our retry crossed with
                // its response, so a flaky link cannot double-book a sale.
                'Idempotency-Key': entry.entityId,
              },
              // Stamp the venue on the way out: the server keys everything by
              // it, and a paused office is refused on this field.
              body: jsonEncode({
                ...jsonDecode(entry.payload) as Map<String, dynamic>,
                'email': office,
                'office': office,
              }),
            )
            .timeout(const Duration(seconds: 10));

        // 2xx means accepted; 409 means the server already has it, which for an
        // idempotent push is success, not failure.
        if (res.statusCode >= 200 && res.statusCode < 300 ||
            res.statusCode == 409) {
          await _db.transaction(() async {
            await (_db.delete(
              _db.outboxEntries,
            )..where((e) => e.id.equals(entry.id))).go();
            await (_db.update(_db.orders)
                  ..where((o) => o.id.equals(entry.entityId)))
                .write(OrdersCompanion(syncedAt: Value(DateTime.now())));
          });
          // A real acknowledgement from the server: the link is live, and the
          // backlog just shrank by one. Emit as we go so the badge counts down.
          delivered = true;
          _online = true;
          _pending = _pending > 0 ? _pending - 1 : 0;
          _emit();
        } else {
          await _recordFailure(entry, 'HTTP ${res.statusCode}');
        }
      } catch (e) {
        // Offline or the server is down: keep the entry and try again later,
        // and mark the terminal offline so the badge reflects it.
        _online = false;
        _emit();
        await _recordFailure(entry, e.toString());
      }
    }

    // An empty queue proves nothing on its own: nothing was sent. Only a socket
    // whose handshake actually completed counts. This previously tested
    // `_channel != null`, which is true the instant connect() is called — so a
    // till that had never reached the server still showed itself online.
    if (entries.isEmpty && _socketLive) {
      _online = true;
    }
    if (delivered || entries.isEmpty) _emit();
  }

  Future<void> _recordFailure(OutboxEntry entry, String error) async {
    await (_db.update(
      _db.outboxEntries,
    )..where((e) => e.id.equals(entry.id))).write(
      OutboxEntriesCompanion(
        attempts: Value(entry.attempts + 1),
        lastError: Value(error),
      ),
    );
  }

  /// Server -> terminal push. Reconnects on drop; the till keeps working
  /// regardless of whether this is up.
  void _connectWebSocket() {
    if (_disposed || _channel != null) return;
    try {
      final channel = WebSocketChannel.connect(Uri.parse(wsUrl));
      _channel = channel;
      _socketLive = false;

      channel.stream.listen(
        _onServerMessage,
        onDone: _resetSocket,
        onError: (_) => _resetSocket(),
        // Without this a socket error becomes an unhandled zone error and, on
        // some platforms, takes the isolate down with it.
        cancelOnError: false,
      );

      // `connect` is lazy, so this is the only place we learn the handshake
      // actually succeeded.
      channel.ready
          .then((_) {
            if (_disposed || _channel != channel) return;
            _socketLive = true;
            _reconnectAttempts = 0;
            if (!_online) {
              _online = true;
              _emit();
            }
          })
          .catchError((Object _) {
            if (_channel == channel) _resetSocket();
          });
    } catch (_) {
      _resetSocket();
    }
  }

  void _resetSocket() {
    _channel = null;
    _socketLive = false;
    // The live link just dropped. Show offline immediately rather than waiting
    // for a queued push to fail.
    if (_online) {
      _online = false;
      _emit();
    }
    _scheduleReconnect();
  }

  /// Rebuild the socket after a drop, backing off so a server that is down does
  /// not get hammered by every till in every venue at once.
  ///
  /// 2s, 4s, 8s, 16s, then every 30s. The periodic timer in [start] is the
  /// backstop if this is ever missed; both funnel through [_connectWebSocket],
  /// which no-ops when a channel already exists.
  void _scheduleReconnect() {
    if (_disposed) return;
    _reconnectTimer?.cancel();

    final seconds = _reconnectAttempts >= 4
        ? 30
        : 2 << _reconnectAttempts.clamp(0, 3);
    _reconnectAttempts++;

    _reconnectTimer = Timer(Duration(seconds: seconds), () {
      if (_disposed || _channel != null) return;
      _connectWebSocket();
      // A reconnect is also the moment to catch up on anything queued while the
      // link was down, and on catalogue changes pushed to terminals that were
      // connected at the time and missed by this one.
      unawaited(resync());
    });
  }

  Future<void> _onServerMessage(dynamic raw) async {
    final msg = jsonDecode(raw as String) as Map<String, dynamic>;
    final type = msg['type'] as String?;
    switch (type) {
      case 'catalogue.updated':
        await pullCatalogue();
        // Departments ride on the catalogue event: the back office broadcasts
        // it for both, and a category picture changing without the rail
        // updating is exactly the "why is it not syncing" complaint.
        await pullDepartments();
      case 'programming.updated':
        // Deals, tax and finalise keys all live here.
        await pullDeals();
      case 'denominations.changed':
        // A note picture or value edited in the back office reaches the counter
        // without anyone restarting the till.
        await pullDenominations();
    }
    // Re-broadcast the event so providers that aren't DB-backed (the floor
    // plan, chiefly) can refresh themselves when the back office changes.
    if (type != null && !_events.isClosed) emit(type);
  }

  /// Server-push events, for UI that needs to refresh on a back-office change
  /// but isn't fed by a database stream. Broadcast so many listeners can
  /// subscribe.
  final _events = StreamController<SyncEvent>.broadcast();
  Stream<SyncEvent> get events => _events.stream;

  int _eventSeq = 0;

  /// Publish an event to the listeners above, stamping it so consecutive
  /// events of one type are distinguishable. See [SyncEvent].
  ///
  /// This is the connected-terminal route only. A till that was offline when the
  /// back office pushed hears nothing here — the socket serves whoever is
  /// attached at the time — and is brought up to date instead by the providers
  /// that watch for the link coming back, and by their own polling.
  void emit(String type) {
    if (_events.isClosed) return;
    _events.add(SyncEvent(type, ++_eventSeq));
  }

  /// Refresh the category buttons — picture, emoji and colour per department.
  ///
  /// Failures are swallowed on purpose. This is decoration on a rail whose
  /// contents come from the products themselves, so a department pull that 404s
  /// against an older server, or times out, must leave the till selling exactly
  /// as it did before.
  Future<void> pullDepartments() async {
    try {
      final res = await http
          .get(
            Uri.parse(
              '$apiBase/till/departments?office=${Uri.encodeComponent(office)}',
            ),
          )
          .timeout(const Duration(seconds: 8));
      if (res.statusCode != 200) return;

      final items = (jsonDecode(res.body) as List<dynamic>)
          .cast<Map<String, dynamic>>();
      final names = <String>{};

      await _db.batch((b) {
        for (final raw in items) {
          final name = (raw['department_name'] as String?)?.trim() ?? '';
          if (name.isEmpty) continue;
          names.add(name);
          b.insert(
            _db.departments,
            DepartmentsCompanion.insert(
              name: name,
              emoji: Value(raw['emoji'] as String?),
              imageUrl: Value(raw['image_url'] as String?),
              buttonColor: Value(raw['button_color'] as String?),
              sortOrder: Value((raw['sort_order'] as num? ?? 0).toInt()),
            ),
            onConflict: DoUpdate((_) => DepartmentsCompanion(
                  emoji: Value(raw['emoji'] as String?),
                  imageUrl: Value(raw['image_url'] as String?),
                  buttonColor: Value(raw['button_color'] as String?),
                  sortOrder: Value((raw['sort_order'] as num? ?? 0).toInt()),
                )),
          );
        }
      });

      // A department deleted in the back office must lose its picture here too,
      // rather than leaving an orphan row decorating a category that is gone.
      if (names.isNotEmpty) {
        await (_db.delete(_db.departments)
              ..where((d) => d.name.isNotIn(names)))
            .go();
      }
    } catch (_) {
      // Offline, or an older server without the endpoint: keep what we have.
    }
  }

  /// Refresh the cash note keys from the back office.
  ///
  /// Like [pullDepartments], failures are swallowed: an office that has never
  /// touched its denominations is served the platform defaults by the server,
  /// and a till that cannot reach the server keeps the set it already cached.
  /// Cash has to keep working when nothing else does.
  Future<void> pullDenominations() async {
    try {
      final res = await http
          .get(
            Uri.parse(
              '$apiBase/till/denominations'
              '?office=${Uri.encodeComponent(office)}',
            ),
          )
          .timeout(const Duration(seconds: 8));
      if (res.statusCode != 200) return;

      final items = (jsonDecode(res.body) as List<dynamic>)
          .cast<Map<String, dynamic>>();
      if (items.isEmpty) return;

      final values = <int>{};
      await _db.batch((b) {
        for (final raw in items) {
          final value = (raw['value_minor'] as num?)?.toInt() ?? 0;
          if (value <= 0) continue;
          values.add(value);

          // The server stores site-relative paths ("/assets/notes/gbp-20.jpg").
          // Resolved here rather than in the widget so the image layer never
          // has to know where the server is — and so a cached row stays valid
          // if the till is later pointed at a different host.
          final path = (raw['image_url'] as String?)?.trim();
          final url = (path == null || path.isEmpty)
              ? null
              : (path.startsWith('http') ? path : '$apiBase$path');

          final label = (raw['label'] as String?)?.trim();
          b.insert(
            _db.cashDenominations,
            CashDenominationsCompanion.insert(
              valueMinor: Value(value),
              label: (label == null || label.isEmpty)
                  ? '£${(value / 100).toStringAsFixed(value % 100 == 0 ? 0 : 2)}'
                  : label,
              imageUrl: Value(url),
              sortOrder: Value((raw['sort_order'] as num? ?? 0).toInt()),
            ),
            onConflict: DoUpdate((_) => CashDenominationsCompanion(
                  label: Value(
                    (label == null || label.isEmpty)
                        ? '£${(value / 100).toStringAsFixed(value % 100 == 0 ? 0 : 2)}'
                        : label,
                  ),
                  imageUrl: Value(url),
                  sortOrder: Value((raw['sort_order'] as num? ?? 0).toInt()),
                )),
          );
        }
      });

      // A key removed in the back office has to disappear from the counter too,
      // or the clerk keeps tapping a note the venue no longer accepts.
      if (values.isNotEmpty) {
        await (_db.delete(_db.cashDenominations)
              ..where((d) => d.valueMinor.isNotIn(values)))
            .go();
      }
    } catch (_) {
      // Offline, or an older server without the endpoint: keep what we have.
    }
  }

  /// Refresh the local product cache. Runs on startup and whenever the back
  /// office signals a change, so the till always has a sellable catalogue even
  /// if it is later cut off from the network.
  Future<void> pullCatalogue() async {
    final res = await http.get(
      Uri.parse('$apiBase/till/products?office=${Uri.encodeComponent(office)}'),
    );
    if (res.statusCode != 200) return;

    final items = jsonDecode(res.body) as List<dynamic>;
    await _db.batch((b) {
      b.insertAllOnConflictUpdate(_db.products, [
        for (final raw in items.cast<Map<String, dynamic>>())
          ProductsCompanion.insert(
            pluId: Value(raw['pluid'] as int),
            name: (raw['product_name'] ?? '') as String,
            departmentName: Value(raw['department_name'] as String?),
            groupName: Value(raw['group_name'] as String?),
            accountingCode: Value(raw['accounting_code'] as String?),
            // The server stores price as a float; convert to pence once, here,
            // so no rounding drift can reach the money maths.
            priceMinor: ((raw['price'] as num? ?? 0) * 100).round(),
            taxPercentage: Value(
              (raw['tax_percentage'] as num? ?? 0).toDouble(),
            ),
            stockQuantity: Value(
              (raw['stock_quantity'] as num? ?? 0).toDouble(),
            ),
            // Set in the back office: where the product sits on the till grid
            // and which kitchen printer it routes to.
            buttonPosition: Value(raw['button_position'] as int?),
            buttonColor: Value(raw['button_color'] as String?),
            printerRoute: Value(raw['printer_route'] as String?),
            emoji: Value(raw['emoji'] as String?),
            // Uploaded images are served relative to the server; store the
            // absolute URL so the till can load it directly.
            imageUrl: Value(_absoluteUrl(raw['image_url'] as String?)),
          ),
      ]);
    });
  }

  /// Turn a server-relative image path into an absolute URL the till can load.
  String? _absoluteUrl(String? path) {
    if (path == null || path.isEmpty) return null;
    if (path.startsWith('http')) return path;
    return '$apiBase$path';
  }

  /// Cache the back office's deals so they still apply when the network is
  /// down — a promotion that silently stops working offline would overcharge
  /// the customer.
  Future<void> pullDeals() async {
    final res = await http.get(
      Uri.parse('$apiBase/till/deals?office=${Uri.encodeComponent(office)}'),
    );
    if (res.statusCode != 200) return;

    final deals = (jsonDecode(res.body) as List<dynamic>)
        .cast<Map<String, dynamic>>();

    await _db.transaction(() async {
      // Replace wholesale: a deal withdrawn in the back office must stop
      // firing here, and a stale row would keep discounting.
      await _db.delete(_db.mixMatchProducts).go();
      await _db.delete(_db.mixMatchDeals).go();

      for (final deal in deals) {
        final id = deal['id'] as int;
        await _db
            .into(_db.mixMatchDeals)
            .insert(
              MixMatchDealsCompanion.insert(
                id: Value(id),
                name: (deal['name'] ?? '') as String,
                triggerQty: Value(deal['trigger_qty'] as int? ?? 2),
                dealPriceMinor: deal['deal_price_minor'] as int? ?? 0,
              ),
            );

        for (final plu
            in (deal['plu_ids'] as List<dynamic>? ?? []).cast<int>()) {
          await _db
              .into(_db.mixMatchProducts)
              .insert(MixMatchProductsCompanion.insert(dealId: id, pluId: plu));
        }
      }
    });
  }

  void dispose() {
    // Set first: a reconnect timer or a late `ready` callback firing after this
    // point would otherwise rebuild the socket and emit on a closed controller.
    _disposed = true;
    _retryTimer?.cancel();
    _reconnectTimer?.cancel();
    _connectivitySub?.cancel();
    _channel?.sink.close();
    _channel = null;
    _status.close();
    _events.close();
  }
}
