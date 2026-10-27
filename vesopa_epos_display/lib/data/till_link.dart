/// The live link to the till (2026-10-17): WebSockets, the fastest route there
/// is, with the shared files still underneath as the fallback.
///
/// TWO ROUTES, ONE PROTOCOL
///
///   * **This PC.** The till listens on 127.0.0.1 only (no firewall prompt, no
///     door into the machine from the network) and leaves its port in
///     `link.json` beside the basket. A basket reaches this screen the moment
///     the till has it, instead of after a file write and a watcher.
///   * **Another computer.** "Display might be used on another computer." The
///     till and this screen both hold the venue's credential and both reach
///     the back office, so they meet on its WebSocket (src/display_link.js on
///     the server). This screen shows its four-digit code; the till connects
///     it; the back office then relays basket, settings and status between
///     that till and its displays only.
///
/// The messages are the same either way: `display.basket`, `display.control`
/// in; `display.status` out. Nothing here throws, and a link that drops is
/// retried quietly: the files keep a same-PC screen correct meanwhile.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:shared_preferences/shared_preferences.dart';

import 'lan/lan_link.dart';
import 'lan/lan_service.dart';

/// The till's note of where it is listening, beside the basket.
const tillLinkFile = 'link.json';

class TillLink {
  TillLink({
    required this.deviceId,
    required this.deviceName,
    required this.appVersion,
    required this.cloudBase,
  });

  final String deviceId;
  String deviceName;
  final String appVersion;

  /// The back office, e.g. https://backoffice.vesopaepos.com.
  final String cloudBase;

  /// What to do with what arrives. Set by the display page.
  void Function(Object? raw)? onBasket;
  void Function(Object? raw)? onControl;
  void Function(String terminal, String terminalName)? onPaired;
  void Function()? onUnpaired;

  /// Called whenever either route connects or drops, for the status bar.
  void Function()? onChange;

  WebSocket? _local;
  WebSocket? _cloud;
  Timer? _localRetry;
  Timer? _cloudRetry;
  Duration _cloudBackoff = const Duration(seconds: 2);
  bool _stopped = false;

  /// The basket file this screen follows, when paired on this PC.
  String _basketPath = '';

  /// The display token, for the cloud route. Null: not signed in, no cloud.
  String? _token;

  /// The four-digit code, sent while unpaired so a till can offer it.
  String _code = '';

  bool get localUp => _local != null;
  bool get cloudUp => _cloud != null;

  /// 'local', 'lan', 'cloud' or 'file', for the till and the status bar.
  String get route => localUp
      ? 'local'
      : lanUp
          ? 'lan'
          : (cloudUp && _cloudPaired ? 'cloud' : 'file');

  // ---- The venue's own network (2026-10-27) ---------------------------------
  //
  // A display on another computer also follows its till over the venue's local
  // link (lan/lan_link.dart): the same messages on the till's own channel,
  // there in milliseconds and there when the internet is not. Whichever of the
  // two routes speaks first is drawn; while the link is carrying the till, the
  // cloud's copy of the same basket is ignored.

  /// The till this screen follows on the link: its device id, from pairing.
  String? _lanTerminal;
  DateTime? _lanHeard;

  bool get lanUp =>
      _lanTerminal != null &&
      LanService.instance.linked &&
      _lanHeard != null &&
      DateTime.now().difference(_lanHeard!) < const Duration(seconds: 30);

  final Set<String> _lanChannels = {};

  void _followOnLan(String terminal) {
    if (terminal.isEmpty) return;
    _lanTerminal = terminal;
    final channel = 'display:$terminal';
    if (_lanChannels.add(channel)) {
      LanService.instance.subscribe(channel, (m) => _onLan(m));
    }
    onChange?.call();
  }

