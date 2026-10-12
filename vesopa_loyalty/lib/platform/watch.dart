import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

/// The card, handed to the watch: the Apple Watch app (ios/VesopaWatch)
/// through the iPhone (ios/Runner/WatchBridge.swift), or the Wear OS app
/// (android/wear) through the Wearable Data Layer
/// (android/app/.../WearBridge.kt). The same card and the same call on both;
/// a no-op on the web and whenever no watch is paired, which the native side
/// works out.
const _watch = MethodChannel('vesopa_loyalty/watch');

String? _lastSent;

Future<void> sendToWatch(Map<String, Object?> card) async {
  if (kIsWeb) return;
  if (defaultTargetPlatform != TargetPlatform.iOS && defaultTargetPlatform != TargetPlatform.android) return;
  // The same card twice is common (every refresh of the card page), and
  // pointless to send: watchOS and the Data Layer would ignore it anyway.
  final encoded = jsonEncode(card);
  if (encoded == _lastSent) return;
  try {
    await _watch.invokeMethod<void>('update', card);
    _lastSent = encoded;
  } catch (_) {
    // No watch, no Watch app, or an older build: nothing to tell anybody.
  }
}
