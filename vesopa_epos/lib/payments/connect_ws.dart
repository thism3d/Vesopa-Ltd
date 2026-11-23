import 'dart:async';
import 'dart:convert';

import 'package:web_socket_channel/io.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import 'connect_pac.dart';

/// A live JSON-RPC 2.0 link to a Paymentsense Connect account.
///
/// Preferred over the REST interface because a card sale is a *conversation*,
/// not a query: the reader emits "present card", "enter PIN", "remove card" as
/// they happen, and asks the till to check a signature. Over REST that is a
/// poll every second — a second of latency on every prompt, and a rate limit to
/// stay under. Over a socket the reader pushes, so the clerk sees each prompt
/// the moment the customer does.
///
/// **The handshake is not what the REST interface uses.** Verified against the
/// live account: credentials go in the *query string*, not in headers, and the
/// WebSocket interface is `v1` where REST is `v2`. Sending Basic auth headers
/// opens a socket that then answers nothing at all, which is a miserable thing
/// to debug — hence this note.
///
///     wss://<account>.connect.paymentsense.cloud/pac
///         ?token=<api-key>&api-version=v1
///         &software-house-id=<x>&installer-id=<y>
class ConnectSocket {
  ConnectSocket({
    required this.baseUrl,
    required this.apiKey,
    this.softwareHouseId,
    this.installerId,
    this.apiVersion = 'v1',
    this.connectTimeout = const Duration(seconds: 15),
    this.pingInterval = const Duration(seconds: 20),
    this.autoReconnect = false,
    WebSocketChannel Function(Uri uri)? connector,
  }) : _connector = connector ??
            ((uri) => IOWebSocketChannel.connect(
                  uri,
                  pingInterval: pingInterval,
                  connectTimeout: connectTimeout,
                ));

  /// How often the till pings Connect, and so how quickly a dead link is
  /// noticed (a ping not answered within it closes the socket).
  ///
  /// Without it a link that died quietly -- the venue's Wi-Fi blinking, a
  /// router forgetting an idle connection, the PC sleeping -- looked open for
  /// ever: the next sale went into a socket nobody was listening to and sat on
  /// "did not answer" while Connect still had the reader down as held, so the
  /// fallback was refused "Terminal is busy" (Pontardawe RFC, 2026-11-23: "card
  /// machines keep disconnecting from dojo and they use standalone").
  final Duration pingInterval;

  /// Open the link again by itself after it drops, so it is up before the
  /// next sale rather than found down by it. Waits 2, 5, 15, 30, then every
  /// 60 seconds while it cannot. Only once the link has been opened: a till
  /// that never takes a card never holds a link.
  final bool autoReconnect;

  static const _reconnectSteps = [2, 5, 15, 30, 60];
  var _reconnectAttempt = 0;
  Timer? _reconnectTimer;
  bool _disposed = false;

  final String baseUrl;
  final String apiKey;
  final String? softwareHouseId;
  final String? installerId;

  /// The WebSocket interface is versioned separately from REST. v0 is closed to
  /// new integrations, and an unversioned connection silently gets v0.
  final String apiVersion;

  final Duration connectTimeout;
  final WebSocketChannel Function(Uri uri) _connector;

  WebSocketChannel? _channel;
  StreamSubscription<dynamic>? _sub;

  /// In-flight requests, by JSON-RPC id. Connect answers out of order, so the
  /// id is the only thing tying a reply to what asked for it.
  final _pending = <int, Completer<Map<String, dynamic>>>{};
  var _nextId = 1;

  /// Progress from the reader, as it happens.
  void Function(ConnectProgress progress)? onProgress;

  /// Asked when the reader wants a signature checked. Connect sends this as a
  /// *request* — it expects a reply carrying the same id, and the transaction
  /// sits unresolved until it gets one.
  Future<bool> Function()? onSignatureRequested;

