import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'config/constants.dart';
import 'data/activity_log.dart';
import 'platform/kiosk_window.dart';
import 'ui/app.dart';

/// Vesopa Express: the self-service ordering kiosk.
///
/// Full screen from the first frame, with no way to close or minimise it from
/// the screen -- see platform/kiosk_window.dart. Staff reach Settings by
/// holding the bottom-left corner for three seconds and typing the venue's
/// passcode, and leave from there.
Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // The activity log: taps, screens and errors, to a local file and to the
  // back office's Activity Log. See data/activity_log.dart.
  ActivityLog.instance
    ..configure(app: 'express', appVersion: ExpressConfig.version, apiBase: ExpressConfig.resolvedBase)
    ..installErrorHandlers();
  await KioskWindow.lock();
  runApp(const ProviderScope(child: ExpressApp()));
}
