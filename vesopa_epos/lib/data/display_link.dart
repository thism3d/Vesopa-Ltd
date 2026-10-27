/// The live link to the customer displays (2026-10-17): WebSockets, the
/// fastest route there is, with the shared files still written underneath.
///
/// The owner: "use websockets fastest route to communicate between the till
/// and the customer display", and "display might be used on another
/// computer". So two routes, one set of messages (see
/// `vesopa_epos_display/lib/data/till_link.dart` for the other end):
///
///   * **This PC.** A WebSocket server on 127.0.0.1 only. Loopback, so no
///     firewall prompt and no door into the till from the network -- the
///     objection in customer_display.dart to "the till listening on a port"
///     was to a port the network could reach. Its port and a random key go in
///     `link.json` beside the basket, where only a display on this machine
///     can read them.
///   * **Another computer.** The back office's WebSocket (/ws), with this
///     till's terminal token. The display shows a four-digit code, this till
///     connects it, and the back office relays basket, settings and status
///     between this till and its displays only (src/display_link.js).
///
/// A basket goes out on every route the moment it is published, before the
/// file is written. Nothing here throws into a sale.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'customer_display_control.dart' show DisplayStatus;
import 'lan/lan_service.dart';

/// The note beside the basket that tells a display on this PC where to dial.
const displayLinkFile = 'link.json';

/// A display on another computer waiting to be connected.
class RemoteDisplayRequest {
  const RemoteDisplayRequest({required this.device, required this.name, required this.code});
  final String device;
  final String name;
  final String code;
}

/// A display on another computer that this till is connected to.
class RemoteDisplay {
  const RemoteDisplay({required this.device, required this.name, required this.online});
  final String device;
  final String name;
  final bool online;
}

class DisplayLinkHub {
  DisplayLinkHub._();

  /// One per till process: the basket feed and the settings page share it.
  static final instance = DisplayLinkHub._();

  // ---- what the settings page watches -----------------------------------

  final _changes = StreamController<void>.broadcast();

  /// Fires whenever a display connects, reports, asks or goes.
  Stream<void> get changes => _changes.stream;
  void _changed() {
    if (!_changes.isClosed) _changes.add(null);
  }

  List<RemoteDisplayRequest> requests = const [];
  List<RemoteDisplay> remotes = const [];

  /// The latest status from each display, by device id ('local' for the one
  /// on this PC).
  final Map<String, DisplayStatus> statuses = {};
  final Map<String, String> statusNames = {};

  bool get localConnected => _localClients.isNotEmpty;
  bool get cloudConnected => _cloud != null;

  /// The last basket and settings, sent to a display the moment it connects.
  Map<String, Object?>? _lastBasket;
  Map<String, Object?>? _lastControl;

  // ---- this PC ------------------------------------------------------------

  HttpServer? _server;
  String _key = '';
  final Set<WebSocket> _localClients = {};
  Directory? _localFolder;

  /// Start listening on this PC, and say where in [folder]. Idempotent.
  Future<void> startLocal(Directory folder) async {
    if (_server != null && _localFolder?.path == folder.path) return;
    _localFolder = folder;
    try {
      _server ??= await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      if (_key.isEmpty) {
        final r = Random.secure();
        _key = List.generate(24, (_) => r.nextInt(256).toRadixString(16).padLeft(2, '0')).join();
      }
      final server = _server!;
      if (!_listening) {
        _listening = true;
        server.listen(_onLocalRequest, onError: (Object _) {});
      }
      final note = File('${folder.path}${Platform.pathSeparator}$displayLinkFile');
      final temp = File('${note.path}.tmp');
      await temp.writeAsString(jsonEncode({
        'format': 1,
        'port': server.port,
        'token': _key,
        'pid': pid,
        'started_at': DateTime.now().toIso8601String(),
      }), flush: true);
      await temp.rename(note.path);
    } catch (_) {
      // No live link on this PC; the files carry on as before.
    }
  }

  bool _listening = false;

