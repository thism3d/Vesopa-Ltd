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
      final local = j['local'];
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

  static Future<Map<String, dynamic>?> _local(LinkedScreen s, String method, String path, {String? addr, Map<String, Object?>? body}) async {
    final at = addr ?? s.localAddr;
    if (at == null || s.localPort == null || s.localKey == null) return null;
    try {
      final req = await _http.openUrl(method, Uri.parse('http://$at:${s.localPort}$path')).timeout(const Duration(milliseconds: 800));
      req.headers.set('x-go-key', s.localKey!);
      if (body != null) {
        req.headers.contentType = ContentType.json;
        req.write(jsonEncode(body));
      }
      final res = await req.close().timeout(const Duration(milliseconds: 900));
      final text = await utf8.decoder.bind(res).join().timeout(const Duration(milliseconds: 900));
      if (res.statusCode != 200) return null;
      final j = jsonDecode(text);
      return j is Map ? Map<String, dynamic>.from(j) : null;
    } catch (_) {
      return null;
    }
  }

  /// Is it on this Wi-Fi? The first of its addresses that answers is used.
  static Future<void> _probe(LinkedScreen s) async {
    for (final ip in s.localIps) {
      final r = await _local(s, 'GET', '/ping', addr: ip);
      if (r != null && r['ok'] == true) {
        s.localAddr = ip;
        s.localAt = DateTime.now();
        return;
      }
    }
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
    try {
      await api.screenKey(id, key, id: kid, index: index, text: text);
    } on TapApiError {
      if (direct != null && await direct != null) {
        s!.localAt = DateTime.now();
        local = true;
      }
      if (!local) rethrow;
      return;
    }
    if (direct != null) {
      unawaited(direct.then((r) {
        if (r != null) s!.localAt = DateTime.now();
      }));
    }
  }
}