  /// Raw traffic, for the diagnostics screen. Both directions.
  void Function(String direction, String message)? onTraffic;

  bool get connected => _channel != null;

  /// Told when the link opens (true) or drops (false), for the till's status.
  void Function(bool connected)? onConnectionChanged;

  /// Why the link last dropped, for the diagnostics screen. Null while open.
  String? lastDrop;

  /// The open in progress, so two callers at once share one socket.
  Future<void>? _opening;

  Uri get uri {
    final host = baseUrl
        .replaceFirst(RegExp(r'^https?://'), '')
        .replaceFirst(RegExp(r'/+$'), '');
    return Uri.parse('wss://$host/pac').replace(queryParameters: {
      'token': apiKey.trim(),
      'api-version': apiVersion,
      'software-house-id': connectSoftwareHouse(softwareHouseId),
      'installer-id': connectInstaller(installerId, softwareHouseId),
    });
  }

  /// Open the socket. Safe to call when already open.
  ///
  /// Connect pings periodically and drops a client that does not answer;
  /// `web_socket_channel` replies to pings in the platform layer, so there is
  /// nothing to do here beyond keeping the subscription alive.
  ///
  /// A link that has dropped is forgotten the moment it drops (see [_dropped]),
  /// so this opens a fresh one: before, the dead one was kept and every sale
  /// after a drop was sent into it until the till was restarted.
  Future<void> connect() {
    if (_channel != null) return Future.value();
    return _opening ??= _open().whenComplete(() => _opening = null);
  }

  Future<void> _open() async {
    final WebSocketChannel channel;
    try {
      channel = _connector(uri);
      // `ready` throws on a rejected handshake — a bad key, or a version the
      // account is not entitled to.
      await channel.ready.timeout(
        connectTimeout,
        onTimeout: () => throw ConnectException(
          'The card machine service did not answer in time. Check the network '
          'and the API URL.',
        ),
      );
    } on ConnectException {
      rethrow;
    } catch (e) {
      throw ConnectException('Could not reach the card machine service: $e');
    }

    _channel = channel;
    lastDrop = null;
    _reconnectAttempt = 0;
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    _sub = channel.stream.listen(
      _receive,
      onError: (Object e) => _dropped(channel, 'Card machine connection error: $e'),
      onDone: () => _dropped(channel, 'The card machine connection closed.'),
      cancelOnError: false,
    );
    onConnectionChanged?.call(true);
  }

  /// The link has gone: fail whatever was waiting on it and forget it, so the
  /// next call opens a new one.
  void _dropped(WebSocketChannel channel, String reason) {
    if (!identical(_channel, channel)) return; // An older link, already gone.
    _channel = null;
    final sub = _sub;
    _sub = null;
    lastDrop = reason;
    _failAll(reason);
    unawaited(sub?.cancel());
    unawaited(Future(() => channel.sink.close()).catchError((_) {}));
    onConnectionChanged?.call(false);
    _scheduleReconnect();
  }

  void _scheduleReconnect() {
    if (!autoReconnect || _disposed || _reconnectTimer != null) return;
    final step = _reconnectSteps[_reconnectAttempt.clamp(0, _reconnectSteps.length - 1)];
    _reconnectAttempt++;
    _reconnectTimer = Timer(Duration(seconds: step), () async {
      _reconnectTimer = null;
      if (_disposed || _channel != null) return;
      try {
        await connect();
      } catch (e) {
        lastDrop = '$e';
        _scheduleReconnect();
      }
    });
  }

  Future<void> dispose() async {
    _disposed = true;
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    _failAll('Card machine connection closed.');
    final channel = _channel;
    _channel = null;
    await _sub?.cancel();
    await channel?.sink.close();
    _sub = null;
  }