  Future<void> _onLocalRequest(HttpRequest req) async {
    try {
      if (req.uri.path != '/display' ||
          req.uri.queryParameters['token'] != _key ||
          !WebSocketTransformer.isUpgradeRequest(req)) {
        req.response.statusCode = HttpStatus.forbidden;
        await req.response.close();
        return;
      }
      final ws = await WebSocketTransformer.upgrade(req);
      ws.pingInterval = const Duration(seconds: 10);
      _localClients.add(ws);
      // Straight to the screen it should be showing.
      if (_lastControl != null) _send(ws, {'type': 'display.control', 'data': _lastControl});
      if (_lastBasket != null) _send(ws, {'type': 'display.basket', 'data': _lastBasket});
      _changed();
      ws.listen(
        (data) => _onDisplayMessage('local', data),
        onDone: () {
          _localClients.remove(ws);
          _changed();
        },
        onError: (Object _) {},
        cancelOnError: false,
      );
    } catch (_) {}
  }

  void _onDisplayMessage(String device, Object? data, {String? name}) {
    if (data is! String) return;
    try {
      final msg = jsonDecode(data);
      if (msg is! Map) return;
      if (msg['type'] == 'display.hello' && device == 'local') {
        statusNames['local'] = '${msg['name'] ?? 'Customer display'}';
        _changed();
        return;
      }
      if (msg['type'] != 'display.status') return;
      final status = DisplayStatus.fromJson(msg['data']);
      if (status == null) return;
      statuses[device] = status;
      if (name != null) statusNames[device] = name;
      _changed();
    } catch (_) {}
  }

  // ---- another computer ---------------------------------------------------

  WebSocket? _cloud;
  Timer? _cloudRetry;
  Duration _backoff = const Duration(seconds: 2);
  String? _apiBase;
  String? _token;
  String _device = '';
  String _name = 'Till';

  /// Connect to the back office for displays on other computers. Cheap to
  /// call often; reconnects only when something changed.
  void configureCloud({
    required String apiBase,
    required String? terminalToken,
    required String terminalDevice,
    required String terminalName,
  }) {
    final changed = apiBase != _apiBase || terminalToken != _token ||
        terminalDevice != _device || terminalName != _name;
    _apiBase = apiBase;
    _token = terminalToken;
    _device = terminalDevice;
    _name = terminalName;
    _joinLan();
    if (!changed) return;
    _closeCloud();
    _scheduleCloud(Duration.zero);
  }

  void _scheduleCloud(Duration after) {
    _cloudRetry?.cancel();
    _cloudRetry = Timer(after, _connectCloud);
  }

  Future<void> _connectCloud() async {
    final token = _token;
    final base = _apiBase;
    if (_cloud != null || token == null || token.isEmpty || base == null || _device.isEmpty) return;
    try {
      final b = Uri.parse(base);
      final url = b.replace(scheme: b.scheme == 'http' ? 'ws' : 'wss', path: '/ws').toString();
      final ws = await WebSocket.connect(url).timeout(const Duration(seconds: 10));
      ws.pingInterval = const Duration(seconds: 25);
      _cloud = ws;
      _backoff = const Duration(seconds: 2);
      _send(ws, {
        'type': 'display.hello',
        'role': 'till',
        'token': token,
        'device': _device,
        'name': _name,
      });
      _changed();
      ws.listen(
        _onCloudMessage,
        onDone: () {
          if (_cloud == ws) _cloud = null;
          _changed();
          final next = _backoff;
          final doubled = _backoff * 2;
          _backoff = doubled > const Duration(seconds: 30) ? const Duration(seconds: 30) : doubled;
          _scheduleCloud(next);
        },
        onError: (Object _) {},
        cancelOnError: false,
      );
    } catch (_) {
      _cloud = null;
      _scheduleCloud(const Duration(seconds: 10));
    }
  }

