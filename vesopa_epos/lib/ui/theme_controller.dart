import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Day / Night / System, remembered between sessions.
///
/// A till lives in one room with one light level, so the operator's choice must
/// survive a restart — being handed the wrong theme every morning is worse than
/// having no choice at all.
class ThemeController extends AsyncNotifier<ThemeMode> {
  static const _key = 'theme_mode';

  @override
  Future<ThemeMode> build() async {
    final prefs = await SharedPreferences.getInstance();
    final stored = prefs.getString(_key);
    return ThemeMode.values.firstWhere(
      (m) => m.name == stored,
      // Dark by default: a till usually stands in a bar or a dim service area,
      // and a full-brightness white screen there is glare in the operator's
      // eyes all shift.
      orElse: () => ThemeMode.dark,
    );
  }

  Future<void> set(ThemeMode mode) async {
    state = AsyncData(mode);
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_key, mode.name);
  }
}

final themeControllerProvider =
    AsyncNotifierProvider<ThemeController, ThemeMode>(ThemeController.new);
