import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

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
  await KioskWindow.lock();
  runApp(const ProviderScope(child: ExpressApp()));
}
