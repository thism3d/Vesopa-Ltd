/// The app's handle on the venue's local link (2026-10-27).
///
/// One per process. Holds the [LanNode], fetches the venue's link key from the
/// back office (and keeps it, so a till that starts with the internet down
/// still joins), reports what it can see every minute (the check), and lets
/// the rest of the app subscribe, publish and ask without caring whether the
/// node has been rebuilt underneath it.
///
/// Shared by the till, the kitchen screen and the customer display: copied
/// unchanged into each (tool/sync_lan_link.py), like lan_link.dart.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

import 'lan_link.dart';

class LanService {
  LanService._();
  static final instance = LanService._();

  LanNode? _node;
  LanNode? get node => _node;

  String? _apiBase;
  String? _token;
  String _deviceId = '';
  String _name = '';
  String _version = '';
  String _role = 'till';
  http.Client _client = http.Client();

  Timer? _report;
  Timer? _refresh;
  StreamSubscription<void>? _nodeChanges;
  StreamSubscription<void>? _nodeReady;

  final _changes = StreamController<void>.broadcast();

  /// The main till, the link or the devices seen changed.
  Stream<void> get changes => _changes.stream;
  void _changed() {
    if (!_changes.isClosed) _changes.add(null);
  }

  bool get linked => _node?.linked ?? false;
  bool get isHub => _node?.isHub ?? false;

  /// The main till's clock (this machine's until linked).
  int now() => _node?.now() ?? DateTime.now().millisecondsSinceEpoch;

  /// The till's firewall rule, as last checked. Null: not a till, or unknown.
  bool? firewallOpen;

  /// Windows' name for the network: Private, Public or DomainAuthenticated.
  String? networkProfile;

  static const _keyCache = 'vesopa_lan_key';

  /// Point the link at this device's credentials. Cheap to call often; the
  /// node is only rebuilt when the device, the venue or the key changes.
  Future<void> configure({
    required String apiBase,
    required String? token,
    required String deviceId,
    required String name,
    required String version,
    required String role,
    http.Client? client,
  }) async {
    if (client != null) _client = client;
    final same = apiBase == _apiBase && token == _token && deviceId == _deviceId && role == _role;
    _apiBase = apiBase;
    _token = token;
    _deviceId = deviceId;
    _name = name;
    _version = version;
    _role = role;
    if (same && _node != null) return;
    if (deviceId.isEmpty) return;

    final key = await _readKey(fresh: true);
    if (key == null) return;
    await _startNode(key);

    _report?.cancel();
    _report = Timer.periodic(const Duration(seconds: 60), (_) => unawaited(sendReport()));
    Timer(const Duration(seconds: 8), () => unawaited(sendReport()));
    _refresh?.cancel();
    _refresh = Timer.periodic(const Duration(minutes: 15), (_) => unawaited(_refreshKey()));
    if (role == 'till') unawaited(checkFirewall());
  }

  Future<({List<int> key, String? preferred, List<String> targets})?> _readKey({required bool fresh}) async {
    Map<String, dynamic>? j;
    final base = _apiBase, token = _token;
    if (fresh && base != null && token != null && token.isNotEmpty) {
      try {
        final res = await _client
            .get(Uri.parse('$base/api/lan/key'), headers: {'Authorization': 'Bearer $token'})
            .timeout(const Duration(seconds: 8));
        if (res.statusCode == 200) {
          j = jsonDecode(res.body) as Map<String, dynamic>;
          try {
            final prefs = await SharedPreferences.getInstance();
            await prefs.setString(_keyCache, res.body);
          } catch (_) {}
        }
      } catch (_) {}
    }
    if (j == null) {
      try {
        final prefs = await SharedPreferences.getInstance();
        final raw = prefs.getString(_keyCache);
        if (raw != null) j = jsonDecode(raw) as Map<String, dynamic>;
      } catch (_) {}
    }
    final key = lanKeyFromHex(j?['key'] as String?);
    if (key == null) return null;
    return (
      key: key,
      preferred: j?['preferred_hub'] as String?,
      targets: [for (final t in (j?['targets'] as List? ?? const [])) '$t'],
    );
  }

  List<int>? _key;

  Future<void> _startNode(({List<int> key, String? preferred, List<String> targets}) k) async {
    final sameKey = _key != null && _key!.length == k.key.length && List.generate(k.key.length, (i) => _key![i] == k.key[i]).every((x) => x);
    final old = _node;
    if (old != null && sameKey && old.identity.id == _deviceId && old.identity.role == _role) {
      old.identity.preferredHub = k.preferred;
      old.targets = _targetsOf(k.targets);
      return;
    }
    _key = k.key;
    await _nodeChanges?.cancel();
    await _nodeReady?.cancel();
    await old?.dispose();
    final node = LanNode(
      LanIdentity(
        venueKey: k.key,
        id: _deviceId,
        name: _name,
        role: _role,
        version: _version,
        preferredHub: k.preferred,
      ),
      targets: _targetsOf(k.targets),
    );
    for (final e in _subs.entries) {
      for (final f in e.value) {
        node.subscribe(e.key, f);
      }
    }
    for (final e in _handlers.entries) {
      node.handle(e.key, e.value);
    }
    _nodeChanges = node.changes.listen((_) => _changed());
    _nodeReady = node.onReady.listen((_) {
      for (final f in List.of(_ready)) {
        try {
          f();
        } catch (_) {}
      }
    });
    _node = node;
    await node.start();
    _changed();
  }

