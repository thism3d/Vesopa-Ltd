/// What this screen has been set up to do.
///
/// All of it is local to this device. There is nothing here another machine
/// needs to know, and putting it in the back office would mean a display that
/// cannot be set up until the broadband is working — on the day of the install,
/// which is exactly when it is not.
library;

import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Where the till writes its basket, by default.
///
/// The till's application support folder under its packaged identity. Computed
/// here rather than asked for, so a display installed beside a till on the same
/// machine works with nothing typed in — which is every installation that is
/// not a separate device.
///
/// Returns null off Windows, and on a machine where the variable is unset. The
/// settings screen then simply shows an empty box with the path it expected.
String? defaultBasketPath() {
  if (!Platform.isWindows) return null;
  final appData = Platform.environment['LOCALAPPDATA'];
  if (appData == null || appData.isEmpty) return null;
  return '$appData\\com.vesopa\\vesopa_epos\\display\\basket.json';
}

@immutable
class DisplaySettings {
  const DisplaySettings({
    this.basketPath = '',
    this.advertFolder = '',
    this.idleSeconds = 45,
    this.dwellSeconds = 12,
    this.showPrices = true,
    this.thankYou = 'Thank you',
  });

  /// The till's basket file.
  final String basketPath;

  /// The folder of images and clips to play. Empty means none chosen.
  final String advertFolder;

  /// How long with no change to the basket before the adverts take the whole
  /// screen.
  ///
  /// The adjustable one the venue asked for. Zero means never — a screen beside
  /// a busy bar may want the bill up permanently — and that is offered rather
  /// than treated as a mistake.
  final int idleSeconds;

  /// How long each still advert stays up.
  final int dwellSeconds;

  /// Whether line prices are shown. A venue that discounts on the fly may not
  /// want a customer reading each line's price off the screen.
  final bool showPrices;

  /// What the screen says when a sale has just been paid for.
  final String thankYou;

  Duration get idleAfter => Duration(seconds: idleSeconds);
  Duration get dwell => Duration(seconds: dwellSeconds);

  /// The advert folder as a directory, or null when none has been chosen.
  ///
  /// Null rather than an empty [Directory]: an empty path resolves to the
  /// process's working directory, and a display that decided to play every
  /// image it found next to its own executable would be a memorable bug.
  Directory? get advertDirectory =>
      advertFolder.trim().isEmpty ? null : Directory(advertFolder.trim());

  /// Whether this screen has been told enough to do its job.
  bool get isConfigured => basketPath.trim().isNotEmpty;

  DisplaySettings copyWith({
    String? basketPath,
    String? advertFolder,
    int? idleSeconds,
    int? dwellSeconds,
    bool? showPrices,
    String? thankYou,
  }) => DisplaySettings(
    basketPath: basketPath ?? this.basketPath,
    advertFolder: advertFolder ?? this.advertFolder,
    idleSeconds: idleSeconds ?? this.idleSeconds,
    dwellSeconds: dwellSeconds ?? this.dwellSeconds,
    showPrices: showPrices ?? this.showPrices,
    thankYou: thankYou ?? this.thankYou,
  );
}

const _keyBasket = 'display.basket_path';
const _keyAdverts = 'display.advert_folder';
const _keyIdle = 'display.idle_seconds';
const _keyDwell = 'display.dwell_seconds';
const _keyPrices = 'display.show_prices';
const _keyThanks = 'display.thank_you';

class DisplaySettingsController extends AsyncNotifier<DisplaySettings> {
  @override
  Future<DisplaySettings> build() async {
    final prefs = await SharedPreferences.getInstance();
    return DisplaySettings(
      // Falls back to the computed path, so a display installed on the same
      // machine as its till needs nothing typed in at all.
      basketPath: prefs.getString(_keyBasket) ?? defaultBasketPath() ?? '',
      advertFolder: prefs.getString(_keyAdverts) ?? '',
      idleSeconds: prefs.getInt(_keyIdle) ?? 45,
      dwellSeconds: prefs.getInt(_keyDwell) ?? 12,
      showPrices: prefs.getBool(_keyPrices) ?? true,
      thankYou: prefs.getString(_keyThanks) ?? 'Thank you',
    );
  }

  Future<void> save(DisplaySettings next) async {
    // On screen first, stored second. A display whose disk is full should still
    // be showing what the manager just set for the rest of the day, rather than
    // silently reverting under them.
    state = AsyncData(next);
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_keyBasket, next.basketPath);
      await prefs.setString(_keyAdverts, next.advertFolder);
      await prefs.setInt(_keyIdle, next.idleSeconds);
      await prefs.setInt(_keyDwell, next.dwellSeconds);
      await prefs.setBool(_keyPrices, next.showPrices);
      await prefs.setString(_keyThanks, next.thankYou);
    } catch (_) {
      // Nothing to tell the customer standing in front of this.
    }
  }
}

final displaySettingsProvider =
    AsyncNotifierProvider<DisplaySettingsController, DisplaySettings>(
      DisplaySettingsController.new,
    );
