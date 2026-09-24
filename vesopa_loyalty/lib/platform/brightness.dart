import 'package:flutter/foundation.dart';
import 'package:screen_brightness/screen_brightness.dart';

/// Turn the screen right up while a QR code is being shown, and put it back.
///
/// A phone set dim in a bar is a phone whose code the till's scanner cannot
/// read, and the airline and coffee-shop apps all do this for that reason.
/// The app's own brightness is set (not the system's), so nothing outlasts
/// the app: leaving the page, backgrounding or closing it all hand the
/// screen back as it was.
///
/// Best effort on every platform. A browser cannot change the screen at all,
/// a desktop may refuse, and a phone whose user has denied it is a phone
/// showing the code at whatever brightness it had -- never an error in front
/// of a customer.
class ScreenGlow {
  ScreenGlow._();

  static bool _on = false;

  static Future<void> on() async {
    if (kIsWeb || _on) return;
    try {
      await ScreenBrightness.instance.setApplicationScreenBrightness(1.0);
      _on = true;
    } catch (_) {
      // Not on this device. The code is still on screen.
    }
  }

  static Future<void> off() async {
    if (kIsWeb || !_on) return;
    _on = false;
    try {
      await ScreenBrightness.instance.resetApplicationScreenBrightness();
    } catch (_) {
      // Nothing to put back.
    }
  }
}