  List<({String host, int port})> _targetsOf(List<String> ips) => [
        for (final ip in ips) (host: ip, port: LanNode.defaultDiscoveryPort),
      ];

  Future<void> _refreshKey() async {
    final k = await _readKey(fresh: true);
    if (k != null) await _startNode(k);
  }

  // ---- what the app uses ----------------------------------------------------

  final Map<String, List<void Function(LanMessage)>> _subs = {};
  final Map<String, LanHandler> _handlers = {};
  final List<void Function()> _ready = [];

  void subscribe(String channel, void Function(LanMessage) onMessage) {
    _subs.putIfAbsent(channel, () => []).add(onMessage);
    _node?.subscribe(channel, onMessage);
  }

  void handle(String channel, LanHandler handler) {
    _handlers[channel] = handler;
    _node?.handle(channel, handler);
  }

  /// Called each time this device has a fresh link to a main till.
  void whenReady(void Function() f) => _ready.add(f);

  bool publish(String channel, Object? data, {String? key, bool log = false}) =>
      _node?.publish(channel, data, key: key, log: log) ?? false;

  Future<Object?> request(String channel, Object? data, {Duration timeout = const Duration(seconds: 4)}) {
    final n = _node;
    if (n == null) throw const LanUnavailable('The local link is not running');
    return n.request(channel, data, timeout: timeout);
  }

  // ---- the check -------------------------------------------------------------

  Future<Map<String, Object?>?> report() async {
    final n = _node;
    if (n == null) return null;
    return {
      ...await n.report(),
      'firewall': firewallOpen,
      'network_profile': networkProfile,
      'os': Platform.operatingSystemVersion,
    };
  }

  Future<void> sendReport() async {
    final base = _apiBase, token = _token;
    if (base == null || token == null || token.isEmpty) return;
    final body = await report();
    if (body == null) return;
    try {
      await _client
          .post(
            Uri.parse('$base/api/lan/report'),
            headers: {'Authorization': 'Bearer $token', 'Content-Type': 'application/json'},
            body: jsonEncode(body),
          )
          .timeout(const Duration(seconds: 8));
    } catch (_) {}
  }

  /// Log changes that lost when the link and the cloud met.
  Future<void> logConflicts(List<Map<String, Object?>> conflicts) async {
    final base = _apiBase, token = _token;
    if (base == null || token == null || conflicts.isEmpty) return;
    try {
      await _client
          .post(
            Uri.parse('$base/api/lan/conflicts'),
            headers: {'Authorization': 'Bearer $token', 'Content-Type': 'application/json'},
            body: jsonEncode({'conflicts': conflicts}),
          )
          .timeout(const Duration(seconds: 8));
    } catch (_) {}
  }

  // ---- the till's firewall ------------------------------------------------------

  static const firewallRule = 'Vesopa local link';

  /// Whether Windows lets the other devices in, and what it calls the network.
  Future<void> checkFirewall() async {
    if (!Platform.isWindows) return;
    try {
      final r = await Process.run('netsh', ['advfirewall', 'firewall', 'show', 'rule', 'name=$firewallRule']);
      firewallOpen = r.exitCode == 0 && '${r.stdout}'.contains('47821');
    } catch (_) {
      firewallOpen = null;
    }
    try {
      final r = await Process.run('powershell', [
        '-NoProfile',
        '-Command',
        '(Get-NetConnectionProfile | Select-Object -ExpandProperty NetworkCategory) -join ","',
      ]).timeout(const Duration(seconds: 15));
      final out = '${r.stdout}'.trim();
      networkProfile = out.isEmpty ? null : out;
    } catch (_) {}
    _changed();
  }

  /// Open the two ports, asking Windows for an administrator once (the EXE
  /// installer does the same on a fresh install; this is for a Store copy or
  /// a till installed before the rule existed).
  Future<bool> allowThroughFirewall() async {
    if (!Platform.isWindows) return false;
    try {
      final dir = await Directory.systemTemp.createTemp('vesopa-lan');
      final script = File('${dir.path}${Platform.pathSeparator}allow.cmd');
      await script.writeAsString([
        '@echo off',
        'netsh advfirewall firewall delete rule name="$firewallRule" >nul 2>&1',
        'netsh advfirewall firewall add rule name="$firewallRule" dir=in action=allow protocol=TCP localport=${LanNode.defaultLinkPort} profile=any',
        'netsh advfirewall firewall add rule name="$firewallRule" dir=in action=allow protocol=UDP localport=${LanNode.defaultDiscoveryPort} profile=any',
      ].join('\r\n'));
      await Process.run('powershell', [
        '-NoProfile',
        '-Command',
        "Start-Process -FilePath '${script.path}' -Verb RunAs -WindowStyle Hidden -Wait",
      ]);
      await checkFirewall();
      unawaited(sendReport());
      return firewallOpen == true;
    } catch (_) {
      return false;
    }
  }
}
