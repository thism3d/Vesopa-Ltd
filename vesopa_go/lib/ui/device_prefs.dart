/// This device's own settings (owner, 2026-10-28): the screen stays on, the
/// app runs full screen, Android leaves it out of battery saving, and NFC's
/// state is told plainly when a feature needs it.
library;

import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:nfc_manager/nfc_manager.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:wakelock_plus/wakelock_plus.dart';

class DevicePrefs {
  DevicePrefs._();

  static const _awakeKey = 'go_keep_awake';
  static const _fullKey = 'go_full_screen';
  static const _channel = MethodChannel('com.vesopa.go/device');

  static bool keepAwake = true;
  static bool fullScreen = true;

  // The idle screen on this device (owner, 2026-10-31: "hide the top and
  // bottom and expand ... a proper idle screen, customised in the settings").
  static const _idleFillKey = 'go_idle_fill';
  static const _idleTopKey = 'go_idle_top';
  static const _idleMessageKey = 'go_idle_message';
  static const _idleShadeKey = 'go_idle_shade';

  /// The picture fills the screen (cropped at the edges) rather than shown
  /// whole on bands of its own colour.
  static bool idleFill = true;

  /// The venue's logo, name and the clock along the top.
  static bool idleTop = true;

  /// The venue's message ("Touch to begin").
  static bool idleMessage = true;

  /// A shade over the picture so the words read on any picture.
  static bool idleShade = true;

  /// Read the choices and apply them; called once at start.
  static Future<void> load() async {
    try {
      final p = await SharedPreferences.getInstance();
      keepAwake = p.getBool(_awakeKey) ?? true;
      fullScreen = p.getBool(_fullKey) ?? true;
      idleFill = p.getBool(_idleFillKey) ?? true;
      idleTop = p.getBool(_idleTopKey) ?? true;
      idleMessage = p.getBool(_idleMessageKey) ?? true;
      idleShade = p.getBool(_idleShadeKey) ?? true;
    } catch (_) {}
    await apply();
  }

  static Future<void> setIdle({bool? fill, bool? top, bool? message, bool? shade}) async {
    idleFill = fill ?? idleFill;
    idleTop = top ?? idleTop;
    idleMessage = message ?? idleMessage;
    idleShade = shade ?? idleShade;
    try {
      final p = await SharedPreferences.getInstance();
      await p.setBool(_idleFillKey, idleFill);
      await p.setBool(_idleTopKey, idleTop);
      await p.setBool(_idleMessageKey, idleMessage);
      await p.setBool(_idleShadeKey, idleShade);
    } catch (_) {}
  }

  static Future<void> apply() async {
    if (kIsWeb) return;
    try {
      await WakelockPlus.toggle(enable: keepAwake);
    } catch (_) {}
    try {
      await SystemChrome.setEnabledSystemUIMode(fullScreen ? SystemUiMode.immersiveSticky : SystemUiMode.edgeToEdge);
    } catch (_) {}
  }

  static Future<void> set({bool? awake, bool? full}) async {
    keepAwake = awake ?? keepAwake;
    fullScreen = full ?? fullScreen;
    try {
      final p = await SharedPreferences.getInstance();
      await p.setBool(_awakeKey, keepAwake);
      await p.setBool(_fullKey, fullScreen);
    } catch (_) {}
    await apply();
  }

  /// Android: whether the system leaves the app running in the background.
  static Future<bool?> batteryUnrestricted() async {
    if (kIsWeb || !Platform.isAndroid) return null;
    try {
      return await _channel.invokeMethod<bool>('isIgnoringBatteryOptimizations');
    } catch (_) {
      return null;
    }
  }

  /// Android's battery optimisation list, where Vesopa Go can be set to
  /// "Not optimised".
  static Future<void> openBatterySettings() async {
    try {
      await _channel.invokeMethod<void>('openBatterySettings');
    } catch (_) {}
  }

  /// Android's NFC settings, to switch NFC on.
  static Future<void> openNfcSettings() async {
    try {
      await _channel.invokeMethod<void>('openNfcSettings');
    } catch (_) {}
  }
}

/// NFC on this device, in words a clerk can act on; null when it is on.
Future<String?> nfcProblem() async {
  if (kIsWeb) return 'This device has no NFC.';
  try {
    return switch (await NfcManager.instance.checkAvailability()) {
      NfcAvailability.enabled => null,
      NfcAvailability.disabled => 'NFC is switched off. Switch it on in the device\'s settings to tap cards here.',
      NfcAvailability.unsupported => 'This device has no NFC, so cards cannot be tapped on it.',
    };
  } catch (_) {
    return 'NFC could not be checked on this device.';
  }
}
