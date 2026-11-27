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
    for (final raw in (r['screens'] as List? ?? const [])) {
      final j = Map<String, dynamic>.from(raw as Map);
      final s = _screen('${j['device_id']}', name: '${j['name'] ?? 'Screen'}', mode: '${j['mode'] ?? 'display'}', tv: j['tv'] == true);
      if (j['live'] != false) s.liveAt = DateTime.now();
    }
    _changed();
  }

  /// What a screen shows, from the back office when it was not heard locally
  /// just now.
  static Future<void> refreshState(TapApi api, String id) async {
    final s = screens.value[id];
    if (s == null) return;
    if (s.local && s.stateAt != null && DateTime.now().difference(s.stateAt!) < const Duration(seconds: 3)) return;
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
    final local = s != null && s.local && LanService.instance.publish('go.remote', msg);
    try {
      await api.screenKey(id, key, id: kid, index: index, text: text);
    } on TapApiError {
      if (!local) rethrow;
    }
  }
}
