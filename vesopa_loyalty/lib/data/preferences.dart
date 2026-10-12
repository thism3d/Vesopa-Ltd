import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../platform/brightness.dart';

/// How the app looks and behaves on this device: light or dark, and whether
/// the card turns the screen up. Settings (lib/ui/settings_page.dart).
///
/// KEPT ON THE DEVICE, NOT THE ACCOUNT. Somebody who likes the app dark on
/// their phone may well want it light on the tablet behind the bar, and
/// neither is anything the venue needs to know. The same reasoning as the
/// notification switch (data/session.dart, Choices).
///
/// Both start at their defaults and correct themselves a moment later, once
/// the device's storage has answered. In practice that is long before the
/// venue's branding arrives, so nobody sees the change.
class AppearanceNotifier extends Notifier<ThemeMode> {
  static const key = 'appearance';

  @override
  ThemeMode build() {
    _load();
    return ThemeMode.system;
  }

  Future<void> _load() async {
    try {
      final saved = (await SharedPreferences.getInstance()).getString(key);
      final mode = parse(saved);
      if (mode != null) state = mode;
    } catch (_) {
      // The device's own setting, then.
    }
  }

  Future<void> set(ThemeMode mode) async {
    state = mode;
    try {
      await (await SharedPreferences.getInstance()).setString(key, mode.name);
    } catch (_) {
      // This run still knows.
    }
  }

  /// 'system', 'light' or 'dark' back to a mode; null for anything else.
  static ThemeMode? parse(String? name) {
    for (final m in ThemeMode.values) {
      if (m.name == name) return m;
    }
    return null;
  }
}

final appearanceProvider = NotifierProvider<AppearanceNotifier, ThemeMode>(AppearanceNotifier.new);

/// "Brighten the screen for my card": on unless the member turns it off.
///
/// Some people find a phone that jumps to full brightness on its own jarring,
/// or have set it low for their eyes, and the card's code reads on most
/// scanners anyway. [ScreenGlow] is told directly, so whatever asks it to
/// glow obeys without needing to know this setting exists.
class CardGlowNotifier extends Notifier<bool> {
  static const key = 'card_glow';

  @override
  bool build() {
    loadCardGlow().then((_) => state = ScreenGlow.allowed);
    return ScreenGlow.allowed;
  }

  Future<void> set(bool on) async {
    state = on;
    ScreenGlow.allowed = on;
    // Turned off while the card is showing: hand the screen back now.
    if (!on) await ScreenGlow.off();
    try {
      await (await SharedPreferences.getInstance()).setBool(key, on);
    } catch (_) {
      // This run still knows.
    }
  }
}

Future<void>? _glowLoaded;

/// The member's card-brightness choice, read once into [ScreenGlow] -- before
/// the card first asks for full brightness, so somebody who turned it off
/// never sees it flash up on opening the app.
Future<void> loadCardGlow() => _glowLoaded ??= () async {
  try {
    final saved = (await SharedPreferences.getInstance()).getBool(CardGlowNotifier.key);
    if (saved != null) ScreenGlow.allowed = saved;
  } catch (_) {
    // On, then.
  }
}();

final cardGlowProvider = NotifierProvider<CardGlowNotifier, bool>(CardGlowNotifier.new);
