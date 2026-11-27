/// The phone's side of controlling the venue's screens (owner, 2026-11-27: as
/// Google TV's app, a list of screens on the same Wi-Fi by name, "Connected"
/// with which one, and whether it is reached Local or Live, with several
/// screens at once).
///
/// Screens are found two ways and merged: over the venue's own network
/// (each screen publishes `go.screen` with its state, lib/remote/go_remote.dart)
/// and through the back office (/api/go/screens). A screen heard locally in
/// the last 15 seconds is Local; otherwise it is Live. Keys go over the local
/// network first and through the back office as well, with one id, so the
/// screen acts on each key once whichever arrives first.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:flutter/foundation.dart';

import '../data/api.dart';
import '../data/lan/lan_service.dart';
import 'nsd.dart';

class LinkedScreen {
  LinkedScreen({required this.id, required this.name, required this.mode, required this.tv});
  final String id;
  String name;
  String mode;
  bool tv;

  /// Last heard over the venue's own network, and through the back office.
  DateTime? localAt;
  DateTime? liveAt;

  /// Where it answers on the venue's own Wi-Fi (from the back office's list),
  /// and the address that answered last.
  List<String> localIps = const [];
  int? localPort;
  String? localKey;
  String? localAddr;

  /// The screen's Vesopa Go version and whether it is asking Vesopa for its
  /// keys (from the back office's list).
  String? app;
  bool polling = false;

  /// What the phone tried and what happened, newest last (the connection
  /// check).
  final log = <String>[];
  void note(String line) {
    final t = DateTime.now();
    String two(int n) => n.toString().padLeft(2, '0');
    log.add('${two(t.hour)}:${two(t.minute)}:${two(t.second)}  $line');
    if (log.length > 40) log.removeAt(0);
    debugPrint('go.remote [$name]: $line');
  }

  /// What it shows: page, items (label, kind, value, focused), volume.
  Map<String, dynamic>? state;
  DateTime? stateAt;

  bool get local => localAt != null && DateTime.now().difference(localAt!) < const Duration(seconds: 15);
  bool get live => liveAt != null && DateTime.now().difference(liveAt!) < const Duration(seconds: 40);
  bool get reachable => local || live;
  String get via => local ? 'Local' : 'Live';

  String get modeLabel => switch (mode) {
        'kitchen' => 'Kitchen screen',
        'display' => 'Customer display',
        'epos' => 'Till',
        'terminal' => 'Card terminal',
        _ => 'Screen',
      };
}

class RemoteLink {
  RemoteLink._();

  /// Every screen found, by device id.
  static final screens = ValueNotifier<Map<String, LinkedScreen>>({});

  /// The screens this phone is controlling (the "Connected" bar), newest last.
  static final connected = ValueNotifier<List<String>>([]);

  static bool _listening = false;
  static final _rand = Random();

  /// Hear screens on the venue's own network.
  static void listenLocal() {
    if (_listening) return;
    _listening = true;
    // TVs announcing themselves on this Wi-Fi (Bonjour / NSD): listed at once
    // as Local, before or without Vesopa.
    unawaited(GoNsd.discover(foundOnWifi));
    LanService.instance.subscribe('go.screen', (m) {
      final d = m.data;
      final id = m.key;
      if (d is! Map || id == null || id.isEmpty) return;
      final st = Map<String, dynamic>.from(d);
      final s = _screen(id, name: '${st['name'] ?? 'Screen'}', mode: '${st['mode'] ?? 'display'}', tv: true);
      s.localAt = DateTime.now();
      s.state = st;
      s.stateAt = DateTime.now();
      _changed();
    });
  }

  /// A screen announced on this Wi-Fi: checked with /ping, then Local.
  static void foundOnWifi(NsdScreen f) {
    final known = screens.value[f.id];
    final s = _screen(f.id,
        name: f.name.isNotEmpty ? f.name : (known?.name ?? 'Screen'),
        mode: f.mode.isNotEmpty ? f.mode : (known?.mode ?? 'display'),
        tv: true);
    s.localPort = f.port;
    if (!s.localIps.contains(f.host)) s.localIps = [f.host, ...s.localIps];
    unawaited(() async {
      final r = await _local(s, 'GET', '/ping', addr: f.host, keyless: true);
      // Found by Bonjour: Local once this phone holds the TV's key (from
      // Vesopa's list); until then it is listed, and keys go through Vesopa.
      if (r != null && r['ok'] == true && (s.localKey == null || r['keyed'] == true)) {
        if (s.localAddr != f.host) s.note('Found on this Wi-Fi by itself (Bonjour) at ${f.host}:${f.port}');
        s.localAddr = f.host;
        s.localAt = DateTime.now();
        _changed();
      }
    }());
    _changed();
  }

