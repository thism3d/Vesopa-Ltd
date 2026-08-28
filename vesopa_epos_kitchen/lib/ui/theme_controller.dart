/// Day, Night, or whatever the machine is set to.
///
/// A kitchen screen lives on one wall in one room with one light level, so the
/// choice has to survive a restart — a board that comes back in the wrong theme
/// every time the venue reboots the panel is worse than no choice at all. Kept
/// on the screen rather than in the back office for the same reason: two
/// screens in one venue can be in two different rooms.
///
/// Day is the default, and stays the default. It is the right answer for the
/// bright kitchen this was built for; Night is for the pass in the dim service
/// corridor and the late shift with the main lights off.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

class KdsThemeController extends AsyncNotifier<ThemeMode> {
  static const _key = 'kds_theme_mode';

  @override
  Future<ThemeMode> build() async {
    final prefs = await SharedPreferences.getInstance();
    final stored = prefs.getString(_key);
    return ThemeMode.values.firstWhere(
      (m) => m.name == stored,
      orElse: () => ThemeMode.light,
    );
  }

  Future<void> set(ThemeMode mode) async {
    state = AsyncData(mode);
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_key, mode.name);
  }
}

final kdsThemeProvider =
    AsyncNotifierProvider<KdsThemeController, ThemeMode>(
      KdsThemeController.new,
    );
