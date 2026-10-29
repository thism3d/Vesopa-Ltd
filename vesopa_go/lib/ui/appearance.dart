/// Light, dark or the device's own (owner, 2026-10-28: automatic by default).
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

class Appearance extends Notifier<ThemeMode> {
  static const _key = 'go_appearance';

  @override
  ThemeMode build() {
    SharedPreferences.getInstance().then((p) {
      final v = p.getString(_key);
      final mode = ThemeMode.values.where((m) => m.name == v).firstOrNull;
      if (mode != null && mode != state) state = mode;
    }).catchError((Object _) {});
    return ThemeMode.system;
  }

  Future<void> set(ThemeMode mode) async {
    state = mode;
    try {
      await (await SharedPreferences.getInstance()).setString(_key, mode.name);
    } catch (_) {}
  }
}

final appearanceProvider = NotifierProvider<Appearance, ThemeMode>(Appearance.new);