  static LinkedScreen _screen(String id, {required String name, required String mode, required bool tv}) {
    final all = screens.value;
    final s = all[id] ?? LinkedScreen(id: id, name: name, mode: mode, tv: tv);
    s
      ..name = name
      ..mode = mode
      ..tv = s.tv || tv;
    all[id] = s;
    return s;
  }

  static void _changed() => screens.value = Map.of(screens.value);

  /// The back office's list of screens awake now.
  static Future<void> refresh(TapApi api, String myDeviceId) async {
    listenLocal();
    final r = await api.awakeScreens(myDeviceId);
    final probes = <Future<void>>[];
    for (final raw in (r['screens'] as List? ?? const [])) {
      final j = Map<String, dynamic>.from(raw as Map);
      final s = _screen('${j['device_id']}', name: '${j['name'] ?? 'Screen'}', mode: '${j['mode'] ?? 'display'}', tv: j['tv'] == true);
      // Listed means it said hello in the last 30 s: reachable through
      // Vesopa, whether or not its own live socket is up (it asks for its
      // keys as well). Before, a screen with its socket down was hidden.
      s.liveAt = DateTime.now();
      s.app = j['app'] is String ? j['app'] as String : null;
      s.polling = j['polling'] == true;
      final local = j['local'];
      if (local is! Map && s.log.isEmpty) {
        s.note('Vesopa lists it with no Wi-Fi address (TV on Vesopa Go ${s.app ?? 'older than 1.2.77'})');
      }
      if (local is Map) {
        s.localIps = [for (final ip in (local['ips'] as List? ?? const [])) '$ip'];
        s.localPort = local['port'] is num ? (local['port'] as num).toInt() : null;
        s.localKey = local['key'] is String ? local['key'] as String : null;
        if (!s.local) probes.add(_probe(s));
      }
    }
    _changed();
    if (probes.isNotEmpty) {
      await Future.wait(probes);
      _changed();
    }
  }

  static final _http = HttpClient()..connectionTimeout = const Duration(milliseconds: 700);

  static Future<Map<String, dynamic>?> _local(LinkedScreen s, String method, String path,
      {String? addr, Map<String, Object?>? body, bool quiet = false, bool keyless = false}) async {
    final at = addr ?? s.localAddr;
    if (at == null || s.localPort == null || (s.localKey == null && !keyless)) return null;
    try {
      final req = await _http.openUrl(method, Uri.parse('http://$at:${s.localPort}$path')).timeout(const Duration(milliseconds: 800));
      if (s.localKey != null) req.headers.set('x-go-key', s.localKey!);
      if (body != null) {
        req.headers.contentType = ContentType.json;
        req.write(jsonEncode(body));
      }
      final res = await req.close().timeout(const Duration(milliseconds: 900));
      final text = await utf8.decoder.bind(res).join().timeout(const Duration(milliseconds: 900));
      if (res.statusCode != 200) {
        if (!quiet) s.note('Wi-Fi $at: $method $path answered ${res.statusCode}${res.statusCode == 403 ? ' (wrong key: the TV restarted, waiting for its new one)' : ''}');
        return null;
      }
      final j = jsonDecode(text);
      return j is Map ? Map<String, dynamic>.from(j) : null;
    } catch (e) {
      if (!quiet) {
        final why = e is TimeoutException
            ? 'no answer in time (another network, or Local Network not allowed for Vesopa Go)'
            : (e is SocketException ? 'cannot reach it (${e.osError?.message ?? e.message})' : '$e');
        s.note('Wi-Fi $at: $method $path: $why');
      }
      return null;
    }
  }

