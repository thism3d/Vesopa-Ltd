/// Closing the app from its own Exit button, at once.
///
/// It used to call windowManager.destroy() and wait for Flutter to take the
/// engine down: the full-screen window sat frozen on the last frame while
/// every plugin, socket and background isolate wound down, and sometimes the
/// process lingered after the window had gone (owner, 2026-10-12: "closing
/// time having trouble and taking time").
///
/// Now the window is hidden first, so it is gone the moment Exit is pressed,
/// whatever is saved is closed properly within a few seconds at most, and the
/// process ends with exit(0) rather than a teardown it does not need.
library;

import 'dart:async';
import 'dart:io' show exit;

import 'package:window_manager/window_manager.dart';

import '../payments/teya_sdk.dart';

Future<void> quitNow({Future<void> Function()? closeFirst}) async {
  try {
    await windowManager.hide().timeout(const Duration(seconds: 1));
  } on Object catch (_) {
    // A window that will not hide is still about to close.
  }
  if (closeFirst != null) {
    try {
      await closeFirst().timeout(const Duration(seconds: 3));
    } on Object catch (_) {
      // Whatever was not written by now is not worth holding the exit for:
      // the local database commits each change as it is made.
    }
  }
  // Teya's SDK app lives and dies with the till.
  await TeyaSdk.instance.stop();
  exit(0);
}
