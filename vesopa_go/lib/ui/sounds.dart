/// Go's sounds, each at the venue's volume (back office, 0 is off), with a
/// switch on the device to mute them all (Settings), and a buzz with each.
library;

import 'package:audioplayers/audioplayers.dart';
import 'package:flutter/services.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../data/go_options.dart';

class GoSounds {
  GoSounds._();

  static const _muteKey = 'go_sounds_muted';
  static final Map<GoSound, AudioPlayer> _players = {};
  static bool muted = false;

  static Future<void> load() async {
    try {
      muted = (await SharedPreferences.getInstance()).getBool(_muteKey) ?? false;
    } catch (_) {}
  }

  static Future<void> setMuted(bool v) async {
    muted = v;
    try {
      await (await SharedPreferences.getInstance()).setBool(_muteKey, v);
    } catch (_) {}
  }

  /// Plays [sound] at the venue's volume. Never throws: a sound that cannot
  /// play is not a reason for a sale to stop.
  static Future<void> play(GoOptions go, GoSound sound) async {
    if (go.haptics) {
      switch (sound) {
        case GoSound.add:
          HapticFeedback.selectionClick();
        case GoSound.approved || GoSound.kitchenReady:
          HapticFeedback.mediumImpact();
        case GoSound.declined || GoSound.allergen:
          HapticFeedback.heavyImpact();
      }
    }
    final volume = go.volume(sound);
    if (muted || volume <= 0) return;
    try {
      final player = _players[sound] ??= AudioPlayer()..setReleaseMode(ReleaseMode.stop);
      await player.stop();
      await player.setVolume(volume / 100);
      await player.play(AssetSource(sound.asset.replaceFirst('assets/', '')), mode: PlayerMode.lowLatency);
    } catch (_) {}
  }
}