  /// Is it on this Wi-Fi? The first of its addresses that answers is used.
  static Future<void> _probe(LinkedScreen s) async {
    for (final ip in s.localIps) {
      final r = await _local(s, 'GET', '/ping', addr: ip);
      if (r != null && r['ok'] == true && r['keyed'] != true) {
        s.note('Wi-Fi $ip: the TV answers but not to this key (it restarted): keys go through Vesopa until the new key arrives');
        continue;
      }
      if (r != null && r['ok'] == true) {
        if (s.localAddr != ip) s.note('Wi-Fi $ip:${s.localPort}: found, keys go straight to it (Local)');
        s.localAddr = ip;
        s.localAt = DateTime.now();
        return;
      }
    }
  }

  /// Check every road to [id] now, for the connection check.
  static Future<void> check(TapApi api, String myDeviceId, String id) async {
    final s = screens.value[id];
    s?.note('Checking…');
    try {
      await refresh(api, myDeviceId);
    } on TapApiError catch (e) {
      s?.note('Vesopa: the list of screens failed: ${e.message}');
    }
    final now = screens.value[id];
    if (now == null) return;
    now.note(now.live ? 'Vesopa: the TV said hello in the last 30 s${now.polling ? ' and is asking for its keys' : ', but is NOT asking for its keys'}' : 'Vesopa: no hello from the TV');
    if (now.localIps.isNotEmpty) {
      now.localAddr = null;
      await _probe(now);
      if (now.localAddr == null) now.note('Wi-Fi: none of ${now.localIps.join(', ')} answered');
    }
    _changed();
  }

  /// What a screen shows, from the back office when it was not heard locally
  /// just now.
  static Future<void> refreshState(TapApi api, String id) async {
    final s = screens.value[id];
    if (s == null) return;
    if (s.local && s.stateAt != null && DateTime.now().difference(s.stateAt!) < const Duration(seconds: 3)) return;
    // On the same Wi-Fi: straight from the screen.
    if (s.localAddr != null) {
      final r = await _local(s, 'GET', '/state');
      if (r != null && r['state'] is Map) {
        s.state = Map<String, dynamic>.from(r['state'] as Map);
        s.stateAt = DateTime.now();
        s.localAt = DateTime.now();
        _changed();
        return;
      }
      s.localAddr = null;
      unawaited(_probe(s));
    }
    try {
      final r = await api.screenStateOf(id);
      if (r['state'] is Map) {
        s.state = Map<String, dynamic>.from(r['state'] as Map);
        s.stateAt = DateTime.now();
        s.liveAt = DateTime.now();
        _changed();
      }
    } on TapApiError {
      // Not on through the back office just now; the local road may still be.
    }
  }

  static void connect(String id) {
    final list = [...connected.value.where((x) => x != id), id];
    connected.value = list;
  }

  static void disconnect(String id) => connected.value = connected.value.where((x) => x != id).toList();

  /// Press [key] on screen [id]: over the venue's own network first, and
  /// through the back office, under one id. Throws [TapApiError] only when
  /// neither road could take it.
  static Future<void> send(TapApi api, String id, String key, {int? index, String? text}) async {
    final kid = '${DateTime.now().microsecondsSinceEpoch}${_rand.nextInt(1 << 20)}';
    final msg = {'device_id': id, 'key': key, 'id': kid, 'index': ?index, 'text': ?text};
    final s = screens.value[id];
    var local = s != null && s.local && LanService.instance.publish('go.remote', msg);
    // Straight to the screen on this Wi-Fi first (fastest), and always
    // through Vesopa too with the same id: the screen presses it once.
    final direct = s != null && s.localAddr != null ? _local(s, 'POST', '/key', body: msg) : null;
    Map<String, dynamic> r;
    try {
      r = await api.screenKey(id, key, id: kid, index: index, text: text);
    } on TapApiError catch (e) {
      s?.note('"$key": Vesopa refused: ${e.message}');
      if (direct != null && await direct != null) {
        s!.localAt = DateTime.now();
        s.note('"$key": sent on the Wi-Fi');
        local = true;
      }
      if (!local) rethrow;
      return;
    }
    if (s != null) {
      final roads = [
        if (r['live'] != false) 'its live connection',
        if (r['polling'] == true) 'its key check',
      ];
      s.note('"$key": Vesopa took it${roads.isEmpty ? ', but the TV has no live connection and is not asking for keys: it will not arrive that way' : ' (to the TV by ${roads.join(' and ')})'}');
    }
    if (direct != null) {
      unawaited(direct.then((r) {
        if (r != null) {
          s!.localAt = DateTime.now();
          s.note('"$key": also sent on the Wi-Fi');
        }
      }));
    }
  }
}