  void _onLan(LanMessage m) {
    if (m.channel != 'display:$_lanTerminal') return;
    final d = m.data;
    if (d is! Map) return;
    _lanHeard = DateTime.now();
    if (localUp) return;
    switch (d['type']) {
      case 'display.basket':
        onBasket?.call(d['data']);
      case 'display.control':
        onControl?.call(d['data']);
    }
  }

  bool _lanStarted = false;

  Future<void> _startLan(String token) async {
    if (_lanStarted) return;
    _lanStarted = true;
    await LanService.instance.configure(
      apiBase: cloudBase,
      token: token,
      deviceId: 'display-$deviceId',
      name: deviceName,
      version: appVersion,
      role: 'display',
    );
    // The till this screen was paired with last time, so it follows it at
    // once -- before, or without, the back office saying so.
    try {
      final prefs = await SharedPreferences.getInstance();
      final raw = prefs.getString('display.remote_pairing');
      if (raw != null) {
        final j = jsonDecode(raw);
        if (j is Map && j['terminal'] is String) _followOnLan(j['terminal'] as String);
      }
    } catch (_) {}
  }

  bool _cloudPaired = false;

  /// Point the link at what this screen currently knows. Cheap to call often.
  void configure({required String basketPath, String? token, required String code}) {
    final pathChanged = basketPath != _basketPath;
    final tokenChanged = token != _token;
    _basketPath = basketPath;
    _token = token;
    _code = code;
    if (token != null && token.isNotEmpty) unawaited(_startLan(token));
    if (pathChanged) {
      _closeLocal();
      _scheduleLocal(Duration.zero);
    }
    // A screen paired with a till on this PC does not also offer itself to
    // the venue's other tills; the cloud route is for one that is not.
    if (tokenChanged || pathChanged) {
      _closeCloud();
      _scheduleCloud(Duration.zero);
    }
  }

  void start() {
    _stopped = false;
    _scheduleLocal(Duration.zero);
    _scheduleCloud(Duration.zero);
  }

  /// Send this screen's status to whichever till is listening.
  void sendStatus(Map<String, Object?> status) {
    final msg = jsonEncode({'type': 'display.status', 'data': status});
    _send(_local, msg);
    if (_cloudPaired) _send(_cloud, msg);
    final terminal = _lanTerminal;
    if (terminal != null) {
      LanService.instance.publish(
        'display-status:$terminal',
        {'data': status, 'name': deviceName},
        key: 'display-$deviceId',
      );
    }
  }

  void _send(WebSocket? ws, String msg) {
    try {
      ws?.add(msg);
    } catch (_) {
      // Closing; the retry picks it up.
    }
  }

  // ---- This PC ------------------------------------------------------------

  void _scheduleLocal(Duration after) {
    _localRetry?.cancel();
    if (_stopped) return;
    _localRetry = Timer(after, _connectLocal);
  }

  Future<void> _connectLocal() async {
    if (_stopped || _local != null) return;
    if (_basketPath.trim().isEmpty) return;
    try {
      final note = File('${File(_basketPath).parent.path}${Platform.pathSeparator}$tillLinkFile');
      if (!await note.exists()) {
        _scheduleLocal(const Duration(seconds: 5));
        return;
      }
      final raw = jsonDecode(await note.readAsString());
      if (raw is! Map) throw const FormatException('link');
      final port = (raw['port'] as num?)?.toInt();
      final key = raw['token'] as String? ?? '';
      if (port == null || port <= 0) throw const FormatException('port');

      final ws = await WebSocket.connect('ws://127.0.0.1:$port/display?token=${Uri.encodeQueryComponent(key)}')
          .timeout(const Duration(seconds: 4));
      ws.pingInterval = const Duration(seconds: 10);
      _local = ws;
      ws.add(jsonEncode({
        'type': 'display.hello',
        'role': 'display',
        'device': deviceId,
        'name': deviceName,
        'version': appVersion,
      }));
      onChange?.call();
      ws.listen(
        (data) => _onMessage(data, cloud: false),
        onDone: () {
          if (_local == ws) _local = null;
          onChange?.call();
          _scheduleLocal(const Duration(seconds: 2));
        },
        onError: (Object _) {},
        cancelOnError: false,
      );
    } catch (_) {
      _local = null;
      _scheduleLocal(const Duration(seconds: 5));
    }
  }

