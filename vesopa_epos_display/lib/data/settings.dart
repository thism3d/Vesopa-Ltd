/// What this screen has been set up to do.
///
/// All of it is local to this device. There is nothing here another machine
/// needs to know, and putting it in the back office would mean a display that
/// cannot be set up until the broadband is working — on the day of the install,
/// which is exactly when it is not.
///
/// WHERE THE TILL WENT
///
/// This file used to work out the till's basket path for itself: a note, two
/// computed folders, a sweep of two directory trees, and a hand-typed override
/// underneath all of it for when none of that landed. Every one of those tiers
/// was a guess, and on a machine that has had more than one till installed the
/// guess was wrong often enough to matter.
///
/// It has all gone. The till hands the path over when a person pairs the two
/// applications, and `data/pairing.dart` is the only thing that knows it. There
/// is deliberately no setting here for it — a path that can be typed is a path
/// that can be typed wrongly, and there is now nothing a person could usefully
/// put in the box.
library;

import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

@immutable
class DisplaySettings {
  const DisplaySettings({
    this.advertFolder = '',
    this.screenKey = '',
    this.fullScreen = true,
    this.idleSeconds = 45,
    this.dwellSeconds = 12,
    this.showPrices = true,
    this.thankYou = 'Thank you',
    this.advertVolume = 0,
    this.billOnRight = false,
    this.billShare = 50,
    this.fillScreen = false,
    this.standingMessage = '',
    this.customerQr = '',
    this.customerQrCaption = 'Scan to join',
  });

  /// The folder of images and clips to play. Empty means none chosen.
  final String advertFolder;

  /// Which monitor this window belongs on — see `data/screens.dart` for what
  /// the key is and why it is a hardware id rather than a number.
  ///
  /// Empty means nobody has chosen, which is a fresh install: the window is
  /// left where it opened, showing the pairing card, rather than taking over
  /// the primary screen. On a two-screen till the primary screen is the till.
  final String screenKey;

  /// Whether to fill the chosen screen, with no title bar and nothing to drag.
  ///
  /// On by default, because that is what a customer display is. It only takes
  /// effect once a screen has been chosen, so it cannot swallow the till on a
  /// machine nobody has set up yet, and Escape always brings the window back.
  final bool fullScreen;

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

  /// How loud video adverts play, 0 to 100. Silent by default.
  final int advertVolume;

  /// Which side of the screen the bill is on. Which side is right depends on
  /// where the customer stands, which is a property of the counter.
  final bool billOnRight;

  /// How much of the screen the bill takes, as a percentage. Clamped where it
  /// is used, so a hand-edited file cannot produce a bill with no width.
  final int billShare;

  /// Whether adverts fill their panel, cropping to fit, instead of sitting
  /// inside it with bars around them.
  final bool fillScreen;

  /// A line the venue sets, shown across the bottom of the adverts.
  final String standingMessage;

  /// A code for the customer to point their phone at, and the line under it.
  ///
  /// Set from the till like everything else on this screen. Kept here as well
  /// so a display switched on before the till in the morning comes up with the
  /// venue's code already on it, rather than a blank space until the till says
  /// so again.
  final String customerQr;
  final String customerQrCaption;

  /// The bill's share of the screen, as a usable fraction.
  double get billFraction => (billShare.clamp(20, 80)) / 100;

  Duration get idleAfter => Duration(seconds: idleSeconds);
  Duration get dwell => Duration(seconds: dwellSeconds);

  /// The advert folder as a directory, or null when none has been chosen.
  ///
  /// Null rather than an empty [Directory]: an empty path resolves to the
  /// process's working directory, and a display that decided to play every
  /// image it found next to its own executable would be a memorable bug.
  Directory? get advertDirectory =>
      advertFolder.trim().isEmpty ? null : Directory(advertFolder.trim());

  DisplaySettings copyWith({
    String? advertFolder,
    String? screenKey,
    bool? fullScreen,
    int? idleSeconds,
    int? dwellSeconds,
    bool? showPrices,
    String? thankYou,
    int? advertVolume,
    bool? billOnRight,
    int? billShare,
    bool? fillScreen,
    String? standingMessage,
    String? customerQr,
    String? customerQrCaption,
  }) => DisplaySettings(
    advertFolder: advertFolder ?? this.advertFolder,
    screenKey: screenKey ?? this.screenKey,
    fullScreen: fullScreen ?? this.fullScreen,
    idleSeconds: idleSeconds ?? this.idleSeconds,
    dwellSeconds: dwellSeconds ?? this.dwellSeconds,
    showPrices: showPrices ?? this.showPrices,
    thankYou: thankYou ?? this.thankYou,
    advertVolume: advertVolume ?? this.advertVolume,
    billOnRight: billOnRight ?? this.billOnRight,
    billShare: billShare ?? this.billShare,
    fillScreen: fillScreen ?? this.fillScreen,
    standingMessage: standingMessage ?? this.standingMessage,
    customerQr: customerQr ?? this.customerQr,
    customerQrCaption: customerQrCaption ?? this.customerQrCaption,
  );
}

const _keyAdverts = 'display.advert_folder';

/// The two keys `main()` reads directly, before there is a widget tree to hold
/// a provider. Public so that the window is positioned from the same strings
/// this file stores, rather than from a copy of them that can drift.
const keyScreen = 'display.screen_key';
const keyFullScreen = 'display.full_screen';

const _keyIdle = 'display.idle_seconds';
const _keyDwell = 'display.dwell_seconds';
const _keyPrices = 'display.show_prices';
const _keyThanks = 'display.thank_you';
const _keyQr = 'display.customer_qr';
const _keyQrCaption = 'display.customer_qr_caption';

class DisplaySettingsController extends AsyncNotifier<DisplaySettings> {
  @override
  Future<DisplaySettings> build() async {
    final prefs = await SharedPreferences.getInstance();
    return DisplaySettings(
      advertFolder: prefs.getString(_keyAdverts) ?? '',
      screenKey: prefs.getString(keyScreen) ?? '',
      fullScreen: prefs.getBool(keyFullScreen) ?? true,
      idleSeconds: prefs.getInt(_keyIdle) ?? 45,
      dwellSeconds: prefs.getInt(_keyDwell) ?? 12,
      showPrices: prefs.getBool(_keyPrices) ?? true,
      thankYou: prefs.getString(_keyThanks) ?? 'Thank you',
      customerQr: prefs.getString(_keyQr) ?? '',
      customerQrCaption: prefs.getString(_keyQrCaption) ?? 'Scan to join',
    );
  }

  Future<void> save(DisplaySettings next) async {
    // On screen first, stored second. A display whose disk is full should still
    // be showing what the manager just set for the rest of the day, rather than
    // silently reverting under them.
    state = AsyncData(next);
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_keyAdverts, next.advertFolder);
      await prefs.setString(keyScreen, next.screenKey);
      await prefs.setBool(keyFullScreen, next.fullScreen);
      await prefs.setInt(_keyIdle, next.idleSeconds);
      await prefs.setInt(_keyDwell, next.dwellSeconds);
      await prefs.setBool(_keyPrices, next.showPrices);
      await prefs.setString(_keyThanks, next.thankYou);
      await prefs.setString(_keyQr, next.customerQr);
      await prefs.setString(_keyQrCaption, next.customerQrCaption);
    } catch (_) {
      // Nothing to tell the customer standing in front of this.
    }
  }
}

final displaySettingsProvider =
    AsyncNotifierProvider<DisplaySettingsController, DisplaySettings>(
      DisplaySettingsController.new,
    );
