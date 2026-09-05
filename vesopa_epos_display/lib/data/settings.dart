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
    this.fillScreen = true,
    this.fillScreenVideo = true,
    this.statusHideSeconds = 10,
    this.saleAdvertsSameFolder = true,
    this.saleAdvertFolder = '',
    this.standingMessage = '',
    this.customerQr = '',
    this.customerQrCaption = 'Scan to join',
    this.childLock = false,
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

  /// Whether still adverts fill their panel, cropping to fit, instead of
  /// sitting inside it with bars around them.
  ///
  /// On by default. A customer display is a poster, and a poster with grey
  /// bars down both sides looks like a screen that is broken rather than one
  /// that is being careful with somebody's aspect ratio. A venue that has had
  /// artwork made to an exact size can turn it off and get the whole frame.
  final bool fillScreen;

  /// The same choice for clips, kept separate from the stills.
  ///
  /// They are separate because the material usually is: a venue's promo video
  /// is cut 16:9 by whoever made it, while its photographs are whatever came
  /// off a phone. One switch for both would force a compromise on one of them.
  final bool fillScreenVideo;

  /// How long the status panel stays up after a tap before hiding itself.
  ///
  /// Zero means never hide it, which is what somebody setting a screen up
  /// wants while they are standing at it. Everything else is a customer-facing
  /// screen with a panel on it, so it goes away on its own.
  final int statusHideSeconds;

  /// Whether a sale on screen keeps the same adverts as the idle loop.
  ///
  /// True is the ordinary answer. False is for a venue that wants its idle
  /// screen selling the room — the Sunday roast, the function suite — and
  /// something quieter beside a bill a customer is reading, where a photograph
  /// of food competes with the prices they are checking.
  final bool saleAdvertsSameFolder;

  /// The folder used beside a bill, when [saleAdvertsSameFolder] is false.
  final String saleAdvertFolder;

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

  /// Whether the screen ignores being touched.
  ///
  /// A customer display lives at hand height on a counter, and the people
  /// nearest it are queueing children, somebody leaning on it while they find
  /// their card, and a cloth at the end of the night. Any of those brings the
  /// status bars up, and a determined one gets into Settings and points the
  /// screen at an empty folder.
  ///
  /// Locked, a tap says the screen is locked and does nothing else. It is
  /// turned on and off from the till — deliberately not from here, because a
  /// lock the locked screen can undo is not a lock.
  final bool childLock;

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

  /// The folder to play from while a bill is on screen.
  ///
  /// Falls back to the idle folder whenever the venue has not set a separate
  /// one, so turning the switch on and then not choosing anything leaves the
  /// screen showing what it showed before rather than going blank.
  Directory? get saleAdvertDirectory {
    if (saleAdvertsSameFolder) return advertDirectory;
    final path = saleAdvertFolder.trim();
    return path.isEmpty ? advertDirectory : Directory(path);
  }

  /// How long the status panel lingers, or null for "until it is dismissed".
  Duration? get statusHideAfter =>
      statusHideSeconds <= 0 ? null : Duration(seconds: statusHideSeconds);

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
    bool? fillScreenVideo,
    int? statusHideSeconds,
    bool? saleAdvertsSameFolder,
    String? saleAdvertFolder,
    String? standingMessage,
    String? customerQr,
    String? customerQrCaption,
    bool? childLock,
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
    fillScreenVideo: fillScreenVideo ?? this.fillScreenVideo,
    statusHideSeconds: statusHideSeconds ?? this.statusHideSeconds,
    saleAdvertsSameFolder: saleAdvertsSameFolder ?? this.saleAdvertsSameFolder,
    saleAdvertFolder: saleAdvertFolder ?? this.saleAdvertFolder,
    standingMessage: standingMessage ?? this.standingMessage,
    customerQr: customerQr ?? this.customerQr,
    customerQrCaption: customerQrCaption ?? this.customerQrCaption,
    childLock: childLock ?? this.childLock,
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

// These five were on the model and in copyWith and in neither of the two
// methods below, so every one of them was set by a manager, applied for the
// rest of the session, and gone by the morning. `fillScreen` in particular
// reverted to letterboxing a screen somebody had deliberately set to fill.
const _keyVolume = 'display.advert_volume';
const _keyBillRight = 'display.bill_on_right';
const _keyBillShare = 'display.bill_share';
const _keyFill = 'display.fill_screen';
const _keyStanding = 'display.standing_message';

const _keyFillVideo = 'display.fill_screen_video';
const _keyStatusHide = 'display.status_hide_seconds';
const _keySaleSame = 'display.sale_adverts_same';
const _keySaleFolder = 'display.sale_advert_folder';
const _keyChildLock = 'display.child_lock';

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
      advertVolume: prefs.getInt(_keyVolume) ?? 0,
      billOnRight: prefs.getBool(_keyBillRight) ?? false,
      billShare: prefs.getInt(_keyBillShare) ?? 50,
      fillScreen: prefs.getBool(_keyFill) ?? true,
      standingMessage: prefs.getString(_keyStanding) ?? '',
      fillScreenVideo: prefs.getBool(_keyFillVideo) ?? true,
      statusHideSeconds: prefs.getInt(_keyStatusHide) ?? 10,
      saleAdvertsSameFolder: prefs.getBool(_keySaleSame) ?? true,
      saleAdvertFolder: prefs.getString(_keySaleFolder) ?? '',
      // Remembered across a restart on purpose. A screen that unlocked itself
      // every time the venue rebooted would be locked in name only.
      childLock: prefs.getBool(_keyChildLock) ?? false,
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
      await prefs.setInt(_keyVolume, next.advertVolume);
      await prefs.setBool(_keyBillRight, next.billOnRight);
      await prefs.setInt(_keyBillShare, next.billShare);
      await prefs.setBool(_keyFill, next.fillScreen);
      await prefs.setString(_keyStanding, next.standingMessage);
      await prefs.setBool(_keyFillVideo, next.fillScreenVideo);
      await prefs.setInt(_keyStatusHide, next.statusHideSeconds);
      await prefs.setBool(_keySaleSame, next.saleAdvertsSameFolder);
      await prefs.setString(_keySaleFolder, next.saleAdvertFolder);
      await prefs.setBool(_keyChildLock, next.childLock);
    } catch (_) {
      // Nothing to tell the customer standing in front of this.
    }
  }
}

final displaySettingsProvider =
    AsyncNotifierProvider<DisplaySettingsController, DisplaySettings>(
      DisplaySettingsController.new,
    );