  void _onCloudMessage(Object? data) {
    if (data is! String) return;
    try {
      final msg = jsonDecode(data);
      if (msg is! Map) return;
      switch (msg['type']) {
        case 'display.requests':
          requests = [
            for (final r in (msg['list'] as List? ?? const []))
              if (r is Map)
                RemoteDisplayRequest(
                  device: '${r['device']}',
                  name: '${r['name'] ?? 'Customer display'}',
                  code: '${r['code'] ?? ''}',
                ),
          ];
          _changed();
        case 'display.paired_list':
          final hadNone = remotes.isEmpty;
          remotes = [
            for (final r in (msg['list'] as List? ?? const []))
              if (r is Map)
                RemoteDisplay(
                  device: '${r['device']}',
                  name: '${r['name'] ?? 'Customer display'}',
                  online: r['online'] == true,
                ),
          ];
          // The first display on another computer: give it the screen now.
          if (hadNone && remotes.isNotEmpty) {
            if (_lastControl != null) _send(_cloud, {'type': 'display.control', 'data': _lastControl});
            if (_lastBasket != null) _send(_cloud, {'type': 'display.basket', 'data': _lastBasket});
          }
          _changed();
        case 'display.status':
          _onDisplayMessage(
            '${msg['device']}',
            jsonEncode({'type': 'display.status', 'data': msg['data']}),
            name: msg['name'] as String?,
          );
        case 'display.refused':
          _closeCloud();
          _token = null;
      }
    } catch (_) {}
  }

  void _closeCloud() {
    final ws = _cloud;
    _cloud = null;
    try {
      ws?.close();
    } catch (_) {}
  }

  /// Connect a display on another computer.
  void accept(String device) => _send(_cloud, {'type': 'display.accept', 'device': device});

  /// Disconnect a display on another computer.
  void unpair(String device) => _send(_cloud, {'type': 'display.unpair', 'device': device});

  // ---- out ----------------------------------------------------------------

  /// A basket, to every display on every route, now.
  void sendBasket(Map<String, Object?> basket) {
    _lastBasket = basket;
    _broadcast({'type': 'display.basket', 'data': basket});
    _toLan('basket', {'type': 'display.basket', 'data': basket});
  }

  /// The settings, to every display on every route, now.
  void sendControl(Map<String, Object?> control) {
    _lastControl = control;
    _broadcast({'type': 'display.control', 'data': control});
    _toLan('control', {'type': 'display.control', 'data': control});
  }

  // ---- the venue's own network (2026-10-27) ---------------------------------
  //
  // A display on another computer that is paired to this till also follows it
  // over the local link: the same messages, on this till's own channel, kept
  // by the main till so a display that starts later is shown the screen at
  // once. The display draws whichever copy reaches it first; the cloud relay
  // stays for when the two computers are on different networks.

  String? _lanJoined;

  void _joinLan() {
    final device = _device;
    if (device.isEmpty || _lanJoined == device) return;
    _lanJoined = device;
    final lan = LanService.instance;
    lan.subscribe('display-status:$device', (m) {
      final d = m.data;
      if (d is! Map) return;
      _onDisplayMessage(
        'lan:${m.from}',
        jsonEncode({'type': 'display.status', 'data': d['data']}),
        name: d['name'] as String?,
      );
    });
    lan.whenReady(() {
      if (_lastControl != null) _toLan('control', {'type': 'display.control', 'data': _lastControl});
      if (_lastBasket != null) _toLan('basket', {'type': 'display.basket', 'data': _lastBasket});
    });
  }

  void _toLan(String key, Map<String, Object?> msg) {
    if (_device.isEmpty) return;
    LanService.instance.publish('display:$_device', msg, key: key);
  }

  void _broadcast(Map<String, Object?> msg) {
    final text = jsonEncode(msg);
    for (final ws in _localClients.toList()) {
      try {
        ws.add(text);
      } catch (_) {}
    }
    // A bill goes to the back office only when this till has a display on
    // another computer to show it on.
    if (remotes.isEmpty) return;
    try {
      _cloud?.add(text);
    } catch (_) {}
  }

  void _send(WebSocket? ws, Map<String, Object?> msg) {
    try {
      ws?.add(jsonEncode(msg));
    } catch (_) {}
  }
}