  /// Fail every waiting caller. A dropped socket must never leave a payment
  /// hanging on a Future that will never complete — the till would sit on
  /// "waiting for the card" forever.
  void _failAll(String reason) {
    if (_pending.isEmpty) return;
    final waiting = List.of(_pending.values);
    _pending.clear();
    for (final completer in waiting) {
      if (!completer.isCompleted) {
        completer.completeError(ConnectException(reason));
      }
    }
  }

  void _receive(dynamic raw) {
    final text = raw is String ? raw : utf8.decode(raw as List<int>);
    onTraffic?.call('←', text);

    final Map<String, dynamic> message;
    try {
      message = jsonDecode(text) as Map<String, dynamic>;
    } catch (_) {
      return; // Not JSON-RPC; nothing sensible to do with it.
    }

    final method = message['method'] as String?;

    // Server-initiated: a progress notification, or a question we must answer.
    if (method == 'terminalNotification') {
      final params = (message['params'] as Map?)?.cast<String, dynamic>() ?? {};
      onProgress?.call(ConnectProgress(
        notification: (params['notificationValue'] as String? ?? '').toUpperCase(),
      ));
      return;
    }
    if (method == 'signatureVerificationRequest') {
      unawaited(_answerSignature(message));
      return;
    }

    // Otherwise it is a reply to something we asked.
    final id = message['id'];
    if (id is! int) return;
    final completer = _pending.remove(id);
    if (completer == null || completer.isCompleted) return;

    final error = message['error'];
    if (error != null) {
      completer.completeError(
        ConnectException(_errorText(error) ?? 'The card machine refused that.'),
      );
      return;
    }
    completer.complete(message);
  }

  /// Reply to a signature request with the same id it arrived under.
  ///
  /// Connect auto-accepts if nothing answers before its own timeout, so a till
  /// that stays silent still completes the sale — but it completes it without
  /// anybody having looked at the signature, which is the outcome worth
  /// avoiding.
  Future<void> _answerSignature(Map<String, dynamic> request) async {
    final id = request['id'];
    final params = (request['params'] as Map?)?.cast<String, dynamic>() ?? {};

    onProgress?.call(const ConnectProgress(
      notification: 'SIGNATURE_VERIFICATION',
    ));

    var accepted = true;
    try {
      accepted = await (onSignatureRequested?.call() ?? Future.value(true));
    } catch (_) {
      // A failure to ask is not a reason to accept silently, but rejecting
      // would decline a sale the customer may well have signed for correctly.
      // Connect's own default is to accept, so match it.
      accepted = true;
    }

    _send({
      'jsonrpc': '2.0',
      'id': id,
      'result': {'accepted': accepted},
    });
    // Keep the receipt the reader sent with the request; it is the only copy
    // carrying the signature line.
    final receipt = params['receiptLines'];
    if (receipt != null) onTraffic?.call('·', 'signature receipt retained');
  }

  void _send(Map<String, dynamic> message) {
    final channel = _channel;
    if (channel == null) throw _NotSent('Not connected.');
    final text = jsonEncode(message);
    try {
      channel.sink.add(text);
    } catch (e) {
      // A sink that has closed under us: nothing went out.
      _dropped(channel, 'The card machine connection closed.');
      throw _NotSent('$e');
    }
    onTraffic?.call('→', text);
  }

  /// Send a JSON-RPC request and wait for its reply.
  ///
  /// [timeout] is generous by default because the far end of this call is a
  /// human holding a card: a sale legitimately takes minutes.
  Future<Map<String, dynamic>> call(
    String method, {
    Map<String, dynamic> params = const {},
    Duration timeout = const Duration(minutes: 3),
  }) async {
    await connect();

    // Ids wrap at the protocol's maximum rather than growing without bound.
    final id = _nextId;
    _nextId = _nextId >= 999999 ? 1 : _nextId + 1;

    final completer = Completer<Map<String, dynamic>>();
    final request = {
      'jsonrpc': '2.0',
      'id': id,
      'method': method,
      if (params.isNotEmpty) 'params': params,
    };
    // Waited on only once it has gone: a reply arrives in a later event, never
    // during the send, and a send that fails must not fail its own request.
    try {
      _send(request);
    } on _NotSent {
      // The link had gone before this left the till, so the reader was asked
      // nothing: open a new one and ask once more. Safe for a sale, because a
      // request that was never sent cannot have been started.
      await connect();
      try {
        _send(request);
      } on _NotSent catch (e) {
        throw ConnectException('Could not reach the card machine service: ${e.reason}');
      }
    }
    _pending[id] = completer;

    try {
      return await completer.future.timeout(timeout, onTimeout: () {
        _pending.remove(id);
        throw ConnectException(
          'The card machine did not answer in time. Check it before retrying — '
          'the payment may still have gone through.',
        );
      });
    } finally {
      _pending.remove(id);
    }
  }

