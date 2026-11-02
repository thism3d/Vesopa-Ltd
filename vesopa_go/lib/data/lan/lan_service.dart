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

import 'package:crypto/crypto.dart';
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
  Timer? _retry;
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

  /// Addresses typed in on this device (Settings > Local network), for a
  /// network that will not let devices find each other by themselves.
  static const _manualKey = 'vesopa_lan_manual';

  /// Tills heard on the network, kept so that after a power cut -- no internet,
  /// the back office unreachable -- this device still knows where to look.
  static const _knownKey = 'vesopa_lan_known';

  List<String> manualHosts = const [];
  List<String> _knownHosts = const [];
  List<String> _serverHosts = const [];

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

    try {
      final prefs = await SharedPreferences.getInstance();
      manualHosts = prefs.getStringList(_manualKey) ?? const [];
      _knownHosts = prefs.getStringList(_knownKey) ?? const [];
    } catch (_) {}

    final key = await _readKey(fresh: true);
    if (key == null) {
      // Never signed in with the internet up on this device, or the back
      // office is down: nothing to join with yet, so ask again shortly.
      _retry?.cancel();
      _retry = Timer(const Duration(minutes: 1), () {
        _token = null;
        unawaited(configure(
          apiBase: apiBase,
          token: token,
          deviceId: deviceId,
          name: name,
          version: version,
          role: role,
        ));
      });
      return;
    }
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
    node.onCall('identify', (data, from) {
      if (!_identify.isClosed) _identify.add('This is ${node.identity.name}');
      return {'shown': true};
    });
    node.onCall('restart', (data, from) async {
      final check = busy;
      if (check != null && await check()) {
        throw const LanUnavailable('Not restarted: a sale is in progress on this device.');
      }
      await Process.start(Platform.resolvedExecutable, const [], mode: ProcessStartMode.detached);
      Timer(const Duration(milliseconds: 400), () => exit(0));
      return {'restarting': true};
    });
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

  List<({String host, int port})> _targetsOf(List<String> ips) {
    _serverHosts = ips;
    return [
      for (final ip in {...manualHosts, ...ips, ..._knownHosts})
        (host: ip, port: LanNode.defaultDiscoveryPort),
    ];
  }

  /// Set the addresses typed in on this device.
  Future<void> setManualHosts(List<String> hosts) async {
    manualHosts = [
      for (final h in hosts)
        if (InternetAddress.tryParse(h.trim())?.type == InternetAddressType.IPv4) h.trim(),
    ];
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setStringList(_manualKey, manualHosts);
    } catch (_) {}
    _node?.targets = _targetsOf(_serverHosts);
    _changed();
  }

  /// Remember where the venue's tills are, for the next time there is no
  /// back office to ask.
  Future<void> _rememberTills() async {
    final n = _node;
    if (n == null) return;
    final seen = {
      for (final p in n.peers.values)
        if (p.role == 'till' && !p.address.isLoopback) p.address.address,
    };
    if (seen.isEmpty || seen.every(_knownHosts.contains)) return;
    _knownHosts = {...seen, ..._knownHosts}.take(16).toList();
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setStringList(_knownKey, _knownHosts);
    } catch (_) {}
    n.targets = _targetsOf(_serverHosts);
  }

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
    Map<String, Object?> extra = const {};
    try {
      extra = await extraReport?.call() ?? const {};
    } catch (_) {}
    return {
      ...await n.report(),
      'firewall': firewallOpen,
      'network_profile': networkProfile,
      'os': Platform.operatingSystemVersion,
      ...extra,
    };
  }

  // ---- Vesopa support (2026-11-02) -------------------------------------------
  //
  // The Connected devices page on the till, and the same controls for a Vesopa
  // admin in the back office, which reach the devices through the main till.

  final _identify = StreamController<String>.broadcast();

  /// Show this message across this device's screen (see LanIdentifyBanner).
  Stream<String> get identifyRequests => _identify.stream;

  /// Whether a restart would interrupt a sale. Set by the till.
  Future<bool> Function()? busy;

  /// What else this device reports: a till's printers and card machine.
  Future<Map<String, Object?>> Function()? extraReport;

  /// Checks this till's printers, for the full check.
  Future<List<Map<String, Object?>>> Function()? testPrinters;

  /// Today's support code for this venue. See supportCode in src/lan.js.
  String? _codeFor(DateTime day) {
    final key = _key;
    if (key == null) return null;
    final date = day.toUtc().toIso8601String().substring(0, 10);
    final mac = Hmac(sha256, key).convert(utf8.encode('vesopa-lan-support|$date')).bytes;
    final n = ((mac[0] << 24) | (mac[1] << 16) | (mac[2] << 8) | mac[3]) & 0xFFFFFFFF;
    return (n % 1000000).toString().padLeft(6, '0');
  }

  /// Whether [code] opens the page. Yesterday's works too, for a day that
  /// turns over at midnight UTC while somebody is on the phone to the venue.
  bool checkSupportCode(String code) {
    final now = DateTime.now().toUtc();
    final c = code.trim();
    return c.isNotEmpty && (c == _codeFor(now) || c == _codeFor(now.subtract(const Duration(days: 1))));
  }

  static const _devicesCache = 'vesopa_lan_devices';

  /// Every device the back office has heard from this month, or the last list
  /// kept here when it cannot be reached.
  Future<List<Map<String, dynamic>>> knownDevices() async {
    final base = _apiBase, token = _token;
    List<Map<String, dynamic>> parse(String raw) => [
          for (final d in (jsonDecode(raw) as Map)['devices'] as List) (d as Map).cast<String, dynamic>(),
        ];
    if (base != null && token != null) {
      try {
        final res = await _client
            .get(Uri.parse('$base/api/lan/devices'), headers: {'Authorization': 'Bearer $token'})
            .timeout(const Duration(seconds: 6));
        if (res.statusCode == 200) {
          try {
            final prefs = await SharedPreferences.getInstance();
            await prefs.setString(_devicesCache, res.body);
          } catch (_) {}
          return parse(res.body);
        }
      } catch (_) {}
    }
    try {
      final prefs = await SharedPreferences.getInstance();
      final raw = prefs.getString(_devicesCache);
      if (raw != null) return parse(raw);
    } catch (_) {}
    return const [];
  }

  /// How long the back office takes to answer, or null when it cannot be reached.
  Future<int?> testInternet() async {
    final base = _apiBase;
    if (base == null) return null;
    final clock = Stopwatch()..start();
    try {
      final res = await _client.get(Uri.parse('$base/health')).timeout(const Duration(seconds: 6));
      return res.statusCode == 200 ? clock.elapsedMilliseconds : null;
    } catch (_) {
      return null;
    }
  }

  /// Make [device] the main till, and tell the back office so it stays so.
  Future<void> makeMain(String device) async {
    final n = _node;
    if (n == null) throw const LanUnavailable('The local link is not running');
    await n.call(device, 'takeover', null);
    final base = _apiBase, token = _token;
    if (base == null || token == null) return;
    try {
      await _client
          .post(
            Uri.parse('$base/api/lan/main-till'),
            headers: {'Authorization': 'Bearer $token', 'Content-Type': 'application/json'},
            body: jsonEncode({'device': device}),
          )
          .timeout(const Duration(seconds: 6));
    } catch (_) {}
  }

  /// Every test at once: the internet, each device on the link, the printers.
  Future<Map<String, Object?>> fullCheck() async {
    final n = _node;
    if (n == null) throw const LanUnavailable('The local link is not running');
    final ids = <String, String>{
      for (final p in n.peers.values)
        if (p.id != n.identity.id && (p.role == 'till' || n.isHub == false || n.clients.any((c) => c['id'] == p.id)))
          p.id: p.name,
      for (final c in n.clients) '${c['id']}': '${c['name']}',
    };
    final devices = <Map<String, Object?>>[];
    for (final e in ids.entries) {
      Map<String, Object?> link;
      try {
        link = await n.testConnection(e.key, count: 5);
      } catch (error) {
        link = {'ok': false, 'error': '$error'};
      }
      Map<String, Object?>? speed;
      if (link['ok'] == true) {
        try {
          speed = await n.testSpeed(e.key, kilobytes: 128);
        } catch (_) {}
      }
      devices.add({'id': e.key, 'name': e.value, 'link': link, 'speed': speed});
    }
    List<Map<String, Object?>> printers = const [];
    try {
      printers = await testPrinters?.call() ?? const [];
    } catch (_) {}
    return {
      'internet_ms': await testInternet(),
      'firewall': firewallOpen,
      'network_profile': networkProfile,
      'is_hub': n.isHub,
      'linked': n.linked,
      'devices': devices,
      'printers': printers,
    };
  }

  /// One action from the back office, or from the page's own buttons.
  Future<Object?> runAction(String target, String action) async {
    final n = _node;
    if (n == null) throw const LanUnavailable('The local link is not running');
    return switch (action) {
      'ping' => n.testConnection(target),
      'speed' => n.testSpeed(target),
      'identify' => n.call(target, 'identify', null),
      'restart' => n.call(target, 'restart', null),
      'disconnect' => n.call(target, 'disconnect', null),
      'takeover' => makeMain(target).then((_) => {'ok': true}),
      'fullcheck' => fullCheck(),
      _ => throw LanUnavailable('Unknown action $action'),
    };
  }

  bool _polling = false;

  /// On the main till: run what a Vesopa admin asked for in the back office.
  Future<void> pollCommands() async {
    final base = _apiBase, token = _token;
    if (!isHub || _polling || base == null || token == null) return;
    _polling = true;
    final headers = {'Authorization': 'Bearer $token', 'Content-Type': 'application/json'};
    try {
      final res = await _client
          .get(Uri.parse('$base/api/lan/commands'), headers: headers)
          .timeout(const Duration(seconds: 6));
      if (res.statusCode != 200) return;
      for (final c in (jsonDecode(res.body) as Map)['commands'] as List) {
        final m = c as Map;
        Map<String, Object?> body;
        try {
          body = {'ok': true, 'result': await runAction('${m['target']}', '${m['action']}')};
        } catch (e) {
          body = {'ok': false, 'result': {'error': '$e'}};
        }
        await _client
            .post(Uri.parse('$base/api/lan/commands/${m['id']}/result'), headers: headers, body: jsonEncode(body))
            .timeout(const Duration(seconds: 6));
      }
    } catch (_) {
      // Asked again on the next report.
    } finally {
      _polling = false;
    }
  }

  Future<void> sendReport() async {
    unawaited(_rememberTills());
    unawaited(pollCommands());
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