  void _closeLocal() {
    final ws = _local;
    _local = null;
    try {
      ws?.close();
    } catch (_) {}
  }

  // ---- Another computer ---------------------------------------------------

  void _scheduleCloud(Duration after) {
    _cloudRetry?.cancel();
    if (_stopped) return;
    _cloudRetry = Timer(after, _connectCloud);
  }

  Uri get _cloudUri {
    final base = Uri.parse(cloudBase);
    return base.replace(scheme: base.scheme == 'http' ? 'ws' : 'wss', path: '/ws');
  }

  Future<void> _connectCloud() async {
    if (_stopped || _cloud != null) return;
    if (_basketPath.trim().isNotEmpty) return;
    final token = _token;
    if (token == null || token.isEmpty) return;
    try {
      final ws = await WebSocket.connect(_cloudUri.toString()).timeout(const Duration(seconds: 10));
      ws.pingInterval = const Duration(seconds: 25);
      _cloud = ws;
      _cloudBackoff = const Duration(seconds: 2);
      ws.add(jsonEncode({
        'type': 'display.hello',
        'role': 'display',
        'token': token,
        'device': deviceId,
        'name': deviceName,
        'code': _code,
        'version': appVersion,
      }));
      onChange?.call();
      ws.listen(
        (data) => _onMessage(data, cloud: true),
        onDone: () {
          if (_cloud == ws) _cloud = null;
          _cloudPaired = false;
          onChange?.call();
          _scheduleCloud(_nextBackoff());
        },
        onError: (Object _) {},
        cancelOnError: false,
      );
    } catch (_) {
      _cloud = null;
      _scheduleCloud(_nextBackoff());
    }
  }

  Duration _nextBackoff() {
    final next = _cloudBackoff;
    final doubled = _cloudBackoff * 2;
    _cloudBackoff = doubled > const Duration(seconds: 30) ? const Duration(seconds: 30) : doubled;
    return next;
  }

  void _closeCloud() {
    final ws = _cloud;
    _cloud = null;
    _cloudPaired = false;
    try {
      ws?.close();
    } catch (_) {}
  }

  // ---- Both ---------------------------------------------------------------

  void _onMessage(Object? data, {required bool cloud}) {
    if (data is! String) return;
    Object? msg;
    try {
      msg = jsonDecode(data);
    } catch (_) {
      return;
    }
    if (msg is! Map) return;
    switch (msg['type']) {
      case 'display.basket':
        // A same-PC till is the faster route; while it is up the cloud copy of
        // the same basket is ignored rather than drawn twice. Likewise while
        // the venue's local link is carrying the till.
        if (cloud && (localUp || lanUp)) return;
        onBasket?.call(msg['data']);
      case 'display.control':
        if (cloud && (localUp || lanUp)) return;
        onControl?.call(msg['data']);
      case 'display.paired':
        if (cloud) {
          _cloudPaired = true;
          _followOnLan('${msg['terminal'] ?? ''}');
          onPaired?.call('${msg['terminal'] ?? ''}', '${msg['terminalName'] ?? 'the till'}');
          onChange?.call();
        }
      case 'display.unpaired':
        if (cloud) {
          _cloudPaired = false;
          onUnpaired?.call();
          onChange?.call();
        }
      case 'display.refused':
        // The token is no good any more. Stop trying until it changes.
        if (cloud) {
          _closeCloud();
          _token = null;
        }
    }
  }

  void stop() {
    _stopped = true;
    _localRetry?.cancel();
    _cloudRetry?.cancel();
    _closeLocal();
    _closeCloud();
  }
}
