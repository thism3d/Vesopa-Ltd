import 'native_auth.dart';
import 'passkey.dart';

/// Everywhere that is not a browser.
///
/// A venue's own app on an iPhone, iPad or Android phone uses the device's own
/// passkeys (NativeAuth: AuthBridge.swift, AuthBridge.kt). Windows and the
/// shared app have none this app can reach, so passkeys are not offered there.
bool passkeysSupported() => NativeAuth.enabled;

Future<PasskeyResult> passkeyCreate(Map<String, dynamic> options) async {
  if (!NativeAuth.enabled) throw UnsupportedError('Passkeys need a web browser.');
  return NativeAuth.passkeyCreate(options);
}

Future<PasskeyResult> passkeyGet(Map<String, dynamic> options) async {
  if (!NativeAuth.enabled) throw UnsupportedError('Passkeys need a web browser.');
  return NativeAuth.passkeyGet(options);
}
