/// Keeping the kiosk on the screen.
///
/// A kiosk that can be closed or minimised from the screen is a kiosk the
/// first curious teenager closes. So on the desktop the window is full screen,
/// has no title bar, cannot be minimised, and ignores the close button and
/// Alt+F4 -- the same lock the till and the kitchen screen use. The only way
/// out is Settings, behind the passcode.
///
/// This is the application's half. The machine's half is Windows' own
/// Assigned Access ("kiosk mode"), which stops the Start menu, the taskbar and
/// Ctrl+Alt+Del getting anywhere; see the README for setting it up.
///
/// `--dart-define=EXPRESS_WINDOWED=true` runs it in an ordinary window, at
/// EXPRESS_W x EXPRESS_H, for development and for screenshots.
///
/// Android and iOS later have their own equivalents (screen pinning, Guided
/// Access); this file is where they will go.
library;

import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';
import 'package:window_manager/window_manager.dart';

class KioskWindow {
  static const windowed = bool.fromEnvironment('EXPRESS_WINDOWED');
  static const _w = int.fromEnvironment('EXPRESS_W', defaultValue: 608);
  static const _h = int.fromEnvironment('EXPRESS_H', defaultValue: 1080);

  static bool get _desktop =>
      !kIsWeb && (Platform.isWindows || Platform.isMacOS || Platform.isLinux);

  static Future<void> lock() async {
    if (!_desktop) return;
    await windowManager.ensureInitialized();
    await windowManager.waitUntilReadyToShow(
      WindowOptions(
        title: 'Vesopa Express',
        titleBarStyle: windowed ? TitleBarStyle.normal : TitleBarStyle.hidden,
        fullScreen: !windowed,
        size: windowed ? Size(_w.toDouble(), _h.toDouble()) : null,
        center: windowed,
      ),
      () async {
        if (!windowed) {
          // Close and Alt+F4 raise an event instead of closing; nothing
          // listens for it, so nothing happens.
          await windowManager.setPreventClose(true);
          await windowManager.setMinimizable(false);
          await windowManager.setFullScreen(true);
        }
        await windowManager.show();
        await windowManager.focus();
      },
    );
  }

  /// Step out of full screen so the system browser can be seen -- for setting
  /// the kiosk up with Continue with Vesopa, and nothing else.
  static Future<void> release() async {
    if (!_desktop || windowed) return;
    await windowManager.setFullScreen(false);
  }

  static Future<void> relock() async {
    if (!_desktop || windowed) return;
    await windowManager.setFullScreen(true);
    await windowManager.focus();
  }

  /// Leave for good. Only ever reached from Settings, behind the passcode.
  static Future<void> exitApp() async {
    if (_desktop) {
      await windowManager.setPreventClose(false);
      await windowManager.destroy();
    }
    exit(0);
  }
}
