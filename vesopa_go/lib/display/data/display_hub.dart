/// Vesopa Go as the till a customer display follows (owner, 2026-11-04: a Go
/// display should pair "to a till or another Go device").
///
/// The till's own protocol (vesopa_epos display_link.dart, the server's
/// display_link.js): this device says hello on the back office's socket as a
/// till, with its terminal token; displays waiting with a code are listed for
/// it to connect; the bill goes to the connected displays through the back
/// office and, faster, over the venue's local link on `display:<device>`,
/// which a display follows once paired (data/till_link.dart). Either a Go
/// display or a Windows one can follow it.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import '../../data/lan/lan_service.dart';

class DisplayRequest {
  const DisplayRequest({required this.device, required this.name, required this.code});
  final String device;
  final String name;
  final String code;
}

class PairedDisplay {
  const PairedDisplay({required this.device, required this.name, required this.online});
  final String device;
  final String name;
  final bool online;
}

class GoDisplayHub {
  GoDisplayHub._();
  static final instance = GoDisplayHub._();

  final _changes = StreamController<void>.broadcast();
  Stream<void> get changes => _changes.stream;
  void _changed() {
    if (!_changes.isClosed) _changes.add(null);
  }

  List<DisplayRequest> requests = const [];
  List<PairedDisplay> paired = const [];
  bool get connected => _ws != null;

  WebSocket? _ws;
  Timer? _retry;
  Duration _backoff = const Duration(seconds: 2);
  String? _base;
  String? _token;
  String _device = '';
  String _name = 'Vesopa Go';
  bool _stopped = true;
  Map<String, Object?>? _lastBasket;
  Map<String, Object?>? _lastControl;
  String? _lastBasketText;

  /// Start, or follow a change of venue or device. Cheap to call often.
  void configure({required String apiBase, required String? token, required String device, required String name}) {
    final changed = apiBase != _base || token != _token || device != _device || name != _name;
    _base = apiBase;
    _token = token;
    _device = device;
    _name = name;
    _stopped = false;
    if (!changed && (_ws != null || _retry != null)) return;
    _close();
    _schedule(Duration.zero);
  }

  void stop() {
    _stopped = true;
    _retry?.cancel();
    _retry = null;
    _close();
  }

  void _schedule(Duration after) {
    _retry?.cancel();
    if (_stopped) return;
    _retry = Timer(after, _connect);
  }

  Future<void> _connect() async {
    _retry = null;
    final token = _token, base = _base;
    if (_stopped || _ws != null || token == null || token.isEmpty || base == null || _device.isEmpty) return;
    try {
      final b = Uri.parse(base);
      final ws = await WebSocket.connect(b.replace(scheme: b.scheme == 'http' ? 'ws' : 'wss', path: '/ws').toString())
          .timeout(const Duration(seconds: 10));
      ws.pingInterval = const Duration(seconds: 25);
      _ws = ws;
      _backoff = const Duration(seconds: 2);
      _send({'type': 'display.hello', 'role': 'till', 'token': token, 'device': _device, 'name': _name});
      _changed();
      ws.listen(_onMessage, onDone: () {
        if (_ws == ws) _ws = null;
        _changed();
        final next = _backoff;
        _backoff = _backoff * 2 > const Duration(seconds: 30) ? const Duration(seconds: 30) : _backoff * 2;
        _schedule(next);
      }, onError: (Object _) {}, cancelOnError: false);
    } catch (_) {
      _ws = null;
      _schedule(const Duration(seconds: 10));
    }
  }

  void _onMessage(Object? data) {
    if (data is! String) return;
    try {
      final msg = jsonDecode(data);
      if (msg is! Map) return;
      switch (msg['type']) {
        case 'display.requests':
          requests = [
            for (final r in (msg['list'] as List? ?? const []))
              if (r is Map) DisplayRequest(device: '${r['device']}', name: '${r['name'] ?? 'Customer display'}', code: '${r['code'] ?? ''}'),
          ];
          _changed();
        case 'display.paired_list':
          final hadNone = paired.isEmpty;
          paired = [
            for (final r in (msg['list'] as List? ?? const []))
              if (r is Map) PairedDisplay(device: '${r['device']}', name: '${r['name'] ?? 'Customer display'}', online: r['online'] == true),
          ];
          // The first display connected: give it the screen now.
          if (hadNone && paired.isNotEmpty) {
            if (_lastControl != null) _send({'type': 'display.control', 'data': _lastControl});
            if (_lastBasket != null) _send({'type': 'display.basket', 'data': _lastBasket});
          }
          _changed();
        case 'display.refused':
          _close();
          _token = null;
      }
    } catch (_) {}
  }

  /// Connect the display showing [device]'s code.
  void accept(String device) => _send({'type': 'display.accept', 'device': device});

  /// Let a display go.
  void unpair(String device) => _send({'type': 'display.unpair', 'device': device});

  /// The bill, to every display following this device, now. Unchanged bills
  /// are not sent again.
  void sendBasket(Map<String, Object?> basket) {
    final text = jsonEncode({...basket, 'updated_at': null});
    if (text == _lastBasketText) return;
    _lastBasketText = text;
    _lastBasket = basket;
    final msg = {'type': 'display.basket', 'data': basket};
    _toLan('basket', msg);
    if (paired.isNotEmpty) _send(msg);
  }

  /// The display's settings, as the till sends them.
  void sendControl(Map<String, Object?> control) {
    _lastControl = control;
    final msg = {'type': 'display.control', 'data': control};
    _toLan('control', msg);
    if (paired.isNotEmpty) _send(msg);
  }

  void _toLan(String key, Map<String, Object?> msg) {
    if (_device.isEmpty) return;
    try {
      LanService.instance.publish('display:$_device', msg, key: key);
    } catch (_) {}
  }

  void _send(Map<String, Object?> msg) {
    try {
      _ws?.add(jsonEncode(msg));
    } catch (_) {}
  }

  void _close() {
    final ws = _ws;
    _ws = null;
    try {
      ws?.close();
    } catch (_) {}
  }
}
