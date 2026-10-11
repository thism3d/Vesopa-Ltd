import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

/// What this device is, said in every request the app makes:
/// "VesopaLoyalty (iPad; iOS 26.0)". The server names the member's devices
/// from it under Where you're signed in (vesopa_server/src/loyalty_account.js
/// deviceLabel), so an iPad says iPad rather than "iPhone or iPad".
///
/// [load] once at start-up; until then, and on the web (where the browser
/// says it itself), [deviceUserAgent] is the plain platform.
String deviceUserAgent = 'VesopaLoyalty (${_platformName()})';

String _platformName() => kIsWeb
    ? 'Web'
    : switch (defaultTargetPlatform) {
        TargetPlatform.iOS => 'iPhone',
        TargetPlatform.android => 'Android',
        TargetPlatform.macOS => 'Mac',
        _ => 'Windows',
      };

Future<void> loadDeviceLabel() async {
  if (kIsWeb || defaultTargetPlatform != TargetPlatform.iOS) return;
  try {
    // ios/Runner/AuthBridge.swift: UIDevice's model ("iPad") and iOS version.
    final d = await const MethodChannel('vesopa_loyalty/auth').invokeMapMethod<String, String>('device');
    final model = d?['model'];
    if (model == null || model.isEmpty) return;
    final system = d?['system'];
    deviceUserAgent = 'VesopaLoyalty ($model${system == null ? '' : '; iOS $system'})';
  } catch (_) {
    // An older build without the method: the plain platform, as before.
  }
}
