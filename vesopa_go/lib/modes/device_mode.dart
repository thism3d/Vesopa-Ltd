/// What this Vesopa Go device runs as: the till (EPOS), a Vesopa Kitchen
/// screen, or a customer display, one at a time (owner, 2026-11-03).
///
/// The back office decides (Devices › Vesopa Go devices; vesopa_server
/// go_modes.js). Set to a mode, the device opens in it and cannot change it.
/// Left on "Ask on the device", it shows the three after sign-in and keeps
/// the choice, which a manager can change in Settings.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../data/api.dart';
import '../data/models.dart' show VenueMode;
import '../data/session.dart';

enum DeviceMode {
  epos('EPOS', 'Take orders and payments at the counter and the tables.', Icons.point_of_sale_rounded),
  kitchen('Vesopa Kitchen', 'Show the kitchen its tickets, and mark them done.', Icons.soup_kitchen_rounded),
  display('Customer display', 'Show the customer their bill, adverts and how to pay.', Icons.connected_tv_rounded);

  const DeviceMode(this.label, this.detail, this.icon);
  final String label;
  final String detail;
  final IconData icon;

  static DeviceMode? parse(String? v) => switch (v) {
        'epos' => DeviceMode.epos,
        'kitchen' => DeviceMode.kitchen,
        'display' => DeviceMode.display,
        _ => null,
      };
}

@immutable
class DeviceModeState {
  const DeviceModeState({this.mode, this.fixed = false, this.loaded = false});

  /// Null: not chosen yet, so the chooser is shown.
  final DeviceMode? mode;

  /// Set by the back office: not changeable on the device.
  final bool fixed;
  final bool loaded;
}

final deviceModeProvider = NotifierProvider<DeviceModeController, DeviceModeState>(DeviceModeController.new);

class DeviceModeController extends Notifier<DeviceModeState> {
  static const _key = 'go_device_mode';
  static const _fixedKey = 'go_device_mode_fixed';
  String? _loadedFor;

  @override
  DeviceModeState build() => const DeviceModeState();

  /// Read the device's choice and ask the back office, once per venue (and
  /// again when [again]). Offline, the last answer stands.
  bool _loading = false;

  Future<void> load({bool again = false}) async {
    final s = ref.read(tapProvider);
    final office = s.venue?.office ?? '';
    if (_loading || (!again && _loadedFor == office && state.loaded)) return;
    _loading = true;
    try {
      await _load(s, office);
    } finally {
      _loading = false;
    }
  }

  Future<void> _load(TapState s, String office) async {
    _loadedFor = office;
    SharedPreferences? prefs;
    try {
      prefs = await SharedPreferences.getInstance();
    } catch (_) {}
    var mode = DeviceMode.parse(prefs?.getString(_key));
    var fixed = prefs?.getBool(_fixedKey) ?? false;
    // A practice venue, or one with no tills, is the till only.
    if (s.demo || s.venue?.mode != VenueMode.connected) {
      state = const DeviceModeState(mode: DeviceMode.epos, loaded: true);
      return;
    }
    // What it ran as last, at once, so a device that starts with no signal
    // opens straight in its mode; the back office's answer follows.
    if (!state.loaded && mode != null) state = DeviceModeState(mode: mode, fixed: fixed, loaded: true);
    try {
      final r = await ref.read(apiProvider).goMode();
      final server = DeviceMode.parse(r['mode'] as String?);
      fixed = r['fixed'] == true && server != null;
      if (fixed) mode = server;
      // Released by the back office: the device's own last choice stands.
      await prefs?.setBool(_fixedKey, fixed);
      if (mode != null) await prefs?.setString(_key, mode.name);
    } on TapApiError {
      // Offline or an older back office: what this device chose last.
    }
    state = DeviceModeState(mode: mode, fixed: fixed, loaded: true);
    if (mode != null) _report(mode);
  }

  /// The device's own choice, when the back office leaves it to the device.
  Future<bool> choose(DeviceMode mode) async {
    if (state.fixed) return false;
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_key, mode.name);
    } catch (_) {}
    state = DeviceModeState(mode: mode, fixed: false, loaded: true);
    _report(mode);
    return true;
  }

  /// Back to the chooser (Settings › Device mode).
  Future<void> forget() async {
    if (state.fixed) return;
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.remove(_key);
    } catch (_) {}
    state = const DeviceModeState(loaded: true);
  }

  void _report(DeviceMode mode) {
    if (ref.read(tapProvider).demo) return;
    ref.read(apiProvider).reportGoMode(mode.name).then((_) {}, onError: (Object _) {});
  }
}