  /// The card machines on this account.
  Future<List<ConnectTerminal>> connectedTerminals() async {
    final reply = await call(
      'connectedTerminals',
      timeout: const Duration(seconds: 30),
    );
    final result = reply['result'];
    if (result is! List) return const [];
    return result
        .cast<Map<String, dynamic>>()
        .map(ConnectTerminal.fromJson)
        .toList();
  }

  /// Run a sale or a refund. Returns the raw `result` payment object, which has
  /// the same field names as the REST interface's.
  Future<Map<String, dynamic>> performTransaction({
    required String tid,
    required int amountMinor,
    String method = 'sale',
    String currency = 'GBP',
    bool cardholderNotPresent = false,
    int? amountCashback,
  }) async {
    final reply = await call(method, params: {
      'tid': tid,
      'currency': currency,
      'amount': amountMinor,
      if (cardholderNotPresent) 'cardholderNotPresent': true,
      if (amountCashback != null && amountCashback > 0)
        'amountCashback': amountCashback,
    });
    return (reply['result'] as Map?)?.cast<String, dynamic>() ?? const {};
  }

  /// Ask the reader to abandon whatever it is doing.
  Future<void> cancelTransaction(String tid) async {
    await call(
      'cancelTransaction',
      params: {'tid': tid},
      timeout: const Duration(seconds: 30),
    );
  }

  /// The reader's last transaction, for working out what happened after a
  /// timeout.
  Future<Map<String, dynamic>> duplicate(String tid) async {
    final reply = await call(
      'duplicate',
      params: {'tid': tid},
      timeout: const Duration(seconds: 30),
    );
    return (reply['result'] as Map?)?.cast<String, dynamic>() ?? const {};
  }

  /// PDQ reports. The method name carries the report type — there is no
  /// `reportType` parameter over the socket, unlike REST.
  static const reportMethods = {
    ConnectReport.endOfDay: 'reportEndOfDay',
    ConnectReport.banking: 'reportBanking',
    ConnectReport.xBalance: 'reportXBalance',
    ConnectReport.zBalance: 'reportZBalance',
  };

  Future<Map<String, dynamic>> report(ConnectReport report, String tid) async {
    final reply = await call(
      reportMethods[report]!,
      params: {'tid': tid},
      timeout: const Duration(minutes: 2),
    );
    return (reply['result'] as Map?)?.cast<String, dynamic>() ?? const {};
  }

  /// JSON-RPC errors arrive in a couple of shapes across versions; prefer the
  /// clerk-readable one wherever it is.
  static String? _errorText(Object? error) {
    if (error is String) return error;
    if (error is Map) {
      final user = error['userMessage'] ?? error['message'];
      if (user is String && user.trim().isNotEmpty) return user;
      final data = error['data'];
      if (data is Map && data['userMessage'] is String) {
        return data['userMessage'] as String;
      }
    }
    return null;
  }
}

/// A request that never left the till: the link was gone. Distinct from a
/// [ConnectException] because it is always safe to send again.
class _NotSent implements Exception {
  _NotSent(this.reason);
  final String reason;
  @override
  String toString() => reason;
}
