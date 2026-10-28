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

  /// Read the choices and apply them; called once at start.
  static Future<void> load() async {
    try {
      final p = await SharedPreferences.getInstance();
      keepAwake = p.getBool(_awakeKey) ?? true;
      fullScreen = p.getBool(_fullKey) ?? true;
    } catch (_) {}
    await apply();
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
